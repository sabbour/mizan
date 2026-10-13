import { barAt, measures } from './meter'
import type { MelodyNote, Song, Track } from './song'

export type FrettedString = {
  string: number
  conventionalStringNumber: number
  name: string
  openPitch: string
  midi: number
  gaugeInches: number
}

export type FrettedInstrumentConfig = {
  id: 'guitar' | 'bass'
  name: string
  file: string
  scaleLength: number
  frets: number
  strings: readonly FrettedString[]
  styles: readonly string[]
}

export const GUITAR: FrettedInstrumentConfig = {
  id: 'guitar',
  name: 'Electric guitar',
  file: 'ElectricGuitar.glb',
  scaleLength: 0.6477,
  frets: 22,
  strings: [
    { string: 1, conventionalStringNumber: 6, name: 'Low E', openPitch: 'E2', midi: 40, gaugeInches: 0.046 },
    { string: 2, conventionalStringNumber: 5, name: 'A', openPitch: 'A2', midi: 45, gaugeInches: 0.036 },
    { string: 3, conventionalStringNumber: 4, name: 'D', openPitch: 'D3', midi: 50, gaugeInches: 0.026 },
    { string: 4, conventionalStringNumber: 3, name: 'G', openPitch: 'G3', midi: 55, gaugeInches: 0.017 },
    { string: 5, conventionalStringNumber: 2, name: 'B', openPitch: 'B3', midi: 59, gaugeInches: 0.013 },
    { string: 6, conventionalStringNumber: 1, name: 'High E', openPitch: 'E4', midi: 64, gaugeInches: 0.01 },
  ],
  styles: ['Realistic', 'HandPaintedAnime', 'Stylized3D', 'NeonRhythm', 'TechnicalLearning', 'ToyDiorama', 'Watercolor', 'VintageConcert'],
}

export const BASS: FrettedInstrumentConfig = {
  id: 'bass',
  name: 'Electric bass',
  file: 'ElectricBass.glb',
  scaleLength: 0.8636,
  frets: 20,
  strings: [
    { string: 1, conventionalStringNumber: 4, name: 'Low E', openPitch: 'E1', midi: 28, gaugeInches: 0.105 },
    { string: 2, conventionalStringNumber: 3, name: 'A', openPitch: 'A1', midi: 33, gaugeInches: 0.085 },
    { string: 3, conventionalStringNumber: 2, name: 'D', openPitch: 'D2', midi: 38, gaugeInches: 0.065 },
    { string: 4, conventionalStringNumber: 1, name: 'G', openPitch: 'G2', midi: 43, gaugeInches: 0.045 },
  ],
  styles: ['Realistic', 'HandPaintedAnime', 'Stylized3D', 'NeonRhythm', 'TechnicalLearning', 'ToyDiorama', 'Watercolor', 'VintageConcert'],
}

export type FrettedPosition = {
  string: number
  conventionalStringNumber: number
  fret: number
  midi: number
  pitchName: string
  pitchClass: string
  octave: number
  fretboardCoordinate: number
  fretDistanceFromNut: number
}

export type FrettedTabNote = {
  index: number
  midi: number
  startBeat: number
  beats: number
  position?: FrettedPosition
  finger?: 1 | 2 | 3 | 4 | 5
  reason?: 'fractional-pitch' | 'outside-range' | 'no-distinct-string'
    | 'invalid-authored-position'
}

export type FrettedVisualState =
  | 'incorrectly-played' | 'correctly-played' | 'current-played' | 'current-target'
  | 'upcoming' | 'held' | 'muted' | 'open' | 'scale' | 'chord' | 'root'
  | 'suggested-finger' | 'selected'

const PITCH_CLASSES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']

export function fretDistanceFromNut(fret: number, config: FrettedInstrumentConfig): number {
  if (!Number.isInteger(fret) || fret < 0) throw new RangeError('A fret must be a non-negative integer.')
  return config.scaleLength * (1 - 2 ** (-fret / 12))
}

export function fretPositionX(fret: number, config: FrettedInstrumentConfig, nutX = config.scaleLength): number {
  return nutX - fretDistanceFromNut(fret, config)
}

function positionFor(string: FrettedString, fret: number, config: FrettedInstrumentConfig): FrettedPosition {
  const midi = string.midi + fret
  const pitchClass = PITCH_CLASSES[midi % 12]
  return {
    string: string.string,
    conventionalStringNumber: string.conventionalStringNumber,
    fret,
    midi,
    pitchName: `${pitchClass}${Math.floor(midi / 12) - 1}`,
    pitchClass,
    octave: Math.floor(midi / 12) - 1,
    fretboardCoordinate: fret === 0 ? config.scaleLength
      : (fretPositionX(fret - 1, config) + fretPositionX(fret, config)) / 2,
    fretDistanceFromNut: fretDistanceFromNut(fret, config),
  }
}

export function positionForStringFret(stringNumber: number, fret: number, config: FrettedInstrumentConfig): FrettedPosition | null {
  const string = config.strings.find((item) => item.string === stringNumber)
  return string && Number.isInteger(fret) && fret >= 0 && fret <= config.frets
    ? positionFor(string, fret, config) : null
}

export function positionsForMidi(midi: number, config: FrettedInstrumentConfig): FrettedPosition[] {
  if (!Number.isInteger(midi)) return []
  return config.strings.flatMap((string) => {
    const fret = midi - string.midi
    return fret >= 0 && fret <= config.frets ? [positionFor(string, fret, config)] : []
  }).sort((a, b) => a.fret - b.fret || a.string - b.string)
}

export function mapFrettedNote(midi: number, config: FrettedInstrumentConfig): FrettedPosition | null {
  return positionsForMidi(midi, config)[0] ?? null
}

/** Deterministic maximum matching; notes in a chord never share a physical string. */
export function planFrettedTab(
  notes: readonly (MelodyNote & { string?: number; fret?: number })[],
  config: FrettedInstrumentConfig,
): FrettedTabNote[] {
  const result: FrettedTabNote[] = notes.map((note, index) => ({
    index, midi: note.midi, startBeat: note.startBeat, beats: note.beats,
    finger: note.finger,
    reason: Number.isInteger(note.midi) ? undefined : 'fractional-pitch',
  }))
  const authored = notes.map((note) => {
    if (note.string === undefined && note.fret === undefined) return undefined
    if (!Number.isInteger(note.string) || !Number.isInteger(note.fret)) return null
    const string = config.strings.find((item) => item.string === note.string)
    if (!string || note.fret! < 0 || note.fret! > config.frets || string.midi + note.fret! !== note.midi) return null
    return positionFor(string, note.fret!, config)
  })
  for (let index = 0; index < result.length; index++)
    if (authored[index] === null) result[index].reason = 'invalid-authored-position'
  const groups = new Map<number, number[]>()
  for (const item of result) {
    if (item.reason) continue
    const group = groups.get(item.startBeat) ?? []
    group.push(item.index)
    groups.set(item.startBeat, group)
  }
  for (const indices of groups.values()) {
    const candidates = new Map(indices.map((index) => [index, authored[index] ? [authored[index]!] : positionsForMidi(result[index].midi, config)]))
    const ordered = [...indices].sort((a, b) =>
      candidates.get(a)!.length - candidates.get(b)!.length ||
      result[a].midi - result[b].midi || a - b)
    const assigned = new Map<number, FrettedPosition>()
    const occupied = new Map<number, number>()
    const place = (index: number, seen: Set<number>): boolean => {
      for (const position of candidates.get(index)!) {
        if (seen.has(position.string)) continue
        seen.add(position.string)
        const previous = occupied.get(position.string)
        if (previous === undefined || place(previous, seen)) {
          occupied.set(position.string, index)
          assigned.set(index, position)
          return true
        }
      }
      return false
    }
    for (const index of ordered) {
      if (!candidates.get(index)!.length) result[index].reason = 'outside-range'
      else if (!place(index, new Set())) result[index].reason = 'no-distinct-string'
    }
    for (const [index, position] of assigned) {
      result[index].position = position
      result[index].reason = undefined
    }
  }
  return result
}

export function notesByMeasure(song: Song, notes: readonly FrettedTabNote[]) {
  return measures(song).map((bar, index) => ({
    bar,
    number: index + 1,
    notes: notes.flatMap((note) =>
      note.startBeat < bar.startBeat + bar.beats &&
      note.startBeat + note.beats > bar.startBeat ? [note] : []),
  }))
}

export function measureAtBeat(song: Song, beat: number): number {
  return barAt(song, beat)
}

export function positionName(string: number, fret: number): string {
  return `Position_S${string}_F${fret}`
}

export function visualStatePriority(state: FrettedVisualState): number {
  return ({
    'incorrectly-played': 8, 'correctly-played': 7, 'current-played': 7, 'current-target': 6, held: 5,
    upcoming: 4, chord: 3, scale: 3, root: 3, 'suggested-finger': 2, selected: 1, open: 0, muted: 0,
  })[state]
}

export function notesForTrack(song: Song, track?: Track, trackId?: string): readonly MelodyNote[] {
  const id = track?.id ?? trackId
  if (track?.instrument === 'piano' || !id) return song.piano
  return song.instrumentNotes?.[id] ?? (track?.instrument !== 'other' ? song.piano : [])
}

export function identifiesInstrument(
  track: Track & { sourceInstrument?: string },
  kind: 'guitar' | 'bass',
): boolean {
  const identity = `${track.sourceInstrument ?? ''} ${track.id} ${track.name}`.toLowerCase().replace(/[_-]+/g, ' ')
  if (Number.isInteger(track.gmProgram) && track.gmProgram! >= 24 && track.gmProgram! <= 39)
    return kind === 'guitar' ? track.gmProgram! <= 31 : track.gmProgram! >= 32
  const has = (word: string) => new RegExp(`(?:^|[^a-z0-9])${word}(?:$|[^a-z0-9])`).test(identity)
  if (has('ukulele') || has('ukelele') || has('mandolin')) return false
  if (kind === 'guitar') return !has('bass') && (has('guitar') || has('gtr'))
  return has('bass')
}
