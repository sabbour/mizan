import base64
import hashlib
import json
import urllib.parse
import wave
from io import BytesIO
from pathlib import Path
from threading import Event

import pytest

from mizan import cloud, gcp_cloud
from mizan.api import Api
from mizan.cloud_result import MAX_AUDIO_BYTES, MAX_WORKER_ERROR_BYTES
from mizan.cloud_worker.worker import MAX_RESULT_BYTES, MODELS
from mizan.engine.models import HTDEMUCS_6S
from mizan.jobs import JobRunner, JobStore


PROJECT = "demo-project-123"
REGION = "us-central1"
BUCKET = "mizan-private-123"
SERVICE_ACCOUNT = f"worker@{PROJECT}.iam.gserviceaccount.com"
IMAGE = "ghcr.io/mizan/mizan-cloud-worker@sha256:" + "a" * 64
SOURCE_HASH = "b" * 64
SETTINGS = {
    "projectId": PROJECT,
    "location": REGION,
    "region": REGION,
    "bucket": BUCKET,
    "serviceAccount": SERVICE_ACCOUNT,
    "machineType": "g2-standard-8",
    "accelerator": "nvidia-l4",
    "image": IMAGE,
    "workerSourceHash": SOURCE_HASH,
    "workerAuthResource": (
        f"projects/{PROJECT}/secrets/{gcp_cloud.WORKER_SECRET_ID}/versions/1"),
    "prepared": True,
}
SETUP_SETTINGS = {
    key: value for key, value in SETTINGS.items()
    if key not in ("workerAuthResource",)
}


class Response:
    def __init__(self, status=200, body=None, headers=None):
        self.status_code = status
        if isinstance(body, bytes):
            self.body = body
            default_type = "application/octet-stream"
        else:
            self.body = json.dumps(body or {}).encode()
            default_type = "application/json"
        self.headers = {
            "Content-Length": str(len(self.body)),
            "Content-Type": default_type,
            **(headers or {}),
        }
        self.closed = False

    def iter_content(self, chunk_size=65536):
        for start in range(0, len(self.body), chunk_size):
            yield self.body[start:start + chunk_size]

    def close(self):
        self.closed = True


class FakeGoogle:
    def __init__(self, *, job_states=("SUCCEEDED",)):
        self.calls = []
        self.enabled = set()
        self.bucket = None
        self.service_account = None
        self.secret_created = False
        self.secrets = {}
        self.secret_policies = {}
        self.bucket_policy = {"version": 3, "etag": "bucket-etag", "bindings": []}
        self.sa_policy = {"version": 3, "etag": "sa-etag", "bindings": []}
        self.project_policy = {"version": 3, "etag": "project-etag", "bindings": []}
        self.objects = {}
        self.jobs = {}
        self.job_payloads = {}
        self.job_states = list(job_states)
        self.create_failure = None
        self.create_status = None
        self.delete_operation_done = True
        self.job_status = None
        self.job_get_error_after_delete = None
        self.batch_delete_count = 0

    @staticmethod
    def _response(status=200, body=None, headers=None):
        return Response(status, body, headers)

    def _project(self):
        return {
            "name": "projects/123456789012",
            "projectId": PROJECT,
            "state": "ACTIVE",
        }

    def request(self, method, url, *, json=None, data=None, params=None, headers=None,
                timeout=None, allow_redirects=None, stream=None):
        split = urllib.parse.urlsplit(url)
        query = urllib.parse.parse_qs(split.query)
        path = urllib.parse.unquote(split.path)
        body = json
        if data is not None:
            body = data.read()
        self.calls.append((method, url, json, body))

        if split.netloc == "cloudresourcemanager.googleapis.com":
            if path == f"/v3/projects/{PROJECT}":
                return self._response(body=self._project())
            if path == "/v3/projects:search" and method == "GET":
                return self._response(body={"projects": [self._project()]})
            if path == f"/v3/projects/{PROJECT}:getIamPolicy" and method == "POST":
                return self._response(body=self.project_policy)
            if path == f"/v3/projects/{PROJECT}:setIamPolicy" and method == "POST":
                self.project_policy = body["policy"]
                return self._response(body=self.project_policy)

        if split.netloc == "serviceusage.googleapis.com":
            if path.startswith("/v1/operations/"):
                return self._response(body={"done": True, "response": {}})
            match = path.split("/services/", 1)
            if len(match) == 2:
                service_path = match[1]
                if service_path.endswith(":enable"):
                    service = service_path[:-7]
                    self.enabled.add(service)
                    return self._response(body={"name": f"operations/enable-{service.split('.')[0]}"})
                if service_path.startswith("operations/"):
                    return self._response(body={"done": True, "response": {}})
                service = service_path
                if service in self.enabled:
                    return self._response(body={"state": "ENABLED"})
                return self._response(404, {"error": {"status": "NOT_FOUND"}})

        if split.netloc == "storage.googleapis.com":
            if path == "/storage/v1/b" and method == "POST":
                bucket_name = body["name"]
                self.bucket = {
                    "name": bucket_name,
                    "location": body["location"],
                    "iamConfiguration": body["iamConfiguration"],
                }
                return self._response(body=self.bucket)
            if path == f"/storage/v1/b/{BUCKET}":
                if self.bucket is None:
                    return self._response(404, {"error": {"status": "NOT_FOUND"}})
                return self._response(body=self.bucket)
            if path == f"/storage/v1/b/{BUCKET}/iam":
                if (method == "GET"
                        and query.get("optionsRequestedPolicyVersion") == ["3"]):
                    return self._response(body=self.bucket_policy)
                if method == "PUT":
                    self.bucket_policy = body
                    return self._response(body=self.bucket_policy)
            prefix = f"/storage/v1/b/{BUCKET}/o/"
            if path.startswith(prefix):
                name = path[len(prefix):]
                if method == "DELETE":
                    if name not in self.objects:
                        return self._response(404, {"error": {"status": "NOT_FOUND"}})
                    self.objects.pop(name)
                    return self._response(204)
                if method == "GET" and query.get("alt") == ["media"]:
                    if name not in self.objects:
                        return self._response(404, {"error": {"status": "NOT_FOUND"}})
                    value = self.objects[name]
                    return self._response(body=value)
            upload_prefix = "/upload/storage/v1/b/"
            if path.startswith(upload_prefix) and method == "POST":
                name = query["name"][0]
                if query.get("ifGenerationMatch") == ["0"] and name in self.objects:
                    return self._response(412, {"error": {"status": "FAILED_PRECONDITION"}})
                self.objects[name] = body
                return self._response(body={"name": name})

        if split.netloc == "iam.googleapis.com":
            if path.endswith("/serviceAccounts"):
                self.service_account = {
                    "email": SERVICE_ACCOUNT,
                    "name": f"projects/{PROJECT}/serviceAccounts/{SERVICE_ACCOUNT}",
                    "disabled": False,
                }
                return self._response(body=self.service_account)
            if (path.endswith(f"/serviceAccounts/{SERVICE_ACCOUNT}:getIamPolicy")
                    and method == "POST"):
                return self._response(body=self.sa_policy)
            if (path.endswith(f"/serviceAccounts/{SERVICE_ACCOUNT}:setIamPolicy")
                    and method == "POST"):
                self.sa_policy = body["policy"]
                return self._response(body=self.sa_policy)
            if path.endswith(f"/serviceAccounts/{SERVICE_ACCOUNT}"):
                if self.service_account is None:
                    return self._response(404, {"error": {"status": "NOT_FOUND"}})
                return self._response(body=self.service_account)

        if split.netloc == "secretmanager.googleapis.com":
            resource = f"projects/{PROJECT}/secrets/{gcp_cloud.WORKER_SECRET_ID}"
            prefix = f"/v1/{resource}"
            if path == f"/v1/projects/{PROJECT}/secrets" and method == "POST":
                self.secret_created = True
                self.secrets.setdefault("versions", [])
                return self._response(body={"name": resource})
            if (path == f"{prefix}:getIamPolicy" and method == "GET"
                    and query.get("options.requestedPolicyVersion") == ["3"]):
                return self._response(body=self.secret_policies.get(
                    resource, {"version": 3, "etag": "secret-etag", "bindings": []}))
            if path == f"{prefix}:setIamPolicy" and method == "POST":
                self.secret_policies[resource] = body["policy"]
                return self._response(body=body["policy"])
            if path == f"{prefix}:addVersion":
                payload = base64.b64decode(body["payload"]["data"])
                version = len(self.secrets.setdefault("versions", [])) + 1
                self.secrets["versions"].append(payload)
                return self._response(body={"name": f"{resource}/versions/{version}"})
            if path == prefix:
                if not self.secret_created:
                    return self._response(404, {"error": {"status": "NOT_FOUND"}})
                return self._response(body={"name": resource})
            if path in (f"{prefix}/versions/latest",
                        f"{prefix}/versions/{len(self.secrets.get('versions', []))}"):
                count = len(self.secrets.get("versions", []))
                if not count:
                    return self._response(404, {"error": {"status": "NOT_FOUND"}})
                return self._response(body={
                    "name": f"{resource}/versions/{count}", "state": "ENABLED"})

        if split.netloc == "batch.googleapis.com":
            job_root = f"/v1/projects/{PROJECT}/locations/{REGION}/jobs"
            if path == job_root and method == "POST":
                if self.create_failure:
                    raise self.create_failure
                if self.create_status:
                    return self._response(
                        self.create_status, {"error": {"status": "INVALID_ARGUMENT"}})
                job_id = query["jobId"][0]
                name = f"projects/{PROJECT}/locations/{REGION}/jobs/{job_id}"
                self.job_payloads[job_id] = body
                self.jobs[job_id] = {
                    "name": name,
                    "status": {"state": self.job_states[0]},
                }
                if self.job_states[0] == "SUCCEEDED":
                    self._publish_job_output(body)
                return self._response(body={"name": name})
            if path.startswith(f"{job_root}/") and path.endswith("/operations"):
                return self._response(body={"done": self.delete_operation_done})
            if path.startswith(f"{job_root}/"):
                job_id = path.rsplit("/", 1)[-1]
                if job_id not in self.jobs:
                    return self._response(404, {"error": {"status": "NOT_FOUND"}})
                if method == "DELETE":
                    self.batch_delete_count += 1
                    if self.delete_operation_done:
                        self.jobs[job_id]["status"]["state"] = "CANCELED"
                    return self._response(body={
                        "name": f"projects/{PROJECT}/locations/{REGION}/operations/delete-{job_id}"})
                if (method == "GET" and self.batch_delete_count
                        and self.job_get_error_after_delete):
                    return self._response(
                        self.job_get_error_after_delete,
                        {"error": {"status": "PERMISSION_DENIED"}})
                job = self.jobs[job_id]
                if self.job_status:
                    job["status"]["state"] = self.job_status
                elif len(self.job_states) > 1:
                    state = self.job_states.pop(0)
                    job["status"]["state"] = state
                    if state == "SUCCEEDED":
                        self._publish_job_output(self.job_payloads[job_id])
                return self._response(body=job)

        if split.netloc == "batch.googleapis.com" and "/operations/" in path:
            return self._response(body={"done": self.delete_operation_done})

        return self._response(404, {"error": {"status": "NOT_FOUND"}})

    def _publish_job_output(self, payload):
        source = payload["taskGroups"][0]["taskSpec"]["runnables"][0]["container"]["commands"][0]
        prefix = source.removesuffix("/input.wav")
        audio = self.objects[source]
        self.objects[f"{prefix}/result.json"] = _manifest(audio, prefix)
        for stem in ("drums", "bass", "other", "vocals", "guitar", "piano"):
            self.objects[f"{prefix}/result/stems/{stem}.wav"] = audio

    def close(self):
        pass


def _audio_bytes():
    stream = BytesIO()
    with wave.open(stream, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(44100)
        output.writeframes(b"\0\0" * 4410)
    return stream.getvalue()


def _manifest(audio, prefix):
    digest = hashlib.sha256(audio).hexdigest()
    names = [f"{prefix}/result/stems/{stem}.wav" for stem in (
        "drums", "bass", "other", "vocals", "guitar", "piano")]
    stems = {
        name.rsplit("/", 1)[-1][:-4]: {
            "blob": name,
            "bytes": len(audio),
            "sha256": digest,
            "sampleRate": 44100,
            "samples": 4410,
            "channels": 1,
        }
        for name in names
    }
    return json.dumps({
        "input": {"blob": f"{prefix}/input.wav", "bytes": len(audio), "sha256": digest},
        "model": "muscriptor-small",
        "modelVersion": MODELS["muscriptor-small"][1],
        "provider": "PyTorch CUDA",
        "separation": {
            "method": "htdemucs-6s-onnx",
            "model": HTDEMUCS_6S["id"],
            "modelVersion": HTDEMUCS_6S["version"],
            "provider": "CUDAExecutionProvider",
            "sampleRate": 44100,
            "samples": 4410,
            "channels": 1,
        },
        "stems": stems,
        "events": [],
        "vocalEvents": [],
    }).encode()


def _session(monkeypatch, *, job_states=("SUCCEEDED",)):
    fake = FakeGoogle(job_states=job_states)
    monkeypatch.setattr(gcp_cloud, "_authorized_session", lambda: fake)
    return fake


def _verified(monkeypatch):
    monkeypatch.setattr(gcp_cloud, "_verified_image", lambda image: {
        "image": image, "digest": image.rsplit("@", 1)[1], "sourceHash": SOURCE_HASH,
    })


def _prepared(monkeypatch):
    fake = _session(monkeypatch)
    _verified(monkeypatch)
    monkeypatch.setattr(gcp_cloud.time, "sleep", lambda _seconds: None)
    result = gcp_cloud.prepare(SETUP_SETTINGS, consent=True)
    assert result["prepared"] is True
    return fake


def test_shared_limits_and_worker_budget_are_used():
    assert gcp_cloud.MAX_AUDIO_BYTES is MAX_AUDIO_BYTES
    assert gcp_cloud.MAX_WORKER_ERROR_BYTES is MAX_WORKER_ERROR_BYTES
    assert gcp_cloud.MAX_RESULT_BYTES is MAX_RESULT_BYTES
    assert gcp_cloud._model_resources("muscriptor-small", SETTINGS) == (2, 8)
    assert gcp_cloud._model_resources("muscriptor-medium", SETTINGS) == (4, 16)
    assert gcp_cloud._model_resources("muscriptor-large", SETTINGS) == (8, 32)
    with pytest.raises(gcp_cloud.CloudError, match="does not meet"):
        gcp_cloud._model_resources(
            "muscriptor-large", {**SETTINGS, "machineType": "g2-standard-4"})
    with pytest.raises(gcp_cloud.CloudError, match="not supported"):
        gcp_cloud.require_model("unknown")


def test_status_models_follow_machine_and_l4_memory_budgets():
    names = [
        "muscriptor-small",
        "muscriptor-medium",
        "muscriptor-large",
    ]
    assert gcp_cloud.status(check_connection=False)["supportedModels"] == names
    assert gcp_cloud._status_for_settings(
        {**SETTINGS, "machineType": "g2-standard-4"},
        check_connection=False,
    )["supportedModels"] == names[:2]
    assert gcp_cloud._status_for_settings(
        SETTINGS, check_connection=False)["supportedModels"] == names


def test_require_model_checks_catalog_not_current_machine_capacity(monkeypatch):
    cloud.save_provider_settings(
        "gcp", {**SETTINGS, "machineType": "g2-standard-4"})

    gcp_cloud.require_model("muscriptor-large")

    with pytest.raises(gcp_cloud.CloudError, match="does not meet"):
        gcp_cloud._model_resources(
            "muscriptor-large", cloud.load_provider_settings("gcp"))


def test_authorized_session_uses_installed_google_auth_transport_offline(monkeypatch):
    import google.auth
    from google.auth.transport.requests import AuthorizedSession, Request

    credentials = object()
    monkeypatch.setattr(
        google.auth, "default",
        lambda **kwargs: (credentials, PROJECT))

    session = gcp_cloud._authorized_session()
    try:
        assert isinstance(session, AuthorizedSession)
        assert session.credentials is credentials
        assert isinstance(session._auth_request, Request)
        assert session._refresh_timeout == gcp_cloud.REQUEST_TIMEOUT
        assert session._max_refresh_attempts == 0
    finally:
        session.close()


def test_missing_application_default_credentials_give_sanitized_login_steps(monkeypatch):
    import google.auth
    from google.auth.exceptions import DefaultCredentialsError

    monkeypatch.setattr(
        google.auth, "default",
        lambda **_kwargs: (_ for _ in ()).throw(
            DefaultCredentialsError("private credential file contents")))

    with pytest.raises(gcp_cloud.CloudError) as failure:
        gcp_cloud._authorized_session()

    message = str(failure.value)
    assert "gcloud auth application-default login" in message
    assert "same Windows account" in message
    assert "gcloud auth login" in message
    assert "private credential file contents" not in message


def test_refresh_error_is_not_reported_as_network_or_exposes_provider_detail():
    from google.auth.exceptions import RefreshError

    class FailedRefresh:
        def request(self, *_args, **_kwargs):
            raise RefreshError("private refresh token")

    with pytest.raises(gcp_cloud.CloudError) as failure:
        gcp_cloud._Rest(FailedRefresh()).request("GET", "https://example.invalid")

    message = str(failure.value)
    assert "could not be refreshed" in message
    assert "gcloud auth application-default login" in message
    assert "Could not reach" not in message
    assert "private refresh token" not in message


def test_google_network_failure_is_distinct_from_authentication_failure():
    class OfflineSession:
        def request(self, *_args, **_kwargs):
            raise ConnectionError("private network detail")

    with pytest.raises(gcp_cloud.CloudError) as failure:
        gcp_cloud._Rest(OfflineSession()).request("GET", "https://example.invalid")

    message = str(failure.value)
    assert "Could not reach Google Cloud" in message
    assert "Application Default Credentials" not in message
    assert "private network detail" not in message


def test_google_auth_transport_failure_is_reported_as_network_error():
    from google.auth.exceptions import TransportError

    class OfflineSession:
        def request(self, *_args, **_kwargs):
            raise TransportError("private network detail")

    with pytest.raises(gcp_cloud.CloudError) as failure:
        gcp_cloud._Rest(OfflineSession()).request("GET", "https://example.invalid")

    message = str(failure.value)
    assert "Could not reach Google Cloud" in message
    assert "Application Default Credentials" in message
    assert "private network detail" not in message


@pytest.mark.parametrize(("status", "expected"), [
    (401, "gcloud auth application-default login"),
    (403, "Cloud Resource Manager API access"),
])
def test_google_project_listing_auth_and_permission_errors_are_distinct(
        monkeypatch, status, expected):
    class Failure:
        def request(self, *_args, **_kwargs):
            return Response(status, {"error": {"status": "PERMISSION_DENIED",
                                                "message": "private provider detail"}})
        def close(self):
            pass

    monkeypatch.setattr(gcp_cloud, "_rest", lambda: gcp_cloud._Rest(Failure()))

    with pytest.raises(gcp_cloud.CloudError) as failure:
        gcp_cloud.list_subscriptions()

    assert expected in str(failure.value)
    assert "private provider detail" not in str(failure.value)
    if status == 403:
        assert "not missing credentials" in str(failure.value)


def test_unexpected_google_request_defect_is_not_reported_as_unreachable():
    class BrokenSession:
        def request(self, *_args, **_kwargs):
            raise RuntimeError("private internal detail")

    with pytest.raises(gcp_cloud.CloudError) as failure:
        gcp_cloud._Rest(BrokenSession()).request("GET", "https://example.invalid")

    assert "failed unexpectedly" in str(failure.value)
    assert "Could not reach" not in str(failure.value)
    assert "private internal detail" not in str(failure.value)


@pytest.mark.parametrize("config", [
    {**SETTINGS, "region": "us-east1"},
    {**SETTINGS, "machineType": "e2-standard-8"},
    {**SETTINGS, "accelerator": "nvidia-a100"},
    {**SETTINGS, "bucket": "bad bucket"},
    {**SETTINGS, "serviceAccount": "wrong@example.invalid"},
    {**SETTINGS, "rawToken": "hf_not-allowed"},
])
def test_invalid_gcp_configuration_is_rejected(config):
    with pytest.raises(gcp_cloud.CloudError):
        gcp_cloud._config_values(config)


def test_setup_requires_explicit_approval_before_any_cloud_request(monkeypatch):
    monkeypatch.setattr(gcp_cloud, "_rest", lambda: pytest.fail("approval was not granted"))
    with pytest.raises(gcp_cloud.CloudError, match="explicit approval"):
        gcp_cloud.prepare(SETTINGS, consent=False)


def test_prepare_enables_services_private_bucket_and_minimal_service_account_access(monkeypatch):
    fake = _session(monkeypatch)
    _verified(monkeypatch)
    monkeypatch.setattr(gcp_cloud.time, "sleep", lambda _seconds: None)

    result = gcp_cloud.prepare(SETUP_SETTINGS, consent=True)

    assert result["provider"] == "gcp"
    assert result["prepared"] is True
    assert fake.enabled == set(gcp_cloud.REQUIRED_SERVICES)
    assert fake.bucket["iamConfiguration"] == {
        "uniformBucketLevelAccess": {"enabled": True},
        "publicAccessPrevention": "enforced",
    }
    assert fake.bucket_policy["bindings"] == [{
        "role": "roles/storage.objectAdmin",
        "members": [f"serviceAccount:{SERVICE_ACCOUNT}"],
    }]
    assert fake.secret_policies[
        f"projects/{PROJECT}/secrets/{gcp_cloud.WORKER_SECRET_ID}"]["bindings"] == [{
            "role": "roles/secretmanager.secretAccessor",
            "members": [f"serviceAccount:{SERVICE_ACCOUNT}"],
        }]
    assert fake.sa_policy["bindings"] == [{
        "role": "roles/iam.serviceAccountUser",
        "members": ["serviceAccount:service-123456789012@gcp-sa-cloudbatch.iam.gserviceaccount.com"],
    }]
    assert fake.project_policy["bindings"] == [
        {"role": "roles/batch.agentReporter", "members": [f"serviceAccount:{SERVICE_ACCOUNT}"]},
        {"role": "roles/logging.logWriter", "members": [f"serviceAccount:{SERVICE_ACCOUNT}"]},
    ]
    bucket_policy_sets = [
        call for call in fake.calls
        if urllib.parse.urlsplit(call[1]).path == f"/storage/v1/b/{BUCKET}/iam"
        and call[0] != "GET"
    ]
    assert [call[0] for call in bucket_policy_sets] == ["PUT"]
    bucket_policy_reads = [
        call for call in fake.calls
        if urllib.parse.urlsplit(call[1]).path == f"/storage/v1/b/{BUCKET}/iam"
        and call[0] == "GET"
    ]
    assert len(bucket_policy_reads) == 1
    assert urllib.parse.parse_qs(
        urllib.parse.urlsplit(bucket_policy_reads[0][1]).query
    )["optionsRequestedPolicyVersion"] == ["3"]
    secret_policy_reads = [
        call for call in fake.calls
        if urllib.parse.urlsplit(call[1]).path.endswith(":getIamPolicy")
        and urllib.parse.urlsplit(call[1]).netloc == "secretmanager.googleapis.com"
    ]
    assert len(secret_policy_reads) == 1
    assert all(call[0] == "GET" for call in secret_policy_reads)
    assert all(
        urllib.parse.parse_qs(urllib.parse.urlsplit(call[1]).query)
        .get("options.requestedPolicyVersion") == ["3"]
        for call in secret_policy_reads
    )
    project_policy_sets = [
        call for call in fake.calls
        if urllib.parse.urlsplit(call[1]).path.endswith(":setIamPolicy")
        and urllib.parse.urlsplit(call[1]).netloc == "cloudresourcemanager.googleapis.com"
    ]
    assert [call[0] for call in project_policy_sets] == ["POST", "POST"]
    assert "workerAuthResource" not in result["config"]


def test_api_prepare_cloud_wrapper_reuses_provider_setup_tracking(monkeypatch):
    _session(monkeypatch)
    _verified(monkeypatch)
    monkeypatch.setattr(gcp_cloud.time, "sleep", lambda _seconds: None)
    runner = JobRunner(JobStore(), lambda *_args: None)
    try:
        api = Api(runner)
        result = api.prepare_cloud(SETUP_SETTINGS, consent=True, provider="gcp")

        assert result["ok"] is True
        assert result["provider"] == "gcp"
        assert result["prepared"] is True
        assert result["configured"] is False
        progress = api.cloud_setup_progress(provider="gcp")
        assert progress["stage"] == "completed"
        assert progress["total"] == 10
    finally:
        runner.close()


def test_prepare_refuses_an_existing_public_or_wrong_region_bucket(monkeypatch):
    fake = _session(monkeypatch)
    _verified(monkeypatch)
    fake.bucket = {
        "name": BUCKET,
        "location": "us-east1",
        "iamConfiguration": {
            "uniformBucketLevelAccess": {"enabled": False},
            "publicAccessPrevention": "inherited",
        },
    }
    with pytest.raises(gcp_cloud.CloudError, match="did not change"):
        gcp_cloud.prepare(SETUP_SETTINGS, consent=True)
    assert not [call for call in fake.calls if call[0] == "POST" and "/storage/v1/b?" in call[1]]


def test_configure_uses_google_project_and_keeps_per_provider_settings(monkeypatch):
    fake = _session(monkeypatch)
    verified = []
    monkeypatch.setattr(gcp_cloud, "_verified_image", lambda image: (
        verified.append(image) or {
            "image": image, "digest": image.rsplit("@", 1)[1], "sourceHash": SOURCE_HASH,
        }))
    cloud.save_provider_settings("aws", {"profile": "work", "region": "us-east-1"})

    result = gcp_cloud.configure(SETTINGS)

    assert result["provider"] == "gcp"
    assert result["providerName"] == "Google Cloud"
    assert result["config"]["projectId"] == PROJECT
    assert result["config"]["workerSourceHash"] == SOURCE_HASH
    assert verified == [IMAGE]
    assert cloud.load_provider_settings("aws") == {"profile": "work", "region": "us-east-1"}
    assert any("cloudresourcemanager.googleapis.com/v3/projects/" in call[1] for call in fake.calls)


def test_status_config_round_trip_exposes_verified_hash_and_native_secret_reference(monkeypatch):
    _session(monkeypatch)
    _verified(monkeypatch)
    cloud.save_provider_settings("gcp", SETTINGS)

    status = cloud.status(check_connection=False, provider="gcp")
    result = gcp_cloud.configure(status["config"])

    assert status["config"]["workerSourceHash"] == SOURCE_HASH
    assert status["config"]["workerAuthResource"] == SETTINGS["workerAuthResource"]
    assert result["config"]["workerSourceHash"] == SOURCE_HASH
    assert result["config"]["workerAuthResource"] == SETTINGS["workerAuthResource"]


def test_configure_preserves_omitted_native_reference_only_for_same_resources(monkeypatch):
    _session(monkeypatch)
    _verified(monkeypatch)
    cloud.save_provider_settings("gcp", SETTINGS)
    without_reference = {
        key: value for key, value in SETTINGS.items() if key != "workerAuthResource"}

    same = gcp_cloud.configure(without_reference)
    assert same["config"]["workerAuthResource"] == SETTINGS["workerAuthResource"]

    changed = gcp_cloud.configure({**without_reference, "bucket": "mizan-private-other"})
    assert "workerAuthResource" not in changed["config"]
    assert "workerAuthResource" not in cloud.load_provider_settings("gcp")


def test_configure_reverifies_source_hash_when_image_changes(monkeypatch):
    _session(monkeypatch)
    _verified(monkeypatch)
    cloud.save_provider_settings("gcp", {**SETTINGS, "workerSourceHash": "c" * 64})
    new_image = "ghcr.io/mizan/mizan-cloud-worker@sha256:" + "d" * 64
    new_config = {
        key: value for key, value in SETTINGS.items() if key != "workerSourceHash"}
    new_config["image"] = new_image

    result = gcp_cloud.configure(new_config)

    assert result["config"]["image"] == new_image
    assert result["config"]["workerSourceHash"] == SOURCE_HASH
    assert cloud.load_provider_settings("gcp")["workerSourceHash"] == SOURCE_HASH


def test_configure_rejects_image_with_mismatched_source_hash(monkeypatch):
    _session(monkeypatch)
    _verified(monkeypatch)
    previous = cloud.load_provider_settings("gcp")

    with pytest.raises(gcp_cloud.CloudError, match="no longer matches"):
        gcp_cloud.configure({**SETTINGS, "workerSourceHash": "c" * 64})

    assert cloud.load_provider_settings("gcp") == previous


def test_projects_are_listed_without_azure_fields(monkeypatch):
    fake = _session(monkeypatch)
    projects = gcp_cloud.list_subscriptions()
    assert projects == [{
        "projectId": PROJECT,
        "projectName": PROJECT,
        "projectNumber": "123456789012",
        "state": "ACTIVE",
    }]
    assert not any("subscriptionId" in str(item) or "tenantId" in str(item) for item in projects)
    assert fake.calls[0][0] == "GET"
    assert urllib.parse.urlsplit(fake.calls[0][1]).path == "/v3/projects:search"
    assert urllib.parse.parse_qs(urllib.parse.urlsplit(fake.calls[0][1]).query)["pageSize"] == ["1000"]


def test_status_is_read_only_and_reports_verified_image_and_secret_consent(monkeypatch):
    fake = _prepared(monkeypatch)
    _verified(monkeypatch)
    before = len(fake.calls)

    result = gcp_cloud.status(check_connection=True)

    assert result["provider"] == "gcp"
    assert result["verified"] is True
    assert result["prepared"] is True
    assert result["configured"] is False
    assert result["requiresHfTokenConsent"] is True
    assert result["next"] == "transfer_hf_token"
    status_calls = fake.calls[before:]
    batch_writes = [
        call for call in status_calls
        if call[0] in ("POST", "PATCH", "DELETE")
        and urllib.parse.urlsplit(call[1]).netloc == "batch.googleapis.com"
    ]
    assert not batch_writes, batch_writes
    assert not any(
        call[0] == "POST" and call[1].endswith(":enable")
        for call in status_calls)
    assert all(
        method == "GET"
        or (method == "POST" and urllib.parse.urlsplit(url).path.endswith(":getIamPolicy"))
        for method, url, *_ in status_calls)
    assert not any("/versions/latest" in call[1] for call in status_calls)


def test_readiness_does_not_use_an_unpinned_latest_secret_version(monkeypatch):
    fake = _prepared(monkeypatch)
    _verified(monkeypatch)
    fake.secrets["versions"] = [b"not returned to the host"]

    result = gcp_cloud.status(check_connection=True)

    assert result["configured"] is False
    assert result["requiresHfTokenConsent"] is True
    assert result["next"] == "transfer_hf_token"
    assert not any("/versions/" in call[1] for call in fake.calls)


def test_panel_status_generates_request_id_and_keeps_captured_gcp_settings(monkeypatch):
    fake = _prepared(monkeypatch)
    _verified(monkeypatch)
    captured = []

    def run_check(request_id, check_callable):
        captured.append(request_id)
        cloud.select_provider("aws")
        return check_callable(Event())

    monkeypatch.setattr(gcp_cloud._STATE, "panel_status", run_check)
    result = gcp_cloud.panel_status()

    assert captured and captured[0]
    assert result["requestId"] == captured[0]
    assert result["provider"] == "gcp"
    assert result["config"]["projectId"] == PROJECT
    assert result["configured"] is False
    assert result["requiresHfTokenConsent"] is True


def test_panel_status_turns_helper_cancellation_into_full_provider_status(monkeypatch):
    _verified(monkeypatch)
    cloud.save_provider_settings("gcp", SETUP_SETTINGS)
    monkeypatch.setattr(
        gcp_cloud._STATE, "panel_status",
        lambda request_id, _check: {"issue": "The gcp readiness check was cancelled."})

    result = gcp_cloud.panel_status("readiness-1")

    assert result["provider"] == "gcp"
    assert result["requestId"] == "readiness-1"
    assert result["configured"] is False
    assert result["issue"] == "The gcp readiness check was cancelled."
    assert isinstance(result["supportedModels"], list)


def test_finish_without_token_is_read_only_and_requests_consent(monkeypatch):
    fake = _prepared(monkeypatch)
    _verified(monkeypatch)
    cloud.save_provider_settings("gcp", SETUP_SETTINGS)
    before = len(fake.calls)

    result = gcp_cloud.finish(IMAGE)

    writes = [
        call for call in fake.calls[before:]
        if call[0] not in ("GET",)
        and ":getIamPolicy" not in call[1]
    ]
    assert not writes
    assert result["requiresHfTokenConsent"] is True
    assert result["next"] == "transfer_hf_token"
    assert "rawToken" not in json.dumps(result)


def test_finish_transfers_token_only_to_secret_manager_and_persists_reference(monkeypatch):
    fake = _prepared(monkeypatch)
    _verified(monkeypatch)
    cloud.save_provider_settings("gcp", SETTINGS)
    token = "hf_" + "x" * 30

    result = gcp_cloud.finish(IMAGE, hf_token_provider=lambda: token)

    resource = f"projects/{PROJECT}/secrets/{gcp_cloud.WORKER_SECRET_ID}/versions/1"
    assert cloud.load_provider_settings("gcp")["workerAuthResource"] == resource
    assert result["config"]["workerAuthResource"] == resource
    assert result["config"]["workerSourceHash"] == SOURCE_HASH
    assert fake.secrets["versions"] == [token.encode()]
    serialized = json.dumps(result)
    assert token not in serialized
    assert result["jobCreated"] is False
    assert result["configured"] is True
    assert result["requiresHfTokenConsent"] is False
    assert result["mode"] == "local"
    assert result["next"] == "ready"
    creates = [
        call for call in fake.calls
        if call[0] == "POST"
        and urllib.parse.urlsplit(call[1]).netloc == "batch.googleapis.com"
        and "/locations/" in call[1] and "/jobs?" in call[1]
    ]
    assert creates == []


def test_finish_preserves_failed_final_readiness_and_issue(monkeypatch):
    fake = _prepared(monkeypatch)
    _verified(monkeypatch)
    cloud.save_provider_settings("gcp", SETTINGS)
    monkeypatch.setattr(gcp_cloud, "_status_for_settings", lambda *_a, **_kw: {
        "configured": False,
        "requiresHfTokenConsent": False,
        "issue": "Google Cloud denied the final readiness check.",
    })

    result = gcp_cloud.finish(IMAGE, hf_token_provider=lambda: "hf_" + "x" * 30)

    assert result["configured"] is False
    assert result["issue"] == "Google Cloud denied the final readiness check."
    assert result["jobCreated"] is False
    assert result.get("next") != "ready"
    assert fake.secrets["versions"] == [("hf_" + "x" * 30).encode()]


def test_finish_requires_a_previously_imported_image_before_token_transfer(monkeypatch):
    fake = _prepared(monkeypatch)
    _verified(monkeypatch)
    config = {
        key: value for key, value in SETTINGS.items()
        if key not in ("image", "workerSourceHash", "workerAuthResource")}
    cloud.save_provider_settings("gcp", config)

    with pytest.raises(gcp_cloud.CloudError, match="Import and save"):
        gcp_cloud.finish(IMAGE, hf_token_provider=lambda: pytest.fail("token was read"))

    assert fake.secrets["versions"] == []
    assert "image" not in cloud.load_provider_settings("gcp")


def test_image_import_uses_shared_verifier_and_saves_only_gcp(monkeypatch):
    verified = {"image": IMAGE, "digest": IMAGE.rsplit("@", 1)[1], "sourceHash": SOURCE_HASH}
    seen = []
    monkeypatch.setattr(gcp_cloud, "_verified_image", lambda image: seen.append(image) or verified)
    cloud.save_provider_settings("gcp", {key: value for key, value in SETTINGS.items()
                                         if key not in ("image", "workerSourceHash",
                                                        "workerAuthResource", "prepared")})
    cloud.save_provider_settings("aws", {"profile": "work", "region": "us-east-1"})

    result = gcp_cloud.import_cloud_image(IMAGE)

    assert seen == [IMAGE]
    assert result["image"] == IMAGE
    assert result["digest"] == verified["digest"]
    assert result["provider"] == "gcp"
    assert result["verified"] is True
    assert cloud.load_provider_settings("gcp")["workerSourceHash"] == SOURCE_HASH
    assert cloud.load_provider_settings("aws") == {"profile": "work", "region": "us-east-1"}


def test_build_image_never_builds_or_publishes():
    cloud.save_provider_settings("gcp", {
        key: value for key, value in SETTINGS.items()
        if key not in ("prepared", "workerAuthResource", "image", "workerSourceHash")
    })
    with pytest.raises(gcp_cloud.CloudError, match="does not build or publish"):
        gcp_cloud.build_cloud_image()


def test_batch_job_has_secret_reference_gpu_driver_and_model_resources(monkeypatch):
    _verified(monkeypatch)
    payload = gcp_cloud._batch_job(
        SETTINGS, "muscriptor-medium", "jobs/run/input.wav", "jobs/run/result.json", "mizan-run")

    task = payload["taskGroups"][0]["taskSpec"]
    runnable = task["runnables"][0]
    assert runnable["container"]["commands"] == [
        "jobs/run/input.wav", "jobs/run/result.json", "muscriptor-medium"]
    assert runnable["environment"]["variables"] == {
        "CLOUD_STORAGE_PROVIDER": "gcp",
        "GCS_BUCKET": BUCKET,
        "GOOGLE_CLOUD_PROJECT": PROJECT,
    }
    assert runnable["environment"]["secretVariables"]["HF_TOKEN"] == SETTINGS["workerAuthResource"]
    assert SETTINGS["workerAuthResource"] not in json.dumps(task["runnables"][0]["environment"]["variables"])
    assert task["computeResource"]["cpuMilli"] == 4000
    assert task["computeResource"]["memoryMib"] == 16384
    assert task["maxRunDuration"] == "7200s"
    assert task["maxRetryCount"] == 0
    instance = payload["allocationPolicy"]["instances"][0]
    policy = instance["policy"]
    assert policy["machineType"] == "g2-standard-8"
    assert policy["accelerators"] == [{"type": "nvidia-l4", "count": 1}]
    assert instance["installGpuDrivers"] is True
    assert "installGpuDrivers" not in policy
    assert payload["allocationPolicy"]["serviceAccount"] == {"email": SERVICE_ACCOUNT}


def test_full_batch_job_upload_poll_download_and_validate_all_six_stems(monkeypatch, tmp_path):
    fake = _prepared(monkeypatch)
    _verified(monkeypatch)
    monkeypatch.setattr(gcp_cloud.time, "sleep", lambda _seconds: None)
    cloud.save_provider_settings("gcp", SETTINGS)
    recording = tmp_path / "input.wav"
    recording.write_bytes(_audio_bytes())
    reports = []

    result, names = gcp_cloud.offload(
        recording, tmp_path, "muscriptor-small", Event(), lambda *args, **kwargs: reports.append(
            (args, kwargs)))

    assert result["separation"]["method"] == "htdemucs-6s-onnx"
    assert names[0] in fake.objects
    assert names[-1] in fake.objects
    assert [name.rsplit("/", 1)[-1] for name in names[2:]] == [
        "drums.wav", "bass.wav", "other.wav", "vocals.wav", "guitar.wav", "piano.wav"]
    callback = next(kwargs["cloud_job"] for _, kwargs in reports if kwargs.get("cloud_job"))
    assert callback["provider"] == "gcp"
    assert callback["id"].endswith(f"/jobs/{callback['id'].rsplit('/', 1)[-1]}")
    assert callback["prefix"] == names[0].removesuffix("/input.wav")
    upload_calls = [
        call for call in fake.calls
        if call[0] == "POST"
        and urllib.parse.urlsplit(call[1]).netloc == "storage.googleapis.com"
        and urllib.parse.urlsplit(call[1]).path.startswith("/upload/storage/v1/")
    ]
    assert len(upload_calls) == 1
    upload_url = urllib.parse.urlsplit(upload_calls[0][1])
    assert upload_url.path == f"/upload/storage/v1/b/{BUCKET}/o"
    upload_query = urllib.parse.parse_qs(upload_url.query)
    assert upload_query["uploadType"] == ["media"]
    assert upload_query["name"] == [names[0]]
    assert upload_query["ifGenerationMatch"] == ["0"]
    batch_body = next(body for method, url, _json, body in fake.calls
                      if method == "POST"
                      and urllib.parse.urlsplit(url).netloc == "batch.googleapis.com"
                      and "/locations/" in url and "/jobs?" in url)
    serialized_job = json.dumps(batch_body)
    assert "hf_" not in serialized_job
    assert SETTINGS["workerAuthResource"] in serialized_job
    assert gcp_cloud.MAX_AUDIO_BYTES == 250 * 1024 * 1024


def test_unknown_batch_submission_is_not_retried_and_keeps_files(monkeypatch, tmp_path):
    fake = _prepared(monkeypatch)
    _verified(monkeypatch)
    cloud.save_provider_settings("gcp", SETTINGS)
    fake.create_failure = TimeoutError("simulated")
    recording = tmp_path / "input.wav"
    recording.write_bytes(_audio_bytes())

    with pytest.raises(gcp_cloud.CloudError, match="outcome is unknown"):
        gcp_cloud.offload(recording, tmp_path, "muscriptor-small", Event(), lambda *_a, **_kw: None)

    creates = [
        call for call in fake.calls
        if call[0] == "POST"
        and urllib.parse.urlsplit(call[1]).netloc == "batch.googleapis.com"
        and "/locations/" in call[1] and "/jobs?" in call[1]
    ]
    assert len(creates) == 1
    assert any(name.endswith("/input.wav") for name in fake.objects)
    assert not any(
        call[0] == "DELETE" and urllib.parse.urlsplit(call[1]).netloc == "batch.googleapis.com"
        for call in fake.calls)


def test_rejected_batch_submission_is_not_retried_and_cleans_input(monkeypatch, tmp_path):
    fake = _prepared(monkeypatch)
    _verified(monkeypatch)
    cloud.save_provider_settings("gcp", SETTINGS)
    fake.create_status = 400
    recording = tmp_path / "input.wav"
    recording.write_bytes(_audio_bytes())

    with pytest.raises(gcp_cloud.CloudError, match="rejected the request"):
        gcp_cloud.offload(
            recording, tmp_path, "muscriptor-small", Event(), lambda *_a, **_kw: None)

    creates = [
        call for call in fake.calls
        if call[0] == "POST"
        and urllib.parse.urlsplit(call[1]).netloc == "batch.googleapis.com"
        and "/locations/" in call[1] and "/jobs?" in call[1]
    ]
    assert len(creates) == 1
    assert fake.objects == {}


def test_job_timeout_stops_confirmed_job_before_cleanup(monkeypatch, tmp_path):
    fake = _prepared(monkeypatch)
    fake.job_states = ["RUNNING"]
    _verified(monkeypatch)
    cloud.save_provider_settings("gcp", SETTINGS)
    monkeypatch.setattr(gcp_cloud, "POLL_INTERVAL", 0.001)
    monkeypatch.setattr(gcp_cloud, "JOB_TIMEOUT", 0.01)
    monkeypatch.setattr(gcp_cloud, "CANCEL_TIMEOUT", 0.01)
    monkeypatch.setattr(gcp_cloud.time, "sleep", lambda _seconds: None)
    recording = tmp_path / "input.wav"
    recording.write_bytes(_audio_bytes())

    with pytest.raises(gcp_cloud.CloudError) as failure:
        gcp_cloud.offload(
            recording, tmp_path, "muscriptor-small", Event(), lambda *_a, **_kw: None)

    assert "job was stopped" in str(failure.value), {
        "calls": fake.calls[-12:], "jobs": fake.jobs,
        "batch_deletes": fake.batch_delete_count,
        "delete_done": fake.delete_operation_done,
    }
    assert fake.batch_delete_count == 1
    assert fake.objects == {}


def test_callback_cancellation_stops_known_job_before_cleanup(monkeypatch, tmp_path):
    fake = _prepared(monkeypatch)
    _verified(monkeypatch)
    cloud.save_provider_settings("gcp", SETTINGS)
    recording = tmp_path / "input.wav"
    recording.write_bytes(_audio_bytes())
    remote = []

    def report(_stage, _progress, **kwargs):
        if kwargs.get("cloud_job"):
            remote.append(kwargs["cloud_job"])
            raise gcp_cloud.Cancelled()

    with pytest.raises(gcp_cloud.Cancelled):
        gcp_cloud.offload(recording, tmp_path, "muscriptor-small", Event(), report)

    assert len(remote) == 1
    assert fake.batch_delete_count == 1
    assert fake.objects == {}


def test_unknown_cancel_keeps_uploaded_files(monkeypatch, tmp_path):
    fake = _prepared(monkeypatch)
    fake.job_states = ["RUNNING"]
    fake.job_status = "RUNNING"
    fake.delete_operation_done = False
    _verified(monkeypatch)
    cloud.save_provider_settings("gcp", SETTINGS)
    monkeypatch.setattr(gcp_cloud, "POLL_INTERVAL", 0.001)
    monkeypatch.setattr(gcp_cloud, "JOB_TIMEOUT", 0.01)
    monkeypatch.setattr(gcp_cloud, "CANCEL_TIMEOUT", 0.01)
    monkeypatch.setattr(gcp_cloud.time, "sleep", lambda _seconds: None)
    recording = tmp_path / "input.wav"
    recording.write_bytes(_audio_bytes())

    with pytest.raises(gcp_cloud.CloudError, match="stop could not be confirmed"):
        gcp_cloud.offload(
            recording, tmp_path, "muscriptor-small", Event(), lambda *_a, **_kw: None)

    assert fake.batch_delete_count >= 1
    assert any(name.endswith("/input.wav") for name in fake.objects)


def test_failed_job_status_read_does_not_confirm_stop_or_cleanup(monkeypatch, tmp_path):
    fake = _prepared(monkeypatch)
    fake.job_states = ["RUNNING"]
    fake.job_status = "RUNNING"
    fake.job_get_error_after_delete = 403
    _verified(monkeypatch)
    cloud.save_provider_settings("gcp", SETTINGS)
    monkeypatch.setattr(gcp_cloud, "POLL_INTERVAL", 0.001)
    monkeypatch.setattr(gcp_cloud, "JOB_TIMEOUT", 0.01)
    monkeypatch.setattr(gcp_cloud, "CANCEL_TIMEOUT", 0.01)
    monkeypatch.setattr(gcp_cloud.time, "sleep", lambda _seconds: None)
    recording = tmp_path / "input.wav"
    recording.write_bytes(_audio_bytes())

    with pytest.raises(gcp_cloud.CloudError, match="stop could not be confirmed"):
        gcp_cloud.offload(
            recording, tmp_path, "muscriptor-small", Event(), lambda *_a, **_kw: None)

    assert fake.batch_delete_count >= 1
    assert any(name.endswith("/input.wav") for name in fake.objects)


def test_confirmed_missing_job_404_confirms_it_is_not_running(monkeypatch):
    fake = _session(monkeypatch)
    rest = gcp_cloud._Rest(fake)

    assert gcp_cloud._cancel_job(
        rest, SETTINGS, "mizan-job-not-found", timeout=0.01) is True


def test_set_mode_requires_configured_not_only_prepared(monkeypatch):
    monkeypatch.setattr(gcp_cloud, "status", lambda **_kwargs: {
        "prepared": True,
        "workerImage": IMAGE,
        "configured": False,
        "issue": "The pinned worker secret is not ready.",
    })
    monkeypatch.setattr(gcp_cloud, "_set_mode", lambda *_args: pytest.fail("mode changed"))

    with pytest.raises(gcp_cloud.CloudError, match="pinned worker secret"):
        gcp_cloud.set_mode("cloud")


def test_cleanup_uses_pinned_target_after_active_provider_changes(monkeypatch):
    fake = _session(monkeypatch)
    cloud.select_provider("aws")
    prefix = "jobs/11111111-1111-1111-1111-111111111111"
    names = gcp_cloud._job_names(prefix)
    fake.bucket = {
        "name": BUCKET,
        "location": REGION,
        "iamConfiguration": {
            "uniformBucketLevelAccess": {"enabled": True},
            "publicAccessPrevention": "enforced",
        },
    }
    fake.objects.update({name: b"test" for name in names})
    target = {"version": 1, "provider": "gcp", "settings": SETTINGS}

    gcp_cloud.cleanup(names, target=target)

    assert fake.objects == {}
    assert all(BUCKET in call[1] for call in fake.calls if call[0] == "DELETE")


@pytest.mark.parametrize(("status", "text"), [
    (403, "denied the request"),
    (429, "quota or capacity"),
])
def test_google_api_errors_are_useful_and_do_not_echo_provider_body(monkeypatch, status, text):
    class Failure:
        def request(self, *_args, **_kwargs):
            return Response(status, {"error": {"status": "RESOURCE_EXHAUSTED",
                                               "message": "secret hf_private-data"}})

        def close(self):
            pass

    with pytest.raises(gcp_cloud.CloudError) as error:
        gcp_cloud._Rest(Failure()).request("GET", "https://batch.googleapis.com/v1/test")

    assert text in str(error.value)
    assert "hf_private-data" not in str(error.value)
