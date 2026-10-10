import { IDENTITY, kitBase, loadGlb, material, mul, read, trs, type Asset, type Item, type KeyTarget, type MaterialView, type Prepared, type Vec3 } from './kitAsset'
import type { Look } from './prefs'

/**
 * The piano and keyboard models: six instruments listed in KeyboardInstruments.json, each a GLB whose keys are separate
 * nodes named Key_<midi>_<pitch> on a rear hinge, with three pedals carrying their MIDI controller. Preparing a look keeps
 * every key and pedal as its own item in its hinge frame, so it can press, and merges everything else.
 */

export type PianoVariant = {
  id: string; file: string; name: string; low: number; high: number; keys: number; whiteKeys: number; blackKeys: number; sha256: string
  dimensions: { bodyWidth: number; bodyDepth: number; bodyHeight: number }
  pedals: { name: string; controller: number }[]
}
export type PianoManifest = { defaultVariant: string; runtimeLooks: Look[]; variants: PianoVariant[] }

export type PreparedPiano = Prepared & {
  /** Each key by MIDI pitch: whether it is black, where its finger label sits (world), and its hinge position. */
  keys: Map<number, { black: boolean; label: Vec3; hinge: Vec3; front: Vec3 }>
  /** Pedal label positions by MIDI controller. */
  pedals: Map<number, Vec3>
  /** World-space bounds of everything drawn (the bench is left out). */
  bounds: { min: Vec3; max: Vec3 }
}

const MANIFEST = 'KeyboardInstruments.json'
let manifest: Promise<PianoManifest> | null = null

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** The instruments on offer, read once per session; a broken manifest is reported, not guessed around. */
export function loadPianoManifest(): Promise<PianoManifest> {
  if (!manifest) {
    manifest = (async () => {
      const response = await fetch(kitBase() + MANIFEST)
      if (!response.ok) throw new Error(`${MANIFEST} is not available (${response.status})`)
      const value = await response.json() as { defaultVariant?: unknown; runtimeLooks?: unknown; variants?: Record<string, Partial<PianoVariant>> }
      const variants = Object.entries(value.variants ?? {}).map(([id, variant]) => ({ ...variant, id }) as PianoVariant)
      if (!variants.length || !variants.every((v) => typeof v.file === 'string' && /^[A-Za-z0-9]+\.glb$/.test(v.file) && typeof v.name === 'string' &&
          isNumber(v.low) && isNumber(v.high) && v.low < v.high && Array.isArray(v.pedals)) ||
          typeof value.defaultVariant !== 'string' || !variants.some((v) => v.id === value.defaultVariant)) throw new Error(`${MANIFEST} is not a valid instrument list`)
      return { defaultVariant: value.defaultVariant, runtimeLooks: (value.runtimeLooks ?? []) as Look[], variants }
    })()
    manifest.catch(() => { manifest = null })
  }
  return manifest
}

export const loadPiano = (variant: PianoVariant): Promise<Asset> => loadGlb(variant.file)

const KEY = /^Key_(\d+)_[A-G]s?\d$/
const PEDAL = /^Pedal_(Soft|Sostenuto|Sustain)$/

/**
 * In the blueprint look the model's keys are tinted glass, which lets the structure under the keybed show through and
 * blurs white and black. The keys a player reads stay solid there: pale paper white and deep blueprint blue.
 */
function keyMaterial(view: MaterialView, look: Look, black: boolean | undefined): MaterialView {
  if (look !== 'TechnicalBlueprint' || black === undefined) return view
  return { ...view, base: black ? [0.13, 0.19, 0.33, 1] : [0.95, 0.97, 1, 1], blend: false, baseTex: -1 }
}

const apply = (m: ArrayLike<number>, v: ArrayLike<number>, w: number): Vec3 =>
  [0, 1, 2].map((k) => m[k] * v[0] + m[4 + k] * v[1] + m[8 + k] * v[2] + m[12 + k] * w) as Vec3

/** Prepares one look of a piano model at one level of detail (0 is the full model). */
export function preparePiano(asset: Asset, look: Look, lod = 0): PreparedPiano {
  const { json } = asset
  const variants = json.extensions?.KHR_materials_variants?.variants.map((v) => v.name) ?? []
  const variant = variants.indexOf(look)
  const sceneRoot = json.scenes[json.scene ?? 0].nodes[0]
  const root = lod === 0 ? sceneRoot : json.nodes[sceneRoot].extensions?.MSFT_lod?.ids?.[lod - 1] ?? sceneRoot
  const items: Item[] = []
  const keys: PreparedPiano['keys'] = new Map()
  const pedals: PreparedPiano['pedals'] = new Map()
  const statics = new Map<number, { data: number[]; index: number[] }>()
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  type Part = { target: KeyTarget; angle: number; frame: Float32Array; black?: boolean }
  const visit = (index: number, parentWorld: Float32Array, part: Part | undefined, local: Float32Array) => {
    const node = json.nodes[index]
    // The bench sits where the camera is (behind the player); the practice view leaves it out, as the kit leaves out its throne.
    if (node.name === 'Bench') return
    const world = mul(parentWorld, trs(node))
    const extras = node.extras ?? {}
    const actuation = extras.actuation as { angle?: unknown; front?: unknown } | undefined
    let own = part
    let toPart = part ? mul(local, trs(node)) : IDENTITY
    const keyMatch = KEY.exec(node.name)
    const pedalMatch = PEDAL.exec(node.name)
    if (!part && (keyMatch || pedalMatch) && isNumber(actuation?.angle)) {
      const target: KeyTarget = keyMatch ? `key:${Number(keyMatch[1])}` : `pedal:${extras.controller as number}`
      own = { target, angle: actuation.angle, frame: world, black: keyMatch ? extras.isBlack === true : undefined }
      toPart = IDENTITY
      const anchor = Array.isArray(extras.labelAnchor) ? extras.labelAnchor as number[] : [0, 0, 0]
      const front = Array.isArray(actuation.front) ? actuation.front as number[] : [0, 0, 0]
      if (keyMatch) keys.set(Number(keyMatch[1]), { black: extras.isBlack === true, label: apply(world, anchor, 1), hinge: apply(world, [0, 0, 0], 1), front: apply(world, front, 1) })
      else if (isNumber(extras.controller)) pedals.set(extras.controller, apply(world, anchor, 1))
    }
    if (node.mesh !== undefined) for (const prim of json.meshes[node.mesh].primitives) {
      const mapped = prim.extensions?.KHR_materials_variants?.mappings.find((m) => m.variants.includes(variant))
      const matIndex = mapped?.material ?? prim.material
      const pos = read(asset, prim.attributes.POSITION) as Float32Array
      const nor = read(asset, prim.attributes.NORMAL) as Float32Array
      const uv = prim.attributes.TEXCOORD_0 !== undefined ? read(asset, prim.attributes.TEXCOORD_0) as Float32Array : new Float32Array(pos.length / 3 * 2)
      const tan = prim.attributes.TANGENT !== undefined ? read(asset, prim.attributes.TANGENT) as Float32Array : new Float32Array(pos.length / 3 * 4)
      const idx = read(asset, prim.indices) as Uint32Array
      const count = pos.length / 3
      // Moving parts keep their vertices in the hinge frame (children folded in); everything else goes to world space.
      const m = own ? toPart : world
      const data = new Float32Array(count * 12)
      for (let i = 0; i < count; i++) {
        const p = apply(m, pos.subarray(i * 3, i * 3 + 3), 1)
        const n = apply(m, nor.subarray(i * 3, i * 3 + 3), 0)
        const t = apply(m, tan.subarray(i * 4, i * 4 + 3), 0)
        data.set(p, i * 12); data.set(n, i * 12 + 3); data.set(uv.subarray(i * 2, i * 2 + 2), i * 12 + 6); data.set(t, i * 12 + 8); data[i * 12 + 11] = tan[i * 4 + 3]
        const w = own ? apply(own.frame, p, 1) : p
        for (let k = 0; k < 3; k++) { if (w[k] < min[k]) min[k] = w[k]; if (w[k] > max[k]) max[k] = w[k] }
      }
      if (own) {
        items.push({ name: node.name, data, index: idx, material: keyMaterial(material(json, matIndex), look, own.black), frame: own.frame, target: own.target, glows: true,
          motion: 'press', angle: own.angle, center: [own.frame[12], own.frame[13], own.frame[14]] })
      } else {
        const batch = statics.get(matIndex) ?? { data: [], index: [] }
        const base = batch.data.length / 12
        for (const value of data) batch.data.push(value)
        for (const i of idx) batch.index.push(i + base)
        statics.set(matIndex, batch)
      }
    }
    for (const child of node.children ?? []) visit(child, world, own, toPart)
  }
  visit(root, IDENTITY, undefined, IDENTITY)
  for (const [matIndex, batch] of statics)
    items.push({ name: `static:${json.materials[matIndex].name}`, data: new Float32Array(batch.data), index: new Uint32Array(batch.index), material: material(json, matIndex),
      frame: IDENTITY, glows: false, center: [0, 0, 0] })
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2
  return { items, anchors: new Map(), center, radius, hatStates: {}, images: json.images.length, keys, pedals, bounds: { min: min as Vec3, max: max as Vec3 } }
}

const preparedCache = new WeakMap<Asset, Map<string, PreparedPiano>>()
/** `preparePiano`, kept per model, look and level of detail. */
export function preparedPiano(asset: Asset, look: Look, lod = 0): PreparedPiano {
  const looks = preparedCache.get(asset) ?? new Map<string, PreparedPiano>()
  preparedCache.set(asset, looks)
  const key = `${look}:${lod}`
  if (!looks.has(key)) looks.set(key, preparePiano(asset, look, lod))
  return looks.get(key)!
}
