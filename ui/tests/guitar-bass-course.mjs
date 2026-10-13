// Run from ui\: node tests\guitar-bass-course.mjs
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

globalThis.matchMedia = () => ({ matches: false })
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const {
    BASS_LESSONS, FRETTED_CONFIG, FRETTED_GENRES, FRETTED_LEVELS, FRETTED_LESSONS, GUITAR_LESSONS,
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
  assert.equal(GUITAR_LESSONS.length, 85)
  assert.equal(BASS_LESSONS.length, 85)
  const notationDurations = [1 / 3, 1 / 2, 2 / 3, 1, 3 / 2, 2]
  for (const instrument of ['guitar', 'bass']) {
    const lessons = instrument === 'guitar' ? GUITAR_LESSONS : BASS_LESSONS
    const course = lessons.filter((lesson) => lesson.kind === 'course')
    const genres = lessons.filter((lesson) => lesson.kind === 'genre')
    const inspired = lessons.filter((lesson) => lesson.kind === 'inspired')
    assert.equal(course.length, 25, `${instrument}: five progressive lessons at each of five levels`)
    assert.deepEqual(Array.from({ length: 5 }, (_, index) => course.filter((lesson) => lesson.level === index + 1).length),
      [5, 5, 5, 5, 5], `${instrument}: each course level has five lessons`)
    assert.equal(genres.length, 55, `${instrument}: five studies for each of eleven genres`)
    assert.equal(inspired.length, 5, `${instrument}: five distinct original artist technique studies`)
    assert.equal(new Set(inspired.map((lesson) => lesson.artist)).size, 5, `${instrument}: artist shelf has five distinct players`)
    assert.deepEqual(frettedGenres(instrument), FRETTED_GENRES, `${instrument}: shared genre list`)
    for (const genre of FRETTED_GENRES) {
      const studies = genres.filter((lesson) => lesson.genre === genre)
      assert.equal(studies.length, 5, `${instrument}: ${genre} has five studies`)
      assert.deepEqual(studies.map((lesson) => lesson.level).toSorted(), [1, 2, 3, 4, 5], `${instrument}: ${genre} progresses across levels`)
      assert.equal(new Set(studies.map((lesson) => lesson.notes.map(({ midi, startBeat, beats }) => `${midi}:${startBeat}:${beats}`).join('|'))).size, 5,
        `${instrument}: ${genre} studies have distinct note material`)
      assert.equal(frettedLessonList(studies[0]).length, 5, `${instrument}: ${genre} lesson navigation stays in that genre`)
    }
    for (const lesson of lessons) {
      const where = lesson.id
      const song = frettedLessonSong(lesson)
      const config = FRETTED_CONFIG[instrument]
      const beats = songBeats(song)
      assert.ok(lesson.goal.length > 30 && lesson.steps.length >= 3, `${where}: goal and practical steps`)
      assert.ok(lesson.tempo.start < lesson.tempo.target && lesson.tempo.start / lesson.tempo.target >= 0.5, `${where}: playable starting speed`)
      assert.equal(lesson.bars, 4, `${where}: four complete bars`)
      assert.ok(lesson.notes.length >= 8, `${where}: enough material for a real exercise`)
      assert.equal(song.source, 'course')
      assert.equal(song.bars, lesson.bars)
      assert.equal(songBeats(song), lesson.bars * 4, `${where}: measure map covers the lesson`)
      assert.equal(song.bpm, lesson.tempo.target)
      assert.deepEqual(song.tracks.map((track) => [track.id, track.instrument, track.gmProgram]), [[instrument, 'other', instrument === 'guitar' ? 27 : 33]])
      assert.equal(song.tracks[0].group, undefined, `${where}: lesson instrument is not hidden as Creative backing`)
      assert.deepEqual(song.instrumentNotes[instrument], lesson.notes, `${where}: correct part notes reach the Song`)
      assert.ok(song.instrumentNotes[instrument].length > 0)
      assert.deepEqual(song.instrumentNotes[instrument].map((note) => note.trackId), Array(lesson.notes.length).fill(instrument))
      const filtered = frettedLessonList(lesson)
      assert.ok(filtered.every((item) => item.instrument === instrument && item.kind === lesson.kind &&
        (lesson.kind === 'course' || lesson.kind === 'genre' && item.genre === lesson.genre ||
          lesson.kind === 'inspired' && item.artist === lesson.artist)), `${where}: instrument, shelf and filter routing`)
      assert.equal(filtered.length, lesson.kind === 'course' ? 25 : lesson.kind === 'genre' ? 5 : 1, `${where}: the correct lesson list is shown`)
      assert.ok(filtered.includes(lesson), `${where}: Previous/Next list includes the lesson`)
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
  for (let bar = 0; bar < bluesShuffle.bars; bar++) {
    const onsets = bluesShuffle.notes.filter((note) => Math.floor(note.startBeat / 4) === bar)
      .map((note) => note.startBeat - bar * 4).sort((a, b) => a - b)
    const gaps = onsets.slice(1).map((beat, index) => Math.round((beat - onsets[index]) * 3))
    assert.deepEqual(gaps, Array.from({ length: onsets.length - 1 }, (_, index) => index % 2 ? 1 : 2),
      `guitar Blues bar ${bar + 1} alternates long-short triplet gaps`)
  }

  const popChordChange = guitarLessonById('guitar-pop-chord-change')
  const chordAt = (lesson, bar, offset) => lesson.notes.filter((note) => Math.abs(note.startBeat - (bar * 4 + offset)) < 1e-9)
    .map((note) => note.midi).sort((a, b) => a - b)
  const cMajor = [48, 52, 55, 60, 64]
  const gMajor = [43, 47, 50, 55, 59, 67]
  for (const bar of [0, 2]) assert.deepEqual(chordAt(popChordChange, bar, 0), cMajor, `Pop bar ${bar + 1} starts on C`)
  for (const bar of [1, 3]) assert.deepEqual(chordAt(popChordChange, bar, 0), gMajor, `Pop bar ${bar + 1} starts on G`)
  assert.deepEqual(chordAt(popChordChange, 0, 2.5), gMajor, 'the second Pop strum is on the & after beat 3')
  assert.deepEqual(chordAt(popChordChange, 1, 2.5), cMajor, 'the next bar reverses the chord order')
  assert.match(popChordChange.steps[0], /Bars 1 and 3 strum C on beat 1, then G on the “&” after beat 3; bars 2 and 4 reverse the chord order\./)
  assert.match(popChordChange.steps[1], /second strum lands on the “&” after beat 3/)
  assert.doesNotMatch(popChordChange.steps.join(' '), /after beat 2/)

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
  assert.match(guitarMarkup, /Rock: Set the pulse/)
  assert.match(guitarMarkup, /Rock: Play root-fifth shapes/)
  assert.doesNotMatch(guitarMarkup, /Blues: a two-note shuffle|Pop: C to G chord changes/)
  const inspiredMarkup = renderToStaticMarkup(createElement(CourseSection, {
    browse: { ...DEFAULT_BROWSE, instrument: 'guitar', guitarShelf: 'inspired', guitarArtist: 'Nile Rodgers' },
    onBrowse: () => {}, onLesson: () => {},
  }))
  assert.match(inspiredMarkup, /data-fretted-shelf="inspired"/)
  assert.match(inspiredMarkup, /data-genre="Nile Rodgers"/)
  assert.match(inspiredMarkup, /Inspired by Nile Rodgers/)
  assert.match(inspiredMarkup, /Clipped offbeat chord cuts/)
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
  console.log(`Guitar and bass course checks passed (${GUITAR_LESSONS.length} guitar, ${BASS_LESSONS.length} bass lessons).`)
} finally {
  await vite.close()
}
