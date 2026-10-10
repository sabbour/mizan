import type { Lesson, LessonBar, Voice } from './curriculum'

/**
 * The genre lessons after each style's first groove: two variations, a fill and a four-bar phrase, in that order.
 * Every pattern is original, written for practice in the style; none is a transcription of a recording.
 */

const FEET: Voice[] = ['bd', 'hp']
const CYMBALS: Voice[] = ['hh', 'rd', 'cr']
const COUNTS: Record<number, string> = {
  2: '1 & 2 & 3 & 4 &',
  3: '1 trip let 2 trip let 3 trip let 4 trip let',
  4: '1 e & a 2 e & a 3 e & a 4 e & a',
}
const TWELVE = Array.from({ length: 12 }, (_, i) => String(i + 1))

/**
 * One bar in 4/4 (or 12/8 when `twelve`), with its count and sticking. Until step `from`, a single hand note is
 * played by the right hand on a cymbal and the left hand on a drum; from `from` on, single hand notes alternate
 * R L starting with the right. Two hands together are always R+L.
 */
function bar(steps: number, notes: LessonBar['notes'], options: { from?: number; twelve?: boolean } = {}): LessonBar {
  const { from = Infinity, twelve = false } = options
  const length = Math.max(...Object.values(notes).map((pattern) => pattern.length))
  const strokes: string[] = []
  let alternate = 0
  for (let step = 0; step < length; step++) {
    const hands = (Object.keys(notes) as Voice[]).filter((voice) => !FEET.includes(voice) && (notes[voice]![step] ?? '-') !== '-')
    if (hands.length === 2) strokes.push('R+L')
    else if (hands.length === 1) strokes.push(step >= from ? (alternate++ % 2 ? 'L' : 'R') : CYMBALS.includes(hands[0]) ? 'R' : 'L')
  }
  const count = twelve ? (steps === 2 ? TWELVE : TWELVE.flatMap((n) => [n, '&'])).join(' ') : COUNTS[steps]
  return { steps, count, sticking: strokes.join(' '), notes }
}
const twice = (one: LessonBar) => [one, one]
const groove = (bars: number, fill = true) => fill ? [{ name: 'Groove', bars }, { name: 'Fill', bars: 1 }] : undefined
const meter = { numerator: 4, denominator: 4 }
const HAT = 'Right hand: hi-hat · Left hand: snare · Right foot: kick'
const HAT_PEDAL = `${HAT} · Left foot: hi-hat pedal`
const FILL_HANDS = 'Right hand: hi-hat, then snare and toms · Left hand: snare and toms · Right foot: kick'

// Bars shared inside one genre's lessons.
const ROCK_A = bar(2, { hh: 'xxxxxxxx', sn: '--X---X-', bd: 'x---xx--' })
const ROCK_B = bar(2, { hh: 'xxxxxxxx', sn: '--X---X-', bd: 'x--x-x--' })
const ROCK_CRASH = bar(2, { cr: 'x-------', hh: '-xxxxxxx', sn: '--X---X-', bd: 'x---xx--' })
const BLUES_CRASH = bar(3, { cr: 'x-----------', hh: '--xx-xx-xx-x', sn: '---X-----X--', bd: 'x-----x-----' })
const BLUES_DOUBLE = bar(3, { hh: 'x-xx-xx-xx-x', sn: 'g-gX-gg-gX-g', bd: 'x-----x-----' })
const BLUES_RIDE = bar(3, { rd: 'x-xx-xx-xx-x', sn: '---X-----X--', bd: 'x----xx-----', hp: '---x-----x--' })
const ROCKERS = bar(3, { hh: 'x-xx-xx-xx-x', sn: '------x-----', bd: 'x--x--x--x--' })
const DROP_CRASH = bar(3, { cr: 'x-----------', hh: '--xx-xx-xx-x', sn: '------x-----', bd: '------x-----' })
const DROP_OPEN = bar(3, { hh: 'x-xx-ox-xx-x', sn: '------x----g', bd: '------x-----', hp: '------x-----' })
const POP = bar(4, { hh: 'Xxxx-xxxXxxx-xxx', sn: '----X-------X---', bd: 'x------xx-------' }, { from: 0 })
const POP_CRASH = bar(4, { cr: 'x---------------', hh: '-xxx-xxxXxxx-xxx', sn: '----X-------X---', bd: 'x------xx-------' }, { from: 0 })
const POP_KICK = bar(4, { hh: 'Xxxx-xxxXxxx-xxx', sn: '----X-------X---', bd: 'x-x----xx-------' }, { from: 0 })
const DISCO = bar(2, { hh: 'xoxoxoxo', sn: '--X---X-', bd: 'x-x-x-x-', hp: 'x-x-x-x-' })
const DISCO_CRASH = bar(2, { cr: 'x-------', hh: '-oxoxoxo', sn: '--X---X-', bd: 'x-x-x-x-', hp: 'x-x-x-x-' })
const DISCO_SIXTEENS = bar(4, { hh: 'xxox-xoxxxox-xox', sn: '----X-------X---', bd: 'x---x---x---x---' }, { from: 0 })
const SWING = { rd: 'x--X-xx--X-x', hp: '---x-----x--' }
const JAZZ_COMP = bar(3, { ...SWING, sn: '-----g-----g', bd: 'g--g--g--g--' })
const JAZZ_KICKS = bar(3, { ...SWING, sn: '--g-----g---', bd: '-----x-----x' })
const JAZZ = bar(3, { ...SWING, sn: '--------g---', bd: 'g--g--g--g--' })
const JAZZ_CRASH = bar(3, { cr: 'x-----------', rd: '---X-xx--X-x', hp: '---x-----x--', sn: '--------g---', bd: 'x--g--g--g--' })
const JAZZ_COMP_CRASH = bar(3, { cr: 'x-----------', rd: '---X-xx--X-x', hp: '---x-----x--', sn: '-----g-----g', bd: 'x--g--g--g--' })
const BOSSA = { bd: 'x--xx--x', hp: '--x---x-' }
const BOSSA_ONE = bar(2, { rd: 'xxxxxxxx', sn: 'x--x--x-', ...BOSSA })
const BOSSA_CRASH = bar(2, { cr: 'x-------', rd: '-xxxxxxx', sn: 'x--x--x-', ...BOSSA })
const BOSSA_ACCENT_CRASH = bar(2, { cr: 'x-------', rd: '-xxXxxXx', sn: 'x--x--x-', ...BOSSA })
const BOSSA_ACCENT_ONE = bar(2, { rd: 'XxxXxxXx', sn: 'x--x--x-', ...BOSSA })
const BOSSA_ACCENT_TWO = bar(2, { rd: 'xxXxxXxx', sn: '--x--x--', ...BOSSA })
const GALLOP = bar(4, { cr: 'x---x---x---x---', sn: '----X-------X---', bd: 'x-xxx-xxx-xxx-xx' })
const DOUBLE_KICK = bar(4, { rd: 'x-x-x-x-x-x-x-x-', sn: '----X-------X---', bd: 'xxxxxxxxxxxxxxxx' })
const BREAKDOWN = bar(4, { cr: 'x---x---x---x---', sn: '--------X-------', bd: 'x--x--x---xx-x--' })
const DNB_CRASH = bar(4, { cr: 'x---------------', hh: '--x-x-x-x-x-x-x-', sn: '----X-------X--g', bd: 'x---------x-----' })
const DNB_GHOSTS = bar(4, { hh: 'x-x-x-x-x-x-x-x-', sn: '-g--X--g-g--X--g', bd: 'x---------x-----' })
const DNB_BROKEN = bar(4, { hh: 'x-x-x-x-x-x-x-x-', sn: '----X--g----X---', bd: 'x-x-------x--x--' })
const SOUL_CRASH = bar(2, { cr: 'x-----------', hh: '-xxxxxxxxxxx', sn: '---X-----X--', bd: 'x----xx-----' }, { twelve: true })
const SOUL_GHOSTS = bar(2, { hh: 'xxxxxxxxxxxx', sn: '--gX-g--gX-g', bd: 'x----xx-----' }, { twelve: true })
const SOUL_RIDE = bar(2, { rd: 'XxxXxxXxxXxx', sn: '---X-----X--', bd: 'x-----x-----' }, { twelve: true })
const FUNK_CRASH = bar(4, { cr: 'x---------------', hh: '--x-x-o-x-x-x-o-', sn: '-g--X--g-g--X---', bd: 'x--x----x-x-----', hp: 'x-------x-------' })
const FUNK_LINEAR = bar(4, { hh: '-xx--x-x-x-x--x-', sn: '---gX---g---X--g', bd: 'x-----x---x--x--' })
const FUNK_CHOP = bar(4, { hh: 'x-x-x-x-x-x-x-o-', sn: '-g-gX-g--g-gX-g-', bd: 'x-x----x--x-----', hp: 'x---------------' })

/** The four lessons that follow each genre's first lesson, keyed by that lesson's id. */
export const GENRE_LESSONS: Record<string, Lesson[]> = {
  'genre-rock': [
    {
      id: 'genre-rock-kick-variations', collection: 'genre', style: 'Rock', feel: 'Straight eighths, moving kick',
      level: 4, title: 'Rock kick variations', meter, tempo: { start: 77, target: 110 }, limbs: HAT,
      goal: 'Keep the hi-hat and backbeat steady while the kick moves to a different "&" in each bar.',
      steps: ['The hands play exactly as in a basic rock beat: hi-hat eighths, snare on 2 and 4.',
        'Bar 1: kick on 1, 3 and "3 &". Bar 2: kick on 1, "2 &" and "3 &".', 'Count aloud so each kick lands on its "&", not between.'],
      bars: [ROCK_A, ROCK_B],
    },
    {
      id: 'genre-rock-open-hat', collection: 'genre', style: 'Rock', feel: 'Straight eighths, open hi-hat and sixteenth kick',
      level: 5, title: 'Rock with an open hi-hat', meter, tempo: { start: 70, target: 100 }, limbs: HAT_PEDAL,
      goal: 'Open the hi-hat on "4 &" and add a quick sixteenth-note kick on "2 a" that pushes into beat 3.',
      steps: ['Open the hi-hat on "4 &" and close it with the pedal on the next 1.',
        'Bar 1: kick on 1, "2 a", 3 and "3 &". Bar 2: kick on 1, "1 &", "2 a" and 3.', 'Practise the "2 a" kick slowly; it is a sixteenth before beat 3.'],
      bars: [
        bar(4, { hh: 'x-x-x-x-x-x-x-o-', sn: '----X-------X---', bd: 'x------xx-x-----', hp: 'x---------------' }),
        bar(4, { hh: 'x-x-x-x-x-x-x-o-', sn: '----X-------X---', bd: 'x-x----xx-------', hp: 'x---------------' }),
      ],
    },
    {
      id: 'genre-rock-tom-fill', collection: 'genre', style: 'Rock', feel: 'Straight eighths, sixteenth-note tom fill',
      level: 6, title: 'Rock groove into a tom fill', meter, tempo: { start: 70, target: 100 }, limbs: FILL_HANDS,
      goal: 'One bar of groove, then a two-beat fill of alternating sixteenths that moves from the snare down the toms.',
      steps: ['Bar 1: the groove with a crash on 1.', 'Bar 2: two beats of groove, then R L sixteenths from beat 3: four on the snare, two on tom 1, two on the floor tom.',
        'Land on the crash and kick on the next 1 without slowing down.'],
      bars: [ROCK_CRASH, bar(4, { hh: 'x-x-x-x---------', sn: '----X---XxXx----', t1: '------------Xx--', f1: '--------------Xx', bd: 'x-------x-------' }, { from: 8 })],
      sections: groove(1),
    },
    {
      id: 'genre-rock-phrase', collection: 'genre', style: 'Rock', feel: 'Straight eighths, three bars and an eighth-note fill',
      level: 6, title: 'Four-bar rock phrase', meter, tempo: { start: 77, target: 110 }, limbs: FILL_HANDS,
      goal: 'A complete four-bar phrase: three bars of groove with a changing kick, then an eighth-note fill into the top.',
      steps: ['Bars 1–3 change the kick under the same hands; bar 3 opens the hi-hat on "4 &".',
        'Bar 4: two beats of groove, then eighths R L R L: snare, snare, tom 2, floor tom.', 'Count the bars aloud so you always know where the fill starts.'],
      bars: [ROCK_CRASH, ROCK_B, bar(2, { hh: 'xxxxxxxo', sn: '--X---X-', bd: 'x---x-x-' }),
        bar(2, { hh: 'xxxx----', sn: '--X-XX--', t2: '------X-', f1: '-------X', bd: 'x---x---' }, { from: 4 })],
      sections: groove(3),
    },
  ],
  'genre-blues-shuffle': [
    {
      id: 'genre-blues-ride-shuffle', collection: 'genre', style: 'Blues', feel: 'Shuffle on the ride, hi-hat foot on 2 and 4',
      level: 4, title: 'Shuffle on the ride', meter, tempo: { start: 70, target: 100 }, limbs: 'Right hand: ride · Left hand: snare · Right foot: kick · Left foot: hi-hat pedal',
      goal: 'Move the shuffle to the ride, close the hi-hat with the foot on 2 and 4, and push beat 3 with a kick on "2 let".',
      steps: ['Play the shuffle on the ride: "1" and "let" of every beat.', 'The hi-hat pedal closes on 2 and 4 with the snare.',
        'Kick on 1, "2 let" and 3: the "let" kick leads into beat 3.'],
      bars: twice(BLUES_RIDE),
    },
    {
      id: 'genre-blues-double-shuffle', collection: 'genre', style: 'Blues', feel: 'Shuffle in both hands',
      level: 5, title: 'Double shuffle', meter, tempo: { start: 63, target: 90 }, limbs: HAT,
      goal: 'Both hands play the shuffle together: the right on the hi-hat, the left on the snare with ghost notes and backbeats.',
      steps: ['Play R+L together on every shuffle note.', 'The left hand is a ghost note everywhere except the backbeats on 2 and 4.',
        'Keep the ghosts low so the backbeat still stands out.'],
      bars: twice(BLUES_DOUBLE),
    },
    {
      id: 'genre-blues-triplet-fill', collection: 'genre', style: 'Blues', feel: 'Shuffle, eighth-note triplet fill',
      level: 6, title: 'Shuffle into a triplet fill', meter, tempo: { start: 70, target: 100 }, limbs: FILL_HANDS,
      goal: 'One bar of shuffle, then two beats of even triplets around the kit to lead back to the top.',
      steps: ['Bar 1: the shuffle with a crash on 1.', 'Bar 2, beats 3 and 4: triplets R L R L R L, three on the snare, two on tom 1, one on the floor tom.',
        'The fill plays every triplet; only the hi-hat skips the middle one.'],
      bars: [BLUES_CRASH, bar(3, { hh: 'x-xx-x------', sn: '---X--Xxx---', t1: '---------Xx-', f1: '-----------X', bd: 'x-----------' }, { from: 6 })],
      sections: groove(1),
    },
    {
      id: 'genre-blues-phrase', collection: 'genre', style: 'Blues', feel: 'Shuffle, three bars and a fill',
      level: 6, title: 'Four-bar shuffle phrase', meter, tempo: { start: 70, target: 100 }, limbs: 'Right hand: hi-hat or ride, then floor tom · Left hand: snare · Right foot: kick · Left foot: hi-hat pedal',
      goal: 'A four-bar shuffle that moves from the hi-hat to the double shuffle and the ride, then fills on the snare and floor tom.',
      steps: ['Bar 1 crashes on 1; bar 2 is the double shuffle; bar 3 moves the right hand to the ride.',
        'Bar 4: triplets from beat 3, three on the snare and three on the floor tom.', 'Change cymbals without a gap in the shuffle.'],
      bars: [BLUES_CRASH, BLUES_DOUBLE, BLUES_RIDE,
        bar(3, { hh: 'x-xx-x------', sn: '---X--Xxx---', f1: '---------Xxx', bd: 'x-----x-----' }, { from: 6 })],
      sections: groove(3),
    },
  ],
  'genre-reggae': [
    {
      id: 'genre-reggae-rockers', collection: 'genre', style: 'Reggae', feel: 'Rockers: kick on every beat, swung hi-hat',
      level: 4, title: 'Reggae rockers', meter, tempo: { start: 70, target: 100 }, limbs: HAT,
      goal: 'Keep the swung hi-hat and the snare on 3, and put the kick on every beat: the rockers feel.',
      steps: ['The hi-hat swings as in the one drop.', 'The kick now plays every beat; the snare still plays only beat 3.', 'Keep the kick even and soft: it drives the band.'],
      bars: twice(ROCKERS),
    },
    {
      id: 'genre-reggae-open-hat', collection: 'genre', style: 'Reggae', feel: 'One drop, open hi-hat on "2 let"',
      level: 5, title: 'One drop with an open hi-hat', meter, tempo: { start: 70, target: 100 }, limbs: HAT_PEDAL,
      goal: 'Open the hi-hat on "2 let" into the drop on 3, and lead back to beat 1 with a ghost note on "4 let".',
      steps: ['Open the hi-hat on "2 let" and close it with the pedal on 3, under the drop.', 'A ghost note on "4 let" leads back to the space on beat 1.',
        'Keep beat 1 empty: no kick and no snare.'],
      bars: twice(DROP_OPEN),
    },
    {
      id: 'genre-reggae-fill', collection: 'genre', style: 'Reggae', feel: 'One drop, triplet fill on beat 4',
      level: 5, title: 'One drop with a triplet fill', meter, tempo: { start: 70, target: 100 }, limbs: FILL_HANDS,
      goal: 'A one-drop bar, then a short triplet fill on beat 4 that leads into the empty first beat.',
      steps: ['Bar 1: the one drop, with a soft crash on 1 where the fill lands.', 'Bar 2: the drop on 3, then triplets on beat 4: snare R, tom 1 L, floor tom R.', 'Play the fill softly; it is a pickup, not a crash.'],
      bars: [DROP_CRASH, bar(3, { hh: 'x-xx-xx-----', sn: '------x--X--', t1: '----------x-', f1: '-----------x', bd: '------x-----' }, { from: 9 })],
      sections: groove(1),
    },
    {
      id: 'genre-reggae-phrase', collection: 'genre', style: 'Reggae', feel: 'One drop and rockers, three bars and a fill',
      level: 6, title: 'Four-bar reggae phrase', meter, tempo: { start: 70, target: 100 }, limbs: HAT_PEDAL,
      goal: 'Change the kick between one drop and rockers, open the hi-hat in bar 3, and close the phrase with snare triplets.',
      steps: ['Bar 1 is the one drop with a crash on 1, bar 2 rockers, bar 3 the one drop with the open hi-hat.', 'Bar 4 ends with three snare triplets R L R, the last one accented.',
        'The kick changes between bars; the swung hi-hat never does.'],
      bars: [DROP_CRASH, ROCKERS, DROP_OPEN, bar(3, { hh: 'x-xx-xx-----', sn: '------x--xxX', bd: '------x-----' }, { from: 9 })],
      sections: groove(3),
    },
  ],
  'genre-pop': [
    {
      id: 'genre-pop-half-time', collection: 'genre', style: 'Pop', feel: 'Straight eighths, snare on 3 only',
      level: 5, title: 'Half-time pop groove', meter, tempo: { start: 63, target: 90 }, limbs: HAT,
      goal: 'Put the backbeat on 3 only, so the same tempo feels half as fast, with the kick filling the space.',
      steps: ['Eighths on the hi-hat with the right hand; the snare plays only beat 3.', 'Kick on 1, "2 a" and "3 &".', 'Let the space after the snare ring.'],
      bars: twice(bar(4, { hh: 'x-x-x-x-x-x-x-x-', sn: '--------X-------', bd: 'x------x--x-----' })),
    },
    {
      id: 'genre-pop-ghost-notes', collection: 'genre', style: 'Pop', feel: 'Straight sixteenths, ghost notes',
      level: 6, title: 'Pop groove with ghost notes', meter, tempo: { start: 63, target: 90 }, limbs: HAT,
      goal: 'Soft ghost notes in the left hand between hi-hat eighths, under a kick that changes in bar 2.',
      steps: ['The right hand keeps eighths on the hi-hat; the left adds ghost notes on "1 a", "2 a", "3 a" and "4 &".',
        'Bar 1: kick on 1, "1 &", 3 and "3 &". Bar 2: kick on 1, "2 a" and 3.', 'Ghost notes barely lift off the head.'],
      bars: [
        bar(4, { hh: 'x-x-x-x-x-x-x-x-', sn: '---gX--g---gX-g-', bd: 'x-x-----x-x-----' }),
        bar(4, { hh: 'x-x-x-x-x-x-x-x-', sn: '---gX--g---gX-g-', bd: 'x------xx-------' }),
      ],
    },
    {
      id: 'genre-pop-snare-build', collection: 'genre', style: 'Pop', feel: 'Straight sixteenths, snare fill',
      level: 6, title: 'Pop groove into a snare build', meter, tempo: { start: 63, target: 90 }, limbs: 'Both hands: hi-hat and snare, alternating · Right foot: kick',
      goal: 'Keep alternating sixteenths from the two-handed groove straight into a snare build on beats 3 and 4.',
      steps: ['Bar 1: the two-handed sixteenth groove with a crash on 1.', 'Bar 2 moves both hands to the snare at beat 3, accenting "3 a" and "4 a".',
        'Keep R L R L all the way; only the drum changes.'],
      bars: [POP_CRASH, bar(4, { hh: 'Xxxx-xxx--------', sn: '----X---xxxXxxxX', bd: 'x------x--------' }, { from: 0 })],
      sections: groove(1),
    },
    {
      id: 'genre-pop-phrase', collection: 'genre', style: 'Pop', feel: 'Straight sixteenths, three bars and a tom fill',
      level: 7, title: 'Four-bar pop phrase', meter, tempo: { start: 63, target: 90 }, limbs: 'Both hands: hi-hat, snare and toms, alternating · Right foot: kick',
      goal: 'Three bars of the two-handed groove, then a sixteenth-note fill from the snare down the toms.',
      steps: ['Bar 1 crashes on 1; bar 3 adds a kick on "1 &".', 'Bar 4: from beat 3, four sixteenths on the snare, two on tom 1, two on the floor tom.',
        'Keep alternating R L through the whole phrase.'],
      bars: [POP_CRASH, POP, POP_KICK,
        bar(4, { hh: 'Xxxx-xxx--------', sn: '----X---XxXx----', t1: '------------Xx--', f1: '--------------Xx', bd: 'x------x--------' }, { from: 0 })],
      sections: groove(3),
    },
  ],
  'genre-disco': [
    {
      id: 'genre-disco-ghost-pickup', collection: 'genre', style: 'Disco and dance', feel: 'Four on the floor, sixteenth-note pickup',
      level: 5, title: 'Disco with a snare pickup', meter, tempo: { start: 84, target: 120 }, limbs: HAT_PEDAL,
      goal: 'Keep the four-limb disco pattern and add a soft sixteenth-note ghost note just before the backbeat on 4.',
      steps: ['The hi-hat opens on every "&" and the pedal closes it on every beat, as before.', 'Add a ghost note on "3 a" with the left hand.',
        'Kick and pedal stay on every beat.'],
      bars: twice(bar(4, { hh: 'x-o-x-o-x-o-x-o-', sn: '----X------gX---', bd: 'x---x---x---x---', hp: 'x---x---x---x---' })),
    },
    {
      id: 'genre-disco-sixteenth-hats', collection: 'genre', style: 'Disco and dance', feel: 'Four on the floor, two-handed sixteenth hi-hat',
      level: 6, title: 'Two-handed disco hi-hat', meter, tempo: { start: 77, target: 110 }, limbs: 'Both hands: hi-hat, the right hand also plays the snare · Right foot: kick',
      goal: 'Alternating sixteenths on the hi-hat, opening it on each "&", with the kick on every beat.',
      steps: ['Alternate R L on the hi-hat, opening it on each "&" with the right hand.', 'On 2 and 4 the right hand plays the snare instead.', 'The kick stays on every beat.'],
      bars: twice(DISCO_SIXTEENS),
    },
    {
      id: 'genre-disco-fill', collection: 'genre', style: 'Disco and dance', feel: 'Four on the floor, sixteenth-note snare fill',
      level: 6, title: 'Disco groove into a snare fill', meter, tempo: { start: 84, target: 120 }, limbs: HAT_PEDAL,
      goal: 'One bar of the disco groove, then alternating snare sixteenths over a kick that never stops.',
      steps: ['Bar 1: the disco groove with a crash on 1.', 'Bar 2, from beat 3: alternate sixteenths on the snare, accenting each R.',
        'Keep the four-on-the-floor kick steady under the fill.'],
      bars: [DISCO_CRASH, bar(4, { hh: 'x-o-x-o---------', sn: '----X---XxXxXxXx', bd: 'x---x---x---x---', hp: 'x---x-----------' }, { from: 8 })],
      sections: groove(1),
    },
    {
      id: 'genre-disco-phrase', collection: 'genre', style: 'Disco and dance', feel: 'Four on the floor, three bars and a tom fill',
      level: 7, title: 'Four-bar disco phrase', meter, tempo: { start: 84, target: 120 }, limbs: 'Right hand: hi-hat, then toms · Left hand: snare and hi-hat · Right foot: kick · Left foot: hi-hat pedal',
      goal: 'Crash, groove, two-handed hi-hat, then a tom fill: a full dance phrase over a constant kick.',
      steps: ['Bar 1 crashes; bar 2 is the basic groove; bar 3 plays the two-handed hi-hat.',
        'Bar 4: from beat 3, four snare sixteenths, two on tom 1, two on the floor tom.', 'The kick never stops: four beats in every bar.'],
      bars: [DISCO_CRASH, DISCO, DISCO_SIXTEENS,
        bar(4, { hh: 'x-o-x-o---------', sn: '----X---XxXx----', t1: '------------Xx--', f1: '--------------Xx', bd: 'x---x---x---x---', hp: 'x---x-----------' }, { from: 8 })],
      sections: groove(3),
    },
  ],
  'genre-jazz-swing': [
    {
      id: 'genre-jazz-comping', collection: 'genre', style: 'Jazz', feel: 'Swing ride, snare comping',
      level: 5, title: 'Swing with snare comping', meter, tempo: { start: 84, target: 120 },
      limbs: 'Right hand: ride · Left hand: snare (comping) · Right foot: kick (feathered) · Left foot: hi-hat pedal',
      goal: 'Keep the swing ride and hi-hat foot steady while the left hand comps in a different place in each bar.',
      steps: ['Keep the ride and the hi-hat foot exactly as in the first jazz lesson.', 'Bar 1: comp softly on "2 let" and "4 let". Bar 2: on "1 let" and 3.',
        'Comping answers the ride; it never covers it.'],
      bars: [JAZZ_COMP, bar(3, { ...SWING, sn: '--g---x-----', bd: 'g--g--g--g--' })],
    },
    {
      id: 'genre-jazz-kick-comping', collection: 'genre', style: 'Jazz', feel: 'Swing ride, snare and kick comping',
      level: 6, title: 'Comping between snare and kick', meter, tempo: { start: 84, target: 120 },
      limbs: 'Right hand: ride · Left hand: snare · Right foot: kick (comping) · Left foot: hi-hat pedal',
      goal: 'The kick stops feathering and joins the comping, trading off-beats with the snare.',
      steps: ['Bar 1: snare on "1 let" and "3 let", kick on "2 let" and "4 let".', 'Bar 2: kick on "1 let" and "3 let", snare on "4 let".',
        'Keep every comp note quieter than the ride.'],
      bars: [JAZZ_KICKS, bar(3, { ...SWING, sn: '-----------x', bd: '--x-----x---' })],
    },
    {
      id: 'genre-jazz-fill', collection: 'genre', style: 'Jazz', feel: 'Swing ride, triplet fill',
      level: 6, title: 'Swing into a triplet fill', meter, tempo: { start: 84, target: 120 },
      limbs: 'Right hand: ride, then snare and toms · Left hand: snare and toms · Right foot: kick · Left foot: hi-hat pedal',
      goal: 'One bar of swing, then two beats of triplets on the snare and toms, with the hi-hat foot still on 2 and 4.',
      steps: ['Bar 1: the swing pattern, with a crash and kick on 1 where the fill lands.', 'Bar 2, beats 3 and 4: triplets R L R L R L, four on the snare, then tom 1 and the floor tom.',
        'The hi-hat foot keeps 2 and 4 under the fill.'],
      bars: [JAZZ_CRASH, bar(3, { rd: 'x--X-x------', hp: '---x-----x--', sn: '------XxxX--', t1: '----------x-', f1: '-----------X', bd: 'g--g--------' }, { from: 6 })],
      sections: groove(1),
    },
    {
      id: 'genre-jazz-phrase', collection: 'genre', style: 'Jazz', feel: 'Swing ride, three bars and a fill',
      level: 7, title: 'Four-bar swing phrase', meter, tempo: { start: 84, target: 120 },
      limbs: 'Right hand: ride · Left hand: snare · Right foot: kick · Left foot: hi-hat pedal',
      goal: 'Comp on the snare, then between snare and kick, settle into the ride pattern, and set up the next phrase with triplets.',
      steps: ['Bar 1 crashes on 1 and comps on the snare, bar 2 between snare and kick, bar 3 is the plain ride pattern.',
        'Bar 4: three snare triplets R L R on beat 4, accenting the last.', 'Count the bars aloud: jazz phrases come in fours.'],
      bars: [JAZZ_COMP_CRASH, JAZZ_KICKS, JAZZ, bar(3, { rd: 'x--X-xx-----', hp: '---x-----x--', sn: '---------xxX', bd: 'g--g--g-----' }, { from: 9 })],
      sections: groove(3),
    },
  ],
  'genre-bossa-nova': [
    {
      id: 'genre-bossa-hi-hat', collection: 'genre', style: 'Latin: bossa nova', feel: 'Straight eighths, snare figure starting with its second bar',
      level: 5, title: 'Bossa nova on the hi-hat', meter, tempo: { start: 98, target: 140 }, limbs: HAT,
      goal: 'Play the bossa nova on the closed hi-hat, with the two-bar snare figure starting from its second bar.',
      steps: ['Play the closed hi-hat instead of the ride.', 'The snare bars swap: bar 1 plays 2 and "3 &", bar 2 plays 1, "2 &" and 4.',
        'The kick is unchanged; keep it soft and steady.'],
      bars: [bar(2, { hh: 'xxxxxxxx', sn: '--x--x--', bd: 'x--xx--x' }), bar(2, { hh: 'xxxxxxxx', sn: 'x--x--x-', bd: 'x--xx--x' })],
    },
    {
      id: 'genre-bossa-ride-accents', collection: 'genre', style: 'Latin: bossa nova', feel: 'Straight eighths, ride accents follow the snare',
      level: 6, title: 'Bossa nova with ride accents', meter, tempo: { start: 98, target: 140 },
      limbs: 'Right hand: ride · Left hand: snare · Right foot: kick · Left foot: hi-hat pedal',
      goal: 'Accent the ride exactly where the snare plays, so the two-bar figure sings across both hands.',
      steps: ['Accent the ride with the snare: 1, "2 &" and 4 in bar 1; 2 and "3 &" in bar 2.', 'Every other ride note stays light.', 'Kick and hi-hat foot as before.'],
      bars: [BOSSA_ACCENT_ONE, BOSSA_ACCENT_TWO],
    },
    {
      id: 'genre-bossa-fill', collection: 'genre', style: 'Latin: bossa nova', feel: 'Straight eighths, soft eighth-note fill',
      level: 6, title: 'Bossa nova with a soft tom fill', meter, tempo: { start: 98, target: 140 },
      limbs: 'Right hand: ride, then snare and toms · Left hand: snare and toms · Right foot: kick · Left foot: hi-hat pedal',
      goal: 'The first bar of the bossa nova, then a quiet eighth-note fill over the kick and hi-hat foot.',
      steps: ['Bar 1: the bossa nova, with a soft crash on 1 where the fill lands.', 'Bar 2: after the snare on 2, play eighths R L R L: snare, tom 2, then the floor tom twice.',
        'Keep the fill quiet; the kick and hi-hat foot continue.'],
      bars: [BOSSA_CRASH, bar(2, { rd: 'xxxx----', sn: '--x-x---', t2: '-----x--', f1: '------xx', ...BOSSA }, { from: 4 })],
      sections: groove(1),
    },
    {
      id: 'genre-bossa-phrase', collection: 'genre', style: 'Latin: bossa nova', feel: 'Straight eighths, two-bar figure twice, soft fill',
      level: 7, title: 'Four-bar bossa nova phrase', meter, tempo: { start: 98, target: 140 },
      limbs: 'Right hand: ride, then snare and floor tom · Left hand: snare · Right foot: kick · Left foot: hi-hat pedal',
      goal: 'Two bars with ride accents, one plain bar, and a short fill: the bossa nova as a four-bar phrase.',
      steps: ['Bars 1 and 2 accent the ride with the snare, bar 1 starting with a soft crash; bar 3 is the plain pattern.',
        'Bar 4: snare on 2, then "3 &" and 4 on the snare and "4 &" on the floor tom.', 'Phrase the four bars as two pairs.'],
      bars: [BOSSA_ACCENT_CRASH, BOSSA_ACCENT_TWO, BOSSA_ONE, bar(2, { rd: 'xxxx----', sn: '--x--xx-', f1: '-------x', ...BOSSA }, { from: 4 })],
      sections: groove(3),
    },
  ],
  'genre-metal': [
    {
      id: 'genre-metal-double-kick', collection: 'genre', style: 'Metal', feel: 'Sixteenth notes on the kick with both feet',
      level: 6, title: 'Double-kick sixteenths', meter, tempo: { start: 56, target: 80 },
      limbs: 'Right hand: ride · Left hand: snare · Both feet: kick, alternating (double pedal)',
      goal: 'Even sixteenth notes on the kick, alternating the feet, under ride eighths and a steady backbeat.',
      steps: ['Alternate the feet R L on every sixteenth; with one pedal, practise the right foot alone at half speed.',
        'The ride plays eighths and the snare 2 and 4.', 'Raise the speed only when all sixteen kicks are the same volume.'],
      bars: twice(DOUBLE_KICK),
    },
    {
      id: 'genre-metal-breakdown', collection: 'genre', style: 'Metal', feel: 'Half time, syncopated kick',
      level: 6, title: 'Half-time breakdown', meter, tempo: { start: 70, target: 100 }, limbs: 'Right hand: crash · Left hand: snare · Right foot: kick',
      goal: 'Crash quarter notes and a single snare on 3, with a syncopated kick that locks with the guitar.',
      steps: ['The snare only on 3 makes the groove feel half as fast.', 'Kick on 1, "1 a", "2 &", "3 &", "3 a" and "4 e".', 'Play each kick exactly with the guitar.'],
      bars: twice(BREAKDOWN),
    },
    {
      id: 'genre-metal-tom-fill', collection: 'genre', style: 'Metal', feel: 'Gallop, sixteenth-note tom fill',
      level: 7, title: 'Gallop into a tom fill', meter, tempo: { start: 70, target: 100 }, limbs: 'Right hand: crash, then snare and toms · Left hand: snare and toms · Right foot: kick',
      goal: 'One bar of gallop, then sixteenths in pairs down the kit: snare, tom 1, tom 2 and the floor tom.',
      steps: ['Bar 1: the gallop.', 'Bar 2, from beat 3: two sixteenths each on the snare, tom 1, tom 2 and the floor tom, R L every time.',
        'The kick plays 3 and 4 under the fill.'],
      bars: [GALLOP, bar(4, { cr: 'x---x-----------', sn: '----X---Xx------', t1: '----------Xx----', t2: '------------Xx--', f1: '--------------Xx', bd: 'x-xxx-xxx---x---' }, { from: 8 })],
      sections: groove(1),
    },
    {
      id: 'genre-metal-phrase', collection: 'genre', style: 'Metal', feel: 'Gallop, double kick and breakdown, then a fill',
      level: 7, title: 'Four-bar metal phrase', meter, tempo: { start: 70, target: 100 },
      limbs: 'Right hand: crash or ride, then snare · Left hand: snare · Feet: kick, both feet in bar 2',
      goal: 'A phrase that changes what the feet do every bar, then an accented snare fill in groups of three.',
      steps: ['Bar 1 gallops, bar 2 plays double-kick sixteenths under the ride, bar 3 is the half-time breakdown.',
        'Bar 4: alternate snare sixteenths from beat 3, accented on 3, "3 a" and "4 &".', 'Each bar changes the feet; keep the hands steady through the change.'],
      bars: [GALLOP, DOUBLE_KICK, BREAKDOWN, bar(4, { cr: 'x---x-----------', sn: '----X---XxxXxxXx', bd: 'x-xxx-xxx---x---' }, { from: 8 })],
      sections: groove(3),
    },
  ],
  'genre-drum-and-bass': [
    {
      id: 'genre-dnb-ghost-notes', collection: 'genre', style: 'Drum and bass', feel: 'Straight sixteenths, two-step with ghost notes',
      level: 6, title: 'Two-step with ghost notes', meter, tempo: { start: 119, target: 170 }, limbs: HAT,
      goal: 'Keep the two-step kick and backbeat, and roll the groove forward with ghost notes between the hi-hat strokes.',
      steps: ['Same kick and backbeat as the two-step.', 'Add ghost notes with the left hand on "1 e", "2 a", "3 e" and "4 a".', 'Learn it slowly; the ghosts keep a fast groove rolling.'],
      bars: twice(DNB_GHOSTS),
    },
    {
      id: 'genre-dnb-broken-kick', collection: 'genre', style: 'Drum and bass', feel: 'Straight sixteenths, broken kick',
      level: 7, title: 'Broken two-step', meter, tempo: { start: 119, target: 170 }, limbs: HAT,
      goal: 'Move the kick off the two-step grid in each bar while the backbeat on 2 and 4 stays put.',
      steps: ['Bar 1: kick on 1, "1 &", "3 &" and "4 e", with a ghost on "2 a".', 'Bar 2: kick on 1, "3 &" and "3 a", with a ghost on "4 &".', 'The backbeat on 2 and 4 never moves.'],
      bars: [DNB_BROKEN, bar(4, { hh: 'x-x-x-x-x-x-x-x-', sn: '----X-------X-g-', bd: 'x---------xx----' })],
    },
    {
      id: 'genre-dnb-fill', collection: 'genre', style: 'Drum and bass', feel: 'Straight sixteenths, sixteenth-note fill',
      level: 7, title: 'Two-step into a snare fill', meter, tempo: { start: 119, target: 170 }, limbs: FILL_HANDS,
      goal: 'One bar of two-step, then a fast run of sixteenths on the snare that ends on the toms.',
      steps: ['Bar 1: the two-step with a crash on 1.', 'Bar 2: six snare sixteenths from beat 3, then tom 1 and the floor tom, alternating R L.',
        'The kick on "3 &" stays under the fill.'],
      bars: [DNB_CRASH, bar(4, { hh: 'x-x-x-x---------', sn: '----X---Xxxxxx--', t1: '--------------x-', f1: '---------------X', bd: 'x---------x-----' }, { from: 8 })],
      sections: groove(1),
    },
    {
      id: 'genre-dnb-phrase', collection: 'genre', style: 'Drum and bass', feel: 'Straight sixteenths, crash, ghosts, broken kick, tom fill',
      level: 8, title: 'Four-bar drum and bass phrase', meter, tempo: { start: 119, target: 170 }, limbs: FILL_HANDS,
      goal: 'Crash into the two-step, add ghost notes, break the kick, then fill down the toms at speed.',
      steps: ['Bar 1 crashes into the two-step, bar 2 adds ghost notes, bar 3 breaks the kick.',
        'Bar 4: four snare sixteenths, two on tom 2 and two on the floor tom from beat 3.', 'Practise at half speed first; the phrase must flow at the target tempo.'],
      bars: [DNB_CRASH, DNB_GHOSTS, DNB_BROKEN,
        bar(4, { hh: 'x-x-x-x---------', sn: '----X---XxXx----', t2: '------------Xx--', f1: '--------------Xx', bd: 'x---------x-----' }, { from: 8 })],
      sections: groove(3),
    },
  ],
  'genre-soul-ballad': [
    {
      id: 'genre-soul-ride', collection: 'genre', style: 'R&B and soul', feel: '12/8 on the ride, accents on each beat',
      level: 7, title: 'Soul ballad on the ride', meter: { numerator: 12, denominator: 8 }, tempo: { start: 42, target: 60 },
      limbs: 'Right hand: ride · Left hand: snare · Right foot: kick',
      goal: 'Twelve eighths on the ride with the four counted beats accented, and a kick that grows in bar 2.',
      steps: ['Accent the ride on 1, 4, 7 and 10: the four counted beats.', 'Bar 1: kick on 1 and 7. Bar 2: kick on 1, 3, 7 and 9.', 'Snare on 4 and 10 as before.'],
      bars: [SOUL_RIDE, bar(2, { rd: 'XxxXxxXxxXxx', sn: '---X-----X--', bd: 'x-x---x-x---' }, { twelve: true })],
    },
    {
      id: 'genre-soul-ghosts', collection: 'genre', style: 'R&B and soul', feel: '12/8, ghost notes on the snare',
      level: 7, title: 'Soul ballad with ghost notes', meter: { numerator: 12, denominator: 8 }, tempo: { start: 42, target: 60 }, limbs: HAT,
      goal: 'Ghost notes around each backbeat give the slow 12/8 its lift, while the hi-hat keeps every eighth.',
      steps: ['The hi-hat keeps all twelve eighths.', 'The left hand adds ghost notes on 3, 6, 9 and 12 around the backbeats on 4 and 10.',
        'Ghosts stay very soft; the slow tempo shows every uneven note.'],
      bars: twice(SOUL_GHOSTS),
    },
    {
      id: 'genre-soul-fill', collection: 'genre', style: 'R&B and soul', feel: '12/8, sixteenth-note fill',
      level: 7, title: 'Soul ballad into a sixteenth fill', meter: { numerator: 12, denominator: 8 }, tempo: { start: 42, target: 60 }, limbs: FILL_HANDS,
      goal: 'One bar of ballad groove, then a sixteenth-note fill over the second half of the bar.',
      steps: ['Bar 1: the ballad groove with a crash on 1.', 'Bar 2, from eighth 7: alternate sixteenths, six on the snare, four on tom 2 and two on the floor tom.',
        'At this slow tempo the sixteenths must stay exactly even.'],
      bars: [SOUL_CRASH, bar(4, {
        hh: 'x-x-x-x-x-x-------------', sn: '------X-----XxXxXx------', t2: '------------------XxXx--', f1: '----------------------Xx', bd: 'x---------x-x-----------',
      }, { from: 12, twelve: true })],
      sections: groove(1),
    },
    {
      id: 'genre-soul-phrase', collection: 'genre', style: 'R&B and soul', feel: '12/8, three bars and a fill',
      level: 8, title: 'Four-bar soul ballad phrase', meter: { numerator: 12, denominator: 8 }, tempo: { start: 42, target: 60 }, limbs: FILL_HANDS,
      goal: 'Crash, ghost notes and the ride across three bars, then an eighth-note fill around the toms.',
      steps: ['Bar 1 crashes, bar 2 adds ghost notes, bar 3 moves to the ride.', 'Bar 4: eighths R L from 7: two on the snare, two on tom 1, two on the floor tom.',
        'Let the last floor-tom accent lead into the crash on 1.'],
      bars: [SOUL_CRASH, SOUL_GHOSTS, SOUL_RIDE,
        bar(2, { hh: 'xxxxxx------', sn: '---X--Xx----', t1: '--------xx--', f1: '----------xX', bd: 'x----x------' }, { from: 6, twelve: true })],
      sections: groove(3),
    },
  ],
  'genre-funk': [
    {
      id: 'genre-funk-linear', collection: 'genre', style: 'Funk', feel: 'Straight sixteenths, linear: no two limbs together',
      level: 8, title: 'Linear funk', meter, tempo: { start: 63, target: 90 }, limbs: HAT,
      goal: 'Kick, hi-hat and snare interlock into one sixteenth-note line, with never two notes at once.',
      steps: ['Only one limb plays at a time: the three voices join into one line of sixteenths.',
        'Right hand on the hi-hat, left hand on the snare; the ghost notes on "1 a", 3 and "4 a" are very soft.', 'Learn it one beat at a time, then join the beats.'],
      bars: twice(FUNK_LINEAR),
    },
    {
      id: 'genre-funk-ghost-chop', collection: 'genre', style: 'Funk', feel: 'Straight sixteenths, dense ghost notes',
      level: 8, title: 'Funk with dense ghost notes', meter, tempo: { start: 63, target: 90 }, limbs: HAT_PEDAL,
      goal: 'Ghost notes fill most of the gaps between the hi-hat eighths, with full backbeats and an open hi-hat on "4 &".',
      steps: ['Right hand eighths on the hi-hat, opening on "4 &"; the pedal closes it on 1.',
        'The left hand ghosts on "1 e", "1 a", "2 &", "3 e", "3 a" and "4 &", with full backbeats on 2 and 4.', 'Kick on 1, "1 &", "2 a" and "3 &".'],
      bars: twice(FUNK_CHOP),
    },
    {
      id: 'genre-funk-fill', collection: 'genre', style: 'Funk', feel: 'Straight sixteenths, hands-and-feet fill',
      level: 8, title: 'Funk into a linear fill', meter, tempo: { start: 63, target: 90 }, limbs: 'Right hand: hi-hat, then snare and toms · Left hand: snare and toms · Right foot: kick · Left foot: hi-hat pedal',
      goal: 'One bar of open hi-hat funk, then a linear fill where the hands and the kick take turns.',
      steps: ['Bar 1: the open hi-hat funk groove with a crash on 1.', 'Bar 2, from beat 3: snare R L, kick, tom 1 R L, kick, floor tom R L.',
        'Keep it linear: no two notes together in the fill.'],
      bars: [FUNK_CRASH, bar(4, { hh: 'x-x-x-o---------', sn: '-g--X--gXx------', t1: '-----------Xx---', f1: '--------------Xx', bd: 'x--x------x--x--', hp: 'x---------------' }, { from: 8 })],
      sections: groove(1),
    },
    {
      id: 'genre-funk-phrase', collection: 'genre', style: 'Funk', feel: 'Straight sixteenths, three bars and a linear fill',
      level: 8, title: 'Four-bar funk phrase', meter, tempo: { start: 63, target: 90 }, limbs: HAT_PEDAL,
      goal: 'Open hi-hat funk, a linear bar and a ghost-note bar, then snare and kick trading sixteenths.',
      steps: ['Bar 1 crashes into the open hi-hat groove, bar 2 is linear, bar 3 adds dense ghost notes.',
        'Bar 4: from beat 3 the snare and kick share every sixteenth, never together; the hands go R L R L R.', 'Count sixteenths aloud through bar 4 until it is automatic.'],
      bars: [FUNK_CRASH, FUNK_LINEAR, FUNK_CHOP,
        bar(4, { hh: 'x-x-x-x---------', sn: '----X--gX-xx-x-X', bd: 'x--x-----x--x-x-', hp: 'x---------------' }, { from: 8 })],
      sections: groove(3),
    },
  ],
}

function withCrashAtStart(source: LessonBar): LessonBar {
  const notes = Object.fromEntries(Object.entries(source.notes).map(([voice, pattern]) => [voice, pattern])) as LessonBar['notes']
  const length = source.steps * (source.count.split(' ').length / source.steps)
  const cymbals = (['hh', 'rd', 'cr'] as Voice[]).filter((voice) => notes[voice])
  const handsAtStart = (Object.keys(notes) as Voice[]).filter((voice) => !FEET.includes(voice) && notes[voice]![0] !== '-')
  if (!cymbals.length && handsAtStart.length > 1) return source
  const crash = [...(notes.cr ?? '-'.repeat(length))]
  let accent = 'x'
  for (const voice of cymbals) {
    const pattern = [...notes[voice]!]
    if (voice !== 'cr' && pattern[0] !== '-') {
      accent = pattern[0]
      pattern[0] = '-'
      notes[voice] = pattern.join('')
    }
  }
  crash[0] = accent
  notes.cr = crash.join('')
  return { ...source, notes }
}

function varyCymbal(notes: LessonBar['notes']): void {
  const source: Voice | undefined = notes.hh && [...notes.hh].every((symbol) => 'xX-'.includes(symbol))
    ? 'hh' : notes.rd ? 'rd' : undefined
  if (!source) return
  const target: Voice = source === 'hh' ? 'rd' : 'hh'
  if (notes[target]) return
  notes[target] = notes[source]!
  delete notes[source]
}

function accentAtDifferentSubdivision(notes: LessonBar['notes'], index: number): void {
  const voice = (['hh', 'rd', 'cr'] as Voice[]).find((item) => notes[item] && [...notes[item]!].some((symbol) => 'xXoO'.includes(symbol)))
  if (!voice) return
  const pattern = [...notes[voice]!]
  const start = index * 5 % pattern.length
  for (let offset = 0; offset < pattern.length; offset++) {
    const step = (start + offset) % pattern.length
    if (pattern[step] === 'x') { pattern[step] = 'X'; break }
    if (pattern[step] === 'X') { pattern[step] = 'x'; break }
    if (pattern[step] === 'o') { pattern[step] = 'O'; break }
    if (pattern[step] === 'O') { pattern[step] = 'o'; break }
  }
  notes[voice] = pattern.join('')
}

function addTurnaroundKick(notes: LessonBar['notes']): void {
  const length = Math.max(...Object.values(notes).map((pattern) => pattern.length))
  const kick = [...(notes.bd ?? '-'.repeat(length))]
  if (kick.at(-1) === '-') kick[kick.length - 1] = 'x'
  notes.bd = kick.join('')
}

function authoredBar(source: LessonBar, index: number, phraseBars: number, stage: number, fill: boolean, meter: Lesson['meter']): LessonBar {
  const notes = Object.fromEntries(Object.entries(source.notes).map(([voice, pattern]) => [voice, pattern])) as LessonBar['notes']
  const isB = index >= phraseBars / 2
  if (stage > 0 && !fill && isB && index % 2 === 0) varyCymbal(notes)
  if (index === 0 || stage > 0 && index === phraseBars / 2 || stage === 0 && index % 4 === 3) {
    const withCrash = withCrashAtStart({ ...source, notes })
    Object.assign(notes, withCrash.notes)
  }
  if (!fill && (stage > 0 || index % 4 === 3)) accentAtDifferentSubdivision(notes, index)
  if (index % 4 === 3) addTurnaroundKick(notes)
  const alternating = source.sticking?.split(' ').slice(0, 6).join(' ') === 'R L R L R L'
  return bar(source.steps, notes, {
    from: alternating ? 0 : Infinity,
    twelve: meter.numerator === 12 && meter.denominator === 8,
  })
}

/**
 * Expand the original short motif into a complete study while keeping the lesson's authored groove and fill cells.
 * Bars 4/8 or 8/16 carry turnarounds; the B section changes cymbal orchestration where the source has a closed hat
 * or ride. Only the two fill stages give the backing a Fill bar, so it rests for exactly the second half of that bar.
 */
export function expandGenreLesson(lesson: Lesson, stage: number): Lesson {
  const length = stage === 4 ? 16 : 8
  const source = lesson.bars
  const hasFill = stage >= 3
  const groove = hasFill ? source.slice(0, -1) : source
  const fillBar = source.at(-1)!
  const phrase = Array.from({ length }, (_, index) => {
    const fill = stage === 3 ? index % 4 === 3 : stage === 4 && index % 8 === 7
    const selected = fill ? fillBar : groove[index % groove.length]
    return authoredBar(selected, index, length, stage, fill, lesson.meter)
  })
  const sections = stage === 3
    ? [{ name: 'Groove', bars: 3 }, { name: 'Fill', bars: 1 }, { name: 'Groove', bars: 3 }, { name: 'Fill', bars: 1 }]
    : stage === 4
      ? [{ name: 'Groove', bars: 7 }, { name: 'Fill', bars: 1 }, { name: 'Groove', bars: 7 }, { name: 'Fill', bars: 1 }]
      : undefined
  const barsText = stage === 4
    ? 'A 16-bar performance phrase: bars 1–7 set up the groove, bar 8 fills, bars 9–15 vary the orchestration, and bar 16 fills back to bar 1.'
    : stage === 3
      ? 'An 8-bar fill study: groove in bars 1–3 and 5–7, with fills in bars 4 and 8; the band rests during each fill’s second half.'
      : stage === 0
        ? `An 8-bar basic groove: bars 1–3 establish ${lesson.feel}; bars 4 and 8 turn the phrase around, and bars 5–7 return to the core groove.`
        : `An 8-bar ${lesson.title.toLowerCase()} variation: develop the ${lesson.feel} focus through bars 1–7, then turn bar 8 back to bar 1.`
  const focus = lesson.goal
    .replace(/\b(?:one|two|three|four)-bar\b/gi, `${length}-bar`)
    .replace(/\bOne bar\b/g, 'The groove')
    .replace(/\bone bar\b/g, 'the groove')
    .replace(/\bthree bars\b/gi, 'the groove section')
    .replace(/\bBar 1\b/gi, 'the opening motif')
    .replace(/\bBar 2\b/gi, 'the alternate motif')
    .replace(/\bBar 3\b/gi, 'the later motif')
    .replace(/\bBar 4\b/gi, 'the fill turnaround')
  const reword = (step: string) => step
    .replace(/\bBar 1\b/gi, 'the opening motif')
    .replace(/\bBar 2\b/gi, 'the alternate motif')
    .replace(/\bBar 3\b/gi, 'the later motif')
    .replace(/\bBar 4\b/gi, 'the fill turnaround')
  const teaching = stage === 3
    ? [
        `Keep the ${lesson.title.toLowerCase()} focus in groove bars 1–3 and 5–7; bars 4 and 8 leave the second half for the fill.`,
        'Repeat the four-bar groove-and-fill layout; the final fill leads back to the opening crash.',
        reword(lesson.steps.at(-1)!),
      ]
    : stage === 4
      ? [
          'Bars 1–7 build the A section and bar 8 fills; bars 9–15 vary the orchestration and bar 16 fills back to bar 1.',
          `The backing rests for the second half of bars 8 and 16; keep the ${lesson.title.toLowerCase()} technique clear through both sections.`,
          'Let the final fill resolve into the opening groove rather than stopping at the end of bar 16.',
        ]
      : [
        reword(lesson.steps[0]),
        reword(lesson.steps[1] ?? lesson.goal),
        stage === 0
          ? 'Bars 1–3 and 5–7 keep the basic pattern steady; use bars 4 and 8 for the small turnaround and return.'
          : 'The second half shifts cymbal color and accents while keeping the lesson’s defining groove intact.',
      ]
  return {
    ...lesson,
    feel: `${lesson.feel} · ${length}-bar ${stage >= 3 ? 'phrase with turnarounds' : 'study'}`,
    goal: `${barsText} Focus: ${lesson.title.toLowerCase()} — ${focus}`,
    steps: teaching,
    bars: phrase,
    ...(sections ? { sections } : { sections: undefined }),
  }
}
