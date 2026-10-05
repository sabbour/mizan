from pathlib import Path
from unittest.mock import patch

import numpy as np

from mizan.engine.audio import Audio
from mizan.engine.real_sample_benchmark import (
    PROGRESSION, RATE, SAMPLES, assemble_fixture, beat_metrics, score_run,
)


def test_chord_fixture_provenance_and_assembly():
    clips = {}
    for name in SAMPLES:
        data = np.zeros((RATE, 2), np.float32)
        data[100:] = 0.1
        clips[name] = Audio(data, RATE)
        assert len(SAMPLES[name]["sha256"]) == 64
        assert SAMPLES[name]["license"].startswith("https://github.com/")
    mix, piano, drums, truth, _, peak = assemble_fixture(clips, chords=True)
    assert np.allclose(mix.samples, piano.samples + drums.samples)
    assert peak < 1
    assert truth["key"] == {"tonic": "E", "mode": "major"}
    assert truth["chords"][0] == {"symbol": "N.C.", "onset": 0, "offset": 0.5}
    assert truth["chords"][-1]["offset"] == 30
    assert [chord["symbol"] for chord in truth["chords"][1:5]] == [
        symbol for symbol, _ in PROGRESSION]
    assert len(truth["piano"]) == 3 * (len(truth["chords"]) - 1)
    assert all(note["midi"] in {SAMPLES[n]["midi"] for n in names}
               for chord, (_, names) in zip(truth["chords"][1:], PROGRESSION * 4)
               for note in truth["piano"] if note["onset"] == chord["onset"])


def test_scores_report_unknown_chords_and_one_to_one_beats():
    truth = {"piano": [{"midi": 76, "onset": 0.5, "offset": 1.5}],
             "drums": [{"lane": "kick", "onset": 0.5}],
             "chords": [{"symbol": "E", "onset": 0, "offset": 30}],
             "key": {"tonic": "E", "mode": "major"}}
    note = {**truth["piano"][0]}
    song = {"piano": [note], "drums": truth["drums"], "chords": [],
            "key": None, "timing": {"times": [0.5, 0.51]},
            "detected": {"piano": 0.1, "drums": 0.2},
            "selectedInstruments": ["drums", "piano"],
            "modelVersions": {}, "diagnostics": {
                "chords": {"method": "onset-grid-v2", "provider": {
                    "effectiveProviders": ["CPU-DSP"]}, "seconds": 1.2}}}
    with patch("mizan.engine.real_sample_benchmark.leakage", return_value={}):
        result = score_run(song, Path("."), None, None, truth, 2.0)
    assert result["piano"]["onsetPitch"]["f1"] == 1
    assert result["chords"]["accuracyIncludingUnknown"] == 0
    assert result["key"]["correct"] is False
    assert result["effectiveProviders"]["chords"] == ["CPU-DSP"]
    assert result["stageSeconds"]["chords"] == 1.2
    assert beat_metrics([0.5, 0.51], [0.5])["matched"] == 1
