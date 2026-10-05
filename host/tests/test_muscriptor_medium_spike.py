import pytest
import numpy as np

from mizan.engine.muscriptor_medium_spike import (
    DRUM, PITCH, PROGRAM, SHIFT, TIE, VELOCITY, decode, decode_chunk, log_mel,
    tie_prompt,
)


def test_decodes_tie_then_piano_retrigger_and_drum_without_phantom_notes():
    tokens = [TIE, PROGRAM, VELOCITY + 1, SHIFT + 25, PITCH + 60,
              SHIFT + 60, PITCH + 60, DRUM + 36, VELOCITY, SHIFT + 85, PITCH + 60]
    assert decode(tokens) == [
        {"instrument": "program_0", "midi": 60, "onset": 0.25, "offset": 0.6},
        {"instrument": "drums", "midi": 36, "onset": 0.6, "offset": 0.61},
        {"instrument": "program_0", "midi": 60, "onset": 0.6, "offset": 0.85},
    ]


def test_rejects_missing_tie_section():
    with pytest.raises(ValueError, match="Missing tie marker"):
        decode([SHIFT + 20, PROGRAM, PITCH + 60])


def test_five_second_frontend_has_expected_finite_shape():
    mel = log_mel(np.zeros(5 * 16000, dtype=np.float32))
    assert mel.shape == (1, 501, 512)
    assert np.isfinite(mel).all()


def test_forced_tie_prologue_preserves_note_across_chunk_boundary():
    active = {}
    assert decode_chunk([TIE, PROGRAM, VELOCITY + 1, SHIFT + 400, PITCH + 60],
                        0, 5, active) == []
    assert tie_prompt(active) == [PROGRAM, PITCH + 60, TIE]
    notes = decode_chunk([*tie_prompt(active), VELOCITY, SHIFT + 100, PITCH + 60],
                         5, 10, active)
    assert notes == [{"instrument": "program_0", "midi": 60,
                      "onset": 4.0, "offset": 6.0}]
    assert not active


def test_omitted_tie_closes_note_at_next_chunk_start():
    active = {(0, 60): 4.0}
    assert decode_chunk([TIE], 5, 10, active) == [
        {"instrument": "program_0", "midi": 60, "onset": 4.0, "offset": 5.0}
    ]
    assert not active


def test_recorded_first_chord_has_explicit_two_point_five_two_second_offset():
    recorded = [1134, 54, 1135, 1133, 1080, 1084, 1087, 1301, 80, 1307,
                154, 1303, 1307, 180, 1307, 255, 1132, 1080, 1084, 1087]
    actual = decode_chunk(recorded, 0, 5, {})
    assert [note for note in actual if note["instrument"] == "program_0"] == [
        {"instrument": "program_0", "midi": pitch, "onset": 0.51, "offset": 2.52}
        for pitch in (76, 80, 83)
    ]
