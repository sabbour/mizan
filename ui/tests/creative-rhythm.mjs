// Run from the repository root: node --experimental-vm-modules --test ui\tests\creative-rhythm.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createContext, SourceTextModule } from 'node:vm'
import ts from 'typescript'

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'workspace')
const modules = new Map()
const timers = new Map()
let nextTimer = 1
const setTimer = (callback) => {
  const id = nextTimer++
  timers.set(id, callback)
  return id
}
const context = createContext({
  window: { setInterval: setTimer, setTimeout: setTimer },
  clearInterval: (id) => timers.delete(id),
  clearTimeout: (id) => timers.delete(id),
  AudioContext: class {
    constructor() { assert.fail('Synthetic rhythm checks must not create audio contexts') }
  },
  fetch() { assert.fail('Synthetic rhythm checks must not fetch samples or recordings') },
})

async function load(file) {
  if (modules.has(file)) return modules.get(file)
  const source = await readFile(file, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  })
  const module = new SourceTextModule(outputText, { context, identifier: file })
  modules.set(file, module)
  await module.link((specifier, parent) =>
    load(path.resolve(path.dirname(parent.identifier), `${specifier}.ts`)))
  return module
}

const creativeModule = await load(path.join(workspace, 'creative.ts'))
const engineModule = await load(path.join(workspace, 'engine.ts'))
await creativeModule.evaluate()
await engineModule.evaluate()
const { creativeTracks, accompanimentRhythm, chordRhythm, HARMONY_DEFAULT } = creativeModule.namespace
const { Engine } = engineModule.namespace
const { buildSong } = modules.get(path.join(workspace, 'song.ts')).namespace

const chord = (startBeat, beats, symbol = 'C') => ({
  startBeat, beats, symbol, numeral: 'I', role: 'tonic',
  tones: symbol === 'N.C.' ? [] : [60, 64, 67], flats: false, confidence: 1,
})
function fixture(overrides = {}) {
  return {
    ...JSON.parse(JSON.stringify(buildSong())), bars: 3, beatsPerBar: 3, beatUnit: 4,
    chords: [chord(0, 9)], sections: [{ name: 'Study', startBar: 1, bars: 3 }],
    piano: [
      { midi: 72, startBeat: 0.75, beats: 0.5, hand: 'right' },
      { midi: 74, startBeat: 3.75, beats: 1, hand: 'right' },
    ],
    vocals: [], drums: [], instrumentNotes: undefined,
    tempoMap: [{ beat: 0, time: 0 }, { beat: 3, time: 2 }, { beat: 6, time: 3.5 }, { beat: 9, time: 6 }],
    ...overrides,
  }
}
const starts = (notes, hand) => [...new Set(Array.from(notes)
  .filter((note) => !hand || note.hand === hand).map((note) => note.startBeat))].sort((a, b) => a - b)
const part = (song, id, options = HARMONY_DEFAULT) =>
  creativeTracks(song, options).find((track) => track.id === id)
const backbeat = [0, 0.75, 2, 3, 3.75, 5, 6, 6.75, 8]
const drums = backbeat.map((startBeat, i) => ({
  lane: i % 3 ? 'snare' : 'kick', startBeat, velocity: 0.8,
}))

test('dense source rhythms keep bounded, beat-aware comping density', () => {
  const song = fixture({ drums: [
    ...drums,
    ...Array.from({ length: 18 }, (_, i) => ({ lane: 'hihat', startBeat: i / 2, velocity: 0.4 })),
    { lane: 'snare', startBeat: 0.75, velocity: 0.8 },
  ] })
  const snapshot = structuredClone(song)
  const restrained = [0, 2, 3, 5, 6, 8]
  assert.deepEqual(Array.from(accompanimentRhythm(song)), restrained)
  assert.deepEqual(starts(part(song, 'harmony-line', { ...HARMONY_DEFAULT, source: 'chords' }).piano), [0],
    'chord harmony holds through drum-driven comping attacks')
  const colour = part(song, 'colour')
  assert.ok(colour.chords.length <= song.chords.length, 'Colour does not add passing or substitute chords')
  assert.deepEqual(song, snapshot, 'Generation must not rewrite source notes, meter, chords, or tempo map')
  for (const track of creativeTracks(song)) {
    for (const note of track.piano) {
      assert.ok(Number.isFinite(note.startBeat) && Number.isFinite(note.beats) && note.beats > 0)
      assert.ok(note.startBeat >= 0 && note.startBeat + note.beats <= 9)
    }
    const attacks = starts(track.piano, 'right')
    if (track.chordal) assert.ok(attacks.includes(0), `${track.id} sounds the chord on its downbeat`)
    for (let bar = 0; bar < song.bars; bar++) {
      const inBar = attacks.filter((beat) => beat >= bar * song.beatsPerBar && beat < (bar + 1) * song.beatsPerBar)
      assert.ok(inBar.length <= 2 * song.beatsPerBar, `${track.id} stays within eighth-note density in bar ${bar + 1}`)
    }
    // Attacks off the eighth grid only ever come from the recording's own accents.
    if (track.chordal) for (const beat of attacks) assert.ok(Number.isInteger(beat * 2) || restrained.includes(beat), `${track.id} invented ${beat}`)
  }
})

test('dense syncopation keeps distinct source accents closest to meter anchors', () => {
  const patterns = [
    [0.5, 1.25, 2.75, 3.5],
    [0.75, 1.5, 2.25, 3],
  ]
  const selected = patterns.map((accents) => {
    const song = fixture({
      bars: 1,
      beatsPerBar: 4,
      beatUnit: 4,
      piano: [],
      drums: accents.map((startBeat) => ({ lane: 'hihat', startBeat, velocity: 0.5 })),
    })
    const rhythm = Array.from(accompanimentRhythm(song))
    assert.equal(rhythm.length, 2, 'dense source bars remain capped at two attacks')
    assert.ok(rhythm.every((beat) => accents.includes(beat)), 'selected attacks come from actual source accents')
    return rhythm
  })
  assert.deepEqual(selected, [[0.5, 2.75], [0.75, 2.25]])
  assert.notDeepEqual(selected[0], selected[1], 'different syncopated grooves do not fall back to identical anchors')
})

test('bar-local percussion and pitched onsets preserve swing without copying another bar', () => {
  const song = fixture({
    drums: [{ lane: 'ride', startBeat: 0.125, velocity: 0.5 }, { lane: 'ride', startBeat: 1.625, velocity: 0.5 }],
    piano: [{ midi: 72, startBeat: 3.25, beats: 0.5, hand: 'right' }],
    vocals: [{ midi: 67, startBeat: 4.625, beats: 0.75 }],
    instrumentNotes: { strings: [{ midi: 60, startBeat: 5.5, beats: 0.5 }] },
  })
  assert.deepEqual(Array.from(accompanimentRhythm(song)), [0.125, 1.625, 3.25, 4.625, 6, 8])
  // Swung accents are kept where the comping follows the source, and no off-grid swing is invented.
  const comping = starts(part(song, 'comping').piano, 'right')
  assert.ok(comping.some((beat) => !Number.isInteger(beat * 2)), 'some swung source accents survive')
  for (const beat of comping) assert.ok(Number.isInteger(beat * 2) || [0.125, 1.625, 3.25, 4.625].includes(beat), `invented ${beat}`)
})

test('meter fallback bounds attacks in simple, compound, odd, and half-note bars', () => {
  for (const [beatsPerBar, beatUnit, expected] of [
    [3, 4, [0, 2, 3, 5]],
    [3, 8, [0, 1.5, 3, 4.5]],
    [4.5, 8, [0, 3, 4.5, 7.5]],
    [2.5, 8, [0, 1.5, 2.5, 4]],
    [4, 2, [0, 2, 4, 6]],
  ]) {
    const song = fixture({ beatsPerBar, beatUnit, bars: 2, piano: [], vocals: [], drums: [] })
    assert.deepEqual(Array.from(accompanimentRhythm(song)), expected)
  }
})

test('invalid meter or length fails explicitly instead of creating a nonadvancing fallback loop', () => {
  for (const field of ['beatUnit', 'beatsPerBar', 'bars']) {
    for (const value of [0, -1, NaN, Infinity, Number.MIN_VALUE, Number.MAX_VALUE]) {
      assert.throws(() => accompanimentRhythm(fixture({ [field]: value })), /invalid meter or length|invalid (or non-contiguous )?bar (map|count)/)
    }
  }
  for (const overrides of [
    { beatUnit: 3 }, { beatUnit: 8.5 }, { beatUnit: Number.MAX_SAFE_INTEGER },
    { beatUnit: 2 ** 52 }, { beatUnit: 2 ** 1000 },
    { beatsPerBar: 3.25 }, { bars: 1.5 }, { bars: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.throws(() => accompanimentRhythm(fixture(overrides)), /invalid meter or length|invalid (or non-contiguous )?bar (map|count)/)
  }
})

test('chord attacks cover pickups and uncertain sustains without crossing N.C. or chord changes', () => {
  assert.deepEqual(Array.from(chordRhythm(chord(0.25, 1.5), [2, 1.5, 0.5, 0.5, 0]), (pulse) => ({ ...pulse })), [
    { startBeat: 0.25, beats: 0.25 }, { startBeat: 0.5, beats: 1 }, { startBeat: 1.5, beats: 0.25 },
  ])
  assert.equal(chordRhythm(chord(0, 0), [0, 1]).length, 0)
  const song = fixture({
    chords: [chord(0, 3), { ...chord(3, 3), symbol: null }, chord(6, 3, 'N.C.')],
    drums,
  })
  const snapshot = structuredClone(song)
  for (const track of creativeTracks(song, { ...HARMONY_DEFAULT, source: 'chords' })) {
    assert.ok(track.piano.some((note) => note.startBeat <= 3 && note.startBeat + note.beats > 3),
      'Known chord carries through the unknown span')
    assert.ok(track.piano.every((note) => note.startBeat + note.beats <= 6), 'No invented harmony during N.C.')
  }
  assert.deepEqual(song, snapshot)
})

test('melody duration selects generated color without letting one passing tone dominate', () => {
  const withMelody = (midi, beats, startBeat = 0.25) => fixture({
    bars: 1,
    beatsPerBar: 4,
    chords: [chord(0, 4, 'C')],
    piano: [{ midi, startBeat, beats, hand: 'right', velocity: 0.8 }],
    vocals: [],
    drums: [],
  })
  const ninthSong = withMelody(74, 1.5)
  const seventhSong = withMelody(71, 1.5)
  const passingSong = withMelody(74, 0.5)
  const snapshots = [ninthSong, seventhSong, passingSong].map((song) => structuredClone(song))
  const choice = (song) => part(song, 'colour').chords[0].symbol
  const ninth = choice(ninthSong)
  const seventh = choice(seventhSong)
  assert.notEqual(ninth, 'C', 'a held D can support a C color chord')
  assert.notEqual(seventh, 'C', 'a held B can support a different C color chord')
  assert.notEqual(ninth, seventh, 'changing the melody changes the generated chord choice')
  assert.equal(choice(passingSong), 'C', 'a passing note covering only a small part of the harmonic region is not enough evidence to replace C')
  for (const [song, snapshot] of [ninthSong, seventhSong, passingSong].map((song, index) =>
    [song, snapshots[index]])) assert.deepEqual(song, snapshot, 'Generated choices do not rewrite source data')

  const repeated = withMelody(74, 1.5)
  repeated.chords = [chord(0, 2, 'C'), chord(2, 2, 'C')]
  const repeatedSource = structuredClone(repeated.chords)
  assert.equal(part(repeated, 'colour').chords.length, 2,
    'compatible chord segments merge only when the melody supports carrying the generated choice')
  assert.deepEqual(repeated.chords, repeatedSource, 'Merging a generated chord never mutates adjacent source chords')
})

test('compatible melody keeps chord harmony stable through dense hits and nearby chord changes', () => {
  const song = fixture({
    bars: 1,
    beatsPerBar: 4,
    chords: [
      chord(0, 2, 'C'),
      { ...chord(2, 2, 'G'), numeral: 'V', role: 'dominant', tones: [67, 71, 74] },
    ],
    piano: [{ midi: 74, startBeat: 0, beats: 4, hand: 'right', velocity: 0.8 }],
    drums: Array.from({ length: 16 }, (_, index) => ({
      lane: 'hihat', startBeat: index / 4, velocity: 0.4,
    })),
  })
  const snapshot = structuredClone(song)
  const generated = creativeTracks(song, { ...HARMONY_DEFAULT, source: 'chords' })
  const colour = generated.find((track) => track.id === 'colour')
  const harmony = generated.find((track) => track.id === 'harmony-line')
  const comping = generated.find((track) => track.id === 'comping')
  assert.equal(colour.chords.length, 1, 'a supported compatible chord is held across the source change')
  assert.equal(colour.chords[0].beats, 4)
  assert.equal(harmony.piano.length, 1, 'chord harmony does not reattack on dense accompaniment hits')
  assert.deepEqual(Array.from(comping.piano.filter((note) => note.hand === 'right'), (note) => note.startBeat)
    .filter((beat, index, all) => all.indexOf(beat) === index), [0, 2],
  'comping attacks remain separately bounded to two meter-aware beats')
  const chordsByPc = generated.find((track) => track.id === 'colour').chords[0].tones.map((tone) => tone % 12)
  assert.ok(chordsByPc.includes(harmony.piano[0].midi % 12), 'the generated harmony note remains a chord tone')
  assert.deepEqual(song, snapshot, 'generated chord and harmony choices leave source progression and melody unchanged')
  assert.deepEqual(creativeTracks(song, { ...HARMONY_DEFAULT, source: 'chords' }), generated,
    'the generated voicings are deterministic')
})

test('melody harmony retains the lead rhythm and long-note option', () => {
  const song = fixture({ piano: [
    { midi: 72, startBeat: 0.125, beats: 0.5, hand: 'right' },
    { midi: 74, startBeat: 1.625, beats: 0.5, hand: 'right' },
    { midi: 76, startBeat: 3, beats: 1.25, hand: 'right' },
  ], drums })
  const melody = part(song, 'harmony-line')
  assert.deepEqual(Array.from(melody.piano, ({ startBeat, beats }) => ({ startBeat, beats })),
    song.piano.map(({ startBeat, beats }) => ({ startBeat, beats })))
  assert.deepEqual(starts(part(song, 'harmony-line', { ...HARMONY_DEFAULT, sparse: true }).piano), [3])
})

test('melody harmony preserves the aimed third when no chord tone is close enough', () => {
  const song = fixture({
    bars: 1,
    beatsPerBar: 4,
    chords: [chord(0, 4, 'Dm')],
    piano: [{ midi: 64, startBeat: 0.5, beats: 1, hand: 'right' }],
    vocals: [],
    drums: [],
  })
  const melody = part(song, 'harmony-line')
  assert.deepEqual(Array.from(melody.piano, ({ midi }) => midi), [60],
    'a major second from the aimed pitch does not displace the intended third')
})

test('source beat attacks schedule on the actual engine clock at 1x and half speed, including resume and loop', () => {
  const song = fixture({ drums })
  const notes = part(song, 'comping').piano
  for (const rate of [1, 0.5]) {
    const engine = new Engine({ ...song, chords: [], piano: [], vocals: [], drums: [], tracks: [] })
    const sounded = []
    engine.ctx = { currentTime: 0 }
    engine.countIn = false
    engine.rate = rate
    engine.extras = [{ id: 'comping', notes }]
    engine.lead = (time, note, duration, id) => sounded.push({ time, note, duration, id })
    try {
      const begin = 3.25
      engine.startAt(begin, false)
      let checked = 0
      for (let time = 0; time < engine.seconds(begin, 9); time += 0.025) {
        engine.ctx.currentTime = time
        engine.schedule()
        for (; checked < sounded.length; checked++) {
          const event = sounded[checked]
          const beat = Math.max(begin, event.note.startBeat)
          assert.equal(event.id, 'comping')
          assert.ok(Math.abs(event.time - (0.05 + engine.seconds(begin, beat))) < 1e-8,
            `Attack at beat ${beat} must use the tempo map at ${rate}x (${event.time}s)`)
          assert.ok(Math.abs(event.duration - engine.seconds(beat, event.note.startBeat + event.note.beats)) < 1e-8)
          engine.ctx.currentTime = event.time
          assert.ok(Math.abs(engine.read().beat - beat) < 1e-7, `Engine clock must read the sounded beat at ${rate}x`)
          engine.ctx.currentTime = time
        }
        if (engine.timer === -1) break
      }
      const expected = [...new Set(Array.from(notes).filter((note) => note.startBeat + note.beats > begin)
        .map((note) => Math.max(begin, note.startBeat)))].sort((a, b) => a - b)
      assert.deepEqual([...new Set(sounded.map(({ note }) => Math.max(begin, note.startBeat)))], expected)
      assert.ok(sounded.filter(({ note }) => note.startBeat < begin).every(({ duration }) => duration > 0), 'Resume carries the held notes')
      const beforeLoop = sounded.length
      engine.loop = { startBar: 2, endBar: 2 }
      engine.seek(5.75)
      const loopAt = engine.ctx.currentTime + 0.05 + engine.seconds(5.75, 6)
      engine.ctx.currentTime = loopAt
      engine.schedule()
      assert.ok(Math.abs(engine.read().beat - 3) < 1e-7)
      assert.equal(sounded.slice(beforeLoop).filter(({ note }) => note.startBeat === 3).length,
        Array.from(notes).filter((note) => note.startBeat === 3).length, 'Loop starts the existing voicing once')
    } finally {
      engine.halt()
    }
  }
  assert.equal(timers.size, 0, 'Synthetic engine timers must be cleaned up')
})

test('creative source passes semantic type checking without emitting build artifacts', () => {
  const program = ts.createProgram([path.join(workspace, 'creative.ts')], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true, noEmit: true,
  })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
  }))
})

test('accompaniment follows energy and phrases with voice leading, a walking bass and resolving suspensions', () => {
  const tones = { C: [60, 64, 67], F: [65, 69, 72], G: [55, 59, 62] }
  const progression = ['C', 'C', 'G', 'C', 'F', 'G', 'C', 'C']
  const melody = [[64, 64], [67, 64], [62, 59], [60], [69, 65], [59, 62], [64, 67], [60]]
  const song = fixture({
    bars: 8, beatsPerBar: 4, beatUnit: 4, tempoMap: undefined, bpm: 120, key: { tonic: 'C', mode: 'major' },
    sections: [{ name: 'Verse', startBar: 1, bars: 4 }, { name: 'Chorus', startBar: 5, bars: 4 }],
    chords: progression.map((symbol, bar) => ({ startBeat: bar * 4, beats: 4, symbol, numeral: null, role: null,
      tones: tones[symbol], flats: false, confidence: 1 })),
    piano: [],
    vocals: melody.flatMap((pitches, bar) => pitches.map((midi, i) =>
      ({ midi, startBeat: bar * 4 + i * (4 / pitches.length), beats: 4 / pitches.length }))),
    // The chorus is busy: eighth-note hats with kick and snare. The verse has only its melody.
    drums: Array.from({ length: 32 }, (_, i) => ({ lane: i % 4 === 0 ? 'kick' : i % 4 === 2 ? 'snare' : 'hihat',
      startBeat: 16 + i / 2, velocity: 0.7 })),
  })
  const snapshot = structuredClone(song)
  const comping = part(song, 'comping').piano
  const right = (from, to, notes = comping) => notes.filter((n) => n.hand === 'right' && n.startBeat >= from && n.startBeat < to)
  const pcs = (notes) => new Set(notes.map((n) => ((n.midi % 12) + 12) % 12))
  for (const note of comping.filter((n) => n.hand === 'right')) {
    const chord = song.chords.find((c) => c.startBeat <= note.startBeat && note.startBeat < c.startBeat + c.beats)
    assert.ok(chord.tones.some((t) => (t - note.midi) % 12 === 0), `Smooth comping keeps detected chord tones (${note.midi} at ${note.startBeat})`)
  }
  // Quiet verse: arpeggiated, one note per pulse; its cadence bar is held to release the phrase.
  for (const beat of starts(right(0, 12))) assert.equal(right(beat, beat + 1e-9).length, 1, `verse beat ${beat} is a broken chord`)
  assert.deepEqual(starts(right(12, 16)), [12], 'the verse cadence holds')
  assert.ok(right(12, 16).length >= 3 && right(12, 16).every((n) => n.beats === 4))
  // Busy chorus: off-beat stabs drive it, and the downbeat is louder than the off-beats.
  assert.ok(starts(right(16, 28)).some((beat) => beat % 1 === 0.5), 'the chorus adds off-beat stabs')
  const downbeat = right(16, 16 + 1e-9)[0].velocity
  assert.ok(right(16, 20).filter((n) => n.startBeat % 1 === 0.5).every((n) => n.velocity < downbeat))
  assert.ok(new Set(comping.map((n) => n.velocity)).size >= 3, 'dynamics vary with meter and phrase')
  // Voice leading: the top notes of consecutive chord voicings move by small steps.
  const tops = starts(comping, 'right').filter((beat) => right(beat, beat + 1e-9).length > 1).map((beat) => Math.max(...right(beat, beat + 1e-9).map((n) => n.midi)))
  assert.ok(tops.slice(1).every((top, i) => Math.abs(top - tops[i]) <= 7), 'the top voice never leaps beyond a fifth')
  // Walking bass: the last pulse before C -> G steps down to it from F, the scale tone below.
  const approach = comping.find((n) => n.hand === 'left' && n.startBeat === 7)
  assert.equal(approach?.midi % 12, 5, 'the bass walks into G from F')
  // Colour chords: G resolving to C starts as Gsus4 and resolves to its third halfway.
  const colour = part(song, 'colour')
  assert.equal(colour.chords.find((c) => c.startBeat === 8).symbol, 'G', 'the chord label stays G; the suspension is texture')
  const before = pcs(right(8, 10, colour.piano))
  const after = pcs(right(10, 12, colour.piano))
  assert.ok(!before.has(11) && [...before].every((p) => [7, 0, 2].includes(p)), `Gsus4 before resolving: ${[...before]}`)
  assert.ok([...after].every((p) => [7, 11, 2].includes(p)), `G after resolving: ${[...after]}`)
  assert.ok([...pcs(right(8, 10))].every((p) => [7, 11, 2].includes(p)), 'Smooth comping does not suspend')
  // Harmony line: oblique hold over a repeated melody note, no unisons, and phrase ends on chord tones.
  const line = part(song, 'harmony-line').piano
  assert.deepEqual(JSON.parse(JSON.stringify(line.filter((n) => n.startBeat < 4).map((n) => [n.startBeat, n.beats, n.midi]))), [[0, 4, 60]],
    'the repeated E is answered by one held C')
  for (const note of line) assert.ok(!song.vocals.some((m) => m.startBeat === note.startBeat && m.midi === note.midi))
  const ending = line.find((n) => n.startBeat <= 12 && 12 < n.startBeat + n.beats)
  assert.ok(ending && [0, 4, 7].includes(ending.midi % 12), 'the verse ends on a C-major chord tone')
  assert.ok(new Set(line.map((n) => n.velocity)).size >= 2)
  assert.deepEqual(song, snapshot, 'nothing in the song is rewritten')
})
