import json
from xml.etree import ElementTree as ET

import mido
import numpy as np
import pytest

from mizan.engine.audio import Audio
from mizan.engine.harmony import activation_beat_grid, analyze_harmony, clean_beats, downbeat_meter
from mizan.engine.models import BEAT_THIS
from mizan.engine.output import build_song, drum_notation_beats, export_midi, export_musicxml
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
    activation[indices] = np.random.default_rng(5).uniform(2, 8, len(indices))
    accents = [index for index in indices[30:37] if (index - indices[30]) % 4]
    activation[accents] = 0.1
    meter = downbeat_meter(indices, 0.95, activation.tolist())
    assert meter["evidence"]["suppressedWeakAccents"] == len(accents) == 3
    assert [(change["startBeat"], change["numerator"]) for change in meter["changes"]] == [(0.0, 4)]
    assert meter["boundariesVerified"]
    # The same run with downbeat-strength off-phase hits stays observed 2-beat bars.
    activation[accents] = 5
    kept = downbeat_meter(indices, 0.95, activation.tolist())
    assert [bar["beats"] for bar in build_bar_map(sum(counts), kept["changes"])] == counts
    assert not kept["boundariesVerified"]
