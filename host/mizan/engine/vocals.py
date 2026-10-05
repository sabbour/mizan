import logging
from threading import Event

import numpy as np

from ..errors import ModelFailed
from .audio import Audio
from .piano import basic_pitch
from .pitch_refinement import refine_pitches
from .providers import PROVIDER_ERRORS, check_cancel

logger = logging.getLogger(__name__)
WARNING = ("Vocal melody is a low-confidence Basic Pitch draft, not lyrics or a singer's voice. "
           "Breaths, vibrato, backing voices and stem leakage can cause missing or incorrect notes.")


def clean_melody(notes: list[dict]) -> list[dict]:
    # ponytail: one dominant line, not a lead/backing-voice separator.
    candidates = [dict(note) for note in notes
                  if 40 <= note["midi"] <= 88 and note["offset"] - note["onset"] >= 0.12
                  and note["confidence"] >= 0.35]
    edges = sorted({note[key] for note in candidates for key in ("onset", "offset")})
    ordered = sorted(candidates, key=lambda note: note["onset"])
    active, line = [], []
    index = 0
    for start, end in zip(edges, edges[1:]):
        active = [note for note in active if note["offset"] > start]
        while index < len(ordered) and ordered[index]["onset"] <= start:
            active.append(ordered[index])
            index += 1
        if not active:
            continue
        best = max(active, key=lambda note: note["confidence"])
        previous = line[-1] if line else None
        stable = next((note for note in active if previous and note["midi"] == previous["midi"]
                       and note["confidence"] >= best["confidence"] - 0.1), None)
        best = stable or best
        if previous and previous["midi"] == best["midi"] and start - previous["offset"] <= 0.1:
            previous["offset"] = end
            previous["confidence"] = min(previous["confidence"], best["confidence"], 0.49)
        else:
            line.append({**best, "onset": start, "offset": end,
                         "confidence": min(0.49, best["confidence"])})
    line = [note for note in line if note["offset"] - note["onset"] >= 0.12]
    for note in line:
        note.pop("hand", None)
    return line


def transcribe_vocals(audio: Audio, cancelled: Event | None = None, progress=None, on_model=None) -> tuple[list[dict], dict]:
    check_cancel(cancelled)
    details = {"method": "basic-pitch-vocal-melody-v1",
               "provider": {"effectiveProviders": ["CPU-DSP"]}, "warnings": [WARNING],
               "input": "vocals-stem"}
    if float(np.sqrt(np.mean(audio.samples.astype(np.float64) ** 2))) < 1e-5:
        details["warnings"].append("The isolated vocals stem is silent or too weak to transcribe.")
        if progress:
            progress(1)
        return [], details
    try:
        notes, model = basic_pitch(audio, cancelled, progress, melody=True, on_model=on_model)
        details.update(model=model["model"], provider=model["provider"])
        melody, count = refine_pitches(clean_melody(notes), audio, cancelled)
        details["pitchRefinement"] = {"method": "multi-frame-harmonic-v1", "refinedNotes": count}
        details["warnings"].append(
            "Cents require stable, isolated vocal notes with harmonic support; "
            "overlap, noise and vibrato retain the detected 12-tone pitch. Not maqam or key recognition.")
        return melody, details
    except (ModelFailed, *PROVIDER_ERRORS) as exc:
        warning = f"Vocal melody transcription unavailable: {exc}"
        logger.warning(warning)
        details["warnings"].append(warning)
        if progress:
            progress(1)
        return [], details
