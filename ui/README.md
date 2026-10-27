# Mizan interface

The interface uses React, TypeScript, and Vite. The Windows app shows it in
WebView2. The native shell sends requests to the Python host through a JSON
bridge. The host owns jobs, the song library, and local file access.

## Develop

Run these commands from the `ui` directory.

Install Node.js, then install the locked dependencies:

```powershell
npm ci
```

Start the Vite development server:

```powershell
npm run dev
```

To build the interface, run:

```powershell
npm run build
```

To lint the interface, run:

```powershell
npm run lint
```

By default, the browser preview uses sample data, not the Python host.
Run the native Windows shell to test the host bridge and real library data.
See the [repository README](../README.md) for host setup and test commands.

## Release updates

The packaged Windows app checks GitHub Releases on launch at most once per day.
Manual checks in About are available with a one-minute cooldown.
When a newer stable release has a matching uploaded package for the installed
architecture, Mizan shows a dismissible notification with a short release-note
summary. **Update on GitHub** opens the release page; Mizan does not download,
install, or restart itself. The dismissed version stays dismissed unless you
choose **Check for updates** in **About**. Browser previews and unpackaged
development builds report that release checks need the installed Windows app.

Open `/?midi=live` on the Vite server to search real public MIDI sources.
This mode supports search only; use the installed app to import a result.
It uses the Python environment in `host\.venv`. Set `MIZAN_DEV_MIDI_PYTHON`
to use a different Python executable. It does not access the real song library.

## Job audio and practice tracks

Job details use real local audio in the Windows app. **Full mix** becomes
available after audio preparation. **Piano** and **Drums** become available
after separation, unless the isolated recording is too weak. Cloud jobs
show isolated recordings after their files return to this PC.
Key and tempo appear after analysis. Completed jobs use their saved files.

Practice shows the saved score parts and recording parts. It does not add
the generated **Creative** group. This change does not delete saved scores
or recordings. Course backing parts remain available.

With Vite running, check job audio and the removed Creative group:

```powershell
node tests\playback.mjs --job-preview
```

## Playable transcription parts

Piano practice splits over-wide parts between two hands and checks whether held chords
leave usable fingers for notes that arrive later. A valid right-hand chord stays in the
right hand; repairs change hand assignments, not piano pitches or note lengths.
Written sustain and sostenuto can free held fingers; the soft pedal cannot.
The animated hands use the constrained fingering suggestions rather than inventing
finger positions for notes that cannot be reached. Those notes still sound and their
keys still light. Guitar and bass practice choose
positions that fit the strings, frets, and hand reach. When a fretted chord is still too
wide, Mizan can shift a recognized chord tone by one octave before leaving a note out;
the chord's pitch classes are preserved, and non-chord notes are reduced before chord
tones when the instrument still lacks strings. The original register remains available
with **As transcribed**. The selected synth part follows the repaired pitches while
**Playable** is active; recording stems and the saved analysis are unchanged.

The hand animation does not glide away from a key that a finger still has to hold.
If written fingering forces a non-thumb hand reposition with no gap, the hand changes
position at the note boundary rather than crossing through a held finger.
Normal thumb-under scale transitions remain supported.

Run the focused repair tests and compare the same local analyses before and after changes:

```powershell
node tests\playability.mjs
node tests\piano-fingers.mjs
node tests\kit-hands.mjs
node tests\playability-songs.mjs "C:\path\to\song-cache"
```

For a before/after comparison, run the report from each revision against the same analysis
folder. It distinguishes moments that were unplayable at their original positions
(`flagged`) from moments still missing notes after repair (`unplayable`), and reports
repositioned notes and octave folds separately. For drums, it flags moments requiring more
than two hand strokes, then counts moments with unassigned hand strokes after sticking
suggestions. Two cymbal strokes can use both hands; moments requiring more than two hand
strokes remain unsuggested.

## Guitar and bass practice

Course shows 80 lessons each for guitar and four-string bass: 25 course
exercises across five levels and 55 studies across 11 genres. Artist-inspired
guitar and bass studies are not listed in Course.
These studies teach playing techniques; they are not song transcriptions.
Scales includes 15 families in all 12 keys, with three patterns for each scale:
an ascending and descending run, broken thirds, and three-note sequences.
Guitar uses E2–A2–D3–G3–B3–E4 tuning.
Bass uses E1–A1–D2–G2 tuning.
Lessons use their own saved practice positions, apart from the song catalog.

Guitar and bass parts offer a score, tab, and a 3D fretboard with tab.
The model sits above a compact tab strip with several bars and rhythm marks.
The single playing view frames the neck and pickup area. Upcoming strings and
frets pulse, the current note glows, and a short flash by the pickup marks each
pluck. An `O` marks an open string: play it without pressing a fret.
Tab and 3D positions are estimated from pitch and standard
tuning; they are not a record of the original player's fingering.
Changing views does not restart playback or change the mixer.
Guitar and bass view choices are saved separately.
The 3D view supports left-handed and right-handed alignment from the player's side.
For a right-handed player, the neck points left and the body sits on the right.
Mizan remembers the chosen hand. Tab keeps its usual
highest-string-first order.

With Vite running, check guitar and bass practice:

```powershell
node tests\playback.mjs --fretted
```

## MIDI search and import

MIDI search checks Commons, Mutopia, Internet Archive, BitMidi, and FreeMIDI
separately. A failed source does not stop the other searches. Commons, Mutopia,
and Internet Archive results need a confirmed per-file license. BitMidi and
FreeMIDI may not list a license. The import dialog requires the user to confirm
permission for each such file before the host downloads it. The app keeps the
source, title, artist, license status, and attribution with the imported score.

## Song analysis settings

Song analysis settings show one topic at a time: audio support, models and
account access, or **Analysis processing**. Use **Getting started guide** to replay
the optional first-use flow. The flow can be skipped; it does not save a path
or token, accept model terms, or download a model without an explicit action.
An empty library can show the guide automatically. Existing libraries and
Course practice are not interrupted. In Audio support, use **Browse…** to pick
`ffmpeg.exe`, or enter its full path. The field shows the configured path or
the FFmpeg path found on this PC. Browsing does not save the path until you
select **Save path**.

Models and account settings show Hugging Face access before model choices.
The access section opens by default when no token is saved.
Links open Hugging Face account creation and its new read-token page; Hugging
Face asks the user to sign in first if needed. Save a read-access token and
accept the model terms before downloading MuScriptor models.

Web links open in the default browser, where the user is usually already signed
in. Mizan's own pages stay in the app window.

## Cloud setup

The interface lets a user select **This PC** or one configured cloud
provider. It displays setup, readiness, job progress, and errors from the host.
Provider settings appear only after Cloud is selected. This PC hides them.
If Cloud needs setup, new analysis stays on This PC until setup finishes
and Cloud is enabled.
Read [cloud setup](../docs/cloud-setup.md) before changing this flow.
