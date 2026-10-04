import { GALLERY_DL_MANGA_SOURCES, type GalleryDlMangaSource } from "@/lib/gallery-dl/sources";

export type GalleryDlImage = {
  url: string;
  filename?: string | null;
  page?: number | string | null;
  chapter?: number | string | null;
  chapterTitle?: string | null;
  title?: string | null;
  language?: string | null;
  extractor?: string | null;
};

type DiscoverResponse = {
  title: string;
  results: Array<{
    sourceId: string;
    source: string;
    url: string;
  }>;
};

type ExtractResponse = {
  url: string;
  imageCount: number;
  images: GalleryDlImage[];
  chapters: unknown[];
};

const timeout = Number(process.env.GALLERY_DL_WORKER_TIMEOUT_MS || 90_000);

async function workerFetch<T>(path: string, body: unknown): Promise<T> {
  const base = process.env.GALLERY_DL_WORKER_URL?.replace(/\/$/, "");
  if (!base) throw new Error("GALLERY_DL_WORKER_URL não configurada.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.GALLERY_DL_WORKER_TOKEN
          ? { "X-Gallery-Token": process.env.GALLERY_DL_WORKER_TOKEN }
          : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.detail || payload?.error || `gallery-dl worker HTTP ${response.status}`);
    }
    return payload as T;
  } finally {
    clearTimeout(timer);
  }
}

export function galleryDlConfigured() {
  return Boolean(process.env.GALLERY_DL_WORKER_URL);
}

export async function discoverGalleryDlSources(title: string, chapter?: number | null) {
  return workerFetch<DiscoverResponse>("/discover", {
    title,
    chapter: chapter ?? null,
    max_sources: GALLERY_DL_MANGA_SOURCES.filter((source) => !source.adult).length,
    results_per_source: 3,
  });
}

export async function extractGalleryDlImages(
  url: string,
  chapter?: number | null,
  language?: string | null,
) {
  return workerFetch<ExtractResponse>("/extract", {
    url,
    chapter: chapter ?? null,
    language: language ?? null,
  });
}

export function sourceForGalleryDlUrl(url: string): GalleryDlMangaSource | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return GALLERY_DL_MANGA_SOURCES.find((source) => {
      const sourceHost = new URL(source.url).hostname.toLowerCase().replace(/^www\./, "");
      return host === sourceHost || host.endsWith("." + sourceHost);
    }) ?? null;
  } catch {
    return null;
  }
}
