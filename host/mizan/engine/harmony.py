import math
import json
from bisect import bisect_right
import logging
import os
from collections import Counter
from fractions import Fraction
from threading import Event

import numpy as np
from scipy.signal import find_peaks

from ..errors import ModelFailed
from ..meter import beat_at_time, build_bar_map, time_at_beat, validate_bar_map
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
            model = VerifiedModel(model_path, feeds, provider="cpu", cancelled=cancelled)
            output = model.first_output
        for index in range(2):
            logits[index][start:stop] += output[index][0]
        weights[start:stop] += 1
        if stop == len(spectrogram):
            break
    beat, downbeat = (value / np.maximum(weights, 1e-8) for value in logits)
    grid = activation_beat_grid(beat, downbeat, frontend["sample_rate"] / hop)
    return grid, {"method": "beat-this-final0", "model": BEAT_THIS, "provider": model.report,
                  "beatCleanup": grid.pop("cleanup")}


def _peak_times(values: np.ndarray, peaks: np.ndarray, fps: float) -> np.ndarray:
    """Sub-frame peak positions; the 50 fps frame grid alone aliases tempo by several percent."""
    positions = peaks.astype(float)
    inner = (peaks > 0) & (peaks < len(values) - 1)
    left, middle, right = (values[peaks[inner] + offset] for offset in (-1, 0, 1))
    divisor = left - 2 * middle + right
    positions[inner] += np.clip(np.divide(0.5 * (left - right), divisor, out=np.zeros_like(divisor),
                                          where=abs(divisor) > 1e-9), -0.5, 0.5)
    return positions / fps


def clean_beats(times) -> tuple[np.ndarray, dict]:
    """Repair isolated missed or doubled tracker beats against the local beat period."""
    beats = np.unique(np.asarray(times, dtype=float))
    beats = beats[np.isfinite(beats)]
    if len(beats) < 4:
        return beats, {"inserted": 0, "removed": 0, "irregular": 0, "intervals": max(0, len(beats) - 1)}

    def local_periods(values):
        # Fold intervals into the song's prevailing tempo octave first, so a tracker that
        # switches to half- or double-time for a section is repaired instead of followed.
        intervals = np.diff(values)
        reference = float(np.median(intervals))
        folded = intervals / 2.0 ** np.round(np.log2(intervals / reference))
        return np.array([np.median(folded[max(0, index - 8):index + 9]) for index in range(len(intervals))])

    removed = 0
    for _ in range(3):
        periods = local_periods(beats)
        intervals = np.diff(beats)
        short = np.flatnonzero(intervals < periods * 0.6)
        if not len(short):
            break
        drop = set()
        for index in short:
            if index in drop or index + 1 in drop:
                continue
            previous = beats[index - 1] + periods[index] if index else None
            drop.add(index + 1 if previous is None or abs(beats[index] - previous)
                     <= abs(beats[index + 1] - previous) else index)
        removed += len(drop)
        beats = np.delete(beats, sorted(drop))
    periods = local_periods(beats)
    filled = [beats[0]]
    inserted = irregular = 0
    for index, interval in enumerate(np.diff(beats)):
        ratio = interval / periods[index]
        count = max(1, round(ratio))
        if abs(ratio - count) > 0.2 * count:
            irregular += 1
        if count > 1:
            filled.extend(beats[index] + interval * np.arange(1, count) / count)
            inserted += count - 1
        filled.append(beats[index + 1])
    return np.asarray(filled), {"inserted": inserted, "removed": removed, "irregular": irregular,
                                "intervals": len(beats) - 1}


def activation_beat_grid(beat: np.ndarray, downbeat: np.ndarray, fps: float) -> dict:
    beat_peaks, _ = find_peaks(beat, distance=7, height=0)
    downbeat_peaks, _ = find_peaks(downbeat, distance=7, height=0)
    raw = _peak_times(beat, beat_peaks, fps)
    beat_times, cleanup = clean_beats(raw)
    if len(beat_times) < 8:
        raise ModelFailed("Beat This! did not find a stable beat sequence.")
    intervals = np.diff(beat_times)
    period = float(np.median(intervals))
    if not 0.2 <= period <= 1.5:
        raise ModelFailed("Beat This! did not find a stable beat sequence.")
    downbeat_times = _peak_times(downbeat, downbeat_peaks, fps)
    indices = []
    for value in downbeat_times:
        index = int(np.argmin(abs(beat_times - value)))
        if abs(beat_times[index] - value) <= period * 0.3 and (not indices or indices[-1] != index):
            indices.append(index)
    repaired = (cleanup["inserted"] + cleanup["removed"]) / max(1, cleanup["intervals"])
    local = np.array([np.median(intervals[max(0, index - 8):index + 9]) for index in range(len(intervals))])
    unsteady = float(np.mean(abs(intervals / local - 1) > 0.12))
    # Regularity counts tracker intervals that fit the local beat; it is not a calibrated probability.
    confidence = (1 - cleanup["irregular"] / max(1, cleanup["intervals"]) - max(0.0, repaired - 0.25)
                  - unsteady)
    return {"bpm": round(60 / period, 3), "confidence": round(max(0.0, confidence), 3),
            "times": beat_times.tolist(), "phaseSeconds": float(beat_times[0]),
            "downbeats": beat_times[indices].tolist(), "downbeatIndices": indices,
            "downbeatActivation": [round(float(downbeat[max(0, int(round(float(time) * fps)) - 2):
                                                         int(round(float(time) * fps)) + 3].max()), 2)
                                   for time in beat_times],
            "downbeatSource": "beat-this", "meterConfidence": 0.0, "beatsTracked": True,
            "cleanup": {**cleanup, "rawBeats": len(raw), "rawDownbeats": len(downbeat_times)}}


def _rational_span(value: float, tolerance: float = 0.04, denominators=(1, 2, 4, 8, 16),
                   strict: bool = False) -> float | None:
    for denominator in denominators:
        fitted = round(value * denominator) / denominator
        if fitted > 0 and abs(fitted - value) <= tolerance:
            return fitted
    return None if strict else round(value * 16) / 16


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


def _literal_runs(counts: list[int], primary: int) -> tuple[set[int], set[int]]:
    """Intervals that form sustained or alternating groups other than the primary bar.

    Returns the literal intervals and the subset whose length is a whole multiple or divisor of
    another group in play: a longer bar or missed downbeats, a shorter bar or extra downbeats.
    Those observed spans are kept but stay ambiguous, so their bars are unverified.
    """
    def related(value, other):
        return value != other and (value % other == 0 or other % value == 0)
    literal, ambiguous = set(), set()
    index = 0
    while index < len(counts):
        stop = index
        while stop < len(counts) and counts[stop] == counts[index]:
            stop += 1
        value = counts[index]
        if value >= 2 and value != primary:
            if not related(value, primary) and stop - index >= 3:
                literal.update(range(index, stop))
            elif related(value, primary) and stop - index >= 4:
                literal.update(range(index, stop))
                ambiguous.update(range(index, stop))
        index = max(stop, index + 1)
    for index in range(len(counts) - 5):
        pattern = counts[index:index + 2]
        if pattern[0] != pattern[1] and min(pattern) >= 2 and counts[index:index + 6] == pattern * 3:
            stop = index + 6
            while stop < len(counts) and counts[stop] == pattern[(stop - index) % 2]:
                stop += 1
            literal.update(range(index, stop))
            if related(*pattern) or any(related(value, primary) for value in pattern):
                ambiguous.update(range(index, stop))
    return literal, ambiguous


def downbeat_meter(indices: list[int], beat_confidence: float, activation: list[float] | None = None) -> dict:
    """Bar groups from whole tracked beats between observed downbeats.

    The primary group is the most frequent observed bar; isolated tracker errors do not
    become one-off signatures, a sustained phase shift leaves an unverified partial bar,
    and only sustained or alternating different groups become signature changes. Inside an
    interval spanning several primary bars, a beat whose downbeat ``activation`` exceeds the
    song's ordinary beats (90th percentile) is an observed weak downbeat. Inside a sustained run
    of shorter groups, off-phase downbeats mostly weaker than the downbeat before them are
    half-bar accents: the primary bar stays, unverified, and the run is reported in
    ``observedShorterGroups``. Otherwise observed longer or shorter groups, sustained or
    alternating, are kept as unverified bars rather than split or merged into the primary bar.
    """
    indices = [int(value) for value in indices]
    counts = [int(value) for value in np.diff(indices)] if len(indices) > 1 else []
    usable = Counter(value for value in counts if value >= 2)
    base = {
        "method": "tracked-downbeat-beat-count-v1",
        "confidenceMeaning": "share of observed downbeat intervals explained by the bar groups; not calibrated",
        "spellingVerified": False,
        "spellingReason": "Downbeats count tracked beats; they do not resolve the written denominator or tempo octave.",
    }
    if not usable or beat_confidence < 0.65:
        return {**base, "beatsPerBar": 4, "confidence": 0.0, "supported": False, "fallback": True,
                "boundariesVerified": False,
                "reason": "low_beat_grid_confidence" if usable else "insufficient_downbeats",
                "anchor": indices[0] if len(indices) else 0,
                "changes": [{"startBeat": 0.0, "numerator": 4, "denominator": 4, "status": "unverified"}],
                "evidence": {"intervals": len(counts)}, "candidates": {}}
    primary = max(sorted(usable), key=lambda value: (usable[value], -value))
    recovered = suppressed = 0
    observed = []
    if activation is not None and len(activation) > indices[-1]:
        marked = set(indices)
        middles = {index + primary * step for index, count in zip(indices, counts)
                   if count > primary and count % primary == 0 for step in range(1, count // primary)}
        ordinary = [activation[index] for index in range(indices[0], indices[-1])
                    if index not in marked and index not in middles]
        if middles and len(ordinary) >= 8:
            threshold = float(np.percentile(ordinary, 90))
            weak = {index for index in middles if activation[index] > threshold}
            if weak:
                recovered = len(weak)
                indices = sorted(marked | weak)
                counts = [int(value) for value in np.diff(indices)]
        # A steady beat with downbeats at a fraction of the bar is a written change only when those
        # downbeats are as strong as the bar's own. Off-phase downbeats that are mostly weaker than
        # the downbeat just before them show strong-weak pairing: half-bar accents, not barlines.
        accents = set()
        first = 0
        while first < len(counts):
            stop = first
            while stop < len(counts) and counts[stop] == counts[first]:
                stop += 1
            if stop - first >= 4 and 2 <= counts[first] < primary and primary % counts[first] == 0:
                run = indices[first:stop + 1]
                pairs = [(activation[index], activation[previous]) for previous, index in zip(run, run[1:])
                         if (index - run[0]) % primary]
                if pairs and sum(off < on for off, on in pairs) >= 2 * len(pairs) / 3:
                    accents.update(index for index in run if (index - run[0]) % primary)
                    observed.append({"startBeat": float(run[0] - indices[0]), "beats": run[-1] - run[0],
                                     "groupBeats": counts[first], "reading": "half-bar accents"})
            first = max(stop, first + 1)
        if accents:
            suppressed = len(accents)
            indices = [index for index in indices if index not in accents]
            counts = [int(value) for value in np.diff(indices)]
    literal, ambiguous = _literal_runs(counts, primary)
    anchor, cursor = indices[0], indices[0]
    changes = []
    explained = missing = shifts = subdivisions = 0

    def mark(start, length, status):
        point = {"startBeat": float(start - anchor), "numerator": length, "denominator": 4, "status": status}
        if changes and changes[-1]["startBeat"] == point["startBeat"]:
            changes[-1] = point
        elif (not changes or changes[-1]["numerator"] != length or status == "unverified"
                or changes[-1]["status"] != status or (point["startBeat"] - changes[-1]["startBeat"]) % length):
            changes.append(point)

    def shift(target):
        length = changes[-1]["numerator"]
        remainder = (target - cursor) % length
        if remainder:
            mark(target - remainder, length, "unverified")
        return target

    mark(anchor, primary, "supported")
    for position, count in enumerate(counts):
        start, target = indices[position], indices[position + 1]
        if position in literal:
            if cursor != start:
                cursor = shift(start)
                shifts += 1
            mark(cursor, count, "unverified" if position in ambiguous else "supported")
            cursor = target
            explained += 1
            continue
        gap = target - cursor
        if gap <= 0:
            continue
        if gap % primary == 0:
            if changes[-1]["numerator"] != primary or changes[-1]["status"] != "supported":
                mark(cursor, primary, "supported")
            missing += gap // primary - 1
            explained += 1
            cursor = target
            continue
        # A downbeat off the running phase is spurious unless following downbeats confirm it.
        later = indices[position + 2:position + 4]
        if len(later) == 2 and all((value - target) % primary == 0 for value in later) \
                and any((value - cursor) % primary for value in later):
            cursor = shift(target)
            shifts += 1
            mark(cursor, primary, "supported")
        elif primary % gap == 0 or primary % (primary - gap % primary) == 0:
            subdivisions += 1
    considered = len(counts) - subdivisions
    confidence = explained / considered if considered else 0.0
    supported = explained >= 3 and confidence >= 0.6
    if not supported:
        return {**base, "beatsPerBar": 4, "confidence": 0.0, "supported": False, "fallback": True,
                "boundariesVerified": False, "reason": "downbeat_spacing_is_too_noisy",
                "anchor": anchor, "changes": [{"startBeat": 0.0, "numerator": 4, "denominator": 4,
                                               "status": "unverified"}],
                "evidence": {"intervals": len(counts), "explained": explained},
                "candidates": {f"{value}/4": count for value, count in usable.items()}}
    verified = not shifts and not ambiguous and not suppressed and missing <= max(1, len(counts) // 4)
    if not verified:
        changes = [{**change, "status": "unverified"} for change in changes]
    return {
        **base, "beatsPerBar": primary, "confidence": round(confidence, 3), "supported": True,
        "fallback": False, "boundariesVerified": verified, "reason": "downbeat_spacing_supports_meter",
        "anchor": anchor, "changes": changes,
        "evidence": {"intervals": len(counts), "explained": explained, "missingBoundaries": missing,
                     "phaseShifts": shifts, "literalGroups": len(literal),
                     "recoveredWeakDownbeats": recovered, "suppressedWeakAccents": suppressed,
                     "ambiguousGroups": len(ambiguous), "observedShorterGroups": observed},
        "candidates": {f"{value}/4": count for value, count in usable.items()},
    }


def beat_timeline(beat_times, anchor_index: int, duration: float) -> dict:
    """Score beat numbers for tracked beats: beat zero starts the (pickup) bar before the anchor."""
    beats = np.asarray(beat_times, dtype=float)
    first_period = float(np.median(np.diff(beats[:9])))
    last_period = float(np.median(np.diff(beats[-9:])))
    lead = max(0, math.ceil((beats[0] - 0.15 * first_period) / first_period))
    tempo_map = []
    if beats[0] > 1e-6:
        tempo_map.append({"beat": round(float(lead - beats[0] / first_period), 6), "time": 0.0})
    tempo_map.extend({"beat": float(index + lead), "time": round(float(time), 6)}
                     for index, time in enumerate(beats) if time > 1e-6 or not tempo_map)
    if beats[-1] < duration:
        end = {"beat": round(float(len(beats) - 1 + lead + (duration - beats[-1]) / last_period), 6),
               "time": round(float(duration), 6)}
        if end["time"] > tempo_map[-1]["time"] and end["beat"] > tempo_map[-1]["beat"]:
            tempo_map.append(end)
    bpm = round(60 / float(np.median(np.diff(beats))), 3)
    total = float(beat_at_time(tempo_map, bpm, duration))
    return {"tempoMap": tempo_map, "bpm": bpm, "pickup": float(anchor_index + lead), "totalBeats": total}


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
            length = _rational_span(index * step / period, denominators=(1, 2), strict=True)
            score = float(accent_correlations[index])
            if (length is not None and length > 1 and abs(index * step / period - length) <= 0.08
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
    if unique:
        phase = float(unique[0] % period)
    elif len(global_peaks):
        angles = 2 * np.pi * (times[global_peaks] % period) / period
        weights = attack[global_peaks]
        phase = float(np.arctan2(weights @ np.sin(angles), weights @ np.cos(angles)) % (2 * np.pi)
                      / (2 * np.pi) * period)
    else:
        phase = 0.0
    timing = {
        "bpm": bpm, "confidence": consistency, "beatConfidence": consistency,
        "phaseSeconds": phase, "times": np.arange(phase, duration, period).tolist(),
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


def align_chord_changes(chords: list[dict], times: np.ndarray, chroma: np.ndarray, bpm: float,
                        tempo_map: list[dict] | None = None) -> list[dict]:
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
        boundary = time_at_beat(tempo_map, bpm, current["startBeat"])
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
            new_beat = float(beat_at_time(tempo_map, bpm, onset))
            end = current["startBeat"] + current["beats"]
            if previous["startBeat"] < new_beat < end:
                previous["beats"] = new_beat - previous["startBeat"]
                current["startBeat"] = new_beat
                current["beats"] = end - new_beat
            break
    return aligned


def analyze_harmony(audio: Audio, cancelled: Event | None = None, onsets=None) -> dict:
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
    learned_tracked = _tracked(timing)
    if acoustic is not None:
        acoustic_timing, acoustic_details = acoustic
        acoustic_meter = infer_meter(acoustic_timing)
        acoustic_details["alternativeBeatGrid"] = {
            "method": beat_details["method"], "bpm": timing["bpm"], "confidence": timing["confidence"],
        }
        same_tempo = abs(acoustic_timing["bpm"] / timing["bpm"] - 1) <= 0.06
        # A validated tracked beat sequence is preferred; distinct recurring accents at the
        # same tempo may still replace its downbeat labels, but never its tempo octave.
        if acoustic_meter["supported"] and (
                not learned_tracked and not infer_meter(timing)["supported"]
                or acoustic_meter.get("boundariesVerified") and (same_tempo or not learned_tracked)):
            timing, beat_details = acoustic_timing, acoustic_details
    timing["beatConfidence"] = timing.get("confidence", 0.0)
    duration = audio.duration
    tempo_map = None
    tracked = _tracked(timing)
    if tracked:
        beats = np.asarray(timing["times"], dtype=float)
        indices = timing.get("downbeatIndices")
        if indices is None:
            indices = []
            for value in timing.get("downbeats", []):
                index = int(np.argmin(abs(beats - value)))
                if abs(beats[index] - value) <= 0.3 * float(np.median(np.diff(beats))) \
                        and (not indices or indices[-1] < index):
                    indices.append(index)
        meter = downbeat_meter(indices, timing["beatConfidence"], timing.get("downbeatActivation"))
        timeline = beat_timeline(beats, meter.pop("anchor"), duration)
        tempo_map, bpm, pickup = timeline["tempoMap"], timeline["bpm"], timeline["pickup"]
        total_beats = timeline["totalBeats"]
        if pickup >= total_beats - 1e-6:
            pickup = 0.0
        timing["bpm"] = bpm
    else:
        meter = infer_meter(timing)
        bpm = timing["bpm"]
        pickup = 0.0
        total_beats = duration * bpm / 60
        period = 60 / bpm
        acoustic_grid = timing.get("accentMeter") is not None
        phase = timing.get("phaseSeconds", 0.0) % period if acoustic_grid else 0.0
        if acoustic_grid:
            # Align acoustic pulses with beats; meter boundaries move by the same whole-grid offset.
            start = phase - max(0, math.ceil((phase - 0.15 * period) / period)) * period
            tempo_map = ([{"beat": 0.0, "time": round(start, 6)}] if start >= 0 else
                         [{"beat": round(-start / period, 6), "time": 0.0}])
            tempo_map.append({"beat": round((duration - start) / period, 6), "time": round(duration, 6)})
            total_beats = (duration - start) / period
            offset = -start / period
            changes = [{**meter["changes"][0], "startBeat": 0.0}]
            for change in meter["changes"][1:]:
                moved = round((change["startBeat"] + offset) * 4) / 4
                if moved > changes[-1]["startBeat"]:
                    changes.append({**change, "startBeat": moved})
            meter = {**meter, "changes": changes}
            if len(changes) == 1 and timing.get("downbeats"):
                pickup = float(round((timing["downbeats"][0] - start) / period))
                if pickup >= total_beats - 1e-6:
                    pickup = 0.0
    beats_per_bar = meter["beatsPerBar"]
    timing["meterConfidence"] = meter["confidence"]
    timing["meter"] = meter
    timing.pop("accentMeter", None)
    timing.pop("beatsTracked", None)
    key = detect_key(chroma)
    bar_map = build_bar_map(total_beats, meter["changes"], pickup=pickup)
    compound = compound_reading(bar_map, tempo_map, bpm, onsets) if tracked and onsets is not None else None
    if compound:
        bar_map, tempo_map, compound_bars = compound
        total_beats = bar_map[-1]["startBeat"] + bar_map[-1]["beats"]
        spans = np.diff([point["beat"] for point in tempo_map])
        bpm = timing["bpm"] = round(60 / float(np.median(np.diff([point["time"] for point in tempo_map]) / spans)), 3)
        changes = []
        for bar in bar_map:
            if not changes or any(changes[-1][key] != bar[key] for key in ("numerator", "denominator", "status")):
                changes.append({key: bar[key] for key in ("startBeat", "numerator", "denominator", "status")})
        nominal = Counter(bar["numerator"] * 4 / bar["denominator"] for bar in bar_map if not bar.get("partial"))
        meter = {**meter, "changes": changes, "beatsPerBar": nominal.most_common(1)[0][0],
                 "evidence": {**meter.get("evidence", {}), "compoundBars": compound_bars}}
        timing["meter"] = meter
        beats_per_bar = meter["beatsPerBar"]
    bars = len(bar_map)

    def seconds(beat):
        return time_at_beat(tempo_map, bpm, beat)

    chords = []
    for beat in range(math.ceil(total_beats)):
        check_cancel(cancelled)
        selected = (times >= seconds(beat)) & (times < seconds(min(beat + 1, total_beats)))
        vector = chroma[selected].mean(axis=0) if selected.any() else np.zeros(12)
        strength = float(energy[selected].mean()) if selected.any() else 0.0
        chords.append({"startBeat": float(beat), "beats": min(1.0, total_beats - beat),
                       **classify_chord(vector, strength, key)})
    sections = []
    section_energy = []
    for first in range(0, bars, 4):
        last = min(first + 3, bars - 1)
        selected = ((times >= seconds(bar_map[first]["startBeat"]))
                    & (times < seconds(bar_map[last]["startBeat"] + bar_map[last]["beats"])))
        sections.append({"name": f"Bars {first + 1}-{min(first + 4, bars)}",
                         "startBar": first + 1, "bars": min(4, bars - first)})
        section_energy.append(float(energy[selected].mean()) if selected.any() else 0.0)
    maximum = max(section_energy, default=0)
    aligned = align_chord_changes(contiguous_chords(chords), times, chroma, bpm, tempo_map)
    spellings = list(dict.fromkeys(f'{point["numerator"]}/{point["denominator"]}'
                                   for point in meter["changes"]))
    meter_warning = (
        f"Measured recurring groups suggest {' then '.join(spellings)}; written denominator and tempo "
        "subdivision remain unverified. "
        + ("Note onsets divide the tracked beat in thirds in some passages; those bars are written "
           "in compound x/8 time. " if meter.get("evidence", {}).get("compoundBars") else "")
        + ("Some passages had downbeats at a fraction of the bar; they are written as half-bar "
           "accents, not signature changes. "
           if meter.get("evidence", {}).get("observedShorterGroups") else "")
        + ("Bar boundaries are unverified; check the tentative grouping against the recording."
           if not meter.get("boundariesVerified") else
           "Check the changing signatures and bar groups against the recording.")
        if meter["supported"] else "Meter is unverified; using 4/4 as a fallback for numbered bars."
    )
    return {"bpm": bpm, "beatsPerBar": beats_per_bar,
            "beatUnit": meter["changes"][0]["denominator"], "bars": bars, "barMap": bar_map, "key": key,
            **({"tempoMap": tempo_map} if tempo_map else {}),
            "sections": sections, "chords": aligned, "timing": timing,
            "beatDetails": beat_details,
            "sectionEnergy": [value / maximum if maximum else 0 for value in section_energy],
            "warnings": [meter_warning]
            + (["Tempo is uncertain; the display uses a 120 BPM grid."] if timing["confidence"] == 0 else [])}


def compound_reading(bar_map: list[dict], tempo_map: list[dict], bpm: float, onsets) -> tuple | None:
    """Re-spell bars whose tracked beats the transcribed onsets divide in thirds as compound x/8.

    Off-beat onsets are compared with the third and quarter grids of each tracked beat, pooled
    over the bar and its neighbours. Where thirds clearly win, the tracked pulse is a dotted
    quarter, so each tracked beat spans 1.5 quarter beats (four tracked beats become 12/8).
    Duple passages keep their spelling. Recording seconds are unchanged; only the score beat
    numbering in the tempo map follows the new beat unit.
    """
    if not tempo_map or not len(onsets):
        return None
    positions = np.array([beat_at_time(tempo_map, bpm, float(onset)) for onset in onsets])
    fraction = positions % 1
    off = (fraction > 0.08) & (fraction < 0.92)
    thirds = abs(fraction * 3 - np.round(fraction * 3)) / 3
    quarters = abs(fraction * 4 - np.round(fraction * 4)) / 4
    starts = [bar["startBeat"] for bar in bar_map]
    owner = np.searchsorted(starts, positions, side="right") - 1
    votes = np.zeros((len(bar_map), 2))
    for bar, keep, third, quarter in zip(owner, off, thirds, quarters):
        if keep and 0 <= bar < len(bar_map) and abs(third - quarter) > 0.01:
            votes[bar, 0 if third < quarter else 1] += 1
    factors = []
    for index, bar in enumerate(bar_map):
        pooled = votes[max(0, index - 1):index + 2].sum(axis=0)
        # A bar's own onsets decide at section edges; sparse bars borrow their neighbours' evidence.
        triple, duple = votes[index] if votes[index].sum() >= 4 else pooled
        factors.append(1.5 if bar["denominator"] == 4 and pooled[0] >= 8 and triple >= 0.75 * (triple + duple)
                       else 1.0)
    for index in range(1, len(factors) - 1):
        if factors[index - 1] == factors[index + 1] != factors[index]:
            factors[index] = factors[index - 1]
    if 1.5 not in factors:
        return None
    converted, cursor = [], 0.0
    for bar, factor in zip(bar_map, factors):
        item = {**bar, "startBeat": cursor, "beats": bar["beats"] * factor}
        if factor != 1:
            item.update(numerator=bar["numerator"] * 3, denominator=8)
        converted.append(item)
        cursor += item["beats"]

    def score_beat(beat):
        index = min(len(bar_map) - 1, max(0, bisect_right(starts, beat) - 1))
        return converted[index]["startBeat"] + (beat - bar_map[index]["startBeat"]) * factors[index]

    mapped = [{"beat": round(score_beat(point["beat"]), 6), "time": point["time"]} for point in tempo_map]
    return validate_bar_map(converted), mapped, factors.count(1.5)


def _tracked(timing: dict) -> bool:
    """Observed beat times regular enough to define the score's beat-to-recording map."""
    times = timing.get("times") or []
    return (timing.get("accentMeter") is None and len(times) >= 8
            and float(timing.get("confidence", 0.0)) >= 0.5
            and bool(np.all(np.diff(np.asarray(times, dtype=float)) > 0)))
