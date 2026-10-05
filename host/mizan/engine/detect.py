import numpy as np

from .audio import Audio


def stem_levels(mix: Audio, stems: dict[str, Audio]) -> dict[str, float]:
    mix_rms = float(np.sqrt(np.mean(mix.samples ** 2))) + 1e-12
    return {name: round(float(np.clip(np.sqrt(np.mean(stem.samples ** 2)) / mix_rms, 0, 1)), 4)
            for name, stem in stems.items()}


def stem_peak_levels(mix: Audio, stems: dict[str, Audio]) -> dict[str, float]:
    def peak(audio: Audio) -> float:
        samples = audio.samples.astype(np.float64)
        if not len(samples):
            return 0.0
        window = max(1, round(audio.rate * 0.1))
        padding = (-len(samples)) % window
        if padding:
            samples = np.pad(samples, ((0, padding),) + ((0, 0),) * (samples.ndim - 1))
        frames = samples.reshape((-1, window) + samples.shape[1:])
        return float(np.sqrt(np.mean(frames ** 2, axis=tuple(range(1, frames.ndim)))).max())

    mix_peak = peak(mix)
    return {name: round(float(np.clip(peak(stem) / (mix_peak + 1e-12), 0, 1)), 4)
            for name, stem in stems.items()}


def detect_instruments(mix: Audio, stems: dict[str, Audio]) -> dict[str, float]:
    levels = stem_levels(mix, stems)
    return {"piano": levels["piano"], "drums": levels["drums"]}


def selected_instruments(detected: dict[str, float]) -> list[str]:
    return sorted(("piano", "drums"), key=lambda name: detected[name], reverse=True)


def insufficient_score_evidence(instrument: str, quality: dict) -> str | None:
    """Flag measured stem leakage, not the transcription model's note confidence."""
    if not quality["eventCount"]:
        return None
    if instrument == "drums" and quality["stemPeakLevel"] < 0.18:
        return ("The isolated drum signal is indistinguishable from measured piano-to-drum "
                "leakage even at its loudest hits; detected hits do not establish an audible drum part.")
    if instrument == "piano" and quality["stemPeakLevel"] < 0.01:
        return ("The isolated piano signal has no audible local peak; pitch events alone "
                "do not establish a piano part.")
    if instrument == "vocals" and quality["stemPeakLevel"] < 0.01:
        return ("The isolated vocal signal is near the measured no-vocal leakage floor; "
                "pitch events alone do not establish an audible vocal part.")
    return None


def transcription_quality(instrument: str, events: list[dict], audio: Audio,
                          stem_level: float, timing: dict | None = None) -> dict:
    """Conservative evidence checks, not a calibrated accuracy estimate."""
    rms = float(np.sqrt(np.mean(audio.samples.astype(np.float64) ** 2)))
    onsets = np.unique([event["onset"] for event in events])
    mean_confidence = float(np.mean([event["confidence"] for event in events])) if events else 0.0
    rhythm = None
    if timing and timing["confidence"] >= 0.5 and len(timing["times"]) >= 2 and len(onsets) >= 4:
        beats = np.asarray(timing["times"])
        covered = onsets[(onsets >= beats[0]) & (onsets <= beats[-1])]
        if len(covered) >= 4:
            positions = np.interp(covered, beats, np.arange(len(beats)))
            rhythm = float(np.mean(abs(positions - np.round(positions * 4) / 4) <= 0.08))
    reasons = []
    if not events:
        reasons.append("No note/hit events were recovered; this does not prove the instrument is absent.")
    else:
        if len(onsets) < (4 if instrument == "drums" else 3):
            reasons.append("Too few distinct attacks to assess a reliable part.")
        if mean_confidence < (0.45 if instrument == "drums" else 0.5):
            reasons.append("Transcription event confidence is low.")
        if rms < 1e-5 or stem_level < 0.01:
            reasons.append("The isolated signal is very weak; leakage or noise may dominate.")
        if instrument == "drums" and rhythm is not None and rhythm < 0.5:
            reasons.append("Fewer than half the attacks agree with the estimated sixteenth-note grid; check timing.")
    status = "empty" if not events else "tentative" if reasons else "usable"
    return {
        "status": status, "confidence": "low" if status != "usable" else "medium",
        "eventCount": len(events), "distinctOnsets": len(onsets),
        "meanEventConfidence": mean_confidence, "stemRms": rms, "stemLevel": stem_level,
        "rhythmicConsistency": rhythm, "reasons": reasons,
        "warnings": [f"{instrument.capitalize()}: "
                     f"{'no events recovered' if status == 'empty' else 'tentative / low confidence'}. "
                     + " ".join(reasons)] if reasons else [],
    }
