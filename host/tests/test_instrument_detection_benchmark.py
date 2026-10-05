from unittest.mock import Mock, patch

import numpy as np
import pytest

from mizan.engine.audio import Audio
from mizan.engine.instrument_detection_benchmark import LABELS, YAMNET, checked_model, compare, yamnet_scores


def test_rejects_model_hash_before_inference(tmp_path):
    model = tmp_path / "yamnet.onnx"
    model.write_bytes(b"unverified")
    with pytest.raises(ValueError, match="invalid pinned YAMNet"):
        checked_model(model)


def test_audio_contract_and_explicit_class_scores():
    session = Mock()
    values = np.zeros((2, 521), np.float32)
    values[:, LABELS["piano"]] = [0.2, 0.8]
    session.run.return_value = [values]
    audio = Audio(np.ones((22050, 2), np.float32) * 0.2, 22050)
    result = yamnet_scores(session, audio)
    waveform = session.run.call_args.args[1]["waveform"]
    assert waveform.shape == (16000,) and waveform.dtype == np.float32
    assert session.run.call_args.args[0] == ["output_0"]
    assert result["scores"]["piano"]["max"] == pytest.approx(0.8)
    assert result["scores"]["piano"]["mean"] == pytest.approx(0.5)
    session.run.return_value = [np.zeros((2, 520), np.float32)]
    with pytest.raises(ValueError, match="output_0 shape"):
        yamnet_scores(session, audio)


def test_clean_references_are_labelled_negatives(tmp_path):
    from mizan.engine.real_sample_benchmark import SAMPLES

    for details in SAMPLES.values():
        (tmp_path / details["filename"]).write_bytes(b"sample")
    waveform = Audio(np.ones((22050, 2), np.float32) * 0.1, 22050)
    mock_session = Mock()
    mock_session.get_providers.return_value = ["CPUExecutionProvider"]
    stems = {"piano": waveform, "drums": waveform}
    with (patch("mizan.engine.instrument_detection_benchmark.checksum",
                side_effect=lambda path: YAMNET["sha256"] if path.name == "model.onnx" else
                next(item["sha256"] for item in SAMPLES.values() if item["filename"] == path.name)),
          patch("mizan.engine.instrument_detection_benchmark.checked_model"),
          patch("mizan.engine.instrument_detection_benchmark.read_audio", return_value=waveform),
          patch("mizan.engine.instrument_detection_benchmark.assemble_fixture",
                return_value=(waveform, waveform, waveform, None, None, None)),
          patch("mizan.engine.instrument_detection_benchmark.ort.InferenceSession",
                return_value=mock_session),
          patch("mizan.engine.instrument_detection_benchmark.yamnet_scores",
                return_value={"frames": 1, "scores": {
                    "piano": {"max": 0.5}, "drumKit": {"max": 0.25}}}),
          patch("mizan.engine.instrument_detection_benchmark.separate",
                return_value=(stems, {"method": "htdemucs-6s-onnx",
                                      "provider": {"effectiveProviders": ["CPUExecutionProvider"]}})) as separator):
        result = compare(tmp_path, tmp_path / "model.onnx", True)
        separator.return_value = (stems, {"method": "hpss-complementary-v1",
                                          "provider": {"effectiveProviders": ["CPU-DSP"]}})
        with pytest.raises(RuntimeError, match="unexpectedly fell back"):
            compare(tmp_path, tmp_path / "model.onnx", True)
    assert result["truth"]["pianoOnly"] == {"piano": True, "drums": False}
    assert result["truth"]["drumsOnly"] == {"piano": False, "drums": True}
    assert len(result["clips"]) == 3
    assert result["positiveVsAbsent"]["drums"]["absentClip"] == "pianoOnly"
    assert "precision" not in result
