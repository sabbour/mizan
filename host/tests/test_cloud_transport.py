from threading import Event
from io import BytesIO
import http.client
import json
import logging
import socket
import ssl
import urllib.error

import pytest

from mizan.cloud_transport import (MAX_ARM_ERROR_BYTES, CloudTransport,
                                   CloudTransportError)
from mizan.cloud_auth import AzureSignInError
from mizan.errors import Cancelled

CONFIG = {
    "tenantId": "11111111-1111-1111-1111-111111111111",
    "subscriptionId": "33333333-3333-3333-3333-333333333333",
    "resourceGroup": "rg-mizan", "storageAccount": "mizanblob",
    "container": "jobs", "jobName": "mizan-gpu-transcribe",
}


def job_template():
    return {"properties": {"template": {"containers": [{
        "name": "gpu", "image": "private.azurecr.io/mizan@sha256:test",
        "resources": {"cpu": 2, "memory": "8Gi"},
        "env": [
            {"name": "HF_TOKEN", "secretRef": "hf-token"},
            {"name": "AZURE_CLIENT_ID", "value": "identity-client"},
            {"name": "AZURE_STORAGE_CONTAINER", "value": "jobs"},
            {"name": "AZURE_STORAGE_BLOB_URL", "value": "https://mizanblob.blob.core.windows.net"},
        ],
    }]}}}


def test_transport_requests_current_user_arm_and_storage_tokens(monkeypatch):
    from mizan import cloud_transport
    calls = []
    monkeypatch.setattr(cloud_transport, "token",
                        lambda scope, tenant, expected_oid: calls.append(
                            (scope, tenant, expected_oid)) or "user-token")
    transport = CloudTransport({**CONFIG, "userObjectId": "dddddddd-dddd-dddd-dddd-dddddddddddd"})
    assert transport._token("https://management.azure.com/.default") == "user-token"
    assert transport._token("https://storage.azure.com/.default") == "user-token"
    assert calls == [
        ("https://management.azure.com/.default", CONFIG["tenantId"],
         "dddddddd-dddd-dddd-dddd-dddddddddddd"),
        ("https://storage.azure.com/.default", CONFIG["tenantId"],
         "dddddddd-dddd-dddd-dddd-dddddddddddd"),
    ]
    monkeypatch.setattr(cloud_transport, "token",
                        lambda *args: (_ for _ in ()).throw(AzureSignInError("Sign in again.")))
    with pytest.raises(CloudTransportError, match="Sign in again"):
        transport._token("https://storage.azure.com/.default")


def test_transport_attaches_user_bearer_only_to_azure_url(monkeypatch):
    from mizan import cloud_transport
    class Opener:
        def open(self, request, timeout):
            assert request.get_header("Authorization") == "Bearer user-token"
            assert request.full_url.startswith("https://mizanblob.blob.core.windows.net/")
            return BytesIO(b"")
    monkeypatch.setattr(cloud_transport, "token", lambda *args: "user-token")
    monkeypatch.setattr(cloud_transport.urllib.request, "build_opener", lambda *args: Opener())
    with CloudTransport(CONFIG)._open(
            "https://mizanblob.blob.core.windows.net/jobs/jobs/test",
            scope="https://storage.azure.com/.default") as response:
        assert response.read() == b""


def test_http_failure_logs_request_id_without_bearer_token(monkeypatch, caplog):
    from mizan import cloud_transport

    secret = "test-access-token-never-log"

    class Opener:
        def open(self, request, timeout):
            assert request.get_header("Authorization") == f"Bearer {secret}"
            raise cloud_transport.urllib.error.HTTPError(
                request.full_url, 403, "Forbidden",
                {"x-ms-request-id": "request-123"}, BytesIO(),
            )

    monkeypatch.setattr(cloud_transport, "token", lambda *args: secret)
    monkeypatch.setattr(cloud_transport.urllib.request, "build_opener", lambda *args: Opener())
    with caplog.at_level(logging.WARNING, logger="mizan.cloud_transport"):
        with pytest.raises(CloudTransportError, match="HTTP 403"):
            CloudTransport(CONFIG)._open(
                "https://mizanblob.blob.core.windows.net/jobs/test",
                scope="https://storage.azure.com/.default",
            )

    assert "request_id=request-123" in caplog.text
    assert secret not in caplog.text


def test_http_failure_surfaces_sanitized_provider_details_without_replaying_post(
        monkeypatch, caplog):
    from mizan import cloud_transport

    token = "hf_abcdefghijklmnopqrstuvwxyz"
    message = (f"Unknown properties volumes are not supported; Bearer private-token "
               f"{token} https://storage.example/?sig=private-signature")
    calls = []

    class Opener:
        def open(self, request, timeout):
            calls.append(request.get_method())
            raise cloud_transport.urllib.error.HTTPError(
                request.full_url, 400, "Bad Request",
                {"x-ms-request-id": "request-400"},
                BytesIO(json.dumps({"error": {
                    "code": "BadRequest", "message": message,
                }}).encode()),
            )

    monkeypatch.setattr(cloud_transport, "token", lambda *args: "unused-token")
    monkeypatch.setattr(cloud_transport.urllib.request, "build_opener", lambda *args: Opener())
    with caplog.at_level(logging.WARNING, logger="mizan.cloud_transport"):
        with pytest.raises(CloudTransportError) as raised:
            CloudTransport(CONFIG)._open(
                "https://management.azure.com/subscriptions/test/jobs/test/start",
                scope="https://management.azure.com/.default", method="POST", data=b"{}")

    assert "HTTP 400" in str(raised.value)
    assert "BadRequest" in str(raised.value)
    assert "Unknown properties volumes" in str(raised.value)
    assert token not in str(raised.value)
    assert "private-token" not in str(raised.value)
    assert "private-signature" not in str(raised.value)
    assert "request_id=request-400" in caplog.text
    assert "BadRequest" in caplog.text
    assert "private-token" not in caplog.text
    assert calls == ["POST"]


def test_http_failure_redacts_bearer_credentials_from_provider_message(monkeypatch):
    from mizan import cloud_transport

    message = "Provider rejected the request: " + "Bear" + "er private-token"

    class Opener:
        def open(self, request, timeout):
            raise cloud_transport.urllib.error.HTTPError(
                request.full_url, 400, "Bad Request", {},
                BytesIO(json.dumps({"error": {"message": message}}).encode()),
            )

    monkeypatch.setattr(cloud_transport, "token", lambda *args: "unused-token")
    monkeypatch.setattr(cloud_transport.urllib.request, "build_opener", lambda *args: Opener())
    with pytest.raises(CloudTransportError) as raised:
        CloudTransport(CONFIG)._open(
            "https://management.azure.com/subscriptions/test/jobs/test/start",
            scope="https://management.azure.com/.default", method="POST", data=b"{}")

    assert "Provider rejected the request" in str(raised.value)
    assert "private-token" not in str(raised.value)


@pytest.mark.parametrize(("body", "read_failure", "expected"), [
    (b"{invalid json", False, "malformed error details"),
    (b"x" * (MAX_ARM_ERROR_BYTES + 1), False, "exceeded the size limit"),
    (b"", OSError, "details could not be read"),
    (b"", http.client.IncompleteRead, "details could not be read"),
])
def test_http_failure_reports_unavailable_provider_details_explicitly(
        monkeypatch, body, read_failure, expected):
    from mizan import cloud_transport

    class ErrorBody(BytesIO):
        def read(self, size=-1):
            if read_failure:
                if read_failure is http.client.IncompleteRead:
                    raise read_failure(b"partial-provider-body")
                raise read_failure("raw provider body must not be surfaced")
            self.requested = size
            return super().read(size)

    response_body = ErrorBody(body)

    class Opener:
        def open(self, request, timeout):
            raise cloud_transport.urllib.error.HTTPError(
                request.full_url, 400, "Bad Request",
                {"x-ms-request-id": "request-400"}, response_body,
            )

    monkeypatch.setattr(cloud_transport, "token", lambda *args: "unused-token")
    monkeypatch.setattr(cloud_transport.urllib.request, "build_opener", lambda *args: Opener())
    with pytest.raises(CloudTransportError) as raised:
        CloudTransport(CONFIG)._open(
            "https://management.azure.com/subscriptions/test/jobs/test/start",
            scope="https://management.azure.com/.default", method="POST", data=b"{}")

    assert "HTTP 400" in str(raised.value)
    assert expected in str(raised.value)
    assert "raw provider body" not in str(raised.value)
    assert "partial-provider-body" not in str(raised.value)
    if not read_failure:
        assert response_body.requested == MAX_ARM_ERROR_BYTES + 1


def test_http_404_remains_not_found_without_reading_provider_body(monkeypatch):
    from mizan import cloud_transport

    class ErrorBody(BytesIO):
        def read(self, size=-1):
            pytest.fail("A 404 response body should not be read.")

    class Opener:
        def open(self, request, timeout):
            raise cloud_transport.urllib.error.HTTPError(
                request.full_url, 404, "Not Found", {}, ErrorBody(b"{}"),
            )

    monkeypatch.setattr(cloud_transport, "token", lambda *args: "unused-token")
    monkeypatch.setattr(cloud_transport.urllib.request, "build_opener", lambda *args: Opener())
    with pytest.raises(FileNotFoundError, match="Azure resource not found"):
        CloudTransport(CONFIG)._open(
            "https://management.azure.com/subscriptions/test/jobs/test",
            scope="https://management.azure.com/.default",
        )


@pytest.mark.parametrize("volumes", [
    [],
    [{"name": "cache", "storageType": "EmptyDir"}],
])
@pytest.mark.parametrize(("model", "resources"), [
    ("muscriptor-small", {"cpu": 2, "memory": "8Gi"}),
    ("muscriptor-medium", {"cpu": 4, "memory": "16Gi"}),
    ("muscriptor-large", {"cpu": 8, "memory": "32Gi"}),
])
def test_job_uses_per_execution_model_budget_and_preserves_template(
        monkeypatch, tmp_path, model, resources, volumes):
    transport = CloudTransport(CONFIG)
    original = job_template()
    template = original["properties"]["template"]
    template["containers"][0]["resources"]["ephemeralStorage"] = "20Gi"
    template["initContainers"] = [{
        "name": "prepare", "image": "helper:latest", "args": ["keep"],
        "command": ["/prepare"], "env": [{"name": "PREPARE", "value": "yes"}],
        "resources": {"cpu": 0.25, "memory": "1Gi", "ephemeralStorage": "2Gi"},
        "volumeMounts": [{"name": "cache", "mountPath": "/cache"}],
    }]
    template["volumes"] = volumes
    template["scale"] = {"minExecutions": 0, "maxExecutions": 1, "rules": []}
    template["jobOnlyField"] = "not-for-start"
    template["containers"][0]["command"] = ["/worker"]
    template["containers"][0]["volumeMounts"] = [{"name": "cache", "mountPath": "/cache"}]
    template["containers"][0]["probes"] = [{"type": "Liveness"}]
    template["containers"].append({
        "name": "sidecar", "image": "sidecar:latest", "args": ["unchanged"],
        "resources": {"cpu": 0.25, "memory": "1Gi", "ephemeralStorage": "2Gi"},
        "env": [{"name": "SIDE", "value": "car"}],
        "volumeMounts": [{"name": "cache", "mountPath": "/cache"}],
    })
    before = json.loads(json.dumps(original))
    calls = []
    reports = []

    def put(name, path, **kwargs):
        assert reports[-1] == ("detect", 0, "Uploading prepared audio")
        calls.append(("upload", name))

    monkeypatch.setattr(transport, "_put", put)
    monkeypatch.setattr(transport, "_get",
                        lambda name, path, *, limit, **kwargs:
                        path.write_text(json.dumps({"model": model})))

    def arm(suffix="", *, method="GET", payload=None, **kwargs):
        if not suffix:
            assert reports[-1] == ("detect", 0, "Checking Azure GPU Job")
        elif suffix == "/start":
            assert reports[-1] == ("detect", 0, "Starting Azure GPU Job")
        elif suffix.startswith("/executions/"):
            assert reports[-1] == ("detect", 0, "Waiting for Azure GPU Job")
        calls.append((method, suffix, payload))
        if suffix == "":
            return original, None
        if suffix == "/start":
            return {"name": "gpu-abcd1234"}, None
        return {"properties": {"status": "Succeeded"}}, None

    monkeypatch.setattr(transport, "_arm", arm)
    result, names = transport.run(tmp_path / "source.wav", tmp_path, model, Event(),
                                  lambda stage, progress, **kwargs:
                                  reports.append((stage, progress, kwargs.get("message"))))
    assert result == {"model": model}
    assert len(names) == 8 and names[0].endswith("/input.wav")
    started = next(call for call in calls if call[1] == "/start")

    def start_container(container):
        projected = {name: value for name, value in container.items()
                     if name in ("args", "command", "env", "image", "name", "resources")}
        if isinstance(projected.get("resources"), dict):
            projected["resources"] = {name: projected["resources"][name]
                                      for name in ("cpu", "memory")
                                      if name in projected["resources"]}
        return projected

    expected = {
        field: [start_container(container)
                for container in before["properties"]["template"][field]]
        for field in ("containers", "initContainers")
        if field in before["properties"]["template"]
    }
    expected["containers"][0]["args"] = [names[0], names[1], model]
    expected["containers"][0]["resources"] = resources
    assert started[2] == expected
    assert set(started[2]) == {"containers", "initContainers"}
    assert started[2]["containers"][0]["args"] == [names[0], names[1], model]
    assert started[2]["containers"][0]["env"][0] == {"name": "HF_TOKEN", "secretRef": "hf-token"}
    assert started[2]["containers"][0]["env"][1] == {
        "name": "AZURE_CLIENT_ID", "value": "identity-client",
    }
    assert started[2]["containers"][0]["command"] == ["/worker"]
    assert started[2]["containers"][1]["args"] == ["unchanged"]
    assert started[2]["initContainers"][0]["command"] == ["/prepare"]
    assert started[2]["initContainers"][0]["env"] == [{"name": "PREPARE", "value": "yes"}]
    assert started[2]["initContainers"][0]["resources"] == {"cpu": 0.25, "memory": "1Gi"}
    assert all("ephemeralStorage" not in container.get("resources", {})
               for field in ("containers", "initContainers")
               for container in started[2][field])
    assert original == before
    assert [message for stage, _, message in reports if stage == "detect"][:5] == [
        "Connecting to Azure GPU processing", "Uploading prepared audio",
        "Checking Azure GPU Job", "Starting Azure GPU Job", "Waiting for Azure GPU Job"]
    assert all(progress == 0 for stage, progress, _ in reports if stage == "detect")


def test_large_execution_budget_never_reduces_existing_resources(monkeypatch, tmp_path):
    from mizan.cloud_transport import _execution_template

    template = job_template()
    container = template["properties"]["template"]["containers"][0]
    container["resources"] = {"cpu": 12, "memory": "64Gi", "ephemeralStorage": "20Gi"}
    original = json.loads(json.dumps(template))
    execution = _execution_template(template, "muscriptor-large", "input.wav", "result.json", CONFIG)
    worker = execution["containers"][0]
    assert worker["resources"] == {"cpu": 12, "memory": "64Gi"}
    assert template == original


@pytest.mark.parametrize(("current", "expected"), [
    ({"cpu": 12, "memory": "8Gi"}, {"cpu": 12, "memory": "32Gi"}),
    ({"cpu": 2, "memory": "64Gi"}, {"cpu": 8, "memory": "64Gi"}),
])
def test_execution_budget_uses_componentwise_max(current, expected):
    from mizan.cloud_transport import _execution_resources

    assert _execution_resources("muscriptor-large", current) == expected


def test_unknown_model_fails_before_upload_or_job_start(monkeypatch, tmp_path):
    transport = CloudTransport(CONFIG)
    monkeypatch.setattr(transport, "_put", lambda *args, **kwargs:
                        pytest.fail("Unknown model must fail before upload"))
    monkeypatch.setattr(transport, "_arm", lambda *args, **kwargs:
                        pytest.fail("Unknown model must fail before Job start"))
    with pytest.raises(CloudTransportError, match="size is not supported"):
        transport.run(tmp_path / "source.wav", tmp_path, "muscriptor-next", Event(),
                      lambda *args, **kwargs: None)


@pytest.mark.parametrize(("cpu", "memory", "message"), [
    (0, "8Gi", "CPU"),
    (2, "512Mi", "memory"),
])
def test_invalid_job_resources_fail_before_start_and_clean_uploads(
        monkeypatch, tmp_path, cpu, memory, message):
    transport = CloudTransport(CONFIG)
    template = job_template()
    template["properties"]["template"]["containers"][0]["resources"] = {
        "cpu": cpu, "memory": memory,
    }
    deleted = []
    arm_calls = []
    monkeypatch.setattr(transport, "_put", lambda *args, **kwargs: None)
    monkeypatch.setattr(transport, "delete", lambda names: deleted.append(names))

    def arm(suffix="", **kwargs):
        arm_calls.append(suffix)
        return template, None

    monkeypatch.setattr(transport, "_arm", arm)
    with pytest.raises(CloudTransportError, match=message):
        transport.run(tmp_path / "source.wav", tmp_path, "muscriptor-large", Event(),
                      lambda *args, **kwargs: None)
    assert "/start" not in arm_calls
    assert len(deleted) == 1 and len(deleted[0]) == 8


def test_open_retries_transient_tls_timeout_then_succeeds(monkeypatch):
    from mizan import cloud_transport
    transport = CloudTransport(CONFIG)
    cancelled = Event()
    waits, calls = [], []
    monkeypatch.setattr(cancelled, "wait", lambda seconds: waits.append(seconds) or False)
    monkeypatch.setattr(cloud_transport, "token", lambda *args: "user-token")

    class Opener:
        def open(self, request, timeout):
            calls.append(timeout)
            if len(calls) == 1:
                raise urllib.error.URLError(ssl.SSLError("TLS handshake timed out"))
            return BytesIO(b"ok")

    monkeypatch.setattr(cloud_transport.urllib.request, "build_opener",
                        lambda *args: Opener())
    with transport._open(
            "https://management.azure.com/subscriptions/test/jobs/test",
            scope="https://management.azure.com/.default",
            cancelled=cancelled) as response:
        assert response.read() == b"ok"
    assert len(calls) == 2
    assert all(0 < timeout <= 30 for timeout in calls)
    assert waits == [1]


def test_open_retry_exhaustion_is_bounded_and_sanitized(monkeypatch, caplog):
    from mizan import cloud_transport
    cancelled = Event()
    waits, calls = [], []
    monkeypatch.setattr(cancelled, "wait", lambda seconds: waits.append(seconds) or False)
    monkeypatch.setattr(cloud_transport, "token", lambda *args: "bearer-never-log")

    class Opener:
        def open(self, request, timeout):
            calls.append(timeout)
            raise urllib.error.URLError(TimeoutError(
                "timed out https://private.test/?sig=secret Bearer hidden-token"))

    monkeypatch.setattr(cloud_transport.urllib.request, "build_opener",
                        lambda *args: Opener())
    with caplog.at_level(logging.WARNING, logger="mizan.cloud_transport"):
        with pytest.raises(CloudTransportError, match="after 3 attempt.*connectivity"):
            CloudTransport(CONFIG)._open(
                "https://management.azure.com/subscriptions/test/jobs/test",
                scope="https://management.azure.com/.default", cancelled=cancelled)
    assert len(calls) == 3
    assert waits == [1, 2]
    assert "private.test" not in caplog.text
    assert "secret" not in caplog.text
    assert "bearer-never-log" not in caplog.text


def test_open_retry_deadline_bounds_socket_timeout_and_backoff(monkeypatch):
    from mizan import cloud_transport
    cancelled = Event()
    clock, calls, waits = [0.0], [], []
    monkeypatch.setattr(cloud_transport, "ARM_REQUEST_TIMEOUT", 3)
    monkeypatch.setattr(cloud_transport, "ARM_SOCKET_TIMEOUT", 30)
    monkeypatch.setattr(cloud_transport.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(cancelled, "wait",
                        lambda delay: (waits.append(delay), clock.__setitem__(0, clock[0] + delay), False)[-1])
    monkeypatch.setattr(cloud_transport, "token", lambda *args: "user-token")

    class Opener:
        def open(self, request, timeout):
            calls.append(timeout)
            clock[0] += 1
            raise urllib.error.URLError(TimeoutError("timed out"))

    monkeypatch.setattr(cloud_transport.urllib.request, "build_opener",
                        lambda *args: Opener())
    with pytest.raises(CloudTransportError, match="after 2 attempt"):
        CloudTransport(CONFIG)._open(
            "https://management.azure.com/subscriptions/test/jobs/test",
            scope="https://management.azure.com/.default", cancelled=cancelled)
    assert calls == [3, 1]
    assert waits == [1]


def test_open_retry_cancellation_stops_before_another_attempt(monkeypatch):
    from mizan import cloud_transport
    transport = CloudTransport(CONFIG)
    cancelled = Event()
    calls = []
    monkeypatch.setattr(cloud_transport, "token", lambda *args: "user-token")

    def cancel_during_wait(_seconds):
        cancelled.set()
        return True

    monkeypatch.setattr(cancelled, "wait", cancel_during_wait)

    class Opener:
        def open(self, request, timeout):
            calls.append(request.get_method())
            raise urllib.error.URLError(TimeoutError("timed out"))

    monkeypatch.setattr(cloud_transport.urllib.request, "build_opener",
                        lambda *args: Opener())
    with pytest.raises(Cancelled):
        transport._open(
            "https://management.azure.com/subscriptions/test/jobs/test",
            scope="https://management.azure.com/.default", cancelled=cancelled)
    assert calls == ["GET"]


@pytest.mark.parametrize("method,data", [
    ("POST", b"{}"), ("PUT", b"audio"), ("DELETE", None),
])
def test_open_never_replays_writes_on_timeout(monkeypatch, method, data):
    from mizan import cloud_transport
    calls = []
    monkeypatch.setattr(cloud_transport, "token", lambda *args: "user-token")

    class Opener:
        def open(self, request, timeout):
            calls.append(request.get_method())
            raise urllib.error.URLError(TimeoutError("timed out"))

    monkeypatch.setattr(cloud_transport.urllib.request, "build_opener",
                        lambda *args: Opener())
    with pytest.raises(CloudTransportError):
        CloudTransport(CONFIG)._open(
            "https://management.azure.com/subscriptions/test/jobs/test",
            scope="https://management.azure.com/.default", method=method, data=data)
    assert calls == [method]


def test_open_does_not_retry_certificate_errors(monkeypatch):
    from mizan import cloud_transport
    calls = []
    monkeypatch.setattr(cloud_transport, "token", lambda *args: "user-token")

    class Opener:
        def open(self, request, timeout):
            calls.append(1)
            raise urllib.error.URLError(ssl.SSLCertVerificationError("certificate verify failed"))

    monkeypatch.setattr(cloud_transport.urllib.request, "build_opener",
                        lambda *args: Opener())
    with pytest.raises(CloudTransportError, match="TLS"):
        CloudTransport(CONFIG)._open(
            "https://management.azure.com/subscriptions/test/jobs/test",
            scope="https://management.azure.com/.default")
    assert calls == [1]


def test_open_retries_temporary_dns_errors(monkeypatch):
    from mizan import cloud_transport
    calls, waits = [], []
    cancelled = Event()
    monkeypatch.setattr(cancelled, "wait", lambda seconds: waits.append(seconds) or False)
    monkeypatch.setattr(cloud_transport, "token", lambda *args: "user-token")

    class Opener:
        def open(self, request, timeout):
            calls.append(1)
            raise urllib.error.URLError(socket.gaierror(
                socket.EAI_AGAIN, "temporary failure in name resolution"))

    monkeypatch.setattr(cloud_transport.urllib.request, "build_opener",
                        lambda *args: Opener())
    with pytest.raises(CloudTransportError, match="DNS lookup"):
        CloudTransport(CONFIG)._open(
            "https://management.azure.com/subscriptions/test/jobs/test",
            scope="https://management.azure.com/.default", cancelled=cancelled)
    assert calls == [1, 1, 1]
    assert waits == [1, 2]


def test_open_does_not_retry_http_authentication_failure(monkeypatch):
    from mizan import cloud_transport
    calls = []
    monkeypatch.setattr(cloud_transport, "token", lambda *args: "user-token")

    class Opener:
        def open(self, request, timeout):
            calls.append(1)
            raise cloud_transport.urllib.error.HTTPError(
                request.full_url, 401, "Unauthorized", {}, BytesIO())

    monkeypatch.setattr(cloud_transport.urllib.request, "build_opener",
                        lambda *args: Opener())
    with pytest.raises(CloudTransportError, match="HTTP 401"):
        CloudTransport(CONFIG)._open(
            "https://management.azure.com/subscriptions/test/jobs/test",
            scope="https://management.azure.com/.default")
    assert calls == [1]


def test_invalid_json_and_partial_blob_body_are_not_retried(monkeypatch, tmp_path):
    from mizan import cloud_transport
    monkeypatch.setattr(cloud_transport, "token", lambda *args: "user-token")
    calls = []

    class InvalidJson:
        headers = {}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def read(self, _size):
            return b"{invalid"

    class PartialBody(BytesIO):
        def __init__(self):
            super().__init__(b"partial")
            self.reads = 0

        def read(self, size=-1):
            self.reads += 1
            if self.reads == 1:
                return super().read(size)
            raise TimeoutError("timed out")

    responses = [InvalidJson(), PartialBody()]

    class Opener:
        def open(self, request, timeout):
            calls.append(request.get_method())
            return responses.pop(0)

    monkeypatch.setattr(cloud_transport.urllib.request, "build_opener",
                        lambda *args: Opener())
    transport = CloudTransport(CONFIG)
    with pytest.raises(CloudTransportError, match="invalid JSON"):
        transport._arm()
    with pytest.raises(CloudTransportError, match="could not be read completely"):
        transport._get("jobs/test/result.json", tmp_path / "partial", limit=100)
    assert calls == ["GET", "GET"]


def test_transient_start_post_is_not_replayed(monkeypatch, tmp_path):
    transport = CloudTransport(CONFIG)
    posts, deletes = [], []
    monkeypatch.setattr(transport, "_put", lambda *args, **kwargs: None)
    monkeypatch.setattr(transport, "delete", lambda names: deletes.append(names))

    def arm(suffix="", *, method="GET", payload=None, **kwargs):
        if not suffix:
            return job_template(), None
        if suffix == "/start":
            posts.append((method, suffix))
            cause = urllib.error.URLError(TimeoutError("timed out"))
            raise CloudTransportError("Could not reach Azure: timed out") from cause
        pytest.fail("Unexpected Azure request after the start POST")

    monkeypatch.setattr(transport, "_arm", arm)
    with pytest.raises(CloudTransportError, match="Could not reach Azure"):
        transport.run(tmp_path / "source.wav", tmp_path, "muscriptor-small", Event(),
                      lambda *args, **kwargs: None)
    assert posts == [("POST", "/start")]
    assert not deletes


def test_cancel_stops_just_this_execution(monkeypatch, tmp_path):
    transport = CloudTransport(CONFIG)
    calls = []
    cancelled = Event()
    remote_jobs = []
    monkeypatch.setattr(transport, "_put", lambda *args, **kwargs: None)
    monkeypatch.setattr(transport, "delete", lambda names: calls.append(("DELETE", names)))

    def arm(suffix="", *, method="GET", payload=None, **kwargs):
        calls.append((method, suffix))
        if suffix == "":
            return job_template(), None
        if suffix == "/start":
            cancelled.set()
            return {"name": "gpu-abcd1234"}, None
        return {}, None

    monkeypatch.setattr(transport, "_arm", arm)
    def report(_stage, _progress, **kwargs):
        if "cloud_job" in kwargs:
            remote_jobs.append(kwargs["cloud_job"])
            assert cancelled.is_set()
            raise Cancelled()
    with pytest.raises(Cancelled):
        transport.run(tmp_path / "source.wav", tmp_path, "muscriptor-small", cancelled, report)
    assert ("POST", "/executions/gpu-abcd1234/stop") in calls
    assert remote_jobs == [{
        "provider": "azure", "id": "gpu-abcd1234",
        "prefix": calls[-1][1][0].removesuffix("/input.wav"),
    }]
    assert not any(method == "GET" and suffix.startswith("/executions/")
                   for method, suffix in calls if isinstance(suffix, str))
    assert any(call[0] == "DELETE" for call in calls)


def test_failed_execution_cleans_up_without_stopping_finished_job(monkeypatch, tmp_path, caplog):
    transport = CloudTransport(CONFIG)
    calls = []
    monkeypatch.setattr(transport, "_put", lambda *args, **kwargs: None)
    monkeypatch.setattr(transport, "delete", lambda names: calls.append(("DELETE", names)))

    def arm(suffix="", *, method="GET", payload=None, **kwargs):
        calls.append((method, suffix))
        if suffix == "":
            return job_template(), None
        if suffix == "/start":
            return {"name": "gpu-failed123"}, None
        if suffix == "/executions/gpu-failed123":
            return {"properties": {"status": "Failed"}}, None
        pytest.fail("A failed execution was stopped after it had ended")

    def get_error(name, path, *, limit, **kwargs):
        run_id = name.split("/")[1]
        path.write_text(json.dumps({
            "schemaVersion": 1, "kind": "mizan-worker-error", "status": "failed",
            "runId": run_id, "stage": "transcribe",
            "error": {
                "category": "TranscriptionLimitError",
                "message": "MuScriptor reached the strict EOS limit in chunk 10 near 50s "
                           "(2,000 tokens); no complete transcription was produced. "
                           "Split the recording around this passage and retry.",
                "diagnostics": {"chunk": 10, "seekSeconds": 50.0, "tokenLimit": 2000},
                "frames": [{"file": "worker.py", "function": "transcribe", "line": 42}],
            },
        }))
        calls.append(("GET", name, limit))
        return path.stat().st_size, "digest"

    monkeypatch.setattr(transport, "_get", get_error)
    monkeypatch.setattr(transport, "_arm", arm)
    with caplog.at_level(logging.INFO, logger="mizan.cloud_transport"):
        with pytest.raises(CloudTransportError,
                           match="gpu-failed123 failed during transcribe "
                                 "\\(TranscriptionLimitError\\): MuScriptor reached the strict EOS limit "
                                 "in chunk 10 near 50s"):
            transport.run(tmp_path / "source.wav", tmp_path, "muscriptor-small", Event(),
                          lambda *args, **kwargs: None)
    assert "run_id=" in caplog.text
    assert "execution=gpu-failed123" in caplog.text
    assert "status=Failed" in caplog.text
    assert "tokenLimit': 2000" in caplog.text
    assert "seekSeconds': 50.0" in caplog.text
    assert "source.wav" not in caplog.text
    assert calls[-2][0] == "GET"
    assert len(calls[-1][1]) == 8
    assert calls[-1][0] == "DELETE"


@pytest.mark.parametrize("failure,expected", [
    (FileNotFoundError(), "not_found"),
    (CloudTransportError("Azure GET failed (HTTP 403)."), "forbidden"),
    (CloudTransportError("Could not reach Azure: timed out"), "unreachable"),
    (CloudTransportError("Cloud result exceeds the 65536 byte download limit."), "read_failed"),
])
def test_worker_error_read_failures_are_distinguished(monkeypatch, tmp_path, failure, expected):
    transport = CloudTransport(CONFIG)
    monkeypatch.setattr(transport, "_get", lambda *args, **kwargs: (_ for _ in ()).throw(failure))

    error, reason = transport._read_worker_error(
        "jobs/11111111-1111-1111-1111-111111111111/result.json",
        "11111111-1111-1111-1111-111111111111", tmp_path)

    assert error is None and reason == expected
    assert not (tmp_path / "worker-error.json").exists()


def test_worker_error_reader_rejects_malformed_and_mismatched_artifacts(monkeypatch, tmp_path):
    transport = CloudTransport(CONFIG)
    path = tmp_path / "worker-error.json"
    payload = {
        "schemaVersion": 1, "kind": "mizan-worker-error", "status": "failed",
        "runId": "22222222-2222-2222-2222-222222222222", "stage": "separate",
        "error": {"category": "RuntimeError", "message": "CUDA failed", "frames": []},
    }
    monkeypatch.setattr(transport, "_get", lambda name, target, *, limit, **kwargs:
                        target.write_text(json.dumps(payload)))

    assert transport._read_worker_error(
        "jobs/11111111-1111-1111-1111-111111111111/result.json",
        "11111111-1111-1111-1111-111111111111", tmp_path) == (None, "invalid")
    assert not path.exists()


def test_worker_error_rejects_invalid_transcription_limit_metadata():
    payload = {
        "schemaVersion": 1, "kind": "mizan-worker-error", "status": "failed",
        "runId": "11111111-1111-1111-1111-111111111111", "stage": "transcribe",
        "error": {
            "category": "TranscriptionLimitError", "message": "EOS limit",
            "frames": [],
            "diagnostics": {"chunk": 10, "seekSeconds": 50.0, "tokenLimit": True},
        },
    }

    assert CloudTransport._validated_worker_error(
        payload, "11111111-1111-1111-1111-111111111111") is None


def test_worker_error_redacts_secrets_urls_and_temporary_paths():
    payload = {
        "schemaVersion": 1, "kind": "mizan-worker-error", "status": "failed",
        "runId": "11111111-1111-1111-1111-111111111111", "stage": "separate",
        "error": {
            "category": "RuntimeError",
            "message": "CUDA failed Bearer abc sharedKey=xyz at .aca-job\\private.wav "
                       "https://example.test/path",
            "frames": [],
        },
    }

    error = CloudTransport._validated_worker_error(
        payload, "11111111-1111-1111-1111-111111111111")

    assert error is not None
    assert "abc" not in error["message"] and "xyz" not in error["message"]
    assert "private.wav" not in error["message"] and "https://" not in error["message"]


def test_unknown_start_response_retains_input_for_possible_running_job(monkeypatch, tmp_path):
    transport = CloudTransport(CONFIG)
    monkeypatch.setattr(transport, "_put", lambda *args, **kwargs: None)
    monkeypatch.setattr(transport, "delete", lambda names: pytest.fail("Deleted running Job input"))

    def arm(suffix="", *, method="GET", payload=None, **kwargs):
        if suffix == "":
            return job_template(), None
        if suffix == "/start":
            return {}, None
        pytest.fail("Tried to stop an unknown execution")

    monkeypatch.setattr(transport, "_arm", arm)
    with pytest.raises(CloudTransportError, match="execution name"):
        transport.run(tmp_path / "source.wav", tmp_path, "muscriptor-small", Event(),
                      lambda *args, **kwargs: None)


def test_prestart_cancel_never_uploads_or_starts_job(monkeypatch, tmp_path):
    transport = CloudTransport(CONFIG)
    monkeypatch.setattr(transport, "_put", lambda *args, **kwargs:
                        pytest.fail("Cancelled upload started"))
    monkeypatch.setattr(transport, "_arm", lambda *args, **kwargs: pytest.fail("Cancelled Job started"))
    monkeypatch.setattr(transport, "delete", lambda *args: None)
    cancelled = Event()
    cancelled.set()
    with pytest.raises(Cancelled):
        transport.run(tmp_path / "source.wav", tmp_path, "muscriptor-small", cancelled,
                      lambda *args, **kwargs: None)


def test_incomplete_job_refuses_to_start(monkeypatch, tmp_path):
    transport = CloudTransport(CONFIG)
    monkeypatch.setattr(transport, "_put", lambda *args, **kwargs: None)
    monkeypatch.setattr(transport, "delete", lambda *args: None)
    template = job_template()
    template["properties"]["template"]["containers"][0]["env"][0] = {"name": "HF_TOKEN", "value": "exposed"}
    monkeypatch.setattr(transport, "_arm",
                        lambda suffix="", **kwargs: (template, None)
                        if not suffix else pytest.fail("Unconfigured Job started"))
    with pytest.raises(CloudTransportError, match="must bind a Hugging Face secret"):
        transport.run(tmp_path / "source.wav", tmp_path, "muscriptor-small", Event(),
                      lambda *args, **kwargs: None)


def test_job_start_follows_only_same_subscription_operation(monkeypatch):
    transport = CloudTransport(CONFIG)
    location = (f"https://management.azure.com/subscriptions/{CONFIG['subscriptionId']}"
                "/providers/Microsoft.App/locations/test/operationStatuses/abc")
    with pytest.raises(CloudTransportError, match="unsafe"):
        transport._start_result("https://another.example/operationStatuses/abc", Event())

    class Response(BytesIO):
        status = 200

    monkeypatch.setattr(transport, "_open",
                        lambda url, *, scope, **kwargs: Response(b'{"name":"gpu-abcd1234"}'))
    assert transport._start_result(location, Event()) == {"name": "gpu-abcd1234"}


def test_start_result_cancel_does_not_replay_start_or_poll(monkeypatch, tmp_path):
    transport = CloudTransport(CONFIG)
    cancelled = Event()
    arm_calls, operation_gets, deletes = [], [], []
    monkeypatch.setattr(transport, "_put", lambda *args, **kwargs: None)
    monkeypatch.setattr(transport, "delete", lambda names: deletes.append(names))

    location = (f"https://management.azure.com/subscriptions/{CONFIG['subscriptionId']}"
                "/providers/Microsoft.App/locations/test/operationStatuses/abc")

    def arm(suffix="", *, method="GET", payload=None, **kwargs):
        arm_calls.append((method, suffix))
        if suffix == "":
            return job_template(), None
        if suffix == "/start":
            return {}, location
        pytest.fail("Cancellation must not submit another ARM operation")

    class Accepted:
        status = 202

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

    def open_operation(_url, *, scope, **kwargs):
        operation_gets.append("GET")
        return Accepted()

    def cancel_wait(_seconds):
        cancelled.set()
        return True

    monkeypatch.setattr(transport, "_arm", arm)
    monkeypatch.setattr(transport, "_open", open_operation)
    monkeypatch.setattr(cancelled, "wait", cancel_wait)
    with pytest.raises(Cancelled):
        transport.run(tmp_path / "source.wav", tmp_path, "muscriptor-small", cancelled,
                      lambda *args, **kwargs: None)
    assert arm_calls.count(("POST", "/start")) == 1
    assert operation_gets == ["GET"]
    assert not deletes, "unknown start execution keeps uploaded input for safe inspection"
