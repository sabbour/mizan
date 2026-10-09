// Dependency-free GLB validation for the acoustic and electronic drum-kit contracts.
// Usage: node ui\tests\drum-kit-assets.mjs [--geometry-only] [--out-dir <dir> | <acoustic.glb> <electronic.glb>]
// Self-check: node ui\tests\drum-kit-assets.mjs --self-test
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readGlb } from '../scripts/kits/gltf.mjs'

const LOOKS = ['Realistic', 'HandPaintedAnime', 'StylizedAnimated3D', 'LowPoly', 'NeonRhythm', 'TechnicalBlueprint', 'ClayStudyModel']
const NEON = {
  Kick: '#8c33ff', Snare: '#0de6ff', TomHigh: '#1a66ff', TomMid: '#4d26d9',
  FloorTom: '#ff26bf', HiHat: '#ffe01a', Crash: '#ff730d', Ride: '#26ff59',
}
const ACOUSTIC_HIERARCHY = {
  AcousticDrumKit: ['Kick', 'KickPedal', 'Snare', 'TomHigh', 'TomMid', 'FloorTom', 'HiHat', 'Crash', 'Ride', 'SnareStand', 'TomMountingSystem', 'Throne'],
  Kick: ['Kick_Shell', 'Kick_FrontHead', 'Kick_BatterHead', 'Kick_FrontHoop', 'Kick_BatterHoop', 'Kick_Lugs', 'Kick_TensionRods', 'Kick_Spurs', 'Kick_Vent', 'Kick_MountingHardware', 'COL_Kick'],
  KickPedal: ['KickPedal_Base', 'KickPedal_Footboard', 'KickPedal_Hinge', 'KickPedal_Chain', 'KickPedal_Cam', 'KickPedal_Spring', 'KickPedal_Shaft', 'KickPedal_Beater'],
  Snare: ['Snare_Shell', 'Snare_BatterHead', 'Snare_ResonantHead', 'Snare_TopHoop', 'Snare_BottomHoop', 'Snare_Rim', 'Snare_Lugs', 'Snare_TensionRods', 'Snare_Strainer', 'Snare_Wires', 'Snare_ButtPlate', 'COL_SnareHead', 'COL_SnareRim'],
  TomHigh: ['TomHigh_Shell', 'TomHigh_BatterHead', 'TomHigh_ResonantHead', 'TomHigh_TopHoop', 'TomHigh_BottomHoop', 'TomHigh_Rim', 'TomHigh_Lugs', 'TomHigh_TensionRods', 'TomHigh_Mount', 'COL_TomHigh'],
  TomMid: ['TomMid_Shell', 'TomMid_BatterHead', 'TomMid_ResonantHead', 'TomMid_TopHoop', 'TomMid_BottomHoop', 'TomMid_Rim', 'TomMid_Lugs', 'TomMid_TensionRods', 'TomMid_Mount', 'COL_TomMid'],
  FloorTom: ['FloorTom_Shell', 'FloorTom_BatterHead', 'FloorTom_ResonantHead', 'FloorTom_TopHoop', 'FloorTom_BottomHoop', 'FloorTom_Rim', 'FloorTom_Lugs', 'FloorTom_TensionRods', 'FloorTom_Leg_Left', 'FloorTom_Leg_Right', 'FloorTom_Leg_Rear', 'COL_FloorTom'],
  HiHat: ['HiHat_TopCymbal', 'HiHat_BottomCymbal', 'HiHat_Clutch', 'HiHat_PullRod', 'HiHat_Stand', 'HiHat_Legs', 'HiHat_Pedal', 'HiHat_Chain', 'HiHat_SpringAssembly', 'COL_HiHat'],
  Crash: ['Crash_Cymbal', 'Crash_Stand', 'Crash_BoomArm', 'Crash_Tilter', 'Crash_Felts', 'Crash_WingNut'],
  Ride: ['Ride_Cymbal', 'Ride_Stand', 'Ride_BoomArm', 'Ride_Tilter', 'Ride_Felts', 'Ride_WingNut'],
  SnareStand: ['SnareStand_Base', 'SnareStand_Post', 'SnareStand_Basket', 'SnareStand_Adjusters'],
  TomMountingSystem: ['TomMount_Base', 'TomMount_HighArm', 'TomMount_MidArm', 'TomMount_Clamps'],
  Throne: ['Throne_Seat', 'Throne_Post', 'Throne_AdjustmentCollar', 'Throne_Legs'],
  Ride_Cymbal: ['Ride_Bell', 'Ride_Bow', 'Ride_Edge', 'COL_RideBell', 'COL_RideBow', 'COL_RideEdge'],
  Crash_Cymbal: ['COL_Crash'],
}
const ELECTRONIC_HIERARCHY = {
  ElectronicDrumKit: ['Rack', 'DrumModule', 'Snare', 'TomHigh', 'TomMid', 'FloorTom', 'HiHat', 'Crash', 'Ride', 'Kick', 'Throne'],
  Rack: ['Rack_LeftPost', 'Rack_RightPost', 'Rack_Crossbar', 'Rack_Legs', 'Rack_Clamps', 'Rack_MountingArms'],
  Rack_Legs: ['Rack_Leg_Left', 'Rack_Leg_Right'],
  Rack_MountingArms: ['Rack_Arm_Snare', 'Rack_Arm_TomHigh', 'Rack_Arm_TomMid', 'Rack_Arm_FloorTom'],
  DrumModule: ['DrumModule_Body', 'DrumModule_Display', 'DrumModule_Buttons', 'DrumModule_Knobs'],
  Snare: ['Snare_Body', 'Snare_Head', 'Snare_Rim', 'COL_Snare'],
  TomHigh: ['TomHigh_Body', 'TomHigh_Head', 'TomHigh_Rim', 'COL_TomHigh'],
  TomMid: ['TomMid_Body', 'TomMid_Head', 'TomMid_Rim', 'COL_TomMid'],
  FloorTom: ['FloorTom_Body', 'FloorTom_Head', 'FloorTom_Rim', 'COL_FloorTom'],
  HiHat: ['HiHat_Cymbal', 'HiHat_Mount', 'HiHat_Pedal', 'COL_HiHat'],
  HiHat_Pedal: ['HiHat_PedalBase', 'HiHat_PedalBoard'],
  Crash: ['Crash_Cymbal', 'Crash_Mount', 'COL_Crash'],
  Ride: ['Ride_Cymbal', 'Ride_Mount', 'COL_Ride'],
  Kick: ['Kick_Pad', 'Kick_Pedal', 'Kick_Beater', 'COL_Kick'],
  Kick_Pedal: ['Kick_PedalBase', 'Kick_PedalBoard'],
  Throne: ['Throne_Seat', 'Throne_Post', 'Throne_Legs'],
}
const profiles = {
  acoustic: {
    root: 'AcousticDrumKit',
    hierarchy: ACOUSTIC_HIERARCHY,
    playable: ['Kick_BatterHead', 'Snare_BatterHead', 'Snare_Rim', 'TomHigh_BatterHead', 'TomMid_BatterHead', 'FloorTom_BatterHead', 'HiHat_TopCymbal', 'Crash_Cymbal', 'Ride_Cymbal'],
    colliders: ['COL_Kick', 'COL_SnareHead', 'COL_SnareRim', 'COL_TomHigh', 'COL_TomMid', 'COL_FloorTom', 'COL_HiHat', 'COL_Crash', 'COL_RideBow', 'COL_RideBell', 'COL_RideEdge'],
    materials: ['MAT_Shell_BurgundyWood', 'MAT_DrumHead_CoatedWhite', 'MAT_DrumHead_Clear', 'MAT_Cymbal_Bronze', 'MAT_Chrome', 'MAT_Steel_Brushed', 'MAT_Metal_Black', 'MAT_Rubber_Black', 'MAT_Plastic_Black', 'MAT_Felt_Dark', 'MAT_SeatVinyl_Black', 'MAT_SnareWire_Steel'],
    primaryMaterials: ['MAT_Shell_BurgundyWood', 'MAT_DrumHead_CoatedWhite', 'MAT_Cymbal_Bronze'],
    budgets: [[120000, 220000], [45000, 90000], [12000, 30000]],
    lowPolyLod: 2,
    lowPolyBudget: [15000, 30000],
    boundRanges: [[1.8, 2.1], [1.2, 1.45], [1.4, 1.7]],
    playableDiameters: {
      Kick_BatterHead: 0.558, Kick_FrontHead: 0.558, Snare_BatterHead: 0.356, TomHigh_BatterHead: 0.254,
      TomMid_BatterHead: 0.304, FloorTom_BatterHead: 0.406, HiHat_TopCymbal: 0.356,
      Crash_Cymbal: 0.458, Ride_Cymbal: 0.508,
    },
    shellDimensions: {
      Kick_Shell: [0.558, 0.43], Snare_Shell: [0.356, 0.15], TomHigh_Shell: [0.254, 0.20],
      TomMid_Shell: [0.304, 0.23], FloorTom_Shell: [0.406, 0.40],
    },
    collisionShapes: {
      COL_Kick: 'cylinder', COL_SnareHead: 'cylinder', COL_SnareRim: 'ring', COL_TomHigh: 'cylinder',
      COL_TomMid: 'cylinder', COL_FloorTom: 'cylinder', COL_HiHat: 'cylinder', COL_Crash: 'cylinder',
      COL_RideBow: 'ring', COL_RideBell: 'cylinder', COL_RideEdge: 'ring',
    },
    collisionParents: {
      COL_Kick: 'Kick', COL_SnareHead: 'Snare', COL_SnareRim: 'Snare', COL_TomHigh: 'TomHigh',
      COL_TomMid: 'TomMid', COL_FloorTom: 'FloorTom', COL_HiHat: 'HiHat', COL_Crash: 'Crash_Cymbal',
      COL_RideBow: 'Ride_Cymbal', COL_RideBell: 'Ride_Cymbal', COL_RideEdge: 'Ride_Cymbal',
    },
    collisionSurfaces: {
      COL_Kick: 'Kick_BatterHead', COL_SnareHead: 'Snare_BatterHead', COL_SnareRim: 'Snare_Rim',
      COL_TomHigh: 'TomHigh_BatterHead', COL_TomMid: 'TomMid_BatterHead', COL_FloorTom: 'FloorTom_BatterHead',
      COL_HiHat: 'HiHat_TopCymbal', COL_Crash: 'Crash_Cymbal', COL_RideBow: 'Ride_Bow',
      COL_RideBell: 'Ride_Bell', COL_RideEdge: 'Ride_Edge',
    },
    pivots: [
      ['KickPedal_Footboard', 'heel hinge'], ['KickPedal_Beater', 'beater shaft rotation axis'],
      ['HiHat_TopCymbal', 'centre shaft'], ['Crash_Cymbal', 'centre mounting hole'],
      ['Ride_Cymbal', 'centre mounting hole'], ['Crash_BoomArm', 'adjustment joint'],
      ['Ride_BoomArm', 'adjustment joint'], ['Throne_Seat', 'centre of the vertical post'],
    ],
    neonComponents: Object.keys(NEON),
  },
  electronic: {
    root: 'ElectronicDrumKit',
    hierarchy: ELECTRONIC_HIERARCHY,
    playable: ['Snare_Head', 'Snare_Rim', 'TomHigh_Head', 'TomMid_Head', 'FloorTom_Head', 'HiHat_Cymbal', 'Crash_Cymbal', 'Ride_Cymbal', 'Kick_Pad'],
    colliders: ['COL_Snare', 'COL_TomHigh', 'COL_TomMid', 'COL_FloorTom', 'COL_HiHat', 'COL_Crash', 'COL_Ride', 'COL_Kick'],
    materials: ['MAT_Rubber_Black', 'MAT_MeshHead_LightGray', 'MAT_PowderCoatedMetal_Black', 'MAT_Steel_Brushed', 'MAT_Chrome', 'MAT_Plastic_Black', 'MAT_DisplayGlass', 'MAT_DisplayEmission', 'MAT_SeatVinyl_Black'],
    primaryMaterials: ['MAT_Rubber_Black', 'MAT_MeshHead_LightGray'],
    budgets: [[80000, 150000], [20000, 50000], [5000, 15000]],
    lowPolyLod: 1,
    lowPolyBudget: [20000, 35000],
    boundMax: [1.4, 1.2, 1.1],
    playableDiameters: {
      Snare_Head: 0.30, TomHigh_Head: 0.25, TomMid_Head: 0.25, FloorTom_Head: 0.30,
      HiHat_Cymbal: 0.30, Crash_Cymbal: 0.35, Ride_Cymbal: 0.40,
    },
    collisionShapes: Object.fromEntries(['COL_Snare', 'COL_TomHigh', 'COL_TomMid', 'COL_FloorTom', 'COL_HiHat', 'COL_Crash', 'COL_Ride', 'COL_Kick'].map((name) => [name, 'cylinder'])),
    collisionParents: {
      COL_Snare: 'Snare', COL_TomHigh: 'TomHigh', COL_TomMid: 'TomMid', COL_FloorTom: 'FloorTom',
      COL_HiHat: 'HiHat', COL_Crash: 'Crash', COL_Ride: 'Ride', COL_Kick: 'Kick',
    },
    collisionSurfaces: {
      COL_Snare: 'Snare_Head', COL_TomHigh: 'TomHigh_Head', COL_TomMid: 'TomMid_Head', COL_FloorTom: 'FloorTom_Head',
      COL_HiHat: 'HiHat_Cymbal', COL_Crash: 'Crash_Cymbal', COL_Ride: 'Ride_Cymbal', COL_Kick: 'Kick_Pad',
    },
    pivots: [
      ['Kick_PedalBoard', 'heel hinge'], ['Kick_Beater', 'beater shaft rotation axis'],
      ['HiHat_Cymbal', 'centre shaft'], ['Crash_Cymbal', 'centre mounting hole'],
      ['Ride_Cymbal', 'centre mounting hole'], ['Throne_Seat', 'centre of the vertical post'],
    ],
    neonComponents: Object.keys(NEON),
  },
}

const issue = (issues, code, message) => issues.push({ code, message })
const approx = (a, b, tolerance = 1e-5) => Math.abs(a - b) <= tolerance
const isIndex = (x, length) => Number.isInteger(x) && x >= 0 && x < length
const componentInfo = {
  5120: { bytes: 1, read: (b, o) => b.readInt8(o) },
  5121: { bytes: 1, read: (b, o) => b.readUInt8(o) },
  5122: { bytes: 2, read: (b, o) => b.readInt16LE(o) },
  5123: { bytes: 2, read: (b, o) => b.readUInt16LE(o) },
  5125: { bytes: 4, read: (b, o) => b.readUInt32LE(o) },
  5126: { bytes: 4, read: (b, o) => b.readFloatLE(o) },
}
const typeSize = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }

function parseGlb(bytes, issues) {
  const b = Buffer.from(bytes)
  if (b.length < 20 || b.readUInt32LE(0) !== 0x46546c67 || b.readUInt32LE(4) !== 2) {
    issue(issues, 'glb-header', 'File does not have a complete glTF 2.0 binary header.')
    return null
  }
  const total = b.readUInt32LE(8)
  if (total !== b.length) issue(issues, 'glb-length', `Header length ${total} does not match file length ${b.length}.`)
  let offset = 12
  const chunks = []
  while (offset + 8 <= b.length) {
    const length = b.readUInt32LE(offset)
    const type = b.readUInt32LE(offset + 4)
    offset += 8
    if (length % 4 || offset + length > b.length) {
      issue(issues, 'glb-chunk', `Chunk at byte ${offset - 8} has an invalid length or exceeds the file.`)
      return null
    }
    chunks.push({ type, bytes: b.subarray(offset, offset + length) })
    offset += length
  }
  if (offset !== b.length || chunks.length < 1 || chunks[0].type !== 0x4e4f534a) {
    issue(issues, 'glb-chunk-order', 'A JSON chunk must be first, and all chunk headers must be complete.')
    return null
  }
  if (chunks.filter((chunk) => chunk.type === 0x4e4f534a).length !== 1 || chunks.filter((chunk) => chunk.type === 0x004e4942).length > 1) {
    issue(issues, 'glb-chunk-count', 'GLB must contain one JSON chunk and at most one BIN chunk.')
    return null
  }
  try {
    const glb = readGlb(b)
    if (!glb.json || typeof glb.json !== 'object' || Array.isArray(glb.json)) {
      issue(issues, 'glb-json-root', 'The GLB JSON chunk must contain a glTF object.')
      return null
    }
    return { json: glb.json, bin: chunks.find((chunk) => chunk.type === 0x004e4942)?.bytes ?? Buffer.alloc(0) }
  } catch (error) {
    issue(issues, 'glb-json', `Could not read GLB JSON/BIN chunks: ${error.message}`)
    return null
  }
}

function checkContainer(json, bin, issues) {
  if (json.asset?.version !== '2.0') issue(issues, 'gltf-version', 'asset.version must be "2.0".')
  if (!Array.isArray(json.buffers) || json.buffers.length !== 1 || json.buffers[0]?.uri !== undefined) {
    issue(issues, 'embedded-buffer', 'Expected exactly one GLB buffer with no external URI.')
  } else if (!Number.isInteger(json.buffers[0].byteLength) || json.buffers[0].byteLength > bin.length) {
    issue(issues, 'buffer-length', 'Declared buffer byteLength is invalid or exceeds the BIN chunk.')
  }
  for (const [i, view] of (json.bufferViews ?? []).entries()) {
    const start = view.byteOffset ?? 0
    const end = start + view.byteLength
    if (view.buffer !== 0 || !Number.isInteger(start) || !Number.isInteger(view.byteLength) || start < 0 || view.byteLength < 0 ||
        end > (json.buffers?.[0]?.byteLength ?? 0) || end > bin.length) {
      issue(issues, 'buffer-view-range', `bufferView ${i} is outside the declared embedded buffer.`)
    }
    if (view.byteStride !== undefined && (!Number.isInteger(view.byteStride) || view.byteStride < 4 || view.byteStride > 252 || view.byteStride % 4)) {
      issue(issues, 'buffer-view-stride', `bufferView ${i} has an invalid byteStride.`)
    }
  }
  for (const [kind, resources] of [['buffer', json.buffers ?? []], ['image', json.images ?? []]]) {
    for (const [i, resource] of resources.entries()) if (resource.uri !== undefined) {
      issue(issues, 'external-uri', `${kind} ${i} uses external URI "${resource.uri}".`)
    }
  }
  if (!Array.isArray(json.scenes) || !json.scenes.length || !isIndex(json.scene, json.scenes.length)) issue(issues, 'scene', 'A valid active scene is required.')
}

function makeAccessorReader(json, bin, issues) {
  const cache = new Map()
  return (index) => {
    if (!isIndex(index, json.accessors?.length ?? 0)) {
      issue(issues, 'accessor-reference', `Accessor index ${index} is invalid.`)
      return null
    }
    if (cache.has(index)) return cache.get(index)
    const a = json.accessors[index]
    const info = componentInfo[a.componentType]
    const size = typeSize[a.type]
    if (!info || !size || !Number.isInteger(a.count) || a.count < 1) {
      issue(issues, 'accessor-format', `Accessor ${index} has an invalid type, componentType, or count.`)
      cache.set(index, null)
      return null
    }
    if (a.sparse) {
      issue(issues, 'sparse-accessor', `Accessor ${index} uses sparse data; the kit builders emit dense accessors only.`)
      cache.set(index, null)
      return null
    }
    if (!isIndex(a.bufferView, json.bufferViews?.length ?? 0)) {
      issue(issues, 'accessor-buffer-view', `Accessor ${index} does not reference a valid bufferView.`)
      cache.set(index, null)
      return null
    }
    const view = json.bufferViews[a.bufferView]
    const offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0)
    const stride = view.byteStride ?? size * info.bytes
    const end = offset + (a.count - 1) * stride + size * info.bytes
    if (!Number.isInteger(a.byteOffset ?? 0) || (a.byteOffset ?? 0) < 0 || stride < size * info.bytes ||
        offset % info.bytes || end > (view.byteOffset ?? 0) + view.byteLength || end > bin.length) {
      issue(issues, 'accessor-range', `Accessor ${index} data exceeds its bufferView or is misaligned.`)
      cache.set(index, null)
      return null
    }
    const values = new Array(a.count * size)
    let finite = true
    for (let i = 0; i < a.count; i++) for (let k = 0; k < size; k++) {
      const value = info.read(bin, offset + i * stride + k * info.bytes)
      values[i * size + k] = value
      if (!Number.isFinite(value)) finite = false
    }
    if (!finite) issue(issues, 'non-finite-accessor', `Accessor ${index} contains a NaN or infinite value.`)
    const result = { accessor: a, values, size, finite }
    cache.set(index, result)
    return result
  }
}

function checkAccessors(json, bin, issues, getAccessor) {
  for (let i = 0; i < (json.accessors ?? []).length; i++) {
    const data = getAccessor(i)
    if (!data?.finite || !data.accessor.min || !data.accessor.max) continue
    const min = Array(data.size).fill(Infinity), max = Array(data.size).fill(-Infinity)
    for (let n = 0; n < data.values.length; n++) {
      const c = n % data.size
      min[c] = Math.min(min[c], data.values[n]); max[c] = Math.max(max[c], data.values[n])
    }
    if (data.accessor.min.length !== data.size || data.accessor.max.length !== data.size ||
        min.some((x, k) => !Number.isFinite(data.accessor.min[k]) || data.accessor.min[k] > x + 1e-6) ||
        max.some((x, k) => !Number.isFinite(data.accessor.max[k]) || data.accessor.max[k] < x - 1e-6)) {
      issue(issues, 'accessor-bounds', `Accessor ${i} min/max do not enclose the stored values.`)
    }
  }
}

function checkMeshes(json, bin, issues, getAccessor) {
  const topology = {
    meshes: json.meshes?.length ?? 0, primitives: 0, analyzedPrimitives: 0, skippedPrimitives: 0,
    openBoundaryEdges: 0, nonManifoldEdges: 0, inconsistentWindingEdges: 0, inwardClosedComponents: 0,
    degenerateTriangles: 0, duplicateFaces: 0,
  }
  for (const [mi, mesh] of (json.meshes ?? []).entries()) {
    if (!Array.isArray(mesh.primitives) || !mesh.primitives.length) {
      issue(issues, 'empty-mesh', `${mesh.name ?? `mesh ${mi}`} has no primitives to validate.`)
      continue
    }
    for (const [pi, prim] of (mesh.primitives ?? []).entries()) {
      topology.primitives++
      const label = `${mesh.name ?? `mesh ${mi}`} primitive ${pi}`
      if (prim.mode !== undefined && prim.mode !== 4) issue(issues, 'primitive-mode', `${label} is not a triangle list.`)
      if (!isIndex(prim.attributes?.POSITION, json.accessors?.length ?? 0)) {
        issue(issues, 'position-attribute', `${label} has no valid POSITION accessor.`)
        topology.skippedPrimitives++
        continue
      }
      const position = getAccessor(prim.attributes.POSITION)
      if (!position || position.size !== 3 || position.accessor.componentType !== 5126) {
        issue(issues, 'position-format', `${label} POSITION must be a float VEC3.`)
        topology.skippedPrimitives++
        continue
      }
      if (!position.accessor.min || !position.accessor.max) issue(issues, 'position-bounds', `${label} POSITION accessor must declare min/max bounds.`)
      for (const semantic of ['NORMAL', 'TANGENT', 'TEXCOORD_0']) {
        if (prim.attributes[semantic] === undefined) continue
        const data = getAccessor(prim.attributes[semantic])
        const size = { NORMAL: 3, TANGENT: 4, TEXCOORD_0: 2 }[semantic]
        if (data && (data.size !== size || data.accessor.count !== position.accessor.count)) {
          issue(issues, 'attribute-count', `${label} ${semantic} count/type does not match POSITION.`)
        }
      }
      const indexData = prim.indices === undefined ? null : getAccessor(prim.indices)
      if (prim.indices !== undefined && (!indexData || indexData.size !== 1 || ![5121, 5123, 5125].includes(indexData.accessor.componentType))) {
        issue(issues, 'index-format', `${label} indices must use an unsigned scalar accessor.`)
      }
      const indices = indexData?.values ?? Array.from({ length: position.accessor.count }, (_, i) => i)
      if (indices.length % 3) issue(issues, 'triangle-index-count', `${label} index count is not divisible by three.`)
      const invalid = indices.some((x) => !Number.isInteger(x) || x < 0 || x >= position.accessor.count)
      if (invalid) issue(issues, 'bad-index', `${label} references a vertex outside POSITION.`)
      if (invalid || !position.finite) {
        topology.skippedPrimitives++
        continue
      }
      topology.analyzedPrimitives++

      const normal = prim.attributes.NORMAL === undefined ? null : getAccessor(prim.attributes.NORMAL)
      const seenFaces = new Set(), edges = new Map(), sets = new Map(), faces = []
      let degenerate = 0, duplicate = 0, reversed = 0
      const find = (key) => {
        if (!sets.has(key)) sets.set(key, key)
        let parent = sets.get(key)
        while (parent !== sets.get(parent)) parent = sets.get(parent)
        let current = key
        while (sets.get(current) !== parent) {
          const next = sets.get(current)
          sets.set(current, parent)
          current = next
        }
        return parent
      }
      const union = (a, b) => {
        const ra = find(a), rb = find(b)
        if (ra !== rb) sets.set(rb, ra)
      }
      const pointKey = (i) => {
        const p = position.values.slice(i * 3, i * 3 + 3)
        return p.map((x) => Math.round(x * 1e6)).join(',')
      }
      const points = indices.length
      for (let t = 0; t + 2 < points; t += 3) {
        const ids = [indices[t], indices[t + 1], indices[t + 2]]
        const p = ids.map((i) => position.values.slice(i * 3, i * 3 + 3))
        const ab = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]]
        const ac = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]]
        const face = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]]
        const area2 = Math.hypot(...face)
        if (area2 < 1e-12) degenerate++
        const keys = ids.map(pointKey)
        union(keys[0], keys[1]); union(keys[1], keys[2])
        if (new Set(keys).size < 3) degenerate++
        const faceKey = [...keys].sort().join('|')
        if (seenFaces.has(faceKey)) duplicate++
        seenFaces.add(faceKey)
        const cross = [p[1][1] * p[2][2] - p[1][2] * p[2][1], p[1][2] * p[2][0] - p[1][0] * p[2][2], p[1][0] * p[2][1] - p[1][1] * p[2][0]]
        faces.push({ keys, volume: (p[0][0] * cross[0] + p[0][1] * cross[1] + p[0][2] * cross[2]) / 6 })
        for (let e = 0; e < 3; e++) {
          const a = keys[e], b = keys[(e + 1) % 3], forward = a < b
          const edge = forward ? `${a}|${b}` : `${b}|${a}`
          const entry = edges.get(edge) ?? { count: 0, direction: 0 }
          entry.count++; entry.direction += forward ? 1 : -1
          edges.set(edge, entry)
        }
        if (normal?.finite && area2 >= 1e-12) {
          const n = ids.map((i) => normal.values.slice(i * 3, i * 3 + 3))
          const average = [0, 1, 2].map((k) => (n[0][k] + n[1][k] + n[2][k]) / 3)
          if (face[0] * average[0] + face[1] * average[1] + face[2] * average[2] <= 0) reversed++
        }
      }
      topology.degenerateTriangles += degenerate
      topology.duplicateFaces += duplicate
      if (degenerate) issue(issues, 'degenerate-triangle', `${label} has ${degenerate} zero-area/duplicate-position triangle(s).`)
      if (duplicate) issue(issues, 'duplicate-face', `${label} has ${duplicate} duplicate triangle face(s) after welding UV seams.`)
      const components = new Map()
      for (const face of faces) {
        const root = find(face.keys[0])
        const component = components.get(root) ?? { volume: 0, open: 0, nonManifold: 0, inconsistent: 0 }
        component.volume += face.volume
        components.set(root, component)
      }
      let nonManifold = 0, open = 0, inconsistent = 0
      for (const [edge, entry] of edges) {
        const [a] = edge.split('|')
        const component = components.get(find(a))
        if (entry.count === 1) { open++; component.open++ }
        if (entry.count > 2) { nonManifold++; component.nonManifold++ }
        if (entry.count === 2 && entry.direction !== 0) { inconsistent++; component.inconsistent++ }
      }
      let inward = 0
      for (const component of components.values()) {
        if (!component.open && !component.nonManifold && !component.inconsistent && component.volume < -1e-18) inward++
      }
      topology.nonManifoldEdges += nonManifold
      topology.openBoundaryEdges += open
      topology.inconsistentWindingEdges += inconsistent
      topology.inwardClosedComponents += inward
      if (nonManifold) issue(issues, 'non-manifold-edge', `${label} has ${nonManifold} welded edges used by more than two faces.`)
      if (inconsistent) issue(issues, 'inconsistent-winding', `${label} has ${inconsistent} welded edges whose adjacent faces have the same winding.`)
      if (inward) issue(issues, 'inward-component', `${label} has ${inward} closed component(s) with inward winding/normals.`)
      if (reversed > Math.max(2, Math.floor(indices.length / 3 * 0.005))) {
        issue(issues, 'normal-winding', `${label} has ${reversed} triangles whose winding opposes their vertex normals.`)
      }
      if (normal?.finite) {
        let nonUnit = 0
        for (let i = 0; i < normal.values.length; i += 3) {
          const n = Math.hypot(normal.values[i], normal.values[i + 1], normal.values[i + 2])
          if (!Number.isFinite(n) || Math.abs(n - 1) > 0.05) nonUnit++
        }
        if (nonUnit) issue(issues, 'normal-length', `${label} has ${nonUnit} non-unit vertex normal(s).`)
      }
      if (prim.attributes.TANGENT !== undefined) {
        const tangent = getAccessor(prim.attributes.TANGENT)
        if (tangent?.finite) for (let i = 0; i < tangent.values.length; i += 4) {
          if (Math.abs(Math.abs(tangent.values[i + 3]) - 1) > 1e-4) {
            issue(issues, 'tangent-handedness', `${label} has a tangent with invalid handedness.`)
            break
          }
        }
      }
      for (const [kind, mapping] of Object.entries(prim.extensions?.KHR_materials_variants?.mappings ?? {})) {
        void kind
        if (!isIndex(mapping.material, json.materials?.length ?? 0) || !Array.isArray(mapping.variants) ||
            mapping.variants.some((variant) => !isIndex(variant, json.extensions?.KHR_materials_variants?.variants?.length ?? 0))) {
          issue(issues, 'variant-reference', `${label} has an invalid material-variant mapping.`)
        }
      }
      if (prim.material !== undefined && !isIndex(prim.material, json.materials?.length ?? 0)) {
        issue(issues, 'material-reference', `${label} references an invalid material.`)
      }
    }
  }
  return topology
}

const matIdentity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
function matMul(a, b) {
  const out = Array(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return out
}
function nodeMatrix(node) {
  if (node.matrix) return node.matrix
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = node.scale ?? [1, 1, 1]
  const tx = node.translation?.[0] ?? 0, ty = node.translation?.[1] ?? 0, tz = node.translation?.[2] ?? 0
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ]
}
function point(m, p) {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]
}
function direction(m, d) {
  return [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]]
}
function normalize(v) {
  const length = Math.hypot(...v) || 1
  return v.map((x) => x / length)
}
function collectTree(json, root, issues = null) {
  const indices = [], byName = new Map(), worlds = new Map(), parents = new Map(), visiting = new Set()
  const visit = (index, parent, parentWorld) => {
    if (!isIndex(index, json.nodes?.length ?? 0)) {
      if (issues) issue(issues, 'node-reference', `Node index ${index} is invalid.`)
      return
    }
    if (visiting.has(index) || worlds.has(index)) {
      if (issues) issue(issues, 'node-cycle', `Node ${index} is repeated or cyclic in the scene hierarchy.`)
      return
    }
    visiting.add(index)
    const node = json.nodes[index]
    const world = matMul(parentWorld, nodeMatrix(node))
    indices.push(index); parents.set(index, parent); worlds.set(index, world)
    if (node.name) {
      if (byName.has(node.name) && issues) issue(issues, 'duplicate-node-name', `Node name "${node.name}" is not unique within a LOD.`)
      byName.set(node.name, index)
    }
    for (const child of node.children ?? []) visit(child, index, world)
    visiting.delete(index)
  }
  visit(root, null, matIdentity())
  return { indices, byName, worlds, parents, _json: json }
}

function checkHierarchy(tree, profile, issues) {
  for (const [parentName, childNames] of Object.entries(profile.hierarchy)) {
    const parentIndex = tree.byName.get(parentName)
    if (parentIndex === undefined) {
      issue(issues, 'missing-node', `Required hierarchy node "${parentName}" is missing.`)
      continue
    }
    const children = new Set((tree._json.nodes[parentIndex].children ?? []).map((i) => tree._json.nodes[i]?.name))
    for (const child of childNames) if (!children.has(child)) issue(issues, 'hierarchy-child', `"${parentName}" is missing required direct child "${child}".`)
  }
}

function checkScale(json, tree, issues) {
  for (const index of tree.indices) {
    const node = json.nodes[index]
    let scales
    if (node.scale) scales = node.scale
    else if (node.matrix) scales = [Math.hypot(node.matrix[0], node.matrix[1], node.matrix[2]), Math.hypot(node.matrix[4], node.matrix[5], node.matrix[6]), Math.hypot(node.matrix[8], node.matrix[9], node.matrix[10])]
    if (scales && scales.some((x) => !Number.isFinite(x) || Math.abs(x - 1) > 1e-4)) {
      issue(issues, 'unapplied-scale', `Node "${node.name ?? index}" has scale ${scales.join(', ')} instead of applied unit scale.`)
    }
    if (node.matrix) {
      const x = node.matrix.slice(0, 3), y = node.matrix.slice(4, 7), z = node.matrix.slice(8, 11)
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
      const determinant = dot(x, [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]])
      if (Math.abs(dot(x, y)) > 1e-4 || Math.abs(dot(x, z)) > 1e-4 || Math.abs(dot(y, z)) > 1e-4 || determinant < 0.999) {
        issue(issues, 'node-basis', `Node "${node.name ?? index}" has a reflected, sheared, or non-rigid matrix transform.`)
      }
    }
  }
}

function checkNoEnvironment(json, tree, issues) {
  if (json.animations?.length) issue(issues, 'animation-data', 'The kit must be animation-ready, not contain baked animation clips.')
  if (json.cameras?.length) issue(issues, 'camera', 'The asset must not include cameras.')
  if (json.extensions?.KHR_lights_punctual || json.extensionsUsed?.includes('KHR_lights_punctual')) issue(issues, 'lights', 'The asset must not include lights.')
  const banned = /(?:^|[_-])(camera|light|backdrop|floor.?plane|ground|reference|measurement|studio|logo|brand|annotation)(?:[_-]|$)/i
  for (const index of tree.indices) {
    const node = json.nodes[index]
    if (node.camera !== undefined || node.extensions?.KHR_lights_punctual) issue(issues, 'environment-node', `Node "${node.name}" contains a camera or light.`)
    if (banned.test(node.name ?? '')) issue(issues, 'environment-object', `Node "${node.name}" resembles excluded environment/reference content.`)
  }
}

function textureImageIndex(json, textureIndex) {
  if (!isIndex(textureIndex, json.textures?.length ?? 0)) return null
  const texture = json.textures[textureIndex]
  const source = texture.source ?? texture.extensions?.KHR_texture_basisu?.source
  return isIndex(source, json.images?.length ?? 0) ? source : null
}
function checkMaterials(json, bin, profile, geometryOnly, issues) {
  const named = new Map()
  for (const [i, material] of (json.materials ?? []).entries()) {
    if (material.name) named.set(material.name, i)
    const pbr = material.pbrMetallicRoughness
    if (!pbr || (pbr.metallicFactor !== undefined && (pbr.metallicFactor < 0 || pbr.metallicFactor > 1)) ||
        (pbr.roughnessFactor !== undefined && (pbr.roughnessFactor < 0 || pbr.roughnessFactor > 1))) {
      issue(issues, 'material-pbr', `Material "${material.name ?? i}" has invalid PBR factors.`)
    }
    const refs = [pbr?.baseColorTexture, pbr?.metallicRoughnessTexture, material.normalTexture, material.occlusionTexture, material.emissiveTexture].filter(Boolean)
    for (const ref of refs) if (!isIndex(ref.index, json.textures?.length ?? 0)) issue(issues, 'texture-reference', `Material "${material.name ?? i}" references an invalid texture.`)
  }
  for (const name of profile.materials) if (!named.has(name)) issue(issues, 'required-material', `Required PBR material "${name}" is missing.`)
  for (const image of json.images ?? []) {
    if (image.uri !== undefined) continue
    if (image.mimeType !== 'image/png' || !isIndex(image.bufferView, json.bufferViews?.length ?? 0)) {
      issue(issues, 'embedded-image', 'Every image must be an embedded PNG referenced by bufferView, not a URI.')
    }
  }
  if (geometryOnly) return { named, sizes: [] }

  if (!json.images?.length || !json.textures?.length) issue(issues, 'missing-pbr-textures', 'Full validation requires embedded PBR texture images.')
  const realisticMaterials = profile.materials.map((name) => [name, named.get(name)]).filter(([, i]) => i !== undefined)
  const sizes = []
  for (const [name, i] of realisticMaterials) {
    const material = json.materials[i], pbr = material.pbrMetallicRoughness ?? {}
    if (!pbr.baseColorTexture || !pbr.metallicRoughnessTexture) {
      issue(issues, 'missing-pbr-map', `Realistic material "${name}" must embed base-color and metallic/roughness maps.`)
    }
    const refs = [pbr.baseColorTexture, pbr.metallicRoughnessTexture, material.normalTexture, material.occlusionTexture].filter(Boolean)
    for (const ref of refs) if (textureImageIndex(json, ref.index) === null) issue(issues, 'texture-source', `Material "${name}" uses a texture without a valid embedded image source.`)
    const baseImage = pbr.baseColorTexture && textureImageIndex(json, pbr.baseColorTexture.index)
    if (baseImage !== null && baseImage !== undefined) {
      const dim = pngDimensions(json, bin, baseImage)
      if (dim) sizes.push({ material: name, width: dim[0], height: dim[1] })
    }
  }
  const missingNormal = realisticMaterials.filter(([, i]) => json.materials[i]?.normalTexture).length === 0
  if (missingNormal) issue(issues, 'missing-normal-maps', 'Realistic PBR materials must include tangent-space normal maps.')
  for (const name of profile.primaryMaterials) {
    const i = named.get(name)
    const texture = i === undefined ? null : json.materials[i]?.pbrMetallicRoughness?.baseColorTexture
    const image = texture && textureImageIndex(json, texture.index)
    const dim = image === null || image === undefined ? null : pngDimensions(json, bin, image)
    if (!dim || dim[0] < 1024 || dim[1] < 1024) issue(issues, 'primary-texture-size', `Primary material "${name}" should have an embedded map of at least 1024×1024.`)
  }
  return { named, sizes }
}

function pngDimensions(json, bin, imageIndex) {
  const view = json.bufferViews?.[json.images?.[imageIndex]?.bufferView]
  if (!view) return null
  const start = view.byteOffset ?? 0
  const bytes = bin.subarray(start, start + view.byteLength)
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (!width || !height) return null
  return [width, height]
}

function checkVariants(json, tree, profile, issues) {
  const variants = json.extensions?.KHR_materials_variants?.variants ?? []
  const names = variants.map((variant) => variant.name)
  if (!json.extensionsUsed?.includes('KHR_materials_variants')) issue(issues, 'variant-extension', 'extensionsUsed must include KHR_materials_variants.')
  if (LOOKS.some((name, i) => names[i] !== name) || names.length !== LOOKS.length) {
    issue(issues, 'variant-list', `Material variants must be exactly: ${LOOKS.join(', ')}.`)
  }
  const seen = new Set()
  for (const nodeIndex of tree.indices) {
    const meshIndex = json.nodes[nodeIndex].mesh
    if (meshIndex === undefined || !isIndex(meshIndex, json.meshes?.length ?? 0)) continue
    for (const [pi, prim] of json.meshes[meshIndex].primitives.entries()) {
      const mappings = prim.extensions?.KHR_materials_variants?.mappings ?? []
      const byVariant = new Map()
      for (const mapping of mappings) for (const variant of mapping.variants ?? []) {
        byVariant.set(variant, mapping.material)
        seen.add(variant)
      }
      for (let variant = 0; variant < LOOKS.length; variant++) {
        const material = byVariant.get(variant)
        if (material === undefined) issue(issues, 'variant-coverage', `Node "${json.nodes[nodeIndex].name}" primitive ${pi} has no ${LOOKS[variant]} mapping.`)
        else if (json.materials[material]?.extras?.look && json.materials[material].extras.look !== LOOKS[variant]) {
          issue(issues, 'variant-material-look', `Node "${json.nodes[nodeIndex].name}" maps ${LOOKS[variant]} to a differently labeled material.`)
        }
      }
      const mat = prim.material === undefined ? null : json.materials[prim.material]
      const normalTexture = mat?.normalTexture || [...byVariant.values()].some((index) => json.materials[index]?.normalTexture)
      if (normalTexture && prim.attributes?.TANGENT === undefined) {
        issue(issues, 'normal-map-tangent', `Node "${json.nodes[nodeIndex].name}" uses a normal map without tangents.`)
      }
    }
  }
  if (LOOKS.some((_, i) => !seen.has(i))) issue(issues, 'variant-unused', 'One or more required look variants are not mapped to geometry.')
  const lowPoly = json.nodes[tree.indices[0]]?.extras?.lod?.lowPolyLook
  if (lowPoly?.lod !== profile.lowPolyLod) issue(issues, 'low-poly-routing', `LowPoly must route to LOD${profile.lowPolyLod}.`)
}

function checkNeon(json, tree, profile, issues) {
  const found = new Map()
  for (const index of tree.indices) {
    const meshIndex = json.nodes[index].mesh
    if (meshIndex === undefined) continue
    for (const prim of json.meshes[meshIndex]?.primitives ?? []) {
      for (const mapping of prim.extensions?.KHR_materials_variants?.mappings ?? []) {
        const material = json.materials[mapping.material]
        const extra = material?.extras
        if (extra?.look === 'NeonRhythm' && extra.component) {
          if (extra.gameplayColor !== NEON[extra.component]) issue(issues, 'neon-palette', `Neon material for ${extra.component} does not use the required component palette.`)
          found.set(extra.component, true)
        }
      }
    }
  }
  for (const component of profile.neonComponents) if (!found.has(component)) issue(issues, 'neon-component', `NeonRhythm has no edge accent for ${component}.`)
}

function findNode(json, tree, name) {
  const index = tree.byName.get(name)
  return index === undefined ? null : { index, node: json.nodes[index], world: tree.worlds.get(index) }
}
function checkPlayableAndPivots(json, tree, profile, issues, getAccessor) {
  const surfaces = json.nodes[tree.indices[0]]?.extras?.playableSurfaces
  if (!Array.isArray(surfaces) || surfaces.length !== profile.playable.length ||
      profile.playable.some((name) => !surfaces.includes(name))) {
    issue(issues, 'playable-metadata', 'Root playableSurfaces metadata does not match the exact kit contract.')
  }
  for (const name of profile.playable) {
    const found = findNode(json, tree, name)
    if (!found) { issue(issues, 'playable-node', `Playable surface "${name}" is missing.`); continue }
    if (found.node.mesh === undefined && !(found.node.children ?? []).length) issue(issues, 'playable-geometry', `Playable surface "${name}" has no geometry.`)
    const meshIndex = found.node.mesh
    if (meshIndex !== undefined) for (const prim of json.meshes[meshIndex]?.primitives ?? []) {
      if (prim.attributes?.TEXCOORD_0 === undefined) issue(issues, 'missing-uv', `Playable surface "${name}" has no UV coordinates.`)
    }
    const dimensions = measurePart(json, tree, found.index, getAccessor)
    const expected = profile.playableDiameters[name]
    if (dimensions && expected !== undefined && Math.abs(dimensions.diameter - expected) > 0.025) {
      issue(issues, 'part-dimension', `${name} diameter is ${dimensions.diameter.toFixed(3)} m; expected about ${expected.toFixed(3)} m.`)
    }
    if (dimensions && (Math.abs(dimensions.center[0]) > 0.01 || Math.abs(dimensions.center[2]) > 0.01)) {
      issue(issues, 'surface-pivot', `${name} geometry is not centered on its local playing-surface pivot.`)
    }
  }
  for (const [name, [diameter, depth]] of Object.entries(profile.shellDimensions ?? {})) {
    const found = findNode(json, tree, name)
    const dimensions = found && measurePart(json, tree, found.index, getAccessor)
    if (dimensions && (Math.abs(dimensions.diameter - diameter) > 0.02 || Math.abs(dimensions.size[1] - depth) > 0.02)) {
      issue(issues, 'shell-dimension', `${name} measures ${dimensions.diameter.toFixed(3)} m × ${dimensions.size[1].toFixed(3)} m; expected about ${diameter.toFixed(3)} m × ${depth.toFixed(3)} m.`)
    }
    if (dimensions && dimensions.center.some((x) => Math.abs(x) > 0.01)) issue(issues, 'shell-pivot', `${name} geometry is not centered on its local shell-center pivot.`)
  }
  for (const [name, pivot] of profile.pivots) {
    const found = findNode(json, tree, name)
    if (!found) { issue(issues, 'pivot-node', `Pivot-bearing node "${name}" is missing.`); continue }
    if (!String(found.node.extras?.pivot ?? '').toLowerCase().includes(pivot.toLowerCase())) {
      issue(issues, 'pivot-metadata', `"${name}" must declare pivot "${pivot}".`)
    }
  }
  const root = json.nodes[tree.indices[0]]
  const hatStates = root?.extras?.hiHatStates
  const hatNode = findNode(json, tree, profile.root === 'AcousticDrumKit' ? 'HiHat_TopCymbal' : 'HiHat_Cymbal')
  if (!hatNode || !hatNode.node.extras?.states ||
      !['fullyOpen', 'partiallyOpen', 'closed', 'pedalClosed'].every((name) => Number.isFinite(hatNode.node.extras.states[name])) ||
      (hatStates && !['fullyOpen', 'partiallyOpen', 'closed', 'pedalClosed'].every((name) => Number.isFinite(hatStates[name])))) {
    issue(issues, 'hi-hat-states', 'Hi-hat must publish open, partially open, closed, and pedal-closed travel states.')
  }
  for (const name of profile.root === 'AcousticDrumKit' ? ['Kick', 'Snare', 'TomHigh', 'TomMid', 'FloorTom'] : []) {
    const drum = findNode(json, tree, name), shell = findNode(json, tree, `${name}_Shell`)
    if (drum && shell) {
      const a = drum.world, b = shell.world
      if (Math.hypot(a[12] - b[12], a[13] - b[13], a[14] - b[14]) > 1e-4) {
        issue(issues, 'shell-pivot', `${name} root and shell geometry must share the shell-center pivot.`)
      }
    }
  }
  const seat = findNode(json, tree, 'Throne_Seat')
  const seatDimensions = seat && measurePart(json, tree, seat.index, getAccessor)
  if (seat && seatDimensions && (seat.world[13] + seatDimensions.max[1] < 0.45 || seat.world[13] + seatDimensions.max[1] > 0.65)) {
    issue(issues, 'throne-height', 'Throne seat height must be adjustable to the 0.45–0.65 m range.')
  }
}

function checkLayout(json, tree, profile, issues) {
  const locations = [
    ['HiHat', 'left'], ['Crash_Cymbal', 'left'], ['Snare', 'left'], ['TomHigh', 'left'],
    ['TomMid', 'right'], ['FloorTom', 'right'], ['Ride_Cymbal', 'right'], ['Kick', 'center'], ['Throne', 'center'],
  ]
  for (const [name, side] of locations) {
    const found = findNode(json, tree, name)
    if (!found) continue
    const x = found.world[12]
    if ((side === 'left' && x >= -0.01) || (side === 'right' && x <= 0.01) || (side === 'center' && Math.abs(x) > 0.05)) {
      issue(issues, 'player-layout', `${name} is not positioned on the required player-${side} side.`)
    }
  }
  const kick = findNode(json, tree, 'Kick')
  const throne = findNode(json, tree, 'Throne')
  if (kick && throne && throne.world[14] <= kick.world[14]) issue(issues, 'player-layout', 'Throne must be behind the kick toward player +Z.')
}

function measurePart(json, tree, rootIndex, getAccessor) {
  const rootWorld = tree.worlds.get(rootIndex)
  if (!rootWorld) return null
  const inverse = matIdentity()
  // Unit-scale node transforms are required, so the transpose of the root rotation is its inverse.
  inverse[0] = rootWorld[0]; inverse[1] = rootWorld[4]; inverse[2] = rootWorld[8]
  inverse[4] = rootWorld[1]; inverse[5] = rootWorld[5]; inverse[6] = rootWorld[9]
  inverse[8] = rootWorld[2]; inverse[9] = rootWorld[6]; inverse[10] = rootWorld[10]
  const t = [rootWorld[12], rootWorld[13], rootWorld[14]]
  inverse[12] = -(inverse[0] * t[0] + inverse[4] * t[1] + inverse[8] * t[2])
  inverse[13] = -(inverse[1] * t[0] + inverse[5] * t[1] + inverse[9] * t[2])
  inverse[14] = -(inverse[2] * t[0] + inverse[6] * t[1] + inverse[10] * t[2])
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  let radius = 0
  for (const index of descendants(json, rootIndex)) {
    const node = json.nodes[index]
    if (node.name?.startsWith('COL_') || node.extras?.collider || node.mesh === undefined) continue
    const toRoot = matMul(inverse, tree.worlds.get(index))
    for (const prim of json.meshes[node.mesh]?.primitives ?? []) {
      const pos = getAccessor(prim.attributes.POSITION)
      const idx = prim.indices === undefined ? Array.from({ length: pos?.accessor.count ?? 0 }, (_, i) => i) : getAccessor(prim.indices)?.values ?? []
      if (!pos) continue
      for (const i of idx) {
        const p = point(toRoot, pos.values.slice(i * 3, i * 3 + 3))
        radius = Math.max(radius, Math.hypot(p[0], p[2]))
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], p[k])
          max[k] = Math.max(max[k], p[k])
        }
      }
    }
  }
  if (!radius) return null
  const size = min.map((x, k) => max[k] - x)
  return { diameter: radius * 2, min, max, size, center: min.map((x, k) => (max[k] + x) / 2) }
}

function descendants(json, rootIndex) {
  const out = []
  const visit = (i) => {
    out.push(i)
    for (const child of json.nodes[i]?.children ?? []) if (isIndex(child, json.nodes.length)) visit(child)
  }
  visit(rootIndex)
  return out
}

function checkColliders(json, tree, profile, issues) {
  const metadata = json.nodes[tree.indices[0]]?.extras?.colliders
  if (!Array.isArray(metadata) || metadata.length !== profile.colliders.length || profile.colliders.some((name) => !metadata.includes(name))) {
    issue(issues, 'collider-metadata', 'Root colliders metadata does not match the exact kit contract.')
  }
  for (const name of profile.colliders) {
    const found = findNode(json, tree, name)
    if (!found) { issue(issues, 'collider-node', `Required collider "${name}" is missing.`); continue }
    const collider = found.node.extras?.collider
    if (!collider || collider.convex !== true || collider.type !== profile.collisionShapes[name]) {
      issue(issues, 'collider-shape', `"${name}" must be a simple convex ${profile.collisionShapes[name]} collider.`)
      continue
    }
    if (collider.axis !== 'y' || !(collider.height > 0) ||
        (collider.type === 'cylinder' && !(collider.radius > 0)) ||
        (collider.type === 'ring' && (!(collider.innerRadius >= 0) || !(collider.outerRadius > collider.innerRadius)))) {
      issue(issues, 'collider-dimensions', `"${name}" has invalid axis or dimensions.`)
    }
    const expectedSurface = profile.collisionSurfaces[name]
    const surface = findNode(json, tree, expectedSurface)
    if (collider.surface !== expectedSurface || !surface) {
      issue(issues, 'collider-target', `"${name}" must target playable surface "${expectedSurface}".`)
    } else {
      const parent = tree.parents.get(found.index)
      if (json.nodes[parent]?.name !== profile.collisionParents[name]) issue(issues, 'collider-parent', `"${name}" is not parented under "${profile.collisionParents[name]}".`)
      const delta = Math.hypot(found.world[12] - surface.world[12], found.world[13] - surface.world[13], found.world[14] - surface.world[14])
      const axisA = normalize(direction(found.world, [0, 1, 0])), axisB = normalize(direction(surface.world, [0, 1, 0]))
      if (delta > 0.04 || Math.abs(axisA[0] * axisB[0] + axisA[1] * axisB[1] + axisA[2] * axisB[2]) < 0.98) {
        issue(issues, 'collider-alignment', `"${name}" is not aligned with its declared playable surface.`)
      }
      if (found.node.mesh !== undefined) issue(issues, 'collider-render-mesh', `"${name}" must be collision metadata only, with no rendered mesh.`)
      if (descendants(json, found.index).some((index) => json.nodes[index].mesh !== undefined)) {
        issue(issues, 'collider-render-mesh', `"${name}" collider subtree must contain no rendered geometry.`)
      }
    }
  }
  for (const index of tree.indices) if (json.nodes[index].name?.startsWith('COL_') && json.nodes[index].mesh !== undefined) {
    issue(issues, 'collider-render-mesh', `Collision node "${json.nodes[index].name}" must not add render triangles.`)
  }
}

function checkMatRefs(json, issues) {
  for (const [mi, mesh] of (json.meshes ?? []).entries()) for (const [pi, prim] of (mesh.primitives ?? []).entries()) {
    const label = `${mesh.name ?? mi} primitive ${pi}`
    if (prim.material !== undefined && !isIndex(prim.material, json.materials?.length ?? 0)) issue(issues, 'material-reference', `${label} references an invalid material.`)
    const mappings = prim.extensions?.KHR_materials_variants?.mappings ?? []
    for (const mapping of mappings) if (!isIndex(mapping.material, json.materials?.length ?? 0)) issue(issues, 'variant-material-reference', `${label} has an invalid variant material reference.`)
  }
  for (const texture of json.textures ?? []) {
    if (texture.sampler !== undefined && !isIndex(texture.sampler, json.samplers?.length ?? 0)) issue(issues, 'sampler-reference', 'Texture references an invalid sampler.')
    if (textureImageIndex(json, json.textures.indexOf(texture)) === null) issue(issues, 'texture-source', 'Texture has no valid embedded image source.')
  }
}

function instanceMatrices(json, node, getAccessor, issues) {
  const attrs = node.extensions?.EXT_mesh_gpu_instancing?.attributes
  if (!attrs) return [matIdentity()]
  const data = {}
  for (const [name, accessor] of Object.entries(attrs)) data[name] = getAccessor(accessor)
  const translation = data.TRANSLATION, rotation = data.ROTATION, scale = data.SCALE
  const count = translation?.accessor.count ?? rotation?.accessor.count ?? scale?.accessor.count
  if (!Number.isInteger(count) || Object.values(data).some((value) => !value || value.accessor.count !== count)) {
    issue(issues, 'instance-attributes', `Node "${node.name}" has mismatched GPU instance attribute counts.`)
    return []
  }
  return Array.from({ length: count }, (_, i) => {
    const t = translation?.values.slice(i * 3, i * 3 + 3) ?? [0, 0, 0]
    const r = rotation?.values.slice(i * 4, i * 4 + 4) ?? [0, 0, 0, 1]
    const s = scale?.values.slice(i * 3, i * 3 + 3) ?? [1, 1, 1]
    const fakeNode = { translation: t, rotation: r, scale: s }
    if (s.some((x) => Math.abs(x - 1) > 1e-4)) issue(issues, 'unapplied-instance-scale', `Node "${node.name}" GPU instance ${i} has unapplied scale.`)
    return nodeMatrix(fakeNode)
  })
}

function measureLod(json, tree, root, getAccessor, issues) {
  let triangles = 0
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
  for (const index of tree.indices) {
    const node = json.nodes[index]
    if (node.name?.startsWith('COL_') || node.extras?.collider) continue
    if (node.mesh === undefined || !isIndex(node.mesh, json.meshes?.length ?? 0)) continue
    const instances = instanceMatrices(json, node, getAccessor, issues)
    for (const instance of instances) for (const prim of json.meshes[node.mesh].primitives ?? []) {
      const pos = getAccessor(prim.attributes?.POSITION)
      if (!pos || pos.size !== 3) continue
      const idx = prim.indices === undefined ? Array.from({ length: pos.accessor.count }, (_, i) => i) : getAccessor(prim.indices)?.values
      if (!idx) continue
      if ((prim.mode ?? 4) === 4) triangles += Math.floor(idx.length / 3)
      const matrix = matMul(tree.worlds.get(index), instance)
      for (const id of idx) {
        if (!Number.isInteger(id) || id < 0 || id >= pos.accessor.count) continue
        const p = point(matrix, pos.values.slice(id * 3, id * 3 + 3))
        for (let k = 0; k < 3; k++) {
          bounds.min[k] = Math.min(bounds.min[k], p[k])
          bounds.max[k] = Math.max(bounds.max[k], p[k])
        }
      }
    }
  }
  return { triangles, bounds: Number.isFinite(bounds.min[0]) ? bounds : null }
}

function outerRim(json, tree, name, getAccessor, lod, issues) {
  const index = tree.byName.get(name)
  const node = index === undefined ? null : json.nodes[index]
  const world = index === undefined ? null : tree.worlds.get(index)
  if (!node || node.mesh === undefined || !isIndex(node.mesh, json.meshes?.length ?? 0) || !world) {
    issue(issues, 'hi-hat-rim-geometry', `LOD${lod} ${name} has no transformable cymbal mesh for rim-clearance validation.`)
    return null
  }
  if (world.some((value) => !Number.isFinite(value))) {
    issue(issues, 'hi-hat-rim-geometry', `LOD${lod} ${name} has a non-finite world transform.`)
    return null
  }
  const vertices = []
  let radius = 0
  for (const prim of json.meshes[node.mesh].primitives ?? []) {
    const positions = getAccessor(prim.attributes?.POSITION)
    if (!positions || positions.size !== 3 || !positions.finite) continue
    const indices = prim.indices === undefined
      ? Array.from({ length: positions.accessor.count }, (_, i) => i)
      : getAccessor(prim.indices)?.values ?? []
    for (const i of indices) {
      if (!Number.isInteger(i) || i < 0 || i >= positions.accessor.count) continue
      const local = positions.values.slice(i * 3, i * 3 + 3)
      const radial = Math.hypot(local[0], local[2])
      radius = Math.max(radius, radial)
      vertices.push({ local, radial })
    }
  }
  const rim = vertices.filter(({ radial }) => radial >= radius - 0.001)
  if (rim.length < 3 || radius <= 0) {
    issue(issues, 'hi-hat-rim-geometry', `LOD${lod} ${name} has fewer than three outer-rim vertices.`)
    return null
  }
  return { radius, points: rim.map(({ local }) => point(world, local)) }
}

function checkAcousticHiHatRim(json, tree, getAccessor, lod, issues) {
  const bottom = outerRim(json, tree, 'HiHat_BottomCymbal', getAccessor, lod, issues)
  const top = outerRim(json, tree, 'HiHat_TopCymbal', getAccessor, lod, issues)
  if (!bottom || !top) return
  const topIndex = tree.byName.get('HiHat_TopCymbal')
  const topNode = json.nodes[topIndex]
  const axis = topNode.extras?.travelAxis
  const states = topNode.extras?.states
  if (!Array.isArray(axis) || axis.length !== 3 || axis.some((x) => !Number.isFinite(x)) || Math.hypot(...axis) < 1e-8 ||
      !states || !['fullyOpen', 'partiallyOpen', 'closed', 'pedalClosed'].every((state) => Number.isFinite(states[state]))) {
    issue(issues, 'hi-hat-rim-state', `LOD${lod} HiHat_TopCymbal must declare a valid travelAxis and all four state offsets.`)
    return
  }
  const transformedAxis = direction(tree.worlds.get(topIndex), axis)
  if (transformedAxis.some((value) => !Number.isFinite(value)) || Math.hypot(...transformedAxis) < 1e-8) {
    issue(issues, 'hi-hat-rim-state', `LOD${lod} HiHat_TopCymbal has an invalid world-space travel axis.`)
    return
  }
  const travel = normalize(transformedAxis)
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const project = (p) => dot(p, travel)
  const bottomHigh = Math.max(...bottom.points.map(project))
  const center = (points) => [0, 1, 2].map((k) => points.reduce((sum, p) => sum + p[k], 0) / points.length)
  const topCenter = center(top.points), bottomCenter = center(bottom.points)
  const delta = topCenter.map((x, k) => x - bottomCenter[k])
  const lateral = Math.hypot(...delta.map((x, k) => x - travel[k] * dot(delta, travel)))
  if (lateral > 0.01 || Math.abs(top.radius - bottom.radius) > 0.005) {
    issue(issues, 'hi-hat-rim-alignment', `LOD${lod} hi-hat outer rims do not share the pull-rod axis and radius (offset ${lateral.toFixed(3)} m, radii ${bottom.radius.toFixed(3)}/${top.radius.toFixed(3)} m).`)
  }
  const gaps = {}
  for (const state of ['fullyOpen', 'partiallyOpen', 'closed', 'pedalClosed']) {
    const offset = states[state]
    const topLow = Math.min(...top.points.map((p) => project(p) + offset))
    gaps[state] = topLow - bottomHigh
  }
  for (const state of ['closed', 'pedalClosed']) {
    if (gaps[state] < -0.003 - 1e-6 || gaps[state] > 0.005 + 1e-6) {
      issue(issues, 'hi-hat-rim-clearance', `LOD${lod} ${state} outer-rim clearance is ${gaps[state].toFixed(4)} m; cymbals must meet within -0.003–0.005 m.`)
    }
  }
  if (gaps.partiallyOpen <= 0.005 || gaps.partiallyOpen <= gaps.closed + 0.005) {
    issue(issues, 'hi-hat-rim-clearance', `LOD${lod} partiallyOpen outer-rim clearance is ${gaps.partiallyOpen.toFixed(4)} m; it must clear the closed rims.`)
  }
  if (gaps.fullyOpen <= gaps.partiallyOpen + 0.005) {
    issue(issues, 'hi-hat-rim-clearance', `LOD${lod} fullyOpen outer-rim clearance is ${gaps.fullyOpen.toFixed(4)} m; it must exceed partiallyOpen clearance.`)
  }
}

function checkBudgets(profile, triangles, issues) {
  triangles.forEach((count, lod) => {
    const [min, max] = profile.budgets[lod]
    if (count < min || count > max) issue(issues, 'triangle-budget', `LOD${lod} has ${count.toLocaleString()} triangles; required ${min.toLocaleString()}–${max.toLocaleString()}.`)
  })
  const count = triangles[profile.lowPolyLod]
  if (count !== undefined && (count < profile.lowPolyBudget[0] || count > profile.lowPolyBudget[1])) {
    issue(issues, 'low-poly-budget', `LowPoly LOD${profile.lowPolyLod} has ${count.toLocaleString()} triangles; required ${profile.lowPolyBudget[0].toLocaleString()}–${profile.lowPolyBudget[1].toLocaleString()}.`)
  }
}

function checkBounds(bounds, profile, issues) {
  if (!bounds) { issue(issues, 'empty-bounds', 'No visible indexed geometry was found for this LOD.'); return null }
  const size = bounds.min.map((x, k) => bounds.max[k] - x)
  if (bounds.min[1] < -0.025 || bounds.min[1] > 0.025) issue(issues, 'ground-contact', `Ground/root lowest Y is ${bounds.min[1].toFixed(3)} m; expected the ground near Y=0.`)
  if (profile.boundRanges) for (let k = 0; k < 3; k++) {
    const [min, max] = profile.boundRanges[k]
    if (size[k] < min || size[k] > max) issue(issues, 'dimension-bounds', `Assembled ${['width', 'height', 'depth'][k]} is ${size[k].toFixed(3)} m; required ${min.toFixed(2)}–${max.toFixed(2)} m.`)
  }
  if (profile.boundMax) for (let k = 0; k < 3; k++) {
    if (size[k] > profile.boundMax[k]) issue(issues, 'dimension-bounds', `Assembled ${['width', 'height', 'depth'][k]} is ${size[k].toFixed(3)} m; maximum is ${profile.boundMax[k].toFixed(2)} m.`)
  }
  return size
}

function checkLods(json, rootIndex, profile, bin, issues) {
  const rootNode = json.nodes[rootIndex]
  const ids = rootNode.extensions?.MSFT_lod?.ids
  if (!Array.isArray(ids) || ids.length !== 2 || ids.some((i) => !isIndex(i, json.nodes.length)) || new Set(ids).size !== 2) {
    issue(issues, 'lod-roots', 'LOD0 root must reference two distinct valid MSFT_lod roots.')
    return null
  }
  const roots = [rootIndex, ...ids]
  const sceneNodes = json.scenes?.[json.scene]?.nodes ?? []
  if (sceneNodes.length !== 1 || sceneNodes[0] !== rootIndex || ids.some((id) => sceneNodes.includes(id))) {
    issue(issues, 'lod-scene-roots', 'Only LOD0 may be active in the scene; LOD1/LOD2 are referenced by MSFT_lod only.')
  }
  if (!json.extensionsUsed?.includes('MSFT_lod')) issue(issues, 'lod-extension', 'extensionsUsed must include MSFT_lod.')
  const getAccessor = makeAccessorReader(json, bin, issues)
  const trees = roots.map((root) => collectTree(json, root, issues))
  const stableNames = new Set([
    ...Object.keys(profile.hierarchy),
    ...Object.values(profile.hierarchy).flat(),
    ...profile.playable,
    ...profile.colliders,
    ...profile.pivots.map(([name]) => name),
  ])
  const metrics = trees.map((tree, i) => {
    checkHierarchy(tree, profile, issues)
    checkScale(json, tree, issues)
    if (profile.root === 'AcousticDrumKit') checkAcousticHiHatRim(json, tree, getAccessor, i, issues)
    if (i > 0) {
      const base = trees[0]
      for (const name of stableNames) {
        const a = base.byName.get(name), b = tree.byName.get(name)
        if (a === undefined || b === undefined) {
          issue(issues, 'lod-node-identity', `LOD${i} does not preserve required node "${name}".`)
          continue
        }
        const na = json.nodes[a], nb = json.nodes[b]
        const ma = nodeMatrix(na), mb = nodeMatrix(nb)
        if (json.nodes[base.parents.get(a)]?.name !== json.nodes[tree.parents.get(b)]?.name ||
            ma.some((value, k) => !approx(value, mb[k], 1e-5)) ||
            JSON.stringify(na.extras?.pivot ?? null) !== JSON.stringify(nb.extras?.pivot ?? null)) {
          issue(issues, 'lod-pivot-identity', `LOD${i} changes "${name}" hierarchy, local transform, or pivot metadata.`)
        }
      }
    }
    return measureLod(json, tree, roots[i], getAccessor, issues)
  })
  const counts = metrics.map((metric) => metric.triangles)
  checkBudgets(profile, counts, issues)
  const declared = rootNode.extras?.lod?.triangles
  if (!Array.isArray(declared) || declared.length !== 3 || declared.some((x, i) => x !== counts[i])) {
    issue(issues, 'lod-count-metadata', `Actual indexed LOD triangles (${counts.join('/')}) differ from root extras.lod.triangles.`)
  }
  if (rootNode.extras?.lod?.lowPolyLook?.triangles !== counts[profile.lowPolyLod]) {
    issue(issues, 'low-poly-metadata', 'lowPolyLook.triangles does not match actual indexed triangle count.')
  }
  if (rootNode.extras?.units !== 'metres' || rootNode.extras?.up !== '+Y' ||
      rootNode.extras?.forward !== '-Z (from the throne toward the audience)' ||
      rootNode.extras?.playerLeft !== '-X' || rootNode.extras?.origin !== 'player centreline on the floor') {
    issue(issues, 'coordinate-metadata', 'Root must declare metric units, +Y up, -Z forward, -X player-left, and floor-centreline origin.')
  }
  const size = checkBounds(metrics[0]?.bounds, profile, issues)
  return { trees, roots, counts, bounds: metrics[0]?.bounds ?? null, size }
}

function checkRoot(json, profile, tree, issues) {
  const root = json.nodes[tree.indices[0]]
  if (root.name !== profile.root || root.mesh !== undefined) issue(issues, 'kit-root', `Active scene root must be empty and named "${profile.root}".`)
  if (JSON.stringify(root.extras?.looks ?? []) !== JSON.stringify(LOOKS)) issue(issues, 'look-metadata', 'Root look metadata must list the seven supported looks.')
  for (const name of profile.colliders) if (!(root.extras?.colliders ?? []).includes(name)) {
    issue(issues, 'collider-list', `Root metadata omits collider "${name}".`)
  }
  const runtime = root.extras?.runtime
  if (!runtime?.note || !runtime?.feedback || !root.extras?.looks?.length) {
    issue(issues, 'runtime-metadata', 'Root must describe runtime shading/hit-feedback coverage and the available look names.')
  }
}

function checkPngChunks(json, bin, issues) {
  for (const [i, image] of (json.images ?? []).entries()) {
    const view = json.bufferViews?.[image.bufferView]
    if (!view) continue
    const bytes = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
    const dim = pngHeader(bytes)
    if (!dim) issue(issues, 'png-data', `Embedded image ${i} is not a complete PNG with a valid IHDR/IDAT/IEND chunk sequence.`)
  }
}
function pngHeader(bytes) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(sig)) return null
  let offset = 8, width, height, sawData = false, sawEnd = false
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    if (offset + 12 + length > bytes.length) return null
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) return null
      width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12)
    }
    if (type === 'IDAT') sawData = true
    offset += 12 + length
    if (type === 'IEND') { sawEnd = true; break }
  }
  return sawData && sawEnd && width && height ? [width, height] : null
}

function validateAsset(bytes, profile, { geometryOnly = false } = {}) {
  const issues = []
  const parsed = parseGlb(bytes, issues)
  if (!parsed) return { issues, report: null }
  const { json, bin } = parsed
  checkContainer(json, bin, issues)
  const getAccessor = makeAccessorReader(json, bin, issues)
  checkAccessors(json, bin, issues, getAccessor)
  checkPngChunks(json, bin, issues)
  const topology = checkMeshes(json, bin, issues, getAccessor)
  checkMatRefs(json, issues)
  const sceneRoots = json.scenes?.[json.scene]?.nodes ?? []
  const rootIndex = sceneRoots.find((i) => json.nodes?.[i]?.name === profile.root)
  if (rootIndex === undefined) {
    issue(issues, 'kit-root', `The active scene does not contain "${profile.root}".`)
    return { issues, report: null }
  }
  const lod = checkLods(json, rootIndex, profile, bin, issues)
  if (!lod) return { issues, report: null }
  const tree = lod.trees[0]
  tree._json = json
  checkRoot(json, profile, tree, issues)
  checkNoEnvironment(json, tree, issues)
  checkPlayableAndPivots(json, tree, profile, issues, getAccessor)
  checkLayout(json, tree, profile, issues)
  checkColliders(json, tree, profile, issues)
  checkVariants(json, tree, profile, issues)
  checkNeon(json, tree, profile, issues)
  const materialReport = checkMaterials(json, bin, profile, geometryOnly, issues)
  const sizeReport = materialReport.sizes
  const storedBounds = json.nodes[rootIndex].extras?.bounds
  const storedSize = storedBounds?.size ?? null
  return {
    issues,
    report: {
      kit: profile.root,
      triangles: lod.counts,
      bounds: lod.bounds ? {
        min: lod.bounds.min.map((x) => +x.toFixed(4)),
        max: lod.bounds.max.map((x) => +x.toFixed(4)),
        size: lod.size.map((x) => +x.toFixed(4)),
      } : null,
      storedBounds: storedSize,
      textures: json.textures?.length ?? 0,
      images: json.images?.length ?? 0,
      materialBaseColorSizes: sizeReport,
      topology,
      validationMode: geometryOnly ? 'geometry-only' : 'full',
    },
  }
}

function makeFixtureGlb(json, bin = Buffer.alloc(44)) {
  const jsonBytes0 = Buffer.from(JSON.stringify(json))
  const jsonBytes = Buffer.concat([jsonBytes0, Buffer.alloc((4 - jsonBytes0.length % 4) % 4, 0x20)])
  const binary = Buffer.concat([bin, Buffer.alloc((4 - bin.length % 4) % 4)])
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + binary.length, 8)
  const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(jsonBytes.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binary.length, 0); binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, binary])
}

function fixtureDocument({ positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], indices = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3], imageUri } = {}) {
  const positionBytes = positions.length * 4
  const indexOffset = (positionBytes + 3) & ~3
  const indexBytes = indices.length * 2
  const byteLength = indexOffset + indexBytes
  const bin = Buffer.alloc((byteLength + 3) & ~3)
  positions.forEach((x, i) => bin.writeFloatLE(x, i * 4))
  indices.forEach((x, i) => bin.writeUInt16LE(x, indexOffset + i * 2))
  const finitePositions = positions.filter(Number.isFinite)
  const min = [0, 1, 2].map((k) => Math.min(...finitePositions.filter((_, i) => i % 3 === k)))
  const max = [0, 1, 2].map((k) => Math.max(...finitePositions.filter((_, i) => i % 3 === k)))
  const json = {
    asset: { version: '2.0' }, buffers: [{ byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positionBytes }, { buffer: 0, byteOffset: indexOffset, byteLength: indexBytes }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
    meshes: [{ name: 'Fixture', primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    nodes: [{ name: 'Fixture', mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
    ...(imageUri ? { images: [{ uri: imageUri }] } : {}),
  }
  return { json, bin, bytes: makeFixtureGlb(json, bin) }
}

function hiHatRimFixture(topY, samples) {
  const radius = 0.1789, rimY = -0.04181107133626938
  const positions = []
  for (let i = 0; i < samples; i++) {
    const angle = (i / samples) * Math.PI * 2
    positions.push(radius * Math.cos(angle), rimY, radius * Math.sin(angle))
  }
  positions.push(0.17, -0.04271107167005539, 0)
  const bin = Buffer.alloc(positions.length * 4)
  positions.forEach((value, i) => bin.writeFloatLE(value, i * 4))
  const json = {
    asset: { version: '2.0' }, buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{
      bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3',
      min: [0, 1, 2].map((k) => Math.min(...positions.filter((_, i) => i % 3 === k))),
      max: [0, 1, 2].map((k) => Math.max(...positions.filter((_, i) => i % 3 === k))),
    }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [
      { name: 'AcousticDrumKit', children: [1] },
      { name: 'HiHat', children: [2, 3] },
      { name: 'HiHat_BottomCymbal', translation: [0, 0.86, 0], rotation: [1, 0, 0, 0], mesh: 0 },
      {
        name: 'HiHat_TopCymbal', translation: [0, topY, 0], mesh: 0,
        extras: { travelAxis: [0, 1, 0], states: { fullyOpen: 0.02, partiallyOpen: 0, closed: -0.013, pedalClosed: -0.0152 } },
      },
    ],
  }
  return { json, bin }
}

function traversalFixture() {
  const chunks = [], bufferViews = [], accessors = []
  let byteLength = 0
  const addAccessor = (values, type, componentType, width, position = false) => {
    const padding = (4 - byteLength % 4) % 4
    if (padding) { chunks.push(Buffer.alloc(padding)); byteLength += padding }
    const bytes = Buffer.alloc(values.length * width)
    values.forEach((value, i) => width === 4 ? bytes.writeFloatLE(value, i * width) : bytes.writeUInt16LE(value, i * width))
    const view = bufferViews.length
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length })
    chunks.push(bytes); byteLength += bytes.length
    const accessor = { bufferView: view, componentType, count: values.length / ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type]), type }
    if (position) {
      accessor.min = [0, 1, 2].map((k) => Math.min(...values.filter((_, i) => i % 3 === k)))
      accessor.max = [0, 1, 2].map((k) => Math.max(...values.filter((_, i) => i % 3 === k)))
    }
    accessors.push(accessor)
    return accessors.length - 1
  }
  const addPrimitive = ({ positions, indices, normals, tangents }) => {
    const attributes = { POSITION: addAccessor(positions, 'VEC3', 5126, 4, true) }
    if (normals) attributes.NORMAL = addAccessor(normals, 'VEC3', 5126, 4)
    if (tangents) attributes.TANGENT = addAccessor(tangents, 'VEC4', 5126, 4)
    return { attributes, indices: addAccessor(indices, 'SCALAR', 5123, 2), mode: 4 }
  }
  const tetra = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]
  const faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]
  const positions = [], normals = [], tangents = [], indices = []
  for (const face of faces) {
    const p = face.map((i) => tetra[i])
    const ab = p[1].map((x, k) => x - p[0][k]), ac = p[2].map((x, k) => x - p[0][k])
    const n = normalize([ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]])
    for (const vertex of p) {
      positions.push(...vertex); normals.push(...n); tangents.push(1, 0, 0, 1); indices.push(indices.length)
    }
  }
  const first = addPrimitive({ positions, indices, normals, tangents })
  const badIndices = [...indices]; badIndices[badIndices.length - 1] = positions.length / 3
  const laterPrimitive = addPrimitive({ positions, indices: badIndices })
  const laterMesh = addPrimitive({
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    normals: Array.from({ length: 9 }, () => [0, 0, -1]).flat(),
  })
  const bin = Buffer.concat(chunks)
  const json = {
    asset: { version: '2.0' }, buffers: [{ byteLength }],
    bufferViews, accessors,
    meshes: [
      { name: 'TangentFirst', primitives: [first, laterPrimitive] },
      { name: 'BadTopologyLaterMesh', primitives: [laterMesh] },
    ],
  }
  return { json, bin }
}

function makeHierarchyFixture(profile) {
  const nodes = [{ name: profile.root, children: [] }]
  const visit = (parentName) => {
    const parent = nodes.findIndex((node) => node.name === parentName)
    for (const child of profile.hierarchy[parentName] ?? []) {
      const index = nodes.length
      nodes.push({ name: child, children: [] })
      nodes[parent].children.push(index)
      visit(child)
    }
  }
  visit(profile.root)
  const tree = collectTree({ nodes }, 0)
  tree._json = { nodes }
  return { nodes, tree }
}

function selfTest() {
  const tetra = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]
  const faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]
  const positions = [], indices = []
  for (const offset of [0, 3]) for (const face of faces) for (const vertex of face) {
    positions.push(tetra[vertex][0] + offset, tetra[vertex][1], tetra[vertex][2])
    indices.push(indices.length)
  }
  const good = fixtureDocument({ positions, indices })
  const parseIssues = []
  const parsed = parseGlb(good.bytes, parseIssues)
  assert(parsed && parseIssues.length === 0, 'a valid in-memory GLB should parse')
  const meshIssues = []
  const get = makeAccessorReader(good.json, good.bin, meshIssues)
  checkAccessors(good.json, good.bin, meshIssues, get)
  const validTopology = checkMeshes(good.json, good.bin, meshIssues, get)
  assert.equal(meshIssues.length, 0, 'seam-welded, disconnected closed components should pass topology checks')
  assert.deepEqual(
    [validTopology.meshes, validTopology.primitives, validTopology.analyzedPrimitives, validTopology.skippedPrimitives],
    [1, 1, 1, 0],
    'valid GLB traversal counts must distinguish meshes, primitives, analyzed data, and skips',
  )

  const rimY = -0.04181107133626938, localMinY = -0.04271107167005539
  const oldPose = hiHatRimFixture(0.875, 12)
  const oldPoseTree = collectTree(oldPose.json, 0)
  const oldPoseIssues = []
  checkAcousticHiHatRim(oldPose.json, oldPoseTree, makeAccessorReader(oldPose.json, oldPose.bin, oldPoseIssues), 0, oldPoseIssues)
  const legacyGap = (0.875 - 0.013 + localMinY) - (0.86 + localMinY)
  const transformedGap = (0.875 - 0.013 + rimY) - (0.86 - rimY)
  assert(Math.abs(legacyGap - 0.002) < 1e-8, 'the old unrotated local-minY check should see the wrong rest pose as a 2 mm gap')
  assert(oldPoseIssues.some((x) => x.code === 'hi-hat-rim-clearance' && x.message.includes('closed') && x.message.includes(transformedGap.toFixed(4))),
    'the quaternion-aware outer-rim check must reject the same flipped-bell pose as penetrating by about 82 mm')

  const closedOffset = -0.013
  const bottomRimY = 0.86 - rimY
  const validTopY = bottomRimY + 0.005 - rimY - closedOffset
  for (const [lod, samples] of [12, 8, 5].entries()) {
    const fixture = hiHatRimFixture(validTopY, samples)
    const fixtureIssues = []
    const fixtureTree = collectTree(fixture.json, 0, fixtureIssues)
    checkAcousticHiHatRim(fixture.json, fixtureTree, makeAccessorReader(fixture.json, fixture.bin, fixtureIssues), lod, fixtureIssues)
    assert.deepEqual(fixtureIssues, [], `flipped closed, pedal-closed, half-open, and open poses should pass LOD${lod}`)
  }
  console.log(`Hi-hat rim regression: legacy unrotated gap ${legacyGap.toFixed(3)} m passes; transformed flipped-rim gap ${transformedGap.toFixed(3)} m fails; valid flipped contact/clearance passes LOD0/1/2.`)

  const traversal = traversalFixture()
  const traversalIssues = []
  const traversalTopology = checkMeshes(traversal.json, traversal.bin, traversalIssues, makeAccessorReader(traversal.json, traversal.bin, traversalIssues))
  assert.deepEqual(
    [traversalTopology.meshes, traversalTopology.primitives, traversalTopology.analyzedPrimitives, traversalTopology.skippedPrimitives],
    [2, 3, 2, 1],
    'mesh traversal must continue past a valid tangent-bearing first primitive and account for later invalid data',
  )
  assert(traversalIssues.some((x) => x.code === 'bad-index' && x.message.includes('TangentFirst primitive 1')), 'a bad index in a later primitive must be reported')
  assert(traversalIssues.some((x) => x.code === 'duplicate-face' && x.message.includes('BadTopologyLaterMesh primitive 0')), 'duplicate topology in a later mesh must be reported')
  assert(traversalIssues.some((x) => x.code === 'non-manifold-edge' && x.message.includes('BadTopologyLaterMesh primitive 0')), 'non-manifold topology in a later mesh must be reported')
  assert(traversalIssues.some((x) => x.code === 'normal-winding' && x.message.includes('BadTopologyLaterMesh primitive 0')), 'invalid normals in a later mesh must be reported')
  console.log(`Regression traversal: ${traversalTopology.meshes} meshes / ${traversalTopology.primitives} primitives (${traversalTopology.analyzedPrimitives} topology-analyzed; ${traversalTopology.skippedPrimitives} invalid-data skips).`)

  const pbrIssues = []
  checkMaterials({ materials: [], images: [], textures: [] }, Buffer.alloc(0), { materials: [], primaryMaterials: [] }, false, pbrIssues)
  assert(pbrIssues.some((x) => x.code === 'missing-pbr-textures'), 'full mode must reject missing embedded PBR maps')

  const missing = makeHierarchyFixture(profiles.electronic)
  const crossbarIndex = missing.nodes.findIndex((node) => node.name === 'Rack_Crossbar')
  missing.nodes[missing.nodes.findIndex((node) => node.name === 'Rack')].children =
    missing.nodes[missing.nodes.findIndex((node) => node.name === 'Rack')].children.filter((i) => i !== crossbarIndex)
  const hierarchyIssues = []
  const missingTree = collectTree({ nodes: missing.nodes }, 0)
  missingTree._json = { nodes: missing.nodes }
  checkHierarchy(missingTree, profiles.electronic, hierarchyIssues)
  assert(hierarchyIssues.some((x) => x.code === 'hierarchy-child' && x.message.includes('Rack_Crossbar')), 'missing hierarchy nodes must fail')

  const uri = fixtureDocument({ imageUri: 'textures/outside.png' })
  const uriIssues = []
  checkContainer(uri.json, uri.bin, uriIssues)
  assert(uriIssues.some((x) => x.code === 'external-uri'), 'external images must fail')

  const badIndices = [...indices]; badIndices[badIndices.length - 1] = positions.length / 3
  const badIndex = fixtureDocument({ positions, indices: badIndices })
  const badIndexIssues = []
  checkMeshes(badIndex.json, badIndex.bin, badIndexIssues, makeAccessorReader(badIndex.json, badIndex.bin, badIndexIssues))
  assert(badIndexIssues.some((x) => x.code === 'bad-index'), 'out-of-range indices must fail')

  const nonFinitePositions = [...positions]; nonFinitePositions[nonFinitePositions.length - 1] = NaN
  const nonFinite = fixtureDocument({ positions: nonFinitePositions, indices })
  const finiteIssues = []
  checkMeshes(nonFinite.json, nonFinite.bin, finiteIssues, makeAccessorReader(nonFinite.json, nonFinite.bin, finiteIssues))
  assert(finiteIssues.some((x) => x.code === 'non-finite-accessor'), 'non-finite vertex data must fail')

  const scaleIssues = []
  checkScale({ nodes: [{ name: 'Scaled', scale: [1.1, 1, 1] }] }, { indices: [0] }, scaleIssues)
  assert(scaleIssues.some((x) => x.code === 'unapplied-scale'), 'unapplied node scales must fail')
  const budgetIssues = []
  checkBudgets(profiles.acoustic, [220001, 76946, 39396], budgetIssues)
  assert(budgetIssues.some((x) => x.code === 'triangle-budget' && x.message.includes('LOD0')), 'triangle-budget overflow must fail')
  assert(budgetIssues.some((x) => x.code === 'low-poly-budget'), 'LowPoly intersection budget overflow must fail')
  console.log('Asset validator self-test passed: closed multipart topology, later-primitive bad index, later-mesh duplicate/non-manifold topology and reversed normals after a tangent-bearing primitive, missing hierarchy, external URI, NaN, scale, missing PBR maps, and budget fixtures.')
}

function printResult({ issues, report }, file) {
  if (report) {
    const size = report.bounds?.size?.join(' × ') ?? 'no bounds'
    console.log(`${file} (${report.kit}, ${report.validationMode}): LOD ${report.triangles?.join(' / ')} tris; actual bounds ${size} m; ${report.textures} textures / ${report.images} images; ${issues.length} violation(s).`)
    if (report.storedBounds) console.log(`  Builder-declared bounds (informational only): ${report.storedBounds.join(' × ')} m.`)
    if (report.topology) console.log(`  Traversed ${report.topology.meshes} meshes / ${report.topology.primitives} primitives (${report.topology.analyzedPrimitives} topology-analyzed; ${report.topology.skippedPrimitives} invalid-data skips). Welded topology: ${report.topology.nonManifoldEdges} non-manifold, ${report.topology.openBoundaryEdges} open-boundary, ${report.topology.inconsistentWindingEdges} inconsistent-winding, ${report.topology.inwardClosedComponents} inward-closed, ${report.topology.degenerateTriangles} degenerate, ${report.topology.duplicateFaces} duplicate faces.`)
    if (report.materialBaseColorSizes?.length) {
      const maps = report.materialBaseColorSizes.map(({ material, width, height }) => `${material} ${width}×${height}`).join('; ')
      console.log(`  Embedded realistic base-color map sizes: ${maps}.`)
    }
  } else console.log(`${file}: invalid GLB; ${issues.length} violation(s).`)
  const grouped = new Map()
  for (const item of issues) {
    const group = grouped.get(item.code) ?? []
    group.push(item.message)
    grouped.set(item.code, group)
  }
  for (const [code, messages] of grouped) {
    console.log(`  ERROR [${code}] ${messages.length} finding(s):`)
    for (const message of messages) console.log(`    ${message}`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) return selfTest()
  if (args.includes('--help')) {
    console.log('Usage: node ui\\tests\\drum-kit-assets.mjs [--geometry-only] [--out-dir <dir> | <acoustic.glb> <electronic.glb>]')
    return
  }
  const geometryOnly = args.includes('--geometry-only')
  const fileArgs = []
  let outDir = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--geometry-only') continue
    if (args[i] === '--out-dir') {
      outDir = args[++i]
      continue
    }
    fileArgs.push(args[i])
  }
  const thisDir = dirname(fileURLToPath(import.meta.url))
  let files
  if (outDir !== null) {
    if (!outDir) {
      console.error('--out-dir requires a directory.')
      process.exitCode = 2
      return
    }
    const dir = resolve(outDir)
    files = [resolve(dir, 'AcousticKit.glb'), resolve(dir, 'ElectronicKit.glb')]
  } else if (fileArgs.length === 2) files = fileArgs.map((path) => resolve(path))
  else if (fileArgs.length === 0) {
    const models = resolve(thisDir, '..', 'public', 'models')
    files = [resolve(models, 'AcousticKit.glb'), resolve(models, 'ElectronicKit.glb')]
  } else {
    console.error('Usage: node ui\\tests\\drum-kit-assets.mjs [--geometry-only] [--out-dir <dir> | <acoustic.glb> <electronic.glb>]')
    process.exitCode = 2
    return
  }
  let failed = false
  for (let i = 0; i < files.length; i++) {
    const file = files[i], profile = profiles[i === 0 ? 'acoustic' : 'electronic']
    try {
      const result = validateAsset(await readFile(file), profile, { geometryOnly })
      printResult(result, file)
      if (result.issues.length) failed = true
    } catch (error) {
      console.error(`${file}: could not read or validate: ${error.message}`)
      failed = true
    }
  }
  if (failed) process.exitCode = 1
  else console.log('Both assets passed mechanical checks.')
  console.log('Visual inspection remains necessary for silhouette, finishes, intersections, branding, and runtime effects.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
