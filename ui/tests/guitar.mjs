import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const modelPath = (name) => fileURLToPath(new URL(`../public/models/${name}`, import.meta.url))
const FRETTED_MODEL_VARIANTS = ['Realistic', 'ClayStudyModel', 'NeonRhythm', 'TechnicalBlueprint']

function readGlb(path) {
  const bytes = readFileSync(path)
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, `${path}: GLB magic`)
  assert.equal(bytes.readUInt32LE(4), 2, `${path}: glTF 2.0`)
  assert.equal(bytes.readUInt32LE(8), bytes.length, `${path}: declared size`)
  const jsonLength = bytes.readUInt32LE(12)
  assert.equal(bytes.toString('ascii', 16, 20), 'JSON')
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength))
  const binHeader = 20 + jsonLength
  const binLength = bytes.readUInt32LE(binHeader)
  assert.equal(bytes.toString('ascii', binHeader + 4, binHeader + 8), 'BIN\u0000')
  const bin = bytes.subarray(binHeader + 8, binHeader + 8 + binLength)
  assert.equal(bin.length, json.buffers[0].byteLength, `${path}: one embedded binary buffer`)
  return { bytes, json, bin }
}

function indexNodes(asset) {
  const byName = Object.create(null)
  const parents = new Map()
  asset.json.nodes.forEach((node, index) => {
    assert.ok(!Object.hasOwn(byName, node.name), `${node.name}: unique object name`)
    byName[node.name] = index
    for (const child of node.children ?? []) parents.set(child, index)
  })
  return { byName, parents }
}

function triangleCount(asset, nodeIndices) {
  let count = 0
  for (const index of nodeIndices) {
    const mesh = asset.json.meshes[asset.json.nodes[index].mesh]
    if (mesh) for (const primitive of mesh.primitives) count += asset.json.accessors[primitive.indices].count / 3
  }
  return count
}

function accessorValues(asset, index, size) {
  const accessor = asset.json.accessors[index]
  const view = asset.json.bufferViews[accessor.bufferView]
  const bytes = accessor.componentType === 5126 ? 4 : accessor.componentType === 5125 ? 4 :
    accessor.componentType === 5123 ? 2 : 1
  const stride = view.byteStride ?? bytes * size
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const data = new DataView(asset.bin.buffer, asset.bin.byteOffset, asset.bin.byteLength)
  const read = accessor.componentType === 5126 ? (offset) => data.getFloat32(offset, true) :
    accessor.componentType === 5125 ? (offset) => data.getUint32(offset, true) :
      accessor.componentType === 5123 ? (offset) => data.getUint16(offset, true) :
        (offset) => data.getUint8(offset)
  return Array.from({ length: accessor.count }, (_, item) =>
    Array.from({ length: size }, (_, axis) => read(start + item * stride + axis * bytes)))
}

function outwardTopTriangles(asset, nodeIndex) {
  const primitive = asset.json.meshes[asset.json.nodes[nodeIndex].mesh].primitives[0]
  const positions = accessorValues(asset, primitive.attributes.POSITION, 3)
  const indices = accessorValues(asset, primitive.indices, 1).flat()
  let outward = 0, surfaces = 0
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = indices.slice(i, i + 3).map((index) => positions[index])
    if ((a[2] + b[2] + c[2]) / 3 < 0.015) continue
    const crossZ = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    if (Math.abs(crossZ) <= 1e-10) continue
    surfaces++
    if (crossZ > 0) outward++
  }
  return outward / surfaces
}

function assertOutwardSurfaces(asset, node) {
  const primitive = asset.json.meshes[node.mesh].primitives[0]
  const positions = accessorValues(asset, primitive.attributes.POSITION, 3)
  const normals = accessorValues(asset, primitive.attributes.NORMAL, 3)
  const indices = accessorValues(asset, primitive.indices, 1).flat()
  let outward = 0, surfaces = 0
  for (let i = 0; i < indices.length; i += 3) {
    const ids = indices.slice(i, i + 3)
    const [a, b, c] = ids.map((index) => positions[index])
    const ab = b.map((value, axis) => value - a[axis])
    const ac = c.map((value, axis) => value - a[axis])
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]]
    if (Math.hypot(...cross) < 1e-12) continue
    const normal = [0, 1, 2].map((axis) => ids.reduce((sum, index) => sum + normals[index][axis], 0))
    surfaces++
    if (cross.reduce((sum, value, axis) => sum + value * normal[axis], 0) > 0) outward++
  }
  assert.ok(outward / surfaces > 0.99,
    `${node.name}: ${(outward / surfaces * 100).toFixed(1)}% of surfaces match their outward normals`)
}

function descendants(asset, roots) {
  const result = []
  const visit = (index) => {
    result.push(index)
    for (const child of asset.json.nodes[index].children ?? []) visit(child)
  }
  roots.forEach(visit)
  return result
}

function multiply4(a, b) {
  const out = new Array(16).fill(0)
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++)
    for (let axis = 0; axis < 4; axis++) out[column * 4 + row] += a[axis * 4 + row] * b[column * 4 + axis]
  return out
}

function nodeMatrix(node) {
  if (node.matrix) return node.matrix
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = node.scale ?? [1, 1, 1]
  const [tx, ty, tz] = node.translation ?? [0, 0, 0]
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ]
}

function worldMatrix(asset, index, parents) {
  const chain = []
  for (let current = index; current !== undefined; current = parents.get(current)) chain.push(current)
  return chain.reverse().reduce((world, current) => multiply4(world, nodeMatrix(asset.json.nodes[current])),
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
}

function worldPoints(asset, index, accessor, parents) {
  const matrix = worldMatrix(asset, index, parents)
  return accessorValues(asset, accessor, 3).map(([x, y, z]) => [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ])
}

function meshWorldPoints(asset, index, parents) {
  const node = asset.json.nodes[index]
  return asset.json.meshes[node.mesh].primitives.flatMap((primitive) =>
    worldPoints(asset, index, primitive.attributes.POSITION, parents))
}

function bounds(asset, roots) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  const visit = (index, parent = [0, 0, 0]) => {
    const node = asset.json.nodes[index]
    const local = node.translation ?? [0, 0, 0]
    const world = parent.map((value, axis) => value + local[axis])
    if (node.mesh !== undefined) for (const primitive of asset.json.meshes[node.mesh].primitives) {
      const position = asset.json.accessors[primitive.attributes.POSITION]
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], world[axis] + position.min[axis])
        max[axis] = Math.max(max[axis], world[axis] + position.max[axis])
      }
    }
    for (const child of node.children ?? []) visit(child, world)
  }
  roots.forEach((root) => visit(root))
  return { min, max, size: max.map((value, axis) => value - min[axis]) }
}

function sceneNodes(asset) {
  return descendants(asset, asset.json.scenes[asset.json.scene ?? 0].nodes)
}

function assertAsset(file, kind, config, expected) {
  const asset = readGlb(modelPath(file))
  const { json } = asset
  assert.equal(json.asset.generator, 'Mizan fretted instrument builder')
  assert.equal(json.buffers.length, 1)
  assert.ok(!json.buffers[0].uri && json.images.every((image) => !image.uri && image.bufferView !== undefined),
    `${kind}: model and textures are self-contained`)
  assert.deepEqual(json.extensions.KHR_materials_variants.variants.map((variant) => variant.name), FRETTED_MODEL_VARIANTS)
  const variantIndices = FRETTED_MODEL_VARIANTS.map((_look, index) => index)
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    const mappings = primitive.extensions?.KHR_materials_variants?.mappings ?? []
    assert.deepEqual(mappings.flatMap((mapping) => mapping.variants).sort((a, b) => a - b), variantIndices,
      `${kind}: every primitive maps all shared appearances exactly once`)
    assert.ok(mappings.every((mapping) => mapping.material < json.materials.length),
      `${kind}: every appearance maps to a material`)
  }
  for (const image of json.images) {
    const view = json.bufferViews[image.bufferView]
    const offset = view.byteOffset ?? 0
    assert.ok(asset.bin.subarray(offset, offset + 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    const width = asset.bin.readUInt32BE(offset + 16)
    const height = asset.bin.readUInt32BE(offset + 20)
    if (/sunburst-or-maple|maple|dark-wood/.test(image.name)) assert.deepEqual([width, height], [2048, 2048])
  }
  const { byName, parents } = indexNodes(asset)
  assert.equal(byName.Body_BackSurface, undefined, `${kind}: no rectangular rear panel protrudes past the body silhouette`)
  const root = byName[kind === 'guitar' ? 'ElectricGuitar' : 'ElectricBass']
  assert.notEqual(root, undefined)
  const rootExtras = json.nodes[root].extras
  assert.deepEqual(rootExtras.stylePresets, FRETTED_MODEL_VARIANTS)
  assert.equal(rootExtras.instrument, kind)
  assert.equal(rootExtras.scaleLength, config.scaleLength)
  assert.equal(rootExtras.playableFrets, config.frets)
  assert.deepEqual(rootExtras.strings.map((string) => string.midi), config.strings.map((string) => string.midi))
  for (const name of ['Body', 'Neck', 'Headstock', 'Pickups', 'Bridge', 'Controls', 'Hardware', 'Strings'])
    assert.equal(parents.get(byName[name]), root, `${kind}: ${name} is independently grouped`)

  const positionNames = []
  for (const string of config.strings) for (let fret = 0; fret <= config.frets; fret++) {
    const name = `Position_S${string.string}_F${fret}`
    positionNames.push(name)
    const index = byName[name]
    assert.notEqual(index, undefined, `${kind}: ${name} exists`)
    const extra = json.nodes[index].extras
    assert.equal(extra.stringObject, `String_${string.string}_${string.name.replaceAll(' ', '')}`)
    assert.equal(extra.conventionalStringNumber, string.conventionalStringNumber)
    assert.equal(extra.fret, fret)
    assert.equal(extra.midiNote, string.midi + fret)
    const expectedX = fret === 0 ? config.scaleLength
      : config.scaleLength * (2 ** (-(fret - 1) / 12) + 2 ** (-fret / 12)) / 2
    assert.ok(Math.abs(extra.fretboardCoordinate - expectedX) < 1e-8,
      `${kind}: ${name} sits at the nut or inside its correct fret space`)
  }
  assert.equal(positionNames.length, expected.strings * (config.frets + 1))
  const stringNodes = json.nodes.filter((node) => /^String_\d+_/.test(node.name))
  assert.equal(stringNodes.length, expected.strings)
  assert.equal(json.nodes.filter((node) => /^Tuner_\d+_/.test(node.name) && node.extras?.stringNumber).length,
    expected.strings, `${kind}: every string has its own tuner pivot`)
  const stringRowsAtNut = []
  const tunerEvidence = []
  for (const node of stringNodes) {
    assertOutwardSurfaces(asset, node)
    assert.equal(node.extras.deformable, true)
    assert.equal(node.extras.vibration.model, 'pinned-sine')
    assert.equal(node.extras.vibration.envelope, 'zero-at-selected-fret-and-bridge')
    const primitive = json.meshes[node.mesh].primitives[0]
    const position = json.accessors[primitive.attributes.POSITION]
    assert.ok(position.max[0] > config.scaleLength && position.max[0] < config.scaleLength + 0.15,
      `${kind}: ${node.name} reaches its headstock tuner, not a point on the body`)
    const points = meshWorldPoints(asset, byName[node.name], parents)
    const minX = Math.min(...points.map((point) => point[0]))
    const maxX = Math.max(...points.map((point) => point[0]))
    const atX = (target) => {
      const distance = Math.min(...points.map((point) => Math.abs(point[0] - target)))
      return points.filter((point) => Math.abs(point[0] - target) <= distance + 1e-5)
    }
    const average = (items) => [0, 1, 2].map((axis) =>
      items.reduce((sum, point) => sum + point[axis], 0) / items.length)
    const start = average(points.filter((point) => point[0] < minX + 1e-5))
    const nut = average(atX(config.scaleLength))
    const end = average(points.filter((point) => point[0] > maxX - 1e-5))
    assert.ok(Math.abs(start[0]) < 0.001, `${kind}: ${node.name} has one continuous run from its bridge end`)
    stringRowsAtNut.push(nut[1])
    const stringNumber = node.extras.stringNumber
    const tunerName = `Tuner_${stringNumber}_${config.strings[stringNumber - 1].name.replaceAll(' ', '')}`
    assert.equal(json.nodes[byName[tunerName]].extras.stringObject, node.name,
      `${kind}: tuner ${stringNumber} is explicitly assigned to ${node.name}`)
    const tuner = json.nodes[byName[tunerName]]
    const postIndex = tuner.children.find((child) => json.nodes[child].name.endsWith('_Post'))
    const buttonIndex = tuner.children.find((child) => json.nodes[child].name.endsWith('_Button'))
    assert.notEqual(postIndex, undefined, `${kind}: tuner ${stringNumber} has its own post`)
    assert.notEqual(buttonIndex, undefined, `${kind}: tuner ${stringNumber} has its own button`)
    const post = meshWorldPoints(asset, postIndex, parents)
    const button = meshWorldPoints(asset, buttonIndex, parents)
    const postCenter = average(post)
    const buttonCenter = average(button)
    const postRadius = Math.max(...post.map((point) => Math.hypot(point[0] - postCenter[0], point[1] - postCenter[1])))
    const endpointDistance = Math.hypot(end[0] - postCenter[0], end[1] - postCenter[1], end[2] - postCenter[2])
    assert.ok(endpointDistance < postRadius * 0.8,
      `${kind}: ${node.name} ends through its own tuner post (${endpointDistance.toFixed(5)} m from post center)`)
    assert.ok(Math.hypot(buttonCenter[0] - postCenter[0], buttonCenter[2] - postCenter[2]) < 0.0015 &&
      Math.abs(buttonCenter[1] - postCenter[1]) > 0.012,
    `${kind}: tuner ${stringNumber} button is attached beside its own post`)
    const buttonSide = Math.sign(buttonCenter[1] - postCenter[1])
    assert.equal(buttonSide, kind === 'guitar' ? 1 : Math.sign(postCenter[1]),
      `${kind}: tuner ${stringNumber} button is on the outward side of its headstock`)
    tunerEvidence.push({ string: stringNumber, endpointToPostMeters: endpointDistance,
      buttonOffsetMeters: Math.abs(buttonCenter[1] - postCenter[1]) })
  }
  assert.ok(stringRowsAtNut.every((value, index) => index === 0 || stringRowsAtNut[index - 1] > value),
    `${kind}: distinct string runs cross the nut in the expected low-to-high order`)
  for (const node of json.nodes.filter((node) =>
    /^Fret_\d{2}$|^Knob_.*_(Seat|Base|Cap)$|^Tuner_\d+_(Post|Button)$|^Pickup_/.test(node.name)))
    assertOutwardSurfaces(asset, node)
  const fretCrowns = json.nodes.filter((node) => /^Fret_\d{2}$/.test(node.name)).map((node) => {
    const points = meshWorldPoints(asset, byName[node.name], parents)
    return { x: (Math.min(...points.map((p) => p[0])) + Math.max(...points.map((p) => p[0]))) / 2,
      z: Math.max(...points.map((p) => p[2])) }
  })
  for (const node of json.nodes.filter((node) => /^String_\d_/.test(node.name))) {
    const points = meshWorldPoints(asset, byName[node.name], parents)
    for (const crown of fretCrowns) {
      const near = points.filter((p) => Math.abs(p[0] - crown.x) < 0.007)
      const height = near.reduce((sum, p) => sum + p[2], 0) / near.length - crown.z
      assert.ok(near.length && height > 0.0013 && height < 0.005,
        `${kind}: ${node.name} clears the fret crown at x=${crown.x.toFixed(3)} (${(height * 1000).toFixed(1)} mm)`)
    }
  }
  const heelTop = bounds(asset, [byName.Neck_Heel]).max[2]
  const pickupBottom = bounds(asset, [byName.Pickup_Neck_Cover ?? byName.Pickup_Neck_Half1]).min[2]
  assert.ok(heelTop < pickupBottom, `${kind}: the neck heel does not hide the neck pickup`)
  const frets = json.nodes.filter((node) => /^Fret_\d{2}$/.test(node.name))
  assert.equal(frets.length, config.frets)
  const fret12 = json.nodes[byName.Fret_12]
  const fret12Position = json.accessors[json.meshes[fret12.mesh].primitives[0].attributes.POSITION]
  const neck = json.nodes[byName.Neck]
  const exactX = (neck.translation?.[0] ?? 0) + (fret12.translation?.[0] ?? 0) +
    (fret12Position.min[0] + fret12Position.max[0]) / 2
  assert.ok(Math.abs(exactX - config.scaleLength / 2) < 1e-6, `${kind}: fret 12 is at half scale length`)
  assert.equal(json.nodes[byName[`Tuner_1_${config.strings[0].name.replaceAll(' ', '')}`]].extras.stringNumber, 1)
  for (const name of ['COL_Body', 'COL_Neck', 'COL_Fretboard', 'COL_Headstock', 'COL_Bridge'])
    assert.notEqual(byName[name], undefined, `${kind}: named lightweight collision ${name}`)
  const rootChildren = sceneNodes(asset)
  const level0 = triangleCount(asset, rootChildren)
  const body0 = triangleCount(asset, [byName.Body_Mesh])
  const body1 = triangleCount(asset, [byName.Body_Mesh_LOD1])
  const body2 = triangleCount(asset, [byName.Body_Mesh_LOD2])
  const lod = [level0, level0 - body0 + body1, level0 - body0 + body2]
  for (const [index, [minimum, maximum]] of [[0, [80000, 160000]], [1, [35000, 80000]], [2, [12000, 30000]]])
    assert.ok(lod[index] >= minimum && lod[index] <= maximum, `${kind}: LOD${index} has ${lod[index]} triangles`)
  const modelBounds = bounds(asset, json.scenes[json.scene ?? 0].nodes)
  const bodyBounds = bounds(asset, [byName.Body_Mesh])
  const pickguardBounds = bounds(asset, [byName.Pickguard])
  assert.ok(bodyBounds.size[0] >= 0.43 && bodyBounds.size[0] <= 0.54,
    `${kind}: sculpted body length ${bodyBounds.size[0].toFixed(3)} m`)
  assert.ok(pickguardBounds.size[0] < 0.35 && pickguardBounds.size[1] < 0.24,
    `${kind}: the pickguard leaves a visible sunburst body perimeter`)
  const outward = outwardTopTriangles(asset, byName.Body_Mesh)
  assert.ok(outward > 0.95,
    `${kind}: ${(outward * 100).toFixed(1)}% of the domed top faces outward; expected more than 95%`)
  const bodyPrimitive = json.meshes[json.nodes[byName.Body_Mesh].mesh].primitives[0]
  const bodyUvs = accessorValues(asset, bodyPrimitive.attributes.TEXCOORD_0, 2)
  for (const axis of [0, 1]) {
    assert.ok(Math.min(...bodyUvs.map((uv) => uv[axis])) < 0.01 &&
      Math.max(...bodyUvs.map((uv) => uv[axis])) > 0.99,
    `${kind}: the body uses the full sunburst texture on axis ${axis}`)
  }
  assert.ok(Math.abs(bodyBounds.size[1] - expected.bodyWidth) < 0.012, `${kind}: body width ${bodyBounds.size[1].toFixed(3)} m`)
  assert.ok(Math.abs(bodyBounds.size[2] - expected.thickness) < 0.006, `${kind}: body thickness ${bodyBounds.size[2].toFixed(3)} m`)
  assert.ok(Math.abs(modelBounds.size[0] - expected.overall) <= expected.overall * 0.01,
    `${kind}: overall length ${modelBounds.size[0].toFixed(3)} m`)
  for (const name of ['Camera', 'Light', 'Floor', 'Logo', 'Brand'])
    assert.ok(!json.nodes.some((node) => node.name.toLowerCase().includes(name.toLowerCase())), `${kind}: no ${name} object`)
  return { kind, bytes: asset.bytes.length, nodes: json.nodes.length, meshes: json.meshes.length,
    strings: stringNodes.length, positions: positionNames.length, lod, dimensions: modelBounds.size,
    bodyWidth: bodyBounds.size[1], bodyThickness: bodyBounds.size[2],
    tunerAlignment: {
      maxEndpointToOwnPostMeters: Math.max(...tunerEvidence.map((item) => item.endpointToPostMeters)),
      minButtonOffsetMeters: Math.min(...tunerEvidence.map((item) => item.buttonOffsetMeters)),
    },
    images: json.images.map((image) => image.name) }
}

globalThis.matchMedia = () => ({ matches: false })
const vite = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
})
let report
let barreEvidence
try {
  const {
    GUITAR, BASS, mapFrettedNote, positionsForMidi, planFrettedTab,
    identifiesInstrument, measureAtBeat, notesByMeasure, notesForTrack, positionForStringFret, frettedPitchName,
    fretDistanceFromNut,
  } = await vite.ssrLoadModule('/src/workspace/fretboard.ts')
  const { LOOKS } = await vite.ssrLoadModule('/src/workspace/prefs.ts')
  const { FRETTED_LOOKS, styleIndex, normalizeFrettedStyle } = await vite.ssrLoadModule('/src/workspace/frettedStyles.ts')
  const { planFrettedHand, selectHandNotes } = await vite.ssrLoadModule('/src/workspace/frettedHand.ts')
  const { decodeFrettedHand, poseFrettedHand } = await vite.ssrLoadModule('/src/workspace/frettedHandAsset.ts')
  const { FrettedRenderer, frettedStringDisplayThicknessPx } = await vite.ssrLoadModule('/src/workspace/frettedRenderer.ts')
  const { buildSong } = await vite.ssrLoadModule('/src/workspace/song.ts')
  assert.deepEqual(LOOKS, ['Realistic', 'ClayStudyModel', 'NeonRhythm', 'TechnicalBlueprint'],
    'Piano and drums keep the shared four-look list')
  assert.deepEqual(FRETTED_LOOKS, ['Realistic', 'ClayStudyModel', 'TechnicalBlueprint'])
  assert.deepEqual(GUITAR.styles, FRETTED_LOOKS)
  assert.deepEqual(BASS.styles, FRETTED_LOOKS)
  assert.equal(styleIndex('TechnicalBlueprint'), 3, 'Blueprint keeps its original GLB material-variant index')
  assert.equal(normalizeFrettedStyle('NeonRhythm'), 'Realistic', 'A retired fretted Neon value falls back only at the fretted boundary')
  assert.equal(frettedStringDisplayThicknessPx(0.01, 0.01, 0.046), 2.8)
  assert.equal(frettedStringDisplayThicknessPx(0.046, 0.01, 0.046), 4.5,
    'Rendered strings keep a 2.8–4.5 CSS-pixel gauge range at every viewport size')
  assert.equal(GUITAR.scaleLength, 0.6477)
  assert.equal(GUITAR.frets, 22)
  assert.deepEqual(GUITAR.strings.map((string) => string.midi), [40, 45, 50, 55, 59, 64])
  assert.deepEqual(BASS.strings.map((string) => string.midi), [28, 33, 38, 43])
  assert.equal(frettedPitchName(37), 'C♯2')
  const bassCSharp = mapFrettedNote(37, BASS)
  assert.deepEqual([bassCSharp?.string, bassCSharp?.fret, bassCSharp?.pitchName], [2, 4, 'C♯2'],
    'MIDI 37 is C-sharp 2 at fret 4 of standard bass A1')
  const guitarCSharp = planFrettedTab([{ midi: 37, startBeat: 0, beats: 1 }], GUITAR)[0]
  assert.equal(guitarCSharp.reason, 'outside-range',
    'MIDI 37 stays outside standard guitar range; it is not octave-shifted or given a fake fret')
  assert.equal(guitarCSharp.position, undefined)
  const routedPitch = { ...buildSong(), instrumentNotes: {
    guitar: [{ midi: 37, startBeat: 0, beats: 1 }],
    bass: [{ midi: 37, startBeat: 0, beats: 1 }],
  } }
  assert.equal(notesForTrack(routedPitch, { id: 'bass', instrument: 'other' })[0].midi, 37,
    'The bass part reads its own MIDI notes')
  assert.deepEqual(planFrettedTab(notesForTrack(routedPitch, { id: 'bass', instrument: 'other' }), BASS)[0].position,
    bassCSharp, 'The routed bass note is evaluated against bass tuning and frets')
  assert.equal(planFrettedTab(notesForTrack(routedPitch, { id: 'guitar', instrument: 'other' }), GUITAR)[0].reason,
    'outside-range', 'The same MIDI pitch remains unplayable on standard guitar')
  assert.equal(BASS.frets, 20)
  const rendererByKind = new Map()
  for (const [config, file] of [[GUITAR, 'ElectricGuitar.glb'], [BASS, 'ElectricBass.glb']]) {
    const asset = readGlb(modelPath(file))
    const { byName, parents } = indexNodes(asset)
    const renderer = Object.create(FrettedRenderer.prototype)
    Object.assign(renderer, {
      config, stringCenterlines: new Map(), stringGuideKey: '', cachedStringGuides: [],
      instrumentBounds: { minX: 0, maxX: config.scaleLength, minY: -0.04, maxY: 0.04, minZ: 0, maxZ: 0.12 },
      items: config.strings.map((string) => ({
        string: string.string,
        frame: nodeMatrix({}),
        data: Float32Array.from(meshWorldPoints(asset,
          byName[`String_${string.string}_${string.name.replaceAll(' ', '')}`], parents)
          .flatMap((point) => [...point, 0, 0, 1, 0, 0])),
      })),
    })
    renderer.findStringCenterlines()
    rendererByKind.set(config.id, renderer)
    for (const handedness of ['right', 'left']) for (const [width, height] of [[780, 350], [342, 350]]) {
      renderer.silhouette = [-0.2, config.scaleLength + 0.16].flatMap((x) => [-0.16, 0.16].flatMap((y) =>
        [-0.03, 0.06].map((z) => [x, y, z])))
      renderer.mirrorFitCache = null
      renderer.pose(handedness, width, height)
      const guides = renderer.stringGuides(width, height, null)
      assert.equal(guides.length, config.strings.length)
      assert.equal(renderer.stringGuides(width, height, null), guides,
        'An unchanged camera and grip reuse their guide paths')
      for (const guide of guides) {
        assert.deepEqual(guide.hidden, [], 'Without a hand, every string guide stays solid')
        assert.equal(guide.visible.length, 1)
        const points = guide.visible[0].split(' ').map((point) => point.split(',').map(Number))
        const [first, last] = [points[0], points.at(-1)]
        const span = Math.hypot(last[0] - first[0], last[1] - first[1])
        assert.ok(span > width / 4, `${config.id} ${handedness}: the guide covers the teaching frame`)
        for (const [x, y] of points) {
          const distance = Math.abs((last[0] - first[0]) * (y - first[1]) -
            (last[1] - first[1]) * (x - first[0])) / span
          assert.ok(distance < 0.15,
            `${config.id} ${handedness}: string ${guide.string} is straight, not a staircase`)
        }
        const x = config.scaleLength * 0.813579
        assert.equal(renderer.stringPointAtX(guide.string, x)[0], x,
          'Contact locations follow the requested fret coordinate rather than a mesh ring')
      }
      const stringPoint = renderer.stringPointAtX(1, config.scaleLength * 0.85)
      const target = [(renderer.teachingFrame.startX + renderer.teachingFrame.endX) / 2,
        handedness === 'right' ? -0.018 : 0.018, 0.035]
      const direction = renderer.cameraPosition.map((value, axis) => value - target[axis])
      const magnitude = Math.hypot(...direction)
      const triangleAt = (distance) => ({
        skin: Float32Array.from([[-0.03, -0.03, 0], [0.03, -0.03, 0], [0, 0.04, 0]]
          .flatMap((offset) => [
            ...stringPoint.map((value, axis) => value + direction[axis] / magnitude * distance + offset[axis]),
            0, 0, 1, 0, 0,
          ])),
        skinIndices: Uint16Array.from([0, 1, 2]),
      })
      assert.equal(renderer.handOcclusion(width, height, triangleAt(0.025))(stringPoint), true,
        `${config.id} ${handedness}: a hand surface in front hides the string without touching it`)
      assert.equal(renderer.handOcclusion(width, height, triangleAt(-0.025))(stringPoint), false,
        `${config.id} ${handedness}: a hand behind the string does not hide it`)
      assert.equal(renderer.handOcclusion(width, height, triangleAt(0.025))([
        stringPoint[0] + 0.12, stringPoint[1], stringPoint[2],
      ]), false, 'String points outside the projected hand silhouette remain solid')
    }
    for (const handedness of ['right', 'left']) for (const [width, height] of [[780, 390], [342, 430]]) {
      renderer.silhouette = [-0.2, config.scaleLength + 0.16].flatMap((x) => [-0.16, 0.16].flatMap((y) =>
        [-0.03, 0.06].map((z) => [x, y, z])))
      renderer.mirrorFitCache = null
      renderer.pose(handedness, width, height)
      const at = (x, y = 0) => renderer.projected([x, y, 0.05], width, height)
      const nut = at(config.scaleLength)
      const bridge = at(0)
      const lowE = renderer.stringPointAtX(1, config.scaleLength / 2)
      const highE = renderer.stringPointAtX(config.strings.length, config.scaleLength / 2)
      const lowScreen = at(lowE[0], lowE[1]), highScreen = at(highE[0], highE[1])
      assert.ok(handedness === 'right' ? nut[0] < bridge[0] : nut[0] > bridge[0],
        `${config.id} ${handedness}: the neck points to the ${handedness === 'right' ? 'left' : 'right'} of the mirror`)
      assert.ok(nut[1] < bridge[1], `${config.id} ${handedness}: the neck rises toward the headstock`)
      const rise = Math.atan2(bridge[1] - nut[1], Math.abs(bridge[0] - nut[0])) * 180 / Math.PI
      assert.ok(rise > 10 && rise < 32, `${config.id} ${handedness}: the neck rises about 15-25 degrees, got ${rise}`)
      assert.ok(lowScreen[1] < highScreen[1], `${config.id} ${handedness}: the low string is above the high string`)
      const fretGap = (a, b) => Math.hypot(...[0, 1].map((axis) => at(config.scaleLength * 2 ** (-a / 12))[axis] -
        at(config.scaleLength * 2 ** (-b / 12))[axis]))
      assert.ok(fretGap(1, 2) > fretGap(12, 13),
        `${config.id} ${handedness}: the full-board mirror retains narrowing physical fret spacing`)
      assert.ok(Math.abs(renderer.viewProjection[3]) + Math.abs(renderer.viewProjection[7]) < 0.6 &&
        renderer.perspectiveW > 1.5, `${config.id} ${handedness}: the mirror uses a long, weak-perspective lens`)
    }
  }
  for (const [config, expected] of [[GUITAR, [40, 64]], [BASS, [28, 43]]]) {
    const low = mapFrettedNote(expected[0], config)
    const high = mapFrettedNote(expected[1], config)
    assert.deepEqual([low.string, low.fret, low.conventionalStringNumber], [1, 0, config.strings.length])
    assert.deepEqual([high.string, high.fret, high.conventionalStringNumber], [config.strings.length, 0, 1])
    assert.equal(low.fretboardCoordinate, config.scaleLength, 'An open string marker sits at the nut')
    for (let fret = 1; fret <= config.frets; fret++) {
      const position = positionForStringFret(1, fret, config)
      assert.ok(position.fretboardCoordinate > config.scaleLength * 2 ** (-fret / 12) &&
        position.fretboardCoordinate < config.scaleLength * 2 ** (-(fret - 1) / 12),
      `Fret ${fret} highlights its own space, not the following fret`)
    }
  }
  assert.ok(positionsForMidi(64, GUITAR).some((position) => position.string === 6 && position.fret === 0))
  const chord = planFrettedTab([64, 67, 71, 60].map((midi) => ({ midi, startBeat: 0, beats: 1 })), GUITAR)
  assert.ok(chord.every((note) => note.position))
  assert.equal(new Set(chord.map((note) => note.position.string)).size, chord.length)
  const impossible = planFrettedTab(Array.from({ length: 7 }, () => ({ midi: 64, startBeat: 0, beats: 1 })), GUITAR)
  assert.ok(impossible.some((note) => note.reason === 'no-distinct-string'))
  const authoredChord = planFrettedTab([
    { midi: 41, startBeat: 0, beats: 1, string: 1, fret: 1, finger: 1 },
    { midi: 48, startBeat: 0, beats: 1, string: 2, fret: 3, finger: 3 },
    { midi: 53, startBeat: 0, beats: 1, string: 3, fret: 3, finger: 3 },
    { midi: 57, startBeat: 0, beats: 1, string: 4, fret: 2, finger: 2 },
  ], GUITAR)
  const handChord = planFrettedHand(authoredChord, GUITAR)
  assert.equal(handChord.unavailable, false)
  assert.deepEqual(handChord.contacts.map((contact) => contact.finger), [1, 3, 3, 2],
    'Authored fingers remain assigned to their exact fretted notes')
  assert.ok(handChord.contacts[1].barre && handChord.contacts[2].barre,
    'Two notes on the same fret can use one barre finger')
  const guitarRenderer = rendererByKind.get(GUITAR.id)
  // A let-ring arpeggio like an imported fingerpicking part: notes overlap, an open onset releases a fretted string,
  // and held high notes would be a wide stretch if every sounding note had to be fretted at once.
  const letRing = [[6, 7, 0, 2], [4, 1, 0.5, 2], [6, 0, 1, 1.5], [5, 2, 1.5, 2.5], [6, 5, 2, 2], [3, 0, 2.5, 3],
    [4, 2, 3, 2], [6, 7, 3.5, 1], [2, 0, 4, 4], [5, 1, 4.5, 2.5], [6, 0, 5, 1], [4, 2, 5.5, 2], [3, 3, 6, 2],
    [6, 8, 6.5, 1.5], [4, 1, 7, 1], [5, 3, 7.5, 0.5]]
  const letRingPlan = planFrettedTab(letRing.map(([string, fret, startBeat, beats]) => ({
    midi: GUITAR.strings[string - 1].midi + fret, string, fret, startBeat, beats,
  })), GUITAR)
  assert.ok(letRingPlan.every((note) => note.position), 'The let-ring fixture places every note')
  let oldUnavailable = 0, newUnavailable = 0, samples = 0
  for (let beat = 0; beat < 8; beat += 0.125) {
    const sounding = letRingPlan.filter((note) => note.startBeat <= beat + 1e-8 && beat < note.startBeat + note.beats - 1e-8)
    const all = sounding.filter((note) => note.position.fret > 0)
    samples++
    if (all.length && planFrettedHand(all, GUITAR).unavailable) oldUnavailable++
    const picked = selectHandNotes(sounding, GUITAR)
    if (picked.unavailable || (picked.notes.length && planFrettedHand(picked.notes, GUITAR).unavailable)) newUnavailable++
  }
  console.log(`Let-ring fixture: no-grip frames ${(oldUnavailable / samples * 100).toFixed(0)}% before, ${(newUnavailable / samples * 100).toFixed(0)}% after`)
  assert.ok(oldUnavailable / samples > 0.3, 'Requiring every sounding note to be fretted at once often fails on let-ring music')
  assert.ok(newUnavailable / samples < 0.05, 'Fretting only what a player would fret keeps nearly every frame playable')
  guitarRenderer.pose('right', 780, 350)
  const modelContacts = (grip, notes, config = GUITAR) => grip.contacts.flatMap((contact) => {
    const note = notes.find((item) => item.index === contact.index)
    if (!note?.position) return []
    const center = rendererByKind.get(config.id).stringPointAtX(contact.string, note.position.fretboardCoordinate)
    const radius = config.strings[contact.string - 1].gaugeInches * 0.0254 / 2
    return [{ ...contact, center, surface: [center[0], center[1], center[2] + radius], radius }]
  })
  const leftHand = decodeFrettedHand(readGlb(modelPath('FrettingLeftHand.glb')).bytes)
  const rightHand = decodeFrettedHand(readGlb(modelPath('FrettingRightHand.glb')).bytes)
  for (const [side, hand] of [['left', leftHand], ['right', rightHand]]) {
    const source = readGlb(modelPath(`Fretting${side === 'left' ? 'Left' : 'Right'}Hand.glb`))
    const skin = source.json.skins[0]
    const primitive = source.json.meshes[source.json.nodes.find((node) => node.skin === 0).mesh].primitives[0]
    assert.equal(skin.joints.length, 25, `${side} hand maps the complete source skeleton by name`)
    assert.equal(source.json.accessors[skin.inverseBindMatrices].type, 'MAT4',
      `${side} inverse-bind matrices retain all sixteen components`)
    assert.equal(source.json.accessors[primitive.attributes.JOINTS_0].componentType, 5121,
      `${side} joint indices use the source Uint8 accessor`)
    assert.equal(source.json.accessors[primitive.attributes.WEIGHTS_0].componentType, 5126,
      `${side} skin weights use the source float accessor`)
    assert.deepEqual(hand.fingers.map((finger) => finger.bones[0]), [
      'index-finger-metacarpal', 'middle-finger-metacarpal',
      'ring-finger-metacarpal', 'pinky-finger-metacarpal',
    ], `${side} identity labels are assigned by finger name, not GLB joint order`)
    assert.equal(hand.meshTriangles, 2314, `${side} uses the connected skinned mesh`)
    assert.ok(hand.weights.every((_, index) => index % 4 !== 3 ||
      Math.abs(hand.weights[index - 3] + hand.weights[index - 2] +
        hand.weights[index - 1] + hand.weights[index] - 1) < 1e-4),
    `${side} preserves normalized skin weights`)
  }
  const poseCases = () => {
    const note = (midi, string, fret, finger) => ({ midi, string, fret, finger, startBeat: 0, beats: 1 })
    return [
      ['guitar', GUITAR, 'single', planFrettedTab([note(43, 1, 3, 3)], GUITAR)],
      ['guitar', GUITAR, 'barre', planFrettedTab([note(41, 1, 1, 1), note(48, 2, 3, 3), note(53, 3, 3, 3),
        note(57, 4, 2, 2), note(60, 5, 1, 1), note(65, 6, 1, 1)], GUITAR)],
      ['guitar', GUITAR, 'mixed', authoredChord],
      ['bass', BASS, 'single', planFrettedTab([note(36, 2, 3, 3)], BASS)],
      ['bass', BASS, 'barre', planFrettedTab([note(29, 1, 1, 1), note(34, 2, 1, 1), note(39, 3, 1, 1),
        note(44, 4, 1, 1)], BASS)],
      ['bass', BASS, 'mixed', planFrettedTab([note(29, 1, 1, 1), note(36, 2, 3, 3), note(41, 3, 3, 3),
        note(45, 4, 2, 2)], BASS)],
    ]
  }
  const fingerNames = ['index', 'middle', 'ring', 'pinky']
  const feasible = new Set(['guitar single left', 'guitar single right', 'bass single left', 'bass single right',
    'guitar barre left', 'guitar mixed left', 'guitar mixed right', 'bass barre left'])
  const meshLengths = new Map()
  const poseMatrix = []
  for (const [instrument, config, shape, plan] of poseCases())
    for (const [meshName, mesh] of [['left', leftHand], ['right', rightHand]]) {
      const key = `${instrument} ${shape} ${meshName}`
      const pose = poseFrettedHand(mesh, modelContacts(planFrettedHand(plan, config), plan, config), 'pressed')
      const gaps = pose.contactTips.map((contact) => contact.gap)
      const valid = gaps.every((gap) => gap <= 0.0035) && pose.thumbBehind && pose.penetration <= 0.003 && pose.fingers.every((f) => !f.pressed || (f.angles[1] + f.angles[2] + f.angles[3] > 1.0 && f.angles[2] > 0.3)) &&
        pose.contactTips.every((contact) => contact.otherGap >= contact.gap - 0.001)
      if (process.env.POSE_DEBUG) console.log(key, JSON.stringify({
        unavailable: pose.unavailable,
        gapsMm: gaps.map((gap) => Number((gap * 1000).toFixed(1))),
        joints: pose.contactTips.map((contact) => contact.skinJoint),
        thumbTip: pose.thumbTip.map((value) => Number(value.toFixed(3))), thumbBehind: pose.thumbBehind,
        penetrationMm: Number((pose.penetration * 1000).toFixed(1)), wrist: pose.wrist, angles: pose.fingers.filter((f) => f.pressed).map((f) => f.angles),
      }))
      assert.equal(pose.unavailable, !valid, `${key}: availability is exactly the geometric grip validation`)
      if (feasible.has(key)) assert.equal(pose.unavailable, false, `${key}: feasible grip is shown`)
      const reference = meshLengths.get(meshName) ?? new Map(pose.fingers.map((finger) => [finger.finger, finger.lengths]))
      meshLengths.set(meshName, reference)
      for (const finger of pose.fingers) finger.lengths.forEach((length, joint) => assert.ok(
        Math.abs(length - reference.get(finger.finger)[joint]) < 1e-5, `${key}: finger ${finger.finger} keeps bone lengths`))
      if (pose.unavailable) continue
      poseMatrix.push({ key, pose })
      // Photo reference: forearm/wrist stays on one edge with the thumb behind the neck and the fingers wrapping over to the strings; the right mesh mirrors the left.
      assert.ok(meshName === 'left' ? pose.wrist[1] < -0.03 : pose.wrist[1] > 0.03, `${key}: wrist is on the mesh's own side of the neck (world y ${pose.wrist[1].toFixed(3)})`)
      assert.ok(Math.abs(pose.thumbTip[1]) < 0.02, `${key}: thumb stays behind the neck centre, not sticking out sideways`)
      assert.ok(pose.thumbTip[2] <= pose.neckBack + 0.006,
        `${key}: thumb pad stays behind the neck`)
      for (const contact of pose.contactTips) {
        assert.ok(contact.skinJoint.startsWith(`${fingerNames[contact.finger - 1]}-finger-`),
          `${key}: contact is made by the assigned digit's own skin`)
        if (shape !== 'barre' && !(shape === 'mixed' && pose.contactTips.filter((c) => c.finger === contact.finger).length > 1))
          assert.ok(/distal|tip/.test(contact.skinJoint), `${key}: a single fretted note uses the finger pad`)
      }
      for (const finger of pose.fingers.filter((item) => item.pressed)) {
        assert.ok(finger.angles[1] + finger.angles[2] + finger.angles[3] > 1.0 && finger.angles[2] > 0.3,
          `${key}: finger ${finger.finger} is curled at its real joints, not an open hand`)
      }
    }
  const productionSingles = [
    ['guitar', { halfWidth: 0.022313527067183165, depth: 0.028499998152256012 }, [0.5608418539496643, 0.018298592258019553, 0.05156057279830227], 0.05214477279830227, 0.0005842],
    ['bass', { halfWidth: 0.022320506563146457, depth: 0.028499998152256012 }, [0.7477891385995525, 0.018653369167790063, 0.05155765930802488], 0.05289115930802488, 0.0013334999999999998],
  ]
  for (const [name, neck, center, surfaceZ, radius] of productionSingles)
    for (const [meshName, mesh] of [['left', leftHand], ['right', rightHand]]) {
      const pose = poseFrettedHand(mesh, [{ finger: 3, string: 1, fret: 3, barre: false, center,
        surface: [center[0], center[1], surfaceZ], radius }], 'pressed', neck)
      if (process.env.POSE_DEBUG) console.log('PROD', name, meshName, pose.unavailable,
        pose.contactTips.map((c) => [c.gap, c.otherGap]), pose.thumbBehind, pose.penetration, pose.fingers.filter((f) => f.pressed).map((f) => f.angles))
      assert.equal(pose.unavailable, false, `${name} ${meshName}: production single ring-finger S1F3 is shown with the real neck profile`)
      assert.ok(meshName === 'left' ? pose.wrist[1] < -0.03 : pose.wrist[1] > 0.03, `${name} ${meshName}: production wrist is on the mesh's own side of the neck`)
      assert.ok(pose.contactTips[0].gap <= 0.0035 && pose.penetration <= 0.003 && pose.thumbBehind,
        `${name} ${meshName}: production single keeps strict contact, penetration and thumb checks`)
    }
  const singlePlan = planFrettedTab(
    [{ midi: 43, string: 1, fret: 3, finger: 3, startBeat: 0, beats: 1 }], GUITAR)
  const singleGrip = planFrettedHand(singlePlan, GUITAR)
  const singleHandPose = poseFrettedHand(leftHand, modelContacts(singleGrip, singlePlan), 'pressed')
  assert.equal(singleHandPose.unavailable, false,
    'A feasible single-note grip can be posed against the instrument mesh')
  assert.ok(singleHandPose.vertices.length > 1000 * 8 && singleHandPose.triangles > 1000 &&
    singleHandPose.fingers.length === 4 &&
    singleHandPose.fingers.filter((finger) => finger.pressed).length === 1 &&
    singleHandPose.fingers.filter((finger) => !finger.pressed).length === 3 &&
    singleHandPose.fingers.every((finger) => finger.joints.length === 5),
  'A single-note hand keeps the connected palm and all four name-mapped joint chains')
  assert.ok(singleHandPose.contactTips.length === 1 &&
    singleHandPose.contactTips[0].gap <= 0.0035 &&
    [...singleHandPose.thumbTip, ...singleHandPose.vertices].every(Number.isFinite),
  'The rendered fingertip skin reaches the real string surface without stretching the hand')
  const previewHandPose = poseFrettedHand(leftHand, modelContacts(singleGrip, singlePlan), 'preview')
    assert.ok(previewHandPose.contactTips[0].gap > singleHandPose.contactTips[0].gap + 0.005,
    'A preview hand stays raised above the string rather than faking contact')
  const relaxedHandPose = poseFrettedHand(leftHand, modelContacts(singleGrip, singlePlan), 'relaxed')
  assert.equal(relaxedHandPose.unavailable, false, 'A relaxed hand for open strings and rests can be posed')
  assert.ok(relaxedHandPose.thumbBehind && relaxedHandPose.penetration <= 0.006 &&
    relaxedHandPose.contactTips[0].gap > previewHandPose.contactTips[0].gap + 0.003,
  'A relaxed hand hovers above the board with its thumb behind the neck and never presses')
  const rightHandPose = poseFrettedHand(rightHand, modelContacts(singleGrip, singlePlan), 'pressed')
  assert.equal(rightHandPose.unavailable, false,
    'The opposite source mesh can pose the same target for left-handed play')
  const fixedLengths = (pose) => pose.fingers.map((finger) => finger.lengths)
  const baselineLengths = fixedLengths(singleHandPose)
  const checkFixedLengths = (pose, referenceLengths, label) => pose.fingers.forEach((finger, index) =>
    finger.lengths.forEach((length, joint) => assert.ok(
      Math.abs(length - referenceLengths[index][joint]) < 1e-5,
      `${label}: finger ${finger.finger} joint ${joint} keeps its source bone length`)))
  const rightHandLengths = fixedLengths(rightHandPose)
  checkFixedLengths(rightHandPose, rightHandLengths, 'left-handed mesh')
  assert.ok(handChord.contacts.some((contact) => contact.barre))
  const chordHandPose = poseFrettedHand(leftHand, modelContacts(handChord, authoredChord), 'pressed')
  assert.equal(chordHandPose.unavailable, false,
    'A feasible mixed-finger/barre chord stays available on the real skinned hand')
  assert.ok(chordHandPose.fingers.find((finger) => finger.finger === 3)?.barre &&
    chordHandPose.contactTips.filter((contact) => contact.finger === 3).length === 2,
  'The authored ring-finger barre has one stable identity across both string contacts')
  checkFixedLengths(chordHandPose, baselineLengths, 'barre chord')
  const sequence = planFrettedTab([
    { midi: 41, startBeat: 0, beats: 2, string: 1, fret: 1 },
    { midi: 47, startBeat: 0, beats: 2, string: 2, fret: 2 },
    { midi: 53, startBeat: 0, beats: 2, string: 3, fret: 3 },
    { midi: 51, startBeat: 1, beats: 3, string: 3, fret: 1 },
    { midi: 57, startBeat: 1, beats: 3, string: 4, fret: 2 },
    { midi: 67, startBeat: 1, beats: 3, string: 6, fret: 3 },
  ], GUITAR)
  const sequenceMemory = new Map()
  const sequenceGripAt = (beat) => planFrettedHand(sequence.filter((note) =>
    note.startBeat <= beat && beat < note.startBeat + note.beats), GUITAR, sequenceMemory)
  const initialSequenceGrip = sequenceGripAt(0)
  const overlappingSequenceGrip = sequenceGripAt(1)
  const releasedSequenceGrip = sequenceGripAt(2)
  assert.equal(initialSequenceGrip.unavailable, false)
  assert.equal(overlappingSequenceGrip.unavailable, false)
  assert.equal(releasedSequenceGrip.unavailable, false)
  assert.deepEqual(initialSequenceGrip.contacts.map((contact) => contact.finger), [1, 2, 3])
  assert.deepEqual(overlappingSequenceGrip.contacts.map((contact) => contact.finger),
    [1, 2, 3, 1, 2, 3],
    'Held fingers keep their identities as the next same-shape grip arrives')
  assert.deepEqual(releasedSequenceGrip.contacts.map((contact) => contact.finger), [1, 2, 3],
    'The newly held chord retains the same identities after the previous chord releases')
  const sequencePoses = [
    poseFrettedHand(leftHand, modelContacts(initialSequenceGrip, sequence), 'pressed'),
    poseFrettedHand(leftHand, modelContacts(overlappingSequenceGrip, sequence), 'pressed'),
    poseFrettedHand(leftHand, modelContacts(releasedSequenceGrip, sequence), 'pressed'),
  ]
  for (const [index, pose] of sequencePoses.entries()) {
    assert.equal(pose.unavailable, !pose.contactTips.every((contact) => contact.gap <= 0.0035) || !pose.thumbBehind || pose.penetration > 0.003,
      `Suggested grip transition ${index} is available only when every target is a real skin contact`)
    assert.equal(pose.fingers.filter((finger) => finger.pressed).length, 3)
    assert.ok(pose.contactTips.every((contact) => contact.skinJoint.startsWith(['index', 'middle', 'ring', 'pinky'][contact.finger - 1])),
    `Suggested grip transition ${index} checks the assigned digit's skin`)
    assert.equal(pose.contactTips.every((contact) => contact.gap <= 0.0035),
      !pose.unavailable, `Suggested grip transition ${index} reports only validated surface contacts`)
    checkFixedLengths(pose, baselineLengths, `sequence frame ${index}`)
  }
  const displacement = (first, second) => Math.max(...first.fingers.flatMap((finger, index) =>
    finger.joints.map((point, joint) => Math.hypot(...point.map((value, axis) =>
      value - second.fingers[index].joints[joint][axis])))))
  assert.ok(displacement(sequencePoses[0], sequencePoses[1]) < 0.12,
    `The suggested hand moves continuously across the chord change (${displacement(sequencePoses[0], sequencePoses[1]).toFixed(3)} m)`)
  assert.ok(sequencePoses[1].unavailable || displacement(sequencePoses[1], sequencePoses[2]) < 0.01,
    `Releasing the first chord does not teleport the still-held next grip (${displacement(sequencePoses[1], sequencePoses[2]).toFixed(3)} m)`)
  const fullBarreNotes = [
    { midi: 41, string: 1, fret: 1, finger: 1, startBeat: 0, beats: 2 },
    { midi: 48, string: 2, fret: 3, finger: 3, startBeat: 0, beats: 2 },
    { midi: 53, string: 3, fret: 3, finger: 3, startBeat: 0, beats: 2 },
    { midi: 57, string: 4, fret: 2, finger: 2, startBeat: 0, beats: 2 },
    { midi: 60, string: 5, fret: 1, finger: 1, startBeat: 0, beats: 2 },
    { midi: 65, string: 6, fret: 1, finger: 1, startBeat: 0, beats: 2 },
  ]
  const fullBarrePlan = planFrettedTab(fullBarreNotes, GUITAR)
  const fullBarreGrip = planFrettedHand(fullBarrePlan, GUITAR)
  const fullBarrePose = poseFrettedHand(leftHand, modelContacts(fullBarreGrip, fullBarrePlan), 'pressed')
  barreEvidence = {
    available: !fullBarrePose.unavailable,
    contacts: fullBarrePose.contactTips.map(({ finger, string, fret, skinJoint, gap, tip, surface }) => ({
      finger, string, fret, skinJoint, skinGapMm: Number((gap * 1000).toFixed(2)),
      tipGapMm: Number((Math.hypot(...tip.map((value, axis) => value - surface[axis])) * 1000).toFixed(2)),
    })),
  }
  assert.equal(fullBarrePose.contactTips.length, 6)
  assert.ok(fullBarrePose.contactTips.every((contact) =>
    contact.skinJoint.startsWith(['index', 'middle', 'ring', 'pinky'][contact.finger - 1])),
  'Each six-string barre target must be touched by skin on its assigned finger')
  assert.equal(fullBarrePose.unavailable || fullBarrePose.contactTips.every((contact) => contact.gap <= 0.0035),
    true,
  `The six-string F shape is shown as a real hand only when every assigned pad meets its string; gaps: ${
    fullBarrePose.contactTips.map(({ finger, string, gap }) =>
      `${finger}:${string}=${(gap * 1000).toFixed(1)}mm`).join(', ')}`)
  assert.deepEqual(planFrettedHand(planFrettedTab([{ midi: 40, startBeat: 0, beats: 1 }], GUITAR), GUITAR),
    { contacts: [], unavailable: false }, 'Open-only notes do not invent a pressing hand')
  const tooWide = planFrettedTab([
    { midi: 41, startBeat: 0, beats: 1, string: 1, fret: 1 },
    { midi: 50, startBeat: 0, beats: 1, string: 2, fret: 5 },
    { midi: 59, startBeat: 0, beats: 1, string: 3, fret: 9 },
  ], GUITAR)
  assert.equal(planFrettedHand(tooWide, GUITAR).unavailable, true,
    'A chord spanning more than four frets is left in tab without a false hand')
  const crossedFingers = planFrettedTab([
    { midi: 43, startBeat: 0, beats: 1, string: 1, fret: 3, finger: 1 },
    { midi: 46, startBeat: 0, beats: 1, string: 2, fret: 1, finger: 3 },
  ], GUITAR)
  assert.equal(planFrettedHand(crossedFingers, GUITAR).unavailable, true,
    'Authored finger assignments that cross frets do not create an impossible hand')
  assert.equal(planFrettedTab([{ midi: 39, startBeat: 0, beats: 1 }], GUITAR)[0].reason, 'outside-range')
  assert.equal(planFrettedTab([{ midi: 40.5, startBeat: 0, beats: 1 }], GUITAR)[0].reason, 'fractional-pitch')
  const bassName = { id: 'bass-guitar', name: 'Bass guitar', instrument: 'other', gmProgram: 33 }
  const bassSource = { ...bassName, gmProgram: undefined, sourceInstrument: 'bass_guitar' }
  for (const track of [bassName, bassSource])
    assert.equal(identifiesInstrument(track, 'bass'), true, 'Bass guitar is recognized as bass')
  assert.equal(identifiesInstrument(bassName, 'guitar'), false, 'Bass guitar is not offered as six-string guitar')
  for (const gmProgram of [0, 23, 40, 73, 127]) {
    const staleGuitar = { id: 'guitar-track', name: 'Electric guitar', sourceInstrument: 'guitar', gmProgram }
    assert.equal(identifiesInstrument(staleGuitar, 'guitar'), false,
      `Explicit non-guitar MIDI program ${gmProgram} overrides stale guitar identity`)
    assert.equal(identifiesInstrument({ ...staleGuitar, id: 'bass-track', name: 'Bass guitar' }, 'bass'), false,
      `Explicit non-bass MIDI program ${gmProgram} overrides stale bass identity`)
  }
  for (const gmProgram of [24, 31])
    assert.equal(identifiesInstrument({ id: 'unrelated', name: 'Flute', gmProgram }, 'guitar'), true)
  for (const gmProgram of [32, 39])
    assert.equal(identifiesInstrument({ id: 'unrelated', name: 'Flute', gmProgram }, 'bass'), true)
  assert.equal(identifiesInstrument({ id: 'guitar-track', name: 'Electric guitar', gmProgram: 128 }, 'guitar'), true,
    'Invalid GM program retains the existing identity fallback')
  for (const name of ['Ukulele', 'Mandolin'])
    assert.equal(identifiesInstrument({ ...bassName, name, gmProgram: undefined }, 'guitar'), false)

  const song = { ...buildSong(), bars: 2, bpm: 90, beatsPerBar: 4,
    piano: [{ midi: 64, startBeat: 3.5, beats: 1 }] }
  const plan = planFrettedTab(song.piano, GUITAR)
  const bars = notesByMeasure(song, plan)
  assert.equal(bars.length, 2)
  assert.equal(bars[0].notes.length, 1)
  assert.equal(bars[1].notes.length, 1, 'a note held over a barline appears in both measures')
  assert.equal(measureAtBeat(song, 0), 0)
  assert.equal(measureAtBeat(song, 4), 1)

  const guitar = assertAsset('ElectricGuitar.glb', 'guitar', GUITAR,
    { strings: 6, bodyWidth: 0.32, thickness: 0.045, overall: 1.0 })
  const bass = assertAsset('ElectricBass.glb', 'bass', BASS,
    { strings: 4, bodyWidth: 0.33, thickness: 0.045, overall: 1.18 })
  report = { mapping: 'open strings, chords, real distal-skin contacts, stable looks, tuner alignment, bass recognition, and bars passed',
    barreEvidence, guitar, bass }
} finally {
  await vite.close()
}
console.log(JSON.stringify(report, null, 2))
