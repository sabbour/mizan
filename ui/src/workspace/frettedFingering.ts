import type { FrettedInstrumentConfig, FrettedTabNote } from './fretboard'

/*
 * Fretting-hand fingering as a shortest path, after Sayegh's "optimum path" idea: every moment (one onset, a note or a
 * chord) has a few playable ways to finger it, each with a cost for how hard it is, and moving the hand from one
 * way to the next has its own cost. A Viterbi pass finds the cheapest route through the whole part, so a scale in
 * one position keeps one finger per fret and the hand only shifts where it has to (best at a gap or after an open string).
 *
 * Costs, all in made-up "effort" units tuned by feel:
 *  - Fingers: the index is free; the little finger is weakest. On a bass in the low positions (frets 1–4, where the
 *    frets are far apart) the ring finger is dearer still, so three adjacent frets prefer the Simandl 1-2-4.
 *  - Stretch: a fret gap larger than the finger gap costs more the nearer the nut (wide frets) and on a bass.
 *  - Barres: the index finger lying across strings at the lowest fret is cheap; a barre by another finger is a last resort.
 *  - Shifts: the hand moves when the hand position (the fret under the index finger) changes. A shift is cheaper
 *    after a gap in time, and when an open string sounded in between.
 *  - Reuse: one finger playing different frets in quick succession, or two fingers on one fret in succession.
 */

export type FingerNote = { index: number; string: number; fret: number; finger?: number }

type Shape = {
  /** The finger for each note, in the order the notes were given. */
  fingers: number[]
  cost: number
  /** The hand position: the fret under the index finger, as a range because the little finger may reach one fret either way. */
  low: number
  high: number
}

type Moment = {
  start: number
  end: number
  notes: FingerNote[]
  openBefore: boolean
  shapes: Shape[]
}

const FINGER_COST = [0, 0, 0.05, 0.15, 0.3]
const STRETCH_COST = 0.8
const SHIFT_COST = 1
const REUSE_COST = 1.2
const SWITCH_COST = 0.6
const MAX_FINGERS = 4

const isBass = (config: FrettedInstrumentConfig) => config.id === 'bass'
const lowPosition = (config: FrettedInstrumentConfig, lowestFret: number) => isBass(config) && lowestFret <= 4

/** Offsets from the hand position to where a finger lies: index 0, middle 1, ring 2, little 3 (or 2 in the Simandl 1-2-4). */
const offsets = (finger: number, simandl: boolean): [number, number] =>
  finger === 4 && simandl ? [2, 3] : [finger - 1, finger - 1]

/** All sensible ways one hand fingers these fretted notes at once, cheapest first, with authored fingers honoured. */
export function fingerShapes(notes: readonly FingerNote[], config: FrettedInstrumentConfig): Shape[] {
  const frets = [...new Set(notes.map((note) => note.fret))].sort((a, b) => a - b)
  if (!frets.length || frets.length > MAX_FINGERS || frets.at(-1)! - frets[0] > 4) return []
  const simandl = lowPosition(config, frets[0])
  const stretchScale = (1 + Math.max(0, 7 - frets[0]) * 0.1) * (isBass(config) ? 1.25 : 1)
  const onFret = frets.map((fret) => notes.map((note, at) => ({ note, at })).filter((item) => item.note.fret === fret)
    .sort((a, b) => a.note.string - b.note.string))
  const shapes: Shape[] = []
  const fingers = new Array<number>(notes.length).fill(0)

  const walk = (at: number, next: number, previous: { fret: number; top: number } | null, cost: number) => {
    if (at === frets.length) {
      const anchors = notes.map((note, position) => {
        const [low, high] = offsets(fingers[position], simandl)
        return [note.fret - high, note.fret - low] as const
      })
      let low = Math.max(...anchors.map((anchor) => anchor[0]))
      let high = Math.min(...anchors.map((anchor) => anchor[1]))
      if (low > high) low = high = Math.round((low + high) / 2)
      shapes.push({ fingers: [...fingers], cost, low, high })
      return
    }
    const group = onFret[at]
    const count = group.length
    const strings = group.map((item) => item.note.string)
    const contiguous = Math.max(...strings) - Math.min(...strings) + 1 === count
    // Either one finger lies across all the strings (a barre), or each string gets its own finger, lowest string first.
    for (const barre of count > 1 ? [true, false] : [false]) {
      const span = barre ? 1 : count
      for (let start = next; start + span - 1 <= MAX_FINGERS; start++) {
        let step = cost
        if (previous) {
          const finger = start - previous.top
          const gap = frets[at] - previous.fret
          const compressed = simandl && previous.top === 2 && start === 4 && gap === 1
          if (!compressed && (gap < finger || gap > finger + 1)) continue
          if (gap > finger) step += STRETCH_COST * stretchScale
          if (compressed) step += 0.25
        }
        // Fingers that must still follow on higher frets need room above this one.
        if (MAX_FINGERS - (start + span - 1) < frets.length - at - 1) continue
        const used = barre ? [start] : group.map((_, order) => start + order)
        for (const finger of used) step += FINGER_COST[finger] + (finger === 3 && simandl ? 0.7 : 0)
        if (barre) step += (count - 1) * (contiguous ? 0.5 : 1.5) + (start > 1 ? 4 : 0)
        else step += (count - 1) * 0.2
        group.forEach((item, order) => { fingers[item.at] = barre ? start : start + order })
        walk(at + 1, start + span, { fret: frets[at], top: start + span - 1 }, step)
      }
    }
    group.forEach((item) => { fingers[item.at] = 0 })
  }
  walk(0, 1, null, 0)

  const authored = notes.map((note) => note.finger && note.finger < 5 ? note.finger : 0)
  if (authored.some(Boolean)) {
    const agreeing = shapes.filter((shape) => shape.fingers.every((finger, at) => !authored[at] || authored[at] === finger))
    if (agreeing.length) return agreeing.sort((a, b) => a.cost - b.cost)
    // The lesson's own fingers win even where they are not our idea of comfortable.
    const lows = notes.flatMap((note, at) => authored[at] ? [note.fret - (authored[at] - 1)] : [])
    return [{ fingers: authored, cost: 0, low: Math.min(...lows), high: Math.max(...lows) }]
  }
  return shapes.sort((a, b) => a.cost - b.cost)
}

function transition(
  from: Moment, fromShape: Shape, to: Moment, toShape: Shape,
): number {
  let cost = 0
  const gap = Math.max(0, to.start - from.end)
  // A shift is easier in a pause or on an open string; reuse hurts most when the notes follow closely.
  const ease = Math.max(0.25, (gap >= 1 ? 0.5 : gap >= 0.5 ? 0.7 : 1) * (to.openBefore ? 0.3 : 1))
  const distance = Math.max(0, fromShape.low - toShape.high, toShape.low - fromShape.high)
  cost += distance * SHIFT_COST * ease
  const quick = Math.max(0, 1 - gap)
  const before = new Map<number, number>()
  from.notes.forEach((note, at) => before.set(fromShape.fingers[at], note.fret))
  const fretBefore = new Map<number, number>(from.notes.map((note, at) => [note.fret, fromShape.fingers[at]]))
  to.notes.forEach((note, at) => {
    const finger = toShape.fingers[at]
    const was = before.get(finger)
    if (was !== undefined && was !== note.fret) cost += REUSE_COST * quick
    const held = fretBefore.get(note.fret)
    if (held !== undefined && held !== finger) cost += SWITCH_COST * quick
  })
  return cost
}

/**
 * A finger for every fretted note, chosen over the whole part. Notes already carrying a lesson finger keep it (and
 * are not returned); notes the lesson leaves out are fingered around it. A moment too wide to finger is skipped.
 */
export function fingerSequence(
  notes: readonly FrettedTabNote[],
  config: FrettedInstrumentConfig,
): Map<number, number> {
  const placed = notes.filter((note) => note.position).sort((a, b) => a.startBeat - b.startBeat || a.index - b.index)
  const moments: Moment[] = []
  let open = false
  for (const note of placed) {
    if (note.position!.fret === 0) {
      open = true
      continue
    }
    const last = moments.at(-1)
    const item: FingerNote = { index: note.index, string: note.position!.string, fret: note.position!.fret, finger: note.finger }
    if (last && Math.abs(note.startBeat - last.start) < 1e-6) {
      last.notes.push(item)
      last.end = Math.max(last.end, note.startBeat + note.beats)
    } else {
      moments.push({ start: note.startBeat, end: note.startBeat + note.beats, notes: [item], openBefore: open, shapes: [] })
      open = false
    }
  }
  const best: { cost: number; back: number }[][] = []
  moments.forEach((moment, at) => {
    moment.shapes = fingerShapes(moment.notes, config)
    const states: { cost: number; back: number }[] = []
    const count = Math.max(1, moment.shapes.length)
    for (let slot = 0; slot < count; slot++) {
      const shape = moment.shapes[slot]
      const previous = moments[at - 1]
      let cost = Infinity
      let back = -1
      if (!previous || !previous.shapes.length || !shape) {
        cost = Math.min(...(best[at - 1]?.map((state) => state.cost) ?? [0]))
        back = best[at - 1]?.reduce((pick, state, index, all) => state.cost < all[pick].cost ? index : pick, 0) ?? -1
      } else {
        previous.shapes.forEach((from, index) => {
          const total = best[at - 1][index].cost + transition(previous, from, moment, shape)
          if (total < cost) { cost = total; back = index }
        })
      }
      states.push({ cost: cost + (shape?.cost ?? 0), back })
    }
    best.push(states)
  })
  const result = new Map<number, number>()
  let slot = best.at(-1)?.reduce((pick, state, index, all) => state.cost < all[pick].cost ? index : pick, 0) ?? 0
  for (let at = moments.length - 1; at >= 0; at--) {
    const shape = moments[at].shapes[slot]
    if (shape) moments[at].notes.forEach((note, order) => {
      if (!note.finger && shape.fingers[order]) result.set(note.index, shape.fingers[order])
    })
    slot = best[at][slot].back
    if (slot < 0) slot = 0
  }
  return result
}
