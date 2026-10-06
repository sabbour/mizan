import json
import math
import shutil
import time
from pathlib import Path
from threading import Event

import numpy as np

from .engine.audio import read_audio
from .engine.harmony import beat_grid, features
from .engine.media import decode, download_video, inspect_video
from .engine.providers import check_cancel
from .errors import InvalidTiming
from .library import LibraryStore
from .meter import total_beats
from .paths import app_dir


def note_chroma(song: dict) -> np.ndarray:
    beats = max(1, math.ceil(total_beats(song)))
    chroma = np.zeros((beats, 12), dtype=np.float32)
    for note in song.get("piano", []):
        first = max(0, int(note["startBeat"]))
        last = min(beats - 1, max(first, math.ceil(note["startBeat"] + note["beats"]) - 1))
        chroma[first:last + 1, round(note["midi"]) % 12] += 1
    for chord in song.get("chords", []):
        first = max(0, int(chord["startBeat"]))
        last = min(beats - 1, max(first, math.ceil(chord["startBeat"] + chord["beats"]) - 1))
        for tone in chord.get("tones", []):
            chroma[first:last + 1, tone % 12] += 0.25
    return chroma


def dtw_tempo_map(notes: np.ndarray, audio: np.ndarray, audio_times: np.ndarray) -> list[dict]:
    if notes.ndim != 2 or audio.ndim != 2 or notes.shape[1] != 12 or audio.shape[1] != 12 \
            or len(notes) == 0 or len(audio) == 0 or len(audio_times) != len(audio):
        raise ValueError("Alignment requires non-empty 12-bin chroma and matching audio times.")
    left = notes / np.maximum(np.linalg.norm(notes, axis=1, keepdims=True), 1e-9)
    right = audio / np.maximum(np.linalg.norm(audio, axis=1, keepdims=True), 1e-9)
    cost = 1 - left @ right.T
    total = np.full(cost.shape, np.inf)
    parent = np.zeros((*cost.shape, 2), dtype=np.int32)
    total[0, 0] = cost[0, 0]
    for i in range(len(left)):
        for j in range(len(right)):
            if i == j == 0:
                continue
            choices = []
            if i:
                choices.append((total[i - 1, j], i - 1, j))
            if j:
                choices.append((total[i, j - 1], i, j - 1))
            if i and j:
                choices.append((total[i - 1, j - 1], i - 1, j - 1))
            value, before_i, before_j = min(choices)
            total[i, j] = cost[i, j] + value
            parent[i, j] = before_i, before_j
    i, j, path = len(left) - 1, len(right) - 1, []
    while True:
        path.append((i, j))
        if i == j == 0:
            break
        i, j = parent[i, j]
    matched = [[] for _ in range(len(left))]
    for beat, frame in reversed(path):
        matched[beat].append(float(audio_times[frame]))
    result, previous = [], -math.inf
    for beat, values in enumerate(matched):
        time = float(np.median(values)) if values else previous
        time = max(previous + 1e-6, time)
        result.append({"beat": float(beat), "time": round(time, 6)})
        previous = time
    return result


def time_at(tempo_map: list[dict], beat: float) -> float:
    if not tempo_map:
        return 0.0
    if beat <= tempo_map[0]["beat"]:
        return tempo_map[0]["time"]
    for left, right in zip(tempo_map, tempo_map[1:]):
        if beat <= right["beat"]:
            width = right["beat"] - left["beat"]
            return left["time"] + (beat - left["beat"]) / width * (right["time"] - left["time"])
    if len(tempo_map) == 1:
        return tempo_map[0]["time"]
    left, right = tempo_map[-2:]
    return right["time"] + (beat - right["beat"]) / (right["beat"] - left["beat"]) * (
        right["time"] - left["time"])


def apply_tempo_map(song: dict, tempo_map: list[dict]) -> dict:
    song = dict(song)
    song["tempoMap"] = tempo_map
    song["recording"] = True
    song["chords"] = [
        {**chord, "onset": time_at(tempo_map, chord["startBeat"]),
         "offset": time_at(tempo_map, chord["startBeat"] + chord["beats"])}
        for chord in song.get("chords", [])
    ]
    return song


def linear_tempo_map(song: dict, offset: float, tempo_scale: float) -> list[dict]:
    if not isinstance(offset, (int, float)) or not math.isfinite(offset) \
            or not isinstance(tempo_scale, (int, float)) or not math.isfinite(tempo_scale) \
            or tempo_scale <= 0:
        raise InvalidTiming()
    seconds = 60 / (song["bpm"] * tempo_scale)
    return [{"beat": float(beat), "time": round(offset + beat * seconds, 6)}
            for beat in sorted(set([*range(math.ceil(total_beats(song))), total_beats(song)]))]


def align_recording(job: dict, report, cancelled: Event, library: LibraryStore) -> dict:
    entry = library.get(job["song_id"])
    song = json.loads(Path(entry["song_path"]).read_text(encoding="utf-8"))
    work = app_dir("tmp") / job["id"]
    work.mkdir()
    try:
        diagnostics = {}
        started = time.perf_counter()
        report("inspect", 0)
        metadata = (job.get("details") or {}).get("metadata") or inspect_video(job["url"], work, cancelled)
        diagnostics["inspect"] = {"seconds": time.perf_counter() - started,
                                  "provider": {"effectiveProviders": ["CPU"]}}
        report("inspect", 1)
        started = time.perf_counter()
        report("download", 0)
        source = download_video(job["url"], work, cancelled,
                                lambda value: report("download", value, measured=True))
        diagnostics["download"] = {"seconds": time.perf_counter() - started,
                                   "provider": {"effectiveProviders": ["CPU"]}}
        report("download", 1)
        started = time.perf_counter()
        report("decode", 0)
        decoded = work / "recording.wav"
        decode(source, decoded, cancelled)
        diagnostics["decode"] = {"seconds": time.perf_counter() - started,
                                 "provider": {"effectiveProviders": ["CPU"]}}
        report("decode", 1)
        started = time.perf_counter()
        report("align", 0)
        audio = read_audio(decoded)
        times, chroma, _, flux = features(audio, cancelled)
        grid = beat_grid(times, flux, audio.duration)["times"]
        if len(grid) < 2:
            tempo_map = linear_tempo_map(song, 0, 1)
        else:
            grid = np.asarray(grid)
            audio_beats = np.zeros((len(grid), 12))
            for index, start in enumerate(grid):
                end = grid[index + 1] if index + 1 < len(grid) else audio.duration
                selected = (times >= start) & (times < end)
                if selected.any():
                    audio_beats[index] = chroma[selected].mean(axis=0)
            tempo_map = dtw_tempo_map(note_chroma(song), audio_beats, grid)
        diagnostics["align"] = {"seconds": time.perf_counter() - started,
                                "method": "beat-chroma-dtw-v1",
                                "provider": {"effectiveProviders": ["CPU-DSP"]}}
        report("align", 1)
        check_cancel(cancelled)
        started = time.perf_counter()
        report("finalize", 0)
        destination = Path(entry["song_path"]).parent / "recording.wav"
        shutil.move(decoded, destination)
        song = apply_tempo_map(song, tempo_map)
        song["durationSeconds"] = audio.duration
        artifacts = {**entry["artifacts"], "mix": str(destination)}
        library.update_recording(entry["id"], artifacts, song, tempo_map)
        diagnostics["finalize"] = {"seconds": time.perf_counter() - started,
                                   "provider": {"effectiveProviders": ["CPU"]}}
        report("finalize", 1)
        return {
            "metadata": metadata, "artifacts": artifacts, "warnings": [],
            "diagnostics": diagnostics,
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)
