// The electronic kit: tubular rack with module, mesh-head pads (snare, two toms, floor), rubber cymbal pads, a
// separate hi-hat controller, a kick tower with pedal and beater, and a throne. Same axes as the acoustic kit.
import { cymbal, lathe, M, merge, pedalParts, rod, roundedBox, seg, sweep, transform, tripod, v } from './parts.mjs'

const P = (mesh, key, cat, comp, role) => ({ mesh, key, cat, comp, role })
const localize = (world, prims) => prims.map((p) => ({ ...p, mesh: transform(p.mesh, M.inverseRigid(world)) }))
const flip = (mesh) => {
  const idx = mesh.idx.slice()
  for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]]
  return { ...mesh, n: mesh.n.map((x) => -x), idx }
}
const roundPath = (points, radius = 0.025, steps = 5) => {
  const out = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], prev = points[i - 1], next = points[i + 1]
    const cut = Math.min(radius, v.len(v.sub(prev, p)) * 0.35, v.len(v.sub(next, p)) * 0.35)
    const a = v.add(p, v.scale(v.norm(v.sub(prev, p)), cut))
    const b = v.add(p, v.scale(v.norm(v.sub(next, p)), cut))
    out.push(a)
    for (let j = 1; j <= steps; j++) {
      const t = j / steps, u = 1 - t
      out.push([0, 1, 2].map((k) => u * u * a[k] + 2 * u * t * p[k] + t * t * b[k]))
    }
  }
  out.push(points.at(-1))
  return out
}

export const ELECTRONIC_MATERIALS = (t) => ({
  rubber: { name: 'MAT_Rubber_Black', set: t.rubberCymbal, size: 2048 },
  mesh: { name: 'MAT_MeshHead_LightGray', set: t.meshHead, size: 2048 },
  powder: { name: 'MAT_PowderCoatedMetal_Black', set: t.powderCoat, size: 2048 },
  steel: { name: 'MAT_Steel_Brushed', set: t.steelBrushed, size: 1024 },
  chrome: { name: 'MAT_Chrome', set: t.chrome, size: 1024 },
  plastic: { name: 'MAT_Plastic_Black', set: t.plasticBlack, size: 1024 },
  glass: { name: 'MAT_DisplayGlass', set: t.displayGlass, size: 1024 },
  emission: { name: 'MAT_DisplayEmission', set: t.displayGlass, size: 1024, emissive: true },
  vinyl: { name: 'MAT_SeatVinyl_Black', set: t.seatVinyl, size: 1024 },
})

export const ELECTRONIC_LAYOUT = {
  Snare: { center: [-0.22, 0.62, 0.12], R: 0.15, H: 0.075, tilt: [0.14, 0.04] },
  TomHigh: { center: [-0.15, 0.8, -0.19], R: 0.125, H: 0.065, tilt: [0.32, -0.08] },
  TomMid: { center: [0.15, 0.8, -0.19], R: 0.125, H: 0.065, tilt: [0.32, 0.08] },
  FloorTom: { center: [0.4, 0.6, 0.06], R: 0.15, H: 0.1, tilt: [0.14, 0.06] },
  HiHat: { center: [-0.48, 0.86, 0.04], R: 0.15, tilt: [0.06, -0.04], pedal: [-0.3, 0, 0.12] },
  Crash: { center: [-0.42, 1.09, -0.28], R: 0.175, tilt: [0.3, -0.12] },
  Ride: { center: [0.46, 1.04, -0.28], R: 0.2, tilt: [0.25, 0.14] },
  Kick: { tower: [0, 0, -0.1], padY: 0.27, R: 0.11 },
  Rack: { left: [-0.55, -0.2], right: [0.6, -0.2], height: 1.0, bar: 0.62 },
  Module: { center: [-0.6, 0.94, -0.12] },
  Throne: { center: [0, 0, 0.35], seat: 0.52 },
}

/** Builds one level of detail of the electronic kit; returns the root node index. */
export function buildElectronic(kit, q, rootExtras) {
  const S = (n, min = 6) => seg(n, q, min)
  const footMesh = () => lathe([[0, 0], [0.013, 0], [0.014, 0.008], [0.011, 0.022], [0, 0.022]], S(16, 6))
  const L = ELECTRONIC_LAYOUT
  const segs = S(128, 16)
  const rings = [20, 8, 3][q]
  const root = kit.part('ElectronicDrumKit', M.identity(), null, [], rootExtras)

  // ---------- Rack ----------
  const rack = kit.part('Rack', M.identity(), root)
  const [lx, lz] = L.Rack.left, [rx, rz] = L.Rack.right
  const postMesh = merge(
    rod([0, 0.03, 0], [0, L.Rack.height, 0], 0.019, S(24, 8)),
    transform(lathe([[0, 0], [0.022, 0], [0.023, 0.02], [0.02, 0.03], [0, 0.03]], S(20, 8)), M.t(0, L.Rack.height, 0)),
  )
  kit.part('Rack_LeftPost', M.t(lx, 0, lz), rack, [P(postMesh, 'powder', 'hardware')], { pivot: 'post base' })
  kit.part('Rack_RightPost', M.t(rx, 0, rz), rack, [P(postMesh, 'powder', 'hardware')], { pivot: 'post base' })
  const barWorld = M.t(lx, L.Rack.bar, lz)
  kit.part('Rack_Crossbar', barWorld, rack, localize(barWorld, [P(merge(
    rod([lx, L.Rack.bar, lz], [rx, L.Rack.bar, rz], 0.019, S(24, 8)),
    rod([lx, 0.34, lz], [rx, 0.34, rz], 0.016, S(20, 8)),
  ), 'powder', 'hardware')]))
  {
    const legs = kit.part('Rack_Legs', M.identity(), rack)
    const legMesh = merge(rod([0, 0.04, -0.22], [0, 0.04, 0.24], 0.017, S(20, 8)), transform(roundedBox(0.05, 0.05, 0.05, 0.01, { steps: q ? 1 : 2 }), M.t(0, 0.04, 0)))
    const feet = merge(transform(footMesh(), M.t(0, 0, -0.22)), transform(footMesh(), M.t(0, 0, 0.24)))
    const first = kit.part('Rack_Leg_Left', M.t(lx, 0, lz), legs, [P(legMesh, 'powder', 'hardware'), P(feet, 'rubber', 'rubber')])
    kit.instance('Rack_Leg_Right', M.t(rx, 0, rz), legs, first)
  }
  const clamps = kit.part('Rack_Clamps', M.identity(), rack)
  const clampMesh = roundedBox(0.06, 0.06, 0.06, 0.012, { steps: q ? 1 : 2 })
  const clampBolt = transform(lathe([[0, 0], [0.012, 0], [0.012, 0.022], [0, 0.026]], S(12, 6)), M.chain(M.t(0, 0, 0.03), M.rx(Math.PI / 2)))
  let firstClamp = null
  const clamp = (name, at) => {
    if (firstClamp === null) firstClamp = kit.part(name, M.t(...at), clamps, [P(clampMesh, 'plastic', 'hardware'), P(clampBolt, 'chrome', 'hardware')])
    else kit.instance(name, M.t(...at), clamps, firstClamp)
  }
  const arms = kit.part('Rack_MountingArms', M.identity(), rack)
  /** A straight arm from a clamp on a rack tube to a pad's bracket, with a ball joint at the bracket. */
  const arm = (name, from, to) => {
    const world = M.t(...from)
    kit.part(name, world, arms, localize(world, [P(merge(
      rod(from, to, 0.0115, S(16, 8)),
      transform(lathe([[0, -0.018], [0.014, -0.014], [0.018, 0], [0.014, 0.014], [0, 0.018]], S(16, 8)), M.t(to[0], to[1] - 0.02, to[2])),
    ), 'powder', 'hardware')]), { pivot: 'clamp' })
  }

  /** A mesh pad: plastic body, mesh head, thick rubber rim. Pivot at its mounting bracket under the body. */
  const pad = (name, { center, R, H, tilt }, comp, armFrom) => {
    const world = M.chain(M.t(...center), M.rx(tilt[0]), M.rz(tilt[1]))
    const bracketLocal = [0, -H / 2 - 0.02, 0]
    const pivot = M.mul(world, M.t(...bracketLocal))
    const node = kit.part(name, pivot, root, [], { pivot: 'mounting bracket' })
    const body = merge(
      lathe([[R - 0.008, -H / 2], [R - 0.012, -H / 2 + 0.002], [R - 0.004, -H / 2 + 0.006], [R, -H / 2 + 0.014], [R, H / 2 - 0.01], [R - 0.004, H / 2 - 0.004], [R - 0.01, H / 2], [R - 0.012, H / 2]], segs),
      flip(lathe([[0, -H / 2], [R - 0.008, -H / 2]].reverse(), segs)),
      transform(roundedBox(0.05, 0.03, 0.05, 0.008, { steps: q ? 1 : 2 }), M.t(0, -H / 2 - 0.012, 0)),
      // Small lug-style blocks around the shell, as on the reference pads.
      ...Array.from({ length: q === 2 ? 0 : 6 }, (_, i) => {
        const a = (i / 6) * Math.PI * 2 + 0.3
        return transform(roundedBox(0.012, H * 0.45, 0.01, 0.003, { steps: 1 }), M.chain(M.ry(Math.PI / 2 - a), M.t(0, 0, R + 0.004)))
      }),
    )
    kit.part(`${name}_Body`, world, node, [P(body, 'plastic', 'drum')])
    const headProfile = [[R - 0.009, H / 2 - 0.006], [R - 0.009, H / 2 + 0.003]]
    for (let i = 1; i <= rings; i++) headProfile.push([(R - 0.012) * (1 - i / rings), H / 2 + 0.004])
    kit.part(`${name}_Head`, M.mul(world, M.t(0, H / 2 + 0.004, 0)), node,
      [P(transform(lathe(headProfile, segs, { uv: 'planar', extent: R }), M.t(0, -H / 2 - 0.004, 0)), 'mesh', 'head', comp, 'surface')], { pivot: 'head centre' })
    const rim = lathe(Array.from({ length: (q === 2 ? 6 : 12) + 1 }, (_, i) => {
      const a = (i / (q === 2 ? 6 : 12)) * Math.PI * 2
      return [R - 0.002 + 0.011 * Math.cos(a), H / 2 + 0.002 + 0.013 * Math.sin(a)]
    }), segs, { tile: 4 })
    kit.part(`${name}_Rim`, world, node, [P(rim, 'rubber', 'rubber', comp, 'edge')])
    kit.collider(`COL_${name}`, M.mul(world, M.t(0, H / 2 + 0.006, 0)), node, { type: 'cylinder', axis: 'y', radius: R, height: 0.02 }, `${name}_Head`)
    if (armFrom) arm(`Rack_Arm_${name}`, armFrom, M.point(pivot, [0, 0, 0]))
    return node
  }

  pad('Snare', L.Snare, 'Snare', [lx + 0.06, L.Rack.bar, lz + 0.05])
  clamp('Rack_Clamp_Snare', [lx + 0.06, L.Rack.bar, lz])
  pad('TomHigh', L.TomHigh, 'TomHigh', [L.TomHigh.center[0], L.Rack.bar, lz])
  clamp('Rack_Clamp_TomHigh', [L.TomHigh.center[0], L.Rack.bar, lz])
  pad('TomMid', L.TomMid, 'TomMid', [L.TomMid.center[0], L.Rack.bar, lz])
  clamp('Rack_Clamp_TomMid', [L.TomMid.center[0], L.Rack.bar, lz])
  pad('FloorTom', L.FloorTom, 'FloorTom', [rx, 0.5, rz])
  clamp('Rack_Clamp_FloorTom', [rx, 0.5, rz])
  clamp('Rack_Clamp_LeftCorner', [lx, L.Rack.bar, lz])
  clamp('Rack_Clamp_RightCorner', [rx, L.Rack.bar, rz])

  // ---------- Cymbal pads on booms from the post tops ----------
  const cymbalPad = (name, c, comp, postTop, opts) => {
    const world = M.chain(M.t(...c.center), M.rx(c.tilt[0]), M.rz(c.tilt[1]))
    const node = kit.part(name, world, root, [], { pivot: 'centre mounting hole' })
    kit.part(`${name}_Cymbal`, world, node, [P(cymbal(c.R, { bellR: c.R * 0.2, bellH: 0.022, bow: 0.012, thick: 0.008, hole: 0.0045, rings: [20, 8, 4][q], segments: S(128, 16), ...opts }), 'rubber', 'cymbal', comp, 'surface')],
      { pivot: 'centre mounting hole', wobbleAxis: 'local X and Z' })
    const normal = M.dir(world, [0, 1, 0])
    const below = v.sub(c.center, v.scale(normal, 0.04))
    const mountWorld = M.t(...postTop)
    kit.part(`${name}_Mount`, mountWorld, node, localize(mountWorld, [
      P(merge(
        rod(postTop, below, 0.0095, S(16, 8)),
        rod(below, v.add(c.center, v.scale(normal, 0.03)), 0.0045, S(10, 5)),
        transform(lathe([[0, -0.008], [0.016, -0.008], [0.016, 0.006], [0, 0.012]], S(16, 8)), M.mul(world, M.t(0, 0.02, 0))),
      ), 'powder', 'hardware'),
      P(transform(roundedBox(0.05, 0.05, 0.05, 0.01, { steps: q ? 1 : 2 }), M.t(...postTop)), 'plastic', 'hardware'),
    ]), { pivot: 'clamp on the rack post' })
    kit.collider(`COL_${name}`, world, node, { type: 'cylinder', axis: 'y', radius: c.R, height: 0.03 }, `${name}_Cymbal`)
    return node
  }
  cymbalPad('Crash', L.Crash, 'Crash', [lx, L.Rack.height - 0.05, lz])
  cymbalPad('Ride', L.Ride, 'Ride', [rx, L.Rack.height - 0.05, rz], { bellH: 0.028 })

  // ---------- Hi-hat pad and controller pedal ----------
  {
    const h = L.HiHat
    const world = M.chain(M.t(...h.center), M.rx(h.tilt[0]), M.rz(h.tilt[1]))
    const node = kit.part('HiHat', world, root, [], { pivot: 'centre shaft' })
    kit.part('HiHat_Cymbal', world, node, [P(cymbal(h.R, { bellR: h.R * 0.22, bellH: 0.02, bow: 0.008, thick: 0.009, hole: 0.0045, rings: [20, 8, 4][q], segments: S(128, 16) }), 'rubber', 'cymbal', 'HiHat', 'surface')],
      { pivot: 'centre shaft', travelAxis: [0, 1, 0], states: { fullyOpen: 0.006, partiallyOpen: 0, closed: -0.004, pedalClosed: -0.005 } })
    const from = [lx, 0.82, lz]
    const mountWorld = M.t(...from)
    kit.part('HiHat_Mount', mountWorld, node, localize(mountWorld, [
      P(merge(sweep(roundPath([from, [from[0], from[1] + 0.02, from[2] + 0.06], [h.center[0], h.center[1] - 0.06, h.center[2]], [h.center[0], h.center[1] - 0.012, h.center[2]]], 0.025, q === 2 ? 2 : 5), 0.0095, S(16, 8)),
        rod([h.center[0], h.center[1] - 0.02, h.center[2]], [h.center[0], h.center[1] + 0.03, h.center[2]], 0.004, S(10, 5))), 'powder', 'hardware'),
      P(transform(roundedBox(0.05, 0.05, 0.05, 0.01, { steps: q ? 1 : 2 }), M.t(...from)), 'plastic', 'hardware'),
    ]), { pivot: 'clamp on the rack post' })
    const pedalWorld = M.t(...h.pedal)
    const pedal = kit.part('HiHat_Pedal', pedalWorld, node)
    const parts = pedalParts({ heelZ: 0.26, toeZ: 0.0, toeY: 0.06, width: 0.08, q })
    kit.part('HiHat_PedalBase', pedalWorld, pedal, [P(merge(parts.base, parts.hinge, transform(roundedBox(0.1, 0.05, 0.05, 0.01, { steps: q ? 1 : 2 }), M.t(0, 0.025, -0.01))), 'plastic', 'hardware')])
    kit.part('HiHat_PedalBoard', M.mul(pedalWorld, M.t(0, 0.022, 0.26)), pedal, [P(transform(parts.footboard, M.rx(parts.angle * 2)), 'steel', 'hardware', 'HiHat')], { pivot: 'heel hinge', rotationAxis: [1, 0, 0], pressAngle: 0.14 })
    kit.collider('COL_HiHat', world, node, { type: 'cylinder', axis: 'y', radius: h.R, height: 0.03 }, 'HiHat_Cymbal')
  }

  // ---------- Kick tower, pedal and beater ----------
  {
    const k = L.Kick
    const towerWorld = M.t(...k.tower)
    const tower = merge(
      transform(roundedBox(0.3, 0.02, 0.24, 0.006, { steps: q ? 1 : 2 }), M.t(0, 0.01, 0)),
      ...[-1, 1].map((s) => rod([s * 0.1, 0.01, -0.02], [s * 0.1, k.padY + 0.1, -0.02], 0.016, S(16, 8))),
      rod([-0.1, k.padY + 0.1, -0.02], [0.1, k.padY + 0.1, -0.02], 0.014, S(16, 8)),
      transform(roundedBox(0.26, 0.26, 0.05, 0.03, { steps: q ? 1 : 2 }), M.t(0, k.padY, -0.045)),
      ...[-1, 1].map((s) => transform(footMesh(), M.t(s * 0.13, 0, s * 0.1))),
    )
    const node = kit.part('Kick', towerWorld, root, [P(tower, 'powder', 'hardware')], { pivot: 'tower base' })
    const faceWorld = M.chain(M.t(k.tower[0], k.padY, k.tower[2] + 0.0), M.rx(Math.PI / 2))
    const facePrims = [
      P(lathe([[k.R + 0.012, -0.02], [k.R + 0.016, 0.0], [k.R + 0.012, 0.012], [k.R - 0.004, 0.014]], S(96, 12)), 'rubber', 'rubber', 'Kick', 'edge'),
      P(lathe([[k.R - 0.004, 0.012], ...Array.from({ length: rings }, (_, i) => [(k.R - 0.004) * (1 - (i + 1) / rings), 0.013])], S(96, 12), { uv: 'planar', extent: k.R }), 'mesh', 'head', 'Kick', 'surface'),
    ]
    kit.part('Kick_Pad', faceWorld, node, facePrims, { pivot: 'pad centre' })
    kit.collider('COL_Kick', M.mul(faceWorld, M.t(0, 0.016, 0)), node, { type: 'cylinder', axis: 'y', radius: k.R, height: 0.02 }, 'Kick_Pad')
    const pedalWorld = M.t(k.tower[0], 0, k.tower[2] + 0.07)
    const pedal = kit.part('Kick_Pedal', pedalWorld, node)
    const parts = pedalParts({ heelZ: 0.3, toeZ: 0.02, toeY: 0.075, q })
    kit.part('Kick_PedalBase', pedalWorld, pedal, [P(merge(parts.base, parts.hinge,
      ...[-1, 1].map((s) => transform(roundedBox(0.016, 0.14, 0.026, 0.004, { steps: q ? 1 : 2 }), M.t(s * 0.06, 0.07, 0.04)))), 'steel', 'hardware')])
    kit.part('Kick_PedalBoard', M.mul(pedalWorld, M.t(0, 0.022, 0.3)), pedal, [P(transform(parts.footboard, M.rx(parts.angle * 2)), 'steel', 'hardware', 'Kick')], { pivot: 'heel hinge', rotationAxis: [1, 0, 0], pressAngle: 0.18 })
    const axle = M.point(pedalWorld, [0, 0.13, 0.04])
    const tip = [0, k.padY, k.tower[2] + 0.04]
    const beaterWorld = M.aim(axle, tip)
    const len = v.len(v.sub(tip, axle))
    kit.part('Kick_Beater', beaterWorld, node, [P(merge(
      rod([0, 0, 0], [0, len, 0], 0.0035, S(12, 6)),
      transform(lathe([[0, -0.02], [0.018, -0.019], [0.024, -0.012], [0.024, 0.012], [0.018, 0.019], [0, 0.02]], S(24, 8)), M.chain(M.t(0, len, 0), M.rz(Math.PI / 2))),
    ), 'steel', 'hardware', 'Kick')], { pivot: 'beater shaft rotation axis', rotationAxis: [1, 0, 0], strikeAngle: -0.45 })
  }

  // ---------- Drum module ----------
  {
    const m = L.Module
    const bracket = [lx, m.center[1] - 0.06, lz]
    const world = M.chain(M.t(...m.center), M.ry(0.55), M.rx(-0.55))
    const node = kit.part('DrumModule', M.t(...bracket), root, [P(transform(sweep(roundPath([bracket, [bracket[0] - 0.02, bracket[1] + 0.02, bracket[2] + 0.04], v.sub(m.center, [0, 0.03, -0.0])], 0.012, q === 2 ? 2 : 4), 0.01, S(12, 6)), M.inverseRigid(M.t(...bracket))), 'powder', 'hardware')],
      { pivot: 'mounting bracket' })
    kit.part('DrumModule_Body', world, node, [P(roundedBox(0.22, 0.15, 0.05, 0.012, { steps: q ? 1 : 3 }), 'plastic', 'hardware')])
    kit.part('DrumModule_Display', M.mul(world, M.t(-0.035, 0.03, 0.026)), node, [
      P(roundedBox(0.105, 0.055, 0.003, 0.0012, { steps: 1 }), 'emission', 'screen'),
      P(transform(roundedBox(0.112, 0.062, 0.002, 0.001, { steps: 1 }), M.t(0, 0, 0.002)), 'glass', 'screen'),
    ])
    const buttons = []
    for (let row = 0; row < 2; row++) for (let i = 0; i < 5; i++)
      buttons.push(transform(roundedBox(0.012, 0.009, 0.005, 0.002, { steps: 1 }), M.t(-0.085 + i * 0.024, -0.035 - row * 0.018, 0.026)))
    kit.part('DrumModule_Buttons', world, node, [P(merge(...buttons), 'plastic', 'hardware')])
    const knob = lathe([[0, 0], [0.011, 0], [0.011, 0.012], [0.009, 0.016], [0, 0.016]], S(20, 8))
    kit.part('DrumModule_Knobs', world, node, [P(merge(
      transform(knob, M.chain(M.t(0.06, 0.035, 0.025), M.rx(Math.PI / 2))),
      transform(knob, M.chain(M.t(0.085, 0.035, 0.025), M.rx(Math.PI / 2))),
      transform(lathe([[0, 0], [0.016, 0], [0.016, 0.014], [0.013, 0.02], [0, 0.02]], S(24, 8)), M.chain(M.t(0.072, -0.02, 0.025), M.rx(Math.PI / 2))),
    ), 'steel', 'hardware')])
  }

  // ---------- Throne ----------
  {
    const th = L.Throne
    const world = M.t(...th.center)
    const node = kit.part('Throne', world, root)
    const spread = 0.22, collar = 0.18, brace = 0.09
    const t = tripod(th.seat - 0.06, { spread, collar, brace, q, tube: 0.015 })
    const legMesh = merge(
      rod([0, collar, 0], [spread, 0.02, 0], 0.0075, S(14, 6)),
      transform(rod([0, collar, 0], [spread * 0.98, 0.026, 0], 0.006, S(10, 5)), M.t(0, 0, 0.012)),
      rod([0.012, brace, 0], [spread * 0.55, collar - (collar - 0.02) * 0.55, 0], 0.005, S(10, 5)),
      transform(footMesh(), M.t(spread, 0, 0)),
    )
    const seatProfile = [[0, -0.035], [0.14, -0.035], [0.158, -0.028], [0.168, -0.012], [0.17, 0.01], [0.166, 0.028], [0.155, 0.042], [0.13, 0.05], [0.07, 0.054], [0, 0.055]]
    kit.part('Throne_Seat', M.mul(world, M.t(0, th.seat, 0)), node, [P(lathe(seatProfile, S(96, 12), { tile: 3 }), 'vinyl', 'rubber')], { pivot: 'centre of the vertical post' })
    kit.part('Throne_Post', world, node, [P(t.base, 'steel', 'hardware')])
    kit.part('Throne_Legs', world, node, [P(merge(...t.angles.map((a) => transform(legMesh, M.ry(a + Math.PI / 2)))), 'steel', 'hardware')])
  }
  return root
}

export const ELECTRONIC_PLAYABLE = ['Snare_Head', 'Snare_Rim', 'TomHigh_Head', 'TomMid_Head', 'FloorTom_Head', 'HiHat_Cymbal', 'Crash_Cymbal', 'Ride_Cymbal', 'Kick_Pad']
export const ELECTRONIC_COLLIDERS = ['COL_Snare', 'COL_TomHigh', 'COL_TomMid', 'COL_FloorTom', 'COL_HiHat', 'COL_Crash', 'COL_Ride', 'COL_Kick']
