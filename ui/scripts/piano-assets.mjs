// Validate the actual GLB files, including every primitive and every key in every LOD.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { M, readGlb, v } from './kits/gltf.mjs'

const EXPECTED = {
  digital_keyboard_61: { file: 'KeyboardDigital61.glb', low: 36, high: 96, white: 36, black: 25 },
  digital_keyboard_76: { file: 'KeyboardDigital76.glb', low: 28, high: 103, white: 45, black: 31 },
  digital_keyboard_88: { file: 'KeyboardDigital88.glb', low: 21, high: 108, white: 52, black: 36 },
  stage_piano_88: { file: 'StagePiano88.glb', low: 21, high: 108, white: 52, black: 36 },
  upright_piano_88: { file: 'UprightPiano88.glb', low: 21, high: 108, white: 52, black: 36 },
  grand_piano_88: { file: 'GrandPiano88.glb', low: 21, high: 108, white: 52, black: 36 },
}
const GROUPS = ['Case', 'Keybed', 'Controls', 'Display', 'Speakers', 'MusicRest', 'Stand', 'Pedals', 'Bench', 'OptionalPianoComponents']
const PITCHES = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B']
const WHITE = new Set([0, 2, 4, 5, 7, 9, 11])
const EPSILON = 1e-5
const approx = (a, b, tolerance = EPSILON) => Math.abs(a - b) <= tolerance
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

function accessor(doc, bin, index) {
  const a = doc.accessors[index]
  assert.ok(a, `Missing accessor ${index}`)
  const view = doc.bufferViews[a.bufferView]
  assert.ok(view && view.buffer === 0, `Invalid accessor buffer view ${index}`)
  const sizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
  const components = { 5123: [2, 'readUInt16LE'], 5125: [4, 'readUInt32LE'], 5126: [4, 'readFloatLE'] }
  const size = sizes[a.type], component = components[a.componentType]
  assert.ok(size && component, `Unsupported accessor type ${index}`)
  const [bytes, method] = component, stride = view.byteStride ?? size * bytes
  const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0)
  assert.ok(a.count > 0 && Number.isInteger(a.count), `Invalid accessor count ${index}`)
  assert.ok(start >= 0 && start + (a.count - 1) * stride + size * bytes <= bin.length, `Accessor outside binary ${index}`)
  return Array.from({ length: a.count }, (_, i) => Array.from({ length: size }, (_, j) => bin[method](start + i * stride + j * bytes)))
}

function matrix(node) {
  const q = node.rotation ?? [0, 0, 0, 1]
  assert.ok(approx(Math.hypot(...q), 1), `${node.name}: non-unit quaternion`)
  const [x, y, z, w] = q
  const rotation = [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    ...(node.translation ?? [0, 0, 0]), 1,
  ]
  assert.ok(!node.matrix && !node.scale, `${node.name}: keys must use consistent rigid local axes`)
  return rotation
}

function primitiveGeometry(doc, bin, primitive, where) {
  assert.equal(primitive.mode, 4, `${where}: triangle primitive required`)
  const positions = accessor(doc, bin, primitive.attributes.POSITION)
  const normals = accessor(doc, bin, primitive.attributes.NORMAL)
  const uv = accessor(doc, bin, primitive.attributes.TEXCOORD_0)
  const tangents = accessor(doc, bin, primitive.attributes.TANGENT)
  const indices = accessor(doc, bin, primitive.indices).flat()
  assert.equal(normals.length, positions.length, `${where}: normal count`)
  assert.equal(uv.length, positions.length, `${where}: UV count`)
  assert.equal(tangents.length, positions.length, `${where}: tangent count`)
  assert.equal(indices.length % 3, 0, `${where}: index count`)
  for (let i = 0; i < positions.length; i++) {
    assert.ok([...positions[i], ...normals[i], ...uv[i], ...tangents[i]].every(Number.isFinite), `${where}: nonfinite vertex ${i}`)
    assert.ok(approx(Math.hypot(...normals[i]), 1, 0.002), `${where}: non-unit normal ${i}`)
    assert.ok(approx(Math.hypot(...tangents[i].slice(0, 3)), 1, 0.002), `${where}: non-unit tangent ${i}`)
    assert.ok(Math.abs(v.dot(normals[i], tangents[i].slice(0, 3))) < 0.005, `${where}: tangent not perpendicular ${i}`)
  }
  const welded = new Map()
  const ids = positions.map((position) => {
    const key = position.map((x) => Math.round(x * 1e6)).join(',')
    if (!welded.has(key)) welded.set(key, welded.size)
    return welded.get(key)
  })
  const edges = new Map(), faces = new Set()
  for (let i = 0; i < indices.length; i += 3) {
    const tri = indices.slice(i, i + 3)
    assert.ok(tri.every((index) => Number.isInteger(index) && index >= 0 && index < positions.length), `${where}: bad triangle index ${i / 3}`)
    const [a, b, c] = tri.map((index) => positions[index])
    const normal = v.cross(v.sub(b, a), v.sub(c, a))
    assert.ok(v.len(normal) > 1e-12, `${where}: degenerate triangle ${i / 3}`)
    const average = tri.reduce((sum, index) => v.add(sum, normals[index]), [0, 0, 0])
    assert.ok(v.dot(normal, average) > 0, `${where}: reversed winding or normals ${i / 3}`)
    const vertices = tri.map((index) => ids[index])
    const face = vertices.slice().sort((a, b) => a - b).join(',')
    assert.ok(!faces.has(face), `${where}: duplicate triangle ${i / 3}`)
    faces.add(face)
    for (const [a, b] of [[vertices[0], vertices[1]], [vertices[1], vertices[2]], [vertices[2], vertices[0]]]) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      const edge = edges.get(key) ?? { count: 0, direction: 0 }
      edge.count++
      edge.direction += a < b ? 1 : -1
      edges.set(key, edge)
    }
  }
  const open = [...edges.values()].filter((edge) => edge.count !== 2 || edge.direction !== 0)
  assert.equal(open.length, 0, `${where}: ${open.length} open, non-manifold, or inconsistent edges`)
  return { triangles: indices.length / 3, positions }
}

function validate(doc, bin, expected, variant, { geometry = true } = {}) {
  const rootIndex = doc.scenes[doc.scene].nodes[0], root = doc.nodes[rootIndex]
  assert.equal(root.name, 'KeyboardInstrument')
  assert.equal(root.extras.instrument.variant, variant)
  assert.deepEqual(root.extras.noteRange, { low: expected.low, high: expected.high })
  assert.equal(root.extras.whiteKeys, expected.white)
  assert.equal(root.extras.blackKeys, expected.black)
  assert.equal(root.extras.units, 'metres')
  assert.equal(root.extras.up, '+Y')
  assert.equal(root.extras.player, '+Z')
  assert.ok(doc.extensionsUsed.includes('MSFT_lod'))
  assert.ok(doc.extensionsUsed.includes('KHR_materials_variants'))
  assert.equal(doc.extensions.KHR_materials_variants.variants.length, 7)
  assert.ok(doc.images.length > 0 && doc.images.every((image) => image.bufferView !== undefined && image.mimeType === 'image/png' && !image.uri))
  assert.ok(doc.buffers.length === 1 && !doc.buffers[0].uri && doc.buffers[0].byteLength <= bin.length)
  for (const image of doc.images) {
    const view = doc.bufferViews[image.bufferView]
    assert.equal(bin.subarray(view.byteOffset, view.byteOffset + 8).toString('hex'), '89504e470d0a1a0a')
  }
  const levels = [rootIndex, ...root.extensions.MSFT_lod.ids]
  assert.equal(levels.length, 3)
  const summary = []
  for (let lod = 0; lod < levels.length; lod++) {
    const seen = new Set(), named = new Map(), world = new Map()
    const visit = (index, parent = M.identity()) => {
      assert.ok(!seen.has(index), `LOD${lod}: node cycle or multiple parents`)
      seen.add(index)
      const node = doc.nodes[index]
      assert.ok(node, `LOD${lod}: missing node ${index}`)
      assert.ok(!named.has(node.name), `LOD${lod}: duplicate node name ${node.name}`)
      named.set(node.name, index)
      const mat = M.mul(parent, matrix(node))
      world.set(index, mat)
      for (const child of node.children ?? []) visit(child, mat)
    }
    visit(levels[lod])
    const groups = (doc.nodes[levels[lod]].children ?? []).map((index) => doc.nodes[index].name)
    assert.deepEqual(groups, GROUPS, `LOD${lod}: instrument hierarchy`)
    const whiteNode = doc.nodes[named.get('WhiteKeys')], blackNode = doc.nodes[named.get('BlackKeys')]
    assert.equal(whiteNode.children.length, expected.white, `LOD${lod}: white key count`)
    assert.equal(blackNode.children.length, expected.black, `LOD${lod}: black key count`)
    const materialIds = new Set(), meshes = new Set()
    const whites = Array.from({ length: expected.high - expected.low + 1 }, (_, i) => expected.low + i).filter((midi) => WHITE.has(midi % 12))
    const whiteX = (midi) => (whites.indexOf(midi) - (whites.length - 1) / 2) * 0.023
    for (let midi = expected.low; midi <= expected.high; midi++) {
      const note = `${PITCHES[midi % 12]}${Math.floor(midi / 12) - 1}`, name = `Key_${midi}_${note}`
      const index = named.get(name), node = doc.nodes[index]
      assert.ok(node, `LOD${lod}: missing ${name}`)
      const black = !WHITE.has(midi % 12), parent = black ? blackNode : whiteNode
      assert.ok(parent.children.includes(index), `${name}: wrong key group`)
      assert.equal(node.extras.midi, midi, `${name}: MIDI metadata`)
      assert.equal(node.extras.pitch, note, `${name}: pitch metadata`)
      assert.equal(node.extras.isBlack, black, `${name}: key color metadata`)
      assert.ok(!meshes.has(node.mesh), `${name}: shared key mesh`)
      meshes.add(node.mesh)
      const material = doc.meshes[node.mesh].primitives[0].material
      assert.ok(!materialIds.has(material), `${name}: shared key material`)
      materialIds.add(material)
      assert.equal(doc.materials[material].name, `MAT_${name}`)
      const neonIndex = doc.extensions.KHR_materials_variants.variants.findIndex((look) => look.name === 'NeonRhythm')
      const neonMapping = doc.meshes[node.mesh].primitives[0].extensions.KHR_materials_variants.mappings.find((mapping) => mapping.variants.includes(neonIndex))
      const neon = doc.materials[neonMapping.material]
      assert.equal(neon.name, `NeonRhythm_${name}`, `${name}: independent neon material`)
      const [red, green, blue] = neon.pbrMetallicRoughness.baseColorFactor
      const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722
      assert.ok(black ? luminance < 0.04 : luminance > 0.7, `${name}: idle neon black/white keys must remain distinct`)
      const x = black ? (whiteX(midi - 1) + whiteX(midi + 1)) / 2 : whiteX(midi)
      assert.ok(approx(node.translation[0], x), `${name}: wrong black-key grouping or key spacing`)
      assert.ok(approx(node.translation[1], black ? 0.767 : 0.75), `${name}: playing height`)
      assert.ok(approx(node.translation[2], -0.045), `${name}: rear hinge alignment`)
      const movement = node.extras.actuation, length = black ? 0.095 : 0.145
      assert.equal(movement.axis, 'x')
      assert.equal(movement.pivot, 'rear hinge')
      assert.deepEqual(movement.front, [0, 0, length])
      assert.ok(approx(movement.travel, black ? 0.007 : 0.01))
      const rest = M.point(world.get(index), movement.front)
      const pressed = M.point(M.mul(world.get(index), M.rx(movement.angle)), movement.front)
      assert.ok(approx(rest[1] - pressed[1], movement.travel), `${name}: physical front travel`)
      assert.ok(node.extras.labelAnchor[2] > 0 && node.extras.labelAnchor[2] < length, `${name}: label anchor`)
      const collider = doc.nodes[named.get(`COL_${name}`)]
      assert.equal(collider.extras.collider.surface, name, `${name}: key hitbox`)
    }
    for (const [name, controller] of [['Soft', 67], ['Sostenuto', 66], ['Sustain', 64]]) {
      const node = doc.nodes[named.get(`Pedal_${name}`)]
      assert.ok(node?.mesh !== undefined, `LOD${lod}: missing independent ${name} pedal`)
      assert.equal(node.extras.controller, controller)
      assert.equal(node.extras.actuation.axis, 'x')
      assert.ok(node.extras.actuation.angle > 0 && node.extras.actuation.angle < 0.2)
    }
    if (variant === 'upright_piano_88') assert.ok(named.has('Upright_TopLid'))
    if (variant === 'grand_piano_88') for (const name of ['Grand_CurvedRim', 'Grand_Soundboard', 'Grand_CastFrame', 'Grand_Lid', 'Grand_LidProp']) assert.ok(named.has(name))
    let triangles = 0, primitives = 0
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    for (const index of seen) {
      const node = doc.nodes[index]
      if (node.mesh === undefined) continue
      for (const primitive of doc.meshes[node.mesh].primitives) {
        const mappings = primitive.extensions?.KHR_materials_variants?.mappings
        assert.equal(mappings?.length, 7, `${node.name}: missing material looks`)
        assert.ok(mappings.every((mapping) => doc.materials[mapping.material]))
        const result = geometry ? primitiveGeometry(doc, bin, primitive, `${variant} LOD${lod} ${node.name}`)
          : { triangles: doc.accessors[primitive.indices].count / 3, positions: accessor(doc, bin, primitive.attributes.POSITION) }
        triangles += result.triangles
        primitives++
        for (const p of result.positions) {
          const position = M.point(world.get(index), p)
          for (let axis = 0; axis < 3; axis++) {
            min[axis] = Math.min(min[axis], position[axis])
            max[axis] = Math.max(max[axis], position[axis])
          }
        }
      }
    }
    assert.equal(triangles, root.extras.lod.triangles[lod])
    assert.ok(triangles <= [80000, 40000, 15000][lod], `LOD${lod}: triangle budget exceeded`)
    assert.ok(approx(min[1], 0), `LOD${lod}: floating or underground instrument`)
    assert.ok(max[2] > 0.75 && max[2] < 0.8, `LOD${lod}: bench placement`)
    assert.ok(max[0] - min[0] >= 1 && max[0] - min[0] < 1.56, `LOD${lod}: credible instrument width`)
    if (variant === 'digital_keyboard_88') {
      assert.ok(approx(max[0] - min[0], 1.4), 'Default digital piano width')
      assert.ok(max[1] >= 1.04 && max[1] < 1.1, 'Default digital piano music rest height')
    }
    if (variant === 'upright_piano_88') assert.ok(max[1] >= 1.05 && max[1] <= 1.35, 'Upright height')
    if (variant === 'grand_piano_88') assert.ok(max[2] - min[2] >= 2.2 && max[2] - min[2] <= 2.8, 'Grand case length and bench')
    summary.push({ lod, triangles, primitives, keys: meshes.size, bounds: { min, max } })
  }
  return summary
}

const args = process.argv.slice(2)
let directory = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models'), report
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--out' || args[i] === '--report') && args[i + 1] && !args[i + 1].startsWith('--')) {
    if (args[i] === '--out') directory = resolve(args[++i])
    else report = resolve(args[++i])
  } else throw new Error(`Unknown or incomplete piano validation argument: ${args[i]}`)
}
const manifest = JSON.parse(await readFile(join(directory, 'KeyboardInstruments.json'), 'utf8'))
assert.equal(manifest.defaultVariant, 'digital_keyboard_88')
assert.deepEqual(Object.keys(manifest.variants), Object.keys(EXPECTED))
const results = []
for (const [variant, expected] of Object.entries(EXPECTED)) {
  const bytes = await readFile(join(directory, expected.file))
  const { json, bin, totalLength } = readGlb(bytes)
  assert.equal(totalLength, bytes.length, `${expected.file}: complete GLB length`)
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, `${expected.file}: JSON chunk`)
  assert.equal(bytes.readUInt32LE(24 + bytes.readUInt32LE(12)), 0x004e4942, `${expected.file}: binary chunk`)
  assert.equal(manifest.variants[variant].bytes, bytes.length)
  assert.equal(manifest.variants[variant].sha256, sha(bytes))
  const levels = validate(json, bin, expected, variant)
  results.push({ variant, file: expected.file, sha256: sha(bytes), levels })
  console.log(`${expected.file}: exact MIDI/key/material/pivot/hierarchy/PBR contracts and closed geometry passed for all 3 LODs`)
}
if (report) await writeFile(report, JSON.stringify({ passed: true, assets: results }, null, 2))
console.log('All six piano variants passed. Visual reference comparison and actual runtime animation remain separate acceptance checks.')
