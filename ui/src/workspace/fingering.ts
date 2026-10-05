import type { PianoNote } from './song'

type Finger = 1 | 2 | 3 | 4 | 5
export type Fingered = PianoNote & { finger: Finger }

type Group = { indices: number[]; pitches: number[]; states: Finger[][] }
const FINGERS: Finger[] = [1, 2, 3, 4, 5]
const POSITION = [0, 0, 2, 4, 5, 7]
const BLACK = new Set([1, 3, 6, 8, 10])

function chordFingers(pitches: number[], left: boolean): Finger[] {
  const span = pitches[pitches.length - 1] - pitches[0]
  // ponytail: more than five simultaneous pitches reuse fingers; split voices for playable parts.
  const pattern: Finger[] = pitches.length === 2 ? [1, span <= 4 ? 3 : 5]
    : pitches.length === 3 ? [1, span > 9 || pitches[1] - pitches[0] <= 2 ? 2 : 3, 5]
    : pitches.length === 4 ? [1, 2, 3, 5]
    : pitches.map((_, i) => FINGERS[Math.round(i * 4 / (pitches.length - 1))])
  return left ? pattern.map((f) => FINGERS[5 - f]) : pattern
}

function movement(delta: number, from: Finger, to: Finger): number {
  if (delta === 0) return from === to ? 0 : 1.5
  const distance = Math.abs(delta)
  if (from === to) return 9 + distance * 0.3
  if (delta * (to - from) < 0) {
    const thumbCrossing = delta > 0 ? to === 1 : from === 1
    const other = from === 1 ? to : from
    if (thumbCrossing) return 2 + (other === 3 ? 0 : other === 4 ? 0.2 : 1)
      + (distance - 1) ** 2 * 0.5
    return 12 + distance + (from >= 4 || to >= 4 ? 4 : 0)
  }
  const comfortable = Math.abs(POSITION[to] - POSITION[from])
  return (distance - comfortable) ** 2 * 0.08
    + Math.max(0, distance - comfortable - 2) ** 2 * 0.7
    + (from >= 4 && to >= 4 ? 0.15 : 0)
}

function nearest(pitches: number[], target: number): number {
  let best = 0
  for (let i = 1; i < pitches.length; i++) {
    if (Math.abs(pitches[i] - target) < Math.abs(pitches[best] - target)) best = i
  }
  return best
}

export function finger(notes: PianoNote[]): Fingered[] {
  const result: Fingered[] = notes.map((note) => ({ ...note, finger: 1 }))
  for (const hand of ['right', 'left'] as const) {
    const left = hand === 'left'
    const direction = left ? -1 : 1
    const indices = notes.map((_, i) => i).filter((i) => notes[i].hand === hand)
      .sort((a, b) => notes[a].startBeat - notes[b].startBeat || notes[a].midi - notes[b].midi || a - b)
    const groups: Group[] = []
    for (const index of indices) {
      let group = groups[groups.length - 1]
      if (!group || notes[index].startBeat - notes[group.indices[0]].startBeat > 0.01 + 1e-9) {
        group = { indices: [], pitches: [], states: [] }
        groups.push(group)
      }
      group.indices.push(index)
    }
    for (const group of groups) {
      group.pitches = [...new Set(group.indices.map((i) => notes[i].midi))].sort((a, b) => a - b)
      group.states = group.pitches.length === 1 ? FINGERS.map((f) => [f]) : [chordFingers(group.pitches, left)]
    }
    const back: number[][] = []
    let costs: number[] = []
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]
      const prev = groups[i - 1]
      const parents: number[] = []
      const nextCosts: number[] = []
      const pairs: [number, number][] = !prev ? [] : prev.pitches.length > 1 && group.pitches.length > 1
        ? [[0, 0], [prev.pitches.length - 1, group.pitches.length - 1]]
        : [[nearest(prev.pitches, group.pitches[0]), nearest(group.pitches, prev.pitches[0])]]
      for (const state of group.states) {
        let best = Infinity
        let parent = 0
        if (!prev) {
          const next = groups[1]
          const ascending = !next || (next.pitches[0] - group.pitches[0]) * direction >= 0
          best = Math.abs(state[0] - (ascending ? 1 : 5)) * 0.12
        } else {
          for (let p = 0; p < prev.states.length; p++) {
            let cost = costs[p]
            for (const [a, b] of pairs) {
              cost += movement((group.pitches[b] - prev.pitches[a]) * direction, prev.states[p][a], state[b]) / pairs.length
            }
            if (cost < best) {
              best = cost
              parent = p
            }
          }
        }
        for (let n = 0; n < state.length; n++) {
          if (state[n] === 1 && BLACK.has(((group.pitches[n] % 12) + 12) % 12)) best += 0.9
        }
        nextCosts.push(best)
        parents.push(parent)
      }
      costs = nextCosts
      back.push(parents)
    }
    let state = 0
    for (let i = 1; i < costs.length; i++) if (costs[i] < costs[state]) state = i
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i]
      for (const index of group.indices) {
        result[index].finger = group.states[state][group.pitches.indexOf(notes[index].midi)]
      }
      state = back[i][state]
    }
  }
  return result
}
