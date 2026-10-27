"""Pinned official MuScriptor CPU models for production jobs."""

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from threading import Event, Lock, Thread
import time
import urllib.error
import urllib.request
import warnings
from urllib.parse import urlsplit

import numpy as np

from ..errors import InvalidTranscriptionModel, MizanError, ModelFailed, ModelUnavailable
from ..paths import app_dir
from .audio import Audio
from .drums import GM_LANES
from .providers import check_cancel

MODELS = {
    "muscriptor-small": {
        "parameters": "103M",
        "revision": "8c127f603b807520fa465c838e9bfee8a91ada4e",
        "bytes": 411888600,
        "sha256": "bbd482c786b895cf7d8f44185073d951adae2ebb8a66f82ca84cd1f84569549c",
        "config": (768, 12, 14, 1393),
        "freeGiB": 6,
    },
    "muscriptor-medium": {
        "parameters": "307M",
        "revision": "f32236969308476e01fd3aae67357de5feb05a2d",
        "bytes": 1228144472,
        "sha256": "ac80adbdf85d87231735fd948af7013441c0afced316c4e9067fd5d8a7fb97ec",
        "config": (1024, 16, 24, 1395),
        "freeGiB": 10,
    },
    "muscriptor-large": {
        "parameters": "1.4B",
        "revision": "8809fdfbed2affa7ade94a7059e746e3880720e7",
        "bytes": 5465642136,
        "sha256": "ac4eb6ea87dfc26b6ca6b954c6b967ab87ad4c7d08e078b25214f13ed051f397",
        "config": (1536, 24, 48, 1395),
        "freeGiB": 20,
    },
}
MEMORY_LIMIT_GIB = {"muscriptor-small": 4, "muscriptor-medium": 8, "muscriptor-large": 16}
DOWNLOAD_SECONDS = 3600
MAX_DECODING_ERROR_DETAILS = 32
EOS_CHUNK_SECONDS = 5.0
EOS_TOKEN_LIMIT = 2000
EOS_WARNING_PATTERN = (
    rf"chunk (?P<chunk>\d+) \(seek=(?P<seek>\d+(?:\.\d+)?)s\) "
    rf"did not emit EOS within {EOS_TOKEN_LIMIT} tokens")
EOS_EXCEPTION_PATTERN = EOS_WARNING_PATTERN + r"(?: \(this is only raised under --strict-eos\))?"
_download_gate = Lock()
_state_lock = Lock()
_active: tuple[str, str] | None = None
_errors: dict[tuple[str, str], str] = {}
_speed = 0.0
_last_sample = (0.0, 0)
DRUM_LANES = GM_LANES


def _spec(model: str) -> dict:
    if not isinstance(model, str) or model not in MODELS:
        raise InvalidTranscriptionModel()
    return MODELS[model]


class _OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urlsplit(newurl)
        host = target.hostname or ""
        if target.scheme != "https" or not (host == "huggingface.co" or
                                             host.endswith(".huggingface.co") or
                                             host.endswith(".hf.co")):
            raise ModelFailed("Official checkpoint redirected outside Hugging Face; download stopped.")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None:
            redirected.remove_header("Authorization")
        return redirected


def _download_file(model: str, name: str, destination: Path, token: str, cancelled, progress=None) -> None:
    spec = _spec(model)
    limit = spec["bytes"] if name == "model.safetensors" else 65536
    address = f"https://huggingface.co/MuScriptor/{model}/resolve/{spec['revision']}/{name}"
    partial = destination.with_name(destination.name + ".partial")
    size = partial.stat().st_size if name == "model.safetensors" and partial.is_file() else 0
    if size > limit:
        partial.unlink()
        size = 0
    if size == limit and name == "model.safetensors":
        check_cancel(cancelled)
        with partial.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() == spec["sha256"]:
                check_cancel(cancelled)
                partial.replace(destination)
                return
        partial.unlink()
        size = 0
    headers = {"Authorization": f"Bearer {token}"}
    if size:
        headers["Range"] = f"bytes={size}-"
    request = urllib.request.Request(address, headers=headers)
    started = time.monotonic()
    try:
        opener = urllib.request.build_opener(_OfficialRedirect())
        with opener.open(request, timeout=45) as response:
            resumed = size > 0 and getattr(response, "status", 200) == 206
            if resumed:
                content_range = response.headers.get("Content-Range", "")
                if not content_range.startswith(f"bytes {size}-"):
                    raise ModelFailed(f"Official {model} returned an invalid resume range; retry the download.")
            else:
                size = 0
            with partial.open("ab" if resumed else "wb") as output:
                if progress:
                    progress(size / limit)
                while block := response.read(256 * 1024):
                    check_cancel(cancelled)
                    size += len(block)
                    if size > limit or time.monotonic() - started > DOWNLOAD_SECONDS:
                        raise ModelFailed(
                            f"Official {model} download exceeded its size or one-hour time limit; retry "
                            "on a faster connection or stage the checkpoint manually.")
                    output.write(block)
                    if progress:
                        progress(min(1.0, size / limit))
        if name == "model.safetensors" and size != spec["bytes"]:
            raise ModelFailed(f"Official {model} download was incomplete; retry the job.")
        if name == "config.json":
            if not size:
                raise ModelFailed(f"Official {model} config download was empty.")
            try:
                settings = json.loads(partial.read_text(encoding="utf-8"))
                if tuple(settings.get(key) for key in ("dim", "num_heads", "num_layers", "card")) != spec["config"]:
                    raise ModelFailed(f"Official {model} config does not match its pinned architecture.")
            except (ValueError, UnicodeError) as exc:
                raise ModelFailed(f"Official {model} config download was invalid; retry the job.") from exc
        else:
            with partial.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != spec["sha256"]:
                    raise ModelFailed(f"Official {model} checkpoint checksum mismatch; download stopped.")
        check_cancel(cancelled)
        partial.replace(destination)
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise ModelFailed(
                f"Official {model} checkpoint access was denied. Sign in to Hugging Face, "
                f"accept this model's terms at huggingface.co/MuScriptor/{model}, then "
                "save or refresh your Hugging Face token in Library and retry.") from None
        raise ModelFailed(f"Official {model} download returned HTTP {exc.code}; retry later.") from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ModelFailed(
            f"Official {model} download failed (network/TLS or disk). Retry later or "
            f"stage model.safetensors and config.json in {destination.parent}.") from None
    except ModelFailed as exc:
        if "checksum mismatch" in str(exc) or "invalid resume range" in str(exc):
            partial.unlink(missing_ok=True)
        raise


class ModelDownloadBusy(MizanError):
    code = "model_download_busy"
    message = "Another model is downloading. Wait for it to finish before starting this download."


def _key(model: str) -> tuple[str, str]:
    return str(app_dir("models")), model


def _record_progress(key: tuple[str, str], received: int) -> None:
    global _speed, _last_sample
    with _state_lock:
        now, previous = _last_sample
        elapsed = time.monotonic() - now
        if elapsed >= 0.5:
            _speed = max(0.0, (received - previous) / elapsed)
            _last_sample = (time.monotonic(), received)


def _release_download(key: tuple[str, str], error: str | None = None) -> None:
    global _active, _speed
    with _state_lock:
        _errors[key] = error or ""
        _active = None
        _speed = 0.0
    _download_gate.release()


def _download_assets(model: str, token: str, cancelled=None, progress=None) -> None:
    directory = app_dir("models") / model
    directory.mkdir(parents=True, exist_ok=True)
    config = directory / "config.json"
    if config.is_file() and not _valid_config(model, config):
        raise ModelFailed(f"{model} config.json is invalid or from a different model; replace it before downloading weights.")
    absent = [name for name in ("config.json", "model.safetensors")
              if not (directory / name).is_file()]
    for index, name in enumerate(absent):
        check_cancel(cancelled)
        def update(value, index=index, name=name):
            if name == "model.safetensors":
                _record_progress(_key(model), round(value * MODELS[model]["bytes"]))
            if progress:
                progress((index + value) / len(absent))
        _download_file(model, name, directory / name, token, cancelled, update)


def _valid_config(model: str, path: Path) -> bool:
    try:
        settings = json.loads(path.read_text(encoding="utf-8"))
        return tuple(settings.get(name) for name in ("dim", "num_heads", "num_layers", "card")) == MODELS[model]["config"]
    except (OSError, ValueError):
        return False


def model_download_status() -> dict[str, dict]:
    root = app_dir("models")
    with _state_lock:
        active, speed, errors = _active, _speed, dict(_errors)

    def size(path: Path) -> int:
        try:
            return path.stat().st_size
        except OSError:
            return 0

    result = {}
    for model, spec in MODELS.items():
        directory = root / model
        weights = directory / "model.safetensors"
        partial = directory / "model.safetensors.partial"
        received = size(weights) or size(partial)
        config = directory / "config.json"
        valid_config = _valid_config(model, config)
        try:
            marker = json.loads((directory / ".verified.json").read_text(encoding="utf-8"))
            verified = (marker == {
                "sha256": spec["sha256"], "bytes": spec["bytes"],
                "mtimeNs": weights.stat().st_mtime_ns,
            })
        except (OSError, ValueError):
            verified = False
        key = str(root), model
        running = key == active
        result[model] = {
            "bytesReceived": min(received, spec["bytes"]), "totalBytes": spec["bytes"],
            "downloaded": verified and valid_config and received == spec["bytes"],
            "active": running, "error": errors.get(key) or None,
            "bytesPerSecond": round(speed, 1) if running else 0.0,
        }
    return result


def start_model_download(model: str) -> None:
    global _active, _speed, _last_sample
    _spec(model)
    if model_download_status()[model]["downloaded"]:
        return
    check_model_resources(model)
    try:
        from ..hf_credentials import get_hf_token
        token = get_hf_token()
    except OSError as exc:
        raise ModelFailed("Windows Credential Manager is unavailable; restore access to the saved Hugging Face token.") from exc
    if not token:
        raise ModelFailed(
            f"Save a Hugging Face token in Library and accept MuScriptor/{model} model terms "
            "before downloading its official checkpoint.")
    if not _download_gate.acquire(blocking=False):
        raise ModelDownloadBusy()
    key = _key(model)
    partial = app_dir("models") / model / "model.safetensors.partial"
    with _state_lock:
        _active, _speed, _last_sample = key, 0.0, (
            time.monotonic(), partial.stat().st_size if partial.is_file() else 0)
        _errors.pop(key, None)

    def work():
        error = None
        try:
            _download_assets(model, token)
            require_ready(model, verify_weights=True, verify_dependencies=False)
        except MizanError as exc:
            error = str(exc)
        except Exception:
            error = f"{model} download failed unexpectedly; retry or check the host logs."
        finally:
            _release_download(key, error)

    try:
        Thread(target=work, name="mizan-model-download", daemon=True).start()
    except RuntimeError:
        _release_download(key, f"Could not start {model} download; retry.")
        raise ModelFailed(f"Could not start {model} download; retry.") from None


def prepare_model(model: str, cancelled=None, progress=None) -> None:
    """Fetch only the pinned official model, after verifying local CPU dependencies."""
    spec = _spec(model)
    directory = app_dir("models") / model
    missing = [name for name in ("torch", "muscriptor")
               if importlib.util.find_spec(name) is None]
    if missing:
        raise ModelFailed(
            f"{model} requires {', '.join(missing)} in Mizan's production Python environment. "
            f"Install the official CPU runtime; checkpoint downloads into {directory} begin only after "
            "dependencies are ready. An isolated benchmark environment does not install app dependencies.")
    if not model_download_status()[model]["downloaded"]:
        try:
            from ..hf_credentials import get_hf_token
            token = get_hf_token()
        except OSError as exc:
            raise ModelFailed("Windows Credential Manager is unavailable; restore access to the saved Hugging Face token.") from exc
        if not token:
            raise ModelFailed(
                f"Save a Hugging Face token in Library after accepting MuScriptor/{model} terms; "
                f"the official {spec['bytes'] / 1e9:.1f} GB checkpoint downloads into {directory} when a job starts.")
        while not _download_gate.acquire(timeout=0.5):
            check_cancel(cancelled)
        global _active, _speed, _last_sample
        key = _key(model)
        partial = directory / "model.safetensors.partial"
        with _state_lock:
            _active, _speed, _last_sample = key, 0.0, (
                time.monotonic(), partial.stat().st_size if partial.is_file() else 0)
            _errors.pop(key, None)
        error = None
        try:
            if not model_download_status()[model]["downloaded"]:
                _download_assets(model, token, cancelled, progress)
                require_ready(model, cancelled, verify_dependencies=False)
        except MizanError as exc:
            error = str(exc)
            raise
        except Exception as exc:
            error = f"{model} download failed unexpectedly; retry or check the host logs."
            raise ModelFailed(error) from exc
        finally:
            _release_download(key, error)
    require_ready(model, cancelled, verify_weights=False)


class _MemoryStatus(ctypes.Structure):
    _fields_ = [("dwLength", wintypes.DWORD), ("dwMemoryLoad", wintypes.DWORD),
                ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]


class _BasicLimit(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD)]


class _IOCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in
                ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                 "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class _ExtendedLimit(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", _BasicLimit), ("IoInfo", _IOCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t)]


def _assign_memory_limit(process, model: str):
    if os.name != "nt":
        return None
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise ModelFailed(f"Could not create the {model} CPU worker memory guard.")
    limits = _ExtendedLimit()
    limits.BasicLimitInformation.LimitFlags = 0x100 | 0x2000
    limits.ProcessMemoryLimit = MEMORY_LIMIT_GIB[model] * 1024 ** 3
    if (not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits))
            or not kernel.AssignProcessToJobObject(job, int(process._handle))):
        kernel.CloseHandle(job)
        raise ModelFailed(f"Could not guard the {model} CPU worker's memory; inference was not started.")
    return job


def _close_job(handle) -> None:
    if handle is not None:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle(handle)


def _memory_status() -> _MemoryStatus:
    if os.name != "nt":
        raise ModelUnavailable("MuScriptor CPU models require the Windows desktop host.")
    status = _MemoryStatus()
    status.dwLength = ctypes.sizeof(status)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(_MemoryStatus)]
    kernel.GlobalMemoryStatusEx.restype = wintypes.BOOL
    if not kernel.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise ModelUnavailable("Cannot measure available memory. Restart Mizan before choosing a CPU model.")
    return status


def _resource_issue(model: str, status: _MemoryStatus, disk_free: int | None = None,
                    remaining_download: int = 0) -> str | None:
    name = f"MuScriptor {model.rsplit('-', 1)[-1].title()}"
    minimum = _spec(model)["freeGiB"]
    free = status.ullAvailPhys / 1024 ** 3
    commit = status.ullAvailPageFile / 1024 ** 3
    smaller = " or choose a smaller MuScriptor size" if model != "muscriptor-small" else ""
    if status.ullTotalPhys < minimum * 1024 ** 3:
        return (f"{name} needs at least {minimum} GiB of RAM. "
                + ("Choose a smaller MuScriptor size." if smaller else "Audio transcription needs a PC with more RAM."))
    if free < minimum:
        return (f"{name} needs {minimum} GiB free RAM ({free:.1f} GiB available). "
                f"Close other apps{smaller}.")
    limit = MEMORY_LIMIT_GIB[model]
    if commit < limit:
        return (f"{name} needs {limit} GiB available Windows commit ({commit:.1f} GiB available). "
                "Free memory or increase the Windows paging file.")
    needed = remaining_download + 1024 ** 3 if disk_free is not None else 0
    if disk_free is not None and disk_free < needed:
        return (f"{name} needs {needed / 1024 ** 3:.1f} GiB free disk space for its checkpoint "
                f"({disk_free / 1024 ** 3:.1f} GiB available). Free space{smaller}.")
    return None


def _check_memory(model: str) -> None:
    issue = _resource_issue(model, _memory_status())
    if issue:
        raise ModelUnavailable(issue)


def model_preflight() -> dict[str, dict]:
    status = _memory_status()
    downloads = model_download_status()
    try:
        disk_free = shutil.disk_usage(app_dir("models")).free
    except OSError as exc:
        raise ModelUnavailable("Cannot measure free model storage. Check the app data drive.") from exc
    result = {}
    for model, spec in MODELS.items():
        download = downloads[model]
        remaining = max(0, spec["bytes"] - download["bytesReceived"])
        issue = _resource_issue(model, status, None if download["downloaded"] else disk_free, remaining)
        result[model] = {
            "eligible": issue is None, "reason": issue,
            "requiredRamGiB": spec["freeGiB"], "freeRamGiB": round(status.ullAvailPhys / 1024 ** 3, 1),
            "requiredCommitGiB": MEMORY_LIMIT_GIB[model],
            "freeCommitGiB": round(status.ullAvailPageFile / 1024 ** 3, 1),
        }
    return result


def check_model_resources(model: str) -> None:
    _spec(model)
    issue = model_preflight()[model]["reason"]
    if issue:
        raise ModelUnavailable(issue)

def require_ready(model: str, cancelled=None, *, verify_weights: bool = True,
                  verify_dependencies: bool = True) -> None:
    spec = _spec(model)
    check_cancel(cancelled)
    directory = app_dir("models") / model
    weights, config = directory / "model.safetensors", directory / "config.json"
    if not weights.is_file() or not config.is_file():
        try:
            from ..hf_credentials import get_hf_token
            has_token = get_hf_token() is not None
        except OSError as exc:
            raise ModelFailed(
                "Windows Credential Manager is unavailable. Restore access to the saved "
                f"Hugging Face token, or stage the official {model} checkpoint locally.") from exc
        if not has_token:
            raise ModelFailed(
                f"{model} requires the gated official checkpoint and a configured "
                f"Hugging Face token. Accept MuScriptor/{model} model terms, "
                "configure the token in Library, and retry the job to download the checkpoint.")
        raise ModelFailed(
            f"{model} checkpoint is missing. Retry the job to download the official "
            f"{spec['bytes'] / 1e9:.1f} GB checkpoint, or stage model.safetensors and config.json in {directory}.")
    try:
        if weights.stat().st_size != spec["bytes"]:
            raise ModelFailed(f"{model} checkpoint size mismatch; replace the incomplete official weights.")
    except OSError as exc:
        raise ModelFailed(f"Cannot read the staged {model} checkpoint; check local file permissions.") from exc
    try:
        settings = json.loads(config.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ModelFailed(f"{model} config.json is invalid; replace it with the official config.") from exc
    if tuple(settings.get(key) for key in ("dim", "num_heads", "num_layers", "card")) != spec["config"]:
        raise ModelFailed(f"{model} config.json does not match the official checkpoint.")
    if verify_dependencies:
        missing = [name for name in ("torch", "muscriptor")
                   if importlib.util.find_spec(name) is None]
        if missing:
            raise ModelFailed(
                f"{model} requires locally installed official CPU dependencies: {', '.join(missing)}. "
                "No model was substituted.")
    if verify_weights:
        try:
            with weights.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
        except OSError as exc:
            raise ModelFailed(f"Cannot read the staged {model} checkpoint; check local file permissions.") from exc
        check_cancel(cancelled)
        if digest != spec["sha256"]:
            raise ModelFailed(f"{model} checkpoint checksum mismatch; replace the corrupted official weights.")
        marker = directory / ".verified.json"
        temporary = directory / ".verified.partial"
        try:
            temporary.write_text(json.dumps({
                "sha256": spec["sha256"], "bytes": spec["bytes"],
                "mtimeNs": weights.stat().st_mtime_ns,
            }), encoding="utf-8")
            temporary.replace(marker)
        except OSError:
            temporary.unlink(missing_ok=True)


def _load_official_model(model: str, weights: Path):
    from muscriptor import TranscriptionModel

    if model != "muscriptor-large":
        return TranscriptionModel.load_model(weights, device="cpu")

    import muscriptor.transcription_model as official
    from safetensors.torch import load_file

    original = official.load_file

    def pread_load(path, device):
        return load_file(path, device=device, backend="pread")

    official.load_file = pread_load
    try:
        return TranscriptionModel.load_model(weights, device="cpu")
    finally:
        official.load_file = original


def format_events(model: str, events: list[dict], duration: float, *,
                  provider: str = "PyTorch CPU") -> tuple[list[dict], list[dict], dict, list[dict]]:
    spec = _spec(model)
    piano, drums = [], []
    unscored, generic = set(), set()
    for event in events:
        onset, offset, pitch = event["onset"], event["offset"], event["midi"]
        instrument = event["instrument"]
        if onset >= duration:
            unscored.add("events beyond the recording duration")
            continue
        if instrument in ("acoustic_piano", "program_0"):
            if not 21 <= pitch <= 108:
                unscored.add(f"piano pitch {pitch}")
                continue
            piano.append({
                "midi": pitch, "onset": onset, "offset": min(offset, duration),
                "velocity": 0.5, "confidence": 0.4, "generated": False,
                "sourceInstrument": instrument,
            })
        elif instrument == "drums":
            lane = DRUM_LANES.get(pitch)
            if lane is None:
                unscored.add(f"drum MIDI {pitch}")
                continue
            drums.append({
                "lane": lane, "sourceMidi": pitch, "onset": onset, "velocity": 0.5,
                "confidence": 0.4, "possibleLanes": [lane],
            })
        else:
            generic.add(instrument)
    from .piano import assign_hands

    details = {
        "method": f"{model}-pytorch-{'cuda' if provider == 'PyTorch CUDA' else 'cpu'}",
        "model": {"id": model, "version": spec["sha256"]},
        "provider": {"effectiveProviders": [provider]},
        "checkpointLoader": "safetensors-pread" if model == "muscriptor-large" else "safetensors-default",
        "input": "mix",
        "warnings": [
            f"{model} events lack velocity and calibrated confidence; neutral MIDI velocity "
            "and conservative tentative confidence are placeholders. Verify the draft against the recording.",
            *([f"Other MuScriptor labels appear as tentative original-mix pitched-note tracks, "
                f"not validated instrument scores or tablature: {', '.join(sorted(generic))}."] if generic else []),
            *([f"Unsupported drum/piano pitches or out-of-range events remain in raw modelEvents "
                f"but are omitted from draft notation: {', '.join(sorted(unscored))}."] if unscored else []),
        ],
    }
    return (assign_hands(piano), sorted(drums, key=lambda hit: hit["onset"]), details,
            sorted(events, key=lambda event: (event["onset"], event["instrument"], event["midi"])))


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


def _transcribe_inprocess(model: str, audio: Audio, cancelled=None, progress=None) -> tuple[list[dict], list[dict], dict, list[dict]]:
    """Run the official CPU model once on the original mix, retaining source event times."""
    _spec(model)
    require_ready(model, cancelled)
    _check_memory(model)
    try:
        import torch
    except (ImportError, OSError) as exc:
        raise ModelFailed(
            f"{model} CPU dependencies are incomplete in Mizan's production Python "
            "environment. Install the official package and its required runtime libraries.") from None

    check_cancel(cancelled)
    try:
        thread_limit = os.cpu_count() or 1
        torch.set_num_threads(
            thread_limit if model == "muscriptor-large" else min(12, thread_limit))
        transcriber = _load_official_model(
            model, app_dir("models") / model / "model.safetensors")
    except Exception as exc:
        raise ModelFailed(f"Could not load official {model} on CPU; check the checkpoint and local dependencies.") from exc
    check_cancel(cancelled)
    signal = np.ascontiguousarray(audio.resampled(16000).mono(), dtype=np.float32)
    starts, model_events = {}, []
    captured = []
    try:
        try:
            with warnings.catch_warnings(record=True) as captured_warnings:
                captured = captured_warnings
                warnings.filterwarnings(
                    "always", message=f"^{EOS_WARNING_PATTERN}$", category=RuntimeWarning)
                with torch.inference_mode():
                    for event in transcriber.transcribe(
                            (torch.from_numpy(signal).unsqueeze(0), 16000),
                            cfg_coef=1.0, no_eos_is_ok=True):
                        check_cancel(cancelled)
                        if hasattr(event, "completed") and hasattr(event, "total"):
                            if progress and event.total:
                                progress(event.completed / event.total)
                        elif hasattr(event, "start_time") and hasattr(event, "index"):
                            starts[event.index] = event
                        elif hasattr(event, "start_event_index"):
                            start = starts.pop(event.start_event_index)
                            onset, offset = float(start.start_time), float(event.end_time)
                            if not all(map(math.isfinite, (onset, offset))) or onset < 0 or offset < onset:
                                raise ValueError("Invalid MuScriptor note timing")
                            model_events.append({
                                "instrument": start.instrument, "midi": int(start.pitch),
                                "onset": onset, "offset": offset,
                            })
            if starts:
                raise ValueError("Unclosed MuScriptor notes")
        finally:
            decoding = _decoding_errors(captured)
    except Exception as exc:
        from ..errors import Cancelled
        if isinstance(exc, Cancelled):
            raise
        if type(exc) is RuntimeError and re.fullmatch(EOS_EXCEPTION_PATTERN, str(exc)):
            raise ModelFailed(
                f"{model} reached the 2000-token limit in a dense passage. "
                "Try another MuScriptor size or a shorter recording.") from exc
        raise ModelFailed(
            f"Official {model} CPU transcription failed. Check available RAM, "
            "the local checkpoint, and the host logs; no replacement transcription was generated.") from exc
    if progress:
        progress(1.0)
    result = format_events(model, model_events, audio.duration)
    result[2]["decodingErrors"] = decoding
    return result


def _cpu_inference_timeout_message(model: str, audio: Audio) -> str:
    message = (f"{model} CPU inference exceeded its bounded run time for this "
               f"{audio.duration / 60:.1f}-minute recording.")
    if model == "muscriptor-small":
        return f"{message} Try a shorter recording."
    return f"{message} Retry with MuScriptor Small or choose a shorter recording."


def transcribe_official(model: str, audio: Audio, cancelled=None, progress=None, *, source: Path):
    """Isolate native PyTorch faults from the host process."""
    _spec(model)
    check_cancel(cancelled)
    result = source.parent / "muscriptor-result.json"
    progress_file = source.parent / "muscriptor-progress.txt"
    error_file = source.parent / "muscriptor-error.txt"
    for path in (result, progress_file, error_file):
        path.unlink(missing_ok=True)
    command = [sys.executable, "-m", "mizan.engine.muscriptor", "--worker",
               "--model", model, "--source", str(source),
               "--result", str(result), "--progress", str(progress_file),
               "--error", str(error_file)]
    deadline = time.monotonic() + min(7200, max(900, audio.duration * 15))
    last_progress = 0.0
    try:
        with subprocess.Popen(command, stdin=subprocess.PIPE,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as worker:
            from .. import telemetry
            telemetry.worker_pid = worker.pid
            guard = None
            try:
                guard = _assign_memory_limit(worker, model)
                worker.stdin.write(b"1")
                worker.stdin.close()
                while worker.poll() is None:
                    check_cancel(cancelled)
                    if time.monotonic() >= deadline:
                        raise ModelFailed(_cpu_inference_timeout_message(model, audio))
                    try:
                        value = float(progress_file.read_text(encoding="ascii"))
                        if math.isfinite(value) and last_progress < value <= 1:
                            last_progress = value
                            if progress:
                                progress(value)
                    except (OSError, ValueError):
                        pass
                    time.sleep(0.2)
                check_cancel(cancelled)
                code = worker.returncode
                if code:
                    if code & 0xffffffff == 0xC0000005:
                        raise ModelFailed(
                            f"{model} CPU worker crashed in native PyTorch (0xC0000005). "
                            "This runtime is unstable on this device; try another MuScriptor size.")
                    try:
                        reason = error_file.read_text(encoding="utf-8").strip()
                    except OSError:
                        reason = ""
                    raise ModelFailed(reason or
                                      f"{model} CPU worker exited 0x{code & 0xffffffff:08X}; "
                                      "check local dependencies and available RAM.")
                try:
                    data = json.loads(result.read_text(encoding="utf-8"))
                    return data["piano"], data["drums"], data["details"], data["events"]
                except (OSError, ValueError, KeyError) as exc:
                    raise ModelFailed(
                        f"{model} CPU worker returned no valid result; check the local runtime.") from exc
            finally:
                if worker.poll() is None:
                    worker.kill()
                    worker.wait()
                telemetry.worker_pid = None
                _close_job(guard)
    except OSError as exc:
        raise ModelFailed(f"Could not start the isolated {model} CPU worker; check the local runtime.") from exc
    finally:
        for path in (result, progress_file, error_file):
            path.unlink(missing_ok=True)


def _main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--model", choices=MODELS)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--result", type=Path)
    parser.add_argument("--progress", type=Path)
    parser.add_argument("--error", type=Path)
    args = parser.parse_args()
    if not args.worker or not all((args.model, args.source, args.result, args.progress, args.error)):
        parser.error("Worker arguments are required")
    if sys.stdin.buffer.read(1) != b"1":
        raise SystemExit(2)
    from .audio import read_audio
    try:
        piano, drums, details, events = _transcribe_inprocess(
            args.model, read_audio(args.source), progress=lambda value:
            args.progress.write_text(str(value), encoding="ascii"))
        args.result.write_text(json.dumps({
            "piano": piano, "drums": drums, "details": details, "events": events,
        }, ensure_ascii=True, allow_nan=False), encoding="utf-8")
    except ModelFailed as exc:
        args.error.write_text(str(exc), encoding="utf-8")
        raise SystemExit(1) from None


if __name__ == "__main__":
    _main()
