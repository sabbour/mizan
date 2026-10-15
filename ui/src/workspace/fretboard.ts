import { barAt, measures } from './meter'
import type { MelodyNote, Song, Track } from './song'
import { FRETTED_LOOKS, type FrettedStyle } from './frettedStyles'

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
  styles: readonly FrettedStyle[]
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
  styles: FRETTED_LOOKS,
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
  styles: FRETTED_LOOKS,
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
    | 'invalid-authored-position' | 'not-playable'
  /** The position was changed so the moment can be played. */
  adjusted?: boolean
}

export type FrettedVisualState =
  | 'incorrectly-played' | 'correctly-played' | 'current-played' | 'current-target'
  | 'upcoming' | 'held' | 'muted' | 'open' | 'scale' | 'chord' | 'root'
  | 'suggested-finger' | 'selected'

const PITCH_CLASSES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']

export function frettedPitchName(midi: number): string {
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) return `MIDI ${midi}`
  return `${PITCH_CLASSES[midi % 12]}${Math.floor(midi / 12) - 1}`
}

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
    pitchName: frettedPitchName(midi),
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

type Layout = Map<number, FrettedPosition>
type Moment = { indices: number[]; start: number; end: number; layouts: Layout[]; costs: number[] }

/** Fretted frets of a layout, lowest to highest; open strings take no part in the hand position. */
const frettedSpan = (layout: Layout) => {
  let low = Infinity
  let high = 0
  for (const position of layout.values()) if (position.fret > 0) {
    low = Math.min(low, position.fret)
    high = Math.max(high, position.fret)
  }
  return high ? { low, high } : null
}

// How hard a layout is to hold: a wide stretch, a high position, and (a little) not using open strings.
const layoutCost = (layout: Layout) => {
  const span = frettedSpan(layout)
  let cost = 0
  for (const position of layout.values()) cost += position.fret * 0.04
  if (span) cost += (span.high - span.low) * 0.6 + (span.high - span.low > 4 ? 8 : 0)
  return cost
}

/**
 * How hard it is to get the hand from one layout to the next: staying inside one hand position is nearly free, and a
 * shift costs more the further it goes, less after a pause, and nothing across an open string (the hand moves unheard).
 */
const handMove = (from: Layout, to: Layout, gap: number) => {
  const a = frettedSpan(from)
  const b = frettedSpan(to)
  if (!a || !b) return a || b ? 0.2 : 0
  const reach = Math.max(a.high, b.high) - Math.min(a.low, b.low)
  const ease = gap >= 1 ? 0.5 : gap >= 0.5 ? 0.7 : 1
  const centre = Math.abs((b.low + b.high) / 2 - (a.low + a.high) / 2)
  return reach <= 3 ? centre * 0.1 : (1 + (reach - 3) * 0.5) * ease + centre * 0.1
}

/** Every way to put these notes on distinct strings (capped), each with its cost, the cheapest few first. */
function layoutsFor(
  indices: readonly number[], candidates: Map<number, FrettedPosition[]>, greedy: Layout,
): { layouts: Layout[]; costs: number[] } {
  const order = [...indices].sort((a, b) => candidates.get(a)!.length - candidates.get(b)!.length || a - b)
  const found: Layout[] = [greedy]
  const taken = new Set<number>()
  const current: Layout = new Map()
  let visits = 0
  const walk = (depth: number) => {
    if (visits > 400) return
    if (depth === order.length) {
      visits++
      found.push(new Map(current))
      return
    }
    for (const position of candidates.get(order[depth])!) {
      if (taken.has(position.string)) continue
      taken.add(position.string)
      current.set(order[depth], position)
      walk(depth + 1)
      current.delete(order[depth])
      taken.delete(position.string)
    }
  }
  walk(0)
  const unique = new Map<string, { layout: Layout; cost: number }>()
  for (const layout of found) {
    const key = [...layout].sort((x, y) => x[0] - y[0]).map(([index, position]) => `${index}:${position.string}:${position.fret}`).join(',')
    if (!unique.has(key)) unique.set(key, { layout, cost: layoutCost(layout) })
  }
  const ranked = [...unique.values()].sort((a, b) => a.cost - b.cost).slice(0, 10)
  return { layouts: ranked.map((item) => item.layout), costs: ranked.map((item) => item.cost) }
}

/**
 * Deterministic maximum matching; notes in a chord never share a physical string. Where a note can lie on several
 * strings, the choice is made over the whole part (cheapest path: compact chords, few hand shifts) rather than
 * by lowest fret each time, so a melody stays in one position.
 */
export function planFrettedTab(
  notes: readonly (MelodyNote & { string?: number; fret?: number })[],
  config: FrettedInstrumentConfig,
): FrettedTabNote[] {
  const result: FrettedTabNote[] = notes.map((note, index) => ({
    index, midi: note.midi, startBeat: note.startBeat, beats: note.beats,
    finger: note.finger,
    ...(note.adjusted ? { adjusted: true } : {}),
    reason: !Number.isInteger(note.midi) ? 'fractional-pitch' : note.notPlayable ? 'not-playable' : undefined,
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
  const moments: Moment[] = []
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
    if (!assigned.size) continue
    const placed = [...assigned.keys()]
    const ranked = layoutsFor(placed, candidates, assigned)
    moments.push({
      indices: placed, start: result[placed[0]].startBeat,
      end: Math.max(...placed.map((index) => result[index].startBeat + result[index].beats)),
      layouts: ranked.layouts, costs: ranked.costs,
    })
  }
  moments.sort((a, b) => a.start - b.start || a.indices[0] - b.indices[0])
  const cheapest: { cost: number; back: number }[][] = []
  moments.forEach((moment, at) => {
    const previous = moments[at - 1]
    cheapest.push(moment.layouts.map((layout, slot) => {
      let cost = Infinity
      let back = 0
      if (!previous) cost = 0
      else previous.layouts.forEach((from, index) => {
        const total = cheapest[at - 1][index].cost + handMove(from, layout, moment.start - previous.end)
        if (total < cost) { cost = total; back = index }
      })
      return { cost: cost + moment.costs[slot], back }
    }))
  })
  let slot = cheapest.at(-1)?.reduce((pick, state, index, all) => state.cost < all[pick].cost ? index : pick, 0) ?? 0
  for (let at = moments.length - 1; at >= 0; at--) {
    for (const [index, position] of moments[at].layouts[slot]) {
      result[index].position = position
      result[index].reason = undefined
    }
    slot = cheapest[at][slot].back
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
  if (Number.isInteger(track.gmProgram) && track.gmProgram! >= 0 && track.gmProgram! <= 127)
    return kind === 'guitar' ? track.gmProgram! >= 24 && track.gmProgram! <= 31
      : track.gmProgram! >= 32 && track.gmProgram! <= 39
  const has = (word: string) => new RegExp(`(?:^|[^a-z0-9])${word}(?:$|[^a-z0-9])`).test(identity)
  if (has('ukulele') || has('ukelele') || has('mandolin')) return false
  if (kind === 'guitar') return !has('bass') && (has('guitar') || has('gtr'))
  return has('bass')
}
