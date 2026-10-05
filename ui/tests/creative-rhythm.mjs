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

test('comping and chord harmony follow the local syncopated backbeat, not two-quarter repeats', () => {
  const song = fixture({ drums: [
    ...drums,
    ...Array.from({ length: 18 }, (_, i) => ({ lane: 'hihat', startBeat: i / 2, velocity: 0.4 })),
    { lane: 'snare', startBeat: 0.75, velocity: 0.8 },
  ] })
  const snapshot = structuredClone(song)
  assert.deepEqual(Array.from(accompanimentRhythm(song)), backbeat)
  assert.deepEqual(starts(part(song, 'comping').piano, 'right'), backbeat)
  assert.deepEqual(starts(part(song, 'harmony-line', { ...HARMONY_DEFAULT, source: 'chords' }).piano), backbeat)
  const colour = part(song, 'colour')
  const expected = [...new Set([...backbeat, ...colour.chords.map((item) => item.startBeat)])].sort((a, b) => a - b)
  assert.deepEqual(starts(colour.piano, 'right'), expected)
  assert.deepEqual(song, snapshot, 'Generation must not rewrite source notes, meter, chords, or tempo map')
  for (const track of creativeTracks(song)) {
    for (const note of track.piano) {
      assert.ok(Number.isFinite(note.startBeat) && Number.isFinite(note.beats) && note.beats > 0)
      assert.ok(note.startBeat >= 0 && note.startBeat + note.beats <= 9)
    }
  }
})

test('bar-local percussion and pitched onsets preserve swing without copying another bar', () => {
  const song = fixture({
    drums: [{ lane: 'ride', startBeat: 0.125, velocity: 0.5 }, { lane: 'ride', startBeat: 1.625, velocity: 0.5 }],
    piano: [{ midi: 72, startBeat: 3.25, beats: 0.5, hand: 'right' }],
    vocals: [{ midi: 67, startBeat: 4.625, beats: 0.75 }],
    instrumentNotes: { strings: [{ midi: 60, startBeat: 5.5, beats: 0.5 }] },
  })
  assert.deepEqual(Array.from(accompanimentRhythm(song)), [0.125, 1.625, 3.25, 4.625, 5.5, 6, 7, 8])
  assert.deepEqual(starts(part(song, 'comping').piano, 'right'), [0, 0.125, 1.625, 3.25, 4.625, 5.5, 6, 7, 8])
})

test('meter fallback respects simple, compound, odd, and half-note meters in quarter-beat coordinates', () => {
  for (const [beatsPerBar, beatUnit, expected] of [
    [3, 4, [0, 1, 2, 3, 4, 5]],
    [3, 8, [0, 1.5, 3, 4.5]],
    [4.5, 8, [0, 1.5, 3, 4.5, 6, 7.5]],
    [2.5, 8, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5]],
    [4, 2, [0, 2, 4, 6]],
  ]) {
    const song = fixture({ beatsPerBar, beatUnit, bars: 2, piano: [], vocals: [], drums: [] })
    assert.deepEqual(Array.from(accompanimentRhythm(song)), expected)
  }
})

test('invalid meter or length fails explicitly instead of creating a nonadvancing fallback loop', () => {
  for (const field of ['beatUnit', 'beatsPerBar', 'bars']) {
    for (const value of [0, -1, NaN, Infinity, Number.MIN_VALUE, Number.MAX_VALUE]) {
      assert.throws(() => accompanimentRhythm(fixture({ [field]: value })), /invalid meter or length/)
    }
  }
  for (const overrides of [
    { beatUnit: 3 }, { beatUnit: 8.5 }, { beatUnit: Number.MAX_SAFE_INTEGER },
    { beatUnit: 2 ** 52 }, { beatUnit: 2 ** 1000 },
    { beatsPerBar: 3.25 }, { bars: 1.5 }, { bars: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.throws(() => accompanimentRhythm(fixture(overrides)), /invalid meter or length/)
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
    assert.ok(track.piano.some((note) => note.startBeat === 3.75), 'Known chord carries through the unknown span')
    assert.ok(track.piano.every((note) => note.startBeat + note.beats <= 6), 'No invented harmony during N.C.')
  }
  assert.deepEqual(song, snapshot)
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
      assert.deepEqual([...new Set(sounded.map(({ note }) => Math.max(begin, note.startBeat)))], [3.25, 3.75, 5, 6, 6.75, 8])
      assert.ok(sounded.filter(({ note }) => note.startBeat === 3).every(({ duration }) => duration > 0), 'Resume carries the held chord')
      const beforeLoop = sounded.length
      engine.loop = { startBar: 2, endBar: 2 }
      engine.seek(5.75)
      const loopAt = engine.ctx.currentTime + 0.05 + engine.seconds(5.75, 6)
      engine.ctx.currentTime = loopAt
      engine.schedule()
      assert.ok(Math.abs(engine.read().beat - 3) < 1e-7)
      assert.equal(sounded.slice(beforeLoop).filter(({ note }) => note.startBeat === 3).length, 3, 'Loop starts the existing voicing once')
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
