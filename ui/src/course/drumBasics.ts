import type { Lesson, LessonBar, Voice } from './curriculum'

const meter = { numerator: 4, denominator: 4 }
const eighthCount = '1 & 2 & 3 & 4 &'
const sixteenthCount = '1 e & a 2 e & a 3 e & a 4 e & a'
const feet: Voice[] = ['bd', 'hp']
const cymbals: Voice[] = ['hh', 'rd', 'cr']

function bar(steps: number, count: string, notes: LessonBar['notes'], alternating = false, sticking?: string): LessonBar {
  if (sticking) return { steps, count, notes, sticking }
  const length = Math.max(...Object.values(notes).map((pattern) => pattern.length))
  let next = 0
  const strokes: string[] = []
  for (let step = 0; step < length; step++) {
    const hands = (Object.keys(notes) as Voice[]).filter((voice) => !feet.includes(voice) && (notes[voice]![step] ?? '-') !== '-')
    if (hands.length === 2) strokes.push('R+L')
    else if (hands.length === 1) strokes.push(alternating
      ? next++ % 2 ? 'L' : 'R'
      : cymbals.includes(hands[0]) ? 'R' : 'L')
  }
  return { steps, count, notes, sticking: strokes.join(' ') }
}

const eight = (notes: LessonBar['notes'], alternating = false) => bar(2, eighthCount, notes, alternating)
const sixteen = (notes: LessonBar['notes'], sticking?: string) => sticking === alternate
  ? bar(4, sixteenthCount, notes, true)
  : bar(4, sixteenthCount, notes, false, sticking)
const doubles = 'R R L L R R L L R R L L R R L L'
const paradiddle = 'R L R R L R L L R L R R L R L L'
const alternate = 'R L R L R L R L R L R L R L R L'

const lessons: Lesson[] = [
  {
    id: 'basics-single-accent-control', level: 2, title: 'Single strokes and accents', meter,
    goal: 'Build even alternating singles, then place accents without changing the eighth-note pulse.',
    tempo: { start: 60, target: 80 }, limbs: 'Both hands: snare, alternating',
    steps: ['Play R L on every eighth and keep each pair even.', 'Move the accent from the number to the "&" without changing the sticking.',
      'Keep the unaccented strokes low and relaxed.'],
    bars: [
      eight({ sn: 'xxxxxxxx' }, true),
      eight({ sn: 'XxXxXxXx' }, true),
      eight({ sn: 'xXxXxXxX' }, true),
      eight({ sn: 'XXxxXXxx' }, true),
    ],
  },
  {
    id: 'basics-eighth-rests', level: 2, title: 'Eighth-note rests', meter,
    goal: 'Keep counting even when a subdivision is silent; return on time without rushing the space.',
    tempo: { start: 60, target: 80 }, limbs: 'Both hands: snare, alternating',
    steps: ['Count every eighth aloud, including the silent "&" positions.', 'Alternate R L only on the notes that sound.',
      'Keep the empty subdivision the same length as a played note.'],
    bars: [
      eight({ sn: 'x-x-x-x-' }, true),
      eight({ sn: 'xx--xx--' }, true),
      eight({ sn: '-x-x-x-x' }, true),
      eight({ sn: 'x--xx-x-' }, true),
    ],
  },
  {
    id: 'basics-sixteenth-rests', level: 2, title: 'Sixteenth-note rests', meter,
    goal: 'Place short rests inside sixteenth-note groups while the quarter-note pulse stays steady.',
    tempo: { start: 56, target: 80 }, limbs: 'Both hands: snare, alternating',
    steps: ['Say "1 e & a" continuously, even when the snare is silent.', 'Alternate hands on each note that sounds.',
      'Start slowly and make every gap exactly one sixteenth long.'],
    bars: [
      sixteen({ sn: 'x-x-x-x-x-x-x-x-' }, alternate),
      sixteen({ sn: 'x--xx--xx--xx--x' }, alternate),
      sixteen({ sn: 'xx-xx-xx-xx-xx-x' }, alternate),
      sixteen({ sn: 'x-x--xx-x-x--xx-' }, alternate),
    ],
  },
  {
    id: 'basics-subdivision-rests', level: 2, title: 'Subdivision changes with rests', meter,
    goal: 'Switch between eighths and sixteenths without changing the beat, and keep silent steps in time.',
    tempo: { start: 56, target: 80 }, limbs: 'Both hands: snare, alternating',
    steps: ['Bars 1–2 use eighth-note spaces; bars 3–4 use sixteenth-note spaces.', 'Count every rest and begin each new subdivision on beat 1.',
      'Keep the accents with the quarter-note pulse.'],
    bars: [
      eight({ sn: 'x-x-xx-x' }, true),
      eight({ sn: 'xx-x--x-' }, true),
      sixteen({ sn: 'X-x-xx--X-x-xx--' }, alternate),
      sixteen({ sn: 'X--xx-x-X--xx-x-' }, alternate),
    ],
  },
  {
    id: 'basics-double-accent-control', level: 3, title: 'Accents in double strokes', meter,
    goal: 'Keep R R L L doubles even while moving the accent from the first stroke to the second.',
    tempo: { start: 56, target: 80 }, limbs: 'Both hands: snare, double strokes',
    steps: ['Say and play R R L L through each sixteenth-note bar.', 'Accent the first stroke of each pair, then move the accent to its partner.',
      'Do not let the second stroke of either double drop behind.'],
    bars: [
      sixteen({ sn: 'XxxxXxxxXxxxXxxx' }, doubles),
      sixteen({ sn: 'xXxx xXxx xXxx xXxx'.replaceAll(' ', '') }, doubles),
      sixteen({ sn: 'XXxxXXxxXXxxXXxx' }, doubles),
      sixteen({ sn: 'xxXXxxXXxxXXxxXX' }, doubles),
    ],
  },
  {
    id: 'basics-paradiddle-dynamics', level: 3, title: 'Paradiddle accents and taps', meter,
    goal: 'Play R L R R, L R L L with a clear accent at the start of each four-note group.',
    tempo: { start: 56, target: 80 }, limbs: 'Both hands: snare, paradiddle sticking',
    steps: ['Speak the sticking as you play: R L R R, L R L L.', 'Accent the first note of each group and keep the other taps low.',
      'Keep the repeated-hand doubles even and relaxed.'],
    bars: [
      sixteen({ sn: 'XxxxXxxxXxxxXxxx' }, paradiddle),
      sixteen({ sn: 'xXxx xXxx xXxx xXxx'.replaceAll(' ', '') }, paradiddle),
      sixteen({ sn: 'XxxxXxxxXxxxXxxx' }, 'L R L L R L R R L R L L R L R R'),
      sixteen({ sn: 'xXxx xXxx xXxx xXxx'.replaceAll(' ', '') }, 'L R L L R L R R L R L L R L R R'),
    ],
  },
  {
    id: 'basics-three-limb-moving-kick', level: 5, title: 'Steady hand, moving kick and snare', meter,
    goal: 'Hold an unchanged right-hand eighth-note ostinato while the kick and snare move to new placements.',
    tempo: { start: 63, target: 90 }, limbs: 'Right hand: closed hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Keep the right hand on every hi-hat eighth; it never changes.', 'Move the kick and snare together only when their written pattern changes.',
      'Count the offbeats aloud so the feet do not pull the hand forward.'],
    bars: [
      eight({ hh: 'xxxxxxxx', sn: '--X---X-', bd: 'x---x---' }),
      eight({ hh: 'xxxxxxxx', sn: '----X---', bd: 'x--x-x--' }),
      eight({ hh: 'xxxxxxxx', sn: '--X-X---', bd: 'x-----x-' }),
      eight({ hh: 'xxxxxxxx', sn: '---X---X', bd: 'x--xx---' }),
    ],
  },
  {
    id: 'basics-four-limb-moving-hand', level: 5, title: 'Keep the feet steady under moving hands', meter,
    goal: 'Keep kick and hi-hat pedal on every quarter while the right-hand ride and left-hand snare change.',
    tempo: { start: 60, target: 80 }, limbs: 'Right hand: ride · Left hand: snare · Right foot: kick · Left foot: hi-hat pedal',
    steps: ['The kick and left-foot pedal repeat on all four quarter notes.', 'Move the snare between backbeats and offbeats while the ride stays even.',
      'Separate the feet from both changing hands before raising the speed.'],
    bars: [
      eight({ rd: 'x-x-x-x-', sn: '--X---X-', bd: 'x-x-x-x-', hp: 'x-x-x-x-' }),
      eight({ rd: 'x-x-x-x-', sn: '---X--X-', bd: 'x-x-x-x-', hp: 'x-x-x-x-' }),
      eight({ rd: 'x-x-x-x-', sn: '--X-X---', bd: 'x-x-x-x-', hp: 'x-x-x-x-' }),
      eight({ rd: 'x-x-x-x-', sn: '---X---X', bd: 'x-x-x-x-', hp: 'x-x-x-x-' }),
    ],
  },
  {
    id: 'basics-pedal-quarter-independence', level: 5, title: 'Quarter-note hi-hat pedal independence', meter,
    goal: 'Play the left-foot hi-hat pedal on every quarter note while the kick moves and the hands keep the backbeat.',
    tempo: { start: 60, target: 80 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick · Left foot: hi-hat pedal',
    steps: ['Close the hi-hat pedal on beats 1, 2, 3 and 4 in every bar.', 'Keep the right hand on eighth notes and the snare on 2 and 4.',
      'Change the kick pattern without moving the pedal off its quarter-note pulse.'],
    bars: [
      eight({ hh: 'xxxxxxxx', sn: '--X---X-', bd: 'x---x---', hp: 'x-x-x-x-' }),
      eight({ hh: 'xxxxxxxx', sn: '--X---X-', bd: 'x--xx---', hp: 'x-x-x-x-' }),
      eight({ hh: 'xxxxxxxx', sn: '--X---X-', bd: 'x-----x-', hp: 'x-x-x-x-' }),
      eight({ hh: 'xxxxxxxx', sn: '--X---X-', bd: 'xx--x--x', hp: 'x-x-x-x-' }),
    ],
  },
  {
    id: 'basics-pedal-offbeats', level: 5, title: 'Hi-hat pedal on the offbeats', meter,
    goal: 'Place the left-foot pedal on each "&" while the hands and kick maintain their own steady pattern.',
    tempo: { start: 60, target: 80 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick · Left foot: hi-hat pedal',
    steps: ['Count "1 & 2 & 3 & 4 &"; the pedal plays only the "&" counts.', 'Keep eighth notes on the hi-hat and the backbeat on 2 and 4.',
      'The right foot changes in each bar while the left foot stays on offbeats.'],
    bars: [
      eight({ hh: 'xxxxxxxx', sn: '--X---X-', bd: 'x---x---', hp: '-x-x-x-x' }),
      eight({ hh: 'xxxxxxxx', sn: '--X---X-', bd: 'x--x-x--', hp: '-x-x-x-x' }),
      eight({ hh: 'xxxxxxxx', sn: '--X---X-', bd: 'x-----x-', hp: '-x-x-x-x' }),
      eight({ hh: 'xxxxxxxx', sn: '--X---X-', bd: 'xx--x--x', hp: '-x-x-x-x' }),
    ],
  },
  {
    id: 'basics-pedal-kick-independence', level: 5, title: 'Pedal and kick independence', meter,
    goal: 'Hold the hi-hat pedal on quarters as the right-foot kick moves through eighth-note offbeats.',
    tempo: { start: 56, target: 80 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick · Left foot: hi-hat pedal',
    steps: ['The left foot plays beats 1–4 without changing.', 'Move the kick from quarter notes to "&" counts while the backbeat stays on 2 and 4.',
      'Build the pattern one foot at a time, then add both hands.'],
    bars: [
      eight({ hh: 'xxxxxxxx', sn: '--X---X-', bd: 'x---x---', hp: 'x-x-x-x-' }),
      eight({ hh: 'xxxxxxxx', sn: '--X---X-', bd: '-x---x--', hp: 'x-x-x-x-' }),
      eight({ hh: 'xxxxxxxx', sn: '--X---X-', bd: 'x-x---x-', hp: 'x-x-x-x-' }),
      eight({ hh: 'xxxxxxxx', sn: '--X---X-', bd: '-x-x-x--', hp: 'x-x-x-x-' }),
    ],
  },
  {
    id: 'basics-three-to-four-limbs', level: 5, title: 'Build from three limbs to four', meter,
    goal: 'Establish a three-limb ride groove, then add the left-foot hi-hat pedal without changing the other limbs.',
    tempo: { start: 56, target: 80 }, limbs: 'Right hand: ride · Left hand: snare · Right foot: kick · Left foot: hi-hat pedal',
    steps: ['Bars 1–2 use ride, snare and kick only; keep the backbeat and kick steady.', 'Bars 3–4 add the left-foot pedal on the "&" counts.',
      'Loop the change between three limbs and four limbs without moving the tempo.'],
    bars: [
      eight({ rd: 'xxxxxxxx', sn: '--X---X-', bd: 'x---x---' }),
      eight({ rd: 'xxxxxxxx', sn: '--X---X-', bd: 'x--xx---' }),
      eight({ rd: 'xxxxxxxx', sn: '--X---X-', bd: 'x---x---', hp: '-x-x-x-x' }),
      eight({ rd: 'xxxxxxxx', sn: '--X---X-', bd: 'x--xx---', hp: '-x-x-x-x' }),
    ],
  },
]

export const BASIC_INSERTIONS: Record<string, Lesson[]> = {
  eighths: lessons.slice(0, 2),
  sixteenths: lessons.slice(2, 4),
  'moving-accents': lessons.slice(4, 6),
  'snare-under-hat': lessons.slice(6, 8),
  'ride-and-hat-foot': lessons.slice(8, 9),
  'four-limb-groove': lessons.slice(9, 12),
}
