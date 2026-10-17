from threading import Event
from pathlib import Path

import pytest

from mizan.api import Api, queue_job
from mizan.engine import media
from mizan.errors import (DownloadFailed, InvalidYoutubeCookies, VideoUnavailable,
                          YoutubeExtractionFailed, YoutubeSignInRequired)
from mizan.jobs import JobRunner, JobStore
from mizan.youtube_auth import (
    import_youtube_cookies,
    youtube_cookies_for_operation,
    youtube_auth_status,
    youtube_cookies_path,
    youtube_sign_out,
)

COOKIE_TEXT = (
    "# Netscape HTTP Cookie File\n"
    ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tSAPISID\tsecret-cookie-value\n"
    "#HttpOnly_.google.com\tTRUE\t/\tTRUE\t1893456000\tSID\tgoogle-cookie-value\n"
)


@pytest.fixture
def cookie_home(monkeypatch, tmp_path):
    home = tmp_path / "mizan"
    monkeypatch.setenv("MIZAN_HOME", str(home))
    return home


def test_import_youtube_cookies_validates_and_tracks_source(cookie_home, tmp_path):
    source = tmp_path / "cookies.txt"
    source.write_text(COOKIE_TEXT, encoding="utf-8")

    assert import_youtube_cookies(str(source)) == {"signedIn": True, "source": "file"}
    assert youtube_cookies_path().read_text(encoding="utf-8") == COOKIE_TEXT
    assert youtube_auth_status() == {"signedIn": True, "source": "file"}

    assert youtube_sign_out() == {"signedIn": False, "source": None}
    assert not youtube_cookies_path().exists()


@pytest.mark.parametrize("contents", [
    "not a cookie file\n",
    "# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t1893456000\tSID\tvalue\n",
    "# Netscape HTTP Cookie File\n.youtube.com\tmaybe\t/\tTRUE\t1893456000\tSID\tvalue\n",
    "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1893456000\tVISITOR_INFO1_LIVE\tvalue\n",
    "# Netscape HTTP Cookie File\n.youtube.com\tFALSE\t/\tTRUE\t1893456000\tSAPISID\tsynthetic-cookie-value\n",
    "# Netscape HTTP Cookie File\n"
    ".youtube.com\tTRUE\t/\tTRUE\t-1\tSID\tsynthetic-cookie-value\n"
    ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tSAPISID\tsynthetic-auth-value\n",
])
def test_import_youtube_cookies_rejects_invalid_files(cookie_home, tmp_path, contents):
    source = tmp_path / "invalid.txt"
    source.write_text(contents, encoding="utf-8")

    with pytest.raises(InvalidYoutubeCookies) as failure:
        import_youtube_cookies(str(source))
    assert "synthetic-cookie-value" not in str(failure.value)
    assert "synthetic-auth-value" not in str(failure.value)
    assert not youtube_cookies_path().exists()


def test_yt_dlp_cookie_copy_is_temporary_and_cannot_restore_sign_out(cookie_home):
    cookies = youtube_cookies_path()
    cookies.parent.mkdir(parents=True, exist_ok=True)
    cookies.write_text(COOKIE_TEXT, encoding="utf-8")
    operation_cookies = None

    with youtube_cookies_for_operation() as operation_cookies:
        assert operation_cookies is not None
        assert operation_cookies != cookies
        youtube_sign_out()
        operation_cookies.write_text(COOKIE_TEXT, encoding="utf-8")
        assert not cookies.exists()

    assert not cookies.exists()
    assert operation_cookies is not None and not operation_cookies.exists()


def test_invalid_saved_cookies_are_not_passed_to_yt_dlp(cookie_home):
    cookies = youtube_cookies_path()
    cookies.parent.mkdir(parents=True, exist_ok=True)
    cookies.write_text(
        "# Netscape HTTP Cookie File\n"
        ".youtube.com\tTRUE\t/\tTRUE\t-1\tSID\tsynthetic-cookie-value\n"
        ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tSAPISID\tsynthetic-auth-value\n",
        encoding="utf-8",
    )

    assert youtube_auth_status() == {"signedIn": False, "source": None}
    with youtube_cookies_for_operation() as operation_cookies:
        assert operation_cookies is None


def test_auth_status_does_not_treat_arbitrary_youtube_cookies_as_signed_in(cookie_home):
    youtube_cookies_path().parent.mkdir(parents=True, exist_ok=True)
    youtube_cookies_path().write_text(
        "# Netscape HTTP Cookie File\n"
        ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tVISITOR_INFO1_LIVE\tarbitrary-value\n",
        encoding="utf-8",
    )

    assert youtube_auth_status() == {"signedIn": False, "source": None}


def test_auth_status_rejects_expired_youtube_sign_in_cookie(cookie_home):
    youtube_cookies_path().parent.mkdir(parents=True, exist_ok=True)
    youtube_cookies_path().write_text(
        "# Netscape HTTP Cookie File\n"
        ".youtube.com\tTRUE\t/\tTRUE\t1\tSAPISID\ttest-value\n",
        encoding="utf-8",
    )

    assert youtube_auth_status() == {"signedIn": False, "source": None}


def test_api_exposes_youtube_auth_status_import_and_sign_out(cookie_home, tmp_path):
    runner = JobRunner(JobStore(), lambda *_: None)
    try:
        api = Api(runner)
        assert api.youtube_auth_status() == {"ok": True, "signedIn": False, "source": None}
        source = tmp_path / "cookies.txt"
        source.write_text(COOKIE_TEXT, encoding="utf-8")
        assert api.import_youtube_cookies(str(source)) == {
            "ok": True, "signedIn": True, "source": "file",
        }
        assert api.youtube_sign_out() == {"ok": True, "signedIn": False, "source": None}
    finally:
        runner.close()


def test_inspect_and_download_video_include_cookie_file_when_present(
        cookie_home, monkeypatch, tmp_path):
    cookies = youtube_cookies_path()
    cookies.write_text(COOKIE_TEXT, encoding="utf-8")
    commands = []
    operation_cookie_files = []
    source = tmp_path / "source.webm"
    source.write_bytes(b"audio")

    def run(command, *_args, **_kwargs):
        commands.append(command)
        operation_cookie_files.append(Path(command[command.index("--cookies") + 1]))
        if "--dump-single-json" in command:
            return '{"id":"aB_12-cD345","duration":12}'
        return str(source)

    monkeypatch.setattr(media, "run_command", run)
    monkeypatch.setattr(media, "ffmpeg_path", lambda: "test-ffmpeg")
    monkeypatch.setattr(media, "_youtube_js_runtime_args",
                        lambda: ["--js-runtimes", "node:test-node.exe"])
    assert media.inspect_video("https://youtube.com/watch?v=abc", tmp_path, Event())["videoId"]
    assert media.download_video("https://youtube.com/watch?v=abc", tmp_path, Event()) == source

    for command in commands:
        assert Path(command[command.index("--cookies") + 1]) != cookies
        assert command[command.index("--js-runtimes") + 1] == "node:test-node.exe"
    assert all(not path.exists() for path in operation_cookie_files)


def test_youtube_js_runtime_args_prefers_bundled_node(cookie_home, monkeypatch, tmp_path):
    python = tmp_path / "Python"
    runtime = python / "js-runtime" / "node.exe"
    runtime.parent.mkdir(parents=True)
    runtime.write_bytes(b"test")
    monkeypatch.setattr(media.sys, "executable", str(python / "python.exe"))
    monkeypatch.setattr(media.shutil, "which", lambda _name: "fallback-node.exe")

    assert media._youtube_js_runtime_args() == ["--js-runtimes", f"node:{runtime}"]


def test_youtube_js_runtime_args_uses_development_node(cookie_home, monkeypatch, tmp_path):
    python = tmp_path / "Python"
    python.mkdir()
    monkeypatch.setattr(media.sys, "executable", str(python / "python.exe"))
    monkeypatch.setattr(media.shutil, "which", lambda name: "node.exe" if name == "node" else None)

    assert media._youtube_js_runtime_args() == ["--js-runtimes", "node:node.exe"]


@pytest.mark.parametrize(("stderr_text", "error_type"), [
    ("ERROR: Sign in to confirm you're not a bot", YoutubeSignInRequired),
    ("ERROR: No supported JavaScript runtime could be found", YoutubeExtractionFailed),
    ("ERROR: Signature solving failed", YoutubeExtractionFailed),
    ("ERROR: n challenge solving failed", YoutubeExtractionFailed),
    ("ERROR: Only images are available", YoutubeExtractionFailed),
    ("ERROR: Requested format is not available", YoutubeExtractionFailed),
    ("ERROR: This video is unavailable", VideoUnavailable),
    ("ERROR: This video is not available", VideoUnavailable),
    ("ERROR: The uploader has not made this video available in your country", VideoUnavailable),
    ("ERROR: Video unavailable. This content isn't available, try again later. "
     "The current session has been rate-limited.", DownloadFailed),
])
def test_ytdlp_failures_are_classified_accurately(
        cookie_home, monkeypatch, tmp_path, caplog, stderr_text, error_type):
    import logging

    class FailedProcess:
        returncode = 1

        def poll(self):
            return self.returncode

        def kill(self):
            pass

        def wait(self):
            return self.returncode

    def failed_command(_command, stdout, stderr, **_kwargs):
        stderr.write(stderr_text)
        stderr.flush()
        return FailedProcess()

    monkeypatch.setattr(media.subprocess, "Popen", failed_command)
    caplog.set_level(logging.WARNING, logger="mizan.engine.media")
    with pytest.raises(error_type) as failure:
        media.run_command(["yt-dlp", "--cookies", "temporary.txt"],
                          tmp_path, Event(), DownloadFailed)

    assert failure.value.code == {
        YoutubeSignInRequired: "youtube_sign_in_required",
        YoutubeExtractionFailed: "youtube_extraction_failed",
        VideoUnavailable: "video_unavailable",
        DownloadFailed: "download_failed",
    }[error_type]
    assert "yt-dlp failed exit_code=1" in caplog.text
    if error_type is DownloadFailed:
        assert "rate-limiting" in str(failure.value)


def test_inspect_in_flight_cookie_writeback_cannot_restore_sign_out(
        cookie_home, monkeypatch, tmp_path):
    cookies = youtube_cookies_path()
    cookies.write_text(COOKIE_TEXT, encoding="utf-8")
    operation_cookie_files = []

    def run(command, *_args, **_kwargs):
        operation_cookies = Path(command[command.index("--cookies") + 1])
        operation_cookie_files.append(operation_cookies)
        youtube_sign_out()
        operation_cookies.write_text(COOKIE_TEXT, encoding="utf-8")
        return '{"id":"aB_12-cD345","duration":12}'

    monkeypatch.setattr(media, "run_command", run)

    assert media.inspect_video(
        "https://youtube.com/watch?v=abc", tmp_path, Event())["videoId"] == "aB_12-cD345"
    assert not cookies.exists()
    assert len(operation_cookie_files) == 1
    assert operation_cookie_files[0] != cookies
    assert not operation_cookie_files[0].exists()


def test_queue_exposes_youtube_sign_in_recovery_for_download_failures():
    job = {
        "id": "test-job", "kind": "transcribe", "song_id": None,
        "url": "https://youtube.com/watch?v=abc", "title": "Test", "thumbnail": None,
        "status": "failed", "stage": "inspect", "progress": 0,
        "error_code": "youtube_sign_in_required",
        "error_message": "YouTube requires sign-in. Sign in, then retry this analysis.",
        "order_index": 0, "instrument": "auto", "created_at": "", "updated_at": "",
        "details": {},
    }

    result = queue_job(job)

    assert result["errorCode"] == "youtube_sign_in_required"
    assert result["fix"] == "Sign in to YouTube, then retry the analysis."
    assert "cookie" not in result["errorMessage"].lower()


def test_queue_exposes_youtube_extraction_recovery():
    job = {
        "id": "test-job", "kind": "transcribe", "song_id": None,
        "url": "https://youtube.com/watch?v=abc", "title": "Test", "thumbnail": None,
        "status": "failed", "stage": "download", "progress": 0,
        "error_code": "youtube_extraction_failed",
        "error_message": YoutubeExtractionFailed.message,
        "order_index": 0, "instrument": "auto", "created_at": "", "updated_at": "",
        "details": {},
    }

    result = queue_job(job)

    assert result["errorCode"] == "youtube_extraction_failed"
    assert result["fix"] == "Update Mizan and retry. If the problem continues, try again later."


@pytest.mark.parametrize(("has_cookies", "expected"), [
    (False, "YouTube requires sign-in. Sign in, then retry this analysis."),
    (True, "YouTube rejected the saved sign-in. Sign in again, then retry this analysis."),
])
def test_bot_check_errors_offer_youtube_sign_in(
        cookie_home, monkeypatch, tmp_path, has_cookies, expected):
    cookies = youtube_cookies_path()
    if has_cookies:
        cookies.write_text(COOKIE_TEXT, encoding="utf-8")

    class FailedProcess:
        returncode = 1

        def poll(self):
            return self.returncode

        def kill(self):
            pass

        def wait(self):
            return self.returncode

    def failed_command(_command, stdout, stderr, **_kwargs):
        stderr.write("ERROR: Sign in to confirm you're not a bot")
        stderr.flush()
        return FailedProcess()

    monkeypatch.setattr(media.subprocess, "Popen", failed_command)
    with pytest.raises(YoutubeSignInRequired, match=expected) as failure:
        media.run_command(["yt-dlp"], tmp_path, Event(), DownloadFailed)
    assert failure.value.code == "youtube_sign_in_required"


@pytest.mark.parametrize("escaped", [False, True])
def test_cookie_loader_errors_do_not_expose_cookie_values(monkeypatch, tmp_path, caplog, escaped):
    class FailedProcess:
        returncode = 1

        def poll(self):
            return self.returncode

        def kill(self):
            pass

        def wait(self):
            return self.returncode

    def failed_command(_command, **kwargs):
        stderr = kwargs["stderr"]
        cookie_record = ".youtube.com\ttrue\t/\tTRUE\t-1\tSID\tsynthetic-cookie-value"
        diagnostic_record = repr(cookie_record) if escaped else cookie_record
        stderr.write(f"WARNING: skipping cookie file entry due to invalid expires at -1: {diagnostic_record}\n")
        stderr.flush()
        return FailedProcess()

    monkeypatch.setattr(media.subprocess, "Popen", failed_command)

    with pytest.raises(DownloadFailed) as failure:
        media.run_command(
            ["yt-dlp", "--cookies", str(tmp_path / "cookies.txt")],
            tmp_path, Event(), DownloadFailed)
    assert "synthetic-cookie-value" not in str(failure.value)
    assert "saved sign-in" in str(failure.value)
    assert "synthetic-cookie-value" not in caplog.text
    assert "[redacted]" in caplog.text
