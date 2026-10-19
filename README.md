<img src="ui/public/mizan-wordmark.svg" alt="Mizan / ميزان" width="316">

# Mizan

Mizan (ميزان, pronounced **mee-ZAHN**) means *balance* or *scale* in Arabic.
It is a Windows desktop app for turning music recordings and scores into
material musicians can study and practise.

Mizan can analyze a recording into draft notes and separated audio parts, or
open MIDI and MusicXML scores. Musicians can review parts in score and
instrument workspaces, slow down and loop playback, and export MIDI or
MusicXML. The app also includes original guitar and bass studies.

Audio processing runs locally by default. An optional cloud worker can run in
an account you control. Transcriptions and scores are drafts for study, not
authoritative notation.

## Screenshots

The examples below use an isolated synthetic library and original study
material; they do not show a real user's library.

![Library with original demo studies](docs/media/mizan-library.png)

![Progress while analyzing generated demo audio](docs/media/mizan-analysis.png)

![Score workspace for an original generated study](docs/media/mizan-score.png)

![Drum-kit practice workspace with hands](docs/media/mizan-drums-practice.png)

![Piano practice workspace with hand assignment](docs/media/mizan-piano-practice.png)

![Guitar tab and 3D hand view](docs/media/mizan-guitar-practice.png)

## Hands in practice

These short demos pair the app's practice views with original, computer-
generated exercises. No commercial recording or sample is used.

**Drums — generated kick, snare, and hi-hat groove**

https://github.com/user-attachments/assets/c6ab9c39-bb71-43e7-b2bc-55ae93bbd917

**Piano — generated two-chord exercise**

https://github.com/user-attachments/assets/22e02033-e4f8-4d28-8820-0efb7763fc0e

**Guitar — generated plucked-string exercise**

https://github.com/user-attachments/assets/adcca28b-f262-4739-8025-e60faced7189

## Architecture

The WinUI 3 shell hosts a React and TypeScript interface in WebView2. A local
Python host manages the library, processing jobs, and artifact server. Local
processing is the default; cloud jobs use a GPU worker in an account you
control.

![Mizan desktop architecture](docs/architecture.png)

The [engine flow](docs/engine-pipeline.png) and
[model readiness](docs/engine-model-readiness.png) diagrams describe local
processing and model checks.

![Cloud job flow](docs/cloud-architecture.png)

See [cloud processing notes](docs/cloud-setup.md) for details about providers,
privacy, and costs.

## Project notes

MuScriptor model weights are not included. Its gated checkpoints have
noncommercial license terms. See [model notes](host/ENGINE.md) and
[third-party notices](THIRD_PARTY_NOTICES.md).

Mizan uses the [MIT License](LICENSE). Dependencies and model weights have
separate terms.
