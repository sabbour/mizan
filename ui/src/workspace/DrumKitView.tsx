import { useEffect, useMemo, useRef, useState } from 'react'
import type { Engine } from './engine'
import { useFrame, useReducedMotion } from './hooks'
import { HAT_LABEL, KIT_PIECES, kitStrike, type HatState, type KitPiece } from './kit'
import type { Song } from './song'
import type { Hand, Sticking } from './sticking'
import { KIT_STYLES, type KitStyle } from './prefs'
import { buildKit, FRAGMENT, KIT_STYLE_LABEL, multiply, normalize, translate, VERTEX, type Target } from './kitScene'

type Props = {
  song: Song; engine: Engine
  /** Hands for the strokes; undefined when the sticking letters are off. */
  sticking?: Sticking
  /** How the kit looks; a view choice only. */
  style: KitStyle
  onStyle: (style: KitStyle) => void
}
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

const perspective = (fov: number, aspect: number, near: number, far: number) => {
  const f = 1 / Math.tan(fov / 2)
  const m = new Float32Array(16)
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1; m[14] = 2 * far * near / (near - far)
  return m
}
const lookAt = (eye: number[], target: number[]) => {
  const sub = (a: number[], b: number[]) => a.map((value, index) => value - b[index])
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const z = normalize(sub(eye, target))
  const x = normalize(cross([0, 1, 0], z))
  const y = cross(z, x)
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1])
}
/** Outline width for the illustrated style, in kit units. */
const INK = 0.006
/** Soft planar shadows: a few light directions around an almost overhead key light. */
const SUNS = [[0.22, 1, 0.12], [0.3, 1, 0.2], [0.14, 1, 0.22]].map(normalize)

/** Where the kit sits in the scene; the camera keeps this sphere in frame at any panel shape. */
const identity4 = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
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
    const gl = element.getContext('webgl', { antialias: true, stencil: true, preserveDrawingBuffer: false })
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
    const shaders = [compile(gl.VERTEX_SHADER, VERTEX), compile(gl.FRAGMENT_SHADER, FRAGMENT)]
    for (const shader of shaders) gl.attachShader(program, shader)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      setFailure('The 3D kit could not start its renderer. The highlighted names below follow the same hits.')
      return
    }
    gl.useProgram(program)
    const attributes = ['p', 'n', 'q'].map((name) => gl.getAttribLocation(program, name))
    const at = Object.fromEntries(['m', 'vp', 'color', 'tint', 'eye', 'metal', 'rough', 'pattern', 'glow', 'ink', 'toon', 'grow', 'sun', 'flatten',
      'blob', 'shadowAlpha'].map((name) => [name, gl.getUniformLocation(program, name)]))
    const illustrated = style === 'illustrated'
    // Built once per style and kept in GPU buffers; each frame only changes uniforms.
    const kit = buildKit(style)
    const batches = kit.batches.map((batch) => {
      const buffer = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, batch.data, gl.STATIC_DRAW)
      return { ...batch, buffer }
    })
    const still = identity4()
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
        const [x, y, z] = kit.anchors.get(piece) ?? [0, 0, 0]
        const anchor = project(x, y + 0.12, z)
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
    const bind = (batch: (typeof batches)[number]) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.buffer)
      attributes.forEach((location, index) => {
        gl.enableVertexAttribArray(location)
        gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 36, index * 12)
      })
    }
    draw.current = (glow, hatState) => {
      gl.clearColor(1, 1, 1, 1)
      gl.clearStencil(0)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
      gl.uniformMatrix4fv(at.vp, false, view)
      gl.uniform3fv(at.eye, eye)
      gl.uniform1f(at.toon, illustrated ? 1 : 0)
      const lift = translate(0, HAT_LIFT[hatState], 0)
      const reset = () => {
        for (const name of ['ink', 'grow', 'flatten', 'blob', 'glow']) gl.uniform1f(at[name], 0)
      }
      const solid = (batch: (typeof batches)[number]) => {
        bind(batch)
        gl.uniformMatrix4fv(at.m, false, batch.hatTop ? lift : still)
        gl.uniform3fv(at.color, batch.material.color)
        gl.uniform1f(at.metal, batch.material.metal)
        gl.uniform1f(at.rough, batch.material.rough)
        gl.uniform1f(at.pattern, batch.material.pattern)
        gl.drawArrays(gl.TRIANGLES, 0, batch.count)
      }
      reset()
      // 1. The floor, as a backdrop: nothing is below it, so it never needs to hide anything.
      gl.depthMask(false)
      for (const batch of batches) if (batch.kind === 'floor') solid(batch)
      // 2. Soft shadows: each light direction shades a floor pixel at most once (stencil), and the passes add up.
      gl.enable(gl.BLEND)
      gl.depthMask(false)
      gl.enable(gl.STENCIL_TEST)
      gl.uniform1f(at.flatten, 1)
      gl.uniform1f(at.shadowAlpha, illustrated ? 0.09 : 0.075)
      SUNS.forEach((sun, index) => {
        if (index) gl.clear(gl.STENCIL_BUFFER_BIT)
        gl.stencilFunc(gl.EQUAL, 0, 0xff)
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR)
        gl.uniform3fv(at.sun, sun)
        for (const batch of batches) if (batch.kind === 'solid') {
          bind(batch)
          gl.uniformMatrix4fv(at.m, false, batch.hatTop ? lift : still)
          gl.drawArrays(gl.TRIANGLES, 0, batch.count)
        }
      })
      gl.disable(gl.STENCIL_TEST)
      gl.uniform1f(at.flatten, 0)
      // 3. Contact shadows where feet and drums meet the floor.
      for (const batch of batches) if (batch.kind === 'blob') {
        gl.uniform1f(at.blob, 1)
        solid(batch)
      }
      gl.uniform1f(at.blob, 0)
      gl.disable(gl.BLEND)
      gl.depthMask(true)
      // 4. The kit, then the illustrated outline.
      for (const batch of batches) if (batch.kind === 'solid') {
        const lit = batch.target ? glow.get(batch.target) : undefined
        gl.uniform1f(at.glow, lit?.value ?? 0)
        gl.uniform3fv(at.tint, TINT[lit?.hand ?? 'none'])
        solid(batch)
      }
      gl.uniform1f(at.glow, 0)
      if (illustrated) {
        gl.uniform1f(at.ink, 1)
        gl.uniform1f(at.grow, INK)
        for (const batch of batches) if (batch.kind === 'solid') solid(batch)
        reset()
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
      for (const batch of batches) gl.deleteBuffer(batch.buffer)
      gl.deleteProgram(program)
      for (const shader of shaders) gl.deleteShader(shader)
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
      <div className="kit-toolbar">
        <label className="kit-style">
          <span>Kit look</span>
          <select value={style} onChange={(event) => onStyle(event.target.value as KitStyle)}
            title="Changes only how the kit looks; the hits and sounds stay the same">
            {KIT_STYLES.map((option) => <option key={option} value={option}>{KIT_STYLE_LABEL[option]}</option>)}
          </select>
        </label>
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
