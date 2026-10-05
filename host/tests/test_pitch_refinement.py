import os
from pathlib import Path
from xml.etree import ElementTree as ET

import mido
import numpy as np
import pytest
from scipy.signal import resample_poly

from mizan.engine.audio import Audio, read_audio
from mizan.engine.models import BASIC_PITCH, checksum
from mizan.engine.output import build_song, export_midi, export_musicxml
from mizan.engine.piano import transcribe_piano
from mizan.engine.pitch_refinement import refine_pitches
from mizan.engine.vocals import transcribe_vocals
from mizan.imports import parse_midi, parse_musicxml


def vowel(cents):
    rate = 22050
    t = np.arange(rate * 2) / rate
    frequency = 440 * 2 ** ((60 - 69 + cents / 100) / 12)
    samples = sum(np.sin(2 * np.pi * frequency * t * h) / h ** 2 for h in range(1, 8))
    samples *= np.minimum(1, t / 0.04) * np.minimum(1, (2 - t) / 0.05) * 0.3
    return Audio(samples.astype(np.float32), rate)


def detected():
    return [{"midi": 60, "onset": 0.08, "offset": 1.7,
             "confidence": 0.8, "velocity": 0.7, "generated": False}]


@pytest.mark.parametrize("cents", [-50, 0, 50])
def test_sustained_harmonic_tone_and_noise_guard(cents):
    input_notes = detected()
    notes, count = refine_pitches(input_notes, vowel(cents))
    assert input_notes[0]["midi"] == 60
    assert abs((notes[0]["midi"] - 60) * 100 - cents) < 7
    assert count == int(cents != 0)
    noise = np.random.default_rng(31).normal(0, 0.15, 22050 * 2).astype(np.float32)
    assert refine_pitches(input_notes, Audio(noise, 22050))[0][0]["midi"] == 60
    t = np.arange(22050 * 2) / 22050
    kick = (np.sin(2 * np.pi * (90 * t + 55 * 0.07 * (1 - np.exp(-t / 0.07))))
            * np.exp(-t * 12)).astype(np.float32)
    assert refine_pitches(input_notes, Audio(kick, 22050))[0][0]["midi"] == 60
    overlapping = [*input_notes, {**input_notes[0], "midi": 67}]
    assert [n["midi"] for n in refine_pitches(overlapping, vowel(cents))[0]] == [60, 67]


def test_no_single_fft_or_pedal_tail_shift():
    short = [{**detected()[0], "offset": 0.35}]
    assert refine_pitches(short, vowel(50))[0][0]["midi"] == 60
    rate = 22050
    t = np.arange(rate * 2) / rate
    pitched = np.sin(2 * np.pi * 440 * 2 ** ((60 - 69 + 0.5) / 12) * t).astype(np.float32)
    assert refine_pitches(detected(), Audio(pitched, rate))[0][0]["midi"] == 60


@pytest.mark.parametrize("cents", [-6, 6])
def test_near_twelve_tet_tuning_noise_stays_on_detected_semitone(cents):
    notes, count = refine_pitches(detected(), vowel(cents))
    assert notes[0]["midi"] == 60 and count == 0


@pytest.mark.parametrize("cents", [-50, 0, 50])
def test_pinned_cc0_recorded_piano_stable_harmonic_pitch(cents):
    directory = os.environ.get("MIZAN_CC0_SAMPLES")
    if not directory:
        pytest.skip("Set MIZAN_CC0_SAMPLES to the checksum-pinned CC0 recorded piano samples.")
    sample = next(Path(directory).glob("GPiano_sus_B4_v3_rr1_Player.wav"))
    source = read_audio(sample).resampled(22050)
    ratio = round(10000 * 2 ** (cents / 1200))
    shifted = resample_poly(source.samples[:2 * 22050], 10000, ratio)
    note = {**detected()[0], "midi": 71, "onset": 0.05, "offset": 1.45}
    notes, count = refine_pitches([note], Audio(shifted, 22050))
    assert abs((notes[0]["midi"] - 71) * 100 - cents) < 8
    assert count == int(cents != 0)


def test_pinned_cc0_actual_detector_does_not_fabricate_octave_fix(monkeypatch):
    directory, path = os.environ.get("MIZAN_CC0_SAMPLES"), os.environ.get("MIZAN_TEST_MODEL")
    if not directory or not path:
        pytest.skip("Set MIZAN_CC0_SAMPLES and MIZAN_TEST_MODEL for recorded-audio model integration.")
    model = Path(path)
    assert checksum(model) == BASIC_PITCH["sha256"]
    monkeypatch.setattr("mizan.engine.piano.ensure_model", lambda **kwargs: model)
    monkeypatch.setenv("MIZAN_PROVIDER", "cpu")
    recorded = read_audio(next(Path(directory).glob("GPiano_sus_B4_v3_rr1_Player.wav"))).resampled(22050)
    notes, details = transcribe_piano(Audio(recorded.samples[:2 * 22050], 22050))
    assert notes[0]["midi"] == 83  # Known Basic Pitch octave error: the recording is B4 (71).
    assert details["pitchRefinement"]["refinedNotes"] == 0


@pytest.mark.parametrize("cents", [-35, 0, 35])
def test_piano_model_refines_unambiguous_detected_tone(monkeypatch, cents):
    path = os.environ.get("MIZAN_TEST_MODEL")
    if not path:
        pytest.skip("Set MIZAN_TEST_MODEL to pinned Basic Pitch for piano integration.")
    model = Path(path)
    assert checksum(model) == BASIC_PITCH["sha256"]
    monkeypatch.setattr("mizan.engine.piano.ensure_model", lambda **kwargs: model)
    monkeypatch.setenv("MIZAN_PROVIDER", "cpu")
    notes, details = transcribe_piano(vowel(cents))
    assert len(notes) == 1
    assert abs((notes[0]["midi"] - 60) * 100 - cents) < 7
    assert details["pitchRefinement"]["refinedNotes"] == int(cents != 0)


@pytest.mark.parametrize("cents", [-50, 0, 50])
def test_cached_model_to_song_notation_and_midi(tmp_path, monkeypatch, cents):
    path = os.environ.get("MIZAN_TEST_MODEL")
    if not path:
        pytest.skip("Set MIZAN_TEST_MODEL to pinned Basic Pitch for full model integration.")
    model = Path(path)
    assert checksum(model) == BASIC_PITCH["sha256"]
    monkeypatch.setattr("mizan.engine.piano.ensure_model", lambda **kwargs: model)
    monkeypatch.setenv("MIZAN_PROVIDER", "cpu")
    notes, details = transcribe_vocals(vowel(cents))
    assert len(notes) == 1
    assert abs((notes[0]["midi"] - 60) * 100 - cents) < 7
    assert details["pitchRefinement"]["refinedNotes"] == int(cents != 0)
    harmony = {
        "bpm": 120, "bars": 1, "beatsPerBar": 4, "timing": {"phaseSeconds": 0},
        "key": {"name": "C major"}, "sections": [], "chords": [], "sectionEnergy": [],
        "warnings": [],
    }
    song = build_song("Test", "recording", 2, harmony, [], [], {}, vocals=notes)
    assert song["vocals"][0]["midi"] == notes[0]["midi"]
    assert song["key"]["name"] == "C major"
    export_musicxml(song, tmp_path / "score.musicxml")
    export_midi(song, tmp_path / "score.mid")
    alter = ET.parse(tmp_path / "score.musicxml").find(".//part[@id='vocals']//pitch/alter")
    _, _, _, _, xml_parts = parse_musicxml((tmp_path / "score.musicxml").read_bytes(), ".musicxml")
    _, _, _, _, midi_parts = parse_midi((tmp_path / "score.mid").read_bytes())
    assert xml_parts[0]["notes"][0]["midi"] == pytest.approx(notes[0]["midi"], abs=0.001)
    assert midi_parts[0]["notes"][0]["midi"] == pytest.approx(notes[0]["midi"], abs=0.001)
    if cents:
        assert alter is not None and not float(alter.text).is_integer()
        assert any(msg.type == "pitchwheel" and msg.pitch != 0
                   for track in mido.MidiFile(tmp_path / "score.mid").tracks for msg in track)
    else:
        assert alter is None
