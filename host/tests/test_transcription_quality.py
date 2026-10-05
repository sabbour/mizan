import numpy as np
import pytest

from mizan.engine.audio import Audio
from mizan.engine.detect import (insufficient_score_evidence, selected_instruments,
                                 stem_levels, stem_peak_levels, transcription_quality)
from mizan.engine.drums import transcribe_drums
from test_drums import drum_sound


def test_auto_selection_keeps_quiet_and_silent_candidates():
    assert selected_instruments({"piano": 0.46, "drums": 0.14}) == ["piano", "drums"]
    assert selected_instruments({"piano": 0, "drums": 0.14}) == ["drums", "piano"]
    assert set(selected_instruments({"piano": 0, "drums": 0})) == {"piano", "drums"}


def test_quiet_real_drum_attacks_survive_transcription_and_quality():
    samples = np.zeros(22050 * 4, np.float32)
    for index in range(8):
        sound = drum_sound("kick") * 0.025
        start = index * 11025
        samples[start:start + len(sound)] += sound
    audio = Audio(samples, 22050)
    events, _ = transcribe_drums(audio)
    result = transcription_quality("drums", events, audio, 0.14,
                                   {"confidence": 0.9, "times": list(np.arange(0, 4, 0.5))})
    assert len(events) >= 8
    assert result["status"] == "usable" and result["confidence"] == "medium"
    assert result["rhythmicConsistency"] >= 0.75


@pytest.mark.parametrize("confidence,level", [(0.2, 0.14), (0.9, 0.001)])
def test_weak_events_remain_present_and_explicitly_tentative(confidence, level):
    events = [{"onset": i * 0.5, "confidence": confidence} for i in range(8)]
    result = transcription_quality("piano", events, Audio(np.ones(22050) * 0.01, 22050), level)
    assert result["status"] == "tentative" and result["confidence"] == "low"
    assert result["eventCount"] == len(events) == 8
    assert result["reasons"] and "low confidence" in result["warnings"][0]
    assert result["rhythmicConsistency"] is None


def test_empty_and_irregular_results_are_not_silently_absent_or_strong():
    audio = Audio(np.ones(22050) * 0.01, 22050)
    empty = transcription_quality("piano", [], audio, 0.2)
    assert empty["status"] == "empty" and empty["warnings"]
    events = [{"onset": i * 0.5 + 0.0625, "confidence": 0.6} for i in range(8)]
    result = transcription_quality("drums", events, audio, 0.2,
                                   {"confidence": 0.9, "times": list(np.arange(0, 5, 0.5))})
    assert result["rhythmicConsistency"] == 0
    assert result["status"] == "tentative" and result["eventCount"] == 8


def test_presence_evidence_is_separate_from_note_confidence():
    evidence = {"eventCount": 94, "stemPeakLevel": 0.1107}
    assert insufficient_score_evidence("drums", evidence)
    assert insufficient_score_evidence("drums", {**evidence, "stemPeakLevel": 0.2018}) is None
    assert insufficient_score_evidence("vocals", {**evidence, "stemPeakLevel": 0.0019})
    assert insufficient_score_evidence("vocals", {**evidence, "stemPeakLevel": 0.02}) is None


def test_short_window_peak_keeps_sparse_recorded_hits():
    rate = 22050
    mix = np.ones(rate * 30, dtype=np.float32) * 0.01
    sparse = np.zeros_like(mix)
    sparse[rate * 20:rate * 20 + rate // 10] = 0.01
    levels = stem_peak_levels(Audio(mix, rate), {"drums": Audio(sparse, rate)})
    assert stem_levels(Audio(mix, rate), {"drums": Audio(sparse, rate)})["drums"] < 0.08
    assert levels["drums"] == 1
