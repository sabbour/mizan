# Product

<!-- impeccable:product-schema 1 -->

## Platform

Windows desktop

The Windows ARM64 app uses a WinUI 3 shell and WebView2 to show its React interface.

## Stack

The interface uses React, TypeScript, and Vite. WebView2 displays it in the
WinUI 3 shell. .NET 10 runs the shell.

Python 3.12 handles YouTube ingestion, source separation, transcription, and
chord analysis. ONNX Runtime and PyTorch run the models. Mizan uses measured
execution providers for each model.

## Users

Musicians who learn parts from full-band recordings and practice with scores,
visual guides, and chords. The audience includes people who are new to notation.

## Product Purpose

Mizan turns a YouTube link into a practice kit for detected parts. It also
imports MIDI and MusicXML for direct practice.

A practice kit includes:

- Draft notes and scores for detected instruments, including piano and drums.
- A synchronized visual guide for each supported part.
- The chord progression for the song.

Success means musicians can learn parts from real recordings. They can repeat
difficult passages, study harmony, and save a growing repertoire.

## Positioning

Mizan is an open-source desktop app. It separates full-band mixes and
transcribes detected parts. Notation, visual guides, and chords share one
playhead. Local processing is the default. Optional cloud processing uses an
account that the user owns. A Hugging Face account is needed to download gated
model weights.

## Operating Context

- Users read the interface at a glance while playing from a music stand.
- Users can keep their hands on an instrument. Controls must be easy to reach between phrases.
- A practice session starts with a recording and an analysis job. Users then repeat and slow difficult sections.
- Full-band mixes can mask instruments. Separation and notation are estimates.
- Target machines use Windows ARM64, including Snapdragon X Elite devices.

## Capabilities and Constraints

- **Input:** Analyze YouTube links. Import MIDI (.mid/.midi) and MusicXML (.musicxml/.xml/.mxl) files into the practice workspace.
- **Instruments:** MuScriptor maps GM MIDI drum tokens to kick, snare, closed/open hat, floor tom, high tom, ride, and crash lanes. Other detected labels produce tentative pitched-note tracks. All transcriptions are drafts.
- **Chords:** Show major/minor triads and common sevenths on a beat-aligned timeline. Show the notes for each chord, the detected key, and its role in that key.
- **Practice tools:** Loop a selection and slow playback without changing pitch. Show a synchronized cursor. Add a count-in, a metronome click, and controls to mute the transcribed part.
- **Guitar and bass:** Show single-staff scores, compact tab, and a 3D instrument above the tab. String and fret positions are estimates. Each instrument has a five-level course and studies across 11 genres.
- **Navigation:** Show bar numbers and auto-detected song sections when available.
- **Modes:** Study mode shows every view. Play mode prioritizes the score and shows a piano roll or drum grid as a guide. Switch modes with one key.
- **Exports:** MusicXML, MIDI, chords, separated audio.
- **Accuracy:** Present generated output as study-aid drafts. Show low-confidence passages.
- **Length:** There is no fixed song-length limit. Long jobs need resource warnings, progress, and cancellation.
- **Cloud:** This PC is the default. Optional Azure, Google Cloud, and AWS paths use resources in user-owned accounts. Setup uses provider APIs. Resource changes and token transfer require separate approval.
- **Models:** MuScriptor checkpoints are gated and noncommercial. Model weights are not bundled with the app or cloud worker image.
- **Deferred:** score editing, tab for other instruments, fingering beyond the supported views, transposition, saved named loops, tempo ramping, mastery tracking, and app accounts.
- **Terminology:** "Stem" means an isolated instrument track. "Piano roll" and "drum grid" mean time-based visual views. "Draft" means generated notation.

## Brand Commitments

- Name: **Mizan** (ميزان), an Arabic word for musical meter and balance.
- Open-source project.

## Evidence on Hand

CC0 comparison fixtures and local model benchmarks exist, but an assembled fixture does not establish real-song accuracy. Do not fabricate testimonials, accuracy figures, or performance claims. Copyrighted songs must not be committed as fixtures.

## Product Principles

1. **The playhead is the product.** Every view (score, piano roll/drum grid, chords, audio) follows one shared time position.
2. **Honest drafts.** Show uncertainty rather than hiding it. Never present generated notation as authoritative.
3. **Readable from the music stand.** Anything needed while playing must be legible and reachable at arm's length, mid-performance.
4. **Scaffold notation, do not assume it.** Visual piano and drum guides support the score for users who are new to notation.
5. **Local first and private by consent.** Local processing is the default. Cloud jobs use user-owned resources and require approval.

## Accessibility & Inclusion

- Practice-time text and controls must be legible at arm's length.
- Keyboard shortcuts for transport and looping, so control is quick between phrases.
- Do not rely on color alone for confidence or chord states.
