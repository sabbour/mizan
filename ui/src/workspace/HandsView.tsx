import { useEffect, useMemo, useRef } from 'react'
import type { Engine } from './engine'
import { useFrame, useReducedMotion } from './hooks'
import { keyOf, suggestFingers, type Finger } from './fingers'
import { barStart, measures, pulseBeats } from './meter'
import { keyLetter, noteName, type PianoNote, type Song } from './song'
import type { KeyTarget, Vec3 } from './kitAsset'
import { feedbackAt, type Strike } from './kitFeedback'

type Props = {
  song: Song
  engine: Engine
  /** Finger numbers on the keys (written, or suggested where none are written). */
  fingering?: boolean
  /** Note letters on the keys that are sounding or about to be played. */
  letters?: boolean
}

// The hand colours of the score letters and the 3D piano: blue left, orange right.
const RIGHT = '#a64800'
const LEFT = '#1b5cb5'
const UNASSIGNED = '#757575'
const rgb = (colour: Vec3, alpha = 1) => `rgb(${colour.map((value) => Math.round(value * 255)).join(' ')} / ${alpha})`
/** Mix a hex colour toward a lit tint, `amount` 0..1. */
const mix = (hex: string, tint: Vec3, amount: number) => {
  const base = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
  return rgb(base.map((value, index) => value + (tint[index] - value) * amount) as Vec3)
}
const BLACK = new Set([1, 3, 6, 8, 10])

/** A white key's width as a share of its length: about a real piano's, so few notes never stretch a handful of keys across the view. */
const KEY_SHAPE = 1 / 4.6

/** A playback-synced keyboard: keys sounding now, by hand, with finger numbers and note letters when they are switched on. */
export function HandsView({ song, engine, fingering = true, letters = false }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const reduced = useReducedMotion()
  const section = useRef<HTMLElement>(null)
  const notes = song.piano
  // Written fingering when the music has it (lessons); otherwise suggestions from note spacing, labelled as such.
  const handAssignments = notes.length > 0 && notes.every((note) => note.hand != null)
  const written = useMemo(() => notes.some((note) => note.finger), [notes])
  const fingers = useMemo(() => written
    ? new Map(notes.filter((note) => note.finger && note.hand).map((note) => [note, { hand: note.hand!, finger: note.finger! } as Finger]))
    : suggestFingers(notes), [notes, written])
  const ordered = useMemo(() => [...notes].sort((a, b) => a.startBeat - b.startBeat), [notes])
  // Each key's strikes for the shared feedback: the same approach glow and hit pulse as the 3D piano and kit.
  const strikes = useMemo(() => {
    const map = new Map<KeyTarget, Strike[]>()
    for (const note of ordered) {
      const target: KeyTarget = `key:${keyOf(note.midi)}`
      const list = map.get(target) ?? []
      const last = list.at(-1)
      if (last && Math.abs(last.beat - note.startBeat) < 1e-9) {
        if (last.hand && note.hand && last.hand !== note.hand) last.hand = 'both'
        else last.hand ??= note.hand
      }
      else list.push({ beat: note.startBeat, velocity: note.velocity ?? 0.7, specified: true, hand: note.hand })
      map.set(target, list)
    }
    return map
  }, [ordered])
  const longest = useMemo(() => ordered.reduce((value, note) => Math.max(value, note.beats), 0), [ordered])
  // Each key's notes in time order, to name the note a glowing key is about to play.
  const byKey = useMemo(() => {
    const map = new Map<number, PianoNote[]>()
    for (const note of ordered) map.set(keyOf(note.midi), [...map.get(keyOf(note.midi)) ?? [], note])
    return map
  }, [ordered])
  // The octaves the music needs; the drawn keyboard adds octaves around them to fill the view at a natural key shape.
  const needed = useMemo(() => {
    const keys = notes.map((note) => keyOf(note.midi))
    let low = keys.length ? Math.floor(Math.min(...keys) / 12) * 12 : 48
    let high = keys.length ? Math.ceil((Math.max(...keys) + 1) / 12) * 12 - 1 : 83
    if (high - low < 23) high = low + 23
    return { low: Math.max(21, low), high: Math.min(108, high) }
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

    // Notes at the playhead, from the same transport beat that drives the score and audio; none while counting in.
    const beat = t.countingIn ? -Infinity : t.beat
    const sounding = t.playing && !t.countingIn
    const active: PianoNote[] = []
    let first = 0
    let last = ordered.length
    while (first < last) {
      const middle = (first + last) >> 1
      if (ordered[middle].startBeat <= beat) first = middle + 1
      else last = middle
    }
    for (let index = first - 1; index >= 0 && ordered[index].startBeat >= beat - longest; index--) {
      const note = ordered[index]
      if (beat < note.startBeat + note.beats) active.push(note)
    }
    const pressed = new Map<number, { note: PianoNote; finger?: Finger }>()
    for (const note of active) pressed.set(keyOf(note.midi), { note, finger: fingers.get(note) })
    // From the playback clock alone, so pausing, seeking, looping and speed changes need no timers: paused, nothing pulses.
    const loop = engine.loop
    const opening = measures(song)[Math.max(0, Math.min(song.bars - 1, loop ? loop.startBar - 1 : 0))]
    const feedback = feedbackAt(strikes, t, {
      secondsPerBeat: 60 / Math.max(1, engine.getEffectiveQuarterBpm()),
      loop: loop ? { start: barStart(song, loop.startBar - 1), end: barStart(song, loop.endBar) } : null,
      countLength: opening ? Math.round(opening.beats / pulseBeats(opening)) : 4,
      sticking: true,
      reduced,
    })
    const lit = (key: number) => feedback.get(`key:${key}`)
    // Redraw only when what is shown changes; a paused or steady transport costs nothing per frame.
    const state = [...pressed].sort(([a], [b]) => a - b)
      .map(([key, { note, finger }]) => `${key}:${note.hand}:${finger?.finger ?? ''}:${Math.round((note.midi - key) * 100)}`).join(',')
    const glow = [...feedback].map(([target, f]) => `${target}:${Math.round(f.pulse * 20)}:${Math.round(f.upcoming * 20)}`).join(',')
    const signature = `${element.width}x${element.height}|${needed.low}-${needed.high}|${state}|${glow}|${sounding}|${fingering}|${letters}`
    if (signature === lastDrawn.current) return
    lastDrawn.current = signature
    const ratio = window.devicePixelRatio || 1
    const width = element.width / ratio
    const height = element.height / ratio
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)

    const top = 34
    const keyHeight = height - top - 6
    // Keys keep a piano's proportions: the range grows by octaves, alternately below and above the music, until the
    // keyboard fills the width; if all 88 keys fit with room to spare, they are drawn at the natural width and centred.
    const natural = Math.max(14, Math.min(34, keyHeight * KEY_SHAPE))
    const whiteCount = (low: number, high: number) => { let count = 0; for (let key = low; key <= high; key++) if (!BLACK.has(key % 12)) count++; return count }
    let low = needed.low, high = needed.high
    for (let below = true; whiteCount(low, high) * natural < width && (low > 21 || high < 108); below = !below) {
      if (below && low > 21) low = Math.max(21, low - 12)
      else if (high < 108) high = Math.min(108, high + 12)
      else low = Math.max(21, low - 12)
    }
    const range = { low, high }
    const whites: number[] = []
    for (let key = range.low; key <= range.high; key++) if (!BLACK.has(key % 12)) whites.push(key)
    const whiteWidth = Math.min(width / whites.length, natural * 1.25)
    const left = (width - whiteWidth * whites.length) / 2
    const xOf = new Map<number, { x: number; w: number; black: boolean }>()
    whites.forEach((key, index) => xOf.set(key, { x: left + index * whiteWidth, w: whiteWidth, black: false }))
    for (let key = range.low; key <= range.high; key++) {
      if (!BLACK.has(key % 12)) continue
      const below = xOf.get(key - 1)
      if (below) xOf.set(key, { x: below.x + whiteWidth * 0.68, w: whiteWidth * 0.64, black: true })
    }
    // A key at the playhead takes its hand's colour, brightened by the hit pulse; a coming note tints its key as it nears.
    const fill = (key: number, rest: string) => {
      const hit = pressed.get(key)
      const f = lit(key)
      if (hit) {
        const colour = hit.note.hand === 'left' ? LEFT : hit.note.hand === 'right' ? RIGHT : UNASSIGNED
        return f && f.pulse > 0.02 ? mix(colour, [1, 1, 1], Math.min(0.4, f.pulse * 0.4)) : colour
      }
      return f && f.upcoming > 0.02 ? mix(rest, f.upcomingTint, Math.min(0.6, f.upcoming * 0.6)) : rest
    }
    // The hit pulse also glows around its key, in the hand's colour, fading with the pulse.
    const halo = (key: number, x: number, y: number, w: number, h: number) => {
      const f = lit(key)
      if (!f || f.pulse < 0.02) return
      context.save()
      context.shadowColor = rgb(f.tint, Math.min(1, f.pulse))
      context.shadowBlur = 14 * f.pulse
      context.strokeStyle = rgb(f.tint, Math.min(1, f.pulse))
      context.lineWidth = 2
      context.strokeRect(x + 1, y + 1, w - 2, h - 2)
      context.restore()
    }
    // Letters on the keys sounding now and on the keys whose next note is coming (the ones that glow), when switched on.
    const named = new Map<number, { letter: string; upcoming: boolean }>()
    if (letters) {
      for (const [key, { note }] of pressed) named.set(key, { letter: keyLetter(note, song.key), upcoming: false })
      for (let key = range.low; key <= range.high; key++) {
        if (pressed.has(key) || !((lit(key)?.upcoming ?? 0) > 0.05)) continue
        const next = byKey.get(key)?.find((note) => note.startBeat >= beat - 1e-9)
        if (next) named.set(key, { letter: keyLetter(next, song.key), upcoming: true })
      }
    }
    for (const key of whites) {
      const box = xOf.get(key)!
      context.fillStyle = fill(key, '#ffffff')
      context.fillRect(box.x + 0.5, top, box.w - 1, keyHeight)
      context.strokeStyle = '#c9cdd1'
      context.strokeRect(box.x + 0.5, top + 0.5, box.w - 1, keyHeight - 1)
      halo(key, box.x + 0.5, top, box.w - 1, keyHeight)
      if (key % 12 === 0 && !pressed.has(key) && !named.has(key)) {
        context.fillStyle = '#6b7177'
        context.font = '500 10px "Archivo Variable", sans-serif'
        context.textAlign = 'center'
        context.fillText(`C${key / 12 - 1}`, box.x + box.w / 2, top + keyHeight - 8)
      }
    }
    for (let key = range.low; key <= range.high; key++) {
      const box = xOf.get(key)
      if (!box?.black) continue
      context.fillStyle = fill(key, '#1b1d1f')
      context.fillRect(box.x, top, box.w, keyHeight * 0.62)
      halo(key, box.x, top, box.w, keyHeight * 0.62)
    }
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    for (const [key, { note, finger }] of pressed) {
      const box = xOf.get(key)
      if (!box) continue
      const y = box.black ? top + keyHeight * 0.5 : top + keyHeight - 16
      if (finger && fingering) {
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
    for (const [key, { letter, upcoming }] of named) {
      const box = xOf.get(key)
      if (!box) continue
      const lifted = pressed.get(key)?.finger && fingering
      const y = box.black ? top + keyHeight * (lifted ? 0.28 : 0.5) : top + keyHeight - (lifted ? 34 : 16)
      context.fillStyle = upcoming ? box.black ? '#ffffff' : '#111111' : '#ffffff'
      context.font = `${upcoming ? 600 : 700} ${Math.max(9, Math.min(12, box.w * 0.5))}px "Archivo Variable", sans-serif`
      context.fillText(letter, box.x + box.w / 2, y)
    }
    if (section.current) {
      section.current.dataset.letters = [...named].sort(([a], [b]) => a - b).map(([key, { letter, upcoming }]) => `${key}:${letter}${upcoming ? ':next' : ''}`).join(',')
      section.current.dataset.fingers = fingering ? [...pressed].filter(([, { finger }]) => finger).map(([key, { finger }]) => `${key}:${finger!.finger}`).join(',') : ''
      section.current.dataset.range = `${range.low}-${range.high}:${Math.round(whiteWidth * 10) / 10}`
    }
    // Illustrative hand spans above the keys, labelled so hands never rely on colour alone.
    for (const hand of ['left', 'right'] as const) {
      const keys = [...pressed].filter(([, value]) => value.note.hand === hand)
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

    const atPlayhead = [...pressed].sort(([a], [b]) => a - b)
    const summary = `${sounding ? '' : 'paused:'}${atPlayhead
      .map(([, { note, finger }]) => `${noteName(note.midi)}${note.hand === 'left' ? ' L' : note.hand === 'right' ? ' R' : ''}${finger ? finger.finger : ''}`).join(', ')}`
    if (summary !== lastActive.current && section.current) {
      lastActive.current = summary
      section.current.dataset.active = summary
      // Readable on demand by assistive technology, without announcing every change while playing.
      const notes = atPlayhead.map(([, { note, finger }]) =>
        `${noteName(note.midi)}${note.hand ? `, ${note.hand} hand` : ''}${finger ? `, finger ${finger.finger}` : ''}`).join('; ')
      if (described.current) described.current.textContent = !notes ? 'No notes at the playhead.'
        : sounding ? `Sounding now: ${notes}.` : `Paused. Notes to play at the playhead: ${notes}.`
    }
  })

  return (
    <section ref={section} className="practice-view practice-hands" aria-label={handAssignments
      ? `Hands and keys: the notes at the playhead, by hand, with ${written ? 'written' : 'suggested'} finger numbers`
      : 'Keyboard: the notes at the playhead'}>
      <canvas ref={canvas} className="practice-canvas" aria-hidden="true" />
      <p ref={described} className="visually-hidden">No notes at the playhead.</p>
      <p className="practice-legend">
        {handAssignments ? <>
          <span className="legend-key legend-right" aria-hidden="true" /> right hand
          <span className="legend-key legend-left" aria-hidden="true" /> left hand
        </> : <span className="practice-note">Hand assignments were not recorded.</span>}
        {handAssignments && <span className="practice-note">{!fingering ? 'Finger numbers are off.' : written ? 'Finger numbers are the written fingering.' : 'Finger numbers are suggestions from note spacing, not detected fingering.'}</span>}
      </p>
    </section>
  )
}
