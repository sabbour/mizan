from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor

from .errors import PopularChartUnavailable

HIT_LIST_ID = "RDCLAK5uy_kmPRjHDECIcuVwnKsx2Ng7fyNgFKWNJFs"
HIT_LIST_URL = f"https://music.youtube.com/playlist?list={HIT_LIST_ID}"
POPS_BIGGEST_HITS_ID = "RDCLAK5uy_nmS3YoxSwVVQk9lEQJ0UX4ZCjXsW_psU8"
POPS_BIGGEST_HITS_URL = f"https://music.youtube.com/playlist?list={POPS_BIGGEST_HITS_ID}"
CLASSIC_ROCK_GREATEST_HITS_ID = "RDCLAK5uy_nZiG9ehz_MQoWQxY5yElsLHCcG0tv9PRg"
CLASSIC_ROCK_GREATEST_HITS_URL = \
    f"https://music.youtube.com/playlist?list={CLASSIC_ROCK_GREATEST_HITS_ID}"
ALL_TIME_ALT_ID = "RDCLAK5uy_mgHrXs_5F6wPwPFA47S8yrzCfjCi4AXDE"
ALL_TIME_ALT_URL = f"https://music.youtube.com/playlist?list={ALL_TIME_ALT_ID}"
POPULAR_PLAYLIST_LIMIT = 12

_PLAYLISTS = (
    {
        "id": "hit-list",
        "title": "Today's Biggest Hits — The Hit List",
        "playlist_id": HIT_LIST_ID,
        "playlist_title": "The Hit List",
        "publisher": "YouTube Music",
        "sourceUrl": HIT_LIST_URL,
        "kind": "editorial",
    },
    {
        "id": "pops-biggest-hits",
        "title": "Pop's Biggest Hits",
        "playlist_id": POPS_BIGGEST_HITS_ID,
        "playlist_title": "Pop's Biggest Hits",
        "publisher": "YouTube Music",
        "sourceUrl": POPS_BIGGEST_HITS_URL,
        "kind": "editorial",
    },
    {
        "id": "classic-rock-greatest-hits",
        "title": "Classic Rock's Greatest Hits",
        "playlist_id": CLASSIC_ROCK_GREATEST_HITS_ID,
        "playlist_title": "Classic Rock's Greatest Hits",
        "publisher": "YouTube Music",
        "sourceUrl": CLASSIC_ROCK_GREATEST_HITS_URL,
        "kind": "editorial",
    },
    {
        "id": "all-time-alt",
        "title": "All-Time Alt",
        "playlist_id": ALL_TIME_ALT_ID,
        "playlist_title": "All-Time Alt",
        "publisher": "YouTube Music",
        "sourceUrl": ALL_TIME_ALT_URL,
        "kind": "editorial",
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
            payload = youtube.extract_info(section["sourceUrl"], download=False)
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
