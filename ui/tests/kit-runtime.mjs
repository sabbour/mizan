// Run from ui\: node tests\kit-runtime.mjs [--assets <dir with AcousticKit.glb and ElectronicKit.glb>]
// The 3D kit's runtime: the shared hit feedback from the playback clock, and each kit prepared in every look.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'vite'

globalThis.matchMedia = () => ({ matches: false })
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { feedbackAt, HAND_GLOW, PIECE_GLOW, LOOKAHEAD } = await vite.ssrLoadModule('/src/workspace/kitFeedback.ts')
  const { motionMatrix, usesElectronicStudioLighting } = await vite.ssrLoadModule('/src/workspace/kitRenderer.ts')
  const { prepare, lodFor, triangleCount } = await vite.ssrLoadModule('/src/workspace/kitAsset.ts')
  const { LOOKS, KIT_TYPES } = await vite.ssrLoadModule('/src/workspace/prefs.ts')
  const { fallbackScene } = await vite.ssrLoadModule('/src/workspace/kitScene.ts')

  // ---------- Feedback from the clock ----------
  const strikes = new Map([
    ['snare', [{ beat: 1, velocity: 0.95, specified: true, hand: 'left' }, { beat: 1.5, velocity: 0.3, specified: true, hand: 'right' }, { beat: 3, velocity: 0.9, specified: true, hand: 'both' }]],
    ['kick', [{ beat: 0, velocity: 0.9, specified: true }, { beat: 2, velocity: 0.9, specified: true }]],
  ])
  const opts = { secondsPerBeat: 0.5, loop: null, countLength: 4, sticking: true, reduced: false }
  const at = (beat, extra = {}) => feedbackAt(strikes, { beat, playing: true, countingIn: false, countBeat: 0, ...extra }, { ...opts, ...extra })
  // Paused: nothing lit, nothing pending.
  assert.equal(feedbackAt(strikes, { beat: 1, playing: false, countingIn: false, countBeat: 0 }, opts).size, 0, 'pausing clears every glow and pulse')
  // Upcoming: rises through the lookahead, in the colour of the hand that will play it.
  const before = [0.1, 0.5, 0.9].map((b) => at(b).get('snare').upcoming)
  assert.ok(before[0] < 0.05 && before[0] < before[1] && before[1] < before[2], `anticipation rises as the note approaches: ${before}`)
  assert.deepEqual(at(0.9).get('snare').upcomingTint, HAND_GLOW.left, 'the upcoming left-hand note glows blue')
  // Hit now: a bright pulse in the played hand's colour that fades; the next stroke's hand shows as upcoming.
  const hit = at(1.0)
  assert.ok(hit.get('snare').pulse > 0.8 && hit.get('snare').since === 0, 'the hit pulses at its beat')
  assert.deepEqual(hit.get('snare').tint, HAND_GLOW.left)
  assert.deepEqual(at(1.4).get('snare').upcomingTint, HAND_GLOW.right, 'alternating strokes: the next (right) stroke is anticipated in orange')
  const fade = [1.0, 1.05, 1.1].map((b) => at(b).get('snare').pulse)
  assert.ok(fade[0] > fade[1] && fade[1] > fade[2], `the pulse fades: ${fade}`)
  assert.ok(at(1.5).get('snare').pulse < at(1.0).get('snare').pulse, 'a ghost note pulses less than an accent')
  // Both hands at once: shown side by side, not mixed.
  const both = at(3.0).get('snare')
  assert.ok(both.split && both.tint === HAND_GLOW.left && both.tint2 === HAND_GLOW.right, 'both hands show blue and orange halves')
  // Feet and sticking off: the piece's own colour.
  assert.deepEqual(at(1.9).get('kick').upcomingTint, PIECE_GLOW.kick, 'the kick has no hand: it glows in its own colour')
  assert.deepEqual(feedbackAt(strikes, { beat: 0.9, playing: true, countingIn: false, countBeat: 0 }, { ...opts, sticking: false }).get('snare').upcomingTint, PIECE_GLOW.snare,
    'with sticking off the feedback keeps going in the piece colour')
  // Loop: approaching the loop end anticipates the first note inside the loop, not a note after it.
  const loop = { start: 0, end: 2 }
  const wrap = feedbackAt(strikes, { beat: 1.8, playing: true, countingIn: false, countBeat: 0 }, { ...opts, loop })
  assert.ok(wrap.get('kick').upcoming > 0.4, 'the kick at the loop start is anticipated before the wrap')
  assert.ok(!(feedbackAt(strikes, { beat: 1.8, playing: true, countingIn: false, countBeat: 0 }, { ...opts, loop: { start: 0.5, end: 1.9 } }).get('kick')?.upcoming > 0.5), 'a note beyond the loop end is not anticipated')
  // Count-in: only the first notes are anticipated, rising with the count.
  const counting = [1, 2, 3, 4].map((countBeat) => feedbackAt(strikes, { beat: 0, playing: true, countingIn: true, countBeat }, opts).get('kick')?.upcoming ?? 0)
  assert.ok(counting.every((v, i) => i === 0 || v > counting[i - 1]), `the first kick builds through the count-in: ${counting}`)
  assert.ok(!feedbackAt(strikes, { beat: 0, playing: true, countingIn: true, countBeat: 4 }, opts).get('snare'), 'later notes are not anticipated during the count-in')
  // Speed: the pulse lasts the same time in seconds, so it spans more beats at a faster tempo.
  const slow = feedbackAt(strikes, { beat: 3.3, playing: true, countingIn: false, countBeat: 0 }, { ...opts, secondsPerBeat: 1 }).get('snare').pulse
  const fast = feedbackAt(strikes, { beat: 3.3, playing: true, countingIn: false, countBeat: 0 }, { ...opts, secondsPerBeat: 0.25 }).get('snare').pulse
  assert.ok(fast > slow, 'at a faster tempo the pulse covers more beats')
  // Close repeated notes on one piece: every hit flashes and goes dark before the next, at any tempo; anticipation
  // of the next note starts only after the pulse; hands keep their colours. Separated notes keep the full pulse.
  const level = (f) => f ? Math.max(f.pulse, f.upcoming * 0.55) : 0
  for (const [bpm, step, label] of [[100, 0.25, 'sixteenths at 100'], [160, 0.5, 'eighths at 160'], [140, 0.25, 'sixteenths at 140'], [70, 1 / 6, 'sextuplets at 70']]) {
    const hats = new Map([['hihat', Array.from({ length: 16 }, (_, k) => ({ beat: k * step, velocity: k % 2 ? 0.6 : 0.95, specified: true, hand: k % 2 ? 'left' : 'right' }))]])
    const o = { ...opts, secondsPerBeat: 60 / bpm }
    for (let k = 1; k < 14; k++) {
      const samples = Array.from({ length: 41 }, (_, s) => feedbackAt(hats, { beat: k * step + (s / 40) * step - 1e-6, playing: true, countingIn: false, countBeat: 0 }, o).get('hihat'))
      const peak = level(feedbackAt(hats, { beat: k * step, playing: true, countingIn: false, countBeat: 0 }, o).get('hihat'))
      const dip = Math.min(...samples.slice(1, 40).map(level))
      assert.ok(peak > 0.5 && dip < 0.1 * peak, `${label}: hit ${k} flashes (${peak.toFixed(2)}) and goes dark (${dip.toFixed(3)}) before the next`)
      assert.deepEqual(feedbackAt(hats, { beat: k * step, playing: true, countingIn: false, countBeat: 0 }, o).get('hihat').tint, HAND_GLOW[k % 2 ? 'left' : 'right'], `${label}: hit ${k} keeps its hand colour`)
    }
  }
  const quarters = new Map([['snare', [0, 1, 2, 3].map((beat) => ({ beat, velocity: 0.9, specified: true }))]])
  const q = (beat) => feedbackAt(quarters, { beat, playing: true, countingIn: false, countBeat: 0 }, { ...opts, secondsPerBeat: 60 / 60 }).get('snare')
  assert.ok(q(1.4).pulse > 0 && q(1.44).pulse < 0.01, 'separated hits at 60 bpm keep the full 0.45 s pulse')
  assert.ok(q(1.5).upcoming > 0 && q(1.5).upcomingTint === PIECE_GLOW.snare, 'and still anticipate the next note through the beat')
  assert.equal(LOOKAHEAD, 1)
  assert.ok(usesElectronicStudioLighting('electronic', 'Realistic'), 'electronic kits use the added studio reflections in the realistic look')
  assert.ok(!usesElectronicStudioLighting('acoustic', 'Realistic'), 'acoustic kits keep the existing realistic lighting')
  assert.ok(!usesElectronicStudioLighting('electronic', 'ClayStudyModel') &&
    !usesElectronicStudioLighting('electronic', 'NeonRhythm') &&
    !usesElectronicStudioLighting('electronic', 'TechnicalBlueprint'), 'the added lighting is limited to the electronic realistic look')
  assert.ok(!usesElectronicStudioLighting(undefined, 'Realistic'), 'shared renderer callers such as piano keep their existing lighting by default')
  // Reduced motion: a steady mark, no wobble.
  const calm = feedbackAt(strikes, { beat: 1.05, playing: true, countingIn: false, countBeat: 0 }, { ...opts, reduced: true }).get('snare')
  assert.ok(calm.pulse === 0.8 && calm.since === 99, 'reduced motion shows a steady mark without wobble')
  // Motions: heads press, cymbals wobble then settle, pedals press, the beater draws back before a note.
  const ident = (m) => m.every((x, i) => Math.abs(x - [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1][i]) < 1e-6)
  const fb = (since, upcoming = 0) => ({ since, upcoming, velocity: 1, pulse: 1, tint: [1, 0, 0], tint2: [1, 0, 0], split: false, upcomingTint: [0, 0, 0] })
  assert.ok(motionMatrix({ motion: 'head' }, fb(0), 0)[13] < -0.002, 'a head presses in at the hit')
  assert.ok(ident(motionMatrix({ motion: 'head' }, undefined, 0)), 'an idle head is at rest')
  assert.ok(!ident(motionMatrix({ motion: 'cymbal' }, fb(0.05), 0)) && ident(motionMatrix({ motion: 'cymbal' }, fb(99), 0)), 'a cymbal wobbles, then settles')
  assert.ok(motionMatrix({ motion: 'pedal', angle: 0.18 }, fb(0), 0)[6] < 0, 'the pedal presses at the hit')
  assert.ok(motionMatrix({ motion: 'beater' }, fb(99, 0.9), 0)[6] > 0, 'the beater draws back before a note')
  assert.ok(Math.abs(motionMatrix({ motion: 'hat' }, undefined, -0.013)[13] + 0.013) < 1e-6, 'the hi-hat top rides to its state')
  assert.ok(ident(motionMatrix({ motion: 'hat' }, fb(0.05), 0, 0).map((x, i) => i === 13 ? 0 : x)), 'a closed hi-hat does not rock open when struck')
  assert.ok(!ident(motionMatrix({ motion: 'hat' }, fb(0.05), 0, 1)), 'an open hi-hat rocks when struck')

  // ---------- Each kit in every look ----------
  const dir = process.argv.includes('--assets') ? process.argv[process.argv.indexOf('--assets') + 1] : join(process.cwd(), 'public', 'models')
  const { readGlb } = await import('../scripts/kits/gltf.mjs')
  const files = { acoustic: 'AcousticKit.glb', electronic: 'ElectronicKit.glb' }
  for (const kit of KIT_TYPES) {
    const { json, bin } = readGlb(await readFile(join(dir, files[kit])))
    const asset = { json, bin: new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength), images: Promise.resolve([]) }
    const full = prepare(asset, 'Realistic')
    const geometry = (p) => p.items.map((item) => item.index.length).reduce((a, b) => a + b, 0)
    const names = (p) => p.items.filter((item) => item.target).map((item) => item.name).sort().join(',')
    assert.deepEqual([...LOOKS], ['Realistic', 'ClayStudyModel', 'NeonRhythm', 'TechnicalBlueprint'], 'four looks are offered')
    for (const look of LOOKS) {
      const p = prepare(asset, look)
      assert.ok(lodFor(asset, look) === 0 && triangleCount(p) === triangleCount(full), `${kit} ${look} draws the full model`)
      assert.equal(geometry(p), geometry(full), `${kit} ${look} keeps the full geometry`)
      assert.equal(names(p), names(full), `${kit} ${look} keeps every playable and moving part`)
      const targets = new Set(p.items.filter((item) => item.glows).map((item) => item.target))
      for (const piece of ['kick', 'snare', 'tom1', 'tom2', 'floor', 'hihat', 'hatPedal', 'crash', 'ride'])
        assert.ok(targets.has(piece), `${kit} ${look}: ${piece} has a surface for the feedback`)
      assert.ok(p.items.some((item) => item.motion === 'pedal' && item.target === 'kick') && p.items.some((item) => item.motion === 'beater') &&
        p.items.some((item) => item.motion === 'pedal' && item.target === 'hatPedal'), `${kit} ${look}: pedals and beater move`)
      assert.ok(!p.items.some((item) => /^COL_/.test(item.name)), `${kit} ${look}: colliders are never drawn`)
      const variant = (name) => p.items.find((item) => item.name === name)?.material.name ?? ''
      if (look !== 'Realistic') assert.ok(p.items.filter((item) => item.glows).every((item) => item.material.name.startsWith(look)), `${kit} ${look} uses its own materials`)
      if (look === 'NeonRhythm') {
        const crash = p.items.find((item) => item.name === 'Crash_Cymbal')
        assert.deepEqual(crash.material.emissive.map((x) => +(x / 0.45).toFixed(2)), [1, 0.45, 0.05], `${kit} neon crash edge is orange`)
        const heads = p.items.filter((item) => /Head$|_Pad$/.test(item.name) && !item.material.name.endsWith('Edge'))
        assert.ok(heads.every((item) => item.material.emissive.every((x) => x === 0)), `${kit} neon heads are not lit when idle`)
      }
      if (look === 'TechnicalBlueprint') assert.ok(p.items.some((item) => item.material.blend), `${kit} blueprint draws translucent parts`)
      if (look === 'ClayStudyModel') assert.ok(p.items.every((item) => item.material.metal <= 0.05 && item.material.baseTex < 0), `${kit} clay is matte with no photographic maps`)
      void variant
    }
    assert.ok(!full.items.some((item) => item.name.startsWith('Throne')), `${kit}: the throne behind the camera is left out of the view`)
  }
  assert.ok(fallbackScene('acoustic').items.length > 5, 'a built-in kit stands in when a model cannot load')
  console.log('Kit runtime checks passed: clock feedback (anticipation, hit, fade, dense repeats stay distinct, loop, count-in, rate, hands, sticking off, reduced motion), part motions, and both kits in all four looks.')
} finally {
  await vite.close()
}
