"""Opt-in Kong versus Basic Pitch comparison on the pinned CC0 piano and mix."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import time

import numpy as np

from .audio import read_audio
from .benchmark import peak_memory_mib
from .piano import basic_pitch
from .providers import VerifiedModel
from .quality_benchmark import note_metrics

MODEL_SHA256 = "d2aff853e4112f9ccdd67526daa8b130e8a955a90b65289e0f836b4c6bcb753a"
MIX_SHA256 = "fa534ecb5ab0713448a4bcd0896ff4f6fc3c19e60818e53f85e70bbd86b73438"
PIANO_SHA256 = "afcd66f0ba76ccead01aa325f546f6ecd8b1293bfbf1b5e9e23aabb2c939fb47"
OUTPUTS = ("reg_onset_output", "reg_offset_output", "frame_output", "velocity_output")


def verified_hash(path: Path, expected: str) -> None:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise ValueError(f"SHA-256 mismatch: {path}")


def regression_peaks(values: np.ndarray, threshold: float, neighbour: int):
    peaks = np.zeros(values.shape, dtype=bool)
    shifts = np.zeros(values.shape, dtype=np.float32)
    for i in range(neighbour, len(values) - neighbour):
        if values[i] <= threshold or any(
            values[i - j] < values[i - j - 1] or values[i + j] < values[i + j + 1]
            for j in range(neighbour)
        ):
            continue
        peaks[i] = True
        left, center, right = values[i - 1:i + 2]
        denominator = center - (right if left > right else left)
        shifts[i] = (right - left) / denominator / 2 if denominator else 0
    return peaks, shifts


def decode_notes(outputs: dict[str, np.ndarray], duration: float) -> list[dict]:
    """Mirror the upstream RegressionPostProcessor note path (pedal not scored)."""
    for name in OUTPUTS:
        if name not in outputs or outputs[name].ndim != 2 or outputs[name].shape[1] != 88:
            raise ValueError(f"Unexpected Kong output shape: {name}")
    if len({len(outputs[name]) for name in OUTPUTS}) != 1:
        raise ValueError("Kong output frame counts differ.")
    notes = []
    for pitch in range(88):
        onsets, onset_shifts = regression_peaks(outputs["reg_onset_output"][:, pitch], 0.3, 2)
        offsets, offset_shifts = regression_peaks(outputs["reg_offset_output"][:, pitch], 0.3, 4)
        frames = outputs["frame_output"][:, pitch]
        velocity = outputs["velocity_output"][:, pitch]
        start = missing = release = None
        for i in range(len(frames)):
            if onsets[i]:
                if start is not None:
                    notes.append({"midi": pitch + 21, "onset": (start + onset_shifts[start]) / 100,
                                  "offset": (i - 1) / 100})
                start, missing, release = i, None, None
            if start is None or i <= start:
                continue
            if frames[i] <= 0.1 and missing is None:
                missing = i
            if offsets[i] and release is None:
                release = i
            end = None
            if missing is not None:
                end = release if release is not None and release - start > missing - release else missing
            elif i - start >= 600 or i == len(frames) - 1:
                end = i
            if end is not None:
                notes.append({"midi": pitch + 21, "onset": (start + onset_shifts[start]) / 100,
                              "offset": (end + offset_shifts[end]) / 100,
                              "velocity": float(velocity[start])})
                start = missing = release = None
    return sorted(({"midi": note["midi"], "onset": max(0.0, float(note["onset"])),
                    "offset": min(duration, float(note["offset"]))}
                   for note in notes if note["onset"] < duration),
                  key=lambda note: (note["onset"], note["midi"]))


def kong_outputs(model: VerifiedModel, samples: np.ndarray) -> dict[str, np.ndarray]:
    # Upstream enframe/deframe: 10 s at 16 kHz, 50% overlap; discard the
    # centered extra frame, keeping 75/50/75% of first/middle/last windows.
    segment = 160000
    padded = np.pad(samples, (0, (-len(samples)) % segment))
    starts = range(0, len(padded) - segment + 1, segment // 2)
    pieces = {name: [] for name in OUTPUTS}
    names = [item.name for item in model.session.get_outputs()]
    if not set(OUTPUTS).issubset(names):
        raise ValueError(f"Kong output names changed: {names}")
    for index, start in enumerate(starts):
        feed = {"waveform": padded[start:start + segment][None, :].astype(np.float32)}
        result = model.first_output if index == 0 else model.run(feed)
        for name in OUTPUTS:
            values = result[names.index(name)]
            if values.shape != (1, 1001, 88) or not np.isfinite(values).all():
                raise ValueError(f"Unexpected Kong {name} output: {values.shape}")
            window = values[0, :-1]
            pieces[name].append(window[(0 if index == 0 else 250):
                                       (1000 if index == len(starts) - 1 else 750)])
    return {name: np.concatenate(parts)[:round(len(samples) / 160)]
            for name, parts in pieces.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True,
                        help="Existing real-sample-model-comparison.json report.")
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    reference = json.loads(args.reference.read_text(encoding="utf-8"))
    paths = {"piano": Path(reference["referenceStems"]["piano"]["path"]),
             "mix": Path(reference["referenceWav"])}
    for name, path in paths.items():
        verified_hash(path, PIANO_SHA256 if name == "piano" else MIX_SHA256)
    if reference["referenceSha256"] != MIX_SHA256 or reference["referenceStems"]["piano"]["sha256"] != PIANO_SHA256:
        raise ValueError("Reference report is not the pinned 30-second CC0 fixture.")
    verified_hash(args.model, MODEL_SHA256)
    truth = reference["truth"]["piano"]
    if len(truth) != 45 or reference["durationSeconds"] != 30:
        raise ValueError("Unexpected reference labels or duration.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    work = args.output.with_name(args.output.stem + "-work")
    work.mkdir(exist_ok=False)
    previous_home = os.environ.get("MIZAN_HOME")
    os.environ["MIZAN_HOME"] = str(work)
    report = {"fixtureSha256": MIX_SHA256, "pianoSha256": PIANO_SHA256,
              "modelSha256": MODEL_SHA256, "referenceReport": str(args.reference),
              "license": "CC-BY-4.0; Kong et al. (2020), ONNX conversion by Mingji Wang",
              "pipelineBasicPitchOnSeparatedMix": reference["runs"]["learned"]["piano"],
              "inputs": {}}
    try:
        for name, path in paths.items():
            audio = read_audio(path)
            started = time.perf_counter()
            baseline_notes, details = basic_pitch(audio)
            baseline_time = time.perf_counter() - started
            samples = audio.resampled(16000).mono().astype(np.float32)
            feed = {"waveform": np.pad(samples[:160000], (0, max(0, 160000 - len(samples))))[None, :]}
            started = time.perf_counter()
            model = VerifiedModel(args.model, feed, provider="cpu")
            outputs = kong_outputs(model, samples)
            kong_notes = decode_notes(outputs, audio.duration)
            kong_time = time.perf_counter() - started
            report["inputs"][name] = {
                "basicPitch": {"metrics": note_metrics(baseline_notes, truth),
                               "wallSeconds": baseline_time, "provider": details["provider"],
                               "noteCount": len(baseline_notes)},
                "kong": {"metrics": note_metrics(kong_notes, truth),
                         "wallSeconds": kong_time, "provider": model.report,
                         "noteCount": len(kong_notes), "outputFrames": len(outputs["frame_output"])},
                "peakHostWorkingSetMiBSoFar": peak_memory_mib(),
            }
            args.output.write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
            print(f"{name}: Basic Pitch {baseline_time:.1f}s, Kong {kong_time:.1f}s", flush=True)
    finally:
        if previous_home is None:
            os.environ.pop("MIZAN_HOME", None)
        else:
            os.environ["MIZAN_HOME"] = previous_home
    report["peakHostWorkingSetMiB"] = peak_memory_mib()
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")


if __name__ == "__main__":
    main()
