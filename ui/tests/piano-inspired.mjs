import assert from 'node:assert/strict'
import { createServer } from 'vite'

globalThis.matchMedia = () => ({ matches: false })
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { PIANO_INSPIRED } = await vite.ssrLoadModule('/src/course/pianoInspired.ts')
  const { PIANO_LESSONS, pianoLessonList } = await vite.ssrLoadModule('/src/course/piano.ts')
  const { pianoSong, canFollow } = await vite.ssrLoadModule('/src/course/pianoParts.ts')
  const { parseChord, chordSpans } = await vite.ssrLoadModule('/src/course/accompaniment.ts')
  const { lessonMeter } = await vite.ssrLoadModule('/src/course/curriculum.ts')
  const { pianoXml } = await vite.ssrLoadModule('/src/workspace/musicxml.ts')
  const pc = (midi) => ((midi % 12) + 12) % 12
  const expectedInfluences = [
    'Erik Satie — Gymnopédie No. 1',
    'Ray Charles — I Got a Woman',
    'Stevie Wonder — Superstition',
    'Elton John — Your Song',
    'Pink Floyd — Breathe (In the Air)',
    'The Dave Brubeck Quartet — Take Five',
    'Vince Guaraldi Trio — Skating',
    'Carole King — You’ve Got a Friend',
    'Bruce Hornsby and the Range — The Way It Is',
    'Herbie Hancock — Cantaloupe Island',
    'Scott Joplin — Maple Leaf Rag',
    'Coldplay — Clocks',
    'Hans Zimmer — Time (Inception)',
    'Hans Zimmer — Cornfield Chase (Interstellar)',
    'Hans Zimmer — Day One (Interstellar)',
    'Hans Zimmer — Davy Jones (Pirates of the Caribbean: Dead Man’s Chest)',
    'Hans Zimmer — Up Is Down (Pirates of the Caribbean: At World’s End)',
    'Hans Zimmer, Lisa Gerrard & Klaus Badelt — Now We Are Free (Gladiator)',
    'Hans Zimmer & James Newton Howard — A Dark Knight (The Dark Knight)',
    'Hans Zimmer — This Land (The Lion King)',
    'Hans Zimmer — Paul’s Dream (Dune)',
    'Pink Floyd — Us and Them',
    'Coldplay — The Scientist',
  ]
  assert.equal(PIANO_INSPIRED.length, 23, 'twenty-three inspired piano studies')
  assert.equal(new Set(PIANO_INSPIRED.map(({ id }) => id)).size, 23, 'unique ids')
  assert.equal(new Set(PIANO_INSPIRED.map(({ title }) => title)).size, 23, 'unique titles')
  const zimmer = PIANO_INSPIRED.filter((lesson) => /Hans Zimmer/.test(lesson.influence))
  assert.equal(zimmer.length, 9, 'nine Zimmer-inspired studies')
  assert.ok(new Set(zimmer.map((lesson) => lesson.influence.match(/\(([^()]*)\)$/)?.[1])).size >= 7, 'Zimmer studies span at least seven films')
  assert.equal(PIANO_INSPIRED.filter((lesson) => lesson.influence.startsWith('Pink Floyd —')).length, 2, 'two distinct Pink Floyd studies')
  assert.equal(PIANO_INSPIRED.filter((lesson) => lesson.influence.startsWith('Coldplay —')).length, 2, 'two distinct Coldplay studies')

  const handMotif = (lesson, bar, hand) => {
    const beatsPerBar = lessonMeter(lesson).beatsPerBar
    const notes = lesson.notes.filter((note) => note.hand === hand && Math.floor(note.startBeat / beatsPerBar + 1e-9) === bar)
    const lowest = Math.min(...notes.map((note) => note.midi))
    return JSON.stringify(notes.map((note) => [
      +((note.startBeat - bar * beatsPerBar) / beatsPerBar).toFixed(4),
      +(note.beats / beatsPerBar).toFixed(4),
      note.midi - lowest,
    ]).sort((a, b) => a[0] - b[0] || a[2] - b[2]))
  }
  const genreMotifs = new Map(['right', 'left'].map((hand) => [hand, new Set(PIANO_LESSONS.flatMap((lesson) =>
    Array.from({ length: lesson.bars }, (_, bar) => handMotif(lesson, bar, hand))))]))
  const seenStudyMotifs = new Map(['right', 'left'].map((hand) => [hand, new Map()]))
  const seenStudyBars = new Map()

  for (const [index, lesson] of PIANO_INSPIRED.entries()) {
    const where = lesson.id
    assert.match(where, /^piano-inspired-[a-z0-9-]+$/)
    assert.equal(lesson.influence, expectedInfluences[index], `${where}: artist and reference track`)
    assert.match(lesson.goal, /original study/i, `${where}: identified as an original study`)
    assert.match(lesson.goal, /not a transcription/i, `${where}: identified as not a transcription`)
    assert.ok(lesson.kind === 'inspired' && lesson.level === index + 1)
    assert.ok(lesson.tempo.start < lesson.tempo.target)
    assert.ok([8, 16].includes(lesson.bars))
    assert.equal(lesson.chords.length, lesson.bars)
    assert.equal(lesson.sections.reduce((sum, section) => sum + section.bars, 0), lesson.bars)
    assert.equal(lessonMeter(lesson).beatsPerBar, lesson.meter.numerator * 4 / lesson.meter.denominator, `${where}: phrase matches its meter`)
    assert.equal(!!lesson.pedals?.length, lesson.hands.includes('Right foot: sustain pedal'), `${where}: pedal matches hand instructions`)
    const barVelocities = Array.from({ length: lesson.bars }, (_, bar) => {
      const notes = lesson.notes.filter((note) => Math.floor(note.startBeat / lessonMeter(lesson).beatsPerBar + 1e-9) === bar)
      return notes.reduce((sum, note) => sum + note.velocity, 0) / notes.length
    })
    assert.ok(Math.max(...barVelocities) - Math.min(...barVelocities) >= 0.06, `${where}: phrase has shaped dynamics`)
    const { beatsPerBar } = lessonMeter(lesson)
    const spans = chordSpans(lesson.chords, beatsPerBar)
    const spanAt = (beat) => spans.findLast((span) => span.start <= beat + 1e-9)
    const fills = lesson.fills ?? []
    const leftLine = lesson.notes.filter((note) => note.hand === 'left').sort((a, b) => a.startBeat - b.startBeat)

    for (let bar = 0; bar < lesson.bars; bar++) {
      const motifs = ['right', 'left'].map((hand) => handMotif(lesson, bar, hand))
      const wholeBar = JSON.stringify(motifs)
      const priorBar = seenStudyBars.get(wholeBar)
      assert.ok(!priorBar || priorBar === where, `${where} bar ${bar + 1}: not the same normalized bar as another study`)
      seenStudyBars.set(wholeBar, where)
      for (const [index, hand] of ['right', 'left'].entries()) {
        const motif = motifs[index]
        assert.ok(!genreMotifs.get(hand).has(motif), `${where} bar ${bar + 1}: unique ${hand}-hand motif versus genre lessons`)
        const prior = seenStudyMotifs.get(hand).get(motif)
        assert.ok(!prior || prior === where, `${where} bar ${bar + 1}: unique ${hand}-hand motif versus other studies`)
        seenStudyMotifs.get(hand).set(motif, where)
      }
    }

    for (const note of lesson.notes) {
      assert.equal(note.trackId, 'piano')
      assert.ok(Number.isInteger(note.midi) && note.beats > 0 && [1, 2, 3, 4, 5].includes(note.finger), `${where}: fingered note`)
      const span = spanAt(note.startBeat)
      assert.ok(span && note.startBeat + note.beats <= span.end + 1e-9, `${where}: note stays within its chord`)
      const { root, intervals } = parseChord(span.symbol)
      const tones = intervals.map((interval) => pc(root + interval))
      if (note.hand === 'right') {
        const bar = Math.floor(note.startBeat / beatsPerBar)
        const inFill = fills.includes(bar) && note.startBeat - bar * beatsPerBar >= beatsPerBar / 2 - 1e-9
        if (!inFill) assert.ok(tones.includes(pc(note.midi)), `${where}: right hand ${note.midi} is a chord tone of ${span.symbol}`)
      } else {
        const next = leftLine.find((other) => other.startBeat > note.startBeat + 1e-9) ?? leftLine[0]
        assert.ok(tones.includes(pc(note.midi)) || pc(note.midi) === pc(root + 9) || (next && Math.abs(note.midi - next.midi) <= 2),
          `${where}: left hand ${note.midi} at ${note.startBeat} belongs to ${span.symbol} as a chord tone, sixth or approach`)
      }
    }

    for (const hand of ['right', 'left']) {
      const notes = lesson.notes.filter((note) => note.hand === hand).sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi)
      const onsets = [...Map.groupBy(notes, (note) => note.startBeat).values()]
      for (const group of onsets) {
        assert.equal(new Set(group.map((note) => note.finger)).size, group.length, `${where}: unique ${hand}-hand fingers`)
        assert.ok(group.at(-1).midi - group[0].midi <= 12, `${where}: ${hand}-hand stretch within an octave`)
      }
      onsets.forEach((group, i) => {
        const before = onsets[i - 1]
        if (!before || before.length !== 1 || group.length !== 1) return
        const [a] = before, [b] = group
        assert.ok(canFollow(hand, { midi: a.midi, finger: a.finger, start: a.startBeat, end: a.startBeat + a.beats }, { midi: b.midi, finger: b.finger, start: b.startBeat }),
          `${where}: ${hand}-hand fingering can follow`)
      })
    }

    const shapes = Array.from({ length: lesson.bars }, (_, bar) => JSON.stringify(lesson.notes
      .filter((note) => Math.floor(note.startBeat / beatsPerBar + 1e-9) === bar)
      .map((note) => [note.hand, note.midi, +(note.startBeat - bar * beatsPerBar).toFixed(3), note.beats, note.finger])))
    for (const period of [1, 2, 4].filter((length) => length < lesson.bars))
      assert.ok(shapes.some((shape, bar) => shape !== shapes[bar % period]), `${where}: not a ${period}-bar tile`)

    const song = pianoSong(lesson)
    assert.equal(song.bars, lesson.bars)
    assert.equal(song.piano, lesson.notes)
    const xml = pianoXml(song)
    assert.equal((xml.match(/<measure /g) ?? []).length, lesson.bars, `${where}: MusicXML measure count`)
    assert.doesNotMatch(xml, /NaN|undefined/, `${where}: valid MusicXML`)
    assert.deepEqual(pianoLessonList(lesson), PIANO_INSPIRED, `${where}: Previous/Next order`)
  }
  console.log('piano-inspired: 23 studies passed')
} finally {
  await vite.close()
}
