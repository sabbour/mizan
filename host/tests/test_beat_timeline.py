import json
from pathlib import Path
from xml.etree import ElementTree as ET

import mido
import numpy as np
import pytest

from mizan.engine.audio import Audio
from mizan.engine.harmony import (activation_beat_grid, analyze_harmony, clean_beats, compound_reading,
                                  doubled_triple_reading, downbeat_meter)
from mizan.engine.models import BEAT_THIS
from mizan.engine.output import build_song, drum_notation_beats, export_midi, export_musicxml, quantize
from mizan.meter import beat_at_time, build_bar_map, song_bar_map, time_at_beat


def logits(beats, downbeats, duration, fps=50.0):
    frames = np.arange(round(duration * fps)) / fps
    beat = np.full(len(frames), -8.0)
    down = np.full(len(frames), -8.0)
    for values, target in ((beats, beat), (downbeats, down)):
        for value in values:
            target[:] = np.maximum(target, 8 - 400 * (frames - value) ** 2)
    return beat, down


def tracked(monkeypatch, beats, downbeats, confidence=0.98):
    timing = {"bpm": 60 / float(np.median(np.diff(beats))), "confidence": confidence,
              "times": list(beats), "phaseSeconds": beats[0], "downbeats": list(downbeats),
              "downbeatSource": "beat-this", "meterConfidence": 0.0, "beatsTracked": True}
    monkeypatch.setenv("MIZAN_BEATS", "auto")
    monkeypatch.setattr("mizan.engine.harmony.learned_beat_grid",
                        lambda *args: (dict(timing), {"method": "fixture"}))
    monkeypatch.setattr("mizan.engine.harmony.acoustic_beat_grid", lambda *args: None)


def test_beat_this_runs_on_cpu_only():
    # DirectML produced finite but wrong Beat This! logits on real recordings.
    assert BEAT_THIS["providerOrder"] == ["cpu"]


def test_sub_frame_peaks_recover_tempo_that_the_50fps_grid_aliases():
    period = 60 / 184
    beats = np.arange(0.5, 60, period)
    beat, down = logits(beats, beats[::4], 61)
    grid = activation_beat_grid(beat, down, 50.0)
    assert abs(grid["bpm"] - 184) < 0.3
    assert max(abs(np.asarray(grid["times"]) - beats)) < 0.004
    assert np.diff(grid["downbeatIndices"]).tolist() == [4] * (len(beats[::4]) - 1)


def test_tracker_octave_switch_and_scattered_noise_are_repaired_or_rejected():
    period = 0.5
    steady = np.arange(0, 20, period)
    half_time = np.arange(20, 40, 2 * period)
    beats, report = clean_beats(np.r_[steady, half_time, np.arange(40, 60, period)])
    assert report["inserted"] == len(half_time) and report["irregular"] == 0
    assert np.allclose(np.diff(beats), period)
    scattered = np.cumsum(np.random.default_rng(3).uniform(0.14, 0.36, 300))
    beat, down = logits(scattered, scattered[::7], scattered[-1] + 1)
    assert activation_beat_grid(beat, down, 50.0)["confidence"] < 0.5


def test_downbeat_counts_keep_primary_meter_through_isolated_errors():
    indices = list(np.arange(0, 120, 3))
    indices.insert(10, 31)  # one spurious downbeat
    del indices[20]  # one missed downbeat
    meter = downbeat_meter(indices, 0.95)
    assert meter["supported"] and meter["beatsPerBar"] == 3
    assert [(change["startBeat"], change["numerator"]) for change in meter["changes"]] == [(0.0, 3)]


@pytest.mark.parametrize("counts,expected", [
    ([4] * 8 + [3] * 4 + [4] * 6, [(0.0, 4), (32.0, 3), (44.0, 4)]),
    ([3, 4] * 6, [(float(start), length) for start, length in zip(np.cumsum([0] + [3, 4] * 6)[:-1], [3, 4] * 6)]),
    ([7] * 10, [(0.0, 7)]),
])
def test_sustained_and_alternating_groups_become_signature_changes(counts, expected):
    indices = np.r_[0, np.cumsum(counts)].tolist()
    meter = downbeat_meter(indices, 0.95)
    assert meter["supported"] and meter["boundariesVerified"]
    assert [(change["startBeat"], change["numerator"]) for change in meter["changes"]] == expected


def test_shifted_downbeat_phase_leaves_an_unverified_partial_bar():
    indices = list(range(0, 40, 4)) + list(range(42, 82, 4))
    meter = downbeat_meter(indices, 0.95)
    assert meter["beatsPerBar"] == 4 and not meter["boundariesVerified"]
    assert meter["evidence"]["phaseShifts"] == 1
    assert all(change["status"] == "unverified" for change in meter["changes"])


def test_low_beat_confidence_is_an_explicit_fallback():
    meter = downbeat_meter(list(range(0, 60, 3)), 0.3)
    assert meter["fallback"] and not meter["supported"] and meter["beatsPerBar"] == 4
    assert downbeat_meter([2, 6, 10, 14], 0.3)["anchor"] == 2


def test_tempo_map_stays_strictly_increasing_at_the_audio_end():
    from mizan.engine.harmony import beat_timeline
    timeline = beat_timeline(np.arange(0, 4, 0.5), 0, 3.5000004)
    points = timeline["tempoMap"]
    assert all(b["beat"] > a["beat"] and b["time"] > a["time"] for a, b in zip(points, points[1:]))
    assert points[0]["time"] >= 0


def test_tracked_rubato_downbeats_anchor_barlines_pickup_and_drum_grid(monkeypatch, tmp_path):
    # A waltz with an anacrusis and drifting tempo: barlines follow the recording, not t=0 * BPM.
    rate = 11025
    periods = 0.5 + 0.08 * np.sin(np.arange(120) / 9)
    beats = 0.37 + np.r_[0, np.cumsum(periods)]
    beats = beats[beats < 60]
    downbeats = beats[2::3]
    tracked(monkeypatch, beats, downbeats)
    audio = Audio(np.zeros(60 * rate, dtype=np.float32), rate)
    harmony = analyze_harmony(audio)
    meter = harmony["timing"]["meter"]
    assert meter["supported"] and meter["boundariesVerified"] and harmony["beatsPerBar"] == 3
    bars = song_bar_map(harmony)
    # The first tracked beat is score beat 1; the bar before the first downbeat holds that pickup.
    assert bars[1]["startBeat"] == 3 and harmony["tempoMap"][0]["time"] == 0
    assert 0 < harmony["tempoMap"][0]["beat"] < 1
    starts = [time_at_beat(harmony["tempoMap"], harmony["bpm"], bar["startBeat"]) for bar in bars[1:]]
    assert max(abs(np.asarray(starts[:len(downbeats)]) - downbeats[:len(starts)])) < 1e-5
    hits = [{"lane": "snare" if index % 2 else "kick", "onset": float(beats[index] + 0.012),
             "velocity": 0.8, "confidence": 0.4} for index in range(len(beats))]
    snapshot = json.dumps(hits)
    song = build_song("Rubato", "test", audio.duration, harmony, [], hits, {})
    assert json.dumps(hits) == snapshot
    assert [hit["onset"] for hit in song["drums"]] == [hit["onset"] for hit in hits]
    assert all(hit["startBeat"] == round(hit["startBeat"]) for hit in song["drums"])
    assert song["tempoMap"] == harmony["tempoMap"]
    for hit in song["drums"]:
        assert abs(beat_at_time(song["tempoMap"], song["bpm"], hit["onset"]) - hit["startBeat"]) < 0.05
    export_midi(song, tmp_path / "rubato.mid")
    export_musicxml(song, tmp_path / "rubato.musicxml")
    meta = [message for message in mido.MidiFile(tmp_path / "rubato.mid").tracks[0] if message.type == "time_signature"]
    assert (meta[0].numerator, meta[0].denominator) == (3, 4)
    measures = ET.parse(tmp_path / "rubato.musicxml").findall(".//part[@id='drums']/measure")
    assert len(measures) == len(bars)


def test_anacrusis_becomes_a_leading_partial_bar(monkeypatch):
    beats = np.arange(0.02, 30, 0.5)
    tracked(monkeypatch, beats, beats[2::4])
    harmony = analyze_harmony(Audio(np.zeros(30 * 11025, dtype=np.float32), 11025))
    bars = song_bar_map(harmony)
    assert bars[0] == {**bars[0], "startBeat": 0.0, "beats": 2.0, "partial": True, "numerator": 4}
    assert abs(time_at_beat(harmony["tempoMap"], harmony["bpm"], bars[1]["startBeat"]) - beats[2]) < 1e-6


def test_drum_engraving_snaps_jitter_but_keeps_fast_figures_and_imports():
    bars = [{"startBeat": 0.0, "beats": 4.0, "numerator": 4, "denominator": 4}]
    hits = [
        {"lane": "snare", "startBeat": 1.08, "confidence": 0.4},
        {"lane": "hihat", "startBeat": 0.9, "confidence": 0.4},
        {"lane": "snare", "startBeat": 2.0, "confidence": 0.4},
        {"lane": "snare", "startBeat": 2.125, "confidence": 0.4},
        {"lane": "kick", "startBeat": 3.02, "confidence": 0.4},
        {"lane": "kick", "startBeat": 3.04, "confidence": 0.4},
        {"lane": "kick", "startBeat": 3.9, "confidence": 0.4},
        {"lane": "snare", "startBeat": 1.125},
    ]
    snapshot = json.dumps(hits)
    assert drum_notation_beats(hits, bars) == [1.0, 1.0, 2.0, 2.125, 3.0, 3.0, 3.9, 1.125]
    assert json.dumps(hits) == snapshot


def test_drum_musicxml_uses_standard_values_and_chords(tmp_path):
    hits = [{"lane": lane, "startBeat": beat, "velocity": 0.8, "confidence": 0.4}
            for beat in np.arange(0, 4, 0.5) for lane in ("hihat",)]
    hits += [{"lane": "kick", "startBeat": 0.02, "velocity": 0.8, "confidence": 0.4},
             {"lane": "snare", "startBeat": 1.03, "velocity": 0.8, "confidence": 0.4},
             {"lane": "kick", "startBeat": 2.48, "velocity": 0.8, "confidence": 0.4},
             {"lane": "snare", "startBeat": 2.98, "velocity": 0.8, "confidence": 0.4}]
    song = {"bpm": 120, "bars": 1, "beatsPerBar": 4, "beatUnit": 4,
            "tracks": [{"id": "drums", "instrument": "drums", "name": "Drum kit"}], "drums": hits}
    export_musicxml(song, tmp_path / "drums.musicxml")
    measure = ET.parse(tmp_path / "drums.musicxml").find(".//part[@id='drums']/measure")
    notes = measure.findall("note")
    hands = [note for note in notes if note.findtext("voice") == "1"]
    feet = [note for note in notes if note.findtext("voice") == "2"]
    assert all(note.findtext("type") == "eighth" for note in hands)
    assert sum(note.find("chord") is not None for note in hands) == 2
    assert all(note.find("rest") is None for note in hands)
    assert [(note.find("rest") is not None, note.findtext("type"), note.find("dot") is not None)
            for note in feet] == [(False, "half", False), (True, "eighth", False), (False, "quarter", True)]
    assert sum(int(note.findtext("duration")) for note in feet) == 4 * 480

@pytest.mark.parametrize("length", [9, 10, 13])
def test_stable_long_tracked_groups_are_not_shortened(length):
    meter = downbeat_meter(list(range(0, length * 20, length)), 0.95)
    assert meter["supported"] and meter["boundariesVerified"] and meter["beatsPerBar"] == length
    assert [(change["startBeat"], change["numerator"]) for change in meter["changes"]] == [(0.0, length)]


@pytest.mark.parametrize("short,long", [(3, 6), (4, 8)])
def test_sustained_multiple_groups_stay_long_but_unverified(short, long):
    counts = [short] * 8 + [long] * 6
    indices = np.r_[0, np.cumsum(counts)].tolist()
    meter = downbeat_meter(indices, 0.95)
    assert meter["supported"] and not meter["boundariesVerified"]
    bars = build_bar_map(sum(counts), meter["changes"])
    assert [bar["beats"] for bar in bars] == counts
    assert all(bar["status"] == "unverified" for bar in bars)
    # Weak downbeat activation in the middle of each long group is observed evidence of the short bar.
    activation = np.full(sum(counts) + 1, -10.0)
    activation[indices] = 8
    activation[[index + short for index in indices[8:-1]]] = -1
    evidenced = downbeat_meter(indices, 0.95, activation.tolist())
    assert evidenced["evidence"]["recoveredWeakDownbeats"] == 6
    assert [(change["startBeat"], change["numerator"]) for change in evidenced["changes"]] == [(0.0, short)]
    assert evidenced["boundariesVerified"]


@pytest.mark.parametrize("pickup", [1e-7, 1e-10])
def test_tiny_positive_pickup_keeps_exact_coverage(pickup):
    total = 4 + pickup
    bars = build_bar_map(total, [{"startBeat": 0, "numerator": 4, "denominator": 4}], pickup=pickup)
    assert bars[0] == {"startBeat": 0.0, "beats": pickup, "numerator": 4, "denominator": 4,
                       "status": "explicit", "partial": True}
    assert bars[1]["startBeat"] == pickup and bars[-1]["startBeat"] + bars[-1]["beats"] == total


def test_pickup_with_whole_bars_and_a_later_change():
    bars = build_bar_map(19, [{"startBeat": 0, "numerator": 4, "denominator": 4},
                              {"startBeat": 8, "numerator": 3, "denominator": 4}], pickup=6)
    assert [(bar["startBeat"], bar["beats"], bar["numerator"], bool(bar.get("partial"))) for bar in bars] == [
        (0.0, 2.0, 4, True), (2.0, 4, 4, False), (6, 4, 4, False), (10, 4, 4, False),
        (14, 3, 3, False), (17, 2, 3, True)]
    assert build_bar_map(16, [{"startBeat": 0, "numerator": 4, "denominator": 4}], pickup=8)[0]["beats"] == 4

def test_drum_fine_figures_roll_and_triplets_keep_distinct_attacks(tmp_path):
    bars = [{"startBeat": 0.0, "beats": 4.0, "numerator": 4, "denominator": 4}]
    roll = [{"lane": "snare", "startBeat": 1 + step / 16 + (0.004 if step % 2 else -0.003),
             "velocity": 0.7, "confidence": 0.4} for step in range(5)]
    triplets = [{"lane": "hihat", "startBeat": step / 3 + (0.02 if step % 2 else -0.015 * (step > 0)),
                 "velocity": 0.6, "confidence": 0.4} for step in range(12)]
    jittered = [{"lane": "ride", "startBeat": step / 2 + (0.06 if step % 2 else -0.04 * (step > 0)),
                 "velocity": 0.6, "confidence": 0.4} for step in range(8)]
    hits = roll + triplets + jittered
    snapshot = json.dumps(hits)
    written = drum_notation_beats(hits, bars)
    assert written[:5] == [1 + step / 16 for step in range(5)]
    assert written[5:17] == pytest.approx([step / 3 for step in range(12)], abs=1e-9)
    assert written[17:] == [step / 2 for step in range(8)]
    assert json.dumps(hits) == snapshot
    song = {"bpm": 120, "bars": 1, "beatsPerBar": 4, "beatUnit": 4,
            "tracks": [{"id": "drums", "instrument": "drums", "name": "Drum kit"}], "drums": hits}
    export_musicxml(song, tmp_path / "fine.musicxml")
    notes = ET.parse(tmp_path / "fine.musicxml").find(".//part[@id='drums']/measure").findall("note")
    triplet_heads = [note for note in notes if note.find("time-modification") is not None and note.find("rest") is None]
    assert len(triplet_heads) >= 10
    assert sum(note.findtext("type") == "64th" for note in notes if note.find("rest") is None) >= 4
    assert all(note.findtext("type") for note in notes if note.find("rest") is None)

@pytest.mark.parametrize("counts", [[6] * 8 + [3] * 6, [8] * 8 + [4] * 6, [3, 6] * 8, [4, 8] * 8])
def test_observed_shorter_and_alternating_related_groups_are_kept_unverified(counts):
    indices = np.r_[0, np.cumsum(counts)].tolist()
    meter = downbeat_meter(indices, 0.95)
    assert meter["supported"] and not meter["boundariesVerified"]
    bars = build_bar_map(sum(counts), meter["changes"])
    assert [bar["beats"] for bar in bars] == counts
    assert any(bar["status"] == "unverified" for bar in bars)
    assert all(bar["status"] == "unverified" for bar, count in zip(bars, counts) if count != meter["beatsPerBar"])


def test_weak_off_phase_downbeats_in_a_short_run_are_half_bar_accents():
    counts = [4] * 30 + [2] * 6 + [4] * 4
    indices = np.r_[0, np.cumsum(counts)].astype(int).tolist()
    activation = np.full(indices[-1] + 1, -10.0)
    activation[indices] = 5.0
    accents = [index for index in indices[30:37] if (index - indices[30]) % 4]
    activation[accents] = 1.5
    meter = downbeat_meter(indices, 0.95, activation.tolist())
    assert meter["evidence"]["suppressedWeakAccents"] == len(accents) == 3
    assert meter["evidence"]["observedShorterGroups"] == [
        {"startBeat": 120.0, "beats": 12, "groupBeats": 2, "reading": "half-bar accents"}]
    assert [(change["startBeat"], change["numerator"]) for change in meter["changes"]] == [(0.0, 4)]
    assert meter["supported"] and not meter["boundariesVerified"]
    # Equally strong downbeats every two beats are an observed shorter bar, kept unverified.
    activation[accents] = 5.0
    kept = downbeat_meter(indices, 0.95, activation.tolist())
    assert [bar["beats"] for bar in build_bar_map(sum(counts), kept["changes"])] == counts
    assert not kept["boundariesVerified"]


def test_unrelated_meter_change_with_activation_stays_supported():
    counts = [4] * 10 + [3] * 6 + [4] * 4
    indices = np.r_[0, np.cumsum(counts)].astype(int).tolist()
    activation = np.full(indices[-1] + 1, -10.0)
    activation[indices] = 5.0
    meter = downbeat_meter(indices, 0.95, activation.tolist())
    assert [(change["startBeat"], change["numerator"], change["status"]) for change in meter["changes"]] == [
        (0.0, 4, "supported"), (40.0, 3, "supported"), (58.0, 4, "supported")]


def test_tracker_half_time_section_is_a_tempo_octave_not_a_meter_change():
    # The tracker drops to half-time for a passage, still marking every second tracked beat.
    beats = np.r_[np.arange(0.2, 20, 0.5), np.arange(20.2, 36, 1.0), np.arange(36.2, 60, 0.5)]
    downbeats = np.r_[np.arange(0.2, 20, 2.0), np.arange(20.2, 36, 2.0), np.arange(36.2, 60, 2.0)]
    beat, down = logits(beats, downbeats, 61)
    grid = activation_beat_grid(beat, down, 50.0)
    meter = downbeat_meter(grid["downbeatIndices"], grid["confidence"], grid["downbeatActivation"])
    assert grid["cleanup"]["inserted"] == 16
    assert meter["beatsPerBar"] == 4 and meter["boundariesVerified"]
    assert {change["numerator"] for change in meter["changes"]} == {4}


def test_cached_user_labelled_four_four_song_gets_no_invented_short_signature():
    # Haseb Haseb (user-labelled 4/4): Beat This! marks downbeats every two steady beats in two
    # passages, with strong-weak pairing. That is not evidence of a written 2/4 change.
    data = json.loads((Path(__file__).parent / "data" / "haseb_tracked_downbeats.json").read_text())
    meter = downbeat_meter(data["downbeatIndices"], data["beatConfidence"], data["downbeatActivation"])
    assert meter["supported"] and meter["beatsPerBar"] == 4 and not meter["boundariesVerified"]
    assert {change["numerator"] for change in meter["changes"]} == {4}
    assert [group["groupBeats"] for group in meter["evidence"]["observedShorterGroups"]] == [2, 2]
    total = data["downbeatIndices"][-1] - data["downbeatIndices"][0] + 4
    assert {bar["numerator"] for bar in build_bar_map(total, meter["changes"])} == {4}

def sectioned_onsets(beats, sections):
    # (bars, subdivisions per tracked beat) per section, four tracked beats per bar.
    onsets, bar = [], 0
    for count, parts in sections:
        for index in range(bar * 4, (bar + count) * 4):
            period = beats[index + 1] - beats[index]
            onsets.extend(beats[index] + period * step / parts for step in range(parts))
        bar += count
    return onsets


def accent_envelope(bar_map, tempo_map, profiles, step=0.01, duration=None):
    """A detrend-friendly flux curve with one impulse per eighth slot of every full 3/4 bar."""
    end = duration or tempo_map[-1]["time"] + 1
    times = np.arange(0, end, step)
    flux = np.zeros(len(times))
    full = [bar for bar in bar_map if not bar.get("partial")]
    for index, bar in enumerate(full):
        for slot, value in enumerate(profiles(index)):
            when = time_at_beat(tempo_map, 0, bar["startBeat"] + slot / 2)
            flux[int(round(when / step))] += value
    return times, flux


def triple_grid(bars=24, pickup=1.0, trailing=0.0, period=0.8):
    total = pickup + bars * 3 + trailing
    tempo_map = [{"beat": float(beat), "time": round(beat * period, 6)} for beat in range(int(np.ceil(total)) + 1)]
    bar_map = build_bar_map(total, [{"startBeat": 0, "numerator": 3, "denominator": 4, "status": "supported"}],
                            pickup=pickup)
    return bar_map, tempo_map


FELT_DOUBLE = [1.0, 0.6, 0.6, 0.9, 0.6, 0.6]


def test_tracked_half_tempo_triple_becomes_two_bars_per_group_with_unchanged_seconds():
    bar_map, tempo_map = triple_grid()
    converted, mapped, evidence = doubled_triple_reading(
        bar_map, tempo_map, 75, *accent_envelope(bar_map, tempo_map, lambda _: FELT_DOUBLE))
    assert evidence["bars"] == 24 and evidence["midBarAccentShare"] == 1.0
    assert [point["time"] for point in mapped] == [point["time"] for point in tempo_map]
    assert [point["beat"] for point in mapped] == [point["beat"] * 2 for point in tempo_map]
    assert converted[0] == {**converted[0], "startBeat": 0.0, "beats": 2.0, "partial": True}
    assert [bar["beats"] for bar in converted[1:]] == [3.0] * 48
    assert {(bar["numerator"], bar["denominator"]) for bar in converted} == {(3, 4)}
    # Observed downbeats keep their status; every inserted mid-group barline is unverified.
    assert [bar["status"] for bar in converted[1:5]] == ["supported", "unverified"] * 2
    # Each tracked downbeat and each mid-group eighth is now a bar start at its original second.
    starts = [time_at_beat(mapped, 0, bar["startBeat"]) for bar in converted[1:5]]
    assert starts == pytest.approx([0.8, 2.0, 3.2, 4.4])


@pytest.mark.parametrize("profile", [
    [1.0, 0.2, 0.7, 0.3, 0.7, 0.2],  # true triple: beats two and three lead
    [1.0, 0.2, 0.6, 0.9, 0.6, 0.2],  # waltz with a syncopated "and of two": other off-beats stay weak
])
def test_true_and_syncopated_triple_bars_keep_their_tempo(profile):
    bar_map, tempo_map = triple_grid()
    assert doubled_triple_reading(bar_map, tempo_map, 75, *accent_envelope(bar_map, tempo_map, lambda _: profile)) is None


def test_doubled_triple_needs_every_passage_and_a_single_triple_meter():
    bar_map, tempo_map = triple_grid()
    waltz_start = accent_envelope(bar_map, tempo_map,
                                  lambda index: [1.0, 0.2, 0.7, 0.3, 0.7, 0.2] if index < 7 else FELT_DOUBLE)
    assert doubled_triple_reading(bar_map, tempo_map, 75, *waltz_start) is None
    mixed = [*bar_map[:5], {**bar_map[5], "numerator": 4, "beats": 4.0}]
    cursor = mixed[-1]["startBeat"] + 4
    mixed += [{**bar, "startBeat": cursor + 3 * offset} for offset, bar in enumerate(bar_map[6:])]
    assert doubled_triple_reading(mixed, tempo_map, 75, *accent_envelope(mixed, tempo_map, lambda _: FELT_DOUBLE)) is None
    assert doubled_triple_reading(bar_map[:8], tempo_map, 75,
                                  *accent_envelope(bar_map[:8], tempo_map, lambda _: FELT_DOUBLE)) is None


def test_doubled_triple_splits_pickups_and_endings_at_their_true_edges():
    bar_map, tempo_map = triple_grid(pickup=2.0, trailing=2.0)
    converted, _, _ = doubled_triple_reading(
        bar_map, tempo_map, 75, *accent_envelope(bar_map, tempo_map, lambda _: FELT_DOUBLE))
    # A two-beat pickup is four felt beats: a one-beat pickup then a whole bar ending on the downbeat.
    assert [(bar["beats"], bool(bar.get("partial"))) for bar in converted[:2]] == [(1.0, True), (3.0, False)]
    # A two-beat ending is a whole bar then a one-beat remainder.
    assert [(bar["beats"], bool(bar.get("partial"))) for bar in converted[-2:]] == [(3.0, False), (1.0, True)]
    assert converted[2]["startBeat"] == 4.0


def test_doubled_triple_reaches_analysis_with_recording_accents(monkeypatch):
    period, rate = 0.8, 11025
    beats = np.arange(0.4, 0.4 + 61 * period, period)
    tracked(monkeypatch, beats, beats[1::3])
    samples = np.zeros(int((beats[-1] + 1) * rate), dtype=np.float32)
    burst = (np.random.default_rng(3).standard_normal(200) * np.hanning(200)).astype(np.float32)
    for downbeat in beats[1:-3:3]:
        for slot, level in enumerate(FELT_DOUBLE):
            at = int(round((downbeat + slot * period / 2) * rate))
            samples[at:at + 200] += 0.5 * level * burst
    harmony = analyze_harmony(Audio(samples, rate))
    evidence = harmony["timing"]["meter"]["evidence"].get("doubledTriple")
    assert evidence and evidence["midBarAccentShare"] >= 0.5 and min(evidence["passageShares"]) >= 0.4
    assert harmony["bpm"] == pytest.approx(150, rel=0.02)
    assert {(bar["numerator"], bar["denominator"]) for bar in harmony["barMap"]} == {(3, 4)}
    assert "two felt beats" in harmony["warnings"][0]
    for point in harmony["tempoMap"]:
        assert any(abs(point["time"] - time) < 1e-6 for time in [0.0, *beats, len(samples) / rate])


def test_triple_subdivided_passages_become_compound_bars_with_unchanged_seconds():
    beats = np.arange(0, 20 * 4 + 1) * 0.4
    tempo_map = [{"beat": float(index), "time": round(float(time), 6)} for index, time in enumerate(beats)]
    bars = build_bar_map(80, [{"startBeat": 0, "numerator": 4, "denominator": 4, "status": "supported"}])
    onsets = sectioned_onsets(beats, [(5, 4), (8, 3), (7, 2)])
    bar_map, mapped, count = compound_reading(bars, tempo_map, 150, onsets)
    assert count == 8
    assert [(bar["numerator"], bar["denominator"]) for bar in bar_map] == [(4, 4)] * 5 + [(12, 8)] * 8 + [(4, 4)] * 7
    assert [bar["beats"] for bar in bar_map] == [4] * 5 + [6] * 8 + [4] * 7
    assert [point["time"] for point in mapped] == [point["time"] for point in tempo_map]
    # A triplet onset in a compound bar is now a straight eighth of the dotted-quarter beat.
    triplet = beats[5 * 4] + 0.4 / 3
    assert quantize(triplet, 150, 0, mapped) == 20.5
    assert compound_reading(bars, tempo_map, 150, sectioned_onsets(beats, [(20, 4)])) is None
    # One triple-subdivided bar between duple bars is not a signature change.
    assert compound_reading(bars, tempo_map, 150, sectioned_onsets(beats, [(9, 4), (1, 3), (10, 4)])) is None


def test_compound_reading_reaches_analysis_only_with_onset_evidence(monkeypatch):
    beats = np.arange(0.2, 60, 0.4)
    tracked(monkeypatch, beats, beats[::4])
    audio = Audio(np.zeros(60 * 11025, dtype=np.float32), 11025)
    plain = analyze_harmony(audio)
    assert {(bar["numerator"], bar["denominator"]) for bar in plain["barMap"]} == {(4, 4)}
    onsets = sectioned_onsets(beats, [(10, 2), (16, 3), (10, 2)])
    harmony = analyze_harmony(audio, onsets=onsets)
    signatures = [(bar["numerator"], bar["denominator"]) for bar in harmony["barMap"]]
    assert signatures.count((12, 8)) == 16 and (4, 4) in signatures
    assert harmony["timing"]["meter"]["evidence"]["compoundBars"] == 16
    assert "compound x/8" in harmony["warnings"][0]
    for point in harmony["tempoMap"]:
        assert any(abs(point["time"] - time) < 1e-6 for time in [0.0, *beats, 60.0])

def test_compound_and_simple_passages_export_at_recording_speed(monkeypatch, tmp_path):
    beats = np.arange(0.2, 60, 0.4)
    tracked(monkeypatch, beats, beats[::4])
    audio = Audio(np.zeros(60 * 11025, dtype=np.float32), 11025)
    harmony = analyze_harmony(audio, onsets=sectioned_onsets(beats, [(10, 2), (16, 3), (10, 2)]))
    hits = [{"lane": "snare" if index % 3 else "kick", "onset": float(onset), "velocity": 0.8, "confidence": 0.4}
            for index, onset in enumerate(sectioned_onsets(beats, [(10, 2), (16, 3), (10, 2)]))]
    song = build_song("Compound", "test", audio.duration, harmony, [], hits, {})
    tempo_map, bpm = song["tempoMap"], song["bpm"]
    assert [hit["onset"] for hit in song["drums"]] == [hit["onset"] for hit in hits]
    export_midi(song, tmp_path / "compound.mid")
    midi = mido.MidiFile(tmp_path / "compound.mid")
    seconds, note_times, signature_times = 0.0, [], []
    for message in midi:
        seconds += message.time
        if message.type == "note_on" and message.velocity:
            note_times.append(seconds)
        elif message.type == "time_signature":
            signature_times.append((seconds, message.numerator, message.denominator))
    offset = time_at_beat(tempo_map, bpm, 0)
    expected = sorted(time_at_beat(tempo_map, bpm, hit["startBeat"]) - offset for hit in song["drums"])
    assert max(abs(a - b) for a, b in zip(sorted(note_times), expected)) < 0.002
    assert max(abs(a + offset - b) for a, b in zip(sorted(note_times), sorted(hit["onset"] for hit in hits))) < 0.02
    changes = [(time_at_beat(tempo_map, bpm, bar["startBeat"]) - offset, bar["numerator"], bar["denominator"])
               for index, bar in enumerate(song["barMap"]) if index and (bar["numerator"], bar["denominator"]) != (
                   song["barMap"][index - 1]["numerator"], song["barMap"][index - 1]["denominator"])]
    assert [(n, d) for _, n, d in changes] == [(12, 8), (4, 4)]
    for when, numerator, denominator in changes:
        assert any(abs(time - when) < 0.002 and (n, d) == (numerator, denominator) for time, n, d in signature_times)
    export_musicxml(song, tmp_path / "compound.musicxml")
    tempos = [float(node.get("tempo")) for node in ET.parse(tmp_path / "compound.musicxml").find(".//part").iter("sound")]
    assert tempos == pytest.approx([150, 225, 150], rel=0.01)
