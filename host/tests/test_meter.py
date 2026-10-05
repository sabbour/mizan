import base64
import io
import json
from pathlib import Path
from xml.etree import ElementTree as ET

import mido
import numpy as np
import pytest

from mizan.engine.audio import Audio
from mizan.engine.harmony import analyze_harmony, inferred_beats_per_bar
from mizan.engine.output import build_song, export_midi, export_musicxml
from mizan.errors import InvalidFile
from mizan.imports import import_score, notes_to_song, parse_midi, parse_musicxml
from mizan.library import LibraryStore


def test_measured_three_four_downbeats_drive_bar_lengths_and_exports(monkeypatch, tmp_path):
    monkeypatch.setenv("MIZAN_BEATS", "auto")
    beats = np.arange(0, 9, 0.5)
    timing = {"bpm": 120, "confidence": 0.9, "times": beats.tolist(),
              "phaseSeconds": 0, "downbeats": [0, 1.5, 3, 4.5, 6, 7.5],
              "meterConfidence": 0.9}
    monkeypatch.setattr("mizan.engine.harmony.learned_beat_grid",
                        lambda audio, cancelled: (timing, {"method": "test", "provider": {"effectiveProviders": ["CPU"]}}))
    # Measured quarter-beat and downbeat positions; no meter guess from a plain 120 BPM pulse.
    audio = Audio(np.zeros(9 * 11025, dtype=np.float32), 11025)
    harmony = analyze_harmony(audio)
    assert harmony["beatsPerBar"] == 3 and harmony["beatUnit"] == 4
    assert harmony["bars"] == 6
    assert harmony["sections"] == [{"name": "Bars 1-4", "startBar": 1, "bars": 4},
                                    {"name": "Bars 5-6", "startBar": 5, "bars": 2}]
    assert 3 * 60 / harmony["bpm"] == 1.5
    song = build_song("Waltz", "test", 9, harmony,
                      [{"midi": 60, "onset": 1.4, "offset": 1.6,
                        "velocity": 0.8, "confidence": 0.9}], [], {})
    assert song["confidence"]["piano"][:2] == ["high", "high"]
    export_midi(song, tmp_path / "three.mid")
    export_musicxml(song, tmp_path / "three.musicxml")
    meter = next(msg for msg in mido.MidiFile(tmp_path / "three.mid").tracks[0] if msg.type == "time_signature")
    assert (meter.numerator, meter.denominator) == (3, 4)
    xml = ET.parse(tmp_path / "three.musicxml")
    assert (xml.findtext(".//time/beats"), xml.findtext(".//time/beat-type")) == ("3", "4")
    assert len(xml.findall(".//part/measure")) == 6


def test_unverified_downbeats_keep_four_four():
    timing = {"bpm": 120, "downbeats": [0, 1.5, 3, 4.5], "meterConfidence": 0.4}
    assert inferred_beats_per_bar(timing) == 4
    assert inferred_beats_per_bar({**timing, "meterConfidence": 0.9, "downbeats": [0, 1.5, 3]}) == 4
    assert inferred_beats_per_bar({**timing, "meterConfidence": 0.9,
                                    "downbeats": [0, 1.5, 3, 5]}) == 4


def test_six_eight_import_preserves_meter_and_quarter_beat_duration(tmp_path):
    midi = mido.MidiFile(ticks_per_beat=480)
    midi.tracks.append(mido.MidiTrack([
        mido.MetaMessage("time_signature", numerator=6, denominator=8),
        mido.Message("note_on", note=60, velocity=90),
        mido.Message("note_off", note=60, velocity=0, time=1440),
        mido.Message("note_on", note=62, velocity=90),
        mido.Message("note_off", note=62, velocity=0, time=1440),
    ]))
    out = io.BytesIO()
    midi.save(file=out)
    _, bpm, bpb, unit, parts = parse_midi(out.getvalue())
    assert (bpb, unit) == (3, 8)
    song = notes_to_song("Six eight", "midi", bpm, bpb, unit, parts)
    assert song["bars"] == 2 and [note["startBeat"] for note in song["piano"]] == [0, 3]
    export_midi(song, tmp_path / "six.mid")
    export_musicxml(song, tmp_path / "six.musicxml")
    meter = next(msg for msg in mido.MidiFile(tmp_path / "six.mid").tracks[0] if msg.type == "time_signature")
    assert (meter.numerator, meter.denominator) == (6, 8)
    xml = ET.parse(tmp_path / "six.musicxml")
    assert (xml.findtext(".//time/beats"), xml.findtext(".//time/beat-type")) == ("6", "8")
    assert len(xml.findall(".//part/measure")) == 2

    source = b"""<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
    <part id="P1"><measure number="1"><attributes><divisions>480</divisions>
    <time><beats>6</beats><beat-type>8</beat-type></time></attributes>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>1440</duration></note></measure>
    <measure number="2"><note><pitch><step>D</step><octave>4</octave></pitch><duration>1440</duration></note>
    </measure></part></score-partwise>"""
    _, _, bpb, unit, parts = parse_musicxml(source, ".musicxml")
    assert (bpb, unit) == (3, 8)
    assert [note["startBeat"] for note in parts[0]["notes"]] == [0, 3]
    entry = import_score("six.musicxml", base64.b64encode(source).decode(), LibraryStore())
    saved = json.loads(Path(entry["song_path"]).read_text(encoding="utf-8"))
    assert (saved["beatUnit"], saved["beatsPerBar"], saved["bars"]) == (8, 3, 2)
    generated = mido.MidiFile(entry["artifacts"]["midi"])
    meter = next(msg for msg in generated.tracks[0] if msg.type == "time_signature")
    assert (meter.numerator, meter.denominator) == (6, 8)
    assert [msg.note for track in generated.tracks[1:] for msg in track if msg.type == "note_on"] == [60, 62]


def test_imported_multipart_export_keeps_each_part(tmp_path):
    parts = [{"name": "Piano", "drums": False,
              "notes": [{"midi": 60, "startBeat": 0, "beats": 3, "velocity": 1}]},
             {"name": "Melody", "drums": False,
              "notes": [{"midi": 67, "startBeat": 3, "beats": 3, "velocity": 1}]}]
    song = notes_to_song("Duet", "musicxml", 120, 3, 8, parts)
    export_midi(song, tmp_path / "duet.mid")
    export_musicxml(song, tmp_path / "duet.musicxml")
    tracks = [track for track in mido.MidiFile(tmp_path / "duet.mid").tracks if track.name]
    assert [[msg.note for msg in track if msg.type == "note_on"] for track in tracks] == [[60], [67]]
    xml = ET.parse(tmp_path / "duet.musicxml")
    assert [part.attrib["id"] for part in xml.findall(".//part")] == ["piano", "melody"]


def test_five_eight_bar_has_integer_notation_durations(tmp_path):
    song = notes_to_song("Odd meter", "midi", 120, 2.5, 8, [
        {"name": "Piano", "drums": False,
         "notes": [{"midi": 60, "startBeat": 0, "beats": 2.5, "velocity": 1}]},
    ])
    export_musicxml(song, tmp_path / "odd.musicxml")
    xml = ET.parse(tmp_path / "odd.musicxml")
    assert xml.findtext(".//time/beats") == "5"
    assert all(duration.text.isdecimal() for duration in xml.findall(".//duration"))
    assert sum(int(duration.text) for duration in xml.findall(".//note/duration")) == 1200


def test_changing_meter_is_rejected_instead_of_misplacing_bars():
    midi = mido.MidiFile()
    midi.tracks.append(mido.MidiTrack([
        mido.MetaMessage("time_signature", numerator=3, denominator=4),
        mido.MetaMessage("time_signature", numerator=4, denominator=4, time=480),
        mido.Message("note_on", note=60, velocity=90),
        mido.Message("note_off", note=60, velocity=0, time=480),
    ]))
    out = io.BytesIO()
    midi.save(file=out)
    with pytest.raises(InvalidFile, match="Changing time signatures"):
        parse_midi(out.getvalue())
