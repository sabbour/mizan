import { useEffect, useMemo, useRef, useState } from 'react'
import type { Engine } from './engine'
import { useFrame, useReducedMotion } from './hooks'
import { HAT_LABEL, KIT_PIECES, kitStrike, type HatState, type KitPiece } from './kit'
import type { Song } from './song'

type Props = { song: Song; engine: Engine }
/** Glow targets: kit pieces plus the hi-hat foot pedal (the kick pedal follows the kick). */
type Target = KitPiece | 'hatPedal'
type Material = { color: [number, number, number]; spec: number; shine: number }
type Part = { target: Target | null; mesh: Float32Array; model: Float32Array; material: Material; hatTop?: boolean; shadow?: number }
type Strike = { beat: number; velocity: number; specified: boolean }

/** A hit glows for half a beat, fading; reduced motion shows a steady quarter-beat mark instead. */
const DECAY = 0.5
const MAX_GLOW = 0.7
/** A strike whose source names only a generic lane lights its whole family this much less. */
const FAMILY = 0.45
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

const LACQUER: Material = { color: [0.22, 0.25, 0.28], spec: 0.5, shine: 48 }
const HEAD: Material = { color: [0.93, 0.92, 0.88], spec: 0.08, shine: 8 }
const RESONANT: Material = { color: [0.62, 0.6, 0.56], spec: 0.05, shine: 8 }
const CHROME: Material = { color: [0.66, 0.68, 0.71], spec: 0.9, shine: 64 }
const BRASS: Material = { color: [0.74, 0.58, 0.28], spec: 0.75, shine: 36 }
const RUBBER: Material = { color: [0.12, 0.12, 0.13], spec: 0.1, shine: 8 }

/** Code-generated kit seen from behind the throne: four rack toms, two floor toms, pedals and stands. */
function kitParts(): Part[] {
  const parts: Part[] = []
  const add = (target: Target | null, mesh: Float32Array, model: Float32Array, material: Material, extra: Partial<Part> = {}) =>
    parts.push({ target, mesh, model, material, ...extra })
  const shadow = (x: number, z: number, radius: number) =>
    add(null, disc(radius, 0.002), translate(x, 0, z), RUBBER, { shadow: radius })
  const legs = (x: number, z: number, top: number, spread = 0.22) => {
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2 + 0.5
      const tilt = Math.atan2(spread, top)
      add(null, rod(0.007, Math.hypot(spread, top)), chain(translate(x, 0, z), rotateY(angle), translate(spread, 0, 0), rotateZ(tilt)), CHROME)
    }
  }
  const drum = (target: KitPiece, radius: number, depth: number, at: [number, number, number], pose: Float32Array) => {
    const model = chain(translate(...at), pose)
    const half = depth / 2
    add(target, lathe([[radius, -half], [radius, half]]), model, LACQUER)
    add(target, disc(radius * 0.99, half + 0.002), model, HEAD)
    add(target, disc(radius * 0.99, -half - 0.002), model, RESONANT)
    add(target, ring(radius + 0.004, half, 0.007), model, CHROME)
    add(target, ring(radius + 0.004, -half, 0.007), model, CHROME)
    return model
  }
  const cymbal = (target: KitPiece, radius: number, at: [number, number, number], pose: Float32Array, extra: Partial<Part> = {}) => {
    const top: [number, number][] = [[0, 0.03], [radius * 0.1, 0.03], [radius * 0.2, 0.012], [radius, -0.01]]
    const model = chain(translate(...at), pose)
    add(target, lathe(top), model, BRASS, extra)
    add(target, lathe(top.map(([r, y]) => [r, y - 0.004] as [number, number]).reverse()), model, BRASS, extra)
  }
  const cymbalStand = (x: number, z: number, height: number) => {
    add(null, rod(0.009, height), translate(x, 0, z), CHROME)
    legs(x, z, 0.26)
    shadow(x, z, 0.3)
  }

  // Kick: on its side, batter head toward the player, with a pedal and beater.
  drum('kick', 0.28, 0.4, [0.02, 0.3, 0.0], rotateX(Math.PI / 2))
  shadow(0.02, 0.0, 0.42)
  add('kick', lathe([[0.06, 0], [0.06, 0.012], [0, 0.012]], 16), chain(translate(0.02, 0.012, 0.42), rotateX(-0.25)), CHROME)
  add('kick', rod(0.005, 0.24), chain(translate(0.02, 0.06, 0.32), rotateX(-0.5)), CHROME)
  add('kick', lathe([[0.001, -0.025], [0.025, -0.012], [0.025, 0.012], [0.001, 0.025]], 16), chain(translate(0.02, 0.27, 0.215), rotateX(Math.PI / 2)), RUBBER)
  // Snare on its tripod, tilted toward the player.
  drum('snare', 0.18, 0.14, [-0.34, 0.62, 0.36], rotateX(0.1))
  add(null, rod(0.008, 0.55), translate(-0.34, 0, 0.36), CHROME)
  legs(-0.34, 0.36, 0.2, 0.18)
  shadow(-0.34, 0.36, 0.28)
  // Four rack toms on mounts, smallest at the player's left.
  const racks: [KitPiece, number, number, [number, number, number], number][] = [
    ['tom1', 0.12, 0.15, [-0.29, 0.86, 0.0], 0.45],
    ['tom2', 0.13, 0.16, [-0.03, 0.9, -0.08], 0.42],
    ['tom3', 0.145, 0.17, [0.24, 0.89, -0.06], 0.4],
    ['tom4', 0.16, 0.19, [0.49, 0.82, 0.05], 0.36],
  ]
  for (const [piece, radius, depth, at, tilt] of racks) {
    drum(piece, radius, depth, at, chain(rotateY(-at[0] * 0.5), rotateX(tilt)))
    add(null, rod(0.008, at[1] - 0.52), translate(at[0] * 0.75 + 0.01, 0.52, at[2] * 0.5), CHROME)
  }
  // Two floor toms on legs at the player's right.
  for (const [piece, radius, depth, x, z] of [['floor1', 0.19, 0.3, 0.55, 0.46], ['floor2', 0.21, 0.32, 0.86, 0.26]] as const) {
    drum(piece, radius, depth, [x, 0.48, z], rotateX(0.04))
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2 + 0.3
      add(null, rod(0.008, 0.36), chain(translate(x + Math.cos(angle) * (radius + 0.03), 0, z + Math.sin(angle) * (radius + 0.03)), rotateZ(Math.cos(angle) * 0.08)), CHROME)
    }
    shadow(x, z, radius + 0.12)
  }
  // Hi-hat: fixed bottom cymbal, top cymbal on the clutch (lifted by the hat state), foot pedal.
  const hat: [number, number, number] = [-0.72, 0.9, 0.3]
  add(null, rod(0.009, hat[1] + 0.12), translate(hat[0], 0, hat[2]), CHROME)
  legs(hat[0], hat[2], 0.24)
  shadow(hat[0], hat[2], 0.3)
  cymbal('hihat', 0.17, hat, rotateX(Math.PI))
  cymbal('hihat', 0.17, [hat[0], hat[1] + 0.012, hat[2]], identity(), { hatTop: true })
  add('hatPedal', lathe([[0.07, 0], [0.07, 0.012], [0, 0.012]], 16), chain(translate(hat[0], 0.012, hat[2] + 0.2), rotateX(-0.22)), CHROME)
  add(null, rod(0.005, 0.2), chain(translate(hat[0], 0.02, hat[2] + 0.14), rotateX(-1.1)), CHROME)
  // Crash and ride on boom stands.
  cymbalStand(-0.6, -0.24, 1.12)
  cymbal('crash', 0.23, [-0.6, 1.16, -0.24], chain(rotateZ(0.14), rotateX(0.3)))
  cymbalStand(0.92, -0.06, 0.98)
  cymbal('ride', 0.27, [0.92, 1.02, -0.06], chain(rotateZ(-0.16), rotateX(0.24)))
  return parts
}

const VERTEX = `attribute vec3 p; attribute vec3 n; uniform mat4 m; uniform mat4 vp;
varying vec3 vn; varying vec3 wp; varying vec3 lp;
void main() { vec4 w = m * vec4(p, 1.0); wp = w.xyz; lp = p; vn = mat3(m) * n; gl_Position = vp * w; }`
const FRAGMENT = `precision mediump float;
uniform vec3 color; uniform float glow; uniform float spec; uniform float shine; uniform float shadow; uniform vec3 eye;
varying vec3 vn; varying vec3 wp; varying vec3 lp;
void main() {
  if (shadow > 0.0) {
    float a = 0.22 * (1.0 - smoothstep(0.25, 1.0, length(lp.xz) / shadow));
    gl_FragColor = vec4(0.0, 0.0, 0.0, a);
    return;
  }
  vec3 N = normalize(vn);
  vec3 V = normalize(eye - wp);
  // Two-sided: every surface is lit on the side the viewer sees.
  if (dot(N, V) < 0.0) N = -N;
  vec3 key = normalize(vec3(0.35, 1.0, 0.65));
  vec3 fill = normalize(vec3(-0.7, 0.45, -0.2));
  float hemi = 0.5 + 0.5 * N.y;
  vec3 ambient = mix(vec3(0.36, 0.35, 0.34), vec3(0.8, 0.82, 0.85), hemi) * 0.5;
  float diffuse = max(dot(N, key), 0.0) * 0.72 + max(dot(N, fill), 0.0) * 0.22;
  float highlight = pow(max(dot(N, normalize(key + V)), 0.0), shine) * spec
    + pow(max(dot(N, normalize(fill + V)), 0.0), shine) * spec * 0.3;
  vec3 base = color * (ambient + diffuse) + vec3(highlight);
  vec3 lit = vec3(0.05, 0.48, 0.39) * (0.6 + 0.4 * diffuse) + 0.1 + vec3(highlight) * 0.5;
  gl_FragColor = vec4(clamp(mix(base, lit, glow), 0.0, 1.0), 1.0);
}`

/** Where the kit sits in the scene; the camera keeps this sphere in frame at any panel shape. */
const CENTER = [0.08, 0.6, 0.06]
const RADIUS = 1.08

/** A 3D kit lit by the hits at the playhead of the shared transport. */
export function DrumKitView({ song, engine }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const section = useRef<HTMLElement>(null)
  const reduced = useReducedMotion()
  const [failure, setFailure] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const [labels, setLabels] = useState<{ piece: KitPiece; text: string; x: number; y: number }[]>([])
  const draw = useRef<((glow: Map<Target, number>, hat: HatState) => void) | null>(null)
  const lastSignature = useRef('')
  const plan = useMemo(() => {
    const strikes = new Map<Target, Strike[]>()
    const hats: { beat: number; state: HatState }[] = []
    const states = new Set<HatState>()
    const unspecified = new Set<string>()
    for (const hit of [...song.drums].sort((a, b) => a.startBeat - b.startBeat)) {
      const strike = kitStrike(hit)
      for (const piece of strike.pieces)
        strikes.set(piece, [...strikes.get(piece) ?? [], { beat: hit.startBeat, velocity: hit.velocity, specified: strike.specified }])
      if (strike.hat) {
        hats.push({ beat: hit.startBeat, state: strike.hat })
        states.add(strike.hat)
      }
      if (strike.hat === 'pedal') strikes.set('hatPedal', [...strikes.get('hatPedal') ?? [], { beat: hit.startBeat, velocity: hit.velocity, specified: true }])
      if (!strike.specified) unspecified.add(strike.label)
    }
    const used = KIT_PIECES.filter(({ piece }) => strikes.has(piece))
    return { strikes, hats, states, unspecified: [...unspecified], used }
  }, [song.drums])

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
    const [modelAt, viewAt, colorAt, glowAt, specAt, shineAt, shadowAt, eyeAt] =
      ['m', 'vp', 'color', 'glow', 'spec', 'shine', 'shadow', 'eye'].map(uniform)
    const parts = kitParts().map((part) => {
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
      for (const pass of ['solid', 'shadow'] as const) {
        if (pass === 'shadow') { gl.enable(gl.BLEND); gl.depthMask(false) }
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
          gl.uniform1f(glowAt, part.target ? glow.get(part.target) ?? 0 : 0)
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
  }, [generation, plan])

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
    const glow = new Map<Target, number>()
    for (const [target, list] of plan.strikes) {
      const hit = last(list)
      if (!hit) continue
      const elapsed = t.beat - hit.beat
      const scale = hit.specified ? 1 : FAMILY
      const value = scale * (reduced
        ? (elapsed < DECAY / 2 ? MAX_GLOW * 0.85 : 0)
        : elapsed < DECAY ? MAX_GLOW * (0.4 + 0.6 * hit.velocity) * (1 - elapsed / DECAY) : 0)
      if (value > 0.01) glow.set(target, value)
    }
    const hat = last(plan.hats)?.state ?? 'closed'
    const signature = `${hat}|${[...glow].map(([target, value]) => `${target}:${Math.round(value * 40)}`).join(',')}`
    if (signature === lastSignature.current) return
    lastSignature.current = signature
    draw.current?.(glow, hat)
    const lit = [...glow.keys()]
    if (section.current) {
      section.current.dataset.lit = lit.join(',')
      section.current.dataset.hat = hat
      for (const pill of section.current.querySelectorAll<HTMLElement>('[data-piece]'))
        pill.toggleAttribute('data-lit', lit.includes(pill.dataset.piece as Target))
      for (const pill of section.current.querySelectorAll<HTMLElement>('[data-hat-state]'))
        pill.toggleAttribute('data-lit', pill.dataset.hatState === hat)
    }
  })

  return (
    <section ref={section} className="practice-view practice-kit" aria-label="Drum kit: pieces light up as the playhead reaches each hit">
      <div className="practice-stage">
        <canvas ref={canvas} className="practice-canvas" aria-hidden="true" hidden={!!failure} />
        {!failure && labels.map(({ piece, text, x, y }) => (
          <span key={piece} className="kit-label" style={{ left: x, top: y }} aria-hidden="true">{text}</span>
        ))}
        {failure && <p className="practice-failure" role="status">{failure}</p>}
      </div>
      <p className="practice-legend kit-legend">
        {plan.used.map(({ piece, label }) => (
          <span key={piece} className="kit-pill" data-piece={piece}>{label}</span>
        ))}
        {plan.strikes.has('hatPedal') && <span className="kit-pill" data-piece="hatPedal">Hi-hat pedal</span>}
        {[...plan.states].map((state) => (
          <span key={state} className="kit-pill kit-state" data-hat-state={state}>Hat {HAT_LABEL[state]}</span>
        ))}
        <span className="practice-note">
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
