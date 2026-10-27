import hashlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from threading import Event, get_ident
from types import ModuleType, SimpleNamespace
from uuid import uuid4
from urllib.request import Request
from urllib.error import HTTPError
from urllib.error import URLError

import numpy as np
import mido
import pytest

from mizan.api import Api, public_job, queue_job
from mizan.engine import pipeline
from mizan.engine.audio import Audio, write_audio
from mizan.engine.muscriptor import (MODELS, _cpu_inference_timeout_message, require_ready,
                                     _transcribe_inprocess, transcribe_official)
from mizan.errors import Cancelled, DownloadFailed, InvalidTranscriptionModel, ModelFailed
from mizan.jobs import JobRunner, JobStore
from mizan.library import LibraryStore
from mizan.paths import app_dir, home
from test_engine_pipeline import fixture_audio
from test_jobs import URL, wait_for


def test_isolated_library_can_use_existing_models_directory(monkeypatch, tmp_path):
    models = tmp_path / "existing-models"
    monkeypatch.setenv("MIZAN_MODELS_DIR", str(models))
    assert app_dir("models") == models
    assert app_dir("models").is_dir()
    assert app_dir("cache") == home() / "cache"
    monkeypatch.delenv("MIZAN_MODELS_DIR")
    assert app_dir("models") == home() / "models"


def test_selection_persists_and_jobs_snapshot_without_cross_model_reuse():
    entered, release = Event(), Event()
    seen = []

    def process(job, report, cancelled):
        seen.append((job["id"], job["transcription_model"]))
        if len(seen) == 1:
            entered.set()
            assert release.wait(5)

    store = JobStore()
    runner = JobRunner(store, process)
    api = Api(runner)
    try:
        assert api.get_transcription_model() == {"ok": True, "model": "muscriptor-small"}
        first = runner.start(URL, "piano")
        assert entered.wait(5)
        assert api.set_transcription_model("muscriptor-large") == {
            "ok": True, "model": "muscriptor-large"}
        assert JobStore().get_transcription_model() == "muscriptor-large"
        second = runner.start(URL, "piano")
        assert second["id"] != first["id"]
        assert second["status"] == "queued"
        assert store.get(first["id"])["transcription_model"] == "muscriptor-small"
        assert store.get(second["id"])["transcription_model"] == "muscriptor-large"
        assert public_job(store.get(first["id"]))["transcriptionModel"] == "muscriptor-small"
        assert queue_job(store.get(second["id"]))["transcriptionModel"] == "muscriptor-large"
        release.set()
        wait_for(store, second["id"], "done")
        assert seen == [(first["id"], "muscriptor-small"), (second["id"], "muscriptor-large")]
        assert runner.start(URL, "piano")["id"] == second["id"]
        assert api.set_transcription_model("muscriptor-small")["ok"]
        assert runner.start(URL, "piano")["id"] == first["id"]
    finally:
        release.set()
        runner.close()


def test_active_reprocess_only_deduplicates_for_same_saved_song():
    store = JobStore()
    args = ("aB_12-cD345", URL, "auto", "v1")
    first = store.create(*args, song_id="song-one", reuse=False)
    assert store.create(*args, song_id="song-one", reuse=False)["id"] == first["id"]
    second = store.create(*args, song_id="song-two", reuse=False)
    intake = store.create(*args, reuse=False)
    assert len({first["id"], second["id"], intake["id"]}) == 3


def test_invalid_selection_does_not_change_setting():
    runner = JobRunner(JobStore(), lambda *_: None)
    try:
        api = Api(runner)
        for value in ("standard", "large", "muscriptor-medium-onnx", "", None, 1):
            result = api.set_transcription_model(value)
            assert result["ok"] is False
            assert result["error"]["code"] == "invalid_transcription_model"
        assert api.get_transcription_model() == {"ok": True, "model": "muscriptor-small"}
    finally:
        runner.close()


def test_model_preflight_blocks_selection_and_job_before_processing(monkeypatch):
    import mizan.engine.muscriptor as official

    gib = 1024 ** 3
    memory = official._MemoryStatus()
    memory.ullTotalPhys = 32 * gib
    memory.ullAvailPhys = 10 * gib
    memory.ullAvailPageFile = 30 * gib
    downloaded = {"value": True}
    disk = {"free": 30 * gib}
    monkeypatch.setattr(official, "_memory_status", lambda: memory)
    monkeypatch.setattr(official, "model_download_status", lambda: {
        model: {"downloaded": downloaded["value"], "bytesReceived": spec["bytes"] if downloaded["value"] else 0}
        for model, spec in MODELS.items()
    })
    monkeypatch.setattr(official.shutil, "disk_usage", lambda _: SimpleNamespace(free=disk["free"]))
    runner = JobRunner(JobStore(), lambda *_: None)
    try:
        api = Api(runner)
        report = api.model_preflight()["models"]
        assert report["muscriptor-medium"]["eligible"]
        assert report["muscriptor-large"]["requiredRamGiB"] == 20
        assert "20 GiB free RAM" in report["muscriptor-large"]["reason"]
        assert api.set_transcription_model("muscriptor-large")["error"]["code"] == "model_unavailable"
        assert api.get_transcription_model()["model"] == "muscriptor-small"

        memory.ullAvailPhys = 24 * gib
        memory.ullAvailPageFile = 12 * gib
        assert "16 GiB available Windows commit" in api.model_preflight()["models"]["muscriptor-large"]["reason"]
        memory.ullAvailPageFile = 30 * gib
        assert api.set_transcription_model("muscriptor-large")["model"] == "muscriptor-large"

        memory.ullAvailPhys = 10 * gib
        blocked = api.start_job(URL, "piano")
        assert blocked["error"]["code"] == "model_unavailable"
        assert runner.store.list() == []

        memory.ullAvailPhys = 24 * gib
        downloaded["value"] = False
        disk["free"] = 1 * gib
        assert "free disk space" in api.model_preflight()["models"]["muscriptor-large"]["reason"]
        assert api.start_model_download("muscriptor-large")["error"]["code"] == "model_unavailable"
    finally:
        runner.close()


def test_existing_database_retires_queued_standard_and_defaults_to_small():
    JobStore()
    with sqlite3.connect(home() / "mizan.db") as connection:
        connection.execute("ALTER TABLE jobs RENAME TO old_jobs")
        connection.execute("""
            CREATE TABLE jobs (
                id TEXT PRIMARY KEY, video_id TEXT, url TEXT, instrument TEXT,
                kind TEXT, song_id TEXT, title TEXT, thumbnail TEXT, stage TEXT,
                status TEXT, progress REAL, order_index INTEGER, dismissed INTEGER,
                error_code TEXT, error_message TEXT, pipeline_version TEXT,
                created_at TEXT, updated_at TEXT, details TEXT
            )
        """)
        connection.execute("""
            INSERT INTO jobs (id, video_id, url, instrument, kind, stage, status,
                progress, order_index, dismissed, pipeline_version, created_at, updated_at, details)
            VALUES (?, 'aB_12-cD345', ?, 'piano', 'transcribe', 'inspect', 'running',
                0, 0, 0, 'v1', 'today', 'today', '{}')
        """, (str(uuid4()), URL))
        connection.execute("DROP TABLE old_jobs")
    store = JobStore()
    assert store.list()[0]["status"] == "failed"
    assert store.list()[0]["transcription_model"] == "standard"
    assert store.list()[0]["error_code"] == "invalid_transcription_model"
    assert store.get_transcription_model() == "muscriptor-small"
    with sqlite3.connect(home() / "mizan.db") as connection:
        connection.execute("INSERT INTO settings (key, value) VALUES ('transcription_model', 'standard')")
    assert JobStore().get_transcription_model() == "muscriptor-small"
    store.set_transcription_model("muscriptor-large")
    assert JobStore().list()[0]["transcription_model"] == "standard"
    assert JobStore().get_transcription_model() == "muscriptor-large"


@pytest.mark.parametrize("model", ("muscriptor-small", "muscriptor-medium", "muscriptor-large"))
def test_all_official_choices_persist_and_snapshot_separately(model):
    store = JobStore()
    first_model = "muscriptor-medium" if model == "muscriptor-small" else "muscriptor-small"
    store.set_transcription_model(first_model)
    first = store.create("aB_12-cD345", URL, "piano", "v1")
    store.set_transcription_model(model)
    second = store.create("aB_12-cD345", URL, "piano", "v1")
    assert second["id"] != first["id"]
    assert second["transcription_model"] == model
    assert JobStore().get_transcription_model() == model
    assert JobStore().get(first["id"])["transcription_model"] == first_model
    store.update(second["id"], status="done")
    assert store.create("aB_12-cD345", URL, "piano", "v1")["id"] != first["id"]


def test_old_large_only_check_migrates_without_losing_job_identity():
    store = JobStore()
    job = store.create("aB_12-cD345", URL, "piano", "v1",
                       metadata={"title": "Keep this"})
    with sqlite3.connect(home() / "mizan.db") as connection:
        connection.execute("UPDATE jobs SET transcription_model = 'standard'")
        connection.execute("DROP INDEX jobs_cache")
        connection.execute("ALTER TABLE jobs RENAME TO jobs_backup")
        schema = connection.execute(
            "SELECT sql FROM sqlite_master WHERE name = 'jobs_backup'").fetchone()[0]
        schema = schema.replace("jobs_backup", "jobs").replace(
            "'standard', 'muscriptor-small', 'muscriptor-medium', 'muscriptor-large'",
            "'standard', 'muscriptor-large'")
        connection.execute(schema)
        connection.execute("INSERT INTO jobs SELECT * FROM jobs_backup")
        connection.execute("DROP TABLE jobs_backup")
    upgraded = JobStore()
    assert upgraded.get(job["id"])["title"] == "Keep this"
    assert upgraded.get(job["id"])["transcription_model"] == "standard"
    assert upgraded.get(job["id"])["status"] == "failed"
    upgraded.set_transcription_model("muscriptor-small")
    assert upgraded.create("aB_12-cD345", URL, "piano", "v1")["transcription_model"] == "muscriptor-small"


def test_large_missing_checkpoint_fails_without_running_standard_pipeline(monkeypatch):
    monkeypatch.setattr("mizan.hf_credentials.get_hf_token", lambda: None)
    monkeypatch.setattr("mizan.engine.muscriptor.importlib.util.find_spec", lambda name: object())
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace())
    monkeypatch.setitem(sys.modules, "muscriptor", SimpleNamespace(TranscriptionModel=object()))
    runner = JobRunner(JobStore())
    try:
        runner.store.set_transcription_model("muscriptor-large")
        job = runner.start(URL, "piano")
        failed = wait_for(runner.store, job["id"], "failed")
        assert failed["error_code"] == "model_failed"
        assert "checkpoint" in failed["error_message"]
        assert "Hugging Face token" in failed["error_message"]
        assert failed["transcription_model"] == "muscriptor-large"
    finally:
        runner.close()


def test_large_with_saved_token_requests_external_checkpoint(monkeypatch):
    monkeypatch.setattr("mizan.hf_credentials.get_hf_token", lambda: "redacted-test-value")
    with pytest.raises(ModelFailed) as exc:
        require_ready("muscriptor-large")
    assert "model.safetensors" in str(exc.value)
    assert "redacted-test-value" not in str(exc.value)


def test_job_download_requires_production_dependencies_before_network(monkeypatch):
    import mizan.engine.muscriptor as official

    monkeypatch.setattr(official.importlib.util, "find_spec",
                        lambda name: object() if name == "torch" else None)
    monkeypatch.setattr("mizan.hf_credentials.get_hf_token",
                        lambda: pytest.fail("Must not download before dependencies"))
    with pytest.raises(ModelFailed, match="muscriptor in Mizan's production"):
        official.prepare_model("muscriptor-large")


@pytest.mark.parametrize("model", tuple(MODELS))
def test_job_prepares_pinned_external_checkpoint_without_returning_token(monkeypatch, model):
    import mizan.engine.muscriptor as official

    secret = "hf_test_only"
    observed = []
    monkeypatch.setattr(official.importlib.util, "find_spec", lambda name: object())
    monkeypatch.setattr("mizan.hf_credentials.get_hf_token", lambda: secret)
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace())
    monkeypatch.setitem(sys.modules, "muscriptor", SimpleNamespace(TranscriptionModel=object()))
    monkeypatch.setitem(MODELS, model, {
        **MODELS[model], "bytes": len(b"mock"),
        "sha256": hashlib.sha256(b"mock").hexdigest()})

    def download(chosen, name, path, token, cancelled, progress):
        assert chosen == model
        assert token == secret
        observed.append(name)
        dim, heads, layers, card = MODELS[model]["config"]
        path.write_bytes(b"mock" if name == "model.safetensors" else
                         f'{{"dim":{dim},"num_heads":{heads},"num_layers":{layers},"card":{card}}}'.encode())
        progress(1)

    monkeypatch.setattr(official, "_download_file", download)
    progress = []
    official.prepare_model(model, Event(), progress.append)
    assert observed == ["config.json", "model.safetensors"]
    assert progress == [0.5, 1]
    assert (home() / "models" / model / "model.safetensors").read_bytes() == b"mock"
    assert official.model_download_status()[model]["downloaded"]
    assert not official.model_download_status()[model]["active"]


@pytest.mark.parametrize("outcome", ("success", "failed", "completed", "cancelled", "corrupt"))
def test_pipeline_waits_for_selected_background_model_before_video_details(monkeypatch, outcome):
    import mizan.engine.muscriptor as official

    model, payload = "muscriptor-small", b"fixture-model"
    monkeypatch.setitem(MODELS, model, {
        **MODELS[model], "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
    })
    monkeypatch.setattr(official.importlib.util, "find_spec", lambda _: object())
    monkeypatch.setattr(official, "check_model_resources", lambda _: None)
    monkeypatch.setattr("mizan.hf_credentials.get_hf_token", lambda: "hf_fixture")
    entered, release, inspected = Event(), Event(), Event()
    directory = app_dir("models") / model

    def download(chosen, _token, cancelled=None, progress=None):
        assert chosen == model
        entered.set()
        assert release.wait(5)
        if outcome == "failed":
            raise ModelFailed("Fixture checkpoint download failed.")
        directory.mkdir(exist_ok=True)
        (directory / "model.safetensors").write_bytes(
            b"x" * len(payload) if outcome == "corrupt" else payload)
        dim, heads, layers, card = MODELS[model]["config"]
        (directory / "config.json").write_text(json.dumps({
            "dim": dim, "num_heads": heads, "num_layers": layers, "card": card,
        }))

    def inspect(*_args):
        assert official.model_download_status()[model]["downloaded"]
        assert not official.model_download_status()[model]["active"]
        inspected.set()
        raise DownloadFailed("Fixture stops before any media download.")

    monkeypatch.setattr(official, "_download_assets", download)
    monkeypatch.setattr(pipeline, "ffmpeg_path", lambda: "fixture-ffmpeg")
    monkeypatch.setattr(pipeline, "inspect_video", inspect)
    monkeypatch.setattr(pipeline, "download_video",
                        lambda *_args: pytest.fail("download started without video details"))
    official.start_model_download(model)
    assert entered.wait(5)
    runner = JobRunner(JobStore())
    try:
        if outcome == "completed":
            release.set()
            deadline = time.monotonic() + 5
            while official.model_download_status()[model]["active"] and time.monotonic() < deadline:
                time.sleep(0.01)
            assert official.model_download_status()[model]["downloaded"]
        job = runner.start(URL, "piano")
        if outcome != "completed":
            running = wait_for(runner.store, job["id"], "running")
            deadline = time.monotonic() + 5
            while not running["details"].get("stageMessage") and time.monotonic() < deadline:
                time.sleep(0.01)
                running = runner.store.get(job["id"])
            assert running["stage"] == "inspect"
            assert running["details"]["stageMessage"] == "Preparing transcription model"
            assert official.model_download_status()[model]["active"]
            assert not inspected.is_set()
        if outcome == "cancelled":
            runner.cancel(job["id"])
            wait_for(runner.store, job["id"], "cancelled")
            assert official.model_download_status()[model]["active"]
            assert not inspected.is_set()
        else:
            release.set()
            failed = wait_for(runner.store, job["id"], "failed")
            model_failed = outcome in ("failed", "corrupt")
            assert inspected.is_set() == (not model_failed)
            assert failed["error_code"] == ("model_failed" if model_failed else "download_failed")
    finally:
        release.set()
        runner.close()
        assert official._download_gate.acquire(timeout=5)
        official._download_gate.release()


def test_official_download_pins_revision_checks_digest_and_cleans_partial(monkeypatch, tmp_path):
    import mizan.engine.muscriptor as official

    monkeypatch.setitem(MODELS, "muscriptor-large", {
        **MODELS["muscriptor-large"], "bytes": len(b"model"),
        "sha256": hashlib.sha256(b"model").hexdigest()})
    requests = []

    class Opener:
        def open(self, request, timeout):
            requests.append(request)
            assert timeout == 45
            return io.BytesIO(b"model")

    monkeypatch.setattr(official.urllib.request, "build_opener", lambda handler: Opener())
    destination = tmp_path / "model.safetensors"
    official._download_file("muscriptor-large", "model.safetensors", destination, "hf_test_only", Event())
    assert destination.read_bytes() == b"model"
    assert MODELS["muscriptor-large"]["revision"] in requests[0].full_url
    assert requests[0].get_header("Authorization") == "Bearer hf_test_only"
    assert not (tmp_path / "model.safetensors.partial").exists()
    monkeypatch.setitem(MODELS, "muscriptor-large", {
        **MODELS["muscriptor-large"], "sha256": "0" * 64})
    with pytest.raises(ModelFailed, match="checksum mismatch"):
        official._download_file("muscriptor-large", "model.safetensors", destination, "hf_test_only", Event())
    assert destination.read_bytes() == b"model"
    assert not (tmp_path / "model.safetensors.partial").exists()


def test_official_download_resumes_partial_and_keeps_it_on_network_error(monkeypatch, tmp_path):
    import mizan.engine.muscriptor as official

    model = "muscriptor-small"
    monkeypatch.setitem(MODELS, model, {
        **MODELS[model], "bytes": len(b"model"),
        "sha256": hashlib.sha256(b"model").hexdigest()})
    destination = tmp_path / "model.safetensors"
    partial = tmp_path / "model.safetensors.partial"
    partial.write_bytes(b"mo")
    requests = []

    class Response(io.BytesIO):
        status = 206
        headers = {"Content-Range": "bytes 2-4/5"}

    class Opener:
        def open(self, request, timeout):
            requests.append(request)
            return Response(b"del")

    monkeypatch.setattr(official.urllib.request, "build_opener", lambda handler: Opener())
    official._download_file(model, "model.safetensors", destination, "hf_fake", Event())
    assert destination.read_bytes() == b"model"
    assert requests[0].get_header("Range") == "bytes=2-"
    assert not partial.exists()
    destination.unlink()
    partial.write_bytes(b"mo")

    class Offline:
        def open(self, request, timeout):
            raise URLError("network unavailable")

    monkeypatch.setattr(official.urllib.request, "build_opener", lambda handler: Offline())
    with pytest.raises(ModelFailed, match="network/TLS"):
        official._download_file(model, "model.safetensors", destination, "hf_fake", Event())
    assert partial.read_bytes() == b"mo"


def test_job_cancellation_preserves_resumable_checkpoint(monkeypatch, tmp_path):
    import mizan.engine.muscriptor as official

    model = "muscriptor-small"
    monkeypatch.setitem(MODELS, model, {
        **MODELS[model], "bytes": 5,
        "sha256": hashlib.sha256(b"model").hexdigest()})
    destination = tmp_path / "model.safetensors"
    partial = tmp_path / "model.safetensors.partial"
    partial.write_bytes(b"mo")
    cancelled = Event()

    class Response(io.BytesIO):
        status = 206
        headers = {"Content-Range": "bytes 2-4/5"}

        def read(self, count=-1):
            chunk = super().read(count)
            cancelled.set()
            return chunk

    class Opener:
        def open(self, request, timeout):
            return Response(b"del")

    monkeypatch.setattr(official.urllib.request, "build_opener", lambda handler: Opener())
    with pytest.raises(Cancelled):
        official._download_file(model, "model.safetensors", destination, "hf_fake", cancelled)
    assert partial.read_bytes() == b"mo"
    assert not destination.exists()


def test_async_download_status_busy_progress_and_verified_completion(monkeypatch):
    import mizan.engine.muscriptor as official

    model, payload = "muscriptor-small", b"model"
    monkeypatch.setitem(MODELS, model, {
        **MODELS[model], "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest()})
    monkeypatch.setattr("mizan.hf_credentials.get_hf_token", lambda: "hf_fake")
    entered, release = Event(), Event()
    directory = home() / "models" / model
    directory.mkdir(parents=True)
    (directory / "model.safetensors.partial").write_bytes(b"mo")

    def download(chosen, token, cancelled=None, progress=None):
        assert chosen == model and token == "hf_fake"
        with official._state_lock:
            official._last_sample = time.monotonic() - 1, 0
        official._record_progress(official._key(model), 2)
        entered.set()
        assert release.wait(5)
        (directory / "model.safetensors.partial").unlink()
        (directory / "model.safetensors").write_bytes(payload)
        dim, heads, layers, card = MODELS[model]["config"]
        (directory / "config.json").write_text(
            f'{{"dim":{dim},"num_heads":{heads},"num_layers":{layers},"card":{card}}}')

    monkeypatch.setattr(official, "_download_assets", download)
    runner = JobRunner(JobStore(), lambda *_: None)
    api = Api(runner)
    try:
        before = api.model_download_status()
        assert before["ok"] and before["models"][model]["bytesReceived"] == 2
        assert before["models"][model]["totalBytes"] == len(payload)
        assert set(before["models"][model]) == {
            "downloaded", "active", "bytesReceived", "totalBytes", "bytesPerSecond", "error"}
        assert not before["models"][model]["downloaded"]
        assert api.start_model_download(model) == {"ok": True, "model": model}
        assert entered.wait(5)
        active = api.model_download_status()["models"][model]
        assert active["active"] and active["bytesReceived"] == 2
        assert active["bytesPerSecond"] > 0
        busy = api.start_model_download("muscriptor-medium")
        assert not busy["ok"] and busy["error"]["code"] == "model_download_busy"
    finally:
        release.set()
        runner.close()
    deadline = time.monotonic() + 5
    while api.model_download_status()["models"][model]["active"] and time.monotonic() < deadline:
        time.sleep(0.01)
    finished = api.model_download_status()["models"][model]
    assert finished["downloaded"] and not finished["active"] and finished["error"] is None
    assert finished["bytesReceived"] == finished["totalBytes"]
    assert (directory / ".verified.json").is_file()


def test_async_failure_retains_resumable_bytes_and_reports_error(monkeypatch):
    import mizan.engine.muscriptor as official

    model = "muscriptor-medium"
    monkeypatch.setattr("mizan.hf_credentials.get_hf_token", lambda: "hf_fake")
    directory = home() / "models" / model
    directory.mkdir(parents=True)

    def fail(*args, **kwargs):
        (directory / "model.safetensors.partial").write_bytes(b"partial")
        raise ModelFailed(f"Official {model} checkpoint access was denied.")

    monkeypatch.setattr(official, "_download_assets", fail)
    runner = JobRunner(JobStore(), lambda *_: None)
    api = Api(runner)
    try:
        assert api.start_model_download(model)["ok"]
        deadline = time.monotonic() + 5
        while api.model_download_status()["models"][model]["active"] and time.monotonic() < deadline:
            time.sleep(0.01)
        status = api.model_download_status()["models"][model]
        assert not status["active"] and not status["downloaded"]
        assert status["bytesReceived"] == 7
        assert "access was denied" in status["error"]
        assert api.start_model_download("bogus")["error"]["code"] == "invalid_transcription_model"
        assert api.start_model_download("standard")["error"]["code"] == "invalid_transcription_model"
    finally:
        runner.close()


@pytest.mark.parametrize("http_status", (401, 403))
def test_small_auth_failure_surfaces_accept_terms_in_async_status(monkeypatch, http_status):
    import mizan.engine.muscriptor as official

    monkeypatch.setattr("mizan.hf_credentials.get_hf_token", lambda: "hf_fake")

    class Denied:
        def open(self, request, timeout):
            raise HTTPError(request.full_url, http_status, "gated", {}, None)

    monkeypatch.setattr(official.urllib.request, "build_opener", lambda handler: Denied())
    runner = JobRunner(JobStore(), lambda *_: None)
    api = Api(runner)
    try:
        assert api.start_model_download("muscriptor-small")["ok"]
        deadline = time.monotonic() + 5
        while api.model_download_status()["models"]["muscriptor-small"]["active"] and time.monotonic() < deadline:
            time.sleep(0.01)
        status = api.model_download_status()["models"]["muscriptor-small"]
        assert not status["downloaded"]
        assert "accept this model's terms" in status["error"]
        assert "muscriptor-small" in status["error"]
        assert "Sign in to Hugging Face" in status["error"]
        assert "save or refresh your Hugging Face token in Library" in status["error"]
    finally:
        runner.close()


def test_official_redirect_does_not_forward_token():
    import mizan.engine.muscriptor as official

    original = Request("https://huggingface.co/model", headers={"Authorization": "Bearer secret"})
    redirected = official._OfficialRedirect().redirect_request(
        original, None, 302, "Found", {},
        "https://cas-bridge.xethub.hf.co/official-signed-blob")
    assert redirected.get_header("Authorization") is None
    with pytest.raises(ModelFailed, match="outside Hugging Face"):
        official._OfficialRedirect().redirect_request(
            original, None, 302, "Found", {}, "https://untrusted.example/model")


def test_official_request_authenticates_only_to_hf_not_signed_cdn(monkeypatch, tmp_path):
    import mizan.engine.muscriptor as official
    from urllib.parse import urlsplit

    model = "muscriptor-small"
    monkeypatch.setitem(MODELS, model, {
        **MODELS[model], "bytes": 5,
        "sha256": hashlib.sha256(b"model").hexdigest()})

    class Opener:
        def __init__(self, redirect):
            self.redirect = redirect

        def open(self, request, timeout):
            assert urlsplit(request.full_url).hostname == "huggingface.co"
            assert request.get_header("Authorization") == "Bearer hf_test_only"
            signed = self.redirect.redirect_request(
                request, None, 302, "Found", {},
                "https://us.aws.cdn.hf.co/signed-official-checkpoint")
            assert urlsplit(signed.full_url).hostname == "us.aws.cdn.hf.co"
            assert signed.get_header("Authorization") is None
            return io.BytesIO(b"model")

    monkeypatch.setattr(official.urllib.request, "build_opener", Opener)
    path = tmp_path / "model.safetensors"
    official._download_file(model, "model.safetensors", path, "hf_test_only", Event())
    assert path.read_bytes() == b"model"


@pytest.mark.parametrize("model", tuple(MODELS))
def test_official_urls_are_pinned_per_model_and_403_names_denied_variant(monkeypatch, tmp_path, model):
    import mizan.engine.muscriptor as official

    requests = []

    class Opener:
        def open(self, request, timeout):
            requests.append(request)
            raise HTTPError(request.full_url, 403, "gated", {}, None)

    monkeypatch.setattr(official.urllib.request, "build_opener", lambda handler: Opener())
    with pytest.raises(ModelFailed, match=f"{model} checkpoint access was denied"):
        official._download_file(model, "config.json", tmp_path / "config.json", "hf_fake", Event())
    assert f"/{model}/resolve/{MODELS[model]['revision']}/config.json" in requests[0].full_url
    assert not (tmp_path / "config.json.partial").exists()


def test_large_vault_error_is_not_misreported_as_unconfigured(monkeypatch):
    def unavailable():
        raise OSError("vault unavailable")

    monkeypatch.setattr("mizan.hf_credentials.get_hf_token", unavailable)
    with pytest.raises(ModelFailed, match="Credential Manager is unavailable"):
        require_ready("muscriptor-large")


def test_large_rejects_corrupt_checkpoint_before_importing_torch():
    directory = home() / "models" / "muscriptor-large"
    directory.mkdir(parents=True)
    (directory / "model.safetensors").write_bytes(b"not a checkpoint")
    (directory / "config.json").write_text("{}")
    with pytest.raises(ModelFailed, match="size mismatch"):
        require_ready("muscriptor-large")


def test_large_validated_files_require_local_dependencies(monkeypatch):
    import mizan.engine.muscriptor as official

    directory = home() / "models" / "muscriptor-large"
    directory.mkdir(parents=True)
    (directory / "model.safetensors").write_bytes(b"dummy weights")
    (directory / "config.json").write_text(
        '{"dim":1536,"num_heads":24,"num_layers":48,"card":1395}')
    monkeypatch.setitem(MODELS, "muscriptor-large", {
        **MODELS["muscriptor-large"], "bytes": len(b"dummy weights"),
        "sha256": hashlib.sha256(b"dummy weights").hexdigest()})
    monkeypatch.setattr(official.importlib.util, "find_spec", lambda name: None)
    with pytest.raises(ModelFailed, match="torch, muscriptor"):
        require_ready("muscriptor-large")
    monkeypatch.setattr(official.importlib.util, "find_spec", lambda name: object())
    monkeypatch.setitem(MODELS, "muscriptor-large", {
        **MODELS["muscriptor-large"], "sha256": "0" * 64})
    with pytest.raises(ModelFailed, match="checksum mismatch"):
        require_ready("muscriptor-large")


def test_corrupt_job_model_never_uses_standard_pipeline():
    with pytest.raises(InvalidTranscriptionModel):
        pipeline.run_pipeline({"id": str(uuid4()), "instrument": "piano",
                               "transcription_model": "unknown"}, lambda *_: None, Event())


@pytest.mark.parametrize("model", tuple(MODELS))
def test_official_event_mapping_progress_and_cancel(monkeypatch, model):
    import contextlib
    import mizan.engine.muscriptor as official

    monkeypatch.setattr(official, "require_ready", lambda model, event: None)
    monkeypatch.setattr(official, "_check_memory", lambda model: None)

    class Tensor:
        def __init__(self, values):
            self.values = values

        def unsqueeze(self, axis):
            return self

    class OfficialModel:
        @staticmethod
        def load_model(path, device):
            assert path.name == "model.safetensors" and device == "cpu"
            return OfficialModel()

        def transcribe(self, source, **kwargs):
            assert source[1] == 16000 and len(source[0].values) == 16000
            assert kwargs == {"cfg_coef": 1.0, "no_eos_is_ok": True}
            yield SimpleNamespace(completed=0, total=2)
            for index, (instrument, pitch, onset, offset) in enumerate((
                ("acoustic_piano", 60, 0.11, 0.61),
                ("program_0", 64, 0.23, 0.88),
                ("drums", 36, 0.31, 0.32),
                ("drums", 46, 0.42, 0.43),
                ("drums", 45, 0.45, 0.46),
                ("drums", 47, 0.47, 0.48),
                ("drums", 50, 0.50, 0.51),
                ("drums", 37, 0.55, 0.56),
                ("violin", 72, 0.67, 0.79),
            )):
                start = SimpleNamespace(index=index, instrument=instrument, pitch=pitch, start_time=onset)
                yield start
                yield SimpleNamespace(start_event_index=index, end_time=offset)
            yield SimpleNamespace(completed=2, total=2)

    thread_counts = []
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(
        set_num_threads=thread_counts.append, inference_mode=contextlib.nullcontext,
        from_numpy=Tensor))
    monkeypatch.setattr(official, "_load_official_model", lambda model, weights: OfficialModel())
    audio = Audio(np.zeros(16000, dtype=np.float32), 16000)
    progress = []
    piano, drums, details, events = _transcribe_inprocess(model, audio, Event(), progress.append)
    assert thread_counts == [
        (os.cpu_count() or 1) if model == "muscriptor-large"
        else min(12, os.cpu_count() or 1)]
    assert [note["midi"] for note in piano] == [60, 64]
    assert [note["onset"] for note in piano] == [0.11, 0.23]
    assert all(note["hand"] in ("left", "right") and note["generated"] is False for note in piano)
    assert [(hit["sourceMidi"], hit["lane"]) for hit in drums] == [
        (36, "kick"), (46, "openhat"), (45, "floortom"),
        (47, "hightom"), (50, "hightom"),
    ]
    assert progress == [0, 1, 1]
    assert details["model"] == {"id": model, "version": MODELS[model]["sha256"]}
    assert "violin" in details["warnings"][1] and "tentative" in details["warnings"][1]
    assert "drum MIDI 37" in details["warnings"][2] and "raw modelEvents" in details["warnings"][2]
    assert [(event["instrument"], event["midi"]) for event in events] == [
        ("acoustic_piano", 60), ("program_0", 64), ("drums", 36),
        ("drums", 46), ("drums", 45), ("drums", 47), ("drums", 50),
        ("drums", 37), ("violin", 72)]
    assert events[-1]["onset"] == 0.67 and events[-1]["offset"] == 0.79
    cancelled = Event()
    cancelled.set()
    with pytest.raises(Cancelled):
        _transcribe_inprocess(model, audio, cancelled)


def test_best_effort_counts_only_eos_runtime_warnings_and_replays_others(monkeypatch):
    import contextlib
    import warnings
    import mizan.engine.muscriptor as official

    monkeypatch.setattr(official, "require_ready", lambda *_: None)
    monkeypatch.setattr(official, "_check_memory", lambda *_: None)
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(
        set_num_threads=lambda *_: None, inference_mode=contextlib.nullcontext,
        from_numpy=lambda samples: SimpleNamespace(unsqueeze=lambda _: samples)))

    class WarningModel:
        def transcribe(self, *_args, **kwargs):
            assert kwargs == {"cfg_coef": 1.0, "no_eos_is_ok": True}
            warnings.warn(
                "chunk 0 (seek=0.0s) did not emit EOS within 2000 tokens",
                RuntimeWarning)
            warnings.warn("unrelated runtime warning", RuntimeWarning)
            yield SimpleNamespace(index=1, instrument="acoustic_piano",
                                  pitch=60, start_time=0.1)
            yield SimpleNamespace(start_event_index=1, end_time=0.5)
            warnings.warn(
                "chunk 1 (seek=5.0s) did not emit EOS within 2000 tokens",
                RuntimeWarning)
            warnings.warn("unrelated user warning", UserWarning)

    monkeypatch.setattr(official, "_load_official_model", lambda *_: WarningModel())
    audio = Audio(np.zeros(160000, dtype=np.float32), 16000)
    with warnings.catch_warnings(record=True) as replayed:
        warnings.simplefilter("always")
        piano, _drums, details, events = _transcribe_inprocess(
            "muscriptor-small", audio, Event())

    assert len(piano) == 1 and events[0]["midi"] == 60
    assert details["decodingErrors"] == {
        "count": 2,
        "details": [
            {"chunk": 0, "seekSeconds": 0.0, "tokenLimit": 2000},
            {"chunk": 1, "seekSeconds": 5.0, "tokenLimit": 2000},
        ],
    }
    assert [(str(item.message), item.category) for item in replayed] == [
        ("unrelated runtime warning", RuntimeWarning),
        ("unrelated user warning", UserWarning),
    ]

    class FatalModel:
        def transcribe(self, *_args, **kwargs):
            assert kwargs == {"cfg_coef": 1.0, "no_eos_is_ok": True}
            warnings.warn(
                "chunk 0 (seek=0.0s) did not emit EOS within 2000 tokens",
                RuntimeWarning)
            yield SimpleNamespace(index=1, instrument="acoustic_piano",
                                  pitch=60, start_time=0.1)
            yield SimpleNamespace(start_event_index=1, end_time=0.5)
            raise RuntimeError("CUDA out of memory")

    monkeypatch.setattr(official, "_load_official_model", lambda *_: FatalModel())
    with warnings.catch_warnings(record=True):
        warnings.simplefilter("always")
        with pytest.raises(ModelFailed, match="Official muscriptor-small CPU transcription failed"):
            _transcribe_inprocess("muscriptor-small", audio, Event())


def test_dense_passage_token_limit_has_actionable_model_error(monkeypatch):
    import contextlib
    import mizan.engine.muscriptor as official

    monkeypatch.setattr(official, "require_ready", lambda *_: None)
    monkeypatch.setattr(official, "_check_memory", lambda *_: None)
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(
        set_num_threads=lambda *_: None, inference_mode=contextlib.nullcontext,
        from_numpy=lambda samples: SimpleNamespace(unsqueeze=lambda _: samples)))

    class DenseModel:
        def transcribe(self, *_args, **_kwargs):
            raise RuntimeError(
                "chunk 0 (seek=0.0s) did not emit EOS within 2000 tokens "
                "(this is only raised under --strict-eos)")
            yield

    monkeypatch.setattr(official, "_load_official_model", lambda *_: DenseModel())
    with pytest.raises(ModelFailed, match="2000-token limit.*another MuScriptor size"):
        _transcribe_inprocess("muscriptor-small", Audio(np.zeros(16000, dtype=np.float32), 16000))


@pytest.mark.parametrize(("model", "recovery"), [
    ("muscriptor-small", "Try a shorter recording."),
    ("muscriptor-medium", "Retry with MuScriptor Small"),
    ("muscriptor-large", "Retry with MuScriptor Small"),
])
def test_cpu_timeout_message_suggests_a_smaller_model_only_when_available(model, recovery):
    message = _cpu_inference_timeout_message(
        model, Audio(np.zeros(90 * 16000, dtype=np.float32), 16000))
    assert "1.5-minute recording" in message
    assert recovery in message
    if model == "muscriptor-small":
        assert "Retry with MuScriptor Small" not in message


def test_large_checkpoint_loader_uses_pread_without_changing_weights(monkeypatch, tmp_path):
    import mizan.engine.muscriptor as official

    weights = tmp_path / "model.safetensors"
    weights.write_bytes(b"mock")
    calls = []
    original = lambda *_args, **_kwargs: {"original": True}
    source = ModuleType("muscriptor.transcription_model")
    source.load_file = original

    def load_file(path, **kwargs):
        calls.append((path, kwargs))
        return {"tensor": "verified-tensor"}

    class Model:
        @staticmethod
        def load_model(path, device):
            if source.load_file is original:
                assert source.load_file(path, device=device) == {"original": True}
                return "loaded default"
            assert source.load_file(path, device=device) == {"tensor": "verified-tensor"}
            return "loaded official architecture"

    package = ModuleType("muscriptor")
    package.__path__ = []
    package.TranscriptionModel = Model
    package.transcription_model = source
    monkeypatch.setitem(sys.modules, "muscriptor", package)
    monkeypatch.setitem(sys.modules, "muscriptor.transcription_model", source)
    safetensors = ModuleType("safetensors")
    safetensors.__path__ = []
    safetensors_torch = ModuleType("safetensors.torch")
    safetensors_torch.load_file = load_file
    monkeypatch.setitem(sys.modules, "safetensors", safetensors)
    monkeypatch.setitem(sys.modules, "safetensors.torch", safetensors_torch)
    assert official._load_official_model("muscriptor-large", weights) == "loaded official architecture"
    assert calls == [(weights, {"device": "cpu", "backend": "pread"})]
    assert source.load_file is original
    assert weights.read_bytes() == b"mock"
    assert official._load_official_model("muscriptor-small", weights) == "loaded default"


@pytest.mark.skipif(os.name != "nt", reason="Windows job object memory limit")
def test_large_worker_has_room_for_verified_checkpoint_load():
    import ctypes
    from mizan.engine.muscriptor import _assign_memory_limit, _close_job, _ExtendedLimit

    with subprocess.Popen(
            [sys.executable, "-c", "import sys; sys.stdin.buffer.read(1)"],
            stdin=subprocess.PIPE) as worker:
        guard = _assign_memory_limit(worker, "muscriptor-large")
        try:
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.QueryInformationJobObject.argtypes = [
                ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p,
                ctypes.c_ulong, ctypes.c_void_p]
            kernel.QueryInformationJobObject.restype = ctypes.c_int
            limits = _ExtendedLimit()
            assert kernel.QueryInformationJobObject(
                guard, 9, ctypes.byref(limits), ctypes.sizeof(limits), None)
            assert limits.ProcessMemoryLimit == 16 * 1024 ** 3
            worker.stdin.write(b"1")
            worker.stdin.close()
            assert worker.wait(timeout=5) == 0
        finally:
            _close_job(guard)


def test_native_worker_crash_is_model_error_not_host_crash(monkeypatch, tmp_path):
    import mizan.engine.muscriptor as official
    from mizan import telemetry

    source = tmp_path / "original.wav"
    write_audio(source, Audio(np.zeros(16000, dtype=np.float32), 16000))

    class Crashed:
        pid = 12345
        returncode = 0xC0000005
        stdin = io.BytesIO()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def poll(self):
            return self.returncode

    monkeypatch.setattr(official.subprocess, "Popen", lambda *args, **kwargs: Crashed())
    monkeypatch.setattr(official, "_assign_memory_limit", lambda worker, model: None)
    with pytest.raises(ModelFailed, match="0xC0000005"):
        transcribe_official("muscriptor-large", Audio(np.zeros(16000), 16000),
                            source=source)
    assert telemetry.worker_pid is None
    assert not (tmp_path / "muscriptor-result.json").exists()


def test_real_isolated_worker_process_reports_progress_and_notes(monkeypatch, tmp_path):
    import mizan.engine.muscriptor as official

    source = tmp_path / "original.wav"
    write_audio(source, Audio(np.zeros(16000, dtype=np.float32), 16000))
    original_popen = official.subprocess.Popen
    payload = {"piano": [{"midi": 60}], "drums": [], "details": {"method": "official"},
               "events": [{"instrument": "violin", "midi": 72, "onset": 0.1, "offset": 0.2}]}

    def replace_worker(command, **kwargs):
        result = command[command.index("--result") + 1]
        progress = command[command.index("--progress") + 1]
        code = (
            "import json, pathlib, sys, time;"
            "sys.stdin.buffer.read(1);"
            f"pathlib.Path({progress!r}).write_text('0.5');"
            "time.sleep(0.4);"
            f"pathlib.Path({result!r}).write_text({json.dumps(payload)!r})"
        )
        return original_popen([sys.executable, "-c", code], **kwargs)

    monkeypatch.setattr(official.subprocess, "Popen", replace_worker)
    monkeypatch.setattr(official, "_assign_memory_limit", lambda worker, model: None)
    progress = []
    piano, drums, details, events = transcribe_official(
        "muscriptor-small", Audio(np.zeros(16000), 16000), Event(),
        progress.append, source=source)
    assert piano == [{"midi": 60}] and drums == []
    assert details["method"] == "official" and events[0]["instrument"] == "violin"
    assert progress == [0.5]
    assert not (tmp_path / "muscriptor-result.json").exists()


def test_cancelled_worker_is_terminated_and_cleans_ipc(monkeypatch, tmp_path):
    import mizan.engine.muscriptor as official
    from mizan import telemetry

    source = tmp_path / "original.wav"
    write_audio(source, Audio(np.zeros(16000, dtype=np.float32), 16000))
    cancelled = Event()

    class Running:
        pid = 12345
        stdin = io.BytesIO()
        returncode = None
        killed = False

        def __enter__(self):
            cancelled.set()
            return self

        def __exit__(self, *args):
            pass

        def poll(self):
            return self.returncode

        def kill(self):
            self.killed = True
            self.returncode = 1

        def wait(self):
            return self.returncode

    worker = Running()
    monkeypatch.setattr(official.subprocess, "Popen", lambda *args, **kwargs: worker)
    monkeypatch.setattr(official, "_assign_memory_limit", lambda process, model: None)
    with pytest.raises(Cancelled):
        transcribe_official("muscriptor-medium", Audio(np.zeros(16000), 16000),
                            cancelled, source=source)
    assert worker.killed
    assert telemetry.worker_pid is None
    assert not list(tmp_path.glob("muscriptor-*.json"))


@pytest.mark.parametrize("model", tuple(MODELS))
def test_official_pipeline_uses_demucs_stems_and_original_mix(monkeypatch, tmp_path, model):
    source = tmp_path / "original.wav"
    audio = fixture_audio()
    write_audio(source, audio)
    seen = []

    def demucs(mix, cancelled, progress, active):
        seen.append(("separation", mix))
        assert mix is not None
        progress(1)
        silence = Audio(np.zeros_like(mix.samples), mix.rate)
        return {
            **{name: silence for name in ("bass", "other", "guitar")},
            "vocals": Audio(mix.samples * 0.5, mix.rate),
            "piano": mix, "drums": mix,
        }, {"method": "htdemucs-6s-onnx", "provider": {"effectiveProviders": ["CPU"]}}

    def official_model(chosen, mix, cancelled, progress, *, source):
        assert chosen == model
        stem = source == tmp_path / "vocals.wav"
        seen.append(("vocal-stem" if stem else "transcription", mix))
        if not stem:
            assert source == tmp_path / "original.wav"
        else:
            assert mix is not seen[0][1]
        progress(1)
        if stem:
            return [], [], {"method": f"{chosen}-pytorch-cpu",
                             "model": {"id": chosen, "version": "test"},
                             "provider": {"effectiveProviders": ["PyTorch CPU"]},
                             "input": "mix", "warnings": ["vocal decoder warning"],
                             "decodingErrors": {"count": 2, "details": [
                                 {"chunk": 2, "seekSeconds": 10.0, "tokenLimit": 2000},
                                 {"chunk": 3, "seekSeconds": 15.0, "tokenLimit": 2000},
                             ]}}, [
                                 {"instrument": "voice", "midi": 60, "onset": 0.2, "offset": 0.8},
                                 {"instrument": "voice", "midi": 64, "onset": 1.0, "offset": 1.6},
                                 {"instrument": "voice", "midi": 67, "onset": 2.0, "offset": 2.6},
                                 {"instrument": "acoustic_piano", "midi": 72, "onset": 1.1, "offset": 1.5},
                             ]
        return ([{"midi": 60, "onset": 0.3, "offset": 0.6, "velocity": 0.7,
                  "confidence": 0.55, "generated": False, "hand": "right"}],
                [{"lane": "kick", "sourceMidi": 36, "onset": 0.2,
                  "velocity": 0.7, "confidence": 0.55, "possibleLanes": ["kick"]}],
                {"method": f"{chosen}-pytorch-cpu",
                 "model": {"id": chosen, "version": "test"},
                 "provider": {"effectiveProviders": ["PyTorch CPU"]},
                 "warnings": ["mix decoder warning"],
                 "decodingErrors": {"count": 1, "details": [
                     {"chunk": 1, "seekSeconds": 5.0, "tokenLimit": 2000},
                 ]}},
                [{"instrument": "violin", "midi": 72, "onset": 0.5, "offset": 1.1},
                 {"instrument": "drums", "midi": 37, "onset": 0.2, "offset": 0.21},
                 {"instrument": "acoustic_guitar", "midi": 64, "onset": 1.0, "offset": 1.3},
                  {"instrument": "electric_bass", "midi": 40, "onset": 1.5, "offset": 1.9},
                  {"instrument": "voice", "midi": 67, "onset": 0.7, "offset": 1.2}])

    monkeypatch.setattr(pipeline, "_demucs", demucs)
    monkeypatch.setattr("mizan.engine.muscriptor.transcribe_official", official_model)
    stages = []
    song = pipeline.analyze_decoded(
        source, tmp_path, title="Large", url=URL, instrument="auto",
        report=lambda stage, value: stages.append((stage, value)),
        cancelled=Event(), transcription_model=model)
    assert [stage for stage, _ in seen][-1] == "vocal-stem"
    assert {stage for stage, _ in seen[:2]} == {"separation", "transcription"}
    assert seen[0][1] is seen[1][1]
    assert song["modelVersions"]["piano"] == song["modelVersions"]["drums"] == "test"
    assert song["diagnostics"]["separate"]["method"] == "htdemucs-6s-onnx"
    assert song["decodingErrors"]["count"] == 3
    assert song["decodingErrors"]["byInput"] == {"mix": 1, "vocals": 2}
    vocal_details = song["diagnostics"]["transcribe"]["instruments"]["vocals"]
    assert "vocal decoder warning" in vocal_details["warnings"]
    assert "uncalibrated draft" in vocal_details["warnings"][-1]
    assert song["piano"][0]["onset"] == 0.3 and song["drums"][0]["onset"] == 0.2
    assert [(event["instrument"], event["midi"]) for event in song["modelEvents"]] == [
        ("violin", 72), ("drums", 37), ("acoustic_guitar", 64), ("electric_bass", 40),
        ("voice", 67)]
    assert {"violin", "drums", "acoustic_guitar", "electric_bass", "voice"} == {
        item["instrument"] for item in song["detectedInstrumentTracks"]}
    assert all(item["kind"] == "detected-notes" and item["rendered"] is False
               for item in song["detectedInstrumentTracks"])
    track = next(item for item in song["tracks"] if item["id"] == "instrument-violin")
    assert (track["instrument"], track["group"], track["scoreStatus"],
            track["sourceInstrument"]) == ("other", "detected", "draft", "violin")
    assert song["instrumentNotes"][track["id"]][0]["midi"] == 72
    assert song["instrumentNotes"][track["id"]][0]["onset"] == 0.5
    assert song["instrumentNotes"][track["id"]][0]["offset"] == 1.1
    assert {item["id"] for item in song["tracks"] if item.get("group") == "detected"} == {
        "instrument-violin", "instrument-acoustic-guitar", "instrument-electric-bass",
        "instrument-voice"}
    assert "vocals" in song["selectedInstruments"]
    assert [note["midi"] for note in song["vocals"]] == [60, 64, 67]
    assert all(note["sourceInstrument"] == "voice" and "hand" not in note for note in song["vocals"])
    assert song["transcribedInstruments"] == [
        "piano", "drums", "vocals", "acoustic_guitar", "electric_bass", "violin", "voice"]
    assert song["transcriptionQuality"]["vocals"]["status"] == "tentative"
    assert song["diagnostics"]["transcribe"]["instruments"]["vocals"]["input"] == "vocals-stem"
    assert song["modelVersions"]["vocals"] == "test"
    assert next(track for track in song["tracks"] if track["id"] == "vocals")["instrument"] == "vocals"
    assert [msg.note for track in mido.MidiFile(tmp_path / "score.mid").tracks
            if track.name == "Vocal melody" for msg in track if msg.type == "note_on"] == [60, 64, 67]
    assert '<score-part id="vocals">' in (tmp_path / "score.musicxml").read_text(encoding="utf-8")
    assert song["instrumentNotes"]["instrument-voice"][0]["midi"] == 67
    assert (tmp_path / "vocals.wav").is_file()
    assert song["diagnostics"]["chords"]["method"]
    assert "Violin" not in [message.name for output in mido.MidiFile(tmp_path / "score.mid").tracks
                            for message in output if message.type == "track_name"]
    assert "Violin" not in (tmp_path / "score.musicxml").read_text(encoding="utf-8")
    assert "Acoustic Guitar" not in (tmp_path / "score.musicxml").read_text(encoding="utf-8")
    assert [value for stage, value in stages if stage == "transcribe"][-1] == 1
    if model == "muscriptor-small":
        analysis = tmp_path / "analysis.json"
        analysis.write_text(json.dumps(song), encoding="utf-8")
        entry = LibraryStore().create_import(
            "Detected parts", "midi", song, {"analysis": str(analysis)}, "v1")
        deleted = LibraryStore().delete_score_track(entry["id"], track["id"])
        saved = json.loads(Path(deleted["song_path"]).read_text(encoding="utf-8"))
        assert track["id"] not in saved["instrumentNotes"]
        assert track["id"] not in {item["id"] for item in saved["tracks"]}
        assert any(event["instrument"] == "violin" for event in saved["modelEvents"])


@pytest.mark.parametrize("stem_level,expected_calls", [(0.005, 1), (0.5, 2)])
def test_official_vocals_require_audible_stem_and_voice_label(monkeypatch, tmp_path, stem_level, expected_calls):
    source = tmp_path / "original.wav"
    write_audio(source, fixture_audio())
    calls = []

    def demucs(mix, *_):
        silence = Audio(np.zeros_like(mix.samples), mix.rate)
        return {**{name: silence for name in ("bass", "other", "guitar")},
                "piano": mix, "drums": mix,
                "vocals": Audio(mix.samples * stem_level, mix.rate)}, {
                    "method": "htdemucs-6s-onnx", "provider": {"effectiveProviders": ["CPU"]}}

    def official_model(model, audio, cancelled, progress, *, source):
        calls.append(source.name)
        return [], [], {"method": f"{model}-pytorch-cpu",
                        "model": {"id": model, "version": "test"},
                        "provider": {"effectiveProviders": ["PyTorch CPU"]},
                        "warnings": []}, [
                            {"instrument": "voice", "midi": 60, "onset": 0.5, "offset": 1.0},
                            {"instrument": "acoustic_piano", "midi": 64, "onset": 1.5, "offset": 2.0},
                        ] if source.name == "original.wav" else [
                            {"instrument": "acoustic_piano", "midi": 64, "onset": 1.5, "offset": 2.0},
                        ]

    monkeypatch.setattr(pipeline, "_demucs", demucs)
    monkeypatch.setattr("mizan.engine.muscriptor.transcribe_official", official_model)
    song = pipeline.analyze_decoded(
        source, tmp_path, title="Instrumental", url=URL, instrument="auto",
        report=lambda *_: None, cancelled=Event(), transcription_model="muscriptor-small")
    assert len(calls) == expected_calls
    assert song["vocals"] == []
    assert "vocals" not in song["transcribedInstruments"]
    assert not any(track["id"] == "vocals" for track in song["tracks"])
    assert song["instrumentNotes"]["instrument-voice"][0]["midi"] == 60
    if expected_calls == 2:
        assert song["transcriptionQuality"]["vocals"]["status"] == "empty"


def test_parallel_mix_overlaps_separation_and_preserves_stage_order(monkeypatch, tmp_path):
    source = tmp_path / "original.wav"
    write_audio(source, fixture_audio())
    mix_started, separator_started, mix_done, separated = Event(), Event(), Event(), Event()
    main_thread = get_ident()
    reports = []
    originals = []
    monkeypatch.setattr(pipeline, "_parallel_ram_safe", lambda *_: True)

    def demucs(audio, cancelled, progress, active):
        originals.append(audio)
        separator_started.set()
        assert mix_started.wait(5)
        active({"method": "htdemucs-6s-onnx", "provider": {"effectiveProviders": ["CPU"]}})
        progress(1)
        separated.set()
        stems = {name: Audio(audio.samples * 0.5, audio.rate)
                 for name in ("drums", "bass", "other", "vocals", "guitar", "piano")}
        return stems, {"method": "htdemucs-6s-onnx", "provider": {"effectiveProviders": ["CPU"]}}

    def official(model, audio, cancelled, progress, *, source):
        if source.name == "original.wav":
            assert separator_started.wait(5)
            originals.append(audio)
            mix_started.set()
            assert not separated.is_set()
            progress(0.7)
            mix_done.set()
        else:
            assert separated.is_set() and mix_done.is_set()
            assert source.name == "vocals.wav"
        return [], [], {"method": "muscriptor-small-pytorch-cpu",
                        "model": {"id": model, "version": "test"},
                        "provider": {"effectiveProviders": ["PyTorch CPU"]}, "warnings": []}, []

    monkeypatch.setattr(pipeline, "_demucs", demucs)
    monkeypatch.setattr("mizan.engine.muscriptor.transcribe_official", official)
    song = pipeline.analyze_decoded(
        source, tmp_path, title="Overlap", url=URL, instrument="auto",
        report=lambda stage, value: reports.append((stage, value, get_ident())),
        cancelled=Event(), transcription_model="muscriptor-small")
    assert len(originals) == 2 and originals[0] is originals[1]
    assert mix_done.is_set() and separated.is_set()
    assert all(thread == main_thread for _, _, thread in reports)
    stage_order = ["detect", "separate", "transcribe", "chords", "notation"]
    assert [stage_order.index(stage) for stage, _, _ in reports] == sorted(
        stage_order.index(stage) for stage, _, _ in reports)
    assert song["diagnostics"]["transcribe"]["seconds"] >= 0
    assert song["diagnostics"]["detect"]["seconds"] >= song["diagnostics"]["detect"]["selectionSeconds"]
    assert "muscriptor-overlap" in song["diagnostics"]["detect"]["method"]
    assert song["diagnostics"]["separate"]["inferenceSeconds"] >= 0


@pytest.mark.parametrize("failure", ["cancel", "worker", "separator"])
def test_parallel_failure_joins_sibling_and_preserves_cause(monkeypatch, tmp_path, failure):
    source = tmp_path / "original.wav"
    write_audio(source, fixture_audio())
    cancelled = Event()
    worker_started, worker_finished = Event(), Event()
    monkeypatch.setattr(pipeline, "_parallel_ram_safe", lambda *_: True)

    def official(model, audio, stop, progress, *, source):
        worker_started.set()
        try:
            if failure == "worker":
                raise ModelFailed("original worker failed")
            assert worker_finished.wait(0.01) is False
            while not stop.is_set():
                time.sleep(0.01)
            raise Cancelled()
        finally:
            worker_finished.set()

    def demucs(audio, stop, progress, active):
        assert worker_started.wait(5)
        if failure == "cancel":
            cancelled.set()
        if failure == "separator":
            raise RuntimeError("separator failed")
        while not stop.is_set():
            time.sleep(0.01)
        pipeline.check_cancel(stop)

    monkeypatch.setattr(pipeline, "_demucs", demucs)
    monkeypatch.setattr("mizan.engine.muscriptor.transcribe_official", official)
    expected = {"cancel": Cancelled, "worker": ModelFailed, "separator": RuntimeError}[failure]
    with pytest.raises(expected, match="original worker failed" if failure == "worker"
                       else "separator failed" if failure == "separator" else None):
        pipeline.analyze_decoded(
            source, tmp_path, title="Failure", url=URL, instrument="drums",
            report=lambda *_: None, cancelled=cancelled, transcription_model="muscriptor-small")
    assert worker_finished.is_set()


@pytest.mark.parametrize("model,free_gib,expected", [
    ("muscriptor-small", 7, False),
    ("muscriptor-small", 11, True),
    ("muscriptor-medium", 11, False),
    ("muscriptor-medium", 16, True),
    ("muscriptor-large", 64, False),
])
def test_parallel_ram_preflight_requires_combined_budget(monkeypatch, model, free_gib, expected):
    monkeypatch.setattr(pipeline, "_available_physical_ram", lambda: free_gib * 1024 ** 3)
    assert pipeline._parallel_ram_safe(model, 300) is expected
    monkeypatch.setattr(pipeline, "_available_physical_ram", lambda: None)
    assert not pipeline._parallel_ram_safe(model, 300)


def test_unknown_memory_falls_back_to_sequential_mix(monkeypatch, tmp_path):
    source = tmp_path / "original.wav"
    write_audio(source, fixture_audio())
    monkeypatch.setattr(pipeline, "_available_physical_ram", lambda: None)
    separated = Event()
    original_calls = []

    def demucs(audio, *_):
        separated.set()
        return {name: audio for name in ("drums", "bass", "other", "vocals", "guitar", "piano")}, {
            "method": "htdemucs-6s-onnx", "provider": {"effectiveProviders": ["CPU"]}}

    def official(model, audio, stop, progress, *, source):
        if source.name == "original.wav":
            assert separated.is_set()
            original_calls.append(audio)
        return [], [], {"method": "muscriptor-small-pytorch-cpu",
                        "model": {"id": model, "version": "test"},
                        "provider": {"effectiveProviders": ["PyTorch CPU"]}, "warnings": []}, []

    monkeypatch.setattr(pipeline, "_demucs", demucs)
    monkeypatch.setattr("mizan.engine.muscriptor.transcribe_official", official)
    pipeline.analyze_decoded(
        source, tmp_path, title="Sequential", url=URL, instrument="drums",
        report=lambda *_: None, cancelled=Event(), transcription_model="muscriptor-small")
    assert len(original_calls) == 1


def test_saved_stems_never_start_parallel_mix(monkeypatch, tmp_path):
    source = tmp_path / "original.wav"
    write_audio(source, fixture_audio())
    monkeypatch.setattr(pipeline, "_parallel_ram_safe",
                        lambda *_: pytest.fail("Reused stems must skip parallel preflight"))
    monkeypatch.setattr(pipeline, "_demucs",
                        lambda *_: pytest.fail("Reused stems must skip separation"))
    separated = Event()

    def reuse(song_id, recording, audio, directory, cancelled, warnings):
        separated.set()
        return {name: audio for name in ("drums", "bass", "other", "vocals", "guitar", "piano")}, {
            "method": "htdemucs-6s-onnx", "provider": {"effectiveProviders": ["Saved audio"]},
            "warnings": [], "reused": True}

    def official(model, audio, stop, progress, *, source):
        assert separated.is_set()
        return [], [], {"method": "muscriptor-small-pytorch-cpu",
                        "model": {"id": model, "version": "test"},
                        "provider": {"effectiveProviders": ["PyTorch CPU"]}, "warnings": []}, []

    monkeypatch.setattr(pipeline, "_reuse_stems", reuse)
    monkeypatch.setattr("mizan.engine.muscriptor.transcribe_official", official)
    song = pipeline.analyze_decoded(
        source, tmp_path, title="Reused", url=URL, instrument="drums",
        report=lambda *_: None, cancelled=Event(), transcription_model="muscriptor-small",
        saved_recording=source, saved_song_id="saved")
    assert song["diagnostics"]["separate"]["reused"] is True
