// Builds the two drum-kit assets as self-contained binary glTF files:
//   ui/public/models/AcousticKit.glb  (AcousticDrumKit)
//   ui/public/models/ElectronicKit.glb (ElectronicDrumKit)
// Run from ui\: node scripts\build-drum-kits.mjs [--out <dir>] [--manifest <file>]
// Each file holds three levels of detail (MSFT_lod), seven looks as material variants (KHR_materials_variants),
// embedded PNG textures, named nodes with pivots, and collision objects. The builder is the editable source.
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KitBuilder, LOOKS, NEON } from './kits/common.mjs'
import { M } from './kits/gltf.mjs'
import { realistic } from './kits/textures.mjs'
import { ACOUSTIC_COLLIDERS, ACOUSTIC_MATERIALS, ACOUSTIC_PLAYABLE, buildAcoustic, HAT_STATES } from './kits/acoustic.mjs'
import { buildElectronic, ELECTRONIC_COLLIDERS, ELECTRONIC_MATERIALS, ELECTRONIC_PLAYABLE } from './kits/electronic.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback }
const outDir = resolve(arg('--out', join(here, '..', 'public', 'models')))

/** World-space bounds of every mesh under `root`, from accessor bounds through each node's world matrix. */
function bounds(doc, root) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  const visit = (index) => {
    const node = doc.json.nodes[index]
    if (node.mesh !== undefined) for (const prim of doc.json.meshes[node.mesh].primitives) {
      const a = doc.json.accessors[prim.attributes.POSITION]
      for (let c = 0; c < 8; c++) {
        const p = M.point(doc.world[index], [c & 1 ? a.max[0] : a.min[0], c & 2 ? a.max[1] : a.min[1], c & 4 ? a.max[2] : a.min[2]])
        for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]) }
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return { min: min.map((x) => +x.toFixed(4)), max: max.map((x) => +x.toFixed(4)), size: max.map((x, k) => +(x - min[k]).toFixed(4)) }
}

const RUNTIME = {
  note: 'Geometry, hierarchy, pivots, colliders and materials are portable glTF. Look shading (tonal bands, outlines, bloom, '
    + 'transparency of unselected parts) and the hit feedback (upcoming glow, hit pulse, wobble) are applied by the app at run time; '
    + 'glTF does not store custom shaders.',
  looks: {
    Realistic: 'PBR with the embedded maps.',
    HandPaintedAnime: 'Painted base colours; run time: 4 soft tonal bands, thin dark-gray silhouette outline, selective occlusion.',
    StylizedAnimated3D: 'Soft PBR factors; run time: smooth wrapped lighting and broad clean highlights.',
    LowPoly: 'Flat factors on the low level of detail; run time: faceted normals and 3 tonal bands.',
    NeonRhythm: 'Near-black metals with dim idle edge accents in each component colour; run time: localized glow.',
    TechnicalBlueprint: 'Translucent blue-gray; run time: technical outlines, selected/active parts drawn opaque.',
    ClayStudyModel: 'Matte clay palette with a subtle clay normal; run time: soft light and strong contact shadows.',
  },
  feedback: 'upcoming note: progressive glow; hit now: bright pulse; then pivot reaction (head compression, cymbal wobble, pedal and beater motion) fading out.',
}

async function build({ file, rootName, materials, buildKit, playable, colliders, lowPolyLod, budgets, hatStates }) {
  const kit = new KitBuilder(rootName, materials(realistic), { maps: !process.argv.includes('--no-maps') })
  const tris = []
  const roots = []
  for (let q = 0; q < 3; q++) {
    kit.tris = 0
    roots.push(buildKit(kit, q, q === 0 ? {} : { lod: q, lodOf: rootName }))
    tris.push(kit.tris)
  }
  const doc = kit.doc
  const root = doc.json.nodes[roots[0]]
  root.extensions = { MSFT_lod: { ids: [roots[1], roots[2]] } }
  root.extras = {
    MSFT_screencoverage: [0.35, 0.12, 0],
    units: 'metres', up: '+Y', forward: '-Z (from the throne toward the audience)', playerLeft: '-X', origin: 'player centreline on the floor',
    lod: { triangles: tris, budgets, lowPolyLook: { lod: lowPolyLod, triangles: tris[lowPolyLod] } },
    looks: LOOKS, runtime: RUNTIME, gameplayColors: Object.fromEntries(Object.entries(NEON).map(([k, c]) => [k, '#' + c.map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')])),
    playableSurfaces: playable, colliders, ...(hatStates ? { hiHatStates: hatStates } : {}),
    bounds: bounds(doc, roots[0]),
  }
  doc.json.scenes = [{ name: rootName, nodes: [roots[0]] }]
  doc.json.extensions = { KHR_materials_variants: { variants: LOOKS.map((name) => ({ name })) } }
  doc.extensionsUsed.add('MSFT_lod')
  doc.extensionsUsed.add('KHR_materials_variants')
  const bytes = doc.write()
  await mkdir(outDir, { recursive: true })
  const path = join(outDir, file)
  await writeFile(path, bytes)
  return { file: path, bytes: bytes.length, triangles: tris, bounds: root.extras.bounds, materials: doc.json.materials.length, textures: doc.json.textures.length, nodes: doc.json.nodes.length }
}

const results = []
results.push(await build({
  file: 'AcousticKit.glb', rootName: 'AcousticDrumKit', materials: ACOUSTIC_MATERIALS, buildKit: buildAcoustic, playable: ACOUSTIC_PLAYABLE,
  colliders: ACOUSTIC_COLLIDERS, lowPolyLod: 2, budgets: [[120000, 220000], [45000, 90000], [12000, 30000]], hatStates: HAT_STATES,
}))
results.push(await build({
  file: 'ElectronicKit.glb', rootName: 'ElectronicDrumKit', materials: ELECTRONIC_MATERIALS, buildKit: buildElectronic, playable: ELECTRONIC_PLAYABLE,
  colliders: ELECTRONIC_COLLIDERS, lowPolyLod: 1, budgets: [[80000, 150000], [20000, 50000], [5000, 15000]],
}))
const manifest = arg('--manifest')
if (manifest) await writeFile(manifest, JSON.stringify(results, null, 2))
for (const r of results) console.log(`${r.file}: ${(r.bytes / 1048576).toFixed(1)} MB, triangles LOD0/1/2 ${r.triangles.join(' / ')}, size ${r.bounds.size.join(' x ')} m, ${r.nodes} nodes, ${r.materials} materials, ${r.textures} textures`)
