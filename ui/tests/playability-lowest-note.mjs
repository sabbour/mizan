// Run from ui\: node tests\playability-lowest-note.mjs <analysis.json> [bar]
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const analysisPath = resolve(process.argv[2] ?? '')
const barNumber = Number(process.argv[3] ?? 76)
const requestPath = process.argv[4] ? resolve(process.argv[4]) : null
assert.ok(process.argv[2], 'Pass the copied analysis.json path.')
assert.ok(Number.isInteger(barNumber) && barNumber > 0, 'Bar must be a positive integer.')

const analysis = JSON.parse(await readFile(analysisPath, 'utf8'))
const trackId = 'instrument-distorted-electric-guitar'
const source = analysis.instrumentNotes?.[trackId]
assert.ok(Array.isArray(source), `The analysis has no notes for ${trackId}.`)
const bar = analysis.barMap?.[barNumber - 1]
assert.ok(bar, `The analysis has no bar ${barNumber}.`)

const vite = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
})
try {
  const { preparePlayableSong, repairFretted } = await vite.ssrLoadModule('/src/workspace/playability.ts')
  const { GUITAR, positionsForMidi } = await vite.ssrLoadModule('/src/workspace/fretboard.ts')
  const repaired = repairFretted(source, GUITAR, { chords: analysis.chords ?? [] }).notes
  const end = bar.startBeat + bar.beats
  const nearChord = (analysis.chords ?? [])
    .filter((chord) => chord.symbol === 'Asus4' && Math.abs(chord.startBeat - end) < 2)
    .sort((a, b) => Math.abs(a.startBeat - end) - Math.abs(b.startBeat - end))[0]
  assert.ok(nearChord, `No Asus4 chord span was found near bar ${barNumber}.`)

  const overlapping = (notes, chord) => notes.flatMap((note, index) =>
    note.startBeat < chord.startBeat + chord.beats && note.startBeat + note.beats > chord.startBeat
      ? [{ index, midi: note.midi, startBeat: note.startBeat, beats: note.beats }]
      : [])
  const sourceSpan = overlapping(source, nearChord)
  const repairedSpan = overlapping(repaired, nearChord)
  const lowest = (notes) => Math.min(...notes.map((note) => note.midi))
  assert.ok(sourceSpan.length, 'The source part has no notes in the Asus4 span.')
  assert.equal(repairedSpan.length, sourceSpan.length, 'Repair must preserve the source note array.')

  const spans = (analysis.chords ?? []).filter((chord) =>
    chord.confidence >= 0.5 && chord.beats > 0)
  const changedLowest = []
  for (const chord of spans) {
    const start = chord.startBeat
    const finish = start + chord.beats
    const events = new Set([start, ...source.flatMap((note) =>
      [note.startBeat, note.startBeat + note.beats].filter((beat) => beat >= start && beat < finish))])
    for (const beat of [...events].sort((a, b) => a - b)) {
      const before = source.filter((note) => note.startBeat <= beat && note.startBeat + note.beats > beat)
      if (!before.length) continue
      const after = before.map((note) => repaired[source.indexOf(note)])
      if (lowest(before) !== lowest(after)) {
        const sourceLowestMidi = lowest(before)
        changedLowest.push({
          chord: chord.symbol ?? null,
          beat,
          before: sourceLowestMidi,
          after: lowest(after),
          sourceLowestPlayable: positionsForMidi(sourceLowestMidi, GUITAR).length > 0,
          changedNotes: before.flatMap((note) => {
            const fixed = repaired[source.indexOf(note)]
            return note.midi === fixed.midi ? [] : [{
              startBeat: note.startBeat,
              beats: note.beats,
              sourceMidi: note.midi,
              repairedMidi: fixed.midi,
            }]
          }),
        })
      }
    }
  }

  const asNotes = (notes) => notes.map(({ midi, startBeat, beats }) => ({ midi, startBeat, beats }))
  console.log(JSON.stringify({
    track: trackId,
    bar: { number: barNumber, startBeat: bar.startBeat, endBeat: end },
    nearestAsus4: {
      startBeat: nearChord.startBeat,
      beats: nearChord.beats,
      confidence: nearChord.confidence,
      sourceLowestMidi: lowest(sourceSpan),
      repairedLowestMidi: lowest(repairedSpan),
      sourceNotes: asNotes(sourceSpan),
      repairedNotes: asNotes(repairedSpan),
    },
    confidentChordSpansChecked: spans.length,
    spansWithChangedLowest: changedLowest,
    lowestPitchMovesWithoutRangeException: changedLowest.filter((span) => span.sourceLowestPlayable),
  }, null, 2))
  assert.deepEqual(
    changedLowest.filter((span) => span.sourceLowestPlayable),
    [],
    'A playable lowest note must not move when another voicing can be used.',
  )
  const asus4Changes = changedLowest.filter((span) =>
    span.chord === 'Asus4' && span.beat >= nearChord.startBeat && span.beat < nearChord.startBeat + nearChord.beats)
  assert.deepEqual(asus4Changes.map(({ beat, before, after, sourceLowestPlayable, changedNotes }) =>
    ({ beat, before, after, sourceLowestPlayable, changedNotes })), [
    { beat: 302, before: 38, after: 45, sourceLowestPlayable: false,
      changedNotes: [{ startBeat: 302, beats: 0.75, sourceMidi: 38, repairedMidi: 50 }] },
    { beat: 302.75, before: 38, after: 45, sourceLowestPlayable: false,
      changedNotes: [{ startBeat: 302.75, beats: 0.25, sourceMidi: 38, repairedMidi: 50 }] },
  ], 'each D2 onset is checked, not just the first lowest-note change in the chord span')
  if (requestPath) {
    const sourceSong = { ...analysis }
    delete sourceSong.playability
    const prepared = preparePlayableSong(sourceSong)
    assert.ok(prepared.request, 'The analysis should produce a stored playability repair.')
    await writeFile(requestPath, JSON.stringify(prepared.request), 'utf8')
  }
} finally {
  await vite.close()
}
