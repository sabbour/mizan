"""Shared Azure request retry and diagnostics policy."""

import errno
import re
import socket
import ssl
import urllib.error

ARM_REQUEST_TIMEOUT = 90
ARM_SOCKET_TIMEOUT = 30
ARM_GET_MAX_ATTEMPTS = 3
ARM_GET_RETRY_BACKOFF = 1
ARM_GET_MAX_BACKOFF = 4


def _transient_transport_error(exc):
    reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    if isinstance(reason, ssl.SSLError):
        return False
    if isinstance(reason, (TimeoutError, socket.timeout, ConnectionError)):
        return True
    if isinstance(reason, socket.gaierror):
        return reason.errno == socket.EAI_AGAIN
    if isinstance(reason, OSError):
        return reason.errno in {
            errno.EAGAIN, errno.EINTR, errno.ECONNRESET, errno.ECONNABORTED,
            errno.ECONNREFUSED, errno.ETIMEDOUT, errno.ENETUNREACH, errno.EHOSTUNREACH,
            10035,  # WSAEWOULDBLOCK
            10051,  # WSAENETUNREACH
            10053,  # WSAECONNABORTED
            10054,  # WSAECONNRESET
            10060,  # WSAETIMEDOUT
            10061,  # WSAECONNREFUSED
        }
    message = str(reason).lower()
    return any(phrase in message for phrase in (
        "timed out", "temporary failure", "temporarily unavailable",
        "connection reset", "connection aborted", "remote end closed connection",
    ))


def _transport_category(exc):
    reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    if isinstance(reason, ssl.SSLError):
        return "tls"
    if isinstance(reason, socket.gaierror):
        return "dns_temporary" if reason.errno == socket.EAI_AGAIN else "dns"
    if isinstance(reason, (TimeoutError, socket.timeout)):
        return "timeout"
    if isinstance(reason, ConnectionError):
        return "connection"
    message = str(reason).lower()
    if "name resolution" in message or "getaddrinfo" in message or "dns" in message:
        return "dns"
    if "timed out" in message or "timeout" in message:
        return "timeout"
    if "connection" in message:
        return "connection"
    return "transport"


def _transport_diagnostics(exc, *, sensitive=False):
    reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    reason_type = type(reason).__name__
    reason_message = "[REDACTED]" if sensitive else _safe_azure_text(reason)
    return (_transport_category(exc), type(exc).__name__, reason_type,
            getattr(reason, "errno", None), getattr(reason, "winerror", None), reason_message)


def _safe_azure_text(value):
    text = " ".join(str(value).split())
    text = re.sub(r"https?://[^\s\"'<>]+", "[URL redacted]", text, flags=re.IGNORECASE)
    text = re.sub(r"(?i)\bBearer\s+\S+", "******", text)
    text = re.sub(
        r"(?i)\b(hf_[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}"
        r"(?:\.[A-Za-z0-9_-]*)?)\b",
        "[REDACTED]", text)
    text = re.sub(
        r"(?i)\b(authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|"
        r"account[_-]?key|password|connection[_-]?string|sig|se|sp|sv|sr|st|spr)\s*[:=]\s*[^,\s;]+",
        r"\1=[REDACTED]", text)
    return text[:500]
