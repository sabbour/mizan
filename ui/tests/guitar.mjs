import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const modelPath = (name) => fileURLToPath(new URL(`../public/models/${name}`, import.meta.url))
const FRETTED_LOOKS = ['Realistic', 'ClayStudyModel', 'NeonRhythm', 'TechnicalBlueprint']

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
  assert.deepEqual(json.extensions.KHR_materials_variants.variants.map((variant) => variant.name), FRETTED_LOOKS)
  const variantIndices = FRETTED_LOOKS.map((_look, index) => index)
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
  assert.deepEqual(rootExtras.stylePresets, FRETTED_LOOKS)
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
  for (const node of stringNodes) {
    assertOutwardSurfaces(asset, node)
    assert.equal(node.extras.deformable, true)
    assert.equal(node.extras.vibration.model, 'pinned-sine')
    assert.equal(node.extras.vibration.envelope, 'zero-at-selected-fret-and-bridge')
    const primitive = json.meshes[node.mesh].primitives[0]
    const position = json.accessors[primitive.attributes.POSITION]
    assert.ok(position.max[0] > config.scaleLength && position.max[0] < config.scaleLength + 0.15,
      `${kind}: ${node.name} reaches its headstock tuner, not a point on the body`)
  }
  for (const node of json.nodes.filter((node) =>
    /^Fret_\d{2}$|^Knob_.*_(Seat|Base|Cap)$|^Tuner_\d+_(Post|Button)$|^Pickup_/.test(node.name)))
    assertOutwardSurfaces(asset, node)
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
    bodyWidth: bodyBounds.size[1], bodyThickness: bodyBounds.size[2], images: json.images.map((image) => image.name) }
}

globalThis.matchMedia = () => ({ matches: false })
const vite = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
})
let report
try {
  const {
    GUITAR, BASS, mapFrettedNote, positionsForMidi, planFrettedTab,
    identifiesInstrument, measureAtBeat, notesByMeasure, positionForStringFret,
  } = await vite.ssrLoadModule('/src/workspace/fretboard.ts')
  const { LOOKS } = await vite.ssrLoadModule('/src/workspace/prefs.ts')
  const { buildSong } = await vite.ssrLoadModule('/src/workspace/song.ts')
  assert.deepEqual(LOOKS, FRETTED_LOOKS)
  assert.deepEqual(GUITAR.styles, LOOKS)
  assert.deepEqual(BASS.styles, LOOKS)
  assert.equal(GUITAR.scaleLength, 0.6477)
  assert.equal(GUITAR.frets, 22)
  assert.deepEqual(GUITAR.strings.map((string) => string.midi), [40, 45, 50, 55, 59, 64])
  assert.deepEqual(BASS.strings.map((string) => string.midi), [28, 33, 38, 43])
  assert.equal(BASS.frets, 20)
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
  assert.equal(planFrettedTab([{ midi: 39, startBeat: 0, beats: 1 }], GUITAR)[0].reason, 'outside-range')
  assert.equal(planFrettedTab([{ midi: 40.5, startBeat: 0, beats: 1 }], GUITAR)[0].reason, 'fractional-pitch')
  const bassName = { id: 'bass-guitar', name: 'Bass guitar', instrument: 'other', gmProgram: 33 }
  const bassSource = { ...bassName, gmProgram: undefined, sourceInstrument: 'bass_guitar' }
  for (const track of [bassName, bassSource])
    assert.equal(identifiesInstrument(track, 'bass'), true, 'Bass guitar is recognized as bass')
  assert.equal(identifiesInstrument(bassName, 'guitar'), false, 'Bass guitar is not offered as six-string guitar')
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
  report = { mapping: 'open strings, chords, range, bass guitar recognition, and bars passed', guitar, bass }
} finally {
  await vite.close()
}
console.log(JSON.stringify(report, null, 2))
