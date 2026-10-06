import { useEffect, useRef, useState } from 'react'
import type { Engine } from './engine'
import { Keys } from './Keys'
import { useFrame, useReducedMotion } from './hooks'
import { centred, chordAt, chordName, displaySymbol, type Confidence, type Song } from './song'
import { barAt, measures } from './meter'

type Props = {
  song: Song
  engine: Engine
  bar: number
  loop: { startBar: number; endBar: number } | null
  confidence: Confidence[]
  onPick: (bar: number, extend: boolean) => void
  previewId: string
}

type Row = { section: string | null; bars: number[] }

/** One block per section; bars wrap to fill the width. */
function rowsOf(song: Song): Row[] {
  const starts = new Map(song.sections.map((s) => [s.startBar, s.name]))
  const rows: Row[] = []
  for (let b = 1; b <= song.bars; b++) {
    const last = rows[rows.length - 1]
    if (!last || starts.has(b)) rows.push({ section: starts.get(b) ?? null, bars: [b] })
    else last.bars.push(b)
  }
  return rows
}

/** The progression as a chord chart: every bar with the keyboard shape of each chord that starts in it. Replaces the staff in the Chords track's Shapes view. */
export function ChordChart({ song, engine, bar, loop, confidence, onPick, previewId }: Props) {
  const current = useRef<HTMLButtonElement>(null)
  const fill = useRef<HTMLSpanElement>(null)
  const reduced = useReducedMotion()
  const barMap = measures(song)
  const rows = rowsOf(song)
  const sustainedFrom = (i: number) => {
    let start = song.chords[i].startBeat
    for (let j = i - 1; j >= 0; j--) {
      const chord = song.chords[j]
      if (chord.startBeat + chord.beats < start - 1e-6) return null
      if (chord.symbol === 'N.C.') return null
      if (chord.symbol) return chord.tones.length ? chord.symbol : null
      start = chord.startBeat
    }
    return null
  }
  // This chart's own chords may change mid-bar, so it follows the playhead itself.
  const [chordIdx, setChordIdx] = useState(0)

  useFrame(engine, (t) => {
    const span = barMap[barAt(song, t.beat)]
    if (fill.current) fill.current.style.transform = `scaleX(${Math.min(1, (t.beat - span.startBeat) / span.beats)})`
    const i = chordAt(song, t.beat)
    if (i !== chordIdx) setChordIdx(i)
  })
  useEffect(() => {
    current.current?.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
  }, [bar, reduced])

  const inLoop = (n: number) => !!loop && n >= loop.startBar && n <= loop.endBar

  return (
    <section className="score chart" aria-label="Chord chart">
      <div className="chart-sheet">
        {rows.map((row) => (
          <div key={row.bars[0]} className="chart-block">
            {row.section && <h2 className="chart-section">{row.section}</h2>}
            <div className="chart-row">
              {row.bars.map((n) => {
                const { startBeat: start, beats: bpb } = barMap[n - 1]
                const starting = song.chords.map((c, i) => ({ c, i })).filter(({ c }) => c.startBeat >= start && c.startBeat < start + bpb)
                const held = starting.length ? null : song.chords.findIndex((c) => c.startBeat < start && c.startBeat + c.beats > start)
                return (
                  <button
                    key={n}
                    ref={n === bar ? current : undefined}
                    type="button"
                    tabIndex={-1}
                    className="chart-bar"
                    data-current={n === bar || undefined}
                    data-loop={inLoop(n) || undefined}
                    onClick={(e) => {
                      const index = (e.target as Element).closest('[data-chord-index]')?.getAttribute('data-chord-index')
                      const chord = index === undefined || index === null ? undefined : song.chords[Number(index)]
                      if (!e.shiftKey && !engine.playing && chord?.symbol && chord.tones.length) void engine.audition(chord.tones, previewId)
                      onPick(n, e.shiftKey)
                    }}
                    aria-label={`Bar ${n}`}
                    title={`Bar ${n}${confidence[n - 1] === 'low' ? ' · uncertain analysis' : ''}. Click a named chord to preview it while paused; shift-click to set the loop end.`}
                  >
                    <span className="chart-num num">{n}</span>
                    {starting.map(({ c, i }) => {
                      const plain = c.symbol === null || c.symbol === 'N.C.'
                      const tones = centred(c.tones)
                      return (
                        <span key={i} className="chart-chord" data-chord-index={!plain && c.tones.length ? i : undefined} data-current={i === chordIdx || undefined} data-plain={plain || undefined}>
                          <span className="chart-name">
                            {c.symbol === null ? '—' : displaySymbol(c.symbol)}
                            {c.numeral && <span className="chart-numeral">{c.numeral}</span>}
                          </span>
                          {c.symbol === null && sustainedFrom(i) && <span className="chart-held">{displaySymbol(sustainedFrom(i)!)} held</span>}
                          {!plain && (
                            <Keys className="chart-keys" tones={tones} low={Math.min(...tones) - 1} high={Math.max(...tones) + 1} flats={c.flats} label={chordName(c.symbol)} />
                          )}
                        </span>
                      )
                    })}
                    {held !== null && held >= 0 && (
                      <span className="chart-held" data-chord-index={song.chords[held].symbol && song.chords[held].symbol !== 'N.C.' && song.chords[held].tones.length ? held : undefined} data-current={held === chordIdx || undefined}>
                        {song.chords[held].symbol === null
                          ? (sustainedFrom(held) ? `${displaySymbol(sustainedFrom(held)!)} held` : '—')
                          : song.chords[held].symbol === 'N.C.' ? 'N.C.' : `${displaySymbol(song.chords[held].symbol!)} held`}
                      </span>
                    )}
                    {n === bar && <span ref={fill} className="chart-progress" aria-hidden="true" />}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
