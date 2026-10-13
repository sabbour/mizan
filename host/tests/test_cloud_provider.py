import json
import time
from threading import Event
from types import SimpleNamespace

import pytest

from mizan import azure_cloud, cloud
from mizan.api import queue_job
from mizan.errors import MizanError
from mizan.jobs import JobRunner, JobStore
from test_jobs import URL


def test_legacy_cloud_settings_and_jobs_default_to_azure():
    config = {"subscriptionId": "legacy"}
    cloud._setting("cloud_config", json.dumps(config))

    assert cloud.resolve_provider() == "azure"
    assert cloud.provider_for_job(None) == "azure"
    assert cloud.provider_for_job("azure") == "azure"
    with pytest.raises(MizanError, match="Unsupported Cloud provider"):
        cloud.provider_for_job("unknown")

    job = JobStore().create("aB_12-cD345", "https://youtu.be/aB_12-cD345",
                            "auto", "test", processing_mode="cloud")
    assert job["details"]["processingMode"] == "cloud"
    assert "cloudProvider" not in job["details"]
    assert queue_job(job)["cloudProvider"] is None


def test_status_dispatch_reports_provider_and_keeps_legacy_config(monkeypatch):
    config = {"subscriptionId": "legacy"}
    cloud._setting("cloud_config", json.dumps(config))
    monkeypatch.setattr(azure_cloud, "status", lambda **_kwargs: {
        "ok": True, "available": False, "configured": False, "config": config,
    })

    result = cloud.status(check_connection=False)

    assert result["provider"] == "azure"
    assert result["providerName"] == "Azure"
    assert result["config"] == {**config, "provider": "azure"}


def test_pinned_azure_dispatch_ignores_mutated_provider_selection(monkeypatch, tmp_path):
    cloud._setting("cloud_config", "{malformed")
    cloud._setting("cloud_provider", "unsupported")
    calls = []
    monkeypatch.setattr(azure_cloud, "status", lambda **kwargs: (
        calls.append(("status", kwargs)) or {"available": True, "configured": True}))
    monkeypatch.setattr(azure_cloud, "offload", lambda *args: (
        calls.append(("offload", args)) or ({"mix": "checked"}, ["jobs/result"])))
    monkeypatch.setattr(azure_cloud, "cleanup", lambda names: calls.append(("cleanup", names)))

    assert cloud.provider_for_job(None) == "azure"
    assert cloud.provider_for_job("azure") == "azure"
    assert cloud.status(provider="azure")["provider"] == "azure"
    cloud.offload("recording", tmp_path, "muscriptor-small", None, None, provider="azure")
    cloud.cleanup(["jobs/result"], provider="azure")

    assert [call[0] for call in calls] == ["status", "offload", "cleanup"]
    assert calls[0][1] == {"check_connection": True}
    with pytest.raises(MizanError, match="Unsupported Cloud provider"):
        cloud.status(provider="unsupported")
    cloud._setting("cloud_provider", "azure")
    with pytest.raises(MizanError, match="Saved Azure settings are invalid"):
        cloud.load_provider_settings("azure")


def test_provider_boundary_accepts_the_same_structural_module_contract(monkeypatch):
    fake = SimpleNamespace(status=lambda **_kwargs: {
        "ok": True, "available": True, "configured": True,
    })
    monkeypatch.setitem(cloud.PROVIDER_NAMES, "fake", "Fake")
    monkeypatch.setattr(cloud, "_implementation", lambda _provider: fake)

    result = cloud.status(provider="fake")

    assert result["provider"] == "fake"
    assert result["providerName"] == "Fake"
    assert result["configured"] is True


def test_invalid_provider_fails_before_dispatch_and_local_mode_stays_local(monkeypatch):
    cloud._setting("cloud_config", json.dumps({"provider": "unsupported"}))
    monkeypatch.setattr(azure_cloud, "list_subscriptions",
                        lambda: pytest.fail("Invalid provider reached Azure"))
    before = cloud._setting("cloud_config")
    cloud._setting("cloud_provider", "azure")

    with pytest.raises(MizanError, match="mismatched provider ID"):
        cloud.status(check_connection=False)
    cloud._setting("cloud_provider", "unsupported")
    with pytest.raises(MizanError, match="Unsupported Cloud provider"):
        cloud.status(check_connection=False)
    with pytest.raises(MizanError, match="Unsupported Cloud provider"):
        cloud.configure({"provider": "unsupported"})
    with pytest.raises(MizanError, match="Unsupported Cloud provider"):
        cloud.prepare({"provider": "unsupported"}, consent=True)

    assert cloud.set_mode("local") == {"ok": True, "mode": "local"}
    assert cloud._setting("processing_mode") == "local"
    assert cloud._setting("cloud_config") == before


def test_cloud_facade_routes_readiness_consent_and_io_operations(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(azure_cloud, "readiness_progress",
                        lambda request_id: {"stage": request_id})
    monkeypatch.setattr(azure_cloud, "cancel_panel_status",
                        lambda request_id: {"cancelRequested": request_id == "active"})
    monkeypatch.setattr(azure_cloud, "finish", lambda image, token, **kwargs: (
        calls.append((image, token, kwargs["hf_token_provider"])) or {"ok": True}))
    monkeypatch.setattr(azure_cloud, "offload", lambda *args: (
        calls.append(args) or ({"mix": "checked"}, ["jobs/result"])))
    monkeypatch.setattr(azure_cloud, "cleanup", lambda names: calls.append(names))

    token_provider = lambda: "consented-token"
    assert cloud.readiness_progress("Azure GPU Job") == {"stage": "Azure GPU Job"}
    assert cloud.cancel_panel_status("active") == {"cancelRequested": True}
    assert cloud.finish("pinned-image", hf_token_provider=token_provider)["provider"] == "azure"
    assert cloud.offload("recording", tmp_path, "muscriptor-small", "cancelled", "report") == (
        {"mix": "checked"}, ["jobs/result"])
    cloud.cleanup(["jobs/result"])
    assert calls[0] == ("pinned-image", None, token_provider)
    assert calls[1] == ("recording", tmp_path, "muscriptor-small", "cancelled", "report")
    assert calls[2] == ["jobs/result"]


def test_configure_persists_the_validated_provider_after_dispatch(monkeypatch):
    monkeypatch.setattr(azure_cloud, "configure", lambda config: {"ok": True, "config": config})

    result = cloud.configure({"provider": "azure", "resourceGroup": "rg"})

    assert result["provider"] == "azure"
    assert result["providerName"] == "Azure"
    assert cloud._setting("cloud_provider") == "azure"


def test_queued_cloud_job_keeps_its_provider_snapshot():
    entered, release = Event(), Event()
    captured = []

    def pipeline(job, _report, _cancelled):
        captured.append(job["details"]["cloudProvider"])
        entered.set()
        assert release.wait(5)

    cloud._setting("processing_mode", "cloud")
    cloud._setting("cloud_provider", "azure")
    settings = {"subscriptionId": "original", "resourceGroup": "original-rg"}
    cloud._setting("cloud_config", json.dumps(settings))
    runner = JobRunner(JobStore(), pipeline)
    try:
        queued = runner.start(URL, "piano")
        assert queue_job(queued)["cloudProvider"] == "azure"
        assert queue_job(queued)["cloudProviderName"] == "Azure"
        assert queued["details"]["cloudTarget"] == {
            "version": 1, "provider": "azure", "settings": settings,
        }
        assert entered.wait(5)
        cloud._setting("cloud_config", json.dumps({"subscriptionId": "changed"}))
        cloud._setting("cloud_provider", "invalid-after-queue")
        release.set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and runner.store.get(queued["id"])["status"] == "running":
            time.sleep(0.01)
        assert runner.store.get(queued["id"])["status"] == "done"
        assert captured == ["azure"]
        assert runner.store.get(queued["id"])["details"]["cloudTarget"]["settings"] == settings
    finally:
        release.set()
        runner.close()


def test_provider_registry_settings_and_nonsecret_job_target(monkeypatch):
    assert cloud.PROVIDER_NAMES == {
        "azure": "Azure", "gcp": "Google Cloud", "aws": "AWS",
    }
    assert cloud.PROVIDER_MODULES == {
        "azure": "mizan.azure_cloud",
        "gcp": "mizan.gcp_cloud", "aws": "mizan.aws_cloud",
    }
    cloud._setting("cloud_config", json.dumps({"subscriptionId": "azure-sub"}))
    cloud.save_provider_settings("gcp", {
        "projectId": "project", "region": "us-central1", "bucket": "private-bucket",
        "serviceAccount": "worker@example.invalid", "machineType": "g2-standard-4",
        "accelerator": "nvidia-l4",
    })
    cloud.select_provider("gcp")

    assert cloud.resolve_provider() == "gcp"
    assert cloud.load_provider_settings("azure")["subscriptionId"] == "azure-sub"
    assert cloud.provider_target("gcp") == {
        "version": 1, "provider": "gcp", "settings": {
            "projectId": "project", "region": "us-central1", "bucket": "private-bucket",
            "serviceAccount": "worker@example.invalid", "machineType": "g2-standard-4",
            "accelerator": "nvidia-l4",
        },
    }
    with pytest.raises(MizanError, match="Do not save credentials or tokens"):
        cloud.save_provider_settings("aws", {"profile": "default", "accessKeyId": "secret"})
    cloud.save_provider_settings("aws", {"profile": "work", "region": "us-east-1"})
    cloud.clear("aws")
    assert cloud._setting("cloud_config") == json.dumps({"subscriptionId": "azure-sub"})
    assert cloud.load_provider_settings("aws") == {}


def test_provider_target_rejects_bad_snapshot_and_invalid_settings_json():
    target = {"version": 1, "provider": "aws", "settings": {"secret": "no"}}
    with pytest.raises(MizanError, match="unsupported fields"):
        cloud._checked_target(target, "aws")
    cloud._setting("cloud_config:gcp", "{invalid")
    with pytest.raises(MizanError, match="Saved Google Cloud settings are invalid"):
        cloud.provider_target("gcp")


def test_aws_target_retains_only_valid_native_binding_references():
    references = {
        "profile": "original", "region": "us-east-1", "accountId": "123456789012",
        "bucket": "original-private-bucket",
        "executionRole": "arn:aws:iam::123456789012:role/MizanExecutionRole",
        "serviceRole": "arn:aws:iam::123456789012:role/MizanBatchRole",
        "instanceRole": "arn:aws:iam::123456789012:instance-profile/MizanInstance",
        "hfSecretArn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:mizan/hf-AbCd",
        "sourceHash": "a" * 64, "vpcId": "vpc-01234567",
        "routeTableId": "rtb-01234567", "internetGatewayId": "igw-01234567",
    }
    cloud.save_provider_settings("aws", references)
    target = cloud.provider_target("aws")
    assert target["settings"] == references
    assert cloud.validate_provider_target(target, "aws") == target
    cloud.save_provider_settings("aws", {"profile": "replacement"})
    assert target["settings"] == references


@pytest.mark.parametrize("value", [
    "hf_not-a-resource-reference", "https://example.invalid/?token=not-allowed",
    {"token": "not-allowed"}, None,
])
def test_native_secret_reference_fields_cannot_store_secret_values(value):
    with pytest.raises(MizanError, match="Do not save credentials or tokens"):
        cloud.save_provider_settings("aws", {"hfSecretArn": value})
    target = {"version": 1, "provider": "aws", "settings": {"hfSecretArn": value}}
    with pytest.raises(MizanError, match="credentials or invalid secret references"):
        cloud.validate_provider_target(target, "aws")


def test_removed_provider_preserves_saved_data_and_requires_an_explicit_selection():
    saved = json.dumps({"profile": "original", "projectId": "original-project"})
    cloud._setting("cloud_config:nebius", saved)
    cloud._setting("cloud_provider", "nebius")
    selection = cloud.provider_selection()
    assert [item["id"] for item in selection["providers"]] == ["azure", "gcp", "aws"]
    assert selection["activeProvider"] is None
    assert "no longer supported" in selection["issue"]
    assert cloud._setting("cloud_provider") == "nebius"
    assert cloud._setting("cloud_config:nebius") == saved
    with pytest.raises(MizanError, match="Unsupported Cloud provider"):
        cloud.resolve_provider()
    with pytest.raises(MizanError, match="Unsupported Cloud provider"):
        cloud.provider_for_job("nebius")
    cloud.select_provider("aws")
    assert cloud.provider_selection()["activeProvider"] == "aws"
    assert cloud._setting("cloud_config:nebius") == saved


def test_gcp_target_retains_verified_source_and_pinned_secret_version():
    references = {
        "projectId": "original-project", "location": "us-central1", "region": "us-central1",
        "bucket": "original-private-bucket",
        "serviceAccount": "worker@original-project.iam.gserviceaccount.com",
        "machineType": "g2-standard-8", "accelerator": "nvidia-l4",
        "image": "ghcr.io/example/worker@sha256:" + "a" * 64,
        "workerSourceHash": "b" * 64,
        "workerAuthResource": "projects/original-project/secrets/mizan-worker-hf-token/versions/12",
    }
    cloud.save_provider_settings("gcp", {**references, "prepared": True})
    target = cloud.provider_target("gcp")
    assert target["settings"] == references
    assert cloud.validate_provider_target(target, "gcp") == target
    cloud.save_provider_settings("gcp", {"projectId": "replacement-project"})
    assert target["settings"] == references


@pytest.mark.parametrize("value", [
    "hf_not-a-resource-reference", "https://example.invalid/?token=not-allowed",
    {"token": "not-allowed"}, None,
    "projects/original-project/secrets/mizan-worker-hf-token/versions/latest",
    "projects/original-project/secrets/mizan-worker-hf-token/versions/0",
])
def test_gcp_runtime_reference_requires_a_native_pinned_version(value):
    with pytest.raises(MizanError, match="Do not save credentials or tokens"):
        cloud.save_provider_settings("gcp", {"workerAuthResource": value})
    target = {"version": 1, "provider": "gcp", "settings": {"workerAuthResource": value}}
    with pytest.raises(MizanError, match="credentials or invalid secret references"):
        cloud.validate_provider_target(target, "gcp")


def test_azure_readiness_uses_the_job_target_snapshot(monkeypatch):
    from test_cloud import SETUP

    seen = []
    image = f"{SETUP['registry']}.azurecr.io/mizan-aca-gpu@sha256:{'a' * 64}"
    settings = {
        **SETUP, "userObjectId": "dddddddd-dddd-dddd-dddd-dddddddddddd",
        "image": image, "jobResources": {"cpu": 2, "memory": "8Gi"},
    }
    target = {"version": 1, "provider": "azure", "settings": settings}
    monkeypatch.setattr(azure_cloud, "_job_capabilities",
                        lambda config, selected_image, resources: seen.append(
                            (config["subscriptionId"], selected_image, resources)))
    monkeypatch.setattr(azure_cloud, "_worker_source", lambda: (b"source", "hash"))

    result = cloud.status(provider="azure", target=target)

    assert seen == [(SETUP["subscriptionId"], image, settings["jobResources"])]
    assert result["configured"] is True
    assert result["workerImage"] == image
    assert "userObjectId" not in result["config"]


def test_provider_selection_never_falls_back_to_azure(monkeypatch):
    monkeypatch.setattr(azure_cloud, "status",
                        lambda **_kwargs: pytest.fail("Provider mismatch reached Azure"))
    with pytest.raises(MizanError, match="Unsupported Cloud provider"):
        cloud.status(provider="not-a-provider")
    monkeypatch.setitem(cloud.PROVIDER_MODULES, "gcp", "mizan._missing_provider_for_test")
    with pytest.raises(MizanError, match="wiring is not installed yet"):
        cloud.status(provider="gcp")


def test_invalid_queued_provider_fails_without_running_local_pipeline():
    store = JobStore()
    job = store.create("aB_12-cD345", URL, "piano", "test",
                       processing_mode="cloud", cloud_provider="unsupported")
    runner = JobRunner(store, lambda *_args: pytest.fail("Invalid Cloud job ran a pipeline"))
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and store.get(job["id"])["status"] == "queued":
            time.sleep(0.01)
        failed = store.get(job["id"])
        assert failed["status"] == "failed"
        assert failed["error_code"] == "cloud_failed"
        assert "Unsupported Cloud provider" in failed["error_message"]
    finally:
        runner.close()


def test_mismatched_queued_target_fails_before_running_pipeline():
    store = JobStore()
    target = {"version": 1, "provider": "aws", "settings": {"region": "us-east-1"}}
    job = store.create("aB_12-cD345", URL, "piano", "test",
                       processing_mode="cloud", cloud_provider="gcp", cloud_target=target)
    runner = JobRunner(store, lambda *_args: pytest.fail("Mismatched target reached pipeline"))
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and store.get(job["id"])["status"] == "queued":
            time.sleep(0.01)
        failed = store.get(job["id"])
        assert failed["status"] == "failed"
        assert failed["error_code"] == "cloud_failed"
        assert "mismatched provider" in failed["error_message"]
    finally:
        runner.close()


@pytest.mark.parametrize("cancel_before_record", [False, True])
def test_remote_job_identifier_is_saved_before_polling_or_cancellation(cancel_before_record):
    entered, release = Event(), Event()
    remote = {"provider": "aws", "id": "batch-job-123", "prefix": "jobs/test-123/"}
    store = JobStore()
    job = store.create("aB_12-cD345", URL, "piano", "test",
                       processing_mode="cloud", cloud_provider="aws",
                       cloud_target={"version": 1, "provider": "aws",
                                     "settings": {"bucket": "original-bucket"}})

    def pipeline(_job, report, cancelled):
        if cancel_before_record:
            cancelled.set()
        report("detect", 0, cloud_job=remote)
        entered.set()
        assert release.wait(5)

    runner = JobRunner(store, pipeline)
    try:
        if not cancel_before_record:
            assert entered.wait(5)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not store.get(job["id"])["details"].get("cloudJob"):
            time.sleep(0.01)
        saved = JobStore().get(job["id"])
        assert saved["details"]["cloudJob"] == remote
        assert saved["details"]["cloudTarget"]["settings"]["bucket"] == "original-bucket"
        if cancel_before_record:
            while time.monotonic() < deadline and store.get(job["id"])["status"] == "running":
                time.sleep(0.01)
            assert store.get(job["id"])["status"] == "cancelled"
    finally:
        release.set()
        runner.close()


@pytest.mark.parametrize("remote", [
    {"provider": "gcp", "id": "job-123", "prefix": "jobs/test/"},
    {"provider": "aws", "id": "job-123", "prefix": "jobs/test/", "token": "not-allowed"},
    {"provider": "aws", "id": "job?token=not-allowed", "prefix": "jobs/test/"},
    {"provider": "aws", "id": "job-123", "prefix": "jobs/test/\n"},
])
def test_remote_job_identifiers_reject_mismatches_and_secret_fields(remote):
    with pytest.raises(MizanError, match="identifiers are invalid"):
        cloud.validate_remote_job(remote, "aws")
