import { useCallback, useEffect, useRef, useState } from 'react'
import { OpenSheetMusicDisplay, VexFlowGraphicalNote } from 'opensheetmusicdisplay'
import type { Engine } from './engine'
import { displaySymbol, sustainedChords, type Confidence, type Instrument, type Song } from './song'
import { useFrame, useReducedMotion, useSize } from './hooks'
import { Guide } from './Guide'
import { notationNotes } from './musicxml'

export type BarBox = { bar: number; x: number; w: number; inset: number; top: number; bottom: number; system: number }
/** `sky` is how far (px, ≤ 0) the highest note or mark rises above the system's top staff line. */
export type Layout = {
  bars: BarBox[]
  systems: { top: number; bottom: number; sky: number }[]
  onsets: { beat: number; x: number }[][]
}

const STEP_LETTER: Record<number, string> = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' }
const SVG = 'http://www.w3.org/2000/svg'

/** Writes each note's letter inside its notehead, in the score's own SVG so it can never drift off the head. */
function labelHeads(osmd: OpenSheetMusicDisplay) {
  for (const staves of osmd.GraphicSheet.MeasureList)
    for (const m of staves)
      for (const entry of m?.staffEntries ?? [])
        for (const ve of entry.graphicalVoiceEntries)
          for (const note of ve.notes) {
            if (!(note instanceof VexFlowGraphicalNote) || !note.sourceNote.Pitch || note.sourceNote.isRest()) continue
            const el = note.getNoteheadSVGs()[note.vfnoteIndex]
            if (!(el instanceof SVGGraphicsElement)) continue
            const box = el.getBBox()
            if (!box.width) continue
            const hollow = note.sourceNote.Length.RealValue >= 0.5
            const text = document.createElementNS(SVG, 'text')
            text.setAttribute('class', 'head-letter')
            text.setAttribute('x', String(box.x + box.width / 2))
            text.setAttribute('y', String(box.y + box.height / 2))
            text.setAttribute('font-size', String(box.height * 0.9))
            // Hollow heads: outlined letter, readable over both the ring and the hole.
            if (hollow) text.setAttribute('stroke-width', String(box.height * 0.2))
            if (hollow) text.setAttribute('data-hollow', '')
            text.textContent = STEP_LETTER[note.sourceNote.Pitch.FundamentalNote] ?? ''
            el.appendChild(text)
          }
}

/** A drawn notehead and the source-note interval sounding on this score segment. */
type Hit = { sourceId?: string; el: HTMLElement; start: number; end: number }

type SourceNote = {
  sourceId: string
  midi: number
  startDiv: number
  startBeat: number
  endBeat: number
  sourceStartBeat: number
  sourceEndBeat: number
  staff: number
}

function sourceNotes(song: Song, instrument: Instrument, trackId: string): SourceNote[] {
  const projected = (notes: Parameters<typeof notationNotes>[0], partId: string, staff: (note: { source: { hand?: string; midi: number } }) => number) =>
    notationNotes(notes, partId, song.beatsPerBar).map((note) => ({
      sourceId: note.sourceId,
      midi: note.midi,
      startDiv: note.startDiv,
      startBeat: note.startBeat,
      endBeat: note.endBeat,
      sourceStartBeat: note.sourceStartBeat,
      sourceEndBeat: note.sourceEndBeat,
      staff: staff(note),
    }))
  const chordNote = (midi: number, startBeat: number, beats: number, staff: number, sourceId: string): SourceNote => {
    const startDiv = Math.round(startBeat * 16)
    const endDiv = Math.max(startDiv + 1, Math.round((startBeat + beats) * 16))
    return { sourceId, midi, startDiv, startBeat: startDiv / 16, endBeat: endDiv / 16,
      sourceStartBeat: startBeat, sourceEndBeat: startBeat + beats, staff }
  }
  if (instrument === 'piano')
    return projected(song.piano, 'piano', (n) => n.source.hand === 'right' ? 0 : 1)
  if (instrument === 'vocals')
    return projected(song.vocals, 'vocals', () => 0)
  if (instrument === 'other') {
    const events = song.instrumentNotes?.[trackId] ?? []
    const split = events.some((n) => n.midi < 60) && events.some((n) => n.midi >= 60)
    return projected(events, trackId, (n) => split && n.source.midi < 60 ? 1 : 0)
  }
  if (instrument === 'chords')
    return sustainedChords(song.chords).flatMap((item) => [
      ...item.tones.map((midi, index) => chordNote(midi, item.startBeat, item.beats, 0, `chord:${item.startBeat}:${index}`)),
      chordNote(item.tones[0] - 24, item.startBeat, item.beats, 1, `chord-bass:${item.startBeat}`),
    ])
  return []
}

function hits(osmd: OpenSheetMusicDisplay, song: Song, instrument: Instrument, trackId: string): Hit[] {
  const out: Hit[] = []
  const events = sourceNotes(song, instrument, trackId)
  for (const staves of osmd.GraphicSheet.MeasureList)
    for (const [staffIndex, staff] of staves.entries())
      for (const entry of staff?.staffEntries ?? []) {
        const writtenStart = entry.getAbsoluteTimestamp().RealValue * 4
        for (const ve of entry.graphicalVoiceEntries)
          for (const note of ve.notes) {
            if (!(note instanceof VexFlowGraphicalNote) || note.sourceNote.isRest()) continue
            const el = note.getNoteheadSVGs()[note.vfnoteIndex]
            if (!el) continue
            el.classList.toggle('score-head-hollow', note.sourceNote.Length.RealValue >= 0.5)
            const writtenEnd = writtenStart + note.graphicalNoteLength.RealValue * 4
            if (instrument === 'drums') {
              if (writtenEnd > writtenStart) out.push({ el, start: writtenStart, end: writtenEnd })
              continue
            }
            // OSMD's half-tone index is one octave below MIDI (C4 is 48 here, MIDI 60).
            const pitch = note.sourceNote.Pitch.getHalfTone() + 12
            const origin = note.sourceNote.NoteTie?.StartNote ?? note.sourceNote
            const onset = Math.round(origin.getAbsoluteTimestamp().RealValue * 64)
            for (const event of events) {
              if (event.staff !== staffIndex ||
                Math.abs(event.midi - pitch) > 0.01 ||
                event.startDiv !== onset ||
                event.startBeat >= writtenEnd || event.endBeat <= writtenStart) continue
              const transportStart = Math.abs(writtenStart - event.startBeat) < 1e-6
                ? event.sourceStartBeat : Math.max(writtenStart, event.sourceStartBeat)
              const transportEnd = Math.abs(writtenEnd - event.endBeat) < 1e-6
                ? event.sourceEndBeat : Math.min(writtenEnd, event.sourceEndBeat)
              if (transportEnd > transportStart)
                out.push({ sourceId: event.sourceId, el, start: transportStart, end: transportEnd })
            }
          }
      }
  return out.sort((a, b) => a.start - b.start)
}

function markChordNames(host: HTMLElement, song: Song, layout: Layout) {
  const rect = host.getBoundingClientRect()
  const available = [...host.querySelectorAll<SVGGElement>('g.vf-text')]
  const written = (name: string) => name.replace(/\s/g, '').replace(/♭/g, 'b').replace(/♯/g, '#')
  for (const [i, chord] of song.chords.entries()) {
    if (!chord.symbol || chord.symbol === 'N.C.' || !chord.tones.length) continue
    const box = layout.bars[Math.floor(chord.startBeat / song.beatsPerBar)]
    if (!box) continue
    const expectedX = scoreX(layout, chord.startBeat, song.beatsPerBar)
    const name = written(chord.symbol)
    const label = available
      .filter((el) => written(el.textContent ?? '') === name)
      .map((el) => ({ el, bounds: el.getBoundingClientRect() }))
      .filter(({ bounds }) => bounds.left >= rect.left + box.x - 4 &&
        bounds.left < rect.left + box.x + box.w &&
        bounds.bottom <= rect.top + box.top + 4 && bounds.bottom >= rect.top + box.top - 100)
      .sort((a, b) => Math.abs(a.bounds.left - rect.left - (expectedX ?? 0)) -
        Math.abs(b.bounds.left - rect.left - (expectedX ?? 0)))[0]?.el
    if (!label) continue
    label.dataset.chordIndex = String(i)
    label.setAttribute('role', 'button')
    label.setAttribute('tabindex', '0')
    label.setAttribute('aria-label', `Preview ${displaySymbol(chord.symbol)} while paused`)
    available.splice(available.indexOf(label), 1)
  }
}

/** Score zoom; bigger when note letters are drawn so they fit inside the noteheads. */
const zoomFor = (letters: boolean) => (letters ? 1.4 : 1)
/** Room kept above the current system for its chord symbols, section name and tempo mark. */
const HEADROOM = 110

type Props = {
  xml: string
  song: Song
  engine: Engine
  bar: number
  loop: { startBar: number; endBar: number } | null
  confidence: Confidence[]
  /** Letter names drawn inside the noteheads (pitched scores only). */
  noteNames: boolean
  instrument: Instrument
  playing: boolean
  audioLoading: boolean
  audioError: boolean
  vocalGuide?: boolean
  instrumentGuide?: string
  onPick: (bar: number, extend: boolean) => void
  previewId: string
}

export function measure(osmd: OpenSheetMusicDisplay, host: HTMLElement): Layout {
  const UNIT = 10 * osmd.Zoom
  const bars: BarBox[] = []
  const onsets: Layout['onsets'] = []
  const systemIds: number[] = []
  const systems: Layout['systems'] = []
  const hostX = host.getBoundingClientRect().left
  osmd.GraphicSheet.MeasureList.forEach((staves, i) => {
    const first = staves.find(Boolean)
    const last = [...staves].reverse().find(Boolean)
    if (!first || !last) return
    const ps = first.PositionAndShape
    const top = first.ParentStaffLine.PositionAndShape.AbsolutePosition.y * UNIT
    const bottom = (last.ParentStaffLine.PositionAndShape.AbsolutePosition.y + 4) * UNIT
    let s = systemIds.indexOf(first.ParentMusicSystem.Id)
    if (s < 0) {
      systemIds.push(first.ParentMusicSystem.Id)
      systems.push({ top, bottom, sky: Math.min(0, first.ParentStaffLine.SkyBottomLineCalculator.getSkyLineMin()) * UNIT })
      s = systems.length - 1
    }
    bars.push({
      bar: i + 1,
      x: (ps.AbsolutePosition.x + ps.BorderLeft) * UNIT,
      w: ps.Size.width * UNIT,
      inset: (first.beginInstructionsWidth ?? 0) * UNIT,
      top,
      bottom,
      system: s,
    })
    const points = new Map<number, number>()
    for (const staff of staves)
      for (const entry of staff?.staffEntries ?? []) {
        const note = entry.graphicalVoiceEntries.flatMap((voice) => voice.notes)
          .find((n): n is VexFlowGraphicalNote => n instanceof VexFlowGraphicalNote && !n.sourceNote.isRest())
        if (!note) continue
        const beat = entry.getAbsoluteTimestamp().RealValue * 4
        if (points.has(beat)) continue
        const head = note.getNoteheadSVGs()[note.vfnoteIndex]
        const rect = head?.getBoundingClientRect()
        points.set(beat, rect && rect.width ? rect.left + rect.width / 2 - hostX : entry.PositionAndShape.AbsolutePosition.x * UNIT)
      }
    onsets.push([...points].map(([beat, x]) => ({ beat, x })).sort((a, b) => a.beat - b.beat))
  })
  return { bars, systems, onsets }
}

function scoreBarIndex(layout: Layout, beat: number, beatsPerBar: number): number {
  const barNumber = Math.floor(beat / beatsPerBar) + 1
  const exact = layout.bars.findIndex((box) => box.bar === barNumber)
  if (exact >= 0) return exact
  let previous = -1
  for (const [index, box] of layout.bars.entries()) {
    if (box.bar < barNumber) previous = index
    else return previous >= 0 ? previous : index
  }
  return previous
}

export function scoreX(layout: Layout, beat: number, beatsPerBar: number): number | null {
  const bar = scoreBarIndex(layout, beat, beatsPerBar)
  const box = layout.bars[bar]
  if (!box) return null
  const barNumber = Math.floor(beat / beatsPerBar) + 1
  if (box.bar !== barNumber) return box.bar < barNumber ? box.x + box.w : box.x + box.inset
  const start = (box.bar - 1) * beatsPerBar
  beat = Math.min(beat, start + beatsPerBar)
  const points = layout.onsets[bar] ?? []
  let left = { beat: start, x: box.x + box.inset }
  let right = { beat: start + beatsPerBar, x: box.x + box.w }
  for (const point of points) {
    if (point.beat <= beat) left = point
    else { right = point; break }
  }
  if (left.beat === start && points[0]?.beat === start) left = points[0]
  return left.x + (right.x - left.x) * (beat - left.beat) / (right.beat - left.beat)
}

export function Score({ xml, song, engine, bar, loop, confidence, noteNames, instrument, playing, audioLoading, audioError, vocalGuide, instrumentGuide, onPick, previewId }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const osmd = useRef<OpenSheetMusicDisplay | null>(null)
  const playhead = useRef<HTMLDivElement>(null)
  const notes = useRef<Hit[]>([])
  const lit = useRef(new Set<HTMLElement>())
  const loadTail = useRef(Promise.resolve())
  const loadGeneration = useRef(0)
  const [viewport, width] = useSize<HTMLDivElement>()
  const reduced = useReducedMotion()
  const [layout, setLayout] = useState<Layout | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  const clearHighlights = useCallback(() => {
    for (const el of lit.current) el.classList.remove('score-head-active')
    lit.current.clear()
  }, [])

  useEffect(() => {
    const generation = ++loadGeneration.current
    let cancelled = false
    notes.current = []
    clearHighlights()
    setLayout(null)
    setStatus('loading')
    if (!host.current || width < 200) return () => { cancelled = true }
    const timer = window.setTimeout(() => {
      const previous = loadTail.current
      let release = () => {}
      loadTail.current = new Promise<void>((resolve) => { release = resolve })
      void (async () => {
        await previous
        try {
          if (cancelled || generation !== loadGeneration.current) return
          if (!osmd.current) {
            osmd.current = new OpenSheetMusicDisplay(host.current!, {
              autoResize: false,
              backend: 'svg',
              drawTitle: false,
              drawSubtitle: false,
              drawComposer: false,
              drawLyricist: false,
              drawCredits: false,
              drawPartNames: false,
              drawPartAbbreviations: false,
              drawMetronomeMarks: true,
              // Bars pack to the page width; forced 4-bar lines left most of each bar empty.
              newSystemFromXML: false,
              autoBeam: true,
              stretchLastSystemLine: true,
              defaultColorMusic: '#111111',
              pageFormat: 'Endless',
            })
            const rules = osmd.current.EngravingRules
            rules.DefaultFontFamily = 'Archivo Variable'
            rules.ChordSymbolTextHeight = 2.1
            rules.ChordSymbolYOffset = 1.4
            rules.MinSkyBottomDistBetweenSystems = 7
          }
          const display = osmd.current
          await display.load(xml)
          if (cancelled || generation !== loadGeneration.current) return
          display.Zoom = zoomFor(noteNames)
          display.render()
          notes.current = hits(display, song, instrument, previewId)
          if (noteNames) labelHeads(display)
          const nextLayout = measure(display, host.current!)
          markChordNames(host.current!, song, nextLayout)
          setLayout(nextLayout)
          setStatus('ready')
        } catch (e) {
          if (cancelled || generation !== loadGeneration.current) return
          notes.current = []
          clearHighlights()
          setError(e instanceof Error ? e.message : String(e))
          setStatus('error')
          setLayout(null)
        } finally {
          release()
        }
      })()
    }, 60)
    return () => {
      cancelled = true
      clearTimeout(timer)
      notes.current = []
      clearHighlights()
    }
  }, [xml, width, attempt, noteNames, song, instrument, previewId, clearHighlights])

  const place = useCallback(
    (beat: number) => {
      const el = playhead.current
      if (!el || !layout) return
      const b = scoreBarIndex(layout, beat, song.beatsPerBar)
      const box = layout.bars[b]
      const x = scoreX(layout, beat, song.beatsPerBar)
      if (!box || x === null) return
      el.style.transform = `translate(${x}px, ${box.top - 12}px)`
      el.style.height = `${box.bottom - box.top + 24}px`
    },
    [layout, song.beatsPerBar],
  )
  const light = useCallback((beat: number, enabled: boolean) => {
    const next = new Set<HTMLElement>()
    if (enabled)
      for (const h of notes.current) {
        if (h.start > beat) break
        if (beat < h.end) next.add(h.el)
      }
    for (const el of lit.current) if (!next.has(el)) el.classList.remove('score-head-active')
    for (const el of next) if (!lit.current.has(el)) el.classList.add('score-head-active')
    lit.current = next
  }, [])
  useFrame(engine, (t) => {
    place(t.beat)
    light(t.beat, playing && t.playing && !t.countingIn && !audioLoading && !audioError && status === 'ready')
  })

  const system = layout?.bars[bar - 1]?.system ?? 0
  useEffect(() => {
    const el = viewport.current
    if (!el || !layout) return
    const s = layout.systems[system]
    el.scrollTo({ top: Math.max(0, s.top - HEADROOM), behavior: reduced ? 'auto' : 'smooth' })
  }, [system, layout, reduced, viewport])

  const sectionStarts = new Map(song.sections.map((s) => [s.startBar, s.name]))
  const uniformlyLow = confidence.length >= song.bars && confidence.slice(0, song.bars).every((value) => value === 'low')
  const inLoop = (n: number) => !!loop && n >= loop.startBar && n <= loop.endBar
  const pickChord = (index: string | undefined, extend: boolean) => {
    if (index === undefined) return
    const chord = song.chords[Number(index)]
    if (!chord?.symbol || !chord.tones.length) return
    if (!extend && !engine.playing) void engine.audition(chord.tones, previewId)
    onPick(Math.floor(chord.startBeat / song.beatsPerBar) + 1, extend)
  }

  return (
    <section className="score" aria-label="Draft score" aria-busy={status === 'loading'} ref={viewport}>
      <div className="score-sheet">
        <div
          ref={host}
          className="score-osmd"
          onClick={(e) => pickChord((e.target as Element).closest<SVGGElement>('[data-chord-index]')?.dataset.chordIndex, e.shiftKey)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            const index = (e.target as Element).closest<SVGGElement>('[data-chord-index]')?.dataset.chordIndex
            if (index === undefined) return
            e.preventDefault()
            pickChord(index, e.shiftKey)
          }}
        />
        {layout && status === 'ready' && (
          <div className="score-overlay">
            {layout.bars.map((b) => (
              <button
                key={b.bar}
                type="button"
                tabIndex={-1}
                className="score-bar"
                data-loop={inLoop(b.bar) || undefined}
                data-loop-start={(inLoop(b.bar) && (b.bar === loop!.startBar || layout.bars[b.bar - 2]?.system !== b.system)) || undefined}
                data-loop-end={(inLoop(b.bar) && (b.bar === loop!.endBar || layout.bars[b.bar]?.system !== b.system)) || undefined}
                style={{ left: b.x, top: b.top - 12, width: b.w, height: b.bottom - b.top + 24 }}
                onClick={(e) => onPick(b.bar, e.shiftKey)}
                aria-label={`Bar ${b.bar}`}
                title={`Bar ${b.bar}. Click to jump, shift-click to set the loop end.`}
              >
                {sectionStarts.get(b.bar) && (
                  <span className="section-flag" style={{ top: layout.systems[b.system].sky - 38 }}>
                    {sectionStarts.get(b.bar)}
                  </span>
                )}
              </button>
            ))}
            {!vocalGuide && !uniformlyLow && instrumentGuide === undefined && layout.bars.map((b, i) => {
              if (confidence[i] !== 'low' || (i > 0 && confidence[i - 1] === 'low' && layout.bars[i - 1].system === b.system)) return null
              let end = i
              while (layout.bars[end + 1]?.system === b.system && confidence[end + 1] === 'low') end++
              const last = layout.bars[end]
              return (
                <span
                  key={b.bar}
                  className="unsure"
                  style={{ left: b.x + 6, top: b.bottom + 18, width: last.x + last.w - b.x - 12 }}
                >
                  <span className="unsure-label">draft unsure</span>
                </span>
              )
            })}
            <div ref={playhead} className="score-playhead" aria-hidden="true" />
          </div>
        )}
      </div>
      {vocalGuide && status === 'ready' && <Guide song={song} engine={engine} layout={layout} instrument="vocals" study showWave={false} />}
      {instrumentGuide && status === 'ready' && <Guide song={song} engine={engine} layout={layout} instrument="other" trackId={instrumentGuide} study showWave={false} />}
      {status === 'loading' && (
        <div className="score-skeleton" role="status">
          <span className="visually-hidden">Drawing the score</span>
          {[0, 1, 2].map((s) => (
            <div key={s} className="skeleton-system">
              {Array.from({ length: 5 }, (_, i) => (
                <span key={i} />
              ))}
            </div>
          ))}
        </div>
      )}
      {status === 'error' && (
        <div className="view-error" role="alert">
          <p>The score couldn’t be drawn ({error}). Playback still works.</p>
          <button type="button" className="text-button" onClick={() => setAttempt((a) => a + 1)}>
            Try drawing it again
          </button>
        </div>
      )}
    </section>
  )
}
