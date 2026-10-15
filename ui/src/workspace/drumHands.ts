import type { Overlay } from './kitRenderer'
import type { MaterialView, Prepared } from './kitAsset'
import { kitStrike, type KitPiece } from './kit'
import type { DrumHit } from './song'
import type { Hand } from './sticking'
import {
  createArm, createHandMesh, jointPoint, loadHandAssets, poseArm, mat4, poseAll, reachDigit, resetPose, setRoot, skinHand, transformPoint,
  type Arm, type Finger, type HandAssets, type HandMesh, type HandSide,
} from './handRig'

/**
 * Hands holding drumsticks for the 3D kit. Each hand is a connected skinned hand gripping a procedural stick; the stick
 * tip is driven from the playback clock alone (never from accumulated state), so seeking, looping and pausing always
 * show the same pose for the same time. The motion is a suggestion built from the sticking, not a recording of a player.
 */
export type Strike = { beat: number; piece: KitPiece; velocity: number }
export type HandPlan = Record<HandSide, Strike[]>
export type Surface = { x: number; y: number; z: number; radius: number; cymbal: boolean }
export type SurfaceMap = Map<KitPiece, Surface>

/** The pieces a hand can strike (feet play the kick and the hi-hat pedal). */
const HAND_PIECES: KitPiece[] = ['snare', 'tom1', 'tom2', 'floor', 'hihat', 'crash', 'ride']
const CYMBALS = new Set<KitPiece>(['hihat', 'crash', 'ride'])

// ---------- the kit's playable surfaces ----------
const surfaceCache = new WeakMap<Prepared, SurfaceMap>()

/** Where each striking surface is: its centre, its radius and the height of its top at the strike point (world metres). */
export function kitSurfaces(prepared: Prepared): SurfaceMap {
  const cached = surfaceCache.get(prepared)
  if (cached) return cached
  const out: SurfaceMap = new Map()
  for (const piece of HAND_PIECES) {
    const items = prepared.items.filter((item) => item.target === piece && item.glows)
    if (!items.length) continue
    // The ride's bow, where it is played, is a separate part; every other piece uses all of its playable parts.
    const bow = items.filter((item) => /Bow/.test(item.name))
    const main = bow.length ? bow : items
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    const world = (item: (typeof items)[number], vertex: number, k: number) =>
      item.frame[k] * item.data[vertex * 12] + item.frame[4 + k] * item.data[vertex * 12 + 1] + item.frame[8 + k] * item.data[vertex * 12 + 2] + item.frame[12 + k]
    for (const item of main) for (let vertex = 0; vertex < item.data.length / 12; vertex++) for (let k = 0; k < 3; k++) {
      const value = world(item, vertex, k)
      if (value < min[k]) min[k] = value
      if (value > max[k]) max[k] = value
    }
    const cymbal = CYMBALS.has(piece)
    const radius = Math.max(max[0] - min[0], max[2] - min[2]) / 2
    const x = (min[0] + max[0]) / 2
    // Cymbals are struck on the bow, toward the player from the bell.
    const z = (min[2] + max[2]) / 2 + (cymbal ? radius * 0.4 : 0)
    out.set(piece, { x, y: topAt(items, x, z) ?? max[1], z, radius, cymbal })
  }
  surfaceCache.set(prepared, out)
  return out
}

/** Height of the highest triangle above (x, z), or null when nothing is there. */
function topAt(items: Prepared['items'], x: number, z: number): number | null {
  let best: number | null = null
  const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0]
  for (const item of items) {
    const f = item.frame, d = item.data
    for (let i = 0; i < item.index.length; i += 3) {
      for (const [target, vertex] of [[a, item.index[i]], [b, item.index[i + 1]], [c, item.index[i + 2]]] as [number[], number][]) {
        const px = d[vertex * 12], py = d[vertex * 12 + 1], pz = d[vertex * 12 + 2]
        target[0] = f[0] * px + f[4] * py + f[8] * pz + f[12]
        target[1] = f[1] * px + f[5] * py + f[9] * pz + f[13]
        target[2] = f[2] * px + f[6] * py + f[10] * pz + f[14]
      }
      const denominator = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
      if (Math.abs(denominator) < 1e-12) continue
      const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / denominator
      const v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / denominator
      const w = 1 - u - v
      if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue
      const y = u * a[1] + v * b[1] + w * c[1]
      if (best === null || y > best) best = y
    }
  }
  return best
}

// ---------- who plays what, and when ----------
/**
 * Each hand's strokes in beat order. A hit with no hand (a song whose sticking cannot be suggested) is given to the
 * hand nearer its surface, so the motion never stops; the L/R legend and glow colours still show only what is known.
 */
export function buildHandPlan(drums: readonly DrumHit[], hands: readonly (Hand | undefined)[], surfaces: SurfaceMap): HandPlan {
  const plan: HandPlan = { left: [], right: [] }
  const ordered = drums.map((hit, index) => ({ hit, hand: hands[index] })).sort((a, b) => a.hit.startBeat - b.hit.startBeat)
  for (const { hit, hand } of ordered) {
    const strike = kitStrike(hit)
    if (strike.foot) continue
    const piece = strike.pieces[0]
    if (!HAND_PIECES.includes(piece)) continue
    const surface = surfaces.get(piece)
    const side: HandSide = hand ?? (surface && !surface.cymbal && surface.x < 0 ? 'left' : 'right')
    const list = plan[side]
    const last = list.at(-1)
    if (last && Math.abs(last.beat - hit.startBeat) < 1e-6) { last.velocity = Math.max(last.velocity, hit.velocity); continue }
    list.push({ beat: hit.startBeat, piece, velocity: hit.velocity })
  }
  return plan
}

// ---------- the stroke, from the clock ----------
export type DrumClock = {
  beat: number
  playing: boolean
  countingIn: boolean
  countBeat: number
  countLength: number
  secondsPerBeat: number
  loop: { start: number; end: number } | null
  /** Hold still at the target positions instead of swinging. */
  reduced: boolean
  /** Rise of the top hi-hat cymbal for the current hat state, metres. */
  hatOffset: number
}
export type StickState = {
  /** The stick tip's lowest point (where it lands), metres. */
  tip: [number, number, number]
  /** Where the hand's grip holds the stick. */
  grip: [number, number, number]
  /** Unit vector along the stick, butt to tip. */
  direction: [number, number, number]
  /** The surface the tip is at or heading to, and how high the tip is above it, metres. */
  piece: KitPiece | null
  lift: number
  /** True in the instant a stroke lands. */
  striking: boolean
  /** The wrist (the cut end of the hand), where its short wrist begins. */
  wrist: [number, number, number]
  /** Unit vector along the hand's back axis, from the wrist away from the fingers. */
  forearm: [number, number, number]
}

const STICK_LENGTH = 0.4
const GRIP_FROM_BUTT = STICK_LENGTH / 3
const BEAD_RADIUS = 0.0045
/** Distance along the stick from the grip to the centre of the tip's bead. */
const GRIP_TO_BEAD = STICK_LENGTH - 0.004 - BEAD_RADIUS - GRIP_FROM_BUTT
const IDLE_LIFT = 0.05
const EPS = 1e-6

const smooth = (t: number) => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)

type Neighbours = { prev: Strike | null; next: Strike | null; s: number; u: number; gap: number }
const near: Neighbours = { prev: null, next: null, s: 0, u: 0, gap: Infinity }

/** The strokes either side of `beat`, wrapping across the loop's end, and the seconds since and until them. */
function neighbours(list: Strike[], clock: DrumClock): Neighbours {
  const { beat, loop, secondsPerBeat } = clock
  const inside = loop && beat >= loop.start - EPS && beat < loop.end - EPS ? loop : null
  let first = 0, end = list.length
  while (first < end) { const middle = (first + end) >> 1; if (list[middle].beat <= beat + EPS) first = middle + 1; else end = middle }
  let prev: Strike | null = first > 0 ? list[first - 1] : null
  let next: Strike | null = first < list.length ? list[first] : null
  let prevBeat = prev ? prev.beat : 0, nextBeat = next ? next.beat : 0
  if (inside) {
    if (prev && prev.beat < inside.start - EPS) prev = null
    if (next && next.beat >= inside.end - EPS) next = null
    if (!prev || !next) {
      // Across the loop's end the neighbour is the other end's stroke, one loop length away.
      let lo = 0, hi = list.length
      while (hi > lo) { const middle = (lo + hi) >> 1; if (list[middle].beat < inside.start - EPS) lo = middle + 1; else hi = middle }
      const firstInLoop = list[lo] && list[lo].beat < inside.end - EPS ? list[lo] : null
      let lastIndex = lo
      while (list[lastIndex + 1] && list[lastIndex + 1].beat < inside.end - EPS) lastIndex++
      const lastInLoop = firstInLoop ? list[lastIndex] : null
      const length = inside.end - inside.start
      if (!next && firstInLoop) { next = firstInLoop; nextBeat = firstInLoop.beat + length }
      if (!prev && lastInLoop) { prev = lastInLoop; prevBeat = lastInLoop.beat - length }
    }
  }
  near.prev = prev; near.next = next
  near.s = prev ? Math.max(0, beat - prevBeat) * secondsPerBeat : Infinity
  near.u = next ? Math.max(0, nextBeat - beat) * secondsPerBeat : Infinity
  near.gap = prev && next ? near.s + near.u : Infinity
  return near
}

// ---------- hand and stick geometry ----------
type Vec3 = [number, number, number]
// The stick's line in the left-hand model (the right-hand model is its mirror across x): a point at the thumb-and-index
// fulcrum and the direction toward the tip. The palm faces +x, the fingers run along -y and the width along z.
const LINE_POINT: Vec3 = [0.011, -0.045, -0.015]
const LINE_DIRECTION: Vec3 = [0, -0.62, -0.78]
/** Where each finger's pad ends, as a direction from the stick's axis: wrapped around its far side toward the palm. */
const WRAP: Vec3[] = [[-0.1, 0.1, -1], [0.35, 0.95, 0], [0.3, 1, 0], [0.4, 0.9, 0], [1, 0.1, 0]]
const STICK_RADIUS = 0.0074
const THUMB_ALONG = -0.03
/** Relaxed starting curls the solver refines: [bend at the knuckle, sideways turn, bend at the middle joint]. */
const CURL_START: Vec3[] = [[0.2, 0.1, 0.3], [0.9, 0, 1.0], [1.0, 0, 1.0], [1.1, 0, 1.0], [1.1, 0, 1.0]]
type Part = { mesh: HandMesh; overlay: Overlay; arm: Arm; foreOverlay: Overlay }
export type DrumHandsOptions = { skin: MaterialView; wood: MaterialView; alpha: number }

const SKIN: MaterialView = { name: 'hand', base: [0.86, 0.66, 0.55, 1], metal: 0, rough: 0.72, emissive: [0, 0, 0], baseTex: -1, ormTex: -1, normalTex: -1, emissiveTex: -1, normalScale: 1, blend: false }
const WOOD: MaterialView = { name: 'drumstick', base: [0.78, 0.6, 0.36, 1], metal: 0, rough: 0.55, emissive: [0, 0, 0], baseTex: -1, ormTex: -1, normalTex: -1, emissiveTex: -1, normalScale: 1, blend: false }

const STICK_SIDES = 14
/** Radius along the stick (metres from the butt): a rounded butt, a long even shaft, a taper, a neck and the bead. */
const STICK_PROFILE: [number, number][] = [
  [0, 0.0001], [0.0015, 0.0045], [0.005, 0.0066], [0.012, 0.0072], [0.2, 0.0072], [0.29, 0.0062], [0.345, 0.0042], [0.378, 0.0034],
  [0.386, 0.0044], [0.3915, 0.0048], [0.3985, 0.0034], [0.4, 0.0001],
]

type StickMesh = { overlay: Overlay; local: Float32Array }
function buildStick(): StickMesh {
  const rings = STICK_PROFILE.length
  const vertices = rings * (STICK_SIDES + 1)
  const local = new Float32Array(vertices * 6)
  const data = new Float32Array(vertices * 12)
  const index: number[] = []
  for (let ring = 0; ring < rings; ring++) {
    const [along, radius] = STICK_PROFILE[ring]
    const next = STICK_PROFILE[Math.min(rings - 1, ring + 1)], before = STICK_PROFILE[Math.max(0, ring - 1)]
    // The surface normal tilts with the profile's slope.
    const slope = (next[1] - before[1]) / Math.max(1e-6, next[0] - before[0])
    const norm = 1 / Math.hypot(1, slope)
    for (let side = 0; side <= STICK_SIDES; side++) {
      const angle = side / STICK_SIDES * Math.PI * 2
      const cx = Math.cos(angle), cy = Math.sin(angle)
      const v = ring * (STICK_SIDES + 1) + side
      // Local frame: x, y across the stick, z along it from the grip point (butt behind, tip ahead).
      local.set([cx * radius, cy * radius, along - GRIP_FROM_BUTT, cx * norm, cy * norm, -slope * norm], v * 6)
      data[v * 12 + 6] = side / STICK_SIDES
      data[v * 12 + 7] = along / STICK_LENGTH
      if (ring < rings - 1 && side < STICK_SIDES) {
        const a = v, b = v + 1, c = v + STICK_SIDES + 1, d = c + 1
        index.push(a, c, b, b, c, d)
      }
    }
  }
  return { local, overlay: { name: 'drumstick', data, index: Uint32Array.from(index), material: WOOD, alpha: 1, visible: false } }
}

const ex = [0, 0, 0], ey = [0, 0, 0], ez = [0, 0, 0]
const handBasis = mat4(), modelBasis = mat4(), inverseModel = mat4(), rootScratch = mat4()
const gripPoint = [0, 0, 0], from = [0, 0, 0], to = [0, 0, 0]

function normalizeInto(out: number[], x: number, y: number, z: number) {
  const length = Math.hypot(x, y, z) || 1
  out[0] = x / length; out[1] = y / length; out[2] = z / length
}

/** Rigid transform taking `fromBasis` columns (a, b, c at p) to `toBasis`; with the two bases' columns orthonormal. */
function alignInto(out: Float64Array, model: Float64Array, world: Float64Array) {
  // inverse of a rigid matrix (rotation transposed)
  inverseModel.fill(0)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) inverseModel[c * 4 + r] = model[r * 4 + c]
  inverseModel[15] = 1
  for (let r = 0; r < 3; r++) inverseModel[12 + r] = -(inverseModel[r] * model[12] + inverseModel[4 + r] * model[13] + inverseModel[8 + r] * model[14])
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[c * 4 + r] = world[r] * inverseModel[c * 4] + world[4 + r] * inverseModel[c * 4 + 1] + world[8 + r] * inverseModel[c * 4 + 2] + world[12 + r] * inverseModel[c * 4 + 3]
  }
}

const knuckle = [0, 0, 0]
/** Where a finger's knuckle sits across the hand (model z), in the rest pose. */
function fingerZ(mesh: HandMesh, finger: Finger): number {
  jointPoint(mesh, `${['', '', 'index', 'middle', 'ring', 'pinky'][finger]}-finger-phalanx-proximal`, knuckle)
  return knuckle[2]
}

/** Two hands and two sticks, ready to draw as renderer overlays. */
export class DrumHands {
  readonly overlays: Overlay[]
  readonly state: Record<HandSide, StickState>
  private parts: Record<HandSide, Part>
  private sticks: Record<HandSide, StickMesh>
  private gripModel: Record<HandSide, { point: Vec3; direction: Vec3 }>
  /** How far each digit's pad is from the stick it wraps, after fitting (metres), for tests. */
  readonly gripError: Record<HandSide, number[]> = { left: [], right: [] }
  private rest: Record<HandSide, Vec3 & { piece?: KitPiece }> = { left: [0, 0, 0], right: [0, 0, 0] }
  /** The implied shoulders (metres, world): 40 cm apart, about 50 cm above the snare and behind the player's seat edge. */
  readonly shoulder: Record<HandSide, Vec3> = { left: [-0.2, 1.2, 0.7], right: [0.2, 1.2, 0.7] }
  private gripAngle: Record<HandSide, number> = { left: 0.8, right: 0.8 }

  constructor(assets: HandAssets, options?: Partial<DrumHandsOptions>) {
    const make = (side: HandSide): Part => {
      const mesh = createHandMesh(assets[side], side)
      const arm = createArm(mesh)
      const material = options?.skin ?? SKIN, alpha = options?.alpha ?? 1
      return { mesh, arm, overlay: { name: `${side}-hand`, data: mesh.data, index: mesh.index, material, alpha, visible: false },
        foreOverlay: { name: `${side}-wrist`, data: arm.fore.data, index: arm.fore.index, material, alpha, visible: false, fade: true } }
    }
    this.parts = { left: make('left'), right: make('right') }
    this.sticks = { left: buildStick(), right: buildStick() }
    if (options?.wood) for (const side of ['left', 'right'] as const) this.sticks[side].overlay.material = options.wood
    // The right-hand model is the left one mirrored across x.
    const mirror = (v: Vec3): Vec3 => [-v[0], v[1], v[2]]
    const unit = (v: Vec3): Vec3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l] }
    this.gripModel = { left: { point: LINE_POINT, direction: unit(LINE_DIRECTION) }, right: { point: mirror(LINE_POINT), direction: mirror(unit(LINE_DIRECTION)) } }
    this.overlays = [this.parts.left.overlay, this.parts.right.overlay, this.sticks.left.overlay, this.sticks.right.overlay,
      this.parts.left.foreOverlay, this.parts.right.foreOverlay]
    const blank = (): StickState => ({ tip: [0, 0, 0], grip: [0, 0, 0], direction: [0, 0, -1], piece: null, lift: 0, striking: false, forearm: [0, 0, 1], wrist: [0, 0, 0] })
    this.state = { left: blank(), right: blank() }
    for (const side of ['left', 'right'] as const) { this.gripAngle[side] = Math.atan2(Math.abs(this.gripModel[side].direction[2]), Math.abs(this.gripModel[side].direction[1])); this.applyGrip(side) }
  }

  /** Where the first-frame hands hover when no stroke is known: the left over the snare, the right over the hi-hat. */
  private homes(surfaces: SurfaceMap) {
    const snare = surfaces.get('snare'), hat = surfaces.get('hihat') ?? surfaces.get('ride')
    // Seated on a throne about 50 cm high behind the snare: shoulders 40 cm apart, about 58 cm above the seat.
    if (snare) { this.shoulder.left = [-0.2, 1.08, snare.z + 0.5]; this.shoulder.right = [0.2, 1.08, snare.z + 0.5] }
    this.rest.left = snare ? [snare.x - snare.radius * 0.25, snare.y, snare.z] : [-0.25, 0.7, 0.2]
    this.rest.left.piece = snare ? 'snare' : undefined
    this.rest.right = hat ? [hat.x + hat.radius * 0.1, hat.y, hat.z] : [0.2, 0.9, 0.1]
    this.rest.right.piece = hat ? (surfaces.has('hihat') ? 'hihat' : 'ride') : undefined
  }

  // Curls the fingers and thumb around the stick's line, once, in the model's own frame.
  private applyGrip(side: HandSide) {
    const mesh = this.parts[side].mesh
    const { point, direction } = this.gripModel[side]
    const mirror = side === 'left' ? 1 : -1
    resetPose(mesh)
    mesh.root.set(mat4())
    poseAll(mesh)
    const target = [0, 0, 0], at = [0, 0, 0]
    this.gripError[side] = []
    for (let finger = 1 as Finger; finger <= 5; finger++) {
      // The stick's axis at this digit's own place across the hand.
      const z = finger === 1 ? THUMB_ALONG : fingerZ(mesh, finger)
      const t = (z - point[2]) / direction[2]
      for (let k = 0; k < 3; k++) at[k] = point[k] + direction[k] * t
      const wrap = WRAP[finger - 1]
      const length = Math.hypot(...wrap)
      for (let k = 0; k < 3; k++) target[k] = at[k] + STICK_RADIUS * (k === 0 ? mirror : 1) * wrap[k] / length
      this.gripError[side].push(reachDigit(mesh, finger, target, CURL_START[finger - 1]))
    }
  }
  /** Poses both hands for the clock. `plan` and `surfaces` come from the kit and its sticking. */
  update(plan: HandPlan, surfaces: SurfaceMap, clock: DrumClock, visible: boolean) {
    this.homes(surfaces)
    for (const side of ['left', 'right'] as const) {
      const part = this.parts[side], stick = this.sticks[side]
      part.overlay.visible = part.foreOverlay.visible = stick.overlay.visible = visible
      if (!visible) continue
      this.stroke(side, plan[side], surfaces, clock)
      this.seat(side)
    }
  }

  // Where a stick tip meets a surface: two hands on one drum take either side of its centre.
  private pointOn(side: HandSide, piece: KitPiece | undefined, surfaces: SurfaceMap, clock: DrumClock, lateral: number, out: number[]) {
    const surface = piece ? surfaces.get(piece) : undefined
    if (!surface) { out[0] = this.rest[side][0]; out[1] = this.rest[side][1]; out[2] = this.rest[side][2]; return out }
    const offset = surface.radius * (surface.cymbal ? 0.1 : 0.22) * lateral
    out[0] = surface.x + offset; out[2] = surface.z
    out[1] = surface.y + (piece === 'hihat' ? clock.hatOffset : 0)
    return out
  }

  // The tip's target for one hand at this time.
  private stroke(side: HandSide, list: Strike[], surfaces: SurfaceMap, clock: DrumClock) {
    const state = this.state[side]
    const lateral = side === 'left' ? -1 : 1
    const point = (piece: KitPiece | undefined, out: number[]) => this.pointOn(side, piece, surfaces, clock, lateral, out)
    const n = neighbours(list, clock)
    const prev = n.prev, next = n.next
    let piece: KitPiece | undefined, lift = IDLE_LIFT, rho = 0, arch = 0
    let striking = false
    const waiting = !clock.playing || clock.countingIn
    if (waiting) {
      // Paused or counting in: ready over the stroke that comes next (the last one at the end), tip raised a little.
      // A stroke at this very beat is the one coming.
      piece = ((prev && n.s < 0.02 ? prev : next ?? prev))?.piece ?? this.rest[side].piece
      point(piece, from); to[0] = from[0]; to[1] = from[1]; to[2] = from[2]
      lift = clock.countingIn ? IDLE_LIFT + 0.04 * Math.min(1, clock.countBeat / Math.max(1, clock.countLength)) : IDLE_LIFT
    } else if (clock.reduced) {
      // No swinging: the tip stays at its target, touching it in the instant of a stroke and hovering otherwise.
      const closer = prev && (!next || n.s <= n.u) ? prev : next ?? prev
      piece = closer?.piece ?? this.rest[side].piece
      point(piece, from); to[0] = from[0]; to[1] = from[1]; to[2] = from[2]
      striking = !!prev && n.s < 0.12
      lift = striking ? 0 : IDLE_LIFT * 0.6
    } else {
      point(prev?.piece ?? next?.piece ?? this.rest[side].piece, from)
      point(next?.piece ?? prev?.piece ?? this.rest[side].piece, to)
      piece = (next && n.u < n.s ? next : prev ?? next)?.piece ?? this.rest[side].piece
      const velocity = (next ?? prev)?.velocity ?? 0.6
      const gap = n.gap
      // Distance covered between the two surfaces, for the arc over whatever is between them.
      const distance = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2])
      const arrive = Math.min(0.1, 0.25 * gap)
      const travel = Math.min(0.4, Math.max(0.05, gap - arrive))
      if (prev && next) {
        const start = gap - arrive - travel
        rho = smooth((n.s - start) / travel)
        arch = Math.sin(Math.PI * rho) * Math.min(0.06, distance * 0.3)
        const rise = 1 - (1 - Math.min(1, n.s / Math.min(0.12, gap * 0.45))) ** 2
        const fall = Math.min(1, n.u / Math.min(0.2, gap * 0.55)) ** 1.6
        const top = Math.min(0.1, Math.max(0.03, 0.02 + 0.18 * gap)) * (0.65 + 0.35 * velocity)
        lift = top * Math.min(rise, fall)
        striking = n.s < 0.012
      } else if (prev) {
        // After the last stroke: rebound, then hover.
        const rise = 1 - (1 - Math.min(1, n.s / 0.12)) ** 2
        lift = IDLE_LIFT * rise
        striking = n.s < 0.012
      } else if (next) {
        // Before the first stroke: hover over the first target and come down onto it.
        const fall = Math.min(1, n.u / 0.2) ** 1.6
        lift = (IDLE_LIFT + 0.05 * velocity) * fall
      }
    }
    // Position: between the surfaces by `rho`, with the height of the blend plus the swing and the arc.
    const x = from[0] + (to[0] - from[0]) * rho
    const z = from[2] + (to[2] - from[2]) * rho
    const y = from[1] + (to[1] - from[1]) * rho + lift + arch
    state.tip[0] = x; state.tip[1] = y; state.tip[2] = z
    state.piece = piece ?? null
    state.lift = lift + arch
    state.striking = striking
  }

  // From the tip and its lift, the stick's direction, then the hand that holds it.
  private seat(side: HandSide) {
    const state = this.state[side]
    const sign = side === 'left' ? 1 : -1
    const shoulder = this.shoulder[side]
    // The tip dips below the grip at the stroke and rises with the lift; the grip height barely changes.
    const elevation = -0.25 + 4 * Math.min(0.2, state.lift)
    const cosEl = Math.cos(elevation), sinEl = Math.sin(elevation)
    // The forearm runs from the hand back to its own shoulder; the stick leaves the hand turned inward from the forearm by the grip's angle.
    const turn = this.gripAngle[side]
    let azimuth = sign * turn
    for (let pass = 0; pass < 4; pass++) {
      const gx = state.tip[0] - Math.sin(azimuth) * cosEl * GRIP_TO_BEAD, gz = state.tip[2] + Math.cos(azimuth) * cosEl * GRIP_TO_BEAD
      azimuth = Math.max(-1.7, Math.min(1.7, Math.atan2(gx - shoulder[0], shoulder[2] - gz) + sign * turn))
    }
    const dx = Math.sin(azimuth) * cosEl, dy = sinEl, dz = -Math.cos(azimuth) * cosEl
    state.direction[0] = dx; state.direction[1] = dy; state.direction[2] = dz
    // The tip's lowest point is a bead radius under the bead's centre.
    const cx = state.tip[0], cy = state.tip[1] + BEAD_RADIUS, cz = state.tip[2]
    gripPoint[0] = cx - dx * GRIP_TO_BEAD; gripPoint[1] = cy - dy * GRIP_TO_BEAD; gripPoint[2] = cz - dz * GRIP_TO_BEAD
    state.grip[0] = gripPoint[0]; state.grip[1] = gripPoint[1]; state.grip[2] = gripPoint[2]
    const toward = Math.hypot(shoulder[0] - state.grip[0], shoulder[2] - state.grip[2])
    const rise = Math.max(0.1, Math.min(0.45, (shoulder[1] - state.grip[1]) / Math.hypot(shoulder[1] - state.grip[1], toward)))
    this.placeHandOnStick(side, dx, dy, dz, rise)
    const root = this.parts[side].mesh.root
    state.forearm[0] = root[4]; state.forearm[1] = root[5]; state.forearm[2] = root[6]
    this.writeStick(side, dx, dy, dz)
  }

  // The hand's rigid transform that puts its grip line on the stick with the palm turned as far down as the stick allows.
  private placeHandOnStick(side: HandSide, dx: number, dy: number, dz: number, rise: number) {
    const mesh = this.parts[side].mesh
    const grip = this.gripModel[side]
    // Model frame: along the stick, the palm's direction across it, and the third axis.
    normalizeInto(ex, grip.direction[0], grip.direction[1], grip.direction[2])
    const palm = side === 'left' ? 1 : -1
    const along = palm * ex[0]
    normalizeInto(ey, palm - along * ex[0], -along * ex[1], -along * ex[2])
    ez[0] = ex[1] * ey[2] - ex[2] * ey[1]; ez[1] = ex[2] * ey[0] - ex[0] * ey[2]; ez[2] = ex[0] * ey[1] - ex[1] * ey[0]
    modelBasis[0] = ex[0]; modelBasis[1] = ex[1]; modelBasis[2] = ex[2]; modelBasis[3] = 0
    modelBasis[4] = ey[0]; modelBasis[5] = ey[1]; modelBasis[6] = ey[2]; modelBasis[7] = 0
    modelBasis[8] = ez[0]; modelBasis[9] = ez[1]; modelBasis[10] = ez[2]; modelBasis[11] = 0
    modelBasis[12] = grip.point[0]; modelBasis[13] = grip.point[1]; modelBasis[14] = grip.point[2]; modelBasis[15] = 1
    // World frame: along the stick, the palm turned down, the third axis.
    const downAlong = -dy
    normalizeInto(ey, -downAlong * dx, -1 - downAlong * dy, -downAlong * dz)
    ez[0] = dy * ey[2] - dz * ey[1]; ez[1] = dz * ey[0] - dx * ey[2]; ez[2] = dx * ey[1] - dy * ey[0]
    // Turn the hand about the stick a little, palm still facing mostly down, so the forearm rises toward its shoulder
    // instead of dropping below the wrist.
    const mx = modelBasis[1], my = modelBasis[5], mz = modelBasis[9]
    let best = 0, bestGap = Infinity
    for (let step = -12; step <= 12; step++) {
      const roll = step * 0.075, c = Math.cos(roll), s = Math.sin(roll)
      const gap = Math.abs(mx * dy + my * (c * ey[1] + s * ez[1]) + mz * (c * ez[1] - s * ey[1]) - rise)
      if (gap < bestGap) { bestGap = gap; best = roll }
    }
    const c = Math.cos(best), s = Math.sin(best)
    const ey0 = ey[0], ey1 = ey[1], ey2 = ey[2]
    ey[0] = c * ey0 + s * ez[0]; ey[1] = c * ey1 + s * ez[1]; ey[2] = c * ey2 + s * ez[2]
    ez[0] = dy * ey[2] - dz * ey[1]; ez[1] = dz * ey[0] - dx * ey[2]; ez[2] = dx * ey[1] - dy * ey[0]
    handBasis[0] = dx; handBasis[1] = dy; handBasis[2] = dz; handBasis[3] = 0
    handBasis[4] = ey[0]; handBasis[5] = ey[1]; handBasis[6] = ey[2]; handBasis[7] = 0
    handBasis[8] = ez[0]; handBasis[9] = ez[1]; handBasis[10] = ez[2]; handBasis[11] = 0
    handBasis[12] = gripPoint[0]; handBasis[13] = gripPoint[1]; handBasis[14] = gripPoint[2]; handBasis[15] = 1
    alignInto(rootScratch, modelBasis, handBasis)
    setRoot(mesh, rootScratch)
    poseAll(mesh)
    // The grip's finger postures were set before the root moved: re-pose them under the new root.
    skinHand(mesh)
    // Each hand ends in a short wrist; the seated body and arms are implied and not drawn.
    poseArm(this.parts[side].arm, mesh.root)
    const arm = this.parts[side].arm, drawn = this.state[side]
    for (let k = 0; k < 3; k++) { drawn.wrist[k] = arm.wrist[k] }
  }

  private writeStick(side: HandSide, dx: number, dy: number, dz: number) {
    const { local, overlay } = this.sticks[side]
    // Across-stick axes: u horizontal and perpendicular to the stick, v completing the frame.
    normalizeInto(ex, dz, 0, -dx)
    ey[0] = dy * ex[2] - dz * ex[1]; ey[1] = dz * ex[0] - dx * ex[2]; ey[2] = dx * ex[1] - dy * ex[0]
    const { data } = overlay
    const g = this.state[side].grip
    for (let v = 0; v < local.length / 6; v++) {
      const lx = local[v * 6], ly = local[v * 6 + 1], lz = local[v * 6 + 2], nx = local[v * 6 + 3], ny = local[v * 6 + 4], nz = local[v * 6 + 5]
      const o = v * 12
      data[o] = g[0] + ex[0] * lx + ey[0] * ly + dx * lz
      data[o + 1] = g[1] + ex[1] * lx + ey[1] * ly + dy * lz
      data[o + 2] = g[2] + ex[2] * lx + ey[2] * ly + dz * lz
      data[o + 3] = ex[0] * nx + ey[0] * ny + dx * nz
      data[o + 4] = ex[1] * nx + ey[1] * ny + dy * nz
      data[o + 5] = ex[2] * nx + ey[2] * ny + dz * nz
    }
  }

  /** The hand's wrist, for tests and tuning. */
  wrist(side: HandSide): [number, number, number] {
    const mesh = this.parts[side].mesh
    const out = [0, 0, 0] as [number, number, number]
    transformPoint(mesh.world, mesh.wrist * 16, [0, 0, 0], out)
    return out
  }
}

export { loadHandAssets }
export { SKIN as HAND_SKIN, WOOD as STICK_WOOD }
