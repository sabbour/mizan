import time
from threading import Event

import pytest

from mizan.api import queue_job
from mizan.errors import ModelFailed
from mizan.jobs import JobRunner, JobStore, STAGES
from mizan.paths import app_dir, home

URL = "https://youtu.be/aB_12-cD345"


def wait_for(store, job_id, status):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        job = store.get(job_id)
        if job["status"] == status:
            return job
        time.sleep(0.01)
    pytest.fail(f"Expected {status}, got {store.get(job_id)}")


def test_paths_created_on_demand(tmp_path, monkeypatch):
    root = tmp_path / "mizan"
    assert not root.exists()
    assert home() == root
    assert list(root.iterdir()) == []
    for name in ("downloads", "cache", "logs", "tmp"):
        assert app_dir(name) == root / name
        assert app_dir(name).is_dir()
    with pytest.raises(ValueError):
        app_dir("../escape")
    monkeypatch.delenv("MIZAN_HOME")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    assert home() == tmp_path / "local" / "Mizan"


def test_queue_transitions_and_single_worker():
    entered, release = Event(), Event()
    calls = []
    store = JobStore()

    def pipeline(job, report, cancelled):
        calls.append(job["id"])
        assert job["status"] == "running"
        for stage in STAGES:
            report(stage, 0.5)
        entered.set()
        assert release.wait(5)

    runner = JobRunner(store, pipeline)
    try:
        first = runner.start(URL, "piano")
        assert first["status"] == "queued"
        assert entered.wait(5)
        running = store.get(first["id"])
        assert running["status"] == "running"
        assert running["stage"] == "finalize"
        assert running["progress"] == 0.5
        second = runner.start(URL, "drums")
        queued = queue_job(store.get(second["id"]))
        assert queued["status"] == "queued"
        queued_at = queued["attemptQueuedAt"]
        assert calls == [first["id"]]
        time.sleep(0.05)
        release.set()
        for job in (first, second):
            raw = wait_for(store, job["id"], "done")
            done = queue_job(raw)
            assert done["progress"] == 1
            assert done["stage"] == "finalize"
            assert done["errorCode"] is None
            assert raw["updated_at"] >= raw["created_at"]
            assert done["startedAt"] is not None
            assert done["finishedAt"] is not None
            assert done["elapsedSeconds"] is not None
            assert done["elapsedSeconds"] >= 0
        second_done = queue_job(store.get(second["id"]))
        assert second_done["attemptQueuedAt"] == queued_at
        assert second_done["elapsedSeconds"] >= 0.05
        assert calls == [first["id"], second["id"]]
        assert JobStore().get(first["id"])["status"] == "done"
    finally:
        release.set()
        runner.close()


def test_running_stage_timer_survives_progress_updates_and_resets_on_next_stage():
    entered, release = Event(), Event()
    snapshots = []
    store = JobStore()

    def pipeline(job, report, cancelled):
        reports = (
            ("inspect", 0, False, None),
            ("inspect", 0.4, False, None),
            ("download", 0, False, None),
            ("download", 0.4, True, "Downloading audio"),
        )
        for stage, progress, measured, message in reports:
            report(stage, progress, measured=measured, message=message)
            snapshots.append(queue_job(store.get(job["id"])))
        entered.set()
        assert release.wait(5)

    runner = JobRunner(store, pipeline)
    try:
        job = runner.start(URL, "piano")
        assert entered.wait(5)
        first, continued, next_stage, measured = snapshots
        assert first["startedAt"] == continued["startedAt"] == next_stage["startedAt"]
        assert first["stageStartedAt"] == continued["stageStartedAt"]
        assert first["stageStartedAt"] != next_stage["stageStartedAt"]
        assert first["stageProgress"] is None and continued["stageProgress"] is None
        assert next_stage["stage"] == "download"
        assert next_stage["stageProgress"] is None
        assert measured["stageProgress"] == 0.4
        assert measured["stageMessage"] == "Downloading audio"
        assert queue_job(store.get(job["id"]))["stageStartedAt"] == next_stage["stageStartedAt"]
        release.set()
        completed = queue_job(wait_for(store, job["id"], "done"))
        assert completed["stageStartedAt"] is None
        assert completed["startedAt"] is not None and completed["finishedAt"] is not None
        assert completed["elapsedSeconds"] is not None
    finally:
        release.set()
        runner.close()


def test_retry_starts_a_fresh_timed_attempt_without_losing_cloud_mode():
    store = JobStore()
    job = store.create("aB_12-cD345", URL, "piano", "test", processing_mode="cloud")
    details = {
        **job["details"], "startedAt": "2026-10-05T00:00:00+00:00",
        "finishedAt": "2026-10-05T00:00:10+00:00", "elapsedSeconds": 10,
        "cloudElapsedSeconds": 8, "stageMessage": "Azure GPU Job failed",
        "activeStage": {"name": "detect", "provider": {"effectiveProviders": ["CPUExecutionProvider"]}},
        "diagnostics": {"detect": {"seconds": 10}},
    }
    store.update(job["id"], status="failed", details=details)

    retried = store.retry(job["id"])

    assert retried["details"]["processingMode"] == "cloud"
    assert retried["details"]["attemptQueuedAt"] != job["details"]["attemptQueuedAt"]
    assert not {"startedAt", "finishedAt", "elapsedSeconds", "cloudElapsedSeconds",
                "stageMessage", "activeStage", "diagnostics"} & retried["details"].keys()


def test_retry_retains_provider_and_queued_resource_target():
    from mizan import cloud

    target = {"version": 1, "provider": "gcp",
              "settings": {"projectId": "original-project", "region": "us-central1"}}
    store = JobStore()
    job = store.create("aB_12-cD345", URL, "piano", "test",
                       processing_mode="cloud", cloud_provider="gcp", cloud_target=target)
    store.update(job["id"], status="failed")
    cloud._setting("cloud_provider", "aws")
    observed = []
    runner = JobRunner(store, lambda current, _report, _cancelled: (
        observed.append((current["details"]["cloudProvider"],
                        current["details"]["cloudTarget"])) or {}))
    try:
        retried = runner.retry(job["id"])
        assert queue_job(retried)["cloudProviderName"] == "Google Cloud"
        assert retried["details"]["cloudTarget"] == target
        assert wait_for(store, job["id"], "done")["details"]["cloudTarget"] == target
        assert observed == [("gcp", target)]
    finally:
        runner.close()


def test_new_redo_and_mode_checks_do_not_reset_active_cloud_job(monkeypatch):
    import json
    from mizan import azure_cloud, cloud
    from mizan.api import Api

    entered, release = Event(), Event()
    calls, events = [], []
    store = JobStore()
    store.set_transcription_model("muscriptor-medium")
    cloud._setting("processing_mode", "cloud")
    cloud._setting("cloud_config", json.dumps({
        "tenantId": "11111111-1111-1111-1111-111111111111",
        "subscriptionId": "33333333-3333-3333-3333-333333333333",
        "resourceGroup": "rg-mizan", "storageAccount": "mizanblob", "container": "jobs",
        "jobName": "mizan-job", "location": "swedencentral", "registry": "mizanregistry",
        "environment": "mizan-env", "identity": "mizan-identity",
    }))
    cloud._setting("cloud_job_created", "synthetic-image")
    monkeypatch.setattr(azure_cloud, "_job_capabilities", lambda *_args: None)

    def pipeline(job, report, cancelled):
        calls.append(job["id"])
        events.append(cancelled)
        job["details"]["activeStage"] = {
            "name": "detect", "provider": {"effectiveProviders": ["CUDAExecutionProvider"]},
            "model": {"id": "htdemucs-6s-fp16weights"},
        }
        report("detect", 0.37, measured=True, message="Synthetic Azure analysis")
        entered.set()
        assert release.wait(5)

    runner = JobRunner(store, pipeline)
    monkeypatch.setattr(runner.library, "get", lambda _id: {
        "source": "youtube", "source_url": "https://youtu.be/ZYXWVUTSRQP",
        "title": "Synthetic saved song", "thumbnail": None, "duration": 5,
    })
    try:
        first = runner.add_link(URL)
        assert entered.wait(5)
        before = store.get(first["id"])
        assert cloud.set_mode("cloud")["mode"] == "cloud"
        assert Api(runner).cloud_status()["configured"]
        second = runner.add_link("https://youtu.be/ABCDEFGHIJK")
        redo = runner.reprocess("saved-song")
        for job in (first, second, redo):
            assert job["details"]["processingMode"] == "cloud"
            assert job["transcription_model"] == "muscriptor-medium"
        assert store.get(first["id"]) == before
        assert not events[0].is_set() and calls == [first["id"]]
        assert store.queue_order(first["id"]) == 0
        assert store.queue_order(second["id"]) == 1
        assert store.queue_order(redo["id"]) == 2
        store.set_transcription_model("muscriptor-large")
        release.set()
        for job in (first, second, redo):
            wait_for(store, job["id"], "done")
            assert store.get(job["id"])["transcription_model"] == "muscriptor-medium"
        assert calls == [first["id"], second["id"], redo["id"]]
    finally:
        release.set()
        runner.close()


def test_enqueue_snapshots_model_before_resource_check_changes_selection(monkeypatch):
    store = JobStore()
    monkeypatch.setattr("mizan.engine.muscriptor.check_model_resources",
                        lambda _model: store.set_transcription_model("muscriptor-large"))
    runner = JobRunner(store, lambda *_args: None)
    try:
        job = runner.add_link(URL)
        assert job["transcription_model"] == "muscriptor-small"
        assert store.get_transcription_model() == "muscriptor-large"
    finally:
        runner.close()


def test_success_preserves_cloud_timing_when_pipeline_returns_replacement_details(monkeypatch):
    monkeypatch.setattr("mizan.cloud.selected", lambda: True)

    def pipeline(job, report, cancelled):
        time.sleep(0.03)
        job["details"].update(cloudElapsedSeconds=0.02)
        return {"diagnostics": {}}

    runner = JobRunner(JobStore(), pipeline=pipeline)
    monkeypatch.setattr(runner.library, "upsert_job", lambda *_args: {"id": "saved-song"})
    try:
        job = runner.start(URL, "piano")
        completed = queue_job(wait_for(runner.store, job["id"], "done"))

        assert completed["processingMode"] == "cloud"
        assert completed["cloudElapsedSeconds"] == 0.02
        assert completed["elapsedSeconds"] >= completed["cloudElapsedSeconds"]
        assert completed["startedAt"] is not None and completed["finishedAt"] is not None
    finally:
        runner.close()


@pytest.mark.parametrize("error,code", [
    (ModelFailed("Could not transcribe this recording."), "model_failed"),
    (RuntimeError("unexpected"), "internal_error"),
])
def test_failure(error, code):
    def pipeline(job, report, cancelled):
        report("transcribe", 0.4)
        raise error

    store = JobStore()
    runner = JobRunner(store, pipeline)
    try:
        job = runner.start(URL, "piano")
        failed = wait_for(store, job["id"], "failed")
        assert failed["error_code"] == code
        assert failed["error_message"]
        assert failed["stage"] == "transcribe"
        assert failed["progress"] == 0.4
        assert failed["details"]["finishedAt"] is not None
        assert failed["details"]["elapsedSeconds"] is not None
        assert runner.start(URL, "piano")["id"] != job["id"]
    finally:
        runner.close()


def test_default_pipeline_surfaces_structured_failure(monkeypatch):
    def fail(job, report, cancelled):
        raise ModelFailed("Test engine unavailable")

    monkeypatch.setattr("mizan.engine.pipeline.run_pipeline", fail)
    store = JobStore()
    runner = JobRunner(store)
    try:
        job = runner.start(URL, "piano")
        assert wait_for(store, job["id"], "failed")["error_code"] == "model_failed"
    finally:
        runner.close()


def test_cancel_running_and_queued():
    entered, release, observed = Event(), Event(), Event()
    calls = []

    def pipeline(job, report, cancelled):
        calls.append(job["id"])
        entered.set()
        assert cancelled.wait(5)
        observed.set()
        assert release.wait(5)
        report("download", 0.5)

    store = JobStore()
    runner = JobRunner(store, pipeline)
    try:
        running = runner.start(URL, "piano")
        assert entered.wait(5)
        queued = runner.start(URL, "drums")
        for job in (queued, running):
            assert runner.cancel(job["id"])["status"] == "cancelled"
        assert observed.wait(5)
        release.set()
    finally:
        release.set()
        runner.close()
    assert calls == [running["id"]]
    for job in (running, queued):
        cancelled = store.get(job["id"])
        assert cancelled["status"] == "cancelled"
        assert cancelled["error_code"] == "cancelled"
        assert cancelled["progress"] == 0


def test_cache_key_includes_instrument_and_version():
    store = JobStore()
    runner = JobRunner(store, lambda job, report, cancelled: None, pipeline_version="v1")
    try:
        job = runner.start(URL, "piano")
        wait_for(store, job["id"], "done")
        reused = runner.start("https://youtube.com/watch?v=aB_12-cD345&t=9", "piano")
        assert reused["id"] == job["id"]
        assert reused["status"] == "done"
        assert runner.cancel(job["id"])["status"] == "done"
        other = runner.start(URL, "drums")
        assert other["id"] != job["id"]
        wait_for(store, other["id"], "done")
    finally:
        runner.close()
    runner = JobRunner(JobStore(), lambda job, report, cancelled: None, pipeline_version="v2")
    try:
        assert runner.start(URL, "piano")["id"] != job["id"]
    finally:
        runner.close()


@pytest.mark.parametrize("stage,progress", [
    ("bogus", 0.5), ("inspect", -0.1), ("inspect", 1.1), ("inspect", float("nan")),
])
def test_invalid_pipeline_reports_fail(stage, progress):
    store = JobStore()
    runner = JobRunner(store, lambda job, report, cancelled: report(stage, progress))
    try:
        job = runner.start(URL, "piano")
        assert wait_for(store, job["id"], "failed")["error_code"] == "internal_error"
    finally:
        runner.close()
