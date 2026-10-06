import math
import json
import logging
import os
from collections import Counter
from fractions import Fraction
from threading import Event

import numpy as np
from scipy.signal import find_peaks

from ..meter import build_bar_map
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
            "downbeats": [], "meterConfidence": 0.0}


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
            "downbeatSource": "beat-this", "meterConfidence": 0.0}
    return grid, {"method": "beat-this-final0", "model": BEAT_THIS, "provider": model.report}


def _rational_span(value: float, tolerance: float = 0.04) -> float:
    for denominator in (1, 2, 4, 8, 16):
        fitted = round(value * denominator) / denominator
        if fitted > 0 and abs(fitted - value) <= tolerance:
            return fitted
    return round(value * 16) / 16


def infer_meter(timing: dict) -> dict:
    if timing.get("accentMeter") is not None:
        return timing["accentMeter"]
    try:
        bpm = float(timing["bpm"])
    except (KeyError, TypeError, ValueError):
        bpm = 0.0
    downbeats = np.asarray(timing.get("downbeats", []), dtype=float).reshape(-1)
    downbeats = np.unique(downbeats[np.isfinite(downbeats)])
    intervals = np.diff(downbeats) / (60 / bpm) if math.isfinite(bpm) and bpm > 0 else np.array([])
    rounded = [_rational_span(float(interval)) for interval in intervals]
    counts = Counter(float(value) for value, interval in zip(rounded, intervals)
                     if value >= 1 and abs(value - interval) <= 0.18)
    candidates = [length for length, count in sorted(counts.items()) if count >= 3]
    support = dict.fromkeys(candidates, 0)
    single_bar = dict.fromkeys(candidates, 0)
    ambiguous = rejected = missing_boundaries = 0
    distinct_accents = timing.get("downbeatSource") == "distinct-acoustic-accents"
    labels = []
    for interval in intervals:
        matches = []
        for meter in candidates:
            bars = round(float(interval) / meter)
            if 1 <= bars <= 4 and abs(interval - bars * meter) <= 0.18:
                matches.append((meter, bars))
        exact = [match for match in matches if match[1] == 1]
        # Recurrent, individually observed strong accents support longer groups too.
        if distinct_accents and len(exact) == 1:
            matches = exact
        if len(matches) == 1:
            meter, bars = matches[0]
            support[meter] += 1
            single_bar[meter] += bars == 1
            missing_boundaries += bars - 1
            labels.append(meter)
        elif len(matches) > 1:
            ambiguous += 1
            labels.append(None)
        else:
            rejected += 1
            labels.append(None)

    interval_count = len(intervals)
    discriminating = sum(support.values())
    support_rate = discriminating / interval_count if interval_count else 0.0
    beat_confidence = timing.get("beatConfidence", timing.get("confidence", 0.0))
    try:
        beat_confidence = float(beat_confidence)
    except (TypeError, ValueError):
        beat_confidence = 0.0
    if not math.isfinite(beat_confidence):
        beat_confidence = 0.0
    observed_period = timing.get("observedPulseSeconds")
    alias = (isinstance(observed_period, (int, float)) and math.isfinite(observed_period)
             and bpm > 0 and abs(observed_period / (60 / bpm) - 1) > 0.06)
    supported = (
        math.isfinite(bpm) and bpm > 0 and beat_confidence >= 0.65
        and not alias and bool(candidates) and discriminating >= 3 and support_rate >= 0.6
    )
    if supported:
        reason = "downbeat_spacing_supports_meter"
    elif not interval_count:
        reason = "insufficient_downbeats"
    elif beat_confidence < 0.65:
        reason = "low_beat_grid_confidence"
    elif alias:
        reason = "pulse_and_quarter_grid_disagree"
    elif discriminating < 3:
        reason = "insufficient_discriminating_intervals"
    else:
        reason = "downbeat_spacing_is_too_noisy"
    selected = next((value for value in labels if value is not None), 4) if supported else 4
    confidence = support_rate if supported else 0.0
    boundaries_verified = supported and not (ambiguous or rejected or missing_boundaries)
    changes = []
    def signature_for(length):
        fraction = Fraction(length).limit_denominator(16)
        return fraction.numerator, fraction.denominator * 4
    if supported:
        for index, length in enumerate(labels):
            if length is None:
                continue
            numerator, denominator = signature_for(length)
            if not changes or changes[-1]["numerator"] * 4 / changes[-1]["denominator"] != length:
                changes.append({
                    "startBeat": _rational_span(float(downbeats[index] * bpm / 60)),
                    "numerator": numerator, "denominator": denominator,
                    "status": "supported" if boundaries_verified else "unverified",
                })
        for width in range(2, len(labels) // 3 + 1):
            pattern = labels[-width:]
            if (None not in pattern and pattern == labels[-2 * width:-width]
                    and pattern == labels[-3 * width:-2 * width]):
                length = pattern[0]
                numerator, denominator = signature_for(length)
                if (changes[-1]["numerator"], changes[-1]["denominator"]) != (numerator, denominator):
                    changes.append({
                        "startBeat": _rational_span(float(downbeats[-1] * bpm / 60)),
                        "numerator": numerator, "denominator": denominator,
                        "status": "supported" if boundaries_verified else "unverified",
                    })
                break
        if changes[0]["startBeat"] < 0.18:
            changes[0]["startBeat"] = 0.0
        else:
            changes.insert(0, {**changes[0], "startBeat": 0.0, "status": "unverified"})
            boundaries_verified = False
    else:
        changes = [{"startBeat": 0.0, "numerator": 4, "denominator": 4, "status": "unverified"}]
    def name(length):
        numerator, denominator = signature_for(length)
        return f"{numerator}/{denominator}"
    return {
        "beatsPerBar": selected,
        "confidence": round(confidence, 3),
        "supported": supported,
        "fallback": not supported,
        "method": "observed-boundary-consensus-v2",
        "confidenceMeaning": "observed interval support rate; not a calibrated probability",
        "spellingVerified": False,
        "boundariesVerified": boundaries_verified,
        "spellingReason": "Acoustic grouping does not resolve written denominator or tempo subdivision.",
        "reason": reason,
        "changes": changes,
        "evidence": {
            "intervals": interval_count,
            "ambiguous": ambiguous,
            "rejected": rejected,
            "missingBoundaries": missing_boundaries,
            "singleBarSupport": {name(meter): count for meter, count in single_bar.items()},
        },
        "candidates": {
            name(meter): {
                "supportIntervals": support[meter],
                "supportRate": round(support[meter] / interval_count, 3) if interval_count else 0.0,
            }
            for meter in candidates
        },
    }


def inferred_beats_per_bar(timing: dict) -> float:
    return infer_meter(timing)["beatsPerBar"]


def acoustic_features(audio: Audio, cancelled: Event | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Short RMS frames retain accents that the harmonic FFT window smears together."""
    size = max(1, round(audio.rate * 0.01))
    samples = audio.mono()
    energies = []
    for first in range(0, len(samples), size * 10000):
        check_cancel(cancelled)
        chunk = samples[first:first + size * 10000]
        frames = np.pad(chunk, (0, (-len(chunk)) % size)).reshape(-1, size)
        energies.extend(np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1)).tolist())
    return np.arange(len(energies)) * size / audio.rate, np.asarray(energies)


def _distinct_accents(attack: np.ndarray, peaks: np.ndarray) -> np.ndarray | None:
    if len(peaks) < 12:
        return None
    heights = attack[peaks]
    centers = np.quantile(heights, [0.25, 0.85])
    for _ in range(12):
        high = abs(heights - centers[1]) < abs(heights - centers[0])
        if not np.any(high) or np.all(high):
            return None
        centers = np.array([heights[~high].mean(), heights[high].mean()])
    spread = float(heights[high].std() + heights[~high].std())
    return high if (centers[1] >= centers[0] * 1.4 and centers[1] - centers[0] > spread * 2
                    and heights[high].std() <= centers[1] * 0.2) else None


def acoustic_beat_grid(times: np.ndarray, energy: np.ndarray, duration: float,
                       cancelled: Event | None = None) -> tuple[dict, dict] | None:
    """Find local pulse and accent recurrence without treating model labels as bar boundaries."""
    if len(times) < 3 or not np.any(energy > 1e-7):
        return None
    step = float(np.median(np.diff(times)))
    level = max(float(np.median(energy[energy > 0])), 1e-8)
    envelope = np.log1p(energy / level * 10)
    attack = np.maximum(0, np.diff(envelope, prepend=0))
    attack = np.convolve(attack, np.ones(3) / 3, mode="same")
    global_peaks, _ = find_peaks(attack, distance=max(1, round(0.12 / step)))
    if attack[0] > 0 and (not len(global_peaks) or global_peaks[0] * step > 0.12):
        global_peaks = np.r_[0, global_peaks]
    peak_energy = np.maximum.reduce([energy, np.r_[energy[1:], 0], np.r_[energy[2:], 0, 0]])
    high = _distinct_accents(peak_energy, global_peaks)
    ordinary_period = None
    if high is not None:
        gaps = np.diff(times[global_peaks[~high]])
        eligible = gaps[(gaps >= 0.28) & (gaps <= 1.1)]
        if len(eligible) >= 8:
            for trial in sorted(set(np.round(eligible / step) * step)):
                direct = eligible[abs(eligible / trial - 1) <= 0.06]
                multiples = np.rint(eligible / trial)
                if (len(direct) >= 8 and np.mean((multiples >= 1)
                        & (abs(eligible / trial - multiples) <= 0.06)) >= 0.85):
                    ordinary_period = float(np.median(direct))
                    break
    width = min(len(times), round(16 / step))
    if width * step < 6:
        return None
    windows = []
    for first in range(0, max(1, len(times) - width + 1), max(1, round(4 / step))):
        check_cancel(cancelled)
        values = attack[first:first + width]
        if np.std(values) < 1e-5:
            continue
        max_lag = len(values) // 3
        correlations = np.zeros(max_lag + 1)
        for lag in range(max(1, round(0.25 / step)), max_lag + 1):
            left, right = values[:-lag], values[lag:]
            left, right = left - left.mean(), right - right.mean()
            denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
            correlations[lag] = float(left @ right) / denominator if denominator else 0.0
        peaks, _ = find_peaks(correlations, distance=max(1, round(0.08 / step)))
        pulses = [int(index) for index in peaks if 0.28 <= index * step <= 1.1
                  and correlations[index] >= 0.08]
        if not pulses:
            continue
        strongest = max(float(correlations[index]) for index in pulses)
        pulse_index = min(index for index in pulses if correlations[index] >= strongest * 0.7)
        correction = 0.0
        if 0 < pulse_index < len(correlations) - 1:
            left, middle, right = correlations[pulse_index - 1:pulse_index + 2]
            divisor = left - 2 * middle + right
            if abs(divisor) > 1e-9:
                correction = float(np.clip(0.5 * (left - right) / divisor, -0.5, 0.5))
        period = ordinary_period if ordinary_period is not None else (pulse_index + correction) * step
        attack_peaks, _ = find_peaks(values, distance=max(1, round(0.12 / step)))
        if len(attack_peaks) < 4:
            continue
        accent = np.maximum(values - float(np.quantile(values[attack_peaks], 0.65)), 0)
        accent_correlations = np.zeros_like(correlations)
        for lag in range(max(1, round(0.25 / step)), max_lag + 1):
            left, right = accent[:-lag], accent[lag:]
            left, right = left - left.mean(), right - right.mean()
            denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
            accent_correlations[lag] = float(left @ right) / denominator if denominator else 0.0
        accent_peaks, _ = find_peaks(accent_correlations, distance=max(1, round(0.08 / step)))
        groups = []
        for index in accent_peaks:
            length = _rational_span(index * step / period)
            score = float(accent_correlations[index])
            if (length > 1 and abs(index * step / period - length) <= 0.08
                    and score >= 0.08 and score - accent_correlations[pulse_index] >= 0.015):
                groups.append((length, score, int(index)))
        group = None
        if groups:
            maximum = max(score for _, score, _ in groups)
            group = min(length for length, score, _ in groups if score >= maximum * 0.6)
        windows.append({"first": first, "period": period, "group": group,
                        "pulseCorrelation": float(correlations[pulse_index]),
                        "pulseAccentCorrelation": float(accent_correlations[pulse_index]),
                        "groups": [(length, score) for length, score, _ in groups]})
    if not windows:
        return None
    period = float(np.median([window["period"] for window in windows]))
    coherent = [window for window in windows if abs(window["period"] / period - 1) <= 0.06]
    consistency = len(coherent) / len(windows)
    if len(coherent) < 2 or consistency < 0.65:
        return None
    # Distinct recurring accents can locate individual bars, including alternating meters.
    boundary_meter = None
    if high is not None:
        points = times[global_peaks[high]]
        candidate = infer_meter({
            "bpm": 60 / period, "beatConfidence": consistency,
            "observedPulseSeconds": period, "downbeats": points.tolist(),
            "downbeatSource": "distinct-acoustic-accents",
        })
        if (candidate["supported"] and candidate["confidence"] >= 0.85
                and candidate["evidence"]["intervals"] >= 8
                and all(change["numerator"] * 4 / change["denominator"] > 1
                        for change in candidate["changes"])):
            positions = np.r_[0, np.cumsum([_rational_span(float(gap) / period)
                                            for gap in np.diff(points)])]
            fitted_period, _ = np.polyfit(positions, points, 1)
            if abs(fitted_period / period - 1) <= 0.06:
                period = float(fitted_period)
            snapped_points = np.array([_rational_span(float(point) / period)
                                       if point > 0 else 0 for point in points]) * period
            snapped = infer_meter({
                "bpm": 60 / period, "beatConfidence": consistency,
                "observedPulseSeconds": period, "downbeats": snapped_points.tolist(),
                "downbeatSource": "distinct-acoustic-accents",
            })
            boundary_meter = {
                **snapped, "confidence": candidate["confidence"],
                "method": "distinct-accent-boundary-consensus-v1",
                "confidenceMeaning": "recurring distinct-accent interval support rate; not calibrated",
            }
    group_counts = Counter(window["group"] for window in coherent if window["group"] is not None)
    recurring = []
    for length in sorted(group_counts):
        independent = []
        for window in coherent:
            if window["group"] == length and (not independent or window["first"] - independent[-1] >= width):
                independent.append(window["first"])
        if len(independent) >= 2:
            recurring.append(length)
    primitives = [length for length in recurring if not any(
        shorter < length and math.isclose(length / shorter, round(length / shorter), abs_tol=0.03)
        for shorter in recurring)]
    downbeats = []
    evidence = []
    accepted_windows = []
    for window in coherent:
        first = window["first"]
        options = [(length, score) for length, score in window["groups"] if length in primitives]
        maximum = max((score for _, score in window["groups"]), default=0)
        options = [(length, score) for length, score in options
                   if score >= maximum * 0.6
                   and score - window["pulseAccentCorrelation"] >= max(
                       0.015, 0.18 * (1 - window["pulseAccentCorrelation"]))]
        length, score = min(options, default=(None, 0))
        evidence.append({
            "startSeconds": round(float(times[first]), 3),
            "pulseSeconds": round(window["period"], 4),
            "groupQuarterBeats": length,
            "pulseCorrelation": round(window["pulseCorrelation"], 3),
            "groupCorrelation": round(score, 3),
            "groupCandidates": [{"quarterBeats": group, "correlation": round(value, 3)}
                                for group, value in window["groups"]],
        })
        if length is None:
            accepted_windows.append({**window, "group": None})
            continue
        bar_period = period * length
        stop = min(first + width, len(times))
        local_times, values = times[first:stop], attack[first:stop]
        phases = (local_times % bar_period) / bar_period
        folded = np.bincount(np.floor(phases * 64).astype(int), weights=values, minlength=64)
        phase = (int(np.argmax(folded)) + 0.5) / 64 * bar_period
        accepted_windows.append({**window, "group": length, "phase": phase, "groupCorrelation": score})
        start = phase + math.ceil((float(local_times[0]) - phase) / bar_period) * bar_period
        for expected in np.arange(start, float(local_times[-1]), bar_period):
            nearby = np.flatnonzero(abs(local_times - expected) <= min(0.1, period * 0.2))
            if not len(nearby):
                continue
            peak = nearby[int(np.argmax(values[nearby]))]
            if values[peak] > np.quantile(values, 0.75):
                downbeats.append(float(local_times[peak]))
    unique = []
    for point in sorted(downbeats):
        if not unique or point - unique[-1] > period * 0.3:
            unique.append(point)
    bpm = round(60 / period, 3)
    runs = []
    for window in accepted_windows:
        if (runs and runs[-1][-1]["group"] == window["group"]
                and (window["first"] - runs[-1][-1]["first"]) * step < 4.5):
            runs[-1].append(window)
        else:
            runs.append([window])
    sustained = [run for run in runs if run[0]["group"] is not None and len(run) >= 3]
    sustained_counts = Counter(window["group"] for run in sustained for window in run)
    length, supported_count = sustained_counts.most_common(1)[0] if sustained_counts else (4, 0)
    fraction = Fraction(length).limit_denominator(16)
    changes = [{"startBeat": 0.0, "numerator": fraction.numerator,
                "denominator": fraction.denominator * 4, "status": "unverified"}] if sustained_counts else []
    supported = bool(changes) and supported_count >= 3
    meter = {
        "beatsPerBar": changes[0]["numerator"] * 4 / changes[0]["denominator"] if changes else 4,
        "confidence": round(supported_count / len(coherent), 3) if supported else 0.0,
        "supported": supported, "fallback": not supported,
        "method": "local-accent-pattern-consensus-v1",
        "confidenceMeaning": "fraction of pulse-consistent windows with recurring accent evidence; not calibrated",
        "spellingVerified": False,
        "boundariesVerified": False,
        "spellingReason": "Acoustic grouping does not resolve written denominator or tempo subdivision.",
        "reason": "accent_grouping_without_verified_boundaries" if supported else "no_sustained_accent_grouping",
        "changes": changes or [{"startBeat": 0.0, "numerator": 4, "denominator": 4, "status": "unverified"}],
        "evidence": {"windows": len(coherent), "supportedWindows": supported_count},
        "candidates": {str(length): {"windows": count} for length, count in group_counts.items()},
    }
    if boundary_meter is not None:
        meter = boundary_meter
        unique = points.tolist()
    timing = {
        "bpm": bpm, "confidence": consistency, "beatConfidence": consistency,
        "phaseSeconds": 0.0, "times": np.arange(0, duration, period).tolist(),
        "downbeats": unique, "downbeatSource": "acoustic-accent-recurrence",
        "meterConfidence": 0.0, "observedPulseSeconds": period, "accentMeter": meter,
    }
    return timing, {
        "method": "local-acoustic-pulse-accent-v1",
        "provider": {"effectiveProviders": ["CPU-DSP"]},
        "pulseSeconds": round(period, 6), "pulseConsistency": round(consistency, 3),
        "windows": evidence,
        "ambiguity": "Recurring accents establish grouping, not written denominator or tempo octave.",
    }


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
    acoustic_times, acoustic_energy = acoustic_features(audio, cancelled)
    acoustic = acoustic_beat_grid(acoustic_times, acoustic_energy, audio.duration, cancelled)
    if acoustic is None or not infer_meter(acoustic[0]).get("boundariesVerified"):
        harmonic_acoustic = acoustic_beat_grid(times, energy, audio.duration, cancelled)
        if harmonic_acoustic is not None and (acoustic is None or
                infer_meter(harmonic_acoustic[0])["confidence"] > infer_meter(acoustic[0])["confidence"]):
            acoustic = harmonic_acoustic
    if acoustic is not None:
        acoustic_timing, acoustic_details = acoustic
        acoustic_meter = infer_meter(acoustic_timing)
        learned_meter = infer_meter(timing)
        acoustic_details["alternativeBeatGrid"] = {
            "method": beat_details["method"], "bpm": timing["bpm"], "confidence": timing["confidence"],
        }
        if acoustic_meter["supported"] and (
                not learned_meter["supported"]
                or abs(acoustic_timing["bpm"] / timing["bpm"] - 1) > 0.06
                or acoustic_meter.get("boundariesVerified")):
            timing, beat_details = acoustic_timing, acoustic_details
    bpm = timing["bpm"]
    meter = infer_meter(timing)
    beats_per_bar = meter["beatsPerBar"]
    timing["beatConfidence"] = timing.get("confidence", 0.0)
    timing["meterConfidence"] = meter["confidence"]
    timing["meter"] = meter
    timing.pop("accentMeter", None)
    key = detect_key(chroma)
    total_beats = audio.duration * bpm / 60
    bar_map = build_bar_map(total_beats, meter["changes"])
    bars = len(bar_map)
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
        last = min(first + 3, bars - 1)
        selected = ((times >= bar_map[first]["startBeat"] * 60 / bpm)
                    & (times < (bar_map[last]["startBeat"] + bar_map[last]["beats"]) * 60 / bpm))
        sections.append({"name": f"Bars {first + 1}-{min(first + 4, bars)}",
                         "startBar": first + 1, "bars": min(4, bars - first)})
        section_energy.append(float(energy[selected].mean()) if selected.any() else 0.0)
    maximum = max(section_energy, default=0)
    aligned = align_chord_changes(contiguous_chords(chords), times, chroma, bpm)
    spellings = list(dict.fromkeys(f'{point["numerator"]}/{point["denominator"]}'
                                   for point in meter["changes"]))
    meter_warning = (
        f"Measured recurring groups suggest {' then '.join(spellings)}; written denominator and tempo "
        "subdivision remain unverified. "
        + ("Bar boundaries are unverified; check the tentative grouping against the recording."
           if not meter.get("boundariesVerified") else
           "Check the changing signatures and bar groups against the recording.")
        if meter["supported"] else "Meter is unverified; using 4/4 as a fallback for numbered bars."
    )
    return {"bpm": bpm, "beatsPerBar": beats_per_bar,
            "beatUnit": meter["changes"][0]["denominator"], "bars": bars, "barMap": bar_map, "key": key,
            "sections": sections, "chords": aligned, "timing": timing,
            "beatDetails": beat_details,
            "sectionEnergy": [value / maximum if maximum else 0 for value in section_energy],
            "warnings": [meter_warning]
            + (["Tempo is uncertain; the display uses a 120 BPM grid."] if timing["confidence"] == 0 else [])}
