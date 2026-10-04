export type GalleryDlMangaSource = {
  id: string;
  name: string;
  url: string;
  capabilities: readonly string[];
  authRequired?: boolean;
  adult?: boolean;
};

export const GALLERY_DL_MANGA_SOURCES: readonly GalleryDlMangaSource[] = [
  { id: "comick", name: "Comick", url: "https://comick.io/", capabilities: ["chapters", "covers", "manga"] },
  { id: "dandadan", name: "Dandadan", url: "https://dandadan.net/", capabilities: ["chapters", "manga"] },
  { id: "danke", name: "Danke fürs Lesen", url: "https://danke.moe/", capabilities: ["chapters", "manga"] },
  { id: "dynasty-reader", name: "Dynasty Reader", url: "https://dynasty-scans.com/", capabilities: ["anthologies", "chapters", "images", "manga", "search"] },
  { id: "hiperdex", name: "HiperDEX", url: "https://hiperdex.com/", capabilities: ["artists", "chapters", "manga"] },
  { id: "kaliscan", name: "KaliScan", url: "https://kaliscan.me/", capabilities: ["chapters", "manga"] },
  { id: "komikcast", name: "Komikcast", url: "https://komikcast.li/", capabilities: ["chapters", "manga"] },
  { id: "mangafox", name: "Manga Fox", url: "https://fanfox.net/", capabilities: ["chapters", "manga"] },
  { id: "mangahere", name: "Manga Here", url: "https://www.mangahere.cc/", capabilities: ["chapters", "manga"] },
  { id: "mangadex", name: "MangaDex", url: "https://mangadex.org/", capabilities: ["authors", "chapters", "covers", "manga"] },
  { id: "mangafire", name: "MangaFire", url: "https://mangafire.to/", capabilities: ["chapters", "manga"] },
  { id: "mangafreak", name: "MangaFreak", url: "https://ww2.mangafreak.me/", capabilities: ["chapters", "manga"] },
  { id: "mangapark", name: "MangaPark", url: "https://mangapark.net/", capabilities: ["chapters", "manga"] },
  { id: "mangaread", name: "MangaRead", url: "https://mangaread.org/", capabilities: ["chapters", "manga"] },
  { id: "mangareader", name: "MangaReader", url: "https://mangareader.to/", capabilities: ["chapters", "manga"] },
  { id: "mangataro", name: "MangaTaro", url: "https://mangataro.org/", capabilities: ["chapters", "manga"] },
  { id: "mangatown", name: "MangaTown", url: "https://www.mangatown.com/", capabilities: ["chapters", "manga"] },
  { id: "naver-webtoon", name: "Naver Webtoon", url: "https://comic.naver.com/", capabilities: ["comics", "episodes"] },
  { id: "rawkuma", name: "Rawkuma", url: "https://rawkuma.net/", capabilities: ["chapters", "manga"] },
  { id: "senmanga", name: "Sen Manga", url: "https://raw.senmanga.com/", capabilities: ["chapters"] },
  { id: "tapas", name: "Tapas", url: "https://tapas.io/", capabilities: ["creators", "episodes", "series"] },
  { id: "tcbscans", name: "TCB Scans", url: "https://tcbscans.me/", capabilities: ["chapters", "manga"] },
  { id: "webtoons", name: "WEBTOON", url: "https://www.webtoons.com/", capabilities: ["artists", "comics", "episodes"] },
  { id: "weebcentral", name: "Weeb Central", url: "https://weebcentral.com/", capabilities: ["chapters", "manga"] },
  { id: "weebdex", name: "WeebDex", url: "https://weebdex.org/", capabilities: ["chapters", "manga"] },
  { id: "manganelo", name: "MangaNelo", url: "https://www.nelomanga.net/", capabilities: ["bookmarks", "chapters", "manga"] },
  { id: "natomanga", name: "MangaNato", url: "https://www.natomanga.com/", capabilities: ["bookmarks", "chapters", "manga"] },
  { id: "manganato-gg", name: "MangaNato", url: "https://www.manganato.gg/", capabilities: ["bookmarks", "chapters", "manga"] },
  { id: "mangakakalot-gg", name: "MangaKakalot", url: "https://www.mangakakalot.gg/", capabilities: ["bookmarks", "chapters", "manga"] },
  { id: "madokami", name: "Madokami", url: "https://manga.madokami.al/", capabilities: ["manga"], authRequired: true },
  { id: "hentai2read", name: "Hentai2Read", url: "https://hentai2read.com/", capabilities: ["chapters", "manga"], adult: true },
  { id: "hentaiHere", name: "HentaiHere", url: "https://hentaihere.com/", capabilities: ["chapters", "manga"], adult: true },
  { id: "simply-hentai", name: "Simply Hentai", url: "https://www.simply-hentai.com/", capabilities: ["galleries", "languages", "manga", "series", "tag-searches"], adult: true },
];

export const galleryDlSourceByHost = new Map(
  GALLERY_DL_MANGA_SOURCES.flatMap((source) => {
    const host = new URL(source.url).hostname.replace(/^www\./, "");
    return [[host, source] as const];
  }),
);

export function supportedGalleryDlSource(rawUrl: string) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    return GALLERY_DL_MANGA_SOURCES.find((source) => {
      const sourceHost = new URL(source.url).hostname.toLowerCase().replace(/^www\./, "");
      return host === sourceHost || host.endsWith("." + sourceHost);
    }) ?? null;
  } catch {
    return null;
  }
}
