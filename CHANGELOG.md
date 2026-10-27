# mizan

## 0.3.2

### Patch Changes

- Bound video-details inspection with a retryable timeout and process cleanup, and clarify model preparation and download status before publishing verified readiness.

## 0.3.1

### Patch Changes

- Include the complete FlatBuffers Apache 2.0 and proxy_tools BSD-2-Clause license texts in Windows packages, with both proxy_tools copyright notices and corrected credits.

## 0.3.0

### Minor Changes

- 7c7ad03: Check GitHub Releases for newer compatible Windows packages and show a dismissible in-app notification with a short summary of what's new. Add a manual check in About; updating opens the release page without downloading, installing, or interrupting practice.

### Patch Changes

- 1071367: Add a remembered top-down piano camera with independently toggleable animated hands, preserving the existing perspective and synchronized playback.

## 0.2.7

### Patch Changes

- 0025d87: Give the score, tab and live guitar more room on the practice page: the best-effort transcription warning, analysis status and playability note now share one slim row above the practice view. Each keeps its headline visible, and its explanation (or the list of moments in Show where) opens over the practice view instead of pushing it down; Escape or a click elsewhere closes it.
- f936365: Add bounded Cloud diagnostics for GPU Job runs.
- c6171a5: Add a built-in drum course: 37 offline lessons in eight levels, from steady pulse and rests through subdivisions, rudiments, grooves with hi-hat and ride, fills and dynamics to 3/4 and 6/8, plus two style collections: 8 lessons inspired by great drummers, and 55 grooves by genre, five for each of 11 styles (basic groove, two variations, a fill and a four-bar phrase), each played with an original bass line and chords in the style that you can mute or turn down in the track list. The library has Songs and Drum course tabs; each lesson opens from the Drum course tab in the practice view with its score, 3D kit, click, count-in and loop at a starting tempo, with its count, sticking (L and R in hand colours) and steps beside the score; lessons keep their own practice state apart from your songs, and count-in, click, sticking, speed and kit choice follow you between lessons.
- 8fef1fb: Show drums on a detailed 3D kit in its own pane beside the score: an electronic or an acoustic kit, each in four looks (Realistic, Hand-painted clay, Neon rhythm and Technical blueprint). Pieces glow in the hand's colour as their notes approach and pulse when played, cymbals and the hi-hat move with the hits and pedal, and the kit stays sharp at any window size or screen density. If the graphics device cannot draw the kit, the pane says so and the named pieces keep lighting with the hits.
- 97fafc2: Show hands on the 3D drum kit and the 3D piano. On the kit, a left and a right hand each grip a drumstick, and the stick tip lands on the struck drum, cymbal, or hi-hat at the moment of each note, following the lesson's sticking (or the suggested right-hand-lead sticking when the sticking letters are off). On the piano, two hands sit palms down over the keys: the finger the music names presses each sounding key and the others hover just above, and the hands glide to the next notes just before they sound. Both views pose the hands from the playback time alone, so seeking, looping, pausing, and the count-in always show a consistent picture, and reduced motion keeps the hands still at their targets. The hands load only when the 3D view opens, the kit and keyboard keep working if they cannot load, and the hint says plainly that the motion is a suggestion, not a recording. Each hand ends in a short natural wrist that fades out; there are no arms, elbows or seated body.
- 43d6950: Suggested drum sticking is now worked out for the whole part at once instead of note by note. It looks for the easiest hands overall: the right hand keeps the hi-hat or ride with the left on the snare, fast single strokes alternate (judged by seconds, so the song's tempo counts), fills travel around the kit without crossing an arm over the other, and a double stroke appears only where alternating would force a crossing. Lesson sticking is unchanged.
- 6372af2: Make the generated Colour chords, Smooth comping and Harmony line breathe with the song: arpeggios in quiet bars, the song's accents with pushes when moderate, off-beat drive when busy, held phrase endings, a walking bass, phrase-shaped dynamics, resolving suspensions in Colour chords, and a harmony line that steps smoothly, holds over repeated notes and ends phrases on chord tones.
- edcef9b: Open web links in the default browser, where people are already signed in, instead of in an in-app window. The Hugging Face link now goes straight to the new read-token page.
- 97fafc2: Allow more time for FFmpeg's first startup probe and reuse successful validation for the same unchanged executable. Report startup timeouts as retryable instead of suggesting FFmpeg must be downloaded again.
- edcef9b: Simplify FFmpeg setup: Song analysis settings now suggest `winget install Gyan.FFmpeg` first, with a Check again button that finds the WinGet install without a restart. The manual download link remains as an alternative.
- 43d6950: Guitar and bass fretting-hand fingering now looks at the whole part instead of one grip at a time. A best-path search picks one finger per fret in a position, uses the 1-2-4 Simandl fingering on low bass frets, covers same-fret chord notes with an index barre (F major, B minor), keeps open strings fingerless, and never puts one finger on two frets. The string and fret choice also avoids needless hand shifts, the reach near the nut is shorter, and fingering written in a lesson is kept as written.
- 97fafc2: Rewrite guitar and bass genre studies as original eight-bar phrases with idiomatic hooks, answers, turnarounds, playable voicings, and genre-matched sounds.
- 97fafc2: Make a clear flat finger guide the default guitar and bass view, with the full configured fretboard, real narrowing fret spacing, finger numbers, connected barre shapes, and a separately numbered fret ruler. Keep stable, reserved NOW/NEXT guidance for current and next notes—including open strings after long rests and repeated notes on an active string—and keep the finger key and tab layout from jumping as playback changes.

  Keep 3D optional and draw the whole guitar or bass, body and headstock included, as a mirror of a player holding it: a long-lens, almost head-on view with the neck rising toward the headstock (right-handed: neck at screen left, body and bridge at screen right; left-handed reverses; only the picture is reflected, never string numbers or notes), the posed fretting hand, a relaxed picking hand (each hand ends in a short natural wrist that fades out; there are no arms, elbows or seated body), and a small, realistically sized pick that follows the played string in the strumming zone between the end of the fretboard and the middle pickup. Guidance is one small glowing dot at the string and fret with a compact note/fret/finger label, coloured by finger (1 index blue, 2 middle orange, 3 ring green, 4 little pink, thumb grey; the same colour tints the fingertip on the hand, in the flat finger guide, the NOW panel and the key, and the numbers stay), and the next note is shown only as text in the NEXT line, never as a marker; string names are an optional toggle, and all guidance can be hidden. The pluck flash appears where the pick strikes the string, not at the fret. Offer it as the "3D mirror" choice, alongside the default "Finger guide" (there is no separate hand close-up). A right-handed player always frets with the left-hand mesh. Label fret markers explicitly as frets and name the fingers (1 Index, 2 Middle, 3 Ring, 4 Little, T Thumb) in the NOW panel. Keep strings readable with straight guides and dashed hidden sections. Use consistent suggested finger assignments; leave unsupported grips as honest targets without an invented hand pose.

  Keep the fretting hand on screen at all times: the last valid pose stays drawn while the next one is prepared and blends into it (no blend with reduced motion), and open strings and rests show a relaxed hand hovering just above the neck near the neighbouring fretted notes, with no finger badge or contact. Remember the chosen view, look, handedness, string names, guides and Hands switch across lessons, instruments and restarts. Add a shared Hands toggle (on by default) to the guitar and bass mirror, the drum kit and the 3D piano; with it off the hands are not drawn or loaded. Fit the 3D mirror, the NOW and NEXT panel, a one-line key (with a Key button for the full legend), the first tab row and the transport in a laptop-sized window without scrolling.

  Make the timing marks below the tab recognizable notes and rests, with an illustrated reading guide, and do not join note beams across pauses.

- 97fafc2: Keep the 3D fretting hand on the current note. Hand poses for the coming notes are now prepared ahead of the playhead for the whole upcoming part of the song, in time order and one pose per grip, instead of only the next four notes, and the pose solver finds a usable pose far faster (about 0.1 s instead of up to several seconds for a stretched grip). Grips that the remembered fingers would stretch too far, or that give an impossible barre, are planned again so the hand can reach them, and the markers and finger colours always match the pose that is drawn. On a fast let-ring arpeggio the hand no longer shows the previous note's pose.
- d315039: Add a Scales shelf to the guitar and bass course: 15 scale families in all 12 keys, each with a one-octave run, broken thirds, and three-note sequences. Fingering is suggested from pitch and standard tuning.
- 0976a11: Show the drum kit's six toms, closed, open and pedalled hi-hat and pedals in a redrawn 3D kit when the transcription names them; generic hits stay unspecified. Toms play at their own pitch, the score and MusicXML give each tom its own position and write the pedalled hat with the feet, and MIDI export keeps the detected drum.
- 97fafc2: Withhold the guitar and bass Inspired shelf until it contains cleared, faithful riff material rather than placeholder exercises linked to famous songs. Existing lesson IDs and saved practice progress remain available, while saved Inspired browsing choices return to the regular course.
- 97fafc2: Import and play MIDI pitch bends during held notes, preserve their curves through MIDI export and re-import, and label bend events in score exports.
- 628b2ae: Playability repairs and drum sticking are now prepared after transcription and stored separately from the original score. Existing library songs are backfilled when opened, and the original transcription remains available in the practice view.
- 43d6950: Suggested piano fingers now come from a cost-minimising search over whole passages: thumb-under and finger-over scales, black-key-aware fingering, tempo-aware repeated notes, and held notes that block fingers unless a sustain or sostenuto pedal carries them. Written pedals also decide which held notes count against a hand in playability repair.
- 81976e9: Guitar and bass practice can octave-fold recognized chord tones when a voicing cannot fit, preserving the chord pitch classes before marking notes unplayable. If the instrument still has too few strings, non-chord notes are reduced before chord tones. The practice notice identifies shifted tones, while the saved analysis and **As transcribed** view keep the original register. Drum sticking now assigns simultaneous cymbal strokes to both hands instead of leaving them without a suggestion.
- 97fafc2: Make piano hands and guitar and bass tab positions playable. When a transcription asks one hand for more than it can do (more than five keys, a stretch wider than a ninth, hands crossed for too long; two notes on one string, more frets than four fingers cover, a stretch wider than four or five frets, or more notes than strings), Mizan moves the fewest notes to the other hand or to other strings and frets, keeps the written split and positions wherever they already work, and recomputes suggested fingering for moved notes. The score puts moved notes on the other staff, the tab shows the repaired positions, and notes that still cannot be played are marked with a `!`. A small note above the practice view says how many notes changed, lists where, and switches between **Playable** and **As transcribed**. The stored transcription is never changed.
- 0976a11: Detect changing, odd and compound time signatures from tracked downbeats and write drum parts without cluttering rests, with matching tempo in exports and a metronome that counts each bar's own pulse. While practising, the score centres the playing line and offers Scroll to start, the piano playhead follows notes inside each bar, a re-analysed song resumes inside its own bars, fast triple-time songs click on the felt beat with an unaccented pickup, and piano and drum practice views (Hands & keys, 3D kit) dock under the score.
- 6b38fa6: Make the local setup, build, and signing scripts find their own tools. A new `Initialize-HostEnvironment.ps1` creates the host environment with the matching Python 3.12 and your pip configuration. `Publish-SignedMsix.ps1 -Build` builds with the active signing profile's publisher and signs that exact package, finding the Trusted Signing client through the configured NuGet packages folder.
- d047f18: Use all available CPU threads for MuScriptor Large, and offer a one-click retry with MuScriptor Small when local CPU inference times out.
- b0b917a: Add an x64 build option to the MSIX packaging and signing scripts. ARM64 stays the default, and the host now installs the matching x64 PyTorch wheel on x64 Python.
- 3237dbf: Bundle yt-dlp's YouTube challenge solver and a supported JavaScript runtime, and report extraction failures accurately.
- edcef9b: Add in-app YouTube sign-in, sign-out, and private `cookies.txt` import for networks that require account verification. Mizan reuses an existing saved session without opening the sign-in window, and refreshes app-managed sign-in cookies silently when it launches.

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
