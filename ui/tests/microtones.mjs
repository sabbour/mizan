import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

function load(file, context) {
  const source = readFileSync(join('src', 'workspace', file), 'utf8')
    .replace(/^import .+$/gm, '')
    .replace(/^export /gm, '')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  })
  vm.runInContext(outputText, context)
}

const context = vm.createContext({ Float32Array, Set, Map, Math })
load('song.ts', context)
load('meter.ts', context)
vm.runInContext('var meterMeasures = measures; var measureIndex = barAt', context)
load('engine.ts', context)
load('musicxml.ts', context)
assert.equal(vm.runInContext('noteName(60.5)', context), 'C +50¢')
assert.equal(vm.runInContext('noteName(59.98)', context), 'C -2¢')

const song = {
  bpm: 120, bars: 1, beatsPerBar: 4, tracks: [], chords: [], drums: [],
  piano: [{ midi: 60.5, startBeat: 0, beats: 1, hand: 'right' }],
  vocals: [{ midi: 60.5, startBeat: 0, beats: 1 }],
}
context.song = song
assert.match(vm.runInContext('pianoXml(song)', context), /<alter>0\.5<\/alter>/)
assert.match(vm.runInContext('vocalXml(song)', context), /<alter>0\.5<\/alter>/)
context.song = {
  ...song,
  piano: [{ ...song.piano[0], pitchBends: [{ beat: 0.5, semitones: 1 }, { beat: 0.75, semitones: 0 }] }],
}
assert.match(vm.runInContext('pianoXml(song)', context), /MIDI pitch bend from the written starting pitch/)
assert.match(vm.runInContext('pianoXml(song)', context), /\+1\.000 semitones at \+0\.500 beat/)
context.song = { ...song, piano: [{ ...song.piano[0], midi: 59.98 }] }
assert.match(vm.runInContext('pianoXml(song)', context), /<pitch><step>C<\/step><alter>-0\.02[^<]*<\/alter><octave>4<\/octave><\/pitch>/)
context.song = { ...song, bars: 2, piano: [{ ...song.piano[0], beats: 5 }] }
const tied = vm.runInContext('pianoXml(song)', context)
assert.match(tied, /<tie type="start"\/>/)
assert.match(tied.split('<measure number="2">')[1], /<alter>0\.5<\/alter>.*<tie type="stop"\/>/)
context.song = song

const sources = []
const param = (value = 0) => ({
  value,
  events: [],
  setValueAtTime(next, time) { this.events.push({ value: next, time }) },
})
const ctx = {
  sampleRate: 48000,
  createBufferSource: () => {
    const source = { playbackRate: param(), connect: () => source, start() {}, stop(time) { source.stoppedAt = time } }
    sources.push(source)
    return source
  },
  createOscillator: () => {
    const source = { frequency: param(), setPeriodicWave() {}, connect: () => source, start() {}, stop() {} }
    sources.push(source)
    return source
  },
  createGain: () => ({
    gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
    connect() { return this },
  }),
  createPeriodicWave: () => ({}),
}
context.ctx = ctx
vm.runInContext(`{
  const engine = new Engine(song)
  engine.ctx = ctx
  engine.master = ctx.createGain()
  engine.pianoSamples = [{ midi: 60, soft: { duration: 10 }, loud: { duration: 10 } }]
  engine.track = (node) => node
  engine.piano(1, song.piano[0], 1, 'piano')
  engine.vocal(1, song.vocals[0], 1, 'vocals')
}`, context)
assert.ok(Math.abs(sources[0].playbackRate.value - 2 ** (0.5 / 12)) < 1e-10)
assert.ok(Math.abs(sources[1].frequency.value - 440 * 2 ** ((60.5 - 69) / 12)) < 1e-8)

context.bentSong = {
  bpm: 120, bars: 2, beatsPerBar: 4, beatUnit: 4, tracks: [{ id: 'piano', instrument: 'piano', name: 'Piano' }],
  tempoMap: [{ beat: 0, time: 0 }, { beat: 2, time: 1 }, { beat: 4, time: 3 }],
  chords: [], drums: [], vocals: [], instrumentNotes: {},
  piano: [{
    midi: 60, startBeat: 0, beats: 4, velocity: 0.8,
    pitchBends: [
      { beat: 0.5, semitones: 1 },
      { beat: 2, semitones: -1 },
      { beat: 3, semitones: 0 },
    ],
  }],
}
context.bentVoices = []
vm.runInContext(`{
  const engine = new Engine(bentSong)
  engine.ctx = ctx
  engine.rate = 0.5
  engine.pianoSamples = [{ midi: 60, soft: { duration: 10 }, loud: { duration: 10 } }]
  engine.track = (node, time) => { bentVoices.push({ node, time }) }
  engine.bus = () => ctx.createGain()
  engine.rhythmSource = bentSong
  engine.rhythmInputs = [bentSong.drums, bentSong.piano, bentSong.vocals, bentSong.instrumentNotes,
    bentSong.beatsPerBar, bentSong.beatUnit, bentSong.bars, bentSong.barMap]
  const spb = engine.seconds(1, 1.25) / 0.25
  engine.events(1, 1.25, 10, spb, true)
}`, context)
const sought = context.bentVoices.at(-1).node.playbackRate.events
assert.deepEqual(sought.map(({ time }) => time), [10, 11, 13])
assert.ok(Math.abs(sought[0].value - 2 ** (1 / 12)) < 1e-10, 'seek resumes at the pitch held at the seek beat')
assert.ok(Math.abs(sought[1].value - 2 ** (-1 / 12)) < 1e-10, 'later controller changes use tempo-map and play-rate seconds')
assert.ok(Math.abs(sought[2].value - 1) < 1e-10, 'the controller reset is scheduled on the held voice')

context.allPitchedSong = {
  ...context.bentSong,
  tracks: [
    { id: 'piano', instrument: 'piano', name: 'Piano' },
    { id: 'instrument-organ', instrument: 'other', name: 'Organ' },
    { id: 'instrument-gm', instrument: 'other', name: 'GM instrument', gmProgram: 24 },
    { id: 'instrument-sample', instrument: 'other', name: 'Sample instrument' },
  ],
  vocals: [{ ...context.bentSong.piano[0], pitchBends: [{ beat: 0.5, semitones: 0.5 }, { beat: 1.5, semitones: 0 }] }],
  piano: [{ ...context.bentSong.piano[0], pitchBends: [{ beat: 0.5, semitones: 0.5 }, { beat: 1.5, semitones: 0 }] }],
  instrumentNotes: {
    'instrument-organ': [{ ...context.bentSong.piano[0], pitchBends: [{ beat: 0.5, semitones: 0.5 }, { beat: 1.5, semitones: 0 }] }],
    'instrument-gm': [{ ...context.bentSong.piano[0], pitchBends: [{ beat: 0.5, semitones: 0.5 }, { beat: 1.5, semitones: 0 }] }],
    'instrument-sample': [{ ...context.bentSong.piano[0], pitchBends: [{ beat: 0.5, semitones: 0.5 }, { beat: 1.5, semitones: 0 }] }],
  },
}
const beforePitched = context.bentVoices.length
vm.runInContext(`{
  const engine = new Engine(allPitchedSong)
  engine.ctx = ctx
  engine.pianoSamples = [{ midi: 60, soft: { duration: 10 }, loud: { duration: 10 } }]
  engine.gmSamples.set(24, [{ midi: 60, buffer: { duration: 10 } }])
  engine.track = (node, time) => { bentVoices.push({ node, time }) }
  engine.bus = () => ctx.createGain()
  engine.rhythmSource = allPitchedSong
  engine.rhythmInputs = [allPitchedSong.drums, allPitchedSong.piano, allPitchedSong.vocals, allPitchedSong.instrumentNotes,
    allPitchedSong.beatsPerBar, allPitchedSong.beatUnit, allPitchedSong.bars, allPitchedSong.barMap]
  const spb = engine.seconds(0, 0.25) / 0.25
  engine.events(0, 0.25, 50, spb, false)
}`, context)
const pitchedVoices = context.bentVoices.slice(beforePitched)
assert.equal(pitchedVoices.length, 5, 'piano, vocal, organ, GM sample, and fallback sample all start')
for (const { node } of pitchedVoices) {
  const automation = (node.playbackRate ?? node.frequency).events
  assert.deepEqual(automation.map(({ time }) => time), [50, 50.25, 50.75])
  assert.ok(Math.abs(automation[1].value / automation[0].value - 2 ** (0.5 / 12)) < 1e-10)
  assert.ok(Math.abs(automation[2].value / automation[0].value - 1) < 1e-10)
}

const sampleStops = []
const longBentNote = {
  midi: 60, startBeat: 0, beats: 4,
  pitchBends: [{ beat: 0.5, semitones: -12 }],
}
context.sampleStops = sampleStops
context.longBentNote = longBentNote
vm.runInContext(`{
  const engine = new Engine(bentSong)
  engine.ctx = ctx
  engine.pianoSamples = [{ midi: 60, soft: { duration: 1 }, loud: { duration: 1 } }]
  engine.gmSamples.set(24, [{ midi: 60, buffer: { duration: 1 } }])
  engine.track = (node, time, stop) => { node.stop(stop); sampleStops.push({ node, time, stop }); return node }
  engine.bus = () => ctx.createGain()
  engine.sampleNote(5, 60, 4, 0.8, ctx.createGain(), 0.006, 0.45, false, longBentNote, 0)
  engine.gmNote(5, longBentNote, 4, 0.8, 'gm', 24, 0)
  engine.sampleNote(10, 60, 4, 0.8, ctx.createGain(), 0.006, 0.45, false, { ...longBentNote, pitchBends: [] }, 0)
  engine.gmNote(10, { ...longBentNote, pitchBends: [] }, 4, 0.8, 'gm', 24, 0)
}`, context)
assert.ok(sampleStops[0].stop > sampleStops[0].time + 1, 'a late down-bend must not be cut at the initial sample duration')
assert.ok(sampleStops[1].stop > sampleStops[1].time + 1, 'GM samples must not be cut at the initial playback rate')
assert.equal(sampleStops[2].stop, 11, 'unbent piano samples retain their existing natural-duration stop')
assert.equal(sampleStops[3].stop, 11, 'unbent GM samples retain their existing natural-duration stop')

vm.runInContext(`{
  const engine = new Engine(bentSong)
  engine.ctx = ctx
  engine.rate = 0.5
  engine.pianoSamples = [{ midi: 60, soft: { duration: 10 }, loud: { duration: 10 } }]
  engine.track = (node, time) => { bentVoices.push({ node, time }) }
  engine.bus = () => ctx.createGain()
  engine.rhythmSource = bentSong
  engine.rhythmInputs = [bentSong.drums, bentSong.piano, bentSong.vocals, bentSong.instrumentNotes,
    bentSong.beatsPerBar, bentSong.beatUnit, bentSong.bars, bentSong.barMap]
  const spb = engine.seconds(0, 0.25) / 0.25
  engine.loop = { startBar: 1, endBar: 1 }
  engine.events(0, 0.25, 20, spb, true)
  engine.events(0, 0.25, 30, spb, true)
}`, context)
const loopVoices = context.bentVoices.slice(-2)
const loopStarts = loopVoices.map(({ node }) => node.playbackRate.events)
assert.ok(Math.abs(loopStarts[0][0].value - 1) < 1e-10 && Math.abs(loopStarts[1][0].value - 1) < 1e-10,
  'each loop restart creates a new voice at the written starting pitch, without the prior bend leaking')
assert.equal(loopStarts[0][0].time, 20)
assert.equal(loopStarts[1][0].time, 30)
console.log('Quarter-tone and MIDI bend notation, seek, tempo-map/rate automation, and loop voice reset passed')
