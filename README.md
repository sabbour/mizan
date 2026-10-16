<img src="ui/public/mizan-wordmark.svg" alt="Mizan / ميزان" width="316">

# Mizan

Mizan (ميزان, pronounced **mee-ZAHN**) means *balance* or *scale* in Arabic.

Mizan turns a YouTube recording into draft scores, chords, and separate audio
tracks for practice. It also imports MIDI and MusicXML scores.
If YouTube asks to confirm you're not a bot, use **YouTube sign-in** in Song
analysis settings or import a private-window `cookies.txt` file. The sign-in
window closes automatically after Mizan saves an active YouTube session.

Mizan runs as a Windows ARM64 desktop app. Local processing is the default.
You can also send a job to one cloud provider in an account that you own.
Generated notes and scores are study aids, not authoritative transcriptions.
The project does not claim representative real-song accuracy.

## Features

- Transcribe piano, drums, vocals, and other detected parts as draft notes.
- Separate recordings into vocals, piano, guitar, bass, drums, and other audio.
- Read scores, view piano, drum, guitar, and bass guides, and play chords and practice parts.
- Correct a transcribed track's instrument without changing its notes or recording.
- Slow playback, loop bars, and export MIDI and MusicXML.
- Import MIDI and MusicXML into the practice library.
- Practise built-in guitar and bass lessons with scores, suggested tab, and instrument guides.

To correct an instrument, open the song's sounds and tracks menu, choose
**Change instrument** beside the transcribed track, and save your choice.
The change is saved with the song and used for playback, the practice guide,
and new MIDI and MusicXML exports. Note pitches, timing, and the original
recording stay unchanged. Generated practice parts and drum tracks cannot be
changed into pitched instruments.

The guitar and bass course browser offers the levelled course, original genre
exercises, and scales. The **Inspired** section is withheld until it can offer
real riffs cleared for inclusion, rather than substitute exercises named after
songs. Previously saved study IDs and practice settings remain available.
Each of the eleven genres has five eight-bar guitar studies and five bass
studies. They use repeating hooks, contrasting answers, written rests and
accents, and sounds chosen for each style. These are original exercises, not
transcriptions of recorded songs.

In guitar and bass tab, numbers show frets and `0` means an open string.
The notes below the strings show timing; rests mean pause. Open **Reading the
rhythm** for illustrated note lengths and a guide to beams, dots, and triplets.
The default **Finger guide** shows the full configured fretboard with real fret
spacing that narrows toward the body: dots show finger numbers, connected
shapes show barres, and the ruler numbers the frets.
Strings stay in tab order, including for left-handed players. Stable **NOW**
and **NEXT** cues name each string and fret (including open strings), and the
finger key is always visible. This view does not need WebGL.
One optional 3D choice sits beside the finger guide. **3D mirror** shows the whole instrument, body and headstock included, the way a
mirror shows a player holding it: a long-lens view of the front of the guitar, the neck rising about 20° toward the
headstock, the fretting hand wrapped around the neck, and a relaxed picking hand holding a separate pick in the strumming zone between the end of the fretboard and the middle pickup (one downstroke from the low string toward the high string for chords, a single-string pick for single notes, a rest pose otherwise). Each hand ends in a short natural wrist that fades out; there are no arms, elbows or seated body. The small flash that shows a plucked string appears where the pick strikes the string, while the steady dot stays at the fret. A right-handed
player (fretting with the left hand) sees the neck at screen left and the body at screen right; left-handed reverses
it. Only the picture is reflected; string numbers, notes and frets are never swapped. The mirror shows one small glowing dot
at the string and fret to play, with a compact label (note, fret, finger). Each finger has its own colour (1 index blue, 2 middle orange, 3 ring green, 4 little pink, thumb grey): the marker for a note you are playing takes the colour of its finger, and the tip of that finger on the 3D hand is tinted the same colour, while the finger numbers stay on the markers. The next note is never drawn on the instrument or on the finger guide; the NEXT line below names it. Three small
toggles hide the guidance (“Guides”), add string names (“String names”, off by default), or hide the hands (“Hands”). A “Key” button opens the longer legend.
Your choices (Finger guide or 3D mirror, Look, Handedness, String names, Guides and Hands) are remembered across lessons, instruments and restarts. The mirror uses the original
guitar model's wood normal and roughness maps with soft studio lighting; the hands are the low-poly, untextured
fretting-hand models, so they are readable rather than photographic. The mirror and the tab below it fit on a laptop-sized window
without scrolling: the 3D stage takes the height that is left after the controls, the NOW and NEXT panel and the first row of the tab.
The fretting hand never disappears: while the next hand shape is being prepared the last one stays on screen and blends into the new one,
and on open strings and rests it rests, relaxed and hovering just above the neck near the neighbouring fretted notes, with no finger badge.
Straight string guides use dashed sections where the suggested hand hides a string. The hand
shape is a suggestion, not a recording of a player's fingering; unsupported
stretches keep their note targets without inventing a hand pose.

The 3D drum kit and 3D piano also show hands, and each 3D view has the same **Hands** toggle in its toolbar (on by default, remembered everywhere); with it off, only the instrument is drawn, the hand models are not loaded, and the stroke glows, key colours and finger numbers stay. On the kit, a left and a right
hand each hold a drumstick between thumb and index finger, and the stick tip
lands on the drum, cymbal, or hi-hat at the moment of each note, then rebounds.
The hands follow the lesson's written sticking; when the sticking letters are
off, or the music has none, they follow the same suggested right-hand-lead
sticking as the legend. The kick and hi-hat pedal are played by feet, so no
hand moves for them. On the piano, two hands sit over the keys with the palms
down. The finger the music names presses each sounding key, and the other
fingers hover just above the keys. When the music names no fingers, the fingers
are suggestions from the note spacing, and when it names no hands, notes below
middle C go to the left hand and the rest to the right, and the hint says so.
Both views draw the same pose for the same time, so seeking, looping, pausing,
and the count-in always show a consistent picture. With reduced motion turned
on, the hands stay at their target positions instead of swinging or gliding.
The hands load only when the 3D view opens; if they cannot load, the kit or
keyboard works as before and says so. The motion is a suggestion, not a
recording of a player. The hands are the same low-poly, untextured models as
the guitar view, each ending in a short faded wrist with no arms, elbows or body, and the feet are not shown.

**Playable hands and tab.** Transcribers and MIDI imports split piano notes between the hands by pitch alone, and
pick a guitar or bass string for each note on its own, so some moments ask a hand for more than it can do. Mizan
checks this each time a piano, guitar or bass part opens, and repairs what it can; the stored song is never changed, so the
check is always worked out again from the transcription. On piano a hand is overloaded when it must hold more than five
different keys at once, or stretch wider than a ninth (a tenth is accepted only when no split avoids it), or stay crossed over
the other hand for more than half a second. A held bass note that sounds a sixth or more below everything the hand has
played since is taken as carried by the sustain pedal. The repair moves as few notes as it can to the other hand, keeps the
written split wherever it already works, keeps the top voice in the right hand and the lowest note in the left, avoids
hands swapping back and forth, and recomputes the suggested fingering for the notes it moved (written fingering is kept
for notes that keep their hand). Moved notes appear on the other staff of the score, in that hand's colour and with
updated finger numbers. Quick jumps between hand positions are only warned about. On guitar and bass a moment is
unplayable when two notes sit on one string, more fretted frets are needed than four fingers can cover (one finger may bar
a fret), the stretch is wider than four frets (five from the seventh fret up on guitar), or there are more notes than
strings. The repair chooses new string and fret positions for the whole part, keeping the written positions
where they work and otherwise preferring few hand shifts, low positions and open strings. A moment that still cannot be
played has its fewest inner notes dropped from the tab (the lowest and highest are kept) and marked with a `!` in the tab and
the score. A small note above the practice view says what changed ("Hands adjusted for playability: 12 notes moved to the
other hand", "Tab positions adjusted for playability: 8 notes", "3 moments can't be played as written"),
**Show where** lists the bars, and **As transcribed** switches back to the music as written to compare (**Playable** is the
default). The MusicXML the workspace builds for the score (`pianoXml`, `instrumentXml`) and the tab (`frettedTabXml`)
use the repaired hands and positions. The files Mizan writes while transcribing (`score.mid`, `score.musicxml`) hold only
pitches and timing, with no hands, staves, strings or frets, so the repair does not change them.

Imported MIDI pitch bends play while notes are held, including after seeking
or changing playback speed. They are saved with the song and retained in MIDI
exports. Scores show each note's starting pitch with bend annotations.
MusicXML keeps those annotations, but not the full bend curve; use MIDI when
you need the bends to survive export and re-import.

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

The app targets Windows ARM64; x64 builds are also supported. You need Windows,
Python 3.12 for the same architecture (ARM64 or x64), Node.js,
.NET 10 SDK, Windows SDK, WebView2 Runtime, `uv`, and FFmpeg for YouTube audio.
Install Git and PowerShell 7.

The easiest way to install FFmpeg is WinGet:

```powershell
winget install Gyan.FFmpeg
```

Mizan finds the WinGet install automatically. Select **Check again** in Song
analysis settings, or restart Mizan.

To install it manually instead, open the
[official FFmpeg download page](https://ffmpeg.org/download.html#build-windows),
download a Windows ZIP build from a listed provider, extract it, and enter the
full path to `bin\ffmpeg.exe` in Song analysis settings.
Mizan uses that saved path before `MIZAN_FFMPEG`, `PATH`, and WinGet discovery.
The first executable check allows up to 30 seconds for a slow Windows start.
Successful checks are reused while that executable is unchanged. If the check
times out, retry the existing path; a timeout does not mean FFmpeg is missing.

The FFmpeg project provides source code.
The listed providers supply the Windows executables.

Create the host environment and install its development dependencies:

```powershell
pwsh -NoProfile -File .\scripts\Initialize-HostEnvironment.ps1
```

The script finds an installed Python 3.12 that matches this PC's architecture.
Add `-Architecture x64` or `-Architecture arm64` to choose another target, or
`-Python <path to python.exe>` to use a specific interpreter. It creates
`host\.venv`, installs `host[dev]`, and installs MuScriptor without its
upstream dependencies. Those dependencies require `torchaudio`, which has no
Windows ARM64 wheel. The host pins the matching PyTorch wheel for ARM64 or x64.

pip uses your existing pip configuration for its package index, proxy, and
credentials. The script does not pass an index URL. pywebview, MuScriptor, and
PyTorch are pinned as direct GitHub and `download-r2.pytorch.org` URLs, so the
PC also needs access to those hosts. If the inherited `GIT_EXEC_PATH` belongs
to a different Git than the one on `PATH`, the script ignores it for that run
only. It does not install Python, change `PATH`, or edit Git or pip settings.
An existing `host\.venv` with the wrong Python is reported, not replaced.

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

On x64, use `-r win-x64`.

The host stores the library and cache under `%LOCALAPPDATA%\Mizan`.
Set `MIZAN_HOME` to use a separate development library.

## Build an MSIX

The build needs the host environment for the target architecture, Node.js, the
.NET 10 SDK, and the Windows SDK. It does not need FFmpeg.
The desktop package does not include FFmpeg.

Build an unsigned package with your own publisher value:

```powershell
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$publisher = "CN=<your publisher>"
pwsh -NoProfile -File .\scripts\Build-Msix.ps1 -Version $version -Publisher $publisher -SkipSign
```

The default architecture is ARM64. Add `-Architecture x64` to build
`Mizan_<version>_x64.msix` from an x64 host environment, and pass the same
`-Architecture` to `Publish-SignedMsix.ps1` when signing it.

The build also downloads the pinned Node.js 24.22.0 runtime for the selected
architecture, verifies its SHA-256 checksum, and includes it for yt-dlp's
YouTube JavaScript challenge solver.

This command creates an unsigned MSIX. It does not install the package.
The MSIX workflow also builds pull requests and `v*` tags.
Pull requests use a development publisher when no publisher secret is set.
They do not upload installers.

To sign a package, provide your own certificate or Trusted Signing account
values. The signing script contains maintainer-specific defaults. Override
them before use. Sign in with `az login`, then build and sign in one step:

```powershell
pwsh -NoProfile -File .\scripts\Publish-SignedMsix.ps1 -Version $version -Architecture x64 -Build
```

`-Build` reads the publisher from the active certificate profile, builds the
package with it, and signs that exact file. Add `-BuildId` to sign a
BuildId-tagged package. Without `-Build`, the script signs the existing
`artifacts\Mizan_<version>_<architecture>.msix`, or the file passed with
`-MsixPath`.

The script finds the newest Windows SDK tools that run on this PC; SignTool is
always the x64 build because the Trusted Signing client is x64. It finds the
Trusted Signing client in the NuGet global-packages folder reported by
`dotnet nuget locals global-packages --list`, which honors `NUGET_PACKAGES`
and `nuget.config`. If the client is missing, it restores it from your
configured NuGet sources into a temporary project. Pass `-DlibPath` to use a
specific `Azure.CodeSigning.Dlib.dll`.

Public installer uploads require `-Upload` and explicit
redistribution approval. See the [release guide](docs/releasing.md).

## Tests

Run Python tests from the repository root. Some tests import the root
`scripts` package, so put both the repository root and `host` on `PYTHONPATH`.

```powershell
$env:PYTHONPATH = "$PWD\host;$PWD"
.\host\.venv\Scripts\python.exe -m pytest host\tests -q
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
