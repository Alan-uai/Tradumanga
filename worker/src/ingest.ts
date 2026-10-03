import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import sharp from "sharp";
import { canonicalizeSourceUrl } from "../../lib/ingest/url";

const execFileAsync = promisify(execFile);
const TMP_ROOT = process.env.WORKER_TMP_DIR || "/tmp/tradumanga";
const MAX_REMOTE_BYTES = Number(process.env.MAX_REMOTE_BYTES || 250 * 1024 * 1024);

function sha256(data: Uint8Array | Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

function isPrivateIpv4(ip: string) {
  const [a,b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || (a === 169 && b === 254) || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isPrivateIpv6(ip: string) {
  const value = ip.toLowerCase();
  return value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:");
}

async function assertSafeUrl(raw: string) {
  const url = new URL(canonicalizeSourceUrl(raw));
  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("URL local não é permitida.");
  }
  if (net.isIP(host) === 4 && isPrivateIpv4(host)) throw new Error("IP privado não é permitido.");
  if (net.isIP(host) === 6 && isPrivateIpv6(host)) throw new Error("IPv6 privado não é permitido.");

  const records = await Promise.all([
    dns.resolve4(host).catch(() => [] as string[]),
    dns.resolve6(host).catch(() => [] as string[]),
  ]);
  for (const ip of [...records[0], ...records[1]]) {
    if ((net.isIP(ip) === 4 && isPrivateIpv4(ip)) || (net.isIP(ip) === 6 && isPrivateIpv6(ip))) {
      throw new Error("O host resolve para uma rede privada e foi bloqueado.");
    }
  }
  return url.toString();
}

async function fetchRemote(url: string, directory: string) {
  let current = await assertSafeUrl(url);
  for (let hop = 0; hop < 5; hop++) {
    const response = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": "TradumangaWorker/1.0" },
      signal: AbortSignal.timeout(90_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirecionamento sem destino.");
      current = await assertSafeUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Download HTTP ${response.status} para ${current}`);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_REMOTE_BYTES) throw new Error("Fonte remota excede o limite de tamanho.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_REMOTE_BYTES) throw new Error("Fonte remota excede o limite de tamanho.");
    const contentType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
    const ext = contentType.includes("pdf") ? ".pdf" : contentType.startsWith("image/") ? `.${contentType.slice(6).replace("jpeg","jpg")}` : ".bin";
    const filePath = path.join(directory, `source${ext}`);
    await writeFile(filePath, buffer);
    return { filePath, contentType, sourceUrl: current, sourceHash: sha256(buffer) };
  }
  throw new Error("Redirecionamentos demais.");
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(full));
    else result.push(full);
  }
  return result;
}

function naturalCompare(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

async function convertPdf(pdfPath: string, directory: string) {
  const outputPrefix = path.join(directory, "pdf-page");
  await execFileAsync("pdftoppm", ["-png", "-r", process.env.PDF_DPI || "150", pdfPath, outputPrefix], {
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return (await listFiles(directory)).filter((file) => /pdf-page-\\d+\\.png$/i.test(file)).sort(naturalCompare);
}

async function downloadWithGalleryDl(url: string, directory: string) {
  await execFileAsync("gallery-dl", ["--no-input", "--no-colors", "--retries", "3", "-D", directory, url], {
    timeout: Number(process.env.GALLERY_DL_TIMEOUT_MS || 300_000),
    maxBuffer: 4 * 1024 * 1024,
  });
  const files = await listFiles(directory);
  return files.filter((file) => /\\.(?:jpe?g|png|webp|gif|bmp|tiff?)$/i.test(file)).sort(naturalCompare);
}

async function normalizeImage(inputPath: string, outputPath: string) {
  const buffer = await sharp(inputPath, { failOn: "warning" }).autoOrient().png().toBuffer();
  await writeFile(outputPath, buffer);
  const meta = await sharp(buffer).metadata();
  return { buffer, width: meta.width ?? 0, height: meta.height ?? 0, sha256: sha256(buffer) };
}

export async function prepareChapterSource(input: {
  chapterId: string;
  sourceType: "images" | "pdf" | "url";
  sourceUrl?: string | null;
  sourcePath?: string | null;
}) {
  const workDir = path.join(TMP_ROOT, `chapter-${input.chapterId}-${Date.now()}`);
  await mkdir(workDir, { recursive: true });

  try {
    let sourceHash: string | null = null;
    let sourceUrl: string | null = input.sourceUrl ? await assertSafeUrl(input.sourceUrl) : null;
    let sourceFile: string | null = null;
    let imageFiles: string[] = [];

    if (input.sourceType === "images") {
      return { workDir, imageFiles: [], sourceHash: null, sourceUrl: null, sourceFile: null };
    }

    if (input.sourceType === "url") {
      if (!sourceUrl) throw new Error("Capítulo URL sem source_url.");
      const direct = await fetchRemote(sourceUrl, workDir);
      sourceFile = direct.filePath;
      sourceHash = direct.sourceHash;
      sourceUrl = direct.sourceUrl;
      if (direct.contentType === "application/pdf" || /\\.pdf$/i.test(sourceFile)) {
        imageFiles = await convertPdf(sourceFile, workDir);
      } else if (direct.contentType.startsWith("image/")) {
        imageFiles = [sourceFile];
      } else {
        await rm(sourceFile, { force: true });
        imageFiles = await downloadWithGalleryDl(sourceUrl, workDir);
      }
    }

    if (!imageFiles.length) {
      throw new Error("Nenhuma página de imagem foi encontrada na fonte.");
    }

    return { workDir, imageFiles, sourceHash, sourceUrl, sourceFile };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

export async function copyPrivateSourceToWorkDir(
  sourcePath: string,
  workDir: string,
  storageDownload: () => Promise<Blob>,
) {
  const file = await storageDownload();
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.byteLength > MAX_REMOTE_BYTES) throw new Error("PDF excede o limite de tamanho.");
  const sourceFile = path.join(workDir, "source.pdf");
  await writeFile(sourceFile, buffer);
  return { sourceFile, sourceHash: sha256(buffer) };
}

export { sha256 };
