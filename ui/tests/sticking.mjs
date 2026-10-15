// Run from ui\: node tests\sticking.mjs
import assert from 'node:assert/strict'
import { createServer } from 'vite'

globalThis.matchMedia = () => ({ matches: false })
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { suggestSticking, stickingFor } = await vite.ssrLoadModule('/src/workspace/sticking.ts')
  const hit = (lane, startBeat, sourceMidi) => ({ trackId: 'drums', lane, startBeat, velocity: 0.7, ...(sourceMidi ? { sourceMidi } : {}) })
  const song = (drums, bpm = 100) => ({ title: 'x', bpm, bars: 4, beatsPerBar: 4, source: 'youtube', tracks: [], drums })
  const letters = (drums, bpm) => suggestSticking(song(drums, bpm)).map((hand) => hand === 'left' ? 'L' : hand === 'right' ? 'R' : '-').join('')
  const toms = (...pieces) => pieces.map(([lane, midi], i) => hit(lane, i / 4, midi))
  const TOM1 = ['hightom', 48], TOM2 = ['hightom', 47], FLOOR = ['floortom', 43], SNARE = ['snare']
  // Left-to-right position of each drum, to check a hand never reaches more than one drum across the other (neighbouring drums overlap a little, as they do).
  const X = { snare: -1, 48: 0, 47: 1, 43: 2.5 }
  const crossings = (drums) => {
    const hands = suggestSticking(song(drums))
    let left = null, right = null, count = 0
    drums.forEach((item, i) => {
      const x = X[item.sourceMidi ?? item.lane]
      if (hands[i] === 'left') { left = x; if (right !== null && x - right > 1.2) count++ } else { right = x; if (left !== null && left - x > 1.2) count++ }
    })
    return count
  }

  // Groove: right hand keeps the hi-hat, left hand takes the snare backbeats.
  const groove = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].flatMap((beat) => [hit('hihat', beat, 42), ...(beat === 1 || beat === 3 ? [hit('snare', beat)] : [])])
  assert.equal(letters(groove), 'RRRLRRRRLR', 'hat eighths are right, backbeats are left')
  assert.equal(letters([0, 1, 2, 3].map((beat) => hit('ride', beat))), 'RRRR', 'a ride pattern stays on the right')
  assert.equal(letters([0, 1, 2, 3].map((beat) => hit('crash', beat))), 'RRRR', 'a crash alone is right')

  // Time-keeping stays on the right hand at any ordinary tempo: hat eighths with snare backbeats and kick, and ride eighths.
  const withKick = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].flatMap((beat) => [hit('hihat', beat, 42),
    ...(beat === 1 || beat === 3 ? [hit('snare', beat)] : []), ...(beat === 0 || beat === 2 ? [hit('kick', beat)] : [])])
  for (const bpm of [100, 120, 140, 160, 180]) {
    const hands = suggestSticking(song(withKick, bpm))
    withKick.forEach((item, i) => {
      if (item.lane === 'hihat') assert.equal(hands[i], 'right', `hat at beat ${item.startBeat} at ${bpm} bpm is right`)
      if (item.lane === 'snare') assert.equal(hands[i], 'left', `snare at ${bpm} bpm is left`)
      if (item.lane === 'kick') assert.equal(hands[i], undefined)
    })
  }
  for (const bpm of [140, 180]) assert.equal(letters([...Array(8)].map((_, i) => hit('ride', i / 2)), bpm), 'RRRRRRRR', `ride eighths at ${bpm} bpm`)

  // Single-stroke runs alternate from the right; slow single notes stay on the lead hand.
  assert.equal(letters([...Array(8)].map((_, i) => hit('snare', i / 4))), 'RLRLRLRL', 'a sixteenth run alternates')
  assert.equal(letters([0, 1, 2].map((beat) => hit('snare', beat))), 'RRR', 'slow single strokes stay right')
  // Tempo counts, not just beats: the same eighths alternate when fast and stay right when slow.
  const eighths = [...Array(6)].map((_, i) => hit('snare', i / 2))
  assert.equal(letters(eighths, 60), 'RRRRRR', 'eighths at 60 bpm are comfortable with one hand')
  assert.equal(letters(eighths, 200), 'RLRLRL', 'eighths at 200 bpm alternate')

  // Fast hat sixteenths with a snare backbeat: the snare is always the left hand and the hat is right at the same moment.
  const hat16 = [...Array(16)].flatMap((_, i) => [hit('hihat', i / 4, 42), ...(i === 4 || i === 12 ? [hit('snare', i / 4)] : [])])
  const hat16Hands = suggestSticking(song(hat16, 140))
  hat16.forEach((item, i) => {
    if (item.lane === 'snare') assert.equal(hat16Hands[i], 'left', 'snare is left')
    if (item.lane === 'hihat' && (item.startBeat === 1 || item.startBeat === 3)) assert.equal(hat16Hands[i], 'right', 'hat with the snare is right')
  })
  const hatOnly = hat16.map((item, i) => [item, hat16Hands[i]]).filter(([item]) => item.lane === 'hihat').map(([, hand]) => hand)
  assert.ok(hatOnly.slice(5, 12).every((hand, i, all) => i === 0 || hand !== all[i - 1]), 'hat sixteenths between backbeats alternate')
  assert.equal(letters([...Array(8)].map((_, i) => hit('hihat', i / 4, 42)), 140), 'RLRLRLRL', 'hat sixteenths at 140 bpm alternate')
  assert.equal(letters([...Array(8)].map((_, i) => hit('hihat', i / 4, 42)), 90), 'RRRRRRRR', 'hat sixteenths at 90 bpm stay right')

  // Fills move around the kit without crossing: the hand on the side of travel finishes the run.
  for (const fill of [toms(SNARE, TOM1, TOM2, FLOOR), toms(FLOOR, TOM2, TOM1, SNARE), toms(SNARE, TOM1, TOM2, FLOOR, FLOOR), toms(FLOOR, TOM1, SNARE)])
    assert.equal(crossings(fill), 0, `no crossing in ${letters(fill)}`)
  assert.equal(letters(toms(SNARE, TOM1, TOM2, FLOOR)).slice(-1), 'R', 'a fill travelling right ends on the right hand')
  assert.equal(letters(toms(FLOOR, TOM2, TOM1, SNARE)).slice(0, 1), 'R', 'a fill starting on the floor tom starts on the right hand')
  assert.match(letters(toms(TOM1, TOM1, TOM2, TOM2, FLOOR, FLOOR)), /^(?:RL|LR)*(?:RR|LL)?[RL]*$/, 'a fill is a string of hands')

  // Two drums at once: the one further right is the right hand; two sounds on one drum take both hands; a hat with a drum is right.
  assert.deepEqual(suggestSticking(song([hit('snare', 0), hit('floortom', 0, 43)])), ['left', 'right'])
  assert.deepEqual(suggestSticking(song([hit('hightom', 0, 50), hit('hightom', 0, 48)])).sort(), ['left', 'right'], 'a flam on one drum uses both hands')
  assert.deepEqual(suggestSticking(song([hit('hihat', 0, 42), hit('snare', 0)])), ['right', 'left'])
  assert.deepEqual(suggestSticking(song([hit('crash', 0), hit('snare', 0)])), ['right', 'left'], 'crash and snare together: right on the crash')

  // Crossing avoidance: a ride-to-floor-tom move after a snare does not put the left hand over the right.
  assert.equal(crossings(toms(SNARE, FLOOR, SNARE, FLOOR)), 0)

  // Impossible moments are left blank, feet get no hand, and the other moments are still suggested.
  assert.equal(letters([hit('hihat', 0, 42), hit('snare', 0), hit('hightom', 0, 50)]), '---')
  assert.equal(letters([hit('crash', 0), hit('ride', 0)]), '--')
  assert.equal(letters([hit('kick', 0), hit('hihat', 1, 44)]), '--')
  assert.equal(letters([hit('snare', 0), hit('crash', 1), hit('ride', 1), hit('snare', 2)]), 'R--R', 'a blank moment does not stop the rest')

  // Deterministic, and authored lesson sticking is untouched.
  assert.equal(letters(groove), letters(groove))
  assert.deepEqual(stickingFor(song([{ ...hit('snare', 0), hand: 'left' }, hit('snare', 1)])), { hands: ['left', undefined], source: 'lesson' })
  assert.equal(stickingFor(song(groove)).source, 'suggested')
  // A long part stays quick.
  const long = [...Array(4000)].map((_, i) => hit(i % 2 ? 'snare' : 'hihat', i / 4, i % 2 ? undefined : 42))
  const started = Date.now()
  suggestSticking(song(long))
  assert.ok(Date.now() - started < 2000, 'thousands of strokes are sticked quickly')

  console.log('Sticking checks passed: groove, runs, tempo, fills, crossings, two-drum moments, impossible moments, lessons.')
} finally {
  await vite.close()
}
