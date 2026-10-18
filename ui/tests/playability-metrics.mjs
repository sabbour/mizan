// Compare source, the PR #8 repair, and the persisted post-transcription layer.
// Run from ui\: node tests\playability-metrics.mjs <analysis cache directory>
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

globalThis.matchMedia = () => ({ matches: false })

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(uiRoot, '..')
const baselineRef = process.env.PLAYABILITY_PR8_REF ?? '520f282'
const legacyFile = resolve(uiRoot, 'src', 'workspace', `.playability-pr8-${process.pid}.ts`)
const legacyStickingFile = resolve(uiRoot, 'src', 'workspace', `.playability-pr8-sticking-${process.pid}.ts`)
const legacySource = execFileSync('git', ['show', `${baselineRef}:ui/src/workspace/playability.ts`],
  { cwd: repoRoot, encoding: 'utf8' })
const legacyStickingSource = execFileSync('git', ['show', `${baselineRef}:ui/src/workspace/sticking.ts`],
  { cwd: repoRoot, encoding: 'utf8' })
writeFileSync(legacyFile, legacySource)
writeFileSync(legacyStickingFile, legacyStickingSource)

const pc = (midi) => (midi % 12 + 12) % 12
const beatKey = (beat) => Math.round(beat * 1e6) / 1e6
const scale = (key) => {
  if (!key) return null
  const pitch = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[key.tonic[0]]
  const offset = key.tonic[1] === '#' ? 1 : key.tonic[1] === 'b' ? -1 : 0
  const steps = key.mode === 'minor' ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]
  return new Set(steps.map((step) => (pitch + offset + step + 12) % 12))
}

const groupsByOnset = (notes) => {
  const groups = new Map()
  notes.forEach((note, index) => {
    const beat = beatKey(note.startBeat)
    const group = groups.get(beat) ?? []
    group.push(index)
    groups.set(beat, group)
  })
  return groups
}

function harmonyMembership(song, notes) {
  let chordEligible = 0, chordMember = 0, keyEligible = 0, keyMember = 0
  const keyTones = scale(song.key)
  for (const note of notes) {
    const chord = song.chords?.find((item) => item.confidence >= 0.5 && item.tones?.length &&
      item.startBeat <= note.startBeat + 1e-6 && item.startBeat + item.beats > note.startBeat + 1e-6)
    if (chord) {
      chordEligible++
      if (chord.tones.some((tone) => pc(tone) === pc(note.midi))) chordMember++
    }
    if (keyTones) {
      keyEligible++
      if (keyTones.has(pc(note.midi))) keyMember++
    }
  }
  return {
    chordToneNotes: chordMember, chordEligibleNotes: chordEligible,
    chordToneRate: chordEligible ? chordMember / chordEligible : null,
    keyNotes: keyMember, keyEligibleNotes: keyEligible,
    keyMembershipRate: keyEligible ? keyMember / keyEligible : null,
  }
}

function chordAnchorMetrics(song, before, after) {
  let chords = 0, changed = 0, dropped = 0
  const intervals = song.chords?.filter((chord) => chord.confidence >= 0.5 && chord.beats > 0)
  const groups = intervals?.length
    ? intervals.map((chord) => before.flatMap((note, index) =>
      note.startBeat < chord.startBeat + chord.beats && note.startBeat + note.beats > chord.startBeat
        ? [index] : []))
    : [...groupsByOnset(before).values()].filter((indices) =>
      new Set(indices.map((index) => before[index].midi)).size > 1)
  for (const indices of groups) {
    if (!indices.length) continue
    const lowest = indices.reduce((best, next) =>
      before[next].midi < before[best].midi ? next : best, indices[0])
    chords++
    const result = after[lowest]
    if (!result || result.notPlayable) dropped++
    if (!result || result.notPlayable || result.midi !== before[lowest].midi) changed++
  }
  return { chordGroups: chords, lowestChanged: changed, lowestDropped: dropped }
}

function tabMetrics(notes, config, planFrettedTab) {
  if (!config) return null
  const planned = planFrettedTab(notes, config)
  const groups = new Map()
  notes.forEach((note, index) => {
    if (note.notPlayable) return
    const assigned = Number.isInteger(note.string) && Number.isInteger(note.fret)
      ? { string: note.string, fret: note.fret }
      : planned[index]?.position
    if (!assigned) return
    const beat = beatKey(note.startBeat)
    const group = groups.get(beat) ?? []
    group.push({ midi: note.midi, fret: assigned.fret })
    groups.set(beat, group)
  })
  const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0])
  const chords = ordered.filter(([, items]) => new Set(items.map((item) => item.midi)).size > 1)
    .map(([, items]) => items.map((item) => item.fret).filter((fret) => fret > 0))
    .filter((frets) => frets.length > 0)
    .map((frets) => Math.max(...frets) - Math.min(...frets))
  const centers = ordered.map(([, frets]) => {
    const held = frets.map((item) => item.fret).filter((fret) => fret > 0).sort((a, b) => a - b)
    return held.length ? held[Math.floor(held.length / 2)] : null
  }).filter((fret) => fret != null)
  const shifts = centers.slice(1).map((fret, index) => Math.abs(fret - centers[index]))
  return {
    chordGroups: chords.length,
    meanChordFretSpan: chords.length ? chords.reduce((sum, value) => sum + value, 0) / chords.length : null,
    maxChordFretSpan: chords.length ? Math.max(...chords) : null,
    positionTransitions: shifts.length,
    totalPositionShiftFrets: shifts.reduce((sum, value) => sum + value, 0),
    maxPositionShiftFrets: shifts.length ? Math.max(...shifts) : null,
  }
}

function noteMetrics(song, before, after, instrument, config, planFrettedTab) {
  let pitchChanged = 0, handChanged = 0, fingerChanged = 0, tabPositionChanged = 0
  let pitchClassChanged = 0, missing = 0, markedUnplayable = 0
  let changedInAnyWay = 0
  for (let index = 0; index < before.length; index++) {
    const source = before[index]
    const result = after[index]
    if (!result) { missing++; changedInAnyWay++; continue }
    if (result.notPlayable) markedUnplayable++
    const pitchDiff = result.midi !== source.midi
    const handDiff = result.hand !== source.hand
    const fingerDiff = result.finger !== source.finger
    const tabDiff = result.string !== source.string || result.fret !== source.fret
    if (pitchDiff) pitchChanged++
    if (pc(result.midi) !== pc(source.midi)) pitchClassChanged++
    if (handDiff) handChanged++
    if (fingerDiff) fingerChanged++
    if (tabDiff) tabPositionChanged++
    if (pitchDiff || handDiff || fingerDiff || tabDiff || result.notPlayable) changedInAnyWay++
  }
  return {
    notes: before.length,
    pitchChanged,
    ...(instrument === 'bass' ? { bassPitchChanged: pitchChanged } : {}),
    pitchClassChanged,
    pitchClassPreservationRate: before.length ? (before.length - pitchClassChanged) / before.length : null,
    handChanged,
    fingerChanged,
    tabPositionChanged,
    markedUnplayable,
    missing,
    changedInAnyWay,
    chordAnchor: chordAnchorMetrics(song, before, after),
    harmonyBefore: harmonyMembership(song, before),
    harmonyAfter: harmonyMembership(song, after.filter((note) => !note.notPlayable)),
    fretboard: tabMetrics(after, config, planFrettedTab),
  }
}

function drumStrokes(song, hits, writtenBeats, kitStrike) {
  const moments = new Map()
  hits.forEach((hit, index) => {
    if (kitStrike(hit).foot) return
    const beat = beatKey(writtenBeats[index] ?? hit.startBeat)
    const sound = `${hit.lane}:${hit.sourceMidi ?? ''}`
    const sounds = moments.get(beat) ?? new Map()
    const indexes = sounds.get(sound) ?? []
    indexes.push(index)
    sounds.set(sound, indexes)
    moments.set(beat, sounds)
  })
  return moments
}

function drumMetrics(song, before, after, modules) {
  const written = modules.drumNotationBeats(song)
  const originalMoments = drumStrokes(song, before, written, modules.kitStrike)
  const resultMoments = drumStrokes(song, after, written, modules.kitStrike)
  const impossible = [...resultMoments.values()].filter((sounds) => sounds.size > 2)
  const impossibleAssigned = impossible.reduce((sum, sounds) =>
    sum + [...sounds.values()].filter((indexes) => after[indexes[0]].hand).length, 0)
  const strokeEntries = [...resultMoments.entries()].flatMap(([beat, sounds]) =>
    [...sounds.entries()].map(([sound, indexes]) => ({ beat, sound, index: indexes[0] })))
  const assigned = strokeEntries.filter(({ index }) => after[index].hand).length
  let authoredHandsChanged = 0
  before.forEach((hit, index) => { if (hit.hand && hit.hand !== after[index]?.hand) authoredHandsChanged++ })
  const secondsPerBeat = 60 / (song.bpm > 0 ? song.bpm : 120)
  const strokes = strokeEntries.sort((a, b) => a.beat - b.beat || a.index - b.index)
  const lastByHand = new Map()
  const intervals = []
  for (const stroke of strokes) {
    const hit = after[stroke.index]
    if (!hit.hand) continue
    const previous = lastByHand.get(hit.hand)
    if (previous) {
      const seconds = (stroke.beat - previous.beat) * secondsPerBeat
      if (seconds > 1e-6) {
        const cymbal = ['hihat', 'openhat', 'ride', 'crash'].includes(hit.lane)
        const sameCymbal = cymbal && previous.cymbal && previous.sound === stroke.sound
        intervals.push({ seconds, limit: sameCymbal ? 0.14 : 0.3 })
      }
    }
    lastByHand.set(hit.hand, {
      beat: stroke.beat, sound: stroke.sound,
      cymbal: ['hihat', 'openhat', 'ride', 'crash'].includes(hit.lane),
    })
  }
  const fast = intervals.filter((item) => item.seconds < item.limit)
  return {
    sourceHits: before.length,
    outputHits: after.length,
    assignedHandStrokes: assigned,
    unassignedHandStrokes: strokeEntries.length - assigned,
    authoredHandsChanged,
    impossibleMoments: impossible.length,
    handStrokesAssignedAtImpossibleMoments: impossibleAssigned,
    sameHandRepeatIntervals: intervals.length,
    fasterThanTempoComfortLimit: fast.length,
    fastestSameHandRepeatMs: intervals.length ? Math.min(...intervals.map((item) => item.seconds)) * 1000 : null,
    minimumSameHandComfortLimitMs: intervals.length ? Math.min(...intervals.map((item) => item.limit)) * 1000 : null,
    sourceSimultaneousMoments: [...originalMoments.values()].filter((sounds) => sounds.size > 2).length,
  }
}

function targets(song, isGuitarTrack, isBassTrack) {
  const result = []
  const pianoTrack = song.tracks?.find((track) => track.group !== 'creative' && track.instrument === 'piano')
  if (song.piano?.length) result.push({ instrument: 'piano', track: pianoTrack })
  for (const track of song.tracks ?? []) {
    if (track.group === 'creative' || track.instrument !== 'other') continue
    if (isBassTrack(track)) result.push({ instrument: 'bass', track })
    else if (isGuitarTrack(track)) result.push({ instrument: 'guitar', track })
    else if (Number.isInteger(track.gmProgram) && track.gmProgram >= 0 && track.gmProgram <= 7) {
      result.push({ instrument: 'piano', track })
    }
  }
  const drums = song.tracks?.filter((track) => track.group !== 'creative' && track.instrument === 'drums') ?? []
  if (song.drums?.length) {
    if (drums.length) result.push(...drums.map((track) => ({ instrument: 'drums', track })))
    else result.push({ instrument: 'drums', track: null })
  }
  return result
}

function scopedSong(song, target) {
  if (target.instrument === 'drums' && target.track &&
      song.tracks.filter((track) => track.group !== 'creative' && track.instrument === 'drums').length > 1) {
    return { ...song, drums: song.drums.filter((hit) => hit.trackId === target.track.id) }
  }
  if (target.instrument === 'piano') {
    if (target.track?.instrument === 'other') {
      return { ...song, piano: song.instrumentNotes?.[target.track.id] ?? [] }
    }
    if (target.track?.id &&
        song.tracks.filter((track) => track.group !== 'creative' && track.instrument === 'piano').length > 1) {
      return { ...song, piano: song.piano.filter((note) => note.trackId === target.track.id) }
    }
  }
  return song
}

function selectedNotes(song, target) {
  if (target.instrument === 'drums') return song.drums ?? []
  if (target.instrument === 'piano') {
    return target.track?.instrument === 'other'
      ? song.instrumentNotes?.[target.track.id] ?? []
      : target.track?.id ? song.piano.filter((note) => note.trackId === target.track.id) : song.piano
  }
  return song.instrumentNotes?.[target.track.id] ?? []
}

const rows = []
let modules
let vite

function addAnalysis(group, title, song, target, planFrettedTab, current) {
  const source = selectedNotes(song, target)
  let pr8Result
  if (target.instrument === 'drums') {
    const hands = modules.pr8StickingFor(song).hands
    pr8Result = song.drums.map((hit, index) => hands[index] ? { ...hit, hand: hands[index] } : hit)
  } else if (target.instrument === 'piano' && target.track?.instrument === 'other') {
    pr8Result = modules.repairPiano(source, { bpm: song.bpm, pedals: song.pedals }).notes
  } else {
    const pr8Song = modules.applyPr8(song, target).song
    pr8Result = target.instrument === 'piano' ? pr8Song.piano
      : pr8Song.instrumentNotes?.[target.track.id] ?? source
  }
  const optimized = target.instrument === 'drums'
    ? current.song.drums
    : target.instrument === 'piano' && target.track?.instrument === 'other'
        ? current.song.piano
      : target.instrument === 'piano'
        ? current.song.piano
        : current.song.instrumentNotes?.[target.track.id] ?? source
  const config = target.instrument === 'guitar' ? modules.GUITAR
    : target.instrument === 'bass' ? modules.BASS : null
  const summary = current.summary
  const optimizerSummary = summary ? {
    flagged: summary.flagged, moved: summary.moved, octaveAdjusted: summary.octaveAdjusted,
    unplayableMoments: summary.unplayable, unplayableNotes: summary.unplayableNotes, warnings: summary.warnings,
  } : null
  if (target.instrument === 'drums') {
    rows.push({
      group, title, instrument: target.instrument, notes: source.length,
      trackName: target.track?.name ?? target.instrument, trackId: target.track?.id ?? null,
      pr8: drumMetrics(song, source, pr8Result, modules),
      postTranscription: drumMetrics(song, source, optimized, modules),
      optimizerSummary,
    })
    return
  }
  rows.push({
    group, title, instrument: target.instrument, notes: source.length,
    trackName: target.track?.name ?? target.instrument, trackId: target.track?.id ?? null,
    pr8: noteMetrics(song, source, pr8Result, target.instrument, config, planFrettedTab),
    postTranscription: noteMetrics(song, source, optimized, target.instrument, config, planFrettedTab),
    optimizerSummary,
  })
}

function lessonStickingComparison(lessons, lessonSong, suggestSticking, kitStrike) {
  const all = { lessons: 0, comparedStrokes: 0, matchingStrokes: 0, authoredSourcePreserved: 0, rudimentLessons: 0,
    rudimentComparedStrokes: 0, rudimentMatchingStrokes: 0 }
  for (const lesson of lessons) {
    const song = lessonSong(lesson)
    const authored = song.drums
    const expected = authored.map((hit) => hit.hand)
    const stripped = { ...song, drums: authored.map(({ hand: _hand, ...hit }) => hit) }
    const predicted = suggestSticking(stripped)
    let compared = 0, matched = 0
    authored.forEach((hit, index) => {
      if (!expected[index] || kitStrike(hit).foot) return
      compared++
      if (predicted[index] === expected[index]) matched++
      if (authored[index].hand === expected[index]) all.authoredSourcePreserved++
    })
    if (!compared) continue
    all.lessons++
    all.comparedStrokes += compared
    all.matchingStrokes += matched
    if (/rudiment|paradiddle|double-stroke|single-stroke|accent-control/i.test(`${lesson.id} ${lesson.title}`)) {
      all.rudimentLessons++
      all.rudimentComparedStrokes += compared
      all.rudimentMatchingStrokes += matched
    }
  }
  return {
    ...all,
    authoredAgreement: all.comparedStrokes ? all.matchingStrokes / all.comparedStrokes : null,
    rudimentAgreement: all.rudimentComparedStrokes ? all.rudimentMatchingStrokes / all.rudimentComparedStrokes : null,
  }
}

try {
  vite = await createServer({ root: uiRoot, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  const currentModule = await vite.ssrLoadModule('/src/workspace/playability.ts')
  const legacyModule = await vite.ssrLoadModule(`/src/workspace/${legacyFile.split(/[\\/]/).at(-1)}`)
  const legacySticking = await vite.ssrLoadModule(`/src/workspace/${legacyStickingFile.split(/[\\/]/).at(-1)}`)
  const fretboard = await vite.ssrLoadModule('/src/workspace/fretboard.ts')
  const guitar = await vite.ssrLoadModule('/src/workspace/guitar.ts')
  const bass = await vite.ssrLoadModule('/src/workspace/bass.ts')
  const kit = await vite.ssrLoadModule('/src/workspace/kit.ts')
  const musicxml = await vite.ssrLoadModule('/src/workspace/musicxml.ts')
  const sticking = await vite.ssrLoadModule('/src/workspace/sticking.ts')
  const curriculum = await vite.ssrLoadModule('/src/course/curriculum.ts')
  const piano = await vite.ssrLoadModule('/src/course/piano.ts')
  const pianoInspired = await vite.ssrLoadModule('/src/course/pianoInspired.ts')
  const fretted = await vite.ssrLoadModule('/src/course/fretted.ts')
  const frettedInspired = await vite.ssrLoadModule('/src/course/frettedInspired.ts')
  modules = {
    applyPr8: legacyModule.applyPlayability,
    repairPiano: legacyModule.repairPiano,
    pr8StickingFor: legacySticking.stickingFor,
    suggestSticking: sticking.suggestSticking,
    drumNotationBeats: musicxml.drumNotationBeats,
    kitStrike: kit.kitStrike,
    GUITAR: fretboard.GUITAR,
    BASS: fretboard.BASS,
  }
  const analyzeSong = (group, title, song) => {
    const prepared = currentModule.preparePlayableSong(song)
    const currentSong = prepared.song
    for (const target of targets(song, guitar.isGuitarTrack, bass.isBassTrack)) {
      const partSong = scopedSong(song, target)
      const currentInput = { ...currentSong, piano: partSong.piano, drums: partSong.drums }
      const current = currentModule.applyPlayability(currentInput, target.instrument === 'drums'
        ? { instrument: null, track: target.track }
        : target)
      addAnalysis(group, title, partSong, target, fretboard.planFrettedTab, current)
    }
  }

  const lesson = [...curriculum.LESSONS]
  for (const item of lesson) analyzeSong('lesson corpus', item.id, curriculum.lessonSong(item))
  for (const item of [...piano.PIANO_LESSONS, ...pianoInspired.PIANO_INSPIRED]) {
    analyzeSong('lesson corpus', item.id, piano.pianoLessonSong(item))
  }
  for (const item of [...fretted.FRETTED_LESSONS, ...frettedInspired.GUITAR_SONG_STUDIES, ...frettedInspired.BASS_SONG_STUDIES]) {
    if ('bars' in item) analyzeSong('lesson corpus', item.id, fretted.frettedLessonSong(item))
  }

  const folder = process.argv[2] ?? process.env.MIZAN_SONGS_DIR
  if (folder && existsSync(folder)) {
    for (const id of readdirSync(folder)) {
      const file = join(folder, id, 'analysis.json')
      if (!existsSync(file)) continue
      const song = JSON.parse(readFileSync(file, 'utf8'))
      if (song.tracks && song.piano && song.drums) analyzeSong('cached songs', `${song.title ?? id} (${id.slice(0, 8)})`, song)
    }
  }

  const drumLesson = lessonStickingComparison(lesson, curriculum.lessonSong, sticking.suggestSticking, kit.kitStrike)
  console.log(JSON.stringify({ baselineRef, rows, drumLessonSticking: drumLesson }, null, 2))
} finally {
  if (vite) await vite.close()
  if (existsSync(legacyFile)) unlinkSync(legacyFile)
  if (existsSync(legacyStickingFile)) unlinkSync(legacyStickingFile)
}
