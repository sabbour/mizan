// Procedural PBR texture sets for the drum-kit assets: base colour, packed occlusion/roughness/metalness (R/G/B, as
// glTF reads them) and tangent-space normal maps, all generated locally. No photographs, logos or baked lighting.
import { png } from './gltf.mjs'

const hash = (x, y, seed) => {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}
/** Tileable value noise over a `period` x `period` lattice. */
export function noise(u, v, period, seed = 1) {
  const x = u * period, y = v * period
  const xi = Math.floor(x), yi = Math.floor(y)
  const fx = x - xi, fy = y - yi
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
  const w = (i, j) => hash(((xi + i) % period + period) % period, ((yi + j) % period + period) % period, seed)
  return (w(0, 0) * (1 - sx) + w(1, 0) * sx) * (1 - sy) + (w(0, 1) * (1 - sx) + w(1, 1) * sx) * sy
}
export const fbm = (u, v, period, octaves = 4, seed = 1) => {
  let sum = 0, amp = 0.5, total = 0
  for (let o = 0; o < octaves; o++) { sum += noise(u, v, period << o, seed + o) * amp; total += amp; amp *= 0.5 }
  return sum / total
}
const clamp = (x) => Math.max(0, Math.min(255, Math.round(x * 255)))

/**
 * Renders a material set at `size`. `fn(u, v)` returns { c: [r,g,b] 0..1, h: height 0..1, r: roughness, m: metalness,
 * ao }. The normal map comes from the height field (`depth` sets its strength); returns PNG buffers.
 */
export function materialSet(size, fn, { depth = 1, normal = true, orm = true } = {}) {
  const base = new Uint8Array(size * size * 3)
  const ormMap = orm ? new Uint8Array(size * size * 3) : null
  const height = new Float32Array(size * size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const s = fn(x / size, y / size)
    const i = y * size + x
    base[i * 3] = clamp(s.c[0]); base[i * 3 + 1] = clamp(s.c[1]); base[i * 3 + 2] = clamp(s.c[2])
    if (ormMap) { ormMap[i * 3] = clamp(s.ao ?? 1); ormMap[i * 3 + 1] = clamp(s.r); ormMap[i * 3 + 2] = clamp(s.m ?? 0) }
    height[i] = s.h ?? 0
  }
  const out = { base: png(size, size, base) }
  if (ormMap) out.orm = png(size, size, ormMap)
  if (normal) {
    const nm = new Uint8Array(size * size * 3)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const h = (dx, dy) => height[((y + dy + size) % size) * size + ((x + dx + size) % size)]
      const nx = (h(-1, 0) - h(1, 0)) * depth, ny = (h(0, -1) - h(0, 1)) * depth
      const l = Math.hypot(nx, ny, 1)
      const i = (y * size + x) * 3
      nm[i] = clamp(nx / l * 0.5 + 0.5); nm[i + 1] = clamp(ny / l * 0.5 + 0.5); nm[i + 2] = clamp(1 / l * 0.5 + 0.5)
    }
    out.normal = png(size, size, nm)
  }
  return out
}

/** A single-image texture (emissive screens, edge masks). */
export function image(size, fn) {
  const rgb = new Uint8Array(size * size * 3)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const c = fn(x / size, y / size)
    const i = (y * size + x) * 3
    rgb[i] = clamp(c[0]); rgb[i + 1] = clamp(c[1]); rgb[i + 2] = clamp(c[2])
  }
  return png(size, size, rgb)
}

const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t)
const radius = (u, v) => Math.hypot(u - 0.5, v - 0.5) * 2

/** The realistic material sets, keyed by the kit's material names. */
export const realistic = {
  shellWood: (size) => materialSet(size, (u, v) => {
    // Vertical grain: lines across u, gently wandering along v; a clear coat keeps it smooth.
    const wander = fbm(u, v, 4, 3, 11) * 6
    const lines = 0.5 + 0.5 * Math.sin((u * 96 + wander) * Math.PI * 2)
    const figure = fbm(u, v, 8, 3, 12)
    const t = 0.55 * lines + 0.45 * figure
    return { c: mix([0.2, 0.025, 0.03], [0.42, 0.07, 0.06], t), h: lines * 0.4, r: 0.26 + 0.06 * figure, m: 0 }
  }, { depth: 1.2 }),
  headCoated: (size) => materialSet(size, (u, v) => {
    const grit = fbm(u, v, 128, 2, 21)
    const cloud = fbm(u, v, 6, 3, 22)
    return { c: mix([0.86, 0.85, 0.8], [0.93, 0.92, 0.88], cloud * 0.7 + grit * 0.3), h: grit, r: 0.62 + 0.12 * cloud, m: 0 }
  }, { depth: 2 }),
  headClear: (size) => materialSet(size, (u, v) => {
    const cloud = fbm(u, v, 8, 3, 23)
    return { c: mix([0.72, 0.72, 0.7], [0.8, 0.8, 0.78], cloud), h: 0, r: 0.22 + 0.08 * cloud, m: 0 }
  }, { normal: false }),
  cymbalBronze: (size) => materialSet(size, (u, v) => {
    const r = radius(u, v)
    const lathe = 0.5 + 0.5 * Math.sin(r * 230 * Math.PI * 2)
    const hammer = fbm(u, v, 24, 2, 31)
    const bell = r < 0.24 ? 1 - r / 0.24 : 0
    const edge = Math.max(0, (r - 0.9) / 0.1)
    const c = mix(mix([0.66, 0.46, 0.2], [0.82, 0.6, 0.3], lathe * 0.5 + hammer * 0.5), [0.9, 0.72, 0.42], bell * 0.6)
    return { c: mix(c, [0.58, 0.42, 0.2], edge * 0.4), h: lathe * 0.5 + hammer * 0.5, r: 0.3 + 0.12 * (1 - lathe) - bell * 0.1, m: 1 }
  }, { depth: 1.5 }),
  chrome: (size) => materialSet(size, (u, v) => ({ c: [0.94, 0.94, 0.95], h: fbm(u, v, 64, 1, 41) * 0.05, r: 0.1 + 0.04 * fbm(u, v, 8, 2, 42), m: 1 })),
  steelBrushed: (size) => materialSet(size, (u, v) => {
    const streak = fbm(u * 0.02, v, 512, 1, 51) * 0.6 + fbm(u, v * 0.05, 64, 2, 52) * 0.4
    return { c: mix([0.6, 0.6, 0.61], [0.76, 0.76, 0.77], streak), h: streak * 0.4, r: 0.32 + 0.08 * streak, m: 1 }
  }),
  metalBlack: (size) => materialSet(size, (u, v) => { const n = fbm(u, v, 32, 2, 61); return { c: [0.045 + 0.01 * n, 0.045 + 0.01 * n, 0.05 + 0.01 * n], h: n * 0.2, r: 0.42 + 0.06 * n, m: 0.85 } }),
  rubberBlack: (size) => materialSet(size, (u, v) => { const n = fbm(u, v, 96, 2, 71); return { c: [0.035 + 0.01 * n, 0.035 + 0.01 * n, 0.04 + 0.01 * n], h: n, r: 0.82 + 0.1 * n, m: 0 } }, { depth: 1.5 }),
  plasticBlack: (size) => materialSet(size, (u, v) => { const n = fbm(u, v, 48, 2, 81); return { c: [0.045, 0.045, 0.05], h: n * 0.3, r: 0.48 + 0.06 * n, m: 0 } }),
  feltDark: (size) => materialSet(size, (u, v) => { const n = fbm(u, v, 128, 3, 91); return { c: mix([0.07, 0.06, 0.055], [0.14, 0.12, 0.1], n), h: n, r: 0.95, m: 0 } }, { depth: 2 }),
  seatVinyl: (size) => materialSet(size, (u, v) => {
    // Pebbled vinyl: a soft cellular bump pattern.
    const cell = Math.abs(Math.sin(u * 160 * Math.PI + fbm(u, v, 16, 2, 101) * 4) * Math.sin(v * 160 * Math.PI + fbm(v, u, 16, 2, 102) * 4))
    return { c: [0.045, 0.045, 0.048], h: Math.sqrt(cell), r: 0.5 + 0.15 * cell, m: 0 }
  }, { depth: 2.5 }),
  snareWire: (size) => materialSet(size, (u, v) => { const line = 0.5 + 0.5 * Math.sin(u * 400 * Math.PI); return { c: [0.7, 0.71, 0.72], h: line, r: 0.3, m: 1 } }, { depth: 2 }),
  rubberCymbal: (size) => materialSet(size, (u, v) => {
    const r = radius(u, v)
    const groove = 0.5 + 0.5 * Math.sin(r * 120 * Math.PI * 2)
    return { c: [0.04 + 0.012 * groove, 0.04 + 0.012 * groove, 0.045 + 0.012 * groove], h: groove, r: 0.72 + 0.12 * groove, m: 0 }
  }, { depth: 1.2 }),
  meshHead: (size) => materialSet(size, (u, v) => {
    // A woven mesh: two crossing thread sets, alternating over and under.
    const a = Math.sin(u * 420 * Math.PI), b = Math.sin(v * 420 * Math.PI)
    const over = (Math.sign(Math.sin(u * 210 * Math.PI) * Math.sin(v * 210 * Math.PI)) + 1) / 2
    const h = Math.abs(a) * over + Math.abs(b) * (1 - over)
    return { c: mix([0.66, 0.66, 0.65], [0.84, 0.84, 0.83], h), h, r: 0.85, m: 0 }
  }, { depth: 1.6 }),
  powderCoat: (size) => materialSet(size, (u, v) => { const n = fbm(u, v, 48, 3, 111); return { c: [0.04 + 0.008 * n, 0.04 + 0.008 * n, 0.045 + 0.008 * n], h: n, r: 0.52 + 0.08 * n, m: 0.25 } }, { depth: 0.8 }),
  displayGlass: (size) => materialSet(size, () => ({ c: [0.02, 0.025, 0.03], h: 0, r: 0.06, m: 0 }), { normal: false }),
}

/** The module screen: a generic interface of bars and blocks (no text, no logos). */
export const displayEmission = (size) => image(size, (u, v) => {
  const inside = u > 0.04 && u < 0.96 && v > 0.06 && v < 0.94
  if (!inside) return [0.01, 0.02, 0.03]
  const header = v < 0.22 && u > 0.08 && u < 0.6
  const meter = v > 0.36 && v < 0.84 && Math.floor(u * 16) % 2 === 0 && (0.84 - v) < 0.48 * (0.4 + 0.6 * Math.abs(Math.sin(Math.floor(u * 16) * 1.7)))
  const tile = v > 0.3 && u > 0.7 && u < 0.92 && Math.floor(v * 8) % 2 === 0
  const glow = header ? 0.9 : meter ? 0.75 : tile ? 0.5 : 0.12
  return [0.25 * glow, 0.55 * glow + 0.05, 1.0 * glow + 0.08]
})

/** A thin bright ring at the outside of a planar-mapped head or cymbal, for idle edge accents. */
export const edgeRing = (size) => image(size, (u, v) => {
  const r = radius(u, v)
  const ring = Math.max(0, 1 - Math.abs(r - 0.955) / 0.035)
  return [ring, ring, ring]
})

/** Hand-painted base colours: broad soft brush variation, low-frequency only. */
export const painted = {
  shell: (size) => image(size, (u, v) => {
    const brush = fbm(u * 0.5, v * 2, 6, 3, 201)
    const grain = 0.5 + 0.5 * Math.sin((u * 24 + fbm(u, v, 3, 2, 202) * 3) * Math.PI * 2)
    return mix([0.55, 0.16, 0.13], [0.72, 0.26, 0.19], brush * 0.75 + grain * 0.25)
  }),
  head: (size) => image(size, (u, v) => mix([0.9, 0.85, 0.74], [0.97, 0.93, 0.83], fbm(u, v, 5, 3, 211))),
  cymbal: (size) => image(size, (u, v) => {
    const r = radius(u, v)
    const band = 0.5 + 0.5 * Math.sin(r * 18 * Math.PI * 2)
    return mix([0.78, 0.58, 0.28], [0.93, 0.76, 0.42], band * 0.5 + fbm(u, v, 4, 2, 221) * 0.5)
  }),
  charcoal: (size) => image(size, (u, v) => mix([0.16, 0.17, 0.2], [0.22, 0.21, 0.2], fbm(u, v, 4, 3, 231))),
  mesh: (size) => image(size, (u, v) => mix([0.86, 0.84, 0.78], [0.94, 0.92, 0.86], fbm(u, v, 5, 3, 241))),
}

/** Subtle clay surface: a soft, low-frequency normal map shared by every clay material. */
export const clayNormal = (size) => materialSet(size, (u, v) => ({ c: [1, 1, 1], h: fbm(u, v, 12, 3, 301), r: 0.9, m: 0 }), { depth: 3, orm: false }).normal
