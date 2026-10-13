"""Small provider-local state for cloud setup and readiness operations."""

from contextlib import contextmanager
from threading import Event, Lock, Thread, get_ident, local
import time

from .cloud import PROVIDER_NAMES
from .errors import Cancelled, MizanError

READINESS_TIMEOUT = 120
REQUEST_ID_LIMIT = 128
_CANCEL_TOMBSTONE_LIMIT = 256
_READINESS_CACHE_SECONDS = READINESS_TIMEOUT


class CloudOperations:
    def __init__(self, provider, readiness_timeout=READINESS_TIMEOUT):
        self.provider = provider
        self.label = PROVIDER_NAMES.get(provider, provider)
        self.readiness_timeout = readiness_timeout
        self._lock = Lock()
        self._setup = {"operation": None, "stage": "idle", "completed": 0,
                       "total": 0, "detail": None}
        self._setup_owner = None
        self._setup_cancelled = Event()
        self._readiness_local = local()
        self._readiness = {}
        self._cancelled_requests = {}

    @contextmanager
    def track_setup(self, operation, total):
        owner = get_ident()
        with self._lock:
            if self._setup_owner is not None:
                if self._setup_owner != owner or self._setup["operation"] != operation:
                    raise MizanError(
                        f"Cloud {self.label} setup is already in progress.")
                nested = True
            else:
                if self._setup["stage"] not in ("idle", "completed", "failed"):
                    raise MizanError(
                        f"Cloud {self.label} setup is already in progress.")
                nested = False
                self._setup_cancelled.clear()
                self._setup_owner = owner
                self._setup.update(operation=operation, stage="starting",
                                   completed=0, total=total, detail=None)
        if nested:
            yield
            self.check_cancelled()
            return
        try:
            yield
            self.check_cancelled()
        except Exception:
            with self._lock:
                stage = self._setup["stage"]
                self._setup.update(
                    stage="failed",
                    detail=f"Cloud {self.label} {operation} failed during "
                           f"{stage.replace('_', ' ')}.")
            raise
        else:
            with self._lock:
                self._setup.update(stage="completed", completed=total, detail=None)
        finally:
            with self._lock:
                self._setup_owner = None
                self._setup_cancelled.clear()

    def setup_progress(self):
        with self._lock:
            return dict(self._setup)

    def cancel_setup(self):
        with self._lock:
            active = (self._setup["operation"] == "provision"
                      and self._setup["stage"] not in ("idle", "completed", "failed"))
            if active:
                self._setup_cancelled.set()
                self._setup["detail"] = (
                    f"Stopping {self.label} setup after the current request.")
        return {"cancelRequested": active}

    def step(self, stage, completed, detail):
        self.check_cancelled()
        with self._lock:
            if (self._setup_owner != get_ident()
                    or self._setup["stage"] in ("idle", "completed", "failed")):
                return
            self._setup.update(stage=stage, completed=completed, detail=detail)

    def check_cancelled(self):
        readiness = getattr(self._readiness_local, "cancelled", None)
        if ((readiness is not None and readiness.is_set())
                or (self._setup_owner == get_ident()
                    and self._setup_cancelled.is_set())):
            raise Cancelled()

    def panel_status(self, request_id, check_callable):
        request_id = self._request_id(request_id)
        now = time.monotonic()
        with self._lock:
            self._prune_cancelled(now)
            self._prune_readiness(now)
            if self._cancelled_requests.get(request_id, 0) > now:
                return self._cancelled_result()
            active = next((item for item in self._readiness.values()
                           if not item["done"].is_set()), None)
            if active:
                active["cancelled"].set()
                active["stage"] = "cancelled"
                active["detail"] = "The read-only access check was cancelled."
                return {"issue": f"The previous {self.label} readiness check is "
                                 "stopping. Retry the check."}
            if request_id in self._readiness:
                raise MizanError(f"This {self.label} readiness request is already complete.")
            request = {
                "started": now,
                "cancelled": Event(),
                "done": Event(),
                "stage": f"{self.label} access",
                "detail": "Starting a read-only access check.",
                "result": None,
                "error": None,
            }
            self._readiness[request_id] = request

        def run_check():
            self._readiness_local.cancelled = request["cancelled"]
            try:
                self.check_cancelled()
                result = check_callable(request["cancelled"])
                if not isinstance(result, dict):
                    raise MizanError("The cloud readiness check returned an invalid result.")
                with self._lock:
                    if not request["cancelled"].is_set():
                        request["result"] = result
                        request["stage"] = "complete"
                        request["detail"] = "The read-only access check is complete."
            except Exception as exc:
                with self._lock:
                    if not request["cancelled"].is_set():
                        request["error"] = exc
            finally:
                request["done"].set()
                del self._readiness_local.cancelled

        Thread(target=run_check, name=f"mizan-{self.provider}-readiness",
               daemon=True).start()
        if not request["done"].wait(self.readiness_timeout):
            with self._lock:
                request["cancelled"].set()
                request["stage"] = "timed out"
                request["detail"] = "The read-only access check timed out."
            return self._cancelled_result(timed_out=True)
        if request["cancelled"].is_set():
            return self._cancelled_result()
        if request["error"]:
            if isinstance(request["error"], MizanError):
                return {"issue": str(request["error"])}
            raise request["error"]
        return dict(request["result"])

    def readiness_progress(self, request_id):
        request_id = self._request_id(request_id)
        with self._lock:
            self._prune_readiness(time.monotonic())
            request = self._readiness.get(request_id)
            if request is None:
                return {"stage": "idle", "detail": None, "elapsedSeconds": 0,
                        "timeoutSeconds": self.readiness_timeout}
            return {
                "stage": request["stage"],
                "detail": request["detail"],
                "elapsedSeconds": round(max(0, time.monotonic() - request["started"]), 1),
                "timeoutSeconds": self.readiness_timeout,
            }

    def cancel_panel_status(self, request_id):
        request_id = self._request_id(request_id)
        now = time.monotonic()
        with self._lock:
            self._prune_cancelled(now)
            if len(self._cancelled_requests) >= _CANCEL_TOMBSTONE_LIMIT:
                oldest = min(self._cancelled_requests,
                             key=self._cancelled_requests.get)
                self._cancelled_requests.pop(oldest)
            self._cancelled_requests[request_id] = now + self.readiness_timeout
            request = self._readiness.get(request_id)
            if request is not None and not request["done"].is_set():
                request["cancelled"].set()
                request["stage"] = "cancelled"
                request["detail"] = "The read-only access check was cancelled."
                return {"cancelRequested": True}
        return {"cancelRequested": False}

    def _request_id(self, request_id):
        if (not isinstance(request_id, str) or not request_id
                or len(request_id) > REQUEST_ID_LIMIT):
            raise MizanError(f"The {self.label} readiness request ID is invalid.")
        return request_id

    def _prune_cancelled(self, now):
        for request_id, expires in list(self._cancelled_requests.items()):
            if expires <= now:
                self._cancelled_requests.pop(request_id)

    def _prune_readiness(self, now):
        for request_id, request in list(self._readiness.items()):
            if (request["done"].is_set()
                    and now - request["started"] >= _READINESS_CACHE_SECONDS):
                self._readiness.pop(request_id)

    def _cancelled_result(self, timed_out=False):
        issue = f"The {self.label} readiness check "
        issue += "timed out." if timed_out else "was cancelled."
        return {"issue": issue}
