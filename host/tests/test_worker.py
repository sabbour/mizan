import json
import os
import subprocess
import sys

from mizan.worker import _dispatch


class StubApi:
    def echo(self, value):
        return {"ok": True, "value": value}


def test_worker_dispatch_preserves_api_envelope():
    reply = _dispatch(StubApi(), {"id": "42", "method": "echo", "args": ["hello"]})

    assert reply == {
        "id": "42",
        "ok": True,
        "result": {"ok": True, "value": "hello"},
    }
    json.dumps(reply)


def test_worker_rejects_private_or_missing_methods():
    for method in ("_secret", "missing"):
        reply = _dispatch(StubApi(), {"id": 1, "method": method, "args": []})
        assert reply["id"] == 1
        assert reply["ok"] is False
        assert reply["error"]["code"] == "invalid_request"


def test_worker_does_not_log_secret_if_credential_dispatch_raises(caplog):
    secret = "hf_example_only_not_real"

    class FailingApi:
        def set_hf_token(self, token):
            raise RuntimeError(token)

    reply = _dispatch(FailingApi(), {"id": 1, "method": "set_hf_token", "args": [secret]})
    assert reply["ok"] is False
    assert secret not in caplog.text + json.dumps(reply)


def test_worker_utf8_concurrent_requests_and_clean_eof(tmp_path):
    requests = [
        {"id": 1, "method": "create_folder", "args": ["ميزان café"]},
        *({"id": index, "method": "list_library", "args": []} for index in range(2, 12)),
    ]
    process = subprocess.run(
        [sys.executable, "-m", "mizan.worker"],
        input="\n".join(json.dumps(request, ensure_ascii=False) for request in requests) + "\n",
        capture_output=True, encoding="utf-8", timeout=30,
        env=os.environ | {"MIZAN_HOME": str(tmp_path), "PYTHONUTF8": "1"},
    )
    assert process.returncode == 0, process.stderr
    replies = {reply["id"]: reply for reply in map(json.loads, process.stdout.splitlines())}
    assert set(replies) == set(range(1, 12))
    assert all(reply["ok"] and reply["result"]["ok"] for reply in replies.values())
    assert replies[1]["result"]["folder"]["name"] == "ميزان café"
    assert "Mizan startup version=development build_id=source" in (
        tmp_path / "logs" / "mizan.log").read_text(encoding="utf-8")


def test_library_worker_does_not_import_processing_dependencies(tmp_path):
    bootstrap = """
import importlib.abc
import runpy
import sys

class NoProcessingImports(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] in {"numpy", "scipy", "onnxruntime", "yt_dlp", "mido"}:
            raise AssertionError("Library startup imported " + fullname)

sys.meta_path.insert(0, NoProcessingImports())
runpy.run_module("mizan.worker", run_name="__main__")
"""
    requests = [
        {"id": index, "method": method, "args": []}
        for index, method in enumerate(("list_library", "list_folders", "list_queue"))
    ]
    process = subprocess.run(
        [sys.executable, "-c", bootstrap],
        input="\n".join(json.dumps(request) for request in requests) + "\n",
        capture_output=True, encoding="utf-8", timeout=30,
        env=os.environ | {"MIZAN_HOME": str(tmp_path), "PYTHONUTF8": "1"},
    )
    assert process.returncode == 0, process.stderr
    replies = {reply["id"]: reply for reply in map(json.loads, process.stdout.splitlines())}
    assert set(replies) == {0, 1, 2}
    assert all(reply["ok"] and reply["result"]["ok"] for reply in replies.values())
