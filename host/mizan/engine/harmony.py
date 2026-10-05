import math
import json
import logging
import os
from threading import Event

import numpy as np
from scipy.signal import find_peaks

from .audio import Audio, spectra
from .models import BEAT_THIS, BEAT_THIS_FRONTEND, ensure_model
from .providers import PROVIDER_ERRORS, VerifiedModel, check_cancel

logger = logging.getLogger(__name__)

NAMES = ("C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B")
QUALITIES = {"": (0, 4, 7), "m": (0, 3, 7), "7": (0, 4, 7, 10),
             "maj7": (0, 4, 7, 11), "m7": (0, 3, 7, 10), "sus4": (0, 5, 7)}
KEY_PROFILES = {
    "major": np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]),
    "minor": np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]),
}


def features(audio: Audio, cancelled: Event | None = None):
    chroma, energy, flux, times = [], [], [], []
    previous = None
    size, hop = 4096, 256
    for seconds, magnitude in spectra(audio, size, hop, cancelled):
        for row in magnitude:
            peaks, _ = find_peaks(row)
            peaks = peaks[(peaks > 5) & (peaks < size // 2 - 1)]
            peaks = peaks[row[peaks] > max(1e-6, row.max() * 0.06)]
            values = row[peaks]
            denominator = row[peaks - 1] - 2 * values + row[peaks + 1]
            correction = np.divide(0.5 * (row[peaks - 1] - row[peaks + 1]), denominator,
                                   out=np.zeros_like(values), where=abs(denominator) > 1e-9)
            frequency = (peaks + correction) * audio.rate / size
            midi = np.rint(69 + 12 * np.log2(np.maximum(frequency, 1) / 440)).astype(int)
            valid = (midi >= 36) & (midi <= 96)
            chroma.append(np.bincount(midi[valid] % 12, weights=values[valid], minlength=12))
            compressed = np.log1p(row)
            flux.append(float(np.maximum(0, compressed - previous).sum()) if previous is not None else float(compressed.sum()))
            previous = compressed
            energy.append(float(np.sqrt(np.mean(row ** 2))) / size)
        times.extend(seconds)
    return np.asarray(times), np.asarray(chroma), np.asarray(energy), np.asarray(flux)


def beat_grid(times, flux, duration: float) -> dict:
    if len(times) < 3 or np.max(flux) < 1e-5:
        return {"bpm": 120.0, "confidence": 0.0, "times": [], "phaseSeconds": 0.0,
                "downbeats": [], "meterConfidence": 0.0}
    step = float(times[1] - times[0])
    peaks, _ = find_peaks(flux, distance=max(1, round(0.20 / step)),
                          prominence=max(float(np.max(flux)) * 0.12, 1e-5))
    if flux[0] > np.max(flux) * 0.3:
        peaks = np.insert(peaks, 0, 0)
    onset_times = times[peaks]
    intervals = np.diff(onset_times)
    valid = intervals[(intervals >= 0.30) & (intervals <= 1.0)]
    if len(valid) < 2:
        return {"bpm": 120.0, "confidence": 0.0, "times": onset_times.tolist(),
                "phaseSeconds": 0.0, "downbeats": [], "meterConfidence": 0.0}
    period = float(np.median(valid))
    # Fit all onset positions after accounting for missed beats. A median of
    # alternating attack latencies alone accumulates audible drift on long clips.
    beat_numbers = np.r_[0, np.cumsum(np.maximum(1, np.rint(intervals / period)))]
    period, intercept = np.polyfit(beat_numbers, onset_times, 1)
    period = float(period)
    regularity = float(np.mean(abs(intervals - np.diff(beat_numbers) * period) < 0.08))
    bpm = round(60 / period, 3)
    phase = float(intercept % period)
    grid = np.arange(phase, duration, period)
    return {"bpm": bpm, "confidence": regularity * min(1, len(valid) / 8),
            "times": grid.tolist(), "phaseSeconds": phase,
            "downbeats": grid[::4].tolist(), "meterConfidence": 0.0}


def learned_beat_grid(audio: Audio, cancelled: Event | None = None) -> tuple[dict, dict]:
    model_path = ensure_model(BEAT_THIS, cancelled)
    frontend_path = ensure_model(BEAT_THIS_FRONTEND, cancelled)
    frontend = json.loads(frontend_path.read_text(encoding="utf-8"))
    samples = audio.resampled(frontend["sample_rate"]).mono()
    size, hop = frontend["n_fft"], frontend["hop_length"]
    padded = np.pad(samples, (size // 2, size // 2), mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, size)[::hop]
    magnitude = np.abs(np.fft.rfft(frames * np.asarray(frontend["window"], np.float32), axis=1))
    magnitude /= math.sqrt(size)
    mel = magnitude @ np.asarray(frontend["mel_filters"], np.float32).T
    spectrogram = np.log1p(1000 * mel).astype(np.float32)
    chunk, overlap = 1500, 250
    logits = [np.zeros(len(spectrogram), np.float32), np.zeros(len(spectrogram), np.float32)]
    weights = np.zeros(len(spectrogram), np.float32)
    model = None
    for start in range(0, len(spectrogram), chunk - overlap):
        check_cancel(cancelled)
        stop = min(start + chunk, len(spectrogram))
        feeds = {"spectrogram": spectrogram[None, start:stop]}
        output = model.run(feeds) if model else None
        if model is None:
            model = VerifiedModel(model_path, feeds, cancelled=cancelled)
            output = model.first_output
        for index in range(2):
            logits[index][start:stop] += output[index][0]
        weights[start:stop] += 1
        if stop == len(spectrogram):
            break
    beat, downbeat = (value / np.maximum(weights, 1e-8) for value in logits)
    beat_peaks, _ = find_peaks(beat, distance=7, height=0)
    downbeat_peaks, _ = find_peaks(downbeat, distance=7, height=0)
    beat_times = beat_peaks * hop / frontend["sample_rate"]
    downbeat_times = downbeat_peaks * hop / frontend["sample_rate"]
    if len(beat_times):
        downbeat_times = np.unique([beat_times[np.argmin(abs(beat_times - value))]
                                    for value in downbeat_times])
    intervals = np.diff(beat_times)
    stable = intervals[(intervals >= 0.28) & (intervals <= 1.1)]
    if len(stable) < 2:
        raise ModelFailed("Beat This! did not find a stable beat sequence.")
    period = float(np.median(stable))
    bpm = 60 / period
    while bpm < 70:
        bpm *= 2
    while bpm > 190:
        bpm /= 2
    confidence = float(np.mean(abs(stable - np.median(stable)) < 0.08))
    grid = {"bpm": round(bpm, 3), "confidence": confidence, "times": beat_times.tolist(),
            "phaseSeconds": float(beat_times[0]), "downbeats": downbeat_times.tolist(),
            "meterConfidence": confidence if len(downbeat_times) >= 2 else 0.0}
    return grid, {"method": "beat-this-final0", "model": BEAT_THIS, "provider": model.report}


def inferred_beats_per_bar(timing: dict) -> int:
    downbeats = np.asarray(timing["downbeats"])
    if timing["meterConfidence"] < 0.65 or len(downbeats) < 4:
        return 4
    period = 60 / timing["bpm"]
    intervals = np.diff(downbeats) / period
    # An unbroken three-quarter-note downbeat cycle is evidence for 3/4,
    # but does not distinguish it from 6/8; never infer the latter from audio alone.
    return 3 if np.all(abs(intervals - 3) < 0.18) else 4


def detect_key(chroma: np.ndarray) -> dict | None:
    vector = chroma.sum(axis=0) if chroma.ndim == 2 else chroma
    if vector.sum() < 1e-7 or np.std(vector) < 1e-7:
        return None
    scored = [(float(np.corrcoef(vector, np.roll(profile, root))[0, 1]), root, mode)
              for mode, profile in KEY_PROFILES.items() for root in range(12)]
    scored.sort(reverse=True)
    score, root, mode = scored[0]
    if score < 0.55 or score - scored[1][0] < 0.04:
        return None
    return {"tonic": NAMES[root], "mode": mode}


def numeral(root: int, quality: str, key: dict | None) -> tuple[str | None, str | None]:
    if not key:
        return None, None
    tonic = NAMES.index(key["tonic"])
    interval = (root - tonic) % 12
    scale = (0, 2, 4, 5, 7, 9, 11) if key["mode"] == "major" else (0, 2, 3, 5, 7, 8, 10)
    romans = ("I", "II", "III", "IV", "V", "VI", "VII")
    if quality == "7" and interval != 7:
        target = (interval + 5) % 12
        if target in scale:
            degree = scale.index(target)
            target_name = romans[degree]
            minor_degrees = (1, 2, 5) if key["mode"] == "major" else (0, 3, 4)
            if degree in minor_degrees:
                target_name = target_name.lower()
            return "V7/" + target_name, "dominant"
    if interval in scale:
        degree = scale.index(interval)
        text = romans[degree]
    else:
        degree = next((i for i, pc in enumerate(scale) if (pc - interval) % 12 == 1), None)
        if degree is None:
            return None, None
        text = "b" + romans[degree]
    if quality.startswith("m") and quality != "maj7":
        text = text.lower()
    text += {"m": "", "7": "7", "m7": "7", "maj7": "maj7", "sus4": "sus4", "": ""}[quality]
    role = "tonic" if degree in (0, 2, 5) else "predominant" if degree in (1, 3) else "dominant"
    return text, role


def classify_chord(vector: np.ndarray, energy: float, key: dict | None = None) -> dict:
    empty = {"symbol": None, "numeral": None, "role": None, "tones": [], "flats": False, "confidence": 0.0}
    if energy < 1e-6:
        return {**empty, "symbol": "N.C.", "confidence": 1.0}
    maximum = float(vector.max())
    if maximum < 1e-6:
        return empty
    normalized = vector / maximum
    if np.count_nonzero(normalized > 0.22) < 3:
        return empty
    candidates = []
    for root in range(12):
        for quality, offsets in QUALITIES.items():
            pcs = [(root + offset) % 12 for offset in offsets]
            inside = normalized[pcs]
            outside = np.delete(normalized, pcs)
            score = float(inside.mean() - outside.mean() * 0.8 - (1 - inside.min()) * 0.35)
            candidates.append((score, root, quality, pcs))
    candidates.sort(reverse=True)
    score, root, quality, pcs = candidates[0]
    margin = score - candidates[1][0]
    confidence = float(np.clip(score * 0.7 + margin, 0, 1))
    if score < 0.45 or margin < 0.045:
        return {**empty, "confidence": min(confidence, 0.39)}
    roman, role = numeral(root, quality, key)
    return {"symbol": NAMES[root] + quality, "numeral": roman, "role": role,
            "tones": [60 + root + offset for offset in QUALITIES[quality]],
            "flats": root in (1, 3, 5, 6, 8, 10), "confidence": confidence}


def smooth_chords(chords: list[dict]) -> list[dict]:
    result = [dict(chord) for chord in chords]
    for i in range(1, len(chords) - 1):
        before, current, after = chords[i - 1:i + 2]
        if (before["symbol"] is not None and before["symbol"] != "N.C."
                and before["symbol"] == after["symbol"] != current["symbol"]
                and current["symbol"] != "N.C." and current["confidence"] < 0.55
                and current["beats"] <= 1):
            result[i] = {**before, "startBeat": current["startBeat"], "beats": current["beats"],
                         "confidence": min(before["confidence"], after["confidence"], 0.55)}
    merged: list[dict] = []
    for chord in result:
        if (merged and merged[-1]["symbol"] == chord["symbol"]
                and math.isclose(merged[-1]["startBeat"] + merged[-1]["beats"], chord["startBeat"])):
            previous = merged[-1]
            total = previous["beats"] + chord["beats"]
            previous["confidence"] = (previous["confidence"] * previous["beats"] + chord["confidence"] * chord["beats"]) / total
            previous["beats"] = total
        else:
            merged.append(dict(chord))
    return merged


def contiguous_chords(chords: list[dict]) -> list[dict]:
    return smooth_chords(chords)


def align_chord_changes(chords: list[dict], times: np.ndarray, chroma: np.ndarray, bpm: float) -> list[dict]:
    aligned = [dict(chord) for chord in chords]
    early_window = min(0.75, 1.35 * 60 / bpm)
    late_window = min(0.3, 0.55 * 60 / bpm)
    for i in range(1, len(aligned)):
        previous, current = aligned[i - 1:i + 1]
        if not previous["symbol"] or not current["symbol"] or "N.C." in (previous["symbol"], current["symbol"]):
            continue
        old = {tone % 12 for tone in previous["tones"]}
        new = {tone % 12 for tone in current["tones"]}
        old_only, new_only = sorted(old - new), sorted(new - old)
        if not old_only or not new_only:
            continue
        boundary = current["startBeat"] * 60 / bpm
        selected = (times >= boundary - early_window) & (times <= boundary + late_window)
        frames = chroma[selected]
        if len(frames) < 16 or frames.sum() < 1e-5:
            continue
        old_strength, new_strength = frames[:, old_only].sum(axis=1), frames[:, new_only].sum(axis=1)
        contrast = (new_strength - old_strength) / np.maximum(new_strength + old_strength, 1e-5)
        contrast = np.convolve(contrast, np.ones(5) / 5, mode="same")
        crossings = np.flatnonzero((contrast[:-1] <= 0) & (contrast[1:] > 0))
        for j in sorted(crossings, key=lambda j: abs(times[selected][j] - boundary)):
            if j < 7 or j + 7 >= len(contrast):
                continue
            if np.median(contrast[j - 6:j - 2]) > -0.35 or np.median(contrast[j + 3:j + 7]) < 0.35:
                continue
            t = times[selected]
            onset = np.interp(0, contrast[j:j + 2], t[j:j + 2])
            new_beat = float(onset * bpm / 60)
            end = current["startBeat"] + current["beats"]
            if previous["startBeat"] < new_beat < end:
                previous["beats"] = new_beat - previous["startBeat"]
                current["startBeat"] = new_beat
                current["beats"] = end - new_beat
            break
    return aligned


def analyze_harmony(audio: Audio, cancelled: Event | None = None) -> dict:
    times, chroma, energy, flux = features(audio, cancelled)
    beat_details = {"method": "onset-grid-v2", "provider": {"effectiveProviders": ["CPU-DSP"]}}
    if os.environ.get("MIZAN_BEATS", "auto").lower() == "auto":
        try:
            timing, beat_details = learned_beat_grid(audio, cancelled)
        except (ModelFailed, *PROVIDER_ERRORS, OSError, ValueError) as exc:
            logger.warning("Beat This! unavailable: %s", exc)
            timing = beat_grid(times, flux, audio.duration)
    else:
        timing = beat_grid(times, flux, audio.duration)
    bpm = timing["bpm"]
    beats_per_bar = inferred_beats_per_bar(timing)
    key = detect_key(chroma)
    total_beats = audio.duration * bpm / 60
    bars = max(1, math.ceil(total_beats / beats_per_bar))
    chords = []
    for beat in range(math.ceil(total_beats)):
        check_cancel(cancelled)
        selected = (times >= beat * 60 / bpm) & (times < min(beat + 1, total_beats) * 60 / bpm)
        vector = chroma[selected].mean(axis=0) if selected.any() else np.zeros(12)
        strength = float(energy[selected].mean()) if selected.any() else 0.0
        chords.append({"startBeat": float(beat), "beats": min(1.0, total_beats - beat),
                       **classify_chord(vector, strength, key)})
    sections = []
    section_energy = []
    for first in range(0, bars, 4):
        selected = (times >= first * beats_per_bar * 60 / bpm) & (times < (first + 4) * beats_per_bar * 60 / bpm)
        sections.append({"name": f"Bars {first + 1}-{min(first + 4, bars)}",
                         "startBar": first + 1, "bars": min(4, bars - first)})
        section_energy.append(float(energy[selected].mean()) if selected.any() else 0.0)
    maximum = max(section_energy, default=0)
    aligned = align_chord_changes(contiguous_chords(chords), times, chroma, bpm)
    return {"bpm": bpm, "beatsPerBar": beats_per_bar, "beatUnit": 4, "bars": bars, "key": key,
            "sections": sections, "chords": aligned, "timing": timing,
            "beatDetails": beat_details,
            "sectionEnergy": [value / maximum if maximum else 0 for value in section_energy],
            "warnings": [("Downbeat spacing suggests 3/4, but 6/8 is indistinguishable from these beat timestamps; "
                          "verify the meter and numbered bar groups." if beats_per_bar == 3 else
                          "Meter/downbeat and section semantics are unverified; using 4/4 and numbered bar groups.")]
            + (["Tempo is uncertain; the display uses a 120 BPM grid."] if timing["confidence"] == 0 else [])}
