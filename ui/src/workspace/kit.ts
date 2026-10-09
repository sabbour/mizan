import type { DrumHit } from './song'

/** Physical kit pieces: four rack toms and two floor toms follow the six GM tom pitches. */
export type KitPiece = 'kick' | 'snare' | 'hihat' | 'tom1' | 'tom2' | 'tom3' | 'tom4' | 'floor1' | 'floor2' | 'ride' | 'crash'
export type HatState = 'closed' | 'half-open' | 'open' | 'pedal'

export const KIT_PIECES: { piece: KitPiece; label: string }[] = [
  { piece: 'crash', label: 'Crash' },
  { piece: 'hihat', label: 'Hi-hat' },
  { piece: 'tom1', label: 'High tom' },
  { piece: 'tom2', label: 'High-mid tom' },
  { piece: 'tom3', label: 'Low-mid tom' },
  { piece: 'tom4', label: 'Low tom' },
  { piece: 'snare', label: 'Snare' },
  { piece: 'ride', label: 'Ride' },
  { piece: 'floor1', label: 'High floor tom' },
  { piece: 'floor2', label: 'Low floor tom' },
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

const TOMS: Record<number, KitPiece> = { 50: 'tom1', 48: 'tom2', 47: 'tom3', 45: 'tom4', 43: 'floor1', 41: 'floor2' }
const RACK: KitPiece[] = ['tom1', 'tom2', 'tom3', 'tom4']
const FLOOR: KitPiece[] = ['floor1', 'floor2']
const label = (piece: KitPiece) => KIT_PIECES.find((item) => item.piece === piece)!.label

export function kitStrike(hit: DrumHit): KitStrike {
  const tom = hit.sourceMidi === undefined ? undefined : TOMS[hit.sourceMidi]
  switch (hit.lane) {
    case 'kick': return { pieces: ['kick'], specified: true, foot: true, label: 'Kick' }
    case 'snare': return { pieces: ['snare'], specified: true, foot: false, label: 'Snare' }
    case 'ride': return { pieces: ['ride'], specified: true, foot: false, label: 'Ride' }
    case 'crash': return { pieces: ['crash'], specified: true, foot: false, label: 'Crash' }
    case 'hightom':
    case 'floortom':
      if (tom && (hit.lane === 'hightom' ? tom !== 'floor1' && tom !== 'floor2' : true))
        return { pieces: [tom], specified: true, foot: false, label: label(tom) }
      return hit.lane === 'hightom'
        ? { pieces: RACK, specified: false, foot: false, label: 'Rack tom (which one is unspecified)' }
        : { pieces: FLOOR, specified: false, foot: false, label: 'Floor tom (which one is unspecified)' }
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
