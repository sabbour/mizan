"""Opt-in YAMNet vs stem-RMS comparison on the pinned CC0 reference fixture."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import time

import numpy as np
import onnxruntime as ort

from .benchmark import peak_memory_mib
from .detect import detect_instruments
from .models import HTDEMUCS_6S, checksum
from .audio import read_audio
from .real_sample_benchmark import SAMPLES, assemble_fixture, fetch_samples
from .separation import separate

YAMNET = {
    "url": "https://huggingface.co/audiomagic/yamnet-onnx/resolve/f25b741c2f0bdc6d7e6db24b5fddda23347dbafd/yamnet.onnx",
    "sha256": "d3835ffbbd4a1bb3e777f0ca217b5007907f5171dd5d17c4236b95b2af8f908e",
    "bytes": 16093355,
    "license": "Apache-2.0",
    "attribution": "Google LLC (2022); ONNX conversion by Audio Magic",
}
LABELS = {"piano": 148, "drumKit": 157, "snareDrum": 160,
          "bassDrum": 163, "hiHat": 167}
LABEL_SOURCE = ("Google AudioSet ontology, CC BY 4.0: "
                "https://huggingface.co/audiomagic/yamnet-onnx/resolve/"
                "f25b741c2f0bdc6d7e6db24b5fddda23347dbafd/yamnet_class_map.csv")


def checked_model(path):
    if not path.is_file() or path.stat().st_size != YAMNET["bytes"] or checksum(path) != YAMNET["sha256"]:
        raise ValueError(f"Missing or invalid pinned YAMNet model: {path}")
    return path


def yamnet_scores(session, audio):
    waveform = np.ascontiguousarray(audio.resampled(16000).mono(), dtype=np.float32)
    scores = session.run(["output_0"], {"waveform": waveform})[0]
    if scores.ndim != 2 or scores.shape[1] != 521 or len(scores) == 0 or not np.isfinite(scores).all():
        raise ValueError(f"Unexpected YAMNet output_0 shape or nonfinite scores: {scores.shape}")
    return {"frames": len(scores), "frameStrideSeconds": 0.48,
            "scores": {name: {"max": float(scores[:, index].max()),
                              "mean": float(scores[:, index].mean())}
                       for name, index in LABELS.items()}}


def compare(samples, model, separator_model=None):
    for details in SAMPLES.values():
        path = samples / details["filename"]
        if not path.is_file() or checksum(path) != details["sha256"]:
            raise ValueError(f"Missing or invalid pinned CC0 sample: {path}")
    loaded = {name: read_audio(samples / details["filename"]) for name, details in SAMPLES.items()}
    mix, piano, drums, _, _, _ = assemble_fixture(loaded, chords=True)
    clips = {"mix": mix, "pianoOnly": piano, "drumsOnly": drums}
    labels = {"mix": {"piano": True, "drums": True},
              "pianoOnly": {"piano": True, "drums": False},
              "drumsOnly": {"piano": False, "drums": True}}
    session = ort.InferenceSession(str(checked_model(model)), providers=["CPUExecutionProvider"])
    if session.get_providers() != ["CPUExecutionProvider"]:
        raise RuntimeError(f"YAMNet did not use CPU-only execution: {session.get_providers()}")
    report = {
        "fixture": "30-second assembled CC0 recordings; mix and clean, unmixed reference stems",
        "mixSamplesSha256": hashlib.sha256(mix.samples.tobytes()).hexdigest(),
        "samples": {name: details["sha256"] for name, details in SAMPLES.items()},
        "model": {**YAMNET, "path": str(model.resolve()), "effectiveProvider": session.get_providers()},
        "labels": {"source": LABEL_SOURCE, "indices": LABELS},
        "baseline": "Current detect_instruments relative stem RMS after separation; not probabilities",
        "truth": labels, "clips": {},
        "limits": [
            "Clean reference stems are labelled absent-instrument examples, not held-out recordings.",
            "No calibrated presence threshold; score ranking is descriptive, not detection precision.",
            "YAMNet class scores measure sound presence, not drum-event identity or onset accuracy.",
            "Each example is 30 seconds; reported working set is a single-process high-water mark.",
        ],
    }
    for name, audio in clips.items():
        started = time.perf_counter()
        yamnet = yamnet_scores(session, audio)
        yamnet["wallSeconds"] = time.perf_counter() - started
        started = time.perf_counter()
        stems, details = separate(audio)
        if separator_model and details["method"] != "htdemucs-6s-onnx":
            raise RuntimeError(f"Learned baseline unexpectedly fell back: {details['method']}")
        report["clips"][name] = {
            "yamnet": yamnet,
            "stemRms": {"scores": detect_instruments(audio, stems),
                        "separatorMethod": details["method"],
                        "effectiveProvider": details["provider"]["effectiveProviders"],
                        "wallSeconds": time.perf_counter() - started},
        }
    report["positiveVsAbsent"] = {}
    for instrument, category in (("piano", "piano"), ("drums", "drumKit")):
        positive = [name for name in clips if labels[name][instrument]]
        absent = next(name for name in clips if not labels[name][instrument])
        report["positiveVsAbsent"][instrument] = {
            "yamnetMax": {name: report["clips"][name]["yamnet"]["scores"][category]["max"]
                          for name in clips},
            "stemRms": {name: report["clips"][name]["stemRms"]["scores"][instrument]
                        for name in clips},
            "positiveClips": positive, "absentClip": absent,
        }
    report["peakHostWorkingSetMiB"] = peak_memory_mib()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--yamnet", type=Path, required=True,
                        help="Pre-downloaded pinned ONNX file; never downloaded by this runner.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--models-from", type=Path, default=Path(os.environ["LOCALAPPDATA"]) / "Mizan" / "models")
    parser.add_argument("--separator", choices=("auto", "dsp"), default="auto")
    args = parser.parse_args()
    checked_model(args.yamnet)
    fetch_samples(args.samples)
    with tempfile.TemporaryDirectory(prefix="mizan-detection-") as directory:
        previous = {key: os.environ.get(key) for key in ("MIZAN_HOME", "MIZAN_SEPARATOR", "MIZAN_PROVIDER")}
        os.environ.update(MIZAN_HOME=directory, MIZAN_SEPARATOR=args.separator, MIZAN_PROVIDER="cpu")
        try:
            if args.separator == "auto":
                source = args.models_from / HTDEMUCS_6S["filename"]
                if not source.is_file() or checksum(source) != HTDEMUCS_6S["sha256"]:
                    raise ValueError(f"Missing or invalid pinned separator model: {source}")
                target = Path(directory) / "models"
                target.mkdir()
                shutil.copy2(source, target / source.name)
            report = compare(args.samples, args.yamnet, args.separator == "auto")
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    print(f"Instrument comparison: {args.output}")


if __name__ == "__main__":
    main()
