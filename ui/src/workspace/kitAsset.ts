import type { KitPiece } from './kit'
import type { KitType, Look } from './prefs'
import { LOOKS } from './prefs'

/**
 * Loads a drum-kit GLB (one per kit type, with every look as a material variant) and prepares it for one look:
 * static parts are merged into a few world-space batches per material; playable surfaces, pedals and the beater stay
 * separate, in their own node frames, so the renderer can move them around their pivots.
 */

export type Target = KitPiece | 'hatPedal'
/** A piano key by MIDI pitch, or a piano pedal by its MIDI controller (64 sustain, 66 sostenuto, 67 soft). */
export type KeyTarget = `key:${number}` | `pedal:${number}`
export type AnyTarget = Target | KeyTarget
export type Vec3 = [number, number, number]
/** How a part reacts to a hit: heads press in, cymbals wobble, the hi-hat top rides its rod, pedals and the beater swing. */
export type Motion = 'head' | 'cymbal' | 'hat' | 'pedal' | 'beater' | 'press'
export type MaterialView = {
  name: string
  base: [number, number, number, number]
  metal: number
  rough: number
  emissive: Vec3
  baseTex: number
  ormTex: number
  normalTex: number
  emissiveTex: number
  normalScale: number
  blend: boolean
}
export type Item = {
  name: string
  /** 12 floats per vertex: position, normal, uv, tangent (xyz + w). Static items are in world space. */
  data: Float32Array
  index: Uint32Array
  material: MaterialView
  /** World matrix of the item's frame (identity for merged static batches). */
  frame: Float32Array
  target?: AnyTarget
  /** The part glows with its target's feedback (a playable surface). */
  glows: boolean
  motion?: Motion
  angle?: number
  center: Vec3
}
export type Prepared = { items: Item[]; anchors: Map<KitPiece, Vec3>; center: Vec3; radius: number; hatStates: Record<string, number>; images: number }
export type Asset = { json: Gltf; bin: Uint8Array; images: Promise<(ImageBitmap | null)[]> }

export type Node = { name: string; mesh?: number; children?: number[]; translation?: number[]; rotation?: number[]; extras?: Record<string, unknown>; extensions?: Record<string, { ids?: number[] }> }
export type Gltf = {
  scenes: { nodes: number[] }[]; scene?: number
  nodes: Node[]
  meshes: { name: string; primitives: { attributes: Record<string, number>; indices: number; material: number; extensions?: { KHR_materials_variants?: { mappings: { material: number; variants: number[] }[] } } }[] }[]
  accessors: { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string }[]
  bufferViews: { byteOffset?: number; byteLength: number }[]
  materials: { name: string; alphaMode?: string; emissiveFactor?: number[]; emissiveTexture?: { index: number }; normalTexture?: { index: number; scale?: number }
    occlusionTexture?: { index: number }; pbrMetallicRoughness?: { baseColorFactor?: number[]; metallicFactor?: number; roughnessFactor?: number
      baseColorTexture?: { index: number }; metallicRoughnessTexture?: { index: number } } }[]
  textures: { source: number }[]
  images: { bufferView: number; mimeType: string; name?: string }[]
  extensions?: { KHR_materials_variants?: { variants: { name: string }[] } }
}

export const KIT_FILE: Record<KitType, string> = { acoustic: 'AcousticKit.glb', electronic: 'ElectronicKit.glb' }
/** Largest texture side uploaded to the GPU. */
export const MAX_TEXTURE = 1024

/** The surfaces and moving parts the app animates, by node name, for both kits. */
const PARTS: Record<string, { target: Target; motion?: Motion; glows?: boolean }> = {
  Kick_BatterHead: { target: 'kick', motion: 'head', glows: true }, Kick_Pad: { target: 'kick', motion: 'head', glows: true },
  KickPedal_Footboard: { target: 'kick', motion: 'pedal' }, Kick_PedalBoard: { target: 'kick', motion: 'pedal' },
  KickPedal_Shaft: { target: 'kick', motion: 'beater' }, KickPedal_Beater: { target: 'kick', motion: 'beater' }, Kick_Beater: { target: 'kick', motion: 'beater' },
  Snare_BatterHead: { target: 'snare', motion: 'head', glows: true }, Snare_Head: { target: 'snare', motion: 'head', glows: true },
  TomHigh_BatterHead: { target: 'tom1', motion: 'head', glows: true }, TomHigh_Head: { target: 'tom1', motion: 'head', glows: true },
  TomMid_BatterHead: { target: 'tom2', motion: 'head', glows: true }, TomMid_Head: { target: 'tom2', motion: 'head', glows: true },
  FloorTom_BatterHead: { target: 'floor', motion: 'head', glows: true }, FloorTom_Head: { target: 'floor', motion: 'head', glows: true },
  HiHat_TopCymbal: { target: 'hihat', motion: 'hat', glows: true }, HiHat_Clutch: { target: 'hihat', motion: 'hat' }, HiHat_Cymbal: { target: 'hihat', motion: 'hat', glows: true },
  HiHat_Pedal: { target: 'hatPedal', motion: 'pedal' }, HiHat_PedalBoard: { target: 'hatPedal', motion: 'pedal' },
  Crash_Cymbal: { target: 'crash', motion: 'cymbal', glows: true },
  Ride_Cymbal: { target: 'ride', motion: 'cymbal', glows: true }, Ride_Bell: { target: 'ride', motion: 'cymbal', glows: true },
  Ride_Bow: { target: 'ride', motion: 'cymbal', glows: true }, Ride_Edge: { target: 'ride', motion: 'cymbal', glows: true },
}
/** Where each piece's label sits. */
const ANCHORS: Partial<Record<KitPiece, string[]>> = {
  kick: ['Kick_BatterHead', 'Kick_Pad'], snare: ['Snare_BatterHead', 'Snare_Head'], tom1: ['TomHigh_BatterHead', 'TomHigh_Head'],
  tom2: ['TomMid_BatterHead', 'TomMid_Head'], floor: ['FloorTom_BatterHead', 'FloorTom_Head'], hihat: ['HiHat_TopCymbal', 'HiHat_Cymbal'],
  crash: ['Crash_Cymbal'], ride: ['Ride_Cymbal'],
}

const cache = new Map<string, Promise<Asset>>()
/** Where the kit files are served from; the dev and test setup can point this elsewhere. */
export const kitBase = () => (globalThis as { __mizanKitAssets?: string }).__mizanKitAssets ?? `${import.meta.env.BASE_URL ?? '/'}models/`

/** Fetches and parses a kit once per session; later looks and remounts reuse it. */
export const loadKit = (kit: KitType): Promise<Asset> => loadGlb(KIT_FILE[kit])

/** Fetches and parses a model in the models folder once per session. */
export function loadGlb(file: string): Promise<Asset> {
  const url = kitBase() + file
  let pending = cache.get(url)
  if (!pending) {
    pending = (async () => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`${file} is not available (${response.status})`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      if (view.getUint32(0, true) !== 0x46546c67) throw new Error(`${file} is not a binary glTF file`)
      const jsonLength = view.getUint32(12, true)
      const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as Gltf
      const binLength = view.getUint32(20 + jsonLength, true)
      const bin = bytes.subarray(28 + jsonLength, 28 + jsonLength + binLength)
      const images = Promise.all(json.images.map(async (image, index) => {
        const v = json.bufferViews[image.bufferView]
        try {
          const blob = new Blob([bin.slice(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)], { type: image.mimeType })
          // The assets carry 2048-pixel maps; the practice view samples them at 1024 at most, a quarter of the GPU memory.
          const full = await createImageBitmap(blob)
          if (full.width <= MAX_TEXTURE && full.height <= MAX_TEXTURE) return full
          const scale = MAX_TEXTURE / Math.max(full.width, full.height)
          const size = { resizeWidth: Math.round(full.width * scale), resizeHeight: Math.round(full.height * scale) }
          full.close()
          return await createImageBitmap(blob, { ...size, resizeQuality: 'high' })
        } catch (error) {
          // The kit still draws, with that map's plain material colour instead of the texture.
          console.error(`${file}: texture ${index}${image.name ? ` (${image.name})` : ''} could not be decoded; drawing its material without it.`, error)
          return null
        }
      }))
      return { json, bin, images }
    })()
    pending.catch(() => cache.delete(url))
    cache.set(url, pending)
  }
  return pending
}

// ---------- small matrix helpers (column-major) ----------
export const mul = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return out
}
export const trs = (node: Node) => {
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1]
  const [tx, ty, tz] = node.translation ?? [0, 0, 0]
  return new Float32Array([
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    tx, ty, tz, 1,
  ])
}
export const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

export function read(asset: Asset, accessorIndex: number): Float32Array | Uint32Array {
  const { json, bin } = asset
  const a = json.accessors[accessorIndex]
  const view = json.bufferViews[a.bufferView]
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type] ?? 1
  const offset = bin.byteOffset + (view.byteOffset ?? 0) + (a.byteOffset ?? 0)
  const buffer = bin.buffer as ArrayBuffer
  if (a.componentType === 5126) return new Float32Array(buffer.slice(offset, offset + a.count * size * 4))
  if (a.componentType === 5125) return new Uint32Array(buffer.slice(offset, offset + a.count * 4))
  return Uint32Array.from(new Uint16Array(buffer.slice(offset, offset + a.count * 2)))
}

export function material(json: Gltf, index: number): MaterialView {
  const m = json.materials[index]
  const pbr = m.pbrMetallicRoughness ?? {}
  return {
    name: m.name,
    base: (pbr.baseColorFactor ?? [1, 1, 1, 1]) as MaterialView['base'],
    metal: pbr.metallicFactor ?? 1,
    rough: pbr.roughnessFactor ?? 1,
    emissive: (m.emissiveFactor ?? [0, 0, 0]) as Vec3,
    baseTex: pbr.baseColorTexture ? json.textures[pbr.baseColorTexture.index].source : -1,
    ormTex: pbr.metallicRoughnessTexture ? json.textures[pbr.metallicRoughnessTexture.index].source : -1,
    normalTex: m.normalTexture ? json.textures[m.normalTexture.index].source : -1,
    emissiveTex: m.emissiveTexture ? json.textures[m.emissiveTexture.index].source : -1,
    normalScale: m.normalTexture?.scale ?? 1,
    blend: m.alphaMode === 'BLEND',
  }
}

/** Which embedded level of detail a look draws: every offered look draws the full model. */
export function lodFor(_asset: Asset, _look: Look): number {
  return 0
}

/** Prepares one look of a kit: picks the level of detail and each primitive's variant material. */
export function prepare(asset: Asset, look: Look, lod = lodFor(asset, look)): Prepared {
  const { json } = asset
  const variants = json.extensions?.KHR_materials_variants?.variants.map((v) => v.name) ?? []
  const variant = variants.indexOf(look)
  const sceneRoot = json.scenes[json.scene ?? 0].nodes[0]
  const root = lod === 0 ? sceneRoot : json.nodes[sceneRoot].extensions?.MSFT_lod?.ids?.[lod - 1] ?? sceneRoot
  const items: Item[] = []
  const anchors = new Map<KitPiece, Vec3>()
  const statics = new Map<number, { data: number[]; index: number[] }>()
  let hatStates: Record<string, number> = { fullyOpen: 0.02, partiallyOpen: 0, closed: -0.013, pedalClosed: -0.015 }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  const visit = (index: number, parentWorld: Float32Array, inherited: (typeof PARTS)[string] | undefined) => {
    const node = json.nodes[index]
    // The throne sits where the camera is (behind the player); the practice view leaves it out.
    if (node.name === 'Throne') return
    const world = mul(parentWorld, trs(node))
    const part = PARTS[node.name] ?? (inherited && node.name.startsWith('Ride_') ? inherited : undefined)
    if (node.extras?.states) hatStates = node.extras.states as Record<string, number>
    for (const [piece, names] of Object.entries(ANCHORS)) if (names!.includes(node.name)) anchors.set(piece as KitPiece, [world[12], world[13], world[14]])
    if (node.mesh !== undefined) for (const prim of json.meshes[node.mesh].primitives) {
      const mapped = prim.extensions?.KHR_materials_variants?.mappings.find((m) => m.variants.includes(variant))
      const matIndex = mapped?.material ?? prim.material
      const pos = read(asset, prim.attributes.POSITION) as Float32Array
      const nor = read(asset, prim.attributes.NORMAL) as Float32Array
      const uv = prim.attributes.TEXCOORD_0 !== undefined ? read(asset, prim.attributes.TEXCOORD_0) as Float32Array : new Float32Array(pos.length / 3 * 2)
      const tan = prim.attributes.TANGENT !== undefined ? read(asset, prim.attributes.TANGENT) as Float32Array : new Float32Array(pos.length / 3 * 4)
      const idx = read(asset, prim.indices) as Uint32Array
      const count = pos.length / 3
      for (let i = 0; i < count; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
        for (let k = 0; k < 3; k++) {
          const w = world[k] * x + world[4 + k] * y + world[8 + k] * z + world[12 + k]
          if (w < min[k]) min[k] = w
          if (w > max[k]) max[k] = w
        }
      }
      if (part) {
        const data = new Float32Array(count * 12)
        for (let i = 0; i < count; i++) {
          data.set(pos.subarray(i * 3, i * 3 + 3), i * 12)
          data.set(nor.subarray(i * 3, i * 3 + 3), i * 12 + 3)
          data.set(uv.subarray(i * 2, i * 2 + 2), i * 12 + 6)
          data.set(tan.subarray(i * 4, i * 4 + 4), i * 12 + 8)
        }
        items.push({ name: node.name, data, index: idx, material: material(json, matIndex), frame: world, target: part.target, glows: !!part.glows,
          motion: part.motion, angle: typeof node.extras?.pressAngle === 'number' ? node.extras.pressAngle as number : typeof node.extras?.strikeAngle === 'number' ? node.extras.strikeAngle as number : undefined,
          center: [world[12], world[13], world[14]] })
      } else {
        const batch = statics.get(matIndex) ?? { data: [], index: [] }
        const base = batch.data.length / 12
        for (let i = 0; i < count; i++) {
          const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
          const nx = nor[i * 3], ny = nor[i * 3 + 1], nz = nor[i * 3 + 2]
          const tx = tan[i * 4], ty = tan[i * 4 + 1], tz = tan[i * 4 + 2]
          batch.data.push(
            world[0] * x + world[4] * y + world[8] * z + world[12], world[1] * x + world[5] * y + world[9] * z + world[13], world[2] * x + world[6] * y + world[10] * z + world[14],
            world[0] * nx + world[4] * ny + world[8] * nz, world[1] * nx + world[5] * ny + world[9] * nz, world[2] * nx + world[6] * ny + world[10] * nz,
            uv[i * 2], uv[i * 2 + 1],
            world[0] * tx + world[4] * ty + world[8] * tz, world[1] * tx + world[5] * ty + world[9] * tz, world[2] * tx + world[6] * ty + world[10] * tz, tan[i * 4 + 3])
        }
        for (const i of idx) batch.index.push(i + base)
        statics.set(matIndex, batch)
      }
    }
    for (const child of node.children ?? []) visit(child, world, part ?? inherited)
  }
  visit(root, IDENTITY, undefined)
  for (const [matIndex, batch] of statics)
    items.push({ name: `static:${json.materials[matIndex].name}`, data: new Float32Array(batch.data), index: new Uint32Array(batch.index), material: material(json, matIndex),
      frame: IDENTITY, glows: false, center: [0, 0, 0] })
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2
  return { items, anchors, center, radius, hatStates, images: json.images.length }
}

const preparedCache = new WeakMap<Asset, Map<Look, Prepared>>()
/** `prepare`, kept per asset and look, so reopening a lesson or switching back to a look reuses the work. */
export function preparedFor(asset: Asset, look: Look): Prepared {
  const looks = preparedCache.get(asset) ?? new Map<Look, Prepared>()
  preparedCache.set(asset, looks)
  if (!looks.has(look)) looks.set(look, prepare(asset, look))
  return looks.get(look)!
}

/** Rendered triangles for a prepared look (used by the tests and the asset report). */
export const triangleCount = (prepared: Prepared) => prepared.items.reduce((sum, item) => sum + item.index.length / 3, 0)

export { LOOKS }
