<img src="ui/public/mizan-wordmark.svg" alt="Mizan / ميزان" width="316">

# Mizan

Mizan (ميزان, pronounced **mee-ZAHN**) means *balance* or *scale* in Arabic.
It is a Windows desktop app for music transcription and practice, with tools
for piano, guitar, bass, and drums.

Start with a YouTube link, import a MIDI or MusicXML file, or work through
the built-in lessons without transcribing anything.

- **Transcription and audio separation.** Turn a recording into draft
  instrument parts and separate audio tracks.
- **Local or cloud processing.** Run transcription on your machine, or use a
  GPU worker in your own Azure, Google Cloud, or Amazon Web Services account.
  Local processing is the default.
- **Interactive notation.** Follow synchronized sheet music, guitar and bass
  tablature, and chord charts during playback.
- **Instrument views.** See animated piano, guitar, bass, and drums with hand
  and fingering guides. The 3D piano has perspective and remembered overhead
  views, with independently toggleable animated hands.
- **Practice controls.** Slow down playback, loop sections, jump between bars,
  and use a metronome and count-in. Toggle note names, fingering, and drum
  sticking.
- **A mixer for practising parts.** Solo or mute individual tracks, adjust
  their volume, and switch between the original recording, separated audio
  tracks, and synthesized notes.
- **Built-in lessons for drums, piano, guitar, and bass.** Work through
  progressive exercises, genre-based studies, and original artist-inspired
  exercises. Practise drum rudiments, coordination, grooves, fills, scales,
  piano chord progressions, and instrument-specific techniques. Lessons include
  practice guidance and starting and target tempos, with backing accompaniment
  where provided.
- **Music discovery.** Search YouTube and public MIDI sources from the app,
  or browse popular music.
- **Library organization.** Keep songs and scores in folders, revisit saved
  analyses, and rerun transcription with a different model.
- **MIDI and MusicXML import and export.** Bring in existing scores or take
  your results into another music tool.

Transcription is a starting point, not a finished arrangement. It can miss
notes or identify parts incorrectly. You can also practise existing scores or
the included lessons without running transcription.

## See Mizan in action

A tour of the library, instruments, practice tools, and
lessons.

https://github.com/user-attachments/assets/6b7432c8-faf3-448d-bed5-09ea26636bf3

## Architecture

The WinUI 3 shell hosts a React and TypeScript interface in WebView2. A local
Python host manages the library, processing jobs, and artifact server. Local
processing is the default; cloud jobs use a GPU worker in an account you
control.

See the [desktop architecture](docs/architecture.png),
[engine flow](docs/engine-pipeline.png),
[model readiness](docs/engine-model-readiness.png), and
[cloud job flow](docs/cloud-architecture.png) diagrams for details.

See [cloud processing notes](docs/cloud-setup.md) for details about providers,
privacy, and costs.

## Project notes

MuScriptor model weights are not included. See [model notes](host/ENGINE.md) and
[third-party notices](THIRD_PARTY_NOTICES.md).

Mizan uses the [MIT License](LICENSE). Dependencies and model weights have
separate terms.
