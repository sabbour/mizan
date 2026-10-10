import type { BarMeter, DrumHit, DrumLane, Song } from '../workspace/song'
import { backingKey, GENRE_STYLE, genreBacking, type Backing } from './accompaniment'
import { expandGenreLesson, GENRE_LESSONS } from './genres'
import { BASIC_INSERTIONS } from './drumBasics'
import { INSPIRED_LESSONS } from './drumInspired'

/**
 * A built-in, offline drum course. Each lesson is authored as a few bars on a step grid and opens as an ordinary
 * song in the practice workspace, so the score, 3D kit, click, count-in, speed and loop all work as for a recording.
 * Lessons are identified as `course:<id>` and never touch the library, its analyses or its saved songs.
 */

/** Kit voices in the pattern grid, with the GM pitch each one plays. */
const VOICES = {
  hh: { lane: 'hihat', midi: 42 }, // x closed, o open (46), h half-open (authored articulation)
  hp: { lane: 'hihat', midi: 44, foot: true }, // hi-hat pedal
  sn: { lane: 'snare', midi: 38 },
  bd: { lane: 'kick', midi: 36, foot: true },
  rd: { lane: 'ride', midi: 51 },
  cr: { lane: 'crash', midi: 49 },
  // The five-piece kit's toms: tom 1, tom 2 and the floor tom, each with one GM pitch.
  t1: { lane: 'hightom', midi: 50 },
  t2: { lane: 'hightom', midi: 47 },
  f1: { lane: 'floortom', midi: 43 },
} as const satisfies Record<string, { lane: DrumLane; midi: number; foot?: boolean }>
export type Voice = keyof typeof VOICES
export const FOOT_VOICES = (Object.keys(VOICES) as Voice[]).filter((voice) => 'foot' in VOICES[voice])

/** Grid characters: `-` rest, `x` normal, `X` accent, `g` ghost note; on the hi-hat `o`/`O` open and `h` half-open. */
export const VELOCITY: Record<string, number> = { x: 0.7, X: 0.95, g: 0.3, o: 0.7, O: 0.95, h: 0.7 }
/** How the score marks a symbol: ghost notes in parentheses, accents with an accent mark. */
const DYNAMIC: Record<string, 'ghost' | 'accent' | undefined> = { g: 'ghost', X: 'accent', O: 'accent' }

export type LessonBar = {
  /** Grid steps per quarter-note beat: 1 quarters, 2 eighths, 3 eighth triplets, 4 sixteenths. */
  steps: number
  /** What to say aloud, one word per step; rests in parentheses are counted silently. */
  count: string
  /** Hands for each moment a hand plays, in order: R, L, or R+L when both play together. Feet are not listed. */
  sticking?: string
  notes: Partial<Record<Voice, string>>
}

export type Lesson = {
  id: string
  /** The progressive course when absent; otherwise one of the separate style collections. */
  collection?: Collection
  /** For a collection lesson: the drummer, band or genre whose style it practises. The pattern itself is original. */
  style?: string
  /** For a collection lesson: the feel and subdivision that make the style recognisable. */
  feel?: string
  /** The course level; for a collection lesson, the level of the course to complete first (its difficulty). */
  level: number
  title: string
  goal: string
  meter: { numerator: number; denominator: number }
  /** In the counted pulse: quarter notes, or dotted quarters in compound time. */
  tempo: { start: number; target: number }
  /** Who plays what, for grooves where the sticking line would only repeat it. */
  limbs?: string
  steps: string[]
  bars: LessonBar[]
  /** Optional names for consecutive bars, e.g. three groove bars then a fill. */
  sections?: { name: string; bars: number }[]
}

export type Collection = 'inspired' | 'genre'
/** Separate sections beside the progressive course. */
export const COLLECTIONS: Record<Collection, { title: string; intro: string }> = {
  inspired: { title: 'Inspired by great drummers',
    intro: 'Original exercises on a hallmark of a famous drummer or band. They teach a style; they are not transcriptions of any recording.' },
  genre: { title: 'Grooves by genre',
    intro: 'Five lessons per style: an 8-bar basic groove, two 8-bar variations, an 8-bar fill study and a 16-bar performance phrase. Each plays with original bass and chords; mute or turn them down in the track list.' },
}

export const LEVELS = ['Pulse and rests', 'Subdivision', 'Rudiments', 'Grooves', 'Limb independence', 'Fills', 'Meter', 'Advanced']

const ROCK = { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R+L R R R R+L R',
  notes: { hh: 'xxxxxxxx', sn: '--X---X-', bd: 'x---x---' } } satisfies LessonBar
const CRASH_IN = { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R+L R R R R+L R',
  notes: { cr: 'x-------', hh: '-xxxxxxx', sn: '--X---X-', bd: 'x---x---' } } satisfies LessonBar
const SIXTEENS = '1 e & a 2 e & a 3 e & a 4 e & a'
const TRIPLETS = '1 trip let 2 trip let 3 trip let 4 trip let'
/** Six notes per beat (sixteenth-note triplets), counted "1 la li & la li". */
const SEXTUPLETS = '1 la li & la li 2 la li & la li 3 la li & la li 4 la li & la li'
const ALTERNATE = (notes: number) => Array.from({ length: notes }, (_, i) => (i % 2 ? 'L' : 'R')).join(' ')
const twice = (bar: LessonBar) => [bar, bar]

const BASE_LESSONS: Lesson[] = [
  {
    id: 'quarter-pulse', level: 1, title: 'Steady quarter notes', meter: { numerator: 4, denominator: 4 },
    goal: 'Play exactly with the click: one even stroke on every beat, the first one a little stronger.',
    tempo: { start: 60, target: 80 },
    steps: ['Listen to the count-in, then play with the click.', 'Alternate hands, starting with the right.',
      'Count aloud. Your stick should land on the click, not just after it.', 'When eight bars feel easy, raise the speed by 5%.'],
    bars: twice({ steps: 1, count: '1 2 3 4', sticking: 'R L R L', notes: { sn: 'Xxxx' } }),
  },
  {
    id: 'quarter-rests', level: 1, title: 'Quarter notes and rests', meter: { numerator: 4, denominator: 4 },
    goal: 'Feel the silent beats. A rest is still counted and still lasts a full beat.',
    tempo: { start: 60, target: 80 },
    steps: ['Count every beat aloud, and whisper the beats in parentheses.', 'Play every note with the right hand so only the timing changes.',
      'Keep the stick still during rests, close to the head and ready.', 'Loop the four bars until no rest gets shorter.'],
    bars: [
      { steps: 1, count: '1 (2) 3 (4)', sticking: 'R R', notes: { sn: 'x-x-' } },
      { steps: 1, count: '1 2 (3) 4', sticking: 'R R R', notes: { sn: 'xx-x' } },
      { steps: 1, count: '(1) 2 (3) 4', sticking: 'R R', notes: { sn: '-x-x' } },
      { steps: 1, count: '1 (2) (3) 4', sticking: 'R R', notes: { sn: 'x--x' } },
    ],
  },
  {
    id: 'eighths', level: 1, title: 'Eighth notes', meter: { numerator: 4, denominator: 4 },
    goal: 'Split each beat into two equal notes, accenting the beat and keeping the "&" softer.',
    tempo: { start: 70, target: 100 },
    steps: ['Say "1 & 2 & 3 & 4 &" with the click on the numbers.', 'Alternate R L; the right hand always plays the numbers.',
      'Play accents from a higher stick and the "&" from low, without changing the timing.'],
    bars: twice({ steps: 2, count: '1 & 2 & 3 & 4 &', sticking: ALTERNATE(8), notes: { sn: 'XxXxXxXx' } }),
  },
  {
    id: 'sixteenths', level: 2, title: 'Sixteenth notes', meter: { numerator: 4, denominator: 4 },
    goal: 'Four even notes per beat, with a clear accent on each beat and the other three low and even.',
    tempo: { start: 60, target: 80 },
    steps: ['Count "1 e & a" for each beat.', 'Alternate hands; the right hand plays every beat and every "&".',
      'Accent only the beat; play "e & a" from about 3 cm above the head.'],
    bars: twice({ steps: 4, count: SIXTEENS, sticking: ALTERNATE(16), notes: { sn: 'XxxxXxxxXxxxXxxx' } }),
  },
  {
    id: 'triplets', level: 2, title: 'Eighth-note triplets', meter: { numerator: 4, denominator: 4 },
    goal: 'Three equal notes per beat. Alternating hands means each beat starts on the opposite hand.',
    tempo: { start: 60, target: 80 },
    steps: ['Count "1 trip let 2 trip let" so each word is equal.', 'Alternate hands: beat 1 starts R, beat 2 starts L.',
      'Accent each beat so the triplet grouping stays clear.'],
    bars: twice({ steps: 3, count: TRIPLETS, sticking: ALTERNATE(12), notes: { sn: 'XxxXxxXxxXxx' } }),
  },
  {
    id: 'eighths-to-triplets', level: 2, title: 'Switching eighths and triplets', meter: { numerator: 4, denominator: 4 },
    goal: 'Change from two notes per beat to three at the bar line, without the beat moving.',
    tempo: { start: 60, target: 80 },
    steps: ['Bar 1 is eighths, bar 2 is triplets. Say the new count from its first note.',
      'Only the notes between the beats move closer together; the accents stay with the click.',
      'If the change rushes, slow down until the triplet bar sounds even.'],
    bars: [
      { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: ALTERNATE(8), notes: { sn: 'XxXxXxXx' } },
      { steps: 3, count: TRIPLETS, sticking: ALTERNATE(12), notes: { sn: 'XxxXxxXxxXxx' } },
    ],
    sections: [{ name: 'Eighths', bars: 1 }, { name: 'Triplets', bars: 1 }],
  },
  {
    id: 'double-strokes', level: 3, title: 'Double strokes', meter: { numerator: 4, denominator: 4 },
    goal: 'Two even strokes per hand. The second stroke of each pair should be as loud as the first.',
    tempo: { start: 60, target: 80 },
    steps: ['Sticking R R L L throughout.', 'Use the wrist for the first stroke and the fingers for the second.',
      'Listen for even sixteenths at one volume; the pairs should not gallop.'],
    bars: twice({ steps: 4, count: SIXTEENS, sticking: 'R R L L R R L L R R L L R R L L', notes: { sn: 'xxxxxxxxxxxxxxxx' } }),
  },
  {
    id: 'paradiddle', level: 3, title: 'Single paradiddle', meter: { numerator: 4, denominator: 4 },
    goal: 'R L R R, L R L L: singles and doubles combined, with an accent on the first note of each group.',
    tempo: { start: 60, target: 80 },
    steps: ['Say the sticking aloud: "R L R R, L R L L".', 'Accent the first note of each group; it alternates hands.',
      'Play the other three notes low, from about 3 cm above the head.'],
    bars: twice({ steps: 4, count: SIXTEENS, sticking: 'R L R R L R L L R L R R L R L L', notes: { sn: 'XxxxXxxxXxxxXxxx' } }),
  },
  {
    id: 'moving-accents', level: 3, title: 'Moving accents', meter: { numerator: 4, denominator: 4 },
    goal: 'Move one accent through the four sixteenths of the beat while the taps stay low and the hands keep alternating.',
    tempo: { start: 60, target: 80 },
    steps: ['Bar 1 accents "1", bar 2 "e", bar 3 "&", bar 4 "a". Say the accented word louder.',
      'Accents on "e" and "a" fall on the left hand: lift it before the accent, then drop it back low.',
      'Keep the sticking R L R L; only the stick height changes.'],
    bars: [
      { steps: 4, count: SIXTEENS, sticking: ALTERNATE(16), notes: { sn: 'XxxxXxxxXxxxXxxx' } },
      { steps: 4, count: SIXTEENS, sticking: ALTERNATE(16), notes: { sn: 'xXxxxXxxxXxxxXxx' } },
      { steps: 4, count: SIXTEENS, sticking: ALTERNATE(16), notes: { sn: 'xxXxxxXxxxXxxxXx' } },
      { steps: 4, count: SIXTEENS, sticking: ALTERNATE(16), notes: { sn: 'xxxXxxxXxxxXxxxX' } },
    ],
  },
  {
    id: 'hat-and-kick', level: 4, title: 'Hi-hat with kick', meter: { numerator: 4, denominator: 4 },
    goal: 'Keep the right hand steady on eighth notes while the right foot plays beats 1 and 3.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: closed hi-hat · Right foot: kick',
    steps: ['Start with the hi-hat alone for a bar, then add the kick.', 'Hand and foot land together on 1 and 3: listen for one sound.',
      'Keep the hi-hat volume even when the kick joins.'],
    bars: twice({ steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R R R R R R', notes: { hh: 'xxxxxxxx', bd: 'x---x---' } }),
  },
  {
    id: 'rock-beat', level: 4, title: 'Basic rock beat', meter: { numerator: 4, denominator: 4 },
    goal: 'The foundation groove: hi-hat eighths, kick on 1 and 3, a strong snare backbeat on 2 and 4.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Lock in the hi-hat and kick first (previous lesson).', 'Add the snare on 2 and 4 with the left hand, played with a full stroke.',
      'The hi-hat stays even under the snare; do not let it get louder on 2 and 4.'],
    bars: twice(ROCK),
  },
  {
    id: 'kick-syncopation', level: 4, title: 'Kick on the "&"', meter: { numerator: 4, denominator: 4 },
    goal: 'Place the kick between the beats while the hands keep the rock beat steady.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Bar 1 adds the kick on "2 &". Bar 2 moves it to "3 &".', 'Say the count aloud and feel where each kick lands against the hi-hat.',
      'Keep the backbeat exactly on 2 and 4.'],
    bars: [
      { ...ROCK, notes: { ...ROCK.notes, bd: 'x--xx---' } },
      { ...ROCK, notes: { ...ROCK.notes, bd: 'x---xx--' } },
    ],
  },
  {
    id: 'open-hi-hat', level: 4, title: 'Open and close the hi-hat', meter: { numerator: 4, denominator: 4 },
    goal: 'Open the hi-hat on "4 &" and close it with the pedal on 1, inside the rock beat.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick · Left foot: hi-hat pedal',
    steps: ['On "4 &" ease the pressure off the hi-hat pedal with your left foot to open it (circled note).',
      'Press the pedal down on 1 to close it: the closing pedal, the kick and the next hand stroke land together.',
      'Let the open note ring for its full eighth, no longer.'],
    bars: twice({ ...ROCK, notes: { ...ROCK.notes, hh: 'xxxxxxxo', hp: 'x-------' } }),
  },
  {
    id: 'half-open-hi-hat', level: 4, title: 'Half-open hi-hat', meter: { numerator: 4, denominator: 4 },
    goal: 'A "slosh" on "2 &" and "4 &": release the pedal only slightly, then close it again on the next beat.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick · Left foot: hi-hat pedal',
    steps: ['Release a little pedal pressure for each "&" after the backbeat; the cymbals should still touch.',
      'Close the pedal on 1 and 3 together with the kick.',
      'This half-open sound is written into the lesson, not detected.'],
    bars: twice({ ...ROCK, notes: { ...ROCK.notes, hh: 'xxxhxxxh', hp: 'x---x---' } }),
  },
  {
    id: 'kick-under-sixteenths', level: 5, title: 'Sixteenths over a steady kick', meter: { numerator: 4, denominator: 4 },
    goal: 'Keep alternating sixteenths in the hands while the right foot plays every beat.',
    tempo: { start: 60, target: 80 }, limbs: 'Both hands: snare · Right foot: kick',
    steps: ['Play the kick on every beat for a bar before the hands join.', 'The kick and the right hand land together on every beat.',
      'Accent only the beat; the kick should not pull the "e & a" louder.'],
    bars: twice({ steps: 4, count: SIXTEENS, sticking: ALTERNATE(16), notes: { sn: 'XxxxXxxxXxxxXxxx', bd: 'x---x---x---x---' } }),
  },
  {
    id: 'hat-ostinato-kick', level: 5, title: 'Steady hi-hat, moving kick', meter: { numerator: 4, denominator: 4 },
    goal: 'The right hand repeats eighth notes on the hi-hat while the kick changes every bar.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat (never changes) · Right foot: kick',
    steps: ['Play the hi-hat alone until it runs by itself.', 'Each bar moves the kick: 1 and 3; add "2 &"; add 4; then 1, "1 &", 3 and "4 &".',
      'If the hi-hat stumbles when the kick moves, loop that bar slowly.'],
    bars: [
      { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R R R R R R', notes: { hh: 'xxxxxxxx', bd: 'x---x---' } },
      { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R R R R R R', notes: { hh: 'xxxxxxxx', bd: 'x--xx---' } },
      { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R R R R R R', notes: { hh: 'xxxxxxxx', bd: 'x---x-x-' } },
      { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R R R R R R', notes: { hh: 'xxxxxxxx', bd: 'xx--x--x' } },
    ],
  },
  {
    id: 'snare-under-hat', level: 5, title: 'Steady hi-hat, moving snare', meter: { numerator: 4, denominator: 4 },
    goal: 'The right hand keeps eighth notes on the hi-hat while the left hand moves the snare to new places.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat (never changes) · Left hand: snare',
    steps: ['Bar 1 is the backbeat on 2 and 4. Bar 2 adds "4 &"; bar 3 moves beat 2 to "2 &"; bar 4 plays 2, 3 and 4.',
      'Every snare lands together with a hi-hat stroke; listen for one sound, not a flam.',
      'Keep the hi-hat at one volume whatever the left hand does.'],
    bars: [
      { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R+L R R R R+L R', notes: { hh: 'xxxxxxxx', sn: '--X---X-' } },
      { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R+L R R R R+L R+L', notes: { hh: 'xxxxxxxx', sn: '--X---Xx' } },
      { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R R+L R R R+L R', notes: { hh: 'xxxxxxxx', sn: '---X--X-' } },
      { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R+L R R+L R R+L R', notes: { hh: 'xxxxxxxx', sn: '--X-X-X-' } },
    ],
  },
  {
    id: 'pedal-ostinato', level: 5, title: 'Hi-hat foot on every beat', meter: { numerator: 4, denominator: 4 },
    goal: 'The left foot closes the hi-hat on every beat while the hands play ride eighths and a backbeat: a three-limb pattern.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: ride · Left hand: snare · Left foot: hi-hat pedal',
    steps: ['Start with the pedal alone: a short, even "chick" on every beat.', 'Add the ride on eighth notes, then the snare on 2 and 4.',
      'The foot stays on the beat when the snare joins it on 2 and 4.'],
    bars: twice({ steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R+L R R R R+L R', notes: { rd: 'xxxxxxxx', sn: '--X---X-', hp: 'x-x-x-x-' } }),
  },
  {
    id: 'ride-and-hat-foot', level: 5, title: 'Ride with the hi-hat foot', meter: { numerator: 4, denominator: 4 },
    goal: 'A three-limb pattern: ride with the right hand, hi-hat pedal on 2 and 4, a soft kick on 1 and 3.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: ride · Left foot: hi-hat pedal · Right foot: kick (soft)',
    steps: ['Ride: 1, 2, "2 &", 3, 4, "4 &". Play it straight first; it can swing later.',
      'Close the hi-hat with the left foot on 2 and 4: a crisp "chick".', 'Keep the kick very soft on 1 and 3, felt more than heard.'],
    bars: twice({ steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R R R R',
      notes: { rd: 'x-xxx-xx', hp: '--x---x-', bd: 'g---g---' } }),
  },
  {
    id: 'four-limb-groove', level: 5, title: 'Four limbs together', meter: { numerator: 4, denominator: 4 },
    goal: 'A four-limb groove: ride, snare backbeat, kick and hi-hat pedal, with both feet changing in bar 2.',
    tempo: { start: 60, target: 80 }, limbs: 'Right hand: ride · Left hand: snare · Right foot: kick · Left foot: hi-hat pedal',
    steps: ['Bar 1: the pedal plays with the snare on 2 and 4 and the kick plays 1 and 3.',
      'Bar 2: the pedal moves to every "&" and the kick adds "2 &"; the hands do not change.',
      'Add one limb at a time: ride, then snare, then kick, then pedal.'],
    bars: [
      { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R+L R R R R+L R', notes: { rd: 'xxxxxxxx', sn: '--X---X-', bd: 'x---x---', hp: '--x---x-' } },
      { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R+L R R R R+L R', notes: { rd: 'xxxxxxxx', sn: '--X---X-', bd: 'x--xx---', hp: '-x-x-x-x' } },
    ],
  },
  {
    id: 'offbeat-kick', level: 5, title: 'Kick on the "e" and "a"', meter: { numerator: 4, denominator: 4 },
    goal: 'Put the kick on sixteenth offbeats, between hi-hat strokes, while the hands keep the rock beat.',
    tempo: { start: 60, target: 80 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Count sixteenths aloud. Bar 1 adds the kick on "1 a" and "3 a"; bar 2 on "2 e" and "3 a".',
      'Those kicks land alone, between two hi-hat strokes; do not move the hi-hat to meet them.',
      'Keep the backbeat exactly on 2 and 4.'],
    bars: [
      { steps: 4, count: SIXTEENS, sticking: 'R R R+L R R R R+L R',
        notes: { hh: 'x-x-x-x-x-x-x-x-', sn: '----X-------X---', bd: 'x--x----x--x----' } },
      { steps: 4, count: SIXTEENS, sticking: 'R R R+L R R R R+L R',
        notes: { hh: 'x-x-x-x-x-x-x-x-', sn: '----X-------X---', bd: 'x----x--x--x----' } },
    ],
  },
  {
    id: 'hands-and-kick-triplets', level: 5, title: 'Hands and kick in triplets', meter: { numerator: 4, denominator: 4 },
    goal: 'Trade triplets between the limbs: right hand, left hand, kick, one after another with nothing played together.',
    tempo: { start: 60, target: 80 }, limbs: 'Right hand: snare, then floor tom · Left hand: snare · Right foot: kick',
    steps: ['Say "R L K" for each triplet; every beat starts with the right hand.',
      'Bar 2 moves the right hand to the floor tom; the left hand stays on the snare.',
      'The kick is as loud as the hands so the triplet stays even.'],
    bars: [
      { steps: 3, count: TRIPLETS, sticking: ALTERNATE(8), notes: { sn: 'Xx-Xx-Xx-Xx-', bd: '--x--x--x--x' } },
      { steps: 3, count: TRIPLETS, sticking: ALTERNATE(8), notes: { f1: 'X--X--X--X--', sn: '-x--x--x--x-', bd: '--x--x--x--x' } },
    ],
  },
  {
    id: 'snare-fill', level: 6, title: 'Groove, fill, crash', meter: { numerator: 4, denominator: 4 },
    goal: 'Play three bars of groove, a two-beat snare fill, and land on the crash with the kick on the next 1.',
    tempo: { start: 70, target: 100 }, limbs: 'Groove as the rock beat; the fill alternates hands on the snare',
    steps: ['Count the bars aloud: "1 2 3 4, 2 2 3 4, 3 2 3 4, 4 2 fill".', 'Start the fill on beat 3 of bar 4 with the right hand, sixteenths R L R L.',
      'The crash and kick on the next 1 end the fill; do not stop or rush into it.', 'Loop the four bars; bar 1 always begins with the crash.'],
    bars: [CRASH_IN, ROCK, ROCK, { steps: 4, count: SIXTEENS, sticking: 'R R R+L R R L R L R L R L',
      notes: { hh: 'x-x-x-x---------', sn: '----X---xxxxxxxX', bd: 'x---------------' } }],
    sections: [{ name: 'Groove', bars: 3 }, { name: 'Fill', bars: 1 }],
  },
  {
    id: 'tom-fill', level: 6, title: 'Fill around the toms', meter: { numerator: 4, denominator: 4 },
    goal: 'Move the fill from tom 1 to tom 2 and down to the floor tom, then back to the groove with a crash.',
    tempo: { start: 65, target: 100 }, limbs: 'Groove as the rock beat; the fill alternates hands from high to low',
    steps: ['The fill on beats 3 and 4 goes: two notes on tom 1, two on tom 2, then four on the floor tom.',
      'Keep the sticking R L R L as you move: the right hand leads each new drum.',
      'Accent the first note on each new drum so the descent is clear.', 'Land the crash and kick together on the next 1.'],
    bars: [CRASH_IN, ROCK, ROCK, { steps: 4, count: SIXTEENS, sticking: 'R R R+L R R L R L R L R L',
      notes: { hh: 'x-x-x-x---------', sn: '----X-----------', bd: 'x---------------',
        t1: '--------Xx------', t2: '----------Xx----', f1: '------------Xxxx' } }],
    sections: [{ name: 'Groove', bars: 3 }, { name: 'Fill', bars: 1 }],
  },
  {
    id: 'triplet-fill', level: 6, title: 'Triplet fill', meter: { numerator: 4, denominator: 4 },
    goal: 'Three bars of groove, then a triplet fill on beats 3 and 4: snare, then tom 1, into the crash.',
    tempo: { start: 60, target: 80 }, limbs: 'Groove as the rock beat; the fill alternates hands in triplets',
    steps: ['In bar 4 the hi-hat plays only beats 1 and 2, so the triplets have room.',
      'Beat 3 on the snare is R L R; beat 4 on tom 1 is L R L.', 'Accent the first note of each triplet and land the crash on the next 1.'],
    bars: [CRASH_IN, ROCK, ROCK, { steps: 3, count: TRIPLETS, sticking: 'R R+L R L R L R L',
      notes: { hh: 'x--x--------', sn: '---X--Xxx---', t1: '---------Xxx', bd: 'x-----------' } }],
    sections: [{ name: 'Groove', bars: 3 }, { name: 'Fill', bars: 1 }],
  },
  {
    id: 'waltz', level: 7, title: 'Waltz groove in 3/4', meter: { numerator: 3, denominator: 4 },
    goal: 'Three beats per bar: kick on 1, snare on 2 and 3, with the hi-hat on eighth notes.',
    tempo: { start: 84, target: 120 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Count "1 & 2 & 3 &"; the bar has only three beats.', 'Feel beat 1 as the strong one; 2 and 3 answer it.',
      'The click accents each new bar, every three beats.'],
    bars: twice({ steps: 2, count: '1 & 2 & 3 &', sticking: 'R R R+L R R+L R', notes: { hh: 'xxxxxx', sn: '--x-x-', bd: 'x-----' } }),
  },
  {
    id: 'six-eight', level: 7, title: 'Groove in 6/8', meter: { numerator: 6, denominator: 8 },
    goal: 'Six eighth notes in two groups of three: kick on 1, snare on 4, accents on 1 and 4.',
    tempo: { start: 42, target: 60 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Count "1 2 3 4 5 6", accenting 1 and 4.', 'The click plays dotted quarters: on 1 and on 4.',
      'Each group of three should roll like a triplet, not split into two even halves.'],
    bars: twice({ steps: 2, count: '1 2 3 4 5 6', sticking: 'R R R R+L R R', notes: { hh: 'XxxXxx', sn: '---X--', bd: 'x-----' } }),
  },
  {
    id: 'five-four', level: 7, title: 'Groove in 5/4', meter: { numerator: 5, denominator: 4 },
    goal: 'Five beats per bar, felt as 3 + 2: kick on 1 and 4, snare on 3 and 5.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Count "1 & 2 & 3 & 4 & 5 &"; the click accents only beat 1.', 'Think of the bar as a group of three beats, then two.',
      'Do not add a sixth beat before the next 1.'],
    bars: twice({ steps: 2, count: '1 & 2 & 3 & 4 & 5 &', sticking: 'R R R R R+L R R R R+L R',
      notes: { hh: 'xxxxxxxxxx', sn: '----X---X-', bd: 'x-----x---' } }),
  },
  {
    id: 'seven-eight', level: 7, title: 'Groove in 7/8', meter: { numerator: 7, denominator: 8 },
    goal: 'Seven eighth notes grouped 2 + 2 + 3, with hi-hat accents marking each group.',
    tempo: { start: 140, target: 200 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Count "1 2 3 4 5 6 7" and accent 1, 3 and 5.', 'The click plays every eighth note and accents the bar.',
      'The last group is one note longer: let it feel like a small stretch, not a stumble.'],
    bars: twice({ steps: 2, count: '1 2 3 4 5 6 7', sticking: 'R R R+L R R R R', notes: { hh: 'XxXxXxx', sn: '--X----', bd: 'x---x--' } }),
  },
  {
    id: 'accents-and-ghosts', level: 8, title: 'Ghost notes in a groove', meter: { numerator: 4, denominator: 4 },
    goal: 'Contrast a loud backbeat with very soft ghost notes on the snare, at the same tempo.',
    tempo: { start: 60, target: 80 }, limbs: 'Right hand: hi-hat · Left hand: snare (ghosts and backbeat) · Right foot: kick',
    steps: ['Ghost notes are barely audible: drop the stick from about 2 cm.',
      'The backbeat on 2 and 4 is a full stroke from high up.', 'Keep the hi-hat steady and even underneath both.'],
    bars: twice({ steps: 4, count: SIXTEENS, sticking: 'R R L R+L R L R R L R+L R L',
      notes: { hh: 'x-x-x-x-x-x-x-x-', sn: '---gX--g---gX--g', bd: 'x-----x-x-------' } }),
  },
  {
    id: 'paradiddle-groove', level: 8, title: 'Paradiddle groove', meter: { numerator: 4, denominator: 4 },
    goal: 'Turn the paradiddle into a groove: right hand on the hi-hat, left on the snare, accents become the backbeat.',
    tempo: { start: 60, target: 80 }, limbs: 'Right hand: hi-hat · Left hand: snare (ghost notes and backbeat) · Right foot: kick',
    steps: ['Play the paradiddle sticking: R on the hi-hat, L on the snare.', 'The accented L notes on 2 and 4 are the backbeat; the other L notes are ghost notes.',
      'Add the kick on 1 and 3 once the hands feel automatic.'],
    bars: twice({ steps: 4, count: SIXTEENS, sticking: 'R L R R L R L L R L R R L R L L',
      notes: { hh: 'X-xx-x--X-xx-x--', sn: '-g--X-gg-g--X-gg', bd: 'x-------x-------' } }),
  },
  {
    id: 'linear-groove', level: 8, title: 'Sixteenth-note linear groove', meter: { numerator: 4, denominator: 4 },
    goal: 'A linear groove: every sixteenth is played by exactly one limb, never two at once.',
    tempo: { start: 60, target: 80 }, limbs: 'Right hand: hi-hat · Left hand: snare (ghosts and backbeat) · Right foot: kick',
    steps: ['Each beat is four single sounds: beat 1 is kick, hat, ghost, hat; beat 2 is snare, hat, kick, hat.',
      'Say the voices aloud slowly ("K H G H, S H K H") before playing.', 'The ghost notes stay soft so the backbeat still leads.'],
    bars: twice({ steps: 4, count: SIXTEENS, sticking: 'R L R L R R R L R L R R',
      notes: { hh: '-x-x-x-x-x-x-x-x', sn: '--g-X-----g-X---', bd: 'x-----x-x-----x-' } }),
  },
  {
    id: 'displaced-backbeat', level: 8, title: 'Displaced backbeat', meter: { numerator: 4, denominator: 4 },
    goal: 'Move the backbeat one sixteenth late, to "2 e" and "4 e", while the hi-hat and kick stay put.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Bar 1 is the backbeat on 2 and 4; bar 2 moves it to "2 e" and "4 e".',
      'In bar 2 the snare lands alone, between two hi-hat strokes.', 'Count sixteenths aloud; the displaced snare should feel late on purpose, not dragged.'],
    bars: [
      { steps: 4, count: SIXTEENS, sticking: 'R R R+L R R R R+L R',
        notes: { hh: 'x-x-x-x-x-x-x-x-', sn: '----X-------X---', bd: 'x-----x-x-------' } },
      { steps: 4, count: SIXTEENS, sticking: 'R R R L R R R R L R',
        notes: { hh: 'x-x-x-x-x-x-x-x-', sn: '-----X-------X--', bd: 'x-----x-x-------' } },
    ],
  },
  {
    id: 'three-note-accents', level: 8, title: 'Accents in groups of three', meter: { numerator: 4, denominator: 4 },
    goal: 'Accent every third sixteenth (3 + 3 + 3 + 3 + 4) so the accents cross the beat and alternate hands.',
    tempo: { start: 60, target: 80 }, limbs: 'Both hands: snare, alternating',
    steps: ['Count sixteenths aloud and say the accented ones louder: 1, "a", "2 &", "3 e", 4.',
      'The accents fall R, L, R, L, R: lift whichever hand plays next.', 'The last group has four notes so each bar starts again on 1.'],
    bars: twice({ steps: 4, count: SIXTEENS, sticking: ALTERNATE(16), notes: { sn: 'XxxXxxXxxXxxXxxx' } }),
  },
  {
    id: 'paradiddle-tom-fill', level: 8, title: 'Paradiddle around the toms', meter: { numerator: 4, denominator: 4 },
    goal: 'Orchestrate a bar of paradiddles: right-hand notes on the toms, left-hand notes on the snare, back to the crash.',
    tempo: { start: 60, target: 80 }, limbs: 'Right hand: tom 1, then floor tom · Left hand: snare',
    steps: ['The sticking is the paradiddle, R L R R L R L L, twice.', 'Beats 1 and 2 put the right hand on tom 1; beats 3 and 4 on the floor tom.',
      'Accent the first note of each group, then land the crash and kick on the next 1.'],
    bars: [CRASH_IN, { steps: 4, count: SIXTEENS, sticking: 'R L R R L R L L R L R R L R L L',
      notes: { t1: 'X-xx-x----------', f1: '--------X-xx-x--', sn: '-x--X-xx-x--X-xx', bd: 'x---------------' } }],
    sections: [{ name: 'Groove', bars: 1 }, { name: 'Fill', bars: 1 }],
  },
  {
    id: 'sextuplet-fill', level: 8, title: 'Sextuplet fill', meter: { numerator: 4, denominator: 4 },
    goal: 'Six notes per beat: a sextuplet run on the snare, then down the toms, back to the crash.',
    tempo: { start: 56, target: 80 }, limbs: 'Groove for two beats; the fill alternates hands, six notes per beat',
    steps: ['Count "1 la li & la li": the hi-hat plays on 1 and "&" for beats 1 and 2.',
      'Beat 3 is six even notes on the snare, R L R L R L; beat 4 moves in pairs to tom 1, tom 2 and the floor tom.',
      'Accent the first note of each beat and land the crash on the next 1.'],
    bars: [CRASH_IN, { steps: 6, count: SEXTUPLETS, sticking: 'R R R+L R R L R L R L R L R L R L',
      notes: { hh: 'x--x--x--x--------------', sn: '------X-----Xxxxxx------', t1: '------------------Xx----',
        t2: '--------------------Xx--', f1: '----------------------Xx', bd: 'x-----------------------' } }],
    sections: [{ name: 'Groove', bars: 1 }, { name: 'Fill', bars: 1 }],
  },
  {
    id: 'three-over-two', level: 8, title: 'Three against two', meter: { numerator: 4, denominator: 4 },
    goal: 'Hands play triplets while the kick plays eighth notes: three notes against two in every beat.',
    tempo: { start: 42, target: 60 }, limbs: 'Right hand: ride, then both hands: snare · Right foot: kick',
    steps: ['Count "1 la li & la li": the hands play on 1, "li" and the second "la"; the kick on 1 and "&".',
      'The kick\'s "&" falls between the second and third triplet note; say "pass the bread" to feel it.',
      'Bar 1 has the right hand alone on the ride; bar 2 alternates both hands on the snare.'],
    bars: [
      { steps: 6, count: SEXTUPLETS, sticking: 'R R R R R R R R R R R R',
        notes: { rd: 'X-x-x-X-x-x-X-x-x-X-x-x-', bd: 'x--x--x--x--x--x--x--x--' } },
      { steps: 6, count: SEXTUPLETS, sticking: ALTERNATE(12),
        notes: { sn: 'X-x-x-X-x-x-X-x-x-X-x-x-', bd: 'x--x--x--x--x--x--x--x--' } },
    ],
  },
  // Inspired by great drummers: original exercises on a stylistic hallmark, never a transcription of a recording.
  {
    id: 'inspired-reggae-rock-hats', collection: 'inspired', style: 'Inspired by Stewart Copeland (The Police)', feel: 'Straight sixteenths, half-time drop on 3',
    level: 4, title: 'Reggae-rock hi-hat accents', meter: { numerator: 4, denominator: 4 },
    goal: 'Accent the hi-hat on every "&" while the kick and snare drop together on 3 only, then add quick hi-hat pickups.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat · Left hand: snare and hi-hat pickups · Right foot: kick',
    steps: ['Bar 1: hi-hat eighths with the accent on each "&"; kick and snare land together on 3.',
      'Bar 2 adds sixteenth pickups on "2 a" and "4 a" with the left hand on the hi-hat.', 'Nothing on 1: let the space under beat 1 be part of the groove.'],
    bars: [
      { steps: 4, count: SIXTEENS, sticking: 'R R R R R+L R R R',
        notes: { hh: 'x-X-x-X-x-X-x-X-', sn: '--------X-------', bd: '--------x-------' } },
      { steps: 4, count: SIXTEENS, sticking: 'R R R R L R+L R R R L',
        notes: { hh: 'x-X-x-Xxx-X-x-Xx', sn: '--------X-------', bd: '--------x-------' } },
    ],
  },
  {
    id: 'inspired-heavy-triplet-fill', collection: 'inspired', style: 'Inspired by John Bonham (Led Zeppelin)', feel: 'Heavy straight eighths, triplet fill',
    level: 6, title: 'Heavy groove and hands-feet triplet fill', meter: { numerator: 4, denominator: 4 },
    goal: 'A heavy, wide groove, then a fill of triplets traded between the hands on the toms and the kick.',
    tempo: { start: 56, target: 80 }, limbs: 'Right hand: hi-hat, then toms · Left hand: snare, then toms · Right foot: kick',
    steps: ['Bar 1: play the groove big and slightly behind the click; the kick doubles on "2 &" and 3.',
      'Bar 2, beats 3 and 4: R L on tom 1 then kick, R L on the floor tom then kick.', 'Land the crash and kick on the next 1.'],
    bars: [
      { ...CRASH_IN, notes: { ...CRASH_IN.notes, bd: 'x--xx---' } },
      { steps: 3, count: TRIPLETS, sticking: 'R R+L R L R L',
        notes: { hh: 'x--x--------', sn: '---X--------', t1: '------Xx----', f1: '---------Xx-', bd: 'x-------x--x' } },
    ],
    sections: [{ name: 'Groove', bars: 1 }, { name: 'Fill', bars: 1 }],
  },
  {
    id: 'inspired-sparse-fill', collection: 'inspired', style: 'Inspired by Ringo Starr (The Beatles)', feel: 'Straight eighths, loose and sparse',
    level: 6, title: 'Sparse melodic fill', meter: { numerator: 4, denominator: 4 },
    goal: 'Leave space: a fill of only four notes that walks from the snare down the toms and serves the song.',
    tempo: { start: 77, target: 110 }, limbs: 'Right hand: hi-hat, then toms · Left hand: snare, then toms · Right foot: kick',
    steps: ['Bar 2 keeps the hi-hat for beats 1 and 2, then stops.', 'The fill leads with the left hand on the snare on 3: L, R on tom 1, L on tom 2, R on the floor tom.',
      'Play it musically rather than loudly; the crash on the next 1 finishes the phrase.'],
    bars: [CRASH_IN, { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R+L R L R L R',
      notes: { hh: 'xxxx----', sn: '--X-X---', t1: '-----X--', t2: '------X-', f1: '-------X', bd: 'x---x---' } }],
    sections: [{ name: 'Groove', bars: 1 }, { name: 'Fill', bars: 1 }],
  },
  {
    id: 'inspired-tom-orchestration', collection: 'inspired', style: 'Inspired by Neil Peart (Rush)', feel: 'Straight sixteenths, accents in threes',
    level: 6, title: 'Orchestrated tom fill', meter: { numerator: 4, denominator: 4 },
    goal: 'Alternating sixteenths in groups of three, each group on a new drum: snare, tom 1, tom 2, then the floor tom.',
    tempo: { start: 60, target: 80 }, limbs: 'Both hands: snare and toms, alternating · Right foot: kick',
    steps: ['Keep R L R L all through bar 2; only the drums change.', 'Accent the first note of each group; the accents fall R, L, R, L, R.',
      'The floor tom takes the last seven notes; land the crash on the next 1.'],
    bars: [CRASH_IN, { steps: 4, count: SIXTEENS, sticking: ALTERNATE(16),
      notes: { sn: 'Xxx-------------', t1: '---Xxx----------', t2: '------Xxx-------', f1: '---------XxxXxxx', bd: 'x---------------' } }],
    sections: [{ name: 'Groove', bars: 1 }, { name: 'Fill', bars: 1 }],
  },
  {
    id: 'inspired-half-time-shuffle', collection: 'inspired', style: 'Inspired by Jeff Porcaro (Toto)', feel: 'Half-time shuffle in triplets',
    level: 8, title: 'Half-time shuffle with ghost notes', meter: { numerator: 4, denominator: 4 },
    goal: 'A shuffle on the hi-hat with soft ghost notes on the middle triplet and a single backbeat on 3.',
    tempo: { start: 63, target: 90 }, limbs: 'Right hand: hi-hat · Left hand: snare (ghosts and backbeat) · Right foot: kick',
    steps: ['The hi-hat plays the first and last note of each triplet: a shuffle, not straight eighths.',
      'The left hand fills the middle triplet with ghost notes, except on beat 3 where it plays the backbeat.', 'Keep the ghosts barely audible; the shuffle and the backbeat lead.'],
    bars: twice({ steps: 3, count: TRIPLETS, sticking: 'R L R R L R R+L R R L R',
      notes: { hh: 'x-xx-xx-xx-x', sn: '-g--g-X---g-', bd: 'x----x--x---' } }),
  },
  {
    id: 'inspired-funk-syncopation', collection: 'inspired', style: 'Inspired by Clyde Stubblefield (James Brown)', feel: 'Straight sixteenths, syncopated',
    level: 8, title: 'Syncopated funk with ghost notes', meter: { numerator: 4, denominator: 4 },
    goal: 'A funk groove whose ghost notes and off-beat kicks push against a steady hi-hat and a strong 2 and 4.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat · Left hand: snare (ghosts and backbeat) · Right foot: kick',
    steps: ['Kick on 1, "1 &", "3 &" and "4 &"; the left hand ghosts "1 a", "2 a", "3 e" and "4 a".',
      'Learn the hands first, then add the kick one note at a time.', 'Ghosts are tiny; the backbeat is full.'],
    bars: twice({ steps: 4, count: SIXTEENS, sticking: 'R R L R+L R L R L R R+L R L',
      notes: { hh: 'x-x-x-x-x-x-x-x-', sn: '---gX--g-g--X--g', bd: 'x-x-------x---x-' } }),
  },
  {
    id: 'inspired-rudimental-groove', collection: 'inspired', style: 'Inspired by Steve Gadd', feel: 'Straight sixteenths, rudiment split between hi-hat and snare',
    level: 8, title: 'Inverted paradiddle groove', meter: { numerator: 4, denominator: 4 },
    goal: 'Play the inverted paradiddle, R R L R L L R L, with the right hand on the hi-hat and the left on the snare.',
    tempo: { start: 60, target: 80 }, limbs: 'Right hand: hi-hat · Left hand: snare (ghosts and backbeat) · Right foot: kick',
    steps: ['Practise the sticking on the snare alone first.', 'Then move every R to the hi-hat; the accented L notes on 2 and 4 are the backbeat.',
      'The kick plays 1, 3 and "3 &".'],
    bars: twice({ steps: 4, count: SIXTEENS, sticking: 'R R L R L L R L R R L R L L R L',
      notes: { hh: 'xx-x--x-xx-x--x-', sn: '--g-Xg-g--g-Xg-g', bd: 'x-------x-x-----' } }),
  },
  {
    id: 'inspired-odd-meter', collection: 'inspired', style: 'Inspired by Danny Carey (Tool)', feel: '7/8 in sixteenths, grouped 3 + 2 + 2',
    level: 8, title: 'Odd-meter phrase in 7/8', meter: { numerator: 7, denominator: 8 },
    goal: 'Phrase seven eighth notes as 3 + 2 + 2 with the kick on each group, then move the right hand to the floor tom.',
    tempo: { start: 112, target: 160 }, limbs: 'Right hand: hi-hat, then floor tom · Left hand: snare · Right foot: kick',
    steps: ['Count "1 & 2 & 3 & 4 & 5 & 6 & 7 &"; the kick plays 1, 4 and 6, where each group starts.',
      'The snare plays 5 and 7 with a ghost on "2 &".', 'Bar 2 plays the same rhythm with the right hand on the floor tom.'],
    bars: [
      { steps: 4, count: '1 & 2 & 3 & 4 & 5 & 6 & 7 &', sticking: 'R R L R R R+L R R+L',
        notes: { hh: 'X-x-x-X-x-X-x-', sn: '---g----X---X-', bd: 'x-----x---x---' } },
      { steps: 4, count: '1 & 2 & 3 & 4 & 5 & 6 & 7 &', sticking: 'R R L R R R+L R R+L',
        notes: { f1: 'X-x-x-X-x-X-x-', sn: '---g----X---X-', bd: 'x-----x---x---' } },
    ],
  },
  // Grooves by genre: what makes each style recognisable, in one short loop.
  {
    id: 'genre-rock', collection: 'genre', style: 'Rock', feel: 'Straight eighths',
    level: 4, title: 'Rock on the ride', meter: { numerator: 4, denominator: 4 },
    goal: 'Driving rock: accented ride eighths, a big backbeat and a kick that pushes into beat 3.',
    tempo: { start: 77, target: 110 }, limbs: 'Right hand: ride · Left hand: snare · Right foot: kick',
    steps: ['Accent the ride on the beats; the "&" is lighter.', 'Kick on 1, "1 &" and "2 &": the "2 &" pushes into beat 3.', 'Every backbeat is a full stroke.'],
    bars: twice({ steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R+L R R R R+L R', notes: { rd: 'XxXxXxXx', sn: '--X---X-', bd: 'xx-x----' } }),
  },
  {
    id: 'genre-blues-shuffle', collection: 'genre', style: 'Blues', feel: 'Shuffle: swung eighths in triplets',
    level: 4, title: 'Blues shuffle', meter: { numerator: 4, denominator: 4 },
    goal: 'The shuffle: long-short eighths played as the first and last note of a triplet, with the backbeat on 2 and 4.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Say "1 trip let" and play only "1" and "let" on the hi-hat.', 'The snare on 2 and 4 lands with the hi-hat.', 'Kick on 1 and 3; keep the shuffle lazy but in time.'],
    bars: twice({ steps: 3, count: TRIPLETS, sticking: 'R R R+L R R R R+L R', notes: { hh: 'x-xx-xx-xx-x', sn: '---X-----X--', bd: 'x-----x-----' } }),
  },
  {
    id: 'genre-reggae', collection: 'genre', style: 'Reggae', feel: 'One drop: swung eighths in triplets',
    level: 4, title: 'Reggae one drop', meter: { numerator: 4, denominator: 4 },
    goal: 'The one drop: nothing on beat 1, kick and snare together only on 3, over a swung hi-hat.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['The hi-hat swings like the shuffle: "1" and "let" of each beat.', 'Kick and snare together on 3, and nowhere else.', 'Play the snare softly, close to the rim.'],
    bars: twice({ steps: 3, count: TRIPLETS, sticking: 'R R R R R+L R R R', notes: { hh: 'x-xx-xx-xx-x', sn: '------x-----', bd: '------x-----' } }),
  },
  {
    id: 'genre-pop', collection: 'genre', style: 'Pop', feel: 'Straight sixteenths, both hands on the hi-hat',
    level: 5, title: 'Two-handed sixteenth pop groove', meter: { numerator: 4, denominator: 4 },
    goal: 'Even sixteenths on the hi-hat with both hands; the right hand leaves the hi-hat for the backbeat.',
    tempo: { start: 63, target: 90 }, limbs: 'Both hands: hi-hat, the right hand also plays the snare · Right foot: kick',
    steps: ['Alternate R L on the hi-hat; on 2 and 4 the right hand plays the snare instead.', 'Accent each beat on the hi-hat.', 'Kick on 1, "2 a" and 3.'],
    bars: twice({ steps: 4, count: SIXTEENS, sticking: ALTERNATE(16), notes: { hh: 'Xxxx-xxxXxxx-xxx', sn: '----X-------X---', bd: 'x------xx-------' } }),
  },
  {
    id: 'genre-disco', collection: 'genre', style: 'Disco and dance', feel: 'Straight eighths, four on the floor',
    level: 5, title: 'Disco four on the floor', meter: { numerator: 4, denominator: 4 },
    goal: 'A kick on every beat, the hi-hat opening on every "&" and closing with the pedal on the beat: a four-limb pattern.',
    tempo: { start: 84, target: 120 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick · Left foot: hi-hat pedal',
    steps: ['Kick and hi-hat pedal both play every beat.', 'Lift the pedal for each "&" so the hi-hat opens, and close it on the next beat.', 'Snare on 2 and 4.'],
    bars: twice({ steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R+L R R R R+L R', notes: { hh: 'xoxoxoxo', sn: '--X---X-', bd: 'x-x-x-x-', hp: 'x-x-x-x-' } }),
  },
  {
    id: 'genre-jazz-swing', collection: 'genre', style: 'Jazz', feel: 'Swing: ride in triplets',
    level: 5, title: 'Jazz swing ride pattern', meter: { numerator: 4, denominator: 4 },
    goal: 'The swing ride, "ding, ding-a ding, ding-a", with the hi-hat foot on 2 and 4 and a feathered kick.',
    tempo: { start: 84, target: 120 }, limbs: 'Right hand: ride · Left hand: snare (comping) · Right foot: kick (feathered) · Left foot: hi-hat pedal',
    steps: ['Ride on 1, 2, "2 let", 3, 4, "4 let", accenting 2 and 4.', 'The hi-hat pedal closes on 2 and 4; the kick is barely heard on every beat.',
      'The left hand adds one soft comping note on "3 let".'],
    bars: twice({ steps: 3, count: TRIPLETS, sticking: 'R R R R L R R', notes: { rd: 'x--X-xx--X-x', sn: '--------g---', hp: '---x-----x--', bd: 'g--g--g--g--' } }),
  },
  {
    id: 'genre-bossa-nova', collection: 'genre', style: 'Latin: bossa nova', feel: 'Straight eighths, two-bar pattern',
    level: 5, title: 'Bossa nova', meter: { numerator: 4, denominator: 4 },
    goal: 'Ride eighths over the bossa kick, with a two-bar figure on the snare where a cross-stick would go.',
    tempo: { start: 98, target: 140 }, limbs: 'Right hand: ride · Left hand: snare · Right foot: kick · Left foot: hi-hat pedal',
    steps: ['Kick on 1, "2 &", 3 and "4 &" in both bars; the hi-hat pedal on 2 and 4.',
      'Left hand: bar 1 plays 1, "2 &" and 4; bar 2 plays 2 and "3 &".', 'Play the snare softly; it stands in for a cross-stick.'],
    bars: [
      { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R+L R R R+L R R R+L R', notes: { rd: 'xxxxxxxx', sn: 'x--x--x-', bd: 'x--xx--x', hp: '--x---x-' } },
      { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R+L R R R+L R R', notes: { rd: 'xxxxxxxx', sn: '--x--x--', bd: 'x--xx--x', hp: '--x---x-' } },
    ],
  },
  {
    id: 'genre-metal', collection: 'genre', style: 'Metal', feel: 'Sixteenth-note gallop on one kick',
    level: 5, title: 'Metal gallop', meter: { numerator: 4, denominator: 4 },
    goal: 'A gallop on a single kick, "1 & a", under crash quarter notes and a heavy backbeat.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: crash · Left hand: snare · Right foot: kick',
    steps: ['The kick plays "1, & a" in every beat: one long, two short.', 'Crash on every beat; snare with the crash on 2 and 4.', 'Keep the gallop even before raising the speed.'],
    bars: twice({ steps: 4, count: SIXTEENS, sticking: 'R R+L R R+L', notes: { cr: 'x---x---x---x---', sn: '----X-------X---', bd: 'x-xxx-xxx-xxx-xx' } }),
  },
  {
    id: 'genre-drum-and-bass', collection: 'genre', style: 'Drum and bass', feel: 'Straight sixteenths, two-step',
    level: 6, title: 'Drum and bass two-step', meter: { numerator: 4, denominator: 4 },
    goal: 'The two-step: kick on 1 and "3 &", snare on 2 and 4, a ghost note on "4 a" leading back to 1.',
    tempo: { start: 119, target: 170 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Learn it slowly; the target tempo is fast.', 'Kick on 1 and "3 &" only; the gap makes the two-step.', 'The ghost on "4 a" is soft and leads into the next 1.'],
    bars: twice({ steps: 4, count: SIXTEENS, sticking: 'R R R+L R R R R+L R L', notes: { hh: 'x-x-x-x-x-x-x-x-', sn: '----X-------X--g', bd: 'x---------x-----' } }),
  },
  {
    id: 'genre-soul-ballad', collection: 'genre', style: 'R&B and soul', feel: '12/8: four beats of three eighths',
    level: 7, title: 'Soul ballad in 12/8', meter: { numerator: 12, denominator: 8 },
    goal: 'The slow 12/8 ballad: twelve even eighths on the hi-hat, backbeat on beats 2 and 4 (eighths 4 and 10).',
    tempo: { start: 42, target: 60 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Count "1 2 3 4 5 6 7 8 9 10 11 12"; the click plays every dotted quarter.', 'Kick on 1, 6 and 7; snare on 4 and 10.', 'Let every group of three roll evenly.'],
    bars: twice({ steps: 2, count: '1 2 3 4 5 6 7 8 9 10 11 12', sticking: 'R R R R+L R R R R R R+L R R',
      notes: { hh: 'xxxxxxxxxxxx', sn: '---X-----X--', bd: 'x----xx-----' } }),
  },
  {
    id: 'genre-funk', collection: 'genre', style: 'Funk', feel: 'Straight sixteenths with open hi-hat',
    level: 8, title: 'Funk with an open hi-hat', meter: { numerator: 4, denominator: 4 },
    goal: 'Ghost notes between hi-hat eighths and an open hi-hat on "2 &" and "4 &", closed by the pedal on the next beat.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick · Left foot: hi-hat pedal',
    steps: ['Open the hi-hat on "2 &" and "4 &"; close it with the pedal on 3 and 1.', 'Ghost notes on "1 e", "2 a" and "3 e" are very soft.', 'Kick on 1, "1 a", 3 and "3 &".'],
    bars: twice({ steps: 4, count: SIXTEENS, sticking: 'R L R R+L R L R L R R+L R',
      notes: { hh: 'x-x-x-o-x-x-x-o-', sn: '-g--X--g-g--X---', bd: 'x--x----x-x-----', hp: 'x-------x-------' } }),
  },
]

/** The course, then each collection; additions follow their prerequisites, and genre studies follow their basics. */
export const LESSONS: Lesson[] = BASE_LESSONS.flatMap((lesson) => {
  if (lesson.collection === 'genre')
    return [expandGenreLesson(lesson, 0), ...GENRE_LESSONS[lesson.id].map((item, index) => expandGenreLesson(item, index + 1))]
  const additions = BASIC_INSERTIONS[lesson.id] ?? []
  const inspired = lesson.id === 'inspired-odd-meter' ? INSPIRED_LESSONS : []
  return [lesson, ...additions, ...inspired]
})

/** What each of a genre's five lessons teaches, in order. */
export const GENRE_STAGES = ['Basic groove', 'Variation', 'Variation', 'Fill', 'Sixteen-bar phrase']

/** A genre's lessons, in order. */
export const genreLessons = (style: string) => LESSONS.filter((lesson) => lesson.collection === 'genre' && lesson.style === style)

/** Each genre with its lessons, in course order. */
export const genres = () => [...new Set(lessonList({ collection: 'genre' }).map((lesson) => lesson.style!))]
  .map((style) => ({ style, lessons: genreLessons(style) }))

/** Where a genre lesson sits among its genre's five, and what that step teaches. */
export function lessonStage(lesson: Lesson): { index: number; of: number; name: string } | null {
  if (lesson.collection !== 'genre') return null
  const lessons = genreLessons(lesson.style!)
  const index = lessons.indexOf(lesson)
  return { index, of: lessons.length, name: GENRE_STAGES[index] }
}

export const lessonById = (id: string) => LESSONS.find((lesson) => lesson.id === id)

/** The lessons in the same list as this one: the progressive course or one collection, in order. */
export const lessonList = (lesson: Pick<Lesson, 'collection'>) => LESSONS.filter((item) => item.collection === lesson.collection)

/** The workspace subtitle for a lesson: where it sits in the course or its collection. */
export const lessonNote = (lesson: Lesson) => {
  const list = lessonList(lesson)
  const where = `${list.indexOf(lesson) + 1} of ${list.length}`
  const stage = lessonStage(lesson)
  if (stage) return `${COLLECTIONS.genre.title} · ${lesson.style} · ${stage.name}, ${stage.index + 1} of ${stage.of} · Level ${lesson.level}`
  return lesson.collection
    ? `${COLLECTIONS[lesson.collection].title} · ${lesson.style} · Level ${lesson.level} · ${where}`
    : `Drum course · Level ${lesson.level} · ${where}`
}

/** Quarter-note beats per bar, and the counted pulse in quarter notes (a dotted quarter in compound time). */
export function lessonMeter(lesson: Pick<Lesson, 'meter'>) {
  const { numerator, denominator } = lesson.meter
  const compound = denominator === 8 && numerator % 3 === 0 && numerator >= 6
  return { beatsPerBar: numerator * 4 / denominator, pulse: compound ? 1.5 : 4 / denominator, compound }
}

/** Cymbal voices: when both hands play together, the right hand takes the cymbal. */
const CYMBAL_VOICES: Voice[] = ['hh', 'rd', 'cr']
/** Drum voices from the player's left to right, for two drums struck together. */
const DRUM_ORDER: Voice[] = ['sn', 't1', 't2', 'f1']

/**
 * The hand for each hand voice at each step of a bar, read from its sticking line: one token per moment a hand
 * plays, in order. R+L names both hands; the right takes the cymbal, or the drum further right when both are drums.
 * Feet never get a hand. A sticking line that does not match the notes is an authoring error.
 */
function barHands(bar: LessonBar, where: string): Map<string, 'left' | 'right'> {
  const hands = new Map<string, 'left' | 'right'>()
  if (!bar.sticking) return hands
  const tokens = bar.sticking.split(' ')
  const length = Math.max(...Object.values(bar.notes).map((pattern) => pattern.length))
  let next = 0
  for (let step = 0; step < length; step++) {
    const voices = (Object.keys(bar.notes) as Voice[]).filter((voice) => !FOOT_VOICES.includes(voice) && (bar.notes[voice]![step] ?? '-') !== '-')
    if (!voices.length) continue
    const token = tokens[next++]
    if (token === 'R' || token === 'L') {
      if (voices.length !== 1) throw new Error(`${where}: step ${step + 1} has ${voices.length} hand notes but sticking ${token}`)
      hands.set(`${voices[0]}:${step}`, token === 'R' ? 'right' : 'left')
    } else if (token === 'R+L' && voices.length === 2) {
      const cymbals = voices.filter((voice) => CYMBAL_VOICES.includes(voice))
      const order = (voice: Voice) => DRUM_ORDER.indexOf(voice)
      const right = cymbals.length === 1 ? cymbals[0] : !cymbals.length && order(voices[0]) !== order(voices[1])
        ? voices.reduce((a, b) => order(a) > order(b) ? a : b) : null
      if (!right) throw new Error(`${where}: step ${step + 1} cannot split R+L between ${voices.join(' and ')}`)
      for (const voice of voices) hands.set(`${voice}:${step}`, voice === right ? 'right' : 'left')
    } else throw new Error(`${where}: sticking "${token ?? '(missing)'}" does not match ${voices.length} hand notes at step ${step + 1}`)
  }
  if (next !== tokens.length) throw new Error(`${where}: sticking has ${tokens.length} strokes for ${next} hand moments`)
  return hands
}

/** Every hit a lesson plays, in time order, with the authored hand for every hand stroke. */
export function lessonHits(lesson: Lesson): DrumHit[] {
  const { beatsPerBar } = lessonMeter(lesson)
  const hits: DrumHit[] = []
  lesson.bars.forEach((bar, index) => {
    const start = index * beatsPerBar
    const hands = barHands(bar, `${lesson.id} bar ${index + 1}`)
    for (const [voice, pattern] of Object.entries(bar.notes) as [Voice, string][]) {
      const kit = VOICES[voice]
      ;[...pattern].forEach((symbol, step) => {
        if (symbol === '-') return
        const startBeat = start + step / bar.steps
        const velocity = VELOCITY[symbol]
        const hand = hands.get(`${voice}:${step}`)
        const handed = { ...(hand ? { hand } : {}), ...(DYNAMIC[symbol] ? { dynamic: DYNAMIC[symbol] } : {}) }
        if (voice === 'hh' && 'oOh'.includes(symbol)) {
          hits.push({ trackId: 'drums', lane: 'openhat', startBeat, velocity, sourceMidi: 46,
            ...(symbol === 'h' ? { articulation: 'half-open' as const } : {}), ...handed })
        } else hits.push({ trackId: 'drums', lane: kit.lane, startBeat, velocity, sourceMidi: kit.midi, ...handed })
      })
    }
  })
  return hits.sort((a, b) => a.startBeat - b.startBeat)
}

/** The original bass and chord backing of a genre lesson; other lessons have none. */
export function lessonBacking(lesson: Lesson): Backing | null {
  if (lesson.collection !== 'genre') return null
  const style = GENRE_STYLE[lesson.style!]
  if (!style) throw new Error(`${lesson.id}: no backing for the ${lesson.style} genre`)
  const fills: boolean[] = []
  for (const { name, bars } of lesson.sections ?? [{ name: 'Groove', bars: lesson.bars.length }])
    for (let bar = 0; bar < bars; bar++) fills.push(name === 'Fill')
  return genreBacking(style, lesson.bars.length, lessonMeter(lesson).beatsPerBar, fills)
}

/** The lesson as a song for the practice workspace: the authored drum track and, for a genre, its backing; no recording, nothing analysed. */
export function lessonSong(lesson: Lesson): Song {
  const { beatsPerBar, pulse } = lessonMeter(lesson)
  const bars = lesson.bars.length
  const backing = lessonBacking(lesson)
  const barMap: BarMeter[] = lesson.bars.map((_, index) => ({
    startBeat: index * beatsPerBar, beats: beatsPerBar, numerator: lesson.meter.numerator,
    denominator: lesson.meter.denominator, status: 'explicit',
  }))
  let startBar = 1
  const sections = (lesson.sections ?? [{ name: 'Exercise', bars }]).map(({ name, bars: length }) => {
    const section = { name, startBar, bars: length }
    startBar += length
    return section
  })
  const high = Array.from({ length: bars }, () => 'high' as const)
  return {
    title: lesson.collection ? lesson.title : `Lesson ${lessonList(lesson).indexOf(lesson) + 1}: ${lesson.title}`,
    source: 'course',
    tracks: [{ id: 'drums', instrument: 'drums', name: 'Drum kit', detail: lesson.collection
      ? 'Original practice pattern in this style (authored, not transcribed)' : 'Lesson pattern (authored, not transcribed)' },
    ...backing?.tracks ?? []],
    bpm: lesson.tempo.target * pulse,
    beatsPerBar,
    beatUnit: lesson.meter.denominator,
    barMap,
    bars,
    key: backing ? backingKey(backing.style) : null,
    sections,
    chords: [],
    piano: [],
    vocals: [],
    drums: lessonHits(lesson),
    ...backing ? { instrumentNotes: backing.notes } : {},
    confidence: { piano: high, drums: high, chords: high, vocals: high, ...backing ? { other: high } : {} },
  }
}
