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
  /**
   * Chords for eight-bar and sixteen-bar lessons, one bar each; a bar written `Dm7 G7` splits evenly between two chords.
   * The sixteen bars are an A and a B section with richer chords and a turnaround back to the top.
   */
  progression: { eight: string[]; sixteen: string[] }
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
    bass: { program: 34, name: 'Bass (picked)' }, harmony: { program: 29, name: 'Guitar (overdriven chords)' },
    progression: {
      eight: ['A5', 'D5', 'E5', 'A5', 'F#5', 'D5', 'G5 D5', 'E5'],
      sixteen: ['Aadd9', 'Asus4 A', 'D', 'A', 'F#m', 'D', 'Esus4', 'E', 'Dadd9', 'A', 'G', 'D', 'F#m', 'D', 'G D', 'E'],
    },
    bassline: [[[0, 0.5, '1'], [0.5, 0.5, '1'], [1, 0.5, '1'], [1.5, 0.5, '1'], [2, 0.5, '1'], [2.5, 0.5, '1'], [3, 0.5, '1'], [3.5, 0.5, '8']]],
    comping: [[[0, 1.5, 0.75], [1.5, 0.5, 0.6], [2, 2, 0.7]]],
    floor: 45,
  },
  blues: {
    key: { tonic: 'A', mode: 'major' },
    bass: { program: 33, name: 'Bass (fingered, walking boogie)' }, harmony: { program: 16, name: 'Organ (chords on 2 and 4)' },
    progression: {
      eight: ['A7', 'D7', 'A7', 'A7', 'D7', 'D7', 'A7', 'E7'],
      sixteen: ['A7', 'D7', 'A7', 'A7', 'D7', 'D7', 'A7', 'A7', 'D7', 'D7', 'A7', 'F#7', 'Bm7', 'E7', 'A7 D7', 'A7 E7'],
    },
    bassline: [[[0, 1, '1'], [1, 1, '3'], [2, 1, '5'], [3, 1, '6']], [[0, 1, '8'], [1, 1, '6'], [2, 1, '5'], [3, 1, '3']]],
    comping: [[[1, 0.75, 0.6], [3, 0.75, 0.6]]],
    floor: 55, voices: 4,
  },
  reggae: {
    key: { tonic: 'A', mode: 'minor' },
    bass: { program: 33, name: 'Bass (fingered, round and low)' }, harmony: { program: 27, name: 'Guitar (skank on 2 and 4)' },
    progression: {
      eight: ['Am', 'G', 'F', 'G', 'Am', 'Dm', 'F', 'G'],
      sixteen: ['Am', 'G', 'Fmaj7', 'G', 'Am7', 'G', 'Fmaj7', 'G', 'Dm7', 'Am7', 'Dm7', 'Am7', 'Fmaj7', 'G', 'Am7', 'G'],
    },
    bassline: [[[0, 1.5, '1'], [2, 1, '5'], [3, 1, '3']], [[0, 1.5, '1'], [2, 0.5, '8'], [2.5, 0.5, '5'], [3, 1, '1']]],
    comping: [[[1, 0.25, 0.65], [3, 0.25, 0.65]]],
    floor: 60,
  },
  pop: {
    key: { tonic: 'C', mode: 'major' },
    bass: { program: 33, name: 'Bass (fingered)' }, harmony: { program: 4, name: 'Electric piano (chords)' },
    progression: {
      eight: ['C', 'G', 'Am', 'F', 'C', 'G', 'F', 'G'],
      sixteen: ['Cadd9', 'G', 'Am7', 'Fmaj7', 'Cadd9', 'G', 'Fmaj7', 'Gsus4 G', 'Am7', 'Fmaj7', 'C', 'G', 'Am7', 'Fmaj7', 'Dm7', 'Gsus4 G'],
    },
    bassline: [[[0, 0.75, '1'], [0.75, 0.75, '1'], [1.5, 0.5, '5'], [2, 0.75, '1'], [2.75, 0.75, '1'], [3.5, 0.5, '8']]],
    comping: [[[0, 1.5, 0.6], [1.5, 2.5, 0.55]]],
    floor: 55,
  },
  disco: {
    key: { tonic: 'A', mode: 'minor' },
    bass: { program: 33, name: 'Bass (fingered octaves)' }, harmony: { program: 48, name: 'Strings (chords)' },
    progression: {
      eight: ['Am7', 'D7', 'Am7', 'D7', 'Fmaj7', 'Em7', 'Dm7', 'E7'],
      sixteen: ['Am9', 'D7', 'Am7', 'D7', 'Fmaj7', 'Em7', 'Dm7', 'E7', 'Am9', 'D7', 'Fmaj7', 'E7', 'Dm7', 'Em7', 'Fmaj7', 'E7'],
    },
    bassline: [[[0, 0.5, '1'], [0.5, 0.5, '8'], [1, 0.5, '1'], [1.5, 0.5, '8'], [2, 0.5, '1'], [2.5, 0.5, '8'], [3, 0.5, '1'], [3.5, 0.5, '8']]],
    comping: [[[0, 2, 0.5], [2, 2, 0.5]]],
    floor: 57, voices: 4,
  },
  jazz: {
    key: { tonic: 'C', mode: 'major' },
    bass: { program: 32, name: 'Double bass (walking)' }, harmony: { program: 26, name: 'Jazz guitar (four to the bar)' },
    progression: {
      eight: ['Dm7', 'G7', 'Cmaj7', 'Cmaj7', 'Dm7', 'G7', 'Cmaj7', 'A7'],
      sixteen: ['Cmaj9', 'A7', 'Dm9', 'G9', 'Em7', 'A7', 'Dm9', 'G9', 'Fmaj7', 'Fm7', 'Em7', 'A7', 'Dm7', 'G7', 'Cmaj7 A7', 'Dm7 G7'],
    },
    bassline: [[[0, 1, '1'], [1, 1, '3'], [2, 1, '5'], [3, 1, '>']], [[0, 1, '1'], [1, 1, '8'], [2, 1, '5'], [3, 1, '>']]],
    comping: [[[0, 0.5, 0.45], [1, 0.5, 0.6], [2, 0.5, 0.45], [3, 0.5, 0.6]]],
    floor: 52, voices: 4,
  },
  bossa: {
    key: { tonic: 'C', mode: 'major' },
    bass: { program: 32, name: 'Double bass (root and fifth)' }, harmony: { program: 24, name: 'Nylon guitar (chords)' },
    progression: {
      eight: ['Cmaj7', 'Cmaj7', 'Dm7', 'G7', 'Em7', 'A7', 'Dm7', 'G7'],
      sixteen: ['Cmaj9', 'Cmaj9', 'D7', 'D7', 'Dm9', 'G7', 'Em7', 'A7', 'Fmaj7', 'Fmaj7', 'Em7', 'A7', 'Dm9', 'G7', 'Cmaj7 A7', 'Dm7 G7'],
    },
    bassline: [[[0, 1.5, '1'], [1.5, 0.5, '5'], [2, 1.5, '5'], [3.5, 0.5, '1']]],
    // The guitar follows the two-bar figure of the lesson's cross-stick part.
    comping: [[[0, 1, 0.55], [1.5, 1, 0.55], [3, 1, 0.5]], [[1, 1, 0.55], [2.5, 1.5, 0.55]]],
    floor: 52, voices: 4,
  },
  metal: {
    key: { tonic: 'E', mode: 'minor' },
    bass: { program: 34, name: 'Bass (picked eighths)' }, harmony: { program: 30, name: 'Guitar (distorted gallop)' },
    progression: {
      eight: ['E5', 'C5', 'D5', 'E5', 'E5', 'C5', 'A5', 'B5'],
      sixteen: ['Em', 'C', 'D', 'B', 'Em', 'C', 'D', 'Bsus4 B', 'Am', 'C', 'D', 'Em', 'C', 'D', 'Am C', 'B'],
    },
    bassline: [[[0, 0.5, '1'], [0.5, 0.5, '1'], [1, 0.5, '1'], [1.5, 0.5, '1'], [2, 0.5, '1'], [2.5, 0.5, '1'], [3, 0.5, '1'], [3.5, 0.5, '1']]],
    comping: [[0, 1, 2, 3].flatMap((beat) => [[beat, 0.5, 0.7], [beat + 0.5, 0.25, 0.55], [beat + 0.75, 0.25, 0.55]] as Strokes)],
    floor: 40,
  },
  dnb: {
    key: { tonic: 'F', mode: 'minor' },
    bass: { program: 38, name: 'Synth bass (sub)' }, harmony: { program: 89, name: 'Warm pad (chords)' },
    progression: {
      eight: ['Fm7', 'Dbmaj7', 'Bbm7', 'C7', 'Fm7', 'Abmaj7', 'Dbmaj7', 'C7'],
      sixteen: ['Fm9', 'Dbmaj7', 'Bbm9', 'C7', 'Fm9', 'Abmaj7', 'Dbmaj7', 'C7', 'Bbm7', 'C7', 'Fm7', 'Abmaj7', 'Dbmaj7', 'Bbm7', 'Gm7b5', 'C7'],
    },
    bassline: [[[0, 1.75, '1'], [2.5, 1, '1'], [3.5, 0.5, '7']]],
    comping: [[[0, 4, 0.45]]],
    floor: 53, voices: 4,
  },
  soul: {
    key: { tonic: 'Eb', mode: 'major' },
    bass: { program: 33, name: 'Bass (fingered)' }, harmony: { program: 0, name: 'Piano (repeated eighth-note chords)' },
    progression: {
      eight: ['Eb', 'Cm', 'Ab', 'Bb7', 'Eb', 'Cm', 'Fm7', 'Bb7'],
      sixteen: ['Ebmaj7', 'Cm7', 'Abmaj7', 'Bb7', 'Ebmaj7', 'Cm7', 'Fm7', 'Bb7', 'Abmaj7', 'Bb7', 'Gm7', 'Cm7', 'Fm7', 'Bb7', 'Abmaj7 Bb7', 'Eb Bb7'],
    },
    // Six quarter-note beats: four dotted-quarter pulses of three eighths.
    bassline: [[[0, 2.5, '1'], [2.5, 0.5, '5'], [3, 1.5, '8'], [4.5, 1, '5'], [5.5, 0.5, '>']]],
    comping: [Array.from({ length: 12 }, (_, eighth) => [eighth / 2, 0.5, eighth % 3 ? 0.35 : 0.5] as [number, number, number])],
    floor: 55,
  },
  funk: {
    key: { tonic: 'E', mode: 'major' },
    bass: { program: 36, name: 'Slap bass' }, harmony: { program: 7, name: 'Clavinet (sixteenth chops)' },
    progression: {
      eight: ['E9', 'E9', 'A9', 'A9', 'E9', 'E9', 'B9', 'A9'],
      sixteen: ['E9', 'E9', 'A9', 'E9', 'E9', 'A9', 'D9 A9', 'E9', 'C#m7', 'F#m7', 'C#m7', 'F#m7', 'A9', 'B9', 'D9 A9', 'B9'],
    },
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
  add9: [0, 4, 7, 14], sus4: [0, 5, 7], sus2: [0, 2, 7], m9: [0, 3, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m7b5: [0, 3, 6, 10],
  dim: [0, 3, 6],
}

/** Root pitch class and intervals of a chord symbol such as `Dbmaj7`, `F#m` or `E5`. */
export function parseChord(symbol: string): { root: number; intervals: number[] } {
  const match = /^([A-G])(#|b)?(.*)$/.exec(symbol)
  const intervals = match && QUALITY[match[3]]
  if (!match || !intervals) throw new Error(`Unknown chord symbol ${symbol}`)
  return { root: (PITCH[match[1]] + (match[2] === '#' ? 1 : match[2] === 'b' ? 11 : 0)) % 12, intervals }
}

/** The chord's third (the fourth or second of a suspended chord, the fifth of a power chord), fifth and seventh above its root. */
export function chordDegrees(intervals: number[]) {
  const third = [3, 4, 5, 2, 7].find((interval) => intervals.includes(interval))!
  const fifth = intervals.includes(7) ? 7 : intervals.includes(6) ? 6 : 7
  const seventh = intervals.includes(11) ? 11 : 10
  return { third, fifth, seventh }
}

/** Bass register: the root from E1 (MIDI 28) up to D#2, with the degree above it. */
function bassPitch(symbol: string, degree: Degree, next: string): number {
  const { root, intervals } = parseChord(symbol)
  const low = 28 + (root - 4 + 12) % 12
  if (degree === '>') {
    const target = 28 + (parseChord(next).root - 4 + 12) % 12
    return target - 1 < 28 ? target + 11 : target - 1
  }
  const { third, fifth, seventh } = chordDegrees(intervals)
  return low + { '1': 0, '3': third, '5': fifth, '6': 9, '7': seventh, '8': 12 }[degree]
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

/** The chords of one bar: one, or two that split the bar evenly (`Dm7 G7`). */
export const barChords = (bar: string) => bar.split(' ')

/** Each chord of a progression with where it sounds, in quarter-note beats from the start. */
export function chordSpans(chords: string[], beatsPerBar: number) {
  return chords.flatMap((bar, index) => {
    const parts = barChords(bar)
    const length = beatsPerBar / parts.length
    return parts.map((symbol, part) => ({ bar: index, symbol, start: index * beatsPerBar + part * length, end: index * beatsPerBar + (part + 1) * length }))
  })
}
export type ChordSpan = ReturnType<typeof chordSpans>[number]

/**
 * The backing for a genre lesson: the style's eight- or sixteen-bar progression, the bass and chord cells in turn,
 * and both parts stopping at the half bar where a fill section starts so the fill stands alone. The last bass note
 * of every fourth bar leads a half step into the next chord, and in sixteen bars the B section's chords sit higher.
 */
export function genreBacking(style: string, bars: number, beatsPerBar: number, fills: boolean[], chords = progression(style, bars)): Backing {
  const spec = STYLES[style]
  if (!spec) throw new Error(`No backing for the ${style} style`)
  if (chords.length !== bars) throw new Error(`${chords.length} bars of chords for a ${bars}-bar backing`)
  const spans = chordSpans(chords, beatsPerBar)
  const spanAt = (beat: number) => spans.findLast((span) => span.start <= beat + 1e-9)!
  const after = (span: ChordSpan) => spans[(spans.indexOf(span) + 1) % spans.length].symbol
  const bass: MelodyNote[] = []
  const harmony: MelodyNote[] = []
  for (let bar = 0; bar < bars; bar++) {
    const start = bar * beatsPerBar
    const end = fills[bar] ? beatsPerBar / 2 : beatsPerBar
    const cell = clip(spec.bassline[bar % spec.bassline.length], end)
    const turn = bar % 4 === 3 && !fills[bar]
    cell.forEach(([at, beats, degree, velocity = 0.8], index) => {
      const span = spanAt(start + at)
      bass.push({ trackId: 'bass', midi: bassPitch(span.symbol, turn && index === cell.length - 1 ? '>' : degree, after(span)),
        startBeat: start + at, beats: Math.min(beats, span.end - start - at), velocity })
    })
    const floor = spec.floor + (bars === 16 && bar >= 8 ? 5 : 0)
    for (const [at, beats, velocity = 0.6] of clip(spec.comping[bar % spec.comping.length], end)) {
      const span = spanAt(start + at)
      for (const midi of voicing(span.symbol, floor, spec.voices ?? 3))
        harmony.push({ trackId: 'harmony', midi, startBeat: start + at, beats: Math.min(beats, span.end - start - at), velocity })
    }
  }
  const written = chords.join(' – ')
  return {
    style, chords,
    tracks: [
      { id: 'bass', instrument: 'other', gmProgram: spec.bass.program, name: spec.bass.name,
        detail: `Backing bass line over ${written}, original and generated for this lesson (not transcribed)` },
      { id: 'harmony', instrument: 'other', gmProgram: spec.harmony.program, name: spec.harmony.name,
        detail: `Backing chords ${written}, original and generated for this lesson (not transcribed)` },
    ],
    notes: { bass, harmony },
  }
}

export const backingKey = (style: string) => STYLES[style].key

/** The style's chords for an eight- or sixteen-bar lesson, one entry per bar. */
export function progression(style: string, bars: number): string[] {
  // ponytail: interim for drum genre lessons still at two or four bars; removed when they are lengthened to 8/16.
  if (bars === 2 || bars === 4) return STYLES[style].progression.eight.slice(0, bars)
  if (bars !== 8 && bars !== 16) throw new Error(`Genre lessons are eight or sixteen bars, not ${bars}`)
  return [...STYLES[style].progression[bars === 8 ? 'eight' : 'sixteen']]
}
