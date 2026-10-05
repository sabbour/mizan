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
context.song = { ...song, piano: [{ ...song.piano[0], midi: 59.98 }] }
assert.match(vm.runInContext('pianoXml(song)', context), /<pitch><step>C<\/step><alter>-0\.02[^<]*<\/alter><octave>4<\/octave><\/pitch>/)
context.song = { ...song, bars: 2, piano: [{ ...song.piano[0], beats: 5 }] }
const tied = vm.runInContext('pianoXml(song)', context)
assert.match(tied, /<tie type="start"\/>/)
assert.match(tied.split('<measure number="2">')[1], /<alter>0\.5<\/alter>.*<tie type="stop"\/>/)
context.song = song

const sources = []
const ctx = {
  sampleRate: 48000,
  createBufferSource: () => {
    const source = { playbackRate: { value: 0 }, connect: () => source, start() {}, stop() {} }
    sources.push(source)
    return source
  },
  createOscillator: () => {
    const source = { frequency: { value: 0 }, setPeriodicWave() {}, connect: () => source, start() {}, stop() {} }
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
vm.runInContext(`
  const engine = new Engine(song)
  engine.ctx = ctx
  engine.master = ctx.createGain()
  engine.pianoSamples = [{ midi: 60, soft: { duration: 10 }, loud: { duration: 10 } }]
  engine.track = (node) => node
  engine.piano(1, song.piano[0], 1, 'piano')
  engine.vocal(1, song.vocals[0], 1, 'vocals')
`, context)
assert.ok(Math.abs(sources[0].playbackRate.value - 2 ** (0.5 / 12)) < 1e-10)
assert.ok(Math.abs(sources[1].frequency.value - 440 * 2 ** ((60.5 - 69) / 12)) < 1e-8)
console.log('Quarter-tone notation and WebAudio piano/vocal frequency passed')
