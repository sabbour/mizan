// Run from ui\: node tests\playability-songs.mjs [folder of analysis.json songs]
// "flagged" counts moments invalid at their original positions; "unplayable" counts moments still missing notes after
// repair. "moved" includes octave-folded chord tones, while "octaveAdjusted" is that subset.
// Reports the metrics for course lessons and any local songs.
// Local songs are only read: set MIZAN_SONGS_DIR (or pass a folder) to point at a folder of <id>\analysis.json files.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'vite'

globalThis.matchMedia = () => ({ matches: false })
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { applyPlayability } = await vite.ssrLoadModule('/src/workspace/playability.ts')
  const { isGuitarTrack } = await vite.ssrLoadModule('/src/workspace/guitar.ts')
  const { isBassTrack } = await vite.ssrLoadModule('/src/workspace/bass.ts')
  const { kitStrike } = await vite.ssrLoadModule('/src/workspace/kit.ts')
  const { drumNotationBeats } = await vite.ssrLoadModule('/src/workspace/musicxml.ts')
  const { stickingFor } = await vite.ssrLoadModule('/src/workspace/sticking.ts')
  const { PIANO_LESSONS, pianoLessonSong } = await vite.ssrLoadModule('/src/course/piano.ts')
  const { PIANO_INSPIRED } = await vite.ssrLoadModule('/src/course/pianoInspired.ts')
  const { FRETTED_LESSONS, frettedLessonSong } = await vite.ssrLoadModule('/src/course/fretted.ts')

  const rows = []
  let slowest = 0
  const check = (group, name, song, includeDrums = false) => {
    const targets = []
    if (song.piano?.length) targets.push({ instrument: 'piano' })
    for (const track of song.tracks ?? []) {
      if (track.instrument !== 'other') continue
      if (isBassTrack(track)) targets.push({ instrument: 'bass', track })
      else if (isGuitarTrack(track)) targets.push({ instrument: 'guitar', track })
    }
    for (const target of targets) {
      const started = performance.now()
      const { summary } = applyPlayability(song, target)
      const took = performance.now() - started
      slowest = Math.max(slowest, took)
      rows.push({ group, name: `${name}${target.track ? ` / ${target.track.name}` : ''}`, instrument: target.instrument,
        notes: target.instrument === 'piano' ? song.piano.length : song.instrumentNotes?.[target.track.id]?.length ?? song.piano.length,
        flagged: summary.flagged, moved: summary.moved, octaveAdjusted: summary.octaveAdjusted ?? 0,
        unplayable: summary.unplayable, warnings: summary.warnings, ms: Number(took.toFixed(1)) })
    }
    if (includeDrums && song.drums?.length) {
      const started = performance.now()
      const written = drumNotationBeats(song)
      const moments = new Map()
      song.drums.forEach((hit, index) => {
        if (kitStrike(hit).foot) return
        const beat = Math.round(written[index] * 1e6) / 1e6
        const strokes = moments.get(beat) ?? new Map()
        const sound = `${hit.lane}:${hit.sourceMidi ?? ''}`
        strokes.set(sound, [...strokes.get(sound) ?? [], index])
        moments.set(beat, strokes)
      })
      const hands = stickingFor(song).hands
      let flagged = 0, unplayable = 0
      for (const strokes of moments.values()) {
        if (strokes.size > 2) flagged++
        if ([...strokes.values()].some((indexes) => indexes.some((index) => hands[index] === undefined))) unplayable++
      }
      const took = performance.now() - started
      slowest = Math.max(slowest, took)
      rows.push({ group, name: `${name} / Drum kit`, instrument: 'drums', notes: song.drums.length,
        flagged, moved: 0, octaveAdjusted: 0, unplayable, warnings: 0, ms: Number(took.toFixed(1)) })
    }
  }

  for (const lesson of [...PIANO_LESSONS, ...PIANO_INSPIRED]) check('piano lessons', lesson.id, pianoLessonSong(lesson))
  for (const lesson of FRETTED_LESSONS) check('guitar and bass lessons', lesson.id, frettedLessonSong(lesson))

  const folder = process.argv[2] ?? process.env.MIZAN_SONGS_DIR ?? join(process.env.LOCALAPPDATA ?? '', 'Mizan', 'cache')
  if (existsSync(folder)) {
    for (const id of readdirSync(folder)) {
      const file = join(folder, id, 'analysis.json')
      if (!existsSync(file)) continue
      const song = JSON.parse(readFileSync(file, 'utf8'))
      if (song.tracks && song.piano) check('local songs', `${song.title ?? id} (${id.slice(0, 8)})`, song, true)
    }
  }

  const groups = [...new Set(rows.map((row) => row.group))]
  for (const group of groups) {
    const list = rows.filter((row) => row.group === group)
    const flagged = list.filter((row) => row.flagged)
    console.log(`\n${group}: ${list.length} parts checked, ${flagged.length} with flagged moments; ` +
      `${list.reduce((sum, row) => sum + row.flagged, 0)} moments flagged, ${list.reduce((sum, row) => sum + row.moved, 0)} notes moved ` +
      `(${list.reduce((sum, row) => sum + row.octaveAdjusted, 0)} octave folds), ` +
      `${list.reduce((sum, row) => sum + row.unplayable, 0)} moments left unplayable, ${list.reduce((sum, row) => sum + row.warnings, 0)} jump warnings`)
    for (const row of group === 'local songs' ? list : flagged)
      console.log(`  ${row.name} [${row.instrument}, ${row.notes} notes]: ${row.flagged} flagged, ${row.moved} moved ` +
        `(${row.octaveAdjusted} octave folds), ${row.unplayable} unplayable, ${row.warnings} jumps, ${row.ms} ms`)
  }
  for (const instrument of [...new Set(rows.map((row) => row.instrument))]) {
    const list = rows.filter((row) => row.instrument === instrument)
    console.log(`${instrument}: ${list.length} parts, ${list.reduce((sum, row) => sum + row.flagged, 0)} flagged moments, ` +
      `${list.reduce((sum, row) => sum + row.moved, 0)} notes adjusted (${list.reduce((sum, row) => sum + row.octaveAdjusted, 0)} octave folds), ` +
      `${list.reduce((sum, row) => sum + row.unplayable, 0)} moments still unplayable`)
  }
  console.log(`\nslowest single song: ${slowest.toFixed(1)} ms`)
} finally {
  await vite.close()
}
