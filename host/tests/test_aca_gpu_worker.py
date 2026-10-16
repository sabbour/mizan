import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
from types import ModuleType, SimpleNamespace
import warnings

import numpy as np
import pytest
from scipy.io import wavfile

WORKER = Path(__file__).resolve().parents[1] / "mizan" / "cloud_worker" / "worker.py"
DOCKERFILE = WORKER.with_name("Dockerfile")
spec = importlib.util.spec_from_file_location("aca_gpu_worker", WORKER)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def test_onnx_runtime_pin_matches_cuda_12_4_base():
    image = DOCKERFILE.read_text(encoding="utf-8")
    assert "pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime" in image
    assert "onnxruntime-gpu==1.20.2" in image
    assert all(f"nvidia/{library}/lib:" in image for library in
               ("cublas", "cudnn", "cuda_nvrtc", "curand", "cufft", "cuda_runtime"))
    assert "libonnxruntime_providers_cuda.so" in image
    assert "['ldd', str(provider)]" in image and "'not found'" in image


def container_storage():
    """Load storage.py as the top-level module the container's /app/worker.py imports."""
    storage_spec = importlib.util.spec_from_file_location("storage", WORKER.with_name("storage.py"))
    module = importlib.util.module_from_spec(storage_spec)
    storage_spec.loader.exec_module(module)
    return module


def test_container_layout_ships_storage_beside_worker():
    image = DOCKERFILE.read_text(encoding="utf-8")
    assert "COPY worker.py /app/worker.py" in image
    assert "COPY storage.py /app/storage.py" in image
    assert 'ENTRYPOINT ["python", "/app/worker.py"]' in image
    assert not worker.__package__


@pytest.fixture
def workdir(monkeypatch):
    monkeypatch.setitem(sys.modules, "storage", container_storage())
    work = Path(__file__).resolve().parent / ".aca-worker-test"
    work.mkdir()
    previous = Path.cwd()
    os.chdir(work)
    try:
        yield work
    finally:
        os.chdir(previous)
        shutil.rmtree(work)


def test_cuda_worker_downloads_pinned_weights_and_emits_original_events(monkeypatch, workdir):
    model_name = "muscriptor-small"
    digest = "0" * 64
    weights = workdir / "model.safetensors"
    weights.write_bytes(b"test weights")
    (workdir / "config.json").write_text("{}")
    monkeypatch.setitem(worker.MODELS, model_name, ("revision", digest, weights.stat().st_size))
    monkeypatch.setattr(worker.hashlib, "file_digest", lambda *_: SimpleNamespace(hexdigest=lambda: digest))
    downloads = []

    def download(repo, filename, *, revision, token):
        downloads.append((repo, filename, revision, token))
        return str(workdir / filename)

    class Model:
        fail_eos = False
        eos_warnings = 0

        @classmethod
        def load_model(cls, path, *, device):
            assert path == weights and device == "cuda"
            return cls()

        def transcribe(self, source, **options):
            assert source in (str(weights), str(workdir / "vocals.wav"))
            assert options == {"cfg_coef": 1.0, "no_eos_is_ok": True}
            for _ in range(self.eos_warnings):
                warnings.warn("chunk 10 (seek=50.0s) did not emit EOS within 2000 tokens",
                              RuntimeWarning, stacklevel=2)
            yield SimpleNamespace(index=4, start_time=0.2,
                                  instrument="voice" if source.endswith("vocals.wav") else "organ", pitch=60)
            yield SimpleNamespace(start_event_index=4, end_time=0.6)
            if self.fail_eos:
                raise RuntimeError(
                    "chunk 10 (seek=50.0s) did not emit EOS within 2000 tokens "
                    "(this is only raised under --strict-eos)")

    torch = ModuleType("torch")
    torch.cuda = SimpleNamespace(is_available=lambda: True)
    torch.inference_mode = lambda: __import__("contextlib").nullcontext()
    hub = ModuleType("huggingface_hub")
    hub.hf_hub_download = download
    muscriptor = ModuleType("muscriptor")
    muscriptor.TranscriptionModel = Model
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub)
    monkeypatch.setitem(sys.modules, "muscriptor", muscriptor)

    result = worker.transcribe(weights, model_name, "test-token")
    assert result == {"model": model_name, "modelVersion": digest,
                      "provider": "PyTorch CUDA",
                      "events": [{"instrument": "organ", "midi": 60, "onset": 0.2, "offset": 0.6}],
                      "decodingErrors": {"mix": {"count": 0, "details": []}}}
    assert downloads == [
        ("MuScriptor/muscriptor-small", "config.json", "revision", "test-token"),
        ("MuScriptor/muscriptor-small", "model.safetensors", "revision", "test-token"),
    ]
    (workdir / "vocals.wav").write_bytes(b"RIFF")
    vocal = worker.transcribe(weights, model_name, "test-token", vocal_source=workdir / "vocals.wav")
    assert vocal["vocalEvents"] == [
        {"instrument": "voice", "midi": 60, "onset": 0.2, "offset": 0.6}]
    Model.eos_warnings = 2
    both_streams = worker.transcribe(weights, model_name, "test-token",
                                     vocal_source=workdir / "vocals.wav")
    assert both_streams["decodingErrors"] == {
        "mix": {"count": 2, "details": [
            {"chunk": 10, "seekSeconds": 50.0, "tokenLimit": 2000},
            {"chunk": 10, "seekSeconds": 50.0, "tokenLimit": 2000},
        ]},
        "vocals": {"count": 2, "details": [
            {"chunk": 10, "seekSeconds": 50.0, "tokenLimit": 2000},
            {"chunk": 10, "seekSeconds": 50.0, "tokenLimit": 2000},
        ]},
    }
    assert both_streams["events"] and both_streams["vocalEvents"]
    Model.fail_eos = True
    with pytest.raises(RuntimeError, match="chunk 10.*2000 tokens"):
        worker.transcribe(weights, model_name, "test-token")
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    with pytest.raises(RuntimeError, match="No CUDA GPU"):
        worker.transcribe(weights, model_name, "test-token")


def fake_ort(monkeypatch, *, providers=("CUDAExecutionProvider",), bad_shape=False):
    calls = []
    torch = ModuleType("torch")
    torch.Tensor = type("Tensor", (), {})
    torch.cuda = SimpleNamespace(is_available=lambda: calls.append(("torch-cuda-ready",)) or True)
    monkeypatch.setitem(sys.modules, "torch", torch)
    ort = ModuleType("onnxruntime")
    ort.get_available_providers = lambda: list(providers)

    class Options:
        def add_session_config_entry(self, key, value):
            calls.append(("strict", key, value))

    class Session:
        def __init__(self, path, *, sess_options, providers):
            assert ("torch-cuda-ready",) in calls
            assert Path(path).read_bytes() == b"model"
            calls.append(("providers", providers))

        def disable_fallback(self):
            calls.append(("fallback-disabled",))

        def get_providers(self):
            return list(providers)

        def get_inputs(self):
            return [SimpleNamespace(name="mix")]

        def run(self, outputs, feeds):
            chunk = feeds["mix"]
            assert outputs is None and chunk.shape == (1, 2, worker.MODEL_SAMPLES)
            calls.append(("run",))
            if bad_shape:
                return [np.zeros((1, 2, 2, worker.MODEL_SAMPLES), dtype=np.float32)]
            return [np.stack([chunk * (index + 1) / 6 for index in range(6)], axis=1)]

    ort.SessionOptions = Options
    ort.InferenceSession = Session
    monkeypatch.setitem(sys.modules, "onnxruntime", ort)
    monkeypatch.setattr(worker, "_model", lambda path: path.write_bytes(b"model"))
    return calls


def test_six_cuda_stems_match_host_overlap_add_and_preserve_audio_shape(monkeypatch, workdir):
    calls = fake_ort(monkeypatch)
    source = workdir / "input.wav"
    samples = np.tile(np.array([[0.24, -0.24]], dtype=np.float32), (400001, 1))
    wavfile.write(source, 44100, samples)
    result = worker.separate(source, workdir)
    assert result["modelVersion"] == "49df9b6989cf2150840ea65b0bef77a2e471b678"
    assert result["provider"] == "CUDAExecutionProvider"
    assert result["sampleRate"] == 44100 and result["samples"] == 400001 and result["channels"] == 2
    assert set(result["stems"]) == set(worker.SOURCES)
    assert ("strict", "session.disable_cpu_ep_fallback", "1") in calls
    assert ("fallback-disabled",) in calls
    assert calls.index(("torch-cuda-ready",)) < calls.index(("providers", ["CUDAExecutionProvider"]))
    assert len([call for call in calls if call == ("run",)]) == 2
    for index, name in enumerate(worker.SOURCES):
        path = workdir / f"{name}.wav"
        rate, actual = wavfile.read(path)
        assert rate == 44100 and actual.shape == samples.shape
        np.testing.assert_allclose(actual, samples * (index + 1) / 6, atol=1e-6)
        metadata = result["stems"][name]
        assert metadata["sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
        assert metadata["bytes"] == path.stat().st_size
        assert metadata["sampleRate"] == 44100 and metadata["samples"] == 400001


def test_mono_wav_resamples_to_model_rate_then_restores_original_alignment(monkeypatch, workdir):
    fake_ort(monkeypatch)
    source = workdir / "input.wav"
    wavfile.write(source, 22050, np.ones(8000, dtype=np.float32) * 0.12)
    result = worker.separate(source, workdir)
    assert result["sampleRate"] == 22050 and result["samples"] == 8000
    assert result["channels"] == 1
    for name in worker.SOURCES:
        rate, stem = wavfile.read(workdir / f"{name}.wav")
        assert rate == 22050 and stem.shape == (8000,)
        assert result["stems"][name]["channels"] == 1
        assert np.isfinite(stem).all()


def test_cuda_separation_rejects_cpu_or_wrong_onnx_output(monkeypatch, workdir):
    source = workdir / "input.wav"
    wavfile.write(source, 22050, np.ones(8000, dtype=np.float32) * 0.1)
    calls = fake_ort(monkeypatch, providers=("CPUExecutionProvider",))
    with pytest.raises(RuntimeError, match="CUDA provider unavailable"):
        worker.separate(source, workdir)
    assert calls == [("torch-cuda-ready",)]
    fake_ort(monkeypatch, providers=("CPUExecutionProvider", "CUDAExecutionProvider"))
    with pytest.raises(RuntimeError, match="CUDA first"):
        worker.separate(source, workdir)
    fake_ort(monkeypatch, providers=("CUDAExecutionProvider", "CPUExecutionProvider"))
    assert worker.separate(source, workdir)["provider"] == "CUDAExecutionProvider"
    fake_ort(monkeypatch, bad_shape=True)
    with pytest.raises(ValueError, match="invalid shape"):
        worker.separate(source, workdir)


def test_cuda_separation_rejects_missing_torch_gpu_before_ort_session(monkeypatch, workdir):
    calls = fake_ort(monkeypatch)
    torch = sys.modules["torch"]
    torch.cuda.is_available = lambda: False
    source = workdir / "input.wav"
    wavfile.write(source, 22050, np.ones(8000, dtype=np.float32) * 0.1)
    with pytest.raises(RuntimeError, match="CUDA GPU unavailable"):
        worker.separate(source, workdir)
    assert not calls


def test_checkpoint_is_hash_verified_and_bounded(monkeypatch, workdir):
    class Response:
        read_once = False

        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def read(self, size):
            assert size == 256 * 1024
            if self.read_once:
                return b""
            self.read_once = True
            return b"wrong"

    response = Response()
    monkeypatch.setattr(worker.urllib.request, "urlopen", lambda url, *, timeout: response)
    assert worker.HTDEMUCS["url"].endswith("/htdemucs_6s_fp16weights.onnx")
    with pytest.raises(ValueError, match="checksum mismatch"):
        worker._model(workdir / "model.onnx")
    response.read_once = False
    monkeypatch.setitem(worker.HTDEMUCS, "sha256", hashlib.sha256(b"wrong").hexdigest())
    worker._model(workdir / "verified.onnx")
    assert (workdir / "verified.onnx").read_bytes() == b"wrong"
    response.read_once = False
    monkeypatch.setattr(worker, "MAX_MODEL_BYTES", 4)
    with pytest.raises(ValueError, match="2 GiB limit"):
        worker._model(workdir / "oversized.onnx")


def test_job_uploads_six_stems_before_original_mix_events_json(monkeypatch, workdir):
    monkeypatch.setenv("HF_TOKEN", "test-token")
    monkeypatch.setenv("AZURE_CLIENT_ID", "identity-client")
    monkeypatch.setenv("AZURE_STORAGE_BLOB_URL", "https://example.blob.core.windows.net")
    monkeypatch.setenv("AZURE_STORAGE_CONTAINER", "jobs")
    run_id = "11111111-1111-1111-1111-111111111111"
    source_blob = f"jobs/{run_id}/input.wav"
    result_blob = f"jobs/{run_id}/result.json"
    monkeypatch.setattr(sys, "argv", ["worker.py", source_blob, result_blob, "muscriptor-small"])
    wav = io.BytesIO()
    wavfile.write(wav, 44100, np.zeros((8, 2), dtype=np.float32))
    content = wav.getvalue()
    calls = []
    size = [len(content)]

    class Blob:
        def get_blob_properties(self):
            return SimpleNamespace(size=size[0])

        def download_blob(self, *, max_concurrency):
            assert max_concurrency == 1
            return SimpleNamespace(chunks=lambda: iter((content[:25], content[25:])))

    class Container:
        def get_blob_client(self, name):
            assert name == source_blob
            return Blob()

        def upload_blob(self, name, data, *, overwrite):
            calls.append((name, data.read() if hasattr(data, "read") else data, overwrite))

    azure = ModuleType("azure")
    identity = ModuleType("azure.identity")
    identity.ManagedIdentityCredential = lambda *, client_id: object()
    storage = ModuleType("azure.storage")
    blob = ModuleType("azure.storage.blob")
    blob.BlobServiceClient = lambda url, *, credential: SimpleNamespace(get_container_client=lambda name: Container())
    for name, module in (("azure", azure), ("azure.identity", identity),
                         ("azure.storage", storage), ("azure.storage.blob", blob)):
        monkeypatch.setitem(sys.modules, name, module)

    def separate(source, directory):
        stems = {}
        for name in worker.SOURCES:
            path = directory / f"{name}.wav"
            path.write_bytes(b"stem-" + name.encode())
            stems[name] = {"sha256": worker._sha256(path), "bytes": path.stat().st_size,
                           "sampleRate": 44100, "samples": 8, "channels": 2}
        return {"method": "htdemucs-6s-onnx", "model": worker.HTDEMUCS["id"],
                "modelVersion": worker.HTDEMUCS["version"],
                "provider": "CUDAExecutionProvider", "sampleRate": 44100,
                "samples": 8, "channels": 2, "stems": stems}

    monkeypatch.setattr(worker, "separate", separate)
    monkeypatch.setattr(worker, "transcribe",
                        lambda source, model, token, *, vocal_source: {
                            "model": model, "modelVersion": worker.MODELS[model][1],
                            "provider": "PyTorch CUDA", "events": [],
                            "vocalEvents": [{"instrument": "voice", "midi": 60,
                                             "onset": 0.1, "offset": 0.2}]
                            if vocal_source.name == "vocals.wav" and vocal_source.is_file() else None})
    worker.main()
    assert [name for name, _, _ in calls] == [
        *(f"jobs/{run_id}/result/stems/{stem}.wav" for stem in worker.SOURCES), result_blob]
    assert all(not overwrite for _, _, overwrite in calls)
    result = json.loads(calls[-1][1])
    assert result["events"] == [] and result["model"] == "muscriptor-small"
    assert result["vocalEvents"] == [{"instrument": "voice", "midi": 60,
                                      "onset": 0.1, "offset": 0.2}]
    assert result["input"] == {"blob": source_blob, "bytes": len(content),
                               "sha256": hashlib.sha256(content).hexdigest()}
    for name in worker.SOURCES:
        stem = result["stems"][name]
        assert stem["blob"] == f"jobs/{run_id}/result/stems/{name}.wav"
        assert stem["sampleRate"] == result["separation"]["sampleRate"]
        assert stem["sha256"] == hashlib.sha256(b"stem-" + name.encode()).hexdigest()
    assert not (workdir / ".aca-job").exists()
    size[0] = worker.MAX_AUDIO_BYTES + 1
    with pytest.raises(SystemExit) as exc:
        worker.main()
    assert exc.value.code == 1
    assert len(calls) == 8
    assert calls[-1][0] == result_blob and calls[-1][2] is True
    assert json.loads(calls[-1][1])["stage"] == "download"


@pytest.mark.parametrize("failure_stage", ["separate", "transcribe"])
@pytest.mark.parametrize("publish_fails", [False, True])
def test_worker_failure_publishes_sanitized_stage_diagnostic(
        monkeypatch, workdir, capsys, publish_fails, failure_stage):
    run_id = "22222222-2222-2222-2222-222222222222"
    source_blob = f"jobs/{run_id}/input.wav"
    result_blob = f"jobs/{run_id}/result.json"
    secret = "sensitive-hf-token"
    monkeypatch.setenv("HF_TOKEN", secret)
    monkeypatch.setenv("AZURE_CLIENT_ID", "identity-client")
    monkeypatch.setenv("AZURE_STORAGE_BLOB_URL", "https://example.blob.core.windows.net")
    monkeypatch.setenv("AZURE_STORAGE_CONTAINER", "jobs")
    monkeypatch.setattr(sys, "argv", ["worker.py", source_blob, result_blob, "muscriptor-small"])
    content = b"audio"
    uploads = []

    class Blob:
        def get_blob_properties(self):
            return SimpleNamespace(size=len(content))

        def download_blob(self, *, max_concurrency):
            assert max_concurrency == 1
            return SimpleNamespace(chunks=lambda: iter((content,)))

    class Container:
        def get_blob_client(self, name):
            assert name == source_blob
            return Blob()

        def upload_blob(self, name, data, *, overwrite):
            if publish_fails:
                raise RuntimeError(secret)
            uploads.append((name, data, overwrite))

    azure = ModuleType("azure")
    identity = ModuleType("azure.identity")
    identity.ManagedIdentityCredential = lambda *, client_id: object()
    storage = ModuleType("azure.storage")
    blob = ModuleType("azure.storage.blob")
    blob.BlobServiceClient = lambda url, *, credential: SimpleNamespace(
        get_container_client=lambda name: Container())
    for name, module in (("azure", azure), ("azure.identity", identity),
                         ("azure.storage", storage), ("azure.storage.blob", blob)):
        monkeypatch.setitem(sys.modules, name, module)

    def fail_separation(source, directory):
        raise RuntimeError(
            f"CUDA failed with Bearer {secret} at {directory / 'private.wav'} "
            "https://example.blob.core.windows.net/private")

    if failure_stage == "separate":
        monkeypatch.setattr(worker, "separate", fail_separation)
    else:
        monkeypatch.setattr(worker, "separate", lambda *_: {"stems": {}})

        def fail_transcription(*_args, **_kwargs):
            raise RuntimeError(
                "chunk 10 (seek=50.0s) did not emit EOS within 2000 tokens "
                "(this is only raised under --strict-eos)")

        monkeypatch.setattr(worker, "transcribe", fail_transcription)
    with pytest.raises(SystemExit) as exc:
        worker.main()
    assert exc.value.code == 1
    if publish_fails:
        assert uploads == []
    else:
        assert len(uploads) == 1
        assert uploads[0][0] == result_blob and uploads[0][2] is True
        envelope = json.loads(uploads[0][1])
        assert envelope["runId"] == run_id and envelope["stage"] == failure_stage
        message = envelope["error"]["message"]
        if failure_stage == "transcribe":
            assert envelope["error"]["category"] == "TranscriptionLimitError"
            assert envelope["error"]["diagnostics"] == {
                "chunk": 10, "seekSeconds": 50.0, "tokenLimit": 2000,
            }
            assert "chunk 10 near 50s" in message and "2,000 tokens" in message
            assert "no complete transcription was produced" in message
            assert "Split the recording around this passage and retry" in message
        else:
            assert envelope["error"]["category"] == "RuntimeError"
            assert "CUDA failed" in message
        assert secret not in message and "private.wav" not in message
        assert "https://" not in message and "example.blob" not in message
    assert not (workdir / ".aca-job").exists()
    stderr = capsys.readouterr().err
    assert "MIZAN_WORKER_ERROR" in stderr
    assert secret not in stderr and "private.wav" not in stderr
