import io
import json
from pathlib import Path
from xml.etree import ElementTree as ET

import mido
import pytest

from mizan.engine.output import export_midi, export_musicxml
from mizan.errors import InvalidFile
from mizan.imports import notes_to_song, parse_midi
from mizan.library import LibraryStore


def midi_bytes(tracks, *, format=1, ticks_per_beat=480):
    midi = mido.MidiFile(type=format, ticks_per_beat=ticks_per_beat)
    midi.tracks.extend(mido.MidiTrack(messages) for messages in tracks)
    output = io.BytesIO()
    midi.save(file=output)
    return output.getvalue()


def parse_notes(data):
    _, bpm, beats_per_bar, beat_unit, parts = parse_midi(data)
    return notes_to_song("Synthetic pitch bend", "midi", bpm, beats_per_bar, beat_unit, parts)


def test_held_notes_keep_rising_falling_and_reset_bend_points():
    source = midi_bytes([[
        mido.Message("note_on", note=60, velocity=90),
        mido.Message("note_on", note=64, velocity=80),
        mido.Message("pitchwheel", pitch=4096, time=240),
        mido.Message("pitchwheel", pitch=-4096, time=240),
        mido.Message("pitchwheel", pitch=0, time=240),
        mido.Message("note_off", note=60, velocity=0, time=240),
        mido.Message("note_off", note=64, velocity=0),
    ]], format=0)

    _, _, _, _, parts = parse_midi(source)
    notes = parts[0]["notes"]
    assert [(note["midi"], note["beats"]) for note in notes] == [(60, 2), (64, 2)]
    expected = [
        {"beat": 0.5, "semitones": 1.0},
        {"beat": 1.0, "semitones": -1.0},
        {"beat": 1.5, "semitones": 0.0},
    ]
    assert [note["pitchBends"] for note in notes] == [expected, expected]


@pytest.mark.parametrize("half_ticks", [240, 80])
def test_bend_at_note_release_is_ignored_and_export_roundtrips(tmp_path, half_ticks):
    source = midi_bytes([[
        mido.Message("note_on", note=60, velocity=90),
        mido.Message("pitchwheel", pitch=4096, time=half_ticks),
        mido.Message("pitchwheel", pitch=0, time=half_ticks),
        mido.Message("note_off", note=60, velocity=0),
    ]], format=0)

    _, _, _, _, parts = parse_midi(source)
    note = parts[0]["notes"][0]
    assert note["beats"] == half_ticks * 2 / 480
    assert note["pitchBends"] == [{"beat": round(half_ticks / 480, 9), "semitones": 1.0}]

    song = parse_notes(source)
    target = tmp_path / "bend-at-release.mid"
    export_midi(song, target)
    restored = parse_notes(target.read_bytes())
    assert restored["piano"][0]["pitchBends"] == note["pitchBends"]


def test_release_tick_bend_updates_channel_state_for_the_next_note():
    source = midi_bytes([[
        mido.Message("note_on", note=60, velocity=90),
        mido.Message("pitchwheel", pitch=4096, time=240),
        mido.Message("pitchwheel", pitch=0, time=240),
        mido.Message("note_off", note=60, velocity=0),
        mido.Message("pitchwheel", pitch=4096),
        mido.Message("note_on", note=62, velocity=90),
        mido.Message("note_off", note=62, velocity=0, time=480),
    ]], format=0)

    _, _, _, _, parts = parse_midi(source)
    first, second = parts[0]["notes"]
    assert first["pitchBends"] == [{"beat": 0.5, "semitones": 1.0}]
    assert second["midi"] == 63
    assert "pitchBends" not in second


def test_bend_range_changes_while_held_and_rpn_null_selection_is_respected():
    source = midi_bytes([[
        mido.Message("control_change", control=101, value=0),
        mido.Message("control_change", control=100, value=0),
        mido.Message("control_change", control=6, value=2),
        mido.Message("note_on", note=60, velocity=90),
        mido.Message("pitchwheel", pitch=4096, time=240),
        mido.Message("control_change", control=6, value=4, time=240),
        mido.Message("control_change", control=38, value=50, time=240),
        mido.Message("control_change", control=101, value=127, time=240),
        mido.Message("control_change", control=100, value=127),
        mido.Message("control_change", control=6, value=100),
        mido.Message("pitchwheel", pitch=0),
        mido.Message("note_off", note=60, velocity=0, time=240),
    ]])

    _, _, _, _, parts = parse_midi(source)
    assert parts[0]["notes"][0]["pitchBends"] == [
        {"beat": 0.5, "semitones": 1.0},
        {"beat": 1.0, "semitones": 2.0},
        {"beat": 1.5, "semitones": 2.25},
        {"beat": 2.0, "semitones": 0.0},
    ]


def test_nrpn_data_entry_does_not_change_pitch_range_until_rpn_is_reselected():
    source = midi_bytes([[
        mido.Message("control_change", control=101, value=0),
        mido.Message("control_change", control=100, value=0),
        mido.Message("control_change", control=6, value=2),
        mido.Message("note_on", note=60, velocity=90),
        mido.Message("pitchwheel", pitch=4096, time=240),
        mido.Message("control_change", control=99, value=1, time=240),
        mido.Message("control_change", control=98, value=2),
        mido.Message("control_change", control=6, value=12),
        mido.Message("control_change", control=101, value=0, time=240),
        mido.Message("control_change", control=100, value=0),
        mido.Message("control_change", control=6, value=4),
        mido.Message("note_off", note=60, velocity=0, time=240),
    ]])

    _, _, _, _, parts = parse_midi(source)
    assert parts[0]["notes"][0]["pitchBends"] == [
        {"beat": 0.5, "semitones": 1.0},
        {"beat": 1.5, "semitones": 2.0},
    ]


def test_cross_track_bends_update_all_active_notes_but_not_another_channel():
    source = midi_bytes([
        [
            mido.Message("program_change", channel=0, program=24),
            mido.Message("note_on", channel=0, note=60, velocity=90),
            mido.Message("note_on", channel=0, note=64, velocity=80),
            mido.Message("note_on", channel=1, note=67, velocity=70),
        ],
        [
            mido.MetaMessage("track_name", name="Controllers"),
            mido.Message("pitchwheel", channel=0, pitch=2048, time=240),
            mido.Message("pitchwheel", channel=1, pitch=-4096),
            mido.Message("pitchwheel", channel=0, pitch=0, time=240),
            mido.Message("note_off", channel=0, note=60, velocity=0, time=240),
            mido.Message("note_off", channel=0, note=64, velocity=0),
            mido.Message("note_off", channel=1, note=67),
        ],
    ])

    _, _, _, _, parts = parse_midi(source)
    guitar = next(part for part in parts if part.get("gmProgram") == 24)
    piano = next(part for part in parts if part.get("gmProgram") is None)
    notes = {note["midi"]: note for note in guitar["notes"]}
    assert notes[60]["pitchBends"] == [
        {"beat": 0.5, "semitones": 0.5},
        {"beat": 1.0, "semitones": 0.0},
    ]
    assert notes[64]["pitchBends"] == notes[60]["pitchBends"]
    assert piano["notes"][0]["pitchBends"] == [{"beat": 0.5, "semitones": -1.0}]


def test_bend_curve_survives_song_serialization_library_reopen_and_midi_export(tmp_path):
    source = midi_bytes([[
        mido.Message("control_change", control=101, value=0),
        mido.Message("control_change", control=100, value=0),
        mido.Message("control_change", control=6, value=4),
        mido.Message("control_change", control=38, value=50),
        mido.Message("note_on", note=60, velocity=90),
        mido.Message("pitchwheel", pitch=4096, time=240),
        mido.Message("pitchwheel", pitch=-4096, time=240),
        mido.Message("pitchwheel", pitch=0, time=240),
        mido.Message("note_off", note=60, velocity=0, time=240),
    ]], format=0)
    song = parse_notes(source)
    reopened = json.loads(json.dumps(song))
    note = reopened["piano"][0]
    assert note["pitchBends"] == [
        {"beat": 0.5, "semitones": 2.25},
        {"beat": 1.0, "semitones": -2.25},
        {"beat": 1.5, "semitones": 0.0},
    ]

    target = tmp_path / "pitch-bends.mid"
    export_midi(reopened, target)
    restored = parse_notes(target.read_bytes())
    restored_note = restored["piano"][0]
    assert restored_note["midi"] == pytest.approx(note["midi"], abs=0.0003)
    assert len(restored_note["pitchBends"]) == 3
    assert [point["beat"] for point in restored_note["pitchBends"]] == [0.5, 1.0, 1.5]
    for original, roundtrip in zip(note["pitchBends"], restored_note["pitchBends"]):
        assert roundtrip["semitones"] == pytest.approx(original["semitones"], abs=2.26 / 8192)

    exported = mido.MidiFile(target)
    note_channels = {message.channel for track in exported.tracks for message in track
                     if message.type == "note_on" and message.velocity}
    assert len(note_channels) == 1
    messages = [message for track in exported.tracks for message in track]
    assert any(message.type == "control_change" and message.control == 6 and message.value == 2
               for message in messages)
    assert any(message.type == "control_change" and message.control == 38 and message.value == 25
               for message in messages)


def test_library_reopen_instrument_edit_and_other_track_delete_keep_bend_curves(tmp_path):
    source = midi_bytes([[
        mido.Message("note_on", channel=0, note=60, velocity=90),
        mido.Message("program_change", channel=1, program=24),
        mido.Message("note_on", channel=1, note=64, velocity=85),
        mido.Message("pitchwheel", channel=0, pitch=2048, time=240),
        mido.Message("pitchwheel", channel=1, pitch=-2048),
        mido.Message("pitchwheel", channel=0, pitch=0, time=240),
        mido.Message("pitchwheel", channel=1, pitch=0),
        mido.Message("note_off", channel=0, note=60, velocity=0, time=240),
        mido.Message("note_off", channel=1, note=64, velocity=0),
    ]], format=0)
    song = parse_notes(source)
    analysis = tmp_path / "analysis.json"
    analysis.write_text(json.dumps(song), encoding="utf-8")
    original = tmp_path / "original.mid"
    original.write_bytes(source)
    store = LibraryStore(tmp_path / "library.db")
    store.create_import("Held bends", "midi", song,
                        {"analysis": str(analysis), "midi": str(original)}, "test", "held-bends")
    opened = json.loads(Path(store.get("held-bends")["song_path"]).read_text(encoding="utf-8"))
    instrument = next(track for track in opened["tracks"] if track.get("gmProgram") == 24)
    curve = opened["instrumentNotes"][instrument["id"]][0]["pitchBends"]
    assert curve == [{"beat": 0.5, "semitones": -0.5}, {"beat": 1.0, "semitones": 0.0}]

    edited = store.change_score_track_instrument("held-bends", instrument["id"], 25)
    edited_song = json.loads(Path(edited["song_path"]).read_text(encoding="utf-8"))
    edited_track = next(track for track in edited_song["tracks"] if track["id"] == instrument["id"])
    assert edited_track["gmProgram"] == 25
    assert edited_song["instrumentNotes"][instrument["id"]][0]["pitchBends"] == curve

    piano_id = next(track["id"] for track in edited_song["tracks"] if track["instrument"] == "piano")
    store.delete_score_track("held-bends", piano_id)
    reopened = json.loads(Path(store.get("held-bends")["song_path"]).read_text(encoding="utf-8"))
    assert reopened["piano"] == []
    assert reopened["instrumentNotes"][instrument["id"]][0]["pitchBends"] == curve
    exported = tmp_path / "library-export.mid"
    export_midi(reopened, exported)
    restored = parse_notes(exported.read_bytes())
    restored_track = next(track for track in restored["tracks"] if track.get("gmProgram") == 25)
    assert restored["instrumentNotes"][restored_track["id"]][0]["pitchBends"] == curve


def test_independent_overlapping_curves_get_separate_channels_but_chords_share(tmp_path):
    shared = {
        "midi": 60, "startBeat": 0, "beats": 2, "velocity": 0.7,
        "pitchBends": [{"beat": 0.5, "semitones": 1.0}],
    }
    song = {
        "bpm": 120, "beatsPerBar": 4, "bars": 1,
        "tracks": [{"id": "piano", "instrument": "piano", "name": "Piano"}],
        "piano": [{**shared, "midi": pitch} for pitch in (60, 64, 67, 72, 76, 79)],
    }
    path = tmp_path / "chord.mid"
    export_midi(song, path)
    midi = mido.MidiFile(path)
    channels = {message.channel for track in midi.tracks for message in track
                if message.type == "note_on" and message.velocity}
    assert len(channels) == 1

    song["piano"] = [
        {**shared, "midi": 60, "pitchBends": [{"beat": 0.5, "semitones": 1.0}]},
        {**shared, "midi": 64, "pitchBends": [{"beat": 0.5, "semitones": -1.0}]},
    ]
    path = tmp_path / "independent.mid"
    export_midi(song, path)
    midi = mido.MidiFile(path)
    channels = {message.channel for track in midi.tracks for message in track
                if message.type == "note_on" and message.velocity}
    assert len(channels) == 2


def test_export_uses_all_melodic_channels_before_reporting_capacity_limit(tmp_path):
    def song_with(count):
        return {
            "bpm": 120, "beatsPerBar": 4, "bars": 1,
            "tracks": [{"id": "piano", "instrument": "piano", "name": "Piano"}],
            "piano": [
                {"midi": 60, "startBeat": 0, "beats": 2, "velocity": 0.7,
                 "pitchBends": [{"beat": 0.5, "semitones": index - (count - 1) / 2}]}
                for index in range(count)
            ],
        }

    path = tmp_path / "fifteen-voices.mid"
    export_midi(song_with(15), path)
    midi = mido.MidiFile(path)
    channels = {message.channel for track in midi.tracks for message in track
                if message.type == "note_on" and message.velocity}
    assert len(channels) == 15 and 9 not in channels

    with pytest.raises(ValueError, match="15 available melodic MIDI channels"):
        export_midi(song_with(16), tmp_path / "sixteen-voices.mid")


def test_invalid_range_and_damaged_curves_remain_rejected(tmp_path):
    invalid_range = midi_bytes([[
        mido.Message("control_change", control=101, value=0),
        mido.Message("control_change", control=100, value=0),
        mido.Message("control_change", control=38, value=100),
        mido.Message("note_on", note=60, velocity=90),
        mido.Message("note_off", note=60, velocity=0, time=480),
    ]])
    with pytest.raises(InvalidFile, match="pitch-bend range"):
        parse_midi(invalid_range)

    song = {
        "bpm": 120, "beatsPerBar": 4, "bars": 1,
        "tracks": [{"id": "piano", "instrument": "piano", "name": "Piano"}],
        "piano": [{"midi": 60, "startBeat": 0, "beats": 1, "velocity": 0.7,
                   "pitchBends": [{"beat": 1, "semitones": 0.5}]}],
    }
    with pytest.raises(ValueError, match="pitch-bend curve"):
        export_midi(song, tmp_path / "bad-curve.mid")


def test_musicxml_keeps_written_start_pitch_and_labels_bend_points(tmp_path):
    song = {
        "bpm": 120, "beatsPerBar": 4, "bars": 1,
        "tracks": [{"id": "piano", "instrument": "piano", "name": "Piano"}],
        "piano": [{
            "midi": 60.25, "startBeat": 0, "beats": 2, "velocity": 0.7,
            "pitchBends": [{"beat": 0.5, "semitones": 1.0}, {"beat": 1.5, "semitones": 0.0}],
        }],
    }
    path = tmp_path / "bends.musicxml"
    export_musicxml(song, path)
    xml = ET.parse(path)
    assert xml.findtext(".//pitch/step") == "C"
    assert float(xml.findtext(".//pitch/alter")) == pytest.approx(0.25)
    words = [node.text for node in xml.findall(".//direction-type/words")]
    assert any("MIDI pitch bend from the written starting pitch" in text for text in words)
    assert any("+1.000 semitones at +0.500 beat" in text for text in words)
