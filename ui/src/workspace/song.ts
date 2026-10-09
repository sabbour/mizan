export type Role = 'tonic' | 'predominant' | 'dominant'
export type Confidence = 'high' | 'medium' | 'low'
/** `chords` is the accompaniment played from the chord progression: a track like the others, but generated, not transcribed. */
export type Instrument = 'piano' | 'drums' | 'chords' | 'vocals' | 'other'

export type Chord = {
  startBeat: number
  beats: number
  /** null means the analysis was unsure; "N.C." means no chord is sounding. */
  symbol: string | null
  numeral: string | null
  role: Role | null
  /** MIDI pitches of a close voicing, root first. */
  tones: number[]
  /** Spell accidentals as flats (A♭ in Fm) rather than sharps. */
  flats: boolean
  confidence: number
}

export type Section = { name: string; startBar: number; bars: number }

export type PianoNote = {
  trackId?: string
  /** Equal-tempered MIDI pitch, allowing fractional semitones (60.5 = C4 +50 cents). */
  midi: number
  startBeat: number
  beats: number
  hand: 'right' | 'left'
  velocity?: number
}
export type MelodyNote = Omit<PianoNote, 'hand'>

export type DrumLane = 'crash' | 'ride' | 'hihat' | 'openhat' | 'hightom' | 'snare' | 'floortom' | 'kick'

/**
 * `confidence` is present on automatic transcriptions; imported hits omit it and keep their written rhythm.
 * `sourceMidi` is the GM percussion pitch the transcriber reported (a specific tom, a pedalled hat); generic
 * detectors omit it. `articulation` is only set by explicit source metadata or authored lessons, never guessed.
 */
export type DrumHit = {
  trackId?: string; lane: DrumLane; startBeat: number; velocity: number; confidence?: number
  sourceMidi?: number; articulation?: 'half-open'
  /** The hand that plays the stroke, from the player's point of view. Only authored lessons set it; it is never guessed. */
  hand?: 'left' | 'right'
  /** A written ghost note or accent. Only authored lessons set it; a quiet or loud detected hit is not labelled. */
  dynamic?: 'ghost' | 'accent'
}

/** One transcribed part. A song lists only the parts that were actually transcribed. */
/** `creative` tracks are generated to play along with, listed apart from the transcribed ones. */
export type Track = { id: string; instrument: Instrument; name: string; detail: string; gmProgram?: number; group?: 'creative'; /** Built from chords, so it can be read as a chord chart. Melodic parts keep their instrument's treatment. */ chordal?: boolean }

export type DecodingErrors = {
  count: number
  byInput: Partial<Record<'mix' | 'vocals', number>>
  details: { input: 'mix' | 'vocals'; category: 'eos_token_limit'; chunk: number; seekSeconds: number; tokenLimit: number }[]
  detailsTruncated: boolean
}

export type BarMeter = {
  startBeat: number
  beats: number
  numerator: number
  denominator: number
  status?: 'explicit' | 'supported' | 'unverified'
  partial?: boolean
}

export type Song = {
  title: string
  tracks: Track[]
  source: string
  bpm: number
  /** Quarter-note beats per bar; e.g. 6/8 has 3 quarter-note beats. */
  beatsPerBar: number
  /** Written meter denominator (4 for legacy songs). */
  beatUnit?: number
  /** Authoritative contiguous measure spans in quarter-note beats; absent on legacy fixed-meter songs. */
  barMap?: BarMeter[]
  bars: number
  key: { tonic: string; mode: 'major' | 'minor' } | null
  sections: Section[]
  chords: Chord[]
  piano: PianoNote[]
  vocals: MelodyNote[]
  drums: DrumHit[]
  /** Pitched draft notes keyed by the id of each transcribed `other` track. */
  instrumentNotes?: Record<string, MelodyNote[]>
  confidence: Record<Exclude<Instrument, 'other'>, Confidence[]> & { other?: Confidence[] }
  /** Score beat to recording seconds, present for aligned imports. */
  tempoMap?: { beat: number; time: number }[]
  /** Present when the decoder reported how many capped chunks it continued past. Missing means unknown (legacy result). */
  decodingErrors?: DecodingErrors
}

export function hasPitchedScore(song: Song): boolean {
  return !!song.piano?.length || !!song.vocals?.length ||
    Object.values(song.instrumentNotes ?? {}).some((notes) => notes.length > 0)
}

export const DRUM_LANES: { lane: DrumLane; label: string }[] = [
  { lane: 'crash', label: 'Crash' },
  { lane: 'ride', label: 'Ride' },
  { lane: 'hihat', label: 'Hi-hat' },
  { lane: 'openhat', label: 'Open hat' },
  { lane: 'hightom', label: 'High tom' },
  { lane: 'snare', label: 'Snare' },
  { lane: 'floortom', label: 'Floor tom' },
  { lane: 'kick', label: 'Kick' },
]

const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

const QUALITY: Record<string, number[]> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  '7': [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  sus4: [0, 5, 7],
}

type ChordSpec = [symbol: string, numeral: string, role: Role, confidence?: number]

function parseSymbol(symbol: string): number[] {
  const match = /^([A-G])(#|b)?(.*)$/.exec(symbol)
  if (!match) return []
  const pc = PC[match[1]] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0)
  let root = 60 + pc
  if (root > 66) root -= 12
  return (QUALITY[match[3]] ?? QUALITY['']).map((i) => root + i)
}

const C = (s: string, n: string, r: Role, c = 0.9): ChordSpec => [s, n, r, c]

const PROGRESSION: { section: string; bars: (ChordSpec | 'nc')[] }[] = [
  { section: 'Intro', bars: [C('C', 'I', 'tonic'), C('Am', 'vi', 'tonic'), C('F', 'IV', 'predominant'), C('G', 'V', 'dominant')] },
  {
    section: 'Verse',
    bars: [
      C('C', 'I', 'tonic'), C('E7', 'V7/vi', 'dominant', 0.72), C('Am', 'vi', 'tonic'), C('F', 'IV', 'predominant'),
      C('Dm7', 'ii7', 'predominant'), C('G7', 'V7', 'dominant'), C('C', 'I', 'tonic'), C('C', 'I', 'tonic'),
    ],
  },
  {
    section: 'Chorus',
    bars: [
      C('F', 'IV', 'predominant'), C('G', 'V', 'dominant'), C('Em', 'iii', 'tonic'), C('Am', 'vi', 'tonic'),
      C('F', 'IV', 'predominant'), C('G', 'V', 'dominant'), C('Csus4', 'Isus4', 'dominant', 0.8), C('C', 'I', 'tonic'),
    ],
  },
  { section: 'Break', bars: ['nc', 'nc'] },
  { section: 'Bridge', bars: [C('Am', 'vi', 'tonic'), C('F', 'IV', 'predominant'), C('Dm7', 'ii7', 'predominant'), C('E7', 'V7/vi', 'dominant', 0.64)] },
  {
    section: 'Chorus',
    bars: [
      C('F', 'IV', 'predominant'), C('G', 'V', 'dominant'), C('Em', 'iii', 'tonic'), C('Am', 'vi', 'tonic'),
      C('F', 'IV', 'predominant'), C('G', 'V', 'dominant'), C('Csus4', 'Isus4', 'dominant', 0.3), C('C', 'I', 'tonic'),
    ],
  },
  { section: 'Outro', bars: [C('F', 'IV', 'predominant'), C('Fm', 'iv', 'predominant'), C('C', 'I', 'tonic'), C('C', 'I', 'tonic')] },
]

/** Right-hand rhythm cells: [offset, beats, chord-tone indexes]; index 3 is the seventh or the upper root. */
type Cell = [number, number, number[]][]
const RH: Record<string, Cell> = {
  block: [[0, 2, [0, 1, 2]], [2, 2, [1, 2, 3]]],
  arp: [[0, 0.5, [0]], [0.5, 0.5, [1]], [1, 0.5, [2]], [1.5, 0.5, [3]], [2, 1, [2]], [3, 1, [1]]],
  lift: [[0, 1, [0, 2]], [1, 0.5, [1]], [1.5, 0.5, [2]], [2, 1.5, [3]], [3.5, 0.5, [2]]],
  run: [
    [0, 0.25, [0]], [0.25, 0.25, [1]], [0.5, 0.25, [2]], [0.75, 0.25, [3]],
    [1, 0.25, [2]], [1.25, 0.25, [1]], [1.5, 0.25, [0]], [1.75, 0.25, [1]],
    [2, 2, [0, 1, 2]],
  ],
  hold: [[0, 4, [0, 1, 2]]],
}
const RH_BY_SECTION: Record<string, string> = { Intro: 'block', Verse: 'arp', Chorus: 'lift', Bridge: 'arp', Outro: 'block' }

function upper(tones: number[]): number[] {
  const t = tones.length > 3 ? tones : [...tones, tones[0] + 12]
  return t
}

export function buildSong(): Song {
  const beatsPerBar = 4
  const sections: Section[] = []
  const chords: Chord[] = []
  const piano: PianoNote[] = []
  const drums: DrumHit[] = []
  let bar = 1

  for (const { section, bars } of PROGRESSION) {
    sections.push({ name: section, startBar: bar, bars: bars.length })
    bars.forEach((spec, i) => {
      const startBeat = (bar - 1) * beatsPerBar
      const last = i === bars.length - 1
      if (spec === 'nc') {
        chords.push({ startBeat, beats: 4, symbol: 'N.C.', numeral: null, role: null, tones: [], flats: false, confidence: 0.95 })
      } else {
        const [symbol, numeral, role, confidence = 0.9] = spec
        const tones = parseSymbol(symbol)
        chords.push({ startBeat, beats: 4, symbol: confidence < 0.4 ? null : symbol, numeral: confidence < 0.4 ? null : numeral, role: confidence < 0.4 ? null : role, tones, flats: /^(F|[A-G]b)/.test(symbol), confidence })

        const dense = section === 'Chorus' && i === 3
        const cellName = section === 'Outro' && last ? 'hold' : dense ? 'run' : RH_BY_SECTION[section]
        const voiced = upper(tones)
        for (const [offset, beats, idx] of RH[cellName]) {
          for (const k of idx) piano.push({ midi: voiced[k], startBeat: startBeat + offset, beats, hand: 'right' })
        }
        const root = tones[0] - 24
        const fifth = root + 7
        if (section === 'Intro' || (section === 'Outro' && last)) {
          piano.push({ midi: root, startBeat, beats: 4, hand: 'left' }, { midi: fifth, startBeat, beats: 4, hand: 'left' })
        } else {
          piano.push({ midi: root, startBeat, beats: 2, hand: 'left' }, { midi: fifth, startBeat, beats: 2, hand: 'left' })
          piano.push({ midi: root + 12, startBeat: startBeat + 2, beats: 2, hand: 'left' })
        }
      }

      const hit = (lane: DrumLane, beat: number, velocity = 0.8) => drums.push({ lane, startBeat: startBeat + beat, velocity })
      if (section === 'Break') {
        if (i === 0) hit('kick', 0, 0.9)
        else for (let b = 0; b < 4; b += 0.25) hit(b < 2 ? 'snare' : b < 3 ? 'hightom' : 'floortom', b, 0.5 + b / 8)
      } else {
        if (i === 0 && section !== 'Intro') hit('crash', 0, 0.9)
        const fill = last && section !== 'Outro'
        const ride = section === 'Bridge'
        const hatEnd = fill ? 3 : 4
        for (let b = 0; b < hatEnd; b += section === 'Intro' ? 1 : 0.5) {
          if (i === 0 && b === 0 && section !== 'Intro') continue
          if (section === 'Chorus' && b === 3.5) hit('openhat', b, 0.6)
          else hit(ride ? 'ride' : 'hihat', b, b % 1 === 0 ? 0.7 : 0.45)
        }
        hit('kick', 0, 0.95)
        if (section !== 'Intro') hit('kick', 2.5, 0.7)
        hit('kick', 2, 0.85)
        hit('snare', 1, 0.85)
        if (!fill) hit('snare', 3, 0.85)
        else for (let b = 3; b < 4; b += 0.25) hit(b < 3.5 ? 'hightom' : 'floortom', b, 0.75)
      }
      bar++
    })
  }

  const totalBars = bar - 1
  const merged = mergeChords(chords)
  const confidence = (low: number[], medium: number[]): Confidence[] =>
    Array.from({ length: totalBars }, (_, i) => (low.includes(i + 1) ? 'low' : medium.includes(i + 1) ? 'medium' : 'high'))

  return {
    title: 'Paper Rain',
    tracks: [
      { id: 'piano', instrument: 'piano', name: 'Piano', detail: 'Both hands, two staves' },
      { id: 'drums', instrument: 'drums', name: 'Drum kit', detail: 'Kick, snare, hi-hat, toms, cymbals' },
      { id: 'chords', instrument: 'chords', group: 'creative', chordal: true, name: 'Chords', detail: 'Generated from the full recording, not the selected instrument score' },
    ],
    source: 'Synthetic demo song. Draft transcription generated from fixture data, not from a recording.',
    bpm: 96,
    beatsPerBar,
    bars: totalBars,
    key: { tonic: 'C', mode: 'major' },
    sections,
    chords: merged,
    piano,
    vocals: [],
    drums,
    confidence: {
      vocals: [],
      piano: confidence([16, 34], [6, 26, 27]),
      drums: confidence([21, 22], [12, 20]),
      // A bar is as trustworthy as the least certain chord in it.
      chords: Array.from({ length: totalBars }, (_, i) => {
        const inBar = merged.filter((c) => c.startBeat < (i + 1) * beatsPerBar && c.startBeat + c.beats > i * beatsPerBar)
        const worst = Math.min(1, ...inBar.map((c) => c.confidence))
        return worst < 0.4 ? 'low' : worst < 0.7 ? 'medium' : 'high'
      }),
    },
  }
}

function mergeChords(chords: Chord[]): Chord[] {
  const out: Chord[] = []
  for (const c of chords) {
    const prev = out[out.length - 1]
    if (prev && prev.symbol === c.symbol && prev.symbol !== null && prev.startBeat + prev.beats === c.startBeat) prev.beats += c.beats
    else out.push({ ...c })
  }
  return out
}

export function chordAt(song: Song, beat: number): number {
  let lo = 0
  for (let i = 0; i < song.chords.length; i++) if (song.chords[i].startBeat <= beat) lo = i
  return lo
}

/** Carry the last identified chord through uncertain spans for play-along only.
 * Keep the original unknown events and their confidence untouched for display.
 * An explicit N.C. ends the sustain; an unknown at the beginning invents nothing.
 */
export function sustainedChords(chords: Chord[]): Chord[] {
  return chords.flatMap((chord, i) => {
    if (!chord.symbol || chord.symbol === 'N.C.' || !chord.tones.length) return []
    let end = chord.startBeat + chord.beats
    for (let j = i + 1; j < chords.length && chords[j].symbol === null && chords[j].startBeat <= end + 1e-6; j++) {
      end = Math.max(end, chords[j].startBeat + chords[j].beats)
    }
    return [{ ...chord, beats: end - chord.startBeat }]
  })
}

export function sectionAt(song: Song, bar: number): number {
  return song.sections.findIndex((s) => bar >= s.startBar && bar < s.startBar + s.bars)
}

const NAMES_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const NAMES_FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B']

export function noteName(midi: number, flats = false): string {
  const base = Math.ceil(midi - 0.5)
  const cents = Math.round((midi - base) * 100)
  return `${(flats ? NAMES_FLAT : NAMES_SHARP)[((base % 12) + 12) % 12]}${cents ? ` ${cents > 0 ? '+' : ''}${cents}¢` : ''}`
}

export function displaySymbol(symbol: string): string {
  return symbol.replace(/#/g, '♯').replace(/([A-G])b/g, '$1♭')
}

const QUALITY_NAME: Record<string, string> = {
  '': 'major', m: 'minor', '7': 'seventh', m7: 'minor seventh', maj7: 'major seventh', dim: 'diminished',
  m7b5: 'half-diminished', aug: 'augmented', sus4: 'sus four', sus2: 'sus two', add9: 'add nine', '6': 'six', m6: 'minor six',
}

/** Spoken chord name, e.g. "C major" or "C major over E"; null is an unsure chord. */
export function chordName(symbol: string | null): string {
  if (symbol === 'N.C.') return 'No chord'
  if (symbol === null) return 'Chord unclear'
  const m = /^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/.exec(symbol)
  if (!m) return displaySymbol(symbol)
  return `${displaySymbol(m[1])} ${QUALITY_NAME[m[2]] ?? m[2]}${m[3] ? ` over ${displaySymbol(m[3])}` : ''}`
}

/** Inversion n of a close voicing: the lowest tone moves up an octave n times. The result stays near middle C. */
export function invert(tones: number[], n: number): number[] {
  let t = [...tones].sort((a, b) => a - b)
  for (let i = 0; i < n % Math.max(1, t.length); i++) t = [...t.slice(1), t[0] + 12]
  return t[0] > 66 ? t.map((m) => m - 12) : t
}

/** Slash-chord symbol for an inversion, e.g. C + first inversion → "C/E". */
export function slash(symbol: string, bass: number, flats: boolean): string {
  const root = /^([A-G][#b]?)/.exec(symbol)?.[1]
  const pc = (n: string) => ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 })[n[0] as 'C'] + (n[1] === '#' ? 1 : n[1] === 'b' ? -1 : 0)
  if (!root || symbol.includes('/') || (pc(root) - bass) % 12 === 0) return symbol
  return `${symbol}/${noteName(bass, flats).replace('♯', '#').replace('♭', 'b')}`
}

/** For each chord, the inversion whose tones move least from the previous chord (smooth voice leading). */
export function smoothInversions(chords: { tones: number[] }[]): number[] {
  let prev: number[] | null = null
  return chords.map((c) => {
    if (!c.tones.length) return 0
    let best = 0
    let cost = Infinity
    for (let n = 0; n < c.tones.length; n++) {
      const t = invert(c.tones, n)
      const d = prev ? t.reduce((s, m) => s + Math.min(...prev!.map((p) => Math.abs(p - m))), 0) + Math.abs(t[0] - prev[0]) * 0.5 : n
      if (d < cost) {
        cost = d
        best = n
      }
    }
    prev = invert(c.tones, best)
    return best
  })
}

/** Voicing moved so its root sits in the C4 octave, the register the chord charts are drawn in. */
export function centred(tones: number[]): number[] {
  if (!tones.length) return tones
  const shift = 12 * Math.floor((71 - tones[0]) / 12)
  return tones.map((m) => m + shift)
}

/** Nearest MIDI note to `midi` whose pitch class is in `pcs`; ties go down. */
function nearestTone(midi: number, pcs: number[]): number {
  for (let d = 0; d < 12; d++) {
    if (pcs.includes((((midi - d) % 12) + 12) % 12)) return midi - d
    if (pcs.includes((midi + d) % 12)) return midi + d
  }
  return midi
}

/**
 * The piano part moved onto changed chords. Where a chord differs from the recording, the melody
 * (highest right-hand note at each onset) stays; the left hand's lowest note takes the new bass; every
 * other note moves to the nearest tone of the new chord. Unchanged chords keep the notes as played.
 */
export function reharmonize(song: Song, chords: Chord[]): PianoNote[] {
  const target = { ...song, chords }
  const onsets = new Map<string, PianoNote[]>()
  for (const n of song.piano) {
    const key = `${n.hand}:${n.startBeat}`
    onsets.set(key, [...(onsets.get(key) ?? []), n])
  }
  const out: PianoNote[] = []
  for (const group of onsets.values()) {
    const was = song.chords[chordAt(song, group[0].startBeat)]
    // Chords are found by time, so the new progression may split or add chords.
    const now = chords[chordAt(target, group[0].startBeat)]
    if (!now || !now.tones.length || !was.tones.length || now.tones === was.tones) {
      out.push(...group)
      continue
    }
    const pcs = now.tones.map((m) => m % 12)
    const sorted = [...group].sort((a, b) => a.midi - b.midi)
    const seen = new Set<number>()
    sorted.forEach((n, k) => {
      const melody = n.hand === 'right' && k === sorted.length - 1
      const bass = n.hand === 'left' && k === 0
      const midi = melody ? n.midi : nearestTone(n.midi, bass ? [now.tones[0] % 12] : pcs)
      if (seen.has(midi)) return
      seen.add(midi)
      out.push({ ...n, midi })
    })
  }
  return out.sort((a, b) => a.startBeat - b.startBeat)
}
