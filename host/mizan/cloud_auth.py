"""Non-interactive, signed-in desktop Azure credentials."""

import base64
import binascii
import json
import time
from threading import Lock

ARM_SCOPE = "https://management.azure.com/.default"
STORAGE_SCOPE = "https://storage.azure.com/.default"
_credential = None
_tokens: dict[tuple[str, str | None], tuple[str, float]] = {}
_token_lock = Lock()


class AzureSignInError(Exception):
    pass


def claims(access: str) -> dict:
    try:
        result = json.loads(base64.urlsafe_b64decode(access.split(".")[1] + "==="))
        if not result.get("oid") or not result.get("tid") or not (
                result.get("scp") or result.get("idtyp") == "app"
                or (result.get("appid") and result.get("roles"))):
            raise ValueError("Expected a signed-in Azure identity")
        return result
    except (IndexError, ValueError, TypeError, binascii.Error) as exc:
        raise AzureSignInError("Azure returned no signed-in identity; check Azure credentials.") from exc


def _new_credential():
    from azure.identity import DefaultAzureCredential
    return DefaultAzureCredential(
        exclude_interactive_browser_credential=True,
        exclude_visual_studio_code_credential=True,
        additionally_allowed_tenants=["*"],
        process_timeout=30,
    )


def token(scope: str, tenant_id: str | None = None, expected_oid: str | None = None) -> str:
    global _credential
    try:
        with _token_lock:
            reused_credential = _credential is not None
            if _credential is None:
                _credential = _new_credential()
                _tokens.clear()
            key = (scope, tenant_id)
            cached = _tokens.get(key)
            cached_valid = bool(cached and cached[1] > time.monotonic())
            if cached_valid:
                access = cached[0]
            else:
                try:
                    access = _credential.get_token(
                        scope, **({"tenant_id": tenant_id} if tenant_id else {})).token
                except AzureSignInError:
                    raise
                except Exception:
                    if not reused_credential:
                        raise
                    _credential = None
                    _tokens.clear()
                    _credential = _new_credential()
                    access = _credential.get_token(
                        scope, **({"tenant_id": tenant_id} if tenant_id else {})).token
            identity = claims(access)
            if tenant_id and identity.get("tid", "").lower() != tenant_id.lower():
                raise AzureSignInError("Azure credentials do not belong to the selected subscription tenant.")
            if expected_oid and identity["oid"].lower() != expected_oid.lower():
                raise AzureSignInError("Azure credentials changed since Cloud setup; reconnect the same identity "
                                       "or reconfigure Cloud before running jobs.")
            if not cached_valid:
                remaining = int(identity.get("exp", 0)) - time.time() - 300
                _tokens[key] = (access, time.monotonic() + max(0, remaining))
            return access
    except AzureSignInError:
        raise
    except Exception as exc:
        # Do not include SDK exception details: some providers print token-bearing command output.
        raise AzureSignInError(
            "Azure token request failed. If you are signed in, check Azure CLI or PowerShell "
            "connectivity and retry; otherwise sign in with 'az login' or 'Connect-AzAccount'."
        ) from exc
