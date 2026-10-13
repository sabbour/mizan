import io
import json
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
from threading import Event

import pytest

from mizan import aws_cloud as cloud


ACCOUNT = "123456789012"
IMAGE = f"ghcr.io/example/mizan-cloud-worker@sha256:{'a' * 64}"
ROLE = f"arn:aws:iam::{ACCOUNT}:role/MizanBatchJobRole"
EXECUTION_ROLE = f"arn:aws:iam::{ACCOUNT}:role/MizanBatchExecutionRole"
SERVICE_ROLE = f"arn:aws:iam::{ACCOUNT}:role/AWSBatchServiceRole"
INSTANCE_ROLE = f"arn:aws:iam::{ACCOUNT}:instance-profile/ecsInstanceRole"
SECRET = f"arn:aws:secretsmanager:us-east-1:{ACCOUNT}:secret:mizan/hf-token-AbCd"
DEFINITION = f"arn:aws:batch:us-east-1:{ACCOUNT}:job-definition/mizan-worker:2"
RUN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
PREFIX = f"jobs/{RUN_ID}"
NAMES = [
    f"{PREFIX}/input.wav", f"{PREFIX}/result.json",
    *(f"{PREFIX}/result/stems/{stem}.wav" for stem in cloud.STEMS),
]


def settings(**overrides):
    result = {
        "provider": "aws", "profile": "default", "region": "us-east-1",
        "accountId": ACCOUNT, "bucket": "mizan-private-worker-bucket",
        "computeEnvironment": "mizan-worker-ce", "jobQueue": "mizan-worker-queue",
        "jobDefinition": DEFINITION, "role": ROLE,
        "executionRole": EXECUTION_ROLE, "serviceRole": SERVICE_ROLE,
        "instanceRole": INSTANCE_ROLE, "hfSecretArn": SECRET,
        "subnetIds": ["subnet-0123456789abcdef0"],
        "securityGroupIds": ["sg-0123456789abcdef0"],
        "image": IMAGE, "sourceHash": "b" * 64,
    }
    result.update(overrides)
    return result


class AwsError(Exception):
    def __init__(self, code, message="fake AWS error"):
        super().__init__(message)
        self.response = {"Error": {"Code": code, "Message": message}}


def test_settings_allow_network_creation_only_when_both_id_lists_are_empty():
    config = settings(subnetIds=[], securityGroupIds=[])
    checked = cloud._validate_settings(config)

    assert checked["subnetIds"] == checked["securityGroupIds"] == []
    with pytest.raises(cloud.CloudError, match="both AWS subnet"):
        cloud._validate_settings(settings(securityGroupIds=[]))
    assert cloud.MAX_AUDIO_BYTES == 250 * 1024 * 1024
    assert cloud.MAX_WORKER_ERROR_BYTES == 64 * 1024


def test_account_discovery_uses_selected_profile_and_region_without_saving(monkeypatch):
    saved = settings(profile="previous")
    original = dict(saved)
    calls = []
    session = object()
    monkeypatch.setattr(cloud, "load_provider_settings", lambda provider: saved)
    monkeypatch.setattr(cloud, "_session", lambda values: calls.append(dict(values)) or session)
    monkeypatch.setattr(cloud, "_identity", lambda selected: (
        selected is session and {"accountId": ACCOUNT, "arn": f"arn:aws:iam::{ACCOUNT}:user/test",
                                "userId": "test"}))

    result = cloud.list_subscriptions(profile="work", region="us-west-2")
    assert calls == [{"profile": "work", "region": "us-west-2"}]
    assert result == [{"accountId": ACCOUNT, "profile": "work", "region": "us-west-2",
                       "arn": f"arn:aws:iam::{ACCOUNT}:user/test", "userId": "test"}]
    assert saved == original


@pytest.mark.parametrize(("profile", "region"), [
    ("", "us-east-1"), ("invalid profile", "us-east-1"),
    ("default", ""), ("default", "https://example.invalid"), (42, "us-east-1"),
])
def test_account_discovery_rejects_invalid_input_before_sdk_calls(monkeypatch, profile, region):
    monkeypatch.setattr(cloud, "load_provider_settings", lambda provider: {})
    monkeypatch.setattr(cloud, "_session", lambda values: pytest.fail("Invalid discovery input reached AWS"))
    with pytest.raises(cloud.CloudError, match="valid AWS"):
        cloud.list_subscriptions(profile=profile, region=region)


def test_job_definition_uses_ec2_gpu_and_native_secret_binding_only():
    values = settings()

    definition = cloud._job_definition_body(values, secret_arn=SECRET)
    container = definition["containerProperties"]

    assert definition["platformCapabilities"] == ["EC2"]
    assert definition["retryStrategy"] == {"attempts": 1}
    assert definition["timeout"] == {"attemptDurationSeconds": 7200}
    assert container["jobRoleArn"] == ROLE
    assert container["executionRoleArn"] == EXECUTION_ROLE
    assert container["secrets"] == [{"name": "HF_TOKEN", "valueFrom": SECRET}]
    assert all(item["name"] != "HF_TOKEN" for item in container["environment"])
    assert container["resourceRequirements"] == [
        {"type": "VCPU", "value": "16"},
        {"type": "MEMORY", "value": "61440"},
        {"type": "GPU", "value": "1"},
    ]
    assert cloud.INSTANCE_HOST_MEMORY_RESERVE_GIB == 4
    assert all(memory * 1024 <= cloud.INSTANCE_MEMORY_MIB
               for _, memory in cloud.MODEL_EXECUTION_BUDGETS.values())
    assert cloud._definition_matches(
        {"containerProperties": container, "platformCapabilities": ["EC2"],
         "retryStrategy": {"attempts": 1}, "timeout": {"attemptDurationSeconds": 7200}},
        values, secret_arn=SECRET)
    assert [cloud._model_resources(name) for name in cloud.MODEL_EXECUTION_BUDGETS] == [
        (2, 8), (4, 16), (8, 32),
    ]
    with pytest.raises(cloud.CloudError, match="supported GPU allocation"):
        cloud._model_resources("unknown")


def test_private_bucket_setup_uses_real_secure_s3_request_shapes(monkeypatch):
    calls = []

    class S3:
        def head_bucket(self, **kwargs):
            calls.append(("head_bucket", kwargs))
            raise AwsError("404")

        def create_bucket(self, **kwargs):
            calls.append(("create_bucket", kwargs))

        def get_bucket_location(self, **kwargs):
            calls.append(("get_bucket_location", kwargs))
            return {"LocationConstraint": None}

        def put_public_access_block(self, **kwargs):
            calls.append(("put_public_access_block", kwargs))

        def put_bucket_ownership_controls(self, **kwargs):
            calls.append(("put_bucket_ownership_controls", kwargs))

        def put_bucket_encryption(self, **kwargs):
            calls.append(("put_bucket_encryption", kwargs))

        def get_bucket_policy(self, **kwargs):
            calls.append(("get_bucket_policy", kwargs))
            raise AwsError("NoSuchBucketPolicy")

        def put_bucket_policy(self, **kwargs):
            calls.append(("put_bucket_policy", kwargs))

    s3 = S3()
    monkeypatch.setattr(cloud, "_client", lambda _session, name, **_kwargs: s3 if name == "s3" else None)
    values = settings()
    identity = {"accountId": ACCOUNT, "arn": f"arn:aws:iam::{ACCOUNT}:user/worker"}

    cloud._ensure_bucket(object(), values, identity)
    cloud._ensure_bucket_policy(object(), values["bucket"], ACCOUNT, identity["arn"], ROLE)

    requests = dict(calls)
    assert requests["create_bucket"] == {"Bucket": values["bucket"]}
    access = requests["put_public_access_block"]["PublicAccessBlockConfiguration"]
    assert all(access.values())
    assert requests["put_bucket_ownership_controls"]["OwnershipControls"] == {
        "Rules": [{"ObjectOwnership": "BucketOwnerEnforced"}],
    }
    assert requests["put_bucket_encryption"]["ServerSideEncryptionConfiguration"]["Rules"][0][
        "ApplyServerSideEncryptionByDefault"] == {"SSEAlgorithm": "AES256"}
    assert "BucketKeyEnabled" not in requests["put_bucket_encryption"][
        "ServerSideEncryptionConfiguration"]["Rules"][0]
    policy = json.loads(requests["put_bucket_policy"]["Policy"])
    assert all(statement["Effect"] == "Allow" for statement in policy["Statement"])
    assert {statement["Principal"]["AWS"] for statement in policy["Statement"]} == {
        identity["arn"], ROLE,
    }
    assert all("s3:*" not in statement["Action"] for statement in policy["Statement"])
    assert not any("ACL" in call or "SSECustomer" in call for call, _ in calls)


def test_approved_network_creation_builds_public_subnet_and_https_only_egress(monkeypatch):
    calls = []
    state = {"vpcs": [], "gateways": [], "subnets": [], "routes": [],
             "groups": [], "routeTables": []}

    class Ec2:
        def describe_vpcs(self, **kwargs):
            calls.append(("describe_vpcs", kwargs))
            if kwargs.get("Filters"):
                return {"Vpcs": state["vpcs"]}
            return {"Vpcs": state["vpcs"]}

        def create_vpc(self, **kwargs):
            calls.append(("create_vpc", kwargs))
            vpc = {"VpcId": "vpc-0123456789abcdef0", "CidrBlock": kwargs["CidrBlock"]}
            state["vpcs"].append(vpc)
            return {"Vpc": vpc}

        def modify_vpc_attribute(self, **kwargs):
            calls.append(("modify_vpc_attribute", kwargs))

        def describe_internet_gateways(self, **kwargs):
            calls.append(("describe_internet_gateways", kwargs))
            return {"InternetGateways": state["gateways"]}

        def create_internet_gateway(self, **kwargs):
            calls.append(("create_internet_gateway", kwargs))
            gateway = {"InternetGatewayId": "igw-0123456789abcdef0", "Attachments": []}
            state["gateways"].append(gateway)
            return {"InternetGateway": gateway}

        def attach_internet_gateway(self, **kwargs):
            calls.append(("attach_internet_gateway", kwargs))
            state["gateways"][0]["Attachments"].append({"VpcId": kwargs["VpcId"]})

        def describe_availability_zones(self, **kwargs):
            calls.append(("describe_availability_zones", kwargs))
            return {"AvailabilityZones": [{"ZoneName": "us-east-1a"}]}

        def describe_subnets(self, **kwargs):
            calls.append(("describe_subnets", kwargs))
            return {"Subnets": state["subnets"]}

        def create_subnet(self, **kwargs):
            calls.append(("create_subnet", kwargs))
            subnet = {"SubnetId": "subnet-0123456789abcdef0", "VpcId": kwargs["VpcId"],
                      "State": "available"}
            state["subnets"].append(subnet)
            return {"Subnet": subnet}

        def modify_subnet_attribute(self, **kwargs):
            calls.append(("modify_subnet_attribute", kwargs))

        def describe_route_tables(self, **kwargs):
            calls.append(("describe_route_tables", kwargs))
            return {"RouteTables": state["routeTables"]}

        def create_route_table(self, **kwargs):
            calls.append(("create_route_table", kwargs))
            table = {"RouteTableId": "rtb-0123456789abcdef0", "Routes": [], "Associations": []}
            state["routeTables"].append(table)
            return {"RouteTable": table}

        def create_route(self, **kwargs):
            calls.append(("create_route", kwargs))
            state["routeTables"][0]["Routes"].append({
                "DestinationCidrBlock": kwargs["DestinationCidrBlock"],
                "GatewayId": kwargs["GatewayId"], "State": "active",
            })

        def associate_route_table(self, **kwargs):
            calls.append(("associate_route_table", kwargs))
            state["routeTables"][0]["Associations"].append({"SubnetId": kwargs["SubnetId"]})

        def describe_security_groups(self, **kwargs):
            calls.append(("describe_security_groups", kwargs))
            groups = state["groups"]
            if kwargs.get("GroupIds"):
                groups = [group for group in groups if group["GroupId"] in kwargs["GroupIds"]]
            return {"SecurityGroups": groups}

        def create_security_group(self, **kwargs):
            calls.append(("create_security_group", kwargs))
            group = {"GroupId": "sg-0123456789abcdef0", "VpcId": kwargs["VpcId"],
                     "IpPermissionsEgress": [{
                         "IpProtocol": "-1", "IpRanges": [{"CidrIp": "0.0.0.0/0"}],
                     }]}
            state["groups"].append(group)
            return {"GroupId": group["GroupId"]}

        def revoke_security_group_egress(self, **kwargs):
            calls.append(("revoke_security_group_egress", kwargs))
            state["groups"][0]["IpPermissionsEgress"] = []

        def authorize_security_group_egress(self, **kwargs):
            calls.append(("authorize_security_group_egress", kwargs))
            state["groups"][0]["IpPermissionsEgress"] = kwargs["IpPermissions"]

    ec2 = Ec2()
    monkeypatch.setattr(cloud, "_client", lambda _session, name, **_kwargs: ec2 if name == "ec2" else None)
    values = settings(subnetIds=[], securityGroupIds=[])

    vpc = cloud._created_network(object(), values)

    assert vpc == "vpc-0123456789abcdef0"
    assert values["subnetIds"] == ["subnet-0123456789abcdef0"]
    assert values["securityGroupIds"] == ["sg-0123456789abcdef0"]
    assert values["vpcId"] == vpc
    assert state["routeTables"][0]["Routes"][0]["GatewayId"] == "igw-0123456789abcdef0"
    egress = state["groups"][0]["IpPermissionsEgress"]
    assert egress == [{
        "IpProtocol": "tcp", "FromPort": 443, "ToPort": 443,
        "IpRanges": [{"CidrIp": "0.0.0.0/0", "Description": "HTTPS for worker image and models"}],
    }]
    assert not any(name == "authorize_security_group_ingress" for name, _ in calls)
    assert any(name == "create_vpc" for name, _ in calls)


def test_s3_file_store_enforces_private_conditional_upload_and_validated_names(monkeypatch, tmp_path):
    calls = []

    class Body(io.BytesIO):
        pass

    class S3:
        def put_object(self, **kwargs):
            calls.append(("put_object", kwargs))

        def get_object(self, **kwargs):
            calls.append(("get_object", kwargs))
            return {"ContentLength": 3, "Body": Body(b"abc")}

        def delete_objects(self, **kwargs):
            calls.append(("delete_objects", kwargs))
            return {"Deleted": kwargs["Delete"]["Objects"]}

    client = S3()
    monkeypatch.setattr(cloud, "_client", lambda _session, name, **_kwargs: client)
    files = cloud._S3Files(object(), "private-bucket")
    local = tmp_path / "input.wav"
    local.write_bytes(b"audio")

    limit = cloud.MAX_AUDIO_BYTES
    files.upload(NAMES[0], local, limit=limit)
    destination = tmp_path / "download.wav"
    assert files.download(NAMES[1], destination, limit=3) == (
        3, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    files.delete(NAMES)

    put = calls[0][1]
    assert put["IfNoneMatch"] == "*" and put["ContentLength"] == 5
    assert put["Bucket"] == "private-bucket"
    assert calls[1][1]["Key"] == NAMES[1]
    assert calls[2][1]["Delete"]["Objects"] == [{"Key": name} for name in NAMES]
    with pytest.raises(cloud.CloudError, match="exceeds"):
        files.upload(NAMES[0], local, limit=2)
    with pytest.raises(cloud.CloudError, match="outside the validated job prefix"):
        files.download("other-account/file", destination, limit=limit)


def test_image_import_saves_only_the_verified_image_for_aws(monkeypatch):
    config = settings(image="")
    saved = []
    monkeypatch.setattr(cloud, "_saved_settings", lambda: dict(config))
    monkeypatch.setattr(cloud, "_verify_image", lambda image: {
        "image": image, "digest": "sha256:" + "c" * 64, "sourceHash": "d" * 64,
    })
    monkeypatch.setattr(cloud, "save_provider_settings",
                        lambda provider, values: saved.append((provider, dict(values))) or values)

    result = cloud.import_cloud_image(IMAGE)

    assert result == {
        "ok": True, "provider": "aws", "image": IMAGE,
        "digest": "sha256:" + "c" * 64, "sourceHash": "d" * 64, "verified": True,
    }
    assert saved[0][0] == "aws"
    assert saved[0][1]["sourceHash"] == "d" * 64
    assert saved[0][1]["profile"] == "default"
    assert saved[0][1]["hfSecretArn"] == SECRET
    assert "SecretString" not in saved[0][1]


def test_public_config_includes_verified_nonsecret_source_hash():
    values = settings()

    assert cloud._public_config(values)["sourceHash"] == values["sourceHash"]


def test_configure_round_trip_preserves_omitted_read_only_references(monkeypatch):
    old = settings(vpcId="vpc-0123456789abcdef0",
                   routeTableId="rtb-0123456789abcdef0",
                   internetGatewayId="igw-0123456789abcdef0")
    config = {key: old[key] for key in cloud.AWS_FIELDS}
    saved = {}
    monkeypatch.setattr(cloud, "_expected_settings",
                        lambda candidate: (cloud._validate_settings(candidate), object(),
                                           {"accountId": ACCOUNT}))
    monkeypatch.setattr(cloud, "load_provider_settings", lambda _provider: dict(old))
    monkeypatch.setattr(cloud, "save_provider_settings",
                        lambda _provider, values: saved.update(values) or values)
    monkeypatch.setattr(cloud, "_setting", lambda *_args: None)
    monkeypatch.setattr(cloud, "status", lambda **_kwargs: {
        "ok": True, "provider": "aws", "config": cloud._public_config(saved),
    })

    result = cloud.configure(config)

    for key in (*cloud.AWS_INTERNAL_FIELDS, "sourceHash"):
        assert saved[key] == old[key]
        assert result["config"][key] == old[key]


def test_configure_does_not_keep_source_hash_for_changed_image(monkeypatch):
    old = settings()
    config = {key: old[key] for key in cloud.AWS_FIELDS}
    config["image"] = IMAGE.replace("a" * 64, "c" * 64)
    saved = {}
    monkeypatch.setattr(cloud, "_expected_settings",
                        lambda candidate: (cloud._validate_settings(candidate), object(),
                                           {"accountId": ACCOUNT}))
    monkeypatch.setattr(cloud, "load_provider_settings", lambda _provider: dict(old))
    monkeypatch.setattr(cloud, "save_provider_settings",
                        lambda _provider, values: saved.update(values) or values)
    monkeypatch.setattr(cloud, "_setting", lambda *_args: None)
    monkeypatch.setattr(cloud, "status", lambda **_kwargs: {
        "ok": True, "provider": "aws", "config": cloud._public_config(saved),
    })

    cloud.configure(config)

    assert "sourceHash" not in saved
    assert saved["executionRole"] == old["executionRole"]
    assert saved["hfSecretArn"] == old["hfSecretArn"]


def test_finish_without_token_is_read_only_and_reports_consent(monkeypatch):
    values = settings(hfSecretArn=None, jobDefinition="mizan-worker")
    calls = []

    class Batch:
        def describe_job_definitions(self, **kwargs):
            calls.append(("describe_job_definitions", kwargs))
            return {"jobDefinitions": []}

    monkeypatch.setattr(cloud, "_saved_settings", lambda: dict(values))
    monkeypatch.setattr(cloud, "_verify_image", lambda image: {
        "image": image, "digest": "sha256:" + "a" * 64, "sourceHash": "b" * 64,
    })
    monkeypatch.setattr(cloud, "_expected_settings",
                        lambda selected: (dict(selected), object(), {"accountId": ACCOUNT}))
    monkeypatch.setattr(cloud, "_client", lambda _session, name, **_kwargs: Batch())
    monkeypatch.setattr(cloud, "_status_for", lambda selected, **kwargs: {
        "ok": True, "provider": "aws", "configured": False, "mode": "local",
    })

    result = cloud.finish(IMAGE)

    assert result["requiresHfTokenConsent"] is True
    assert result["jobCreated"] is False
    assert [call[0] for call in calls] == ["describe_job_definitions"]


def test_finish_read_only_existing_binding_describes_revision_arn_by_name(monkeypatch):
    values = settings()
    requests = []

    class Batch:
        def describe_job_definitions(self, **kwargs):
            requests.append(kwargs)
            definition = cloud._job_definition_body(values, secret_arn=SECRET)
            definition["jobDefinitionArn"] = DEFINITION
            return {"jobDefinitions": [definition]}

    monkeypatch.setattr(cloud, "_saved_settings", lambda: dict(values))
    monkeypatch.setattr(cloud, "_verify_image", lambda image: {
        "image": image, "digest": "sha256:" + "a" * 64, "sourceHash": "b" * 64,
    })
    monkeypatch.setattr(cloud, "_expected_settings",
                        lambda selected: (dict(selected), object(), {"accountId": ACCOUNT}))
    monkeypatch.setattr(cloud, "_client", lambda *_args, **_kwargs: Batch())
    monkeypatch.setattr(cloud, "_status_for", lambda *_args, **_kwargs: {
        "ok": True, "provider": "aws", "configured": True, "mode": "cloud",
    })

    result = cloud.finish(IMAGE)

    assert requests == [{"jobDefinitionName": "mizan-worker", "status": "ACTIVE"}]
    assert result["jobCreated"] is True
    assert result["configured"] is True


@pytest.mark.parametrize("message", [
    "Saved AWS settings contain unsupported fields.",
    "Saved AWS settings must not contain credentials or tokens.",
    "Saved AWS settings have a mismatched provider ID.",
])
def test_status_and_panel_preserve_saved_settings_errors(monkeypatch, message):
    def fail_loading():
        raise cloud.BaseCloudError(message)

    monkeypatch.setattr(cloud, "_saved_settings", fail_loading)
    monkeypatch.setattr(cloud, "_setting", lambda _name: "local")

    assert cloud.status()["issue"] == message
    assert cloud.panel_status()["issue"] == message


def test_status_empty_settings_keeps_initial_setup_message(monkeypatch):
    monkeypatch.setattr(cloud, "load_provider_settings", lambda _provider: {})
    monkeypatch.setattr(cloud, "_setting", lambda _name: "local")

    result = cloud.status()

    assert result["configured"] is False
    assert result["issue"] == "Select an AWS profile, region, S3 bucket and Batch resources."


def test_hf_secret_is_sent_only_to_secrets_manager_and_returns_only_reference(monkeypatch):
    calls = []

    class Secrets:
        def describe_secret(self, **kwargs):
            calls.append(("describe_secret", kwargs))
            raise AwsError("ResourceNotFoundException")

        def create_secret(self, **kwargs):
            calls.append(("create_secret", kwargs))
            return {"ARN": SECRET, "Name": kwargs["Name"]}

    monkeypatch.setattr(cloud, "_client", lambda _session, name, **_kwargs: Secrets())
    reference = cloud._store_hf_token(object(), settings(hfSecretArn=None), "hf_" + "a" * 20)

    assert reference == SECRET
    stored = dict(calls)["create_secret"]
    assert stored["SecretString"] == "hf_" + "a" * 20
    assert "SecretString" not in str(reference)
    assert set(stored) == {"Name", "Description", "SecretString"}


def test_offload_records_returned_batch_id_before_poll_and_materializes_all_six_stems(
        monkeypatch, tmp_path):
    values = settings()
    calls = []

    class Batch:
        def submit_job(self, **kwargs):
            calls.append(("submit_job", kwargs))
            return {"jobId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}

        def describe_jobs(self, **kwargs):
            calls.append(("describe_jobs", kwargs))
            return {"jobs": [{"jobId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                              "status": "SUCCEEDED"}]}

    class Files:
        def __init__(self, *_args):
            self.deleted = []

        def upload(self, name, path, **kwargs):
            calls.append(("upload", name))

        def download_bytes(self, name, *, limit):
            calls.append(("download_bytes", name, limit))
            return b"{}"

        def delete(self, names):
            self.deleted.append(names)

    files = Files()
    materialized = []
    monkeypatch.setattr(cloud, "_target_config", lambda target: dict(target["settings"]))
    monkeypatch.setattr(cloud, "_verify_image", lambda image: {
        "image": image, "digest": "sha256:" + "a" * 64, "sourceHash": "b" * 64,
    })
    monkeypatch.setattr(cloud, "_expected_settings",
                        lambda selected: (dict(selected), object(), {"accountId": ACCOUNT}))
    monkeypatch.setattr(cloud, "_preflight", lambda *args, **kwargs: None)
    monkeypatch.setattr(cloud, "_client", lambda _session, name, **_kwargs: Batch())
    monkeypatch.setattr(cloud, "_S3Files", lambda *_args: files)
    monkeypatch.setattr(cloud, "_materialize", lambda manifest, store, names, *args, **kwargs:
                        materialized.append((manifest, store, names)) or {"mix": "validated"})
    recording = tmp_path / "input.wav"
    recording.write_bytes(b"audio")
    progress = []

    result, names = cloud.offload(
        recording, tmp_path, "muscriptor-small", Event(),
        lambda *args, **kwargs: progress.append((args, kwargs)),
        target={"version": 1, "provider": "aws", "settings": values},
    )

    assert result == {"mix": "validated"}
    prefix = names[0].removesuffix("/input.wav")
    assert names == [
        f"{prefix}/input.wav", f"{prefix}/result.json",
        *(f"{prefix}/result/stems/{stem}.wav" for stem in cloud.STEMS),
    ]
    assert materialized[0][2] == names
    assert len([name for name in names if "/result/stems/" in name]) == 6
    assert progress[1][1]["cloud_job"] == {
        "provider": "aws", "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "prefix": prefix,
    }
    assert [call[0] for call in calls].index("submit_job") < [
        call[0] for call in calls].index("describe_jobs")
    submit = next(call[1] for call in calls if call[0] == "submit_job")
    assert submit["retryStrategy"] == {"attempts": 1}
    assert submit["timeout"] == {"attemptDurationSeconds": 7200}
    assert submit["containerOverrides"]["resourceRequirements"][:2] == [
        {"type": "VCPU", "value": "2"}, {"type": "MEMORY", "value": "8192"},
    ]
    assert not files.deleted


def test_ambiguous_batch_submit_is_not_retried_or_cleaned(monkeypatch, tmp_path):
    values = settings()
    calls, deleted = [], []

    class Batch:
        def submit_job(self, **kwargs):
            calls.append(kwargs)
            raise TimeoutError("socket timed out")

    class Files:
        def upload(self, *_args, **_kwargs):
            pass

        def delete(self, names):
            deleted.append(names)

    monkeypatch.setattr(cloud, "_target_config", lambda target: dict(target["settings"]))
    monkeypatch.setattr(cloud, "_verify_image", lambda image: {
        "image": image, "digest": "sha256:" + "a" * 64, "sourceHash": "b" * 64,
    })
    monkeypatch.setattr(cloud, "_expected_settings",
                        lambda selected: (dict(selected), object(), {"accountId": ACCOUNT}))
    monkeypatch.setattr(cloud, "_preflight", lambda *args, **kwargs: None)
    monkeypatch.setattr(cloud, "_client", lambda _session, name, **_kwargs: Batch())
    monkeypatch.setattr(cloud, "_S3Files", lambda *_args: Files())
    recording = tmp_path / "input.wav"
    recording.write_bytes(b"audio")

    with pytest.raises(cloud.CloudError, match="outcome is unknown"):
        cloud.offload(recording, tmp_path, "muscriptor-small", Event(), lambda *_args, **_kwargs: None,
                      target={"version": 1, "provider": "aws", "settings": values})

    assert len(calls) == 1
    assert deleted == []


@pytest.mark.parametrize(("initial", "method"), [
    ("RUNNABLE", "cancel_job"), ("RUNNING", "terminate_job"), ("UNKNOWN", None),
])
def test_cancel_uses_batch_operation_and_deletes_only_after_stop_confirmation(
        monkeypatch, tmp_path, initial, method):
    values = settings()
    calls, deleted = [], []
    stop_status = "FAILED" if method else "UNKNOWN"

    class Batch:
        def submit_job(self, **kwargs):
            return {"jobId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}

        def describe_jobs(self, **kwargs):
            calls.append(("describe_jobs", kwargs))
            status = initial if len([name for name, _ in calls if name == "describe_jobs"]) == 1 else stop_status
            return {"jobs": [{"jobId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                              "status": status}]}

        def cancel_job(self, **kwargs):
            calls.append(("cancel_job", kwargs))

        def terminate_job(self, **kwargs):
            calls.append(("terminate_job", kwargs))

    class Files:
        def upload(self, *_args, **_kwargs):
            pass

        def delete(self, names):
            deleted.append(names)

    batch = Batch()
    monkeypatch.setattr(cloud, "_target_config", lambda target: dict(target["settings"]))
    monkeypatch.setattr(cloud, "_verify_image", lambda image: {
        "image": image, "digest": "sha256:" + "a" * 64, "sourceHash": "b" * 64,
    })
    monkeypatch.setattr(cloud, "_expected_settings",
                        lambda selected: (dict(selected), object(), {"accountId": ACCOUNT}))
    monkeypatch.setattr(cloud, "_preflight", lambda *args, **kwargs: None)
    monkeypatch.setattr(cloud, "_client", lambda _session, name, **_kwargs: batch)
    monkeypatch.setattr(cloud, "_S3Files", lambda *_args: Files())
    recording = tmp_path / "input.wav"
    recording.write_bytes(b"audio")
    cancelled = Event()

    def report(*_args, **kwargs):
        if kwargs.get("cloud_job"):
            cancelled.set()

    with pytest.raises(cloud.Cancelled):
        cloud.offload(recording, tmp_path, "muscriptor-small", cancelled, report,
                      target={"version": 1, "provider": "aws", "settings": values})

    called = [name for name, _ in calls]
    assert (method in called) if method else not any(
        name in called for name in ("cancel_job", "terminate_job"))
    assert bool(deleted) is bool(method)


def test_shared_state_is_used_for_setup_and_panel_operations(monkeypatch):
    calls = []

    class State:
        def setup_progress(self):
            calls.append("setup_progress")
            return {"stage": "ready"}

        def track_setup(self, operation, total):
            calls.append(("track_setup", operation, total))
            return "context"

        def cancel_setup(self):
            calls.append("cancel_setup")
            return {"cancelRequested": True}

        def readiness_progress(self, request_id):
            calls.append(("readiness_progress", request_id))
            return {"stage": "ready"}

        def cancel_panel_status(self, request_id):
            calls.append(("cancel_panel_status", request_id))
            return {"cancelRequested": True}

        def step(self, stage, completed, detail):
            calls.append(("step", stage, completed, detail))

        def check_cancelled(self):
            calls.append("check_cancelled")

    monkeypatch.setattr(cloud, "state", State())

    assert cloud.setup_progress() == {"stage": "ready"}
    assert cloud.track_setup("provision", 4) == "context"
    assert cloud.cancel_setup() == {"cancelRequested": True}
    assert cloud.readiness_progress("request") == {"stage": "ready"}
    assert cloud.cancel_panel_status("request") == {"cancelRequested": True}
    cloud._step("storage", 1, "secured")
    cloud._check_cancelled()
    assert ("step", "storage", 1, "secured") in calls


def test_prepare_requires_explicit_approval_before_any_aws_request(monkeypatch):
    monkeypatch.setattr(cloud, "_expected_settings",
                        lambda *_args: pytest.fail("AWS must not be contacted without consent"))

    with pytest.raises(cloud.CloudError, match="Approve AWS"):
        cloud.prepare(settings(), consent=False)


def test_compute_environment_is_zero_idle_on_demand_ec2_gpu(monkeypatch):
    calls = []

    class Batch:
        def describe_compute_environments(self, **kwargs):
            calls.append(("describe_compute_environments", kwargs))
            return {"computeEnvironments": []}

        def create_compute_environment(self, **kwargs):
            calls.append(("create_compute_environment", kwargs))

    batch = Batch()
    monkeypatch.setattr(cloud, "_client", lambda *_args, **_kwargs: batch)
    monkeypatch.setattr(cloud, "_wait_compute_environment",
                        lambda *_args, **_kwargs: {"status": "VALID"})

    cloud._create_compute_environment(object(), settings())

    request = next(args for name, args in calls if name == "create_compute_environment")
    resources = request["computeResources"]
    from botocore.session import Session
    from botocore.validate import validate_parameters

    shape = Session().get_service_model("batch").operation_model(
        "CreateComputeEnvironment").input_shape
    validate_parameters(request, shape)
    assert request["type"] == "MANAGED"
    assert resources["type"] == "EC2"
    assert resources["minvCpus"] == resources["desiredvCpus"] == 0
    assert resources["allocationStrategy"] == "BEST_FIT_PROGRESSIVE"
    assert resources["instanceTypes"] == ["g5.4xlarge"]
    assert resources["maxvCpus"] == cloud.INSTANCE_VCPUS
    assert resources["ec2Configuration"] == [{"imageType": "ECS_AL2023_NVIDIA"}]
    assert cloud._uses_nvidia_ecs_ami(resources)
    assert "bidPercentage" not in resources and "spotIamFleetRole" not in resources
    assert not cloud._uses_nvidia_ecs_ami({
        "ec2Configuration": [{
            "imageType": "ECS_AL2023_NVIDIA", "imageIdOverride": "ami-custom",
        }],
    })


def test_existing_role_policy_is_not_overwritten(monkeypatch):
    expected = {"Version": "2012-10-17", "Statement": []}
    calls = []

    class Iam:
        def get_role_policy(self, **kwargs):
            calls.append(("get_role_policy", kwargs))
            return {"PolicyDocument": json.dumps(expected)}

        def put_role_policy(self, **kwargs):
            calls.append(("put_role_policy", kwargs))

    monkeypatch.setattr(cloud, "_client", lambda *_args, **_kwargs: Iam())
    cloud._role_policy(object(), "worker", "MizanCloudAccess", expected)
    assert [name for name, _ in calls] == ["get_role_policy"]

    with pytest.raises(cloud.CloudError, match="differs from the required"):
        cloud._role_policy(object(), "worker", "MizanCloudAccess",
                           {"Version": "2012-10-17", "Statement": [{"Effect": "Allow"}]})
    assert [name for name, _ in calls] == ["get_role_policy", "get_role_policy"]


def test_expired_profile_and_quota_errors_are_actionable():
    expired = cloud._aws_error("confirm the selected AWS account", AwsError("ExpiredToken"))
    quota = cloud._aws_error("create AWS Batch GPU compute", AwsError("VcpuLimitExceeded"))

    assert "credentials expired" in str(expired)
    assert "quota or capacity" in str(quota)
    assert "fake AWS error" not in str(expired)


def test_list_subscriptions_preserves_malformed_saved_settings_error(monkeypatch):
    monkeypatch.setattr(
        cloud, "load_provider_settings",
        lambda _provider: (_ for _ in ()).throw(
            cloud.BaseCloudError("Saved AWS settings contain unsupported fields.")),
    )

    with pytest.raises(cloud.BaseCloudError, match="contain unsupported fields"):
        cloud.list_subscriptions()


def test_readiness_partial_cancel_is_merged_into_pinned_full_status(monkeypatch):
    captured = []

    class State:
        def panel_status(self, request_id, _callback):
            captured.append(request_id)
            return {"issue": "The AWS readiness check was cancelled."}

    values = settings()
    monkeypatch.setattr(cloud, "_saved_settings", lambda: dict(values))
    monkeypatch.setattr(cloud, "state", State())
    monkeypatch.setattr(cloud, "_setting", lambda _name: "local")

    result = cloud.panel_status()

    assert captured and isinstance(captured[0], str) and captured[0]
    assert result["provider"] == "aws"
    assert result["config"]["profile"] == values["profile"]
    assert result["configured"] is False
    assert result["requiresHfTokenConsent"] is False
    assert "cancelled" in result["issue"]


def test_selected_network_rejects_inbound_permissions_without_mutating(monkeypatch):
    calls = []

    class Ec2:
        def describe_subnets(self, **kwargs):
            calls.append(("describe_subnets", kwargs))
            return {"Subnets": [{"SubnetId": "subnet-0123456789abcdef0",
                                 "VpcId": "vpc-0123456789abcdef0",
                                 "State": "available"}]}

        def describe_security_groups(self, **kwargs):
            calls.append(("describe_security_groups", kwargs))
            return {"SecurityGroups": [{
                "GroupId": "sg-0123456789abcdef0",
                "VpcId": "vpc-0123456789abcdef0",
                "IpPermissions": [{"IpProtocol": "-1"}],
            }]}

    monkeypatch.setattr(cloud, "_client", lambda *_args, **_kwargs: Ec2())

    with pytest.raises(cloud.CloudError, match="must not allow inbound"):
        cloud._valid_network(object(), settings())
    assert [name for name, _ in calls] == ["describe_subnets", "describe_security_groups"]


def test_sdk_client_uses_bounded_timeouts_and_single_submit_attempt(monkeypatch):
    seen = {}

    class Session:
        def client(self, service, *, config):
            seen.update(service=service, config=config)
            return config

    config = cloud._client(Session(), "batch", attempts=1)

    assert seen["service"] == "batch"
    assert config.connect_timeout == 10
    assert config.read_timeout == 30
    assert config.retries["total_max_attempts"] == 1


def test_batch_roles_are_separate_and_job_role_is_limited_to_private_s3(monkeypatch):
    calls = []
    roles = {}
    profiles = {}

    class Iam:
        def get_role(self, *, RoleName):
            calls.append(("get_role", RoleName))
            if RoleName not in roles:
                raise AwsError("NoSuchEntity")
            return {"Role": roles[RoleName]}

        def create_role(self, **kwargs):
            calls.append(("create_role", kwargs))
            arn = f"arn:aws:iam::{ACCOUNT}:role/{kwargs['RoleName']}"
            roles[kwargs["RoleName"]] = {
                "Arn": arn,
                "AssumeRolePolicyDocument": json.loads(kwargs["AssumeRolePolicyDocument"]),
            }
            return {"Role": {"Arn": arn}}

        def list_attached_role_policies(self, **kwargs):
            calls.append(("list_attached_role_policies", kwargs))
            return {"AttachedPolicies": []}

        def attach_role_policy(self, **kwargs):
            calls.append(("attach_role_policy", kwargs))

        def get_role_policy(self, **kwargs):
            calls.append(("get_role_policy", kwargs))
            raise AwsError("NoSuchEntity")

        def put_role_policy(self, **kwargs):
            calls.append(("put_role_policy", kwargs))

        def get_instance_profile(self, *, InstanceProfileName):
            if InstanceProfileName not in profiles:
                raise AwsError("NoSuchEntity")
            return {"InstanceProfile": profiles[InstanceProfileName]}

        def create_instance_profile(self, *, InstanceProfileName):
            profile = {
                "Arn": f"arn:aws:iam::{ACCOUNT}:instance-profile/{InstanceProfileName}",
                "Roles": [],
            }
            profiles[InstanceProfileName] = profile
            return {"InstanceProfile": profile}

        def add_role_to_instance_profile(self, *, InstanceProfileName, RoleName):
            calls.append(("add_role_to_instance_profile", (InstanceProfileName, RoleName)))
            profiles[InstanceProfileName]["Roles"].append({"RoleName": RoleName})

    monkeypatch.setattr(cloud, "_client", lambda *_args, **_kwargs: Iam())
    values = settings()
    role_names = cloud._ensure_roles(object(), values, ACCOUNT)

    assert role_names == (
        "MizanBatchJobRole", "MizanBatchExecutionRole",
        "AWSBatchServiceRole", "ecsInstanceRole",
    )
    assert values["role"] == ROLE
    assert values["executionRole"] == EXECUTION_ROLE
    assert values["serviceRole"] == SERVICE_ROLE
    assert values["instanceRole"] == INSTANCE_ROLE
    trust = {name: roles[name]["AssumeRolePolicyDocument"]["Statement"][0]["Principal"]["Service"]
             for name in roles}
    assert trust == {
        "MizanBatchJobRole": "ecs-tasks.amazonaws.com",
        "MizanBatchExecutionRole": "ecs-tasks.amazonaws.com",
        "AWSBatchServiceRole": "batch.amazonaws.com",
        "ecsInstanceRole": "ec2.amazonaws.com",
    }
    job_policy = json.loads(next(
        call[1]["PolicyDocument"] for call in calls
        if call[0] == "put_role_policy" and call[1]["RoleName"] == "MizanBatchJobRole"))
    assert all("s3:" in str(statement["Action"]) for statement in job_policy["Statement"])
    assert all("secretsmanager:" not in str(statement["Action"])
               for statement in job_policy["Statement"])
    assert any(call[0] == "add_role_to_instance_profile" for call in calls)


def test_cleanup_uses_frozen_aws_profile_and_bucket(monkeypatch):
    pinned = settings(profile="original-profile", bucket="original-private-bucket")
    target = {"version": 1, "provider": "aws", "settings": pinned}
    used = {}

    class Files:
        def __init__(self, session, bucket):
            used.update(bucket=bucket)

        def delete(self, names):
            used["names"] = names

    monkeypatch.setattr(cloud, "_saved_settings",
                        lambda: pytest.fail("cleanup must not read the active AWS profile"))
    monkeypatch.setattr(cloud, "_target_config",
                        lambda value: cloud._validate_settings(value["settings"]))
    monkeypatch.setattr(cloud, "_expected_settings",
                        lambda values: (used.update(profile=values["profile"])
                                        or values, object(), {"accountId": ACCOUNT}))
    monkeypatch.setattr(cloud, "_S3Files", Files)

    cloud.cleanup(NAMES, target=target)

    assert used["profile"] == "original-profile"
    assert used["bucket"] == "original-private-bucket"
    assert used["names"] == NAMES
