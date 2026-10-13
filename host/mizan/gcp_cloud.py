"""Google Cloud Batch and private Cloud Storage adapter."""

import base64
import hashlib
import json
import logging
import re
import time
import urllib.parse
from pathlib import Path
from threading import Event
from uuid import uuid4

from .cloud import CloudError as BaseCloudError
from .cloud_result import (
    MAX_AUDIO_BYTES,
    MAX_WORKER_ERROR_BYTES,
    STEMS,
    materialize,
    validate_worker_error,
)
from .cloud_state import CloudOperations
from .cloud_transport import MODEL_EXECUTION_BUDGETS
from .cloud_worker.worker import MAX_RESULT_BYTES
from .errors import Cancelled

logger = logging.getLogger(__name__)
PROVIDER = "gcp"
PROVIDER_NAME = "Google Cloud"
BATCH_API = "https://batch.googleapis.com/v1"
STORAGE_API = "https://storage.googleapis.com/storage/v1"
STORAGE_UPLOAD_API = "https://storage.googleapis.com/upload/storage/v1"
SERVICE_USAGE_API = "https://serviceusage.googleapis.com/v1"
RESOURCE_MANAGER_API = "https://cloudresourcemanager.googleapis.com/v3"
IAM_API = "https://iam.googleapis.com/v1"
SECRET_MANAGER_API = "https://secretmanager.googleapis.com/v1"
REQUEST_TIMEOUT = 30
RESPONSE_LIMIT = 4 * 1024 * 1024
ERROR_RESPONSE_LIMIT = 64 * 1024
POLL_INTERVAL = 5
JOB_TIMEOUT = 2 * 60 * 60
SETUP_TIMEOUT = 15 * 60
CANCEL_TIMEOUT = 120
TERMINAL_STATES = {"SUCCEEDED", "FAILED", "CANCELED", "CANCELLED"}
ACTIVE_STATES = {"QUEUED", "SCHEDULED", "RUNNING", "CANCELLING", "DELETION_IN_PROGRESS"}
REQUIRED_SERVICES = (
    "batch.googleapis.com",
    "compute.googleapis.com",
    "storage.googleapis.com",
    "iam.googleapis.com",
    "secretmanager.googleapis.com",
)
WORKER_SECRET_ID = "mizan-worker-hf-token"
GPU_MACHINE_TYPES = {
    "g2-standard-4": (4, 16, "nvidia-l4"),
    "g2-standard-8": (8, 32, "nvidia-l4"),
}
_STATE = CloudOperations(PROVIDER)


class CloudError(BaseCloudError):
    code = "cloud_failed"
    message = "Google Cloud processing failed."


class _ApiError(CloudError):
    def __init__(self, status, reason=""):
        self.status = status
        self.reason = reason
        super().__init__(self._message())

    def _message(self):
        if self.status == 403:
            return "Google Cloud denied the request. Check your credentials and required permissions."
        if self.status == 404:
            return "Google Cloud could not find the requested resource."
        if self.status == 409:
            return "Google Cloud reported a resource conflict. Check the selected project and resource names."
        if self.status == 429 or self.reason in ("RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED"):
            return "Google Cloud quota or capacity is unavailable. Check project quotas and GPU capacity."
        if self.status == 400:
            return "Google Cloud rejected the request. Check the selected resource settings and GPU quota."
        if self.status >= 500:
            return "Google Cloud is temporarily unavailable. Check the resource state before retrying."
        return f"Google Cloud request failed with HTTP {self.status}."


def _authorized_session():
    try:
        import google.auth
        from google.auth.transport.requests import AuthorizedSession, Request

        credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        return AuthorizedSession(
            credentials,
            max_refresh_attempts=0,
            refresh_timeout=REQUEST_TIMEOUT,
            auth_request=Request(),
        )
    except Exception:
        raise CloudError(
            "Google Cloud credentials are unavailable. Configure Application Default "
            "Credentials and retry.") from None


def _response_bytes(response, limit):
    raw_length = response.headers.get("Content-Length")
    if raw_length is not None:
        try:
            if int(raw_length) < 0 or int(raw_length) > limit:
                raise CloudError("Google Cloud returned a response larger than the allowed limit.")
        except ValueError:
            raise CloudError("Google Cloud returned an invalid response size.") from None
    body = bytearray()
    for chunk in response.iter_content(chunk_size=64 * 1024):
        if chunk:
            body.extend(chunk)
            if len(body) > limit:
                raise CloudError("Google Cloud returned a response larger than the allowed limit.")
    return bytes(body)


class _Rest:
    def __init__(self, session=None):
        self.session = session or _authorized_session()

    @staticmethod
    def _url(url, params):
        if not params:
            return url
        query = urllib.parse.urlencode(params, doseq=True)
        return f"{url}{'&' if '?' in url else '?'}{query}"

    def _open(self, method, url, *, params=None, body=None, data=None,
              headers=None, cancelled=None):
        if cancelled is not None and cancelled.is_set():
            raise Cancelled()
        try:
            response = self.session.request(
                method,
                self._url(url, params),
                json=body,
                data=data,
                headers={"Accept-Encoding": "identity", **(headers or {})},
                timeout=(5, REQUEST_TIMEOUT),
                allow_redirects=False,
                stream=True,
            )
        except Cancelled:
            raise
        except Exception as exc:
            if isinstance(exc, (TimeoutError, OSError)) or "timeout" in type(exc).__name__.lower():
                raise CloudError("Google Cloud request timed out; check the resource state before retrying.") from None
            raise CloudError("Could not reach Google Cloud. Check network access and credentials.") from None
        if 300 <= response.status_code < 400:
            response.close()
            raise CloudError("Google Cloud unexpectedly redirected an authenticated request.")
        return response

    def request(self, method, url, *, params=None, body=None, data=None,
                headers=None, missing_ok=False, cancelled=None, limit=RESPONSE_LIMIT):
        response = self._open(
            method, url, params=params, body=body, data=data, headers=headers,
            cancelled=cancelled)
        try:
            status = response.status_code
            raw = _response_bytes(response, limit if 200 <= status < 300 else ERROR_RESPONSE_LIMIT)
            if missing_ok and status == 404:
                return None
            if not 200 <= status < 300:
                reason = ""
                try:
                    error = json.loads(raw).get("error", {})
                    reason = str(error.get("status", ""))[:80] if isinstance(error, dict) else ""
                except (ValueError, AttributeError, UnicodeDecodeError):
                    pass
                raise _ApiError(status, reason)
            if not raw:
                return {}
            try:
                result = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                raise CloudError("Google Cloud returned invalid JSON.") from None
            if not isinstance(result, dict):
                raise CloudError("Google Cloud returned an invalid response.")
            return result
        finally:
            response.close()

    def stream(self, method, url, *, params=None, data=None, headers=None, cancelled=None):
        response = self._open(
            method, url, params=params, data=data, headers=headers, cancelled=cancelled)
        if 200 <= response.status_code < 300:
            return response
        try:
            raw = _response_bytes(response, ERROR_RESPONSE_LIMIT)
            reason = ""
            try:
                error = json.loads(raw).get("error", {})
                reason = str(error.get("status", ""))[:80] if isinstance(error, dict) else ""
            except (ValueError, AttributeError, UnicodeDecodeError):
                pass
            raise _ApiError(response.status_code, reason)
        finally:
            response.close()

    def close(self):
        self.session.close()


def _api_error(exc):
    if isinstance(exc, _ApiError):
        return CloudError(str(exc))
    return exc


def _config_values(config, *, require_complete=True):
    if not isinstance(config, dict):
        raise CloudError("Choose valid Google Cloud settings.")
    if config.get("provider", PROVIDER) != PROVIDER:
        raise CloudError("Google Cloud settings have a mismatched provider ID.")
    allowed = {
        "provider", "projectId", "location", "region", "bucket", "serviceAccount",
        "machineType", "accelerator", "image", "workerSourceHash",
        "workerAuthResource", "prepared",
    }
    if set(config) - allowed:
        raise CloudError("Google Cloud settings contain unsupported fields.")
    values = {key: value for key, value in config.items() if key != "provider"}
    required = ("projectId", "location", "region", "bucket",
                "serviceAccount", "machineType", "accelerator")
    for key in required:
        if not isinstance(values.get(key), str) or not values[key].strip():
            if require_complete:
                raise CloudError(f"Enter a Google Cloud {key} value.")
    if not require_complete and not values:
        return {}
    project = values.get("projectId", "").strip()
    region = values.get("region", "").strip()
    location = values.get("location", "").strip()
    bucket = values.get("bucket", "").strip()
    service_account = values.get("serviceAccount", "").strip()
    machine_type = values.get("machineType", "").strip()
    accelerator = values.get("accelerator", "").strip()
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project):
        raise CloudError("Enter a valid Google Cloud project ID.")
    if (not re.fullmatch(r"[a-z]+(?:-[a-z]+)+\d+", region)
            or location != region):
        raise CloudError("Google Cloud location and region must match a supported region name.")
    if (not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]", bucket)
            or ".." in bucket or re.fullmatch(r"\d+\.\d+\.\d+\.\d+", bucket)):
        raise CloudError("Enter a valid private Google Cloud Storage bucket name.")
    if not re.fullmatch(
            rf"[a-z][a-z0-9-]{{4,28}}[a-z0-9]@{re.escape(project)}\.iam\.gserviceaccount\.com",
            service_account):
        raise CloudError("Choose a service account in the selected Google Cloud project.")
    if machine_type not in GPU_MACHINE_TYPES or accelerator != GPU_MACHINE_TYPES[machine_type][2]:
        raise CloudError(
            "Choose a supported G2 L4 machine: g2-standard-4 or g2-standard-8 with nvidia-l4.")
    result = {
        "projectId": project,
        "location": location,
        "region": region,
        "bucket": bucket,
        "serviceAccount": service_account,
        "machineType": machine_type,
        "accelerator": accelerator,
    }
    for key in ("image", "workerSourceHash", "workerAuthResource"):
        value = values.get(key)
        if value is not None:
            if not isinstance(value, str):
                raise CloudError(f"Saved Google Cloud field {key} is invalid.")
            result[key] = value
    if "workerSourceHash" in result and not re.fullmatch(r"[a-f0-9]{64}", result["workerSourceHash"]):
        raise CloudError("The saved Google Cloud worker source hash is invalid.")
    if "workerAuthResource" in result:
        expected = (rf"projects/{re.escape(project)}/secrets/{WORKER_SECRET_ID}/versions/"
                    r"[1-9][0-9]*")
        if not re.fullmatch(expected, result["workerAuthResource"]):
            raise CloudError("The saved Google Cloud worker credential resource is invalid.")
    if "prepared" in values:
        if not isinstance(values["prepared"], bool):
            raise CloudError("The saved Google Cloud setup state is invalid.")
        result["prepared"] = values["prepared"]
    if "image" in result and not result["image"]:
        result.pop("image")
    return result


def _model_resources(model, settings):
    budget = MODEL_EXECUTION_BUDGETS.get(model)
    if budget is None:
        raise CloudError("The selected MuScriptor size is not supported by this Cloud worker.")
    machine_type = settings.get("machineType")
    machine = GPU_MACHINE_TYPES.get(machine_type)
    if not machine:
        raise CloudError("The queued Google Cloud target has no supported GPU machine type.")
    cpu, memory_gib, accelerator = machine
    required_cpu, required_memory_gib = budget
    if settings.get("accelerator") != accelerator or (
            cpu < required_cpu or memory_gib < required_memory_gib):
        raise CloudError(
            f"{machine_type} does not meet the {model} model budget "
            f"({required_cpu} vCPU, {required_memory_gib} GiB, {accelerator}).")
    return required_cpu, required_memory_gib


def _supported_models(settings):
    names = list(MODEL_EXECUTION_BUDGETS)
    machine = GPU_MACHINE_TYPES.get(settings.get("machineType"))
    if machine is None:
        return names
    from .engine.muscriptor import MODELS as model_specs

    cpu, memory_gib, _ = machine
    return [
        name for name in names
        if (cpu >= MODEL_EXECUTION_BUDGETS[name][0]
            and memory_gib >= MODEL_EXECUTION_BUDGETS[name][1]
            and model_specs[name]["freeGiB"] <= 24)
    ]


def require_model(model):
    if model not in MODEL_EXECUTION_BUDGETS:
        raise CloudError("The selected MuScriptor size is not supported by this Cloud worker.")


def _settings(target=None):
    from .cloud import load_provider_settings

    if target is None:
        values = load_provider_settings(PROVIDER)
    else:
        if (not isinstance(target, dict) or target.get("version") != 1
                or target.get("provider") != PROVIDER
                or not isinstance(target.get("settings"), dict)):
            raise CloudError("Queued Google Cloud resource target is invalid or has a mismatched provider.")
        values = target["settings"]
    return _config_values(values, require_complete=bool(values))


def _store_settings(values):
    from .cloud import save_provider_settings

    return save_provider_settings(PROVIDER, values)


def _mode():
    from .cloud import _setting

    return _setting("processing_mode") or "local"


def _set_mode(mode):
    from .cloud import _setting

    _setting("processing_mode", mode)


def _verified_image(image):
    from .cloud_image import verify_image

    try:
        result = verify_image(image)
    except Exception as exc:
        if isinstance(exc, CloudError):
            raise
        raise CloudError(str(exc)) from exc
    if (not isinstance(result, dict) or set(result) != {"image", "digest", "sourceHash"}
            or result["image"] != image
            or not isinstance(result["digest"], str)
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", result["digest"])
            or not isinstance(result["sourceHash"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", result["sourceHash"])):
        raise CloudError("The shared worker-image verifier returned an invalid result.")
    if image.rsplit("@", 1)[-1] != result["digest"]:
        raise CloudError("The shared worker-image verifier returned a different digest.")
    return result


def _pin_verified_image(settings):
    if not settings.get("image"):
        return
    verified = _verified_image(settings["image"])
    if settings.get("workerSourceHash") not in (None, verified["sourceHash"]):
        raise CloudError(
            "The saved worker image no longer matches the bundled Google Cloud worker source.")
    settings["image"] = verified["image"]
    settings["workerSourceHash"] = verified["sourceHash"]


def _secret_base(settings):
    return f"projects/{settings['projectId']}/secrets/{WORKER_SECRET_ID}"


def _credential_version(settings):
    resource = settings.get("workerAuthResource")
    if not isinstance(resource, str) or not re.fullmatch(
            rf"{re.escape(_secret_base(settings))}/versions/[1-9][0-9]*", resource):
        raise CloudError(
            "Transfer the approved Hugging Face token in Google Cloud setup before starting a job.")
    return resource


def _rest():
    return _Rest()


def _resource_url(base, resource):
    return f"{base}/{resource}"


def _safe_project_id(project_id):
    return urllib.parse.quote(project_id, safe="")


def _project_url(project, service):
    return f"{SERVICE_USAGE_API}/projects/{_safe_project_id(project)}/services/{service}"


def _poll_operation(rest, name, *, deadline, cancelled=None, check_cancelled=None):
    if not isinstance(name, str) or not name or len(name) > 512 or "?" in name or "#" in name:
        raise CloudError("Google Cloud returned an invalid setup operation name.")
    url = f"{SERVICE_USAGE_API}/{name}"
    while time.monotonic() < deadline:
        if check_cancelled:
            check_cancelled()
        elif cancelled is not None and cancelled.is_set():
            raise Cancelled()
        operation = rest.request("GET", url, cancelled=cancelled)
        if operation.get("done") is True:
            error = operation.get("error")
            if error:
                raise CloudError("Google Cloud did not complete the approved setup operation.")
            return operation.get("response", {})
        time.sleep(min(POLL_INTERVAL, max(0, deadline - time.monotonic())))
    raise CloudError("Google Cloud setup operation exceeded its time limit; inspect resources before retrying.")


def _ensure_services(rest, project, *, check_cancelled):
    deadline = time.monotonic() + SETUP_TIMEOUT
    for service in REQUIRED_SERVICES:
        check_cancelled()
        status = rest.request(
            "GET", _project_url(project, service), missing_ok=True)
        if isinstance(status, dict) and status.get("state") == "ENABLED":
            continue
        operation = rest.request(
            "POST", f"{_project_url(project, service)}:enable", body={})
        name = operation.get("name")
        if not name:
            raise CloudError(
                f"Google Cloud accepted enabling {service} without returning an operation ID.")
        _poll_operation(
            rest, name, deadline=deadline,
            check_cancelled=check_cancelled)


def _ensure_bucket(rest, settings):
    bucket = settings["bucket"]
    url = f"{STORAGE_API}/b/{urllib.parse.quote(bucket, safe='')}"
    current = rest.request("GET", url, missing_ok=True)
    if current is None:
        rest.request("POST", f"{STORAGE_API}/b", params={"project": settings["projectId"]},
                     body={
                         "name": bucket,
                         "location": settings["region"],
                         "iamConfiguration": {
                             "uniformBucketLevelAccess": {"enabled": True},
                             "publicAccessPrevention": "enforced",
                         },
                     })
        current = rest.request("GET", url)
    iam = current.get("iamConfiguration")
    if (current.get("name") != bucket
            or str(current.get("location", "")).lower() != settings["region"].lower()
            or not isinstance(iam, dict)
            or (iam.get("uniformBucketLevelAccess") or {}).get("enabled") is not True
            or iam.get("publicAccessPrevention") != "enforced"):
        raise CloudError(
            "The selected bucket is not private, region-matched, and uniformly managed. "
            "Mizan did not change the existing bucket.")
    return current


def _ensure_service_account(rest, settings):
    project = _safe_project_id(settings["projectId"])
    email = settings["serviceAccount"]
    url = f"{IAM_API}/projects/{project}/serviceAccounts/{urllib.parse.quote(email, safe='@.')}"
    account = rest.request("GET", url, missing_ok=True)
    if account is None:
        account_id = email.split("@", 1)[0]
        account = rest.request(
            "POST", f"{IAM_API}/projects/{project}/serviceAccounts",
            body={"accountId": account_id, "serviceAccount": {"displayName": "Mizan cloud worker"}})
    if (not isinstance(account, dict)
            or account.get("email") != email
            or account.get("disabled") is True):
        raise CloudError("The selected Google Cloud worker service account is unavailable.")
    return url, account


def _ensure_secret(rest, settings):
    base = _secret_base(settings)
    url = f"{SECRET_MANAGER_API}/{base}"
    secret = rest.request("GET", url, missing_ok=True)
    if secret is None:
        secret = rest.request("POST", f"{SECRET_MANAGER_API}/projects/"
                              f"{_safe_project_id(settings['projectId'])}/secrets",
                              params={"secretId": WORKER_SECRET_ID},
                              body={"replication": {"automatic": {}}})
    if not isinstance(secret, dict) or secret.get("name") != base:
        raise CloudError("Google Cloud Secret Manager returned an unexpected worker credential resource.")
    return url


def _has_binding(policy, role, member):
    bindings = policy.get("bindings") if isinstance(policy, dict) else None
    return any(isinstance(binding, dict) and binding.get("role") == role
               and member in binding.get("members", [])
               for binding in (bindings or []))


def _add_binding(policy, role, member):
    if not isinstance(policy, dict):
        raise CloudError("Google Cloud returned an invalid IAM policy.")
    updated = dict(policy)
    bindings = list(policy.get("bindings", []))
    for index, binding in enumerate(bindings):
        if isinstance(binding, dict) and binding.get("role") == role:
            members = list(binding.get("members", []))
            if member not in members:
                bindings[index] = {**binding, "members": [*members, member]}
            updated["bindings"] = bindings
            return updated
    bindings.append({"role": role, "members": [member]})
    updated["bindings"] = bindings
    return updated


def _grant_binding(
    rest,
    get_url,
    set_url,
    role,
    member,
    *,
    get_method="POST",
    set_method="POST",
    get_params=None,
    get_body=None,
    storage_policy=False,
):
    policy = rest.request(
        "GET" if storage_policy else get_method,
        get_url,
        params=get_params,
        body=get_body if get_body is not None else (
            {"options": {"requestedPolicyVersion": 3}}
            if not storage_policy and get_method == "POST"
            else None),
    )
    if _has_binding(policy, role, member):
        return
    updated = _add_binding(policy, role, member)
    body = updated if storage_policy else {"policy": updated}
    rest.request("PUT" if storage_policy else set_method, set_url, body=body)


def _project_number(project):
    name = project.get("name") if isinstance(project, dict) else None
    match = re.fullmatch(r"projects/([0-9]+)", name if isinstance(name, str) else "")
    if not match:
        raise CloudError("Google Cloud did not return the project number needed for Batch access.")
    return match.group(1)


def _grant_permissions(rest, settings, sa_url, secret_url):
    member = f"serviceAccount:{settings['serviceAccount']}"
    bucket = urllib.parse.quote(settings["bucket"], safe="")
    _grant_binding(
        rest,
        f"{STORAGE_API}/b/{bucket}/iam",
        f"{STORAGE_API}/b/{bucket}/iam",
        "roles/storage.objectAdmin",
        member,
        storage_policy=True,
        get_params={"optionsRequestedPolicyVersion": 3},
    )
    secret_base = _secret_base(settings)
    _grant_binding(
        rest,
        f"{SECRET_MANAGER_API}/{secret_base}:getIamPolicy",
        f"{SECRET_MANAGER_API}/{secret_base}:setIamPolicy",
        "roles/secretmanager.secretAccessor",
        member,
        get_method="GET",
        get_params={"options.requestedPolicyVersion": 3},
    )
    project = _safe_project_id(settings["projectId"])
    project_info = rest.request("GET", f"{RESOURCE_MANAGER_API}/projects/{project}")
    project_number = _project_number(project_info)
    project_url = f"{RESOURCE_MANAGER_API}/projects/{project}"
    for role in ("roles/batch.agentReporter", "roles/logging.logWriter"):
        _grant_binding(
            rest,
            f"{project_url}:getIamPolicy",
            f"{project_url}:setIamPolicy",
            role,
            member,
            get_body={"options": {"requestedPolicyVersion": 3}},
        )
    batch_agent = f"service-{project_number}@gcp-sa-cloudbatch.iam.gserviceaccount.com"
    _grant_binding(
        rest,
        f"{sa_url}:getIamPolicy",
        f"{sa_url}:setIamPolicy",
        "roles/iam.serviceAccountUser",
        f"serviceAccount:{batch_agent}",
    )


def _enable_private_settings(rest, settings, ops):
    ops.step("services", 1, "Enabling the approved Google Cloud services.")
    _ensure_services(rest, settings["projectId"], check_cancelled=ops.check_cancelled)
    ops.check_cancelled()
    ops.step("bucket", 2, "Creating or checking the private Cloud Storage bucket.")
    _ensure_bucket(rest, settings)
    ops.check_cancelled()
    ops.step("identity", 3, "Creating or checking the Batch worker service account.")
    sa_url, _ = _ensure_service_account(rest, settings)
    ops.check_cancelled()
    ops.step("credentials", 4, "Creating the native Secret Manager reference.")
    secret_url = _ensure_secret(rest, settings)
    ops.check_cancelled()
    ops.step("permissions", 5, "Granting only the required bucket, secret, and Batch access.")
    _grant_permissions(rest, settings, sa_url, secret_url)
    ops.check_cancelled()
    ops.step("complete", 6, "Google Cloud resources and permissions are ready.")


def list_subscriptions():
    rest = _rest()
    try:
        projects = []
        page_token = None
        for _ in range(10):
            page = rest.request(
                "GET", f"{RESOURCE_MANAGER_API}/projects:search",
                params={"pageSize": 1000, **({"pageToken": page_token} if page_token else {})})
            values = page.get("projects", [])
            if not isinstance(values, list):
                raise CloudError("Google Cloud returned an invalid project list.")
            for project in values:
                if (isinstance(project, dict) and project.get("state") == "ACTIVE"
                        and isinstance(project.get("projectId"), str)):
                    projects.append({
                        "projectId": project["projectId"],
                        "projectName": project.get("displayName", project["projectId"]),
                        "projectNumber": _project_number(project),
                        "state": project["state"],
                    })
            page_token = page.get("nextPageToken")
            if not page_token:
                return projects
        if page_token:
            raise CloudError("Google Cloud returned too many project pages to list safely.")
        return projects
    except _ApiError as exc:
        raise _api_error(exc) from None
    finally:
        rest.close()


def configure(config):
    values = _config_values(config)
    rest = _rest()
    try:
        project = rest.request(
            "GET", f"{RESOURCE_MANAGER_API}/projects/{_safe_project_id(values['projectId'])}")
        if (project.get("projectId") != values["projectId"]
                or project.get("state") != "ACTIVE"):
            raise CloudError("Choose an active Google Cloud project visible to these credentials.")
    except _ApiError as exc:
        raise _api_error(exc) from None
    finally:
        rest.close()
    from .cloud import load_provider_settings

    previous = load_provider_settings(PROVIDER)
    resource_fields = (
        "projectId", "region", "bucket", "serviceAccount", "machineType", "accelerator")
    unchanged = all(previous.get(key) == values[key] for key in resource_fields)
    if unchanged:
        for key in ("workerSourceHash", "workerAuthResource", "image"):
            if key not in values and key in previous:
                if (key == "workerSourceHash" and "image" in values
                        and values["image"] != previous.get("image")):
                    continue
                values[key] = previous[key]
        values["prepared"] = previous.get("prepared", False)
    else:
        values["prepared"] = False
        if "image" not in values:
            for key in ("image", "workerSourceHash"):
                if key in previous:
                    values[key] = previous[key]
    _pin_verified_image(values)
    saved = _store_settings(values)
    _set_mode("local")
    result = status(check_connection=False)
    result["config"] = {**saved, "provider": PROVIDER}
    return result


def prepare(config, consent=False):
    if consent is not True:
        raise CloudError(
            "Google Cloud resource creation and permission changes require explicit approval.")
    values = _config_values(config)
    from .cloud import load_provider_settings

    previous = load_provider_settings(PROVIDER)
    if all(previous.get(key) == values[key] for key in (
            "projectId", "region", "bucket", "serviceAccount", "machineType", "accelerator")):
        for key in ("image", "workerSourceHash", "workerAuthResource"):
            if key not in values and key in previous:
                values[key] = previous[key]
    _pin_verified_image(values)
    values["prepared"] = False
    saved = _store_settings(values)
    ops = _STATE
    rest = _rest()
    try:
        with ops.track_setup("provision", 6):
            _enable_private_settings(rest, saved, ops)
            saved["prepared"] = True
            saved = _store_settings(saved)
    except Cancelled as exc:
        raise CloudError(
            "Google Cloud setup was cancelled. Some approved resources may already exist; "
            "review the project before retrying.") from exc
    except _ApiError as exc:
        raise _api_error(exc) from None
    finally:
        rest.close()
    result = status(check_connection=False)
    result.update(prepared=True, configured=False, next="import_worker_image")
    result["config"] = {**saved, "provider": PROVIDER}
    return result


def track_setup(operation, total):
    return _STATE.track_setup(operation, total)


def setup_progress():
    return _STATE.setup_progress()


def cancel_setup():
    return _STATE.cancel_setup()


def readiness_progress(request_id):
    return _STATE.readiness_progress(request_id)


def cancel_panel_status(request_id):
    return _STATE.cancel_panel_status(request_id)


def panel_status(request_id=None):
    request_id = request_id or str(uuid4())
    values = _settings()
    if not values:
        result = _status_for_settings({}, check_connection=False)
        result["requestId"] = request_id
        return result
    frozen = {"version": 1, "provider": PROVIDER, "settings": dict(values)}
    result = _STATE.panel_status(
        request_id,
        lambda cancelled: _status_for_settings(
            values, check_connection=True, cancelled=cancelled, target=frozen),
    )
    if result.get("issue"):
        snapshot = _status_for_settings(values, check_connection=False)
        snapshot.update(result)
        snapshot["configured"] = False
        snapshot["requestId"] = request_id
        return snapshot
    result["requestId"] = request_id
    return result


def _status_for_settings(settings, *, check_connection, cancelled=None, target=None):
    mode = _mode()
    supported = _supported_models(settings)
    result = {
        "ok": True,
        "provider": PROVIDER,
        "providerName": PROVIDER_NAME,
        "available": True,
        "configured": False,
        "verified": False,
        "verifiedModels": [],
        "supportedModels": supported,
        "workerDigest": None,
        "workerImage": None,
        "mode": mode,
        "prepared": bool(settings.get("prepared")),
        "jobCreated": False,
        "runtimeVerified": False,
        "requiresHfTokenConsent": True,
    }
    if settings:
        result["config"] = {
            key: value for key, value in settings.items()
            if key != "prepared"
        }
        image = settings.get("image")
        if image and check_connection:
            try:
                verified = _verified_image(image)
                if settings.get("workerSourceHash") != verified["sourceHash"]:
                    raise CloudError(
                        "The Google Cloud image is not imported for this worker source. "
                        "Import the verified image again.")
                result.update(
                    verified=True,
                    verifiedModels=supported,
                    workerDigest=verified["digest"],
                    workerImage=verified["image"],
                )
            except Exception as exc:
                result["issue"] = str(exc) if isinstance(exc, CloudError) else (
                    "The Google Cloud worker image could not be verified.")
        elif image:
            result["workerImage"] = image
        else:
            result["issue"] = "Enter the public immutable GHCR worker image in Cloud setup."
    else:
        result["issue"] = "Configure Google Cloud project, region, bucket, service account, and GPU."

    if not settings or not check_connection or not settings.get("image"):
        if settings and check_connection is False:
            result.setdefault("issue", "Google Cloud readiness has not been checked.")
        return result

    rest = _rest()
    try:
        if cancelled is not None and cancelled.is_set():
            raise Cancelled()
        _check_readiness_resources(rest, settings)
        if cancelled is not None and cancelled.is_set():
            raise Cancelled()
        secret_ref = settings.get("workerAuthResource")
        if secret_ref:
            version = rest.request("GET", f"{SECRET_MANAGER_API}/{secret_ref}")
            if version.get("state") == "ENABLED":
                result["requiresHfTokenConsent"] = False
        else:
            result["requiresHfTokenConsent"] = True
        if secret_ref and result["requiresHfTokenConsent"]:
            result["issue"] = (
                "The pinned Google Cloud Secret Manager token version is unavailable or "
                "disabled; approve a new token transfer.")
        result["prepared"] = True
        result["configured"] = (
            result["verified"] and not result["requiresHfTokenConsent"])
        if not result["configured"]:
            result.setdefault(
                "issue",
                "Google Cloud resources are ready; approve the Hugging Face token transfer to finish setup.")
            if result["requiresHfTokenConsent"]:
                result["next"] = "transfer_hf_token"
        else:
            result["next"] = "ready"
    except Cancelled:
        raise
    except (_ApiError, CloudError) as exc:
        result["configured"] = False
        result["issue"] = str(_api_error(exc))
    finally:
        rest.close()
    return result


def _check_readiness_resources(rest, settings):
    project = _safe_project_id(settings["projectId"])
    bucket = urllib.parse.quote(settings["bucket"], safe="")
    bucket_info = rest.request("GET", f"{STORAGE_API}/b/{bucket}")
    iam = bucket_info.get("iamConfiguration")
    if (str(bucket_info.get("location", "")).lower() != settings["region"].lower()
            or ((iam or {}).get("uniformBucketLevelAccess") or {}).get("enabled") is not True):
        raise CloudError("The Google Cloud Storage bucket does not enforce private uniform access.")
    if (iam or {}).get("publicAccessPrevention") != "enforced":
        raise CloudError("The Google Cloud Storage bucket does not enforce public access prevention.")
    sa = urllib.parse.quote(settings["serviceAccount"], safe="@.")
    account = rest.request(
        "GET", f"{IAM_API}/projects/{project}/serviceAccounts/{sa}")
    if account.get("email") != settings["serviceAccount"] or account.get("disabled") is True:
        raise CloudError("The Google Cloud Batch worker service account is unavailable.")
    member = f"serviceAccount:{settings['serviceAccount']}"
    bucket_policy = rest.request(
        "GET",
        f"{STORAGE_API}/b/{bucket}/iam",
        params={"optionsRequestedPolicyVersion": 3},
    )
    if not _has_binding(bucket_policy, "roles/storage.objectAdmin", member):
        raise CloudError("The worker service account lacks private bucket access.")
    secret_base = _secret_base(settings)
    secret_policy = rest.request(
        "GET", f"{SECRET_MANAGER_API}/{secret_base}:getIamPolicy",
        params={"options.requestedPolicyVersion": 3})
    if not _has_binding(secret_policy, "roles/secretmanager.secretAccessor", member):
        raise CloudError("The worker service account lacks access to its Secret Manager token.")
    project_info = rest.request("GET", f"{RESOURCE_MANAGER_API}/projects/{project}")
    project_number = _project_number(project_info)
    agent = f"serviceAccount:service-{project_number}@gcp-sa-cloudbatch.iam.gserviceaccount.com"
    sa_policy = rest.request(
        "POST", f"{IAM_API}/projects/{project}/serviceAccounts/{sa}:getIamPolicy",
        body={"options": {"requestedPolicyVersion": 3}})
    if not _has_binding(sa_policy, "roles/iam.serviceAccountUser", agent):
        raise CloudError("The Google Cloud Batch service agent cannot use the worker service account.")
    project_policy = rest.request(
        "POST",
        f"{RESOURCE_MANAGER_API}/projects/{project}:getIamPolicy",
        body={"options": {"requestedPolicyVersion": 3}},
    )
    for role in ("roles/batch.agentReporter", "roles/logging.logWriter"):
        if not _has_binding(project_policy, role, member):
            raise CloudError(f"The worker service account lacks {role} on the Google Cloud project.")
    for service in REQUIRED_SERVICES:
        state = rest.request("GET", _project_url(settings["projectId"], service))
        if state.get("state") != "ENABLED":
            raise CloudError(f"Google Cloud service {service} is not enabled.")


def status(*, check_connection=True, target=None):
    settings = _settings(target)
    if not settings:
        return _status_for_settings({}, check_connection=False)
    return _status_for_settings(settings, check_connection=check_connection, target=target)


def import_cloud_image(source_image):
    from .cloud import load_provider_settings

    saved = load_provider_settings(PROVIDER)
    if not saved:
        raise CloudError("Configure Google Cloud before selecting its worker image.")
    settings = _config_values(saved)
    verified = _verified_image(source_image)
    settings["image"] = verified["image"]
    settings["workerSourceHash"] = verified["sourceHash"]
    saved = _store_settings(settings)
    return {
        "provider": PROVIDER,
        "ok": True,
        "image": verified["image"],
        "digest": verified["digest"],
        "verified": True,
        "sourceHash": verified["sourceHash"],
        "config": {**saved, "provider": PROVIDER},
    }


def build_cloud_image():
    from .cloud import load_provider_settings

    settings = load_provider_settings(PROVIDER)
    image = settings.get("image")
    if not image:
        raise CloudError(
            "Paste the public immutable GHCR worker digest and use Import worker image. "
            "Google Cloud does not build or publish the shared image.")
    verified = _verified_image(image)
    if settings.get("workerSourceHash") != verified["sourceHash"]:
        raise CloudError("The saved worker source hash is stale; import the verified image again.")
    return {"ok": True, "verified": True, **verified}


def enable_log_analytics(consent=False):
    raise CloudError("Google Cloud does not use the Azure Log Analytics setup operation.")


def set_mode(mode):
    if mode not in ("local", "cloud"):
        raise CloudError("Choose local or cloud processing.")
    if mode == "local":
        _set_mode(mode)
        return {"ok": True, "mode": mode}
    check = status(check_connection=True)
    if not check.get("configured"):
        raise CloudError(check.get(
            "issue", "Complete Google Cloud setup before enabling processing."))
    _set_mode("cloud")
    return {**check, "ok": True, "mode": mode}


def finish(image, hf_token=None, *, hf_token_provider=None):
    from .cloud import load_provider_settings

    settings = load_provider_settings(PROVIDER)
    if not settings or not settings.get("prepared"):
        raise CloudError("Complete approved Google Cloud resource setup before finishing worker setup.")
    settings = _config_values(settings)
    verified = _verified_image(image)
    if settings.get("workerSourceHash") not in (None, verified["sourceHash"]):
        raise CloudError("The worker image no longer matches the bundled Google Cloud worker source.")
    if (settings.get("image") != verified["image"]
            or settings.get("workerSourceHash") != verified["sourceHash"]):
        raise CloudError("Import and save the verified Google Cloud worker image before finishing setup.")
    candidate = {**settings, "image": verified["image"],
                 "workerSourceHash": verified["sourceHash"]}
    if hf_token_provider is None and hf_token is None:
        result = _status_for_settings(candidate, check_connection=True)
        if settings.get("image") != verified["image"]:
            result.update(
                configured=False,
                jobCreated=False,
                issue="Import and save this verified worker image before finishing setup.",
            )
        result["requiresHfTokenConsent"] = bool(result.get("requiresHfTokenConsent", True))
        return result

    try:
        token = hf_token_provider() if hf_token_provider is not None else hf_token
    except Exception:
        raise CloudError(
            "The saved Hugging Face token could not be read. Review the local token setting "
            "and approve the transfer again.") from None
    if (not isinstance(token, str) or not re.fullmatch(r"hf_[A-Za-z0-9]{10,}", token)
            or len(token) > 8192):
        raise CloudError("The approved Hugging Face token is invalid.")
    rest = _rest()
    try:
        _check_readiness_resources(rest, candidate)
        body = {"payload": {"data": base64.b64encode(token.encode("utf-8")).decode("ascii")}}
        created = rest.request(
            "POST", f"{SECRET_MANAGER_API}/{_secret_base(candidate)}:addVersion", body=body)
        resource = created.get("name")
        expected = rf"{re.escape(_secret_base(candidate))}/versions/[1-9][0-9]*"
        if not isinstance(resource, str) or not re.fullmatch(expected, resource):
            raise CloudError("Google Cloud did not return a valid Secret Manager version resource.")
        candidate["workerAuthResource"] = resource
        saved = _store_settings(candidate)
    except _ApiError as exc:
        raise _api_error(exc) from None
    finally:
        rest.close()
    result = _status_for_settings(saved, check_connection=True)
    result["jobCreated"] = False
    result["config"] = {
        key: value for key, value in saved.items()
        if key != "prepared"
    }
    return result


class _GCSFileStore:
    def __init__(self, rest, settings):
        self.rest = rest
        self.bucket = settings["bucket"]

    @staticmethod
    def _validate_name(name):
        if (not isinstance(name, str)
                or not re.fullmatch(
                    r"jobs/[0-9a-f-]{36}/(?:input\.wav|result\.json|result/stems/"
                    r"(?:drums|bass|other|vocals|guitar|piano)\.wav)",
                    name, re.IGNORECASE)):
            raise CloudError("Cannot transfer an invalid Google Cloud job file name.")

    def _object_url(self, name, upload=False):
        self._validate_name(name)
        base = STORAGE_UPLOAD_API if upload else STORAGE_API
        url = f"{base}/b/{urllib.parse.quote(self.bucket, safe='')}/o"
        if not upload:
            url += f"/{urllib.parse.quote(name, safe='')}"
        return url

    def upload(self, name, path, *, limit=MAX_AUDIO_BYTES, cancelled=None):
        self._validate_name(name)
        path = Path(path)
        try:
            size = path.stat().st_size
            if size < 0 or size > limit:
                raise CloudError("The recording exceeds the Google Cloud upload size limit.")
            params = {"uploadType": "media", "name": name, "ifGenerationMatch": 0}
            with path.open("rb") as stream:
                response = self.rest.request(
                    "POST", self._object_url(name, upload=True), params=params,
                    data=stream,
                    headers={"Content-Type": "application/octet-stream",
                             "Content-Length": str(size)},
                    cancelled=cancelled,
                )
            if response.get("name") != name:
                raise CloudError("Google Cloud did not confirm the uploaded recording.")
        except OSError:
            raise CloudError("Could not read the recording for Google Cloud upload.") from None

    def download(self, name, path, *, limit, cancelled=None):
        url = self._object_url(name)
        response = self.rest.stream(
            "GET", url, params={"alt": "media"}, cancelled=cancelled)
        target = Path(path)
        digest = hashlib.sha256()
        count = 0
        try:
            header = response.headers.get("Content-Length")
            if header is not None:
                try:
                    if int(header) < 0 or int(header) > limit:
                        raise CloudError("Google Cloud returned an object larger than the allowed limit.")
                except ValueError:
                    raise CloudError("Google Cloud returned an invalid object size.") from None
            with target.open("wb") as output:
                for block in response.iter_content(chunk_size=256 * 1024):
                    if cancelled is not None and cancelled.is_set():
                        raise Cancelled()
                    if not block:
                        continue
                    count += len(block)
                    if count > limit:
                        raise CloudError("Google Cloud returned an object larger than the allowed limit.")
                    digest.update(block)
                    output.write(block)
            if header is not None and count != int(header):
                raise CloudError("Google Cloud returned an object with an incomplete size.")
            return count, digest.hexdigest()
        except Exception:
            target.unlink(missing_ok=True)
            raise
        finally:
            response.close()

    def delete(self, names):
        for name in names:
            url = self._object_url(name)
            self.rest.request("DELETE", url, missing_ok=True)


def _job_names(prefix):
    return [f"{prefix}/input.wav", f"{prefix}/result.json",
            *(f"{prefix}/result/stems/{stem}.wav" for stem in STEMS)]


def _batch_job(settings, model, source, result, job_id):
    cpu, memory = _model_resources(model, settings)
    secret_version = _credential_version(settings)
    image = settings.get("image")
    if not image or settings.get("workerSourceHash") is None:
        raise CloudError("Import and verify the public worker image before starting a Google Cloud job.")
    verified = _verified_image(image)
    if verified["sourceHash"] != settings["workerSourceHash"]:
        raise CloudError("The queued Google Cloud worker image does not match its saved source hash.")
    accelerator = GPU_MACHINE_TYPES[settings["machineType"]][2]
    return {
        "taskGroups": [{
            "taskCount": 1,
            "taskSpec": {
                "runnables": [{
                    "container": {
                        "imageUri": verified["image"],
                        "commands": [source, result, model],
                    },
                    "environment": {
                        "variables": {
                            "CLOUD_STORAGE_PROVIDER": "gcp",
                            "GCS_BUCKET": settings["bucket"],
                            "GOOGLE_CLOUD_PROJECT": settings["projectId"],
                        },
                        "secretVariables": {"HF_TOKEN": secret_version},
                    },
                }],
                "computeResource": {
                    "cpuMilli": cpu * 1000,
                    "memoryMib": memory * 1024,
                    "bootDiskMib": 50 * 1024,
                },
                "maxRunDuration": f"{JOB_TIMEOUT}s",
                "maxRetryCount": 0,
            },
        }],
        "allocationPolicy": {
            "instances": [{
                "policy": {
                    "machineType": settings["machineType"],
                    "accelerators": [{"type": accelerator, "count": 1}],
                },
                "installGpuDrivers": True,
            }],
            "serviceAccount": {"email": settings["serviceAccount"]},
            "location": {"allowedLocations": [f"regions/{settings['region']}"]},
        },
        "logsPolicy": {"destination": "CLOUD_LOGGING"},
        "labels": {"application": "mizan", "job": job_id},
    }


def _job_url(settings, name):
    root = (f"{BATCH_API}/projects/{_safe_project_id(settings['projectId'])}"
            f"/locations/{urllib.parse.quote(settings['region'], safe='-')}/jobs")
    return root if name is None else f"{root}/{urllib.parse.quote(name, safe='-')}"


def _job_state(job):
    status = job.get("status") if isinstance(job, dict) else None
    state = status.get("state") if isinstance(status, dict) else None
    if not isinstance(state, str):
        raise CloudError("Google Cloud Batch returned a job without a state.")
    return state


def _operation_url(name, settings):
    if name.startswith("projects/"):
        return f"{BATCH_API}/{name}"
    return (f"{BATCH_API}/projects/{_safe_project_id(settings['projectId'])}"
            f"/locations/{urllib.parse.quote(settings['region'], safe='-')}/operations/"
            f"{urllib.parse.quote(name.rsplit('/', 1)[-1], safe='-')}")


def _cancel_job(rest, settings, name, *, timeout=None):
    timeout = CANCEL_TIMEOUT if timeout is None else timeout
    request_id = str(uuid4())
    delete_operation = None
    delete_accepted = False
    try:
        delete_operation = rest.request(
            "DELETE", _job_url(settings, name), params={"requestId": request_id})
        delete_accepted = True
    except (_ApiError, CloudError):
        # A delete timeout is ambiguous; status polling can still prove the job stopped.
        delete_operation = None
    operation_name = delete_operation.get("name") if isinstance(delete_operation, dict) else None
    deadline = time.monotonic() + timeout
    operation_done = delete_accepted and not operation_name
    while time.monotonic() < deadline:
        if operation_name and not operation_done:
            try:
                operation = rest.request(
                    "GET", _operation_url(operation_name, settings), missing_ok=True)
                if operation is None:
                    operation_done = False
                elif operation.get("done") is True:
                    if operation.get("error"):
                        return False
                    operation_done = True
            except (CloudError, _ApiError):
                pass
        try:
            job = rest.request("GET", _job_url(settings, name), missing_ok=True)
        except (CloudError, _ApiError):
            job = None
        else:
            if job is None:
                return True
        if job is not None:
            try:
                if _job_state(job) in TERMINAL_STATES:
                    return True
            except CloudError:
                return False
        time.sleep(min(POLL_INTERVAL, max(0, deadline - time.monotonic())))
    return False


def _read_worker_result(store, result_name, result_path, run_id, cancelled):
    store.download(result_name, result_path, limit=MAX_RESULT_BYTES, cancelled=cancelled)
    try:
        payload = json.loads(result_path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError):
        raise CloudError("Google Cloud worker output is not valid JSON.") from None
    finally:
        result_path.unlink(missing_ok=True)
    worker_error = validate_worker_error(payload, run_id)
    if worker_error:
        raise CloudError(
            f"Google Cloud worker failed during {worker_error['stage']} "
            f"({worker_error['category']}): {worker_error['message']}")
    return payload


def _job_failure_message(job, name):
    status = job.get("status") if isinstance(job, dict) else None
    events = status.get("statusEvents") if isinstance(status, dict) else None
    details = []
    for event in events if isinstance(events, list) else []:
        description = event.get("description") if isinstance(event, dict) else None
        if isinstance(description, str) and description.strip():
            safe = re.sub(r"https?://\S+", "[URL redacted]", description)
            safe = re.sub(r"(?i)\b(Bearer|token|password|authorization)\s*[:=]?\s*\S+",
                          "[redacted]", safe)
            details.append(" ".join(safe.split())[:300])
        if len(details) == 2:
            break
    suffix = f" {' '.join(details)}" if details else ""
    return f"Google Cloud Batch job ended with state {_job_state(job)}.{suffix}"


def offload(recording, directory, model, cancelled, report, *, target=None):
    from .cloud import validate_remote_job

    settings = _settings(target)
    if not settings:
        raise CloudError("Configure Google Cloud before starting cloud processing.")
    _model_resources(model, settings)
    _credential_version(settings)
    if cancelled.is_set():
        raise Cancelled()
    rest = _rest()
    run_id = str(uuid4())
    prefix = f"jobs/{run_id}"
    names = _job_names(prefix)
    source, result_name = names[:2]
    job_id = f"mizan-{run_id.replace('-', '')}"
    job = None
    terminal = False
    submission_unknown = False
    files_cleaned = False
    cancellation_attempted = False
    store = _GCSFileStore(rest, settings)

    def remove_files():
        nonlocal files_cleaned
        if not files_cleaned:
            store.delete(names)
            files_cleaned = True

    def stop_job():
        nonlocal terminal, cancellation_attempted
        if cancellation_attempted:
            return terminal
        cancellation_attempted = True
        terminal = _cancel_job(rest, settings, job_id)
        return terminal

    try:
        report("detect", 0, message="Connecting to Google Cloud processing")
        _check_readiness_resources(rest, settings)
        report("detect", 0, message="Uploading prepared audio")
        store.upload(source, recording, limit=MAX_AUDIO_BYTES, cancelled=cancelled)
        if cancelled.is_set():
            raise Cancelled()
        payload = _batch_job(settings, model, source, result_name, job_id)
        report("detect", 0, message="Submitting Google Cloud Batch GPU job")
        submission_unknown = True
        try:
            created = rest.request(
                "POST", _job_url(settings, None), params={"jobId": job_id}, body=payload)
        except _ApiError as exc:
            if exc.status >= 500:
                raise CloudError(
                    f"Google Cloud Batch submission outcome is unknown for {job_id}; "
                    "no second job was submitted. Check Batch before retrying.") from None
            submission_unknown = False
            raise _api_error(exc) from None
        except CloudError as exc:
            raise CloudError(
                f"Google Cloud Batch submission outcome is unknown for {job_id}; "
                "no second job was submitted. Check Batch before retrying.") from exc
        name = created.get("name")
        expected_name = (f"projects/{settings['projectId']}/locations/{settings['region']}"
                         f"/jobs/{job_id}")
        if name != expected_name:
            raise CloudError("Google Cloud Batch returned an unexpected job resource name.")
        job = validate_remote_job(
            {"provider": PROVIDER, "id": name, "prefix": prefix}, PROVIDER)
        submission_unknown = False
        try:
            report("detect", 0, message="Waiting for Google Cloud Batch GPU job", cloud_job=job)
        except Cancelled:
            if stop_job():
                remove_files()
            else:
                raise CloudError(
                    "Google Cloud cancellation was requested, but the Batch job stop "
                    "could not be confirmed. Remote files were retained.")
            raise
        deadline = time.monotonic() + JOB_TIMEOUT
        last_state = None
        while time.monotonic() < deadline:
            if cancelled.wait(POLL_INTERVAL):
                if stop_job():
                    remove_files()
                    raise Cancelled()
                raise CloudError(
                    "Google Cloud cancellation was requested, but the Batch job stop "
                    "could not be confirmed. Remote files were retained.")
            current = rest.request("GET", _job_url(settings, job_id), cancelled=cancelled)
            state = _job_state(current)
            if state != last_state:
                last_state = state
                message = {
                    "QUEUED": "Google Cloud GPU job queued",
                    "SCHEDULED": "Google Cloud GPU job scheduled",
                    "RUNNING": "Google Cloud GPU job running",
                    "SUCCEEDED": "Google Cloud GPU job completed; retrieving results",
                    "FAILED": "Google Cloud GPU job failed",
                    "CANCELLING": "Google Cloud GPU job is stopping",
                    "CANCELED": "Google Cloud GPU job was canceled",
                    "CANCELLED": "Google Cloud GPU job was canceled",
                }.get(state)
                if message:
                    report("detect", 0, message=message)
            if state == "SUCCEEDED":
                terminal = True
                break
            if state in TERMINAL_STATES:
                terminal = True
                if state == "FAILED":
                    try:
                        _read_worker_result(
                            store, result_name, Path(directory) / "cloud-worker-result.json",
                            run_id, cancelled)
                    except CloudError as exc:
                        raise CloudError(f"{_job_failure_message(current, name)} {exc}") from exc
                raise CloudError(_job_failure_message(current, name))
            if state not in ACTIVE_STATES:
                raise CloudError(f"Google Cloud Batch reported an unknown job state: {state}.")
        else:
            if stop_job():
                remove_files()
            else:
                raise CloudError(
                    "Google Cloud Batch job exceeded the two-hour execution limit, but its stop "
                    "could not be confirmed. Remote files were retained.")
            raise CloudError(
                "Google Cloud Batch job exceeded the two-hour execution limit; "
                "the job was stopped and its remote files were removed.")
        if cancelled.is_set():
            store.delete(names)
            raise Cancelled()
        report("detect", 0, message="Retrieving Google Cloud worker results")
        manifest = _read_worker_result(
            store, result_name, Path(directory) / "cloud-worker-result.json", run_id, cancelled)
        report("detect", 0, message="Validating Google Cloud worker results")
        checked = materialize(
            manifest, store, names, Path(recording), Path(directory), model, error_type=CloudError)
        return checked, names
    except Cancelled:
        if job is not None and not terminal:
            if stop_job():
                remove_files()
            else:
                raise CloudError(
                    "Google Cloud cancellation was requested, but the Batch job stop "
                    "could not be confirmed. Remote files were retained.")
        elif job is not None and terminal:
            remove_files()
        elif job is None and not submission_unknown:
            remove_files()
        raise
    except Exception:
        if job is not None and not terminal:
            try:
                if stop_job():
                    remove_files()
            except Exception:
                logger.exception("Could not confirm Google Cloud Batch job stop job=%s", job_id)
        elif job is None and not submission_unknown:
            # A rejected or unattempted submission cannot still be processing the files.
            remove_files()
        elif job is not None and terminal:
            try:
                remove_files()
            except Exception:
                logger.exception("Could not remove terminal Google Cloud job files run_id=%s", run_id)
        raise
    finally:
        rest.close()


def cleanup(names, *, target=None):
    settings = _settings(target)
    if not settings:
        raise CloudError("The Google Cloud target was removed before remote files could be cleaned up.")
    if (not isinstance(names, list) or len(names) != len(STEMS) + 2
            or not all(isinstance(name, str) for name in names)
            or not re.fullmatch(r"jobs/[0-9a-f-]{36}/input\.wav", names[0], re.IGNORECASE)):
        raise CloudError("Cannot clean up invalid Google Cloud job file names.")
    prefix = names[0].removesuffix("/input.wav")
    expected = _job_names(prefix)
    if names != expected:
        raise CloudError("Google Cloud files do not belong to the same job.")
    rest = _rest()
    try:
        _GCSFileStore(rest, settings).delete(names)
    except _ApiError as exc:
        raise _api_error(exc) from None
    finally:
        rest.close()
