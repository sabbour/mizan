import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Engine } from './engine'
import { useFrame, useReducedMotion } from './hooks'
import { barStart, measures, pulseBeats } from './meter'
import { keyLetter, noteName, type PianoNote, type Song } from './song'
import { loadPrefs, LOOKS, LOOK_LABEL, savePref, type Look } from './prefs'
import type { KeyTarget } from './kitAsset'
import { KitRenderer, stageBackground, type Feedback } from './kitRenderer'
import { feedbackAt, HAND_GLOW, type Strike } from './kitFeedback'
import { loadPiano, loadPianoManifest, preparedPiano, type PianoManifest, type PreparedPiano } from './pianoAsset'
import { HandsView } from './HandsView'
import { useHandsPref } from './useHandsPref'
import type { PianoGeometry, PianoHandPlan, PianoHands } from './pianoHands'

type HandsKit = {
  instance: PianoHands
  build: typeof import('./pianoHands')['buildPianoHandPlan']
  geometry: typeof import('./pianoHands')['pianoGeometry']
}
type Props = {
  song: Song
  engine: Engine
  /** Written finger numbers over the keys that are down. */
  fingering?: boolean
  /** Note letters over the keys that are down and the keys about to be played. */
  letters?: boolean
}

const PEDAL_LABEL: Record<number, string> = { 64: 'Sustain pedal', 66: 'Sostenuto pedal', 67: 'Soft pedal' }
const UNASSIGNED_GLOW: [number, number, number] = [0.72, 0.72, 0.72]
/** The look chosen in this session; a view choice only, never stored. */
const session: { look?: Look } = {}


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
const lookAt = (eye: number[], target: number[], up = [0, 1, 0]) => {
  const sub = (a: number[], b: number[]) => a.map((value, index) => value - b[index])
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const z = normalize(sub(eye, target))
  const x = normalize(cross(up, z))
  const y = cross(z, x)
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1])
}
const orthographic = (left: number, right: number, bottom: number, top: number, near: number, far: number) =>
  new Float32Array([2 / (right - left), 0, 0, 0, 0, 2 / (top - bottom), 0, 0, 0, 0, -2 / (far - near), 0,
    -(right + left) / (right - left), -(top + bottom) / (top - bottom), -(far + near) / (far - near), 1])

type Held = { start: number; end: number; note: PianoNote }

/** A 3D piano that follows the shared transport: keys glow as their notes approach and press while they sound. */
export function PianoView({ song, engine, fingering = true, letters = false }: Props) {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const [canvasElement, setCanvasElement] = useState<HTMLCanvasElement | null>(null)
  const attachCanvas = useCallback((element: HTMLCanvasElement | null) => { canvas.current = element; setCanvasElement(element) }, [])
  const section = useRef<HTMLElement>(null)
  const fingersLayer = useRef<HTMLDivElement>(null)
  const described = useRef<HTMLParagraphElement>(null)
  const reduced = useReducedMotion()
  const [manifest, setManifest] = useState<PianoManifest | null>(null)
  const [variantId, setVariantId] = useState<string | undefined>()
  const [look, setLook] = useState<Look>(session.look ?? 'Realistic')
  const [topView, setTopView] = useState(() => loadPrefs().pianoTopView ?? false)
  const [failure, setFailure] = useState<string | null>(null)
  // A lost graphics context is temporary: the canvas stays mounted so the restore event can bring the keyboard back.
  const [lost, setLost] = useState(false)
  const [generation, setGeneration] = useState(0)
  const [context, setContext] = useState(0)
  // Bumped when a renderer starts, so a model that loaded first is still uploaded and framed.
  const [rendererReady, setRendererReady] = useState(0)
  const renderer = useRef<{ renderer: KitRenderer; size: () => [number, number] } | null>(null)
  // The hands load only once the 3D keyboard is shown; without them the keyboard works as before.
  const [loadedKit, setHandsKit] = useState<HandsKit | null>(null)
  const [handsFailed, setHandsFailed] = useState(false)
  const [handsOn, toggleHands] = useHandsPref()
  // With Hands off nothing of the hands is drawn or posed; the models are only fetched once they are on.
  const handsKit = handsOn ? loadedKit : null
  const camera = useRef<{ view: Float32Array; width: number; height: number } | null>(null)
  const lastSignature = useRef('')
  const lastLabels = useRef('')
  const lastSummary = useRef('')

  const notes = song.piano
  const plan = useMemo(() => {
    const strikes = new Map<KeyTarget, Strike[]>()
    const held = new Map<number, Held[]>()
    // A written sustain pedal holds the sound but not the key: keys rise when the note's written length ends.
    for (const note of [...notes].sort((a, b) => a.startBeat - b.startBeat)) {
      const key = Math.round(note.midi)
      const target: KeyTarget = `key:${key}`
      const list = strikes.get(target) ?? []
      const last = list.at(-1)
      if (last && Math.abs(last.beat - note.startBeat) < 1e-9) {
        if (last.hand && note.hand && last.hand !== note.hand) last.hand = 'both'
        else last.hand ??= note.hand
      } else list.push({ beat: note.startBeat, velocity: note.velocity ?? 0.7, specified: true, hand: note.hand })
      strikes.set(target, list)
      held.set(key, [...held.get(key) ?? [], { start: note.startBeat, end: note.startBeat + note.beats, note }])
    }
    const used = [...held.keys()]
    return { strikes, held, low: used.length ? Math.min(...used) : null, high: used.length ? Math.max(...used) : null,
      fingered: notes.some((note) => note.finger), pedals: song.pedals ?? null }
  }, [notes, song.pedals])

  useEffect(() => {
    if (!handsOn || loadedKit) return
    let cancelled = false
    import('./pianoHands').then(async (module) => {
      const assets = await module.loadHandAssets()
      if (!cancelled) setHandsKit({ instance: new module.PianoHands(assets), build: module.buildPianoHandPlan, geometry: module.pianoGeometry })
    }).catch((error) => {
      console.warn('The piano hands could not be loaded; showing the keyboard without them.', error)
      if (!cancelled) setHandsFailed(true)
    })
    return () => { cancelled = true }
  }, [handsOn, loadedKit])
  useEffect(() => {
    let cancelled = false
    loadPianoManifest().then((value) => {
      if (cancelled) return
      setManifest(value)
      setVariantId(value.defaultVariant)
    }).catch((error) => {
      if (cancelled) return
      console.error('The piano models could not be listed.', error)
      setFailure('The 3D piano models could not be found, so a flat keyboard is shown instead. It follows the same notes.')
    })
    return () => { cancelled = true }
  }, [])
  const variant = manifest?.variants.find((v) => v.id === variantId)

  // The GL context and renderer live as long as the view; instrument and look changes only swap what it draws.
  useEffect(() => {
    const element = canvasElement
    if (!element) return
    const keep = !!(globalThis as { __mizanKitCapture?: boolean }).__mizanKitCapture
    const gl = element.getContext('webgl', { alpha: false, antialias: true, stencil: true, preserveDrawingBuffer: keep })
    if (!gl) {
      setFailure('The 3D piano needs WebGL, which this device has turned off. A flat keyboard follows the same notes instead.')
      return
    }
    let instance: KitRenderer
    try {
      instance = new KitRenderer(gl)
    } catch (error) {
      console.warn('The 3D piano renderer could not start.', error)
      setFailure('The 3D piano could not start its renderer. A flat keyboard follows the same notes instead.')
      return
    }
    const cap = (css: number) => Math.min(2, 2560 / Math.max(1, css))
    renderer.current = { renderer: instance, size: () => [element.width, element.height] }
    setRendererReady((value) => value + 1)
    const resize = (entries: ResizeObserverEntry[]) => {
      const box = entries[0]?.devicePixelContentBoxSize?.[0]
      const dpr = window.devicePixelRatio || 1
      const scale = Math.min(1, cap(element.clientWidth) / dpr)
      const width = Math.max(1, Math.round((box ? box.inlineSize : element.clientWidth * dpr) * scale))
      const height = Math.max(1, Math.round((box ? box.blockSize : element.clientHeight * dpr) * scale))
      if (width === element.width && height === element.height) return
      element.width = width
      element.height = height
      setGeneration((value) => value + 1)
    }
    const observer = new ResizeObserver(resize)
    try {
      observer.observe(element, { box: 'device-pixel-content-box' })
    } catch {
      observer.observe(element)
    }
    const onLost = (event: Event) => {
      event.preventDefault()
      renderer.current = null
      setLost(true)
    }
    const restored = () => { setLost(false); setContext((value) => value + 1) }
    element.addEventListener('webglcontextlost', onLost)
    element.addEventListener('webglcontextrestored', restored)
    return () => {
      observer.disconnect()
      element.removeEventListener('webglcontextlost', onLost)
      element.removeEventListener('webglcontextrestored', restored)
      renderer.current = null
      instance.dispose()
    }
  }, [context, canvasElement])

  const [scene, setScene] = useState<{ variant: string; look: Look; prepared: PreparedPiano; images: (ImageBitmap | null)[] } | null>(null)
  useEffect(() => {
    if (!variant) return
    let cancelled = false
    loadPiano(variant).then(async (asset) => {
      const images = await asset.images
      if (cancelled) return
      setScene({ variant: variant.id, look, prepared: preparedPiano(asset, look), images })
    }).catch((error) => {
      if (cancelled) return
      console.error(`The ${variant.name} model could not be loaded.`, error)
      setFailure(`The ${variant.name} model could not be loaded, so a flat keyboard is shown instead. It follows the same notes.`)
    })
    return () => { cancelled = true }
  }, [variant, look])
  const lastVariant = useRef<string | null>(null)
  useEffect(() => {
    const current = renderer.current
    if (!current || !scene) return
    if (lastVariant.current !== scene.variant) { current.renderer.clearTextures(); lastVariant.current = scene.variant }
    current.renderer.setScene(scene.prepared, scene.look, scene.images)
    lastSignature.current = ''
  }, [scene, context, rendererReady])
  const geometry = useMemo<PianoGeometry | null>(() => scene && handsKit ? handsKit.geometry(scene.prepared) : null, [scene, handsKit])
  const handPlan = useMemo<PianoHandPlan | null>(() => scene && handsKit ? handsKit.build(notes, (key) => scene.prepared.keys.has(key), song.pedals, song.bpm) : null, [scene, handsKit, notes, song.pedals, song.bpm])
  const timelines = useMemo(() => handsKit && handPlan && geometry ? handsKit.instance.compile(handPlan, geometry) : null, [handsKit, handPlan, geometry])
  useEffect(() => {
    const current = renderer.current
    if (!current) return
    current.renderer.setOverlays(handsKit ? handsKit.instance.overlays : [])
    lastSignature.current = ''
  }, [handsKit, scene, context, rendererReady])
  const handsShown = !!(handsKit && timelines)
  // Frame the whole keybed and front of the piano, leaving out the legs and music rest. The default perspective keeps
  // the end keys their true shape; the orthographic top view also leaves room for the wrists. Neither depends on notes.
  useEffect(() => {
    const current = renderer.current
    const element = canvas.current
    if (!current || !scene || !element) return
    const width = Math.max(1, element.clientWidth), height = Math.max(1, element.clientHeight)
    const keys = [...scene.prepared.keys.values()]
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    for (const key of keys) for (const point of [key.hinge, key.front, key.label]) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], point[k]); max[k] = Math.max(max[k], point[k])
    }
    // The keys' own width at the ends, a little case beyond them, and the key tops and fronts.
    min[0] -= 0.045; max[0] += 0.045; min[1] -= 0.02; max[1] += 0.03; min[2] -= 0.03; max[2] += 0.03
    const target = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
    let eye: number[], view: ReturnType<typeof multiply>, clip: number[][]
    if (topView) {
      // The overhead view keeps the whole keyboard and room for both wrists in frame, even on a narrow stage.
      const topMin = [min[0] - 0.12, min[1], min[2] - 0.08]
      const topMax = [max[0] + 0.12, max[1], max[2] + 0.28]
      const topTarget = [(topMin[0] + topMax[0]) / 2, target[1], (topMin[2] + topMax[2]) / 2]
      const topCorners: number[][] = []
      for (const x of [topMin[0], topMax[0]]) for (const y of [min[1], max[1]]) for (const z of [topMin[2], topMax[2]]) topCorners.push([x, y, z])
      const aspect = width / height
      const halfHeight = Math.max((topMax[2] - topMin[2]) / 2, (topMax[0] - topMin[0]) / (2 * aspect)) / 0.9
      eye = [topTarget[0], topTarget[1] + 4, topTarget[2]]
      view = multiply(orthographic(-halfHeight * aspect, halfHeight * aspect, -halfHeight, halfHeight, 0.1, 10),
        lookAt(eye, topTarget, [0, 0, -1]))
      clip = topCorners.map(([x, y, z]) => {
        const w = view[3] * x + view[7] * y + view[11] * z + view[15]
        return [(view[0] * x + view[4] * y + view[8] * z + view[12]) / w, (view[1] * x + view[5] * y + view[9] * z + view[13]) / w]
      })
    } else {
      const direction = normalize([0, 1.15, 1])
      const fov = 0.42
      const aspect = width / height
      const corners: number[][] = []
      for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push([x, y, z])
      const project = (distance: number) => {
        const eye = target.map((value, index) => value + direction[index] * distance)
        const view = multiply(perspective(fov, aspect, Math.max(0.05, distance - 1.5), distance + 3), lookAt(eye, target))
        const clip = corners.map(([x, y, z]) => {
          const w = view[3] * x + view[7] * y + view[11] * z + view[15]
          return [(view[0] * x + view[4] * y + view[8] * z + view[12]) / w, (view[1] * x + view[5] * y + view[9] * z + view[13]) / w]
        })
        return { eye, view, clip, extent: Math.max(...clip.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y)))) }
      }
      // The nearest camera that keeps the whole keybed inside the stage with a margin.
      let near = 0.2, far = 20
      for (let i = 0; i < 40; i++) { const middle = (near + far) / 2; if (project(middle).extent > 0.9) near = middle; else far = middle }
      const projected = project(far)
      eye = projected.eye
      view = projected.view
      clip = projected.clip
    }
    current.renderer.view = view
    current.renderer.eye = eye
    camera.current = { view, width, height }
    // How the keybed sits in the stage, for tests: its box corners on screen (all inside ±1 when it fits).
    if (section.current) section.current.dataset.frame = [Math.min(...clip.map((p) => p[0])), Math.max(...clip.map((p) => p[0])),
      Math.min(...clip.map((p) => p[1])), Math.max(...clip.map((p) => p[1]))].map((value) => value.toFixed(3)).join(',')
    if (section.current) section.current.dataset.framed = `${scene.variant}:${scene.look}`
    ;(globalThis as { __mizanPianoKeyAt?: (midi: number) => { x: number; y: number } | null }).__mizanPianoKeyAt = (midi) => {
      const key = scene.prepared.keys.get(midi)
      if (!key) return null
      const [kx, ky, kz] = key.label
      const w = view[3] * kx + view[7] * ky + view[11] * kz + view[15]
      return { x: (view[0] * kx + view[4] * ky + view[8] * kz + view[12]) / w * 0.5 + 0.5, y: (view[1] * kx + view[5] * ky + view[9] * kz + view[13]) / w * 0.5 + 0.5 }
    }
    lastSignature.current = ''
    lastLabels.current = '\u0000'
  }, [scene, generation, context, rendererReady, topView])

  useFrame(engine, (t) => {
    const loop = engine.loop
    const bar = measures(song)[Math.max(0, Math.min(song.bars - 1, loop ? loop.startBar - 1 : 0))]
    const feedback = feedbackAt(plan.strikes, t, {
      secondsPerBeat: 60 / Math.max(1, engine.getEffectiveQuarterBpm()),
      loop: loop ? { start: barStart(song, loop.startBar - 1), end: barStart(song, loop.endBar) } : null,
      countLength: bar ? Math.round(bar.beats / pulseBeats(bar)) : 4,
      sticking: true,
      reduced,
    }) as Map<KeyTarget, Feedback>
    // The notes at the playhead (playing or paused): coloured by hand with their written fingers, so the keyboard always shows what to play.
    const beat = t.countingIn ? -1 : t.beat
    const down: { key: number; note: PianoNote; start: number }[] = []
    for (const [key, list] of plan.held) for (const item of list) if (item.start <= beat + 1e-9 && beat < item.end - 1e-9) { down.push({ key, note: item.note, start: item.start }); break }
    // Keys move only while the music plays: a sounding key goes down over a few milliseconds and rises when its note ends.
    // Paused, every key rests and the keys at the playhead are only coloured, to show what to play next.
    const secondsPerBeat = 60 / Math.max(1, engine.getEffectiveQuarterBpm())
    const moving = t.playing && !t.countingIn
    for (const { key, note, start } of down) {
      const target: KeyTarget = `key:${key}`
      const tint = note.hand ? HAND_GLOW[note.hand] : UNASSIGNED_GLOW
      const f = feedback.get(target)
      feedback.set(target, { upcoming: f?.upcoming ?? 0, upcomingTint: f?.upcomingTint ?? tint, pulse: Math.max(f?.pulse ?? 0, 0.4), tint, tint2: tint, split: false,
        since: f?.since ?? 99, velocity: f?.velocity ?? note.velocity ?? 0.7, press: moving ? Math.min(1, (beat - start) * secondsPerBeat / 0.04) : 0 })
    }
    const pedalDown = (plan.pedals ?? []).filter((pedal) => pedal.startBeat <= beat + 1e-9 && beat < pedal.startBeat + pedal.beats - 1e-9).map((pedal) => pedal.controller)
    for (const controller of pedalDown)
      feedback.set(`pedal:${controller}`, { upcoming: 0, upcomingTint: [0, 0, 0], pulse: 0.3, tint: [0.75, 0.75, 0.8], tint2: [0.75, 0.75, 0.8], split: false, since: 99, velocity: 0.7, press: moving ? 1 : 0 })
    const chord = song.chordLabels?.find((label) => label.startBeat <= beat + 1e-9 && beat < label.startBeat + label.beats)?.symbol ?? ''
    // The hands are posed from the same clock; a moving pose redraws the frame, a still one does not.
    let handsSignature = ''
    if (handsKit && timelines && geometry && scene && renderer.current && !failure && !lost) {
      handsKit.instance.update(timelines, geometry, {
        beat: t.beat, playing: t.playing, countingIn: t.countingIn, secondsPerBeat, reduced,
        loop: loop ? { start: barStart(song, loop.startBar - 1), end: barStart(song, loop.endBar) } : null,
      }, true)
      handsSignature = (['left', 'right'] as const).map((side) => {
        const hand = handsKit.instance.state[side]
        return `${Math.round(hand.center * 1000)}:${hand.fingers.map((finger) => `${Math.round(finger.target[0] * 1000)},${Math.round(finger.target[1] * 1000)},${Math.round(finger.target[2] * 1000)}`).join(';')}`
      }).join('|')
    }
    const signature = `${handsSignature}#${[...feedback].map(([target, f]) => `${target}:${Math.round(f.pulse * 40)}:${Math.round(f.upcoming * 40)}:${f.press ?? 0}`).join(',')}`
    const current = renderer.current
    if (signature !== lastSignature.current && current && !failure && !lost && scene) {
      lastSignature.current = signature
      const [width, height] = current.size()
      try {
        current.renderer.draw(width, height, { hat: 'closed', feedback, selected: new Set() })
      } catch (error) {
        console.error('The 3D piano stopped drawing.', error)
        renderer.current = null
        setFailure('The 3D piano stopped drawing because of a graphics error. A flat keyboard follows the same notes instead.')
        return
      }
      ;(globalThis as { __mizanPianoFrame?: (canvas: HTMLCanvasElement, state: { feedback: typeof feedback; hands?: PianoHands['state'] }) => void }).__mizanPianoFrame?.(canvas.current!, { feedback, hands: handsSignature ? handsKit?.instance.state : undefined })
    }
    // Labels over the keys: for keys that are down, the written finger (when Fingering is on) and the letter (when Note
    // letters is on), in the hand's colour; for keys whose next note is coming (the ones that glow), the letter only.
    const labelled: { key: number; hand?: PianoNote['hand']; finger?: number; letter?: string; upcoming: boolean }[] = []
    for (const { key, note } of down) {
      const finger = fingering ? note.finger : undefined
      const letter = letters ? keyLetter(note, song.key) : undefined
      if (finger || letter) labelled.push({ key, hand: note.hand, finger, letter, upcoming: false })
    }
    if (letters) for (const [target, f] of feedback) {
      if (!target.startsWith('key:') || f.upcoming <= 0.05) continue
      const key = Number(target.slice(4))
      if (down.some((item) => item.key === key)) continue
      const next = plan.held.get(key)?.find((item) => item.start >= beat - 1e-9)?.note
      if (next) labelled.push({ key, hand: next.hand, letter: keyLetter(next, song.key), upcoming: true })
    }
    const labels = labelled.map(({ key, hand, finger, letter, upcoming }) => `${key}:${hand}:${finger ?? ''}:${letter ?? ''}:${upcoming}`).sort().join(',')
    const view = camera.current
    if (fingersLayer.current && scene && view && labels !== lastLabels.current) {
      lastLabels.current = labels
      // Each label sits over its key; where keys are too close for their labels, labels stack upward in rows, each
      // joined to its key by a short line, so every label stays readable however small the keyboard is drawn.
      const placed = labelled.filter(({ key }) => scene.prepared.keys.has(key)).map((label) => {
        const [x, y, z] = scene.prepared.keys.get(label.key)!.label
        const m = view.view
        const [px, py, , pw] = [0, 1, 2, 3].map((row) => m[row] * x + m[4 + row] * y + m[8 + row] * z + m[12 + row])
        return { ...label, x: (px / pw * 0.5 + 0.5) * view.width, y: (0.5 - py / pw * 0.5) * view.height, row: 0 }
      }).sort((a, b) => a.x - b.x)
      const gap = letters ? (fingering ? 34 : 26) : 20
      const rows: number[] = []
      for (const label of placed) {
        label.row = rows.findIndex((right) => label.x - right >= gap)
        if (label.row < 0) label.row = rows.length
        rows[label.row] = label.x
      }
      fingersLayer.current.replaceChildren(...placed.map(({ key, hand, finger, letter, upcoming, x, y, row }) => {
        const span = document.createElement('span')
          span.className = upcoming ? 'piano-finger piano-finger-next'
            : `piano-finger piano-finger-${hand ?? 'unassigned'}`
        span.dataset.key = String(key)
        if (letter) {
          const name = document.createElement('i')
          name.className = 'piano-letter'
          name.textContent = letter
          span.append(name)
        }
        if (finger) span.append(String(finger))
        span.style.left = `${x}px`
        span.style.top = `${y}px`
        span.style.setProperty('--lift', `${row * 21}px`)
        return span
      }))
    }
    if (section.current) {
      const pressed = down.map(({ key, note }) => `${key}${note.hand === 'left' ? 'L' : note.hand === 'right' ? 'R' : '?'}${note.finger ?? ''}`).sort().join(',')
      section.current.dataset.pressed = pressed
      section.current.dataset.depressed = [...feedback].filter(([target, f]) => target.startsWith('key:') && (f.press ?? 0) > 0).map(([target]) => target.slice(4)).join(',')
      section.current.dataset.upcoming = [...feedback].filter(([target, f]) => target.startsWith('key:') && f.upcoming > 0.05).map(([target]) => target.slice(4)).join(',')
      section.current.dataset.pedal = plan.pedals ? pedalDown.includes(64) ? 'down' : 'up' : 'none'
      section.current.dataset.chord = chord
      for (const pill of section.current.querySelectorAll<HTMLElement>('[data-hand]'))
        pill.toggleAttribute('data-lit', down.some(({ note }) => note.hand === pill.dataset.hand))
      for (const pill of section.current.querySelectorAll<HTMLElement>('[data-pedal]'))
        pill.toggleAttribute('data-lit', pedalDown.some((controller) => controller === Number(pill.dataset.pedal)))
      const chordPill = section.current.querySelector<HTMLElement>('[data-chord]')
      if (chordPill) chordPill.textContent = chord ? `Chord ${chord}` : 'Chord —'
      const notesNow = down.map(({ key, note }) =>
        `${noteName(key)}${note.hand ? `, ${note.hand} hand` : ''}${note.finger ? `, finger ${note.finger}` : ''}`).join('; ')
      const summary = `${moving}|${notesNow}`
      if (summary !== lastSummary.current && described.current) {
        lastSummary.current = summary
        described.current.textContent = !notesNow ? 'No notes at the playhead.' : moving ? `Keys down: ${notesNow}.` : `Paused. Notes to play at the playhead: ${notesNow}.`
      }
    }
  })
  // A value no label set can have, so the next frame always redraws the labels (even to none).
  useEffect(() => { lastSignature.current = ''; lastLabels.current = '\u0000' }, [scene, failure, lost, fingering, letters, topView])

  // Loading until the scene for the chosen instrument and look has arrived.
  const loading = !failure && !lost && (!scene || scene.variant !== variantId || scene.look !== look)
  const outside = variant ? notes.filter((note) => Math.round(note.midi) < variant.low || Math.round(note.midi) > variant.high).length : 0
  const chooseLook = (value: Look) => { session.look = value; setLook(value) }
  return (
    <section ref={section} className="practice-view practice-kit practice-piano" data-variant={variantId ?? ''} data-look={look} data-camera={topView ? 'top' : 'perspective'} data-ready={!!scene && !loading && !failure && !lost} data-lost={lost || undefined} data-hands-shown={handsShown ? 'true' : !handsOn ? 'off' : handsFailed ? 'failed' : 'loading'}
      style={{ ['--stage-bg' as string]: `rgb(${stageBackground(look).map((x) => Math.round(x * 255)).join(' ')})` }}
      aria-label="3D keyboard: keys glow as their notes approach and press while they sound, in the colour of the hand that plays them">
      <div className="kit-toolbar" title="Changes only how the piano looks; the notes, sounds and playback stay the same">

        <label className="kit-look">
          <span>Look</span>
          <select value={look} onChange={(event) => chooseLook(event.target.value as Look)}>
            {LOOKS.map((option) => <option key={option} value={option}>{LOOK_LABEL[option]}</option>)}
          </select>
        </label>
        <button type="button" className="kit-toggle" data-kit-toggle="top" aria-pressed={topView}
          onClick={() => setTopView((value) => { const next = !value; savePref('pianoTopView', next); return next })}>Top view</button>
        <button type="button" className="kit-toggle" data-kit-toggle="hands" aria-pressed={handsOn} onClick={toggleHands}>Hands</button>
      </div>
      {failure ? (
        <>
          <p className="practice-failure" role="status">{failure}</p>
          <HandsView song={song} engine={engine} fingering={fingering} letters={letters} />
        </>
      ) : (
        <div className="practice-stage" hidden={lost}>
          <canvas ref={attachCanvas} className="practice-canvas" aria-hidden="true" />
          <div ref={fingersLayer} className="piano-fingers" aria-hidden="true" />
          {loading && <p className="practice-note kit-notice" role="status">Loading the {variant?.name ?? 'piano'}…</p>}
        </div>
      )}
      {lost && !failure && <>
        <p className="practice-failure" role="status">The 3D piano lost its graphics context. It comes back when the device restores it; this flat keyboard follows the same notes meanwhile.</p>
        <HandsView song={song} engine={engine} fingering={fingering} letters={letters} />
      </>}
      <p ref={described} className="visually-hidden">No notes at the playhead.</p>
      <p className="practice-legend kit-legend">
        {notes.some((note) => note.hand) ? <>
          <span className="kit-pill kit-hand" data-hand="left"><b aria-hidden="true">L</b> Left hand</span>
          <span className="kit-pill kit-hand" data-hand="right"><b aria-hidden="true">R</b> Right hand</span>
        </> : <span className="kit-pill kit-state">No hand assignments</span>}
        {song.chordLabels?.length ? <span className="kit-pill" data-chord="">Chord —</span> : null}
        {plan.pedals
          ? [...new Set(plan.pedals.map((pedal) => pedal.controller))].map((controller) =>
            <span key={controller} className="kit-pill" data-pedal={controller}>{PEDAL_LABEL[controller]}</span>)
          : <span className="kit-pill kit-state">No pedalling written</span>}
        <span className="practice-note">
          {!fingering ? 'Finger numbers are off. ' : plan.fingered ? 'Finger numbers are the lesson\'s written fingering (1 thumb to 5 little finger). '
            : 'No fingering is written for this music, so no finger numbers are shown. '}
          {letters ? 'Letters name the keys that are down and the next keys to play. ' : ''}
          {outside ? `${outside} note${outside === 1 ? ' is' : 's are'} outside the piano's ${variant!.keys} keys and cannot be shown. ` : ''}
          Keys light as their notes approach and go down while they sound; paused, the notes at the playhead stay lit.
          {!handsOn ? '' : handsFailed ? ' The hands could not be loaded, so only the keyboard is shown.' : ' Hands show a suggested motion, not a recording.'}
          {handsShown && handPlan?.placedByPitch ? ' No hands are written for this music, so they are placed by pitch: left below middle C, right from middle C up.' : ''}
          {handsShown && handPlan && !handPlan.placedByPitch && handPlan.fingersSuggested && notes.length ? ' No fingering is written, so the fingers on the hands are suggestions.' : ''}
        </span>
      </p>
    </section>
  )
}
