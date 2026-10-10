// Original modular keyboard assets. Run from ui: node scripts\build-pianos.mjs [--out <directory>].
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KitBuilder, LOOKS } from './kits/common.mjs'
import { M, mesh, merge, rod, roundedBox, lathe, transform, v } from './kits/gltf.mjs'
import { fbm, materialSet, realistic } from './kits/textures.mjs'

/** The one instrument the app offers: an 88-key stage piano on an X stand. */
export const PIANO_VARIANTS = {
  stage_piano_88: { file: 'StagePiano88.glb', name: '88-key stage piano', low: 21, high: 108, width: 1.38, depth: 0.36, bodyHeight: 0.12 },
}

const WHITE_PITCHES = new Set([0, 2, 4, 5, 7, 9, 11])
const PITCHES = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B']
const GROUPS = ['Case', 'Keybed', 'Controls', 'Display', 'Speakers', 'MusicRest', 'Stand', 'Pedals', 'Bench', 'OptionalPianoComponents']
const KEY_HEIGHT = 0.75
const KEY_REAR = -0.045
const KEY_SPACING = 0.023
const WHITE_WIDTH = 0.0226
const WHITE_LENGTH = 0.145
const BLACK_WIDTH = 0.013
const BLACK_LENGTH = 0.095
const LOD_BUDGETS = [80000, 40000, 15000]
const isWhite = (midi) => WHITE_PITCHES.has(midi % 12)
const pitch = (midi) => `${PITCHES[midi % 12]}${Math.floor(midi / 12) - 1}`
const P = (geometry, key, cat) => ({ mesh: geometry, key, cat })

function materialDefinitions() {
  return {
    plastic: { name: 'MAT_Case_PowderCoat', set: realistic.powderCoat, size: 256 },
    panel: { name: 'MAT_ControlPanel_BlackMetal', set: realistic.metalBlack, size: 256 },
    whiteKey: { name: 'MAT_Key_IvoryPolymer', size: 128, set: (size) => materialSet(size, (u, w) => {
      const n = fbm(u, w, 32, 2, 319)
      return { c: [0.94 + 0.015 * n, 0.935 + 0.015 * n, 0.915 + 0.015 * n], h: n * 0.02, r: 0.22 + 0.04 * n, m: 0 }
    }, { depth: 0.25 }) },
    blackKey: { name: 'MAT_Key_BlackPolymer', size: 128, set: (size) => materialSet(size, (u, w) => {
      const n = fbm(u, w, 48, 2, 321)
      return { c: [0.024 + 0.005 * n, 0.025 + 0.005 * n, 0.028 + 0.005 * n], h: n * 0.03, r: 0.26 + 0.04 * n, m: 0 }
    }, { depth: 0.3 }) },
    wood: { name: 'MAT_Case_Walnut', size: 256, set: (size) => materialSet(size, (u, w) => {
      const grain = fbm(u * 0.08, w, 64, 2, 327)
      return { c: [0.13 + grain * 0.07, 0.063 + grain * 0.035, 0.03 + grain * 0.018], h: grain * 0.08, r: 0.32, m: 0 }
    }, { depth: 0.35 }) },
    lacquer: { name: 'MAT_Case_BlackLacquer', size: 256, set: (size) => materialSet(size, () =>
      ({ c: [0.025, 0.024, 0.026], r: 0.13, m: 0 }), { normal: false }) },
    brass: { name: 'MAT_Pedal_Brass', size: 256, set: (size) => materialSet(size, (u, w) => {
      const n = fbm(u * 0.1, w, 64, 1, 333)
      return { c: [0.65 + 0.04 * n, 0.43 + 0.03 * n, 0.16 + 0.02 * n], h: n * 0.1, r: 0.25 + 0.04 * n, m: 1 }
    }) },
    steel: { name: 'MAT_Hardware_Steel', set: realistic.steelBrushed, size: 128 },
    rubber: { name: 'MAT_Feet_Rubber', set: realistic.rubberBlack, size: 128 },
    felt: { name: 'MAT_Keybed_Felt', set: realistic.feltDark, size: 128 },
    vinyl: { name: 'MAT_Bench_Upholstery', set: realistic.seatVinyl, size: 256 },
    speaker: { name: 'MAT_Speaker_Cloth', size: 128, set: (size) => materialSet(size, (u, w) => {
      const weave = Math.abs(Math.sin(u * 128 * Math.PI) * Math.sin(w * 128 * Math.PI))
      return { c: [0.055 + 0.015 * weave, 0.056 + 0.015 * weave, 0.06 + 0.015 * weave], h: weave * 0.25, r: 0.85, m: 0 }
    }, { depth: 0.5 }) },
    glass: { name: 'MAT_Display_Glass', set: realistic.displayGlass, size: 128, emissive: true },
    soundboard: { name: 'MAT_Soundboard_Spruce', size: 256, set: (size) => materialSet(size, (u, w) => {
      const grain = 0.5 + 0.5 * Math.sin((u * 90 + fbm(u, w, 8, 2, 347)) * Math.PI * 2)
      return { c: [0.66 + grain * 0.08, 0.46 + grain * 0.07, 0.24 + grain * 0.04], h: grain * 0.06, r: 0.65, m: 0 }
    }, { depth: 0.3 }) },
  }
}

const cross2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

function cleanContour(points) {
  const out = points.filter((p, i) => {
    const before = points[(i + points.length - 1) % points.length]
    return Math.hypot(p[0] - before[0], p[1] - before[1]) > 1e-9
  })
  let changed = true
  while (changed && out.length > 3) {
    changed = false
    for (let i = 0; i < out.length; i++) {
      if (Math.abs(cross2(out[(i + out.length - 1) % out.length], out[i], out[(i + 1) % out.length])) < 1e-12) {
        out.splice(i, 1)
        changed = true
        break
      }
    }
  }
  const area = out.reduce((sum, p, i) => {
    const next = out[(i + 1) % out.length]
    return sum + p[0] * next[1] - next[0] * p[1]
  }, 0)
  if (area < 0) out.reverse()
  return out
}

function triangulate(points) {
  const remaining = points.map((_, i) => i)
  const result = []
  while (remaining.length > 3) {
    let clipped = false
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[(i + remaining.length - 1) % remaining.length]
      const b = remaining[i], c = remaining[(i + 1) % remaining.length]
      if (cross2(points[a], points[b], points[c]) <= 1e-12) continue
      const contains = remaining.some((j) => j !== a && j !== b && j !== c &&
        cross2(points[a], points[b], points[j]) >= -1e-12 &&
        cross2(points[b], points[c], points[j]) >= -1e-12 &&
        cross2(points[c], points[a], points[j]) >= -1e-12)
      if (contains) continue
      result.push([a, b, c])
      remaining.splice(i, 1)
      clipped = true
      break
    }
    if (!clipped) throw new Error('Cannot triangulate the keyboard component contour')
  }
  result.push(remaining)
  return result
}

function insetContour(points, distance) {
  return points.map((p, i) => {
    const a = points[(i + points.length - 1) % points.length], b = points[(i + 1) % points.length]
    const leftNormal = (from, to) => {
      const length = Math.hypot(to[0] - from[0], to[1] - from[1])
      return [-(to[1] - from[1]) / length, (to[0] - from[0]) / length]
    }
    const n1 = leftNormal(a, p), n2 = leftNormal(p, b)
    const divisor = 1 + n1[0] * n2[0] + n1[1] * n2[1]
    if (divisor < 1e-6) throw new Error('A component bevel has a folded contour')
    return [p[0] + distance * (n1[0] + n2[0]) / divisor, p[1] + distance * (n1[1] + n2[1]) / divisor]
  })
}

function triangle(out, a, b, c, uvScale = 1) {
  const normal = v.norm(v.cross(v.sub(b, a), v.sub(c, a)))
  const start = out.p.length / 3
  for (const p of [a, b, c]) {
    out.p.push(...p)
    out.n.push(...normal)
    out.uv.push(p[0] * uvScale, p[2] * uvScale + p[1] * uvScale)
  }
  out.idx.push(start, start + 1, start + 2)
}

/** Closed, concave key silhouettes keep black-key clearance without overlapping fused boxes. */
function extrude(points, bottom, top, bevel = 0) {
  points = cleanContour(points)
  const inner = bevel ? insetContour(points, bevel) : points
  const out = mesh()
  const at = (p, y) => [p[0], y, p[1]]
  for (const [a, b, c] of triangulate(inner)) {
    triangle(out, at(inner[a], top), at(inner[c], top), at(inner[b], top), 7)
    triangle(out, at(inner[a], bottom), at(inner[b], bottom), at(inner[c], bottom), 7)
  }
  const layers = bevel
    ? [[inner, bottom], [points, bottom + bevel], [points, top - bevel], [inner, top]]
    : [[points, bottom], [points, top]]
  for (let layer = 0; layer + 1 < layers.length; layer++) {
    const [lower, y0] = layers[layer], [upper, y1] = layers[layer + 1]
    for (let i = 0; i < points.length; i++) {
      const next = (i + 1) % points.length
      triangle(out, at(lower[i], y0), at(upper[i], y1), at(lower[next], y0), 7)
      triangle(out, at(lower[next], y0), at(upper[i], y1), at(upper[next], y1), 7)
    }
  }
  return out
}

function whiteGeometry(midi, spec, lod) {
  const left = -WHITE_WIDTH / 2, right = WHITE_WIDTH / 2
  const l = midi > spec.low && !isWhite(midi - 1) ? 0.0067 : 0
  const r = midi < spec.high && !isWhite(midi + 1) ? 0.0067 : 0
  return extrude([
    [left + l, 0], [right - r, 0], [right - r, 0.1], [right, 0.1],
    [right, WHITE_LENGTH], [left, WHITE_LENGTH], [left, 0.1], [left + l, 0.1],
  ], -0.012, 0, lod === 2 ? 0 : 0.0007)
}

function buildLevel(kit, variant, spec, lod) {
  const box = (w, h, d, radius = 0.003) => roundedBox(w, h, d, radius, { steps: [3, 2, 1][lod], tile: 4 })
  const atBox = (x, y, z, w, h, d, radius) => transform(box(w, h, d, radius), M.t(x, y, z))
  const root = kit.part(lod ? `KeyboardInstrument_LOD${lod}` : 'KeyboardInstrument', M.identity(), null, [], { lod, instrument: { variant } })
  const groups = Object.fromEntries(GROUPS.map((name) => [name, kit.part(name, M.identity(), root)]))
  const add = (name, parent, geometry, material = 'plastic', category = 'drum', world = M.identity(), extras) =>
    kit.part(name, world, parent, [P(geometry, material, category)], extras)
  const whites = [], blacks = []
  for (let midi = spec.low; midi <= spec.high; midi++) (isWhite(midi) ? whites : blacks).push(midi)
  const whiteGroup = kit.part('WhiteKeys', M.identity(), groups.Keybed)
  const blackGroup = kit.part('BlackKeys', M.identity(), groups.Keybed)
  const center = (midi) => (whites.indexOf(midi) - (whites.length - 1) / 2) * KEY_SPACING
  const keys = []
  for (let midi = spec.low; midi <= spec.high; midi++) {
    const black = !isWhite(midi), name = `Key_${midi}_${pitch(midi)}`
    const x = black ? (center(midi - 1) + center(midi + 1)) / 2 : center(midi)
    const length = black ? BLACK_LENGTH : WHITE_LENGTH
    const travel = black ? 0.007 : 0.01
    const y = KEY_HEIGHT + (black ? 0.017 : 0)
    const world = M.t(x, y, KEY_REAR)
    if (!kit.materials.has(name)) {
      const original = kit.doc.json.materials[kit.realistic(black ? 'blackKey' : 'whiteKey')]
      const material = structuredClone(original)
      material.name = `MAT_${name}`
      material.extras = { midi, individuallyHighlightable: true }
      kit.materials.set(name, kit.doc.material(material))
    }
    const geometry = black
      ? atBox(0, -0.008, length / 2, BLACK_WIDTH, 0.016, length, 0.0013)
      : whiteGeometry(midi, spec, lod)
    const actuation = { axis: 'x', angle: Math.asin(travel / length), travel, pivot: 'rear hinge', front: [0, 0, length] }
    const labelAnchor = [0, 0.001, black ? length - 0.014 : length - 0.021]
    const key = add(name, black ? blackGroup : whiteGroup, geometry, name, black ? 'rubber' : 'head', world,
      { midi, pitch: pitch(midi), isBlack: black, actuation, labelAnchor })
    const primitive = kit.doc.json.meshes[kit.doc.json.nodes[key].mesh].primitives[0]
    const neon = primitive.extensions.KHR_materials_variants.mappings.find((mapping) => mapping.variants.includes(LOOKS.indexOf('NeonRhythm')))
    neon.material = kit.variant(`NeonRhythm_${name}`, () => ({
      pbrMetallicRoughness: {
        baseColorFactor: black ? [0.018, 0.025, 0.035, 1] : [0.7, 0.82, 0.88, 1],
        metallicFactor: 0, roughnessFactor: 0.45,
      },
      emissiveFactor: black ? [0, 0.012, 0.018] : [0.01, 0.07, 0.09],
      extras: { look: 'NeonRhythm', midi, individuallyHighlightable: true },
    }))
    kit.collider(`COL_${name}`, world, key, { type: 'box', size: [black ? BLACK_WIDTH : WHITE_WIDTH, black ? 0.016 : 0.012, length], center: [0, black ? -0.008 : -0.006, length / 2] }, name)
    keys.push({ midi, name, pitch: pitch(midi), isBlack: black, position: [x, y, KEY_REAR], actuation, labelAnchor })
  }

  const keyWidth = whites.length * KEY_SPACING
  const caseMat = 'plastic'
  const cheekWidth = (spec.width - keyWidth) / 2 - 0.004
  const bodyRear = 0.12 - spec.depth
  add('Case_Base', groups.Case, atBox(0, 0.672, (bodyRear + 0.12) / 2, spec.width, 0.044, 0.12 - bodyRear), caseMat)
  for (const side of [-1, 1]) {
    add(`Case_Cheek_${side < 0 ? 'Left' : 'Right'}`, groups.Case,
      atBox(side * (spec.width / 2 - cheekWidth / 2), 0.71, (bodyRear + 0.12) / 2, cheekWidth, 0.12, 0.12 - bodyRear, 0.008), caseMat)
  }
  add('Case_FrontRail', groups.Case, atBox(0, 0.71, 0.115, keyWidth + 0.012, 0.038, 0.01, 0.002), caseMat)
  add('Keybed_FeltStrip', groups.Keybed, atBox(0, 0.743, KEY_REAR - 0.01, keyWidth, 0.014, 0.012, 0.001), 'felt', 'rubber')
  add('Case_FallboardRail', groups.Case, atBox(0, 0.747, KEY_REAR - 0.018, keyWidth + 0.015, 0.042, 0.012), caseMat)

  {
    add('Controls_Panel', groups.Controls, atBox(0, 0.735, (bodyRear - 0.063) / 2, spec.width - 0.016, 0.07, -0.063 - bodyRear, 0.004), 'panel', 'hardware')
    const screenWorld = M.t(0, 0.7715, -0.116)
    add('Display_Screen', groups.Display, atBox(0, 0, 0, 0.096, 0.003, 0.039, 0.001), 'glass', 'screen', screenWorld)
    add('Display_Bezel', groups.Display, merge(
      atBox(-0.051, 0, 0, 0.006, 0.005, 0.049), atBox(0.051, 0, 0, 0.006, 0.005, 0.049),
      atBox(0, 0, -0.023, 0.096, 0.005, 0.006), atBox(0, 0, 0.023, 0.096, 0.005, 0.006),
    ), 'plastic', 'drum', screenWorld)
    for (let i = 0; i < 4; i++) {
      const world = M.t(-0.22 + i * 0.035, 0.771, -0.113)
      const geometry = lathe([[0, 0], [0.009, 0], [0.0105, 0.0015], [0.0105, 0.01], [0.009, 0.012], [0, 0.012]], [24, 16, 8][lod], { tile: 8, smooth: false })
      const knob = add(`Control_Knob_${i + 1}`, groups.Controls, geometry, 'rubber', 'rubber', world, { pivot: 'shaft', axis: 'y' })
      add(`Control_Knob_${i + 1}_Indicator`, knob, atBox(0, 0.0125, 0.0055, 0.002, 0.001, 0.005, 0.0003), 'whiteKey', 'head', world)
    }
    for (let i = 0; i < 8; i++) {
      add(`Control_Button_${i + 1}`, groups.Controls,
        atBox(0.079 + i * 0.024, 0.774, -0.113, 0.017, 0.007, 0.013, 0.002), 'rubber', 'rubber')
    }
    for (const side of [-1, 1]) {
      const x = side * (spec.width / 2 - 0.16), z = bodyRear + 0.091
      const speaker = add(`Speaker_${side < 0 ? 'Left' : 'Right'}`, groups.Speakers,
        atBox(x, 0.772, z, 0.215, 0.006, 0.082, 0.005), 'speaker', 'rubber')
      add(`Speaker_${side < 0 ? 'Left' : 'Right'}_Frame`, speaker, merge(
        atBox(x - 0.11, 0.773, z, 0.007, 0.006, 0.094), atBox(x + 0.11, 0.773, z, 0.007, 0.006, 0.094),
        atBox(x, 0.773, z - 0.046, 0.215, 0.006, 0.006), atBox(x, 0.773, z + 0.046, 0.215, 0.006, 0.006),
      ), 'plastic', 'drum')
    }
    add('Controls_RearConnections', groups.Controls, merge(
      ...Array.from({ length: 5 }, (_, i) => atBox(-0.11 + i * 0.038, 0.721, bodyRear - 0.001, 0.02, 0.013, 0.004, 0.002)),
    ), 'rubber', 'rubber')
  }

  {
    add('Stand_XBrace_Left', groups.Stand, rod([-0.46, 0.043, -0.046], [0.46, 0.627, -0.046], 0.023, [24, 16, 8][lod]), 'panel', 'hardware')
    add('Stand_XBrace_Right', groups.Stand, rod([0.46, 0.043, 0.006], [-0.46, 0.627, 0.006], 0.023, [24, 16, 8][lod]), 'panel', 'hardware')
    add('Stand_XBrace_Hinge', groups.Stand, rod([0, 0.335, -0.09], [0, 0.335, 0.05], 0.034, [24, 16, 8][lod]), 'panel', 'hardware')
    for (const side of [-1, 1]) {
      const x = side * 0.46
      add(`Stand_TopRail_${side < 0 ? 'Left' : 'Right'}`, groups.Stand, rod([x, 0.631, -0.219], [x, 0.631, 0.096], 0.019, [24, 16, 8][lod]), 'panel', 'hardware')
      add(`Stand_FootRail_${side < 0 ? 'Left' : 'Right'}`, groups.Stand, rod([x, 0.021, -0.239], [x, 0.021, 0.166], 0.021, [24, 16, 8][lod]), 'panel', 'hardware')
      add(`Stand_Rubber_${side < 0 ? 'Left' : 'Right'}`, groups.Stand, merge(
        atBox(x, 0.004, -0.231, 0.052, 0.008, 0.059, 0.003), atBox(x, 0.004, 0.158, 0.052, 0.008, 0.059, 0.003),
      ), 'rubber', 'rubber')
    }
  }

  const restWorld = M.chain(M.t(0, 0.77, -0.22), M.rx(-0.18))
  const restWidth = Math.min(0.65, spec.width - 0.36)
  const rest = add('MusicRest_Board', groups.MusicRest, atBox(0, 0.144, 0, restWidth, 0.288, 0.012, 0.006), caseMat, 'drum', restWorld,
    { pivot: 'lower hinge', axis: 'x' })
  add('MusicRest_Ledge', rest, atBox(0, 0.019, 0.018, restWidth + 0.025, 0.018, 0.036, 0.003), caseMat, 'drum', restWorld)

  add('Pedals_Base', groups.Pedals, atBox(0, 0.0125, 0.2, 0.278, 0.025, 0.162, 0.005), 'plastic')
  const pedals = []
  for (const [i, name, controller] of [[-1, 'Soft', 67], [0, 'Sostenuto', 66], [1, 'Sustain', 64]]) {
    const world = M.t(i * 0.068, 0.045, 0.166)
    const actuation = { axis: 'x', angle: Math.asin(0.01 / 0.11), travel: 0.01, pivot: 'rear hinge', front: [0, 0, 0.11] }
    const pedal = add(`Pedal_${name}`, groups.Pedals, atBox(0, -0.004, 0.055, 0.032, 0.008, 0.11, 0.003), 'brass', 'hardware', world,
      { controller, actuation, labelAnchor: [0, 0.004, 0.092] })
    add(`Pedal_${name}_FootSurface`, pedal, atBox(0, 0.0005, 0.078, 0.026, 0.001, 0.034, 0.0004), 'brass', 'hardware', world)
    add(`Pedal_${name}_Hinge`, groups.Pedals, rod([i * 0.068 - 0.022, 0.038, 0.171], [i * 0.068 + 0.022, 0.038, 0.171], 0.006, [16, 12, 8][lod]), 'steel', 'hardware')
    pedals.push({ name: `Pedal_${name}`, controller, actuation })
  }
  const benchZ = 0.605
  const cushion = add('Bench_Cushion', groups.Bench, atBox(0, 0.475, benchZ, 0.56, 0.05, 0.325, 0.018), 'vinyl', 'rubber')
  add('Bench_Piping', cushion, merge(
    atBox(-0.275, 0.473, benchZ, 0.004, 0.005, 0.302, 0.001), atBox(0.275, 0.473, benchZ, 0.004, 0.005, 0.302, 0.001),
    atBox(0, 0.473, benchZ - 0.16, 0.536, 0.005, 0.004, 0.001), atBox(0, 0.473, benchZ + 0.16, 0.536, 0.005, 0.004, 0.001),
  ), 'rubber', 'rubber')
  add('Bench_Frame', groups.Bench, atBox(0, 0.447, benchZ, 0.525, 0.03, 0.288, 0.004), caseMat)
  for (const x of [-0.235, 0.235]) for (const z of [-0.119, 0.119]) {
    const name = `${x < 0 ? 'Left' : 'Right'}_${z < 0 ? 'Rear' : 'Front'}`
    add(`Bench_Leg_${name}`, groups.Bench, atBox(x, 0.226, benchZ + z, 0.038, 0.442, 0.038, 0.004), caseMat)
    add(`Bench_Foot_${name}`, groups.Bench, atBox(x, 0.004, benchZ + z, 0.041, 0.008, 0.041, 0.001), 'rubber', 'rubber')
  }
  return { root, keys, pedals, groups, whites: whites.length, blacks: blacks.length }
}

function bounds(doc, root) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  const visit = (index) => {
    const node = doc.json.nodes[index]
    if (node.mesh !== undefined) for (const primitive of doc.json.meshes[node.mesh].primitives) {
      const accessor = doc.json.accessors[primitive.attributes.POSITION]
      for (let corner = 0; corner < 8; corner++) {
        const p = M.point(doc.world[index], [0, 1, 2].map((axis) => corner & (1 << axis) ? accessor.max[axis] : accessor.min[axis]))
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], p[axis])
          max[axis] = Math.max(max[axis], p[axis])
        }
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return { min, max, size: max.map((x, i) => x - min[i]) }
}

export async function buildPianos(outDir, { maps = true } = {}) {
  await mkdir(outDir, { recursive: true })
  const manifest = {
    schemaVersion: 1, defaultVariant: 'stage_piano_88',
    axes: { units: 'metres', up: '+Y', playerRight: '+X', player: '+Z', keyDepressionAxis: '+X' },
    runtimeLooks: ['Realistic', 'ClayStudyModel', 'NeonRhythm', 'TechnicalBlueprint'],
    variants: {},
  }
  for (const [variant, spec] of Object.entries(PIANO_VARIANTS)) {
    const kit = new KitBuilder('KeyboardInstrument', materialDefinitions(), { maps })
    kit.doc.json.asset.generator = 'Mizan modular piano builder (original, dependency-free)'
    const levels = [], triangles = []
    for (let lod = 0; lod < 3; lod++) {
      kit.tris = 0
      levels.push(buildLevel(kit, variant, spec, lod))
      triangles.push(kit.tris)
      if (kit.tris > LOD_BUDGETS[lod]) throw new Error(`${variant} LOD${lod} exceeds ${LOD_BUDGETS[lod]} triangles: ${kit.tris}`)
    }
    const doc = kit.doc, main = levels[0], root = doc.json.nodes[main.root]
    root.extensions = { MSFT_lod: { ids: levels.slice(1).map((level) => level.root) } }
    const metadata = {
      instrument: { variant }, units: 'metres', up: '+Y', playerRight: '+X', player: '+Z', origin: 'floor on player centreline',
      noteRange: { low: spec.low, high: spec.high }, keyCount: spec.high - spec.low + 1, whiteKeys: main.whites, blackKeys: main.blacks,
      keybed: { playingHeight: KEY_HEIGHT, spacing: KEY_SPACING, whiteWidth: WHITE_WIDTH, whiteLength: WHITE_LENGTH, blackWidth: BLACK_WIDTH, blackLength: BLACK_LENGTH },
      dimensions: { bodyWidth: spec.width, bodyDepth: spec.depth, bodyHeight: spec.bodyHeight, benchHeight: 0.5 },
      keys: main.keys, pedals: main.pedals, looks: LOOKS,
      lod: { triangles, budgets: LOD_BUDGETS, screenCoverage: [0.35, 0.12, 0] },
      bounds: bounds(doc, main.root),
      runtime: 'Key and pedal actuation follows explicit MIDI-valued note/controller data on the shared transport. Highlights, hand/finger/note labels, chord states and guidance are applied per key at runtime. Missing fingering or pedal data is not inferred.',
      reference: 'Original unbranded instrument variant using the same modular keybed and credible real-world proportions.',
    }
    Object.assign(root.extras, metadata, { MSFT_screencoverage: [0.35, 0.12, 0] })
    doc.json.scenes = [{ name: 'KeyboardInstrument', nodes: [main.root] }]
    doc.json.extensions = { KHR_materials_variants: { variants: LOOKS.map((name) => ({ name })) } }
    doc.extensionsUsed.add('MSFT_lod')
    const bytes = doc.write(), path = join(outDir, spec.file)
    await writeFile(path, bytes)
    manifest.variants[variant] = {
      file: spec.file, name: spec.name, low: spec.low, high: spec.high,
      keys: metadata.keyCount, whiteKeys: main.whites, blackKeys: main.blacks,
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      triangles, dimensions: metadata.dimensions, bounds: metadata.bounds, pedals: main.pedals,
    }
    console.log(`${spec.file}: ${metadata.keyCount} keys (${main.whites} white / ${main.blacks} black), LOD ${triangles.join(' / ')}, ${(bytes.length / 1048576).toFixed(2)} MB`)
  }
  await writeFile(join(outDir, 'KeyboardInstruments.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  let out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models')
  let maps = true
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1] && !args[i + 1].startsWith('--')) out = resolve(args[++i])
    else if (args[i] === '--no-maps') maps = false
    else throw new Error(`Unknown or incomplete piano build argument: ${args[i]}`)
  }
  await buildPianos(out, { maps })
}
