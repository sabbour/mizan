# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The React UI runs in a WebView2 desktop window, packaged as an installable Windows app with web-style interactions.

## Stack

React + TypeScript + Vite for the UI, shown in WebView2 with a .NET 10 host. Python 3.12 handles YouTube ingestion, source separation, transcription, and chord analysis. ONNX Runtime and PyTorch use measured execution providers per model.

## Users

A single hobbyist musician, the author, who plays piano and drums. They read notation slowly and are still learning it. They learn songs from full-band recordings found on YouTube.

## Product Purpose

Mizan (ميزان, the Arabic word for musical meter and also "balance") turns a YouTube link into a practice kit for detected parts. It also imports MIDI and MusicXML for direct practice. Piano and drums are the author's main instruments:

- draft notes and scores for detected instruments, including piano and drums
- a synchronized visual guide appropriate to each supported part
- the song's chord progression

Success means the user can learn a real song from a real recording: play along with it, memorize the part accurately, work through hard passages, understand why the harmony works, and keep a growing repertoire.

## Positioning

A local, open-source tool that separates a full-band mix, transcribes the parts it can identify, and puts notation, visual note guides, and chords on one shared playhead for practice. It runs on the user's own laptop hardware; a Hugging Face account is needed only to download optional gated model weights.

## Operating Context

- The laptop sits on the piano's music stand, at arm's length, while the user plays. The UI is read mid-performance and at a glance.
- The user's hands are usually on the instrument; controls are reached between phrases.
- Typical practice loop: paste a link, wait for processing (minutes, sometimes longer), then repeatedly loop and slow down sections while playing along.
- Sources include full-band mixes; instrument separation and notation are estimates.
- Target machine: Windows on ARM, Snapdragon X Elite (Hexagon NPU, Adreno GPU).

## Capabilities and Constraints

- **Input:** YouTube links for audio analysis; MIDI (.mid/.midi) and MusicXML (.musicxml/.xml/.mxl) files import directly into the practice workspace.
- **Instruments:** Official MuScriptor maps GM MIDI drum tokens to kick, snare, closed/open hat, floor tom, high tom, ride, and crash lanes. Its other detected instrument labels produce individual tentative pitched-note tracks. All transcriptions remain drafts.
- **Chords:** major/minor triads and common sevenths on a beat-aligned timeline, each shown with its notes on a small keyboard, the song's detected key, and the chord's role in that key (I, IV, V…).
- **Practice tools:** loop a selection, slow down without changing pitch, a synchronized playback cursor, a count-in before each loop repeat, a metronome click over the recording, and muting the transcribed part so the user plays it.
- **Navigation:** bar numbers, plus auto-detected song sections (verse, chorus…) when available.
- **Modes:** Study mode (every view, for reading at a desk) and Play mode (score leads, piano roll/drum grid as a thin guide, for reading from the stand), switched with one key.
- **Exports:** MusicXML, MIDI, chords, separated audio.
- **Accuracy:** present generated output as study-aid drafts with visible low-confidence passages.
- **Length:** there is no fixed song-length limit. Long jobs need preflight warnings, progress, and cancellation.
- **Deferred:** score editing, instrument-specific tabs and fingering beyond the supported views, transposition, saved named loops, tempo ramping, mastery tracking, app accounts, and cloud processing.
- **Terminology:** "stem" = an isolated instrument track; "piano roll" / "drum grid" = the time-based visual views; "draft" = generated notation.

## Brand Commitments

- Name: **Mizan** (ميزان). Arabic-inspired naming was the user's explicit choice.
- Open-source project.

## Evidence on Hand

CC0 comparison fixtures and local model benchmarks exist, but an assembled fixture does not establish real-song accuracy. Do not fabricate testimonials, accuracy figures, or performance claims. Copyrighted songs must not be committed as fixtures.

## Product Principles

1. **The playhead is the product.** Every view (score, piano roll/drum grid, chords, audio) follows one shared time position.
2. **Honest drafts.** Show uncertainty rather than hiding it; never present generated notation as authoritative.
3. **Readable from the music stand.** Anything needed while playing must be legible and reachable at arm's length, mid-performance.
4. **Scaffold notation, don't assume it.** The user is still learning to read, so the visual piano roll and drum grid support the score instead of the score standing alone.
5. **Local and private.** Everything runs on the user's machine; nothing depends on a cloud service.

## Accessibility & Inclusion

- Practice-time text and controls must be legible at arm's length.
- Keyboard shortcuts for transport and looping, so control is quick between phrases.
- Do not rely on color alone for confidence or chord states.
