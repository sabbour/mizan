# Mizan desktop host

Requires Python 3.12 ARM64, the Windows WebView2 runtime, and the ARM64
.NET 10 Desktop Runtime. From the repository root:

```powershell
uv venv --python "$env:LOCALAPPDATA\Programs\Python\Python312-arm64\python.exe" host\.venv
uv pip install --python host\.venv\Scripts\python.exe -e "host[dev]"
$env:MIZAN_DEV_URL = "http://localhost:5173"
host\.venv\Scripts\python -m mizan
```

The host pins the pending pywebview ARM64/CoreCLR fix until that support is
available in a release.

Start the Vite server separately. Without `MIZAN_DEV_URL`, the host loads
`ui\dist\index.html`. Data lives in `%LOCALAPPDATA%\Mizan`; `MIZAN_HOME` overrides
this location. Downloads, cache, logs, and temporary directories are created
only when requested.
The host writes diagnostics to `%LOCALAPPDATA%\Mizan\logs\mizan.log`, or
`%MIZAN_HOME%\logs\mizan.log` when `MIZAN_HOME` is set. The active log is capped
at 5 MiB with three rotated backups. Cloud runs record a generated run ID,
Container Apps execution ID and status changes; failed Azure requests include
their HTTP status and Azure request ID. Logs do not include access tokens,
recording audio, or transcript content. Review the log before sharing it.

For an isolated development library that uses already-downloaded model weights,
set `MIZAN_MODELS_DIR="$env:LOCALAPPDATA\Mizan\models"` alongside `MIZAN_HOME`.
Only model files are shared; the song library and cached recordings stay isolated.

Check `sysconfig.get_platform()` for `win-arm64`; `platform.machine()` can report
ARM64 even for an emulated x64 interpreter. If `uv` downloads fail with a TLS
handshake error, use the environment's configured pip feed:

```powershell
host\.venv\Scripts\python -m ensurepip
host\.venv\Scripts\python -m pip install -e "host[dev]"
```

The JS bridge exposes `start_job`, `get_job`, `cancel_job`, `list_jobs`, and
`open_result`. Responses contain `ok` and either job data or a structured error.
Completed engine jobs return `{ok, job, song, artifacts, stems}` from `open_result`.
`song` uses the workspace's beats-based shape, plus generated `accompaniment`
notes, unquantized seconds, warnings, model versions, and diagnostics.
`artifacts` contains file URIs for analysis JSON, MIDI, decoded original audio,
and six sample-aligned WAV stems. `stems` lists the mix first, then vocals,
piano, guitar, bass, drums, and other URLs with relative RMS levels.
Stems whose isolated signal is too weak are omitted, including vocal leakage
whose brief peaks would otherwise appear as a false vocal listening track.
Unknown jobs return `job_not_found`; invalid instruments return `invalid_instrument`.

### Score imports and public MIDI search

`import_file(name, dataBase64)` uses the existing MIDI/MusicXML parser and library
path. The UI asks before it imports a MIDI file opened from Windows, selected in
the picker, or dropped onto the app. `search_midi_commons` and
`search_midi_mutopia` and `search_midi_archive` are separate provider calls so
one slow or failed source does not block YouTube or the other MIDI sources.
They offer only per-file Public Domain, CC0, CC BY, and CC BY-SA results.
Archive search currently accepts only the exact per-item CC0 URL and only
original MIDI files with verified size and any listed hashes.
`import_midi_result` accepts
only a result returned by those searches, follows HTTPS redirects only on the
approved provider hosts (including Archive storage subdomains), limits downloads
to 2 MiB, checks the MIDI header, and then uses the same score-import parser and
storage path. Imported provider entries retain the source page, artist, license,
and attribution.

Video search also calls `search_youtube_music` independently. It uses yt-dlp
against `music.youtube.com/search` without credentials, keeps only video IDs,
and returns canonical YouTube watch URLs for the existing transcription path.
The UI merges the two video lists by ID and keeps each provider's loading or
error status visible.

The Library landing page lazily fetches two public YouTube Music playlists in
parallel through yt-dlp, without credentials or media downloads. The lead
editorial shelf is **Today's Biggest Hits — The Hit List**; its playlist order
is not presented as a chart. The secondary **Top 100 Songs Global** playlist
is published by YouTube Music Global Charts, and its description and playlist
order provide the chart label and ranks. Each shelf reports its own failure,
so one unavailable playlist does not hide the other. Successful
responses are cached in memory for six hours; a complete refresh failure shows
the last successful snapshot and its date. Cards link to the source video on
YouTube and YouTube Music, and only the explicit Transcribe button starts work.

### Single-user Azure GPU offload

See the editable [Cloud architecture diagram](../docs/cloud-architecture.drawio)
for setup, the runtime data path, and the preflight boundary.

The bridge exposes `azure_subscriptions() → {ok:true,subscriptions:[{id,name,tenantId}]}` through
Azure Identity's default credential chain, `cloud_status() → {ok:true, available:boolean, configured:boolean, mode:"local"|"cloud", config?:{tenantId,subscriptionId,resourceGroup,storageAccount,container,jobName,location,registry,vnet,subnet,vnetCidr,subnetCidr,environment,identity}, prepared?:boolean, jobCreated?:boolean, issue?:string}`,
`configure_cloud(config: dict) → cloud_status` (resource identifiers, no client secret),
`prepare_cloud(config, consent:true) → {prepared:true, identityPrincipalId, identityClientId, containerScope, registryScope, next}`,
`build_cloud_worker() → {image,digest}`,
`finish_cloud(imageDigest, useSavedToken:bool) → {jobCreated:true, configured:false, next}`,
`set_processing_mode("local"|"cloud") → {ok:true, mode}` and
`clear_cloud() → cloud_status`. Invalid mode/readiness returns `{ok:false,error:{code:"cloud_failed",message}}`.
Cloud configuration contains no Azure credential. Sign in with an Azure Identity
credential available to the packaged app (for example, `az login` with Azure CLI
installed), then select an accessible subscription in the wizard. Nonsecret
resource settings and mode are stored in the host SQLite database; Azure
access tokens are obtained on demand and reused in memory until shortly before
expiry, never saved to disk.
Local remains the default. Cloud selection requires valid saved Azure settings,
a recorded GPU Job, a bundled worker, and a supported model, but does not wait
for a live Azure check. A revised GPU worker
can produce original-mix and vocal-stem MuScriptor events plus six HT-Demucs
WAVs, and the host can validate and import these results without running its
local separation or transcription. The combined worker produced six verified
stems and mix/vocal note lists on an A100 GPU with a synthetic recording; the
full Small-model host path also saved a song at 2/8. T4-profile pilot
executions still fail before container startup (see the pilot README).
Wizard provisioning and orphan retention have **not** been verified in live Azure;
role assignments may require elevated permission or an Azure administrator. The transport deletes
known files after a terminal failed execution and after a successful library
save, but retains input when Job start may have succeeded without returning an
execution name. `cloud_status.available:true` means this build includes the
Cloud worker; `verifiedModels` currently contains Small, while `supportedModels`
contains Small, Medium and Large. `configured:false` means this customer's Azure identity
and Job are not yet ready. A developer's CLI-token
pilot does **not** verify any customer's Azure identity.
`set_processing_mode("cloud")` saves processing intent, not Azure readiness.
Invalid or incomplete local setup returns `cloud_failed`. `configure_cloud`
validates and stores nonsecret identifiers **without provisioning Azure resources**.
On successful Cloud selection the host returns the saved local setup snapshot;
the UI still requires a live access check before it calls Azure ready. If access
is unknown or a check fails, check the existing Azure setup instead of starting
new environment provisioning. Model sizes use per-execution budgets in the
selected Container Apps environment; choosing a larger model does not require a
new environment. Once selected, Cloud remains selected across restarts and
temporary readiness failures.
New analysis and Redo analysis snapshot the selected processing mode and MuScriptor
size; queued jobs and retries keep that snapshot. A Cloud job that cannot pass
execution preflight fails explicitly rather than using local model inference.
Adding a YouTube link creates its queue entry before fetching video metadata;
inspection errors are reported by that job, and the UI shows pending submission
and prevents duplicate clicks while the host is accepting it.
The Song analysis panel checks Azure asynchronously with a 120-second overall
readiness deadline and shows the current local check stage while it waits.
Concurrent panel checks share the same read-only verification, and successful
results are reused for up to 30 seconds; execution preflight still checks Azure
again before starting GPU work. Closing the panel or choosing
Cancel check cancels only that request, never provisioning or an analysis job.
An in-progress Azure credential request may finish in the background, but a
cancelled or timed-out check does not continue subsequent readiness requests or
overwrite newer UI state.
Only after explicit cost consent, `prepare_cloud` creates a dedicated resource
group in the chosen subscription, private Blob storage/container, a one-day `jobs/` expiry
policy, authenticated ACR, user-assigned identity and an ACA environment with an
A100 GPU profile. New setup defaults to a Mizan-managed VNet
(10.42.0.0/16, delegated 10.42.0.0/23 subnet); Custom VNet prepopulates
editable VNet/subnet names and private IPv4 address ranges, then creates both
after approval. Existing saved no-VNet and existing-subnet configurations remain
supported by the host. Retrying the same saved setup checks all existing
resource shapes before creating missing infrastructure and leaves
existing-pilot Job semantics unchanged. This can incur idle costs.
After cost consent, a new or resumed non-pilot setup also creates or reuses
`mizan-aca-env-logs` in the same resource group and connects the environment's
future console and system logs. Log Analytics uses the PerGB2018 SKU and 30-day
retention; ingestion can add ongoing charges, and logs from past Job runs are
not backfilled. An existing-pilot setup remains read-only for logging until the
user separately approves the workspace and ingestion charges. Mizan keeps only
the workspace resource ID, customer ID and region locally; the shared key stays
in memory and is sent only in the environment's logging configuration.
`build_cloud_worker` uploads the small bundled Docker context and schedules
an Azure Container Registry Linux amd64 build. ACR build time is billable.
Its resulting immutable SHA-256 image digest is pinned for `finish_cloud`,
which creates a dormant manual Job using the **lowest tested 2-vCPU/8-GiB
request**. It does not start a Job. The profile's
24-vCPU/220-GiB capacity is **not** its minimum request; smaller than 2/8
has not been validated.
Azure accepted 8-vCPU/32-GiB, 4-vCPU/16-GiB and 2-vCPU/8-GiB pilot Job
configurations. The combined worker's eight-second **Small** synthetic run
succeeded at 4/16 in 166 seconds and a second 2/8 real A100 Job completed
the full host import/save (six checked stems, analysis, MIDI, MusicXML) and
remote Blob cleanup without invoking local separation or transcription. An initial
test asserted cleanup before its async deletion completed; a subsequent
remote listing showed zero `jobs/` Blobs, and the test now waits for cleanup.
Large completed a synthetic A100 worker run at 2/8 in 230 seconds, with
PyTorch CUDA notes, CUDA HT-Demucs and six stems. Its **full host pipeline**
has not been validated; Medium has not completed a live GPU worker run either.
All three sizes are selectable for Cloud, with this validation gap disclosed
in the app; Medium and Large may require more resources.
Each Cloud execution uses a conservative per-model resource budget: Small 2 vCPU /
8 GiB, Medium 4 vCPU / 16 GiB, and Large 8 vCPU / 32 GiB. These are policy
allocations, not measured minimums or proof that a model completes successfully.
Before starting a run, the host reads the saved Job and builds the request from
the fields supported by the [2024-03-01 Start API](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/jobs/start?view=rest-resource-manager-containerapps-2024-03-01):
top-level `containers` and `initContainers`, with container `name`, `image`,
`args`, `command`, `env` and `resources`. Job-only fields such as `volumes` and
`scale` are not copied into the start request; neither are unsupported
`volumeMounts`, probes or read-only `resources.ephemeralStorage`. The existing
Job and its volume definitions are not patched.
The host raises only the worker container's resources to the selected budget
when needed and never reduces a larger existing request.
Customer preflight checks the deployed Job's CPU/memory against the saved
requests; changing them requires registering the updated Job.
Accepted 2/8 and successful Small/Large worker runs do not guarantee lower
billing. A matching existing 2/8 or 4/16 pilot can be registered without
changing its resource requests; new Jobs default to 2/8.
The pilot's validated image digest is
`sha256:5fe0f3b2fc894a8e9c3079baf3cc59f0f3b297ab049bc730d59882bfb8b79c5a`.
A build in another registry gets its own digest; the Job must use that
registry's completed-build digest, not a mutable tag or the pilot digest.
Existing-job adoption also accepts 8 vCPU / 32 GiB on the same A100 profile.
Readiness recognizes the authorized upgrade from a saved 2/8 or 4/16 pair to
8/32 without changing Azure resources or transferring secrets; unchanged
ephemeral storage, image, identity, secret binding and private-storage checks
remain required. Other resource mismatches and downgrades remain unready.
This compatibility is not evidence that Large succeeds or that 32 GiB is its
minimum memory requirement.
Sweden Central's stated component rates are $0.000688/GPU-s,
$0.000024/vCPU-s and $0.000003/GiB-s, roughly $0.000760/s for 2/8 and
$0.175 for the 230-second Large worker run before other charges; check
current regional prices and bills.
The desktop Azure identity needs Blob Data Contributor on the container;
the Job identity needs Blob Data Contributor on the container and AcrPull
on the registry. RG Contributor alone cannot grant these roles; if automatic
role assignments fail, an administrator must grant them at the indicated
scopes. `finish_cloud` checks the scoped grants and reports missing permissions
before creating the Job. For a new Job, explicit transfer approval lets the
host read the previously saved Hugging Face token from Windows Credential Manager
and send it once to Azure ARM as Job secret `hf-token`, binding
`HF_TOKEN=secretref:hf-token`; the token never reaches the web UI or host settings.
Existing-pilot mode checks security settings
without modifying existing resources. Setup never enables Cloud. Customer
`configured` requires the current desktop Azure credential to access a Job
with pinned image, correct manual A100 profile and managed identity, HF
secret binding, exact scoped Blob/ACR grants, a private HTTPS-only Blob
container and a successful Blob **data-plane HEAD** using that identity.
These checks run again before enabling Cloud and on Cloud selection; losing
permissions or changing the Job resets mode to Local. No first customer
Cloud Job is required to establish readiness, and no developer-harness
proof is copied into customer settings.
Previously queued Cloud jobs fail rather than publishing a locally separated
score labelled Azure GPU. See
[`spikes\aca_gpu\README.md`](..\spikes\aca_gpu\README.md) for prerequisites,
data retention, RBAC, quota and deployment limitations.
If a Cloud run fails, use the run ID and Azure request ID in `mizan.log` when
checking Azure diagnostics. The host obtains scoped Azure Identity tokens for
its Blob and Job requests, but never writes those tokens to the log. The known
T4 pilot failure occurred before a container started; it is evidence of an ACA
GPU-profile startup/scheduling problem, not a worker inference failure. The
pilot evidence does not determine whether regional capacity or another Azure
platform issue caused it; see the spike README for details.

The A100 pilot logs also captured two earlier, image-specific worker failures:
an ONNX Runtime 1.22 image could not load `libcublasLt.so.12`, and the
`combined-20260929-linked` image refused separation because HT-Demucs did not
select CUDA exclusively. The worker now pins ONNX Runtime 1.20.2 with its
CUDA libraries available and uses the corrected CUDA-provider guard. The
current A100 Job uses `combined-20260929-a100`, which later succeeded as
execution `mizan-gpu-transcribe-2cluljy`; those historical failures do not
indicate that the current image is broken.

At the time of this diagnosis, this desktop's database was still in
`processing_mode=local`. It had saved Cloud identifiers but no prepared
environment, registered Job, or runtime verification, so it had not submitted
a host Cloud run. This local setup state is separate from the historical
failures recorded by the pilot Job.

One background worker runs jobs sequentially. Pipelines receive
`(job, report(stage, progress), cancelled)` and must check the cancellation event
during long operations. Progress is a fraction from 0 to 1; completed jobs finish
at `finalize`, 1. Only completed jobs are reused, keyed by video ID, instrument,
selected transcription model, and pipeline/model version, including beat/provider overrides. Missing or
malformed analysis caches are not reused. Jobs inspect/download YouTube audio
with yt-dlp, decode with FFmpeg, separate candidate stems, transcribe the chosen
instruments (both piano and drums in auto mode), analyze harmony, generate accompaniment/MIDI, and publish artifacts
atomically. Host shutdown requests cancellation and waits for the worker.
Job records and result manifests persist in SQLite; interrupted jobs are not
automatically resumed. Long recordings receive duration/disk warnings, not a cap.

FFmpeg must be installed separately. The engine looks at `MIZAN_FFMPEG`, `PATH`,
then the existing Gyan FFmpeg WinGet installation. YouTube extraction is for
personal use and may break as YouTube changes; access restrictions and download
errors are surfaced, not bypassed. If YouTube denies a direct audio stream with
HTTP 403 but offers HLS audio, the downloader retries that stream before failing.

Initial stem levels prioritize work but never exclude auto-mode piano and drums;
the vocal pass requires an audible isolated vocal stem. Without transcribed
pitched notes, chord labels and generated accompaniment are withheld.
Jobs expose `selectedInstruments`, `transcribedInstruments`, and
`transcriptionQuality` with actual event counts, confidence/energy/timing checks,
and reasons. Weak results remain playable as tentative/low-confidence drafts;
empty attempts are reported explicitly.

The basic command above installs Windows ML's ONNX Runtime build. Install the
Windows App SDK Runtime if it is not already present; Windows ML uses it to load
the shared runtime and to acquire certified execution providers such as Qualcomm
QNN on first use.

```powershell
winget install Microsoft.WindowsAppRuntime.2.3
host\.venv\Scripts\python -m pip install -e "host[probe]"
```

`MIZAN_PROVIDER=auto|qnn|dml|cpu` controls model provider preference; unavailable
or unverified accelerators fall back to CPU. In `auto`, each model owns its
measured order: HT-Demucs uses ARM CPU, while Beat This! uses
DirectML with CPU for unsupported nodes. `MIZAN_BEATS=dsp` selects the
lower-quality onset-grid fallback for timing, not a different note transcriber.
HT-Demucs and Beat This! download their weights on first use into
`%LOCALAPPDATA%\Mizan\models`.

In Library → How Mizan finds notes, select official MuScriptor
Small, Medium, or Large on CPU for new songs; Small is the default. MuScriptor reads
the original recording; HT-Demucs still separates the mix into listenable
parts. MuScriptor maps GM drum tokens to kick, snare, closed/open hat, floor
tom, high tom, ride, and crash lanes. Its other detected instrument labels
become individual tentative pitched-note tracks, not piano-only results.
These are original-mix detections rather than validated instrument-isolated
scores. Only the exact `clean_electric_guitar` label gets GM program 28 and is
included in MIDI and MusicXML exports; other unverified detected labels are
omitted from exports.

MuScriptor's gated, noncommercial checkpoints are required for audio transcription and unbundled.
Accept each size's terms at its Hugging Face model page and save a read-access
token in Windows Credential Manager through Library settings; its separate
Download button then shows transferred bytes and speed. The token must belong
to the account that accepted **that model's** terms. Before selection, Mizan
checks free physical RAM (Small/Medium/Large: 6/10/20 GiB), available Windows
commit (4/8/16 GiB), and disk space for a missing checkpoint plus 1 GiB
headroom. Large's CPU worker is capped at 16 GiB and uses up to four threads;
Medium uses up to twelve. Model errors identify the checkpoint or runtime
problem. Completed downloads are checksum-verified.

See [ENGINE.md](ENGINE.md) for the exact contract, measured hardware results,
licenses, historical comparisons, and limitations.

```powershell
host\.venv\Scripts\python -m pytest host\tests -q
# Include the real-model integration test without network access:
$env:MIZAN_TEST_MODEL = "$env:LOCALAPPDATA\Mizan\models\basic-pitch-icassp-2022.onnx"
host\.venv\Scripts\python -m pytest host\tests -q

host\.venv\Scripts\python -m mizan.engine.providers --output host\provider-benchmark.json
host\.venv\Scripts\python -m mizan.engine.benchmark --seconds 60 --probe-model-providers --output host\engine-benchmark.json

# Downloads checksum-pinned CC0 source samples, builds a 30-second reference,
# and runs the normal analysis pipeline with an isolated temporary MIZAN_HOME.
host\.venv\Scripts\python -m mizan.engine.real_sample_benchmark `
  --samples <artifact-directory>\samples `
  --output <artifact-directory>\real-sample-benchmark.json
```

### Opt-in piano model comparison

`kong_piano_benchmark` uses the **existing** `real-sample-model-comparison.json`
30-second CC0 report, not a newly assembled fixture. Supply the separate
[Kong ONNX conversion](https://github.com/MingjiWang/kong-piano-transcription-onnx/releases/tag/v1.0.0)
(`kong_CRNN_note_F1.0.9677_pedal_F1.0.9186.onnx`, SHA-256
`d2aff853e4112f9ccdd67526daa8b130e8a955a90b65289e0f836b4c6bcb753a`);
the runner verifies the model and both WAVs before running, and does not
download or install weights. The converted weights are
[CC-BY-4.0](https://zenodo.org/records/4034264): credit Kong, Li, Song, Wan
and Wang, *High-resolution Piano Transcription with Pedals by Regressing Onsets
and Offsets Times* (2020), and ONNX conversion by Mingji Wang.

```powershell
$env:PYTHONPATH = "host"
host\.venv\Scripts\python -m mizan.engine.kong_piano_benchmark `
  --reference <artifact-directory>\real-sample-model-comparison.json `
  --model <artifact-directory>\kong_CRNN_note_F1.0.9677_pedal_F1.0.9186.onnx `
  --output <artifact-directory>\kong-piano-comparison.json
```

Both models receive the same **clean piano** and **piano+drums mix** WAVs,
without separation or the pipeline's mix/stem gating. Kong uses upstream 16 kHz,
10-second/50%-overlapped inference and regression onset/offset decoding at its
default 0.3/0.3/0.1 thresholds; pedal events are not applied. Basic Pitch uses
its current direct decoder. The runner scores both against the existing 45
note labels using `note_metrics`: pitch within 15 cents, onset within 150 ms,
and full-note offset within max(50 ms, 20% of reference duration). Older
reports used exact MIDI-pitch matching and are not directly comparable. It
includes the existing **separated-mix pipeline** Basic Pitch score only as
context, not as a same-input comparison.

On Snapdragon X Elite (September 27, 2026), direct Basic Pitch versus Kong
pitch/onset F1 and full-note F1 were **.967 / .418 versus .848 / .261** on the
clean piano, and **.776 / .000 versus .953 / .488** on the raw mix. Direct
Basic Pitch had 2/7 unmatched predicted attacks on piano/mix; Kong had 8/0.
Matched full notes were 19/0 for Basic Pitch and 12/21 for Kong.
These counts reflect this fixture's labels, not arbitrary confidence cutoffs.
Direct Basic Pitch took 1.4/1.1 s; Kong took 22.9/25.2 s including its session probe.
Both executed on ARM CPU; the process high-water working set was 733 MiB across
the sequential runs (not per-model allocation). Runtime was not controlled for
other system workloads. The full report is
`kong-piano-comparison.json` alongside the existing benchmark report. These
assembled, cropped sample tails are not independently played releases; one
fixture cannot establish general piano accuracy or sustain performance.
Kong is **not** selected by the application: its clean-stem result is worse.

The job-panel status regression runs with `cd ui; node tests\job-status.mjs`.

### Experimental MuScriptor Medium comparison

`mizan.engine.muscriptor_medium_spike` is an **opt-in experiment** using an
unofficial ONNX conversion, separate from the app's official MuScriptor
selection. It transcribes the full 30 seconds of
the original, non-isolated, SHA-256-pinned CC0 comparison mix in six
consecutive five-second chunks (`--seconds 5` runs only the first); no other
transcription, rhythm, or chord model runs. Supply the local `w4a32_optimized`
directory containing `config.json`, `conditioner.onnx`, `decoder.onnx`, and
`decoder.onnx.data` from
[the unofficial conversion](https://huggingface.co/happyme531/muscriptor-medium-onnx).
The command checks all four SHA-256 digests before loading. **The original and
derivative weights are CC BY-NC 4.0, for noncommercial use only; comply with
the source model's audio-rights conditions.** No model is bundled or
automatically downloaded; keep weights and JSON reports out of the repository.

Run from `host` with the project venv:

```powershell
.\.venv\Scripts\python.exe -m mizan.engine.muscriptor_medium_spike `
  --model-dir "$env:USERPROFILE\.copilot\session-state\<session-id>\files\muscriptor-medium-spike\w4a32_optimized" `
  --reference "$env:USERPROFILE\.copilot\session-state\<session-id>\files\real-sample-model-comparison.json" `
  --seconds 30 --threads 12 `
  --output "$env:USERPROFILE\.copilot\session-state\<session-id>\files\muscriptor-medium-spike\thirty-second-12threads-report.json"
```

On Windows ARM64 with 8 CPU threads, all six chunks reached EOS (251 model
tokens total). The runner teacher-forces each new chunk's tie prologue from
the previous chunk's open notes; notes retain their original onset through
later chunks. It decoded 43 piano notes and 70 drum hits. Piano onset+pitch
matched **37/45 labels** within 150 ms/15 cents (F1 **0.841**, six unmatched
predictions); onset+pitch+offset matched **0/45** within max(50 ms, 20% of
reference note length), with mean matched-offset error **0.56 s**. Drums
matched **58/60** hits within 50 ms (onset F1 **0.892**); 12 extra hats
and two missed hits. No non-piano tonal notes were predicted. The 30-second
fixture covers an assembled, regular piano-and-drums progression, **not**
performance-quality music or a representative real-song benchmark.

The first chord's recorded token stream begins `1134` (tie), `54`
(51-centisecond shift), `1135` (piano program), `1133` (note-on),
`1080,1084,1087` (MIDI 76/80/83). It later emits `255` (252-centisecond
shift), `1132` (note-off), and `1080,1084,1087` again. The
[official MuScriptor `OpenNoteTracker`](https://github.com/muscriptor/muscriptor/blob/7f213afecf23bd6a1b8672aa223690ee9807cefb/muscriptor/events.py)
and our decoder independently produce the same 0.51–2.52 s notes; all
**113/113** saved notes matched its onsets and offsets. Our log-mel frontend
versus the conversion's public reference had mean absolute difference
`9.2e-6` (maximum `9.3e-4`) on the first chunk. The **0/45** full-note
result therefore reflects this conversion's explicit token offsets under
this frontend, **not a note-decoder offset bug**; it does *not* establish
whether the official FP32 checkpoint would produce the same notes.

The earlier five-second single-chunk run matched 7/9 piano onsets/pitches
(F1 0.824), 0/9 full notes and 10/10 drum hits with two extra hats.
Its 4.5-second chord crosses the artificial clip boundary, so note-offset
metrics from that run are especially limited; the 30-second measurement
includes the full fixture.

Both graphs used **CPUExecutionProvider only**, not QNN/NPU. On the 12-core
Snapdragon X Elite, the 12-thread run spent **0.27 s preprocessing** and
**0.60 s loading ONNX sessions**. Its six chunks took 1.65–1.91 s each
(five post-first chunks averaged **1.78 s**); decoder prefills took 1.16–1.36 s
per chunk and post-prefill decoding averaged **12.6 ms/token** across warm
chunks. Total preprocessing + loading + inference was **11.55 s for 30 s
of music (2.60 music-seconds per wall-second)**; peak process working set
was **631 MiB**, including a ~319.5 MiB shared KV allocation. A second
12-thread run recording token streams was **2.47× real-time**, with ~633 MiB
peak working set and unchanged note metrics. For comparison,
the earlier eight-thread run took ~0.42 s preprocessing + 12.92 s including
~0.67 s session loading (13.33 s total, **2.25× real-time**, 632 MiB peak).
These are single runs, not controlled throughput trials. The 12-core ARM
**CPU is viable for this Medium fixture**; without comparable NPU graph
placement, latency, power, and quality measurements there is **no basis to
assert NPU is better**. The separate official Large CPU benchmark is reported
below; these different implementations do not establish a general winner. Measurements vary with
cache/thermal state. This adapter does not implement the upstream
classifier-free guidance, velocity,
or MIDI postprocessing. The converter reports only **81.25% top-1** parity
on a synthetic 64-step teacher-forced smoke test versus FP32 PyTorch; this
local fixture does not establish equivalence to the original checkpoint.

### Opt-in FP16 Medium CPU versus partial QNN experiment

`mizan.engine.muscriptor_fp16_spike` uses the independent
[cursedhelm FP16 conversion](https://huggingface.co/cursedhelm/cubaser-muscriptor-medium-onnx)
on the **first five seconds of the same original, non-isolated CC0 recording**,
without running the app pipeline or any other inference model. The four ONNX
graph/weight SHA-256 digests are verified before each run. The original and
converted weights remain **CC BY-NC 4.0**; only use audio you have rights to.
The log-mel preprocessing and FP16 conditioner always run on CPU. Only the
autoregressive FP16 decoder requests QNN with CPU fallback; executed-node
profile counts—not just registered providers—indicate actual NPU execution.
No weights are installed or bundled.

Run from `host` after placing the public files outside Git:

```powershell
$work = "$env:USERPROFILE\.copilot\session-state\<session-id>\files"
$graph = "$work\muscriptor-medium-fp16-graph"
$reference = "$work\real-sample-model-comparison.json"
.\.venv\Scripts\python.exe -m mizan.engine.muscriptor_fp16_spike `
  --model-dir $graph --reference $reference --provider cpu `
  --output "$graph\fp16-cpu-five-second-report.json"
.\.venv\Scripts\python.exe -m mizan.engine.muscriptor_fp16_spike `
  --model-dir $graph --reference $reference --provider qnn `
  --cpu-reference "$graph\fp16-cpu-five-second-report.json" `
  --output "$graph\fp16-qnn-five-second-report.json"
```

Both runs reached EOS after **41 generated tokens** and decoded **identical
seven piano notes and twelve drum hits** (41-token common prefix; note-event
parity). The piano onset/pitch matched 7/9 labelled notes (F1 .875), but
0/9 full notes matched; 10/10 drum hits matched with two extra hats. These
are five-second *assembled-fixture* figures, not real-song quality evidence.
On the 12-core Snapdragon X Elite (12 CPU threads), the repeat runs
recording setup separately took (seconds; local checksum verification and
Python startup excluded from audio-to-notes time):

| Stage | FP16 CPU | FP16 QNN + CPU |
|---|---:|---:|
| Audio read/resample/log-mel | 0.064 | 0.064 |
| CPU conditioner session setup and inference | 0.009 + 0.002 | 0.009 + 0.002 |
| Decoder session setup (includes QNN registration) | 1.638 | 4.361 |
| Decoder prefill | 1.291 | 1.379 |
| Post-prefill decode | 1.233 (30.1 ms/token) | 2.850 (69.5 ms/token) |
| Audio to decoded notes | **4.260** | **8.689** |
| Additional QNN profile writing/parsing | 0 | 1.138 |
| Peak process working set | **1,440 MiB** | **2,497 MiB** |

The QNN ONNX Runtime trace executed **1,050 QNN fused partitions and 38,682
CPU nodes**, i.e. 25 QNN and 921 CPU executions per generated/EOS step.
Profiled node time in the repeat was ~538 ms QNN versus ~3,510 ms CPU, so this decoder is
**partially accelerated, not NPU-only**. For this FP16 graph and fixture, the
12-core CPU-only run was faster overall *and* on warm token decoding; an
earlier run measured CPU/QNN post-prefill at 30.3/51.8 ms per token, illustrating
variability between separate process runs. Neither this
five-second FP16 measurement nor its QNN timings are directly comparable to
the **different W4A32 conversion's 2.47–2.60× real-time, full-30-second CPU
run** as an architecture/provider speedup claim. No Large checkpoint was
tested in this FP16 experiment; the separate official Large CPU run is below.

### HT-Demucs NPU and MuScriptor Large decision

An opt-in HT-Demucs 6s QNN probe used the installed ONNX graph and a
7.8-second chunk of the local CC0 mix. It requested QNN with the existing
executed-node verification, but produced no verified provider profile or
six-stem output after more than 30 minutes of graph setup. The Python process
reached approximately 29 GiB of working memory and was stopped to avoid
exhausting the machine. **HT-Demucs NPU execution is unproven**, not a
working or faster replacement for the CPU pipeline. The earlier
`real-sample-model-comparison.json` records a completed 30-second CPU
separation at 102.03 seconds (its `learned.stageSeconds.separate`); the
incomplete 7.8-second NPU attempt is not a comparable throughput run.
Production separation remains on CPU, and this failed probe is not enabled
in the app.

The W4A32 Medium graph executed zero QNN nodes, while the separate FP16
Medium decoder executed only partial QNN partitions and ran slower with
QNN+CPU than CPU alone on the same five-second mix. This is insufficient
evidence to spend time converting or shipping MuScriptor Large for NPU. No
public Large ONNX export was located in this spike; Large CPU is measured
separately below, but Large NPU execution remains unmeasured. Reconsider a
licensed Large conversion only after a Medium graph shows useful, verified
NPU placement and an accuracy benefit on representative labelled music.

### Opt-in official MuScriptor Large CPU spike

`mizan.engine.muscriptor_large_spike` is a separate **PyTorch CPU experiment**
with its own 14 GiB worker cap; the app's official Large selection uses a
16 GiB cap and up to four threads. HT-Demucs 6-stem remains the production
separator, and MuScriptor Small is the default transcription model. The
spike uses only the original (not separated) 30-second CC0 mix and official
Large FP32 checkpoint, without invoking any other inference models. The
official weights are gated **CC BY-NC 4.0** (including restrictions on input
audio rights), while the upstream code is MIT. Accept the terms at
[`MuScriptor/muscriptor-large`](https://huggingface.co/MuScriptor/muscriptor-large)
and configure a Hugging Face token in Mizan's Library settings before opting
into a download; the token stays in Windows Credential Manager and is sent
only to Hugging Face. Gated weights stay outside the repository. The checkpoint is
revision `8809fdfbed2affa7ade94a7059e746e3880720e7`, 5,465,642,136 bytes,
SHA-256 `ac4eb6ea87dfc26b6ca6b954c6b967ab87ad4c7d08e078b25214f13ed051f397`
(published in that repository's file-security metadata). The runner verifies
its size, checksum, fixture checksum, and architecture before inference.

The host production dependencies pin the official ARM64 CPU PyTorch 2.14.0
wheel and MuScriptor's inference dependencies. For local development and MSIX
staging, install the official MuScriptor source at the pinned commit with
`--no-deps` after installing the host dependencies. The upstream package also
declares a server and Python `beat-this` dependency, whose `torchaudio` wheel
is unavailable on Windows ARM64; neither is needed by MuScriptor inference
or Mizan's existing Beat This! **ONNX** path. The MSIX packager checks the
source commit and stages the inference code and MIT license, not those unused
dependencies or gated weights. From `host`:

```powershell
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
.\.venv\Scripts\python.exe -m pip install --no-deps "git+https://github.com/muscriptor/muscriptor.git@7f213afecf23bd6a1b8672aa223690ee9807cefb"
```

The opt-in command (also from `host`); the copied fixture report and verified
checkpoint directory must already exist outside Git:

```powershell
$work = "$env:USERPROFILE\.copilot\session-state\<session-id>\files"
.\.venv\Scripts\python.exe -m mizan.engine.muscriptor_large_spike `
  --model-dir "$work\muscriptor-large-official" `
  --reference "$work\real-sample-model-comparison.json" `
  --output "$work\muscriptor-large-official\thirty-second-report.json" `
  --download --threads 12 --timeout 900
```

`--download` is optional if verified weights/config already exist at
`--model-dir`. With `--download`, an existing verified checkpoint is reused
without a network request (even if the token is subsequently removed);
an existing corrupt or incomplete weights file is rejected instead of
silently downloading another 5.47 GB. A first download uses Hugging Face's
revision-pinned cache/resumption. Before inference, the runner requires at
least **20 GiB available physical RAM**; the Windows Job Object hard-limits
worker process memory to **14 GiB** and kills the worker on job closure.
The spike's default **900-second** subprocess
deadline stops runaway inference; results are
written only after the full 30 seconds finish. The JSON records piano
onset/pitch and full-note F1, drum-onset F1, total/load/inference time and
peak working set under the same scoring rules as the Medium run above.
The official checkpoint was downloaded outside Git and verified by size and
SHA-256. On this Snapdragon X Elite, PyTorch 2.7.0's default memory-mapped
`safetensors` load crashed in `torch_cpu.dll` before inference (peak
12.26 GiB working set, below the spike's 14 GiB process cap). Reading the same verified weights through
`safetensors`' `pread` backend instead loaded successfully in **10.98 s**.
On the original 30-second assembled CC0 mix, the official Large CPU model
then spent **217.69 s on inference**, **228.70 s total**, with peak working set
**10,702 MiB** (12 CPU threads). It matched **41/45 piano onsets/pitches**
(F1 **.932**) but **0/45** full notes with the labelled offsets (mean
matched-offset error **.573 s**). Its drums matched only **20/60** labelled
hits (onset F1 **.500**), missing many kick/snare/hat hits. The earlier
unofficial W4 Medium ONNX path matched 37/45 piano onsets/pitches (F1 .841),
0/45 full notes, and 58/60 drum hits (onset F1 .892) in ~11.55 s on this
fixture. These are **different implementations**, a single assembled
recording, and single timed runs—not a representative quality or direct
architecture speed comparison. Large is optional, not a recommended
automatic replacement for Small; in particular its drum recall and
piano durations are poor here. No Large NPU result exists. The local
development environment was subsequently upgraded from PyTorch 2.7.0 to
official native Windows ARM64 2.14.0: the Snapdragon X Elite `cpuinfo`
"Unknown chip model name" warning no longer appears on import or a CPU
matrix-multiply smoke test. The benchmark figures above were obtained on
2.7.0; they have not been reproduced on 2.14.0.
