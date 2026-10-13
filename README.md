<img src="ui/public/mizan-wordmark.svg" alt="Mizan / ميزان" width="316">

# Mizan

Mizan (ميزان, pronounced **mee-ZAHN**) means *balance* or *scale* in Arabic.

Mizan turns a YouTube recording into draft scores, chords, and separate audio
tracks for practice. It also imports MIDI and MusicXML scores.

Mizan runs as a Windows ARM64 desktop app. Local processing is the default.
You can also send a job to one cloud provider in an account that you own.
Generated notes and scores are study aids, not authoritative transcriptions.
The project does not claim representative real-song accuracy.

## Features

- Transcribe piano, drums, vocals, and other detected parts as draft notes.
- Separate recordings into vocals, piano, guitar, bass, drums, and other audio.
- Read scores, view piano and drum guides, and play chords and practice parts.
- Slow playback, loop bars, and export MIDI and MusicXML.
- Import MIDI and MusicXML into the practice library.

MuScriptor model weights are not included. Its gated checkpoints have
noncommercial license terms. Read and accept the terms for each model before
you download it. See [model notes](host/ENGINE.md) and
[third-party notices](THIRD_PARTY_NOTICES.md).

## Architecture

The WinUI 3 shell shows a React and TypeScript interface in WebView2. A local
Python host handles jobs, the library, and a local artifact server.

![Mizan desktop architecture](docs/architecture.png)

Edit the [system architecture diagram](docs/architecture.drawio).
The [engine flow](docs/engine-pipeline.png) and
[model readiness](docs/engine-model-readiness.png) diagrams explain local
processing and model checks. Edit them in
[draw.io](docs/engine-pipeline.drawio) and
[draw.io](docs/engine-model-readiness.drawio).

![Cloud job flow](docs/cloud-architecture.png)

Edit the [cloud architecture diagram](docs/cloud-architecture.drawio).
Cloud processing uses a GPU worker in an account that you control. See
[cloud setup](docs/cloud-setup.md) for provider, privacy, cost, and test limits.

## Run from source

The app targets Windows ARM64. You need Windows, Python 3.12 ARM64, Node.js,
.NET 10 SDK, Windows SDK, WebView2 Runtime, `uv`, and FFmpeg for YouTube audio.
Install Git and PowerShell 7.

Open the [official FFmpeg download page](https://ffmpeg.org/download.html#build-windows).
Choose a Windows build from one of the providers listed there.
Download a ZIP package.
Extract the package.
Enter the full path to `bin\ffmpeg.exe` in Song analysis settings.
Mizan uses that saved path before `MIZAN_FFMPEG`, `PATH`, and WinGet discovery.

The FFmpeg project provides source code.
The listed providers supply the Windows executables.

Create the host environment and install its development dependencies:

```powershell
uv venv --seed --python "$env:LOCALAPPDATA\Programs\Python\Python312-arm64\python.exe" host\.venv
uv pip install --python host\.venv\Scripts\python.exe -e "host[dev]"
host\.venv\Scripts\python.exe -m pip install --no-deps "git+https://github.com/muscriptor/muscriptor.git@7f213afecf23bd6a1b8672aa223690ee9807cefb"
```

Install MuScriptor without its upstream dependencies. Its unused server and
`beat-this` dependencies require `torchaudio`, which has no Windows ARM64 wheel.

Install and build the interface:

```powershell
Push-Location ui
npm ci
npm run build
Pop-Location
```

Start the Vite server in one terminal:

```powershell
Push-Location ui
npm run dev
```

Start the native shell from the repository root in another terminal:

```powershell
$env:MIZAN_DEV_URL = "http://localhost:5173"
dotnet run --project shell\Mizan.Shell\Mizan.Shell.csproj -r win-arm64
```

The host stores the library and cache under `%LOCALAPPDATA%\Mizan`.
Set `MIZAN_HOME` to use a separate development library.

## Build an MSIX

The build needs Python 3.12 ARM64, Node.js, `uv`, the .NET 10 SDK, Windows SDK,
and the host packages. It does not need FFmpeg.
The desktop package does not include FFmpeg.

Build an unsigned package with your own publisher value:

```powershell
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$publisher = "CN=<your publisher>"
pwsh -NoProfile -File .\scripts\Build-Msix.ps1 -Version $version -Publisher $publisher -SkipSign
```

This command creates an unsigned MSIX. It does not install the package.
The MSIX workflow also builds pull requests and `v*` tags.
Pull requests use a development publisher when no publisher secret is set.
They do not upload installers.

To sign a package, provide your own certificate or Trusted Signing account
values. The signing script contains maintainer-specific defaults. Override
them before use. Public installer uploads require `-Upload` and explicit
redistribution approval. See the [release guide](docs/releasing.md).

## Tests

Run Python tests from `host`. The test suite uses paths relative to that
directory.

```powershell
Push-Location host
.\.venv\Scripts\python.exe -m pytest tests -q
Pop-Location
```

Run UI checks from `ui`:

```powershell
Push-Location ui
npm run build
npm run lint
node --test tests\cloud-lifecycle.test.mjs
Pop-Location
```

The browser tests use sample data. These commands do not prove that a full
ARM64 MSIX works on every supported device.

## Cloud worker image

The shared Linux AMD64 image does not have a public image reference yet.
Do not use `ghcr.io/<owner>/mizan-cloud-worker@sha256:<digest>` as a working
image until an owner and digest are confirmed and published.
The manual workflow records the image, digest, and source hash.
Its first package publication is private. The owner must make only this
package public and check anonymous access before use.
See the [image publication guide](docs/cloud-worker-image.md).

The worker application code uses the MIT License. PyTorch, NumPy, and SciPy
have BSD terms. Google authentication libraries have Apache terms. The CUDA
base image and other dependencies have separate terms. Preserve and review
all notices. The image does not contain model weights, credentials, tokens,
or recordings.
The worker downloads pinned, hash-checked model files when a job starts.

## Contributing

- Keep changes focused. Run the existing checks for the parts that you change.
- Do not commit copyrighted audio, model weights, tokens, credentials, or recordings.
- Get explicit user approval before cloud resource changes, permission grants, token transfers, or paid cloud tests.

Use the [release guide](docs/releasing.md) before you publish source,
installers, or a cloud worker image.

## License

Mizan uses the [MIT License](LICENSE). Dependencies and model weights have
separate terms. Read [third-party notices](THIRD_PARTY_NOTICES.md) before
you use or redistribute them.
