from __future__ import annotations

import json
import os
import re
import subprocess
from urllib.parse import quote_plus, urlparse

import requests
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="Tradumanga gallery-dl worker", version="1.0.0")

TOKEN = os.environ.get("GALLERY_DL_WORKER_TOKEN", "")
TIMEOUT = int(os.environ.get("GALLERY_DL_TIMEOUT", "120"))

SOURCES = [
    ("comick", "Comick", "comick.io"),
    ("dandadan", "Dandadan", "dandadan.net"),
    ("danke", "Danke fürs Lesen", "danke.moe"),
    ("dynasty-reader", "Dynasty Reader", "dynasty-scans.com"),
    ("hiperdex", "HiperDEX", "hiperdex.com"),
    ("kaliscan", "KaliScan", "kaliscan.me"),
    ("komikcast", "Komikcast", "komikcast.li"),
    ("mangafox", "Manga Fox", "fanfox.net"),
    ("mangahere", "Manga Here", "mangahere.cc"),
    ("mangadex", "MangaDex", "mangadex.org"),
    ("mangafire", "MangaFire", "mangafire.to"),
    ("mangafreak", "MangaFreak", "ww2.mangafreak.me"),
    ("mangapark", "MangaPark", "mangapark.net"),
    ("mangaread", "MangaRead", "mangaread.org"),
    ("mangareader", "MangaReader", "mangareader.to"),
    ("mangataro", "MangaTaro", "mangataro.org"),
    ("mangatown", "MangaTown", "mangatown.com"),
    ("naver-webtoon", "Naver Webtoon", "comic.naver.com"),
    ("rawkuma", "Rawkuma", "rawkuma.net"),
    ("senmanga", "Sen Manga", "raw.senmanga.com"),
    ("tapas", "Tapas", "tapas.io"),
    ("tcbscans", "TCB Scans", "tcbscans.me"),
    ("webtoons", "WEBTOON", "webtoons.com"),
    ("weebcentral", "Weeb Central", "weebcentral.com"),
    ("weebdex", "WeebDex", "weebdex.org"),
    ("manganelo", "MangaNelo", "nelomanga.net"),
    ("natomanga", "MangaNato", "natomanga.com"),
    ("manganato-gg", "MangaNato", "manganato.gg"),
    ("mangakakalot-gg", "MangaKakalot", "mangakakalot.gg"),
    ("madokami", "Madokami", "manga.madokami.al"),
]

SOURCE_BY_HOST = {host: (sid, name) for sid, name, host in SOURCES}


class DiscoverRequest(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    chapter: float | None = None
    max_sources: int = Field(default=8, ge=1, le=30)
    results_per_source: int = Field(default=3, ge=1, le=5)


class ExtractRequest(BaseModel):
    url: str = Field(min_length=8, max_length=4000)
    chapter: float | None = None
    language: str | None = Field(default=None, max_length=10)


def authorize(value: str | None):
    if TOKEN and value != TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")


def run_gallery_dl(args: list[str]) -> list[dict]:
    command = ["python", "-m", "gallery_dl", "--no-input", "--no-colors", "-J", *args]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=TIMEOUT,
            check=False,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="gallery-dl excedeu o tempo limite.") from exc

    if result.returncode != 0 and not result.stdout.strip():
        detail = (result.stderr or "gallery-dl falhou.").strip()[-2000:]
        raise HTTPException(status_code=502, detail=detail)

    records: list[dict] = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            records.append(value)
    return records


def domain_allowed(url: str) -> bool:
    try:
        host = urlparse(url).hostname or ""
        host = host.lower().removeprefix("www.")
        return host in SOURCE_BY_HOST or any(host.endswith("." + h) for h in SOURCE_BY_HOST)
    except Exception:
        return False


def search_source(title: str, host: str, limit: int) -> list[str]:
    query = f'site:{host} "{title}"'
    endpoint = "https://html.duckduckgo.com/html/?q=" + quote_plus(query)
    try:
        response = requests.get(
            endpoint,
            timeout=15,
            headers={"User-Agent": "TradumangaGalleryDlWorker/1.0"},
        )
        response.raise_for_status()
    except requests.RequestException:
        return []

    links = re.findall(r'nofollow" class="result__a" href="([^"]+)"', response.text)
    out: list[str] = []
    seen: set[str] = set()
    for link in links:
        link = link.replace("&amp;", "&")
        if link.startswith("//"):
            link = "https:" + link
        if not link.startswith("http") or not domain_allowed(link) or link in seen:
            continue
        seen.add(link)
        out.append(link)
        if len(out) >= limit:
            break
    return out


@app.get("/health")
def health():
    return {"ok": True, "gallery_dl": True}


@app.get("/sources")
def sources(x_gallery_token: str | None = Header(default=None)):
    authorize(x_gallery_token)
    return {
        "sources": [
            {"id": sid, "name": name, "domain": host}
            for sid, name, host in SOURCES
        ]
    }


@app.post("/discover")
def discover(
    payload: DiscoverRequest,
    x_gallery_token: str | None = Header(default=None),
):
    authorize(x_gallery_token)

    results = []
    seen: set[str] = set()
    sources = SOURCES[: payload.max_sources]

    # Search several supported gallery-dl domains concurrently at the HTTP layer
    # would be faster, but sequential requests are deliberately used here to
    # avoid hammering small manga sites and search providers.
    for sid, name, host in sources:
        for candidate in search_source(payload.title, host, payload.results_per_source):
            if candidate in seen:
                continue
            seen.add(candidate)
            results.append({"sourceId": sid, "source": name, "url": candidate})
    return {"title": payload.title, "results": results}


@app.post("/extract")
def extract(
    payload: ExtractRequest,
    x_gallery_token: str | None = Header(default=None),
):
    authorize(x_gallery_token)

    if not domain_allowed(payload.url):
        raise HTTPException(status_code=400, detail="URL fora da lista de fontes gallery-dl do Tradumanga.")

    args: list[str] = []
    if payload.chapter is not None:
        low = payload.chapter
        high = low + 0.0001 if low % 1 else low + 0.999999
        args += ["--chapter-filter", f"{low} <= chapter < {high}"]
    if payload.language:
        args += ["-o", f"lang={payload.language}"]
    args.append(payload.url)

    records = run_gallery_dl(args)
    images = []
    chapters = []
    for item in records:
        url = item.get("url")
        if isinstance(url, str) and url.startswith(("http://", "https://")):
            images.append({
                "url": url,
                "filename": item.get("filename"),
                "page": item.get("num") or item.get("page") or item.get("index"),
                "chapter": item.get("chapter"),
                "chapterTitle": item.get("chapter_title"),
                "title": item.get("title"),
                "language": item.get("lang"),
                "extractor": item.get("extractor"),
            })
        if item.get("chapter") is not None:
            chapters.append(item)

    return {
        "url": payload.url,
        "imageCount": len(images),
        "images": images,
        "chapters": chapters,
    }
