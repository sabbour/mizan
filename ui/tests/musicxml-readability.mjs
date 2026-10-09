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
  assert.equal(centerDelta({ top: 100, bottom: 700 }, { top: 900, bottom: 1100 }), 600,
    'the active line centre moves to the usable viewport centre')
  assert.equal(centerDelta({ top: 100, bottom: 700 }, { top: 350, bottom: 450 }), 0, 'a centred line does not scroll')
  assert.equal(centerDelta({ top: 100, bottom: 500 }, { top: 300, bottom: 1000 }), 188,
    'a line taller than the viewport is aligned near its top')
  console.log('Notation projection and source-timing checks passed')
} finally {
  await vite.close()
}
