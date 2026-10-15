import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
from concurrent.futures import CancelledError, Future, TimeoutError as FutureTimeoutError
from contextlib import closing
from threading import Event, Lock
import time
import warnings

from scipy.io.wavfile import WavFileWarning

from ..errors import (DownloadFailed, FFmpegProbeTimedOut, FFmpegUnavailable, InsufficientDisk,
                      UnsupportedMedia, VideoUnavailable)
from ..paths import home
from .audio import read_audio
from .providers import check_cancel

logger = logging.getLogger(__name__)
FFMPEG_DOWNLOAD_URL = "https://www.gyan.dev/ffmpeg/builds/"
FFMPEG_VERSION_TIMEOUT_SECONDS = 30
_FFMPEG_VALIDATION_LOCK = Lock()
_FFMPEG_VALIDATION_CACHE: dict[str, tuple[int, int, int, int, int]] = {}
_FFMPEG_VALIDATION_IN_FLIGHT: dict[
    tuple[str, tuple[int, int, int, int, int]], Future[None]
] = {}


def copy_decoded(source: Path, output: Path, cancelled: Event) -> float:
    """Copy, never move/link, a saved WAV into this job's disposable workspace."""
    check_cancel(cancelled)
    try:
        stream = source.open("rb")
    except OSError as exc:
        raise UnsupportedMedia(f"Cannot open saved audio: {exc}") from exc
    with stream, output.open("wb") as target:
        while True:
            check_cancel(cancelled)
            try:
                chunk = stream.read(1024 * 1024)
            except OSError as exc:
                raise UnsupportedMedia(f"Cannot read saved audio: {exc}") from exc
            if not chunk:
                break
            target.write(chunk)
    check_cancel(cancelled)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", WavFileWarning)
            audio = read_audio(output)
    except (WavFileWarning, EOFError) as exc:
        raise UnsupportedMedia(f"Saved WAV is incomplete or unsupported: {exc}") from exc
    check_cancel(cancelled)
    return audio.duration


def _saved_ffmpeg_path() -> str | None:
    if not os.environ.get("MIZAN_HOME") and not os.environ.get("LOCALAPPDATA"):
        return None
    database = home() / "mizan.db"
    if not database.is_file():
        return None
    try:
        with closing(sqlite3.connect(database, timeout=1)) as connection:
            row = connection.execute(
                "SELECT value FROM settings WHERE key = 'ffmpeg_path'").fetchone()
    except sqlite3.OperationalError as exc:
        if "no such table: settings" in str(exc).lower():
            return None
        raise FFmpegUnavailable("Mizan could not read the saved FFmpeg path.") from exc
    return row[0] if row else None


def _normalize_ffmpeg_path(value: str, *, require_absolute: bool) -> str:
    if type(value) is not str:
        raise FFmpegUnavailable("Enter the full path to ffmpeg.exe.")
    value = value.strip()
    if value.startswith('"') and value.endswith('"') and len(value) >= 2:
        value = value[1:-1].strip()
    elif '"' in value:
        raise FFmpegUnavailable("Remove unmatched quotes from the FFmpeg path.")
    if not value:
        raise FFmpegUnavailable("Enter the full path to ffmpeg.exe.")
    path = Path(value)
    if require_absolute and not path.is_absolute():
        raise FFmpegUnavailable("Enter a full absolute path to ffmpeg.exe.")
    if not path.is_file():
        raise FFmpegUnavailable(f"FFmpeg was not found at {value}.")
    return str(path)


def _ffmpeg_file_identity(executable: str) -> tuple[str, tuple[int, int, int, int, int]]:
    try:
        stat = Path(executable).stat()
    except OSError as exc:
        raise FFmpegUnavailable(f"FFmpeg could not be inspected: {exc}") from exc
    return (os.path.normcase(os.path.abspath(executable)),
            (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))


def validate_ffmpeg_executable(value: str, *, require_absolute: bool = False) -> str:
    executable = _normalize_ffmpeg_path(value, require_absolute=require_absolute)
    normalized_path, identity = _ffmpeg_file_identity(executable)
    key = (normalized_path, identity)
    with _FFMPEG_VALIDATION_LOCK:
        if _FFMPEG_VALIDATION_CACHE.get(normalized_path) == identity:
            return executable
        future = _FFMPEG_VALIDATION_IN_FLIGHT.get(key)
        if future is None:
            future = Future()
            _FFMPEG_VALIDATION_IN_FLIGHT[key] = future
            owner = True
        else:
            owner = False

    if not owner:
        try:
            future.result(timeout=FFMPEG_VERSION_TIMEOUT_SECONDS + 10)
        except CancelledError as exc:
            raise FFmpegUnavailable("FFmpeg validation was interrupted. Retry with the selected executable.") from exc
        except FutureTimeoutError as exc:
            raise FFmpegProbeTimedOut(
                f"FFmpeg validation did not finish within {FFMPEG_VERSION_TIMEOUT_SECONDS + 10} seconds.") from exc
        return executable

    try:
        try:
            result = subprocess.run(
                [executable, "-version"], capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=FFMPEG_VERSION_TIMEOUT_SECONDS, check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except subprocess.TimeoutExpired as exc:
            raise FFmpegProbeTimedOut(
                f"FFmpeg did not respond to -version within {FFMPEG_VERSION_TIMEOUT_SECONDS} seconds.") from exc
        except OSError as exc:
            raise FFmpegUnavailable(f"FFmpeg could not start: {exc}") from exc
        version = (result.stdout or "") + "\n" + (result.stderr or "")
        if result.returncode != 0 or not re.search(r"(?im)^ffmpeg version\s+\S+", version):
            raise FFmpegUnavailable("The selected file is not a working FFmpeg executable.")
        current_path, current_identity = _ffmpeg_file_identity(executable)
        if current_path != normalized_path or current_identity != identity:
            raise FFmpegUnavailable("The selected FFmpeg executable changed during validation. Retry with that file.")
        with _FFMPEG_VALIDATION_LOCK:
            _FFMPEG_VALIDATION_CACHE[normalized_path] = identity
        future.set_result(None)
        return executable
    except FFmpegUnavailable as exc:
        if not future.done():
            future.set_exception(exc)
        raise
    finally:
        with _FFMPEG_VALIDATION_LOCK:
            if _FFMPEG_VALIDATION_IN_FLIGHT.get(key) is future:
                del _FFMPEG_VALIDATION_IN_FLIGHT[key]
            if not future.done():
                future.cancel()


def _winget_ffmpeg_path() -> str | None:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        return None
    package = Path(local_app_data) / "Microsoft" / "WinGet" / "Packages" / (
        "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe")
    candidates = sorted(package.glob("ffmpeg-*-full_build/bin/ffmpeg.exe"))
    return str(candidates[-1]) if candidates else None


def _resolve_ffmpeg_path(configured: str | None) -> str:
    if configured is not None:
        return validate_ffmpeg_executable(configured, require_absolute=True)
    override = os.environ.get("MIZAN_FFMPEG")
    if override:
        return validate_ffmpeg_executable(override)
    executable = shutil.which("ffmpeg")
    if executable:
        return validate_ffmpeg_executable(executable)
    winget = _winget_ffmpeg_path()
    if winget:
        return validate_ffmpeg_executable(winget)
    raise FFmpegUnavailable(
        "FFmpeg was not found. Download it from "
        f"{FFMPEG_DOWNLOAD_URL} and choose bin\\ffmpeg.exe in Song analysis settings.")


def ffmpeg_path() -> str:
    return _resolve_ffmpeg_path(_saved_ffmpeg_path())


def ffmpeg_status() -> dict[str, str | bool | None]:
    configured = None
    try:
        configured = _saved_ffmpeg_path()
        effective = _resolve_ffmpeg_path(configured)
        return {"configuredPath": configured, "effectivePath": effective,
                "available": True, "issue": None}
    except FFmpegUnavailable as exc:
        return {"configuredPath": configured, "effectivePath": None,
                "available": False, "issue": str(exc)}


def run_command(command: list[str], directory: Path, cancelled: Event, error_type, progress=None) -> str:
    with (directory / "command.out").open("w+", encoding="utf-8") as output, \
            (directory / "command.err").open("w+", encoding="utf-8") as errors:
        try:
            process = subprocess.Popen(command, stdout=output, stderr=errors,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except OSError as exc:
            raise error_type(f"Cannot start {Path(command[0]).name}: {exc}") from exc
        try:
            while process.poll() is None:
                check_cancel(cancelled)
                if progress:
                    # Output is file-backed, so neither pipe can deadlock on a long download.
                    with (directory / "command.out").open(encoding="utf-8", errors="replace") as updates:
                        for line in updates:
                            if line.startswith("progress:"):
                                value = line.partition(":")[2].strip().strip("%")
                                try:
                                    fraction = float(value) / 100
                                except ValueError:
                                    continue  # yt-dlp emits "N/A" before the size is known.
                                progress(min(0.99, max(0, fraction)))
                time.sleep(0.1)
            check_cancel(cancelled)
            output.seek(0)
            text = output.read()
            if process.returncode:
                errors.seek(0)
                message = errors.read()[-3000:].strip()
                if error_type is DownloadFailed and any(word in message.lower() for word in
                        ("private video", "video unavailable", "removed", "sign in", "not available", "copyright")):
                    raise VideoUnavailable(message)
                raise error_type(message or f"Media command exited with code {process.returncode}.")
            return text
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


def inspect_video(url: str, directory: Path, cancelled: Event) -> dict:
    text = run_command([sys.executable, "-m", "yt_dlp", "--ignore-config", "--no-playlist",
                        "--skip-download", "--dump-single-json", "--no-warnings", url],
                       directory, cancelled, DownloadFailed)
    try:
        info = json.loads(text)
    except json.JSONDecodeError as exc:
        raise DownloadFailed("YouTube inspection returned invalid metadata.") from exc
    if not isinstance(info, dict) or not isinstance(info.get("id"), str):
        raise DownloadFailed("YouTube inspection did not return video metadata.")
    if info.get("is_live"):
        raise UnsupportedMedia("Live streams must finish before transcription.")
    duration = info.get("duration")
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
        raise UnsupportedMedia("YouTube did not report a usable audio duration.")
    return {"title": str(info.get("title") or info["id"]), "duration": duration,
            "videoId": info["id"], "thumbnail": info.get("thumbnail"), "source": url}


def preflight(metadata: dict, directory: Path) -> list[str]:
    duration = metadata["duration"]
    estimate = int(duration * 22050 * 2 * 4 * 8 + 256 * 1024 ** 2)
    if shutil.disk_usage(directory).free < estimate:
        raise InsufficientDisk(f"Approximately {estimate / 1024 ** 3:.1f} GiB of free space is needed.")
    warnings = []
    if duration > 20 * 60:
        warnings.append(f"Long recording ({duration / 60:.0f} minutes): processing may use substantial memory and disk; cancellation is available.")
    metadata["estimatedDiskBytes"] = estimate
    return warnings


def download_video(url: str, directory: Path, cancelled: Event, progress=None) -> Path:
    command = [sys.executable, "-m", "yt_dlp", "--ignore-config", "--no-playlist",
               "--ffmpeg-location", ffmpeg_path(),
               "-f", "bestaudio/best", "--newline", "--progress",
               "--progress-template", "download:progress:%(progress._percent_str)s",
               "--print", "after_move:filepath", "--no-simulate",
               "-o", str(directory / "source.%(ext)s"), url]
    try:
        text = run_command(command, directory, cancelled, DownloadFailed, progress)
    except DownloadFailed as exc:
        if "HTTP Error 403" not in str(exc):
            raise
        logger.warning("Direct YouTube audio returned HTTP 403; retrying its HLS audio stream.")
        command[command.index("-f") + 1] = "bestaudio[protocol^=m3u8]/best[protocol^=m3u8]"
        text = run_command(command, directory, cancelled, DownloadFailed, progress)
    files = [directory / Path(line.strip()).name for line in text.splitlines() if line.strip() and not line.startswith("progress:")]
    source = next((path for path in reversed(files) if path.is_file() and path.name.startswith("source.")), None)
    if source is None:
        raise DownloadFailed("YouTube download completed without an audio file.")
    return source


def decode(source: Path, output: Path, cancelled: Event) -> None:
    run_command([ffmpeg_path(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                 "-i", str(source), "-vn", "-ac", "2", "-ar", "22050",
                 "-c:a", "pcm_s16le", "-rf64", "auto", str(output)], output.parent, cancelled, UnsupportedMedia)
