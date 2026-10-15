import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from xml.etree import ElementTree as ET

import mido
import pytest

from mizan.api import Api
from mizan.engine.gm import GM_PROGRAM_NAMES
from mizan.errors import InvalidScoreTrackInstrument
from mizan.library import LibraryStore


def saved_score(tmp_path: Path):
    store = LibraryStore(tmp_path / "library.sqlite")
    audio = tmp_path / "recording.wav"
    audio.write_bytes(b"original recording")
    target = {
        "id": "instrument-violin", "instrument": "other", "name": "Violin",
        "detail": "Draft notes from original mix; unverified instrument label",
        "group": "detected", "sourceInstrument": "violin",
    }
    sibling = {
        "id": "instrument-cello", "instrument": "other", "name": "Cello",
        "detail": "Draft notes", "group": "detected", "sourceInstrument": "cello",
    }
    piano = {"id": "piano", "instrument": "piano", "name": "Piano", "detail": "Piano notes"}
    piano_sibling = {"id": "piano-secondary", "instrument": "piano", "name": "Second piano", "detail": "Piano notes"}
    vocals = {"id": "lead-vocal", "instrument": "vocals", "name": "Lead Vocal", "detail": "Vocal melody"}
    vocal_sibling = {"id": "backing-vocal", "instrument": "vocals", "name": "Backing Vocal", "detail": "Vocal melody"}
    drums = {"id": "drums", "instrument": "drums", "name": "Drum kit", "detail": "Drum hits"}
    creative = {"id": "accompaniment", "instrument": "piano", "name": "Play along", "group": "creative"}
    target_notes = [{
        "trackId": target["id"], "midi": 37, "startBeat": 1.25, "beats": 0.375, "velocity": 0.73,
        "onset": 0.6, "offset": 0.8, "confidence": 0.42, "sourceInstrument": "violin", "custom": "kept",
    }]
    sibling_notes = [{"trackId": sibling["id"], "midi": 55, "startBeat": 2, "beats": 1, "velocity": 0.6}]
    piano_notes = [
        {"trackId": piano["id"], "midi": 64, "startBeat": 0.25, "beats": 0.375,
         "hand": "right", "velocity": 0.8, "custom": "piano-owned"},
        {"trackId": piano_sibling["id"], "midi": 48, "startBeat": 0.5, "beats": 0.75,
         "hand": "left", "velocity": 0.56, "custom": "sibling-owned"},
    ]
    vocal_notes = [
        {"trackId": vocals["id"], "midi": 67, "startBeat": 1.125, "beats": 0.625,
         "velocity": 0.66, "sourceInstrument": "voice", "custom": "vocal-owned"},
        {"trackId": vocal_sibling["id"], "midi": 55, "startBeat": 2.5, "beats": 0.25,
         "velocity": 0.47, "custom": "sibling-vocal-owned"},
    ]
    drum_hits = [{"trackId": drums["id"], "lane": "kick", "startBeat": 0, "velocity": 0.9}]
    song = {
        "title": "Isolated instrument edit fixture", "source": "temporary", "bpm": 120,
        "beatsPerBar": 4, "bars": 4, "chords": [], "sections": [], "piano": piano_notes,
        "vocals": vocal_notes, "drums": drum_hits,
        "tracks": [piano, piano_sibling, target, sibling, vocals, vocal_sibling, drums, creative],
        "instrumentNotes": {target["id"]: target_notes, sibling["id"]: sibling_notes},
        "accompaniment": [{"trackId": creative["id"], "midi": 60, "startBeat": 0, "beats": 1, "velocity": 0.7}],
        "tempoMap": [{"beat": 0, "time": 0}, {"beat": 16, "time": 8}],
        "confidence": {"piano": ["high"], "drums": ["high"], "vocals": ["medium"]},
        "durationSeconds": 8, "timing": {"offset": 0, "tempoScale": 1},
        "stemLevels": {"mix": 1},
    }
    analysis = tmp_path / "analysis.json"
    analysis.write_text(json.dumps(song), encoding="utf-8")
    artifacts = {
        "analysis": str(analysis), "midi": str(tmp_path / "old.mid"),
        "musicxml": str(tmp_path / "old.musicxml"), "original": str(audio), "mix": str(audio),
    }
    entry = store.create_import("Instrument edit fixture", "youtube", song, artifacts, "test")
    position = {
        "bar": 3, "loop": {"startBar": 2, "endBar": 4}, "loopName": "Practice",
        "rate": 0.65, "trackId": target["id"], "muted": ["piano", "stem:mix"],
        "solo": [target["id"]],
    }
    store.save_position(entry["id"], position)
    with store._connect() as connection, connection:
        connection.execute("UPDATE songs SET recording = 1 WHERE id = ?", (entry["id"],))
    api = Api.__new__(Api)
    api._library = store
    api._runner = SimpleNamespace(pipeline_version="test")
    api._artifacts = None
    return api, store, entry["id"], song, target_notes, sibling_notes, piano_notes, drum_hits, audio, analysis, position


@pytest.mark.parametrize("program,name,xml_program", [
    (33, "Electric Bass Finger", "34"),
    (27, "Electric Guitar Clean", "28"),
    (0, "Acoustic Grand Piano", "1"),
])
def test_changing_detected_instrument_keeps_notes_recording_position_and_exports(
        tmp_path, program, name, xml_program):
    api, store, song_id, before, notes, sibling, piano, drums, audio, analysis, position = saved_score(tmp_path)
    before_audio = hashlib.sha256(audio.read_bytes()).digest()
    before_analysis = analysis.read_bytes()

    reply = api.change_score_track_instrument(song_id, "instrument-violin", program)

    assert reply["ok"]
    track = next(item for item in reply["song"]["tracks"] if item["id"] == "instrument-violin")
    assert (track["id"], track["instrument"], track["name"], track["gmProgram"]) == (
        "instrument-violin", "other", name, program)
    assert track["sourceInstrument"] == "violin"
    assert track["instrumentCorrection"] == {
        "detectedName": "Violin", "detectedGmProgram": None,
        "detectedInstrument": "other", "sourceInstrument": "violin", "gmProgram": program,
    }
    assert reply["song"]["instrumentNotes"]["instrument-violin"] == notes
    assert reply["song"]["instrumentNotes"]["instrument-cello"] == sibling
    assert reply["song"]["piano"] == piano and reply["song"]["vocals"] == before["vocals"]
    assert reply["song"]["drums"] == drums
    assert {part["id"] for part in reply["song"]["tracks"]} == {part["id"] for part in before["tracks"]}
    assert reply["entry"]["parts"] == ["Piano", "Second piano", name, "Cello",
                                        "Lead Vocal", "Backing Vocal", "Drum kit"]
    assert reply["entry"]["position"] == position
    assert hashlib.sha256(audio.read_bytes()).digest() == before_audio
    assert analysis.read_bytes() == before_analysis, "the previous analysis revision remains untouched"

    reopened = LibraryStore(store.path).get(song_id)
    reopened_song = json.loads(Path(reopened["song_path"]).read_text(encoding="utf-8"))
    assert next(item for item in reopened_song["tracks"] if item["id"] == "instrument-violin")["gmProgram"] == program
    assert reopened["position"] == position

    revision = store.get(song_id)["artifacts"]
    midi = mido.MidiFile(revision["midi"])
    exported = [part for part in midi.tracks if part.name]
    assert name in [part.name for part in exported]
    target_export = next(part for part in exported if part.name == name)
    assert next(message for message in target_export if message.type == "program_change").program == program
    note_on = next(message for message in target_export if message.type == "note_on")
    assert note_on.note == 37 and note_on.velocity == round(0.73 * 127)
    xml = ET.parse(revision["musicxml"])
    target_xml = xml.find(".//part[@id='instrument-violin']")
    assert target_xml is not None
    assert xml.findtext(".//score-part[@id='instrument-violin']/midi-instrument/midi-program") == xml_program
    note = next(item for item in target_xml.findall(".//note") if item.find("rest") is None)
    assert int(note.findtext("duration")) == round(notes[0]["beats"] * 480)


@pytest.mark.parametrize("program", [True, False, -1, 120, 128, 1.5, None, "33"])
def test_invalid_instrument_program_does_not_change_any_saved_file(tmp_path, program):
    api, store, song_id, _, _, _, _, _, _, analysis, position = saved_score(tmp_path)
    before = store.get(song_id)
    before_bytes = Path(before["song_path"]).read_bytes()
    reply = api.change_score_track_instrument(song_id, "instrument-violin", program)
    assert reply["ok"] is False
    assert reply["error"]["code"] == "invalid_score_track_instrument"
    after = store.get(song_id)
    assert after["song_path"] == before["song_path"]
    assert after["position"] == position
    assert Path(after["song_path"]).read_bytes() == before_bytes == analysis.read_bytes()
    assert not list(tmp_path.glob("analysis-*.json"))
    assert not list(tmp_path.glob("score-*.mid"))
    assert not list(tmp_path.glob("score-*.musicxml"))


@pytest.mark.parametrize("track_id,code", [
    ("missing", "score_track_not_found"),
    ("drums", "score_track_instrument_not_editable"),
    ("accompaniment", "score_track_not_found"),
])
def test_only_saved_detected_pitched_tracks_can_be_reassigned(tmp_path, track_id, code):
    api, store, song_id, _, _, _, _, _, _, analysis, _ = saved_score(tmp_path)
    before = store.get(song_id)
    reply = api.change_score_track_instrument(song_id, track_id, 33)
    assert reply["ok"] is False and reply["error"]["code"] == code
    assert store.get(song_id)["song_path"] == before["song_path"]
    assert Path(analysis).read_bytes() == Path(before["song_path"]).read_bytes()
    assert not list(tmp_path.glob("analysis-*.json"))


@pytest.mark.parametrize("track_id,program,role,remaining_key,remaining_id", [
    ("piano", 27, "piano", "piano", "piano-secondary"),
    ("piano", 0, "piano", "piano", "piano-secondary"),
    ("lead-vocal", 73, "vocals", "vocals", "backing-vocal"),
])
def test_normal_pitched_track_moves_only_owned_events_into_stable_track_notes(
        tmp_path, track_id, program, role, remaining_key, remaining_id):
    api, store, song_id, before, _, _, _, _, audio, analysis, position = saved_score(tmp_path)
    original_entry = store.get(song_id)
    original_audio = hashlib.sha256(audio.read_bytes()).digest()
    selected = [event for event in before[role] if event.get("trackId") == track_id]
    siblings = [event for event in before[role] if event.get("trackId") != track_id]

    reply = api.change_score_track_instrument(song_id, track_id, program)

    assert reply["ok"]
    song = reply["song"]
    track = next(item for item in song["tracks"] if item["id"] == track_id)
    assert (track["id"], track["instrument"], track["gmProgram"], track["name"]) == (
        track_id, "other", program, GM_PROGRAM_NAMES[program].replace("_", " ").title())
    assert track["instrumentCorrection"]["detectedInstrument"] == role
    assert song["instrumentNotes"][track_id] == selected
    assert song[remaining_key] == siblings
    assert next(item for item in song["tracks"] if item["id"] == remaining_id)["instrument"] == role
    assert song["drums"] == before["drums"]
    assert song["instrumentNotes"]["instrument-violin"] == before["instrumentNotes"]["instrument-violin"]
    assert song["instrumentNotes"]["instrument-cello"] == before["instrumentNotes"]["instrument-cello"]
    assert song["confidence"] == before["confidence"]
    assert reply["entry"]["position"] == position
    assert hashlib.sha256(audio.read_bytes()).digest() == original_audio
    assert Path(original_entry["song_path"]).read_bytes() == analysis.read_bytes()

    reopened = LibraryStore(store.path).get(song_id)
    reopened_song = json.loads(Path(reopened["song_path"]).read_text(encoding="utf-8"))
    assert reopened_song["instrumentNotes"][track_id] == selected
    assert reopened_song[remaining_key] == siblings
    assert reopened["parts"] == reply["entry"]["parts"]
    assert reopened["position"] == position
    midi_tracks = [item for item in mido.MidiFile(reopened["artifacts"]["midi"]).tracks if item.name == track["name"]]
    assert len(midi_tracks) == 1
    assert next(message for message in midi_tracks[0] if message.type == "program_change").program == program
    assert next(message for message in midi_tracks[0] if message.type == "note_on").note == round(selected[0]["midi"])
    xml = ET.parse(reopened["artifacts"]["musicxml"])
    assert xml.findtext(f".//score-part[@id='{track_id}']/midi-instrument/midi-program") == str(program + 1)


def test_corrected_normal_piano_track_can_be_deleted_without_affecting_siblings_or_exports(tmp_path):
    api, store, song_id, before, _, _, _, _, audio, _, _ = saved_score(tmp_path)
    audio_hash = hashlib.sha256(audio.read_bytes()).digest()
    sibling_notes = [event for event in before["piano"] if event.get("trackId") != "piano"]

    corrected = api.change_score_track_instrument(song_id, "piano", 33)
    assert corrected["ok"]
    bass = next(item for item in corrected["song"]["tracks"] if item["id"] == "piano")
    assert bass.get("group") is None
    before_delete = store.get(song_id)

    def exported_events(path):
        result = {}
        for midi_track in mido.MidiFile(path).tracks:
            if not midi_track.name:
                continue
            tick = 0
            events = []
            for message in midi_track:
                tick += message.time
                if message.type in ("program_change", "note_on", "note_off"):
                    events.append((
                        tick, message.type, getattr(message, "program", None),
                        getattr(message, "note", None), getattr(message, "velocity", None),
                    ))
            result[midi_track.name] = events
        return result

    before_export = exported_events(before_delete["artifacts"]["midi"])
    assert any(event[1] == "note_on" for event in before_export["Electric Bass Finger"])
    assert any(event[1] == "note_on" and event[3] == 48 for event in before_export["Second piano"])

    deleted = api.delete_score_track(song_id, "piano")

    assert deleted["ok"]
    song = deleted["song"]
    assert all(item["id"] != "piano" for item in song["tracks"])
    assert song["piano"] == sibling_notes
    assert "piano" not in song["instrumentNotes"]
    assert [item for item in song["tracks"] if item["id"] != "piano"] == [
        item for item in before["tracks"] if item["id"] != "piano"
    ]
    assert "Electric Bass Finger" not in deleted["entry"]["parts"]
    assert "Second piano" in deleted["entry"]["parts"]
    assert hashlib.sha256(audio.read_bytes()).digest() == audio_hash

    after_export = exported_events(store.get(song_id)["artifacts"]["midi"])
    assert after_export == {
        name: events for name, events in before_export.items()
        if name != "Electric Bass Finger"
    }


def test_multitrack_legacy_unowned_piano_notes_are_rejected_without_writes(tmp_path):
    api, store, song_id, _, _, _, _, _, _, analysis, _ = saved_score(tmp_path)
    raw = json.loads(analysis.read_text(encoding="utf-8"))
    raw["piano"][0].pop("trackId")
    analysis.write_text(json.dumps(raw), encoding="utf-8")
    before = store.get(song_id)
    before_bytes = Path(before["song_path"]).read_bytes()

    reply = api.change_score_track_instrument(song_id, "piano", 27)

    assert reply["ok"] is False and reply["error"]["code"] == "score_track_instrument_ambiguous"
    assert store.get(song_id)["song_path"] == before["song_path"]
    assert Path(before["song_path"]).read_bytes() == before_bytes
    assert not list(tmp_path.glob("analysis-*.json"))
    assert not list(tmp_path.glob("score-*.mid"))
    assert not list(tmp_path.glob("score-*.musicxml"))


def test_repeated_correction_keeps_original_identity_not_stale_display_name(tmp_path):
    api, store, song_id, _, notes, _, _, _, _, _, _ = saved_score(tmp_path)
    first = api.change_score_track_instrument(song_id, "instrument-violin", 27)
    assert first["ok"]
    second = api.change_score_track_instrument(song_id, "instrument-violin", 73)

    assert second["ok"]
    track = next(item for item in second["song"]["tracks"] if item["id"] == "instrument-violin")
    assert track["name"] == "Flute" and track["gmProgram"] == 73
    assert track["sourceInstrument"] == "violin"
    assert track["instrumentCorrection"] == {
        "detectedName": "Violin", "detectedInstrument": "other",
        "detectedGmProgram": None, "sourceInstrument": "violin", "gmProgram": 73,
    }
    assert second["song"]["instrumentNotes"]["instrument-violin"] == notes
    midi = mido.MidiFile(store.get(song_id)["artifacts"]["midi"])
    flute = next(part for part in midi.tracks if part.name == "Flute")
    assert next(message for message in flute if message.type == "program_change").program == 73


def test_ambiguous_legacy_event_ownership_refuses_instrument_change(tmp_path):
    api, store, song_id, _, _, _, _, _, _, analysis, _ = saved_score(tmp_path)
    raw = json.loads(analysis.read_text(encoding="utf-8"))
    raw["instrumentNotes"]["legacy-part"] = [
        {"trackId": "instrument-violin", "midi": 99, "startBeat": 9, "beats": 1},
    ]
    analysis.write_text(json.dumps(raw), encoding="utf-8")
    before = store.get(song_id)
    reply = api.change_score_track_instrument(song_id, "instrument-violin", 33)
    assert reply["ok"] is False and reply["error"]["code"] == "score_track_instrument_ambiguous"
    assert store.get(song_id)["song_path"] == before["song_path"]
    assert Path(before["song_path"]).read_bytes() == analysis.read_bytes()
    assert not list(tmp_path.glob("analysis-*.json"))


def test_instrument_revision_cas_removes_unpublished_exports_on_concurrent_change(tmp_path, monkeypatch):
    api, store, song_id, _, _, _, _, _, _, analysis, _ = saved_score(tmp_path)
    concurrent_path = tmp_path / "concurrent-analysis.json"
    concurrent_path.write_text(analysis.read_text(encoding="utf-8"), encoding="utf-8")
    original_export = __import__("mizan.engine.output", fromlist=["export_musicxml"]).export_musicxml

    def concurrent_export(song, path):
        original_export(song, path)
        with store._connect() as connection, connection:
            connection.execute("UPDATE songs SET song_path = ? WHERE id = ?",
                               (str(concurrent_path), song_id))

    monkeypatch.setattr("mizan.engine.output.export_musicxml", concurrent_export)
    reply = api.change_score_track_instrument(song_id, "instrument-violin", 33)
    assert reply["ok"] is False and reply["error"]["code"] == "song_not_found"
    assert store.get(song_id)["song_path"] == str(concurrent_path)
    assert not list(tmp_path.glob("analysis-*.json"))
    assert not list(tmp_path.glob("score-*.mid"))
    assert not list(tmp_path.glob("score-*.musicxml"))
    assert not any(item.get("gmProgram") == 33 for item in json.loads(concurrent_path.read_text())["tracks"]
                   if item["id"] == "instrument-violin")


def test_supported_pitched_program_catalog_matches_the_sample_bank():
    from json import loads

    manifest = Path(__file__).parents[2] / "ui" / "public" / "samples" / "fluidr3" / "manifest.json"
    names = [item["name"] for item in loads(manifest.read_text(encoding="utf-8"))["instruments"]]
    assert list(GM_PROGRAM_NAMES) == [name.replace("__", "_") for name in names[:120]]
