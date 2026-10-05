"""Per-user Hugging Face credential in Windows Credential Manager."""

import ctypes
import sys
from ctypes import wintypes

TARGET = "Mizan:HuggingFace"
_GENERIC = 1
_LOCAL_MACHINE = 2
_NOT_FOUND = 1168


class _Credential(ctypes.Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
        ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
        ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
        ("Persist", wintypes.DWORD), ("AttributeCount", wintypes.DWORD),
        ("Attributes", ctypes.c_void_p), ("TargetAlias", wintypes.LPWSTR),
        ("UserName", wintypes.LPWSTR),
    ]


def _vault():
    if sys.platform != "win32":
        raise OSError("Windows Credential Manager is required.")
    api = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
    pointer = ctypes.POINTER(_Credential)
    api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(pointer)]
    api.CredReadW.restype = wintypes.BOOL
    api.CredWriteW.argtypes = [pointer, wintypes.DWORD]
    api.CredWriteW.restype = wintypes.BOOL
    api.CredDeleteW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
    api.CredDeleteW.restype = wintypes.BOOL
    api.CredFree.argtypes = [ctypes.c_void_p]
    api.CredFree.restype = None
    return api


def get_credential(target: str) -> str | None:
    """Read a per-user secret; never expose it through the host API."""
    api = _vault()
    credential = ctypes.POINTER(_Credential)()
    if not api.CredReadW(target, _GENERIC, 0, ctypes.byref(credential)):
        if ctypes.get_last_error() == _NOT_FOUND:
            return None
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        record = credential.contents
        if record.CredentialBlobSize % 2:
            raise OSError("Stored credential is invalid.")
        try:
            return ctypes.string_at(record.CredentialBlob, record.CredentialBlobSize).decode("utf-16-le")
        except UnicodeError:
            raise OSError("Stored credential is invalid.") from None
    finally:
        api.CredFree(credential)


def set_credential(target: str, token: str) -> None:
    if not isinstance(token, str) or not token.strip() or len(token) > 1200 or "\x00" in token:
        raise ValueError("Enter a valid Hugging Face token.")
    blob = bytearray(token.encode("utf-16-le"))
    try:
        if len(blob) > 2560:
            raise ValueError("Enter a valid Hugging Face token.")
        buffer = (ctypes.c_ubyte * len(blob)).from_buffer(blob)
        credential = _Credential(
            Type=_GENERIC, TargetName=target, CredentialBlobSize=len(blob),
            CredentialBlob=buffer, Persist=_LOCAL_MACHINE, UserName="Mizan",
        )
        api = _vault()
        if not api.CredWriteW(ctypes.byref(credential), 0):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        blob[:] = b"\x00" * len(blob)


def clear_credential(target: str) -> None:
    api = _vault()
    if not api.CredDeleteW(target, _GENERIC, 0) and ctypes.get_last_error() != _NOT_FOUND:
        raise ctypes.WinError(ctypes.get_last_error())


def get_hf_token() -> str | None:
    return get_credential(TARGET)


def set_hf_token(token: str) -> None:
    set_credential(TARGET, token)


def clear_hf_token() -> None:
    clear_credential(TARGET)
