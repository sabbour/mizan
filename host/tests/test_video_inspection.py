import json
import os
from pathlib import Path
import subprocess
import sys
import time
from threading import Event, Timer

import pytest

from mizan.api import Api
from mizan.engine import media
from mizan.errors import Cancelled, DownloadFailed
from mizan.jobs import JobRunner, JobStore
from test_jobs import URL, wait_for


def stalled_extractor(monkeypatch, tmp_path):
    child = tmp_path / "extractor.pid"
    popen = subprocess.Popen
    processes = []

    def launch(_command, **kwargs):
        if _command[0].lower().endswith("taskkill.exe"):
            return popen(_command, **kwargs)
        process = popen([
            sys.executable, "-c",
            "import os, pathlib, time; "
            f"pathlib.Path({str(child)!r}).write_text(str(os.getpid())); "
            "time.sleep(60)",
        ], **kwargs)
        processes.append(process)
        return process

    monkeypatch.setattr(media.subprocess, "Popen", launch)
    monkeypatch.setattr(media, "VIDEO_INSPECTION_TIMEOUT_SECONDS", 0.5, raising=False)
    return processes


def test_stalled_inspection_fails_job_and_queue_remains_usable(monkeypatch, tmp_path, caplog):
    processes = stalled_extractor(monkeypatch, tmp_path)

    def inspect(job, report, cancelled):
        report("inspect", 0.8, message="Reading video details")
        return media.inspect_video(job["url"], tmp_path, cancelled)

    runner = JobRunner(JobStore(), inspect)
    try:
        started = time.monotonic()
        job = runner.start(URL, "piano")
        failed = wait_for(runner.store, job["id"], "failed")
        assert time.monotonic() - started < 5
        assert failed["error_code"] == "youtube_inspection_timeout"
        assert "timed out" in failed["error_message"]
        public = Api(runner).list_queue()["jobs"][0]
        assert public["errorCode"] == "youtube_inspection_timeout"
        assert "retry" in public["fix"].lower()
        assert processes[0].poll() is not None
        assert "YouTube video details timed out" in caplog.text
        runner.pipeline = lambda *_: None
        next_job = runner.start("https://www.youtube.com/watch?v=bB_12-cD345", "piano")
        wait_for(runner.store, next_job["id"], "done")
    finally:
        runner.close()
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait()


def test_inspection_cancellation_stops_subprocess_without_timeout(monkeypatch, tmp_path):
    processes = stalled_extractor(monkeypatch, tmp_path)
    monkeypatch.setattr(media, "VIDEO_INSPECTION_TIMEOUT_SECONDS", 10)
    cancelled = Event()
    timer = Timer(0.3, cancelled.set)
    timer.start()
    try:
        with pytest.raises(Cancelled):
            media.inspect_video(URL, tmp_path, cancelled)
        assert len(processes) == 1
        assert processes[0].poll() is not None
    finally:
        timer.cancel()
        timer.join()
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait()


def test_cancelled_inspection_does_not_launch_extractor(monkeypatch, tmp_path):
    monkeypatch.setattr(media.subprocess, "Popen",
                        lambda *_args, **_kwargs: pytest.fail("launched after cancellation"))
    cancelled = Event()
    cancelled.set()
    with pytest.raises(Cancelled):
        media.inspect_video(URL, tmp_path, cancelled)


def test_inspection_passes_bounded_network_options_and_preserves_metadata(monkeypatch, tmp_path):
    def run(command, directory, cancelled, error_type, **kwargs):
        assert directory == tmp_path
        assert error_type is DownloadFailed
        assert kwargs["timeout"] == media.VIDEO_INSPECTION_TIMEOUT_SECONDS
        assert command[command.index("--socket-timeout") + 1] == "15"
        assert command[command.index("--retries") + 1] == "1"
        assert command[command.index("--extractor-retries") + 1] == "1"
        assert "--no-playlist" in command and "--skip-download" in command
        return json.dumps({"id": "aB_12-cD345", "duration": 12, "title": "Synthetic study"})

    monkeypatch.setattr(media, "run_command", run)
    assert media.inspect_video(URL, tmp_path, Event()) == {
        "videoId": "aB_12-cD345", "duration": 12, "title": "Synthetic study",
        "thumbnail": None, "source": URL,
    }


def test_inspection_timeout_preserves_saved_sign_in_and_removes_cookie_copy(monkeypatch, tmp_path):
    from mizan.youtube_auth import youtube_cookies_path
    from test_youtube_auth import COOKIE_TEXT

    cookies = youtube_cookies_path()
    cookies.write_text(COOKIE_TEXT, encoding="utf-8")
    copies = []
    popen = subprocess.Popen

    def launch(command, **kwargs):
        if command[0].lower().endswith("taskkill.exe"):
            return popen(command, **kwargs)
        copies.append(command[command.index("--cookies") + 1])
        return popen([sys.executable, "-c", "import time; time.sleep(60)"], **kwargs)

    monkeypatch.setattr(media.subprocess, "Popen", launch)
    monkeypatch.setattr(media, "VIDEO_INSPECTION_TIMEOUT_SECONDS", 0.3)
    with pytest.raises(DownloadFailed, match="timed out"):
        media.inspect_video(URL, tmp_path, Event())
    assert cookies.read_text(encoding="utf-8") == COOKIE_TEXT
    assert copies and all(not Path(path).exists() for path in copies)


@pytest.mark.skipif(os.name != "nt", reason="Windows desktop process-tree cleanup")
def test_inspection_timeout_stops_challenge_solver_child(monkeypatch, tmp_path):
    import ctypes

    pid_file = tmp_path / "solver.pid"
    popen = subprocess.Popen
    processes = []

    def launch(_command, **kwargs):
        if _command[0].lower().endswith("taskkill.exe"):
            return popen(_command, **kwargs)
        process = popen([
            sys.executable, "-c",
            "import subprocess, sys, pathlib; "
            "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
            f"pathlib.Path({str(pid_file)!r}).write_text(str(child.pid)); child.wait()",
        ], **kwargs)
        processes.append(process)
        deadline = time.monotonic() + 5
        while not pid_file.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert pid_file.exists()
        return process

    monkeypatch.setattr(media.subprocess, "Popen", launch)
    monkeypatch.setattr(media, "VIDEO_INSPECTION_TIMEOUT_SECONDS", 0.5)
    try:
        with pytest.raises(DownloadFailed, match="timed out"):
            media.inspect_video(URL, tmp_path, Event())
        assert processes[0].poll() is not None
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x100000, False, int(pid_file.read_text()))
        if handle:
            try:
                assert kernel.WaitForSingleObject(handle, 5000) == 0
            finally:
                kernel.CloseHandle(handle)
    finally:
        for process in processes:
            if process.poll() is None:
                subprocess.run([
                    str(Path(os.environ["SystemRoot"]) / "System32" / "taskkill.exe"),
                    "/PID", str(process.pid), "/T", "/F",
                ], capture_output=True, timeout=5, check=False)
                process.wait(timeout=5)
