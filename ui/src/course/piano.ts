import { backingKey, GENRE_STYLE, parseChord, progression } from './accompaniment'
import { lessonById, lessonMeter } from './curriculum'
import { PIANO_INSPIRED } from './pianoInspired'
import { arrange, pianoSong, type Arp, type FillRhythm, type Finger, type LeftCell, type LeftPalette, type Mode, type PianoLesson, type RightPalette, type Strokes } from './pianoParts'
import { tonalLesson, tonalList } from './pianoTonal'

export type { PianoLesson } from './pianoParts'

/**
 * Piano lessons by genre: ten per style over the same styles, keys and progressions as the drum genres. Steps 1–5 are
 * eight-bar phrases that teach one thing each; steps 6–10 are sixteen-bar pieces with an A and a B section, richer
 * chords, syncopation, broken chords, a moving bass and a full arrangement. Each is an original two-hand part with
 * written fingering (and pedalling where it matters), over an original drum and bass backing that never doubles it.
 */

type Genre = {
  /** The drum genre's first lesson: its style, meter, tempo and groove back the piano. */
  drums: string
  /** The scale the fills run down. */
  mode: Mode
  right: RightPalette
  left: LeftPalette
  /** Steps (from 0) whose chords are held with the sustain pedal, changed with each chord. */
  pedal?: number[]
  /** The style's fills: their rhythms, and whether the run climbs. */
  fill: { run: FillRhythm; climb: FillRhythm; up?: boolean }
  /** Which phrase shape the voicings' top notes follow (see CONTOURS). */
  shape: number
  words: { right: [string, string]; left: [string, string]; feel: string; advanced: [string, string, string, string, string] }
}

const each = (beats: number[], length: number): Strokes => beats.map((beat) => [beat, length])
const quarters = (degrees: LeftCell[number][2], fingers: Finger[], length = 1): LeftCell => [0, 1, 2, 3].map((beat) => [beat, length, degrees, fingers])
/** A broken chord in even notes: the voicing's notes from the bottom in this order, `length` beats each. */
const broken = (order: number[], length = 0.5): Arp => order.map((index, step) => [step * length, length, index])
/** Phrase shapes for the voicings' top notes, one per style family, so styles don't share one melodic arc. */
const CONTOURS = [
  [72, 74, 77, 71, 79, 81, 76, 72, 76, 79, 82, 77, 74, 77, 79, 72],
  [79, 77, 74, 72, 76, 74, 71, 72, 81, 79, 77, 76, 74, 76, 77, 72],
  [72, 76, 79, 76, 74, 77, 81, 72, 74, 77, 79, 82, 79, 76, 74, 72],
  [69, 72, 71, 74, 72, 76, 74, 71, 76, 74, 79, 77, 76, 72, 74, 69],
]
const walk = (degrees: LeftCell[number][2][number][], length = 1): LeftCell => degrees.map((degree, step) => [step * length, length, [degree]])

const GENRES: Genre[] = [
  {
    drums: 'genre-rock', mode: 'mixolydian', shape: 0,
    fill: { run: [[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.25], [1.75, 0.25]], climb: [[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5]] },
    right: {
      A: [each([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], 0.5)], B: [[[0, 1.5], [1.5, 1], [2.5, 1.5]]],
      C: [[[0, 0.5], [0.5, 0.5], [1, 1], [2.5, 0.5], [3, 1]]], K: [[[0, 1.5], [1.5, 2.5]]],
      S: [[[0, 0.75], [0.75, 0.75], [1.5, 0.5], [2.5, 0.75], [3.25, 0.75]]], P: [broken([0, 2, 1, 2, 0, 2, 1, 2])],
    },
    left: {
      b: [[0, 1.5, ['R', '8'], [5, 1]], [1.5, 2.5, ['R', '8'], [5, 1]]],
      o: [0, 1, 2, 3].flatMap((beat) => [[beat, 0.5, ['R'], [5]], [beat + 0.5, 0.5, [beat % 2 ? '5' : '8'], [beat % 2 ? 2 : 1]]] as LeftCell),
      t: walk(['R', '3', '5', '>']), m: walk(['R', '8', 'R', '8', '5', '8', '5', '>'], 0.5),
    },
    words: { right: ['eighth-note chords', 'pushed chords'], left: ['octaves', 'rolling root, octave and fifth'], feel: 'Straight eighths',
      advanced: ['add9 and sus4 voicings', 'pushed off-beat chords', 'broken-chord eighths', 'walking octave bass', 'sixteen-bar arrangement'] },
  },
  {
    drums: 'genre-blues-shuffle', mode: 'mixolydian', shape: 1,
    fill: { run: [[0, 0.75], [0.75, 0.25], [1, 0.5], [1.5, 0.25], [1.75, 0.25]], climb: [[0, 0.75], [0.75, 0.25], [1, 0.75], [1.75, 0.25]] },
    right: {
      A: [each([1, 3], 1)], B: [each([0, 1, 2, 3], 0.75)], C: [[[0, 0.75], [1, 0.75], [2.5, 0.5], [3, 0.75]]], K: [[[0, 0.75], [1, 3]]],
      S: [[[0.5, 0.5], [1.5, 0.25], [2.5, 0.5], [3.75, 0.25]]],
      P: [[[0, 0.75, 0], [0.75, 0.25, 1], [1, 0.75, 2], [1.75, 0.25, 3], [2, 0.75, 2], [2.75, 0.25, 1], [3, 1, 0]]],
    },
    left: {
      b: [[0, 2, ['R', '5'], [5, 1]], [2, 1, ['R', '6'], [5, 1]], [3, 1, ['R', '5'], [5, 1]]],
      o: [0, 1, 2, 3].map((beat) => [beat, 1, ['R', beat % 2 ? '6' : '5'], [5, beat % 2 ? 1 : 2]]),
      t: walk(['R', '3', '5', '>']),
      // Boogie-woogie: the left hand climbs and falls the chord with its sixth in a long-short shuffle pattern.
      m: [[0, 0.75, ['R']], [0.75, 0.25, ['3']], [1, 0.75, ['5']], [1.75, 0.25, ['6']], [2, 0.75, ['8']], [2.75, 0.25, ['6']], [3, 0.75, ['5']], [3.75, 0.25, ['3']]],
    },
    words: { right: ['chords on 2 and 4', 'four chords to the bar'], left: ['open fifths', 'shuffle fifth and sixth'], feel: 'Shuffle feel, written in straight quarters',
      advanced: ['four-note seventh voicings', 'off-beat organ stabs', 'broken seventh chords in shuffle rhythm', 'boogie-woogie eighths', 'sixteen-bar blues arrangement'] },
  },
  {
    drums: 'genre-reggae', mode: 'minor', shape: 3,
    fill: { run: [[0.5, 0.25], [0.75, 0.25], [1, 0.5], [1.5, 0.25], [1.75, 0.25]], climb: [[0.5, 0.5], [1, 0.5], [1.5, 0.25], [1.75, 0.25]] },
    right: {
      A: [each([1, 3], 0.5)], B: [each([1, 1.25, 3, 3.25], 0.25)], C: [[[1, 0.5], [2.5, 0.25], [3, 0.5]]], K: [[[1, 0.5], [3, 1]]],
      S: [[[0.5, 0.25], [1, 0.5], [2.5, 0.25], [3, 0.5]]], P: [[[0.5, 0.25, 0], [1, 0.5, 2], [1.5, 0.25, 1], [2.5, 0.25, 0], [3, 0.5, 2], [3.5, 0.25, 1]]],
    },
    left: {
      b: [[0, 1.5, ['R'], [5]], [2, 1, ['5'], [2]]], o: [[0, 1.5, ['R'], [5]], [2, 1, ['5'], [2]], [3, 1, ['8'], [1]]],
      t: [[0, 1.5, ['R']], [2, 1, ['5']], [3, 1, ['>']]], m: [[0, 1, ['R']], [1, 0.5, ['3']], [1.5, 0.5, ['5']], [2, 1.5, ['8']], [3.5, 0.5, ['5']]],
    },
    words: { right: ['skank on 2 and 4', 'double skank'], left: ['root and fifth', 'root, fifth and octave'], feel: 'One drop: chords on the off-beats 2 and 4',
      advanced: ['seventh-chord skanks', 'pushed skanks', 'organ bubble', 'melodic bass line', 'sixteen-bar arrangement'] },
  },
  {
    drums: 'genre-pop', mode: 'major', pedal: [0, 5, 7], shape: 2,
    fill: { run: [[0, 0.5], [0.5, 0.5], [1, 0.25], [1.25, 0.25], [1.5, 0.5]], climb: [[0, 0.75], [0.75, 0.75], [1.5, 0.25], [1.75, 0.25]], up: true },
    right: {
      A: [[[0, 2], [2, 1.5], [3.5, 0.5]]], B: [[[0, 0.75], [0.75, 0.75], [1.5, 0.5], [2, 0.75], [2.75, 0.75], [3.5, 0.5]]],
      C: [[[0, 1], [1, 1], [2, 1.5], [3.5, 0.5]]], K: [[[0, 2.5], [2.5, 1.5]]], S: [[[0, 0.75], [0.75, 1.25], [2.5, 0.5], [3, 1]]],
      P: [[[0, 0.5, 0], [0.5, 0.5, 2], [1, 0.5, 1], [1.5, 0.5, 3], [2, 1, 2], [3, 0.5, 1], [3.5, 0.5, 3]]],
    },
    left: {
      b: [[0, 4, ['R', '8'], [5, 1]]],
      o: [[0, 0.75, ['R'], [5]], [0.75, 0.75, ['5'], [2]], [1.5, 0.5, ['8'], [1]], [2, 0.75, ['R'], [5]], [2.75, 0.75, ['5'], [2]], [3.5, 0.5, ['8'], [1]]],
      t: [[0, 2, ['R', '8'], [5, 1]], [2, 1, ['5']], [3, 1, ['>']]], m: [[0, 1.5, ['R']], [1.5, 1, ['5']], [2.5, 0.5, ['8']], [3, 1, ['3']]],
    },
    words: { right: ['half-note chords', 'the 3 + 3 + 2 pulse'], left: ['whole-note octaves', '3 + 3 + 2 root, fifth and octave'], feel: 'Straight eighths, 3 + 3 + 2 pulse',
      advanced: ['add9 and seventh voicings', 'syncopated pushes', 'broken-chord eighths', 'moving bass line', 'sixteen-bar arrangement'] },
  },
  {
    drums: 'genre-disco', mode: 'dorian', shape: 1,
    fill: { run: [[0, 0.25], [0.25, 0.25], [0.5, 0.25], [0.75, 0.25], [1, 1]], climb: [[0, 0.25], [0.25, 0.25], [0.5, 0.25], [0.75, 1.25]], up: true },
    right: {
      A: [each([0.5, 1.5, 2.5, 3.5], 0.5)], B: [[[0, 0.5], [0.75, 0.25], [1.5, 0.5], [2.5, 0.25], [2.75, 0.25], [3.5, 0.5]]],
      C: [[[0, 0.25], [0.5, 0.5], [1.5, 0.25], [2, 0.5], [3.5, 0.5]]], K: [[[0.5, 0.5], [1.5, 2.5]]],
      S: [[[0.25, 0.25], [0.75, 0.5], [1.5, 0.25], [2.25, 0.25], [2.75, 0.5], [3.5, 0.5]]], P: [[[0, 0.25, 0], [0.25, 0.25, 3], [0.5, 0.5, 1], [1, 0.25, 0], [1.25, 0.25, 3], [1.5, 0.5, 2], [2, 0.25, 0], [2.25, 0.25, 3], [2.5, 0.5, 1], [3, 1, 2]]],
    },
    left: {
      b: quarters(['R'], [5], 0.75),
      o: [0, 1, 2, 3].flatMap((beat) => [[beat, 0.5, ['R'], [5]], [beat + 0.5, 0.5, ['8'], [1]]] as LeftCell),
      t: [[0, 0.5, ['R']], [0.5, 0.5, ['8']], [1, 0.5, ['R']], [1.5, 0.5, ['8']], [2, 1, ['5']], [3, 1, ['>']]],
      m: walk(['R', '8', '5', '8', 'R', '8', '7', '8'], 0.5),
    },
    words: { right: ['off-beat chords', 'sixteenth-note stabs'], left: ['four on the floor', 'octave bounce'], feel: 'Four on the floor, chords between the beats',
      advanced: ['ninth-chord voicings', 'sixteenth-note pushes', 'broken-chord sixteenths', 'octave-and-seventh bass', 'sixteen-bar arrangement'] },
  },
  {
    drums: 'genre-jazz-swing', mode: 'major', shape: 3,
    fill: { run: [[0, 0.25], [0.25, 0.25], [0.5, 0.5], [1, 0.5], [1.5, 0.5]], climb: [[0, 0.5], [0.5, 0.25], [0.75, 0.75], [1.5, 0.5]] },
    right: {
      A: [each([0, 2], 2)], B: [each([1, 3], 0.75)], C: [[[0, 0.75], [1.5, 1]]], K: [[[0, 0.5], [1.5, 2.5]]], S: [[[0, 0.5], [1.5, 1], [3.5, 0.5]]],
      // Comping broken across the beat: a quarter, two eighths, then quarters, the way a pianist spreads a voicing.
      P: [[[0, 1, 0], [1, 0.5, 2], [1.5, 0.5, 3], [2, 1, 1], [3, 1, 2]]],
    },
    left: {
      b: [[0, 1.5, ['R', '7'], [5, 1]], [2.5, 1.5, ['R', '3'], [5, 2]]],
      o: [[0, 1, ['R'], [5]], [1, 1, ['3'], [3]], [2, 1, ['5'], [2]], [3, 1, ['6'], [1]]],
      t: walk(['R', '3', '5', '>']), m: walk(['R', '5', '3', '>']),
    },
    words: { right: ['half-note voicings', 'comping on 2 and 4'], left: ['root and seventh shells', 'walking quarters'], feel: 'Swing, written in straight quarters',
      advanced: ['ninth-chord voicings', 'anticipated comping', 'spread comping voicings', 'walking bass line', 'sixteen-bar arrangement'] },
  },
  {
    drums: 'genre-bossa-nova', mode: 'major', pedal: [0, 5], shape: 2,
    fill: { run: [[0, 0.75], [0.75, 0.25], [1, 0.25], [1.25, 0.25], [1.5, 0.5]], climb: [[0, 1], [1, 0.5], [1.5, 0.25], [1.75, 0.25]] },
    right: {
      A: [[[0, 3], [3, 1]]], B: [[[0, 1], [1.5, 1], [3, 1]], [[1, 1], [2.5, 1.5]]], C: [[[0.5, 1], [2, 1], [3.5, 0.5]]], K: [[[0, 1], [1.5, 2.5]]],
      S: [[[0, 0.5], [1, 1], [2.5, 1.5]]], P: [[[0, 0.5, 0], [0.5, 0.5, 1], [1, 0.5, 2], [1.5, 0.5, 3], [2, 1, 2], [3, 1, 1]]],
    },
    left: {
      b: [[0, 3, ['R'], [5]], [3, 1, ['5'], [1]]],
      o: [[0, 1.5, ['R'], [5]], [1.5, 0.5, ['5'], [1]], [2, 1.5, ['5'], [1]], [3.5, 0.5, ['R'], [5]]],
      t: [[0, 1.5, ['R']], [1.5, 0.5, ['5']], [2, 1, ['5']], [3, 1, ['>']]], m: [[0, 1.5, ['R']], [1.5, 0.5, ['3']], [2, 1.5, ['5']], [3.5, 0.5, ['>']]],
    },
    words: { right: ['held chords', 'the two-bar bossa figure'], left: ['root and fifth', 'bossa bass'], feel: 'Straight eighths, two-bar pattern',
      advanced: ['ninth-chord voicings', 'anticipated bossa figure', 'broken-chord guitar figure', 'moving bossa bass', 'sixteen-bar arrangement'] },
  },
  {
    drums: 'genre-metal', mode: 'minor', shape: 0,
    fill: { run: [[0, 0.25], [0.25, 0.25], [0.5, 0.5], [1, 0.25], [1.25, 0.75]], climb: [[0, 0.5], [0.5, 0.25], [0.75, 0.25], [1, 1]] },
    right: {
      A: [each([0, 1, 2, 3], 1)], B: [[0, 1, 2, 3].flatMap((beat) => [[beat, 0.5], [beat + 0.5, 0.25], [beat + 0.75, 0.25]] as Strokes)],
      C: [[[0, 0.5], [0.5, 0.5], [1, 1], [2, 0.5], [2.5, 0.5], [3, 1]]], K: [[[0, 1.5], [1.5, 0.5], [2, 2]]],
      S: [[[0, 0.5], [0.75, 0.75], [1.5, 0.25], [2, 0.5], [2.75, 0.75], [3.5, 0.5]]], P: [[[0, 0.25, 0], [0.25, 0.25, 1], [0.5, 0.25, 0], [0.75, 0.25, 1], [1, 0.5, 2], [1.5, 0.5, 1], [2, 0.25, 0], [2.25, 0.25, 1], [2.5, 0.25, 0], [2.75, 0.25, 1], [3, 1, 2]]],
    },
    left: {
      b: quarters(['R', '8'], [5, 1]),
      o: [0, 1, 2, 3].flatMap((beat) => [[beat, 0.5, ['R'], [5]], [beat + 0.5, 0.25, ['R'], [5]], [beat + 0.75, 0.25, ['R'], [5]]] as LeftCell),
      t: [[0, 0.5, ['R']], [0.5, 0.5, ['R']], [1, 0.5, ['R']], [1.5, 0.5, ['R']], [2, 1, ['5']], [3, 1, ['>']]],
      m: [[0, 0.5, ['R']], [0.5, 0.25, ['R']], [0.75, 0.25, ['R']], [1, 0.5, ['8']], [1.5, 0.25, ['R']], [1.75, 0.25, ['R']], [2, 0.5, ['5']], [2.5, 0.25, ['R']], [2.75, 0.25, ['R']], [3, 1, ['8']]],
    },
    words: { right: ['quarter-note power chords', 'galloping power chords'], left: ['quarter-note octaves', 'gallop'], feel: 'Sixteenth-note gallop',
      advanced: ['full triad voicings', 'syncopated gallop', 'tremolo broken chords', 'pedal-point gallop bass', 'sixteen-bar arrangement'] },
  },
  {
    drums: 'genre-drum-and-bass', mode: 'minor', shape: 1,
    fill: { run: [[0, 0.25], [0.75, 0.25], [1, 0.25], [1.5, 0.25], [1.75, 0.25]], climb: [[0, 0.75], [0.75, 0.25], [1.5, 0.25], [1.75, 0.25]] },
    right: {
      A: [each([0], 4)], B: [[[0, 0.5], [1.5, 0.5], [2.5, 1]]], C: [[[0, 1.5], [2, 0.5], [3, 1]]], K: [[[0, 3.5], [3.5, 0.5]]],
      // Broken chords against the break: syncopated sixteenths that skip, never even eighths.
      S: [[[0.75, 0.75], [2.5, 0.5], [3.25, 0.75]]], P: [[[0, 0.5, 0], [0.75, 0.25, 2], [1.5, 0.5, 1], [2.5, 0.5, 3], [3.25, 0.75, 2]]],
    },
    left: {
      b: [[0, 3, ['R', '5'], [5, 1]], [3.5, 0.5, ['8'], [1]]], o: [[0, 1.75, ['R'], [5]], [2.5, 1, ['8'], [1]], [3.5, 0.5, ['7'], [2]]],
      t: [[0, 1.75, ['R']], [2.5, 1, ['5']], [3.5, 0.5, ['>']]], m: [[0, 1.5, ['R']], [1.5, 0.5, ['8']], [2.5, 0.75, ['5']], [3.25, 0.75, ['7']]],
    },
    words: { right: ['held pads', 'syncopated stabs'], left: ['open fifths', 'two-step bass'], feel: 'Fast two-step, chords felt in half time',
      advanced: ['ninth-chord pads', 'syncopated stabs over the break', 'syncopated broken chords', 'moving sub line', 'sixteen-bar arrangement'] },
  },
  {
    drums: 'genre-soul-ballad', mode: 'major', pedal: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], shape: 2,
    fill: { run: [[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 1]], climb: [[0, 1], [1, 0.5], [1.5, 1], [2.5, 0.5]] },
    right: {
      A: [each([0, 1.5, 3, 4.5], 1.5)], B: [Array.from({ length: 12 }, (_, eighth) => [eighth / 2, 0.5] as [number, number])],
      C: [[[0, 1], [1, 0.5], [1.5, 1.5], [3, 1], [4, 0.5], [4.5, 1.5]]], K: [[[0, 3], [3, 3]]],
      S: [[[0, 1], [1, 1.5], [2.5, 0.5], [3, 1], [4, 1], [5, 1]]], P: [broken([0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1])],
    },
    left: {
      b: [[0, 3, ['R', '8'], [5, 1]], [3, 3, ['R', '8'], [5, 1]]],
      o: [0, 1.5, 3, 4.5].flatMap((pulse) => [[pulse, 0.5, ['R'], [5]], [pulse + 0.5, 0.5, ['5'], [2]], [pulse + 1, 0.5, ['8'], [1]]] as LeftCell),
      t: walk(['R', '3', '5', '>'], 1.5), m: [[0, 1.5, ['R']], [1.5, 1, ['3']], [2.5, 0.5, ['5']], [3, 1.5, ['8']], [4.5, 1, ['5']], [5.5, 0.5, ['>']]],
    },
    words: { right: ['chords on the four beats', 'repeated eighth-note chords'], left: ['octaves', 'rolling triplet arpeggios'], feel: '12/8: four beats of three eighths',
      advanced: ['seventh-chord voicings', 'pushed triplet chords', 'triplet arpeggios', 'walking 12/8 bass', 'sixteen-bar arrangement'] },
  },
  {
    drums: 'genre-funk', mode: 'mixolydian', shape: 3,
    fill: { run: [[0, 0.25], [0.25, 0.25], [0.75, 0.25], [1, 0.25], [1.5, 0.5]], climb: [[0, 0.25], [0.5, 0.25], [0.75, 0.25], [1.25, 0.75]], up: true },
    right: {
      A: [each([0, 1.5, 2.5], 0.5)], B: [each([0.25, 0.75, 1.5, 2.25, 2.75, 3.5], 0.25)],
      C: [[[0, 0.25], [0.5, 0.25], [1, 0.5], [2, 0.25], [2.5, 0.25], [3, 0.5]]], K: [[[0, 0.25], [0.75, 0.25], [1.5, 2.5]]],
      S: [each([0.25, 1, 1.75, 2.5, 3.25, 3.75], 0.25)],
      P: [[[0, 0.25, 0], [0.5, 0.25, 2], [0.75, 0.25, 1], [1.25, 0.25, 3], [1.5, 0.5, 2], [2.25, 0.25, 0], [2.75, 0.25, 1], [3, 0.25, 3], [3.5, 0.5, 2]]],
    },
    left: {
      b: [[0, 1, ['R'], [5]], [2, 1, ['R'], [5]]],
      o: [[0, 0.5, ['R'], [5]], [0.75, 0.25, ['8'], [1]], [1.5, 0.25, ['7'], [2]], [1.75, 0.25, ['8'], [1]], [2.5, 0.5, ['5'], [2]], [3.25, 0.25, ['R'], [5]], [3.5, 0.5, ['3'], [3]]],
      t: [[0, 0.5, ['R']], [0.75, 0.25, ['8']], [1.5, 0.5, ['5']], [2.5, 0.5, ['3']], [3, 0.5, ['5']], [3.5, 0.5, ['>']]],
      m: [[0, 0.5, ['R']], [0.75, 0.25, ['R']], [1.5, 0.5, ['8']], [2.25, 0.25, ['7']], [2.5, 0.5, ['5']], [3.5, 0.5, ['3']]],
    },
    words: { right: ['short chord stabs', 'sixteenth-note chops'], left: ['roots on 1 and 3', 'syncopated bass line'], feel: 'Straight sixteenths, syncopated',
      advanced: ['ninth-chord voicings', 'sixteenth-note pushes', 'broken-chord clav line', 'syncopated octave bass', 'sixteen-bar arrangement'] },
  },
]

export const PIANO_STAGES = ['Right-hand rhythm', 'Second right-hand rhythm', 'Left-hand pattern', 'Fill', 'Four-bar phrase',
  'Richer voicings', 'Syncopation', 'Broken chords', 'Moving bass', 'Sixteen-bar arrangement']

/** Each step's plan, one letter per bar: the right-hand cell, the left-hand cell and any fill (`1` chord tones up, `2` a run down). */
const PLANS: { right: string; left: string; fills: string }[] = [
  { right: 'AAAK AACK', left: 'bbbb bbbb', fills: '' },
  { right: 'BBBK BBAK', left: 'bbbb bbbb', fills: '' },
  { right: 'AAAK AACK', left: 'ooot ooot', fills: '' },
  { right: 'AAAA AACA', left: 'bbbb bbbb', fills: '...1 ...2' },
  { right: 'BBCK BBCB', left: 'ooot oooo', fills: '.... ...2' },
  { right: 'AAAK AACK BBBK BBCB', left: 'bbbb bbbb bbbb bbbb', fills: '.... .... .... ...2' },
  { right: 'SSAK SSCK SSAK SSCS', left: 'ooot ooot ooot oooo', fills: '.... .... .... ...2' },
  { right: 'PPPK PPPK BBPP PPBP', left: 'bbbb bbbb bbbb bbbb', fills: '.... .... .... ...2' },
  { right: 'AAAK AAAK BBBK BBBB', left: 'mmmt mmmt mmmt mmmm', fills: '.... .... .... ...2' },
  { right: 'BBCK BBCA SSPP SSCS', left: 'ooot oooo mmmt mmmm', fills: '.... ...1 .... ...2' },
]
const SUFFIX = ['rhythm', 'second-rhythm', 'left-hand', 'fill', 'phrase', 'voicings', 'syncopation', 'broken-chords', 'moving-bass', 'arrangement']

const SLUG: Record<string, string> = {
  'genre-rock': 'rock', 'genre-blues-shuffle': 'blues', 'genre-reggae': 'reggae', 'genre-pop': 'pop', 'genre-disco': 'disco',
  'genre-jazz-swing': 'jazz', 'genre-bossa-nova': 'bossa-nova', 'genre-metal': 'metal', 'genre-drum-and-bass': 'drum-and-bass',
  'genre-soul-ballad': 'soul', 'genre-funk': 'funk',
}

/** Sections of a phrase: two four-bar halves (or an A and a B section), the last bar marked when it ends in a fill. */
export function phraseSections(bars: number, fills: number[]) {
  const halves = bars === 16 ? ['A section', 'B section'] : ['Phrase', 'Answer']
  const last = fills.includes(bars - 1)
  return [{ name: halves[0], bars: bars / 2 }, { name: halves[1], bars: bars / 2 - (last ? 1 : 0) }, ...last ? [{ name: 'Fill', bars: 1 }] : []]
}

function build(genre: Genre, stage: number): PianoLesson {
  const drums = lessonById(genre.drums)!
  const name = drums.style!
  const style = GENRE_STYLE[name]
  const { beatsPerBar } = lessonMeter(drums)
  const bars = stage < 5 ? 8 : 16
  const chords = progression(style, bars)
  const plan = PLANS[stage]
  const pedalled = !!genre.pedal?.includes(stage)
  const id = `piano-${SLUG[genre.drums]}-${SUFFIX[stage]}`
  const { notes, pedals, fills } = arrange({
    id, beatsPerBar, chords, right: plan.right, left: plan.left, fills: plan.fills, palette: { right: genre.right, left: genre.left },
    rich: stage >= 5, pedal: pedalled, tonic: parseChord(backingKey(style).tonic).root, mode: genre.mode, contour: CONTOURS[genre.shape], fill: genre.fill,
  })
  const { right: rh, left: lh, feel, advanced } = genre.words
  const title = `${name} piano: ${[rh[0], rh[1], `${lh[1]} in the left hand`, 'fill', 'four-bar phrase', ...advanced][stage]}`
  const leftWords = [lh[0], lh[0], lh[1], lh[0], lh[1], lh[0], lh[1], lh[0], 'a moving bass line', `${lh[1]} and a moving bass`][stage]
  const rightWords = [rh[0], rh[1], rh[0], rh[0], rh[1], advanced[0], advanced[1], advanced[2], rh[0], `${rh[1]}, ${advanced[1]} and ${advanced[2]}`][stage]
  const goal = [
    `Hold the ${lh[0]} in the left hand while the right hand plays ${rh[0]} through an eight-bar phrase; bars 4 and 8 close each half with a held chord.`,
    `Keep the ${lh[0]} steady while the right hand changes to ${rh[1]}; bar 7 answers with the first rhythm before the closing chord.`,
    `The left hand takes the ${lh[1]}, walking up into the next chord in bars 4 and 8; the right hand returns to ${rh[0]} on top.`,
    'Groove for three bars, then fill: chord tones climb in bar 4, and in bar 8 the right hand runs five notes down the scale while the left hand holds the root.',
    `Put it together as a four-bar phrase and its answer: ${rh[1]} over the ${lh[1]}, a contrasting rhythm in bars 3 and 7, a held chord in bar 4 and the fill into the top.`,
    `Sixteen bars in two sections: ${advanced[0]} that move to the nearest notes of each new chord, a contrasting answer in each half and a run back to the top.`,
    `Push the chords off the beat (${advanced[1]}) over the ${lh[1]}, with plainer answer bars, held chords every four bars and a run back to the top.`,
    `Break each chord into ${advanced[2]}, the hand staying in one position per chord; held chords mark the A section and block chords break up the B section.`,
    `The left hand plays ${advanced[3]}, leading into each chord change from a half step above, under a steady right hand that moves to the second rhythm in the B section.`,
    `The whole piece: an A section of ${rh[1]} and its answer ending with climbing chord tones in bar 8, then a B section of ${advanced[1]} and ${advanced[2]} over the moving bass, and the run back to the top.`,
  ][stage]
  const pedalStep = pedalled ? ['Press the sustain pedal just after each new chord and lift it just before the next, so chords join without blurring.'] : []
  return {
    id, instrument: 'piano', kind: 'genre', style: name, feel: `${feel}; ${rightWords} over ${leftWords}`, level: stage + 1, title, goal,
    meter: drums.meter, tempo: { start: Math.round(drums.tempo.target * (stage < 5 ? 0.6 : 0.55)), target: drums.tempo.target },
    hands: `Right hand: ${rightWords}, written fingers 1–5 · Left hand: ${leftWords}${pedalled ? ' · Right foot: sustain pedal' : ''}`,
    steps: [
      'Play each hand alone first, with the drums and bass, reading the finger numbers over the notes.',
      ...pedalStep,
      fills.length ? 'In a fill the right hand plays alone over the held root; land back on the next chord with the next bar.'
        : 'Keep the chords short where they are written short: the rests are part of the groove.',
      bars === 16 ? 'Learn the A and B sections apart, then join them; the last bar leads back to the top.' : 'Learn the first four bars, then the answer; the last bar leads back to the top.',
      'Then put the hands together at the starting speed, and raise it as it settles.',
    ],
    bars, chords, notes, fills, sections: phraseSections(bars, fills),
    backing: { style, drums: genre.drums },
    ...(pedals ? { pedals } : {}),
  }
}

/** The 110 genre lessons, ten per style, style by style. */
export const PIANO_LESSONS: PianoLesson[] = GENRES.flatMap((genre) => PIANO_STAGES.map((_, stage) => build(genre, stage)))

/** Any piano lesson: a genre lesson, an inspired study, or a progression or scale in a key. */
export const pianoLessonById = (id: string): PianoLesson | undefined =>
  PIANO_LESSONS.find((lesson) => lesson.id === id) ?? PIANO_INSPIRED.find((lesson) => lesson.id === id) ?? tonalLesson(id)

/** The lessons in the same list as this one, for Previous and Next. */
export function pianoLessonList(lesson: PianoLesson): PianoLesson[] {
  if (lesson.kind === 'genre') return PIANO_LESSONS
  if (lesson.kind === 'inspired') return PIANO_INSPIRED
  return tonalList(lesson)
}

/** What the step teaches and where it sits, e.g. "Fill, 4 of 10". */
export function pianoStep(lesson: PianoLesson): string {
  const list = pianoLessonList(lesson)
  if (lesson.kind === 'genre') return `${PIANO_STAGES[lesson.level - 1]}, ${lesson.level} of ${PIANO_STAGES.length}`
  return `${lesson.kind === 'inspired' ? lesson.influence : lesson.title}, ${list.indexOf(lesson) + 1} of ${list.length}`
}

const SHELF = { genre: 'Piano by genre', inspired: 'Inspired piano', progression: 'Chord progressions', scale: 'Scales' }

/** The workspace subtitle for a piano lesson. */
export const pianoLessonNote = (lesson: PianoLesson) => `${SHELF[lesson.kind]} · ${lesson.style} · ${pianoStep(lesson)}`

/** Each genre with its piano lessons, in order. */
export const pianoGenres = () => [...new Set(PIANO_LESSONS.map((lesson) => lesson.style))]
  .map((style) => ({ style, lessons: PIANO_LESSONS.filter((lesson) => lesson.style === style) }))

/** The lesson as a song: the piano part first, then the drum and bass backing on the same bars. */
export const pianoLessonSong = pianoSong
