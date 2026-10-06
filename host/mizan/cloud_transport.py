"""Private Blob and per-execution Azure Container Apps Job transport."""

import copy
import http.client
import json
import logging
import math
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from threading import Event
from uuid import uuid4

from .errors import Cancelled
from .cloud_auth import AzureSignInError, token
from .cloud_network import (ARM_GET_MAX_ATTEMPTS, ARM_GET_MAX_BACKOFF,
                            ARM_GET_RETRY_BACKOFF, ARM_REQUEST_TIMEOUT,
                            ARM_SOCKET_TIMEOUT, _safe_azure_text,
                            _transport_category, _transport_diagnostics,
                            _transient_transport_error)

API_VERSION = "2024-03-01"
MAX_AUDIO_BYTES = 250 * 1024 * 1024
MAX_WORKER_ERROR_BYTES = 64 * 1024
MAX_ARM_ERROR_BYTES = 16 * 1024
STEMS = ("drums", "bass", "other", "vocals", "guitar", "piano")
START_CONTAINER_FIELDS = ("args", "command", "env", "image", "name", "resources")
WORKER_ERROR_STAGES = {
    "startup", "credentials", "storage", "download", "separate",
    "transcribe", "upload_stems", "upload_result",
}
MODEL_EXECUTION_BUDGETS = {
    "muscriptor-small": (2, 8),
    "muscriptor-medium": (4, 16),
    "muscriptor-large": (8, 32),
}
logger = logging.getLogger(__name__)


class CloudTransportError(Exception):
    pass


def _model_execution_budget(model: str) -> tuple[int, int]:
    if not isinstance(model, str) or model not in MODEL_EXECUTION_BUDGETS:
        raise CloudTransportError("The selected MuScriptor size is not supported by this Cloud worker.")
    return MODEL_EXECUTION_BUDGETS[model]


def _execution_resources(model: str, resources: dict) -> dict:
    cpu_budget, memory_budget = _model_execution_budget(model)
    if not isinstance(resources, dict):
        raise CloudTransportError("The Azure GPU Job has invalid container resources.")
    cpu = resources.get("cpu")
    if isinstance(cpu, bool) or not isinstance(cpu, (int, float)):
        raise CloudTransportError("The Azure GPU Job has invalid container CPU resources.")
    try:
        cpu_value = float(cpu)
    except (OverflowError, ValueError):
        raise CloudTransportError("The Azure GPU Job has invalid container CPU resources.") from None
    if not math.isfinite(cpu_value) or cpu_value <= 0:
        raise CloudTransportError("The Azure GPU Job has invalid container CPU resources.")
    memory = resources.get("memory")
    match = re.fullmatch(r"(\d+(?:\.\d+)?)Gi", memory) if isinstance(memory, str) else None
    memory_value = float(match.group(1)) if match else 0
    if not math.isfinite(memory_value) or memory_value <= 0:
        raise CloudTransportError("The Azure GPU Job has invalid container memory resources.")
    result = {"cpu": cpu, "memory": memory}
    if cpu_value < cpu_budget:
        result["cpu"] = cpu_budget
    if memory_value < memory_budget:
        result["memory"] = f"{memory_budget}Gi"
    return result


def _execution_template(job: dict, model: str, source: str, result: str,
                        config: dict) -> dict:
    _model_execution_budget(model)
    properties = job.get("properties") if isinstance(job, dict) else None
    template = properties.get("template") if isinstance(properties, dict) else None
    if not isinstance(template, dict):
        raise CloudTransportError("The Azure GPU Job has an invalid execution template.")
    execution = {}
    for field in ("containers", "initContainers"):
        if field not in template:
            if field == "containers":
                raise CloudTransportError("The Azure GPU Job has an invalid container template.")
            continue
        source_containers = template[field]
        if source_containers is None and field == "initContainers":
            continue
        if not isinstance(source_containers, list):
            raise CloudTransportError(f"The Azure GPU Job has invalid {field}.")
        containers = []
        for source_container in source_containers:
            if not isinstance(source_container, dict):
                raise CloudTransportError(f"The Azure GPU Job has invalid {field}.")
            container = {
                name: copy.deepcopy(source_container[name])
                for name in START_CONTAINER_FIELDS if name in source_container
            }
            resources = source_container.get("resources")
            if isinstance(resources, dict):
                container["resources"] = {
                    name: copy.deepcopy(resources[name])
                    for name in ("cpu", "memory") if name in resources
                }
            containers.append(container)
        execution[field] = containers
    containers = execution.get("containers")
    if not isinstance(containers, list) or not containers:
        raise CloudTransportError("The Azure GPU Job has an invalid container template.")

    required = {"HF_TOKEN", "AZURE_STORAGE_BLOB_URL", "AZURE_STORAGE_CONTAINER",
                "AZURE_CLIENT_ID"}
    candidates = []
    for index, container in enumerate(containers):
        if not isinstance(container, dict):
            raise CloudTransportError("The Azure GPU Job has an invalid container template.")
        env = container.get("env")
        if not isinstance(env, list):
            continue
        environment = {
            item["name"]: item for item in env
            if isinstance(item, dict) and isinstance(item.get("name"), str)
        }
        if required <= environment.keys():
            candidates.append((index, environment))
    if len(candidates) != 1:
        raise CloudTransportError("The Azure GPU Job must have exactly one configured worker container.")

    index, environment = candidates[0]
    container = containers[index]
    if not all(isinstance(container.get(key), str) and container[key]
               for key in ("name", "image")) or "resources" not in container:
        raise CloudTransportError("The Azure GPU Job has an incomplete worker container template.")
    storage_account = config.get("storageAccount")
    storage_container = config.get("container")
    if (not isinstance(storage_account, str) or not storage_account
            or not isinstance(storage_container, str) or not storage_container
            or not isinstance(environment["HF_TOKEN"].get("secretRef"), str)
            or not environment["HF_TOKEN"]["secretRef"]
            or environment["AZURE_STORAGE_BLOB_URL"].get("value")
               != f"https://{storage_account}.blob.core.windows.net"
            or environment["AZURE_STORAGE_CONTAINER"].get("value") != storage_container
            or not isinstance(environment["AZURE_CLIENT_ID"].get("value"), str)
            or not environment["AZURE_CLIENT_ID"]["value"]):
        raise CloudTransportError("The GPU Job must bind a Hugging Face secret and private Blob identity.")
    container["resources"] = _execution_resources(model, container["resources"])
    container["args"] = [source, result, model]
    return execution


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise CloudTransportError("Azure unexpectedly redirected a credentialed request.")


class CloudTransport:
    def __init__(self, config: dict):
        self.config = config
        self.arm = (
            f"https://management.azure.com/subscriptions/{config['subscriptionId']}"
            f"/resourceGroups/{urllib.parse.quote(config['resourceGroup'], safe='')}"
            f"/providers/Microsoft.App/jobs/{config['jobName']}"
        )
        self.blob = f"https://{config['storageAccount']}.blob.core.windows.net/{config['container']}"

    def _token(self, scope: str) -> str:
        try:
            return token(scope, self.config["tenantId"], self.config.get("userObjectId"))
        except AzureSignInError as exc:
            raise CloudTransportError(str(exc)) from exc

    @staticmethod
    def _network_error(exc, *, scope, method, attempt, max_attempts, started,
                       request_id="unavailable", retry_delay=0, partial=False):
        category, error_type, reason_type, error_errno, error_winerror, reason = \
            _transport_diagnostics(exc)
        request_id = _safe_azure_text(request_id)[:128]
        service = ("Blob Storage" if scope == "https://storage.azure.com/.default"
                   else "Azure Resource Manager")
        logger.warning(
            "Azure transport failure service=%s method=%s attempt=%d max_attempts=%d "
            "request_id=%s category=%s error_type=%s reason_type=%s errno=%s "
            "winerror=%s reason=%s retry_delay_seconds=%.2f elapsed_seconds=%.2f",
            service, method, attempt, max_attempts, request_id, category, error_type,
            reason_type, error_errno, error_winerror, reason, retry_delay,
            time.monotonic() - started)
        if partial:
            message = f"Azure {method} response could not be read completely ({category})."
        elif method == "POST":
            message = ("Azure POST outcome is unknown; inspect the Azure GPU Job before "
                       "retrying.")
        elif category == "tls":
            issue = "handshake timed out" if "handshake" in reason.lower() \
                and "time" in reason.lower() else "connection failed"
            message = (f"Azure TLS {issue} after {attempt} attempt(s); check network "
                       "connectivity, certificate trust, and device time.")
        elif category.startswith("dns"):
            message = (f"Azure DNS lookup failed after {attempt} attempt(s); check network "
                       "name resolution.")
        elif method in ("GET", "HEAD"):
            message = (f"Could not reach Azure for {method} ({category}) after "
                       f"{attempt} attempt(s); check connectivity and retry.")
        else:
            message = (f"Azure {method} did not complete ({category}); check Azure before "
                       "retrying.")
        return CloudTransportError(message)

    def _open(self, url: str, *, scope: str, method: str = "GET",
              data: bytes | None = None, headers: dict | None = None,
              cancelled: Event | None = None, deadline: float | None = None):
        started = time.monotonic()
        request_deadline = min(deadline or started + ARM_REQUEST_TIMEOUT,
                               started + ARM_REQUEST_TIMEOUT)
        read_only = method in ("GET", "HEAD") and data is None
        max_attempts = ARM_GET_MAX_ATTEMPTS if read_only else 1
        if cancelled and cancelled.is_set():
            raise Cancelled()
        access_token = self._token(scope)
        request = urllib.request.Request(
            url, data=data, method=method,
            headers={"Authorization": f"Bearer {access_token}", **(headers or {})},
        )
        for attempt in range(1, max_attempts + 1):
            if cancelled and cancelled.is_set():
                raise Cancelled()
            remaining = request_deadline - time.monotonic()
            if remaining <= 0:
                raise self._network_error(
                    TimeoutError("Azure request deadline elapsed."),
                    scope=scope, method=method, attempt=attempt - 1,
                    max_attempts=max_attempts, started=started) from None
            try:
                response = urllib.request.build_opener(_NoRedirect()).open(
                    request, timeout=min(ARM_SOCKET_TIMEOUT, remaining))
                if cancelled and cancelled.is_set():
                    response.close()
                    raise Cancelled()
                if time.monotonic() >= request_deadline:
                    response.close()
                    raise self._network_error(
                        TimeoutError("Azure request deadline elapsed."),
                        scope=scope, method=method, attempt=attempt,
                        max_attempts=max_attempts, started=started) from None
                return response
            except urllib.error.HTTPError as exc:
                request_id = (exc.headers.get("x-ms-request-id")
                              or exc.headers.get("x-ms-correlation-request-id")
                              or "unavailable")
                request_id = _safe_azure_text(request_id)[:128]
                service = ("Blob Storage" if scope == "https://storage.azure.com/.default"
                           else "Azure Resource Manager")
                logger.warning(
                    "Azure request failed service=%s method=%s status=%s request_id=%s",
                    service, method, exc.code, request_id)
                if exc.code == 404:
                    raise FileNotFoundError("Azure resource not found.") from None
                try:
                    body = exc.read(MAX_ARM_ERROR_BYTES + 1)
                except (http.client.HTTPException, OSError, ValueError):
                    provider_code, provider_message, detail_status = None, None, "unreadable"
                else:
                    if not isinstance(body, bytes):
                        provider_code, provider_message, detail_status = None, None, "malformed"
                    elif len(body) > MAX_ARM_ERROR_BYTES:
                        provider_code, provider_message, detail_status = None, None, "oversized"
                    else:
                        try:
                            envelope = json.loads(body)
                        except (ValueError, RecursionError):
                            provider_code, provider_message, detail_status = None, None, "malformed"
                        else:
                            azure_error = envelope.get("error") if isinstance(envelope, dict) else None
                            if not isinstance(azure_error, dict):
                                provider_code, provider_message, detail_status = None, None, "malformed"
                            else:
                                raw_code = azure_error.get("code")
                                raw_message = azure_error.get("message")
                                provider_code = (_safe_azure_text(raw_code)
                                                 if isinstance(raw_code, str) else "")
                                provider_message = (_safe_azure_text(raw_message)
                                                    if isinstance(raw_message, str) else "")
                                provider_code = provider_code or None
                                provider_message = provider_message or None
                                detail_status = ("available" if provider_code or provider_message
                                                 else "malformed")
                logger.warning(
                    "Azure request error details service=%s method=%s status=%s request_id=%s "
                    "detail_status=%s provider_code=%s provider_message=%s",
                    service, method, exc.code, request_id, detail_status,
                    provider_code, provider_message)
                if provider_code or provider_message:
                    detail = ": ".join(part for part in (provider_code, provider_message) if part)
                    message = f"Azure {method} failed (HTTP {exc.code}): {detail}."
                else:
                    detail_message = {
                        "unreadable": "Azure error details could not be read.",
                        "oversized": "Azure error details exceeded the size limit.",
                        "malformed": "Azure returned malformed error details.",
                    }.get(detail_status, "Azure error details were unavailable.")
                    message = f"Azure {method} failed (HTTP {exc.code}); {detail_message}"
                raise CloudTransportError(message) from None
            except (urllib.error.URLError, OSError) as exc:
                if cancelled and cancelled.is_set():
                    raise Cancelled() from None
                category = _transport_category(exc)
                reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
                tls_timeout = (isinstance(reason, ssl.SSLError)
                               and any(word in str(reason).lower()
                                       for word in ("timeout", "timed out")))
                retryable = (read_only
                             and (_transient_transport_error(exc) or tls_timeout))
                remaining = request_deadline - time.monotonic()
                delay = (min(ARM_GET_RETRY_BACKOFF * (2 ** (attempt - 1)),
                             ARM_GET_MAX_BACKOFF, remaining)
                         if retryable and attempt < max_attempts and remaining > 0 else 0)
                error = self._network_error(
                    exc, scope=scope, method=method, attempt=attempt,
                    max_attempts=max_attempts, started=started, retry_delay=delay)
                if delay:
                    if cancelled and cancelled.wait(delay):
                        raise Cancelled() from None
                    if cancelled is None:
                        time.sleep(delay)
                    continue
                raise error from None
        raise self._network_error(
            TimeoutError("Azure request deadline elapsed."),
            scope=scope, method=method, attempt=max_attempts,
            max_attempts=max_attempts, started=started) from None

    def _arm(self, suffix: str = "", *, method: str = "GET",
             payload: dict | None = None, cancelled: Event | None = None,
             deadline: float | None = None) -> tuple[dict, str | None]:
        url = f"{self.arm}{suffix}?api-version={API_VERSION}"
        data = json.dumps(payload).encode() if payload is not None else None
        with self._open(url, scope="https://management.azure.com/.default",
                        method=method, data=data,
                        headers={"Content-Type": "application/json"} if data else None,
                        cancelled=cancelled, deadline=deadline) as response:
            if cancelled and cancelled.is_set():
                raise Cancelled()
            try:
                body = response.read(2 * 1024 * 1024 + 1)
            except (OSError, urllib.error.URLError) as exc:
                raise self._network_error(
                    exc, scope="https://management.azure.com/.default",
                    method=method, attempt=1, max_attempts=1,
                    started=time.monotonic(), partial=True) from None
            if cancelled and cancelled.is_set():
                raise Cancelled()
            if len(body) > 2 * 1024 * 1024:
                raise CloudTransportError("Azure Job response is too large.")
            try:
                result = json.loads(body) if body else {}
            except (ValueError, UnicodeError):
                raise CloudTransportError("Azure Job returned invalid JSON.") from None
            if not isinstance(result, dict):
                raise CloudTransportError("Azure Job returned an invalid response.")
            return result, response.headers.get("Location")

    def _job_template(self, cancelled: Event) -> dict:
        return self._arm(
            cancelled=cancelled,
            deadline=time.monotonic() + ARM_REQUEST_TIMEOUT)[0]

    def _blob_url(self, name: str) -> str:
        return f"{self.blob}/{urllib.parse.quote(name, safe='/')}"

    def _start_result(self, location: str, cancelled: Event) -> dict:
        parsed = urllib.parse.urlparse(location)
        if (parsed.scheme != "https" or parsed.netloc != "management.azure.com"
                or not parsed.path.startswith(
                    f"/subscriptions/{self.config['subscriptionId']}/")):
            raise CloudTransportError("Azure returned an unsafe Job operation location.")
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            if cancelled.is_set():
                raise Cancelled()
            with self._open(location, scope="https://management.azure.com/.default",
                            cancelled=cancelled, deadline=deadline) as response:
                if response.status == 200:
                    try:
                        body = response.read(2 * 1024 * 1024 + 1)
                    except (OSError, urllib.error.URLError) as exc:
                        raise self._network_error(
                            exc, scope="https://management.azure.com/.default",
                            method="GET", attempt=1, max_attempts=1,
                            started=time.monotonic(), partial=True) from None
                    if cancelled.is_set():
                        raise Cancelled()
                    if len(body) > 2 * 1024 * 1024:
                        raise CloudTransportError("Azure Job operation response is too large.")
                    try:
                        result = json.loads(body)
                    except (ValueError, UnicodeError):
                        raise CloudTransportError(
                            "Azure Job operation returned invalid JSON.") from None
                    if not isinstance(result, dict):
                        raise CloudTransportError("Azure returned an invalid Job execution.")
                    return result
                if response.status != 202:
                    raise CloudTransportError(f"Azure Job start returned HTTP {response.status}.")
            if cancelled.wait(min(5, max(0, deadline - time.monotonic()))):
                raise Cancelled()
        if cancelled.is_set():
            raise Cancelled()
        raise CloudTransportError("Azure did not return a GPU Job execution name within five minutes.")

    def _put(self, name: str, path: Path, *, cancelled: Event | None = None,
             deadline: float | None = None) -> None:
        if cancelled and cancelled.is_set():
            raise Cancelled()
        if path.stat().st_size > MAX_AUDIO_BYTES:
            raise CloudTransportError("The recording exceeds the 250 MiB Cloud Job limit.")
        with self._open(self._blob_url(name), scope="https://storage.azure.com/.default",
                        method="PUT", data=path.read_bytes(), headers={
                            "x-ms-blob-type": "BlockBlob", "x-ms-version": "2023-11-03",
                            "Content-Type": "audio/wav",
                        }, cancelled=cancelled, deadline=deadline) as response:
            try:
                response.read()
            except (OSError, urllib.error.URLError) as exc:
                raise self._network_error(
                    exc, scope="https://storage.azure.com/.default", method="PUT",
                    attempt=1, max_attempts=1, started=time.monotonic(),
                    partial=True) from None

    def _get(self, name: str, path: Path, *, limit: int,
             cancelled: Event | None = None, deadline: float | None = None) -> tuple[int, str]:
        import hashlib
        digest = hashlib.sha256()
        received = 0
        with self._open(self._blob_url(name), scope="https://storage.azure.com/.default",
                        headers={"x-ms-version": "2023-11-03"},
                        cancelled=cancelled, deadline=deadline) as response, path.open("wb") as output:
            while True:
                if cancelled and cancelled.is_set():
                    raise Cancelled()
                try:
                    data = response.read(256 * 1024)
                except (OSError, urllib.error.URLError) as exc:
                    raise self._network_error(
                        exc, scope="https://storage.azure.com/.default",
                        method="GET", attempt=1, max_attempts=1,
                        started=time.monotonic(), partial=True) from None
                if not data:
                    break
                received += len(data)
                if received > limit:
                    raise CloudTransportError(f"Cloud result exceeds the {limit} byte download limit.")
                digest.update(data)
                output.write(data)
        return received, digest.hexdigest()

    @staticmethod
    def _validated_worker_error(payload: object, run_id: str) -> dict | None:
        if not isinstance(payload, dict) or payload.get("schemaVersion") != 1 \
                or payload.get("kind") != "mizan-worker-error" \
                or payload.get("status") != "failed" or payload.get("runId") != run_id \
                or payload.get("stage") not in WORKER_ERROR_STAGES:
            return None
        error = payload.get("error")
        if not isinstance(error, dict):
            return None
        category = error.get("category")
        message = error.get("message")
        frames = error.get("frames")
        if not isinstance(category, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", category) \
                or not isinstance(message, str) or not message or len(message) > 512 \
                or not isinstance(frames, list) or len(frames) > 4:
            return None
        diagnostics = error.get("diagnostics")
        if category == "TranscriptionLimitError":
            if (not isinstance(diagnostics, dict)
                    or set(diagnostics) != {"chunk", "seekSeconds", "tokenLimit"}
                    or not isinstance(diagnostics.get("chunk"), int)
                    or isinstance(diagnostics.get("chunk"), bool)
                    or not 0 <= diagnostics["chunk"] <= 999_999
                    or not isinstance(diagnostics.get("seekSeconds"), (int, float))
                    or isinstance(diagnostics.get("seekSeconds"), bool)
                    or not math.isfinite(diagnostics["seekSeconds"])
                    or not 0 <= diagnostics["seekSeconds"] <= 99_999_999.999
                    or not isinstance(diagnostics.get("tokenLimit"), int)
                    or isinstance(diagnostics.get("tokenLimit"), bool)
                    or not 1 <= diagnostics["tokenLimit"] <= 999_999):
                return None
        elif diagnostics is not None:
            return None
        safe_frames = []
        for frame in frames:
            if not isinstance(frame, dict):
                return None
            filename, function, line = frame.get("file"), frame.get("function"), frame.get("line")
            if not isinstance(filename, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", filename) \
                    or not isinstance(function, str) or not re.fullmatch(r"[A-Za-z0-9_.<>-]{1,100}", function) \
                    or not isinstance(line, int) or isinstance(line, bool) or not 1 <= line <= 1_000_000:
                return None
            safe_frames.append({"file": filename, "function": function, "line": line})
        message = re.sub(r"https?://\S+", "[redacted URL]", message)
        message = re.sub(
            r"(?i)\b(?:bearer|hf[_-]?token|token|sig|sas|authorization|accountkey|sharedkey)\b"
            r"\s*[=:]?\s*\S+", "[redacted secret]", message)
        message = re.sub(
            r"(?:[A-Za-z]:\\|\.aca-job[\\/]|/)(?:[^\s:\\/]+[\\/])*[^\s:\\/]+",
            "[redacted path]", message)
        result = {"stage": payload["stage"], "category": category,
                  "message": message, "frames": safe_frames}
        if diagnostics is not None:
            result["diagnostics"] = diagnostics
        return result

    def _read_worker_error(self, blob: str, run_id: str, directory: Path,
                           cancelled: Event | None = None) -> tuple[dict | None, str | None]:
        path = directory / "worker-error.json"
        try:
            self._get(blob, path, limit=MAX_WORKER_ERROR_BYTES, cancelled=cancelled)
            payload = json.loads(path.read_text(encoding="utf-8"))
            validated = self._validated_worker_error(payload, run_id)
            return (validated, None) if validated else (None, "invalid")
        except FileNotFoundError:
            return None, "not_found"
        except CloudTransportError as exc:
            reason = "forbidden" if "HTTP 403" in str(exc) else \
                "unreachable" if "Could not reach Azure" in str(exc) else "read_failed"
            return None, reason
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
            return None, "invalid"
        finally:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                logger.warning("Could not remove temporary worker error metadata run_id=%s", run_id)

    @staticmethod
    def _worker_error_message(error: dict) -> str:
        return f"Azure GPU Job failed during {error['stage']} ({error['category']}): {error['message']}"

    def delete(self, names: list[str]) -> None:
        for name in names:
            try:
                with self._open(self._blob_url(name), scope="https://storage.azure.com/.default",
                                method="DELETE", headers={"x-ms-version": "2023-11-03"}) as response:
                    response.read()
            except FileNotFoundError:
                continue

    def run(self, recording: Path, directory: Path, model: str, cancelled: Event,
            report) -> tuple[dict, list[str]]:
        run_id = str(uuid4())
        prefix = f"jobs/{run_id}"
        source, result = f"{prefix}/input.wav", f"{prefix}/result.json"
        names = [source, result, *(f"{prefix}/result/stems/{name}.wav" for name in STEMS)]
        execution = None
        terminal = False
        start_submitted = False
        stage = "starting"
        started_at = time.monotonic()
        last_status = None
        _model_execution_budget(model)
        logger.info("Cloud GPU run started run_id=%s model=%s", run_id, model)
        try:
            if cancelled.is_set():
                raise Cancelled()
            report("detect", 0, message="Connecting to Azure GPU processing")
            report("detect", 0, message="Uploading prepared audio")
            stage = "uploading recording"
            self._put(source, recording, cancelled=cancelled)
            if cancelled.is_set():
                raise Cancelled()
            report("detect", 0, message="Checking Azure GPU Job")
            stage = "reading Job template"
            template = self._job_template(cancelled)
            execution_template = _execution_template(
                template, model, source, result, self.config)
            if cancelled.is_set():
                raise Cancelled()
            report("detect", 0, message="Starting Azure GPU Job")
            stage = "submitting execution"
            start_submitted = True
            started, location = self._arm(
                "/start", method="POST", payload=execution_template,
                cancelled=cancelled)
            execution = started.get("name")
            if not execution and location:
                execution = self._start_result(location, cancelled).get("name")
            if not isinstance(execution, str) or not re.fullmatch(r"[-\w.()]+", execution, re.ASCII):
                raise CloudTransportError("Azure did not return a usable GPU Job execution name.")
            logger.info("Cloud GPU execution started run_id=%s execution=%s", run_id, execution)
            report("detect", 0, message="Waiting for Azure GPU Job")
            stage = "waiting for execution"
            deadline = time.monotonic() + 7200
            while time.monotonic() < deadline:
                if cancelled.wait(5):
                    raise Cancelled()
                state, _ = self._arm(
                    f"/executions/{execution}", cancelled=cancelled, deadline=deadline)
                status = state.get("properties", {}).get("status")
                if status != last_status:
                    logger.info("Cloud GPU execution status run_id=%s execution=%s status=%s",
                                run_id, execution, status)
                    last_status = status
                    progress_message = {
                        "Pending": "Azure GPU Job queued",
                        "Running": "Azure GPU Job running",
                        "Processing": "Azure GPU Job running",
                        "Succeeded": "Azure GPU Job completed; retrieving notes",
                        "Failed": "Azure GPU Job failed",
                        "Stopped": "Azure GPU Job stopped",
                        "Cancelled": "Azure GPU Job cancelled",
                    }.get(status)
                    if progress_message:
                        report("detect", 0, message=progress_message)
                if status == "Succeeded":
                    terminal = True
                    break
                if status in ("Failed", "Stopped", "Cancelled"):
                    terminal = True
                    if status == "Failed":
                        worker_error, unavailable = self._read_worker_error(
                            result, run_id, directory, cancelled)
                        if worker_error:
                            logger.error(
                                "Azure GPU worker failed run_id=%s execution=%s stage=%s category=%s message=%s diagnostics=%s frames=%s",
                                run_id, execution, worker_error["stage"], worker_error["category"],
                                worker_error["message"], worker_error.get("diagnostics"),
                                worker_error["frames"],
                            )
                            raise CloudTransportError(
                                f"Azure GPU Job {execution} failed during {worker_error['stage']} "
                                f"({worker_error['category']}): {worker_error['message']}")
                        unavailable_message = {
                            "not_found": "Worker error details are unavailable (the worker did not publish an error result).",
                            "forbidden": "Worker error details could not be read (Azure returned HTTP 403).",
                            "unreachable": "Worker error details could not be read because Azure could not be reached.",
                            "read_failed": "Worker error details could not be read from Azure.",
                            "invalid": "Worker error details are unavailable (the failure result was invalid or did not match this run).",
                        }.get(unavailable or "", "Worker error details are unavailable.")
                        logger.warning("Azure GPU worker error details unavailable run_id=%s reason=%s",
                                       run_id, unavailable or "invalid")
                        raise CloudTransportError(
                            f"Azure GPU Job {execution} ended with status {status}. {unavailable_message}")
                    raise CloudTransportError(f"Azure GPU Job {execution} ended with status {status}.")
                if status not in ("Pending", "Running", "Processing"):
                    raise CloudTransportError(f"Azure GPU Job reported an unknown status: {status}.")
            else:
                raise CloudTransportError("Azure GPU Job exceeded the two-hour timeout.")
            stage = "downloading result"
            report("detect", 0, message="Retrieving Azure GPU results")
            manifest_file = directory / "cloud-result.json"
            self._get(result, manifest_file, limit=8 * 1024 * 1024,
                      cancelled=cancelled)
            try:
                manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
            except (ValueError, UnicodeError):
                raise CloudTransportError("Azure GPU result was not valid JSON.") from None
            manifest_file.unlink()
            report("detect", 0, message="Preparing notes from Azure results")
            logger.info("Cloud GPU run succeeded run_id=%s execution=%s elapsed_seconds=%.1f",
                        run_id, execution, time.monotonic() - started_at)
            return manifest, names
        except Exception as exc:
            elapsed = time.monotonic() - started_at
            if isinstance(exc, Cancelled):
                logger.info("Cloud GPU run cancelled run_id=%s execution=%s stage=%s elapsed_seconds=%.1f",
                            run_id, execution or "unavailable", stage, elapsed)
            else:
                logger.exception("Cloud GPU run failed run_id=%s execution=%s stage=%s elapsed_seconds=%.1f",
                                 run_id, execution or "unavailable", stage, elapsed)
            stopped = terminal or (execution is None and not start_submitted)
            if execution and not terminal:
                try:
                    self._arm(f"/executions/{execution}/stop", method="POST")
                    stopped = True
                except (CloudTransportError, FileNotFoundError):
                    logger.exception("Could not stop Azure GPU execution %s", execution)
            elif start_submitted and execution is None:
                logger.error("Azure may have started a GPU Job without returning its execution name; "
                             "retaining uploaded files under %s", prefix)
            if stopped:
                try:
                    self.delete(names)
                except (CloudTransportError, OSError):
                    logger.exception("Could not remove failed Azure GPU Job files under %s", prefix)
            raise
