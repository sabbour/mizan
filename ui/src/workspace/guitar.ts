import type { MelodyNote, Track } from './song'
import {
  GUITAR, identifiesInstrument, mapFrettedNote, notesForTrack, planFrettedTab,
  positionsForMidi as positionsForMidiForConfig, visualStatePriority,
  type FrettedPosition, type FrettedTabNote, type FrettedVisualState,
} from './fretboard'

export const GUITAR_SCALE_LENGTH = GUITAR.scaleLength
export const GUITAR_MAX_FRET = GUITAR.frets
export const GUITAR_STRINGS = GUITAR.strings
export type GuitarString = (typeof GUITAR_STRINGS)[number]
export type GuitarPosition = FrettedPosition
export type GuitarTabNote = FrettedTabNote
export type GuitarVisualState = FrettedVisualState

export const fretDistanceFromNut = (fret: number) => fretDistance(fret)
function fretDistance(fret: number) {
  if (!Number.isInteger(fret) || fret < 0) throw new RangeError('A guitar fret must be a non-negative integer.')
  return GUITAR.scaleLength * (1 - 2 ** (-fret / 12))
}

export function fretPositionX(fret: number, nutX = GUITAR.scaleLength): number {
  return nutX - fretDistance(fret)
}

export const positionsForMidi = (midi: number) => positionsForMidiForConfig(midi, GUITAR)

export const mapGuitarNote = (midi: number) => mapFrettedNote(midi, GUITAR)
export const planGuitarTab = (notes: readonly MelodyNote[]) => planFrettedTab(notes, GUITAR)
export const isGuitarTrack = (track: Track & { sourceInstrument?: string }) => identifiesInstrument(track, 'guitar')
export const guitarNotes = notesForTrack
export { GUITAR as guitarConfig, visualStatePriority }
