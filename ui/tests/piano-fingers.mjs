// Run from ui\: node tests\piano-fingers.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'

globalThis.matchMedia = () => ({ matches: false })
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { suggestFingers, pedalCarries, keyOf } = await vite.ssrLoadModule('/src/workspace/fingers.ts')
  const { repairPiano } = await vite.ssrLoadModule('/src/workspace/playability.ts')
  const { buildPianoHandPlan } = await vite.ssrLoadModule('/src/workspace/pianoHands.ts')

  const line = (midis, hand, { step = 0.5, beats = step, start = 0 } = {}) =>
    midis.map((midi, index) => ({ midi, hand, startBeat: start + index * step, beats }))
  const fingersOf = (notes, pedals, options) => {
    const result = suggestFingers(notes, pedals, options)
    return notes.map((note) => result.get(note)?.finger)
  }
  const BLACK = new Set([1, 3, 6, 8, 10])
  const dump = process.env.DUMP

  // ---- Scales: the thumb passes under (right hand up, left hand down) and a finger passes over the thumb the other way.
  const cMajor = [60, 62, 64, 65, 67, 69, 71, 72]
  assert.deepEqual(fingersOf(line(cMajor, 'right'), undefined), [1, 2, 3, 1, 2, 3, 4, 5], 'C major up, right hand: thumb under after the third finger')
  assert.deepEqual(fingersOf(line(cMajor.map((m) => m - 24), 'left'), undefined), [5, 4, 3, 2, 1, 3, 2, 1], 'C major up, left hand: third finger over the thumb')
  assert.deepEqual(fingersOf(line([...cMajor].reverse(), 'right'), undefined), [5, 4, 3, 2, 1, 3, 2, 1], 'C major down, right hand: third finger over the thumb')
  assert.deepEqual(fingersOf(line([...cMajor].reverse().map((m) => m - 24), 'left'), undefined), [1, 2, 3, 1, 2, 3, 4, 5], 'C major down, left hand: thumb under')
  assert.deepEqual(buildPianoHandPlan(line(cMajor, 'right'), () => true).right.map((event) => event.finger),
    [1, 2, 3, 1, 2, 3, 4, 5], 'legal thumb-under transitions remain in the animated plan')

  // ---- Arpeggio and chords.
  if (dump) console.log('arpeggio', fingersOf(line([60, 64, 67, 72, 76, 79, 84], 'right'), undefined))
  const triad = [60, 64, 67].map((midi) => ({ midi, hand: 'right', startBeat: 0, beats: 1 }))
  const lowTriad = [48, 52, 55].map((midi) => ({ midi, hand: 'left', startBeat: 0, beats: 1 }))
  assert.deepEqual(fingersOf(triad), [1, 3, 5], 'a right-hand triad is 1-3-5')
  assert.deepEqual(fingersOf(lowTriad), [5, 3, 1], 'a left-hand triad is 5-3-1')
  // Textbook arpeggios: one octave needs no crossing; two octaves turn the thumb under once, pinky only at the top.
  assert.deepEqual(fingersOf(line([60, 64, 67, 72], 'right')), [1, 2, 3, 5], 'one-octave C arpeggio, right hand: 1-2-3-5')
  assert.deepEqual(fingersOf(line([60, 64, 67, 72, 76, 79, 84], 'right')), [1, 2, 3, 1, 2, 3, 5], 'two-octave C arpeggio, right hand: 1-2-3-1-2-3-5')
  // Alberti bass keeps the hand still: the outer notes on 1 and 5, the middle on 3.
  assert.deepEqual(fingersOf(line([48, 55, 52, 55, 48, 55, 52, 55], 'left')), [5, 1, 3, 1, 5, 1, 3, 1], 'left-hand Alberti bass: 5-1-3-1')
  assert.deepEqual(fingersOf(line([60, 67, 64, 67, 60, 67, 64, 67], 'right')), [1, 5, 3, 5, 1, 5, 3, 5], 'right-hand Alberti bass: 1-5-3-5')
  const fourth = [60, 64, 67, 72].map((midi) => ({ midi, hand: 'right', startBeat: 0, beats: 1 }))
  assert.deepEqual(fingersOf(fourth), [1, 2, 3, 5], 'a four-note chord with an octave top is 1-2-3-5')
  assert.deepEqual(fingersOf([60, 62, 64, 65, 67].map((midi) => ({ midi, hand: 'right', startBeat: 0, beats: 1 }))), [1, 2, 3, 4, 5], 'five keys use every finger')

  // ---- Black keys: the thumb stays off them where a white-key option exists (F-sharp major, and a D-flat arpeggio).
  const fSharp = line([66, 68, 70, 71, 73, 75, 77, 78], 'right')
  const fSharpFingers = fingersOf(fSharp)
  assert.deepEqual(fSharpFingers, [2, 3, 4, 1, 2, 3, 1, 2], 'F-sharp major, right hand: the usual 2-3-4 on the black keys')
  const blackRun = line([61, 63, 65, 66, 68, 70, 72, 73], 'right')
  fingersOf(blackRun).forEach((finger, i) => {
    if (BLACK.has(Math.round(blackRun[i].midi) % 12)) assert.ok(finger !== 1, `the thumb is not on black key ${blackRun[i].midi}`)
  })
  const flatArp = line([61, 65, 68, 73], 'right')
  fingersOf(flatArp).forEach((finger, i) => {
    if (BLACK.has(flatArp[i].midi % 12)) assert.ok(finger !== 1 && finger !== 5 || i === 3, 'black keys take long fingers where they can')
  })

  // ---- Held notes block their fingers unless a pedal carries them.
  const heldLow = { midi: 57, startBeat: 0, beats: 3, hand: 'right' }
  const leap = { midi: 72, startBeat: 1, beats: 1, hand: 'right' }
  const near = { midi: 62, startBeat: 2, beats: 1, hand: 'right' }
  const passage = [heldLow, leap, near]
  const plain = suggestFingers(passage)
  assert.equal(plain.get(heldLow).finger, 1)
  assert.equal(plain.get(leap), undefined, 'without a pedal a leap past a held note gets no impossible suggestion')
  assert.ok(plain.get(near).finger > 1, 'a note within reach of the held thumb takes another finger')
  const sustain = [{ controller: 64, startBeat: 0.5, beats: 3 }]
  const pedalled = suggestFingers(passage, sustain)
  assert.ok(pedalled.get(leap), 'with the sustain pedal carrying the held note the hand may leap')
  assert.ok(pedalled.get(near), 'and the next note is still fingered')
  assert.equal(suggestFingers(passage, [{ controller: 67, startBeat: 0.5, beats: 3 }]).get(leap), undefined, 'the soft pedal changes nothing')
  assert.ok(suggestFingers(passage, [{ controller: 66, startBeat: 0.5, beats: 3 }]).get(leap), 'a sostenuto pressed while the note is down carries it')
  assert.equal(suggestFingers(passage, [{ controller: 66, startBeat: -1, beats: 5 }]).get(leap), undefined, 'a sostenuto pressed before the note was struck does not')
  assert.equal(suggestFingers(passage, [{ controller: 64, startBeat: 1.5, beats: 3 }]).get(leap), undefined, 'a sustain pedal that goes down after the leap does not help it')
  assert.equal(suggestFingers(passage, [{ controller: 64, startBeat: 0.5, beats: 1 }]).get(leap), undefined, 'a pedal that lifts well before the note ends does not carry it')
  assert.ok(pedalCarries(sustain, 0, 3, 1) && !pedalCarries(undefined, 0, 3, 1), 'pedalCarries follows the written pedals')

  // The pedal frees a finger as well as the hand: a melody over a held bass reuses the bass note's finger.
  const bass = { midi: 48, startBeat: 0, beats: 4, hand: 'left' }
  const melody = line([52, 55, 57, 59], 'left', { start: 1, step: 1 })
  const freeBass = suggestFingers([bass, ...melody], [{ controller: 64, startBeat: 0.25, beats: 3.75 }])
  assert.ok([bass, ...melody].every((note) => freeBass.get(note)), 'every note is fingered when the pedal carries the bass')

  // ---- Repeated notes: the same finger when slow, alternating when fast.
  assert.deepEqual(fingersOf(line([60, 60, 60, 60], 'right', { step: 1 }), undefined, { bpm: 90 }), [1, 1, 1, 1], 'slow repeated notes keep one finger')
  const quick = fingersOf(line([60, 60, 60, 60], 'right', { step: 0.25 }), undefined, { bpm: 120 })
  assert.ok(quick.every((finger, i) => i === 0 || finger !== quick[i - 1]), 'quick repeated notes alternate fingers')

  // ---- Limits: no confident suggestion for what one hand cannot hold.
  const six = [60, 62, 64, 65, 67, 69].map((midi) => ({ midi, hand: 'right', startBeat: 0, beats: 2 }))
  const wide = [48, 63].map((midi) => ({ midi, hand: 'left', startBeat: 2, beats: 2 }))
  const dup = [60, 60].map((midi) => ({ midi, hand: 'right', startBeat: 4, beats: 1 }))
  const limits = suggestFingers([...six, ...wide, ...dup])
  assert.ok([...six, ...wide, ...dup].every((note) => !limits.has(note)), 'six keys, a span over an octave and a doubled key get no suggestion')

  // ---- Determinism and speed: a long passage is fingered the same way twice and quickly; sources are untouched.
  const long = line(Array.from({ length: 6000 }, (_, i) => 48 + ((i * 7) % 30)), 'right', { step: 0.25 })
  const before = structuredClone(long)
  const started = Date.now()
  const first = suggestFingers(long)
  assert.ok(Date.now() - started < 3000, 'six thousand notes are fingered quickly')
  const second = suggestFingers(long)
  assert.deepEqual(long.map((note) => first.get(note)?.finger), long.map((note) => second.get(note)?.finger), 'suggestions are deterministic')
  assert.deepEqual(long, before, 'suggesting never changes the notes')

  // ---- Playability uses written pedals, not the gap guess, to decide what a held note costs the hand.
  const bassHeld = (extra) => [
    { midi: 36, hand: 'left', startBeat: 0, beats: 4 },
    ...[60, 64, 67, 71, 72].map((midi, i) => ({ midi, hand: 'left', startBeat: 1 + i * 0.5, beats: 0.5 })),
    ...extra,
  ]
  const dry = repairPiano(bassHeld([]), { bpm: 100 })
  const guessed = repairPiano(bassHeld([]), { bpm: 100, pedals: [] })
  assert.equal(dry.summary.flagged, 0, 'with no pedals written, a bass far below the hand is taken as pedalled')
  assert.equal(dry.summary.flagged, guessed.summary.flagged, 'an empty pedal list keeps the gap guess')
  const written = repairPiano(bassHeld([]), { bpm: 100, pedals: [{ controller: 64, startBeat: 0.5, beats: 3.75 }] })
  assert.equal(written.summary.flagged, 0, 'a written sustain pedal carrying the bass leaves nothing to repair')
  const uncovered = repairPiano(bassHeld([]), { bpm: 100, pedals: [{ controller: 64, startBeat: 4.5, beats: 1 }] })
  assert.ok(uncovered.summary.flagged > 0, 'written pedals elsewhere do not excuse the held bass: the guess is not used')

  // ---- Held notes: states that differ only in which finger holds an earlier note must stay apart.
  const notesAt = (rows) => rows.map(([midi, startBeat, beats]) => ({ midi, hand: 'right', startBeat, beats }))
  const heldG = fingersOf(notesAt([[55, 0, 4], [62, 1, 0.5], [53, 2, 0.5]]))
  assert.ok(heldG.every((finger) => finger !== undefined) && heldG[2] === 1 && heldG[0] < heldG[1], `a held G keeps room for the thumb on the F below (${heldG})`)
  const overlapping = fingersOf(notesAt([[61, 0, 3], [72, 0.5, 1], [64, 1, 3], [66, 1.5, 1], [63, 2, 3], [71, 2.5, 1]]))
  assert.ok(overlapping.every((finger) => finger !== undefined), `overlapping held notes all get fingers (${overlapping})`)
  const nested = notesAt([[60, 0, 3], [64, 0, 3], [67, 0, 3], [62, 0.5, 2.5], [66, 1, 1.5]])
  const nestedFingers = suggestFingers(nested)
  assert.ok(nested.every((note) => nestedFingers.has(note)), 'notes that fill the gaps between a held chord can be fingered')
  for (let a = 0; a < nested.length; a++) for (let b = a + 1; b < nested.length; b++) {
    if (nested[a].startBeat < nested[b].startBeat + nested[b].beats &&
      nested[b].startBeat < nested[a].startBeat + nested[a].beats) {
      assert.ok((nested[a].midi - nested[b].midi) * (nestedFingers.get(nested[a]).finger - nestedFingers.get(nested[b]).finger) > 0,
        'fingers remain in pitch order while notes overlap; only non-overlapping passages may cross')
    }
  }
  const nestedPlan = buildPianoHandPlan(nested, () => true)
  assert.deepEqual(nested.map((note) => nestedPlan.right.find((event) => event.key === keyOf(note.midi) && event.start === note.startBeat)?.finger),
    nested.map((note) => nestedFingers.get(note)?.finger), 'the animated hand plan preserves the no-crossing assignment')
  for (const at of [0, 0.5, 1, 2]) {
    const activeEvents = nestedPlan.right.filter((event) => event.start <= at && event.end > at)
    const activeFingers = activeEvents.map((event) => event.finger)
    assert.equal(new Set(activeFingers).size, activeFingers.length, `overlapping notes never occupy the same finger at beat ${at}`)
  }
  // A sustain pedal that lifts before the note ends does not carry it: the finger must stay down.
  assert.equal(pedalCarries([{ controller: 64, startBeat: 0.5, beats: 3 }], 0, 4, 1), false, 'pedal lifting at 3.5 does not carry a note to 4')
  assert.equal(pedalCarries([{ controller: 64, startBeat: 0.5, beats: 3.5 }], 0, 4, 1), true, 'pedal held to 4 carries the note')

  // ---- The hand plan lets go of a pedalled key when the hand needs the finger, so it does not stretch to hold it.
  const stretch = notesAt([[57, 0, 3], [72, 1, 1], [62, 2, 1]])
  const lateLift = [{ controller: 64, startBeat: 0.5, beats: 3 }]
  const handPlan = buildPianoHandPlan(stretch, () => true, lateLift, 120)
  assert.deepEqual(handPlan.right.map((event) => event.finger), fingersOf(stretch, lateLift, { bpm: 120 }), 'the hand plan follows the pedal-aware fingers')
  assert.equal(handPlan.right[0].end, 1, 'the pedalled A is let go when the next note starts')
  assert.equal(buildPianoHandPlan(stretch, () => true, undefined, 120).right[0].end, 3, 'without a pedal the A is held to its end')
  const inferredBass = [
    { midi: 36, hand: 'left', startBeat: 0, beats: 4 },
    ...[60, 64, 67].map((midi) => ({ midi, hand: 'left', startBeat: 1, beats: 2 })),
  ]
  const inferredPlan = buildPianoHandPlan(inferredBass, () => true)
  const inferredSuggestions = suggestFingers(inferredBass, undefined, { inferBassPedalGap: true })
  assert.equal(inferredPlan.left.length, inferredBass.length, 'the practice bass-pedal policy leaves the moved accompaniment visible')
  assert.equal(inferredPlan.left[0].end, 1, 'an inferred pedalled bass releases physically when the left hand moves')
  assert.deepEqual(inferredPlan.left.map((event) => event.finger), inferredBass.map((note) => inferredSuggestions.get(note)?.finger),
    'the shared key-release policy gives flat and animated piano views the same suggestions')

  // ---- A repeated key is released for its next attack, even when detected sound durations overlap.
  const repeatedHeld = notesAt([[60, 0, 2], [60, 1, 0.5]])
  const repeatedDry = suggestFingers(repeatedHeld)
  assert.ok(repeatedDry.get(repeatedHeld[0]))
  assert.ok(repeatedDry.get(repeatedHeld[1]), 'a repeated key may be released and rearticulated without a pedal')
  const repeatedPedal = [{ controller: 64, startBeat: 0.5, beats: 2.5 }]
  const repeatedWet = suggestFingers(repeatedHeld, repeatedPedal)
  assert.ok(repeatedWet.get(repeatedHeld[0]) && repeatedWet.get(repeatedHeld[1]), 'the sustain pedal frees the key for rearticulation')
  const repeatedPlan = buildPianoHandPlan(repeatedHeld, () => true)
  assert.equal(repeatedPlan.right.length, 2, 'the 3D plan includes both attacks of a repeated key')
  assert.equal(repeatedPlan.right[0].end, 1, 'the first physical contact ends at the next attack without altering sound duration')
  const repeatedPedalPlan = buildPianoHandPlan(repeatedHeld, () => true, repeatedPedal)
  assert.deepEqual(repeatedPedalPlan.right.map((event) => event.finger), fingersOf(repeatedHeld, repeatedPedal))
  assert.equal(repeatedPedalPlan.right[0].end, 1, 'the first key is released when the pedal carries it and the key is reattacked')

  // The hand plan uses the shared suggestions exactly, and no active finger is assigned twice.
  const sparse = notesAt([[57, 0, 3], [72, 1, 1], [62, 2, 1]])
  const sparsePedals = [{ controller: 67, startBeat: 0, beats: 4 }]
  const sparseSuggestions = suggestFingers(sparse, sparsePedals)
  const sparsePlan = buildPianoHandPlan(sparse, () => true, sparsePedals)
  for (const note of sparse) {
    const suggested = sparseSuggestions.get(note)?.finger
    const event = sparsePlan.right.find((item) => item.key === keyOf(note.midi) && item.start === note.startBeat)
    assert.equal(event?.finger, suggested, '3D uses a valid suggestion or leaves the note without a finger')
  }
  for (const at of [0, 1, 2]) {
    const activeFingers = sparsePlan.right.filter((event) => event.start <= at && event.end > at).map((event) => event.finger)
    assert.equal(new Set(activeFingers).size, activeFingers.length, `no finger is doubled at beat ${at}`)
  }
  const crossedWritten = [
    { midi: 60, hand: 'right', startBeat: 0, beats: 2, finger: 5 },
    { midi: 64, hand: 'right', startBeat: 0, beats: 2, finger: 1 },
  ]
  const crossedPlan = buildPianoHandPlan(crossedWritten, () => true)
  assert.equal(crossedPlan.right.length, 1, 'the plan omits a written assignment that would cross active fingers')
  const stretchedWritten = crossedWritten.map((note, index) => ({ ...note, midi: index ? 72 : 60, finger: index ? 5 : 4 }))
  assert.equal(buildPianoHandPlan(stretchedWritten, () => true).right.length, 1,
    'written ring and little fingers cannot be stretched an octave apart')
  for (const hand of ['right', 'left']) {
    const thumbCrossing = [
      { midi: hand === 'right' ? 64 : 60, hand, finger: 3, startBeat: 0, beats: 1.05 },
      { midi: hand === 'right' ? 65 : 59, hand, finger: 1, startBeat: 1, beats: 1 },
    ]
    assert.equal(buildPianoHandPlan(thumbCrossing, () => true)[hand].length, 2,
      'brief legato thumb-under contact overlap is a legitimate transition')
  }
  const partial = [
    { midi: 60, hand: 'right', finger: 2, startBeat: 0, beats: 2 },
    { midi: 64, hand: 'right', startBeat: 1, beats: 1 },
  ]
  const partialPlan = buildPianoHandPlan(partial, () => true)
  assert.equal(partialPlan.right.length, 2, 'missing fingers are solved around retained authored contacts')
  assert.equal(partialPlan.right[0].finger, 2)
  assert.ok(partialPlan.right[1].finger > 2)

  const unplaced = buildPianoHandPlan(notesAt([[48, 0, 1], [60, 0, 1]]).map(({ hand: _hand, ...note }) => note), () => true)
  assert.equal(unplaced.placedByPitch, true, 'pitch placement still fills in missing hand labels')
  assert.equal(unplaced.left.length + unplaced.right.length, 2, 'pitch-placed notes are included when the suggestions are constrained')

  console.log('piano-fingers: ok')
} finally {
  await vite.close()
}