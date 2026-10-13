"""Bundled CUDA HT-Demucs six-stem separation and MuScriptor worker."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import traceback
import urllib.request
import warnings
from math import gcd

MODELS = {
    "muscriptor-small": ("8c127f603b807520fa465c838e9bfee8a91ada4e",
                         "bbd482c786b895cf7d8f44185073d951adae2ebb8a66f82ca84cd1f84569549c", 411888600),
    "muscriptor-medium": ("f32236969308476e01fd3aae67357de5feb05a2d",
                          "ac80adbdf85d87231735fd948af7013441c0afced316c4e9067fd5d8a7fb97ec", 1228144472),
    "muscriptor-large": ("8809fdfbed2affa7ade94a7059e746e3880720e7",
                         "ac4eb6ea87dfc26b6ca6b954c6b967ab87ad4c7d08e078b25214f13ed051f397", 5465642136),
}
MAX_AUDIO_BYTES = 250 * 1024 * 1024
MAX_RESULT_BYTES = 32 * 1024 * 1024
MAX_MODEL_BYTES = 2 * 1024 * 1024 * 1024
MAX_STEM_BYTES = 250 * 1024 * 1024
MAX_WORKER_ERROR_BYTES = 16 * 1024
MAX_DECODING_ERROR_DETAILS = 32
EOS_CHUNK_SECONDS = 5.0
EOS_TOKEN_LIMIT = 2000
EOS_WARNING_PATTERN = (
    rf"chunk (?P<chunk>\d+) \(seek=(?P<seek>\d+(?:\.\d+)?)s\) "
    rf"did not emit EOS within {EOS_TOKEN_LIMIT} tokens")
EOS_EXCEPTION_PATTERN = EOS_WARNING_PATTERN + r"(?: \(this is only raised under --strict-eos\))?"
SOURCES = ("drums", "bass", "other", "vocals", "guitar", "piano")
MODEL_RATE = 44100
MODEL_SAMPLES = 343980
HTDEMUCS = {
    "id": "htdemucs-6s-fp16weights",
    "version": "49df9b6989cf2150840ea65b0bef77a2e471b678",
    "url": "https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/49df9b6989cf2150840ea65b0bef77a2e471b678/htdemucs_6s_fp16weights.onnx",
    "sha256": "7ce55792e2231c93fbf92de95f5fd5b3a5e6c89f7db690dfd693e8f1dce56869",
}


def _sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _decoding_errors(captured):
    count, details = 0, []
    for warning in captured:
        match = (re.fullmatch(EOS_WARNING_PATTERN, str(warning.message))
                 if warning.category is RuntimeWarning else None)
        if not match:
            warnings.showwarning(warning.message, warning.category, warning.filename,
                                 warning.lineno, line=warning.line)
            continue
        count += 1
        if len(details) < MAX_DECODING_ERROR_DETAILS:
            details.append({"chunk": int(match.group("chunk")),
                            "seekSeconds": float(match.group("seek")),
                            "tokenLimit": EOS_TOKEN_LIMIT})
    return {"count": count, "details": details}


def _run_id(result_blob: str) -> str | None:
    match = re.fullmatch(r"jobs/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/result\.json",
                         result_blob, re.IGNORECASE)
    return match.group(1).lower() if match else None


def _worker_error(exc: Exception, stage: str, run_id: str | None,
                  redactions: tuple[str, ...]) -> dict:
    message = str(exc)
    category = type(exc).__name__[:80]
    diagnostics = None
    eos_limit = re.fullmatch(
        EOS_EXCEPTION_PATTERN, message) if type(exc) is RuntimeError else None
    if eos_limit:
        chunk = int(eos_limit.group("chunk"))
        seek = float(eos_limit.group("seek"))
        tokens = EOS_TOKEN_LIMIT
        category = "TranscriptionLimitError"
        diagnostics = {"chunk": chunk, "seekSeconds": seek, "tokenLimit": tokens}
        message = (f"MuScriptor reached the strict EOS limit in chunk {chunk} near {seek:g}s "
                   f"({tokens:,} tokens); no complete transcription was produced. "
                   "Split the recording around this passage and retry.")
    for value in redactions:
        if value:
            message = message.replace(value, "[redacted]")
    message = re.sub(r"https?://\S+", "[redacted URL]", message)
    message = re.sub(
        r"(?i)\b(?:bearer|hf[_-]?token|token|access[_-]?token|sig|sas|authorization|accountkey|"
        r"sharedkey|aws_access_key_id|aws_secret_access_key|aws_session_token|private_key)\b"
        r"\s*[=:]?\s*\S+",
                     "[redacted secret]", message)
    message = re.sub(
        r"(?:[A-Za-z]:\\|\.aca-job[\\/]|/)(?:[^\s:\\/]+[\\/])*[^\s:\\/]+",
        "[redacted path]", message)
    message = " ".join(message.split())[:512] or "No safe error message was available."
    frames = []
    for frame in traceback.extract_tb(exc.__traceback__)[-4:]:
        filename = re.sub(r"[^A-Za-z0-9_.-]", "_", Path(frame.filename).name)[:100] or "unknown"
        function = re.sub(r"[^A-Za-z0-9_.<>-]", "_", frame.name)[:100] or "unknown"
        frames.append({"file": filename, "function": function, "line": frame.lineno})
    return {
        "schemaVersion": 1,
        "kind": "mizan-worker-error",
        "status": "failed",
        "runId": run_id,
        "stage": stage,
        "error": {"category": category, "message": message, "frames": frames,
                  **({"diagnostics": diagnostics} if diagnostics else {})},
    }


def _publish_worker_error(storage, result_blob: str, envelope: dict) -> None:
    payload = json.dumps(envelope, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_WORKER_ERROR_BYTES:
        envelope["error"]["message"] = "Worker error details exceeded the safe size limit."
        envelope["error"]["frames"] = []
        payload = json.dumps(envelope, allow_nan=False, separators=(",", ":")).encode("utf-8")
    print(f"MIZAN_WORKER_ERROR {payload.decode('utf-8')}", file=sys.stderr, flush=True)
    if storage is None or envelope["runId"] is None:
        return
    try:
        storage.upload_bytes(result_blob, payload, limit=MAX_WORKER_ERROR_BYTES, overwrite=True)
    except Exception as publish_error:
        print(f"MIZAN_WORKER_ERROR_ARTIFACT_UNAVAILABLE type={type(publish_error).__name__[:80]}",
              file=sys.stderr, flush=True)


def _model(path: Path) -> None:
    digest = hashlib.sha256()
    received = 0
    with urllib.request.urlopen(HTDEMUCS["url"], timeout=30) as response, path.open("wb") as output:
        while block := response.read(256 * 1024):
            received += len(block)
            if received > MAX_MODEL_BYTES:
                raise ValueError("HT-Demucs checkpoint exceeds the 2 GiB limit.")
            digest.update(block)
            output.write(block)
    if digest.hexdigest() != HTDEMUCS["sha256"]:
        raise ValueError("HT-Demucs checkpoint checksum mismatch.")


def separate(source: Path, directory: Path) -> dict:
    """Match Mizan's 343980-sample overlap/add segmentation; require CUDA for every ONNX node."""
    import numpy as np
    import torch
    import onnxruntime as ort
    from scipy.io import wavfile
    from scipy.signal import resample_poly

    # PyTorch loads the CUDA/cuDNN libraries bundled in this image before ORT dlopens its CUDA provider.
    if not torch.cuda.is_available():
        raise RuntimeError("HT-Demucs CUDA GPU unavailable; refusing CPU separation.")
    if "CUDAExecutionProvider" not in ort.get_available_providers():
        raise RuntimeError("HT-Demucs CUDA provider unavailable; refusing CPU separation.")
    rate, raw = wavfile.read(source)
    if rate < 8000 or raw.ndim not in (1, 2) or len(raw) == 0 or (
            raw.ndim == 2 and raw.shape[1] not in (1, 2)):
        raise ValueError("Input WAV must be nonempty mono/stereo PCM at 8 kHz or higher.")
    if raw.dtype == np.uint8:
        samples = (raw.astype(np.float32) - 128) / 128
    elif np.issubdtype(raw.dtype, np.integer):
        samples = raw.astype(np.float32) / (np.iinfo(raw.dtype).max + 1)
    else:
        samples = raw.astype(np.float32)
    if not np.isfinite(samples).all():
        raise ValueError("Input WAV has nonfinite samples.")
    divisor = gcd(rate, MODEL_RATE)
    source_samples = (resample_poly(samples, MODEL_RATE // divisor, rate // divisor, axis=0).astype(np.float32)
                      if rate != MODEL_RATE else samples)
    stereo = source_samples[:, None] if source_samples.ndim == 1 else source_samples
    mix = np.column_stack((stereo[:, 0], stereo[:, -1])).T
    model_path = directory / "htdemucs.onnx"
    _model(model_path)
    options = ort.SessionOptions()
    options.add_session_config_entry("session.disable_cpu_ep_fallback", "1")
    session = ort.InferenceSession(str(model_path), sess_options=options, providers=["CUDAExecutionProvider"])
    session.disable_fallback()
    providers = session.get_providers()
    if not providers or providers[0] != "CUDAExecutionProvider":
        raise RuntimeError(f"HT-Demucs session did not select CUDA first: {providers}.")
    if session.get_inputs()[0].name != "mix":
        raise ValueError("HT-Demucs checkpoint has an unexpected input signature.")
    overlap = MODEL_SAMPLES // 4
    stride = MODEL_SAMPLES - overlap
    starts = list(range(0, max(1, mix.shape[1]), stride))
    fade = np.linspace(0, 1, overlap, dtype=np.float32)
    window = np.ones(MODEL_SAMPLES, dtype=np.float32)
    window[:overlap], window[-overlap:] = fade, fade[::-1]
    output = np.zeros((len(SOURCES), 2, mix.shape[1]), dtype=np.float32)
    weight = np.zeros(mix.shape[1], dtype=np.float32)
    for index, start in enumerate(starts):
        end = min(start + MODEL_SAMPLES, mix.shape[1])
        chunk = np.pad(mix[:, start:end], ((0, 0), (0, MODEL_SAMPLES - (end - start))))
        separated = session.run(None, {"mix": chunk[None].astype(np.float32, copy=False)})[0]
        if separated.shape != (1, len(SOURCES), 2, MODEL_SAMPLES) or not np.isfinite(separated).all():
            raise ValueError("HT-Demucs CUDA output has invalid shape or nonfinite values.")
        length = end - start
        chunk_window = window.copy()
        if index == 0:
            chunk_window[:overlap] = 1
        if index == len(starts) - 1:
            chunk_window[-overlap:] = 1
        output[:, :, start:end] += separated[0, :, :, :length] * chunk_window[:length]
        weight[start:end] += chunk_window[:length]
    output /= np.maximum(weight, 1e-8)[None, None, :]
    stems = {}
    for index, name in enumerate(SOURCES):
        stem = output[index].T
        if rate != MODEL_RATE:
            stem = resample_poly(stem, rate // divisor, MODEL_RATE // divisor, axis=0).astype(np.float32)
        if len(stem) < len(samples):
            stem = np.pad(stem, ((0, len(samples) - len(stem)), (0, 0)))
        stem = stem[:len(samples)].astype(np.float32)
        if samples.ndim == 1:
            stem = stem.mean(axis=1)
        elif samples.shape[1] == 1:
            stem = stem.mean(axis=1, keepdims=True)
        if not np.isfinite(stem).all():
            raise ValueError(f"HT-Demucs {name} stem has nonfinite values.")
        filename = directory / f"{name}.wav"
        wavfile.write(filename, rate, stem)
        if filename.stat().st_size > MAX_STEM_BYTES:
            raise ValueError(f"HT-Demucs {name} stem exceeds the 250 MiB output limit.")
        stems[name] = {"sha256": _sha256(filename), "bytes": filename.stat().st_size,
                       "sampleRate": rate, "samples": len(samples),
                       "channels": 1 if samples.ndim == 1 else samples.shape[1]}
    return {"method": "htdemucs-6s-onnx", "model": HTDEMUCS["id"],
            "modelVersion": HTDEMUCS["version"], "provider": "CUDAExecutionProvider",
            "sampleRate": rate, "samples": len(samples),
            "channels": 1 if samples.ndim == 1 else samples.shape[1], "stems": stems}


def transcribe(source: Path, model_name: str, token: str, *, vocal_source: Path | None = None) -> dict:
    import torch
    from huggingface_hub import hf_hub_download
    from muscriptor import TranscriptionModel

    if model_name not in MODELS:
        raise ValueError(f"Unknown MuScriptor model: {model_name}")
    if not torch.cuda.is_available():
        raise RuntimeError("No CUDA GPU is available; refusing to run the CPU fallback.")
    revision, digest, size = MODELS[model_name]
    repo = f"MuScriptor/{model_name}"
    config = Path(hf_hub_download(repo, "config.json", revision=revision, token=token))
    weights = Path(hf_hub_download(repo, "model.safetensors", revision=revision, token=token))
    if config.parent != weights.parent or weights.stat().st_size != size:
        raise ValueError(f"{model_name} checkpoint is incomplete or its config does not match.")
    with weights.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != digest:
            raise ValueError(f"{model_name} checkpoint checksum mismatch.")
    model = TranscriptionModel.load_model(weights, device="cuda")
    def events_for(path):
        starts, events = {}, []
        captured = []
        try:
            with warnings.catch_warnings(record=True) as captured_warnings:
                captured = captured_warnings
                warnings.filterwarnings(
                    "always", message=f"^{EOS_WARNING_PATTERN}$", category=RuntimeWarning)
                with torch.inference_mode():
                    for event in model.transcribe(str(path), cfg_coef=1.0, no_eos_is_ok=True):
                        if hasattr(event, "start_time") and hasattr(event, "index"):
                            starts[event.index] = event
                        elif hasattr(event, "start_event_index"):
                            start = starts.pop(event.start_event_index)
                            onset, offset = float(start.start_time), float(event.end_time)
                            if not all(map(math.isfinite, (onset, offset))) or onset < 0 or offset < onset:
                                raise ValueError("Invalid MuScriptor note timing")
                            events.append({"instrument": start.instrument, "midi": int(start.pitch),
                                           "onset": onset, "offset": offset})
            if starts:
                raise ValueError("Unclosed MuScriptor notes")
        finally:
            decoding = _decoding_errors(captured)
        return (sorted(events, key=lambda note: (note["onset"], note["instrument"], note["midi"])),
                decoding)

    mix_events, mix_errors = events_for(source)
    decoding_errors = {"mix": mix_errors}
    result = {"model": model_name, "modelVersion": digest, "provider": "PyTorch CUDA",
              "events": mix_events, "decodingErrors": decoding_errors}
    if vocal_source is not None:
        vocal_events, vocal_errors = events_for(vocal_source)
        result["vocalEvents"] = vocal_events
        decoding_errors["vocals"] = vocal_errors
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_blob")
    parser.add_argument("result_blob")
    parser.add_argument("model", choices=MODELS)
    args = parser.parse_args()
    stage = "startup"
    run_id = _run_id(args.result_blob)
    storage = None
    workspace = Path(".aca-job")
    failed = False
    try:
        if (run_id is None or args.source_blob != f"jobs/{run_id}/input.wav"):
            raise ValueError("Provide matching jobs/{runId}/input.wav and result.json Blob names.")
        stage = "credentials"
        token = os.environ["HF_TOKEN"]
        stage = "storage"
        if __package__:
            from .storage import from_environment
        else:
            from storage import from_environment
        storage = from_environment()
        stage = "download"
        source_size = storage.size(args.source_blob)
        if not 0 < source_size <= MAX_AUDIO_BYTES:
            raise ValueError("Audio exceeds the 250 MiB Cloud worker limit.")
        workspace.mkdir()
        audio = workspace / "input.wav"
        storage.download(args.source_blob, audio, limit=MAX_AUDIO_BYTES)
        stage = "separate"
        separation = separate(audio, workspace)
        stage = "transcribe"
        result = transcribe(audio, args.model, token, vocal_source=workspace / "vocals.wav")
        stage = "upload_stems"
        stems = separation.pop("stems")
        for name, metadata in stems.items():
            key = args.result_blob[:-5] + f"/stems/{name}.wav"
            storage.upload(key, workspace / f"{name}.wav",
                           limit=MAX_STEM_BYTES, overwrite=False)
            metadata["blob"] = key
        result["input"] = {"blob": args.source_blob, "bytes": source_size, "sha256": _sha256(audio)}
        result["separation"] = separation
        result["stems"] = stems
        manifest = json.dumps(result, allow_nan=False).encode("utf-8")
        if len(manifest) > MAX_RESULT_BYTES:
            raise ValueError("Combined transcription manifest exceeds 32 MiB.")
        stage = "upload_result"
        storage.upload_bytes(args.result_blob, manifest,
                             limit=MAX_RESULT_BYTES, overwrite=False)
    except Exception as exc:
        failed = True
        envelope = _worker_error(
            exc, stage, run_id,
            (os.environ.get("HF_TOKEN", ""), os.environ.get("AZURE_STORAGE_BLOB_URL", ""),
             os.environ.get("AZURE_CLIENT_ID", ""), os.environ.get("AWS_ACCESS_KEY_ID", ""),
             os.environ.get("AWS_SECRET_ACCESS_KEY", ""), os.environ.get("AWS_SESSION_TOKEN", ""),
             os.environ.get("S3_ENDPOINT_URL", ""), args.source_blob, args.result_blob),
        )
        _publish_worker_error(storage, args.result_blob, envelope)
        sys.tracebacklimit = 0
        raise SystemExit(1) from None
    finally:
        if workspace.exists():
            try:
                shutil.rmtree(workspace)
            except OSError:
                if failed:
                    print("MIZAN_WORKER_CLEANUP_FAILED", file=sys.stderr, flush=True)
                else:
                    raise


if __name__ == "__main__":
    main()
