import type { MelodyNote, Track } from './song'
import {
  BASS, identifiesInstrument, mapFrettedNote, notesForTrack, planFrettedTab,
  positionsForMidi as positionsForMidiForConfig, visualStatePriority,
  type FrettedPosition, type FrettedTabNote, type FrettedVisualState,
} from './fretboard'

export const BASS_SCALE_LENGTH = BASS.scaleLength
export const BASS_MAX_FRET = BASS.frets
export const BASS_STRINGS = BASS.strings
export type BassString = (typeof BASS_STRINGS)[number]
export type BassPosition = FrettedPosition
export type BassTabNote = FrettedTabNote
export type BassVisualState = FrettedVisualState

export const fretDistanceFromNut = (fret: number) => {
  if (!Number.isInteger(fret) || fret < 0) throw new RangeError('A bass fret must be a non-negative integer.')
  return BASS.scaleLength * (1 - 2 ** (-fret / 12))
}
export const fretPositionX = (fret: number, nutX = BASS.scaleLength) => nutX - fretDistanceFromNut(fret)
export const positionsForMidi = (midi: number) => positionsForMidiForConfig(midi, BASS)
export const mapBassNote = (midi: number) => mapFrettedNote(midi, BASS)
export const planBassTab = (notes: readonly MelodyNote[]) => planFrettedTab(notes, BASS)
export const isBassTrack = (track: Track & { sourceInstrument?: string }) => identifiesInstrument(track, 'bass')
export const bassNotes = notesForTrack
export { BASS as bassConfig, visualStatePriority }
