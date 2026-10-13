import hashlib
from email.message import Message
import io
import json
import urllib.error

import pytest

from mizan import cloud_image
from mizan.cloud_worker.source import worker_source


def _bytes(value):
    return json.dumps(value, separators=(",", ":")).encode()


def _digest(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


class _Response:
    def __init__(self, body, headers=None):
        self._body = io.BytesIO(body)
        self.headers = Message()
        for key, value in (headers or {}).items():
            self.headers[key] = value

    def read(self, limit):
        return self._body.read(limit)

    def close(self):
        self._body.close()


def _publish(monkeypatch, *, config=None, index=False, redirect=False,
             fail_status=None, wrong_digest=False, ambiguous_index=False):
    source_hash = worker_source()[1]
    config = config or {
        "architecture": "amd64",
        "os": "linux",
        "config": {"Labels": {
            "org.mizan.worker.source-sha256": source_hash,
        }},
    }
    config_body = _bytes(config)
    config_digest = _digest(config_body)
    image_manifest = {
        "schemaVersion": 2,
        "config": {"digest": config_digest, "size": len(config_body)},
        "layers": [],
    }
    image_manifest_body = _bytes(image_manifest)
    image_digest = _digest(image_manifest_body)
    manifests = {image_digest: image_manifest_body}
    if index:
        index_body = _bytes({
            "schemaVersion": 2,
            "manifests": [
                {"digest": _digest(b"ignored-arm"), "platform": {
                    "os": "linux", "architecture": "arm64"}},
                {"digest": image_digest, "platform": {
                    "os": "linux", "architecture": "amd64"}},
                {"digest": _digest(b"attestation"), "platform": {
                    "os": "unknown", "architecture": "unknown"}},
            ],
        })
        if ambiguous_index:
            index_data = json.loads(index_body)
            index_data["manifests"].append({
                "digest": _digest(b"second-amd64"),
                "platform": {"os": "linux", "architecture": "amd64"},
            })
            index_body = _bytes(index_data)
        image_digest = _digest(index_body)
        manifests[image_digest] = index_body
    image = f"ghcr.io/example/mizan-cloud-worker@{image_digest}"
    calls = []

    class _Opener:
        def open(self, request, timeout):
            url = request.full_url
            headers = {key.lower(): value for key, value in request.header_items()}
            calls.append((url, headers))
            if fail_status and "/manifests/" in url:
                error_headers = Message()
                raise urllib.error.HTTPError(
                    url, fail_status, "private", error_headers, io.BytesIO())
            if url.startswith("https://ghcr.io/token?"):
                assert "authorization" not in headers
                return _Response(_bytes({"token": "anonymous-token"}))
            if "/manifests/" in url:
                assert headers["authorization"] == "Bearer anonymous-token"
                digest = url.rsplit("/", 1)[-1]
                body = manifests.get(digest)
                if body is None and wrong_digest:
                    body = next(iter(manifests.values()))
                if body is None:
                    error_headers = Message()
                    raise urllib.error.HTTPError(
                        url, 404, "missing", error_headers, io.BytesIO())
                return _Response(body, {"Docker-Content-Digest": digest})
            if url.startswith("https://ghcr.io/") and "/blobs/" in url and redirect:
                assert headers["authorization"] == "Bearer anonymous-token"
                redirect_headers = Message()
                redirect_headers["Location"] = (
                    "https://pkg-containers.githubusercontent.com/ghcr1/blobs/"
                    f"{config_digest}?sig=must-not-leak")
                raise urllib.error.HTTPError(
                    url, 302, "redirect", redirect_headers, io.BytesIO())
            if url.startswith("https://pkg-containers.githubusercontent.com/"):
                assert "authorization" not in headers
                assert "sig=must-not-leak" in url
                return _Response(config_body)
            if "/blobs/" in url:
                assert headers["authorization"] == "Bearer anonymous-token"
                return _Response(config_body)
            raise AssertionError(f"Unexpected request: {url}")

    monkeypatch.setattr(
        cloud_image.urllib.request, "build_opener", lambda *_: _Opener())
    return image, source_hash, calls


def test_verify_immutable_public_digest_and_source_hash(monkeypatch):
    image, source_hash, calls = _publish(monkeypatch, redirect=True)

    result = cloud_image.verify_image(image)

    assert result == {"image": image, "digest": image.rsplit("@", 1)[1],
                      "sourceHash": source_hash}
    assert len(calls) == 4
    assert calls[-1][1].get("authorization") is None


def test_verify_selects_linux_amd64_from_oci_index(monkeypatch):
    image, source_hash, _ = _publish(monkeypatch, index=True)

    result = cloud_image.verify_image(image)

    assert result["digest"] == image.rsplit("@", 1)[1]
    assert result["sourceHash"] == source_hash


@pytest.mark.parametrize("image", [
    "ghcr.io/example/mizan-cloud-worker:latest",
    "ghcr.io/Example/mizan-cloud-worker@sha256:" + "a" * 64,
    "docker.io/example/mizan-cloud-worker@sha256:" + "a" * 64,
])
def test_rejects_mutable_or_non_ghcr_references(image):
    with pytest.raises(cloud_image.CloudImageError, match="immutable"):
        cloud_image.verify_image(image)


def test_rejects_digest_mismatch(monkeypatch):
    image, _, _ = _publish(monkeypatch, wrong_digest=True)
    wrong_digest = "sha256:" + "0" * 64

    with pytest.raises(cloud_image.CloudImageError, match="digest"):
        cloud_image.verify_image(image.rsplit("@", 1)[0] + "@" + wrong_digest)


@pytest.mark.parametrize("change", [
    {"config": {"Labels": {"org.mizan.worker.source-sha256": "0" * 64}}},
    {"architecture": "arm64"},
    {"os": "windows"},
])
def test_rejects_source_or_platform_mismatch(monkeypatch, change):
    source_hash = worker_source()[1]
    config = {
        "architecture": "amd64",
        "os": "linux",
        "config": {"Labels": {
            "org.mizan.worker.source-sha256": source_hash,
        }},
        **change,
    }
    image, _, _ = _publish(monkeypatch, config=config)

    with pytest.raises(cloud_image.CloudImageError, match="platform or worker source"):
        cloud_image.verify_image(image)


def test_rejects_private_package_with_safe_message(monkeypatch):
    image, _, _ = _publish(monkeypatch, fail_status=403)

    with pytest.raises(cloud_image.CloudImageError, match="private") as error:
        cloud_image.verify_image(image)

    assert "anonymous-token" not in str(error.value)
    assert "sig=" not in str(error.value)


def test_network_errors_do_not_expose_signed_urls_or_tokens(monkeypatch):
    image, _, _ = _publish(monkeypatch)

    class _BrokenOpener:
        def open(self, request, timeout):
            raise urllib.error.URLError(
                "https://example.test/blob?sig=signed-secret&token=private-secret")

    monkeypatch.setattr(
        cloud_image.urllib.request, "build_opener", lambda *_: _BrokenOpener())
    with pytest.raises(cloud_image.CloudImageError) as error:
        cloud_image.verify_image(image)

    assert "signed-secret" not in str(error.value)
    assert "private-secret" not in str(error.value)


def test_rejects_oversized_registry_response():
    response = _Response(b"12345", {"Content-Length": "5"})

    with pytest.raises(cloud_image.CloudImageError, match="too large"):
        cloud_image._Registry()._read(response, 4)


def test_rejects_ambiguous_or_unsupported_index(monkeypatch):
    image, _, _ = _publish(monkeypatch, index=True, ambiguous_index=True)

    with pytest.raises(cloud_image.CloudImageError, match="unambiguous"):
        cloud_image.verify_image(image)
