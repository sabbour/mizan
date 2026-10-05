import numpy as np
import pytest

from mizan.engine.audio import Audio
from mizan.engine.harmony import (
    align_chord_changes, analyze_harmony, beat_grid, classify_chord, contiguous_chords, detect_key, numeral, smooth_chords,
)
from mizan.engine.accompaniment import generate_accompaniment, voice_chord


def synth_chord(notes, seconds=2, rate=22050):
    t = np.arange(round(seconds * rate)) / rate
    return sum(0.15 * np.sin(2 * np.pi * 440 * 2 ** ((note - 69) / 12) * t) for note in notes).astype(np.float32)


@pytest.mark.parametrize("root,quality,pcs", [
    (0, "", [0, 4, 7]), (9, "m", [9, 0, 4]), (7, "7", [7, 11, 2, 5]),
    (0, "maj7", [0, 4, 7, 11]), (2, "m7", [2, 5, 9, 0]), (0, "sus4", [0, 5, 7]),
])
def test_chord_templates(root, quality, pcs):
    vector = np.zeros(12)
    vector[pcs] = 1
    result = classify_chord(vector, 0.1)
    assert result["tones"][0] % 12 == root
    assert result["symbol"].endswith(quality)
    assert result["confidence"] >= 0.65


def test_unknown_is_not_silence():
    assert classify_chord(np.ones(12), 0.1)["symbol"] is None
    assert classify_chord(np.zeros(12), 0)["symbol"] == "N.C."
    assert detect_key(np.ones(12)) is None


@pytest.mark.parametrize("root,quality,key,expected", [
    (0, "", {"tonic": "C", "mode": "major"}, ("I", "tonic")),
    (2, "m7", {"tonic": "C", "mode": "major"}, ("ii7", "predominant")),
    (7, "7", {"tonic": "C", "mode": "major"}, ("V7", "dominant")),
    (4, "7", {"tonic": "C", "mode": "major"}, ("V7/vi", "dominant")),
    (9, "m", {"tonic": "A", "mode": "minor"}, ("i", "tonic")),
    (4, "7", {"tonic": "A", "mode": "minor"}, ("V7", "dominant")),
])
def test_numerals(root, quality, key, expected):
    assert numeral(root, quality, key) == expected


def test_smoothing_and_duration():
    base = classify_chord(np.array([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]), 0.1)
    chords = [{**base, "startBeat": i, "beats": 1} for i in range(3)]
    chords[1].update(symbol=None, confidence=0.2)
    result = smooth_chords(chords)
    assert len(result) == 1 and result[0]["beats"] == 3
    chords[1]["symbol"] = "N.C."
    assert len(smooth_chords(chords)) == 3


def test_uncertain_chords_are_not_invented_across_silence():
    c = classify_chord(np.array([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]), 0.1)
    blank = {**c, "symbol": None, "tones": [], "startBeat": 1, "beats": 1, "confidence": 0.1}
    silence = {**blank, "symbol": "N.C.", "startBeat": 2}
    result = contiguous_chords([
        {**c, "startBeat": 0, "beats": 1}, blank, silence, {**c, "startBeat": 3, "beats": 1},
    ])
    assert [chord["symbol"] for chord in result] == ["C", None, "N.C.", "C"]
    assert [chord["startBeat"] for chord in result] == [0, 1, 2, 3]


def test_synthetic_harmony_beats_and_accompaniment():
    rate = 22050
    audio = np.concatenate([synth_chord(notes) for notes in ([60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62])])
    for onset in np.arange(0, 8, 0.5):
        start = round(onset * rate)
        audio[start:start + 200] += 0.5 * np.exp(-np.arange(200) / 30)
    harmony = analyze_harmony(Audio(audio, rate))
    assert abs(harmony["bpm"] - 120) < 3
    assert harmony["timing"]["confidence"] > 0.5
    assert {"C", "Am", "F", "G"} <= {c["symbol"] for c in harmony["chords"]}
    notes = generate_accompaniment(harmony)
    assert notes == generate_accompaniment(harmony)
    assert {n["hand"] for n in notes} == {"left", "right"}
    assert all(60 <= n["midi"] <= 84 for n in notes if n["hand"] == "right")
    assert all(n["generated"] and n["beats"] > 0 for n in notes)
    assert all(n["startBeat"] + n["beats"] <= 8 * harmony["bpm"] / 60 + 1e-5 for n in notes)


@pytest.mark.parametrize("phase", [0.0, 0.35])
def test_chord_changes_follow_labelled_audio_onsets_not_late_bar_edges(monkeypatch, phase):
    monkeypatch.setenv("MIZAN_BEATS", "dsp")
    rate = 22050
    samples = np.zeros(round((8 + phase) * rate), dtype=np.float32)
    for index, pitches in enumerate(([60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62])):
        start = round((phase + 2 * index) * rate)
        end = min(len(samples), round((phase + 2 * (index + 1)) * rate))
        t = np.arange(end - start) / rate
        samples[start:end] = sum(0.12 * np.sin(2 * np.pi * 440 * 2 ** ((pitch - 69) / 12) * t)
                                 for pitch in pitches)
    for onset in np.arange(phase, 8 + phase, 0.5):
        start = round(onset * rate)
        stop = min(start + 160, len(samples))
        samples[start:stop] += 0.65 * np.exp(-np.arange(stop - start) / 16)
    harmony = analyze_harmony(Audio(samples, rate))
    assert abs(harmony["bpm"] - 120) < 3
    for symbol, onset in (("Am", 2 + phase), ("F", 4 + phase), ("G", 6 + phase)):
        starts = [chord["startBeat"] * 60 / harmony["bpm"]
                  for chord in harmony["chords"] if chord["symbol"] == symbol]
        assert starts and abs(starts[0] - onset) < 0.07, (symbol, starts, onset)


def test_chord_alignment_does_not_move_unsupported_or_uncertain_boundaries():
    c = classify_chord(np.array([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]), 0.1)
    am = classify_chord(np.array([1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]), 0.1)
    chords = [{**c, "startBeat": 0, "beats": 4},
              {**am, "startBeat": 4, "beats": 4},
              {**am, "symbol": None, "tones": [], "startBeat": 8, "beats": 4},
              {**am, "symbol": "N.C.", "tones": [], "startBeat": 12, "beats": 4}]
    times = np.arange(0, 8, 0.01)
    chroma = np.zeros((len(times), 12))
    chroma[:, [0, 4, 7]] = 1
    original = [dict(chord) for chord in chords]
    assert align_chord_changes(chords, times, chroma, 120) == original
    assert chords == original


def test_chord_alignment_recovers_a_change_missed_by_a_full_beat():
    c = classify_chord(np.array([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]), 0.1)
    am = classify_chord(np.array([1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]), 0.1)
    chords = [{**c, "startBeat": 0, "beats": 5},
              {**am, "startBeat": 5, "beats": 4}]
    times = np.arange(0, 4.5, 0.01)
    chroma = np.zeros((len(times), 12))
    chroma[np.ix_(times < 2, [4, 7])] = 1
    chroma[np.ix_(times >= 2, [4, 9])] = 1
    aligned = align_chord_changes(chords, times, chroma, 120)
    assert abs(aligned[1]["startBeat"] * 0.5 - 2) < 0.03
    assert abs(aligned[0]["beats"] + aligned[1]["beats"] - 9) < 1e-6


def test_voice_leading_and_styles():
    first = voice_chord([60, 64, 67])
    second = voice_chord([65, 69, 72], first)
    assert sum(abs(a - b) for a, b in zip(first, second)) <= 6
    for energy, style in ((0.2, "block"), (0.5, "arpeggio"), (0.9, "pop")):
        harmony = {"chords": [{"symbol": "C", "tones": [60, 64, 67], "startBeat": 0, "beats": 4, "confidence": 0.8}],
                   "sections": [{"startBar": 1, "bars": 1}], "sectionEnergy": [energy]}
        notes = generate_accompaniment(harmony)
        assert {n["style"] for n in notes} == {style}
        for beat in {n["startBeat"] for n in notes}:
            right = [n["midi"] for n in notes if n["startBeat"] == beat and n["hand"] == "right"]
            assert not right or max(right) - min(right) <= 12


def test_silence_no_fabricated_parts():
    harmony = analyze_harmony(Audio(np.zeros(22050, dtype=np.float32), 22050))
    assert harmony["key"] is None
    assert harmony["chords"][0]["symbol"] == "N.C."
    assert harmony["timing"]["confidence"] == 0
    assert generate_accompaniment(harmony) == []


def test_tempo_does_not_drift_with_missing_beats_and_alternating_attacks():
    times = np.arange(0, 60, 0.01)
    flux = np.zeros_like(times)
    for index, onset in enumerate(np.arange(0, 60, 0.5)):
        if index % 4 == 2:
            continue
        latency = 0.02 if index % 2 else -0.01
        flux[max(0, round((onset + latency) / 0.01))] = 1
    grid = beat_grid(times, flux, 60)
    assert abs(grid["bpm"] - 120) < 0.1
    assert max(abs(beat - round(beat * 2) / 2) for beat in grid["times"]) < 0.05
    assert grid["meterConfidence"] == 0
