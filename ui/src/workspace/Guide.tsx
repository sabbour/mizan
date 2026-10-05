import { useEffect, useMemo, useRef } from 'react'
import type { Engine } from './engine'
import { useFrame } from './hooks'
import type { Layout } from './Score'
import { DRUM_LANES, displaySymbol, type Instrument, type MelodyNote, type Song } from './song'

const INK = '#111111'
const RAIN = '#8a8f94'
const SILVER = '#c0c4c8'
const HAIR = '#d9dcdf'
const NO_NOTES: MelodyNote[] = []

type Props = {
  song: Song
  engine: Engine
  layout: Layout | null
  instrument: Instrument
  trackId?: string
  study: boolean
  showWave: boolean
}

function envelope(song: Song): Float32Array {
  const perBeat = 8
  const env = new Float32Array(song.bars * song.beatsPerBar * perBeat)
  const add = (beat: number, v: number, decay: number) => {
    for (let i = 0; i < 12; i++) {
      const k = Math.floor(beat * perBeat) + i
      if (k < env.length) env[k] += v * Math.exp(-i / decay)
    }
  }
  for (const n of song.piano) add(n.startBeat, 0.12, 5)
  for (const h of song.drums) add(h.startBeat, h.lane === 'kick' ? 0.5 : h.lane === 'crash' ? 0.6 : 0.25 * h.velocity, 2)
  for (const c of song.chords) if (c.tones.length) for (let b = 0; b < c.beats; b += 0.125) add(c.startBeat + b, 0.02, 1)
  const max = env.reduce((a, b) => Math.max(a, b), 0) || 1
  return env.map((v) => Math.sqrt(v / max))
}

export function Guide({ song, engine, layout, instrument, trackId, study, showWave }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const wave = useMemo(() => envelope(song), [song])
  const notes = instrument === 'vocals' ? song.vocals : instrument === 'other' ? song.instrumentNotes?.[trackId ?? ''] ?? NO_NOTES : song.piano
  const range = useMemo(() => {
    const pitches = notes.map((n) => n.midi)
    return pitches.length ? { lo: Math.min(...pitches) - 1, hi: Math.max(...pitches) + 1 } : { lo: 59, hi: 73 }
  }, [notes])

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1
      c.width = Math.round(c.clientWidth * dpr)
      c.height = Math.round(c.clientHeight * dpr)
    })
    ro.observe(c)
    return () => ro.disconnect()
  }, [])

  useFrame(engine, (t) => {
    const c = canvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx || !layout) return
    const dpr = window.devicePixelRatio || 1
    const W = c.width / dpr
    const H = c.height / dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    const bpb = song.beatsPerBar
    const barIdx = Math.min(Math.floor(t.beat / bpb), layout.bars.length - 1)
    const system = layout.bars[barIdx]?.system ?? 0
    const boxes = layout.bars.filter((b) => b.system === system)
    if (!boxes.length) return
    const xAt = (beat: number) => {
      const i = Math.floor(beat / bpb)
      const box = boxes.find((b) => b.bar === i + 1)
      if (!box) return null
      return box.x + box.inset + (beat / bpb - i) * (box.w - box.inset)
    }
    const first = (boxes[0].bar - 1) * bpb
    const last = boxes[boxes.length - 1].bar * bpb

    const chordH = 26
    const waveH = study && showWave ? 30 : 0
    const bodyTop = chordH + 8
    const bodyH = (study ? H - waveH - 14 : Math.min(H, 96)) - bodyTop

    // Bar lines, shared with the score above.
    ctx.fillStyle = HAIR
    for (const b of boxes) {
      ctx.fillRect(Math.round(b.x + b.inset), bodyTop, 1, bodyH)
      if (b === boxes[boxes.length - 1]) ctx.fillRect(Math.round(b.x + b.w) - 1, bodyTop, 1, bodyH)
    }

    // Chord timeline.
    ctx.textBaseline = 'middle'
    for (const ch of song.chords) {
      const s = Math.max(ch.startBeat, first)
      if (s >= last || ch.startBeat + ch.beats <= first) continue
      const x = xAt(s)
      if (x === null) continue
      const played = ch.startBeat + ch.beats <= t.beat
      const now = ch.startBeat <= t.beat && t.beat < ch.startBeat + ch.beats
      const weight = ch.role === 'dominant' ? 800 : ch.role === 'predominant' ? 500 : ch.role === 'tonic' ? 700 : 400
      const stretch: CanvasFontStretch = ch.role === 'dominant' ? 'condensed' : ch.role === 'predominant' ? 'semi-expanded' : 'normal'
      ctx.font = `${weight} 17px "Archivo Variable", sans-serif`
      ctx.fontStretch = stretch
      const label = ch.symbol === null ? '?' : displaySymbol(ch.symbol)
      if (now) {
        ctx.fillStyle = SILVER
        ctx.fillRect(x + 3, chordH - 3, ctx.measureText(label).width + 4, 3)
      }
      ctx.fillStyle = played ? RAIN : INK
      ctx.fillText(label, x + 5, chordH / 2)
      if (study && ch.numeral) {
        const w = ctx.measureText(label).width
        ctx.font = `500 13px "Archivo Variable", sans-serif`
        ctx.fillStyle = played ? RAIN : '#4a4f55'
        ctx.fillText(ch.numeral, x + w + 11, chordH / 2 + 1)
      }
    }

    if (instrument === 'piano' || instrument === 'vocals' || instrument === 'other') {
      const span = range.hi - range.lo
      const noteH = Math.max(2, Math.min(study ? 6 : 3, bodyH / span))
      const yOf = (m: number) => bodyTop + (1 - (m - range.lo) / span) * (bodyH - noteH)
      if (study) {
        ctx.font = '500 11px "Archivo Variable", sans-serif'
        for (let m = Math.ceil(range.lo / 12) * 12; m <= range.hi; m += 12) {
          const y = yOf(m) + noteH / 2
          ctx.fillStyle = HAIR
          ctx.fillRect(boxes[0].x + boxes[0].inset, Math.round(y), boxes[boxes.length - 1].x + boxes[boxes.length - 1].w - boxes[0].x - boxes[0].inset, 1)
          ctx.fillStyle = '#5c6167'
          ctx.fillText(`C${m / 12 - 1}`, Math.max(0, boxes[0].x - 26), y)
        }
      }
      for (const n of notes) {
        if (n.startBeat + n.beats <= first || n.startBeat >= last) continue
        const x0 = xAt(Math.max(first, n.startBeat))
        const x1 = xAt(Math.min(n.startBeat + n.beats, last - 0.001))
        if (x0 === null || x1 === null) continue
        const y = yOf(n.midi)
        const w = Math.max(3, x1 - x0 - 2)
        const played = n.startBeat + n.beats <= t.beat
        const sounding = n.startBeat <= t.beat && t.beat < n.startBeat + n.beats
        const color = played ? RAIN : INK
        if (instrument !== 'piano' || ('hand' in n && n.hand === 'right') || !study) {
          ctx.fillStyle = color
          ctx.fillRect(x0, y, w, noteH)
        } else {
          ctx.strokeStyle = color
          ctx.lineWidth = 1
          ctx.strokeRect(x0 + 0.5, y + 0.5, w - 1, Math.max(1, noteH - 1))
        }
        if (sounding) {
          ctx.fillStyle = SILVER
          ctx.fillRect(x0, y + noteH + 1, w, 2)
        }
      }
    } else {
      const lanes = DRUM_LANES
      const laneH = bodyH / lanes.length
      if (study) {
        ctx.font = '500 11px "Archivo Variable", sans-serif'
        lanes.forEach((l, i) => {
          ctx.fillStyle = '#5c6167'
          ctx.textAlign = 'right'
          ctx.fillText(l.label, boxes[0].x + boxes[0].inset - 8, bodyTop + laneH * (i + 0.5))
          ctx.textAlign = 'left'
          ctx.fillStyle = HAIR
          ctx.fillRect(boxes[0].x + boxes[0].inset, Math.round(bodyTop + laneH * (i + 1)), boxes[boxes.length - 1].x + boxes[boxes.length - 1].w - boxes[0].x - boxes[0].inset, 1)
        })
      }
      for (const h of song.drums) {
        if (h.startBeat < first || h.startBeat >= last) continue
        const x = xAt(h.startBeat)
        if (x === null) continue
        const lane = lanes.findIndex((l) => l.lane === h.lane)
        const hh = Math.max(2, laneH * (0.35 + 0.5 * h.velocity))
        const y = bodyTop + laneH * lane + (laneH - hh) / 2
        const played = h.startBeat < t.beat - 0.05
        ctx.fillStyle = played ? RAIN : INK
        ctx.fillRect(Math.round(x), y, study ? 4 : 3, hh)
      }
    }

    if (waveH) {
      const top = H - waveH
      const x0 = boxes[0].x + boxes[0].inset
      for (let px = Math.ceil(x0); px < boxes[boxes.length - 1].x + boxes[boxes.length - 1].w; px += 2) {
        let beat = -1
        for (const b of boxes) {
          if (px >= b.x + b.inset && px < b.x + b.w) beat = (b.bar - 1) * bpb + ((px - b.x - b.inset) / (b.w - b.inset)) * bpb
        }
        if (beat < 0) continue
        const v = wave[Math.floor(beat * 8)] ?? 0
        const h = Math.max(1, v * waveH)
        ctx.fillStyle = beat < t.beat ? RAIN : '#3a3f45'
        ctx.fillRect(px, top + (waveH - h) / 2, 1, h)
      }
    }

    const px = xAt(Math.min(t.beat, last - 0.001))
    if (px !== null) {
      ctx.fillStyle = INK
      ctx.fillRect(Math.round(px) - 1, 0, 2, study ? H : bodyTop + bodyH)
    }
  })

  const label =
    instrument === 'vocals' ? 'Vocal melody piano roll. Draft pitches, not piano fingering.' : instrument === 'other'
      ? 'Transcribed instrument pitch roll. Draft notes, not fingering or tablature.' : instrument === 'piano'
      ? 'Piano roll for the bars on screen. Right hand filled, left hand outlined.'
      : 'Drum grid for the bars on screen, one row per drum.'
  return (
    <section className="guide" aria-label={label}>
      <canvas ref={canvas} className="guide-canvas" aria-hidden="true" />
      {study && (
        <p className="guide-legend">
          {instrument === 'vocals' ? <>Vocal melody · low-confidence draft · no lyrics</> : instrument === 'other' ? (
            <>Pitched-note draft · no instrument fingering</>
          ) : instrument === 'piano' ? (
            <>
              <span className="legend-swatch legend-filled" aria-hidden="true" /> right hand
              <span className="legend-swatch legend-outline" aria-hidden="true" /> left hand
            </>
          ) : (
            <>tick height = how hard each hit lands</>
          )}
          {showWave && <span className="legend-wave">waveform, synthetic mix</span>}
        </p>
      )}
    </section>
  )
}
