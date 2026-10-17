"""Provider-neutral cloud processing entry points."""

from copy import deepcopy
import importlib
import json
import re
import sqlite3
from contextlib import closing

from .errors import MizanError
from .paths import home

AZURE_PROVIDER = "azure"
PROVIDER_NAMES = {
    AZURE_PROVIDER: "Azure",
    "gcp": "Google Cloud",
    "aws": "AWS",
}
PROVIDER_MODULES = {provider: f"mizan.{provider}_cloud" for provider in PROVIDER_NAMES}
TARGET_FIELDS = {
    "azure": (
        "tenantId", "subscriptionId", "resourceGroup", "storageAccount", "container",
        "jobName", "location", "registry", "vnet", "subnet", "subnetResourceId",
        "vnetCidr", "subnetCidr", "environment", "identity", "userObjectId", "image",
    ),
    "gcp": ("projectId", "location", "region", "bucket", "serviceAccount",
            "machineType", "accelerator", "image", "workerSourceHash", "workerAuthResource"),
    "aws": ("profile", "region", "accountId", "bucket", "computeEnvironment",
            "jobQueue", "jobDefinition", "role", "subnetIds", "securityGroupIds", "image",
            "executionRole", "serviceRole", "instanceRole", "hfSecretArn", "sourceHash",
            "vpcId", "routeTableId", "internetGatewayId"),
}
NONSECRET_REFERENCES = {
    "hfSecretArn": (
        r"arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}"
    ),
    "workerAuthResource": (
        r"projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/secrets/mizan-worker-hf-token/versions/[1-9][0-9]*"
    ),
}
OPERATIONS = {
    "status", "panel_status", "cancel_panel_status", "readiness_progress",
    "setup_progress", "track_setup", "cancel_setup", "list_subscriptions",
    "configure", "prepare", "enable_log_analytics", "import_cloud_image",
    "build_cloud_image", "finish", "set_mode", "require_model", "offload", "cleanup",
}


class CloudError(MizanError):
    code = "cloud_failed"
    message = "Cloud processing failed."


def _connection():
    return sqlite3.connect(home() / "mizan.db")


def _setting(key, value=None):
    with closing(_connection()) as db:
        db.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        if value is None:
            row = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
            return row[0] if row else None
        with db:
            db.execute("INSERT INTO settings (key, value) VALUES (?, ?) "
                       "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))


def _checked_provider(provider):
    if not isinstance(provider, str) or provider not in PROVIDER_NAMES:
        label = repr(provider)[:100]
        supported = ", ".join(PROVIDER_NAMES)
        raise CloudError(f"Unsupported Cloud provider {label}. Supported providers: {supported}.")
    return provider


def resolve_provider(provider=None):
    if provider is not None:
        return _checked_provider(provider)
    active_provider = _setting("cloud_provider")
    return _checked_provider(active_provider) if active_provider is not None else AZURE_PROVIDER


def provider_for_job(provider=None):
    """Resolve a job's immutable provider; missing IDs identify legacy Azure jobs."""
    return resolve_provider(AZURE_PROVIDER if provider is None else provider)


def _settings_key(provider):
    return "cloud_config" if provider == AZURE_PROVIDER else f"cloud_config:{provider}"


def _contains_secret_field(value):
    secret_words = ("token", "password", "secret", "credential", "privatekey",
                    "accesskey", "apikey", "serviceaccountkey")
    if isinstance(value, dict):
        for key, item in value.items():
            if key in NONSECRET_REFERENCES:
                if not isinstance(item, str) or not re.fullmatch(NONSECRET_REFERENCES[key], item):
                    return True
                continue
            if ((isinstance(key, str) and any(
                    word in "".join(char.lower() for char in key if char.isalnum())
                    for word in secret_words))
                    or _contains_secret_field(item)):
                return True
        return False
    if isinstance(value, (list, tuple)):
        return any(_contains_secret_field(item) for item in value)
    return False


def load_provider_settings(provider):
    """Load a provider's saved JSON settings without consulting active selection."""
    provider = _checked_provider(provider)
    saved = _setting(_settings_key(provider))
    if saved is None:
        return {}
    try:
        settings = json.loads(saved)
    except (TypeError, ValueError) as exc:
        raise CloudError(f"Saved {PROVIDER_NAMES[provider]} settings are invalid.") from exc
    if not isinstance(settings, dict):
        raise CloudError(f"Saved {PROVIDER_NAMES[provider]} settings must be an object.")
    try:
        json.dumps(settings, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise CloudError(f"Saved {PROVIDER_NAMES[provider]} settings are invalid.") from exc
    if _contains_secret_field(settings):
        raise CloudError(f"Saved {PROVIDER_NAMES[provider]} settings must not contain credentials or tokens.")
    if "provider" in settings and settings["provider"] != provider:
        raise CloudError(f"Saved {PROVIDER_NAMES[provider]} settings have a mismatched provider ID.")
    return settings


def save_provider_settings(provider, settings):
    """Persist one provider's nonsecret settings without modifying any other provider."""
    provider = _checked_provider(provider)
    if not isinstance(settings, dict):
        raise CloudError(f"Choose valid {PROVIDER_NAMES[provider]} settings.")
    if _contains_secret_field(settings):
        raise CloudError(f"Do not save credentials or tokens in {PROVIDER_NAMES[provider]} settings.")
    if "provider" in settings and settings["provider"] != provider:
        raise CloudError("Cloud configuration provider does not match the requested provider.")
    try:
        encoded = json.dumps(settings, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise CloudError(f"{PROVIDER_NAMES[provider]} settings are not valid JSON data.") from exc
    _setting(_settings_key(provider), encoded)
    return load_provider_settings(provider)


def select_provider(provider):
    provider = _checked_provider(provider)
    _setting("cloud_provider", provider)
    return {"ok": True, "provider": provider, "providerName": PROVIDER_NAMES[provider]}


def provider_selection():
    saved = _setting("cloud_provider")
    selected = AZURE_PROVIDER if saved is None else saved
    result = {"providers": [{"id": key, "name": name} for key, name in PROVIDER_NAMES.items()],
              "activeProvider": selected if selected in PROVIDER_NAMES else None}
    if result["activeProvider"] is None:
        result["issue"] = (
            "The saved cloud provider is no longer supported. Choose Azure, Google Cloud, "
            "or AWS. Saved settings and existing resources have not been changed.")
    return result


def provider_target(provider=None):
    """Capture the allowlisted, nonsecret resource selectors for a queued job."""
    provider = resolve_provider(provider)
    settings = load_provider_settings(provider)
    snapshot = {}
    list_fields = {"subnetIds", "securityGroupIds"}
    for key in TARGET_FIELDS[provider]:
        if key not in settings:
            continue
        value = settings[key]
        if key in list_fields:
            valid = isinstance(value, list) and all(isinstance(item, str) for item in value)
        else:
            valid = isinstance(value, str)
        if not valid:
            raise CloudError(f"Saved {PROVIDER_NAMES[provider]} target field {key} is invalid.")
        snapshot[key] = value
    if provider == AZURE_PROVIDER:
        image = _setting("cloud_job_created")
        if image:
            snapshot["image"] = image
        resources = _setting("cloud_job_resources")
        if resources:
            try:
                parsed_resources = json.loads(resources)
            except (TypeError, ValueError) as exc:
                raise CloudError("Saved Azure job resource settings are invalid.") from exc
            if not isinstance(parsed_resources, dict):
                raise CloudError("Saved Azure job resource settings must be an object.")
            if (set(parsed_resources) - {"cpu", "memory"}
                    or type(parsed_resources.get("cpu")) is not int
                    or not isinstance(parsed_resources.get("memory"), str)):
                raise CloudError("Saved Azure job resource settings are invalid.")
            snapshot["jobResources"] = parsed_resources
    return {"version": 1, "provider": provider, "settings": snapshot}


def _checked_target(target, provider):
    if target is None:
        return None
    if (not isinstance(target, dict) or target.get("version") != 1
            or target.get("provider") != provider or not isinstance(target.get("settings"), dict)):
        raise CloudError("Queued Cloud resource target is invalid or has a mismatched provider.")
    allowed = set(TARGET_FIELDS[provider]) | ({"jobResources"} if provider == AZURE_PROVIDER else set())
    if any(key not in allowed for key in target["settings"]):
        raise CloudError("Queued Cloud resource target contains unsupported fields.")
    if _contains_secret_field(target["settings"]):
        raise CloudError("Queued Cloud resource target contains credentials or invalid secret references.")
    for key, value in target["settings"].items():
        if key in ("subnetIds", "securityGroupIds"):
            if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
                raise CloudError("Queued Cloud resource target contains invalid resource selectors.")
        elif key == "jobResources" and provider == AZURE_PROVIDER:
            if (not isinstance(value, dict) or set(value) - {"cpu", "memory"}
                    or type(value.get("cpu")) is not int
                    or not isinstance(value.get("memory"), str)):
                raise CloudError("Queued Azure resource target contains invalid job resources.")
        elif not isinstance(value, str):
            raise CloudError("Queued Cloud resource target contains invalid resource selectors.")
    return target


def validate_provider_target(target, provider):
    return _checked_target(target, _checked_provider(provider))


def validate_remote_job(remote_job, provider):
    provider = _checked_provider(provider)
    if (not isinstance(remote_job, dict)
            or set(remote_job) != {"provider", "id", "prefix"}
            or remote_job["provider"] != provider
            or not isinstance(remote_job["id"], str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}", remote_job["id"])
            or not isinstance(remote_job["prefix"], str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,511}", remote_job["prefix"])):
        raise CloudError("Cloud job identifiers are invalid or have a mismatched provider.")
    return dict(remote_job)


def _implementation(provider=None):
    selected = resolve_provider(provider)
    module_path = PROVIDER_MODULES[selected]
    try:
        return importlib.import_module(module_path)
    except ModuleNotFoundError as exc:
        if exc.name == module_path:
            raise CloudError(f"{PROVIDER_NAMES[selected]} provider wiring is not installed yet.") from exc
        raise


def dispatch(operation, *args, provider=None, **kwargs):
    if operation not in OPERATIONS:
        raise CloudError(f"Unknown Cloud operation {operation!r}.")
    selected = resolve_provider(provider)
    implementation = _implementation(selected)
    function = getattr(implementation, operation, None)
    if not callable(function):
        raise CloudError(f"Cloud provider {PROVIDER_NAMES[selected]} "
                         f"does not support {operation}.")
    return function(*args, **kwargs)


def _provider_result(result, provider):
    if not isinstance(result, dict) or result.get("provider", provider) != provider:
        raise CloudError("Cloud provider returned a response with a mismatched provider ID.")
    config = result.get("config")
    if isinstance(config, dict) and _contains_secret_field(config):
        raise CloudError("Cloud provider returned credentials in its settings response.")
    if isinstance(config, dict) and config.get("provider", provider) != provider:
        raise CloudError("Cloud provider returned configuration with a mismatched provider ID.")
    return {**result, "provider": provider, "providerName": PROVIDER_NAMES[provider],
            **({"config": {**config, "provider": provider}} if isinstance(config, dict) else {})}


def status(*, check_connection=True, provider=None, target=None):
    selected = resolve_provider(provider)
    target = _checked_target(target, selected)
    options = {"check_connection": check_connection}
    if target is not None:
        options["target"] = deepcopy(target)
    return _provider_result(dispatch("status", provider=selected, **options), selected)


def panel_status(request_id=None, *, provider=None):
    selected = resolve_provider(provider)
    return _provider_result(dispatch("panel_status", request_id, provider=selected), selected)


def cancel_panel_status(request_id, *, provider=None):
    return dispatch("cancel_panel_status", request_id, provider=provider)


def readiness_progress(request_id, *, provider=None):
    return dispatch("readiness_progress", request_id, provider=provider)


def setup_progress(*, provider=None):
    return dispatch("setup_progress", provider=provider)


def track_setup(operation, total, *, provider=None):
    return dispatch("track_setup", operation, total, provider=provider)


def cancel_setup(*, provider=None):
    return dispatch("cancel_setup", provider=provider)


def list_subscriptions(*, provider=None, profile=None, region=None):
    selected = resolve_provider(provider)
    options = {key: value for key, value in (("profile", profile), ("region", region))
               if value is not None}
    if options and selected != "aws":
        raise CloudError("Credential profile and region discovery are only supported for AWS.")
    return dispatch("list_subscriptions", provider=selected, **options)


def configure(config, *, provider=None):
    if not isinstance(config, dict):
        raise CloudError("Choose a Cloud provider and configure its settings.")
    if provider is not None and "provider" in config and config["provider"] != provider:
        raise CloudError("Cloud configuration provider does not match the requested provider.")
    if provider is None and "provider" in config and config["provider"] is None:
        raise CloudError("Cloud provider must be specified.")
    explicit = config["provider"] if provider is None and "provider" in config else provider
    selected = resolve_provider(explicit)
    result = dispatch("configure", config, provider=selected)
    _setting("cloud_provider", selected)
    return _provider_result(result, selected)


def prepare(config, consent=False, *, provider=None):
    if provider is not None and isinstance(config, dict) and "provider" in config \
            and config["provider"] != provider:
        raise CloudError("Cloud configuration provider does not match the requested provider.")
    if provider is None and isinstance(config, dict) and "provider" in config \
            and config["provider"] is None:
        raise CloudError("Cloud provider must be specified.")
    explicit = config["provider"] if provider is None and isinstance(config, dict) \
        and "provider" in config else provider
    selected = resolve_provider(explicit)
    return _provider_result(dispatch("prepare", config, consent, provider=selected), selected)


def enable_log_analytics(consent=False, *, provider=None):
    selected = resolve_provider(provider)
    return _provider_result(dispatch("enable_log_analytics", consent, provider=selected), selected)


def import_cloud_image(source_image, *, provider=None):
    selected = resolve_provider(provider)
    return _provider_result(dispatch("import_cloud_image", source_image, provider=selected), selected)


def build_cloud_image(*, provider=None):
    selected = resolve_provider(provider)
    return _provider_result(dispatch("build_cloud_image", provider=selected), selected)


def finish(image, hf_token=None, *, hf_token_provider=None, provider=None,
           update_existing_job=False, job_update_confirmation=None):
    selected = resolve_provider(provider)
    if type(update_existing_job) is not bool:
        raise CloudError("Review and confirm the existing GPU Job update before applying it.")
    if not update_existing_job and job_update_confirmation is not None:
        raise CloudError("Check the existing GPU Job before using its update confirmation.")
    if update_existing_job:
        if selected != "azure":
            raise CloudError("Only an Azure GPU Job can use the reviewed existing-Job update.")
        return _provider_result(dispatch(
            "finish", image, hf_token, hf_token_provider=hf_token_provider,
            update_existing_job=True, job_update_confirmation=job_update_confirmation,
            provider=selected), selected)
    return _provider_result(dispatch("finish", image, hf_token,
                                     hf_token_provider=hf_token_provider,
                                     provider=selected), selected)


def set_mode(mode, *, provider=None):
    if mode == "local":
        _setting("processing_mode", "local")
        return {"ok": True, "mode": "local"}
    if mode != "cloud":
        raise CloudError("Choose local or cloud processing.")
    selected = resolve_provider(provider)
    result = _provider_result(dispatch("set_mode", mode, provider=selected), selected)
    _setting("cloud_provider", selected)
    return result


def clear(provider=None):
    selected = resolve_provider(provider)
    _setting("processing_mode", "local")
    with closing(_connection()) as db, db:
        if selected == AZURE_PROVIDER:
            db.execute("DELETE FROM settings WHERE key IN "
                       "('cloud_config', 'cloud_prepared', 'cloud_job_created', "
                       "'cloud_job_resources', 'cloud_environment_ready', 'cloud_log_analytics_workspace', "
                       "'cloud_reuse', 'cloud_built_image', 'cloud_build_run', 'cloud_imported_digest', "
                       "'cloud_runtime_verified')")
        else:
            db.execute("DELETE FROM settings WHERE key = ?", (_settings_key(selected),))
        db.execute("DELETE FROM settings WHERE key = 'cloud_provider' AND value = ?", (selected,))
    if selected == AZURE_PROVIDER:
        return status(provider=selected)
    return {"ok": True, "provider": selected, "providerName": PROVIDER_NAMES[selected],
            "mode": "local", "configured": False}


def selected():
    return _setting("processing_mode") == "cloud"


def selected_provider():
    return resolve_provider() if selected() else None


def require_model(model, *, provider=None):
    return dispatch("require_model", model, provider=provider)


def offload(recording, directory, model, cancelled, report, *, provider=None, target=None):
    selected = resolve_provider(provider)
    target = _checked_target(target, selected)
    options = {"provider": selected}
    if target is not None:
        options["target"] = deepcopy(target)
    return dispatch("offload", recording, directory, model, cancelled, report, **options)


def cleanup(names, *, provider=None, target=None):
    selected = resolve_provider(provider)
    target = _checked_target(target, selected)
    options = {"provider": selected}
    if target is not None:
        options["target"] = deepcopy(target)
    return dispatch("cleanup", names, **options)
