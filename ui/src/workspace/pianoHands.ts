import type { Overlay } from './kitRenderer'
import type { MaterialView } from './kitAsset'
import { keyOf, pianoKeyReleases, pianoFingerPairFits, suggestFingers } from './fingers'
import type { PreparedPiano } from './pianoAsset'
import type { Pedal, PianoNote } from './song'
import {
  createArm, createHandMesh, jointPoint, loadHandAssets, poseArm, padPoint, placeHand, poseAll, reachDigit, resetPose, skinHand,
  type Arm, type Finger, type HandAssets, type HandMesh, type HandSide,
} from './handRig'

/**
 * Two hands over the 3D keyboard. The pose is a pure function of the playback clock: the hand glides toward the next
 * notes just before they sound, each sounding key is pressed by the finger the music names (written fingering first,
 * otherwise a suggestion from the note spacing, and by pitch when no hand is written), and every other finger hovers
 * just above the keys. It is a suggested motion, not a recording of a player.
 */
export type PianoEvent = { key: number; start: number; end: number; finger: Finger }
export type PianoHandPlan = {
  left: PianoEvent[]
  right: PianoEvent[]
  /** True when no note names its hand, so hands were placed by pitch. */
  placedByPitch: boolean
  /** True when no note names its finger, so fingers are suggestions. */
  fingersSuggested: boolean
}

const MIDDLE_C = 60

/** Which hand and finger plays each note, in the music's own words first, and a plain suggestion where it is silent. */
export function buildPianoHandPlan(
  notes: readonly PianoNote[], hasKey: (key: number) => boolean, pedals?: readonly Pedal[], bpm?: number,
): PianoHandPlan {
  const playable = notes.filter((note) => hasKey(keyOf(note.midi)))
  const placedByPitch = playable.length > 0 && playable.every((note) => !note.hand)
  const handed = playable.map((note) => ({ note, hand: note.hand ?? (note.midi < MIDDLE_C ? 'left' : 'right') as HandSide }))
  const asPlaced = handed.map(({ note, hand }) => note.hand === hand ? note : { ...note, hand })
  const fingersSuggested = !playable.some((note) => note.finger)
  const options = { bpm, inferBassPedalGap: !pedals?.length }
  const suggestions = suggestFingers(asPlaced, pedals, options)
  const releases = pianoKeyReleases(asPlaced, pedals, options)
  const plan: PianoHandPlan = { left: [], right: [], placedByPitch, fingersSuggested }
  for (const side of ['left', 'right'] as const) {
    const mine = asPlaced.map((note, index) => ({ note, written: playable[index].finger })).filter(({ note }) => note.hand === side)
      .sort((a, b) => a.note.startBeat - b.note.startBeat || a.note.midi - b.note.midi)
    const active: PianoEvent[] = []
    for (let first = 0; first < mine.length;) {
      let last = first
      while (last + 1 < mine.length && Math.abs(mine[last + 1].note.startBeat - mine[first].note.startBeat) < 1e-6) last++
      const group = mine.slice(first, last + 1)
      const start = group[0].note.startBeat
      const sounding = new Set(active.filter((event) => event.start < start - 1e-6 && event.end > start + 1e-6).map((event) => event.finger))
      const taken = new Set<number>(sounding)
      const ordered = active.filter((event) => event.end > start + 1e-6).map((event) => ({ key: event.key, finger: event.finger as number }))
      const chosen = group.map(({ note, written }) => {
        const wanted = written ?? suggestions.get(note)?.finger
        const key = keyOf(note.midi)
        if (wanted === undefined || taken.has(wanted) ||
          ordered.some((other) => !pianoFingerPairFits(key, wanted, other.key, other.finger, side))) return undefined
        taken.add(wanted)
        ordered.push({ key, finger: wanted })
        return wanted as Finger
      })
      group.forEach(({ note }, index) => {
        if (chosen[index] === undefined) return
        const event = { key: keyOf(note.midi), start: note.startBeat, end: releases.get(note) ?? note.startBeat + note.beats, finger: chosen[index] as Finger }
        plan[side].push(event); active.push(event)
      })
      first = last + 1
    }
  }
  return plan
}

// ---------- the keyboard ----------
type KeyInfo = { x: number; top: number; padZ: number; hinge: [number, number, number]; angle: number; black: boolean }
export type PianoGeometry = { keys: Map<number, KeyInfo>; whiteTop: number; whitePadZ: number; keyWidth: number; minX: number; maxX: number }
const geometryCache = new WeakMap<PreparedPiano, PianoGeometry>()
/** Where on each key a fingertip lands (about three quarters of the way to its front edge), and how far it can move. */
const PAD_FRACTION = 0.74

export function pianoGeometry(prepared: PreparedPiano): PianoGeometry {
  const cached = geometryCache.get(prepared)
  if (cached) return cached
  const angles = new Map<number, number>()
  for (const item of prepared.items) if (item.motion === 'press' && item.target?.startsWith('key:')) angles.set(Number(item.target.slice(4)), item.angle ?? 0)
  const keys = new Map<number, KeyInfo>()
  let whiteTop = 0, whitePadZ = 0, minX = Infinity, maxX = -Infinity
  for (const [midi, key] of prepared.keys) {
    const padZ = key.hinge[2] + (key.front[2] - key.hinge[2]) * PAD_FRACTION
    keys.set(midi, { x: key.label[0], top: key.label[1], padZ, hinge: key.hinge, angle: angles.get(midi) ?? 0, black: key.black })
    if (!key.black) { whiteTop = key.label[1]; whitePadZ = padZ }
    minX = Math.min(minX, key.label[0]); maxX = Math.max(maxX, key.label[0])
  }
  // The width of one white key, from two neighbouring white keys.
  const whites = [...prepared.keys].filter(([, key]) => !key.black).sort((a, b) => a[0] - b[0])
  const keyWidth = whites.length > 1 ? Math.abs(whites[1][1].label[0] - whites[0][1].label[0]) : 0.0235
  const geometry = { keys, whiteTop, whitePadZ, keyWidth, minX, maxX }
  geometryCache.set(prepared, geometry)
  return geometry
}

// ---------- the pose, from the clock ----------
export type PianoClock = {
  beat: number
  playing: boolean
  countingIn: boolean
  secondsPerBeat: number
  loop: { start: number; end: number } | null
  reduced: boolean
}
export type FingerState = {
  finger: Finger
  /** The key this finger is pressing now, or null. */
  pressing: number | null
  pad: [number, number, number]
  target: [number, number, number]
  /** Distance between the pad and its target after solving, metres. */
  error: number
}
export type PianoHandState = { center: number; fingers: FingerState[]; wrist: [number, number, number] }

const GLIDE_SECONDS = 0.2
const APPROACH_SECONDS = 0.07
const RELEASE_SECONDS = 0.09
const SPREAD_SECONDS = 0.25
/** A lifted finger returns to its place beside the hand this quickly, so it never trails behind a gliding hand. */
const LEAVE_SECONDS = 0.09
/** How far (metres) a finger can stretch sideways from its place beside the hand to reach a key. */
const REACH = 0.015
/** How far the thumb reaches sideways from the centre of its hand (metres): outward, and inward under the palm. */
const THUMB_INWARD = 0.003
const THUMB_OUTWARD = 0.0686
const HOVER = 0.012
const READY_HOVER = 0.006
/** Height of the middle knuckle above the white keys, and the forward tilt of the hand (fingertips lower than the wrist). */
const KNUCKLE_HEIGHT = 0.034
/** How far behind the fingertips' key position (toward the player) the middle knuckle sits. */
const ANCHOR_BACK = 0.032
/** The thumb meets a white key nearer its front edge and the shorter little finger a little nearer too (metres toward the player). */
const FINGER_FORWARD = [0, 0.016, 0, 0, 0.002, 0.008]
const PITCH = 0.12
const EPS = 1e-6
const smooth = (t: number) => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)

type Group = { start: number; center: number }
type Timeline = { groups: Group[]; fingers: PianoEvent[][]; rest: number }
type Around = { prev: number; next: number; prevShift: number; nextShift: number }
const around: Around = { prev: -1, next: -1, prevShift: 0, nextShift: 0 }

/** The items either side of `beat` by start time, wrapping across a loop's end (`shift` is the beat offset of a wrapped item). */
function neighbours(list: { start: number }[], beat: number, loop: PianoClock['loop']): Around {
  let first = 0, end = list.length
  while (first < end) { const middle = (first + end) >> 1; if (list[middle].start <= beat + EPS) first = middle + 1; else end = middle }
  around.prev = first - 1; around.next = first < list.length ? first : -1; around.prevShift = 0; around.nextShift = 0
  if (loop && beat >= loop.start - EPS && beat < loop.end - EPS) {
    if (around.prev >= 0 && list[around.prev].start < loop.start - EPS) around.prev = -1
    if (around.next >= 0 && list[around.next].start >= loop.end - EPS) around.next = -1
    const length = loop.end - loop.start
    if (around.next < 0 || around.prev < 0) {
      let lo = 0, hi = list.length
      while (lo < hi) { const middle = (lo + hi) >> 1; if (list[middle].start < loop.start - EPS) lo = middle + 1; else hi = middle }
      let lastIndex = lo
      while (lastIndex + 1 < list.length && list[lastIndex + 1].start < loop.end - EPS) lastIndex++
      const hasAny = lo < list.length && list[lo].start < loop.end - EPS
      if (hasAny && around.next < 0) { around.next = lo; around.nextShift = length }
      if (hasAny && around.prev < 0) { around.prev = lastIndex; around.prevShift = -length }
    }
  }
  return around
}

const SKIN: MaterialView = { name: 'hand', base: [0.86, 0.66, 0.55, 1], metal: 0, rough: 0.72, emissive: [0, 0, 0], baseTex: -1, ormTex: -1, normalTex: -1, emissiveTex: -1, normalScale: 1, blend: false }
const NATURAL: [number, number, number] = [0.55, 0, 0.75]
const NATURAL_THUMB: [number, number, number] = [0.25, 0, 0.3]
const anchorModel = [0, 0, 0], at = [0, 0, 0], forward = [0, 0, 0], palm = [0, 0, 0], target = [0, 0, 0]

const centerRange = (key: KeyInfo, finger: number, dir: number, keyWidth: number): [number, number] => {
  if (finger === 1) return dir > 0
    ? [key.x - THUMB_INWARD, key.x + THUMB_OUTWARD]
    : [key.x - THUMB_OUTWARD, key.x + THUMB_INWARD]
  const base = key.x - dir * (finger - 3) * keyWidth
  return [base - REACH, base + REACH]
}

type Part = { mesh: HandMesh; overlay: Overlay; arm: Arm; foreOverlay: Overlay }

export class PianoHands {
  readonly overlays: Overlay[]
  readonly state: Record<HandSide, PianoHandState>
  private parts: Record<HandSide, Part>
  /** Middle-finger knuckle in each hand model's own frame: the point the hand is placed by. */
  private knuckle: Record<HandSide, number[]> = { left: [0, 0, 0], right: [0, 0, 0] }

  constructor(assets: HandAssets, options?: { alpha?: number; skin?: MaterialView }) {
    const make = (side: HandSide): Part => {
      const mesh = createHandMesh(assets[side], side)
      resetPose(mesh); mesh.root.fill(0); mesh.root[0] = mesh.root[5] = mesh.root[10] = mesh.root[15] = 1
      poseAll(mesh)
      jointPoint(mesh, 'middle-finger-phalanx-proximal', anchorModel)
      this.knuckle[side] = [...anchorModel]
      const arm = createArm(mesh)
      const material = options?.skin ?? SKIN, alpha = options?.alpha ?? 1
      return { mesh, arm, overlay: { name: `${side}-hand`, data: mesh.data, index: mesh.index, material, alpha, visible: false },
        foreOverlay: { name: `${side}-wrist`, data: arm.fore.data, index: arm.fore.index, material, alpha, visible: false, fade: true } }
    }
    this.parts = { left: make('left'), right: make('right') }
    this.overlays = [this.parts.left.overlay, this.parts.right.overlay, this.parts.left.foreOverlay, this.parts.right.foreOverlay]
    const blank = (): PianoHandState => ({ wrist: [0, 0, 0], center: 0, fingers: [1, 2, 3, 4, 5].map((finger) => ({ finger: finger as Finger, pressing: null, pad: [0, 0, 0], target: [0, 0, 0], error: 0 })) })
    this.state = { left: blank(), right: blank() }
  }

  /** Hand centres at each group of notes, per hand, for this keyboard. Done once per plan and keyboard. */
  compile(plan: PianoHandPlan, geometry: PianoGeometry): Record<HandSide, Timeline> {
    const timeline = (side: HandSide): Timeline => {
      const events = plan[side]
      const dir = side === 'right' ? 1 : -1
      const starts = [...new Set(events.map((event) => event.start))].sort((a, b) => a - b)
      let before: number | null = null
      const groups: Group[] = starts.map((beat) => {
        const sounding = events.filter((event) => event.start <= beat + EPS && event.end > beat + EPS)
        // Where the hand sits so every finger of the group is at its key, within what each finger (the thumb passing under
        // the palm, the others spreading) can stretch to reach.
        let sum = 0, count = 0, low = -Infinity, high = Infinity
        for (const event of sounding) {
          const key = geometry.keys.get(event.key)
          if (!key) continue
          sum += key.x - dir * (event.finger - 3) * geometry.keyWidth; count++
          const range = centerRange(key, event.finger, dir, geometry.keyWidth)
          low = Math.max(low, range[0]); high = Math.min(high, range[1])
        }
        // The hand moves only as far as the new notes need: it stays where it was when every finger can still reach.
        const wanted = before ?? (count ? sum / count : (geometry.minX + geometry.maxX) / 2)
        // Stay clear of the edge of every finger's reach, so each lands on its key and not just near it.
        const margin = Math.min(0.006, (high - low) / 4)
        const center = low <= high ? Math.max(low + margin, Math.min(high - margin, wanted)) : (low + high) / 2
        before = center
        return { start: beat, center }
      })
      const fingers: PianoEvent[][] = [[], [], [], [], [], []]
      for (const event of events) fingers[event.finger].push(event)
      for (const list of fingers) list.sort((a, b) => a.start - b.start)
      const rest = geometry.minX + (geometry.maxX - geometry.minX) * (side === 'left' ? 0.36 : 0.62)
      return { groups, fingers, rest }
    }
    return { left: timeline('left'), right: timeline('right') }
  }

  update(timelines: Record<HandSide, Timeline>, geometry: PianoGeometry, clock: PianoClock, visible: boolean) {
    // The player sits centred between their hands.
    for (const side of ['left', 'right'] as const) {
      const part = this.parts[side]
      part.overlay.visible = part.foreOverlay.visible = visible
      if (visible) this.poseHand(side, timelines[side], geometry, clock)
    }
  }

  private centerAt(line: Timeline, clock: PianoClock): number {
    const { groups } = line
    if (!groups.length) return line.rest
    const near = neighbours(groups, clock.beat, clock.loop)
    const prev = near.prev >= 0 ? groups[near.prev] : null
    const next = near.next >= 0 ? groups[near.next] : null
    if (!prev) return next!.center
    // Paused, counting in or reduced motion: the hand stays over the latest notes and jumps rather than glides.
    if (!next || clock.reduced || !clock.playing || clock.countingIn) return prev.center
    const prevBeat = prev.start + near.prevShift, nextBeat = next.start + near.nextShift
    const glide = Math.min(nextBeat - prevBeat, GLIDE_SECONDS / clock.secondsPerBeat)
    const progress = glide > EPS ? smooth((clock.beat - (nextBeat - glide)) / glide) : 1
    return prev.center + (next.center - prev.center) * progress
  }

  // Per finger: its key (or -1), how much it belongs to that key rather than beside the hand, its hover height and press.
  private keyOf = new Int16Array(6)
  private weightOf = new Float64Array(6)
  private heightOf = new Float64Array(6)
  private pressOf = new Float64Array(6)
  private downOf = new Uint8Array(6)

  private poseHand(side: HandSide, line: Timeline, geometry: PianoGeometry, clock: PianoClock) {
    const { mesh } = this.parts[side]
    const state = this.state[side]
    const dir = side === 'right' ? 1 : -1
    const live = clock.playing && !clock.countingIn
    const spb = clock.secondsPerBeat
    for (let finger = 1 as Finger; finger <= 5; finger++) {
      const events = line.fingers[finger]
      let key = -1, weight = 0, height = HOVER, press = 0, down = 0
      if (events.length) {
        const near = neighbours(events, clock.beat, clock.loop)
        const prev = near.prev >= 0 ? events[near.prev] : null
        const next = near.next >= 0 ? events[near.next] : null
        const prevStart = prev ? prev.start + near.prevShift : 0, prevEnd = prev ? prev.end + near.prevShift : 0
        const nextStart = next ? next.start + near.nextShift : 0
        if (prev && clock.beat < prevEnd - EPS) {
          key = prev.key; weight = 1
          if (live) { down = 1; height = 0; press = Math.min(1, (clock.beat - prevStart) * spb / 0.04) } else height = READY_HOVER
        } else if (live && !clock.reduced) {
          let coming = 0
          if (next) {
            const until = (nextStart - clock.beat) * spb
            coming = 1 - smooth(until / SPREAD_SECONDS)
            if (coming > 0) { key = next.key; weight = coming; height = HOVER * smooth(until / APPROACH_SECONDS) }
          }
          if (prev) {
            const since = (clock.beat - prevEnd) * spb
            const leaving = 1 - smooth(since / LEAVE_SECONDS)
            if (leaving > weight) { key = prev.key; weight = leaving }
            if (!(next && coming > 0) || leaving > coming) height = HOVER * smooth(since / RELEASE_SECONDS)
          }
        }
      }
      this.keyOf[finger] = key; this.weightOf[finger] = weight; this.heightOf[finger] = height; this.pressOf[finger] = press; this.downOf[finger] = down
    }
    // An approaching or releasing finger must not pass through a different finger that is still pressing a key.
    // The thumb is excluded: passing under another finger is a normal scale transition.
    for (let finger = 2 as Finger; finger <= 5; finger++) {
      if (this.downOf[finger] || this.keyOf[finger] < 0) continue
      for (let held = 2 as Finger; held <= 5; held++) {
        if (!this.downOf[held] || held === finger) continue
        if (dir * (this.keyOf[finger] - this.keyOf[held]) * (finger - held) <= 0) {
          this.keyOf[finger] = -1; this.weightOf[finger] = 0
          break
        }
      }
    }
    let low = -Infinity, high = Infinity
    for (let finger = 1 as Finger; finger <= 5; finger++) {
      if (this.weightOf[finger] < 1) continue
      const key = geometry.keys.get(this.keyOf[finger])
      if (!key) continue
      const range = centerRange(key, finger, dir, geometry.keyWidth)
      low = Math.max(low, range[0]); high = Math.min(high, range[1])
    }
    const wanted = this.centerAt(line, clock)
    const center = low <= high ? Math.max(low, Math.min(high, wanted)) : (low + high) / 2
    state.center = center
    // Place the hand: palm down, fingers away from the player, tilted a little so the fingertips sit lower than the wrist.
    forward[0] = 0; forward[1] = -Math.sin(PITCH); forward[2] = -Math.cos(PITCH)
    palm[0] = 0; palm[1] = -Math.cos(PITCH); palm[2] = Math.sin(PITCH)
    // Playing a black key, the hand rides a little higher and further forward over the keys.
    let blackness = 0
    for (let finger = 1 as Finger; finger <= 5; finger++) {
      const info = this.keyOf[finger] >= 0 ? geometry.keys.get(this.keyOf[finger]) : undefined
      if (info?.black) blackness = Math.max(blackness, smooth(this.weightOf[finger]))
    }
    at[0] = center; at[1] = geometry.whiteTop + KNUCKLE_HEIGHT + 0.012 * blackness; at[2] = geometry.whitePadZ + ANCHOR_BACK - 0.022 * blackness
    resetPose(mesh)
    placeHand(mesh, at, forward, palm, this.knuckle[side])
    poseAll(mesh)
    for (let finger = 1 as Finger; finger <= 5; finger++) {
      const key = this.keyOf[finger], weight = this.weightOf[finger], height = this.heightOf[finger], press = this.pressOf[finger]
      const slot = state.fingers[finger - 1]
      slot.pressing = this.downOf[finger] ? key : null
      const info = key >= 0 ? geometry.keys.get(key) : undefined
      // The finger's resting place beside the hand, and its key when it has one.
      const restX = center + dir * (finger - 3) * geometry.keyWidth * (finger === 1 ? 1.1 : 1)
      const restZ = geometry.whitePadZ + FINGER_FORWARD[finger]
      const restY = geometry.whiteTop + HOVER
      let x = restX, y = restY, z = restZ
      if (info) {
        const toKey = smooth(weight)
        x = restX + (info.x - restX) * toKey
        z = restZ + (info.padZ + (info.black ? 0 : FINGER_FORWARD[finger]) - restZ) * toKey
        y = restY + (keyTop(info, press) + height - restY) * toKey
      }
      slot.target[0] = x; slot.target[1] = y; slot.target[2] = z
      target[0] = x; target[1] = y; target[2] = z
      slot.error = reachDigit(mesh, finger, target, finger === 1 ? NATURAL_THUMB : NATURAL)
      padPoint(mesh, finger, slot.pad)
    }
    skinHand(mesh)
    const arm = this.parts[side].arm
    poseArm(arm, mesh.root)
    for (let k = 0; k < 3; k++) state.wrist[k] = arm.wrist[k]
  }
}
const keyPoint = [0, 0, 0]
/** Height of a key's top at the fingertip when the key is `press` (0..1) of the way down. */
function keyTop(info: KeyInfo, press: number): number {
  const angle = info.angle * press
  const dz = info.padZ - info.hinge[2]
  keyPoint[1] = info.hinge[1] + (info.top - info.hinge[1]) * Math.cos(angle) - dz * Math.sin(angle)
  return keyPoint[1]
}

export { loadHandAssets }
export { SKIN as PIANO_HAND_SKIN }
