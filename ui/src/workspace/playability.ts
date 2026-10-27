import { keyOf, pedalCarries, pianoKeyReleases, suggestFingers } from './fingers'
import {
  BASS, GUITAR, identifiesInstrument, planFrettedTab, positionsForMidi,
  type FrettedInstrumentConfig, type FrettedPosition,
} from './fretboard'
import { kitStrike } from './kit'
import { drumNotationBeats } from './musicxml'
import { suggestSticking } from './sticking'
import type {
  Chord, DrumHit, MelodyNote, Pedal, PianoNote, PlayabilitySummary, Song, StoredPlayability, Track,
} from './song'

export type { PlayabilityIssue, PlayabilitySummary } from './song'

/**
 * Playability checks and repairs for transcribed music. Transcribers and importers split piano notes between the hands by
 * pitch alone and pick a guitar string for each note on its own, so a moment can ask one hand for more than it can do.
 * Repairs are stored as a separate derived layer; the source notes remain unchanged.
 */

const EPS = 1e-6
export const PLAYABILITY_VERSION = 'constrained-path-v5'

/** Most keys one hand can hold down at once. */
export const PIANO_MAX_NOTES = 5
/** Widest comfortable stretch in semitones (a ninth), and the wider one (a tenth) allowed only where no better split exists. */
export const PIANO_REACH = 14
export const PIANO_WIDE_REACH = 16
/** A hand cannot cover more than this many semitones between two attacks closer together than this many seconds. */
const JUMP_SEMITONES = 24
const JUMP_SECONDS = 0.12
/** Crossed hands are tolerated for a short moment. */
const CROSS_SECONDS = 0.5
/** Without written pedals, a held note this far below the hand's newest notes is taken as carried by the sustain pedal. */
const PEDAL_GAP = 9
const BEAM = 6

const empty = (instrument: PlayabilitySummary['instrument']): PlayabilitySummary =>
  ({ instrument, flagged: 0, moved: 0, octaveAdjusted: 0, unplayable: 0, unplayableNotes: 0, warnings: 0, issues: [] })

const tally = (map: Map<number, number>, beat: number) => map.set(beat, (map.get(beat) ?? 0) + 1)

// ---------------------------------------------------------------- piano

export type PianoPlayabilityOptions = {
  bpm?: number
  reach?: number
  wideReach?: number
  crossSeconds?: number
  /** Written pedals: where there are any, they decide which held notes a pedal carries instead of the gap guess. */
  pedals?: readonly Pedal[]
}

export function repairPiano(
  input: readonly PianoNote[],
  options: PianoPlayabilityOptions = {},
): { notes: PianoNote[]; summary: PlayabilitySummary } {
  const reach = options.reach ?? PIANO_REACH
  const wide = Math.max(reach, options.wideReach ?? PIANO_WIDE_REACH)
  const secondsPerBeat = 60 / (options.bpm && options.bpm > 0 ? options.bpm : 120)
  const crossBeats = (options.crossSeconds ?? CROSS_SECONDS) / secondsPerBeat
  const summary = empty('piano')
  const written = !!options.pedals?.length

  const ids: number[] = []
  input.forEach((note, index) => { if (note.hand && Number.isFinite(note.midi) && note.beats > 0) ids.push(index) })
  const keys = ids.map((index) => keyOf(input[index].midi))
  const start = ids.map((index) => input[index].startBeat)
  const end = ids.map((index) => input[index].startBeat + input[index].beats)
  const original = Uint8Array.from(ids, (index) => input[index].hand === 'left' ? 0 : 1)
  const hand = Uint8Array.from(original)

  // One moment per onset: everything sounding then, held notes included.
  const order = [...ids.keys()].sort((a, b) => start[a] - start[b] || a - b)
  const onsets: number[] = []
  const moments: number[][] = []
  const starts: number[][] = []
  const momentsOf: number[][] = ids.map(() => [])
  let active: number[] = []
  let next = 0
  for (const first of order) {
    if (onsets.length && start[first] - onsets[onsets.length - 1] <= EPS) continue
    const at = start[first]
    const arriving: number[] = []
    while (next < order.length && start[order[next]] <= at + EPS) arriving.push(order[next++])
    active = active.filter((note) => end[note] > at + EPS).concat(arriving)
    const sorted = [...active].sort((a, b) => keys[a] - keys[b] || a - b)
    for (const note of sorted) momentsOf[note].push(onsets.length)
    onsets.push(at)
    moments.push(sorted)
    starts.push(arriving)
  }
  const count = onsets.length
  const tier = new Array<number>(count).fill(reach)
  let crossLong = new Uint8Array(count)
  const flaggedMoments = new Set<number>()

  const crossedAt = (moment: number) => {
    let leftTop = -Infinity
    let rightBottom = Infinity
    for (const note of moments[moment]) {
      if (hand[note] === 0) leftTop = Math.max(leftTop, keys[note])
      else rightBottom = Math.min(rightBottom, keys[note])
    }
    return leftTop > rightBottom
  }
  const momentEnd = (moment: number) => moment + 1 < count ? onsets[moment + 1]
    : Math.min(...moments[moment].map((note) => end[note]))
  const crossRuns = () => {
    const result = new Uint8Array(count)
    const crossed = Uint8Array.from({ length: count }, (_, moment) => crossedAt(moment) ? 1 : 0)
    for (let moment = 0; moment < count; moment++) {
      if (!crossed[moment]) continue
      let last = moment
      while (last + 1 < count && crossed[last + 1]) last++
      if (momentEnd(last) - onsets[moment] > crossBeats + EPS) result.fill(1, moment, last + 1)
      moment = last
    }
    return result
  }

  /**
   * How far a moment is from playable: surplus keys and surplus stretch, plus crossing where it has gone on too long.
   * A held note the hand has left is taken as carried by the sustain pedal: where pedals are written, one that really carries
   * it (sustain down for the rest of the note, or sostenuto pressed while it was held); otherwise a bass note struck earlier
   * and now at least a sixth below everything the hand has played since is assumed to be pedalled.
   */
  const excess = (moment: number, allowed: number) => {
    const latest = [-Infinity, -Infinity]
    const latestLow = [Infinity, Infinity]
    for (const note of moments[moment]) {
      const side = hand[note]
      if (start[note] > latest[side] + EPS) { latest[side] = start[note]; latestLow[side] = keys[note] }
      else if (start[note] > latest[side] - EPS && keys[note] < latestLow[side]) latestLow[side] = keys[note]
    }
    const counts = [0, 0]
    const lastKey = [NaN, NaN]
    const low = [Infinity, Infinity]
    const high = [-Infinity, -Infinity]
    for (const note of moments[moment]) {
      const side = hand[note]
      if (start[note] < latest[side] - EPS) {
        if (written ? pedalCarries(options.pedals, start[note], end[note], latest[side]) : keys[note] <= latestLow[side] - PEDAL_GAP) continue
      }
      if (keys[note] !== lastKey[side]) { counts[side]++; lastKey[side] = keys[note] }
      low[side] = Math.min(low[side], keys[note])
      high[side] = Math.max(high[side], keys[note])
    }
    let total = 0
    for (const side of [0, 1])
      if (counts[side]) total += Math.max(0, counts[side] - PIANO_MAX_NOTES) * 4 + Math.max(0, high[side] - low[side] - allowed)
    if (crossLong[moment] && counts[0] && counts[1] && high[0] > low[1]) total += 3
    return total
  }

  crossLong = crossRuns()
  for (let moment = 0; moment < count; moment++) if (excess(moment, reach) > 0) flaggedMoments.add(moment)

  const apply = (changes: [number, number][]) => { for (const [note, side] of changes) hand[note] = side }
  const touched = (changes: [number, number][]) => {
    const set = new Set<number>()
    for (const [note] of changes) for (const moment of momentsOf[note]) set.add(moment)
    return set
  }

  const fix = (moment: number) => {
    const groups: number[][] = []
    for (const note of moments[moment]) {
      const last = groups[groups.length - 1]
      if (last && keys[last[0]] === keys[note]) last.push(note)
      else groups.push([note])
    }
    if (groups.length < 2) return
    const splits = (): { changes: [number, number][]; k: number }[] =>
      Array.from({ length: groups.length - 1 }, (_, at) => {
        const k = at + 1
        const changes: [number, number][] = []
        groups.forEach((group, g) => { for (const note of group) if (hand[note] !== (g < k ? 0 : 1)) changes.push([note, g < k ? 0 : 1]) })
        return { changes, k }
      })
    const previous = moment ? moments[moment - 1] : []
    const cost = (changes: [number, number][], k: number) => {
      const before = changes.map(([note]) => [note, hand[note]] as const)
      apply(changes)
      let continuity = 0
      for (const note of starts[moment]) {
        let nearest = -1
        for (const other of previous)
          if (nearest < 0 || Math.abs(keys[other] - keys[note]) < Math.abs(keys[nearest] - keys[note])) nearest = other
        if (nearest >= 0 && hand[nearest] !== hand[note]) continuity++
      }
      for (const [note, side] of before) hand[note] = side
      const gap = keys[groups[k][0]] - keys[groups[k - 1][0]]
      return changes.length * 10 + continuity + Math.abs(k - (groups.length - k)) * 0.2 - Math.min(gap, 12) * 0.15
    }
    for (const allowed of reach === wide ? [reach] : [reach, wide]) {
      let best: { changes: [number, number][]; score: number } | null = null
      for (const { changes, k } of splits()) {
        const previousHands = changes.map(([note]) => [note, hand[note]] as const)
        const revert = () => { for (const [note, side] of previousHands) hand[note] = side }
        // The moment itself is checked first: most splits fail there, and the held notes' other moments cost more to check.
        apply(changes)
        let fine = excess(moment, allowed) === 0
        let around: number[] = []
        let after: number[] = []
        if (fine) {
          around = [...touched(changes)].filter((other) => other !== moment)
          after = around.map((other) => excess(other, tier[other]))
        }
        revert()
        if (fine) fine = around.every((other, at) => after[at] <= excess(other, tier[other]))
        if (!fine) continue
        const score = cost(changes, k)
        if (!best || score < best.score - 1e-9) best = { changes, score }
      }
      if (best) {
        apply(best.changes)
        tier[moment] = allowed
        return
      }
    }
    // Nothing is playable: take the least-bad split, or keep what was written if it is no worse.
    let bestExcess = excess(moment, wide)
    let choice: [number, number][] = []
    let bestChanges = 0
    for (const { changes } of splits()) {
      const previousHands = changes.map(([note]) => [note, hand[note]] as const)
      apply(changes)
      const value = excess(moment, wide)
      for (const [note, side] of previousHands) hand[note] = side
      if (value < bestExcess || value === bestExcess && changes.length < bestChanges && choice.length) {
        bestExcess = value
        choice = changes
        bestChanges = changes.length
      }
    }
    apply(choice)
    tier[moment] = wide
  }

  for (let pass = 0; pass < 3; pass++) {
    crossLong = crossRuns()
    const snapshot = hand.join('')
    for (let moment = 0; moment < count; moment++) if (excess(moment, tier[moment]) > 0) fix(moment)
    if (hand.join('') === snapshot) break
  }

  // A note-count or overall span check cannot catch a chord whose fingers leave no reachable finger for the next
  // melody note. Reassign an intact, sustained onset/voicing group only when the shared fingering model confirms that
  // doing so makes more of the passage playable without worsening any existing count/span allocation.
  const fingeringFailures = new Set<number>()
  crossLong = crossRuns()
  const passages: number[][] = []
  const releases = pianoKeyReleases(input, options.pedals, { inferBassPedalGap: !written })
  let passageEnd = -Infinity
  for (const local of order) {
    if (!passages.length || start[local] >= passageEnd - EPS) {
      passages.push([])
      passageEnd = -Infinity
    }
    passages[passages.length - 1].push(local)
    passageEnd = Math.max(passageEnd, releases.get(input[ids[local]]) ?? end[local])
  }
  for (const passage of passages) {
    if (!passage.some((local) => momentsOf[local].some((moment) => starts[moment].some((other) =>
      start[other] > start[local] + EPS && hand[other] === hand[local])))) continue
    type FingeringCandidate = { notes: number[]; triggers: Set<number> }
    const makeSuggestions = () => {
      const placed = passage.map((local) => ({
        ...input[ids[local]], hand: hand[local] === 0 ? 'left' as const : 'right' as const,
      }))
      const suggestions = suggestFingers(placed, options.pedals, {
        bpm: options.bpm, inferBassPedalGap: !written,
      })
      const missing: number[] = []
      for (let index = 0; index < placed.length; index++) if (!suggestions.has(placed[index])) missing.push(passage[index])
      return missing
    }

    const unresolved = new Set<number>()
    for (let pass = 0; pass < passage.length; pass++) {
      const current = makeSuggestions()
      if (!current.length) break
      for (const local of current) flaggedMoments.add(momentsOf[local][0])
      const first = current.find((local) => !unresolved.has(local))
      if (first === undefined) break
      const candidates = new Map<string, FingeringCandidate>()
      for (const local of current.filter((note) => Math.abs(start[note] - start[first]) <= EPS)) {
        const moment = momentsOf[local][0]
        const activeByVoice = new Map<string, number[]>()
        const lowerHeld: number[] = []
        for (const other of moments[moment]) {
          if (hand[other] !== hand[local] || end[other] <= start[local] + EPS) continue
          const key = `${start[other]}`
          const group = activeByVoice.get(key) ?? []
          group.push(other)
          activeByVoice.set(key, group)
          if (start[other] < start[local] - EPS && keys[other] < keys[local]) lowerHeld.push(other)
        }
        for (const notes of [...activeByVoice.values(), lowerHeld]) {
          if (!notes.length) continue
          const ordered = [...notes].sort((a, b) => a - b)
          const key = ordered.join(',')
          const candidate = candidates.get(key) ?? { notes: ordered, triggers: new Set<number>() }
          candidate.triggers.add(local)
          candidates.set(key, candidate)
        }
      }

      let best: { candidate: FingeringCandidate; missing: number; targetMoved: number; above: number } | null = null
      for (const candidate of candidates.values()) {
        const affected = new Set(candidate.notes.flatMap((note) => momentsOf[note]))
        const previousExcess = new Map([...affected].map((moment) => [moment, excess(moment, tier[moment])]))
        const previousCross = crossLong
        for (const note of candidate.notes) hand[note] = hand[note] === 0 ? 1 : 0
        crossLong = crossRuns()
        const fitsAllocation = !crossLong.some((crossed, moment) => crossed && !previousCross[moment]) &&
          [...affected].every((moment) => excess(moment, tier[moment]) <= (previousExcess.get(moment) ?? 0))
        const next = fitsAllocation ? makeSuggestions() : null
        for (const note of candidate.notes) hand[note] = hand[note] === 0 ? 1 : 0
        crossLong = previousCross
        const missing = new Set(current)
        if (!next || next.length >= current.length || next.some((note) => !missing.has(note))) continue
        const targetMoved = candidate.notes.some((note) => missing.has(note)) ? 1 : 0
        const targetKeys = [...candidate.triggers].map((note) => keys[note])
        const candidateCenter = candidate.notes.reduce((sum, note) => sum + keys[note], 0) / candidate.notes.length
        const targetCenter = targetKeys.reduce((sum, key) => sum + key, 0) / targetKeys.length
        const above = candidateCenter > targetCenter ? 1 : 0
        const score = { candidate, missing: next.length, targetMoved, above }
        if (!best || score.missing < best.missing ||
          score.missing === best.missing && (score.targetMoved < best.targetMoved ||
            score.targetMoved === best.targetMoved && (score.above < best.above ||
              score.above === best.above && score.candidate.notes.length > best.candidate.notes.length))) best = score
      }
      if (!best) {
        unresolved.add(first)
        continue
      }
      for (const note of best.candidate.notes) hand[note] = hand[note] === 0 ? 1 : 0
      crossLong = crossRuns()
    }
    for (const local of makeSuggestions()) fingeringFailures.add(momentsOf[local][0])
  }

  summary.flagged = flaggedMoments.size
  crossLong = crossRuns()
  const failed = new Set<number>(fingeringFailures)
  for (let moment = 0; moment < count; moment++) if (excess(moment, tier[moment]) > 0) failed.add(moment)
  summary.unplayable = failed.size

  const replaced = new Map<number, PianoNote>()
  const movedAt = new Map<number, number>()
  ids.forEach((index, local) => {
    if (hand[local] === original[local]) return
    const { finger: _dropped, ...rest } = input[index]
    replaced.set(index, { ...rest, hand: hand[local] === 0 ? 'left' : 'right', adjusted: true })
    tally(movedAt, input[index].startBeat)
    summary.moved++
  })
  for (const moment of failed) {
    let marked = 0
    for (const local of starts[moment]) {
      const index = ids[local]
      replaced.set(index, { ...(replaced.get(index) ?? input[index]), notPlayable: true })
      marked++
    }
    summary.unplayableNotes += marked
    summary.issues.push({ beat: onsets[moment], kind: 'unplayable', count: marked })
  }
  for (const [beat, moved] of movedAt) summary.issues.push({ beat, kind: 'moved', count: moved })

  // Quick jumps are only warned about.
  for (const side of [0, 1]) {
    let before: { beat: number; low: number; high: number } | null = null
    for (let moment = 0; moment < count; moment++) {
      const played = starts[moment].filter((note) => hand[note] === side)
      if (!played.length) continue
      const now = { beat: onsets[moment], low: Math.min(...played.map((note) => keys[note])), high: Math.max(...played.map((note) => keys[note])) }
      if (before) {
        const distance = Math.max(0, now.low - before.high, before.low - now.high)
        if (distance > JUMP_SEMITONES && (now.beat - before.beat) * secondsPerBeat < JUMP_SECONDS) {
          summary.warnings++
          summary.issues.push({ beat: now.beat, kind: 'jump', count: 1 })
        }
      }
      before = now
    }
  }
  summary.issues.sort((a, b) => a.beat - b.beat)

  if (!replaced.size) return { notes: input as PianoNote[], summary }
  const notes = input.map((note, index) => replaced.get(index) ?? note)
  // Written fingering stays where a note kept its hand; moved notes get a suggestion in place of the finger they lost.
  if (input.some((note) => note.finger)) {
    const suggestions = suggestFingers(notes, options.pedals, { bpm: options.bpm })
    for (const [index, note] of replaced) {
      if (!note.adjusted) continue
      const suggestion = suggestions.get(notes[index])
      if (suggestion && suggestion.hand === note.hand) notes[index] = { ...note, finger: suggestion.finger as PianoNote['finger'] }
    }
  }
  return { notes, summary }
}

// ---------------------------------------------------------------- guitar and bass

type Pos = { string: number; fret: number }
type Candidate = Pos & { midi: number; octaveFold: boolean }
export type FrettedNote = MelodyNote & { string?: number; fret?: number }

const CHORD_SHAPES = [
  [0, 3, 7], [0, 4, 7], [0, 3, 6], [0, 4, 8], [0, 5, 7],
  [0, 3, 6, 9], [0, 3, 6, 10], [0, 3, 7, 10], [0, 4, 7, 10], [0, 4, 7, 11],
]
const pitchClass = (midi: number) => (midi % 12 + 12) % 12

function inferredChordTones(notes: readonly { midi: number }[]): Set<number> | null {
  const pitches = new Set(notes.map((note) => pitchClass(note.midi)))
  if (pitches.size < 3 || pitches.size > 4) return null
  const soundsLikeChord = CHORD_SHAPES.some((shape) =>
    Array.from({ length: 12 }, (_, root) => new Set(shape.map((step) => (root + step) % 12)))
      .some((candidate) => [...pitches].every((pitch) => candidate.has(pitch))))
  return soundsLikeChord ? pitches : null
}

/**
 * Widest stretch in frets the fretting hand covers (highest fret minus lowest). Frets are widest nearest the nut and
 * on a bass, so the reach shrinks there, and narrower from the seventh up on a guitar, so it grows.
 */
export const frettedReach = (config: FrettedInstrumentConfig, lowestFret: number) =>
  config.id === 'bass' ? (lowestFret <= 3 ? 3 : 4) : lowestFret <= 2 ? 3 : lowestFret >= 7 ? 5 : 4

/** Whether one hand can hold these positions at once: free strings, four fingers (one may bar a fret), a reachable stretch. */
export function shapeFits(items: readonly Pos[], config: FrettedInstrumentConfig): boolean {
  let used = 0
  let low = Infinity
  let high = -1
  for (const item of items) {
    const bit = 1 << item.string
    if (used & bit) return false
    used |= bit
    if (item.fret > 0) {
      if (item.fret < low) low = item.fret
      if (item.fret > high) high = item.fret
    }
  }
  if (high < 0) return true
  if (high - low > frettedReach(config, low)) return false
  let fingers = 0
  for (let at = 0; at < items.length; at++) {
    const fret = items[at].fret
    if (fret <= 0) continue
    let seen = false
    for (let before = 0; before < at; before++) if (items[before].fret === fret) { seen = true; break }
    if (seen) continue
    let count = 0
    let first = Infinity
    let last = -1
    for (const item of items) if (item.fret === fret) {
      count++
      if (item.string < first) first = item.string
      if (item.string > last) last = item.string
    }
    // One finger bars a run of strings on one fret; the lowest fret may also be barred across gaps.
    fingers += fret === low || last - first + 1 === count ? 1 : count
  }
  return fingers <= 4
}

type Item = { index: number; midi: number; start: number; end: number; candidates: Candidate[]; originallyPlayable: boolean; preferred?: Pos }
type Placed = { index: number; midi: number; string: number; fret: number; end: number }
type Node = { cost: number; pos: number | null; active: Placed[]; parent: Node | null; placed: Placed[]; dropped: number[]; key: string }

const sameSpot = (a?: Pos, b?: Pos) => !!a && !!b && a.string === b.string && a.fret === b.fret

export function repairFretted(
  input: readonly FrettedNote[],
  config: FrettedInstrumentConfig,
  options: { chords?: readonly Chord[] } = {},
): { notes: FrettedNote[]; summary: PlayabilitySummary } {
  const summary = empty(config.id)
  const baseline = planFrettedTab(input, config)
  const items: Item[] = []
  for (const [index, note] of input.entries()) {
    if (!Number.isInteger(note.midi) || !(note.beats > 0)) continue
    const given = baseline[index].position
    const preferred = given ? { string: given.string, fret: given.fret } : undefined
    items.push({ index, midi: note.midi, start: note.startBeat, end: note.startBeat + note.beats,
      candidates: [], originallyPlayable: false, preferred })
  }
  items.sort((a, b) => a.start - b.start || a.index - b.index)

  const theoryNotes = new Set<number>()
  const chordAt = (beat: number) => options.chords?.find((chord) =>
    chord.confidence >= 0.5 && chord.tones.length > 0 &&
    chord.startBeat <= beat + EPS && chord.startBeat + chord.beats > beat + EPS)
  for (let first = 0; first < items.length;) {
    let last = first + 1
    while (last < items.length && items[last].start - items[first].start <= EPS) last++
    const group = items.slice(first, last)
    const chord = chordAt(group[0].start)
    const tones = chord ? new Set(chord.tones.map(pitchClass)) : inferredChordTones(group)
    if (tones) for (const item of group) if (tones.has(pitchClass(item.midi))) theoryNotes.add(item.index)
    first = last
  }

  const byMidi = new Map<number, FrettedPosition[]>()
  const positions = (midi: number) => {
    let found = byMidi.get(midi)
    if (!found) byMidi.set(midi, found = positionsForMidi(midi, config))
    return found
  }
  for (const item of items) {
    const originalPositions = positions(item.midi)
    item.originallyPlayable = originalPositions.length > 0
    const pitches = [item.midi]
    if (theoryNotes.has(item.index)) pitches.push(item.midi - 12, item.midi + 12)
    item.candidates = pitches.flatMap((midi) =>
      positions(midi).map((place) => ({ string: place.string, fret: place.fret, midi, octaveFold: midi !== item.midi })))
      .sort((a, b) => {
        const preferredA = !a.octaveFold && sameSpot(a, item.preferred) ? 1 : 0
        const preferredB = !b.octaveFold && sameSpot(b, item.preferred) ? 1 : 0
        return preferredB - preferredA || Number(a.octaveFold) - Number(b.octaveFold) || a.fret - b.fret || a.string - b.string
      })
  }
  for (let index = items.length - 1; index >= 0; index--)
    if (!items[index].candidates.length) items.splice(index, 1)

  const bassAnchors = new Set<number>()
  if (config.id === 'guitar') {
    for (const chord of options.chords ?? []) {
      if (chord.confidence < 0.5 || chord.beats <= 0) continue
      const sounding = items.filter((item) =>
        item.start < chord.startBeat + chord.beats && item.end > chord.startBeat)
      if (sounding.length) {
        const lowest = sounding.reduce((best, next) => next.midi < best.midi ? next : best)
        bassAnchors.add(lowest.index)
      }
    }
  }

  const bassFloorByItem = new Map<number, number>()
  if (config.id === 'guitar') {
    const playable = items.filter((item) => item.originallyPlayable)
    const starts = [...playable].sort((a, b) => a.start - b.start || a.index - b.index)
    const ends = [...playable].sort((a, b) => a.end - b.end || a.index - b.index)
    const times = [...new Set(playable.flatMap((item) => [item.start, item.end]))].sort((a, b) => a - b)
    const activeAtPitch = Array.from({ length: 128 }, () => new Set<number>())
    const counts = new Array<number>(128).fill(0)
    const active = new Set<number>()
    const floors: (number | null)[] = []
    let nextStart = 0
    let nextEnd = 0
    for (const beat of times) {
      while (nextEnd < ends.length && ends[nextEnd].end <= beat + EPS) {
        const item = ends[nextEnd++]
        if (!active.delete(item.index)) continue
        activeAtPitch[item.midi].delete(item.index)
        counts[item.midi]--
      }
      while (nextStart < starts.length && starts[nextStart].start <= beat + EPS) {
        const item = starts[nextStart++]
        if (item.end <= beat + EPS) continue
        active.add(item.index)
        activeAtPitch[item.midi].add(item.index)
        counts[item.midi]++
      }
      let lowest = 0
      while (lowest < counts.length && counts[lowest] === 0) lowest++
      const floor = lowest < counts.length ? lowest : null
      floors.push(floor)
      if (floor !== null) for (const index of activeAtPitch[floor]) bassAnchors.add(index)
    }

    let treeSize = 1
    while (treeSize < floors.length) treeSize *= 2
    const floorTree = new Array<number>(treeSize * 2).fill(-Infinity)
    floors.forEach((floor, index) => { floorTree[treeSize + index] = floor ?? -Infinity })
    for (let node = treeSize - 1; node > 0; node--)
      floorTree[node] = Math.max(floorTree[node * 2], floorTree[node * 2 + 1])

    const lowerBound = (beat: number) => {
      let low = 0
      let high = times.length
      while (low < high) {
        const middle = (low + high) >> 1
        if (times[middle] < beat) low = middle + 1
        else high = middle
      }
      return low
    }
    for (const item of items) {
      let left = lowerBound(item.start - EPS) + treeSize
      let right = lowerBound(item.end - EPS) + treeSize
      let floor = -Infinity
      while (left < right) {
        if (left % 2) floor = Math.max(floor, floorTree[left++])
        if (right % 2) floor = Math.max(floor, floorTree[--right])
        left = Math.floor(left / 2)
        right = Math.floor(right / 2)
      }
      if (Number.isFinite(floor)) bassFloorByItem.set(item.index, floor)
    }
  }

  const groups: Item[][] = []
  const originalGroups: Item[][] = []
  for (const item of items) {
    const group = groups[groups.length - 1]
    if (group && item.start - group[0].start <= EPS) group.push(item)
    else groups.push([item])
    const originalGroup = originalGroups[originalGroups.length - 1]
    if (originalGroup && item.start - originalGroup[0].start <= EPS) originalGroup.push(item)
    else originalGroups.push([item])
  }

  // Moments the notes as first placed cannot play.
  const where = new Map(items.map((item) => [item.index, item]))
  const bad: number[] = []
  let sounding: Item[] = []
  originalGroups.forEach((group) => {
    const t = group[0].start
    sounding = sounding.filter((item) => item.end > t + EPS).concat(group)
    const spots = sounding.map((item) => baseline[item.index].position)
    if (spots.some((spot) => !spot) || !shapeFits(spots as Pos[], config)) bad.push(t)
  })
  summary.flagged = bad.length
  if (!bad.length && !items.some((item) => !item.originallyPlayable)) return { notes: input as FrettedNote[], summary }

  // Keep alternate positions for held notes around an impossible moment so a greedy prefix cannot force a later drop.
  const criticalGroups = new Set<number>()
  for (const beat of bad) {
    groups.forEach((group, index) => {
      if (group[0].start <= beat + EPS && group.some((item) => item.end > beat + EPS)) criticalGroups.add(index)
    })
  }

  /** What a placement costs: stretch, hand movement, higher frets, octave folds, and leaving the first placement. */
  const leafOf = (held: Placed[], chosen: Placed[], pos: number | null, anchors: ReadonlySet<number>) => {
    const fretted = held.concat(chosen).filter((item) => item.fret > 0).map((item) => item.fret)
    let cost = 0
    let nextPos = pos
    if (fretted.length) {
      const low = Math.min(...fretted)
      cost += (Math.max(...fretted) - low) * 0.5
      nextPos = low
      if (pos !== null) cost += Math.abs(low - pos)
    }
    for (const place of chosen) {
      const item = where.get(place.index)!
      cost += place.fret * 0.02
      if (place.midi !== item.midi) cost += anchors.has(place.index) ? 24 : 12
      if (!sameSpot(item.preferred, place) || place.midi !== item.midi) cost += 6
    }
    return { placed: chosen, cost, pos: nextPos }
  }

  const enumerate = (kept: Item[], held: Placed[], pos: number | null,
    endpoints: ReadonlySet<number>, allowOctaveFolds = false) => {
    const order = [...kept].sort((a, b) => a.candidates.length - b.candidates.length || a.midi - b.midi || a.index - b.index)
    const leaves: { placed: Placed[]; cost: number; pos: number | null }[] = []
    const chosen: Placed[] = []
    const stack: Placed[] = held.slice()
    let visits = 0
    const walk = (depth: number) => {
      if (visits > 48) return
      if (depth === order.length) {
        visits++
        leaves.push(leafOf(held, [...chosen], pos, endpoints))
        return
      }
      const item = order[depth]
      const bassFloor = bassFloorByItem.get(item.index)
      // A fold must not move a playable guitar bass anchor or create a lower note than it.
      for (const candidate of item.candidates.filter((place) =>
        !place.octaveFold || allowOctaveFolds &&
          (config.id === 'guitar' || !endpoints.has(item.index)) &&
          !(config.id === 'guitar' && bassAnchors.has(item.index) && item.originallyPlayable) &&
          (config.id !== 'guitar' || bassFloor === undefined || place.midi >= bassFloor))) {
        const place: Placed = { index: item.index, midi: candidate.midi, string: candidate.string, fret: candidate.fret, end: item.end }
        stack.push(place)
        if (!shapeFits(stack, config)) { stack.pop(); continue }
        chosen.push(place)
        walk(depth + 1)
        chosen.pop()
        stack.pop()
      }
    }
    walk(0)
    return leaves.sort((a, b) => a.cost - b.cost).slice(0, 4)
  }

  const uniqueLeaves = (leaves: { placed: Placed[]; cost: number; pos: number | null }[]) => {
    const unique = new Map<string, typeof leaves[number]>()
    for (const leaf of leaves) {
      const key = leaf.placed.map((place) =>
        `${place.index}:${place.string}:${place.fret}:${place.midi}`).sort().join('|')
      if (!unique.has(key)) unique.set(key, leaf)
    }
    return [...unique.values()].sort((a, b) => a.cost - b.cost).slice(0, 4)
  }

  let beam: Node[] = [{ cost: 0, pos: null, active: [], parent: null, placed: [], dropped: [], key: '' }]
  for (const [groupIndex, group] of groups.entries()) {
    const t = group[0].start
    const byMidi = [...group].sort((a, b) => a.midi - b.midi || a.index - b.index)
    // Keep the bass anchor and distinct chord tones; redundant tones are the first to go.
    const priority: Item[] = []
    for (let low = 0, high = byMidi.length - 1; low <= high; low++, high--) {
      priority.push(byMidi[low])
      if (high !== low) priority.push(byMidi[high])
    }
    const rank = new Map(priority.map((item, index) => [item.index, index]))
    const distinctPitches = new Set(byMidi.map((item) => item.midi)).size
    const endpoints = new Set(bassAnchors)
    if (distinctPitches > 1) endpoints.add(byMidi[0].index)
    const distinctChordTones = new Set<number>()
    const seenChordTones = new Set<number>()
    for (const item of byMidi) {
      const pitch = pitchClass(item.midi)
      if (theoryNotes.has(item.index) && !seenChordTones.has(pitch)) {
        seenChordTones.add(pitch)
        distinctChordTones.add(item.index)
      }
    }
    priority.sort((a, b) => {
      const importance = (item: Item) => endpoints.has(item.index) ? 0
        : distinctChordTones.has(item.index) ? 1
          : theoryNotes.has(item.index) ? 2 : 3
      return importance(a) - importance(b) || rank.get(a.index)! - rank.get(b.index)!
    })
    const merged = new Map<string, Node>()
    const first = group.every((item) => item.preferred)
      ? group.map((item): Placed => ({ index: item.index, midi: item.midi, string: item.preferred!.string, fret: item.preferred!.fret, end: item.end })) : null
    let easy = !!first
    for (const node of beam) {
      const held = node.active.filter((place) => place.end > t + EPS)
      // Where the first placement already works, keep it and spare the search.
      const quick = first && shapeFits([...held, ...first], config) ? [leafOf(held, first, node.pos, endpoints)] : null
      if (!quick) easy = false
      if (quick && criticalGroups.has(groupIndex)) easy = false
      for (let kept = priority.length; kept >= 0; kept--) {
        const selected = priority.slice(0, kept)
        const standard = quick
          ? criticalGroups.has(groupIndex)
            ? uniqueLeaves([...quick, ...enumerate(group, held, node.pos, endpoints)])
            : quick
          : kept ? enumerate(selected, held, node.pos, endpoints) : [{ placed: [], cost: 0, pos: node.pos }]
        const leaves = standard.length || !kept ? standard : enumerate(selected, held, node.pos, endpoints, true)
        if (!leaves.length) continue
        const dropped = priority.slice(kept).map((item) => item.index)
        for (const leaf of leaves) {
          const active = [...held, ...leaf.placed]
          let hash = 0
          for (const place of active) hash = (hash * 31 + place.index * 257 + place.string * 29 + place.fret) | 0
          const key = `${hash}:${active.length}:${leaf.pos}`
          const candidate: Node = {
            cost: node.cost + leaf.cost + dropped.length * 1000, pos: leaf.pos, active, parent: node, placed: leaf.placed, dropped, key,
          }
          const known = merged.get(key)
          if (!known || candidate.cost < known.cost - 1e-9) merged.set(key, candidate)
        }
        break
      }
    }
    beam = [...merged.values()].sort((a, b) => a.cost - b.cost || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, easy ? 2 : BEAM)
  }

  const chosen = new Map<number, Placed>()
  const dropped = new Set<number>()
  const droppedAt = new Map<number, number>()
  for (let node: Node | null = beam[0]; node?.parent; node = node.parent) {
    for (const place of node.placed) chosen.set(place.index, place)
    for (const index of node.dropped) {
      dropped.add(index)
      droppedAt.set(where.get(index)!.start, (droppedAt.get(where.get(index)!.start) ?? 0) + 1)
    }
  }

  const movedAt = new Map<number, number>()
  const octaveAt = new Map<number, number>()
  const notes = input.map((note, index) => {
    const place = chosen.get(index)
    if (place) {
      const folded = place.midi !== note.midi
      const moved = !sameSpot(where.get(index)!.preferred, place)
      if (moved) summary.moved++
      if (folded) { summary.octaveAdjusted++; tally(octaveAt, note.startBeat) }
      else if (moved) tally(movedAt, note.startBeat)
      return { ...note, midi: place.midi, string: place.string, fret: place.fret, ...(moved || folded ? { adjusted: true } : {}) }
    }
    if (dropped.has(index)) {
      const { string: _string, fret: _fret, ...rest } = note
      return { ...rest, notPlayable: true }
    }
    return note
  })
  summary.unplayableNotes = dropped.size
  summary.unplayable = droppedAt.size
  for (const [beat, marked] of droppedAt) summary.issues.push({ beat, kind: 'unplayable', count: marked })
  for (const [beat, moved] of movedAt) summary.issues.push({ beat, kind: 'moved', count: moved })
  for (const [beat, folded] of octaveAt) summary.issues.push({ beat, kind: 'octave', count: folded })
  summary.issues.sort((a, b) => a.beat - b.beat)
  return { notes, summary }
}

// ---------------------------------------------------------------- the song a practice view shows

export type PracticeTarget = { instrument: 'piano' | 'guitar' | 'bass' | null; track?: Track }
export type Playable = { song: Song; summary: PlayabilitySummary | null }

const cache = new WeakMap<readonly unknown[], Map<string, { notes: readonly unknown[]; summary: PlayabilitySummary }>>()

export type PlayabilitySaveRequest = {
  version: string
  parts: Record<string, {
    sourceNotes: (PianoNote | MelodyNote)[]
    sourceSignature: string
    notes: (PianoNote | MelodyNote)[]
    summary: PlayabilitySummary
  }>
  drums?: {
    sourceHits: DrumHit[]
    sourceSignature: string
    hits: DrumHit[]
    summary: PlayabilitySummary
    trackSummaries: Record<string, PlayabilitySummary>
  }
}

export type PreparedPlayability = { song: Song; request: PlayabilitySaveRequest | null }

function sourceSignature(
  song: Song,
  instrument: PlayabilitySummary['instrument'],
  notes: readonly (PianoNote | MelodyNote)[],
): string {
  const context = instrument === 'piano'
    ? { bpm: song.bpm, pedals: song.pedals ?? [] }
    : { chords: (song.chords ?? []).map((chord) => [chord.startBeat, chord.beats, chord.confidence, chord.tones]) }
  return signatureOf([PLAYABILITY_VERSION, instrument, context, notes])
}

function signatureOf(value: unknown): string {
  const text = JSON.stringify(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193)
  }
  return `${(hash >>> 0).toString(16)}:${text.length}`
}

const trackPartKey = (id: string) => `track:${id}`

function repairDrumPart(song: Song): { hits: DrumHit[]; summary: PlayabilitySummary } {
  const hands = song.drums.some((hit) => hit.hand)
    ? song.drums.map((hit) => hit.hand)
    : suggestSticking(song)
  const hits = song.drums.map((hit, index) => hit.hand || !hands[index] ? hit : { ...hit, hand: hands[index] })
  const summary = empty('drums')
  const writtenBeats = drumNotationBeats(song)
  const moments = new Map<number, Map<string, number[]>>()
  song.drums.forEach((hit, index) => {
    if (kitStrike(hit).foot) return
    const beat = Math.round(writtenBeats[index] * 1e6) / 1e6
    const sound = `${hit.lane}:${hit.sourceMidi ?? ''}`
    const strokes = moments.get(beat) ?? new Map<string, number[]>()
    strokes.set(sound, [...(strokes.get(sound) ?? []), index])
    moments.set(beat, strokes)
  })
  const assignedAt = new Map<number, number>()
  const unassignedAt = new Map<number, number>()
  for (const [beat, strokes] of moments) {
    if (strokes.size > 2) {
      summary.flagged++
      unassignedAt.set(beat, [...strokes.values()].flat().length)
    }
    for (const indexes of strokes.values()) {
      const assigned = indexes.filter((index) => hits[index].hand)
      const newlyAssigned = assigned.filter((index) => !song.drums[index].hand)
      if (newlyAssigned.length) assignedAt.set(beat, (assignedAt.get(beat) ?? 0) + 1)
    }
  }
  summary.moved = [...assignedAt.values()].reduce((sum, count) => sum + count, 0)
  summary.unplayable = unassignedAt.size
  summary.unplayableNotes = [...unassignedAt.values()].reduce((sum, count) => sum + count, 0)
  for (const [beat, count] of assignedAt) summary.issues.push({ beat, kind: 'moved', count })
  for (const [beat, count] of unassignedAt) summary.issues.push({ beat, kind: 'unplayable', count })

  const secondsPerBeat = 60 / (song.bpm > 0 ? song.bpm : 120)
  const lastByHand = new Map<'left' | 'right', { beat: number; sound: string; cymbal: boolean }>()
  const repeatsAt = new Map<number, number>()
  const uniqueStrokes = [...moments.entries()].flatMap(([beat, strokes]) =>
    [...strokes.entries()].map(([sound, indexes]) => ({ beat, sound, index: indexes[0] })))
      .sort((a, b) => a.beat - b.beat || a.index - b.index)
  for (const stroke of uniqueStrokes) {
    const hit = hits[stroke.index]
    if (!hit.hand) continue
    const current = { beat: stroke.beat, sound: stroke.sound, cymbal: ['hihat', 'openhat', 'ride', 'crash'].includes(hit.lane) }
    const previous = lastByHand.get(hit.hand)
    if (previous) {
      const gap = (current.beat - previous.beat) * secondsPerBeat
      const limit = current.cymbal && previous.cymbal && current.sound === previous.sound ? 0.14 : 0.3
      if (gap > EPS && gap < limit) {
        summary.warnings++
        repeatsAt.set(hit.startBeat, (repeatsAt.get(hit.startBeat) ?? 0) + 1)
      }
    }
    lastByHand.set(hit.hand, current)
  }
  for (const [beat, count] of repeatsAt) summary.issues.push({ beat, kind: 'repeat', count })
  summary.issues.sort((a, b) => a.beat - b.beat)
  return { hits, summary }
}

function repairDrumSticking(song: Song): {
  hits: DrumHit[]
  summary: PlayabilitySummary
  trackSummaries: Record<string, PlayabilitySummary>
} {
  const hits = [...song.drums]
  const summary = empty('drums')
  const trackSummaries: Record<string, PlayabilitySummary> = {}
  const groups = new Map<string | null, number[]>()
  song.drums.forEach((hit, index) => {
    const trackId = hit.trackId || null
    groups.set(trackId, [...(groups.get(trackId) ?? []), index])
  })
  for (const [trackId, indexes] of groups) {
    const repaired = repairDrumPart({ ...song, drums: indexes.map((index) => song.drums[index]) })
    repaired.hits.forEach((hit, index) => { hits[indexes[index]] = hit })
    for (const field of ['flagged', 'moved', 'octaveAdjusted', 'unplayable', 'unplayableNotes', 'warnings'] as const) {
      summary[field] += repaired.summary[field]
    }
    summary.issues.push(...repaired.summary.issues)
    if (trackId) trackSummaries[trackId] = repaired.summary
  }
  summary.issues.sort((a, b) => a.beat - b.beat)
  return { hits, summary, trackSummaries }
}

/**
 * Create the complete post-transcription practice layer. Existing stored parts are reused only when their source
 * fingerprint still matches; a missing or stale part is repaired before the song is opened.
 */
export function preparePlayableSong(song: Song): PreparedPlayability {
  const targets: { key: string; instrument: PlayabilitySummary['instrument']; notes: readonly (PianoNote | MelodyNote)[] }[] = []
  const pianoTracks = song.tracks.filter((track) => track.group !== 'creative' && track.instrument === 'piano')
  if (pianoTracks.length <= 1 && song.piano.length) {
    targets.push({ key: 'piano', instrument: 'piano', notes: song.piano })
  } else {
    for (const track of pianoTracks) {
      const notes = song.piano.filter((note) => note.trackId === track.id)
      if (notes.length) targets.push({ key: trackPartKey(track.id), instrument: 'piano', notes })
    }
  }
  for (const track of song.tracks) {
    if (track.group === 'creative' || track.instrument !== 'other') continue
    const notes = song.instrumentNotes?.[track.id]
    if (!notes?.length) continue
    if (Number.isInteger(track.gmProgram) && track.gmProgram! >= 0 && track.gmProgram! <= 7) {
      targets.push({ key: trackPartKey(track.id), instrument: 'piano', notes })
    } else if (identifiesInstrument(track, 'bass')) {
      targets.push({ key: trackPartKey(track.id), instrument: 'bass', notes })
    } else if (identifiesInstrument(track, 'guitar')) {
      targets.push({ key: trackPartKey(track.id), instrument: 'guitar', notes })
    }
  }
  const existing = song.playability?.version === PLAYABILITY_VERSION ? song.playability.parts : null
  const drumSignature = song.drums.length
    ? signatureOf([PLAYABILITY_VERSION, 'drums', song.bpm, song.drums])
    : null
  const drumTrackIds = new Set(song.drums.map((hit) => hit.trackId).filter((id): id is string => !!id))
  const matches = targets.every((target) => existing?.[target.key]?.sourceSignature ===
    sourceSignature(song, target.instrument, target.notes)) &&
    (!drumSignature || (song.playability?.drums?.sourceSignature === drumSignature &&
      [...drumTrackIds].every((id) => song.playability?.drums?.trackSummaries[id]?.instrument === 'drums')))
  if (matches) return { song, request: null }
  if (!targets.length && !drumSignature) return { song, request: null }

  const parts: StoredPlayability['parts'] = {}
  const saveParts: PlayabilitySaveRequest['parts'] = {}
  for (const target of targets) {
    const signature = sourceSignature(song, target.instrument, target.notes)
    const result = target.instrument === 'piano'
      ? repairPiano(target.notes as readonly PianoNote[], { bpm: song.bpm, pedals: song.pedals })
      : repairFretted(target.notes as readonly MelodyNote[], target.instrument === 'bass' ? BASS : GUITAR,
        { chords: song.chords })
    const record = { sourceSignature: signature, notes: result.notes, summary: result.summary }
    parts[target.key] = record
    saveParts[target.key] = { ...record, sourceNotes: [...target.notes] }
  }
  const repairedDrums = drumSignature ? repairDrumSticking(song) : null
  const drums = repairedDrums && drumSignature
    ? {
      sourceSignature: drumSignature, hits: repairedDrums.hits, summary: repairedDrums.summary,
      trackSummaries: repairedDrums.trackSummaries,
    }
    : undefined
  const saveDrums = repairedDrums && drumSignature
    ? { ...drums!, sourceHits: [...song.drums] }
    : undefined
  return {
    song: { ...song, playability: { version: PLAYABILITY_VERSION, parts, ...(drums ? { drums } : {}) } },
    request: { version: PLAYABILITY_VERSION, parts: saveParts, ...(saveDrums ? { drums: saveDrums } : {}) },
  }
}

/**
 * The song as it should be practised: hands and string choices made playable. The stored song is left as it is, so the
 * repair is always worked out again from the transcription.
 */
export function applyPlayability(song: Song, target: PracticeTarget): Playable {
  const { instrument, track } = target
  if (!instrument) {
    const storedDrums = track?.instrument === 'drums' && song.playability?.version === PLAYABILITY_VERSION
      ? song.playability.drums : undefined
    if (!storedDrums) return { song, summary: null }
    const drumTracks = song.tracks.filter((item) => item.group !== 'creative' && item.instrument === 'drums')
    const perTrack = !!track && drumTracks.length > 1
    const hits = perTrack
      ? storedDrums.hits.filter((hit) => hit.trackId === track.id)
      : storedDrums.hits
    const summary = perTrack
      ? storedDrums.trackSummaries[track.id] ?? empty('drums')
      : storedDrums.summary
    return { song: { ...song, drums: hits }, summary }
  }
  let source: 'piano' | string | null = 'piano'
  let storedKey = 'piano'
  if (instrument === 'piano') {
    const multiplePianoTracks = song.tracks.filter(
      (item) => item.group !== 'creative' && item.instrument === 'piano',
    ).length > 1
    if (track?.id && (track.instrument === 'other' || (track.instrument === 'piano' && multiplePianoTracks))) {
      storedKey = trackPartKey(track.id)
    }
  } else {
    const id = track?.id
    source = track?.instrument === 'piano' || !id ? 'piano'
      : song.instrumentNotes?.[id] ? id : track.instrument !== 'other' ? 'piano' : null
    if (source && source !== 'piano') storedKey = trackPartKey(source)
  }
  if (!source) return { song, summary: null }
  const notes: readonly (PianoNote | MelodyNote)[] = source === 'piano' ? song.piano : song.instrumentNotes![source]
  const stored = song.playability?.version === PLAYABILITY_VERSION ? song.playability.parts[storedKey] : undefined
  if (stored && stored.notes.length === notes.length) {
    return {
      song: source === 'piano' ? { ...song, piano: stored.notes as PianoNote[] }
        : { ...song, instrumentNotes: { ...song.instrumentNotes, [source]: stored.notes as MelodyNote[] } },
      summary: stored.summary,
    }
  }
  const pedalKey = song.pedals?.map((pedal) => `${pedal.controller}@${pedal.startBeat}+${pedal.beats}`).join() ?? ""
  const harmonyKey = song.chords?.map((chord) =>
    `${chord.startBeat}+${chord.beats}:${chord.confidence}:${chord.tones.join('.')}`).join(';') ?? ""
  const key = `${instrument}:${song.bpm}:${pedalKey}:${harmonyKey}`
  const cached = cache.get(notes)?.get(key)
  const result = cached ?? (() => {
    const made = instrument === 'piano'
      ? repairPiano(notes as PianoNote[], { bpm: song.bpm, pedals: song.pedals })
      : repairFretted(notes, instrument === 'bass' ? BASS : GUITAR, { chords: song.chords })
    const entry = { notes: made.notes as readonly unknown[], summary: made.summary }
    cache.set(notes, (cache.get(notes) ?? new Map()).set(key, entry))
    return entry
  })()
  if (result.notes === notes) return { song, summary: result.summary }
  return {
    song: source === 'piano' ? { ...song, piano: result.notes as PianoNote[] }
      : { ...song, instrumentNotes: { ...song.instrumentNotes, [source]: result.notes as MelodyNote[] } },
    summary: result.summary,
  }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** Plain-English lines for the note above the practice view; empty when nothing needed changing. */
export function playabilityNotice(summary: PlayabilitySummary | null): string[] {
  if (!summary) return []
  const lines: string[] = []
  if (summary.moved) lines.push(summary.instrument === 'piano'
    ? `Hands adjusted for playability: ${plural(summary.moved, 'note')} moved to the other hand.`
    : summary.instrument === 'drums'
      ? `Suggested sticking assigned to ${plural(summary.moved, 'stroke')}.`
      : `Tab notes adjusted for playability: ${plural(summary.moved, 'note')}.`)
  if (summary.octaveAdjusted) lines.push(`${plural(summary.octaveAdjusted, 'chord tone')} shifted by an octave to keep the voicing playable.`)
  if (summary.unplayable) lines.push(summary.instrument === 'drums'
    ? `${plural(summary.unplayable, 'moment')} exceed the two available hands; those strokes remain unassigned.`
    : `${plural(summary.unplayable, 'moment')} can't be played as written; marked in the score${summary.instrument === 'piano' ? '' : ' and tab'}.`)
  if (summary.warnings) lines.push(summary.instrument === 'drums'
    ? `${plural(summary.warnings, 'rapid same-hand repeat')} may be hard to play.`
    : `${plural(summary.warnings, 'quick jump')} between hand positions may be hard to play.`)
  return lines
}
