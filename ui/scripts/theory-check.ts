// Run from the repository root: node --experimental-strip-types ui\scripts\theory-check.ts
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { alternatives, chordTones } from '../src/workspace/harmonize.ts'
import { finger } from '../src/workspace/fingering.ts'
import type { Chord, PianoNote, Song } from '../src/workspace/song.ts'

function song(symbols: (string | null)[], key: Song['key'] = { tonic: 'C', mode: 'major' }): Song {
  const chords: Chord[] = symbols.map((symbol, i) => ({
    symbol, startBeat: i * 4, beats: 4, numeral: null,
    role: symbol === 'G' || symbol === 'G7' ? 'dominant' : null,
    tones: symbol ? chordTones(symbol) : [], flats: false, confidence: 1,
  }))
  return {
    title: 'Theory check', source: 'Synthetic', bpm: 100, beatsPerBar: 4, bars: symbols.length,
    key, chords, piano: [], drums: [], tracks: [], sections: [], confidence: { piano: [], drums: [] },
  }
}

function notes(pitches: number[], hand: PianoNote['hand'] = 'right', chord = false): PianoNote[] {
  return pitches.map((midi, i) => ({ midi, hand, startBeat: chord ? 0 : i, beats: 1 }))
}

const tonic = alternatives(song(['C']), 0)
assert(tonic.some((a) => a.symbol === 'Am' && a.numeral === 'vi' && a.kind === 'substitute'))
assert(!tonic.some((a) => a.symbol === 'C'))
assert.equal(new Set(tonic.map((a) => a.kind)).size, 3)
assert(alternatives(song(['G7', 'C']), 0).some((a) => a.symbol === 'Db7' && a.numeral === 'bII7' && a.kind === 'tritone'))
assert(alternatives(song(['G', 'Am']), 0).some((a) => a.symbol === 'E7' && a.numeral === 'V/vi' && a.kind === 'secondary'))
assert(alternatives(song(['F']), 0).some((a) => a.symbol === 'Fm' && a.numeral === 'iv' && a.kind === 'borrowed'))
assert(!alternatives(song(['F', 'C']), 0, 99).some((a) => a.kind === 'secondary'))
assert(alternatives(song(['Am'], { tonic: 'A', mode: 'minor' }), 0).some((a) => a.symbol === 'A' && a.kind === 'borrowed'))
assert(alternatives(song(['Dm'], { tonic: 'A', mode: 'minor' }), 0).some((a) => a.symbol === 'D' && a.numeral === 'IV'))
assert(alternatives(song(['F#m'], { tonic: 'F#', mode: 'minor' }), 0).some((a) => a.symbol === 'F#' && a.numeral === 'I'))
const unlabelledDominant = song(['G', 'C'])
unlabelledDominant.chords[0].role = null
assert(alternatives(unlabelledDominant, 0).some((a) => a.symbol === 'Db7' && a.kind === 'tritone'))
for (const [symbol, expected] of [['C', 'Em'], ['F', 'Dm'], ['G', 'Bdim'], ['G', 'Em']]) {
  assert(alternatives(song([symbol]), 0, 99).some((a) => a.symbol === expected && a.kind === 'substitute'))
}
for (const symbol of ['Fm', 'Ab', 'Bb', 'Ddim']) {
  assert(alternatives(song(['C']), 0, 99).some((a) => a.symbol === symbol && a.kind === 'borrowed' && a.flats))
}
assert.deepEqual(alternatives(song([null, 'N.C.']), 0), [])
assert.deepEqual(alternatives(song([null, 'N.C.']), 1), [])
assert.deepEqual(alternatives(song(['C']), 9), [])
assert.deepEqual(alternatives(song(['C']), 0, 0), [])
assert.equal(alternatives(song(['C']), 0, 1).length, 1)
assert(alternatives(song(['C'], null), 0).every((a) => a.kind === 'color' && a.numeral === null))
assert(alternatives(song(['Bb'], { tonic: 'Bb', mode: 'major' }), 0, 99).every((a) => a.flats))
const qualities: Record<string, number[]> = {
  '': [0, 4, 7], m: [0, 3, 7], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11], dim: [0, 3, 6], m7b5: [0, 3, 6, 10],
  sus2: [0, 2, 7], sus4: [0, 5, 7], add9: [0, 2, 4, 7], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9],
}
for (const [quality, intervals] of Object.entries(qualities)) {
  assert.deepEqual(chordTones(`C${quality}`), intervals.map((n) => n + 60))
}
assert.deepEqual(chordTones('Bb'), [58, 62, 65])
assert.deepEqual(chordTones('Cb'), [59, 63, 66])
assert.throws(() => chordTones('Cunknown'), RangeError)
const originalSong = song(['G', 'Am'])
const snapshot = structuredClone(originalSong)
alternatives(originalSong, 0)
assert.deepEqual(originalSong, snapshot)
const withMelody = song(['C'])
withMelody.piano = [{ midi: 65, startBeat: -1, beats: 5, hand: 'right' }]
const ranked = alternatives(withMelody, 0, 99)
assert(ranked.findIndex((a) => a.symbol === 'Csus4') < ranked.findIndex((a) => a.symbol === 'Cmaj7'))
const baseline = alternatives(song(['C']), 0)
for (const note of [
  { midi: 65, startBeat: -1, beats: 1, hand: 'right' },
  { midi: 65, startBeat: 4, beats: 1, hand: 'right' },
  { midi: 65, startBeat: 0, beats: 4, hand: 'left' },
] satisfies PianoNote[]) {
  withMelody.piano = [note]
  assert.deepEqual(alternatives(withMelody, 0), baseline)
}
console.log('Harmonization: substitutions, borrowing, secondary/tritone, colors, melody overlap, spelling OK')

assert.deepEqual(finger(notes([60, 62, 64, 65, 67])).map((n) => n.finger), [1, 2, 3, 4, 5])
const scale = [60, 62, 64, 65, 67, 69, 71, 72]
const scaleFingers = finger(notes(scale)).map((n) => n.finger)
assert.deepEqual(scaleFingers, [1, 2, 3, 1, 2, 3, 4, 5])
assert.deepEqual(finger(notes([48, 52, 55], 'left', true)).map((n) => n.finger), [5, 3, 1])
assert.deepEqual(finger(notes([60, 64, 67], 'right', true)).map((n) => n.finger), [1, 3, 5])
assert.deepEqual(finger(notes([60, 64, 67, 71], 'right', true)).map((n) => n.finger), [1, 2, 3, 5])
assert.deepEqual(finger(notes([48, 52, 55, 59], 'left', true)).map((n) => n.finger), [5, 4, 3, 1])
assert.deepEqual(finger([]), [])
const simultaneous = notes([55, 48, 52], 'left', true)
simultaneous[0].startBeat = 0.01
assert.deepEqual(finger(simultaneous).map((n) => n.finger), [1, 5, 3])
const mixed = [...notes(scale), ...notes([48, 52, 55], 'left', true)].reverse()
const untouched = structuredClone(mixed)
assert.deepEqual(finger(mixed), finger(mixed))
assert.deepEqual(mixed, untouched)
assert.deepEqual(finger(mixed).map(({ finger, ...note }) => { assert.ok(finger); return note }), mixed)
assert.deepEqual(finger(mixed).filter((n) => n.hand === 'right').map((n) => n.finger), [...scaleFingers].reverse())
const bounded = [...notes([60, 64, 67], 'right', true), { midi: 69, startBeat: 1, beats: 1, hand: 'right' } satisfies PianoNote]
assert.notEqual(finger(bounded)[3].finger, 5)
assert(finger(notes([61, 63, 65])).every((n) => n.midi === 65 || n.finger !== 1))
assert.deepEqual(finger(notes([60, 60, 60])).map((n) => n.finger), [1, 1, 1])
assert.deepEqual(finger(notes([67, 65, 64, 62, 60])).map((n) => n.finger), [5, 4, 3, 2, 1])
assert.deepEqual(finger(notes([48, 50, 52, 53, 55], 'left')).map((n) => n.finger), [5, 4, 3, 2, 1])
console.log(`Fingering: RH five-note 1-2-3-4-5; RH scale ${scaleFingers.join('-')}; LH triad 5-3-1; grouping/order/DP OK`)

const workload = Array.from({ length: 500 }, (_, i): PianoNote => ({
  midi: scale[i % scale.length], startBeat: i * 0.25, beats: 0.25, hand: 'right',
}))
for (let i = 0; i < 20; i++) finger(workload)
const times: number[] = []
for (let i = 0; i < 101; i++) {
  const start = performance.now()
  finger(workload)
  times.push(performance.now() - start)
}
times.sort((a, b) => a - b)
const median = times[Math.floor(times.length / 2)]
assert(median < 5, `500-note median ${median.toFixed(3)} ms exceeds 5 ms`)
console.log(`Performance: 500 notes median ${median.toFixed(3)} ms (<5 ms), p95 ${times[95].toFixed(3)} ms`)
console.log('All theory checks passed.')
