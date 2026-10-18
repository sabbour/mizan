import { kitStrike, type KitPiece } from './kit'
import { drumNotationBeats } from './musicxml'
import type { Song } from './song'

export type Hand = 'left' | 'right'
/** A hand for each drum hit (undefined for feet and for strokes no hand is suggested for), and where it came from. */
export type Sticking = { hands: (Hand | undefined)[]; source: 'lesson' | 'suggested' }

const CYMBALS = new Set<KitPiece>(['hihat', 'ride', 'crash'])
/** Where each piece sits across a right-handed kit, from the player's far left to far right (generic rack toms average). */
const X: Partial<Record<KitPiece, number>> = { crash: -2.5, hihat: -2, snare: -1, tom1: 0, tom2: 1, ride: 2, floor: 2.5 }
/** Seconds between strokes by one hand below which repeating that hand gets hard; at or above it, a repeat is free. */
const COMFORT = 0.3
/** The same, for a hand keeping time on one cymbal: hat and ride eighths stay on the right hand well past 200 bpm. */
const CYMBAL_COMFORT = 0.14
/** Tempo assumed when a song has none. */
const DEFAULT_BPM = 120

/**
 * The hands for a song's drum hits. An authored lesson's sticking is used as written. Otherwise a deterministic
 * suggestion for a right-handed player: the cheapest way through the whole part, found by dynamic programming (a Viterbi
 * search over where each hand last struck). Costs: the same hand twice in a row at a fast spacing (measured in seconds,
 * so tempo counts), an arm crossing over the other, distance travelled around the kit, the left hand on a cymbal
 * (the right hand keeps the hat or ride pattern), a cymbal changing hands, and a slight lean to the right hand.
 * So grooves are right on the cymbal and left on the snare; fast single strokes alternate; fills move toward the
 * side they travel to without crossing; and doubles appear only where alternating would force a crossing or an
 * impossible repeat. Two simultaneous cymbals use both hands; feet get no hand, and moments with more than two hand
 * strokes get no suggestion.
 */
export function stickingFor(song: Song): Sticking {
  if (song.drums.some((hit) => hit.hand)) return { hands: song.drums.map((hit) => hit.hand), source: 'lesson' }
  return { hands: suggestSticking(song), source: 'suggested' }
}

type Choice = { left: number[]; right: number[] }
/** The cheapest way to a state, as a chain back through the choices made. */
type Path = { cost: number; choice: Choice | null; previous: Path | null }
const NONE = ''

export function suggestSticking(song: Song): (Hand | undefined)[] {
  const hands: (Hand | undefined)[] = song.drums.map(() => undefined)
  const written = drumNotationBeats(song)
  // Hand strokes grouped by written moment; repeated hits of the same sound at one moment are one stroke.
  const moments = new Map<number, Map<string, number[]>>()
  song.drums.forEach((hit, index) => {
    const strike = kitStrike(hit)
    if (strike.foot) return
    const beat = Math.round(written[index] * 1e6) / 1e6
    const strokes = moments.get(beat) ?? new Map<string, number[]>()
    const sound = `${hit.lane}:${hit.sourceMidi ?? ''}`
    strokes.set(sound, [...strokes.get(sound) ?? [], index])
    moments.set(beat, strokes)
  })
  const secondsPerBeat = 60 / (song.bpm > 0 ? song.bpm : DEFAULT_BPM)
  const beats = [...moments.keys()].sort((a, b) => a - b)
  const piece = (indexes: number[]) => kitStrike(song.drums[indexes[0]]).pieces
  const isCymbal = (indexes: number[]) => CYMBALS.has(piece(indexes)[0])
  const x = (indexes: number[]) => {
    const pieces = piece(indexes)
    return pieces.reduce((sum, item) => sum + (X[item] ?? 0), 0) / pieces.length
  }
  // The key of the piece a stroke lands on, so a hand's position and a cymbal changing hands can be told apart.
  const where = (indexes: number[]) => piece(indexes).join('+')

  // What each moment could be: which stroke goes to which hand. Impossible moments have no options and get no hands.
  const options = beats.map((beat): Choice[] | null => {
    const strokes = [...moments.get(beat)!.values()]
    if (strokes.length === 1) return [{ left: strokes[0], right: [] }, { left: [], right: strokes[0] }]
    if (strokes.length !== 2) return null
    // Two sounds on one drum are played with both hands: the higher-pitched on the right, as before.
    const [a, b] = [...strokes].sort((p, q) => x(p) - x(q) || (song.drums[q[0]].sourceMidi ?? 0) - (song.drums[p[0]].sourceMidi ?? 0))
    if (where(a) === where(b)) return [{ left: a, right: b }]
    return [{ left: a, right: b }, { left: b, right: a }]
  })

  // A state is where each hand last struck and which hands played the moment before; the best way to reach it so far.
  let states = new Map<string, { left: string; right: string; played: number; path: Path }>([
    [`${NONE}|${NONE}|0`, { left: NONE, right: NONE, played: 0, path: { cost: 0, choice: null, previous: null } }],
  ])
  const positions = new Map<string, number>()
  for (let m = 0; m < beats.length; m++) {
    const choices = options[m]
    const gap = m ? (beats[m] - beats[m - 1]) * secondsPerBeat : Infinity
    const next = new Map<string, { left: string; right: string; played: number; path: Path }>()
    for (const state of states.values()) {
      for (const choice of choices ?? [{ left: [], right: [] }]) {
        const impossible = !choices
        let cost = state.path.cost
        const play = (hand: 'left' | 'right', stroke: number[]) => {
          const here = where(stroke)
          positions.set(here, x(stroke))
          const was = hand === 'left' ? state.left : state.right
          const otherWas = hand === 'left' ? state.right : state.left
          const mask = hand === 'left' ? 1 : 2
          // Hitting again with the hand that just played: free when slow, harder the faster it gets.
          if (state.played & mask) {
            const keepingTime = isCymbal(stroke) && was === here
            const comfort = keepingTime ? CYMBAL_COMFORT : COMFORT
            // Time-keeping gets hard quickly just under its limit; drum strokes ease in over the whole range.
            cost += 6 * Math.min(1, Math.max(0, (comfort - gap) / (keepingTime ? comfort / 2 : comfort)))
          }
          if (was !== NONE) cost += 0.15 * Math.abs(positions.get(was)! - x(stroke))
          // An arm crossing over the other: the left hand's strike right of where the right hand is, or the reverse.
          if (otherWas !== NONE) {
            const reach = hand === 'left' ? x(stroke) - positions.get(otherWas)! : positions.get(otherWas)! - x(stroke)
            if (reach > 0) cost += 0.25 * reach * reach
            if (isCymbal(stroke) && otherWas === here) cost += 0.3
          }
          if (hand === 'left') cost += isCymbal(stroke) ? 1.05 : 0.05
          // The first stroke of the part starts on the right, as most players do.
          if (hand === 'left' && !state.played && state.left === NONE && state.right === NONE) cost += 0.1
        }
        if (choice.left.length) play('left', choice.left)
        if (choice.right.length) play('right', choice.right)
        const left = choice.left.length ? where(choice.left) : state.left
        const right = choice.right.length ? where(choice.right) : state.right
        const played = impossible ? 3 : (choice.left.length ? 1 : 0) | (choice.right.length ? 2 : 0)
        const key = `${left}|${right}|${played}`
        const known = next.get(key)
        if (!known || cost < known.path.cost) next.set(key, { left, right, played, path: { cost, choice, previous: state.path } })
      }
    }
    states = next
  }
  let best: Path | null = null
  for (const state of states.values()) if (!best || state.path.cost < best.cost) best = state.path
  for (let m = beats.length - 1, path = best; m >= 0 && path?.choice; m--, path = path.previous) {
    if (!options[m]) continue
    for (const index of path.choice.left) hands[index] = 'left'
    for (const index of path.choice.right) hands[index] = 'right'
  }
  return hands
}
