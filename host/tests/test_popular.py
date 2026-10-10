import json
import io
from pathlib import Path
from urllib.request import Request

import pytest

from mizan import popular
from mizan.api import Api
from mizan.jobs import JobRunner, JobStore

from mizan.popular import parse_chart_response


FIXTURE = Path(__file__).parent / "data" / "youtube-global-weekly-tracks.json"


def test_chart_parser_keeps_real_rank_fields_and_weekly_market_metadata():
    chart = parse_chart_response(json.loads(FIXTURE.read_text(encoding="utf-8")))

    assert chart["title"] == "Top Songs"
    assert chart["period"] == "CHART_PERIOD_TYPE_WEEKLY"
    assert chart["market"] == "global"
    assert chart["chartDate"] == "2026-10-03"
    assert [row["rank"] for row in chart["rows"]] == [1, 2]
    assert "do not have a public video link" in chart["warning"]
    assert chart["rows"][0]["videoId"] == "aB_12-cD345"
    assert chart["rows"][0]["artist"] == "Fixture Artist"
    assert chart["rows"][0]["thumbnail"] == "https://example.com/high.jpg"
    assert chart["rows"][1]["artist"] == "Second Artist, Guest Artist"


def test_chart_parser_rejects_malformed_or_empty_chart_responses():
    from mizan.errors import PopularChartUnavailable

    with pytest.raises(PopularChartUnavailable):
        parse_chart_response({})

    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    payload["contents"]["sectionListRenderer"]["contents"][0]["musicAnalyticsSectionRenderer"]["content"]["trackTypes"] = []
    with pytest.raises(PopularChartUnavailable):
        parse_chart_response(payload)


def test_live_fetch_uses_keyless_global_chart_browse_request(monkeypatch):
    payload = FIXTURE.read_bytes()
    requests = []

    class Response(io.BytesIO):
        headers = {}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            self.close()

        def geturl(self):
            return popular.CHARTS_API

    class Opener:
        def open(self, request, timeout):
            requests.append((request, timeout))
            return Response(payload)

    monkeypatch.setattr(popular, "build_opener", lambda *_args: Opener())
    result = popular.fetch_chart()

    request, timeout = requests[0]
    body = json.loads(request.data)
    assert request.full_url == popular.CHARTS_API
    assert timeout == 8
    assert "key=" not in request.full_url
    assert body["browseId"] == "FEmusic_analytics_charts_home"
    assert json.loads(body["query"]) == {"region": "global"}
    assert result["market"] == "global"


def test_chart_fetch_redirects_stay_on_the_official_https_host():
    request = Request(popular.CHARTS_API)
    handler = popular._ChartRedirects()

    allowed = handler.redirect_request(request, io.BytesIO(), 302, "Found", {},
                                       "https://charts.youtube.com/charts/TopSongs/global")
    assert allowed.full_url == "https://charts.youtube.com/charts/TopSongs/global"
    for target in ("http://charts.youtube.com/charts", "https://charts.youtube.com:444/charts",
                   "https://charts.youtube.com.evil.example/charts"):
        with pytest.raises(popular.PopularChartUnavailable):
            handler.redirect_request(request, io.BytesIO(), 302, "Found", {}, target)


def test_popular_chart_host_cache_is_six_hours_and_stale_chart_is_visible(monkeypatch):
    runner = JobRunner(JobStore(), lambda *_args: None)
    bridge = Api(runner)
    now = [100.0]
    fetched = []
    chart = {
        "title": "Top Songs", "period": "CHART_PERIOD_TYPE_WEEKLY",
        "market": "global", "chartDate": "2026-10-03", "sourceUrl": popular.CHARTS_URL,
        "rows": [],
    }
    monkeypatch.setattr("mizan.api.monotonic", lambda: now[0])
    monkeypatch.setattr("mizan.api.fetch_chart", lambda: fetched.append(1) or chart)
    try:
        first = bridge.popular_songs()
        now[0] += 60
        second = bridge.popular_songs()
        assert first["ok"] and second["ok"]
        assert first["fetchedAt"] == second["fetchedAt"]
        assert len(fetched) == 1

        now[0] += 6 * 60 * 60 + 1
        monkeypatch.setattr("mizan.api.fetch_chart",
                            lambda: (_ for _ in ()).throw(popular.PopularChartUnavailable()))
        stale = bridge.popular_songs()
        assert stale["ok"] and stale["rows"] == []
        assert "last fetched chart" in stale["warning"]
        assert stale["fetchedAt"] == first["fetchedAt"]
    finally:
        runner.close()


def test_popular_chart_first_failure_returns_unavailable_error(monkeypatch):
    runner = JobRunner(JobStore(), lambda *_args: None)
    bridge = Api(runner)
    monkeypatch.setattr("mizan.api.fetch_chart",
                        lambda: (_ for _ in ()).throw(popular.PopularChartUnavailable()))
    try:
        result = bridge.popular_songs()
        assert result["error"]["code"] == "popular_chart_unavailable"
    finally:
        runner.close()
