import { keyOf, pedalCarries, suggestFingers } from './fingers'
import {
  BASS, GUITAR, planFrettedTab, positionsForMidi,
  type FrettedInstrumentConfig, type FrettedPosition,
} from './fretboard'
import type { MelodyNote, Pedal, PianoNote, Song, Track } from './song'

/**
 * Playability checks and repairs for transcribed music. Transcribers and importers split piano notes between the hands by
 * pitch alone and pick a guitar string for each note on its own, so a moment can ask one hand for more than it can do.
 * The repair here runs on the stored song every time it is opened; the stored notes are never changed.
 */

const EPS = 1e-6

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

export type PlayabilityIssue = {
  beat: number
  kind: 'moved' | 'unplayable' | 'jump'
  count: number
}

export type PlayabilitySummary = {
  instrument: 'piano' | 'guitar' | 'bass'
  /** Moments that could not be played as written. */
  flagged: number
  /** Notes moved to the other hand (piano) or to another string and fret (guitar, bass). */
  moved: number
  /** Moments still not playable after the repair; their notes are marked. */
  unplayable: number
  unplayableNotes: number
  /** Quick jumps between hand positions: hard, not impossible, and never repaired. */
  warnings: number
  issues: PlayabilityIssue[]
}

const empty = (instrument: PlayabilitySummary['instrument']): PlayabilitySummary =>
  ({ instrument, flagged: 0, moved: 0, unplayable: 0, unplayableNotes: 0, warnings: 0, issues: [] })

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
  for (let moment = 0; moment < count; moment++) if (excess(moment, reach) > 0) summary.flagged++

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

  crossLong = crossRuns()
  const failed = new Set<number>()
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
export type FrettedNote = MelodyNote & { string?: number; fret?: number }

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

type Item = { index: number; midi: number; start: number; end: number; candidates: Pos[]; preferred?: Pos }
type Placed = { index: number; string: number; fret: number; end: number }
type Node = { cost: number; pos: number | null; active: Placed[]; parent: Node | null; placed: Placed[]; dropped: number[]; key: string }

const sameSpot = (a?: Pos, b?: Pos) => !!a && !!b && a.string === b.string && a.fret === b.fret

export function repairFretted(
  input: readonly FrettedNote[],
  config: FrettedInstrumentConfig,
): { notes: FrettedNote[]; summary: PlayabilitySummary } {
  const summary = empty(config.id)
  const baseline = planFrettedTab(input, config)
  const items: Item[] = []
  const byMidi = new Map<number, FrettedPosition[]>()
  for (const [index, note] of input.entries()) {
    if (!Number.isInteger(note.midi) || !(note.beats > 0)) continue
    let places = byMidi.get(note.midi)
    if (!places) byMidi.set(note.midi, places = positionsForMidi(note.midi, config))
    if (!places.length) continue
    const given = baseline[index].position
    const preferred = given ? { string: given.string, fret: given.fret } : undefined
    const candidates = places.map((place: FrettedPosition) => ({ string: place.string, fret: place.fret }))
      .sort((a, b) => (sameSpot(b, preferred) ? 1 : 0) - (sameSpot(a, preferred) ? 1 : 0) || a.fret - b.fret || a.string - b.string)
    items.push({ index, midi: note.midi, start: note.startBeat, end: note.startBeat + note.beats, candidates, preferred })
  }
  items.sort((a, b) => a.start - b.start || a.index - b.index)

  const groups: Item[][] = []
  for (const item of items) {
    const group = groups[groups.length - 1]
    if (group && item.start - group[0].start <= EPS) group.push(item)
    else groups.push([item])
  }

  // Moments the notes as first placed cannot play.
  const where = new Map(items.map((item) => [item.index, item]))
  const bad: number[] = []
  let sounding: Item[] = []
  groups.forEach((group, at) => {
    const t = group[0].start
    sounding = sounding.filter((item) => item.end > t + EPS).concat(group)
    const spots = sounding.map((item) => baseline[item.index].position)
    if (spots.some((spot) => !spot) || !shapeFits(spots as Pos[], config)) bad.push(at)
  })
  summary.flagged = bad.length
  if (!bad.length) return { notes: input as FrettedNote[], summary }

  /** What a placement costs: stretch, a shift of the hand from where it was, higher frets, and leaving the first placement. */
  const leafOf = (held: Placed[], chosen: Placed[], pos: number | null) => {
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
      cost += place.fret * 0.02
      if (!sameSpot(where.get(place.index)!.preferred, place)) cost += 6
    }
    return { placed: chosen, cost, pos: nextPos }
  }

  const enumerate = (kept: Item[], held: Placed[], pos: number | null) => {
    const order = [...kept].sort((a, b) => a.candidates.length - b.candidates.length || a.midi - b.midi || a.index - b.index)
    const leaves: { placed: Placed[]; cost: number; pos: number | null }[] = []
    const chosen: Placed[] = []
    const stack: Placed[] = held.slice()
    let visits = 0
    const walk = (depth: number) => {
      if (visits > 48) return
      if (depth === order.length) {
        visits++
        leaves.push(leafOf(held, [...chosen], pos))
        return
      }
      const item = order[depth]
      for (const candidate of item.candidates) {
        const place: Placed = { index: item.index, string: candidate.string, fret: candidate.fret, end: item.end }
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

  let beam: Node[] = [{ cost: 0, pos: null, active: [], parent: null, placed: [], dropped: [], key: '' }]
  for (const group of groups) {
    const t = group[0].start
    const byMidi = [...group].sort((a, b) => a.midi - b.midi || a.index - b.index)
    // Keep the lowest and highest notes longest; the inner notes are the first to go.
    const priority: Item[] = []
    for (let low = 0, high = byMidi.length - 1; low <= high; low++, high--) {
      priority.push(byMidi[low])
      if (high !== low) priority.push(byMidi[high])
    }
    const merged = new Map<string, Node>()
    const first = group.every((item) => item.preferred)
      ? group.map((item): Placed => ({ index: item.index, string: item.preferred!.string, fret: item.preferred!.fret, end: item.end })) : null
    let easy = !!first
    for (const node of beam) {
      const held = node.active.filter((place) => place.end > t + EPS)
      // Where the first placement already works, keep it and spare the search.
      const quick = first && shapeFits([...held, ...first], config) ? [leafOf(held, first, node.pos)] : null
      if (!quick) easy = false
      for (let kept = priority.length; kept >= 0; kept--) {
        const leaves = quick ?? (kept ? enumerate(priority.slice(0, kept), held, node.pos) : [{ placed: [], cost: 0, pos: node.pos }])
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
  const notes = input.map((note, index) => {
    const place = chosen.get(index)
    if (place) {
      const moved = !sameSpot(where.get(index)!.preferred, place)
      if (moved) { summary.moved++; tally(movedAt, note.startBeat) }
      return { ...note, string: place.string, fret: place.fret, ...(moved ? { adjusted: true } : {}) }
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
  summary.issues.sort((a, b) => a.beat - b.beat)
  return { notes, summary }
}

// ---------------------------------------------------------------- the song a practice view shows

export type PracticeTarget = { instrument: 'piano' | 'guitar' | 'bass' | null; track?: Track }
export type Playable = { song: Song; summary: PlayabilitySummary | null }

const cache = new WeakMap<readonly unknown[], Map<string, { notes: readonly unknown[]; summary: PlayabilitySummary }>>()

/**
 * The song as it should be practised: hands and string choices made playable. The stored song is left as it is, so the
 * repair is always worked out again from the transcription.
 */
export function applyPlayability(song: Song, target: PracticeTarget): Playable {
  const { instrument, track } = target
  if (!instrument) return { song, summary: null }
  let source: 'piano' | string | null = 'piano'
  if (instrument !== 'piano') {
    const id = track?.id
    source = track?.instrument === 'piano' || !id ? 'piano'
      : song.instrumentNotes?.[id] ? id : track.instrument !== 'other' ? 'piano' : null
  }
  if (!source) return { song, summary: null }
  const notes: readonly (PianoNote | MelodyNote)[] = source === 'piano' ? song.piano : song.instrumentNotes![source]
  const pedalKey = song.pedals?.map((pedal) => `${pedal.controller}@${pedal.startBeat}+${pedal.beats}`).join() ?? ""
  const key = `${instrument}:${song.bpm}:${pedalKey}`
  const cached = cache.get(notes)?.get(key)
  const result = cached ?? (() => {
    const made = instrument === 'piano'
      ? repairPiano(notes as PianoNote[], { bpm: song.bpm, pedals: song.pedals })
      : repairFretted(notes, instrument === 'bass' ? BASS : GUITAR)
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
    : `Tab positions adjusted for playability: ${plural(summary.moved, 'note')}.`)
  if (summary.unplayable) lines.push(`${plural(summary.unplayable, 'moment')} can't be played as written; marked in the score${summary.instrument === 'piano' ? '' : ' and tab'}.`)
  if (summary.warnings) lines.push(`${plural(summary.warnings, 'quick jump')} between hand positions may be hard to play.`)
  return lines
}
