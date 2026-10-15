import assert from 'node:assert/strict'
import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { GUITAR, BASS, planFrettedTab } = await vite.ssrLoadModule('/src/workspace/fretboard.ts')
  const { planFrettedHand, suggestFrettedFingers } = await vite.ssrLoadModule('/src/workspace/frettedHand.ts')
  const { frettedReach, shapeFits } = await vite.ssrLoadModule('/src/workspace/playability.ts')

  const at = (string, fret, startBeat, config, extra = {}) =>
    ({ midi: config.strings[string - 1].midi + fret, string, fret, startBeat, beats: 1, ...extra })
  const fingersOf = (notes, config) => {
    const plan = planFrettedTab(notes, config)
    const memory = suggestFrettedFingers(plan, config)
    return { plan, memory, list: plan.map((note) => (note.position.fret ? memory.get(note.index) : 0)) }
  }

  // A scale in one position: one finger per fret.
  const scale = [[2, 5], [2, 7], [3, 5], [3, 7], [4, 5], [4, 7], [5, 5], [5, 8], [6, 5], [6, 8]].map(([s, f], i) => at(s, f, i, GUITAR))
  const chromatic = [5, 6, 7, 8, 7, 6, 5].map((f, i) => at(3, f, i, GUITAR))
  assert.deepEqual(fingersOf(chromatic, GUITAR).list, [1, 2, 3, 4, 3, 2, 1], 'a four-fret run in position is one finger per fret')
  const major = scale
  const majorList = fingersOf(major, GUITAR).list
  const fingerFrets = new Map()
  major.forEach((note, i) => {
    const frets = fingerFrets.get(majorList[i]) ?? new Set()
    frets.add(note.fret)
    fingerFrets.set(majorList[i], frets)
  })
  assert.ok([...fingerFrets.values()].every((frets) => frets.size === 1), 'a scale in one position never reuses a finger on a second fret')
  assert.deepEqual(majorList.slice(0, 2), [1, 3], 'frets 5 and 7 take the index and ring finger by position')

  // Bass low positions use the Simandl 1-2-4.
  const simandl = [1, 2, 3, 2, 1].map((f, i) => at(2, f, i, BASS))
  assert.deepEqual(fingersOf(simandl, BASS).list, [1, 2, 4, 2, 1], 'three low bass frets use 1-2-4, skipping the ring finger')
  const highBass = [7, 8, 9, 10].map((f, i) => at(2, f, i, BASS))
  assert.deepEqual(fingersOf(highBass, BASS).list, [1, 2, 3, 4], 'high on the bass it is one finger per fret')
  const lowBass4 = [1, 2, 3, 4].map((f, i) => at(2, f, i, BASS))
  assert.deepEqual(fingersOf(lowBass4, BASS).list, [1, 2, 3, 4], 'four frets in a row need all four fingers')

  // Open strings get no finger.
  const withOpen = [at(5, 0, 0, GUITAR), at(5, 2, 1, GUITAR), at(6, 0, 2, GUITAR)]
  const opened = fingersOf(withOpen, GUITAR)
  assert.equal(opened.memory.has(0), false)
  assert.equal(opened.memory.has(2), false)
  assert.ok(opened.memory.has(1))
  assert.equal(planFrettedHand([opened.plan[0], opened.plan[2]], GUITAR, opened.memory).contacts.length, 0, 'an open-string moment holds nothing')

  // Barre chords: F major and B minor.
  const chord = (frets, config) => frets.flatMap((fret, i) => fret === null ? [] : [at(i + 1, fret, 0, config)])
  for (const [name, frets, barreFret] of [['F major', [1, 3, 3, 2, 1, 1], 1], ['B minor', [null, 2, 4, 4, 3, 2], 2]]) {
    const plan = planFrettedTab(chord(frets, GUITAR), GUITAR)
    const grip = planFrettedHand(plan, GUITAR)
    assert.equal(grip.unavailable, false, `${name} can be fretted`)
    const barred = grip.contacts.filter((contact) => contact.fret === barreFret)
    assert.ok(barred.length >= 2 && barred.every((contact) => contact.finger === 1 && contact.barre), `${name} is an index barre`)
    const fingerFret = new Map()
    for (const contact of grip.contacts) {
      assert.equal(fingerFret.get(contact.finger) ?? contact.fret, contact.fret, `${name}: no finger holds two frets`)
      fingerFret.set(contact.finger, contact.fret)
    }
  }
  // Open E major uses separate fingers, no barre.
  const eMajor = planFrettedHand(planFrettedTab(chord([0, 2, 2, 1, 0, 0], GUITAR), GUITAR), GUITAR)
  assert.equal(eMajor.unavailable, false)
  assert.ok(eMajor.contacts.every((contact) => !contact.barre || contact.finger === 1))

  // A chord never gives one finger two frets and stays in reach, over every moment of a chord progression.
  const progression = [[0, 2, 2, 1, 0, 0], [null, 0, 2, 2, 2, 0], [3, 2, 0, 0, 0, 3], [null, 3, 2, 0, 1, 0], [1, 3, 3, 2, 1, 1],
    [null, 2, 4, 4, 3, 2], [null, 0, 2, 2, 1, 0], [3, 5, 5, 4, 3, 3]]
  progression.forEach((frets, beat) => {
    const plan = planFrettedTab(chord(frets, GUITAR).map((note) => ({ ...note, startBeat: beat })), GUITAR)
    const grip = planFrettedHand(plan, GUITAR)
    if (grip.unavailable) return
    const fingerFret = new Map()
    for (const contact of grip.contacts) {
      assert.equal(fingerFret.get(contact.finger) ?? contact.fret, contact.fret, `chord ${beat}: no finger holds two frets`)
      fingerFret.set(contact.finger, contact.fret)
    }
    for (const a of grip.contacts) for (const b of grip.contacts)
      if (a.finger < b.finger) assert.ok(b.fret - a.fret <= b.finger - a.finger + 1, `chord ${beat}: stretch within reach`)
    assert.ok(shapeFits(plan.map((note) => note.position), GUITAR), `chord ${beat} fits one hand`)
  })

  // Reach shrinks near the nut.
  assert.ok(frettedReach(BASS, 1) < frettedReach(BASS, 6) && frettedReach(GUITAR, 1) < frettedReach(GUITAR, 8))

  // A sample melody shifts the hand in fewer places than always taking the lowest fret.
  const melody = [66, 69, 73, 76, 73, 69, 66, 69, 73, 76, 78, 76, 73, 69]
    .map((midi, i) => ({ midi, startBeat: i * 0.5, beats: 0.5 }))
  const shifts = (plan) => {
    let count = 0
    let anchor = null
    for (const note of plan) {
      if (!note.position.fret) continue
      if (anchor !== null && (note.position.fret < anchor || note.position.fret > anchor + 4)) count++
      if (anchor === null || note.position.fret < anchor || note.position.fret > anchor + 4) anchor = note.position.fret
    }
    return count
  }
  const lowest = melody.map((note, index) => {
    // The old rule: the lowest fret that sounds the pitch.
    let best = null
    for (const item of GUITAR.strings) {
      const fret = note.midi - item.midi
      if (fret >= 0 && fret <= GUITAR.frets && (best === null || fret < best.fret)) best = { string: item.string, fret }
    }
    return { index, position: best }
  })
  const planned = planFrettedTab(melody, GUITAR)
  assert.ok(planned.every((note, i) => note.position.string && note.midi === melody[i].midi))
  assert.ok(shifts(planned) < shifts(lowest), `the path-based plan shifts ${shifts(planned)} times, the lowest-fret plan ${shifts(lowest)}`)

  // Lesson fingering is kept; the planner fills only what is missing.
  const written = [at(4, 5, 0, GUITAR, { finger: 2 }), at(4, 7, 1, GUITAR)]
  const keep = fingersOf(written, GUITAR)
  assert.equal(keep.memory.has(0), false, 'written fingers are not overwritten')
  assert.ok(keep.memory.get(1) > 2, 'the next fret takes a finger above the written one')

  // A whole song stays fast.
  const long = Array.from({ length: 4000 }, (_, i) => ({ midi: 40 + ((i * 7) % 30), startBeat: i * 0.25, beats: 0.25 }))
  const started = performance.now()
  suggestFrettedFingers(planFrettedTab(long, GUITAR), GUITAR)
  assert.ok(performance.now() - started < 3000, 'a few thousand notes are fingered quickly')

  console.log('Fretted fingering checks passed.')
} finally {
  await vite.close()
}
