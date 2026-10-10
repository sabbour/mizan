// Run from ui\: node tests\piano-course.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'

globalThis.matchMedia = () => ({ matches: false })
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { PIANO_LESSONS, PIANO_STAGES, pianoGenres, pianoLessonById, pianoLessonList, pianoLessonSong } = await vite.ssrLoadModule('/src/course/piano.ts')
  const { PIANO_INSPIRED } = await vite.ssrLoadModule('/src/course/pianoInspired.ts')
  const { KEYS, SCALE_FAMILIES, progressionLessons, scaleLessons, scaleTonic, scaleFingering } = await vite.ssrLoadModule('/src/course/pianoTonal.ts')
  const { canFollow } = await vite.ssrLoadModule('/src/course/pianoParts.ts')
  const { parseChord, progression, chordSpans, GENRE_STYLE } = await vite.ssrLoadModule('/src/course/accompaniment.ts')
  const { LESSONS, genres, lessonMeter } = await vite.ssrLoadModule('/src/course/curriculum.ts')
  const { freshPosition, lessonPosition } = await vite.ssrLoadModule('/src/course/state.ts')
  const { browseTo, DEFAULT_BROWSE } = await vite.ssrLoadModule('/src/course/browse.ts')
  const { pianoXml } = await vite.ssrLoadModule('/src/workspace/musicxml.ts')
  const { songBeats } = await vite.ssrLoadModule('/src/workspace/meter.ts')

  const pc = (midi) => ((midi % 12) + 12) % 12
  const onGrid = (beat) => Math.abs(beat * 4 - Math.round(beat * 4)) < 1e-9
  const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  const spelledPc = (name) => pc(LETTER[name[0]] + [...name.slice(1)].reduce((sum, mark) => sum + (mark === '#' ? 1 : -1), 0))
  const BLACK = [1, 3, 6, 8, 10]

  /** Rules every written part keeps, whatever the shelf. */
  function playable(lesson) {
    const where = lesson.id
    for (const note of lesson.notes) {
      assert.ok(note.trackId === 'piano' && Number.isInteger(note.midi) && note.beats > 0 && onGrid(note.startBeat) && onGrid(note.beats), `${where} note on the grid`)
      assert.ok([1, 2, 3, 4, 5].includes(note.finger), `${where} note has a written finger`)
    }
    for (const hand of ['right', 'left']) {
      const notes = lesson.notes.filter((n) => n.hand === hand).sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi)
      const onsets = [...Map.groupBy(notes, (n) => n.startBeat).values()]
      for (const together of onsets) {
        const fingers = together.map((n) => n.finger)
        assert.equal(new Set(fingers).size, fingers.length, `${where} ${hand} at ${together[0].startBeat}: one finger per key`)
        assert.ok(fingers.every((f, i) => i === 0 || (hand === 'right' ? f > fingers[i - 1] : f < fingers[i - 1])), `${where} ${hand} at ${together[0].startBeat}: fingers follow the pitches (${fingers})`)
        assert.ok(together.at(-1).midi - together[0].midi <= 12, `${where} ${hand} at ${together[0].startBeat}: within an octave`)
        assert.equal(new Set(together.map((n) => n.midi)).size, together.length, `${where} ${hand}: no doubled key`)
      }
      // A line of single notes: each finger can follow the one before (steps in the hand's direction, thumb crossings, shifts on leaps or rests).
      onsets.forEach((together, index) => {
        const before = onsets[index - 1]
        if (!before || before.length > 1 || together.length > 1) return
        const [a] = before, [b] = together
        assert.ok(canFollow(hand, { midi: a.midi, finger: a.finger, start: a.startBeat, end: a.startBeat + a.beats }, { midi: b.midi, finger: b.finger, start: b.startBeat }),
          `${where} ${hand} ${a.midi}/${a.finger} at ${a.startBeat} then ${b.midi}/${b.finger}: the finger can follow`)
      })
      for (const [midi, same] of Map.groupBy(notes, (n) => n.midi))
        same.forEach((n, i) => assert.ok(i === 0 || same[i - 1].startBeat + same[i - 1].beats <= n.startBeat + 1e-9, `${where} ${hand} ${midi} is released before it is struck again`))
    }
  }

  /** Bar-by-bar content, so loops can be checked for real variation rather than one or two bars tiled. */
  const barShapes = (lesson, beatsPerBar) => Array.from({ length: lesson.bars }, (_, bar) => JSON.stringify(lesson.notes
    .filter((n) => Math.floor(n.startBeat / beatsPerBar + 1e-9) === bar).map((n) => [n.hand, n.midi, +(n.startBeat - bar * beatsPerBar).toFixed(3), n.beats, n.finger])))
  const rhythms = (lesson, beatsPerBar) => Array.from({ length: lesson.bars }, (_, bar) => JSON.stringify(lesson.notes
    .filter((n) => Math.floor(n.startBeat / beatsPerBar + 1e-9) === bar).map((n) => [n.hand, +(n.startBeat - bar * beatsPerBar).toFixed(3), n.beats])))

  // ---- Genre lessons: ten per style, eight bars then sixteen ----
  const groups = pianoGenres()
  assert.equal(PIANO_LESSONS.length, 110, 'one hundred and ten genre lessons')
  assert.deepEqual(groups.map(({ style }) => style), genres().map(({ style }) => style), 'the same eleven genres, in the same order, as the drums')
  assert.equal(new Set(PIANO_LESSONS.map((lesson) => lesson.id)).size, 110, 'unique ids')
  assert.ok(PIANO_LESSONS.every((lesson) => /^piano-/.test(lesson.id) && !LESSONS.some((drum) => drum.id === lesson.id)), 'piano ids are their own')
  assert.equal(new Set(PIANO_LESSONS.map((lesson) => lesson.title)).size, 110, 'unique titles')
  assert.equal(new Set(PIANO_LESSONS.map((lesson) => JSON.stringify(lesson.notes.map((n) => [n.hand, n.midi, n.startBeat, n.beats, n.finger])))).size, 110, 'every lesson plays a different part')
  assert.deepEqual(PIANO_STAGES, ['Right-hand rhythm', 'Second right-hand rhythm', 'Left-hand pattern', 'Fill', 'Four-bar phrase',
    'Richer voicings', 'Syncopation', 'Broken chords', 'Moving bass', 'Sixteen-bar arrangement'])
  // The first five lessons of each style keep their ids and titles.
  const ORIGINAL = ['rhythm', 'second-rhythm', 'left-hand', 'fill', 'phrase']
  assert.equal(pianoLessonById('piano-rock-rhythm').title, 'Rock piano: eighth-note chords')
  assert.equal(pianoLessonById('piano-soul-second-rhythm').title, 'R&B and soul piano: repeated eighth-note chords')
  const pedalled = new Set()
  for (const { style, lessons } of groups) {
    assert.equal(lessons.length, 10, `${style}: ten piano lessons`)
    assert.deepEqual(lessons.map((lesson) => lesson.level), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], `${style}: steps in order`)
    assert.deepEqual(lessons.map((lesson) => lesson.bars), [8, 8, 8, 8, 8, 16, 16, 16, 16, 16], `${style}: eight-bar foundations, then sixteen-bar pieces`)
    const prefix = lessons[0].id.replace(/-rhythm$/, '')
    assert.deepEqual(lessons.slice(0, 5).map((lesson) => lesson.id), ORIGINAL.map((suffix) => `${prefix}-${suffix}`), `${style}: the original ids`)
    const { beatsPerBar } = lessonMeter(lessons[0])
    const part = (lesson, hand, bar = 0) => JSON.stringify(lesson.notes.filter((n) => n.hand === hand && Math.floor(n.startBeat / beatsPerBar) === bar).map((n) => [n.startBeat % beatsPerBar, n.beats]))
    assert.notEqual(part(lessons[1], 'right'), part(lessons[0], 'right'), `${style}: step 2 changes the right-hand rhythm`)
    assert.equal(part(lessons[1], 'left'), part(lessons[0], 'left'), `${style}: step 2 keeps the left hand`)
    assert.notEqual(part(lessons[2], 'left'), part(lessons[0], 'left'), `${style}: step 3 changes the left hand`)
    assert.ok(lessons.every((lesson) => lesson.meter.numerator === lessons[0].meter.numerator && lesson.tempo.target === lessons[0].tempo.target), `${style}: one meter and tempo`)
    assert.ok(lessons.slice(5).every((lesson) => lesson.notes.some((n) => n.hand === 'right' && lesson.notes.filter((m) => m.hand === 'right' && m.startBeat === n.startBeat).length === 4)),
      `${style}: the sixteen-bar pieces use four-note voicings`)
    assert.ok(lessons[7].notes.filter((n) => n.hand === 'right').some((n, i, all) => all.filter((m) => m.startBeat === n.startBeat).length === 1), `${style}: broken chords are single notes`)
  }
  for (const lesson of PIANO_LESSONS) {
    const where = lesson.id
    const { beatsPerBar } = lessonMeter(lesson)
    const style = GENRE_STYLE[lesson.style]
    assert.ok(lesson.goal.length > 30 && lesson.steps.length >= 3 && lesson.hands.includes('Right hand') && lesson.hands.includes('Left hand'), `${where} explains the hands`)
    assert.ok(lesson.tempo.start < lesson.tempo.target, `${where} starts slower`)
    assert.deepEqual(lesson.chords, progression(style, lesson.bars), `${where}: the style's ${lesson.bars}-bar progression`)
    assert.equal(lesson.sections.reduce((sum, s) => sum + s.bars, 0), lesson.bars, `${where}: sections cover the bars`)
    const spans = chordSpans(lesson.chords, beatsPerBar)
    const chordAt = (beat) => spans.findLast((span) => span.start <= beat + 1e-9)
    const fills = lesson.fills ?? []
    const inFill = (note) => fills.includes(Math.floor(note.startBeat / beatsPerBar)) && note.startBeat % beatsPerBar >= beatsPerBar / 2 - 1e-9
    const leftLine = lesson.notes.filter((n) => n.hand === 'left').sort((a, b) => a.startBeat - b.startBeat)
    for (const note of lesson.notes) {
      const bar = Math.floor(note.startBeat / beatsPerBar)
      const span = chordAt(note.startBeat)
      assert.ok(note.startBeat + note.beats <= span.end + 1e-9, `${where} note at ${note.startBeat} stays in its chord and bar`)
      assert.ok(note.hand === 'right' ? note.midi >= 60 && note.midi <= 84 : note.midi >= 36 && note.midi <= 59, `${where} ${note.hand} hand in its register (${note.midi})`)
      const { root, intervals } = parseChord(span.symbol)
      const tones = intervals.map((i) => pc(root + i))
      if (note.hand === 'left') {
        // Chord tones, the sixth of a boogie, or a half-step approach into the next note.
        const next = leftLine.find((n) => n.startBeat > note.startBeat + 1e-9) ?? leftLine[0]
        assert.ok([...tones, pc(root + 9)].includes(pc(note.midi)) || (next && Math.abs(next.midi - note.midi) <= 2), `${where} left-hand ${note.midi} at ${note.startBeat} belongs to ${span.symbol}`)
      } else if (!inFill(note)) assert.ok(tones.includes(pc(note.midi)), `${where} right-hand ${note.midi} at ${note.startBeat} belongs to ${span.symbol}`)
      void bar
    }
    // Every chord of a split bar is played by both hands.
    for (const span of spans) for (const hand of ['right', 'left'])
      assert.ok(lesson.notes.some((n) => n.hand === hand && n.startBeat >= span.start - 1e-9 && n.startBeat < span.end - 1e-9), `${where} ${hand} hand plays ${span.symbol} at ${span.start}`)
    playable(lesson)
    // Real phrases: the bars vary, and the loop is not one or two bars (or a half) tiled.
    const shapes = barShapes(lesson, beatsPerBar)
    assert.ok(new Set(shapes).size >= (lesson.bars === 8 ? 6 : 11), `${where}: ${new Set(shapes).size} different bars of ${lesson.bars}`)
    assert.ok(new Set(rhythms(lesson, beatsPerBar)).size >= 2, `${where}: more than one rhythm`)
    for (const period of [1, 2, 4, 8].filter((p) => p < lesson.bars))
      assert.ok(shapes.some((shape, bar) => shape !== shapes[bar % period]), `${where} is not a ${period}-bar pattern repeated`)
    // The last bar leads back to the top: a held chord, a fill or a turnaround, never just the first bar again.
    assert.notEqual(shapes.at(-1), shapes[0], `${where}: the last bar turns the loop round`)
    // Fills: a run of five notes down the scale (5 4 3 2 1) or chord tones climbing, over a held left-hand root.
    for (const bar of fills) {
      const half = bar * beatsPerBar + beatsPerBar / 2
      const run = lesson.notes.filter((n) => n.hand === 'right' && n.startBeat >= half - 1e-9 && n.startBeat < (bar + 1) * beatsPerBar)
      const span = chordAt(half)
      if (run.length === 5) {
        // A run of five scale steps: down with fingers 5 to 1, or (in some styles) up with 1 to 5.
        const up = run[1].midi > run[0].midi
        assert.deepEqual(run.map((n) => n.finger), up ? [1, 2, 3, 4, 5] : [5, 4, 3, 2, 1], `${where} fill fingering`)
        assert.ok(run.every((n, i) => i === 0 || (Math.abs(run[i - 1].midi - n.midi) >= 1 && Math.abs(run[i - 1].midi - n.midi) <= 2 && (n.midi > run[i - 1].midi) === up)),
          `${where} fill steps along the scale`)
      } else {
        const { root, intervals } = parseChord(span.symbol)
        assert.ok(run.length >= 3 && run.every((n, i) => (i === 0 || n.midi > run[i - 1].midi) && intervals.map((x) => pc(root + x)).includes(pc(n.midi))), `${where} bar ${bar + 1}: chord tones climb`)
      }
      const held = lesson.notes.filter((n) => n.hand === 'left' && n.startBeat >= half - 1e-9 && n.startBeat < (bar + 1) * beatsPerBar)
      assert.ok(held.length === 1 && Math.abs(held[0].startBeat + held[0].beats - (bar + 1) * beatsPerBar) < 1e-9 && pc(held[0].midi) === parseChord(span.symbol).root,
        `${where} left hand holds the root under the fill`)
    }
    if (lesson.pedals) {
      pedalled.add(lesson.style)
      // One pedal per chord, lifted before the next chord and before a fill (a chord that starts with the fill has none).
      const fillStart = (span) => fills.includes(span.bar) ? span.bar * beatsPerBar + beatsPerBar / 2 : Infinity
      const pedalledSpans = spans.filter((span) => span.start < fillStart(span) - 1e-9)
      assert.equal(lesson.pedals.length, pedalledSpans.length, `${where}: one pedal per chord`)
      lesson.pedals.forEach((pedal, i) => assert.ok(pedal.controller === 64 && pedal.startBeat > pedalledSpans[i].start &&
        pedal.startBeat + pedal.beats < Math.min(pedalledSpans[i].end, fillStart(pedalledSpans[i])),
        `${where}: the pedal goes down after the chord and lifts before the next`))
      assert.match(lesson.hands, /sustain pedal/)
      assert.ok(lesson.steps.some((step) => /sustain pedal/.test(step)), `${where} says how to pedal`)
    } else assert.doesNotMatch(lesson.hands, /pedal/, `${where} mentions no pedal it does not write`)

    const song = pianoLessonSong(lesson)
    assert.deepEqual(song.tracks.map((track) => `${track.id}:${track.instrument}`), ['piano:piano', 'drums:drums', 'bass:other'], `${where}: piano first, then the drum and bass backing`)
    assert.ok(!song.tracks.some((track) => track.group === 'creative') && song.chords.length === 0 && !song.instrumentNotes.harmony, `${where}: no chord part doubles the piano`)
    assert.equal(song.piano, lesson.notes)
    assert.equal(song.bars, lesson.bars)
    assert.equal(songBeats(song), lesson.bars * beatsPerBar, `${where}: the loop clock ends with the last bar`)
    assert.ok(song.drums.length > 0 && song.drums.every((hit) => hit.startBeat >= 0 && hit.startBeat < songBeats(song)), `${where}: drums fill the lesson`)
    assert.ok(song.drums.some((hit) => hit.startBeat >= (lesson.bars - 1) * beatsPerBar), `${where}: drums play the last bar`)
    const bass = song.instrumentNotes.bass
    assert.ok(bass.length >= lesson.bars && bass.every((n) => n.startBeat + n.beats <= songBeats(song) + 1e-9), `${where}: bass in time`)
    for (const n of bass) {
      const span = chordAt(n.startBeat)
      const { root, intervals } = parseChord(span.symbol)
      const next = spans[(spans.indexOf(span) + 1) % spans.length]
      assert.ok(n.startBeat + n.beats <= span.end + 1e-9 && ([...intervals, 9].map((x) => pc(root + x)).includes(pc(n.midi)) || pc(n.midi) === pc(parseChord(next.symbol).root - 1)),
        `${where}: bass ${n.midi} at ${n.startBeat} agrees with ${span.symbol}`)
    }
    assert.ok(bass.some((n) => n.startBeat >= (lesson.bars - 1) * beatsPerBar), `${where}: the bass plays the last bar`)
    for (const bar of fills) assert.ok(!bass.some((n) => n.startBeat >= bar * beatsPerBar + beatsPerBar / 2 - 1e-9 && n.startBeat < (bar + 1) * beatsPerBar), `${where}: the bass rests for the fill`)
    assert.deepEqual(song.chordLabels.map((label) => label.symbol), spans.map((span) => span.symbol))
    assert.equal(song.pedals, lesson.pedals)
    assert.equal(song.bpm, lesson.tempo.target * lessonMeter(lesson).pulse)
    const xml = pianoXml(song)
    assert.equal((xml.match(/<measure /g) ?? []).length, lesson.bars, `${where} engraves every bar`)
    assert.equal((xml.match(/<fingering>/g) ?? []).length, lesson.notes.length, `${where}: every note shows its finger once`)
    assert.equal((xml.match(/<harmony /g) ?? []).length, spans.length, `${where}: every chord name over the score`)
    assert.doesNotMatch(xml, /NaN|undefined/)
    assert.equal(freshPosition(lesson).trackId, 'piano')
    assert.deepEqual(freshPosition(lesson).loop, { startBar: 1, endBar: lesson.bars })
  }
  assert.deepEqual([...pedalled].sort(), ['Latin: bossa nova', 'Pop', 'R&B and soul'], 'pedalling is written where the style needs it')
  // Across styles, no motif is reused: compared with key, chords, tempo, fingers and velocity taken out (rhythms in beats,
  // pitches as intervals), no right-hand bar rhythm belongs to two styles, no two styles' left-hand parts share a rhythm,
  // and no two lessons open with the same four bars of two-hand rhythm and voicing size.
  {
    const bars = (lesson, read) => {
      const { beatsPerBar } = lessonMeter(lesson)
      return Array.from({ length: lesson.bars }, (_, bar) => read(lesson.notes.filter((n) => Math.floor(n.startBeat / beatsPerBar + 1e-9) === bar), bar * beatsPerBar))
    }
    const at = (n, start) => +(n.startBeat - start).toFixed(3)
    const rightRhythm = (notes, start) => JSON.stringify([...new Set(notes.filter((n) => n.hand === 'right').map((n) => `${at(n, start)}/${n.beats}`))])
    const leftRhythm = (notes, start) => JSON.stringify(notes.filter((n) => n.hand === 'left').map((n) => `${at(n, start)}/${n.beats}`))
    const twoHands = (notes, start) => JSON.stringify([...Map.groupBy(notes, (n) => `${n.hand}@${at(n, start)}/${n.beats}`)].map(([key, group]) => `${key}x${group.length}`).sort())
    const owners = new Map()
    for (const lesson of PIANO_LESSONS) for (const rhythm of new Set(bars(lesson, rightRhythm))) owners.set(rhythm, new Set([...owners.get(rhythm) ?? [], lesson.style]))
    const shared = [...owners].filter(([, styles]) => styles.size > 1)
    assert.equal(shared.length, 0, `right-hand bar rhythms shared across styles: ${shared.map(([r, s]) => `${r} in ${[...s]}`).slice(0, 3)}`)
    for (const [i, a] of PIANO_LESSONS.entries()) for (const b of PIANO_LESSONS.slice(i + 1)) {
      if (a.style === b.style) continue
      assert.notEqual(JSON.stringify(bars(a, leftRhythm)), JSON.stringify(bars(b, leftRhythm)), `${a.id} and ${b.id} share a left-hand part`)
      assert.notEqual(JSON.stringify(bars(a, twoHands).slice(0, 4)), JSON.stringify(bars(b, twoHands).slice(0, 4)), `${a.id} and ${b.id} open with the same four bars`)
    }
  }
  // Flat keys are spelled in flats (Eb major, F minor), sharp keys in sharps.
  for (const id of ['piano-soul-phrase', 'piano-drum-and-bass-phrase']) assert.doesNotMatch(pianoXml(pianoLessonSong(pianoLessonById(id))), /<alter>1<\/alter>/, `${id} is spelled in flats`)
  assert.doesNotMatch(pianoXml(pianoLessonSong(pianoLessonById('piano-rock-phrase'))), /<alter>-1<\/alter>/, 'A major is spelled in sharps')
  assert.deepEqual(pianoLessonList(PIANO_LESSONS[3]), PIANO_LESSONS, 'Previous and Next move through the genre lessons')

  // ---- Progressions in every key ----
  assert.equal(KEYS.length, 24, 'twelve major and twelve minor keys')
  let tonalCount = 0
  const families = new Set()
  for (const { tonic, pitch, mode } of KEYS) {
    const progressions = progressionLessons(pitch, mode)
    tonalCount += progressions.length
    assert.equal(progressions.length, mode === 'major' ? 10 : 8, `${tonic} ${mode}: ten major or eight minor progressions`)
    for (const lesson of progressions) {
      const where = lesson.id
      families.add(lesson.id.replace(/-[a-g](-sharp|-flat)?-(major|minor)$/, '') + ':' + mode)
      assert.equal(pianoLessonById(lesson.id), lesson, `${where} opens by id`)
      assert.deepEqual(pianoLessonList(lesson), progressions, `${where}: Previous and Next stay in the key`)
      const back = browseTo(lesson.id, DEFAULT_BROWSE)
      assert.ok(back.instrument === 'piano' && back.pianoShelf === 'progression' && back.pianoKey.pitch === pitch && back.pianoKey.mode === mode, `${where}: Back returns to its key`)
      assert.deepEqual(lesson.key, { tonic, mode })
      playable(lesson)
      assert.ok(lesson.notes.every((n) => n.spell && spelledPc(n.spell) === pc(n.midi)), `${where}: notes spelled to their pitches`)
      const song = pianoLessonSong(lesson)
      const xml = pianoXml(song)
      assert.doesNotMatch(xml, /NaN|undefined/)
      assert.equal((xml.match(/<measure /g) ?? []).length, lesson.bars)
      assert.deepEqual(song.tracks.map((t) => t.id), ['piano', 'drums', 'bass'], `${where}: with drums and bass`)
      assert.ok(lesson.tempo.start >= 76 && lesson.tempo.target >= 112, `${where}: a lively tempo`)
      assert.equal(lesson.numerals.length, lesson.bars)
      assert.deepEqual(lesson.sections.map((s) => s.name), lesson.numerals, `${where}: the numerals over each bar`)
      const blues = lesson.id.includes('twelve-bar-blues')
      assert.equal(lesson.bars, blues ? 24 : 16, `${where}: sixteen bars (the blues two twelve-bar choruses)`)
      const eight = lesson.id.includes('-canon-')
      if (!blues && !eight) assert.ok(lesson.chords.slice(8, 12).every((bar) => bar.split(' ').length === 2), `${where}: bars 9–12 move two chords a bar`)
      // Phrases vary the playing, not only the chords: the right-hand rhythm of each four-bar phrase is not all the same.
      const rhythmOf = (bar) => JSON.stringify(lesson.notes.filter((n) => n.hand === 'right' && Math.floor(n.startBeat / 4) === bar).map((n) => [n.startBeat % 4, n.beats]))
      assert.ok(new Set(Array.from({ length: lesson.bars / 4 }, (_, phrase) => rhythmOf(phrase * 4))).size >= 2, `${where}: the phrases are played in different ways`)
      // Chord quality follows the numeral's case, built from the key's scale; the harmonic V and blues sevenths are named.
      const scale = (lesson.id.includes('dorian') ? [0, 2, 3, 5, 7, 9, 10] : mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10]).map((s) => (pitch + s) % 12)
      const minorScale = [0, 2, 3, 5, 7, 8, 10].map((s) => (pitch + s) % 12)
      lesson.numerals.forEach((numerals, bar) => numerals.split(' – ').forEach((numeral, part) => {
        const symbol = lesson.chords[bar].split(' ')[part]
        const { root, intervals } = parseChord(symbol)
        const bare = numeral.replace(/^b/, '')
        assert.equal(intervals.includes(3), bare[0] === bare[0].toLowerCase(), `${where}: ${numeral} is ${symbol}`)
        for (const x of intervals) {
          const tone = pc(root + x)
          const raised = /harmonic/.test(lesson.title) && /^V/.test(numeral) && tone === (pitch + 11) % 12
          const flatSeventh = blues && x === 10
          const borrowed = numeral.startsWith('b') && minorScale.includes(tone)
          assert.ok(scale.includes(tone) || raised || flatSeventh || borrowed, `${where}: ${symbol} is in the key or named as outside it`)
        }
      }))
      if (blues) assert.match(lesson.goal, /outside the major scale/)
      if (/harmonic/.test(lesson.title)) assert.match(lesson.goal, /raised seventh|seventh is raised/)
    }
  }
  assert.ok(families.size >= 18, `at least eighteen progression families (${families.size})`)
  assert.ok([...progressionLessons(0, 'major'), ...progressionLessons(9, 'minor')].every((lesson) => /^(Heard in|Same chords as) [^()]+\(/.test(lesson.feel) && lesson.examples?.songs.length && lesson.examples.songs.every((song) => /\(.+\)/.test(song)) &&
    lesson.examples.songs.every((song) => !lesson.goal.includes(song)) &&
    !/\(/.test(lesson.title.replace(/\((harmonic minor V|I7 – IV7 – V7|Dorian)\)/, ''))), 'every progression description names example songs and artists; titles stay compact')
  assert.deepEqual(pianoLessonById('piano-progression-ii-v-i-e-flat-major').chords.slice(0, 4), ['Fm7', 'Bb7', 'Ebmaj7', 'Ebmaj7'])
  assert.deepEqual(pianoLessonById('piano-progression-i-iv-v-i-harmonic-g-sharp-minor').chords.slice(0, 4), ['G#m', 'C#m', 'D#', 'G#m'])
  assert.deepEqual(pianoLessonById('piano-progression-twelve-bar-blues-a-major').chords.slice(0, 12), ['A7', 'A7', 'A7', 'A7', 'D7', 'D7', 'A7', 'A7', 'E7', 'D7', 'A7', 'E7'])
  assert.deepEqual(pianoLessonById('piano-progression-i-bvii-iv-i-c-major').chords.slice(0, 4), ['C', 'Bb', 'F', 'C'], 'bVII borrowed from C minor')
  assert.deepEqual(pianoLessonById('piano-progression-minor-ii-v-i-c-minor').chords.slice(0, 4), ['Dm7b5', 'G7', 'Cm', 'Cm'], 'minor ii–V–i: half-diminished ii, harmonic V7')
  assert.deepEqual(pianoLessonById('piano-progression-dorian-vamp-a-minor').chords.slice(0, 2), ['Am7', 'D7'], 'Dorian vamp: major IV7')
  assert.deepEqual(pianoLessonById('piano-progression-canon-d-major').chords.slice(0, 8), ['D', 'A', 'Bm', 'F#m', 'G', 'D', 'G', 'A'], 'the Canon sequence')
  assert.deepEqual(pianoLessonById('piano-progression-andalusian-a-minor').chords.slice(0, 4), ['Am', 'G', 'F', 'E'])

  // ---- Scales: fifteen kinds in every key ----
  assert.equal(SCALE_FAMILIES.length, 15)
  const fingerings = new Set()
  const STEPS = {
    major: [2, 2, 1, 2, 2, 2, 1], minor: [2, 1, 2, 2, 1, 2, 2], dorian: [2, 1, 2, 2, 2, 1, 2], phrygian: [1, 2, 2, 2, 1, 2, 2], lydian: [2, 2, 2, 1, 2, 2, 1],
    mixolydian: [2, 2, 1, 2, 2, 1, 2], locrian: [1, 2, 2, 1, 2, 2, 2], 'harmonic-minor': [2, 1, 2, 2, 1, 3, 1], 'melodic-minor': [2, 1, 2, 2, 2, 2, 1],
    'major-pentatonic': [2, 2, 3, 2, 3], 'minor-pentatonic': [3, 2, 2, 3, 2], blues: [3, 2, 1, 1, 3, 2], chromatic: Array(12).fill(1),
    'whole-tone': [2, 2, 2, 2, 2, 2], diminished: [1, 2, 1, 2, 1, 2, 1, 2],
  }
  for (const family of SCALE_FAMILIES) for (let pitch = 0; pitch < 12; pitch++) {
    const scales = scaleLessons(pitch, family.id)
    tonalCount += scales.length
    assert.equal(scales.length, 3, `${family.id} ${pitch}: right hand, left hand, hands together`)
    const tonic = scaleTonic(pitch, family.id)
    assert.equal(spelledPc(tonic), pitch, `${family.id}: the tonic ${tonic} names its pitch`)
    for (const lesson of scales) {
      const where = lesson.id
      assert.equal(pianoLessonById(lesson.id), lesson, `${where} opens by id`)
      assert.deepEqual(pianoLessonList(lesson), scales, `${where}: Previous and Next stay in the scale`)
      const back = browseTo(lesson.id, DEFAULT_BROWSE)
      assert.ok(back.pianoShelf === 'scale' && back.pianoKey.pitch === pitch && back.pianoScale === family.id, `${where}: Back returns to its scale`)
      assert.equal(lesson.key.tonic, tonic)
      assert.ok(lesson.title.startsWith(`${tonic} ${family.name}`), `${where}: titled with its tonic and scale (${lesson.title})`)
      playable(lesson)
      assert.ok(lesson.notes.every((n) => n.spell && spelledPc(n.spell) === pc(n.midi) && n.spell.length <= 3), `${where}: notes spelled to their pitches`)
      const xml = pianoXml(pianoLessonSong(lesson))
      assert.doesNotMatch(xml, /NaN|undefined/)
      assert.equal((xml.match(/<measure /g) ?? []).length, lesson.bars)
      const octaves = family.id === 'chromatic' ? 1 : 2
      const size = STEPS[family.id].length
      for (const hand of lesson.id.includes('together') ? ['right', 'left'] : [lesson.id.includes('right-hand') ? 'right' : 'left']) {
        const line = lesson.notes.filter((n) => n.hand === hand)
        const top = size * octaves
        assert.equal(line.length, top * 2 + 1, `${where} ${hand}: up and back down`)
        const up = line.slice(0, top + 1), down = line.slice(top)
        assert.deepEqual(up.slice(1).map((n, i) => n.midi - up[i].midi), Array(octaves).fill(STEPS[family.id]).flat(), `${where} ${hand}: the scale's steps going up`)
        const fall = family.id === 'melodic-minor' ? STEPS.minor : STEPS[family.id]
        assert.deepEqual(down.slice(1).map((n, i) => down[i].midi - n.midi), Array(octaves).fill([...fall].reverse()).flat(), `${where} ${hand}: the scale's steps coming down`)
        // The thumb keeps to white keys in seven-note scales; the others (pentatonics, blues, whole tone, diminished) may need it
        // on a black key, at most about once an octave.
        const thumbsOnBlack = up.filter((n) => n.finger === 1 && BLACK.includes(pc(n.midi))).length
        if (size === 7) assert.equal(thumbsOnBlack, 0, `${where} ${hand}: the thumb stays on white keys`)
        else if (family.id !== 'chromatic') assert.ok(thumbsOnBlack <= octaves + 1, `${where} ${hand}: the thumb rarely takes a black key (${thumbsOnBlack})`)
        if (size === 7) assert.ok(up.slice(1).every((n, i) => 'CDEFGAB'.indexOf(n.spell[0]) === ('CDEFGAB'.indexOf(up[i].spell[0]) + 1) % 7), `${where} ${hand}: one letter per degree`)
        fingerings.add(`${family.id}:${hand}:${up.map((n) => n.finger).join('')}`)
      }
      if (lesson.id.includes('together')) {
        const right = lesson.notes.filter((n) => n.hand === 'right'), left = lesson.notes.filter((n) => n.hand === 'left')
        assert.ok(right.every((n, i) => n.midi - left[i].midi === 12 && n.startBeat === left[i].startBeat), `${where}: the hands an octave apart`)
      }
    }
  }
  assert.ok(fingerings.size >= 60, `scale fingering follows the key and the scale, not one shape transposed (${fingerings.size} shapes)`)
  const notes = (id, hand) => pianoLessonById(id).notes.filter((n) => n.hand === hand)
  assert.equal(notes('piano-scale-right-hand-f-major', 'right')[3].finger, 4, 'F major: the fourth finger on Bb')
  assert.equal(notes('piano-scale-right-hand-b-flat-major', 'right')[0].finger, 4, 'Bb major starts on the fourth finger')
  assert.deepEqual([...new Set(notes('piano-scale-right-hand-d-flat-major', 'right').filter((n) => n.finger === 1).map((n) => n.spell))], ['F', 'C'], 'Db major: thumb on F and C')
  assert.ok(notes('piano-scale-right-hand-f-sharp-major', 'right').some((n) => n.spell === 'E#'), 'F# major is spelled with E#')
  assert.ok(notes('piano-scale-left-hand-e-flat-minor', 'left').some((n) => n.spell === 'Cb'), 'Eb minor is spelled with Cb')
  assert.match(pianoXml(pianoLessonSong(pianoLessonById('piano-scale-right-hand-f-sharp-major'))), /<step>E<\/step><alter>1<\/alter>/, 'E# is engraved as E sharp')
  assert.deepEqual(notes('piano-scale-right-hand-a-melodic-minor', 'right').slice(0, 8).map((n) => n.spell), ['A', 'B', 'C', 'D', 'E', 'F#', 'G#', 'A'], 'melodic minor raises the sixth and seventh going up')
  assert.deepEqual(notes('piano-scale-right-hand-a-melodic-minor', 'right').slice(-8).map((n) => n.spell), ['A', 'G', 'F', 'E', 'D', 'C', 'B', 'A'], 'and comes down natural')
  assert.deepEqual(notes('piano-scale-right-hand-a-blues', 'right').slice(0, 7).map((n) => n.spell), ['A', 'C', 'D', 'Eb', 'E', 'G', 'A'], 'the blues scale names its flat fifth')
  assert.deepEqual(notes('piano-scale-right-hand-c-diminished', 'right').slice(0, 9).map((n) => n.spell), ['C', 'Db', 'Eb', 'E', 'F#', 'G', 'A', 'Bb', 'C'], 'half-whole diminished')
  assert.equal(notes('piano-scale-right-hand-c-chromatic', 'right').slice(0, 13).map((n) => n.finger).join(''), '1313123131312', 'chromatic: 3 on black keys, 2 on F and C')

  // ---- Inspired studies ----
  for (const lesson of PIANO_INSPIRED) playable(lesson)

  // A lesson position for piano is kept under the course's own key and reopens on the piano.
  {
    const store = new Map()
    globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) }
    const lesson = pianoLessonById('piano-jazz-phrase')
    assert.deepEqual(lessonPosition(lesson), freshPosition(lesson))
    delete globalThis.localStorage
  }
  console.log(`Piano course checks passed: ${PIANO_LESSONS.length} genre lessons in ${groups.length} genres (8 and 16 bars, varied phrases, ` +
    `backing and chord names in agreement), ${PIANO_INSPIRED.length} inspired studies, ${tonalCount} progressions and scales in 24 keys; ` +
    'registers, chord tones, playable fingering, fills, pedalling, spelling and key fingering.')
} finally {
  await vite.close()
}
