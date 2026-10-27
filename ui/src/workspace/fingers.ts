import type { Pedal, PianoNote } from './song'

export type Finger = { hand: 'left' | 'right'; finger: number }

export const keyOf = (midi: number) => Math.ceil(midi - 0.5)
/** The widest chord (in semitones) given a suggestion: an octave between thumb and fifth finger. */
const REACH = 12
const EPS = 1e-6

/**
 * Whether a pedal carries a held note, so the finger that struck it is free at `at`.
 * Sustain: the pedal is down by then and stays down for the rest of the note, so the key may be let go early.
 * Sostenuto: the note was already down when the pedal went down, and the pedal then keeps it. The soft pedal never matters.
 */
export function pedalCarries(pedals: readonly Pedal[] | undefined, start: number, end: number, at: number): boolean {
  if (!pedals) return false
  for (const pedal of pedals) {
    const stop = pedal.startBeat + pedal.beats
    if (pedal.startBeat > at + EPS || stop < end - EPS || stop <= at + EPS) continue
    if (pedal.controller === 64 && stop >= start) return true
    if (pedal.controller === 66 && start <= pedal.startBeat + EPS && end > pedal.startBeat + EPS) return true
  }
  return false
}

const sustainDown = (pedals: readonly Pedal[] | undefined, at: number) =>
  !!pedals?.some((pedal) => pedal.controller === 64 && pedal.startBeat <= at + EPS && at < pedal.startBeat + pedal.beats - EPS)

// Spans between two fingers in semitones, thumb-side finger first: [practical min, comfortable min, relaxed min,
// relaxed max, comfortable max, practical max]. These follow the shape of Parncutt et al. (1997), rounded for a medium hand.
const SPANS: Record<string, readonly number[]> = {
  '1-2': [-5, -3, 1, 5, 8, 10], '1-3': [-4, -2, 3, 5, 8, 12], '1-4': [-3, -1, 5, 9, 12, 14], '1-5': [-1, 1, 7, 10, 13, 15],
  '2-3': [1, 1, 1, 3, 4, 5], '2-4': [1, 1, 3, 4, 5, 7], '2-5': [2, 2, 5, 6, 10, 12],
  '3-4': [1, 1, 1, 2, 2, 4], '3-5': [1, 1, 2, 4, 6, 8], '4-5': [1, 1, 1, 2, 4, 6],
}
/** Where each finger rests, in semitones above the thumb, for a hand sitting on five white keys. */
const REST = [0, 2, 3.5, 5, 7]
/** Cost of passing the thumb under (or a finger over the thumb), by the crossing finger. */
const CROSS: Record<number, number> = { 2: 4, 3: 2, 4: 3, 5: 6 }
/** Penalty for using a finger on its own: the fourth and fifth are weak. */
/** Cost per semitone the hand position drifts between notes beyond a free allowance, when no crossing explains it. */
const DRIFT = 0.3
const DRIFT_FREE = 0.5
const WEAK = [0, 0, 0, 0.75, 0.5]

const isBlack = (key: number) => [1, 3, 6, 8, 10].includes(((key % 12) + 12) % 12)

/** Cost of two fingers playing keys `span` semitones apart at once, or Infinity when the hand cannot do it. */
function sounding(low: number, high: number, span: number): number {
  const [, , minRel, maxRel, maxComf, maxPrac] = SPANS[`${low}-${high}`]
  if (span < 1 || span > Math.min(maxPrac, REACH)) return Infinity
  const [, minComf] = SPANS[`${low}-${high}`]
  return 2 * Math.max(0, minComf - span) + 2 * Math.max(0, span - maxComf) + Math.max(0, minRel - span) + Math.max(0, span - maxRel)
}

/** Whether two simultaneous key contacts keep the fingers in order and within their practical reach. */
export function pianoFingerPairFits(a: number, af: number, b: number, bf: number, hand: 'left' | 'right'): boolean {
  const direction = hand === 'right' ? 1 : -1
  const [low, high] = (b - a) * direction > 0 ? [af, bf] : [bf, af]
  return low < high && Number.isFinite(sounding(low, high, Math.abs(b - a)))
}

/** Cost of moving from one finger on one key to the next finger on the next key (`d` semitones, positive away from the thumb). */
function step(from: number, to: number, d: number, fast: boolean, legatoBlocked: boolean): number {
  if (d === 0) return from === to ? (fast ? 2 : 0) : fast ? 0.5 : 1
  if (from === to) return 1 + (legatoBlocked ? 4 : 0) + (Math.abs(d) > 2 ? 0.1 * Math.abs(d) : 0)
  const outward = Math.sign(to - from) === Math.sign(d)
  const low = Math.min(from, to)
  const high = Math.max(from, to)
  if (outward) {
    const [, minComf, minRel, maxRel, maxComf] = SPANS[`${low}-${high}`]
    const span = Math.abs(d)
    const excess = Math.max(0, minComf - span) + Math.max(0, span - maxComf)
    return (excess <= 2 ? 2 * excess : 4 + 0.1 * excess) + Math.max(0, minRel - span) + Math.max(0, span - maxRel)
  }
  // The thumb passing under a finger, or a finger passing over the thumb; other crossings are rare and costly.
  const crossing = low === 1 ? CROSS[high] : 6
  return crossing + Math.min(2, 1.5 * Math.max(0, Math.abs(d) - 2))
}

const COMBOS: number[][][] = [[[]]]
for (let size = 1; size <= 5; size++) {
  const list: number[][] = []
  const build = (from: number, chosen: number[]) => {
    if (chosen.length === size) { list.push(chosen); return }
    for (let finger = from; finger <= 5; finger++) build(finger + 1, [...chosen, finger])
  }
  build(1, [])
  COMBOS.push(list)
}

type Entry = { note: PianoNote; m: number; finger: number; end: number }
type Group = { start: number; notes: PianoNote[]; m: number[]; keys: number[] }
type State = { fingers: number[]; cost: number; back: State | null; group: Group; active: Entry[]; anchor: number }

export type SuggestOptions = {
  /** Quarter notes per minute: quick repeated notes are better played with alternating fingers. */
  bpm?: number
  /** Apply the playability layer's unwritten pedal-gap heuristic to a single low bass note. */
  inferBassPedalGap?: boolean
}

/** Physical key releases for the hand display; sounding durations and source notes are not changed. */
export function pianoKeyReleases(
  notes: readonly PianoNote[], pedals?: readonly Pedal[], options: SuggestOptions = {},
): Map<PianoNote, number> {
  const releases = new Map<PianoNote, number>()
  for (const hand of ['left', 'right'] as const) {
    const mine = notes.filter((note) => note.hand === hand).sort((a, b) => a.startBeat - b.startBeat)
    const onsetCounts = new Map<number, number>()
    for (const note of mine) onsetCounts.set(note.startBeat, (onsetCounts.get(note.startBeat) ?? 0) + 1)
    let active: PianoNote[] = []
    for (let first = 0; first < mine.length;) {
      let last = first + 1
      while (last < mine.length && mine[last].startBeat - mine[first].startBeat < EPS) last++
      const arriving = mine.slice(first, last)
      const at = mine[first].startBeat
      const keys = new Set(arriving.map((note) => keyOf(note.midi)))
      const low = Math.min(...keys)
      active = active.filter((note) => {
        const end = note.startBeat + note.beats
        if (end <= at + EPS) return false
        const inferred = options.inferBassPedalGap && hand === 'left' && !pedals?.length &&
          onsetCounts.get(note.startBeat) === 1 && keyOf(note.midi) <= low - 9
        if (keys.has(keyOf(note.midi)) || pedalCarries(pedals, note.startBeat, end, at) || inferred) {
          releases.set(note, at)
          return false
        }
        return true
      })
      active.push(...arriving)
      first = last
    }
  }
  return releases
}

/**
 * Suggested fingers: an estimate for practice, not detected fingering. For each hand a Viterbi search finds the finger
 * assignment with the lowest cost over the whole passage, using a Parncutt-style model: stretch and small or large spans
 * between fingers, weak fourth and fifth fingers, thumb or fifth finger on a black key, and the thumb passing under (or a
 * finger over the thumb) in scales and arpeggios. Chords take fingers in pitch order. A held note keeps its finger busy
 * (and limits what the hand can reach) until it ends, unless a sustain pedal carries it, or a sostenuto pedal pressed
 * while it was down: then the key may be let go and the hand moves freely. The left hand is the right hand mirrored.
 * Chords of more than five keys, repeated keys or wider than an octave, and notes out of reach of held notes, get no
 * suggestion; their keys still light. The result is deterministic, and the source notes are never changed.
 */
export function suggestFingers(
  notes: readonly PianoNote[], pedals?: readonly Pedal[], options: SuggestOptions = {},
): Map<PianoNote, Finger> {
  const result = new Map<PianoNote, Finger>()
  const secondsPerBeat = 60 / (options.bpm && options.bpm > 0 ? options.bpm : 120)
  for (const hand of ['right', 'left'] as const) {
    const mine = notes.filter((note) => note.hand === hand && Number.isFinite(note.midi) && note.beats > 0)
      .sort((a, b) => a.startBeat - b.startBeat)
    const sign = hand === 'right' ? 1 : -1
    const groups: Group[] = []
    for (const note of mine) {
      const last = groups[groups.length - 1]
      if (last && note.startBeat - last.start < EPS) last.notes.push(note)
      else groups.push({ start: note.startBeat, notes: [note], m: [], keys: [] })
    }
    for (const group of groups) {
      group.notes.sort((a, b) => sign * (a.midi - b.midi))
      group.keys = group.notes.map((note) => keyOf(note.midi))
      group.m = group.keys.map((key) => sign * key)
    }
    const whiteNear = (group: Group | undefined, key: number) => {
      if (!group) return false
      let nearest = group.keys[0]
      for (const other of group.keys) if (Math.abs(other - key) < Math.abs(nearest - key)) nearest = other
      return !isBlack(nearest)
    }

    let frontier: State[] = []
    const unknown: PianoNote[] = []
    const releases = pianoKeyReleases(mine, pedals, options)
    const blocking = (entry: { note: PianoNote; end: number }, at: number) =>
      (releases.get(entry.note) ?? entry.end) > at + EPS

    groups.forEach((group, index) => {
      const at = group.start
      const size = group.notes.length
      const unique = new Set(group.keys).size === size
      const width = Math.abs(group.m[size - 1] - group.m[0])
      const lost = unknown.some((note) => blocking({ note, end: note.startBeat + note.beats }, at))
      if (lost || !unique || size > 5 || width > REACH) { unknown.push(...group.notes); return }

      const before = groups[index - 1]
      const after = groups[index + 1]
      const own = COMBOS[size].map((fingers) => {
        let cost = 0
        fingers.forEach((finger, i) => {
          const key = group.keys[i]
          cost += WEAK[finger - 1] ?? 0
          const previousWhite = whiteNear(before, key)
          const nextWhite = whiteNear(after, key)
          if (isBlack(key) && finger === 1) cost += 2 + (previousWhite ? 2 : 0) + (nextWhite ? 2 : 0)
          if (isBlack(key) && finger === 5) cost += (previousWhite ? 1 : 0) + (nextWhite ? 1 : 0)
        })
        for (let a = 0; a < size; a++) for (let b = a + 1; b < size; b++) cost += sounding(fingers[a], fingers[b], group.m[b] - group.m[a])
        return { fingers, cost }
      }).filter((option) => Number.isFinite(option.cost))

      const created = new Map<string, State>()
      const sources: (State | null)[] = frontier.length ? frontier : [null]
      for (const from of sources) {
        const held = (from?.active ?? []).filter((entry) => blocking(entry, at) && !group.m.includes(entry.m))
        for (const option of own) {
          let cost = (from?.cost ?? 0) + option.cost
          let fits = true
          // Held notes keep their fingers: the new fingers must sit in pitch order around them within reach.
          for (const entry of held) {
            for (let i = 0; i < size && fits; i++) {
              const [low, high] = entry.m < group.m[i] ? [entry.finger, option.fingers[i]] : [option.fingers[i], entry.finger]
              const span = Math.abs(group.m[i] - entry.m)
              if (low >= high) { fits = false; break }
              const pair = sounding(low, high, span)
              if (!Number.isFinite(pair)) fits = false
              else cost += pair
            }
            if (!fits) break
          }
          if (!fits) continue
          const anchor = group.m.reduce((total, m, i) => total + m - REST[option.fingers[i] - 1], 0) / size
          if (from && !held.length) {
            const previous = from.group
            if (previous.notes.length === 1 && size === 1) {
              const note = previous.notes[0]
              const legato = Math.abs(note.startBeat + note.beats - at) < 0.05
              const fast = (at - previous.start) * secondsPerBeat < 0.2
              cost += step(from.fingers[0], option.fingers[0], group.m[0] - previous.m[0], fast, legato && !sustainDown(pedals, at))
              // Staying in one hand position: the thumb-referenced position should not drift between notes, except across a crossing.
              const crossing = Math.sign(option.fingers[0] - from.fingers[0]) === -Math.sign(group.m[0] - previous.m[0]) && from.fingers[0] !== option.fingers[0]
              if (!crossing) cost += DRIFT * Math.max(0, Math.abs(anchor - from.anchor) - DRIFT_FREE)
            } else {
              const shift = Math.abs(anchor - from.anchor)
              cost += shift <= 2 ? 0.25 * shift : Math.min(6, 0.5 + 0.35 * (shift - 2))
            }
          }
          // States with the same new fingers but different held notes lead to different futures, so keep them apart.
          const id = option.fingers.join('') + '|' + held.map((entry) => `${entry.m}:${entry.finger}:${entry.end}`).sort().join(',')
          const known = created.get(id)
          if (known && known.cost <= cost + 1e-9) continue
          const active = held.concat(group.notes.map((note, i) => ({ note, m: group.m[i], finger: option.fingers[i], end: note.startBeat + note.beats })))
          created.set(id, { fingers: option.fingers, cost, back: from, group, active, anchor })
        }
      }
      // Nothing fits around the held notes: leave these notes without a suggestion and keep the hand's last known state.
      if (!created.size) { unknown.push(...group.notes); return }
      frontier = [...created.values()]
    })

    let best: State | null = null
    for (const state of frontier) if (!best || state.cost < best.cost - 1e-9) best = state
    for (let state = best; state; state = state.back)
      state.group.notes.forEach((note, i) => result.set(note, { hand, finger: state.fingers[i] }))
  }
  return result
}
