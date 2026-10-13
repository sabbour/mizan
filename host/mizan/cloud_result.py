"""Provider-independent validation for shared cloud worker results."""

import hashlib
import math
import re
from pathlib import Path

MAX_AUDIO_BYTES = 250 * 1024 * 1024
MAX_WORKER_ERROR_BYTES = 64 * 1024
STEMS = ("drums", "bass", "other", "vocals", "guitar", "piano")
WORKER_ERROR_STAGES = {
    "startup", "credentials", "storage", "download", "separate",
    "transcribe", "upload_stems", "upload_result",
}


def validate_events(raw, duration: float, *, error_type=ValueError) -> list[dict]:
    if not isinstance(raw, list) or len(raw) > 500_000:
        raise error_type("Cloud returned an invalid note list.")
    for event in raw:
        if (not isinstance(event, dict)
                or not isinstance(event.get("instrument"), str)
                or not 0 < len(event["instrument"]) <= 100
                or type(event.get("midi")) is not int or not 0 <= event["midi"] <= 127
                or any(type(event.get(key)) not in (int, float) or not math.isfinite(event[key])
                       for key in ("onset", "offset"))
                or not 0 <= event["onset"] <= event["offset"] <= duration + 10):
            raise error_type("Cloud returned an invalid note event.")
    return raw


def materialize(manifest: dict, transport, names: list[str], recording: Path,
                directory: Path, model: str, *, error_type=ValueError) -> dict:
    from .engine.audio import read_audio
    from .engine.models import HTDEMUCS_6S
    from .engine.muscriptor import (
        EOS_CHUNK_SECONDS, EOS_TOKEN_LIMIT, MAX_DECODING_ERROR_DETAILS, MODELS, format_events,
    )

    if not isinstance(manifest, dict):
        raise error_type("Cloud returned an invalid result manifest.")
    source = manifest.get("input")
    with recording.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if (not isinstance(source, dict) or source.get("blob") != names[0]
            or source.get("bytes") != recording.stat().st_size or source.get("sha256") != digest):
        raise error_type("Cloud output does not match the uploaded recording.")
    audio = read_audio(recording)
    prefix = names[0].removesuffix("/input.wav")
    separation = manifest.get("separation")
    if (manifest.get("model") != model or manifest.get("modelVersion") != MODELS[model]["sha256"]
            or manifest.get("provider") != "PyTorch CUDA"
            or not isinstance(separation, dict)
            or separation.get("method") != "htdemucs-6s-onnx"
            or separation.get("model") != HTDEMUCS_6S["id"]
            or separation.get("modelVersion") != HTDEMUCS_6S["version"]
            or separation.get("provider") != "CUDAExecutionProvider"
            or separation.get("sampleRate") != audio.rate
            or separation.get("samples") != len(audio.samples)
            or separation.get("channels") != (1 if audio.samples.ndim == 1 else audio.samples.shape[1])):
        raise error_type("Cloud result did not come from the pinned CUDA models.")
    stems = manifest.get("stems")
    if not isinstance(stems, dict) or set(stems) != set(STEMS):
        raise error_type("Cloud did not return all six separated stems.")
    channels = 1 if audio.samples.ndim == 1 else audio.samples.shape[1]
    download = getattr(transport, "download", None) or transport._get
    for name in STEMS:
        info = stems[name]
        expected = f"{prefix}/result/stems/{name}.wav"
        if (not isinstance(info, dict) or info.get("blob") != expected
                or type(info.get("bytes")) is not int or not 44 <= info["bytes"] <= MAX_AUDIO_BYTES
                or not isinstance(info.get("sha256"), str)
                or not re.fullmatch(r"[a-f0-9]{64}", info["sha256"])
                or info.get("sampleRate") != audio.rate
                or info.get("samples") != len(audio.samples)
                or info.get("channels") != channels):
            raise error_type(f"Cloud {name} stem metadata is invalid.")
        path = directory / f"{name}.wav"
        size, digest = download(expected, path, limit=MAX_AUDIO_BYTES)
        if size != info["bytes"] or digest != info["sha256"]:
            raise error_type(f"Cloud {name} stem checksum or size did not match.")
        stem = read_audio(path)
        if stem.rate != audio.rate or stem.samples.shape != audio.samples.shape:
            raise error_type(f"Cloud {name} stem does not match the original audio.")
    decoding_errors = None
    if "decodingErrors" in manifest:
        raw_errors = manifest["decodingErrors"]
        inputs = {"mix"} | ({"vocals"} if "vocalEvents" in manifest else set())
        max_chunks = math.ceil(audio.duration / EOS_CHUNK_SECONDS)
        if not isinstance(raw_errors, dict) or set(raw_errors) != inputs:
            raise error_type("Cloud returned invalid transcription decoding error metadata.")
        by_input, error_details = {}, []
        for input_name in ("mix", "vocals"):
            if input_name not in inputs:
                continue
            item = raw_errors[input_name]
            if (not isinstance(item, dict) or set(item) != {"count", "details"}
                    or type(item["count"]) is not int or not 0 <= item["count"] <= max_chunks
                    or not isinstance(item["details"], list)
                    or len(item["details"]) != min(item["count"], MAX_DECODING_ERROR_DETAILS)):
                raise error_type("Cloud returned invalid transcription decoding error metadata.")
            by_input[input_name] = item["count"]
            for detail in item["details"]:
                if (not isinstance(detail, dict) or set(detail) != {"chunk", "seekSeconds", "tokenLimit"}
                        or type(detail["chunk"]) is not int
                        or not 0 <= detail["chunk"] < max_chunks
                        or type(detail["seekSeconds"]) not in (int, float)
                        or not math.isfinite(detail["seekSeconds"])
                        or not 0 <= detail["seekSeconds"] <= audio.duration
                        or type(detail["tokenLimit"]) is not int
                        or detail["tokenLimit"] != EOS_TOKEN_LIMIT):
                    raise error_type("Cloud returned invalid transcription decoding error metadata.")
                error_details.append({"input": input_name, "category": "eos_token_limit",
                                      **detail})
        count = sum(by_input.values())
        decoding_errors = {
            "count": count, "byInput": by_input, "details": error_details,
            "detailsTruncated": count > len(error_details),
        }
    result = {
        "separation": {
            "method": "htdemucs-6s-onnx", "model": HTDEMUCS_6S,
            "provider": {"effectiveProviders": ["CUDAExecutionProvider"]},
            "sampleRate": audio.rate, "samples": len(audio.samples), "latencySamples": 0,
            "warnings": ["HT-Demucs 6s can leak or artifact piano; transcription confidence remains a draft."],
        },
        "mix": format_events(model, validate_events(
            manifest.get("events"), audio.duration, error_type=error_type),
            audio.duration, provider="PyTorch CUDA"),
        "vocals": format_events(model, validate_events(
            manifest.get("vocalEvents"), audio.duration, error_type=error_type),
            audio.duration, provider="PyTorch CUDA"),
    }
    if decoding_errors is not None:
        result["decodingErrors"] = decoding_errors
    return result


def validate_worker_error(payload: object, run_id: str) -> dict | None:
    if (not isinstance(payload, dict) or type(payload.get("schemaVersion")) is not int
            or payload.get("schemaVersion") != 1
            or payload.get("kind") != "mizan-worker-error"
            or payload.get("status") != "failed" or payload.get("runId") != run_id
            or payload.get("stage") not in WORKER_ERROR_STAGES):
        return None
    error = payload.get("error")
    if not isinstance(error, dict):
        return None
    category, message, frames = error.get("category"), error.get("message"), error.get("frames")
    if (not isinstance(category, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", category)
            or not isinstance(message, str) or not message or len(message) > 512
            or not isinstance(frames, list) or len(frames) > 4):
        return None
    diagnostics = error.get("diagnostics")
    if category == "TranscriptionLimitError":
        if (not isinstance(diagnostics, dict)
                or set(diagnostics) != {"chunk", "seekSeconds", "tokenLimit"}
                or not isinstance(diagnostics.get("chunk"), int)
                or isinstance(diagnostics.get("chunk"), bool)
                or not 0 <= diagnostics["chunk"] <= 999_999
                or not isinstance(diagnostics.get("seekSeconds"), (int, float))
                or isinstance(diagnostics.get("seekSeconds"), bool)
                or not math.isfinite(diagnostics["seekSeconds"])
                or not 0 <= diagnostics["seekSeconds"] <= 99_999_999.999
                or not isinstance(diagnostics.get("tokenLimit"), int)
                or isinstance(diagnostics.get("tokenLimit"), bool)
                or not 1 <= diagnostics["tokenLimit"] <= 999_999):
            return None
    elif diagnostics is not None:
        return None
    safe_frames = []
    for frame in frames:
        if not isinstance(frame, dict):
            return None
        filename, function, line = frame.get("file"), frame.get("function"), frame.get("line")
        if (not isinstance(filename, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", filename)
                or not isinstance(function, str) or not re.fullmatch(r"[A-Za-z0-9_.<>-]{1,100}", function)
                or not isinstance(line, int) or isinstance(line, bool) or not 1 <= line <= 1_000_000):
            return None
        safe_frames.append({"file": filename, "function": function, "line": line})
    message = re.sub(r"https?://\S+", "[redacted URL]", message)
    message = re.sub(
        r"(?i)\b(?:bearer|hf[_-]?token|token|access[_-]?token|sig|sas|authorization|accountkey|"
        r"sharedkey|aws_access_key_id|aws_secret_access_key|aws_session_token|private_key)\b"
        r"\s*[=:]?\s*\S+", "[redacted secret]", message)
    message = re.sub(
        r"(?:[A-Za-z]:\\|\.aca-job[\\/]|/)(?:[^\s:\\/]+[\\/])*[^\s:\\/]+",
        "[redacted path]", message)
    result = {"stage": payload["stage"], "category": category,
              "message": message, "frames": safe_frames}
    if diagnostics is not None:
        result["diagnostics"] = diagnostics
    return result
