import type { Lesson, LessonBar, Voice } from './curriculum'

type Pattern = { steps: number; notes: LessonBar['notes']; alternating?: boolean }
type Study = {
  id: string; title: string; artist: string; track: string; focus: string; level: number
  meter?: { numerator: number; denominator: number }; bars: Pattern[]
}
type Teaching = { goal: string; steps: string[]; tempo: { start: number; target: number }; limbs: string }

const FEET: Voice[] = ['bd', 'hp']
const CYMBALS: Voice[] = ['hh', 'rd', 'cr']
const COUNTS: Record<number, string[]> = {
  2: ['', '&'],
  3: ['', 'trip', 'let'],
  4: ['', 'e', '&', 'a'],
}

function makeBar(pattern: Pattern, meter: { numerator: number; denominator: number }): LessonBar {
  const { steps, notes, alternating = false } = pattern
  const length = Math.max(...Object.values(notes).map((value) => value.length))
  const count = meter.denominator === 8
    ? Array.from({ length: meter.numerator }, (_, i) => steps === 2 ? [String(i + 1)] : [String(i + 1), '&']).flat().join(' ')
    : Array.from({ length }, (_, i) => COUNTS[steps][i % steps] || String(Math.floor(i / steps) + 1)).join(' ')
  let next = 0
  const sticking: string[] = []
  for (let step = 0; step < length; step++) {
    const hands = (Object.keys(notes) as Voice[]).filter((voice) => !FEET.includes(voice) && (notes[voice]![step] ?? '-') !== '-')
    if (hands.length === 2) sticking.push('R+L')
    else if (hands.length === 1) sticking.push(alternating
      ? next++ % 2 ? 'L' : 'R'
      : CYMBALS.includes(hands[0]) ? 'R' : 'L')
  }
  return { steps, count, notes, sticking: sticking.join(' ') }
}

const studies: Study[] = [
  {
    id: 'inspired-pink-floyd-money', title: 'Seven-quarter groove — Money', artist: 'Pink Floyd', track: 'Money',
    focus: 'Original exercise, not a transcription · seven-quarter cycle grouped 3 + 2 + 2',
    level: 7, meter: { numerator: 7, denominator: 4 },
    bars: [
      { steps: 2, notes: { hh: 'XxXxXxXxXxXxXx', sn: '----X-----X---', bd: 'x-----x---x---' } },
      { steps: 2, notes: { rd: 'X-xx-X-xx-X-xx', sn: '------X---X---', bd: 'x-----x---x-x-' } },
      { steps: 2, notes: { hh: 'XxXxXxXxXxXxXx', sn: '----X---g-X---', bd: 'x-----x---x--x' } },
      { steps: 2, alternating: true, notes: { cr: 'X-------------', hh: '-x-x-x-x-x-x--', sn: '----X---g-----', t1: '--------Xx----', t2: '----------Xx--', f1: '------------Xx', bd: 'x-----x---x---' } },
    ],
  },
  {
    id: 'inspired-pink-floyd-time', title: 'Space, then a tom response — Time', artist: 'Pink Floyd', track: 'Time',
    focus: 'Original exercise, not a transcription · open space, measured tom answers and a controlled build',
    level: 6,
    bars: [
      { steps: 4, notes: { hh: 'x---x---x---x---', sn: '----X-------X---', bd: 'x-------x-------' } },
      { steps: 4, alternating: true, notes: { hh: 'x---x---x---x---', sn: '----X-------X---', t1: '------g---X-----', bd: 'x-------x-------' } },
      { steps: 4, alternating: true, notes: { rd: 'x---x---x---x---', sn: '----X-------X---', t2: '------x---X---x-', bd: 'x-------x-------' } },
      { steps: 4, alternating: true, notes: { cr: 'x---------------', hh: '----x---x-------', sn: '----X---Xx------',
        t1: '----------Xx----', t2: '------------Xx--', f1: '--------------Xx', bd: 'x-------x-------' } },
    ],
  },
  {
    id: 'inspired-pink-floyd-another-brick', title: 'Open sixteenth hats — Another Brick in the Wall, Part 2',
    artist: 'Pink Floyd', track: 'Another Brick in the Wall, Part 2',
    focus: 'Original exercise, not a transcription · disco-influenced sixteenth hats, open offbeats and a half-time backbeat',
    level: 5,
    bars: [
      { steps: 4, alternating: true, notes: { hh: 'x-x-x-o-x-x-x-o-', sn: '--------X-------', bd: 'x-------x---x---', hp: 'x-------x-------' } },
      { steps: 4, alternating: true, notes: { hh: 'x-x-x-o-x-x-x-o-', sn: '--------X-------', bd: 'x---x---x-----x-', hp: 'x-------x-------' } },
      { steps: 4, alternating: true, notes: { rd: 'X-x-x-x-X-x-x-x-', hh: '-x-x-x-x-x-x-x-x', sn: '--------X-------', bd: 'x-------x---x---', hp: 'x-------x-------' } },
      { steps: 4, alternating: true, notes: { cr: 'X---------------', hh: '-x-x-o-x-x-x-o-x', sn: '--------X--g----', bd: 'x---x---x-----x-', hp: 'x-------x-------' } },
    ],
  },
  {
    id: 'inspired-dire-straits-sultans', title: 'Light shuffle and rimshot accents — Sultans of Swing',
    artist: 'Dire Straits', track: 'Sultans of Swing',
    focus: 'Original exercise, not a transcription · light shuffle pulse, ghost-note snare and rimshot-like accents',
    level: 7,
    bars: [
      { steps: 3, notes: { rd: 'x-xx-xx-xx-x', sn: '---g---X----', bd: 'x-----x-----' } },
      { steps: 3, notes: { rd: 'x-xx-xx-xx-x', sn: 'g--g-----X--', bd: 'x--x--x-----' } },
      { steps: 3, notes: { hh: 'x-xx-xx-xx-x', sn: '---g----gX--', bd: 'x-----x---x-' } },
      { steps: 3, alternating: true, notes: { cr: 'X-----------', rd: '-xx-xx------', sn: '---g---X----', t1: '---------X--', t2: '----------X-', f1: '-----------X', bd: 'x-----x-----' } },
    ],
  },
  {
    id: 'inspired-dire-straits-money-for-nothing', title: 'Tom-led half-time build — Money for Nothing',
    artist: 'Dire Straits', track: 'Money for Nothing',
    focus: 'Original exercise, not a transcription · low-tom intro texture opening into a broad half-time backbeat',
    level: 6,
    bars: [
      { steps: 2, notes: { f1: 'X---x---', bd: 'x---x---' } },
      { steps: 2, notes: { f1: 'x-----X-', t2: '----g---', bd: 'x---x---' } },
      { steps: 2, notes: { rd: 'X---x---', sn: '----X---', f1: 'x-------', bd: 'x-----x-' } },
      { steps: 2, alternating: true, notes: { cr: 'X-------', rd: '-x-x----', sn: '----X---', t2: '------x-', f1: '-------X', bd: 'x---x---' } },
    ],
  },
  {
    id: 'inspired-dire-straits-walk-of-life', title: 'Bouncy country shuffle — Walk of Life',
    artist: 'Dire Straits', track: 'Walk of Life',
    focus: 'Original exercise, not a transcription · bouncy country shuffle with accented backbeats and kick pickups',
    level: 5,
    bars: [
      { steps: 3, notes: { hh: 'x-xx-xx-xx-x', sn: '---X-----X--', bd: 'x-----x-----' } },
      { steps: 3, notes: { hh: 'x-xx-xx-xx-x', sn: '---X--g--X--', bd: 'x---xx------' } },
      { steps: 3, notes: { rd: 'X-xx-x-xx-x-', sn: '---X-----X--', bd: 'x---x-x-----' } },
      { steps: 3, alternating: true, notes: { cr: 'X-----------', hh: '--xx-xx-xx-x', sn: '---X--------', t1: '---------x--', t2: '----------x-', f1: '-----------X', bd: 'x-----x-----' } },
    ],
  },
  {
    id: 'inspired-metallica-enter-sandman', title: 'Steady eighths and a changing kick — Enter Sandman',
    artist: 'Metallica', track: 'Enter Sandman',
    focus: 'Original exercise, not a transcription · firm eighth-note pulse with measured kick variations',
    level: 6,
    bars: [
      { steps: 2, notes: { cr: 'X-------', hh: '-xxxxxxx', sn: '--X---X-', bd: 'x---x---' } },
      { steps: 2, notes: { hh: 'xxxxxxxx', sn: '--X---X-', bd: 'x--x-x--' } },
      { steps: 2, notes: { rd: 'XxXxXxXx', sn: '--X---X-', bd: 'xx--x---' } },
      { steps: 2, notes: { cr: 'x-------', hh: '-xxxxxxx', sn: '--X---X-', bd: 'x--xx-x-' } },
    ],
  },
  {
    id: 'inspired-metallica-master-of-puppets', title: 'Galloping kick groups — Master of Puppets',
    artist: 'Metallica', track: 'Master of Puppets',
    focus: 'Original exercise, not a transcription · controlled long-short kick groups and clear backbeats',
    level: 8,
    bars: [
      { steps: 4, notes: { cr: 'X---x---X---x---', sn: '----X-------X---', bd: 'X-xx--xx-X-xx--x' } },
      { steps: 4, notes: { rd: 'X-x-x-x-X-x-x-x-', sn: '----X-------X---', bd: 'X-xxx-xx-X-xxx-x' } },
      { steps: 4, notes: { cr: 'X---x---X---x---', sn: '----X-------X---', bd: 'X-xx--xx-X-xxx-x' } },
      { steps: 4, alternating: true, notes: { cr: 'X---x---X---x---', sn: '----X---XxXx----', t1: '------------Xx--', bd: 'X-xx--xx-X-xx--x' } },
    ],
  },
  {
    id: 'inspired-metallica-sad-but-true', title: 'Slow heavy backbeat — Sad But True',
    artist: 'Metallica', track: 'Sad But True',
    focus: 'Original exercise, not a transcription · slow half-time weight and deliberate rests',
    level: 6,
    bars: [
      { steps: 2, notes: { cr: 'x-------', hh: '----x---', sn: '----X---', bd: 'x-------' } },
      { steps: 2, notes: { hh: 'x---x---', sn: '----X---', bd: 'x-----x-' } },
      { steps: 2, notes: { rd: 'x---x---', sn: '----X---', bd: 'x---x---' } },
      { steps: 2, alternating: true, notes: { cr: 'x-------', hh: '----x---', sn: '----X-X-', t2: '------x-', bd: 'x-----x-' } },
    ],
  },
  {
    id: 'inspired-tool-schism', title: 'Grouped odd-meter phrase — Schism',
    artist: 'Tool', track: 'Schism',
    focus: 'Original exercise, not a transcription · odd-meter groupings in the spirit of progressive rock',
    level: 8, meter: { numerator: 7, denominator: 8 },
    bars: [
      { steps: 4, notes: { t1: 'X-----x---X---', sn: '----X-----X---', bd: 'x-----x---x---' } },
      { steps: 4, notes: { t1: 'X---x---X---x-', sn: '------X---X---', bd: 'x---x---x---x-' } },
      { steps: 4, notes: { t2: 'X---x---X---x-', sn: '----X---g-X---', bd: 'x---x-x---x---' } },
      { steps: 4, alternating: true, notes: { cr: 'X-------------', sn: '----X---g-----', t1: '------Xx------', t2: '--------Xx----', f1: '----------Xx--', bd: 'x-----x---x---' } },
    ],
  },
  {
    id: 'inspired-tool-lateralus', title: 'Accents that cross the pulse — Lateralus',
    artist: 'Tool', track: 'Lateralus',
    focus: 'Original exercise, not a transcription · shifting accent groups over an even subdivision',
    level: 8,
    bars: [
      { steps: 4, alternating: true, notes: { sn: 'XxxXxxXxxXxxXxxx' } },
      { steps: 4, alternating: true, notes: { sn: 'xxXxxXxxXxxXxxxX' } },
      { steps: 4, alternating: true, notes: { hh: 'XxxxXxxxXxxxXxxx', sn: '----X-------X---', bd: 'x-----x---x-----' } },
      { steps: 4, alternating: true, notes: { cr: 'X---------------', hh: '-xxx-xxx-xxx----', sn: '----X---XxXx----', t1: '------------Xx--', f1: '--------------Xx', bd: 'x---x---x-------' } },
    ],
  },
  {
    id: 'inspired-tool-the-pot', title: 'Syncopated linear accents — The Pot',
    artist: 'Tool', track: 'The Pot',
    focus: 'Original exercise, not a transcription · syncopated kick and ghost-note answers',
    level: 8,
    bars: [
      { steps: 4, notes: { hh: 'x-x-x-x-x-x-x-x-', sn: '---gX--g---gX--g', bd: 'x-x-----x---x---' } },
      { steps: 4, notes: { hh: 'x-x-x-x-x-x-x-x-', sn: '-g--X---g-g-X---', bd: 'x---x-x-----x---' } },
      { steps: 4, notes: { rd: 'x-x-x-x-x-x-x-x-', sn: '---gX-----g-X--g', bd: 'x--x----x-x-----' } },
      { steps: 4, notes: { cr: 'x---------------', hh: '-x-x-x-x-x-x-x--', sn: '---gX--g---gX---', bd: 'x-x---x---x-----' } },
    ],
  },
  {
    id: 'inspired-eagles-hotel-california', title: 'Reggae-tinged half-feel — Hotel California',
    artist: 'Eagles', track: 'Hotel California',
    focus: 'Original exercise, not a transcription · laid-back half-feel, offbeat cymbal color and quiet snare ghosts',
    level: 6,
    bars: [
      { steps: 2, notes: { rd: 'x---x---', sn: '--g-X---', bd: 'x-----x-' } },
      { steps: 2, notes: { hh: 'x-o-x-o-', sn: '----X---', bd: 'x---x---', hp: '----x---' } },
      { steps: 2, notes: { rd: 'x-x-x-x-', sn: '--g-X-g-', bd: 'x-----x-' } },
      { steps: 2, alternating: true, notes: { cr: 'X-------', rd: '-x-x-x--', sn: '----X---', t1: '------g-', bd: 'x---x-x-' } },
    ],
  },
  {
    id: 'inspired-eagles-take-it-easy', title: 'Country-rock train beat — Take It Easy',
    artist: 'Eagles', track: 'Take It Easy',
    focus: 'Original exercise, not a transcription · straight-eighth train beat with backbeat accents and ghost taps',
    level: 6,
    bars: [
      { steps: 2, notes: { hh: 'xxxxxxxx', sn: 'XgXgXgXg', bd: 'x---x---' } },
      { steps: 2, notes: { hh: 'xxxxxxxx', sn: 'XgXgXgXg', bd: 'x--xx---' } },
      { steps: 2, notes: { rd: 'x-x-x-x-', sn: 'XgXgXgXg', bd: 'x---x-x-' } },
      { steps: 2, alternating: true, notes: { cr: 'X-------', hh: '-xxxxx--', sn: 'XgXgXgXg', t1: '------x-', bd: 'x--xx---' } },
    ],
  },
  {
    id: 'inspired-eagles-life-in-fast-lane', title: 'Driving sixteenths and kick shifts — Life in the Fast Lane',
    artist: 'Eagles', track: 'Life in the Fast Lane',
    focus: 'Original exercise, not a transcription · driving sixteenth hats, kick shifts and crash punctuation',
    level: 7,
    bars: [
      { steps: 4, notes: { hh: 'XxxxXxxxXxxxXxxx', sn: '----X-------X---', bd: 'x-----x---x-----' } },
      { steps: 4, notes: { hh: 'XxxxXxxxXxxxXxxx', sn: '----X-------X---', bd: 'x--x----x-x-----' } },
      { steps: 4, notes: { rd: 'xXxxXxxxXxxxXxxx', sn: '----X--g----X---', bd: 'x---x---x-----x-' } },
      { steps: 4, alternating: true, notes: { cr: 'X---------------', hh: '-xxx-xxx-xxx-xxx', sn: '----X---XxxX----', t1: '------------Xx--', bd: 'x--x----x-----x-' } },
    ],
  },
  {
    id: 'inspired-phil-collins-in-the-air-tonight', title: 'A spacious build and original tom answer — In the Air Tonight',
    artist: 'Phil Collins', track: 'In the Air Tonight',
    focus: 'Original exercise, not a transcription · gradual dynamic build and a newly written tom response',
    level: 7,
    bars: [
      { steps: 4, notes: { hh: 'x-------x-------', bd: 'x---------------' } },
      { steps: 4, notes: { hh: 'x---x---x---x---', bd: 'x-------x-------' } },
      { steps: 4, notes: { hh: 'x-x-x-x-x-x-x-x-', sn: '--------X-------', bd: 'x-------x---x---' } },
      { steps: 4, alternating: true, notes: { cr: 'x---------------', hh: '-x-x-x-x--------', sn: '--------X-------', t1: '------------x---', t2: '--------------x-', f1: '---------------X', bd: 'x-------x-------' } },
    ],
  },
  {
    id: 'inspired-phil-collins-easy-lover', title: 'Upbeat two-hand pulse — Easy Lover',
    artist: 'Philip Bailey & Phil Collins', track: 'Easy Lover',
    focus: 'Original exercise, not a transcription · bright alternating hi-hat and syncopated kick',
    level: 6,
    bars: [
      { steps: 4, alternating: true, notes: { hh: 'XxxxXxxxXxxxXxxx', sn: '----X-------X---', bd: 'x------xx-------' } },
      { steps: 4, alternating: true, notes: { hh: 'XxxxXxxxXxxxXxxx', sn: '----X-------X---', bd: 'x-x----x-x------' } },
      { steps: 4, alternating: true, notes: { hh: 'XxxxXxxxXxxxXxxx', sn: '----X---g---X---', bd: 'x------xx---x---' } },
      { steps: 4, alternating: true, notes: { cr: 'x---------------', hh: '-xxx-xxxXxxx-xxx', sn: '----X-------X---', bd: 'x-x----x-x------' } },
    ],
  },
  {
    id: 'inspired-genesis-turn-it-on-again', title: 'Uneven phrase accents — Turn It On Again',
    artist: 'Genesis', track: 'Turn It On Again',
    focus: 'Original exercise, not a transcription · asymmetric groupings in the spirit of progressive pop',
    level: 8, meter: { numerator: 7, denominator: 8 },
    bars: [
      { steps: 4, notes: { hh: 'X-xx-X-xX-xx-X', sn: '----X-----X---', bd: 'x---x---x---x-' } },
      { steps: 4, notes: { rd: 'x-xx-x-Xx-xx-x', sn: '------X-----X-', bd: 'x-----x---x---' } },
      { steps: 4, notes: { hh: 'X-xx-X-xX-xx-X', sn: '----X-------X-', bd: 'x---x-x-----x-' } },
      { steps: 4, alternating: true, notes: { cr: 'X-------------', hh: '-x-xx-X-x--x-X', sn: '----X-----X---', t1: '----------Xx--', f1: '------------Xx', bd: 'x---x---x---x-' } },
    ],
  },
]

const TEACHING: Record<string, Teaching> = {
  'inspired-pink-floyd-money': {
    goal: 'a seven-quarter cycle grouped 3 + 2 + 2, with a steady eighth-note hat, backbeats that shift with the group, and a last-bar pickup.',
    tempo: { start: 56, target: 80 }, limbs: 'Right hand: hi-hat or ride · Left hand: snare · Right foot: kick',
    steps: ['Count each bar as 1-2-3, 1-2, 1-2; do not shorten the final pair.',
      'Bars 1–2 set the kick on each group start; bar 3 changes to ride and answers with a displaced snare.',
      'Bar 4 adds an original tom descent across beats 5–7, then returns to the opening hat pulse.'],
  },
  'inspired-pink-floyd-time': {
    goal: 'grow from a spacious quarter-note pulse into a four-beat tom conversation, then release back to a single crash.',
    tempo: { start: 56, target: 80 }, limbs: 'Right hand: hi-hat, then ride · Left hand: snare · Both hands: toms · Right foot: kick',
    steps: ['Bars 1–2 stay sparse: play the hat on quarter notes and leave the spaces open.',
      'Bar 2 answers the snare with a soft high tom; bar 3 answers on the lower tom and opens the ride.',
      'Bar 4 builds with a new snare-to-tom descent, accents the final tom, then drops back to bar 1.'],
  },
  'inspired-pink-floyd-another-brick': {
    goal: 'combine a simple half-time backbeat with busy sixteenth hats, open-hat offbeats and a clean phrase-end close.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick · Left foot: hi-hat pedal',
    steps: ['Keep the snare on beat 3 while the right hand alternates sixteenth notes on the hat.',
      'Open the hat only on the written offbeats; close it with the pedal on the next quarter.',
      'Bars 1–3 keep the half-time pocket; bar 4 adds a kick pickup and crash before the groove restarts.'],
  },
  'inspired-dire-straits-sultans': {
    goal: 'a light triplet shuffle with quiet snare ghosts, a rim-like accented backbeat and an answering tom phrase.',
    tempo: { start: 60, target: 80 }, limbs: 'Right hand: ride or hi-hat · Left hand: snare and toms · Right foot: kick',
    steps: ['Play the ride on the first and last triplet of each beat; keep the middle space relaxed.',
      'Use the written g notes as quiet snare taps and reserve X for the backbeat.',
      'Bar 3 moves the shuffle to hi-hat; bar 4 answers with a short tom pickup into the first beat.'],
  },
  'inspired-dire-straits-money-for-nothing': {
    goal: 'begin with low tom punctuation, open into a broad half-time backbeat, then answer it with a short floor-tom release.',
    tempo: { start: 60, target: 80 }, limbs: 'Right hand: crash or hi-hat · Left hand: snare and toms · Right foot: kick',
    steps: ['Bars 1–2 are an intro texture: let the floor tom answer the kick, with no busy cymbal pattern.',
      'Bar 3 brings in the snare on beat 3 and a wide, accented ride pulse.',
      'Bar 4 keeps the backbeat, then walks two low tom notes toward bar 1; keep this fill original.'],
  },
  'inspired-dire-straits-walk-of-life': {
    goal: 'a bouncy country shuffle: keep the outer triplet cymbal notes light, put broad snare accents on 2 and 4, and add a kick pickup.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat or ride · Left hand: snare · Right foot: kick',
    steps: ['Count triplets evenly; the ride plays the first and last subdivision of each beat.',
      'Keep snare accents on beats 2 and 4; add the quiet ghost note only in bar 2.',
      'Bar 3 moves to ride accents; bar 4 closes with three tom notes into the opening shuffle.'],
  },
  'inspired-metallica-enter-sandman': {
    goal: 'a mid-tempo heavy groove with an even hat, kick variations under a firm backbeat and crash accents at phrase starts.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Lock the eighth-note hat and accented snare on 2 and 4 before adding the kick.',
      'Bars 1–2 change only the kick; keep the backbeat broad and even.',
      'Bar 3 moves to ride; bar 4 uses a crash on 1 and a short snare answer to reset the groove.'],
  },
  'inspired-metallica-master-of-puppets': {
    goal: 'alternate an eighth-note kick drive with sixteenth-note bursts and snare accents, then release through an original tom fill.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: crash or ride · Left hand: snare and toms · Right foot: kick',
    steps: ['Bars 1–2 alternate kick strokes evenly; count sixteenths and keep every double controlled.',
      'Bar 3 answers the kick pattern with a snare burst; do not let the kick speed up.',
      'Bar 4 trades snare and tom sixteenths, accents the final tom and returns to the top.'],
  },
  'inspired-metallica-sad-but-true': {
    goal: 'make a slow half-time pocket feel heavy through long rests, low kick notes and one deliberate backbeat.',
    tempo: { start: 56, target: 80 }, limbs: 'Right hand: sparse hi-hat or ride · Left hand: snare and floor tom · Right foot: kick',
    steps: ['Count all four beats, including the empty beats around the snare on 3.',
      'Use the crash only at the opening; keep the hat or ride sparse and let notes ring.',
      'Bar 4 answers with a low tom note after the backbeat, then leave space before bar 1.'],
  },
  'inspired-tool-schism': {
    goal: 'feel an original seven-eighth phrase as 3 + 2 + 2, then move the accents to 2 + 2 + 3 while a tom ostinato stays steady.',
    tempo: { start: 56, target: 80 }, limbs: 'Right hand: hi-hat or ride · Left hand: snare and toms · Right foot: kick',
    steps: ['Bars 1–2 group the 16ths as 3 + 2 + 2; kick each group start and keep the high tom ostinato even.',
      'Bar 3 shifts the accents to 2 + 2 + 3 without changing the subdivision.',
      'Bar 4 moves the ostinato down the toms and uses a crash to lead back; this is an exercise grouping, not the track meter.'],
  },
  'inspired-tool-lateralus': {
    goal: 'keep a sixteenth-note single-stroke stream even while the accent group shifts one note later on each bar.',
    tempo: { start: 63, target: 90 }, limbs: 'Both hands: alternating snare · Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Alternate R L continuously and count sixteenths; do not restart the sticking at each accent.',
      'Shift the accent one sixteenth later in bar 2, then return to a groove in bar 3.',
      'Bar 4 moves the accent across the beat and resolves with a kick-and-crash downbeat.'],
  },
  'inspired-tool-the-pot': {
    goal: 'interlock sixteenth hats, syncopated kick and ghost-note snare answers, with a final linear turnaround.',
    tempo: { start: 63, target: 90 }, limbs: 'Right hand: hi-hat or ride · Left hand: snare · Right foot: kick',
    steps: ['Keep the hat even while the kick moves between sixteenth positions.',
      'Play g softly and X at full height; the ghost notes answer the kick rather than doubling it.',
      'Bar 4 changes to ride and crash, then leaves the last subdivision clear for the loop.'],
  },
  'inspired-eagles-hotel-california': {
    goal: 'a laid-back half-feel with offbeat hat color, soft snare ghosts and a sparse kick that leaves room for the phrase.',
    tempo: { start: 60, target: 80 }, limbs: 'Right hand: ride or hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Play the ride lightly and keep the kick on the widely spaced quarter notes.',
      'Place g before the accented snare; let the offbeat pulse sit behind the count.',
      'Bar 3 moves to hi-hat; bar 4 adds a crash pickup but keeps the half-time space.'],
  },
  'inspired-eagles-take-it-easy': {
    goal: 'a rolling country-rock train beat: keep straight eighths on the cymbal, alternate snare accents and ghost taps, and let the kick walk.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat or ride · Left hand: snare · Right foot: kick',
    steps: ['Keep the right hand on eighth notes and count every "&" evenly.',
      'The left hand accents each beat and uses g for the quiet eighth-note responses.',
      'Bars 2–3 change the kick and cymbal; bar 4 adds a crash and a short tom pickup before returning to the train beat.'],
  },
  'inspired-eagles-life-in-fast-lane': {
    goal: 'drive with sixteenth hats, a firm backbeat and syncopated kick changes before an original snare-to-tom release.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat or ride · Left hand: snare · Right foot: kick',
    steps: ['Count 1 e & a continuously and keep the right hand moving through all sixteen hat strokes.',
      'Bars 1–2 shift the kick under the same backbeat; bar 3 accents the ride and adds a ghost.',
      'Bar 4 opens on crash, runs snare sixteenths into tom 1 and releases back to the hat.'],
  },
  'inspired-phil-collins-in-the-air-tonight': {
    goal: 'build from a sparse pulse to a new descending tom conversation, with space before and after the payoff.',
    tempo: { start: 56, target: 80 }, limbs: 'Right hand: hi-hat · Left hand: snare and toms · Right foot: kick',
    steps: ['Bars 1–2 use only a few hat and kick notes; hold the dynamic down and leave the gaps silent.',
      'Bar 3 adds a strong snare backbeat and a busier hat to create the build.',
      'Bar 4 plays a newly composed snare-to-tom descent, not the recording’s famous fill; accent the floor tom, then release.'],
  },
  'inspired-phil-collins-easy-lover': {
    goal: 'drive a pop-rock phrase with alternating sixteenth hats, strong beat accents and a kick that answers the backbeat.',
    tempo: { start: 70, target: 100 }, limbs: 'Both hands: alternating hi-hat; left hand: snare · Right foot: kick',
    steps: ['Alternate R L across the sixteenth hats; accents stay on the four quarter-note beats.',
      'Move the kick under the same hand pattern in bars 2–3; keep the snare backbeat full.',
      'Bar 4 opens with a crash, then drops back to lighter hats for the loop.'],
  },
  'inspired-genesis-turn-it-on-again': {
    goal: 'alternate two uneven seven-eighth groupings while a steady kick marks the pulse and the final bar resolves cleanly.',
    tempo: { start: 56, target: 80 }, limbs: 'Right hand: hi-hat or ride · Left hand: snare · Right foot: kick',
    steps: ['Bars 1 and 3 group the pulse 3 + 2 + 2; bar 2 changes to 2 + 2 + 3.',
      'Keep the eighth-note kick steady while the accented cymbal and snare move with each group.',
      'Bar 4 adds a new crash pickup and returns to the first grouping; this is a practice grouping, not a transcription.'],
  },
}

export const INSPIRED_LESSONS: Lesson[] = studies.map((study) => {
  const meter = study.meter ?? { numerator: 4, denominator: 4 }
  const teaching = TEACHING[study.id]
  return {
    id: study.id, collection: 'inspired', style: `Inspired by ${study.artist} — ${study.track}`,
    feel: study.focus, level: study.level, title: study.title,
    goal: `Original exercise, not a transcription: ${teaching.goal}`,
    meter, tempo: teaching.tempo, limbs: teaching.limbs, steps: teaching.steps,
    bars: study.bars.map((pattern) => makeBar(pattern, meter)),
  }
})
