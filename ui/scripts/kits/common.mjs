// Shared kit-building helpers: materials and their look variants, the playable-surface palette, and a small
// recorder that places named nodes and their primitives into a glTF Document, once per level of detail.
import { Document, M, merge, transform, triangles } from './gltf.mjs'
import { clayNormal, displayEmission, edgeRing, painted } from './textures.mjs'

/** Looks, in the order the app offers them. Realistic is each primitive's default material. */
export const LOOKS = ['Realistic', 'HandPaintedAnime', 'StylizedAnimated3D', 'LowPoly', 'NeonRhythm', 'TechnicalBlueprint', 'ClayStudyModel']

/** NeonRhythm gameplay colours per playable component (linear RGB). */
export const NEON = {
  Kick: [0.55, 0.2, 1.0], Snare: [0.05, 0.9, 1.0], TomHigh: [0.1, 0.4, 1.0], TomMid: [0.3, 0.15, 0.85],
  FloorTom: [1.0, 0.15, 0.75], HiHat: [1.0, 0.88, 0.1], Crash: [1.0, 0.45, 0.05], Ride: [0.15, 1.0, 0.35],
}
const hex = (c) => '#' + c.map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')

/**
 * Primitive categories decide the stylised materials: `drum` shells and pad bodies, `head` playing surfaces,
 * `cymbal`, `hardware` metal, `rubber` feet, pads and seat, `screen` module display.
 */
const STYLE = {
  HandPaintedAnime: {
    drum: { color: [0.62, 0.2, 0.16], rough: 0.7, metal: 0, painted: 'shell' }, head: { color: [0.95, 0.9, 0.8], rough: 0.8, metal: 0, painted: 'head' },
    cymbal: { color: [0.86, 0.68, 0.36], rough: 0.6, metal: 0.25, painted: 'cymbal' }, hardware: { color: [0.5, 0.52, 0.56], rough: 0.6, metal: 0.2 },
    rubber: { color: [0.19, 0.19, 0.22], rough: 0.85, metal: 0, painted: 'charcoal' }, screen: { color: [0.2, 0.32, 0.46], rough: 0.5, metal: 0 },
  },
  StylizedAnimated3D: {
    drum: { color: [0.62, 0.1, 0.12], rough: 0.35, metal: 0 }, head: { color: [0.96, 0.94, 0.88], rough: 0.55, metal: 0 },
    cymbal: { color: [0.95, 0.7, 0.3], rough: 0.35, metal: 0.7 }, hardware: { color: [0.75, 0.78, 0.84], rough: 0.3, metal: 0.75 },
    rubber: { color: [0.12, 0.12, 0.15], rough: 0.6, metal: 0 }, screen: { color: [0.15, 0.4, 0.8], rough: 0.3, metal: 0 },
  },
  LowPoly: {
    drum: { color: [0.55, 0.12, 0.12], rough: 0.9, metal: 0 }, head: { color: [0.9, 0.88, 0.82], rough: 0.9, metal: 0 },
    cymbal: { color: [0.85, 0.65, 0.3], rough: 0.85, metal: 0 }, hardware: { color: [0.62, 0.65, 0.7], rough: 0.85, metal: 0 },
    rubber: { color: [0.15, 0.15, 0.17], rough: 0.95, metal: 0 }, screen: { color: [0.2, 0.45, 0.85], rough: 0.8, metal: 0 },
  },
  ClayStudyModel: {
    drum: { color: [0.72, 0.38, 0.26], rough: 0.92, metal: 0 }, head: { color: [0.92, 0.88, 0.8], rough: 0.92, metal: 0 },
    cymbal: { color: [0.76, 0.6, 0.3], rough: 0.9, metal: 0.02 }, hardware: { color: [0.55, 0.58, 0.62], rough: 0.9, metal: 0.02 },
    rubber: { color: [0.18, 0.18, 0.19], rough: 0.95, metal: 0 }, screen: { color: [0.55, 0.58, 0.62], rough: 0.9, metal: 0 },
  },
}

/**
 * Builds a kit: `materials` maps each realistic material key to { name, set, size } (a texture generator from
 * textures.realistic), and the builder calls `part()` to add nodes. LOD levels share every material and texture.
 */
export class KitBuilder {
  constructor(rootName, materials, { maps = true } = {}) {
    this.doc = new Document('Mizan drum-kit builder (procedural, dependency-free)')
    this.rootName = rootName
    this.defs = materials
    this.maps = maps
    this.materials = new Map()
    this.variantMaterials = new Map()
    this.textures = new Map()
    this.colliders = []
  }
  texture(key, make) {
    if (!this.textures.has(key)) this.textures.set(key, make())
    return this.textures.get(key)
  }
  realistic(key) {
    if (this.materials.has(key)) return this.materials.get(key)
    const def = this.defs[key]
    const pbr = { baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1 }
    const material = { name: def.name, pbrMetallicRoughness: pbr }
    if (this.maps && def.set) {
      const set = this.texture(`set:${key}`, () => {
        const maps = def.set(def.size)
        return Object.fromEntries(Object.entries(maps).map(([kind, bytes]) => [kind, this.doc.texture(`${def.name}_${kind}`, bytes)]))
      })
      pbr.baseColorTexture = { index: set.base }
      if (set.orm !== undefined) {
        pbr.metallicRoughnessTexture = { index: set.orm }
        material.occlusionTexture = { index: set.orm }
      }
      if (set.normal !== undefined) material.normalTexture = { index: set.normal }
    }
    if (def.emissive) {
      material.emissiveTexture = { index: this.texture('emissive:display', () => this.doc.texture(`${def.name}_emissive`, displayEmission(1024))) }
      material.emissiveFactor = [1, 1, 1]
    }
    const index = this.doc.material(material)
    this.materials.set(key, index)
    return index
  }
  variant(name, make) {
    if (!this.variantMaterials.has(name)) this.variantMaterials.set(name, this.doc.material({ name, ...make() }))
    return this.variantMaterials.get(name)
  }
  /** The material for a primitive under each look, keyed by look index (see LOOKS). */
  looks({ key, cat, comp, role }) {
    const out = [this.realistic(key)]
    for (const look of ['HandPaintedAnime', 'StylizedAnimated3D', 'LowPoly']) {
      const s = STYLE[look][cat]
      out.push(this.variant(`${look}_${cat}`, () => {
        const m = { pbrMetallicRoughness: { baseColorFactor: [...s.color, 1], metallicFactor: s.metal, roughnessFactor: s.rough } }
        if (look === 'HandPaintedAnime' && s.painted) {
          m.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 1]
          m.pbrMetallicRoughness.baseColorTexture = { index: this.texture(`painted:${s.painted}`, () => this.doc.texture(`HandPaintedAnime_${s.painted}`, painted[s.painted](1024))) }
        }
        m.extras = { look, category: cat }
        return m
      }))
    }
    // Neon: near-black materials; only edges carry a dim idle accent in the component's colour.
    const accent = comp && NEON[comp] && (role === 'edge' || cat === 'cymbal')
    out.push(this.variant(accent ? `NeonRhythm_${comp}_${cat === 'cymbal' ? 'CymbalEdge' : 'Edge'}` : `NeonRhythm_${cat}`, () => {
      const dark = { drum: [0.03, 0.03, 0.04], head: [0.05, 0.05, 0.06], cymbal: [0.05, 0.05, 0.055], hardware: [0.06, 0.06, 0.07], rubber: [0.03, 0.03, 0.035], screen: [0.02, 0.03, 0.05] }[cat]
      const m = { pbrMetallicRoughness: { baseColorFactor: [...dark, 1], metallicFactor: cat === 'hardware' || cat === 'cymbal' ? 0.85 : 0.2, roughnessFactor: 0.38 },
        extras: { look: 'NeonRhythm', category: cat, ...(accent ? { gameplayColor: hex(NEON[comp]), component: comp } : {}) } }
      if (accent) {
        m.emissiveFactor = NEON[comp].map((x) => x * 0.45)
        if (cat === 'cymbal') m.emissiveTexture = { index: this.texture('edgeRing', () => this.doc.texture('NeonRhythm_EdgeRing', edgeRing(512))) }
      }
      if (cat === 'screen' && this.textures.has('emissive:display')) {
        m.emissiveTexture = { index: this.textures.get('emissive:display') }
        m.emissiveFactor = [0.6, 0.6, 0.6]
      }
      return m
    }))
    // Blueprint: translucent blue-gray, playable parts slightly more solid; the app makes a selected part opaque.
    const playable = cat === 'head' || cat === 'cymbal' || role === 'edge'
    out.push(this.variant(`TechnicalBlueprint_${playable ? 'Playable' : 'Structure'}`, () => ({
      pbrMetallicRoughness: { baseColorFactor: playable ? [0.6, 0.72, 0.88, 0.55] : [0.52, 0.6, 0.72, 0.3], metallicFactor: 0, roughnessFactor: 0.85 },
      alphaMode: 'BLEND', doubleSided: true, extras: { look: 'TechnicalBlueprint', selectedOpacity: 1 },
    })))
    const clay = STYLE.ClayStudyModel[cat]
    out.push(this.variant(`ClayStudyModel_${cat}`, () => ({
      pbrMetallicRoughness: { baseColorFactor: [...clay.color, 1], metallicFactor: clay.metal, roughnessFactor: clay.rough },
      normalTexture: { index: this.texture('clayNormal', () => this.doc.texture('ClayStudyModel_SurfaceNormal', clayNormal(512))), scale: 0.5 },
      extras: { look: 'ClayStudyModel', category: cat },
    })))
    return out
  }
  /**
   * A named node at `world` under `parent`, with primitives [{ mesh (node-local), key, cat, comp?, role? }].
   * Returns the node index; adds triangles to `this.tris`.
   */
  part(name, world, parent, prims = [], extras) {
    const groups = new Map()
    for (const prim of prims) {
      const id = `${prim.key}|${prim.cat}|${prim.comp ?? ''}|${prim.role ?? ''}`
      const group = groups.get(id) ?? { ...prim, meshes: [] }
      group.meshes.push(prim.mesh)
      groups.set(id, group)
    }
    const primitives = [...groups.values()].map((group) => {
      const looks = this.looks(group)
      return { mesh: merge(...group.meshes), material: looks[0], variants: looks.map((material, variant) => ({ material, variants: [variant] })) }
    })
    const built = primitives.length ? this.doc.mesh(name, primitives) : null
    if (built) this.tris += built.tris
    return this.doc.node(name, world, parent, { ...(built ? { mesh: built.index } : {}), ...(extras ? { extras } : {}) })
  }
  /** A node that reuses another node's mesh (instanced hardware). */
  instance(name, world, parent, of) {
    const mesh = this.doc.json.nodes[of].mesh
    const tris = this.doc.json.meshes[mesh].primitives.reduce((sum, p) => sum + this.doc.json.accessors[p.indices].count / 3, 0)
    this.tris += tris
    return this.doc.node(name, world, parent, { mesh })
  }
  /** A collision object: an empty node with a simple shape, aligned to the surface it covers. */
  collider(name, world, parent, shape, surface) {
    this.colliders.push(name)
    return this.doc.node(name, world, parent, { extras: { collider: { ...shape, convex: true, surface } } })
  }
}

export { M, merge, transform, triangles }
