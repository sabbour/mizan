import json
import inspect
from threading import Event
from urllib.request import Request, urlopen

import pytest

from mizan.api import Api, _stage_details, queue_job
from mizan.artifacts import ArtifactServer
from mizan import azure_cloud
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


def test_cloud_failure_hint_points_to_provider_error_details():
    result = queue_job({
        "id": "failed-cloud-job", "kind": "transcribe", "song_id": None,
        "url": URL, "title": "", "thumbnail": None, "status": "failed",
        "stage": "detect", "progress": 0, "details": {"processingMode": "cloud"},
        "created_at": "2026-10-05T00:00:00Z", "updated_at": "2026-10-05T00:00:01Z",
        "order_index": 0, "error_code": "cloud_failed",
        "error_message": "Azure POST failed (HTTP 400): BadRequest: Unknown properties volumes.",
        "instrument": "piano", "transcription_model": "muscriptor-large",
    })

    assert result["fix"] == (
        "Review the Cloud error details and correct the reported issue before retrying.")
    assert "sign in" not in result["fix"].lower()
    assert "connectivity" not in result["fix"].lower()
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


def test_job_preview_uses_served_existing_files(api, tmp_path):
    bridge, runner = api
    job_id = bridge.start_job(URL, "piano")["job"]["id"]
    wait_for(runner.store, job_id, "done")
    mix, piano = tmp_path / "original.wav", tmp_path / "piano.wav"
    mix.write_bytes(b"RIFF-test-original-audio")
    piano.write_bytes(b"RIFF-test-piano-audio")
    runner.store.update(job_id, details={
        "previewArtifacts": {"mix": str(mix), "piano": str(piano),
                             "drums": str(tmp_path / "missing.wav")},
        "found": {"key": "A minor", "tempo": 112},
    })
    server = ArtifactServer()
    bridge._artifacts = server
    try:
        found = bridge.get_job(job_id)["job"]["found"]
        assert found["key"] == "A minor" and found["tempo"] == 112
        assert set(found["stems"]) == {"mix", "piano"}
        assert str(tmp_path) not in json.dumps(found)
        with urlopen(found["stems"]["mix"], timeout=5) as response:
            assert response.read() == mix.read_bytes()
        with urlopen(Request(found["stems"]["piano"], headers={"Range": "bytes=5-8"}),
                     timeout=5) as response:
            assert response.status == 206
            assert response.read() == piano.read_bytes()[5:9]
        mix.unlink()
        piano.unlink()
        assert "stems" not in bridge.get_job(job_id)["job"]["found"]
    finally:
        server.close()


def test_completed_legacy_job_recovers_preview_without_reanalysis(api, tmp_path):
    bridge, runner = api
    job_id = bridge.start_job(URL, "piano")["job"]["id"]
    wait_for(runner.store, job_id, "done")
    analysis = tmp_path / "analysis.json"
    analysis.write_text(json.dumps({"key": {"tonic": "F", "mode": "major"}, "bpm": 98}),
                        encoding="utf-8")
    mix = tmp_path / "original.wav"
    mix.write_bytes(b"saved recording")
    runner.store.update(job_id, details={
        "processingMode": "cloud",
        "artifacts": {"analysis": str(analysis), "mix": str(mix)},
        "previewArtifacts": {"piano": str(mix)},
    })
    result = bridge.get_job(job_id)
    assert result["ok"]
    assert result["job"]["found"] == {
        "key": "F major", "tempo": 98, "stems": {"mix": mix.as_uri()},
    }
    assert result["job"]["status"] == "done"
    assert bridge.list_queue()["jobs"][0]["found"] == result["job"]["found"]


def test_bad_saved_preview_facts_report_warning_but_keep_audio(api, tmp_path, caplog):
    bridge, runner = api
    job_id = bridge.start_job(URL, "piano")["job"]["id"]
    wait_for(runner.store, job_id, "done")
    analysis, mix = tmp_path / "analysis.json", tmp_path / "original.wav"
    analysis.write_text("not JSON", encoding="utf-8")
    mix.write_bytes(b"saved recording")
    runner.store.update(job_id, details={"artifacts": {"analysis": str(analysis), "mix": str(mix)}})
    result = bridge.get_job(job_id)["job"]
    assert result["found"] == {"stems": {"mix": mix.as_uri()}}
    assert any("Saved key and tempo could not be loaded" in warning for warning in result["warnings"])
    assert "Could not read job preview facts" in caplog.text


def test_pywebview_can_inspect_bridge_arguments(api):
    bridge, _ = api
    for method, expected in (
        ("ffmpeg_status", []),
        ("set_ffmpeg_path", ["path"]),
        ("get_transcription_model", []),
        ("set_transcription_model", ["model"]),
        ("model_download_status", []),
        ("start_model_download", ["model"]),
        ("hf_token_status", []),
        ("set_hf_token", ["token"]),
        ("clear_hf_token", []),
        ("cancel_cloud_setup", ["provider"]),
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
        assert azure_cloud._setup_cancelled.is_set()
    assert not azure_cloud._setup_cancelled.is_set()
    assert bridge.cancel_cloud_status("unknown-request") == {"ok": True, "cancelRequested": False}


def test_azure_subscription_compatibility_aliases_are_never_routed_to_active_provider(api, monkeypatch):
    from mizan import cloud

    bridge, _ = api
    calls = []
    cloud._setting("cloud_provider", "aws")
    monkeypatch.setattr(cloud, "list_subscriptions", lambda *, provider=None: (
        calls.append(provider) or [{
            "subscriptionId": "sub", "displayName": "Azure account",
            "tenantId": "tenant", "state": "Enabled",
        }]))

    assert bridge.azure_subscriptions()["subscriptions"] == [
        {"id": "sub", "name": "Azure account", "tenantId": "tenant"},
    ]
    assert bridge.list_subscriptions()["subscriptions"][0]["subscriptionId"] == "sub"
    assert calls == ["azure", "azure"]


def test_cloud_account_discovery_forwards_the_selected_aws_profile(api, monkeypatch):
    from mizan import cloud

    bridge, _ = api
    calls = []
    account = {"accountId": "123456789012", "profile": "work", "region": "us-west-2"}
    monkeypatch.setattr(cloud, "list_subscriptions", lambda **options: (
        calls.append(options) or [account]))
    result = bridge.list_cloud_subscriptions("aws", "work", "us-west-2")
    assert result["ok"] is True
    assert result["subscriptions"] == [account]
    assert calls == [{"provider": "aws", "profile": "work", "region": "us-west-2"}]


def test_setup_api_pins_provider_before_progress_tracking(api, monkeypatch):
    from contextlib import contextmanager
    from mizan import cloud

    bridge, _ = api
    calls = []

    @contextmanager
    def track(operation, total, *, provider=None):
        calls.append(("track", operation, total, provider))
        cloud._setting("cloud_provider", "gcp")
        yield

    monkeypatch.setattr(cloud, "track_setup", track)
    monkeypatch.setattr(cloud, "configure", lambda config, *, provider=None: (
        calls.append(("configure", provider, config)) or {"ok": True, "provider": provider}))

    result = bridge.configure_cloud({"provider": "aws", "profile": "work"}, "aws")

    assert result["ok"] is True
    assert calls == [
        ("track", "configuration", 2, "aws"),
        ("configure", "aws", {"provider": "aws", "profile": "work"}),
    ]


def test_readiness_status_progress_and_cancellation_use_explicit_provider(api, monkeypatch):
    from mizan import cloud

    bridge, _ = api
    calls = []
    monkeypatch.setattr(cloud, "panel_status", lambda request_id, *, provider=None: (
        calls.append(("status", request_id, provider)) or {"provider": provider, "configured": False}))
    monkeypatch.setattr(cloud, "readiness_progress", lambda request_id, *, provider=None: (
        calls.append(("progress", request_id, provider)) or {"stage": "idle"}))
    monkeypatch.setattr(cloud, "cancel_panel_status", lambda request_id, *, provider=None: (
        calls.append(("cancel", request_id, provider)) or {"cancelRequested": True}))
    cloud._setting("cloud_provider", "gcp")

    assert bridge.cloud_status("setup-1", "aws")["provider"] == "aws"
    assert bridge.cloud_readiness_progress("setup-1", "aws")["stage"] == "idle"
    assert bridge.cancel_cloud_status("setup-1", "aws")["cancelRequested"] is True
    assert calls == [
        ("status", "setup-1", "aws"),
        ("progress", "setup-1", "aws"),
        ("cancel", "setup-1", "aws"),
    ]


def test_cloud_readiness_progress_is_local_and_request_scoped(api, monkeypatch):
    from mizan import cloud

    bridge, _ = api
    check = azure_cloud._ReadinessCheck(("settings",))
    check.set_progress("ACR image", "Authenticating with the selected registry.")
    cancelled = Event()
    azure_cloud._readiness_requests["progress-request"] = (check, cancelled)
    monkeypatch.setattr(azure_cloud, "_job_capabilities",
                        lambda *_args: pytest.fail("Progress polling launched Azure readiness"))
    try:
        progress = bridge.cloud_readiness_progress("progress-request")
        assert progress["ok"] is True
        assert progress["stage"] == "ACR image"
        assert progress["detail"] == "Authenticating with the selected registry."
        assert progress["elapsedSeconds"] >= 0
        assert bridge.cloud_readiness_progress("unknown-request") == {
            "ok": True, "stage": "idle", "detail": None, "elapsedSeconds": 0,
            "timeoutSeconds": azure_cloud.READINESS_TIMEOUT}
    finally:
        azure_cloud._readiness_requests.pop("progress-request", None)


@pytest.mark.parametrize("request_id", [None, "", "x" * 129, 42, []])
def test_cloud_readiness_progress_rejects_invalid_request_ids(api, request_id):
    bridge, _ = api
    result = bridge.cloud_readiness_progress(request_id)
    assert result["ok"] is False
    assert result["error"]["code"] == "cloud_failed"
    assert result["error"]["message"] == "The Azure readiness request ID is invalid."


def test_cloud_mode_api_returns_saved_setup_without_live_readiness(api, monkeypatch):
    from mizan import cloud
    from test_cloud import SETUP

    bridge, runner = api
    config = {**SETUP, "userObjectId": "dddddddd-dddd-dddd-dddd-dddddddddddd"}
    cloud._setting("cloud_config", json.dumps(config))
    cloud._setting("cloud_prepared", json.dumps(config))
    cloud._setting("cloud_environment_ready", "yes")
    cloud._setting("cloud_job_created",
                   f"{SETUP['registry']}.azurecr.io/mizan-aca-gpu@{azure_cloud.SUPPORTED_WORKER_DIGEST}")
    cloud._setting("transcription_model", "muscriptor-large")
    monkeypatch.setattr(azure_cloud, "_job_capabilities",
                        lambda *_args: pytest.fail("Cloud mode save ran live readiness"))
    monkeypatch.setattr(cloud, "panel_status",
                        lambda *_args: pytest.fail("Cloud mode save launched a panel check"))

    result = bridge.set_processing_mode("cloud")

    assert result["ok"] and result["mode"] == "cloud"
    assert result["config"]["environment"] == SETUP["environment"]
    assert result["prepared"] and result["jobCreated"]
    assert result["configured"] is False
    assert "userObjectId" not in result["config"]
    assert runner.store.get_transcription_model() == "muscriptor-large"


def test_local_mode_api_succeeds_when_saved_cloud_config_is_malformed(api):
    from mizan import cloud

    bridge, _ = api
    cloud._setting("cloud_config", "{")
    cloud._setting("processing_mode", "cloud")

    assert bridge.set_processing_mode("local") == {"ok": True, "mode": "local"}
    assert cloud._setting("processing_mode") == "local"


def test_add_link_deduplicates_only_same_selected_provider_and_model(monkeypatch):
    from mizan import cloud

    entered, release = Event(), Event()

    def pipeline(job, report, cancelled):
        entered.set()
        assert release.wait(5)

    store = JobStore()
    cloud._setting("processing_mode", "cloud")
    monkeypatch.setattr("mizan.engine.muscriptor.check_model_resources", lambda _model: None)
    monkeypatch.setattr(azure_cloud, "_job_capabilities",
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
