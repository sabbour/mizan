import { IDENTITY, mul, read, trs, type Asset, type MaterialView, type Node, type Vec3 } from './kitAsset'
import {
  positionForStringFret, visualStatePriority,
  type FrettedInstrumentConfig, type FrettedPosition, type FrettedTabNote, type FrettedVisualState,
} from './fretboard'
import type { FrettedStyle } from './frettedStyles'
import { styleIndex } from './frettedStyles'

type Item = {
  name: string
  data: Float32Array
  indices: Uint16Array | Uint32Array
  type: number
  frame: Float32Array
  materials: MaterialView[]
  clearcoats: number[]
  string?: number
  lod: number
}
export type FrettedMarker = {
  index: number
  x: number
  y: number
  anchorX: number
  anchorY: number
  label: string
  state: 'playback' | 'upcoming' | FrettedVisualState
  position: FrettedPosition
}
export type FrettedStringLabel = { string: number; name: string; x: number; y: number }
export type FrettedFretLabel = { fret: number; x: number; y: number }
export type FrettedVibration = { string: number; fret: number; amplitude: number; activeStartX: number }
export type FrettedStringCue = { string: number; fret: number; state: 'playback' | 'upcoming' }
export type FrettedPluck = {
  index: number; string: number; conventionalStringNumber: number; name: string; x: number; y: number
}
export type FrettedFrame = {
  markers: FrettedMarker[]
  stringLabels: FrettedStringLabel[]
  fretLabels: FrettedFretLabel[]
  stringCues: FrettedStringCue[]
  plucks: FrettedPluck[]
  vibrations: FrettedVibration[]
  triangles: number
}

const vertexSource = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec2 aUv;
uniform mat4 uMvp;
uniform mat4 uModel;
uniform float uVibration;
uniform float uFretX;
uniform float uTime;
uniform float uAmplitude;
varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUv;
void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  if (uVibration > 0.5) {
    float active = 1.0 - step(uFretX, world.x);
    float envelope = sin(3.14159265 * clamp(world.x / max(uFretX, 0.001), 0.0, 1.0));
    world.y += sin(uTime * 52.0) * uAmplitude * active * envelope;
  }
  vPosition = world.xyz;
  vNormal = normalize(mat3(uModel) * aNormal);
  vUv = aUv;
  gl_Position = uMvp * vec4(aPosition + vec3(0.0, world.y - (uModel * vec4(aPosition, 1.0)).y, 0.0), 1.0);
}`

const fragmentSource = `
precision highp float;
uniform vec4 uBase;
uniform float uMetal;
uniform float uRough;
uniform vec3 uCameraPosition;
uniform vec3 uEmissive;
uniform float uClearcoat;
uniform sampler2D uTexture;
uniform float uHasTexture;
uniform float uStyle;
uniform vec3 uStateColor;
uniform float uState;
varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUv;
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
    step(vec3(0.0031308), c));
}
vec3 studioReflection(vec3 direction, float rough) {
  float spread = mix(0.025, 0.32, rough);
  float strip = exp(-pow((direction.x + 0.38) / (0.18 + spread), 2.0)) *
    smoothstep(-0.3 - spread, 0.1, direction.y);
  float softbox = exp(-pow((direction.x - 0.65) / (0.22 + spread), 2.0) -
    pow((direction.y + 0.25) / (0.48 + spread), 2.0));
  vec3 room = mix(vec3(0.045, 0.035, 0.028), vec3(0.23, 0.27, 0.32),
    smoothstep(-0.55, 0.65, direction.y));
  return room + vec3(1.0, 0.93, 0.82) * strip + vec3(0.65, 0.78, 1.0) * softbox;
}
vec3 toneMap(vec3 color) {
  return clamp((color * (2.51 * color + 0.03)) /
    (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  vec3 n = normalize(vNormal);
  vec3 base = uBase.rgb * (uHasTexture > 0.5 ? srgbToLinear(texture2D(uTexture, vUv).rgb) : vec3(1.0));
  vec3 key = normalize(vec3(-0.38, 0.62, 0.78));
  vec3 fill = normalize(vec3(0.72, -0.32, 0.62));
  vec3 view = normalize(uCameraPosition - vPosition);
  float keyDiffuse = max(dot(n, key), 0.0);
  float fillDiffuse = max(dot(n, fill), 0.0);
  float rough = clamp(uRough, 0.08, 1.0);
  float exponent = mix(128.0, 5.0, rough);
  float keySpec = pow(max(dot(n, normalize(key + view)), 0.0), exponent) * keyDiffuse;
  float fillSpec = pow(max(dot(n, normalize(fill + view)), 0.0), exponent) * fillDiffuse;
  vec3 f0 = mix(vec3(0.04), base, uMetal);
  vec3 fresnel = f0 + (1.0 - f0) * pow(1.0 - max(dot(n, view), 0.0), 5.0);
  vec3 specular = f0 * (keySpec * 2.0 + fillSpec * 1.25);
  specular += vec3(0.04) * pow(max(dot(n, normalize(key + view)), 0.0), 32.0) * uClearcoat * 3.0;
  vec3 diffuse = base * (1.0 - uMetal) *
    (vec3(0.15, 0.13, 0.11) + vec3(0.82, 0.78, 0.72) * keyDiffuse +
      vec3(0.22, 0.25, 0.30) * fillDiffuse);
  vec3 reflected = studioReflection(reflect(-view, n), rough);
  vec3 environment = base * (1.0 - uMetal) * 0.08 +
    reflected * fresnel * (1.0 - rough * 0.45);
  environment += studioReflection(reflect(-view, n), 0.12) * 0.04 * uClearcoat;
  vec3 color = diffuse + environment + specular;
  if (uStyle > 0.5 && uStyle < 1.5) {
    float band = floor((0.35 + 0.65 * (keyDiffuse * 0.75 + fillDiffuse * 0.25)) * 4.0) / 4.0;
    color = base * mix(0.58, 1.12, band) * vec3(1.04, 0.97, 0.88);
  } else if (uStyle > 1.5 && uStyle < 2.5) {
    color = color * 0.42 + vec3(0.12, 0.19, 0.4) + uEmissive;
  } else if (uStyle > 2.5 && uStyle < 3.5) {
    color = mix(color, vec3(0.22, 0.42, 0.59), 0.42);
    color *= 0.84 + 0.16 * keyDiffuse;
  }
  color += uEmissive;
  color = mix(color, uStateColor, clamp(uState, 0.0, 0.82));
  gl_FragColor = vec4(linearToSrgb(toneMap(max(color, vec3(0.0)))), uBase.a);
}`

const STYLE_TONES: Record<FrettedStyle, [number, number, number]> = {
  Realistic: [0.16, 0.48, 0.95],
  ClayStudyModel: [0.15, 0.54, 0.91],
  NeonRhythm: [0.18, 0.9, 1],
  TechnicalBlueprint: [0.05, 0.32, 0.72],
}

const FEEDBACK_COLOR: Record<FrettedVisualState, [number, number, number]> = {
  'incorrectly-played': [1, 0.15, 0.12],
  'correctly-played': [0.13, 0.82, 0.35],
  'current-played': [0.18, 0.75, 1],
  'current-target': [1, 0.75, 0.12],
  upcoming: [1, 0.8, 0.18],
  held: [0.3, 0.83, 0.96],
  muted: [0.52, 0.55, 0.6],
  open: [0.62, 0.84, 0.97],
  scale: [0.2, 0.68, 0.38],
  chord: [0.6, 0.4, 0.9],
  root: [1, 0.55, 0.13],
  'suggested-finger': [0.5, 0.7, 1],
  selected: [0.18, 0.6, 1],
}

const orthographic = (halfWidth: number, halfHeight: number, near: number, far: number, flipX: boolean) =>
  new Float32Array([
    (flipX ? -1 : 1) / halfWidth, 0, 0, 0, 0, 1 / halfHeight, 0, 0, 0, 0, -2 / (far - near), 0,
    0, 0, -(far + near) / (far - near), 1,
  ])

const normalise = (v: number[]) => { const length = Math.hypot(...v); return v.map((x) => x / length) }
const lookAt = (eye: number[], target: number[]) => {
  const sub = (a: number[], b: number[]) => a.map((value, index) => value - b[index])
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const z = normalise(sub(eye, target))
  const x = normalise(cross([0, 1, 0], z))
  const y = cross(z, x)
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1])
}

const multiply = (a: Float32Array, b: Float32Array) => {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return out
}

export class FrettedRenderer {
  private readonly gl: WebGLRenderingContext
  private readonly program: WebGLProgram
  private readonly buffers: { vertex: WebGLBuffer; index: WebGLBuffer }[] = []
  private readonly textures: WebGLTexture[] = []
  private readonly locations: Record<string, WebGLUniformLocation | null> = {}
  private items: Item[] = []
  private readonly config: FrettedInstrumentConfig
  private viewProjection = IDENTITY
  private cameraPosition: [number, number, number] = [0, 0, 2.15]
  private readonly pluckPoints = new Map<number, [number, number, number]>()

  constructor(gl: WebGLRenderingContext, asset: Asset, config: FrettedInstrumentConfig, images: (ImageBitmap | null)[]) {
    this.gl = gl
    this.config = config
    this.program = this.makeProgram(vertexSource, fragmentSource)
    for (const name of ['uMvp', 'uModel', 'uVibration', 'uFretX', 'uTime', 'uAmplitude', 'uBase', 'uMetal',
      'uCameraPosition',
      'uRough', 'uEmissive', 'uClearcoat', 'uTexture', 'uHasTexture', 'uStyle', 'uStateColor', 'uState'])
      this.locations[name] = gl.getUniformLocation(this.program, name)
    gl.useProgram(this.program)
    gl.uniform1i(this.locations.uTexture, 0)
    this.textures = this.loadTextures(asset, images)
    const variantNames = asset.json.extensions?.KHR_materials_variants?.variants.map((variant) => variant.name) ?? []
    const root = asset.json.scenes[asset.json.scene ?? 0].nodes[0]
    this.visit(asset, root, IDENTITY, variantNames)
    for (let index = 0; index < asset.json.nodes.length; index++)
      if (asset.json.nodes[index].extras?.lodLevel === 1 || asset.json.nodes[index].extras?.lodLevel === 2)
        this.visit(asset, index, IDENTITY, variantNames)
    this.findPluckPoints()
  }

  private makeProgram(vertex: string, fragment: string): WebGLProgram {
    const gl = this.gl
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('WebGL could not allocate a guitar shader.')
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const reason = gl.getShaderInfoLog(shader) ?? 'shader compilation failed'
        gl.deleteShader(shader)
        throw new Error(reason)
      }
      return shader
    }
    const vs = compile(gl.VERTEX_SHADER, vertex)
    const fs = compile(gl.FRAGMENT_SHADER, fragment)
    const program = gl.createProgram()
    if (!program) throw new Error('WebGL could not allocate a guitar program.')
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program)
    gl.deleteShader(vs); gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const reason = gl.getProgramInfoLog(program) ?? 'program link failed'
      gl.deleteProgram(program)
      throw new Error(reason)
    }
    return program
  }

  private loadTextures(asset: Asset, images: (ImageBitmap | null)[]): WebGLTexture[] {
    const gl = this.gl
    return asset.json.images.map((_image, index) => {
      const texture = gl.createTexture()
      if (!texture) throw new Error('WebGL could not allocate a guitar material texture.')
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
      const bitmap = images[index]
      if (bitmap) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([190, 160, 120, 255]))
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
      gl.generateMipmap(gl.TEXTURE_2D)
      return texture
    })
  }

  private visit(asset: Asset, index: number, parent: Float32Array, variantNames: string[]) {
    const gl = this.gl
    const gltf = asset.json
    const node = gltf.nodes[index]
    const world = mul(parent, trs(node))
    if (node.mesh !== undefined) {
      const mesh = gltf.meshes[node.mesh]
      for (const primitive of mesh.primitives) {
        const materialIndices = variantNames.map((_variant, style) =>
          primitive.extensions?.KHR_materials_variants?.mappings.find((entry) =>
            entry.variants.includes(style))?.material ?? primitive.material)
        const materials = materialIndices.map((materialIndex) => this.readMaterial(gltf.materials[materialIndex]))
        const clearcoats = materialIndices.map((materialIndex) => this.clearcoat(gltf.materials[materialIndex]))
        const position = read(asset, primitive.attributes.POSITION) as Float32Array
        const normal = read(asset, primitive.attributes.NORMAL) as Float32Array
        const uv = primitive.attributes.TEXCOORD_0 === undefined
          ? new Float32Array(position.length / 3 * 2) : read(asset, primitive.attributes.TEXCOORD_0) as Float32Array
        const rawIndices = read(asset, primitive.indices) as Uint32Array
        const indices = rawIndices.every((value) => value < 65536) ? Uint16Array.from(rawIndices) : rawIndices
        const data = new Float32Array(position.length / 3 * 8)
        for (let i = 0; i < position.length / 3; i++)
          data.set([position[i * 3], position[i * 3 + 1], position[i * 3 + 2],
            normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2], uv[i * 2], uv[i * 2 + 1]], i * 8)
        const vertex = gl.createBuffer(), element = gl.createBuffer()
        if (!vertex || !element) throw new Error('WebGL could not allocate guitar geometry buffers.')
        gl.bindBuffer(gl.ARRAY_BUFFER, vertex); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, element); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
        this.buffers.push({ vertex, index: element })
        this.items.push({ name: node.name, data, indices, type: indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
          frame: world, materials, clearcoats, string: this.stringNumber(node),
          lod: typeof node.extras?.lodLevel === 'number' ? node.extras.lodLevel : 0 })
      }
    }
    for (const child of node.children ?? []) this.visit(asset, child, world, variantNames)
  }

  private readMaterial(source: Asset['json']['materials'][number]): MaterialView {
    return {
        name: source.name,
        base: (source.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1]) as MaterialView['base'],
        metal: source.pbrMetallicRoughness?.metallicFactor ?? 0,
        rough: source.pbrMetallicRoughness?.roughnessFactor ?? 0.6,
        emissive: (source.emissiveFactor ?? [0, 0, 0]) as Vec3,
        baseTex: source.pbrMetallicRoughness?.baseColorTexture ? source.pbrMetallicRoughness.baseColorTexture.index : -1,
        ormTex: source.pbrMetallicRoughness?.metallicRoughnessTexture?.index ?? -1,
        normalTex: source.normalTexture?.index ?? -1,
        emissiveTex: -1,
        normalScale: source.normalTexture?.scale ?? 1,
        blend: false,
    }
  }

  private clearcoat(material: Asset['json']['materials'][number]) {
    return (material as typeof material & { extensions?: { KHR_materials_clearcoat?: { clearcoatFactor?: number } } })
      .extensions?.KHR_materials_clearcoat?.clearcoatFactor ?? 0
  }

  private stringNumber(node: Node): number | undefined {
    const value = node.extras?.stringNumber
    return typeof value === 'number' && node.name.startsWith('String_') ? value : undefined
  }

  private worldVertex(item: Item, offset: number): [number, number, number] {
    const [x, y, z] = item.data.subarray(offset, offset + 3)
    const frame = item.frame
    return [
      frame[0] * x + frame[4] * y + frame[8] * z + frame[12],
      frame[1] * x + frame[5] * y + frame[9] * z + frame[13],
      frame[2] * x + frame[6] * y + frame[10] * z + frame[14],
    ]
  }

  private stringPointAtX(string: number, x: number): [number, number, number] | undefined {
    const item = this.items.find((candidate) => candidate.string === string)
    if (!item) return
    let nearest = Infinity
    const points: [number, number, number][] = []
    for (let offset = 0; offset < item.data.length; offset += 8) {
      const point = this.worldVertex(item, offset)
      const distance = Math.abs(point[0] - x)
      if (distance < nearest - 1e-5) { nearest = distance; points.length = 0 }
      if (distance <= nearest + 1e-5) points.push(point)
    }
    if (!points.length) return
    return [0, 1, 2].map((axis) => points.reduce((sum, point) => sum + point[axis], 0) / points.length) as [number, number, number]
  }

  private findPluckPoints() {
    const pickupName = this.config.id === 'guitar' ? 'Pickup_Middle' : 'Pickup_Neck'
    const pickup = this.items.find((item) => item.name === pickupName)
    if (!pickup) return
    let minX = Infinity, maxX = -Infinity
    for (let offset = 0; offset < pickup.data.length; offset += 8) {
      const x = this.worldVertex(pickup, offset)[0]
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
    }
    const pickupX = (minX + maxX) / 2
    for (const string of this.config.strings) {
      const point = this.stringPointAtX(string.string, pickupX)
      if (point) this.pluckPoints.set(string.string, point)
    }
  }

  private pose(handedness: 'right' | 'left', width: number, height: number) {
    const aspect = Math.max(0.5, width / Math.max(1, height))
    const margin = 0.035
    const targetX = this.config.scaleLength * 0.46
    const spanX = this.config.scaleLength + 0.16
    const halfHeight = Math.max((spanX / 2 + margin) / aspect, 0.09)
    const halfWidth = halfHeight * aspect
    const projection = orthographic(halfWidth, halfHeight, 0.01, 5, false)
    this.cameraPosition = [targetX - 0.42, 0.32, 2.15]
    const view = lookAt(this.cameraPosition, [targetX, 0, 0.035])
    const angle = 0.06
    const roll = new Float32Array([
      Math.cos(angle), Math.sin(angle), 0, 0,
      -Math.sin(angle), Math.cos(angle), 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ])
    const mirror = handedness === 'right'
      ? new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
      : IDENTITY
    this.viewProjection = multiply(mirror, multiply(roll, multiply(projection, view)))
  }

  private projected(point: [number, number, number], width: number, height: number): [number, number] {
    const m = this.viewProjection
    const [x, y, z] = point
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12]
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13]
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15]
    return [(cx / cw * 0.5 + 0.5) * width, (0.5 - cy / cw * 0.5) * height]
  }

  draw(
    width: number,
    height: number,
    style: FrettedStyle,
    time: number,
    plan: readonly FrettedTabNote[],
    beat: number,
    secondsPerBeat: number,
    playing: boolean,
    countingIn: boolean,
    loop: { start: number; end: number } | null,
    feedback: Readonly<Record<string, FrettedVisualState | undefined>> = {},
    reducedMotion = false,
    handedness: 'right' | 'left' = 'right',
  ): FrettedFrame {
    const gl = this.gl
    gl.viewport(0, 0, width, height)
    gl.clearColor(style === 'NeonRhythm' ? 0.055 : style === 'TechnicalBlueprint' ? 0.92 : 0.96,
      style === 'NeonRhythm' ? 0.075 : style === 'TechnicalBlueprint' ? 0.95 : 0.94, style === 'NeonRhythm' ? 0.12 : 0.93, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.DEPTH_TEST)
    gl.enable(gl.CULL_FACE)
    gl.frontFace(handedness === 'right' ? gl.CW : gl.CCW)
    gl.useProgram(this.program)
    const lod = width < 520 ? 1 : 0
    this.pose(handedness, width, height)
    const drawItems = this.items.filter((item) =>
      item.name === 'Body_Mesh' ? lod === 0 :
        item.name === 'Body_Mesh_LOD1' ? lod === 1 : item.lod === 0)
    const triangles = drawItems.reduce((sum, item) => sum + item.indices.length / 3, 0)
    const activeNotes = countingIn ? [] : plan.filter((note) =>
      note.position && note.startBeat <= beat + 1e-8 && beat < note.startBeat + note.beats - 1e-8)
    const distanceTo = (note: FrettedTabNote) => {
      if (!note.position) return Infinity
      if (loop) {
        if (note.startBeat >= loop.end) return Infinity
        if (note.startBeat >= beat - 1e-8) return Math.max(0, note.startBeat - beat)
        if (countingIn || beat < loop.start || note.startBeat < loop.start) return Infinity
        return loop.end - beat + note.startBeat - loop.start
      }
      return countingIn ? note.startBeat - beat : note.startBeat > beat + 1e-8 ? note.startBeat - beat : Infinity
    }
    const nextNotes = plan.filter((note) => note.position && distanceTo(note) >= -1e-8 && distanceTo(note) <= 1)
    const byString = new Map<number, FrettedTabNote>()
    for (const note of activeNotes) if (note.position) {
      const previous = byString.get(note.position.string)
      if (!previous || previous.startBeat < note.startBeat) byString.set(note.position.string, note)
    }
    const upcomingByString = new Map<number, { note: FrettedTabNote; distance: number }>()
    for (const note of nextNotes) if (note.position) {
      const distance = distanceTo(note)
      const previous = upcomingByString.get(note.position.string)
      if (!previous || previous.distance > distance) upcomingByString.set(note.position.string, { note, distance })
    }
    const stringCues: FrettedStringCue[] = []
    for (const [string, note] of byString) if (note.position)
      stringCues.push({ string, fret: note.position.fret, state: 'playback' })
    for (const [string, upcoming] of upcomingByString)
      if (!byString.has(string) && upcoming.note.position)
        stringCues.push({ string, fret: upcoming.note.position.fret, state: 'upcoming' })
    const vibrations: FrettedVibration[] = []
    const plucks: FrettedPluck[] = []
    if (playing && !countingIn) {
      const recentByString = new Map<number, { note: FrettedTabNote; age: number }>()
      for (const note of plan) if (note.position &&
        (!loop || note.startBeat < loop.end && (note.startBeat >= loop.start || beat < loop.start)) &&
        note.startBeat <= beat + 1e-8) {
        const age = Math.max(0, (beat - note.startBeat) * secondsPerBeat)
        const previous = recentByString.get(note.position.string)
        if (age < 0.45 && (!previous || previous.note.startBeat < note.startBeat))
          recentByString.set(note.position.string, { note, age })
      }
      for (const { note } of recentByString.values()) {
        const position = note.position!
        const point = this.pluckPoints.get(position.string)
        if (!point) continue
        const [x, y] = this.projected([point[0], point[1], point[2] + 0.006], width, height)
        const string = this.config.strings[position.string - 1]
        plucks.push({ index: note.index, string: position.string,
          conventionalStringNumber: string.conventionalStringNumber, name: string.name, x, y })
      }
    }
    const stateColor: [number, number, number] = STYLE_TONES[style]
    const stateFor = (item: Item) => {
      const key = item.string ? `String_${item.string}` : item.name
      const explicit = feedback[key]
      return explicit ? FEEDBACK_COLOR[explicit] : stateColor
    }
    const program = this.program
    for (const item of drawItems) {
      const stringNote = item.string ? byString.get(item.string) : undefined
      const upcomingNote = item.string ? upcomingByString.get(item.string)?.note : undefined
      const noteState = stringNote?.position
        ? feedback[`Position_S${stringNote.position.string}_F${stringNote.position.fret}`] : undefined
      const stringState = feedback[item.string ? `String_${item.string}` : item.name]
      const isVibrating = !!stringNote?.position && playing && !countingIn && !reducedMotion
      const age = stringNote ? Math.max(0, (beat - stringNote.startBeat) * secondsPerBeat) : 0
      const amplitude = isVibrating ? 0.002 * Math.exp(-age * 2.6) : 0
      const activeStartX = stringNote?.position
        ? this.config.scaleLength - stringNote.position.fretDistanceFromNut : this.config.scaleLength
      if (item.string && stringNote?.position && isVibrating)
        vibrations.push({ string: item.string, fret: stringNote.position.fret, amplitude, activeStartX })
      const itemIndex = this.items.indexOf(item)
      const selectedMaterial = item.materials[styleIndex(style)] ?? item.materials[0]
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[itemIndex].vertex)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers[itemIndex].index)
      for (const [attribute, offset, size] of [['aPosition', 0, 3], ['aNormal', 3, 3], ['aUv', 6, 2]] as const) {
        const location = gl.getAttribLocation(program, attribute)
        if (location >= 0) { gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, size, gl.FLOAT, false, 32, offset * 4) }
      }
      const model = item.frame
      gl.uniformMatrix4fv(this.locations.uModel, false, model)
      gl.uniformMatrix4fv(this.locations.uMvp, false, multiply(this.viewProjection, model))
      gl.uniform1f(this.locations.uVibration, isVibrating && item.string ? 1 : 0)
      gl.uniform1f(this.locations.uFretX, activeStartX)
      gl.uniform1f(this.locations.uTime, time / 1000)
      gl.uniform1f(this.locations.uAmplitude, amplitude)
      gl.uniform4fv(this.locations.uBase, selectedMaterial.base)
      gl.uniform1f(this.locations.uMetal, selectedMaterial.metal)
      gl.uniform3fv(this.locations.uCameraPosition, this.cameraPosition)
      gl.uniform1f(this.locations.uRough, selectedMaterial.rough)
      gl.uniform3fv(this.locations.uEmissive, selectedMaterial.emissive)
      gl.uniform1f(this.locations.uClearcoat, item.clearcoats[styleIndex(style)] ?? 0)
      gl.uniform1f(this.locations.uStyle, styleIndex(style))
      const explicitState = noteState ?? stringState
      const noteTint = explicitState ? FEEDBACK_COLOR[explicitState] :
        stringNote ? stateColor : upcomingNote ? FEEDBACK_COLOR.upcoming : stateFor(item)
      gl.uniform3fv(this.locations.uStateColor, noteTint)
      const pulse = 0.5 + 0.5 * Math.sin(time / 150)
      const amount = explicitState ? 0.54 : stringNote ? 0.86 :
        upcomingNote ? reducedMotion || !playing ? 0.7 : 0.18 + 0.58 * pulse : 0
      gl.uniform1f(this.locations.uState, amount)
      const baseTex = selectedMaterial.baseTex
      gl.uniform1f(this.locations.uHasTexture, baseTex >= 0 ? 1 : 0)
      if (baseTex >= 0 && this.textures[baseTex]) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.textures[baseTex]) }
      gl.drawElements(gl.TRIANGLES, item.indices.length, item.type, 0)
    }

    const markers: FrettedMarker[] = []
    const markerRank = (state: FrettedMarker['state']) =>
      state === 'playback' ? 5.5 : state === 'upcoming' ? visualStatePriority('upcoming') : visualStatePriority(state)
    const addMarker = (note: FrettedTabNote, state: FrettedMarker['state']) => {
      if (!note.position) return
      const x = note.position.fretboardCoordinate
      const point = this.stringPointAtX(note.position.string, x)
      const [px, py] = this.projected(point ? [point[0], point[1], point[2] + 0.006] : [x, 0, 0.058], width, height)
      const positionState = feedback[`Position_S${note.position.string}_F${note.position.fret}`]
      const resolved = positionState && visualStatePriority(positionState) > markerRank(state) ? positionState : state
      const existing = markers.find((marker) => marker.position.string === note.position!.string && marker.position.fret === note.position!.fret)
      if (existing) {
        if (markerRank(resolved) > markerRank(existing.state)) existing.state = resolved
        if (existing.index < 0 && note.index >= 0) existing.index = note.index
      } else {
        markers.push({ index: note.index, x: px, y: py, anchorX: px, anchorY: py,
          label: note.position.fret ? String(note.position.fret) : 'O',
          state: resolved, position: note.position })
      }
    }
    for (const note of activeNotes) addMarker(note, 'playback')
    for (const note of nextNotes) addMarker(note, 'upcoming')
    for (const [name, state] of Object.entries(feedback)) {
      if (!state) continue
      const match = /^Position_S([1-6])_F(\d+)$/.exec(name)
      if (!match) continue
      const fret = Number(match[2])
      const position = positionForStringFret(Number(match[1]), fret, this.config)
      if (!position) continue
      const note = { index: -1, midi: position.midi, startBeat: beat, beats: 1, position }
      addMarker(note, state)
    }
    const pixelRatio = Math.min(2, globalThis.devicePixelRatio || 1)
    const clusters: FrettedMarker[][] = []
    for (const marker of markers) {
      const cluster = clusters.find((items) => items.some((other) =>
        other.position.string !== marker.position.string &&
        Math.hypot(other.anchorX - marker.anchorX, other.anchorY - marker.anchorY) < 26 * pixelRatio))
      if (cluster) cluster.push(marker)
      else clusters.push([marker])
    }
    for (const cluster of clusters.filter((items) => items.length > 1)) {
      cluster.sort((a, b) => a.anchorY - b.anchorY)
      const centerY = cluster.reduce((sum, marker) => sum + marker.anchorY, 0) / cluster.length
      cluster.forEach((marker, index) => { marker.y = centerY + (index - (cluster.length - 1) / 2) * 28 * pixelRatio })
    }
    const [nutX, nutY] = this.projected([this.config.scaleLength, 0, 0.058], width, height)
    const labelX = Math.max(40 * pixelRatio, Math.min(width - 40 * pixelRatio,
      nutX + (handedness === 'right' ? -1 : 1) * 48 * pixelRatio))
    const labelGap = 20 * pixelRatio
    const labelHalf = (this.config.strings.length - 1) * labelGap / 2
    const labelY = Math.min(height - 50 * pixelRatio - labelHalf, Math.max(46 * pixelRatio + labelHalf, nutY))
    const stringLabels = this.config.strings.map((string) => {
      return { string: string.string, name: `${string.conventionalStringNumber} · ${string.name}`,
        x: labelX, y: labelY - labelHalf + (string.string - 1) * labelGap }
    })
    const fretLabels: FrettedFretLabel[] = []
    for (const fret of [12, 3, 5, 7, 9, 15, 17, 19, 21]) {
      if (fret > this.config.frets) continue
      const x = this.config.scaleLength - this.config.scaleLength * (1 - 2 ** (-fret / 12))
      const [px, py] = this.projected([x, 0.038, 0.058], width, height)
      if (fretLabels.every((label) => Math.abs(label.x - px) >= 24 * pixelRatio))
        fretLabels.push({ fret, x: px, y: py })
    }
    fretLabels.sort((a, b) => a.fret - b.fret)
    return { markers, stringLabels, fretLabels, stringCues, plucks, vibrations, triangles }
  }

  dispose() {
    const gl = this.gl
    for (const buffer of this.buffers) { gl.deleteBuffer(buffer.vertex); gl.deleteBuffer(buffer.index) }
    for (const texture of this.textures) gl.deleteTexture(texture)
    gl.deleteProgram(this.program)
    this.items = []
    this.buffers.length = 0
    this.textures.length = 0
  }
}
