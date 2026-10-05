"""Reproducible synthetic benchmark; no downloaded or copyrighted audio."""

import argparse
import ctypes
import importlib.metadata
import json
import os
from pathlib import Path
import tempfile
from threading import Event
import time

import numpy as np
from scipy.signal import butter, sosfilt

from ..paths import app_dir
from .audio import Audio, write_audio
from .models import BASIC_PITCH, ensure_model
from .pipeline import analyze_decoded
from .providers import VerifiedModel


def synthetic_mix(seconds: float = 60) -> tuple[Audio, list[dict], list[dict]]:
    rate = 22050
    samples = np.zeros(round(seconds * rate), dtype=np.float32)
    truth, chord_truth = [], []
    progression = [("C", [48, 60, 64, 67]), ("Am", [45, 57, 60, 64]),
                   ("F", [41, 53, 57, 60]), ("G", [43, 55, 59, 62])]
    for index, onset in enumerate(np.arange(0, seconds, 2)):
        symbol, notes = progression[index % 4]
        length = min(1.8, seconds - onset)
        t = np.arange(round(length * rate)) / rate
        envelope = np.minimum(t / 0.01, 1) * np.exp(-t * 1.1) * np.minimum((length - t) / 0.04, 1)
        chord = sum(np.sin(2 * np.pi * 440 * 2 ** ((pitch - 69) / 12) * t) for pitch in notes)
        start = round(onset * rate)
        samples[start:start + len(t)] += (0.10 * chord * envelope).astype(np.float32)
        truth.extend({"midi": pitch, "onset": float(onset), "offset": float(onset + length)} for pitch in notes)
        chord_truth.append({"symbol": symbol, "onset": float(onset), "offset": float(min(seconds, onset + 2))})
    rng = np.random.default_rng(42)
    for index, onset in enumerate(np.arange(0, seconds, 0.5)):
        t = np.arange(min(round(rate * 0.15), len(samples) - round(onset * rate))) / rate
        if index % 2 == 0:
            sound = np.sin(2 * np.pi * 65 * t) * np.exp(-t * 30)
        else:
            noise = rng.normal(size=len(t))
            sound = sosfilt(butter(3, [300, 2500], btype="bandpass", fs=rate, output="sos"), noise) * np.exp(-t * 40)
        start = round(onset * rate)
        samples[start:start + len(t)] += (sound * 0.25).astype(np.float32)
    return Audio(np.column_stack((samples, samples * 0.9)), rate), truth, chord_truth


def note_metrics(events: list[dict], truth: list[dict]) -> dict:
    unmatched = set(range(len(truth)))
    errors = []
    offsets = []
    for note in events:
        candidates = [i for i in unmatched if truth[i]["midi"] == note["midi"]
                      and abs(truth[i]["onset"] - note["onset"]) <= 0.15]
        if candidates:
            index = min(candidates, key=lambda i: abs(truth[i]["onset"] - note["onset"]))
            unmatched.remove(index)
            errors.append(abs(truth[index]["onset"] - note["onset"]))
            offsets.append(abs(truth[index]["offset"] - note["offset"]))
    return {"onsetToleranceSeconds": 0.15, "matched": len(errors), "expected": len(truth),
            "predicted": len(events), "precision": len(errors) / max(1, len(events)),
            "recall": len(errors) / max(1, len(truth)),
            "meanOnsetErrorSeconds": float(np.mean(errors)) if errors else None,
            "meanOffsetErrorSeconds": float(np.mean(offsets)) if offsets else None}


def peak_memory_mib() -> float | None:
    if os.name != "nt":
        return None

    class Counters(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong)] + [
            (name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize",
            "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
            "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]

    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    handle = ctypes.c_void_p(-1)
    if not ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
        raise ctypes.WinError()
    return counters.PeakWorkingSetSize / 1024 ** 2


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=60)
    parser.add_argument("--output", type=Path, default=Path("engine-benchmark.json"))
    parser.add_argument("--provider", choices=["auto", "qnn", "dml", "cpu"], default="auto")
    parser.add_argument("--probe-model-providers", action="store_true")
    args = parser.parse_args()
    if not 0 < args.seconds <= 3600:
        parser.error("The synthetic benchmark length must be between 0 and 3600 seconds.")
    os.environ["MIZAN_PROVIDER"] = args.provider
    audio, truth, chords = synthetic_mix(args.seconds)
    results = {"audio": "Deterministic synthetic piano-like chords and kick/snare; not real-music accuracy.",
               "durationSeconds": args.seconds, "requestedProvider": args.provider,
               "versions": {name: importlib.metadata.version(name) for name in ("numpy", "scipy", "onnxruntime", "mido")},
               "model": BASIC_PITCH, "stages": {}}
    with tempfile.TemporaryDirectory(prefix="benchmark-", dir=app_dir("tmp")) as temporary:
        directory = Path(temporary)
        source = directory / "synthetic.wav"
        write_audio(source, audio)
        for instrument in ("piano", "drums"):
            output = directory / instrument
            output.mkdir()
            start = time.perf_counter()
            song = analyze_decoded(source, output, title="Synthetic benchmark", url="synthetic",
                                   instrument=instrument, report=lambda s, p: None, cancelled=Event())
            result = {"wallSeconds": time.perf_counter() - start, "diagnostics": song["diagnostics"],
                      "bpm": song["bpm"], "key": song["key"], "events": len(song[instrument]),
                      "accompanimentNotes": len(song["accompaniment"])}
            if instrument == "piano":
                result["syntheticNoteMetrics"] = note_metrics(song["piano"], truth)
            correct = 0
            for chord in chords:
                midpoint = (chord["onset"] + chord["offset"]) / 2
                predicted = next((c for c in song["chords"] if c["onset"] <= midpoint < c["offset"]), None)
                correct += predicted is not None and predicted["symbol"] == chord["symbol"]
            result["syntheticChordAccuracyAtMidpoints"] = correct / len(chords)
            results["stages"][instrument] = result
        if args.probe_model_providers:
            model_path = ensure_model()
            samples = np.pad(audio.mono()[:43844], (0, max(0, 43844 - len(audio.samples))))
            feeds = {"serving_default_input_2:0": samples.reshape(1, 43844, 1).astype(np.float32)}
            results["modelProviders"] = {}
            reference = None
            for provider in ("cpu", "qnn", "dml"):
                model = VerifiedModel(model_path, feeds, provider=provider)
                if reference is None:
                    reference = model.first_output
                deviations = [float(np.max(abs(a - b))) for a, b in zip(reference, model.first_output)]
                times = []
                for _ in range(5):
                    start = time.perf_counter()
                    model.run(feeds)
                    times.append((time.perf_counter() - start) * 1000)
                results["modelProviders"][provider] = {**model.report, "medianRunMs": float(np.median(times)),
                                                       "maxAbsoluteOutputDifferenceFromCpu": max(deviations)}
    results["peakHostWorkingSetMiB"] = peak_memory_mib()
    args.output.write_text(json.dumps(results, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps({instrument: {key: value for key, value in result.items() if key != "diagnostics"}
                      for instrument, result in results["stages"].items()}, indent=2))
    print(f"Full report: {args.output}")


if __name__ == "__main__":
    main()
