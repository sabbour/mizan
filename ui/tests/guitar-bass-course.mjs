// Run from ui\: node tests\guitar-bass-course.mjs
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

globalThis.matchMedia = () => ({ matches: false })
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const {
    BASS_LESSONS, FRETTED_BROWSE_LESSONS, FRETTED_CONFIG, FRETTED_GENRES, FRETTED_LEVELS, FRETTED_LESSONS, GUITAR_LESSONS,
    bassLessonById, frettedGenres, frettedLessonById, frettedLessonList, frettedLessonNote, frettedLessonSong, frettedScaleLessons,
    guitarLessonById,
  } = await vite.ssrLoadModule('/src/course/fretted.ts')
  const { CourseSection, FrettedLessonPanel } = await vite.ssrLoadModule('/src/course/Course.tsx')
  const { browseTo, DEFAULT_BROWSE } = await vite.ssrLoadModule('/src/course/browse.ts')
  const { SCALE_FAMILIES, scaleTonic } = await vite.ssrLoadModule('/src/course/pianoTonal.ts')
  const { freshPosition, lessonPosition, saveLessonPosition } = await vite.ssrLoadModule('/src/course/state.ts')
  const { planFrettedTab, positionsForMidi } = await vite.ssrLoadModule('/src/workspace/fretboard.ts')
  const { songBeats } = await vite.ssrLoadModule('/src/workspace/meter.ts')

  const ids = FRETTED_LESSONS.map((lesson) => lesson.id)
  assert.equal(new Set(ids).size, ids.length, 'all guitar and bass lesson IDs are unique')
  assert.deepEqual(ids, [...GUITAR_LESSONS, ...BASS_LESSONS].map((lesson) => lesson.id), 'lesson IDs and order are stable')
  assert.deepEqual(FRETTED_LEVELS, ['String and fret basics', 'Open and fretted notes', 'String changes and picking', 'Chords and patterns', 'Phrases and grooves'])
  assert.deepEqual(FRETTED_GENRES, [
    'Rock', 'Blues', 'Reggae', 'Pop', 'Disco and dance', 'Jazz', 'Latin: bossa nova', 'Metal', 'Drum and bass', 'R&B and soul', 'Funk',
  ])
  assert.deepEqual(GUITAR_LESSONS.slice(0, 13).map((lesson) => lesson.id), [
    'guitar-open-strings', 'guitar-first-position-e-a', 'guitar-low-string-frets', 'guitar-eighth-note-counting',
    'guitar-string-changes', 'guitar-alternate-picking', 'guitar-c-major-arpeggio', 'guitar-open-chord-rhythm',
    'guitar-c-major-scale', 'guitar-original-riff', 'guitar-rock-fifths', 'guitar-blues-shuffle', 'guitar-pop-chord-change',
  ])
  assert.deepEqual(BASS_LESSONS.slice(0, 13).map((lesson) => lesson.id), [
    'bass-open-strings', 'bass-low-e-pulse', 'bass-first-frets', 'bass-string-changes', 'bass-eighth-note-plucking',
    'bass-root-fifth-groove', 'bass-root-fifth-octave', 'bass-g-major-scale', 'bass-moving-roots', 'bass-original-groove',
    'bass-rock-root-fifth', 'bass-blues-walk', 'bass-pop-root-octave',
  ])
  assert.deepEqual(FRETTED_CONFIG.guitar.strings.map((string) => string.openPitch), ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'])
  assert.equal(FRETTED_CONFIG.guitar.frets, 22)
  assert.deepEqual(FRETTED_CONFIG.bass.strings.map((string) => string.openPitch), ['E1', 'A1', 'D2', 'G2'])
  assert.equal(FRETTED_CONFIG.bass.frets, 20)
  assert.equal(GUITAR_LESSONS.length, 105)
  assert.equal(BASS_LESSONS.length, 105)
  assert.equal(FRETTED_BROWSE_LESSONS.filter((lesson) => lesson.instrument === 'guitar').length, 80)
  assert.equal(FRETTED_BROWSE_LESSONS.filter((lesson) => lesson.instrument === 'bass').length, 80)
  assert.ok(FRETTED_BROWSE_LESSONS.every((lesson) => lesson.kind !== 'inspired'),
    'placeholder Inspired studies are withheld from browsing without deleting their legacy IDs')
  const notationDurations = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 1, 3 / 2, 2]
  const songReferences = {
    guitar: [
      'Purple Haze', 'Little Wing', 'Le Freak', 'Get Lucky', "Ain't Talkin' 'Bout Love", 'Panama',
      'Money for Nothing', 'Sultans of Swing', 'Killing in the Name', 'Bulls on Parade', 'Iron Man', 'Paranoid',
      'Whole Lotta Love', 'Black Dog', 'Back in Black', 'Highway to Hell', 'Smells Like Teen Spirit', 'Come As You Are',
      'Enter Sandman', 'Master of Puppets',
    ],
    bass: [
      "What's Going On", 'I Was Made to Love Her', "Stretchin' Out (In a Rubber Band)", "I'd Rather Be with You",
      'Give It Away', "Can't Stop", 'The Beat Goes On', 'Wichita Lineman', 'Come On, Come Over', 'The Chicken',
      'Another One Bites the Dust', 'Under Pressure', 'Come Together', 'Something', 'Good Times', 'Le Freak',
      'For Whom the Bell Tolls', 'Orion', 'The Trooper', 'Run to the Hills',
    ],
  }
  const songTracksByArtist = {
    guitar: {
      'Jimi Hendrix': ['Purple Haze', 'Little Wing'], 'Nile Rodgers': ['Le Freak', 'Get Lucky'],
      'Eddie Van Halen': ["Ain't Talkin' 'Bout Love", 'Panama'], 'Mark Knopfler': ['Money for Nothing', 'Sultans of Swing'],
      'Tom Morello': ['Killing in the Name', 'Bulls on Parade'], 'Tony Iommi': ['Iron Man', 'Paranoid'],
      'Jimmy Page': ['Whole Lotta Love', 'Black Dog'], 'Angus Young': ['Back in Black', 'Highway to Hell'],
      'Kurt Cobain': ['Smells Like Teen Spirit', 'Come As You Are'], 'James Hetfield': ['Enter Sandman', 'Master of Puppets'],
    },
    bass: {
      'James Jamerson': ["What's Going On", 'I Was Made to Love Her'],
      'Bootsy Collins': ["Stretchin' Out (In a Rubber Band)", "I'd Rather Be with You"],
      Flea: ['Give It Away', "Can't Stop"], 'Carol Kaye': ['The Beat Goes On', 'Wichita Lineman'],
      'Jaco Pastorius': ['Come On, Come Over', 'The Chicken'],
      'John Deacon': ['Another One Bites the Dust', 'Under Pressure'], 'Paul McCartney': ['Come Together', 'Something'],
      'Bernard Edwards': ['Good Times', 'Le Freak'], 'Cliff Burton': ['For Whom the Bell Tolls', 'Orion'],
      'Steve Harris': ['The Trooper', 'Run to the Hills'],
    },
  }
  for (const instrument of ['guitar', 'bass']) {
    const lessons = instrument === 'guitar' ? GUITAR_LESSONS : BASS_LESSONS
    const course = lessons.filter((lesson) => lesson.kind === 'course')
    const genres = lessons.filter((lesson) => lesson.kind === 'genre')
    const inspired = lessons.filter((lesson) => lesson.kind === 'inspired')
    assert.equal(course.length, 25, `${instrument}: five progressive lessons at each of five levels`)
    assert.deepEqual(Array.from({ length: 5 }, (_, index) => course.filter((lesson) => lesson.level === index + 1).length),
      [5, 5, 5, 5, 5], `${instrument}: each course level has five lessons`)
    assert.equal(genres.length, 55, `${instrument}: five studies for each of eleven genres`)
    assert.equal(inspired.length, 25, `${instrument}: five original technique lessons plus twenty song-reference studies`)
    assert.equal(new Set(inspired.map((lesson) => lesson.artist)).size, 10, `${instrument}: Inspired shelf has ten distinct players`)
    const songStudies = inspired.filter((lesson) => lesson.track)
    assert.equal(songStudies.length, 20, `${instrument}: twenty original studies have song references`)
    assert.deepEqual(songStudies.map((lesson) => lesson.track).toSorted(), songReferences[instrument].toSorted(),
      `${instrument}: song references match the requested artists and tracks`)
    assert.deepEqual(Object.fromEntries(Map.groupBy(songStudies, (lesson) => lesson.artist)
      .entries().map(([artist, studies]) => [artist, studies.map((lesson) => lesson.track).toSorted()])),
    Object.fromEntries(Object.entries(songTracksByArtist[instrument]).map(([artist, tracks]) => [artist, tracks.toSorted()])),
    `${instrument}: each song reference is grouped under the requested artist`)
    assert.deepEqual([...new Set(inspired.map((lesson) => lesson.artist))].map((artist) =>
      inspired.filter((lesson) => lesson.artist === artist).length).toSorted(), [2, 2, 2, 2, 2, 3, 3, 3, 3, 3],
    `${instrument}: each of ten artists has two song studies, and existing artists retain their original study`)
    const signature = (lesson) => lesson.notes.map(({ midi, startBeat, beats }) => `${midi}:${startBeat}:${beats}`).join('|')
    const existingMaterial = new Set(lessons.filter((lesson) => !lesson.track).map(signature))
    const songMaterial = songStudies.map(signature)
    assert.equal(new Set(songMaterial).size, songStudies.length, `${instrument}: every song study has distinct note material`)
    for (const lesson of songStudies) {
      assert.ok(!existingMaterial.has(signature(lesson)), `${lesson.id}: note material is distinct from all existing lessons`)
      assert.match(lesson.steps[2], /\bloop\b/i, `${lesson.id}: third practice step has an actionable loop instruction`)
    }
    assert.ok(songStudies.filter((lesson) => lesson.notes.some((note) => note.beats === 0.25)).length >= 8,
      `${instrument}: several studies use real sixteenth-note durations`)
    assert.ok(songStudies.filter((lesson) => lesson.notes.some((note) => note.velocity >= 0.9)).length >= 16,
      `${instrument}: accents are encoded in the authored notes`)
    assert.ok(new Set(songStudies.map((lesson) => lesson.notes.map(({ startBeat, beats }) =>
      `${startBeat % 4}:${beats}`).join('|'))).size >= 15, `${instrument}: song-study rhythms have broad variety`)
    if (instrument === 'guitar') {
      const riffChordIds = [
        'guitar-inspired-nile-le-freak', 'guitar-inspired-nile-get-lucky', 'guitar-inspired-eddie-panama',
        'guitar-inspired-iommi-iron-man', 'guitar-inspired-iommi-paranoid', 'guitar-inspired-angus-back-in-black',
        'guitar-inspired-angus-highway-to-hell', 'guitar-inspired-cobain-smells-like-teen-spirit',
        'guitar-inspired-hetfield-enter-sandman',
      ]
      const pitchesAt = (lesson, bar, beat) => lesson.notes
        .filter((note) => note.startBeat === bar * 4 + beat).map((note) => note.midi).toSorted((a, b) => a - b)
      const barPattern = (lesson, bar) => lesson.notes.filter((note) => Math.floor(note.startBeat / 4) === bar)
        .map(({ midi, startBeat, beats, velocity }) => [midi, startBeat % 4, beats, velocity])
      for (const id of riffChordIds) {
        const lesson = guitarLessonById(id)
        const hits = Map.groupBy(lesson.notes, (note) => note.startBeat)
        assert.ok([...hits.values()].filter((notes) => notes.length >= 2).length >= 2,
          `${id}: riff has multiple simultaneous chord hits`)
        assert.deepEqual(barPattern(lesson, 0), barPattern(lesson, 1), `${id}: bars 1–2 establish a repeatable motif`)
      }
      const leFreak = guitarLessonById('guitar-inspired-nile-le-freak')
      assert.deepEqual(pitchesAt(leFreak, 0, 0.5), [55, 59, 62], 'Le Freak study starts with a simultaneous upper triad')
      assert.deepEqual(pitchesAt(leFreak, 1, 1.5), [52, 55, 59], 'Le Freak repeated motif includes a second upper triad')
      assert.deepEqual(pitchesAt(leFreak, 2, 2.75), [52, 55, 59], 'Le Freak answer includes a short sixteenth-note triad cut')
      assert.ok(leFreak.notes.filter((note) => note.startBeat === 2 * 4 + 2.75).every((note) => note.beats === 0.25),
        'Le Freak sixteenth-note triad voices have short written durations')
      const getLucky = guitarLessonById('guitar-inspired-nile-get-lucky')
      assert.deepEqual(pitchesAt(getLucky, 0, 0.25), [57, 60], 'Get Lucky study starts with a simultaneous offbeat dyad')
      assert.ok(getLucky.notes.filter((note) => note.startBeat === 0.25).every((note) => note.beats === 0.25),
        'Get Lucky opening dyad is a short sixteenth-note cut')
    }
    assert.deepEqual(frettedGenres(instrument), FRETTED_GENRES, `${instrument}: shared genre list`)
    const genreBar = (lesson, bar) => lesson.notes.filter((note) => Math.floor(note.startBeat / 4) === bar)
      .map(({ midi, startBeat, beats, velocity }) =>
        [midi, Number((startBeat % 4).toFixed(6)), Number(beats.toFixed(6)), velocity])
      .toSorted((a, b) => a[1] - b[1] || a[0] - b[0])
    const genrePrograms = {
      Rock: { guitar: 29, bass: 34 }, Blues: { guitar: 27, bass: 33 }, Reggae: { guitar: 27, bass: 33 },
      Pop: { guitar: 27, bass: 33 }, 'Disco and dance': { guitar: 28, bass: 36 },
      Jazz: { guitar: 27, bass: 35 }, 'Latin: bossa nova': { guitar: 24, bass: 33 },
      Metal: { guitar: 30, bass: 34 }, 'Drum and bass': { guitar: 28, bass: 33 },
      'R&B and soul': { guitar: 27, bass: 35 }, Funk: { guitar: 28, bass: 36 },
    }
    for (const genre of FRETTED_GENRES) {
      const studies = genres.filter((lesson) => lesson.genre === genre)
      assert.equal(studies.length, 5, `${instrument}: ${genre} has five studies`)
      assert.deepEqual(studies.map((lesson) => lesson.level).toSorted(), [1, 2, 3, 4, 5], `${instrument}: ${genre} progresses across levels`)
      assert.ok(studies.every((lesson) => lesson.gmProgram === genrePrograms[genre][instrument]),
        `${instrument}: ${genre} uses its intended genre-specific GM sound`)
      assert.equal(new Set(studies.map((lesson) => lesson.notes.map(({ midi, startBeat, beats }) => `${midi}:${startBeat}:${beats}`).join('|'))).size, 5,
        `${instrument}: ${genre} studies have distinct note material`)
      for (const lesson of studies) {
        assert.equal(lesson.bars, 8, `${lesson.id}: authored phrase has eight bars`)
        assert.deepEqual(genreBar(lesson, 0), genreBar(lesson, 2), `${lesson.id}: the opening two-bar hook returns`)
        assert.deepEqual(genreBar(lesson, 1), genreBar(lesson, 3), `${lesson.id}: the second hook bar returns`)
        assert.deepEqual(genreBar(lesson, 0), genreBar(lesson, 6), `${lesson.id}: the hook returns after the answer`)
        assert.deepEqual(genreBar(lesson, 5), genreBar(lesson, 7), `${lesson.id}: the turnaround resolves both phrases`)
        assert.notDeepEqual(genreBar(lesson, 0), genreBar(lesson, 4), `${lesson.id}: the answer contrasts with the hook`)
        assert.ok(Math.max(...lesson.notes.map((note) => note.velocity)) - Math.min(...lesson.notes.map((note) => note.velocity)) >= 0.1,
          `${lesson.id}: accents and lighter attacks are both written`)
      }
      assert.equal(frettedLessonList(studies[0]).length, 5, `${instrument}: ${genre} lesson navigation stays in that genre`)
    }
    const genreStudy = (genre, level = 1) => genres.find((lesson) => lesson.genre === genre && lesson.level === level)
    const notesAt = (lesson, bar, beat) => lesson.notes.filter((note) => note.startBeat === bar * 4 + beat)
    const hasDuration = (lesson, duration) => lesson.notes.some((note) => Math.abs(note.beats - duration) < 1e-9)
    if (instrument === 'guitar') {
      const rockHook = notesAt(genreStudy('Rock'), 0, 0)
      assert.deepEqual(rockHook.map((note) => note.midi).toSorted((a, b) => a - b), [40, 47],
        'Rock opens with an E5 power-chord hook, not a scale fragment')
      const shuffle = genreStudy('Blues')
      assert.ok(notesAt(shuffle, 0, 0).every((note) => Math.abs(note.beats - 2 / 3) < 1e-9) &&
        notesAt(shuffle, 0, 2 / 3).every((note) => Math.abs(note.beats - 1 / 3) < 1e-9),
      'Blues uses a real long-short shuffle double-stop')
      assert.equal(notesAt(genreStudy('Reggae'), 0, 0.5).length, 3, 'Reggae chords land together on offbeats')
      assert.equal(notesAt(genreStudy('Reggae'), 0, 0).length, 0, 'Reggae leaves the downbeat open')
      assert.deepEqual(notesAt(genreStudy('Pop'), 0, 0).map((note) => note.midi).toSorted((a, b) => a - b),
        [48, 52, 55], 'Pop starts on a voiced C triad')
      assert.equal(notesAt(genreStudy('Disco and dance'), 0, 1).length, 3, 'Disco has clipped upper-chord hits on the backbeat')
      assert.deepEqual(notesAt(genreStudy('Jazz'), 0, 1).map((note) => note.midi).toSorted((a, b) => a - b),
        [53, 60], 'Jazz comping starts with a D-minor guide-tone shell')
      assert.equal(notesAt(genreStudy('Latin: bossa nova'), 0, 0).length, 1, 'Bossa alternates a bass-register root with its chord')
      assert.equal(notesAt(genreStudy('Latin: bossa nova'), 0, 1.5).length, 3, 'Bossa chord answer lands on its syncopated offbeat')
      assert.deepEqual(rockHook.map((note) => note.velocity > 0.85), [true, true], 'Rock power-chord accents are explicit')
      assert.ok(genreStudy('Metal', 5).notes.some((note) => note.beats === 0.25) &&
        genreStudy('Metal', 5).notes.some((note) => note.midi === 40 && note.beats >= 1.5),
      'Metal combines a short burst with a breathing pedal-note resolution')
      assert.ok(new Set(genreStudy('Drum and bass').notes.map((note) => note.startBeat)).size <= 16,
        'Drum and bass stays sparse around its syncopated stabs')
      assert.ok(notesAt(genreStudy('R&B and soul'), 0, 0).length >= 3 &&
        notesAt(genreStudy('R&B and soul'), 0, 0).every((note) => note.beats >= 1.5),
      'R&B opens with a warm, sustained chord voicing')
      assert.ok(notesAt(genreStudy('Funk'), 0, 0).length >= 4 &&
        genreStudy('Funk', 5).notes.some((note) => note.beats === 0.25),
      'Funk uses clipped upper voicings and later adds sixteenth-note syncopation')
      assert.match(genreStudy('Funk').title, /E7/)
      assert.deepEqual(notesAt(genreStudy('Funk'), 0, 0).map((note) => note.midi % 12).toSorted((a, b) => a - b),
        [2, 4, 8, 11], 'the Funk hook is correctly named E7, not E9 without a ninth')
      assert.match(genreStudy('R&B and soul').goal, /warm Am chord/)
      assert.deepEqual(notesAt(genreStudy('R&B and soul'), 0, 0).map((note) => note.midi % 12).toSorted((a, b) => a - b),
        [0, 4, 9], 'the first R&B study teaches an Am triad without claiming a seventh')
    } else {
      assert.deepEqual(notesAt(genreStudy('Rock'), 0, 0).map((note) => note.midi), [28], 'Rock bass opens on a firm E root')
      assert.ok(notesAt(genreStudy('Rock'), 0, 2).some((note) => note.midi === 35), 'Rock bass answers its root with the fifth')
      assert.ok(genreStudy('Blues', 3).notes.some((note) => note.midi === 37), 'Blues bass uses a real A-major boogie third')
      assert.ok(genreStudy('Reggae').notes.every((note) => [2, 3.5].includes(note.startBeat % 4)),
        'Reggae bass keeps the one-drop pulse spacious')
      assert.ok(notesAt(genreStudy('Pop', 2), 0, 0).some((note) => note.midi === 36) &&
        notesAt(genreStudy('Pop', 2), 0, 2).some((note) => note.midi === 48),
      'Pop bass uses an intentional root-to-octave answer')
      assert.ok(notesAt(genreStudy('Disco and dance'), 0, 0).some((note) => note.midi === 33) &&
        notesAt(genreStudy('Disco and dance'), 0, 1).some((note) => note.midi === 45),
      'Disco bass establishes its octave hook')
      assert.ok(genreStudy('Jazz', 4).notes.some((note) => note.startBeat % 1 === 0.5 || note.startBeat % 1 === 0.25),
        'Jazz bass uses chromatic approach notes around its walking quarter notes')
      assert.ok(genreStudy('Latin: bossa nova', 4).notes.some((note) => note.startBeat % 4 === 3.5),
        'Bossa bass anticipates the next chord')
      assert.ok(hasDuration(genreStudy('Metal', 3), 0.25), 'Metal bass uses a straight sixteenth-note gallop')
      assert.ok(genreStudy('Drum and bass', 4).notes.some((note) => note.beats === 0.25) &&
        genreStudy('Drum and bass', 4).notes.length < 32,
      'Drum and bass bassline combines tight syncopation with sub-bass space')
      assert.ok(genreStudy('R&B and soul').notes.some((note) => note.beats === 2), 'R&B bass lets the root notes breathe')
      assert.ok(genreStudy('Funk', 4).notes.some((note) => note.beats === 0.25) &&
        genreStudy('Funk', 4).notes.some((note) => note.velocity < 0.7),
      'Funk bass uses clipped sixteenths with ghosted lighter attacks')
    }
    for (const lesson of lessons) {
      const where = lesson.id
      const song = frettedLessonSong(lesson)
      const config = FRETTED_CONFIG[instrument]
      const beats = songBeats(song)
      assert.ok(lesson.goal.length > 30 && lesson.steps.length >= 3, `${where}: goal and practical steps`)
      assert.ok(lesson.tempo.start < lesson.tempo.target && lesson.tempo.start / lesson.tempo.target >= 0.5, `${where}: playable starting speed`)
      assert.equal(lesson.bars, lesson.kind === 'genre' ? 8 : 4, `${where}: bars match the lesson type`)
      assert.ok(lesson.notes.length >= 8, `${where}: enough material for a real exercise`)
      assert.equal(song.source, 'course')
      assert.equal(song.bars, lesson.bars)
      assert.equal(songBeats(song), lesson.bars * 4, `${where}: measure map covers the lesson`)
      assert.equal(song.bpm, lesson.tempo.target)
      assert.deepEqual(song.tracks.map((track) => [track.id, track.instrument, track.gmProgram]), [[instrument, 'other',
        lesson.kind === 'genre' ? lesson.gmProgram : instrument === 'guitar' ? 27 : 33]])
      assert.equal(song.tracks[0].group, undefined, `${where}: lesson instrument is not hidden as Creative backing`)
      assert.deepEqual(song.instrumentNotes[instrument], lesson.notes, `${where}: correct part notes reach the Song`)
      assert.ok(song.instrumentNotes[instrument].length > 0)
      assert.deepEqual(song.instrumentNotes[instrument].map((note) => note.trackId), Array(lesson.notes.length).fill(instrument))
      const filtered = frettedLessonList(lesson)
      assert.ok(filtered.every((item) => item.instrument === instrument && item.kind === lesson.kind &&
        (lesson.kind === 'course' || lesson.kind === 'genre' && item.genre === lesson.genre ||
          lesson.kind === 'inspired' && item.artist === lesson.artist)), `${where}: instrument, shelf and filter routing`)
      assert.equal(filtered.length, lesson.kind === 'course' ? 25 : lesson.kind === 'genre' ? 5
        : lesson.kind === 'inspired' ? inspired.filter((item) => item.artist === lesson.artist).length : 1,
      `${where}: the correct lesson list is shown`)
      assert.ok(filtered.includes(lesson), `${where}: Previous/Next list includes the lesson`)
      assert.strictEqual(frettedLessonById(lesson.id), lesson, `${where}: route preserves lesson identity`)
      for (const note of lesson.notes) {
        assert.ok(Number.isInteger(note.midi) && positionsForMidi(note.midi, config).length > 0, `${where}: pitch ${note.midi} fits the instrument tuning and fret range`)
        assert.ok(note.startBeat >= 0 && note.beats > 0 && note.startBeat + note.beats <= beats + 1e-9, `${where}: note stays inside the lesson`)
        assert.ok(Math.abs(note.startBeat * 12 - Math.round(note.startBeat * 12)) < 1e-8 &&
          notationDurations.some((beats) => Math.abs(note.beats - beats) < 1e-9),
          `${where}: note onset and duration fit the conventional quarter/eighth/half/triplet notation grid`)
        assert.ok(note.velocity > 0 && note.velocity <= 1, `${where}: note velocity is valid`)
      }
      const tab = planFrettedTab(song.instrumentNotes[instrument], config)
      assert.equal(tab.length, lesson.notes.length)
      assert.ok(tab.every((item) => item.position && !item.reason), `${where}: every tab note has a playable position`)
      const onsets = new Map()
      for (const item of tab) {
        const group = onsets.get(item.startBeat) ?? []
        group.push(item.position.string)
        onsets.set(item.startBeat, group)
      }
      for (const [beat, strings] of onsets)
        assert.equal(new Set(strings).size, strings.length, `${where}: simultaneous notes at ${beat} use different strings`)
      if (lesson.kind === 'genre' && instrument === 'guitar')
        for (const [beat, sameBeat] of Map.groupBy(tab, (item) => item.startBeat)) if (sameBeat.length > 1) {
          const frets = sameBeat.map((item) => item.position.fret)
          assert.ok(Math.max(...frets) - Math.min(...frets) <= 5, `${where}: chord at ${beat} fits a compact fretting-hand span`)
        }
      for (const [id, sameString] of Map.groupBy(tab, (item) => item.position.string)) {
        const ordered = sameString.toSorted((a, b) => a.startBeat - b.startBeat)
        ordered.forEach((item, index) => assert.ok(index === 0 || ordered[index - 1].startBeat + ordered[index - 1].beats <= item.startBeat + 1e-9,
          `${where}: string ${id} is free before beat ${item.startBeat}`))
      }
    }
  }
  const scaleIds = []
  for (const instrument of ['guitar', 'bass']) {
    for (const family of SCALE_FAMILIES) for (let pitch = 0; pitch < 12; pitch++) {
      const tonic = scaleTonic(pitch, family.id)
      const root = (instrument === 'guitar' ? 48 : 36) + pitch
      const lessons = frettedScaleLessons(instrument, pitch, family.id)
      assert.equal(lessons.length, 3, `${instrument}: ${tonic} ${family.name} has three playable patterns`)
      assert.deepEqual(lessons.map((lesson) => lesson.variant), ['run', 'thirds', 'sequence'])
      assert.strictEqual(frettedScaleLessons(instrument, pitch, family.id), lessons, `${instrument}: ${tonic} ${family.id} keeps its lesson list stable`)
      const run = lessons[0]
      const descending = family.down ?? family.up
      const expected = [
        ...family.up.map((step) => root + step), root + 12,
        ...descending.slice(1).toReversed().map((step) => root + step), root,
      ]
      assert.deepEqual(run.notes.map((note) => note.midi), expected, `${instrument}: ${tonic} ${family.id} ascends and descends with its scale intervals`)
      assert.equal(run.notes.filter((note) => note.startBeat < expected.length / 2).length, expected.length)
      if (family.id === 'melodic-minor') {
        const downPitches = run.notes.map((note) => note.midi).slice(family.up.length + 1)
        assert.deepEqual(downPitches, [root + 10, root + 8, root + 7, root + 5, root + 3, root + 2, root],
          `${instrument}: melodic minor uses the natural minor descent`)
      }
      for (const lesson of lessons) {
        scaleIds.push(lesson.id)
        assert.strictEqual(frettedLessonById(lesson.id), lesson, `${lesson.id}: lesson route preserves identity`)
        const lessonList = frettedLessonList(lesson)
        assert.deepEqual(lessonList.map((item) => item.id), lessons.map((item) => item.id),
          `${lesson.id}: previous and next stay within the selected key and family`)
        assert.strictEqual(lessonList[lesson.level - 1], lesson, `${lesson.id}: navigation list preserves identity`)
        assert.ok(lesson.goal.length > 30 && lesson.steps.length >= 3, `${lesson.id}: instructions are useful`)
        assert.ok(lesson.notes.length >= 8, `${lesson.id}: has enough note material`)
        const tab = planFrettedTab(lesson.notes, FRETTED_CONFIG[instrument])
        assert.equal(tab.length, lesson.notes.length)
        assert.ok(tab.every((item) => item.position && !item.reason), `${lesson.id}: every note maps to suggested tab`)
        const onsets = new Map()
        for (const item of tab) {
          const strings = onsets.get(item.startBeat) ?? []
          strings.push(item.position.string)
          onsets.set(item.startBeat, strings)
        }
        for (const [beat, strings] of onsets)
          assert.equal(new Set(strings).size, strings.length, `${lesson.id}: simultaneous notes at ${beat} use separate strings`)
        for (const [string, sameString] of Map.groupBy(tab, (item) => item.position.string)) {
          const ordered = sameString.toSorted((a, b) => a.startBeat - b.startBeat)
          ordered.forEach((item, index) => assert.ok(index === 0 || ordered[index - 1].startBeat + ordered[index - 1].beats <= item.startBeat + 1e-9,
            `${lesson.id}: string ${string} is free before beat ${item.startBeat}`))
        }
      }
    }
  }
  assert.equal(new Set([...ids, ...scaleIds]).size, ids.length + scaleIds.length, 'all static and generated scale IDs are unique')
  assert.deepEqual(frettedScaleLessons('guitar', 0, 'major')[1].notes.map((note) => note.midi), [
    48, 52, 50, 53, 52, 55, 53, 57, 55, 59, 57, 60, 59, 62,
    60, 57, 59, 55, 57, 53, 55, 52, 53, 50, 52, 48, 50, 47, 48, 45,
  ], 'C-major broken thirds are scale notes two degrees apart in both directions')
  assert.deepEqual(frettedScaleLessons('guitar', 0, 'major-pentatonic')[1].notes.map((note) => note.midi), [
    48, 52, 50, 55, 52, 57, 55, 60, 57, 62,
    60, 55, 57, 52, 55, 50, 52, 48, 50, 45, 48, 43,
  ], 'C-major pentatonic broken thirds skip its pentatonic degrees in both directions')
  const tabPositions = (lesson) => planFrettedTab(lesson.notes, FRETTED_CONFIG[lesson.instrument])
  assert.deepEqual(tabPositions(guitarLessonById('guitar-open-strings')).slice(0, 6).map(({ position }) =>
    [position.conventionalStringNumber, position.fret]), [[6, 0], [5, 0], [4, 0], [3, 0], [2, 0], [1, 0]],
  'the guitar open-string lesson maps to all six open strings')
  assert.deepEqual(tabPositions(bassLessonById('bass-open-strings')).slice(0, 4).map(({ position }) =>
    [position.conventionalStringNumber, position.fret]), [[4, 0], [3, 0], [2, 0], [1, 0]],
  'the bass open-string lesson maps to all four open strings')
  assert.deepEqual(tabPositions(guitarLessonById('guitar-string-changes')).slice(0, 4).map(({ position }) =>
    [position.conventionalStringNumber, position.fret]), [[6, 0], [5, 0], [4, 0], [3, 0]],
  'the guitar string-change lesson begins on its four written open pitches')

  const bluesShuffle = guitarLessonById('guitar-blues-shuffle')
  for (let bar = 0; bar < Math.min(bluesShuffle.bars, 4); bar++) {
    const onsets = bluesShuffle.notes.filter((note) => Math.floor(note.startBeat / 4) === bar)
      .map((note) => note.startBeat - bar * 4).filter((beat, index, beats) => beats.indexOf(beat) === index).sort((a, b) => a - b)
    const gaps = onsets.slice(1).map((beat, index) => Math.round((beat - onsets[index]) * 3))
    assert.deepEqual(gaps, Array.from({ length: onsets.length - 1 }, (_, index) => index % 2 ? 1 : 2),
      `guitar Blues bar ${bar + 1} alternates long-short triplet gaps`)
  }

  const popChordChange = guitarLessonById('guitar-pop-chord-change')
  const chordAt = (lesson, bar, offset) => lesson.notes.filter((note) => Math.abs(note.startBeat - (bar * 4 + offset)) < 1e-9)
    .map((note) => note.midi).sort((a, b) => a - b)
  const popChords = {
    c: [48, 52, 55], g: [55, 59, 62], am: [57, 60, 64], f: [53, 57, 60],
  }
  for (const bar of [0, 2]) {
    assert.deepEqual(chordAt(popChordChange, bar, 0), popChords.c, `Pop bar ${bar + 1} starts on C`)
    assert.deepEqual(chordAt(popChordChange, bar, 2.5), popChords.g, `Pop bar ${bar + 1} answers with G`)
  }
  for (const bar of [1, 3]) {
    assert.deepEqual(chordAt(popChordChange, bar, 0), popChords.am, `Pop bar ${bar + 1} moves to Am`)
    assert.deepEqual(chordAt(popChordChange, bar, 2.5), popChords.f, `Pop bar ${bar + 1} answers with F`)
  }
  assert.match(popChordChange.steps[1], /two-bar .* hook/i)

  const gMajorScale = bassLessonById('bass-g-major-scale')
  const barPitches = (lesson, bar) => lesson.notes.filter((note) => Math.floor(note.startBeat / 4) === bar)
    .sort((a, b) => a.startBeat - b.startBeat).map((note) => note.midi)
  assert.deepEqual(barPitches(gMajorScale, 0), [31, 33, 35, 36, 38, 40, 42, 43], 'G-major bar 1 ascends')
  assert.deepEqual(barPitches(gMajorScale, 1), [43, 42, 40, 38, 36, 35, 33, 31], 'G-major bar 2 descends')
  assert.deepEqual(barPitches(gMajorScale, 2), [31, 35, 38, 42, 43, 42, 38, 35], 'G-major bar 3 uses its written skips')
  assert.deepEqual(barPitches(gMajorScale, 3), [33, 36, 40, 43, 40, 36, 33, 31], 'G-major bar 4 uses its written return phrase')
  assert.match(gMajorScale.steps[0], /Bars 1 and 2.*up, then back down/)
  assert.match(gMajorScale.steps[1], /Bars 3 and 4.*skipped-note patterns/)
  assert.match(gMajorScale.steps[2], /string choices are inferred from pitch, not fixed/)

  const guitarScale = guitarLessonById('guitar-c-major-scale')
  const guitarPitchesByBar = (lesson, bar) => lesson.notes.filter((note) => Math.floor(note.startBeat / 4) === bar)
    .sort((a, b) => a.startBeat - b.startBeat).map((note) => note.midi)
  assert.deepEqual(guitarPitchesByBar(guitarScale, 0), [48, 50, 52, 53, 55, 57, 59, 60])
  assert.deepEqual(guitarPitchesByBar(guitarScale, 1), [60, 59, 57, 55, 53, 52, 50, 48])
  assert.match(guitarScale.steps[1], /scale up in bar 1 and down in bar 2/)
  assert.match(guitarScale.steps[2], /broken scale pattern in bar 3.*second pattern in bar 4/)

  const originalRiff = guitarLessonById('guitar-original-riff')
  assert.ok(originalRiff.notes.some((note) => note.midi === 40 && note.startBeat === 7.5 && note.beats === 0.5),
    'the low E pickup is the final eighth note of bar 2')
  assert.match(originalRiff.steps[1], /low E pickup short/)
  const callAndAnswer = guitarLessonById('guitar-call-answer-riff')
  assert.ok(callAndAnswer.notes.some((note) => note.startBeat === 15 && note.midi === 40 && note.beats === 1),
    'the final E follows one beat of rest in bar 4')
  assert.match(callAndAnswer.steps[2], /Leave one beat of space in bar 4/)
  const fourBarRiff = guitarLessonById('guitar-four-bar-riff')
  assert.ok(fourBarRiff.notes.some((note) => note.startBeat === 14 && note.midi === 40 && note.beats === 1),
    'the final E rings for one beat, leaving the last beat silent')
  assert.match(fourBarRiff.steps[2], /final E ring for one beat.*last beat silent/)

  const bassRootFifth = bassLessonById('bass-root-fifth-groove')
  assert.ok(bassRootFifth.notes.some((note) => note.startBeat === 15.5 && note.midi === 28 && note.beats === 0.5),
    'the last note of the E groove is an eighth-note E pickup at the loop end')
  assert.match(bassRootFifth.goal, /short pickup/)
  assert.match(bassRootFifth.steps[2], /last eighth-note pickup to return to E/)
  const bassTriplets = bassLessonById('bass-triplet-pulse')
  for (let bar = 0; bar < bassTriplets.bars; bar++) {
    const notesInBar = bassTriplets.notes.filter((note) => Math.floor(note.startBeat / 4) === bar)
    assert.equal(notesInBar.length, 12, `Bass triplet bar ${bar + 1} fills all twelve triplet slots`)
    assert.ok(Math.abs(Math.max(...notesInBar.map((note) => note.startBeat + note.beats)) - (bar + 1) * 4) < 1e-9,
      `Bass triplet bar ${bar + 1} ends on the bar line without an unnotated rest`)
  }
  assert.match(bassTriplets.steps[2], /start the next bar on time/)
  assert.doesNotMatch(bassTriplets.steps.join(' '), /last rest silent/)

  const unsupportedPositionClaim = /\b(?:on|at|from) (?:the )?(?:low |high )?(?:E|A|D|G|B) string\b|\bfret(?:s)? \d+/i
  for (const lesson of FRETTED_LESSONS.filter((item) => !['guitar-open-strings', 'bass-open-strings', 'bass-low-e-pulse'].includes(item.id)))
    assert.doesNotMatch(`${lesson.title} ${lesson.goal} ${lesson.steps.join(' ')}`, unsupportedPositionClaim,
      `${lesson.id}: no unverified string/fret assignment in the lesson copy`)

  assert.equal(guitarLessonById('guitar-open-strings'), GUITAR_LESSONS[0])
  assert.equal(bassLessonById('bass-open-strings'), BASS_LESSONS[0])
  assert.equal(frettedLessonById('guitar-open-strings').instrument, 'guitar')
  assert.equal(frettedLessonNote(guitarLessonById('guitar-blues-shuffle')), 'Guitar Blues study · Level 4')
  assert.deepEqual(frettedLessonList(guitarLessonById('guitar-blues-shuffle')).map((lesson) => lesson.id), [
    'guitar-blues-level-1', 'guitar-blues-level-2', 'guitar-blues-level-3', 'guitar-blues-shuffle', 'guitar-blues-level-5',
  ])

  const savedValues = new Map()
  globalThis.localStorage = {
    getItem: (key) => savedValues.get(key) ?? null,
    setItem: (key, value) => savedValues.set(key, value),
  }
  for (const lesson of [
    guitarLessonById('guitar-open-chord-rhythm'), bassLessonById('bass-root-fifth-octave'),
    guitarLessonById('guitar-inspired-nile-rodgers'), bassLessonById('bass-inspired-jaco-pastorius'),
    guitarLessonById('guitar-inspired-jimi-purple-haze'), bassLessonById('bass-inspired-harris-the-trooper'),
    frettedScaleLessons('guitar', 6, 'melodic-minor')[0], frettedScaleLessons('bass', 9, 'blues')[0],
  ]) {
    const fresh = freshPosition(lesson)
    assert.equal(fresh.trackId, lesson.instrument)
    assert.deepEqual(fresh.loop, { startBar: 1, endBar: lesson.bars })
    const saved = { ...fresh, bar: 2, loop: { startBar: 2, endBar: 3 }, rate: 0.65, muted: [lesson.instrument], solo: ['click'] }
    saveLessonPosition(lesson, saved)
    assert.deepEqual(lessonPosition(lesson), saved, `${lesson.id}: saved practice choices restore`)
  }

  const chosen = {
    ...DEFAULT_BROWSE, instrument: 'guitar', guitarShelf: 'genre', guitarGenre: 'Blues',
    bassShelf: 'genre', bassGenre: 'Pop', pianoShelf: 'scale', pianoScale: 'minor',
  }
  const genreBrowse = browseTo('guitar-blues-shuffle', chosen)
  assert.deepEqual(genreBrowse, chosen, 'opening a guitar genre study preserves the selected instrument and filters')
  assert.equal(browseTo('bass-pop-root-octave', genreBrowse).instrument, 'bass', 'Bass lessons select Bass on open')
  assert.equal(browseTo('bass-pop-root-octave', genreBrowse).bassGenre, 'Pop', 'the selected Bass genre remains active')
  assert.equal(browseTo('guitar-open-strings', genreBrowse).guitarShelf, 'course', 'course lessons return to their level list')
  assert.equal(browseTo('guitar-open-strings', genreBrowse).guitarGenre, 'Blues', 'the prior Guitar genre remains selected')
  assert.equal(chosen.instrument, 'guitar', 'the pre-practice browse state remains available for Back')
  const guitarInspired = guitarLessonById('guitar-inspired-nile-rodgers')
  const guitarInspiredBrowse = browseTo(guitarInspired.id, chosen)
  assert.equal(guitarInspiredBrowse.guitarShelf, 'inspired', 'inspired lessons return to the Inspired shelf')
  assert.equal(guitarInspiredBrowse.guitarArtist, 'Nile Rodgers', 'Back restores the selected artist')
  const guitarSongStudy = guitarLessonById('guitar-inspired-jimi-purple-haze')
  const guitarSongBrowse = browseTo(guitarSongStudy.id, chosen)
  assert.equal(guitarSongBrowse.guitarShelf, 'inspired', 'song-linked guitar study returns to the Inspired shelf')
  assert.equal(guitarSongBrowse.guitarArtist, guitarSongStudy.artist, 'Back restores the song study artist')
  const bassSongStudy = bassLessonById('bass-inspired-harris-the-trooper')
  const bassSongBrowse = browseTo(bassSongStudy.id, chosen)
  assert.equal(bassSongBrowse.bassShelf, 'inspired', 'song-linked bass study returns to the Inspired shelf')
  assert.equal(bassSongBrowse.bassArtist, bassSongStudy.artist, 'Back restores the bass song study artist')
  const bassScale = frettedScaleLessons('bass', 6, 'melodic-minor')[0]
  const bassScaleBrowse = browseTo(bassScale.id, chosen)
  assert.equal(bassScaleBrowse.instrument, 'bass', 'a bass scale selects Bass on open')
  assert.equal(bassScaleBrowse.bassShelf, 'scale', 'bass scale returns to the Scales shelf')
  assert.deepEqual(bassScaleBrowse.bassKey, { pitch: 6 }, 'Back restores the bass tonic')
  assert.equal(bassScaleBrowse.bassScale, 'melodic-minor', 'Back restores the bass scale family')
  assert.equal(bassScaleBrowse.guitarKey.pitch, chosen.guitarKey.pitch, 'bass scale routing preserves the independent guitar key')
  assert.equal(bassScaleBrowse.guitarScale, chosen.guitarScale, 'bass scale routing preserves the independent guitar family')

  const guitarMarkup = renderToStaticMarkup(createElement(CourseSection, {
    browse: { ...DEFAULT_BROWSE, instrument: 'guitar', guitarShelf: 'genre', guitarGenre: 'Rock' },
    onBrowse: () => {}, onLesson: () => {},
  }))
  assert.match(guitarMarkup, /Guitar by genre/)
  assert.match(guitarMarkup, /data-choice="guitar"/)
  assert.match(guitarMarkup, /data-choice="bass"/)
  assert.match(guitarMarkup, /data-choice="genre"/)
  assert.match(guitarMarkup, />Genres</)
  assert.match(guitarMarkup, /Rock: E5 hook/)
  assert.match(guitarMarkup, /Rock: Muted eighth-note drive/)
  assert.match(guitarMarkup, /Each eight-bar phrase/)
  assert.doesNotMatch(guitarMarkup, /four-bar pattern/)
  assert.doesNotMatch(guitarMarkup, /Blues: a two-note shuffle|Pop: C to G chord changes/)
  const inspiredMarkup = renderToStaticMarkup(createElement(CourseSection, {
    browse: { ...DEFAULT_BROWSE, instrument: 'guitar', guitarShelf: 'inspired', guitarArtist: 'Nile Rodgers' },
    onBrowse: () => {}, onLesson: () => {},
  }))
  assert.match(inspiredMarkup, /data-fretted-shelf="course"/)
  assert.match(inspiredMarkup, /Guitar course/)
  assert.doesNotMatch(inspiredMarkup, /data-choice="inspired"|Inspired|Nile Rodgers|Clipped offbeat chord cuts/)
  const songInspiredMarkup = renderToStaticMarkup(createElement(CourseSection, {
    browse: { ...DEFAULT_BROWSE, instrument: 'guitar', guitarShelf: 'inspired', guitarArtist: 'Jimi Hendrix' },
    onBrowse: () => {}, onLesson: () => {},
  }))
  assert.match(songInspiredMarkup, /data-fretted-shelf="course"/)
  assert.doesNotMatch(songInspiredMarkup, /data-choice="inspired"|Jimi Hendrix|Purple Haze|Song reference:/)
  const bassSongInspiredMarkup = renderToStaticMarkup(createElement(CourseSection, {
    browse: { ...DEFAULT_BROWSE, instrument: 'bass', bassShelf: 'inspired', bassArtist: 'Steve Harris' },
    onBrowse: () => {}, onLesson: () => {},
  }))
  assert.match(bassSongInspiredMarkup, /data-fretted-shelf="course"/)
  assert.match(bassSongInspiredMarkup, /Bass course/)
  assert.doesNotMatch(bassSongInspiredMarkup, /data-choice="inspired"|Steve Harris|The Trooper|Song reference:/)
  const scaleMarkup = renderToStaticMarkup(createElement(CourseSection, {
    browse: { ...DEFAULT_BROWSE, instrument: 'bass', bassShelf: 'scale', bassKey: { pitch: 6 }, bassScale: 'melodic-minor' },
    onBrowse: () => {}, onLesson: () => {},
  }))
  assert.match(scaleMarkup, /data-fretted-shelf="scale"/)
  assert.match(scaleMarkup, /F# melodic minor/i)
  assert.match(scaleMarkup, /One-octave run/)
  assert.match(scaleMarkup, /Broken thirds/)
  assert.match(scaleMarkup, /Three-note sequences/)
  assert.equal((scaleMarkup.match(/<option value="\d+"/g) ?? []).length, 12, 'the fretted scale picker offers all twelve tonics')
  for (const family of SCALE_FAMILIES)
    assert.match(scaleMarkup, new RegExp(`<option value="${family.id}"`), `scale picker offers ${family.name}`)
  const bassMarkup = renderToStaticMarkup(createElement(CourseSection, {
    browse: { ...DEFAULT_BROWSE, instrument: 'bass', bassShelf: 'course' },
    onBrowse: () => {}, onLesson: () => {},
  }))
  assert.match(bassMarkup, /Bass course/)
  assert.match(bassMarkup, /Level 5 · Phrases and grooves <span class="dim num">5/)
  assert.match(bassMarkup, /bass-original-groove|Build a four-bar bass groove/)
  assert.doesNotMatch(bassMarkup, /Guitar course|Build an E-minor riff|open fifths and a pickup/)
  const panel = renderToStaticMarkup(createElement(FrettedLessonPanel, {
    lesson: guitarLessonById('guitar-open-strings'), onLesson: () => {},
  }))
  assert.match(panel, /E2 · A2 · D3 · G3 · B3 · E4/)
  assert.match(panel, /Tab positions are suggested/)
  assert.match(panel, /does not listen for played notes/)
  assert.match(panel, /No previous lesson/)
  assert.match(panel, /Next lesson: First notes on E and A/)
  const scalePanel = renderToStaticMarkup(createElement(FrettedLessonPanel, {
    lesson: frettedScaleLessons('guitar', 0, 'major')[1], onLesson: () => {},
  }))
  assert.match(scalePanel, /Previous lesson: C Major \(Ionian\): One-octave run/)
  assert.match(scalePanel, /Next lesson: C Major \(Ionian\): Three-note sequences/)
  const songPanel = renderToStaticMarkup(createElement(FrettedLessonPanel, {
    lesson: guitarSongStudy, onLesson: () => {},
  }))
  assert.match(songPanel, /Song reference: Purple Haze/)
  assert.match(songPanel, /Original riff study/)
  assert.match(songPanel, /Previous lesson: Syncopated double-stop answers/)
  assert.match(songPanel, /Next lesson: Little Wing: Low anchors with a high call-and-answer line/)
  const bassSongPanel = renderToStaticMarkup(createElement(FrettedLessonPanel, {
    lesson: bassSongStudy, onLesson: () => {},
  }))
  assert.match(bassSongPanel, /Song reference: The Trooper/)
  assert.match(bassSongPanel, /Original riff study/)
  assert.match(bassSongPanel, /No previous lesson/)
  assert.match(bassSongPanel, /Next lesson: Run to the Hills: Eighth-note plus two-sixteenth gallops with wide root jumps/)
  const trooper = bassLessonById('bass-inspired-harris-the-trooper')
  const runToTheHills = bassLessonById('bass-inspired-harris-run-to-the-hills')
  const bassBar = (lesson, bar) => lesson.notes.filter((note) => Math.floor(note.startBeat / 4) === bar)
    .map(({ startBeat, beats }) => [startBeat % 4, beats])
  assert.match(trooper.steps[0], /eighth note followed by two sixteenth notes: long-short-short/)
  assert.doesNotMatch(trooper.steps[0], /long-short-long/)
  assert.deepEqual(bassBar(trooper, 0).slice(0, 3), [[0, 0.5], [0.5, 0.25], [0.75, 0.25]],
    'The Trooper opening figure is an eighth followed by two sixteenths, not a triplet')
  assert.match(runToTheHills.steps[0], /one eighth note followed by two even sixteenth notes, not as a triplet/)
  assert.doesNotMatch(runToTheHills.title, /triplet/i)
  for (const lesson of [trooper, runToTheHills])
    assert.ok(lesson.notes.every((note) => note.beats !== 1 / 3 && note.beats !== 2 / 3),
      `${lesson.id}: gallop uses sixteenth values instead of triplet durations`)
  for (const bar of [0, 1, 2]) {
    assert.deepEqual(bassBar(runToTheHills, bar).slice(0, 9), [
      [0, 0.5], [0.5, 0.25], [0.75, 0.25], [1.5, 0.5], [2, 0.25], [2.25, 0.25],
      [3, 0.5], [3.5, 0.25], [3.75, 0.25],
    ], `Run to the Hills bar ${bar + 1} has three eighth-plus-two-sixteenth gallops`)
  }
  console.log(`Guitar and bass course checks passed (${GUITAR_LESSONS.length} guitar, ${BASS_LESSONS.length} bass lessons).`)
} finally {
  await vite.close()
}
