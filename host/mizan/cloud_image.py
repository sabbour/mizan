"""Strict anonymous verification for the shared public GHCR worker image."""

import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from .cloud_worker.source import worker_source
from .errors import MizanError

_IMAGE = re.compile(
    r"^ghcr\.io/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)/"
    r"mizan-cloud-worker@(sha256:[0-9a-f]{64})$")
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_MANIFEST_LIMIT = 4 * 1024 * 1024
_CONFIG_LIMIT = 8 * 1024 * 1024
_REQUEST_LIMIT = 8
_TOTAL_TIMEOUT = 45
_REQUEST_TIMEOUT = 12
_SOURCE_LABEL = "org.mizan.worker.source-sha256"
_ACCEPT = ", ".join((
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
))


class CloudImageError(MizanError):
    code = "cloud_image_invalid"
    message = "The public cloud worker image could not be verified."


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


class _Registry:
    def __init__(self):
        self._opener = urllib.request.build_opener(_NoRedirect())
        self._deadline = time.monotonic() + _TOTAL_TIMEOUT
        self._requests = 0

    def _timeout(self):
        remaining = self._deadline - time.monotonic()
        if remaining <= 0:
            raise CloudImageError("GHCR image verification timed out.")
        return min(_REQUEST_TIMEOUT, remaining)

    def _read(self, response, limit):
        length = response.headers.get("Content-Length")
        expected = None
        if length is not None:
            try:
                expected = int(length)
                if expected < 0 or expected > limit:
                    raise CloudImageError("GHCR returned image metadata that is too large.")
            except ValueError:
                raise CloudImageError("GHCR returned invalid image metadata.") from None
        body = bytearray()
        while expected is None or len(body) < expected:
            remaining = self._deadline - time.monotonic()
            if remaining <= 0:
                raise CloudImageError("GHCR image verification timed out.")
            socket = getattr(getattr(getattr(response, "fp", None), "raw", None),
                             "_sock", None)
            if socket is not None:
                socket.settimeout(min(_REQUEST_TIMEOUT, remaining))
            chunk = response.read(min(64 * 1024, limit + 1 - len(body)))
            if not chunk:
                break
            body.extend(chunk)
            if len(body) > limit:
                raise CloudImageError("GHCR returned image metadata that is too large.")
        if expected is not None and len(body) != expected:
            raise CloudImageError("GHCR returned incomplete image metadata.")
        return bytes(body)

    def _open(self, url, headers, limit, allow_blob_redirect=False):
        self._requests += 1
        if self._requests > _REQUEST_LIMIT:
            raise CloudImageError("GHCR image verification exceeded its request limit.")
        request = urllib.request.Request(
            url, headers={"Accept-Encoding": "identity",
                          "User-Agent": "Mizan-cloud-image-verifier/1",
                          **headers}, method="GET")
        try:
            response = self._opener.open(request, timeout=self._timeout())
        except urllib.error.HTTPError as exc:
            if allow_blob_redirect and exc.code in (301, 302, 303, 307, 308):
                location = exc.headers.get("Location")
                exc.close()
                target = self._blob_redirect(url, location)
                return self._open(target, {}, limit)
            status = exc.code
            exc.close()
            self._raise_status(status)
        except (OSError, TimeoutError, urllib.error.URLError):
            raise CloudImageError(
                "Could not reach GHCR to verify the public worker image.") from None
        try:
            try:
                body = self._read(response, limit)
                return body, response.headers
            except (OSError, TimeoutError, urllib.error.URLError):
                raise CloudImageError(
                    "Could not read GHCR metadata for the public worker image.") from None
        finally:
            response.close()

    def _blob_redirect(self, source, location):
        try:
            target = urllib.parse.urljoin(source, location or "")
            parsed = urllib.parse.urlsplit(target)
            port = parsed.port
        except ValueError:
            raise CloudImageError("GHCR returned an invalid image blob redirect.") from None
        host = (parsed.hostname or "").lower()
        trusted = (host in ("ghcr.io", "github.com", "objects.githubusercontent.com",
                            "pkg-containers.githubusercontent.com")
                   or host.endswith(".githubusercontent.com"))
        if (parsed.scheme != "https" or not trusted or parsed.username is not None
                or parsed.password is not None or port not in (None, 443)):
            raise CloudImageError("GHCR returned an untrusted image blob redirect.")
        return target

    def _raise_status(self, status):
        if status in (401, 403):
            message = "The GHCR package is private or does not allow anonymous image pulls."
        elif status == 404:
            message = "The public GHCR image digest was not found."
        elif status == 429:
            message = "GHCR limited anonymous image verification. Retry later."
        else:
            message = f"GHCR image verification returned HTTP {status}."
        raise CloudImageError(message)

    def token(self, owner):
        query = urllib.parse.urlencode({
            "scope": f"repository:{owner}/mizan-cloud-worker:pull",
            "service": "ghcr.io",
        })
        body, _ = self._open(
            f"https://ghcr.io/token?{query}",
            {"Accept": "application/json"}, 64 * 1024)
        data = _json(body)
        token = data.get("token") or data.get("access_token")
        if not isinstance(token, str) or not token or len(token) > 8192:
            raise CloudImageError("GHCR did not provide an anonymous image-pull token.")
        return token

    def json(self, url, token, limit, digest=None, allow_blob_redirect=False):
        body, headers = self._open(
            url,
            {"Accept": _ACCEPT, "Authorization": f"Bearer {token}"},
            limit,
            allow_blob_redirect=allow_blob_redirect,
        )
        if digest is not None and hashlib.sha256(body).hexdigest() != digest[7:]:
            raise CloudImageError("GHCR image metadata does not match its declared digest.")
        reported_digest = headers.get("Docker-Content-Digest")
        if digest is not None and reported_digest and reported_digest != digest:
            raise CloudImageError("GHCR returned a different image metadata digest.")
        return _json(body), len(body)


def _json(body):
    try:
        data = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise CloudImageError("GHCR returned invalid image metadata.") from None
    if not isinstance(data, dict):
        raise CloudImageError("GHCR returned invalid image metadata.")
    return data


def _manifest(registry, owner, token, digest):
    url = f"https://ghcr.io/v2/{owner}/mizan-cloud-worker/manifests/{digest}"
    manifest, _ = registry.json(url, token, _MANIFEST_LIMIT, digest=digest)
    manifests = manifest.get("manifests")
    if manifests is not None:
        if not isinstance(manifests, list) or len(manifests) > 100:
            raise CloudImageError("GHCR returned an invalid multi-platform image index.")
        matching = [
            item for item in manifests
            if isinstance(item, dict)
            and isinstance(item.get("platform"), dict)
            and item["platform"].get("os") == "linux"
            and item["platform"].get("architecture") == "amd64"
        ]
        if len(matching) != 1 or not _DIGEST.fullmatch(
                str(matching[0].get("digest", "")) if matching else ""):
            raise CloudImageError(
                "The GHCR image does not contain one unambiguous Linux AMD64 image.")
        child_digest = matching[0]["digest"]
        return _manifest(registry, owner, token, child_digest)
    config = manifest.get("config")
    if not isinstance(config, dict) or not _DIGEST.fullmatch(str(config.get("digest", ""))):
        raise CloudImageError("GHCR returned an invalid worker image manifest.")
    size = config.get("size")
    if isinstance(size, bool) or not isinstance(size, int) or not 0 < size <= _CONFIG_LIMIT:
        raise CloudImageError("GHCR returned an invalid worker image config size.")
    return owner, token, config["digest"], size


def verify_image(image):
    """Accept only a public, source-matched immutable GHCR worker image."""
    if not isinstance(image, str) or not (match := _IMAGE.fullmatch(image)):
        raise CloudImageError(
            "Use a public GHCR worker image in immutable @sha256 digest form.")
    owner, digest = match.groups()
    try:
        _, source_hash = worker_source()
    except (OSError, ValueError):
        raise CloudImageError("The bundled worker source does not satisfy its source contract.") from None
    registry = _Registry()
    token = registry.token(owner)
    _, _, config_digest, config_size = _manifest(registry, owner, token, digest)
    url = (f"https://ghcr.io/v2/{owner}/mizan-cloud-worker/blobs/{config_digest}")
    config, actual_size = registry.json(
        url, token, _CONFIG_LIMIT, digest=config_digest, allow_blob_redirect=True)
    if actual_size != config_size:
        raise CloudImageError("GHCR returned a worker image config with the wrong size.")
    labels = config.get("config")
    labels = labels.get("Labels") if isinstance(labels, dict) else None
    if (config.get("os") != "linux" or config.get("architecture") != "amd64"
            or not isinstance(labels, dict) or labels.get(_SOURCE_LABEL) != source_hash):
        raise CloudImageError(
            "The GHCR image platform or worker source hash does not match this application.")
    return {"image": image, "digest": digest, "sourceHash": source_hash}
