import type { BarMeter, MelodyNote, Song } from '../workspace/song'
import { BASS, GUITAR, type FrettedInstrumentConfig } from '../workspace/fretboard'
import { SCALE_FAMILIES, scaleTonic } from './pianoTonal'
import { inspiredOrder } from './inspired'

export type FrettedInstrument = 'guitar' | 'bass'
export type FrettedLessonKind = 'course' | 'genre' | 'inspired' | 'scale'
type Event = readonly [midi: number, beat: number, beats?: number, velocity?: number]

export type FrettedLesson = {
  id: string
  instrument: FrettedInstrument
  kind: FrettedLessonKind
  genre?: string
  artist?: string
  family?: string
  tonic?: number
  variant?: string
  level: number
  title: string
  goal: string
  meter: { numerator: number; denominator: number }
  tempo: { start: number; target: number }
  bars: number
  steps: string[]
  notes: MelodyNote[]
}

type LessonDraft = Omit<FrettedLesson, 'notes'> & { events: Event[][] }
const meter = { numerator: 4, denominator: 4 }
const exercise = (draft: LessonDraft): FrettedLesson => ({
  ...draft, notes: draft.events.flatMap((bar, index) => bar.map(([midi, beat, beats = 0.5, velocity = 0.78]) => ({
    trackId: draft.instrument, midi, startBeat: index * 4 + beat, beats, velocity,
  }))),
})
const notes = (...events: Event[]) => events
const sequence = (pitches: number[], step = 0.5, duration = step, first = 0): Event[] =>
  pitches.map((midi, index) => [midi, first + index * step, duration])
const shuffle = (pitches: number[]): Event[] =>
  pitches.map((midi, index) => [midi, Math.floor(index / 2) + index % 2 * 2 / 3, index % 2 ? 1 / 3 : 2 / 3])
const chord = (pitches: number[], beat: number, duration = 1): Event[] =>
  pitches.map((midi) => [midi, beat, duration])
const byBar = (pitches: number[], step = 0.5): Event[][] =>
  Array.from({ length: 4 }, (_, bar) => pitches.flatMap((midi, index) => {
    const beat = index * step
    return beat >= bar * 4 && beat < (bar + 1) * 4
      ? [[midi, beat - bar * 4, step] as Event]
      : []
  }))

export const GUITAR_LESSONS: FrettedLesson[] = [
  exercise({
    id: 'guitar-open-strings', instrument: 'guitar', kind: 'course', level: 1, title: 'Name the open strings',
    goal: 'Learn the six open-string pitches from the low E string to the high E string, then reverse the order.',
    meter, tempo: { start: 60, target: 84 }, bars: 4,
    steps: ['Say each string name before you pick it: E, A, D, G, B, E.', 'Let each note ring for one steady beat, then leave the written rests silent.',
      'Repeat the sequence from the high E back to the low E.'],
    events: [
      notes(...sequence([40, 45, 50, 55], 1)),
      notes(...sequence([59, 64], 1)),
      notes(...sequence([59, 55, 50, 45], 1)),
      notes([40, 0, 1]),
    ],
  }),
  exercise({
    id: 'guitar-first-position-e-a', instrument: 'guitar', kind: 'course', level: 1, title: 'First notes on E and A',
    goal: 'Connect the open E2 and A2 pitches to their nearby fretted notes.',
    meter, tempo: { start: 60, target: 84 }, bars: 4,
    steps: ['Play E2, F♯2 and G2, then move up through A2, B2 and C3.', 'Use the suggested tab positions to find the notes above the open E and A pitches.',
      'Keep one finger close to the fret wire and release before the next note.'],
    events: [
      notes(...sequence([40, 42, 43, 45], 1)),
      notes(...sequence([47, 48, 47, 45], 1)),
      notes(...sequence([43, 42, 40, 45], 1)),
      notes(...sequence([48, 47, 45, 40], 1)),
    ],
  }),
  exercise({
    id: 'guitar-low-string-frets', instrument: 'guitar', kind: 'course', level: 2, title: 'Find F♯, G, B and C',
    goal: 'Connect E and A to nearby fretted pitches without changing the quarter-note pulse.',
    meter, tempo: { start: 60, target: 88 }, bars: 4,
    steps: ['Play E2–F♯2–G2, then A2–B2–C3.', 'Use the tab’s suggested positions to find each pitch; the lesson does not author a string or fret choice.',
      'Count all four beats, including the rests between the short phrases.'],
    events: [
      notes(...sequence([40, 42, 43, 42], 1)),
      notes(...sequence([45, 47, 48, 47], 1)),
      notes(...sequence([40, 43, 45, 48], 1)),
      notes(...sequence([48, 45, 43, 40], 1)),
    ],
  }),
  exercise({
    id: 'guitar-eighth-note-counting', instrument: 'guitar', kind: 'course', level: 2, title: 'Eighth notes and rests',
    goal: 'Keep the "&" subdivision even while changing strings and leaving some eighth notes silent.',
    meter, tempo: { start: 56, target: 80 }, bars: 4,
    steps: ['Count “1 & 2 & 3 & 4 &” in every bar.', 'Pick the written eighth notes with relaxed down-up motion; do not fill the rests.',
      'Keep the note lengths short enough for each new string to speak clearly.'],
    events: [
      notes(...sequence([40, 45, 47, 50, 45, 43, 40], 0.5)),
      notes(...sequence([50, 52, 55, 52, 50, 47, 45], 0.5, 0.5, 0.5)),
      notes(...sequence([40, 43, 45, 47, 45, 43, 40], 0.5)),
      notes(...sequence([45, 48, 50, 55, 50, 48, 45], 0.5, 0.5, 0.5)),
    ],
  }),
  exercise({
    id: 'guitar-string-changes', instrument: 'guitar', kind: 'course', level: 3, title: 'Crossing strings cleanly',
    goal: 'Follow the suggested string positions while keeping the pick stroke and count consistent.',
    meter, tempo: { start: 56, target: 84 }, bars: 4,
    steps: ['Follow the string changes shown in the suggested tab; change position on the next counted subdivision.', 'Use alternate picking: down on the number, up on “&”.',
      'Watch the pick move a short distance so it does not catch the neighboring string.'],
    events: [
      notes(...sequence([40, 45, 50, 55, 50, 45, 40], 0.5)),
      notes(...sequence([43, 47, 50, 55, 59, 55, 50], 0.5, 0.5, 0.5)),
      notes(...sequence([45, 50, 55, 59, 64, 59, 55], 0.5)),
      notes(...sequence([64, 59, 55, 50, 45, 50, 40], 0.5, 0.5, 0.5)),
    ],
  }),
  exercise({
    id: 'guitar-alternate-picking', instrument: 'guitar', kind: 'course', level: 3, title: 'Alternate picking in E minor',
    goal: 'Play a short E-minor pentatonic phrase with even down-up picking.',
    meter, tempo: { start: 56, target: 84 }, bars: 4,
    steps: ['The pattern uses the pitches E, G, A, B and D.', 'Pick down-up through every pair and keep the eighth-note rests in time.',
      'Loop the four-bar phrase without speeding up at the end.'],
    events: [
      notes(...sequence([40, 43, 45, 47, 50, 47, 45, 43], 0.5)),
      notes(...sequence([40, 43, 45, 43, 40, 45, 47, 50], 0.5)),
      notes(...sequence([50, 47, 45, 43, 40, 43, 45, 47], 0.5)),
      notes(...sequence([50, 47, 45, 43, 40, 40], 0.5, 0.5, 0.5)),
    ],
  }),
  exercise({
    id: 'guitar-c-major-arpeggio', instrument: 'guitar', kind: 'course', level: 4, title: 'C major chord tones',
    goal: 'Find the notes of a C major chord, then play its chord tones as a clear arpeggio.',
    meter, tempo: { start: 56, target: 80 }, bars: 4,
    steps: ['The C major chord uses the notes C, E and G.', 'Pick one note at a time in the written order; this is an arpeggio, not a strum.',
      'Let each note finish before the next one on that string.'],
    events: [
      notes(...sequence([48, 52, 55, 60], 1)),
      notes(...sequence([64, 60, 55, 52], 1)),
      notes(...sequence([48, 55, 60, 64], 1)),
      notes(...sequence([64, 60, 55, 48], 1)),
    ],
  }),
  exercise({
    id: 'guitar-open-chord-rhythm', instrument: 'guitar', kind: 'course', level: 4, title: 'C major chord rhythm',
    goal: 'Play a C major voicing and practise a steady chord rhythm with space between strums.',
    meter, tempo: { start: 52, target: 76 }, bars: 4,
    steps: ['Form the C shape before the first beat; the tab shows each note of the chord on its own string.', 'Strum only on beats 1 and 3; count beats 2 and 4 without striking.',
      'Keep the chord notes together and release them before the next strum.'],
    events: [
      [...chord([48, 52, 55, 60, 64], 0, 2), ...chord([48, 52, 55, 60, 64], 2, 2)],
      [...chord([48, 52, 55, 60, 64], 0, 2), ...chord([48, 52, 55, 60, 64], 2, 2)],
      [...chord([48, 52, 55, 60, 64], 0, 2), ...chord([48, 52, 55, 60, 64], 2, 2)],
      [...chord([48, 52, 55, 60, 64], 0, 2), ...chord([48, 52, 55, 60, 64], 2, 2)],
    ],
  }),
  exercise({
    id: 'guitar-c-major-scale', instrument: 'guitar', kind: 'course', level: 5, title: 'C major scale pattern',
    goal: 'Play a compact C-major scale pattern in both directions.',
    meter, tempo: { start: 52, target: 76 }, bars: 4,
    steps: ['Use the notes C, D, E, F, G, A, B and C in order.', 'Play the scale up in bar 1 and down in bar 2.',
      'Play one broken scale pattern in bar 3 and a second pattern in bar 4.'],
    events: [
      notes(...sequence([48, 50, 52, 53, 55, 57, 59, 60], 0.5)),
      notes(...sequence([60, 59, 57, 55, 53, 52, 50, 48], 0.5)),
      notes(...sequence([48, 52, 55, 59, 60, 59, 55, 52], 0.5)),
      notes(...sequence([50, 53, 57, 60, 57, 53, 50, 48], 0.5)),
    ],
  }),
  exercise({
    id: 'guitar-original-riff', instrument: 'guitar', kind: 'course', level: 5, title: 'Build an E-minor riff',
    goal: 'Join E-minor pentatonic notes, short rests and a short E pickup into an original four-bar riff.',
    meter, tempo: { start: 56, target: 84 }, bars: 4,
    steps: ['Use alternate picking on the moving notes and let the rests stay silent.', 'Keep the low E pickup short so it leads into the next bar.',
      'Play the phrase at one comfortable speed before increasing the tempo.'],
    events: [
      notes(...sequence([40, 43, 45, 47], 0.5)),
      notes([50, 0.5, 0.5], [47, 1, 0.5], [45, 1.5, 0.5], [43, 2, 0.5], [40, 3.5, 0.5]),
      notes(...sequence([40, 45, 47, 50, 47, 45, 43], 0.5)),
      notes(...sequence([50, 47, 45, 43, 40], 0.5, 0.5, 0.5)),
    ],
  }),
  exercise({
    id: 'guitar-rock-fifths', instrument: 'guitar', kind: 'genre', genre: 'Rock', level: 3, title: 'Rock: fifths and a pickup',
    goal: 'Use E5 and A5 power intervals, then add a short pickup to make a firm rock phrase.',
    meter, tempo: { start: 60, target: 88 }, bars: 4,
    steps: ['Play E and B together for the E5 shape, then A and E for A5.', 'Keep the paired notes on distinct strings and stop them before the next chord.',
      'Use the final low E as a pickup into the first beat of the loop.'],
    events: [
      [...chord([40, 47], 0), ...chord([40, 47], 2)],
      [...chord([45, 52], 0), ...chord([45, 52], 2)],
      notes(...sequence([40, 47, 50, 47, 45, 40], 0.5)),
      notes([43, 0.5, 0.5], [47, 1, 0.5], [50, 1.5, 0.5], [47, 2, 0.5], [40, 3.5, 0.5]),
    ],
  }),
  exercise({
    id: 'guitar-blues-shuffle', instrument: 'guitar', kind: 'genre', genre: 'Blues', level: 4, title: 'Blues: a two-note shuffle',
    goal: 'Place a repeating pair of notes on the long-short shuffle subdivision and add a small E-blues answer.',
    meter, tempo: { start: 54, target: 78 }, bars: 4,
    steps: ['Count each beat as a triplet and play the first and third triplet slots.', 'Keep the shuffle spacing even; do not turn it into straight eighth notes.',
      'Use B♭/A♯ as a brief colour in the E-blues answer, then resolve to E.'],
    events: [
      shuffle([40, 43, 45, 43, 40, 43]),
      shuffle([40, 43, 45, 43, 40, 43]),
      shuffle([40, 43, 46, 47, 45, 43]),
      shuffle([47, 46, 45, 43, 40]),
    ],
  }),
  exercise({
    id: 'guitar-pop-chord-change', instrument: 'guitar', kind: 'genre', genre: 'Pop', level: 4, title: 'Pop: C to G chord changes',
    goal: 'Change between C and G chord shapes on a syncopated rhythm while keeping the chord tones together.',
    meter, tempo: { start: 52, target: 76 }, bars: 4,
    steps: ['Bars 1 and 3 strum C on beat 1, then G on the “&” after beat 3; bars 2 and 4 reverse the chord order.', 'Count “1 & 2 & 3 & 4 &”; the second strum lands on the “&” after beat 3.',
      'Release each chord before changing shape; do not add extra strums.'],
    events: [
      [...chord([48, 52, 55, 60, 64], 0), ...chord([43, 47, 50, 55, 59, 67], 2.5)],
      [...chord([43, 47, 50, 55, 59, 67], 0), ...chord([48, 52, 55, 60, 64], 2.5)],
      [...chord([48, 52, 55, 60, 64], 0), ...chord([43, 47, 50, 55, 59, 67], 2.5)],
      [...chord([43, 47, 50, 55, 59, 67], 0), ...chord([48, 52, 55, 60, 64], 2.5)],
    ],
  }),
]

const GUITAR_COURSE_ADDITIONS: FrettedLesson[] = [
  exercise({
    id: 'guitar-high-note-neighbors', instrument: 'guitar', kind: 'course', level: 1, title: 'Find nearby high notes',
    goal: 'Hear how one semitone changes a note, then find a few neighboring pitches in the score.',
    meter, tempo: { start: 56, target: 80 }, bars: 4,
    steps: ['Count four quarter notes in each bar.', 'Play the written pitch, then move up one or two semitones.', 'Use the suggested tab positions and let each rest stay silent.'],
    events: [
      notes(...sequence([59, 60, 62, 64], 1)),
      notes(...sequence([64, 62, 60, 59], 1)),
      notes(...sequence([55, 57, 59, 60], 1)),
      notes(...sequence([60, 59, 57, 55], 1)),
    ],
  }),
  exercise({
    id: 'guitar-half-step-ladder', instrument: 'guitar', kind: 'course', level: 1, title: 'Move by half steps',
    goal: 'Hear a half step as the distance from one fret to the next.',
    meter, tempo: { start: 56, target: 80 }, bars: 4,
    steps: ['Play the written notes in order and listen for each small pitch change.', 'Reverse the pattern in bars 2 and 4.', 'Let each quarter note finish before the next note starts.'],
    events: [
      notes(...sequence([40, 41, 42, 43], 1)),
      notes(...sequence([43, 42, 41, 40], 1)),
      notes(...sequence([45, 46, 47, 48], 1)),
      notes(...sequence([48, 47, 46, 45], 1)),
    ],
  }),
  exercise({
    id: 'guitar-quarter-note-rests', instrument: 'guitar', kind: 'course', level: 1, title: 'Count rests between notes',
    goal: 'Keep the quarter-note pulse while you leave selected beats silent.',
    meter, tempo: { start: 56, target: 80 }, bars: 4,
    steps: ['Count all four beats in each bar.', 'Pick only the notes that appear in the score.', 'Keep the empty beats quiet and return on time.'],
    events: [
      notes([40, 0, 1], [45, 2, 1]),
      notes([47, 0, 1], [50, 1, 1], [47, 3, 1]),
      notes([43, 1, 1], [45, 3, 1]),
      notes([40, 0, 1], [43, 2, 1], [40, 3, 1]),
    ],
  }),
  exercise({
    id: 'guitar-a-minor-pentatonic', instrument: 'guitar', kind: 'course', level: 2, title: 'A minor pentatonic notes',
    goal: 'Play five notes from the A-minor pentatonic scale in both directions.',
    meter, tempo: { start: 56, target: 82 }, bars: 4,
    steps: ['Use A, C, D, E and G as the five scale notes.', 'Play A, C, D and E in bar 1, then start bar 2 on G.', 'Continue down through E, D and C.'],
    events: [
      notes(...sequence([45, 48, 50, 52], 1)),
      notes(...sequence([55, 52, 50, 48], 1)),
      notes(...sequence([45, 50, 55, 52], 1)),
      notes(...sequence([50, 48, 45, 45], 1)),
    ],
  }),
  exercise({
    id: 'guitar-eighth-note-pairs', instrument: 'guitar', kind: 'course', level: 2, title: 'Pair eighth notes with space',
    goal: 'Play even eighth-note pairs and keep the quarter-note count through each rest.',
    meter, tempo: { start: 56, target: 82 }, bars: 4,
    steps: ['Count “1 & 2 & 3 & 4 &” in each bar.', 'Pick the two-note groups with a steady down-up motion.', 'Do not fill the spaces between groups.'],
    events: [
      notes([40, 0, 0.5], [43, 0.5, 0.5], [45, 2, 0.5], [47, 2.5, 0.5]),
      notes([50, 0, 0.5], [47, 0.5, 0.5], [45, 1, 0.5], [43, 1.5, 0.5]),
      notes([45, 0, 0.5], [48, 0.5, 0.5], [50, 2, 0.5], [52, 2.5, 0.5]),
      notes([55, 0, 0.5], [52, 0.5, 0.5], [48, 2, 0.5], [45, 2.5, 0.5]),
    ],
  }),
  exercise({
    id: 'guitar-change-pitch-groups', instrument: 'guitar', kind: 'course', level: 2, title: 'Join two pitch groups',
    goal: 'Move between a low phrase and a higher answer without changing the steady beat.',
    meter, tempo: { start: 56, target: 82 }, bars: 4,
    steps: ['Play the first two bars as one low phrase.', 'Answer with the higher notes in bars 3 and 4.', 'Count the quarter-note pulse through each phrase change.'],
    events: [
      notes(...sequence([40, 43, 45, 47], 1)),
      notes(...sequence([50, 47, 45, 43], 1)),
      notes(...sequence([55, 59, 60, 62], 1)),
      notes(...sequence([64, 62, 60, 59], 1)),
    ],
  }),
  exercise({
    id: 'guitar-string-crossing-answers', instrument: 'guitar', kind: 'course', level: 3, title: 'Cross strings in short answers',
    goal: 'Play a picked call and answer that moves between low and high written pitches.',
    meter, tempo: { start: 54, target: 82 }, bars: 4,
    steps: ['Play the first two notes in each four-note group as the call.', 'Answer with the next two notes, then start the next group.', 'Use alternate picking and keep the eighth notes even.'],
    events: [
      notes(...sequence([40, 47, 55, 52, 45, 50, 59, 55], 0.5)),
      notes(...sequence([43, 50, 59, 55, 47, 52, 60, 55], 0.5)),
      notes(...sequence([45, 52, 60, 57, 48, 53, 62, 57], 0.5)),
      notes(...sequence([40, 47, 59, 55, 43, 50, 55, 52], 0.5)),
    ],
  }),
  exercise({
    id: 'guitar-triplet-picking', instrument: 'guitar', kind: 'course', level: 3, title: 'Pick even triplets',
    goal: 'Play three even notes per beat and keep the triplet pulse steady.',
    meter, tempo: { start: 48, target: 72 }, bars: 4,
    steps: ['Count “1 trip let” for each beat.', 'Pick one note on each triplet slot.', 'Keep all three notes even and stop at the end of each bar.'],
    events: [
      notes(...sequence([40, 43, 45, 47, 50, 47, 45, 43, 40, 43, 45, 47], 1 / 3, 1 / 3)),
      notes(...sequence([50, 47, 45, 43, 40, 43, 45, 47, 50, 47, 45, 43], 1 / 3, 1 / 3)),
      notes(...sequence([45, 47, 50, 52, 55, 52, 50, 47, 45, 47, 50, 52], 1 / 3, 1 / 3)),
      notes(...sequence([55, 52, 50, 47, 45, 43, 40, 43, 45, 47, 43, 40], 1 / 3, 1 / 3)),
    ],
  }),
  exercise({
    id: 'guitar-string-skip-picking', instrument: 'guitar', kind: 'course', level: 3, title: 'Pick a wide arpeggio pattern',
    goal: 'Follow a wide arpeggio pattern without adding notes between the written pitches.',
    meter, tempo: { start: 54, target: 82 }, bars: 4,
    steps: ['Play the notes in the written order.', 'Keep the spaces between each pitch clear.', 'Keep each eighth note short and even.'],
    events: [
      notes(...sequence([40, 47, 52, 59, 55, 50, 45, 40], 0.5)),
      notes(...sequence([43, 50, 55, 62, 59, 55, 50, 43], 0.5)),
      notes(...sequence([45, 52, 57, 64, 60, 57, 52, 45], 0.5)),
      notes(...sequence([40, 47, 55, 59, 55, 52, 47, 40], 0.5)),
    ],
  }),
  exercise({
    id: 'guitar-g-major-arpeggio', instrument: 'guitar', kind: 'course', level: 4, title: 'Arpeggiate G major',
    goal: 'Play the G-major chord tones one at a time, then reverse the arpeggio.',
    meter, tempo: { start: 52, target: 78 }, bars: 4,
    steps: ['Use G, B and D as the three chord tones.', 'Play the ascending notes in bar 1 and the descending notes in bar 2.', 'Keep each quarter note clear before the next pitch.'],
    events: [
      notes(...sequence([43, 47, 50, 55], 1)),
      notes(...sequence([59, 55, 50, 47], 1)),
      notes(...sequence([43, 50, 55, 59], 1)),
      notes(...sequence([55, 50, 47, 43], 1)),
    ],
  }),
  exercise({
    id: 'guitar-d-a-g-changes', instrument: 'guitar', kind: 'course', level: 4, title: 'Change D, A and G shapes',
    goal: 'Change between three major chord voicings on a steady half-note rhythm.',
    meter, tempo: { start: 50, target: 74 }, bars: 4,
    steps: ['Play D, then A in bar 1.', 'Play G, then D in bar 2; play A, then G in bar 3.', 'Play D, then G in bar 4 and keep each chord together.'],
    events: [
      [...chord([50, 54, 57, 62, 66], 0, 2), ...chord([45, 49, 52, 57, 61], 2, 2)],
      [...chord([43, 47, 50, 55, 59], 0, 2), ...chord([50, 54, 57, 62, 66], 2, 2)],
      [...chord([45, 49, 52, 57, 61], 0, 2), ...chord([43, 47, 50, 55, 59], 2, 2)],
      [...chord([50, 54, 57, 62, 66], 0, 2), ...chord([43, 47, 50, 55, 59], 2, 2)],
    ],
  }),
  exercise({
    id: 'guitar-a-minor-chord-tones', instrument: 'guitar', kind: 'course', level: 4, title: 'Play A minor chord tones',
    goal: 'Use A, C and E as a minor chord, then shape a short arpeggio from those notes.',
    meter, tempo: { start: 52, target: 78 }, bars: 4,
    steps: ['Play A, C and E one note at a time.', 'Move from A to E and back through C.', 'Use the suggested tab positions and leave the rests open.'],
    events: [
      notes(...sequence([45, 48, 52, 57], 1)),
      notes(...sequence([57, 52, 48, 45], 1)),
      notes(...sequence([45, 52, 48, 57], 1)),
      notes(...sequence([52, 48, 45, 45], 1)),
    ],
  }),
  exercise({
    id: 'guitar-e-minor-scale-sequence', instrument: 'guitar', kind: 'course', level: 5, title: 'Sequence E minor',
    goal: 'Play an E-minor scale fragment in rising groups and resolve it to E.',
    meter, tempo: { start: 50, target: 76 }, bars: 4,
    steps: ['Play the scale notes in the written order.', 'Start each bar higher in the scale.', 'Finish on E and keep the eighth-note pulse steady.'],
    events: [
      notes(...sequence([40, 43, 45, 43, 45, 47, 45, 47], 0.5)),
      notes(...sequence([50, 47, 50, 52, 50, 52, 55, 52], 0.5)),
      notes(...sequence([55, 57, 55, 57, 59, 57, 59, 64], 0.5)),
      notes(...sequence([59, 57, 55, 52, 50, 47, 43, 40], 0.5)),
    ],
  }),
  exercise({
    id: 'guitar-call-answer-riff', instrument: 'guitar', kind: 'course', level: 5, title: 'Write a call and answer',
    goal: 'Join a short E-minor call to a higher answer, with space before the final return.',
    meter, tempo: { start: 52, target: 78 }, bars: 4,
    steps: ['Play the low call in bars 1 and 2.', 'Answer with the higher phrase in bar 3.', 'Leave one beat of space in bar 4, then return to E.'],
    events: [
      notes(...sequence([40, 43, 47, 45, 40], 0.5)),
      notes(...sequence([40, 45, 47, 50, 45], 0.5, 0.5, 0.5)),
      notes(...sequence([55, 52, 59, 57, 55], 0.5)),
      notes([50, 0, 0.5], [47, 0.5, 0.5], [45, 1, 1], [40, 3, 1]),
    ],
  }),
  exercise({
    id: 'guitar-four-bar-riff', instrument: 'guitar', kind: 'course', level: 5, title: 'Build a four-bar riff',
    goal: 'Combine a repeated low pulse, a rising answer and a clear final note into an original phrase.',
    meter, tempo: { start: 52, target: 80 }, bars: 4,
    steps: ['Keep the opening pulse steady in bars 1 and 2.', 'Raise the phrase in bar 3, then descend in bar 4.', 'Let the final E ring for one beat, then leave the last beat silent.'],
    events: [
      notes(...sequence([40, 40, 47, 40, 43, 45, 47, 45], 0.5)),
      notes(...sequence([40, 43, 45, 47, 50, 47, 45, 43], 0.5)),
      notes(...sequence([45, 47, 50, 52, 55, 57, 55, 52], 0.5)),
      notes([50, 0, 0.5], [47, 0.5, 0.5], [45, 1, 1], [40, 2, 1]),
    ],
  }),
]

export const BASS_LESSONS: FrettedLesson[] = [
  exercise({
    id: 'bass-open-strings', instrument: 'bass', kind: 'course', level: 1, title: 'Name the four open strings',
    goal: 'Learn the standard low-to-high E, A, D and G strings, then find each one by its open pitch.',
    meter, tempo: { start: 60, target: 84 }, bars: 4,
    steps: ['Say E, A, D and G as you play the open strings.', 'Use one relaxed pluck for each quarter note and let the pitch ring.',
      'Play the last two bars from G back down to E.'],
    events: [
      notes(...sequence([28, 33, 38, 43], 1)),
      notes(...sequence([43, 38, 33, 28], 1)),
      notes(...sequence([28, 33, 38, 43], 1)),
      notes(...sequence([43, 38, 33, 28], 1)),
    ],
  }),
  exercise({
    id: 'bass-low-e-pulse', instrument: 'bass', kind: 'course', level: 1, title: 'Hold the low E pulse',
    goal: 'Keep a steady quarter-note pulse on the open E string and leave the written rests empty.',
    meter, tempo: { start: 60, target: 84 }, bars: 4,
    steps: ['Pluck each written quarter note with the same finger motion.', 'Count each silent beat while the note is not playing.',
      'Keep your fretting hand relaxed over the first few frets.'],
    events: [
      notes(...sequence([28, 28], 2, 1)),
      notes(...sequence([28, 28, 28], 1)),
      notes(...sequence([28, 28], 2, 1, 1)),
      notes(...sequence([28, 28, 28, 28], 1)),
    ],
  }),
  exercise({
    id: 'bass-first-frets', instrument: 'bass', kind: 'course', level: 2, title: 'First frets on E and A',
    goal: 'Learn F♯1 and G1 above E1, then B1 and C2 above A1.',
    meter, tempo: { start: 60, target: 88 }, bars: 4,
    steps: ['Play E1–F♯1–G1, then A1–B1–C2.', 'Use the tab’s suggested positions to find these notes above the open E and A pitches.',
      'Keep each note even as you move between the pitches.'],
    events: [
      notes(...sequence([28, 30, 31, 30], 1)),
      notes(...sequence([33, 35, 36, 35], 1)),
      notes(...sequence([28, 31, 33, 36], 1)),
      notes(...sequence([36, 35, 31, 28], 1)),
    ],
  }),
  exercise({
    id: 'bass-string-changes', instrument: 'bass', kind: 'course', level: 2, title: 'Move across four open pitches',
    goal: 'Change pitch on the beat without losing the steady pulse or adding unwanted notes.',
    meter, tempo: { start: 56, target: 84 }, bars: 4,
    steps: ['Play the open E1, A1, D2 and G2 pitches, then follow the suggested tab positions back down.', 'Keep the plucking hand relaxed and count through each move.',
      'Use the tab to see how the fretted notes are positioned.'],
    events: [
      notes(...sequence([28, 33, 38, 43], 1)),
      notes(...sequence([45, 40, 35, 30], 1)),
      notes(...sequence([31, 36, 41, 46], 1)),
      notes(...sequence([43, 38, 33, 28], 1)),
    ],
  }),
  exercise({
    id: 'bass-eighth-note-plucking', instrument: 'bass', kind: 'course', level: 3, title: 'Even eighth-note plucking',
    goal: 'Play short eighth-note phrases with clear pitch changes and keep every silent subdivision in the count.',
    meter, tempo: { start: 56, target: 84 }, bars: 4,
    steps: ['Count “1 & 2 & 3 & 4 &” throughout.', 'Alternate index and middle fingers on the moving eighth notes.',
      'Keep rests the same length as a played subdivision.'],
    events: [
      notes(...sequence([28, 28, 33, 33, 28, 28], 0.5)),
      notes(...sequence([33, 35, 36, 35, 33, 31], 0.5, 0.5, 0.5)),
      notes(...sequence([28, 31, 33, 35, 33, 31, 28], 0.5)),
      notes(...sequence([38, 35, 33, 31, 28], 0.5, 0.5, 0.5)),
    ],
  }),
  exercise({
    id: 'bass-root-fifth-groove', instrument: 'bass', kind: 'course', level: 3, title: 'E root and fifth',
    goal: 'Build a simple E groove from its root and fifth with a short pickup.',
    meter, tempo: { start: 60, target: 88 }, bars: 4,
    steps: ['Use E1 as the root and B1 as its fifth.', 'Follow the written root-and-fifth pattern. Some notes start off the beat.',
      'Use the last eighth-note pickup to return to E without pushing the pulse.'],
    events: [
      notes(...sequence([28, 28, 35, 28, 35, 28, 35], 0.5)),
      notes(...sequence([28, 35, 28, 35, 28, 35], 0.5)),
      notes(...sequence([28, 28, 35, 40, 35, 28, 35], 0.5)),
      notes(...sequence([28, 35, 28, 35, 28, 35, 28], 0.5, 0.5, 0.5)),
    ],
  }),
  exercise({
    id: 'bass-root-fifth-octave', instrument: 'bass', kind: 'course', level: 4, title: 'Root, fifth and octave',
    goal: 'Move between E, B and the higher E to hear three useful roles in one bass line.',
    meter, tempo: { start: 56, target: 80 }, bars: 4,
    steps: ['Play E1, B1 and E2; the octave is two times the root frequency.', 'Use the tab’s suggested positions for the higher E octave.',
      'Play the notes as a line, with no overlaps, and count the spaces between them.'],
    events: [
      notes(...sequence([28, 35, 40, 35], 1)),
      notes(...sequence([28, 40, 35, 28], 1)),
      notes(...sequence([28, 35, 40, 40], 1)),
      notes(...sequence([40, 35, 28, 35], 1)),
    ],
  }),
  exercise({
    id: 'bass-g-major-scale', instrument: 'bass', kind: 'course', level: 4, title: 'G major scale pattern',
    goal: 'Play a one-octave G-major pattern up and down, then use its notes in a broken-scale phrase.',
    meter, tempo: { start: 52, target: 76 }, bars: 4,
    steps: ['Bars 1 and 2 play G–A–B–C–D–E–F♯–G up, then back down.', 'Bars 3 and 4 use the written skipped-note patterns and return to G.',
      'Follow the tab’s suggested positions; string choices are inferred from pitch, not fixed in the lesson.'],
    events: [
      notes(...sequence([31, 33, 35, 36, 38, 40, 42, 43], 0.5)),
      notes(...sequence([43, 42, 40, 38, 36, 35, 33, 31], 0.5)),
      notes(...sequence([31, 35, 38, 42, 43, 42, 38, 35], 0.5)),
      notes(...sequence([33, 36, 40, 43, 40, 36, 33, 31], 0.5)),
    ],
  }),
  exercise({
    id: 'bass-moving-roots', instrument: 'bass', kind: 'course', level: 5, title: 'Root changes with octave answers',
    goal: 'Change roots between G and C, using a fifth or octave as a short answer instead of repeating one pattern.',
    meter, tempo: { start: 56, target: 84 }, bars: 4,
    steps: ['Use G1 and C2 as the two roots.', 'Answer each root with its fifth or octave as written.',
      'Keep the final G in time so the phrase returns cleanly to its first bar.'],
    events: [
      notes(...sequence([31, 31, 38, 43], 1)),
      notes(...sequence([36, 36, 43, 48], 1)),
      notes(...sequence([31, 38, 43, 38], 1)),
      notes(...sequence([36, 43, 48, 31], 1)),
    ],
  }),
  exercise({
    id: 'bass-original-groove', instrument: 'bass', kind: 'course', level: 5, title: 'Build a four-bar bass groove',
    goal: 'Combine roots, fifths, octaves and rests into a varied original groove with a clear loop point.',
    meter, tempo: { start: 56, target: 84 }, bars: 4,
    steps: ['Let the root establish each bar before the fifth or octave answers.', 'Count the eighth-note rests and keep the pulse steady.',
      'Play the whole phrase twice with the same relaxed plucking motion.'],
    events: [
      notes(...sequence([31, 38, 31, 43, 38, 31], 0.5)),
      notes(...sequence([36, 43, 48, 43, 36], 0.5, 0.5, 0.5)),
      notes(...sequence([31, 31, 38, 43, 38, 31], 0.5)),
      notes(...sequence([36, 43, 48, 43, 38], 0.5, 0.5, 0.5)),
    ],
  }),
  exercise({
    id: 'bass-rock-root-fifth', instrument: 'bass', kind: 'genre', genre: 'Rock', level: 3, title: 'Rock: driving roots and fifths',
    goal: 'Keep a firm eighth-note rock pulse while alternating an E root with its fifth.',
    meter, tempo: { start: 64, target: 92 }, bars: 4,
    steps: ['Use E1 as the root and B1 as its fifth.', 'Accent the downbeats with a slightly stronger pluck; keep the offbeats even.',
      'Change the last two bars to the written A-root response.'],
    events: [
      notes(...sequence([28, 35, 28, 35, 28, 35, 28, 35], 0.5)),
      notes(...sequence([28, 28, 35, 28, 35, 28, 35], 0.5)),
      notes(...sequence([33, 40, 33, 40, 33, 40, 33, 40], 0.5)),
      notes(...sequence([33, 40, 33, 35, 33, 40, 33], 0.5)),
    ],
  }),
  exercise({
    id: 'bass-blues-walk', instrument: 'bass', kind: 'genre', genre: 'Blues', level: 4, title: 'Blues: a simple walking turn',
    goal: 'Walk through E, A and B chord roots with fifths and stepwise approaches in an original blues exercise.',
    meter, tempo: { start: 54, target: 78 }, bars: 4,
    steps: ['Count four even quarter notes and pluck each note once.', 'Use E, A and B chord tones and keep the line smooth across bar changes.',
      'Keep the low notes warm and even rather than accenting every change.'],
    events: [
      notes(...sequence([28, 33, 35, 38], 1)),
      notes(...sequence([33, 38, 40, 43], 1)),
      notes(...sequence([35, 40, 42, 43], 1)),
      notes(...sequence([38, 35, 33, 31], 1)),
    ],
  }),
  exercise({
    id: 'bass-pop-root-octave', instrument: 'bass', kind: 'genre', genre: 'Pop', level: 4, title: 'Pop: root and octave answers',
    goal: 'Use a simple root-and-octave pattern with a held note and a syncopated answer.',
    meter, tempo: { start: 58, target: 82 }, bars: 4,
    steps: ['Play G1 and G2, then C2 and C3; follow the suggested positions for each octave.', 'Hold the first root for two beats and place the octave on the “&” before beat 4.',
      'Count all subdivisions through the held notes and rests.'],
    events: [
      notes(...notes([31, 0, 2], [43, 2.5, 0.5])),
      notes(...notes([36, 0, 2], [48, 2.5, 0.5])),
      notes(...sequence([31, 43, 38, 43], 1)),
      notes(...notes([36, 0, 2], [48, 2.5, 0.5], [36, 3.5, 0.5])),
    ],
  }),
]

const BASS_COURSE_ADDITIONS: FrettedLesson[] = [
  exercise({
    id: 'bass-half-step-ladder', instrument: 'bass', kind: 'course', level: 1, title: 'Move by half steps',
    goal: 'Hear how one semitone changes a note, then find the nearby pitches in the score.',
    meter, tempo: { start: 56, target: 80 }, bars: 4,
    steps: ['Count four quarter notes in each bar.', 'Play the notes in order, then reverse them in the next bar.', 'Use the suggested tab positions and keep the pulse even.'],
    events: [
      notes(...sequence([28, 29, 30, 31], 1)),
      notes(...sequence([31, 30, 29, 28], 1)),
      notes(...sequence([33, 34, 35, 36], 1)),
      notes(...sequence([36, 35, 34, 33], 1)),
    ],
  }),
  exercise({
    id: 'bass-quarter-note-rests', instrument: 'bass', kind: 'course', level: 1, title: 'Count rests in a bass pulse',
    goal: 'Keep a steady quarter-note count while you leave selected beats silent.',
    meter, tempo: { start: 56, target: 80 }, bars: 4,
    steps: ['Count all four beats in each bar.', 'Pluck only the notes that appear in the score.', 'Keep the rests quiet and return on time.'],
    events: [
      notes([28, 0, 1], [28, 2, 1]),
      notes([28, 0, 1], [33, 1, 1], [28, 3, 1]),
      notes([33, 0, 1], [38, 2, 1]),
      notes([28, 0, 1], [35, 2, 1], [28, 3, 1]),
    ],
  }),
  exercise({
    id: 'bass-open-register-answers', instrument: 'bass', kind: 'course', level: 1, title: 'Answer with a higher note',
    goal: 'Keep a low pulse and answer it with a higher pitch from the same written phrase.',
    meter, tempo: { start: 56, target: 80 }, bars: 4,
    steps: ['Play the low note on beats 1 and 3.', 'Answer with the higher note on beats 2 and 4.', 'Keep each quarter note even and relaxed.'],
    events: [
      notes(...sequence([28, 40, 28, 40], 1)),
      notes(...sequence([33, 45, 33, 45], 1)),
      notes(...sequence([38, 50, 38, 50], 1)),
      notes(...sequence([43, 55, 43, 55], 1)),
    ],
  }),
  exercise({
    id: 'bass-d-and-g-neighbors', instrument: 'bass', kind: 'course', level: 2, title: 'Find notes near D and G',
    goal: 'Connect D and G to nearby written pitches with a steady quarter-note count.',
    meter, tempo: { start: 56, target: 82 }, bars: 4,
    steps: ['Play D, E, F♯ and G in bar 1.', 'Reverse those notes in bar 2.', 'Use the same pattern from G in bars 3 and 4.'],
    events: [
      notes(...sequence([38, 40, 42, 43], 1)),
      notes(...sequence([43, 42, 40, 38], 1)),
      notes(...sequence([43, 45, 47, 48], 1)),
      notes(...sequence([48, 47, 45, 43], 1)),
    ],
  }),
  exercise({
    id: 'bass-e-minor-note-set', instrument: 'bass', kind: 'course', level: 2, title: 'Use the E minor notes',
    goal: 'Find E, G, A, B and D as a small set of useful bass notes.',
    meter, tempo: { start: 56, target: 82 }, bars: 4,
    steps: ['Play E, G, A and B in bar 1.', 'Add D, then return through B, A and G.', 'Finish on E and keep each eighth note even.'],
    events: [
      notes(...sequence([28, 31, 33, 35], 1)),
      notes(...sequence([38, 35, 33, 31], 1)),
      notes(...sequence([28, 33, 35, 38], 1)),
      notes(...sequence([35, 33, 31, 28], 1)),
    ],
  }),
  exercise({
    id: 'bass-eighth-note-pairs', instrument: 'bass', kind: 'course', level: 2, title: 'Play paired eighth notes',
    goal: 'Play paired eighth notes on a steady beat and leave the written spaces silent.',
    meter, tempo: { start: 54, target: 82 }, bars: 4,
    steps: ['Count “1 & 2 & 3 & 4 &” in each bar.', 'Use alternating index and middle fingers on each pair.', 'Keep the empty subdivisions silent.'],
    events: [
      notes([28, 0, 0.5], [35, 0.5, 0.5], [33, 2, 0.5], [28, 2.5, 0.5]),
      notes([33, 0, 0.5], [38, 0.5, 0.5], [35, 1, 0.5], [33, 1.5, 0.5]),
      notes([28, 0, 0.5], [31, 0.5, 0.5], [35, 2, 0.5], [38, 2.5, 0.5]),
      notes([33, 0, 0.5], [35, 0.5, 0.5], [31, 2, 0.5], [28, 2.5, 0.5]),
    ],
  }),
  exercise({
    id: 'bass-alternate-finger-eighths', instrument: 'bass', kind: 'course', level: 3, title: 'Alternate fingers on eighths',
    goal: 'Keep an even eighth-note line while the pitches move between a root and its fifth.',
    meter, tempo: { start: 54, target: 82 }, bars: 4,
    steps: ['Alternate index and middle fingers through each eighth-note group.', 'Use E and B in bars 1 and 2, then A and E in bars 3 and 4.', 'Keep the final note short and count the remaining space.'],
    events: [
      notes(...sequence([28, 35, 28, 35, 28, 35, 28], 0.5)),
      notes(...sequence([28, 28, 35, 28, 35, 28, 35], 0.5)),
      notes(...sequence([33, 40, 33, 40, 33, 40, 33], 0.5)),
      notes(...sequence([33, 40, 33, 35, 33, 40, 33], 0.5)),
    ],
  }),
  exercise({
    id: 'bass-string-skip-arpeggio', instrument: 'bass', kind: 'course', level: 3, title: 'Play a skipped-note arpeggio',
    goal: 'Move between chord tones in a wide pitch pattern without adding extra notes.',
    meter, tempo: { start: 54, target: 82 }, bars: 4,
    steps: ['Play the root, fifth and octave in the written order.', 'Let each eighth note finish before the next note.', 'Keep the skipped pitches in the count.'],
    events: [
      notes(...sequence([28, 35, 40, 35, 28, 35, 40, 35], 0.5)),
      notes(...sequence([33, 40, 45, 40, 33, 40, 45, 40], 0.5)),
      notes(...sequence([31, 38, 43, 38, 31, 38, 43, 38], 0.5)),
      notes(...sequence([28, 35, 40, 35, 31, 38, 43, 28], 0.5)),
    ],
  }),
  exercise({
    id: 'bass-triplet-pulse', instrument: 'bass', kind: 'course', level: 3, title: 'Pluck an even triplet pulse',
    goal: 'Play three even notes per beat and keep the triplet count steady.',
    meter, tempo: { start: 48, target: 72 }, bars: 4,
    steps: ['Count “1 trip let” for each beat.', 'Pluck one note on every triplet slot.', 'Keep each group even and start the next bar on time.'],
    events: [
      notes(...sequence([28, 28, 35, 28, 33, 33, 40, 33, 28, 35, 40, 35], 1 / 3, 1 / 3)),
      notes(...sequence([33, 33, 40, 33, 38, 38, 45, 38, 33, 40, 45, 40], 1 / 3, 1 / 3)),
      notes(...sequence([31, 31, 38, 31, 36, 36, 43, 36, 31, 38, 43, 38], 1 / 3, 1 / 3)),
      notes(...sequence([28, 28, 35, 28, 33, 35, 38, 35, 31, 35, 38, 28], 1 / 3, 1 / 3)),
    ],
  }),
  exercise({
    id: 'bass-c-major-arpeggio', instrument: 'bass', kind: 'course', level: 4, title: 'Arpeggiate C major',
    goal: 'Play C, E and G as a major chord, then move up to the octave.',
    meter, tempo: { start: 52, target: 78 }, bars: 4,
    steps: ['Play C, E, G and the higher C in bar 1.', 'Return through G, E and C in bar 2.', 'Use the same notes in a new order for bars 3 and 4.'],
    events: [
      notes(...sequence([36, 40, 43, 48], 1)),
      notes(...sequence([48, 43, 40, 36], 1)),
      notes(...sequence([36, 43, 40, 48], 1)),
      notes(...sequence([43, 40, 36, 36], 1)),
    ],
  }),
  exercise({
    id: 'bass-a-minor-scale', instrument: 'bass', kind: 'course', level: 4, title: 'Play an A minor scale',
    goal: 'Play an A minor scale over one octave and return to its root.',
    meter, tempo: { start: 50, target: 76 }, bars: 4,
    steps: ['Use A, B, C, D, E, F, G and A in order.', 'Play the scale up in bar 1 and down in bar 2.', 'Keep the last two bars even and resolve to A.'],
    events: [
      notes(...sequence([33, 35, 36, 38, 40, 41, 43, 45], 0.5)),
      notes(...sequence([45, 43, 41, 40, 38, 36, 35, 33], 0.5)),
      notes(...sequence([33, 36, 40, 43, 45, 43, 40, 36], 0.5)),
      notes(...sequence([38, 41, 45, 43, 40, 36, 35, 33], 0.5)),
    ],
  }),
  exercise({
    id: 'bass-root-third-fifth', instrument: 'bass', kind: 'course', level: 4, title: 'Connect root, third and fifth',
    goal: 'Build an E minor line from its root, minor third and fifth.',
    meter, tempo: { start: 52, target: 78 }, bars: 4,
    steps: ['Use E, G and B as the E minor chord tones.', 'Play each pitch in the written order.', 'Keep the roots steady when the line changes direction.'],
    events: [
      notes(...sequence([28, 31, 35, 40], 1)),
      notes(...sequence([35, 31, 28, 35], 1)),
      notes(...sequence([28, 35, 31, 40], 1)),
      notes(...sequence([35, 31, 28, 28], 1)),
    ],
  }),
  exercise({
    id: 'bass-d-octave-groove', instrument: 'bass', kind: 'course', level: 5, title: 'Add octave answers in D',
    goal: 'Use D and A as the root and fifth, then answer with the higher D octave.',
    meter, tempo: { start: 52, target: 80 }, bars: 4,
    steps: ['Use D2 as the root and A2 as its fifth.', 'Answer with D3 at the written points.', 'Keep each note in time and let the rests stay silent.'],
    events: [
      notes(...sequence([38, 38, 45, 50], 1)),
      notes(...sequence([38, 45, 38, 50], 1)),
      notes(...sequence([38, 38, 45, 45], 1)),
      notes(...sequence([50, 45, 38, 38], 1)),
    ],
  }),
  exercise({
    id: 'bass-chromatic-approaches', instrument: 'bass', kind: 'course', level: 5, title: 'Approach roots by a half step',
    goal: 'Use short chromatic approach notes to lead into E, A and G.',
    meter, tempo: { start: 52, target: 80 }, bars: 4,
    steps: ['Play F and F♯ before G in the opening phrase.', 'Use G♯ before A in bar 3.', 'Finish on G and keep each approach note short.'],
    events: [
      notes([29, 0, 0.5], [30, 0.5, 0.5], [31, 1, 1], [35, 2, 1], [31, 3, 1]),
      notes([31, 0, 1], [33, 1, 1], [35, 2, 1], [38, 3, 1]),
      notes([32, 0, 0.5], [33, 0.5, 0.5], [36, 1, 1], [40, 2, 1], [36, 3, 1]),
      notes([38, 0, 1], [35, 1, 1], [33, 2, 1], [31, 3, 1]),
    ],
  }),
  exercise({
    id: 'bass-four-bar-question-answer', instrument: 'bass', kind: 'course', level: 5, title: 'Shape a four-bar bass phrase',
    goal: 'Use a repeated two-bar question and a changed two-bar answer.',
    meter, tempo: { start: 52, target: 80 }, bars: 4,
    steps: ['Play the first two bars as the question.', 'Change the last two bars to make the answer.', 'End on E and keep the loop point clear.'],
    events: [
      notes(...sequence([28, 35, 28, 40, 35, 28, 35, 28], 0.5)),
      notes(...sequence([28, 35, 28, 40, 35, 28, 35, 28], 0.5)),
      notes(...sequence([33, 40, 33, 45, 40, 33, 38, 40], 0.5)),
      notes([35, 0, 0.5], [33, 0.5, 0.5], [31, 1, 1], [28, 2.5, 1.5]),
    ],
  }),
]

const GUITAR_INSPIRED: FrettedLesson[] = [
  exercise({
    id: 'guitar-inspired-jimi-hendrix', instrument: 'guitar', kind: 'inspired', artist: 'Jimi Hendrix', level: 1,
    title: 'Syncopated double-stop answers',
    goal: 'Practise original two-note answers that leave space around a syncopated chord pulse.',
    meter, tempo: { start: 56, target: 84 }, bars: 4,
    steps: ['Play each paired note together as a compact double stop.', 'Keep the short answers behind the steady quarter-note pulse.', 'Leave the written gaps quiet; this is an original technique study, not a song transcription.'],
    events: [
      [...chord([55, 62], 0, 1), ...chord([57, 64], 2.5, 0.5)],
      [...chord([59, 65], 0.5, 0.5), ...chord([57, 64], 2, 1)],
      [...chord([55, 62], 0, 1), ...chord([60, 67], 1.5, 0.5), ...chord([57, 64], 3, 0.5)],
      [...chord([59, 65], 0, 0.5), ...chord([57, 64], 2, 1)],
    ],
  }),
  exercise({
    id: 'guitar-inspired-nile-rodgers', instrument: 'guitar', kind: 'inspired', artist: 'Nile Rodgers', level: 1,
    title: 'Clipped offbeat chord cuts',
    goal: 'Build a light, even offbeat strum from short chord stabs and clean rests.',
    meter, tempo: { start: 60, target: 92 }, bars: 4,
    steps: ['Count “1 & 2 & 3 & 4 &” and strike only the written offbeats.', 'Keep each chord short and use a small, relaxed strumming motion.', 'Do not fill the spaces with extra strokes; this is an original rhythm study.'],
    events: Array.from({ length: 4 }, () =>
      [0.5, 1.5, 2.5, 3.5].flatMap((beat, index) => chord([[55, 59, 62], [57, 60, 64], [52, 59, 64], [55, 60, 64]][index], beat, 0.5))),
  }),
  exercise({
    id: 'guitar-inspired-eddie-van-halen', instrument: 'guitar', kind: 'inspired', artist: 'Eddie Van Halen', level: 1,
    title: 'Tapped high-note call and answer',
    goal: 'Alternate a quick high-register tapping figure with a lower-register response.',
    meter, tempo: { start: 52, target: 80 }, bars: 4,
    steps: ['Tap the short upper-register pairs evenly, then answer with the lower notes.', 'Keep each phrase relaxed and separated by its written rest.', 'The pitches form a new exercise and do not reproduce a recorded passage.'],
    events: [
      notes(...sequence([72, 76, 79, 76, 72, 67, 64, 67], 0.5)),
      notes(...sequence([74, 77, 81, 77, 74, 69, 65, 69], 0.5)),
      notes(...sequence([76, 79, 83, 79, 76, 71, 67, 71], 0.5)),
      notes(...sequence([72, 76, 79, 76, 72, 67, 64, 60], 0.5)),
    ],
  }),
  exercise({
    id: 'guitar-inspired-mark-knopfler', instrument: 'guitar', kind: 'inspired', artist: 'Mark Knopfler', level: 1,
    title: 'Alternating bass and picked melody',
    goal: 'Coordinate a steady low-note pulse with a separate, lightly picked upper melody.',
    meter, tempo: { start: 52, target: 78 }, bars: 4,
    steps: ['Play the low note on beats 1 and 3 with the thumb.', 'Use the fingers for the shorter upper answers between those beats.', 'Keep the two parts distinct and let each rest remain silent.'],
    events: [
      notes([43, 0, 1], [60, 1, 0.5], [64, 1.5, 0.5], [47, 2, 1], [62, 3, 0.5], [67, 3.5, 0.5]),
      notes([40, 0, 1], [59, 1, 0.5], [64, 1.5, 0.5], [45, 2, 1], [60, 3, 0.5], [67, 3.5, 0.5]),
      notes([43, 0, 1], [62, 1, 0.5], [67, 1.5, 0.5], [47, 2, 1], [64, 3, 0.5], [69, 3.5, 0.5]),
      notes([40, 0, 1], [59, 1, 0.5], [62, 1.5, 0.5], [43, 2, 1], [60, 3, 1]),
    ],
  }),
  exercise({
    id: 'guitar-inspired-tom-morello', instrument: 'guitar', kind: 'inspired', artist: 'Tom Morello', level: 1,
    title: 'Pedal-tone rhythm breaks',
    goal: 'Keep a repeated low anchor steady while contrasting it with syncopated rests and short answers.',
    meter, tempo: { start: 56, target: 84 }, bars: 4,
    steps: ['Use a firm, even attack for each low anchor note.', 'Make the higher answer notes short and sharply separated.', 'Count through every gap; this original study focuses on rhythmic contrast, not effects.'],
    events: [
      notes([40, 0, 0.5], [40, 1, 0.5], [55, 1.5, 0.5], [40, 2, 1], [59, 3.5, 0.5]),
      notes([40, 0, 0.5], [52, 0.5, 0.5], [40, 2, 0.5], [57, 2.5, 0.5], [40, 3, 0.5]),
      notes([40, 0, 1], [55, 1.5, 0.5], [40, 2, 0.5], [59, 3, 0.5], [40, 3.5, 0.5]),
      notes([40, 0, 0.5], [52, 1, 0.5], [40, 2, 1], [55, 3.5, 0.5]),
    ],
  }),
]

const BASS_INSPIRED: FrettedLesson[] = [
  exercise({
    id: 'bass-inspired-james-jamerson', instrument: 'bass', kind: 'inspired', artist: 'James Jamerson', level: 1,
    title: 'Syncopated roots with chromatic approaches',
    goal: 'Hold a moving root line together with short passing notes that lead into each new harmony.',
    meter, tempo: { start: 52, target: 80 }, bars: 4,
    steps: ['Keep the quarter-note pulse audible under the shorter approach notes.', 'Use the half-step notes as brief links into the next root.', 'Play this original line evenly; it is not a transcription of a recording.'],
    events: [
      notes([28, 0, 1], [35, 1, 0.5], [31, 1.5, 0.5], [33, 2, 1], [35, 3, 0.5], [34, 3.5, 0.5]),
      notes([35, 0, 1], [40, 1, 0.5], [38, 1.5, 0.5], [36, 2, 1], [33, 3, 0.5], [32, 3.5, 0.5]),
      notes([33, 0, 1], [40, 1, 0.5], [38, 1.5, 0.5], [31, 2, 1], [35, 3, 0.5], [34, 3.5, 0.5]),
      notes([35, 0, 1], [33, 1, 1], [31, 2, 1], [28, 3, 1]),
    ],
  }),
  exercise({
    id: 'bass-inspired-bootsy-collins', instrument: 'bass', kind: 'inspired', artist: 'Bootsy Collins', level: 1,
    title: 'Funk syncopation with open space',
    goal: 'Contrast short offbeat notes with rests so the groove has room to breathe.',
    meter, tempo: { start: 56, target: 88 }, bars: 4,
    steps: ['Count sixteenth-note subdivisions while keeping the written eighth-note attacks clear.', 'Shorten each note before a rest; do not sustain across the gap.', 'Keep the accents playful but even in this original funk study.'],
    events: [
      notes([28, 0, 0.5], [35, 1.5, 0.5], [40, 2.5, 0.5], [31, 3.5, 0.5]),
      notes([28, 0, 0.5], [31, 0.5, 0.5], [35, 2, 0.5], [40, 3, 0.5]),
      notes([33, 0, 1], [40, 1.5, 0.5], [38, 2.5, 0.5], [35, 3.5, 0.5]),
      notes([28, 0, 0.5], [35, 1, 0.5], [40, 2, 0.5], [31, 3, 0.5], [28, 3.5, 0.5]),
    ],
  }),
  exercise({
    id: 'bass-inspired-flea', instrument: 'bass', kind: 'inspired', artist: 'Flea', level: 1,
    title: 'Octave jumps over an eighth-note pulse',
    goal: 'Move between a grounded root and its octave while keeping a bright, driving pulse.',
    meter, tempo: { start: 56, target: 84 }, bars: 4,
    steps: ['Keep the eighth-note subdivision even through each register change.', 'Use a firm attack on the octave answer, then return cleanly to the root.', 'Relax the plucking hand as the phrase repeats.'],
    events: [
      notes(...sequence([28, 40, 28, 35, 28, 40, 31, 43], 0.5)),
      notes(...sequence([33, 45, 33, 40, 33, 45, 35, 47], 0.5)),
      notes(...sequence([28, 40, 35, 47, 31, 43, 35, 47], 0.5)),
      notes(...sequence([33, 45, 40, 52, 35, 47, 33, 45], 0.5)),
    ],
  }),
  exercise({
    id: 'bass-inspired-carol-kaye', instrument: 'bass', kind: 'inspired', artist: 'Carol Kaye', level: 1,
    title: 'Steady roots with a singing answer',
    goal: 'Pair a clear quarter-note foundation with a small melodic answer at the end of each bar.',
    meter, tempo: { start: 52, target: 76 }, bars: 4,
    steps: ['Let the first two beats establish the bar before adding the answer.', 'Play the upper notes smoothly, with equal time between them.', 'Return to the next root without rushing the end of the phrase.'],
    events: [
      notes([28, 0, 1], [28, 1, 1], [35, 2, 0.5], [38, 2.5, 0.5], [40, 3, 1]),
      notes([33, 0, 1], [33, 1, 1], [40, 2, 0.5], [43, 2.5, 0.5], [45, 3, 1]),
      notes([31, 0, 1], [31, 1, 1], [38, 2, 0.5], [40, 2.5, 0.5], [43, 3, 1]),
      notes([28, 0, 1], [28, 1, 1], [35, 2, 0.5], [38, 2.5, 0.5], [28, 3, 1]),
    ],
  }),
  exercise({
    id: 'bass-inspired-jaco-pastorius', instrument: 'bass', kind: 'inspired', artist: 'Jaco Pastorius', level: 1,
    title: 'Upper-register melodic contour',
    goal: 'Shape a lyrical bass melody with held tones, short turns and a clear return to the low register.',
    meter, tempo: { start: 50, target: 76 }, bars: 4,
    steps: ['Give the longer notes room to ring without covering the next attack.', 'Keep the short upper-register turns light and connected.', 'Finish with a measured return to the opening pitch.'],
    events: [
      notes([43, 0, 1.5], [47, 1.5, 0.5], [50, 2, 1], [52, 3, 1]),
      notes([55, 0, 1], [52, 1, 0.5], [50, 1.5, 0.5], [47, 2, 1], [45, 3, 1]),
      notes([43, 0, 0.5], [47, 0.5, 0.5], [50, 1, 1], [55, 2, 1.5], [52, 3.5, 0.5]),
      notes([50, 0, 1], [47, 1, 1], [45, 2, 1], [43, 3, 1]),
    ],
  }),
]

type BeatEvent = readonly [beat: number, duration: number]
const rhythm = (...events: BeatEvent[]) => events
type FrettedGenreRecipe = {
  genre: string
  slug: string
  guitarRoot: number
  intervals: number[]
  count: string
  feel: string
  guitarPulse: BeatEvent[]
  bassPulse: BeatEvent[]
  guitarAnswer: BeatEvent[]
  bassAnswer: BeatEvent[]
  target: number
}

const FRETTED_GENRE_RECIPES: FrettedGenreRecipe[] = [
  { genre: 'Rock', slug: 'rock', guitarRoot: 40, intervals: [0, 3, 5, 7, 10], count: 'Count four even quarter-note beats.',
    feel: 'Straight rock pulse', target: 96,
    guitarPulse: rhythm([0, 1], [1, 1], [2, 1], [3, 1]), bassPulse: rhythm([0, 1], [1, 1], [2, 1], [3, 1]),
    guitarAnswer: rhythm([0, 0.5], [0.5, 0.5], [1.5, 0.5], [2, 1], [3, 0.5], [3.5, 0.5]),
    bassAnswer: rhythm([0, 1], [1.5, 0.5], [2, 1], [3, 1]) },
  { genre: 'Blues', slug: 'blues', guitarRoot: 45, intervals: [0, 3, 5, 6, 7, 10], count: 'Count each beat in three triplet slots.',
    feel: 'Long-short blues shuffle',
    guitarPulse: rhythm([0, 2 / 3], [2 / 3, 1 / 3], [1, 2 / 3], [1 + 2 / 3, 1 / 3], [2, 2 / 3], [2 + 2 / 3, 1 / 3], [3, 2 / 3], [3 + 2 / 3, 1 / 3]),
    bassPulse: rhythm([0, 1], [1, 1], [2, 1], [3, 1]),
    guitarAnswer: rhythm([0, 1], [1, 1], [2, 1], [3, 1]),
    bassAnswer: rhythm([0, 0.5], [1, 0.5], [1.5, 0.5], [2, 1], [3, 0.5], [3.5, 0.5]), target: 86 },
  { genre: 'Reggae', slug: 'reggae', guitarRoot: 50, intervals: [0, 2, 3, 5, 7, 10], count: 'Count four beats and keep the offbeat chord hits light.',
    feel: 'Offbeat guitar and a one-drop bass',
    guitarPulse: rhythm([0.5, 0.5], [1.5, 0.5], [2.5, 0.5], [3.5, 0.5]),
    bassPulse: rhythm([2, 1], [3, 1]),
    guitarAnswer: rhythm([0, 0.5], [1.5, 0.5], [2, 1], [3.5, 0.5]),
    bassAnswer: rhythm([0, 1], [1, 1], [2, 1], [3, 1]), target: 92 },
  { genre: 'Pop', slug: 'pop', guitarRoot: 43, intervals: [0, 2, 4, 5, 7, 9, 11], count: 'Count four beats and keep the chord changes clear.',
    feel: 'Open chord changes',
    guitarPulse: rhythm([0, 1], [1.5, 0.5], [2, 1], [3.5, 0.5]),
    bassPulse: rhythm([0, 1], [1, 1], [2, 1], [3, 1]),
    guitarAnswer: rhythm([0, 0.5], [0.5, 0.5], [1.5, 0.5], [2.5, 0.5], [3, 1]),
    bassAnswer: rhythm([0, 1], [1.5, 0.5], [2, 1], [3.5, 0.5]), target: 92 },
  { genre: 'Disco and dance', slug: 'disco-dance', guitarRoot: 45, intervals: [0, 2, 4, 5, 7, 9, 11], count: 'Count the beat and its even eighth-note offbeat.',
    feel: 'Steady dance pulse',
    guitarPulse: rhythm([0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 0.5], [2.5, 0.5], [3, 0.5], [3.5, 0.5]),
    bassPulse: rhythm([0, 0.5], [0.5, 0.5], [1, 1], [2, 0.5], [2.5, 0.5], [3, 1]),
    guitarAnswer: rhythm([0, 1], [1.5, 0.5], [2, 1], [3.5, 0.5]),
    bassAnswer: rhythm([0, 1], [1, 1], [2, 1], [3, 1]), target: 116 },
  { genre: 'Jazz', slug: 'jazz', guitarRoot: 50, intervals: [0, 2, 4, 5, 7, 9, 10], count: 'Count four beats and keep the swing relaxed.',
    feel: 'Swing comping and walking notes',
    guitarPulse: rhythm([0, 1], [1.5, 0.5], [2, 1], [3.5, 0.5]),
    bassPulse: rhythm([0, 1], [1, 1], [2, 1], [3, 1]),
    guitarAnswer: rhythm([0, 2 / 3], [2 / 3, 1 / 3], [1, 1], [2, 2 / 3], [2 + 2 / 3, 1 / 3], [3, 1]),
    bassAnswer: rhythm([0, 0.5], [0.5, 0.5], [1, 1], [2, 0.5], [2.5, 0.5], [3, 1]), target: 108 },
  { genre: 'Latin: bossa nova', slug: 'bossa-nova', guitarRoot: 48, intervals: [0, 2, 4, 5, 7, 9, 11], count: 'Count four even beats through the syncopated notes.',
    feel: 'Syncopated bossa pulse',
    guitarPulse: rhythm([0.5, 0.5], [1.5, 0.5], [2, 1], [3.5, 0.5]),
    bassPulse: rhythm([0, 1.5], [1.5, 0.5], [2.5, 0.5], [3, 1]),
    guitarAnswer: rhythm([0, 0.5], [1, 0.5], [2, 0.5], [2.5, 0.5], [3.5, 0.5]),
    bassAnswer: rhythm([0, 1], [1, 1], [2, 1], [3, 1]), target: 112 },
  { genre: 'Metal', slug: 'metal', guitarRoot: 40, intervals: [0, 2, 3, 5, 7, 8, 10], count: 'Count each beat and keep the pedal note firm.',
    feel: 'Palm-muted pedal-note drive',
    guitarPulse: rhythm([0, 1], [1, 0.5], [1.5, 0.5], [2, 1], [3, 0.5], [3.5, 0.5]),
    bassPulse: rhythm([0, 1], [2, 1], [3, 0.5], [3.5, 0.5]),
    guitarAnswer: rhythm([0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 1], [3, 0.5], [3.5, 0.5]),
    bassAnswer: rhythm([0, 1], [1.5, 0.5], [2, 1], [3, 0.5], [3.5, 0.5]), target: 100 },
  { genre: 'Drum and bass', slug: 'drum-and-bass', guitarRoot: 50, intervals: [0, 2, 3, 5, 7, 8, 10], count: 'Count four beats and leave space around the backbeat.',
    feel: 'Sparse two-step pulse',
    guitarPulse: rhythm([0, 1.5], [2.5, 0.5], [3, 0.5], [3.5, 0.5]),
    bassPulse: rhythm([0, 1.5], [2.5, 0.5], [3, 1]),
    guitarAnswer: rhythm([0, 0.5], [1, 1], [2.5, 0.5], [3, 1]),
    bassAnswer: rhythm([0, 1], [1.5, 0.5], [2, 1], [3.5, 0.5]), target: 132 },
  { genre: 'R&B and soul', slug: 'rnb-soul', guitarRoot: 45, intervals: [0, 2, 4, 5, 7, 9, 11], count: 'Count four slow beats under the held notes.',
    feel: 'Held notes and soft answers',
    guitarPulse: rhythm([0, 1.5], [1.5, 0.5], [2, 2]),
    bassPulse: rhythm([0, 2], [2, 2]),
    guitarAnswer: rhythm([0, 1], [1.5, 0.5], [2, 1], [3, 1]),
    bassAnswer: rhythm([0, 1.5], [1.5, 0.5], [2.5, 1.5]), target: 76 },
  { genre: 'Funk', slug: 'funk', guitarRoot: 40, intervals: [0, 2, 4, 5, 7, 9, 10], count: 'Count four beats and keep the short notes clipped.',
    feel: 'Short syncopated notes',
    guitarPulse: rhythm([0, 0.5], [1, 0.5], [1.5, 0.5], [2.5, 0.5], [3, 0.5], [3.5, 0.5]),
    bassPulse: rhythm([0, 1], [1.5, 0.5], [2, 1], [3.5, 0.5]),
    guitarAnswer: rhythm([0, 0.5], [0.5, 0.5], [1.5, 0.5], [2, 1], [3.5, 0.5]),
    bassAnswer: rhythm([0, 1.5], [2, 0.5], [2.5, 0.5], [3.5, 0.5]), target: 104 },
]

export const FRETTED_GENRES = FRETTED_GENRE_RECIPES.map(({ genre }) => genre)

const scalePitch = (root: number, intervals: number[], degree: number) =>
  root + intervals[degree % intervals.length] + Math.floor(degree / intervals.length) * 12

const genreLesson = (instrument: FrettedInstrument, recipe: FrettedGenreRecipe, level: number): FrettedLesson => {
  const guitar = instrument === 'guitar'
  const root = recipe.guitarRoot - (guitar ? 0 : 12)
  const third = recipe.intervals.findIndex((interval) => interval === 3 || interval === 4)
  const fifth = recipe.intervals.indexOf(7)
  const pulse = guitar ? recipe.guitarPulse : recipe.bassPulse
  const answer = guitar ? recipe.guitarAnswer : recipe.bassAnswer
  const chordRoots = [0, 3, 4, 0]
  const events = Array.from({ length: 4 }, (_, bar) => {
    const beats = level === 1 ? pulse : level === 2 ? answer
      : level === 3 ? (bar % 2 ? pulse : answer)
        : level === 4 ? (bar % 2 ? answer : pulse)
          : (bar < 2 ? pulse : answer)
    const chordRoot = scalePitch(root, recipe.intervals, chordRoots[bar])
    return beats.flatMap(([beat, duration], index) => {
      if (guitar && level === 4) return chord([chordRoot, chordRoot + 7], beat, duration)
      const roles = level === 1 ? [0, fifth, 0, fifth]
        : level === 2 ? [0, third, fifth, third, 0, fifth]
          : level === 3 ? [0, 1, 2, 3, 4, 3, 2, 1]
            : level === 4 ? [chordRoots[bar], chordRoots[bar] + fifth, chordRoots[bar], chordRoots[bar] + fifth]
              : bar < 2 ? [0, fifth, third, fifth, 0] : bar === 2 ? [third, 2, fifth, 3, 2, 1] : [fifth, third, 1, 0]
      const degree = roles[index % roles.length]
      const midi = level === 4
        ? chordRoot + (index % 2 ? 7 : 0)
        : scalePitch(root, recipe.intervals, degree)
      return [[midi, beat, duration, beat % 2 === 0 ? 0.82 : 0.68] as Event]
    })
  })
  const title = level === 1 ? 'Set the pulse' : level === 2 ? 'Add chord tones' : level === 3 ? 'Play a scale answer'
    : level === 4 ? guitar ? 'Play root-fifth shapes' : 'Move through the roots' : 'Shape a four-bar phrase'
  const goal = level === 1
    ? `Keep a steady ${recipe.feel.toLowerCase()} with root notes and a fifth.`
    : level === 2 ? `Add a third and fifth while you keep the ${recipe.genre} rhythm.`
      : level === 3 ? `Use a short scale phrase to answer the ${recipe.genre} pulse.`
        : level === 4 ? guitar ? `Play root-fifth shapes in a four-bar ${recipe.genre} pattern.` : `Change the roots and fifths through a four-bar ${recipe.genre} line.`
          : `Join the ${recipe.genre} groove and a scale answer in one four-bar study.`
  const steps = level === 1
    ? [`${recipe.count}`, 'Play the root and fifth in the written rhythm.', 'Keep each note length as shown.']
    : level === 2 ? [`${recipe.count}`, 'Use the root, third and fifth in the written order.', 'Keep the rhythm steady through each pitch change.']
      : level === 3 ? [`${recipe.count}`, 'Follow the written scale notes as a short answer.', 'Keep the phrase in time before you raise the tempo.']
        : level === 4 ? [`${recipe.count}`, guitar ? 'Play each root-fifth shape together.' : 'Alternate each written root with its fifth.',
          'Change the shape or root at each new bar.']
          : [`${recipe.count}`, 'Use the main pulse in bars 1 and 2.', 'Change to the written answer in bars 3 and 4.']
  const tempoTarget = recipe.target + (level - 1) * 3
  return exercise({
    id: `${instrument}-${recipe.slug}-level-${level}`, instrument, kind: 'genre', genre: recipe.genre, level,
    title: `${recipe.genre}: ${title}`, goal, meter, tempo: { start: tempoTarget - 24, target: tempoTarget },
    bars: 4, steps, events,
  })
}

GUITAR_LESSONS.push(...GUITAR_COURSE_ADDITIONS)
BASS_LESSONS.push(...BASS_COURSE_ADDITIONS)
GUITAR_LESSONS.push(...GUITAR_INSPIRED)
BASS_LESSONS.push(...BASS_INSPIRED)
for (const instrument of ['guitar', 'bass'] as const) {
  const lessons = instrument === 'guitar' ? GUITAR_LESSONS : BASS_LESSONS
  for (const recipe of FRETTED_GENRE_RECIPES)
    for (let level = 1; level <= 5; level++)
      if (!lessons.some((lesson) => lesson.kind === 'genre' && lesson.genre === recipe.genre && lesson.level === level))
        lessons.push(genreLesson(instrument, recipe, level))
}

export const FRETTED_LESSONS = [...GUITAR_LESSONS, ...BASS_LESSONS]
export const FRETTED_LEVELS = ['String and fret basics', 'Open and fretted notes', 'String changes and picking', 'Chords and patterns', 'Phrases and grooves']
export const FRETTED_CONFIG: Record<FrettedInstrument, FrettedInstrumentConfig> = { guitar: GUITAR, bass: BASS }
export const guitarLessonById = (id: string) => GUITAR_LESSONS.find((lesson) => lesson.id === id)
export const bassLessonById = (id: string) => BASS_LESSONS.find((lesson) => lesson.id === id)
const tonalSlug = (name: string) => name[0].toLowerCase() + (name[1] === '#' ? '-sharp' : name[1] === 'b' ? '-flat' : '')
const scaleVariants = [
  { id: 'run', name: 'One-octave run' },
  { id: 'thirds', name: 'Broken thirds' },
  { id: 'sequence', name: 'Three-note sequences' },
] as const
const madeScales = new Map<string, FrettedLesson[]>()

/** The selected scale in an instrument-friendly register; fingering is suggested by pitch, not written. */
export function frettedScaleLessons(instrument: FrettedInstrument, pitch: number, familyId: string): FrettedLesson[] {
  const family = SCALE_FAMILIES.find((item) => item.id === familyId)
  if (!family) return []
  const cacheKey = `${instrument}:${pitch}:${familyId}`
  const cached = madeScales.get(cacheKey)
  if (cached) return cached
  const tonic = scaleTonic(pitch, familyId)
  const root = (instrument === 'guitar' ? 48 : 36) + pitch
  const up = [...family.up.map((step) => root + step), root + 12]
  const downSteps = family.down ?? family.up
  const down = [root + 12, ...downSteps.slice(1).toReversed().map((step) => root + step), root]
  const ascendingDegrees = family.up.map((step) => root + step)
  const ascendingThirds = [...ascendingDegrees, ...ascendingDegrees.slice(0, 2).map((note) => note + 12)]
  const descendingThirds = [
    ...down,
    ...downSteps.slice(1).toReversed().slice(0, 2).map((step) => root + step - 12),
  ]
  const groups = (line: number[], size: number) => {
    const count = Math.min(4, Math.max(0, line.length - size + 1))
    return Array.from({ length: count }, (_, index) =>
      line.slice(Math.floor(index * (line.length - size + 1) / count), Math.floor(index * (line.length - size + 1) / count) + size)).flat()
  }
  const pairBudget = 16
  const upCount = Math.min(family.up.length, pairBudget / 2)
  const downCount = Math.min(family.up.length + 1, pairBudget - upCount)
  const sampledPairs = (line: number[], count: number) => Array.from({ length: count }, (_, index) => {
    const start = count === 1 ? 0 : Math.round(index * (line.length - 3) / (count - 1))
    return [line[start], line[start + 2]]
  })
  const variants = [
    [...up, ...down.slice(1)],
    [...sampledPairs(ascendingThirds, upCount).flat(), ...sampledPairs(descendingThirds, downCount).flat()],
    [...groups(up, 3), ...groups(down, 3).slice(3)],
  ]
  const lessons = scaleVariants.map((variant, index) => {
    const pitches = variants[index]
    return exercise({
      id: `${instrument}-scale-${tonalSlug(tonic)}-${familyId}-${variant.id}`,
      instrument, kind: 'scale', family: familyId, tonic: pitch, variant: variant.id, level: index + 1,
      title: `${tonic} ${family.name}: ${variant.name}`,
      goal: index === 0
        ? `Play the ${tonic} ${family.name.toLowerCase()} scale one octave up and down in the written direction. ${family.note}.`
        : `Practise ${variant.name.toLowerCase()} using notes from the ${tonic} ${family.name.toLowerCase()} scale.`,
      meter, tempo: family.tempo, bars: 4,
      steps: [
        index === 0 ? 'Play each note evenly, ascending to the octave and returning to the tonic.' : `Follow the written ${variant.name.toLowerCase()} pattern; every pitch belongs to the selected scale.`,
        index === 0 && family.down
          ? 'Going up, use the raised sixth and seventh; coming down, use the natural-minor sixth and seventh.'
          : 'Use the suggested tab as a position guide; choose fingering that feels comfortable for your hand.',
        'Play slowly first, then increase the tempo only when the changes stay even.',
      ],
      events: byBar(pitches),
    })
  })
  madeScales.set(cacheKey, lessons)
  return lessons
}

export function frettedLessonById(id: string): FrettedLesson | undefined {
  const lesson = FRETTED_LESSONS.find((item) => item.id === id)
  if (lesson) return lesson
  for (const instrument of ['guitar', 'bass'] as const)
    for (const family of SCALE_FAMILIES)
      for (let pitch = 0; pitch < 12; pitch++) {
        const prefix = `${instrument}-scale-${tonalSlug(scaleTonic(pitch, family.id))}-${family.id}-`
        if (id.startsWith(prefix)) {
          const match = frettedScaleLessons(instrument, pitch, family.id).find((item) => item.id === id)
          if (match) return match
        }
      }
  return undefined
}

export const frettedLessonList = (lesson: FrettedLesson) => {
  if (lesson.kind === 'scale') return frettedScaleLessons(lesson.instrument, lesson.tonic!, lesson.family!)
  const same = FRETTED_LESSONS.filter((item) => item.instrument === lesson.instrument && item.kind === lesson.kind &&
    (item.kind === 'genre' ? item.genre === lesson.genre : item.kind !== 'inspired' || item.artist === lesson.artist))
  return lesson.kind === 'inspired' ? inspiredOrder(same) : same.toSorted((a, b) => a.level - b.level)
}
export const frettedGenres = (_instrument: FrettedInstrument) => [...FRETTED_GENRES]
export const frettedLessonNote = (lesson: FrettedLesson) => {
  const instrument = lesson.instrument === 'guitar' ? 'Guitar' : 'Bass'
  const category = lesson.kind === 'genre' ? `${lesson.genre} study` : lesson.kind === 'inspired' ? `Inspired by ${lesson.artist}`
    : lesson.kind === 'scale' ? `${scaleTonic(lesson.tonic!, lesson.family!)} ${SCALE_FAMILIES.find((family) => family.id === lesson.family)?.name} scale` : 'course'
  return `${instrument} ${category} · Level ${lesson.level}`
}

export function frettedLessonSong(lesson: FrettedLesson): Song {
  const barMap: BarMeter[] = Array.from({ length: lesson.bars }, (_, index) => ({
    startBeat: index * 4, beats: 4, numerator: 4, denominator: 4, status: 'explicit',
  }))
  const high = Array.from({ length: lesson.bars }, () => 'high' as const)
  return {
    title: `Lesson: ${lesson.title}`, source: 'course',
    tracks: [{
      id: lesson.instrument, instrument: 'other', name: lesson.instrument === 'guitar' ? 'Electric guitar' : 'Electric bass',
      detail: 'Original fretted-instrument lesson', gmProgram: lesson.instrument === 'guitar' ? 27 : 33,
    }],
    bpm: lesson.tempo.target, beatsPerBar: 4, beatUnit: 4, barMap, bars: lesson.bars, key: null,
    sections: [{ name: lesson.genre ?? 'Exercise', startBar: 1, bars: lesson.bars }],
    chords: [], piano: [], vocals: [], drums: [], instrumentNotes: { [lesson.instrument]: lesson.notes },
    confidence: { piano: high, drums: high, chords: high, vocals: high, other: high },
  }
}
