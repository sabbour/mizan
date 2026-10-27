// Run from ui\: node tests\kit-hands.mjs
// The hands on the 3D drum kit and piano, without a browser: where the stick tips land, which hand plays what, the
// fingers on the keys, and that a pose depends only on the clock (seeking, looping and pausing show the same hand).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'vite'

globalThis.matchMedia = () => ({ matches: false })
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const dir = join(process.cwd(), 'public', 'models')
  const { readGlb } = await import('../scripts/kits/gltf.mjs')
  const { prepare } = await vite.ssrLoadModule('/src/workspace/kitAsset.ts')
  const { preparePiano } = await vite.ssrLoadModule('/src/workspace/pianoAsset.ts')
  const { decodeFrettedHand } = await vite.ssrLoadModule('/src/workspace/frettedHandAsset.ts')
  const { DrumHands, buildHandPlan, kitSurfaces } = await vite.ssrLoadModule('/src/workspace/drumHands.ts')
  const { PianoHands, buildPianoHandPlan, pianoGeometry } = await vite.ssrLoadModule('/src/workspace/pianoHands.ts')
  const { stickingFor } = await vite.ssrLoadModule('/src/workspace/sticking.ts')
  const { hatOffsetOf } = await vite.ssrLoadModule('/src/workspace/kitRenderer.ts')
  const { buildSong } = await vite.ssrLoadModule('/src/workspace/song.ts')

  const assetOf = async (file) => {
    const { json, bin } = readGlb(await readFile(join(dir, file)))
    return { json, bin: new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength), images: Promise.resolve([]) }
  }
  const hands = {
    left: decodeFrettedHand(new Uint8Array(await readFile(join(dir, 'FrettingLeftHand.glb')))),
    right: decodeFrettedHand(new Uint8Array(await readFile(join(dir, 'FrettingRightHand.glb')))),
  }
  const checksum = (data) => { let sum = 0; for (let i = 0; i < data.length; i += 7) sum += data[i] * ((i % 13) + 1); return sum }
  const mm = (metres) => `${(metres * 1000).toFixed(1)} mm`

  // ---------- Drums ----------
  const hit = (lane, startBeat, hand, extra = {}) => ({ lane, startBeat, velocity: 0.8, ...(hand ? { hand } : {}), ...extra })
  const groove = [
    ...[0, 1, 2, 3].flatMap((beat) => [hit('hihat', beat, 'right', { sourceMidi: 42 }), hit('hihat', beat + 0.5, 'right', { sourceMidi: 42 })]),
    hit('kick', 0), hit('kick', 2), hit('snare', 1, 'left'), hit('snare', 3, 'left'),
    hit('hightom', 4, 'right', { sourceMidi: 50 }), hit('floortom', 4.5, 'left', { sourceMidi: 43 }), hit('crash', 5, 'right'), hit('ride', 5.5, 'right'),
  ]
  const clockOf = (beat, extra = {}) => ({ beat, playing: true, countingIn: false, countBeat: 0, countLength: 4, secondsPerBeat: 0.5, loop: null, reduced: false, hatOffset: 0, ...extra })

  for (const file of ['AcousticKit.glb', 'ElectronicKit.glb']) {
    const prepared = prepare(await assetOf(file), 'Realistic')
    const surfaces = kitSurfaces(prepared)
    for (const piece of ['snare', 'tom1', 'tom2', 'floor', 'hihat', 'crash', 'ride']) {
      const surface = surfaces.get(piece)
      assert.ok(surface && surface.radius > 0.05 && surface.y > 0.4 && surface.y < 1.6, `${file}: ${piece} has a striking surface (${JSON.stringify(surface)})`)
    }
    const sticking = stickingFor({ ...buildSong(), drums: groove, bars: 8, bpm: 100, beatsPerBar: 4, source: 'course' })
    const plan = buildHandPlan(groove, sticking.hands, surfaces)
    assert.deepEqual([...new Set(plan.left.map((s) => s.piece))].sort(), ['floor', 'snare'], `${file}: the left hand plays the snare and floor tom as written`)
    assert.deepEqual([...new Set(plan.right.map((s) => s.piece))].sort(), ['crash', 'hihat', 'ride', 'tom1'], `${file}: the right hand plays the hi-hat, tom, crash and ride as written`)
    assert.equal(plan.left.length + plan.right.length, groove.filter((h) => h.lane !== 'kick').length, `${file}: every hand stroke has a hand and the kick has none`)

    const rig = new DrumHands(hands)
    for (const side of ['left', 'right']) assert.ok(rig.gripError[side].every((error) => error < 0.002), `${file}: ${side} fingers and thumb reach the stick (${rig.gripError[side].map((e) => mm(e))})`)
    // Every stroke lands: the stick tip is on the surface at the stroke's time, with the right hand.
    let worst = 0
    for (const side of ['left', 'right']) for (const stroke of plan[side]) {
      rig.update(plan, surfaces, clockOf(stroke.beat), true)
      const state = rig.state[side], surface = surfaces.get(stroke.piece)
      const gap = Math.abs(state.tip[1] - surface.y)
      worst = Math.max(worst, gap)
      assert.ok(gap < 0.01 && state.striking && state.piece === stroke.piece, `${file}: ${side} stick tip lands on ${stroke.piece} at beat ${stroke.beat} (off by ${mm(gap)})`)
      assert.ok(Math.hypot(state.tip[0] - surface.x, state.tip[2] - surface.z) <= surface.radius, `${file}: ${side} stick tip is over the ${stroke.piece}`)
      assert.ok(rig.overlays.every((overlay) => overlay.visible), `${file}: hands and sticks are drawn`)
    }
    // Between strokes the tip is off the surface.
    for (const side of ['left', 'right']) {
      const list = plan[side]
      for (let i = 0; i + 1 < list.length; i++) {
        if (list[i + 1].beat - list[i].beat < 0.4) continue
        const middle = (list[i].beat + list[i + 1].beat) / 2
        rig.update(plan, surfaces, clockOf(middle), true)
        assert.ok(rig.state[side].lift > 0.02 && !rig.state[side].striking, `${file}: ${side} stick is raised between strokes (lift ${mm(rig.state[side].lift)})`)
      }
    }
    // Seeking, looping and pausing: the pose depends only on the clock.
    const probe = clockOf(2.3)
    rig.update(plan, surfaces, probe, true)
    const first = [0, 1, 2, 3].map((i) => checksum(rig.overlays[i].data))
    for (const beat of [0, 5.9, 1.01, 3.3]) rig.update(plan, surfaces, clockOf(beat), true)
    rig.update(plan, surfaces, probe, true)
    assert.deepEqual([0, 1, 2, 3].map((i) => checksum(rig.overlays[i].data)), first, `${file}: the same time gives the same hands and sticks after seeking around`)
    const loop = { start: 0, end: 4 }
    rig.update(plan, surfaces, clockOf(0.2, { loop }), true)
    const looped = rig.state.right.tip.slice()
    rig.update(plan, surfaces, clockOf(3.9, { loop }), true)
    rig.update(plan, surfaces, clockOf(0.2, { loop }), true)
    assert.deepEqual(rig.state.right.tip, looped, `${file}: looping does not carry state`)
    // Across a loop's end the right hand heads for the first stroke in the loop (the hi-hat), not into the unplayed bar.
    rig.update(plan, surfaces, clockOf(3.95, { loop }), true)
    assert.equal(rig.state.right.piece, 'hihat', `${file}: the loop's last gap leads back to the loop's first stroke`)
    // Paused and counting in: ready over the first strokes, nothing striking.
    rig.update(plan, surfaces, clockOf(0, { playing: false }), true)
    assert.ok(!rig.state.left.striking && !rig.state.right.striking && rig.state.left.piece === 'snare' && rig.state.right.piece === 'hihat', `${file}: paused hands wait over their first strokes`)
    // A stroke on the very first beat is the one the hand waits over, not the one after it.
    const openers = { left: [{ beat: 0.5, piece: 'tom1', velocity: 0.8 }], right: [{ beat: 0, piece: 'snare', velocity: 0.8 }, { beat: 1, piece: 'tom2', velocity: 0.8 }] }
    rig.update(openers, surfaces, clockOf(0, { playing: false }), true)
    assert.ok(rig.state.right.piece === 'snare' && rig.state.left.piece === 'tom1', `: paused at a stroke, the hand waits over that stroke's drum`)
    rig.update(plan, surfaces, clockOf(0, { countingIn: true, countBeat: 2 }), true)
    assert.ok(!rig.state.left.striking && rig.state.right.lift > 0.04, `${file}: counting in, the right stick is raised ready for the hi-hat`)
    // Reduced motion: the tip is still at the target, touching it in the instant of a stroke and not swinging between.
    rig.update(plan, surfaces, clockOf(0.1, { reduced: true }), true)
    const held = rig.state.right.tip.slice()
    rig.update(plan, surfaces, clockOf(0.3, { reduced: true }), true)
    assert.deepEqual([rig.state.right.tip[0], rig.state.right.tip[2]], [held[0], held[2]], `${file}: reduced motion holds still between strokes`)
    rig.update(plan, surfaces, clockOf(1.0, { reduced: true }), true)
    assert.ok(Math.abs(rig.state.left.tip[1] - surfaces.get('snare').y) < 0.01, `${file}: reduced motion still touches the snare when it is struck`)
    // No stick through a drum or cymbal: sample the stick along its length through the whole pattern.
    let penetrations = 0
    for (let beat = 0; beat < 6; beat += 0.02) {
      rig.update(plan, surfaces, clockOf(beat), true)
      for (const side of ['left', 'right']) {
        const { grip, direction } = rig.state[side]
        for (let along = -0.13; along <= 0.26; along += 0.02) {
          const p = [grip[0] + direction[0] * along, grip[1] + direction[1] * along, grip[2] + direction[2] * along]
          for (const surface of surfaces.values()) {
            const inside = Math.hypot(p[0] - surface.x, p[2] - surface.z) < surface.radius * 0.92
            if (inside && p[1] < surface.y - 0.004 && p[1] > surface.y - 0.05) penetrations++
          }
        }
      }
    }
    assert.equal(penetrations, 0, `${file}: no stick passes through a drum or cymbal (${penetrations} samples)`)
    // Hi-hat openness: the tip follows the cymbal's height.
    const open = hatOffsetOf(prepared, 'open')
    rig.update(plan, surfaces, clockOf(0, { hatOffset: open }), true)
    assert.ok(Math.abs(rig.state.right.tip[1] - (surfaces.get('hihat').y + open)) < 0.01, `${file}: the stick lands on the hat in its current state`)
    // Hands end in a short faded wrist: no upper arm or elbow overlays exist, and each wrist reaches 5 cm back along its hand.
    const pose = (beat) => rig.update(plan, surfaces, clockOf(beat), true)
    assert.ok(!rig.overlays.some((o) => /upper-arm|forearm/.test(o.name)), `${file}: no arm overlays are drawn`)
    for (const beat of [0, 1, 2.5, 4, 5.5]) {
      pose(beat)
      for (const side of ['left', 'right']) {
        const overlay = rig.overlays.find((o) => o.name === `${side}-wrist`)
        assert.ok(overlay?.visible && overlay.fade && overlay.data.every(Number.isFinite), `${file}: the ${side} hand has a visible faded wrist at beat ${beat}`)
        const wrist = rig.wrist(side), axis = rig.state[side].forearm
        let farthest = 0
        for (let v = 0; v < overlay.data.length; v += 12) farthest = Math.max(farthest, Math.hypot(overlay.data[v] - wrist[0], overlay.data[v + 1] - wrist[1], overlay.data[v + 2] - wrist[2]))
        assert.ok(farthest > 0.04 && farthest < 0.08, `${file}: the ${side} wrist reaches about 5 cm past the wrist joint (${(farthest * 100).toFixed(1)} cm)`)
        const far = [0, 1, 2].map((k) => overlay.data[k])
        const back = (far[0] - wrist[0]) * axis[0] + (far[1] - wrist[1]) * axis[1] + (far[2] - wrist[2]) * axis[2]
        assert.ok(back > 0.04, `${file}: the ${side} wrist continues along the back of the hand (${(back * 100).toFixed(1)} cm)`)
        assert.ok(overlay.data[6] >= 2 && overlay.data[(overlay.data.length / 12 - 1) * 12 + 6] >= 2 && overlay.data[6] > overlay.data[overlay.data.length - 6], `${file}: the ${side} wrist fades out toward its far end`)
      }
    }    // A song with no hands written is still played by suggested hands.
    const unwritten = groove.map(({ hand: _hand, ...rest }) => rest)
    const suggested = buildHandPlan(unwritten, stickingFor({ ...buildSong(), drums: unwritten, bars: 8, bpm: 100, beatsPerBar: 4, source: 'x' }).hands, surfaces)
    assert.ok(suggested.right.length >= 8 && suggested.left.length >= 2, `${file}: suggested sticking drives both hands`)
    console.log(`${file}: ${plan.left.length + plan.right.length} strokes land within ${mm(worst)}`)
  }

  // ---------- Piano ----------
  const prepared = preparePiano(await assetOf('StagePiano88.glb'), 'Realistic')
  const geometry = pianoGeometry(prepared)
  const note = (midi, startBeat, beats, hand, finger) => ({ midi, startBeat, beats, ...(hand ? { hand } : {}), ...(finger ? { finger } : {}), velocity: 0.8 })
  const has = (key) => prepared.keys.has(key)
  const rig = new PianoHands(hands)
  const clock = (beat, extra = {}) => ({ beat, playing: true, countingIn: false, secondsPerBeat: 0.5, loop: null, reduced: false, ...extra })
  const chord = [note(60, 0, 2, 'right', 1), note(64, 0, 2, 'right', 3), note(67, 0, 2, 'right', 5), note(48, 0, 2, 'left', 5), note(55, 0, 2, 'left', 1),
    note(62, 2, 2, 'right', 1), note(65, 2, 2, 'right', 3), note(69, 2, 2, 'right', 5), note(50, 2, 2, 'left', 5), note(57, 2, 2, 'left', 1)]
  const scale = [[60, 1], [62, 2], [64, 3], [65, 1], [67, 2], [69, 3], [71, 4], [72, 5]].map(([midi, finger], index) => note(midi, index * 0.5, 0.5, 'right', finger))
  const black = [note(61, 0, 1, 'right', 2), note(63, 1, 1, 'right', 3), note(66, 2, 1, 'right', 2), note(68, 3, 1, 'right', 3), note(58, 0, 2, 'left', 2)]
  for (const [name, notes] of [['chord', chord], ['scale', scale], ['black keys', black]]) {
    const plan = buildPianoHandPlan(notes, has)
    assert.ok(!plan.placedByPitch && !plan.fingersSuggested, `${name}: written hands and fingers are used as written`)
    const timelines = rig.compile(plan, geometry)
    let worstPress = 0, worstAny = 0
    const beats = [...new Set(notes.flatMap((n) => [n.startBeat, n.startBeat + n.beats / 2, n.startBeat + 0.02]))]
    for (const beat of beats) {
      rig.update(timelines, geometry, clock(beat + 0.001), true)
      for (const side of ['left', 'right']) for (const finger of rig.state[side].fingers) {
        worstAny = Math.max(worstAny, finger.error)
        if (finger.pressing === null) {
          assert.ok(finger.pad[1] > geometry.whiteTop - 0.007, `${name}: a resting ${side} finger ${finger.finger} stays above the keys at beat ${beat}`)
          continue
        }
        const written = notes.find((n) => n.hand === side && n.finger === finger.finger && Math.round(n.midi) === finger.pressing)
        assert.ok(written && written.startBeat <= beat + 0.002 && beat < written.startBeat + written.beats, `${name}: ${side} finger ${finger.finger} presses ${finger.pressing} only while it sounds (beat ${beat})`)
        const key = geometry.keys.get(finger.pressing)
        assert.ok(Math.abs(finger.target[0] - key.x) < 0.001 && finger.target[1] <= key.top + 0.0005 && finger.target[1] > key.top - 0.012, `${name}: the target is on key ${finger.pressing}`)
        worstPress = Math.max(worstPress, finger.error)
        assert.ok(finger.error < 0.004, `${name}: ${side} finger ${finger.finger} reaches key ${finger.pressing} within ${mm(finger.error)} at beat ${beat}`)
        assert.ok(Math.abs(finger.pad[0] - key.x) < geometry.keyWidth / 2 && finger.pad[1] < key.top + 0.004, `${name}: the fingertip is on key ${finger.pressing} (${mm(finger.pad[1] - key.top)} above its top)`)
      }
      for (const side of ['left', 'right']) {
        const fingers = rig.state[side].fingers
        const direction = side === 'right' ? 1 : -1
        for (let index = 1; index < 4; index++) {
          assert.ok(direction * (fingers[index + 1].pad[0] - fingers[index].pad[0]) > 0,
            `${name}: adjacent non-thumb fingertips do not cross in the rendered ${side} hand at beat ${beat}`)
        }
      }
    }
    for (const beat of beats) {
      rig.update(timelines, geometry, clock(beat + 0.001), true)
      for (const side of ['left', 'right']) {
        const overlay = rig.overlays.find((o) => o.name === `${side}-wrist`)
        assert.ok(overlay?.visible && overlay.fade && overlay.data.every(Number.isFinite), `${name}: the ${side} hand has a visible faded wrist`)
        assert.ok(!rig.overlays.some((o) => /upper-arm|forearm/.test(o.name)), `${name}: no arm overlays are drawn`)
        assert.ok(rig.state[side].wrist.every(Number.isFinite), `${name}: the ${side} wrist position is known`)
      }
    }    // Only the hand written for a note plays it.
    rig.update(timelines, geometry, clock(0.01), true)
    assert.deepEqual(rig.state.left.fingers.filter((f) => f.pressing !== null).map((f) => f.pressing).sort(), notes.filter((n) => n.hand === 'left' && n.startBeat === 0).map((n) => n.midi).sort(), `${name}: the left hand presses the left-hand notes`)
    // Seeking: same time, same hands.
    const probe = clock(beats[1] + 0.13)
    rig.update(timelines, geometry, probe, true)
    const before = [checksum(rig.overlays[0].data), checksum(rig.overlays[1].data)]
    for (const beat of [3.2, 0, 1.7]) rig.update(timelines, geometry, clock(beat), true)
    rig.update(timelines, geometry, probe, true)
    assert.deepEqual([checksum(rig.overlays[0].data), checksum(rig.overlays[1].data)], before, `${name}: the same time gives the same hands after seeking`)
    // Gliding: no jump between frames at 60 fps.
    let jump = 0, last = null
    for (let beat = 0; beat < 4; beat += 1 / 60 / 0.5) {
      rig.update(timelines, geometry, clock(beat), true)
      const centre = rig.state.right.center
      if (last !== null) jump = Math.max(jump, Math.abs(centre - last))
      last = centre
    }
    // The written upward 3-to-2 black-key transition requires a reposition after release. Do not glide away from a held key.
    const largestStep = name === 'black keys' ? 0.08 : 0.012
    assert.ok(jump < largestStep, `${name}: movement stays bounded (largest step ${mm(jump)})`)
    // Reduced motion: no gliding, a still hand over the notes.
    rig.update(timelines, geometry, clock(1.9, { reduced: true }), true)
    const still = rig.state.right.center
    rig.update(timelines, geometry, clock(1.99, { reduced: true }), true)
    assert.equal(rig.state.right.center, still, `${name}: reduced motion keeps the hand still until the next notes`)
    console.log(`${name}: pressing fingertips within ${mm(worstPress)} of their keys (worst finger anywhere ${mm(worstAny)})`)
  }

  // This written 3-to-2 upward transition needs a hand reposition, not an index finger passing through a held middle finger.
  for (const duration of [0.9, 0.95, 1]) {
    const reposition = rig.compile(buildPianoHandPlan([
      note(63, 0, duration, 'right', 3), note(66, 1, 1, 'right', 2),
    ], has), geometry)
    for (let beat = 0.01; beat < 2; beat += 0.02) {
      rig.update(reposition, geometry, clock(beat), true)
      const fingers = rig.state.right.fingers
      for (let index = 1; index < 4; index++) assert.ok(fingers[index + 1].pad[0] > fingers[index].pad[0],
        `a reposition never crosses non-thumb fingertips at beat ${beat}`)
      for (const finger of fingers.filter((item) => item.pressing !== null)) assert.ok(finger.error < 0.004,
        `anticipating the next hand position does not pull a held fingertip away from its key at beat ${beat}`)
    }
  }

  // Hands placed by pitch, and fingers suggested, when the music names neither.
  const bare = [note(60, 0, 1), note(64, 1, 1), note(48, 0, 4), note(72, 3, 1), note(55, 2, 2)]
  const bared = buildPianoHandPlan(bare, has)
  assert.ok(bared.placedByPitch && bared.fingersSuggested, 'music with no hands is placed by pitch with suggested fingers')
  assert.deepEqual(bared.left.map((e) => e.key).sort(), [48, 55], 'notes below middle C go to the left hand')
  assert.deepEqual(bared.right.map((e) => e.key).sort((a, b) => a - b), [60, 64, 72], 'notes from middle C up go to the right hand')
  assert.ok([...bared.left, ...bared.right].every((event) => event.finger >= 1 && event.finger <= 5), 'every note has a finger')
  const bareTimelines = rig.compile(bared, geometry)
  for (const beat of [0.01, 1.01, 2.01, 3.01]) {
    rig.update(bareTimelines, geometry, clock(beat), true)
    for (const side of ['left', 'right']) for (const finger of rig.state[side].fingers) if (finger.pressing !== null) assert.ok(finger.error < 0.004, `pitch-placed ${side} finger ${finger.finger} reaches key ${finger.pressing} (${mm(finger.error)})`)
  }
  // A chord with no written fingers never gives two notes one finger.
  const triad = buildPianoHandPlan([note(60, 0, 1, 'right'), note(64, 0, 1, 'right'), note(67, 0, 1, 'right')], has)
  assert.equal(new Set(triad.right.map((e) => e.finger)).size, 3, 'a three-note chord uses three different fingers')
  console.log('Kit hands: all checks passed')
} finally {
  await vite.close()
}
