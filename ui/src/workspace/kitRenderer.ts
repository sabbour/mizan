import type { HatState } from './kit'
import type { Item, Prepared, Target, Vec3 } from './kitAsset'
import type { Look } from './prefs'

/**
 * WebGL renderer for a prepared kit. One program serves every look: the look picks the shading model (PBR,
 * painted clay, neon, blueprint) and the extra passes (outline, transparency, glow halo). The hit feedback is the
 * same for every look and comes from `Feedback`.
 */

/** Per piece, from the shared playback clock: an upcoming note's glow, the hit pulse, and time since the hit. */
export type Feedback = {
  /** 0..1, rises as the next note on this piece approaches. */
  upcoming: number
  upcomingTint: Vec3
  /** 0..1, the bright pulse of the latest hit, decaying. */
  pulse: number
  /** Colour of the latest hit; with `split`, the left half takes `tint` and the right half `tint2` (both hands). */
  tint: Vec3
  tint2: Vec3
  split: boolean
  /** Seconds since the latest hit (for wobble and presses); large when there is none. */
  since: number
  /** Note strength 0..1 (ghost notes are quieter). */
  velocity: number
}
export type FrameState = { hat: HatState; feedback: Map<Target, Feedback>; selected: ReadonlySet<Target> }

const LOOK_INDEX: Record<Look, number> = { Realistic: 0, ClayStudyModel: 1, NeonRhythm: 2, TechnicalBlueprint: 3 }
/** Background and floor tone per look; the neon stage is dark for contrast. Blueprint outlines its translucent parts too. */
const STAGE: Record<Look, { bg: Vec3; floor: Vec3; shadow: number; ink?: Vec3; inkWidth?: number; inkAll?: boolean }> = {
  Realistic: { bg: [1, 1, 1], floor: [0.91, 0.91, 0.915], shadow: 0.075 },
  ClayStudyModel: { bg: [1, 0.988, 0.962], floor: [0.95, 0.92, 0.85], shadow: 0.1, ink: [0.36, 0.27, 0.21], inkWidth: 0.0016 },
  NeonRhythm: { bg: [0.035, 0.035, 0.05], floor: [0.06, 0.06, 0.08], shadow: 0.12 },
  TechnicalBlueprint: { bg: [0.93, 0.95, 0.98], floor: [0.88, 0.91, 0.96], shadow: 0.03, ink: [0.1, 0.2, 0.42], inkWidth: 0.0012, inkAll: true },
}
export const stageBackground = (look: Look) => STAGE[look].bg

const SUNS = [[0.22, 1, 0.12], [0.3, 1, 0.2], [0.14, 1, 0.22]].map((v) => { const l = Math.hypot(...v); return v.map((x) => x / l) })

const VERTEX = `attribute vec3 p; attribute vec3 n; attribute vec2 uv; attribute vec4 tg;
uniform mat4 m; uniform mat4 vp; uniform float grow; uniform vec3 sun; uniform float flatten;
varying vec3 vn; varying vec3 wp; varying vec2 vuv; varying vec3 vt; varying float vw; varying vec3 lp;
void main() {
  vec4 w = m * vec4(p + n * grow, 1.0);
  if (flatten > 0.0) { w.xyz -= sun * (w.y / sun.y); w.y = 0.002; }
  wp = w.xyz; vn = mat3(m) * n; vt = mat3(m) * tg.xyz; vw = tg.w; vuv = uv; lp = p;
  gl_Position = vp * w;
}`

const FRAGMENT = `#extension GL_OES_standard_derivatives : enable
precision highp float;
uniform vec4 baseColor; uniform float metal; uniform float rough; uniform vec3 emissive; uniform float normalScale;
uniform sampler2D baseTex; uniform sampler2D ormTex; uniform sampler2D normalTex; uniform sampler2D emisTex;
uniform float hasBase; uniform float hasOrm; uniform float hasNormal; uniform float hasEmis;
uniform float look; uniform vec3 eye; uniform float flatten; uniform float shadowAlpha; uniform float floorPass; uniform vec3 floorColor; uniform vec3 bg;
uniform float ink; uniform vec3 inkColor; uniform float halo; uniform float alpha;
uniform float pulse; uniform vec3 tint; uniform vec3 tint2; uniform float split; uniform float upcoming; uniform vec3 upTint;
varying vec3 vn; varying vec3 wp; varying vec2 vuv; varying vec3 vt; varying float vw; varying vec3 lp;
float bands(float x, float steps) { float s = x * steps; return (floor(s) + smoothstep(0.35, 0.65, fract(s))) / steps; }
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
void main() {
  if (flatten > 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, shadowAlpha); return; }
  if (floorPass > 0.0) {
    float d = length(wp.xz - vec2(0.05, -0.1));
    gl_FragColor = vec4(mix(floorColor, bg, smoothstep(0.6, 2.4, d)), 1.0);
    return;
  }
  vec3 V = normalize(eye - wp);
  vec3 N = normalize(vn);
  // Surface curvature on screen: large where a rim, bevel or edge turns sharply (blueprint draws these as lines).
  float crease = length(fwidth(N));
  if (look > 0.5 && look < 1.5) {
    // Painted clay: a little of each facet's flat normal, for a hand-modelled surface.
    vec3 facet = normalize(cross(dFdx(wp), dFdy(wp)));
    if (dot(facet, N) < 0.0) facet = -facet;
    N = normalize(mix(N, facet, 0.18));
  }
  if (ink > 0.0) {
    if (dot(N, V) > 0.0) discard;
    gl_FragColor = vec4(inkColor, 1.0);
    return;
  }
  vec3 hitColour = split > 0.5 && lp.x > 0.0 ? tint2 : tint;
  if (halo > 0.0) {
    // A soft additive halo outside the silhouette of a lit piece.
    if (dot(N, V) > 0.0) discard;
    float edge = pow(1.0 - abs(dot(N, V)), 1.5);
    gl_FragColor = vec4(hitColour * pulse * halo * edge + upTint * upcoming * halo * 0.5 * edge, 1.0);
    return;
  }
  if (dot(N, V) < 0.0) N = -N;
  vec4 texel = hasBase > 0.5 ? texture2D(baseTex, vuv) : vec4(1.0);
  vec3 base = baseColor.rgb * texel.rgb;
  float ao = 1.0, r = rough, mt = metal;
  if (hasOrm > 0.5) { vec3 orm = texture2D(ormTex, vuv).rgb; ao = orm.r; r *= orm.g; mt *= orm.b; }
  if (hasNormal > 0.5 && look < 0.5) {
    vec3 T = normalize(vt - N * dot(N, vt));
    vec3 B = cross(N, T) * vw;
    vec3 t = texture2D(normalTex, vuv).xyz * 2.0 - 1.0;
    t.xy *= normalScale;
    N = normalize(T * t.x + B * t.y + N * t.z);
  }
  vec3 key = normalize(vec3(0.35, 1.0, 0.6));
  vec3 fill = normalize(vec3(-0.75, 0.45, 0.25));
  vec3 rim = normalize(vec3(0.15, 0.55, -1.0));
  float k = max(dot(N, key), 0.0), f = max(dot(N, fill), 0.0), rl = max(dot(N, rim), 0.0);
  float facing = max(dot(N, V), 0.0);
  float occlusion = mix(0.6, 1.0, smoothstep(0.0, 0.45, wp.y)) * ao;
  vec3 col;
  float a = alpha;
  if (look < 0.5) {
    float shine = mix(220.0, 3.0, pow(r, 0.6));
    vec3 F0 = mix(vec3(0.04), base, mt);
    vec3 F = F0 + (vec3(1.0) - F0) * pow(1.0 - facing, 5.0) * (1.0 - r * 0.8);
    float norm = (shine + 8.0) / 25.0;
    float spec = (pow(max(dot(N, normalize(key + V)), 0.0), shine) + 0.3 * pow(max(dot(N, normalize(fill + V)), 0.0), shine) + 0.6 * pow(max(dot(N, normalize(rim + V)), 0.0), shine)) * norm;
    vec3 R = reflect(-V, N);
    vec3 env = R.y > 0.0 ? mix(vec3(0.8, 0.81, 0.83), vec3(1.0), sqrt(R.y)) : mix(vec3(0.8), vec3(0.32, 0.31, 0.3), min(1.0, -R.y * 3.0));
    env += vec3(2.2) * smoothstep(0.9, 0.975, dot(R, normalize(vec3(0.3, 0.8, 0.52))));
    env += vec3(1.0) * smoothstep(0.93, 0.985, dot(R, normalize(vec3(-0.7, 0.45, 0.55))));
    env = mix(env, vec3(0.72), r * r);
    vec3 ambient = mix(vec3(0.34, 0.33, 0.32), vec3(0.62, 0.64, 0.68), 0.5 + 0.5 * N.y) * occlusion;
    vec3 diffuse = base * (ambient + vec3(1.0, 0.97, 0.92) * k * 0.85 + vec3(0.82, 0.88, 1.0) * f * 0.3 + rl * 0.15);
    col = diffuse * (1.0 - mt) + env * F * occlusion * mix(0.6, 1.0, mt) + spec * F;
    col = vec3(1.0) - exp(-col * 1.15);
  } else if (look < 1.5) {
    // Hand-painted clay: matte clay forms under a warm painted light. Soft toon bands between a cool violet shade
    // and warm cream light, a slow painted drift in tone across each part, a soft highlight and a warm sky rim.
    float wrap = clamp(dot(N, key) * 0.55 + 0.45 + f * 0.12, 0.0, 1.0);
    float light = mix(wrap, bands(wrap, 3.0), 0.6);
    float wash = noise(lp * 9.0) * 0.65 + noise(lp * 23.0) * 0.35;
    vec3 paint = base * (0.93 + 0.14 * wash) * mix(vec3(1.0), vec3(1.05, 1.0, 0.9), wash * 0.5);
    col = paint * mix(vec3(0.5, 0.48, 0.62), vec3(1.07, 1.0, 0.87), light) * mix(0.72, 1.0, occlusion);
    col += vec3(1.0, 0.95, 0.82) * smoothstep(0.88, 0.96, dot(N, normalize(key + V))) * 0.1;
    col += vec3(1.0, 0.9, 0.74) * pow(1.0 - facing, 3.0) * 0.14 * light;
  } else if (look < 2.5) {
    // Neon: dark metal lit by cool rims; colour only from emission.
    float spec = pow(max(dot(N, normalize(key + V)), 0.0), 40.0) * 0.35;
    col = base * (0.25 + 0.35 * k) + spec * vec3(0.7, 0.75, 0.9) + vec3(0.25, 0.3, 0.45) * pow(1.0 - facing, 3.0) * 0.6;
  } else {
    // Blueprint: flat blue-gray fills with drawn lines where surfaces turn sharply (rims, bevels, edges).
    col = base * (0.82 + 0.18 * k) + vec3(0.75, 0.85, 1.0) * pow(1.0 - facing, 2.5) * 0.3;
    float line = smoothstep(0.18, 0.45, crease);
    col = mix(col, inkColor, line * 0.85);
    a = max(a, line * 0.8);
  }
  vec3 glowE = emissive * (hasEmis > 0.5 ? texture2D(emisTex, vuv).rgb : vec3(1.0));
  col += glowE;
  // Shared feedback: the hit pulse floods the surface with its colour; an upcoming note lights its edge.
  float edge = 0.25 + 0.75 * pow(1.0 - facing, 2.0);
  col = mix(col, hitColour, clamp(pulse * 0.75, 0.0, 0.85)) + hitColour * pulse * 0.25;
  col += upTint * upcoming * edge * 0.55;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), a);
}`

const SHADOW_FRAGMENT_PRELUDE = ''
void SHADOW_FRAGMENT_PRELUDE

type GL = WebGLRenderingContext
type Uploaded = Item & { vbo: WebGLBuffer; ibo: WebGLBuffer; count: number }

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
const mul = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return out
}
const translateY = (y: number) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, y, 0, 1])
const rotX = (a: number) => { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]) }
const rotZ = (a: number) => { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) }
const HAT_OFFSET: Record<HatState, string> = { closed: 'closed', pedal: 'pedalClosed', 'half-open': 'partiallyOpen', open: 'fullyOpen' }

/** The local motion of a part for its piece's feedback: press, wobble, hat travel or swing. */
export function motionMatrix(item: Pick<Item, 'motion' | 'angle' | 'target'>, fb: Feedback | undefined, hatOffset: number): Float32Array {
  const since = fb?.since ?? 99
  const strength = fb ? 0.4 + 0.6 * fb.velocity : 0
  const decay = Math.exp(-since * 6)
  switch (item.motion) {
    case 'head': return translateY(-0.004 * strength * Math.exp(-since * 22))
    case 'cymbal': {
      const a = 0.07 * strength * decay
      return mul(rotX(a * Math.sin(since * 26)), rotZ(a * 0.6 * Math.sin(since * 26 + 1.3)))
    }
    case 'hat': return mul(translateY(hatOffset), rotX(0.025 * strength * decay * Math.sin(since * 30)))
    case 'pedal': return rotX(-(item.angle ?? 0.15) * Math.exp(-since * 14) * (fb ? 1 : 0))
    case 'beater': {
      // Pulled back as the note approaches, through the head at the hit, then settling.
      const back = 0.5 * (fb?.upcoming ?? 0) * (1 - Math.exp(-since * 30))
      return rotX(back)
    }
    default: return IDENTITY
  }
}

export class KitRenderer {
  private gl: GL
  private program: WebGLProgram
  private shaders: WebGLShader[]
  private at: Record<string, WebGLUniformLocation | null>
  private attrs: number[]
  private items: Uploaded[] = []
  private floor: { vbo: WebGLBuffer; ibo: WebGLBuffer; count: number }
  private textures = new Map<number, WebGLTexture>()
  private white: WebGLTexture
  private indexUint: boolean
  private prepared: Prepared | null = null
  private look: Look = 'Realistic'
  view = new Float32Array(16)
  eye: number[] = [0, 1, 2]

  constructor(gl: GL) {
    this.gl = gl
    gl.getExtension('OES_standard_derivatives')
    this.indexUint = !!gl.getExtension('OES_element_index_uint')
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader did not compile')
      return shader
    }
    this.shaders = [compile(gl.VERTEX_SHADER, VERTEX), compile(gl.FRAGMENT_SHADER, FRAGMENT)]
    this.program = gl.createProgram()!
    for (const shader of this.shaders) gl.attachShader(this.program, shader)
    gl.linkProgram(this.program)
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program) ?? 'Program did not link')
    gl.useProgram(this.program)
    this.attrs = ['p', 'n', 'uv', 'tg'].map((name) => gl.getAttribLocation(this.program, name))
    this.at = Object.fromEntries(['m', 'vp', 'grow', 'sun', 'flatten', 'baseColor', 'metal', 'rough', 'emissive', 'normalScale', 'baseTex', 'ormTex', 'normalTex', 'emisTex',
      'hasBase', 'hasOrm', 'hasNormal', 'hasEmis', 'look', 'eye', 'shadowAlpha', 'floorPass', 'floorColor', 'bg', 'ink', 'inkColor', 'halo', 'alpha',
      'pulse', 'tint', 'tint2', 'split', 'upcoming', 'upTint'].map((name) => [name, gl.getUniformLocation(this.program, name)]))
    gl.uniform1i(this.at.baseTex, 0); gl.uniform1i(this.at.ormTex, 1); gl.uniform1i(this.at.normalTex, 2); gl.uniform1i(this.at.emisTex, 3)
    this.white = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.white)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255]))
    // The floor: a disc that fades into the page.
    const disc: number[] = [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1], idx: number[] = []
    for (let i = 0; i <= 64; i++) { const a = (i / 64) * Math.PI * 2; disc.push(Math.cos(a) * 3.2, 0, Math.sin(a) * 3.2, 0, 1, 0, 0, 0, 1, 0, 0, 1); if (i) idx.push(0, i + 1, i) }
    this.floor = this.upload(new Float32Array(disc), new Uint32Array(idx))
    gl.enable(gl.DEPTH_TEST)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  }

  private upload(data: Float32Array, index: Uint32Array) {
    const gl = this.gl
    const vbo = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    const ibo = gl.createBuffer()!
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indexUint ? index : new Uint16Array(index), gl.STATIC_DRAW)
    return { vbo, ibo, count: index.length }
  }

  /** Replaces the drawn kit (a new look or kit); textures already uploaded for this kit are kept. */
  setScene(prepared: Prepared, look: Look, images: (ImageBitmap | null)[]) {
    const gl = this.gl
    for (const item of this.items) { gl.deleteBuffer(item.vbo); gl.deleteBuffer(item.ibo) }
    this.items = prepared.items.map((item) => ({ ...item, ...this.upload(item.data, item.index) }))
    this.prepared = prepared
    this.look = look
    for (const item of prepared.items) for (const index of [item.material.baseTex, item.material.ormTex, item.material.normalTex, item.material.emissiveTex]) {
      if (index < 0 || this.textures.has(index) || !images[index]) continue
      const texture = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, images[index]!)
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic')
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4)
      this.textures.set(index, texture)
    }
  }

  /** Forgets textures (when the kit type changes). */
  clearTextures() {
    for (const texture of this.textures.values()) this.gl.deleteTexture(texture)
    this.textures.clear()
  }

  private bind(buffers: { vbo: WebGLBuffer; ibo: WebGLBuffer }) {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.vbo)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.ibo)
    const sizes = [3, 3, 2, 4], offsets = [0, 12, 24, 32]
    this.attrs.forEach((location, i) => {
      if (location < 0) return
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, sizes[i], gl.FLOAT, false, 48, offsets[i])
    })
  }
  private elements(count: number) { this.gl.drawElements(this.gl.TRIANGLES, count, this.indexUint ? this.gl.UNSIGNED_INT : this.gl.UNSIGNED_SHORT, 0) }

  private material(item: Uploaded) {
    const gl = this.gl, m = item.material
    gl.uniform4fv(this.at.baseColor, m.base)
    gl.uniform1f(this.at.metal, m.metal)
    gl.uniform1f(this.at.rough, m.rough)
    gl.uniform3fv(this.at.emissive, m.emissive)
    gl.uniform1f(this.at.normalScale, m.normalScale)
    const slots: [number, string][] = [[m.baseTex, 'hasBase'], [m.ormTex, 'hasOrm'], [m.normalTex, 'hasNormal'], [m.emissiveTex, 'hasEmis']]
    slots.forEach(([index, flag], unit) => {
      const texture = index >= 0 ? this.textures.get(index) : undefined
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, texture ?? this.white)
      gl.uniform1f(this.at[flag], texture ? 1 : 0)
    })
  }

  private feedbackUniforms(fb: Feedback | undefined, glows: boolean) {
    const gl = this.gl
    const on = glows && fb
    gl.uniform1f(this.at.pulse, on ? fb.pulse : 0)
    gl.uniform3fv(this.at.tint, on ? fb.tint : [0, 0, 0])
    gl.uniform3fv(this.at.tint2, on ? fb.tint2 : [0, 0, 0])
    gl.uniform1f(this.at.split, on && fb.split ? 1 : 0)
    gl.uniform1f(this.at.upcoming, on ? fb.upcoming : 0)
    gl.uniform3fv(this.at.upTint, on ? fb.upcomingTint : [0, 0, 0])
  }

  draw(width: number, height: number, state: FrameState) {
    const gl = this.gl
    const prepared = this.prepared
    if (!prepared) return
    const look = this.look
    const stage = STAGE[look]
    const hatOffset = prepared.hatStates[HAT_OFFSET[state.hat]] ?? 0
    gl.viewport(0, 0, width, height)
    gl.clearColor(stage.bg[0], stage.bg[1], stage.bg[2], 1)
    gl.clearStencil(0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
    gl.useProgram(this.program)
    gl.uniformMatrix4fv(this.at.vp, false, this.view)
    gl.uniform3fv(this.at.eye, this.eye)
    gl.uniform1f(this.at.look, LOOK_INDEX[look])
    gl.uniform3fv(this.at.bg, stage.bg)
    gl.uniform3fv(this.at.inkColor, stage.ink ?? [0, 0, 0])
    for (const name of ['flatten', 'floorPass', 'ink', 'halo', 'grow']) gl.uniform1f(this.at[name], 0)
    gl.uniform1f(this.at.alpha, 1)
    this.feedbackUniforms(undefined, false)
    const model = (item: Uploaded) => item.motion ? mul(item.frame, motionMatrix(item, item.target ? state.feedback.get(item.target) : undefined, hatOffset)) : item.frame

    // Floor, then soft planar shadows (each light direction shades a floor pixel once).
    gl.depthMask(false)
    this.bind(this.floor)
    gl.uniformMatrix4fv(this.at.m, false, IDENTITY)
    gl.uniform1f(this.at.floorPass, 1)
    gl.uniform3fv(this.at.floorColor, stage.floor)
    this.elements(this.floor.count)
    gl.uniform1f(this.at.floorPass, 0)
    gl.enable(gl.BLEND)
    gl.enable(gl.STENCIL_TEST)
    gl.uniform1f(this.at.flatten, 1)
    gl.uniform1f(this.at.shadowAlpha, stage.shadow)
    SUNS.forEach((sun, index) => {
      // Each light direction marks the floor pixels it shades with its own stencil value, so no pixel is darkened
      // twice by one light, without clearing the stencil between lights.
      gl.stencilFunc(gl.NOTEQUAL, index + 1, 0xff)
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE)
      gl.uniform3fv(this.at.sun, sun)
      for (const item of this.items) { this.bind(item); gl.uniformMatrix4fv(this.at.m, false, model(item)); this.elements(item.count) }
    })
    gl.disable(gl.STENCIL_TEST)
    gl.uniform1f(this.at.flatten, 0)
    gl.disable(gl.BLEND)
    gl.depthMask(true)

    // Blueprint: selected or active pieces are opaque; the rest is drawn translucent after the opaque pass.
    const active = (item: Uploaded) => !!item.target && (state.selected.has(item.target) || ((state.feedback.get(item.target)?.pulse ?? 0) + (state.feedback.get(item.target)?.upcoming ?? 0) > 0.05))
    const translucent = (item: Uploaded) => item.material.blend && !active(item)
    for (const item of this.items) {
      if (translucent(item)) continue
      this.bind(item)
      this.material(item)
      gl.uniformMatrix4fv(this.at.m, false, model(item))
      this.feedbackUniforms(item.target ? state.feedback.get(item.target) : undefined, item.glows)
      gl.uniform1f(this.at.alpha, 1)
      this.elements(item.count)
    }
    this.feedbackUniforms(undefined, false)
    const outline = (item: Uploaded) => {
      gl.uniform1f(this.at.ink, 1)
      gl.uniform1f(this.at.grow, stage.inkWidth!)
      this.elements(item.count)
      gl.uniform1f(this.at.ink, 0)
      gl.uniform1f(this.at.grow, 0)
    }
    if (stage.ink) for (const item of this.items) {
      if (translucent(item)) continue
      this.bind(item)
      gl.uniformMatrix4fv(this.at.m, false, model(item))
      outline(item)
    }
    const glass = this.items.filter(translucent)
    if (glass.length) {
      const distance = (item: Uploaded) => { const c = item.frame === IDENTITY ? prepared.center : item.center; return -Math.hypot(c[0] - this.eye[0], c[1] - this.eye[1], c[2] - this.eye[2]) }
      for (const item of glass.sort((a, b) => distance(a) - distance(b))) {
        this.bind(item)
        gl.uniformMatrix4fv(this.at.m, false, model(item))
        if (stage.inkAll) {
          // The part's own depth first, so its outline shows only around its silhouette, not through its faint fill.
          gl.colorMask(false, false, false, false)
          this.elements(item.count)
          gl.colorMask(true, true, true, true)
          outline(item)
          gl.depthFunc(gl.LEQUAL)
        }
        gl.enable(gl.BLEND)
        gl.depthMask(!!stage.inkAll)
        this.material(item)
        gl.uniform1f(this.at.alpha, item.material.base[3])
        this.elements(item.count)
        gl.depthMask(true)
        gl.disable(gl.BLEND)
        gl.depthFunc(gl.LESS)
      }
      gl.uniform1f(this.at.alpha, 1)
    }
    // Glow halo around pieces that are lit by the feedback, for every look.
    const lit = this.items.filter((item) => item.glows && item.target && ((state.feedback.get(item.target)?.pulse ?? 0) > 0.02 || (state.feedback.get(item.target)?.upcoming ?? 0) > 0.05))
    if (lit.length) {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE)
      gl.depthMask(false)
      gl.uniform1f(this.at.halo, look === 'NeonRhythm' ? 1.4 : 0.7)
      gl.uniform1f(this.at.grow, look === 'NeonRhythm' ? 0.012 : 0.007)
      for (const item of lit) {
        this.bind(item)
        gl.uniformMatrix4fv(this.at.m, false, model(item))
        this.feedbackUniforms(state.feedback.get(item.target!), true)
        this.elements(item.count)
      }
      gl.uniform1f(this.at.halo, 0)
      gl.uniform1f(this.at.grow, 0)
      gl.depthMask(true)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
      gl.disable(gl.BLEND)
      this.feedbackUniforms(undefined, false)
    }
  }

  dispose() {
    const gl = this.gl
    for (const item of this.items) { gl.deleteBuffer(item.vbo); gl.deleteBuffer(item.ibo) }
    gl.deleteBuffer(this.floor.vbo); gl.deleteBuffer(this.floor.ibo)
    this.clearTextures()
    gl.deleteTexture(this.white)
    gl.deleteProgram(this.program)
    for (const shader of this.shaders) gl.deleteShader(shader)
    this.items = []
  }
}
