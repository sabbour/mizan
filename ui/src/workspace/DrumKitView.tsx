import { useEffect, useMemo, useRef, useState } from 'react'
import type { Engine } from './engine'
import { useFrame, useReducedMotion } from './hooks'
import { HAT_LABEL, KIT_PIECES, kitStrike, type HatState, type KitPiece } from './kit'
import { barStart, measures, pulseBeats } from './meter'
import type { Song } from './song'
import type { Sticking } from './sticking'
import { KIT_TYPES, LOOKS, splitKitStyle, type KitStyle, type KitType, type Look } from './prefs'
import { loadKit, prepare, type Prepared, type Target } from './kitAsset'
import { KitRenderer, stageBackground } from './kitRenderer'
import { feedbackAt, type Strike } from './kitFeedback'
import { fallbackScene } from './kitScene'

type Props = {
  song: Song; engine: Engine
  /** Hands for the strokes; undefined when the sticking letters are off. */
  sticking?: Sticking
  /** Kit and look; a view choice only. */
  style: KitStyle
  onStyle: (style: KitStyle) => void
}

const KIT_LABEL: Record<KitType, string> = { electronic: 'Electronic kit', acoustic: 'Acoustic kit' }
const LOOK_LABEL: Record<Look, string> = {
  Realistic: 'Realistic', HandPaintedAnime: 'Hand-painted anime', StylizedAnimated3D: 'Stylized animated 3D', LowPoly: 'Low poly',
  NeonRhythm: 'Neon rhythm', TechnicalBlueprint: 'Technical blueprint', ClayStudyModel: 'Clay study model',
}

const perspective = (fov: number, aspect: number, near: number, far: number) => {
  const f = 1 / Math.tan(fov / 2)
  const m = new Float32Array(16)
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1; m[14] = 2 * far * near / (near - far)
  return m
}
const normalize = (v: number[]) => { const l = Math.hypot(...v); return v.map((x) => x / l) }
const multiply = (a: Float32Array, b: Float32Array) => {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return out
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

/** A 3D kit that follows the shared transport: notes glow as they approach, pulse when played, and the parts react. */
export function DrumKitView({ song, engine, sticking, style, onStyle }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const section = useRef<HTMLElement>(null)
  const reduced = useReducedMotion()
  const { kit, look } = splitKitStyle(style)
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const [context, setContext] = useState(0)
  const [labels, setLabels] = useState<{ piece: KitPiece; text: string; x: number; y: number }[]>([])
  const [selected, setSelected] = useState<ReadonlySet<Target>>(new Set())
  const renderer = useRef<{ renderer: KitRenderer; size: () => [number, number] } | null>(null)
  const latest = useRef({ selected, look })
  const lastSignature = useRef('')
  latest.current = { selected, look }
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
  // The GL context and renderer live as long as the view; kit and look changes only swap what it draws.
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    // Visual tests can ask to keep the drawn frame so it can be read back.
    const keep = !!(globalThis as { __mizanKitCapture?: boolean }).__mizanKitCapture
    const gl = element.getContext('webgl', { antialias: true, stencil: true, preserveDrawingBuffer: keep })
    if (!gl) {
      setFailure('The 3D kit needs WebGL, which this device has turned off. The highlighted names below follow the same hits.')
      return
    }
    let instance: KitRenderer
    try {
      instance = new KitRenderer(gl)
    } catch (error) {
      console.warn('The 3D kit renderer could not start.', error)
      setFailure('The 3D kit could not start its renderer. The highlighted names below follow the same hits.')
      return
    }
    setFailure(null)
    const ratio = () => Math.min(2, window.devicePixelRatio || 1)
    renderer.current = { renderer: instance, size: () => [element.width, element.height] }
    const resize = () => {
      element.width = Math.max(1, Math.round(element.clientWidth * ratio()))
      element.height = Math.max(1, Math.round(Math.max(1, element.clientHeight) * ratio()))
      setGeneration((value) => value + 1)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    const lost = (event: Event) => {
      event.preventDefault()
      renderer.current = null
      setFailure('The 3D kit lost its graphics context. It will return when the device restores it; the highlighted names below keep following the hits.')
    }
    const restored = () => setContext((value) => value + 1)
    element.addEventListener('webglcontextlost', lost)
    element.addEventListener('webglcontextrestored', restored)
    return () => {
      observer.disconnect()
      element.removeEventListener('webglcontextlost', lost)
      element.removeEventListener('webglcontextrestored', restored)
      renderer.current = null
      instance.dispose()
    }
  }, [context])

  // The scene for the chosen kit and look: the kit's GLB (fetched once), or the built-in model if it cannot load.
  const [scene, setScene] = useState<{ kit: KitType; look: Look; prepared: Prepared; images: (ImageBitmap | null)[] } | null>(null)
  useEffect(() => {
    let cancelled = false
    loadKit(kit).then(async (asset) => {
      const images = await asset.images
      if (cancelled) return
      setNotice(null)
      setScene({ kit, look, prepared: prepare(asset, look), images })
    }).catch((error) => {
      if (cancelled) return
      console.warn(`The ${kit} kit model could not be loaded; showing the built-in kit.`, error)
      setNotice('The detailed kit model could not be loaded, so a simpler built-in kit is shown.')
      setScene({ kit, look, prepared: fallbackScene(kit), images: [] })
    })
    return () => { cancelled = true }
  }, [kit, look])
  const lastKit = useRef<KitType | null>(null)
  const camera = useRef<{ view: Float32Array; eye: number[] } | null>(null)
  useEffect(() => {
    const current = renderer.current
    if (!current || !scene) return
    // Textures are cached per kit: a scene from the other kit (even a stale one) starts afresh.
    if (lastKit.current !== scene.kit) { current.renderer.clearTextures(); lastKit.current = scene.kit }
    current.renderer.setScene(scene.prepared, scene.look, scene.images)
    lastSignature.current = ''
  }, [scene, context])
  useEffect(() => {
    const current = renderer.current
    const element = canvas.current
    if (!current || !scene || !element) return
    // Frame the kit (without the throne) from the player's seat, slightly above.
    const width = element.clientWidth, height = Math.max(1, element.clientHeight)
    const { center, radius } = scene.prepared
    const fov = 0.62
    const aspect = width / height
    const across = 2 * Math.atan(Math.tan(fov / 2) * aspect)
    const fit = radius * 0.92
    const distance = fit / Math.sin(Math.min(fov, across) / 2) * 0.9
    const direction = normalize([0, 0.62, 1])
    const eye = center.map((value, index) => value + direction[index] * distance)
    const view = multiply(perspective(fov, aspect, Math.max(0.05, distance - fit * 2.5), distance + fit * 4), lookAt(eye, center))
    current.renderer.view = view
    current.renderer.eye = eye
    camera.current = { view, eye }
    const project = (x: number, y: number, z: number) => {
      const [px, py, , pw] = [0, 1, 2, 3].map((row) => view[row] * x + view[4 + row] * y + view[8 + row] * z + view[12 + row])
      return { x: (px / pw * 0.5 + 0.5) * width, y: (0.5 - py / pw * 0.5) * height }
    }
    const placed: { piece: KitPiece; text: string; x: number; y: number }[] = []
    // A compact stage cannot fit a label per piece; the legend below names and lights them instead.
    for (const { piece, label } of height < 220 ? [] : plan.used) {
      const at = scene.prepared.anchors.get(piece)
      if (!at) continue
      const anchor = project(at[0], at[1] + 0.12, at[2])
      const half = label.length * 3.3 + 8
      const clash = () => placed.some((other) => Math.abs(other.x - anchor.x) < half + other.text.length * 3.3 + 8 && Math.abs(other.y - anchor.y) < 17)
      for (let tries = 0; tries < 6 && clash() && anchor.y - 17 > 18; tries++) anchor.y -= 17
      for (let tries = 0; tries < 8 && clash(); tries++) anchor.y += 17
      anchor.y = Math.max(18, Math.min(height - 4, anchor.y))
      placed.push({ piece, text: label, x: anchor.x, y: anchor.y })
    }
    setLabels(placed)
    lastSignature.current = ''
  }, [scene, generation, context, plan])

  useFrame(engine, (t) => {
    const current = renderer.current
    const loop = engine.loop
    const bar = measures(song)[Math.max(0, Math.min(song.bars - 1, loop ? loop.startBar - 1 : 0))]
    const feedback = feedbackAt(plan.strikes, t, {
      secondsPerBeat: 60 / Math.max(1, engine.getEffectiveQuarterBpm()),
      loop: loop ? { start: barStart(song, loop.startBar - 1), end: barStart(song, loop.endBar) } : null,
      countLength: bar ? Math.round(bar.beats / pulseBeats(bar)) : 4,
      sticking: !!sticking,
      reduced,
    })
    const last = <T extends { beat: number }>(list: T[]) => {
      let first = 0, end = list.length
      while (first < end) { const middle = (first + end) >> 1; if (list[middle].beat <= t.beat) first = middle + 1; else end = middle }
      return list[first - 1]
    }
    const hat = (t.playing ? last(plan.hats)?.state : undefined) ?? 'closed'
    const { selected: chosen } = latest.current
    const signature = `${hat}|${[...chosen].join(',')}|${[...feedback].map(([target, f]) => `${target}:${Math.round(f.pulse * 40)}:${Math.round(f.upcoming * 40)}:${Math.round(Math.min(f.since, 3) * 30)}`).join(',')}`
    if (signature === lastSignature.current) return
    lastSignature.current = signature
    if (current && !failure) {
      const [width, height] = current.size()
      current.renderer.draw(width, height, { hat, feedback, selected: chosen })
    }
    if (section.current) {
      const lit = [...feedback].filter(([, f]) => f.pulse > 0.05).map(([target]) => target)
      section.current.dataset.lit = lit.join(',')
      section.current.dataset.upcoming = [...feedback].filter(([, f]) => f.upcoming > 0.05).map(([target]) => target).join(',')
      section.current.dataset.hat = hat
      for (const pill of section.current.querySelectorAll<HTMLElement>('[data-piece]'))
        pill.toggleAttribute('data-lit', lit.includes(pill.dataset.piece as Target))
      const hands = new Set([...feedback.entries()].filter(([, f]) => f.pulse > 0.05 && sticking)
        .flatMap(([target, f]) => f.split ? ['left', 'right'] : handOf(plan.strikes.get(target), t.beat) ?? []))
      section.current.dataset.hands = [...hands].sort().join(',')
      for (const pill of section.current.querySelectorAll<HTMLElement>('[data-hand]'))
        pill.toggleAttribute('data-lit', hands.has(pill.dataset.hand!))
      for (const pill of section.current.querySelectorAll<HTMLElement>('[data-hat-state]'))
        pill.toggleAttribute('data-lit', pill.dataset.hatState === hat)
    }
  })
  // Selecting a piece (Technical blueprint) draws it opaque; redraw at once even while paused.
  useEffect(() => { lastSignature.current = '' }, [selected])

  return (
    <section ref={section} className="practice-view practice-kit" data-style={style} data-kit={kit} data-look={look}
      style={{ ['--stage-bg' as string]: `rgb(${stageBackground(look).map((x) => Math.round(x * 255)).join(' ')})` }}
      aria-label="Drum kit: pieces glow as their notes approach and light up when played">
      <div className="practice-stage">
        <canvas ref={canvas} className="practice-canvas" aria-hidden="true" hidden={!!failure} />
        {!failure && labels.map(({ piece, text, x, y }) => (
          <span key={piece} className="kit-label" style={{ left: x, top: y }} aria-hidden="true">{text}</span>
        ))}
        {failure && <p className="practice-failure" role="status">{failure}</p>}
        {notice && !failure && <p className="practice-note kit-notice" role="status">{notice}</p>}
      </div>
      <div className="kit-toolbar">
        <label className="kit-style">
          <span>Kit</span>
          <select value={style} onChange={(event) => onStyle(event.target.value as KitStyle)}
            title="Changes only how the kit looks; the hits, sounds and playback stay the same">
            {KIT_TYPES.map((type) => (
              <optgroup key={type} label={KIT_LABEL[type]}>
                {LOOKS.map((option) => <option key={option} value={`${type}:${option}`}>{LOOK_LABEL[option]}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
      </div>
      <p className="practice-legend kit-legend">
        {sticking && <>
          <span className="kit-pill kit-hand" data-hand="left"><b aria-hidden="true">L</b> Left hand</span>
          <span className="kit-pill kit-hand" data-hand="right"><b aria-hidden="true">R</b> Right hand</span>
        </>}
        {plan.used.map(({ piece, label }) => look === 'TechnicalBlueprint'
          ? <button key={piece} type="button" className="kit-pill kit-select" data-piece={piece} aria-pressed={selected.has(piece)}
            title="Show this piece solid" onClick={() => setSelected((current) => {
              const next = new Set(current)
              if (!next.delete(piece)) next.add(piece)
              return next
            })}>{label}</button>
          : <span key={piece} className="kit-pill" data-piece={piece}>{label}</span>)}
        {plan.strikes.has('hatPedal') && <span className="kit-pill" data-piece="hatPedal">Hi-hat pedal</span>}
        {[...plan.states].map((state) => (
          <span key={state} className="kit-pill kit-state" data-hat-state={state}>Hat {HAT_LABEL[state]}</span>
        ))}
        <span className="practice-note">
          {sticking && (sticking.source === 'lesson'
            ? 'Lesson sticking: each note glows in its hand\'s colour as it approaches and when played, from the player\'s side. '
            : 'Suggested sticking, right-hand lead: a guide from the hits, not from the recording. ')}
          {!sticking && 'Each piece glows in its own colour as its note approaches and when played. '}
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

/** The hand of the latest strike at or before `beat`, for the legend. */
function handOf(list: Strike[] | undefined, beat: number): string[] | undefined {
  if (!list) return undefined
  let first = 0, end = list.length
  while (first < end) { const middle = (first + end) >> 1; if (list[middle].beat <= beat) first = middle + 1; else end = middle }
  const hand = list[first - 1]?.hand
  return hand === 'both' ? ['left', 'right'] : hand ? [hand] : undefined
}
