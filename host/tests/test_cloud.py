import base64
import copy
import json
import logging
import socket
import ssl
import threading
import time
import urllib.error
from io import BytesIO
from types import SimpleNamespace

import pytest

from mizan import cloud, cloud_auth, logging_setup
from mizan.api import Api
from mizan.jobs import JobRunner, JobStore

CONFIG = {
    "tenantId": "11111111-1111-1111-1111-111111111111",
    "subscriptionId": "33333333-3333-3333-3333-333333333333",
    "resourceGroup": "rg-mizan", "storageAccount": "mizanblob",
    "container": "jobs", "jobName": "mizan-gpu-transcribe",
}
SETUP = {**CONFIG, "location": "swedencentral", "registry": "mizanregistry",
         "vnet": "mizan-vnet", "subnet": "aca-subnet",
         "environment": "mizan-aca-env", "identity": "mizan-job-identity"}
SUBSCRIPTIONS = [{"subscriptionId": CONFIG["subscriptionId"], "tenantId": CONFIG["tenantId"],
                  "displayName": "My Azure", "state": "Enabled"}]


@pytest.fixture
def signed_in(monkeypatch):
    enable_log_analytics = cloud._enable_log_analytics
    monkeypatch.setattr(cloud, "_enable_log_analytics", lambda *args, **kwargs: {})
    monkeypatch.setattr(cloud, "list_subscriptions", lambda: SUBSCRIPTIONS)
    subject = {"tid": CONFIG["tenantId"], "oid": "dddddddd-dddd-dddd-dddd-dddddddddddd",
               "scp": "user_impersonation", "exp": 2147483647}
    access = f"header.{base64.urlsafe_b64encode(json.dumps(subject).encode()).decode().rstrip('=')}.sig"
    monkeypatch.setattr(cloud, "token", lambda scope, tenant=None, expected_oid=None: access)
    cloud.clear()
    yield enable_log_analytics
    cloud.clear()


def test_subscription_bridge_lists_signed_in_user_and_handles_failure(monkeypatch):
    runner = JobRunner(JobStore(), pipeline=lambda *args: {})
    try:
        monkeypatch.setattr(cloud, "list_subscriptions", lambda: SUBSCRIPTIONS)
        assert Api(runner).list_cloud_subscriptions() == {
            "ok": True, "subscriptions": SUBSCRIPTIONS}
        assert Api(runner).azure_subscriptions() == {
            "ok": True, "subscriptions": [{"id": CONFIG["subscriptionId"],
                                           "name": "My Azure", "tenantId": CONFIG["tenantId"]}]}
        monkeypatch.setattr(cloud, "list_subscriptions",
                            lambda: (_ for _ in ()).throw(cloud.CloudError("Sign in to Azure.")))
        error = Api(runner).azure_subscriptions()["error"]
        assert error["code"] == "cloud_failed" and error["message"] == "Sign in to Azure."
        assert error["fix"]
    finally:
        runner.close()


def test_log_analytics_api_forwards_explicit_consent(monkeypatch):
    calls = []
    monkeypatch.setattr(cloud, "enable_log_analytics",
                        lambda consent: calls.append(consent) or {
                            "ok": True, "workspaceId": "/workspace", "location": "italynorth"})
    runner = JobRunner(JobStore(), pipeline=lambda *args: {})
    try:
        result = Api(runner).enable_cloud_logging(True)
    finally:
        runner.close()
    assert calls == [True]
    assert result == {"ok": True, "workspaceId": "/workspace", "location": "italynorth"}


def test_progress_bridge_can_be_polled_while_discovery_blocks(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    results = []
    def discover():
        cloud._progress_step("subscriptions", 1, "Loading Azure subscriptions.")
        entered.set()
        assert release.wait(5)
        return SUBSCRIPTIONS
    monkeypatch.setattr(cloud, "list_subscriptions", discover)
    runner = JobRunner(JobStore(), pipeline=lambda *args: {})
    api = Api(runner)
    worker = threading.Thread(target=lambda: results.append(api.azure_subscriptions()))
    try:
        worker.start()
        assert entered.wait(5)
        assert api.cloud_setup_progress() == {
            "ok": True, "operation": "subscriptions", "stage": "subscriptions",
            "completed": 1, "total": 2, "detail": "Loading Azure subscriptions."}
        cloud._progress_step("job", 2, "Unrelated concurrent caller.")
        assert api.cloud_setup_progress()["stage"] == "subscriptions"
        assert "already in progress" in api.azure_subscriptions()["error"]["message"]
    finally:
        release.set()
        worker.join(5)
        runner.close()
    assert results[0]["ok"]
    assert api.cloud_setup_progress() == {
        "ok": True, "operation": "subscriptions", "stage": "completed",
        "completed": 2, "total": 2, "detail": None}


def test_progress_failure_is_terminal_and_does_not_echo_secret(monkeypatch):
    secret = "hf_" + "private" * 8
    from mizan import hf_credentials
    monkeypatch.setattr(hf_credentials, "get_hf_token", lambda: secret)
    def fail():
        cloud._progress_step("job", 2, "Creating the GPU Job and binding its one-time secret.")
        raise cloud.CloudError("Job secret could not be installed; check Azure permissions.")
    monkeypatch.setattr(
        cloud, "finish",
        lambda image, hf_token=None, *, hf_token_provider=None: fail())
    runner = JobRunner(JobStore(), pipeline=lambda *args: {})
    try:
        result = Api(runner).finish_cloud("pinned-image", True)
        progress = Api(runner).cloud_setup_progress()
        assert result["ok"] is False
        assert progress["operation"] == "job" and progress["stage"] == "failed"
        assert progress["completed"] == 2 and progress["total"] == 4
        assert "job" in progress["detail"].lower()
        assert secret not in str(progress) + str(result)
    finally:
        runner.close()


def test_build_cloud_worker_bridge_returns_only_pinned_image_and_digest(monkeypatch):
    digest = "sha256:" + "1" * 64
    image = "mizanregistry.azurecr.io/mizan-aca-gpu@" + digest
    monkeypatch.setattr(cloud, "build_cloud_image",
                        lambda: {"ok": True, "image": image, "digest": digest,
                                 "sourceHash": "internal", "runId": "run-123"})
    runner = JobRunner(JobStore(), pipeline=lambda *args: {})
    try:
        assert Api(runner).build_cloud_worker() == {
            "ok": True, "image": image, "digest": digest}
    finally:
        runner.close()


def test_subscription_pages_reject_unsafe_url_and_unavailable_signin(monkeypatch):
    class Response(BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *_):
            self.close()

    class Opener:
        def open(self, request, timeout):
            assert request.headers["Authorization"] == "Bearer user-token"
            return Response(json.dumps({"value": SUBSCRIPTIONS,
                                        "nextLink": "https://evil.example/collect"}).encode())

    monkeypatch.setattr(cloud, "token", lambda scope: "user-token")
    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    with pytest.raises(cloud.CloudError, match="unsafe subscription page"):
        cloud.list_subscriptions()
    monkeypatch.setattr(cloud, "token",
                        lambda scope: (_ for _ in ()).throw(cloud_auth.AzureSignInError("Sign in.")))
    with pytest.raises(cloud.CloudError, match="Sign in"):
        cloud.list_subscriptions()


def test_credential_accepts_default_chain_but_excludes_interactive_providers(monkeypatch):
    import sys
    from types import SimpleNamespace
    options = {}
    class Credential:
        def __init__(self, **kwargs):
            options.update(kwargs)

        def get_token(self, scope, **kwargs):
            assert scope == cloud_auth.ARM_SCOPE
            assert kwargs.get("tenant_id")
            claims = {"tid": CONFIG["tenantId"], "oid": "dddddddd-dddd-dddd-dddd-dddddddddddd",
                      "scp": "user_impersonation"}
            payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
            return SimpleNamespace(token=f"header.{payload}.signature")

    monkeypatch.setitem(sys.modules, "azure", SimpleNamespace(identity=SimpleNamespace(
        DefaultAzureCredential=Credential)))
    monkeypatch.setitem(sys.modules, "azure.identity", SimpleNamespace(DefaultAzureCredential=Credential))
    monkeypatch.setattr(cloud_auth, "_credential", None)
    assert cloud_auth.token(cloud_auth.ARM_SCOPE, CONFIG["tenantId"]).startswith("header.")
    with pytest.raises(cloud_auth.AzureSignInError, match="changed since Cloud setup"):
        cloud_auth.token(cloud_auth.ARM_SCOPE, CONFIG["tenantId"],
                         "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee")
    with pytest.raises(cloud_auth.AzureSignInError, match="selected subscription tenant"):
        cloud_auth.token(cloud_auth.ARM_SCOPE, "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee")
    assert all(options[f"exclude_{source}_credential"] for source in (
        "interactive_browser", "visual_studio_code"))
    assert options["process_timeout"] == 30
    assert "exclude_environment_credential" not in options
    app = {"tid": CONFIG["tenantId"], "oid": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
           "idtyp": "app"}
    access = f"header.{base64.urlsafe_b64encode(json.dumps(app).encode()).decode().rstrip('=')}.sig"
    assert cloud_auth.claims(access)["idtyp"] == "app"
    with pytest.raises(cloud_auth.AzureSignInError, match="signed-in identity"):
        cloud_auth.claims("not-a-jwt")
    monkeypatch.setattr(cloud_auth, "_credential", None)


def test_credential_failure_does_not_claim_user_is_signed_out(monkeypatch):
    class SlowCredential:
        def get_token(self, scope, **kwargs):
            raise TimeoutError("Private Azure provider details")

    monkeypatch.setattr(cloud_auth, "_credential", SlowCredential())
    with pytest.raises(cloud_auth.AzureSignInError, match="Azure token request failed") as failure:
        cloud_auth.token(cloud_auth.ARM_SCOPE)
    assert "Private Azure provider details" not in str(failure.value)
    monkeypatch.setattr(cloud_auth, "_credential", None)


def test_azure_cli_token_reused_until_expiry_without_skipping_identity_check(monkeypatch):
    tenant = CONFIG["tenantId"]
    oid = "dddddddd-dddd-dddd-dddd-dddddddddddd"
    payload = {"tid": tenant, "oid": oid, "scp": "user_impersonation",
               "exp": int(time.time()) + 3600}
    access = f"header.{base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=')}.sig"

    class Credential:
        calls = 0
        def get_token(self, scope, **kwargs):
            self.calls += 1
            assert scope == cloud_auth.ARM_SCOPE and kwargs["tenant_id"] == tenant
            return SimpleNamespace(token=access)

    credential = Credential()
    monkeypatch.setattr(cloud_auth, "_credential", credential)
    monkeypatch.setattr(cloud_auth, "_tokens", {})
    assert cloud_auth.token(cloud_auth.ARM_SCOPE, tenant, oid) == access
    assert cloud_auth.token(cloud_auth.ARM_SCOPE, tenant, oid) == access
    assert credential.calls == 1
    with pytest.raises(cloud_auth.AzureSignInError, match="credentials changed"):
        cloud_auth.token(cloud_auth.ARM_SCOPE, tenant, "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee")
    assert credential.calls == 1
    cloud_auth._tokens[(cloud_auth.ARM_SCOPE, tenant)] = (access, 0)
    assert cloud_auth.token(cloud_auth.ARM_SCOPE, tenant, oid) == access
    assert credential.calls == 2


def test_configure_rejects_sp_secrets_and_foreign_subscriptions(signed_in):
    with pytest.raises(cloud.CloudError, match="Do not enter application credentials"):
        cloud.configure({**SETUP, "clientSecret": "private-secret"})
    with pytest.raises(cloud.CloudError, match="different Azure tenant"):
        cloud.configure({**SETUP, "tenantId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"})
    with pytest.raises(cloud.CloudError, match="enabled subscription"):
        cloud.configure({**SETUP, "subscriptionId": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"})
    assert "config" not in cloud.status()
    saved = cloud.configure({key: value for key, value in SETUP.items() if key != "tenantId"})
    assert saved["config"] == {
        **SETUP, "subnetResourceId": "", "vnetCidr": "10.42.0.0/16", "subnetCidr": "10.42.0.0/23"}
    assert not saved["prepared"] and not saved["configured"]
    assert "private-secret" not in cloud._setting("cloud_config")
    assert "userObjectId" in cloud._setting("cloud_config")
    assert "userObjectId" not in saved["config"]
    with pytest.raises(cloud.CloudError, match="not complete"):
        cloud.set_mode("cloud")


def test_prepare_requires_explicit_consent_and_creates_rg_roles(signed_in, monkeypatch):
    cloud.configure(SETUP)
    calls = []
    logging_calls = []
    monkeypatch.setattr(cloud, "_enable_log_analytics",
                        lambda azure, values, *, require_prepared:
                        logging_calls.append((values, require_prepared)))
    environment_reads = []
    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"

        def __init__(self, config):
            assert {key: config[key] for key in SETUP} == SETUP

        def _auth(self):
            return "user-token"

        def request(self, path, version, method="GET", body=None):
            calls.append((method, path, body))
            if path == self.base and method == "GET":
                return None
            if "/managedEnvironments/" in path:
                environment_reads.append(path)
                return {"location": "swedencentral", "properties": {
                    "provisioningState": "InProgress" if len(environment_reads) == 1 else "Succeeded",
                    "vnetConfiguration": None,
                    "workloadProfiles": [{"name": cloud.GPU_PROFILE,
                                          "workloadProfileType": cloud.GPU_TYPE}]}}
            return {"location": "swedencentral"}

        def create(self, path, version, body, *, reuse=False):
            calls.append(("CREATE", path, body, cloud.setup_progress()))
            if "userAssignedIdentities" in path:
                return {"properties": {"principalId": "principal", "clientId": "identity-client"}}
            return {"location": "swedencentral", "properties": {"policy": {"rules": []}}}

    monkeypatch.setattr(cloud, "_Azure", Azure)
    monkeypatch.setattr(cloud, "_grant_roles", lambda *args: calls.append(("ROLES", "", None)))
    monkeypatch.setattr(cloud.time, "sleep", lambda seconds: None)
    with pytest.raises(cloud.CloudError, match="approve"):
        cloud.prepare(SETUP)
    assert not calls
    with cloud.track_setup("provision", 10):
        result = cloud.prepare(SETUP, True)
    assert calls[1][0:2] == ("CREATE", Azure.base)
    assert calls[-1][0] == "ROLES"
    assert logging_calls == [(cloud._setup(json.loads(cloud._setting("cloud_config"))), False)]
    assert len(environment_reads) == 2
    assert [(item[3]["stage"], item[3]["completed"]) for item in calls if item[0] == "CREATE"] == [
        ("resource_group", 0), ("storage", 1), ("container", 2), ("registry", 3),
        ("identity", 4), ("network", 5), ("subnet", 6), ("environment", 7), ("lifecycle", 8)]
    assert cloud.setup_progress()["stage"] == "completed"
    assert cloud.setup_progress()["completed"] == 10
    assert result["prepared"] and not result["configured"]
    assert not cloud.status()["configured"]

def test_prepare_uses_azure_managed_network_without_creating_vnet(signed_in, monkeypatch):
    managed = {key: value for key, value in SETUP.items() if key not in ("vnet", "subnet")}
    saved = cloud.configure(managed)
    assert saved["config"]["vnet"] == saved["config"]["subnet"] == ""
    with pytest.raises(ValueError, match="both a virtual network and delegated subnet"):
        cloud._setup({**managed, "vnet": "mizan-vnet"})
    creations = []

    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"

        def __init__(self, config):
            assert config["vnet"] == config["subnet"] == ""

        def _auth(self):
            return "user-token"

        def request(self, path, version, method="GET", body=None):
            if "/managedEnvironments/" in path:
                return {"properties": {"provisioningState": "Succeeded"}}
            return {"location": "swedencentral"}

        def create(self, path, version, body, *, reuse=False):
            creations.append((path, body))
            if "userAssignedIdentities" in path:
                return {"properties": {"principalId": "principal", "clientId": "client"}}
            return {"location": "swedencentral", "properties": {}}

    monkeypatch.setattr(cloud, "_Azure", Azure)
    monkeypatch.setattr(cloud, "_grant_roles", lambda *args: None)
    with cloud.track_setup("provision", 10):
        cloud.prepare(managed, True)
    assert not any("/virtualNetworks/" in path or "/providers/Microsoft.Network/" in path
                   for path, _ in creations)
    environment = next(body for path, body in creations if "/managedEnvironments/" in path)
    assert "vnetConfiguration" not in environment["properties"]
    assert environment["properties"]["workloadProfiles"] == [{
        "name": cloud.GPU_PROFILE, "workloadProfileType": cloud.GPU_TYPE}]
    assert cloud.setup_progress()["completed"] == 10


def test_custom_network_defaults_are_editable_and_validated(signed_in, monkeypatch):
    custom = {**SETUP, "vnet": "my-network", "subnet": "my-aca",
              "vnetCidr": "172.18.0.0/16", "subnetCidr": "172.18.4.0/23"}
    with pytest.raises(ValueError, match="private IPv4"):
        cloud._setup({**custom, "vnetCidr": "8.8.0.0/16", "subnetCidr": "8.8.4.0/23"})
    with pytest.raises(ValueError, match="within"):
        cloud._setup({**custom, "subnetCidr": "172.19.4.0/23"})
    with pytest.raises(ValueError, match="/27"):
        cloud._setup({**custom, "subnetCidr": "172.18.4.0/28"})
    cloud.configure(custom)
    bodies = {}

    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"
        def __init__(self, config):
            pass
        def _auth(self):
            return "token"
        def request(self, path, version, method="GET", body=None):
            if "/managedEnvironments/" in path:
                return {"properties": {"provisioningState": "Succeeded"}}
            return {"location": "swedencentral"} if path == self.base else None
        def create(self, path, version, body, *, reuse=False):
            bodies[path] = body
            if "userAssignedIdentities" in path:
                return {"properties": {"principalId": "principal", "clientId": "client"}}
            return {"location": "swedencentral", "properties": {"delegations": [
                {"properties": {"serviceName": "Microsoft.App/environments"}}]}}

    monkeypatch.setattr(cloud, "_Azure", Azure)
    monkeypatch.setattr(cloud, "_grant_roles", lambda *args: None)
    assert cloud.prepare(custom, True)["prepared"]
    network = next(body for path, body in bodies.items() if "/virtualNetworks/" in path and "/subnets/" not in path)
    subnet = next(body for path, body in bodies.items() if "/virtualNetworks/" in path and "/subnets/" in path)
    assert network["properties"]["addressSpace"]["addressPrefixes"] == ["172.18.0.0/16"]
    assert subnet["properties"]["addressPrefix"] == "172.18.4.0/23"


def test_partial_retry_checks_existing_before_writing_and_keeps_new_job_mode(signed_in, monkeypatch):
    subnet = (f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/shared-network"
              "/providers/Microsoft.Network/virtualNetworks/approved/subnets/aca")
    values = {**SETUP, "vnet": "", "subnet": "", "subnetResourceId": subnet}
    cloud.configure(values)
    calls = []
    resources = {
        f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan":
            {"location": "swedencentral"},
        subnet: {"properties": {"delegations": [{"properties": {
            "serviceName": "Microsoft.App/environments"}}]}},
    }
    base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan/providers"
    resources[f"{base}/Microsoft.Storage/storageAccounts/mizanblob"] = {
        "location": "swedencentral", "kind": "StorageV2", "sku": {"name": "Standard_LRS"}, "properties": {
            "allowBlobPublicAccess": False, "supportsHttpsTrafficOnly": True,
            "minimumTlsVersion": "TLS1_2"}}
    resources[f"{base}/Microsoft.ContainerRegistry/registries/mizanregistry"] = {
        "location": "swedencentral", "sku": {"name": "Basic"},
        "properties": {"adminUserEnabled": False}}
    resources[f"{base}/Microsoft.ManagedIdentity/userAssignedIdentities/mizan-job-identity"] = {
        "location": "swedencentral", "properties": {
            "principalId": "principal", "clientId": "client"}}

    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"
        def __init__(self, config):
            pass
        def _auth(self):
            return "token"
        def request(self, path, version, method="GET", body=None):
            calls.append((method, path))
            if method == "PUT":
                resources[path] = body
                if "/managedEnvironments/" in path:
                    resources[path]["properties"]["provisioningState"] = "Succeeded"
            return resources.get(path)
        def create(self, path, version, body, *, reuse=False):
            assert reuse
            if path in resources:
                return resources[path]
            return self.request(path, version, "PUT", body)

    monkeypatch.setattr(cloud, "_Azure", Azure)
    monkeypatch.setattr(cloud, "_grant_roles", lambda *args: calls.append(("ROLES", "")))
    resources[f"{base}/Microsoft.ContainerRegistry/registries/mizanregistry"]["sku"]["name"] = "Premium"
    with pytest.raises(cloud.CloudError, match="Basic SKU"):
        cloud.prepare({**values, "resumePartial": True}, True)
    assert not any(method in ("PUT", "ROLES") for method, _ in calls)
    resources[f"{base}/Microsoft.ContainerRegistry/registries/mizanregistry"]["sku"]["name"] = "Basic"
    calls.clear()
    assert cloud.prepare({**values, "resumePartial": True}, True)["prepared"]
    assert not any(method == "PUT" and "/Microsoft.Network/" in path for method, path in calls)
    assert any(method == "PUT" and "/managedEnvironments/" in path for method, path in calls)
    environment = resources[f"{base}/Microsoft.App/managedEnvironments/mizan-aca-env"]
    assert environment["properties"]["vnetConfiguration"]["infrastructureSubnetId"] == subnet
    assert cloud.status()["existingPilot"] is False


def test_partial_retry_reprovisions_failed_gpu_environment_only_after_approval(signed_in, monkeypatch):
    managed = {key: value for key, value in SETUP.items() if key not in ("vnet", "subnet")}
    cloud.configure(managed)
    cloud._setting("cloud_prepared", json.dumps(managed))
    cloud._setting("cloud_built_image", json.dumps({"image": "pinned-image", "sourceHash": "hash"}))
    base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"
    environment = f"{base}/providers/Microsoft.App/managedEnvironments/mizan-aca-env"
    writes = []
    failed = {"value": True, "reject_once": True}

    class Azure:
        def __init__(self, config):
            self.base = base

        def _auth(self):
            return "user-token"

        def request(self, path, version, method="GET", body=None):
            if method == "PUT":
                assert path == environment
                writes.append(body)
                if failed["reject_once"]:
                    failed["reject_once"] = False
                    raise cloud.CloudError("Azure provisioning failed; inspect the deployment in Azure Portal.")
                failed["value"] = False
                return {"properties": {"provisioningState": "Succeeded"}}
            if path == environment:
                return {"location": "swedencentral", "properties": {
                    "provisioningState": "Failed" if failed["value"] else "Succeeded",
                    "workloadProfiles": [{"name": cloud.GPU_PROFILE,
                                          "workloadProfileType": cloud.GPU_TYPE}]}}
            if path == base:
                return {"location": "swedencentral"}
            if path.endswith("/storageAccounts/mizanblob"):
                return {"location": "swedencentral", "kind": "StorageV2",
                        "sku": {"name": "Standard_LRS"}, "properties": {
                            "allowBlobPublicAccess": False, "supportsHttpsTrafficOnly": True,
                            "minimumTlsVersion": "TLS1_2"}}
            if path.endswith("/registries/mizanregistry"):
                return {"location": "swedencentral", "sku": {"name": "Basic"},
                        "properties": {"adminUserEnabled": False}}
            if path.endswith("/userAssignedIdentities/mizan-job-identity"):
                return {"location": "swedencentral", "properties": {
                    "principalId": "principal", "clientId": "client"}}
            if path.endswith("/containers/jobs"):
                return {"properties": {"publicAccess": "None"}}
            if path.endswith("/managementPolicies/default"):
                return {"properties": {"policy": {"rules": [{"enabled": True, "definition": {
                    "filters": {"prefixMatch": ["jobs/jobs/"]},
                    "actions": {"baseBlob": {"delete": {"daysAfterModificationGreaterThan": 1}}}}}]}}}
            return None

        def create(self, path, version, body, *, reuse=False):
            assert reuse and path != environment
            return self.request(path, version)

    monkeypatch.setattr(cloud, "_Azure", Azure)
    monkeypatch.setattr(cloud, "_grant_roles", lambda *args: None)
    with pytest.raises(cloud.CloudError, match="approve"):
        cloud.prepare({**managed, "resumePartial": True})
    assert not writes
    with pytest.raises(cloud.CloudError, match="Azure provisioning failed"):
        cloud.prepare({**managed, "resumePartial": True}, True)
    assert len(writes) == 1 and not cloud.status()["prepared"]
    assert cloud._setting("cloud_built_image")
    assert cloud.prepare({**managed, "resumePartial": True}, True)["prepared"]
    assert len(writes) == 2


def test_partial_retry_reuses_succeeded_environment_without_put(signed_in, monkeypatch):
    values = SETUP
    cloud.configure(values)
    base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/{CONFIG['resourceGroup']}/providers"
    storage = f"{base}/Microsoft.Storage/storageAccounts/{CONFIG['storageAccount']}"
    container = f"{storage}/blobServices/default/containers/{CONFIG['container']}"
    policy = f"{storage}/managementPolicies/default"
    registry = f"{base}/Microsoft.ContainerRegistry/registries/{values['registry']}"
    identity = f"{base}/Microsoft.ManagedIdentity/userAssignedIdentities/{values['identity']}"
    network = f"{base}/Microsoft.Network/virtualNetworks/{values['vnet']}"
    subnet = f"{network}/subnets/{values['subnet']}"
    environment = f"{base}/Microsoft.App/managedEnvironments/{values['environment']}"
    resources = {
        f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/{CONFIG['resourceGroup']}":
            {"location": "swedencentral"},
        storage: {"location": "swedencentral", "kind": "StorageV2",
                  "sku": {"name": "Standard_LRS"}, "properties": {
                      "allowBlobPublicAccess": False, "supportsHttpsTrafficOnly": True,
                      "minimumTlsVersion": "TLS1_2"}},
        container: {"properties": {"publicAccess": "None"}},
        policy: {"properties": {"policy": {"rules": [{
            "enabled": True, "definition": {
                "filters": {"prefixMatch": ["jobs/jobs/"]},
                "actions": {"baseBlob": {"delete": {"daysAfterModificationGreaterThan": 1}}}}}]}}},
        registry: {"location": "swedencentral", "sku": {"name": "Basic"},
                   "properties": {"adminUserEnabled": False}},
        identity: {"location": "swedencentral", "properties": {
            "principalId": "principal", "clientId": "client"}},
        network: {"location": "swedencentral", "properties": {
            "addressSpace": {"addressPrefixes": ["10.42.0.0/16"]}}},
        subnet: {"properties": {"addressPrefix": "10.42.0.0/23",
                                "delegations": [{"properties": {
                                    "serviceName": "Microsoft.App/environments"}}]}},
        environment: {"location": "swedencentral", "properties": {
            "provisioningState": "Succeeded",
            "vnetConfiguration": {"infrastructureSubnetId": subnet},
            "workloadProfiles": [{"name": cloud.GPU_PROFILE,
                                  "workloadProfileType": cloud.GPU_TYPE}]}},
    }
    calls = []

    class Azure:
        def __init__(self, config):
            self.base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/{CONFIG['resourceGroup']}"

        def _auth(self):
            return "token"

        def request(self, path, version, method="GET", body=None):
            calls.append((method, path))
            return resources.get(path)

        def create(self, path, version, body, *, reuse=False):
            assert reuse
            return resources[path]

    monkeypatch.setattr(cloud, "_Azure", Azure)
    monkeypatch.setattr(cloud, "_grant_roles", lambda *args: None)

    result = cloud.prepare({**values, "resumePartial": True}, True)

    assert result["prepared"]
    assert not any(method in ("PUT", "POST") for method, _ in calls)
    assert sum(method == "GET" and path == environment for method, path in calls) >= 2
    assert cloud.status()["prepared"]


def test_existing_subnet_validation_precedes_provisioning(signed_in, monkeypatch):
    subnet = (f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/shared-network"
              "/providers/Microsoft.Network/virtualNetworks/approved/subnets/aca")
    values = {**SETUP, "vnet": "", "subnet": "", "subnetResourceId": subnet}
    cloud.configure(values)
    calls = []
    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"
        def __init__(self, config):
            pass
        def _auth(self):
            return "token"
        def request(self, path, version, method="GET", body=None):
            calls.append((method, path))
            return {"properties": {"delegations": []}} if path == subnet else None
        def create(self, path, version, body, *, reuse=False):
            pytest.fail("Invalid network must not create resources")
    monkeypatch.setattr(cloud, "_Azure", Azure)
    with pytest.raises(cloud.CloudError, match="delegated"):
        cloud.prepare(values, True)
    assert not any(method == "PUT" for method, _ in calls)
    with pytest.raises(ValueError, match="selected subscription"):
        cloud._setup({**values, "subnetResourceId": subnet.replace(CONFIG["subscriptionId"],
                                                                      CONFIG["tenantId"])})


def test_busy_custom_subnet_is_rejected_before_writes(signed_in, monkeypatch):
    subnet = (f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/network"
              "/providers/Microsoft.Network/virtualNetworks/busy/subnets/aca")
    values = {**SETUP, "vnet": "", "subnet": "", "subnetResourceId": subnet}
    cloud.configure(values)

    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"
        def __init__(self, config):
            pass
        def _auth(self):
            return "token"
        def request(self, path, version, method="GET", body=None):
            assert method == "GET"
            return {"properties": {
                "delegations": [{"properties": {"serviceName": "Microsoft.App/environments"}}],
                "serviceAssociationLinks": [{"properties": {"linkedResourceType": "Microsoft.App/environments"}}],
            }} if path == subnet else None
        def create(self, path, version, body, *, reuse=False):
            pytest.fail("Occupied subnet must not create resources")

    monkeypatch.setattr(cloud, "_Azure", Azure)
    with pytest.raises(cloud.CloudError, match="already in use"):
        cloud.prepare(values, True)


def test_reuse_managed_environment_accepts_null_network(signed_in, monkeypatch):
    managed = {key: value for key, value in SETUP.items() if key not in ("vnet", "subnet")}
    cloud.configure(managed)
    logging_calls = []
    monkeypatch.setattr(cloud, "_enable_log_analytics",
                        lambda *args, **kwargs: logging_calls.append("unexpected"))

    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"

        def __init__(self, config):
            pass

        def _auth(self):
            return "user-token"

        def request(self, path, version, method="GET", body=None):
            if "/managedEnvironments/" in path:
                return {"location": "swedencentral", "properties": {
                    "provisioningState": "Succeeded", "vnetConfiguration": None,
                    "workloadProfiles": [{"name": cloud.GPU_PROFILE,
                                          "workloadProfileType": cloud.GPU_TYPE}]}}
            return {"location": "swedencentral"}

        def create(self, path, version, body, *, reuse=False):
            assert reuse
            if "userAssignedIdentities" in path:
                return {"location": "swedencentral", "properties": {
                    "principalId": "principal", "clientId": "client"}}
            if path.endswith("/storageAccounts/mizanblob"):
                return {"location": "swedencentral", "properties": {
                    "allowBlobPublicAccess": False, "supportsHttpsTrafficOnly": True,
                    "policy": {"rules": []}}}
            if "/containers/" in path:
                return {"properties": {"publicAccess": "None"}}
            if "/registries/" in path:
                return {"location": "swedencentral", "properties": {"adminUserEnabled": False}}
            if "/managedEnvironments/" in path:
                return {"location": "swedencentral", "properties": {
                    "vnetConfiguration": None, "workloadProfiles": [
                        {"name": cloud.GPU_PROFILE, "workloadProfileType": cloud.GPU_TYPE}]}}
            return {"properties": {"policy": {"rules": [{
                "enabled": True, "definition": {"filters": {"prefixMatch": ["jobs/jobs/"]},
                "actions": {"baseBlob": {"delete": {"daysAfterModificationGreaterThan": 1}}}}}]}}}

    monkeypatch.setattr(cloud, "_Azure", Azure)
    monkeypatch.setattr(cloud, "_grant_roles", lambda *args: None)
    with cloud.track_setup("provision", 10):
        assert cloud.prepare({**managed, "existingPilot": True}, True)["prepared"]
    assert logging_calls == []


def test_role_assignment_denial_reports_action_and_does_not_mark_prepared(signed_in, monkeypatch):
    cloud.configure(SETUP)
    subject = {"tid": CONFIG["tenantId"], "oid": "dddddddd-dddd-dddd-dddd-dddddddddddd",
               "scp": "user_impersonation"}
    access = f"header.{base64.urlsafe_b64encode(json.dumps(subject).encode()).decode().rstrip('=')}.sig"
    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"

        def _auth(self):
            return access

        def _request(self, url):
            return {"value": []}

        def request(self, path, version, method="GET", body=None):
            if method == "PUT":
                raise cloud.CloudError("AuthorizationFailed")
            return None

    with pytest.raises(cloud.CloudError, match="RBAC Administrator") as denied:
        cloud._grant_roles(Azure(), SETUP, {"properties": {"principalId": "principal"}})
    assert "AuthorizationFailed" in str(denied.value)
    assert not cloud.status()["prepared"]


def test_grants_user_blob_and_managed_identity_blob_acr_roles():
    subject = {"tid": CONFIG["tenantId"], "oid": "dddddddd-dddd-dddd-dddd-dddddddddddd",
               "scp": "user_impersonation"}
    access = f"header.{base64.urlsafe_b64encode(json.dumps(subject).encode()).decode().rstrip('=')}.sig"
    grants = []
    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"

        def _auth(self):
            return access

        def _request(self, url):
            return {"value": []}

        def request(self, path, version, method="GET", body=None):
            if method == "PUT":
                grants.append((path, body["properties"]))
            return None

    cloud._grant_roles(Azure(), SETUP, {"properties": {"principalId": "managed-principal"}})
    assert len(grants) == 4
    assert {grant["principalType"] for _, grant in grants} == {"User", "ServicePrincipal"}
    assert {grant["roleDefinitionId"].rsplit("/", 1)[-1] for _, grant in grants} == {
        cloud.DATA_CONTRIBUTOR, cloud.ACR_PULL}
    assert all("/providers/Microsoft.Authorization/roleAssignments/" in path for path, _ in grants)


def test_grants_environment_identity_as_service_principal():
    subject = {"tid": CONFIG["tenantId"], "oid": "dddddddd-dddd-dddd-dddd-dddddddddddd",
               "idtyp": "app"}
    access = f"header.{base64.urlsafe_b64encode(json.dumps(subject).encode()).decode().rstrip('=')}.sig"
    grants = []
    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"

        def _auth(self):
            return access

        def _request(self, url):
            return {"value": []}

        def request(self, path, version, method="GET", body=None):
            if method == "PUT":
                grants.append(body["properties"])
            return None

    cloud._grant_roles(Azure(), SETUP, {"properties": {"principalId": "managed-principal"}})
    assert len(grants) == 4
    assert all(item["principalType"] == "ServicePrincipal" for item in grants)


def test_arm_denial_includes_provider_code_and_action(monkeypatch):
    class Opener:
        def open(self, request, timeout):
            raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, BytesIO(
                b'{"error":{"code":"AuthorizationFailed","message":"Microsoft.Authorization/roleAssignments/write denied"}}'))
    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(cloud._Azure, "_auth", lambda self: "token")
    with pytest.raises(cloud.CloudError, match="User Access Administrator"):
        cloud._Azure(SETUP).request("/subscriptions/x", "2024-03-01", "PUT", {})


def test_policy_denial_explains_network_instead_of_rbac(monkeypatch):
    class Opener:
        def open(self, request, timeout):
            raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, BytesIO(
                b'{"error":{"code":"RequestDisallowedByPolicy","message":"VNet required"}}'))
    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(cloud._Azure, "_auth", lambda self: "token")
    with pytest.raises(cloud.CloudError, match="VNet-integrated") as denied:
        cloud._Azure(SETUP).request("/subscriptions/x", "2024-03-01", "PUT", {})
    assert "User Access Administrator" not in str(denied.value)


@pytest.mark.parametrize("relative,operation_query,expected_query", [
    (False, "", "?api-version=2019-04-01"),
    (True, "", "?api-version=2019-04-01"),
    (False, "?job=build", "?job=build&api-version=2019-04-01"),
    (False, "?api-version=2023-11-01", "?api-version=2023-11-01"),
])
def test_async_acr_post_recovers_run_id_from_operation_result(
        monkeypatch, relative, operation_query, expected_query):
    operation = (f"https://management.azure.com/subscriptions/{CONFIG['subscriptionId']}"
                 "/providers/Microsoft.ContainerRegistry/locations/test/operationStatuses/build")
    seen = []

    class Response(BytesIO):
        def __init__(self, body, headers):
            super().__init__(body)
            self.headers = headers

    class Opener:
        def open(self, request, timeout):
            if request.get_method() == "POST":
                return Response(b"{}", {"Azure-AsyncOperation": (
                    (operation + operation_query).removeprefix(cloud.ARM) if relative
                    else operation + operation_query)})
            assert request.full_url == operation + expected_query
            seen.append(cloud.setup_progress())
            return Response(b'{"properties":{"status":"Succeeded","runId":"run-123"}}', {})

    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(cloud._Azure, "_auth", lambda self: "azure-token")
    monkeypatch.setattr(cloud.time, "sleep", lambda seconds: None)
    with cloud.track_setup("build", 4):
        cloud._progress_step("build", 2, "Scheduling ACR build.")
        result = cloud._Azure(SETUP).request(
            "/subscriptions/x/providers/Microsoft.ContainerRegistry/registries/mizanregistry/scheduleRun",
            "2019-04-01", "POST", {"type": "DockerBuildRequest"})
    assert seen[0]["stage"] == "build"
    assert seen[0]["detail"] == (
        "Waiting for Azure async operation for "
        "Microsoft.ContainerRegistry/registries/mizanregistry/scheduleRun to finish.")
    assert result["properties"]["runId"] == "run-123"


@pytest.mark.parametrize("method", ["PUT", "PATCH"])
def test_async_environment_update_polls_with_api_version(monkeypatch, method):
    operation = "/subscriptions/x/providers/Microsoft.App/locations/swedencentral/operationStatuses/env"
    seen = []

    class Response(BytesIO):
        def __init__(self, data, headers=None):
            super().__init__(data)
            self.headers = headers or {}

    class Opener:
        def open(self, request, timeout):
            seen.append((request.get_method(), request.full_url))
            if request.get_method() == method:
                return Response(b"{}", {"Azure-AsyncOperation": operation})
            return Response(b'{"status":"Succeeded"}')

    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(cloud._Azure, "_auth", lambda self: "azure-token")
    monkeypatch.setattr(cloud.time, "sleep", lambda seconds: None)
    cloud._Azure(SETUP).request("/subscriptions/x/providers/Microsoft.App/managedEnvironments/env",
                              "2024-03-01", method, {"location": "swedencentral"})
    assert seen == [
        (method, "https://management.azure.com/subscriptions/x/providers/Microsoft.App/"
                "managedEnvironments/env?api-version=2024-03-01"),
        ("GET", f"https://management.azure.com{operation}?api-version=2024-03-01"),
    ]


def _log_analytics_stub(execution_pages, *, existing_workspace="default", after_keys=None):
    values = cloud._setup(json.loads(cloud._setting("cloud_config")))
    workspace_path = (f"{cloud._Azure(values).base}/providers/Microsoft.OperationalInsights/"
                      f"workspaces/{cloud.LOG_ANALYTICS_WORKSPACE}")
    environment_path = (f"{cloud._Azure(values).base}/providers/Microsoft.App/"
                        f"managedEnvironments/{values['environment']}")
    job_path = f"{cloud._Azure(values).base}/providers/Microsoft.App/jobs/{values['jobName']}"
    subnet = (f"{cloud._Azure(values).base}/providers/Microsoft.Network/virtualNetworks/"
              f"{values['vnet']}/subnets/{values['subnet']}")
    customer_id = "44444444-4444-4444-4444-444444444444"
    shared_key = "test-shared-key-never-log"
    workspace = existing_workspace if existing_workspace != "default" else {
        "id": workspace_path, "location": values["location"],
        "properties": {"sku": {"name": "PerGB2018"}, "customerId": customer_id, "retentionInDays": 30,
                       "provisioningState": "Succeeded"},
    }
    env = {
        "id": environment_path, "name": values["environment"], "type": "Microsoft.App/managedEnvironments",
        "location": values["location"], "identity": {"type": "SystemAssigned"},
        "tags": {"owner": "mizan"},
        "properties": {
            "provisioningState": "Succeeded",
            "vnetConfiguration": {"infrastructureSubnetId": subnet},
            "workloadProfiles": [
                {"name": "Consumption", "workloadProfileType": "Consumption"},
                {"name": cloud.GPU_PROFILE, "workloadProfileType": cloud.GPU_TYPE},
            ],
            "appLogsConfiguration": {"destination": "console"},
        },
    }
    calls = []
    page_index = 0

    class Azure:
        base = cloud._Azure(values).base

        def _auth(self):
            calls.append(("auth",))

        def request(self, path, version, method="GET", body=None, *, redact=False,
                    redacted_error=None):
            nonlocal workspace
            calls.append(("request", method, path, body, redact, redacted_error))
            if path == self.base:
                return {"location": values["location"]}
            if path == workspace_path:
                if method == "PUT":
                    assert body == {
                        "location": values["location"],
                        "properties": {"sku": {"name": "PerGB2018"}, "retentionInDays": 30},
                    }
                    workspace = {
                        "id": workspace_path, "location": values["location"],
                        "properties": {"sku": {"name": "PerGB2018"}, "customerId": customer_id, "retentionInDays": 30,
                                       "provisioningState": "Succeeded"},
                    }
                    return {}
                return workspace
            if path == f"{workspace_path}/sharedKeys":
                assert method == "POST" and redact
                if after_keys:
                    after_keys()
                return {"primarySharedKey": shared_key}
            if path == job_path:
                return {"name": values["jobName"]}
            if path == environment_path and method == "PATCH":
                assert set(body) == {"properties"}
                assert set(body["properties"]) == {"appLogsConfiguration"}
                assert body["properties"]["appLogsConfiguration"] == {
                    "destination": "log-analytics",
                    "logAnalyticsConfiguration": {
                        "customerId": customer_id, "sharedKey": shared_key,
                    },
                }
                assert redact and "Log Analytics" in redacted_error
                env["properties"]["appLogsConfiguration"] = {
                    **body["properties"]["appLogsConfiguration"],
                    "logAnalyticsConfiguration": {"customerId": customer_id},
                }
                return {}
            if path == environment_path:
                return copy.deepcopy(env)
            pytest.fail(f"Unexpected Azure request: {method} {path}")

        def _request(self, url, *, resource_label):
            nonlocal page_index
            calls.append(("page", url))
            page = execution_pages[page_index]
            page_index += 1
            return page

    return Azure(), values, calls, shared_key, workspace_path, environment_path


def test_log_analytics_connection_pages_jobs_and_preserves_environment(signed_in):
    cloud.configure(SETUP)
    run_path = (f"{cloud.ARM}{cloud._Azure(SETUP).base}/providers/Microsoft.App/"
                f"jobs/{SETUP['jobName']}/executions")
    azure, values, calls, shared_key, workspace_path, environment_path = _log_analytics_stub([
        {"value": [{"properties": {"status": "Succeeded"}}],
         "nextLink": f"{run_path}?api-version=2024-03-01&$skiptoken=next"},
        {"value": [{"properties": {"status": "Failed"}}]},
    ], existing_workspace=None)

    result = signed_in(azure, values, require_prepared=False)

    assert result == {
        "id": workspace_path, "customerId": "44444444-4444-4444-4444-444444444444",
        "location": values["location"],
    }
    assert sum(call[0] == "page" for call in calls) == 2
    methods = [(call[1], call[2]) for call in calls if call[0] == "request"]
    assert methods.index(("POST", f"{workspace_path}/sharedKeys")) < methods.index(
        ("PATCH", environment_path))
    patch_index = methods.index(("PATCH", environment_path))
    assert methods.index(("GET", environment_path), patch_index + 1) > patch_index
    assert any(call[1] == "PUT" and call[2] == workspace_path
               for call in calls if call[0] == "request")
    stored = json.loads(cloud._setting("cloud_log_analytics_workspace"))
    assert stored == result and shared_key not in cloud._setting("cloud_log_analytics_workspace")


def test_log_analytics_refuses_active_execution_before_environment_patch(signed_in):
    cloud.configure(SETUP)
    azure, values, calls, _, _, environment_path = _log_analytics_stub([
        {"value": [{"properties": {"status": "Running"}}]},
    ])

    with pytest.raises(cloud.CloudError, match="active or has an unknown status"):
        signed_in(azure, values, require_prepared=False)
    assert not any(call[0] == "request" and call[1] == "PATCH"
                   and call[2] == environment_path for call in calls)


def test_log_analytics_does_not_mutate_incompatible_workspace(signed_in):
    cloud.configure(SETUP)
    values = cloud._setup(json.loads(cloud._setting("cloud_config")))
    workspace_path = (f"{cloud._Azure(values).base}/providers/Microsoft.OperationalInsights/"
                      f"workspaces/{cloud.LOG_ANALYTICS_WORKSPACE}")
    incompatible = {
        "id": workspace_path, "location": values["location"], "sku": {"name": "PerGB2018"},
        "properties": {"customerId": "44444444-4444-4444-4444-444444444444",
                       "retentionInDays": 90, "provisioningState": "Succeeded"},
    }
    azure, values, calls, _, _, _ = _log_analytics_stub([], existing_workspace=incompatible)

    with pytest.raises(cloud.CloudError, match="incompatible"):
        cloud._ensure_log_analytics_workspace(azure, values)
    assert not any(call[1] == "PUT" for call in calls if call[0] == "request")
    assert not any(call[1] == "POST" for call in calls if call[0] == "request")


def test_log_analytics_accepts_properties_sku_shape(signed_in):
    cloud.configure(SETUP)
    values = cloud._setup(json.loads(cloud._setting("cloud_config")))
    azure, _, calls, _, workspace_path, _ = _log_analytics_stub([])

    workspace, _ = cloud._ensure_log_analytics_workspace(azure, values)

    assert workspace["id"] == workspace_path
    assert not any(call[1] == "PUT" for call in calls if call[0] == "request")


def test_compatible_log_analytics_workspace_is_reused_without_put(signed_in):
    cloud.configure(SETUP)
    values = cloud._setup(json.loads(cloud._setting("cloud_config")))
    azure, _, calls, _, workspace_path, _ = _log_analytics_stub([])

    workspace, shared_key = cloud._ensure_log_analytics_workspace(azure, values)

    assert workspace["id"] == workspace_path
    assert shared_key == "test-shared-key-never-log"
    assert not any(call[1] == "PUT" for call in calls if call[0] == "request")


def test_log_analytics_rechecks_saved_config_after_workspace_keys(signed_in):
    cloud.configure(SETUP)
    azure, values, calls, _, _, environment_path = _log_analytics_stub(
        [{"value": []}],
        after_keys=lambda: cloud._setting("cloud_config", json.dumps({
            **json.loads(cloud._setting("cloud_config")), "resourceGroup": "other-group"})),
    )

    with pytest.raises(cloud.CloudError, match="configuration changed"):
        signed_in(azure, values, require_prepared=False)
    assert not any(call[0] == "page" for call in calls)
    assert not any(call[0] == "request" and call[1] == "PATCH"
                   and call[2] == environment_path for call in calls)


def test_prepared_log_setup_matches_saved_fields_without_identity_copy(signed_in):
    cloud.configure(SETUP)
    saved = json.loads(cloud._setting("cloud_config"))
    prepared = {key: value for key, value in saved.items() if key != "userObjectId"}
    cloud._setting("cloud_prepared", json.dumps(prepared))
    cloud._setting("cloud_environment_ready", "yes")

    cloud._require_saved_cloud_config(cloud._setup(saved), require_prepared=True)


def test_one_off_log_connection_checks_saved_job_and_returns_safe_metadata(
        signed_in, monkeypatch):
    cloud.configure(SETUP)
    saved = json.loads(cloud._setting("cloud_config"))
    cloud._setting("cloud_prepared", json.dumps(
        {key: value for key, value in saved.items() if key != "userObjectId"}))
    cloud._setting("cloud_environment_ready", "yes")
    cloud._setting("cloud_job_created", "existing-image-digest")
    azure, values, calls, shared_key, workspace_path, _ = _log_analytics_stub([
        {"value": [{"properties": {"status": "Succeeded"}}]},
    ], existing_workspace=None)
    monkeypatch.setattr(cloud, "_Azure", lambda _: azure)
    monkeypatch.setattr(cloud, "_enable_log_analytics", signed_in)

    result = cloud.enable_log_analytics(True)

    assert result == {
        "ok": True, "workspaceId": workspace_path,
        "customerId": "44444444-4444-4444-4444-444444444444",
        "location": values["location"],
    }
    assert any(call[0] == "auth" for call in calls)
    assert shared_key not in str(result)
    assert shared_key not in cloud._setting("cloud_log_analytics_workspace")


def test_log_analytics_one_off_requires_consent_and_existing_job(signed_in, monkeypatch):
    cloud.configure(SETUP)
    monkeypatch.setattr(cloud, "_Azure", lambda *_: pytest.fail("Wrong environment must fail before ARM"))
    with pytest.raises(cloud.CloudError, match="Approve Log Analytics"):
        cloud.enable_log_analytics()
    with pytest.raises(cloud.CloudError, match="GPU Job must be saved"):
        cloud.enable_log_analytics(True)


def test_redacted_patch_failure_never_exposes_shared_key(monkeypatch, caplog):
    secret = "test-shared-key-never-log"
    azure = cloud._Azure(SETUP)

    class Opener:
        def open(self, request, timeout):
            assert secret in request.data.decode()
            raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, BytesIO(
                json.dumps({"error": {"message": secret}}).encode()))

    monkeypatch.setattr(azure, "_auth", lambda: "access-token")
    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    with pytest.raises(cloud.CloudError) as failure:
        azure.request("/subscriptions/x/providers/Microsoft.App/managedEnvironments/env",
                      "2024-03-01", "PATCH", {"properties": {"sharedKey": secret}},
                      redact=True,
                      redacted_error="Azure Log Analytics settings could not be saved.")
    assert "Log Analytics" in str(failure.value)
    assert "Job secret" not in str(failure.value)
    assert secret not in str(failure.value) and secret not in caplog.text


def test_async_poll_retries_transient_get_then_checks_environment_ready(signed_in, monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    operation = "/subscriptions/x/providers/Microsoft.App/locations/italynorth/operationStatuses/env"
    env_path = "/subscriptions/x/providers/Microsoft.App/managedEnvironments/env"
    requests = []
    poll_reads = 0

    class Response(BytesIO):
        def __init__(self, data, status=200, headers=None):
            super().__init__(data)
            self.status = status
            self.headers = headers or {}

    class Opener:
        def open(self, request, timeout):
            nonlocal poll_reads
            method, url = request.get_method(), request.full_url
            requests.append((method, url, timeout))
            if method == "PUT":
                return Response(b"{}", 202, {
                    "Azure-AsyncOperation": operation, "Retry-After": "0",
                    "x-ms-request-id": "accepted-put",
                })
            if "operationStatuses" in url:
                poll_reads += 1
                if poll_reads == 1:
                    raise urllib.error.URLError(TimeoutError("timed out"))
                status = "InProgress" if poll_reads == 2 else "Succeeded"
                return Response(json.dumps({"status": status}).encode(), headers={
                    "x-ms-request-id": f"poll-{poll_reads}"})
            assert env_path in url
            return Response(json.dumps({"properties": {"provisioningState": "Succeeded"}}).encode())

    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(cloud._setup_cancelled, "wait", lambda seconds: False)
    monkeypatch.setattr(cloud.time, "sleep", lambda seconds: None)
    azure = cloud._Azure(SETUP)
    with cloud.track_setup("provision", 10):
        azure.request(env_path, "2024-03-01", "PUT", {"location": "italynorth"})
        assert cloud._environment_ready(azure, env_path, wait=True)

    assert [method for method, _, _ in requests].count("PUT") == 1
    assert poll_reads == 3
    assert "category=timeout" in caplog.text
    assert "poll=1 attempt=1" in caplog.text
    assert "origin_request_id=accepted-put" in caplog.text
    assert "Azure environment readiness" in caplog.text


def test_transient_get_retry_exhaustion_preserves_cause_and_is_bounded(signed_in, monkeypatch, caplog):
    operation = "/subscriptions/x/providers/Microsoft.App/locations/italynorth/operationStatuses/env"
    calls = []

    class Response(BytesIO):
        headers = {"Azure-AsyncOperation": operation, "x-ms-request-id": "accepted-put"}
        status = 202

    class Opener:
        def open(self, request, timeout):
            calls.append(request.get_method())
            if request.get_method() == "PUT":
                return Response(b"{}")
            raise urllib.error.URLError(ConnectionResetError(10054, "connection reset"))

    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(cloud._setup_cancelled, "wait", lambda seconds: False)
    monkeypatch.setattr(cloud.time, "sleep", lambda seconds: None)
    with pytest.raises(cloud.CloudError, match="failed after 3 attempt") as failure:
        cloud._Azure(SETUP).request(
            "/subscriptions/x/providers/Microsoft.App/managedEnvironments/env",
            "2024-03-01", "PUT", {"location": "italynorth"})

    assert calls == ["PUT", "GET", "GET", "GET"]
    assert isinstance(failure.value.__cause__, urllib.error.URLError)
    assert isinstance(failure.value.__cause__.reason, ConnectionResetError)
    assert "category=connection" in caplog.text
    assert "poll=1 attempt=3 max_attempts=3" in caplog.text
    assert "origin_request_id=accepted-put" in caplog.text


def test_transient_get_retries_stay_within_request_deadline(signed_in, monkeypatch):
    clock = [0.0]
    timeouts, waits = [], []

    class Opener:
        def open(self, request, timeout):
            timeouts.append(timeout)
            raise urllib.error.URLError(TimeoutError("timed out"))

    def wait(seconds):
        waits.append(seconds)
        clock[0] += seconds
        return False

    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(cloud.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(cloud._setup_cancelled, "wait", wait)
    with cloud.track_setup("provision", 10):
        with pytest.raises(cloud.CloudError, match="failed after 2 attempt"):
            cloud._Azure(SETUP)._request(
                "https://management.azure.com/subscriptions/x/resourceGroups/rg-mizan",
                timeout=2, resource_label="resourceGroups/rg-mizan")

    assert timeouts == [2, 1]
    assert waits == [1, 1]
    assert clock[0] == 2


def test_cancel_stops_transient_get_retry_without_replaying_write(signed_in, monkeypatch):
    calls = []

    class Response(BytesIO):
        headers = {"Azure-AsyncOperation": (
            "/subscriptions/x/providers/Microsoft.App/locations/italynorth/operations/env"),
            "Retry-After": "0"}
        status = 202

    class Opener:
        def open(self, request, timeout):
            calls.append(request.get_method())
            if request.get_method() == "PUT":
                return Response(b"{}")
            raise urllib.error.URLError(TimeoutError("timed out"))

    def cancel_during_wait(seconds):
        if seconds == 0:
            return False
        assert cloud.cancel_setup()["cancelRequested"]
        return True

    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(cloud._setup_cancelled, "wait", cancel_during_wait)
    monkeypatch.setattr(cloud.time, "sleep", lambda seconds: None)
    with cloud.track_setup("provision", 10):
        with pytest.raises(cloud.CloudError, match="stopped while waiting"):
            cloud._Azure(SETUP).request(
                "/subscriptions/x/providers/Microsoft.App/managedEnvironments/env",
                "2024-03-01", "PUT", {"location": "italynorth"})
    assert calls == ["PUT", "GET"]


@pytest.mark.parametrize("status,code", [(403, "AuthorizationFailed"),
                                           (409, "AnotherOperationInProgress"),
                                           (429, "TooManyRequests"),
                                           (503, "ServiceUnavailable")])
def test_http_status_errors_are_not_transport_retried(signed_in, monkeypatch, status, code):
    calls = []

    class Opener:
        def open(self, request, timeout):
            calls.append(request.get_method())
            raise urllib.error.HTTPError(
                request.full_url, status, "error", {"x-ms-request-id": "http-error"},
                BytesIO(json.dumps({"error": {"code": code, "message": "try later"}}).encode()))

    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    with pytest.raises(cloud.CloudError):
        cloud._Azure(SETUP).request(
            "/subscriptions/x/providers/Microsoft.App/managedEnvironments/env", "2024-03-01")
    assert calls == ["GET"]


def test_malformed_http_200_is_decode_error_and_not_retried(signed_in, monkeypatch, caplog):
    calls = []

    class Response(BytesIO):
        status = 200
        headers = {"x-ms-request-id": "bad-json"}

    class Opener:
        def open(self, request, timeout):
            calls.append(request.get_method())
            return Response(b"{")

    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    with pytest.raises(cloud.CloudError, match="invalid JSON"):
        cloud._Azure(SETUP).request(
            "/subscriptions/x/providers/Microsoft.App/managedEnvironments/env", "2024-03-01")
    assert calls == ["GET"]
    assert "response decode failed" in caplog.text
    assert "transport failure" not in caplog.text


@pytest.mark.parametrize(("reason", "category", "attempts"), [
    (socket.gaierror(socket.EAI_AGAIN, "temporary DNS failure"), "dns_temporary", 3),
    (ConnectionResetError(10054, "connection reset"), "connection", 3),
    (TimeoutError("timed out"), "timeout", 3),
    (ssl.SSLCertVerificationError("certificate verify failed"), "tls", 1),
])
def test_transport_diagnostics_categorize_and_redact(signed_in, monkeypatch, caplog, reason, category, attempts):
    calls = []

    class Opener:
        def open(self, request, timeout):
            calls.append(request.get_method())
            raise urllib.error.URLError(reason)

    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(cloud.time, "sleep", lambda seconds: None)
    with pytest.raises(cloud.CloudError):
        cloud._Azure(SETUP).request(
            "/subscriptions/x/providers/Microsoft.App/managedEnvironments/env", "2024-03-01")

    assert calls == ["GET"] * attempts
    assert f"category={category}" in caplog.text


def test_transport_diagnostics_redact_reason_urls_and_credentials(signed_in, monkeypatch, caplog):
    class Opener:
        def open(self, request, timeout):
            raise urllib.error.URLError(
                "connection reset https://example.test/path?sig=private-sas "
                "access_token=private-token")

    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(cloud.time, "sleep", lambda seconds: None)
    with pytest.raises(cloud.CloudError):
        cloud._Azure(SETUP).request(
            "/subscriptions/x/providers/Microsoft.App/managedEnvironments/env", "2024-03-01")

    assert "private-sas" not in caplog.text and "private-token" not in caplog.text
    assert "https://example.test/" not in caplog.text


def test_location_operation_uses_http_completion_status(monkeypatch):
    operation = "/subscriptions/x/providers/Microsoft.App/locations/swedencentral/operations/env"
    responses = iter([(b'{"status":"Running"}', 202), (b"", 204)])
    seen = []

    class Response(BytesIO):
        def __init__(self, data, status, headers=None):
            super().__init__(data)
            self.headers = headers or {}
            self.status = status

    class Opener:
        def open(self, request, timeout):
            seen.append(request.get_method())
            if request.get_method() == "PUT":
                return Response(b"{}", 202, {"Location": operation})
            data, status = next(responses)
            return Response(data, status)

    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(cloud._Azure, "_auth", lambda self: "azure-token")
    monkeypatch.setattr(cloud.time, "sleep", lambda seconds: None)

    cloud._Azure(SETUP).request(
        "/subscriptions/x/providers/Microsoft.App/managedEnvironments/env",
        "2024-03-01", "PUT", {"location": "swedencentral"})
    assert seen == ["PUT", "GET", "GET"]


def test_arm_lro_timeout_bounds_poll_request_to_remaining_time(monkeypatch):
    operation = "/subscriptions/x/providers/Microsoft.App/locations/swedencentral/operations/timeout"
    clock = [0.0]
    sleeps = []
    requests = []

    class Response(BytesIO):
        def __init__(self, data, status, headers=None):
            super().__init__(data)
            self.status = status
            self.headers = headers or {}

    class Opener:
        def open(self, request, timeout):
            requests.append((request.get_method(), timeout))
            if request.get_method() == "PUT":
                return Response(b"{}", 202, {"Location": operation})
            assert timeout == 5
            clock[0] = cloud.ARM_OPERATION_TIMEOUT
            return Response(b'{"status":"Running"}', 202, {"x-ms-request-id": "timeout-poll"})

    def sleep(seconds):
        sleeps.append(seconds)
        clock[0] = cloud.ARM_OPERATION_TIMEOUT - 5

    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(cloud._Azure, "_auth", lambda self: "azure-token")
    monkeypatch.setattr(cloud.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(cloud.time, "sleep", sleep)
    monkeypatch.setattr(cloud, "_wait_setup", lambda seconds, resource: sleep(seconds))

    with cloud.track_setup("provision", 10):
        cloud._progress_step("environment", 7, "Provisioning environment.")
        with pytest.raises(cloud.CloudError, match="30-minute/360-poll limit"):
            cloud._Azure(SETUP).request(
                "/subscriptions/x/providers/Microsoft.App/managedEnvironments/env",
                "2024-03-01", "PUT", {"location": "swedencentral"})

    assert sleeps == [5]
    assert requests == [("PUT", 90), ("GET", 5)]


def test_arm_lro_logs_file_metadata_and_redacts_sensitive_data(tmp_path, monkeypatch):
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    monkeypatch.setattr(logging_setup, "app_dir",
                        lambda name: log_dir if name == "logs" else pytest.fail(name))
    logging_setup.configure_file_logging()
    root = logging.getLogger()
    handler = next(item for item in root.handlers if item.get_name() == "mizan-file")
    location = (f"https://management.azure.com/subscriptions/{CONFIG['subscriptionId']}"
                "/providers/Microsoft.App/locations/swedencentral/operations/poll-operation-id"
                "?api-version=2024-03-01&sig=do-not-log-this-sas")
    async_operation = (f"https://management.azure.com/subscriptions/{CONFIG['subscriptionId']}"
                       "/providers/Microsoft.App/locations/swedencentral/operationStatuses/async-id"
                       "?api-version=2024-03-01")
    polls = {"location": 0, "async": 0}
    wait_details = []
    access_token = "Bearer test-access-token-do-not-log"
    secret = "hf_secret-value-do-not-log"

    class Response(BytesIO):
        def __init__(self, data, status, headers=None):
            super().__init__(data)
            self.status = status
            self.headers = headers or {}

    class Opener:
        def open(self, request, timeout):
            url = request.full_url
            if "managedEnvironments/mizan-aca-env" in url and request.get_method() == "PUT":
                return Response(b"{}", 202, {
                    "Location": location, "Retry-After": "0", "x-ms-request-id": "loc-start",
                })
            if "poll-operation-id" in url:
                wait_details.append(cloud.setup_progress()["detail"])
                polls["location"] += 1
                if polls["location"] == 1:
                    return Response(b'{"status":"Running"}', 202, {
                        "Retry-After": "0", "x-ms-request-id": "loc-running",
                    })
                return Response(b"", 204, {"x-ms-request-id": "loc-done"})
            if "managedEnvironments/conflict-env" in url:
                raise urllib.error.HTTPError(
                    url, 409, "Conflict",
                    {"Retry-After": "9", "x-ms-request-id": "conflict-409"},
                    BytesIO(json.dumps({"error": {
                        "code": "AnotherOperationInProgress",
                        "message": f"Wait for {location} {access_token}",
                    }}).encode()),
                )
            if "managedEnvironments/failed-env" in url and request.get_method() == "PUT":
                return Response(b"{}", 202, {
                    "Azure-AsyncOperation": async_operation, "Retry-After": "0",
                    "x-ms-request-id": "async-start",
                })
            if "async-id" in url:
                polls["async"] += 1
                return Response(json.dumps({"status": "Failed", "error": {
                    "code": "QuotaExceeded", "message": "A100 capacity is unavailable.",
                }}).encode(), 200, {"x-ms-request-id": "async-failed"})
            if "managedEnvironments/secret-env" in url:
                raise urllib.error.HTTPError(
                    url, 400, "Bad Request", {"x-ms-request-id": "secret-failed"},
                    BytesIO(json.dumps({"error": {
                        "code": "InvalidSecret", "message": secret,
                    }}).encode()),
                )
            raise AssertionError(f"Unexpected mocked Azure request: {request.get_method()}")

    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(cloud._Azure, "_auth", lambda self: "azure-token")
    monkeypatch.setattr(cloud.time, "sleep", lambda seconds: None)
    azure = cloud._Azure(SETUP)
    try:
        with cloud.track_setup("provision", 10):
            cloud._progress_step("environment", 7, "Provisioning environment.")
            azure.request(
                "/subscriptions/x/providers/Microsoft.App/managedEnvironments/mizan-aca-env",
                "2024-03-01", "PUT", {"location": "swedencentral"})
            with pytest.raises(cloud.CloudError, match="resource conflict.*HTTP 409") as conflict:
                azure.request(
                    "/subscriptions/x/providers/Microsoft.App/managedEnvironments/conflict-env",
                    "2024-03-01", "PUT", {"location": "swedencentral"})
            assert "Retry after 9 seconds." in str(conflict.value)
            with pytest.raises(cloud.CloudError, match="QuotaExceeded"):
                azure.request(
                    "/subscriptions/x/providers/Microsoft.App/managedEnvironments/failed-env",
                    "2024-03-01", "PUT", {"location": "swedencentral"})
            with pytest.raises(cloud.CloudError, match="Job secret could not be installed"):
                azure.request(
                    "/subscriptions/x/providers/Microsoft.App/managedEnvironments/secret-env",
                    "2024-03-01", "PUT", {"properties": {"configuration": {
                        "secrets": [{"name": "hf-token", "value": secret}],
                    }}},
                )
    finally:
        root.removeHandler(handler)
        handler.close()

    contents = (log_dir / "mizan.log").read_text(encoding="utf-8")
    assert "File logging enabled path=" in contents
    assert "stage=environment" in contents
    assert "resource=Microsoft.App/managedEnvironments/mizan-aca-env" in contents
    assert "lro_type=Location" in contents and "lro_type=Azure-AsyncOperation" in contents
    assert "http_status=202" in contents and "http_status=204" in contents
    assert "request_id=loc-start" in contents and "request_id=loc-done" in contents
    assert "status=Succeeded" in contents and "status=Failed" in contents
    assert "retry_after_seconds=9" in contents
    assert "QuotaExceeded" in contents and "A100 capacity is unavailable." in contents
    assert "elapsed_seconds=" in contents and "poll=1" in contents
    assert "Waiting for Azure Location operation for " \
        "Microsoft.App/managedEnvironments/mizan-aca-env" in wait_details[0]
    assert "poll-operation-id" not in contents and "async-id" not in contents
    assert "do-not-log-this-sas" not in contents and "sig=" not in contents
    assert access_token not in contents and secret not in contents
    assert "https://management.azure.com/" not in contents


@pytest.mark.parametrize("state", [
    {"status": "Failed", "error": {
        "code": "QuotaExceeded", "message": "GPU quota is unavailable in this region."
    }},
    {"properties": {"status": "Failed", "error": {
        "code": "QuotaExceeded", "message": "GPU quota is unavailable in this region."
    }}},
])
def test_async_failure_surfaces_error_details(monkeypatch, state):
    operation = "/subscriptions/x/providers/Microsoft.App/locations/swedencentral/operationStatuses/env"
    calls = []

    class Response(BytesIO):
        def __init__(self, data, headers=None):
            super().__init__(data)
            self.headers = headers or {}

    class Opener:
        def open(self, request, timeout):
            calls.append(request.get_method())
            if request.get_method() == "PUT":
                return Response(b"{}", {"Azure-AsyncOperation": operation})
            return Response(json.dumps(state).encode())

    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(cloud._Azure, "_auth", lambda self: "azure-token")
    monkeypatch.setattr(cloud.time, "sleep", lambda seconds: None)

    with pytest.raises(cloud.CloudError) as failure:
        cloud._Azure(SETUP).request(
            "/subscriptions/x/providers/Microsoft.App/managedEnvironments/env",
            "2024-03-01", "PUT", {"location": "swedencentral"})
    assert str(failure.value) == (
        "Azure operation for Microsoft.App/managedEnvironments/env failed "
        "(QuotaExceeded: GPU quota is unavailable in this region.).")
    assert calls == ["PUT", "GET"]


@pytest.mark.parametrize("status", ["Failed", "Canceled"])
def test_terminal_async_states_are_not_transport_retried(signed_in, monkeypatch, status):
    calls = []
    operation = "/subscriptions/x/providers/Microsoft.App/locations/italynorth/operationStatuses/env"

    class Response(BytesIO):
        def __init__(self, data, headers=None):
            super().__init__(data)
            self.headers = headers or {}

    class Opener:
        def open(self, request, timeout):
            calls.append(request.get_method())
            if request.get_method() == "PUT":
                return Response(b"{}", {"Azure-AsyncOperation": operation})
            return Response(json.dumps({"status": status}).encode())

    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(cloud.time, "sleep", lambda seconds: None)
    with pytest.raises(cloud.CloudError, match="operation for"):
        cloud._Azure(SETUP).request(
            "/subscriptions/x/providers/Microsoft.App/managedEnvironments/env",
            "2024-03-01", "PUT", {"location": "italynorth"})
    assert calls == ["PUT", "GET"]


def test_async_sensitive_failure_does_not_surface_error_details(monkeypatch):
    operation = "/subscriptions/x/providers/Microsoft.App/locations/swedencentral/operationStatuses/env"
    secret = "hf_supersecret"

    class Response(BytesIO):
        def __init__(self, data, headers=None):
            super().__init__(data)
            self.headers = headers or {}

    class Opener:
        def open(self, request, timeout):
            if request.get_method() == "PUT":
                return Response(b"{}", {"Azure-AsyncOperation": operation})
            return Response(json.dumps({"status": "Failed", "error": {
                "code": "InvalidSecret", "message": f"Rejected {secret}"
            }}).encode())

    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(cloud._Azure, "_auth", lambda self: "azure-token")
    monkeypatch.setattr(cloud.time, "sleep", lambda seconds: None)
    body = {"properties": {"configuration": {"secrets": [
        {"name": "hf-token", "value": secret}]}}}

    with pytest.raises(cloud.CloudError) as failure:
        cloud._Azure(SETUP).request(
            "/subscriptions/x/providers/Microsoft.App/jobs/job", "2024-03-01", "PUT", body)
    assert str(failure.value) == (
        "Azure operation for Microsoft.App/jobs/job failed; inspect its deployment "
        "in Azure Portal before retrying.")
    assert secret not in str(failure.value)


@pytest.mark.parametrize("operation", [
    "//evil.example/subscriptions/x",
    "https://management.azure.com.evil.example/subscriptions/x",
    "http://management.azure.com/subscriptions/x",
    "https://management.azure.com:443/subscriptions/x",
    "https://user@management.azure.com/subscriptions/x",
])
def test_async_operation_rejects_external_or_ambiguous_urls(monkeypatch, operation):
    requests = []

    class Response(BytesIO):
        headers = {"Azure-AsyncOperation": operation}

    class Opener:
        def open(self, request, timeout):
            requests.append(request.full_url)
            return Response(b"{}")

    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(cloud._Azure, "_auth", lambda self: "azure-token")
    with pytest.raises(cloud.CloudError, match="unexpected operation URL"):
        cloud._Azure(SETUP).request("/subscriptions/x", "2024-03-01", "PUT", {})
    assert requests == ["https://management.azure.com/subscriptions/x?api-version=2024-03-01"]


def test_finish_refuses_unverified_image_before_any_azure_call(signed_in, monkeypatch):
    cloud.configure(SETUP)
    cloud._setting("cloud_prepared", json.dumps(SETUP))
    monkeypatch.setattr(cloud, "_Azure", lambda config: pytest.fail("Invalid digest accessed Azure"))
    with pytest.raises(cloud.CloudError, match="digest"):
        cloud.finish("mizanregistry.azurecr.io/mizan-aca-gpu:latest")


def test_finish_requires_one_time_token_and_never_persists_or_returns_it(signed_in, monkeypatch):
    from mizan import hf_credentials
    cloud.configure(SETUP)
    cloud._setting("cloud_prepared", json.dumps(SETUP))
    image = "mizanregistry.azurecr.io/mizan-aca-gpu@" + cloud.SUPPORTED_WORKER_DIGEST
    cloud._setting("cloud_built_image", json.dumps({
        "image": image, "sourceHash": cloud._worker_source()[1]}))
    token_value = "hf_" + "s" * 40
    creations = []
    job_progress = []

    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"

        def __init__(self, config):
            pass

        def request(self, path, version, method="GET", body=None):
            if "/Microsoft.ManagedIdentity/" in path:
                return {"properties": {"clientId": "managed-client", "principalId": "managed-principal"}}
            if "/managedEnvironments/" in path:
                return {"properties": {"provisioningState": "Succeeded"}}
            return None

        def create(self, path, version, body):
            job_progress.append(cloud.setup_progress())
            creations.append(body)
            return body

    monkeypatch.setattr(cloud, "_Azure", Azure)
    monkeypatch.setattr(cloud, "_roles_ready", lambda *args: None)
    assert cloud.finish(image)["requiresHfTokenConsent"]
    assert cloud.finish(image, "")["requiresHfTokenConsent"]
    assert not creations and not cloud.status()["jobCreated"]
    runner = JobRunner(JobStore(), pipeline=lambda *args: {})
    try:
        monkeypatch.setattr(
            hf_credentials, "get_hf_token",
            lambda: pytest.fail("A Job check without transfer consent must not read credentials"))
        no_consent = Api(runner).finish_cloud(image, False)
        assert no_consent["requiresHfTokenConsent"] and not no_consent["jobCreated"]
        monkeypatch.setattr(hf_credentials, "get_hf_token", lambda: None)
        assert "No Hugging Face token is saved" in Api(runner).finish_cloud(image, True)["error"]["message"]
        assert "Approve sending" in Api(runner).finish_cloud(image, token_value)["error"]["message"]
        assert not creations
        monkeypatch.setattr(hf_credentials, "get_hf_token", lambda: token_value)
        result = Api(runner).finish_cloud(image, True)
    finally:
        runner.close()
    assert result["jobCreated"] and not result["configured"]
    assert cloud._setting("cloud_job_created") == image
    assert cloud._setting("cloud_environment_ready") == "yes"
    assert job_progress[0]["stage"] == "job" and job_progress[0]["completed"] == 2
    assert cloud.setup_progress()["stage"] == "completed"
    assert cloud.setup_progress()["completed"] == 4
    props = creations[0]["properties"]
    assert props["configuration"]["secrets"] == [{"name": "hf-token", "value": token_value}]
    assert {"name": "HF_TOKEN", "secretRef": "hf-token"} in props["template"]["containers"][0]["env"]
    assert token_value not in str(result)
    assert token_value not in str(cloud.status())
    assert token_value not in str([cloud._setting(key) for key in (
        "cloud_config", "cloud_prepared", "cloud_job_created", "cloud_job_resources")])


@pytest.mark.parametrize("state,reason", [("Failed", "failed to provision"),
                                          ("InProgress", "not provisioned yet")])
def test_finish_checks_gpu_environment_before_job_or_token_write(signed_in, monkeypatch, state, reason):
    cloud.configure(SETUP)
    cloud._setting("cloud_prepared", json.dumps(SETUP))
    image = "mizanregistry.azurecr.io/mizan-aca-gpu@" + cloud.SUPPORTED_WORKER_DIGEST
    cloud._setting("cloud_built_image", json.dumps({
        "image": image, "sourceHash": cloud._worker_source()[1]}))
    token_value = "hf_" + "s" * 40
    assert not cloud.status()["prepared"]
    assert cloud.status()["workerImage"] == image
    assert "retry the GPU environment" in cloud.status()["issue"]
    calls = []

    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"

        def __init__(self, config):
            pass

        def request(self, path, version, method="GET", body=None):
            calls.append((method, path, body))
            if "/Microsoft.ManagedIdentity/" in path:
                return {"properties": {"clientId": "client", "principalId": "principal"}}
            if "/managedEnvironments/" in path:
                return {"properties": {"provisioningState": state}}
            pytest.fail("The Job must not be queried until the GPU environment is ready")

        def create(self, *args, **kwargs):
            pytest.fail("The token must not be sent when the GPU environment is unavailable")

    monkeypatch.setattr(cloud, "_Azure", Azure)
    monkeypatch.setattr(cloud, "_roles_ready", lambda *args: None)
    with pytest.raises(cloud.CloudError, match=reason) as failure:
        cloud.finish(image, token_value)
    assert token_value not in str(failure.value) + str(calls)
    assert not cloud.status()["prepared"]
    assert cloud._setting("cloud_built_image")
    assert not cloud._setting("cloud_job_created")


def test_existing_pilot_needs_valid_secret_binding_and_never_overwrites(signed_in, monkeypatch):
    cloud.configure(SETUP)
    cloud._setting("cloud_prepared", json.dumps(SETUP))
    image = "mizanregistry.azurecr.io/mizan-aca-gpu@" + cloud.SUPPORTED_WORKER_DIGEST
    tagged_image = "mizanregistry.azurecr.io/mizan-aca-gpu:combined-20260929-a100"
    cloud._setting("cloud_built_image", json.dumps({
        "image": image, "sourceHash": cloud._worker_source()[1]}))
    manifest_checks = []
    monkeypatch.setattr(cloud, "_registry_manifest",
                        lambda config, reference, digest: manifest_checks.append((reference, digest)))
    identity = (f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"
                "/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mizan-job-identity")
    job = {
        "identity": {"userAssignedIdentities": {identity: {}}},
        "properties": {
            "environmentId": (f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"
                              "/providers/Microsoft.App/managedEnvironments/mizan-aca-env"),
            "workloadProfileName": cloud.GPU_PROFILE,
            "configuration": {"triggerType": "Manual", "secrets": []},
            "template": {"containers": [{
                "image": tagged_image,
                "resources": {"cpu": 2, "memory": "8Gi", "ephemeralStorage": ""},
                "env": []}]},
        },
    }

    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"

        def __init__(self, config):
            pass

        def request(self, path, version, method="GET", body=None):
            if "/Microsoft.ManagedIdentity/" in path:
                return {"properties": {"clientId": "managed-client", "principalId": "managed-principal"}}
            if "/managedEnvironments/" in path:
                return {"properties": {"provisioningState": "Succeeded"}}
            return job

        def create(self, *args):
            pytest.fail("Existing pilot Job was overwritten")

    monkeypatch.setattr(cloud, "_Azure", Azure)
    monkeypatch.setattr(cloud, "_roles_ready", lambda *args: None)
    with pytest.raises(cloud.CloudError, match="pinned image"):
        cloud.finish(image, "hf_" + "s" * 40)
    assert not cloud.status()["jobCreated"]
    cloud._setting("cloud_reuse", "yes")
    with pytest.raises(cloud.CloudError, match="missing its required HF_TOKEN secret binding"):
        cloud.finish(image)
    job["properties"]["configuration"]["secrets"] = [{"name": "hf-token"}]
    job["properties"]["template"]["containers"][0]["env"] = [
        {"name": "HF_TOKEN", "secretRef": "hf-token"}]
    with pytest.raises(cloud.CloudError, match="will not transfer a token"):
        cloud.finish(image, "hf_" + "s" * 40)
    result = cloud.finish(image, "")
    assert result["jobCreated"]
    assert job["properties"]["template"]["containers"][0]["image"] == tagged_image
    assert (tagged_image.rsplit(":", 1)[-1], cloud.SUPPORTED_WORKER_DIGEST) in manifest_checks
    assert cloud._setting("cloud_job_created") == image
    assert json.loads(cloud._setting("cloud_job_resources")) == cloud.JOB_RESOURCES


@pytest.mark.parametrize("resources", cloud.EXISTING_JOB_RESOURCES)
def test_finish_adopts_matching_pinned_job_without_reuse_or_token_read(signed_in, monkeypatch, resources):
    from mizan import hf_credentials

    cloud.configure(SETUP)
    cloud._setting("cloud_prepared", json.dumps(SETUP))
    cloud._setting("cloud_reuse", "no")
    image = "mizanregistry.azurecr.io/mizan-aca-gpu@" + cloud.SUPPORTED_WORKER_DIGEST
    cloud._setting("cloud_built_image", json.dumps({
        "image": image, "sourceHash": cloud._worker_source()[1]}))
    identity = (f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"
                "/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mizan-job-identity")
    environment = (f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"
                   "/providers/Microsoft.App/managedEnvironments/mizan-aca-env")
    job = {
        "identity": {"userAssignedIdentities": {identity: {}}},
        "properties": {
            "environmentId": environment,
            "workloadProfileName": cloud.GPU_PROFILE,
            "configuration": {
                "triggerType": "Manual",
                "secrets": [{"name": "hf-token"}],
            },
            "template": {"containers": [{
                "image": image,
                "resources": {**resources, "ephemeralStorage": ""},
                "env": [{"name": "HF_TOKEN", "secretRef": "hf-token"}],
            }]},
        },
    }
    requests = []
    provider_calls = []

    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"

        def __init__(self, config):
            pass

        def request(self, path, version, method="GET", body=None):
            requests.append((method, path))
            if "/Microsoft.ManagedIdentity/" in path:
                return {"properties": {"clientId": "managed-client", "principalId": "managed-principal"}}
            if "/managedEnvironments/" in path:
                return {"properties": {"provisioningState": "Succeeded"}}
            return job

        def create(self, *args):
            pytest.fail("A matching existing GPU Job must not be overwritten")

    monkeypatch.setattr(cloud, "_Azure", Azure)
    monkeypatch.setattr(cloud, "_roles_ready", lambda *args: None)
    monkeypatch.setattr(cloud, "_registry_manifest", lambda *args: None)
    preflight = {"fail": True}

    def verify(config, candidate):
        if preflight["fail"]:
            raise cloud.CloudError("Blob access denied")

    monkeypatch.setattr(cloud, "_job_capabilities", verify)
    monkeypatch.setattr(hf_credentials, "get_hf_token",
                        lambda: provider_calls.append("read"))
    runner = JobRunner(JobStore(), pipeline=lambda *args: {})
    try:
        incomplete = Api(runner).finish_cloud(image, True)
        assert incomplete["jobCreated"] and not incomplete["configured"]
        assert "Blob access denied" in incomplete["issue"]
        assert cloud._setting("cloud_job_created") == image
        preflight["fail"] = False
        repeated = Api(runner).finish_cloud(image, True)
    finally:
        runner.close()

    assert repeated["jobCreated"] and repeated["configured"]
    assert repeated["mode"] == "local" and not repeated["runtimeVerified"]
    assert cloud._setting("cloud_reuse") == "no"
    assert cloud._setting("cloud_job_created") == image
    assert json.loads(cloud._setting("cloud_job_resources")) == resources
    assert not provider_calls
    assert requests and all(method == "GET" for method, _ in requests)


def test_job_resources_match_azure_empty_ephemeral_storage_only():
    assert cloud._job_resources_match(
        {"cpu": 2, "memory": "8Gi", "ephemeralStorage": ""}, cloud.JOB_RESOURCES)
    assert cloud._job_resources_match(cloud.JOB_RESOURCES, cloud.JOB_RESOURCES)
    assert not cloud._job_resources_match(
        {"cpu": 4, "memory": "8Gi", "ephemeralStorage": ""}, cloud.JOB_RESOURCES)
    assert not cloud._job_resources_match(
        {"cpu": 2, "memory": "16Gi", "ephemeralStorage": ""}, cloud.JOB_RESOURCES)
    assert not cloud._job_resources_match(
        {"cpu": 2, "memory": "8Gi", "ephemeralStorage": "1Gi"}, cloud.JOB_RESOURCES)


def test_secret_write_error_cannot_echo_token_from_azure(monkeypatch, caplog):
    from mizan.api import response
    token_value = "hf_" + "s" * 40

    class Opener:
        def open(self, request, timeout):
            raise urllib.error.HTTPError(request.full_url, 403, token_value, {}, BytesIO(
                json.dumps({"error": {"code": "AuthorizationFailed",
                                      "message": f"Rejected token {token_value}"}}).encode()))

    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Opener())
    monkeypatch.setattr(cloud._Azure, "_auth", lambda self: "azure-token")
    body = {"properties": {"configuration": {"secrets": [
        {"name": "hf-token", "value": token_value}]}}}
    with pytest.raises(cloud.CloudError, match="Job secret could not be installed") as exc:
        cloud._Azure(SETUP).request("/subscriptions/x", "2024-03-01", "PUT", body)
    assert token_value not in str(exc.value)
    assert exc.value.__cause__ is None and exc.value.__context__ is None
    result = response(lambda: cloud._Azure(SETUP).request(
        "/subscriptions/x", "2024-03-01", "PUT", body))
    assert result["error"]["code"] == "cloud_failed"
    assert token_value not in str(result)
    assert token_value not in caplog.text

    class NetworkError:
        def open(self, request, timeout):
            raise urllib.error.URLError(token_value)
    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: NetworkError())
    with pytest.raises(cloud.CloudError, match="Job secret could not be installed") as network:
        cloud._Azure(SETUP).request("/subscriptions/x", "2024-03-01", "PUT", body)
    assert network.value.__cause__ is None and network.value.__context__ is None
    assert token_value not in str(network.value)


def test_import_requires_prepared_exact_digest_and_never_guesses_source(signed_in):
    source = "registry.example.com/mizan-aca-gpu@" + cloud.SUPPORTED_WORKER_DIGEST
    with pytest.raises(cloud.CloudError, match="Prepare Cloud"):
        cloud.import_cloud_image(source)
    cloud.configure(SETUP)
    cloud._setting("cloud_prepared", json.dumps(SETUP))
    for invalid in ("registry.example.com/mizan-aca-gpu:latest",
                    "https://" + source, source[:-1] + "0",
                    "user:password@registry.example.com/mizan-aca-gpu@"
                    + cloud.SUPPORTED_WORKER_DIGEST):
        with pytest.raises(cloud.CloudError, match="validated worker digest"):
            cloud.import_cloud_image(invalid)
    assert not cloud.status()["jobCreated"]


def test_import_copies_untagged_pinned_manifest_and_verifies_identity(signed_in, monkeypatch):
    from types import SimpleNamespace
    from azure import containerregistry
    cloud.configure(SETUP)
    cloud._setting("cloud_prepared", json.dumps(SETUP))
    source = "registry.example.com/project/mizan-aca-gpu@" + cloud.SUPPORTED_WORKER_DIGEST
    calls = []
    state = {"digest": cloud.SUPPORTED_WORKER_DIGEST}

    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"

        def __init__(self, config):
            assert config["userObjectId"] == "dddddddd-dddd-dddd-dddd-dddddddddddd"

        def request(self, path, version, method="GET", body=None):
            calls.append((method, path, version, body))
            return {"id": path}

    class Registry:
        def __init__(self, endpoint, credential):
            assert endpoint == "https://mizanregistry.azurecr.io"
            assert credential.get_token("https://containerregistry.azure.net/.default").token

        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def get_manifest(self, repo, digest):
            assert (repo, digest) == ("mizan-aca-gpu", cloud.SUPPORTED_WORKER_DIGEST)
            return SimpleNamespace(digest=state["digest"])

    monkeypatch.setattr(cloud, "_Azure", Azure)
    monkeypatch.setattr(containerregistry, "ContainerRegistryClient", Registry)
    runner = JobRunner(JobStore(), pipeline=lambda *args: {})
    try:
        result = Api(runner).import_cloud_image(source)
    finally:
        runner.close()
    assert result == {"ok": True, "image": "mizanregistry.azurecr.io/mizan-aca-gpu@"
                      + cloud.SUPPORTED_WORKER_DIGEST,
                      "digest": cloud.SUPPORTED_WORKER_DIGEST, "verified": True}
    imported = next(body for method, path, version, body in calls if method == "POST")
    assert imported == {
        "source": {"registryUri": "registry.example.com",
                   "sourceImage": "project/mizan-aca-gpu@" + cloud.SUPPORTED_WORKER_DIGEST},
        "untaggedTargetRepositories": ["mizan-aca-gpu"], "mode": "NoForce"}
    assert source not in str(cloud.status())
    state["digest"] = "sha256:" + "0" * 64
    with pytest.raises(cloud.CloudError, match="digest differs"):
        cloud.import_cloud_image(source)


def test_import_private_source_reports_clear_blocker(signed_in, monkeypatch):
    cloud.configure(SETUP)
    cloud._setting("cloud_prepared", json.dumps(SETUP))
    source = "private.azurecr.io/mizan-aca-gpu@" + cloud.SUPPORTED_WORKER_DIGEST
    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"

        def __init__(self, config):
            pass

        def request(self, path, version, method="GET", body=None):
            if method == "POST":
                raise cloud.CloudError("Azure 401")
            return {"id": path}

    monkeypatch.setattr(cloud, "_Azure", Azure)
    with pytest.raises(cloud.CloudError, match="source must permit anonymous pulls"):
        cloud.import_cloud_image(source)
    assert not cloud.status()["jobCreated"]


def test_build_bundles_exact_worker_and_pins_actual_acr_digest(signed_in, monkeypatch):
    from types import SimpleNamespace
    from azure import containerregistry
    import tarfile

    cloud.configure(SETUP)
    cloud._setting("cloud_prepared", json.dumps(SETUP))
    digest = "sha256:" + "1" * 64
    sas_url = ("https://mizanbuild.blob.core.windows.net/context/"
               "tasks-source/20260929/context.tar.gz?sig=private-sas")
    calls = []
    state = {"runs": 0}

    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"

        def __init__(self, config):
            assert config["userObjectId"] == "dddddddd-dddd-dddd-dddd-dddddddddddd"

        def request(self, path, version, method="GET", body=None):
            calls.append((method, path, version, body, cloud.setup_progress()))
            if "/Microsoft.ManagedIdentity/" in path:
                return {"properties": {"clientId": "managed-client", "principalId": "managed-principal"}}
            if "/managedEnvironments/" in path:
                return {"properties": {"provisioningState": "Succeeded"}}
            if "/Microsoft.App/jobs/" in path:
                return None
            if path.endswith("/listBuildSourceUploadUrl"):
                return {"relativePath": "tasks-source/20260929/context.tar.gz", "uploadUrl": sas_url}
            if path.endswith("/scheduleRun"):
                assert body["sourceLocation"] == "tasks-source/20260929/context.tar.gz"
                assert body["platform"] == {"os": "Linux", "architecture": "amd64"}
                assert body["isPushEnabled"] is True
                state["tag"] = body["imageNames"][0].split(":")[1]
                return {"properties": {"runId": "build-run-123"}}
            if "/runs/" in path:
                state["runs"] += 1
                if state["runs"] == 1:
                    return {"properties": {"status": "Queued"}}
                return {"properties": {"status": "Succeeded", "outputImages": [{
                    "registry": "mizanregistry.azurecr.io", "repository": "mizan-aca-gpu",
                    "tag": state["tag"], "digest": digest}]}}
            return {"id": path}

        def create(self, path, version, body):
            state["job_image"] = body["properties"]["template"]["containers"][0]["image"]
            return body

    class Upload:
        def open(self, request, timeout):
            assert request.full_url == sas_url and request.get_method() == "PUT"
            assert cloud.setup_progress()["stage"] == "upload"
            assert cloud.setup_progress()["completed"] == 1
            with tarfile.open(fileobj=BytesIO(request.data), mode="r:gz") as archive:
                assert {entry.name for entry in archive} == {"Dockerfile", "worker.py"}
                for name, content in cloud._worker_source()[0].items():
                    assert archive.extractfile(name).read() == content
            return BytesIO(b"")

    class Registry:
        def __init__(self, endpoint, credential):
            assert endpoint == "https://mizanregistry.azurecr.io"
            assert credential.get_token("https://containerregistry.azure.net/.default").token

        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def get_manifest(self, repo, tag):
            assert repo == "mizan-aca-gpu" and tag == state["tag"]
            assert cloud.setup_progress()["stage"] == "manifest"
            assert cloud.setup_progress()["completed"] == 3
            return SimpleNamespace(digest=digest)

    monkeypatch.setattr(cloud, "_Azure", Azure)
    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Upload())
    monkeypatch.setattr(containerregistry, "ContainerRegistryClient", Registry)
    monkeypatch.setattr(cloud.time, "sleep", lambda seconds: None)
    runner = JobRunner(JobStore(), pipeline=lambda *args: {})
    try:
        result = Api(runner).build_cloud_image()
    finally:
        runner.close()
    assert result["digest"] == digest and result["image"] == (
        "mizanregistry.azurecr.io/mizan-aca-gpu@" + digest)
    assert result["runId"] == "build-run-123" and result["sourceHash"] == cloud._worker_source()[1]
    assert next(item[4]["stage"] for item in calls if item[1].endswith("/scheduleRun")) == "build"
    assert next(item[4]["completed"] for item in calls if "/runs/" in item[1]) == 2
    assert cloud.setup_progress()["stage"] == "completed"
    assert cloud.setup_progress()["completed"] == 4
    assert cloud.status()["workerDigest"] == digest
    assert cloud.status()["workerImage"] == result["image"]
    assert "private-sas" not in str(result) + str(cloud.status())
    assert cloud._image_digest(
        cloud._setup(json.loads(cloud._setting("cloud_config"))), result["image"]) == digest
    monkeypatch.setattr(cloud, "_roles_ready", lambda *args: None)
    assert cloud.finish(result["image"], "hf_" + "s" * 40)["jobCreated"]
    assert state["job_image"] == result["image"]
    original_source = cloud._worker_source
    monkeypatch.setattr(cloud, "_worker_source",
                        lambda: (original_source()[0], "0" * 64))
    with pytest.raises(cloud.CloudError, match="current bundled worker source"):
        cloud._image_digest(
            cloud._setup(json.loads(cloud._setting("cloud_config"))), result["image"])
    assert cloud.status()["workerDigest"] is None
    assert cloud.status()["workerImage"] is None
    assert "no longer matches" in cloud.status()["issue"]
    monkeypatch.setattr(cloud, "_worker_source", original_source)
    with pytest.raises(cloud.CloudError, match="current bundled worker source"):
        cloud._image_digest(cloud._setup(json.loads(cloud._setting("cloud_config"))),
                            "mizanregistry.azurecr.io/mizan-aca-gpu@" + cloud.SUPPORTED_WORKER_DIGEST)


def test_build_upload_error_never_exposes_sas_and_stays_local(signed_in, monkeypatch):
    cloud.configure(SETUP)
    cloud._setting("cloud_prepared", json.dumps(SETUP))
    sas_url = "https://mizanbuild.blob.core.windows.net/context/source.tar.gz?sig=private-sas"

    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"

        def __init__(self, config):
            pass

        def request(self, path, version, method="GET", body=None):
            if path.endswith("/listBuildSourceUploadUrl"):
                return {"relativePath": "source/20260929/context.tar.gz", "uploadUrl": sas_url}
            if path.endswith("/scheduleRun"):
                pytest.fail("Build was scheduled after failed upload")
            return {"id": path}

    class Upload:
        def open(self, request, timeout):
            raise urllib.error.HTTPError(sas_url, 403, sas_url, {}, BytesIO(b""))

    monkeypatch.setattr(cloud, "_Azure", Azure)
    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Upload())
    with pytest.raises(cloud.CloudError, match="upload failed") as exc:
        cloud.build_cloud_image()
    assert "private-sas" not in str(exc.value)
    assert exc.value.__cause__ is None and exc.value.__context__ is None
    assert cloud.status()["mode"] == "local"
    assert not cloud._setting("cloud_built_image")


def test_build_failed_run_never_records_image(signed_in, monkeypatch):
    cloud.configure(SETUP)
    cloud._setting("cloud_prepared", json.dumps(SETUP))
    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"

        def __init__(self, config):
            pass

        def request(self, path, version, method="GET", body=None):
            if path.endswith("/listBuildSourceUploadUrl"):
                return {
                    "relativePath": "source/build/context.tar.gz",
                    "uploadUrl": "https://registry.blob.core.windows.net/context/build?sig=secret",
                }
            if path.endswith("/scheduleRun"):
                return {"properties": {"runId": "failed-run"}}
            if "/runs/" in path:
                return {"properties": {"status": "Failed"}}
            return {"id": path}

    class Upload:
        def open(self, request, timeout):
            return BytesIO(b"")

    monkeypatch.setattr(cloud, "_Azure", Azure)
    monkeypatch.setattr(cloud.urllib.request, "build_opener", lambda *args: Upload())
    with pytest.raises(cloud.CloudError, match="failed-run ended Failed"):
        cloud.build_cloud_image()
    assert cloud._setting("cloud_build_run") == "failed-run"
    assert not cloud._setting("cloud_built_image")
    assert cloud.status()["mode"] == "local"
    assert "failed-run has no verified image" in cloud.status()["issue"]


def test_corrupted_build_record_never_enables_cloud(signed_in):
    cloud.configure(SETUP)
    cloud._setting("cloud_built_image", "{invalid")
    assert cloud.status()["workerDigest"] is None
    assert cloud.status()["workerImage"] is None
    assert "build record is invalid" in cloud.status()["issue"]


def test_worker_image_resume_requires_selected_registry_and_current_source(signed_in, monkeypatch):
    cloud.configure(SETUP)
    image = "mizanregistry.azurecr.io/mizan-aca-gpu@sha256:" + "a" * 64
    source = cloud._worker_source
    cloud._setting("cloud_built_image", json.dumps({"image": image, "sourceHash": source()[1]}))
    assert cloud.status()["workerImage"] == image

    cloud._setting("cloud_built_image", json.dumps({
        "image": "otherregistry.azurecr.io/mizan-aca-gpu@sha256:" + "a" * 64,
        "sourceHash": source()[1]}))
    assert cloud.status()["workerImage"] is None
    assert "selected ACR" in cloud.status()["issue"]

    cloud._setting("cloud_built_image", json.dumps({"image": image, "sourceHash": source()[1]}))
    monkeypatch.setattr(cloud, "_worker_source", lambda: (source()[0], "b" * 64))
    assert cloud.status()["workerImage"] is None
    monkeypatch.setattr(cloud, "_worker_source", source)

    cloud.configure({**SETUP, "registry": "otherregistry"})
    assert not cloud._setting("cloud_built_image")
    assert cloud.status()["workerImage"] is None


def test_private_blob_preflight_uses_current_user(signed_in, monkeypatch):
    from contextlib import nullcontext
    from mizan import cloud_transport
    calls = []
    class Transport:
        def __init__(self, config):
            self.blob = f"https://{config['storageAccount']}.blob.core.windows.net/{config['container']}"

        def _open(self, url, **options):
            calls.append((url, options))
            return nullcontext(type("Response", (), {"read": lambda self: b""})())
    monkeypatch.setattr(cloud_transport, "CloudTransport", Transport)
    cloud._blob_access(SETUP)
    assert calls[0][1]["scope"] == cloud_auth.STORAGE_SCOPE
    monkeypatch.setattr(Transport, "_open",
                        lambda self, url, **options: (_ for _ in ()).throw(
                            cloud_transport.CloudTransportError("HTTP 403")))
    with pytest.raises(cloud.CloudError, match="selected Azure identity"):
        cloud._blob_access(SETUP)


def test_cloud_intent_survives_readiness_failure_without_local_fallback(signed_in, monkeypatch):
    cloud.configure(SETUP)
    image = "mizanregistry.azurecr.io/mizan-aca-gpu@" + cloud.SUPPORTED_WORKER_DIGEST
    cloud._setting("cloud_job_created", image)
    monkeypatch.setattr(cloud, "_job_capabilities", lambda config, image: None)
    check = cloud.status()
    assert check["configured"]
    assert check["verifiedModels"] == ["muscriptor-small"]
    assert set(check["supportedModels"]) == {"muscriptor-small", "muscriptor-medium", "muscriptor-large"}
    for model in check["supportedModels"]:
        JobStore().set_transcription_model(model)
        assert cloud.set_mode("cloud")["mode"] == "cloud"
        assert cloud.selected()
        cloud.require_model(model)
    monkeypatch.setattr(cloud, "_job_capabilities",
                        lambda config, image: (_ for _ in ()).throw(cloud.CloudError("Blob access denied")))
    failed = cloud.status()
    assert not failed["configured"] and "Blob access denied" in failed["issue"]
    assert failed["mode"] == cloud._setting("processing_mode") == "cloud"
    assert cloud.selected()
    with pytest.raises(cloud.CloudError, match="not supported"):
        cloud.require_model("unsupported")
    assert cloud._setting("processing_mode") == "cloud"


def test_cloud_large_choice_is_immediate_while_live_readiness_is_blocked(signed_in, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    cloud._setting("cloud_config", json.dumps(SETUP))
    cloud._setting("cloud_job_created", "synthetic-image")
    cloud._setting("transcription_model", "muscriptor-large")
    cloud._setting("processing_mode", "local")
    monkeypatch.setattr(cloud, "READINESS_TIMEOUT", 1.0)
    entered, release = threading.Event(), threading.Event()

    def blocked(*_args):
        entered.set()
        assert release.wait(3)
        cloud._check_readiness()

    monkeypatch.setattr(cloud, "_job_capabilities", blocked)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(cloud.panel_status, "slow-choice")
        try:
            assert entered.wait(3)
            started = time.monotonic()
            selected = cloud.set_mode("cloud")
            assert selected["ok"] and selected["mode"] == "cloud"
            assert selected["jobCreated"] and selected["config"]["jobName"] == CONFIG["jobName"]
            assert not selected["configured"]
            assert time.monotonic() - started < 0.5
            assert not pending.done()
            assert cloud._setting("processing_mode") == "cloud"
            timed_out = pending.result(timeout=3)
            assert not timed_out["configured"] and "timed out" in timed_out["issue"]
            assert cloud._setting("processing_mode") == "cloud"
            assert cloud.selected()
            assert JobStore().get_transcription_model() == "muscriptor-large"
            assert cloud._setting("processing_mode") == "cloud"
            snapshot = cloud.status(check_connection=False)
            assert snapshot["mode"] == "cloud" and not snapshot["configured"]
        finally:
            release.set()
            assert cloud._readiness_check.done.wait(3)


def test_cloud_selection_returns_saved_snapshot_without_live_readiness(signed_in, monkeypatch):
    config = {**SETUP, "userObjectId": "dddddddd-dddd-dddd-dddd-dddddddddddd"}
    image = f"{SETUP['registry']}.azurecr.io/mizan-aca-gpu@{cloud.SUPPORTED_WORKER_DIGEST}"
    cloud._setting("cloud_config", json.dumps(config))
    cloud._setting("cloud_prepared", json.dumps(config))
    cloud._setting("cloud_environment_ready", "yes")
    cloud._setting("cloud_job_created", image)
    cloud._setting("cloud_job_resources", json.dumps(cloud.JOB_RESOURCES))
    cloud._setting("transcription_model", "muscriptor-large")
    cloud._setting("processing_mode", "local")
    monkeypatch.setattr(cloud, "_job_capabilities",
                        lambda *_args: pytest.fail("Cloud preference save ran live readiness"))

    result = cloud.set_mode("cloud")

    assert result["ok"] and result["mode"] == "cloud"
    assert result["config"]["resourceGroup"] == SETUP["resourceGroup"]
    assert result["config"]["environment"] == SETUP["environment"]
    assert result["prepared"] and result["jobCreated"]
    assert result["configured"] is False
    assert "userObjectId" not in result["config"]
    assert cloud._setting("processing_mode") == "cloud"


def test_local_selection_succeeds_with_malformed_saved_cloud_config():
    cloud._setting("cloud_config", "{")
    cloud._setting("processing_mode", "cloud")

    assert cloud.set_mode("local") == {"ok": True, "mode": "local"}
    assert cloud._setting("processing_mode") == "local"


@pytest.mark.parametrize("invalid,reason", [
    ("missing-config", "not complete"), ("invalid-config", "not complete"),
    ("missing-job", "not complete"), ("unsupported-model", "not supported"),
    ("missing-worker", "no supported"), ("invalid-mode", "Choose local or cloud"),
])
def test_cloud_choice_still_validates_local_setup_worker_and_model(signed_in, monkeypatch, invalid, reason):
    cloud._setting("cloud_config", json.dumps(SETUP))
    cloud._setting("cloud_job_created", "synthetic-image")
    cloud._setting("processing_mode", "local")
    monkeypatch.setattr(cloud, "panel_status",
                        lambda *_args: pytest.fail("Choosing a provider waited for live readiness"))
    monkeypatch.setattr(cloud, "_job_capabilities",
                        lambda *_args: pytest.fail("Choosing a provider contacted Azure"))
    if invalid == "missing-config":
        cloud._setting("cloud_config", "")
    elif invalid == "invalid-config":
        cloud._setting("cloud_config", '{"tenantId":"invalid"}')
    elif invalid == "missing-job":
        cloud._setting("cloud_job_created", "")
    elif invalid == "unsupported-model":
        cloud._setting("transcription_model", "unsupported")
    elif invalid == "missing-worker":
        monkeypatch.setattr(cloud, "_worker_source",
                            lambda: (_ for _ in ()).throw(cloud.CloudError("Missing bundled worker")))
    with pytest.raises(cloud.CloudError, match=reason):
        cloud.set_mode("invalid" if invalid == "invalid-mode" else "cloud")
    assert cloud._setting("processing_mode") == "local"


def test_preflight_checks_job_private_storage_roles_and_user_blob_token(signed_in, monkeypatch):
    cloud.configure(SETUP)
    image = f"mizanregistry.azurecr.io/mizan-aca-gpu@{cloud.SUPPORTED_WORKER_DIGEST}"
    cloud._setting("cloud_job_created", image)
    cloud._setting("cloud_job_resources", json.dumps(cloud.JOB_RESOURCES))
    cloud._setting("cloud_reuse", "yes")
    tagged_image = "mizanregistry.azurecr.io/mizan-aca-gpu:combined-20260929-a100"
    state = {"secret": False, "private": True, "environment": "Succeeded"}
    checks = []
    manifest_checks = []

    class Azure:
        base = f"/subscriptions/{CONFIG['subscriptionId']}/resourceGroups/rg-mizan"

        def __init__(self, config):
            pass

        def request(self, path, version):
            identity = f"{self.base}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mizan-job-identity"
            if "/Microsoft.App/jobs/" in path:
                return {
                    "identity": {"userAssignedIdentities": {identity: {}}},
                    "properties": {
                        "environmentId": f"{self.base}/providers/Microsoft.App/managedEnvironments/mizan-aca-env",
                        "workloadProfileName": cloud.GPU_PROFILE,
                        "configuration": {
                            "triggerType": "Manual",
                            "registries": [{"server": "mizanregistry.azurecr.io", "identity": identity}],
                            "secrets": [{"name": "hf-token"}] if state["secret"] else [],
                        },
                        "template": {"containers": [{
                            "image": tagged_image,
                            "resources": state.get("resources", {
                                "cpu": 2, "memory": "8Gi", "ephemeralStorage": ""}),
                            "env": [{"name": "HF_TOKEN", "secretRef": "hf-token"},
                                    {"name": "AZURE_STORAGE_BLOB_URL",
                                     "value": "https://mizanblob.blob.core.windows.net"},
                                    {"name": "AZURE_STORAGE_CONTAINER", "value": "jobs"},
                                    {"name": "AZURE_CLIENT_ID", "value": "managed-client"}],
                        }]},
                    },
                }
            if "/Microsoft.ManagedIdentity/" in path:
                return {"properties": {"clientId": "managed-client", "principalId": "managed-principal"}}
            if "/Microsoft.App/managedEnvironments/" in path:
                return {"properties": {"provisioningState": state["environment"], "workloadProfiles": [{
                    "name": cloud.GPU_PROFILE, "workloadProfileType": cloud.GPU_TYPE}]}}
            if path.endswith("/containers/jobs"):
                return {"properties": {"publicAccess": "None" if state["private"] else "Blob"}}
            return {"properties": {"allowBlobPublicAccess": False, "supportsHttpsTrafficOnly": True}}

    monkeypatch.setattr(cloud, "_Azure", Azure)
    monkeypatch.setattr(
        cloud, "_registry_manifest",
        lambda config, reference, digest: manifest_checks.append((reference, digest)))
    monkeypatch.setattr(cloud, "_roles_ready", lambda *args: checks.append("roles"))
    monkeypatch.setattr(cloud, "_blob_access", lambda config: checks.append("blob"))
    cloud._setting("cloud_reuse", "no")
    assert not cloud.status()["configured"]
    cloud._setting("cloud_reuse", "yes")
    assert not cloud.status()["configured"]
    assert "HF_TOKEN is not bound" in cloud.status()["issue"]
    assert not checks
    state["secret"] = True
    state["private"] = False
    assert not cloud.status()["configured"]
    assert "private" in cloud.status()["issue"]
    assert checks == ["roles", "roles"]
    state["private"] = True
    ready = cloud.status()
    assert ready["configured"]
    assert ready["workerImage"] == image
    assert (tagged_image.rsplit(":", 1)[-1], cloud.SUPPORTED_WORKER_DIGEST) in manifest_checks
    assert checks[-2:] == ["roles", "blob"]
    assert cloud.status()["runtimeVerified"] is False
    assert "not passed a live A100 GPU smoke run" in cloud.status()["warning"]
    cloud._setting("processing_mode", "cloud")
    state["resources"] = {"cpu": 8, "memory": "32Gi", "ephemeralStorage": ""}
    assert cloud.status()["configured"]
    assert json.loads(cloud._setting("cloud_job_resources")) == cloud.JOB_RESOURCES
    state["resources"]["ephemeralStorage"] = "50Gi"
    assert not cloud.status()["configured"]
    state["resources"]["ephemeralStorage"] = ""
    cloud._setting("cloud_job_resources", json.dumps({"cpu": 8, "memory": "32Gi"}))
    state["resources"] = {"cpu": 2, "memory": "8Gi"}
    assert not cloud.status()["configured"]
    assert cloud.status()["mode"] == "cloud"
    cloud._setting("cloud_job_resources", json.dumps(cloud.JOB_RESOURCES))
    state["resources"] = {"cpu": 4, "memory": "8Gi", "ephemeralStorage": ""}
    assert not cloud.status()["configured"]
    assert "resources" in cloud.status()["issue"]
    state.pop("resources")
    registry_manifest = cloud._registry_manifest
    monkeypatch.setattr(
        cloud, "_registry_manifest",
        lambda config, reference, digest: (_ for _ in ()).throw(
            cloud.CloudError("The ACR manifest digest differs from the recorded build.")))
    assert not cloud.status()["configured"]
    assert "manifest digest differs" in cloud.status()["issue"]
    monkeypatch.setattr(cloud, "_registry_manifest", registry_manifest)
    cloud._setting("cloud_prepared", json.dumps(SETUP))
    cloud._setting("cloud_environment_ready", "yes")
    state["environment"] = "Failed"
    check = cloud.status()
    assert not check["prepared"] and not check["configured"]
    assert "environment failed to provision" in check["issue"]


def test_registry_manifest_errors_keep_auth_rbac_and_missing_image_distinct(signed_in, monkeypatch):
    from azure import containerregistry
    from azure.core.exceptions import AzureError

    class RegistryFailure(AzureError):
        def __init__(self, status_code):
            super().__init__("synthetic registry failure")
            self.status_code = status_code

    status = [403]

    class Registry:
        def __init__(self, *_args, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def get_manifest(self, *_args, **_kwargs):
            raise RegistryFailure(status[0])

    monkeypatch.setattr(containerregistry, "ContainerRegistryClient", Registry)
    for code, message in (
        (403, "Azure RBAC action required"),
        (401, "could not authenticate"),
        (404, "was not found"),
        (503, "Azure or registry error"),
    ):
        status[0] = code
        with pytest.raises(cloud.CloudError, match=message):
            cloud._registry_manifest(SETUP, cloud.SUPPORTED_WORKER_DIGEST,
                                     cloud.SUPPORTED_WORKER_DIGEST)


def test_panel_readiness_has_overall_bound_and_preserves_cloud_intent(signed_in, monkeypatch):
    cloud._setting("cloud_config", json.dumps(SETUP))
    cloud._setting("cloud_job_created", "synthetic-image")
    cloud._setting("processing_mode", "cloud")
    entered, release = threading.Event(), threading.Event()
    monkeypatch.setattr(cloud, "READINESS_TIMEOUT", 0.08)

    def slow(*_args):
        cloud._readiness_phase("private Blob container read access",
                               "Checking read access to the private Blob container.")
        entered.set()
        assert release.wait(3)
        cloud._check_readiness()

    monkeypatch.setattr(cloud, "_job_capabilities", slow)
    started = time.monotonic()
    try:
        result = cloud.panel_status("slow-panel")
        assert entered.is_set()
        assert time.monotonic() - started < 0.8
        assert not result["configured"] and "timed out" in result["issue"]
        assert "private Blob container read access" in result["issue"]
        assert "RBAC" not in result["issue"]
        assert result["mode"] == cloud._setting("processing_mode") == "cloud"
    finally:
        release.set()
        assert cloud._readiness_check.done.wait(3)


def test_panel_readiness_completes_after_previous_fifteen_second_limit(signed_in, monkeypatch):
    cloud._setting("cloud_config", json.dumps(SETUP))
    cloud._setting("cloud_job_created", "synthetic-image")
    cloud._setting("processing_mode", "cloud")
    elapsed = [100.0]
    monkeypatch.setattr(cloud.time, "monotonic", lambda: elapsed[0])
    phases = (
        ("Azure GPU Job", "Checking the configured Azure GPU Job."),
        ("ACR image", "Checking the registry image."),
        ("Azure role assignments", "Checking Azure role assignments."),
        ("GPU environment", "Checking the GPU environment."),
        ("private Blob storage", "Checking private storage."),
        ("private Blob container read access", "Checking Blob read access."),
    )

    def sequential(*_args):
        for stage, detail in phases:
            cloud._readiness_phase(stage, detail)
            elapsed[0] += 4
            cloud._check_readiness()

    monkeypatch.setattr(cloud, "_job_capabilities", sequential)
    result = cloud.panel_status("slow-but-successful-panel")
    assert elapsed[0] - 100 > 15
    assert result["configured"] and result["mode"] == "cloud"
    assert cloud._readiness_check.result["configured"]


def test_panel_checks_share_readiness_and_cancel_only_the_named_request(signed_in, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    cloud._setting("cloud_config", json.dumps(SETUP))
    cloud._setting("cloud_job_created", "synthetic-image")
    cloud._setting("processing_mode", "cloud")
    entered, release = threading.Event(), threading.Event()
    calls = []

    def slow(*_args):
        calls.append("readiness")
        entered.set()
        assert release.wait(3)
        cloud._check_readiness()

    monkeypatch.setattr(cloud, "_job_capabilities", slow)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(cloud.panel_status, "first-panel")
        try:
            assert entered.wait(3)
            second = pool.submit(cloud.panel_status, "second-panel")
            deadline = time.monotonic() + 3
            while "second-panel" not in cloud._readiness_requests and time.monotonic() < deadline:
                time.sleep(0.005)
            assert "second-panel" in cloud._readiness_requests
            assert cloud.cancel_panel_status("wrong-id") == {"cancelRequested": False}
            assert cloud.cancel_setup() == {"cancelRequested": False}
            assert cloud.cancel_panel_status("first-panel") == {"cancelRequested": True}
            cancelled = first.result(timeout=3)
            assert "cancelled" in cancelled["issue"] and cancelled["mode"] == "cloud"
            assert not second.done() and not cloud._readiness_check.cancelled.is_set()
            assert cloud.cancel_panel_status("first-panel") == {"cancelRequested": False}
            release.set()
            ready = second.result(timeout=3)
            assert ready["configured"] and ready["mode"] == "cloud"
            assert cloud.panel_status("cached-panel")["configured"]
            assert calls == ["readiness"]
            cloud._setting("processing_mode", "local")
            assert cloud.panel_status("cached-local")["mode"] == "local"
            assert calls == ["readiness"]
            assert cloud.set_mode("cloud")["mode"] == "cloud"
            assert cloud.panel_status("cached-cloud")["mode"] == "cloud"
            assert calls == ["readiness"]
        finally:
            release.set()


def test_closed_panel_stops_its_check_without_cancelling_provision(signed_in, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    cloud._setting("cloud_config", json.dumps(SETUP))
    cloud._setting("cloud_job_created", "synthetic-image")
    entered, release = threading.Event(), threading.Event()

    def slow(*_args):
        entered.set()
        assert release.wait(3)
        cloud._check_readiness()

    monkeypatch.setattr(cloud, "_job_capabilities", slow)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(cloud.panel_status, "closing-panel")
        try:
            assert entered.wait(3)
            with cloud.track_setup("provision", 10):
                assert cloud.cancel_panel_status("closing-panel")["cancelRequested"]
                assert not cloud._setup_cancelled.is_set()
                assert "cancelled" in pending.result(timeout=3)["issue"]
        finally:
            release.set()
            assert cloud._readiness_check.done.wait(3)


def test_panel_cancel_before_rpc_starts_does_not_launch_late_readiness(signed_in, monkeypatch):
    cloud._setting("cloud_config", json.dumps(SETUP))
    cloud._setting("cloud_job_created", "synthetic-image")
    cloud._setting("processing_mode", "cloud")
    monkeypatch.setattr(cloud, "_job_capabilities",
                        lambda *_args: pytest.fail("A closed panel launched Azure readiness"))
    assert cloud.cancel_panel_status("closed-before-start") == {"cancelRequested": False}
    result = cloud.panel_status("closed-before-start")
    assert "cancelled" in result["issue"] and result["mode"] == "cloud"
    assert not result["configured"]


def test_successful_cloud_run_records_runtime_validation(signed_in, monkeypatch):
    from pathlib import Path
    from threading import Event
    from mizan import cloud_transport

    cloud.configure(SETUP)
    image = "mizanregistry.azurecr.io/mizan-aca-gpu@" + cloud.SUPPORTED_WORKER_DIGEST
    cloud._setting("cloud_job_created", image)

    class Transport:
        def __init__(self, config):
            assert config["userObjectId"] == "dddddddd-dddd-dddd-dddd-dddddddddddd"

        def run(self, *args):
            return {}, ["uploaded"]

    monkeypatch.setattr(cloud_transport, "CloudTransport", Transport)
    monkeypatch.setattr(cloud, "_materialize", lambda *args: {"mix": "validated"})
    output, names = cloud.offload(
        Path("unused.wav"), Path("unused"), "muscriptor-small", Event(), lambda *args: None)
    assert output == {"mix": "validated"} and names == ["uploaded"]
    assert cloud._setting("cloud_runtime_verified") == image
