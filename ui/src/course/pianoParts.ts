import type { BarMeter, ChordLabel, DrumHit, Pedal, PianoNote, Song } from '../workspace/song'
import { backingKey, chordDegrees, chordSpans, genreBacking, parseChord, type ChordSpan } from './accompaniment'
import { lessonById, lessonHits, lessonMeter } from './curriculum'

/**
 * The parts every piano lesson is built from: right-hand voicings that move to the nearest chord tones, left-hand
 * degrees, written fingering that a hand can actually play, and the lesson as a song with its backing.
 */

export type Finger = NonNullable<PianoNote['finger']>
/** Left-hand degrees from the chord root: `8` is the octave, `7` the chord's seventh, `>` a half step above the next chord's root. */
export type Degree = 'R' | '3' | '5' | '6' | '7' | '8' | '>'
/** Left-hand strokes: start and length in quarter-note beats, the degrees played together, and (for chords) their fingers. */
export type LeftCell = [start: number, beats: number, degrees: Degree[], fingers?: Finger[]][]
/** Right-hand chord strokes: start and length in quarter-note beats. */
export type Strokes = [start: number, beats: number][]
/** A broken chord: start, length, and which note of the voicing from the bottom (wrapping round the voicing). */
export type Arp = [start: number, beats: number, index: number][]

export type Mode = 'major' | 'minor' | 'mixolydian' | 'dorian' | 'harmonic'
export const MODES: Record<Mode, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], mixolydian: [0, 2, 4, 5, 7, 9, 10], dorian: [0, 2, 3, 5, 7, 9, 10],
  harmonic: [0, 2, 3, 5, 7, 8, 11],
}

export type PianoKind = 'genre' | 'inspired' | 'progression' | 'scale'

export type PianoLesson = {
  id: string
  instrument: 'piano'
  kind: PianoKind
  /** The genre, the inspired study's style, or the key of a progression or scale. */
  style: string
  feel: string
  /** The step in its list, from 1. */
  level: number
  title: string
  goal: string
  meter: { numerator: number; denominator: number }
  tempo: { start: number; target: number }
  hands: string
  steps: string[]
  bars: number
  sections?: { name: string; bars: number }[]
  /** One entry per bar; a bar written `Dm7 G7` splits evenly between two chords. Empty for scales. */
  chords: string[]
  /** Bars (from 0) whose second half is a right-hand fill over a held left-hand root, with the bass resting. */
  fills?: number[]
  notes: PianoNote[]
  pedals?: Pedal[]
  /** The backing: a bass in a genre style and a drum lesson's groove, looped under the piano. */
  backing?: { style: string; drums: string; bass?: string }
  key?: { tonic: string; mode: 'major' | 'minor' }
  /** Roman numerals for a progression, one per bar. */
  numerals?: string[]
  /** For a scale: which scale (major, dorian, blues, ...). */
  family?: string
  /** For a progression: songs that use it, and how (in a section, or the same chords in another order). */
  examples?: { songs: string[]; scope: string }
  /** For an inspired study: the artist and recording it takes its style from. */
  influence?: string
  artist?: string
  track?: string
  section?: string
  fidelity?: { meter: string; feel: string; tempo: number }
}

export const pc = (midi: number) => ((midi % 12) + 12) % 12
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

/** The chord's notes for the right hand, as pitch classes from the root: ninths leave out the fifth so four fingers hold the colour. */
function rightTones(symbol: string): { root: number; tones: number[]; power: boolean } {
  const { root, intervals } = parseChord(symbol)
  if (intervals.includes(12)) return { root, tones: [0, 7], power: true }
  const tones = intervals.length > 4 ? intervals.filter((interval) => interval !== 7) : intervals
  return { root, tones: [...new Set(tones.map((interval) => interval % 12))], power: false }
}

/** Every close voicing of the chord between middle C and C6: richer voicings double a triad's bottom note an octave up. */
export function voicings(symbol: string, rich: boolean): number[][] {
  const { root, tones, power } = rightTones(symbol)
  const classes = tones.map((tone) => (root + tone) % 12)
  const options: number[][] = []
  for (let bottom = 60; bottom <= 79; bottom++) {
    // A power chord stands on its root, or on its fifth with the root a fourth above (E A E).
    if (power) {
      const shape = pc(bottom) === root % 12 ? [0, 7, 12] : pc(bottom) === (root + 7) % 12 ? [0, 5, 12] : null
      if (shape && bottom + 12 <= 84) options.push(shape.map((step) => bottom + step))
      continue
    }
    if (!classes.includes(pc(bottom))) continue
    const voiced = [bottom]
    for (let pitch = bottom + 1; voiced.length < classes.length; pitch++) if (classes.includes(pc(pitch))) voiced.push(pitch)
    if (rich && voiced.length === 3) voiced.push(bottom + 12)
    if (voiced.at(-1)! <= 84) options.push(voiced)
  }
  return options
}

/** The voicing whose top note is nearest the phrase's target, moving little from the chord before. */
export function chooseVoicing(symbol: string, rich: boolean, previous: number[] | null, target: number, options = voicings(symbol, rich)): number[] {
  const centre = previous ? sum(previous) / previous.length : target - 5
  const cost = (voiced: number[]) => 0.7 * Math.abs(voiced.at(-1)! - target) + 0.3 * Math.abs(sum(voiced) / voiced.length - centre)
  return options.reduce((best, option) => cost(option) < cost(best) ? option : best)
}

/** Written fingering for a right-hand block chord: thumb on the lowest note, fifth finger on the top. */
export function rightFingers(pitches: number[]): Finger[] {
  if (pitches.length === 4) return [1, 2, 3, 5]
  if (pitches.length === 2) return [1, pitches[1] - pitches[0] >= 7 ? 5 : 3]
  // A fourth on top (a first inversion, or a power chord's octave) takes 1-2-5; otherwise 1-3-5.
  return pitches[2] - pitches[1] === 5 ? [1, 2, 5] : [1, 3, 5]
}

/** The left hand's note for a degree of the chord, from its root in the octave C2 to B2. */
export function leftPitch(symbol: string, degree: Exclude<Degree, '>'>): number {
  const { root, intervals } = parseChord(symbol)
  const { third, fifth, seventh } = chordDegrees(intervals)
  // A power chord has no third: its place in a line is taken by the octave.
  return 36 + root % 12 + { R: 0, '3': third === 7 && intervals.includes(12) ? 12 : third, '5': fifth, '6': 9, '7': seventh, '8': 12 }[degree]
}

/** Largest comfortable stretch between two fingers in semitones, by how far apart the fingers are; the thumb reaches further. */
const REACH = { thumb: [0, 5, 7, 9, 12], other: [0, 4, 6, 8, 8] }

/**
 * Whether one finger can follow another in a line: a step in the hand's direction within reach, the thumb passing
 * under (or a finger crossing over the thumb) by up to a fourth, a repeated key, a leap of more than a fifth (the hand moves), or a rest
 * or a held note long enough to move the hand.
 */
export function canFollow(hand: 'right' | 'left', a: { midi: number; finger: Finger; start: number; end: number }, b: { midi: number; finger: Finger; start: number }): boolean {
  const d = b.midi - a.midi
  // A held note of a beat or more leaves time to move the hand before the next one.
  if (d === 0 || Math.abs(d) > 7 || b.start - a.end >= 0.25 - 1e-9 || a.end - a.start >= 1 - 1e-9) return true
  // Towards the little finger: up for the right hand, down for the left.
  const out = hand === 'right' ? d : -d
  const gap = b.finger - a.finger
  // The thumb passes under (or a finger over the thumb) by up to a fourth, as in arpeggios.
  if (out > 0 && b.finger === 1 && [2, 3, 4].includes(a.finger)) return out <= 5
  if (out < 0 && a.finger === 1 && [2, 3, 4].includes(b.finger)) return -out <= 5
  if (gap === 0 || Math.sign(gap) !== Math.sign(out)) return false
  const reach = (a.finger === 1 || b.finger === 1 ? REACH.thumb : REACH.other)[Math.abs(gap)]
  return Math.abs(out) <= reach && Math.abs(out) >= Math.abs(gap) - 1
}

/**
 * Fills in the missing fingers of one hand's single notes so the whole part can be played: chords keep their written
 * fingers, and each free note takes the playable finger nearest its preferred one.
 */
export function fingerLine(hand: 'right' | 'left', notes: (PianoNote & { prefer?: Finger })[], where: string): void {
  const groups: PianoNote[][] = []
  for (const note of [...notes].sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi)) {
    const last = groups.at(-1)
    if (last && Math.abs(last[0].startBeat - note.startBeat) < 1e-9) last.push(note)
    else groups.push([note])
  }
  const singles = groups.map((group) => group.length === 1 ? group[0] as PianoNote & { prefer?: Finger } : null)
  type Cell = { cost: number; from: number }
  const table: Cell[][] = []
  singles.forEach((note, index) => {
    const options: Finger[] = !note ? [1] : note.finger ? [note.finger] : [1, 2, 3, 4, 5]
    const before = index > 0 ? singles[index - 1] : null
    table.push(([1, 2, 3, 4, 5] as Finger[]).map((finger) => {
      if (!options.includes(finger)) return { cost: Infinity, from: -1 }
      const own = note && !note.finger ? Math.abs(finger - (note.prefer ?? finger)) : 0
      if (index === 0) return { cost: own, from: -1 }
      let best: Cell = { cost: Infinity, from: -1 }
      table[index - 1].forEach((cell, previous) => {
        if (cell.cost === Infinity) return
        const playable = !note || !before || canFollow(hand, { midi: before.midi, finger: (previous + 1) as Finger, start: before.startBeat, end: before.startBeat + before.beats },
          { midi: note.midi, finger, start: note.startBeat })
        if (!playable) return
        const total = cell.cost + own
        if (total < best.cost) best = { cost: total, from: previous }
      })
      return { cost: best.cost, from: best.from }
    }))
  })
  let finger = table.at(-1)!.reduce((best, cell, index, all) => cell.cost < all[best].cost ? index : best, 0)
  if (table.at(-1)![finger].cost === Infinity) {
    const stuck = table.findIndex((row) => row.every((cell) => cell.cost === Infinity))
    const around = singles.slice(Math.max(0, stuck - 3), stuck + 1).map((note) => note ? `${note.startBeat}:${note.midi}${note.finger ? `/${note.finger}` : ''}` : 'chord')
      .map((text, offset) => `${text}[${table[Math.max(0, stuck - 3) + offset].flatMap((cell, finger) => cell.cost < Infinity ? [finger + 1] : []).join('')}]`)
    throw new Error(`${where}: no playable ${hand}-hand fingering near ${around.join(' ')}`)
  }
  for (let index = singles.length - 1; index >= 0; index--) {
    const note = singles[index]
    if (note && !note.finger) note.finger = (finger + 1) as Finger
    finger = table[index][finger].from
  }
  for (const note of notes) delete note.prefer
}

/** A fill's rhythm: each note's start and length in quarter-note beats from the middle of the bar; the last note rings to the bar line. */
export type FillRhythm = [start: number, beats: number][]

const ringOut = (rhythm: FillRhythm, half: number): FillRhythm => rhythm.map(([at, beats], index) => [at, index === rhythm.length - 1 ? half - at : beats])

/**
 * Five steps of the scale over the second half of a bar: down from the first scale note at or above A4 (and above the
 * note before) with fingers 5 to 1, or, when `up`, up from near the note before with fingers 1 to 5.
 */
export function scaleRun(tonic: number, mode: Mode, start: number, half: number, above = 0, rhythm?: FillRhythm, up = false): PianoNote[] {
  const scale = MODES[mode].map((step) => (tonic + step) % 12)
  const run: number[] = []
  if (up) {
    let low = Math.max(62, Math.min(76, above - 4))
    while (!scale.includes(pc(low))) low++
    for (let pitch = low; run.length < 5; pitch++) if (scale.includes(pc(pitch))) run.push(pitch)
  } else {
    // It starts above the note before it, so the little finger can reach it from where the hand is.
    let top = Math.max(69, above + 1)
    while (!scale.includes(pc(top))) top++
    for (let pitch = top; run.length < 5; pitch--) if (scale.includes(pc(pitch))) run.push(pitch)
  }
  const timing = ringOut(rhythm ?? (half === 3 ? [[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 1]] : half >= 2
    ? [[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.25], [1.75, 0.25]] : [[0, 0.25], [0.25, 0.25], [0.5, 0.25], [0.75, 0.25], [1, 0.25]]), half)
  return run.map((midi, index) => ({ trackId: 'piano', hand: 'right', midi, startBeat: start + timing[index][0], beats: timing[index][1],
    velocity: index ? 0.6 : 0.7, finger: (up ? index + 1 : 5 - index) as Finger }))
}

/** Chord tones climbing to the octave over the second half of a bar, fingered by the solver from 1-2-3-5 (or 1-3-5) as the shape allows. */
export function chordClimb(symbol: string, previous: number[] | null, start: number, half: number, rhythm?: FillRhythm): (PianoNote & { prefer: Finger })[] {
  const options = voicings(symbol, false).map((voiced) => voiced.filter((midi, index) => voiced.findIndex((other) => pc(other) === pc(midi)) === index))
    .filter((voiced) => voiced[0] + 12 <= 84)
  const voiced = chooseVoicing(symbol, false, previous, 76, options)
  const climb = [...voiced.slice(0, 3), voiced[0] + 12]
  const fingers: Finger[] = climb.length === 4 ? [1, 2, 3, 5] : [1, 3, 5]
  const timing = ringOut((rhythm ?? [[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5]]).slice(0, climb.length), half)
  return climb.map((midi, index) => ({ trackId: 'piano', hand: 'right', midi, startBeat: start + timing[index][0],
    beats: timing[index][1], velocity: 0.62, prefer: fingers[index] }))
}

export const spanAt = (spans: ChordSpan[], beat: number) => spans.findLast((span) => span.start <= beat + 1e-9)!

/** The lesson as a song: the piano part first, then (where it has one) the drum and bass backing on the same bars. */
export function pianoSong(lesson: PianoLesson): Song {
  const { beatsPerBar, pulse } = lessonMeter(lesson)
  const total = lesson.bars * beatsPerBar
  const barMap: BarMeter[] = Array.from({ length: lesson.bars }, (_, index) => ({
    startBeat: index * beatsPerBar, beats: beatsPerBar, numerator: lesson.meter.numerator, denominator: lesson.meter.denominator, status: 'explicit',
  }))
  let startBar = 1
  const sections = (lesson.sections ?? [{ name: 'Exercise', bars: lesson.bars }]).map(({ name, bars }) => {
    const section = { name, startBar, bars }
    startBar += bars
    return section
  })
  const chordLabels: ChordLabel[] = chordSpans(lesson.chords, beatsPerBar).map(({ symbol, start, end }) => ({ startBeat: start, beats: end - start, symbol }))
  const high = Array.from({ length: lesson.bars }, () => 'high' as const)
  const fills = Array.from({ length: lesson.bars }, (_, bar) => !!lesson.fills?.includes(bar))
  const backing = lesson.backing && genreBacking(lesson.backing.style, lesson.bars, beatsPerBar, fills, lesson.chords)
  const drums = lesson.backing ? loopGroove(lesson.backing.drums, total) : []
  return {
    title: lesson.title,
    source: 'course',
    tracks: [
      { id: 'piano', instrument: 'piano', name: 'Piano', detail: 'Lesson part for both hands, with written fingering' },
      ...backing ? [
        { id: 'drums', instrument: 'drums' as const, name: 'Drum kit', detail: 'Backing groove in this style' },
        lesson.backing!.bass ? { ...backing.tracks[0], name: lesson.backing!.bass } : backing.tracks[0],
      ] : [],
    ],
    bpm: lesson.tempo.target * pulse,
    beatsPerBar,
    beatUnit: lesson.meter.denominator,
    barMap,
    bars: lesson.bars,
    key: lesson.key ?? (lesson.backing ? backingKey(lesson.backing.style) : null),
    sections,
    chords: [],
    chordLabels,
    piano: lesson.notes,
    vocals: [],
    drums,
    instrumentNotes: backing ? { bass: backing.notes.bass } : {},
    ...(lesson.pedals ? { pedals: lesson.pedals } : {}),
    confidence: { piano: high, drums: high, chords: high, vocals: high, other: high },
  }
}

/** A drum lesson's whole pattern, repeated to fill the piano lesson. */
function loopGroove(id: string, total: number): DrumHit[] {
  const groove = lessonById(id)
  if (!groove) throw new Error(`No drum lesson ${id} to back the piano`)
  const loop = groove.bars.length * lessonMeter(groove).beatsPerBar
  const hits = lessonHits(groove)
  return Array.from({ length: Math.ceil(total / loop) }, (_, copy) => hits.map((hit) => ({ ...hit, startBeat: hit.startBeat + copy * loop })))
    .flat().filter((hit) => hit.startBeat < total - 1e-9)
}

/** The right hand's cells by letter, each a list of bars taken in turn: `P` cells are broken chords. */
export type RightPalette = Partial<Record<'A' | 'B' | 'C' | 'K' | 'S', Strokes[]>> & { P?: Arp[] }
/** The left hand's cells by letter: `b` the basic pattern, `o` the ostinato, `t` a turnaround into the next chord, `m` a moving line. */
export type LeftPalette = Partial<Record<'b' | 'o' | 't' | 'm', LeftCell>>

export type PhraseSpec = {
  id: string
  beatsPerBar: number
  chords: string[]
  /** One letter per bar for each hand (spaces are ignored), and for fills `1` (chord tones climbing) or `2` (a run down the scale). */
  right: string
  left: string
  fills?: string
  palette: { right: RightPalette; left: LeftPalette }
  rich: boolean
  pedal: boolean
  tonic: number
  mode: Mode
  /** The top note each bar's voicing aims for, so the phrase rises and falls; repeats if shorter than the phrase. */
  contour?: number[]
  /** The style's own fill rhythms, and whether its run climbs instead of falling. */
  fill?: { run?: FillRhythm; climb?: FillRhythm; up?: boolean }
}

// The first half stays low and rises; the answer starts higher and comes home; a sixteen-bar B section climbs again.
const CONTOUR = [72, 74, 77, 71, 79, 81, 76, 72, 76, 79, 82, 77, 74, 77, 79, 72]
const letters = (line: string) => [...line.replace(/ /g, '')]

/** A left-hand finger by how far the note sits above the chord's root: the little finger on the root, the thumb at the octave. */
function leftPrefer(offset: number): Finger {
  return offset <= 0 ? 5 : offset <= 2 ? 4 : offset <= 4 ? 3 : offset <= 7 ? 2 : 1
}

/**
 * A two-hand part from a phrase plan: each bar names its right- and left-hand cells; voicings follow the chords and
 * the contour; every chord of a split bar is played; fills hand the second half of a bar to the right hand over a
 * held root; and the fingering is solved so the part can be played as written.
 */
export function arrange(spec: PhraseSpec): { notes: PianoNote[]; pedals?: Pedal[]; fills: number[] } {
  const { beatsPerBar: bpb, chords, palette } = spec
  const bars = chords.length
  const right = letters(spec.right), left = letters(spec.left), fill = letters(spec.fills ?? '').concat(Array(bars).fill('.')).slice(0, bars)
  if (right.length !== bars || left.length !== bars) throw new Error(`${spec.id}: the plan has ${right.length}/${left.length} bars for ${bars} chords`)
  const spans = chordSpans(chords, bpb)
  const contour = spec.contour ?? CONTOUR
  const notes: (PianoNote & { prefer?: Finger })[] = []
  const turns: Record<string, number> = {}
  let previous: number[] | null = null
  const add = (note: PianoNote & { prefer?: Finger }) => notes.push({ trackId: 'piano', velocity: Math.abs(note.startBeat - Math.round(note.startBeat)) < 1e-9 ? 0.66 : 0.58, ...note })
  for (let bar = 0; bar < bars; bar++) {
    const start = bar * bpb
    const end = fill[bar] === '.' ? bpb : bpb / 2
    const target = contour[bar % contour.length]
    const voiced = new Map<ChordSpan, number[]>()
    const voice = (span: ChordSpan) => {
      if (!voiced.has(span)) voiced.set(span, previous = chooseVoicing(span.symbol, spec.rich, previous, target))
      return voiced.get(span)!
    }
    const ownSpans = spans.filter((span) => span.bar === bar && span.start < start + end - 1e-9)
    const length = (at: number, beats: number, span: ChordSpan) => Math.min(beats, end - at, span.end - start - at)
    const token = right[bar]
    const turn = turns[token] = (turns[token] ?? -1) + 1
    if (token === 'P') {
      const cell = palette.right.P![turn % palette.right.P!.length]
      for (const [at, beats, index] of cell.filter(([at]) => at < end - 1e-9)) {
        const span = spanAt(spans, start + at)
        const chord = voice(span)
        add({ hand: 'right', midi: chord[index % chord.length], startBeat: start + at, beats: length(at, beats, span), prefer: rightFingers(chord)[index % chord.length] })
      }
    } else {
      const cells = palette.right[token as 'A']
      if (!cells) throw new Error(`${spec.id}: no right-hand cell ${token}`)
      for (const [at, beats] of cells[turn % cells.length].filter(([at]) => at < end - 1e-9)) {
        const span = spanAt(spans, start + at)
        const chord = voice(span)
        const fingers = rightFingers(chord)
        chord.forEach((midi, index) => add({ hand: 'right', midi, startBeat: start + at, beats: length(at, beats, span), finger: fingers[index] }))
      }
    }
    const cell = palette.left[left[bar] as 'b']
    if (!cell) throw new Error(`${spec.id}: no left-hand cell ${left[bar]}`)
    for (const [at, beats, degrees, fingers] of cell.filter(([at]) => at < end - 1e-9)) {
      const span = spanAt(spans, start + at)
      const root = leftPitch(span.symbol, 'R')
      degrees.forEach((degree, index) => {
        const midi = degree === '>' ? leftPitch(spans[(spans.indexOf(span) + 1) % spans.length].symbol, 'R') + 1 : leftPitch(span.symbol, degree)
        // A single note's written finger is where the hand would like to be; the solver keeps it unless the line needs another.
        const chord = degrees.length > 1
        add({ hand: 'left', midi, startBeat: start + at, beats: length(at, beats, span), finger: chord ? fingers?.[index] : undefined,
          prefer: (chord ? undefined : fingers?.[index]) ?? leftPrefer(midi - root) })
      })
    }
    // Every chord sounds: a chord change the cells miss gets its chord, and its root, where it starts.
    for (const span of ownSpans) {
      const sounds = (hand: 'right' | 'left') => notes.some((note) => note.hand === hand && note.startBeat >= span.start - 1e-9 && note.startBeat < span.end - 1e-9)
      const beats = Math.min(span.end, start + end) - span.start
      if (!sounds('right')) {
        const chord = voice(span)
        const fingers = rightFingers(chord)
        chord.forEach((midi, index) => add({ hand: 'right', midi, startBeat: span.start, beats, finger: fingers[index] }))
      }
      if (!sounds('left')) add({ hand: 'left', midi: leftPitch(span.symbol, 'R'), startBeat: span.start, beats, prefer: 5 })
    }
    if (fill[bar] !== '.') {
      const half = bpb / 2
      const span = spanAt(spans, start + half)
      notes.push(...(fill[bar] === '1' ? chordClimb(span.symbol, previous, start + half, half, spec.fill?.climb) : scaleRun(spec.tonic, spec.mode, start + half, half,
        notes.filter((note) => note.hand === 'right' && note.startBeat < start + half).sort((a, b) => a.startBeat - b.startBeat).at(-1)?.midi,
        spec.fill?.run, spec.fill?.up)))
      notes.push({ trackId: 'piano', hand: 'left', midi: leftPitch(span.symbol, 'R'), startBeat: start + half, beats: half, prefer: 5, velocity: 0.55 } as PianoNote)
    }
  }
  for (const hand of ['right', 'left'] as const) fingerLine(hand, notes.filter((note) => note.hand === hand), spec.id)
  notes.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi)
  const fills = fill.flatMap((kind, bar) => kind === '.' ? [] : [bar])
  const pedals: Pedal[] | undefined = spec.pedal ? spans.map((span) => {
    const stop = fills.includes(span.bar) ? Math.min(span.end, span.bar * bpb + bpb / 2) : span.end
    return { controller: 64 as const, startBeat: span.start + 0.25, beats: stop - span.start - 0.5 }
  }).filter((pedal) => pedal.beats > 0) : undefined
  return { notes, fills, ...(pedals ? { pedals } : {}) }
}
