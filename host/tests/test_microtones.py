import base64
import io
import json
from pathlib import Path
from xml.etree import ElementTree as ET

import mido
import pytest

from mizan.alignment import note_chroma
from mizan.engine.output import export_midi, export_musicxml
from mizan.errors import InvalidFile
from mizan.imports import import_score, notes_to_song, parse_midi, parse_musicxml
from mizan.library import LibraryStore


def test_quarter_tone_musicxml_roundtrip_and_independent_midi_bends(tmp_path):
    source = b"""<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
    <part id="P1"><measure number="1"><attributes><divisions>480</divisions></attributes>
    <note><pitch><step>C</step><alter>0.5</alter><octave>4</octave></pitch><duration>480</duration></note>
    <backup><duration>480</duration></backup>
    <note><pitch><step>E</step><alter>-0.5</alter><octave>4</octave></pitch><duration>480</duration></note>
    </measure></part></score-partwise>"""
    _, bpm, bpb, unit, parts = parse_musicxml(source, ".musicxml")
    song = notes_to_song("Quarter tones", "musicxml", bpm, bpb, unit, parts)
    assert sorted(note["midi"] for note in song["piano"]) == [60.5, 63.5]
    assert note_chroma(song).shape == (4, 12)
    saved = import_score("quarter.musicxml", base64.b64encode(source).decode(), LibraryStore())
    stored = json.loads(Path(saved["song_path"]).read_text(encoding="utf-8"))
    assert sorted(note["midi"] for note in stored["piano"]) == [60.5, 63.5]

    export_musicxml(song, tmp_path / "quarter.musicxml")
    xml = ET.parse(tmp_path / "quarter.musicxml")
    assert sorted(float(node.text) for node in xml.findall(".//pitch/alter")) == [0.5, 1.5]
    _, _, _, _, roundtrip = parse_musicxml((tmp_path / "quarter.musicxml").read_bytes(), ".musicxml")
    assert sorted(note["midi"] for note in roundtrip[0]["notes"]) == [60.5, 63.5]

    sustained = {**song, "bars": 2, "piano": [{**song["piano"][0], "beats": 5}]}
    export_musicxml(sustained, tmp_path / "tied.musicxml")
    _, _, _, _, tied = parse_musicxml((tmp_path / "tied.musicxml").read_bytes(), ".musicxml")
    assert [(note["midi"], note["beats"]) for note in tied[0]["notes"]] == [(60.5, 5)]

    export_midi(song, tmp_path / "quarter.mid")
    midi = mido.MidiFile(tmp_path / "quarter.mid")
    _, _, _, _, imported = parse_midi((tmp_path / "quarter.mid").read_bytes())
    assert sorted(note["midi"] for note in imported[0]["notes"]) == pytest.approx([60.5, 63.5], abs=0.001)
    starts = [(msg.channel, msg.note) for track in midi.tracks for msg in track if msg.type == "note_on"]
    assert len({channel for channel, _ in starts}) == 2


def test_imports_static_midi_pitch_bend_without_rounding():
    midi = mido.MidiFile()
    midi.tracks.append(mido.MidiTrack([
        mido.Message("pitchwheel", channel=0, pitch=2048),
        mido.Message("note_on", channel=0, note=60, velocity=90),
        mido.Message("note_off", channel=0, note=60, velocity=0, time=480),
    ]))
    out = io.BytesIO()
    midi.save(file=out)
    _, _, _, _, parts = parse_midi(out.getvalue())
    assert parts[0]["notes"][0]["midi"] == 60.5


def test_negative_cent_export_uses_nearest_semitone(tmp_path):
    song = {
        "bpm": 120, "beatsPerBar": 4, "bars": 1,
        "tracks": [{"id": "piano", "instrument": "piano", "name": "Piano"}],
        "piano": [{"midi": 59.98, "startBeat": 0, "beats": 1,
                   "velocity": 0.8}],
    }
    export_musicxml(song, tmp_path / "negative.musicxml")
    pitch = ET.parse(tmp_path / "negative.musicxml").find(".//pitch")
    assert pitch is not None
    assert pitch.findtext("step") == "C"
    assert float(pitch.findtext("alter")) == pytest.approx(-0.02)
    assert pitch.findtext("octave") == "4"
    _, _, _, _, xml_parts = parse_musicxml((tmp_path / "negative.musicxml").read_bytes(), ".musicxml")
    assert xml_parts[0]["notes"][0]["midi"] == pytest.approx(59.98)

    export_midi(song, tmp_path / "negative.mid")
    messages = [message for track in mido.MidiFile(tmp_path / "negative.mid").tracks for message in track]
    assert next(message.note for message in messages if message.type == "note_on") == 60
    assert next(message.pitch for message in messages if message.type == "pitchwheel") < 0
    _, _, _, _, midi_parts = parse_midi((tmp_path / "negative.mid").read_bytes())
    assert midi_parts[0]["notes"][0]["midi"] == pytest.approx(59.98, abs=0.001)


def test_midi_bend_track_and_declared_range_apply_to_other_note_track():
    midi = mido.MidiFile()
    midi.tracks.append(mido.MidiTrack([
        mido.Message("control_change", channel=0, control=101, value=0),
        mido.Message("control_change", channel=0, control=100, value=0),
        mido.Message("control_change", channel=0, control=6, value=1),
        mido.Message("pitchwheel", channel=0, pitch=4096),
    ]))
    midi.tracks.append(mido.MidiTrack([
        mido.Message("note_on", channel=0, note=60, velocity=90),
        mido.Message("note_off", channel=0, note=60, velocity=0, time=480),
    ]))
    out = io.BytesIO()
    midi.save(file=out)
    _, _, _, _, parts = parse_midi(out.getvalue())
    assert parts[0]["notes"][0]["midi"] == 60.5

    midi.tracks[0].append(mido.Message("pitchwheel", channel=0, pitch=0, time=240))
    out = io.BytesIO()
    midi.save(file=out)
    with pytest.raises(InvalidFile, match="during held notes"):
        parse_midi(out.getvalue())
