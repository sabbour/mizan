import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/workspace/engine.ts', import.meta.url), 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const timers = []

class FakeMedia {
  attributes = new Set()
  listeners = new Map()
  paused = true
  currentTime = 0
  playbackRate = 1
  pauseCount = 0

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  hasAttribute(name) { return this.attributes.has(name) }
  setAttribute(name) { this.attributes.add(name) }
  removeAttribute(name) { this.attributes.delete(name) }
  pause() { this.paused = true; this.pauseCount++ }
  emit(type) { for (const listener of this.listeners.get(type) ?? []) listener() }
}

class FakeRecording {
  constructor() { this.media = new FakeMedia() }
  async prepare() {}
  dispose() {}
}

class FakeNode {
  gain = { value: 1, setTargetAtTime() {} }
  threshold = { value: 0 }
  knee = { value: 0 }
  ratio = { value: 0 }
  connect() { return this }
}

class FakeAudioContext {
  state = 'running'
  currentTime = 0
  destination = {}
  createGain() { return new FakeNode() }
  createDynamicsCompressor() { return new FakeNode() }
}

const module = { exports: {} }
const context = {
  module,
  exports: module.exports,
  AudioContext: FakeAudioContext,
  window: {
    setTimeout: (callback, delay) => {
      const timer = { callback, delay }
      timers.push(timer)
      return timer
    },
    setInterval: () => 1,
  },
  clearInterval() {},
  clearTimeout() {},
  require(name) {
    if (name === './recording') return { Recording: FakeRecording }
    if (name === './song') return { sustainedChords: () => [] }
    throw new Error(`Unexpected runtime import: ${name}`)
  },
}
vm.runInNewContext(output, context)
const { Engine } = module.exports
const song = { bpm: 120, bars: 247, beatsPerBar: 4, piano: [] }
const stems = [{ id: 'mix', label: 'Mock recording', url: 'mock:mix' }]

function runningEngine() {
  const engine = new Engine(song, stems)
  engine.ensure()
  engine.timer = 1
  engine.pausedBeat = 468
  const errors = []
  engine.onError = (message) => errors.push(message)
  return { engine, errors, media: engine.recording.media }
}

const muted = runningEngine()
muted.engine.muted.add('stem:mix')
muted.media.emit('error')
assert.equal(muted.engine.playing, true, 'An inactive recording error does not stop Synth playback')
assert.equal(muted.engine.read().beat, 468, 'An inactive recording error preserves the current beat')
assert.deepEqual(muted.errors, [], 'An inactive recording error is not reported')
assert.equal(muted.media.pauseCount, 0, 'An inactive recording error does not pause media')

const zeroVolume = runningEngine()
zeroVolume.engine.trackGains.set('stem:mix', 0)
zeroVolume.media.emit('error')
assert.equal(zeroVolume.engine.playing, true, 'A zero-volume recording error does not stop Synth playback')
assert.deepEqual(zeroVolume.errors, [], 'A zero-volume recording error is not reported')

const active = runningEngine()
active.media.setAttribute('src')
active.media.emit('error')
assert.equal(active.engine.playing, false, 'An active recording error stops playback')
assert.equal(active.engine.read().beat, 468, 'An active recording error preserves the current beat')
assert.deepEqual(active.errors, ['The recording could not be read. Try playing again.'])

const stale = runningEngine()
stale.media.setAttribute('src')
let rejectPlay
stale.media.play = () => new Promise((_, reject) => { rejectPlay = reject })
stale.engine.scheduleMedia(0, 0)
timers.shift().callback()
stale.media.removeAttribute('src')
rejectPlay(new Error('Stale recording playback failure'))
await new Promise((resolve) => setImmediate(resolve))
assert.equal(stale.engine.playing, true, 'A stale media.play rejection after muting does not stop Synth playback')
assert.deepEqual(stale.errors, [], 'A stale media.play rejection after muting is not reported')

console.log('Playback error checks passed: inactive and zero-volume stems, active recording failure, and stale media.play rejection.')
