# Release Mizan

Source publication, installer distribution, and cloud image publication are
separate steps. A local build does not approve any public upload.

## Publish source

1. Confirm the GitHub owner, repository, and branch before you upload code.
2. Review the current files and the history of that branch for private data.
3. Stage only reviewed source files, documentation, tests, and licensed assets.
4. Run the source checks described in the README.
5. Scan the branch history and staged changes with Gitleaks:

   ```powershell
   gitleaks git . --log-opts=HEAD --ignore-gitleaks-allow --redact=100
   gitleaks git . --pre-commit --staged --ignore-gitleaks-allow --redact=100
   ```

6. Review every finding. Do not print credential values or test them online.
7. Publish only the reviewed branch. Do not use `--all`, `--mirror`, or a blanket
   `--tags` push.
8. Create release tags only from reviewed commits.

A scanner cannot prove that all private data is absent. Also review screenshots,
recordings, browser profiles, database files, and provider account details.
Deleting a file from the current tree does not remove it from older commits.
Do not rewrite history without the repository owner's approval.

Keep `LICENSE`, `THIRD_PARTY_NOTICES.md`, and the `licenses` directory with
the source. The bundled practice samples have separate licenses and credits.
Model weights and user recordings must stay outside the repository.

## Windows installers

Public installer uploads are blocked by default. Local builds and signing
remain available.

Desktop packages do not bundle or install FFmpeg. Users install it separately
for YouTube audio, and the selected build controls its license and linked
libraries. This change does not approve public installer uploads.
Before you distribute an installer:

1. Review the package contents and its SHA-256 hash.
2. Review the licenses for the .NET, Python, Windows App SDK, and other bundled components.
3. Make the required notices available through a distribution method permitted by
   the applicable licenses.
4. Keep MuScriptor checkpoints outside the installer. Their noncommercial
   terms are separate from Mizan's MIT license.

Do not treat this checklist as a completed legal review.
Do not approve binary distribution while required source materials are missing.

The credits generator supplies reviewed upstream license text for FlatBuffers
25.12.19 and corrects proxy_tools 0.1.0's MIT metadata to its upstream BSD-2-Clause
license, retaining Armin Ronacher's and Jonathan Tushman's copyright notices.
The immutable source references are recorded in `scripts/credits.py`; the
generator rejects other versions of these packages until their license data is
reviewed. After generation, inspect the license contents, not only linked paths.

After the requirements are met, set the Actions repository variable
`MIZAN_BINARY_DISTRIBUTION_READY` to `true`.
Only tag builds can then upload unsigned MSIX artifacts. Pull requests never
upload installers.

For an approved signed release upload, also set this variable in the local
PowerShell process:

```powershell
$env:MIZAN_BINARY_DISTRIBUTION_READY = "true"
```

The signing script requires this value when you pass `-Upload`.
Do not use it as a substitute for obtaining and reviewing the required materials.

## Cloud worker image

Confirm the owner and repository before you run the publication workflow.
Review the image's CUDA and dependency terms.
The image must not contain model weights, recordings, or credentials.

Follow [the image publication guide](cloud-worker-image.md).
Keep the published digest and worker source hash together.
Make only the intended package public, then check anonymous access.
Do not advertise a placeholder image reference as a working image.

The new provider paths have offline checks. Live account access, quotas, and
paid jobs need separate approval and validation.
Publishing the image does not prove that every provider works in a customer account.
