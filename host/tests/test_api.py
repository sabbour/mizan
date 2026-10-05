import json
import inspect
from threading import Event

import pytest

from mizan.api import Api, _stage_details
from mizan.jobs import JobRunner, JobStore

from test_jobs import URL, wait_for


def test_running_stage_reports_actual_processor_and_model():
    job = {
        "kind": "transcribe", "status": "running", "stage": "detect",
        "details": {"diagnostics": {}, "activeStage": {
            "name": "detect", "method": "htdemucs-6s-onnx",
            "model": {"id": "htdemucs-6s-fp16weights"},
            "provider": {"effectiveProviders": ["CPUExecutionProvider"]},
        }},
    }
    stages = _stage_details(job)
    active = next(stage for stage in stages if stage["name"] == "detect")
    assert active["model"] == "htdemucs-6s-fp16weights"
    assert active["provider"] == "CPUExecutionProvider"
    assert active["seconds"] is None
    assert next(stage for stage in stages if stage["name"] == "transcribe")["model"] is None


def test_job_activity_is_scoped_to_requested_job(api):
    bridge, runner = api
    job = bridge.start_job(URL, "piano")["job"]
    wait_for(runner.store, job["id"], "done")
    runner.store.update(job["id"], details={"diagnostics": {
        "detect": {"seconds": 2.5, "method": "stem-rms-priority-v2",
                   "provider": {"effectiveProviders": ["CPU-DSP"]}}},
        "warnings": ["Draft notes are uncertain."]})
    result = bridge.get_job_log(job["id"])
    assert result["ok"] is True
    assert "Detect: stem-rms-priority-v2 on CPU-DSP (2.50 s)" in result["lines"]
    assert "Analysis completed." in result["lines"]
    assert "Warning: Draft notes are uncertain." in result["lines"]
    assert bridge.get_job_log("missing")["error"]["code"] == "job_not_found"


@pytest.fixture
def api():
    runner = JobRunner(JobStore(), lambda job, report, cancelled: None)
    try:
        yield Api(runner), runner
    finally:
        runner.close()


@pytest.mark.parametrize("method,args,code", [
    ("start_job", ("not a url", "piano"), "invalid_url"),
    ("start_job", (None, "piano"), "invalid_url"),
    ("start_job", (URL, "guitar"), "invalid_instrument"),
    ("get_job", ("missing",), "job_not_found"),
    ("get_job", (None,), "job_not_found"),
    ("cancel_job", ("missing",), "job_not_found"),
    ("open_result", ("missing",), "job_not_found"),
])
def test_error_envelopes(api, method, args, code):
    bridge, _ = api
    result = getattr(bridge, method)(*args)
    assert set(result) == {"ok", "error"}
    assert result["ok"] is False
    expected = {"code", "message"} | ({"fix"} if code == "invalid_url" else set())
    assert set(result["error"]) == expected
    assert result["error"]["code"] == code
    assert result["error"]["message"]
    json.dumps(result)


def test_success_envelopes_and_completed_result(api):
    bridge, runner = api
    response = bridge.start_job(URL, "piano")
    assert response["ok"] is True
    job = response["job"]
    assert set(job) == {
        "id", "videoId", "url", "instrument", "transcriptionModel", "stage", "status", "progress",
        "errorCode", "errorMessage", "createdAt", "updatedAt",
    }
    assert job["status"] == "queued"
    wait_for(runner.store, job["id"], "done")
    result = bridge.get_job(job["id"])
    assert result["ok"] is True
    assert result["job"]["status"] == "done"
    assert bridge.list_jobs() == {"ok": True, "jobs": [result["job"]]}
    assert bridge.open_result(job["id"]) == result
    json.dumps(result)


def test_incomplete_result_and_cancel():
    entered = Event()

    def pipeline(job, report, cancelled):
        entered.set()
        assert cancelled.wait(5)

    runner = JobRunner(JobStore(), pipeline)
    bridge = Api(runner)
    try:
        job_id = bridge.start_job(URL, "drums")["job"]["id"]
        assert entered.wait(5)
        response = bridge.open_result(job_id)
        assert response["ok"] is False
        assert response["error"]["code"] == "pipeline_not_ready"
        cancelled = bridge.cancel_job(job_id)
        assert cancelled["ok"] is True
        assert cancelled["job"]["status"] == "cancelled"
    finally:
        runner.close()


def test_unexpected_errors_are_logged_and_enveloped(api, monkeypatch, caplog):
    bridge, runner = api

    def fail():
        raise OSError("test storage failure")

    monkeypatch.setattr(runner.store, "list", fail)
    response = bridge.list_jobs()
    assert response["ok"] is False
    assert response["error"]["code"] == "internal_error"
    assert "test storage failure" in caplog.text


def test_pywebview_can_inspect_bridge_arguments(api):
    bridge, _ = api
    for method, expected in (
        ("get_transcription_model", []),
        ("set_transcription_model", ["model"]),
        ("model_download_status", []),
        ("start_model_download", ["model"]),
        ("hf_token_status", []),
        ("set_hf_token", ["token"]),
        ("clear_hf_token", []),
        ("cancel_cloud_setup", []),
        ("start_job", ["url", "instrument"]),
        ("get_job", ["job_id"]),
        ("cancel_job", ["job_id"]),
        ("list_jobs", []),
        ("open_result", ["job_id"]),
    ):
        assert inspect.getfullargspec(getattr(bridge, method)).args[1:] == expected


def test_cancel_cloud_setup_only_signals_active_provision(api):
    from mizan import cloud

    bridge, _ = api
    assert bridge.cancel_cloud_setup() == {"ok": True, "cancelRequested": False}
    with cloud.track_setup("provision", 10):
        assert bridge.cancel_cloud_setup() == {"ok": True, "cancelRequested": True}
        assert cloud._setup_cancelled.is_set()
    assert not cloud._setup_cancelled.is_set()
    assert bridge.cancel_cloud_status("unknown-request") == {"ok": True, "cancelRequested": False}


def test_add_link_deduplicates_only_same_selected_provider_and_model(monkeypatch):
    from mizan import cloud

    entered, release = Event(), Event()

    def pipeline(job, report, cancelled):
        entered.set()
        assert release.wait(5)

    store = JobStore()
    cloud._setting("processing_mode", "cloud")
    monkeypatch.setattr("mizan.engine.muscriptor.check_model_resources", lambda _model: None)
    monkeypatch.setattr(cloud, "_job_capabilities",
                        lambda *_args: pytest.fail("Submission checked remote readiness"))
    runner = JobRunner(store, pipeline)
    bridge = Api(runner)
    monkeypatch.setattr(bridge, "_inspect", lambda _url: pytest.fail("Submission inspected metadata"))
    try:
        first = bridge.add_link(URL)["job"]
        assert entered.wait(5)
        assert first["processingMode"] == "cloud"
        assert bridge.add_link(URL)["job"]["id"] == first["id"]
        cloud._setting("processing_mode", "local")
        local = bridge.add_link(URL)["job"]
        assert local["id"] != first["id"] and local["processingMode"] == "local"
        cloud._setting("processing_mode", "cloud")
        store.set_transcription_model("muscriptor-large")
        large = bridge.add_link(URL)["job"]
        assert large["id"] not in (first["id"], local["id"])
        assert large["processingMode"] == "cloud" and large["transcriptionModel"] == "muscriptor-large"
        assert bridge.add_link(URL)["job"]["id"] == large["id"]
        assert store.get(first["id"])["status"] == "running"
        assert len(store.list_queue()) == 3
    finally:
        release.set()
        runner.close()


def test_activity_never_labels_unmeasured_cloud_progress_as_percentage(api):
    from mizan import cloud

    bridge, runner = api
    cloud._setting("processing_mode", "cloud")
    job = runner.store.create("aB_12-cD345", URL, "auto", "test", processing_mode="cloud")
    runner.store.update(job["id"], status="running", stage="detect", progress=0,
                        details={**job["details"], "stageMessage": "Azure GPU Job running"})
    lines = bridge.get_job_log(job["id"])["lines"]
    assert "Azure GPU Job running" in lines
    assert not any("%" in line for line in lines)
    assert bridge.get_job(job["id"])["job"]["stageProgress"] is None


def test_retry_keeps_original_cloud_provider_and_model_after_settings_change(monkeypatch):
    from mizan import cloud

    entered, release = Event(), Event()

    def pipeline(job, report, cancelled):
        entered.set()
        assert release.wait(5)

    store = JobStore()
    store.set_transcription_model("muscriptor-medium")
    job = store.create("aB_12-cD345", URL, "auto", "test", processing_mode="cloud")
    store.update(job["id"], status="failed")
    cloud._setting("processing_mode", "local")
    store.set_transcription_model("muscriptor-small")
    monkeypatch.setattr("mizan.engine.muscriptor.check_model_resources",
                        lambda _model: pytest.fail("Cloud retry attempted Local processing"))
    runner = JobRunner(store, pipeline)
    try:
        retried = Api(runner).retry_job(job["id"])["job"]
        assert retried["processingMode"] == "cloud"
        assert retried["transcriptionModel"] == "muscriptor-medium"
        assert entered.wait(5)
    finally:
        release.set()
        runner.close()


def test_hf_token_bridge_never_returns_or_logs_secret(api, monkeypatch, caplog):
    from mizan import hf_credentials

    bridge, _ = api
    secret = "hf_example_only_not_real"
    stored = []
    monkeypatch.setattr(hf_credentials, "get_hf_token", lambda: stored[0] if stored else None)
    monkeypatch.setattr(hf_credentials, "set_hf_token", lambda value: stored.__setitem__(slice(None), [value]))
    monkeypatch.setattr(hf_credentials, "clear_hf_token", stored.clear)

    assert bridge.hf_token_status() == {"ok": True, "configured": False}
    assert bridge.set_hf_token(secret) == {"ok": True, "configured": True}
    assert bridge.hf_token_status() == {"ok": True, "configured": True}
    assert bridge.clear_hf_token() == {"ok": True, "configured": False}
    assert bridge.hf_token_status() == {"ok": True, "configured": False}

    def fail(_):
        raise OSError("Credential Manager failed")

    monkeypatch.setattr(hf_credentials, "set_hf_token", fail)
    error = bridge.set_hf_token(secret)
    assert error["ok"] is False
    assert "Credential Manager" in error["error"]["message"]
    assert secret not in json.dumps(error) + caplog.text
    assert inspect.getfullargspec(bridge.set_hf_token).args[1:] == ["token"]
    def fail_status():
        raise OSError("unavailable")

    monkeypatch.setattr(hf_credentials, "get_hf_token", fail_status)
    assert bridge.hf_token_status()["error"]["message"].startswith("Windows Credential Manager is unavailable")

    def fail_with_secret(_):
        raise RuntimeError(secret)

    caplog.clear()
    monkeypatch.setattr(hf_credentials, "set_hf_token", fail_with_secret)
    result = bridge.set_hf_token(secret)
    assert result["ok"] is False
    assert secret not in caplog.text + json.dumps(result)


def test_hf_native_credential_structure_and_no_plaintext_fallback(monkeypatch):
    import ctypes
    from mizan import hf_credentials

    captured = {}

    class Vault:
        def CredWriteW(self, pointer, flags):
            record = ctypes.cast(pointer, ctypes.POINTER(hf_credentials._Credential)).contents
            captured.update(
                target=record.TargetName, type=record.Type, persist=record.Persist,
                payload=ctypes.string_at(record.CredentialBlob, record.CredentialBlobSize),
            )
            return True

    monkeypatch.setattr(hf_credentials, "_vault", Vault)
    hf_credentials.set_hf_token("hf_é-test")
    assert captured == {
        "target": hf_credentials.TARGET, "type": 1, "persist": 2,
        "payload": "hf_é-test".encode("utf-16-le"),
    }
    with pytest.raises(ValueError):
        hf_credentials.set_hf_token("x" * 1300)

    class ReadVault:
        def __init__(self):
            payload = bytearray("hf_é-test".encode("utf-16-le"))
            self.buffer = (ctypes.c_ubyte * len(payload)).from_buffer(payload)
            self.record = hf_credentials._Credential(
                CredentialBlobSize=len(payload), CredentialBlob=self.buffer,
            )
            self.pointer = ctypes.pointer(self.record)
            self.freed = False

        def CredReadW(self, target, kind, flags, output):
            assert (target, kind, flags) == (hf_credentials.TARGET, 1, 0)
            ctypes.cast(output, ctypes.POINTER(ctypes.POINTER(hf_credentials._Credential)))[0] = self.pointer
            return True

        def CredFree(self, pointer):
            self.freed = True

    vault = ReadVault()
    monkeypatch.setattr(hf_credentials, "_vault", lambda: vault)
    assert hf_credentials.get_hf_token() == "hf_é-test"
    assert vault.freed
