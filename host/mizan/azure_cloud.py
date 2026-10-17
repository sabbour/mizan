"""Cloud setup stays gated until the complete Azure Job is deployed and verified."""

import json
import copy
import hashlib
import io
import gzip
import ipaddress
import logging
import re
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from threading import Event, Lock, Thread, get_ident, local
from uuid import UUID, uuid4, uuid5

from .cloud import CloudError as BaseCloudError, _setting, load_provider_settings
from .cloud_auth import ARM_SCOPE, AzureSignInError, claims, token
from .cloud_worker.worker import MODELS as CLOUD_WORKER_MODELS
from .cloud_network import (ARM_GET_MAX_ATTEMPTS, ARM_GET_RETRY_BACKOFF,
                            ARM_REQUEST_TIMEOUT, _safe_azure_text,
                            _transport_diagnostics, _transient_transport_error)
from .cloud_result import materialize as _shared_materialize, validate_events
from .cloud_worker.source import LEGACY_AZURE_SOURCE_HASH, worker_source
from .paths import home

logger = logging.getLogger(__name__)
FIELDS = ("tenantId", "subscriptionId", "resourceGroup",
          "storageAccount", "container", "jobName")
SETUP_FIELDS = ("location", "registry", "vnet", "subnet", "subnetResourceId",
                "vnetCidr", "subnetCidr", "environment", "identity")
NETWORK_DEFAULTS = {"vnetCidr": "10.42.0.0/16", "subnetCidr": "10.42.0.0/23"}
GPU_PROFILE = "NC24-A100"
GPU_TYPE = "Consumption-GPU-NC24-A100"
LOG_ANALYTICS_API_VERSION = "2023-09-01"
LOG_ANALYTICS_WORKSPACE = "mizan-aca-env-logs"
LOG_ANALYTICS_RETENTION_DAYS = 30
TERMINAL_JOB_STATUSES = {"Succeeded", "Failed", "Stopped", "Cancelled", "Canceled"}
ARM = "https://management.azure.com"
ARM_OPERATION_TIMEOUT = 30 * 60
ARM_POLL_INTERVAL = 5
DATA_CONTRIBUTOR = "ba92f5b4-2d11-453d-a403-e96b0029c9fe"
ACR_PULL = "7f951dda-4ed3-4680-a7ca-43fe172d538d"
JOB_RESOURCES = {"cpu": 2, "memory": "8Gi"}
EXISTING_JOB_RESOURCES = (JOB_RESOURCES, {"cpu": 4, "memory": "16Gi"},
                          {"cpu": 8, "memory": "32Gi"})
BUILD_VERIFIED_MODELS = ("muscriptor-small",)
SUPPORTED_CLOUD_MODELS = tuple(CLOUD_WORKER_MODELS)
SUPPORTED_WORKER_DIGEST = "sha256:5fe0f3b2fc894a8e9c3079baf3cc59f0f3b297ab049bc730d59882bfb8b79c5a"
FULL_PIPELINE_ISSUE = (
    "An earlier Small-model A100 pilot passed a synthetic six-stem run at 2 vCPU / 8 GiB. "
    "Each newly built image has a different digest and has not passed a customer GPU smoke run. "
    "Cloud also needs the selected identity, pinned Job and private Blob access; "
    "provisioning requires separate cost consent."
)


class CloudError(BaseCloudError):
    code = "cloud_failed"
    message = FULL_PIPELINE_ISSUE


def _job_resources_match(actual, expected):
    if not isinstance(actual, dict) or not isinstance(expected, dict):
        return False
    if actual.get("cpu") != expected.get("cpu") or actual.get("memory") != expected.get("memory"):
        return False
    actual_ephemeral = actual.get("ephemeralStorage")
    expected_ephemeral = expected.get("ephemeralStorage")
    return actual_ephemeral == expected_ephemeral or (
        actual_ephemeral in (None, "") and expected_ephemeral in (None, ""))


def _job_resources_compatible(actual, expected):
    if _job_resources_match(actual, expected):
        return True
    if not isinstance(expected, dict) or (expected.get("cpu"), expected.get("memory")) not in (
            (2, "8Gi"), (4, "16Gi")):
        return False
    return _job_resources_match(actual, {**expected, "cpu": 8, "memory": "32Gi"})


READINESS_TIMEOUT = 120
READINESS_CACHE_SECONDS = 30
_readiness_lock = Lock()
_readiness_context = local()
_readiness_check = None
_readiness_requests = {}
_cancelled_readiness_requests = {}


class _ReadinessCheck:
    def __init__(self, key):
        self.key = key
        self.started_at = time.monotonic()
        self.deadline = self.started_at + READINESS_TIMEOUT
        self.cancelled = Event()
        self.done = Event()
        self.result = None
        self.error = None
        self.completed_at = None
        self.progress_lock = Lock()
        self.stage = "Azure GPU Job"
        self.detail = "Starting the Azure access check."

    def set_progress(self, stage, detail):
        with self.progress_lock:
            self.stage = stage
            self.detail = detail

    def progress(self):
        with self.progress_lock:
            return {"stage": self.stage, "detail": self.detail,
                    "elapsedSeconds": round(max(0, time.monotonic() - self.started_at), 1),
                    "timeoutSeconds": READINESS_TIMEOUT}


def _readiness_timeout_message(check):
    stage = check.progress()["stage"]
    return (f"Azure readiness check timed out while checking {stage}. "
            "Check connectivity and retry; processing selection is unchanged.")


def _check_readiness():
    check = getattr(_readiness_context, "check", None)
    if check:
        if check.cancelled.is_set():
            raise CloudError("Azure readiness check was cancelled. Processing selection is unchanged.")
        if time.monotonic() >= check.deadline:
            raise CloudError(_readiness_timeout_message(check))


def _readiness_phase(stage, detail):
    check = getattr(_readiness_context, "check", None)
    if check:
        _check_readiness()
        check.set_progress(stage, detail)


def readiness_progress(request_id):
    if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
        raise CloudError("The Azure readiness request ID is invalid.")
    with _readiness_lock:
        request = _readiness_requests.get(request_id)
        if not request:
            return {"stage": "idle", "detail": None, "elapsedSeconds": 0, "timeoutSeconds": READINESS_TIMEOUT}
        return request[0].progress()


def _readiness_timeout(seconds):
    _check_readiness()
    check = getattr(_readiness_context, "check", None)
    return min(seconds, check.deadline - time.monotonic()) if check else seconds


def _readiness_key():
    return (str(home()), *(_setting(key) for key in (
        "cloud_config", "cloud_job_created", "cloud_job_resources",
        "cloud_built_image", "cloud_reuse", "cloud_runtime_verified")),
        _worker_source()[1])


def panel_status(request_id=None):
    """Bound and share read-only panel checks without cancelling any job or setup."""
    global _readiness_check
    snapshot = status(check_connection=False)
    if not snapshot["jobCreated"] or not snapshot["available"]:
        return snapshot
    if request_id is None:
        request_id = str(uuid4())
    if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
        raise CloudError("The Azure readiness request ID is invalid.")
    key = _readiness_key()
    with _readiness_lock:
        if _cancelled_readiness_requests.get((key[0], request_id), 0) > time.monotonic():
            return {**snapshot, "issue": "Azure readiness check was cancelled. "
                    "Processing selection is unchanged."}
        if request_id in _readiness_requests:
            raise CloudError("This Azure readiness request is already in progress.")
        check = _readiness_check
        if check and not check.done.is_set() and check.key != key:
            check.cancelled.set()
            return {**snapshot, "issue": "The previous Azure check is stopping. Retry the check."}
        cached = bool(check and check.key == key and check.done.is_set()
                      and not check.cancelled.is_set() and check.result
                      and check.result["configured"]
                      and time.monotonic() - check.completed_at < READINESS_CACHE_SECONDS)
        if cached:
            return {**check.result, "mode": snapshot["mode"]}
        if check is None or check.done.is_set():
            check = _ReadinessCheck(key)
            _readiness_check = check

            def verify():
                _readiness_context.check = check
                try:
                    result = status()
                    _readiness_phase("complete", "Azure access checks are complete.")
                    _check_readiness()
                    check.result = result
                except Exception as exc:
                    check.error = exc
                finally:
                    check.completed_at = time.monotonic()
                    check.done.set()
                    del _readiness_context.check

            Thread(target=verify, name="mizan-azure-readiness", daemon=True).start()
        cancelled = Event()
        _readiness_requests[request_id] = (check, cancelled)
    try:
        while not check.done.wait(0.05):
            if cancelled.is_set() or check.cancelled.is_set():
                return {**snapshot, "issue": "Azure readiness check was cancelled. "
                        "Processing selection is unchanged."}
            if time.monotonic() >= check.deadline:
                check.cancelled.set()
                return {**snapshot, "issue": _readiness_timeout_message(check)}
        if cancelled.is_set() or check.cancelled.is_set():
            return {**snapshot, "issue": "Azure readiness check was cancelled. "
                    "Processing selection is unchanged."}
        if check.error:
            if isinstance(check.error, CloudError):
                return {**snapshot, "issue": str(check.error)}
            raise check.error
        if _readiness_key() != key:
            return {**status(check_connection=False),
                    "issue": "Azure settings changed during the check. Retry the check."}
        return {**check.result, "mode": _setting("processing_mode") or "local"}
    finally:
        with _readiness_lock:
            _readiness_requests.pop(request_id, None)
            if not check.done.is_set() and not any(
                    active is check and not event.is_set()
                    for active, event in _readiness_requests.values()):
                check.cancelled.set()


def cancel_panel_status(request_id):
    with _readiness_lock:
        timestamp = time.monotonic()
        for key, expires in list(_cancelled_readiness_requests.items()):
            if expires <= timestamp:
                _cancelled_readiness_requests.pop(key)
        if isinstance(request_id, str) and request_id and len(request_id) <= 128:
            _cancelled_readiness_requests[(str(home()), request_id)] = timestamp + READINESS_TIMEOUT
        request = _readiness_requests.get(request_id) if isinstance(request_id, str) else None
        if not request or request[0].key[0] != str(home()):
            return {"cancelRequested": False}
        check, cancelled = request
        cancelled.set()
        if not any(active is check and not event.is_set()
                   for active, event in _readiness_requests.values()):
            check.cancelled.set()
        return {"cancelRequested": True}


_progress_lock = Lock()
_setup_progress = {"operation": None, "stage": "idle", "completed": 0,
                   "total": 0, "detail": None}
_progress_owner = None
_setup_cancelled = Event()


def setup_progress():
    with _progress_lock:
        return dict(_setup_progress)


def _progress_step(stage=None, completed=None, detail=None):
    with _progress_lock:
        if (_progress_owner != get_ident()
                or _setup_progress["stage"] in ("idle", "completed", "failed")):
            return
        if stage is not None:
            _setup_progress["stage"] = stage
        if completed is not None:
            _setup_progress["completed"] = completed
        _setup_progress["detail"] = detail


@contextmanager
def track_setup(operation, total):
    global _progress_owner
    with _progress_lock:
        if _setup_progress["stage"] not in ("idle", "completed", "failed"):
            raise CloudError(f"Cloud {_setup_progress['operation']} is already in progress; wait for it to finish.")
        _setup_cancelled.clear()
        _progress_owner = get_ident()
        _setup_progress.update(operation=operation, stage="starting", completed=0,
                               total=total, detail=None)
    try:
        yield
    except Exception:
        with _progress_lock:
            stage = _setup_progress["stage"]
            remedy = {
                "subscriptions": "Check Azure sign-in and network access.",
                "configuration": "Check the selected subscription and tenant.",
                "provision": "Check subscription RBAC, policy, quota and partially created resources in Azure Portal.",
                "import": "Check source registry access and the destination ACR.",
                "build": "Check network access and the ACR task log before retrying.",
                "job": "Inspect the Job, permissions and secret binding in Azure Portal before retrying.",
            }.get(operation, "Check operation details in Azure Portal.")
            _setup_progress.update(stage="failed", detail=(
                f"Cloud {operation} failed during {stage.replace('_', ' ')}. "
                f"Review the returned error. {remedy}"))
            _setup_cancelled.clear()
            _progress_owner = None
        raise
    else:
        with _progress_lock:
            _setup_progress.update(stage="completed", completed=total, detail=None)
            _setup_cancelled.clear()
            _progress_owner = None


def cancel_setup():
    with _progress_lock:
        active = (_setup_progress["operation"] == "provision"
                  and _setup_progress["stage"] not in ("idle", "completed", "failed"))
        if active:
            _setup_cancelled.set()
            _setup_progress["detail"] = (
                "Stopping setup after the current Azure request; accepted Azure operations may continue.")
    return {"cancelRequested": active}


def _wait_setup(seconds, resource_label):
    check = getattr(_readiness_context, "check", None)
    if check:
        check.cancelled.wait(_readiness_timeout(seconds))
        _check_readiness()
        return
    with _progress_lock:
        active = _progress_owner is not None
    if active:
        if _setup_cancelled.wait(seconds):
            raise CloudError(
                f"Azure setup was stopped while waiting for {resource_label}. "
                "Any accepted Azure operation may continue; inspect Azure Portal before retrying.")
    else:
        time.sleep(seconds)


def _validate(config):
    if not isinstance(config, dict):
        raise ValueError("Enter an Azure subscription, resource group, storage and Job settings.")
    result = {}
    guid = re.compile(r"^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$")
    dns = re.compile(r"^[a-z][a-z0-9-]{1,62}$")
    for key in FIELDS:
        value = config.get(key)
        if not isinstance(value, str) or not value or value != value.strip():
            raise ValueError(f"Enter a valid {key}.")
        if key in ("tenantId", "subscriptionId") and not guid.fullmatch(value):
            raise ValueError(f"Enter a valid {key} GUID.")
        if key == "resourceGroup" and (len(value) > 90 or not re.fullmatch(r"[a-zA-Z0-9_.()\-]+", value)
                                       or value.endswith(".")):
            raise ValueError("Enter a valid resourceGroup.")
        if key == "storageAccount" and not re.fullmatch(r"[a-z0-9]{3,24}", value):
            raise ValueError("Enter a valid storageAccount.")
        if key in ("container", "jobName") and (not dns.fullmatch(value) or "--" in value or value.endswith("-")):
            raise ValueError(f"Enter a valid {key}.")
        result[key] = value
    if "userObjectId" in config:
        if not isinstance(config["userObjectId"], str) or not guid.fullmatch(config["userObjectId"]):
            raise ValueError("Enter a valid Azure identity object ID.")
        result["userObjectId"] = config["userObjectId"]
    return result


def _setup(config):
    result = _validate(config)
    for key in SETUP_FIELDS:
        value = config.get(key, NETWORK_DEFAULTS.get(
            key, "" if key in ("vnet", "subnet", "subnetResourceId") else None))
        if not isinstance(value, str) or (not value and key not in ("vnet", "subnet", "subnetResourceId")) or value != value.strip():
            raise ValueError(f"Enter a valid {key}.")
        if key in ("location", "registry", "environment", "identity") and not re.fullmatch(
                r"[a-z][a-z0-9-]{2,49}", value):
            raise ValueError(f"Enter a valid {key}.")
        if key == "registry" and (len(value) < 5 or "-" in value):
            raise ValueError("Enter an ACR name (5–50 lowercase letters or digits).")
        if key in ("vnet", "subnet") and value and not re.fullmatch(r"[a-zA-Z0-9_.-]{2,64}", value):
            raise ValueError(f"Enter a valid {key}.")
        result[key] = value
    if bool(result["vnet"]) != bool(result["subnet"]):
        raise ValueError("Enter both a virtual network and delegated subnet, or use Azure-managed networking.")
    try:
        vnet_cidr = ipaddress.ip_network(result["vnetCidr"])
        subnet_cidr = ipaddress.ip_network(result["subnetCidr"])
    except ValueError as exc:
        raise ValueError("Enter valid VNet and subnet IPv4 address ranges (CIDR).") from exc
    if (not isinstance(vnet_cidr, ipaddress.IPv4Network)
            or not isinstance(subnet_cidr, ipaddress.IPv4Network)
            or not any(vnet_cidr.subnet_of(ipaddress.ip_network(private)) for private in (
                "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
            or not subnet_cidr.subnet_of(vnet_cidr) or subnet_cidr.prefixlen > 27):
        raise ValueError("Use a private IPv4 VNet and a /27 or larger subnet within its address range.")
    if result["subnetResourceId"]:
        if result["vnet"] or result["subnet"]:
            raise ValueError("Choose a new virtual network or an existing subnet, not both.")
        pattern = (rf"/subscriptions/{re.escape(result['subscriptionId'])}/resourceGroups/"
                   r"[a-zA-Z0-9_.()\-]+/providers/Microsoft\.Network/virtualNetworks/"
                   r"[a-zA-Z0-9_.-]+/subnets/[a-zA-Z0-9_.-]+")
        if not re.fullmatch(pattern, result["subnetResourceId"], re.IGNORECASE):
            raise ValueError("Enter a subnet resource ID in the selected subscription.")
    return result


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise CloudError("Azure redirected a credentialed setup request.")


def _arm_url(value):
    if not isinstance(value, str) or value != value.strip() or any(
            char in value for char in "\r\n\\"):
        raise CloudError("Azure returned an unexpected operation URL.")
    parsed = urllib.parse.urlsplit(value)
    if not parsed.scheme and not parsed.netloc and value.startswith("/") and not value.startswith("//"):
        value = f"{ARM}{value}"
        parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "https" or parsed.netloc.lower() != "management.azure.com"
            or not parsed.path.startswith("/") or parsed.fragment):
        raise CloudError("Azure returned an unexpected operation URL.")
    return value


def _arm_resource_label(value):
    parts = [part for part in urllib.parse.urlsplit(value).path.split("/") if part]
    provider_index = next((i for i, part in enumerate(parts) if part.lower() == "providers"), None)
    if provider_index is not None:
        return "/".join(parts[provider_index + 1:]) or "Azure resource"
    if len(parts) >= 2 and parts[-2].lower() == "resourcegroups":
        return "/".join(parts[-2:])
    return "/".join(parts[-2:]) or "Azure resource"


def _request_id(headers):
    value = headers.get("x-ms-request-id") or headers.get("x-ms-correlation-request-id")
    return re.sub(r"[^A-Za-z0-9._-]", "", str(value))[:128] or "unavailable"


def _retry_after(headers):
    try:
        value = float(headers.get("Retry-After"))
    except (TypeError, ValueError):
        return None
    return max(0.0, value)


class _Azure:
    def __init__(self, config):
        self.config = config
        self.base = (f"/subscriptions/{config['subscriptionId']}/resourceGroups/"
                     f"{urllib.parse.quote(config['resourceGroup'], safe='')}")
    def _auth(self):
        try:
            _check_readiness()
            access = token(ARM_SCOPE, self.config["tenantId"], self.config.get("userObjectId"))
            _check_readiness()
            return access
        except AzureSignInError as exc:
            raise CloudError(str(exc)) from exc

    def request(self, path, version, method="GET", body=None, *, redact=False,
                redacted_error=None):
        url = f"{ARM}{path}?api-version={version}"
        return self._request(url, method, body, redact=redact,
                             resource_label=_arm_resource_label(path),
                             redacted_error=redacted_error)

    def _request(self, url, method="GET", body=None, *, redact=False, include_metadata=False,
                 timeout=ARM_REQUEST_TIMEOUT, resource_label=None, stage=None, log_request=True,
                 poll_number=None, origin_request_id=None, redacted_error=None):
        timeout = _readiness_timeout(timeout)
        url = _arm_url(url)
        resource_label = resource_label or _arm_resource_label(url)
        stage = stage or setup_progress()["stage"] or "outside-setup"
        started_at = time.monotonic()
        sensitive = redact or bool(body and any(
            item.get("value") for item in body.get("properties", {}).get(
                "configuration", {}).get("secrets", [])))
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Authorization": f"Bearer {self._auth()}"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        secret_error = None
        response_status = None
        request_id = "unavailable"
        retry_after = None
        if log_request:
            logger.info("Azure ARM request started stage=%s method=%s resource=%s",
                        stage, method, resource_label)
        try:
            request = urllib.request.Request(url, data=data, method=method, headers=headers)
            request_deadline = started_at + timeout
            attempt = 0
            while True:
                _check_readiness()
                if _setup_cancelled.is_set():
                    raise CloudError("Azure setup was stopped. Any accepted Azure operation may continue; "
                                     "inspect its status in Azure Portal before retrying.")
                attempt += 1
                remaining = request_deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Azure request deadline elapsed.")
                try:
                    with urllib.request.build_opener(_NoRedirect()).open(
                            request, timeout=_readiness_timeout(
                                min(ARM_REQUEST_TIMEOUT, remaining))) as response:
                        response_status = getattr(response, "status", None)
                        if response_status is None and callable(getattr(response, "getcode", None)):
                            response_status = response.getcode()
                        request_id = _request_id(response.headers)
                        retry_after = _retry_after(response.headers)
                        payload = response.read(2 * 1024 * 1024 + 1)
                        _check_readiness()
                        if len(payload) > 2 * 1024 * 1024:
                            raise CloudError(f"Azure returned an oversized response for {resource_label}.")
                        try:
                            result = json.loads(payload) if payload else {}
                        except (ValueError, UnicodeError) as exc:
                            logger.warning("Azure ARM response decode failed stage=%s method=%s "
                                           "resource=%s http_status=%s request_id=%s error_type=%s "
                                           "elapsed_seconds=%.2f",
                                           stage, method, resource_label, response_status, request_id,
                                           type(exc).__name__, time.monotonic() - started_at)
                            raise CloudError(
                                f"Azure returned invalid JSON for {resource_label} "
                                f"(HTTP {response_status}, request {request_id}).") from exc
                        async_operation = response.headers.get("Azure-AsyncOperation")
                        operation = async_operation or response.headers.get("Location")
                    break
                except urllib.error.HTTPError:
                    raise
                except (urllib.error.URLError, OSError) as exc:
                    if (method != "GET" or attempt >= ARM_GET_MAX_ATTEMPTS
                            or not _transient_transport_error(exc)):
                        raise
                    remaining = request_deadline - time.monotonic()
                    delay = min(max(ARM_GET_RETRY_BACKOFF * (2 ** (attempt - 1)),
                                    retry_after or 0), remaining)
                    if delay <= 0:
                        raise
                    category, error_type, reason_type, error_errno, error_winerror, reason = \
                        _transport_diagnostics(exc, sensitive=sensitive)
                    logger.warning("Azure ARM transient GET retry stage=%s method=%s resource=%s "
                                   "poll=%s attempt=%d max_attempts=%d origin_request_id=%s "
                                   "http_status=%s request_id=%s category=%s error_type=%s reason_type=%s "
                                   "errno=%s winerror=%s reason=%s retry_delay_seconds=%.2f "
                                   "elapsed_seconds=%.2f",
                                   stage, method, resource_label, poll_number or "n/a", attempt,
                                   ARM_GET_MAX_ATTEMPTS, origin_request_id or "unavailable",
                                   response_status or "unavailable", request_id, category, error_type,
                                   reason_type, error_errno, error_winerror, reason, delay,
                                   time.monotonic() - started_at)
                    try:
                        _wait_setup(delay, resource_label)
                    except CloudError as stopped:
                        raise stopped from exc
                    if time.monotonic() >= request_deadline:
                        raise
        except urllib.error.HTTPError as exc:
            response_status = exc.code
            request_id = _request_id(exc.headers or {})
            retry_after = _retry_after(exc.headers or {})
            if exc.code == 404 and method == "GET":
                if log_request:
                    logger.info("Azure ARM response stage=%s method=%s resource=%s http_status=%s "
                                "request_id=%s elapsed_seconds=%.2f",
                                stage, method, resource_label, exc.code, request_id,
                                time.monotonic() - started_at)
                return (None, exc.code, retry_after, request_id) if include_metadata else None
            if sensitive:
                logger.warning("Azure ARM request failed stage=%s method=%s resource=%s "
                               "http_status=%s request_id=%s retry_after_seconds=%s "
                               "elapsed_seconds=%.2f response_details=redacted",
                               stage, method, resource_label, exc.code, request_id, retry_after,
                               time.monotonic() - started_at)
                secret_error = redacted_error or (
                    f"Job secret could not be installed for {resource_label} (HTTP {exc.code}); "
                    "check Azure Job policy and permissions, then inspect any partially created "
                    "Job before retrying.")
            else:
                try:
                    details = json.loads(exc.read(32768)).get("error", {})
                    code = details.get("code", "")
                    message = details.get("message", "")
                except (ValueError, AttributeError):
                    code = message = ""
                code = _safe_azure_text(code) if code else "unknown"
                message = _safe_azure_text(message) if message else ""
                logger.warning(
                    "Azure ARM request failed stage=%s method=%s resource=%s http_status=%s "
                    "code=%s request_id=%s retry_after_seconds=%s message=%s elapsed_seconds=%.2f",
                    stage, method, resource_label, exc.code, code, request_id, retry_after,
                    message or "unavailable", time.monotonic() - started_at)
                if code == "RequestDisallowedByPolicy":
                    raise CloudError(
                        f"Azure policy denied {method} for {resource_label} "
                        f"(HTTP {exc.code}): {message} "
                        "This subscription may require a VNet-integrated Container Apps environment. "
                        "Select a delegated subnet or review and approve a new VNet in Cloud setup; "
                        "ask your Azure administrator which networking policy applies."
                    ) from exc
                if code in ("AuthorizationFailed", "LinkedAuthorizationFailed", "Microsoft.Authorization/roleAssignments/write") or exc.code == 403:
                    raise CloudError(
                        f"Azure {method} denied for {resource_label} "
                        f"(HTTP {exc.code}, {code or 'Forbidden'}): {message} "
                        "Ask an Azure administrator for permissions at the selected subscription/resource "
                        "group and User Access Administrator or RBAC Administrator for role assignments."
                    ) from exc
                if exc.code == 409:
                    wait = (f" Retry after {retry_after:g} seconds."
                            if retry_after is not None else "")
                    raise CloudError(
                        f"Azure resource conflict for {resource_label} (HTTP 409, {code}): {message} "
                        f"Check the existing operation before retrying.{wait}"
                    ) from exc
                if exc.code == 429:
                    wait = f"Retry after {retry_after:g} seconds." if retry_after is not None else "Retry later."
                    raise CloudError(
                        f"Azure throttled {method} for {resource_label} (HTTP 429, {code}): "
                        f"{message} {wait}"
                    ) from exc
                raise CloudError(f"Azure {method} failed for {resource_label} "
                                 f"(HTTP {exc.code}, {code}): {message} "
                                 "Check Azure quota, policy and resource names.") from exc
        except (urllib.error.URLError, OSError) as exc:
            category, error_type, reason_type, error_errno, error_winerror, reason = \
                _transport_diagnostics(exc, sensitive=sensitive)
            logger.warning("Azure ARM transport failure stage=%s method=%s resource=%s "
                           "poll=%s attempt=%d max_attempts=%d origin_request_id=%s "
                           "http_status=%s request_id=%s category=%s error_type=%s reason_type=%s "
                           "errno=%s winerror=%s reason=%s elapsed_seconds=%.2f",
                           stage, method, resource_label, poll_number or "n/a", attempt,
                           ARM_GET_MAX_ATTEMPTS if method == "GET" else 1,
                           origin_request_id or "unavailable",
                           response_status or "unavailable", request_id, category, error_type, reason_type,
                           error_errno, error_winerror, reason, time.monotonic() - started_at)
            if sensitive:
                secret_error = redacted_error or (
                    "Job secret could not be installed; check Azure connectivity and "
                    "inspect any partially created Job before retrying.")
            else:
                raise CloudError(f"Azure {method} request for {resource_label} failed after "
                                 f"{attempt} attempt(s); check connectivity and inspect the Azure "
                                 "Portal before retrying.") from exc
        if secret_error:
            raise CloudError(secret_error) from None
        if not isinstance(result, dict):
            logger.error("Azure ARM returned an invalid response stage=%s method=%s resource=%s "
                         "http_status=%s request_id=%s elapsed_seconds=%.2f",
                         stage, method, resource_label, response_status, request_id,
                         time.monotonic() - started_at)
            raise CloudError(f"Azure returned an invalid response for {resource_label}.")
        if log_request:
            logger.info("Azure ARM response stage=%s method=%s resource=%s http_status=%s "
                        "request_id=%s retry_after_seconds=%s elapsed_seconds=%.2f",
                        stage, method, resource_label, response_status, request_id, retry_after,
                        time.monotonic() - started_at)
        if method in ("PUT", "POST", "PATCH") and operation:
            operation_request_id = request_id
            operation = _arm_url(operation)
            query = urllib.parse.urlsplit(operation).query
            if not any(key.lower() == "api-version" for key, _ in urllib.parse.parse_qsl(
                    query, keep_blank_values=True)):
                version = next((value for key, value in urllib.parse.parse_qsl(
                    urllib.parse.urlsplit(url).query) if key.lower() == "api-version"), None)
                if not version:
                    raise CloudError("Azure returned an operation URL without an API version.")
                operation += ("&" if query else "?") + urllib.parse.urlencode({"api-version": version})
            location_operation = not async_operation
            operation_type = "Azure-AsyncOperation" if async_operation else "Location"
            operation_label = "async operation" if async_operation else "Location operation"
            logger.info("Azure ARM long-running operation started stage=%s method=%s resource=%s "
                        "lro_type=%s http_status=%s request_id=%s retry_after_seconds=%s",
                        stage, method, resource_label, operation_type, response_status,
                        request_id, retry_after)
            deadline = time.monotonic() + ARM_OPERATION_TIMEOUT
            poll_delay = retry_after if retry_after is not None else ARM_POLL_INTERVAL
            last_poll = object()
            poll_number = 0
            state = None
            outcome = None
            while poll_number < 360:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                _progress_step(detail=f"Waiting for Azure {operation_label} for "
                                      f"{resource_label} to finish.")
                _wait_setup(min(poll_delay, remaining), resource_label)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                poll_number += 1
                state, response_status, retry_after, request_id = self._request(
                    operation, redact=sensitive, include_metadata=True,
                    timeout=min(ARM_REQUEST_TIMEOUT, remaining), resource_label=resource_label,
                    stage=stage, log_request=False, poll_number=poll_number,
                    origin_request_id=operation_request_id, redacted_error=redacted_error)
                properties = state.get("properties", {}) if state else {}
                raw_outcome = (state.get("status") or properties.get("provisioningState")
                               or properties.get("status")) if state else None
                outcome = raw_outcome
                if location_operation:
                    if response_status == 202:
                        outcome = None
                    elif response_status in (200, 204) and outcome not in ("Failed", "Canceled"):
                        outcome = "Succeeded"
                poll_key = (response_status, raw_outcome, outcome)
                logger.info("Azure ARM long-running poll stage=%s method=%s resource=%s "
                            "lro_type=%s poll=%d http_status=%s operation_status=%s "
                            "completion_state=%s status_changed=%s request_id=%s "
                            "origin_request_id=%s retry_after_seconds=%s elapsed_seconds=%.2f",
                            stage, method, resource_label, operation_type, poll_number,
                            response_status, _safe_azure_text(raw_outcome or "pending")[:80],
                            outcome or "pending", poll_key != last_poll, request_id,
                            operation_request_id, retry_after,
                            time.monotonic() - started_at)
                last_poll = poll_key
                if outcome in ("Succeeded", "Failed", "Canceled"):
                    if outcome != "Succeeded":
                        error_code = error_message = ""
                        if not sensitive:
                            error = state.get("error")
                            if not isinstance(error, dict):
                                error = properties.get("error")
                            if isinstance(error, dict):
                                code = error.get("code")
                                message = error.get("message")
                                details = []
                                if isinstance(code, str) and code.strip():
                                    error_code = _safe_azure_text(code)[:120]
                                    details.append(error_code)
                                if isinstance(message, str) and message.strip():
                                    error_message = _safe_azure_text(message)
                                    details.append(error_message)
                                if details:
                                    logger.error("Azure ARM long-running operation failed stage=%s "
                                                 "method=%s resource=%s lro_type=%s status=%s "
                                                 "error_code=%s error_message=%s request_id=%s "
                                                 "elapsed_seconds=%.2f",
                                                 stage, method, resource_label, operation_type, outcome,
                                                 error_code, error_message, request_id,
                                                 time.monotonic() - started_at)
                                    raise CloudError(
                                        f"Azure operation for {resource_label} failed "
                                        f"({': '.join(details)}).")
                        logger.error("Azure ARM long-running operation failed stage=%s method=%s "
                                     "resource=%s lro_type=%s status=%s request_id=%s "
                                     "elapsed_seconds=%.2f error_details=redacted",
                                     stage, method, resource_label, operation_type, outcome,
                                     request_id, time.monotonic() - started_at)
                        raise CloudError(
                            f"Azure operation for {resource_label} failed; inspect its deployment "
                            "in Azure Portal before retrying.")
                    logger.info("Azure ARM long-running operation succeeded stage=%s method=%s "
                                "resource=%s lro_type=%s status=%s poll=%d request_id=%s "
                                "elapsed_seconds=%.2f",
                                stage, method, resource_label, operation_type, outcome,
                                poll_number, request_id, time.monotonic() - started_at)
                    if method in ("POST", "PATCH") and not result:
                        result = state
                    break
                poll_delay = retry_after if retry_after is not None else ARM_POLL_INTERVAL
            if outcome not in ("Succeeded", "Failed", "Canceled"):
                elapsed = time.monotonic() - started_at
                logger.error("Azure ARM long-running operation timed out stage=%s method=%s "
                             "resource=%s lro_type=%s polls=%d timeout_seconds=%d "
                             "elapsed_seconds=%.2f request_id=%s",
                             stage, method, resource_label, operation_type, poll_number,
                             ARM_OPERATION_TIMEOUT, elapsed, request_id)
                raise CloudError(
                    f"Azure operation for {resource_label} did not finish within its "
                    "30-minute/360-poll limit. Check its provisioning state in Azure Portal "
                    "before retrying.")
        return ((result, response_status, retry_after, request_id)
                if include_metadata else result)

    def create(self, path, version, body, *, reuse=False):
        previous = self.request(path, version)
        if previous:
            if reuse:
                return previous
            raise CloudError(f"Azure resource already exists: {path.rsplit('/', 1)[-1]}. "
                             "Choose a different name under Advanced or use another resource group.")
        self.request(path, version, "PUT", body)
        created = self.request(path, version, redact=True) if body.get(
            "properties", {}).get("configuration", {}).get("secrets") else self.request(path, version)
        if not created:
            raise CloudError("Azure accepted provisioning but the resource is not visible yet; "
                             "check Azure Portal before retrying the same setup.")
        return created


def _resource(azure, provider, kind, name):
    return f"{azure.base}/providers/{provider}/{kind}/{name}"


def _require_saved_cloud_config(values, *, require_prepared):
    try:
        fields = (*FIELDS, *SETUP_FIELDS)
        expected = _setup(values)
        saved = json.loads(_setting("cloud_config") or "null")
        saved_setup = _setup(saved) if isinstance(saved, dict) else None
        if (not isinstance(saved, dict) or not saved.get("userObjectId") or saved_setup is None
                or any(saved_setup[key] != expected[key] for key in fields)):
            raise CloudError("The saved Azure subscription or resource configuration changed; review Cloud setup.")
        if require_prepared:
            prepared = json.loads(_setting("cloud_prepared") or "null")
            prepared_setup = _setup(prepared) if isinstance(prepared, dict) else None
            if (prepared_setup is None
                    or any(prepared_setup[key] != expected[key] for key in fields)
                    or _setting("cloud_environment_ready") != "yes"):
                raise CloudError("The saved Azure environment is not ready for log configuration.")
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise CloudError("The saved Azure configuration is invalid; review Cloud setup.") from exc


def _ensure_log_analytics_workspace(azure, values):
    path = _resource(azure, "Microsoft.OperationalInsights", "workspaces", LOG_ANALYTICS_WORKSPACE)
    workspace = azure.request(path, LOG_ANALYTICS_API_VERSION)
    if workspace is None:
        azure.request(path, LOG_ANALYTICS_API_VERSION, "PUT", {
            "location": values["location"],
            "properties": {
                "sku": {"name": "PerGB2018"},
                "retentionInDays": LOG_ANALYTICS_RETENTION_DAYS,
            },
        })
        workspace = azure.request(path, LOG_ANALYTICS_API_VERSION)
    if not isinstance(workspace, dict):
        raise CloudError("The Log Analytics workspace is not available after provisioning.")
    properties = workspace.get("properties")
    workspace_id = workspace.get("id")
    sku = workspace.get("sku") or (properties.get("sku") if isinstance(properties, dict) else None)
    if (not isinstance(properties, dict)
            or str(workspace.get("location", "")).replace(" ", "").casefold()
                != values["location"].replace(" ", "").casefold()
            or not isinstance(sku, dict)
            or sku.get("name") != "PerGB2018"
            or properties.get("retentionInDays") != LOG_ANALYTICS_RETENTION_DAYS
            or properties.get("provisioningState") not in (None, "Succeeded")
            or not isinstance(workspace_id, str)
            or workspace_id.casefold() != path.casefold()):
        raise CloudError("The existing Log Analytics workspace is incompatible; Mizan did not change it.")
    customer_id = properties.get("customerId")
    try:
        customer_id = str(UUID(customer_id))
    except (TypeError, ValueError, AttributeError) as exc:
        raise CloudError("Azure returned an invalid Log Analytics workspace ID.") from exc
    keys = azure.request(
        f"{path}/sharedKeys", LOG_ANALYTICS_API_VERSION, "POST", redact=True,
        redacted_error="Azure Log Analytics shared keys could not be retrieved; check workspace permissions.",
    )
    shared_key = keys.get("primarySharedKey") if isinstance(keys, dict) else None
    if not isinstance(shared_key, str) or not shared_key:
        raise CloudError("Azure did not return a usable Log Analytics workspace key.")
    return {"id": workspace_id, "customerId": customer_id,
            "location": workspace["location"]}, shared_key


def _assert_job_executions_terminal(azure, values, *, require_job):
    job_path = _resource(azure, "Microsoft.App", "jobs", values["jobName"])
    job = azure.request(job_path, "2024-03-01")
    if job is None:
        if require_job or _setting("cloud_job_created"):
            raise CloudError("The saved Azure GPU Job is not available; Mizan did not change the environment.")
        return
    executions_path = f"{job_path}/executions"
    expected_path = urllib.parse.urlsplit(ARM + executions_path).path.casefold()
    url = f"{ARM}{executions_path}?api-version=2024-03-01"
    seen = set()
    for _ in range(100):
        url = _arm_url(url)
        parsed = urllib.parse.urlsplit(url)
        if (parsed.path.casefold() != expected_path
                or not any(key.casefold() == "api-version" for key, _ in
                           urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
                or url in seen):
            raise CloudError("Azure returned an unsafe or repeated GPU Job execution page; no environment change was made.")
        seen.add(url)
        page = azure._request(url, resource_label="Microsoft.App/jobs/executions")
        entries = page.get("value") if isinstance(page, dict) else None
        if not isinstance(entries, list):
            raise CloudError("Azure returned an invalid GPU Job execution page; no environment change was made.")
        for entry in entries:
            properties = entry.get("properties") if isinstance(entry, dict) else None
            status = properties.get("status") if isinstance(properties, dict) else None
            if status not in TERMINAL_JOB_STATUSES:
                raise CloudError("A GPU Job execution is active or has an unknown status; "
                                 "wait for it to finish before configuring logs.")
        next_link = page.get("nextLink")
        if not next_link:
            return
        if not isinstance(next_link, str):
            raise CloudError("Azure returned an invalid GPU Job execution page link; no environment change was made.")
        url = next_link
    raise CloudError("Azure returned too many GPU Job execution pages; no environment change was made.")


def _environment_without_log_settings(environment, values):
    if not isinstance(environment, dict) or not isinstance(environment.get("properties"), dict):
        raise CloudError("The Azure Container Apps environment returned an invalid configuration.")
    properties = environment["properties"]
    profiles = properties.get("workloadProfiles")
    if (str(environment.get("location", "")).replace(" ", "").casefold()
            != values["location"].replace(" ", "").casefold()
            or properties.get("provisioningState") != "Succeeded"
            or not isinstance(profiles, list)
            or not any(profile.get("name") == GPU_PROFILE
                       and profile.get("workloadProfileType") == GPU_TYPE
                       for profile in profiles if isinstance(profile, dict))):
        raise CloudError("The Azure environment is not ready with the saved A100 profile and region.")
    expected_subnet = values.get("subnetResourceId")
    if not expected_subnet and values.get("vnet"):
        expected_subnet = (
            f"/subscriptions/{values['subscriptionId']}/resourceGroups/"
            f"{urllib.parse.quote(values['resourceGroup'], safe='')}/providers/"
            f"Microsoft.Network/virtualNetworks/{values['vnet']}/subnets/{values['subnet']}"
        )
    network = properties.get("vnetConfiguration") or {}
    if not isinstance(network, dict):
        raise CloudError("The Azure environment network configuration is invalid.")
    actual_subnet = network.get("infrastructureSubnetId")
    if expected_subnet and (not isinstance(actual_subnet, str)
                            or actual_subnet.casefold() != expected_subnet.casefold()):
        raise CloudError("The Azure environment network does not match the saved setup.")
    snapshot = copy.deepcopy(environment)
    for key in ("id", "name", "type", "systemData", "etag"):
        snapshot.pop(key, None)
    snapshot_properties = snapshot["properties"]
    for key in ("appLogsConfiguration", "provisioningState", "provisioningStateDetail"):
        snapshot_properties.pop(key, None)
    return snapshot


def _enable_log_analytics(azure, values, *, require_prepared):
    workspace, shared_key = _ensure_log_analytics_workspace(azure, values)
    _require_saved_cloud_config(values, require_prepared=require_prepared)
    _assert_job_executions_terminal(
        azure, values, require_job=bool(_setting("cloud_job_created")))
    environment_path = _resource(azure, "Microsoft.App", "managedEnvironments", values["environment"])
    environment = azure.request(environment_path, "2024-03-01")
    before = _environment_without_log_settings(environment, values)
    current = environment["properties"].get("appLogsConfiguration")
    current_logs = current.get("logAnalyticsConfiguration") if isinstance(current, dict) else None
    current_customer_id = current_logs.get("customerId") if isinstance(current_logs, dict) else None
    if not (isinstance(current, dict)
            and current.get("destination") == "log-analytics"
            and isinstance(current_customer_id, str)
            and current_customer_id.casefold()
                == workspace["customerId"].casefold()):
        azure.request(environment_path, "2024-03-01", "PATCH", {
            "properties": {
                "appLogsConfiguration": {
                    "destination": "log-analytics",
                    "logAnalyticsConfiguration": {
                        "customerId": workspace["customerId"],
                        "sharedKey": shared_key,
                    },
                },
            },
        }, redact=True,
            redacted_error="Azure Log Analytics settings could not be saved for the Container Apps environment.",
        )
    verified = azure.request(environment_path, "2024-03-01")
    after = _environment_without_log_settings(verified, values)
    logs = verified["properties"].get("appLogsConfiguration")
    verified_logs = logs.get("logAnalyticsConfiguration") if isinstance(logs, dict) else None
    verified_customer_id = verified_logs.get("customerId") if isinstance(verified_logs, dict) else None
    if (before != after or not isinstance(logs, dict)
            or logs.get("destination") != "log-analytics"
            or not isinstance(verified_customer_id, str)
            or verified_customer_id.casefold()
                != workspace["customerId"].casefold()):
        raise CloudError("Azure did not confirm the Log Analytics connection or changed protected environment settings.")
    safe_workspace = {key: workspace[key] for key in ("id", "customerId", "location")}
    _setting("cloud_log_analytics_workspace", json.dumps(safe_workspace))
    return safe_workspace


def enable_log_analytics(consent=False):
    if consent is not True:
        raise CloudError("Approve Log Analytics ingestion charges and 30-day retention before connecting Azure logs.")
    try:
        saved = json.loads(_setting("cloud_config") or "null")
        if not isinstance(saved, dict):
            raise CloudError("Save the exact Azure setup before connecting logs.")
        values = _setup(saved)
        if not _setting("cloud_job_created"):
            raise CloudError("The existing Azure GPU Job must be saved before connecting logs.")
        _require_saved_cloud_config(values, require_prepared=True)
        azure = _Azure(values)
        azure._auth()
        group = azure.request(azure.base, "2024-03-01")
        if (not group or str(group.get("location", "")).replace(" ", "").casefold()
                != values["location"].replace(" ", "").casefold()):
            raise CloudError("The saved Azure resource group is unavailable or has a different region.")
        workspace = _enable_log_analytics(azure, values, require_prepared=True)
        return {"ok": True, "workspaceId": workspace["id"],
                "customerId": workspace["customerId"], "location": workspace["location"]}
    except (ValueError, TypeError, json.JSONDecodeError, AzureSignInError) as exc:
        raise CloudError(f"Could not connect Azure Log Analytics: {exc}") from exc


def _worker_source():
    try:
        return worker_source()
    except OSError as exc:
        raise CloudError("Bundled GPU worker source is missing; reinstall Mizan before building.") from exc
    except ValueError as exc:
        raise CloudError("Bundled GPU worker source does not satisfy the Docker build contract.") from exc


def _image_digest(config, image):
    expected = f"{config['registry']}.azurecr.io/mizan-aca-gpu@"
    if not isinstance(image, str) or not image.startswith(expected):
        raise CloudError("Choose an image in the configured ACR pinned by its build digest.")
    digest = image.removeprefix(expected)
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise CloudError("The GPU Job image must use a sha256 manifest digest.")
    try:
        recorded = json.loads(_setting("cloud_built_image") or "{}")
    except ValueError as exc:
        raise CloudError("ACR build record is invalid; rebuild the bundled worker.") from exc
    if not isinstance(recorded, dict):
        raise CloudError("ACR build record is invalid; rebuild the bundled worker.")
    if (recorded.get("image") == image
            and recorded.get("sourceHash") in (_worker_source()[1], LEGACY_AZURE_SOURCE_HASH)):
        return digest
    if (_setting("cloud_reuse") == "yes" or _setting("cloud_imported_digest") == digest
            ) and digest == SUPPORTED_WORKER_DIGEST:
        return digest
    raise CloudError("This image was not built from the current bundled worker source. "
                     "Build the worker in the selected ACR again; a prior pilot digest "
                     "does not identify a fresh build.")


def _job_image_matches(config, image, job_image):
    """Verify a Job's pinned image or existing-pilot ACR tag against the approved digest."""
    digest = _image_digest(config, image)
    if job_image == image:
        reference = digest
    elif _setting("cloud_reuse") == "yes" and isinstance(job_image, str):
        repository = f"{config['registry']}.azurecr.io/mizan-aca-gpu"
        match = re.fullmatch(
            rf"{re.escape(repository)}:([A-Za-z0-9_][A-Za-z0-9_.-]{{0,127}})", job_image)
        if not match:
            return False
        reference = match[1]
    else:
        return False
    _registry_manifest(config, reference, digest)
    return True


def _job_update_display(value):
    if value in (None, ""):
        return "Not set"
    if isinstance(value, (dict, list)):
        return json.dumps(value, sort_keys=True, separators=(",", ":"))
    return str(value)


def _job_update_plan(job_name, previous, image, environment, identity,
                     identity_client_id, values):
    """Build a narrowly scoped merge patch and a displayable confirmation plan."""
    properties = previous.get("properties")
    if not isinstance(properties, dict):
        raise CloudError("The existing GPU Job configuration is incomplete; Mizan will not change it.")
    configuration = properties.get("configuration")
    if not isinstance(configuration, dict) or configuration.get("triggerType") != "Manual":
        raise CloudError("The existing Job is not a manual Mizan GPU Job; Mizan will not change it.")
    template = properties.get("template")
    containers = template.get("containers") if isinstance(template, dict) else None
    if (not isinstance(containers, list) or len(containers) != 1
            or not isinstance(containers[0], dict)
            or containers[0].get("name") != "mizan-worker"):
        raise CloudError("The existing Job does not have the single Mizan worker container; "
                         "Mizan will not change it.")

    container = copy.deepcopy(containers[0])
    repository = f"{values['registry']}.azurecr.io/mizan-aca-gpu"
    current_image = container.get("image")
    if (not isinstance(current_image, str)
            or not re.fullmatch(
                rf"{re.escape(repository)}(?:(?:@sha256:[a-f0-9]{{64}})|"
                r":(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))", current_image)):
        raise CloudError("The existing Job image is not in the selected Mizan registry; "
                         "Mizan will not change it.")

    secrets = configuration.get("secrets", [])
    env = container.get("env", [])
    hf_secrets = [item for item in secrets if isinstance(item, dict)
                  and item.get("name") == "hf-token"] if isinstance(secrets, list) else []
    hf_bindings = [item for item in env if isinstance(item, dict)
                   and item.get("name") == "HF_TOKEN"] if isinstance(env, list) else []
    if (len(hf_secrets) != 1 or len(hf_bindings) != 1
            or hf_bindings[0].get("secretRef") != "hf-token"
            or hf_bindings[0].get("value")):
        raise CloudError("The existing GPU Job is missing its required HF_TOKEN secret binding. "
                         "Mizan will not replace its secret or transfer a token.")
    if not isinstance(env, list) or any(not isinstance(item, dict) for item in env):
        raise CloudError("The existing Job environment is ambiguous; Mizan will not change it.")

    changes = []
    container_changed = False

    def add_change(field, current, target):
        if current != target:
            changes.append({
                "field": field,
                "current": _job_update_display(current),
                "target": _job_update_display(target),
            })

    properties_patch = {}
    if properties.get("environmentId") != environment:
        add_change("Container Apps environment", properties.get("environmentId"), environment)
        properties_patch["environmentId"] = environment
    if properties.get("workloadProfileName") != GPU_PROFILE:
        add_change("GPU workload profile", properties.get("workloadProfileName"), GPU_PROFILE)
        properties_patch["workloadProfileName"] = GPU_PROFILE
    if current_image != image:
        add_change("Worker image (SHA-256 digest)", current_image, image)
        container["image"] = image
        container_changed = True

    existing_resources = container.get("resources")
    matched_resources = next(
        (candidate for candidate in EXISTING_JOB_RESOURCES
         if _job_resources_match(existing_resources, candidate)), None)
    resources = matched_resources or JOB_RESOURCES
    if not _job_resources_match(existing_resources, resources):
        current = (f"{existing_resources.get('cpu')} vCPU / {existing_resources.get('memory')}"
                   if isinstance(existing_resources, dict) else "Not set")
        target = f"{resources['cpu']} vCPU / {resources['memory']}"
        add_change("Worker CPU and memory", current, target)
        container["resources"] = copy.deepcopy(resources)
        container_changed = True

    current_identity = previous.get("identity")
    if current_identity is None:
        current_identity = {}
    if not isinstance(current_identity, dict):
        raise CloudError("The existing Job identity is ambiguous; Mizan will not change it.")
    assigned = current_identity.get("userAssignedIdentities", {})
    if not isinstance(assigned, dict) or any(not isinstance(key, str) for key in assigned):
        raise CloudError("The existing Job identity is ambiguous; Mizan will not change it.")
    identity_type = current_identity.get("type")
    if identity_type is not None and not isinstance(identity_type, str):
        raise CloudError("The existing Job identity is ambiguous; Mizan will not change it.")
    current_types = {part.strip() for part in (identity_type or "").split(",") if part.strip()}
    if current_types - {"SystemAssigned", "UserAssigned"}:
        raise CloudError("The existing Job identity has an unsupported type; Mizan will not change it.")
    assigned_identity = next(
        (name for name in assigned if name.lower() == identity.lower()), None)
    target_types = current_types | {"UserAssigned"}
    identity_patch = {}
    if target_types != current_types:
        identity_patch["type"] = ", ".join(
            kind for kind in ("SystemAssigned", "UserAssigned") if kind in target_types)
    if assigned_identity is None:
        identity_patch.setdefault("userAssignedIdentities", {})[identity] = {}
    current_identity_text = (
        f"{', '.join(kind for kind in ('SystemAssigned', 'UserAssigned') if kind in current_types) or 'None'}; "
        f"assigned: {', '.join(sorted(assigned, key=str.lower)) or 'none'}"
    )
    target_names = sorted(
        assigned if assigned_identity is not None else {*assigned, identity},
        key=str.lower)
    target_identity_text = (
        f"{', '.join(kind for kind in ('SystemAssigned', 'UserAssigned') if kind in target_types)}; "
        f"assigned: {', '.join(target_names)}"
    )
    add_change("Managed identity", current_identity_text, target_identity_text)

    registries = configuration.get("registries", [])
    if not isinstance(registries, list) or any(not isinstance(item, dict) for item in registries):
        raise CloudError("The existing Job registry settings are ambiguous; Mizan will not change them.")
    registry_server = f"{values['registry']}.azurecr.io"
    registry_indexes = [index for index, item in enumerate(registries)
                        if item.get("server", "").lower() == registry_server.lower()]
    if len(registry_indexes) > 1:
        raise CloudError("The existing Job has duplicate settings for the selected registry; "
                         "Mizan will not change them.")
    registry_identity = None
    if registry_indexes:
        registry_identity = registries[registry_indexes[0]].get("identity")
        if not isinstance(registry_identity, str) or registry_identity.lower() != identity.lower():
            add_change("Registry pull identity", registry_identity, identity)
            registries = copy.deepcopy(registries)
            registries[registry_indexes[0]]["identity"] = identity
    else:
        add_change("Registry pull identity", "Not configured", identity)
        registries = [*copy.deepcopy(registries), {"server": registry_server, "identity": identity}]
    if registry_identity is None or registry_identity.lower() != identity.lower():
        properties_patch.setdefault("configuration", {})["registries"] = registries

    target_environment = {
        "AZURE_STORAGE_BLOB_URL": f"https://{values['storageAccount']}.blob.core.windows.net",
        "AZURE_STORAGE_CONTAINER": values["container"],
        "AZURE_CLIENT_ID": identity_client_id,
    }
    for name, target in target_environment.items():
        matches = [item for item in env if item.get("name") == name]
        if len(matches) > 1:
            raise CloudError(f"The existing Job has duplicate {name} settings; Mizan will not change it.")
        if matches and (matches[0].get("secretRef") or matches[0].get("valueFrom")):
            raise CloudError(f"The existing Job {name} setting is secret-backed; Mizan will not replace it.")
        current = matches[0].get("value") if matches else None
        if current != target:
            add_change(name.replace("_", " "), current, target)
            if matches:
                matches[0]["value"] = target
            else:
                env.append({"name": name, "value": target})
            container_changed = True

    if container_changed:
        properties_patch.setdefault("template", {})["containers"] = [container]
    patch = {}
    if properties_patch:
        patch["properties"] = properties_patch
    if identity_patch:
        patch["identity"] = identity_patch
    confirmation_id = hashlib.sha256(json.dumps({
        "job": {key: values.get(key) for key in (*FIELDS, *SETUP_FIELDS)},
        "changes": changes,
    }, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return {
        "patch": patch,
        "changes": changes,
        "confirmationId": confirmation_id,
        "resources": resources,
    }


def _require_fresh_worker_build(image):
    try:
        built = json.loads(_setting("cloud_built_image") or "{}")
    except (TypeError, ValueError) as exc:
        raise CloudError("Build the GPU worker in the selected registry before updating the Job.") from exc
    if (not isinstance(built, dict) or built.get("image") != image
            or built.get("sourceHash") != _worker_source()[1]):
        raise CloudError("Build the current GPU worker in the selected registry before updating the Job.")


def list_subscriptions():
    """List subscriptions visible to the currently signed-in desktop user."""
    _progress_step("authentication", 0, "Checking the signed-in Azure identity.")
    try:
        access = token(ARM_SCOPE)
    except AzureSignInError as exc:
        raise CloudError(str(exc)) from exc
    url = f"{ARM}/subscriptions?api-version=2022-12-01"
    subscriptions = []
    for page_number in range(1, 21):
        _progress_step("subscriptions", 1, f"Loading Azure subscription page {page_number}.")
        if not url.startswith(f"{ARM}/subscriptions?"):
            raise CloudError("Azure returned an unsafe subscription page URL.")
        try:
            with urllib.request.build_opener(_NoRedirect()).open(
                    urllib.request.Request(url, headers={"Authorization": "Bearer " + access}),
                    timeout=30) as response:
                page = json.load(response)
        except urllib.error.HTTPError as exc:
            raise CloudError(f"Azure could not list subscriptions (HTTP {exc.code}); "
                             "sign in with an identity that has subscription access.") from exc
        except (urllib.error.URLError, ValueError) as exc:
            raise CloudError("Azure could not list subscriptions; check sign-in and network access.") from exc
        if not isinstance(page, dict) or not isinstance(page.get("value"), list):
            raise CloudError("Azure returned an invalid subscription list.")
        for entry in page["value"]:
            if (isinstance(entry, dict) and isinstance(entry.get("subscriptionId"), str)
                    and isinstance(entry.get("tenantId"), str)):
                subscriptions.append({key: entry.get(key) for key in (
                    "subscriptionId", "displayName", "tenantId", "state")})
        url = page.get("nextLink")
        if not url:
            return subscriptions
    raise CloudError("Azure returned too many subscription pages; retry from Azure Portal.")


def _grant_roles(azure, config, identity):
    """Assign narrowly scoped data roles; missing RBAC is an error, never readiness."""
    desktop_claims = claims(azure._auth())
    desktop = desktop_claims["oid"]
    desktop_type = ("ServicePrincipal" if desktop_claims.get("idtyp") == "app"
                    or (not desktop_claims.get("scp") and desktop_claims.get("appid")
                        and desktop_claims.get("roles")) else "User")
    principal = identity["properties"]["principalId"]
    storage = _resource(azure, "Microsoft.Storage", "storageAccounts", config["storageAccount"])
    registry = _resource(azure, "Microsoft.ContainerRegistry", "registries", config["registry"])
    for scope, grantee, role in (
        (f"{storage}/blobServices/default/containers/{config['container']}", desktop, DATA_CONTRIBUTOR),
        (f"{storage}/blobServices/default/containers/{config['container']}", principal, DATA_CONTRIBUTOR),
        (registry, desktop, ACR_PULL),
        (registry, principal, ACR_PULL),
    ):
        _progress_step("roles", 9, "Checking or assigning Blob and registry access.")
        page_url = (f"{ARM}{scope}/providers/Microsoft.Authorization/roleAssignments"
                    "?api-version=2022-04-01&%24filter=atScope%28%29")
        existing = False
        for _ in range(10):
            page = azure._request(page_url)
            existing = existing or any(
                grant.get("properties", {}).get("scope", "").lower() == scope.lower()
                and grant.get("properties", {}).get("principalId", "").lower() == grantee.lower()
                and grant.get("properties", {}).get("roleDefinitionId", "").lower().endswith(f"/{role}")
                for grant in page.get("value", []))
            page_url = page.get("nextLink")
            if not page_url:
                break
        else:
            raise CloudError("Azure RBAC returned too many pages; inspect role assignments in Azure Portal.")
        if existing:
            continue
        grant_id = uuid5(UUID("12a807b0-dae2-4c2b-b03f-9047f17f99af"),
                         f"{scope.lower()}:{grantee.lower()}:{role}")
        role_id = f"/subscriptions/{config['subscriptionId']}/providers/Microsoft.Authorization/roleDefinitions/{role}"
        assignment = (f"{scope}/providers/Microsoft.Authorization/roleAssignments/{grant_id}")
        if not azure.request(assignment, "2022-04-01"):
            try:
                azure.request(assignment, "2022-04-01", "PUT", {
                    "properties": {"roleDefinitionId": role_id, "principalId": grantee,
                                   "principalType": desktop_type if grantee == desktop else "ServicePrincipal"}})
            except CloudError as exc:
                raise CloudError(f"Unable to assign {role} at {scope}. "
                                 "Ask a User Access Administrator or RBAC Administrator to grant "
                                 "Storage Blob Data Contributor to the selected identity and job identity, "
                                 "and AcrPull to the job identity; then retry. "
                                 f"Azure detail: {exc}") from exc


def _roles_ready(azure, config, identity):
    try:
        desktop = claims(azure._auth())["oid"]
    except AzureSignInError as exc:
        raise CloudError(str(exc)) from exc
    principal = identity.get("properties", {}).get("principalId")
    if not principal:
        raise CloudError("The managed identity principal ID is not ready for RBAC preflight.")
    storage = _resource(azure, "Microsoft.Storage", "storageAccounts", config["storageAccount"])
    registry = _resource(azure, "Microsoft.ContainerRegistry", "registries", config["registry"])
    scopes = (
        (f"{storage}/blobServices/default/containers/{config['container']}", desktop, DATA_CONTRIBUTOR,
         "Selected Azure identity needs Storage Blob Data Contributor on the container."),
        (f"{storage}/blobServices/default/containers/{config['container']}", principal, DATA_CONTRIBUTOR,
         "Job managed identity needs Storage Blob Data Contributor on the container."),
        (registry, principal, ACR_PULL, "Job managed identity needs AcrPull on the registry."),
    )
    assignments = {}
    for scope in {item[0] for item in scopes}:
        path = (f"{ARM}{scope}/providers/Microsoft.Authorization/roleAssignments"
                "?api-version=2022-04-01&%24filter=atScope%28%29")
        grants = []
        for _ in range(10):
            page = azure._request(path)
            grants.extend(page.get("value", []))
            path = page.get("nextLink")
            if not path:
                break
        else:
            raise CloudError("Azure RBAC preflight returned too many pages; review the scope in Azure Portal.")
        assignments[scope] = grants
    for scope, grantee, role, message in scopes:
        if not any(
                grant.get("properties", {}).get("scope", "").lower() == scope.lower()
                and grant.get("properties", {}).get("principalId", "").lower() == grantee.lower()
                and grant.get("properties", {}).get("roleDefinitionId", "").lower().endswith(f"/{role}")
                for grant in assignments[scope]):
            raise CloudError(f"Azure RBAC action required: {message} "
                             "Role assignments may take several minutes to propagate; "
                             "an RBAC Administrator can grant roles at these scopes.")


def _check_existing(resource, label, *, location=None, properties=None):
    if location and resource.get("location", "").replace(" ", "").lower() != location:
        raise CloudError(f"Existing {label} is not in the selected GPU region.")
    for key, expected in (properties or {}).items():
        if resource.get("properties", {}).get(key) != expected:
            raise CloudError(f"Existing {label} has an incompatible {key}; no changes were made to it.")


def _check_subnet(resource):
    if not any(item.get("properties", {}).get("serviceName") == "Microsoft.App/environments"
               for item in resource.get("properties", {}).get("delegations", [])):
        raise CloudError("Existing subnet must be delegated to Microsoft.App/environments.")


def _environment_ready(azure, path, *, wait=False):
    resource_label = _arm_resource_label(path)
    started_at = time.monotonic()
    last_state = object()
    state = None
    for poll_number in range(1, 361 if wait else 2):
        environment = azure.request(path, "2024-03-01")
        properties = (environment or {}).get("properties", {})
        state = properties.get("provisioningState")
        if state != last_state:
            logger.info("Azure environment readiness stage=environment resource=%s "
                        "provisioning_state=%s poll=%d elapsed_seconds=%.2f",
                        resource_label, _safe_azure_text(state or "unavailable")[:80],
                        poll_number, time.monotonic() - started_at)
            last_state = state
        if state == "Succeeded":
            return environment
        _setting("cloud_prepared", "")
        _setting("cloud_environment_ready", "")
        if state in ("Failed", "Canceled"):
            error = properties.get("error")
            code = _safe_azure_text(error.get("code"))[:120] if isinstance(error, dict) \
                and error.get("code") else ""
            message = _safe_azure_text(error.get("message")) if isinstance(error, dict) \
                and error.get("message") else ""
            logger.error("Azure environment provisioning failed stage=environment resource=%s "
                         "status=%s error_code=%s error_message=%s elapsed_seconds=%.2f",
                         resource_label, state, code or "unavailable", message or "unavailable",
                         time.monotonic() - started_at)
            details = f" ({code}: {message})" if code or message else ""
            raise CloudError(f"The Container Apps GPU environment failed to provision for "
                             f"{resource_label}{details}. Check its "
                             "deployment in Azure Portal, including regional A100 capacity. "
                             "Retry provisioning later or choose another GPU region and new resource names.")
        if not wait or state not in ("Accepted", "Creating", "Updating", "InProgress"):
            raise CloudError(f"The Container Apps GPU environment is not provisioned yet for "
                             f"{resource_label}. "
                             "Check its deployment in Azure Portal before creating the Job.")
        _progress_step(detail=f"Waiting for the Container Apps GPU environment "
                              f"{resource_label} to be ready.")
        time.sleep(5)
    logger.error("Azure environment readiness timed out stage=environment resource=%s "
                 "provisioning_state=%s polls=%d elapsed_seconds=%.2f",
                 resource_label, _safe_azure_text(state or "unavailable")[:80],
                 poll_number, time.monotonic() - started_at)
    raise CloudError(f"The Container Apps GPU environment is still provisioning for {resource_label}. "
                     "Check its deployment in Azure Portal before retrying.")


def prepare(config, consent=False):
    """Provision infrastructure only after an explicit, per-request cost approval."""
    _progress_step("preflight", 0, "Checking consent and selected subscription.")
    values = _setup(config)
    if consent is not True:
        raise CloudError("Review Azure charges and approve provisioning explicitly.")
    saved = _setting("cloud_config")
    previous = _setup(json.loads(saved)) if saved else None
    if not previous or not previous.get("userObjectId") or any(
            previous[key] != values[key] for key in (*FIELDS, *SETUP_FIELDS)):
        raise CloudError("Save these exact Azure identifiers before provisioning.")
    azure = _Azure(previous)
    azure._auth()
    _progress_step("resource_group", 0, "Checking or creating the resource group.")
    group = azure.request(azure.base, "2024-03-01")
    reuse = config.get("existingPilot") is True
    resume = config.get("resumePartial") is True
    if reuse and resume:
        raise CloudError("Choose either an existing pilot or a partial infrastructure retry.")
    if not group and reuse:
        raise CloudError("The selected existing-pilot resource group does not exist.")
    if group and group.get("location", "").replace(" ", "").lower() != values["location"]:
        raise CloudError("The resource group is not in the selected GPU region.")
    loc = values["location"]
    storage = _resource(azure, "Microsoft.Storage", "storageAccounts", values["storageAccount"])
    registry = _resource(azure, "Microsoft.ContainerRegistry", "registries", values["registry"])
    identity = _resource(azure, "Microsoft.ManagedIdentity", "userAssignedIdentities", values["identity"])
    network = _resource(azure, "Microsoft.Network", "virtualNetworks", values["vnet"]) if values["vnet"] else None
    subnet = f"{network}/subnets/{values['subnet']}" if network else values["subnetResourceId"] or None
    environment = _resource(azure, "Microsoft.App", "managedEnvironments", values["environment"])
    container_path = f"{storage}/blobServices/default/containers/{values['container']}"
    policy_path = f"{storage}/managementPolicies/default"
    paths = (storage, container_path, registry, identity, environment, policy_path)
    if resume:
        # A retry must reject incompatible resources before creating any missing ones.
        existing = {path: azure.request(path, "2023-05-01" if path in (storage, container_path, policy_path)
                                        else "2023-07-01" if path == registry
                                        else "2023-01-31" if path == identity
                                        else "2024-03-01") for path in paths}
        if network:
            existing[network] = azure.request(network, "2024-05-01")
        if subnet:
            existing[subnet] = azure.request(subnet, "2024-05-01")
        if existing[storage]:
            _check_existing(existing[storage], "storage account", location=loc,
                            properties={"allowBlobPublicAccess": False, "supportsHttpsTrafficOnly": True,
                                        "minimumTlsVersion": "TLS1_2"})
            if (existing[storage].get("kind") != "StorageV2"
                    or existing[storage].get("sku", {}).get("name") != "Standard_LRS"):
                raise CloudError("Existing storage account must use StorageV2 and Standard_LRS.")
            if existing[storage].get("properties", {}).get("publicNetworkAccess", "Enabled") != "Enabled":
                raise CloudError("Existing storage account cannot be accessed over the public endpoint.")
        if existing[container_path]:
            _check_existing(existing[container_path], "Blob container", properties={"publicAccess": "None"})
        if existing[registry]:
            _check_existing(existing[registry], "container registry", location=loc,
                            properties={"adminUserEnabled": False})
            if existing[registry].get("sku", {}).get("name") != "Basic":
                raise CloudError("Existing container registry is not Basic SKU.")
            if existing[registry].get("properties", {}).get("publicNetworkAccess", "Enabled") != "Enabled":
                raise CloudError("Existing container registry cannot be accessed over the public endpoint.")
        if existing[identity]:
            _check_existing(existing[identity], "managed identity", location=loc)
            if not all(existing[identity].get("properties", {}).get(key)
                       for key in ("principalId", "clientId")):
                raise CloudError("Existing managed identity is still provisioning; retry later.")
        if network and existing[network]:
            _check_existing(existing[network], "virtual network", location=loc)
            if values["vnetCidr"] not in existing[network].get("properties", {}).get(
                    "addressSpace", {}).get("addressPrefixes", []):
                raise CloudError("Existing virtual network does not have the selected address range.")
        if subnet and existing[subnet]:
            _check_subnet(existing[subnet])
            if network and existing[subnet].get("properties", {}).get("addressPrefix") != values["subnetCidr"]:
                raise CloudError("Existing subnet does not have the selected address range.")
        if existing[environment]:
            _check_existing(existing[environment], "Container Apps environment", location=loc)
            props = existing[environment].get("properties", {})
            if ((props.get("vnetConfiguration") or {}).get("infrastructureSubnetId", "").lower()
                    != (subnet or "").lower()
                    or not any(profile.get("name") == GPU_PROFILE
                               and profile.get("workloadProfileType") == GPU_TYPE
                               for profile in props.get("workloadProfiles", []))):
                raise CloudError("Existing environment needs the selected network and A100 GPU profile.")
        if existing[policy_path] and not any(
                rule.get("enabled") and rule.get("definition", {}).get("filters", {}).get(
                    "prefixMatch") == [f"{values['container']}/jobs/"] and rule.get(
                    "definition", {}).get("actions", {}).get("baseBlob", {}).get(
                    "delete", {}).get("daysAfterModificationGreaterThan", 999) <= 1
                for rule in existing[policy_path].get("properties", {}).get("policy", {}).get("rules", [])):
            raise CloudError("Existing storage needs a one-day jobs/ Blob lifecycle rule.")
    if values["subnetResourceId"]:
        delegated = azure.request(subnet, "2024-05-01")
        if not delegated:
            raise CloudError("The selected existing subnet does not exist; ask your network administrator.")
        _check_subnet(delegated)
        if (not reuse and not (resume and existing[environment])
                and (delegated.get("properties", {}).get("serviceAssociationLinks")
                     or delegated.get("properties", {}).get("ipConfigurations"))):
            raise CloudError("The selected subnet is already in use by another resource. "
                             "Choose a free delegated subnet or use a Mizan-managed VNet.")
    if not group:
        azure.create(azure.base, "2024-03-01", {"location": loc})
    _progress_step("storage", 1, "Creating the private storage account.")
    account = azure.create(storage, "2023-05-01", {
        "location": loc, "sku": {"name": "Standard_LRS"}, "kind": "StorageV2",
        "properties": {"allowBlobPublicAccess": False, "supportsHttpsTrafficOnly": True,
                       "minimumTlsVersion": "TLS1_2"},
    }, reuse=reuse or resume)
    if reuse:
        _check_existing(account, "storage account", location=loc,
                        properties={"allowBlobPublicAccess": False, "supportsHttpsTrafficOnly": True})
    _progress_step("container", 2, "Creating the private Blob container.")
    container = azure.create(container_path, "2023-05-01", {
        "properties": {"publicAccess": "None"},
    }, reuse=reuse or resume)
    if reuse:
        _check_existing(container, "Blob container", properties={"publicAccess": "None"})
    _progress_step("registry", 3, "Creating the container registry.")
    acr = azure.create(registry, "2023-07-01", {
        "location": loc, "sku": {"name": "Basic"},
        "properties": {"adminUserEnabled": False, "publicNetworkAccess": "Enabled"},
    }, reuse=reuse or resume)
    if reuse:
        _check_existing(acr, "container registry", location=loc, properties={"adminUserEnabled": False})
    _progress_step("identity", 4, "Creating the Job managed identity.")
    ident = azure.create(identity, "2023-01-31", {"location": loc}, reuse=reuse or resume)
    if reuse:
        _check_existing(ident, "managed identity", location=loc)
    if not ident.get("properties", {}).get("principalId") or not ident.get("properties", {}).get("clientId"):
        raise CloudError("Managed identity is still provisioning; wait for its principal and client IDs before retrying.")
    if values["subnetResourceId"]:
        _progress_step("network", 5, "Using the existing virtual network.")
        _progress_step("subnet", 6, "Using the delegated subnet without modifying it.")
    elif network:
        _progress_step("network", 5, "Creating the virtual network.")
        azure.create(network, "2024-05-01", {
            "location": loc, "properties": {"addressSpace": {"addressPrefixes": [values["vnetCidr"]]}},
        }, reuse=reuse or resume)
        _progress_step("subnet", 6, "Creating the delegated subnet.")
        delegated = azure.create(subnet, "2024-05-01", {
            "properties": {"addressPrefix": values["subnetCidr"],
                           "delegations": [{"name": "aca", "properties": {
                               "serviceName": "Microsoft.App/environments"}}]},
        }, reuse=reuse or resume)
        if reuse or resume:
            _check_subnet(delegated)
    else:
        _progress_step("network", 5, "Using Azure-managed networking.")
        _progress_step("subnet", 6, "No customer subnet required.")
    _progress_step("environment", 7,
                   f"Provisioning GPU Container Apps environment '{values['environment']}'.")
    environment_body = {
        "location": loc, "properties": {
            **({"vnetConfiguration": {"infrastructureSubnetId": subnet}} if subnet else {}),
            "workloadProfiles": [{"name": GPU_PROFILE,
                                  "workloadProfileType": GPU_TYPE}],
        },
    }
    if resume and existing[environment] and existing[environment].get(
            "properties", {}).get("provisioningState") == "Failed":
        _setting("cloud_prepared", "")
        _setting("cloud_environment_ready", "")
        azure.request(environment, "2024-03-01", "PUT", environment_body)
    else:
        azure.create(environment, "2024-03-01", environment_body, reuse=reuse or resume)
    env = _environment_ready(azure, environment, wait=not reuse)
    if reuse:
        _check_existing(env, "Container Apps environment", location=loc)
        props = env.get("properties", {})
        if ((props.get("vnetConfiguration") or {}).get("infrastructureSubnetId", "").lower()
                != (subnet or "").lower()
                or not any(profile.get("name") == GPU_PROFILE
                           and profile.get("workloadProfileType") == GPU_TYPE
                           for profile in props.get("workloadProfiles", []))):
            raise CloudError("Existing environment needs the selected network and A100 GPU profile.")
    else:
        _progress_step("log_analytics", 7, "Connecting future Azure console and system logs.")
        _enable_log_analytics(azure, previous, require_prepared=False)
    _progress_step("lifecycle", 8, "Creating the one-day Blob cleanup rule.")
    policy = azure.create(policy_path, "2023-05-01", {
            "properties": {"policy": {"rules": [{
                "enabled": True, "name": "mizan-orphan-expiry", "type": "Lifecycle",
                "definition": {
                    "filters": {"blobTypes": ["blockBlob"], "prefixMatch": [f"{values['container']}/jobs/"]},
                    "actions": {"baseBlob": {"delete": {"daysAfterModificationGreaterThan": 1}}},
                },
            }]}}
        }, reuse=reuse or resume)
    if reuse and not any(rule.get("enabled") and rule.get("definition", {}).get("filters", {}).get(
            "prefixMatch") == [f"{values['container']}/jobs/"] and rule.get("definition", {}).get(
            "actions", {}).get("baseBlob", {}).get("delete", {}).get("daysAfterModificationGreaterThan", 999) <= 1
            for rule in policy.get("properties", {}).get("policy", {}).get("rules", [])):
        raise CloudError("Existing storage needs a one-day jobs/ Blob lifecycle rule; "
                         "configure it in Azure Portal before retrying.")
    _progress_step("roles", 9, "Assigning Blob and registry access to the selected and Job identities.")
    _grant_roles(azure, values, ident)
    _setting("cloud_prepared", json.dumps(values))
    _setting("cloud_environment_ready", "yes")
    _setting("cloud_reuse", "yes" if reuse else "no")
    return {"ok": True, "provider": "azure", "prepared": True, "configured": False, "mode": "local",
            "identityPrincipalId": ident.get("properties", {}).get("principalId"),
            "identityClientId": ident.get("properties", {}).get("clientId"),
            "containerScope": f"{storage}/blobServices/default/containers/{values['container']}",
            "registryScope": registry,
            "next": "RBAC roles were requested for the selected identity and managed identity. "
                    "Wait for propagation, push the combined image to ACR and provide its sha256 digest; "
                    "do not upload a Hugging Face token to Mizan."}


def _registry_manifest(config, reference, digest):
    from azure.containerregistry import ContainerRegistryClient
    from azure.core.credentials import AccessToken
    from azure.core.exceptions import AzureError

    class SelectedIdentity:
        def get_token(self, *scopes, **kwargs):
            _check_readiness()
            access = token(scopes[0], config["tenantId"], config["userObjectId"])
            _check_readiness()
            return AccessToken(access, int(claims(access)["exp"]))

    try:
        with ContainerRegistryClient(
                f"https://{config['registry']}.azurecr.io", SelectedIdentity()) as client:
            check = getattr(_readiness_context, "check", None)
            options = ({"connection_timeout": _readiness_timeout(30),
                        "read_timeout": _readiness_timeout(30), "retry_total": 0}
                       if check else {})
            manifest = client.get_manifest("mizan-aca-gpu", reference, **options)
            _check_readiness()
    except (AzureError, AzureSignInError, KeyError, ValueError) as exc:
        _check_readiness()
        response = getattr(exc, "response", None)
        status_code = getattr(exc, "status_code", None) or getattr(response, "status_code", None)
        if status_code == 403:
            raise CloudError("Azure RBAC action required: the selected Azure identity needs "
                             "AcrPull permission on the destination registry.") from exc
        if status_code == 401:
            raise CloudError("The selected Azure identity could not authenticate to the destination "
                             "registry; sign in again and retry the access check.") from exc
        if status_code == 404:
            raise CloudError("The expected GPU worker image or manifest was not found in the "
                             "destination registry; confirm the build or import completed.") from exc
        raise CloudError("Could not verify the ACR image because of an Azure or registry error. "
                         "Check connectivity and retry the access check.") from exc
    if manifest.digest != digest:
        raise CloudError("The ACR manifest digest differs from the recorded build; Cloud remains unready.")


def import_cloud_image(source_image):
    """Copy the validated pilot digest from an anonymous registry; verify it in the destination ACR."""
    _progress_step("source", 0, "Checking the source image and selected registry.")
    saved = _setting("cloud_prepared")
    config = json.loads(_setting("cloud_config") or "{}")
    if not saved or not config.get("userObjectId"):
        raise CloudError("Prepare Cloud with explicit cost consent before importing a GPU image.")
    values = _setup(json.loads(saved))
    config = _setup(config)
    if any(config[key] != values[key] for key in (*FIELDS, *SETUP_FIELDS)):
        raise CloudError("Cloud settings changed since provisioning; re-run Prepare.")
    if not isinstance(source_image, str):
        raise CloudError("Enter a source registry image pinned to the validated sha256 digest.")
    match = re.fullmatch(
        r"([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/([a-z0-9][a-z0-9._/-]*)@(sha256:[a-f0-9]{64})",
        source_image)
    if (not match or ".." in match[1] or any(
            not re.fullmatch(r"[a-z0-9]+(?:[._-][a-z0-9]+)*", segment)
            for segment in match[2].split("/")) or match[3] != SUPPORTED_WORKER_DIGEST):
        raise CloudError("Source image must be a registry/repository@sha256 reference using "
                         "this build's validated worker digest; tags or other digests are not accepted.")
    registry_uri, repository, digest = match.groups()
    azure = _Azure(config)
    target = _resource(azure, "Microsoft.ContainerRegistry", "registries", config["registry"])
    if not azure.request(target, "2023-07-01"):
        raise CloudError("The destination ACR is missing; re-run Prepare.")
    if registry_uri != f"{config['registry']}.azurecr.io":
        _progress_step("import", 1, "Importing the pinned image into the selected ACR.")
        try:
            azure.request(f"{target}/importImage", "2025-11-01", "POST", {
                "source": {"registryUri": registry_uri, "sourceImage": f"{repository}@{digest}"},
                "untaggedTargetRepositories": ["mizan-aca-gpu"],
                "mode": "NoForce",
            })
        except CloudError as exc:
            raise CloudError("ACR image import failed. The selected identity needs import permission "
                             "on the destination; the source must permit anonymous pulls. Private "
                             "sources require a separately authorized transfer; no registry "
                             f"credentials are sent by Mizan. Azure detail: {exc}") from exc
    _progress_step("manifest", 1, "Verifying the imported image digest.")
    _registry_manifest(config, digest, digest)
    _setting("cloud_imported_digest", digest)
    return {"ok": True, "provider": "azure",
            "image": f"{config['registry']}.azurecr.io/mizan-aca-gpu@{digest}",
            "digest": digest, "verified": True}


def build_cloud_image():
    """Quick-build the bundled worker in this customer's ACR; pin the pushed manifest."""
    _progress_step("source", 0, "Validating and bundling the installed GPU worker source.")
    saved = _setting("cloud_prepared")
    config = _setup(json.loads(_setting("cloud_config") or "{}"))
    if not saved or not config.get("userObjectId"):
        raise CloudError("Prepare Cloud with explicit cost consent before building the GPU worker.")
    values = _setup(json.loads(saved))
    if any(config[key] != values[key] for key in (*FIELDS, *SETUP_FIELDS)):
        raise CloudError("Cloud settings changed since provisioning; re-run Prepare.")
    files, contract = _worker_source()
    archive = io.BytesIO()
    with gzip.GzipFile(fileobj=archive, mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w|") as tar:
            for name, content in files.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(content)
                entry.mode = 0o644
                tar.addfile(entry, io.BytesIO(content))
    azure = _Azure(config)
    registry = _resource(azure, "Microsoft.ContainerRegistry", "registries", config["registry"])
    if not azure.request(registry, "2023-07-01"):
        raise CloudError("Destination ACR is missing; re-run Prepare.")
    _setting("processing_mode", "local")
    _setting("cloud_built_image", "")
    _setting("cloud_runtime_verified", "")
    _progress_step("upload", 1, "Requesting an ACR source-upload location.")
    upload = azure.request(f"{registry}/listBuildSourceUploadUrl", "2019-04-01", "POST")
    relative = upload.get("relativePath")
    location = upload.get("uploadUrl")
    parsed = urllib.parse.urlsplit(location) if isinstance(location, str) else None
    if (not isinstance(relative, str) or len(relative) > 512
            or not re.fullmatch(r"(?:source|tasks-source)/[A-Za-z0-9._/-]+\.tar\.gz", relative)
            or ".." in relative or "//" in relative
            or not parsed or parsed.scheme != "https"
            or not parsed.hostname or not parsed.hostname.endswith(".blob.core.windows.net")
            or not urllib.parse.parse_qs(parsed.query).get("sig")):
        raise CloudError("Azure returned an unsafe build-source upload location.")
    upload_error = None
    try:
        _progress_step("upload", 1, "Uploading the bundled worker source to Azure.")
        request = urllib.request.Request(location, data=archive.getvalue(), method="PUT", headers={
            "x-ms-blob-type": "BlockBlob", "x-ms-version": "2023-11-03",
            "Content-Type": "application/octet-stream"})
        with urllib.request.build_opener(_NoRedirect()).open(request, timeout=120) as response:
            response.read()
    except (urllib.error.URLError, CloudError) as exc:
        upload_error = (f"Azure build-source upload failed (HTTP {exc.code})."
                        if isinstance(exc, urllib.error.HTTPError) else
                        "Azure build-source upload failed; check network access and retry.")
    if upload_error:
        raise CloudError(upload_error)
    _progress_step("build", 2, "Scheduling the Docker build in the selected ACR.")
    tag = f"build-{uuid4().hex[:16]}"
    run = azure.request(f"{registry}/scheduleRun", "2019-04-01", "POST", {
        "type": "DockerBuildRequest", "sourceLocation": relative,
        "dockerFilePath": "Dockerfile", "platform": {"os": "Linux", "architecture": "amd64"},
        "imageNames": [f"mizan-aca-gpu:{tag}"], "isPushEnabled": True,
        "isArchiveEnabled": False, "timeout": 3600,
    })
    run_id = run.get("properties", {}).get("runId") or run.get("name")
    if not isinstance(run_id, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", run_id):
        raise CloudError("ACR accepted a build but did not return a run ID. "
                         "Inspect ACR Tasks runs in Azure Portal before retrying.")
    _setting("cloud_build_run", run_id)
    for _ in range(450):
        result = azure.request(f"{registry}/runs/{run_id}", "2019-04-01")
        status = (result or {}).get("properties", {}).get("status")
        if status == "Succeeded":
            break
        if status in ("Failed", "Canceled", "Error", "Timeout"):
            raise CloudError(f"ACR build {run_id} ended {status}; inspect its task log in Azure Portal.")
        if status not in ("Queued", "Started", "Running"):
            raise CloudError(f"ACR build {run_id} returned an unknown status; inspect its task log.")
        _progress_step("build", 2, f"ACR build {run_id} is {status}.")
        time.sleep(10)
    else:
        raise CloudError(f"ACR build {run_id} exceeded 75 minutes; inspect its task log.")
    _progress_step("manifest", 3, "Verifying the pushed image digest in the selected ACR.")
    images = result["properties"].get("outputImages", [])
    matching = [item for item in images
                if item.get("registry", "").lower() == f"{config['registry']}.azurecr.io"
                and item.get("repository") == "mizan-aca-gpu" and item.get("tag") == tag]
    if (len(matching) != 1 or not isinstance(matching[0].get("digest"), str)
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", matching[0]["digest"])):
        raise CloudError("ACR completed a build without the expected pushed image digest.")
    digest = matching[0]["digest"]
    _registry_manifest(config, tag, digest)
    image = f"{config['registry']}.azurecr.io/mizan-aca-gpu@{digest}"
    _setting("cloud_built_image", json.dumps({"image": image, "sourceHash": contract}))
    return {"ok": True, "provider": "azure", "image": image, "digest": digest,
            "verified": True, "runId": run_id,
            "sourceHash": contract}


def finish(image, hf_token=None, *, hf_token_provider=None, update_existing_job=False,
           job_update_confirmation=None):
    """Verify or create a dormant manual Job without persisting its one-time secret."""
    if type(update_existing_job) is not bool:
        raise CloudError("Review and confirm the existing GPU Job update before applying it.")
    if job_update_confirmation is not None and not isinstance(job_update_confirmation, str):
        raise CloudError("The existing GPU Job update confirmation is invalid; check the Job again.")
    _progress_step("preflight", 0, "Checking the pinned image and prepared Azure resources.")
    saved = _setting("cloud_prepared")
    if not saved:
        raise CloudError("Provision the infrastructure and obtain administrator RBAC grants first.")
    values = _setup(json.loads(saved))
    configured = _setup(json.loads(_setting("cloud_config") or "{}"))
    if not configured.get("userObjectId") or any(
            configured[key] != values[key] for key in (*FIELDS, *SETUP_FIELDS)):
        raise CloudError("Azure identity or configuration changed since provisioning; reconnect and prepare again.")
    digest = _image_digest(configured, image)
    resources = JOB_RESOURCES
    azure = _Azure(configured)
    environment = _resource(azure, "Microsoft.App", "managedEnvironments", values["environment"])
    _environment_ready(azure, environment)
    _setting("cloud_environment_ready", "yes")
    identity = _resource(azure, "Microsoft.ManagedIdentity", "userAssignedIdentities", values["identity"])
    ident = azure.request(identity, "2023-01-31")
    if not ident or not ident.get("properties", {}).get("clientId"):
        raise CloudError("The user-assigned identity is missing its client ID.")
    _progress_step("roles", 1, "Checking Blob and registry permissions.")
    _roles_ready(azure, values, ident)
    _progress_step("job", 2, "Checking the GPU Job configuration.")
    job = _resource(azure, "Microsoft.App", "jobs", values["jobName"])
    previous = azure.request(job, "2024-03-01")
    if previous:
        if hf_token not in (None, ""):
            raise CloudError("Mizan will not transfer a token to an existing GPU Job.")
        plan = _job_update_plan(
            values["jobName"], previous, image, environment, identity,
            ident["properties"]["clientId"], values)
        if plan["changes"]:
            _require_fresh_worker_build(image)
            if not update_existing_job:
                _registry_manifest(configured, digest, digest)
                result = status()
                return {
                    **result,
                    "requiresJobUpdateConsent": True,
                    "jobUpdate": {
                        "confirmationId": plan["confirmationId"],
                        "changes": plan["changes"],
                    },
                    "next": "Review the listed changes and approve updating this Mizan GPU Job. "
                            "Its Hugging Face secret and other Azure resources will remain unchanged.",
                }
            if job_update_confirmation != plan["confirmationId"]:
                raise CloudError("The GPU Job changed after review or its update approval expired. "
                                 "Check the existing Job again before approving another update.")
            _registry_manifest(configured, digest, digest)
            _progress_step("job", 2, "Updating only the approved GPU Job settings.")
            azure.request(job, "2024-03-01", "PATCH", plan["patch"])
            updated = azure.request(job, "2024-03-01")
            if not updated:
                raise CloudError("Azure accepted the GPU Job update but the Job is not visible yet; "
                                 "check Azure Portal before retrying.")
            verified_plan = _job_update_plan(
                values["jobName"], updated, image, environment, identity,
                ident["properties"]["clientId"], values)
            if verified_plan["changes"]:
                raise CloudError("Azure accepted the GPU Job update, but its configuration does not "
                                 "match the approved values. Check the Job in Azure before retrying.")
            resources = verified_plan["resources"]
        else:
            if update_existing_job:
                raise CloudError("The GPU Job no longer needs the reviewed update. Check it again.")
            resources = plan["resources"]
    else:
        if update_existing_job or job_update_confirmation is not None:
            raise CloudError("No existing GPU Job is available for the reviewed update. "
                             "Check the Azure resources again.")
        _setting("cloud_job_created", "")
        _setting("cloud_job_resources", "")
        if hf_token is None and hf_token_provider is not None:
            hf_token = hf_token_provider()
        if (not isinstance(hf_token, str) or not re.fullmatch(
                r"hf_[A-Za-z0-9_-]{10,2000}", hf_token)):
            result = status()
            return {**result, "requiresHfTokenConsent": True,
                    "next": "No existing GPU Job was found. Approve sending the saved Hugging Face "
                            "token only if you want Mizan to create one."}
        _progress_step("job", 2, "Creating the GPU Job and binding its one-time secret.")
        azure.create(job, "2024-03-01", {
        "location": values["location"],
        "identity": {"type": "UserAssigned", "userAssignedIdentities": {identity: {}}},
        "properties": {
            "environmentId": environment, "workloadProfileName": GPU_PROFILE,
            "configuration": {
                "triggerType": "Manual", "replicaTimeout": 7200, "replicaRetryLimit": 0,
                "manualTriggerConfig": {"parallelism": 1, "replicaCompletionCount": 1},
                "registries": [{"server": f"{values['registry']}.azurecr.io", "identity": identity}],
                "secrets": [{"name": "hf-token", "value": hf_token}],
            },
            "template": {"containers": [{
                "name": "mizan-worker", "image": image,
                "resources": resources,
                "env": [
                    {"name": "HF_TOKEN", "secretRef": "hf-token"},
                    {"name": "AZURE_STORAGE_BLOB_URL",
                     "value": f"https://{values['storageAccount']}.blob.core.windows.net"},
                    {"name": "AZURE_STORAGE_CONTAINER", "value": values["container"]},
                    {"name": "AZURE_CLIENT_ID", "value": ident["properties"]["clientId"]},
                ],
            }]},
        },
        })
    _progress_step("record", 3, "Recording the verified Job configuration.")
    _setting("cloud_job_created", image)
    _setting("cloud_job_resources", json.dumps(resources))
    _progress_step("verify", 3, "Checking Azure access and the GPU Job.")
    checked = status()
    next_step = ("Azure access and the GPU Job are verified. Choose Use Cloud to enable Cloud "
                 "processing." if checked["configured"] else
                 "The GPU Job exists, but Azure access checks are not complete. Resolve the "
                 "reported issue, then retry the check.")
    return {**checked, "next": next_step}


def _job_capabilities(config, image, resources=None):
    """Recheck the configured Job; saved identifiers alone are never readiness evidence."""
    if not config.get("userObjectId"):
        raise CloudError("Reconnect the Azure identity in Cloud setup before enabling Cloud jobs.")
    azure = _Azure(config)
    _readiness_phase("Azure GPU Job", "Checking the configured Azure GPU Job.")
    job = azure.request(_resource(azure, "Microsoft.App", "jobs", config["jobName"]), "2024-03-01")
    if not job:
        raise CloudError("The configured Azure GPU Job no longer exists.")
    properties = job.get("properties", {})
    identity = _resource(azure, "Microsoft.ManagedIdentity", "userAssignedIdentities", config["identity"])
    environment = _resource(azure, "Microsoft.App", "managedEnvironments", config["environment"])
    containers = properties.get("template", {}).get("containers", [])
    if resources is None:
        try:
            resources = json.loads(_setting("cloud_job_resources") or "{}")
        except ValueError:
            resources = {}
    _readiness_phase("ACR image", "Authenticating with the selected registry and checking the Job image.")
    image_matches = (len(containers) == 1
                     and _job_image_matches(config, image, containers[0].get("image")))
    if (properties.get("environmentId", "").lower() != environment.lower()
            or properties.get("workloadProfileName") != GPU_PROFILE
            or properties.get("configuration", {}).get("triggerType") != "Manual"
            or identity.lower() not in {name.lower() for name in job.get(
                "identity", {}).get("userAssignedIdentities", {})}
            or not image_matches
            or not resources or not _job_resources_compatible(
                containers[0].get("resources"), resources)
            or not any(registry.get("server") == f"{config['registry']}.azurecr.io"
                       and registry.get("identity", "").lower() == identity.lower()
                       for registry in properties.get("configuration", {}).get("registries", []))):
        raise CloudError("The GPU Job image, identity, CPU/memory resources or manual A100 profile "
                         "changed; reverify Cloud.")
    env = {item.get("name"): item for item in containers[0].get("env", [])}
    if (env.get("HF_TOKEN", {}).get("secretRef") != "hf-token"
            or env.get("HF_TOKEN", {}).get("value")
            or not any(item.get("name") == "hf-token" for item in
                       properties.get("configuration", {}).get("secrets", []))):
        raise CloudError("The GPU Job exists, but HF_TOKEN is not bound to its hf-token secret. "
                         "Mizan will not overwrite the secret or transfer a token; repair the "
                         "binding in Azure, then retry this check.")
    if (env.get("AZURE_STORAGE_BLOB_URL", {}).get("value") !=
            f"https://{config['storageAccount']}.blob.core.windows.net"
            or env.get("AZURE_STORAGE_CONTAINER", {}).get("value") != config["container"]):
        raise CloudError("The GPU Job storage settings do not match the saved private Blob container.")
    _readiness_phase("Job managed identity", "Checking the configured Job managed identity.")
    managed = azure.request(identity, "2023-01-31")
    if not managed or env.get("AZURE_CLIENT_ID", {}).get("value") != managed.get(
            "properties", {}).get("clientId"):
        raise CloudError("The GPU Job does not use the configured managed identity.")
    _readiness_phase("Azure role assignments", "Checking selected-user and Job identity role assignments.")
    _roles_ready(azure, config, managed)
    _readiness_phase("GPU environment", "Checking the Azure GPU environment and A100 profile.")
    gpu_environment = _environment_ready(azure, environment)
    if not any(
            profile.get("name") == GPU_PROFILE
            and profile.get("workloadProfileType") == GPU_TYPE
            for profile in gpu_environment.get("properties", {}).get("workloadProfiles", [])):
        raise CloudError("The Container Apps environment no longer has the A100 GPU profile.")
    storage = _resource(azure, "Microsoft.Storage", "storageAccounts", config["storageAccount"])
    _readiness_phase("private Blob storage", "Checking the private storage account and container settings.")
    account = azure.request(storage, "2023-05-01")
    container = azure.request(
        f"{storage}/blobServices/default/containers/{config['container']}", "2023-05-01")
    if (not account or account.get("properties", {}).get("allowBlobPublicAccess") is not False
            or account.get("properties", {}).get("supportsHttpsTrafficOnly") is not True
            or not container or container.get("properties", {}).get("publicAccess") != "None"):
        raise CloudError("The configured Blob container must be private and require HTTPS.")
    _readiness_phase("private Blob container read access", "Checking read access to the private Blob container.")
    _blob_access(config)
    return azure


def _blob_access(config):
    from .cloud_transport import CloudTransport, CloudTransportError
    transport = CloudTransport(config)
    try:
        _check_readiness()
        check = getattr(_readiness_context, "check", None)
        options = {"cancelled": check.cancelled, "deadline": check.deadline} if check else {}
        with transport._open(
                f"{transport.blob}?restype=container",
                scope="https://storage.azure.com/.default", method="HEAD",
                headers={"x-ms-version": "2023-11-03"}, **options) as response:
            response.read()
            _check_readiness()
    except (CloudTransportError, OSError) as exc:
        raise CloudError("The selected Azure identity cannot read the private Blob container "
                         "with its Azure data-plane token; check container RBAC propagation.") from exc


def _status_for_target(target, *, check_connection):
    settings = target["settings"]
    try:
        config = _setup(settings)
    except (ValueError, TypeError) as exc:
        raise CloudError(f"Queued Azure resource target is invalid: {exc}") from exc
    image = settings.get("image")
    resources = settings.get("jobResources")
    configured = False
    issue = "The queued Azure target has no pinned GPU Job image."
    if image and check_connection:
        try:
            _job_capabilities(config, image, resources or {})
            configured = True
        except (CloudError, ValueError) as exc:
            issue = f"Azure connection preflight failed for the queued target: {exc}"
    elif image:
        issue = "Azure readiness has not been checked."
    try:
        _, current_source = _worker_source()
        build_ready = bool(SUPPORTED_CLOUD_MODELS)
    except CloudError:
        current_source = None
        build_ready = False
    configured = bool(configured and build_ready)
    if not build_ready:
        issue = "This build has no supported combined GPU worker image and model."
    public_config = {key: value for key, value in settings.items()
                     if key not in ("userObjectId", "image", "jobResources", "provider")}
    return {
        "ok": True, "provider": "azure", "providerName": "Azure",
        "available": build_ready, "configured": configured, "verified": build_ready,
        "verifiedModels": list(BUILD_VERIFIED_MODELS) if build_ready else [],
        "supportedModels": list(SUPPORTED_CLOUD_MODELS) if build_ready else [],
        "workerDigest": image.rsplit("@", 1)[-1] if image and build_ready else None,
        "workerImage": image if build_ready else None, "mode": "cloud",
        "config": public_config, "prepared": bool(image),
        "jobCreated": bool(image), "runtimeVerified": False,
        **({"issue": issue} if not configured else {
            "warning": "The queued Azure target has not passed a live GPU smoke run."
        }),
    }


def status(*, check_connection=True, target=None):
    if target is not None:
        return _status_for_target(target, check_connection=check_connection)
    load_provider_settings("azure")
    saved = _setting("cloud_config")
    image = _setting("cloud_job_created")
    prepared = bool(_setting("cloud_prepared") and _setting("cloud_environment_ready") == "yes")
    configured = False
    issue = "Sign in to Azure, choose a subscription, provision resources and bind the gated-model Job secret."
    if saved and not image:
        if _setting("cloud_built_image"):
            issue = ("The GPU worker image is built; finish the Azure Job with a one-time Hugging Face token."
                     if prepared else "The GPU worker is built; open Cloud setup to retry the GPU environment.")
        elif _setting("cloud_build_run"):
            issue = (f"ACR build {_setting('cloud_build_run')} has no verified image. "
                     "Inspect the ACR Tasks run, then retry Build Worker.")
        elif prepared:
            issue = "Infrastructure is prepared; build the bundled GPU worker in the selected ACR."
        else:
            issue = ("Azure subscription is saved but provisioning is not complete. "
                     "Approve Azure charges before provisioning.")
    if saved and image and check_connection:
        try:
            _job_capabilities(_setup(json.loads(saved)), image)
            configured = True
        except (CloudError, ValueError) as exc:
            issue = f"Azure connection preflight failed: {exc}"
    elif saved and image:
        issue = "Azure readiness has not been checked."
    try:
        _, current_source = _worker_source()
        build_ready = bool(SUPPORTED_CLOUD_MODELS)
    except CloudError:
        current_source = None
        build_ready = False
    configured = bool(configured and build_ready)
    if not build_ready:
        issue = "This build has no supported combined GPU worker image and model."
    mode = _setting("processing_mode") or "local"
    try:
        built = json.loads(_setting("cloud_built_image") or "{}")
    except ValueError:
        built = {}
        issue = "ACR build record is invalid; rebuild the bundled worker."
    if not isinstance(built, dict):
        built = {}
        issue = "ACR build record is invalid; rebuild the bundled worker."
    worker_image = None
    image_issue = False
    if built:
        configured_registry = json.loads(saved).get("registry") if saved else None
        candidate = built.get("image")
        if (built.get("sourceHash") in (current_source, LEGACY_AZURE_SOURCE_HASH)
                and isinstance(candidate, str)
                and configured_registry and re.fullmatch(
                    rf"{re.escape(configured_registry)}\.azurecr\.io/mizan-aca-gpu@sha256:[a-f0-9]{{64}}",
                    candidate)):
            worker_image = candidate
        else:
            issue = "The built GPU image no longer matches the selected ACR or bundled source; rebuild it."
            image_issue = True
    elif _setting("cloud_reuse") == "yes" and build_ready and saved:
        configured_registry = json.loads(saved).get("registry")
        if configured_registry:
            worker_image = (f"{configured_registry}.azurecr.io/mizan-aca-gpu@"
                            f"{SUPPORTED_WORKER_DIGEST}")
    digest = worker_image.rsplit("@", 1)[-1] if worker_image else None
    if image and worker_image and image != worker_image:
        configured = False
        issue = ("A newer worker image is built. Check the existing GPU Job to review and "
                 "approve its update before using Cloud.")
    if not digest and _setting("cloud_reuse") == "yes":
        digest = SUPPORTED_WORKER_DIGEST
    result = {"ok": True, "provider": "azure", "providerName": "Azure",
              "available": build_ready, "configured": configured,
              "verified": build_ready, "verifiedModels": list(BUILD_VERIFIED_MODELS) if build_ready else [],
              "supportedModels": list(SUPPORTED_CLOUD_MODELS) if build_ready else [],
              "workerDigest": digest if build_ready else None,
              "workerImage": worker_image if build_ready else None, "mode": mode,
              "loggingConfigured": bool(_setting("cloud_log_analytics_workspace"))}
    if _setting("cloud_log_analytics_workspace"):
        try:
            logging_workspace = json.loads(_setting("cloud_log_analytics_workspace"))
            result["loggingLocation"] = logging_workspace.get("location")
        except (ValueError, AttributeError):
            result["loggingConfigured"] = False
    result["runtimeVerified"] = bool(configured and _setting("cloud_runtime_verified") == image)
    if configured and not result["runtimeVerified"]:
        result["warning"] = ("This customer's Job has not passed a live A100 GPU smoke run. "
                             "The worker source and image digest are checked, not runtime behavior.")
    if not configured or image_issue:
        result["issue"] = issue
    if saved:
        result["config"] = {key: value for key, value in json.loads(saved).items()
                            if key != "userObjectId"}
        result["config"]["provider"] = "azure"
    result["prepared"] = bool(configured or
                              (_setting("cloud_prepared") and _setting("cloud_environment_ready") == "yes"))
    result["jobCreated"] = bool(image)
    result["existingPilot"] = _setting("cloud_reuse") == "yes"
    return result


def configure(config):
    _progress_step("subscription", 0, "Validating the selected subscription.")
    try:
        if not isinstance(config, dict):
            raise ValueError("Choose an Azure subscription.")
        if config.get("clientSecret") or config.get("clientId"):
            raise ValueError("Do not enter application credentials; use the Azure credential chain.")
        subscription = config.get("subscriptionId")
        matching = [item for item in list_subscriptions() if item["subscriptionId"] == subscription
                    and item["state"] == "Enabled"]
        if not matching:
            raise ValueError("Select an enabled subscription visible to the signed-in Azure user.")
        tenant = matching[0]["tenantId"]
        if config.get("tenantId") and config["tenantId"].lower() != tenant.lower():
            raise ValueError("The selected subscription belongs to a different Azure tenant.")
        _progress_step("identity", 1, "Checking the Azure identity in the selected tenant.")
        selected = {key: value for key, value in config.items() if key != "userObjectId"}
        selected["tenantId"] = tenant
        selected["userObjectId"] = claims(token(ARM_SCOPE, tenant))["oid"]
        values = _setup(selected) if any(key in selected for key in SETUP_FIELDS) else _validate(selected)
        values["provider"] = "azure"
        if _setting("cloud_config") != json.dumps(values):
            _setting("cloud_prepared", "")
            _setting("cloud_environment_ready", "")
            _setting("cloud_job_created", "")
            _setting("cloud_job_resources", "")
            _setting("cloud_reuse", "")
            _setting("cloud_log_analytics_workspace", "")
            _setting("cloud_built_image", "")
            _setting("cloud_build_run", "")
            _setting("cloud_imported_digest", "")
            _setting("cloud_runtime_verified", "")
        _setting("cloud_config", json.dumps(values))
        _setting("processing_mode", "local")
    except (ValueError, AzureSignInError, TypeError) as exc:
        raise CloudError(f"Azure setup failed: {exc}") from exc
    return status()


def set_mode(mode):
    if mode not in ("local", "cloud"):
        raise CloudError("Choose local or cloud processing.")
    if mode == "cloud":
        try:
            _setup(json.loads(_setting("cloud_config") or "{}"))
        except (ValueError, TypeError) as exc:
            raise CloudError("Azure setup is not complete. Review the saved Azure settings.") from exc
        check = status(check_connection=False)
        if not check["available"] or not check["jobCreated"]:
            raise CloudError(check["issue"])
        if (_setting("transcription_model") or "muscriptor-small") not in check["supportedModels"]:
            raise CloudError("The selected MuScriptor size is not supported by this Cloud worker.")
    _setting("processing_mode", mode)
    if mode == "cloud":
        return {**check, "ok": True, "mode": mode}
    return {"ok": True, "mode": mode}


def selected():
    return _setting("processing_mode") == "cloud"


def require_model(model: str):
    if model not in SUPPORTED_CLOUD_MODELS:
        raise CloudError("The selected MuScriptor size is not supported by this Cloud worker.")


def _events(raw, duration: float) -> list[dict]:
    return validate_events(raw, duration, error_type=CloudError)


def _materialize(manifest: dict, transport, names: list[str], recording: Path,
                 directory: Path, model: str) -> dict:
    return _shared_materialize(
        manifest, transport, names, recording, directory, model, error_type=CloudError)


def _target_config(target):
    if target is None:
        saved = _setting("cloud_config")
        if not saved:
            raise CloudError("Configure an Azure GPU Job before starting Cloud processing.")
        try:
            settings = json.loads(saved)
        except (ValueError, TypeError) as exc:
            raise CloudError("Saved Azure settings are invalid.") from exc
        if not isinstance(settings, dict) or settings.get("provider", "azure") != "azure":
            raise CloudError("Saved Azure settings have a mismatched provider ID.")
        return _validate(settings)
    if (not isinstance(target, dict) or target.get("provider") != "azure"
            or not isinstance(target.get("settings"), dict)):
        raise CloudError("Queued Azure resource target is invalid or has a mismatched provider.")
    try:
        return _validate(target["settings"])
    except (ValueError, TypeError) as exc:
        raise CloudError(f"Queued Azure resource target is invalid: {exc}") from exc


def offload(recording: Path, directory: Path, model: str, cancelled: Event, report, *, target=None):
    from .cloud_transport import CloudTransport, CloudTransportError
    config = _target_config(target)
    if not config.get("userObjectId"):
        raise CloudError("Reconnect the Azure identity before starting Cloud processing.")
    transport = CloudTransport(config)
    try:
        manifest, names = transport.run(recording, directory, model, cancelled, report)
        try:
            materialized = _materialize(manifest, transport, names, recording, directory, model)
            if target is None and _setting("cloud_job_created"):
                _setting("cloud_runtime_verified", _setting("cloud_job_created"))
            return materialized, names
        except (CloudError, ValueError, OSError):
            try:
                transport.delete(names)
            except (CloudTransportError, OSError):
                logger.exception("Could not remove invalid Cloud output; configure Blob expiry.")
            raise
    except (CloudTransportError, FileNotFoundError) as exc:
        raise CloudError(str(exc)) from exc


def cleanup(names: list[str], *, target=None) -> None:
    from .cloud_transport import CloudTransport
    if target is None and not _setting("cloud_config"):
        raise CloudError("Azure configuration was removed before Cloud files could be cleaned up.")
    if (len(names) != 8 or not all(isinstance(name, str) for name in names)
            or not re.fullmatch(r"jobs/[0-9a-f-]{36}/input\.wav", names[0])):
        raise CloudError("Cannot clean up invalid Cloud file names.")
    prefix = names[0].removesuffix("/input.wav")
    UUID(prefix.rsplit("/", 1)[-1])
    from .cloud_transport import STEMS
    if names != [names[0], f"{prefix}/result.json",
                 *(f"{prefix}/result/stems/{stem}.wav" for stem in STEMS)]:
        raise CloudError("Cloud files do not belong to the same Job.")
    config = _target_config(target)
    if not config.get("userObjectId"):
        raise CloudError("Reconnect the Azure identity before cleaning Cloud files.")
    CloudTransport(config).delete(names)
