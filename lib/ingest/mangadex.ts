const MANGADEX_HOSTS = new Set(["mangadex.org", "www.mangadex.org", "api.mangadex.org"]);

export function isMangaDexChapterUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return MANGADEX_HOSTS.has(url.hostname.toLowerCase()) && /^\\/chapter\\/[0-9a-f-]{36}\\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function getMangaDexChapterId(raw: string): string {
  const url = new URL(raw);
  const match = url.pathname.match(/\\/chapter\\/([0-9a-f-]{36})\\/?$/i);
  if (!match) throw new Error("URL do MangaDex não contém um ID de capítulo válido.");
  return match[1];
}

export type MangaDexChapterManifest = {
  chapterId: string;
  title: string;
  chapterNumber: string | null;
  volume: string | null;
  mangaId: string | null;
  mangaTitle: string | null;
  coverUrl: string | null;
  imageUrls: string[];
};

async function mdFetch<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0 (compatible; Tradumanga/3.0)",
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`MangaDex API respondeu HTTP ${response.status}.`);
  return response.json() as Promise<T>;
}

export async function getMangaDexChapterManifest(rawUrl: string): Promise<MangaDexChapterManifest> {
  const chapterId = getMangaDexChapterId(rawUrl);
  const [atHome, chapter] = await Promise.all([
    mdFetch<any>(`https://api.mangadex.org/at-home/server/${chapterId}`),
    mdFetch<any>(`https://api.mangadex.org/chapter/${chapterId}?includes[]=manga&includes[]=scanlation_group`),
  ]);

  const chapterData = chapter?.data;
  const attributes = chapterData?.attributes ?? {};
  const relationships = Array.isArray(chapterData?.relationships) ? chapterData.relationships : [];
  const mangaRelationship = relationships.find((r: any) => r?.type === "manga");
  const mangaId = mangaRelationship?.id ?? null;

  let mangaTitle: string | null = null;
  let coverUrl: string | null = null;

  if (mangaId) {
    try {
      const manga = await mdFetch<any>(`https://api.mangadex.org/manga/${mangaId}?includes[]=cover_art`);
      const mangaData = manga?.data;
      const titleMap = mangaData?.attributes?.title ?? {};
      mangaTitle = titleMap.en ?? Object.values(titleMap)[0] ?? null;

      const cover = (Array.isArray(mangaData?.relationships) ? mangaData.relationships : [])
        .find((r: any) => r?.type === "cover_art");
      if (cover?.id) {
        try {
          const coverData = await mdFetch<any>(`https://api.mangadex.org/cover/${cover.id}`);
          const filename = coverData?.data?.attributes?.fileName;
          if (filename) coverUrl = `https://uploads.mangadex.org/covers/${mangaId}/${filename}`;
        } catch {
          // Cover is optional; chapter ingestion must continue without it.
        }
      }
    } catch {
      // Manga metadata is optional; page extraction remains valid.
    }
  }

  const baseUrl = String(atHome?.baseUrl ?? "");
  const hash = String(atHome?.chapter?.hash ?? "");
  const data = Array.isArray(atHome?.chapter?.data) ? atHome.chapter.data : [];
  if (!baseUrl || !hash || !data.length) {
    throw new Error("O MangaDex não retornou páginas para este capítulo.");
  }

  const imageUrls = data.map((filename: string) => `${baseUrl}/data/${hash}/${filename}`);

  return {
    chapterId,
    title: attributes.title ?? `Capítulo ${attributes.chapter ?? ""}`.trim(),
    chapterNumber: attributes.chapter ?? null,
    volume: attributes.volume ?? null,
    mangaId,
    mangaTitle,
    coverUrl,
    imageUrls,
  };
}
