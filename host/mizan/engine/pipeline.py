import errno
from collections import Counter
import ctypes
import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
from threading import Event, Thread
import time
from uuid import UUID

from ..errors import Cancelled, InsufficientDisk, InvalidInstrument, InvalidTranscriptionModel, InvalidUrl, SongNotFound, UnsupportedMedia
from ..library import LibraryStore
from ..paths import app_dir
from ..youtube import parse_video_id
from . import VERSION
from .audio import Audio, read_audio, write_audio
from .detect import (detect_instruments, insufficient_score_evidence, selected_instruments,
                     stem_levels, stem_peak_levels, transcription_quality)
from .harmony import analyze_harmony
from .media import copy_decoded, decode, download_video, ffmpeg_path, inspect_video, preflight
from .models import HTDEMUCS_6S
from .output import build_song, detected_gm_program, export_midi, export_musicxml, quantize
from .providers import check_cancel
from .separation import SOURCES, _demucs
from .vocals import clean_melody

logger = logging.getLogger(__name__)


def _decoding_error_summary(by_input: dict[str, dict] | None) -> dict | None:
    if not by_input:
        return None
    counts = {name: bucket["count"] for name, bucket in by_input.items()}
    total = sum(counts.values())
    details = [
        {"input": name, "category": "eos_token_limit", **detail}
        for name, bucket in by_input.items() for detail in bucket["details"]
    ]
    return {"count": total, "byInput": counts, "details": details,
            "detailsTruncated": total > len(details)}


def _reported_model_seconds(details: dict) -> float | None:
    seconds = details.get("seconds")
    if type(seconds) in (int, float) and math.isfinite(seconds) and seconds >= 0:
        return float(seconds)
    return None


def _hidden_stems(levels: dict[str, float], peak_levels: dict[str, float]) -> dict[str, str]:
    thresholds = {"piano": 0.01, "drums": 0.18, "vocals": 0.01,
                  "guitar": 0.05, "bass": 0.05, "other": 0.05}
    return {
        name: (f"{name.capitalize()} recording hidden: its loudest 100 ms "
               f"is only {peak_levels[name]:.1%} of the full mix peak; "
               "the isolated signal is too weak to offer as a listening part. "
               "This does not prove the instrument is absent.")
        for name, threshold in thresholds.items()
        if peak_levels[name] < threshold or name == "vocals" and levels[name] < 0.01
    }


def _available_physical_ram() -> int | None:
    if os.name != "nt":
        return None
    try:
        from .muscriptor import _MemoryStatus
        status = _MemoryStatus()
        status.dwLength = ctypes.sizeof(status)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(_MemoryStatus)]
        kernel.GlobalMemoryStatusEx.restype = ctypes.c_int
        if not kernel.GlobalMemoryStatusEx(ctypes.byref(status)):
            return None
        return status.ullAvailPhys
    except (OSError, AttributeError, ValueError, OverflowError):
        return None


def _parallel_ram_safe(model: str, duration: float, rate: int = 44100) -> bool:
    if (os.name != "nt" or model not in ("muscriptor-small", "muscriptor-medium")
            or not math.isfinite(duration) or duration <= 0):
        return False
    available = _available_physical_ram()
    # Reserve the bounded worker, six stereo stems plus conversion buffers,
    # a fixed ONNX workspace, and RAM for the host and other processes.
    gib = 1024 ** 3
    demucs_bytes = 2 * gib + duration * max(44100, rate) * 2 * 4 * 20
    return available is not None and available >= (
        {"muscriptor-small": 4, "muscriptor-medium": 8}[model] * gib
        + demucs_bytes + 2 * gib)


def _reuse_recording(job: dict, output: Path, cancelled: Event) -> tuple[dict | None, list[str], Path | None]:
    if not job.get("song_id"):
        return None, [], None
    try:
        # Resolve only host-owned library artifacts, never paths supplied in job details.
        entry = LibraryStore().get(job["song_id"])
        video_id = parse_video_id(job["url"])
        if (entry["source"] != "youtube"
                or parse_video_id(entry["source_url"]) != video_id
                or job.get("video_id", video_id) != video_id):
            raise UnsupportedMedia("Saved recording does not match this YouTube video.")
        failures = []
        artifacts = entry["artifacts"] or {}
        for value in dict.fromkeys(artifacts.get(name) for name in ("mix", "original")):
            if not value:
                continue
            check_cancel(cancelled)
            try:
                try:
                    source = Path(value).resolve()
                except OSError as exc:
                    raise UnsupportedMedia(f"Cannot resolve saved audio: {exc}") from exc
                if (not source.is_relative_to(app_dir("cache").resolve())
                        or source.suffix.lower() != ".wav"):
                    raise UnsupportedMedia("Saved audio is not a WAV in the library cache.")
                duration = copy_decoded(source, output, cancelled)
            except (UnsupportedMedia, ValueError) as exc:
                failures.append(str(exc))
                continue
            return {
                "title": entry["title"], "thumbnail": entry["thumbnail"],
                "channel": entry.get("artist"), "duration": duration,
                "videoId": video_id, "source": job["url"],
            }, [], source
        raise UnsupportedMedia("; ".join(failures) or "No saved mix or original audio exists.")
    except (SongNotFound, InvalidUrl, UnsupportedMedia) as exc:
        output.unlink(missing_ok=True)
        warning = f"Saved audio could not be reused; downloading from YouTube again. {exc}"
        logger.warning("%s", warning)
        return None, [warning], None


def _reuse_stems(song_id: str, recording: Path, audio: Audio, directory: Path,
                 cancelled: Event, warnings: list[str]) -> tuple[dict[str, Audio], dict] | None:
    entry = LibraryStore().get(song_id)
    artifacts = entry["artifacts"] or {}
    if not all(artifacts.get(name) for name in SOURCES):
        return None
    try:
        analysis = Path(entry["song_path"]).resolve()
        if analysis != recording.parent / "analysis.json":
            raise UnsupportedMedia("Saved analysis does not belong to the recording.")
        prior = json.loads(analysis.read_text(encoding="utf-8"))
        if (prior.get("diagnostics", {}).get("separate", {}).get("method") != "htdemucs-6s-onnx"
                or prior.get("modelVersions", {}).get("separation") != HTDEMUCS_6S["version"]):
            return None
        stems = {}
        for name in SOURCES:
            check_cancel(cancelled)
            stem_path = Path(artifacts[name]).resolve()
            if stem_path != recording.parent / f"{name}.wav":
                raise UnsupportedMedia(f"Saved {name} stem is not in this recording's cache.")
            copy = directory / f"{name}.wav"
            copy_decoded(stem_path, copy, cancelled)
            stem = read_audio(copy)
            if stem.rate != audio.rate or stem.samples.shape != audio.samples.shape:
                raise UnsupportedMedia(f"Saved {name} stem no longer matches the recording.")
            stems[name] = stem
        return stems, {
            "method": "htdemucs-6s-onnx", "model": HTDEMUCS_6S,
            "provider": {"effectiveProviders": ["Saved audio"]}, "reused": True,
            "sampleRate": audio.rate, "samples": len(audio.samples),
            "latencySamples": 0, "warnings": [],
        }
    except (OSError, ValueError, KeyError, TypeError, UnsupportedMedia) as exc:
        message = f"Saved stems could not be reused; running separation again. {exc}"
        logger.warning("%s", message)
        warnings.append(message)
        return None


def analyze_decoded(source: Path, directory: Path, *, title: str, url: str, instrument: str,
                    report, cancelled: Event, live_details: dict | None = None,
                    transcription_model: str = "muscriptor-small",
                    saved_recording: Path | None = None,
                    saved_song_id: str | None = None,
                    cloud_result: dict | None = None) -> dict:
    if instrument not in ("auto", "piano", "drums"):
        raise InvalidInstrument()
    from .muscriptor import MODELS
    if transcription_model not in MODELS:
        raise InvalidTranscriptionModel()
    live = live_details if live_details is not None else {}
    diagnostics = live.setdefault("diagnostics", {})
    quality = {}
    transcribed = []
    live.update(transcriptionQuality=quality, transcribedInstruments=transcribed)
    audio = read_audio(source)
    detect_started = time.perf_counter()
    report("detect", 0)
    separation_started = time.perf_counter()
    cached_stems = (_reuse_stems(saved_song_id, saved_recording, audio, directory, cancelled,
                                 live.setdefault("warnings", []))
                    if saved_recording and saved_song_id and cloud_result is None
                    else None)
    def separator_active(details):
        live["activeStage"] = {"name": "detect", **details}
        report("detect", 0)
    parallel = cloud_result is None and cached_stems is None and _parallel_ram_safe(
        transcription_model, audio.duration, audio.rate)
    mix_result = {}
    mix_progress = [0.0]
    if parallel:
        from .muscriptor import transcribe_official
        abort = Event()

        class CombinedCancel:
            def is_set(self):
                return cancelled.is_set() or abort.is_set()

        def transcribe_mix():
            began = time.perf_counter()
            try:
                mix_result["notes"] = transcribe_official(
                    transcription_model, audio, CombinedCancel(),
                    lambda value: mix_progress.__setitem__(0, max(mix_progress[0], value)),
                    source=source)
            except BaseException as exc:
                mix_result["error"] = exc
                abort.set()
            finally:
                mix_result["seconds"] = time.perf_counter() - began

        worker = Thread(target=transcribe_mix, name="mizan-original-mix")
        worker.start()
    if cloud_result is not None:
        stems = {name: read_audio(directory / f"{name}.wav") for name in SOURCES}
        if any(stem.rate != audio.rate or stem.samples.shape != audio.samples.shape
               for stem in stems.values()):
            raise UnsupportedMedia("Cloud stems do not match the original recording.")
        separation = cloud_result["separation"]
        separator_active({"method": separation["method"], "model": separation["model"],
                          "provider": separation["provider"]})
        report("detect", 0.8)
    elif cached_stems is None:
        try:
            stems, separation = _demucs(
                audio, CombinedCancel() if parallel else cancelled,
                lambda p: report("detect", p * 0.8), separator_active)
        except BaseException as exc:
            if parallel:
                abort.set()
                worker.join()
                if "error" in mix_result and not cancelled.is_set() and isinstance(exc, Cancelled):
                    raise mix_result["error"] from None
            raise
    else:
        stems, separation = cached_stems
        separator_active({"method": "saved-six-stem-wav", "provider": separation["provider"]})
    separation_seconds = time.perf_counter() - separation_started
    if parallel:
        if worker.is_alive():
            live["activeStage"] = {
                "name": "detect", "method": f"{transcription_model}-pytorch-cpu",
                "model": {"id": transcription_model},
                "provider": {"effectiveProviders": ["PyTorch CPU"]},
            }
            report("detect", 0.8)
        while worker.is_alive():
            if cancelled.is_set():
                abort.set()
            worker.join(0.2)
        check_cancel(cancelled)
        if "error" in mix_result:
            raise mix_result["error"]
    started = time.perf_counter()
    levels = stem_levels(audio, stems)
    peak_levels = stem_peak_levels(audio, stems)
    detected = detect_instruments(audio, stems)
    selected = selected_instruments(detected) if instrument == "auto" else [instrument]
    if instrument == "auto":
        if levels["vocals"] >= 0.01 and peak_levels["vocals"] >= 0.01:
            selected.append("vocals")
        detected["vocals"] = levels["vocals"]
    live.update(detected=detected, selectedInstruments=selected)
    diagnostics["detect"] = {
        "method": ("stem-rms-priority-v2" if cloud_result is not None else
                   f"{separation['method']}+stem-rms-priority-v2")
                  + ("+muscriptor-overlap" if parallel else ""),
        "selectedInstruments": selected,
        "provider": {"effectiveProviders": ["CPU-DSP", "PyTorch CPU"] if parallel
                     else ["CPU-DSP"]},
        "seconds": time.perf_counter() - detect_started,
        "selectionSeconds": time.perf_counter() - started,
    }
    report("detect", 1)
    started = time.perf_counter()
    report("separate", 0)
    if cached_stems is None and cloud_result is None:
        for name, stem in stems.items():
            write_audio(directory / f"{name}.wav", stem)
    hidden = _hidden_stems(levels, peak_levels)
    live["previewArtifacts"] = {
        "mix": str(source),
        **{name: str(directory / f"{name}.wav")
           for name in ("piano", "drums") if name not in hidden},
    }
    diagnostics["separate"] = {
        **separation,
        "seconds": (_reported_model_seconds(separation) if cloud_result is not None
                    else time.perf_counter() - started),
        **({"timingNote": "HT-Demucs ran on the Cloud GPU; compute time was not reported."}
           if cloud_result is not None and _reported_model_seconds(separation) is None else {}),
        **({"inferenceSeconds": separation_seconds} if cloud_result is None else {}),
    }
    report("separate", 1)
    started = time.perf_counter()
    report("transcribe", 0)
    piano, drums, vocals = [], [], []
    transcriptions = []
    from .muscriptor import transcribe_official as transcribe
    live["activeStage"] = {
        "name": "transcribe", "method": f"{transcription_model}-pytorch-{'cuda' if cloud_result else 'cpu'}",
        "model": {"id": transcription_model},
        "provider": {"effectiveProviders": ["PyTorch CUDA" if cloud_result else "PyTorch CPU"]},
    }
    report("transcribe", 0)
    if cloud_result is not None:
        official_piano, official_drums, official_details, model_events = cloud_result["mix"]
        report("transcribe", 0.5)
    elif parallel:
        official_piano, official_drums, official_details, model_events = mix_result["notes"]
        report("transcribe", mix_progress[0] * (0.5 if "vocals" in selected else 1))
    else:
        official_piano, official_drums, official_details, model_events = transcribe(
            transcription_model, audio, cancelled,
            lambda p: report("transcribe", p, measured=True) if "vocals" not in selected
            else report("transcribe", p * 0.5),
            source=source)
    decoding_by_input = {}
    if cloud_result is None and "decodingErrors" in official_details:
        decoding_by_input["mix"] = official_details["decodingErrors"]
    for selected_instrument in selected:
        if selected_instrument == "piano":
            piano, details = official_piano, dict(official_details)
        elif selected_instrument == "vocals":
            live["activeStage"] = {"name": "transcribe", "method": official_details["method"],
                                   "model": official_details["model"],
                                   "provider": official_details["provider"], "input": "vocals-stem"}
            if cloud_result is not None:
                _, _, stem_details, stem_events = cloud_result["vocals"]
                report("transcribe", 1)
            else:
                _, _, stem_details, stem_events = transcribe(
                    transcription_model, stems["vocals"], cancelled,
                    lambda p: report("transcribe", 0.5 + p * 0.5),
                    source=directory / "vocals.wav")
                if "decodingErrors" in stem_details:
                    decoding_by_input["vocals"] = stem_details["decodingErrors"]
            vocals = [
                {"midi": event["midi"], "onset": event["onset"],
                 "offset": min(event["offset"], audio.duration), "velocity": 0.5,
                 "confidence": 0.4, "generated": False,
                 "sourceInstrument": event["instrument"]}
                for event in stem_events
                if event["instrument"] == "voice" and event["onset"] < audio.duration
            ]
            vocals = clean_melody(vocals)
            details = {**stem_details, "input": "vocals-stem",
                       "warnings": [
                           *stem_details.get("warnings", []),
                           f"{transcription_model} vocal melody is an uncalibrated draft from the "
                           "isolated stem, not lyrics or a singer's voice; leakage and backing voices "
                           "can cause incorrect notes.",
                       ]}
        else:
            drums, details = official_drums, dict(official_details)
        events = {"piano": piano, "drums": drums, "vocals": vocals}[selected_instrument]
        quality[selected_instrument] = transcription_quality(
            selected_instrument, events, stems[selected_instrument], levels[selected_instrument])
        quality[selected_instrument]["stemPeakLevel"] = peak_levels[selected_instrument]
        reason = insufficient_score_evidence(selected_instrument, quality[selected_instrument])
        if reason:
            quality[selected_instrument]["scoreWithheld"] = True
            quality[selected_instrument]["reasons"].append(reason)
            quality[selected_instrument]["warnings"].append(
                f"{selected_instrument.capitalize()}: score withheld; {reason} "
                "The isolated recording is assessed separately; this does not prove absence.")
            if selected_instrument == "drums":
                drums = []
            elif selected_instrument == "vocals":
                vocals = []
            elif selected_instrument == "piano":
                piano = []
        elif events:
            transcribed.append(selected_instrument)
        transcriptions.append((selected_instrument, details))
        live["warnings"] = list(dict.fromkeys([
            *live.get("warnings", []), *separation.get("warnings", []),
            *details.get("warnings", []), *quality[selected_instrument]["warnings"],
        ]))
    providers = list(dict.fromkeys(
        provider for _, details in transcriptions
        for provider in details.get("provider", {}).get("effectiveProviders", [])
    ))
    diagnostics["transcribe"] = {
        "method": "+".join(details["method"] for _, details in transcriptions),
        "model": next((details.get("model") for _, details in transcriptions if details.get("model")), None),
        "provider": {"effectiveProviders": providers or ["CPU"]},
        "warnings": [warning for _, details in transcriptions for warning in details.get("warnings", [])],
        "instruments": {name: details for name, details in transcriptions},
        "seconds": (None if cloud_result is not None else
                    time.perf_counter() - started + (mix_result["seconds"] if parallel else 0)),
        **({"timingNote": "MuScriptor ran on the Cloud GPU; compute time was not reported."}
           if cloud_result is not None else {}),
    }
    decoding_errors = (cloud_result.get("decodingErrors") if cloud_result is not None
                   else _decoding_error_summary(decoding_by_input))
    if decoding_errors is not None:
        diagnostics["transcribe"]["decodingErrors"] = decoding_errors
        if decoding_errors["count"]:
            warning = (f"Best-effort transcription: {decoding_errors['count']} chunks reached the "
                       "decoding limit. Notes may be missing or cut short.")
            diagnostics["transcribe"]["warnings"].insert(0, warning)
            live["warnings"] = [warning, *live.get("warnings", [])]
    report("transcribe", 1)
    started = time.perf_counter()
    report("chords", 0)
    # Full mix retains attacks for beat analysis; peak-based chroma reduces noise. Transcribed
    # onsets show whether the tracked beat divides in halves or thirds (simple vs compound time).
    onsets = sorted({round(event["onset"], 4) for event in (*model_events, *piano, *drums, *(vocals or []))
                     if event["onset"] < audio.duration})
    harmony = analyze_harmony(audio, cancelled, onsets)
    pitched_notes = bool(piano or vocals or any(
        event["instrument"] not in ("drums", "acoustic_piano", "program_0")
        and event["onset"] < audio.duration for event in model_events))
    if not pitched_notes:
        harmony["key"] = None
        for chord in harmony["chords"]:
            chord.update(symbol=None, numeral=None, role=None, tones=[], flats=False, confidence=0.0)
        harmony["warnings"].append(
            "No pitched notes were transcribed; chord names from the full mix "
            "would be untrustworthy, so harmony and generated chord parts were withheld.")
    for name, details in transcriptions:
        if not quality[name].get("scoreWithheld"):
            quality[name] = transcription_quality(
                name, {"piano": piano, "drums": drums, "vocals": vocals}[name],
                stems[name], levels[name], harmony["timing"])
            quality[name]["stemPeakLevel"] = peak_levels[name]
        details["quality"] = quality[name]
    diagnostics["transcribe"]["warnings"].extend(
        warning for result in quality.values() for warning in result["warnings"])
    live["warnings"] = list(dict.fromkeys([
        *live.get("warnings", []), *diagnostics["transcribe"]["warnings"]]))
    beat_details = harmony.pop("beatDetails")
    diagnostics["chords"] = {
        "method": f"{beat_details['method']}+chroma-templates-uncertain-v3",
        "model": beat_details.get("model"),
        "provider": beat_details["provider"],
        "seconds": time.perf_counter() - started,
    }
    key = harmony["key"]
    live["found"] = {
        **({"key": f"{key['tonic']} {key['mode']}"} if key else {}),
        "tempo": harmony["bpm"],
    }
    report("chords", 1)
    started = time.perf_counter()
    report("notation", 0)
    song = build_song(title, url, audio.duration, harmony, piano, drums, diagnostics, vocals=vocals)
    if decoding_errors is not None:
        song["decodingErrors"] = decoding_errors
    for track in song["tracks"]:
        if track["id"] == "drums":
            track["detail"] = "MuScriptor drum notes: kick, snare, hats, toms and cymbals"
    counts = Counter(event["instrument"] for event in model_events)
    instrument_ids = {}
    used_ids = {track["id"] for track in song["tracks"]}
    for name in sorted(counts):
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "unknown"
        base = f"instrument-{slug}"
        track_id = base
        index = 2
        while track_id in used_ids:
            track_id = f"{base}-{index}"
            index += 1
        instrument_ids[name] = track_id
        used_ids.add(track_id)
    song["modelEvents"] = model_events
    song["detectedInstrumentTracks"] = [
        {"id": instrument_ids[name], "name": name.replace("_", " ").title(),
         "instrument": name, "kind": "detected-notes", "rendered": False,
         "eventCount": count}
        for name, count in sorted(counts.items())
    ]
    song["instrumentNotes"] = {}
    for name in sorted(counts):
        if name in ("acoustic_piano", "program_0", "drums"):
            continue
        track_id = instrument_ids[name]
        notes = []
        for event in model_events:
            if event["instrument"] != name or event["onset"] >= audio.duration:
                continue
            start = quantize(event["onset"], song["bpm"], harmony["timing"]["phaseSeconds"], song.get("tempoMap"))
            end = quantize(min(event["offset"], audio.duration), song["bpm"], harmony["timing"]["phaseSeconds"],
                           song.get("tempoMap"))
            notes.append({
                **event, "trackId": track_id, "sourceInstrument": name,
                "startBeat": start, "beats": round(max(0.01, end - start), 6),
                "velocity": 0.5, "confidence": 0.4, "generated": False,
            })
        if not notes:
            continue
        song["instrumentNotes"][track_id] = notes
        transcribed.append(name)
        gm_program = detected_gm_program(name)
        song["tracks"].append({
            "id": track_id, "instrument": "other", "name": name.replace("_", " ").title(),
            "group": "detected", "sourceInstrument": name, "scoreStatus": "draft",
            "detail": "Draft notes from original mix; unverified instrument label",
            **({"gmProgram": gm_program} if gm_program is not None else {}),
        })
    if song["instrumentNotes"]:
        song["warnings"].append(
            "Additional MuScriptor instrument parts are unverified original-mix note detections, "
            "not stem-isolated or validated guitar, bass, string, or other instrument scores.")
    song["detected"] = detected
    song["stemLevels"] = {"mix": 1.0, **levels}
    song["stemPeakLevels"] = peak_levels
    song["hiddenStems"] = hidden
    diagnostics["separate"]["hiddenStems"] = hidden
    song["warnings"].extend(hidden.values())
    song.update(selectedInstruments=selected, transcribedInstruments=transcribed,
                transcriptionQuality=quality)
    for track in song["tracks"]:
        result = quality.get(track["id"])
        if result:
            track["quality"] = result["status"]
            if result["status"] == "tentative":
                track["detail"] += "; tentative / low confidence"
                song["confidence"][track["id"]] = ["low"] * song["bars"]
    song["warnings"] = list(dict.fromkeys([*live.get("warnings", []), *song["warnings"]]))
    live["warnings"] = song["warnings"]
    check_cancel(cancelled)
    export_midi(song, directory / "score.mid")
    export_musicxml(song, directory / "score.musicxml")
    diagnostics["notation"] = {"method": "voice-leading-v2+mido", "provider": {"effectiveProviders": ["CPU"]},
                                "seconds": time.perf_counter() - started}
    song["modelVersions"] = {"pipeline": VERSION,
                              **{name: details.get("model", {}).get("version", details["method"])
                                 for name, details in transcriptions},
                              "separation": separation.get("model", {}).get("version", separation["method"]),
                              "beats": beat_details.get("model", {}).get("version", beat_details["method"]),
                              "harmony": "chroma-templates-uncertain-v3",
                              "accompaniment": "voice-leading-v2"}
    report("notation", 1)
    return song


def run_pipeline(job: dict, report, cancelled: Event) -> dict:
    UUID(job["id"])
    if job["instrument"] not in ("auto", "piano", "drums"):
        raise InvalidInstrument()
    model = job.get("transcription_model", "muscriptor-small")
    from .muscriptor import MODELS
    if model not in MODELS:
        raise InvalidTranscriptionModel()
    work = app_dir("tmp") / job["id"]
    destination = app_dir("cache") / job["id"]
    work.mkdir()
    committed = False
    diagnostics = {}
    try:
        job["details"] = {**(job.get("details") or {}), "diagnostics": diagnostics}
        cloud = job["details"].get("processingMode") == "cloud"
        started = time.perf_counter()
        if not cloud:
            report("inspect", 0, message="Preparing transcription model")
            from .muscriptor import prepare_model
            prepare_model(model, cancelled, lambda value: report(
                "inspect", value * 0.8, message="Downloading transcription model"))
        decoded = work / "original.wav"
        if job.get("song_id"):
            report("inspect", 0, message="Validating saved audio")
        metadata, warnings, saved_recording = _reuse_recording(job, decoded, cancelled)
        reused = metadata is not None
        job["details"]["warnings"] = warnings
        if not reused:
            # Persist the fallback warning even if inspection/download fails offline.
            report("inspect", 0.8, message="Reading video details")
            ffmpeg_path()
            metadata = (None if job.get("song_id") else job["details"].get("metadata")) \
                or inspect_video(job["url"], work, cancelled)
        warnings.extend(preflight(metadata, work))
        job["details"].update(metadata=metadata, warnings=warnings)
        diagnostics["inspect"] = {
            "seconds": time.perf_counter() - started, "provider": {"effectiveProviders": ["CPU"]},
            "method": "saved-audio-validation" if reused else "youtube-metadata",
        }
        report("inspect", 1)
        started = time.perf_counter()
        report("download", 0)
        if not reused:
            source = download_video(job["url"], work, cancelled,
                                    lambda p: report("download", p, measured=True))
        diagnostics["download"] = {
            "seconds": 0.0 if reused else time.perf_counter() - started,
            "provider": {"effectiveProviders": ["CPU"]},
            "method": "reused-saved-audio" if reused else "yt-dlp",
        }
        report("download", 1)
        started = time.perf_counter()
        report("decode", 0)
        if not reused:
            decode(source, decoded, cancelled)
            source.unlink()
        diagnostics["decode"] = {
            "seconds": 0.0 if reused else time.perf_counter() - started,
            "provider": {"effectiveProviders": ["CPU"]},
            "method": "reused-decoded-wav" if reused else "ffmpeg",
        }
        job["details"]["previewArtifacts"] = {"mix": str(decoded)}
        report("decode", 1)
        cloud_result = None
        if cloud:
            from ..cloud import CloudError, offload, provider_for_job, status, PROVIDER_NAMES
            provider = provider_for_job(job.get("details", {}).get("cloudProvider"))
            target = job.get("details", {}).get("cloudTarget")
            report("detect", 0, message=f"Connecting to {PROVIDER_NAMES[provider]} processing")
            cloud_status = (status(provider=provider) if target is None
                            else status(provider=provider, target=target))
            if not cloud_status["available"] or not cloud_status["configured"]:
                raise CloudError(cloud_status.get("issue") or "Cloud processing is not ready.")
            cloud_started = time.perf_counter()
            try:
                if target is None:
                    cloud_result, names = offload(decoded, work, model, cancelled, report,
                                                  provider=provider)
                else:
                    cloud_result, names = offload(decoded, work, model, cancelled, report,
                                                  provider=provider, target=target)
            finally:
                cloud_elapsed = time.perf_counter() - cloud_started
                job["details"]["cloudElapsedSeconds"] = round(cloud_elapsed, 3)
                diagnostics["cloudRoundTrip"] = {
                    "method": "cloud-job-and-local-materialization",
                    "provider": provider,
                    "seconds": cloud_elapsed,
                    "timingNote": (
                        "Includes remote execution, result transfer, and host-side "
                        "materialization; it is not GPU model compute time."),
                }
            job["details"]["cloudFiles"] = names
        song = analyze_decoded(decoded, work, title=metadata["title"], url=job["url"],
                               instrument=job["instrument"], report=report, cancelled=cancelled,
                               live_details=job["details"],
                               transcription_model=model,
                               saved_recording=saved_recording, saved_song_id=job.get("song_id"),
                               cloud_result=cloud_result)
        song["diagnostics"] = {**diagnostics, **song["diagnostics"]}
        song["warnings"] = warnings + song["warnings"]
        report("finalize", 0)
        started = time.perf_counter()
        for name in song["hiddenStems"]:
            (work / f"{name}.wav").unlink()
        artifacts = {"analysis": "analysis.json", "midi": "score.mid", "musicxml": "score.musicxml", "original": "original.wav",
                     "mix": "original.wav", **{name: f"{name}.wav" for name in
                                               ("vocals", "piano", "guitar", "bass", "drums", "other")
                                               if name not in song["hiddenStems"]},
                     **({"pianoOther": "piano.wav"} if "piano" not in song["hiddenStems"] else {}),
                     **({"percussion": "drums.wav"} if "drums" not in song["hiddenStems"] else {})}
        for name in ("command.out", "command.err"):
            (work / name).unlink(missing_ok=True)
        song["diagnostics"]["finalize"] = {"seconds": time.perf_counter() - started, "provider": {"effectiveProviders": ["CPU"]}}
        (work / "analysis.json").write_text(json.dumps(song, ensure_ascii=True, allow_nan=False), encoding="utf-8")
        details = {"metadata": metadata, "warnings": song["warnings"], "modelVersions": song["modelVersions"],
                   "artifacts": {name: str(destination / filename) for name, filename in artifacts.items()},
                   "diagnostics": song["diagnostics"], "detected": song["detected"],
                   "selectedInstruments": song["selectedInstruments"],
                   "transcribedInstruments": song["transcribedInstruments"],
                   "transcriptionQuality": song["transcriptionQuality"],
                   "found": job["details"].get("found", {}),
                   "cacheable": (os.environ.get("MIZAN_BEATS", "auto") != "auto"
                                 or "beat-this" in song["diagnostics"]["chords"]["method"])}
        if cloud and "cloudElapsedSeconds" in job["details"]:
            details["cloudElapsedSeconds"] = job["details"]["cloudElapsedSeconds"]
        if "decodingErrors" in song:
            details["decodingErrors"] = song["decodingErrors"]
        if cloud:
            details["cloudFiles"] = job["details"]["cloudFiles"]
        (work / "manifest.json").write_text(json.dumps(details, allow_nan=False), encoding="utf-8")
        check_cancel(cancelled)
        report("finalize", 1)
        work.rename(destination)
        committed = True
        return details
    except OSError as exc:
        if exc.errno == errno.ENOSPC:
            raise InsufficientDisk() from exc
        raise
    finally:
        if not committed:
            shutil.rmtree(work)


def discard_result(job_id: str) -> None:
    UUID(job_id)
    directory = app_dir("cache") / job_id
    if directory.is_dir():
        shutil.rmtree(directory)
