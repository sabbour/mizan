"""Labelled CC0 recording checks for whether a draft score should be published."""

import os
from pathlib import Path
from threading import Event
from xml.etree import ElementTree

import mido
import numpy as np
import pytest

from mizan.api import Api
from mizan.engine.audio import Audio, read_audio, write_audio
from mizan.engine.models import HTDEMUCS_6S, checksum
from mizan.engine.pipeline import analyze_decoded
from mizan.engine.real_sample_benchmark import SAMPLES, assemble_fixture
from mizan.engine import separation
from mizan.jobs import JobRunner, JobStore


@pytest.mark.parametrize("clip,expected,withheld", [
    ("pianoOnly", {"piano"}, {"drums", "vocals"}),
    ("drumsOnly", {"drums"}, {"piano", "vocals"}),
    ("mix", {"piano", "drums"}, {"vocals"}),
    ("quietDrums", {"piano", "drums"}, {"vocals"}),
    ("quietPiano", {"piano", "drums"}, {"vocals"}),
    ("sparseDrums", {"piano", "drums"}, {"vocals"}),
])
def test_cc0_score_presence(tmp_path, monkeypatch, clip, expected, withheld):
    sample_dir = Path(os.environ.get("MIZAN_CC0_SAMPLES", ""))
    if not os.environ.get("MIZAN_CC0_SAMPLES"):
        pytest.skip("Set MIZAN_CC0_SAMPLES to the checksum-pinned CC0 sample directory.")
    model = Path(os.environ.get("LOCALAPPDATA", "")) / "Mizan" / "models" / HTDEMUCS_6S["filename"]
    if not model.is_file():
        pytest.skip("Cached HT-Demucs weights required; no model download in this test.")
    assert checksum(model) == HTDEMUCS_6S["sha256"]
    for sample in SAMPLES.values():
        path = sample_dir / sample["filename"]
        assert checksum(path) == sample["sha256"]
    clips = {name: read_audio(sample_dir / sample["filename"])
             for name, sample in SAMPLES.items()}
    mix, piano, drums, *_ = assemble_fixture(clips, chords=True)
    sparse_drums = np.zeros_like(drums.samples)
    sparse_drums[round(20.4 * drums.rate):round(21 * drums.rate)] = (
        drums.samples[round(20.4 * drums.rate):round(21 * drums.rate)])
    audio = {"mix": mix, "pianoOnly": piano, "drumsOnly": drums,
             "quietDrums": Audio(piano.samples + drums.samples * 0.1, piano.rate),
             "quietPiano": Audio(drums.samples + piano.samples * 0.1, piano.rate),
             "sparseDrums": Audio(piano.samples + sparse_drums * 0.1, piano.rate)}[clip]
    monkeypatch.setenv("MIZAN_SEPARATOR", "auto")
    monkeypatch.setenv("MIZAN_PIANO", "dsp")
    monkeypatch.setenv("MIZAN_PROVIDER", "cpu")
    monkeypatch.setattr(separation, "ensure_model", lambda *args: model)
    source = tmp_path / "input.wav"
    write_audio(source, audio)
    song = analyze_decoded(source, tmp_path, title=clip, url="fixture",
                           instrument="auto", report=lambda *args: None, cancelled=Event())
    assert song["diagnostics"]["separate"]["method"] == "htdemucs-6s-onnx"
    assert set(song["transcribedInstruments"]) == expected
    assert {track["id"] for track in song["tracks"] if track.get("group") != "creative"} == expected
    assert all(song[name] == [] for name in withheld)
    assert all((tmp_path / f"{name}.wav").exists() for name in ("piano", "drums", "vocals"))
    runner = JobRunner(JobStore())
    try:
        artifacts = {"mix": str(source), **{
            name: str(tmp_path / f"{name}.wav") for name in
            ("vocals", "piano", "guitar", "bass", "drums", "other")}}
        selectable = {stem["id"] for stem in Api(runner)._stems(artifacts, song)}
        assert {"mix", *expected} <= selectable
        assert not withheld & selectable
        assert not song["hiddenStems"].keys() & selectable
    finally:
        runner.close()
    if clip == "pianoOnly":
        assert song["stemPeakLevels"]["drums"] < 0.18
        assert "drums" in song["hiddenStems"]
        assert any("Drums recording hidden" in warning for warning in song["warnings"])
    if clip == "sparseDrums":
        assert song["stemLevels"]["drums"] < 0.08
        assert song["stemPeakLevels"]["drums"] >= 0.18
    midi_names = {message.name for track in mido.MidiFile(tmp_path / "score.mid").tracks
                  for message in track if message.type == "track_name"}
    xml_parts = {part.attrib["id"] for part in
                 ElementTree.parse(tmp_path / "score.musicxml").findall(".//score-part")}
    assert {{"piano": "Piano", "drums": "Drum kit", "vocals": "Vocal melody"}[name]
            for name in expected} <= midi_names
    assert not {{"piano": "Piano", "drums": "Drum kit", "vocals": "Vocal melody"}[name]
                for name in withheld} & midi_names
    assert not withheld & xml_parts
    if clip == "pianoOnly":
        assert song["transcriptionQuality"]["drums"]["scoreWithheld"]
        assert any("Drums: score withheld" in warning for warning in song["warnings"])
    if clip == "mix":
        assert song["transcriptionQuality"]["vocals"]["scoreWithheld"]
