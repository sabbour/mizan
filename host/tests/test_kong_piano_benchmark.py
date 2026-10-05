import numpy as np
import pytest

from mizan.engine.kong_piano_benchmark import (
    OUTPUTS, decode_notes, kong_outputs, regression_peaks,
)
from mizan.engine.quality_benchmark import note_metrics


def test_regression_decoder_keeps_offsets_and_repeated_attacks():
    output = {name: np.zeros((250, 88), np.float32) for name in (
        "reg_onset_output", "reg_offset_output", "frame_output", "velocity_output")}
    pitch = 76 - 21
    output["reg_onset_output"][50, pitch] = 0.8
    output["reg_onset_output"][150, pitch] = 0.8
    output["reg_offset_output"][120, pitch] = 0.7
    output["reg_offset_output"][210, pitch] = 0.7
    output["frame_output"][50:120, pitch] = 0.9
    output["frame_output"][150:210, pitch] = 0.9
    output["velocity_output"][:, pitch] = 0.5
    notes = decode_notes(output, 2.5)
    np.testing.assert_allclose([(note["onset"], note["offset"]) for note in notes],
                               [(0.5, 1.2), (1.5, 2.1)])
    score = note_metrics(notes, [{"midi": 76, "onset": 0.5, "offset": 1.2},
                                 {"midi": 76, "onset": 1.5, "offset": 2.1}])
    assert score["onsetPitch"]["f1"] == score["onsetPitchOffset"]["f1"] == 1
    peaks, shifts = regression_peaks(np.array([0, 0.2, 0.5, 0.4, 0, 0]), 0.3, 2)
    assert peaks[2] and shifts[2] > 0


def test_decoder_rejects_incomplete_outputs():
    with pytest.raises(ValueError, match="Unexpected Kong output shape"):
        decode_notes({"frame_output": np.zeros((10, 88))}, 1.0)


def test_overlapping_windows_keep_3000_frames_without_seam_duplicates():
    class Model:
        class Session:
            @staticmethod
            def get_outputs():
                return [type("Output", (), {"name": name})() for name in OUTPUTS]

        session = Session()
        first_output = [np.zeros((1, 1001, 88), np.float32) for _ in OUTPUTS]
        index = 0

        def run(self, feed):
            assert feed["waveform"].shape == (1, 160000)
            self.index += 1
            return [np.full((1, 1001, 88), self.index, np.float32) for _ in OUTPUTS]

    result = kong_outputs(Model(), np.zeros(30 * 16000, np.float32))
    for values in result.values():
        assert values.shape == (3000, 88)
        np.testing.assert_array_equal(values[[749, 750, 1249, 1250, 2249, 2250], 0],
                                      [0, 1, 1, 2, 3, 4])
