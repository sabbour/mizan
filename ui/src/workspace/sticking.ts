import { kitStrike, type KitPiece } from './kit'
import { drumNotationBeats } from './musicxml'
import type { Song } from './song'

export type Hand = 'left' | 'right'
/** A hand for each drum hit (undefined for feet and for strokes no hand is suggested for), and where it came from. */
export type Sticking = { hands: (Hand | undefined)[]; source: 'lesson' | 'suggested' }

const CYMBALS = new Set<KitPiece>(['hihat', 'ride', 'crash'])
/** Drums from the player's left to right on the five-piece kit; generic rack-tom hits sit between the two racks. */
const DRUM_ORDER: Partial<Record<KitPiece, number>> = { snare: 0, tom1: 1, tom2: 2, floor: 3 }
/** Single drum strokes this close (in beats) to the stroke before alternate hands: sixteenths and triplets. */
const RUN_GAP = 0.34

/**
 * The hands for a song's drum hits. An authored lesson's sticking is used as written. Otherwise a simple,
 * deterministic right-hand-lead suggestion: a cymbal alone is the right hand; a cymbal with one drum is right on
 * the cymbal and left on the drum; two drums split by kit position (two notes on one drum take both hands); a
 * single drum alternates with the stroke before it in fast runs and is otherwise the right hand. Feet get no hand,
 * and moments with more than two hand strokes, or two cymbals, get no suggestion.
 */
export function stickingFor(song: Song): Sticking {
  if (song.drums.some((hit) => hit.hand)) return { hands: song.drums.map((hit) => hit.hand), source: 'lesson' }
  return { hands: suggestSticking(song), source: 'suggested' }
}

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
  let previous: { beat: number; lead: Hand | null } | null = null
  for (const beat of [...moments.keys()].sort((a, b) => a - b)) {
    const strokes = [...moments.get(beat)!.values()]
    const piece = (indexes: number[]) => kitStrike(song.drums[indexes[0]]).pieces
    const isCymbal = (indexes: number[]) => CYMBALS.has(piece(indexes)[0])
    const order = (indexes: number[]) => {
      const pieces = piece(indexes)
      return pieces.reduce((sum, item) => sum + (DRUM_ORDER[item] ?? 0), 0) / pieces.length
    }
    let assigned: [number[], Hand][] = []
    if (strokes.length === 1) {
      const [stroke] = strokes
      const run = previous && beat - previous.beat <= RUN_GAP
      const hand: Hand = isCymbal(stroke) || !run ? 'right' : previous!.lead === 'right' ? 'left' : 'right'
      assigned = [[stroke, hand]]
    } else if (strokes.length === 2) {
      const cymbals = strokes.filter(isCymbal)
      if (cymbals.length === 1) {
        assigned = strokes.map((stroke) => [stroke, isCymbal(stroke) ? 'right' : 'left'])
      } else if (!cymbals.length) {
        // The drum further right takes the right hand; two sounds on one drum are played with both hands.
        const [left, right] = [...strokes].sort((a, b) => order(a) - order(b) ||
          (song.drums[b[0]].sourceMidi ?? 0) - (song.drums[a[0]].sourceMidi ?? 0))
        assigned = [[left, 'left'], [right, 'right']]
      }
    }
    for (const [stroke, hand] of assigned) for (const index of stroke) hands[index] = hand
    // After both hands, the next single stroke starts again on the right.
    previous = { beat, lead: assigned.length === 1 ? assigned[0][1] : assigned.length === 2 ? 'left' : null }
  }
  return hands
}
