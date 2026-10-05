# Local ONNX provider spike (Windows ARM64, September 29, 2026)

Opt-in only: no production engine, Azure resources, or model weights are changed.
Input is **the same five seconds (15–20 seconds of the source)** from the
[Navy Band Southwest “New Mexico March” video](https://www.youtube.com/watch?v=u7ODP3CZC2Y)
for both models and every provider. The locally generated
`spikes\local_onnx_results\navy-15-20.wav` has SHA-256
`264a08659658f8950683879f4fba65b1af149abbebfd34be8f9776c283db07ed`.
The Navy recording is public domain; the unofficial MuScriptor FP16 model
derivative is **CC BY-NC 4.0**, not suitable for a commercial distribution.
No ground-truth score exists for this passage: note counts measure execution
and output validity, **not transcription accuracy**.

Run from repository root in a shell with `PYTHONPATH=host` and the existing
`host\.venv\Scripts\python.exe` (ORT Windows ML 1.27). First create the WAV:

```powershell
$env:PYTHONPATH = 'host'
$navy = "$env:USERPROFILE\.copilot\session-state\<session-id>\files\navy-demo\excerpt-15-35.wav"
$model = "$env:USERPROFILE\.copilot\session-state\<session-id>\files\muscriptor-medium-fp16-graph"
New-Item -ItemType Directory -Force spikes\local_onnx_results | Out-Null
host\.venv\Scripts\python.exe -c "from pathlib import Path; from mizan.engine.audio import read_audio, write_audio, Audio; a=read_audio(Path(r'$navy')); write_audio(Path(r'spikes\local_onnx_results\navy-15-20.wav'), Audio(a.samples[:5*a.rate],a.rate))"
foreach ($provider in 'cpu','qnn','dml') {
  host\.venv\Scripts\python.exe spikes\local_onnx_probe.py demucs $provider `
    --audio spikes\local_onnx_results\navy-15-20.wav `
    --output "spikes\local_onnx_results\demucs-$provider.json"
  host\.venv\Scripts\python.exe spikes\local_onnx_probe.py muscriptor $provider `
    --audio spikes\local_onnx_results\navy-15-20.wav --model-dir $model `
    --max-tokens 1024 --deadline-seconds 155 `
    --output "spikes\local_onnx_results\muscriptor-$provider-complete.json"
}
```

Run hardware probes **one at a time** to avoid resource contention. The
script pins QNN to the **NPU device**, rather than QNN's second GPU device;
DirectML selects the GPU. ONNX Runtime profiling counts *executed nodes* for
each graph; a registered provider alone is insufficient evidence. The script
checks all four MuScriptor model hashes against the existing pinned conversion.
Its single 7.8-second padded HT-Demucs segment yields six stems covering the
same five seconds. Model setup and inference are separately timed; the overall
duration also includes input preparation, profile parsing and Python cleanup.
The 100-second initial MuScriptor runs hit 256 tokens without EOS; the complete
runs below allowed up to 1,024 tokens and 155 seconds.

| Model/provider | Executed graph nodes | Setup / inference | Result |
| --- | --- | --- | --- |
| HT-Demucs CPU | 1,170 CPU | 10.73 / 4.58 s | Valid finite `[1,6,2,343980]` tensor; all six named stems have finite RMS |
| HT-Demucs QNN NPU | None confirmed | >100 s setup before manually stopping | QNN rejects Reshape nodes (3110), fails graph finalization (1002), remains stuck; no six-stem output |
| HT-Demucs DirectML GPU | No successful inference | 5.36 s setup; failure after 12.85 s total | `DmlFusedNode_0_0`: `8007000E` not enough memory resources; no six-stem output |
| MuScriptor FP16 CPU | Conditioner 8 CPU; decoder 311,708 CPU | 0.01 + 1.51 s setup; 14.36 s decode; 26.10 s total | EOS, 297 tokens, 103 program-57 note events |
| MuScriptor FP16 QNN NPU | Conditioner 8 CPU, **zero QNN**; decoder 274,458 CPU + 7,450 QNN fused partition executions | 0.30 + 3.77 s setup; 16.44 s decode; 30.01 s total | EOS, same 297 tokens and 103 note events as CPU; **slower** |
| MuScriptor FP16 DirectML GPU | Conditioner 8 DML; decoder 188,100 DML + 37,500 CPU | 0.08 + 0.54 s setup; 98.00 s decode; 106.71 s total | EOS, 299 tokens and 104 program-57 notes; differs from CPU |

Node counts are execution events, not percentage of compute or silicon
utilization. QNN decoder is **mixed NPU/CPU**, not NPU-only; DML is mixed
GPU/CPU. Results are one run each on a shared machine, not statistically
stable benchmarks. The DML note difference is not independently validated.
HT-Demucs QNN was stopped after graph-finalization failure and ~100 seconds;
the run was bounded operationally, not by a model-level timeout.

**Recommendation:** keep CPU for these exact ONNX graphs. For NPU Demucs,
re-export or partition unsupported reshape/ISTFT operations and test a
smaller NPU-compatible graph; for GPU Demucs, diagnose memory allocation on
this driver before promising acceleration. For MuScriptor, offload more of
the decoder and recheck output parity/latency before using either provider
in production.
