"""Opt-in MuScriptor Medium ONNX experiment (never used by the app).

The model is an unofficial CC BY-NC 4.0 conversion. Preprocessing and token
layout follow the MIT-licensed MuScriptor sources and the conversion's runtime:
https://github.com/muscriptor/muscriptor
https://huggingface.co/happyme531/muscriptor-medium-onnx
No weights or audio are downloaded by this script.
"""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import time

import numpy as np
import onnxruntime as ort
from .audio import read_audio
from .benchmark import peak_memory_mib
from .quality_benchmark import drum_metrics, note_metrics

SHA256 = {
    "config.json": "f96a1c3131459e32bd443325d39d963f0ea9a3cdd9dea8e6e2d9ab140f74302d",
    "conditioner.onnx": "c1ea7895ade9760538f42f63110a782bcc1606dee89f2ee434db2251434a3c7d",
    "decoder.onnx": "74e1181288fa5205754e9661cbccafc5182d035beadd4412da1ecd00515c3de9",
    "decoder.onnx.data": "4bc6ac2807854632bacc0ef9b5e9e1871545e573194fe7fc197948730aa3c8ef",
}
MIX_SHA256 = "fa534ecb5ab0713448a4bcd0896ff4f6fc3c19e60818e53f85e70bbd86b73438"
RATE = 16000
SECONDS = 5
SHIFT = 3
PITCH = SHIFT + 1001
VELOCITY = PITCH + 128
TIE = VELOCITY + 2
PROGRAM = TIE + 1
DRUM = PROGRAM + 130


def verify(path: Path, sha256: str) -> None:
    with path.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != sha256:
        raise ValueError(f"SHA-256 mismatch: {path}")


def log_mel(audio: np.ndarray) -> np.ndarray:
    """Match the conversion's HTK mel frontend: 2048-point FFT, 160 hop."""
    audio = np.pad(audio, (1024, 1024), mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(audio, 2048)[::160]
    window = np.hanning(2049)[:-1].astype(np.float32)
    spectrum = np.abs(np.fft.rfft(frames * window, axis=-1)).astype(np.float32)
    freqs = np.linspace(0, 8000, 1025, dtype=np.float32)
    mels = np.linspace(0, 2595 * np.log10(1 + 8000 / 700), 514, dtype=np.float32)
    points = 700 * (10 ** (mels / 2595) - 1)
    slopes = points[None, :] - freqs[:, None]
    bank = np.maximum(0, np.minimum(-slopes[:, :-2] / np.diff(points)[:-1],
                                    slopes[:, 2:] / np.diff(points)[1:])).astype(np.float32)
    return np.log(spectrum @ bank + np.float32(1e-6))[None, ...].astype(np.float32)


def tie_prompt(active: dict[tuple[int, int], float]) -> list[int]:
    prompt, previous_program = [], None
    for program, pitch in sorted(active):
        if program != previous_program:
            prompt.append(PROGRAM + program)
            previous_program = program
        prompt.append(PITCH + pitch)
    return [*prompt, TIE]


def decode_chunk(tokens: list[int], seek: float, end: float,
                 active: dict[tuple[int, int], float]) -> list[dict]:
    """Mirror upstream's chunk boundary, forced-tie and open-note rules."""
    notes = []
    in_prologue = True
    program = velocity = None
    tick = 0
    tied = set()
    for token in tokens:
        if in_prologue:
            if token == TIE:
                in_prologue = False
                velocity = None
                for key in list(active):
                    if key not in tied:
                        start = active.pop(key)
                        notes.append({"instrument": f"program_{key[0]}", "midi": key[1],
                                      "onset": start, "offset": max(start + 0.01, seek)})
            elif SHIFT <= token < PITCH:
                raise ValueError("Missing tie marker; cannot decode chunk")
            elif PROGRAM <= token < DRUM:
                program = token - PROGRAM
            elif PITCH <= token < VELOCITY and program is not None:
                tied.add((program, token - PITCH))
            continue
        if SHIFT <= token < PITCH:
            if token > SHIFT:
                tick = token - SHIFT
        elif VELOCITY <= token < TIE:
            velocity = token - VELOCITY
        elif PROGRAM <= token < DRUM:
            program = token - PROGRAM
        elif DRUM <= token < DRUM + 128:
            onset = seek + tick / 100
            if onset < end:
                notes.append({"instrument": "drums", "midi": token - DRUM,
                              "onset": onset, "offset": onset + 0.01})
        elif PITCH <= token < VELOCITY and program is not None and velocity is not None:
            onset = seek + tick / 100
            if onset >= end:
                continue
            key = (program, token - PITCH)
            if key in active:
                start = active.pop(key)
                notes.append({"instrument": f"program_{program}", "midi": key[1],
                              "onset": start, "offset": max(start + 0.01, onset)})
            if velocity:
                active[key] = onset
    if in_prologue:
        raise ValueError("Missing tie marker; cannot decode chunk")
    return notes


def decode(tokens: list[int], duration: float = SECONDS) -> list[dict]:
    """Convenience wrapper for standalone five-second decoder regression tests."""
    active = {}
    notes = decode_chunk(tokens, 0, duration, active)
    notes.extend({"instrument": f"program_{p}", "midi": pitch, "onset": onset,
                  "offset": onset + 0.01} for (p, pitch), onset in active.items())
    return sorted(notes, key=lambda note: (note["onset"], note["instrument"], note["midi"]))


def run(model_dir: Path, chunks: list[np.ndarray], max_tokens: int, threads: int
        ) -> tuple[list[dict], dict]:
    run_started = time.perf_counter()
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    conditioner = ort.InferenceSession(model_dir / "conditioner.onnx",
                                       sess_options=options, providers=["CPUExecutionProvider"])
    decoder = ort.InferenceSession(model_dir / "decoder.onnx",
                                   sess_options=options, providers=["CPUExecutionProvider"])
    load_seconds = time.perf_counter() - run_started
    if conditioner.get_providers() != ["CPUExecutionProvider"] or decoder.get_providers() != ["CPUExecutionProvider"]:
        raise RuntimeError("Expected CPUExecutionProvider for both graphs")
    notes, active, timings = [], {}, []
    for index, mel in enumerate(chunks):
        started = time.perf_counter()
        condition = conditioner.run(["condition_embeddings"], {
            "log_mel": mel, "instrument_ids": np.array([[-1]], np.int64),
            "dataset_ids": np.array([[-1]], np.int64),
        })[0]
        conditioned = time.perf_counter() - started
        if condition.shape != (1, 502, 1024) and condition.shape != (1, 503, 1024):
            raise ValueError(f"Unexpected conditioner output: {condition.shape}")
        prompt = tie_prompt(active) if index else []
        if len(prompt) >= max_tokens:
            raise ValueError(f"Chunk {index} tie prologue exceeds token budget")
        cache_length = condition.shape[1] + max_tokens + 1
        cache = {f"past_{kind}.{layer}": ort.OrtValue.ortvalue_from_numpy(
            np.zeros((1, 16, cache_length, 64), np.float32), "cpu", 0)
            for layer in range(24) for kind in ("key", "value")}
        ids = np.array([[1395, *prompt]], dtype=np.int64)
        tokens, elapsed = [], []
        for step in range(max_tokens - len(prompt)):
            prefix = condition if step == 0 else np.empty((1, 0, 1024), np.float32)
            past = 0 if step == 0 else condition.shape[1] + len(prompt) + step
            end = past + prefix.shape[1] + ids.shape[1]
            binding = decoder.io_binding()
            feeds = {
                "input_ids": ids,
                "condition_embeddings": prefix,
                "position_ids": np.arange(past, end, dtype=np.int64)[None, :],
                "seqlens_k": np.array([end - 1], np.int32),
                "total_sequence_length": np.array(end, np.int32),
            }
            for name, value in feeds.items():
                binding.bind_ortvalue_input(name, ort.OrtValue.ortvalue_from_numpy(value, "cpu", 0))
            for name, value in cache.items():
                binding.bind_ortvalue_input(name, value)
            binding.bind_output("logits", "cpu", 0)
            for layer in range(24):
                for kind in ("key", "value"):
                    binding.bind_ortvalue_output(f"present_{kind}.{layer}", cache[f"past_{kind}.{layer}"])
            tick = time.perf_counter()
            decoder.run_with_iobinding(binding)
            logits = binding.get_outputs()[0].numpy()
            elapsed.append(time.perf_counter() - tick)
            if not np.isfinite(logits).all():
                raise RuntimeError("Nonfinite decoder output")
            ids = np.array([[int(np.argmax(logits[0, :1393]))]], dtype=np.int64)
            if ids[0, 0] == 1:
                break
            tokens.append(int(ids[0, 0]))
        eos = bool(ids[0, 0] == 1)
        if not eos:
            raise RuntimeError(f"Chunk {index} did not reach EOS within {max_tokens} tokens")
        seek = index * SECONDS
        notes.extend(decode_chunk([*prompt, *tokens], seek, seek + SECONDS, active))
        chunk_wall = time.perf_counter() - started
        timings.append({
            "index": index, "seekSeconds": seek, "forcedTieTokens": len(prompt),
            "prompt": prompt, "tokens": tokens,
            "generatedTokens": len(tokens), "eosReached": eos,
            "chunkWallSeconds": chunk_wall,
            "conditionerSeconds": conditioned, "prefillSeconds": elapsed[0],
            "decodeSeconds": sum(elapsed[1:]),
            "decodeMeanMilliseconds": float(1000 * np.mean(elapsed[1:])) if len(elapsed) > 1 else None,
            "openNotesAtBoundary": len(active),
            "peakWorkingSetMiB": peak_memory_mib(),
        })
        print(f"chunk {index + 1}/{len(chunks)}: {len(tokens)} tokens, "
              f"{len(active)} open notes, {chunk_wall:.2f}s", flush=True)
    notes.extend({"instrument": f"program_{p}", "midi": pitch, "onset": onset,
                  "offset": onset + 0.01} for (p, pitch), onset in active.items())
    return sorted(notes, key=lambda note: (note["onset"], note["instrument"], note["midi"])), {
        "provider": decoder.get_providers(), "sessionLoadSeconds": load_seconds,
        "inferenceWallSeconds": time.perf_counter() - run_started,
        "generatedTokens": sum(chunk["generatedTokens"] for chunk in timings),
        "eosReached": all(chunk["eosReached"] for chunk in timings),
        "warmChunkMeanSeconds": float(np.mean([chunk["chunkWallSeconds"] for chunk in timings[1:]]))
        if len(timings) > 1 else None,
        "warmDecodeMillisecondsPerToken": (
            1000 * sum(chunk["decodeSeconds"] for chunk in timings[1:]) /
            sum(chunk["generatedTokens"] for chunk in timings[1:])
        ) if len(timings) > 1 else None,
        "cacheMiB": 24 * 2 * 16 * cache_length * 64 * 4 / 2**20,
        "peakWorkingSetMiB": peak_memory_mib(), "chunks": timings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-tokens", type=int, default=1200)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--seconds", type=int, choices=(5, 30), default=5)
    args = parser.parse_args()
    if not 1 <= args.max_tokens <= 2000 or not 1 <= args.threads <= 32:
        parser.error("Expected 1–2000 tokens and 1–32 CPU threads")
    for filename, digest in SHA256.items():
        verify(args.model_dir / filename, digest)
    config = json.loads((args.model_dir / "config.json").read_text(encoding="utf-8"))
    if (config["card"], config["initial_token_id"], config["first_reserved_token_id"]) != (1395, 1395, 1393):
        raise ValueError("Unexpected MuScriptor tokenizer/configuration")
    reference = json.loads(args.reference.read_text(encoding="utf-8"))
    mix = Path(reference["referenceWav"])
    if reference["referenceSha256"] != MIX_SHA256 or reference["durationSeconds"] != 30:
        raise ValueError("Expected the pinned 30-second CC0 fixture")
    verify(mix, MIX_SHA256)
    start = time.perf_counter()
    audio = read_audio(mix)
    mono = audio.resampled(RATE).mono()[:RATE * args.seconds]
    chunks = [log_mel(mono[start:start + SECONDS * RATE])
              for start in range(0, len(mono), SECONDS * RATE)]
    preparation = time.perf_counter() - start
    notes, runtime = run(args.model_dir, chunks, args.max_tokens, args.threads)
    truth = [n for n in reference["truth"]["piano"] if n["onset"] < args.seconds]
    drum_truth = [n for n in reference["truth"]["drums"] if n["onset"] < args.seconds]
    drum_names = {36: "kick", 38: "snare", 42: "hihat"}
    predicted_drums = [{"lane": drum_names.get(n["midi"], f"midi_{n['midi']}"),
                        "onset": n["onset"]} for n in notes if n["instrument"] == "drums"]
    summary = {
        "scope": f"Original, non-isolated first {args.seconds} seconds of pinned 30-second CC0 mix; {len(chunks)} consecutive chunks.",
        "license": "Derivative and original model weights: CC BY-NC 4.0 (noncommercial only).",
        "source": "happyme531/muscriptor-medium-onnx W4A32 optimized; upstream MuScriptor Medium",
        "fixtureSha256": MIX_SHA256, "modelSha256": SHA256,
        "limitations": "Unconditioned greedy decoding with forced cross-chunk tie prologues; no CFG, MIDI postprocessing or velocity. The 5s run truncates fixture labels across its boundary; 30s runs cover the full fixture. The converter reports only 81.25% top-1 64-step synthetic smoke parity versus PyTorch. Not NPU.",
        "audioSeconds": args.seconds, "cpuThreads": args.threads,
        "preprocessSeconds": preparation,
        **runtime,
        "totalWallSeconds": preparation + runtime["inferenceWallSeconds"],
        "musicSecondsPerWallSecond": args.seconds / (preparation + runtime["inferenceWallSeconds"]),
        "complete": runtime["eosReached"],
        "noteCount": len(notes),
        "instrumentCounts": dict(Counter(note["instrument"] for note in notes)),
        "piano": note_metrics([n for n in notes if n["instrument"] == "program_0"], truth)
        if runtime["eosReached"] else None,
        "drums": drum_metrics(predicted_drums, drum_truth) if runtime["eosReached"] else None,
        "falsePositiveNonPianoTonalNotes": sum(n["instrument"] not in ("program_0", "drums") for n in notes),
        "notes": notes,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "notes"}, indent=2))


if __name__ == "__main__":
    main()
