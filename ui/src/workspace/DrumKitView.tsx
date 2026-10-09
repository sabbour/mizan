import { useEffect, useMemo, useRef, useState } from 'react'
import type { Engine } from './engine'
import { useFrame, useReducedMotion } from './hooks'
import { HAT_LABEL, KIT_PIECES, kitStrike, type HatState, type KitPiece } from './kit'
import type { Song } from './song'
import type { Hand, Sticking } from './sticking'
import { KIT_STYLES, type KitStyle } from './prefs'

type Props = {
  song: Song; engine: Engine
  /** Hands for the strokes; undefined when the sticking letters are off. */
  sticking?: Sticking
  /** How the kit looks; a view choice only. */
  style: KitStyle
  onStyle: (style: KitStyle) => void
}
/** Glow targets: kit pieces plus the hi-hat foot pedal (the kick pedal follows the kick). */
type Target = KitPiece | 'hatPedal'
type Material = { color: [number, number, number]; spec: number; shine: number }
type Part = { target: Target | null; mesh: Float32Array; model: Float32Array; material: Material; hatTop?: boolean; shadow?: number }
type Strike = { beat: number; velocity: number; specified: boolean; hand?: Hand | 'both' }

/** A hit glows for half a beat, fading; reduced motion shows a steady quarter-beat mark instead. */
const DECAY = 0.5
const MAX_GLOW = 0.7
/** A strike whose source names only a generic lane lights its whole family this much less. */
const FAMILY = 0.45
/** Glow colours: the existing teal for strokes without a hand (and feet), blue for the left hand, orange for the right. */
const TINT: Record<Hand | 'both' | 'none', [number, number, number]> = {
  none: [0.05, 0.48, 0.39], both: [0.05, 0.48, 0.39], left: [0.11, 0.36, 0.71], right: [0.85, 0.38, 0.05],
}
const HAT_LIFT: Record<HatState, number> = { closed: 0, pedal: 0, 'half-open': 0.024, open: 0.06 }

// Column-major 4x4 matrices.
const multiply = (a: Float32Array, b: Float32Array) => {
  const out = new Float32Array(16)
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k]
  return out
}
const chain = (...matrices: Float32Array[]) => matrices.reduce(multiply)
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
const translate = (x: number, y: number, z: number) => { const m = identity(); m[12] = x; m[13] = y; m[14] = z; return m }
const rotateX = (angle: number) => {
  const m = identity(); const c = Math.cos(angle); const s = Math.sin(angle)
  m[5] = c; m[6] = s; m[9] = -s; m[10] = c
  return m
}
const rotateY = (angle: number) => {
  const m = identity(); const c = Math.cos(angle); const s = Math.sin(angle)
  m[0] = c; m[2] = -s; m[8] = s; m[10] = c
  return m
}
const rotateZ = (angle: number) => {
  const m = identity(); const c = Math.cos(angle); const s = Math.sin(angle)
  m[0] = c; m[1] = s; m[4] = -s; m[5] = c
  return m
}
const perspective = (fov: number, aspect: number, near: number, far: number) => {
  const f = 1 / Math.tan(fov / 2)
  const m = new Float32Array(16)
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1; m[14] = 2 * far * near / (near - far)
  return m
}
const normalize = (v: number[]) => { const l = Math.hypot(...v); return v.map((value) => value / l) }
const lookAt = (eye: number[], target: number[]) => {
  const sub = (a: number[], b: number[]) => a.map((value, index) => value - b[index])
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const z = normalize(sub(eye, target))
  const x = normalize(cross([0, 1, 0], z))
  const y = cross(z, x)
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1])
}

/**
 * Turns a (radius, height) profile around the Y axis into triangles with interleaved position and normal.
 * Normals are perpendicular to each profile segment, so shells, heads, rims and cymbal bells all shade correctly.
 */
function lathe(profile: [number, number][], segments = 48): Float32Array {
  const out: number[] = []
  for (let k = 0; k + 1 < profile.length; k++) {
    const [r0, y0] = profile[k]
    const [r1, y1] = profile[k + 1]
    const [nr, ny] = normalize([y1 - y0, -(r1 - r0)])
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2
      const b = ((i + 1) / segments) * Math.PI * 2
      const point = (r: number, y: number, angle: number) =>
        out.push(r * Math.cos(angle), y, r * Math.sin(angle), nr * Math.cos(angle), ny, nr * Math.sin(angle))
      point(r0, y0, a); point(r0, y0, b); point(r1, y1, b)
      point(r0, y0, a); point(r1, y1, b); point(r1, y1, a)
    }
  }
  return new Float32Array(out)
}
const ring = (radius: number, y: number, tube: number) =>
  lathe(Array.from({ length: 9 }, (_, i) => {
    const angle = (i / 8) * Math.PI * 2
    return [radius + tube * Math.cos(angle), y + tube * Math.sin(angle)] as [number, number]
  }), 48)
const rod = (radius: number, length: number) => lathe([[radius, 0], [radius, length]], 12)
const disc = (radius: number, y = 0) => lathe([[0, y], [radius, y]], 48)


type Palette = { shell: Material; head: Material; resonant: Material; hoop: Material; cymbal: Material; metal: Material }
const PALETTES: Record<KitStyle, Palette> = {
  // Wood shells, coated heads, bronze cymbals and chrome hardware.
  acoustic: {
    shell: { color: [0.46, 0.21, 0.1], spec: 0.55, shine: 48 }, head: { color: [0.93, 0.92, 0.88], spec: 0.08, shine: 8 },
    resonant: { color: [0.62, 0.6, 0.56], spec: 0.05, shine: 8 }, hoop: { color: [0.66, 0.68, 0.71], spec: 0.9, shine: 64 },
    cymbal: { color: [0.74, 0.58, 0.28], spec: 0.75, shine: 36 }, metal: { color: [0.66, 0.68, 0.71], spec: 0.9, shine: 64 },
  },
  // Shallow pads with light mesh heads and rubber hoops, black rubber cymbals, a black tubular rack.
  electronic: {
    shell: { color: [0.1, 0.1, 0.11], spec: 0.25, shine: 24 }, head: { color: [0.86, 0.87, 0.87], spec: 0.03, shine: 4 },
    resonant: { color: [0.1, 0.1, 0.11], spec: 0.1, shine: 8 }, hoop: { color: [0.14, 0.14, 0.15], spec: 0.2, shine: 16 },
    cymbal: { color: [0.11, 0.11, 0.12], spec: 0.3, shine: 20 }, metal: { color: [0.17, 0.17, 0.18], spec: 0.55, shine: 32 },
  },
  // The acoustic kit drawn like an illustration: warm painted finishes, faceted shapes, banded light and dark outlines.
  illustrated: {
    shell: { color: [0.78, 0.4, 0.17], spec: 0.15, shine: 8 }, head: { color: [0.97, 0.93, 0.82], spec: 0.05, shine: 8 },
    resonant: { color: [0.82, 0.72, 0.58], spec: 0.05, shine: 8 }, hoop: { color: [0.78, 0.75, 0.7], spec: 0.3, shine: 16 },
    cymbal: { color: [0.93, 0.72, 0.3], spec: 0.3, shine: 16 }, metal: { color: [0.64, 0.62, 0.6], spec: 0.3, shine: 16 },
  },
}
const STYLE_LABEL: Record<KitStyle, string> = { electronic: 'Electronic', acoustic: 'Acoustic', illustrated: 'Illustrated acoustic' }
/** Outline width for the illustrated style, in kit units. */
const INK = 0.006
const CHROME: Material = { color: [0.66, 0.68, 0.71], spec: 0.9, shine: 64 }
const RUBBER: Material = { color: [0.12, 0.12, 0.13], spec: 0.1, shine: 8 }
const SCREEN: Material = { color: [0.24, 0.48, 0.86], spec: 0.4, shine: 32 }

/**
 * Code-generated five-piece kit seen from behind the throne: two rack toms, one floor tom, pedals and stands. Both styles
 * place every piece in the same spot, so a hit lights the same surface whichever look is chosen.
 */
function kitParts(style: KitStyle): Part[] {
  const electronic = style === 'electronic'
  // Fewer sides give the illustrated kit its faceted, hand-drawn look.
  const sides = style === 'illustrated' ? 16 : 48
  const { shell, head, resonant, hoop, cymbal: bronze, metal } = PALETTES[style]
  const parts: Part[] = []
  const add = (target: Target | null, mesh: Float32Array, model: Float32Array, material: Material, extra: Partial<Part> = {}) =>
    parts.push({ target, mesh, model, material, ...extra })
  const shadow = (x: number, z: number, radius: number) =>
    add(null, disc(radius, 0.002), translate(x, 0, z), RUBBER, { shadow: radius })
  const legs = (x: number, z: number, top: number, spread = 0.22) => {
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2 + 0.5
      const tilt = Math.atan2(spread, top)
      add(null, rod(0.007, Math.hypot(spread, top)), chain(translate(x, 0, z), rotateY(angle), translate(spread, 0, 0), rotateZ(tilt)), metal)
    }
  }
  /** A bar from (x0, y, z) to (x1, y, z). */
  const bar = (x0: number, x1: number, y: number, z: number) => add(null, rod(0.016, x1 - x0), chain(translate(x0, y, z), rotateZ(-Math.PI / 2)), metal)
  const drum = (target: KitPiece, radius: number, depth: number, at: [number, number, number], pose: Float32Array) => {
    const model = chain(translate(...at), pose)
    // Pads are shallow; acoustic shells keep their depth.
    const half = (electronic ? Math.min(depth, 0.07) : depth) / 2
    add(target, lathe([[radius, -half], [radius, half]], sides), model, shell)
    add(target, lathe([[0, half + 0.002], [radius * 0.99, half + 0.002]], sides), model, head)
    add(target, lathe([[0, -half - 0.002], [radius * 0.99, -half - 0.002]], sides), model, resonant)
    add(target, ring(radius + 0.004, half, electronic ? 0.012 : 0.007), model, hoop)
    if (!electronic) add(target, ring(radius + 0.004, -half, 0.007), model, hoop)
    return model
  }
  const cymbal = (target: KitPiece, radius: number, at: [number, number, number], pose: Float32Array, extra: Partial<Part> = {}) => {
    // Rubber cymbal pads are flatter than bronze.
    const rise = electronic ? 0.5 : 1
    const top: [number, number][] = [[0, 0.03 * rise], [radius * 0.1, 0.03 * rise], [radius * 0.2, 0.012 * rise], [radius, -0.01 * rise]]
    const model = chain(translate(...at), pose)
    add(target, lathe(top, sides), model, bronze, extra)
    add(target, lathe(top.map(([r, y]) => [r, y - 0.006] as [number, number]).reverse(), sides), model, bronze, extra)
  }
  const cymbalStand = (x: number, z: number, height: number) => {
    add(null, rod(0.009, height), translate(x, 0, z), metal)
    if (!electronic) legs(x, z, 0.26)
    shadow(x, z, 0.3)
  }

  if (electronic) {
    // Tubular rack: two side posts and a front bar carry the pads and cymbals.
    for (const [x, z] of [[-0.5, 0.06], [0.78, 0.06], [-0.5, -0.24], [0.78, -0.24]]) {
      add(null, rod(0.016, 0.82), translate(x, 0, z), metal)
      shadow(x, z, 0.12)
    }
    bar(-0.5, 0.78, 0.72, 0.06)
    bar(-0.5, 0.78, 0.72, -0.24)
    // Drum module on the left post, angled toward the player.
    const module = chain(translate(-0.56, 0.86, 0.14), rotateY(0.5), rotateX(1.15))
    add(null, lathe([[0.001, -0.012], [0.1, -0.012], [0.1, 0.012], [0.001, 0.012]], 4), chain(module, rotateY(Math.PI / 4)), RUBBER)
    add(null, lathe([[0.001, 0.013], [0.045, 0.013]], 4), chain(module, translate(0, 0, -0.02), rotateY(Math.PI / 4)), SCREEN)
  }
  // Kick: an acoustic bass drum on its side, or a small pad on a tower; either way a pedal and beater in front.
  const kickFront = electronic ? 0.07 : 0.2
  if (electronic) {
    drum('kick', 0.13, 0.05, [0.02, 0.3, 0.03], rotateX(Math.PI / 2))
    for (const x of [-0.07, 0.11]) add(null, rod(0.012, 0.3), translate(x, 0, 0.03), metal)
    add(null, lathe([[0.16, 0], [0.16, 0.02], [0, 0.02]], 4), chain(translate(0.02, 0, 0.03), rotateY(Math.PI / 4)), metal)
  } else drum('kick', 0.28, 0.4, [0.02, 0.3, 0.0], rotateX(Math.PI / 2))
  shadow(0.02, 0.0, electronic ? 0.22 : 0.42)
  add('kick', lathe([[0.06, 0], [0.06, 0.012], [0, 0.012]], 16), chain(translate(0.02, 0.012, kickFront + 0.22), rotateX(-0.25)), CHROME)
  add('kick', rod(0.005, 0.24), chain(translate(0.02, 0.06, kickFront + 0.12), rotateX(-0.5)), CHROME)
  add('kick', lathe([[0.001, -0.025], [0.025, -0.012], [0.025, 0.012], [0.001, 0.025]], 16), chain(translate(0.02, 0.27, kickFront + 0.015), rotateX(Math.PI / 2)), RUBBER)
  // Snare on its stand, tilted toward the player.
  drum('snare', 0.18, 0.14, [-0.34, 0.62, 0.36], rotateX(0.1))
  add(null, rod(0.008, 0.55), translate(-0.34, 0, 0.36), metal)
  legs(-0.34, 0.36, 0.2, 0.18)
  shadow(-0.34, 0.36, 0.28)
  // Two rack toms over the kick, the smaller one at the player's left.
  const racks: [KitPiece, number, number, [number, number, number], number][] = [
    ['tom1', 0.13, 0.16, [-0.16, 0.88, -0.02], 0.45],
    ['tom2', 0.145, 0.17, [0.18, 0.88, -0.02], 0.4],
  ]
  for (const [piece, radius, depth, at, tilt] of racks) {
    drum(piece, radius, depth, at, chain(rotateY(-at[0] * 0.5), rotateX(tilt)))
    if (electronic) add(null, rod(0.01, at[1] - 0.72), translate(at[0], 0.72, -0.02), metal)
    else add(null, rod(0.008, at[1] - 0.52), translate(at[0] * 0.75 + 0.01, 0.52, at[2] * 0.5), metal)
  }
  // One floor tom at the player's right: on legs, or held by the rack.
  for (const [piece, radius, depth, x, z] of [['floor', 0.2, 0.31, 0.6, 0.42]] as const) {
    drum(piece, radius, depth, [x, 0.48, z], rotateX(electronic ? 0.25 : 0.04))
    if (electronic) {
      add(null, rod(0.01, 0.38), translate(x, 0.1, z - 0.04), metal)
      add(null, rod(0.01, 0.4), chain(translate(x, 0.48, z - 0.04), rotateX(-Math.PI / 2 - 0.2)), metal)
    } else {
      for (let i = 0; i < 3; i++) {
        const angle = (i / 3) * Math.PI * 2 + 0.3
        add(null, rod(0.008, 0.36), chain(translate(x + Math.cos(angle) * (radius + 0.03), 0, z + Math.sin(angle) * (radius + 0.03)), rotateZ(Math.cos(angle) * 0.08)), metal)
      }
    }
    shadow(x, z, radius + 0.12)
  }
  // Hi-hat: fixed bottom cymbal, top cymbal on the clutch (lifted by the hat state), foot pedal.
  const hat: [number, number, number] = [-0.72, 0.9, 0.3]
  add(null, rod(0.009, hat[1] + 0.12), translate(hat[0], 0, hat[2]), metal)
  legs(hat[0], hat[2], 0.24)
  shadow(hat[0], hat[2], 0.3)
  cymbal('hihat', 0.17, hat, rotateX(Math.PI))
  cymbal('hihat', 0.17, [hat[0], hat[1] + 0.012, hat[2]], identity(), { hatTop: true })
  add('hatPedal', lathe([[0.07, 0], [0.07, 0.012], [0, 0.012]], 16), chain(translate(hat[0], 0.012, hat[2] + 0.2), rotateX(-0.22)), CHROME)
  add(null, rod(0.005, 0.2), chain(translate(hat[0], 0.02, hat[2] + 0.14), rotateX(-1.1)), CHROME)
  // Crash and ride on their stands.
  cymbalStand(-0.6, -0.24, 1.12)
  cymbal('crash', 0.23, [-0.6, 1.16, -0.24], chain(rotateZ(0.14), rotateX(0.3)))
  cymbalStand(0.92, -0.06, 0.98)
  cymbal('ride', 0.27, [0.92, 1.02, -0.06], chain(rotateZ(-0.16), rotateX(0.24)))
  return parts
}

const VERTEX = `attribute vec3 p; attribute vec3 n; uniform mat4 m; uniform mat4 vp;
varying vec3 vn; varying vec3 wp; varying vec3 lp;
uniform float grow;
void main() { vec4 w = m * vec4(p + n * grow, 1.0); wp = w.xyz; lp = p; vn = mat3(m) * n; gl_Position = vp * w; }`
const FRAGMENT = `precision mediump float;
uniform vec3 color; uniform vec3 tint; uniform float glow; uniform float ink; uniform float toon; uniform float spec; uniform float shine; uniform float shadow; uniform vec3 eye;
varying vec3 vn; varying vec3 wp; varying vec3 lp;
void main() {
  if (shadow > 0.0) {
    float a = 0.22 * (1.0 - smoothstep(0.25, 1.0, length(lp.xz) / shadow));
    gl_FragColor = vec4(0.0, 0.0, 0.0, a);
    return;
  }
  vec3 N = normalize(vn);
  vec3 V = normalize(eye - wp);
  // Outline pass: only the grown shell's far side shows, as a dark rim around each shape.
  if (ink > 0.0) {
    if (dot(N, V) > 0.0) discard;
    gl_FragColor = vec4(0.17, 0.1, 0.05, 1.0);
    return;
  }
  // Two-sided: every surface is lit on the side the viewer sees.
  if (dot(N, V) < 0.0) N = -N;
  vec3 key = normalize(vec3(0.35, 1.0, 0.65));
  vec3 fill = normalize(vec3(-0.7, 0.45, -0.2));
  float hemi = 0.5 + 0.5 * N.y;
  vec3 ambient = mix(vec3(0.36, 0.35, 0.34), vec3(0.8, 0.82, 0.85), hemi) * 0.5;
  float diffuse = max(dot(N, key), 0.0) * 0.72 + max(dot(N, fill), 0.0) * 0.22;
  float highlight = pow(max(dot(N, normalize(key + V)), 0.0), shine) * spec
    + pow(max(dot(N, normalize(fill + V)), 0.0), shine) * spec * 0.3;
  if (toon > 0.0) {
    diffuse = floor(diffuse * 3.0 + 0.5) / 3.0;
    highlight = step(0.35, highlight) * 0.3;
  }
  vec3 base = color * (ambient + diffuse) + vec3(highlight);
  vec3 lit = tint * (0.6 + 0.4 * diffuse) + 0.1 + vec3(highlight) * 0.5;
  gl_FragColor = vec4(clamp(mix(base, lit, glow), 0.0, 1.0), 1.0);
}`

/** Where the kit sits in the scene; the camera keeps this sphere in frame at any panel shape. */
const CENTER = [0.08, 0.6, 0.06]
const RADIUS = 1.08

/** A 3D kit lit by the hits at the playhead of the shared transport. */
export function DrumKitView({ song, engine, sticking, style, onStyle }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const section = useRef<HTMLElement>(null)
  const reduced = useReducedMotion()
  const [failure, setFailure] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const [labels, setLabels] = useState<{ piece: KitPiece; text: string; x: number; y: number }[]>([])
  const draw = useRef<((glow: Map<Target, { value: number; hand: Strike['hand'] }>, hat: HatState) => void) | null>(null)
  const lastSignature = useRef('')
  const plan = useMemo(() => {
    const strikes = new Map<Target, Strike[]>()
    const hats: { beat: number; state: HatState }[] = []
    const states = new Set<HatState>()
    const unspecified = new Set<string>()
    const ordered = song.drums.map((hit, index) => ({ hit, hand: sticking?.hands[index] })).sort((a, b) => a.hit.startBeat - b.hit.startBeat)
    for (const { hit, hand } of ordered) {
      const strike = kitStrike(hit)
      for (const piece of strike.pieces) {
        const list = strikes.get(piece) ?? []
        const last = list.at(-1)
        // Two strokes on one surface at once (two GM toms on one drum) show both hands.
        if (last && last.beat === hit.startBeat) {
          if (last.hand !== hand) last.hand = last.hand && hand ? 'both' : last.hand ?? hand
          last.velocity = Math.max(last.velocity, hit.velocity)
        } else list.push({ beat: hit.startBeat, velocity: hit.velocity, specified: strike.specified, hand })
        strikes.set(piece, list)
      }
      if (strike.hat) {
        hats.push({ beat: hit.startBeat, state: strike.hat })
        states.add(strike.hat)
      }
      if (strike.hat === 'pedal') strikes.set('hatPedal', [...strikes.get('hatPedal') ?? [], { beat: hit.startBeat, velocity: hit.velocity, specified: true }])
      if (!strike.specified) unspecified.add(strike.label)
    }
    const used = KIT_PIECES.filter(({ piece }) => strikes.has(piece))
    return { strikes, hats, states, unspecified: [...unspecified], used }
  }, [song.drums, sticking])

  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const gl = element.getContext('webgl', { antialias: true, preserveDrawingBuffer: false })
    if (!gl) {
      setFailure('The 3D kit needs WebGL, which this device has turned off. The highlighted names below follow the same hits.')
      return
    }
    setFailure(null)
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      return shader
    }
    const program = gl.createProgram()!
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      setFailure('The 3D kit could not start its renderer. The highlighted names below follow the same hits.')
      return
    }
    gl.useProgram(program)
    const position = gl.getAttribLocation(program, 'p')
    const normal = gl.getAttribLocation(program, 'n')
    const uniform = (name: string) => gl.getUniformLocation(program, name)
    const [modelAt, viewAt, colorAt, glowAt, specAt, shineAt, shadowAt, eyeAt, tintAt, growAt, inkAt, toonAt] =
      ['m', 'vp', 'color', 'glow', 'spec', 'shine', 'shadow', 'eye', 'tint', 'grow', 'ink', 'toon'].map(uniform)
    const illustrated = style === 'illustrated'
    const parts = kitParts(style).map((part) => {
      const buffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, part.mesh, gl.STATIC_DRAW)
      return { ...part, buffer, count: part.mesh.length / 6 }
    })
    gl.enable(gl.DEPTH_TEST)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    let view = new Float32Array(16)
    let eye = [0, 0, 0]
    const resize = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1)
      const width = element.clientWidth
      const height = Math.max(1, element.clientHeight)
      element.width = Math.max(1, Math.round(width * ratio))
      element.height = Math.max(1, Math.round(height * ratio))
      gl.viewport(0, 0, element.width, element.height)
      // Fit the kit's bounding sphere in whichever of the two fields of view is narrower.
      const fov = 0.62
      const aspect = width / height
      const across = 2 * Math.atan(Math.tan(fov / 2) * aspect)
      const distance = RADIUS / Math.sin(Math.min(fov, across) / 2) * 0.78
      const direction = normalize([0, 0.72, 1])
      eye = CENTER.map((value, index) => value + direction[index] * distance)
      view = multiply(perspective(fov, aspect, Math.max(0.05, distance - RADIUS * 2), distance + RADIUS * 3), lookAt(eye, CENTER))
      const project = (x: number, y: number, z: number) => {
        const [px, py, , pw] = [0, 1, 2, 3].map((row) => view[row] * x + view[4 + row] * y + view[8 + row] * z + view[12 + row])
        return { x: (px / pw * 0.5 + 0.5) * width, y: (0.5 - py / pw * 0.5) * height }
      }
      const placed: { piece: KitPiece; text: string; x: number; y: number }[] = []
      // A compact stage cannot fit a label per piece; the legend below names and lights them instead.
      for (const { piece, label } of height < 220 ? [] : plan.used) {
        const part = parts.find((item) => item.target === piece)!
        const anchor = project(part.model[12], part.model[13] + 0.12, part.model[14])
        const text = label
        const half = text.length * 3.3 + 8
        const clash = () => placed.some((other) =>
          Math.abs(other.x - anchor.x) < half + other.text.length * 3.3 + 8 && Math.abs(other.y - anchor.y) < 17)
        // Nudge labels up until they clear the ones already placed, staying inside the stage.
        for (let tries = 0; tries < 6 && clash() && anchor.y - 17 > 18; tries++) anchor.y -= 17
        for (let tries = 0; tries < 8 && clash(); tries++) anchor.y += 17
        anchor.y = Math.max(18, Math.min(height - 4, anchor.y))
        placed.push({ piece, text, x: anchor.x, y: anchor.y })
      }
      setLabels(placed)
      lastSignature.current = ''
    }
    draw.current = (glow, hatState) => {
      gl.clearColor(1, 1, 1, 1)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.uniformMatrix4fv(viewAt, false, view)
      gl.uniform3fv(eyeAt, eye)
      const lift = translate(0, HAT_LIFT[hatState], 0)
      gl.uniform1f(toonAt, illustrated ? 1 : 0)
      for (const pass of illustrated ? ['solid', 'ink', 'shadow'] as const : ['solid', 'shadow'] as const) {
        if (pass === 'shadow') { gl.enable(gl.BLEND); gl.depthMask(false) }
        gl.uniform1f(growAt, pass === 'ink' ? INK : 0)
        gl.uniform1f(inkAt, pass === 'ink' ? 1 : 0)
        for (const part of parts) {
          if ((pass === 'shadow') !== !!part.shadow) continue
          gl.bindBuffer(gl.ARRAY_BUFFER, part.buffer)
          gl.enableVertexAttribArray(position)
          gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 24, 0)
          gl.enableVertexAttribArray(normal)
          gl.vertexAttribPointer(normal, 3, gl.FLOAT, false, 24, 12)
          gl.uniformMatrix4fv(modelAt, false, part.hatTop ? multiply(lift, part.model) : part.model)
          gl.uniform3fv(colorAt, part.material.color)
          gl.uniform1f(specAt, part.material.spec)
          gl.uniform1f(shineAt, part.material.shine)
          gl.uniform1f(shadowAt, part.shadow ?? 0)
          const lit = part.target ? glow.get(part.target) : undefined
          gl.uniform1f(glowAt, lit?.value ?? 0)
          gl.uniform3fv(tintAt, TINT[lit?.hand ?? 'none'])
          gl.drawArrays(gl.TRIANGLES, 0, part.count)
        }
      }
      gl.disable(gl.BLEND)
      gl.depthMask(true)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    const lost = (event: Event) => {
      event.preventDefault()
      draw.current = null
      setFailure('The 3D kit lost its graphics context. It will return when the device restores it; the highlighted names below keep following the hits.')
    }
    const restored = () => setGeneration((value) => value + 1)
    element.addEventListener('webglcontextlost', lost)
    element.addEventListener('webglcontextrestored', restored)
    return () => {
      observer.disconnect()
      element.removeEventListener('webglcontextlost', lost)
      element.removeEventListener('webglcontextrestored', restored)
      draw.current = null
      for (const part of parts) gl.deleteBuffer(part.buffer)
      gl.deleteProgram(program)
    }
  }, [generation, plan, style])

  useFrame(engine, (t) => {
    const last = <T extends { beat: number }>(list: T[]) => {
      let first = 0
      let end = list.length
      while (first < end) {
        const middle = (first + end) >> 1
        if (list[middle].beat <= t.beat) first = middle + 1
        else end = middle
      }
      return list[first - 1]
    }
    const glow = new Map<Target, { value: number; hand: Strike['hand'] }>()
    for (const [target, list] of plan.strikes) {
      const hit = last(list)
      if (!hit) continue
      const elapsed = t.beat - hit.beat
      const scale = hit.specified ? 1 : FAMILY
      const value = scale * (reduced
        ? (elapsed < DECAY / 2 ? MAX_GLOW * 0.85 : 0)
        : elapsed < DECAY ? MAX_GLOW * (0.4 + 0.6 * hit.velocity) * (1 - elapsed / DECAY) : 0)
      if (value > 0.01) glow.set(target, { value, hand: hit.hand })
    }
    const hat = last(plan.hats)?.state ?? 'closed'
    const signature = `${hat}|${[...glow].map(([target, { value, hand }]) => `${target}:${Math.round(value * 40)}:${hand ?? ''}`).join(',')}`
    if (signature === lastSignature.current) return
    lastSignature.current = signature
    draw.current?.(glow, hat)
    const lit = [...glow.keys()]
    if (section.current) {
      section.current.dataset.lit = lit.join(',')
      section.current.dataset.hat = hat
      for (const pill of section.current.querySelectorAll<HTMLElement>('[data-piece]'))
        pill.toggleAttribute('data-lit', lit.includes(pill.dataset.piece as Target))
      const hands = new Set([...glow.values()].flatMap(({ hand }) => hand === 'both' ? ['left', 'right'] : hand ? [hand] : []))
      section.current.dataset.hands = [...hands].sort().join(',')
      for (const pill of section.current.querySelectorAll<HTMLElement>('[data-hand]'))
        pill.toggleAttribute('data-lit', hands.has(pill.dataset.hand!))
      for (const pill of section.current.querySelectorAll<HTMLElement>('[data-hat-state]'))
        pill.toggleAttribute('data-lit', pill.dataset.hatState === hat)
    }
  })

  return (
    <section ref={section} className="practice-view practice-kit" data-style={style} aria-label="Drum kit: pieces light up as the playhead reaches each hit">
      <div className="practice-stage">
        <canvas ref={canvas} className="practice-canvas" aria-hidden="true" hidden={!!failure} />
        {!failure && labels.map(({ piece, text, x, y }) => (
          <span key={piece} className="kit-label" style={{ left: x, top: y }} aria-hidden="true">{text}</span>
        ))}
        {failure && <p className="practice-failure" role="status">{failure}</p>}
      </div>
      <div className="chordview kit-style" role="radiogroup" aria-label="Drum kit style">
        <span className="chordview-label" aria-hidden="true">Kit</span>
        {KIT_STYLES.map((option, index) => (
          <button key={option} type="button" role="radio" aria-checked={style === option} tabIndex={style === option ? 0 : -1}
            className="chordview-option" data-style={option} title="Changes only how the kit looks; the hits and sounds stay the same"
            onClick={() => onStyle(option)}
            onKeyDown={(event) => {
              const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
              if (!step) return
              event.preventDefault()
              event.stopPropagation()
              const next = KIT_STYLES[(index + step + KIT_STYLES.length) % KIT_STYLES.length]
              onStyle(next)
              ;(event.currentTarget.parentElement?.querySelector(`[data-style="${next}"]`) as HTMLElement | null)?.focus()
            }}>
            {STYLE_LABEL[option]}
          </button>
        ))}
      </div>
      <p className="practice-legend kit-legend">
        {sticking && <>
          <span className="kit-pill kit-hand" data-hand="left"><b aria-hidden="true">L</b> Left hand</span>
          <span className="kit-pill kit-hand" data-hand="right"><b aria-hidden="true">R</b> Right hand</span>
        </>}
        {plan.used.map(({ piece, label }) => (
          <span key={piece} className="kit-pill" data-piece={piece}>{label}</span>
        ))}
        {plan.strikes.has('hatPedal') && <span className="kit-pill" data-piece="hatPedal">Hi-hat pedal</span>}
        {[...plan.states].map((state) => (
          <span key={state} className="kit-pill kit-state" data-hat-state={state}>Hat {HAT_LABEL[state]}</span>
        ))}
        <span className="practice-note">
          {sticking && (sticking.source === 'lesson'
            ? 'Lesson sticking: each stroke glows in its hand\'s colour, from the player\'s side. '
            : 'Suggested sticking, right-hand lead: a guide from the hits, not from the recording. ')}
          {song.source === 'course' ? 'Hits light briefly. Every stroke in the lesson names its kit piece and hi-hat state' : <>
            Hits light briefly. Toms and hi-hat states come from the transcription&apos;s GM drum detail
            {plan.unspecified.length
              ? `; hits without it (${plan.unspecified.map((name) => name.replace(/ \(.*\)$/, '').toLowerCase()).join(', ')}) stay unspecified: toms light their family dimly and the hat keeps its last known state`
              : ''}</>}.
        </span>
      </p>
    </section>
  )
}
