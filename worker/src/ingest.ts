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
const MAX_HTML_BYTES = Number(process.env.MAX_HTML_BYTES || 8 * 1024 * 1024);
const MAX_HTML_IMAGES = Number(process.env.MAX_HTML_IMAGES || 500);
const MAX_HTML_TOTAL_BYTES = Number(process.env.MAX_HTML_TOTAL_BYTES || 500 * 1024 * 1024);

export type DetectedSourceMetadata = {
  title: string | null;
  chapterNumber: number | null;
  chapterTitle: string | null;
  sourceLanguage: string | null;
  extractor: string | null;
  detectionMethod: "gallery-dl" | "html" | "url" | "none";
};

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
    if (!response.ok) throw new Error("Download HTTP " + response.status + " para " + current);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_REMOTE_BYTES) throw new Error("Fonte remota excede o limite de tamanho.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_REMOTE_BYTES) throw new Error("Fonte remota excede o limite de tamanho.");
    const contentType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
    const ext = contentType.includes("pdf") ? ".pdf" : contentType.startsWith("image/") ? "." + contentType.slice(6).replace("jpeg","jpg") : ".bin";
    const filePath = path.join(directory, "source" + ext);
    await writeFile(filePath, buffer);
    return { filePath, contentType, sourceUrl: current, sourceHash: sha256(buffer) };
  }
  throw new Error("Redirecionamentos demais.");
}

async function fetchHtml(url: string) {
  let current = await assertSafeUrl(url);
  for (let hop = 0; hop < 5; hop++) {
    const response = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": "Mozilla/5.0 (compatible; TradumangaWorker/1.0)" },
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirecionamento sem destino.");
      current = await assertSafeUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error("Página HTTP " + response.status + " para " + current);
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error("A URL não retornou uma página HTML.");
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_HTML_BYTES) throw new Error("HTML da fonte excede o limite de tamanho.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_HTML_BYTES) throw new Error("HTML da fonte excede o limite de tamanho.");
    return { html: buffer.toString("utf8"), sourceUrl: current };
  }
  throw new Error("Redirecionamentos demais.");
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function cleanText(value: unknown) {
  if (typeof value !== "string") return null;
  const text = decodeHtml(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text || null;
}

function readMeta(html: string, key: string) {
  const safeKey = key.replace(/[.*+?^()|[\]\\]/g, "\\$&");
  const a = new RegExp("<meta[^>]+(?:property|name)=[\"']" + safeKey + "[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>", "i");
  const b = new RegExp("<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+(?:property|name)=[\"']" + safeKey + "[\"'][^>]*>", "i");
  return cleanText(html.match(a)?.[1] || html.match(b)?.[1] || "");
}

function parseChapterNumber(...values: unknown[]) {
  const patterns = [
    /(?:chapter|cap(?:í|i)tulo|cap|ch|episode|ep)[\s._:#-]*(\d+(?:[.,]\d+)?)/i,
    /[\/_-](\d+(?:[.,]\d+)?)(?:\D*)$/i,
  ];
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") continue;
    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (!match) continue;
      const number = Number(match[1].replace(",", "."));
      if (Number.isFinite(number) && number >= 0 && number < 100000) return number;
    }
  }
  return null;
}

function stripChapterSuffix(value: string | null) {
  if (!value) return null;
  return value
    .replace(/\s*[-|–—:]?\s*(?:chapter|cap(?:í|i)tulo|cap|ch|episode|ep)\s*[#.: -]*\d+(?:[.,]\d+)?(?:\s*[-|–—:]\s*.*)?$/i, "")
    .trim() || null;
}

function normalizeLanguage(value: unknown) {
  if (typeof value !== "string") return null;
  const language = value.toLowerCase().trim();
  const aliases: Record<string, string> = {
    japanese: "ja", japonês: "ja", ja: "ja", korean: "ko", coreano: "ko", ko: "ko",
    chinese: "zh", chinês: "zh", zh: "zh", english: "en", inglês: "en", en: "en",
    spanish: "es", espanhol: "es", es: "es", french: "fr", francês: "fr", fr: "fr",
    portuguese: "pt-BR", português: "pt-BR", "pt-br": "pt-BR", pt: "pt-BR",
  };
  return aliases[language] ?? (language.match(/^[a-z]{2}(?:-[a-z]{2})?$/i) ? language : null);
}

function metadataFromGalleryJson(stdout: string) {
  for (const line of stdout.split(/\r?\n/).map((v) => v.trim()).filter(Boolean)) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (!value || typeof value !== "object") continue;
      const manga = cleanText(value.manga) ?? cleanText(value.series) ?? cleanText(value.name);
      const title = cleanText(value.title);
      const chapterNumber = parseChapterNumber(value.chapter, value.chapter_id, value.url);
      if (manga || title || chapterNumber !== null) {
        return {
          title: manga ?? stripChapterSuffix(title),
          chapterNumber,
          chapterTitle: title && manga && title !== manga ? title : null,
          sourceLanguage: normalizeLanguage(value.language ?? value.lang),
          extractor: cleanText(value.extractor) ?? cleanText(value.category),
        };
      }
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }
  return null;
}

async function detectSourceMetadata(url: string): Promise<DetectedSourceMetadata> {
  const safeUrl = await assertSafeUrl(url);
  try {
    const { stdout } = await execFileAsync("gallery-dl", [
      "--no-input", "--no-colors", "--no-download", "--dump-json", "--range", "1", safeUrl,
    ], {
      timeout: Number(process.env.GALLERY_DL_METADATA_TIMEOUT_MS || 90_000),
      maxBuffer: 8 * 1024 * 1024,
    });
    const metadata = metadataFromGalleryJson(stdout);
    if (metadata) return { ...metadata, detectionMethod: "gallery-dl" };
  } catch {
    // Fall through to HTML/URL metadata.
  }

  try {
    const { html } = await fetchHtml(safeUrl);
    const ogTitle = readMeta(html, "og:title");
    const siteName = readMeta(html, "og:site_name");
    const genericTitle = cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
    const rawTitle = ogTitle ?? genericTitle;
    const chapterNumber = parseChapterNumber(safeUrl, rawTitle);
    const title = stripChapterSuffix(rawTitle) ?? rawTitle;
    return {
      title: title ?? siteName,
      chapterNumber,
      chapterTitle: rawTitle && title && rawTitle !== title ? rawTitle : null,
      sourceLanguage: normalizeLanguage(readMeta(html, "og:locale")),
      extractor: null,
      detectionMethod: "html",
    };
  } catch {
    const urlTitle = decodeURIComponent(safeUrl.split("/").filter(Boolean).pop() ?? "")
      .replace(/[-_]+/g, " ").trim();
    return {
      title: stripChapterSuffix(urlTitle),
      chapterNumber: parseChapterNumber(safeUrl, urlTitle),
      chapterTitle: null,
      sourceLanguage: null,
      extractor: null,
      detectionMethod: urlTitle ? "url" : "none",
    };
  }
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

export async function convertPdfSource(pdfPath: string, directory: string) {
  const outputPrefix = path.join(directory, "pdf-page");
  await execFileAsync("pdftoppm", ["-png", "-r", process.env.PDF_DPI || "150", pdfPath, outputPrefix], {
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return (await listFiles(directory)).filter((file) => /pdf-page-\d+\.png$/i.test(file)).sort(naturalCompare);
}

async function downloadWithGalleryDl(url: string, directory: string) {
  await execFileAsync("gallery-dl", [
    "--no-input", "--no-colors", "--retries", "3", "--filesize-max", String(MAX_REMOTE_BYTES),
    "-D", directory, url,
  ], {
    timeout: Number(process.env.GALLERY_DL_TIMEOUT_MS || 300_000),
    maxBuffer: 4 * 1024 * 1024,
  });
  const files = await listFiles(directory);
  return files.filter((file) => /\.(?:jpe?g|png|webp|gif|bmp|tiff?)$/i.test(file)).sort(naturalCompare);
}

function extractImageUrls(html: string, baseUrl: string) {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const match = tag.match(/(?:data-src|data-original|data-lazy-src|data-url|src)=["']([^"']+)["']/i);
    if (!match?.[1]) continue;
    try {
      const resolved = new URL(decodeHtml(match[1]), baseUrl).toString();
      if (!seen.has(resolved)) { seen.add(resolved); result.push(resolved); }
    } catch {}
    if (result.length >= MAX_HTML_IMAGES) break;
  }
  return result;
}

async function downloadHtmlImages(url: string, directory: string) {
  const { html, sourceUrl } = await fetchHtml(url);
  const urls = extractImageUrls(html, sourceUrl);
  if (!urls.length) return [];
  const imageDir = path.join(directory, "html-images");
  await mkdir(imageDir, { recursive: true });
  const files: string[] = [];
  let totalBytes = 0;

  for (let i = 0; i < urls.length; i++) {
    try {
      let current = await assertSafeUrl(urls[i]);
      let response = await fetch(current, {
        redirect: "manual",
        headers: { "user-agent": "Mozilla/5.0 (compatible; TradumangaWorker/1.0)" },
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) continue;
        current = await assertSafeUrl(new URL(location, current).toString());
        response = await fetch(current, {
          redirect: "manual",
          headers: { "user-agent": "Mozilla/5.0 (compatible; TradumangaWorker/1.0)" },
          signal: AbortSignal.timeout(60_000),
        });
      }
      if (!response.ok) continue;
      const data = Buffer.from(await response.arrayBuffer());
      if (data.byteLength > MAX_REMOTE_BYTES || totalBytes + data.byteLength > MAX_HTML_TOTAL_BYTES) break;
      const type = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
      if (!type.startsWith("image/")) continue;
      const imageMeta = await sharp(data).metadata();
      const width = imageMeta.width ?? 0;
      const height = imageMeta.height ?? 0;
      if (width < 200 || height < 200 || width * height < 150_000) continue;
      const file = path.join(imageDir, "page-" + String(i + 1).padStart(4, "0") + ".png");
      await sharp(data).png().toFile(file);
      totalBytes += data.byteLength;
      files.push(file);
    } catch {}
  }
  return files;
}

export async function prepareChapterSource(input: {
  chapterId: string;
  sourceType: "images" | "pdf" | "url";
  sourceUrl?: string | null;
  sourcePath?: string | null;
}) {
  const workDir = path.join(TMP_ROOT, "chapter-" + input.chapterId + "-" + Date.now());
  await mkdir(workDir, { recursive: true });

  try {
    let sourceHash: string | null = null;
    let sourceUrl: string | null = input.sourceUrl ? await assertSafeUrl(input.sourceUrl) : null;
    let sourceFile: string | null = null;
    let imageFiles: string[] = [];
    let metadata: DetectedSourceMetadata = {
      title: null, chapterNumber: null, chapterTitle: null, sourceLanguage: null,
      extractor: null, detectionMethod: "none",
    };

    if (input.sourceType === "images") {
      return { workDir, imageFiles: [], sourceHash: null, sourceUrl: null, sourceFile: null, metadata };
    }

    if (input.sourceType === "url") {
      if (!sourceUrl) throw new Error("Capítulo URL sem source_url.");
      metadata = await detectSourceMetadata(sourceUrl);
      let directError: unknown = null;
      try {
        const direct = await fetchRemote(sourceUrl, workDir);
        sourceFile = direct.filePath;
        sourceHash = direct.sourceHash;
        sourceUrl = direct.sourceUrl;
        if (direct.contentType === "application/pdf" || /\.pdf$/i.test(sourceFile)) {
          imageFiles = await convertPdfSource(sourceFile, workDir);
        } else if (direct.contentType.startsWith("image/")) {
          imageFiles = [sourceFile];
        } else {
          await rm(sourceFile, { force: true });
          try { imageFiles = await downloadWithGalleryDl(sourceUrl, workDir); } catch {}
          if (!imageFiles.length) imageFiles = await downloadHtmlImages(sourceUrl, workDir);
        }
      } catch (error) {
        directError = error;
      }

      if (!imageFiles.length) {
        try { imageFiles = await downloadWithGalleryDl(sourceUrl, workDir); } catch {}
      }
      if (!imageFiles.length) {
        try { imageFiles = await downloadHtmlImages(sourceUrl, workDir); } catch {}
      }
      if (!imageFiles.length) {
        throw new Error(directError instanceof Error ? "Não foi possível extrair páginas da URL: " + directError.message : "Nenhuma página de imagem foi encontrada na fonte.");
      }
    }

    return { workDir, imageFiles, sourceHash, sourceUrl, sourceFile, metadata };
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
