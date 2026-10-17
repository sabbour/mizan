import json
import logging
from copy import deepcopy
from pathlib import Path

import pytest
from yt_dlp.utils import DownloadError

from mizan import popular
from mizan.api import Api, POPULAR_SONGS_CACHE_SECONDS
from mizan.errors import PopularChartUnavailable
from mizan.jobs import JobRunner, JobStore
from mizan.youtube_auth import youtube_cookies_path, youtube_sign_out


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


def test_playlist_fetch_uses_metadata_without_extracting_video_playback(monkeypatch):
    from yt_dlp.utils import DownloadError

    class Playlist:
        def __init__(self, options):
            self.options = options
            assert options["skip_download"]
            assert options["playlistend"] == popular.POPULAR_PLAYLIST_LIMIT

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def extract_info(self, url, download):
            assert url == popular.HIT_LIST_URL
            assert download is False
            if self.options["extract_flat"] != "in_playlist":
                raise DownloadError("Sign in to confirm you're not a bot")
            return fixture_payloads()["hitList"]

    monkeypatch.setattr("yt_dlp.YoutubeDL", Playlist)
    result = popular._fetch_playlist(popular._PLAYLISTS[0])

    assert result["status"] == "available"
    assert [row["videoId"] for row in result["rows"]] == ["78wrful9cVU", "nUsrYVxrDwI"]


@pytest.mark.parametrize("error, expected", [
    ("Network offline", "Retry or search for a song"),
])
def test_playlist_failure_is_logged_and_explained(monkeypatch, caplog, error, expected):
    from yt_dlp.utils import DownloadError

    def unavailable(options):
        raise DownloadError(error)

    monkeypatch.setattr("yt_dlp.YoutubeDL", unavailable)
    result = popular._fetch_playlist(popular._PLAYLISTS[0])

    assert result["status"] == "unavailable"
    assert result["rows"] == []
    assert result["requiresAuth"] is False
    assert expected in result["message"]
    assert "hit-list" in caplog.text and "DownloadError" in caplog.text
    assert error not in caplog.text


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
    fetched = []
    failed_feed = {
        "title": "YouTube Music",
        "sections": [
            {"id": "hit-list", "status": "unavailable", "rows": []},
            {"id": "pops-biggest-hits", "status": "unavailable", "rows": []},
            {"id": "classic-rock-greatest-hits", "status": "unavailable", "rows": []},
            {"id": "all-time-alt", "status": "unavailable", "rows": []},
        ],
    }
    monkeypatch.setattr("mizan.api.fetch_popular_songs", lambda: fetched.append(1) or failed_feed)
    try:
        first = bridge.popular_songs()
        second = bridge.popular_songs()
        assert first["ok"] and second["ok"]
        assert [section["status"] for section in first["sections"]] == ["unavailable"] * 4
        assert len(fetched) == 2
    finally:
        runner.close()
def test_failed_initial_playlist_load_is_not_cached(monkeypatch):
    runner = JobRunner(JobStore(), lambda *_args: None)
    bridge = Api(runner)
    attempts = []

    def fetch():
        attempts.append(1)
        if len(attempts) == 1:
            return {"title": "YouTube Music", "sections": [
                {"id": "hit-list", "status": "unavailable", "rows": []},
            ]}
        return {"title": "YouTube Music", "sections": [
            {"id": "hit-list", "status": "available", "rows": [{"videoId": "78wrful9cVU"}]},
        ]}

    monkeypatch.setattr("mizan.api.fetch_popular_songs", fetch)
    try:
        failed = bridge.popular_songs()
        assert failed["ok"] and failed["sections"][0]["status"] == "unavailable"
        recovered = bridge.popular_songs()
        assert recovered["ok"] and recovered["sections"][0]["status"] == "available"
        assert len(attempts) == 2
        assert bridge.popular_songs() == recovered
        assert len(attempts) == 2
    finally:
        runner.close()


def test_playlist_fetch_uses_saved_youtube_cookies_and_logs_failures(monkeypatch, tmp_path, caplog):
    monkeypatch.setenv("MIZAN_HOME", str(tmp_path / "mizan"))
    cookies = youtube_cookies_path()
    cookies.parent.mkdir(parents=True, exist_ok=True)
    cookies.write_text(
        "# Netscape HTTP Cookie File\n"
        ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tSAPISID\tsynthetic-cookie-value\n",
        encoding="utf-8",
    )
    options_seen = []
    operation_cookie_files = []

    class Youtube:
        def __init__(self, options):
            options_seen.append(options)
            operation_cookie_files.append(Path(options["cookiefile"]))

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            operation_cookie_files[-1].write_text(
                "# yt-dlp simulated cookie-jar writeback\n", encoding="utf-8")
            youtube_sign_out()

        def extract_info(self, *_args, **_kwargs):
            raise DownloadError("temporary network failure")

    monkeypatch.setattr("yt_dlp.YoutubeDL", Youtube)

    with caplog.at_level(logging.WARNING, logger="mizan.popular"):
        result = popular._fetch_playlist(popular._PLAYLISTS[0])

    assert operation_cookie_files[0] != cookies
    assert options_seen[0]["cookiefile"] == str(operation_cookie_files[0])
    assert not operation_cookie_files[0].exists()
    assert not cookies.exists()
    assert options_seen[0]["extract_flat"] == "in_playlist"
    assert result["status"] == "unavailable"
    assert result["requiresAuth"] is False
    assert any("DownloadError" in record.getMessage() for record in caplog.records)


def test_playlist_auth_failure_is_actionable_without_exposing_error(monkeypatch, tmp_path):
    class Youtube:
        def __init__(self, _options):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def extract_info(self, *_args, **_kwargs):
            raise DownloadError("Sign in to confirm you're not a bot")

    monkeypatch.setenv("MIZAN_HOME", str(tmp_path / "empty-mizan"))
    monkeypatch.setattr("yt_dlp.YoutubeDL", Youtube)

    result = popular._fetch_playlist(popular._PLAYLISTS[0])

    assert result["requiresAuth"] is True
    assert result["message"] == "YouTube Music requires sign-in to load this playlist."
