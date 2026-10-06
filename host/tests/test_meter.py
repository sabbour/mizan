import base64
import io
import json
import math
from pathlib import Path
from xml.etree import ElementTree as ET

import mido
import numpy as np
import pytest

from mizan.engine.audio import Audio
from mizan.engine.harmony import acoustic_beat_grid, acoustic_features, analyze_harmony, infer_meter, inferred_beats_per_bar
from mizan.engine.output import build_song, export_midi, export_musicxml
from mizan.errors import InvalidFile
from mizan.imports import import_score, notes_to_song, parse_midi, parse_musicxml
from mizan.library import LibraryStore
from mizan.meter import bar_index, build_bar_map, song_bar_map, total_beats, validate_bar_map


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
    assert harmony["timing"]["beatConfidence"] == timing["confidence"]
    assert harmony["timing"]["meterConfidence"] == 1
    assert harmony["timing"]["meter"]["supported"]
    assert not harmony["timing"]["meter"]["fallback"]
    assert "written denominator and tempo subdivision remain unverified" in harmony["warnings"][0]
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
    assert infer_meter(timing)["reason"] == "low_beat_grid_confidence"


def test_three_four_consensus_tolerates_a_missed_and_spurious_downbeat():
    assessment = infer_meter({
        "bpm": 120, "confidence": 0.9,
        "downbeats": [10.5, 3, 0, 1.5, 3, 4.5, 7.5, 9, 10.9, 12],
    })
    assert assessment["beatsPerBar"] == 3
    assert assessment["supported"] and not assessment["fallback"]
    assert assessment["confidence"] == assessment["candidates"]["3/4"]["supportRate"] == 0.75
    assert assessment["evidence"]["singleBarSupport"]["3/4"] >= 2
    assert assessment["evidence"]["rejected"] == 2


def test_four_four_consensus_tolerates_a_missed_and_spurious_downbeat():
    assessment = infer_meter({
        "bpm": 120, "confidence": 0.9,
        "downbeats": [0, 2, 4, 8, 10, 12, 12.3, 14, 16],
    })
    assert assessment["beatsPerBar"] == 4
    assert assessment["supported"] and not assessment["fallback"]
    assert assessment["confidence"] == assessment["candidates"]["4/4"]["supportRate"] == 0.75
    assert assessment["evidence"]["singleBarSupport"]["4/4"] >= 2


def test_shared_bar_multiples_and_tempo_aliases_remain_unverified():
    lengths = [3] * 3 + [4] * 3 + [12] * 3
    ambiguous = infer_meter({
        "bpm": 120, "confidence": 0.9, "downbeats": (np.r_[0, np.cumsum(lengths)] * 0.5).tolist(),
    })
    assert ambiguous["evidence"]["ambiguous"] == 3
    assert "12/4" in ambiguous["candidates"]
    assert not ambiguous["boundariesVerified"]
    assert all(change["status"] == "unverified" for change in ambiguous["changes"])
    assert not ambiguous["spellingVerified"]

    aliased = infer_meter({
        "bpm": 240, "confidence": 0.9, "observedPulseSeconds": 0.5,
        "downbeats": [0, 1.5, 3, 4.5, 6, 7.5],
    })
    assert aliased["beatsPerBar"] == 4
    assert aliased["fallback"] and not aliased["supported"]
    assert aliased["reason"] == "pulse_and_quarter_grid_disagree"


def test_noisy_and_silent_downbeats_keep_an_explicit_four_four_fallback():
    noisy = infer_meter({
        "bpm": 120, "confidence": 0.9,
        "downbeats": [0, 0.5, 1.1, 2.4, 3.1, 4.8, 5.2, 6.7],
    })
    silent = infer_meter({"bpm": 120, "confidence": 0, "downbeats": []})
    for assessment in (noisy, silent):
        assert assessment["beatsPerBar"] == 4
        assert assessment["fallback"] and not assessment["supported"]
        assert assessment["confidence"] == 0
        assert assessment["method"] == "observed-boundary-consensus-v2"
        assert "calibrated probability" in assessment["confidenceMeaning"]


def test_ambiguous_meter_fallback_survives_cached_library_song(monkeypatch, tmp_path):
    monkeypatch.setenv("MIZAN_BEATS", "auto")
    timing = {
        "bpm": 120, "confidence": 0.9, "times": [], "phaseSeconds": 0,
        "downbeats": [0, 1.1, 2.4, 3.1], "meterConfidence": 0.9,
    }
    monkeypatch.setattr(
        "mizan.engine.harmony.learned_beat_grid",
        lambda audio, cancelled: (timing, {"method": "test", "provider": {"effectiveProviders": ["CPU"]}}),
    )
    harmony = analyze_harmony(Audio(np.zeros(12 * 11025, dtype=np.float32), 11025))
    song = build_song("Ambiguous", "test", 12, harmony, [], [], {})
    assert song["beatsPerBar"] == 4 and song["beatUnit"] == 4
    assert song["timing"]["meter"]["fallback"]
    assert song["timing"]["meterConfidence"] == 0
    assert "using 4/4 as a fallback" in song["warnings"][0]
    analysis = tmp_path / "analysis.json"
    analysis.write_text(json.dumps(song, ensure_ascii=True, allow_nan=False), encoding="utf-8")
    library = LibraryStore(tmp_path / "library.db")
    entry = library.upsert_job({
        "song_id": "meter-fallback",
        "url": "https://example.test/watch?v=meter-fallback",
        "transcription_model": "muscriptor-small",
        "details": {
            "artifacts": {"analysis": str(analysis)},
            "metadata": {"title": "Ambiguous", "duration": 12},
        },
    }, "test-pipeline")
    cached = json.loads(Path(entry["song_path"]).read_text(encoding="utf-8"))
    assert cached["timing"]["meter"] == song["timing"]["meter"]
    assert cached["timing"]["meterConfidence"] == 0
    assert "using 4/4 as a fallback" in cached["warnings"][0]


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


def test_mid_bar_midi_meter_change_preserves_note_positions():
    midi = mido.MidiFile()
    midi.tracks.append(mido.MidiTrack([
        mido.MetaMessage("time_signature", numerator=3, denominator=4),
        mido.MetaMessage("time_signature", numerator=4, denominator=4, time=480),
        mido.Message("note_on", note=60, velocity=90),
        mido.Message("note_off", note=60, velocity=0, time=480),
    ]))
    out = io.BytesIO()
    midi.save(file=out)
    _, bpm, bpb, unit, parts = parse_midi(out.getvalue())
    song = notes_to_song("Changing", "midi", bpm, bpb, unit, parts)
    assert [note["startBeat"] for note in song["piano"]] == [1]
    assert [(bar["numerator"], bar["denominator"]) for bar in song["barMap"]] == [(3, 4), (4, 4)]
    assert song["barMap"][0]["partial"] and song["barMap"][0]["beats"] == 1


@pytest.mark.parametrize("length,numerator,denominator", [(5, 5, 4), (7, 7, 4), (3.5, 7, 8), (11, 11, 4)])
def test_meter_candidates_are_derived_from_observed_boundaries(length, numerator, denominator):
    timing = {"bpm": 120, "confidence": 0.9,
              "downbeats": (np.arange(9) * length * 0.5).tolist()}
    original = json.dumps(timing)
    assessment = infer_meter(timing)
    assert assessment["supported"] and not assessment["fallback"]
    assert assessment["beatsPerBar"] == length
    assert assessment["changes"] == [{
        "startBeat": 0, "numerator": numerator, "denominator": denominator, "status": "supported",
    }]
    assert json.dumps(timing) == original


@pytest.mark.parametrize("lengths", [[3] * 5 + [5] * 5, [3.5, 4] * 6])
def test_local_meter_changes_are_not_replaced_by_a_global_winner(lengths):
    timing = {"bpm": 120, "confidence": 0.95,
              "downbeats": (np.r_[0, np.cumsum(lengths)] * 0.5).tolist()}
    assessment = infer_meter(timing)
    bars = build_bar_map(sum(lengths), assessment["changes"])
    assert [bar["beats"] for bar in bars] == lengths
    assert all(bar["status"] == "supported" for bar in bars)


def test_bar_map_contract_pickup_partial_and_legacy_compatibility():
    bars = build_bar_map(13, [
        {"startBeat": 0, "numerator": 5, "denominator": 4},
        {"startBeat": 1, "numerator": 5, "denominator": 4},
        {"startBeat": 6, "numerator": 7, "denominator": 8},
    ])
    assert [bar["startBeat"] for bar in bars] == [0, 1, 6, 9.5]
    assert [bar["beats"] for bar in bars] == [1, 5, 3.5, 3.5]
    assert bars[0]["partial"]
    assert bar_index(bars, 6) == 2 and bar_index(bars, 5.9999) == 1
    assert total_beats({"bars": 4, "barMap": bars}) == 13
    legacy = {"bars": 2, "beatsPerBar": 3, "beatUnit": 8}
    assert [(bar["startBeat"], bar["beats"]) for bar in song_bar_map(legacy)] == [(0, 3), (3, 3)]
    assert total_beats(legacy) == 6


@pytest.mark.parametrize("bar_map", [
    [], [{"startBeat": 1, "beats": 3, "numerator": 3, "denominator": 4}],
    [{"startBeat": 0, "beats": 0, "numerator": 3, "denominator": 4}],
    [{"startBeat": 0, "beats": 3, "numerator": 3, "denominator": 3}],
    [{"startBeat": 0, "beats": 4, "numerator": 3, "denominator": 4}],
    [{"startBeat": 0, "beats": float("nan"), "numerator": 3, "denominator": 4}],
])
def test_malformed_bar_maps_raise_explicit_errors(bar_map):
    with pytest.raises(ValueError):
        validate_bar_map(bar_map)


def test_changing_musicxml_and_midi_round_trip_preserves_tied_notes(tmp_path):
    source = b"""<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
    <part id="P1"><measure number="1"><attributes><divisions>480</divisions>
    <time><beats>5</beats><beat-type>4</beat-type></time></attributes>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>2400</duration><tie type="start"/></note></measure>
    <measure number="2"><attributes><time><beats>7</beats><beat-type>8</beat-type></time></attributes>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>1680</duration><tie type="stop"/></note>
    </measure></part></score-partwise>"""
    _, bpm, bpb, unit, parts = parse_musicxml(source, ".musicxml")
    song = notes_to_song("Mixed", "musicxml", bpm, bpb, unit, parts)
    assert [(bar["startBeat"], bar["beats"]) for bar in song["barMap"]] == [(0, 5), (5, 3.5)]
    assert song["piano"][0]["startBeat"] == 0 and song["piano"][0]["beats"] == 8.5
    snapshot = json.dumps(song)
    export_musicxml(song, tmp_path / "mixed.musicxml")
    export_midi(song, tmp_path / "mixed.mid")
    xml = ET.parse(tmp_path / "mixed.musicxml")
    assert [node.text for node in xml.findall(".//time/beats")] == ["5", "7"]
    assert [node.text for node in xml.findall(".//time/beat-type")] == ["4", "8"]
    assert [node.attrib["type"] for node in xml.findall(".//tie")] == ["start", "stop"]
    _, bpm, bpb, unit, midi_parts = parse_midi((tmp_path / "mixed.mid").read_bytes())
    reimported = notes_to_song("Mixed", "midi", bpm, bpb, unit, midi_parts)
    assert reimported["barMap"] == song["barMap"]
    assert reimported["piano"][0]["beats"] == 8.5
    assert json.dumps(song) == snapshot


@pytest.mark.parametrize("extent,restart,note_beats", [(5, 1, 5), (9, 1, 1), (5.25, None, 1), (8, None, 8)])
def test_midi_same_signature_restarts_and_end_of_track_preserve_partial_coverage(
        extent, restart, note_beats, tmp_path):
    changes = [{"startBeat": 0, "numerator": 4, "denominator": 4}]
    if restart is not None:
        changes.append({"startBeat": restart, "numerator": 4, "denominator": 4})
    bars = build_bar_map(extent, changes)
    song = {
        "bpm": 120, "bars": len(bars), "beatsPerBar": 4, "beatUnit": 4, "barMap": bars,
        "tracks": [{"id": "piano", "name": "Piano", "instrument": "piano"}],
        "piano": [{"midi": 60, "startBeat": 0, "beats": note_beats, "velocity": 1}],
    }
    original = json.dumps(song)
    target = tmp_path / "coverage.mid"
    export_midi(song, target)
    _, bpm, bpb, unit, parts = parse_midi(target.read_bytes())
    restored = notes_to_song("Coverage", "midi", bpm, bpb, unit, parts)
    assert restored["barMap"] == bars
    assert [(note["startBeat"], note["beats"]) for note in restored["piano"]] == [(0, note_beats)]
    midi = mido.MidiFile(target)
    tick = 0
    signatures = []
    for message in midi.tracks[0]:
        tick += message.time
        if message.type == "time_signature":
            signatures.append((tick / midi.ticks_per_beat, message.numerator, message.denominator))
    assert signatures == [(0, 4, 4)] + ([(restart, 4, 4)] if restart is not None else [])
    assert all(track[-1].type == "end_of_track"
               and sum(message.time for message in track) == extent * midi.ticks_per_beat
               for track in midi.tracks)
    assert json.dumps(song) == original


def test_two_hand_midi_import_keeps_meter_restart_and_end_rest_extent(tmp_path):
    midi = mido.MidiFile(ticks_per_beat=480)
    midi.tracks.append(mido.MidiTrack([
        mido.MetaMessage("time_signature", numerator=4, denominator=4),
        mido.MetaMessage("time_signature", numerator=4, denominator=4, time=480),
        mido.MetaMessage("end_of_track", time=2040),
    ]))
    for name, pitch, duration in (("Right hand", 60, 2400), ("Left hand", 48, 480)):
        midi.tracks.append(mido.MidiTrack([
            mido.MetaMessage("track_name", name=name),
            mido.Message("note_on", note=pitch, velocity=100),
            mido.Message("note_off", note=pitch, velocity=0, time=duration),
            mido.MetaMessage("end_of_track", time=2520 - duration),
        ]))
    data = io.BytesIO()
    midi.save(file=data)
    entry = import_score("hands.mid", base64.b64encode(data.getvalue()).decode(),
                         LibraryStore(tmp_path / "hands.db"))
    restored = json.loads(Path(entry["song_path"]).read_text(encoding="utf-8"))
    assert [(bar["startBeat"], bar["beats"]) for bar in restored["barMap"]] == [(0, 1), (1, 4), (5, 0.25)]
    assert {(note["midi"], note["beats"], note["hand"]) for note in restored["piano"]} == {
        (60, 5, "right"), (48, 1, "left"),
    }


def accented_audio(lengths: list[float], missing_boundaries: tuple[int, ...] = ()) -> Audio:
    rate, period = 11025, 0.4
    duration = sum(lengths) * period
    samples = np.zeros(round(duration * rate))
    for points, amplitude, frequency, decay in (
        (np.arange(0, duration, period), 0.08, 440, 0.04),
        (np.delete(np.r_[0, np.cumsum(lengths)[:-1]], missing_boundaries) * period, 0.7, 220, 0.05),
    ):
        for point in points:
            first = round(point * rate)
            count = min(round(0.16 * rate), len(samples) - first)
            time = np.arange(count) / rate
            samples[first:first + count] += amplitude * np.exp(-time / decay) * np.sin(2 * np.pi * frequency * time)
    return Audio(samples.astype(np.float32), rate)


@pytest.mark.parametrize("lengths", [[3] * 50, [5] * 30, [3.5, 4] * 20])
def test_auto_same_tempo_fixed_model_labels_cannot_erase_acoustic_boundaries(monkeypatch, lengths):
    monkeypatch.setenv("MIZAN_BEATS", "auto")
    audio = accented_audio(lengths)
    timing = {"bpm": 150, "confidence": 0.99, "phaseSeconds": 0,
              "times": np.arange(0, audio.duration, 0.4).tolist(),
              "downbeats": np.arange(0, audio.duration, 1.6).tolist()}
    monkeypatch.setattr("mizan.engine.harmony.learned_beat_grid",
                        lambda *args: (dict(timing), {"method": "fixed-model-fixture"}))
    samples = audio.samples.copy()
    harmony = analyze_harmony(audio)
    assert [bar["beats"] for bar in harmony["barMap"][:len(lengths)]] == lengths
    assert harmony["timing"]["meter"]["boundariesVerified"]
    assert harmony["beatDetails"]["alternativeBeatGrid"]["method"] == "fixed-model-fixture"
    assert np.array_equal(audio.samples, samples)


def test_auto_same_tempo_unverified_grouping_does_not_override_supported_model(monkeypatch):
    monkeypatch.setenv("MIZAN_BEATS", "auto")
    timing = {"bpm": 150, "confidence": 0.99, "phaseSeconds": 0,
              "times": np.arange(0, 8, 0.4).tolist(), "downbeats": np.arange(0, 8, 1.6).tolist()}
    monkeypatch.setattr("mizan.engine.harmony.learned_beat_grid",
                        lambda *args: (dict(timing), {"method": "fixed-model-fixture"}))
    tentative = {
        "beatsPerBar": 3, "confidence": 0.2, "supported": True, "fallback": False,
        "spellingVerified": False, "boundariesVerified": False,
        "changes": [{"startBeat": 0, "numerator": 3, "denominator": 4, "status": "unverified"}],
    }
    monkeypatch.setattr("mizan.engine.harmony.acoustic_beat_grid", lambda *args: (
        {**timing, "accentMeter": tentative}, {"method": "tentative-acoustic-fixture"}))
    harmony = analyze_harmony(Audio(np.zeros(8 * 11025, dtype=np.float32), 11025))
    assert harmony["beatDetails"]["method"] == "fixed-model-fixture"
    assert all(bar["beats"] == 4 for bar in harmony["barMap"])


@pytest.mark.parametrize("short,long", [(3, 6), (4, 8)])
def test_recurring_multiple_related_acoustic_gaps_do_not_invent_short_bars(short, long):
    lengths = [short] * 30 + [long] * 20
    audio = accented_audio(lengths)
    times, energy = acoustic_features(audio)
    timing, _ = acoustic_beat_grid(times, energy, audio.duration)
    meter = infer_meter(timing)
    assert not meter["spellingVerified"]
    if meter["boundariesVerified"]:
        assert [bar["beats"] for bar in build_bar_map(sum(lengths), meter["changes"])] == lengths
    else:
        assert meter["evidence"].get("ambiguous", 0) > 0
        assert all(point["status"] == "unverified" for point in meter["changes"])


def test_a_missing_acoustic_downbeat_is_not_a_verified_invented_boundary():
    audio = accented_audio([3] * 50, missing_boundaries=(20,))
    times, energy = acoustic_features(audio)
    timing, _ = acoustic_beat_grid(times, energy, audio.duration)
    meter = infer_meter(timing)
    assert not meter["boundariesVerified"]
    assert not meter["spellingVerified"]
    assert meter["evidence"].get("missingBoundaries", 0) > 0
    assert all(point["status"] == "unverified" for point in meter["changes"])


@pytest.mark.parametrize("length", [1.25, 1.75])
def test_smaller_odd_units_fit_exact_and_acoustic_boundaries(length):
    exact = infer_meter({"bpm": 150, "confidence": 0.95,
                         "downbeats": (np.arange(50) * length * 0.4).tolist()})
    assert exact["supported"] and exact["beatsPerBar"] == length
    assert exact["changes"][0]["denominator"] == 16
    audio = accented_audio([length] * 120)
    times, energy = acoustic_features(audio)
    timing, _ = acoustic_beat_grid(times, energy, audio.duration)
    meter = infer_meter(timing)
    assert meter["supported"] and meter["beatsPerBar"] == length
    assert abs(timing["bpm"] - 150) < 0.2
    assert not meter["spellingVerified"]


@pytest.mark.parametrize("tail", [0.01, 0.0000001])
@pytest.mark.parametrize("pickup", [False, True])
def test_tiny_positive_partial_keeps_coverage_and_exported_source_note(tail, pickup, tmp_path):
    end = 4 + tail
    changes = [{"startBeat": 0, "numerator": 4, "denominator": 4}]
    if pickup:
        changes.append({"startBeat": tail, "numerator": 4, "denominator": 4})
    bars = build_bar_map(end, changes)
    partial = 0 if pickup else 1
    base = 0 if pickup else 4
    assert len(bars) == 2 and bars[partial]["beats"] > 0 and bars[partial]["partial"]
    assert bars[-1]["startBeat"] + bars[-1]["beats"] == end
    note = {"midi": 60, "startBeat": base + tail / 4, "beats": tail / 2,
            "velocity": 1, "onset": (base + tail / 4) / 2, "offset": (base + tail * 3 / 4) / 2}
    song = {"bpm": 120, "bars": 2, "beatsPerBar": 4, "beatUnit": 4, "barMap": bars,
            "tracks": [{"id": "piano", "instrument": "piano", "name": "Piano"}],
            "piano": [note]}
    original = json.dumps(song)
    export_musicxml(song, tmp_path / "tiny.musicxml")
    xml = ET.parse(tmp_path / "tiny.musicxml")
    assert len(xml.findall(".//measure")) == 2
    assert all(int(node.text) > 0 for node in xml.findall(".//duration"))
    assert xml.find(f".//measure[@number='{partial + 1}']/note/pitch") is not None
    assert json.dumps(song) == original


@pytest.mark.parametrize("length", [3, 4, 5, 3.5, 7, 11])
def test_synthetic_audio_detects_data_derived_fixed_grouping(length):
    audio = accented_audio([length] * max(12, math.ceil(60 / (length * 0.4))))
    original = audio.samples.copy()
    times, energy = acoustic_features(audio)
    timing, _ = acoustic_beat_grid(times, energy, audio.duration)
    meter = infer_meter(timing)
    assert meter["supported"] and meter["boundariesVerified"]
    assert meter["beatsPerBar"] == length
    assert abs(timing["bpm"] - 150) < 0.2
    assert not meter["spellingVerified"]
    assert len({(change["numerator"], change["denominator"]) for change in meter["changes"]}) == 1
    assert np.array_equal(audio.samples, original)


@pytest.mark.parametrize("lengths", [[3] * 32 + [5] * 24, [3.5, 4] * 20])
def test_synthetic_audio_preserves_short_and_sustained_meter_changes(lengths):
    audio = accented_audio(lengths)
    times, energy = acoustic_features(audio)
    timing, _ = acoustic_beat_grid(times, energy, audio.duration)
    assessment = infer_meter(timing)
    assert assessment["supported"] and assessment["boundariesVerified"]
    assert abs(timing["bpm"] - 150) < 0.2
    bars = build_bar_map(sum(lengths), assessment["changes"])
    assert [bar["beats"] for bar in bars] == pytest.approx(lengths, abs=1e-6)
    assert all(bar["status"] == "supported" for bar in bars)


def test_pulse_only_noise_and_silence_do_not_confirm_meter():
    times = np.arange(0, 64, 0.01)
    uniform = np.zeros_like(times)
    for first in range(0, len(times), 40):
        uniform[first:first + 16] = np.exp(-np.arange(min(16, len(times) - first)) / 4)
    for energy in (uniform, np.zeros_like(times), np.random.default_rng(42).random(len(times))):
        result = acoustic_beat_grid(times, energy, 64)
        assert result is None or not infer_meter(result[0])["supported"]


def test_local_accent_recurrence_does_not_invent_window_center_changes():
    times = np.arange(0, 80, 0.01)
    energy = np.zeros_like(times) + 0.002
    for spacing, amplitude in ((0.4, 0.15), (1.2, 1.0)):
        for point in np.arange(0, 80, spacing):
            first = round(point / 0.01)
            count = min(20, len(times) - first)
            energy[first:first + count] += amplitude * np.exp(-np.arange(count) / 5)
    # A smoothly varying accent level is not distinct per-boundary evidence.
    energy *= 1 + 0.5 * np.sin(times / 3)
    result = acoustic_beat_grid(times, energy, 80)
    assert result is not None
    meter = infer_meter(result[0])
    assert meter["beatsPerBar"] == 3
    assert len({(point["numerator"], point["denominator"]) for point in meter["changes"]}) == 1


def test_audio_analysis_output_and_exports_share_the_alternating_timeline(monkeypatch, tmp_path):
    monkeypatch.setenv("MIZAN_BEATS", "dsp")
    audio = accented_audio([3.5, 4] * 20)
    samples = audio.samples.copy()
    harmony = analyze_harmony(audio)
    assert harmony["timing"]["meter"]["boundariesVerified"]
    assert [bar["beats"] for bar in harmony["barMap"][:40]] == [3.5, 4] * 20
    assert abs(total_beats(harmony) * 60 / harmony["bpm"] - audio.duration) < 1e-6
    note = {"midi": 60, "onset": 2.37, "offset": 4.93, "velocity": 0.8, "confidence": 0.9}
    song = build_song("Alternating", "test", audio.duration, harmony, [note], [], {})
    snapshot = json.dumps(song)
    assert song["piano"][0]["onset"] == note["onset"] and song["piano"][0]["offset"] == note["offset"]
    assert song["barMap"] == harmony["barMap"]
    export_midi(song, tmp_path / "alternating.mid")
    export_musicxml(song, tmp_path / "alternating.musicxml")
    tick = 0
    changes = []
    for message in mido.MidiFile(tmp_path / "alternating.mid").tracks[0]:
        tick += message.time
        if message.type == "time_signature":
            changes.append((tick / 480, message.numerator, message.denominator))
    assert changes[:3] == [(0, 7, 8), (3.5, 4, 4), (7.5, 7, 8)]
    xml = ET.parse(tmp_path / "alternating.musicxml")
    assert [node.text for node in xml.findall(".//time/beats")[:3]] == ["7", "4", "7"]
    assert json.dumps(song) == snapshot and np.array_equal(audio.samples, samples)


def test_tentative_acoustic_grouping_keeps_its_signature_and_boundary_warning(monkeypatch):
    monkeypatch.setenv("MIZAN_BEATS", "dsp")
    meter = {
        "beatsPerBar": 3, "confidence": 0.2, "supported": True, "fallback": False,
        "spellingVerified": False, "boundariesVerified": False,
        "changes": [{"startBeat": 0, "numerator": 3, "denominator": 4, "status": "unverified"}],
    }
    timing = {"bpm": 150, "confidence": 0.8, "phaseSeconds": 0, "times": [],
              "downbeats": [], "accentMeter": meter}
    monkeypatch.setattr("mizan.engine.harmony.acoustic_beat_grid",
                        lambda *args: (dict(timing), {"method": "test"}))
    harmony = analyze_harmony(Audio(np.zeros(9 * 11025, dtype=np.float32), 11025))
    assert harmony["beatsPerBar"] == 3
    assert all(bar["status"] == "unverified" for bar in harmony["barMap"])
    assert "suggest 3/4" in harmony["warnings"][0]
    assert "Bar boundaries are unverified" in harmony["warnings"][0]
    assert not harmony["timing"]["meter"]["boundariesVerified"]
