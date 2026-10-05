# mizan

## 0.2.6

Chord-shape keyboards now fit their bars in the score, wrapping when several chords share the same bar instead of overlapping neighboring labels.

### Patch Changes

- Size chord keyboards to their contents and wrap crowded bars.

## 0.2.5

Completed-song processing times now match the steps that actually ran, and chord-shape bars use the available width. MuScriptor errors no longer suggest the removed Standard option.

### Patch Changes

- Time the combined audio-and-note preparation step, report isolated-audio saving separately from HT-Demucs inference, and show MuScriptor as the active processor while a parallel original-mix pass finishes.
- Let chord-shape bars fill the chart width instead of reserving empty columns; reduce crowding when multiple chords share a bar.
- Remove stale Standard recommendations from MuScriptor resource, token-limit, crash, and timeout errors.

## 0.2.4

Mizan can transcribe a YouTube recording even when the direct audio format is denied but its HLS audio stream is available. Download failures that the alternate stream cannot resolve remain visible.

### Patch Changes

- Retry a YouTube audio download as HLS only after an HTTP 403 from the direct format; keep other failures explicit.
- Correct the invalid-model message to list only MuScriptor Small, Medium, and Large.

## 0.2.3

Mizan now describes its MuScriptor-only transcription path consistently in the installed library and browser preview.

### Patch Changes

- Remove outdated in-app descriptions of the retired Standard note-finding method.

## 0.2.2

Mizan now uses MuScriptor alone for audio note transcription; Small is the default, with Medium and Large available when the PC has enough memory. Large loads its official checkpoint within a measured memory limit, and split left- and right-hand piano MIDI parts appear on one score.

### Patch Changes

- Give the official Large model enough guarded memory to load on Windows, and use four CPU threads instead of twelve for its autoregressive inference. Keep Medium's measured twelve-thread setting.
- Remove Standard audio transcription from the library and production pipeline. Preserve MIDI/MusicXML imports, HT-Demucs listening stems, and Beat This! timing; unfinished old Standard jobs fail instead of silently changing models.
- Check available RAM, Windows commit, and checkpoint storage before choosing or starting a MuScriptor job; explain blocked options in the model picker.
- Combine explicitly split upper/lower piano MIDI parts into one two-hand score; show MuScriptor's individual drum lanes, including toms and cymbals.
- Give dense passages that exceed MuScriptor's token limit a specific error instead of a generic checkpoint failure.

## 0.2.1

Drum-only transcriptions now show drum notes without unsupported chords, harmony parts, or very weak vocal stems. This update also tidies uncertain-score markers and library rows, and removes hardware-specific performance claims from model descriptions.

### Patch Changes

- Hide chord and harmony parts when no pitched notes were transcribed, suppress weak vocal leakage in listening stems, and declutter low-confidence scores. Keep model descriptions device-independent and prevent library actions from overlapping timestamps.

## 0.2.0

Mizan now offers a choice of MuScriptor note models and makes its draft scores and processing status easier to understand. This release also improves audio reuse, vocal and drum drafts, chord timing, score imports, and practice controls; automatically inferred notes and chords still need checking against the recording.

### Minor Changes

- Add a choice of the current transcription method or official MuScriptor Small, Medium, and Large on CPU. Download each gated checkpoint separately using a token saved in Windows Credential Manager, with per-model progress and actionable access errors. Keep HT-Demucs for listenable stems and show additional detected instruments as labelled draft notes.
- Respect explicit non-4/4 time signatures in imported MIDI/MusicXML, bar timing, playback and score exports. Use repeated learned downbeats for a tentative 3/4 audio analysis; retain 4/4 when meter is uncertain.

### Patch Changes

- Add an About dialog with the current version, release notes, source and license links, creator details, and access to the full third-party credits.
- Show job steps as readable activity rows, highlight and animate the active step, and surface its model and verified processor while it runs instead of waiting for completion.
- Add an opt-in, checksum-verified YAMNet instrument-presence comparison against stem-RMS on the CC0 mix and clean reference stems, without changing the default transcription pipeline.
- Add a reproducible, checksum-pinned CC0 audio benchmark comparing separation, piano transcription, and beat-grid variants on the same annotated mix, with chord, key, drum-event, timing, and provider measurements and documented limitations.
- Allow deleting individual saved transcription score tracks from the workspace after confirmation. Keep the original recording and isolated stems, update saved library parts and practice selection, and regenerate MIDI/MusicXML score exports without the deleted notes.
- Align the score playhead with engraved note onsets instead of spacing beats evenly across each measure, including during slower playback, seeking and looping.
- Withhold uncorroborated weak-stem piano drafts and likely drum/vocal leakage from transcribed scores. Hide inaudible isolated recordings from the picker and omit their WAVs from newly cached jobs, without touching existing cached songs. Preserve sparse real hits using local peak evidence and report measured reasons and uncertainty.
- Show actual per-job processing activity and warnings in technical details instead of an endless loading message when the host does not provide logs.
- Make the whole job details panel scrollable while keeping its header visible. While details are open, direct wheel input to the panel and stop the library behind it from scrolling, even when WebView2 reports the wrong event target or coordinates. Preserve panel position during running-job updates.
- Add an opt-in, checksum-verified Kong piano versus Basic Pitch benchmark on the existing CC0 piano and mix, without changing the app's transcription model.
- Truncate long song titles in the workspace header instead of letting them overlap the bar position and controls; show the full title on hover.
- Ignore saved window coordinates outside active displays and never save the minimized-window sentinel as the normal position. Keep dev-window placement with its isolated MIZAN_HOME data. Prevents an apparently running app from staying invisible after taskbar activation.
- Reuse compatible separated audio and active jobs when redoing a song, add an isolated-vocal MuScriptor draft, improve drum tom mapping and chord timing, and withhold chord names when only drums have audible evidence. Show honest processing timers, CPU and memory use, and an always-visible action to open a completed song.
- Preserve fractional pitches from imported MusicXML and static MIDI pitch bends in saved scores, synthesized playback, notation and score exports. Automatic recording cents estimation is described separately.
- Keep the search field focused when adding a video, allow additional links to be submitted before the previous request returns, and preserve the next search while the queue updates.
- Show readable model, tool and processor names in job technical details while retaining the original identifiers on hover.
- Estimate cents from sustained isolated piano and vocal note audio only when repeated harmonic measurements agree; leave uncertain detected notes at their original twelve-tone pitches. Preserve fractional results in score and MIDI/MusicXML exports, spelling slight negative detuning against the nearest semitone, without changing twelve-tone harmony analysis. Match benchmark notes within 15 cents rather than requiring exact float equality. Polyphonic overlap and vibrato are not supported by this bounded refinement.
- Clarify that isolated guitar and bass recordings do not provide transcribed scores, and list generated accompaniment under creative parts instead of transcriptions.
- Keep the last identified chord sounding through uncertain passages without labelling it as detected, add denser melody-led or chord-led Harmony line options, and preview identified chord names and shapes while paused through the selected track's mixer.
  Place detected chord changes at measured pitch-class transitions when both adjacent chords have clear audio evidence, instead of automatically delaying them to the next beat.
  Compare fractional melody pitches to symbolic chord tones at the nearest semitone when ranking substitutions, without changing the recorded pitches.
- Keep job timing visible without horizontal scrolling, show a live elapsed counter on queue rows and job details with clearly labelled step and overall percentages, and explain why MuScriptor vocal stems have no dedicated vocal score.

## 0.1.10

### Patch Changes

- Restore the existing Mizan window on redirected launches and request foreground focus when Windows permits it. Background CLI launches cannot override Windows focus protection. Document a labelled, held-out protocol for comparing candidate drum, piano, beat and chord models.

## 0.1.9

- [Measured transcription baseline and quality changes](changesets-history/0.1.9-measured-engine.md).

## 0.1.8

- [Subtle version label sourced from the installer](changesets-history/0.1.8-version-label.md).

## 0.1.7

- [Aligned library layout](changesets-history/0.1.7-library-layout.md).

## 0.1.6

- [Native-compatible folder dragging](changesets-history/0.1.6-native-drag.md).
- [Chord-chart layout and mixer score selection](changesets-history/0.1.6-score-and-mixer.md).

## 0.1.5

- [Custom-folder guidance and drag feedback](changesets-history/0.1.5-folder-guidance.md).

## 0.1.4

- [Six-stem analysis and vocal-melody draft](changesets-history/0.1.4-analysis-and-vocals.md).
- [Sampled playback and offline reprocessing](changesets-history/0.1.4-playback-and-caching.md).
- [Library, score, and mixer corrections](changesets-history/0.1.4-library-and-score.md).

## 0.1.3 and earlier

- [YouTube ingestion, jobs and imports](changesets-history/0.1.3-ingestion.md).
- [ARM64 transcription engine](changesets-history/0.1.3-engine.md).
- [Score-first practice workspace](changesets-history/0.1.3-workspace.md).
- [Creative chord and harmony tracks](changesets-history/0.1.3-creative-tracks.md).
- [Library and queue](changesets-history/0.1.3-library.md).
- [WinUI shell, packaging, branding and credits](changesets-history/0.1.3-windows-shell.md).
