// Run from ui\: node tests\piano-course.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'

globalThis.matchMedia = () => ({ matches: false })
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { PIANO_LESSONS, PIANO_STAGES, pianoGenres, pianoLessonById, pianoLessonSong } = await vite.ssrLoadModule('/src/course/piano.ts')
  const { parseChord } = await vite.ssrLoadModule('/src/course/accompaniment.ts')
  const { LESSONS, genres, lessonMeter } = await vite.ssrLoadModule('/src/course/curriculum.ts')
  const { freshPosition, lessonPosition } = await vite.ssrLoadModule('/src/course/state.ts')
  const { pianoXml } = await vite.ssrLoadModule('/src/workspace/musicxml.ts')
  const { songBeats } = await vite.ssrLoadModule('/src/workspace/meter.ts')

  const pc = (midi) => ((midi % 12) + 12) % 12
  const onGrid = (beat) => Math.abs(beat * 4 - Math.round(beat * 4)) < 1e-9
  const groups = pianoGenres()
  assert.equal(PIANO_LESSONS.length, 55, 'fifty-five piano lessons')
  assert.equal(LESSONS.length + PIANO_LESSONS.length, 155, 'one hundred and fifty-five lessons in all')
  assert.deepEqual(groups.map(({ style }) => style), genres().map(({ style }) => style), 'the same eleven genres, in the same order, as the drums')
  assert.equal(new Set(PIANO_LESSONS.map((lesson) => lesson.id)).size, 55, 'unique ids')
  assert.ok(PIANO_LESSONS.every((lesson) => /^piano-/.test(lesson.id) && !LESSONS.some((drum) => drum.id === lesson.id)), 'piano ids are their own')
  assert.equal(new Set(PIANO_LESSONS.map((lesson) => lesson.title)).size, 55, 'unique titles')
  assert.equal(new Set(PIANO_LESSONS.map((lesson) => JSON.stringify(lesson.notes.map((n) => [n.hand, n.midi, n.startBeat, n.beats, n.finger])))).size, 55, 'every lesson plays a different part')
  assert.deepEqual(PIANO_STAGES, ['Right-hand rhythm', 'Second right-hand rhythm', 'Left-hand pattern', 'Fill', 'Four-bar phrase'])
  const pedalled = new Set()
  for (const { style, lessons } of groups) {
    assert.equal(lessons.length, 5, `${style}: five piano lessons`)
    assert.deepEqual(lessons.map((lesson) => lesson.level), [1, 2, 3, 4, 5], `${style}: steps in order`)
    assert.deepEqual(lessons.map((lesson) => lesson.bars), [2, 2, 2, 2, 4], `${style}: two-bar lessons, then a four-bar phrase`)
    assert.deepEqual(lessons.map((lesson) => lesson.sections?.map((s) => `${s.name}:${s.bars}`).join() ?? ''), ['', '', '', 'Groove:1,Fill:1', 'Groove:3,Fill:1'])
    const part = (lesson, hand) => JSON.stringify(lesson.notes.filter((n) => n.hand === hand && n.startBeat < lessonMeter(lesson).beatsPerBar).map((n) => [n.startBeat, n.beats]))
    assert.notEqual(part(lessons[1], 'right'), part(lessons[0], 'right'), `${style}: step 2 changes the right-hand rhythm`)
    assert.equal(part(lessons[1], 'left'), part(lessons[0], 'left'), `${style}: step 2 keeps the left hand`)
    assert.notEqual(part(lessons[2], 'left'), part(lessons[0], 'left'), `${style}: step 3 changes the left hand`)
    assert.ok(lessons.every((lesson) => lesson.meter.numerator === lessons[0].meter.numerator && lesson.tempo.target === lessons[0].tempo.target), `${style}: one meter and tempo`)
  }
  for (const lesson of PIANO_LESSONS) {
    const where = lesson.id
    const { beatsPerBar } = lessonMeter(lesson)
    assert.ok(lesson.goal.length > 30 && lesson.steps.length >= 3 && lesson.hands.includes('Right hand') && lesson.hands.includes('Left hand'), `${where} explains the hands`)
    assert.ok(lesson.tempo.start < lesson.tempo.target, `${where} starts slower`)
    assert.equal(lesson.chords.length, lesson.bars, `${where}: one chord per bar`)
    const fillBar = lesson.sections ? lesson.bars - 1 : -1
    // Every note: in its bar, on the sixteenth grid, written for one hand with one finger, each hand in its own register.
    for (const note of lesson.notes) {
      assert.ok(note.trackId === 'piano' && Number.isInteger(note.midi) && note.beats > 0 && onGrid(note.startBeat) && onGrid(note.beats), `${where} note on the grid`)
      const bar = Math.floor(note.startBeat / beatsPerBar)
      assert.ok(note.startBeat + note.beats <= (bar + 1) * beatsPerBar + 1e-9, `${where} note stays in its bar`)
      assert.ok([1, 2, 3, 4, 5].includes(note.finger), `${where} note has a written finger`)
      assert.ok(note.hand === 'right' ? note.midi >= 60 && note.midi <= 84 : note.midi >= 36 && note.midi <= 59, `${where} ${note.hand} hand in its register (${note.midi})`)
      const { root, intervals } = parseChord(lesson.chords[bar])
      const chordTones = intervals.map((i) => pc(root + i))
      const inFill = bar === fillBar && note.startBeat >= bar * beatsPerBar + beatsPerBar / 2 - 1e-9
      if (note.hand === 'left') assert.ok([...chordTones, pc(root + 9)].includes(pc(note.midi)), `${where} left-hand ${note.midi} belongs to ${lesson.chords[bar]}`)
      else if (!inFill) assert.ok(chordTones.includes(pc(note.midi)), `${where} right-hand ${note.midi} belongs to ${lesson.chords[bar]}`)
    }
    // Fingering: notes struck together take different fingers in pitch order (thumb lowest in the right hand, highest in
    // the left), inside an octave; a held note is never struck again in the same hand.
    for (const hand of ['right', 'left']) {
      const notes = lesson.notes.filter((n) => n.hand === hand)
      const onsets = Map.groupBy(notes, (n) => n.startBeat)
      for (const [beat, together] of onsets) {
        const sorted = [...together].sort((a, b) => a.midi - b.midi)
        const fingers = sorted.map((n) => n.finger)
        assert.equal(new Set(fingers).size, fingers.length, `${where} ${hand} at ${beat}: one finger per key`)
        assert.ok(fingers.every((f, i) => i === 0 || (hand === 'right' ? f > fingers[i - 1] : f < fingers[i - 1])), `${where} ${hand} at ${beat}: fingers follow the pitches (${fingers})`)
        assert.ok(sorted.at(-1).midi - sorted[0].midi <= 12, `${where} ${hand} at ${beat}: within an octave`)
        assert.equal(new Set(sorted.map((n) => n.midi)).size, sorted.length, `${where} ${hand} at ${beat}: no doubled key`)
      }
      for (const [midi, same] of Map.groupBy(notes, (n) => n.midi))
        same.forEach((n, i) => assert.ok(i === 0 || same[i - 1].startBeat + same[i - 1].beats <= n.startBeat + 1e-9, `${where} ${hand} ${midi} is released before it is struck again`))
    }
    // The fill: five notes stepping down the scale, fingers 5 4 3 2 1, over a held left-hand root.
    if (fillBar >= 0) {
      const half = fillBar * beatsPerBar + beatsPerBar / 2
      const run = lesson.notes.filter((n) => n.hand === 'right' && n.startBeat >= half - 1e-9)
      assert.deepEqual(run.map((n) => n.finger), [5, 4, 3, 2, 1], `${where} fill fingering`)
      assert.ok(run.every((n, i) => i === 0 || (run[i - 1].midi - n.midi >= 1 && run[i - 1].midi - n.midi <= 2)), `${where} fill steps down the scale`)
      const held = lesson.notes.filter((n) => n.hand === 'left' && n.startBeat >= half - 1e-9)
      assert.ok(held.length === 1 && Math.abs(held[0].startBeat + held[0].beats - (fillBar + 1) * beatsPerBar) < 1e-9 && held[0].finger === 5, `${where} left hand holds the root under the fill`)
    }
    if (lesson.pedals) {
      pedalled.add(lesson.style)
      assert.equal(lesson.pedals.length, lesson.bars, `${where}: one pedal per bar`)
      lesson.pedals.forEach((pedal, bar) => assert.ok(pedal.controller === 64 && pedal.startBeat > bar * beatsPerBar && pedal.startBeat + pedal.beats < (bar + 1) * beatsPerBar,
        `${where}: the pedal goes down after the chord and lifts before the next bar`))
      assert.match(lesson.hands, /sustain pedal/)
      assert.ok(lesson.steps.some((step) => /sustain pedal/.test(step)), `${where} says how to pedal`)
    } else assert.doesNotMatch(lesson.hands, /pedal/, `${where} mentions no pedal it does not write`)

    const song = pianoLessonSong(lesson)
    assert.deepEqual(song.tracks.map((track) => `${track.id}:${track.instrument}`), ['piano:piano', 'drums:drums', 'bass:other'], `${where}: piano first, then the drum and bass backing`)
    assert.ok(!song.tracks.some((track) => track.group === 'creative') && song.chords.length === 0 && !song.instrumentNotes.harmony, `${where}: no chord part doubles the piano`)
    assert.equal(song.piano, lesson.notes)
    assert.ok(song.drums.length > 0 && song.drums.every((hit) => hit.startBeat >= 0 && hit.startBeat < songBeats(song)), `${where}: drums fill the lesson`)
    assert.ok(song.instrumentNotes.bass.length >= lesson.bars && song.instrumentNotes.bass.every((n) => n.startBeat + n.beats <= songBeats(song) + 1e-9), `${where}: bass in time`)
    assert.deepEqual(song.chordLabels.map((label) => label.symbol), lesson.chords)
    assert.equal(song.pedals, lesson.pedals)
    assert.equal(song.bpm, lesson.tempo.target * lessonMeter(lesson).pulse)
    const xml = pianoXml(song)
    assert.equal((xml.match(/<measure /g) ?? []).length, lesson.bars, `${where} engraves every bar`)
    assert.equal((xml.match(/<fingering>/g) ?? []).length, lesson.notes.length, `${where}: every note shows its finger once`)
    assert.equal((xml.match(/<harmony /g) ?? []).length, lesson.bars, `${where}: chord names over the score`)
    assert.doesNotMatch(xml, /NaN|undefined/)
    assert.equal(freshPosition(lesson).trackId, 'piano')
    assert.deepEqual(freshPosition(lesson).loop, { startBar: 1, endBar: lesson.bars })
  }
  assert.deepEqual([...pedalled].sort(), ['Latin: bossa nova', 'Pop', 'R&B and soul'], 'pedalling is written where the style needs it')
  assert.equal(pianoLessonById('piano-rock-rhythm').title, 'Rock piano: eighth-note chords')
  // Flat keys are spelled in flats (Eb major, F minor), sharp keys in sharps.
  for (const id of ['piano-soul-phrase', 'piano-drum-and-bass-phrase']) assert.doesNotMatch(pianoXml(pianoLessonSong(pianoLessonById(id))), /<alter>1<\/alter>/, `${id} is spelled in flats`)
  assert.doesNotMatch(pianoXml(pianoLessonSong(pianoLessonById('piano-rock-phrase'))), /<alter>-1<\/alter>/, 'A major is spelled in sharps')
  // A lesson position for piano is kept under the course's own key and reopens on the piano.
  {
    const store = new Map()
    globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) }
    const lesson = pianoLessonById('piano-jazz-phrase')
    assert.deepEqual(lessonPosition(lesson), freshPosition(lesson))
    delete globalThis.localStorage
  }
  console.log(`Piano course checks passed: ${PIANO_LESSONS.length} lessons in ${groups.length} genres (${LESSONS.length + PIANO_LESSONS.length} with the drums); steps, registers, ` +
    'chord tones, written fingering, fills, pedalling, drum and bass backing, chord names and fingering in the score.')
} finally {
  await vite.close()
}
