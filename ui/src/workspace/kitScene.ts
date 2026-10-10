import type { KitPiece } from './kit'
/** The procedural looks, kept as the fallback when a kit's GLB file cannot be loaded. */
export type KitStyle = 'electronic' | 'studio' | 'acoustic' | 'illustrated'

/**
 * The 3D drum kit scene: procedural geometry for a five-piece kit (two rack toms, one floor tom) in four looks, baked
 * into a few vertex batches, with shaders for studio lighting, physically motivated materials, soft planar shadows and
 * the illustrated outline. Every style puts each surface in the same place, so a hit lights the same piece in any look.
 */

export type Target = KitPiece | 'hatPedal'
type Vec3 = [number, number, number]
/** `pattern`: 0 plain, 1 wood grain, 2 lathed bronze, 3 mesh head, 4 rubber cymbal, 5 coated head, 6 lit screen, 7 floor. */
export type Material = { color: Vec3; metal: number; rough: number; pattern: number }
export type Batch = { target: Target | null; material: Material; hatTop: boolean; kind: 'solid' | 'blob' | 'floor'; data: Float32Array; count: number }
export type Kit = { batches: Batch[]; anchors: Map<KitPiece, Vec3> }


// Column-major 4x4 matrices.
export const multiply = (a: Float32Array, b: Float32Array) => {
  const out = new Float32Array(16)
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k]
  return out
}
export const chain = (...matrices: Float32Array[]) => matrices.reduce(multiply)
export const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
export const translate = (x: number, y: number, z: number) => { const m = identity(); m[12] = x; m[13] = y; m[14] = z; return m }
const rotateX = (angle: number) => {
  const m = identity(); const c = Math.cos(angle); const s = Math.sin(angle)
  m[5] = c; m[6] = s; m[9] = -s; m[10] = c
  return m
}
const rotateY = (angle: number) => {
  const m = identity(); const c = Math.cos(angle); const s = Math.sin(angle)
  m[0] = c; m[2] = -s; m[8] = s; m[10] = c
  return m
}
const rotateZ = (angle: number) => {
  const m = identity(); const c = Math.cos(angle); const s = Math.sin(angle)
  m[0] = c; m[1] = s; m[4] = -s; m[5] = c
  return m
}
export const normalize = (v: number[]) => { const l = Math.hypot(...v); return v.map((value) => value / l) }
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** A matrix whose local +Y runs from `a` to `b` (length = distance), for struts, legs and booms. */
function between(a: number[], b: number[]): Float32Array {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const y = normalize(d)
  const x = normalize(cross(y, Math.abs(y[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]))
  const z = cross(x, y)
  const length = Math.hypot(...d)
  return new Float32Array([...x, 0, ...y.map((v) => v * length), 0, ...z, 0, a[0], a[1], a[2], 1])
}

/** Turns a (radius, height) profile around the Y axis into triangles with interleaved position and normal. */
function lathe(profile: [number, number][], segments = 48): Float32Array {
  const out: number[] = []
  for (let k = 0; k + 1 < profile.length; k++) {
    const [r0, y0] = profile[k]
    const [r1, y1] = profile[k + 1]
    const [nr, ny] = normalize([y1 - y0, -(r1 - r0)])
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2
      const b = ((i + 1) / segments) * Math.PI * 2
      const point = (r: number, y: number, angle: number) =>
        out.push(r * Math.cos(angle), y, r * Math.sin(angle), nr * Math.cos(angle), ny, nr * Math.sin(angle))
      point(r0, y0, a); point(r0, y0, b); point(r1, y1, b)
      point(r0, y0, a); point(r1, y1, b); point(r1, y1, a)
    }
  }
  return new Float32Array(out)
}
const ring = (radius: number, y: number, tube: number, segments = 64) =>
  lathe(Array.from({ length: 11 }, (_, i) => {
    const angle = (i / 10) * Math.PI * 2
    return [radius + tube * Math.cos(angle), y + tube * Math.sin(angle)] as [number, number]
  }), segments)
/** A unit-length tube along +Y; scale its length with `between`. */
const tube = (radius: number) => lathe([[radius, 0], [radius, 1]], 14)
const disc = (radius: number, y = 0, segments = 48) => lathe([[0, y], [radius, y]], segments)
/** A small rounded cap, for rubber feet and knobs. */
const cap = (radius: number, height: number) => lathe([[radius, 0], [radius, height * 0.7], [radius * 0.7, height], [0.0001, height]], 14)

function box(w: number, h: number, d: number): Float32Array {
  const out: number[] = []
  const faces: [Vec3, Vec3, Vec3][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, -1]], [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [0, 0, -1], [1, 0, 0]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ]
  const half = [w / 2, h / 2, d / 2]
  for (const [n, u, v] of faces) {
    const corner = (su: number, sv: number) => [0, 1, 2].map((i) => (n[i] + u[i] * su + v[i] * sv) * half[i])
    const quad = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, -1), corner(1, 1), corner(-1, 1)]
    for (const p of quad) out.push(...p, ...n)
  }
  return new Float32Array(out)
}

const material = (color: Vec3, metal: number, rough: number, pattern = 0): Material => ({ color, metal, rough, pattern })
const CHROME = material([0.92, 0.93, 0.95], 1, 0.16)
const RUBBER = material([0.05, 0.05, 0.055], 0, 0.85)
const FELT = material([0.88, 0.86, 0.8], 0, 0.95)
const FLOOR = material([0.94, 0.94, 0.94], 0, 1, 7)
const SHADOW = material([0, 0, 0], 0, 1)

type Palette = {
  shell: Material; snareShell: Material; head: Material; resonant: Material; hoop: Material; kickHoop: Material
  cymbal: Material; stand: Material; rack: Material
}
const PALETTES: Record<KitStyle, Palette> = {
  // Dark cherry lacquered wood, coated heads, chrome hardware and lathed bronze cymbals.
  acoustic: {
    shell: material([0.32, 0.045, 0.04], 0, 0.22, 1), snareShell: material([0.035, 0.035, 0.04], 0, 0.18),
    head: material([0.93, 0.92, 0.88], 0, 0.75, 5), resonant: material([0.9, 0.89, 0.86], 0, 0.75, 5),
    hoop: CHROME, kickHoop: material([0.3, 0.045, 0.04], 0, 0.25, 1),
    cymbal: material([0.86, 0.64, 0.32], 1, 0.32, 2), stand: CHROME, rack: CHROME,
  },
  // Shallow black pads with mesh heads and thick rubber rims, black rubber cymbals, a matte black tubular rack.
  electronic: {
    shell: material([0.045, 0.045, 0.05], 0, 0.55), snareShell: material([0.045, 0.045, 0.05], 0, 0.55),
    head: material([0.86, 0.86, 0.85], 0, 0.95, 3), resonant: material([0.04, 0.04, 0.045], 0, 0.7),
    hoop: material([0.04, 0.04, 0.045], 0, 0.8), kickHoop: material([0.04, 0.04, 0.045], 0, 0.8),
    cymbal: material([0.06, 0.06, 0.065], 0, 0.6, 4), stand: CHROME, rack: material([0.05, 0.05, 0.055], 0.4, 0.45),
  },
  // Premium pads: gloss black shells, bright fine mesh, chrome rims and lugs, deeper floor pad.
  studio: {
    shell: material([0.03, 0.03, 0.035], 0, 0.16), snareShell: material([0.03, 0.03, 0.035], 0, 0.16),
    head: material([0.93, 0.93, 0.92], 0, 0.9, 3), resonant: material([0.03, 0.03, 0.035], 0, 0.5),
    hoop: CHROME, kickHoop: material([0.03, 0.03, 0.035], 0, 0.3),
    cymbal: material([0.05, 0.05, 0.055], 0, 0.5, 4), stand: CHROME, rack: material([0.035, 0.035, 0.04], 0.5, 0.35),
  },
  // The acoustic kit as an illustration: warm painted finishes, drawn with outlines and banded light.
  illustrated: {
    shell: material([0.62, 0.17, 0.1], 0, 0.6, 1), snareShell: material([0.12, 0.1, 0.1], 0, 0.6),
    head: material([0.98, 0.95, 0.86], 0, 0.8), resonant: material([0.92, 0.88, 0.8], 0, 0.8),
    hoop: material([0.82, 0.8, 0.76], 0.6, 0.4), kickHoop: material([0.58, 0.16, 0.1], 0, 0.6, 1),
    cymbal: material([0.95, 0.74, 0.32], 0.6, 0.45, 2), stand: material([0.78, 0.77, 0.75], 0.6, 0.4), rack: material([0.78, 0.77, 0.75], 0.6, 0.4),
  },
}

/** Builds the kit for a style and bakes it into batches grouped by target, material and hi-hat clutch. */
export function buildKit(style: KitStyle): Kit {
  const pads = style === 'electronic' || style === 'studio'
  const studio = style === 'studio'
  const P = PALETTES[style]
  const sides = style === 'illustrated' ? 18 : 64
  const anchors = new Map<KitPiece, Vec3>()
  const groups = new Map<string, { target: Target | null; material: Material; hatTop: boolean; kind: Batch['kind']; chunks: number[][] }>()
  const add = (target: Target | null, mesh: Float32Array, model: Float32Array, mat: Material, extra: { hatTop?: boolean; kind?: Batch['kind'] } = {}) => {
    const kind = extra.kind ?? 'solid'
    const key = `${target}|${JSON.stringify(mat)}|${!!extra.hatTop}|${kind}`
    const group = groups.get(key) ?? { target, material: mat, hatTop: !!extra.hatTop, kind, chunks: [] }
    const out: number[] = []
    for (let i = 0; i < mesh.length; i += 6) {
      const [x, y, z, nx, ny, nz] = mesh.subarray(i, i + 6)
      out.push(
        model[0] * x + model[4] * y + model[8] * z + model[12], model[1] * x + model[5] * y + model[9] * z + model[13], model[2] * x + model[6] * y + model[10] * z + model[14],
        ...normalize([model[0] * nx + model[4] * ny + model[8] * nz, model[1] * nx + model[5] * ny + model[9] * nz, model[2] * nx + model[6] * ny + model[10] * nz]),
        x, y, z)
    }
    group.chunks.push(out)
    groups.set(key, group)
  }
  const strut = (a: number[], b: number[], radius: number, mat: Material, target: Target | null = null) => add(target, tube(radius), between(a, b), mat)
  // Contact shadows are unit discs scaled into place, so the shader can fade each one from its centre.
  const blob = (x: number, z: number, radius: number) => {
    const model = translate(x, 0.003, z)
    model[0] = radius; model[10] = radius
    add(null, disc(1, 0, 32), model, SHADOW, { kind: 'blob' })
  }

  /** A tripod: three legs from a collar to rubber feet, braces to the centre tube, and the tube up to `top`. */
  const tripod = (x: number, z: number, top: number, spread = 0.24, collar = 0.3) => {
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2 + 0.5
      const foot = [x + Math.cos(angle) * spread, 0.012, z + Math.sin(angle) * spread]
      strut([x, collar, z], foot, 0.0065, P.stand)
      strut([x, 0.12, z], [x + Math.cos(angle) * spread * 0.55, 0.12 + (collar - 0.12) * 0.45, z + Math.sin(angle) * spread * 0.55], 0.004, P.stand)
      add(null, cap(0.012, 0.022), translate(foot[0], 0, foot[2]), RUBBER)
    }
    add(null, lathe([[0.016, -0.02], [0.016, 0.02]], 16), translate(x, collar, z), P.stand)
    // Telescoping tube: a wider lower section, a memory lock, then the narrower upper one.
    strut([x, collar, z], [x, (collar + top) / 2, z], 0.011, P.stand)
    add(null, lathe([[0.017, -0.012], [0.017, 0.012]], 16), translate(x, (collar + top) / 2, z), P.stand)
    strut([x, (collar + top) / 2, z], [x, top, z], 0.0075, P.stand)
    blob(x, z, spread * 1.1)
  }

  /** A drum: rounded shell, head, hoop(s) and lugs, oriented by `pose` (local +Y is the batter head). */
  const drum = (target: KitPiece, radius: number, depth: number, at: Vec3, pose: Float32Array, options: { snare?: boolean; kick?: boolean; lugs?: number } = {}) => {
    const model = chain(translate(...at), pose)
    const half = depth / 2
    const shell = options.snare ? P.snareShell : P.shell
    add(target, lathe([[radius - 0.004, -half], [radius, -half + 0.005], [radius, half - 0.005], [radius - 0.004, half]], sides), model, shell)
    add(target, lathe([[0, half + 0.001], [radius * 0.985, half + 0.001], [radius * 0.985, half - 0.005]], sides), model, P.head)
    add(target, lathe([[radius * 0.985, -half + 0.005], [radius * 0.985, -half - 0.001], [0, -half - 0.001]], sides), model, P.resonant)
    const hoop = options.kick ? P.kickHoop : P.hoop
    if (pads && !studio) {
      // Thick rubber rim over the pad's edge.
      add(target, ring(radius + 0.005, half - 0.002, 0.013, sides), model, hoop)
    } else {
      add(target, ring(radius + 0.004, half + 0.002, options.kick ? 0.012 : 0.006, sides), model, hoop)
      if (!pads) add(target, ring(radius + 0.004, -half - 0.002, options.kick ? 0.012 : 0.006, sides), model, hoop)
      const count = options.lugs ?? (radius > 0.25 ? 10 : radius > 0.16 ? 8 : 6)
      const length = Math.min(0.055, depth * 0.36)
      for (let i = 0; i < count; i++) {
        const angle = ((i + 0.5) / count) * Math.PI * 2
        const [cx, cz] = [Math.cos(angle) * (radius + 0.007), Math.sin(angle) * (radius + 0.007)]
        add(target, lathe([[0.0001, -length / 2 - 0.005], [0.0065, -length / 2], [0.0065, length / 2], [0.0001, length / 2 + 0.005]], 10),
          chain(model, translate(cx, pads ? 0 : depth * 0.12, cz)), CHROME)
        // Tension rods from the lug to the hoop.
        add(target, tube(0.0022), chain(model, between([cx, pads ? length / 2 : depth * 0.12 + length / 2, cz], [cx, half + 0.004, cz])), CHROME)
        if (!pads) add(target, tube(0.0022), chain(model, between([cx, -half - 0.004, cz], [cx, depth * 0.12 - length / 2, cz])), CHROME)
      }
    }
    if (options.snare && !pads) add(target, box(0.03, 0.04, 0.016), chain(model, translate(radius + 0.012, 0, 0)), CHROME)
    anchors.set(target, [at[0], at[1], at[2]])
    return model
  }

  /** A curved cymbal: bell, bow and edge, with a felt and wing nut on top. */
  const cymbal = (target: KitPiece, radius: number, at: Vec3, pose: Float32Array, hatTop = false) => {
    const bow = pads ? 0.6 : 1
    const top: [number, number][] = [[0.004, 0.044 * bow], [0.012, 0.043 * bow], [0.028, 0.038 * bow], [radius * 0.2, 0.022 * bow],
      [radius * 0.26, 0.016 * bow], [radius * 0.55, 0.006 * bow], [radius * 0.82, -0.003 * bow], [radius, -0.011 * bow]]
    const thick = pads ? 0.007 : 0.0028
    const model = chain(translate(...at), pose)
    add(target, lathe(top, sides), model, P.cymbal, { hatTop })
    add(target, lathe([...top.map(([r, y]) => [r, y - thick] as [number, number])].reverse(), sides), model, P.cymbal, { hatTop })
    add(target, lathe([[radius, -0.011 * bow], [radius, -0.011 * bow - thick]], sides), model, P.cymbal, { hatTop })
    if (!hatTop) {
      add(null, lathe([[0.012, 0.045 * bow], [0.012, 0.058 * bow], [0, 0.058 * bow]], 12), model, FELT)
      add(null, cap(0.008, 0.02), chain(model, translate(0, 0.058 * bow, 0)), CHROME)
    }
    if (target !== 'hihat' || !hatTop) anchors.set(target, [at[0], at[1], at[2]])
  }

  /** A cymbal on a tripod with a boom arm reaching to its centre. */
  const cymbalStand = (base: Vec3, top: number, at: Vec3) => {
    tripod(base[0], base[2], top)
    strut([base[0], top, base[2]], [at[0], at[1] - 0.04, at[2]], 0.0065, P.stand)
    add(null, lathe([[0.012, -0.015], [0.012, 0.015]], 12), translate(base[0], top, base[2]), P.stand)
  }

  /** A pedal: footboard, heel plate, frame and beater shaft; the kick pedal glows with the kick. */
  const pedal = (target: Target, x: number, front: number, beaterTo?: Vec3) => {
    add(target, box(0.075, 0.012, 0.26), chain(translate(x, 0.035, front + 0.15), rotateX(-0.2)), CHROME)
    add(null, box(0.08, 0.01, 0.09), translate(x, 0.006, front + 0.3), CHROME)
    add(null, box(0.12, 0.01, 0.07), translate(x, 0.006, front + 0.02), RUBBER)
    if (beaterTo) {
      for (const dx of [-0.05, 0.05]) strut([x + dx, 0.01, front + 0.03], [x + dx, 0.15, front + 0.03], 0.006, CHROME)
      strut([x - 0.05, 0.15, front + 0.03], [x + 0.05, 0.15, front + 0.03], 0.005, CHROME)
      strut([x, 0.15, front + 0.03], beaterTo, 0.0035, CHROME, target)
      add(target, lathe([[0.0001, -0.022], [0.022, -0.012], [0.022, 0.012], [0.0001, 0.022]], 16), chain(translate(...beaterTo), rotateX(Math.PI / 2)), FELT)
    }
  }

  // Floor and soft contact shadows.
  add(null, disc(3.2, 0, 64), identity(), FLOOR, { kind: 'floor' })

  if (pads) {
    // Tubular rack: four legs, front and back bars, clamps at every joint, rubber feet.
    const posts: [number, number][] = [[-0.52, 0.1], [-0.52, -0.3], [0.84, 0.1], [0.84, -0.3]]
    for (const [x, z] of posts) {
      strut([x, 0, z], [x, 0.98, z], 0.018, P.rack)
      add(null, cap(0.022, 0.03), translate(x, 0, z), RUBBER)
      add(null, cap(0.02, 0.025), translate(x, 0.98, z), RUBBER)
      blob(x, z, 0.12)
    }
    for (const z of [0.1, -0.3]) strut([-0.52, 0.72, z], [0.84, 0.72, z], 0.017, P.rack)
    for (const x of [-0.52, 0.84]) strut([x, 0.4, 0.1], [x, 0.4, -0.3], 0.015, P.rack)
    for (const [x, z] of [...posts, [-0.16, 0.1], [0.18, 0.1]] as [number, number][])
      add(null, box(0.055, 0.06, 0.055), translate(x, 0.72, z), P.rack)
    // Drum module on an arm from the left front leg, angled toward the player.
    strut([-0.52, 0.86, 0.1], [-0.64, 0.9, 0.14], 0.01, P.rack)
    const module = chain(translate(-0.7, 0.92, 0.16), rotateY(0.55), rotateX(-0.75))
    add(null, box(studio ? 0.22 : 0.18, 0.13, 0.04), module, material([0.06, 0.06, 0.07], 0.1, 0.4))
    add(null, box(studio ? 0.1 : 0.07, 0.05, 0.004), chain(module, translate(studio ? -0.04 : -0.035, 0.02, 0.021)), material([0.3, 0.55, 0.95], 0, 0.3, 6))
    for (let i = 0; i < 6; i++)
      add(null, cap(0.008, 0.01), chain(module, translate(0.025 + (i % 3) * 0.025, (i < 3 ? 0.03 : -0.01), 0.02), rotateX(Math.PI / 2)), material([0.6, 0.6, 0.62], 0.8, 0.3))
  }

  // Kick: a full bass drum on spurs, or a pad on a tower; either way a pedal and beater in front.
  if (pads) {
    const r = studio ? 0.14 : 0.12
    drum('kick', r, studio ? 0.06 : 0.05, [0.02, 0.32, 0.03], rotateX(Math.PI / 2), { kick: true, lugs: 6 })
    for (const x of [-0.09, 0.13]) strut([x, 0, 0.0], [x, 0.36, 0.0], 0.014, P.rack)
    strut([-0.09, 0.2, 0], [0.13, 0.2, 0], 0.012, P.rack)
    add(null, box(0.3, 0.02, 0.2), translate(0.02, 0.01, 0.0), P.rack)
    pedal('kick', 0.02, 0.07, [0.02, 0.3, 0.085])
    blob(0.02, 0.05, 0.22)
  } else {
    drum('kick', 0.28, 0.4, [0.02, 0.3, 0.0], rotateX(Math.PI / 2), { kick: true })
    for (const side of [-1, 1]) strut([0.02 + side * 0.27, 0.2, 0.08], [0.02 + side * 0.4, 0.012, 0.2], 0.007, CHROME)
    // Tom holder on the bass drum.
    add(null, box(0.05, 0.04, 0.06), translate(0.02, 0.585, -0.02), CHROME)
    strut([0.02, 0.6, -0.02], [0.02, 0.72, -0.02], 0.011, CHROME)
    pedal('kick', 0.02, 0.2, [0.02, 0.3, 0.22])
    blob(0.02, 0.0, 0.42)
  }

  // Snare on its stand, tilted toward the player, held by a three-arm basket.
  const snareAt: Vec3 = [-0.34, 0.62, 0.36]
  drum('snare', pads ? 0.165 : 0.18, pads ? (studio ? 0.09 : 0.07) : 0.14, snareAt, rotateX(0.1), { snare: true })
  tripod(snareAt[0], snareAt[2], snareAt[1] - 0.1, 0.2, 0.26)
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2 + 1
    strut([snareAt[0], snareAt[1] - 0.1, snareAt[2]], [snareAt[0] + Math.cos(angle) * 0.15, snareAt[1] - 0.075, snareAt[2] + Math.sin(angle) * 0.15], 0.004, P.stand)
  }

  // Two rack toms over the kick, the smaller one at the player's left, each on an arm.
  const racks: [KitPiece, number, number, Vec3, number][] = [
    ['tom1', pads ? 0.125 : 0.13, pads ? (studio ? 0.09 : 0.06) : 0.2, [-0.16, 0.88, -0.02], 0.45],
    ['tom2', pads ? 0.135 : 0.145, pads ? (studio ? 0.09 : 0.06) : 0.22, [0.18, 0.88, -0.02], 0.4],
  ]
  for (const [piece, radius, depth, at, tilt] of racks) {
    const model = drum(piece, radius, depth, at, chain(rotateY(-at[0] * 0.5), rotateX(tilt)))
    // The arm meets the side of the shell, under the drum.
    const under = [model[12] - model[4] * depth * 0.2 - model[8] * radius * 0.9, model[13] - model[5] * depth * 0.2 - model[9] * radius * 0.9,
      model[14] - model[6] * depth * 0.2 - model[10] * radius * 0.9]
    add(null, lathe([[0.0001, -0.02], [0.016, -0.012], [0.016, 0.012], [0.0001, 0.02]], 14), translate(under[0], under[1], under[2]), P.rack)
    if (pads) strut([at[0], 0.72, 0.1], under, 0.011, P.rack)
    else strut([0.02, 0.72, -0.02], under, 0.009, CHROME)
  }

  // One floor tom at the player's right: on three legs, or held by the rack.
  {
    const [radius, depth, x, z] = pads ? [0.18, studio ? 0.2 : 0.07, 0.6, 0.42] : [0.2, 0.36, 0.6, 0.42]
    const y = pads ? 0.5 : 0.5
    drum('floor', radius, depth, [x, y, z], rotateX(pads ? 0.22 : 0.03))
    if (pads) {
      strut([0.84, 0.72, 0.1], [x + 0.05, y - 0.02, z - radius * 0.8], 0.012, P.rack)
    } else {
      for (let i = 0; i < 3; i++) {
        const angle = (i / 3) * Math.PI * 2 + 0.6
        const top = [x + Math.cos(angle) * (radius + 0.02), y - depth * 0.2, z + Math.sin(angle) * (radius + 0.02)]
        add(null, box(0.025, 0.04, 0.025), translate(top[0], top[1], top[2]), CHROME)
        strut(top, [x + Math.cos(angle) * (radius + 0.09), 0.012, z + Math.sin(angle) * (radius + 0.09)], 0.006, CHROME)
        add(null, cap(0.011, 0.02), translate(x + Math.cos(angle) * (radius + 0.09), 0, z + Math.sin(angle) * (radius + 0.09)), RUBBER)
      }
      blob(x, z, radius + 0.12)
    }
  }

  // Hi-hat: tripod stand, pedal, fixed bottom cymbal and the top cymbal on the clutch (lifted by the hat state).
  const hat: Vec3 = [-0.72, 0.9, 0.3]
  tripod(hat[0], hat[2], hat[1] - 0.04, 0.24, 0.32)
  strut([hat[0], hat[1] - 0.04, hat[2]], [hat[0], hat[1] + 0.13, hat[2]], 0.0035, CHROME)
  cymbal('hihat', 0.17, hat, rotateX(Math.PI))
  cymbal('hihat', 0.17, [hat[0], hat[1] + 0.012, hat[2]], identity(), true)
  add(null, lathe([[0.01, 0.02], [0.01, 0.045]], 12), translate(hat[0], hat[1], hat[2]), CHROME, { hatTop: true })
  pedal('hatPedal', hat[0], hat[2] + 0.06)

  // Crash at the player's left and ride at the right: on boom stands, or on the rack's booms.
  const crash: Vec3 = [-0.6, 1.16, -0.24]
  const ride: Vec3 = [0.92, 1.02, -0.06]
  if (pads) {
    strut([-0.52, 0.98, -0.3], [crash[0], crash[1] - 0.04, crash[2]], 0.011, P.rack)
    strut([0.84, 0.98, -0.3], [ride[0], ride[1] - 0.04, ride[2]], 0.011, P.rack)
  } else {
    cymbalStand([-0.82, 0, -0.06], 0.98, crash)
    cymbalStand([1.1, 0, 0.16], 0.86, ride)
  }
  cymbal('crash', pads ? 0.2 : 0.23, crash, chain(rotateZ(0.14), rotateX(0.3)))
  cymbal('ride', pads ? 0.23 : 0.27, ride, chain(rotateZ(-0.16), rotateX(0.24)))

  const batches: Batch[] = [...groups.values()].map(({ chunks, ...group }) => {
    const data = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
    let offset = 0
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length }
    return { ...group, data, count: data.length / 9 }
  })
  return { batches, anchors }
}

export const VERTEX = `attribute vec3 p; attribute vec3 n; attribute vec3 q;
uniform mat4 m; uniform mat4 vp; uniform float grow; uniform vec3 sun; uniform float flatten;
varying vec3 vn; varying vec3 wp; varying vec3 lq;
void main() {
  vec4 w = m * vec4(p + n * grow, 1.0);
  // Planar shadow: project along the light onto the floor.
  if (flatten > 0.0) { w.xyz -= sun * (w.y / sun.y); w.y = 0.002; }
  wp = w.xyz; lq = q; vn = mat3(m) * n;
  gl_Position = vp * w;
}`

export const FRAGMENT = `precision highp float;
uniform vec3 color; uniform vec3 tint; uniform vec3 eye;
uniform float metal; uniform float rough; uniform float pattern; uniform float glow; uniform float ink; uniform float toon;
uniform float blob; uniform float flatten; uniform float shadowAlpha;
varying vec3 vn; varying vec3 wp; varying vec3 lq;
void main() {
  if (flatten > 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, shadowAlpha); return; }
  if (blob > 0.0) {
    float a = 0.2 * (1.0 - smoothstep(0.1, 1.0, length(lq.xz) / blob));
    gl_FragColor = vec4(0.0, 0.0, 0.0, a);
    return;
  }
  vec3 N = normalize(vn);
  vec3 V = normalize(eye - wp);
  if (ink > 0.0) {
    if (dot(N, V) > 0.0) discard;
    gl_FragColor = vec4(0.16, 0.09, 0.05, 1.0);
    return;
  }
  if (pattern > 6.5) {
    // A seamless studio floor that fades into the page.
    float d = length(wp.xz - vec2(0.1, 0.0));
    gl_FragColor = vec4(mix(vec3(0.91, 0.91, 0.915), vec3(1.0), smoothstep(0.5, 2.4, d)), 1.0);
    return;
  }
  // Two-sided: every surface is lit on the side the viewer sees.
  if (dot(N, V) < 0.0) N = -N;
  vec3 base = color;
  float r = length(lq.xz);
  float angle = atan(lq.z, lq.x);
  float roughness = rough;
  if (pattern > 0.5 && pattern < 1.5) {
    float grain = sin(angle * 140.0 + sin(lq.y * 38.0 + angle * 9.0) * 2.4) * 0.5 + 0.5;
    float figure = sin(angle * 23.0 + lq.y * 11.0) * 0.5 + 0.5;
    base *= 0.78 + 0.28 * grain + 0.14 * figure;
  } else if (pattern < 2.5 && pattern > 1.5) {
    float lathe = 0.5 + 0.5 * sin(r * 1400.0);
    float hammer = 0.5 + 0.5 * sin(angle * 37.0 + r * 90.0) * sin(angle * 23.0 - r * 140.0);
    base *= 0.82 + 0.12 * lathe + 0.1 * hammer;
    roughness = clamp(rough - 0.1 * lathe, 0.05, 1.0);
  } else if (pattern < 3.5 && pattern > 2.5) {
    float weave = abs(sin(lq.x * 520.0)) * abs(sin(lq.z * 520.0));
    base *= 0.9 + 0.1 * weave;
  } else if (pattern < 4.5 && pattern > 3.5) {
    base *= 0.8 + 0.25 * (0.5 + 0.5 * sin(r * 230.0));
  } else if (pattern < 5.5 && pattern > 4.5) {
    base *= 0.97 + 0.03 * sin(lq.x * 70.0 + sin(lq.z * 50.0));
  } else if (pattern > 5.5) {
    gl_FragColor = vec4(base * (0.85 + 0.15 * step(0.0, sin(lq.y * 300.0))), 1.0);
    return;
  }
  vec3 key = normalize(vec3(0.35, 1.0, 0.6));
  vec3 fill = normalize(vec3(-0.75, 0.45, 0.25));
  vec3 rim = normalize(vec3(0.15, 0.55, -1.0));
  float k = max(dot(N, key), 0.0);
  float f = max(dot(N, fill), 0.0);
  float rimLight = max(dot(N, rim), 0.0);
  if (toon > 0.0) { k = floor(k * 3.0 + 0.5) / 3.0; f = floor(f * 2.0 + 0.5) / 2.0; }
  float shine = mix(220.0, 3.0, pow(roughness, 0.6));
  vec3 F0 = mix(vec3(0.04), base, metal);
  float facing = max(dot(N, V), 0.0);
  vec3 F = F0 + (vec3(1.0) - F0) * pow(1.0 - facing, 5.0) * (1.0 - roughness * 0.8);
  float norm = (shine + 8.0) / 25.0;
  float spec = pow(max(dot(N, normalize(key + V)), 0.0), shine) * norm * 1.0
    + pow(max(dot(N, normalize(fill + V)), 0.0), shine) * norm * 0.3
    + pow(max(dot(N, normalize(rim + V)), 0.0), shine) * norm * 0.6;
  if (toon > 0.0) spec = step(0.5, spec) * 0.5;
  // A studio environment for reflections: bright ceiling with a softbox, a pale horizon and a darker floor.
  vec3 R = reflect(-V, N);
  vec3 env = R.y > 0.0 ? mix(vec3(0.8, 0.81, 0.83), vec3(1.0), sqrt(R.y)) : mix(vec3(0.8), vec3(0.32, 0.31, 0.3), min(1.0, -R.y * 3.0));
  env += vec3(2.2) * smoothstep(0.9, 0.975, dot(R, normalize(vec3(0.3, 0.8, 0.52))));
  env += vec3(1.0) * smoothstep(0.93, 0.985, dot(R, normalize(vec3(-0.7, 0.45, 0.55))));
  env = mix(env, vec3(0.72), roughness * roughness);
  float occlusion = mix(0.62, 1.0, smoothstep(0.0, 0.45, wp.y));
  vec3 ambient = mix(vec3(0.34, 0.33, 0.32), vec3(0.62, 0.64, 0.68), 0.5 + 0.5 * N.y) * occlusion;
  vec3 diffuse = base * (ambient + vec3(1.0, 0.97, 0.92) * k * 0.85 + vec3(0.82, 0.88, 1.0) * f * 0.3 + rimLight * 0.15);
  vec3 col = diffuse * (1.0 - metal) + env * F * occlusion * mix(0.6, 1.0, metal) + spec * F * vec3(1.0, 0.98, 0.95);
  col = vec3(1.0) - exp(-col * 1.15);
  vec3 lit = tint * (0.55 + 0.45 * k) + 0.12;
  gl_FragColor = vec4(clamp(mix(col, lit, glow), 0.0, 1.0), 1.0);
}`

/** The procedural kit in the asset renderer's format, so a missing GLB still shows a working kit with feedback. */
export function fallbackScene(kit: 'acoustic' | 'electronic'): import('./kitAsset').Prepared {
  const built = buildKit(kit)
  const items: import('./kitAsset').Item[] = built.batches.filter((batch) => batch.kind === 'solid').map((batch, index) => {
    const count = batch.count
    const data = new Float32Array(count * 12)
    for (let i = 0; i < count; i++) {
      data.set(batch.data.subarray(i * 9, i * 9 + 6), i * 12)
      data.set([0, 0], i * 12 + 6)
      data.set([1, 0, 0, 1], i * 12 + 8)
    }
    // The hi-hat top rides its rod: keep it in its own frame so the hat states move it in place.
    let frame = identity()
    if (batch.hatTop) {
      const centre = [0, 1, 2].map((k) => { let s = 0; for (let i = 0; i < count; i++) s += data[i * 12 + k]; return s / count })
      for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) data[i * 12 + k] -= centre[k]
      frame = translate(centre[0], centre[1], centre[2])
    }
    const m = batch.material
    return {
      name: `fallback:${index}`, data, index: Uint32Array.from({ length: count }, (_, i) => i),
      material: { name: `fallback:${index}`, base: [...m.color, 1] as [number, number, number, number], metal: m.metal, rough: m.rough, emissive: [0, 0, 0],
        baseTex: -1, ormTex: -1, normalTex: -1, emissiveTex: -1, normalScale: 1, blend: false },
      frame, target: batch.target ?? undefined, glows: !!batch.target,
      motion: batch.hatTop ? 'hat' : undefined, center: [0, 0, 0],
    }
  })
  return { items, anchors: built.anchors, center: [0.08, 0.6, 0.06], radius: 1.08, images: 0,
    hatStates: { fullyOpen: 0.06, partiallyOpen: 0.024, closed: 0, pedalClosed: 0 } }
}
