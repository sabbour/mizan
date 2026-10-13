import subprocess
from pathlib import Path
from threading import Event

import pytest

from mizan.api import Api
from mizan.engine import media
from mizan.errors import FFmpegUnavailable
from mizan.jobs import JobRunner, JobStore


ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("MIZAN_HOME", str(tmp_path / "profile"))
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.delenv("MIZAN_FFMPEG", raising=False)
    runner = JobRunner(JobStore(), pipeline=lambda *_args: None)
    try:
        yield Api(runner)
    finally:
        runner.close()


def fake_version(*_args, **_kwargs):
    return subprocess.CompletedProcess(
        ["ffmpeg", "-version"], 0, stdout="ffmpeg version test-build\n", stderr="")


def test_saved_path_is_validated_persisted_and_cleared(api, tmp_path, monkeypatch):
    executable = tmp_path / "FFmpeg Folder" / "ffmpeg.exe"
    executable.parent.mkdir()
    executable.touch()
    calls = []

    def version(*args, **kwargs):
        calls.append((args, kwargs))
        return fake_version(*args, **kwargs)

    monkeypatch.setattr(media.subprocess, "run", version)
    result = api.set_ffmpeg_path(f'"{executable}"')
    assert result["ok"] is True
    assert result["configuredPath"] == str(executable)
    assert result["effectivePath"] == str(executable)
    assert calls[0][0][0] == [str(executable), "-version"]
    assert calls[0][1]["timeout"] == 5
    assert "shell" not in calls[0][1]
    assert JobStore().get_ffmpeg_path() == str(executable)

    restarted = JobStore()
    assert restarted.get_ffmpeg_path() == str(executable)
    automatic = api.set_ffmpeg_path("")
    assert automatic["ok"] is True
    assert automatic["configuredPath"] is None
    assert restarted.get_ffmpeg_path() is None


@pytest.mark.parametrize("value", [None, 42, "", "  ", "relative\\ffmpeg.exe"])
def test_rejects_invalid_path_values(value):
    with pytest.raises(FFmpegUnavailable):
        media._normalize_ffmpeg_path(value, require_absolute=True)


def test_rejects_directory_and_non_ffmpeg_file(tmp_path, monkeypatch):
    missing = tmp_path / "missing.exe"
    with pytest.raises(FFmpegUnavailable, match="not found"):
        media.validate_ffmpeg_executable(str(missing), require_absolute=True)

    directory = tmp_path / "ffmpeg.exe"
    directory.mkdir()
    with pytest.raises(FFmpegUnavailable, match="not found"):
        media.validate_ffmpeg_executable(str(directory), require_absolute=True)

    executable = tmp_path / "not-ffmpeg.exe"
    executable.touch()
    monkeypatch.setattr(
        media.subprocess, "run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess(
            ["not-ffmpeg.exe", "-version"], 0, stdout="other tool 1.0\n", stderr=""))
    with pytest.raises(FFmpegUnavailable, match="not a working FFmpeg"):
        media.validate_ffmpeg_executable(str(executable), require_absolute=True)

    monkeypatch.setattr(
        media.subprocess, "run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess(
            ["not-ffmpeg.exe", "-version"], 1,
            stdout="ffmpeg version test-build\n", stderr="failed"))
    with pytest.raises(FFmpegUnavailable, match="not a working FFmpeg"):
        media.validate_ffmpeg_executable(str(executable), require_absolute=True)


def test_ffmpeg_validation_has_a_bounded_timeout(tmp_path, monkeypatch):
    executable = tmp_path / "ffmpeg.exe"
    executable.touch()

    def timeout(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(["ffmpeg", "-version"], 5)

    monkeypatch.setattr(media.subprocess, "run", timeout)
    with pytest.raises(FFmpegUnavailable, match="within 5 seconds"):
        media.validate_ffmpeg_executable(str(executable), require_absolute=True)


def test_invalid_saved_path_does_not_fall_back(tmp_path, monkeypatch):
    configured = str(tmp_path / "invalid.exe")
    path_lookup = []
    monkeypatch.setattr(media, "_saved_ffmpeg_path", lambda: configured)
    monkeypatch.setenv("MIZAN_FFMPEG", str(tmp_path / "env.exe"))
    monkeypatch.setattr(media.shutil, "which", lambda _name: path_lookup.append("PATH"))
    monkeypatch.setattr(media, "_winget_ffmpeg_path", lambda: path_lookup.append("WinGet"))

    def invalid(*_args, **_kwargs):
        raise FFmpegUnavailable("Saved path is invalid.")

    monkeypatch.setattr(media, "validate_ffmpeg_executable", invalid)
    with pytest.raises(FFmpegUnavailable, match="Saved path is invalid"):
        media.ffmpeg_path()
    assert path_lookup == []


def test_resolution_order_and_linux_path_need_no_localappdata(tmp_path, monkeypatch):
    monkeypatch.setenv("MIZAN_HOME", str(tmp_path / "profile"))
    store = JobStore()
    saved = str(tmp_path / "saved.exe")
    environment = str(tmp_path / "environment.exe")
    path_found = str(tmp_path / "path" / "ffmpeg.exe")
    winget = str(tmp_path / "winget.exe")
    store.set_ffmpeg_path(saved)
    selected = []
    monkeypatch.setattr(media, "validate_ffmpeg_executable",
                        lambda value, **_kwargs: selected.append(value) or value)
    monkeypatch.setenv("MIZAN_FFMPEG", environment)
    monkeypatch.setattr(media.shutil, "which", lambda _name: path_found)
    monkeypatch.setattr(media, "_winget_ffmpeg_path", lambda: winget)
    assert media.ffmpeg_path() == saved
    store.set_ffmpeg_path(None)
    assert media.ffmpeg_path() == environment
    monkeypatch.delenv("MIZAN_FFMPEG")
    assert media.ffmpeg_path() == path_found
    monkeypatch.setattr(media.shutil, "which", lambda _name: None)
    assert media.ffmpeg_path() == winget
    assert selected == [saved, environment, path_found, winget]

    monkeypatch.delenv("MIZAN_HOME")
    monkeypatch.delenv("LOCALAPPDATA")
    monkeypatch.setattr(media.shutil, "which", lambda _name: "/usr/bin/ffmpeg")
    monkeypatch.setattr(media, "_winget_ffmpeg_path",
                        lambda: pytest.fail("WinGet discovery should not be needed"))
    assert media.ffmpeg_path() == "/usr/bin/ffmpeg"


def test_winget_full_build_discovery(tmp_path, monkeypatch):
    executable = (tmp_path / "Microsoft" / "WinGet" / "Packages" /
                  "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe" /
                  "ffmpeg-9-full_build" / "bin" / "ffmpeg.exe")
    executable.parent.mkdir(parents=True)
    executable.touch()
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.delenv("MIZAN_FFMPEG", raising=False)
    monkeypatch.setattr(media.shutil, "which", lambda _name: None)
    monkeypatch.setattr(media, "validate_ffmpeg_executable", lambda value, **_kwargs: value)
    assert media._resolve_ffmpeg_path(None) == str(executable)


def test_missing_ffmpeg_is_setup_status_not_api_error(api, monkeypatch):
    monkeypatch.setattr(media.shutil, "which", lambda _name: None)
    monkeypatch.setattr(media, "_winget_ffmpeg_path", lambda: None)
    result = api.ffmpeg_status()
    assert result["ok"] is True
    assert result["available"] is False
    assert result["configuredPath"] is None
    assert result["effectivePath"] is None
    assert "FFmpeg was not found" in result["issue"]


def test_api_rejects_non_string_path_with_actionable_error(api):
    result = api.set_ffmpeg_path(None)
    assert result["ok"] is False
    assert result["error"]["code"] == "ffmpeg_unavailable"
    assert "Song analysis settings" in result["error"]["fix"]


def test_downloader_and_decoder_use_selected_executable(tmp_path, monkeypatch):
    executable = str(tmp_path / "FFmpeg Folder" / "ffmpeg.exe")
    monkeypatch.setattr(media, "ffmpeg_path", lambda: executable)
    source = tmp_path / "source.m4a"
    source.touch()
    commands = []
    monkeypatch.setattr(media, "run_command", lambda command, *_args, **_kwargs:
                        commands.append(command) or str(source))

    assert media.download_video("https://youtu.be/aB_12-cD345", tmp_path, Event()) == source
    download = commands.pop()
    assert download[download.index("--ffmpeg-location") + 1] == executable

    media.decode(source, tmp_path / "decoded.wav", Event())
    assert commands[0][0] == executable


def test_desktop_packaging_and_credits_do_not_require_ffmpeg():
    build = (ROOT / "scripts" / "Build-Msix.ps1").read_text(encoding="utf-8")
    workflow = (ROOT / ".github" / "workflows" / "msix.yml").read_text(encoding="utf-8")
    shell = (ROOT / "shell" / "Mizan.Shell" / "WorkerProcess.cs").read_text(encoding="utf-8")
    credits = (ROOT / "scripts" / "credits.py").read_text(encoding="utf-8")
    assert "Tools\\ffmpeg.exe" not in build
    assert "ffmpeg-full" not in workflow
    assert "Tools\", \"ffmpeg.exe" not in shell
    assert "ffmpeg_path" not in credits
    assert "ffmpeg_credit" not in credits
