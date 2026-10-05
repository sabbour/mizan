import logging
import os
from threading import Event

import numpy as np
from scipy.ndimage import median_filter
from scipy.signal import istft, stft

from ..errors import ModelFailed
from .audio import Audio
from .models import HTDEMUCS_6S, ensure_model
from .providers import PROVIDER_ERRORS, VerifiedModel, check_cancel

logger = logging.getLogger(__name__)
SOURCES = ("drums", "bass", "other", "vocals", "guitar", "piano")
MODEL_RATE = 44100
MODEL_SAMPLES = 343980


def _hpss(audio: Audio, cancelled: Event | None = None, progress=None, on_model=None) -> tuple[dict[str, Audio], dict]:
    if on_model:
        on_model({"method": "hpss-complementary-v1", "provider": {"effectiveProviders": ["CPU-DSP"]}})
    samples = audio.samples
    stereo = samples[:, None] if samples.ndim == 1 else samples
    harmonic = np.zeros_like(stereo, dtype=np.float32)
    size, hop = 2048, 512
    block = audio.rate * 10
    margin = size + 16 * hop
    for start in range(0, len(samples), block):
        check_cancel(cancelled)
        stop = min(start + block, len(samples))
        first, last = max(0, start - margin), min(len(samples), stop + margin)
        segment = stereo[first:last].T
        segment = np.pad(segment, ((0, 0), (0, max(0, size - segment.shape[1]))))
        _, _, spectrum = stft(segment, fs=audio.rate, nperseg=size, noverlap=size - hop, axis=-1)
        magnitude = np.abs(spectrum).mean(axis=0)
        sustained = median_filter(magnitude, size=(1, 31), mode="nearest")
        check_cancel(cancelled)
        transient = median_filter(magnitude, size=(31, 1), mode="nearest")
        mask = sustained ** 2 / (sustained ** 2 + transient ** 2 + 1e-20)
        _, reconstructed = istft(spectrum * mask[None, :, :], fs=audio.rate,
                                  nperseg=size, noverlap=size - hop, time_axis=-1, freq_axis=-2)
        harmonic[start:stop] = reconstructed[:, start - first:stop - first].T
        if progress:
            progress(stop / len(samples))
    if samples.ndim == 1:
        harmonic = harmonic[:, 0]
    percussion = samples - harmonic
    silence = np.zeros_like(samples, dtype=np.float32)
    return {
        "drums": Audio(percussion.astype(np.float32), audio.rate),
        "bass": Audio(silence.copy(), audio.rate),
        "other": Audio(silence.copy(), audio.rate),
        "vocals": Audio(silence.copy(), audio.rate),
        "guitar": Audio(silence.copy(), audio.rate),
        "piano": Audio(harmonic.astype(np.float32), audio.rate),
    }, {
        "method": "hpss-complementary-v1", "provider": {"effectiveProviders": ["CPU-DSP"]},
        "sampleRate": audio.rate, "samples": len(samples), "latencySamples": 0,
        "warnings": ["Learned six-stem separation was unavailable; using the lower-quality harmonic/percussive fallback."],
    }


def _demucs(audio: Audio, cancelled: Event | None = None, progress=None, on_model=None) -> tuple[dict[str, Audio], dict]:
    model_path = ensure_model(HTDEMUCS_6S, cancelled)
    source = audio.resampled(MODEL_RATE)
    mix = source.samples
    if mix.ndim == 1:
        mix = np.column_stack((mix, mix))
    mix = mix.T.astype(np.float32, copy=False)
    overlap = MODEL_SAMPLES // 4
    stride = MODEL_SAMPLES - overlap
    starts = list(range(0, max(1, mix.shape[1]), stride))
    fade = np.linspace(0, 1, overlap, dtype=np.float32)
    window = np.ones(MODEL_SAMPLES, dtype=np.float32)
    window[:overlap], window[-overlap:] = fade, fade[::-1]
    output = np.zeros((len(SOURCES), 2, mix.shape[1]), dtype=np.float32)
    weight = np.zeros(mix.shape[1], dtype=np.float32)
    model = None
    for index, start in enumerate(starts):
        check_cancel(cancelled)
        end = min(start + MODEL_SAMPLES, mix.shape[1])
        chunk = np.pad(mix[:, start:end], ((0, 0), (0, MODEL_SAMPLES - (end - start))))
        feeds = {"mix": chunk[None].astype(np.float32, copy=False)}
        if model is None:
            model = VerifiedModel(model_path, feeds, cancelled=cancelled)
            if on_model:
                on_model({"method": "htdemucs-6s-onnx", "model": HTDEMUCS_6S, "provider": model.report})
            separated = model.first_output[0][0]
        else:
            separated = model.run(feeds)[0][0]
            if on_model and model.report.get("runtimeFallback"):
                on_model({"method": "htdemucs-6s-onnx", "model": HTDEMUCS_6S, "provider": model.report})
        length = end - start
        chunk_window = window.copy()
        if index == 0:
            chunk_window[:overlap] = 1
        if index == len(starts) - 1:
            chunk_window[-overlap:] = 1
        output[:, :, start:end] += separated[:, :, :length] * chunk_window[:length]
        weight[start:end] += chunk_window[:length]
        if progress:
            progress((index + 1) / len(starts))
    output /= np.maximum(weight, 1e-8)[None, None, :]
    stems = {}
    for index, name in enumerate(SOURCES):
        samples = Audio(output[index].T, MODEL_RATE).resampled(audio.rate).samples
        if len(samples) < len(audio.samples):
            samples = np.pad(samples, ((0, len(audio.samples) - len(samples)), (0, 0)))
        samples = samples[:len(audio.samples)].astype(np.float32)
        if audio.samples.ndim == 1:
            samples = samples.mean(axis=1)
        elif audio.samples.shape[1] == 1:
            samples = samples.mean(axis=1, keepdims=True)
        stems[name] = Audio(samples, audio.rate)
    return stems, {
        "method": "htdemucs-6s-onnx",
        "model": HTDEMUCS_6S,
        "provider": model.report,
        "sampleRate": audio.rate,
        "samples": len(audio.samples),
        "latencySamples": 0,
        "warnings": ["HT-Demucs 6s can leak or artifact piano; transcription confidence remains a draft."],
    }


def separate(audio: Audio, cancelled: Event | None = None, progress=None, on_model=None) -> tuple[dict[str, Audio], dict]:
    backend = os.environ.get("MIZAN_SEPARATOR", "auto").lower()
    if backend not in ("auto", "dsp"):
        raise ModelFailed("MIZAN_SEPARATOR must be auto or dsp.")
    if backend == "auto":
        try:
            return _demucs(audio, cancelled, progress, on_model)
        except (ModelFailed, *PROVIDER_ERRORS) as exc:
            logger.warning("HT-Demucs unavailable: %s", exc)
    return _hpss(audio, cancelled, progress, on_model)
