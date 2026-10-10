import json
from copy import deepcopy
from pathlib import Path

import pytest

from mizan import popular
from mizan.api import Api, POPULAR_SONGS_CACHE_SECONDS
from mizan.errors import PopularChartUnavailable
from mizan.jobs import JobRunner, JobStore


FIXTURE = Path(__file__).parent / "data" / "youtube-music-playlists.json"


def fixture_payloads():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_playlist_parser_keeps_real_hit_list_metadata_without_inventing_ranks():
    payload = fixture_payloads()["hitList"]
    result = popular.parse_playlist_response(
        payload,
        playlist_id=popular.HIT_LIST_ID,
        title="The Hit List",
        publisher="YouTube Music",
    )

    assert result["description"] == "The home of today's biggest and hottest hits."
    assert result["chartDate"] == ""
    assert result["rows"][0] == {
        "videoId": "78wrful9cVU",
        "title": "Olivia Rodrigo - drop dead (Official Music Video)",
        "artist": "Olivia Rodrigo",
        "thumbnail": "https://i.ytimg.com/vi/78wrful9cVU/maxresdefault.jpg",
    }
    assert all("rank" not in row for row in result["rows"])


def test_global_playlist_parser_preserves_order_as_real_chart_rank():
    payload = fixture_payloads()["globalTop100"]
    result = popular.parse_playlist_response(
        payload,
        playlist_id=popular.GLOBAL_TOP_100_ID,
        title="Top 100 Songs Global",
        publisher="YouTube Music Global Charts",
        ranked=True,
    )

    assert result["description"] == "This week's ranking of the most popular songs on YouTube."
    assert result["chartDate"] == "20261010"
    assert [row["rank"] for row in result["rows"]] == [1, 2]
    assert result["rows"][0]["videoId"] == "fcnDmrtj6Sk"


def test_playlist_parser_rejects_wrong_source_and_keeps_original_chart_positions():
    payload = deepcopy(fixture_payloads()["globalTop100"])
    payload["entries"].insert(1, deepcopy(payload["entries"][0]))
    payload["entries"].append({
        "id": "xvT1jH8B9AM",
        "title": "KALYANI Official Music Video",
        "channel": "MONEY VERSE RECORDS",
    })
    result = popular.parse_playlist_response(
        payload,
        playlist_id=popular.GLOBAL_TOP_100_ID,
        title="Top 100 Songs Global",
        publisher="YouTube Music Global Charts",
        ranked=True,
    )

    assert [row["rank"] for row in result["rows"]] == [1, 3, 4]
    payload["channel"] = "Unverified uploader"
    with pytest.raises(PopularChartUnavailable):
        popular.parse_playlist_response(
            payload,
            playlist_id=popular.GLOBAL_TOP_100_ID,
            title="Top 100 Songs Global",
            publisher="YouTube Music Global Charts",
            ranked=True,
        )


def test_playlist_fetches_are_independent_and_preserve_partial_errors(monkeypatch):
    def fetch(section):
        if section["id"] == "hit-list":
            return {**section, "status": "unavailable", "message": "playlist failed", "rows": []}
        parsed = popular.parse_playlist_response(
            fixture_payloads()["globalTop100"],
            playlist_id=section["playlist_id"],
            title=section["playlist_title"],
            publisher=section["publisher"],
            ranked=True,
        )
        return {**section, "status": "available", **parsed}

    monkeypatch.setattr(popular, "_fetch_playlist", fetch)
    result = popular.fetch_popular_songs()

    assert [section["status"] for section in result["sections"]] == ["unavailable", "available"]
    assert result["sections"][0]["id"] == "hit-list"
    assert result["sections"][1]["rows"][0]["rank"] == 1


def test_popular_feed_cache_and_stale_snapshot(monkeypatch):
    runner = JobRunner(JobStore(), lambda *_args: None)
    bridge = Api(runner)
    now = [100.0]
    feed = {
        "title": "YouTube Music",
        "sections": [
            {"id": "hit-list", "status": "available", "rows": [{"videoId": "78wrful9cVU"}]},
            {"id": "global-top-100", "status": "available", "rows": [{"videoId": "fcnDmrtj6Sk"}]},
        ],
    }
    fetched = []
    monkeypatch.setattr("mizan.api.monotonic", lambda: now[0])
    monkeypatch.setattr("mizan.api.fetch_popular_songs", lambda: fetched.append(1) or feed)
    try:
        first = bridge.popular_songs()
        now[0] += 60
        second = bridge.popular_songs()
        assert first["ok"] and second["ok"]
        assert first["fetchedAt"] == second["fetchedAt"]
        assert len(fetched) == 1
        refreshed = bridge.popular_songs(True)
        assert refreshed["ok"] and len(fetched) == 2

        now[0] += POPULAR_SONGS_CACHE_SECONDS + 1
        monkeypatch.setattr("mizan.api.fetch_popular_songs", lambda: {
            "title": "YouTube Music",
            "sections": [
                {"id": "hit-list", "status": "unavailable", "rows": []},
                {"id": "global-top-100", "status": "unavailable", "rows": []},
            ],
        })
        stale = bridge.popular_songs()
        assert stale["ok"]
        assert stale["sections"] == feed["sections"]
        assert "last playlist snapshot" in stale["warning"]
        assert stale["fetchedAt"] == refreshed["fetchedAt"]
    finally:
        runner.close()
def test_all_playlist_failures_are_visible_without_a_cached_success(monkeypatch):
    runner = JobRunner(JobStore(), lambda *_args: None)
    bridge = Api(runner)
    monkeypatch.setattr("mizan.api.fetch_popular_songs", lambda: {
        "title": "YouTube Music",
        "sections": [
            {"id": "hit-list", "status": "unavailable", "rows": []},
            {"id": "global-top-100", "status": "unavailable", "rows": []},
        ],
    })
    try:
        result = bridge.popular_songs()
        assert result["ok"]
        assert [section["status"] for section in result["sections"]] == ["unavailable", "unavailable"]
    finally:
        runner.close()
