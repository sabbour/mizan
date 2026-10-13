"""Lazy object-storage clients used by the shared cloud worker."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
from typing import Protocol

CHUNK_BYTES = 256 * 1024
MAX_AUDIO_BYTES = 250 * 1024 * 1024


class ObjectStorage(Protocol):
    def size(self, name: str) -> int: ...
    def download(self, name: str, path: Path, *, limit: int) -> tuple[int, str]: ...
    def upload(self, name: str, path: Path, *, limit: int, overwrite: bool) -> None: ...
    def upload_bytes(self, name: str, data: bytes, *, limit: int, overwrite: bool) -> None: ...


def _copy_chunks(chunks, path: Path, *, size: int, limit: int) -> tuple[int, str]:
    if type(size) is not int or not 0 < size <= limit:
        raise ValueError(f"Cloud object exceeds the {limit} byte download limit.")
    digest = hashlib.sha256()
    received = 0
    try:
        with path.open("wb") as output:
            for block in chunks:
                if not isinstance(block, bytes):
                    raise ValueError("Cloud storage returned an invalid download block.")
                if not block:
                    continue
                received += len(block)
                if received > size or received > limit:
                    raise ValueError("Cloud download exceeds its declared size or limit.")
                output.write(block)
                digest.update(block)
        if received != size:
            raise ValueError("Cloud download size does not match its declared size.")
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return received, digest.hexdigest()


def _read_chunks(stream):
    while block := stream.read(CHUNK_BYTES):
        yield block


def _upload_size(path: Path, limit: int) -> int:
    size = path.stat().st_size
    if not 0 < size <= limit:
        raise ValueError(f"Cloud object exceeds the {limit} byte upload limit.")
    return size


class _AzureBlobStorage:
    def __init__(self):
        from azure.identity import ManagedIdentityCredential
        from azure.storage.blob import BlobServiceClient

        service = BlobServiceClient(
            os.environ["AZURE_STORAGE_BLOB_URL"],
            credential=ManagedIdentityCredential(client_id=os.environ["AZURE_CLIENT_ID"]),
        )
        self.container = service.get_container_client(os.environ["AZURE_STORAGE_CONTAINER"])

    def _blob(self, name):
        return self.container.get_blob_client(name)

    def size(self, name):
        return self._blob(name).get_blob_properties().size

    def download(self, name, path, *, limit):
        blob = self._blob(name)
        size = blob.get_blob_properties().size
        return _copy_chunks(blob.download_blob(max_concurrency=1).chunks(), path,
                            size=size, limit=limit)

    def upload(self, name, path, *, limit, overwrite):
        _upload_size(path, limit)
        with path.open("rb") as stream:
            self.container.upload_blob(name, stream, overwrite=overwrite)

    def upload_bytes(self, name, data, *, limit, overwrite):
        if not 0 < len(data) <= limit:
            raise ValueError(f"Cloud object exceeds the {limit} byte upload limit.")
        self.container.upload_blob(name, data, overwrite=overwrite)


class _GoogleCloudStorage:
    def __init__(self):
        from google.cloud import storage

        self.client = storage.Client(project=os.environ.get("GOOGLE_CLOUD_PROJECT") or None)
        self.bucket = self.client.bucket(os.environ["GCS_BUCKET"])

    def _blob(self, name):
        return self.bucket.blob(name)

    def size(self, name):
        blob = self._blob(name)
        blob.reload()
        return blob.size

    def download(self, name, path, *, limit):
        blob = self._blob(name)
        blob.reload()
        with blob.open("rb", chunk_size=CHUNK_BYTES) as stream:
            return _copy_chunks(_read_chunks(stream), path, size=blob.size, limit=limit)

    def upload(self, name, path, *, limit, overwrite):
        size = _upload_size(path, limit)
        blob = self._blob(name)
        with path.open("rb") as stream:
            blob.upload_from_file(stream, rewind=True, size=size,
                                  if_generation_match=None if overwrite else 0,
                                  content_type="application/octet-stream")

    def upload_bytes(self, name, data, *, limit, overwrite):
        if not 0 < len(data) <= limit:
            raise ValueError(f"Cloud object exceeds the {limit} byte upload limit.")
        blob = self._blob(name)
        blob.upload_from_string(
            data, content_type="application/json",
            if_generation_match=None if overwrite else 0,
        )


class _S3Storage:
    def __init__(self):
        import boto3

        region = os.environ["AWS_REGION"]
        if os.environ.get("S3_ENDPOINT_URL"):
            raise ValueError("AWS uses its regional S3 endpoint; custom endpoints are not accepted.")
        bucket = os.environ["S3_BUCKET"]
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]", bucket):
            raise ValueError("S3 bucket name is invalid.")
        self.client = boto3.client("s3", region_name=region, endpoint_url=None)
        self.bucket = bucket

    def size(self, name):
        return self.client.head_object(Bucket=self.bucket, Key=name)["ContentLength"]

    def download(self, name, path, *, limit):
        response = self.client.get_object(Bucket=self.bucket, Key=name)
        body = response["Body"]
        try:
            return _copy_chunks(_read_chunks(body), path,
                                size=response["ContentLength"], limit=limit)
        finally:
            body.close()

    def upload(self, name, path, *, limit, overwrite):
        size = _upload_size(path, limit)
        with path.open("rb") as stream:
            request = {"Bucket": self.bucket, "Key": name,
                       "Body": stream, "ContentLength": size}
            if not overwrite:
                request["IfNoneMatch"] = "*"
            self.client.put_object(**request)

    def upload_bytes(self, name, data, *, limit, overwrite):
        if not 0 < len(data) <= limit:
            raise ValueError(f"Cloud object exceeds the {limit} byte upload limit.")
        request = {"Bucket": self.bucket, "Key": name, "Body": data}
        if not overwrite:
            request["IfNoneMatch"] = "*"
        self.client.put_object(**request)


def from_environment() -> ObjectStorage:
    provider = os.environ.get("CLOUD_STORAGE_PROVIDER", "azure").lower()
    if provider == "azure":
        return _AzureBlobStorage()
    if provider == "gcp":
        return _GoogleCloudStorage()
    if provider == "aws":
        return _S3Storage()
    raise ValueError("Unsupported cloud storage provider.")
