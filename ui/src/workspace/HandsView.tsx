import { useEffect, useMemo, useRef } from 'react'
import type { Engine } from './engine'
import { useFrame } from './hooks'
import { keyOf, suggestFingers, type Finger } from './fingers'
import { noteName, type PianoNote, type Song } from './song'

type Props = { song: Song; engine: Engine }

const RIGHT = '#0d7a63'
const LEFT = '#4a4f54'
const BLACK = new Set([1, 3, 6, 8, 10])

/** A playback-synced keyboard: keys sounding now, by hand, with estimated finger numbers. */
export function HandsView({ song, engine }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const section = useRef<HTMLElement>(null)
  const notes = song.piano
  const fingers = useMemo(() => suggestFingers(notes), [notes])
  const ordered = useMemo(() => [...notes].sort((a, b) => a.startBeat - b.startBeat), [notes])
  const longest = useMemo(() => ordered.reduce((value, note) => Math.max(value, note.beats), 0), [ordered])
  const range = useMemo(() => {
    const keys = notes.map((note) => keyOf(note.midi))
    let low = keys.length ? Math.floor(Math.min(...keys) / 12) * 12 : 48
    let high = keys.length ? Math.ceil((Math.max(...keys) + 1) / 12) * 12 - 1 : 83
    if (high - low < 23) high = low + 23
    low = Math.max(21, low)
    high = Math.min(108, high)
    return { low, high }
  }, [notes])
  const lastActive = useRef('')
  const lastDrawn = useRef('')
  const described = useRef<HTMLParagraphElement>(null)
  // A new song (new notes, fingers or key range) always redraws.
  useEffect(() => {
    lastDrawn.current = ''
  }, [notes])

  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      const ratio = window.devicePixelRatio || 1
      element.width = Math.round(element.clientWidth * ratio)
      element.height = Math.round(element.clientHeight * ratio)
      // Resizing clears the canvas.
      lastDrawn.current = ''
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useFrame(engine, (t) => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return

    // Notes sounding now, from the same transport beat that drives the score and audio.
    const active: PianoNote[] = []
    let first = 0
    let last = ordered.length
    while (first < last) {
      const middle = (first + last) >> 1
      if (ordered[middle].startBeat <= t.beat) first = middle + 1
      else last = middle
    }
    for (let index = first - 1; index >= 0 && ordered[index].startBeat >= t.beat - longest; index--) {
      const note = ordered[index]
      if (t.beat < note.startBeat + note.beats) active.push(note)
    }
    const pressed = new Map<number, { note: PianoNote; finger?: Finger }>()
    for (const note of active) pressed.set(keyOf(note.midi), { note, finger: fingers.get(note) })
    // Redraw only when what is shown changes; a paused or steady transport costs nothing per frame.
    const state = [...pressed].sort(([a], [b]) => a - b)
      .map(([key, { note, finger }]) => `${key}:${note.hand}:${finger?.finger ?? ''}:${Math.round((note.midi - key) * 100)}`).join(',')
    const signature = `${element.width}x${element.height}|${range.low}-${range.high}|${state}`
    if (signature === lastDrawn.current) return
    lastDrawn.current = signature
    const ratio = window.devicePixelRatio || 1
    const width = element.width / ratio
    const height = element.height / ratio
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)

    const whites: number[] = []
    for (let key = range.low; key <= range.high; key++) if (!BLACK.has(key % 12)) whites.push(key)
    const top = 34
    const keyHeight = height - top - 6
    const whiteWidth = width / whites.length
    const xOf = new Map<number, { x: number; w: number; black: boolean }>()
    whites.forEach((key, index) => xOf.set(key, { x: index * whiteWidth, w: whiteWidth, black: false }))
    for (let key = range.low; key <= range.high; key++) {
      if (!BLACK.has(key % 12)) continue
      const left = xOf.get(key - 1)
      if (left) xOf.set(key, { x: left.x + whiteWidth * 0.68, w: whiteWidth * 0.64, black: true })
    }
    const fill = (key: number) => {
      const hit = pressed.get(key)
      return hit ? (hit.note.hand === 'left' ? LEFT : RIGHT) : null
    }
    for (const key of whites) {
      const box = xOf.get(key)!
      context.fillStyle = fill(key) ?? '#ffffff'
      context.fillRect(box.x + 0.5, top, box.w - 1, keyHeight)
      context.strokeStyle = '#c9cdd1'
      context.strokeRect(box.x + 0.5, top + 0.5, box.w - 1, keyHeight - 1)
      if (key % 12 === 0 && !pressed.has(key)) {
        context.fillStyle = '#6b7177'
        context.font = '500 10px "Archivo Variable", sans-serif'
        context.textAlign = 'center'
        context.fillText(`C${key / 12 - 1}`, box.x + box.w / 2, top + keyHeight - 8)
      }
    }
    for (let key = range.low; key <= range.high; key++) {
      const box = xOf.get(key)
      if (!box?.black) continue
      context.fillStyle = fill(key) ?? '#1b1d1f'
      context.fillRect(box.x, top, box.w, keyHeight * 0.62)
    }
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    for (const [key, { note, finger }] of pressed) {
      const box = xOf.get(key)
      if (!box) continue
      const y = box.black ? top + keyHeight * 0.5 : top + keyHeight - 16
      if (finger) {
        context.fillStyle = '#ffffff'
        context.font = '700 13px "Archivo Variable", sans-serif'
        context.fillText(String(finger.finger), box.x + box.w / 2, y)
      }
      const cents = Math.round((note.midi - key) * 100)
      if (cents) {
        context.fillStyle = '#111111'
        context.font = '600 10px "Archivo Variable", sans-serif'
        context.fillText(`${cents > 0 ? '+' : ''}${cents}¢`, box.x + box.w / 2, top - 6)
      }
    }
    // Illustrative hand spans above the keys, labelled so hands never rely on colour alone.
    for (const hand of ['left', 'right'] as const) {
      const keys = [...pressed].filter(([, value]) => value.note.hand === hand || (hand === 'right' && value.note.hand !== 'left'))
        .map(([key]) => xOf.get(key)).filter((box) => box !== undefined)
      if (!keys.length) continue
      const from = Math.min(...keys.map((box) => box.x))
      const to = Math.max(...keys.map((box) => box.x + box.w))
      context.strokeStyle = hand === 'left' ? LEFT : RIGHT
      context.lineWidth = 3
      context.lineCap = 'round'
      context.beginPath()
      context.moveTo(from + 3, 20)
      context.lineTo(to - 3, 20)
      context.stroke()
      context.fillStyle = hand === 'left' ? LEFT : RIGHT
      context.font = '700 11px "Archivo Variable", sans-serif'
      context.fillText(hand === 'left' ? 'L' : 'R', (from + to) / 2, 9)
    }

    const sounding = [...pressed].sort(([a], [b]) => a - b)
    const summary = sounding
      .map(([, { note, finger }]) => `${noteName(note.midi)}${note.hand === 'left' ? ' L' : ' R'}${finger ? finger.finger : ''}`).join(', ')
    if (summary !== lastActive.current && section.current) {
      lastActive.current = summary
      section.current.dataset.active = summary
      // Readable on demand by assistive technology, without announcing every change while playing.
      if (described.current) described.current.textContent = sounding.length
        ? `Sounding now: ${sounding.map(([, { note, finger }]) =>
          `${noteName(note.midi)}, ${note.hand === 'left' ? 'left' : 'right'} hand${finger ? `, finger ${finger.finger}` : ''}`).join('; ')}.`
        : 'No keys sounding.'
    }
  })

  return (
    <section ref={section} className="practice-view practice-hands" aria-label="Hands and keys: the keys sounding now, by hand, with estimated finger numbers">
      <canvas ref={canvas} className="practice-canvas" aria-hidden="true" />
      <p ref={described} className="visually-hidden">No keys sounding.</p>
      <p className="practice-legend">
        <span className="legend-key legend-right" aria-hidden="true" /> right hand
        <span className="legend-key legend-left" aria-hidden="true" /> left hand
        <span className="practice-note">Finger numbers are suggestions from note spacing, not detected fingering.</span>
      </p>
    </section>
  )
}
