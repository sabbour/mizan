from io import BytesIO
import hashlib
import importlib
from pathlib import Path
import sys
import tomllib
from types import ModuleType, SimpleNamespace

import pytest

from mizan.cloud_worker import storage
from mizan.cloud_worker.source import WORKER_SOURCE_FILES, worker_source
from mizan.cloud_worker.worker import _worker_error


def test_worker_storage_import_does_not_load_provider_sdks(monkeypatch):
    import builtins
    original_import = builtins.__import__

    def reject_cloud_sdk(name, *args, **kwargs):
        if name.split(".", 1)[0] in {"azure", "boto3", "google"}:
            raise AssertionError(f"Cloud SDK imported eagerly: {name}")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", reject_cloud_sdk)
    importlib.reload(storage)


def test_existing_worker_jobs_default_to_azure(monkeypatch):
    identity = ModuleType("azure.identity")
    identity.ManagedIdentityCredential = lambda **kwargs: kwargs
    blob = ModuleType("azure.storage.blob")

    class BlobService:
        def __init__(self, url, *, credential):
            self.url, self.credential = url, credential

        def get_container_client(self, name):
            return (self.url, self.credential, name)

    blob.BlobServiceClient = BlobService
    azure = ModuleType("azure")
    azure.__path__ = []
    azure.identity = identity
    azure_storage = ModuleType("azure.storage")
    azure_storage.__path__ = []
    monkeypatch.setitem(sys.modules, "azure", azure)
    monkeypatch.setitem(sys.modules, "azure.identity", identity)
    monkeypatch.setitem(sys.modules, "azure.storage", azure_storage)
    monkeypatch.setitem(sys.modules, "azure.storage.blob", blob)
    monkeypatch.delenv("CLOUD_STORAGE_PROVIDER", raising=False)
    monkeypatch.setenv("AZURE_STORAGE_BLOB_URL", "https://mizan.blob.core.windows.net")
    monkeypatch.setenv("AZURE_STORAGE_CONTAINER", "jobs")
    monkeypatch.setenv("AZURE_CLIENT_ID", "managed-identity")

    backend = storage.from_environment()
    assert isinstance(backend, storage._AzureBlobStorage)
    assert backend.container == (
        "https://mizan.blob.core.windows.net",
        {"client_id": "managed-identity"}, "jobs")


def test_download_is_bounded_and_returns_sha256(tmp_path):
    target = tmp_path / "download"
    assert storage._copy_chunks([b"abc", b"def"], target, size=6, limit=6) == (
        6, hashlib.sha256(b"abcdef").hexdigest())
    assert target.read_bytes() == b"abcdef"

    with pytest.raises(ValueError, match="declared size or limit"):
        storage._copy_chunks([b"abcdefg"], target, size=6, limit=6)
    assert not target.exists()

    with pytest.raises(ValueError, match="declared size"):
        storage._copy_chunks([b"abc"], target, size=6, limit=6)
    assert not target.exists()


def test_worker_source_hash_covers_all_image_inputs():
    files, digest = worker_source()
    assert tuple(files) == WORKER_SOURCE_FILES
    assert set(files) == {"Dockerfile", "worker.py", "storage.py", "LICENSE"}
    assert len(digest) == 64


@pytest.mark.parametrize("name", WORKER_SOURCE_FILES)
def test_worker_source_hash_changes_for_each_image_input(monkeypatch, name):
    _, original_digest = worker_source()
    read_bytes = Path.read_bytes
    monkeypatch.setattr(
        Path, "read_bytes",
        lambda path: read_bytes(path) + (b"\n" if path.name == name else b""))
    assert worker_source()[1] != original_digest


def test_worker_package_preserves_the_app_license_notice():
    root = Path(__file__).resolve().parents[2]
    files, _ = worker_source()
    assert files["LICENSE"].decode("utf-8").splitlines() == (
        root / "LICENSE").read_text(encoding="utf-8").splitlines()
    project = tomllib.loads((root / "host" / "pyproject.toml").read_text(encoding="utf-8"))
    assert "cloud_worker/LICENSE" in project["tool"]["setuptools"]["package-data"]["mizan"]


def test_worker_error_scrubs_non_azure_cloud_secrets():
    access_key = "AKIA" + "PRIVATEKEY0000000000"
    secret_key = "s3-private-secret"
    envelope = _worker_error(
        RuntimeError(f"AWS_ACCESS_KEY_ID={access_key} AWS_SECRET_ACCESS_KEY={secret_key}"),
        "storage", "11111111-1111-1111-1111-111111111111", (access_key, secret_key))

    assert access_key not in str(envelope)
    assert secret_key not in str(envelope)
    assert "[redacted secret]" in envelope["error"]["message"]


def test_removed_provider_cannot_create_a_storage_client(monkeypatch):
    monkeypatch.setenv("CLOUD_STORAGE_PROVIDER", "nebius")
    with pytest.raises(ValueError, match="Unsupported cloud storage provider"):
        storage.from_environment()


def test_aws_storage_uses_regional_endpoint_and_bounded_transfers(monkeypatch, tmp_path):
    calls = []

    class Client:
        def head_object(self, **kwargs):
            return {"ContentLength": 6}

        def get_object(self, **kwargs):
            return {"ContentLength": 6, "Body": BytesIO(b"abcdef")}

        def put_object(self, **kwargs):
            body = kwargs["Body"]
            calls.append({**kwargs, "Body": body.read() if hasattr(body, "read") else body})

    client = Client()
    boto3 = ModuleType("boto3")
    boto3.client = lambda service, **kwargs: (
        calls.append((service, kwargs)) or client)
    monkeypatch.setitem(sys.modules, "boto3", boto3)
    monkeypatch.setenv("CLOUD_STORAGE_PROVIDER", "aws")
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.delenv("S3_ENDPOINT_URL", raising=False)
    monkeypatch.setenv("S3_BUCKET", "mizan-jobs")

    backend = storage.from_environment()
    assert calls[0] == ("s3", {
        "region_name": "us-east-1",
        "endpoint_url": None,
    })
    assert backend.size("jobs/test/input.wav") == 6
    path = tmp_path / "input.wav"
    assert backend.download("jobs/test/input.wav", path, limit=6) == (
        6, hashlib.sha256(b"abcdef").hexdigest())
    assert path.read_bytes() == b"abcdef"

    upload = tmp_path / "stem.wav"
    upload.write_bytes(b"stem")
    backend.upload("jobs/test/stem.wav", upload, limit=10, overwrite=False)
    assert calls[-1]["Body"] == b"stem"
    assert calls[-1]["IfNoneMatch"] == "*"


def test_aws_storage_rejects_custom_endpoints_before_client_creation(monkeypatch):
    boto3 = ModuleType("boto3")
    boto3.client = lambda *args, **kwargs: pytest.fail("Untrusted S3 endpoint reached the SDK")
    monkeypatch.setitem(sys.modules, "boto3", boto3)
    monkeypatch.setenv("CLOUD_STORAGE_PROVIDER", "aws")
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("S3_BUCKET", "mizan-jobs")
    monkeypatch.setenv("S3_ENDPOINT_URL", "https://storage.attacker.example")

    with pytest.raises(ValueError, match="custom endpoints"):
        storage.from_environment()


def test_gcs_storage_uses_application_default_credentials(monkeypatch, tmp_path):
    class Blob:
        def reload(self):
            self.size = 4

        def open(self, mode, *, chunk_size):
            assert mode == "rb" and chunk_size == storage.CHUNK_BYTES
            return BytesIO(b"data")

        def upload_from_file(self, stream, **kwargs):
            self.uploaded = stream.read()
            self.upload_options = kwargs

    class Bucket:
        def __init__(self):
            self.blob_value = Blob()

        def blob(self, _name):
            return self.blob_value

    bucket = Bucket()
    storage_client = SimpleNamespace(bucket=lambda name: (
        calls.append(("bucket", name)) or bucket))
    calls = []
    storage_module = ModuleType("google.cloud.storage")
    storage_module.Client = lambda **kwargs: (
        calls.append(("client", kwargs)) or storage_client)
    google = ModuleType("google")
    google.__path__ = []
    cloud = ModuleType("google.cloud")
    cloud.__path__ = []
    cloud.storage = storage_module
    monkeypatch.setitem(sys.modules, "google", google)
    monkeypatch.setitem(sys.modules, "google.cloud", cloud)
    monkeypatch.setitem(sys.modules, "google.cloud.storage", storage_module)
    monkeypatch.setenv("CLOUD_STORAGE_PROVIDER", "gcp")
    monkeypatch.setenv("GCS_BUCKET", "mizan-jobs")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "mizan-project")

    backend = storage.from_environment()
    assert calls == [
        ("client", {"project": "mizan-project"}),
        ("bucket", "mizan-jobs"),
    ]
    assert backend.download("jobs/test/input.wav", tmp_path / "input.wav", limit=4) == (
        4, hashlib.sha256(b"data").hexdigest())
    source = tmp_path / "stem.wav"
    source.write_bytes(b"stem")
    backend.upload("jobs/test/stem.wav", source, limit=8, overwrite=False)
    assert bucket.blob_value.uploaded == b"stem"
    assert bucket.blob_value.upload_options["if_generation_match"] == 0
