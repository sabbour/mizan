from threading import Event

import numpy as np
import pytest

from mizan.engine.audio import Audio
from mizan.engine.separation import separate
from mizan.errors import Cancelled


@pytest.mark.parametrize("duration,channels", [(0.01, 1), (2, 2), (10.2, 1)])
def test_alignment_reconstruction_and_stereo(duration, channels):
    rate = 22050
    t = np.arange(round(duration * rate)) / rate
    tone = (0.2 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    onset = rate * 10 if duration > 10 else len(t) // 2
    tone[onset] += 0.8
    samples = tone if channels == 1 else np.column_stack((tone, tone * 0.5))
    stems, report = separate(Audio(samples, rate))
    harmonic, percussion = stems["piano"], stems["drums"]
    assert set(stems) == {"vocals", "piano", "guitar", "bass", "drums", "other"}
    assert all(stem.samples.shape == samples.shape for stem in stems.values())
    np.testing.assert_allclose(harmonic.samples + percussion.samples, samples, atol=1e-7)
    np.testing.assert_allclose(sum(stem.samples for stem in stems.values()), samples, atol=1e-7)
    assert np.argmax(abs(percussion.mono())) == onset
    if channels == 2:
        np.testing.assert_allclose(harmonic.samples[:, 1], harmonic.samples[:, 0] * 0.5, atol=1e-6)
    assert report["latencySamples"] == 0 and report["warnings"]


def test_silence_and_cancellation():
    audio = Audio(np.zeros(22050, np.float32), 22050)
    stems, _ = separate(audio)
    assert not any(stem.samples.any() for stem in stems.values())
    event = Event()
    event.set()
    with pytest.raises(Cancelled):
        separate(audio, event)


@pytest.mark.parametrize("channels", [1, 2])
def test_learned_overlap_preserves_edges_channels_and_alignment(monkeypatch, channels):
    from mizan.engine import separation

    monkeypatch.setenv("MIZAN_SEPARATOR", "auto")
    monkeypatch.setattr(separation, "MODEL_RATE", 22050)
    monkeypatch.setattr(separation, "MODEL_SAMPLES", 800)
    monkeypatch.setattr(separation, "ensure_model", lambda *args: None)

    class IdentityModel:
        def __init__(self, path, feeds, **kwargs):
            self.report = {"effectiveProviders": ["CPU"]}
            self.first_output = self.run(feeds)

        def run(self, feeds):
            return [np.repeat(feeds["mix"][:, None], 6, axis=1) / 6]

    monkeypatch.setattr(separation, "VerifiedModel", IdentityModel)
    samples = np.random.default_rng(1).normal(size=1501).astype(np.float32) * 0.1
    if channels == 2:
        samples = np.column_stack((samples, samples * 0.5))
    stems, details = separate(Audio(samples, 22050))
    assert details["method"] == "htdemucs-6s-onnx"
    assert all(stem.samples.shape == samples.shape for stem in stems.values())
    np.testing.assert_allclose(sum(stem.samples for stem in stems.values()), samples, atol=1e-7)
