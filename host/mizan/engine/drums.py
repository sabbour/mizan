from threading import Event

import numpy as np
from scipy.signal import butter, find_peaks, sosfilt

from .audio import Audio
from .providers import check_cancel

GM_DRUMS = {"kick": 36, "snare": 38, "hihat": 42, "openhat": 46,
            "hightom": 48, "floortom": 41, "ride": 51, "crash": 49}
# Each GM percussion pitch the transcriber reports, by kit lane; the pitch itself is kept as sourceMidi.
GM_LANES = {
    35: "kick", 36: "kick", 38: "snare", 40: "snare",
    42: "hihat", 44: "hihat", 46: "openhat",
    41: "floortom", 43: "floortom", 45: "floortom",
    47: "hightom", 48: "hightom", 50: "hightom",
    49: "crash", 52: "crash", 55: "crash", 57: "crash",
    51: "ride", 53: "ride", 59: "ride",
}


def gm_pitch(hit: dict) -> int:
    """The detected GM pitch when it belongs to the hit's lane (a specific tom, pedal hat), else the lane's."""
    source = hit.get("sourceMidi")
    return source if type(source) is int and GM_LANES.get(source) == hit["lane"] else GM_DRUMS[hit["lane"]]


MERGED_CLASSES = {
    "kick": ["kick", "floortom"],
    "snare": ["snare", "hightom"],
    "hihat": ["hihat", "openhat", "ride", "crash"],
}


def classify_bands(powers: np.ndarray) -> list[tuple[str, float]]:
    total = float(powers.sum())
    if total < 1e-12:
        return []
    low, mid, high = powers / total
    strongest = max(low, mid, high)
    groups = []
    if low > 0.25 and low >= strongest * 0.70:
        groups.append(("kick", min(0.65, 0.35 + float(low) * 0.3)))
    if mid > 0.35 and mid >= strongest * 0.70:
        groups.append(("snare", min(0.60, 0.3 + float(mid) * 0.3)))
    if high > 0.30 and high >= strongest * 0.70:
        groups.append(("hihat", min(0.55, 0.3 + float(high) * 0.25)))
    return groups


def transcribe_drums(audio: Audio, cancelled: Event | None = None, progress=None) -> tuple[list[dict], dict]:
    rate = audio.rate
    hop = max(1, round(rate * 0.005))
    samples = audio.mono()
    # ponytail: three spectral groups, not eight identified kit pieces; use a
    # validated ADT model before claiming tom or cymbal subtype recognition.
    bands = [(30, 180), (180, min(3500, rate * 0.40)), (min(3500, rate * 0.40), rate * 0.48)]
    envelopes = []
    for low, high in bands:
        check_cancel(cancelled)
        sos = butter(3, [low, high], btype="bandpass", fs=rate, output="sos")
        state = np.zeros((len(sos), 2))
        powers = []
        block_size = hop * 2000
        for start in range(0, len(samples), block_size):
            check_cancel(cancelled)
            filtered, state = sosfilt(sos, samples[start:start + block_size], zi=state)
            filtered = np.pad(filtered, (0, (-len(filtered)) % hop))
            powers.extend(np.mean(filtered.reshape(-1, hop) ** 2, axis=1))
        envelopes.append(np.asarray(powers))
    power = np.asarray(envelopes)
    candidates = []
    for envelope in np.sqrt(power):
        novelty = np.maximum(0, envelope - np.r_[0, envelope[:-1]])
        maximum = float(novelty.max())
        if maximum < 1e-5:
            continue
        peaks, _ = find_peaks(novelty, prominence=max(1e-5, maximum * 0.18),
                              distance=max(1, round(0.065 * rate / hop)))
        if novelty[0] > maximum * 0.18:
            peaks = np.insert(peaks, 0, 0)
        candidates.extend(peaks.tolist())
    grouped = []
    for frame in sorted(set(candidates)):
        if not grouped or (frame - grouped[-1]) * hop / rate > 0.03:
            grouped.append(frame)
    events = []
    maximum = max(float(power.sum(axis=0).max()), 1e-12)
    for index, frame in enumerate(grouped):
        check_cancel(cancelled)
        powers = power[:, frame:min(frame + 10, power.shape[1])].mean(axis=1)
        for lane, confidence in classify_bands(powers):
            onset = frame * hop / rate
            if onset < audio.duration:
                events.append({"lane": lane, "onset": onset,
                               "velocity": float(np.clip(np.sqrt(powers.sum() / maximum), 0.1, 1.0)),
                               "confidence": confidence, "possibleLanes": MERGED_CLASSES[lane]})
        if progress:
            progress((index + 1) / len(grouped))
    if progress:
        progress(1.0)
    return events, {
        "method": "onset-spectral-groups-v2", "provider": {"effectiveProviders": ["CPU-DSP"]},
        "supportedLanes": ["kick", "snare", "hihat"], "mergedClasses": MERGED_CLASSES,
        "warnings": ["Drums are spectral groups, not reliable kit identification: tom-like hits merge into kick/snare; all cymbals merge into hi-hat."],
    }
