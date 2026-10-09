// The acoustic five-piece kit: kick, snare, two rack toms, floor tom, hi-hat, crash and ride on stands, and a throne.
// Metres, +Y up, the audience toward -Z, the player at +Z, the player's left toward -X. Root on the player centreline.
import { cymbal, cymbalZone, DETAIL, foot, head, hoop, lathe, lug, M, merge, pedalParts, rod, roundedBox, seg, shell, spring, chain, sweep, tensionRod, transform, tripod, v } from './parts.mjs'

const P = (mesh, key, cat, comp, role) => ({ mesh, key, cat, comp, role })
const localize = (world, prims) => prims.map((p) => ({ ...p, mesh: transform(p.mesh, M.inverseRigid(world)) }))

export const ACOUSTIC_MATERIALS = (t) => ({
  shell: { name: 'MAT_Shell_BurgundyWood', set: t.shellWood, size: 2048 },
  headCoated: { name: 'MAT_DrumHead_CoatedWhite', set: t.headCoated, size: 2048 },
  headClear: { name: 'MAT_DrumHead_Clear', set: t.headClear, size: 2048 },
  cymbal: { name: 'MAT_Cymbal_Bronze', set: t.cymbalBronze, size: 2048 },
  chrome: { name: 'MAT_Chrome', set: t.chrome, size: 1024 },
  steel: { name: 'MAT_Steel_Brushed', set: t.steelBrushed, size: 1024 },
  metalBlack: { name: 'MAT_Metal_Black', set: t.metalBlack, size: 1024 },
  rubber: { name: 'MAT_Rubber_Black', set: t.rubberBlack, size: 1024 },
  plastic: { name: 'MAT_Plastic_Black', set: t.plasticBlack, size: 1024 },
  felt: { name: 'MAT_Felt_Dark', set: t.feltDark, size: 1024 },
  vinyl: { name: 'MAT_SeatVinyl_Black', set: t.seatVinyl, size: 1024 },
  wire: { name: 'MAT_SnareWire_Steel', set: t.snareWire, size: 1024 },
})

/** Layout of the playable pieces, shared with the collision objects and the manifest. */
export const ACOUSTIC_LAYOUT = {
  Kick: { center: [0, 0.296, -0.24], R: 0.279, H: 0.43 },
  Snare: { center: [-0.3, 0.64, 0.17], R: 0.178, H: 0.15, tilt: [0.12, 0.05] },
  TomHigh: { center: [-0.17, 0.8, -0.24], R: 0.127, H: 0.2, tilt: [0.35, -0.12] },
  TomMid: { center: [0.17, 0.83, -0.27], R: 0.152, H: 0.23, tilt: [0.35, 0.12] },
  FloorTom: { center: [0.55, 0.53, 0.12], R: 0.203, H: 0.4, tilt: [0.05, 0.04] },
  HiHat: { stand: [-0.64, 0, 0.18], height: 0.86, R: 0.178 },
  Crash: { stand: [-0.74, 0, -0.2], center: [-0.58, 1.28, -0.2], R: 0.229, tilt: [0.3, -0.15] },
  Ride: { stand: [0.86, 0, -0.16], center: [0.72, 1.12, -0.16], R: 0.254, tilt: [0.25, 0.18] },
  Throne: { center: [0, 0, 0.68], seat: 0.55 },
  KickPedal: { front: -0.005 },
}

/** Hi-hat top-cymbal travel along the pull rod from its exported rest height (metres). */
export const HAT_STATES = { fullyOpen: 0.02, partiallyOpen: 0, closed: -0.013, pedalClosed: -0.0152 }

/** Builds one level of detail of the acoustic kit under a new root; returns the root node index. */
export function buildAcoustic(kit, q, rootExtras) {
  const S = (n, min = 6) => seg(n, q, min)
  const chainBetween = (a, b) => q === 2 ? rod(a, b, 0.003, S(6, 4)) : chain(a, b, q)
  const cymbalSegments = (n) => q === 2 ? S(112, 12) : S(n, 16)
  const L = ACOUSTIC_LAYOUT
  const root = kit.part('AcousticDrumKit', M.identity(), null, [], rootExtras)
  const segs = S(128, 16)
  const rings = [20, 8, 3][q]

  /** A complete drum: shell, two heads, two hoops, a rim zone, lugs and tension rods. Pivot at the shell centre. */
  const drum = (name, parent, world, { R, H, comp, front = false, lugCount, lugLength, kickHoops = false, snare = false }) => {
    const node = kit.part(name, world, parent)
    const at = (local) => M.mul(world, local)
    kit.part(`${name}_Shell`, world, node, [P(shell(R, H, { segments: segs, t: front ? 0.008 : 0.006 }), 'shell', 'drum')])
    const batterName = name === 'Kick' ? 'Kick_BatterHead' : `${name}_BatterHead`
    kit.part(batterName, at(M.t(0, H / 2, 0)), node, [P(head(R, { rings, segments: segs }), 'headCoated', 'head', comp, 'surface')])
    const resoName = name === 'Kick' ? 'Kick_FrontHead' : `${name}_ResonantHead`
    const reso = front ? portedHead(R, 0.062, segs, q) : head(R, { rings: Math.max(2, Math.round(rings / 3)), segments: segs, bottom: true })
    kit.part(resoName, at(M.t(0, -H / 2, 0)), node, [P(reso, front ? 'headCoated' : 'headClear', 'head')])
    const hoopKey = kickHoops ? 'shell' : 'chrome'
    const hoopCat = kickHoops ? 'drum' : 'hardware'
    const hoopSize = kickHoops ? { h: 0.032, w: 0.018 } : {}
    kit.part(name === 'Kick' ? 'Kick_BatterHoop' : `${name}_TopHoop`, at(M.t(0, H / 2, 0)), node,
      [P(hoop(R, { segments: segs, ...hoopSize, sides: q === 2 ? 1 : 3 }), hoopKey, hoopCat, comp, 'edge')])
    kit.part(name === 'Kick' ? 'Kick_FrontHoop' : `${name}_BottomHoop`, at(M.t(0, -H / 2, 0)), node,
      [P(hoop(R, { segments: segs, bottom: true, ...hoopSize, sides: q === 2 ? 1 : 3 }), hoopKey, hoopCat)])
    if (name !== 'Kick') {
      // The playable rim: the rounded top edge of the hoop, separate from the head.
      kit.part(`${name}_Rim`, at(M.t(0, H / 2, 0)), node,
        [P(lathe(circleTube(R + 0.0075, 0.0164, 0.0034, q === 2 ? 4 : 8), segs, { tile: 3 }), 'chrome', 'hardware', comp, 'edge')])
    }
    // Lugs and tension rods, instanced around the shell.
    const lugsNode = kit.part(`${name}_Lugs`, world, node)
    const rodsNode = kit.part(`${name}_TensionRods`, world, node)
    const lugDetail = q === 0 ? 1 : q
    const lugMesh = name === 'Kick'
      ? merge(transform(lug(0.05, lugDetail), M.t(0, H / 2 - 0.05, 0)), transform(lug(0.05, lugDetail), M.t(0, -H / 2 + 0.05, 0)))
      : lug(lugLength, lugDetail)
    const lugTop = name === 'Kick' ? H / 2 - 0.025 : lugLength / 2
    const rodLen = H / 2 + 0.012 - lugTop
    const rodForLod = (length) => q === 2 ? rod([0, 0, 0], [0, length, 0], 0.0024, S(6, 4)) : tensionRod(length, q)
    const rodMesh = merge(transform(rodForLod(rodLen), M.t(0, lugTop, 0.013)), transform(rodForLod(rodLen), M.chain(M.rx(Math.PI), M.t(0, lugTop, -0.013))))
    let firstLug = null, firstRod = null
    for (let i = 0; i < (q === 2 ? Math.min(lugCount, 4) : lugCount); i++) {
      const a = ((i + 0.5) / lugCount) * Math.PI * 2
      const frame = M.chain(world, M.ry(Math.PI / 2 - a), M.t(0, 0, R))
      const id = String(i + 1).padStart(2, '0')
      if (firstLug === null) firstLug = kit.part(`${name}_Lug_${id}`, frame, lugsNode, [P(lugMesh, 'chrome', 'hardware')])
      else kit.instance(`${name}_Lug_${id}`, frame, lugsNode, firstLug)
      if (firstRod === null) firstRod = kit.part(`${name}_TensionRod_${id}`, frame, rodsNode, [P(rodMesh, 'chrome', 'hardware')])
      else kit.instance(`${name}_TensionRod_${id}`, frame, rodsNode, firstRod)
    }
    if (snare) {
      // Strainer and butt plate on opposite sides, wires under the resonant head.
      const strainer = merge(roundedBox(0.03, 0.05, 0.022, 0.005, { steps: q ? 1 : 2 }), transform(roundedBox(0.008, 0.04, 0.014, 0.003, { steps: 1 }), M.t(0, 0.01, 0.014)),
        rod([0, -0.025, 0.004], [0, -H / 2 - 0.02 + H / 2 - 0.004, 0.004], 0.0025, S(8, 5)))
      kit.part('Snare_Strainer', M.chain(world, M.ry(Math.PI / 2), M.t(0, 0, R + 0.014)), node, [P(strainer, 'chrome', 'hardware')])
      kit.part('Snare_ButtPlate', M.chain(world, M.ry(-Math.PI / 2), M.t(0, -H / 4, R + 0.012)), node, [P(roundedBox(0.03, 0.028, 0.016, 0.004, { steps: q ? 1 : 2 }), 'chrome', 'hardware')])
      const wires = []
      const count = [20, 10, 4][q]
      for (let i = 0; i < count; i++) {
        const x = -R * 0.55 + (R * 1.1) * i / (count - 1)
        wires.push(rod([x, -0.0055, -R * 0.78], [x, -0.0055, R * 0.78], 0.0011, S(6, 3), { caps: false }))
      }
      wires.push(transform(roundedBox(R * 1.2, 0.002, 0.02, 0.001, { steps: 1 }), M.t(0, -0.0055, -R * 0.8)), transform(roundedBox(R * 1.2, 0.002, 0.02, 0.001, { steps: 1 }), M.t(0, -0.0055, R * 0.8)))
      kit.part('Snare_Wires', at(M.t(0, -H / 2, 0)), node, [P(merge(...wires), 'wire', 'hardware')])
    }
    return node
  }

  // ---------- Kick and pedal ----------
  const kick = L.Kick
  const kickWorld = M.chain(M.t(...kick.center), M.rx(Math.PI / 2))
  const kickNode = drum('Kick', root, kickWorld, { R: kick.R, H: kick.H, comp: 'Kick', front: true, lugCount: [8, 8, 4][q], kickHoops: true })
  kit.part('Kick_Vent', M.mul(kickWorld, M.t(0, -kick.H / 2 - 0.004, 0)), kickNode, [P(lathe(circleTube(0.062, 0, 0.004, q === 2 ? 4 : 8), S(64, 12), { tile: 3 }), 'plastic', 'rubber')])
  {
    // Spurs fold out of brackets on the lower sides and reach forward to the floor.
    const spurs = []
    for (const side of [-1, 1]) {
      const bracket = [side * (kick.R + 0.012) * 0.9, kick.center[1] - kick.R * 0.42, kick.center[2] - kick.H * 0.25]
      spurs.push(transform(roundedBox(0.03, 0.05, 0.06, 0.006, { steps: q ? 1 : 2 }), M.t(...bracket)))
      const toe = [side * (kick.R + 0.13), 0.012, kick.center[2] - kick.H * 0.1]
      spurs.push(rod(bracket, toe, 0.0075, S(12, 6)), transform(foot(q), M.t(toe[0], 0, toe[2])))
    }
    kit.part('Kick_Spurs', kickWorld, kickNode, localize(kickWorld, [P(merge(...spurs), 'chrome', 'hardware')]))
    const hardware = merge(
      // Hoop clamp tab where the pedal grips the batter hoop, and the tom-mount plate on top of the shell.
      transform(roundedBox(0.07, 0.02, 0.02, 0.004, { steps: q ? 1 : 2 }), M.t(0, 0.035, kick.center[2] + kick.H / 2 + 0.006)),
      transform(roundedBox(0.09, 0.012, 0.12, 0.004, { steps: q ? 1 : 2 }), M.t(0, kick.center[1] + kick.R + 0.004, kick.center[2])),
    )
    kit.part('Kick_MountingHardware', kickWorld, kickNode, localize(kickWorld, [P(hardware, 'chrome', 'hardware')]))
    kit.collider('COL_Kick', M.mul(kickWorld, M.t(0, kick.H / 2 + 0.004, 0)), kickNode, { type: 'cylinder', axis: 'y', radius: kick.R, height: 0.02 }, 'Kick_BatterHead')
  }
  {
    const frontZ = L.KickPedal.front
    const pedalWorld = M.t(0, 0, frontZ)
    const pedal = kit.part('KickPedal', pedalWorld, root)
    const parts = pedalParts({ heelZ: 0.36, toeZ: 0.05, toeY: 0.078, q })
    const axle = [0, 0.13, 0.06]
    const posts = merge(...[-1, 1].map((s) => merge(
      transform(roundedBox(0.016, 0.14, 0.026, 0.004, { steps: q ? 1 : 2 }), M.t(s * 0.06, 0.07, 0.06)),
      transform(lathe([[0.0001, -0.008], [0.011, -0.008], [0.011, 0.008], [0.0001, 0.008]], S(16, 8)), M.chain(M.t(s * 0.071, 0.13, 0.06), M.rz(Math.PI / 2))),
    )))
    kit.part('KickPedal_Base', pedalWorld, pedal, [P(merge(parts.base, posts), 'steel', 'hardware')])
    kit.part('KickPedal_Hinge', M.mul(pedalWorld, M.t(0, 0.02, 0.36)), pedal, [P(transform(parts.hinge, M.t(0, -0.02, -0.36)), 'steel', 'hardware')])
    const heel = M.mul(pedalWorld, M.t(0, 0.022, 0.36))
    kit.part('KickPedal_Footboard', heel, pedal, [P(transform(parts.footboard, M.rx(2 * parts.angle)), 'steel', 'hardware', 'Kick')],
      { pivot: 'heel hinge', rotationAxis: [-1, 0, 0], pressAngle: 0.18 })
    // Chain from the footboard toe up over the cam on the axle.
    const toe = [0, 0.022 + Math.sin(parts.angle) * parts.length, 0.36 - Math.cos(parts.angle) * parts.length]
    kit.part('KickPedal_Chain', M.mul(pedalWorld, M.t(0.03, toe[1], toe[2])), pedal,
      [P(transform(chainBetween([0.03, toe[1], toe[2]], [0.03, axle[1] - 0.012, axle[2] + 0.02]), M.t(-0.03, -toe[1], -toe[2])), 'metalBlack', 'hardware')])
    kit.part('KickPedal_Cam', M.mul(pedalWorld, M.t(...axle)), pedal,
      [P(transform(lathe([[0.0001, -0.007], [0.022, -0.007], [0.024, -0.005], [0.024, 0.005], [0.022, 0.007], [0.0001, 0.007]], S(24, 8)), M.chain(M.t(0.03, 0, 0), M.rz(Math.PI / 2))), 'metalBlack', 'hardware')])
    kit.part('KickPedal_Spring', M.mul(pedalWorld, M.t(0.075, 0.04, 0.06)), pedal, [P(spring(0.007, 0.075, 9, 0.0012, q), 'steel', 'hardware')])
    const beaterTip = [0, 0.27, kick.center[2] + kick.H / 2 + 0.032 - frontZ]
    const shaftLen = v.len(v.sub(beaterTip, axle))
    const shaftWorld = M.mul(pedalWorld, M.aim(axle, beaterTip))
    kit.part('KickPedal_Shaft', shaftWorld, pedal, [P(merge(
      rod([0, 0, 0], [0, shaftLen, 0], 0.0035, S(12, 6)),
      transform(roundedBox(0.03, 0.012, 0.012, 0.003, { steps: 1 }), M.t(0, 0.0, 0)),
    ), 'steel', 'hardware')], { pivot: 'beater shaft rotation axis', rotationAxis: [1, 0, 0] })
    kit.part('KickPedal_Beater', shaftWorld, pedal, [P(transform(lathe([[0.0001, -0.022], [0.02, -0.021], [0.026, -0.014], [0.026, 0.014], [0.02, 0.021], [0.0001, 0.022]], S(24, 8)), M.chain(M.t(0, shaftLen, 0), M.rz(Math.PI / 2))), 'felt', 'rubber', 'Kick')],
      { pivot: 'beater shaft rotation axis', strikeAngle: -0.45 })
  }

  // ---------- Snare and its stand ----------
  {
    const s = L.Snare
    const world = M.chain(M.t(...s.center), M.rx(s.tilt[0]), M.rz(s.tilt[1]))
    const node = drum('Snare', root, world, { R: s.R, H: s.H, comp: 'Snare', lugCount: [8, 8, 4][q], lugLength: 0.05, snare: true })
    kit.collider('COL_SnareHead', M.mul(world, M.t(0, s.H / 2 + 0.004, 0)), node, { type: 'cylinder', axis: 'y', radius: s.R * 0.98, height: 0.015 }, 'Snare_BatterHead')
    kit.collider('COL_SnareRim', M.mul(world, M.t(0, s.H / 2 + 0.016, 0)), node, { type: 'ring', axis: 'y', innerRadius: s.R * 0.98, outerRadius: s.R + 0.012, height: 0.014 }, 'Snare_Rim')
    const base = [s.center[0], 0, s.center[2]]
    const standWorld = M.t(...base)
    const stand = kit.part('SnareStand', standWorld, root)
    const basketY = s.center[1] - s.H / 2 - 0.05
    const t = tripod(basketY - 0.06, { spread: 0.24, collar: 0.26, q, tube: 0.011 })
    kit.part('SnareStand_Base', standWorld, stand, [P(merge(...t.angles.map((a) => transform(t.legMesh, M.ry(a)))), 'chrome', 'hardware')])
    kit.part('SnareStand_Post', standWorld, stand, [P(t.base, 'chrome', 'hardware')])
    const basket = []
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.3
      const tip = [Math.cos(a) * s.R * 0.82, basketY - 0.012 + 0.02, Math.sin(a) * s.R * 0.82]
      basket.push(sweep([[0, basketY - 0.03, 0], [Math.cos(a) * 0.05, basketY - 0.03, Math.sin(a) * 0.05], tip, [tip[0] * 1.06, tip[1] + 0.03, tip[2] * 1.06]], 0.0045, S(10, 5)))
      basket.push(transform(roundedBox(0.014, 0.02, 0.014, 0.004, { steps: 1 }), M.t(tip[0] * 1.06, tip[1] + 0.035, tip[2] * 1.06)))
    }
    basket.push(transform(lathe([[0.0001, -0.02], [0.025, -0.02], [0.028, -0.016], [0.028, 0.0], [0.0001, 0.0]], S(20, 8)), M.t(0, basketY - 0.02, 0)))
    kit.part('SnareStand_Basket', M.mul(standWorld, M.t(0, basketY, 0)), stand, [P(transform(merge(...basket), M.t(0, -basketY, 0)), 'chrome', 'hardware')])
    kit.part('SnareStand_Adjusters', M.mul(standWorld, M.t(0, basketY - 0.07, 0)), stand, [P(merge(
      transform(lathe([[0.0001, -0.012], [0.02, -0.012], [0.022, 0], [0.02, 0.012], [0.0001, 0.012]], S(16, 8)), M.chain(M.t(0.03, 0, 0), M.rz(Math.PI / 2))),
      rod([0, 0, 0], [0.03, 0, 0], 0.004, S(8, 5)),
    ), 'steel', 'hardware')])
  }

  // ---------- Rack toms on their mount ----------
  const toms = {}
  for (const name of ['TomHigh', 'TomMid']) {
    const t = L[name]
    const world = M.chain(M.t(...t.center), M.rx(t.tilt[0]), M.rz(t.tilt[1]))
    const node = drum(name, root, world, { R: t.R, H: t.H, comp: name, lugCount: [8, 6, 4][q], lugLength: 0.05 })
    // The bracket on the shell side facing the kit centre; the drum's mounting pivot.
    const inward = name === 'TomHigh' ? 1 : -1
    const bracketLocal = [inward * (t.R + 0.016), -t.H * 0.05, -t.R * 0.15]
    const bracketWorld = M.point(world, bracketLocal)
    kit.part(`${name}_Mount`, M.mul(world, M.t(...bracketLocal)), node, [P(merge(
      roundedBox(0.03, 0.06, 0.04, 0.006, { steps: q ? 1 : 2 }),
      transform(lathe([[0.0001, -0.012], [0.013, -0.012], [0.013, 0.012], [0.0001, 0.012]], S(16, 8)), M.chain(M.t(inward * 0.02, 0, 0), M.rz(Math.PI / 2))),
    ), 'chrome', 'hardware')], { pivot: 'mounting bracket' })
    kit.collider(`COL_${name}`, M.mul(world, M.t(0, t.H / 2 + 0.004, 0)), node, { type: 'cylinder', axis: 'y', radius: t.R * 0.98, height: 0.015 }, `${name}_BatterHead`)
    toms[name] = bracketWorld
  }
  {
    const baseY = kick.center[1] + kick.R + 0.01
    const baseWorld = M.t(0, baseY, kick.center[2])
    const mount = kit.part('TomMountingSystem', baseWorld, root)
    kit.part('TomMount_Base', baseWorld, mount, [P(merge(
      roundedBox(0.07, 0.05, 0.08, 0.008, { steps: q ? 1 : 2 }),
      ...[-1, 1].map((s) => rod([s * 0.022, 0.02, 0], [s * 0.022, 0.09, 0], 0.012, S(16, 8))),
    ), 'chrome', 'hardware')])
    const clampMesh = lathe([[0.0001, -0.014], [0.016, -0.014], [0.018, -0.011], [0.018, 0.011], [0.016, 0.014], [0.0001, 0.014]], S(16, 8))
    const clamps = kit.part('TomMount_Clamps', baseWorld, mount)
    let firstClamp = null
    for (const [name, side] of [['TomHigh', -1], ['TomMid', 1]]) {
      const start = [side * 0.022, baseY + 0.09, kick.center[2]]
      const bracket = toms[name]
      const elbow = [start[0] + (bracket[0] - start[0]) * 0.35, bracket[1] - 0.02, start[2] + (bracket[2] - start[2]) * 0.35]
      const armWorld = M.aim(start, elbow)
      kit.part(name === 'TomHigh' ? 'TomMount_HighArm' : 'TomMount_MidArm', armWorld, mount,
        localize(armWorld, [P(sweep([start, [start[0], start[1] + 0.06, start[2]], elbow, bracket], 0.0095, S(16, 8)), 'chrome', 'hardware')]),
        { pivot: 'adjustment joint at the mount base' })
      const clampWorld = M.t(start[0], start[1] + 0.02, start[2])
      if (firstClamp === null) firstClamp = kit.part(`TomMount_Clamp_${name}`, clampWorld, clamps, [P(clampMesh, 'chrome', 'hardware')])
      else kit.instance(`TomMount_Clamp_${name}`, clampWorld, clamps, firstClamp)
    }
  }

  // ---------- Floor tom on three legs ----------
  {
    const f = L.FloorTom
    const world = M.chain(M.t(...f.center), M.rx(f.tilt[0]), M.rz(f.tilt[1]))
    const node = drum('FloorTom', root, world, { R: f.R, H: f.H, comp: 'FloorTom', lugCount: [8, 8, 4][q], lugLength: 0.06 })
    for (const [name, a] of [['FloorTom_Leg_Left', Math.PI * 0.85], ['FloorTom_Leg_Right', Math.PI * 0.15], ['FloorTom_Leg_Rear', -Math.PI * 0.5]]) {
      const bracketLocal = [Math.cos(a) * (f.R + 0.014), f.H * 0.18, Math.sin(a) * (f.R + 0.014)]
      const bracket = M.point(world, bracketLocal)
      const out = v.norm([Math.cos(a), 0, Math.sin(a)].map((x, i) => i === 1 ? 0 : x))
      const dir = M.dir(world, out)
      const toe = [bracket[0] + dir[0] * 0.09, 0.012, bracket[2] + dir[2] * 0.09]
      const legWorld = M.t(...bracket)
      kit.part(name, legWorld, node, localize(legWorld, [
        P(merge(transform(roundedBox(0.03, 0.05, 0.03, 0.006, { steps: q ? 1 : 2 }), M.t(...bracket)), rod([bracket[0], bracket[1] + 0.06, bracket[2]], toe, 0.0072, S(14, 6))), 'chrome', 'hardware'),
        P(transform(foot(q), M.t(toe[0], 0, toe[2])), 'rubber', 'rubber'),
      ]), { pivot: 'leg bracket' })
    }
    kit.collider('COL_FloorTom', M.mul(world, M.t(0, f.H / 2 + 0.004, 0)), node, { type: 'cylinder', axis: 'y', radius: f.R * 0.98, height: 0.015 }, 'FloorTom_BatterHead')
  }

  // ---------- Hi-hat ----------
  {
    const h = L.HiHat
    const standWorld = M.t(...h.stand)
    const node = kit.part('HiHat', standWorld, root)
    const t = tripod(h.height - 0.03, { spread: 0.25, collar: 0.3, q, tube: 0.0125 })
    kit.part('HiHat_Stand', standWorld, node, [P(merge(t.base, transform(roundedBox(0.09, 0.008, 0.32, 0.003, { steps: q ? 1 : 2 }), M.t(0, 0.004, 0.17))), 'chrome', 'hardware')])
    const legs = kit.part('HiHat_Legs', standWorld, node)
    let firstLeg = null
    t.angles.forEach((a, i) => {
      const w = M.mul(standWorld, M.ry(a + Math.PI / 3))
      if (firstLeg === null) firstLeg = kit.part(`HiHat_Leg_0${i + 1}`, w, legs, [P(t.legMesh, 'chrome', 'hardware')])
      else kit.instance(`HiHat_Leg_0${i + 1}`, w, legs, firstLeg)
    })
    const opts = { bellR: h.R * 0.24, bellH: 0.03, bow: 0.012, thick: 0.0018, rings: [26, 12, 5][q], segments: cymbalSegments(128) }
    kit.part('HiHat_BottomCymbal', M.chain(standWorld, M.t(0, h.height, 0), M.rx(Math.PI)), node, [P(cymbal(h.R, opts), 'cymbal', 'cymbal', 'HiHat')], { pivot: 'centre shaft' })
    const restY = h.height + 0.015
    kit.part('HiHat_TopCymbal', M.mul(standWorld, M.t(0, restY, 0)), node, [P(cymbal(h.R, opts), 'cymbal', 'cymbal', 'HiHat', 'surface')],
      { pivot: 'centre shaft', travelAxis: [0, 1, 0], states: HAT_STATES })
    kit.part('HiHat_Clutch', M.mul(standWorld, M.t(0, restY + 0.03, 0)), node, [P(merge(
      lathe([[0.0001, -0.024], [0.014, -0.024], [0.014, -0.004], [0.022, -0.004], [0.022, 0.004], [0.0001, 0.004]], S(20, 8)),
      transform(roundedBox(0.03, 0.012, 0.012, 0.003, { steps: 1 }), M.t(0.016, -0.015, 0)),
    ), 'steel', 'hardware')], { followsTopCymbal: true })
    kit.part('HiHat_PullRod', standWorld, node, [P(rod([0, 0.03, 0], [0, restY + 0.06, 0], 0.0035, S(10, 5)), 'steel', 'hardware')])
    const heel = M.mul(standWorld, M.t(0, 0.022, 0.42))
    const parts = pedalParts({ heelZ: 0.42, toeZ: 0.12, toeY: 0.07, width: 0.075, q })
    kit.part('HiHat_Pedal', heel, node, [P(transform(parts.footboard, M.rx(2 * parts.angle)), 'steel', 'hardware', 'HiHat')], { pivot: 'heel hinge', rotationAxis: [-1, 0, 0], pressAngle: 0.15 })
    kit.part('HiHat_Chain', standWorld, node, [P(chainBetween([0, 0.065, 0.12], [0, 0.11, 0.02]), 'metalBlack', 'hardware')])
    kit.part('HiHat_SpringAssembly', M.mul(standWorld, M.t(0, 0.12, 0)), node, [P(merge(
      transform(spring(0.011, 0.11, 10, 0.0014, q), M.t(0, 0, 0)),
      lathe([[0.0001, -0.012], [0.026, -0.012], [0.028, -0.008], [0.028, 0.008], [0.026, 0.012], [0.0001, 0.012]], S(20, 8)),
    ), 'steel', 'hardware')])
    kit.collider('COL_HiHat', M.mul(standWorld, M.t(0, restY + 0.005, 0)), node, { type: 'cylinder', axis: 'y', radius: h.R, height: 0.03 }, 'HiHat_TopCymbal')
  }

  // ---------- Crash and ride on boom stands ----------
  for (const name of ['Crash', 'Ride']) {
    const c = L[name]
    const standWorld = M.t(...c.stand)
    const node = kit.part(name, standWorld, root)
    const cymWorld = M.chain(M.t(...c.center), M.rx(c.tilt[0]), M.rz(c.tilt[1]))
    const normal = M.dir(cymWorld, [0, 1, 0])
    const tilterPoint = v.sub(c.center, v.scale(normal, 0.05))
    const top = c.center[1] - 0.25
    const t = tripod(top, { spread: 0.24, collar: 0.32, q, tube: 0.0135 })
    kit.part(`${name}_Stand`, standWorld, node, [P(merge(t.base, ...t.angles.map((a) => transform(t.legMesh, M.ry(a)))), 'chrome', 'hardware')])
    const joint = [c.stand[0], top + 0.03, c.stand[2]]
    const armWorld = M.aim(joint, tilterPoint)
    const armLen = v.len(v.sub(tilterPoint, joint))
    kit.part(`${name}_BoomArm`, armWorld, node, [P(merge(
      transform(lathe([[0.0001, -0.022], [0.02, -0.022], [0.022, -0.018], [0.022, 0.018], [0.02, 0.022], [0.0001, 0.022]], S(20, 8)), M.rz(Math.PI / 2)),
      rod([0, 0, 0], [0, armLen, 0], 0.0095, S(16, 8)),
    ), 'chrome', 'hardware')], { pivot: 'adjustment joint' })
    const tilterWorld = M.aim(tilterPoint, c.center)
    kit.part(`${name}_Tilter`, tilterWorld, node, [P(merge(
      roundedBox(0.026, 0.03, 0.026, 0.006, { steps: q ? 1 : 2 }),
      rod([0, 0, 0], [0, 0.085, 0], 0.0042, S(10, 5)),
    ), 'chrome', 'hardware')])
    const felt = lathe([[0.003, -0.006], [0.017, -0.006], [0.019, -0.004], [0.019, 0.004], [0.017, 0.006], [0.003, 0.006]], S(20, 8))
    const felts = kit.part(`${name}_Felts`, cymWorld, node)
    const lower = kit.part(`${name}_Felt_Lower`, M.mul(cymWorld, M.t(0, -0.012, 0)), felts, [P(felt, 'felt', 'rubber')])
    kit.instance(`${name}_Felt_Upper`, M.mul(cymWorld, M.t(0, 0.012, 0)), felts, lower)
    kit.part(`${name}_WingNut`, M.mul(cymWorld, M.t(0, 0.024, 0)), node, [P(merge(
      lathe([[0.0001, 0], [0.008, 0], [0.008, 0.01], [0.0001, 0.012]], S(12, 6)),
      ...[-1, 1].map((s) => transform(roundedBox(0.016, 0.014, 0.004, 0.0015, { steps: 1 }), M.t(s * 0.013, 0.008, 0))),
    ), 'chrome', 'hardware')])
    const opts = name === 'Crash'
      ? { bellR: c.R * 0.2, bellH: 0.03, bow: 0.028, thick: 0.0014, rings: [28, 12, 5][q], segments: cymbalSegments(144) }
      : { bellR: c.R * 0.22, bellH: 0.034, bow: 0.026, thick: 0.0018, rings: [30, 12, 5][q], segments: cymbalSegments(144) }
    if (name === 'Crash') {
      const cym = kit.part('Crash_Cymbal', cymWorld, node, [P(cymbal(c.R, opts), 'cymbal', 'cymbal', 'Crash', 'surface')], { pivot: 'centre mounting hole', wobbleAxis: 'local X and Z' })
      kit.collider('COL_Crash', cymWorld, cym, { type: 'cylinder', axis: 'y', radius: c.R, height: 0.03 }, 'Crash_Cymbal')
    } else {
      const cym = kit.part('Ride_Cymbal', cymWorld, node, [], { pivot: 'centre mounting hole', wobbleAxis: 'local X and Z', zones: { bell: [0, opts.bellR], bow: [opts.bellR, c.R * 0.86], edge: [c.R * 0.86, c.R] } })
      kit.part('Ride_Bell', cymWorld, cym, [P(cymbalZone(c.R, 0, opts.bellR, opts), 'cymbal', 'cymbal', 'Ride', 'surface')])
      kit.part('Ride_Bow', cymWorld, cym, [P(cymbalZone(c.R, opts.bellR, c.R * 0.86, opts), 'cymbal', 'cymbal', 'Ride', 'surface')])
      kit.part('Ride_Edge', cymWorld, cym, [P(cymbalZone(c.R, c.R * 0.86, c.R, opts), 'cymbal', 'cymbal', 'Ride', 'surface')])
      kit.collider('COL_RideBell', cymWorld, cym, { type: 'cylinder', axis: 'y', radius: opts.bellR, height: 0.05 }, 'Ride_Bell')
      kit.collider('COL_RideBow', cymWorld, cym, { type: 'ring', axis: 'y', innerRadius: opts.bellR, outerRadius: c.R * 0.86, height: 0.03 }, 'Ride_Bow')
      kit.collider('COL_RideEdge', cymWorld, cym, { type: 'ring', axis: 'y', innerRadius: c.R * 0.86, outerRadius: c.R, height: 0.03 }, 'Ride_Edge')
    }
  }

  // ---------- Throne ----------
  {
    const th = L.Throne
    const world = M.t(...th.center)
    const node = kit.part('Throne', world, root)
    const t = tripod(th.seat - 0.06, { spread: 0.27, collar: 0.2, brace: 0.1, q, tube: 0.016 })
    const legs = kit.part('Throne_Legs', world, node)
    let firstLeg = null
    t.angles.forEach((a, i) => {
      const w = M.mul(world, M.ry(a + Math.PI / 2))
      if (firstLeg === null) firstLeg = kit.part(`Throne_Leg_0${i + 1}`, w, legs, [P(t.legMesh, 'chrome', 'hardware')])
      else kit.instance(`Throne_Leg_0${i + 1}`, w, legs, firstLeg)
    })
    kit.part('Throne_Post', world, node, [P(t.base, 'chrome', 'hardware')])
    kit.part('Throne_AdjustmentCollar', M.mul(world, M.t(0, 0.38, 0)), node, [P(merge(
      lathe([[0.0001, -0.02], [0.026, -0.02], [0.028, -0.016], [0.028, 0.016], [0.026, 0.02], [0.0001, 0.02]], S(24, 8)),
      rod([0.026, 0, 0], [0.06, 0, 0], 0.005, S(8, 5)),
      transform(lathe([[0.0001, -0.008], [0.014, -0.008], [0.015, 0], [0.014, 0.008], [0.0001, 0.008]], S(16, 8)), M.chain(M.t(0.066, 0, 0), M.rz(Math.PI / 2))),
    ), 'chrome', 'hardware')])
    const seatProfile = [[0.0001, -0.035], [0.15, -0.035], [0.168, -0.028], [0.178, -0.012], [0.18, 0.01], [0.176, 0.028], [0.165, 0.042], [0.14, 0.05], [0.08, 0.054], [0.0001, 0.055]]
    kit.part('Throne_Seat', M.mul(world, M.t(0, th.seat, 0)), node, [
      P(lathe(seatProfile, S(96, 12), { tile: 3 }), 'vinyl', 'rubber'),
      P(lathe([[0.0001, -0.05], [0.12, -0.05], [0.12, -0.035], [0.0001, -0.035]], S(48, 8)), 'metalBlack', 'hardware'),
    ], { pivot: 'centre of the vertical post' })
  }
  return root
}

/** A closed circular tube profile (for rims and the vent ring). */
function circleTube(R, y, t, steps) {
  return Array.from({ length: steps + 1 }, (_, i) => { const a = (i / steps) * Math.PI * 2; return [R + t * Math.cos(a), y + t * Math.sin(a)] })
}

/** The kick's front head with a centred vent hole and a turned-down collar, facing -Y (the audience). */
function portedHead(R, hole, segments, q) {
  const rings = [8, 4, 2][q]
  const profile = [[R + 0.0012, -0.012], [R + 0.0012, 0.002], [R * 0.985, 0.0035]]
  for (let i = 1; i <= rings; i++) profile.push([R * 0.985 - (R * 0.985 - hole) * i / rings, 0.0035])
  profile.push([hole, 0.0])
  return lathe(profile.map(([r, y]) => [r, -y]).reverse(), segments, { uv: 'planar', extent: R })
}

export const ACOUSTIC_PLAYABLE = ['Kick_BatterHead', 'Snare_BatterHead', 'Snare_Rim', 'TomHigh_BatterHead', 'TomMid_BatterHead', 'FloorTom_BatterHead', 'HiHat_TopCymbal', 'Crash_Cymbal', 'Ride_Cymbal']
export const ACOUSTIC_COLLIDERS = ['COL_Kick', 'COL_SnareHead', 'COL_SnareRim', 'COL_TomHigh', 'COL_TomMid', 'COL_FloorTom', 'COL_HiHat', 'COL_Crash', 'COL_RideBow', 'COL_RideBell', 'COL_RideEdge']
export { DETAIL }
