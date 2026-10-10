import type { BarMeter, ChordLabel, Pedal, PianoNote, Song } from '../workspace/song'
import { backingKey, GENRE_STYLE, genreBacking, parseChord, progression } from './accompaniment'
import { lessonById, lessonHits, lessonMeter } from './curriculum'

/**
 * Piano lessons by genre: five per style, the same styles and progressions as the drum genres. Each lesson is an
 * original two-hand part with written fingering (and pedalling where it matters), played over an original drum and
 * bass backing. The piano part is the lesson; the backing never doubles it.
 */

type Finger = NonNullable<PianoNote['finger']>
/** Left-hand degrees from the chord root: as for the bass, `8` is the octave and `7` the chord's seventh. */
type Degree = 'R' | '3' | '5' | '6' | '7' | '8'
/** One left-hand stroke: start and length in quarter-note beats, the degrees played together, and the finger for each. */
type LeftCell = [start: number, beats: number, degrees: Degree[], fingers: Finger[]][]
/** Right-hand chord strokes: start and length in quarter-note beats. */
type Strokes = [start: number, beats: number][]

type Mode = 'major' | 'minor' | 'mixolydian' | 'dorian'
const MODES: Record<Mode, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10], dorian: [0, 2, 3, 5, 7, 9, 10],
}

type Genre = {
  /** The drum genre's first lesson: its style, meter, tempo and groove back the piano. */
  drums: string
  /** The scale the fills run down. */
  mode: Mode
  /** Two right-hand rhythms, easier first; each a list of bars taken in turn. */
  right: [Strokes[], Strokes[]]
  left: { basic: LeftCell[]; ostinato: LeftCell[] }
  /** Steps whose chords are held with the sustain pedal, changed each bar. */
  pedal?: number[]
  words: { right: [string, string]; left: [string, string]; feel: string }
}

const each = (beats: number[], length: number): Strokes => beats.map((beat) => [beat, length])
const quarters = (degrees: Degree[], fingers: Finger[], length = 1): LeftCell => [0, 1, 2, 3].map((beat) => [beat, length, degrees, fingers])

const GENRES: Genre[] = [
  {
    drums: 'genre-rock', mode: 'mixolydian',
    right: [[each([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], 0.5)], [[[0, 1.5], [1.5, 1], [2.5, 1.5]]]],
    left: {
      basic: [[[0, 2, ['R', '8'], [5, 1]], [2, 2, ['R', '8'], [5, 1]]]],
      ostinato: [[0, 1, 2, 3].flatMap((beat) => [[beat, 0.5, ['R'], [5]], [beat + 0.5, 0.5, [beat % 2 ? '5' : '8'], [beat % 2 ? 2 : 1]]] as LeftCell)],
    },
    words: { right: ['eighth-note chords', 'pushed chords'], left: ['octaves', 'rolling root, octave and fifth'], feel: 'Straight eighths' },
  },
  {
    drums: 'genre-blues-shuffle', mode: 'mixolydian',
    right: [[each([1, 3], 0.75)], [each([0, 1, 2, 3], 0.75)]],
    left: {
      basic: [[[0, 2, ['R', '5'], [5, 1]], [2, 2, ['R', '5'], [5, 1]]]],
      ostinato: [[0, 1, 2, 3].map((beat) => [beat, 1, ['R', beat % 2 ? '6' : '5'], [5, beat % 2 ? 1 : 2]])],
    },
    words: { right: ['chords on 2 and 4', 'four chords to the bar'], left: ['open fifths', 'shuffle fifth and sixth'], feel: 'Shuffle feel, written in straight quarters' },
  },
  {
    drums: 'genre-reggae', mode: 'minor',
    right: [[each([1, 3], 0.5)], [each([1, 1.25, 3, 3.25], 0.25)]],
    left: {
      basic: [[[0, 1.5, ['R'], [5]], [2, 1, ['5'], [2]]]],
      ostinato: [[[0, 1.5, ['R'], [5]], [2, 1, ['5'], [2]], [3, 1, ['8'], [1]]]],
    },
    words: { right: ['skank on 2 and 4', 'double skank'], left: ['root and fifth', 'root, fifth and octave'], feel: 'One drop: chords on the off-beats 2 and 4' },
  },
  {
    drums: 'genre-pop', mode: 'major', pedal: [0],
    right: [[each([0, 2], 2)], [[[0, 0.75], [0.75, 0.75], [1.5, 0.5], [2, 0.75], [2.75, 0.75], [3.5, 0.5]]]],
    left: {
      basic: [[[0, 4, ['R', '8'], [5, 1]]]],
      ostinato: [[[0, 0.75, ['R'], [5]], [0.75, 0.75, ['5'], [2]], [1.5, 0.5, ['8'], [1]], [2, 0.75, ['R'], [5]], [2.75, 0.75, ['5'], [2]], [3.5, 0.5, ['8'], [1]]]],
    },
    words: { right: ['half-note chords', 'the 3 + 3 + 2 pulse'], left: ['whole-note octaves', '3 + 3 + 2 root, fifth and octave'], feel: 'Straight eighths, 3 + 3 + 2 pulse' },
  },
  {
    drums: 'genre-disco', mode: 'dorian',
    right: [[each([0.5, 1.5, 2.5, 3.5], 0.5)], [[[0, 0.5], [0.75, 0.25], [1.5, 0.5], [2.5, 0.25], [2.75, 0.25], [3.5, 0.5]]]],
    left: {
      basic: [quarters(['R'], [5], 0.75)],
      ostinato: [[0, 1, 2, 3].flatMap((beat) => [[beat, 0.5, ['R'], [5]], [beat + 0.5, 0.5, ['8'], [1]]] as LeftCell)],
    },
    words: { right: ['off-beat chords', 'sixteenth-note stabs'], left: ['four on the floor', 'octave bounce'], feel: 'Four on the floor, chords between the beats' },
  },
  {
    drums: 'genre-jazz-swing', mode: 'major',
    right: [[each([0, 2], 2)], [each([1, 3], 0.75)]],
    left: {
      basic: [[[0, 2, ['R', '7'], [5, 1]], [2, 2, ['R', '7'], [5, 1]]]],
      ostinato: [[[0, 1, ['R'], [5]], [1, 1, ['3'], [3]], [2, 1, ['5'], [2]], [3, 1, ['6'], [1]]]],
    },
    words: { right: ['half-note voicings', 'comping on 2 and 4'], left: ['root and seventh shells', 'walking quarters'], feel: 'Swing, written in straight quarters' },
  },
  {
    drums: 'genre-bossa-nova', mode: 'major', pedal: [0],
    right: [[each([0], 4)], [[[0, 1], [1.5, 1], [3, 1]], [[1, 1], [2.5, 1.5]]]],
    left: {
      basic: [[[0, 2, ['R'], [5]], [2, 2, ['5'], [1]]]],
      ostinato: [[[0, 1.5, ['R'], [5]], [1.5, 0.5, ['5'], [1]], [2, 1.5, ['5'], [1]], [3.5, 0.5, ['R'], [5]]]],
    },
    words: { right: ['held chords', 'the two-bar bossa figure'], left: ['root and fifth', 'bossa bass'], feel: 'Straight eighths, two-bar pattern' },
  },
  {
    drums: 'genre-metal', mode: 'minor',
    right: [[each([0, 1, 2, 3], 1)], [[0, 1, 2, 3].flatMap((beat) => [[beat, 0.5], [beat + 0.5, 0.25], [beat + 0.75, 0.25]] as Strokes)]],
    left: {
      basic: [quarters(['R', '8'], [5, 1])],
      ostinato: [[0, 1, 2, 3].flatMap((beat) => [[beat, 0.5, ['R'], [5]], [beat + 0.5, 0.25, ['R'], [5]], [beat + 0.75, 0.25, ['R'], [5]]] as LeftCell)],
    },
    words: { right: ['quarter-note power chords', 'galloping power chords'], left: ['quarter-note octaves', 'gallop'], feel: 'Sixteenth-note gallop' },
  },
  {
    drums: 'genre-drum-and-bass', mode: 'minor',
    right: [[each([0], 4)], [[[0, 0.5], [1.5, 0.5], [2.5, 1]]]],
    left: {
      basic: [[[0, 2, ['R', '5'], [5, 1]], [2, 2, ['R', '5'], [5, 1]]]],
      ostinato: [[[0, 1.75, ['R'], [5]], [2.5, 1, ['8'], [1]], [3.5, 0.5, ['7'], [2]]]],
    },
    words: { right: ['held pads', 'syncopated stabs'], left: ['open fifths', 'two-step bass'], feel: 'Fast two-step, chords felt in half time' },
  },
  {
    drums: 'genre-soul-ballad', mode: 'major', pedal: [0, 1, 2, 3, 4],
    right: [[each([0, 1.5, 3, 4.5], 1.5)], [Array.from({ length: 12 }, (_, eighth) => [eighth / 2, 0.5] as [number, number])]],
    left: {
      basic: [[[0, 3, ['R', '8'], [5, 1]], [3, 3, ['R', '8'], [5, 1]]]],
      ostinato: [[0, 1.5, 3, 4.5].flatMap((pulse) => [[pulse, 0.5, ['R'], [5]], [pulse + 0.5, 0.5, ['5'], [2]], [pulse + 1, 0.5, ['8'], [1]]] as LeftCell)],
    },
    words: { right: ['chords on the four beats', 'repeated eighth-note chords'], left: ['octaves', 'rolling triplet arpeggios'], feel: '12/8: four beats of three eighths' },
  },
  {
    drums: 'genre-funk', mode: 'mixolydian',
    right: [[each([0, 1.5, 2.5], 0.5)], [each([0.25, 0.75, 1.5, 2.25, 2.75, 3.5], 0.25)]],
    left: {
      basic: [[[0, 1, ['R'], [5]], [2, 1, ['R'], [5]]]],
      ostinato: [[[0, 0.5, ['R'], [5]], [0.75, 0.25, ['8'], [1]], [1.5, 0.25, ['7'], [2]], [1.75, 0.25, ['8'], [1]], [2.5, 0.5, ['5'], [2]], [3.25, 0.25, ['R'], [5]], [3.5, 0.5, ['3'], [3]]]],
    },
    words: { right: ['short chord stabs', 'sixteenth-note chops'], left: ['roots on 1 and 3', 'syncopated bass line'], feel: 'Straight sixteenths, syncopated' },
  },
]

export const PIANO_STAGES = ['Right-hand rhythm', 'Second right-hand rhythm', 'Left-hand pattern', 'Fill', 'Four-bar phrase']

export type PianoLesson = {
  id: string
  instrument: 'piano'
  style: string
  feel: string
  /** The step in its genre, 1 to 5. */
  level: number
  title: string
  goal: string
  meter: { numerator: number; denominator: number }
  tempo: { start: number; target: number }
  hands: string
  steps: string[]
  bars: number
  sections?: { name: string; bars: number }[]
  chords: string[]
  notes: PianoNote[]
  pedals?: Pedal[]
}

const SLUG: Record<string, string> = {
  'genre-rock': 'rock', 'genre-blues-shuffle': 'blues', 'genre-reggae': 'reggae', 'genre-pop': 'pop', 'genre-disco': 'disco',
  'genre-jazz-swing': 'jazz', 'genre-bossa-nova': 'bossa-nova', 'genre-metal': 'metal', 'genre-drum-and-bass': 'drum-and-bass',
  'genre-soul-ballad': 'soul', 'genre-funk': 'funk',
}
const pc = (midi: number) => ((midi % 12) + 12) % 12

/** The right hand's close voicing from middle C up, moved to the inversion nearest the previous chord. */
function rightVoicing(symbol: string, previous: number[] | null): number[] {
  const { root, intervals } = parseChord(symbol)
  // Ninths leave out the fifth so four fingers hold the colour notes; power chords keep root, fifth and octave.
  const tones = intervals.length > 4 ? intervals.filter((interval) => interval !== 7) : intervals
  const classes = [...new Set(tones.map((interval) => (root + interval) % 12))]
  const options: number[][] = []
  for (let bottom = 60; bottom < 72; bottom++) {
    if (!classes.includes(pc(bottom))) continue
    const voiced = [bottom]
    for (let pitch = bottom + 1; voiced.length < classes.length; pitch++) if (classes.includes(pc(pitch))) voiced.push(pitch)
    // A power chord doubles its root an octave up.
    if (intervals.includes(12) && voiced.length < 3) voiced.push(bottom + 12)
    options.push(voiced)
  }
  const centre = previous ? previous.reduce((a, b) => a + b) / previous.length : 66
  return options.reduce((best, option) => {
    const distance = (voiced: number[]) => Math.abs(voiced.reduce((a, b) => a + b) / voiced.length - centre)
    return distance(option) < distance(best) ? option : best
  })
}

/** Written fingering for a right-hand block chord: thumb on the lowest note, fifth finger on the top. */
function rightFingers(pitches: number[]): Finger[] {
  if (pitches.length === 4) return [1, 2, 3, 5]
  if (pitches.length === 2) return [1, pitches[1] - pitches[0] >= 7 ? 5 : 3]
  // A fourth on top (a first inversion, or a power chord's octave) takes 1-2-5; otherwise 1-3-5.
  return pitches[2] - pitches[1] === 5 ? [1, 2, 5] : [1, 3, 5]
}

function leftPitch(symbol: string, degree: Degree): number {
  const { root, intervals } = parseChord(symbol)
  const low = 36 + root % 12
  const third = intervals.includes(3) ? 3 : intervals.includes(4) ? 4 : 7
  const seventh = intervals.includes(11) ? 11 : 10
  return low + { R: 0, '3': third, '5': 7, '6': 9, '7': seventh, '8': 12 }[degree]
}

const clip = <T extends [number, number, ...unknown[]]>(cell: T[], end: number): T[] =>
  cell.filter(([start]) => start < end).map((item) => [item[0], Math.min(item[1], end - item[0]), ...item.slice(2)] as T)

/** Five notes down the scale from the first scale note at or above A4, fingers 5 to 1, over the second half of a bar. */
function fill(tonic: number, mode: Mode, start: number, half: number): PianoNote[] {
  const scale = MODES[mode].map((step) => (tonic + step) % 12)
  let top = 69
  while (!scale.includes(pc(top))) top++
  const run = [top]
  for (let pitch = top - 1; run.length < 5; pitch--) if (scale.includes(pc(pitch))) run.push(pitch)
  const rhythm: [number, number][] = half === 3 ? [[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 1]] : [[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.25], [1.75, 0.25]]
  return run.map((midi, index) => ({ trackId: 'piano', hand: 'right', midi, startBeat: start + rhythm[index][0], beats: rhythm[index][1],
    velocity: index ? 0.6 : 0.7, finger: (5 - index) as Finger }))
}

function build(genre: Genre, stage: number): PianoLesson {
  const drums = lessonById(genre.drums)!
  const style = GENRE_STYLE[drums.style!]
  const { beatsPerBar } = lessonMeter(drums)
  const bars = stage === 4 ? 4 : 2
  const fills = Array.from({ length: bars }, (_, bar) => stage >= 3 && bar === bars - 1)
  const chords = progression(style, bars)
  const right = genre.right[stage === 1 || stage === 4 ? 1 : 0]
  const left = stage >= 2 ? genre.left.ostinato : genre.left.basic
  const key = backingKey(style)
  const tonic = parseChord(key.tonic).root
  const notes: PianoNote[] = []
  let previous: number[] | null = null
  for (let bar = 0; bar < bars; bar++) {
    const start = bar * beatsPerBar
    const end = fills[bar] ? beatsPerBar / 2 : beatsPerBar
    const voiced = rightVoicing(chords[bar], previous)
    previous = voiced
    const fingers = rightFingers(voiced)
    for (const [at, beats] of clip(right[bar % right.length], end))
      voiced.forEach((midi, index) => notes.push({ trackId: 'piano', hand: 'right', midi, startBeat: start + at, beats, finger: fingers[index],
        velocity: Math.abs(at - Math.round(at)) < 1e-9 ? 0.66 : 0.58 }))
    if (fills[bar]) {
      // The left hand holds the root while the right hand plays the fill.
      notes.push({ trackId: 'piano', hand: 'left', midi: leftPitch(chords[bar], 'R'), startBeat: start + end, beats: beatsPerBar - end, finger: 5, velocity: 0.55 })
      notes.push(...fill(tonic, genre.mode, start + end, beatsPerBar - end))
    }
    for (const [at, beats, degrees, fingers] of clip(left[bar % left.length], end))
      degrees.forEach((degree, index) => notes.push({ trackId: 'piano', hand: 'left', midi: leftPitch(chords[bar], degree), startBeat: start + at, beats,
        finger: fingers[index], velocity: 0.55 }))
  }
  notes.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi)
  const pedalled = genre.pedal?.includes(stage)
  const pedals: Pedal[] | undefined = pedalled
    ? Array.from({ length: bars }, (_, bar) => ({ controller: 64 as const, startBeat: bar * beatsPerBar + 0.25, beats: beatsPerBar - 0.5 })) : undefined
  const name = drums.style!
  const { right: rh, left: lh, feel } = genre.words
  const title = `${name} piano: ${[rh[0], rh[1], `${lh[1]} in the left hand`, 'fill', 'four-bar phrase'][stage]}`
  const leftWords = stage >= 2 ? lh[1] : lh[0]
  const rightWords = stage === 1 || stage === 4 ? rh[1] : rh[0]
  const goal = [
    `Hold the ${lh[0]} in the left hand while the right hand plays ${rh[0]} over ${chords.join(' – ')}.`,
    `Keep the ${lh[0]} steady while the right hand changes to ${rh[1]}.`,
    `The left hand takes the ${lh[1]}; the right hand returns to ${rh[0]} on top.`,
    `One bar of groove, then the right hand runs five notes down the scale while the left hand holds the root.`,
    `Put it together: ${rh[1]} over the ${lh[1]} for three bars, then the fill into the top.`,
  ][stage]
  const pedalStep = pedalled ? ['Press the sustain pedal just after each new chord and lift it just before the next bar, so chords join without blurring.'] : []
  return {
    id: `piano-${SLUG[genre.drums]}-${['rhythm', 'second-rhythm', 'left-hand', 'fill', 'phrase'][stage]}`,
    instrument: 'piano', style: name, feel: `${feel}; ${rightWords} over ${leftWords}`, level: stage + 1, title, goal,
    meter: drums.meter, tempo: { start: Math.round(drums.tempo.target * 0.6), target: drums.tempo.target },
    hands: `Right hand: ${rightWords}, written fingers 1–5 · Left hand: ${leftWords}${pedalled ? ' · Right foot: sustain pedal' : ''}`,
    steps: [
      'Play each hand alone first, with the drums and bass, reading the finger numbers over the notes.',
      ...pedalStep,
      stage >= 3 ? 'In the fill the thumb finishes the run; land back on the first chord with the next bar.' : 'Keep the chords short where they are written short: the rests are part of the groove.',
      'Then put the hands together at the starting speed, and raise it as it settles.',
    ],
    bars, chords, notes,
    ...(stage >= 3 ? { sections: [{ name: 'Groove', bars: bars - 1 }, { name: 'Fill', bars: 1 }] } : {}),
    ...(pedals ? { pedals } : {}),
  }
}

export const PIANO_LESSONS: PianoLesson[] = GENRES.flatMap((genre) => [0, 1, 2, 3, 4].map((stage) => build(genre, stage)))
export const pianoLessonById = (id: string) => PIANO_LESSONS.find((lesson) => lesson.id === id)
/** The workspace subtitle for a piano lesson. */
export const pianoLessonNote = (lesson: PianoLesson) =>
  `Piano by genre · ${lesson.style} · ${PIANO_STAGES[lesson.level - 1]}, ${lesson.level} of 5`
/** Each genre with its piano lessons, in order. */
export const pianoGenres = () => [...new Set(PIANO_LESSONS.map((lesson) => lesson.style))]
  .map((style) => ({ style, lessons: PIANO_LESSONS.filter((lesson) => lesson.style === style) }))

/** The lesson as a song: the piano part first, then the drum and bass backing on the same bars. */
export function pianoLessonSong(lesson: PianoLesson): Song {
  const drums = pianoGenreDrums(lesson)
  const { beatsPerBar, pulse } = lessonMeter(lesson)
  const style = GENRE_STYLE[lesson.style]
  const fills = Array.from({ length: lesson.bars }, (_, bar) => !!lesson.sections && bar === lesson.bars - 1)
  const backing = genreBacking(style, lesson.bars, beatsPerBar, fills)
  const barMap: BarMeter[] = Array.from({ length: lesson.bars }, (_, index) => ({
    startBeat: index * beatsPerBar, beats: beatsPerBar, numerator: lesson.meter.numerator, denominator: lesson.meter.denominator, status: 'explicit',
  }))
  let startBar = 1
  const sections = (lesson.sections ?? [{ name: 'Exercise', bars: lesson.bars }]).map(({ name, bars }) => {
    const section = { name, startBar, bars }
    startBar += bars
    return section
  })
  const chordLabels: ChordLabel[] = lesson.chords.map((symbol, bar) => ({ startBeat: bar * beatsPerBar, beats: beatsPerBar, symbol }))
  const high = Array.from({ length: lesson.bars }, () => 'high' as const)
  const bass = backing.tracks[0]
  return {
    title: lesson.title,
    source: 'course',
    tracks: [
      { id: 'piano', instrument: 'piano', name: 'Piano', detail: 'Lesson part for both hands, with written fingering (authored, not transcribed)' },
      { id: 'drums', instrument: 'drums', name: 'Drum kit', detail: 'Backing groove in this style, original (authored, not transcribed)' },
      bass,
    ],
    bpm: lesson.tempo.target * pulse,
    beatsPerBar,
    beatUnit: lesson.meter.denominator,
    barMap,
    bars: lesson.bars,
    key: backingKey(style),
    sections,
    chords: [],
    chordLabels,
    piano: lesson.notes,
    vocals: [],
    drums,
    instrumentNotes: { bass: backing.notes.bass },
    ...(lesson.pedals ? { pedals: lesson.pedals } : {}),
    confidence: { piano: high, drums: high, chords: high, vocals: high, other: high },
  }
}

/** The genre's basic drum groove, repeated to the lesson's length. */
function pianoGenreDrums(lesson: PianoLesson) {
  const groove = lessonById(Object.keys(SLUG).find((id) => lessonById(id)!.style === lesson.style)!)!
  const { beatsPerBar } = lessonMeter(groove)
  const loop = groove.bars.length * beatsPerBar
  const hits = lessonHits(groove)
  return Array.from({ length: Math.ceil(lesson.bars * beatsPerBar / loop) }, (_, copy) => hits.map((hit) => ({ ...hit, startBeat: hit.startBeat + copy * loop })))
    .flat().filter((hit) => hit.startBeat < lesson.bars * beatsPerBar)
}
