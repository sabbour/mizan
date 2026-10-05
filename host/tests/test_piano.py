from threading import Event
from io import BytesIO
import hashlib
import os
from pathlib import Path

import numpy as np
import pytest

from mizan.engine.audio import Audio
from mizan.engine.models import BASIC_PITCH, checksum, ensure_model
from mizan.engine.piano import (
    assign_hands, activation_notes, reinforce_sustain, sustain_notes, transcribe_piano,
)
from mizan.errors import Cancelled, ModelFailed
from test_harmony import synth_chord


def test_synthesized_polyphonic_piano(monkeypatch):
    monkeypatch.setenv("MIZAN_PIANO", "dsp")
    signal = np.concatenate([np.zeros(11025), synth_chord([48, 60, 64, 67], 1), np.zeros(11025)]).astype(np.float32)
    active = []
    notes, report = transcribe_piano(Audio(signal, 22050), on_model=active.append)
    assert active == [{"method": "spectral-piano-v1", "provider": {"effectiveProviders": ["CPU-DSP"]}}]
    assert {n["midi"] for n in notes} == {48, 60, 64, 67}
    for note in notes:
        assert abs(note["onset"] - 0.5) < 0.12
        assert abs(note["offset"] - 1.5) < 0.12
        assert 0 < note["confidence"] <= 0.65
    assert next(n for n in notes if n["midi"] == 48)["hand"] == "left"
    assert next(n for n in notes if n["midi"] == 67)["hand"] == "right"
    assert report["warnings"]


def test_artifacts_repeats_and_silence(monkeypatch):
    values = np.zeros((100, 88))
    values[10:12, 39] = 0.8
    values[30:90, 43] = 0.9
    onset = np.zeros_like(values)
    onset[60, 43] = 0.8
    notes = activation_notes(values, 0.01, 1.0, onset=onset)
    assert [n["midi"] for n in notes] == [64, 64]
    assert notes[0]["offset"] == notes[1]["onset"] == 0.6
    monkeypatch.setenv("MIZAN_PIANO", "dsp")
    assert transcribe_piano(Audio(np.zeros(22050), 22050))[0] == []


def test_fragmented_notes_merge_but_reonsets_remain():
    fragments = [
        {"midi": 60, "onset": 0.0, "offset": 0.4, "velocity": 0.6, "confidence": 0.7},
        {"midi": 60, "onset": 0.5, "offset": 1.0, "velocity": 0.8, "confidence": 0.9},
        {"midi": 60, "onset": 1.0, "offset": 1.4, "velocity": 0.7, "confidence": 0.8},
    ]
    notes = sustain_notes(fragments)
    assert len(notes) == 2
    assert notes[0]["onset"] == 0 and notes[0]["offset"] == 1
    assert notes[1]["onset"] == 1 and notes[1]["offset"] == 1.4


def test_mix_reference_extends_stem_notes_without_crossing_reonset():
    stem = [
        {"midi": 60, "onset": 0.0, "offset": 0.3},
        {"midi": 60, "onset": 1.0, "offset": 1.2},
    ]
    mix = [
        {"midi": 60, "onset": 0.04, "offset": 1.1},
        {"midi": 60, "onset": 1.03, "offset": 1.8},
    ]
    result = reinforce_sustain(stem, mix)
    assert result[0]["offset"] == 1.0
    assert result[1]["offset"] == 1.8

    microtonal = reinforce_sustain(
        [{"midi": 60.499, "onset": 0, "offset": 0.3}],
        [{"midi": 60.501, "onset": 0.01, "offset": 0.8}])
    assert microtonal[0]["midi"] == 60.499 and microtonal[0]["offset"] == 0.8

    repeated = reinforce_sustain(
        [{"midi": 60.49, "onset": 0, "offset": 0.3},
         {"midi": 60.54, "onset": 1, "offset": 1.2}],
        [{"midi": 60.55, "onset": 0.04, "offset": 1.1},
         {"midi": 60.50, "onset": 1.03, "offset": 1.8},
         {"midi": 61, "onset": 0.04, "offset": 2}])
    assert [(note["midi"], note["offset"]) for note in repeated] == [
        (60.49, 1), (60.54, 1.8)]


def test_hands_continuity_and_input_not_mutated():
    events = [{"midi": p, "onset": i * 0.5, "offset": i * 0.5 + 0.4} for i, p in enumerate([50, 55, 57, 72, 64])]
    result = assign_hands(events)
    assert [n["hand"] for n in result] == ["left", "left", "left", "right", "right"]
    assert "hand" not in events[0]


def test_model_checksum_download_cache_and_corruption(monkeypatch):
    content = b"test model bytes"
    spec = {"id": "test", "url": "https://example.invalid/model", "sha256": hashlib.sha256(content).hexdigest()}
    calls = []

    def download(*args, **kwargs):
        calls.append(args)
        return BytesIO(content)

    monkeypatch.setattr("urllib.request.urlopen", download)
    target = ensure_model(spec)
    assert ensure_model(spec) == target and len(calls) == 1
    target.write_bytes(b"corrupt")
    assert ensure_model(spec).read_bytes() == content and len(calls) == 2
    with pytest.raises(ModelFailed, match="checksum"):
        ensure_model({**spec, "sha256": "0" * 64})
    assert not target.with_suffix(".partial").exists()
    event = Event()
    event.set()
    with pytest.raises(Cancelled):
        ensure_model(spec, event)


def test_unavailable_model_has_explicit_cpu_fallback(monkeypatch):
    def fail(*args, **kwargs):
        raise ModelFailed("offline")

    monkeypatch.setenv("MIZAN_PIANO", "auto")
    monkeypatch.setattr("mizan.engine.piano.ensure_model", fail)
    notes, report = transcribe_piano(Audio(synth_chord([60]), 22050))
    assert notes and report["method"] == "spectral-piano-v1"
    assert "offline" in report["warnings"][0]


def test_empty_learned_result_attempts_honest_spectral_recovery(monkeypatch):
    monkeypatch.setenv("MIZAN_PIANO", "auto")
    monkeypatch.setattr("mizan.engine.piano.basic_pitch", lambda *args, **kwargs: (
        [], {"method": "basic-pitch", "provider": {"effectiveProviders": ["CPU"]}, "warnings": []}))
    notes, details = transcribe_piano(Audio(synth_chord([60], seconds=1) * 0.05, 22050))
    assert notes and {note["midi"] for note in notes} == {60}
    assert all(note["confidence"] <= 0.45 for note in notes)
    assert "spectral-recovery" in details["method"]
    assert any("tentative" in warning for warning in details["warnings"])
    assert transcribe_piano(Audio(np.zeros(22050), 22050))[0] == []


def test_cached_real_model_window_alignment(monkeypatch):
    path = os.environ.get("MIZAN_TEST_MODEL")
    if not path:
        pytest.skip("Set MIZAN_TEST_MODEL to the verified cached Basic Pitch file for offline integration.")
    model = Path(path)
    assert checksum(model) == BASIC_PITCH["sha256"]
    monkeypatch.setattr("mizan.engine.piano.ensure_model", lambda **kwargs: model)
    monkeypatch.setenv("MIZAN_PIANO", "auto")
    monkeypatch.setenv("MIZAN_PROVIDER", "cpu")
    rate = 22050
    samples = np.zeros(rate * 6, np.float32)
    for onset in (0.5, 2.5, 4.5):
        sound = synth_chord([64], 1)
        samples[round(onset * rate):round(onset * rate) + len(sound)] = sound
    notes, report = transcribe_piano(Audio(samples, rate))
    assert report["method"] == "basic-pitch"
    assert report["provider"]["effectiveProviders"] == ["CPUExecutionProvider"]
    assert [note["midi"] for note in notes] == [64, 64, 64]
    for note, onset in zip(notes, (0.5, 2.5, 4.5)):
        assert abs(note["onset"] - onset) < 0.08
        assert abs(note["offset"] - onset - 1) < 0.15
