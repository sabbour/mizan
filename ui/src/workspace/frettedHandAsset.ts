import { kitBase } from './kitAsset'
import type { FrettedHandFinger } from './frettedHand'
import type { HandVector } from './frettedHand'

type GltfNode = {
  name: string
  children?: number[]
  translation?: number[]
  rotation?: number[]
  scale?: number[]
  matrix?: number[]
  mesh?: number
  skin?: number
}
type Accessor = {
  bufferView: number
  byteOffset?: number
  componentType: number
  count: number
  type: string
  normalized?: boolean
}
type HandGltf = {
  nodes: GltfNode[]
  meshes: { primitives: { attributes: Record<string, number>; indices: number }[] }[]
  skins: { joints: number[]; inverseBindMatrices: number }[]
  accessors: Accessor[]
  bufferViews: { byteOffset?: number; byteStride?: number }[]
}
type Bone = {
  name: string
  localRest: Float32Array
  inverseBind: Float32Array
}
type FingerRig = {
  finger: FrettedHandFinger
  bones: string[]
  labelBone: string
}
export type FrettedHandAssets = Record<'left' | 'right', FrettedHandAsset>
export type FrettedHandAsset = {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  joints: Uint16Array
  weights: Float32Array
  indices: Uint16Array
  jointNames: string[]
  bones: Map<string, Bone>
  fingers: FingerRig[]
  thumbBones: string[]
  meshTriangles: number
}
export type FrettedHandPoseContact = {
  finger: FrettedHandFinger
  string: number
  fret: number
  barre: boolean
  center: HandVector
  surface: HandVector
  radius: number
}
export type FrettedHandPose = {
  vertices: Float32Array
  indices: Uint16Array
  fingers: {
    finger: FrettedHandFinger
    joints: HandVector[]
    lengths: number[]
    pressed: boolean
    barre: boolean
    angles: number[]
  }[]
  thumbTip: HandVector
  boneLengths: { finger: FrettedHandFinger; lengths: number[] }[]
  contactTips: {
    finger: FrettedHandFinger
    string: number
    fret: number
    tip: HandVector
    surface: HandVector
    skinPoint: HandVector
    skinJoint: string
    gap: number
    otherGap: number
  }[]
  triangles: number
  unavailable: boolean
  thumbError?: number
  thumbBehind?: boolean
  penetration?: number
  padError?: number
  neckBack?: number
  wrist?: HandVector
}

// Fixed neck frame in the shared instrument world: centred on y = 0 with a typical guitar/bass neck profile.
const NECK_HALF_WIDTH = 0.0235
const NECK_DEPTH = 0.024

const HAND_FILES: Record<'left' | 'right', string> = {
  left: 'FrettingLeftHand.glb',
  right: 'FrettingRightHand.glb',
}
const handCache = new Map<string, Promise<FrettedHandAsset>>()
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
const FINGER_NAMES = ['index', 'middle', 'ring', 'pinky'] as const

function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16)
  const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], a4 = a[4], a5 = a[5], a6 = a[6], a7 = a[7]
  const a8 = a[8], a9 = a[9], a10 = a[10], a11 = a[11], a12 = a[12], a13 = a[13], a14 = a[14], a15 = a[15]
  for (let column = 0; column < 16; column += 4) {
    const b0 = b[column], b1 = b[column + 1], b2 = b[column + 2], b3 = b[column + 3]
    out[column] = a0 * b0 + a4 * b1 + a8 * b2 + a12 * b3
    out[column + 1] = a1 * b0 + a5 * b1 + a9 * b2 + a13 * b3
    out[column + 2] = a2 * b0 + a6 * b1 + a10 * b2 + a14 * b3
    out[column + 3] = a3 * b0 + a7 * b1 + a11 * b2 + a15 * b3
  }
  return out
}

function invert(matrix: Float32Array): Float32Array {
  const rows = Array.from({ length: 4 }, (_, row) => [
    matrix[row], matrix[4 + row], matrix[8 + row], matrix[12 + row],
    Number(row === 0), Number(row === 1), Number(row === 2), Number(row === 3),
  ])
  for (let column = 0; column < 4; column++) {
    let pivot = column
    for (let row = column + 1; row < 4; row++)
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row
    if (Math.abs(rows[pivot][column]) < 1e-10) throw new Error('Hand rig contains a singular joint transform.')
    ;[rows[column], rows[pivot]] = [rows[pivot], rows[column]]
    const divisor = rows[column][column]
    for (let entry = 0; entry < 8; entry++) rows[column][entry] /= divisor
    for (let row = 0; row < 4; row++) if (row !== column) {
      const factor = rows[row][column]
      for (let entry = 0; entry < 8; entry++) rows[row][entry] -= factor * rows[column][entry]
    }
  }
  return new Float32Array(Array.from({ length: 16 }, (_, index) => rows[index % 4][4 + Math.floor(index / 4)]))
}

function nodeMatrix(node: GltfNode): Float32Array {
  if (node.matrix) return new Float32Array(node.matrix)
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = node.scale ?? [1, 1, 1]
  const [tx, ty, tz] = node.translation ?? [0, 0, 0]
  return new Float32Array([
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ])
}

function accessorValues(json: HandGltf, bin: Uint8Array, index: number): number[] {
  const accessor = json.accessors[index]
  const view = json.bufferViews[accessor.bufferView]
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[accessor.type]
  const componentSize = { 5121: 1, 5123: 2, 5126: 4 }[accessor.componentType]
  if (!size || !componentSize) throw new Error(`Unsupported hand accessor ${index}.`)
  const stride = view.byteStride ?? componentSize * size
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const read = accessor.componentType === 5126
    ? (offset: number) => data.getFloat32(offset, true)
    : accessor.componentType === 5123
      ? (offset: number) => data.getUint16(offset, true)
      : (offset: number) => data.getUint8(offset)
  const values = new Array<number>(accessor.count * size)
  for (let item = 0; item < accessor.count; item++) for (let axis = 0; axis < size; axis++)
    values[item * size + axis] = read(start + item * stride + axis * componentSize)
  if (accessor.normalized && accessor.componentType !== 5126)
    for (let index = 0; index < values.length; index++) values[index] /= accessor.componentType === 5121 ? 255 : 65535
  return values
}

function glbParts(bytes: Uint8Array): { json: HandGltf; bin: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2)
    throw new Error('The fretting hand model is not a glTF 2.0 binary.')
  const jsonLength = view.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as HandGltf
  const binLengthOffset = 20 + jsonLength
  const binLength = view.getUint32(binLengthOffset, true)
  return { json, bin: bytes.subarray(binLengthOffset + 8, binLengthOffset + 8 + binLength) }
}

function makeRig(json: HandGltf, bin: Uint8Array): FrettedHandAsset {
  const skin = json.skins[0]
  const meshNode = json.nodes.find((node) => node.mesh !== undefined && node.skin === 0)
  const mesh = meshNode?.mesh === undefined ? undefined : json.meshes[meshNode.mesh]?.primitives[0]
  if (!skin || !mesh) throw new Error('The hand model must contain one skinned mesh.')
  const jointNames = skin.joints.map((index) => json.nodes[index].name)
  const inverseBind = accessorValues(json, bin, skin.inverseBindMatrices)
  const inverseByName = new Map(jointNames.map((name, index) =>
    [name, new Float32Array(inverseBind.slice(index * 16, index * 16 + 16))]))
  const parentIndex = new Map<number, number>()
  json.nodes.forEach((node, parent) => node.children?.forEach((child) => parentIndex.set(child, parent)))
  const restWorldByIndex = new Map<number, Float32Array>()
  const restWorld = (index: number): Float32Array => {
    const cached = restWorldByIndex.get(index)
    if (cached) return cached
    const parent = parentIndex.get(index)
    const result = parent === undefined
      ? nodeMatrix(json.nodes[index])
      : multiply(restWorld(parent), nodeMatrix(json.nodes[index]))
    restWorldByIndex.set(index, result)
    return result
  }
  const nodeIndexByName = new Map(json.nodes.map((node, index) => [node.name, index]))
  const parentFor = (name: string): string | null => {
    if (name === 'wrist') return null
    if (name.endsWith('-metacarpal')) return 'wrist'
    const prefix = name.startsWith('thumb-') ? 'thumb' : `${name.split('-finger-')[0]}-finger`
    if (name.endsWith('-phalanx-proximal')) return `${prefix}-metacarpal`
    if (name.endsWith('-phalanx-intermediate')) return `${prefix}-phalanx-proximal`
    if (name.endsWith('-phalanx-distal')) return name.startsWith('thumb-') ? 'thumb-phalanx-proximal' : `${prefix}-phalanx-intermediate`
    if (name.endsWith('-tip')) return `${prefix}-phalanx-distal`
    return null
  }
  const bones = new Map<string, Bone>()
  for (const name of jointNames) {
    const index = nodeIndexByName.get(name)
    if (index === undefined) throw new Error(`The hand rig is missing joint ${name}.`)
    const parentName = parentFor(name)
    const parentIndexForBone = parentName ? nodeIndexByName.get(parentName) : undefined
    const globalRest = restWorld(index)
    const localRest = parentIndexForBone === undefined
      ? globalRest
      : multiply(invert(restWorld(parentIndexForBone)), globalRest)
    const bind = inverseByName.get(name)
    if (!bind) throw new Error(`The hand skin is missing inverse-bind data for ${name}.`)
    bones.set(name, { name, localRest, inverseBind: bind })
  }
  const fingers = FINGER_NAMES.map((name, index): FingerRig => {
    const prefix = `${name}-finger-`
    const names = ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip']
      .map((part) => `${prefix}${part}`)
    if (names.some((joint) => !bones.has(joint)))
      throw new Error(`The hand model is missing a complete ${name} finger chain.`)
    return {
      finger: (index + 1) as FrettedHandFinger,
      bones: names,
      labelBone: names[2],
    }
  })
  const attributes = mesh.attributes
  return {
    positions: Float32Array.from(accessorValues(json, bin, attributes.POSITION)),
    normals: Float32Array.from(accessorValues(json, bin, attributes.NORMAL)),
    uvs: Float32Array.from(accessorValues(json, bin, attributes.TEXCOORD_0)),
    joints: Uint16Array.from(accessorValues(json, bin, attributes.JOINTS_0)),
    weights: Float32Array.from(accessorValues(json, bin, attributes.WEIGHTS_0)),
    indices: Uint16Array.from(accessorValues(json, bin, mesh.indices)),
    jointNames,
    bones,
    fingers,
    thumbBones: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
    meshTriangles: json.accessors[mesh.indices].count / 3,
  }
}

export function decodeFrettedHand(bytes: Uint8Array): FrettedHandAsset {
  const { json, bin } = glbParts(bytes)
  return makeRig(json, bin)
}

export function loadFrettedHand(side: 'left' | 'right'): Promise<FrettedHandAsset> {
  const url = kitBase() + HAND_FILES[side]
  let pending = handCache.get(url)
  if (!pending) {
    pending = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`${HAND_FILES[side]} is not available (${response.status})`)
      const parts = glbParts(new Uint8Array(await response.arrayBuffer()))
      return makeRig(parts.json, parts.bin)
    })
    handCache.set(url, pending)
  }
  return pending
}

export async function loadFrettedHands(): Promise<FrettedHandAssets> {
  const [left, right] = await Promise.all([loadFrettedHand('left'), loadFrettedHand('right')])
  return { left, right }
}

function rotationX(angle: number): Float32Array {
  const cosine = Math.cos(angle), sine = Math.sin(angle)
  return new Float32Array([1, 0, 0, 0, 0, cosine, sine, 0, 0, -sine, cosine, 0, 0, 0, 0, 1])
}

function rotationY(angle: number): Float32Array {
  const cosine = Math.cos(angle), sine = Math.sin(angle)
  return new Float32Array([cosine, 0, -sine, 0, 0, 1, 0, 0, sine, 0, cosine, 0, 0, 0, 0, 1])
}

function rotationZ(angle: number): Float32Array {
  const cosine = Math.cos(angle), sine = Math.sin(angle)
  return new Float32Array([cosine, sine, 0, 0, -sine, cosine, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
}

function pointOf(matrix: Float32Array): HandVector {
  return [matrix[12], matrix[13], matrix[14]]
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

const parentNames = new Map<string, string | null>()
function parentNameFor(name: string): string | null {
  const known = parentNames.get(name)
  if (known !== undefined) return known
  const found = findParentName(name)
  parentNames.set(name, found)
  return found
}
function findParentName(name: string): string | null {
  if (name === 'wrist') return null
  if (name.endsWith('-metacarpal')) return 'wrist'
  const prefix = name.startsWith('thumb-') ? 'thumb' : `${name.split('-finger-')[0]}-finger`
  if (name.endsWith('-phalanx-proximal')) return `${prefix}-metacarpal`
  if (name.endsWith('-phalanx-intermediate')) return `${prefix}-phalanx-proximal`
  if (name.endsWith('-phalanx-distal')) return name.startsWith('thumb-') ? 'thumb-phalanx-proximal' : `${prefix}-phalanx-intermediate`
  if (name.endsWith('-tip')) return `${prefix}-phalanx-distal`
  return null
}

// Local joint rotations about the bone's own X (flexion hinge) and Y (side-to-side) axes.
type Rotations = Map<string, readonly [number, number]>

function poseBones(asset: FrettedHandAsset, root: Float32Array, rotations: Rotations): Map<string, Float32Array> {
  const result = new Map<string, Float32Array>()
  const pose = (name: string): Float32Array => {
    const cached = result.get(name)
    if (cached) return cached
    const parentName = parentNameFor(name)
    const local = asset.bones.get(name)?.localRest
    if (!local) throw new Error(`The hand pose references unknown bone ${name}.`)
    const parent = parentName && asset.bones.has(parentName) ? pose(parentName) : root
    const turn = rotations.get(name)
    const rotated = turn && (turn[0] || turn[1])
      ? multiply(multiply(parent, local), multiply(rotationX(turn[0]), rotationY(turn[1])))
      : multiply(parent, local)
    result.set(name, rotated)
    return rotated
  }
  for (const name of asset.bones.keys()) pose(name)
  return result
}

function apply(matrix: Float32Array, point: readonly number[]): HandVector {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
  ]
}

type PadPoint = { slot: number; local: HandVector }
type HandPrep = {
  palmSign: 1 | -1
  rest: Map<string, Float32Array>
  mcp: HandVector
  tipPads: PadPoint[][]
  digitPads: PadPoint[][]
  thumbPads: PadPoint[]
  samples: { joints: number[]; weights: number[]; locals: HandVector[] }[]
  jointIndex: Map<string, number>
}
// Alternative finger-curl priors tried only when the default posture sinks the hand into the neck.
const POSTURE_STYLES = [[-0.5, 0, 0.4, 0.3], [0.3, 0, -0.4, -0.3], [-0.9, 0, 0.5, 0.5], [0.2, 0, 0.4, -0.6], [-0.4, 0, -0.5, 0.4]]
const prepCache = new WeakMap<FrettedHandAsset, HandPrep>()
const warmCache = new WeakMap<FrettedHandAsset, { p: number[]; seed: Float32Array; lift: number; hover: Map<number, HandVector> }>()

function prepareHand(asset: FrettedHandAsset): HandPrep {
  const cached = prepCache.get(asset)
  if (cached) return cached
  const rest = poseBones(asset, IDENTITY, new Map())
  const jointIndex = new Map(asset.jointNames.map((name, index) => [name, index]))
  const thumbTip = pointOf(rest.get('thumb-tip')!)
  const mcp = pointOf(rest.get(asset.fingers[1].bones[1])!)
  const palmSign: 1 | -1 = thumbTip[0] > mcp[0] ? 1 : -1
  const vertexCount = asset.positions.length / 3
  const position = (vertex: number) => [...asset.positions.subarray(vertex * 3, vertex * 3 + 3)]
  const gather = (bones: string[], palmSide: boolean): PadPoint[] => {
    const slots = new Map(bones.map((name, slot) => [jointIndex.get(name)!, slot]))
    const pads: PadPoint[] = []
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      let influence = 0, bestSlot = -1, bestWeight = 0
      for (let item = 0; item < 4; item++) {
        const slot = slots.get(asset.joints[vertex * 4 + item])
        if (slot === undefined) continue
        const weight = asset.weights[vertex * 4 + item]
        influence += weight
        if (weight > bestWeight) { bestWeight = weight; bestSlot = slot }
      }
      if (influence < 0.7 || bestSlot < 0) continue
      if (palmSide && asset.normals[vertex * 3] * palmSign < 0.25) continue
      pads.push({ slot: bestSlot, local: apply(asset.bones.get(bones[bestSlot])!.inverseBind, position(vertex)) })
    }
    return pads
  }
  const tipPads = asset.fingers.map((finger) => gather(finger.bones.slice(3), true).map((pad) => ({ ...pad, slot: pad.slot + 2 })))
  const digitPads = asset.fingers.map((finger) => gather(finger.bones.slice(1), true))
  const thumbPads = gather(asset.thumbBones.slice(2), false).map((pad) => ({ ...pad, slot: pad.slot + 2 }))
  const samples: HandPrep['samples'] = []
  for (let vertex = 0; vertex < vertexCount; vertex += 6) {
    const entry = { joints: [] as number[], weights: [] as number[], locals: [] as HandVector[] }
    for (let item = 0; item < 4; item++) {
      const weight = asset.weights[vertex * 4 + item]
      if (weight <= 0) continue
      const joint = asset.joints[vertex * 4 + item]
      entry.joints.push(joint)
      entry.weights.push(weight)
      entry.locals.push(apply(asset.bones.get(asset.jointNames[joint])!.inverseBind, position(vertex)))
    }
    samples.push(entry)
  }
  const prep = { palmSign, rest, mcp, tipPads, digitPads, thumbPads, samples, jointIndex }
  prepCache.set(asset, prep)
  return prep
}

type Limits = { lo: number[]; hi: number[]; prior: number[]; weight: number }

function solveLinear(matrix: number[][], rhs: number[]): number[] {
  const size = rhs.length
  const a = matrix.map((row, index) => [...row, rhs[index]])
  for (let column = 0; column < size; column++) {
    let pivot = column
    for (let row = column + 1; row < size; row++) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row
    ;[a[column], a[pivot]] = [a[pivot], a[column]]
    const divisor = a[column][column] || 1e-12
    for (let row = column + 1; row < size; row++) {
      const factor = a[row][column] / divisor
      for (let item = column; item <= size; item++) a[row][item] -= factor * a[column][item]
    }
  }
  const result = new Array<number>(size).fill(0)
  for (let row = size - 1; row >= 0; row--) {
    let sum = a[row][size]
    for (let column = row + 1; column < size; column++) sum -= a[row][column] * result[column]
    result[row] = sum / (a[row][row] || 1e-12)
  }
  return result
}

// Levenberg-Marquardt on joint angles; residual returns (target - current) positions in metres.
function levenberg(
  start: readonly number[],
  limits: Limits,
  residual: (angles: number[]) => number[],
  steps: number,
): number[] {
  let angles = start.map((value, index) => Math.max(limits.lo[index], Math.min(limits.hi[index], value)))
  const priorWeight = limits.weight * limits.weight
  const energy = (values: number[], r: number[]) =>
    r.reduce((sum, value) => sum + value * value, 0) +
    priorWeight * values.reduce((sum, value, index) => sum + (value - limits.prior[index]) ** 2, 0)
  let damping = 1e-6
  for (let step = 0; step < steps; step++) {
    const r = residual(angles)
    const h = 2e-3
    const jacobian = angles.map((_, index) => {
      const probe = angles.slice()
      probe[index] += h
      return residual(probe).map((value, row) => (value - r[row]) / h)
    })
    const size = angles.length
    const normal = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) =>
      jacobian[row].reduce((sum, value, item) => sum + value * jacobian[column][item], 0)))
    const gradient = angles.map((value, index) =>
      jacobian[index].reduce((sum, item, row) => sum + item * r[row], 0) +
      priorWeight * (value - limits.prior[index]))
    const before = energy(angles, r)
    let accepted = false
    for (let attempt = 0; attempt < 4 && !accepted; attempt++) {
      const system = normal.map((row, index) => row.map((value, column) =>
        value + (index === column ? priorWeight + damping : 0)))
      const delta = solveLinear(system, gradient.map((value) => -value))
      const trial = angles.map((value, index) =>
        Math.max(limits.lo[index], Math.min(limits.hi[index], value + Math.max(-0.4, Math.min(0.4, delta[index])))))
      if (energy(trial, residual(trial)) < before) {
        const moved = trial.reduce((sum, value, index) => Math.max(sum, Math.abs(value - angles[index])), 0)
        angles = trial
        accepted = true
        damping = Math.max(1e-7, damping / 3)
        if (moved < 1e-4) return angles
      } else damping *= 8
    }
    if (!accepted) break
  }
  return angles
}

const FINGER_LIMITS: Limits = {
  lo: [-1.65, -0.5, -1.8, -1.25],
  hi: [0.4, 0.5, 0, 0],
  prior: [-0.7, 0, -0.9, -0.4],
  weight: 0.0035,
}
const THUMB_LIMITS: Limits = {
  lo: [-0.9, -0.9, -1.1, -0.5, -1.1, -0.4],
  hi: [0.9, 0.9, 1.1, 0.5, 1.1, 0.4],
  prior: [0, 0, 0, 0, 0, 0],
  weight: 0.012,
}

function localOf(asset: FrettedHandAsset, name: string): Float32Array {
  return asset.bones.get(name)!.localRest
}

function fingerChain(asset: FrettedHandAsset, finger: FingerRig, meta: Float32Array, a: readonly number[]): Float32Array[] {
  const [, proximal, intermediate, distal, tip] = finger.bones
  const first = multiply(multiply(meta, localOf(asset, proximal)), multiply(rotationX(a[0]), rotationY(a[1])))
  const second = multiply(multiply(first, localOf(asset, intermediate)), rotationX(a[2]))
  const third = multiply(multiply(second, localOf(asset, distal)), rotationX(a[3]))
  return [first, second, third, multiply(third, localOf(asset, tip))]
}

function thumbChain(asset: FrettedHandAsset, wrist: Float32Array, a: readonly number[]): Float32Array[] {
  const [metacarpal, proximal, distal, tip] = asset.thumbBones
  const first = multiply(multiply(wrist, localOf(asset, metacarpal)), multiply(rotationX(a[0]), rotationY(a[1])))
  const second = multiply(multiply(first, localOf(asset, proximal)), multiply(rotationX(a[2]), rotationY(a[3])))
  const third = multiply(multiply(second, localOf(asset, distal)), multiply(rotationX(a[4]), rotationY(a[5])))
  return [first, second, third, multiply(third, localOf(asset, tip))]
}

type PadSolve = { angles: number[]; errors: number[] }

// Drives skin points of one digit onto its targets: the lowest pad point for a single contact,
// or the nearest palmar skin under every string for a barre.
function solvePad(
  chain: (angles: number[]) => Float32Array[],
  limits: Limits,
  targets: readonly HandVector[],
  pads: PadPoint[],
  mode: 'lowest' | 'nearest' | 'highest',
  start: readonly number[],
  rounds: number,
  steps: number,
): PadSolve {
  let angles = start.slice()
  const select = (current: number[]): PadPoint[] => {
    const matrices = chain(current)
    const world = pads.map((pad) => apply(matrices[pad.slot], pad.local))
    return targets.map((target) => {
      let best = 0
      for (let index = 1; index < pads.length; index++) {
        const better = mode === 'lowest' ? world[index][2] < world[best][2]
          : mode === 'highest' ? world[index][2] > world[best][2]
            : distance(world[index], target) < distance(world[best], target)
        if (better) best = index
      }
      return pads[best]
    })
  }
  for (let round = 0; round < rounds; round++) {
    const chosen = select(angles)
    angles = levenberg(angles, limits, (values) => {
      const matrices = chain(values)
      return targets.flatMap((target, index) => {
        const point = apply(matrices[chosen[index].slot], chosen[index].local)
        return [target[0] - point[0], target[1] - point[1], target[2] - point[2]]
      })
    }, steps)
  }
  const chosen = select(angles)
  const matrices = chain(angles)
  return {
    angles,
    errors: targets.map((target, index) => distance(target, apply(matrices[chosen[index].slot], chosen[index].local))),
  }
}

function skinMesh(asset: FrettedHandAsset, matrices: Map<string, Float32Array>): {
  vertices: Float32Array
  skinMatrices: Float32Array[]
} {
  const skinMatrices = asset.jointNames.map((name) => {
    const bone = asset.bones.get(name)!
    return multiply(matrices.get(name)!, bone.inverseBind)
  })
  const vertices = new Float32Array(asset.positions.length / 3 * 8)
  for (let vertex = 0; vertex < asset.positions.length / 3; vertex++) {
    const position = asset.positions.subarray(vertex * 3, vertex * 3 + 3)
    const normal = asset.normals.subarray(vertex * 3, vertex * 3 + 3)
    const out = vertex * 8
    let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0, total = 0
    for (let slot = 0; slot < 4; slot++) {
      const weight = asset.weights[vertex * 4 + slot]
      const joint = asset.joints[vertex * 4 + slot]
      if (weight <= 0 || !skinMatrices[joint]) continue
      const matrix = skinMatrices[joint]
      px += (matrix[0] * position[0] + matrix[4] * position[1] + matrix[8] * position[2] + matrix[12]) * weight
      py += (matrix[1] * position[0] + matrix[5] * position[1] + matrix[9] * position[2] + matrix[13]) * weight
      pz += (matrix[2] * position[0] + matrix[6] * position[1] + matrix[10] * position[2] + matrix[14]) * weight
      nx += (matrix[0] * normal[0] + matrix[4] * normal[1] + matrix[8] * normal[2]) * weight
      ny += (matrix[1] * normal[0] + matrix[5] * normal[1] + matrix[9] * normal[2]) * weight
      nz += (matrix[2] * normal[0] + matrix[6] * normal[1] + matrix[10] * normal[2]) * weight
      total += weight
    }
    const inverseLength = 1 / Math.max(1e-8, Math.hypot(nx, ny, nz))
    vertices[out] = px / Math.max(1, total) // Source WEIGHTS_0 sums to one; preserve malformed data safely.
    vertices[out + 1] = py / Math.max(1, total)
    vertices[out + 2] = pz / Math.max(1, total)
    vertices[out + 3] = nx * inverseLength
    vertices[out + 4] = ny * inverseLength
    vertices[out + 5] = nz * inverseLength
    vertices[out + 6] = asset.uvs[vertex * 2]
    vertices[out + 7] = asset.uvs[vertex * 2 + 1]
  }
  return { vertices, skinMatrices }
}

function closestSkinPoint(
  asset: FrettedHandAsset,
  vertices: Float32Array,
  contactJoints: string[],
  target: HandVector,
): { point: HandVector; joint: string; gap: number; otherGap: number } {
  const digitJoints = new Set(contactJoints.map((name) => asset.jointNames.indexOf(name)))
  let bestGap = Infinity
  let best: HandVector = target
  let bestJoint = contactJoints.at(-1)!
  let otherGap = Infinity
  for (let vertex = 0; vertex < asset.positions.length / 3; vertex++) {
    let influence = 0
    let dominantJoint = -1
    let dominantWeight = 0
    for (let slot = 0; slot < 4; slot++)
      if (digitJoints.has(asset.joints[vertex * 4 + slot])) {
        const weight = asset.weights[vertex * 4 + slot]
        influence += weight
        if (weight > dominantWeight) {
          dominantWeight = weight
          dominantJoint = asset.joints[vertex * 4 + slot]
        }
      }
    const offset = vertex * 8
    const point: HandVector = [vertices[offset], vertices[offset + 1], vertices[offset + 2]]
    const gap = distance(point, target)
    if (influence < 0.5 || dominantJoint < 0) {
      if (influence < 0.2) otherGap = Math.min(otherGap, gap)
      continue
    }
    if (gap < bestGap) { bestGap = gap; best = point; bestJoint = asset.jointNames[dominantJoint] }
  }
  return { point: best, joint: bestJoint, gap: bestGap, otherGap }
}

// A relaxed picking hand in the model's own rest frame: the thumb pad and the side of the curled
// index finger are driven together on a pick-sized gap; the other fingers curl loosely.
export type RestingHand = {
  vertices: Float32Array
  indices: Uint16Array
  anchor: HandVector
  forward: HandVector
  squeeze: HandVector
  wrist: HandVector
  across: HandVector
  knuckles: HandVector
  pinchGap: number
}

const pinchCache = new WeakMap<FrettedHandAsset, RestingHand>()

export function restingPickingHand(asset: FrettedHandAsset): RestingHand {
  const cached = pinchCache.get(asset)
  if (cached) return cached
  const loose = [[-0.62, -0.75, -0.5], [-0.7, -0.85, -0.55], [-0.78, -0.9, -0.6]]
  const prior = [-0.9, -1.2, -0.55, 0, 0, 0, 0, 0, 0]
  const lo = [-1.65, -1.8, -1.25, -0.9, -0.9, -1.1, -0.5, -1.1, -0.4]
  const hi = [0.4, 0, 0, 0.9, 0.9, 1.1, 0.5, 1.1, 0.4]
  const build = (p: readonly number[]) => {
    const rotations: Rotations = new Map()
    asset.fingers.forEach((finger, index) => {
      const curl = index === 0 ? [p[0], p[1], p[2]] : loose[index - 1]
      rotations.set(finger.bones[1], [curl[0], 0])
      rotations.set(finger.bones[2], [curl[1], 0])
      rotations.set(finger.bones[3], [curl[2], 0])
    })
    rotations.set(asset.thumbBones[0], [p[3], p[4]])
    rotations.set(asset.thumbBones[1], [p[5], p[6]])
    rotations.set(asset.thumbBones[2], [p[7], p[8]])
    return poseBones(asset, IDENTITY, rotations)
  }
  const sidePoint = (matrices: Map<string, Float32Array>): HandVector => {
    const a = pointOf(matrices.get('index-finger-phalanx-intermediate')!)
    const b = pointOf(matrices.get('index-finger-phalanx-distal')!)
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
  }
  const cost = (p: readonly number[]) => {
    const matrices = build(p)
    const gap = distance(pointOf(matrices.get('thumb-tip')!), sidePoint(matrices))
    let regular = 0
    p.forEach((value, index) => { regular += (value - prior[index]) ** 2 })
    return ((gap - 0.011) * 1000) ** 2 + regular * 4
  }
  const p = prior.slice()
  let best = cost(p)
  for (let step = 0.3; step > 0.01; step *= 0.7)
    for (let round = 0; round < 6; round++)
      for (let index = 0; index < p.length; index++)
        for (const direction of [-1, 1]) {
          const trial = Math.min(hi[index], Math.max(lo[index], p[index] + direction * step))
          if (trial === p[index]) continue
          const previous = p[index]
          p[index] = trial
          const value = cost(p)
          if (value < best) best = value
          else p[index] = previous
        }
  const matrices = build(p)
  const thumbTip = pointOf(matrices.get('thumb-tip')!)
  const side = sidePoint(matrices)
  const unit = (v: number[]) => { const length = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / length, v[1] / length, v[2] / length] as HandVector }
  const squeeze = unit([thumbTip[0] - side[0], thumbTip[1] - side[1], thumbTip[2] - side[2]])
  const thumbDistal = pointOf(matrices.get('thumb-phalanx-distal')!)
  let forward = unit([thumbTip[0] - thumbDistal[0], thumbTip[1] - thumbDistal[1], thumbTip[2] - thumbDistal[2]])
  const along = forward[0] * squeeze[0] + forward[1] * squeeze[1] + forward[2] * squeeze[2]
  forward = unit([forward[0] - squeeze[0] * along, forward[1] - squeeze[1] * along, forward[2] - squeeze[2] * along])
  const result: RestingHand = {
    vertices: skinMesh(asset, matrices).vertices,
    indices: asset.indices,
    anchor: [(thumbTip[0] + side[0]) / 2, (thumbTip[1] + side[1]) / 2, (thumbTip[2] + side[2]) / 2],
    forward, squeeze,
    wrist: pointOf(matrices.get('wrist')!),
    across: (() => { const i = pointOf(matrices.get('index-finger-metacarpal')!), p = pointOf(matrices.get('pinky-finger-metacarpal')!); return [p[0] - i[0], p[1] - i[1], p[2] - i[2]] as HandVector })(),
    knuckles: (() => { const names = ['index', 'middle', 'ring', 'pinky']; const q = names.map((n) => pointOf(matrices.get(n + '-finger-metacarpal')!)); return [0, 1, 2].map((a) => q.reduce((s, v) => s + v[a], 0) / 4) as HandVector })(),
    pinchGap: distance(thumbTip, side),
  }
  pinchCache.set(asset, result)
  return result
}

export function poseFrettedHand(
  asset: FrettedHandAsset,
  contacts: readonly FrettedHandPoseContact[],
  state: 'pressed' | 'preview' | 'relaxed',
  neck: { halfWidth: number; depth: number } = { halfWidth: NECK_HALF_WIDTH, depth: NECK_DEPTH },
  quick = false,
): FrettedHandPose {
  const byFinger = new Map<number, FrettedHandPoseContact[]>()
  for (const contact of contacts) {
    const group = byFinger.get(contact.finger) ?? []
    group.push(contact)
    byFinger.set(contact.finger, group)
  }
  if ([...byFinger.keys()].some((finger) => finger === 5) || !contacts.length)
    return { vertices: new Float32Array(0), indices: new Uint16Array(0), fingers: [], thumbTip: [0, 0, 0],
      boneLengths: [], contactTips: [], triangles: 0, unavailable: true }
  const prep = prepareHand(asset)
  const raised = state === 'preview' ? 0.018 : state === 'relaxed' ? 0.024 : 0.0005
  const meanOf = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
  const pressedX = meanOf(contacts.map((contact) => contact.surface[0]))
  const zCenter = meanOf(contacts.map((contact) => contact.center[2]))
  const fretZ = (x: number) => zCenter - 0.0035 + 0.014 * (x - pressedX)
  const backZ = (x: number) => fretZ(x) - neck.depth
  const topZ = (x: number) => fretZ(x) + 0.0012
  const pressedTargets = new Map<number, HandVector[]>()
  for (const [finger, group] of byFinger)
    pressedTargets.set(finger, group.map((contact) => [
      contact.surface[0], contact.surface[1], contact.surface[2] + raised,
    ] as HandVector))
  const reference = [...pressedTargets].sort((a, b) => a[0] - b[0])[0]
  const hoverTargets = new Map<number, HandVector[]>()
  for (const finger of [1, 2, 3, 4] as const) {
    if (pressedTargets.has(finger)) continue
    const nearest = [...pressedTargets.keys()].sort((a, b) => Math.abs(a - finger) - Math.abs(b - finger))[0] ?? reference[0]
    const base = pressedTargets.get(nearest)![0]
    // Unpressed fingers hover curled just above the board, inside the neck edges.
    const hoverLimit = neck.halfWidth * 0.8
    const computed: HandVector = [base[0] - (finger - nearest) * 0.022,
      Math.max(-hoverLimit, Math.min(hoverLimit, base[1])), base[2] + 0.014]
    hoverTargets.set(finger, [computed])
  }
  const lowestFinger = Math.min(...byFinger.keys())
  const thumbX = lowestFinger <= 2 ? pressedX
    : meanOf(byFinger.get(lowestFinger)!.map((contact) => contact.surface[0])) + (lowestFinger - 2) * 0.022
  const thumbTarget = (): HandVector => [thumbX, 0, backZ(thumbX) - 0.005]
  const cubeRotations: Float32Array[] = []
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]])
    for (const signs of [[1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1], [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1]]) {
      const matrix = new Float32Array(16)
      matrix[15] = 1
      for (let column = 0; column < 3; column++) matrix[column * 4 + order[column]] = signs[column]
      const determinant = matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9])
        - matrix[4] * (matrix[1] * matrix[10] - matrix[2] * matrix[9])
        + matrix[8] * (matrix[1] * matrix[6] - matrix[2] * matrix[5])
      if (determinant > 0) cubeRotations.push(matrix)
    }
  const makeRoot = (p: readonly number[], seed: Float32Array): Float32Array => {
    const turn = multiply(multiply(rotationZ(p[5]), rotationY(p[4])), multiply(rotationX(p[3]), seed))
    const moved = apply(turn, prep.mcp)
    turn[12] = p[0] - moved[0]; turn[13] = p[1] - moved[1]; turn[14] = p[2] - moved[2]
    return turn
  }
  let fingerPrior = FINGER_LIMITS.prior
  type Evaluation = {
    cost: number
    root: Float32Array
    rotations: Rotations
    fingerError: Map<number, number[]>
    thumbError: number
    penetration: number
    thumbPoint: HandVector
  }
  const evaluate = (p: readonly number[], seed: Float32Array, rounds: number, steps: number): Evaluation => {
    const root = makeRoot(p, seed)
    const base = poseBones(asset, root, new Map())
    const rotations: Rotations = new Map()
    const fingerError = new Map<number, number[]>()
    let cost = 0
    for (const finger of asset.fingers) {
      const pressedGroup = pressedTargets.get(finger.finger)
      const targets = pressedGroup ?? hoverTargets.get(finger.finger)!
      const meta = base.get(finger.bones[0])!
      const barre = !!pressedGroup && pressedGroup.length > 1
      const solved = solvePad((angles) => fingerChain(asset, finger, meta, angles), FINGER_LIMITS, targets,
        barre || !pressedGroup ? prep.digitPads[finger.finger - 1] : prep.tipPads[finger.finger - 1],
        pressedGroup ? (barre ? 'nearest' : 'lowest') : 'lowest', fingerPrior, rounds, steps)
      rotations.set(finger.bones[1], [solved.angles[0], solved.angles[1]])
      rotations.set(finger.bones[2], [solved.angles[2], 0])
      rotations.set(finger.bones[3], [solved.angles[3], 0])
      fingerError.set(finger.finger, solved.errors)
      const weight = pressedGroup ? 1 : 0.15
      for (const error of solved.errors) cost += weight * (error * 1000) ** 2
    }
    const wrist = base.get('wrist')!
    const thumb = solvePad((angles) => thumbChain(asset, wrist, angles), THUMB_LIMITS, [thumbTarget()],
      prep.thumbPads, 'nearest', THUMB_LIMITS.prior, rounds, steps)
    asset.thumbBones.slice(0, 3).forEach((name, index) =>
      rotations.set(name, [thumb.angles[index * 2], thumb.angles[index * 2 + 1]]))
    const thumbError = thumb.errors[0]
    cost += 1.5 * (thumbError * 1000) ** 2
    const thumbPoint = thumbTarget()
    const matrices = poseBones(asset, root, rotations)
    const wristPoint = pointOf(matrices.get('wrist')!)
    // Keep the forearm roughly square to the neck: limit yaw along the neck and wrist drop.
    const reachX = p[0] - wristPoint[0]
    const reachY = p[1] - wristPoint[1]
    const reachXY = Math.hypot(reachX, reachY) || 1
    cost += 0.02 * (Math.max(0, Math.abs(reachX) / reachXY - 0.5) * 100) ** 2
    cost += 0.02 * (Math.max(0, (p[2] - wristPoint[2]) / reachXY - 0.5) * 100) ** 2
    cost += (Math.max(0, 0.03 - Math.abs(wristPoint[1])) * 1000) ** 2
    cost += 0.3 * (Math.max(0, Math.abs(wristPoint[1]) - 0.09) * 1000) ** 2
    cost += (Math.max(0, wristPoint[2] - topZ(wristPoint[0]) - 0.01) * 1000) ** 2
    let penetration = 0
    {
      for (const sample of prep.samples) {
        const point: HandVector = [0, 0, 0]
        sample.joints.forEach((joint, index) => {
          const world = apply(matrices.get(asset.jointNames[joint])!, sample.locals[index])
          point[0] += world[0] * sample.weights[index]
          point[1] += world[1] * sample.weights[index]
          point[2] += world[2] * sample.weights[index]
        })
        const depth = Math.min(neck.halfWidth - Math.abs(point[1]), topZ(point[0]) - point[2], point[2] - backZ(point[0]))
        if (depth > 0.0015) {
          cost += 4 * ((depth - 0.0015) * 1000) ** 2
          penetration = Math.max(penetration, depth)
        }
      }
    }
    cost += 2 * (p[3] ** 2 + p[4] ** 2 + p[5] ** 2)
    return { cost, root, rotations, fingerError, thumbError, penetration, thumbPoint }
  }
  type Start = { p: number[]; seed: Float32Array; cost: number }
  const warm = warmCache.get(asset)
  const surfaceZ = meanOf([...pressedTargets.values()].flat().map((point) => point[2]))
  const warmCost = (p: readonly number[], seed: Float32Array) => {
    if (!warm || warm.seed !== seed) return 0
    return 0.004 * ((p[1] - warm.p[1]) ** 2 + (p[2] - surfaceZ - warm.lift) ** 2) * 1e6
      + 3 * ((p[3] - warm.p[3]) ** 2 + (p[4] - warm.p[4]) ** 2 + (p[5] - warm.p[5]) ** 2)
  }
  const score = (p: number[], seed: Float32Array): Start => ({ p, seed, cost: evaluate(p, seed, 1, 5).cost + warmCost(p, seed) })
  const reachChoices = warm && quick ? [Math.sign(warm.p[1]) * 0.04] : [0.04, -0.04]
  const scoreSeeds = (seeds: readonly Float32Array[]) => {
    const scored: Start[] = []
    for (const seed of seeds) for (const reach of reachChoices)
      scored.push(score([pressedX, reach, surfaceZ + 0.02, 0, 0, 0], seed))
    return scored.sort((a, b) => a.cost - b.cost)
  }
  // After a first pose the same hand orientation is tried first, which is far faster; the full search is the fallback.
  const scoredAll = scoreSeeds(warm && quick ? [warm.seed] : cubeRotations)
  const fullSearch = () => warm && quick ? scoreSeeds(cubeRotations) : scoredAll
  // `untilFeasible` stops at the first start whose refined pose is usable, instead of comparing every start.
  let finished: { start: Start; pose: FrettedHandPose } | null = null
  const refine = (starts: Start[], untilFeasible = false): Start => {
    let best = starts[0]
    for (const start of starts) {
      let current = start
      let steps = [0.01, 0.01, 0.01, 0.2, 0.15, 0.15]
      for (let sweep = 0; sweep < 40 && steps[0] > 0.0006; sweep++) {
        let improved = false
        for (let axis = 0; axis < 6; axis++) for (const sign of [1, -1]) {
          const trial = current.p.slice()
          trial[axis] += sign * steps[axis]
          const cost = evaluate(trial, current.seed, 1, 5).cost + warmCost(trial, current.seed)
          if (cost < current.cost) { current = { ...current, p: trial, cost }; improved = true }
        }
        if (!improved) steps = steps.map((step) => step / 2)
      }
      if (untilFeasible) {
        const candidate = finish(current)
        if (!candidate.unavailable) { finished = { start: current, pose: candidate }; return current }
      }
      if (current.cost < best.cost) best = current
    }
    return best
  }
  const warmStart: Start[] = warm
    ? [score([pressedX, warm.p[1], surfaceZ + warm.lift, warm.p[3], warm.p[4], warm.p[5]], warm.seed)] : []
  // Warm: refine only the better of the two similar starts; the retry below still searches widely.
  const firstStarts = warm && quick
    ? [[...warmStart, ...scoredAll].sort((a, b) => a.cost - b.cost)[0]] : [...warmStart, ...scoredAll.slice(0, 8)]
  const finish = (best: Start): FrettedHandPose => {
    const final = evaluate(best.p, best.seed, 3, 14)
    const { root } = final
    let rotations = final.rotations
    let finalPenetration = final.penetration
    const penetrationOf = (matrices: Map<string, Float32Array>) => {
      let worst = 0
      for (const sample of prep.samples) {
        const point: HandVector = [0, 0, 0]
        sample.joints.forEach((joint, index) => {
          const world = apply(matrices.get(asset.jointNames[joint])!, sample.locals[index])
          point[0] += world[0] * sample.weights[index]
          point[1] += world[1] * sample.weights[index]
          point[2] += world[2] * sample.weights[index]
        })
        const depth = Math.min(neck.halfWidth - Math.abs(point[1]), topZ(point[0]) - point[2], point[2] - backZ(point[0]))
        if (depth > 0.0015) worst = Math.max(worst, depth)
      }
      return worst
    }
    // Idle fingers curl a little more, within joint limits, so their tips stay inside the neck edges.
    {
      const adjusted: Rotations = new Map(rotations)
      const edge = neck.halfWidth * 0.55
      let changed = false
      for (const finger of asset.fingers) {
        if (pressedTargets.has(finger.finger)) continue
        const [, knuckle, middle, end] = finger.bones
        let a = [...(adjusted.get(knuckle) ?? [0, 0])]
        let b = [...(adjusted.get(middle) ?? [0, 0])]
        let c = [...(adjusted.get(end) ?? [0, 0])]
        for (let step = 0; step < 40; step++) {
          const tip = pointOf(poseBones(asset, root, adjusted).get(finger.bones[4])!)
          if (Math.abs(tip[1]) <= edge) break
          a = [Math.max(-1.65, a[0] - 0.04), a[1]]
          b = [Math.max(-1.8, b[0] - 0.08), b[1]]
          c = [Math.max(-1.25, c[0] - 0.06), c[1]]
          adjusted.set(knuckle, a as unknown as readonly [number, number])
          adjusted.set(middle, b as unknown as readonly [number, number])
          adjusted.set(end, c as unknown as readonly [number, number])
          changed = true
        }
      }
      if (changed) {
        const after = penetrationOf(poseBones(asset, root, adjusted))
        if (after <= Math.max(final.penetration, 0.003) + 1e-9) { rotations = adjusted; finalPenetration = after }
      }
    }
  const matrices = poseBones(asset, root, rotations)
  const { vertices } = skinMesh(asset, matrices)
  const fingers = asset.fingers.map((finger) => {
    const joints = finger.bones.map((name) => pointOf(matrices.get(name)!))
    const lengths = joints.slice(1).map((point, index) => distance(joints[index], point))
    return {
      finger: finger.finger,
      joints,
      lengths,
      pressed: pressedTargets.has(finger.finger),
      barre: (byFinger.get(finger.finger)?.length ?? 0) > 1,
      angles: [0, ...finger.bones.slice(1, 4).map((name) => -(rotations.get(name)?.[0] ?? 0))],
    }
  })
  const contactTips = contacts.map((contact) => {
    const finger = asset.fingers[contact.finger - 1]
    const tip = pointOf(matrices.get(finger.bones[4])!)
    const surface: HandVector = [...contact.surface]
    const nearest = closestSkinPoint(asset, vertices,
      (byFinger.get(contact.finger)?.length ?? 0) > 1 ? finger.bones.slice(1) : finger.bones.slice(3), surface)
    return { finger: contact.finger, string: contact.string, fret: contact.fret, tip, surface,
      skinPoint: nearest.point, skinJoint: nearest.joint, gap: nearest.gap, otherGap: nearest.otherGap }
  })
  const thumbTip = pointOf(matrices.get('thumb-tip')!)
  const padError = Math.max(...[...final.fingerError]
    .filter(([finger]) => pressedTargets.has(finger)).flatMap(([, errors]) => errors))
  const behind = thumbTip[2] <= backZ(thumbTip[0]) + 0.006 && final.thumbError <= 0.005
  const curled = fingers.every((finger) => !finger.pressed ||
    (finger.angles[1] + finger.angles[2] + finger.angles[3] > 1.0 && finger.angles[2] > 0.3))
  const unavailable = state === 'pressed'
    ? contactTips.some((contact) => contact.gap > 0.0035 || contact.otherGap < contact.gap - 0.001)
      || finalPenetration > 0.003 || !behind || !curled
    : padError > (state === 'relaxed' ? 0.009 : 0.004) || !behind
  return {
    vertices,
    indices: asset.indices,
    fingers,
    thumbTip,
    boneLengths: fingers.map((finger) => ({ finger: finger.finger, lengths: finger.lengths })),
    contactTips,
    triangles: asset.meshTriangles,
    unavailable,
    thumbError: final.thumbError,
    thumbBehind: behind,
    penetration: finalPenetration,
    padError,
    neckBack: backZ(pressedX),
    wrist: pointOf(matrices.get('wrist')!),
    }
  }
  let chosen = refine(firstStarts, !quick && state === 'pressed')
  const done = finished as { start: Start; pose: FrettedHandPose } | null
  let pose = done?.start === chosen ? done.pose : finish(chosen)
  // A pose for a coming onset is only worth a quick attempt; the wide search runs when it is needed now.
  if (pose.unavailable && !quick) {
    const second = refine(fullSearch().slice(0, 24), true)
    const settled = finished as { start: Start; pose: FrettedHandPose } | null
    const retry = settled?.start === second ? settled.pose : finish(second)
    if (!retry.unavailable) { chosen = second; pose = retry }
    else {
      for (const style of POSTURE_STYLES) {
        fingerPrior = FINGER_LIMITS.prior.map((value, index) => value + style[index])
        const styled = refine([score(second.p.slice(), second.seed)])
        const styledPose = finish(styled)
        if (!styledPose.unavailable) { chosen = styled; pose = styledPose; break }
      }
      fingerPrior = FINGER_LIMITS.prior
    }
  }
  if (!pose.unavailable && state === 'pressed')
    warmCache.set(asset, { p: chosen.p, seed: chosen.seed, lift: chosen.p[2] - surfaceZ, hover: new Map([...hoverTargets].map(([finger, targets]) => [finger, targets[0]])) })
  return pose
}

