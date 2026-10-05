import base64
import io
import json
import sqlite3
import time
import zipfile
from urllib.parse import unquote, urlparse
from xml.etree import ElementTree as ET
from threading import Event
from concurrent.futures import ThreadPoolExecutor

import mido
import numpy as np
import pytest

from mizan.alignment import dtw_tempo_map
from mizan.api import Api
from mizan.engine.audio import Audio
from mizan.engine.output import export_midi, export_musicxml
from mizan.engine.detect import detect_instruments, selected_instruments
from mizan.errors import ModelFailed
from mizan.imports import notes_to_song, parse_midi, parse_musicxml
from mizan.jobs import JobRunner, JobStore
from mizan.library import LibraryStore
from mizan.paths import app_dir

from test_jobs import URL, wait_for


def midi_data() -> bytes:
    midi = mido.MidiFile(ticks_per_beat=480)
    piano = mido.MidiTrack()
    piano.append(mido.MetaMessage("track_name", name="Piano"))
    piano.append(mido.Message("program_change", program=0, channel=0))
    piano.append(mido.Message("note_on", note=60, velocity=100, channel=0, time=0))
    piano.append(mido.Message("note_off", note=60, velocity=0, channel=0, time=480))
    drums = mido.MidiTrack()
    drums.append(mido.MetaMessage("track_name", name="Drum kit"))
    drums.append(mido.Message("note_on", note=36, velocity=110, channel=9, time=0))
    drums.append(mido.Message("note_off", note=36, velocity=0, channel=9, time=120))
    drums.append(mido.Message("note_on", note=42, velocity=80, channel=9, time=120))
    drums.append(mido.Message("note_off", note=42, velocity=0, channel=9, time=120))
    midi.tracks.extend((piano, drums))
    output = io.BytesIO()
    midi.save(file=output)
    return output.getvalue()


MUSICXML = b"""<?xml version="1.0"?>
<score-partwise version="3.1">
  <work><work-title>XML Study</work-title></work>
  <part-list><score-part id="P1"><part-name>Keyboard</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
    <direction><sound tempo="90"/></direction>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration></note>
    <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration></note>
  </measure></part>
</score-partwise>"""


def api_with_idle_runner():
    runner = JobRunner(JobStore(), lambda job, report, cancelled: None)
    return Api(runner), runner


def test_midi_musicxml_and_mxl_imports_and_position_roundtrip():
    api, runner = api_with_idle_runner()
    try:
        imported = api.import_file("duet.mid", base64.b64encode(midi_data()).decode())
        assert imported["ok"] and imported["entry"]["parts"] == ["Piano", "Drum kit"]
        opened = api.open_song(imported["entry"]["id"])
        assert opened["song"]["piano"] and {hit["lane"] for hit in opened["song"]["drums"]} == {"kick", "hihat"}
        assert opened["song"]["confidence"]["piano"] == ["high"]
        assert opened["artifacts"]["midi"].startswith("file:")
        assert "stems" not in opened

        xml = api.import_file("study.musicxml", base64.b64encode(MUSICXML).decode())
        assert xml["entry"]["title"] == "XML Study"
        assert api.open_song(xml["entry"]["id"])["song"]["bpm"] == 90

        package = io.BytesIO()
        with zipfile.ZipFile(package, "w") as archive:
            archive.writestr("META-INF/container.xml", """<container><rootfiles>
                <rootfile full-path="score.xml"/></rootfiles></container>""")
            archive.writestr("score.xml", MUSICXML)
        mxl = api.import_file("study.mxl", base64.b64encode(package.getvalue()).decode())
        assert mxl["ok"] and mxl["entry"]["source"] == "musicxml"

        position = {"bar": 1, "loop": {"startBar": 1, "endBar": 1}, "loopName": "Chorus",
                    "rate": 0.75, "trackId": "piano", "muted": ["drums"], "solo": [],
                    "futureField": {"kept": True}}
        assert api.save_position(imported["entry"]["id"], position) == {"ok": True}
        saved = next(entry for entry in api.list_library()["entries"]
                     if entry["id"] == imported["entry"]["id"])
        assert saved["position"] == position and saved["practicedAt"]
        assert saved["folders"] == []
    finally:
        runner.close()


def test_split_piano_hands_import_as_one_grand_staff():
    midi = mido.MidiFile(ticks_per_beat=480)
    for name, pitch in (("up", 76), ("down", 62)):
        track = mido.MidiTrack()
        track.append(mido.MetaMessage("track_name", name=name))
        track.append(mido.Message("note_on", note=pitch, velocity=90, channel=0))
        track.append(mido.Message("note_off", note=pitch, velocity=0, channel=0, time=480))
        midi.tracks.append(track)
    source = io.BytesIO()
    midi.save(file=source)
    api, runner = api_with_idle_runner()
    try:
        created = api.import_file("piano.mid", base64.b64encode(source.getvalue()).decode())
        assert created["entry"]["parts"] == ["Piano"]
        song = api.open_song(created["entry"]["id"])["song"]
        assert len(song["tracks"]) == 1
        assert {(note["midi"], note["hand"], note["trackId"]) for note in song["piano"]} == {
            (76, "right", "piano"), (62, "left", "piano")}
    finally:
        runner.close()


def test_guitar_program_survives_midi_and_musicxml_import_export(tmp_path):
    midi = mido.MidiFile(ticks_per_beat=480)
    track = mido.MidiTrack()
    track.append(mido.MetaMessage("track_name", name="Guitars"))
    for program, note in ((24, 64), (25, 67), (40, 69)):
        track.append(mido.Message("program_change", channel=0, program=program))
        track.append(mido.Message("note_on", channel=0, note=note, velocity=90))
        track.append(mido.Message("note_off", channel=0, note=note, velocity=0, time=480))
    midi.tracks.append(track)
    source = io.BytesIO()
    midi.save(file=source)
    _, bpm, beats_per_bar, beat_unit, parts = parse_midi(source.getvalue())
    guitars = [part for part in parts if part.get("gmProgram") is not None]
    assert [part["gmProgram"] for part in guitars] == [24, 25, 40]

    song = notes_to_song("Guitars", "midi", bpm, beats_per_bar, beat_unit, parts)
    assert all(track["instrument"] == "other" for track in song["tracks"])
    assert {track["gmProgram"] for track in song["tracks"]} == {24, 25, 40}
    api, runner = api_with_idle_runner()
    try:
        imported = api.import_file("guitars.mid", base64.b64encode(source.getvalue()).decode())
        reopened = api.open_song(imported["entry"]["id"])["song"]
        assert {track["gmProgram"] for track in reopened["tracks"]} == {24, 25, 40}
        assert set(reopened["instrumentNotes"]) == {track["id"] for track in reopened["tracks"]}
    finally:
        runner.close()
    midi_path = tmp_path / "guitars.mid"
    export_midi(song, midi_path)
    programs = [message.program for track in mido.MidiFile(midi_path).tracks
                for message in track if message.type == "program_change"]
    assert programs == [24, 25, 40]

    xml = b"""<score-partwise><part-list><score-part id="P1">
      <part-name>Steel guitar</part-name><score-instrument id="I1"><instrument-name>Steel guitar</instrument-name></score-instrument>
      <midi-instrument id="I1"><midi-channel>1</midi-channel><midi-program>26</midi-program></midi-instrument>
      </score-part></part-list><part id="P1"><measure number="1"><attributes>
      <divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration></note>
      </measure></part></score-partwise>"""
    _, bpm, beats_per_bar, beat_unit, xml_parts = parse_musicxml(xml, ".musicxml")
    xml_song = notes_to_song("Steel guitar", "musicxml", bpm, beats_per_bar, beat_unit, xml_parts)
    assert xml_song["tracks"][0]["gmProgram"] == 25
    xml_path = tmp_path / "guitars.musicxml"
    export_musicxml(xml_song, xml_path)
    root = ET.parse(xml_path)
    assert root.findtext(".//midi-program") == "26"


def test_delete_saved_score_track_preserves_recording_and_updates_exports():
    api, runner = api_with_idle_runner()
    try:
        original = midi_data()
        entry = api.import_file("duet.mid", base64.b64encode(original).decode())["entry"]
        song_id = entry["id"]
        before = api.open_song(song_id)
        original_path = api._library.get(song_id)["artifacts"]["midi"]
        stem = app_dir("cache") / song_id / "drums.wav"
        stem.write_bytes(b"isolated recording")
        with api._library._connect() as connection, connection:
            artifacts = {**api._library.get(song_id)["artifacts"], "drums": str(stem)}
            connection.execute("UPDATE songs SET artifacts = ?, recording = 1 WHERE id = ?",
                               (json.dumps(artifacts), song_id))
        position = {"bar": 1, "loop": None, "rate": 1, "trackId": "piano",
                    "muted": ["piano", "drums", "stem:drums"], "solo": ["piano"]}
        assert api.save_position(song_id, position)["ok"]
        assert api.delete_score_track(song_id, "stem:drums")["error"]["code"] == "score_track_not_found"
        assert api.delete_score_track(song_id, "chords")["error"]["code"] == "score_track_not_found"
        result = api.delete_score_track(song_id, "piano")
        assert result["ok"] and result["entry"]["parts"] == ["Drum kit"]
        assert result["entry"]["position"] == {**position, "trackId": "drum-kit",
                                                "muted": ["drums", "stem:drums"], "solo": []}
        assert [track["id"] for track in result["song"]["tracks"]] == ["drum-kit"]
        assert result["song"]["piano"] == [] and result["song"]["drums"] == before["song"]["drums"]
        assert stem.read_bytes() == b"isolated recording"
        assert open(original_path, "rb").read() == original
        assert [stem_item["id"] for stem_item in result["stems"]] == ["drums"]
        midi_path = unquote(urlparse(result["artifacts"]["midi"]).path).lstrip("/")
        xml_path = unquote(urlparse(result["artifacts"]["musicxml"]).path).lstrip("/")
        assert [track.name for track in mido.MidiFile(midi_path).tracks if track.name] == ["Drum kit"]
        assert [part.attrib["id"] for part in ET.parse(xml_path).iter("part")] == ["drum-kit"]
        assert api.delete_score_track(song_id, "piano")["error"]["code"] == "score_track_not_found"
        assert api.open_song(song_id)["song"] == result["song"]
        assert api.list_library()["entries"][0]["parts"] == ["Drum kit"]
        assert api.delete_score_track(song_id, "drum-kit")["ok"]
        assert api.open_song(song_id)["song"]["drums"] == []
        assert stem.read_bytes() == b"isolated recording"
    finally:
        runner.close()


def test_legacy_overlapping_import_refuses_ambiguous_deletion():
    api, runner = api_with_idle_runner()
    try:
        song = api.import_file("duet.mid", base64.b64encode(midi_data()).decode())["entry"]
        path = api._library.get(song["id"])["song_path"]
        raw = json.loads(open(path, encoding="utf-8").read())
        raw["tracks"].append({"id": "second-piano", "instrument": "piano", "name": "Second piano"})
        for note in raw["piano"]:
            note.pop("trackId")
        with open(path, "w", encoding="utf-8") as output:
            json.dump(raw, output)
        reply = api.delete_score_track(song["id"], "piano")
        assert reply["error"]["code"] == "score_track_ambiguous"
        assert api.open_song(song["id"])["song"] == raw
    finally:
        runner.close()


def test_imported_pitched_parts_keep_individual_notes_after_delete():
    midi = mido.MidiFile(ticks_per_beat=480)
    for name, pitch in (("Lead piano", 60), ("Second piano", 67)):
        track = mido.MidiTrack([
            mido.MetaMessage("track_name", name=name),
            mido.Message("note_on", note=pitch, velocity=100, time=0),
            mido.Message("note_off", note=pitch, velocity=0, time=480),
        ])
        midi.tracks.append(track)
    stream = io.BytesIO()
    midi.save(file=stream)
    api, runner = api_with_idle_runner()
    try:
        entry = api.import_file("duo.mid", base64.b64encode(stream.getvalue()).decode())["entry"]
        before = api.open_song(entry["id"])["song"]
        assert {note["trackId"] for note in before["piano"]} == {"lead-piano", "second-piano"}
        reply = api.delete_score_track(entry["id"], "lead-piano")
        assert reply["ok"] and reply["entry"]["parts"] == ["Second piano"]
        assert [note["midi"] for note in reply["song"]["piano"]] == [67]
        assert reply["song"]["piano"][0]["trackId"] == "second-piano"
        midi_path = unquote(urlparse(reply["artifacts"]["midi"]).path).lstrip("/")
        assert [track.name for track in mido.MidiFile(midi_path).tracks if track.name] == ["Second piano"]
    finally:
        runner.close()


def test_generated_accompaniment_is_not_a_deletable_score_track():
    api, runner = api_with_idle_runner()
    try:
        entry = api.import_file("duet.mid", base64.b64encode(midi_data()).decode())["entry"]
        path = api._library.get(entry["id"])["song_path"]
        with open(path, encoding="utf-8") as source:
            raw = json.load(source)
        raw["tracks"].append({"id": "accompaniment", "instrument": "piano",
                              "name": "Generated accompaniment", "group": "creative"})
        raw["accompaniment"] = [{**raw["piano"][0], "trackId": "accompaniment"}]
        with open(path, "w", encoding="utf-8") as output:
            json.dump(raw, output)
        assert api.delete_score_track(entry["id"], "accompaniment")["error"]["code"] == "score_track_not_found"
        result = api.delete_score_track(entry["id"], "piano")
        assert result["ok"] and result["song"]["accompaniment"] == raw["accompaniment"]
        assert any(track["id"] == "accompaniment" for track in result["song"]["tracks"])
        midi_path = unquote(urlparse(result["artifacts"]["midi"]).path).lstrip("/")
        assert [track.name for track in mido.MidiFile(midi_path).tracks if track.name] == [
            "Drum kit", "Generated accompaniment",
        ]
    finally:
        runner.close()


def test_folder_storage_uniqueness_membership_and_cascade():
    api, runner = api_with_idle_runner()
    try:
        song = api.import_file("duet.mid", base64.b64encode(midi_data()).decode())["entry"]
        studies = api.create_folder(" Studies ")["folder"]
        favorites = api.create_folder("Favorites")["folder"]
        assert studies["name"] == "Studies" and studies["count"] == 0
        duplicate = api.create_folder("studies")
        assert not duplicate["ok"] and duplicate["error"]["code"] == "folder_name_exists"

        assert api.set_song_folders(song["id"], [studies["id"], favorites["id"]]) == {"ok": True}
        listed = api.list_library()["entries"][0]
        assert set(listed["folders"]) == {studies["id"], favorites["id"]}
        assert set(api.open_song(song["id"])["entry"]["folders"]) == {studies["id"], favorites["id"]}
        assert {folder["name"]: folder["count"] for folder in api.list_folders()["folders"]} == {
            "Studies": 1, "Favorites": 1,
        }

        renamed = api.rename_folder(studies["id"], "Repertoire")["folder"]
        assert renamed["name"] == "Repertoire"
        reopened = LibraryStore()
        assert set(reopened.get(song["id"])["folders"]) == {studies["id"], favorites["id"]}
        assert {folder["name"]: folder["count"] for folder in reopened.list_folders()} == {
            "Repertoire": 1, "Favorites": 1,
        }
        assert api.delete_folder(favorites["id"]) == {"ok": True}
        assert api.list_library()["entries"][0]["folders"] == [studies["id"]]

        assert api.delete_song(song["id"]) == {"ok": True}
        assert api.list_folders()["folders"][0]["count"] == 0
        with sqlite3.connect(reopened.path) as connection:
            assert connection.execute("SELECT COUNT(*) FROM folder_songs").fetchone()[0] == 0
    finally:
        runner.close()


def test_existing_database_migrates_folders_and_artist(tmp_path):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as connection:
        connection.execute("""
            CREATE TABLE songs (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, thumbnail TEXT, source TEXT NOT NULL,
                parts TEXT NOT NULL, recording INTEGER NOT NULL, duration REAL,
                created_at TEXT NOT NULL, practiced_at TEXT, position TEXT,
                pipeline_version TEXT NOT NULL, source_url TEXT, artifacts TEXT NOT NULL,
                song_path TEXT NOT NULL, tempo_map TEXT
            )
        """)
        connection.execute("""
            INSERT INTO songs (id, title, source, parts, recording, created_at,
                               pipeline_version, artifacts, song_path)
            VALUES ('legacy', 'Existing song', 'midi', '["Piano"]', 0,
                    '2026-09-01T00:00:00+00:00', 'old', '{}', 'legacy.json')
        """)
    store = LibraryStore(path)
    assert store.get("legacy")["title"] == "Existing song"
    assert store.get("legacy")["artist"] is None
    assert store.get("legacy")["folders"] == []
    folder = store.create_folder("Migrated")
    store.set_song_folders("legacy", [folder["id"]])
    store = LibraryStore(path)
    assert store.get("legacy")["folders"] == [folder["id"]]
    assert store.list_folders() == [{**folder, "count": 1}]
    with sqlite3.connect(path) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(songs)")}
        tables = {row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )}
    assert "artist" in columns
    assert {"transcription_model", "separation_method"} <= columns
    assert {"folders", "folder_songs"} <= tables


def test_folder_validation_and_atomic_membership_changes():
    api, runner = api_with_idle_runner()
    try:
        song = api.import_file("duet.mid", base64.b64encode(midi_data()).decode())["entry"]
        first = api.create_folder("Études")["folder"]
        assert api.create_folder("études")["error"]["code"] == "folder_name_exists"
        assert api.create_folder("A" * 60)["ok"]
        for name in ("", " \t ", "A" * 61, None, 1):
            assert api.create_folder(name)["error"]["code"] == "invalid_folder_name"
            assert api.rename_folder(first["id"], name)["error"]["code"] == "invalid_folder_name"
        second = api.create_folder("Other")["folder"]
        assert api.rename_folder(second["id"], " ÉTUDES ")["error"]["code"] == "folder_name_exists"
        assert api.rename_folder(first["id"], " études ")["folder"]["name"] == "études"
        assert api.rename_folder("missing", "Name")["error"]["code"] == "folder_not_found"
        assert api.delete_folder("missing")["error"]["code"] == "folder_not_found"
        assert api.set_song_folders("missing", [])["error"]["code"] == "song_not_found"
        assert api.set_song_folders(song["id"], [first["id"], first["id"]])["ok"]
        for ids in ([second["id"], "missing"], None, first["id"], [1]):
            assert api.set_song_folders(song["id"], ids)["error"]["code"] == "folder_not_found"
            assert api.list_library()["entries"][0]["folders"] == [first["id"]]
        assert api.set_song_folders(song["id"], [])["ok"]
        assert all(folder["count"] == 0 for folder in api.list_folders()["folders"])
    finally:
        runner.close()


def test_updating_transcription_preserves_folder_membership(tmp_path):
    store = LibraryStore()
    analysis = tmp_path / "analysis.json"
    analysis.write_text(json.dumps({"title": "First title", "tracks": [{"name": "Piano"}],
                                    "diagnostics": {"separate": {"method": "htdemucs-6s-onnx"}}}))
    job = {"song_id": "song", "url": URL, "transcription_model": "standard", "details": {
        "artifacts": {"analysis": str(analysis)}, "metadata": {"channel": "Artist"},
    }}
    song = store.upsert_job(job, "v1")
    assert song["transcription_model"] == "standard"
    assert song["separation_method"] == "htdemucs-6s-onnx"
    folder = store.create_folder("Repertoire")
    store.set_song_folders(song["id"], [folder["id"]])
    analysis.write_text(json.dumps({"title": "Updated title", "tracks": [{"name": "Piano"}],
                                    "diagnostics": {"separate": {"method": "cpu-fallback"}}}))
    job["transcription_model"] = "muscriptor-large"
    updated = store.upsert_job(job, "v2")
    assert updated["title"] == "Updated title"
    assert updated["transcription_model"] == "muscriptor-large"
    assert updated["separation_method"] == "cpu-fallback"
    assert updated["artist"] == "Artist"
    assert updated["created_at"] == song["created_at"]
    assert updated["folders"] == [folder["id"]]
    assert store.list_folders()[0]["count"] == 1


def test_processing_metadata_migration_uses_only_matching_completed_analysis():
    jobs = JobStore()
    path = jobs.path
    with sqlite3.connect(path) as connection:
        connection.execute("""
            CREATE TABLE songs (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, parts TEXT NOT NULL,
                recording INTEGER NOT NULL, duration REAL, created_at TEXT NOT NULL,
                practiced_at TEXT, position TEXT, pipeline_version TEXT NOT NULL,
                source_url TEXT, artifacts TEXT NOT NULL, song_path TEXT NOT NULL, tempo_map TEXT
            )
        """)
        for song_id, analysis in (("matched", "matched.json"), ("unknown", "unknown.json")):
            connection.execute("""
                INSERT INTO songs (id, title, source, parts, recording, created_at,
                                   pipeline_version, artifacts, song_path)
                VALUES (?, ?, 'youtube', '[]', 1, 'today', 'v1', '{}', ?)
            """, (song_id, song_id, analysis))
    queued = jobs.create("aB_12-cD345", URL, "auto", "v1", reuse=False)
    jobs.update(queued["id"], status="done", details={
        "artifacts": {"analysis": "matched.json"},
        "diagnostics": {"separate": {"method": "htdemucs-6s-onnx"}},
    })
    store = LibraryStore(path)
    assert store.get("matched")["transcription_model"] == "muscriptor-small"
    assert store.get("matched")["separation_method"] == "htdemucs-6s-onnx"
    assert store.get("unknown")["transcription_model"] is None
    assert store.get("unknown")["separation_method"] is None


def test_youtube_search_returns_bounded_safe_results(monkeypatch):
    calls = []

    class Search:
        def __init__(self, options):
            assert options["extract_flat"] and options["skip_download"]
            assert options["socket_timeout"] == 8 and options["retries"] == 0

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def extract_info(self, query, download):
            calls.append(query)
            assert download is False
            return {"entries": [
                {"id": "aB_12-cD345", "title": "Piano study", "channel": "Artist", "duration": 92,
                 "url": "javascript:bad", "thumbnail": "file:///private"},
                {"id": "aB_12-cD345", "title": "Duplicate"},
                {"id": "../../bad", "title": "Invalid"},
                {"id": "bB_12-cD345", "is_live": True},
                {"id": "cB_12-cD345", "title": "Unknown duration", "duration": float("nan")},
                None,
            ]}

    monkeypatch.setattr("yt_dlp.YoutubeDL", Search)
    api, runner = api_with_idle_runner()
    try:
        result = api.search_youtube("  piano study  ")
        assert result["ok"] and calls == ["ytsearch6:piano study"]
        assert result["results"] == [
            {"id": "aB_12-cD345", "title": "Piano study", "channel": "Artist", "duration": 92,
             "url": "https://www.youtube.com/watch?v=aB_12-cD345",
             "thumbnail": "https://i.ytimg.com/vi/aB_12-cD345/mqdefault.jpg"},
            {"id": "cB_12-cD345", "title": "Unknown duration", "channel": "", "duration": None,
             "url": "https://www.youtube.com/watch?v=cB_12-cD345",
             "thumbnail": "https://i.ytimg.com/vi/cB_12-cD345/mqdefault.jpg"},
        ]
        assert api.search_youtube(" \t ") == {"ok": True, "results": []}
        for query in (None, [], "a" * 201):
            assert api.search_youtube(query)["error"]["code"] == "invalid_search"
        assert len(calls) == 1
    finally:
        runner.close()


def test_youtube_search_failure_keeps_library_available(monkeypatch):
    from yt_dlp.utils import DownloadError

    def unavailable(options):
        raise DownloadError("Network offline")

    monkeypatch.setattr("yt_dlp.YoutubeDL", unavailable)
    api, runner = api_with_idle_runner()
    try:
        result = api.search_youtube("piano")
        assert not result["ok"] and result["error"]["code"] == "youtube_search_failed"
        assert result["error"]["fix"]
        assert api.list_library() == {"ok": True, "entries": []}
    finally:
        runner.close()


def test_simultaneous_add_link_reuses_active_job(monkeypatch):
    release = Event()
    def pipeline(job, report, cancelled):
        assert release.wait(5)

    runner = JobRunner(JobStore(), pipeline)
    api = Api(runner)
    inspected = []

    def inspect(url):
        inspected.append(url)
        return {"title": "Search result", "duration": 92, "videoId": "aB_12-cD345"}

    monkeypatch.setattr(api, "_inspect", inspect)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(api.add_link, [URL, "https://youtu.be/aB_12-cD345"]))
        assert all(result["ok"] for result in results)
        assert results[0]["job"]["id"] == results[1]["job"]["id"]
        assert inspected == [] and len(api.list_queue()["jobs"]) == 1
    finally:
        release.set()
        runner.close()


def test_queue_order_retry_and_dismiss():
    entered, release = Event(), Event()

    def blocking(job, report, cancelled):
        entered.set()
        release.wait(5)

    runner = JobRunner(JobStore(), blocking)
    try:
        first = runner.start(URL, "piano")
        assert entered.wait(5)
        second = runner.start("https://youtu.be/bB_12-cD345", "piano")
        third = runner.start("https://youtu.be/cB_12-cD345", "drums")
        runner.move(third["id"], 0)
        queued = [job["id"] for job in runner.store.list_queue() if job["status"] == "queued"]
        assert queued == [third["id"], second["id"]]
        runner.cancel(second["id"])
        retried = runner.retry(second["id"])
        assert retried["status"] == "queued"
        runner.cancel(second["id"])
        runner.store.dismiss(second["id"])
        assert second["id"] not in [job["id"] for job in runner.store.list_queue()]
    finally:
        release.set()
        runner.close()

    attempts = 0

    def flaky(job, report, cancelled):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise ModelFailed("try again")

    runner = JobRunner(JobStore(), flaky)
    try:
        job = runner.start(URL, "piano")
        wait_for(runner.store, job["id"], "failed")
        runner.retry(job["id"])
        wait_for(runner.store, job["id"], "done")
        assert attempts == 2
    finally:
        runner.close()


def test_add_link_returns_before_slow_metadata_and_reports_it_from_worker(monkeypatch):
    entered, release = Event(), Event()
    metadata = {"title": "Queued study", "thumbnail": "https://example.test/thumb.jpg",
                "duration": 60, "videoId": "aB_12-cD345", "source": URL}

    def pipeline(job, report, cancelled):
        entered.set()
        assert release.wait(5)
        job["details"]["metadata"] = metadata
        report("inspect", 1)

    runner = JobRunner(JobStore(), pipeline)
    api = Api(runner)
    monkeypatch.setattr(api, "_inspect", lambda _url: pytest.fail("Submission inspected metadata"))
    try:
        result = api.add_link(URL)
        assert result["ok"]
        job = result["job"]
        assert job["kind"] == "transcribe" and job["title"] is None
        assert job["thumbnail"] is None and job["detected"] is None
        assert entered.wait(5)
        assert len(api.list_queue()["jobs"]) == 1
        assert [stage["name"] for stage in job["stages"]] == [
            "inspect", "download", "decode", "detect", "separate",
            "transcribe", "chords", "notation", "finalize",
        ]
        invalid = api.add_link("not a url")["error"]
        assert invalid["code"] == "invalid_url" and invalid["fix"]
        release.set()
        wait_for(runner.store, job["id"], "done")
        completed = api.get_job(job["id"])["job"]
        assert completed["title"] == metadata["title"]
        assert completed["thumbnail"] == metadata["thumbnail"]
    finally:
        release.set()
        runner.close()


def test_completed_transcription_job_links_library_song():
    def pipeline(job, report, cancelled):
        directory = app_dir("cache") / job["id"]
        directory.mkdir()
        analysis = directory / "analysis.json"
        analysis.write_text(json.dumps({
            "title": "Linked result", "tracks": [], "piano": [], "drums": [], "chords": [],
        }), encoding="utf-8")
        return {"artifacts": {"analysis": str(analysis)}, "metadata": job["details"]["metadata"]}

    runner = JobRunner(JobStore(), pipeline)
    api = Api(runner)
    try:
        job = runner.add_link(URL, {
            "title": "Linked result", "thumbnail": None, "duration": 1,
        })
        wait_for(runner.store, job["id"], "done")
        queued = api.get_job(job["id"])["job"]
        entries = api.list_library()["entries"]
        assert queued["songId"] == entries[0]["id"]
    finally:
        runner.close()


def test_detection_prioritizes_but_never_excludes_instruments():
    rate = 22050
    time_axis = np.arange(rate * 2) / rate
    harmonic_samples = (0.4 * np.sin(2 * np.pi * 261.63 * time_axis)
                        + 0.3 * np.sin(2 * np.pi * 329.63 * time_axis)).astype(np.float32)
    silence = np.zeros_like(harmonic_samples)
    harmonic = detect_instruments(Audio(harmonic_samples, rate), {
        "piano": Audio(harmonic_samples, rate), "drums": Audio(silence, rate),
    })
    assert selected_instruments(harmonic) == ["piano", "drums"]

    impulses = np.zeros_like(harmonic_samples)
    for onset in np.arange(0, 2, 0.25):
        start = round(onset * rate)
        impulses[start:start + 100] = np.exp(-np.arange(100) / 15)
    drums = detect_instruments(Audio(impulses, rate), {
        "piano": Audio(silence, rate), "drums": Audio(impulses, rate),
    })
    assert selected_instruments(drums) == ["drums", "piano"]


def test_dtw_alignment_recovers_tempo_change():
    random = np.random.default_rng(4)
    chroma = random.random((16, 12))
    times = np.array([beat * 0.5 if beat < 8 else 4 + (beat - 8) * 0.75
                      for beat in range(16)])
    tempo_map = dtw_tempo_map(chroma, chroma.copy(), times)
    np.testing.assert_allclose([point["time"] for point in tempo_map], times, atol=1e-5)
    assert tempo_map[8] == {"beat": 8.0, "time": 4.0}
