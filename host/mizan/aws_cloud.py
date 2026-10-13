"""AWS Batch and private S3 implementation of the cloud worker contract."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
import re
import time
from pathlib import Path
from threading import Event
from urllib.parse import unquote
from uuid import uuid4

from .cloud import (
    CloudError as BaseCloudError,
    _setting,
    load_provider_settings,
    save_provider_settings,
)
from .cloud_result import (
    MAX_AUDIO_BYTES,
    MAX_WORKER_ERROR_BYTES,
    STEMS,
    materialize as _materialize,
    validate_worker_error,
)
from .cloud_transport import MODEL_EXECUTION_BUDGETS
from .errors import Cancelled
from .cloud_state import CloudOperations

logger = logging.getLogger(__name__)

PROVIDER = "aws"
JOB_TIMEOUT_SECONDS = 2 * 60 * 60
POLL_INTERVAL = 5
SETUP_TIMEOUT_SECONDS = 30 * 60
INSTANCE_TYPE = "g5.4xlarge"
INSTANCE_GPU_MEMORY_GIB = 24
INSTANCE_VCPUS = 16
# Reserve 4 GiB of the instance's 64 GiB for ECS and host processes.
INSTANCE_HOST_MEMORY_RESERVE_GIB = 4
INSTANCE_MEMORY_MIB = (64 - INSTANCE_HOST_MEMORY_RESERVE_GIB) * 1024
TERMINAL_STATES = {"SUCCEEDED", "FAILED"}
STOPPED_STATES = TERMINAL_STATES
WAITING_STATES = {"SUBMITTED", "PENDING", "RUNNABLE"}
RUNNING_STATES = {"STARTING", "RUNNING"}
AWS_FIELDS = (
    "profile", "region", "accountId", "bucket", "computeEnvironment",
    "jobQueue", "jobDefinition", "role", "subnetIds", "securityGroupIds", "image",
)
AWS_INTERNAL_FIELDS = (
    "executionRole", "serviceRole", "instanceRole", "hfSecretArn", "vpcId",
    "routeTableId", "internetGatewayId",
)
AWS_ALLOWED_FIELDS = set(AWS_FIELDS + AWS_INTERNAL_FIELDS + ("provider", "sourceHash"))
_SECRET_PATTERN = re.compile(
    r"(?i)\b(?:hf_[A-Za-z0-9_-]{10,}|(?:aws_)?(?:access|secret)[_-]?key(?:[_-]?id)?|"
    r"session[_-]?token|authorization|bearer)\b\s*[=:]?\s*\S+"
)
_SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}\Z")
_BATCH_JOB_ID = re.compile(r"[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\Z")
_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")
_BUCKET = re.compile(r"(?!xn--)(?!sthree-)(?!amzn_s3_demo_)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\Z")


class CloudError(BaseCloudError):
    code = "cloud_failed"
    message = "AWS cloud processing failed."


state = CloudOperations(PROVIDER)


def _uses_nvidia_ecs_ami(resources):
    configuration = resources.get("ec2Configuration") if isinstance(resources, dict) else None
    return (
        isinstance(configuration, list)
        and len(configuration) == 1
        and isinstance(configuration[0], dict)
        and configuration[0].get("imageType") == "ECS_AL2023_NVIDIA"
        and not configuration[0].get("imageIdOverride")
    )


def setup_progress():
    return state.setup_progress()


def track_setup(operation, total):
    return state.track_setup(operation, total)


def cancel_setup():
    return state.cancel_setup()


def readiness_progress(request_id):
    return state.readiness_progress(request_id)


def cancel_panel_status(request_id):
    return state.cancel_panel_status(request_id)


def _step(stage, completed, detail):
    _check_cancelled()
    state.step(stage, completed, detail)


def _check_cancelled():
    state.check_cancelled()


def _safe_text(value):
    text = str(value or "")
    text = _SECRET_PATTERN.sub("[redacted]", text)
    text = re.sub(r"https?://\S+", "[redacted URL]", text)
    return text[:300]


def _aws_error(action, exc):
    response = getattr(exc, "response", None)
    error = response.get("Error", {}) if isinstance(response, dict) else {}
    code = error.get("Code") if isinstance(error, dict) else None
    code = code if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", code) else None
    if code in {
        "ExpiredToken", "ExpiredTokenException", "InvalidClientTokenId",
        "UnrecognizedClientException", "TokenRefreshRequired",
    }:
        return CloudError("AWS credentials expired or are invalid for the selected profile. "
                          "Refresh the profile and retry.")
    if code in {"AccessDenied", "AccessDeniedException", "UnauthorizedOperation"}:
        return CloudError(f"AWS denied {action}. Check the selected profile's IAM permissions.")
    if code in {
        "VcpuLimitExceeded", "ServiceQuotaExceededException", "LimitExceededException",
        "InsufficientInstanceCapacity", "InstanceLimitExceeded",
    }:
        return CloudError(f"AWS quota or capacity blocked {action} ({code}). "
                          "Request quota or GPU capacity in the selected region.")
    message = error.get("Message") if isinstance(error, dict) else None
    detail = _safe_text(message)
    suffix = f" ({code})" if code else ""
    return CloudError(f"AWS {action} failed{suffix}."
                      + (f" {detail}" if detail else " Check the selected profile and region."))


def _aws_call(client, method, action, **kwargs):
    try:
        return getattr(client, method)(**kwargs)
    except CloudError:
        raise
    except Exception as exc:
        raise _aws_error(action, exc) from None


def _client(session, name, *, attempts=2):
    import boto3
    from botocore.config import Config

    return session.client(
        name,
        config=Config(
            connect_timeout=10,
            read_timeout=30,
            retries={"mode": "standard", "total_max_attempts": attempts},
        ),
    )


def _session(settings):
    import boto3
    from botocore.exceptions import ProfileNotFound

    try:
        return boto3.Session(profile_name=settings["profile"], region_name=settings["region"])
    except ProfileNotFound:
        raise CloudError("The selected AWS credential profile was not found. "
                         "Select a configured profile and refresh its credentials.") from None


def _identity(session):
    result = _aws_call(_client(session, "sts"), "get_caller_identity",
                       "confirm the selected AWS account")
    account = result.get("Account") if isinstance(result, dict) else None
    arn = result.get("Arn") if isinstance(result, dict) else None
    if not isinstance(account, str) or not re.fullmatch(r"\d{12}", account) \
            or not isinstance(arn, str) or not arn.startswith(f"arn:aws:"):
        raise CloudError("AWS STS returned an invalid account identity.")
    return {"accountId": account, "arn": arn,
            "userId": result.get("UserId") if isinstance(result.get("UserId"), str) else None}


def _validate_settings(config):
    if not isinstance(config, dict):
        raise CloudError("Enter the AWS profile, region, bucket, Batch resources and network IDs.")
    if config.get("provider", PROVIDER) != PROVIDER:
        raise CloudError("AWS settings have a mismatched provider ID.")
    unknown = set(config) - AWS_ALLOWED_FIELDS
    if unknown:
        raise CloudError("AWS settings contain unsupported fields.")
    values = {key: config[key] for key in config if key in AWS_ALLOWED_FIELDS}
    for key in ("profile", "region", "accountId", "bucket", "computeEnvironment",
                "jobQueue", "jobDefinition", "role"):
        value = values.get(key)
        if not isinstance(value, str) or not value or value != value.strip():
            raise CloudError(f"Enter a valid AWS {key}.")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", values["profile"]):
        raise CloudError("Enter a valid AWS credential profile name.")
    if not re.fullmatch(r"[a-z]{2}(?:-gov)?-[a-z]+-\d", values["region"]):
        raise CloudError("Enter a valid AWS region.")
    if not re.fullmatch(r"\d{12}", values["accountId"]):
        raise CloudError("Enter the 12-digit AWS account ID shown by the selected profile.")
    bucket = values["bucket"]
    if (not _BUCKET.fullmatch(bucket) or ".." in bucket or ".-" in bucket or "-." in bucket
            or re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", bucket)):
        raise CloudError("Enter a valid globally unique S3 bucket name.")
    for key in ("computeEnvironment", "jobQueue"):
        if not _NAME.fullmatch(values[key]):
            raise CloudError(f"Enter a valid AWS {key} name.")
    if (not _NAME.fullmatch(values["jobDefinition"])
            and not re.fullmatch(
                r"arn:aws:batch:[a-z0-9-]+:\d{12}:job-definition/[A-Za-z0-9_-]{1,128}:\d+",
                values["jobDefinition"])):
        raise CloudError("Enter a valid AWS job definition name or revision ARN.")
    if (not re.fullmatch(r"[A-Za-z0-9+=,.@_-]{1,64}", values["role"])
            and not re.fullmatch(
                r"arn:aws:iam::\d{12}:role/[A-Za-z0-9+=,.@_/-]{1,512}", values["role"])):
        raise CloudError("Enter a valid AWS Batch job role name.")
    for key, pattern in (("subnetIds", r"subnet-[0-9a-f]{8,17}"),
                         ("securityGroupIds", r"sg-[0-9a-f]{8,17}")):
        selectors = values.get(key, [])
        if (not isinstance(selectors, list) or len(selectors) > 16 or any(
                not isinstance(item, str) or not re.fullmatch(pattern, item)
                for item in selectors)
                or len(set(selectors)) != len(selectors)):
            raise CloudError(f"Enter valid AWS {key} values.")
        values[key] = selectors
    if bool(values["subnetIds"]) != bool(values["securityGroupIds"]):
        raise CloudError("Enter both AWS subnet and security group IDs, or leave both empty "
                         "to create a private worker network during approved setup.")
    if values.get("image") not in (None, "") and not isinstance(values["image"], str):
        raise CloudError("AWS worker image must be an immutable public GHCR reference.")
    for key in ("executionRole", "serviceRole"):
        value = values.get(key)
        if value is not None and (
                not isinstance(value, str)
                or (value.startswith("arn:") and not re.fullmatch(
                    rf"arn:aws:iam::{values['accountId']}:role/[A-Za-z0-9+=,.@_/-]{{1,512}}",
                    value))
                or (not value.startswith("arn:") and not re.fullmatch(
                    r"[A-Za-z0-9+=,.@_-]{1,64}", value))):
            raise CloudError(f"Saved AWS {key} reference is invalid.")
    instance_role = values.get("instanceRole")
    if instance_role is not None and (
            not isinstance(instance_role, str)
            or (instance_role.startswith("arn:") and not re.fullmatch(
                rf"arn:aws:iam::{values['accountId']}:instance-profile/"
                r"[A-Za-z0-9+=,.@_/-]{1,512}", instance_role))
            or (not instance_role.startswith("arn:") and not re.fullmatch(
                r"[A-Za-z0-9+=,.@_-]{1,64}", instance_role))):
        raise CloudError("Saved AWS instanceRole reference is invalid.")
    secret_arn = values.get("hfSecretArn")
    if secret_arn is not None and (
            not isinstance(secret_arn, str)
            or not re.fullmatch(
                rf"arn:aws:secretsmanager:{re.escape(values['region'])}:"
                rf"{values['accountId']}:secret:[A-Za-z0-9/_+=.@-]{{1,512}}",
                secret_arn)):
        raise CloudError("Saved AWS HF_TOKEN secret reference is invalid.")
    for key, pattern in (("vpcId", r"vpc-[0-9a-f]{8,17}"),
                         ("routeTableId", r"rtb-[0-9a-f]{8,17}"),
                         ("internetGatewayId", r"igw-[0-9a-f]{8,17}")):
        if key in values and (not isinstance(values[key], str)
                              or not re.fullmatch(pattern, values[key])):
            raise CloudError(f"Saved AWS {key} reference is invalid.")
    if "sourceHash" in values and (
            not isinstance(values["sourceHash"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", values["sourceHash"])):
        raise CloudError("Saved AWS worker source hash is invalid.")
    values["provider"] = PROVIDER
    return values


def _public_config(values):
    return {key: value for key, value in values.items()
            if key != "provider"}


def _saved_settings():
    try:
        values = load_provider_settings(PROVIDER)
        if not values:
            raise CloudError("Select an AWS profile, region, S3 bucket and Batch resources.")
        return _validate_settings(values)
    except BaseCloudError:
        raise
    except Exception as exc:
        raise CloudError("Saved AWS settings are invalid.") from None


def _job_role_name(value):
    if value.startswith("arn:"):
        match = re.fullmatch(r"arn:aws:iam::(\d{12}):role/(.+)", value)
        if not match or not re.fullmatch(r"[A-Za-z0-9+=,.@_/-]{1,512}", match[2]):
            raise CloudError("The AWS Batch job role ARN is invalid.")
        return match[2].rsplit("/", 1)[-1]
    return value


def _role_arn(account, role):
    if isinstance(role, str) and role.startswith("arn:"):
        if not role.startswith(f"arn:aws:iam::{account}:role/"):
            raise CloudError("AWS role belongs to a different account.")
        return role
    return f"arn:aws:iam::{account}:role/{role}"


def _role_name(role):
    return role.rsplit("/", 1)[-1] if isinstance(role, str) and role.startswith("arn:") else role


def _job_definition_name(value):
    match = re.fullmatch(
        r"arn:aws:batch:[a-z0-9-]+:\d{12}:job-definition/([A-Za-z0-9_-]{1,128}):\d+",
        value,
    ) if isinstance(value, str) else None
    return match[1] if match else value


def _target_config(target):
    if target is None:
        values = _saved_settings()
    else:
        if (not isinstance(target, dict) or target.get("version") != 1
                or target.get("provider") != PROVIDER
                or not isinstance(target.get("settings"), dict)):
            raise CloudError("Queued AWS resource target is invalid or has a mismatched provider.")
        values = _validate_settings(target["settings"])
    if not values.get("image"):
        raise CloudError("Verify the public shared worker image before using AWS Batch.")
    values["role"] = _role_arn(values["accountId"], values["role"])
    return values


def _verify_image(image):
    from .cloud_image import CloudImageError, verify_image

    try:
        verified = verify_image(image)
    except CloudImageError as exc:
        raise CloudError(str(exc)) from None
    if (not isinstance(verified, dict) or verified.get("image") != image
            or not isinstance(verified.get("digest"), str)
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", verified["digest"])
            or not isinstance(verified.get("sourceHash"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", verified["sourceHash"])):
        raise CloudError("The shared image verifier returned an invalid AWS worker identity.")
    return verified


def _model_resources(model):
    if not isinstance(model, str):
        raise CloudError("The selected AWS transcription model is invalid.")
    budget = MODEL_EXECUTION_BUDGETS.get(model)
    from .engine.muscriptor import MODELS

    model_info = MODELS.get(model)
    gpu_memory = model_info.get("freeGiB") if isinstance(model_info, dict) else None
    if (budget is None or gpu_memory is None or budget[0] > INSTANCE_VCPUS
            or budget[1] * 1024 > INSTANCE_MEMORY_MIB
            or gpu_memory > INSTANCE_GPU_MEMORY_GIB):
        raise CloudError(f"AWS Batch does not have a supported GPU allocation for {model}.")
    return budget


def _expected_role_name(values, key, fallback):
    return values.get(key) or fallback


def _role_policy(session, role_name, policy_name, policy):
    iam = _client(session, "iam")
    try:
        current = _aws_call(
            iam, "get_role_policy", "inspect the AWS Batch role policy",
            RoleName=role_name, PolicyName=policy_name)
    except CloudError as exc:
        if "NoSuchEntity" not in str(exc):
            raise
    else:
        document = current.get("PolicyDocument") if isinstance(current, dict) else None
        if isinstance(document, str):
            try:
                document = json.loads(unquote(document))
            except json.JSONDecodeError:
                document = None
        if document != policy:
            raise CloudError(f"The existing AWS IAM policy {policy_name} differs from the "
                             "required Mizan permissions; it was not changed.")
        return
    _aws_call(
        iam, "put_role_policy", "grant the AWS Batch role its required private-resource access",
        RoleName=role_name, PolicyName=policy_name,
        PolicyDocument=json.dumps(policy, separators=(",", ":")))


def _ensure_role(session, account, name, service, *, managed_policy=None, inline=None):
    iam = _client(session, "iam")
    trust = {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow", "Principal": {"Service": service},
            "Action": "sts:AssumeRole",
        }],
    }
    try:
        result = _aws_call(iam, "get_role", "inspect the AWS Batch IAM role", RoleName=name)
        role = result.get("Role") if isinstance(result, dict) else None
        if not isinstance(role, dict) or not isinstance(role.get("Arn"), str):
            raise CloudError(f"AWS IAM returned an invalid {name} role.")
        trust_doc = role.get("AssumeRolePolicyDocument", {})
        principals = set()
        if isinstance(trust_doc, dict):
            for statement in trust_doc.get("Statement", []):
                principal = statement.get("Principal", {}).get("Service") \
                    if isinstance(statement, dict) and statement.get("Effect") == "Allow" else None
                principals.update(principal if isinstance(principal, list) else [principal])
        if principals != {service}:
            raise CloudError(f"The existing AWS role {name} has an incompatible trust policy; "
                             "Mizan did not change it.")
        arn = role["Arn"]
    except CloudError as exc:
        if "NoSuchEntity" not in str(exc):
            raise
        result = _aws_call(iam, "create_role", "create the AWS Batch IAM role",
                           RoleName=name, AssumeRolePolicyDocument=json.dumps(trust),
                           Description="Mizan AWS Batch cloud worker role")
        role = result.get("Role") if isinstance(result, dict) else None
        arn = role.get("Arn") if isinstance(role, dict) else None
        if not isinstance(arn, str):
            raise CloudError("AWS IAM accepted role creation but returned no role ARN.")
    if managed_policy:
        attached = _aws_call(iam, "list_attached_role_policies",
                             "inspect AWS Batch role permissions", RoleName=name)
        current = attached.get("AttachedPolicies", []) if isinstance(attached, dict) else []
        if not any(item.get("PolicyArn") == managed_policy for item in current if isinstance(item, dict)):
            _aws_call(iam, "attach_role_policy", "attach the AWS Batch service policy",
                      RoleName=name, PolicyArn=managed_policy)
    if inline:
        _role_policy(session, name, "MizanCloudAccess", inline)
    return arn


def _principal_arn(arn):
    match = re.fullmatch(r"arn:aws:sts::(\d{12}):assumed-role/(.+)/[^/]+", arn)
    if match:
        return f"arn:aws:iam::{match[1]}:role/{match[2]}"
    if re.fullmatch(r"arn:aws:iam::\d{12}:(?:user|role)/[A-Za-z0-9+=,.@_/-]+", arn):
        return arn
    return None


def _ensure_bucket_policy(session, bucket, account, identity_arn, job_role_arn):
    s3 = _client(session, "s3")
    if not job_role_arn.startswith(f"arn:aws:iam::{account}:role/"):
        raise CloudError("The AWS Batch job role belongs to a different account.")
    policy = {"Version": "2012-10-17", "Statement": []}
    try:
        response = _aws_call(s3, "get_bucket_policy", "inspect S3 access policy", Bucket=bucket)
        policy = json.loads(response.get("Policy", "{}"))
    except CloudError as exc:
        if "NoSuchBucketPolicy" not in str(exc):
            raise
    if not isinstance(policy, dict) or not isinstance(policy.get("Statement", []), list):
        raise CloudError("The existing S3 bucket policy is invalid; Mizan did not change it.")
    desktop_principal = _principal_arn(identity_arn)
    if desktop_principal and not desktop_principal.startswith(f"arn:aws:iam::{account}:"):
        raise CloudError("The selected AWS profile identity belongs to a different account.")
    if desktop_principal:
        additions = [
            ("MizanDesktopCloudFiles", desktop_principal),
            ("MizanBatchCloudFiles", job_role_arn),
        ]
        existing = {item.get("Sid"): item for item in policy["Statement"] if isinstance(item, dict)}
        for sid, principal in additions:
            statement = {
                "Sid": sid, "Effect": "Allow", "Principal": {"AWS": principal},
                "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
                "Resource": f"arn:aws:s3:::{bucket}/jobs/*",
            }
            if sid in existing:
                if existing[sid] != statement:
                    raise CloudError(f"The S3 bucket policy already uses {sid} for another purpose.")
            else:
                policy["Statement"].append(statement)
        list_statement = {
            "Sid": "MizanDesktopCloudFileList", "Effect": "Allow",
            "Principal": {"AWS": desktop_principal},
            "Action": "s3:ListBucket", "Resource": f"arn:aws:s3:::{bucket}",
            "Condition": {"StringLike": {"s3:prefix": ["jobs/*"]}},
        }
        existing = {item.get("Sid"): item for item in policy["Statement"] if isinstance(item, dict)}
        if "MizanDesktopCloudFileList" in existing:
            if existing["MizanDesktopCloudFileList"] != list_statement:
                raise CloudError("The S3 bucket policy already uses MizanDesktopCloudFileList "
                                 "for another purpose.")
        else:
            policy["Statement"].append(list_statement)
    if not any(item.get("Sid") == "MizanBatchCloudFiles"
               for item in policy["Statement"] if isinstance(item, dict)):
        policy["Statement"].append({
            "Sid": "MizanBatchCloudFiles", "Effect": "Allow",
            "Principal": {"AWS": job_role_arn},
            "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
            "Resource": f"arn:aws:s3:::{bucket}/jobs/*",
        })
    _aws_call(s3, "put_bucket_policy", "grant the AWS Batch job role private S3 access",
              Bucket=bucket, Policy=json.dumps(policy, separators=(",", ":")))


def _profile_key(values):
    return hashlib.sha256(
        f"{values['accountId']}\0{values['profile']}\0{values['bucket']}".encode()
    ).hexdigest()[:16]


def _network_tags(values, resource):
    return [
        {"Key": "mizan:managed-by", "Value": "Mizan"},
        {"Key": "mizan:profile-key", "Value": _profile_key(values)},
        {"Key": "Name", "Value": f"mizan-{resource}-{_profile_key(values)}"},
    ]


def _tag_filter(values):
    return [
        {"Name": "tag:mizan:managed-by", "Values": ["Mizan"]},
        {"Name": "tag:mizan:profile-key", "Values": [_profile_key(values)]},
    ]


def _one(items, label):
    if len(items) > 1:
        raise CloudError(f"More than one AWS {label} is tagged for this Mizan profile; "
                         "review the network in AWS before retrying.")
    return items[0] if items else None


def _created_network(session, values):
    ec2 = _client(session, "ec2")
    found = _aws_call(ec2, "describe_vpcs", "find the approved Mizan worker VPC",
                      Filters=_tag_filter(values))
    vpc = _one(found.get("Vpcs", []), "worker VPC")
    if vpc is None:
        all_vpcs = _aws_call(ec2, "describe_vpcs", "choose an unused private VPC range")
        used = []
        for item in all_vpcs.get("Vpcs", []):
            ranges = [item.get("CidrBlock")]
            ranges += [entry.get("CidrBlock") for entry in
                       item.get("CidrBlockAssociationSet", []) if isinstance(entry, dict)]
            for cidr in ranges:
                try:
                    used.append(ipaddress.ip_network(cidr))
                except (ValueError, TypeError):
                    pass
        cidr = next((
            ipaddress.ip_network(f"172.{octet}.0.0/16")
            for octet in range(16, 32)
            if not any(ipaddress.ip_network(f"172.{octet}.0.0/16").overlaps(item)
                       for item in used)
        ), None)
        if cidr is None:
            raise CloudError("AWS has no unused private /16 range for a new Mizan VPC.")
        created = _aws_call(
            ec2, "create_vpc", "create the AWS Batch worker VPC",
            CidrBlock=str(cidr),
            TagSpecifications=[{
                "ResourceType": "vpc", "Tags": _network_tags(values, "vpc"),
            }],
        )
        vpc = created.get("Vpc") if isinstance(created, dict) else None
        if not isinstance(vpc, dict) or not isinstance(vpc.get("VpcId"), str):
            raise CloudError("AWS accepted VPC creation but did not return its ID.")
    vpc_id = vpc["VpcId"]
    values["vpcId"] = vpc_id
    _aws_call(ec2, "modify_vpc_attribute", "enable DNS for the AWS worker VPC",
              VpcId=vpc_id, EnableDnsSupport={"Value": True})
    _aws_call(ec2, "modify_vpc_attribute", "enable DNS hostnames for the AWS worker VPC",
              VpcId=vpc_id, EnableDnsHostnames={"Value": True})

    gateways = _aws_call(ec2, "describe_internet_gateways",
                         "find the Mizan worker internet gateway",
                         Filters=_tag_filter(values))
    gateway = _one(gateways.get("InternetGateways", []), "internet gateway")
    if gateway is None:
        created = _aws_call(
            ec2, "create_internet_gateway", "create the worker internet gateway",
            TagSpecifications=[{
                "ResourceType": "internet-gateway",
                "Tags": _network_tags(values, "internet"),
            }],
        )
        gateway = created.get("InternetGateway") if isinstance(created, dict) else None
        if not isinstance(gateway, dict) or not isinstance(gateway.get("InternetGatewayId"), str):
            raise CloudError("AWS accepted internet gateway creation but returned no ID.")
    gateway_id = gateway["InternetGatewayId"]
    values["internetGatewayId"] = gateway_id
    if not any(item.get("VpcId") == vpc_id for item in gateway.get("Attachments", [])):
        _aws_call(ec2, "attach_internet_gateway", "attach the worker internet gateway",
                  InternetGatewayId=gateway_id, VpcId=vpc_id)

    zone_response = _aws_call(
        ec2, "describe_availability_zones", "select an AWS Batch availability zone",
        Filters=[{"Name": "state", "Values": ["available"]}],
    )
    zones = sorted(item["ZoneName"] for item in zone_response.get("AvailabilityZones", [])
                   if isinstance(item, dict) and isinstance(item.get("ZoneName"), str))
    if not zones:
        raise CloudError("AWS returned no available zone for the worker subnet.")
    subnets = _aws_call(ec2, "describe_subnets", "find the Mizan worker subnet",
                        Filters=[{"Name": "vpc-id", "Values": [vpc_id]}, *_tag_filter(values)])
    subnet = _one(subnets.get("Subnets", []), "worker subnet")
    if subnet is None:
        vpc_network = ipaddress.ip_network(vpc["CidrBlock"])
        subnet_cidr = next(vpc_network.subnets(new_prefix=24), None)
        if subnet_cidr is None:
            raise CloudError("AWS returned a VPC too small for the worker subnet.")
        created = _aws_call(
            ec2, "create_subnet", "create the AWS Batch worker subnet",
            VpcId=vpc_id, CidrBlock=str(subnet_cidr), AvailabilityZone=zones[0],
            TagSpecifications=[{
                "ResourceType": "subnet", "Tags": _network_tags(values, "subnet"),
            }],
        )
        subnet = created.get("Subnet") if isinstance(created, dict) else None
        if not isinstance(subnet, dict) or not isinstance(subnet.get("SubnetId"), str):
            raise CloudError("AWS accepted subnet creation but returned no subnet ID.")
    subnet_id = subnet["SubnetId"]
    values["subnetIds"] = [subnet_id]
    _aws_call(ec2, "modify_subnet_attribute", "enable public IPv4 for AWS Batch",
              SubnetId=subnet_id, MapPublicIpOnLaunch={"Value": True})

    tables = _aws_call(ec2, "describe_route_tables", "find the Mizan worker route table",
                       Filters=[{"Name": "vpc-id", "Values": [vpc_id]}, *_tag_filter(values)])
    table = _one(tables.get("RouteTables", []), "worker route table")
    if table is None:
        created = _aws_call(
            ec2, "create_route_table", "create the AWS Batch route table", VpcId=vpc_id,
            TagSpecifications=[{
                "ResourceType": "route-table", "Tags": _network_tags(values, "route"),
            }],
        )
        table = created.get("RouteTable") if isinstance(created, dict) else None
        if not isinstance(table, dict) or not isinstance(table.get("RouteTableId"), str):
            raise CloudError("AWS accepted route table creation but returned no ID.")
    table_id = table["RouteTableId"]
    values["routeTableId"] = table_id
    route = next((item for item in table.get("Routes", [])
                  if item.get("DestinationCidrBlock") == "0.0.0.0/0"), None)
    if route is None:
        _aws_call(ec2, "create_route", "route the worker subnet to the internet gateway",
                  RouteTableId=table_id, DestinationCidrBlock="0.0.0.0/0",
                  GatewayId=gateway_id)
    elif route.get("GatewayId") != gateway_id:
        raise CloudError("The Mizan worker route table has a conflicting default route.")
    associated = any(item.get("SubnetId") == subnet_id
                     for item in table.get("Associations", []) if isinstance(item, dict))
    if not associated:
        _aws_call(ec2, "associate_route_table", "associate the worker subnet route table",
                  RouteTableId=table_id, SubnetId=subnet_id)

    groups = _aws_call(ec2, "describe_security_groups",
                       "find the Mizan worker security group",
                       Filters=[{"Name": "vpc-id", "Values": [vpc_id]}, *_tag_filter(values)])
    group = _one(groups.get("SecurityGroups", []), "worker security group")
    if group is None:
        created = _aws_call(
            ec2, "create_security_group", "create the AWS Batch worker security group",
            GroupName=f"mizan-{_profile_key(values)}",
            Description="Mizan AWS Batch worker HTTPS egress only",
            VpcId=vpc_id,
            TagSpecifications=[{
                "ResourceType": "security-group", "Tags": _network_tags(values, "security"),
            }],
        )
        group_id = created.get("GroupId") if isinstance(created, dict) else None
        if not isinstance(group_id, str):
            raise CloudError("AWS accepted security group creation but returned no ID.")
        described = _aws_call(ec2, "describe_security_groups",
                              "inspect the created worker security group",
                              GroupIds=[group_id])
        group_rows = described.get("SecurityGroups", []) if isinstance(described, dict) else []
        if len(group_rows) != 1:
            raise CloudError("AWS created a worker security group but did not return its settings.")
        group = group_rows[0]
    group_id = group["GroupId"]
    expected_egress = {
        "IpProtocol": "tcp", "FromPort": 443, "ToPort": 443,
        "IpRanges": [{"CidrIp": "0.0.0.0/0", "Description": "HTTPS for worker image and models"}],
    }
    current_egress = group.get("IpPermissionsEgress", [])
    has_expected = any(
        permission.get("IpProtocol") == "tcp"
        and permission.get("FromPort") == 443 and permission.get("ToPort") == 443
        and len(permission.get("IpRanges", [])) == 1
        and permission["IpRanges"][0].get("CidrIp") == "0.0.0.0/0"
        and not any(permission.get(key) for key in ("Ipv6Ranges", "PrefixListIds", "UserIdGroupPairs"))
        for permission in current_egress if isinstance(permission, dict)
    )
    for permission in current_egress:
        if not isinstance(permission, dict):
            continue
        matching = (
            permission.get("IpProtocol") == "tcp"
            and permission.get("FromPort") == 443 and permission.get("ToPort") == 443
            and any(item.get("CidrIp") == "0.0.0.0/0"
                    for item in permission.get("IpRanges", []) if isinstance(item, dict))
        )
        if matching:
            continue
        revocation = {key: permission[key] for key in (
            "IpProtocol", "FromPort", "ToPort", "IpRanges", "Ipv6Ranges",
            "PrefixListIds", "UserIdGroupPairs",
        ) if key in permission}
        if revocation:
            _aws_call(ec2, "revoke_security_group_egress",
                      "restrict worker security group egress",
                      GroupId=group_id, IpPermissions=[revocation])
    if not has_expected:
        _aws_call(
            ec2, "authorize_security_group_egress", "allow worker HTTPS egress",
            GroupId=group_id, IpPermissions=[expected_egress],
        )
    values["securityGroupIds"] = [group_id]
    return _valid_network(session, values)


def _ensure_bucket(session, values, identity):
    s3 = _client(session, "s3")
    bucket, region = values["bucket"], values["region"]
    try:
        _aws_call(s3, "head_bucket", "check the selected S3 bucket", Bucket=bucket)
    except CloudError as exc:
        if not any(code in str(exc) for code in ("404", "NoSuchBucket", "NotFound")):
            raise
        create = {"Bucket": bucket}
        if region != "us-east-1":
            create["CreateBucketConfiguration"] = {"LocationConstraint": region}
        _aws_call(s3, "create_bucket", "create the private S3 bucket", **create)
    location = _aws_call(s3, "get_bucket_location", "confirm the S3 bucket region", Bucket=bucket)
    actual_region = location.get("LocationConstraint") if isinstance(location, dict) else None
    actual_region = actual_region or "us-east-1"
    if actual_region != region:
        raise CloudError("The selected S3 bucket is in a different region; choose a bucket in "
                         "the AWS Batch region.")
    _aws_call(
        s3, "put_public_access_block", "block public S3 access", Bucket=bucket,
        PublicAccessBlockConfiguration={
            "BlockPublicAcls": True, "IgnorePublicAcls": True,
            "BlockPublicPolicy": True, "RestrictPublicBuckets": True,
        },
    )
    _aws_call(
        s3, "put_bucket_ownership_controls", "enforce private S3 bucket ownership",
        Bucket=bucket,
        OwnershipControls={"Rules": [{"ObjectOwnership": "BucketOwnerEnforced"}]},
    )
    _aws_call(
        s3, "put_bucket_encryption", "enable S3 encryption", Bucket=bucket,
        ServerSideEncryptionConfiguration={"Rules": [{
            "ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"},
        }]},
    )


def _valid_network(session, values):
    ec2 = _client(session, "ec2")
    subnets = _aws_call(ec2, "describe_subnets", "check the selected AWS subnets",
                        SubnetIds=values["subnetIds"])
    rows = subnets.get("Subnets", []) if isinstance(subnets, dict) else []
    if (len(rows) != len(values["subnetIds"])
            or any(row.get("State") != "available" or not isinstance(row.get("VpcId"), str)
                   for row in rows)):
        raise CloudError("Choose available AWS subnets in the selected region.")
    vpcs = {row["VpcId"] for row in rows}
    if len(vpcs) != 1:
        raise CloudError("AWS Batch subnets and security groups must use one VPC.")
    vpc = next(iter(vpcs))
    values["vpcId"] = vpc
    groups = _aws_call(ec2, "describe_security_groups",
                       "check the selected AWS security groups",
                       GroupIds=values["securityGroupIds"])
    group_rows = groups.get("SecurityGroups", []) if isinstance(groups, dict) else []
    if (len(group_rows) != len(values["securityGroupIds"])
            or any(group.get("VpcId") != vpc for group in group_rows)):
        raise CloudError("Choose security groups in the same VPC as the selected subnets.")
    for group in group_rows:
        if group.get("IpPermissions"):
            raise CloudError("The AWS Batch security group must not allow inbound traffic; "
                             "the worker needs outbound HTTPS only.")
        egress = group.get("IpPermissionsEgress", [])
        https = any(
            (permission.get("IpProtocol") == "-1"
             or (permission.get("IpProtocol") == "tcp"
                 and (permission.get("FromPort") or 0) <= 443
                 and (permission.get("ToPort") or 0) >= 443))
            and (any(item.get("CidrIp") == "0.0.0.0/0"
                     for item in permission.get("IpRanges", []) if isinstance(item, dict))
                 or any(item.get("CidrIpv6") == "::/0"
                        for item in permission.get("Ipv6Ranges", []) if isinstance(item, dict)))
            for permission in egress if isinstance(permission, dict)
        )
        if not https:
            raise CloudError("The AWS Batch security group must allow outbound HTTPS for the "
                             "public image and model downloads.")
    routes = _aws_call(
        ec2, "describe_route_tables", "check AWS subnet internet routes",
        Filters=[{"Name": "association.subnet-id", "Values": values["subnetIds"]}],
    )
    route_tables = routes.get("RouteTables", []) if isinstance(routes, dict) else []
    by_subnet = {}
    for table in route_tables:
        for association in table.get("Associations", []):
            subnet_id = association.get("SubnetId")
            if subnet_id:
                by_subnet[subnet_id] = table.get("Routes", [])
    missing = [item for item in values["subnetIds"] if item not in by_subnet]
    if missing:
        main_tables = _aws_call(
            ec2, "describe_route_tables", "check AWS VPC internet routes",
            Filters=[{"Name": "vpc-id", "Values": [vpc]},
                     {"Name": "association.main", "Values": ["true"]}],
        )
        main = (main_tables.get("RouteTables", []) if isinstance(main_tables, dict) else [])
        if len(main) == 1:
            for subnet_id in missing:
                by_subnet[subnet_id] = main[0].get("Routes", [])
    for subnet_id in values["subnetIds"]:
        routes = by_subnet.get(subnet_id, [])
        internet = any(
            route.get("DestinationCidrBlock") == "0.0.0.0/0"
            and (str(route.get("GatewayId", "")).startswith("igw-")
                 or str(route.get("NatGatewayId", "")).startswith("nat-"))
            and route.get("State", "active") == "active"
            for route in routes if isinstance(route, dict)
        )
        if not internet:
            raise CloudError(f"AWS subnet {subnet_id} needs an active internet or NAT route "
                             "for the image and pinned model downloads.")
    return vpc


def _ensure_roles(session, values, account):
    iam = _client(session, "iam")
    role_name = _job_role_name(values["role"])
    execution_name = _role_name(values.get("executionRole") or "MizanBatchExecutionRole")
    service_name = _role_name(values.get("serviceRole") or "AWSBatchServiceRole")
    instance_name = _role_name(values.get("instanceRole") or "ecsInstanceRole")
    job_arn = _role_arn(account, role_name)
    s3_policy = {
        "Version": "2012-10-17",
        "Statement": [
            {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
             "Resource": f"arn:aws:s3:::{values['bucket']}/jobs/*"},
            {"Effect": "Allow", "Action": "s3:ListBucket",
             "Resource": f"arn:aws:s3:::{values['bucket']}",
             "Condition": {"StringLike": {"s3:prefix": ["jobs/*"]}}},
        ],
    }
    job_arn = _ensure_role(
        session, account, role_name, "ecs-tasks.amazonaws.com", inline=s3_policy)
    execution_arn = _ensure_role(
        session, account, execution_name, "ecs-tasks.amazonaws.com",
        managed_policy="arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy")
    service_arn = _ensure_role(
        session, account, service_name, "batch.amazonaws.com",
        managed_policy="arn:aws:iam::aws:policy/service-role/AWSBatchServiceRole")
    instance_arn = _ensure_role(
        session, account, instance_name, "ec2.amazonaws.com",
        managed_policy="arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role")
    try:
        profile = _aws_call(iam, "get_instance_profile",
                            "inspect the AWS Batch EC2 instance profile",
                            InstanceProfileName=instance_name)
        instance_profile = profile.get("InstanceProfile") if isinstance(profile, dict) else None
    except CloudError as exc:
        if "NoSuchEntity" not in str(exc):
            raise
        profile = _aws_call(iam, "create_instance_profile",
                            "create the AWS Batch EC2 instance profile",
                            InstanceProfileName=instance_name)
        instance_profile = profile.get("InstanceProfile") if isinstance(profile, dict) else None
    if not isinstance(instance_profile, dict) or not isinstance(instance_profile.get("Arn"), str):
        raise CloudError("AWS IAM returned an invalid EC2 instance profile.")
    roles = instance_profile.get("Roles", [])
    if not any(item.get("RoleName") == instance_name for item in roles if isinstance(item, dict)):
        if roles:
            raise CloudError("The existing AWS EC2 instance profile has a different role; "
                             "Mizan did not change it.")
        _aws_call(iam, "add_role_to_instance_profile",
                  "add the AWS Batch EC2 role to its instance profile",
                  InstanceProfileName=instance_name, RoleName=instance_name)
    values.update({
        "role": job_arn, "executionRole": execution_arn,
        "serviceRole": service_arn, "instanceRole": instance_profile["Arn"],
    })
    return role_name, execution_name, service_name, instance_name


def _create_compute_environment(session, values):
    batch = _client(session, "batch")
    name = values["computeEnvironment"]
    described = _aws_call(batch, "describe_compute_environments",
                          "inspect the AWS Batch compute environment",
                          computeEnvironments=[name])
    environments = described.get("computeEnvironments", []) if isinstance(described, dict) else []
    if environments:
        environment = environments[0]
        resources = environment.get("computeResources", {})
        if (environment.get("type") != "MANAGED"
                or environment.get("serviceRole") != values["serviceRole"]
                or resources.get("type") != "EC2"
                or resources.get("minvCpus") != 0
                or resources.get("maxvCpus", 0) < INSTANCE_VCPUS
                or resources.get("instanceTypes") != [INSTANCE_TYPE]
                or set(resources.get("subnets", [])) != set(values["subnetIds"])
                or set(resources.get("securityGroupIds", [])) != set(values["securityGroupIds"])
                or not _uses_nvidia_ecs_ami(resources)
                or resources.get("allocationStrategy") != "BEST_FIT_PROGRESSIVE"
                or resources.get("instanceRole") != values["instanceRole"]):
            raise CloudError("The existing AWS Batch compute environment is incompatible; "
                             "Mizan did not change it.")
    else:
        _aws_call(
            batch, "create_compute_environment", "create AWS Batch GPU compute",
            computeEnvironmentName=name, type="MANAGED", state="ENABLED",
            serviceRole=values["serviceRole"],
            computeResources={
                "type": "EC2", "allocationStrategy": "BEST_FIT_PROGRESSIVE",
                "minvCpus": 0, "maxvCpus": INSTANCE_VCPUS, "desiredvCpus": 0,
                "instanceTypes": [INSTANCE_TYPE],
                "subnets": values["subnetIds"],
                "securityGroupIds": values["securityGroupIds"],
                "instanceRole": values["instanceRole"],
                "ec2Configuration": [{"imageType": "ECS_AL2023_NVIDIA"}],
            },
        )
    return _wait_compute_environment(session, name)


def _wait_compute_environment(session, name, cancelled=None):
    deadline = time.monotonic() + SETUP_TIMEOUT_SECONDS
    batch = _client(session, "batch")
    while time.monotonic() < deadline:
        _check_cancelled()
        if cancelled is not None and cancelled.is_set():
            raise Cancelled()
        response = _aws_call(batch, "describe_compute_environments",
                             "wait for AWS Batch GPU compute",
                             computeEnvironments=[name])
        items = response.get("computeEnvironments", []) if isinstance(response, dict) else []
        if not items:
            raise CloudError("AWS Batch accepted compute setup but did not return its environment.")
        status = items[0].get("status")
        if status == "VALID":
            return items[0]
        if status == "INVALID":
            reason = _safe_text(items[0].get("statusReason"))
            raise CloudError("AWS Batch GPU compute could not start. "
                             + (reason or "Check GPU quota, IAM and selected subnet capacity."))
        if status not in ("CREATING", "UPDATING", "DELETING"):
            raise CloudError("AWS Batch returned an unknown compute environment state.")
        if cancelled is not None:
            if cancelled.wait(min(POLL_INTERVAL, max(0, deadline - time.monotonic()))):
                raise Cancelled()
        else:
            time.sleep(min(POLL_INTERVAL, max(0, deadline - time.monotonic())))
    raise CloudError("AWS Batch GPU compute did not become ready within 30 minutes. "
                     "Inspect the compute environment before retrying setup.")


def _ensure_queue(session, values):
    batch = _client(session, "batch")
    name = values["jobQueue"]
    response = _aws_call(batch, "describe_job_queues", "inspect the AWS Batch job queue",
                         jobQueues=[name])
    queues = response.get("jobQueues", []) if isinstance(response, dict) else []
    compute_response = _aws_call(
        batch, "describe_compute_environments", "verify AWS Batch compute environment",
        computeEnvironments=[values["computeEnvironment"]],
    )
    compute_items = compute_response.get("computeEnvironments", []) \
        if isinstance(compute_response, dict) else []
    compute_arn = compute_items[0].get("computeEnvironmentArn") if compute_items else None
    if not isinstance(compute_arn, str):
        raise CloudError("AWS Batch did not return the compute environment ARN for its queue.")
    expected = [{"computeEnvironment": compute_arn, "order": 1}]
    if queues:
        queue = queues[0]
        environments = queue.get("computeEnvironmentOrder", [])
        if queue.get("state") != "ENABLED" or environments != expected:
            raise CloudError("The existing AWS Batch queue is incompatible; Mizan did not change it.")
    else:
        _aws_call(batch, "create_job_queue", "create the AWS Batch job queue",
                  jobQueueName=name, state="ENABLED", priority=1,
                  computeEnvironmentOrder=expected)
    deadline = time.monotonic() + 5 * 60
    while time.monotonic() < deadline:
        checked = _aws_call(batch, "describe_job_queues", "verify the AWS Batch job queue",
                            jobQueues=[name])
        verified = checked.get("jobQueues", []) if isinstance(checked, dict) else []
        if not verified:
            raise CloudError("AWS Batch accepted the queue but did not return it.")
        status = verified[0].get("status")
        if status == "VALID":
            return
        if status == "INVALID":
            raise CloudError("AWS Batch marked the job queue invalid. Check its compute environment "
                             "and permissions.")
        if status not in ("CREATING", "UPDATING"):
            raise CloudError("AWS Batch returned an unknown job queue state.")
        _check_cancelled()
        time.sleep(min(POLL_INTERVAL, max(0, deadline - time.monotonic())))
    raise CloudError("AWS Batch job queue did not become valid within five minutes.")


def _job_definition_body(values, *, secret_arn=None):
    resources = [
        {"type": "VCPU", "value": str(INSTANCE_VCPUS)},
        {"type": "MEMORY", "value": str(INSTANCE_MEMORY_MIB)},
        {"type": "GPU", "value": "1"},
    ]
    container = {
        "image": values["image"],
        "command": ["Ref::source", "Ref::result", "Ref::model"],
        "resourceRequirements": resources,
        "jobRoleArn": values["role"],
        "executionRoleArn": values["executionRole"],
        "environment": [
            {"name": "CLOUD_STORAGE_PROVIDER", "value": "aws"},
            {"name": "S3_BUCKET", "value": values["bucket"]},
            {"name": "AWS_REGION", "value": values["region"]},
        ],
    }
    if secret_arn:
        container["secrets"] = [{"name": "HF_TOKEN", "valueFrom": secret_arn}]
    return {
        "jobDefinitionName": _job_definition_name(values["jobDefinition"]),
        "type": "container",
        "platformCapabilities": ["EC2"],
        "containerProperties": container,
        "retryStrategy": {"attempts": 1},
        "timeout": {"attemptDurationSeconds": JOB_TIMEOUT_SECONDS},
    }


def _definition_matches(definition, values, *, secret_arn=None):
    container = definition.get("containerProperties", {}) if isinstance(definition, dict) else {}
    expected = _job_definition_body(values, secret_arn=secret_arn)["containerProperties"]
    for key in ("image", "command", "resourceRequirements", "jobRoleArn",
                "executionRoleArn", "environment", "secrets"):
        actual_value = container.get(key, [] if key in ("environment", "secrets") else None)
        if actual_value != expected.get(key, [] if key in ("environment", "secrets") else None):
            return False
    return (
        definition.get("platformCapabilities") == ["EC2"]
        and definition.get("retryStrategy") == {"attempts": 1}
        and definition.get("timeout") == {"attemptDurationSeconds": JOB_TIMEOUT_SECONDS}
    )


def _register_job_definition(session, values, *, secret_arn=None):
    batch = _client(session, "batch")
    response = _aws_call(batch, "describe_job_definitions",
                         "inspect the AWS Batch job definition",
                         jobDefinitionName=_job_definition_name(values["jobDefinition"]),
                         status="ACTIVE")
    definitions = response.get("jobDefinitions", []) if isinstance(response, dict) else []
    definitions.sort(key=lambda item: item.get("revision", 0), reverse=True)
    for definition in definitions:
        if _definition_matches(definition, values, secret_arn=secret_arn):
            arn = definition.get("jobDefinitionArn")
            if isinstance(arn, str):
                return arn
    result = _aws_call(
        batch, "register_job_definition", "register the AWS Batch worker configuration",
        **_job_definition_body(values, secret_arn=secret_arn),
    )
    arn = result.get("jobDefinitionArn") if isinstance(result, dict) else None
    if not isinstance(arn, str) or not _SAFE_ID.fullmatch(arn):
        raise CloudError("AWS Batch accepted job definition registration but returned no revision ARN.")
    return arn


def _expected_settings(config):
    values = _validate_settings(config)
    session = _session(values)
    identity = _identity(session)
    if identity["accountId"] != values["accountId"]:
        raise CloudError("The selected AWS profile authenticated to account "
                         f"{identity['accountId']}, not the confirmed account "
                         f"{values['accountId']}. No AWS changes were made.")
    return values, session, identity


def list_subscriptions(profile=None, region=None):
    saved = load_provider_settings(PROVIDER)
    profile = saved.get("profile", "default") if profile is None else profile
    region = saved.get("region", "us-east-1") if region is None else region
    if not isinstance(profile, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", profile):
        raise CloudError("Enter a valid AWS credential profile name.")
    if not isinstance(region, str) or not re.fullmatch(r"[a-z]{2}(?:-gov)?-[a-z]+-\d", region):
        raise CloudError("Enter a valid AWS region.")
    values = {"profile": profile, "region": region}
    session = _session(values)
    identity = _identity(session)
    return [{
        "accountId": identity["accountId"], "profile": profile,
        "region": region, "arn": identity["arn"], "userId": identity["userId"],
    }]


def configure(config):
    values, session, identity = _expected_settings(config)
    values["role"] = _role_arn(identity["accountId"], _job_role_name(values["role"]))
    old = load_provider_settings(PROVIDER)
    same_resources = bool(old) and all(
        old.get(key) == values.get(key) for key in AWS_FIELDS if key != "image")
    same_image = bool(old) and old.get("image") == values.get("image")
    if same_resources:
        for key in AWS_INTERNAL_FIELDS:
            if key not in values and key in old:
                values[key] = old[key]
    else:
        for key in AWS_INTERNAL_FIELDS:
            values.pop(key, None)
    if same_image and isinstance(old.get("sourceHash"), str):
        values["sourceHash"] = old["sourceHash"]
    else:
        values.pop("sourceHash", None)
    save_provider_settings(PROVIDER, values)
    _setting("processing_mode", "local")
    return status(check_connection=False)


def _bucket_readiness(session, values):
    s3 = _client(session, "s3")
    _aws_call(s3, "head_bucket", "read the private S3 bucket", Bucket=values["bucket"])
    location = _aws_call(s3, "get_bucket_location", "check the S3 bucket region",
                         Bucket=values["bucket"])
    actual_region = (location.get("LocationConstraint") if isinstance(location, dict) else None) or "us-east-1"
    if actual_region != values["region"]:
        raise CloudError("The saved S3 bucket is not in the selected AWS region.")
    public = _aws_call(s3, "get_public_access_block", "check S3 public access protection",
                       Bucket=values["bucket"])
    block = public.get("PublicAccessBlockConfiguration", {}) if isinstance(public, dict) else {}
    if not all(block.get(key) is True for key in (
            "BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets")):
        raise CloudError("The AWS S3 bucket must block all public access.")
    ownership = _aws_call(s3, "get_bucket_ownership_controls",
                          "check S3 bucket ownership controls", Bucket=values["bucket"])
    rules = ownership.get("OwnershipControls", {}).get("Rules", []) if isinstance(ownership, dict) else []
    if not any(rule.get("ObjectOwnership") == "BucketOwnerEnforced"
               for rule in rules if isinstance(rule, dict)):
        raise CloudError("The AWS S3 bucket must enforce bucket-owner object ownership.")
    encryption = _aws_call(s3, "get_bucket_encryption", "check S3 default encryption",
                           Bucket=values["bucket"])
    rules = encryption.get("ServerSideEncryptionConfiguration", {}).get("Rules", []) \
        if isinstance(encryption, dict) else []
    if not any(rule.get("ApplyServerSideEncryptionByDefault", {}).get("SSEAlgorithm") == "AES256"
               for rule in rules if isinstance(rule, dict)):
        raise CloudError("The AWS S3 bucket must use default AES-256 encryption.")


def _preflight(values, session, identity, *, check_image=True,
               check_job_definition=True, cancelled=None):
    def check_cancelled():
        if cancelled is not None and cancelled.is_set():
            raise Cancelled()

    check_cancelled()
    if identity["accountId"] != values["accountId"]:
        raise CloudError("The selected AWS profile now points to a different account.")
    _bucket_readiness(session, values)
    check_cancelled()
    ec2_vpc = _valid_network(session, values)
    check_cancelled()
    batch = _client(session, "batch")
    env_response = _aws_call(batch, "describe_compute_environments",
                             "check AWS Batch GPU compute",
                             computeEnvironments=[values["computeEnvironment"]])
    environments = env_response.get("computeEnvironments", []) if isinstance(env_response, dict) else []
    resources = environments[0].get("computeResources", {}) if environments else {}
    if (not environments or environments[0].get("status") != "VALID"
            or resources.get("minvCpus") != 0
            or resources.get("type") != "EC2"
            or resources.get("maxvCpus", 0) < INSTANCE_VCPUS
            or resources.get("instanceTypes") != [INSTANCE_TYPE]
            or not isinstance(resources.get("subnets"), list)
            or set(resources["subnets"]) != set(values["subnetIds"])
            or not isinstance(resources.get("securityGroupIds"), list)
            or set(resources["securityGroupIds"]) != set(values["securityGroupIds"])
            or resources.get("instanceRole") != values.get("instanceRole")
            or environments[0].get("serviceRole") != values.get("serviceRole")
            or not _uses_nvidia_ecs_ami(resources)
            or resources.get("allocationStrategy") != "BEST_FIT_PROGRESSIVE"):
        raise CloudError("The saved AWS Batch compute environment is not a valid zero-idle NVIDIA environment.")
    compute_arn = environments[0].get("computeEnvironmentArn")
    queue_response = _aws_call(batch, "describe_job_queues", "check AWS Batch queue",
                               jobQueues=[values["jobQueue"]])
    queues = queue_response.get("jobQueues", []) if isinstance(queue_response, dict) else []
    if (not queues or queues[0].get("status") != "VALID"
            or queues[0].get("state") != "ENABLED"):
        raise CloudError("The saved AWS Batch job queue is unavailable or disabled.")
    if queues[0].get("computeEnvironmentOrder") != [
            {"computeEnvironment": compute_arn, "order": 1}]:
        raise CloudError("The saved AWS Batch queue is not connected to its compute environment.")
    check_cancelled()
    if check_job_definition:
        definitions_response = _aws_call(
            batch, "describe_job_definitions", "check AWS Batch worker configuration",
            jobDefinitionName=_job_definition_name(values["jobDefinition"]), status="ACTIVE",
        )
        definitions = definitions_response.get("jobDefinitions", []) \
            if isinstance(definitions_response, dict) else []
        definition = next(
            (item for item in definitions
             if item.get("jobDefinitionArn") == values["jobDefinition"]),
            None,
        )
        definition_secret = None
        container = definition.get("containerProperties", {}) if isinstance(definition, dict) else {}
        secrets = container.get("secrets", []) if isinstance(container, dict) else []
        token_binding = [item for item in secrets if isinstance(item, dict)
                         and item.get("name") == "HF_TOKEN"]
        if len(token_binding) == 1:
            definition_secret = token_binding[0].get("valueFrom")
        expected_secret = values.get("hfSecretArn") or definition_secret
        if (definition is None
                or (values.get("hfSecretArn") and definition_secret != values["hfSecretArn"])
                or not _definition_matches(definition, values, secret_arn=expected_secret)):
            raise CloudError("The saved AWS Batch job definition, IAM roles, image, or HF_TOKEN binding changed.")
        check_cancelled()
    if check_image:
        _verify_image(values["image"])
    return ec2_vpc


def _status_for(values, *, check_connection=True, cancelled=None):
    def check_cancelled():
        if cancelled is not None and cancelled.is_set():
            raise Cancelled()

    mode = _setting("processing_mode") or "local"
    result = {
        "ok": True, "provider": PROVIDER, "providerName": "AWS", "available": True,
        "configured": False, "verified": False, "supportedModels": [],
        "verifiedModels": [], "workerDigest": None, "workerImage": values.get("image"),
        "mode": mode, "config": _public_config(values), "prepared": False,
        "jobCreated": False, "requiresHfTokenConsent": not bool(values.get("hfSecretArn")),
        "runtimeVerified": False,
    }
    check_cancelled()
    if values.get("image"):
        try:
            verified = _verify_image(values["image"])
            result.update(workerDigest=verified["digest"], sourceHash=verified["sourceHash"])
        except CloudError as exc:
            result["issue"] = str(exc)
            return result
    else:
        result["issue"] = "Choose and verify the immutable public GHCR worker image."
        return result
    if not check_connection:
        result["issue"] = "AWS readiness has not been checked."
        return result
    try:
        check_cancelled()
        values, session, identity = _expected_settings(values)
        check_cancelled()
        _preflight(values, session, identity)
        supported = [model for model in MODEL_EXECUTION_BUDGETS
                     if _model_resources(model)]
        result.update(
            configured=bool(values.get("hfSecretArn")), verified=True,
            supportedModels=supported, verifiedModels=supported,
            prepared=True, jobCreated=bool(values.get("hfSecretArn")),
            requiresHfTokenConsent=not bool(values.get("hfSecretArn")),
            runtimeVerified=False,
        )
        if not result["configured"]:
            result["issue"] = ("AWS resources are ready. Approve transfer of the saved Hugging Face "
                               "token to create the native Batch secret binding.")
    except CloudError as exc:
        result["issue"] = str(exc)
    return result


def status(*, check_connection=True, target=None):
    if target is None:
        try:
            values = _saved_settings()
        except BaseCloudError as exc:
            return {
                "ok": True, "provider": PROVIDER, "providerName": "AWS",
                "available": True, "configured": False, "verified": False,
                "supportedModels": [], "verifiedModels": [], "workerDigest": None,
                "workerImage": None, "mode": _setting("processing_mode") or "local",
                "config": {"provider": PROVIDER}, "prepared": False,
                "jobCreated": False, "requiresHfTokenConsent": True,
                "runtimeVerified": False,
                "issue": str(exc),
            }
    else:
        values = _target_config(target)
    return _status_for(values, check_connection=check_connection)


def panel_status(request_id=None):
    try:
        values = _saved_settings()
    except BaseCloudError as exc:
        return {
            **status(check_connection=False),
            "issue": str(exc),
        }
    request_id = request_id or str(uuid4())
    result = state.panel_status(
        request_id, lambda cancelled: _status_for(
            values, check_connection=True, cancelled=cancelled))
    if "provider" in result:
        return result
    base = {
        "ok": True, "provider": PROVIDER, "providerName": "AWS", "available": True,
        "configured": False, "verified": False, "supportedModels": [],
        "verifiedModels": [], "workerDigest": None, "workerImage": values.get("image"),
        "sourceHash": values.get("sourceHash"), "mode": _setting("processing_mode") or "local",
        "config": _public_config(values), "prepared": False, "jobCreated": False,
        "requiresHfTokenConsent": not bool(values.get("hfSecretArn")),
        "runtimeVerified": False,
    }
    return {
        **base, **result, "configured": False,
        "requiresHfTokenConsent": not bool(values.get("hfSecretArn")),
    }


def prepare(config, consent=False):
    if consent is not True:
        raise CloudError("Approve AWS S3, IAM, networking and Batch resource changes before setup.")
    values, session, identity = _expected_settings(config)
    values["role"] = _role_arn(identity["accountId"], _job_role_name(values["role"]))
    with track_setup("provision", 7):
        _check_cancelled()
        _step("identity", 1, "Confirmed the selected AWS credential profile and account.")
        _ensure_bucket(session, values, identity)
        _step("storage", 2, "Created or secured the private, encrypted S3 bucket.")
        vpc = (_created_network(session, values) if not values["subnetIds"]
               else _valid_network(session, values))
        _step("network", 3, f"Validated Batch subnets and security groups in {vpc}.")
        _ensure_roles(session, values, identity["accountId"])
        _ensure_bucket_policy(
            session, values["bucket"], identity["accountId"], identity["arn"], values["role"])
        _step("roles", 4, "Created or verified the separate Batch job and execution roles.")
        _create_compute_environment(session, values)
        _step("compute", 5, "Created or verified the zero-idle NVIDIA Batch compute environment.")
        _ensure_queue(session, values)
        _step("queue", 6, "Created or verified the AWS Batch job queue.")
        if values.get("image"):
            verified = _verify_image(values["image"])
            values["sourceHash"] = verified["sourceHash"]
            values["jobDefinition"] = _register_job_definition(
                session, values, secret_arn=values.get("hfSecretArn"))
            _step("job", 7, "Registered the shared worker job definition with native secret binding.")
        saved = save_provider_settings(PROVIDER, values)
    result = status(check_connection=bool(values.get("image")))
    ready = bool(result.get("configured"))
    if ready:
        next_step = "AWS resources are ready. Choose Use Cloud to enable processing."
    elif not values.get("image"):
        next_step = "Import a verified immutable public GHCR worker image before binding the token."
    elif (result.get("requiresHfTokenConsent")
          and str(result.get("issue", "")).startswith("AWS resources are ready.")):
        next_step = ("AWS resources are ready. Separately approve transfer of the saved "
                     "Hugging Face token to bind the native Batch secret.")
    else:
        next_step = result.get("issue") or "Check the AWS resource status before continuing."
    return {
        **result, "prepared": True, "configured": ready,
        "jobCreated": bool(values.get("image") and values.get("hfSecretArn")),
        "next": next_step,
        "config": _public_config(saved),
    }


def _secret_arn(secret):
    arn = secret.get("ARN") if isinstance(secret, dict) else None
    if not isinstance(arn, str) or not re.fullmatch(
            r"arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}", arn):
        raise CloudError("AWS Secrets Manager returned an invalid HF_TOKEN reference.")
    return arn


def _store_hf_token(session, values, token):
    if not isinstance(token, str) or not re.fullmatch(r"hf_[A-Za-z0-9_-]{10,2000}", token):
        raise CloudError("The saved Hugging Face token is invalid; no AWS secret was changed.")
    client = _client(session, "secretsmanager", attempts=1)
    secret_arn = values.get("hfSecretArn")
    if secret_arn:
        if not secret_arn.startswith(
                f"arn:aws:secretsmanager:{values['region']}:{values['accountId']}:secret:"):
            raise CloudError("The saved AWS HF_TOKEN secret reference belongs to another account or region.")
        response = _aws_call(client, "put_secret_value", "update the approved AWS HF_TOKEN secret",
                             SecretId=secret_arn, SecretString=token)
    else:
        name = f"mizan/{values['accountId']}/hf-token"
        try:
            existing = _aws_call(client, "describe_secret",
                                 "check the approved AWS HF_TOKEN secret reference",
                                 SecretId=name)
        except CloudError as exc:
            if "ResourceNotFoundException" not in str(exc):
                raise
            response = _aws_call(
                client, "create_secret", "create the approved AWS HF_TOKEN secret",
                Name=name, Description="Mizan cloud worker Hugging Face token",
                SecretString=token,
            )
        else:
            arn = existing.get("ARN") if isinstance(existing, dict) else None
            if not isinstance(arn, str):
                raise CloudError("AWS Secrets Manager returned an invalid existing secret reference.")
            response = _aws_call(
                client, "put_secret_value", "update the approved AWS HF_TOKEN secret",
                SecretId=arn, SecretString=token,
            )
    return _secret_arn(response)


def finish(image, hf_token=None, *, hf_token_provider=None):
    values = _saved_settings()
    if not isinstance(image, str) or not image:
        raise CloudError("Choose the verified immutable public GHCR worker image.")
    verified = _verify_image(image)
    values["image"], values["sourceHash"] = image, verified["sourceHash"]
    values, session, identity = _expected_settings(values)
    values["role"] = _role_arn(identity["accountId"], _job_role_name(values["role"]))
    if not values.get("executionRole") or not values.get("serviceRole") or not values.get("instanceRole"):
        raise CloudError("Prepare AWS resources before binding the shared worker image.")
    if hf_token is None and hf_token_provider is not None:
        hf_token = hf_token_provider()
    if hf_token is None:
        try:
            definitions = _aws_call(
                _client(session, "batch"), "describe_job_definitions",
                "check the existing AWS Batch secret binding",
                jobDefinitionName=_job_definition_name(values["jobDefinition"]),
                status="ACTIVE")
            found = next((item for item in definitions.get("jobDefinitions", [])
                          if item.get("jobDefinitionArn") == values.get("jobDefinition")), None)
            if found and _definition_matches(
                    found, values, secret_arn=values.get("hfSecretArn")) \
                    and values.get("hfSecretArn"):
                current = _status_for(values, check_connection=True)
                return {**current, "jobCreated": True}
        except CloudError as exc:
            return {**_status_for(values, check_connection=False),
                    "requiresHfTokenConsent": True, "issue": str(exc)}
        return {
            **_status_for(values, check_connection=False), "configured": False,
            "jobCreated": False, "requiresHfTokenConsent": True,
            "next": "No verified AWS Batch secret binding exists. Approve sending the saved "
                    "Hugging Face token only if you want to create it.",
        }

    _preflight(values, session, identity, check_job_definition=False)
    # A token reaches this method only through the separate UI consent callback.
    secret_arn = _store_hf_token(session, values, hf_token)
    values["hfSecretArn"] = secret_arn
    execution_name = values["executionRole"].rsplit("/", 1)[-1]
    _role_policy(session, execution_name, "MizanHuggingFaceSecret", {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow", "Action": "secretsmanager:GetSecretValue",
            "Resource": secret_arn,
        }],
    })
    values["jobDefinition"] = _register_job_definition(session, values, secret_arn=secret_arn)
    save_provider_settings(PROVIDER, values)
    result = _status_for(values, check_connection=True)
    return {
        **result, "jobCreated": True,
        "next": ("The AWS Batch worker definition now uses the native HF_TOKEN secret binding. "
                 "Choose Use Cloud to enable processing; this did not start a GPU job."),
    }


def import_cloud_image(source_image):
    values = _saved_settings()
    verified = _verify_image(source_image)
    values["image"] = verified["image"]
    values["sourceHash"] = verified["sourceHash"]
    save_provider_settings(PROVIDER, values)
    return {
        "ok": True, "provider": PROVIDER, "image": verified["image"],
        "digest": verified["digest"], "sourceHash": verified["sourceHash"],
        "verified": True,
    }


def build_cloud_image():
    values = _saved_settings()
    image = values.get("image")
    if not image:
        raise CloudError("Enter the published public GHCR image pinned by sha256 digest, then "
                         "use Import worker image to verify it. AWS does not build or publish images.")
    verified = _verify_image(image)
    values["sourceHash"] = verified["sourceHash"]
    save_provider_settings(PROVIDER, values)
    return {"ok": True, "provider": PROVIDER, "image": verified["image"],
            "digest": verified["digest"], "sourceHash": verified["sourceHash"]}


def enable_log_analytics(consent=False):
    raise CloudError("AWS Batch uses the selected AWS logging configuration; "
                     "AWS log setup is not an AWS provider operation.")


def set_mode(mode):
    if mode == "local":
        _setting("processing_mode", "local")
        return {"ok": True, "mode": "local"}
    if mode != "cloud":
        raise CloudError("Choose local or cloud processing.")
    values = _saved_settings()
    result = _status_for(values, check_connection=True)
    if not result.get("configured"):
        raise CloudError(result.get("issue", "AWS Batch is not ready for processing."))
    selected_model = _setting("transcription_model") or "muscriptor-small"
    require_model(selected_model)
    _setting("processing_mode", "cloud")
    return {**result, "ok": True, "mode": "cloud"}


def require_model(model):
    _model_resources(model)


class _S3Files:
    def __init__(self, session, bucket):
        self.client = _client(session, "s3")
        self.bucket = bucket

    @staticmethod
    def _name(name):
        if not isinstance(name, str) or not re.fullmatch(
                r"jobs/[0-9a-f-]{36}/(?:input\.wav|result\.json|result\.json\.error|"
                r"result/stems/(?:drums|bass|other|vocals|guitar|piano)\.wav)", name):
            raise CloudError("AWS S3 object name is outside the validated job prefix.")
        return name

    @staticmethod
    def _check_cancelled(cancelled):
        if cancelled is not None and cancelled.is_set():
            raise Cancelled()

    def upload(self, name, path, *, limit=MAX_AUDIO_BYTES, cancelled=None):
        self._check_cancelled(cancelled)
        name = self._name(name)
        size = path.stat().st_size
        if not 0 < size <= limit:
            raise CloudError(f"Cloud object exceeds the {limit} byte upload limit.")
        with path.open("rb") as stream:
            _aws_call(
                self.client, "put_object", "upload a private S3 job file",
                Bucket=self.bucket, Key=name, Body=stream, ContentLength=size,
                IfNoneMatch="*", ContentType="application/octet-stream",
            )

    def download(self, name, path, *, limit, cancelled=None):
        name = self._name(name)
        self._check_cancelled(cancelled)
        response = _aws_call(self.client, "get_object", "download a private S3 job file",
                             Bucket=self.bucket, Key=name)
        body = response.get("Body")
        size = response.get("ContentLength")
        if type(size) is not int or not 0 < size <= limit or body is None:
            if body is not None:
                body.close()
            raise CloudError("AWS S3 returned an invalid object size.")
        digest = hashlib.sha256()
        received = 0
        try:
            with path.open("wb") as output:
                while True:
                    self._check_cancelled(cancelled)
                    block = body.read(256 * 1024)
                    if not block:
                        break
                    received += len(block)
                    if received > size or received > limit:
                        raise CloudError("AWS S3 download exceeded its declared size or limit.")
                    output.write(block)
                    digest.update(block)
            if received != size:
                raise CloudError("AWS S3 download size does not match its declared size.")
        except Exception:
            path.unlink(missing_ok=True)
            raise
        finally:
            body.close()
        return received, digest.hexdigest()

    def download_bytes(self, name, *, limit):
        name = self._name(name)
        response = _aws_call(self.client, "get_object", "read a private AWS worker result",
                             Bucket=self.bucket, Key=name)
        body, size = response.get("Body"), response.get("ContentLength")
        if type(size) is not int or not 0 < size <= limit or body is None:
            if body is not None:
                body.close()
            raise CloudError("AWS S3 returned an invalid worker result size.")
        try:
            data = body.read(limit + 1)
        finally:
            body.close()
        if len(data) != size or len(data) > limit:
            raise CloudError("AWS worker result does not match its declared size.")
        return data

    def delete(self, names):
        if (not isinstance(names, list) or not names or len(names) > 8
                or len(set(names)) != len(names)):
            raise CloudError("Cannot clean up invalid AWS Cloud file names.")
        safe = [self._name(name) for name in names]
        prefixes = {re.match(r"jobs/([0-9a-f-]{36})/", name).group(1) for name in safe}
        if len(prefixes) != 1:
            raise CloudError("AWS Cloud files do not belong to one job.")
        response = _aws_call(
            self.client, "delete_objects", "delete completed AWS job files",
            Bucket=self.bucket,
            Delete={"Objects": [{"Key": name} for name in safe], "Quiet": True},
        )
        errors = response.get("Errors", []) if isinstance(response, dict) else []
        if errors:
            raise CloudError("AWS S3 could not delete every completed job file. "
                             "Check the selected profile's S3 permissions.")


def _wait_job(batch, job_id, cancelled=None, *, deadline=None):
    deadline = deadline or (time.monotonic() + JOB_TIMEOUT_SECONDS)
    while time.monotonic() < deadline:
        if cancelled is not None and cancelled.is_set():
            return None
        response = _aws_call(batch, "describe_jobs", "check AWS Batch job status",
                             jobs=[job_id])
        jobs = response.get("jobs", []) if isinstance(response, dict) else []
        if not jobs:
            raise CloudError("AWS Batch no longer returns the submitted job; its state is unknown.")
        job = jobs[0]
        status = job.get("status")
        if status in STOPPED_STATES:
            return job
        if status not in WAITING_STATES | RUNNING_STATES:
            raise CloudError("AWS Batch returned an unknown job status; the remote job was not "
                             "treated as stopped.")
        if cancelled is not None:
            if cancelled.wait(min(POLL_INTERVAL, max(0, deadline - time.monotonic()))):
                return None
        else:
            time.sleep(min(POLL_INTERVAL, max(0, deadline - time.monotonic())))
    return None


def _stop_job(batch, job_id):
    response = _aws_call(batch, "describe_jobs", "check AWS Batch job before stopping",
                         jobs=[job_id])
    jobs = response.get("jobs", []) if isinstance(response, dict) else []
    if not jobs:
        return False
    status = jobs[0].get("status")
    if status in STOPPED_STATES:
        return True
    if status in WAITING_STATES:
        _aws_call(batch, "cancel_job", "cancel the queued AWS Batch job",
                  jobId=job_id, reason="Mizan job cancelled.")
    elif status in RUNNING_STATES:
        _aws_call(batch, "terminate_job", "terminate the running AWS Batch job",
                  jobId=job_id, reason="Mizan job cancelled.")
    else:
        return False
    stopped = _wait_job(batch, job_id, deadline=time.monotonic() + 10 * 60)
    return bool(stopped and stopped.get("status") in STOPPED_STATES)


def _job_error(files, result_name, run_id):
    try:
        raw = files.download_bytes(result_name, limit=MAX_WORKER_ERROR_BYTES)
    except CloudError:
        return None
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeError):
        return None
    return validate_worker_error(payload, run_id)


def offload(recording: Path, directory: Path, model: str, cancelled: Event, report, *, target=None):
    from .cloud_worker.worker import MAX_RESULT_BYTES
    values = _target_config(target)
    require_model(model)
    verified = _verify_image(values["image"])
    values["sourceHash"] = verified["sourceHash"]
    values, session, identity = _expected_settings(values)
    _preflight(values, session, identity)
    batch = _client(session, "batch", attempts=1)
    files = _S3Files(session, values["bucket"])
    run_id = str(uuid4())
    prefix = f"jobs/{run_id}"
    source_name, result_name = f"{prefix}/input.wav", f"{prefix}/result.json"
    names = [source_name, result_name,
             *(f"{prefix}/result/stems/{stem}.wav" for stem in STEMS)]
    if cancelled.is_set():
        raise Cancelled()
    report("detect", 0, message="Uploading prepared audio to private AWS S3")
    uploaded = False
    remote_job_id = None
    submit_unknown = False
    objects_cleaned = False

    def cleanup_remote():
        nonlocal objects_cleaned
        if not objects_cleaned:
            files.delete(names)
            objects_cleaned = True

    try:
        files.upload(source_name, recording, limit=MAX_AUDIO_BYTES, cancelled=cancelled)
        uploaded = True
        if cancelled.is_set():
            raise Cancelled()
        cpu, memory_gib = _model_resources(model)
        submit_unknown = True
        try:
            submitted = batch.submit_job(
                jobName=f"mizan-{run_id.replace('-', '')[:28]}",
                jobQueue=values["jobQueue"],
                jobDefinition=values["jobDefinition"],
                parameters={"source": source_name, "result": result_name, "model": model},
                containerOverrides={"resourceRequirements": [
                    {"type": "VCPU", "value": str(cpu)},
                    {"type": "MEMORY", "value": str(memory_gib * 1024)},
                ]},
                timeout={"attemptDurationSeconds": JOB_TIMEOUT_SECONDS},
                retryStrategy={"attempts": 1},
            )
        except Exception as exc:
            raise CloudError("AWS Batch job submission outcome is unknown. No second job was "
                             "submitted and uploaded input was retained. Inspect AWS Batch before "
                             "retrying. " + str(_aws_error("submit the AWS Batch job", exc))) from None
        remote_job_id = submitted.get("jobId") if isinstance(submitted, dict) else None
        if not isinstance(remote_job_id, str) or not _BATCH_JOB_ID.fullmatch(remote_job_id):
            raise CloudError("AWS Batch accepted a submission without a valid job ID. Its outcome "
                             "is unknown; inspect AWS Batch before retrying. Uploaded input was retained.")
        submit_unknown = False
        report("detect", 0, message="Waiting for AWS Batch GPU job",
               cloud_job={"provider": PROVIDER, "id": remote_job_id, "prefix": prefix})
        job = _wait_job(batch, remote_job_id, cancelled,
                        deadline=time.monotonic() + JOB_TIMEOUT_SECONDS)
        if job is None:
            stopped = _stop_job(batch, remote_job_id)
            if stopped:
                cleanup_remote()
            if cancelled.is_set():
                raise Cancelled()
            raise CloudError(
                "AWS Batch job timed out or its status could not be confirmed. "
                + ("The remote job stopped; temporary files were removed."
                   if stopped else "AWS has not confirmed that the job stopped; temporary files were retained.")
            )
        if cancelled.is_set():
            if job.get("status") in STOPPED_STATES:
                cleanup_remote()
            else:
                stopped = _stop_job(batch, remote_job_id)
                if stopped:
                    cleanup_remote()
            raise Cancelled()
        if job.get("status") != "SUCCEEDED":
            worker_error = _job_error(files, result_name, run_id)
            if worker_error:
                detail = f"{worker_error['stage']}: {worker_error['message']}"
                cleanup_remote()
                raise CloudError(f"AWS Batch worker failed ({detail}).")
            reason = _safe_text(job.get("statusReason"))
            cleanup_remote()
            raise CloudError("AWS Batch job failed."
                             + (f" {reason}" if reason else
                                " Check AWS Batch job details and configured network access."))
        report("detect", 0, message="Downloading validated results from AWS S3")
        raw = files.download_bytes(result_name, limit=MAX_RESULT_BYTES)
        try:
            manifest = json.loads(raw)
        except (ValueError, UnicodeError):
            cleanup_remote()
            raise CloudError("AWS Batch returned an invalid result manifest.") from None
        try:
            output = _materialize(
                manifest, files, names, recording, directory, model, error_type=CloudError)
        except (CloudError, ValueError, OSError):
            cleanup_remote()
            raise
        return output, names
    except Cancelled:
        if remote_job_id is not None:
            try:
                if _stop_job(batch, remote_job_id):
                    cleanup_remote()
                else:
                    logger.warning("AWS Batch did not confirm job stop; retaining temporary S3 objects.")
            except CloudError:
                logger.warning("Could not confirm AWS Batch job stop; retaining temporary S3 objects.")
        elif uploaded and not submit_unknown:
            files.delete([source_name])
        raise
    except CloudError:
        if remote_job_id is not None:
            try:
                if _stop_job(batch, remote_job_id):
                    cleanup_remote()
            except CloudError:
                logger.warning("Could not confirm AWS Batch job stop; retaining temporary S3 objects.")
        elif uploaded and not submit_unknown:
            files.delete([source_name])
        raise
    except Exception as exc:
        if remote_job_id is not None:
            try:
                if _stop_job(batch, remote_job_id):
                    cleanup_remote()
            except CloudError:
                logger.warning("Could not confirm AWS Batch job stop; retaining temporary S3 objects.")
        raise _aws_error("run the AWS Batch job", exc) from None


def cleanup(names, *, target=None):
    values = _target_config(target)
    _, session, identity = _expected_settings(values)
    if identity["accountId"] != values["accountId"]:
        raise CloudError("The queued AWS profile no longer points to its recorded account; "
                         "temporary S3 files were not deleted.")
    _S3Files(session, values["bucket"]).delete(names)
