"""Opt-in five-second MuScriptor FP16 ONNX CPU/QNN comparison; not an app model.

Unofficial cursedhelm conversion, derivative weights CC BY-NC 4.0.
No model, credential, or fixture download; use checksum-verified local files.
"""

import argparse
from collections import Counter
import gc
import json
from pathlib import Path
import time

import numpy as np
import onnxruntime as ort

from .audio import read_audio
from .benchmark import peak_memory_mib
from .muscriptor_medium_spike import MIX_SHA256, RATE, decode, log_mel, verify
from .providers import _register_windows_ml_provider, profile_evidence
from .quality_benchmark import drum_metrics, note_metrics

SHA256 = {
    "conditioner.onnx": "223f00272b0721a46f09a901d44557e43b8db199c6ecfc8484d9fb40cb22e20a",
    "conditioner.onnx.data": "f4c980a55579dacef4d6eeded1aef36fa9af508e68b2493314af4b0dc93503ab",
    "model.onnx": "058c07d7284c4ec685c128f85ddbda76b8121f00f359dd726824c42805044c83",
    "model.onnx.data": "1141677a407c13b48fc4d25d5209202bdda8e6ca5a0caec3e542a28cbe07654a",
}
LAYERS = 24
HEADS = 16
HEAD_DIM = 64


def compare(cpu: dict, candidate: dict) -> dict:
    if cpu["fixtureSha256"] != candidate["fixtureSha256"] or cpu["modelSha256"] != candidate["modelSha256"]:
        raise ValueError("CPU and QNN reports use different input or model weights")
    a, b = cpu["tokens"], candidate["tokens"]
    prefix = next((i for i, pair in enumerate(zip(a, b)) if pair[0] != pair[1]), min(len(a), len(b)))
    return {
        "sharedPrefixTokens": prefix,
        "tokenStreamsIdentical": bool(cpu["eosReached"] and candidate["eosReached"] and a == b),
        "noteEventsIdentical": bool(cpu["eosReached"] and candidate["eosReached"]
                                    and cpu["notes"] == candidate["notes"]),
        "parityComplete": bool(cpu["eosReached"] and candidate["eosReached"]),
    }


def run_decoder(session: ort.InferenceSession, condition: np.ndarray,
                max_tokens: int, deadline_seconds: float) -> tuple[list[int], dict]:
    if condition.ndim != 3 or condition.shape[0] != 1 or condition.shape[2] != 1024 or condition.dtype != np.float16:
        raise ValueError(f"Unexpected FP16 condition: {condition.shape} {condition.dtype}")
    cache = {
        f"past_key_values.{layer}.{kind}": np.empty((1, HEADS, 0, HEAD_DIM), dtype=np.float16)
        for layer in range(LAYERS) for kind in ("key", "value")
    }
    ids = np.array([[1395]], dtype=np.int64)
    tokens, elapsed = [], []
    started = time.perf_counter()
    stopped = "token limit"
    for step in range(max_tokens):
        if time.perf_counter() - started > deadline_seconds:
            stopped = "wall-clock decode deadline"
            break
        feed = {"input_ids": ids, "condition_embeds":
                condition if step == 0 else np.empty((1, 0, 1024), dtype=np.float16), **cache}
        tick = time.perf_counter()
        outputs = session.run(None, feed)
        elapsed.append(time.perf_counter() - tick)
        logits = outputs[0]
        if logits.shape != (1, ids.shape[1], 1395) or not np.isfinite(logits).all():
            raise ValueError(f"Unexpected FP16 logits: {logits.shape}")
        for layer in range(LAYERS):
            for kind in ("key", "value"):
                name = f"past_key_values.{layer}.{kind}"
                value = outputs[1 + 2 * layer + (kind == "value")]
                if value.dtype != np.float16 or value.shape != (1, HEADS, condition.shape[1] + step + 1, HEAD_DIM):
                    raise ValueError(f"Unexpected FP16 cache {name}: {value.shape} {value.dtype}")
                cache[name] = value
        token = int(np.argmax(logits[0, -1, :1393]))
        if token == 1:
            stopped = "EOS"
            break
        ids = np.array([[token]], dtype=np.int64)
        tokens.append(token)
    return tokens, {
        "eosReached": stopped == "EOS", "stopReason": stopped,
        "prefillSeconds": elapsed[0] if elapsed else None,
        "postPrefillSeconds": sum(elapsed[1:]),
        "warmDecodeMillisecondsPerToken": float(np.mean(elapsed[1:]) * 1000) if len(elapsed) > 1 else None,
        "decodeWallSeconds": time.perf_counter() - started,
        "generatedTokens": len(tokens),
        "finalCacheMiB": sum(value.nbytes for value in cache.values()) / 2**20,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--provider", choices=("cpu", "qnn"), required=True)
    parser.add_argument("--cpu-reference", type=Path, help="CPU report for QNN token/note comparison")
    parser.add_argument("--threads", type=int, default=12)
    parser.add_argument("--max-tokens", type=int, default=128)
    parser.add_argument("--deadline-seconds", type=float, default=90)
    args = parser.parse_args()
    if not 1 <= args.max_tokens <= 256 or not 1 <= args.threads <= 12 or not 5 <= args.deadline_seconds <= 120:
        parser.error("Expect 1–256 tokens, 1–12 CPU threads and 5–120 s decode budget")
    if args.provider == "qnn" and args.cpu_reference is None:
        parser.error("--cpu-reference is required for QNN comparison")
    for filename, digest in SHA256.items():
        verify(args.model_dir / filename, digest)
    fixture = json.loads(args.reference.read_text(encoding="utf-8"))
    mix = Path(fixture["referenceWav"])
    if fixture["referenceSha256"] != MIX_SHA256 or fixture["durationSeconds"] != 30:
        raise ValueError("Expected the pinned 30-second original CC0 mix")
    verify(mix, MIX_SHA256)
    total_started = time.perf_counter()
    mel = log_mel(read_audio(mix).resampled(RATE).mono()[:5 * RATE])
    preprocessing = time.perf_counter() - total_started
    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    conditioner_setup_started = time.perf_counter()
    conditioner = ort.InferenceSession(str(args.model_dir / "conditioner.onnx"),
                                       sess_options=options, providers=["CPUExecutionProvider"])
    conditioner_setup = time.perf_counter() - conditioner_setup_started
    tick = time.perf_counter()
    condition = conditioner.run(["condition_embeds"], {
        "log_mel": mel, "instrument_ids": np.array([[-1]], np.int64),
        "dataset_ids": np.array([[-1]], np.int64),
    })[0]
    condition_seconds = time.perf_counter() - tick
    if conditioner.get_providers() != ["CPUExecutionProvider"]:
        raise RuntimeError("Conditioner did not execute under CPU-only provider")
    del conditioner
    gc.collect()
    setup_started = time.perf_counter()
    decoder_options = ort.SessionOptions()
    decoder_options.intra_op_num_threads = args.threads
    decoder_options.inter_op_num_threads = 1
    decoder_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    decoder_options.enable_mem_pattern = False
    if args.provider == "qnn":
        _register_windows_ml_provider("QNNExecutionProvider")
        devices = [d for d in ort.get_ep_devices() if d.ep_name == "QNNExecutionProvider"]
        if not devices:
            raise RuntimeError("Windows ML did not expose a QNN device")
        decoder_options.add_provider_for_devices(devices, {})
        decoder_options.enable_profiling = True
        decoder_options.profile_file_prefix = str(args.output.with_suffix("")) + "-ort"
        decoder = ort.InferenceSession(str(args.model_dir / "model.onnx"),
                                       sess_options=decoder_options)
        if "QNNExecutionProvider" not in decoder.get_providers():
            raise RuntimeError("QNN session fell back to CPU")
    else:
        decoder = ort.InferenceSession(str(args.model_dir / "model.onnx"),
                                       sess_options=decoder_options, providers=["CPUExecutionProvider"])
    decoder_setup = time.perf_counter() - setup_started
    tokens, timing = run_decoder(decoder, condition, args.max_tokens, args.deadline_seconds)
    notes = decode(tokens) if timing["eosReached"] else []
    inference_total = time.perf_counter() - total_started
    profile_started = time.perf_counter()
    provider_evidence = profile_evidence(decoder.end_profiling()) if args.provider == "qnn" else {
        "nodeExecutions": {"CPUExecutionProvider": "CPU-only session"}
    }
    profile_seconds = time.perf_counter() - profile_started
    active = decoder.get_providers()
    del decoder
    gc.collect()
    predicted_drums = [{"lane": {36: "kick", 38: "snare", 42: "hihat"}.get(n["midi"], "other"),
                        "onset": n["onset"]} for n in notes if n["instrument"] == "drums"]
    output = {
        "source": "cursedhelm/cubaser-muscriptor-medium-onnx FP16",
        "license": "Original and derivative weights: CC BY-NC 4.0, noncommercial only",
        "scope": "First five seconds of original (non-isolated) pinned CC0 mix; no other inference models",
        "modelSha256": SHA256, "fixtureSha256": MIX_SHA256,
        "requestedProvider": args.provider, "registeredDecoderProviders": active,
        "conditionerProvider": ["CPUExecutionProvider"], "executedNodes": provider_evidence,
        "cpuThreads": args.threads, "preprocessSeconds": preprocessing,
        "conditionerSessionSetupSeconds": conditioner_setup,
        "decoderSessionSetupSeconds": decoder_setup, "conditionerSeconds": condition_seconds,
        **timing,
        "audioToDecodedNotesSeconds": inference_total,
        "profileWritingAndParsingSeconds": profile_seconds,
        "endToEndSeconds": time.perf_counter() - total_started,
        "peakProcessWorkingSetMiB": peak_memory_mib(),
        "instrumentCounts": dict(Counter(n["instrument"] for n in notes)),
        "nonPianoTonalNotes": sum(n["instrument"] not in ("program_0", "drums") for n in notes),
        "piano": note_metrics([n for n in notes if n["instrument"] == "program_0"],
                              [n for n in fixture["truth"]["piano"] if n["onset"] < 5])
        if timing["eosReached"] else None,
        "drums": drum_metrics(predicted_drums,
                              [n for n in fixture["truth"]["drums"] if n["onset"] < 5])
        if timing["eosReached"] else None,
        "tokens": tokens, "notes": notes,
    }
    if args.cpu_reference:
        cpu = json.loads(args.cpu_reference.read_text(encoding="utf-8"))
        if cpu["requestedProvider"] != "cpu":
            raise ValueError("Expected CPU-only reference")
        output["versusCpu"] = compare(cpu, output)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in output.items() if k not in ("tokens", "notes", "piano", "drums")},
                     indent=2), flush=True)


if __name__ == "__main__":
    main()
