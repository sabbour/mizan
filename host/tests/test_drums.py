from threading import Event

import numpy as np
import pytest
from scipy.signal import butter, sosfilt

from mizan.engine.audio import Audio
from mizan.engine.drums import GM_DRUMS, MERGED_CLASSES, classify_bands, transcribe_drums
from mizan.engine.quality_benchmark import drum_metrics
from mizan.errors import Cancelled


def drum_sound(lane, rate=22050):
    t = np.arange(round(rate * 0.2)) / rate
    rng = np.random.default_rng(42)
    if lane == "kick":
        return (np.sin(2 * np.pi * 65 * t) * np.exp(-t * 30)).astype(np.float32)
    low, high = (300, 2500) if lane == "snare" else (5000, 9500)
    noise = sosfilt(butter(3, [low, high], fs=rate, btype="bandpass", output="sos"), rng.normal(size=len(t)))
    return (noise * np.exp(-t * 40)).astype(np.float32)


def drum_stress_fixture(rate=22050):
    hop = round(rate * 0.005)
    length = round(rate * 0.18)
    t = np.arange(length) / rate
    bands = [(30, 180), (180, 3500), (3500, rate * 0.48)]

    def band_powers(sound):
        powers = []
        for low, high in bands:
            filtered = sosfilt(butter(3, [low, high], fs=rate, btype="bandpass",
                                      output="sos"), sound)
            filtered = np.pad(filtered, (0, (-len(filtered)) % hop))
            powers.append(np.mean(filtered.reshape(-1, hop)[:10] ** 2))
        return np.asarray(powers)

    bases = [np.sin(2 * np.pi * 65 * t) * np.exp(-t * 30)]
    rng = np.random.default_rng(42)
    for low, high in ((350, 2600), (5000, 9500)):
        noise = sosfilt(butter(3, [low, high], fs=rate, btype="bandpass",
                               output="sos"), rng.normal(size=length))
        bases.append(noise * np.exp(-t * 40))
    bases = [sound / np.sqrt(band_powers(sound)[index])
             for index, sound in enumerate(bases)]

    cases = [
        ((1, 0, 0), ("kick",)),
        ((0.32, 0.53, 0.15), ("snare",)),
        ((0.32, 0.10, 0.58), ("hihat",)),
        ((0.48, 0.48, 0.04), ("kick", "snare")),
        ((0.48, 0.04, 0.48), ("kick", "hihat")),
        ((0.04, 0.48, 0.48), ("snare", "hihat")),
    ]
    samples = np.zeros(rate * 4, np.float32)
    truth = []
    for index, (weights, lanes) in enumerate(cases):
        onset = 0.25 + index * 0.55
        sound = sum(np.sqrt(weight) * base for weight, base in zip(weights, bases))
        start = round(onset * rate)
        samples[start:start + length] += (sound * 0.005).astype(np.float32)
        truth.extend({"lane": lane, "onset": onset} for lane in lanes)
    return Audio(samples, rate), truth


def test_synthetic_hits_timing_mapping_and_no_fabricated_lanes():
    rate = 22050
    samples = np.zeros(rate * 3, np.float32)
    expected = [(0.25, "kick"), (1.0, "snare"), (1.75, "hihat"), (2.5, "kick")]
    for onset, lane in expected:
        sound = drum_sound(lane)
        start = round(onset * rate)
        samples[start:start + len(sound)] += sound
    events, report = transcribe_drums(Audio(samples, rate))
    assert len(events) == len(expected)
    for event, (onset, lane) in zip(events, expected):
        assert event["lane"] == lane
        assert abs(event["onset"] - onset) < 0.035
        assert 0 < event["velocity"] <= 1
        assert event["confidence"] <= 0.65
        assert event["possibleLanes"] == MERGED_CLASSES[lane]
    assert report["supportedLanes"] == ["kick", "snare", "hihat"]
    assert GM_DRUMS == {"kick": 36, "snare": 38, "hihat": 42, "openhat": 46,
                        "hightom": 48, "floortom": 41, "ride": 51, "crash": 49}


def test_broadband_and_simultaneous_hits_keep_honest_grouped_classes():
    audio, truth = drum_stress_fixture()
    events, _ = transcribe_drums(audio)
    metrics = drum_metrics(events, truth)
    assert {lane: score["f1"] for lane, score in metrics["groupedClasses"].items()} == {
        "kick": 1, "snare": 1, "hihat": 1,
    }
    assert metrics["onsetOnly"]["f1"] == 1


def test_simultaneous_groups_silence_and_cancel():
    assert {lane for lane, _ in classify_bands(np.array([0.5, 0, 0.5]))} == {"kick", "hihat"}
    audio = Audio(np.zeros(22050), 22050)
    assert transcribe_drums(audio)[0] == []
    event = Event()
    event.set()
    with pytest.raises(Cancelled):
        transcribe_drums(audio, event)
