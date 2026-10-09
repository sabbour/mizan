import { useEffect, useMemo, useRef, useState } from 'react'
import type { Engine } from './engine'
import { useFrame, useReducedMotion } from './hooks'
import type { DrumHit, DrumLane, Song } from './song'

type Props = { song: Song; engine: Engine }
type Piece = 'crash' | 'ride' | 'hihat' | 'hightom' | 'snare' | 'floortom' | 'kick'
type Part = { piece: Piece | null; geometry: Float32Array; model: Float32Array; color: [number, number, number] }

const PIECES: { piece: Piece; label: string; lanes: DrumLane[] }[] = [
  { piece: 'crash', label: 'Crash', lanes: ['crash'] },
  { piece: 'hihat', label: 'Hi-hat', lanes: ['hihat', 'openhat'] },
  { piece: 'hightom', label: 'High tom', lanes: ['hightom'] },
  { piece: 'snare', label: 'Snare', lanes: ['snare'] },
  { piece: 'ride', label: 'Ride', lanes: ['ride'] },
  { piece: 'floortom', label: 'Floor tom', lanes: ['floortom'] },
  { piece: 'kick', label: 'Kick', lanes: ['kick'] },
]
/** A hit glows for half a beat, fading; reduced motion shows a steady quarter-beat mark instead. */
const DECAY = 0.5
const MAX_GLOW = 0.7

// Column-major 4x4 matrices.
const multiply = (a: Float32Array, b: Float32Array) => {
  const out = new Float32Array(16)
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k]
  return out
}
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
const translate = (x: number, y: number, z: number) => { const m = identity(); m[12] = x; m[13] = y; m[14] = z; return m }
const rotateX = (angle: number) => {
  const m = identity(); const c = Math.cos(angle); const s = Math.sin(angle)
  m[5] = c; m[6] = s; m[9] = -s; m[10] = c
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
const lookAt = (eye: number[], target: number[]) => {
  const sub = (a: number[], b: number[]) => a.map((value, index) => value - b[index])
  const norm = (v: number[]) => { const l = Math.hypot(...v); return v.map((value) => value / l) }
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const z = norm(sub(eye, target))
  const x = norm(cross([0, 1, 0], z))
  const y = cross(z, x)
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1])
}

/** Triangles with interleaved position and normal for a Y-axis cylinder centred at the origin. */
function cylinder(radius: number, height: number, segments = 40): Float32Array {
  const out: number[] = []
  const half = height / 2
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    const b = ((i + 1) / segments) * Math.PI * 2
    const [ca, sa, cb, sb] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)]
    const side = (x: number, y: number, z: number, nx: number, nz: number) => out.push(x, y, z, nx, 0, nz)
    side(radius * ca, -half, radius * sa, ca, sa); side(radius * cb, -half, radius * sb, cb, sb); side(radius * cb, half, radius * sb, cb, sb)
    side(radius * ca, -half, radius * sa, ca, sa); side(radius * cb, half, radius * sb, cb, sb); side(radius * ca, half, radius * sa, ca, sa)
    out.push(0, half, 0, 0, 1, 0, radius * cb, half, radius * sb, 0, 1, 0, radius * ca, half, radius * sa, 0, 1, 0)
    out.push(0, -half, 0, 0, -1, 0, radius * ca, -half, radius * sa, 0, -1, 0, radius * cb, -half, radius * sb, 0, -1, 0)
  }
  return new Float32Array(out)
}

const SHELL: [number, number, number] = [0.24, 0.26, 0.29]
const HEAD: [number, number, number] = [0.9, 0.89, 0.86]
const BRASS: [number, number, number] = [0.72, 0.6, 0.32]
const STAND: [number, number, number] = [0.55, 0.57, 0.6]

/** Code-generated kit: shells with heads, brass cymbals and stands, seen from the stool. */
function kitParts(): Part[] {
  const parts: Part[] = []
  const drum = (piece: Piece, radius: number, depth: number, at: [number, number, number], tilt: number, sideways = false) => {
    const pose = multiply(translate(...at), sideways ? rotateX(Math.PI / 2) : rotateX(tilt))
    parts.push({ piece, geometry: cylinder(radius, depth), model: pose, color: SHELL })
    const head = multiply(pose, translate(0, depth / 2 + 0.004, 0))
    parts.push({ piece, geometry: cylinder(radius * 0.97, 0.008), model: head, color: HEAD })
  }
  const cymbal = (piece: Piece, radius: number, at: [number, number, number], tilt: number, roll = 0) => {
    parts.push({ piece, geometry: cylinder(radius, 0.012), model: multiply(translate(...at), multiply(rotateZ(roll), rotateX(tilt))), color: BRASS })
    parts.push({ piece: null, geometry: cylinder(0.008, at[1]), model: translate(at[0], at[1] / 2, at[2]), color: STAND })
  }
  drum('kick', 0.29, 0.42, [0, 0.29, 0.05], 0, true)
  drum('snare', 0.18, 0.13, [-0.36, 0.6, 0.32], 0.12)
  drum('hightom', 0.15, 0.17, [-0.1, 0.8, 0.02], 0.35)
  drum('floortom', 0.21, 0.3, [0.42, 0.46, 0.3], 0.05)
  cymbal('hihat', 0.18, [-0.66, 0.88, 0.28], 0.05)
  parts.push({ piece: 'hihat', geometry: cylinder(0.18, 0.012), model: translate(-0.66, 0.85, 0.28), color: BRASS })
  cymbal('ride', 0.27, [0.6, 0.94, -0.08], 0.28, -0.1)
  cymbal('crash', 0.23, [-0.42, 1.12, -0.22], 0.35, 0.12)
  return parts
}

const VERTEX = `attribute vec3 p; attribute vec3 n; uniform mat4 m; uniform mat4 vp; varying vec3 vn;
void main() { vn = mat3(m) * n; gl_Position = vp * m * vec4(p, 1.0); }`
const FRAGMENT = `precision mediump float; uniform vec3 color; uniform float glow; varying vec3 vn;
void main() {
  float light = 0.38 + 0.62 * max(dot(normalize(vn), normalize(vec3(0.3, 1.0, 0.7))), 0.0);
  gl_FragColor = vec4(mix(color * light, vec3(0.05, 0.48, 0.39) * (0.6 + 0.4 * light) + 0.12, glow), 1.0);
}`

/** A lightweight 3D kit lit by the hits at the playhead of the shared transport. */
export function DrumKitView({ song, engine }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const section = useRef<HTMLElement>(null)
  const reduced = useReducedMotion()
  const [failure, setFailure] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const [labels, setLabels] = useState<{ piece: Piece; x: number; y: number }[]>([])
  const draw = useRef<((glow: Map<Piece, number>) => void) | null>(null)
  const lastSignature = useRef('')
  const hits = useMemo(() => {
    const byPiece = new Map<Piece, DrumHit[]>()
    for (const { piece, lanes } of PIECES) byPiece.set(piece, song.drums.filter((hit) => lanes.includes(hit.lane)).sort((a, b) => a.startBeat - b.startBeat))
    return byPiece
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
    const [modelAt, viewAt, colorAt, glowAt] = ['m', 'vp', 'color', 'glow'].map(uniform)
    const parts = kitParts().map((part) => {
      const buffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, part.geometry, gl.STATIC_DRAW)
      return { ...part, buffer, count: part.geometry.length / 6 }
    })
    gl.enable(gl.DEPTH_TEST)
    let view = new Float32Array(16)
    const resize = () => {
      const ratio = window.devicePixelRatio || 1
      element.width = Math.max(1, Math.round(element.clientWidth * ratio))
      element.height = Math.max(1, Math.round(element.clientHeight * ratio))
      gl.viewport(0, 0, element.width, element.height)
      view = multiply(perspective(0.72, element.clientWidth / Math.max(1, element.clientHeight), 0.1, 10), lookAt([0, 1.55, 2.05], [0, 0.66, 0]))
      // Label each piece at its projected centre.
      setLabels(PIECES.map(({ piece }) => {
        const part = parts.find((item) => item.piece === piece)!
        const [x, y, z, w] = [0, 1, 2, 3].map((row) => view[row] * part.model[12] + view[4 + row] * part.model[13] + view[8 + row] * part.model[14] + view[12 + row])
        void z
        return { piece, x: (x / w * 0.5 + 0.5) * element.clientWidth, y: (0.5 - y / w * 0.5) * element.clientHeight }
      }))
      lastSignature.current = ''
    }
    draw.current = (glow) => {
      gl.clearColor(1, 1, 1, 1)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.uniformMatrix4fv(viewAt, false, view)
      for (const part of parts) {
        gl.bindBuffer(gl.ARRAY_BUFFER, part.buffer)
        gl.enableVertexAttribArray(position)
        gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 24, 0)
        gl.enableVertexAttribArray(normal)
        gl.vertexAttribPointer(normal, 3, gl.FLOAT, false, 24, 12)
        gl.uniformMatrix4fv(modelAt, false, part.model)
        gl.uniform3fv(colorAt, part.color)
        gl.uniform1f(glowAt, part.piece ? glow.get(part.piece) ?? 0 : 0)
        gl.drawArrays(gl.TRIANGLES, 0, part.count)
      }
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
  }, [generation])

  useFrame(engine, (t) => {
    const glow = new Map<Piece, number>()
    for (const [piece, list] of hits) {
      let first = 0
      let last = list.length
      while (first < last) {
        const middle = (first + last) >> 1
        if (list[middle].startBeat <= t.beat) first = middle + 1
        else last = middle
      }
      const hit = list[first - 1]
      if (!hit) continue
      const elapsed = t.beat - hit.startBeat
      const value = reduced ? (elapsed < DECAY / 2 ? MAX_GLOW * 0.85 : 0) : elapsed < DECAY ? MAX_GLOW * (0.4 + 0.6 * hit.velocity) * (1 - elapsed / DECAY) : 0
      if (value > 0.01) glow.set(piece, value)
    }
    const signature = PIECES.map(({ piece }) => Math.round((glow.get(piece) ?? 0) * 40)).join(',')
    if (signature === lastSignature.current) return
    lastSignature.current = signature
    draw.current?.(glow)
    const lit = PIECES.filter(({ piece }) => glow.has(piece)).map(({ piece }) => piece)
    if (section.current) {
      section.current.dataset.lit = lit.join(',')
      for (const pill of section.current.querySelectorAll<HTMLElement>('[data-piece]')) pill.toggleAttribute('data-lit', lit.includes(pill.dataset.piece as Piece))
    }
  })

  return (
    <section ref={section} className="practice-view practice-kit" aria-label="Drum kit: pieces light up as the playhead reaches each hit">
      <div className="practice-stage">
        <canvas ref={canvas} className="practice-canvas" aria-hidden="true" hidden={!!failure} />
        {!failure && labels.map(({ piece, x, y }) => (
          <span key={piece} className="kit-label" style={{ left: x, top: y }} aria-hidden="true">
            {PIECES.find((item) => item.piece === piece)!.label}
          </span>
        ))}
        {failure && <p className="practice-failure" role="status">{failure}</p>}
      </div>
      <p className="practice-legend kit-legend">
        {PIECES.map(({ piece, label }) => (
          <span key={piece} className="kit-pill" data-piece={piece}>{label}</span>
        ))}
        <span className="practice-note">Hits light briefly; the grouping follows the transcription&apos;s drum lanes.</span>
      </p>
    </section>
  )
}
