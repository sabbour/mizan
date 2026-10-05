"""Conservative cents refinement of already-detected, isolated notes."""

import math
from threading import Event

import numpy as np

from .audio import Audio
from .providers import check_cancel


def refine_pitches(notes: list[dict], audio: Audio, cancelled: Event | None = None) -> tuple[list[dict], int]:
    """Keep integer MIDI unless repeated sustain spectra agree on the fundamental."""
    result = [dict(note) for note in notes]
    if not notes:
        return result, 0
    rate = audio.rate
    samples = audio.mono()
    size = min(8192, 2 ** int(math.floor(math.log2(rate * 0.4))))
    window = np.hanning(size)
    frequencies = np.fft.rfftfreq(size, 1 / rate)
    refined = 0
    for note in result:
        check_cancel(cancelled)
        onset, offset = note["onset"], note["offset"]
        if offset - onset < 0.55 or note["confidence"] < 0.35:
            continue
        # ponytail: overlapping pitches need a trained multi-pitch contour model;
        # don't assign another voice's partials to this note.
        if any(other["midi"] != note["midi"]
               and min(offset, other["offset"]) - max(onset, other["onset"]) > 0.08
               for other in notes):
            continue
        pitch = round(note["midi"])
        fundamental = 440 * 2 ** ((pitch - 69) / 12)
        estimates = []
        for center in np.linspace(onset + 0.13, min(offset - 0.13, onset + 0.72), 6):
            first = round(center * rate) - size // 2
            if first < 0 or first + size > len(samples):
                continue
            frame = samples[first:first + size] * window
            spectrum = np.abs(np.fft.rfft(frame))
            if spectrum.max() < 1e-4:
                continue
            partials = []
            for harmonic in (1, 2, 3):
                target = fundamental * harmonic
                if target >= rate * 0.45:
                    break
                choices = np.flatnonzero((frequencies >= target * 2 ** (-0.65 / 12))
                                         & (frequencies <= target * 2 ** (0.65 / 12)))
                if len(choices) < 2:
                    continue
                peak = choices[np.argmax(spectrum[choices])]
                if peak <= 1 or peak >= len(spectrum) - 1:
                    continue
                neighborhood = spectrum[max(1, peak - 16):min(len(spectrum), peak + 17)]
                noise = np.median(neighborhood)
                if spectrum[peak] < max(noise * 5, spectrum.max() * (0.002 if harmonic == 3 else 0.02)):
                    continue
                left, middle, right = np.log(np.maximum(spectrum[peak - 1:peak + 2], 1e-12))
                curve = left - 2 * middle + right
                shift = np.clip(0.5 * (left - right) / curve, -0.5, 0.5) if curve < -1e-6 else 0
                cents = 1200 * np.log2(((peak + shift) * rate / size) / target)
                if abs(cents) <= 65:
                    partials.append((harmonic, cents))
            pairs = [(left, right) for i, left in enumerate(partials) for right in partials[i + 1:]
                     if abs(left[1] - right[1]) < 12]
            if not pairs:
                continue
            pair = min(pairs, key=lambda values: min(item[0] for item in values))
            estimates.append(float(np.mean([item[1] for item in pair])))
        if len(estimates) < 3 or np.percentile(estimates, 75) - np.percentile(estimates, 25) > 12:
            continue
        cents = float(np.median(estimates))
        if 8 <= abs(cents) <= 58:
            note["midi"] = round(pitch + cents / 100, 4)
            refined += 1
    return result, refined
