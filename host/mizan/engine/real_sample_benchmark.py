"""Reproducible full-pipeline benchmark assembled from pinned CC0 instrument samples."""

import argparse
from contextlib import nullcontext
import hashlib
import json
import os
import platform
from pathlib import Path
from threading import Event
import time
from urllib.request import urlopen

import numpy as np

from .audio import Audio, read_audio, write_audio
from .benchmark import peak_memory_mib
from .quality_benchmark import chord_metrics, drum_metrics, leakage, note_metrics, stage_models
from .pipeline import analyze_decoded

RATE = 22050
VCSL_LICENSE = "https://github.com/sgossner/VCSL/blob/c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e/README.md"
DRUM_LICENSE = "https://github.com/Boochi44/free-drum-samples/blob/77ba31428a079dd8f17c8e144c1e649ea0a198b3/README.md"
SAMPLES = {
    "piano-c": {
        "filename": "GPiano_sus_C4_v1_rr1_Player.wav", "midi": 72,
        "sha256": "f921d4737ee847ecb55ce251a94e1841069b70e206b00342676954992ea7d0dc",
        "url": "https://raw.githubusercontent.com/sgossner/VCSL/c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e/Chordophones/Zithers/Grand%20Piano%2C%20Kawai/Sustains/GPiano_sus_C4_v1_rr1_Player.wav",
        "license": VCSL_LICENSE,
    },
    "piano-e": {
        "filename": "GPiano_sus_E4_v1_rr1_Player.wav", "midi": 76,
        "sha256": "2bbea3d9e280e7b87605eaa01853b9e81c8ce21eae1db61cfb6fa33b94ca449f",
        "url": "https://raw.githubusercontent.com/sgossner/VCSL/c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e/Chordophones/Zithers/Grand%20Piano%2C%20Kawai/Sustains/GPiano_sus_E4_v1_rr1_Player.wav",
        "license": VCSL_LICENSE,
    },
    "piano-g-sharp": {
        "filename": "GPiano_sus_G#4_v1_rr1_Player.wav", "midi": 80,
        "sha256": "09f8fc60ff5fde5ca7bc80f189885c2678df7405adf27a251139eae8c39c6390",
        "url": "https://raw.githubusercontent.com/sgossner/VCSL/c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e/Chordophones/Zithers/Grand%20Piano%2C%20Kawai/Sustains/GPiano_sus_G%234_v1_rr1_Player.wav",
        "license": VCSL_LICENSE,
    },
    "piano-b": {
        "filename": "GPiano_sus_B4_v3_rr1_Player.wav", "midi": 83,
        "sha256": "00cd9f702d90dc69c366ced45f45fdc2742e7cae636c63b5b0e1958a04bd362d",
        "url": "https://raw.githubusercontent.com/sgossner/VCSL/c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e/Chordophones/Zithers/Grand%20Piano%2C%20Kawai/Sustains/GPiano_sus_B4_v3_rr1_Player.wav",
        "license": VCSL_LICENSE,
    },
    "piano-d-sharp": {
        "filename": "GPiano_sus_D#5_v1_rr1_Player.wav", "midi": 87,
        "sha256": "a207576b7a205d7eb7ad4d5aa9eb79dd2ededd42415b2dc8cc36d4c576c213ea",
        "url": "https://raw.githubusercontent.com/sgossner/VCSL/c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e/Chordophones/Zithers/Grand%20Piano%2C%20Kawai/Sustains/GPiano_sus_D%235_v1_rr1_Player.wav",
        "license": VCSL_LICENSE,
    },
    "piano-f-sharp": {
        "filename": "GPiano_sus_F#4_v1_rr1_Player.wav", "midi": 78,
        "sha256": "252a182b6030b9e23b5b4702b6e9d38cd90e980d4e179809bd874f3e8c699c1b",
        "url": "https://raw.githubusercontent.com/sgossner/VCSL/c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e/Chordophones/Zithers/Grand%20Piano%2C%20Kawai/Sustains/GPiano_sus_F%234_v1_rr1_Player.wav",
        "license": VCSL_LICENSE,
    },
    "kick": {
        "filename": "kick.wav",
        "sha256": "77b2648133000406d5add8f5890051d2300c7a1b5015d9800ff954b7a77a8cea",
        "url": "https://raw.githubusercontent.com/Boochi44/free-drum-samples/77ba31428a079dd8f17c8e144c1e649ea0a198b3/drum-samples/02-bounce/kicks/bounce-kick-02.wav",
        "license": DRUM_LICENSE,
    },
    "snare": {
        "filename": "snare.wav",
        "sha256": "667eca1430ac5f692544613ad72bfc82e9f4ba3be461d96c16cc437156d0943e",
        "url": "https://raw.githubusercontent.com/Boochi44/free-drum-samples/77ba31428a079dd8f17c8e144c1e649ea0a198b3/drum-samples/02-bounce/snares/bounce-snare-02.wav",
        "license": DRUM_LICENSE,
    },
    "hihat": {
        "filename": "closed-hat.wav",
        "sha256": "c9f30ff2b4d73b03f41960e504e03c54e9a59697af666fe4d155bab9cd1ccae6",
        "url": "https://raw.githubusercontent.com/Boochi44/free-drum-samples/77ba31428a079dd8f17c8e144c1e649ea0a198b3/drum-samples/02-bounce/hi-hats/hi-hat-closed-01.wav",
        "license": DRUM_LICENSE,
    },
}
TARGET_PEAKS = {"piano-c": 0.12, "piano-e": 0.12, "piano-g-sharp": 0.12,
                "piano-b": 0.12, "piano-d-sharp": 0.12, "piano-f-sharp": 0.12,
                "kick": 0.32, "snare": 0.24, "hihat": 0.10}

# I–iii–V–I in E major; chord identity is scored, not the arbitrary voicing.
PROGRESSION = (("E", ("piano-e", "piano-g-sharp", "piano-b")),
               ("G#m", ("piano-g-sharp", "piano-b", "piano-d-sharp")),
               ("B", ("piano-b", "piano-d-sharp", "piano-f-sharp")),
               ("E", ("piano-e", "piano-g-sharp", "piano-b")))
VARIANTS = {
    "learned": {"separator": "auto", "piano": "auto", "beats": "auto"},
    "dsp-separator": {"separator": "dsp", "piano": "auto", "beats": "auto"},
    "spectral-piano": {"separator": "auto", "piano": "dsp", "beats": "auto"},
    "onset-grid": {"separator": "auto", "piano": "auto", "beats": "dsp"},
}


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch_samples(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for details in SAMPLES.values():
        path = directory / details["filename"]
        if not path.is_file() or file_sha256(path) != details["sha256"]:
            with urlopen(details["url"]) as response:
                path.write_bytes(response.read())
        if file_sha256(path) != details["sha256"]:
            raise ValueError(f"Downloaded sample hash mismatch: {path}")


def measured_pitch(audio, expected_midi):
    mono = audio.resampled(RATE).mono()
    peak = np.max(np.abs(mono))
    onset = int(np.argmax(np.abs(mono) >= peak * 0.02))
    signal = mono[onset + round(0.05 * RATE):onset + round(2 * RATE)]
    size = 1 << (len(signal) - 1).bit_length()
    spectrum = np.abs(np.fft.rfft(signal * np.hanning(len(signal)), size))
    frequencies = np.fft.rfftfreq(size, 1 / RATE)
    target = 440 * 2 ** ((expected_midi - 69) / 12)
    band = (frequencies >= target * 2 ** (-0.5 / 12)) & (
        frequencies < target * 2 ** (0.5 / 12))
    frequency = frequencies[np.flatnonzero(band)[np.argmax(spectrum[band])]]
    return float(frequency), float(1200 * np.log2(frequency / target))


def prepare(audio, peak, seconds=None):
    samples = audio.resampled(RATE).samples
    if samples.ndim == 1:
        samples = np.column_stack((samples, samples))
    audible = np.max(np.abs(samples), axis=1)
    onset = int(np.argmax(audible >= np.max(audible) * 0.02))
    samples = samples[onset:]
    if seconds is not None:
        samples = samples[:round(seconds * RATE)]
    return Audio((samples * (peak / np.max(np.abs(samples)))).astype(np.float32), RATE), onset / RATE


def assemble_fixture(samples, seconds=30, *, chords=False):
    piano = np.zeros((seconds * RATE, 2), np.float32)
    drums = np.zeros_like(piano)
    truth = {"piano": [], "drums": []}
    prepared = {}
    trims = {}
    for name, audio in samples.items():
        prepared[name], trims[name] = prepare(
            audio, TARGET_PEAKS[name], 1.5 if name.startswith("piano-") else None)

    piano_names = ("piano-c", "piano-e", "piano-g-sharp")
    if chords:
        truth.update(chords=[{"symbol": "N.C.", "onset": 0.0, "offset": 0.5}],
                     key={"tonic": "E", "mode": "major"})
    for index, onset in enumerate(np.arange(0.5, seconds - (0.5 if chords else 1.5), 2.0)):
        symbol, names = PROGRESSION[index % len(PROGRESSION)] if chords else (
            None, (piano_names[index % len(piano_names)],))
        if chords:
            truth["chords"].append({"symbol": symbol, "onset": float(onset),
                                    "offset": float(min(onset + 2, seconds))})
        for name in names:
            clip = prepared[name]
            start = round(onset * RATE)
            piano[start:start + len(clip.samples)] += clip.samples
            truth["piano"].append({
                "midi": SAMPLES[name]["midi"], "onset": float(onset),
                "offset": float(onset + clip.duration),
            })

    for onset in np.arange(0.5, seconds - 0.25, 1.0):
        lane = "kick" if round(onset - 0.5) % 2 == 0 else "snare"
        for name, event_onset in ((lane, onset), ("hihat", onset + 0.25)):
            clip = prepared[name]
            start = round(event_onset * RATE)
            length = min(len(clip.samples), len(drums) - start)
            drums[start:start + length] += clip.samples[:length]
            truth["drums"].append({"lane": name, "onset": float(event_onset)})

    mix = piano + drums
    peak = float(np.max(np.abs(mix)))
    if peak >= 1:
        raise ValueError(f"Fixture would clip at {peak:.3f}; lower TARGET_PEAKS.")
    return Audio(mix, RATE), Audio(piano, RATE), Audio(drums, RATE), truth, trims, peak


def beat_metrics(predicted, expected, tolerance=0.08):
    remaining = list(expected)
    matched = 0
    for beat in predicted:
        if remaining:
            nearest = min(range(len(remaining)), key=lambda i: abs(beat - remaining[i]))
            if abs(beat - remaining[nearest]) <= tolerance:
                matched += 1
                remaining.pop(nearest)
    return {"toleranceSeconds": tolerance, "matched": matched,
            "predicted": len(predicted), "expected": len(expected),
            "precision": matched / len(predicted) if predicted else 0.0,
            "recall": matched / len(expected) if expected else 0.0,
            "f1": 2 * matched / (len(predicted) + len(expected))
            if predicted or expected else 0.0}


def score_run(song, analysis, piano, drums, truth, elapsed):
    diagnostics = song["diagnostics"]
    methods = {name: details["method"] for name, details in diagnostics.items()}
    return {
        "actualMethods": methods,
        "effectiveProviders": {
            name: details["provider"]["effectiveProviders"]
            for name, details in diagnostics.items()
        },
        "stageSeconds": {name: details["seconds"] for name, details in diagnostics.items()},
        "wallSeconds": elapsed,
        "modelVersions": song["modelVersions"],
        "piano": note_metrics(song["piano"], truth["piano"]),
        "drums": drum_metrics(song["drums"], truth["drums"]),
        "separation": leakage(analysis, piano, drums),
        "chords": chord_metrics(song["chords"], truth["chords"], 30),
        "key": {"expected": truth["key"], "predicted": song["key"],
                "correct": song["key"] == truth["key"]},
        "beat": beat_metrics(song["timing"]["times"],
                             np.arange(0.5, 30, 1.0).tolist()),
        "detected": song["detected"],
        "selectedInstruments": song["selectedInstruments"],
        "outputShape": {"pianoNotes": len(song["piano"]), "drumHits": len(song["drums"]),
                        "chordSpans": len(song["chords"]), "stemNames": sorted(
                            path.stem for path in analysis.glob("*.wav"))},
        "diagnostics": diagnostics,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--models-from", type=Path,
                        default=Path(os.environ["LOCALAPPDATA"]) / "Mizan" / "models")
    parser.add_argument("--variants", nargs="+", choices=tuple(VARIANTS),
                        default=list(VARIANTS), help="Run selected backend combinations.")
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        fetch_samples(args.samples)
        loaded = {name: read_audio(args.samples / details["filename"])
                  for name, details in SAMPLES.items()}
        pitch_checks = {}
        for name in (name for name in SAMPLES if name.startswith("piano-")):
            frequency, cents = measured_pitch(loaded[name], SAMPLES[name]["midi"])
            if abs(cents) > 25:
                raise ValueError(f"{name} measured {cents:.1f} cents from expected pitch.")
            pitch_checks[name] = {"expectedMidi": SAMPLES[name]["midi"],
                                  "measuredHz": frequency, "centsError": cents}
        mix, piano, drums, truth, trims, mix_peak = assemble_fixture(loaded, chords=True)
    except ValueError as exc:
        parser.error(str(exc))

    source = args.output.with_name(args.output.stem + "-mix.wav")
    piano_path = args.output.with_name(args.output.stem + "-piano-reference.wav")
    drums_path = args.output.with_name(args.output.stem + "-drums-reference.wav")
    for path, audio in ((source, mix), (piano_path, piano), (drums_path, drums)):
        write_audio(path, audio)

    report = {
        "fixture": ("Recorded CC0 instrument samples assembled into a deterministic 30-second "
                    "synthetic I–iii–V–I progression with a regular kick/snare/closed-hat groove; "
                    "not a live performance or representative production mix."),
        "durationSeconds": 30, "sampleRate": RATE, "mixPeak": mix_peak,
        "referenceWav": str(source.resolve()), "referenceSha256": file_sha256(source),
        "referenceStems": {
            "piano": {"path": str(piano_path.resolve()), "sha256": file_sha256(piano_path)},
            "drums": {"path": str(drums_path.resolve()), "sha256": file_sha256(drums_path)},
        },
        "samples": {name: {**details, "localSha256": file_sha256(
            args.samples / details["filename"]), "trimmedLeadingSilenceSeconds": trims[name]}
                    for name, details in SAMPLES.items()},
        "pitchChecks": pitch_checks, "truth": truth,
        "processor": {"machine": platform.machine(), "processor": platform.processor()},
        "variants": {}, "runs": {},
        "metrics": {
            "piano": "One-to-one MIDI pitch/onset ±150 ms; offset ±max(50 ms, 20% duration).",
            "drums": "One-to-one onset ±50 ms; kick/snare/merged-hat F1.",
            "chords": "100 ms frame accuracy including uncovered and unknown frames.",
            "beat": "One-to-one beat onset ±80 ms against 1-second fixture pulse; no downbeat truth.",
            "separation": "Aligned least-squares source projection; artifacts/residual reported separately.",
        },
        "unmeasured": {
            "instrumentNegativeTests": "Auto mode always selects piano and drums; this positive mix "
                                       "cannot measure false instrument presence on absent-instrument audio.",
            "downbeats": "No independently accented meter/downbeat labels in this drum pattern.",
            "otherInstruments": "No labelled guitar, bass, vocals, toms or open-hat material.",
            "generalization": "One assembled sample set, one arrangement and one designed key; "
                              "no live-performance or held-out-song estimate.",
        },
        "limits": [
            "All variants use the identical WAV, labelled events, metric thresholds and cached model files.",
            "An E-major design label is one musical interpretation; a single key example cannot "
            "establish key-detection accuracy across songs.",
            "Source snippets are onset-aligned, peak-scaled, resampled and cropped; tails are "
            "not necessarily the original played note releases.",
            "Model-backed auto may recover spectrally or fall back to DSP; inspect actualMethods.",
            "Per-stage seconds include setup/probe and downstream effects; wall-clock is not "
            "the sum of diagnostics; first run includes cold initialization.",
        ],
    }
    workspace = args.output.with_name(args.output.stem + "-work")
    workspace.mkdir()
    with nullcontext(workspace) as temporary:
        previous = {name: os.environ.get(name) for name in
                    ("MIZAN_HOME", "MIZAN_SEPARATOR", "MIZAN_PIANO", "MIZAN_BEATS", "MIZAN_PROVIDER")}
        os.environ.update(MIZAN_HOME=str(temporary), MIZAN_PROVIDER="auto")
        try:
            model_dir = Path(temporary) / "models"
            stage_models(args.models_from, model_dir)
            for name in args.variants:
                settings = VARIANTS[name]
                os.environ.update({f"MIZAN_{stage.upper()}": value for stage, value in settings.items()})
                report["variants"][name] = {**settings, "provider": "auto"}
                analysis = Path(temporary) / name
                analysis.mkdir()
                started = time.perf_counter()
                song = analyze_decoded(source, analysis, title="CC0 real-sample reference",
                                       url="local-cc0-fixture", instrument="auto",
                                       report=lambda stage, progress: None, cancelled=Event())
                elapsed = time.perf_counter() - started
                report["runs"][name] = score_run(song, analysis, piano, drums, truth, elapsed)
                report["peakHostWorkingSetMiBSoFar"] = peak_memory_mib()
                args.output.write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
                print(f"{name}: {elapsed:.1f}s; {report['runs'][name]['actualMethods']}", flush=True)
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    report["peakHostWorkingSetMiB"] = peak_memory_mib()
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    print(f"Full report: {args.output}")


if __name__ == "__main__":
    main()
