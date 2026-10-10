import type { MelodyNote, Song, Track } from '../workspace/song'

/**
 * Original backing parts for the genre lessons: a bass line and a chord part in each style, built here from short
 * rhythmic cells and a stock progression, so nothing is taken from a recording. They play through the GM sound bank
 * like any other pitched track, so they share the drum clock, the speed, the loop and the mixer.
 */

/** One note of a cell: start and length in quarter-note beats from the bar line, the chord degree, and how hard. */
type Cell = [start: number, beats: number, degree: Degree, velocity?: number][]
/** One chord stroke: start and length in quarter-note beats from the bar line, and how hard. */
type Strokes = [start: number, beats: number, velocity?: number][]
/**
 * Bass degrees from the chord root: `1` root, `3` the chord's third, `5` fifth, `6` sixth, `7` the chord's seventh
 * (flat unless the chord is a major seventh), `8` the octave, and `>` a half step below the next bar's root.
 */
type Degree = '1' | '3' | '5' | '6' | '7' | '8' | '>'

type Style = {
  key: NonNullable<Song['key']>
  /** GM program (0-based) and the name shown in the track list. */
  bass: { program: number; name: string }
  harmony: { program: number; name: string }
  /** Chords for two-bar and four-bar lessons, one per bar. */
  progression: { two: [string, string]; four: [string, string, string, string] }
  /** Bass cells in turn, bar by bar. */
  bassline: Cell[]
  /** Chord strokes in turn, bar by bar. */
  comping: Strokes[]
  /** Where the chord part sits: the lowest note of every voicing is at or above this MIDI pitch. */
  floor: number
  /** How many chord tones to voice: three for triads and power chords, up to five for ninths. */
  voices?: number
}

const STYLES: Record<string, Style> = {
  rock: {
    key: { tonic: 'A', mode: 'major' },
    bass: { program: 34, name: 'Bass (picked)' }, harmony: { program: 29, name: 'Guitar (overdriven power chords)' },
    progression: { two: ['A5', 'D5'], four: ['A5', 'G5', 'D5', 'A5'] },
    bassline: [[[0, 0.5, '1'], [0.5, 0.5, '1'], [1, 0.5, '1'], [1.5, 0.5, '1'], [2, 0.5, '1'], [2.5, 0.5, '1'], [3, 0.5, '1'], [3.5, 0.5, '8']]],
    comping: [[[0, 1.5, 0.75], [1.5, 0.5, 0.6], [2, 2, 0.7]]],
    floor: 45,
  },
  blues: {
    key: { tonic: 'A', mode: 'major' },
    bass: { program: 33, name: 'Bass (fingered, walking boogie)' }, harmony: { program: 16, name: 'Organ (chords on 2 and 4)' },
    progression: { two: ['A7', 'D7'], four: ['A7', 'D7', 'A7', 'E7'] },
    bassline: [[[0, 1, '1'], [1, 1, '3'], [2, 1, '5'], [3, 1, '6']], [[0, 1, '8'], [1, 1, '6'], [2, 1, '5'], [3, 1, '3']]],
    comping: [[[1, 0.75, 0.6], [3, 0.75, 0.6]]],
    floor: 55, voices: 4,
  },
  reggae: {
    key: { tonic: 'A', mode: 'minor' },
    bass: { program: 33, name: 'Bass (fingered, round and low)' }, harmony: { program: 27, name: 'Guitar (skank on 2 and 4)' },
    progression: { two: ['Am', 'G'], four: ['Am', 'G', 'F', 'G'] },
    bassline: [[[0, 1.5, '1'], [2, 1, '5'], [3, 1, '3']], [[0, 1.5, '1'], [2, 0.5, '8'], [2.5, 0.5, '5'], [3, 1, '1']]],
    comping: [[[1, 0.25, 0.65], [3, 0.25, 0.65]]],
    floor: 60,
  },
  pop: {
    key: { tonic: 'C', mode: 'major' },
    bass: { program: 33, name: 'Bass (fingered)' }, harmony: { program: 4, name: 'Electric piano (chords)' },
    progression: { two: ['Am', 'F'], four: ['C', 'G', 'Am', 'F'] },
    bassline: [[[0, 0.75, '1'], [0.75, 0.75, '1'], [1.5, 0.5, '5'], [2, 0.75, '1'], [2.75, 0.75, '1'], [3.5, 0.5, '8']]],
    comping: [[[0, 1.5, 0.6], [1.5, 2.5, 0.55]]],
    floor: 55,
  },
  disco: {
    key: { tonic: 'A', mode: 'minor' },
    bass: { program: 33, name: 'Bass (fingered octaves)' }, harmony: { program: 48, name: 'Strings (chords)' },
    progression: { two: ['Am7', 'D7'], four: ['Am7', 'D7', 'Fmaj7', 'E7'] },
    bassline: [[[0, 0.5, '1'], [0.5, 0.5, '8'], [1, 0.5, '1'], [1.5, 0.5, '8'], [2, 0.5, '1'], [2.5, 0.5, '8'], [3, 0.5, '1'], [3.5, 0.5, '8']]],
    comping: [[[0, 2, 0.5], [2, 2, 0.5]]],
    floor: 57, voices: 4,
  },
  jazz: {
    key: { tonic: 'C', mode: 'major' },
    bass: { program: 32, name: 'Double bass (walking)' }, harmony: { program: 26, name: 'Jazz guitar (four to the bar)' },
    progression: { two: ['Dm7', 'G7'], four: ['Dm7', 'G7', 'Cmaj7', 'A7'] },
    bassline: [[[0, 1, '1'], [1, 1, '3'], [2, 1, '5'], [3, 1, '>']], [[0, 1, '1'], [1, 1, '8'], [2, 1, '5'], [3, 1, '>']]],
    comping: [[[0, 0.5, 0.45], [1, 0.5, 0.6], [2, 0.5, 0.45], [3, 0.5, 0.6]]],
    floor: 52, voices: 4,
  },
  bossa: {
    key: { tonic: 'C', mode: 'major' },
    bass: { program: 32, name: 'Double bass (root and fifth)' }, harmony: { program: 24, name: 'Nylon guitar (chords)' },
    progression: { two: ['Dm7', 'G7'], four: ['Cmaj7', 'A7', 'Dm7', 'G7'] },
    bassline: [[[0, 1.5, '1'], [1.5, 0.5, '5'], [2, 1.5, '5'], [3.5, 0.5, '1']]],
    // The guitar follows the two-bar figure of the lesson's cross-stick part.
    comping: [[[0, 1, 0.55], [1.5, 1, 0.55], [3, 1, 0.5]], [[1, 1, 0.55], [2.5, 1.5, 0.55]]],
    floor: 52, voices: 4,
  },
  metal: {
    key: { tonic: 'E', mode: 'minor' },
    bass: { program: 34, name: 'Bass (picked eighths)' }, harmony: { program: 30, name: 'Guitar (distorted gallop)' },
    progression: { two: ['E5', 'C5'], four: ['E5', 'C5', 'D5', 'B5'] },
    bassline: [[[0, 0.5, '1'], [0.5, 0.5, '1'], [1, 0.5, '1'], [1.5, 0.5, '1'], [2, 0.5, '1'], [2.5, 0.5, '1'], [3, 0.5, '1'], [3.5, 0.5, '1']]],
    comping: [[0, 1, 2, 3].flatMap((beat) => [[beat, 0.5, 0.7], [beat + 0.5, 0.25, 0.55], [beat + 0.75, 0.25, 0.55]] as Strokes)],
    floor: 40,
  },
  dnb: {
    key: { tonic: 'F', mode: 'minor' },
    bass: { program: 38, name: 'Synth bass (sub)' }, harmony: { program: 89, name: 'Warm pad (chords)' },
    progression: { two: ['Fm7', 'Dbmaj7'], four: ['Fm7', 'Dbmaj7', 'Bbm7', 'C7'] },
    bassline: [[[0, 1.75, '1'], [2.5, 1, '1'], [3.5, 0.5, '7']]],
    comping: [[[0, 4, 0.45]]],
    floor: 53, voices: 4,
  },
  soul: {
    key: { tonic: 'Eb', mode: 'major' },
    bass: { program: 33, name: 'Bass (fingered)' }, harmony: { program: 0, name: 'Piano (repeated eighth-note chords)' },
    progression: { two: ['Eb', 'Ab'], four: ['Eb', 'Cm', 'Ab', 'Bb7'] },
    // Six quarter-note beats: four dotted-quarter pulses of three eighths.
    bassline: [[[0, 2.5, '1'], [2.5, 0.5, '5'], [3, 1.5, '8'], [4.5, 1, '5'], [5.5, 0.5, '>']]],
    comping: [Array.from({ length: 12 }, (_, eighth) => [eighth / 2, 0.5, eighth % 3 ? 0.35 : 0.5] as [number, number, number])],
    floor: 55,
  },
  funk: {
    key: { tonic: 'E', mode: 'major' },
    bass: { program: 36, name: 'Slap bass' }, harmony: { program: 7, name: 'Clavinet (sixteenth chops)' },
    progression: { two: ['E9', 'A9'], four: ['E9', 'E9', 'A9', 'E9'] },
    bassline: [[[0, 0.5, '1', 0.9], [0.75, 0.25, '8'], [1.5, 0.25, '7'], [1.75, 0.25, '8'], [2.5, 0.5, '5'], [3.25, 0.25, '1'], [3.5, 0.5, '3']]],
    comping: [[[0.25, 0.25, 0.55], [0.75, 0.25, 0.5], [1.5, 0.25, 0.55], [2.25, 0.25, 0.55], [2.75, 0.25, 0.5], [3.5, 0.25, 0.55]]],
    floor: 52, voices: 4,
  },
}

/** The backing style for each genre, by the genre name its lessons show. */
export const GENRE_STYLE: Record<string, keyof typeof STYLES> = {
  Rock: 'rock', Blues: 'blues', Reggae: 'reggae', Pop: 'pop', 'Disco and dance': 'disco', Jazz: 'jazz',
  'Latin: bossa nova': 'bossa', Metal: 'metal', 'Drum and bass': 'dnb', 'R&B and soul': 'soul', Funk: 'funk',
}

const PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const QUALITY: Record<string, number[]> = {
  '': [0, 4, 7], m: [0, 3, 7], '5': [0, 7, 12], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], '9': [0, 4, 7, 10, 14],
}

/** Root pitch class and intervals of a chord symbol such as `Dbmaj7`, `F#m` or `E5`. */
export function parseChord(symbol: string): { root: number; intervals: number[] } {
  const match = /^([A-G])(#|b)?(.*)$/.exec(symbol)
  const intervals = match && QUALITY[match[3]]
  if (!match || !intervals) throw new Error(`Unknown chord symbol ${symbol}`)
  return { root: (PITCH[match[1]] + (match[2] === '#' ? 1 : match[2] === 'b' ? 11 : 0)) % 12, intervals }
}

/** Bass register: the root from E1 (MIDI 28) up to D#2, with the degree above it. */
function bassPitch(symbol: string, degree: Degree, next: string): number {
  const { root, intervals } = parseChord(symbol)
  const low = 28 + (root - 4 + 12) % 12
  if (degree === '>') {
    const target = 28 + (parseChord(next).root - 4 + 12) % 12
    return target - 1 < 28 ? target + 11 : target - 1
  }
  const third = intervals.includes(3) ? 3 : intervals.includes(4) ? 4 : 7
  const seventh = intervals.includes(11) ? 11 : 10
  return low + { '1': 0, '3': third, '5': 7, '6': 9, '7': seventh, '8': 12 }[degree]
}

/** A close voicing of the chord, its lowest note at or above the floor. */
function voicing(symbol: string, floor: number, voices: number): number[] {
  const { root, intervals } = parseChord(symbol)
  // A ninth chord drops its fifth when only four voices are wanted.
  const tones = intervals.length > voices ? intervals.filter((interval) => interval !== 7).slice(0, voices) : intervals
  const base = floor + (root - floor % 12 + 12) % 12
  return tones.map((interval) => base + interval)
}

/** What is left of a cell when the bar ends early: the band stops for a fill and lets it be heard. */
function clip<T extends [number, number, ...unknown[]]>(cell: T[], end: number): T[] {
  return cell.filter(([start]) => start < end).map((note) => [note[0], Math.min(note[1], end - note[0]), ...note.slice(2)] as T)
}

export type Backing = { style: string; chords: string[]; tracks: Track[]; notes: Record<string, MelodyNote[]> }

/**
 * The backing for a genre lesson: one chord per bar from the style's progression, the bass and chord cells in turn,
 * and both parts stopping at the half bar where a fill section starts so the fill stands alone.
 */
export function genreBacking(style: string, bars: number, beatsPerBar: number, fills: boolean[]): Backing {
  const spec = STYLES[style]
  if (!spec) throw new Error(`No backing for the ${style} style`)
  if (bars !== 2 && bars !== 4) throw new Error(`Genre backing needs two or four bars, not ${bars}`)
  const chords = bars === 2 ? [...spec.progression.two] : [...spec.progression.four]
  const bass: MelodyNote[] = []
  const harmony: MelodyNote[] = []
  for (let bar = 0; bar < bars; bar++) {
    const start = bar * beatsPerBar
    const end = fills[bar] ? beatsPerBar / 2 : beatsPerBar
    const next = chords[(bar + 1) % bars]
    for (const [at, beats, degree, velocity = 0.8] of clip(spec.bassline[bar % spec.bassline.length], end))
      bass.push({ trackId: 'bass', midi: bassPitch(chords[bar], degree, next), startBeat: start + at, beats, velocity })
    const tones = voicing(chords[bar], spec.floor, spec.voices ?? 3)
    for (const [at, beats, velocity = 0.6] of clip(spec.comping[bar % spec.comping.length], end))
      for (const midi of tones) harmony.push({ trackId: 'harmony', midi, startBeat: start + at, beats, velocity })
  }
  const progression = chords.join(' – ')
  return {
    style, chords,
    tracks: [
      { id: 'bass', instrument: 'other', gmProgram: spec.bass.program, name: spec.bass.name,
        detail: `Backing bass line over ${progression}, original and generated for this lesson (not transcribed)` },
      { id: 'harmony', instrument: 'other', gmProgram: spec.harmony.program, name: spec.harmony.name,
        detail: `Backing chords ${progression}, original and generated for this lesson (not transcribed)` },
    ],
    notes: { bass, harmony },
  }
}

export const backingKey = (style: string) => STYLES[style].key
