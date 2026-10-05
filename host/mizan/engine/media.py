import json
import logging
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
from threading import Event
import time
import warnings

from scipy.io.wavfile import WavFileWarning

from ..errors import DownloadFailed, InsufficientDisk, UnsupportedMedia, VideoUnavailable
from .audio import read_audio
from .providers import check_cancel

logger = logging.getLogger(__name__)


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


def ffmpeg_path() -> str:
    override = os.environ.get("MIZAN_FFMPEG")
    if override:
        if not Path(override).is_file():
            raise UnsupportedMedia("MIZAN_FFMPEG does not point to an executable file.")
        return override
    executable = shutil.which("ffmpeg")
    if executable:
        return executable
    package = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages" / "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
    candidates = sorted(package.glob(r"ffmpeg-*-full_build\bin\ffmpeg.exe"))
    if candidates:
        return str(candidates[-1])
    raise UnsupportedMedia("FFmpeg was not found. Install FFmpeg or set MIZAN_FFMPEG to ffmpeg.exe.")


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
