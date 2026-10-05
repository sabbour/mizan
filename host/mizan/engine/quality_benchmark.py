"""Offline, synthetic full-pipeline accuracy baseline; not a real-music benchmark."""

import argparse
import json
import os
from pathlib import Path
import shutil
from threading import Event
import tempfile
import time

import numpy as np
from scipy.signal import butter, sosfilt

from .audio import Audio, read_audio, write_audio
from .benchmark import peak_memory_mib
from .models import BASIC_PITCH, BEAT_THIS, BEAT_THIS_FRONTEND, HTDEMUCS_6S, checksum
from .pipeline import analyze_decoded

RATE = 22050
CHORDS = [("C", (48, 60, 64, 67)), ("Am", (45, 57, 60, 64)),
          ("F", (41, 53, 57, 60)), ("G", (43, 55, 59, 62))]


def fixture(seconds=32):
    piano = np.zeros(round(seconds * RATE), np.float32)
    drums = np.zeros_like(piano)
    notes, hits, chords = [], [], []
    rng = np.random.default_rng(42)
    for index, onset in enumerate(np.arange(0, seconds, 2)):
        symbol, pitches = CHORDS[index % len(CHORDS)]
        chords.append({"symbol": symbol, "onset": float(onset),
                       "offset": float(min(seconds, onset + 2))})
        for pitch in pitches:
            length = min(2.65 if pitch == pitches[0] and index % 2 == 0 else 1.7,
                         seconds - onset)
            t = np.arange(round(length * RATE)) / RATE
            env = np.minimum(1, t / 0.012) * np.exp(-0.65 * t) * np.minimum(1, (length - t) / 0.06)
            wave = (np.sin(2 * np.pi * 440 * 2 ** ((pitch - 69) / 12) * t)
                    + 0.18 * np.sin(4 * np.pi * 440 * 2 ** ((pitch - 69) / 12) * t))
            start = round(onset * RATE)
            piano[start:start + len(t)] += (0.035 * env * wave).astype(np.float32)
            notes.append({"midi": pitch, "onset": float(onset), "offset": float(onset + length)})
    for index, onset in enumerate(np.arange(0.25, seconds - 0.15, 0.25)):
        if index % 2:
            continue
        beat = index // 2
        lane = "kick" if beat % 4 in (0, 2) else "snare" if beat % 4 == 1 else "openhat"
        if beat % 4 != 3:
            # Offset hats avoid ambiguous simultaneous onset assignment.
            hat_onset = onset + 0.25
            if hat_onset < seconds - 0.15:
                hits.append({"lane": "hihat", "onset": float(hat_onset)})
        hits.append({"lane": lane, "onset": float(onset)})
    for hit in hits:
        lane = hit["lane"]
        length = 0.28 if lane == "openhat" else 0.18
        t = np.arange(round(length * RATE)) / RATE
        if lane == "kick":
            sound = np.sin(2 * np.pi * 65 * t) * np.exp(-t * 30)
        else:
            low, high = ((300, 2500) if lane == "snare" else
                         (5000, 9500) if lane == "hihat" else (4000, 9000))
            sound = sosfilt(butter(3, [low, high], fs=RATE, btype="bandpass",
                                   output="sos"), rng.normal(size=len(t)))
            sound *= np.exp(-t * (40 if lane != "openhat" else 12))
        start = round(hit["onset"] * RATE)
        length = min(len(t), len(drums) - start)
        drums[start:start + length] += (0.12 * sound[:length]).astype(np.float32)
    return (Audio(np.column_stack((piano + drums, (piano + drums) * 0.9)), RATE),
            Audio(np.column_stack((piano, piano * 0.9)), RATE),
            Audio(np.column_stack((drums, drums * 0.9)), RATE),
            {"piano": notes, "drums": hits, "chords": chords,
             "key": {"tonic": "C", "mode": "major"}})


def score(tp, predicted, expected):
    return {"matched": tp, "predicted": predicted, "expected": expected,
            "precision": tp / predicted if predicted else 0.0,
            "recall": tp / expected if expected else 0.0,
            "f1": 2 * tp / (predicted + expected) if predicted + expected else 0.0}


def note_metrics(predicted, expected):
    available = set(range(len(expected)))
    pairs = []
    for note in sorted(predicted, key=lambda item: item["onset"]):
        candidates = [i for i in available if abs(note["midi"] - expected[i]["midi"]) <= 0.15
                      and abs(note["onset"] - expected[i]["onset"]) <= 0.15]
        if candidates:
            i = min(candidates, key=lambda j: abs(note["onset"] - expected[j]["onset"]))
            available.remove(i)
            pairs.append((note, expected[i]))
    full = sum(abs(a["offset"] - b["offset"]) <= max(0.05, 0.2 * (b["offset"] - b["onset"]))
               for a, b in pairs)
    sustained = [b for b in expected if b["offset"] - b["onset"] > 2]
    matched_sustained = [(a, b) for a, b in pairs if b["offset"] - b["onset"] > 2]
    return {"onsetToleranceSeconds": 0.15, "pitchToleranceCents": 15,
            "offsetToleranceSeconds": "max(0.05, 0.20 * reference duration)",
            "onsetPitch": score(len(pairs), len(predicted), len(expected)),
            "onsetPitchOffset": score(full, len(predicted), len(expected)),
            "meanOnsetErrorSeconds": float(np.mean([abs(a["onset"] - b["onset"]) for a, b in pairs])) if pairs else None,
            "meanOffsetErrorSeconds": float(np.mean([abs(a["offset"] - b["offset"]) for a, b in pairs])) if pairs else None,
            "sustained": {"expected": len(sustained), "onsetPitchMatched": len(matched_sustained),
                          "onsetPitchOffsetMatched": sum(
                              abs(a["offset"] - b["offset"]) <= max(0.05, 0.2 * (b["offset"] - b["onset"]))
                              for a, b in matched_sustained)}}


def drum_metrics(predicted, expected):
    group = lambda lane: "hihat" if lane in ("hihat", "openhat") else lane
    # Match onset first, then report lane confusion, not a misleading count of coincident events.
    options = sorted((abs(a["onset"] - b["onset"]), group(a["lane"]) != group(b["lane"]), i, j)
                     for i, a in enumerate(predicted) for j, b in enumerate(expected)
                     if abs(a["onset"] - b["onset"]) <= 0.05)
    used_pred, used_truth, confusion = set(), set(), {}
    for _, _, i, j in options:
        if i not in used_pred and j not in used_truth:
            used_pred.add(i)
            used_truth.add(j)
            truth, prediction = group(expected[j]["lane"]), group(predicted[i]["lane"])
            confusion.setdefault(truth, {}).setdefault(prediction, 0)
            confusion[truth][prediction] += 1
    classes = {}
    for lane in ("kick", "snare", "hihat"):
        tp = confusion.get(lane, {}).get(lane, 0)
        classes[lane] = score(tp, sum(group(p["lane"]) == lane for p in predicted),
                              sum(group(t["lane"]) == lane for t in expected))
    return {"onsetToleranceSeconds": 0.05, "groupedClasses": classes,
            "onsetOnly": score(len(used_pred), len(predicted), len(expected)),
            "confusion": confusion,
            "unmatchedTruth": {lane: sum(j not in used_truth and group(hit["lane"]) == lane
                                          for j, hit in enumerate(expected)) for lane in classes},
            "unmatchedPredicted": {lane: sum(i not in used_pred and group(hit["lane"]) == lane
                                              for i, hit in enumerate(predicted)) for lane in classes},
            "unsupportedSubtypes": {"closedHat": None, "openHat": None}}


def chord_metrics(predicted, expected, seconds):
    # Time-weighted frames count uncovered and unknown spans as errors, not skipped examples.
    frames = np.arange(0.05, seconds, 0.1)
    matches = covered = 0
    for t in frames:
        actual = next(c["symbol"] for c in expected if c["onset"] <= t < c["offset"])
        guess = next((c["symbol"] for c in predicted if c["onset"] <= t < c["offset"]), None)
        covered += guess not in (None, "N.C.")
        matches += guess == actual
    return {"frameSeconds": 0.1, "frames": len(frames), "coverage": covered / len(frames),
            "accuracyIncludingUnknown": matches / len(frames),
            "accuracyWhenCovered": matches / covered if covered else None}


def leakage(stems, piano, drums):
    # Projection against known independent sources; residual/model artifacts are not counted as correct isolation.
    sources = np.column_stack((piano.mono(), drums.mono())).astype(np.float64)
    result = {}
    for stem_name, own, other in (("piano", 0, 1), ("drums", 1, 0)):
        estimate = read_audio(stems / f"{stem_name}.wav").mono()
        coefficients = np.linalg.lstsq(sources, estimate, rcond=None)[0]
        components = coefficients * np.sqrt(np.sum(sources ** 2, axis=0))
        result[stem_name] = {
            "referenceSourceProjection": float(coefficients[own]),
            "otherSourceProjection": float(coefficients[other]),
            "otherToOwnProjectedEnergyRatio": float((components[other] / components[own]) ** 2)
            if abs(components[own]) > 1e-12 else None,
            "unexplainedEnergyFraction": float(np.sum((estimate - sources @ coefficients) ** 2)
                                               / max(np.sum(estimate ** 2), 1e-12))}
    return result


def stage_models(models_from, model_dir):
    model_dir.mkdir()
    for spec in (HTDEMUCS_6S, BASIC_PITCH, BEAT_THIS, BEAT_THIS_FRONTEND):
        name = spec.get("filename", f"{spec['id']}.onnx")
        original = models_from / name
        if not original.is_file() or checksum(original) != spec["sha256"]:
            raise ValueError(f"Missing or invalid cached model: {original}. No downloads attempted.")
        shutil.copy2(original, model_dir / name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=32)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--models-from", type=Path, default=Path(os.environ["LOCALAPPDATA"]) / "Mizan" / "models")
    args = parser.parse_args()
    if not 30 <= args.seconds <= 60:
        parser.error("--seconds must be from 30 to 60.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    mix, piano, drums, truth = fixture(args.seconds)
    for label, audio in (("", mix), ("-piano-truth", piano), ("-drums-truth", drums)):
        write_audio(args.output.with_name(args.output.stem + label + ".wav"), audio)
    source = args.output.with_suffix(".wav")
    with tempfile.TemporaryDirectory(prefix="mizan-quality-") as temporary:
        os.environ.update(MIZAN_HOME=temporary, MIZAN_SEPARATOR="auto", MIZAN_PIANO="auto",
                          MIZAN_BEATS="auto", MIZAN_PROVIDER="auto")
        model_dir = Path(temporary) / "models"
        try:
            stage_models(args.models_from, model_dir)
        except ValueError as exc:
            parser.error(str(exc))
        output = Path(temporary) / "analysis"
        output.mkdir()
        start = time.perf_counter()
        song = analyze_decoded(source, output, title="Synthetic quality reference",
                               url="locally-generated", instrument="auto",
                               report=lambda stage, progress: None, cancelled=Event())
        elapsed = time.perf_counter() - start
        report = {
            "fixture": ("Deterministic synthesized overlapping harmonic chords and spectral percussion; "
                        "no real piano resonance/pedal, recorded-kit timbre, guitars, bass, vocals, "
                        "room acoustics or production. Synthetic scores do not generalize to real music."),
            "durationSeconds": args.seconds, "sampleRate": RATE,
            "referenceWav": str(source.resolve()), "referenceSha256": checksum(source), "truth": truth,
            "settings": {"separator": "auto", "piano": "auto", "beats": "auto", "provider": "auto"},
            "modelVersions": song["modelVersions"],
            "actualMethods": {name: value["method"] for name, value in song["diagnostics"].items()},
            "piano": note_metrics(song["piano"], truth["piano"]),
            "drums": drum_metrics(song["drums"], truth["drums"]),
            "chords": chord_metrics(song["chords"], truth["chords"], args.seconds),
            "key": {"expected": truth["key"], "predicted": song["key"],
                    "correct": song["key"] == truth["key"]},
            "separation": leakage(output, piano, drums),
            "separationMetricNote": ("Aligned least-squares projection of predicted stem onto known sources; "
                                     "residual includes artifacts and phase/timing differences. "
                                     "Projected energy ratio alone does not measure accuracy."),
            "wallSeconds": elapsed, "peakHostWorkingSetMiB": peak_memory_mib(),
            "diagnostics": song["diagnostics"],
            "unsupported": ["open/closed hat subtype recognition", "guitar/bass transcription",
                            "real-recording generalization"],
        }
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("piano", "drums", "chords", "key", "separation",
                                                 "wallSeconds", "peakHostWorkingSetMiB")}, indent=2))
    print(f"Full report: {args.output}")


if __name__ == "__main__":
    main()
