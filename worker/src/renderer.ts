import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);
const ROOT = process.env.WORKER_TMP_DIR || "/tmp/tradumanga";

export async function renderPage(input: {
  originalPath: string;
  bubbles: Array<Record<string, unknown>>;
  outputPath: string;
  maskPath: string;
}) {
  await mkdir(ROOT, { recursive: true });
  const bubblesPath = path.join(ROOT, `bubbles-${process.pid}-${Date.now()}.json`);
  await writeFile(bubblesPath, JSON.stringify(input.bubbles), "utf8");
  try {
    await execFileAsync("python3", [
      "/app/worker/scripts/render_page.py",
      input.originalPath,
      input.outputPath,
      input.maskPath,
      bubblesPath,
    ], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    return await readFile(input.outputPath);
  } finally {
    await import("node:fs/promises").then(({ unlink }) => unlink(bubblesPath).catch(() => undefined));
  }
}
