"""Opt-in official MuScriptor Large CPU benchmark; never used by app jobs."""

import argparse
from collections import Counter
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import subprocess
import sys
import time

from .muscriptor_medium_spike import MIX_SHA256, verify

REPO = "MuScriptor/muscriptor-large"
REVISION = "8809fdfbed2affa7ade94a7059e746e3880720e7"
# SHA-256 published in the official repository's file-security metadata.
WEIGHTS_SHA256 = "ac4eb6ea87dfc26b6ca6b954c6b967ab87ad4c7d08e078b25214f13ed051f397"
WEIGHTS_BYTES = 5465642136
MEMORY_LIMIT_GIB = 14
MIN_FREE_GIB = MEMORY_LIMIT_GIB + 6


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


def run_bounded(command: list[str], timeout: int) -> None:
    """Enforce a Windows process-commit limit, including abrupt child failures."""
    if sys.platform != "win32":
        raise OSError("The Large CPU memory guard requires Windows")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(_MemoryStatus)]
    kernel.GlobalMemoryStatusEx.restype = wintypes.BOOL
    status = _MemoryStatus()
    status.dwLength = ctypes.sizeof(status)
    if not kernel.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise ctypes.WinError(ctypes.get_last_error())
    if status.ullAvailPhys < MIN_FREE_GIB * 1024 ** 3:
        raise RuntimeError(f"Need at least {MIN_FREE_GIB} GiB free physical RAM before Large CPU inference")

    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.QueryInformationJobObject.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    ]
    kernel.QueryInformationJobObject.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        limits = _ExtendedLimit()
        limits.BasicLimitInformation.LimitFlags = 0x100 | 0x2000  # process memory, kill on close
        limits.ProcessMemoryLimit = int(MEMORY_LIMIT_GIB * 1024 ** 3)
        if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise ctypes.WinError(ctypes.get_last_error())
        with subprocess.Popen(command) as worker:
            if not kernel.AssignProcessToJobObject(job, int(worker._handle)):
                worker.kill()
                worker.wait()
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                exit_code = worker.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                worker.kill()
                worker.wait()
                raise RuntimeError(f"Large CPU benchmark exceeded {timeout}s; no new result saved") from None
            if exit_code:
                usage = _ExtendedLimit()
                peak = "unknown"
                if kernel.QueryInformationJobObject(job, 9, ctypes.byref(usage), ctypes.sizeof(usage), None):
                    peak = f"{usage.PeakProcessMemoryUsed / 1024 ** 3:.2f} GiB"
                raise RuntimeError(f"Large CPU benchmark exited with code {exit_code}; "
                                   f"peak process memory {peak} (cap {MEMORY_LIMIT_GIB} GiB)")
    finally:
        kernel.CloseHandle(job)


def check_model(model_dir: Path) -> None:
    weights = model_dir / "model.safetensors"
    if not weights.is_file() or not (model_dir / "config.json").is_file():
        raise FileNotFoundError("Official Large weights/config missing; use --download after accepting model terms")
    if weights.stat().st_size != WEIGHTS_BYTES:
        raise ValueError("Large checkpoint size mismatch")
    verify(weights, WEIGHTS_SHA256)
    config = json.loads((model_dir / "config.json").read_text(encoding="utf-8"))
    if tuple(config.get(key) for key in ("dim", "num_heads", "num_layers", "card")) != (
        1536, 24, 48, 1395
    ):
        raise ValueError("Unexpected Large checkpoint configuration")


def download(model_dir: Path) -> None:
    if (model_dir / "model.safetensors").exists():
        weights = model_dir / "model.safetensors"
        if weights.stat().st_size != WEIGHTS_BYTES:
            raise ValueError("Existing Large weights are incomplete or corrupt; refusing another download")
        if (model_dir / "config.json").is_file():
            return
    from mizan.hf_credentials import get_hf_token

    token = get_hf_token()
    if not token:
        raise RuntimeError("No Mizan Hugging Face token configured; accept the official model terms first")
    from huggingface_hub import hf_hub_download

    model_dir.mkdir(parents=True, exist_ok=True)
    for filename in ("config.json", "model.safetensors"):
        if filename == "model.safetensors" and (model_dir / filename).is_file():
            continue
        hf_hub_download(
            REPO, filename, revision=REVISION, token=token,
            local_dir=model_dir,
        )


def notes_from_events(events) -> list[dict]:
    starts, notes = {}, []
    for event in events:
        if hasattr(event, "start_time") and hasattr(event, "index"):
            starts[event.index] = event
        elif hasattr(event, "start_event_index"):
            start = starts.pop(event.start_event_index)
            notes.append({
                "instrument": start.instrument, "midi": start.pitch,
                "onset": start.start_time, "offset": event.end_time,
            })
    if starts:
        raise RuntimeError("Unclosed notes in MuScriptor event stream")
    return sorted(notes, key=lambda n: (n["onset"], n["instrument"], n["midi"]))


def benchmark(args) -> None:
    import torch
    from muscriptor import TranscriptionModel
    import muscriptor.transcription_model as upstream
    from safetensors.torch import load_file
    from .audio import read_audio
    from .benchmark import peak_memory_mib
    from .quality_benchmark import drum_metrics, note_metrics

    torch.set_num_threads(args.threads)
    reference = json.loads(args.reference.read_text(encoding="utf-8"))
    mix = Path(reference["referenceWav"])
    if reference["referenceSha256"] != MIX_SHA256 or reference["durationSeconds"] != 30:
        raise ValueError("Expected pinned 30-second CC0 fixture")
    verify(mix, MIX_SHA256)
    started = time.perf_counter()
    waveform = read_audio(mix).resampled(16000).mono()[:30 * 16000].copy()
    prep = time.perf_counter() - started
    loaded = time.perf_counter()
    print("Loading official Large CPU weights", file=sys.stderr, flush=True)
    upstream.load_file = lambda path, device: load_file(path, device=device, backend="pread")
    model = TranscriptionModel.load_model(args.model_dir / "model.safetensors", device="cpu")
    load = time.perf_counter() - loaded
    print(f"Loaded Large CPU weights in {load:.1f}s; starting transcription", file=sys.stderr, flush=True)
    with torch.inference_mode():
        events = model.transcribe((torch.from_numpy(waveform).unsqueeze(0), 16000),
                                  cfg_coef=1.0, no_eos_is_ok=False)
        notes = notes_from_events(events)
    elapsed = time.perf_counter() - started
    drums = [{"lane": {36: "kick", 38: "snare", 42: "hihat"}.get(n["midi"], f"midi_{n['midi']}"),
              "onset": n["onset"]} for n in notes if n["instrument"] == "drums"]
    result = {
        "source": f"{REPO}@{REVISION} official FP32 PyTorch",
        "license": "CC BY-NC 4.0, research/noncommercial use only; input rights required",
        "weightsSha256": WEIGHTS_SHA256, "fixtureSha256": MIX_SHA256,
        "scope": "Original, non-isolated pinned 30-second CC0 mix; no other inference models",
        "cpuThreads": args.threads, "provider": "PyTorch CPU",
        "preprocessSeconds": prep, "loadSeconds": load,
        "inferenceSeconds": elapsed - prep - load, "totalWallSeconds": elapsed,
        "peakWorkingSetMiB": peak_memory_mib(),
        "instrumentCounts": dict(Counter(n["instrument"] for n in notes)),
        "piano": note_metrics(
            [n for n in notes if n["instrument"] in ("acoustic_piano", "program_0")],
            reference["truth"]["piano"],
        ),
        "drums": drum_metrics(drums, reference["truth"]["drums"]),
        "notes": notes,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps({key: value for key, value in result.items() if key != "notes"}, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=12)
    parser.add_argument("--timeout", type=int, default=900, help="Maximum worker time in seconds")
    parser.add_argument("--download", action="store_true", help="Fetch gated official weights using the Mizan vault")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not 1 <= args.threads <= 32 or not 1 <= args.timeout <= 3600:
        parser.error("Expected 1–32 CPU threads and 1–3600 seconds timeout")
    if args.worker:
        benchmark(args)
        return
    if args.download:
        download(args.model_dir)
    check_model(args.model_dir)
    command = [
        sys.executable, "-X", "faulthandler", "-m", "mizan.engine.muscriptor_large_spike",
        "--worker", "--model-dir", str(args.model_dir),
        "--reference", str(args.reference), "--output", str(args.output),
        "--threads", str(args.threads),
    ]
    run_bounded(command, args.timeout)


if __name__ == "__main__":
    main()
