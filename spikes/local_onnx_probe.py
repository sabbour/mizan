r"""Opt-in, bounded Windows ARM64 ONNX probe; no production model settings changed.

PYTHONPATH=host host\.venv\Scripts\python.exe spikes\local_onnx_probe.py demucs qnn
Run each model with qnn or dml, supplying --audio and --model-dir as needed.
Unofficial MuScriptor FP16 weights are CC BY-NC 4.0; do not redistribute.
"""

import argparse
from collections import Counter
import json
from pathlib import Path
import time

import numpy as np
import onnxruntime as ort

from mizan.engine.audio import read_audio
from mizan.engine.models import HTDEMUCS_6S, ensure_model
from mizan.engine.muscriptor_fp16_spike import run_decoder
from mizan.engine.muscriptor_medium_spike import decode, log_mel
from mizan.engine.providers import _register_windows_ml_provider, profile_evidence
from mizan.engine.separation import MODEL_RATE, MODEL_SAMPLES, SOURCES


def session(model, provider, profile):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 12
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.enable_mem_pattern = False
    options.enable_profiling = True
    options.profile_file_prefix = str(profile)
    if provider == "qnn":
        _register_windows_ml_provider("QNNExecutionProvider")
        devices = [d for d in ort.get_ep_devices()
                   if d.ep_name == "QNNExecutionProvider" and
                   d.device.type == ort.OrtHardwareDeviceType.NPU]
        if len(devices) != 1:
            raise RuntimeError(f"Expected one QNN NPU device, found {len(devices)}")
        options.add_provider_for_devices(devices, {})
        result = ort.InferenceSession(str(model), sess_options=options)
    else:
        providers = (["DmlExecutionProvider", "CPUExecutionProvider"] if provider == "dml"
                     else ["CPUExecutionProvider"])
        result = ort.InferenceSession(str(model), sess_options=options, providers=providers)
    return result


def evidence(runtime):
    path = Path(runtime.end_profiling())
    try:
        report = profile_evidence(str(path))
        report.pop("profile")
        return report
    finally:
        path.unlink(missing_ok=True)


def probe_demucs(args, result):
    audio = read_audio(args.audio).resampled(MODEL_RATE)
    samples = audio.samples[:MODEL_RATE * 5]
    if samples.ndim == 1:
        samples = np.column_stack((samples, samples))
    chunk = np.pad(samples.T, ((0, 0), (0, MODEL_SAMPLES - len(samples)))).astype(np.float32)
    model = ensure_model(HTDEMUCS_6S)
    start = time.perf_counter()
    runtime = session(model, args.provider, args.output.with_name("demucs-profile"))
    result["setupSeconds"] = time.perf_counter() - start
    result["registeredProviders"] = runtime.get_providers()
    start = time.perf_counter()
    output = runtime.run(None, {"mix": chunk[None]})[0]
    result["inferenceSeconds"] = time.perf_counter() - start
    result["executed"] = evidence(runtime)
    result["outputShape"] = list(output.shape)
    if output.shape != (1, len(SOURCES), 2, MODEL_SAMPLES) or not np.isfinite(output).all():
        raise ValueError("Invalid HT-Demucs six-stem tensor")
    result["stemRms"] = dict(zip(SOURCES, np.sqrt(np.mean(
        output[0, :, :, :len(samples)] ** 2, axis=(1, 2))).astype(float).tolist()))
    result["validSixStems"] = True


def probe_muscriptor(args, result):
    from mizan.engine.muscriptor_fp16_spike import SHA256, verify
    for name, digest in SHA256.items():
        verify(args.model_dir / name, digest)
    audio = read_audio(args.audio).resampled(16000).mono()[:80000]
    mel = log_mel(audio)
    model = args.model_dir
    condition_feed = {"log_mel": mel, "instrument_ids": np.array([[-1]], np.int64),
                      "dataset_ids": np.array([[-1]], np.int64)}
    start = time.perf_counter()
    conditioner = session(model / "conditioner.onnx", args.provider,
                          args.output.with_name("conditioner-profile"))
    result["conditionerSetupSeconds"] = time.perf_counter() - start
    start = time.perf_counter()
    condition = conditioner.run(["condition_embeds"], condition_feed)[0]
    result["conditionerSeconds"] = time.perf_counter() - start
    result["conditionerNodes"] = evidence(conditioner)
    result["conditionerProviders"] = conditioner.get_providers()
    del conditioner
    start = time.perf_counter()
    decoder = session(model / "model.onnx", args.provider,
                      args.output.with_name("decoder-profile"))
    result["decoderSetupSeconds"] = time.perf_counter() - start
    result["decoderProviders"] = decoder.get_providers()
    tokens, timing = run_decoder(decoder, condition, args.max_tokens, args.deadline_seconds)
    result.update(timing)
    result["decoderNodes"] = evidence(decoder)
    result["notes"] = decode(tokens) if timing["eosReached"] else []
    result["noteCount"] = len(result["notes"])
    result["instruments"] = dict(Counter(n["instrument"] for n in result["notes"]))
    if not timing["eosReached"]:
        raise RuntimeError("MuScriptor did not finish before the token or time limit")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", choices=("demucs", "muscriptor"))
    parser.add_argument("provider", choices=("qnn", "dml", "cpu"))
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path)
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--deadline-seconds", type=float, default=100)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.model == "muscriptor" and not args.model_dir:
        parser.error("MuScriptor requires --model-dir")
    if not 1 <= args.max_tokens <= 1024:
        parser.error("--max-tokens must be between 1 and 1024")
    if not 5 <= args.deadline_seconds <= 180:
        parser.error("--deadline-seconds must be between 5 and 180")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    result = {"model": args.model, "requestedProvider": args.provider,
              "audio": str(args.audio), "audioSeconds": 5}
    start = time.perf_counter()
    try:
        (probe_demucs if args.model == "demucs" else probe_muscriptor)(args, result)
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {str(exc)[:1000]}"
    result["totalSeconds"] = time.perf_counter() - start
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in result.items() if k != "notes"}, indent=2), flush=True)
    if "error" in result:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
