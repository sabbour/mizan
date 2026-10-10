import type { PianoNote } from '../workspace/song'
import { arrange, canFollow, MODES, pc, type Finger, type LeftPalette, type PianoLesson, type RightPalette } from './pianoParts'

/**
 * Chord progressions and scales in every key, built from scale degrees rather than transposed from C: each note is
 * spelled from its degree, chords are stacked in thirds from the scale, and scales carry fingering for that key and
 * scale. Lessons are made when a key is chosen, never all at start-up.
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

/** A pitch class named on a given letter (an index into C D E F G A B, wrapping): Cb on B's letter is B, on C's is Cb. */
function onLetter(letter: number, pitch: number): string {
  const name = LETTERS[((letter % 7) + 7) % 7]
  const diff = ((pitch - NATURAL[LETTERS.indexOf(name)]) % 12 + 18) % 12 - 6
  return name + (diff > 0 ? '#'.repeat(diff) : 'b'.repeat(-diff))
}
/** The name of a scale degree (0 to 6) whose pitch class is `pitch`, lettered from the tonic: E# in F# major, Cb in Eb minor. */
export const spell = (tonic: string, degree: number, pitch: number) => onLetter(LETTERS.indexOf(tonic[0]) + degree, pitch)

const slug = (name: string) => name[0].toLowerCase() + (name[1] === '#' ? '-sharp' : name[1] === 'b' ? '-flat' : '')
const keyLabel = (tonic: string, mode: KeyMode) => `${tonic} ${mode}`

// ---- Chord progressions ----

/** How the first half of a progression lesson is played; the second half always moves twice as fast, two chords a bar. */
type Texture = 'held' | 'pulse' | 'offbeat' | 'broken'
type Pattern = {
  slug: string
  numerals: string[]
  about: string
  /** Songs with a section built on this progression. */
  examples?: string[]
  /** The songs use these chords, but not in this exact order. */
  loose?: boolean
  /** The V chord takes harmonic minor's raised seventh. */
  harmonic?: boolean
  /** Uppercase numerals with 7 are dominant sevenths even where the scale's seventh is major (the blues). */
  dominant?: boolean
  texture: Texture
  /** Twelve-bar form, one numeral per bar, instead of four chords played twice. */
  blues?: boolean
  /** Chords taken from another scale on the same tonic (a Dorian vamp's major IV). */
  scale?: 'dorian'
}
const PATTERNS: Record<KeyMode, Pattern[]> = {
  major: [
    { slug: 'I-IV-V-I', numerals: ['I', 'IV', 'V', 'I'], texture: 'pulse', about: 'home, the subdominant, the dominant and home: the plainest cadence',
      examples: ['La Bamba (Ritchie Valens)', 'Twist and Shout (The Isley Brothers)'] },
    { slug: 'I-vi-IV-V', numerals: ['I', 'vi', 'IV', 'V'], texture: 'broken', about: 'the relative minor softens the move away before the dominant pulls home',
      examples: ['Stand by Me (Ben E. King)', 'Every Breath You Take (The Police)'] },
    { slug: 'ii-V-I', numerals: ['ii7', 'V7', 'Imaj7', 'Imaj7'], texture: 'held', about: 'seventh chords a fifth apart, the cadence of jazz standards',
      examples: ['Autumn Leaves (jazz standard)', 'Tune Up (Miles Davis)'] },
    { slug: 'I-V-vi-IV', numerals: ['I', 'V', 'vi', 'IV'], texture: 'offbeat', about: 'the loop under many pop songs, falling to the relative minor',
      examples: ['Let It Be (The Beatles)', 'I\'m Yours (Jason Mraz)'] },
    { slug: 'I-vi-ii-V', numerals: ['I', 'vi', 'ii', 'V'], texture: 'pulse', about: 'the circle of fifths back home, the turnaround of countless standards',
      examples: ['I Got Rhythm (George and Ira Gershwin)', 'Blue Moon (Rodgers and Hart)'] },
    { slug: 'I-bVII-IV-I', numerals: ['I', 'bVII', 'IV', 'I'], texture: 'pulse',
      about: 'the flat seventh chord is borrowed from the minor key (the Mixolydian sound of rock): its root lies a whole step below the tonic',
      examples: ['Sweet Child o\' Mine (Guns N\' Roses)', 'Hey Jude (The Beatles), in the long coda'] },
    { slug: 'I-IV-V-IV', numerals: ['I', 'IV', 'V', 'IV'], texture: 'offbeat', about: 'the three primary chords rocking back through IV instead of resolving',
      examples: ['Wild Thing (The Troggs)'] },
    { slug: 'canon', numerals: ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'], texture: 'broken', about: 'a bass falling by step under eight chords, the sequence of Pachelbel\'s Canon',
      examples: ['Canon in D (Johann Pachelbel)'] },
    { slug: 'twelve-bar-blues', numerals: ['I7', 'I7', 'I7', 'I7', 'IV7', 'IV7', 'I7', 'I7', 'V7', 'IV7', 'I7', 'V7'], dominant: true, blues: true, texture: 'offbeat',
      about: 'dominant sevenths on I, IV and V; the flat sevenths of I7 and IV7 lie outside the major scale, which is the blues sound',
      examples: ['Johnny B. Goode (Chuck Berry)', 'Hound Dog (Big Mama Thornton)'] },
  ],
  minor: [
    { slug: 'i-iv-v-i', numerals: ['i', 'iv', 'v', 'i'], texture: 'held', about: 'the natural minor cadence: every chord minor, the dominant without a leading tone',
      examples: ['Black Magic Woman (Fleetwood Mac)'], loose: true },
    { slug: 'i-VI-III-VII', numerals: ['i', 'VI', 'III', 'VII'], texture: 'offbeat', about: 'down to the sixth, up to the relative major and its dominant',
      examples: ['Zombie (The Cranberries)', 'Save Tonight (Eagle-Eye Cherry)'] },
    { slug: 'i-iv-VII-III', numerals: ['i', 'iv', 'VII', 'III'], texture: 'pulse', about: 'through the subtonic to the relative major',
      examples: ['Island in the Sun (Weezer)', 'It\'s My Life (Talk Talk)'] },
    { slug: 'i-iv-V-i-harmonic', numerals: ['i', 'iv', 'V', 'i'], harmonic: true, texture: 'broken',
      about: 'harmonic minor: the seventh is raised in the V chord only, so the dominant is major and leads home',
      examples: ['Minor Swing (Django Reinhardt and Stéphane Grappelli)'] },
    { slug: 'i-VII-VI-VII', numerals: ['i', 'VII', 'VI', 'VII'], texture: 'pulse', about: 'a rocking natural minor loop that never reaches the dominant',
      examples: ['All Along the Watchtower (Bob Dylan; Jimi Hendrix)'] },
    { slug: 'andalusian', numerals: ['i', 'VII', 'VI', 'V'], harmonic: true, texture: 'broken',
      about: 'the Andalusian cadence: stepping down to a major V, whose raised seventh comes from harmonic minor',
      examples: ['Hit the Road Jack (Ray Charles)'] },
    { slug: 'minor-ii-V-i', numerals: ['iiø7', 'V7', 'i', 'i'], harmonic: true, texture: 'held',
      about: 'the minor-key jazz cadence: a half-diminished ii, then a V7 whose major third is harmonic minor\'s raised seventh',
      examples: ['Autumn Leaves (jazz standard), in its minor-key phrases'] },
    { slug: 'dorian-vamp', numerals: ['i7', 'IV7'], scale: 'dorian', texture: 'offbeat',
      about: 'a Dorian vamp: the IV chord is major because Dorian raises natural minor\'s sixth',
      examples: ['Oye Como Va (Tito Puente; Santana)'] },
    { slug: 'i-VI-VII-i', numerals: ['i', 'VI', 'VII', 'i'], texture: 'pulse', about: 'climbing VI, VII, i: the natural minor reaches home by step instead of through V',
      examples: ['The Lord of the Rings theme (Howard Shore)'] },
  ],
}
const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii']
const QUALITY: Record<string, string> = { '4,7': '', '3,7': 'm', '3,6': 'dim', '4,7,11': 'maj7', '4,7,10': '7', '3,7,10': 'm7', '3,6,10': 'm7b5' }

/** The scale of a key, as pitch classes from the tonic; harmonic minor raises the seventh. */
const scaleOf = (tonic: number, mode: KeyMode | 'harmonic' | 'dorian') => MODES[mode].map((step) => (tonic + step) % 12)

/**
 * A roman numeral as a chord symbol in the key, checked against the chord its scale degrees make. A `b` before a
 * major-key numeral borrows the chord from the minor key on the same tonic (bVII, bVI, bIII); `ø7` is half-diminished.
 */
export function numeralChord(tonic: string, mode: KeyMode, numeral: string,
  options: { harmonic?: boolean; dominant?: boolean; scale?: 'dorian' } = {}): string {
  const match = /^(b?)(i{1,3}|iv|vi{0,2}|v)(maj7|ø7|7)?$/i.exec(numeral)
  if (!match) throw new Error(`Unknown numeral ${numeral}`)
  const [, flat, roman, suffix] = match
  const degree = ROMAN.indexOf(roman.toLowerCase())
  const from = flat ? 'minor' : options.scale ?? (mode === 'minor' && options.harmonic && degree === 4 ? 'harmonic' : mode)
  const scale = scaleOf(pitchOf(tonic), from)
  const tones = [0, 2, 4, ...(suffix ? [6] : [])].map((step) => scale[(degree + step) % 7])
  // A blues dominant seventh: the scale's triad with a flat seventh, outside the scale where the scale has a major seventh.
  if (options.dominant && suffix === '7' && roman === roman.toUpperCase()) tones[3] = (tones[0] + 10) % 12
  const quality = QUALITY[tones.slice(1).map((tone) => (tone - tones[0] + 12) % 12).join()]
  const upper = roman === roman.toUpperCase()
  if (quality === undefined || upper !== ['', 'maj7', '7'].includes(quality) || (suffix === 'maj7') !== (quality === 'maj7') || (suffix === 'ø7') !== (quality === 'm7b5'))
    throw new Error(`${numeral} is not ${quality ?? 'a chord'} in ${tonic} ${mode}`)
  return spell(tonic, degree, tones[0]) + quality
}

/** Each chord tone's name, lettered up from the chord's root in thirds: the seventh of A7 is G, of Bbm7b5 is Ab. */
function chordNames(symbol: string): Map<number, string> {
  const match = /^([A-G](?:#|b)?)(.*)$/.exec(symbol)!
  const root = match[1]
  const letter = LETTERS.indexOf(root[0])
  const steps: Record<number, number> = { 0: 0, 2: 1, 3: 2, 4: 2, 5: 3, 6: 4, 7: 4, 9: 5, 10: 6, 11: 6 }
  const intervals = { '': [0, 4, 7], m: [0, 3, 7], dim: [0, 3, 6], maj7: [0, 4, 7, 11], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10], m7b5: [0, 3, 6, 10] }[match[2]]!
  return new Map(intervals.map((interval) => [(pitchOf(root) + interval) % 12, onLetter(letter + steps[interval], (pitchOf(root) + interval) % 12)]))
}

const progressionId = (pattern: Pattern, tonic: string, mode: KeyMode) => `piano-progression-${pattern.slug.toLowerCase()}-${slug(tonic)}-${mode}`

const PROGRESSION_RIGHT: RightPalette = {
  K: [[[0, 4]]], A: [[[0, 1], [1, 1], [2, 1], [3, 1]]], S: [[[0.5, 0.5], [1.5, 0.5], [2.5, 0.5], [3.5, 0.5]]],
  P: [[[0, 0.5, 0], [0.5, 0.5, 1], [1, 0.5, 2], [1.5, 0.5, 1], [2, 0.5, 0], [2.5, 0.5, 1], [3, 0.5, 2], [3.5, 0.5, 1]]],
  // Two chords a bar, each pushed onto its second eighth.
  B: [[[0, 1.5], [1.5, 0.5], [2, 1.5], [3.5, 0.5]]],
  // The blues: a short chord on 1, then off-beat stabs.
  C: [[[0, 0.75], [1.5, 0.5], [2.5, 0.5], [3.5, 0.5]]],
}
const PROGRESSION_LEFT: LeftPalette = {
  b: [[0, 4, ['R', '5'], [5, 1]]],
  // Root and fifth on the beats (with two chords a bar, each chord's own root and fifth).
  o: [[0, 1, ['R']], [1, 1, ['5']], [2, 1, ['R']], [3, 1, ['5']]],
  m: [[0, 1, ['R']], [1, 1, ['5']], [2, 1, ['8']], [3, 1, ['5']]],
  // The last bar walks into the top.
  t: [[0, 1, ['R']], [1, 1, ['5']], [2, 1, ['R']], [3, 1, ['>']]],
}
const TEXTURE: Record<Texture, { right: string; left: string; pedal: boolean; words: string }> = {
  held: { right: 'KKKK', left: 'bbbb', pedal: true, words: 'held chords' },
  pulse: { right: 'AAAA', left: 'oooo', pedal: false, words: 'four chords to the bar over root and fifth' },
  offbeat: { right: 'SSSS', left: 'mmmm', pedal: false, words: 'off-beat chords over a walking root and fifth' },
  broken: { right: 'PPPP', left: 'bbbb', pedal: true, words: 'broken chords' },
}

/** The contrasting texture for a progression's second phrase. */
const CONTRAST: Record<Texture, Texture> = { held: 'pulse', pulse: 'broken', offbeat: 'held', broken: 'offbeat' }

/**
 * A progression lesson in phrases, each a new way of playing the same chords: the family's texture, then a contrasting
 * one over a walking bass, then (for four- and two-chord families) the chords twice as fast, two a bar, and the first
 * texture again, ending on a walk back to the top. Eight-chord families play their sequence twice; the blues two choruses.
 */
function progressionPlan(pattern: Pattern, once: string[]) {
  const size = once.length
  const a = TEXTURE[pattern.texture], b = TEXTURE[CONTRAST[pattern.texture]]
  const repeat = (line: string, bars: number) => line.repeat(Math.ceil(bars / line.length)).slice(0, bars)
  const pairs = (list: string[]) => Array.from({ length: Math.ceil(list.length / 2) }, (_, i) => `${list[2 * i]} ${list[(2 * i + 1) % list.length]}`)
  const numerals = pattern.numerals
  if (pattern.blues) return {
    chords: [...once, ...once], numerals: [...numerals, ...numerals],
    right: `${repeat('C', 12)}${repeat('A', 12)}`, left: `${repeat('m', 12)}${repeat('o', 11)}t`,
    phrases: 'two choruses: off-beat stabs over a walking bass, then four chords to the bar over root and fifth',
  }
  if (size === 8) return {
    chords: [...once, ...once], numerals: [...numerals, ...numerals],
    right: `${repeat(a.right[0], 8)}${repeat(b.right[0], 8)}`, left: `${repeat(a.left[0], 8)}mmmmmmmt`,
    phrases: `the sequence as ${a.words}, then again as ${b.words} over a walking bass`,
  }
  // Four or two chords: four phrases of four bars.
  const cycle = (bars: number) => Array.from({ length: bars }, (_, i) => once[i % size])
  const cycleNumerals = (bars: number) => Array.from({ length: bars }, (_, i) => numerals[i % size])
  const fast = pairs(cycle(8)), fastNumerals = pairs(cycleNumerals(8))
  return {
    chords: [...cycle(4), ...cycle(4), ...fast, ...cycle(4)], numerals: [...cycleNumerals(4), ...cycleNumerals(4), ...fastNumerals, ...cycleNumerals(4)],
    right: `${a.right}${b.right}BBBB${a.right}`, left: `${a.left}mmmmoooo${a.left.slice(0, 3)}t`,
    phrases: `four phrases: ${a.words}; ${b.words} over a walking bass; two chords a bar; then ${a.words} again, walking back to the top`,
  }
}

function progressionLesson(pattern: Pattern, tonic: string, mode: KeyMode, index: number): PianoLesson {
  const id = progressionId(pattern, tonic, mode)
  const once = pattern.numerals.map((numeral) => numeralChord(tonic, mode, numeral, pattern))
  const texture = TEXTURE[pattern.texture]
  const plan = progressionPlan(pattern, once)
  const { chords, numerals } = plan
  const pedal = texture.pedal && !pattern.blues
  const { notes, pedals } = arrange({
    id, beatsPerBar: 4, chords, rich: false, pedal, tonic: pitchOf(tonic), mode, contour: [72, 74, 76, 74, 76, 77, 79, 74, 74, 76, 77, 79, 76, 74, 72, 71],
    right: plan.right, left: plan.left, palette: { right: PROGRESSION_RIGHT, left: PROGRESSION_LEFT },
  })
  // Every note spelled from the chord it belongs to; a passing note into the next chord from the letter above that root.
  const spans = chords.flatMap((bar, number) => bar.split(' ').map((symbol, part, all) => ({ symbol, start: number * 4 + part * 4 / all.length })))
  for (const note of notes) {
    const at = spans.findLastIndex((span) => span.start <= note.startBeat + 1e-9)
    note.spell = chordNames(spans[at].symbol).get(pc(note.midi))
    if (!note.spell) {
      const next = spans[(at + 1) % spans.length].symbol
      note.spell = onLetter(LETTERS.indexOf(next[0]) + 1, pc(note.midi))
    }
  }
  const written = pattern.numerals.join(' – ')
  const name = pattern.blues ? 'Twelve-bar blues (I7 – IV7 – V7)' : `${written}${pattern.harmonic ? ' (harmonic minor V)' : ''}${pattern.scale ? ' (Dorian)' : ''}`
  const examples = pattern.examples ?? []
  return {
    id, instrument: 'piano', kind: 'progression', style: keyLabel(tonic, mode), level: index + 1,
    title: `${name} in ${keyLabel(tonic, mode)}`,
    // The songs are part of the description: the first two under the title in the list, all of them in the lesson's details.
    feel: `${examples.length ? `${pattern.loose ? 'Same chords as' : 'Heard in'} ${examples.slice(0, 2).join(', ')}${examples.length > 2 ? ` and ${examples.length - 2} more` : ''} · ` : ''}` +
      `${chords.length} bars: ${pattern.blues ? 'two choruses' : `${texture.words}, then variations`}`,
    goal: `${pattern.blues ? 'The twelve-bar blues' : `Play ${written}`} in ${keyLabel(tonic, mode)} (${[...new Set(once)].join(' – ')}): ${pattern.about}. ` +
      `${chords.length} bars in ${plan.phrases}.`,
    ...(examples.length ? { examples: { songs: examples, scope: pattern.loose ? 'These songs use the same chords in another order.' : 'These songs use this progression in a section.' } } : {}),
    meter: { numerator: 4, denominator: 4 }, tempo: pattern.blues ? { start: 84, target: 126 } : { start: 76, target: 116 },
    hands: `Right hand: three-note chords moving to the nearest notes of the next, fingers 1–5 written · Left hand: root and fifth, walking up to the octave${pedal ? ' · Right foot: sustain pedal, changed with each chord' : ''}`,
    steps: [
      'Say the numeral and the chord name as you play each bar: the numeral is the chord\'s place in the key.',
      'Keep the notes the chords share under the same fingers and move the others by the smallest step.',
      ...(pedal ? ['Press the sustain pedal just after each new chord and lift it just before the next.'] : []),
      pattern.blues ? 'Count the twelve bars in three lines of four: I, then IV and back, then V, IV and home; the second chorus changes the rhythm.'
        : once.length === 8 ? 'Feel the bass step down under the first half of the sequence; the second time through, the left hand walks.'
        : 'Each four-bar phrase plays the chords a new way; in bars 9–12 they change every two beats: get the left hand moving first, then add the right.',
      'Then try the same progression in another key with the key picker: the numerals stay the same.',
    ],
    bars: chords.length, chords, notes, ...(pedals ? { pedals } : {}),
    sections: numerals.map((numeral) => ({ name: numeral.replace(' ', ' – '), bars: 1 })),
    numerals: numerals.map((numeral) => numeral.replace(' ', ' – ')),
    key: { tonic, mode },
    backing: { style: 'pop', drums: 'genre-pop' },
  }
}

// ---- Scales ----

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


/** A scale: its steps from the tonic going up (and, for melodic minor, coming down), and each note's letter from the tonic's. */
type Family = { id: string; name: string; up: number[]; down?: number[]; letters: number[]; third: KeyMode; tempo: { start: number; target: number }; note: string }
export const SCALE_FAMILIES: Family[] = [
  { id: 'major', name: 'Major (Ionian)', up: MODES.major, letters: [0, 1, 2, 3, 4, 5, 6], third: 'major', tempo: { start: 66, target: 116 }, note: 'whole and half steps W W H W W W H' },
  { id: 'minor', name: 'Natural minor (Aeolian)', up: MODES.minor, letters: [0, 1, 2, 3, 4, 5, 6], third: 'minor', tempo: { start: 66, target: 116 }, note: 'the major scale from its sixth: W H W W H W W' },
  { id: 'dorian', name: 'Dorian', up: [0, 2, 3, 5, 7, 9, 10], letters: [0, 1, 2, 3, 4, 5, 6], third: 'minor', tempo: { start: 66, target: 112 }, note: 'minor with a major sixth' },
  { id: 'phrygian', name: 'Phrygian', up: [0, 1, 3, 5, 7, 8, 10], letters: [0, 1, 2, 3, 4, 5, 6], third: 'minor', tempo: { start: 66, target: 112 }, note: 'minor with a flat second' },
  { id: 'lydian', name: 'Lydian', up: [0, 2, 4, 6, 7, 9, 11], letters: [0, 1, 2, 3, 4, 5, 6], third: 'major', tempo: { start: 66, target: 112 }, note: 'major with a sharp fourth' },
  { id: 'mixolydian', name: 'Mixolydian', up: [0, 2, 4, 5, 7, 9, 10], letters: [0, 1, 2, 3, 4, 5, 6], third: 'major', tempo: { start: 66, target: 112 }, note: 'major with a flat seventh' },
  { id: 'locrian', name: 'Locrian', up: [0, 1, 3, 5, 6, 8, 10], letters: [0, 1, 2, 3, 4, 5, 6], third: 'minor', tempo: { start: 60, target: 104 }, note: 'a flat second and a flat fifth' },
  { id: 'harmonic-minor', name: 'Harmonic minor', up: MODES.harmonic, letters: [0, 1, 2, 3, 4, 5, 6], third: 'minor', tempo: { start: 60, target: 104 }, note: 'natural minor with the seventh raised: a step and a half between the sixth and seventh' },
  { id: 'melodic-minor', name: 'Melodic minor (classical)', up: [0, 2, 3, 5, 7, 9, 11], down: MODES.minor, letters: [0, 1, 2, 3, 4, 5, 6], third: 'minor', tempo: { start: 60, target: 104 },
    note: 'going up the sixth and seventh are raised; coming down it is the natural minor' },
  { id: 'major-pentatonic', name: 'Major pentatonic', up: [0, 2, 4, 7, 9], letters: [0, 1, 2, 4, 5], third: 'major', tempo: { start: 72, target: 126 }, note: 'the major scale without its fourth and seventh' },
  { id: 'minor-pentatonic', name: 'Minor pentatonic', up: [0, 3, 5, 7, 10], letters: [0, 2, 3, 4, 6], third: 'minor', tempo: { start: 72, target: 126 }, note: 'the natural minor without its second and sixth' },
  { id: 'blues', name: 'Minor blues', up: [0, 3, 5, 6, 7, 10], letters: [0, 2, 3, 4, 4, 6], third: 'minor', tempo: { start: 72, target: 120 }, note: 'the minor pentatonic with the flat fifth (blue note) added' },
  { id: 'chromatic', name: 'Chromatic', up: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], letters: [], third: 'major', tempo: { start: 60, target: 100 }, note: 'every half step; written in sharps going up and flats coming down' },
  { id: 'whole-tone', name: 'Whole tone', up: [0, 2, 4, 6, 8, 10], letters: [0, 1, 2, 3, 4, 5], third: 'major', tempo: { start: 66, target: 112 }, note: 'six whole steps to the octave' },
  { id: 'diminished', name: 'Diminished (half-whole)', up: [0, 1, 3, 4, 6, 7, 9, 10], letters: [0, 1, 2, 2, 3, 4, 5, 6], third: 'minor', tempo: { start: 60, target: 100 }, note: 'eight notes alternating half and whole steps, starting with a half step' },
]
const familyOf = (id: string) => SCALE_FAMILIES.find((family) => family.id === id)!

const TONIC_CHOICES = [['C'], ['C#', 'Db'], ['D'], ['D#', 'Eb'], ['E'], ['F'], ['F#', 'Gb'], ['G'], ['G#', 'Ab'], ['A'], ['A#', 'Bb'], ['B']]
/** Each scale note's name going up, lettered from the tonic (chromatic: sharps going up). */
function scaleNames(tonic: string, family: Family, steps = family.up): string[] {
  const root = pitchOf(tonic)
  if (family.id === 'chromatic') return steps.map((step) => step === 0 ? tonic : sharpName((root + step) % 12))
  return steps.map((step, index) => onLetter(LETTERS.indexOf(tonic[0]) + family.letters[index], (root + step) % 12))
}
const sharpName = (pitch: number) => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][pitch]
const flatName = (pitch: number) => ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'][pitch]
const accidentals = (names: string[]) => names.reduce((sum, name) => sum + (name.length - 1) * (name.length > 2 ? 10 : 1), 0)
/** The tonic's name for a scale: major and natural minor as keys are written; other scales take whichever spelling needs fewer accidentals. */
export function scaleTonic(pitch: number, familyId: string): string {
  const family = familyOf(familyId)
  if (familyId === 'major' || familyId === 'minor') return KEY_NAMES[family.third][pitch]
  const preferred = KEY_NAMES[family.third][pitch]
  return [...TONIC_CHOICES[pitch]].sort((a, b) => accidentals(scaleNames(a, family)) - accidentals(scaleNames(b, family)) || (a === preferred ? -1 : b === preferred ? 1 : 0))[0]
}

/** Chromatic fingering: 3 on black keys, 1 on white keys, and 2 on the white key of a white-white half step (F and C going up in the right hand, E and B in the left). */
function chromaticFinger(midi: number, hand: 'right' | 'left'): Finger {
  const key = pc(midi)
  if ([1, 3, 6, 8, 10].includes(key)) return 3
  return (hand === 'right' ? [5, 0] : [4, 11]).includes(key) ? 2 : 1
}

/** Fingers for a line going up: the thumb kept off black keys, the little finger only at the end, every change playable. */
function solveUp(pitches: number[], hand: 'right' | 'left', fixedLast?: Finger): Finger[] {
  const black = (midi: number) => [1, 3, 6, 8, 10].includes(pc(midi))
  const cost: number[][] = [], from: number[][] = []
  pitches.forEach((midi, index) => {
    cost.push([]); from.push([])
    for (let finger = 1 as Finger; finger <= 5; finger++) {
      // The thumb keeps to white keys; only a scale with almost none (a black-key pentatonic) puts it on a black key.
      let own = black(midi) && finger === 1 ? 20 : 0
      const outer = hand === 'right' ? 5 : 1, inner = hand === 'right' ? 1 : 5
      if (index === 0) own += finger === inner ? 0 : finger === (hand === 'right' ? 2 : 4) ? 1 : 2.5
      else if (index === pitches.length - 1) own += fixedLast ? (finger === fixedLast ? 0 : Infinity) : finger === outer ? 0 : finger === (hand === 'right' ? 4 : 2) ? 1 : 3
      else if (finger === outer) own += 4
      if (index === 0) { cost[index][finger] = own; from[index][finger] = -1; continue }
      let best = Infinity, arg = -1
      for (let previous = 1 as Finger; previous <= 5; previous++) {
        const prior = cost[index - 1][previous]
        if (prior === Infinity || prior === undefined) continue
        if (!canFollow(hand, { midi: pitches[index - 1], finger: previous, start: 0, end: 0.5 }, { midi, finger, start: 0.5 })) continue
        const crossing = (hand === 'right' ? finger < previous : finger > previous) ? 1 : 0
        if (prior + own + crossing < best) { best = prior + own + crossing; arg = previous }
      }
      cost[index][finger] = best; from[index][finger] = arg
    }
  })
  let finger = [1, 2, 3, 4, 5].reduce((best, f) => cost.at(-1)![f] < cost.at(-1)![best] ? f : best, 1)
  if (cost.at(-1)![finger] === Infinity) throw new Error(`No fingering for ${pitches.join(' ')}`)
  const out: Finger[] = []
  for (let index = pitches.length - 1; index >= 0; index--) { out[index] = finger as Finger; finger = from[index][finger] }
  return out
}

type Variant = { slug: string; name: string; hands: ('right' | 'left')[] }
const VARIANTS: Variant[] = [
  { slug: 'right-hand', name: 'right hand', hands: ['right'] },
  { slug: 'left-hand', name: 'left hand', hands: ['left'] },
  { slug: 'hands-together', name: 'hands together', hands: ['right', 'left'] },
]
const scaleId = (variant: Variant, tonic: string, familyId: string) => `piano-scale-${variant.slug}-${slug(tonic)}-${familyId}`

function scaleLesson(variant: Variant, pitch: number, familyId: string, index: number): PianoLesson {
  const family = familyOf(familyId)
  const tonic = scaleTonic(pitch, familyId)
  const octaves = family.id === 'chromatic' ? 1 : 2
  const size = family.up.length
  const upSteps = Array.from({ length: size * octaves + 1 }, (_, i) => family.up[i % size] + 12 * Math.floor(i / size))
  const downSteps = Array.from({ length: size * octaves + 1 }, (_, i) => (family.down ?? family.up)[i % size] + 12 * Math.floor(i / size))
  const upNames = scaleNames(tonic, family).concat()
  const downNames = family.id === 'chromatic' ? family.up.map((step) => step === 0 ? tonic : flatName((pitch + step) % 12)) : scaleNames(tonic, family, family.down ?? family.up)
  const table = family.id === 'major' || family.id === 'minor' ? FINGERING[family.third][pitch] : null
  const notes: PianoNote[] = []
  const total = upSteps.length * 2 - 1
  const bars = Math.floor((total - 1) * 0.5 / 4) + 1
  for (const hand of variant.hands) {
    const base = (hand === 'right' ? 60 : 48) + pitch
    const up = upSteps.map((step) => base + step)
    const down = downSteps.map((step) => base + step).reverse()
    let upFingers: Finger[], downFingers: Finger[]
    if (table) {
      const finger = (degree: number) => (hand === 'right' ? degree === size * octaves ? table.top : degree === 0 ? table.start ?? table.right[0] : table.right[degree % 7]
        : degree === 0 ? table.bottom : table.left[degree % 7]) as Finger
      upFingers = up.map((_, degree) => finger(degree))
      downFingers = [...upFingers].reverse()
    } else if (family.id === 'chromatic') {
      // Starting on C or F, the right hand has no E or B before it, so the thumb starts.
      upFingers = up.map((midi, i) => i === 0 && hand === 'right' && [0, 5].includes(pc(midi)) ? 1 : chromaticFinger(midi, hand))
      downFingers = down.map((midi, i) => i === down.length - 1 ? upFingers[0] : chromaticFinger(midi, hand))
    } else {
      upFingers = solveUp(up, hand)
      // Coming down retraces the way up (melodic minor solves its own descent, meeting at the top note).
      downFingers = family.down ? solveUp([...down].reverse(), hand, upFingers.at(-1)).reverse() : [...upFingers].reverse()
    }
    const line = [...up.map((midi, i) => ({ midi, finger: upFingers[i], name: upNames[i % size] })),
      ...down.slice(1).map((midi, i) => ({ midi, finger: downFingers[i + 1], name: downNames[(size * octaves - 1 - i) % size] }))]
    line.forEach(({ midi, finger, name }, i) => notes.push({ trackId: 'piano', hand, midi, startBeat: i / 2, beats: i === line.length - 1 ? bars * 4 - i / 2 : 0.5,
      finger, velocity: i % 4 ? 0.58 : 0.66, spell: name }))
  }
  notes.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi)
  const thumbs = (hand: 'right' | 'left') => [...new Set(notes.filter((note) => note.hand === hand && note.finger === 1).map((note) => note.spell!))].join(', ')
  const label = `${tonic} ${family.name.toLowerCase()}`
  const half = Math.ceil(bars / 2)
  return {
    id: scaleId(variant, tonic, familyId), instrument: 'piano', kind: 'scale', style: label, level: index + 1, family: familyId,
    title: `${tonic} ${family.name} scale: ${variant.name}`,
    feel: `${octaves === 2 ? 'Two octaves' : 'One octave'} up and down in eighth notes`,
    goal: `Play the ${label} scale (${family.note}) ${octaves === 2 ? 'two octaves' : 'one octave'} up and back down, ${variant.name}, with the fingering written for it.`,
    meter: { numerator: 4, denominator: 4 }, tempo: family.tempo,
    hands: variant.hands.map((hand) => `${hand === 'right' ? 'Right' : 'Left'} hand: fingers written for ${label}${thumbs(hand) ? `, thumb on ${thumbs(hand)}` : ''}`).join(' · '),
    steps: [
      'Play slowly and even: every eighth note the same length and weight.',
      family.id === 'chromatic' ? 'Thumb on the white keys, third finger on the black keys; the second finger takes the white key after E or B.'
        : 'Pass the thumb under (or the finger over the thumb) without a bump; the hand moves along with it.',
      ...(family.down ? ['Going up, raise the sixth and seventh; coming down, play them natural again.'] : []),
      variant.hands.length === 2 ? 'The hands change position at different notes: practise each hand alone first.' : 'Watch the written finger at each change of position.',
      'Raise the speed only when the turn at the top is as smooth as the rest.',
    ],
    bars, chords: [], notes,
    sections: [{ name: 'Up', bars: half }, { name: 'Down', bars: bars - half }].filter((section) => section.bars > 0),
    key: { tonic, mode: family.third },
  }
}

// ---- Lists and lookup ----

/** Every key for progressions, in the order the picker lists them. */
export const KEYS = (['major', 'minor'] as KeyMode[]).flatMap((mode) => KEY_NAMES[mode].map((tonic, pitch) => ({ tonic, pitch, mode })))
export const PROGRESSION_COUNT = PATTERNS.major.length + PATTERNS.minor.length
export const SCALE_COUNT = SCALE_FAMILIES.length

const made = new Map<string, PianoLesson>()
const remember = (id: string, make: () => PianoLesson) => { if (!made.has(id)) made.set(id, make()); return made.get(id)! }

/** The progressions in one key, made when first asked for. */
export function progressionLessons(pitch: number, mode: KeyMode): PianoLesson[] {
  const tonic = KEY_NAMES[mode][pitch]
  return PATTERNS[mode].map((pattern, index) => remember(progressionId(pattern, tonic, mode), () => progressionLesson(pattern, tonic, mode, index)))
}
/** One scale in one key, hand by hand, made when first asked for. */
export function scaleLessons(pitch: number, familyId: string): PianoLesson[] {
  const tonic = scaleTonic(pitch, familyId)
  return VARIANTS.map((variant, index) => remember(scaleId(variant, tonic, familyId), () => scaleLesson(variant, pitch, familyId, index)))
}

/** A progression or scale lesson by id, e.g. `piano-progression-ii-v-i-e-flat-major` or `piano-scale-left-hand-f-sharp-dorian`. */
export function tonalLesson(id: string): PianoLesson | undefined {
  if (id.startsWith('piano-progression-')) {
    const key = KEYS.find(({ tonic, mode }) => id.endsWith(`-${slug(tonic)}-${mode}`))
    return key && progressionLessons(key.pitch, key.mode).find((lesson) => lesson.id === id)
  }
  if (!id.startsWith('piano-scale-')) return undefined
  for (const family of SCALE_FAMILIES) for (let pitch = 0; pitch < 12; pitch++)
    if (id.endsWith(`-${slug(scaleTonic(pitch, family.id))}-${family.id}`) && VARIANTS.some((variant) => id === scaleId(variant, scaleTonic(pitch, family.id), family.id)))
      return scaleLessons(pitch, family.id).find((lesson) => lesson.id === id)
  return undefined
}

/** The key (and scale) of a progression or scale lesson, as the picker shows it. */
export function lessonKey(lesson: PianoLesson): { pitch: number; mode: KeyMode; family?: string } | undefined {
  if (!lesson.key) return undefined
  return { pitch: pitchOf(lesson.key.tonic), mode: lesson.key.mode, ...lesson.family ? { family: lesson.family } : {} }
}

/** The other lessons of the same kind in the same key (and scale). */
export function tonalList(lesson: PianoLesson): PianoLesson[] {
  const key = lessonKey(lesson)!
  return lesson.kind === 'progression' ? progressionLessons(key.pitch, key.mode) : scaleLessons(key.pitch, lesson.family!)
}

/** Standard fingering for a major or natural minor scale, by tonic pitch class. */
export const scaleFingering = (tonic: number, mode: KeyMode) => FINGERING[mode][tonic]
