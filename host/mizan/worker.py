from __future__ import annotations

import json
import logging
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock
from typing import Any

from .api import Api
from .artifacts import ArtifactServer
from .jobs import JobRunner, JobStore
from .logging_setup import configure_file_logging


def _reply(request_id: Any, *, result: Any = None, error: dict[str, str] | None = None) -> dict:
    if error is not None:
        return {"id": request_id, "ok": False, "error": error}
    return {"id": request_id, "ok": True, "result": result}


def _dispatch(api: Api, request: dict[str, Any]) -> dict:
    request_id = request.get("id")
    method = request.get("method")
    args = request.get("args", [])
    if not isinstance(method, str) or method.startswith("_"):
        return _reply(request_id, error={
            "code": "invalid_request",
            "message": "The host method is invalid.",
            "fix": "Restart Mizan and try again.",
        })
    target = getattr(api, method, None)
    if not callable(target) or not isinstance(args, list):
        return _reply(request_id, error={
            "code": "invalid_request",
            "message": f"The host does not support '{method}'.",
            "fix": "Update Mizan and try again.",
        })
    try:
        return _reply(request_id, result=target(*args))
    except Exception:
        if method in ("set_hf_token", "finish_cloud", "configure_cloud"):
            logging.getLogger(__name__).error("Worker credential dispatch failed")
        else:
            logging.getLogger(__name__).exception("Worker dispatch failed for %s", method)
        return _reply(request_id, error={
            "code": "worker_error",
            "message": "The Mizan host stopped processing this request.",
            "fix": "Try again. If it keeps failing, restart Mizan.",
        })


def main() -> None:
    configure_file_logging()
    runner = JobRunner(JobStore())
    artifacts = ArtifactServer()
    api = Api(runner, artifacts)
    output_lock = Lock()

    def send(reply: dict) -> None:
        line = json.dumps(reply, ensure_ascii=True, allow_nan=False)
        with output_lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    try:
        with ThreadPoolExecutor(max_workers=4, thread_name_prefix="mizan-rpc") as pool:
            for line in sys.stdin:
                try:
                    request = json.loads(line)
                    if not isinstance(request, dict):
                        raise ValueError("request must be an object")
                except (json.JSONDecodeError, ValueError):
                    send(_reply(None, error={
                        "code": "invalid_json",
                        "message": "The desktop shell sent an invalid request.",
                        "fix": "Restart Mizan and try again.",
                    }))
                    continue
                future = pool.submit(_dispatch, api, request)
                future.add_done_callback(lambda completed: send(completed.result()))
    finally:
        artifacts.close()
        runner.close()


if __name__ == "__main__":
    main()
