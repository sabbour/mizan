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
    focus: 'seven-quarter cycle grouped 3 + 2 + 2',
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
    focus: 'open space, measured tom answers and a controlled build',
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
    focus: 'sixteenth hats with open offbeats and a half-time backbeat',
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
    focus: 'light shuffle pulse, ghost-note snare and accented backbeats',
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
    focus: 'low-tom intro texture opening into a broad half-time backbeat',
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
    focus: 'bouncy country shuffle with accented backbeats and kick pickups',
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
    focus: 'firm eighth-note pulse with measured kick variations',
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
    focus: 'controlled long-short kick groups and clear backbeats',
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
    focus: 'slow half-time weight and deliberate rests',
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
    focus: 'odd-meter groupings in the spirit of progressive rock',
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
    focus: 'shifting accent groups over an even subdivision',
    level: 8, meter: { numerator: 9, denominator: 8 },
    bars: [
      { steps: 4, alternating: true, notes: { sn: 'XxxXxxXxxXxxXxxXxx' } },
      { steps: 4, alternating: true, notes: { sn: 'xxXxxXxxXxxXxxXxxX' } },
      { steps: 4, alternating: true, notes: { hh: 'XxxxXxxxXxxxXxxxXx', sn: '----X-------X-----', bd: 'x-----x-----x-----' } },
      { steps: 4, alternating: true, notes: { cr: 'X-----------------', hh: '-xxx-xxx-xxx-xxx--', sn: '----X---XxXx------',
        t1: '--------------Xx--', f1: '----------------Xx', bd: 'x---x---x---------' } },
    ],
  },
  {
    id: 'inspired-tool-the-pot', title: 'Syncopated linear accents — The Pot',
    artist: 'Tool', track: 'The Pot',
    focus: 'syncopated kick and ghost-note answers',
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
    focus: 'laid-back half-feel, offbeat cymbal color and quiet snare ghosts',
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
    focus: 'straight-eighth train beat with backbeat accents and ghost taps',
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
    focus: 'driving sixteenth hats, kick shifts and crash punctuation',
    level: 7,
    bars: [
      { steps: 4, notes: { hh: 'XxxxXxxxXxxxXxxx', sn: '----X-------X---', bd: 'x-----x---x-----' } },
      { steps: 4, notes: { hh: 'XxxxXxxxXxxxXxxx', sn: '----X-------X---', bd: 'x--x----x-x-----' } },
      { steps: 4, notes: { rd: 'xXxxXxxxXxxxXxxx', sn: '----X--g----X---', bd: 'x---x---x-----x-' } },
      { steps: 4, alternating: true, notes: { cr: 'X---------------', hh: '-xxx-xxx-xxx-xxx', sn: '----X---XxxX----', t1: '------------Xx--', bd: 'x--x----x-----x-' } },
    ],
  },
  {
    id: 'inspired-phil-collins-in-the-air-tonight', title: 'A spacious build and tom answer — In the Air Tonight',
    artist: 'Phil Collins', track: 'In the Air Tonight',
    focus: 'gradual dynamic build and a tom response',
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
    focus: 'bright alternating hi-hat and syncopated kick',
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
    focus: 'a seven-eighth cell from the irregular verse cycle',
    level: 8, meter: { numerator: 7, denominator: 8 },
    bars: [
      { steps: 4, notes: { hh: 'X-xx-X-xX-xx-X', sn: '----X-----X---', bd: 'x---x---x---x-' } },
      { steps: 4, notes: { rd: 'x-xx-x-Xx-xx-x', sn: '------X-----X-', bd: 'x-----x---x---' } },
      { steps: 4, notes: { hh: 'X-xx-X-xX-xx-X', sn: '----X-------X-', bd: 'x---x-x-----x-' } },
      { steps: 4, alternating: true, notes: { cr: 'X-------------', hh: '-x-xx-X-x--x-X', sn: '----X-----X---', t1: '----------Xx--', f1: '------------Xx', bd: 'x---x---x---x-' } },
    ],
  },
  {
    id: 'inspired-pink-floyd-have-a-cigar', title: 'Straight rock pulse and a late fill — Have a Cigar',
    artist: 'Pink Floyd', track: 'Have a Cigar', focus: 'straight 4/4 rock pulse with syncopated kick answers',
    level: 7,
    bars: [
      { steps: 2, notes: { hh: 'xxxxxxxx', sn: '----X---', bd: 'x---x-x-' } },
      { steps: 2, notes: { hh: 'xxxxxxxx', sn: '----X---', bd: 'x--x-x--' } },
      { steps: 2, notes: { rd: 'XxXxXxXx', sn: '----X-g-', bd: 'x---xx--' } },
      { steps: 2, alternating: true, notes: { cr: 'X-------', hh: '-xxxx---', sn: '----XxXx', t1: '------x-', bd: 'x--x-x--' } },
    ],
  },
  {
    id: 'inspired-pink-floyd-us-and-them', title: 'Slow compound sway — Us and Them',
    artist: 'Pink Floyd', track: 'Us and Them', focus: 'slow 6/8 ballad pulse with broad backbeats and restrained cymbal color',
    level: 7, meter: { numerator: 6, denominator: 8 },
    bars: [
      { steps: 2, notes: { hh: 'x-x-x-', sn: '---X--', bd: 'x-----' } },
      { steps: 2, notes: { hh: 'x-x-x-', sn: '---X--', bd: 'x--x--' } },
      { steps: 2, notes: { rd: 'X-x-x-', sn: '---X-g', bd: 'x-----' } },
      { steps: 2, notes: { cr: 'X-----', hh: '-x-x-x', sn: '---X--', t1: '-----x', bd: 'x--x--' } },
    ],
  },
  {
    id: 'inspired-dire-straits-brothers-in-arms', title: 'Spacious backbeat and ride answer — Brothers in Arms',
    artist: 'Dire Straits', track: 'Brothers in Arms', focus: 'slow 4/4 ballad groove with long rests and quiet cymbal changes',
    level: 6,
    bars: [
      { steps: 2, notes: { rd: 'x---x---', sn: '----X---', bd: 'x-------' } },
      { steps: 2, notes: { rd: 'x---x---', sn: '----X---', bd: 'x-----x-' } },
      { steps: 2, notes: { hh: 'x-x-x-x-', sn: '----X---', bd: 'x-------' } },
      { steps: 2, alternating: true, notes: { cr: 'X-------', rd: '-x---x--', sn: '----X--g', t2: '------x-', bd: 'x-----x-' } },
    ],
  },
  {
    id: 'inspired-metallica-one', title: 'Quiet pulse into a firm backbeat — One',
    artist: 'Metallica', track: 'One', focus: '4/4 verse pulse that builds from sparse hats to a denser kick and snare',
    level: 7,
    bars: [
      { steps: 2, notes: { hh: 'x---x---', sn: '----X---', bd: 'x-------' } },
      { steps: 2, notes: { hh: 'x-x-x-x-', sn: '----X---', bd: 'x---x---' } },
      { steps: 2, notes: { hh: 'xxxxxxxx', sn: '--X---X-', bd: 'x---x-x-' } },
      { steps: 2, alternating: true, notes: { cr: 'X-------', hh: '-xxxxxxx', sn: '--X-x-X-', t1: '-------x', bd: 'x-xx-x-x' } },
    ],
  },
  {
    id: 'inspired-tool-aenema', title: 'Syncopated 4/4 tom ostinato — Ænema',
    artist: 'Tool', track: 'Ænema', focus: '4/4 verse groove with a steady tom figure under displaced accents',
    level: 8,
    bars: [
      { steps: 2, notes: { hh: 'x-x-x-x-', sn: '----X---', bd: 'x--x-x--', t1: '-x---x--' } },
      { steps: 2, notes: { hh: 'x-x-x-x-', sn: '----X---', bd: 'x---xx--', t1: '-x---x--' } },
      { steps: 2, notes: { rd: 'x-x-x-x-', sn: '--X---X-', bd: 'x--x-x--', t2: 'x---x---' } },
      { steps: 2, alternating: true, notes: { cr: 'X-------', hh: '-x-x-x-x', sn: '----XxX-', t1: 'x---x---', f1: '------x-', bd: 'x--x-x--' } },
    ],
  },
  {
    id: 'inspired-eagles-desperado', title: 'Restrained ballad groove — Desperado',
    artist: 'Eagles', track: 'Desperado', focus: 'slow 4/4 ballad with soft backbeats, sustained cymbals and a measured fill',
    level: 6,
    bars: [
      { steps: 2, notes: { rd: 'x---x---', sn: '----X---', bd: 'x-------' } },
      { steps: 2, notes: { rd: 'x---x---', sn: '----X---', bd: 'x-----x-' } },
      { steps: 2, notes: { hh: 'x---x---', sn: '---gX---', bd: 'x-------' } },
      { steps: 2, alternating: true, notes: { cr: 'X-------', rd: '-x---x--', sn: '----X---', t2: '------x-', bd: 'x-----x-' } },
    ],
  },
  {
    id: 'inspired-genesis-mama', title: 'Measured pulse with a dark build — Mama',
    artist: 'Genesis', track: 'Mama', focus: '4/4 verse pulse that grows from a machine-like pattern into a full backbeat',
    level: 7,
    bars: [
      { steps: 2, notes: { hh: 'x---x---', bd: 'x---x---' } },
      { steps: 2, notes: { hh: 'x-x-x-x-', bd: 'x---x---' } },
      { steps: 2, notes: { hh: 'xxxxxxxx', sn: '----X---', bd: 'x---x-x-' } },
      { steps: 2, alternating: true, notes: { cr: 'X-------', hh: '-xxxxxxx', sn: '----X-xX', t1: '-----x--', bd: 'x-x-x-x-' } },
    ],
  },
  {
    id: 'inspired-police-walking-on-the-moon', title: 'Offbeat space and a one-drop answer — Walking on the Moon',
    artist: 'The Police', track: 'Walking on the Moon', focus: '4/4 reggae-tinged groove with sparse offbeat cymbal and kick-snare answers',
    level: 6,
    bars: [
      { steps: 2, notes: { hh: '-x---x--', sn: '------X-', bd: '------x-' } },
      { steps: 2, notes: { hh: '-x---x--', sn: '------X-', bd: 'x-----x-' } },
      { steps: 2, notes: { rd: '-x-x-x-x', sn: '------X-', bd: '------x-' } },
      { steps: 2, alternating: true, notes: { cr: 'X-------', hh: '-x-x----', sn: '------Xg', t1: '------x-', bd: 'x-----x-' } },
    ],
  },
  {
    id: 'inspired-led-zeppelin-when-the-levee-breaks', title: 'Slow triplet weight — When the Levee Breaks',
    artist: 'Led Zeppelin', track: 'When the Levee Breaks', focus: 'slow 4/4 half-time shuffle with a heavy kick and roomy snare',
    level: 7,
    bars: [
      { steps: 3, notes: { hh: 'x-xx-xx-xx-x', sn: '------X-----', bd: 'x-----x-----' } },
      { steps: 3, notes: { hh: 'x-xx-xx-xx-x', sn: '------X-----', bd: 'x---xx------' } },
      { steps: 3, notes: { rd: 'x-xx-xx-xx-x', sn: '---g--X-----', bd: 'x-----x-----' } },
      { steps: 3, alternating: true, notes: { cr: 'X-----------', hh: '--xx-xx-----', sn: '------XxXx--', t1: '----------X-', bd: 'x-----x-----' } },
    ],
  },
  {
    id: 'inspired-beatles-ticket-to-ride', title: 'Driving eighths and a heavy backbeat — Ticket to Ride',
    artist: 'The Beatles', track: 'Ticket to Ride', focus: '4/4 rock pulse with a broad backbeat and changing kick accents',
    level: 6,
    bars: [
      { steps: 2, notes: { hh: 'xxxxxxxx', sn: '--X---X-', bd: 'x---x---' } },
      { steps: 2, notes: { hh: 'xxxxxxxx', sn: '--X---X-', bd: 'x--x-x--' } },
      { steps: 2, notes: { rd: 'x-x-x-x-', sn: '--X---X-', bd: 'x---x-x-' } },
      { steps: 2, alternating: true, notes: { cr: 'X-------', hh: '-xxxxxxx', sn: '--X-x-X-', t1: '-------x', bd: 'x--x-x--' } },
    ],
  },
  {
    id: 'inspired-rush-limelight', title: 'Steady verse pulse with a tom response — Limelight',
    artist: 'Rush', track: 'Limelight', focus: 'driving 4/4 verse groove with crisp eighths and a compact tom answer',
    level: 7,
    bars: [
      { steps: 2, notes: { rd: 'XxXxXxXx', sn: '--X---X-', bd: 'x---x---' } },
      { steps: 2, notes: { rd: 'XxXxXxXx', sn: '--X---X-', bd: 'x--x-x--' } },
      { steps: 2, notes: { hh: 'xxxxxxxx', sn: '--X---X-', bd: 'x---xx--' } },
      { steps: 2, alternating: true, notes: { cr: 'X-------', rd: '-xxxxxxx', sn: '--X---X-', t1: '-----x--', f1: '-------X', bd: 'x--x-x--' } },
    ],
  },
  {
    id: 'inspired-james-brown-i-got-you', title: 'Bright backbeat and clipped ghost notes — I Got You (I Feel Good)',
    artist: 'James Brown', track: 'I Got You (I Feel Good)', focus: 'fast 4/4 soul groove with crisp backbeats, ghost notes and syncopated kick',
    level: 7,
    bars: [
      { steps: 4, notes: { hh: 'XxxxXxxxXxxxXxxx', sn: '----X--g----X--g', bd: 'x--x----x---x---' } },
      { steps: 4, notes: { hh: 'XxxxXxxxXxxxXxxx', sn: '----X-g-----X--g', bd: 'x---x-x---x-----' } },
      { steps: 4, notes: { rd: 'XxxxXxxxXxxxXxxx', sn: '----X--g-g--X---', bd: 'x--x---x----x---' } },
      { steps: 4, alternating: true, notes: { cr: 'X---------------', hh: '-xxx-xxx-xxx----', sn: '----X--gXxXx----', t1: '------------Xx--', bd: 'x--x---x----x---' } },
    ],
  },
]

const TEACHING: Record<string, Teaching> = {
  'inspired-pink-floyd-money': {
    goal: 'play a seven-quarter cycle grouped 3 + 2 + 2, with a steady eighth-note hat, shifting backbeats and a phrase-end pickup.',
    tempo: { start: 91, target: 130 }, limbs: 'Right hand: hi-hat or ride · Left hand: snare · Right foot: kick',
    steps: ['Count each bar as 1-2-3, 1-2, 1-2; do not shorten the final pair.',
      'Bars 1–2 set the kick on each group start; bar 3 changes to ride and answers with a displaced snare.',
      'Bar 4 adds a tom descent across beats 5–7, then returns to the opening hat pulse.'],
  },
  'inspired-pink-floyd-time': {
    goal: 'grow from a spacious quarter-note pulse into a four-beat tom conversation, then release back to a single crash.',
    tempo: { start: 84, target: 120 }, limbs: 'Right hand: hi-hat, then ride · Left hand: snare · Both hands: toms · Right foot: kick',
    steps: ['Bars 1–2 stay sparse: play the hat on quarter notes and leave the spaces open.',
      'Bar 2 answers the snare with a soft high tom; bar 3 answers on the lower tom and opens the ride.',
      'Bar 4 builds with a snare-to-tom descent, accents the final tom, then drops back to bar 1.'],
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
    tempo: { start: 105, target: 150 }, limbs: 'Right hand: ride or hi-hat · Left hand: snare and toms · Right foot: kick',
    steps: ['Play the ride on the first and last triplet of each beat; keep the middle space relaxed.',
      'Use the written g notes as quiet snare taps and reserve X for the backbeat.',
      'Bar 3 moves the shuffle to hi-hat; bar 4 answers with a short tom pickup into the first beat.'],
  },
  'inspired-dire-straits-money-for-nothing': {
    goal: 'begin with low tom punctuation, open into a broad half-time backbeat, then answer it with a short floor-tom release.',
    tempo: { start: 98, target: 140 }, limbs: 'Right hand: crash or hi-hat · Left hand: snare and toms · Right foot: kick',
    steps: ['Bars 1–2 are an intro texture: let the floor tom answer the kick, with no busy cymbal pattern.',
      'Bar 3 brings in the snare on beat 3 and a wide, accented ride pulse.',
      'Bar 4 keeps the backbeat, then walks two low tom notes toward bar 1.'],
  },
  'inspired-dire-straits-walk-of-life': {
    goal: 'a bouncy country shuffle: keep the outer triplet cymbal notes light, put broad snare accents on 2 and 4, and add a kick pickup.',
    tempo: { start: 119, target: 170 }, limbs: 'Right hand: hi-hat or ride · Left hand: snare · Right foot: kick',
    steps: ['Count triplets evenly; the ride plays the first and last subdivision of each beat.',
      'Keep snare accents on beats 2 and 4; add the quiet ghost note only in bar 2.',
      'Bar 3 moves to ride accents; bar 4 closes with three tom notes into the opening shuffle.'],
  },
  'inspired-metallica-enter-sandman': {
    goal: 'a mid-tempo heavy groove with an even hat, kick variations under a firm backbeat and crash accents at phrase starts.',
    tempo: { start: 87.5, target: 125 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Lock the eighth-note hat and accented snare on 2 and 4 before adding the kick.',
      'Bars 1–2 change only the kick; keep the backbeat broad and even.',
      'Bar 3 moves to ride; bar 4 uses a crash on 1 and a short snare answer to reset the groove.'],
  },
  'inspired-metallica-master-of-puppets': {
    goal: 'alternate a fast kick drive with sixteenth-note bursts and snare accents, then release through a descending tom fill.',
    tempo: { start: 77, target: 110 }, limbs: 'Right hand: crash or ride · Left hand: snare and toms · Right foot: kick',
    steps: ['Bars 1–2 alternate kick strokes evenly; count sixteenths and keep every double controlled.',
      'Bar 3 answers the kick pattern with a snare burst; do not let the kick speed up.',
      'Bar 4 trades snare and tom sixteenths, accents the final tom and returns to the top.'],
  },
  'inspired-metallica-sad-but-true': {
    goal: 'make a slow half-time pocket feel heavy through long rests, low kick notes and one deliberate backbeat.',
    tempo: { start: 70, target: 100 }, limbs: 'Right hand: sparse hi-hat or ride · Left hand: snare and floor tom · Right foot: kick',
    steps: ['Count all four beats, including the empty beats around the snare on 3.',
      'Use the crash only at the opening; keep the hat or ride sparse and let notes ring.',
      'Bar 4 answers with a low tom note after the backbeat, then leave space before bar 1.'],
  },
  'inspired-tool-schism': {
    goal: 'play a seven-eighth cell from the alternating riff with a steady tom ostinato and a kick at each group start.',
    tempo: { start: 119, target: 170 }, limbs: 'Right hand: toms · Left hand: snare and toms · Right foot: kick',
    steps: ['Count the 7/8 cell in sixteenths and keep the kick on the 3+2+2 group starts.',
      'Maintain the high-tom ostinato while the snare accents answer it.',
      'Bar 4 moves the final answer down the toms, then returns to the riff’s 5/8 cell.'],
  },
  'inspired-tool-lateralus': {
    goal: 'keep a sixteenth-note single-stroke stream even while the accent group shifts one note later on each bar.',
    tempo: { start: 40.6, target: 58 }, limbs: 'Both hands: alternating snare · Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Count the 9/8 bar as 18 even sixteenths and keep alternating R L.',
      'Move the accent through the first 9/8 cell, then let the next measure begin the shorter group.',
      'Bar 4 uses a crash and tom answer before the cycle continues into 8/8 and 7/8.'],
  },
  'inspired-tool-the-pot': {
    goal: 'interlock sixteenth hats, syncopated kick and ghost-note snare answers, with a final linear turnaround.',
    tempo: { start: 73.5, target: 105 }, limbs: 'Right hand: hi-hat or ride · Left hand: snare · Right foot: kick',
    steps: ['Keep the hat even while the kick moves between sixteenth positions.',
      'Play g softly and X at full height; the ghost notes answer the kick rather than doubling it.',
      'Bar 4 changes to ride and crash, then leaves the last subdivision clear for the loop.'],
  },
  'inspired-eagles-hotel-california': {
    goal: 'a laid-back half-feel with offbeat hat color, soft snare ghosts and a sparse kick that leaves room for the phrase.',
    tempo: { start: 56, target: 80 }, limbs: 'Right hand: ride or hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Play the ride lightly and keep the kick on the widely spaced quarter notes.',
      'Place g before the accented snare; let the offbeat pulse sit behind the count.',
      'Bar 3 moves to hi-hat; bar 4 adds a crash pickup but keeps the half-time space.'],
  },
  'inspired-eagles-take-it-easy': {
    goal: 'a rolling country-rock train beat: keep straight eighths on the cymbal, alternate snare accents and ghost taps, and let the kick walk.',
    tempo: { start: 98, target: 140 }, limbs: 'Right hand: hi-hat or ride · Left hand: snare · Right foot: kick',
    steps: ['Keep the right hand on eighth notes and count every "&" evenly.',
      'The left hand accents each beat and uses g for the quiet eighth-note responses.',
      'Bars 2–3 change the kick and cymbal; bar 4 adds a crash and a short tom pickup before returning to the train beat.'],
  },
  'inspired-eagles-life-in-fast-lane': {
    goal: 'drive with sixteenth hats, a firm backbeat and syncopated kick changes before a snare-to-tom release.',
    tempo: { start: 77, target: 110 }, limbs: 'Right hand: hi-hat or ride · Left hand: snare · Right foot: kick',
    steps: ['Count 1 e & a continuously and keep the right hand moving through all sixteen hat strokes.',
      'Bars 1–2 shift the kick under the same backbeat; bar 3 accents the ride and adds a ghost.',
      'Bar 4 opens on crash, runs snare sixteenths into tom 1 and releases back to the hat.'],
  },
  'inspired-phil-collins-in-the-air-tonight': {
    goal: 'build from a sparse pulse to a descending tom conversation, with space before and after the payoff.',
    tempo: { start: 66.5, target: 95 }, limbs: 'Right hand: hi-hat · Left hand: snare and toms · Right foot: kick',
    steps: ['Bars 1–2 use only a few hat and kick notes; hold the dynamic down and leave the gaps silent.',
      'Bar 3 adds a strong snare backbeat and a busier hat to create the build.',
      'Bar 4 plays a snare-to-tom descent; accent the floor tom, then release.'],
  },
  'inspired-phil-collins-easy-lover': {
    goal: 'drive a pop-rock phrase with alternating sixteenth hats, strong beat accents and a kick that answers the backbeat.',
    tempo: { start: 87.5, target: 125 }, limbs: 'Both hands: alternating hi-hat; left hand: snare · Right foot: kick',
    steps: ['Alternate R L across the sixteenth hats; accents stay on the four quarter-note beats.',
      'Move the kick under the same hand pattern in bars 2–3; keep the snare backbeat full.',
      'Bar 4 opens with a crash, then drops back to lighter hats for the loop.'],
  },
  'inspired-genesis-turn-it-on-again': {
    goal: 'play the 7/8 portion of the 13/8 verse cycle with changing group accents and a kick pickup into the next bar.',
    tempo: { start: 182, target: 260 }, limbs: 'Right hand: hi-hat or ride · Left hand: snare · Right foot: kick',
    steps: ['Count the seven-eighth measure as 2+2+3 within the repeating 13/8 verse cycle.',
      'Keep the kick pulse steady while the cymbal accents mark the short groups.',
      'Bar 4 uses the final crash as the pickup back to the cycle’s 6/4 portion.'],
  },
  'inspired-pink-floyd-have-a-cigar': {
    goal: 'a steady straight-rock pulse with kick syncopations and a compact snare answer.',
    tempo: { start: 80.5, target: 115 }, limbs: 'Right hand: hi-hat, then ride · Left hand: snare · Right foot: kick',
    steps: ['Bars 1–2 keep the eighth-note hat even and move only the kick.',
      'Bar 3 shifts the pulse to ride and adds a quiet snare response.',
      'Bar 4 opens with a crash and a short tom pickup before the groove returns.'],
  },
  'inspired-pink-floyd-us-and-them': {
    goal: 'a slow 6/8 ballad groove with broad snare placements and a restrained cymbal lift.',
    tempo: { start: 39.2, target: 56 }, limbs: 'Right hand: hi-hat or ride · Left hand: snare · Right foot: kick',
    steps: ['Count six eighth notes in two groups of three and keep the hats light.',
      'Keep the snare broad and quiet at its response point.',
      'Bar 4 uses a crash and one tom answer, then returns to the open pulse.'],
  },
  'inspired-dire-straits-brothers-in-arms': {
    goal: 'a spacious slow-rock backbeat with long cymbal notes and a measured low-drum answer.',
    tempo: { start: 54.6, target: 78 }, limbs: 'Right hand: ride or hi-hat · Left hand: snare and toms · Right foot: kick',
    steps: ['Leave room between the ride notes and keep the kick soft.',
      'Hold the backbeat steady while the cymbal changes in bar 3.',
      'Bar 4 ends with one low tom response, then returns to the first sparse bar.'],
  },
  'inspired-metallica-one': {
    goal: 'build a 4/4 verse pulse from sparse eighths to a firm backbeat and a denser kick answer.',
    tempo: { start: 77, target: 110 }, limbs: 'Right hand: hi-hat · Left hand: snare and toms · Right foot: kick',
    steps: ['Bars 1–2 stay sparse and let each kick ring.',
      'Add the backbeat in bar 3 without changing the eighth-note count.',
      'Bar 4 raises the energy with a short tom answer, then resets to the quiet opening.'],
  },
  'inspired-tool-aenema': {
    goal: 'hold a syncopated 4/4 verse groove while a tom ostinato repeats under displaced accents.',
    tempo: { start: 64.4, target: 92 }, limbs: 'Right hand: hi-hat or ride · Left hand: snare and toms · Right foot: kick',
    steps: ['Keep the tom ostinato level as the kick changes around it.',
      'Move the snare accents between backbeats and offbeats.',
      'Bar 4 descends across the toms and returns to the main 4/4 groove.'],
  },
  'inspired-eagles-desperado': {
    goal: 'support a slow 4/4 ballad with a soft backbeat, long cymbal notes and one quiet fill.',
    tempo: { start: 52.5, target: 75 }, limbs: 'Right hand: ride · Left hand: snare and toms · Right foot: kick',
    steps: ['Keep the ride sparse and let the kick mark the long pulse.',
      'Play the snare softly, with no extra notes between backbeats.',
      'Bar 4 adds one tom answer and a crash before the ballad groove returns.'],
  },
  'inspired-genesis-mama': {
    goal: 'grow a dark 4/4 pulse from a restrained machine-like pattern to a full backbeat.',
    tempo: { start: 63, target: 90 }, limbs: 'Right hand: hi-hat · Left hand: snare and toms · Right foot: kick',
    steps: ['Bars 1–2 use only the sparse hat and kick pattern.',
      'Add the snare in bar 3 and keep the pulse even as the texture fills out.',
      'Bar 4 adds a tom answer under the crash, then drops back to the opening level.'],
  },
  'inspired-police-walking-on-the-moon': {
    goal: 'leave space around a slow 4/4 one-drop feel with offbeat cymbal notes and a quiet snare answer.',
    tempo: { start: 101.5, target: 145 }, limbs: 'Right hand: hi-hat · Left hand: snare · Right foot: kick',
    steps: ['Play the cymbal only on its written offbeats and let the rests ring.',
      'Keep kick and snare together at the late backbeat point.',
      'Bar 4 adds a quiet ghost and tom pickup, then returns to the open groove.'],
  },
  'inspired-led-zeppelin-when-the-levee-breaks': {
    goal: 'make a slow half-time shuffle feel heavy with broad kick and snare strokes.',
    tempo: { start: 49, target: 70 }, limbs: 'Right hand: hi-hat or ride · Left hand: snare and toms · Right foot: kick',
    steps: ['Count the triplet subdivision slowly and keep the cymbal pattern wide.',
      'Let the kick and snare land heavily without adding extra notes.',
      'Bar 4 answers with a small tom move before the main shuffle returns.'],
  },
  'inspired-beatles-ticket-to-ride': {
    goal: 'drive a 4/4 rock groove with an accented backbeat and changing kick placement.',
    tempo: { start: 87.5, target: 125 }, limbs: 'Right hand: hi-hat or ride · Left hand: snare and toms · Right foot: kick',
    steps: ['Keep the eighth-note cymbal steady through bars 1–2.',
      'Shift the kick while the backbeat stays in place.',
      'Bar 4 adds a compact tom pickup and resolves to the opening cymbal pulse.'],
  },
  'inspired-rush-limelight': {
    goal: 'keep an even 4/4 verse groove under a changing cymbal and tom response.',
    tempo: { start: 91, target: 130 }, limbs: 'Right hand: ride or hi-hat · Left hand: snare and toms · Right foot: kick',
    steps: ['Accent the ride while keeping the kick and backbeat steady.',
      'Move to hi-hat in bar 3 and shift the kick pickup.',
      'Bar 4 finishes with a brief tom descent, then returns to the verse pulse.'],
  },
  'inspired-james-brown-i-got-you': {
    goal: 'play a bright 4/4 soul groove with tight backbeats, ghost-note snare and syncopated kick.',
    tempo: { start: 101.5, target: 145 }, limbs: 'Right hand: hi-hat or ride · Left hand: snare · Right foot: kick',
    steps: ['Keep the cymbal eighths even and make the snare backbeats clear.',
      'Ghost the quieter snare notes and move the kick around them.',
      'Bar 4 brings a crash and a short snare-to-tom answer back to the groove.'],
  },
}

const REFERENCE: Record<string, { artist: string; track: string; section: string; fidelity: { meter: string; feel: string; tempo: number } }> = {
  'inspired-reggae-rock-hats': { artist: 'The Police', track: 'Roxanne', section: 'verse groove', fidelity: { meter: '4/4', feel: 'syncopated offbeat accents with a reggae-tinged pulse; quarter-note tempo', tempo: 133 } },
  'inspired-heavy-triplet-fill': { artist: 'Led Zeppelin', track: 'Good Times Bad Times', section: 'verse groove', fidelity: { meter: '4/4', feel: 'heavy straight eighths with triplet-shaped kick accents; quarter-note tempo', tempo: 94 } },
  'inspired-sparse-fill': { artist: 'The Beatles', track: 'Come Together', section: 'verse groove', fidelity: { meter: '4/4', feel: 'laid-back half-time pulse with tom and snare answers; quarter-note tempo', tempo: 84 } },
  'inspired-tom-orchestration': { artist: 'Rush', track: 'Tom Sawyer', section: 'verse groove', fidelity: { meter: '4/4', feel: 'driving straight subdivision with accents and broad tom answers; quarter-note tempo', tempo: 88 } },
  'inspired-half-time-shuffle': { artist: 'Toto', track: 'Rosanna', section: 'verse shuffle', fidelity: { meter: '4/4', feel: 'half-time shuffle with triplet subdivisions and snare ghosts; quarter-note tempo', tempo: 87 } },
  'inspired-funk-syncopation': { artist: 'James Brown', track: 'Funky Drummer', section: 'drum-break groove', fidelity: { meter: '4/4', feel: 'straight sixteenths with syncopated kick and soft snare ghosts; quarter-note tempo', tempo: 101 } },
  'inspired-rudimental-groove': { artist: 'Paul Simon', track: '50 Ways to Leave Your Lover', section: 'verse groove', fidelity: { meter: '4/4', feel: 'syncopated snare accents over a steady pop pulse; quarter-note tempo', tempo: 103 } },
  'inspired-odd-meter': { artist: 'Tool', track: 'Forty Six & 2', section: 'bridge groove', fidelity: { meter: '7/8', feel: 'bridge meter with rolling sixteenths and tom accents; eighth-note pulse', tempo: 158 } },
  'inspired-pink-floyd-money': { artist: 'Pink Floyd', track: 'Money', section: 'verse riff', fidelity: { meter: '7/4', feel: 'straight eighths grouped 3+2+2; quarter-note pulse', tempo: 126 } },
  'inspired-pink-floyd-time': { artist: 'Pink Floyd', track: 'Time', section: 'main verse', fidelity: { meter: '4/4', feel: 'steady quarter pulse with tom and snare answers; quarter-note tempo', tempo: 120 } },
  'inspired-pink-floyd-another-brick': { artist: 'Pink Floyd', track: 'Another Brick in the Wall, Part 2', section: 'verse groove', fidelity: { meter: '4/4', feel: 'disco-influenced backbeat and steady eighth-note pocket; quarter-note tempo', tempo: 105 } },
  'inspired-dire-straits-sultans': { artist: 'Dire Straits', track: 'Sultans of Swing', section: 'verse shuffle', fidelity: { meter: '4/4', feel: 'light swung eighths, snare ghosts and accented backbeats; quarter-note tempo', tempo: 148 } },
  'inspired-dire-straits-money-for-nothing': { artist: 'Dire Straits', track: 'Money for Nothing', section: 'intro into verse', fidelity: { meter: '4/4', feel: 'slow-feeling tom-led intro into a broad half-time backbeat; quarter-note tempo', tempo: 135 } },
  'inspired-dire-straits-walk-of-life': { artist: 'Dire Straits', track: 'Walk of Life', section: 'verse shuffle', fidelity: { meter: '4/4', feel: 'bouncy shuffle with a steady kick and backbeat; quarter-note tempo', tempo: 172 } },
  'inspired-metallica-enter-sandman': { artist: 'Metallica', track: 'Enter Sandman', section: 'main verse groove', fidelity: { meter: '4/4', feel: 'mid-tempo heavy eighth-note groove with crash accents; quarter-note tempo', tempo: 123 } },
  'inspired-metallica-master-of-puppets': { artist: 'Metallica', track: 'Master of Puppets', section: 'main riff', fidelity: { meter: '4/4', feel: 'fast alternate-picked eighths and sixteenth kick bursts; quarter-note pulse', tempo: 108 } },
  'inspired-metallica-sad-but-true': { artist: 'Metallica', track: 'Sad But True', section: 'verse groove', fidelity: { meter: '4/4', feel: 'slow, spacious half-time weight; quarter-note tempo', tempo: 96 } },
  'inspired-tool-schism': { artist: 'Tool', track: 'Schism', section: '7/8 bar in the alternating riff', fidelity: { meter: '7/8', feel: 'one 7/8 cell from the alternating 5/8–7/8 riff; eighth-note pulse', tempo: 168 } },
  'inspired-tool-lateralus': { artist: 'Tool', track: 'Lateralus', section: '9/8 measure of the verse cycle', fidelity: { meter: '9/8', feel: 'first cell of the 9/8–8/8–7/8 cycle; dotted-quarter pulse', tempo: 58 } },
  'inspired-tool-the-pot': { artist: 'Tool', track: 'The Pot', section: 'main verse groove', fidelity: { meter: '4/4', feel: 'syncopated straight sixteenths with ghost-note snare; quarter-note tempo', tempo: 106 } },
  'inspired-eagles-hotel-california': { artist: 'Eagles', track: 'Hotel California', section: 'verse groove', fidelity: { meter: '4/4', feel: 'laid-back half-feel and restrained cymbal pulse; quarter-note tempo', tempo: 75 } },
  'inspired-eagles-take-it-easy': { artist: 'Eagles', track: 'Take It Easy', section: 'verse train beat', fidelity: { meter: '4/4', feel: 'straight eighth-note train beat with a relaxed backbeat; quarter-note tempo', tempo: 138 } },
  'inspired-eagles-life-in-fast-lane': { artist: 'Eagles', track: 'Life in the Fast Lane', section: 'verse groove', fidelity: { meter: '4/4', feel: 'driving sixteenth hats and steady backbeat; quarter-note tempo', tempo: 112 } },
  'inspired-phil-collins-in-the-air-tonight': { artist: 'Phil Collins / Genesis', track: 'In the Air Tonight', section: 'build into the drum entrance', fidelity: { meter: '4/4', feel: 'sparse build with a measured tom descent; quarter-note tempo', tempo: 95 } },
  'inspired-phil-collins-easy-lover': { artist: 'Phil Collins / Genesis', track: 'Easy Lover', section: 'chorus groove', fidelity: { meter: '4/4', feel: 'driving sixteenth-note pop-rock pulse; quarter-note tempo', tempo: 125 } },
  'inspired-genesis-turn-it-on-again': { artist: 'Phil Collins / Genesis', track: 'Turn It On Again', section: '7/8 measure of the 13/8 verse cycle', fidelity: { meter: '7/8', feel: 'one 7/8 cell within the repeating 13/8 verse cycle; eighth-note pulse', tempo: 256 } },
  'inspired-genesis-mama': { artist: 'Phil Collins / Genesis', track: 'Mama', section: 'verse groove', fidelity: { meter: '4/4', feel: 'dark, machine-like pulse growing into a full backbeat; quarter-note tempo', tempo: 89 } },
  'inspired-pink-floyd-have-a-cigar': { artist: 'Pink Floyd', track: 'Have a Cigar', section: 'verse groove', fidelity: { meter: '4/4', feel: 'straight rock pulse and syncopated kick; quarter-note tempo', tempo: 116 } },
  'inspired-pink-floyd-us-and-them': { artist: 'Pink Floyd', track: 'Us and Them', section: 'verse ballad groove', fidelity: { meter: '6/8', feel: 'slow compound sway with a dotted-quarter pulse', tempo: 56 } },
  'inspired-dire-straits-brothers-in-arms': { artist: 'Dire Straits', track: 'Brothers in Arms', section: 'verse ballad groove', fidelity: { meter: '4/4', feel: 'spacious slow-rock backbeat; quarter-note tempo', tempo: 78 } },
  'inspired-metallica-one': { artist: 'Metallica', track: 'One', section: 'verse before the build', fidelity: { meter: '4/4', feel: 'restrained verse pulse before the later double-time build; quarter-note tempo', tempo: 108 } },
  'inspired-tool-aenema': { artist: 'Tool', track: 'Ænema', section: 'main verse groove', fidelity: { meter: '4/4', feel: 'syncopated verse groove under a repeating tom figure; quarter-note tempo', tempo: 92 } },
  'inspired-eagles-desperado': { artist: 'Eagles', track: 'Desperado', section: 'verse ballad groove', fidelity: { meter: '4/4', feel: 'slow ballad backbeat and sustained cymbal; quarter-note tempo', tempo: 73 } },
  'inspired-police-walking-on-the-moon': { artist: 'The Police', track: 'Walking on the Moon', section: 'verse groove', fidelity: { meter: '4/4', feel: 'sparse reggae-tinged offbeats; quarter-note tempo', tempo: 146 } },
  'inspired-led-zeppelin-when-the-levee-breaks': { artist: 'Led Zeppelin', track: 'When the Levee Breaks', section: 'main groove', fidelity: { meter: '4/4', feel: 'heavy half-time shuffle with a broad backbeat; half-time pulse', tempo: 72 } },
  'inspired-beatles-ticket-to-ride': { artist: 'The Beatles', track: 'Ticket to Ride', section: 'verse groove', fidelity: { meter: '4/4', feel: 'driving rock backbeat and changing kick accents; quarter-note tempo', tempo: 123 } },
  'inspired-rush-limelight': { artist: 'Rush', track: 'Limelight', section: 'verse groove', fidelity: { meter: '4/4', feel: 'steady driving rock pulse; quarter-note tempo', tempo: 131 } },
  'inspired-james-brown-i-got-you': { artist: 'James Brown', track: 'I Got You (I Feel Good)', section: 'verse groove', fidelity: { meter: '4/4', feel: 'bright soul backbeat and clipped syncopation; quarter-note tempo', tempo: 144 } },
}

export const INSPIRED_LESSONS: Lesson[] = studies.map((study) => {
  const meter = study.meter ?? { numerator: 4, denominator: 4 }
  const teaching = TEACHING[study.id]
  const reference = REFERENCE[study.id]
  return {
    id: study.id, collection: 'inspired', style: `Inspired by ${study.artist} — ${study.track}`,
    ...reference, artist: reference.artist, track: reference.track,
    feel: study.focus, level: study.level, title: study.title,
    goal: teaching.goal.charAt(0).toUpperCase() + teaching.goal.slice(1),
    meter, tempo: teaching.tempo, limbs: teaching.limbs, steps: teaching.steps,
    bars: study.bars.map((pattern) => makeBar(pattern, meter)),
  }
})
