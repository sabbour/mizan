from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor

from .errors import PopularChartUnavailable

HIT_LIST_ID = "RDCLAK5uy_kmPRjHDECIcuVwnKsx2Ng7fyNgFKWNJFs"
HIT_LIST_URL = f"https://music.youtube.com/playlist?list={HIT_LIST_ID}"
GLOBAL_TOP_100_ID = "PL4fGSI1pDJn6puJdseH2Rt9sMvt9E2M4i"
GLOBAL_TOP_100_URL = f"https://music.youtube.com/playlist?list={GLOBAL_TOP_100_ID}"
POPULAR_PLAYLIST_LIMIT = 12

_PLAYLISTS = (
    {
        "id": "hit-list",
        "title": "Today's Biggest Hits — The Hit List",
        "playlist_id": HIT_LIST_ID,
        "playlist_title": "The Hit List",
        "publisher": "YouTube Music",
        "url": HIT_LIST_URL,
        "kind": "editorial",
    },
    {
        "id": "global-top-100",
        "title": "Top 100 Songs Global",
        "playlist_id": GLOBAL_TOP_100_ID,
        "playlist_title": "Top 100 Songs Global",
        "publisher": "YouTube Music Global Charts",
        "url": GLOBAL_TOP_100_URL,
        "kind": "chart",
    },
)


def parse_playlist_response(payload: dict, *, playlist_id: str, title: str,
                            publisher: str, ranked: bool = False) -> dict:
    if (not isinstance(payload, dict)
            or payload.get("id") != playlist_id
            or payload.get("title") != title
            or payload.get("channel") != publisher
            or not isinstance(payload.get("entries"), list)):
        raise PopularChartUnavailable()

    rows, seen = [], set()
    for position, entry in enumerate(payload["entries"][:POPULAR_PLAYLIST_LIMIT], 1):
        if not isinstance(entry, dict):
            continue
        video_id = entry.get("id")
        if (not isinstance(video_id, str) or not re.fullmatch(r"[\w-]{11}", video_id, re.ASCII)
                or video_id in seen):
            continue
        video_title = entry.get("title")
        if not isinstance(video_title, str) or not video_title.strip():
            continue
        seen.add(video_id)
        artist = entry.get("channel") or entry.get("artist") or entry.get("uploader") or ""
        thumbnails = entry.get("thumbnails")
        thumbnail = next(
            (item.get("url") for item in reversed(thumbnails or [])
             if isinstance(item, dict) and isinstance(item.get("url"), str)
             and item["url"].startswith("https://i.ytimg.com/")),
            None,
        )
        if not thumbnail:
            candidate = entry.get("thumbnail")
            thumbnail = candidate if isinstance(candidate, str) \
                and candidate.startswith("https://i.ytimg.com/") else None
        row = {
            "videoId": video_id,
            "title": video_title.strip()[:300],
            "artist": str(artist)[:300],
            "thumbnail": thumbnail or f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        }
        if ranked:
            row["rank"] = position
        rows.append(row)
    if not rows:
        raise PopularChartUnavailable()

    result = {
        "rows": rows,
        "description": str(payload.get("description") or "")[:500],
        "chartDate": str(payload.get("modified_date") or "") if ranked else "",
    }
    return result


def _fetch_playlist(section: dict) -> dict:
    from yt_dlp import YoutubeDL
    from yt_dlp.utils import DownloadError

    try:
        with YoutubeDL({
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extract_flat": False,
            "playlistend": POPULAR_PLAYLIST_LIMIT,
            "socket_timeout": 8,
            "retries": 0,
            "extractor_retries": 0,
            "cachedir": False,
            "cookiefile": None,
            "usenetrc": False,
        }) as youtube:
            payload = youtube.extract_info(section["url"], download=False)
        parsed = parse_playlist_response(
            payload,
            playlist_id=section["playlist_id"],
            title=section["playlist_title"],
            publisher=section["publisher"],
            ranked=section["kind"] == "chart",
        )
        return {
            **section,
            "status": "available",
            **parsed,
        }
    except (DownloadError, OSError, TimeoutError, PopularChartUnavailable):
        return {
            **section,
            "status": "unavailable",
            "message": "YouTube Music could not load this playlist.",
            "rows": [],
            "description": "",
            "chartDate": "",
        }


def fetch_popular_songs() -> dict:
    with ThreadPoolExecutor(max_workers=len(_PLAYLISTS)) as executor:
        sections = list(executor.map(_fetch_playlist, _PLAYLISTS))
    return {"title": "YouTube Music", "sections": sections}
