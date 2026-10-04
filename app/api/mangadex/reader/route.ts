import { NextResponse } from "next/server";
import { isMangaDexChapterUrl, getMangaDexChapterManifest } from "@/lib/ingest/mangadex";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function GET(req: Request) {
  try {
    const requestUrl = new URL(req.url);
    const source = requestUrl.searchParams.get("source")?.trim() ?? "";
    if (!source || !isMangaDexChapterUrl(source)) {
      return NextResponse.json({ error: "Informe uma URL válida de capítulo do MangaDex." }, { status: 400 });
    }

    const manifest = await getMangaDexChapterManifest(source);
    const title = manifest.mangaTitle
      ? `${manifest.mangaTitle} — Capítulo ${manifest.chapterNumber ?? manifest.title}`
      : manifest.title;

    const body = [
      "<!doctype html><html><head>",
      `<meta property="og:title" content="${escapeHtml(title)}">`,
      manifest.coverUrl ? `<meta property="og:image" content="${escapeHtml(manifest.coverUrl)}">` : "",
      `<meta name="description" content="MangaDex chapter ${escapeHtml(manifest.chapterId)}">`,
      '</head><body><main class="reading-content">',
      ...manifest.imageUrls.map((url, index) =>
        `<img class="wp-manga-chapter-img" data-page="${index + 1}" src="${escapeHtml(url)}" alt="page ${index + 1}">`
      ),
      "</main></body></html>",
    ].join("");

    return new NextResponse(body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, max-age=300",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao obter o capítulo do MangaDex." },
      { status: 502 },
    );
  }
}
