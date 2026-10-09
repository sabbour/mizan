import type { BarMeter, DrumHit, DrumLane, Song } from '../workspace/song'

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
  t1: { lane: 'hightom', midi: 50 },
  t2: { lane: 'hightom', midi: 48 },
  t3: { lane: 'hightom', midi: 47 },
  f1: { lane: 'floortom', midi: 43 },
  f2: { lane: 'floortom', midi: 41 },
} as const satisfies Record<string, { lane: DrumLane; midi: number; foot?: boolean }>
export type Voice = keyof typeof VOICES
export const FOOT_VOICES = (Object.keys(VOICES) as Voice[]).filter((voice) => 'foot' in VOICES[voice])

/** Grid characters: `-` rest, `x` normal, `X` accent, `g` ghost note; on the hi-hat `o`/`O` open and `h` half-open. */
export const VELOCITY: Record<string, number> = { x: 0.7, X: 0.95, g: 0.3, o: 0.7, O: 0.95, h: 0.7 }

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

export const LEVELS = ['Pulse and rests', 'Subdivision', 'Rudiments', 'Coordination and grooves', 'Fills', 'Dynamics and meter']

const ROCK = { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R+L R R R R+L R',
  notes: { hh: 'xxxxxxxx', sn: '--X---X-', bd: 'x---x---' } } satisfies LessonBar
const CRASH_IN = { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R+L R R R R+L R',
  notes: { cr: 'x-------', hh: '-xxxxxxx', sn: '--X---X-', bd: 'x---x---' } } satisfies LessonBar
const SIXTEENS = '1 e & a 2 e & a 3 e & a 4 e & a'
const twice = (bar: LessonBar) => [bar, bar]

export const LESSONS: Lesson[] = [
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
    bars: twice({ steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R L R L R L R L', notes: { sn: 'XxXxXxXx' } }),
  },
  {
    id: 'sixteenths', level: 2, title: 'Sixteenth notes with beat accents', meter: { numerator: 4, denominator: 4 },
    goal: 'Four even notes per beat with a clear accent on each beat, while the kick marks the pulse.',
    tempo: { start: 60, target: 80 },
    steps: ['Count "1 e & a" for each beat.', 'Alternate hands; the right hand plays every beat and every "&".',
      'Keep the kick on each beat with the click.', 'Accent only the beat; play "e & a" low and even.'],
    bars: twice({ steps: 4, count: SIXTEENS, sticking: 'R L R L R L R L R L R L R L R L',
      notes: { sn: 'XxxxXxxxXxxxXxxx', bd: 'x---x---x---x---' } }),
  },
  {
    id: 'triplets', level: 2, title: 'Eighth-note triplets', meter: { numerator: 4, denominator: 4 },
    goal: 'Three equal notes per beat. Alternating hands means each beat starts on the opposite hand.',
    tempo: { start: 60, target: 80 },
    steps: ['Count "1 trip let 2 trip let" so each word is equal.', 'Alternate hands: beat 1 starts R, beat 2 starts L.',
      'Accent each beat so the triplet grouping stays clear.'],
    bars: twice({ steps: 3, count: '1 trip let 2 trip let 3 trip let 4 trip let', sticking: 'R L R L R L R L R L R L',
      notes: { sn: 'XxxXxxXxxXxx', bd: 'x--x--x--x--' } }),
  },
  {
    id: 'subdivision-ladder', level: 2, title: 'Subdivision ladder', meter: { numerator: 4, denominator: 4 },
    goal: 'Move between quarters, eighths, triplets and sixteenths over the same steady pulse.',
    tempo: { start: 60, target: 80 },
    steps: ['The kick keeps quarter notes in every bar; let it hold you steady.', 'Count each bar with its own words and change smoothly at the bar line.',
      'If a change rushes, loop just those two bars at a slower speed.'],
    bars: [
      { steps: 1, count: '1 2 3 4', sticking: 'R L R L', notes: { sn: 'XXXX', bd: 'xxxx' } },
      { steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R L R L R L R L', notes: { sn: 'XxXxXxXx', bd: 'x-x-x-x-' } },
      { steps: 3, count: '1 trip let 2 trip let 3 trip let 4 trip let', sticking: 'R L R L R L R L R L R L', notes: { sn: 'XxxXxxXxxXxx', bd: 'x--x--x--x--' } },
      { steps: 4, count: SIXTEENS, sticking: 'R L R L R L R L R L R L R L R L', notes: { sn: 'XxxxXxxxXxxxXxxx', bd: 'x---x---x---x---' } },
    ],
    sections: [{ name: 'Quarters', bars: 1 }, { name: 'Eighths', bars: 1 }, { name: 'Triplets', bars: 1 }, { name: 'Sixteenths', bars: 1 }],
  },
  {
    id: 'double-strokes', level: 3, title: 'Double strokes', meter: { numerator: 4, denominator: 4 },
    goal: 'Two even strokes per hand. The second stroke of each pair should be as loud as the first.',
    tempo: { start: 60, target: 80 },
    steps: ['Sticking R R L L throughout, with the kick on every beat.', 'Use the wrist for the first stroke and the fingers for the second.',
      'Listen for even sixteenths at one volume; the pairs should not gallop.'],
    bars: twice({ steps: 4, count: SIXTEENS, sticking: 'R R L L R R L L R R L L R R L L',
      notes: { sn: 'xxxxxxxxxxxxxxxx', bd: 'x---x---x---x---' } }),
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
    id: 'paradiddle-groove', level: 4, title: 'Paradiddle groove', meter: { numerator: 4, denominator: 4 },
    goal: 'Turn the paradiddle into a groove: right hand on the hi-hat, left on the snare, accents become the backbeat.',
    tempo: { start: 60, target: 80 }, limbs: 'Right hand: hi-hat · Left hand: snare (ghost notes and backbeat) · Right foot: kick',
    steps: ['Play the paradiddle sticking: R on the hi-hat, L on the snare.', 'The accented L notes on 2 and 4 are the backbeat; the other L notes are ghost notes.',
      'Add the kick on 1 and 3 once the hands feel automatic.'],
    bars: twice({ steps: 4, count: SIXTEENS, sticking: 'R L R R L R L L R L R R L R L L',
      notes: { hh: 'X-xx-x--X-xx-x--', sn: '-g--X-gg-g--X-gg', bd: 'x-------x-------' } }),
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
    id: 'hi-hat-states', level: 4, title: 'Open, half-open and closed hi-hat', meter: { numerator: 4, denominator: 4 },
    goal: 'Control the hi-hat with your foot: open it on "4 &", a little on "2 &", and close it with the pedal on 1.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick · Left foot: hi-hat pedal',
    steps: ['On "4 &" ease the pressure off the hi-hat pedal with your left foot to open it (circled note), then press the pedal down on 1 to close it.',
      'Bar 2 adds a half-open "slosh" on "2 &": release the pedal pressure only slightly. This half-open sound is written into the lesson, not detected.',
      'The closing pedal and the next hand stroke land together.'],
    bars: [
      { ...ROCK, notes: { ...ROCK.notes, hh: 'xxxxxxxo', hp: 'x-------' } },
      { ...ROCK, notes: { ...ROCK.notes, hh: 'xxxhxxxo', hp: 'x-------' } },
    ],
  },
  {
    id: 'ride-and-hat-foot', level: 4, title: 'Ride with the hi-hat foot', meter: { numerator: 4, denominator: 4 },
    goal: 'A three-limb pattern: ride with the right hand, hi-hat pedal on 2 and 4, a soft kick on 1 and 3.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: ride · Left foot: hi-hat pedal · Right foot: kick (soft)',
    steps: ['Ride: 1, 2, "2 &", 3, 4, "4 &". Play it straight first; it can swing later.',
      'Close the hi-hat with the left foot on 2 and 4: a crisp "chick".', 'Keep the kick very soft on 1 and 3, felt more than heard.'],
    bars: twice({ steps: 2, count: '1 & 2 & 3 & 4 &', sticking: 'R R R R R R',
      notes: { rd: 'x-xxx-xx', hp: '--x---x-', bd: 'g---g---' } }),
  },
  {
    id: 'snare-fill', level: 5, title: 'Groove, fill, crash', meter: { numerator: 4, denominator: 4 },
    goal: 'Play three bars of groove, a two-beat snare fill, and land on the crash with the kick on the next 1.',
    tempo: { start: 70, target: 100 }, limbs: 'Groove as the rock beat; the fill alternates hands on the snare',
    steps: ['Count the bars aloud: "1 2 3 4, 2 2 3 4, 3 2 3 4, 4 2 fill".', 'Start the fill on beat 3 of bar 4 with the right hand, sixteenths R L R L.',
      'The crash and kick on the next 1 end the fill; do not stop or rush into it.', 'Loop the four bars; bar 1 always begins with the crash.'],
    bars: [CRASH_IN, ROCK, ROCK, { steps: 4, count: SIXTEENS, sticking: 'R R R+L R R L R L R L R L',
      notes: { hh: 'x-x-x-x---------', sn: '----X---xxxxxxxX', bd: 'x---------------' } }],
    sections: [{ name: 'Groove', bars: 3 }, { name: 'Fill', bars: 1 }],
  },
  {
    id: 'tom-fill', level: 5, title: 'Fill around the toms', meter: { numerator: 4, denominator: 4 },
    goal: 'Move the fill from the high tom down to the floor toms, then back to the groove with a crash.',
    tempo: { start: 65, target: 100 }, limbs: 'Groove as the rock beat; the fill alternates hands from high to low',
    steps: ['The fill on beats 3 and 4 goes: high tom, high-mid tom, low-mid tom, then the two floor toms.',
      'Keep the sticking R L R L as you move: the right hand leads each rack-tom pair, then right on the high floor tom and left on the low one.',
      'Accent the first note on each new drum so the descent is clear.', 'Land the crash and kick together on the next 1.'],
    bars: [CRASH_IN, ROCK, ROCK, { steps: 4, count: SIXTEENS, sticking: 'R R R+L R R L R L R L R L',
      notes: { hh: 'x-x-x-x---------', sn: '----X-----------', bd: 'x---------------',
        t1: '--------Xx------', t2: '----------Xx----', t3: '------------Xx--', f1: '--------------X-', f2: '---------------X' } }],
    sections: [{ name: 'Groove', bars: 3 }, { name: 'Fill', bars: 1 }],
  },
  {
    id: 'accents-and-ghosts', level: 6, title: 'Accents and ghost notes', meter: { numerator: 4, denominator: 4 },
    goal: 'Contrast a loud backbeat with very soft ghost notes on the snare, at the same tempo.',
    tempo: { start: 60, target: 80 }, limbs: 'Right hand: hi-hat · Left hand: snare (ghosts and backbeat) · Right foot: kick',
    steps: ['Ghost notes are barely audible: drop the stick from about 2 cm.',
      'The backbeat on 2 and 4 is a full stroke from high up.', 'Keep the hi-hat steady and even underneath both.'],
    bars: twice({ steps: 4, count: SIXTEENS, sticking: 'R R L R+L R L R R L R+L R L',
      notes: { hh: 'x-x-x-x-x-x-x-x-', sn: '---gX--g---gX--g', bd: 'x-----x-x-------' } }),
  },
  {
    id: 'waltz', level: 6, title: 'Waltz groove in 3/4', meter: { numerator: 3, denominator: 4 },
    goal: 'Three beats per bar: kick on 1, snare on 2 and 3, with the hi-hat on eighth notes.',
    tempo: { start: 84, target: 120 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Count "1 & 2 & 3 &"; the bar has only three beats.', 'Feel beat 1 as the strong one; 2 and 3 answer it.',
      'The click accents each new bar, every three beats.'],
    bars: twice({ steps: 2, count: '1 & 2 & 3 &', sticking: 'R R R+L R R+L R', notes: { hh: 'xxxxxx', sn: '--x-x-', bd: 'x-----' } }),
  },
  {
    id: 'six-eight', level: 6, title: 'Groove in 6/8', meter: { numerator: 6, denominator: 8 },
    goal: 'Six eighth notes in two groups of three: kick on 1, snare on 4, accents on 1 and 4.',
    tempo: { start: 42, target: 60 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Count "1 2 3 4 5 6", accenting 1 and 4.', 'The click plays dotted quarters: on 1 and on 4.',
      'Each group of three should roll like a triplet, not split into two even halves.'],
    bars: twice({ steps: 2, count: '1 2 3 4 5 6', sticking: 'R R R R+L R R', notes: { hh: 'XxxXxx', sn: '---X--', bd: 'x-----' } }),
  },
]

export const lessonById = (id: string) => LESSONS.find((lesson) => lesson.id === id)

/** The workspace subtitle for a lesson: where it sits in the course. */
export const lessonNote = (lesson: Lesson) =>
  `Drum course · Level ${lesson.level} · ${LESSONS.indexOf(lesson) + 1} of ${LESSONS.length}`

/** Quarter-note beats per bar, and the counted pulse in quarter notes (a dotted quarter in compound time). */
export function lessonMeter(lesson: Pick<Lesson, 'meter'>) {
  const { numerator, denominator } = lesson.meter
  const compound = denominator === 8 && numerator % 3 === 0 && numerator >= 6
  return { beatsPerBar: numerator * 4 / denominator, pulse: compound ? 1.5 : 4 / denominator, compound }
}

/** Every hit a lesson plays, in time order. */
export function lessonHits(lesson: Lesson): DrumHit[] {
  const { beatsPerBar } = lessonMeter(lesson)
  const hits: DrumHit[] = []
  lesson.bars.forEach((bar, index) => {
    const start = index * beatsPerBar
    for (const [voice, pattern] of Object.entries(bar.notes) as [Voice, string][]) {
      const kit = VOICES[voice]
      ;[...pattern].forEach((symbol, step) => {
        if (symbol === '-') return
        const startBeat = start + step / bar.steps
        const velocity = VELOCITY[symbol]
        if (voice === 'hh' && 'oOh'.includes(symbol)) {
          hits.push({ trackId: 'drums', lane: 'openhat', startBeat, velocity, sourceMidi: 46,
            ...(symbol === 'h' ? { articulation: 'half-open' as const } : {}) })
        } else hits.push({ trackId: 'drums', lane: kit.lane, startBeat, velocity, sourceMidi: kit.midi })
      })
    }
  })
  return hits.sort((a, b) => a.startBeat - b.startBeat)
}

/** The lesson as a song for the practice workspace: one authored drum track, no recording, nothing analysed. */
export function lessonSong(lesson: Lesson): Song {
  const { beatsPerBar, pulse } = lessonMeter(lesson)
  const bars = lesson.bars.length
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
    title: `Lesson ${LESSONS.indexOf(lesson) + 1}: ${lesson.title}`,
    source: 'course',
    tracks: [{ id: 'drums', instrument: 'drums', name: 'Drum kit', detail: 'Lesson pattern (authored, not transcribed)' }],
    bpm: lesson.tempo.target * pulse,
    beatsPerBar,
    beatUnit: lesson.meter.denominator,
    barMap,
    bars,
    key: null,
    sections,
    chords: [],
    piano: [],
    vocals: [],
    drums: lessonHits(lesson),
    confidence: { piano: high, drums: high, chords: high, vocals: high },
  }
}
