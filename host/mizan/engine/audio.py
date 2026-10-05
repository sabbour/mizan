from dataclasses import dataclass
from math import gcd
from pathlib import Path
from threading import Event

import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly

from ..errors import UnsupportedMedia
from .providers import check_cancel


@dataclass
class Audio:
    samples: np.ndarray
    rate: int

    def __post_init__(self):
        if (self.rate < 8000 or self.samples.ndim not in (1, 2) or len(self.samples) == 0
                or not np.isfinite(self.samples).all()):
            raise UnsupportedMedia("Audio must contain finite PCM samples at 8 kHz or higher.")
        if self.samples.ndim == 2 and self.samples.shape[1] not in (1, 2):
            raise UnsupportedMedia("Decode audio to mono or stereo first.")

    @property
    def duration(self) -> float:
        return len(self.samples) / self.rate

    def mono(self) -> np.ndarray:
        return self.samples.mean(axis=1) if self.samples.ndim == 2 else self.samples

    def resampled(self, rate: int) -> "Audio":
        if rate == self.rate:
            return self
        divisor = gcd(self.rate, rate)
        return Audio(resample_poly(self.samples, rate // divisor, self.rate // divisor, axis=0).astype(np.float32), rate)


def read_audio(path: Path) -> Audio:
    try:
        rate, samples = wavfile.read(path)
    except (ValueError, OSError) as exc:
        raise UnsupportedMedia(f"Cannot read decoded WAV: {exc}") from exc
    if samples.dtype == np.uint8:
        samples = (samples.astype(np.float32) - 128) / 128
    elif np.issubdtype(samples.dtype, np.integer):
        samples = samples.astype(np.float32) / (np.iinfo(samples.dtype).max + 1)
    else:
        samples = samples.astype(np.float32)
    return Audio(samples, rate)


def write_audio(path: Path, audio: Audio) -> None:
    wavfile.write(path, audio.rate, audio.samples.astype(np.float32))


def spectra(audio: Audio, size: int = 4096, hop: int = 256, cancelled: Event | None = None):
    """Yield bounded, centered FFT batches; frame zero is sample zero."""
    samples = np.pad(audio.mono(), (size // 2, size // 2))
    window = np.hanning(size).astype(np.float32)
    count = (len(audio.samples) + hop - 1) // hop
    for first in range(0, count, 256):
        check_cancel(cancelled)
        last = min(first + 256, count)
        chunk = samples[first * hop:(last - 1) * hop + size]
        frames = np.lib.stride_tricks.sliding_window_view(chunk, size)[::hop]
        yield np.arange(first, last) * hop / audio.rate, np.abs(np.fft.rfft(frames * window, axis=1))
