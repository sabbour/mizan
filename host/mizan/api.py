import json
import logging
import math
import re
import shutil
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from threading import Event, Lock
from time import monotonic
from typing import Any
from urllib.parse import urlencode
from uuid import uuid4

from .artifacts import ArtifactServer
from .errors import (FFmpegUnavailable, InvalidSearch, MizanError, PipelineNotReady,
                     YoutubeMusicSearchFailed, YoutubeSearchFailed)
from .jobs import ALL_STAGES, Job, JobRunner, JobStore
from .library import public_entry
from .paths import app_dir
from .popular import fetch_popular_songs
from .telemetry import UsageSampler
from .youtube import parse_video_id

logger = logging.getLogger(__name__)
POPULAR_SONGS_CACHE_SECONDS = 6 * 60 * 60
STEM_LABELS = {
    "mix": "Full mix", "vocals": "Vocals", "piano": "Piano", "guitar": "Guitar",
    "bass": "Bass", "drums": "Drums", "other": "Other",
}

FIXES = {
    "invalid_url": "Paste a public youtube.com or youtu.be video link.",
    "video_unavailable": "Check the video is public, or sign in to YouTube in your browser.",
    "download_failed": "Check your connection and try the link again.",
    "unsupported_media": "Try a finished, public YouTube video with audio.",
    "ffmpeg_unavailable": "Download FFmpeg, extract it, then choose bin\\ffmpeg.exe in Song analysis settings.",
    "ffmpeg_validation_timeout": (
        "FFmpeg took too long to start. Wait for startup activity to finish, then retry "
        "with the selected executable; you do not need to download FFmpeg."
    ),
    "insufficient_disk": "Free disk space, then retry the job.",
    "model_failed": "Retry the job. If it fails again, restart Mizan.",
    "cloud_failed": "Review the Cloud error details and correct the reported issue before retrying.",
    "invalid_folder_name": "Use a unique name between 1 and 60 characters.",
    "folder_name_exists": "Choose a different folder name.",
    "folder_not_found": "Refresh the library and try again.",
    "youtube_search_failed": "Check your connection and retry.",
    "youtube_music_search_failed": "Check your connection and retry.",
    "popular_playlist_unavailable": "Try again later.",
}


def _cloud_provider_name(provider: str | None) -> str:
    from .cloud import PROVIDER_NAMES
    if provider is None:
        return PROVIDER_NAMES["azure"]
    return PROVIDER_NAMES.get(provider, f"Unknown Cloud provider ({provider})")


def public_job(job: Job) -> dict[str, Any]:
    details = job.get("details") or {}
    provider = details.get("cloudProvider")
    result = {
        "id": job["id"], "videoId": job["video_id"], "url": job["url"],
        "instrument": job["instrument"], "transcriptionModel": job.get("transcription_model", "muscriptor-small"),
        "stage": job["stage"], "status": job["status"],
        "progress": job["progress"], "errorCode": job["error_code"],
        **({"cloudProvider": provider,
            "cloudProviderName": _cloud_provider_name(provider)}
           if details.get("processingMode") == "cloud" else {}),
        "errorMessage": job["error_message"], "createdAt": job["created_at"],
        "updatedAt": job["updated_at"],
    }
    details = job.get("details", {})
    for name in ("warnings", "metadata", "diagnostics", "decodingErrors", "detected", "selectedInstruments",
                 "transcribedInstruments", "transcriptionQuality"):
        if name in details:
            result[name] = details[name]
    return result


def _stage_details(job: Job) -> list[dict]:
    diagnostics = (job.get("details") or {}).get("diagnostics", {})
    names = ("inspect", "download", "decode", "align", "finalize") \
        if job["kind"] == "align" else tuple(name for name in ALL_STAGES if name != "align")
    result = []
    for name in names:
        detail = diagnostics.get(name, {})
        active = (job.get("details") or {}).get("activeStage") or {}
        if job["status"] == "running" and job["stage"] == name and active.get("name") == name:
            detail = {**detail, **active}
        provider = detail.get("provider")
        effective = provider.get("effectiveProviders", []) if isinstance(provider, dict) else []
        result.append({
            "name": name, "seconds": detail.get("seconds"),
            "provider": ", ".join(effective) or None, "method": detail.get("method"),
            "model": (detail.get("model") or {}).get("id"),
            "timingNote": detail.get("timingNote"),
        })
    return result


def queue_job(job: Job, order: int | None = None) -> dict[str, Any]:
    names = ("inspect", "download", "decode", "align", "finalize") \
        if job["kind"] == "align" else tuple(name for name in ALL_STAGES if name != "align")
    stage_index = names.index(job["stage"]) if job["stage"] in names else 0
    overall = 1.0 if job["status"] == "done" else (stage_index + job["progress"]) / len(names)
    details = job.get("details") or {}
    provider = details.get("cloudProvider")
    return {
        "id": job["id"], "kind": job["kind"], "songId": job["song_id"],
        "url": job["url"], "title": job["title"], "thumbnail": job["thumbnail"],
        "status": job["status"], "stage": job["stage"], "progress": round(overall, 6),
        "processingMode": details.get("processingMode", "local"),
        **({"cloudProvider": provider,
            "cloudProviderName": _cloud_provider_name(provider)}
           if details.get("processingMode") == "cloud" else {}),
        "attemptQueuedAt": details.get("attemptQueuedAt"),
        "elapsedSeconds": details.get("elapsedSeconds"),
        "cloudElapsedSeconds": details.get("cloudElapsedSeconds"),
        "finishedAt": details.get("finishedAt"),
        "order": job["order_index"] if order is None else order, "errorCode": job["error_code"],
        "errorMessage": job["error_message"], "fix": FIXES.get(job["error_code"]),
        "warnings": details.get("warnings", []), "detected": details.get("detected"),
        "decodingErrors": details.get("decodingErrors"),
        "instrument": job["instrument"], "transcriptionModel": job.get("transcription_model", "muscriptor-small"),
        "selectedInstruments": details.get("selectedInstruments"),
        "transcribedInstruments": details.get("transcribedInstruments"),
        "transcriptionQuality": details.get("transcriptionQuality"),
        "stageProgress": job["progress"] if job["status"] == "running"
        and details.get("stageProgressMeasured") is True else None,
        "stageMessage": details.get("stageMessage"),
        "startedAt": details.get("startedAt"),
        "stageStartedAt": details.get("stageStartedAt") if job["status"] == "running" else None,
        "stages": _stage_details(job), "createdAt": job["created_at"],
        "updatedAt": job["updated_at"],
    }


def _youtube_results(entries: list, source: str, limit: int = 6) -> list[dict]:
    results, seen = [], set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        video_id = entry.get("id")
        if (not isinstance(video_id, str) or not re.fullmatch(r"[\w-]{11}", video_id, re.ASCII)
                or video_id in seen or entry.get("is_live")):
            continue
        seen.add(video_id)
        duration = entry.get("duration")
        channel = entry.get("channel") or entry.get("uploader") or entry.get("artist") or ""
        if isinstance(channel, list):
            channel = " · ".join(str(name) for name in channel if name)
        results.append({
            "id": video_id, "title": str(entry.get("title") or video_id)[:300],
            "channel": str(channel)[:200],
            "duration": duration if isinstance(duration, (int, float)) and not isinstance(duration, bool)
            and math.isfinite(duration) and duration > 0 else None,
            "thumbnail": f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg",
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "source": source,
        })
        if len(results) == limit:
            break
    return results


def response(action: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    try:
        return action()
    except MizanError as exc:
        error = {"code": exc.code, "message": str(exc)}
        if exc.code in FIXES:
            error["fix"] = FIXES[exc.code]
        return {"ok": False, "error": error}
    except Exception:
        logger.exception("Host API call failed")
        error = MizanError()
        return {"ok": False, "error": {"code": error.code, "message": str(error)}}


def cloud_setup_response(operation: str, total: int, action: Callable[[str], dict[str, Any]],
                         provider: str | None = None) -> dict[str, Any]:
    from .cloud import resolve_provider, track_setup
    def tracked():
        selected = resolve_provider(provider)
        with track_setup(operation, total, provider=selected):
            return action(selected)
    return response(tracked)


class Api:
    def __init__(self, runner: JobRunner | None = None, artifacts: ArtifactServer | None = None):
        self._runner = runner if runner is not None else JobRunner(JobStore())
        self._library = self._runner.library
        self._artifacts = artifacts
        self._add_link_lock = Lock()
        self._search_lock = Lock()
        self._youtube_music_search_lock = Lock()
        self._popular_songs_lock = Lock()
        self._popular_songs_fetch_lock = Lock()
        self._popular_songs_cache: tuple[float, dict[str, Any]] | None = None
        self._midi_result_lock = Lock()
        self._midi_results: dict[str, dict[str, Any]] = {}
        self._usage = UsageSampler()

    def cloud_providers(self) -> dict[str, Any]:
        from .cloud import provider_selection
        return response(lambda: {"ok": True, **provider_selection()})

    def cloud_settings(self, provider: str | None = None) -> dict[str, Any]:
        from .cloud import TARGET_FIELDS, load_provider_settings, resolve_provider
        def read():
            selected = resolve_provider(provider)
            settings = load_provider_settings(selected)
            public = {key: settings[key] for key in TARGET_FIELDS[selected]
                      if key in settings and key != "userObjectId"}
            return {"ok": True, "provider": selected, "settings": public}
        return response(read)

    def select_cloud_provider(self, provider: str) -> dict[str, Any]:
        from .cloud import select_provider
        return response(lambda: select_provider(provider))

    def cloud_status(self, request_id: str | None = None,
                     provider: str | None = None) -> dict[str, Any]:
        from .cloud import panel_status, resolve_provider
        return response(lambda: panel_status(request_id, provider=resolve_provider(provider)))

    def cancel_cloud_status(self, request_id: str,
                            provider: str | None = None) -> dict[str, Any]:
        from .cloud import cancel_panel_status, resolve_provider
        return response(lambda: {"ok": True, **cancel_panel_status(
            request_id, provider=resolve_provider(provider))})

    def cloud_setup_progress(self, provider: str | None = None) -> dict[str, Any]:
        from .cloud import resolve_provider, setup_progress
        return response(lambda: {"ok": True, **setup_progress(provider=resolve_provider(provider))})

    def cloud_readiness_progress(self, request_id: str, provider: str | None = None) -> dict[str, Any]:
        from .cloud import readiness_progress, resolve_provider
        return response(lambda: {"ok": True, **readiness_progress(
            request_id, provider=resolve_provider(provider))})

    def cancel_cloud_setup(self, provider: str | None = None) -> dict[str, Any]:
        from .cloud import cancel_setup, resolve_provider
        return response(lambda: {"ok": True, **cancel_setup(provider=resolve_provider(provider))})

    def list_cloud_subscriptions(self, provider: str | None = None,
                                 profile: str | None = None,
                                 region: str | None = None) -> dict[str, Any]:
        from .cloud import list_subscriptions
        options = {key: value for key, value in (("profile", profile), ("region", region))
                   if value is not None}
        return cloud_setup_response(
            "subscriptions", 2,
            lambda selected: {"ok": True,
                              "subscriptions": list_subscriptions(provider=selected, **options)},
            provider)

    def list_subscriptions(self) -> dict[str, Any]:
        return self.list_cloud_subscriptions("azure")

    def azure_subscriptions(self) -> dict[str, Any]:
        from .cloud import list_subscriptions
        return cloud_setup_response("subscriptions", 2, lambda selected: {"ok": True, "subscriptions": [
            {"id": item["subscriptionId"], "name": item["displayName"],
             "tenantId": item["tenantId"]}
            for item in list_subscriptions(provider=selected) if item["state"] == "Enabled"
        ]}, "azure")

    def configure_cloud(self, config: dict, provider: str | None = None) -> dict[str, Any]:
        from .cloud import configure
        selected = provider if provider is not None else (
            config.get("provider") if isinstance(config, dict) else None)
        return cloud_setup_response("configuration", 2,
                                    lambda pinned: configure(config, provider=pinned), selected)

    def prepare_cloud(self, config: dict, consent: bool = False,
                      provider: str | None = None) -> dict[str, Any]:
        from .cloud import prepare
        selected = provider if provider is not None else (
            config.get("provider") if isinstance(config, dict) else None)
        return cloud_setup_response("provision", 10,
                                    lambda pinned: prepare(config, consent, provider=pinned), selected)

    def enable_cloud_logging(self, consent: bool = False,
                             provider: str | None = None) -> dict[str, Any]:
        from .cloud import enable_log_analytics
        return cloud_setup_response("logging", 2,
                                    lambda pinned: enable_log_analytics(consent, provider=pinned), provider)

    def import_cloud_image(self, sourceImage: str, provider: str | None = None) -> dict[str, Any]:
        from .cloud import import_cloud_image
        return cloud_setup_response("import", 2,
                                    lambda pinned: import_cloud_image(sourceImage, provider=pinned), provider)

    def build_cloud_image(self, provider: str | None = None) -> dict[str, Any]:
        from .cloud import build_cloud_image
        return cloud_setup_response("build", 4,
                                    lambda pinned: build_cloud_image(provider=pinned), provider)

    def build_cloud_worker(self, provider: str | None = None) -> dict[str, Any]:
        from .cloud import build_cloud_image
        def build(pinned):
            result = build_cloud_image(provider=pinned)
            return {"ok": True, "provider": result["provider"],
                    "image": result["image"], "digest": result["digest"]}
        return cloud_setup_response("build", 4, build, provider)

    def finish_cloud(self, image: str, use_saved_token: bool = False,
                     provider: str | None = None) -> dict[str, Any]:
        from .cloud import CloudError, finish
        from .hf_credentials import get_hf_token
        def create(pinned):
            if type(use_saved_token) is not bool:
                raise CloudError("Approve sending the saved Hugging Face token to the Cloud provider.")
            def token_provider():
                if not use_saved_token:
                    return None
                try:
                    token = get_hf_token()
                except OSError as exc:
                    raise CloudError(
                        "Could not read the saved Hugging Face token from Windows Credential Manager.") from exc
                if not token:
                    raise CloudError(
                        "No Hugging Face token is saved. Save one in Song analysis settings, then retry.")
                return token
            return finish(image, hf_token_provider=token_provider, provider=pinned)
        return cloud_setup_response("job", 4, create, provider)

    def set_processing_mode(self, mode: str, provider: str | None = None) -> dict[str, Any]:
        from .cloud import set_mode
        return response(lambda: set_mode(mode, provider=provider))

    def clear_cloud(self, provider: str | None = None) -> dict[str, Any]:
        from .cloud import clear
        return response(lambda: clear(provider))

    def ffmpeg_status(self) -> dict[str, Any]:
        from .engine.media import ffmpeg_status
        return response(lambda: {"ok": True, **ffmpeg_status()})

    def set_ffmpeg_path(self, path: str) -> dict[str, Any]:
        from .engine.media import ffmpeg_status, validate_ffmpeg_executable

        def save():
            if type(path) is not str:
                raise FFmpegUnavailable("Enter the full path to ffmpeg.exe.")
            if path == "":
                self._runner.store.set_ffmpeg_path(None)
            else:
                executable = validate_ffmpeg_executable(path, require_absolute=True)
                self._runner.store.set_ffmpeg_path(executable)
            return {"ok": True, **ffmpeg_status()}

        return response(save)

    def get_transcription_model(self) -> dict[str, Any]:
        return response(lambda: {"ok": True, "model": self._runner.store.get_transcription_model()})

    def set_transcription_model(self, model: str) -> dict[str, Any]:
        def select():
            from .cloud import require_model, selected
            from .engine.muscriptor import check_model_resources
            if selected():
                require_model(model)
            else:
                check_model_resources(model)
            return {"ok": True, "model": self._runner.store.set_transcription_model(model)}
        return response(select)

    def model_preflight(self) -> dict[str, Any]:
        from .engine.muscriptor import model_preflight
        return response(lambda: {"ok": True, "models": model_preflight()})

    def model_download_status(self) -> dict[str, Any]:
        from .engine.muscriptor import model_download_status
        return response(lambda: {"ok": True, "models": model_download_status()})

    def start_model_download(self, model: str) -> dict[str, Any]:
        from .engine.muscriptor import start_model_download

        def start():
            start_model_download(model)
            return {"ok": True, "model": model}
        return response(start)

    def hf_token_status(self) -> dict[str, Any]:
        from .hf_credentials import get_hf_token

        def status():
            try:
                return {"ok": True, "configured": get_hf_token() is not None}
            except OSError:
                raise MizanError("Windows Credential Manager is unavailable. Try again after signing in to Windows.") from None
        return response(status)

    def set_hf_token(self, token: str) -> dict[str, Any]:
        from .hf_credentials import set_hf_token

        def save():
            try:
                set_hf_token(token)
            except ValueError:
                raise MizanError("Enter a valid Hugging Face token.") from None
            except Exception:
                logger.error("Credential Manager token write failed")
                raise MizanError("Could not save the token in Windows Credential Manager.") from None
            return {"ok": True, "configured": True}
        return response(save)

    def clear_hf_token(self) -> dict[str, Any]:
        from .hf_credentials import clear_hf_token

        def clear():
            try:
                clear_hf_token()
            except OSError:
                raise MizanError("Could not remove the token from Windows Credential Manager.") from None
            return {"ok": True, "configured": False}
        return response(clear)

    def _search_youtube_videos(self, search_url: str, source: str, lock: Lock,
                               failure: type[MizanError]) -> list[dict[str, Any]]:
        from yt_dlp import YoutubeDL
        from yt_dlp.utils import DownloadError

        try:
            with lock, YoutubeDL({
                "quiet": True, "no_warnings": True, "extract_flat": True,
                "skip_download": True, "socket_timeout": 8, "retries": 0,
                "extractor_retries": 0, "cachedir": False,
            }) as youtube:
                info = youtube.extract_info(search_url, download=False)
        except DownloadError as exc:
            logger.warning("%s search failed: %s", source, exc)
            raise failure() from exc
        if not isinstance(info, dict) or not isinstance(info.get("entries"), list):
            raise failure()
        return _youtube_results(info["entries"], source)

    @staticmethod
    def _search_text(query: str) -> str:
        if not isinstance(query, str) or len(query.strip()) > 200:
            raise InvalidSearch()
        return query.strip()

    def search_youtube(self, query: str) -> dict[str, Any]:
        def search():
            text = self._search_text(query)
            if not text:
                return {"ok": True, "results": []}
            return {"ok": True, "results": self._search_youtube_videos(
                f"ytsearch6:{text}", "youtube", self._search_lock, YoutubeSearchFailed)}
        return response(search)

    def search_youtube_music(self, query: str) -> dict[str, Any]:
        def search():
            text = self._search_text(query)
            if not text:
                return {"ok": True, "results": []}
            url = f"https://music.youtube.com/search?{urlencode({'q': text})}"
            return {"ok": True, "results": self._search_youtube_videos(
                url, "youtube_music", self._youtube_music_search_lock, YoutubeMusicSearchFailed)}
        return response(search)

    def popular_songs(self, refresh: bool = False) -> dict[str, Any]:
        def get_songs():
            with self._popular_songs_lock:
                cached = self._popular_songs_cache
                if (not refresh and cached
                        and monotonic() - cached[0] < POPULAR_SONGS_CACHE_SECONDS):
                    return {"ok": True, **cached[1]}
            with self._popular_songs_fetch_lock:
                with self._popular_songs_lock:
                    cached = self._popular_songs_cache
                    if (not refresh and cached
                            and monotonic() - cached[0] < POPULAR_SONGS_CACHE_SECONDS):
                        return {"ok": True, **cached[1]}
                try:
                    songs = fetch_popular_songs()
                except MizanError:
                    if cached:
                        return {"ok": True, **cached[1],
                                "warning": "YouTube Music could not refresh; showing the last playlist snapshot and its date."}
                    raise
                if (cached and songs.get("sections")
                        and all(section.get("status") == "unavailable" for section in songs["sections"])):
                    return {"ok": True, **cached[1],
                            "warning": "YouTube Music could not refresh; showing the last playlist snapshot and its date."}
                fetched_at = datetime.now(timezone.utc).isoformat()
                result = {**songs, "fetchedAt": fetched_at}
                with self._popular_songs_lock:
                    self._popular_songs_cache = (monotonic(), result)
                return {"ok": True, **result}
        return response(get_songs)

    def _remember_midi_results(self, results: list[dict[str, Any]]) -> list[dict[str, Any]]:
        with self._midi_result_lock:
            self._midi_results.update((result["id"], result) for result in results)
            if len(self._midi_results) > 200:
                self._midi_results = dict(list(self._midi_results.items())[-200:])
        private = {"url", "identifier", "fileName", "size", "hashes", "_licenseUrl", "_downloadPath"}
        return [{key: value for key, value in result.items() if key not in private} for result in results]

    def search_midi_commons(self, query: str) -> dict[str, Any]:
        def search():
            from .midi_search import search_commons
            return {"ok": True, "results": self._remember_midi_results(search_commons(query))}
        return response(search)

    def search_midi_mutopia(self, query: str, startat: int = 0) -> dict[str, Any]:
        def search():
            from .midi_search import search_mutopia
            results, next_start = search_mutopia(query, startat)
            return {"ok": True, "results": self._remember_midi_results(results), "nextStart": next_start}
        return response(search)

    def search_midi_archive(self, query: str) -> dict[str, Any]:
        def search():
            from .midi_search import search_archive
            return {"ok": True, "results": self._remember_midi_results(search_archive(query))}
        return response(search)

    def search_midi_bitmidi(self, query: str) -> dict[str, Any]:
        def search():
            from .midi_search import search_bitmidi
            return {"ok": True, "results": self._remember_midi_results(search_bitmidi(query))}
        return response(search)

    def search_midi_freemidi(self, query: str) -> dict[str, Any]:
        def search():
            from .midi_search import search_freemidi
            return {"ok": True, "results": self._remember_midi_results(search_freemidi(query))}
        return response(search)

    def import_midi_result(self, result_id: str, allow_unknown_license: bool = False) -> dict[str, Any]:
        def import_result():
            from .imports import import_score
            from .midi_search import download_midi
            from .errors import InvalidFile
            import base64

            if type(allow_unknown_license) is not bool:
                raise InvalidFile("Permission confirmation must be true or false.")
            with self._midi_result_lock:
                result = self._midi_results.get(result_id) if isinstance(result_id, str) else None
            if result is None:
                raise InvalidFile("Search for this MIDI again before importing it.")
            if result.get("provider") in ("bitmidi", "freemidi") and allow_unknown_license is not True:
                raise InvalidFile("Confirm that you have permission to use this file before importing it.")
            data = download_midi(result)
            entry = import_score(
                f"{result['title']}.mid", base64.b64encode(data).decode("ascii"),
                self._library, self._runner.pipeline_version,
                {"title": result["title"], "artist": result.get("artist"),
                 "sourceUrl": result["sourceUrl"], "license": result["license"],
                 "attribution": result.get("attribution"), "provider": result["source"]},
            )
            return {"ok": True, "entry": public_entry(entry, self._runner.pipeline_version)}
        return response(import_result)

    def _artifact_url(self, path: str) -> str:
        return self._artifacts.url(path) if self._artifacts else Path(path).as_uri()

    def _stems(self, artifacts: dict[str, str], song: dict) -> list[dict]:
        levels = song.get("stemLevels", {})
        method = song.get("diagnostics", {}).get("separate", {}).get("method")
        fallback = method == "hpss-complementary-v1" or (
            method != "htdemucs-6s-onnx" and "pianoOther" in artifacts and "vocals" not in artifacts)
        if fallback:
            artifacts = {**artifacts,
                         **({"piano": artifacts["pianoOther"]} if "piano" not in artifacts and "pianoOther" in artifacts else {}),
                         **({"drums": artifacts["percussion"]} if "drums" not in artifacts and "percussion" in artifacts else {})}
        labels = {"mix": "Full mix", "piano": "Harmonic (piano candidate)",
                  "drums": "Percussive (drum candidate)"} if fallback else STEM_LABELS
        return [
            {"id": name, "label": labels[name], "url": self._artifact_url(artifacts[name]),
             "level": float(levels.get(name, 1.0 if name == "mix" else 0.0))}
            for name in labels if name not in song.get("hiddenStems", {})
            and not (name == "vocals" and method == "htdemucs-6s-onnx"
                     and song.get("stemLevels", {}).get("vocals", 1) < 0.01)
            and name in artifacts and Path(artifacts[name]).is_file()
        ]

    def _inspect(self, url: str) -> dict:
        from .engine.media import inspect_video

        directory = app_dir("tmp") / ("inspect-" + str(uuid4()))
        directory.mkdir()
        try:
            return inspect_video(url, directory, Event())
        finally:
            shutil.rmtree(directory, ignore_errors=True)

    def _queue_job(self, job: Job) -> dict:
        result = queue_job(job, self._runner.store.queue_order(job["id"]))
        details = job.get("details") or {}
        found = dict(details.get("found") or {})
        artifacts = details.get("artifacts") or details.get("previewArtifacts") or {}
        if not found and artifacts.get("analysis"):
            try:
                song = json.loads(Path(artifacts["analysis"]).read_text(encoding="utf-8"))
                if not isinstance(song, dict):
                    raise ValueError("Saved analysis is not a song.")
                key = song.get("key")
                if isinstance(key, dict) and key.get("tonic") and key.get("mode"):
                    found["key"] = f"{key['tonic']} {key['mode']}"
                tempo = song.get("bpm")
                if type(tempo) in (int, float) and math.isfinite(tempo) and tempo > 0:
                    found["tempo"] = tempo
            except (OSError, ValueError) as exc:
                logger.warning("Could not read job preview facts for %s: %s", job["id"], exc)
                result["warnings"] = [*result["warnings"],
                                      "Saved key and tempo could not be loaded. Open the song for details."]
        stems = {}
        for name in ("mix", "piano", "drums"):
            path = artifacts.get(name)
            if not path or not Path(path).is_file():
                continue
            try:
                stems[name] = self._artifact_url(path)
            except FileNotFoundError:
                # Finalization moves live files into the saved cache; the next poll uses those paths.
                logger.debug("Job preview moved during finalization: %s", path)
        if stems:
            found["stems"] = stems
        result["found"] = found or None
        return result

    def add_link(self, url: str) -> dict[str, Any]:
        def add():
            video_id = parse_video_id(url)
            canonical = f"https://www.youtube.com/watch?v={video_id}"
            with self._add_link_lock:
                job = self._runner.add_link(canonical)
                return {"ok": True, "job": self._queue_job(job)}
        return response(add)

    def get_job_log(self, job_id: str) -> dict[str, Any]:
        def activity():
            job = self._runner.store.get(job_id)
            lines = []
            for stage in _stage_details(job):
                if stage["seconds"] is None:
                    continue
                name = stage["name"].replace("_", " ").capitalize()
                method = stage["model"] or stage["method"] or "built-in"
                processor = stage["provider"] or "unknown processor"
                lines.append(f"{name}: {method} on {processor} ({stage['seconds']:.2f} s)")
            if job["status"] == "running":
                stage = next((item for item in _stage_details(job) if item["name"] == job["stage"]), None)
                method = (stage or {}).get("model") or (stage or {}).get("method")
                processor = (stage or {}).get("provider")
                detail = f" [{method} on {processor}]" if method and processor else ""
                measured = job["details"].get("stageProgressMeasured") is True
                progress = f" ({job['progress']:.0%})" if measured else ""
                message = job["details"].get("stageMessage") or f"Running {job['stage']}"
                lines.append(f"{message}{progress}{detail}")
            elif job["status"] == "queued":
                lines.append("Waiting in the transcription queue.")
            elif job["status"] == "done":
                lines.append("Analysis completed.")
            elif job["status"] in ("failed", "cancelled"):
                lines.append(f"{job['status'].capitalize()}: {job.get('error_message') or 'Stopped.'}")
            lines.extend(f"Warning: {warning}" for warning in
                         (job.get("details") or {}).get("warnings", []))
            return {"ok": True, "lines": lines}
        return response(activity)

    def import_file(self, name: str, dataBase64: str) -> dict[str, Any]:
        def import_entry():
            from .imports import import_score

            return {"ok": True, "entry": public_entry(
                import_score(name, dataBase64, self._library, self._runner.pipeline_version),
                self._runner.pipeline_version)}
        return response(import_entry)

    def list_library(self) -> dict[str, Any]:
        return response(lambda: {"ok": True, "entries": [
            public_entry(entry, self._runner.pipeline_version) for entry in self._library.list()
        ]})

    def list_folders(self) -> dict[str, Any]:
        return response(lambda: {"ok": True, "folders": self._library.list_folders()})

    def create_folder(self, name: str) -> dict[str, Any]:
        return response(lambda: {"ok": True, "folder": self._library.create_folder(name)})

    def rename_folder(self, folder_id: str, name: str) -> dict[str, Any]:
        return response(lambda: {"ok": True, "folder": self._library.rename_folder(folder_id, name)})

    def delete_folder(self, folder_id: str) -> dict[str, Any]:
        def delete():
            self._library.delete_folder(folder_id)
            return {"ok": True}
        return response(delete)

    def set_song_folders(self, song_id: str, folder_ids: list[str]) -> dict[str, Any]:
        def set_folders():
            self._library.set_song_folders(song_id, folder_ids)
            return {"ok": True}
        return response(set_folders)

    def list_queue(self) -> dict[str, Any]:
        return response(lambda: {"ok": True, "jobs": [
            self._queue_job(job) for job in self._runner.store.list_queue()
        ]})

    def resource_usage(self) -> dict[str, Any]:
        def usage():
            running = any(job["status"] == "running" for job in self._runner.store.list_queue())
            return {"ok": True, "usage": self._usage.read(running)}
        return response(usage)

    def get_job(self, job_id: str) -> dict[str, Any]:
        return response(lambda: {"ok": True, "job": self._queue_job(self._runner.store.get(job_id))})

    def cancel_job(self, job_id: str) -> dict[str, Any]:
        return response(lambda: {"ok": True, "job": self._queue_job(self._runner.cancel(job_id))})

    def retry_job(self, job_id: str) -> dict[str, Any]:
        return response(lambda: {"ok": True, "job": self._queue_job(self._runner.retry(job_id))})

    def move_job(self, job_id: str, order: int) -> dict[str, Any]:
        return response(lambda: {"ok": True, "job": self._queue_job(self._runner.move(job_id, order))})

    def dismiss_job(self, job_id: str) -> dict[str, Any]:
        def dismiss():
            self._runner.store.dismiss(job_id)
            return {"ok": True}
        return response(dismiss)

    def open_song(self, song_id: str) -> dict[str, Any]:
        return response(lambda: self._open_song(song_id))

    def _open_song(self, song_id: str) -> dict[str, Any]:
        entry = self._library.get(song_id)
        try:
            song = json.loads(Path(entry["song_path"]).read_text(encoding="utf-8"))
            artifacts = {name: self._artifact_url(path) for name, path in entry["artifacts"].items()
                         if name not in ("analysis", "original") and Path(path).is_file()}
        except (OSError, ValueError) as exc:
            raise MizanError("The cached song is missing or damaged.") from exc
        result = {"ok": True, "entry": public_entry(entry, self._runner.pipeline_version),
                  "song": song, "artifacts": artifacts}
        stems = self._stems(entry["artifacts"], song)
        if stems:
            result["stems"] = stems
        return result

    def save_position(self, song_id: str, position: dict) -> dict[str, Any]:
        def save():
            self._library.save_position(song_id, position)
            return {"ok": True}
        return response(save)

    def delete_song(self, song_id: str) -> dict[str, Any]:
        def delete():
            self._library.delete(song_id)
            return {"ok": True}
        return response(delete)

    def delete_score_track(self, song_id: str, track_id: str) -> dict[str, Any]:
        def delete():
            self._library.delete_score_track(song_id, track_id)
            return self._open_song(song_id)
        return response(delete)

    def change_score_track_instrument(self, song_id: str, track_id: str, gm_program: int) -> dict[str, Any]:
        def change():
            self._library.change_score_track_instrument(song_id, track_id, gm_program)
            return self._open_song(song_id)
        return response(change)

    def reprocess_song(self, song_id: str) -> dict[str, Any]:
        return response(lambda: {"ok": True, "job": self._queue_job(self._runner.reprocess(song_id))})

    def link_recording(self, song_id: str, url: str) -> dict[str, Any]:
        def link():
            video_id = parse_video_id(url)
            canonical = f"https://www.youtube.com/watch?v={video_id}"
            self._library.get(song_id)
            return {"ok": True, "job": self._queue_job(
                self._runner.align(song_id, canonical, self._inspect(canonical)))}
        return response(link)

    def set_timing(self, song_id: str, timing: dict) -> dict[str, Any]:
        return response(lambda: self._set_timing(song_id, timing))

    def _set_timing(self, song_id: str, timing: dict) -> dict[str, Any]:
        from .alignment import apply_tempo_map, linear_tempo_map

        if not isinstance(timing, dict) or set(timing) != {"offset", "tempoScale"}:
            from .errors import InvalidTiming
            raise InvalidTiming()
        entry = self._library.get(song_id)
        if "mix" not in entry["artifacts"]:
            raise MizanError("Link a recording before adjusting its timing.")
        song = json.loads(Path(entry["song_path"]).read_text(encoding="utf-8"))
        tempo_map = linear_tempo_map(song, timing["offset"], timing["tempoScale"])
        song = apply_tempo_map(song, tempo_map)
        entry = self._library.update_recording(song_id, entry["artifacts"], song, tempo_map)
        return {"ok": True, "entry": public_entry(entry, self._runner.pipeline_version)}

    # Compatibility aliases used by the current workspace and host tests.
    def start_job(self, url: str, instrument: str) -> dict[str, Any]:
        return response(lambda: {"ok": True, "job": public_job(self._runner.start(url, instrument))})

    def list_jobs(self) -> dict[str, Any]:
        return response(lambda: {"ok": True, "jobs": [
            self._queue_job(job) for job in self._runner.store.list()
        ]})

    def open_result(self, job_id: str) -> dict[str, Any]:
        return response(lambda: self._open_result(job_id))

    def _open_result(self, job_id: str) -> dict[str, Any]:
        job = self._runner.store.get(job_id)
        if job["status"] != "done":
            raise PipelineNotReady()
        result = {"ok": True, "job": self._queue_job(job)}
        artifacts = job.get("details", {}).get("artifacts")
        if artifacts:
            try:
                song = json.loads(Path(artifacts["analysis"]).read_text(encoding="utf-8"))
                if not all(Path(path).is_file() for path in artifacts.values()):
                    raise OSError("A cached artifact is missing.")
            except (OSError, ValueError) as exc:
                raise MizanError("The cached result is missing or damaged. Start the job again.") from exc
            result.update(song=song, artifacts={
                name: self._artifact_url(path) for name, path in artifacts.items()
            })
            stems = self._stems(artifacts, song)
            if stems:
                result["stems"] = stems
        return result
