# Azure Container Apps GPU separation + transcription worker

This is a **manual, per-recording GPU Job**, not a public HTTP endpoint. The revised worker reads one private PCM WAV, downloads the pinned HT-Demucs 6s ONNX checkpoint, separates six sample-aligned WAV stems with ONNX Runtime CUDA, then transcribes the original mix and vocal stem with official MuScriptor CUDA. It uploads the six stems followed by one commit-marker JSON manifest. A Small-model synthetic run on A100 completed the full host import/save path at 2cpu/8Gi using developer CLI tokens; it does not validate another customer's Azure identity or the Large-model full host path. **Mizan Cloud mode requires per-customer identity/Job/Blob preflight.**

MuScriptor's **weights are CC-BY-NC**. Confirm that the proposed cloud use complies with the model terms and that you have permission to upload the recording before sending audio to Azure. The model owner must accept the gated model terms for each size. Never put the Hugging Face token or weights in the image, build arguments, logs, or source control.

## Image and resources

Build from this directory as the Docker context, targeting **Linux amd64** (the development machine is ARM64):

```powershell
docker build --platform linux/amd64 -t mizan-aca-gpu:spike host\mizan\cloud_worker
```

The image includes CUDA-enabled PyTorch, ONNX Runtime GPU **1.20.2**, SciPy and the pinned official MuScriptor source. ONNX Runtime 1.20.x targets CUDA 12.x/cuDNN 9, matching the PyTorch CUDA 12.4/cuDNN 9 base; the previously used 1.22 image failed to load `libcublasLt.so.12`. The image exposes PyTorch's bundled cuBLAS, cuDNN, NVRTC, cuRAND, cuFFT and CUDA runtime libraries to the dynamic linker and checks at build time that the ONNX CUDA provider's linked libraries resolve. The CPU-only ACR builder cannot initialize that provider without a GPU driver; the live A100 run below verified the combined worker separately. It contains no model weights or tokens. The worker checksum-verifies the pinned MIT-licensed HT-Demucs ONNX model from `host\mizan\engine\models.py`, imports PyTorch before creating the ONNX session so its bundled CUDA/cuDNN libraries are loaded, requires CUDA exclusively for ONNX nodes (`session.disable_cpu_ep_fallback=1` and `disable_fallback()`), and refuses a CPU fallback for either model. ONNX Runtime can report an automatically registered CPU provider even when the requested CUDA provider is first; the strict session option rejects graph nodes unsupported by CUDA. It uses `/app/work` inside the ephemeral Job container for model and audio files. The source Docker context is bundled at `host\mizan\cloud_worker`. Build/push manually with `az acr build --platform linux/amd64 --registry <ACR_NAME> --image mizan-aca-gpu:spike host\mizan\cloud_worker` if needed. ONNX GPU kernel support for this exact checkpoint has **not been validated on a real T4**; a missing CUDA op causes an explicit failed Job rather than a CPU result.

Create a [workload-profiles Container Apps environment](https://learn.microsoft.com/en-us/azure/container-apps/gpu-serverless-overview) in a supported region with GPU quota. This subscription's policy requires a VNet-integrated environment: delegate a subnet to `Microsoft.App/environments` and supply its ID when creating the environment. For a T4, add a `Consumption-GPU-NC8as-T4` profile (for example named `NC8as-T4`) and select that profile on the Job. The [GPU tutorial](https://learn.microsoft.com/en-us/azure/container-apps/gpu-image-generation) uses 8 vCPU and 56 GiB for this profile. Start with Small, then measure VRAM and elapsed time before trying Large on the 16 GiB T4.

Provision a **private** Blob container, a private ACR, and a user-assigned managed identity. Give the Job identity `Storage Blob Data Contributor` scoped to that container and pull access to its image in ACR. The Job also needs outbound HTTPS to Hugging Face. Use a separate token authorized for the gated models, not the desktop user's saved credential.

Once those resources exist, create the manual Job (replace all placeholders):

```powershell
$rg = "<RESOURCE_GROUP>"
$envName = "<CONTAINER_APPS_ENVIRONMENT>"
$identityId = "<USER_ASSIGNED_IDENTITY_RESOURCE_ID>"
$registry = "<ACR_NAME>.azurecr.io"
$account = "<STORAGE_ACCOUNT_NAME>"
$container = "<PRIVATE_BLOB_CONTAINER>"
$clientId = "<USER_ASSIGNED_IDENTITY_CLIENT_ID>"

az containerapp job create `
  --name mizan-gpu-transcribe --resource-group $rg --environment $envName `
  --trigger-type Manual --workload-profile-name NC8as-T4 `
  --image "$registry/mizan-aca-gpu:spike" --registry-server $registry `
  --mi-user-assigned $identityId --registry-identity $identityId `
  --cpu 8 --memory 56Gi --replica-timeout 7200 --replica-retry-limit 0 `
  --env-vars "AZURE_STORAGE_BLOB_URL=https://$account.blob.core.windows.net" `
             "AZURE_STORAGE_CONTAINER=$container" "AZURE_CLIENT_ID=$clientId"
```

Add a Job secret named `hf-token` in **Azure Portal → Container Apps Job → Secrets**, then bind it without exposing the token in a CLI argument:

```powershell
az containerapp job update --name mizan-gpu-transcribe --resource-group $rg `
  --set-env-vars "HF_TOKEN=secretref:hf-token"
```

Do not start an execution until that binding exists. The role that can **start** the Job must be trusted to use its secrets; see the permissions note below.

If you prefer the CLI to set the secret directly, prompt for the token locally and avoid a literal in shell history:

```powershell
$token = Read-Host "Hugging Face token" -AsSecureString
$plain = [System.Net.NetworkCredential]::new("", $token).Password
try {
  az containerapp job secret set --name mizan-gpu-transcribe --resource-group $rg `
    --secrets "hf-token=$plain" -o none
} finally {
  $plain = $null
  $token.Dispose()
}
```

This CLI approach still passes the token briefly in a process argument; use the Portal instead on a shared machine.

For manual smoke tests only, upload an **authorized** WAV to the private container, then set the pilot Job's arguments to blob **names, not URLs or SAS tokens**, and start an execution:

```powershell
az containerapp job update --name mizan-gpu-transcribe --resource-group $rg `
  --args recordings/example.wav results/example.json muscriptor-small
az containerapp job start --name mizan-gpu-transcribe --resource-group $rg
```

For this **single-run pilot only**, updating the Job template is sufficient. The Mizan host does **not** start this pilot Job. The current Azure CLI `job start --args` shortcut sent an incomplete template that Azure rejected with `ContainerAppImageRequired`.

Check `az containerapp job execution list --name mizan-gpu-transcribe --resource-group $rg` and read `results/example.json` with a caller granted Blob read access. A failed job writes no result; see its execution logs. Args are **exactly** `[inputBlob, resultBlob, model]`. The new manifest retains the previous top-level MuScriptor `{model, modelVersion, provider:"PyTorch CUDA", events:[{instrument,midi,onset,offset}]}` fields and adds `vocalEvents` (same event shape, from a second MuScriptor pass over the isolated vocal WAV), `input`, `separation`, and top-level `stems`:

```json
{
  "input": {"blob": "recordings/example.wav", "bytes": 123456, "sha256": "<SHA-256 of uploaded WAV>"},
  "separation": {
    "method": "htdemucs-6s-onnx",
    "model": "htdemucs-6s-fp16weights",
    "modelVersion": "49df9b6989cf2150840ea65b0bef77a2e471b678",
    "provider": "CUDAExecutionProvider",
    "sampleRate": 44100,
    "samples": 80000,
    "channels": 2
  },
  "stems": {
    "drums": {"blob": "results/example/stems/drums.wav", "sha256": "<SHA-256>", "bytes": 640058, "sampleRate": 44100, "samples": 80000, "channels": 2}
  },
  "vocalEvents": [{"instrument": "voice", "midi": 60, "onset": 0.1, "offset": 0.6}]
}
```

`stems` has **exactly six** entries in order: `drums`, `bass`, `other`, `vocals`, `guitar`, `piano`. Each blob is 32-bit float WAV at the **original** input rate/channel count and exactly the original frame count; mono remains mono. The worker matches the host's 343,980-sample segments, quarter overlap, fade and resampling logic. The JSON Blob is uploaded **last**, after all six immutable stem Blobs. Source WAV and each stem are limited to 250 MiB, the HT-Demucs download to 2 GiB and JSON to 32 MiB. Use unique output keys per request; `overwrite=False` on all writes. Partial stem Blobs may remain if inference/upload fails; set a one-day Blob lifecycle policy for their prefix. The host's import and library-save path remains unverified with real Azure output.

## Mizan Cloud setup is blocked

`azure_subscriptions` lists the desktop Azure Identity credential's accessible subscriptions. `configure_cloud` saves nonsecret Azure resource identifiers; the wizard separately offers `prepare_cloud` to create a dedicated resource group and A100-profile infrastructure **only after explicit cost consent**, `build_cloud_worker` to compile the bundled Docker context in that ACR (additional build cost), and `finish_cloud` to create a dormant manual Job referencing that registry's completed-build image by immutable ACR SHA-256 digest and the **tested 2-vCPU/8-GiB request**. These ARM operations have only mocked tests; see [host setup](../../host/README.md#single-user-azure-gpu-offload). `cloud_status().available` reports the build's validated Small pipeline; `configured` requires this desktop's current Azure credential, pinned Job, scoped roles and private Blob data-plane access. The CLI-token pilot is never stored as a customer's proof. The Large worker passed a synthetic 2/8 GPU run, but Large's full host path remains unverified.

Manual pilot provisioning is still possible using the commands above, but it is **not** a working full Mizan Cloud mode. The Job identity needs `Storage Blob Data Contributor` on the private container and `AcrPull` on the registry; the desktop Azure identity needs Blob Data Contributor on the container. Assigning these roles requires elevated permission; Resource Group Contributor alone is insufficient. Wizard provisioning still needs live verification; the wizard creates a one-day `jobs/` Blob lifecycle policy for new storage, but does not inspect or stop old Job executions. Check those in Azure Portal.

## Live pilot

An isolated pilot exists in Sweden Central: resource group `rg-mizan-gpu-spike`, Job `mizan-gpu-transcribe`, private storage account `mizanagpu2819` with container `jobs`, and ACR `mizanacagpu2819`. Its VNet-integrated environment uses the `NC8as-T4` serverless profile. Execution `mizan-gpu-transcribe-zo23xh2` succeeded using an eight-second generated C4 sine-wave WAV. The `results/synthetic-c4.json` Blob reports `PyTorch CUDA`, the pinned Small checkpoint, and zero note events (a pure tone is not a musical transcription benchmark). The execution took about 166 seconds **including cold start and first checkpoint download**; this does not establish a speedup over local processing.

Execution `mizan-gpu-transcribe-z4yxknn` also succeeded on the [official Navy Band Southwest recording of Sousa's New Mexico March](https://www.youtube.com/watch?v=u7ODP3CZC2Y) (183 seconds). MuScriptor Large returned 3,809 raw events using `PyTorch CUDA` in **525 seconds (8 minutes 45 seconds)**, including startup, downloading its 5.5 GB checkpoint, Blob I/O, and inference. The local desktop analysis of a different song was cancelled after 30+ minutes; this is not an apples-to-apples model benchmark because the desktop pipeline also separates stems and builds a score, neither of which this worker does.

The Job has no HTTP ingress and scales to zero when idle. ACR, Blob storage, VNet resources and Log Analytics remain provisioned and may incur charges even when no GPU is running. Delete the isolated resource group after the pilot is no longer needed; do not assume scale-to-zero removes all costs.

The first synthetic test of the **combined** worker used ONNX Runtime 1.22 and its console log reported `libcublasLt.so.12: cannot open shared object file`. CUDA provider creation then failed, and the worker correctly refused CPU fallback. The rebuilt 1.20.2 image passed its build and an ACR CPU startup check, but its GPU Job exited before creating a container. Subsequent CPU build checks identified six CUDA loader paths in the bundled PyTorch packages; direct provider initialization on the CPU build agent segfaulted after attempting to load the absent NVIDIA driver. The linked image, `mizan-aca-gpu:combined-20260929-linked` (digest `sha256:c3e75564e022d0092fec161f00eef9c80c0341cc10c1ef1ae6f472c0437cd404`), passed the build-time linked-dependency check. Control executions using the **previously successful** MuScriptor-only image and even a small public image failed before container startup on `NC8as-T4`, with empty replica container lists and no console logs. Starting the Job without a per-execution override also failed. The **same Job and managed environment succeeded on the CPU Consumption profile** with the public image. T4 quota was **5, usage 0**. This isolates that T4 failure to GPU-profile scheduling/startup, but does not establish whether the cause is regional capacity or another Azure platform issue. It is separate from the A100 worker errors below.

An A100 quota of **2, usage 0** was available in the same environment. A temporary `NC24-A100` profile and `mizan-a100-smoke` Job succeeded: `nvidia-smi` reported an NVIDIA A100 80 GB PCIe, driver `580.159.04` and CUDA `13.0`. The first combined A100 run, `mizan-gpu-transcribe-9u3tp1p`, used `combined-20260929-linked` and failed with `RuntimeError: HT-Demucs session did not select CUDA exclusively; refusing CPU separation.` The corrected guard retains `session.disable_cpu_ep_fallback=1` (which rejects graph nodes unsupported by the non-CPU provider) and `disable_fallback()` (which prevents Python retry on CPU); it requires CUDA to be the first registered provider rather than the only registered provider.

The corrected image, `mizan-aca-gpu:combined-20260929-a100` (digest `sha256:5fe0f3b2fc894a8e9c3079baf3cc59f0f3b297ab049bc730d59882bfb8b79c5a`), succeeded as execution `mizan-gpu-transcribe-2cluljy` on the eight-second synthetic C4 recording in **167 seconds including startup and checkpoint download**. Its manifest reported `CUDAExecutionProvider` for HT-Demucs and `PyTorch CUDA` for MuScriptor's original-mix and vocal-stem passes; both note lists were empty, as expected for this synthetic tone. All six WAV stems were downloaded and SHA-256-verified, and each matched the input's 16 kHz rate, 128,000 frames and mono channel shape. This verifies the **worker** on A100, not the host's Cloud import/library-save path, Azure setup wizard, lifecycle or T4 scheduling. The original T4 Job settings were restored after the A100 test.
