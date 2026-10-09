// Dependency-free glTF 2.0 toolkit for the drum-kit asset builders: mesh primitives with UVs and tangents,
// a small PNG encoder for procedural textures, and a binary glTF (.glb) writer with node hierarchy,
// PBR materials, embedded images, MSFT_lod levels and KHR_materials_variants.
import { deflateSync } from 'node:zlib'

// ---------- vectors and matrices (column-major 4x4, as glTF) ----------
export const v = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l] },
}
export const M = {
  identity: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  mul(a, b) {
    const out = new Array(16).fill(0)
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
    return out
  },
  chain: (...ms) => ms.reduce((a, b) => M.mul(a, b)),
  t: (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
  rx(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1] },
  ry(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1] },
  rz(a) { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  /** Rigid inverse (rotation + translation only). */
  inverseRigid(m) {
    const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1]
    const t = [m[12], m[13], m[14]]
    r[12] = -(r[0] * t[0] + r[4] * t[1] + r[8] * t[2])
    r[13] = -(r[1] * t[0] + r[5] * t[1] + r[9] * t[2])
    r[14] = -(r[2] * t[0] + r[6] * t[1] + r[10] * t[2])
    return r
  },
  point: (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]],
  dir: (m, d) => [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]],
  /** A rigid frame at `a` whose +Y points toward `b`. */
  aim(a, b, up = [0, 0, 1]) {
    const y = v.norm(v.sub(b, a))
    const x = v.norm(v.cross(y, Math.abs(v.dot(y, up)) > 0.95 ? [1, 0, 0] : up))
    const z = v.cross(x, y)
    return [...x, 0, ...y, 0, ...z, 0, a[0], a[1], a[2], 1]
  },
  quat(m) {
    const [m00, m10, m20, , m01, m11, m21, , m02, m12, m22] = m
    const trace = m00 + m11 + m22
    let x, y, z, w
    if (trace > 0) { const s = 0.5 / Math.sqrt(trace + 1); w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s }
    else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s }
    else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s }
    else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s }
    const l = Math.hypot(x, y, z, w)
    return [x / l, y / l, z / l, w / l]
  },
}

// ---------- meshes ----------
/** A mesh: flat arrays of positions, normals and UVs, and triangle indices (counter-clockwise from outside). */
export const mesh = () => ({ p: [], n: [], uv: [], idx: [] })

export function merge(...meshes) {
  const out = mesh()
  for (const m of meshes) {
    const base = out.p.length / 3
    for (const x of m.p) out.p.push(x)
    for (const x of m.n) out.n.push(x)
    for (const x of m.uv) out.uv.push(x)
    for (const i of m.idx) out.idx.push(i + base)
  }
  return out
}

export function transform(m, matrix) {
  const out = { p: new Array(m.p.length), n: new Array(m.n.length), uv: m.uv.slice(), idx: m.idx.slice() }
  for (let i = 0; i < m.p.length; i += 3) {
    const p = M.point(matrix, [m.p[i], m.p[i + 1], m.p[i + 2]])
    const n = v.norm(M.dir(matrix, [m.n[i], m.n[i + 1], m.n[i + 2]]))
    out.p[i] = p[0]; out.p[i + 1] = p[1]; out.p[i + 2] = p[2]
    out.n[i] = n[0]; out.n[i + 1] = n[1]; out.n[i + 2] = n[2]
  }
  return out
}

/**
 * Revolves a (radius, height) profile around +Y. The outward side of the profile is to its right
 * (normal = (dy, -dr)), so a profile walked bottom-to-top faces out and one walked edge-to-centre on top faces up.
 * UVs: `cyl` wraps u around and runs v along the profile length (both in metres times `tile`); `planar` maps x/z
 * onto the unit square over `extent` (for heads and cymbals, so grooves stay concentric). `smooth: false` gives
 * every profile segment its own normal (crisp edges, flat low-poly facets along the profile).
 */
export function lathe(profile, segments, { uv = 'cyl', tile = 1, extent = 1, smooth = true } = {}) {
  const out = mesh()
  const lengths = [0]
  for (let k = 1; k < profile.length; k++) lengths.push(lengths[k - 1] + Math.hypot(profile[k][0] - profile[k - 1][0], profile[k][1] - profile[k - 1][1]))
  const segNormal = (k) => v.norm([profile[k + 1][1] - profile[k][1], -(profile[k + 1][0] - profile[k][0]), 0])
  const ringCount = segments + 1
  const wraps = Math.max(1, Math.round(Math.PI * 2 * Math.max(...profile.map(([r]) => r)) * tile))
  const emit = (k, nn) => {
    const [r, y] = profile[k]
    const start = out.p.length / 3
    for (let i = 0; i < ringCount; i++) {
      const t = Math.PI * 2 * i / segments
      const c = Math.cos(t), s = Math.sin(t)
      out.p.push(r * c, y, r * s)
      out.n.push(nn[0] * c, nn[1], nn[0] * s)
      if (uv === 'planar') out.uv.push(0.5 + r * c / (2 * extent), 0.5 + r * s / (2 * extent))
      // Whole texture repeats around the circumference, so the wrap has no seam.
      else out.uv.push(i / segments * wraps, lengths[k] * tile)
    }
    return start
  }
  const quads = (a, b, k) => {
    const r0 = profile[k][0], r1 = profile[k + 1][0]
    for (let i = 0; i < segments; i++) {
      // Skip triangles that collapse at the axis.
      if (r0 > 1e-7) out.idx.push(a + i, b + i, a + i + 1)
      if (r1 > 1e-7) out.idx.push(a + i + 1, b + i, b + i + 1)
    }
  }
  if (smooth) {
    const starts = profile.map((_, k) => {
      const a = k > 0 ? segNormal(k - 1) : null
      const b = k < profile.length - 1 ? segNormal(k) : null
      return emit(k, v.norm(a && b ? v.add(a, b) : a ?? b))
    })
    for (let k = 0; k + 1 < profile.length; k++) quads(starts[k], starts[k + 1], k)
  } else {
    for (let k = 0; k + 1 < profile.length; k++) {
      const nn = segNormal(k)
      quads(emit(k, nn), emit(k + 1, nn), k)
    }
  }
  return out
}

/** A closed tube profile (circle of radius `t` around (R, y)), for torus hoops and rims. */
export const circleProfile = (R, y, t, steps, from = 0, to = Math.PI * 2) =>
  Array.from({ length: steps + 1 }, (_, i) => { const a = from + (to - from) * i / steps; return [R + t * Math.cos(a), y + t * Math.sin(a)] })

export const torus = (R, t, segments, sides, y = 0) => lathe(circleProfile(R, y, t, sides), segments, { tile: 4 })

/** A rod of `radius` from `a` to `b` with small rounded ends, for tubes, legs and arms. */
export function rod(a, b, radius, segments = 16, { caps = true } = {}) {
  const length = v.len(v.sub(b, a))
  const e = Math.min(radius * 0.35, length / 4)
  const profile = caps
    ? [[0, 0], [radius - e, 0], [radius - e * 0.3, e * 0.3], [radius, e], [radius, length - e], [radius - e * 0.3, length - e * 0.3], [radius - e, length], [0, length]]
    : [[radius, 0], [radius, length]]
  return transform(lathe(profile, segments, { tile: 6 }), M.aim(a, b))
}

/**
 * A box with rounded edges of radius `r`: each face is a grid concentrated toward the edges, pushed onto the
 * rounded shape so normals blend smoothly. Box-mapped UVs in metres times `tile`.
 */
export function roundedBox(w, h, d, r, { tile = 4, steps = 2 } = {}) {
  const half = [w / 2, h / 2, d / 2]
  r = Math.min(r, ...half.map((x) => x * 0.95))
  const coords = (hh) => {
    const list = [-hh, hh]
    for (let i = 1; i <= steps; i++) { const o = r * (1 - Math.cos((Math.PI / 2) * i / steps)); list.push(-hh + o, hh - o) }
    return [...new Set(list.map((x) => +x.toFixed(7)))].sort((a, b) => a - b)
  }
  const out = mesh()
  for (const ax of [0, 1, 2]) for (const sign of [1, -1]) {
    const au = (ax + 1) % 3, av = (ax + 2) % 3
    const us = coords(half[au]), vs = coords(half[av])
    const start = out.p.length / 3
    for (const cv of vs) for (const cu of us) {
      const p = [0, 0, 0]
      p[ax] = sign * half[ax]; p[au] = cu; p[av] = cv
      const inner = p.map((x, i) => Math.max(-(half[i] - r), Math.min(half[i] - r, x)))
      const dvec = v.sub(p, inner)
      const l = v.len(dvec)
      const flat = [0, 0, 0]; flat[ax] = sign
      const nn = l > 1e-9 ? v.scale(dvec, 1 / l) : flat
      const q = l > 1e-9 ? v.add(inner, v.scale(nn, r)) : p
      out.p.push(...q); out.n.push(...nn)
      out.uv.push((cu + half[au]) * tile, (cv + half[av]) * tile)
    }
    const cols = us.length
    for (let j = 0; j + 1 < vs.length; j++) for (let i = 0; i + 1 < cols; i++) {
      const a = start + j * cols + i, b = a + 1, c = a + cols, e = c + 1
      // u x v = +axis, so this order faces out for +sign; flip for the opposite face.
      if (sign > 0) out.idx.push(a, b, e, a, e, c)
      else out.idx.push(a, e, b, a, c, e)
    }
  }
  return out
}

/** A tube swept along a polyline (springs, chains, bent arms), with flat end caps. */
export function sweep(points, radius, sides = 12, { caps = true, tile = 6 } = {}) {
  const out = mesh()
  const tangentAt = (i) => v.norm(v.sub(points[Math.min(i + 1, points.length - 1)], points[Math.max(i - 1, 0)]))
  let t = tangentAt(0)
  let n = v.norm(v.cross(t, Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]))
  let along = 0
  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      along += v.len(v.sub(points[i], points[i - 1]))
      const next = tangentAt(i)
      // Parallel transport: remove the component of the old normal along the new tangent.
      n = v.norm(v.sub(n, v.scale(next, v.dot(n, next))))
      t = next
    }
    const b = v.cross(t, n)
    for (let s = 0; s <= sides; s++) {
      const a = Math.PI * 2 * s / sides
      const dir = v.add(v.scale(n, Math.cos(a)), v.scale(b, Math.sin(a)))
      out.p.push(...v.add(points[i], v.scale(dir, radius)))
      out.n.push(...dir)
      out.uv.push(s / sides, along * tile)
    }
  }
  const ring = sides + 1
  for (let i = 0; i + 1 < points.length; i++) for (let s = 0; s < sides; s++) {
    const a = i * ring + s, b = a + ring
    out.idx.push(a, a + 1, b, a + 1, b + 1, b)
  }
  // Orient by checking one triangle against its normal.
  const [i0, i1, i2] = out.idx
  const P = (i) => [out.p[i * 3], out.p[i * 3 + 1], out.p[i * 3 + 2]]
  const face = v.cross(v.sub(P(i1), P(i0)), v.sub(P(i2), P(i0)))
  if (v.dot(face, [out.n[i0 * 3], out.n[i0 * 3 + 1], out.n[i0 * 3 + 2]]) < 0)
    for (let k = 0; k < out.idx.length; k += 3) [out.idx[k + 1], out.idx[k + 2]] = [out.idx[k + 2], out.idx[k + 1]]
  if (caps) {
    for (const [i, sign] of [[0, -1], [points.length - 1, 1]]) {
      const dir = v.scale(tangentAt(i), sign)
      const center = out.p.length / 3
      out.p.push(...points[i]); out.n.push(...dir); out.uv.push(0.5, 0.5)
      const first = out.p.length / 3
      for (let s = 0; s <= sides; s++) {
        const k = (i * ring + s) * 3
        out.p.push(out.p[k], out.p[k + 1], out.p[k + 2]); out.n.push(...dir); out.uv.push(0.5 + Math.cos(s / sides * 6.283) / 2, 0.5 + Math.sin(s / sides * 6.283) / 2)
      }
      for (let s = 0; s < sides; s++) {
        const P2 = (j) => [out.p[j * 3], out.p[j * 3 + 1], out.p[j * 3 + 2]]
        const tri = [center, first + s, first + s + 1]
        const f = v.cross(v.sub(P2(tri[1]), P2(tri[0])), v.sub(P2(tri[2]), P2(tri[0])))
        out.idx.push(...(v.dot(f, dir) >= 0 ? tri : [tri[0], tri[2], tri[1]]))
      }
    }
  }
  return out
}

/** A closed rounded-rectangle profile centred at (cr, cy), counter-clockwise so its normals face out. */
export function roundedRect(cr, cy, w, h, r, steps = 3) {
  const out = []
  const corners = [[cr + w / 2 - r, cy - h / 2 + r, -Math.PI / 2], [cr + w / 2 - r, cy + h / 2 - r, 0], [cr - w / 2 + r, cy + h / 2 - r, Math.PI / 2], [cr - w / 2 + r, cy - h / 2 + r, Math.PI]]
  for (const [x, y, start] of corners) for (let i = 0; i <= steps; i++) {
    const a = start + (Math.PI / 2) * i / steps
    out.push([x + r * Math.cos(a), y + r * Math.sin(a)])
  }
  out.push(out[0])
  return out
}

/** Per-vertex tangents (xyz + handedness) from UV gradients, orthogonalised against the normals. */
export function tangents(m) {
  const count = m.p.length / 3
  const tan = new Float64Array(count * 3), bit = new Float64Array(count * 3)
  for (let t = 0; t < m.idx.length; t += 3) {
    const a = m.idx[t], b = m.idx[t + 1], c = m.idx[t + 2]
    const e1 = [m.p[b * 3] - m.p[a * 3], m.p[b * 3 + 1] - m.p[a * 3 + 1], m.p[b * 3 + 2] - m.p[a * 3 + 2]]
    const e2 = [m.p[c * 3] - m.p[a * 3], m.p[c * 3 + 1] - m.p[a * 3 + 1], m.p[c * 3 + 2] - m.p[a * 3 + 2]]
    const du1 = m.uv[b * 2] - m.uv[a * 2], dv1 = m.uv[b * 2 + 1] - m.uv[a * 2 + 1]
    const du2 = m.uv[c * 2] - m.uv[a * 2], dv2 = m.uv[c * 2 + 1] - m.uv[a * 2 + 1]
    const det = du1 * dv2 - du2 * dv1
    if (Math.abs(det) < 1e-14) continue
    const f = 1 / det
    for (let k = 0; k < 3; k++) {
      const T = (e1[k] * dv2 - e2[k] * dv1) * f, B = (e2[k] * du1 - e1[k] * du2) * f
      tan[a * 3 + k] += T; tan[b * 3 + k] += T; tan[c * 3 + k] += T
      bit[a * 3 + k] += B; bit[b * 3 + k] += B; bit[c * 3 + k] += B
    }
  }
  const out = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    const n = [m.n[i * 3], m.n[i * 3 + 1], m.n[i * 3 + 2]]
    let t = [tan[i * 3], tan[i * 3 + 1], tan[i * 3 + 2]]
    t = v.sub(t, v.scale(n, v.dot(n, t)))
    if (v.len(t) < 1e-9) t = v.cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])
    t = v.norm(t)
    const w = v.dot(v.cross(n, t), [bit[i * 3], bit[i * 3 + 1], bit[i * 3 + 2]]) < 0 ? -1 : 1
    out.set([t[0], t[1], t[2], w], i * 4)
  }
  return out
}

export const triangles = (m) => m.idx.length / 3

// ---------- PNG ----------
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (bytes) => { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
/** Encodes an 8-bit RGB image (Uint8Array, width*height*3) as PNG, with the Paeth filter on every row. */
export function png(width, height, rgb) {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1)
    raw[row] = 4
    for (let x = 0; x < stride; x++) {
      const cur = rgb[y * stride + x]
      const a = x >= 3 ? rgb[y * stride + x - 3] : 0
      const b = y > 0 ? rgb[(y - 1) * stride + x] : 0
      const c = x >= 3 && y > 0 ? rgb[(y - 1) * stride + x - 3] : 0
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      raw[row + 1 + x] = (cur - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4)
  header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// ---------- glTF document ----------
/**
 * Collects nodes, meshes, materials and images, then writes one self-contained GLB. Nodes are placed with world
 * matrices (rotation + translation only, no scale) and stored relative to their parent; meshes are in node space.
 */
export class Document {
  constructor(generator) {
    this.json = { asset: { version: '2.0', generator }, scene: 0, scenes: [], nodes: [], meshes: [], materials: [], textures: [], images: [],
      samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }], accessors: [], bufferViews: [], buffers: [] }
    this.chunks = []
    this.length = 0
    this.world = []
    this.materialIndex = new Map()
    this.extensionsUsed = new Set()
  }
  bufferView(bytes, target) {
    const pad = (4 - (this.length % 4)) % 4
    if (pad) { this.chunks.push(Buffer.alloc(pad)); this.length += pad }
    const view = { buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength }
    if (target) view.target = target
    this.chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    this.length += bytes.byteLength
    this.json.bufferViews.push(view)
    return this.json.bufferViews.length - 1
  }
  accessor(array, type, componentType, target, minmax = false) {
    const view = this.bufferView(array, target)
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type]
    const accessor = { bufferView: view, componentType, count: array.length / size, type }
    if (minmax) {
      const min = Array(size).fill(Infinity), max = Array(size).fill(-Infinity)
      for (let i = 0; i < array.length; i++) { const k = i % size; if (array[i] < min[k]) min[k] = array[i]; if (array[i] > max[k]) max[k] = array[i] }
      Object.assign(accessor, { min, max })
    }
    this.json.accessors.push(accessor)
    return this.json.accessors.length - 1
  }
  texture(name, pngBytes) {
    const view = this.bufferView(new Uint8Array(pngBytes))
    this.json.images.push({ name, bufferView: view, mimeType: 'image/png' })
    this.json.textures.push({ name, sampler: 0, source: this.json.images.length - 1 })
    return this.json.textures.length - 1
  }
  material(def) {
    if (this.materialIndex.has(def.name)) return this.materialIndex.get(def.name)
    this.json.materials.push(def)
    this.materialIndex.set(def.name, this.json.materials.length - 1)
    return this.json.materials.length - 1
  }
  /** A mesh from [{ mesh, material, variants? }] primitives; returns { index, tris } or null when empty. */
  mesh(name, primitives) {
    let tris = 0
    const prims = primitives.filter(({ mesh: m }) => m.idx.length).map(({ mesh: m, material, variants }) => {
      tris += triangles(m)
      const count = m.p.length / 3
      const attributes = {
        POSITION: this.accessor(new Float32Array(m.p), 'VEC3', 5126, 34962, true),
        NORMAL: this.accessor(new Float32Array(m.n), 'VEC3', 5126, 34962),
        TANGENT: this.accessor(tangents(m), 'VEC4', 5126, 34962),
        TEXCOORD_0: this.accessor(new Float32Array(m.uv), 'VEC2', 5126, 34962),
      }
      const indices = this.accessor(count > 65535 ? new Uint32Array(m.idx) : new Uint16Array(m.idx), 'SCALAR', count > 65535 ? 5125 : 5123, 34963)
      const prim = { attributes, indices, material, mode: 4 }
      if (variants?.length) {
        prim.extensions = { KHR_materials_variants: { mappings: variants } }
        this.extensionsUsed.add('KHR_materials_variants')
      }
      return prim
    })
    if (!prims.length) return null
    this.json.meshes.push({ name, primitives: prims })
    return { index: this.json.meshes.length - 1, tris }
  }
  /** Adds a node at a world matrix under `parent` (node index or null). */
  node(name, world, parent = null, extra = {}) {
    const local = parent === null ? world : M.mul(M.inverseRigid(this.world[parent]), world)
    const node = { name }
    const t = [local[12], local[13], local[14]].map((x) => +x.toFixed(6))
    if (t.some((x) => x !== 0)) node.translation = t
    const q = M.quat(local).map((x) => +x.toFixed(7))
    if (Math.abs(q[3]) < 0.9999999) node.rotation = q
    Object.assign(node, extra)
    this.json.nodes.push(node)
    const index = this.json.nodes.length - 1
    this.world[index] = world
    if (parent !== null) (this.json.nodes[parent].children ??= []).push(index)
    return index
  }
  write() {
    this.json.buffers.push({ byteLength: this.length })
    if (this.extensionsUsed.size) this.json.extensionsUsed = [...this.extensionsUsed]
    const pad = (buf, fill) => { const p = (4 - (buf.length % 4)) % 4; return p ? Buffer.concat([buf, Buffer.alloc(p, fill)]) : buf }
    const jsonBytes = pad(Buffer.from(JSON.stringify(this.json)), 0x20)
    const bin = pad(Buffer.concat(this.chunks), 0)
    const header = Buffer.alloc(12)
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + bin.length, 8)
    const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBytes.length, 0); jh.writeUInt32LE(0x4e4f534a, 4)
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4)
    return Buffer.concat([header, jh, jsonBytes, bh, bin])
  }
}

/** Reads a GLB into its JSON and binary chunk. */
export function readGlb(bytes) {
  const buf = Buffer.from(bytes)
  if (buf.readUInt32LE(0) !== 0x46546c67 || buf.readUInt32LE(4) !== 2) throw new Error('Not a glTF 2.0 binary')
  const jsonLength = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'))
  const binLength = buf.readUInt32LE(20 + jsonLength)
  return { json, bin: buf.subarray(28 + jsonLength, 28 + jsonLength + binLength), totalLength: buf.readUInt32LE(8) }
}
