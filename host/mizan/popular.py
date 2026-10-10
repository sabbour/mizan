from __future__ import annotations

import json
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .errors import PopularChartUnavailable

CHARTS_URL = "https://artists.youtube.com/charts/tracks"
CHARTS_API = "https://charts.youtube.com/youtubei/v1/browse?alt=json"
MAX_CHART_RESPONSE = 2 * 1024 * 1024


class _ChartRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        url = urljoin(request.full_url, new_url)
        try:
            parsed = urlsplit(url)
            port = parsed.port
        except ValueError as exc:
            raise PopularChartUnavailable() from exc
        if (parsed.scheme != "https" or parsed.hostname != "charts.youtube.com"
                or port not in (None, 443)):
            raise PopularChartUnavailable()
        return super().redirect_request(request, fp, code, message, headers, url)


def parse_chart_response(payload: dict) -> dict:
    try:
        section = payload["contents"]["sectionListRenderer"]["contents"][0]["musicAnalyticsSectionRenderer"]["content"]
        perspective = section["perspectiveMetadata"]
        params = perspective["requestParams"]["chartParams"]
        track_lists = section["trackTypes"]
    except (KeyError, IndexError, TypeError) as exc:
        raise PopularChartUnavailable() from exc

    chart_type = params.get("chartType")
    track_lists = section["trackTypes"]
    if not isinstance(track_lists, list):
        raise PopularChartUnavailable()
    title = "Top Songs" if chart_type in (None, "CHART_TYPE_UNKNOWN", "CHART_TYPE_TRACKS") else None
    if not title:
        raise PopularChartUnavailable()
    chart_lists = [item for item in track_lists
                   if isinstance(item, dict) and item.get("listType") == "TOP_VIEWS_CHART"]
    chart = next((item for item in chart_lists
                  if item.get("chartPeriodType") == "CHART_PERIOD_TYPE_WEEKLY"),
                 chart_lists[0] if chart_lists else None)
    if not chart or not isinstance(chart.get("trackViews"), list):
        raise PopularChartUnavailable()

    period = chart.get("chartPeriodType")
    market = params.get("countryCode") or params.get("region")
    if not isinstance(period, str) or not isinstance(market, str):
        raise PopularChartUnavailable()
    rows, seen = [], set()
    def rank_of(item):
        try:
            return int((item.get("chartEntryMetadata") or {}).get("currentPosition"))
        except (AttributeError, TypeError, ValueError):
            return 2**31

    chart_window = sorted(
        (item for item in chart["trackViews"] if isinstance(item, dict)),
        key=rank_of,
    )[:8]
    for entry in chart_window:
        video_id = entry.get("encryptedVideoId")
        entry_metadata = entry.get("chartEntryMetadata")
        title_text = entry.get("name")
        if (not isinstance(video_id, str) or not re.fullmatch(r"[\w-]{11}", video_id, re.ASCII)
                or video_id in seen or not isinstance(title_text, str) or not title_text.strip()
                or not isinstance(entry_metadata, dict)):
            continue
        try:
            rank = int(entry_metadata.get("currentPosition"))
        except (TypeError, ValueError):
            continue
        if rank < 1:
            continue
        seen.add(video_id)
        artists = entry.get("artists")
        artist = ", ".join(
            name for item in artists if isinstance(item, dict)
            if isinstance((name := item.get("name")), str) and name.strip()
        ) if isinstance(artists, list) else ""
        thumbnail_data = entry.get("thumbnail")
        thumbnails = thumbnail_data.get("thumbnails") if isinstance(thumbnail_data, dict) else None
        thumbnail = next((item["url"] for item in reversed(thumbnails or [])
                          if isinstance(item, dict) and isinstance(item.get("url"), str)
                          and item["url"].startswith("https://")), None)
        rows.append({
            "id": video_id,
            "title": title_text.strip()[:300],
            "artist": artist[:300],
            "rank": rank,
            "thumbnail": thumbnail or f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg",
            "videoId": video_id,
        })
    rows.sort(key=lambda item: item["rank"])
    if not rows:
        raise PopularChartUnavailable()
    warning = (
        "Some songs in this chart do not have a public video link; remaining ranks are unchanged."
        if len(rows) < len(chart_window) else None
    )
    return {
        "title": title,
        "period": period,
        "market": market,
        "chartDate": str(chart.get("endDate") or perspective.get("latestEndDate") or ""),
        "rows": rows,
        "sourceUrl": CHARTS_URL,
        **({"warning": warning} if warning else {}),
    }


def fetch_chart() -> dict:
    body = json.dumps({
        "context": {"client": {
            "clientName": "WEB_MUSIC_ANALYTICS",
            "clientVersion": "2.0",
            "hl": "en",
            "gl": "US",
        }},
        "browseId": "FEmusic_analytics_charts_home",
        "query": json.dumps({"region": "global"}),
    }).encode("utf-8")
    request = Request(CHARTS_API, data=body, headers={
        "Content-Type": "application/json",
        "Origin": "https://charts.youtube.com",
        "Referer": "https://charts.youtube.com/charts/TopSongs/global",
        "User-Agent": "Mozilla/5.0",
    })
    try:
        with build_opener(_ChartRedirects()).open(request, timeout=8) as response:
            if not response.geturl().startswith("https://charts.youtube.com/"):
                raise PopularChartUnavailable()
            length = response.headers.get("Content-Length")
            if length and int(length) > MAX_CHART_RESPONSE:
                raise PopularChartUnavailable()
            raw = response.read(MAX_CHART_RESPONSE + 1)
    except PopularChartUnavailable:
        raise
    except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
        raise PopularChartUnavailable() from exc
    if len(raw) > MAX_CHART_RESPONSE:
        raise PopularChartUnavailable()
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PopularChartUnavailable() from exc
    if not isinstance(payload, dict):
        raise PopularChartUnavailable()
    return parse_chart_response(payload)
