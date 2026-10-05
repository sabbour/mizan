import json

import numpy as np
import pytest

from mizan.engine import providers
from mizan.errors import Cancelled, ModelFailed
from threading import Event


def fake_session(tmp_path, requested, executed):
    class Session:
        def get_providers(self):
            return [providers.PROVIDERS[requested], providers.PROVIDERS["cpu"]]

        def run(self, _, feeds):
            return [feeds["x"]]

        def end_profiling(self):
            path = tmp_path / f"{requested}.json"
            path.write_text(json.dumps([
                {"cat": "Node", "dur": 40, "args": {"provider": providers.PROVIDERS[p]}}
                for p in executed
            ]))
            return str(path)
    return Session()


def test_presence_is_not_execution_and_order(tmp_path, monkeypatch):
    attempted = []

    def create(model, candidate, path):
        attempted.append(candidate)
        if candidate == "dml":
            raise RuntimeError("Unsupported operation")
        return fake_session(tmp_path, candidate, ["cpu"])

    monkeypatch.setattr(providers, "_session", create)
    result = providers.VerifiedModel(tmp_path / "x.onnx", {"x": np.ones(1)})
    assert attempted == ["qnn", "dml", "cpu"]
    assert result.report["selected"] == "cpu"
    assert result.report["effectiveProviders"] == ["CPUExecutionProvider"]
    assert "No profiled nodes" in result.report["attempts"][0]["reason"]


def test_mixed_assignment_is_honest(tmp_path, monkeypatch):
    monkeypatch.setattr(providers, "_session",
                        lambda m, c, p: fake_session(tmp_path, c, ["qnn", "cpu"]))
    result = providers.VerifiedModel(tmp_path / "x", {"x": np.ones(1)})
    assert result.report["selected"] == "qnn"
    assert set(result.report["effectiveProviders"]) == {"QNNExecutionProvider", "CPUExecutionProvider"}


def test_basic_pitch_uses_measured_cpu_default(tmp_path, monkeypatch):
    attempted = []

    def create(model, candidate, path):
        attempted.append(candidate)
        return fake_session(tmp_path, candidate, [candidate])

    monkeypatch.setattr(providers, "_session", create)
    result = providers.VerifiedModel(tmp_path / "basic-pitch-icassp-2022.onnx", {"x": np.ones(1)})
    assert attempted == ["cpu"]
    assert result.report["selected"] == "cpu"


def test_override_and_cancel(tmp_path, monkeypatch):
    monkeypatch.setenv("MIZAN_PROVIDER", "cpu")
    monkeypatch.setattr(providers, "_session",
                        lambda m, c, p: fake_session(tmp_path, c, ["cpu"]))
    result = providers.VerifiedModel(tmp_path / "x", {"x": np.ones(1)})
    assert [a["requested"] for a in result.report["attempts"]] == ["cpu"]
    event = Event()
    event.set()
    with pytest.raises(Cancelled):
        providers.VerifiedModel(tmp_path / "x", {}, cancelled=event)
    monkeypatch.setenv("MIZAN_PROVIDER", "invalid")
    with pytest.raises(ModelFailed):
        providers.VerifiedModel(tmp_path / "x", {})


def test_runtime_failure_reselects_provider(tmp_path, monkeypatch):
    def session(model, candidate, path):
        instance = fake_session(tmp_path, candidate, [candidate])
        run = instance.run
        calls = 0

        def fail_later(_, feeds):
            nonlocal calls
            calls += 1
            if candidate == "qnn" and calls > 1:
                raise RuntimeError("Lost accelerator")
            return run(_, feeds)

        instance.run = fail_later
        return instance

    monkeypatch.setattr(providers, "_session", session)
    model = providers.VerifiedModel(tmp_path / "model", {"x": np.ones(1)})
    model.run({"x": np.ones(1)})
    assert model.report["selected"] == "dml"
    assert model.report["runtimeFallback"]["reason"] == "Lost accelerator"
    assert set(model.report["effectiveProviders"]) == {"QNNExecutionProvider", "DmlExecutionProvider"}
