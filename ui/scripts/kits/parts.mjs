// Geometry shared by the acoustic and electronic kits: cymbal and drum profiles, stands, pedals and fittings.
// Every function returns meshes in a local frame; callers place them with node world matrices.
import { circleProfile, lathe, M, merge, rod, roundedBox, roundedRect, sweep, transform, v } from './gltf.mjs'

/** Detail per level of detail: LOD0, LOD1, LOD2. */
export const DETAIL = [1, 0.42, 0.18]
export const seg = (n, q, min = 6) => Math.max(min, Math.round(n * DETAIL[q] / 2) * 2)

/**
 * A cymbal as one closed solid: bottom surface outward, rounded edge, top surface inward, centre-hole wall. The top
 * is sampled densely (bell, bow and edge) for silhouette and deformation; the hidden underside more coarsely.
 * Local origin is the centre mounting hole on the top surface; +Y is up through the bell.
 */
export function cymbal(R, { bellR = R * 0.22, bellH = 0.035, bow = 0.03, thick = 0.0016, hole = 0.0065, rings = 26, segments = 128, flat = false } = {}) {
  const top = (r) => bow * Math.pow(1 - r / R, 1.3) + (r < bellR ? bellH * Math.pow(1 - (r / bellR) ** 2, 0.75) : 0)
  const base = top(hole)
  const y = (r) => top(r) - base
  const samples = (count) => Array.from({ length: count + 1 }, (_, i) => {
    const t = i / count
    // Denser near the bell's foot and the edge.
    const s = t < 0.35 ? (t / 0.35) * bellR * 1.25 : bellR * 1.25 + (R - bellR * 1.25) * Math.pow((t - 0.35) / 0.65, 0.85)
    return Math.max(hole, Math.min(R, s))
  })
  const topRs = samples(rings), bottomRs = samples(Math.max(4, Math.round(rings / 2)))
  const profile = []
  for (const r of bottomRs) profile.push([r, y(r) - thick * (r < bellR ? 1.6 : 1)])
  const edge = circleProfile(R, y(R) - thick / 2, thick / 2, flat ? 2 : 6, -Math.PI / 2, Math.PI / 2)
  profile.push(...edge.slice(1, -1))
  for (const r of [...topRs].reverse()) profile.push([r, y(r)])
  profile.push(profile[0])
  return lathe(profile, segments, { uv: 'planar', extent: R, smooth: !flat })
}

/** Ring split of a cymbal for zones (bell / bow / edge): the same solid's top surface clipped to [r0, r1]. */
export function cymbalZone(R, r0, r1, opts) {
  const { bellR = R * 0.22, bellH = 0.035, bow = 0.03, thick = 0.0016, hole = 0.0065, rings = 26, segments = 128, flat = false } = opts
  const top = (r) => bow * Math.pow(1 - r / R, 1.3) + (r < bellR ? bellH * Math.pow(1 - (r / bellR) ** 2, 0.75) : 0)
  const y = (r) => top(r) - top(hole)
  const count = Math.max(3, Math.round(rings * (r1 - r0) / R))
  const rs = Array.from({ length: count + 1 }, (_, i) => Math.max(hole, r0 + (r1 - r0) * i / count))
  const profile = rs.map((r) => [r, y(r) - thick * (r < bellR ? 1.6 : 1)])
  if (r1 >= R - 1e-6) profile.push(...circleProfile(R, y(R) - thick / 2, thick / 2, flat ? 2 : 6, -Math.PI / 2, Math.PI / 2).slice(1, -1))
  for (const r of [...rs].reverse()) profile.push([r, y(r)])
  if (r0 <= hole + 1e-6) profile.push(profile[0])
  else profile.push([r0, y(r0) - thick], profile[0])
  return lathe(profile, segments, { uv: 'planar', extent: R, smooth: !flat })
}

/** A drum shell as a closed wall with rounded bearing edges; local origin at the shell centre, +Y the batter side. */
export function shell(R, H, { t = 0.006, segments = 128, flat = false } = {}) {
  const e = 0.003
  return lathe([[R - t, -H / 2], [R - e, -H / 2], [R, -H / 2 + e], [R, H / 2 - e], [R - e, H / 2], [R - t, H / 2], [R - t, -H / 2]], segments, { smooth: !flat, tile: 1 })
}

/** A drumhead: membrane with many rings (for centre-weighted deformation) and a collar over the bearing edge. */
export function head(R, { rings = 20, segments = 128, bottom = false } = {}) {
  const profile = [[R + 0.0012, -0.012], [R + 0.0012, 0.002], [R * 0.985, 0.0035]]
  for (let i = 1; i <= rings; i++) { const r = R * 0.985 * (1 - i / rings); profile.push([r, 0.0035]) }
  if (bottom) return lathe(profile.map(([r, y]) => [r, -y]).reverse(), segments, { uv: 'planar', extent: R })
  return lathe(profile, segments, { uv: 'planar', extent: R })
}

/** A triple-flange hoop: rounded section sitting over the head's collar. */
export const hoop = (R, { segments = 128, h = 0.022, w = 0.0055, bottom = false, sides = 3 } = {}) => {
  const profile = roundedRect(R + 0.0075, bottom ? -h / 2 + 0.006 : h / 2 - 0.006, w, h, 0.0022, sides)
  return lathe(profile, segments, { tile: 3 })
}

/** A tube lug: rounded body with two mounting feet, in a frame where +Y runs along the shell and +Z points out. */
export function lug(length, q) {
  const body = transform(roundedBox(0.018, length, 0.016, 0.006, { steps: q ? 1 : 2 }), M.t(0, 0, 0.008))
  return body
}

/** A tension rod with its square head; rod runs along +Y from 0 to `length`, head on top. */
export function tensionRod(length, q) {
  return merge(
    rod([0, 0, 0], [0, length, 0], 0.0024, seg(10, q, 5), { caps: false }),
    transform(roundedBox(0.009, 0.01, 0.009, 0.002, { steps: 1 }), M.t(0, length + 0.004, 0)),
    transform(lathe([[0.006, 0], [0.006, 0.0015], [0.0028, 0.0015]], seg(14, q, 6)), M.t(0, length - 0.001, 0)),
  )
}

/** A rubber foot. */
export const foot = (q) => lathe([[0.0001, 0], [0.013, 0], [0.014, 0.008], [0.011, 0.022], [0.0001, 0.022]], seg(16, q, 6))

/**
 * A tripod stand: three legs from a collar to rubber feet, braces from a lower collar, and a two-section tube up to
 * `top`, with a memory lock. Returns { base, legs: [leg meshes in base frame], legMesh (one leg at angle 0), angles }.
 */
export function tripod(top, { spread = 0.27, collar = 0.3, brace = 0.14, tube = 0.0125, q = 0, doubleBraced = true } = {}) {
  const legMesh = merge(
    rod([0, collar, 0], [spread, 0.02, 0], 0.0075, seg(14, q, 6)),
    ...(doubleBraced ? [rod([0, collar, 0], [spread * 0.98, 0.026, 0.0], 0.006, seg(10, q, 5))].map((m) => transform(m, M.t(0, 0, 0.012))) : []),
    rod([0.012, brace, 0], [spread * 0.55, collar - (collar - 0.02) * 0.55, 0], 0.005, seg(10, q, 5)),
    transform(foot(q), M.t(spread, 0, 0)),
  )
  const base = merge(
    lathe([[tube + 0.007, collar - 0.022], [tube + 0.009, collar - 0.018], [tube + 0.009, collar + 0.018], [tube + 0.007, collar + 0.022]], seg(24, q, 8)),
    lathe([[tube + 0.004, brace - 0.012], [tube + 0.006, brace - 0.01], [tube + 0.006, brace + 0.01], [tube + 0.004, brace + 0.012]], seg(24, q, 8)),
    rod([0, brace - 0.02, 0], [0, (collar + top) / 2, 0], tube, seg(20, q, 8)),
    transform(lathe([[tube + 0.006, -0.014], [tube + 0.008, -0.012], [tube + 0.008, 0.012], [tube + 0.006, 0.014]], seg(20, q, 8)), M.t(0, (collar + top) / 2, 0)),
    rod([0, (collar + top) / 2 - 0.02, 0], [0, top, 0], tube * 0.75, seg(18, q, 8)),
    transform(roundedBox(0.02, 0.022, 0.016, 0.004, { steps: 1 }), M.t(tube + 0.012, (collar + top) / 2, 0)),
  )
  return { base, legMesh, angles: [0.5, 0.5 + Math.PI * 2 / 3, 0.5 + Math.PI * 4 / 3] }
}

/** A helical spring along +Y from 0 to `length`. */
export function spring(radius, length, turns, wire, q) {
  const points = []
  const steps = Math.max(12, Math.round(turns * 16 * DETAIL[q]))
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * turns * Math.PI * 2
    points.push([radius * Math.cos(a), (i / steps) * length, radius * Math.sin(a)])
  }
  return sweep(points, wire, seg(8, q, 4))
}

/** A roller chain as a run of rounded links between two points (along +Y in the local frame). */
export function chain(a, b, q) {
  const count = Math.max(4, Math.round(v.len(v.sub(b, a)) / 0.0127))
  const links = []
  for (let i = 0; i < count; i++) {
    const t0 = i / count, t1 = (i + 1) / count
    const p0 = v.add(a, v.scale(v.sub(b, a), t0)), p1 = v.add(a, v.scale(v.sub(b, a), t1))
    const mid = v.scale(v.add(p0, p1), 0.5)
    links.push(transform(roundedBox(0.008, 0.0125, i % 2 ? 0.004 : 0.006, 0.0018, { steps: q ? 1 : 2 }), M.mul(M.aim(mid, p1), M.t(0, 0, 0))))
  }
  return merge(...links)
}

/**
 * A pedal: base plate and frame posts, a footboard (built at its heel hinge, rising toward the toe), and the
 * parts that sit on the axle. `toe` and `heel` are in the pedal's local frame (z toward the player).
 */
export function pedalParts({ heelZ = 0.32, toeZ = 0.02, toeY = 0.075, width = 0.085, q = 0 }) {
  const length = Math.hypot(heelZ - toeZ, toeY - 0.022)
  const angle = Math.atan2(toeY - 0.022, heelZ - toeZ)
  const board = merge(
    transform(roundedBox(width, 0.012, length, 0.004, { steps: q ? 1 : 2 }), M.t(0, 0.006, -length / 2)),
    // Raised grip ridges on the footboard.
    ...Array.from({ length: q === 2 ? 0 : 5 }, (_, i) => transform(roundedBox(width * 0.8, 0.0025, 0.006, 0.001, { steps: 1 }), M.t(0, 0.013, -0.05 - i * length * 0.15))),
  )
  const footboard = transform(board, M.rx(-angle))
  const base = merge(
    transform(roundedBox(width + 0.04, 0.008, Math.abs(heelZ - toeZ) + 0.06, 0.003, { steps: q ? 1 : 2 }), M.t(0, 0.004, (heelZ + toeZ) / 2)),
    transform(roundedBox(width + 0.06, 0.01, 0.05, 0.003, { steps: 1 }), M.t(0, 0.005, toeZ)),
  )
  const hinge = rod([-width / 2 - 0.006, 0.02, heelZ], [width / 2 + 0.006, 0.02, heelZ], 0.006, seg(14, q, 6))
  return { footboard, base, hinge, angle, length }
}

export { circleProfile, lathe, M, merge, rod, roundedBox, roundedRect, sweep, transform, v }
