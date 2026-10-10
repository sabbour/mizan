import type { PianoNote } from '../workspace/song'
import { arrange, MODES, pc, type Finger, type PianoLesson } from './pianoParts'

/**
 * Chord progressions and scales in any of the twenty-four keys, built from the key's scale degrees rather than
 * transposed from C: each note is spelled from its degree, chords are stacked in thirds from the scale, and scales
 * use the standard fingering for that key.
 */

export type KeyMode = 'major' | 'minor'
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
const NATURAL = [0, 2, 4, 5, 7, 9, 11]
/** Key names by pitch class, spelled as they are usually written. */
export const KEY_NAMES: Record<KeyMode, string[]> = {
  major: ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'],
  minor: ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'],
}
const PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const pitchOf = (name: string) => (PITCH[name[0]] + [...name.slice(1)].reduce((sum, mark) => sum + (mark === '#' ? 1 : -1), 0) + 12) % 12

/** The name of a scale degree (0 to 6) whose pitch class is `pitch`, lettered from the tonic: E# in F# major, Cb in Eb minor. */
export function spell(tonic: string, degree: number, pitch: number): string {
  const letter = LETTERS[(LETTERS.indexOf(tonic[0]) + degree) % 7]
  const diff = ((pitch - NATURAL[LETTERS.indexOf(letter)]) % 12 + 18) % 12 - 6
  return letter + (diff > 0 ? '#'.repeat(diff) : 'b'.repeat(-diff))
}

const slug = (name: string) => name[0].toLowerCase() + (name[1] === '#' ? '-sharp' : name[1] === 'b' ? '-flat' : '')
const keyLabel = (tonic: string, mode: KeyMode) => `${tonic} ${mode}`

type Pattern = { slug: string; numerals: string[]; about: string; harmonic?: boolean }
const PATTERNS: Record<KeyMode, Pattern[]> = {
  major: [
    { slug: 'I-IV-V-I', numerals: ['I', 'IV', 'V', 'I'], about: 'home, the subdominant, the dominant and home: the plainest cadence' },
    { slug: 'I-vi-IV-V', numerals: ['I', 'vi', 'IV', 'V'], about: 'the relative minor softens the move away before the dominant pulls home' },
    { slug: 'ii-V-I', numerals: ['ii7', 'V7', 'Imaj7', 'Imaj7'], about: 'seventh chords a fifth apart, the cadence of jazz standards' },
    { slug: 'I-V-vi-IV', numerals: ['I', 'V', 'vi', 'IV'], about: 'the loop under many pop songs, falling to the relative minor' },
  ],
  minor: [
    { slug: 'i-iv-v-i', numerals: ['i', 'iv', 'v', 'i'], about: 'the natural minor cadence: every chord minor, the dominant without a leading tone' },
    { slug: 'i-VI-III-VII', numerals: ['i', 'VI', 'III', 'VII'], about: 'down to the sixth, up to the relative major and its dominant' },
    { slug: 'i-iv-VII-III', numerals: ['i', 'iv', 'VII', 'III'], about: 'through the subtonic to the relative major' },
    { slug: 'i-iv-V-i-harmonic', numerals: ['i', 'iv', 'V', 'i'], harmonic: true,
      about: 'harmonic minor: the seventh is raised in the V chord only, so the dominant is major and leads home' },
  ],
}
const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii']
const QUALITY: Record<string, string> = { '4,7': '', '3,7': 'm', '3,6': 'dim', '4,7,11': 'maj7', '4,7,10': '7', '3,7,10': 'm7', '3,6,10': 'm7b5' }

/** The scale of a key, as pitch classes from the tonic; harmonic minor raises the seventh. */
const scaleOf = (tonic: number, mode: KeyMode | 'harmonic') => MODES[mode].map((step) => (tonic + step) % 12)

/** A roman numeral as a chord symbol in the key, checked against the chord its scale degrees make. */
export function numeralChord(tonic: string, mode: KeyMode, numeral: string, harmonic = false): string {
  const match = /^(i{1,3}|iv|vi{0,2}|v)(maj7|7)?$/i.exec(numeral)
  if (!match) throw new Error(`Unknown numeral ${numeral}`)
  const degree = ROMAN.indexOf(match[1].toLowerCase())
  const scale = scaleOf(pitchOf(tonic), mode === 'minor' && harmonic && degree === 4 ? 'harmonic' : mode)
  const tones = [0, 2, 4, ...(match[2] ? [6] : [])].map((step) => scale[(degree + step) % 7])
  const quality = QUALITY[tones.slice(1).map((tone) => (tone - tones[0] + 12) % 12).join()]
  const upper = match[1] === match[1].toUpperCase()
  if (quality === undefined || upper !== ['', 'maj7', '7'].includes(quality) || (match[2] === 'maj7') !== (quality === 'maj7'))
    throw new Error(`${numeral} is not ${quality ?? 'a chord'} in ${tonic} ${mode}`)
  return spell(tonic, degree, tones[0]) + quality
}

/** Pitch-class names for a key, so every note in a lesson is spelled from its degree (and the raised seventh where written). */
function names(tonic: string, mode: KeyMode, harmonic: boolean): Map<number, string> {
  const scale = scaleOf(pitchOf(tonic), mode)
  const spelled = new Map(scale.map((pitch, degree) => [pitch, spell(tonic, degree, pitch)]))
  if (harmonic) spelled.set((scale[6] + 1) % 12, spell(tonic, 6, (scale[6] + 1) % 12))
  return spelled
}

const progressionId = (pattern: Pattern, tonic: string, mode: KeyMode) => `piano-progression-${pattern.slug.toLowerCase()}-${slug(tonic)}-${mode}`

function progressionLesson(pattern: Pattern, tonic: string, mode: KeyMode, index: number): PianoLesson {
  const id = progressionId(pattern, tonic, mode)
  const once = pattern.numerals.map((numeral) => numeralChord(tonic, mode, numeral, pattern.harmonic))
  const chords = [...once, ...once]
  const { notes, pedals } = arrange({
    id, beatsPerBar: 4, chords, right: 'KKKK AAAA', left: 'bbbb oooo', rich: false, pedal: true, tonic: pitchOf(tonic), mode, contour: [72],
    palette: {
      right: { K: [[[0, 4]]], A: [[[0, 1], [1, 1], [2, 1], [3, 1]]] },
      left: { b: [[0, 4, ['R', '5'], [5, 1]]], o: [[0, 2, ['R'], [5]], [2, 2, ['5'], [1]]] },
    },
  })
  const spelled = names(tonic, mode, !!pattern.harmonic)
  for (const note of notes) note.spell = spelled.get(pc(note.midi))
  const written = pattern.numerals.join(' – ')
  return {
    id, instrument: 'piano', kind: 'progression', style: keyLabel(tonic, mode), level: index + 1,
    title: `${keyLabel(tonic, mode)}: ${written}${pattern.harmonic ? ' (harmonic minor)' : ''}`,
    feel: `${once.join(' – ')}: held chords, then four to the bar`,
    goal: `Play ${written} in ${keyLabel(tonic, mode)} (${once.join(' – ')}): ${pattern.about}. Bars 1–4 hold each chord; bars 5–8 play it four times.`,
    meter: { numerator: 4, denominator: 4 }, tempo: { start: 60, target: 90 },
    hands: 'Right hand: three-note chords, each moving to the nearest notes of the next, fingers 1–5 written · Left hand: root and fifth · Right foot: sustain pedal, changed with each chord',
    steps: [
      'Say the numeral and the chord name as you play each bar: the numeral is the chord\'s place in the key.',
      'Keep the notes the chords share under the same fingers and move the others by the smallest step.',
      'Press the sustain pedal just after each new chord and lift it just before the next.',
      'Then try the same progression in another key with the key picker: the numerals stay the same.',
    ],
    bars: 8, chords, notes, pedals,
    sections: chords.map((_, bar) => ({ name: pattern.numerals[bar % 4], bars: 1 })),
    numerals: [...pattern.numerals, ...pattern.numerals],
    key: { tonic, mode },
    backing: { style: 'pop', drums: 'genre-pop' },
  }
}

/** Standard two-octave fingering per key: each hand's finger for scale degrees 1–7, the outer notes' fingers, and (where it differs) the right hand's first finger. */
type Fingering = { right: number[]; top: number; left: number[]; bottom: number; start?: number }
const C_SHAPE: Fingering = { right: [1, 2, 3, 1, 2, 3, 4], top: 5, left: [1, 4, 3, 2, 1, 3, 2], bottom: 5 }
const B_SHAPE: Fingering = { ...C_SHAPE, left: [1, 3, 2, 1, 4, 3, 2], bottom: 4 }
const F_SHAPE: Fingering = { ...C_SHAPE, right: [1, 2, 3, 4, 1, 2, 3], top: 4 }
const FLAT_LEFT = { left: [3, 2, 1, 4, 3, 2, 1], bottom: 3 }
const FINGERING: Record<KeyMode, Record<number, Fingering>> = {
  major: {
    0: C_SHAPE, 2: C_SHAPE, 4: C_SHAPE, 7: C_SHAPE, 9: C_SHAPE, 11: B_SHAPE, 5: F_SHAPE,
    10: { right: [4, 1, 2, 3, 1, 2, 3], top: 4, ...FLAT_LEFT },
    3: { right: [3, 1, 2, 3, 4, 1, 2], top: 3, ...FLAT_LEFT },
    8: { right: [3, 4, 1, 2, 3, 1, 2], top: 3, ...FLAT_LEFT },
    1: { right: [2, 3, 1, 2, 3, 4, 1], top: 2, ...FLAT_LEFT },
    6: { right: [2, 3, 4, 1, 2, 3, 1], top: 2, left: [4, 3, 2, 1, 3, 2, 1], bottom: 4 },
  },
  minor: {
    0: C_SHAPE, 2: C_SHAPE, 4: C_SHAPE, 7: C_SHAPE, 9: C_SHAPE, 11: B_SHAPE, 5: F_SHAPE,
    6: { right: [3, 4, 1, 2, 3, 1, 2], top: 3, left: [4, 3, 2, 1, 3, 2, 1], bottom: 4 },
    1: { right: [3, 4, 1, 2, 3, 1, 2], top: 3, ...FLAT_LEFT },
    8: { right: [3, 4, 1, 2, 3, 1, 2], top: 3, left: [3, 2, 1, 3, 2, 1, 4], bottom: 3 },
    3: { right: [3, 1, 2, 3, 4, 1, 2], top: 3, left: [2, 1, 4, 3, 2, 1, 3], bottom: 2 },
    10: { right: [4, 1, 2, 3, 1, 2, 3], start: 2, top: 4, left: [2, 1, 3, 2, 1, 4, 3], bottom: 2 },
  },
}
export const scaleFingering = (tonic: number, mode: KeyMode) => FINGERING[mode][tonic]

type Variant = { slug: string; name: string; hands: ('right' | 'left')[] }
const VARIANTS: Variant[] = [
  { slug: 'right-hand', name: 'right hand', hands: ['right'] },
  { slug: 'left-hand', name: 'left hand', hands: ['left'] },
  { slug: 'hands-together', name: 'hands together', hands: ['right', 'left'] },
]
const scaleId = (variant: Variant, tonic: string, mode: KeyMode) => `piano-scale-${variant.slug}-${slug(tonic)}-${mode}`

function scaleLesson(variant: Variant, tonic: string, mode: KeyMode, index: number): PianoLesson {
  const root = pitchOf(tonic)
  const steps = MODES[mode]
  const fingering = scaleFingering(root, mode)
  const notes: PianoNote[] = []
  for (const hand of variant.hands) {
    const start = (hand === 'right' ? 60 : 48) + root
    for (let index = 0; index <= 28; index++) {
      const degree = index <= 14 ? index : 28 - index
      const finger = (hand === 'right' ? degree === 14 ? fingering.top : degree === 0 ? fingering.start ?? fingering.right[0] : fingering.right[degree % 7]
        : degree === 0 ? fingering.bottom : fingering.left[degree % 7]) as Finger
      notes.push({ trackId: 'piano', hand, midi: start + 12 * Math.floor(degree / 7) + steps[degree % 7], startBeat: index / 2, beats: index === 28 ? 2 : 0.5,
        finger, velocity: index % 4 ? 0.58 : 0.66, spell: spell(tonic, degree % 7, (root + steps[degree % 7]) % 12) })
    }
  }
  notes.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi)
  const thumbs = (hand: 'right' | 'left') => [...new Set(notes.filter((note) => note.hand === hand && note.finger === 1).map((note) => note.spell!))].join(' and ')
  const label = `${keyLabel(tonic, mode)}${mode === 'minor' ? ' (natural)' : ''}`
  return {
    id: scaleId(variant, tonic, mode), instrument: 'piano', kind: 'scale', style: keyLabel(tonic, mode), level: index + 1,
    title: `${label} scale: ${variant.name}`,
    feel: 'Two octaves up and down in eighth notes',
    goal: `Play the ${label} scale two octaves up and back down, ${variant.name}, with the fingering written for this key.`,
    meter: { numerator: 4, denominator: 4 }, tempo: { start: 60, target: 100 },
    hands: variant.hands.map((hand) => `${hand === 'right' ? 'Right' : 'Left'} hand: fingers written for ${tonic} ${mode}, thumb on ${thumbs(hand)}`).join(' · '),
    steps: [
      'Play slowly and even: every eighth note the same length and weight.',
      'Pass the thumb under (or the finger over the thumb) without a bump; the hand moves along with it.',
      variant.hands.length === 2 ? 'The hands change position at different notes: practise each hand alone first.' : 'Watch the written finger at each change of position.',
      'Raise the speed only when the turn at the top is as smooth as the rest.',
    ],
    bars: 4, chords: [], notes,
    sections: [{ name: 'Up', bars: 2 }, { name: 'Down', bars: 2 }],
    key: { tonic, mode },
  }
}

/** Every key, in the order the picker lists them. */
export const KEYS = (['major', 'minor'] as KeyMode[]).flatMap((mode) => KEY_NAMES[mode].map((tonic, pitch) => ({ tonic, pitch, mode })))
export const PROGRESSION_COUNT = PATTERNS.major.length
export const SCALE_COUNT = VARIANTS.length

const made = new Map<string, PianoLesson>()
/** The progressions or scales in one key, made when first asked for. */
export function tonalLessons(kind: 'progression' | 'scale', pitch: number, mode: KeyMode): PianoLesson[] {
  const tonic = KEY_NAMES[mode][pitch]
  const ids = kind === 'progression' ? PATTERNS[mode].map((pattern) => progressionId(pattern, tonic, mode)) : VARIANTS.map((variant) => scaleId(variant, tonic, mode))
  return ids.map((id, index) => {
    if (!made.has(id)) made.set(id, kind === 'progression' ? progressionLesson(PATTERNS[mode][index], tonic, mode, index) : scaleLesson(VARIANTS[index], tonic, mode, index))
    return made.get(id)!
  })
}

/** A progression or scale lesson by id, e.g. `piano-progression-ii-v-i-e-flat-major` or `piano-scale-left-hand-f-sharp-minor`. */
export function tonalLesson(id: string): PianoLesson | undefined {
  const kind = id.startsWith('piano-progression-') ? 'progression' : id.startsWith('piano-scale-') ? 'scale' : null
  if (!kind) return undefined
  const key = KEYS.find(({ tonic, mode }) => id.endsWith(`-${slug(tonic)}-${mode}`))
  return key && tonalLessons(kind, key.pitch, key.mode).find((lesson) => lesson.id === id)
}

/** The other lessons of the same kind in the same key. */
export function tonalList(lesson: PianoLesson): PianoLesson[] {
  const key = KEYS.find(({ tonic, mode }) => tonic === lesson.key!.tonic && mode === lesson.key!.mode)!
  return tonalLessons(lesson.kind as 'progression' | 'scale', key.pitch, key.mode)
}

/** The key of a progression or scale lesson, as the picker shows it. */
export const lessonKey = (lesson: PianoLesson) => KEYS.find(({ tonic, mode }) => tonic === lesson.key?.tonic && mode === lesson.key?.mode)
