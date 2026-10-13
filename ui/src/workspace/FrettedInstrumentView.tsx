import { useEffect, useMemo, useRef, useState } from 'react'
import { loadGlb } from './kitAsset'
import { useReducedMotion } from './hooks'
import { recordingSeconds } from './meter'
import {
  notesForTrack, planFrettedTab, visualStatePriority,
  type FrettedInstrumentConfig, type FrettedVisualState,
} from './fretboard'
import { FRETTED_STYLES, FRETTED_STYLE_LABEL, type FrettedStyle, type FrettedViewMode } from './frettedStyles'
import { FrettedRenderer, type FrettedFrame, type FrettedMarker } from './frettedRenderer'
import { FrettedTabView, type FrettedPracticeProps } from './FrettedTabView'
import './fretted.css'

export type FrettedInstrumentViewProps = FrettedPracticeProps & {
  style?: FrettedStyle
  onStyleChange?: (style: FrettedStyle) => void
  viewMode?: FrettedViewMode
  onViewModeChange?: (mode: FrettedViewMode) => void
  handedness?: 'right' | 'left'
  onHandednessChange?: (handedness: 'right' | 'left') => void
  feedback?: Readonly<Record<string, FrettedVisualState | undefined>>
  showTabStrip?: boolean
}

type Size = { width: number; height: number }
type Overlay = Pick<FrettedFrame, 'markers' | 'stringLabels' | 'fretLabels'>
type FrameHook = (canvas: HTMLCanvasElement, frame: FrettedFrame) => void
const EMPTY_FEEDBACK: Readonly<Record<string, FrettedVisualState | undefined>> = Object.freeze({})
const EMPTY_OVERLAY: Overlay = { markers: [], stringLabels: [], fretLabels: [] }
const frameHook = (name: '__mizanGuitarFrame' | '__mizanBassFrame') =>
  (globalThis as typeof globalThis & Record<string, FrameHook | undefined>)[name]
const stateRank = (state: FrettedMarker['state']): number =>
  state === 'playback' ? 5 : state === 'upcoming' ? 4 : visualStatePriority(state)
const chooseState = (a: FrettedMarker['state'], b: FrettedMarker['state']) => stateRank(a) >= stateRank(b) ? a : b

export function FrettedInstrumentView({
  song, track, trackId, beat, playing, countingIn = false, onPick,
  style: chosenStyle, onStyleChange, viewMode: chosenMode, onViewModeChange,
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
  const [localMode, setLocalMode] = useState<FrettedViewMode>('fretboard')
  const [localHandedness, setLocalHandedness] = useState<'right' | 'left'>('right')
  const [overlay, setOverlay] = useState<Overlay>(EMPTY_OVERLAY)
  const reduced = useReducedMotion()
  const mode = chosenMode ?? localMode
  const handedness = chosenHandedness ?? localHandedness
  const style = chosenStyle ?? localStyle
  const source = notesForTrack(song, track, trackId)
  const plan = useMemo(() => planFrettedTab(source, config), [source, config])
  const latest = useRef({ beat, playing, countingIn, mode, style, handedness, plan, feedback, song })
  latest.current = { beat, playing, countingIn, mode, style, handedness, plan, feedback, song }
  const selectMode = (value: FrettedViewMode) => {
    setLocalMode(value)
    onViewModeChange?.(value)
  }
  const selectHandedness = (value: 'right' | 'left') => {
    setLocalHandedness(value)
    onHandednessChange?.(value)
  }
  const selectStyle = (value: FrettedStyle) => {
    setLocalStyle(value)
    onStyleChange?.(value)
  }

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
    if (!renderer || !canvas || !size.width || !size.height) return
    let animation = 0
    let lastOverlayKey = ''
    const draw = (time: number) => {
      const current = latest.current
      const frame = renderer.draw(canvas.width, canvas.height, current.style, current.mode, time,
        current.plan, current.beat, (at) => recordingSeconds(current.song, at), current.feedback,
        reduced || current.countingIn, current.handedness)
      const key = frame.markers.map((marker) => `${marker.index}:${marker.x.toFixed(1)}:${marker.y.toFixed(1)}:${marker.state}`).join('|') +
        frame.stringLabels.map((label) => `${label.string}:${label.x.toFixed(1)}:${label.y.toFixed(1)}`).join('|') +
        frame.fretLabels.map((label) => `${label.fret}:${label.x.toFixed(1)}:${label.y.toFixed(1)}`).join('|')
      if (key !== lastOverlayKey) {
        lastOverlayKey = key
        setOverlay({ markers: [...frame.markers], stringLabels: [...frame.stringLabels], fretLabels: [...frame.fretLabels] })
      }
      if (section.current) {
        section.current.dataset.vibrating = frame.vibrations.filter((string) => string.amplitude > 0.00003).map((item) => item.string).join(',')
        section.current.dataset.vibrationFret = frame.vibrations.map((item) => `${item.string}:${item.fret}:${item.activeStartX.toFixed(4)}`).join(',')
        section.current.dataset.triangles = String(frame.triangles)
      }
      frameHook(config.id === 'guitar' ? '__mizanGuitarFrame' : '__mizanBassFrame')?.(canvas, frame)
      if (current.playing && !current.countingIn && !reduced) animation = requestAnimationFrame(draw)
    }
    if (playing && !countingIn && !reduced) animation = requestAnimationFrame(draw)
    else draw(performance.now())
    return () => cancelAnimationFrame(animation)
  }, [renderer, canvas, size, style, mode, handedness, plan, beat, playing, countingIn, feedback, song, reduced, config])

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
      data-view-mode={mode} data-handedness={handedness} data-loading={loading || undefined}
      aria-label={`3D ${config.name} practice view`}>
      <div className="fretted-view" data-style={style} data-view-mode={mode}>
        <div className="fretted-toolbar">
          <div className="fretted-mode" role="group" aria-label="Instrument view">
            <button type="button" aria-pressed={mode === 'fretboard'} onClick={() => selectMode('fretboard')}>Fretboard</button>
            <button type="button" aria-pressed={mode === 'whole'} onClick={() => selectMode('whole')}>Whole instrument</button>
          </div>
          <label>Handedness
            <select value={handedness} onChange={(event) => selectHandedness(event.target.value as 'right' | 'left')}>
              <option value="right">Right-handed</option>
              <option value="left">Left-handed</option>
            </select>
          </label>
          <details className="fretted-appearance">
            <summary>Appearance</summary>
            <label>Style
              <select value={style} onChange={(event) => selectStyle(event.target.value as FrettedStyle)}>
                {FRETTED_STYLES.map((item) => <option key={item} value={item}>{FRETTED_STYLE_LABEL[item]}</option>)}
              </select>
            </label>
          </details>
        </div>
        <div className="fretted-stage">
          <canvas ref={setCanvas} className="fretted-canvas" style={{ aspectRatio: mode === 'fretboard' ? '2.4' : '2.15' }} aria-hidden="true" />
          {loading && <p className="fretted-instrument-note" role="status">Loading the original instrument model…</p>}
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
                aria-label={`${marker.position.pitchName}, string ${marker.position.conventionalStringNumber}, fret ${marker.position.fret}; ${state === 'playback' ? 'current playback' : state}`}
                title={`${marker.position.pitchName} · string ${marker.position.conventionalStringNumber}, fret ${marker.position.fret}`}
                onClick={() => onPick(plan.find((note) => note.index === marker.index)?.startBeat ?? beat)}>
                {marker.label}
              </button>
            })}
          </div>}
        </div>
        <p className="fretted-instrument-note">
          Standard tuning · {names}. Positions are estimated from MIDI pitch; the music does not identify recorded fingering.
          {playing && !countingIn ? ' Current playback and the next note follow the transport.' : ' Paused: the playhead position stays highlighted.'}
        </p>
      </div>
      {showTabStrip && <div className="fretted-strip" style={{ minWidth: 0 }}>
        <FrettedTabView song={song} track={track} trackId={trackId} beat={beat} playing={playing}
          countingIn={countingIn} onPick={onPick} config={config} />
      </div>}
    </section>
  )
}
