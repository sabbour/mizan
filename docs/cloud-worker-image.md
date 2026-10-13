# Publish the cloud worker image

A user starts the workflow manually to publish one Linux AMD64 CUDA image to GHCR. The first package publication is private.

The image contains the worker and pinned runtime dependencies. The worker downloads pinned model files at job runtime. The image does not contain model files, recordings, account credentials, or a Hugging Face token.

## Start the workflow

1. Open **Actions** in the GitHub repository.
2. Select **Cloud worker image**.
3. Select the branch that contains the approved source.
4. Select **Run workflow**.
5. Wait for the job to finish.
6. Read the job summary.
7. Download the `cloud-worker-image-<run-id>` artifact.
8. Keep the image reference, digest, and `sourceHash` together.

The workflow uses `GITHUB_TOKEN` to publish the package. It does not need a Hugging Face token. It builds only from `host/mizan/cloud_worker` for `linux/amd64`.

## Make the first package public

1. Open the `mizan-cloud-worker` package in GitHub.
2. Open this package's settings.
3. Change this package's visibility to **Public**.
4. Do not change another package.
5. Keep using the immutable image reference from the workflow summary or artifact.
6. Do not replace its digest with a tag.

Public visibility permits anonymous image pulls.

## Verify anonymous access

1. Set the exact image reference from the workflow output:

   ```powershell
   $env:MIZAN_CLOUD_IMAGE = "ghcr.io/<lowercase-owner>/mizan-cloud-worker@sha256:<digest>"
   ```

2. Run the verifier from the `host` directory:

   ```powershell
   .\.venv\Scripts\python.exe -c "import os; from mizan.cloud_image import verify_image; print(verify_image(os.environ['MIZAN_CLOUD_IMAGE']))"
   ```

The verifier requests public GHCR metadata without a registry account token. It checks the manifest digest, Linux AMD64 platform, and worker source hash. It does not start a cloud job.
