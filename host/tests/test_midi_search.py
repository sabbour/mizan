import base64
import copy
import hashlib
import io
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request

import mido
import pytest

from mizan import midi_search
from mizan.api import Api
from mizan.errors import InvalidFile, MidiSearchFailed
from mizan.jobs import JobRunner, JobStore
from mizan.library import public_entry


DATA = Path(__file__).parent / "data"


def _midi_bytes() -> bytes:
    midi = mido.MidiFile()
    track = mido.MidiTrack()
    track.append(mido.Message("note_on", note=60, velocity=64, time=0))
    track.append(mido.Message("note_off", note=60, velocity=0, time=480))
    midi.tracks.append(track)
    stream = io.BytesIO()
    midi.save(file=stream)
    return stream.getvalue()


def test_commons_fixture_sorts_and_keeps_only_confirmed_allowed_licenses():
    payload = json.loads((DATA / "commons-midi.json").read_text(encoding="utf-8"))

    results = midi_search.parse_commons_response(payload)

    assert [item["title"] for item in results] == ["Share Alike.midi", "PD Piece.mid"]
    assert results[0]["license"] == "CC BY-SA"
    assert results[1]["license"] == "Public Domain"
    assert results[1]["artist"] == "Composer Example"
    assert results[1]["attribution"] == "Sequenced by A. Musician"


@pytest.mark.parametrize(("license_name", "expected"), [
    ("Public domain", "Public Domain"),
    ("CC0 1.0 Universal", "CC0"),
    ("CC BY 4.0", "CC BY"),
    ("Creative Commons Attribution-ShareAlike 4.0", "CC BY-SA"),
    ("CC BY-NC 4.0", None),
    ("CC BY-ND 4.0", None),
    ("CC BY-SA-NC 4.0", None),
    ("All rights reserved", None),
    ("", None),
])
def test_license_allowlist(license_name, expected):
    assert midi_search._license_name(license_name) == expected


def test_mutopia_fixture_parses_piece_license_and_source_links():
    document = (DATA / "mutopia-midi.html").read_text(encoding="utf-8")

    results = midi_search.parse_mutopia_response(document)

    assert [(item["title"], item["artist"], item["license"]) for item in results] == [
        ("Piano Sonata in C", "Example Composer", "Public Domain"),
        ("Étude No. 2", "Second Composer", "CC BY-SA"),
    ]
    assert results[0]["url"] == "https://www.mutopiaproject.org/ftp/Example/sonata.mid"
    assert results[0]["sourceUrl"] == "https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=101"


def test_mutopia_search_uses_required_endpoint_and_page_offset(monkeypatch):
    requested = []
    monkeypatch.setattr(midi_search, "_request_bytes", lambda url, hosts, **_: requested.append(url) or b"<html/>")

    results, next_start = midi_search.search_mutopia("Moonlight sonata", 10)

    assert results == []
    assert next_start is None
    assert requested[0].startswith("https://www.mutopiaproject.org/cgibin/make-table.cgi?")
    assert "searchingfor=Moonlight+sonata" in requested[0]
    assert "Instrument=Piano" in requested[0]
    assert "startat=10" in requested[0]


def test_mutopia_pagination_counts_raw_results_even_when_some_licenses_are_skipped(monkeypatch):
    allowed = """<table class="result-table"><td>Sonata</td><td>Composer</td><td>Example</td>
      <a href="../legal.html#publicdomain">Public Domain</a>
      <a href="../ftp/sonata.mid">MIDI</a>
      <a href="../cgibin/piece-info.cgi?id=1">Source</a></table>"""
    restricted = """<table class="result-table"><td>Restricted</td><td>Composer</td><td>Example</td>
      <a href="../legal.html#cc-nc">CC BY-NC</a>
      <a href="../ftp/restricted.mid">MIDI</a>
      <a href="../cgibin/piece-info.cgi?id=2">Source</a></table>"""
    monkeypatch.setattr(midi_search, "_request_bytes",
                        lambda *_args, **_kwargs: (allowed + restricted * 9).encode())

    results, next_start = midi_search.search_mutopia("sonata")

    assert len(results) == 1
    assert next_start == 10


def test_archive_metadata_requires_exact_cc0_and_original_bounded_midi():
    metadata = json.loads((DATA / "archive-metadata.json").read_text(encoding="utf-8"))

    results = midi_search.parse_archive_item("guido-von-arezzo-ut-queant-laxis", metadata)

    assert len(results) == 1
    result = results[0]
    assert result["source"] == "Internet Archive"
    assert result["license"] == "CC0"
    assert result["size"] == 460
    assert result["hashes"]["md5"] == "07389bc3c53720c3b29260a788f4f98c"
    assert result["hashes"]["sha1"] == "0c437ab5a651de7c5016a5d6073c321ff54cc01e"
    assert result["url"] == (
        "https://archive.org/download/guido-von-arezzo-ut-queant-laxis/"
        "Guido%20von%20Arezzo%20--%20Ut%20queant%20laxis.mid"
    )

    unlicensed = copy.deepcopy(metadata)
    unlicensed["metadata"]["licenseurl"] = "http://creativecommons.org/licenses/by-nc/4.0/"
    assert midi_search.parse_archive_item("guido-von-arezzo-ut-queant-laxis", unlicensed) == []
    derivative = copy.deepcopy(metadata)
    derivative["files"][0]["source"] = "derivative"
    assert midi_search.parse_archive_item("guido-von-arezzo-ut-queant-laxis", derivative) == []
    wrong_item = copy.deepcopy(metadata)
    wrong_item["metadata"]["identifier"] = "another-item"
    assert midi_search.parse_archive_item("guido-von-arezzo-ut-queant-laxis", wrong_item) == []


def test_archive_search_and_metadata_use_keyless_endpoints_and_and_terms(monkeypatch):
    search_payload = (DATA / "archive-search.json").read_bytes()
    metadata_payload = (DATA / "archive-metadata.json").read_bytes()
    requested = []

    def fetch(url, hosts, **_kwargs):
        requested.append((url, hosts))
        return metadata_payload if "/metadata/" in url else search_payload

    monkeypatch.setattr(midi_search, "_request_bytes", fetch)
    results = midi_search.search_archive("Guido von Arezzo")

    assert len(results) == 1
    search_url = next(url for url, _hosts in requested if "advancedsearch.php" in url)
    params = parse_qs(urlsplit(search_url).query)
    assert params["q"] == [
        'format:"MIDI" AND licenseurl:"http://creativecommons.org/publicdomain/zero/1.0/"'
        ' AND "Guido" AND "von" AND "Arezzo"'
    ]
    assert params["fl[]"] == ["identifier", "title", "licenseurl"]
    assert params["rows"] == ["5"] and params["page"] == ["1"] and params["output"] == ["json"]
    assert all(hosts == midi_search.ARCHIVE_HOSTS for _url, hosts in requested)


def test_archive_metadata_unavailability_is_reported_as_provider_failure(monkeypatch):
    search_payload = (DATA / "archive-search.json").read_bytes()

    def unavailable_metadata(url, _hosts):
        if "advancedsearch.php" in url:
            return search_payload
        raise MidiSearchFailed()

    monkeypatch.setattr(midi_search, "_request_bytes", unavailable_metadata)

    with pytest.raises(MidiSearchFailed):
        midi_search.search_archive("Guido")


def test_archive_download_validates_storage_redirect_domain_size_and_hash(monkeypatch):
    result = midi_search.parse_archive_item(
        "guido-von-arezzo-ut-queant-laxis",
        json.loads((DATA / "archive-metadata.json").read_text(encoding="utf-8")),
    )[0]
    data = b"MThd" + b"x" * (result["size"] - 4)
    result["hashes"] = {
        "md5": hashlib.md5(data).hexdigest(),
        "sha1": hashlib.sha1(data).hexdigest(),
    }
    requested = []
    monkeypatch.setattr(midi_search, "_request_bytes",
                        lambda url, hosts: requested.append((url, hosts)) or data)

    assert midi_search.download_midi(result) == data
    assert requested == [(result["url"], midi_search.ARCHIVE_DOWNLOAD_HOSTS)]

    result["hashes"]["sha1"] = "0" * 40
    with pytest.raises(InvalidFile, match="hash"):
        midi_search.download_midi(result)


def test_archive_redirects_allow_archive_storage_subdomains_only():
    handler = midi_search._ApprovedRedirects(midi_search.ARCHIVE_DOWNLOAD_HOSTS)
    request = Request("https://archive.org/download/item/score.mid")

    storage_url = "https://dn710209.ca.archive.org/0/items/item/score.mid"
    assert handler.redirect_request(request, io.BytesIO(), 302, "Found", {}, storage_url).full_url == storage_url
    for url in ("https://archive.org.evil.example/score.mid", "https://evilarchive.org/score.mid"):
        with pytest.raises(ValueError):
            handler.redirect_request(request, io.BytesIO(), 302, "Found", {}, url)


def test_commons_search_uses_required_action_api_parameters(monkeypatch):
    requested = []
    payload = (DATA / "commons-midi.json").read_bytes()
    monkeypatch.setattr(midi_search, "_request_bytes",
                        lambda url, hosts, **_: requested.append(url) or payload)

    results = midi_search.search_commons("Moonlight sonata")

    assert len(results) == 2
    params = parse_qs(urlsplit(requested[0]).query)
    assert params["action"] == ["query"]
    assert params["generator"] == ["search"]
    assert params["gsrsearch"] == ["Moonlight sonata filemime:audio/midi"]
    assert params["gsrnamespace"] == ["6"]
    assert params["gsrlimit"] == ["5"]
    assert params["prop"] == ["imageinfo"]
    assert params["iiprop"] == ["url|mime|size|extmetadata"]
    assert params["iiextmetadatafilter"] == [
        "LicenseShortName|LicenseUrl|Artist|Credit|UsageTerms|AttributionRequired"
    ]
    assert params["format"] == ["json"]
    assert params["formatversion"] == ["2"]


def test_bitmidi_response_reads_only_ordered_search_results_and_keeps_license_unknown():
    payload = {
        "location": {"name": "search"},
        "data": {"midis": {
            "moonlight-sonata": {
                "id": 16752, "slug": "moonlight-sonata", "name": "Moonlight Sonata",
                "url": "/moonlight-sonata", "downloadUrl": "/uploads/16752.mid",
            },
            "unrelated": {
                "id": 99, "slug": "unrelated", "name": "Unrelated",
                "url": "/unrelated", "downloadUrl": "/uploads/99.mid",
            },
        }},
        "views": {"search": {"Moonlight": {"0": ["moonlight-sonata"], "total": 1, "pageTotal": 1}}},
    }
    document = f"<script>window.initStore = {json.dumps(payload)};</script>"

    results = midi_search.parse_bitmidi_response(document, "Moonlight")

    assert len(results) == 1
    assert results[0]["title"] == "Moonlight Sonata"
    assert results[0]["source"] == "BitMidi"
    assert results[0]["artist"] is None
    assert results[0]["license"] == "Not listed by source"
    assert results[0]["licenseUrl"] is None
    assert results[0]["url"] == "https://bitmidi.com/uploads/16752.mid"
    assert results[0]["sourceUrl"] == "https://bitmidi.com/moonlight-sonata"


def test_bitmidi_empty_search_is_empty_but_unrecognized_layout_fails():
    empty = {"location": {"name": "search"}, "data": {"midis": {}},
             "views": {"search": {"Moonlight": {"0": [], "total": 0, "pageTotal": 0}}}}
    assert midi_search.parse_bitmidi_response(
        f"<script>window.initStore = {json.dumps(empty)};</script>", "Moonlight") == []
    with pytest.raises(MidiSearchFailed):
        midi_search.parse_bitmidi_response("<html><title>Check your browser</title></html>", "Moonlight")


def test_bitmidi_search_encodes_query_and_uses_only_approved_search_host(monkeypatch):
    requested = []
    payload = {
        "location": {"name": "search"}, "data": {"midis": {}},
        "views": {"search": {"A & B": {"0": [], "total": 0, "pageTotal": 0}}},
    }
    monkeypatch.setattr(midi_search, "_request_bytes",
                        lambda url, hosts: requested.append((url, hosts))
                        or f"<script>window.initStore = {json.dumps(payload)};</script>".encode())

    assert midi_search.search_bitmidi("A & B") == []
    params = parse_qs(urlsplit(requested[0][0]).query)
    assert params == {"q": ["A & B"]}
    assert requested[0][1] == midi_search.BITMIDI_HOSTS


def test_freemidi_cards_keep_title_artist_and_deduplicate_view_links():
    document = """
      <div class="card"><div class="card-body">
        <h5 class="card-title"><a href="download3-1034-mr-moonlight-beatles"
          title="Mr. Moonlight">Mr. Moonlight</a></h5>
        <div class="card-text"><a href="/artist-251-beatles">Beatles</a></div>
        <div class="card-img"><a href="/download3-1034-mr-moonlight-beatles">cover</a></div>
      </div></div>
    """

    results = midi_search.parse_freemidi_response(document)

    assert len(results) == 1
    assert results[0]["title"] == "Mr. Moonlight"
    assert results[0]["artist"] == "Beatles"
    assert results[0]["source"] == "FreeMIDI"
    assert results[0]["license"] == "Not listed by source"
    assert results[0]["attribution"] == "Artist listed: Beatles"
    assert results[0]["sourceUrl"] == "https://freemidi.org/download3-1034-mr-moonlight-beatles"

    unsafe = document.replace(
        "download3-1034-mr-moonlight-beatles",
        "https://attacker.example/download3-1034-mr-moonlight-beatles",
    )
    with pytest.raises(MidiSearchFailed):
        midi_search.parse_freemidi_response(unsafe)


def test_freemidi_search_encodes_query_and_uses_only_approved_search_host(monkeypatch):
    requested = []
    monkeypatch.setattr(midi_search, "_request_bytes",
                        lambda url, hosts: requested.append((url, hosts))
                        or b"<form action='/search'></form><div id='mainContent' class='container'></div>")

    assert midi_search.search_freemidi("A & B") == []
    assert parse_qs(urlsplit(requested[0][0]).query) == {"q": ["A & B"]}
    assert requested[0][1] == midi_search.FREEMIDI_HOSTS


def test_freemidi_empty_search_shape_is_not_a_layout_failure():
    document = "<form action='/search'></form><div id='mainContent' class='container'><a href='/search-help'>Help</a></div>"
    assert midi_search.parse_freemidi_response(document) == []
    with pytest.raises(MidiSearchFailed):
        midi_search.parse_freemidi_response("<html><title>Access denied</title></html>")


def test_freemidi_import_uses_matching_detail_control_referer_and_ephemeral_cookies(monkeypatch):
    result = {
        "id": "freemidi:1034", "provider": "freemidi",
        "license": "Not listed by source",
        "sourceUrl": "https://freemidi.org/download3-1034-mr-moonlight-beatles",
    }
    calls = []

    def fetch(url, hosts, limit=midi_search.MAX_MIDI_BYTES, headers=None, cookie_jar=None):
        calls.append((url, hosts, headers, cookie_jar))
        if url == result["sourceUrl"]:
            return b'<a id="downloadmidi" href="getter-1034">Download MIDI</a>'
        return _midi_bytes()

    monkeypatch.setattr(midi_search, "_request_bytes", fetch)
    assert midi_search.download_midi(result).startswith(b"MThd")
    assert [call[0] for call in calls] == [
        result["sourceUrl"], "https://freemidi.org/getter-1034",
    ]
    assert calls[1][2] == {"Referer": result["sourceUrl"]}
    assert calls[0][3] is calls[1][3]


def test_freemidi_import_rejects_a_download_control_for_another_file(monkeypatch):
    result = {
        "id": "freemidi:1034", "provider": "freemidi",
        "license": "Not listed by source",
        "sourceUrl": "https://freemidi.org/download3-1034-mr-moonlight-beatles",
    }
    calls = []
    monkeypatch.setattr(midi_search, "_request_bytes",
                        lambda url, _hosts, **_kwargs:
                        calls.append(url) or b'<a id="downloadmidi" href="getter-999">Download</a>')

    with pytest.raises(InvalidFile, match="does not match"):
        midi_search.download_midi(result)
    assert calls == [result["sourceUrl"]]


def test_bitmidi_download_requires_its_searched_file_path_and_approved_host(monkeypatch):
    result = {
        "id": "bitmidi:16752", "provider": "bitmidi",
        "license": "Not listed by source",
        "url": "https://bitmidi.com/uploads/16752.mid",
        "sourceUrl": "https://bitmidi.com/moonlight-sonata",
        "_downloadPath": "/uploads/16752.mid",
    }
    calls = []
    monkeypatch.setattr(midi_search, "_request_bytes",
                        lambda url, hosts: calls.append((url, hosts)) or _midi_bytes())
    assert midi_search.download_midi(result).startswith(b"MThd")
    assert calls == [(result["url"], midi_search.BITMIDI_HOSTS)]

    calls.clear()
    result["url"] = "https://bitmidi.com/uploads/other.mid"
    with pytest.raises(InvalidFile, match="approved download path"):
        midi_search.download_midi(result)
    result["url"] = "https://attacker.example/16752.mid"
    with pytest.raises(InvalidFile, match="approved download path"):
        midi_search.download_midi(result)
    assert calls == []


def test_metadata_html_removes_markup_and_script_content():
    assert midi_search._clean_html("Composer <b>Example</b><script>bad()</script>") == "Composer Example"


@pytest.mark.parametrize("url", [
    "http://commons.wikimedia.org/wiki/File:score.mid",
    "https://evil.example/score.mid",
    "https://commons.wikimedia.org.evil.example/score.mid",
    "https://user@commons.wikimedia.org/score.mid",
    "https://commons.wikimedia.org:444/score.mid",
])
def test_url_validation_rejects_non_https_unapproved_and_credential_urls(url):
    with pytest.raises(ValueError):
        midi_search._validate_url(url, midi_search.COMMONS_HOSTS)


def test_redirect_handler_rejects_unsafe_hop_and_allows_approved_upload_host():
    handler = midi_search._ApprovedRedirects(midi_search.COMMONS_HOSTS)
    request = Request("https://commons.wikimedia.org/wiki/File:score.mid")
    headers = {}

    with pytest.raises(ValueError):
        handler.redirect_request(request, io.BytesIO(), 302, "Found", headers,
                                 "https://attacker.example/score.mid")
    redirected = handler.redirect_request(request, io.BytesIO(), 302, "Found", headers,
                                          "https://upload.wikimedia.org/score.mid")
    assert redirected.full_url == "https://upload.wikimedia.org/score.mid"

    mutopia = midi_search._ApprovedRedirects(midi_search.MUTOPIA_HOSTS)
    mutopia_request = Request("https://www.mutopiaproject.org/ftp/score.mid")
    with pytest.raises(ValueError):
        mutopia.redirect_request(mutopia_request, io.BytesIO(), 302, "Found", headers,
                                 "https://upload.wikimedia.org/score.mid")


def test_download_checks_bound_and_midi_header(monkeypatch):
    result = {
        "provider": "commons",
        "url": "https://upload.wikimedia.org/file.mid",
        "sourceUrl": "https://commons.wikimedia.org/wiki/File:file.mid",
        "license": "CC BY",
    }
    monkeypatch.setattr(midi_search, "_request_bytes", lambda *_args, **_kwargs: b"not a MIDI")
    with pytest.raises(InvalidFile, match="MIDI header"):
        midi_search.download_midi(result)

def test_request_rejects_oversized_content_length(monkeypatch):
    class Response(io.BytesIO):
        headers = {"Content-Length": str(midi_search.MAX_MIDI_BYTES + 1)}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            self.close()

        def geturl(self):
            return "https://upload.wikimedia.org/file.mid"

    class Opener:
        def open(self, *_args, **_kwargs):
            return Response(b"MThd")

    monkeypatch.setattr(midi_search, "build_opener", lambda *_args: Opener())
    with pytest.raises(InvalidFile, match="larger than 2 MB"):
        midi_search._request_bytes("https://upload.wikimedia.org/file.mid", midi_search.COMMONS_HOSTS)


def test_request_rejects_oversized_stream_without_content_length(monkeypatch):
    class Response(io.BytesIO):
        headers = {}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            self.close()

        def geturl(self):
            return "https://upload.wikimedia.org/file.mid"

    class Opener:
        def open(self, *_args, **_kwargs):
            return Response(b"MThd" + b"x" * (midi_search.MAX_MIDI_BYTES + 1))

    monkeypatch.setattr(midi_search, "build_opener", lambda *_args: Opener())
    with pytest.raises(InvalidFile, match="larger than 2 MB"):
        midi_search._request_bytes("https://upload.wikimedia.org/file.mid", midi_search.COMMONS_HOSTS)


def test_api_search_does_not_import_until_explicit_result_import(monkeypatch):
    result = {
        "id": "commons:test-result",
        "provider": "commons",
        "source": "Wikimedia Commons",
        "title": "Imported test piece",
        "artist": "Test Composer",
        "license": "CC BY",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "attribution": "Test Composer",
        "url": "https://upload.wikimedia.org/wikipedia/commons/test.mid",
        "sourceUrl": "https://commons.wikimedia.org/wiki/File:test.mid",
    }
    monkeypatch.setattr(midi_search, "search_commons", lambda _query: [result])
    monkeypatch.setattr(midi_search, "download_midi", lambda _result: _midi_bytes())
    runner = JobRunner(JobStore(), lambda *_args: None)
    api = Api(runner)
    try:
        searched = api.search_midi_commons("test")
        assert searched["ok"]
        assert "url" not in searched["results"][0]
        assert api._library.list() == []

        imported = api.import_midi_result(result["id"])

        assert imported["ok"]
        entry = imported["entry"]
        assert entry["artist"] == "Test Composer"
        assert entry["license"] == "CC BY"
        assert entry["attribution"] == "Test Composer"
        assert entry["sourceUrl"] == result["sourceUrl"]
        assert len(api._library.list()) == 1
    finally:
        runner.close()


def test_archive_api_hides_file_url_and_hash_until_explicit_import(monkeypatch):
    result = {
        "id": "archive:test-item:test-file",
        "dedupeKey": "file-digest",
        "provider": "archive",
        "source": "Internet Archive",
        "title": "Test score",
        "artist": None,
        "license": "CC0",
        "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
        "attribution": "Attribution not required (CC0)",
        "url": "https://archive.org/download/test-item/score.mid",
        "sourceUrl": "https://archive.org/details/test-item",
        "identifier": "test-item",
        "fileName": "score.mid",
        "size": 460,
        "hashes": {"sha1": "0" * 40},
        "_licenseUrl": midi_search.ARCHIVE_CC0_URL,
    }
    monkeypatch.setattr(midi_search, "search_archive", lambda _query: [result])
    runner = JobRunner(JobStore(), lambda *_args: None)
    api = Api(runner)
    try:
        response = api.search_midi_archive("score")
        assert response["ok"]
        assert response["results"][0]["source"] == "Internet Archive"
        assert "url" not in response["results"][0]
        assert "hashes" not in response["results"][0]
        assert "identifier" not in response["results"][0]
        assert api._library.list() == []
    finally:
        runner.close()


def test_import_by_url_cannot_be_requested_without_a_searched_result():
    runner = JobRunner(JobStore(), lambda *_args: None)
    api = Api(runner)
    try:
        result = api.import_midi_result("https://attacker.example/file.mid")
        assert result["ok"] is False
        assert result["error"]["code"] == "invalid_file"
        assert api._library.list() == []
    finally:
        runner.close()


@pytest.mark.parametrize("provider", ["bitmidi", "freemidi"])
def test_unknown_license_import_requires_strict_confirmation_before_download(monkeypatch, provider):
    result = {
        "id": "bitmidi:16752",
        "provider": "bitmidi",
        "source": "BitMidi",
        "title": "Moonlight Sonata",
        "artist": None,
        "license": "Not listed by source",
        "licenseUrl": None,
        "attribution": "Not listed by source",
        "url": "https://bitmidi.com/uploads/16752.mid",
        "sourceUrl": "https://bitmidi.com/moonlight-sonata",
        "_downloadPath": "/uploads/16752.mid",
    }
    if provider == "freemidi":
        result.update({
            "id": "freemidi:1034", "provider": "freemidi", "source": "FreeMIDI",
            "artist": "Example Artist",
            "sourceUrl": "https://freemidi.org/download3-1034-moonlight-example",
        })
    monkeypatch.setattr(midi_search, f"search_{provider}", lambda _query: [result])
    downloads = []
    monkeypatch.setattr(midi_search, "download_midi",
                        lambda item: downloads.append(item) or _midi_bytes())
    runner = JobRunner(JobStore())
    api = Api(runner)
    try:
        searched = getattr(api, f"search_midi_{provider}")("Moonlight")
        assert searched["ok"]
        assert "_downloadPath" not in searched["results"][0]
        assert "url" not in searched["results"][0]
        result_id = searched["results"][0]["id"]

        assert not api.import_midi_result(result_id)["ok"]
        assert not api.import_midi_result(result_id, False)["ok"]
        assert not api.import_midi_result(result_id, "true")["ok"]
        assert not api.import_midi_result(result_id, 1)["ok"]
        assert downloads == []

        imported = api.import_midi_result(result_id, True)

        assert imported["ok"]
        entry = imported["entry"]
        assert entry["title"] == "Moonlight Sonata"
        assert entry["artist"] == result["artist"]
        assert entry["sourceUrl"] == result["sourceUrl"]
        assert entry["provider"] == result["source"]
        assert entry["license"] == "Not listed by source"
        assert entry["attribution"] == "Not listed by source"
        reopened = public_entry(api._library.get(entry["id"]), runner.pipeline_version)
        assert reopened["provider"] == result["source"]
        assert reopened["license"] == "Not listed by source"
        assert reopened["attribution"] == "Not listed by source"
        assert len(downloads) == 1
    finally:
        runner.close()
