import { loadFrettedHand, type FrettedHandAsset } from './frettedHandAsset'

/**
 * A posable, connected 3D hand for the drum and piano views: the same skinned WebXR hand models the guitar view uses
 * (one wrist, five digits), posed with forward kinematics and a small solver that reaches a fingertip to a point.
 * Poses are pure functions of their inputs, so seeking, looping and pausing always show the same hand for the same
 * time. Matrices are column-major 4x4 in Float64Array scratch space; nothing is allocated per frame.
 */
export type HandSide = 'left' | 'right'
export type Finger = 1 | 2 | 3 | 4 | 5
export type Vec = [number, number, number]

type Digit = { bones: number[]; padBone: number; pad: Vec }
export type HandMesh = {
  side: HandSide
  /** Interleaved vertices for the kit renderer: position, normal, uv, tangent (12 floats). Rewritten by `skinHand`. */
  data: Float32Array
  index: Uint32Array
  triangles: number
  /** Posed bone matrices, in the model's joint order. */
  world: Float64Array
  /** Flexion (positive curls toward the palm) and sideways turn of each bone, in radians. */
  flex: Float64Array
  splay: Float64Array
  root: Float64Array
  asset: FrettedHandAsset
  parent: Int16Array
  order: number[]
  rest: Float64Array
  inverseBind: Float64Array
  wrist: number
  /** Digits 1 (thumb) to 5 (little finger). */
  digits: Digit[]
  skinScratch: Float64Array
}

const FINGER_PREFIX = ['', 'thumb', 'index-finger', 'middle-finger', 'ring-finger', 'pinky-finger']

function parentName(name: string): string | null {
  if (name === 'wrist') return null
  if (name.endsWith('-metacarpal')) return 'wrist'
  const prefix = name.startsWith('thumb-') ? 'thumb' : `${name.split('-finger-')[0]}-finger`
  if (name.endsWith('-phalanx-proximal')) return `${prefix}-metacarpal`
  if (name.endsWith('-phalanx-intermediate')) return `${prefix}-phalanx-proximal`
  if (name.endsWith('-phalanx-distal')) return name.startsWith('thumb-') ? 'thumb-phalanx-proximal' : `${prefix}-phalanx-intermediate`
  if (name.endsWith('-tip')) return `${prefix}-phalanx-distal`
  return null
}

// ---------- 4x4 helpers (column-major) ----------
export function mat4(): Float64Array {
  const m = new Float64Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  return m
}

/** out = a * b; the matrices live in larger arrays at the given offsets. `out` may not alias `a` or `b`. */
function mulAt(out: Float64Array, o: number, a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number) {
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[o + c * 4 + r] = a[ao + r] * b[bo + c * 4] + a[ao + 4 + r] * b[bo + c * 4 + 1] + a[ao + 8 + r] * b[bo + c * 4 + 2] + a[ao + 12 + r] * b[bo + c * 4 + 3]
  }
}
export const mulMat = (out: Float64Array, a: ArrayLike<number>, b: ArrayLike<number>) => mulAt(out, 0, a, 0, b, 0)

/** A rigid transform from an orthonormal basis (columns x, y, z) and an origin. */
export function basisMat(out: Float64Array, x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number>, origin: ArrayLike<number>) {
  out[0] = x[0]; out[1] = x[1]; out[2] = x[2]; out[3] = 0
  out[4] = y[0]; out[5] = y[1]; out[6] = y[2]; out[7] = 0
  out[8] = z[0]; out[9] = z[1]; out[10] = z[2]; out[11] = 0
  out[12] = origin[0]; out[13] = origin[1]; out[14] = origin[2]; out[15] = 1
}

export function transformPoint(m: ArrayLike<number>, o: number, p: ArrayLike<number>, out: number[] | Float64Array | Float32Array) {
  const x = p[0], y = p[1], z = p[2]
  out[0] = m[o] * x + m[o + 4] * y + m[o + 8] * z + m[o + 12]
  out[1] = m[o + 1] * x + m[o + 5] * y + m[o + 9] * z + m[o + 13]
  out[2] = m[o + 2] * x + m[o + 6] * y + m[o + 10] * z + m[o + 14]
}

const tmpA = new Float64Array(16)

// ---------- loading ----------
export type HandAssets = Record<HandSide, FrettedHandAsset>

/** Fetches the two hand models once per session (shared with the guitar view's cache). */
export async function loadHandAssets(): Promise<HandAssets> {
  const [left, right] = await Promise.all([loadFrettedHand('left'), loadFrettedHand('right')])
  return { left, right }
}

export function createHandMesh(asset: FrettedHandAsset, side: HandSide): HandMesh {
  const names = asset.jointNames
  const count = names.length
  const indexOf = new Map(names.map((name, index) => [name, index]))
  const parent = new Int16Array(count).fill(-1)
  names.forEach((name, index) => {
    const parentOf = parentName(name)
    if (parentOf !== null) parent[index] = indexOf.get(parentOf) ?? -1
  })
  const order: number[] = []
  const seen = new Set<number>()
  const visit = (index: number) => {
    if (seen.has(index)) return
    if (parent[index] >= 0) visit(parent[index])
    seen.add(index)
    order.push(index)
  }
  for (let index = 0; index < count; index++) visit(index)
  const rest = new Float64Array(count * 16), inverseBind = new Float64Array(count * 16)
  names.forEach((name, index) => {
    const bone = asset.bones.get(name)!
    rest.set(bone.localRest, index * 16)
    inverseBind.set(bone.inverseBind, index * 16)
  })
  const vertices = asset.positions.length / 3
  const data = new Float32Array(vertices * 12)
  for (let vertex = 0; vertex < vertices; vertex++) {
    data[vertex * 12 + 6] = asset.uvs[vertex * 2]
    data[vertex * 12 + 7] = asset.uvs[vertex * 2 + 1]
  }
  const need = (name: string) => {
    const index = indexOf.get(name)
    if (index === undefined) throw new Error(`The hand model is missing joint ${name}.`)
    return index
  }
  const digits: Digit[] = [{ bones: [], padBone: 0, pad: [0, 0, 0] }]
  for (let finger = 1 as Finger; finger <= 5; finger++) {
    const prefix = FINGER_PREFIX[finger]
    const bones = finger === 1
      ? ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'].map(need)
      : ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'].map((part) => need(`${prefix}-${part}`))
    digits.push({ bones, padBone: bones[bones.length - 2], pad: [0, 0, 0] })
  }
  const hand: HandMesh = {
    side, data, index: Uint32Array.from(asset.indices), triangles: asset.indices.length / 3,
    world: new Float64Array(count * 16), flex: new Float64Array(count), splay: new Float64Array(count), root: mat4(),
    asset, parent, order, rest, inverseBind, wrist: need('wrist'), digits, skinScratch: new Float64Array(count * 16),
  }
  measurePads(hand)
  return hand
}

/** The vertex of each digit's last bone that sticks out furthest toward the palm, in that bone's own frame: its pad. */
function measurePads(hand: HandMesh) {
  const { asset } = hand
  hand.world.fill(0)
  hand.root.set(mat4())
  poseAll(hand)
  // Palm side in the model: the side of the wrist the thumb tip leans toward.
  const thumbTip = boneIndex(hand, 'thumb-tip')
  const palm = Math.sign(hand.world[thumbTip * 16 + 12] - hand.world[boneIndex(hand, 'index-finger-metacarpal') * 16 + 12]) || 1
  for (let finger = 1; finger <= 5; finger++) {
    const digit = hand.digits[finger]
    // The pad belongs to the last two bones (distal and tip), where the finger's skin is.
    const bones = new Set([digit.padBone, digit.bones[digit.bones.length - 1]])
    let best = -Infinity
    for (let vertex = 0; vertex < asset.positions.length / 3; vertex++) {
      let weight = 0
      for (let slot = 0; slot < 4; slot++) if (bones.has(asset.joints[vertex * 4 + slot])) weight += asset.weights[vertex * 4 + slot]
      if (weight < 0.5) continue
      const score = asset.positions[vertex * 3] * palm
      if (score > best) {
        best = score
        // Vertices are in the bind pose: into the pad bone's frame with its inverse-bind matrix.
        transformPoint(hand.inverseBind, digit.padBone * 16, [asset.positions[vertex * 3], asset.positions[vertex * 3 + 1], asset.positions[vertex * 3 + 2]], digit.pad)
      }
    }
  }
}

function boneIndex(hand: HandMesh, name: string): number {
  return hand.asset.jointNames.indexOf(name)
}

// ---------- posing ----------
function poseBone(hand: HandMesh, bone: number) {
  const { world, rest, parent, flex, splay } = hand
  const p = parent[bone]
  mulAt(tmpA, 0, p < 0 ? hand.root : world, p < 0 ? 0 : p * 16, rest, bone * 16)
  // The right-hand model is a mirror image, so a positive turn moves toward the little finger on both hands.
  const f = -flex[bone], s = hand.side === 'left' ? splay[bone] : -splay[bone]
  if (f === 0 && s === 0) { world.set(tmpA, bone * 16); return }
  // R = Rx(f) * Ry(s); the bone's own axes: x runs across the hand, y across its back.
  const cf = Math.cos(f), sf = Math.sin(f), cs = Math.cos(s), ss = Math.sin(s)
  const r00 = cs, r02 = ss, r10 = sf * ss, r11 = cf, r12 = -sf * cs, r20 = -cf * ss, r21 = sf, r22 = cf * cs
  const o = bone * 16
  for (let row = 0; row < 3; row++) {
    const a = tmpA[row], b = tmpA[4 + row], c = tmpA[8 + row]
    world[o + row] = a * r00 + b * r10 + c * r20
    world[o + 4 + row] = b * r11 + c * r21
    world[o + 8 + row] = a * r02 + b * r12 + c * r22
    world[o + 12 + row] = tmpA[12 + row]
  }
  world[o + 3] = 0; world[o + 7] = 0; world[o + 11] = 0; world[o + 15] = 1
}

export function poseAll(hand: HandMesh) {
  for (const bone of hand.order) poseBone(hand, bone)
}
export function poseDigit(hand: HandMesh, finger: Finger) {
  for (const bone of hand.digits[finger].bones) poseBone(hand, bone)
}

/** Writes a joint's world position of the current pose. */
export function jointPoint(hand: HandMesh, name: string, out: number[] | Float64Array) {
  const o = boneIndex(hand, name) * 16
  out[0] = hand.world[o + 12]; out[1] = hand.world[o + 13]; out[2] = hand.world[o + 14]
}

/** World position of a digit's pad (the furthest point of the fingertip toward the palm). */
export function padPoint(hand: HandMesh, finger: Finger, out: number[] | Float64Array) {
  const digit = hand.digits[finger]
  transformPoint(hand.world, digit.padBone * 16, digit.pad, out)
}

/** Which bones turn for a digit when it flexes: [bone, share of the flexion] pairs the solver and presets drive. */
export function digitBones(hand: HandMesh, finger: Finger) {
  return hand.digits[finger].bones
}

export function resetPose(hand: HandMesh) {
  hand.flex.fill(0)
  hand.splay.fill(0)
}

/** Skins the mesh into `hand.data` from the current pose. */
export function skinHand(hand: HandMesh) {
  const { asset, world, inverseBind, skinScratch, data } = hand
  const joints = asset.jointNames.length
  for (let joint = 0; joint < joints; joint++) mulAt(skinScratch, joint * 16, world, joint * 16, inverseBind, joint * 16)
  const { positions, normals, weights, joints: jointIds } = asset
  const vertices = positions.length / 3
  for (let vertex = 0; vertex < vertices; vertex++) {
    const px = positions[vertex * 3], py = positions[vertex * 3 + 1], pz = positions[vertex * 3 + 2]
    const nx = normals[vertex * 3], ny = normals[vertex * 3 + 1], nz = normals[vertex * 3 + 2]
    let ox = 0, oy = 0, oz = 0, mx = 0, my = 0, mz = 0, total = 0
    for (let slot = 0; slot < 4; slot++) {
      const weight = weights[vertex * 4 + slot]
      if (weight <= 0) continue
      const m = jointIds[vertex * 4 + slot] * 16
      ox += (skinScratch[m] * px + skinScratch[m + 4] * py + skinScratch[m + 8] * pz + skinScratch[m + 12]) * weight
      oy += (skinScratch[m + 1] * px + skinScratch[m + 5] * py + skinScratch[m + 9] * pz + skinScratch[m + 13]) * weight
      oz += (skinScratch[m + 2] * px + skinScratch[m + 6] * py + skinScratch[m + 10] * pz + skinScratch[m + 14]) * weight
      mx += (skinScratch[m] * nx + skinScratch[m + 4] * ny + skinScratch[m + 8] * nz) * weight
      my += (skinScratch[m + 1] * nx + skinScratch[m + 5] * ny + skinScratch[m + 9] * nz) * weight
      mz += (skinScratch[m + 2] * nx + skinScratch[m + 6] * ny + skinScratch[m + 10] * nz) * weight
      total += weight
    }
    const out = vertex * 12
    const inverse = 1 / Math.max(1, total)
    const normal = 1 / Math.max(1e-8, Math.hypot(mx, my, mz))
    data[out] = ox * inverse; data[out + 1] = oy * inverse; data[out + 2] = oz * inverse
    data[out + 3] = mx * normal; data[out + 4] = my * normal; data[out + 5] = mz * normal
  }
}

// ---------- placing the hand ----------
const frameX = new Float64Array(3), frameY = new Float64Array(3), frameZ = new Float64Array(3), frameT = new Float64Array(3)
const handFrame = new Float64Array(16)

/**
 * Puts the hand in the world so that the model point `anchor` lands on `at`, with the fingers pointing along `forward`
 * and the palm facing `palm` (both unit vectors; `palm` need only be roughly perpendicular to `forward`). Writes `hand.root`.
 */
export function placeHand(hand: HandMesh, at: ArrayLike<number>, forward: ArrayLike<number>, palm: ArrayLike<number>, anchor: ArrayLike<number>) {
  // Model axes: fingers run along -y, the palm faces +x (left hand) or -x (right hand), and the width runs along z.
  const sign = hand.side === 'left' ? 1 : -1
  // x_model = sign * palm direction, y_model = -forward, z_model = x_model × y_model.
  const px = palm[0], py = palm[1], pz = palm[2]
  // Remove the part of the palm direction along forward so the basis stays orthonormal.
  const dot = px * forward[0] + py * forward[1] + pz * forward[2]
  let nx = px - dot * forward[0], ny = py - dot * forward[1], nz = pz - dot * forward[2]
  const length = Math.hypot(nx, ny, nz) || 1
  nx /= length; ny /= length; nz /= length
  frameX[0] = nx * sign; frameX[1] = ny * sign; frameX[2] = nz * sign
  frameY[0] = -forward[0]; frameY[1] = -forward[1]; frameY[2] = -forward[2]
  frameZ[0] = frameX[1] * frameY[2] - frameX[2] * frameY[1]
  frameZ[1] = frameX[2] * frameY[0] - frameX[0] * frameY[2]
  frameZ[2] = frameX[0] * frameY[1] - frameX[1] * frameY[0]
  basisMat(handFrame, frameX, frameY, frameZ, frameT.fill(0))
  transformPoint(handFrame, 0, anchor, scratchPoint)
  basisMat(hand.root, frameX, frameY, frameZ, [at[0] - scratchPoint[0], at[1] - scratchPoint[1], at[2] - scratchPoint[2]])
}
const scratchPoint = new Float64Array(3)

/** Places the hand from a full rigid transform of the model (used when a held object fixes the hand's pose). */
export function setRoot(hand: HandMesh, matrix: ArrayLike<number>) {
  for (let index = 0; index < 16; index++) hand.root[index] = matrix[index]
}

// ---------- reaching a point with a digit ----------
export type DigitLimits = { ranges: [number, number][]; ratio: number }
const FINGER_LIMITS: DigitLimits = { ranges: [[-0.35, 1.45], [-0.45, 0.45], [0, 1.9]], ratio: 0.7 }
const THUMB_LIMITS: DigitLimits = { ranges: [[-0.9, 0.9], [-0.9, 0.9], [-0.2, 1.1]], ratio: 0.8 }

const params = new Float64Array(3), reach = new Float64Array(3), jac = new Float64Array(9), step = new Float64Array(3), pad = new Float64Array(3)

function applyParams(hand: HandMesh, finger: Finger, a: number, b: number, c: number, ratio: number) {
  const bones = hand.digits[finger].bones
  if (finger === 1) {
    // Thumb: the base turns on both axes; the first and second joints bend together.
    hand.flex[bones[0]] = a; hand.splay[bones[0]] = b
    hand.flex[bones[1]] = c; hand.flex[bones[2]] = c * ratio
  } else {
    hand.flex[bones[1]] = a; hand.splay[bones[1]] = b
    hand.flex[bones[2]] = c; hand.flex[bones[3]] = c * ratio
  }
  poseDigit(hand, finger)
}

/**
 * Bends and turns one digit so its pad reaches `target` (world) as closely as its joints allow, starting from the given
 * relaxed posture. Deterministic: the same inputs always give the same pose. Returns the remaining distance in metres.
 */
export function reachDigit(hand: HandMesh, finger: Finger, target: ArrayLike<number>, start: readonly [number, number, number], limits?: DigitLimits): number {
  const lim = limits ?? (finger === 1 ? THUMB_LIMITS : FINGER_LIMITS)
  const p = params
  p[0] = start[0]; p[1] = start[1]; p[2] = start[2]
  const clamp = (v: number, range: [number, number]) => Math.max(range[0], Math.min(range[1], v))
  const ranges = lim.ranges
  const evaluate = () => {
    applyParams(hand, finger, p[0], p[1], p[2], lim.ratio)
    padPoint(hand, finger, pad)
    reach[0] = target[0] - pad[0]; reach[1] = target[1] - pad[1]; reach[2] = target[2] - pad[2]
    return Math.hypot(reach[0], reach[1], reach[2])
  }
  let error = evaluate()
  const eps = 1e-3
  for (let iteration = 0; iteration < 14 && error > 5e-5; iteration++) {
    const e0 = reach[0], e1 = reach[1], e2 = reach[2]
    for (let k = 0; k < 3; k++) {
      const saved = p[k]
      p[k] = saved + eps
      applyParams(hand, finger, p[0], p[1], p[2], lim.ratio)
      padPoint(hand, finger, pad)
      // Jacobian column: change of the pad per radian.
      jac[k] = (pad[0] - (target[0] - e0)) / eps
      jac[3 + k] = (pad[1] - (target[1] - e1)) / eps
      jac[6 + k] = (pad[2] - (target[2] - e2)) / eps
      p[k] = saved
    }
    // Damped least squares: (JᵀJ + λI) Δ = Jᵀ e, solved by Cramer's rule on the 3x3 system.
    const lambda = 2e-4 + error * 4e-3
    let a00 = lambda, a01 = 0, a02 = 0, a11 = lambda, a12 = 0, a22 = lambda, b0 = 0, b1 = 0, b2 = 0
    for (let row = 0; row < 3; row++) {
      const j0 = jac[row * 3], j1 = jac[row * 3 + 1], j2 = jac[row * 3 + 2]
      const e = row === 0 ? e0 : row === 1 ? e1 : e2
      a00 += j0 * j0; a01 += j0 * j1; a02 += j0 * j2; a11 += j1 * j1; a12 += j1 * j2; a22 += j2 * j2
      b0 += j0 * e; b1 += j1 * e; b2 += j2 * e
    }
    const det = a00 * (a11 * a22 - a12 * a12) - a01 * (a01 * a22 - a12 * a02) + a02 * (a01 * a12 - a11 * a02)
    if (Math.abs(det) < 1e-18) break
    step[0] = (b0 * (a11 * a22 - a12 * a12) - a01 * (b1 * a22 - a12 * b2) + a02 * (b1 * a12 - a11 * b2)) / det
    step[1] = (a00 * (b1 * a22 - a12 * b2) - b0 * (a01 * a22 - a12 * a02) + a02 * (a01 * b2 - b1 * a02)) / det
    step[2] = (a00 * (a11 * b2 - b1 * a12) - a01 * (a01 * b2 - b1 * a02) + b0 * (a01 * a12 - a11 * a02)) / det
    const limit = 0.5
    for (let k = 0; k < 3; k++) p[k] = clamp(p[k] + Math.max(-limit, Math.min(limit, step[k])), ranges[k])
    error = evaluate()
  }
  return error
}

export const poseOf = (hand: HandMesh, finger: Finger): [number, number, number] => {
  const bones = hand.digits[finger].bones
  return finger === 1
    ? [hand.flex[bones[0]], hand.splay[bones[0]], hand.flex[bones[1]]]
    : [hand.flex[bones[1]], hand.splay[bones[1]], hand.flex[bones[2]]]
}

/** Sets a relaxed or gripping posture for a digit from the same three numbers the solver uses. */
export function setDigit(hand: HandMesh, finger: Finger, a: number, b: number, c: number, ratio = finger === 1 ? THUMB_LIMITS.ratio : FINGER_LIMITS.ratio) {
  applyParams(hand, finger, a, b, c, ratio)
}

// ---------- the wrist ----------
/** A short tube drawn as a renderer overlay and rewritten each frame. */
export type Limb = { data: Float32Array; index: Uint32Array; rings: number; sides: number }
export type Arm = {
  /** The short wrist that continues the hand past its cut end, fading out. */
  fore: Limb
  /** Centre of the hand model's cut wrist end, in the model's frame, and its half-widths across (x) and through (z). */
  cut: [number, number, number]
  halfX: number
  halfZ: number
  wrist: Vec
}
const LIMB_SIDES = 16, LIMB_RINGS = 6
/** How far the wrist reaches back past the wrist joint, and how far it starts inside the hand so no seam shows. */
export const WRIST_LENGTH = 0.05, WRIST_OVERLAP = 0.015

function createLimb(): Limb {
  const vertices = (LIMB_RINGS + 1) * (LIMB_SIDES + 1)
  const index: number[] = []
  for (let ring = 0; ring < LIMB_RINGS; ring++) for (let side = 0; side < LIMB_SIDES; side++) {
    const v = ring * (LIMB_SIDES + 1) + side, c = v + LIMB_SIDES + 1
    index.push(v, v + 1, c, v + 1, c + 1, c)
  }
  return { data: new Float32Array(vertices * 12), index: Uint32Array.from(index), rings: LIMB_RINGS, sides: LIMB_SIDES }
}

/** The wrist tube, sized to the hand model's own cut wrist section. */
export function createArm(hand: HandMesh): Arm {
  const { positions } = hand.asset
  let top = -Infinity
  for (let i = 1; i < positions.length; i += 3) top = Math.max(top, positions[i])
  // The cut end: every vertex within 4 mm of the one farthest back from the fingers.
  const min = [Infinity, Infinity], max = [-Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) if (positions[i + 1] > top - 0.004) {
    min[0] = Math.min(min[0], positions[i]); max[0] = Math.max(max[0], positions[i])
    min[1] = Math.min(min[1], positions[i + 2]); max[1] = Math.max(max[1], positions[i + 2])
  }
  return {
    fore: createLimb(), cut: [(min[0] + max[0]) / 2, top, (min[1] + max[1]) / 2],
    halfX: (max[0] - min[0]) / 2, halfZ: (max[1] - min[1]) / 2, wrist: [0, 0, 0],
  }
}

/**
 * Writes the short wrist for a hand placed by `root`: an ellipse the size of the hand's own wrist section that
 * continues along the hand's back axis, tapers a little and fades out (the renderer reads uv.x = 2 + fade).
 */
export function poseArm(arm: Arm, root: ArrayLike<number>) {
  const { cut, halfX, halfZ } = arm
  const { data, rings, sides } = arm.fore
  arm.wrist[0] = root[0] * cut[0] + root[4] * cut[1] + root[8] * cut[2] + root[12]
  arm.wrist[1] = root[1] * cut[0] + root[5] * cut[1] + root[9] * cut[2] + root[13]
  arm.wrist[2] = root[2] * cut[0] + root[6] * cut[1] + root[10] * cut[2] + root[14]
  for (let ring = 0; ring <= rings; ring++) {
    const t = ring / rings
    const along = WRIST_LENGTH - (WRIST_LENGTH + WRIST_OVERLAP) * t
    const scale = 0.9 + 0.1 * t
    for (let side = 0; side <= sides; side++) {
      const angle = side / sides * Math.PI * 2
      const cx = Math.cos(angle), sz = Math.sin(angle)
      const x = cut[0] + halfX * scale * cx, y = cut[1] + along, z = cut[2] + halfZ * scale * sz
      let nx = cx / halfX, nz = sz / halfZ
      const nl = Math.hypot(nx, nz) || 1
      nx /= nl; nz /= nl
      const o = (ring * (sides + 1) + side) * 12
      data[o] = root[0] * x + root[4] * y + root[8] * z + root[12]
      data[o + 1] = root[1] * x + root[5] * y + root[9] * z + root[13]
      data[o + 2] = root[2] * x + root[6] * y + root[10] * z + root[14]
      data[o + 3] = root[0] * nx + root[8] * nz; data[o + 4] = root[1] * nx + root[9] * nz; data[o + 5] = root[2] * nx + root[10] * nz
      data[o + 6] = 2 + (1 - t)
    }
  }
}