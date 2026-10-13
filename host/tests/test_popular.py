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


def test_editorial_playlists_preserve_verified_metadata_order_without_chart_ranks():
    payloads = fixture_payloads()
    expected = (
        ("pops-biggest-hits", "popsBiggestHits", popular.POPS_BIGGEST_HITS_ID,
         "Pop's Biggest Hits", popular.POPS_BIGGEST_HITS_URL, "ic8j13piAhQ"),
        ("classic-rock-greatest-hits", "classicRocksGreatestHits",
         popular.CLASSIC_ROCK_GREATEST_HITS_ID, "Classic Rock's Greatest Hits",
         popular.CLASSIC_ROCK_GREATEST_HITS_URL, "OMOGaugKpzs"),
        ("all-time-alt", "allTimeAlt", popular.ALL_TIME_ALT_ID,
         "All-Time Alt", popular.ALL_TIME_ALT_URL, "hTWKbfoikeg"),
    )
    assert [section["id"] for section in popular._PLAYLISTS] == [
        "hit-list", "pops-biggest-hits", "classic-rock-greatest-hits", "all-time-alt",
    ]

    for section, (section_id, fixture_key, playlist_id, title, source_url, first_video_id) in zip(
        popular._PLAYLISTS[1:], expected
    ):
        payload = payloads[fixture_key]
        result = popular.parse_playlist_response(
            payload,
            playlist_id=playlist_id,
            title=title,
            publisher="YouTube Music",
        )
        assert section["id"] == section_id
        assert section["sourceUrl"] == source_url
        assert payload["modified_date"] == "20261013"
        assert payload["channel"] == section["publisher"] == "YouTube Music"
        assert result["description"] == payload["description"]
        assert result["chartDate"] == ""
        assert [row["videoId"] for row in result["rows"]] == [
            entry["id"] for entry in payload["entries"]
        ]
        assert result["rows"][0]["videoId"] == first_video_id
        assert all("rank" not in row for row in result["rows"])


def test_editorial_playlist_parser_rejects_wrong_source_and_preserves_order():
    payload = deepcopy(fixture_payloads()["popsBiggestHits"])
    payload["entries"].insert(1, deepcopy(payload["entries"][0]))
    result = popular.parse_playlist_response(
        payload,
        playlist_id=popular.POPS_BIGGEST_HITS_ID,
        title="Pop's Biggest Hits",
        publisher="YouTube Music",
    )

    assert [row["videoId"] for row in result["rows"]] == [
        entry["id"] for entry in fixture_payloads()["popsBiggestHits"]["entries"]
    ]
    payload["channel"] = "Unverified uploader"
    with pytest.raises(PopularChartUnavailable):
        popular.parse_playlist_response(
            payload,
            playlist_id=popular.POPS_BIGGEST_HITS_ID,
            title="Pop's Biggest Hits",
            publisher="YouTube Music",
        )


def test_playlist_fetches_are_independent_and_preserve_partial_errors(monkeypatch):
    def fetch(section):
        if section["id"] == "hit-list":
            return {**section, "status": "unavailable", "message": "playlist failed", "rows": []}
        payload = fixture_payloads()[{
            "pops-biggest-hits": "popsBiggestHits",
            "classic-rock-greatest-hits": "classicRocksGreatestHits",
            "all-time-alt": "allTimeAlt",
        }[section["id"]]]
        parsed = popular.parse_playlist_response(
            payload,
            playlist_id=section["playlist_id"],
            title=section["playlist_title"],
            publisher=section["publisher"],
            ranked=section["kind"] == "chart",
        )
        return {**section, "status": "available", **parsed}

    monkeypatch.setattr(popular, "_fetch_playlist", fetch)
    result = popular.fetch_popular_songs()

    assert [section["status"] for section in result["sections"]] == [
        "unavailable", "available", "available", "available",
    ]
    assert result["sections"][0]["id"] == "hit-list"
    assert [section["id"] for section in result["sections"]] == [
        "hit-list", "pops-biggest-hits", "classic-rock-greatest-hits", "all-time-alt",
    ]
    assert result["sections"][1]["sourceUrl"] == popular.POPS_BIGGEST_HITS_URL
    assert all("rank" not in row for section in result["sections"][1:] for row in section["rows"])


def test_popular_feed_cache_and_stale_snapshot(monkeypatch):
    runner = JobRunner(JobStore(), lambda *_args: None)
    bridge = Api(runner)
    now = [100.0]
    feed = {
        "title": "YouTube Music",
        "sections": [
            {"id": "hit-list", "status": "available", "rows": [{"videoId": "78wrful9cVU"}]},
            {"id": "pops-biggest-hits", "status": "available", "rows": [{"videoId": "ic8j13piAhQ"}]},
            {"id": "classic-rock-greatest-hits", "status": "available", "rows": [{"videoId": "OMOGaugKpzs"}]},
            {"id": "all-time-alt", "status": "available", "rows": [{"videoId": "hTWKbfoikeg"}]},
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
                {"id": "pops-biggest-hits", "status": "unavailable", "rows": []},
                {"id": "classic-rock-greatest-hits", "status": "unavailable", "rows": []},
                {"id": "all-time-alt", "status": "unavailable", "rows": []},
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
            {"id": "pops-biggest-hits", "status": "unavailable", "rows": []},
            {"id": "classic-rock-greatest-hits", "status": "unavailable", "rows": []},
            {"id": "all-time-alt", "status": "unavailable", "rows": []},
        ],
    })
    try:
        result = bridge.popular_songs()
        assert result["ok"]
        assert [section["status"] for section in result["sections"]] == ["unavailable"] * 4
    finally:
        runner.close()
