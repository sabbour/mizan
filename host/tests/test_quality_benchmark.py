import pytest

import numpy as np

from mizan.engine.audio import Audio
from mizan.engine.quality_benchmark import chord_metrics, drum_metrics, fixture, note_metrics
from mizan.engine.real_sample_benchmark import RATE, SAMPLES, assemble_fixture, measured_pitch


def test_fixture_has_aligned_sustains_hats_and_chords():
    mix, piano, drums, truth = fixture(30)
    assert mix.samples.shape == piano.samples.shape == drums.samples.shape == (30 * 22050, 2)
    assert {hit["lane"] for hit in truth["drums"]} == {"kick", "snare", "hihat", "openhat"}
    assert sum(note["offset"] - note["onset"] > 2 for note in truth["piano"]) > 0
    assert truth["chords"][0]["symbol"] == "C" and truth["chords"][-1]["offset"] == 30


def test_one_to_one_pitch_onset_offset_and_false_note_penalty():
    truth = [{"midi": 60, "onset": 0.0, "offset": 2.6}]
    predicted = [{"midi": 60, "onset": 0.04, "offset": 0.9},
                 {"midi": 62, "onset": 0.0, "offset": 2.6}]
    result = note_metrics(predicted, truth)
    assert result["onsetPitch"]["f1"] == 2 / 3
    assert result["onsetPitchOffset"]["f1"] == 0
    assert result["meanOffsetErrorSeconds"] == pytest.approx(1.7)
    assert result["sustained"] == {"expected": 1, "onsetPitchMatched": 1, "onsetPitchOffsetMatched": 0}


def test_fractional_pitch_requires_fifteen_cent_agreement_without_loosening_timing():
    truth = [{"midi": 60.5, "onset": 1, "offset": 2}]
    near = [{"midi": 60.56, "onset": 1.14, "offset": 2.1}]
    result = note_metrics(near, truth)
    assert result["pitchToleranceCents"] == 15
    assert result["onsetPitch"]["f1"] == result["onsetPitchOffset"]["f1"] == 1
    for wrong in ({**near[0], "midi": 60.66},  # 16 cents
                  {**near[0], "midi": 61.5},   # whole-semitone error
                  {**near[0], "onset": 1.16},
                  {**near[0], "offset": 2.25}):
        score = note_metrics([wrong], truth)
        assert score["onsetPitchOffset"]["f1"] == 0
        if wrong["midi"] != near[0]["midi"] or wrong["onset"] != near[0]["onset"]:
            assert score["onsetPitch"]["f1"] == 0
    duplicate = note_metrics([near[0], {**near[0], "midi": 60.53}], truth)
    assert duplicate["onsetPitch"]["matched"] == 1
    assert duplicate["onsetPitch"]["precision"] == 0.5


def test_drums_distinguish_confusion_from_unsupported_hat_subtypes():
    truth = [{"lane": "kick", "onset": 0.0}, {"lane": "openhat", "onset": 1.0}]
    predicted = [{"lane": "snare", "onset": 0.01}, {"lane": "hihat", "onset": 1.02}]
    result = drum_metrics(predicted, truth)
    assert result["onsetOnly"]["f1"] == 1
    assert result["groupedClasses"]["kick"]["f1"] == 0
    assert result["groupedClasses"]["hihat"]["f1"] == 1
    assert result["confusion"] == {"kick": {"snare": 1}, "hihat": {"hihat": 1}}
    assert result["unsupportedSubtypes"]["openHat"] is None


def test_chord_unknown_and_gap_count_as_incorrect():
    expected = [{"symbol": "C", "onset": 0, "offset": 1},
                {"symbol": "G", "onset": 1, "offset": 2}]
    predicted = [{"symbol": "C", "onset": 0, "offset": 0.5},
                 {"symbol": None, "onset": 0.5, "offset": 1}]
    result = chord_metrics(predicted, expected, 2)
    assert result["coverage"] == 0.25
    assert result["accuracyIncludingUnknown"] == 0.25
    assert result["accuracyWhenCovered"] == 1


def test_real_sample_fixture_aligns_known_events_without_clipping():
    seconds = 3
    clips = {}
    for name in SAMPLES:
        samples = np.zeros((RATE, 2), np.float32)
        samples[100:, :] = 0.1
        clips[name] = Audio(samples, RATE)
    mix, piano, drums, truth, trims, peak = assemble_fixture(clips, seconds)
    assert mix.samples.shape == piano.samples.shape == drums.samples.shape == (seconds * RATE, 2)
    assert truth["piano"] == [{
        "midi": 72, "onset": 0.5, "offset": pytest.approx(0.5 + (RATE - 100) / RATE),
    }]
    assert {hit["lane"] for hit in truth["drums"]} == {"kick", "snare", "hihat"}
    assert all(value == pytest.approx(100 / RATE) for value in trims.values())
    assert peak < 1


def test_pitch_measurement_checks_expected_note():
    frequency = 440 * 2 ** ((72 - 69) / 12)
    t = np.arange(2 * RATE) / RATE
    measured, cents = measured_pitch(Audio(np.sin(2 * np.pi * frequency * t), RATE), 72)
    assert measured == pytest.approx(frequency, abs=2)
    assert cents == pytest.approx(0, abs=7)
