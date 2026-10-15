import type { FrettedInstrumentConfig, FrettedTabNote } from './fretboard'
import { fingerSequence, fingerShapes } from './frettedFingering'

export type FrettedHandFinger = 1 | 2 | 3 | 4 | 5
/** One colour per fretting finger (Okabe–Ito based, so they stay apart for common colour-blindness); numbers always accompany them. */
export const FINGER_COLORS: Record<FrettedHandFinger, string> = {
  1: '#56b4e9', 2: '#e69f00', 3: '#1fbf8f', 4: '#cc79a7', 5: '#a7adb4',
}
export type FrettedHandContact = {
  finger: FrettedHandFinger
  string: number
  fret: number
  index: number
  barre: boolean
}
export type FrettedHandPlan = { contacts: FrettedHandContact[]; unavailable: boolean }
export type FrettedHandMemory = Map<number, FrettedHandFinger>
export type HandVector = [number, number, number]
export type FrettedHandModelContact = FrettedHandContact & {
  center: HandVector
  surface: HandVector
  radius: number
}
export type FrettedHandString = { string: number; center: HandVector; radius: number }
export type FrettedHandGeometry = {
  skin: Float32Array
  skinIndices: Uint16Array
  details: Float32Array
  detailIndices: Uint16Array
  nails: Float32Array
  nailIndices: Uint16Array
  fingers: { finger: FrettedHandFinger; pressed: boolean; barre: boolean; joints: HandVector[] }[]
  contactTips: {
    finger: FrettedHandFinger
    string: number
    fret: number
    barre: boolean
    surface: HandVector
    tip: HandVector
    gap: number
  }[]
  palmCenter: HandVector
  palmHalfExtents: HandVector
  wristStart: HandVector
  wristEnd: HandVector
  nailCenters: { finger: FrettedHandFinger; center: HandVector }[]
  thumbTip: HandVector
  surfaceGap: number
}

// Two fingers cannot be further apart than one fret more than their finger distance (index and ring: three frets).
const tooWide = (contacts: readonly FrettedHandContact[]) => contacts.some((a) => contacts.some((b) =>
  a.finger < b.finger && b.fret - a.fret > b.finger - a.finger + (a.finger === 1 ? 1 : 0)))

/**
 * Fingers for a whole part at once, so a run keeps its hand position and shifts only where it must. Seed the hand
 * memory with this; fingers a lesson wrote are left alone and are not in the result.
 */
export function suggestFrettedFingers(notes: readonly FrettedTabNote[], config: FrettedInstrumentConfig): FrettedHandMemory {
  return new Map(fingerSequence(notes, config) as Map<number, FrettedHandFinger>)
}

/**
 * Suggest a compact, playable grip; open strings need no finger and wide stretches stay unposed. A grip that the
 * remembered fingers would stretch too far is planned again from scratch, so the hand can reach it.
 */
export function planFrettedHand(
  notes: readonly FrettedTabNote[],
  config: FrettedInstrumentConfig,
  memory?: FrettedHandMemory,
): FrettedHandPlan {
  const grip = buildGrip(notes, config, memory)
  // Barres belong to the index finger; a remembered middle or ring finger barring two strings is replanned too.
  const oddBarre = (contacts: readonly FrettedHandContact[]) => contacts.some((contact) => contact.barre && contact.finger > 1)
  const crossed = (contacts: readonly FrettedHandContact[]) => contacts.some((a) => contacts.some((b) =>
    a.finger < 5 && b.finger < 5 && a.fret < b.fret && a.finger > b.finger))
  if (memory && (grip.unavailable || tooWide(grip.contacts) || oddBarre(grip.contacts) || crossed(grip.contacts))) {
    const fresh = buildGrip(notes, config)
    if (!fresh.unavailable && !tooWide(fresh.contacts) &&
      !crossed(fresh.contacts) &&
      (grip.unavailable || tooWide(grip.contacts) || crossed(grip.contacts) || !oddBarre(fresh.contacts))) {
      for (const contact of fresh.contacts) {
        const note = notes.find((item) => item.index === contact.index)
        if (note && !note.finger) memory.set(contact.index, contact.finger)
      }
      return fresh
    }
  }
  return grip
}

function buildGrip(
  notes: readonly FrettedTabNote[],
  config: FrettedInstrumentConfig,
  memory?: FrettedHandMemory,
): FrettedHandPlan {
  const fretted = notes.filter((note) => note.position && note.position.fret > 0)
  if (!fretted.length) return { contacts: [], unavailable: false }

  const frets = [...new Set(fretted.map((note) => note.position!.fret))].sort((a, b) => a - b)
  if (frets.at(-1)! - frets[0] > 4 || frets.length > 4)
    return { contacts: [], unavailable: true }
  const fretboardCoordinates = fretted.map((note) => note.position!.fretboardCoordinate)
  if (Math.max(...fretboardCoordinates) - Math.min(...fretboardCoordinates) > 0.095)
    return { contacts: [], unavailable: true }
  const authored = fretted.filter((note) => note.finger && note.finger < 5)
  if (authored.some((a) => authored.some((b) =>
    a.position!.fret < b.position!.fret && a.finger! > b.finger!)))
    return { contacts: [], unavailable: true }

  const byFret = new Map<number, Set<FrettedHandFinger>>()
  const fingerForIndex = new Map<number, FrettedHandFinger>()
  // With nothing written or remembered, the cheapest whole-grip shape is chosen (barres, one finger per fret, Simandl);
  // if no shape fits, fingers are chosen fret by fret below.
  const open = !fretted.some((note) => note.finger || memory?.has(note.index))
  const shape = open ? fingerShapes(fretted.map((note) => ({
    index: note.index, string: note.position!.string, fret: note.position!.fret,
  })), config)[0] : undefined
  if (shape) fretted.forEach((note, at) => fingerForIndex.set(note.index, shape.fingers[at] as FrettedHandFinger))
  for (const note of shape ? [] : fretted) {
    const finger = note.finger
    if (finger === 5 && note.position!.conventionalStringNumber < config.strings.length - 1)
      return { contacts: [], unavailable: true }
    const remembered = finger && finger >= 1 && finger <= 5 ? finger : memory?.get(note.index)
    if (remembered && remembered >= 1 && remembered <= 5) {
      const assigned = byFret.get(note.position!.fret) ?? new Set<FrettedHandFinger>()
      assigned.add(remembered)
      byFret.set(note.position!.fret, assigned)
      fingerForIndex.set(note.index, remembered)
    }
  }

  const used = new Set([...byFret.values()].flatMap((fingers) => [...fingers].filter((finger) => finger < 5)))
  for (const fret of shape ? [] : frets) {
    const assigned = byFret.get(fret) ?? new Set<FrettedHandFinger>()
    if (!assigned.size) {
      const lower = frets.filter((item) => item < fret).flatMap((item) => [...(byFret.get(item) ?? [])])
      const upper = frets.filter((item) => item > fret).flatMap((item) => [...(byFret.get(item) ?? [])])
      const lowerBound = Math.max(0, ...lower)
      const upperBound = Math.min(5, ...upper)
      const options = ([1, 2, 3, 4] as const).filter((candidate) =>
        !used.has(candidate) && candidate > lowerBound && candidate < upperBound)
      // A wide jump from the next lower fret skips fingers, so the hand is not stretched between neighbours.
      const lowerFret = Math.max(0, ...frets.filter((item) => item < fret))
      const wanted = lowerFret ? lowerBound + Math.max(1, fret - lowerFret - 1) : 1
      const finger = options.find((candidate) => candidate >= wanted) ?? options.at(-1)
      if (!finger) return { contacts: [], unavailable: true }
      assigned.add(finger)
      used.add(finger)
      byFret.set(fret, assigned)
    }
    for (const note of fretted.filter((item) => item.position!.fret === fret))
      if (!fingerForIndex.has(note.index))
        fingerForIndex.set(note.index, [...assigned].sort((a, b) => a - b)[0])
  }

  const contacts = fretted.map((note) => ({
    finger: fingerForIndex.get(note.index)!,
    string: note.position!.string,
    fret: note.position!.fret,
    index: note.index,
    barre: false,
  }))
  for (const finger of [1, 2, 3, 4, 5] as const) {
    const grouped = contacts.filter((contact) => contact.finger === finger)
    if (new Set(grouped.map((contact) => contact.fret)).size > 1)
      return { contacts: [], unavailable: true }
    if (new Set(grouped.map((contact) => contact.string)).size > 1)
      grouped.forEach((contact) => { contact.barre = true })
  }
  // A barre presses every string it spans, so no other finger can hold one of them nearer the nut (checked when choosing\n  // which ringing notes the hand holds; remembered fingers keep their identities).
  if (!memory) for (const barre of contacts.filter((contact) => contact.barre)) {
    const spanned = contacts.filter((contact) => contact.finger === barre.finger).map((contact) => contact.string)
    const [low, high] = [Math.min(...spanned), Math.max(...spanned)]
    // (Strings with several overlapping notes are left to the caller, which keeps one note per string.)
    if (contacts.some((other) => other.finger !== barre.finger && other.string > low && other.string < high &&
      other.fret < barre.fret && contacts.filter((item) => item.string === other.string).length === 1))
      return { contacts: [], unavailable: true }
  }
  for (const contact of contacts) {
    const note = fretted.find((item) => item.index === contact.index)
    if (note && !note.finger) memory?.set(contact.index, contact.finger)
  }
  return { contacts, unavailable: false }
}

/**
 * The notes a player would actually be fretting among those still sounding: each string keeps only its newest note
 * (an open onset releases the string), the newest onset always counts, and older ringing notes join only while the
 * grip stays playable. `unavailable` means even the newest onset alone cannot be fretted.
 */
export function selectHandNotes(
  sounding: readonly FrettedTabNote[],
  config: FrettedInstrumentConfig,
): { notes: FrettedTabNote[]; unavailable: boolean } {
  const latest = new Map<number, FrettedTabNote>()
  for (const note of sounding) {
    if (!note.position) continue
    const previous = latest.get(note.position.string)
    if (!previous || note.startBeat >= previous.startBeat) latest.set(note.position.string, note)
  }
  const fretted = [...latest.values()].filter((note) => note.position!.fret > 0)
  if (!fretted.length) return { notes: [], unavailable: false }
  const onsets = [...new Set(fretted.map((note) => note.startBeat))].sort((a, b) => b - a)
  let chosen: FrettedTabNote[] = []
  for (const onset of onsets) {
    const group = fretted.filter((note) => note.startBeat === onset)
    const trial = [...chosen, ...group]
    if (!planFrettedHand(trial, config).unavailable) chosen = trial
    else if (!chosen.length) return { notes: group, unavailable: true }
  }
  return { notes: chosen, unavailable: false }
}

type SweepKnot = { center: HandVector; across: number; height: number }

const add = (a: HandVector, b: HandVector): HandVector => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: HandVector, b: HandVector): HandVector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (a: HandVector, value: number): HandVector => [a[0] * value, a[1] * value, a[2] * value]
const dot = (a: HandVector, b: HandVector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: HandVector, b: HandVector): HandVector => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
]
const length = (a: HandVector) => Math.hypot(...a)
const unit = (a: HandVector): HandVector => {
  const magnitude = Math.max(1e-8, length(a))
  return [a[0] / magnitude, a[1] / magnitude, a[2] / magnitude]
}

class HandMeshBuilder {
  readonly vertices: number[] = []
  readonly indices: number[] = []

  private vertex(position: HandVector, normal: HandVector, uv: [number, number]): number {
    const index = this.vertices.length / 8
    this.vertices.push(...position, ...unit(normal), ...uv)
    return index
  }

  private triangle(a: number, b: number, c: number, outward: HandVector) {
    const pa = this.vertices.slice(a * 8, a * 8 + 3) as HandVector
    const pb = this.vertices.slice(b * 8, b * 8 + 3) as HandVector
    const pc = this.vertices.slice(c * 8, c * 8 + 3) as HandVector
    const facing = dot(cross(sub(pb, pa), sub(pc, pa)), outward)
    this.indices.push(a, facing >= 0 ? b : c, facing >= 0 ? c : b)
  }

  private sample(knots: readonly SweepKnot[], segment: number, t: number): SweepKnot {
    const p0 = knots[Math.max(0, segment - 1)]
    const p1 = knots[segment]
    const p2 = knots[segment + 1]
    const p3 = knots[Math.min(knots.length - 1, segment + 2)]
    const interpolate = (a: number, b: number, c: number, d: number) => 0.5 *
      ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t ** 2 +
        (-a + 3 * b - 3 * c + d) * t ** 3)
    return {
      center: [0, 1, 2].map((axis) => interpolate(p0.center[axis], p1.center[axis],
        p2.center[axis], p3.center[axis])) as HandVector,
      across: Math.max(0.0003, interpolate(p0.across, p1.across, p2.across, p3.across)),
      height: Math.max(0.0003, interpolate(p0.height, p1.height, p2.height, p3.height)),
    }
  }

  sweep(knots: readonly SweepKnot[], sides = 12, subdivisions = 4) {
    if (knots.length < 2) return
    const samples: SweepKnot[] = []
    for (let segment = 0; segment < knots.length - 1; segment++)
      for (let step = 0; step < subdivisions; step++)
        samples.push(this.sample(knots, segment, step / subdivisions))
    samples.push(knots.at(-1)!)
    const base = this.vertices.length / 8
    const tangents: HandVector[] = []
    let previousAcross: HandVector | null = null
    for (let row = 0; row < samples.length; row++) {
      const before = samples[Math.max(0, row - 1)].center
      const after = samples[Math.min(samples.length - 1, row + 1)].center
      const tangent = unit(sub(after, before))
      tangents.push(tangent)
      let acrossAxis: HandVector = previousAcross
        ? sub(previousAcross, mul(tangent, dot(previousAcross, tangent)))
        : cross(tangent, [0, 0, 1])
      if (length(acrossAxis) < 0.08) acrossAxis = cross(tangent, [0, 1, 0])
      acrossAxis = unit(acrossAxis)
      const heightAxis = unit(cross(tangent, acrossAxis))
      previousAcross = acrossAxis
      const section = samples[row]
      for (let side = 0; side < sides; side++) {
        const angle = side / sides * Math.PI * 2
        const cosine = Math.cos(angle), sine = Math.sin(angle)
        const normal = unit(add(mul(acrossAxis, cosine / section.across),
          mul(heightAxis, sine / section.height)))
        const position = add(section.center, add(
          mul(acrossAxis, cosine * section.across), mul(heightAxis, sine * section.height)))
        this.vertex(position, normal, [side / sides, row / (samples.length - 1)])
      }
    }
    for (let row = 0; row < samples.length - 1; row++) for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides
      const a = base + row * sides + side
      const b = base + row * sides + next
      const c = base + (row + 1) * sides + side
      const d = base + (row + 1) * sides + next
      this.triangle(a, b, c, unit(add(
        add(this.vertices.slice(a * 8 + 3, a * 8 + 6) as HandVector,
          this.vertices.slice(b * 8 + 3, b * 8 + 6) as HandVector),
        this.vertices.slice(c * 8 + 3, c * 8 + 6) as HandVector)))
      this.triangle(b, d, c, unit(add(
        add(this.vertices.slice(b * 8 + 3, b * 8 + 6) as HandVector,
          this.vertices.slice(d * 8 + 3, d * 8 + 6) as HandVector),
        this.vertices.slice(c * 8 + 3, c * 8 + 6) as HandVector)))
    }
    for (const [row, tangent, reverse] of [[0, tangents[0], true],
      [samples.length - 1, tangents.at(-1)!, false]] as const) {
      const center = this.vertex(samples[row].center, mul(tangent, reverse ? -1 : 1), [0.5, 0.5])
      for (let side = 0; side < sides; side++) {
        const a = base + row * sides + side
        const b = base + row * sides + (side + 1) % sides
        if (reverse) this.triangle(center, b, a, mul(tangent, -1))
        else this.triangle(center, a, b, tangent)
      }
    }
  }

  sphere(center: HandVector, radii: HandVector, latitude = 8, longitude = 12) {
    const base = this.vertices.length / 8
    for (let row = 0; row <= latitude; row++) {
      const phi = -Math.PI / 2 + row / latitude * Math.PI
      const cosine = Math.cos(phi), sine = Math.sin(phi)
      for (let column = 0; column <= longitude; column++) {
        const theta = column / longitude * Math.PI * 2
        const direction: HandVector = [cosine * Math.cos(theta), cosine * Math.sin(theta), sine]
        const position = add(center, [direction[0] * radii[0], direction[1] * radii[1], direction[2] * radii[2]])
        const normal = unit([direction[0] / radii[0], direction[1] / radii[1], direction[2] / radii[2]])
        this.vertex(position, normal, [column / longitude, row / latitude])
      }
    }
    const rowSize = longitude + 1
    for (let row = 0; row < latitude; row++) for (let column = 0; column < longitude; column++) {
      const a = base + row * rowSize + column
      const b = a + 1
      const c = a + rowSize
      const d = c + 1
      const normal = unit(add(add(
        this.vertices.slice(a * 8 + 3, a * 8 + 6) as HandVector,
        this.vertices.slice(b * 8 + 3, b * 8 + 6) as HandVector),
      this.vertices.slice(c * 8 + 3, c * 8 + 6) as HandVector))
      this.triangle(a, b, c, normal)
      this.triangle(b, d, c, normal)
    }
  }

  build() {
    return { vertices: new Float32Array(this.vertices), indices: Uint16Array.from(this.indices) }
  }
}

const knot = (center: HandVector, across: number, height: number): SweepKnot => ({ center, across, height })
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)

/** Build a small, jointed 3D fretting hand in instrument-local metres. */
export function buildFrettedHandGeometry(
  contacts: readonly FrettedHandModelContact[],
  strings: readonly FrettedHandString[],
  handedness: 'right' | 'left',
  preview: boolean,
): FrettedHandGeometry {
  const skin = new HandMeshBuilder()
  const details = new HandMeshBuilder()
  const nails = new HandMeshBuilder()
  const activeContacts = contacts.filter((contact) => contact.finger <= 4)
  const side = handedness === 'right' ? 1 : -1
  const yValues = strings.map((string) => string.center[1])
  const minStringY = Math.min(...yValues), maxStringY = Math.max(...yValues)
  const ySpan = maxStringY - minStringY
  const fingerLaneX = (finger: number) => (2.5 - finger) * 0.016
  const handAnchorX = mean(activeContacts.map((contact) =>
    contact.surface[0] - fingerLaneX(contact.finger))) + 0.018
  const rootXs = [1, 2, 3, 4].map((finger) => handAnchorX + fingerLaneX(finger))
  const handTargetY = mean(activeContacts.map((contact) => contact.surface[1]))
  const rootYs = [1, 2, 3, 4].map((finger) => {
    const group = activeContacts.filter((contact) => contact.finger === finger)
    const targetY = group.length ? mean(group.map((contact) => contact.surface[1])) : handTargetY
    return targetY - side * 0.03
  })
  const palmX = mean(rootXs)
  const palmMinX = Math.min(...rootXs) - 0.004
  const palmMaxX = Math.max(...rootXs) + 0.004
  const palmHalfX = Math.max(0.022, (palmMaxX - palmMinX) / 2)
  const palmY = mean(rootYs)
  const palmHalfY = Math.max(0.029,
    Math.min(0.052, ySpan * 0.24 + (Math.max(...rootYs) - Math.min(...rootYs)) / 2))
  const maxSurfaceZ = Math.max(...contacts.map((contact) => contact.surface[2]))
  const rise = preview ? 0.018 : 0
  const palmZ = maxSurfaceZ + 0.001 + rise
  const palmHalfZ = 0.009
  const wristBackY = palmY - side * 0.038
  const wristStart: HandVector = [palmX, wristBackY, palmZ - 0.003]
  const wristEnd: HandVector = [palmX, palmY - side * 0.005, palmZ - 0.001]
  const nailCenters: FrettedHandGeometry['nailCenters'] = []
  const fingerMetadata: FrettedHandGeometry['fingers'] = []
  const fingerCrease = (point: HandVector, radiusY: number, width = 0.006) => {
    const y = point[1] + side * radiusY * 0.9
    const z = point[2] + 0.001
    details.sweep([
      knot([point[0] - width / 2, y, z], 0.00075, 0.00065),
      knot([point[0] + width / 2, y, z], 0.00075, 0.00065),
    ], 7, 2)
  }

  skin.sweep([
    knot([palmX, palmY - side * 0.012, palmZ - 0.001], 0.014, 0.007),
    knot([palmX, palmY + side * 0.006, palmZ], 0.024, 0.009),
    knot([palmX, palmY + side * 0.003, palmZ - 0.001], 0.022, 0.008),
  ], 18, 6)
  skin.sweep([
    knot(wristStart, 0.009, 0.006),
    knot([palmX, palmY - side * 0.020, palmZ - 0.001], 0.010, 0.006),
    knot(wristEnd, 0.014, 0.008),
  ], 16, 5)
  const palmNearY = palmY + side * palmHalfY * 0.88
  details.sweep([
    knot([palmX - 0.018, palmNearY, palmZ + 0.003], 0.0007, 0.0006),
    knot([palmX - 0.004, palmNearY, palmZ + 0.004], 0.0007, 0.0006),
    knot([palmX + 0.014, palmNearY, palmZ + 0.002], 0.0007, 0.0006),
  ], 7, 3)
  details.sweep([
    knot([palmX - 0.022, palmY + side * palmHalfY * 0.69, palmZ + 0.005],
      0.0006, 0.0005),
    knot([palmX + 0.002, palmY + side * palmHalfY * 0.72, palmZ + 0.005],
      0.0006, 0.0005),
  ], 7, 2)

  for (const finger of [1, 2, 3, 4] as const) {
    const group = contacts.filter((contact) => contact.finger === finger)
    if (!group.length) {
      const peakReachByFinger = [0, 0.65, 0.68, 0.63, 0.60] as const
      const curlBackByFinger = [0, 0.12, 0.13, 0.12, 0.10] as const
      const root: HandVector = [rootXs[finger - 1], rootYs[finger - 1], palmZ + 0.014]
      const peakY = root[1] + side * ySpan * peakReachByFinger[finger]
      const tipY = peakY - side * ySpan * curlBackByFinger[finger]
      const at = (fraction: number) => root[1] + (peakY - root[1]) * fraction
      const splay = (2.5 - finger) * 0.003
      const joints: HandVector[] = [
        root,
        [root[0] + splay * 0.2, at(0.28), maxSurfaceZ + 0.027 + rise],
        [root[0] + splay * 0.65, at(0.62), maxSurfaceZ + 0.034 + rise],
        [root[0] + splay, peakY, maxSurfaceZ + 0.027 + rise],
        [root[0] + splay * 1.2, tipY, maxSurfaceZ + 0.021 + rise],
      ]
      skin.sweep([
        knot(joints[0], 0.005, 0.0048),
        knot(joints[1], 0.0048, 0.0046),
        knot(joints[2], 0.0046, 0.0044),
        knot(joints[3], 0.0042, 0.004),
        knot(joints[4], 0.0037, 0.0035),
      ], 12, 4)
      skin.sphere(joints[1], [0.0046, 0.0043, 0.0043], 7, 10)
      skin.sphere(joints[2], [0.0044, 0.0041, 0.004], 7, 10)
      skin.sphere(joints[3], [0.0041, 0.0039, 0.0037], 7, 10)
      const nail: HandVector = [joints[4][0] - 0.0005, joints[4][1],
        joints[4][2] + 0.0032]
      nails.sphere(nail, [0.0035, 0.0026, 0.0009], 7, 10)
      nailCenters.push({ finger, center: nail })
      fingerCrease(joints[1], 0.005, 0.006)
      fingerCrease(joints[2], 0.0048, 0.006)
      fingerMetadata.push({ finger, pressed: false, barre: false, joints })
      continue
    }
    const targetX = mean(group.map((contact) => contact.surface[0]))
    const targetY = mean(group.map((contact) => contact.surface[1]))
    const targetZ = mean(group.map((contact) => contact.surface[2]))
    const padHeight = 0.0042
    const root: HandVector = [rootXs[finger - 1], rootYs[finger - 1], palmZ + 0.014]
    const atX = (fraction: number) => targetX + (root[0] - targetX) * fraction
    const atY = (fraction: number) => targetY + (root[1] - targetY) * fraction
    const joints: HandVector[] = [
      [targetX, targetY, targetZ + padHeight + rise],
      [atX(0.1), atY(0.14), targetZ + 0.014 + rise],
      [atX(0.52), atY(0.52), targetZ + 0.021 + rise * 0.55],
      [atX(0.86), atY(0.84), palmZ + 0.018],
      root,
    ]
    skin.sweep([
      knot(joints[0], 0.0045, padHeight),
      knot(joints[1], 0.0048, 0.0046),
      knot(joints[2], 0.0054, 0.0051),
      knot(joints[3], 0.0057, 0.0054),
      knot(joints[4], 0.006, 0.0057),
    ], 14, 5)
    skin.sphere(joints[0], [0.0048, 0.0044, padHeight], 8, 12)
    skin.sphere(joints[1], [0.0048, 0.0045, 0.0044], 8, 12)
    skin.sphere(joints[2], [0.0053, 0.0049, 0.005], 8, 12)
    skin.sphere(joints[3], [0.0057, 0.0053, 0.0052], 8, 12)
    skin.sphere(root, [0.006, 0.0055, 0.0054], 8, 12)
    const barre = group.length > 1 && group.every((contact) => contact.barre)
    const terminalContact = barre
      ? group.reduce((furthest, contact) =>
        Math.abs(contact.surface[1] - root[1]) > Math.abs(furthest.surface[1] - root[1])
          ? contact : furthest)
      : null
    const nail = terminalContact
      ? add(terminalContact.surface, [0.001, 0, padHeight * 0.92 + rise])
      : add(joints[0], [0.001, 0, padHeight * 0.92])
    nails.sphere(nail, [0.0054, 0.003, 0.0009], 7, 10)
    nailCenters.push({ finger, center: nail })
    fingerCrease(joints[1], 0.0052, 0.007)
    fingerCrease(joints[2], 0.0061, 0.008)
    if (barre) {
      const across = [...group].sort((a, b) => a.surface[1] - b.surface[1])
      const barreRadius = 0.004
      skin.sweep(across.map((contact) => knot(
        [contact.surface[0], contact.surface[1],
          contact.surface[2] + barreRadius + rise],
        0.0062, barreRadius)), 14, 3)
    }
    fingerMetadata.push({ finger, pressed: true, barre, joints })
  }

  let thumbTip: HandVector
  const thumbContact = contacts.find((contact) => contact.finger === 5)
  if (thumbContact) {
    thumbTip = [thumbContact.surface[0], thumbContact.surface[1],
      thumbContact.surface[2] + 0.0052 + rise]
    skin.sweep([
      knot([palmX, palmY + side * palmHalfY * 0.66, palmZ - 0.002], 0.008, 0.008),
      knot([thumbTip[0] - 0.025, thumbTip[1] - side * 0.016, palmZ - 0.006], 0.008, 0.008),
      knot([thumbTip[0] - 0.008, thumbTip[1] - side * 0.006, thumbTip[2] + 0.009], 0.0065, 0.0065),
      knot(thumbTip, 0.0058, 0.0052),
    ], 14, 5)
    const thumbNail = [thumbTip[0] + 0.001, thumbTip[1], thumbTip[2] + 0.0058] as HandVector
    nails.sphere(thumbNail, [0.0048, 0.0031, 0.0009], 6, 10)
    nailCenters.push({ finger: 5, center: thumbNail })
  } else {
    const targetX = mean(contacts.map((contact) => contact.surface[0]))
    const farEdgeY = side > 0 ? maxStringY : minStringY
    thumbTip = [targetX, farEdgeY + side * 0.014, maxSurfaceZ - 0.012 + rise]
  }
  const skinMesh = skin.build()
  const detailMesh = details.build()
  const nailMesh = nails.build()
  return {
    skin: skinMesh.vertices,
    skinIndices: skinMesh.indices,
    details: detailMesh.vertices,
    detailIndices: detailMesh.indices,
    nails: nailMesh.vertices,
    nailIndices: nailMesh.indices,
    fingers: fingerMetadata,
    contactTips: contacts.map((contact) => {
      const barre = contact.barre
      const radius = barre ? 0.004 : contact.finger === 5 ? 0.0052 : 0.0042
      return {
        finger: contact.finger,
        string: contact.string,
        fret: contact.fret,
        barre: contact.barre,
        surface: contact.surface,
        tip: [contact.surface[0], contact.surface[1], contact.surface[2] + radius + rise] as HandVector,
        gap: rise,
      }
    }),
    palmCenter: [palmX, palmY, palmZ],
    palmHalfExtents: [palmHalfX, palmHalfY, palmHalfZ],
    wristStart,
    wristEnd,
    nailCenters,
    thumbTip,
    surfaceGap: rise,
  }
}
