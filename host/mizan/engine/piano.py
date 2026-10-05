import logging
import math
import os
from threading import Event

import numpy as np
from scipy.signal import find_peaks

from ..errors import ModelFailed
from .audio import Audio, spectra
from .models import BASIC_PITCH, ensure_model
from .pitch_refinement import refine_pitches
from .providers import PROVIDER_ERRORS, VerifiedModel, check_cancel

logger = logging.getLogger(__name__)


def assign_hands(notes: list[dict]) -> list[dict]:
    result = sorted((dict(note) for note in notes), key=lambda note: (note["onset"], note["midi"]))
    previous = {"left": 48, "right": 72}
    active: list[dict] = []
    for note in result:
        active = [other for other in active if other["offset"] > note["onset"]]
        pitch = note["midi"]
        if pitch < 55:
            hand = "left"
        elif pitch >= 65:
            hand = "right"
        else:
            costs = {}
            for candidate in ("left", "right"):
                assigned = [other["midi"] for other in active if other["hand"] == candidate]
                span = max([pitch, *assigned]) - min([pitch, *assigned])
                register_penalty = max(0, pitch - 60) if candidate == "left" else max(0, 60 - pitch)
                costs[candidate] = abs(pitch - previous[candidate]) + max(0, span - 12) * 3 + register_penalty * 0.5
            hand = min(costs, key=costs.get)
        note["hand"] = hand
        previous[hand] = pitch
        active.append(note)
    return result


def sustain_notes(notes: list[dict], *, max_gap: float = 0.30) -> list[dict]:
    ordered = sorted((dict(note) for note in notes), key=lambda note: (note["midi"], note["onset"]))
    merged = []
    for note in ordered:
        duration = note["offset"] - note["onset"]
        if duration < 0.07 or note.get("confidence", 0) < 0.12 \
                or (duration < 0.12 and note.get("confidence", 0) < 0.45):
            continue
        gap = note["onset"] - merged[-1]["offset"] if merged else math.inf
        if merged and merged[-1]["midi"] == note["midi"] and 0 < gap <= max_gap:
            previous = merged[-1]
            duration = previous["offset"] - previous["onset"] + note["offset"] - note["onset"]
            previous["confidence"] = (
                previous["confidence"] * (previous["offset"] - previous["onset"])
                + note["confidence"] * (note["offset"] - note["onset"])
            ) / max(duration, 1e-9)
            previous["offset"] = max(previous["offset"], note["offset"])
            previous["velocity"] = max(previous["velocity"], note["velocity"])
        else:
            merged.append(note)
    return assign_hands(sorted(merged, key=lambda note: (note["onset"], note["midi"])))


def reinforce_sustain(notes: list[dict], reference: list[dict]) -> list[dict]:
    result = [dict(note) for note in notes]
    for index, note in enumerate(result):
        next_onset = next((later["onset"] for later in result[index + 1:]
                           if abs(later["midi"] - note["midi"]) < 0.15), math.inf)
        matches = [other for other in reference
                   if abs(other["midi"] - note["midi"]) < 0.15
                   and abs(other["onset"] - note["onset"]) <= 0.12]
        if matches:
            note["offset"] = min(next_onset, max(note["offset"], max(other["offset"] for other in matches)))
    return result


def activation_notes(activation: np.ndarray, step: float, duration: float, *,
                     onset: np.ndarray | None = None, threshold: float = 0.3,
                     confidence_cap: float = 1.0, sustain: bool = True) -> list[dict]:
    notes = []
    for pitch in range(88):
        values = activation[:, pitch]
        start = None
        for i in range(len(values) + 1):
            value = values[i] if i < len(values) else 0
            sounding = value >= (threshold * 0.55 if start is not None else threshold)
            repeated = (sounding and start is not None and (i - start) * step > 0.12
                        and onset is not None and onset[i, pitch] >= 0.5
                        and onset[i, pitch] > onset[i - 1, pitch]
                        and (i + 1 == len(values) or onset[i, pitch] >= onset[i + 1, pitch]))
            if start is not None and (not sounding or repeated):
                begin, end = max(0.0, start * step), min(duration, i * step)
                strength = float(values[start:i].mean())
                if end - begin >= 0.09 and strength >= threshold:
                    notes.append({"midi": pitch + 21, "onset": begin, "offset": end,
                                  "velocity": float(np.clip(strength, 0.1, 1)),
                                  "confidence": min(confidence_cap, strength), "generated": False})
                start = None
            if sounding and start is None:
                start = i
    return sustain_notes(notes) if sustain else notes


def spectral_piano(audio: Audio, cancelled: Event | None = None) -> list[dict]:
    size, hop = 8192, 256
    activations = []
    for _, magnitude in spectra(audio, size, hop, cancelled):
        for row in magnitude:
            peaks, _ = find_peaks(row)
            peaks = peaks[(peaks > 1) & (peaks < len(row) - 1)]
            peaks = peaks[row[peaks] > max(1e-3, row.max() * 0.12)]
            values = row[peaks]
            denominator = row[peaks - 1] - 2 * values + row[peaks + 1]
            correction = np.divide(0.5 * (row[peaks - 1] - row[peaks + 1]), denominator,
                                   out=np.zeros_like(values), where=abs(denominator) > 1e-8)
            frequencies = (peaks + correction) * audio.rate / size
            pitches = np.rint(69 + 12 * np.log2(np.maximum(frequencies, 1) / 440)).astype(int)
            frame = np.zeros(88)
            for index, (frequency, pitch, value) in enumerate(zip(frequencies, pitches, values)):
                if not 21 <= pitch <= 108:
                    continue
                lower = frequencies[:index]
                ratios = frequency / np.maximum(lower, 1)
                harmonic = ((np.abs(ratios - np.rint(ratios)) < 0.035) & (ratios >= 1.95)
                            & (values[:index] > value * 2)).any()
                if not harmonic:
                    frame[pitch - 21] = max(frame[pitch - 21], float(value))
            activations.append(frame)
    matrix = np.asarray(activations)
    maximum = float(matrix.max())
    if maximum < 0.02:
        return []
    matrix /= maximum
    return activation_notes(matrix, hop / audio.rate, audio.duration, threshold=0.16, confidence_cap=0.65)


def basic_pitch(audio: Audio, cancelled: Event | None = None, progress=None, *,
                melody: bool = False, on_model=None) -> tuple[list[dict], dict]:
    model_path = ensure_model(cancelled=cancelled)
    samples = audio.resampled(22050).mono()
    window_size, overlap, step = 43844, 7680, 256 / 22050
    hop = window_size - overlap
    padded = np.pad(samples, (overlap // 2, window_size))
    frames = int(np.ceil(audio.duration / step))
    activation = np.zeros((frames, 88), dtype=np.float32)
    onsets = np.zeros_like(activation)
    model = None
    starts = range(0, len(samples) + overlap // 2, hop)
    for index, start in enumerate(starts):
        check_cancel(cancelled)
        feeds = {"serving_default_input_2:0": padded[start:start + window_size].reshape(1, window_size, 1).astype(np.float32)}
        if model is None:
            model = VerifiedModel(model_path, feeds, cancelled=cancelled)
            if on_model:
                on_model({"method": "basic-pitch", "model": BASIC_PITCH, "provider": model.report})
            output = model.first_output
        else:
            output = model.run(feeds)
            if on_model and model.report.get("runtimeFallback"):
                on_model({"method": "basic-pitch", "model": BASIC_PITCH, "provider": model.report})
        # The pinned ONNX output order is onset, note, contour. Keep center
        # frames and map using sample positions, avoiding accumulated window drift.
        note, attack = output[1][0], output[0][0]
        for local in range(15, 157):
            global_frame = round((start - overlap // 2 + local * 256) / 256)
            if 0 <= global_frame < frames:
                activation[global_frame] = np.maximum(activation[global_frame], note[local])
                onsets[global_frame] = np.maximum(onsets[global_frame], attack[local])
        if progress:
            progress((index + 1) / len(starts))
    return activation_notes(activation, step, audio.duration, onset=None if melody else onsets,
                            threshold=0.35 if melody else 0.3, sustain=not melody), {
        "method": "basic-pitch", "model": BASIC_PITCH, "provider": model.report,
        "warnings": ["Basic Pitch is instrument-agnostic; other pitched instruments can appear as piano notes."],
    }


def transcribe_piano(audio: Audio, cancelled: Event | None = None, progress=None, on_model=None) -> tuple[list[dict], dict]:
    backend = os.environ.get("MIZAN_PIANO", "auto").lower()
    if backend not in ("auto", "dsp"):
        raise ModelFailed("MIZAN_PIANO must be auto or dsp.")
    warning = "Spectral piano fallback: limited polyphony and harmonic rejection; not a trained piano model."
    if backend == "auto":
        try:
            notes, details = basic_pitch(audio, cancelled, progress, on_model=on_model)
            if not notes:
                check_cancel(cancelled)
                if on_model:
                    on_model({"method": "spectral-piano-v1", "provider": {"effectiveProviders": ["CPU-DSP"]}})
                notes = spectral_piano(audio, cancelled)
                for note in notes:
                    note["confidence"] = min(note["confidence"], 0.45)
                details["method"] += "+spectral-recovery-v1"
                details["warnings"].append(
                    "Basic Pitch recovered no notes; spectral recovery was attempted. "
                    "Any recovered notes are tentative, not verified piano.")
            notes, count = refine_pitches(notes, audio, cancelled)
            details["pitchRefinement"] = {"method": "multi-frame-harmonic-v1", "refinedNotes": count}
            details["warnings"].append(
                "Cents require isolated stable piano notes with harmonic support; "
                "polyphonic chords, noise and pedal decay retain the detected 12-tone pitch. "
                "Not maqam or key recognition.")
            return notes, details
        except (ModelFailed, *PROVIDER_ERRORS) as exc:
            warning += f" Basic Pitch unavailable: {exc}"
            logger.warning(warning)
    if on_model:
        on_model({"method": "spectral-piano-v1", "provider": {"effectiveProviders": ["CPU-DSP"]}})
    notes = spectral_piano(audio, cancelled)
    notes, count = refine_pitches(notes, audio, cancelled)
    if progress:
        progress(1.0)
    return notes, {"method": "spectral-piano-v1", "provider": {"effectiveProviders": ["CPU-DSP"]},
                   "pitchRefinement": {"method": "multi-frame-harmonic-v1", "refinedNotes": count},
                   "warnings": [warning, "Cents require isolated stable piano notes "
                                "with harmonic support; polyphony and noise retain the detected 12-tone pitch."]}
