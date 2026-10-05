"""Select providers using executed-node evidence, not advertised availability."""

import argparse
import atexit
import json
import logging
import os
from pathlib import Path
from threading import Event
import time

import numpy as np
from onnxruntime.capi import onnxruntime_pybind11_state as ort_errors

from ..errors import Cancelled, ModelFailed
from ..paths import app_dir
from .models import BASIC_PITCH, BEAT_THIS, HTDEMUCS_6S

logger = logging.getLogger(__name__)
PROVIDERS = {"qnn": "QNNExecutionProvider", "dml": "DmlExecutionProvider", "cpu": "CPUExecutionProvider"}
DEFAULT_PROVIDER_ORDER = ["qnn", "dml", "cpu"]
MODEL_PROVIDER_ORDER = {
    BASIC_PITCH.get("filename", f"{BASIC_PITCH['id']}.onnx"): BASIC_PITCH["providerOrder"],
    BEAT_THIS["filename"]: BEAT_THIS["providerOrder"],
    HTDEMUCS_6S["filename"]: HTDEMUCS_6S["providerOrder"],
}
_winml_bootstrap = None
_winml_registered: set[str] = set()
PROVIDER_ERRORS = (RuntimeError, ValueError, OSError, ImportError,
                   ort_errors.Fail, ort_errors.InvalidArgument, ort_errors.NotImplemented,
                   ort_errors.RuntimeException, ort_errors.EPFail, ort_errors.InvalidGraph)


def check_cancel(cancelled: Event | None) -> None:
    if cancelled is not None and cancelled.is_set():
        raise Cancelled()


def _provider_order(model: Path, order: list[str] | None = None) -> list[str]:
    return order or MODEL_PROVIDER_ORDER.get(model.name, DEFAULT_PROVIDER_ORDER)


def _register_windows_ml_provider(name: str) -> None:
    if name in _winml_registered:
        return
    import onnxruntime as ort
    import winui3.microsoft.windows.applicationmodel.dynamicdependency.bootstrap as bootstrap
    import winui3.microsoft.windows.ai.machinelearning as winml

    global _winml_bootstrap
    if _winml_bootstrap is None:
        _winml_bootstrap = bootstrap.initialize()
        atexit.register(_winml_bootstrap)
    catalog = winml.ExecutionProviderCatalog.get_default()
    for provider in catalog.find_all_providers():
        if provider.name != name:
            continue
        result = provider.ensure_ready_async().get()
        if result.status != winml.ExecutionProviderReadyResultState.SUCCESS:
            detail = getattr(result, "diagnostic_text", "") or getattr(result, "extended_error", "")
            raise RuntimeError(f"Windows ML could not prepare {name}: {result.status} {detail}")
        if provider.name not in ort.get_available_providers():
            ort.register_execution_provider_library(provider.name, provider.library_path)
        _winml_registered.add(name)
        return
    raise RuntimeError(f"Windows ML catalog has no compatible {name}.")


def _session(model: Path, provider: str, profile: Path):
    import onnxruntime as ort

    ort.disable_telemetry_events()
    options = ort.SessionOptions()
    options.enable_profiling = True
    options.profile_file_prefix = str(profile)
    options.intra_op_num_threads = 4
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.enable_mem_pattern = False
    name = PROVIDERS[provider]
    if provider == "qnn":
        _register_windows_ml_provider(name)
        devices = [d for d in ort.get_ep_devices() if d.ep_name == name]
        if not devices:
            raise RuntimeError("Windows ML QNN has no available NPU/GPU device.")
        options.add_provider_for_devices(devices, {})
        return ort.InferenceSession(str(model), sess_options=options)
    if name not in ort.get_available_providers():
        raise RuntimeError(f"{name} is not available in this runtime.")
    providers = [(name, {})]
    if provider != "cpu":
        providers.append(("CPUExecutionProvider", {}))
    return ort.InferenceSession(str(model), sess_options=options, providers=providers)


def profile_evidence(path: str) -> dict:
    events = json.loads(Path(path).read_text(encoding="utf-8"))
    counts: dict[str, int] = {}
    durations: dict[str, float] = {}
    for event in events:
        args = event.get("args", {})
        provider = args.get("provider")
        if event.get("cat") == "Node" and provider:
            counts[provider] = counts.get(provider, 0) + 1
            durations[provider] = durations.get(provider, 0.0) + event.get("dur", 0) / 1000
    return {"nodeExecutions": counts, "nodeMilliseconds": durations, "profile": path}


class VerifiedModel:
    def __init__(self, model: Path, sample: dict[str, np.ndarray], *,
                 provider: str | None = None, provider_order: list[str] | None = None,
                 cancelled: Event | None = None):
        self.model = model
        self.cancelled = cancelled
        self.session = None
        self.report: dict = {"attempts": [], "effectiveProviders": []}
        requested = (provider or os.environ.get("MIZAN_PROVIDER", "auto")).lower()
        self.requested = requested
        if requested not in ("auto", *PROVIDERS):
            raise ModelFailed("MIZAN_PROVIDER must be auto, qnn, dml, or cpu.")
        # Overrides prioritize one EP but never remove the guaranteed CPU fallback.
        candidates = (_provider_order(model, provider_order) if requested == "auto"
                      else list(dict.fromkeys([requested, "cpu"])))
        self.candidates = candidates
        for candidate in candidates:
            check_cancel(cancelled)
            started = time.perf_counter()
            attempt = {"requested": candidate}
            session = None
            self.session = None
            try:
                profile = app_dir("logs") / f"ort-{candidate}-{time.time_ns()}"
                session = _session(model, candidate, profile)
                registered = session.get_providers()
                output = session.run(None, sample)
                evidence = profile_evidence(session.end_profiling())
                attempt.update(evidence, registeredProviders=registered)
                if PROVIDERS[candidate] not in registered or not evidence["nodeExecutions"].get(PROVIDERS[candidate]):
                    raise RuntimeError(f"No profiled nodes executed on {PROVIDERS[candidate]}.")
                self.session = session
                self.report.update(evidence, registeredProviders=registered)
                if any(not np.isfinite(value).all() for value in output):
                    raise RuntimeError("Provider returned non-finite model outputs.")
                self.report["effectiveProviders"] = list(self.report["nodeExecutions"])
                self.report["selected"] = candidate
                self.first_output = output
                attempt["verified"] = True
            except PROVIDER_ERRORS as exc:
                attempt["reason"] = str(exc)
                logger.warning("Provider %s fallback: %s", candidate, exc)
            finally:
                attempt["setupAndProbeSeconds"] = time.perf_counter() - started
                self.report["attempts"].append(attempt)
            if attempt.get("verified"):
                return
        raise ModelFailed(f"No provider could execute {model.name}: {self.report['attempts']}")

    def _fallback_provider(self, selected: str) -> str:
        try:
            index = self.candidates.index(selected)
        except ValueError:
            return "cpu"
        return next((candidate for candidate in self.candidates[index + 1:] if candidate != selected), "cpu")

    def run(self, feeds: dict[str, np.ndarray]) -> list[np.ndarray]:
        check_cancel(self.cancelled)
        try:
            output = self.session.run(None, feeds)
            if any(not np.isfinite(value).all() for value in output):
                raise RuntimeError("Provider returned non-finite model outputs.")
        except PROVIDER_ERRORS as exc:
            check_cancel(self.cancelled)
            selected = self.report["selected"]
            if selected == "cpu":
                raise ModelFailed(f"CPU inference failed: {exc}") from exc
            logger.warning("Provider %s failed during inference: %s", selected, exc)
            fallback_provider = self._fallback_provider(selected) if self.requested == "auto" else "cpu"
            fallback = VerifiedModel(self.model, feeds, provider=fallback_provider, cancelled=self.cancelled)
            previous = {"provider": selected, "reason": str(exc), "evidence": self.report}
            self.session = fallback.session
            used = list(dict.fromkeys([*self.report["effectiveProviders"], *fallback.report["effectiveProviders"]]))
            self.report = {**fallback.report, "effectiveProviders": used, "runtimeFallback": previous}
            output = fallback.first_output
        check_cancel(self.cancelled)
        return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("provider-benchmark.json"))
    args = parser.parse_args()
    import onnx
    from onnx import TensorProto, helper, numpy_helper
    import onnxruntime as ort
    import sysconfig

    model_path = app_dir("models") / "probe-matmul-v1.onnx"
    weights = np.eye(128, dtype=np.float32) * 0.5
    model = helper.make_model(helper.make_graph(
        [helper.make_node("MatMul", ["x", "w"], ["y"])], "mizan-provider-probe",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, 128])],
        [helper.make_tensor_value_info("y", TensorProto.FLOAT, [1, 128])],
        [numpy_helper.from_array(weights, "w")]),
        opset_imports=[helper.make_opsetid("", 17)], ir_version=9)
    onnx.save(model, model_path)
    feeds = {"x": np.ones((1, 128), dtype=np.float32)}
    results = {"platform": sysconfig.get_platform(), "ortVersion": ort.__version__, "models": {}}
    for provider in PROVIDERS:
        selected = VerifiedModel(model_path, feeds, provider=provider)
        np.testing.assert_allclose(selected.first_output[0], 0.5, atol=1e-3)
        times = []
        for _ in range(10):
            start = time.perf_counter()
            output = selected.run(feeds)
            times.append((time.perf_counter() - start) * 1000)
            np.testing.assert_allclose(output[0], 0.5, atol=1e-3)
        results["models"][provider] = {**selected.report, "medianRunMs": float(np.median(times))}
    args.output.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
