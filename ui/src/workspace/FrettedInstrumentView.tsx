import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadGlb } from './kitAsset'
import { useFrame, useReducedMotion } from './hooks'
import { barStart } from './meter'
import {
  notesForTrack, planFrettedTab, visualStatePriority,
  type FrettedInstrumentConfig, type FrettedVisualState,
} from './fretboard'
import { LOOKS, LOOK_LABEL } from './prefs'
import type { FrettedStyle } from './frettedStyles'
import { FrettedRenderer, type FrettedFrame, type FrettedMarker } from './frettedRenderer'
import { FrettedTabView, type FrettedPracticeProps } from './FrettedTabView'
import type { Engine, Transport } from './engine'
import './fretted.css'

export type FrettedInstrumentViewProps = FrettedPracticeProps & {
  engine?: Engine
  style?: FrettedStyle
  onStyleChange?: (style: FrettedStyle) => void
  handedness?: 'right' | 'left'
  onHandednessChange?: (handedness: 'right' | 'left') => void
  feedback?: Readonly<Record<string, FrettedVisualState | undefined>>
  showTabStrip?: boolean
}

type Size = { width: number; height: number }
type Overlay = Pick<FrettedFrame, 'markers' | 'stringLabels' | 'fretLabels' | 'plucks'>
type FrameHook = (canvas: HTMLCanvasElement, frame: FrettedFrame) => void
const EMPTY_FEEDBACK: Readonly<Record<string, FrettedVisualState | undefined>> = Object.freeze({})
const EMPTY_OVERLAY: Overlay = { markers: [], stringLabels: [], fretLabels: [], plucks: [] }
const frameHook = (name: '__mizanGuitarFrame' | '__mizanBassFrame') =>
  (globalThis as typeof globalThis & Record<string, FrameHook | undefined>)[name]
const stateRank = (state: FrettedMarker['state']): number =>
  state === 'playback' ? 5 : state === 'upcoming' ? 4 : visualStatePriority(state)
const chooseState = (a: FrettedMarker['state'], b: FrettedMarker['state']) => stateRank(a) >= stateRank(b) ? a : b

export function FrettedInstrumentView({
  song, track, trackId, beat, playing, countingIn = false, onPick, engine,
  style: chosenStyle, onStyleChange,
  handedness: chosenHandedness, onHandednessChange,
  feedback = EMPTY_FEEDBACK, showTabStrip = true, config,
}: FrettedInstrumentViewProps & { config: FrettedInstrumentConfig }) {
  const section = useRef<HTMLElement>(null)
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const [renderer, setRenderer] = useState<FrettedRenderer | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [localStyle, setLocalStyle] = useState<FrettedStyle>('Realistic')
  const [localHandedness, setLocalHandedness] = useState<'right' | 'left'>('right')
  const [overlay, setOverlay] = useState<Overlay>(EMPTY_OVERLAY)
  const reduced = useReducedMotion()
  const handedness = chosenHandedness ?? localHandedness
  const style = chosenStyle ?? localStyle
  const source = notesForTrack(song, track, trackId)
  const plan = useMemo(() => planFrettedTab(source, config), [source, config])
  const latest = useRef({ beat, playing, countingIn, style, handedness, plan, feedback, song })
  const lastOverlayKey = useRef('')
  const lastStaticFrame = useRef<string | null>(null)
  useEffect(() => {
    latest.current = { beat, playing, countingIn, style, handedness, plan, feedback, song }
  }, [beat, playing, countingIn, style, handedness, plan, feedback, song])
  const selectHandedness = (value: 'right' | 'left') => {
    setLocalHandedness(value)
    onHandednessChange?.(value)
  }
  const selectStyle = (value: FrettedStyle) => {
    setLocalStyle(value)
    onStyleChange?.(value)
  }

  const drawFrame = useCallback((transport?: Transport) => {
    if (!renderer || !canvas || !size.width || !size.height) return
    const current = latest.current
    const clock = transport ?? {
      beat: current.beat, playing: current.playing, countingIn: current.countingIn, countBeat: 0,
    }
    const loop = engine?.loop ? {
      start: barStart(current.song, engine.loop.startBar - 1),
      end: barStart(current.song, engine.loop.endBar),
    } : null
    const secondsPerBeat = 60 / Math.max(1, engine?.getEffectiveQuarterBpm() ?? current.song.bpm)
    const frame = renderer.draw(canvas.width, canvas.height, current.style, performance.now(),
      current.plan, clock.beat, secondsPerBeat, clock.playing, clock.countingIn, loop,
      current.feedback, reduced, current.handedness)
    const key = frame.markers.map((marker) =>
      `${marker.index}:${marker.x.toFixed(1)}:${marker.y.toFixed(1)}:${marker.state}`).join('|') +
      frame.stringLabels.map((label) => `${label.string}:${label.x.toFixed(1)}:${label.y.toFixed(1)}`).join('|') +
      frame.fretLabels.map((label) => `${label.fret}:${label.x.toFixed(1)}:${label.y.toFixed(1)}`).join('|') +
      frame.plucks.map((pluck) => `${pluck.index}:${pluck.string}:${pluck.x.toFixed(1)}:${pluck.y.toFixed(1)}`).join('|')
    if (key !== lastOverlayKey.current) {
      lastOverlayKey.current = key
      setOverlay({ markers: [...frame.markers], stringLabels: [...frame.stringLabels],
        fretLabels: [...frame.fretLabels], plucks: [...frame.plucks] })
    }
    if (section.current) {
      section.current.dataset.vibrating = frame.vibrations.map((item) => item.string).join(',')
      section.current.dataset.vibrationFret = frame.vibrations.map((item) =>
        `${item.string}:${item.fret}:${item.activeStartX.toFixed(4)}`).join(',')
      section.current.dataset.triangles = String(frame.triangles)
    }
    frameHook(config.id === 'guitar' ? '__mizanGuitarFrame' : '__mizanBassFrame')?.(canvas, frame)
  }, [canvas, config, engine, reduced, renderer, size.height, size.width])

  useEffect(() => {
    const element = canvas
    if (!element) return
    const resize = () => {
      const box = element.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const next = { width: Math.max(1, Math.round(box.width * dpr)), height: Math.max(1, Math.round(box.height * dpr)) }
      if (next.width === element.width && next.height === element.height) return
      element.width = next.width
      element.height = next.height
      setSize(next)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    return () => observer.disconnect()
  }, [canvas])

  useEffect(() => {
    const element = canvas
    if (!element) return
    let cancelled = false
    let instance: FrettedRenderer | null = null
    setLoading(true)
    loadGlb(config.file).then(async (asset) => {
      const images = await asset.images
      if (cancelled) return
      const capture = globalThis as { __mizanGuitarCapture?: boolean; __mizanBassCapture?: boolean }
      const keep = config.id === 'guitar' ? !!capture.__mizanGuitarCapture : !!capture.__mizanBassCapture
      const gl = element.getContext('webgl', { alpha: false, antialias: true, preserveDrawingBuffer: keep })
      if (!gl) throw new Error('WebGL is unavailable on this device.')
      instance = new FrettedRenderer(gl, asset, config, images)
      if (cancelled) { instance.dispose(); return }
      setFailure(null)
      setRenderer(instance)
      setLoading(false)
    }).catch((error: unknown) => {
      if (cancelled) return
      console.error(`${config.name} visualization could not load.`, error)
      setFailure(`The 3D ${config.name.toLowerCase()} could not load. The tablature remains available below.`)
      setLoading(false)
    })
    const lost = (event: Event) => { event.preventDefault(); setFailure('The 3D view lost its graphics context. Reload the practice view to restore it.') }
    element.addEventListener('webglcontextlost', lost)
    return () => {
      cancelled = true
      element.removeEventListener('webglcontextlost', lost)
      instance?.dispose()
      setRenderer(null)
    }
  }, [canvas, config])

  useEffect(() => {
    if (engine) return
    drawFrame()
  }, [drawFrame, engine, style, handedness, plan, beat, playing, countingIn, feedback, song])
  useEffect(() => {
    if (!engine) return
    lastStaticFrame.current = null
    drawFrame(engine.read())
  }, [drawFrame, engine, style, handedness, plan, feedback, song])
  useFrame(engine ?? null, (transport) => {
    const loop = engine?.loop
    const staticFrame = `${transport.beat}:${loop ? `${loop.startBar}:${loop.endBar}` : ''}`
    if (!transport.playing && lastStaticFrame.current === staticFrame) return
    lastStaticFrame.current = transport.playing ? null : staticFrame
    drawFrame(transport)
  })

  const merge = (previous: FrettedMarker['state'] | undefined, next: FrettedMarker['state']) =>
    previous ? chooseState(previous, next) : next
  const states = new Map<string, FrettedMarker['state']>()
  for (const [key, state] of Object.entries(feedback)) if (state) states.set(key, state)
  for (const marker of overlay.markers) {
    const key = `Position_S${marker.position.string}_F${marker.position.fret}`
    states.set(key, merge(states.get(key), marker.state))
  }
  const getLabelStyle = (x: number, y: number) => ({
    left: `${(x / Math.max(1, size.width)) * 100}%`,
    top: `${(y / Math.max(1, size.height)) * 100}%`,
  })
  const names = config.strings.map((item) => item.name).join(', ')

  return (
    <section ref={section} className="fretted-practice" data-instrument={config.id} data-style={style}
      data-handedness={handedness} data-playing={playing && !countingIn}
      data-counting-in={countingIn || undefined} data-loading={loading || undefined}
      aria-label={`3D ${config.name} practice view`}>
      <div className="fretted-view" data-style={style}>
        <div className="kit-toolbar fretted-toolbar">
          <label className="kit-look">Look
            <select aria-label="Look" value={style} onChange={(event) => selectStyle(event.target.value as FrettedStyle)}>
              {LOOKS.map((item) => <option key={item} value={item}>{LOOK_LABEL[item]}</option>)}
            </select>
          </label>
          <label className="kit-look">Handedness
            <select aria-label="Handedness" value={handedness} onChange={(event) => selectHandedness(event.target.value as 'right' | 'left')}>
              <option value="right">Right-handed</option>
              <option value="left">Left-handed</option>
            </select>
          </label>
        </div>
        <div className="fretted-stage">
          <canvas ref={setCanvas} className="fretted-canvas" aria-hidden="true" />
          {loading && <p className="fretted-loading" role="status">Loading the original instrument model…</p>}
          {failure && <p className="fretted-failure" role="status">{failure}</p>}
          {!failure && <div className="fretted-overlay">
            <svg aria-hidden="true" viewBox={`0 0 ${Math.max(1, size.width)} ${Math.max(1, size.height)}`}
              preserveAspectRatio="none"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 0, pointerEvents: 'none' }}>
              {overlay.markers.filter((marker) => marker.x !== marker.anchorX || marker.y !== marker.anchorY).map((marker) =>
                <line key={`marker-link-${marker.index}-${marker.position.string}-${marker.position.fret}`}
                  x1={marker.anchorX} y1={marker.anchorY} x2={marker.x} y2={marker.y}
                  stroke="#283642" strokeOpacity="0.78" strokeWidth="1.5" />)}
            </svg>
            {overlay.stringLabels.map((label) =>
              <span key={`string-${label.string}`} className="fretted-overlay-string-label"
                style={getLabelStyle(label.x, label.y)}>{label.name}</span>)}
            {overlay.fretLabels.map((label) =>
              <span key={`fret-${label.fret}`} className="fretted-overlay-fret-label"
                style={getLabelStyle(label.x, label.y)}>{label.fret}</span>)}
            {overlay.markers.map((marker) => {
              const state = states.get(`Position_S${marker.position.string}_F${marker.position.fret}`) ?? marker.state
              return <button key={`${marker.index}:${marker.state}`} type="button" className="fretted-position"
                style={getLabelStyle(marker.x, marker.y)} data-state={state} data-string={marker.position.string}
                data-fret={marker.position.fret}
                aria-label={`${marker.position.pitchName}, string ${marker.position.conventionalStringNumber}, ${marker.position.fret === 0 ? 'open string, no fret press' : `fret ${marker.position.fret}`}; ${state === 'playback' ? 'playhead position' : state}`}
                title={`${marker.position.pitchName} · string ${marker.position.conventionalStringNumber} · ${marker.position.fret === 0 ? 'open, no fret press' : `fret ${marker.position.fret}`}`}
                onClick={() => onPick(plan.find((note) => note.index === marker.index)?.startBeat ?? beat)}>
                {marker.label}
              </button>
            })}
            {overlay.plucks.map((pluck) =>
              <span key={`${pluck.index}:${pluck.string}`} className="fretted-pluck" data-string={pluck.string}
                style={getLabelStyle(pluck.x, pluck.y)}
                title={`Pluck ${pluck.name}, string ${pluck.conventionalStringNumber}`} aria-hidden="true" />)}
          </div>}
        </div>
        <p className="fretted-instrument-note">
          <strong>O = open string: play without pressing a fret.</strong> Standard tuning · {names}. Positions are estimated from MIDI pitch, not recorded fingering.
          {' '}{countingIn ? 'The first note is previewed during the count-in; plucks start with the music.' :
            playing ? 'Current and upcoming notes follow playback; a flash by the pickup marks each pluck.' :
              'Paused: the playhead stays lit, with no pluck or string vibration.'}
        </p>
      </div>
      {showTabStrip && <div className="fretted-strip" style={{ minWidth: 0 }}>
        <FrettedTabView song={song} track={track} trackId={trackId} beat={beat} playing={playing}
          countingIn={countingIn} onPick={onPick} config={config} />
      </div>}
    </section>
  )
}
