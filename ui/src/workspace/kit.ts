import type { DrumHit } from './song'

/**
 * Physical kit pieces of a five-piece kit: two rack toms and one floor tom. The six GM tom pitches share them in
 * pairs (high and high-mid on tom 1, low-mid and low on tom 2, both floor toms on the floor tom); the hits keep
 * their source pitch for notation and sound.
 */
export type KitPiece = 'kick' | 'snare' | 'hihat' | 'tom1' | 'tom2' | 'floor' | 'ride' | 'crash'
export type HatState = 'closed' | 'half-open' | 'open' | 'pedal'

export const KIT_PIECES: { piece: KitPiece; label: string }[] = [
  { piece: 'crash', label: 'Crash' },
  { piece: 'hihat', label: 'Hi-hat' },
  { piece: 'tom1', label: 'Tom 1' },
  { piece: 'tom2', label: 'Tom 2' },
  { piece: 'snare', label: 'Snare' },
  { piece: 'ride', label: 'Ride' },
  { piece: 'floor', label: 'Floor tom' },
  { piece: 'kick', label: 'Kick' },
]

export const HAT_LABEL: Record<HatState, string> = {
  closed: 'closed', 'half-open': 'half-open', open: 'open', pedal: 'pedal',
}

/**
 * What a hit strikes. `specified` is false when the source only names a generic lane: such a tom lights its
 * whole family dimly, and a hat keeps no claimed state, rather than inventing a particular drum or pedal.
 */
export type KitStrike = { pieces: KitPiece[]; specified: boolean; hat?: HatState; foot: boolean; label: string }

const TOMS: Record<number, KitPiece> = { 50: 'tom1', 48: 'tom1', 47: 'tom2', 45: 'tom2', 43: 'floor', 41: 'floor' }
/** The GM tom pitches each lane can name, as playback tuning and exports trust them. */
const LANE_TOMS = { hightom: [50, 48, 47], floortom: [45, 43, 41] }
const RACK: KitPiece[] = ['tom1', 'tom2']
const label = (piece: KitPiece) => KIT_PIECES.find((item) => item.piece === piece)!.label

export function kitStrike(hit: DrumHit): KitStrike {
  switch (hit.lane) {
    case 'kick': return { pieces: ['kick'], specified: true, foot: true, label: 'Kick' }
    case 'snare': return { pieces: ['snare'], specified: true, foot: false, label: 'Snare' }
    case 'ride': return { pieces: ['ride'], specified: true, foot: false, label: 'Ride' }
    case 'crash': return { pieces: ['crash'], specified: true, foot: false, label: 'Crash' }
    case 'hightom':
    case 'floortom':
      // Trust a GM tom only on its own lane, as playback tuning and exports do. A generic floor-tom hit can only be
      // the one floor tom; a generic rack-tom hit could be either rack tom, so it lights both dimly.
      if (LANE_TOMS[hit.lane].includes(hit.sourceMidi ?? 0)) {
        const tom = TOMS[hit.sourceMidi!]
        return { pieces: [tom], specified: true, foot: false, label: label(tom) }
      }
      return hit.lane === 'hightom'
        ? { pieces: RACK, specified: false, foot: false, label: 'Rack tom (which one is unspecified)' }
        : { pieces: ['floor'], specified: true, foot: false, label: label('floor') }
    case 'openhat':
      return hit.articulation === 'half-open'
        ? { pieces: ['hihat'], specified: true, hat: 'half-open', foot: false, label: 'Hi-hat half-open' }
        : { pieces: ['hihat'], specified: true, hat: 'open', foot: false, label: 'Hi-hat open' }
    case 'hihat':
      if (hit.sourceMidi === 44) return { pieces: ['hihat'], specified: true, hat: 'pedal', foot: true, label: 'Hi-hat pedal' }
      if (hit.articulation === 'half-open') return { pieces: ['hihat'], specified: true, hat: 'half-open', foot: false, label: 'Hi-hat half-open' }
      if (hit.sourceMidi === 42) return { pieces: ['hihat'], specified: true, hat: 'closed', foot: false, label: 'Hi-hat closed' }
      return { pieces: ['hihat'], specified: false, foot: false, label: 'Hi-hat (state unspecified)' }
  }
}

/** Sample tuning for a specific tom, relative to its lane's sample (the lane's GM default pitch plays as before). */
export function tomRate(hit: DrumHit): number {
  const rates: Record<string, Record<number, number>> = {
    hightom: { 50: 1.12, 48: 1, 47: 0.92 },
    floortom: { 45: 1.2, 43: 1.1, 41: 1 },
  }
  return hit.sourceMidi === undefined ? 1 : rates[hit.lane]?.[hit.sourceMidi] ?? 1
}
