import assert from 'node:assert/strict'
import test from 'node:test'
import {
  phraseSignature, rhythmSignature, inspectPianoScales, inspectPianoProgressions, inspectPianoInspired,
} from './piano-music-check.mjs'

const song = {
  bars: 8, beatsPerBar: 4, bpm: 80,
  piano: [
    {midi: 48, startBeat: 0, beats: 2, hand: 'left', finger: 5},
    {midi: 64, startBeat: 0.5, beats: 0.5, hand: 'right', finger: 1},
    {midi: 67, startBeat: 1.5, beats: 0.25, hand: 'right', finger: 3},
    {midi: 55, startBeat: 2, beats: 1, hand: 'left', finger: 1},
  ],
}

test('transposition, tempo, spelling, velocity, fingering, and note order do not disguise copied music', () => {
  const disguised = {...song, bpm: 140, piano: [...song.piano].reverse().map(note => ({
    ...note, midi: note.midi + 7, finger: 2, velocity: 90, spell: 'D',
  }))}
  assert.equal(phraseSignature(song), phraseSignature(disguised))
})

test('real rhythm, duration, voicing, and hand interaction changes produce different signatures', () => {
  for (const changed of [
    {startBeat: 0.75}, {beats: 0.25}, {midi: 65}, {hand: 'left'},
  ]) {
    const different = {...song, piano: song.piano.map((note, index) => index === 1 ? {...note, ...changed} : note)}
    assert.notEqual(phraseSignature(song), phraseSignature(different))
  }
})

test('phrase windows normalize time and pitch but retain the phrase contour', () => {
  const repeated = {...song, piano: [
    ...song.piano,
    ...song.piano.map(note => ({...note, startBeat: note.startBeat + 8, midi: note.midi + 12})),
  ]}
  assert.equal(phraseSignature(repeated, 0, 8), phraseSignature(repeated, 8, 16))
})

test('changed harmony alone does not disguise a reused two-hand rhythmic motif', () => {
  const reharmonized = {...song, piano: song.piano.map((note, index) => ({...note, midi: note.midi + index * 2}))}
  assert.notEqual(phraseSignature(song), phraseSignature(reharmonized))
  assert.equal(rhythmSignature(song), rhythmSignature(reharmonized))
  const varied = {...song, piano: song.piano.map((note, index) => index === 1 ? {...note, startBeat: 0.75} : note)}
  assert.notEqual(rhythmSignature(song), rhythmSignature(varied))
})

const intervals = {
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10], 'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
  'melodic-minor': [0, 2, 3, 5, 7, 9, 11], 'major-pentatonic': [0, 2, 4, 7, 9],
  'minor-pentatonic': [0, 3, 5, 7, 10], blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'whole-tone': [0, 2, 4, 6, 8, 10],
  diminished: [0, 1, 3, 4, 6, 7, 9, 10],
}
const spell = midi => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][midi % 12]
function scaleCases() {
  return Object.entries(intervals).flatMap(([family, up]) => Array.from({length: 12}, (_, pitch) =>
    Array.from({length: 3}, (_, variant) => {
      const down = family === 'melodic-minor' ? intervals.minor : up
      const octaves = family === 'chromatic' ? [0] : [0, 12]
      const offsets = [...octaves.flatMap(octave => up.map(value => octave + value)), octaves.length * 12,
        ...[...octaves].reverse().flatMap(octave => [...down].reverse().map(value => octave + value))]
      const bars = Math.ceil(offsets.length / 8)
      const tonic = spell(pitch)
      const degreeSpell = (offset, index) => {
        if (up.length !== 7) return spell(offset + pitch)
        const letters = 'CDEFGAB'
        const peakIndex = up.length * octaves.length
        const degree = (index <= peakIndex ? index : offsets.length - 1 - index) % 7
        const letter = letters[(letters.indexOf(tonic[0]) + degree) % 7]
        const natural = {C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11}[letter]
        let alteration = (offset + pitch - natural + 12) % 12
        if (alteration > 6) alteration -= 12
        return letter + (alteration < 0 ? 'b'.repeat(-alteration) : '#'.repeat(alteration))
      }
      const hands = variant === 0 ? ['right'] : variant === 1 ? ['left'] : ['left', 'right']
      const piano = hands.flatMap(hand => offsets.map((offset, index) => {
        const midi = (hand === 'right' ? 60 : 48) + pitch + offset
        return {hand, midi, startBeat: index / 2, beats: index === offsets.length - 1 ? bars * 4 - index / 2 : 0.5,
          finger: index === 0 && family === 'major' && [1, 3, 6, 8, 10].includes(pitch) ? 2 : index % 5 + 1,
          spell: degreeSpell(offset, index)}
      }))
      const minorFamilies = ['minor', 'dorian', 'phrygian', 'locrian', 'harmonic-minor',
        'melodic-minor', 'minor-pentatonic', 'blues', 'diminished']
      return {id: `${family}:${pitch}:${variant}`, family, pitch, variant,
        song: {bars, beatsPerBar: 4, piano, key: {tonic, mode: minorFamilies.includes(family) ? 'minor' : 'major'}}}
    })).flat())
}

test('all 540 generated scale combinations have the independently specified intervals and hand shape', () => {
  const cases = scaleCases()
  assert.equal(inspectPianoScales(cases).cases, 540)
  for (const mutate of [
    cases => { cases[0].song.piano[1].midi++ },
    cases => { cases[0].song.piano[1].spell = 'E' },
    cases => { cases.find(entry => entry.family === 'major' && entry.pitch === 1 && entry.variant === 0).song.piano[0].finger = 1 },
    cases => { cases.find(entry => entry.family === 'melodic-minor').song.piano[15].midi++ },
    cases => { cases[0].song.piano[1].startBeat = 0.75 },
    cases => { cases[0].song.piano[1].beats = 1 },
    cases => { cases[0].song.piano.at(-1).beats = 0.5 },
    cases => { cases[0].song.key.tonic = 'D' },
    cases => { cases.find(entry => entry.family === 'dorian').song.key.mode = 'major' },
    cases => { cases[0].song.piano[1].spell = 'Ebb' },
  ]) {
    const changed = structuredClone(cases)
    mutate(changed)
    assert.throws(() => inspectPianoScales(changed))
  }
})

function progressionCases() {
  const patterns = {
    major: [[0, 5, 7, 0], [0, 9, 5, 7], [2, 7, 0, 0], [0, 7, 9, 5], [0, 9, 2, 7],
      [0, 10, 5, 0], [0, 5, 7, 5], [0, 4, 5, 7], [0, 7, 9, 4, 5, 0, 5, 7], null],
    minor: [[0, 5, 7, 0], [0, 8, 3, 10], [0, 5, 10, 3], [0, 5, 7, 0], [0, 10, 8, 10],
      [0, 10, 8, 7], [2, 7, 0, 0], [0, 5, 0, 5]],
  }
  const qualities = {
    major: [['M', 'M', 'M', 'M'], ['M', 'm', 'M', 'M'], ['m7', '7', 'maj7', 'maj7'],
      ['M', 'M', 'm', 'M'], ['M', 'm', 'm', 'M'], ['M', 'M', 'M', 'M'],
      ['M', 'M', 'M', 'M'], ['M', 'm', 'M', 'M'], ['M', 'M', 'm', 'm', 'M', 'M', 'M', 'M'], null],
    minor: [['m', 'm', 'm', 'm'], ['m', 'M', 'M', 'M'], ['m', 'm', 'M', 'M'],
      ['m', 'm', 'M', 'm'], ['m', 'M', 'M', 'M'], ['m', 'M', 'M', 'M'],
      ['m7b5', '7', 'm', 'm'], ['m7', '7', 'm7', '7']],
  }
  const tonesByQuality = {
    M: [0, 4, 7], m: [0, 3, 7], maj7: [0, 4, 7, 11],
    m7: [0, 3, 7, 10], 7: [0, 4, 7, 10], m7b5: [0, 3, 6, 10],
  }
  return Object.entries(patterns).flatMap(([mode, variants]) => variants.flatMap((pattern, variant) =>
    Array.from({length: 12}, (_, pitch) => {
      const bars = pattern ? 16 : 24
      const piano = [], chordLabels = [], chords = []
      for (let bar = 0; bar < bars; bar++) {
        const phrase = Math.floor(bar / 4) % 4
        const indices = !pattern ? [bar % 12] : pattern.length === 8 ? [bar % 8] :
          bar >= 8 && bar < 12 ? [((bar - 8) * 2) % pattern.length, ((bar - 8) * 2 + 1) % pattern.length] :
          [bar % pattern.length]
        const symbols = []
        for (const [half, index] of indices.entries()) {
          const root = pattern ? pattern[index] : [0, 0, 0, 0, 5, 5, 0, 0, 7, 5, 0, 7][index]
          const quality = pattern ? qualities[mode][variant][index] : '7'
          const startBeat = bar * 4 + half * 4 / indices.length
          const symbol = spell((pitch + root) % 12) + (quality === 'M' ? '' : quality)
          symbols.push(symbol)
          chordLabels.push({symbol, startBeat, beats: 4 / indices.length})
          const bass = 36 + pitch + root
          piano.push({hand: 'left', midi: bass, startBeat, beats: 1, finger: 5, spell: spell(bass)})
          for (const tone of tonesByQuality[quality]) {
            const midi = 60 + pitch + root + tone
            piano.push({hand: 'right', midi, startBeat: startBeat + phrase / 2,
              beats: [2, 0.5, 1, 0.5][phrase], finger: 2, spell: spell(midi)})
          }
        }
        chords.push(symbols.join(' '))
      }
      const pickup = 36 + pitch + (pattern?.[0] ?? 0) + 1
      piano.push({hand: 'left', midi: pickup, startBeat: bars * 4 - 1, beats: 1, finger: 2, spell: spell(pickup)})
      const pedaled = variant % 2 === 0
      const pedals = pedaled ? chordLabels.map(label => ({
        controller: 64, startBeat: label.startBeat + 0.25, beats: label.beats - 0.5,
      })) : []
      return {id: `${mode}:${variant}:${pitch}`, mode, variant, pitch, chords, title: `Progression in ${spell(pitch)} ${mode}`,
        hands: pedaled ? 'Right foot: sustain pedal' : 'Both hands',
        song: {bars, beatsPerBar: 4, piano, chordLabels, pedals, key: {tonic: spell(pitch), mode}}}
    })))
}

test('all 216 keyed progressions verify roots, chord qualities and developed phrases', () => {
  const cases = progressionCases()
  assert.equal(inspectPianoProgressions(cases).cases, 216)
  const wrongRoot = structuredClone(cases)
  const bass = wrongRoot[0].song.piano.find(note => note.hand === 'left' && note.startBeat === 4)
  bass.midi++
  bass.spell = spell(bass.midi)
  assert.throws(() => inspectPianoProgressions(wrongRoot))
  const wrongDominant = structuredClone(cases)
  const natural = wrongDominant.find(entry => entry.mode === 'minor' && entry.variant === 0 && entry.pitch === 0)
  const minorThird = natural.song.piano.find(note => note.hand === 'right' && note.startBeat === 8 && note.midi % 12 === 10)
  minorThird.midi++
  minorThird.spell = spell(minorThird.midi)
  assert.throws(() => inspectPianoProgressions(wrongDominant))
  const wrongDiminished = structuredClone(cases)
  const ii = wrongDiminished.find(entry => entry.mode === 'minor' && entry.variant === 6 && entry.pitch === 0)
  const fifth = ii.song.piano.find(note => note.hand === 'right' && note.startBeat === 0 && note.midi % 12 === 8)
  fifth.midi++
  fifth.spell = spell(fifth.midi)
  assert.throws(() => inspectPianoProgressions(wrongDiminished))
  const wrongDorian = structuredClone(cases)
  const dorian = wrongDorian.find(entry => entry.mode === 'minor' && entry.variant === 7 && entry.pitch === 0)
  const raisedSixth = dorian.song.piano.find(note => note.hand === 'right' && note.startBeat === 4 && note.midi % 12 === 9)
  raisedSixth.midi--
  raisedSixth.spell = spell(raisedSixth.midi)
  assert.throws(() => inspectPianoProgressions(wrongDorian))
})

test('progressions reject padded or repeated phrases and an incomplete Canon cycle', () => {
  const cases = progressionCases()
  for (const mutate of [
    cases => { cases[0].song.bars = 8 },
    cases => { cases[0].song.key.tonic = 'D' },
    cases => { cases[0].title += ' as in Example Song' },
    cases => { cases[0].chords[8] = 'C G' },
    cases => { cases[0].song.chordLabels[8].beats = 4 },
    cases => { cases[0].song.pedals = [] },
    cases => { cases[0].song.pedals[8].beats = 3.5 },
    cases => { cases[0].song.pedals[0].controller = 67 },
    cases => {
      const bass = cases[0].song.piano.find(note => note.hand === 'left' && note.startBeat === 34)
      bass.midi++
      bass.spell = spell(bass.midi)
    },
    cases => {
      const part = cases[0].song
      part.piano = [...part.piano.filter(note => note.startBeat < 16 || note.startBeat >= 32),
        ...part.piano.filter(note => note.startBeat < 16).map(note => ({...note, startBeat: note.startBeat + 16}))]
    },
    cases => {
      const blues = cases.find(entry => entry.mode === 'major' && entry.variant === 9).song
      blues.piano = [...blues.piano.filter(note => note.startBeat < 48 || note.startBeat === 95),
        ...blues.piano.filter(note => note.startBeat < 48).map(note => ({...note, startBeat: note.startBeat + 48}))]
    },
    cases => {
      const canon = cases.find(entry => entry.mode === 'major' && entry.variant === 8)
      const root = canon.song.piano.find(note => note.hand === 'left' && note.startBeat === 32)
      root.midi++
      root.spell = spell(root.midi)
    },
  ]) {
    const changed = structuredClone(cases)
    mutate(changed)
    assert.throws(() => inspectPianoProgressions(changed))
  }
})

test('inspired studies reject relabelled transposed parts and tiled two-bar motifs', () => {
  const ids = [
    ...Array.from({length: 9}, (_, index) => `piano-inspired-hans-zimmer-${index}`),
    ...Array.from({length: 2}, (_, index) => `piano-inspired-pink-floyd-${index}`),
    ...Array.from({length: 2}, (_, index) => `piano-inspired-coldplay-${index}`),
    ...Array.from({length: 22}, (_, index) => `piano-inspired-other-${index}`),
  ]
  const studies = ids.map((id, index) => ({
    id, song: {bars: 8, beatsPerBar: 4, piano: Array.from({length: 8}, (_, bar) => [
      {hand: 'left', midi: 48 + bar % 5, startBeat: bar * 4, beats: 1, finger: 5},
      {hand: 'right', midi: 60, startBeat: bar * 4 + 1, beats: 0.5, finger: 1},
      {hand: 'right', midi: 61 + index + bar % 3, startBeat: bar * 4 + 2, beats: 0.5, finger: 3},
    ]).flat()},
  }))
  assert.deepEqual(inspectPianoInspired(studies).collisions, [])
  const duplicated = structuredClone(studies)
  duplicated[1].song = {...duplicated[0].song, piano: duplicated[0].song.piano.map(note => ({...note, midi: note.midi + 5}))}
  assert.ok(inspectPianoInspired(duplicated).collisions.some(collision => collision.kind === 'full'))
  const tiled = structuredClone(studies)
  tiled[0].song.piano = Array.from({length: 4}, (_, section) => studies[0].song.piano.filter(note => note.startBeat < 8)
    .map(note => ({...note, startBeat: note.startBeat + section * 8}))).flat()
  assert.deepEqual(inspectPianoInspired(tiled).repeatedLoops, [ids[0]])
})
