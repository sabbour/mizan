// Run from the repository root: node ui\tests\musicxml-readability.mjs
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { notationNotes, pianoXml, instrumentXml } = await vite.ssrLoadModule('/src/workspace/musicxml.ts')
  const { buildSong } = await vite.ssrLoadModule('/src/workspace/song.ts')
  const notes = [
    { midi: 72, startBeat: 0.40625, beats: 0.34375, hand: 'right', confidence: 0.4, generated: false },
    { midi: 50, startBeat: 0.125, beats: 0.125, hand: 'left' },
    { midi: 52, startBeat: 0.3125, beats: 0.125, hand: 'left', confidence: 0.4, generated: false },
    { midi: 77, startBeat: 3.96, beats: 0.24, hand: 'right', confidence: 0.4, generated: false },
  ]
  const original = structuredClone(notes)
  const song = { ...buildSong(), bars: 1, chords: [], vocals: [], drums: [], piano: notes }
  const projected = notationNotes(notes, 'piano', song.beatsPerBar)
  assert.deepEqual(projected.map(({ sourceId }) => sourceId),
    ['piano:note:0', 'piano:note:1', 'piano:note:2', 'piano:note:3'])
  assert.equal(projected[0].startBeat, 0.5, 'a low-confidence onset near the 16th grid is cleaned for notation')
  assert.equal(projected[0].endBeat, 0.75)
  assert.equal(projected[0].sourceStartBeat, notes[0].startBeat, 'the exact playback onset remains available')
  assert.equal(projected[1].startBeat, 0.125, 'imported fine rhythms remain written as supplied')
  assert.equal(projected[2].startBeat, 0.3125, 'intentional off-grid fast rhythms are not coarsened')
  assert.ok(projected[3].startBeat < song.beatsPerBar, 'notation does not move a note onset across a barline')
  assert.deepEqual(notes, original, 'projection does not mutate shared song events')

  const xml = pianoXml(song, false)
  const pitchedNotes = (xml.match(/<note>[\s\S]*?<\/note>/g) ?? [])
    .filter((note) => note.includes('<pitch>'))
  const noteFor = (step) => pitchedNotes.find((note) => note.includes(`<step>${step}</step>`))
  assert.match(noteFor('C'), /<type>16th<\/type>/,
    'the simple uncertain melody is engraved with readable sixteenth-note values')
  assert.match(noteFor('D'), /<type>32nd<\/type>/, 'an imported fast rhythm remains a 32nd note')
  assert.match(noteFor('E'), /<type>32nd<\/type>/, 'an off-grid fast rhythm remains a 32nd note')

  const gates = [
    { midi: 60, startBeat: 0.02, beats: 0.125, hand: 'right', confidence: 0.4, generated: false },
    { midi: 62, startBeat: 1.02, beats: 0.95, hand: 'right', confidence: 0.4, generated: false },
  ]
  const gatesBefore = structuredClone(gates)
  const engravedGates = notationNotes(gates, 'piano', 4)
  assert.deepEqual(engravedGates.map(({ startBeat, endBeat, staccato }) => ({ startBeat, endBeat, staccato })), [
    { startBeat: 0, endBeat: 1, staccato: true },
    { startBeat: 1, endBeat: 2, staccato: false },
  ], 'a short detected gate takes the logical space to the next attack and gains staccato')
  const gateXml = pianoXml({ ...song, piano: gates }, false)
  const gateHeads = (gateXml.match(/<note>[\s\S]*?<\/note>/g) ?? []).filter((note) => note.includes('<pitch>'))
  assert.match(gateHeads[0], /<type>quarter<\/type>/)
  assert.match(gateHeads[0], /<articulations><staccato\/><\/articulations>/)
  assert.doesNotMatch(gateXml, /<type>(?:32nd|64th)<\/type>/,
    'short performance gates do not become tiny pitched notes or rests')
  assert.deepEqual(gates, gatesBefore, 'logical engraving does not change source attacks or releases')

  const quickAttacks = [
    { midi: 72, startBeat: 0.02, beats: 0.1, hand: 'right', confidence: 0.4, generated: false },
    { midi: 74, startBeat: 0.145, beats: 0.12, hand: 'right', confidence: 0.4, generated: false },
    { midi: 76, startBeat: 0.27, beats: 0.12, hand: 'right', confidence: 0.4, generated: false },
  ]
  const quickProjection = notationNotes(quickAttacks, 'piano', 4)
  assert.deepEqual(quickProjection.map(({ startDiv }) => startDiv), [0, 2, 4],
    'closely spaced source attacks remain distinct instead of merging onto a coarse grid')
  assert.ok(quickProjection.every(({ staccato }) => !staccato),
    'true fast attacks are not given a false detached-note articulation')

  const fastNotes = [
    { midi: 60, startBeat: 0.02, beats: 0.175, hand: 'right', confidence: 0.4, generated: false },
    { midi: 64, startBeat: 0.208, beats: 0.175, hand: 'right', confidence: 0.4, generated: false },
    { midi: 67, startBeat: 0.396, beats: 0.175, hand: 'right', confidence: 0.4, generated: false },
  ]
  const fastProjection = notationNotes(fastNotes, 'piano', 4)
  assert.deepEqual(fastProjection.map(({ startDiv, endDiv }) => [startDiv, endDiv]),
    [[0, 3], [3, 6], [6, 9]],
    'tightly spaced same-voice attacks keep their source written divisions')
  assert.ok(fastProjection.every(({ staccato }) => !staccato),
    'fast source gates are not extended or marked staccato')

  const interleavedHands = [
    { midi: 72, startBeat: 0.40625, beats: 1, hand: 'right', confidence: 0.4, generated: false },
    { midi: 48, startBeat: 0.75, beats: 0.1, hand: 'left', confidence: 0.4, generated: false },
    { midi: 74, startBeat: 1.40625, beats: 1, hand: 'right', confidence: 0.4, generated: false },
    { midi: 50, startBeat: 1, beats: 0.1, hand: 'left', confidence: 0.4, generated: false },
    { midi: 76, startBeat: 2.40625, beats: 1, hand: 'right', confidence: 0.4, generated: false },
  ]
  const interleavedProjection = notationNotes(interleavedHands, 'piano', 4)
  assert.deepEqual(interleavedProjection.filter(({ source }) => source.hand === 'right')
    .map(({ startBeat }) => startBeat), [0.5, 1.5, 2.5],
  'interleaved attacks in the other hand do not disable slow-voice grid cleanup')

  const simultaneousHands = [
    { midi: 72, startBeat: 0.08, beats: 0.175, hand: 'right', confidence: 0.4, generated: false },
    { midi: 74, startBeat: 0.27, beats: 0.175, hand: 'right', confidence: 0.4, generated: false },
    { midi: 76, startBeat: 0.46, beats: 0.175, hand: 'right', confidence: 0.4, generated: false },
    { midi: 48, startBeat: 0.08, beats: 1, hand: 'left', confidence: 0.4, generated: false },
    { midi: 50, startBeat: 1.08, beats: 0.5, hand: 'left', confidence: 0.4, generated: false },
  ]
  const simultaneousProjection = notationNotes(simultaneousHands, 'piano', 4)
  assert.equal(simultaneousProjection[0].startDiv, simultaneousProjection[3].startDiv,
    'simultaneous cross-staff attacks stay aligned when one hand has fast neighboring notes')

  const spacedAttacks = [
    { midi: 72, startBeat: 2.444449, beats: 1.083447, hand: 'right', confidence: 0.4, generated: false },
    { midi: 64, startBeat: 3.527896, beats: 1.25, hand: 'right', confidence: 0.4, generated: false },
    { midi: 60, startBeat: 4.777896, beats: 1.083227, hand: 'right', confidence: 0.4, generated: false },
    { midi: 72, startBeat: 5.861123, beats: 1.166773, hand: 'right', confidence: 0.4, generated: false },
    { midi: 64, startBeat: 7.027896, beats: 0.9, hand: 'right', confidence: 0.4, generated: false },
  ]
  const spacedProjection = notationNotes(spacedAttacks, 'piano', 4)
  assert.deepEqual(spacedProjection.map(({ startBeat, endBeat }) => [startBeat, endBeat]), [
    [2.5, 3.5], [3.5, 4.75], [4.75, 5.75], [5.75, 7], [7, 8],
  ], 'near-grid attacks and releases are projected only when neighboring intervals confirm the sixteenth grid')
  assert.ok(spacedProjection.every(({ staccato }) => !staccato),
    'full sounding gates remain legato rather than receiving false staccato')

  const adjacent = [
    { midi: 60, startBeat: 0.40625, beats: 0.1875, hand: 'right', confidence: 0.4, generated: false },
    { midi: 62, startBeat: 0.6, beats: 0.25, hand: 'right', confidence: 0.4, generated: false },
  ]
  const overlaps = (events) => {
    const ordered = [...events].sort((a, b) => a.startBeat - b.startBeat)
    const pairs = []
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length && ordered[j].startBeat < ordered[i].endBeat; j++) {
        pairs.push([ordered[i].sourceId, ordered[j].sourceId].sort().join('|'))
      }
    }
    return pairs.sort()
  }
  const sharedStartFallback = [
    { midi: 72, startBeat: 0.08, beats: 0.75, hand: 'right', confidence: 0.4, generated: false },
    { midi: 48, startBeat: 0.08, beats: 0.75, hand: 'left', confidence: 0.4, generated: false },
    { midi: 50, startBeat: 0.74, beats: 0.5, hand: 'left', confidence: 0.4, generated: false },
  ]
  const sharedStartBaseline = notationNotes(sharedStartFallback.map((note) => ({ ...note, generated: true })),
    'piano', song.beatsPerBar)
  const sharedStartProjection = notationNotes(sharedStartFallback, 'piano', song.beatsPerBar)
  assert.deepEqual(sharedStartProjection.slice(0, 2).map(({ startDiv }) => startDiv), [1, 1],
    'a one-hand overlap fallback keeps a simultaneous other-hand attack aligned')
  assert.deepEqual(overlaps(sharedStartProjection), overlaps(sharedStartBaseline),
    'shared-start fallback retains genuine overlapping source notes')
  const adjacentBaseline = notationNotes(adjacent.map((note) => ({ ...note, generated: true })),
    'piano', song.beatsPerBar)
  const adjacentProjection = notationNotes(adjacent, 'piano', song.beatsPerBar)
  assert.deepEqual(overlaps(adjacentProjection), overlaps(adjacentBaseline),
    'notation cleanup does not create overlaps between otherwise separated written notes')
  assert.equal(adjacentProjection[1].startBeat, 0.625,
    'a conflicting projection falls back to the source-aligned notation position')
  assert.equal(adjacentProjection[1].startDiv, adjacentProjection[1].startBeat * 16,
    'score positions and MusicXML divisions use the same guarded onset')
  assert.equal(adjacentProjection[1].endDiv, adjacentProjection[1].endBeat * 16,
    'score positions and MusicXML divisions use the same guarded end')

  const lostPolyphony = [
    { midi: 60, startBeat: 0.02, beats: 0.75, hand: 'right', confidence: 0.4, generated: false },
    { midi: 64, startBeat: 0.68, beats: 0.5, hand: 'right', confidence: 0.4, generated: false },
  ]
  const lostPolyphonyBaseline = notationNotes(lostPolyphony.map((note) => ({ ...note, generated: true })),
    'piano', song.beatsPerBar)
  const lostPolyphonyProjection = notationNotes(lostPolyphony, 'piano', song.beatsPerBar)
  assert.deepEqual(overlaps(lostPolyphonyBaseline), ['piano:note:0|piano:note:1'],
    'the fixture contains source-written polyphony')
  assert.deepEqual(overlaps(lostPolyphonyProjection), overlaps(lostPolyphonyBaseline),
    'notation cleanup preserves source overlaps instead of removing genuine polyphony')
  assert.deepEqual(lostPolyphonyProjection.map(({ startDiv, endDiv }) => [startDiv, endDiv]),
    [[0, 12], [11, 19]], 'only changed intervals fall back to their source divisions')

  const polyphonic = [
    { midi: 60, startBeat: 0.40625, beats: 1.09375, hand: 'right', confidence: 0.4, generated: false },
    { midi: 64, startBeat: 1.25, beats: 0.5, hand: 'right', confidence: 0.4, generated: false },
  ]
  const polyphonicBaseline = notationNotes(polyphonic.map((note) => ({ ...note, generated: true })),
    'piano', song.beatsPerBar)
  const polyphonicProjection = notationNotes(polyphonic, 'piano', song.beatsPerBar)
  assert.ok(overlaps(polyphonicBaseline).length > 0, 'the fixture contains genuine source polyphony')
  assert.deepEqual(overlaps(polyphonicProjection), overlaps(polyphonicBaseline),
    'notation cleanup preserves original polyphony')
  assert.equal(polyphonicProjection[0].startBeat, 0.5,
    'valid projection remains available when it preserves original polyphony')

  const tiedXml = pianoXml({
    ...song,
    bars: 2,
    chords: [
      { startBeat: 0, beats: 4, symbol: null, tones: [], flats: false },
      { startBeat: 4, beats: 4, symbol: null, tones: [], flats: true },
    ],
    piano: [{ midi: 70, startBeat: 3.59, beats: 0.82, hand: 'right', confidence: 0.4, generated: false }],
  }, false)
  const tiedHeads = (tiedXml.match(/<note>[\s\S]*?<\/note>/g) ?? [])
    .filter((note) => note.includes('<pitch>'))
  assert.equal(tiedHeads.filter((note) => note.includes('<tie type="start"/>')).length, 1,
    'the projected cross-bar note starts one tie')
  assert.equal(tiedHeads.filter((note) => note.includes('<tie type="stop"/>')).length, 1,
    'the projected cross-bar note ends the same tie')
  assert.deepEqual(tiedHeads.map((note) => Number(/<duration>(\d+)<\/duration>/.exec(note)?.[1])),
    [8, 8], 'the cross-bar tie uses the projected half-beat boundary on both sides')
  assert.deepEqual(tiedHeads.map((note) => /<pitch>([\s\S]*?)<\/pitch>/.exec(note)?.[1]),
    ['<step>A</step><alter>1</alter><octave>4</octave>', '<step>A</step><alter>1</alter><octave>4</octave>'],
    'a tied pitch keeps one spelling across a chord change')

  const guitar = { id: 'guitar', instrument: 'other', name: 'Guitar', detail: '' }
  const instrumentSong = {
    ...song,
    bars: 2,
    instrumentNotes: {
      guitar: [
        { midi: 48, startBeat: 3, beats: 0.75 },
        { midi: 50, startBeat: 3.5, beats: 1 },
      ],
    },
  }
  const instrumentXmlText = instrumentXml(instrumentSong, guitar)
  const instrumentHeads = (instrumentXmlText.match(/<note>[\s\S]*?<\/note>/g) ?? [])
    .filter((note) => note.includes('<pitch>'))
  const startVoice = instrumentHeads.find((note) => note.includes('<tie type="start"/>'))
    ?.match(/<voice>(\d+)<\/voice>/)?.[1]
  const stopVoice = instrumentHeads.find((note) => note.includes('<tie type="stop"/>'))
    ?.match(/<voice>(\d+)<\/voice>/)?.[1]
  assert.equal(startVoice, '2', 'overlapping instrument notes use a stable second voice before the barline')
  assert.equal(stopVoice, startVoice, 'the instrument tie continuation stays in the same voice')

  const { drumXml, drumNotationBeats } = await vite.ssrLoadModule('/src/workspace/musicxml.ts')
  const jittered = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((beat, index) => ({
    lane: 'hihat', startBeat: beat + (index % 2 ? 0.06 : -0.04 * (index > 0)), velocity: 0.6, confidence: 0.4 }))
  jittered.push({ lane: 'kick', startBeat: 0.03, velocity: 0.9, confidence: 0.4 },
    { lane: 'snare', startBeat: 1.07, velocity: 0.9, confidence: 0.4 },
    { lane: 'snare', startBeat: 1.07, velocity: 0.9, confidence: 0.4 })
  const drumSong = { ...song, bars: 1, piano: [], drums: jittered }
  const drumsBefore = structuredClone(jittered)
  const drumScore = drumXml(drumSong, false)
  assert.doesNotMatch(drumScore, /<type>(?:32nd|64th)<\/type>|time-modification/,
    'timing jitter in automatic drum hits does not become tiny rests or tuplets')
  assert.equal((drumScore.match(/<display-step>C<\/display-step>/g) ?? []).length, 1,
    'a duplicated automatic snare hit is written as one notehead')
  assert.deepEqual(jittered, drumsBefore, 'drum engraving keeps source playback beats')
  assert.deepEqual(drumNotationBeats({ ...drumSong, drums: [
    { lane: 'snare', startBeat: 2, velocity: 1, confidence: 0.4 },
    { lane: 'snare', startBeat: 2.125, velocity: 1, confidence: 0.4 },
    { lane: 'snare', startBeat: 3.125, velocity: 1 },
  ] }), [2, 2.125, 3.125], 'a genuine 32nd figure and imported rhythms are not coarsened')
  const roll = [0, 1, 2, 3, 4].map((step) => ({ lane: 'snare', startBeat: 1 + step / 16 + (step % 2 ? 0.004 : -0.003), velocity: 0.7, confidence: 0.4 }))
  const triplets = Array.from({ length: 12 }, (_, step) => ({ lane: 'hihat', startBeat: step / 3 + (step % 2 ? 0.02 : -0.015 * (step > 0)), velocity: 0.6, confidence: 0.4 }))
  const fineSong = { ...drumSong, drums: [...roll, ...triplets] }
  const fineBefore = structuredClone(fineSong.drums)
  const fineWritten = drumNotationBeats(fineSong)
  assert.deepEqual(fineWritten.slice(0, 5), [1, 1.0625, 1.125, 1.1875, 1.25], 'a recurring 64th roll keeps distinct 64th attacks')
  assert.ok(fineWritten.slice(5).every((beat, step) => Math.abs(beat - step / 3) < 1e-9), 'recurring eighth triplets keep exact triplet attacks')
  const fineScore = drumXml(fineSong, false)
  assert.ok((fineScore.match(/<actual-notes>3<\/actual-notes><normal-notes>2<\/normal-notes>/g) ?? []).length >= 10,
    'triplet attacks are written as 3:2 triplet values')
  assert.match(fineScore, /<type>64th<\/type>/, 'the roll is written with 64th values')
  assert.doesNotMatch(fineScore, /<actual-notes>(?!3<)/, 'no irregular tuplet ratios are invented')
  assert.deepEqual(fineSong.drums, fineBefore, 'fine-figure engraving keeps source playback beats')

  const marks = (xml) => xml.split('<measure ').slice(1).map((measure) => {
    const metronome = /<metronome><beat-unit>quarter<\/beat-unit>(<beat-unit-dot\/>)?<per-minute>(\d+)<\/per-minute><\/metronome><\/direction-type><sound tempo="([\d.]+)"/.exec(measure)
    return metronome ? { dotted: !!metronome[1], shown: Number(metronome[2]), sound: Number(metronome[3]) } : null
  })
  const blank = { ...song, chords: [], piano: [], vocals: [], drums: [] }
  const mixed = { ...blank, bpm: 150, bars: 3, beatsPerBar: 4, barMap: [
    { startBeat: 0, beats: 4, numerator: 4, denominator: 4 },
    { startBeat: 4, beats: 6, numerator: 12, denominator: 8 },
    { startBeat: 10, beats: 4, numerator: 4, denominator: 4 },
  ], tempoMap: [{ beat: 0, time: 0 }, { beat: 4, time: 1.6 }, { beat: 10, time: 3.2 }, { beat: 14, time: 4.8 }] }
  assert.deepEqual(marks(drumXml(mixed, false)), [
    { dotted: false, shown: 150, sound: 150 }, { dotted: true, shown: 150, sound: 225 }, { dotted: false, shown: 150, sound: 150 },
  ], 'a steady pulse across 4/4 and 12/8 is marked as quarter, dotted quarter and quarter at their real quarter tempos')
  const eighths = { ...blank, bpm: 120, bars: 2, beatsPerBar: 3, barMap: [
    { startBeat: 0, beats: 3, numerator: 6, denominator: 8 },
    { startBeat: 3, beats: 1.5, numerator: 3, denominator: 8 },
  ] }
  assert.deepEqual(marks(drumXml(eighths, false)), [
    { dotted: true, shown: 80, sound: 120 }, { dotted: false, shown: 120, sound: 120 },
  ], 'a change of displayed beat unit at the same quarter tempo gets its own marking')

  const { centerDelta } = await vite.ssrLoadModule('/src/workspace/follow.ts')
  const { suggestFingers } = await vite.ssrLoadModule('/src/workspace/fingers.ts')
  const scale = [60, 62, 64, 65, 67].map((midi, index) => ({ midi, startBeat: index, beats: 1, hand: 'right' }))
  const chord = [48, 52, 55].map((midi) => ({ midi, startBeat: 0, beats: 2, hand: 'left' }))
  const quarterTone = { midi: 64.5, startBeat: 6, beats: 1, hand: 'right' }
  const handNotes = [...scale, ...chord, quarterTone]
  const handBefore = structuredClone(handNotes)
  const fingering = suggestFingers(handNotes)
  assert.deepEqual(scale.map((note) => fingering.get(note).finger), [1, 2, 3, 4, 5],
    'a rising five-note right-hand line stays in one hand position from the thumb')
  assert.deepEqual(chord.map((note) => fingering.get(note).finger), [5, 3, 1],
    'a left-hand triad spreads 5-3-1 from the bottom, the thumb on top')
  assert.equal(fingering.get(quarterTone).hand, 'right', 'a microtonal note keeps its hand')
  assert.deepEqual(handNotes, handBefore, 'finger suggestions never change source notes')
  const heldLow = { midi: 57, startBeat: 0, beats: 3, hand: 'right' }
  const farAbove = { midi: 72, startBeat: 1, beats: 1, hand: 'right' }
  const nearAbove = { midi: 62, startBeat: 2, beats: 1, hand: 'right' }
  const holding = suggestFingers([heldLow, farAbove, nearAbove])
  assert.equal(holding.get(heldLow).finger, 1)
  assert.equal(holding.get(farAbove), undefined, 'a note out of reach of a held note gets no impossible suggestion')
  assert.ok(holding.get(nearAbove).finger > 1, 'a note within reach of a held thumb takes another finger')
  const cluster = [60, 62, 64, 65, 67, 69].map((midi) => ({ midi, startBeat: 0, beats: 2, hand: 'right' }))
  const wide = [48, 63].map((midi) => ({ midi, startBeat: 2, beats: 2, hand: 'left' }))
  const octave = [60, 64, 72].map((midi) => ({ midi, startBeat: 4, beats: 1, hand: 'right' }))
  const after = { midi: 64, startBeat: 1, beats: 1, hand: 'right' }
  const limits = suggestFingers([...cluster, ...wide, ...octave, after])
  assert.ok(cluster.every((note) => !limits.has(note)), 'six keys in one hand get no finger suggestion')
  assert.ok(wide.every((note) => !limits.has(note)), 'a chord wider than an octave gets no finger suggestion')
  assert.deepEqual(octave.map((note) => limits.get(note).finger), [1, 3, 5], 'an octave-wide triad is still fingered')
  assert.equal(limits.get(after), undefined, 'a note under an unfingered held chord is not guessed and does not throw')
  assert.equal(centerDelta({ top: 100, bottom: 700 }, { top: 900, bottom: 1100 }), 600,
    'the active line centre moves to the usable viewport centre')
  assert.equal(centerDelta({ top: 100, bottom: 700 }, { top: 350, bottom: 450 }), 0, 'a centred line does not scroll')
  assert.equal(centerDelta({ top: 100, bottom: 500 }, { top: 300, bottom: 1000 }), 188,
    'a line taller than the viewport is aligned near its top')

  // A held right-hand chord under moving eighths (Fel Khetam bar 2) must not overflow its voice:
  // an overfull voice stretches the engraved bar and every later playhead/highlight timestamp drifts.
  const held = {
    ...buildSong(), bars: 3, beatsPerBar: 3, chords: [], vocals: [], drums: [],
    piano: [
      ...[0, 0.5, 1].map((offset, index) => ({ midi: [72, 76, 72][index], startBeat: offset, beats: 0.5, hand: 'right' })),
      { midi: 69, startBeat: 1.5, beats: 1.5, hand: 'right' }, { midi: 72, startBeat: 1.5, beats: 1.5, hand: 'right' },
      { midi: 76, startBeat: 2, beats: 0.5, hand: 'right' }, { midi: 72, startBeat: 2.5, beats: 0.5, hand: 'right' },
      { midi: 45, startBeat: 0, beats: 4, hand: 'left' }, { midi: 74, startBeat: 3, beats: 0.5, hand: 'right' },
      ...[0, 1, 2, 3, 4, 5].map((index) => ({ midi: 60 + index, startBeat: 6 + index * 0.5, beats: 0.5, hand: 'right' })),
      { midi: 48, startBeat: 6, beats: 3, hand: 'right' },
    ],
  }
  const heldXml = pianoXml(held, false)
  const division = Number(heldXml.match(/<divisions>(\d+)<\/divisions>/)[1])
  const heldMeasures = heldXml.match(/<measure[\s\S]*?<\/measure>/g)
  assert.equal(heldMeasures.length, 3)
  for (const [index, measure] of heldMeasures.entries()) {
    const totals = new Map()
    for (const [, body] of measure.matchAll(/<note>([\s\S]*?)<\/note>/g)) {
      if (body.includes('<chord/>')) continue
      const voice = body.match(/<voice>(\d+)<\/voice>/)[1]
      totals.set(voice, (totals.get(voice) ?? 0) + Number(body.match(/<duration>(\d+)<\/duration>/)[1]))
    }
    for (const [voice, total] of totals)
      assert.equal(total, 3 * division, `bar ${index + 1} voice ${voice} fills exactly one 3/4 bar`)
    const pitched = [...measure.matchAll(/<note>(?:(?!<\/note>)[\s\S])*?<pitch>(?:(?!<\/note>)[\s\S])*?<\/note>/g)]
      .filter(([note]) => !note.includes('<tie type="stop"/>')).length
    assert.equal(pitched, [8, 1, 7][index], `bar ${index + 1} keeps every sounding note onset`)
  }
  assert.match(heldMeasures[0], /<voice>2<\/voice>/, 'the held chord and the moving line are written as separate voices')

  const { kitStrike, tomRate } = await vite.ssrLoadModule('/src/workspace/kit.ts')
  const strike = (hit) => kitStrike({ startBeat: 0, velocity: 0.8, ...hit })
  const { KIT_PIECES } = await vite.ssrLoadModule('/src/workspace/kit.ts')
  assert.deepEqual(KIT_PIECES.map(({ piece }) => piece).filter((piece) => /tom|floor/.test(piece)), ['tom1', 'tom2', 'floor'],
    'the kit is a five-piece: exactly two rack toms and one floor tom')
  assert.deepEqual([50, 48, 47].map((sourceMidi) => strike({ lane: 'hightom', sourceMidi }).pieces), [['tom1'], ['tom1'], ['tom2']])
  assert.deepEqual([45, 43, 41].map((sourceMidi) => strike({ lane: 'floortom', sourceMidi }).pieces), [['tom2'], ['floor'], ['floor']],
    'the six GM tom pitches share the three toms in pairs, high to low')
  assert.deepEqual([50, 48, 47].map((sourceMidi) => strike({ lane: 'hightom', sourceMidi }).label), ['Tom 1', 'Tom 1', 'Tom 2'])
  assert.deepEqual(strike({ lane: 'hightom' }), { pieces: ['tom1', 'tom2'], specified: false, foot: false,
    label: 'Rack tom (which one is unspecified)' }, 'a generic rack tom stays unspecified instead of naming a drum')
  assert.deepEqual(strike({ lane: 'floortom' }).pieces, ['floor'], 'a generic floor tom can only be the one floor tom')
  assert.equal(strike({ lane: 'hightom', sourceMidi: 41 }).specified, false, 'a floor-tom pitch on the rack lane is not trusted')
  for (const [lane, sourceMidi] of [['hightom', 45], ['hightom', 43], ['floortom', 50], ['floortom', 47]]) {
    assert.deepEqual(strike({ lane, sourceMidi }).pieces, lane === 'hightom' ? ['tom1', 'tom2'] : ['floor'], `${lane} with GM ${sourceMidi} stays its lane`)
    assert.equal(tomRate({ lane, sourceMidi }), 1, `${lane} with GM ${sourceMidi} keeps the lane's own pitch`)
  }
  {
    const { Engine } = await vite.ssrLoadModule('/src/workspace/engine.ts')
    const engine = new Engine({ ...buildSong(), drums: [] })
    const started = []
    const node = () => ({ connect: (next) => next ?? node(), gain: { value: 1 } })
    engine.ctx = {
      createBufferSource: () => {
        const source = { ...node(), playbackRate: { value: 1 }, buffer: null,
          start(at) { started.push({ source, at }) }, stop(at) { source.stoppedAt = Math.min(source.stoppedAt ?? Infinity, at) } }
        return source
      },
      createGain: node,
    }
    engine.bus = () => node()
    engine.track = (source, start, stop) => { source.start(start); source.stop(stop); return source }
    engine.drumSamples = new Map(['hihat', 'openhat'].map((lane) => [lane, { duration: 2, lane }]))
    const play = (time, hit) => { engine.drum(time, { startBeat: 0, velocity: 0.7, ...hit }, 'drums'); return started.at(-1).source }
    const open = play(0, { lane: 'openhat', sourceMidi: 46 })
    const halfOnHat = play(1, { lane: 'hihat', sourceMidi: 42, articulation: 'half-open' })
    assert.equal(halfOnHat.buffer.lane, 'openhat', 'a half-open hit on the hi-hat lane sounds the open-hat sample')
    assert.ok(open.stoppedAt <= 1.03, 'it chokes the ringing open hat, as any hi-hat lane hit does')
    assert.ok(halfOnHat.stoppedAt - 1 < 0.4, 'and rings short')
    const pedal = play(1.2, { lane: 'hihat', sourceMidi: 44 })
    assert.equal(pedal.buffer.lane, 'hihat')
    assert.ok(halfOnHat.stoppedAt <= 1.23, 'the pedal closes the half-open hat')
    const halfOnOpen = play(2, { lane: 'openhat', sourceMidi: 46, articulation: 'half-open' })
    assert.equal(halfOnOpen.buffer.lane, 'openhat')
    assert.ok(halfOnOpen.stoppedAt - 2 < 0.4, 'a half-open hit on the open-hat lane rings short too')
    const closed = play(2.1, { lane: 'hihat', sourceMidi: 42 })
    assert.equal(closed.buffer.lane, 'hihat', 'ordinary closed hits keep the closed sample')
    assert.ok(halfOnOpen.stoppedAt <= 2.13, 'and close the half-open hat')
    const generic = play(3, { lane: 'hihat' })
    assert.equal(generic.buffer.lane, 'hihat', 'a generic hi-hat hit is unchanged')
    assert.ok(generic.stoppedAt - 3 > 1.5, 'and keeps its natural length')
  }
  assert.deepEqual(['hihat:42', 'openhat:46', 'hihat:44', 'hihat:'].map((key) => {
    const [lane, midi] = key.split(':')
    return strike({ lane, ...(midi ? { sourceMidi: Number(midi) } : {}) }).hat ?? 'unspecified'
  }), ['closed', 'open', 'pedal', 'unspecified'], 'hat states come from GM 42/46/44 only; a generic hat claims none')
  assert.equal(strike({ lane: 'openhat', articulation: 'half-open' }).hat, 'half-open', 'half-open only from explicit articulation')
  assert.ok(strike({ lane: 'hihat', sourceMidi: 44 }).foot && strike({ lane: 'kick' }).foot)
  assert.deepEqual([{ lane: 'hightom', sourceMidi: 48 }, { lane: 'floortom', sourceMidi: 41 }, { lane: 'hightom' }].map((hit) => tomRate(hit)),
    [1, 1, 1], 'lane-default GM toms and generic toms keep their existing sample pitch')
  assert.ok(tomRate({ lane: 'hightom', sourceMidi: 50 }) > 1 && tomRate({ lane: 'hightom', sourceMidi: 47 }) < 1 &&
    tomRate({ lane: 'floortom', sourceMidi: 45 }) > tomRate({ lane: 'floortom', sourceMidi: 43 }), 'specific toms are tuned high to low')
  const kitXml = drumXml({ ...buildSong(), bars: 1, chords: [], piano: [], vocals: [], drums: [
    { lane: 'hightom', startBeat: 0, velocity: 0.8, sourceMidi: 47 }, { lane: 'hihat', startBeat: 1, velocity: 0.5, sourceMidi: 44 },
    { lane: 'hightom', startBeat: 2, velocity: 0.8 }, { lane: 'kick', startBeat: 3, velocity: 0.8 },
  ] }, false)
  const heads = [...kitXml.matchAll(/<display-step>(\w)<\/display-step><display-octave>(\d)<\/display-octave><\/unpitched><duration>\d+<\/duration><voice>(\d)<\/voice>[\s\S]*?<stem>(\w+)<\/stem>(<notehead>[^<]+<\/notehead>)?/g)]
    .map(([, step, octave, voice, stem, head]) => `${step}${octave}${head ? 'x' : ''}:${voice}:${stem}`)
  assert.deepEqual(heads, ['B4:1:up', 'D4x:1:up', 'E5:1:up', 'F4:1:up'],
    'a GM low-mid tom keeps its own line, the pedalled hat its foot position below, a generic tom its lane; all share one up-stemmed voice')
  console.log('Notation projection and source-timing checks passed')
} finally {
  await vite.close()
}
