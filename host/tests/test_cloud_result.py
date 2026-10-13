import hashlib
import json
import shutil
from pathlib import Path
from threading import Event

import numpy as np
import pytest

from mizan import azure_cloud as cloud
from mizan.cloud_transport import STEMS
from mizan.engine.audio import Audio, write_audio
from mizan.engine.models import HTDEMUCS_6S
from mizan.engine.muscriptor import MODELS


def cloud_fixture(tmp_path):
    audio = Audio(np.zeros((8000, 2), dtype=np.float32), 8000)
    recording = tmp_path / "original.wav"
    write_audio(recording, audio)
    source = tmp_path / "source"
    source.mkdir()
    names = ["jobs/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/input.wav",
             "jobs/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/result.json",
             *(f"jobs/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/result/stems/{stem}.wav" for stem in STEMS)]
    metadata = {}
    for name in STEMS:
        path = source / f"{name}.wav"
        write_audio(path, audio)
        data = path.read_bytes()
        metadata[name] = {"blob": names[STEMS.index(name) + 2], "sha256": hashlib.sha256(data).hexdigest(),
                          "bytes": len(data), "sampleRate": 8000, "samples": 8000, "channels": 2}
    manifest = {
        "model": "muscriptor-small", "modelVersion": MODELS["muscriptor-small"]["sha256"],
        "input": {"blob": names[0], "bytes": recording.stat().st_size,
                  "sha256": hashlib.sha256(recording.read_bytes()).hexdigest()},
        "provider": "PyTorch CUDA", "events": [
            {"instrument": "acoustic_piano", "midi": 60, "onset": 0.25, "offset": 0.5}],
        "vocalEvents": [{"instrument": "voice", "midi": 62, "onset": 0.25, "offset": 0.5}],
        "decodingErrors": {
            "mix": {"count": 0, "details": []},
            "vocals": {"count": 0, "details": []},
        },
        "separation": {"method": "htdemucs-6s-onnx", "model": HTDEMUCS_6S["id"],
                       "modelVersion": HTDEMUCS_6S["version"],
                       "provider": "CUDAExecutionProvider", "sampleRate": 8000,
                       "samples": 8000, "channels": 2},
        "stems": metadata,
    }

    class Transport:
        def download(self, blob: str, target: Path, *, limit: int):
            assert blob in names and limit > 0
            data = (source / Path(blob).name).read_bytes()
            shutil.copy(source / Path(blob).name, target)
            return len(data), hashlib.sha256(data).hexdigest()

    return manifest, Transport(), names, recording


def test_gpu_result_validates_six_stems_and_scores_mix_and_vocals(tmp_path):
    manifest, transport, names, recording = cloud_fixture(tmp_path)
    result = cloud._materialize(manifest, transport, names, recording, tmp_path, "muscriptor-small")
    assert result["separation"]["provider"]["effectiveProviders"] == ["CUDAExecutionProvider"]
    assert result["mix"][0][0]["midi"] == 60
    assert result["vocals"][3][0]["instrument"] == "voice"
    assert result["decodingErrors"] == {
        "count": 0, "byInput": {"mix": 0, "vocals": 0},
        "details": [], "detailsTruncated": False,
    }
    assert all((tmp_path / f"{stem}.wav").is_file() for stem in STEMS)


def test_gpu_result_preserves_per_input_decoding_error_counts(tmp_path):
    manifest, transport, names, recording = cloud_fixture(tmp_path)
    manifest["decodingErrors"] = {
        "mix": {"count": 1, "details": [
            {"chunk": 0, "seekSeconds": 0.0, "tokenLimit": 2000},
        ]},
        "vocals": {"count": 1, "details": [
            {"chunk": 0, "seekSeconds": 0.0, "tokenLimit": 2000},
        ]},
    }

    result = cloud._materialize(manifest, transport, names, recording, tmp_path, "muscriptor-small")

    assert result["decodingErrors"] == {
        "count": 2, "byInput": {"mix": 1, "vocals": 1},
        "details": [
            {"input": "mix", "category": "eos_token_limit",
             "chunk": 0, "seekSeconds": 0.0, "tokenLimit": 2000},
            {"input": "vocals", "category": "eos_token_limit",
             "chunk": 0, "seekSeconds": 0.0, "tokenLimit": 2000},
        ],
        "detailsTruncated": False,
    }


def test_legacy_cloud_manifest_has_unknown_decoding_count(tmp_path):
    manifest, transport, names, recording = cloud_fixture(tmp_path)
    del manifest["decodingErrors"]

    result = cloud._materialize(manifest, transport, names, recording, tmp_path, "muscriptor-small")

    assert "decodingErrors" not in result


@pytest.mark.parametrize("change", ["missing-stem", "wrong-hash", "cpu-provider", "invalid-note", "wrong-input"])
def test_gpu_result_rejects_partial_or_untrusted_output(tmp_path, change):
    manifest, transport, names, recording = cloud_fixture(tmp_path)
    if change == "missing-stem":
        del manifest["stems"]["piano"]
    elif change == "wrong-hash":
        manifest["stems"]["bass"]["sha256"] = "0" * 64
    elif change == "cpu-provider":
        manifest["separation"]["provider"] = "CPUExecutionProvider"
    elif change == "wrong-input":
        manifest["input"]["sha256"] = "0" * 64
    else:
        manifest["events"][0]["onset"] = float("nan")
    with pytest.raises(cloud.CloudError):
        cloud._materialize(manifest, transport, names, recording, tmp_path, "muscriptor-small")


@pytest.mark.parametrize("count,details", [
    (True, []),
    (-1, []),
    (2, [{"chunk": 0, "seekSeconds": 0.0, "tokenLimit": 2000}]),
    (1, [{"chunk": 0, "seekSeconds": float("nan"), "tokenLimit": 2000}]),
    (1, [{"chunk": 0, "seekSeconds": 0.0, "tokenLimit": 1999}]),
])
def test_gpu_result_rejects_invalid_decoding_error_metadata(tmp_path, count, details):
    manifest, transport, names, recording = cloud_fixture(tmp_path)
    manifest["decodingErrors"]["mix"] = {"count": count, "details": details}

    with pytest.raises(cloud.CloudError, match="decoding error metadata"):
        cloud._materialize(manifest, transport, names, recording, tmp_path, "muscriptor-small")


def test_invalid_gpu_manifest_removes_uploaded_files(monkeypatch, tmp_path):
    manifest, _, names, recording = cloud_fixture(tmp_path)
    del manifest["stems"]["piano"]
    removed = []

    class Transport:
        def __init__(self, config):
            assert config == {"pilot": "approved", "userObjectId": "user-oid"}

        def run(self, *args):
            return manifest, names

        def delete(self, blobs):
            removed.append(blobs)

    monkeypatch.setattr(cloud, "_setting",
                        lambda key: json.dumps({"pilot": "approved", "userObjectId": "user-oid"}))
    monkeypatch.setattr(cloud, "_validate", lambda config: config)
    monkeypatch.setattr("mizan.cloud_transport.CloudTransport", Transport)
    with pytest.raises(cloud.CloudError, match="six separated stems"):
        cloud.offload(recording, tmp_path, "muscriptor-small", Event(), lambda *args: None)
    assert removed == [names]
