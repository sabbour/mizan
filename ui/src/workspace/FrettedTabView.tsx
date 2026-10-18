import { useEffect, useMemo } from 'react'
import type { Song, Track } from './song'
import { useSize } from './hooks'
import {
  notesForTrack, notesByMeasure, measureAtBeat, planFrettedTab, frettedPitchName,
  type FrettedInstrumentConfig, type FrettedTabNote,
} from './fretboard'
import './fretted.css'

export type FrettedPracticeProps = {
  song: Song
  track?: Track
  trackId?: string
  beat: number
  playing: boolean
  countingIn?: boolean
  onPick: (beat: number) => void
}

type Props = FrettedPracticeProps & { config: FrettedInstrumentConfig }
type Rhythm = { beats: number; base: number; dotted?: boolean; triplet?: boolean }
const RHYTHMS: Rhythm[] = [
  { beats: 4, base: 4 }, { beats: 3, base: 2, dotted: true }, { beats: 2, base: 2 },
  { beats: 1.5, base: 1, dotted: true }, { beats: 1, base: 1 },
  { beats: 0.75, base: 0.5, dotted: true }, { beats: 0.5, base: 0.5 },
  { beats: 0.375, base: 0.25, dotted: true }, { beats: 0.25, base: 0.25 },
  { beats: 0.125, base: 0.125 }, { beats: 0.0625, base: 0.0625 },
  ...[2, 1, 0.5, 0.25].map((base) => ({ beats: base * 2 / 3, base, triplet: true })),
]
const rhythm = (beats: number) => RHYTHMS.find((item) => Math.abs(item.beats - beats) < 1e-6)
const flagsFor = (beats: number) => Math.max(0, Math.round(Math.log2(1 / (rhythm(beats)?.base ?? 1))))
const LABEL: Record<NonNullable<FrettedTabNote['reason']>, string> = {
  'fractional-pitch': 'This pitch falls between frets; no fret is guessed.',
  'outside-range': 'Outside this instrument’s standard tuning and fret range.',
  'no-distinct-string': 'No unused string is available for this chord.',
  'invalid-authored-position': 'The written string and fret do not match the note pitch.',
  'not-playable': 'Not playable as written: one hand cannot reach these notes together, so no fret is shown.',
}

function RhythmMark({ x, y, beats, rest = false, beamed = false }: {
  x: number; y: number; beats: number; rest?: boolean; beamed?: boolean
}) {
  const mark = rhythm(beats)
  if (!mark) return <text x={x} y={y + 23} className="fretted-rhythm-length" textAnchor="middle">{Number(beats.toFixed(2))} beats</text>
  const flags = flagsFor(beats)
  const duration = `${Number(beats.toFixed(2))} ${beats === 1 ? 'beat' : 'beats'}`
  return <g className="fretted-rhythm" transform={`translate(${x} ${y})`}
    data-kind={rest ? 'rest' : 'note'} data-beats={beats} role="img"
    aria-label={`${rest ? 'Rest' : 'Note'}: ${duration}${mark.triplet ? ', three in the time of two' : ''}`}>
    <title>{rest ? 'Pause for' : 'Play for'} {duration}</title>
    {rest ? mark.base >= 2 ? <>
      <line x1="-9" y1="17" x2="9" y2="17" />
      <rect x="-5" y={mark.base === 4 ? 17 : 12} width="10" height="5" className="fretted-rest" />
    </> : mark.base === 1
      ? <path className="fretted-rest" d="M-3,2 L5,10 L0,16 L5,23 C-4,19 -7,23 -2,31 C-10,28 -8,19 0,20 L-5,13 L0,7 Z" />
      : <>
        <line className="fretted-rest-stem" x1="4" y1="7" x2="-3" y2={25 + flags * 4} />
        {Array.from({ length: flags }, (_, flag) => <g key={flag} transform={`translate(0 ${flag * 6})`}>
          <circle className="fretted-rest" cx="-3" cy="10" r="3" />
          <path className="fretted-rest-curve" d="M-3,12 Q1,15 4,7" />
        </g>)}
      </>
      : <>
        <ellipse className={`fretted-notehead${mark.base >= 2 ? ' is-open' : ''}`}
          cx="0" cy="28" rx={mark.base === 4 ? 7.5 : 5.8} ry="4"
          transform="rotate(-20 0 28)" />
        {mark.base < 4 && <line className="fretted-note-stem" x1="5" y1="0" x2="5" y2="27" />}
        {!beamed && Array.from({ length: flags }, (_, flag) =>
          <path className="fretted-note-flag" key={flag}
            transform={`translate(0 ${flag * 4})`}
            d="M5,0 C6,5 16,6 11,16 C14,9 8,8 5,5 Z" />)}
      </>}
    {mark.dotted && <circle className="fretted-rhythm-dot" cx={rest ? 10 : 11} cy={rest ? 17 : 26} r="1.8" />}
    {mark.triplet && <text x="0" y="47" textAnchor="middle">3</text>}
  </g>
}

export function FrettedTabView({ song, track, trackId, beat, playing, countingIn = false, onPick, config }: Props) {
  const source = notesForTrack(song, track, trackId)
  const notes = useMemo(() => planFrettedTab(source, config), [source, config])
  const bars = useMemo(() => notesByMeasure(song, notes), [song, notes])
  const active = Math.max(0, Math.min(bars.length - 1, measureAtBeat(song, beat)))
  const first = Math.max(0, Math.min(Math.floor(active / 4) * 4, bars.length - 4))
  const shown = bars.slice(first, first + 4)
  const rowStrings = [...config.strings].reverse()
  const rowY = (row: number) => 50 + row * 18
  const bottom = rowY(rowStrings.length - 1)
  const [staffRef, availableWidth] = useSize<HTMLDivElement>()
  let left = 52
  const layouts = shown.map((measure) => {
    const { bar, notes: inBar } = measure
    const end = bar.startBeat + bar.beats
    const attacks = [...new Set([bar.startBeat, ...inBar.map((note) => Math.max(bar.startBeat, note.startBeat)), end])].sort((a, b) => a - b)
    const gaps = attacks.slice(1).map((at, i) => Math.max(30, (at - attacks[i]) * 54))
    const needed = gaps.reduce((sum, gap) => sum + gap, 0)
    const width = Math.max(224, needed + 34)
    const points = [left + 17]
    for (const gap of gaps) points.push(points.at(-1)! + gap * (width - 34) / needed)
    const xAt = (position: number) => {
      const at = Math.max(bar.startBeat, Math.min(end, position))
      const right = attacks.findIndex((edge) => edge >= at)
      if (right <= 0) return points[0]
      return points[right - 1] + (points[right] - points[right - 1]) *
        (at - attacks[right - 1]) / (attacks[right] - attacks[right - 1])
    }
    const rhythms = new Map<number, number>()
    const rests: { start: number; beats: number }[] = []
    let until = bar.startBeat
    for (const note of [...inBar].sort((a, b) => a.startBeat - b.startBeat)) {
      const onset = Math.max(bar.startBeat, note.startBeat)
      const finish = Math.min(end, note.startBeat + note.beats)
      if (onset > until + 1e-6) rests.push({ start: until, beats: onset - until })
      until = Math.max(until, finish)
      rhythms.set(onset, Math.max(rhythms.get(onset) ?? 0, finish - onset))
    }
    if (until < end - 1e-6) rests.push({ start: until, beats: end - until })
    const result = { ...measure, left, width, end, xAt, rhythms: [...rhythms], rests }
    left += width
    return result
  })
  const width = left + 16
  const currentLayout = layouts.find((item) => item.number === active + 1)!
  useEffect(() => {
    const element = staffRef.current
    if (!element) return
    const { left, width } = currentLayout
    if (left < element.scrollLeft + 12) element.scrollLeft = Math.max(0, left - 12)
    else if (left + width > element.scrollLeft + element.clientWidth - 12)
      element.scrollLeft = Math.max(0, left + width - element.clientWidth + 12)
  }, [active, currentLayout.left, currentLayout.width, availableWidth, staffRef])
  const unplacedGroups = new Map<string, FrettedTabNote[]>()
  for (const note of notes) if (!note.position && note.reason) {
    const key = `${note.reason}:${note.midi}`
    const group = unplacedGroups.get(key) ?? []
    group.push(note)
    unplacedGroups.set(key, group)
  }
  const unplaced = [...unplacedGroups.values()].map((group) => group.sort((a, b) =>
    a.startBeat - b.startBeat || a.index - b.index))
  const unplacedDescription = (note: FrettedTabNote) => {
    if (note.reason !== 'outside-range') return LABEL[note.reason!]
    const minPitch = Math.min(...config.strings.map((string) => string.midi))
    const maxPitch = Math.max(...config.strings.map((string) => string.midi + config.frets))
    const pitch = frettedPitchName(note.midi)
    const range = `${frettedPitchName(minPitch)}–${frettedPitchName(maxPitch)}`
    const side = note.midi < minPitch ? 'below' : note.midi > maxPitch ? 'above' : 'outside'
    return `${pitch} is ${side} the standard ${config.id} range (${range}). The source pitch stays in the score; no tuning, octave shift or fret is guessed.`
  }
  const seekLabel = (note: FrettedTabNote) => {
    const bar = bars[measureAtBeat(song, note.startBeat)]?.bar
    const beatInBar = note.startBeat - (bar?.startBeat ?? 0) + 1
    return `Bar ${measureAtBeat(song, note.startBeat) + 1}, beat ${Number(beatInBar.toFixed(2))}`
  }
  const isCurrent = (note: FrettedTabNote) => note.startBeat <= beat + 1e-8 && beat < note.startBeat + note.beats - 1e-8
  const isUpcoming = (note: FrettedTabNote) => !isCurrent(note) && note.startBeat > beat && note.startBeat - beat <= 0.75
  const pickBar = (index: number) => onPick(bars[Math.max(0, Math.min(bars.length - 1, index))].bar.startBeat)

  return (
    <section className="fretted-tab" data-instrument={config.id} data-playing={playing && !countingIn}
      aria-label={`${config.name} tablature`}>
      <div className="fretted-tab-heading">
        <div>
          <h3>{config.name} tab</h3>
          <p className="fretted-tuning" aria-label={`Standard tuning: ${config.strings.map((string) => string.openPitch).join(', ')}`}>
            Standard tuning · string choices are estimates
          </p>
        </div>
        <div className="fretted-bar-nav" aria-label="Measure navigation">
          <button type="button" aria-label="Previous measure" disabled={active === 0} onClick={() => pickBar(active - 1)}>‹</button>
          <span>Bar {active + 1} of {bars.length}</span>
          <button type="button" aria-label="Next measure" disabled={active === bars.length - 1} onClick={() => pickBar(active + 1)}>›</button>
        </div>
      </div>
      <div ref={staffRef} className="fretted-tab-scroll">
        <svg className="fretted-tab-staff" viewBox={`0 0 ${width} ${bottom + 63}`} width={width} height={bottom + 63} role="group"
          aria-label={`Bars ${first + 1} to ${first + shown.length}, ${config.strings.length}-line tablature`}>
          {layouts.map((layout) => <g key={`bar-${layout.number}`} className="fretted-tab-measure" data-bar={layout.number}>
            {layout.number === active + 1 && <rect className="fretted-active-bar" x={layout.left} y="5" width={layout.width} height={bottom + 57} />}
            <text className="fretted-bar-number" x={layout.left + 6} y="30">{layout.number}</text>
            {song.chords.filter((chord) => chord.symbol && chord.startBeat >= layout.bar.startBeat && chord.startBeat < layout.end)
              .map((chord) => <text key={chord.startBeat} className="fretted-chord-label" x={layout.xAt(chord.startBeat)} y="15">{chord.symbol}</text>)}
            {rowStrings.map((string, row) => <line key={string.string} className="fretted-string-line" x1={layout.left} y1={rowY(row)}
              x2={layout.left + layout.width} y2={rowY(row)} />)}
            <line className="fretted-bar-edge" x1={layout.left} y1={rowY(0)} x2={layout.left} y2={bottom} />
            {layout.number === first + shown.length &&
              <line className="fretted-bar-edge" x1={layout.left + layout.width} y1={rowY(0)} x2={layout.left + layout.width} y2={bottom} />}
            {layout.rhythms.map(([onset, length], index) => {
              const before = layout.rhythms[index - 1]
              const after = layout.rhythms[index + 1]
              const flags = flagsFor(length)
              const joins = (other: [number, number] | undefined) => {
                if (!other || flags === 0 || flagsFor(other[1]) !== flags) return false
                const [earlier, later] = other[0] < onset ? [other, [onset, length]] : [[onset, length], other]
                return Math.floor(onset - layout.bar.startBeat + 1e-6) === Math.floor(other[0] - layout.bar.startBeat + 1e-6) &&
                  Math.abs(earlier[0] + earlier[1] - later[0]) < 1e-6
              }
              return <g key={onset}>
                <RhythmMark x={layout.xAt(onset)} y={bottom + 11} beats={length} beamed={joins(before) || joins(after)} />
                {joins(after) && Array.from({ length: flags }, (_, flag) =>
                  <line key={flag} className="fretted-beam" x1={layout.xAt(onset) + 5} y1={bottom + 11 + flag * 6}
                    x2={layout.xAt(after![0]) + 5} y2={bottom + 11 + flag * 6} />)}
              </g>
            })}
            {layout.rests.map((rest) => <RhythmMark key={`rest-${rest.start}`} x={layout.xAt(rest.start)}
              y={bottom + 11} beats={rest.beats} rest />)}
            {layout.notes.map((note) => {
              if (note.reason === 'not-playable') return <text key={note.index} className="fretted-unplayable-mark"
                x={layout.xAt(note.startBeat)} y={rowY(0) - 8} textAnchor="middle" data-note-index={note.index}
                data-reason="not-playable"><title>{frettedPitchName(note.midi)}: not playable as written</title>!</text>
              if (!note.position) return null
              const row = rowStrings.findIndex((string) => string.string === note.position!.string)
              if (row < 0) return null
              const x = layout.xAt(note.startBeat)
              const y = rowY(row)
              const state = isCurrent(note) ? 'current' : isUpcoming(note) ? 'upcoming' : 'rest'
              return <g key={note.index} className={`fretted-tab-note is-${state}`} data-note-index={note.index}
                data-string={note.position.string} data-fret={note.position.fret} data-state={state}>
                {note.startBeat < layout.bar.startBeat &&
                  <path className="fretted-tie" d={`M${x - 13},${y - 9} q8,-7 16,0`} />}
                {note.startBeat + note.beats > layout.end + 1e-6 &&
                  <path className="fretted-tie" d={`M${x + 9},${y - 9} Q${(x + layout.left + layout.width) / 2},${y - 20} ${layout.left + layout.width - 4},${y - 9}`} />}
                <foreignObject x={x - 13} y={y - 11} width="26" height="22">
                  <button type="button" className={`fretted-fret${(rhythm(note.beats)?.base ?? 0) >= 2 ? ' is-open-length' : ''}${note.adjusted ? ' is-adjusted' : ''}`}
                    data-adjusted={note.adjusted ? 'true' : undefined}
                    aria-label={`${note.position.pitchName}, string ${note.position.conventionalStringNumber}, fret ${note.position.fret}${note.finger ? `, finger ${note.finger}` : ''}${note.adjusted ? ', adjusted to make this playable' : ''}; seek to beat ${note.startBeat}`}
                    title={`${note.position.pitchName} · string ${note.position.conventionalStringNumber}, fret ${note.position.fret} · ${Number(note.beats.toFixed(2))} beats${note.adjusted ? ' · adjusted to make this playable' : ''}`}
                    onClick={() => onPick(Math.max(layout.bar.startBeat, note.startBeat))}>{note.position.fret}</button>
                </foreignObject>
              </g>
            })}
          </g>)}
          {rowStrings.map((string, row) => <g key={string.string} className="fretted-string-row" data-string={string.string}>
            <text x="15" y={rowY(row) + 5} className="fretted-string-label">{string.openPitch}</text>
          </g>)}
          <line className="fretted-playhead" x1={currentLayout.xAt(beat)} y1="5"
            x2={currentLayout.xAt(beat)} y2={bottom + 62} />
        </svg>
      </div>
      <p className="fretted-tab-footnote">Highest string at the top. Numbers show frets (0 = open string). Notes below show timing; rests mean pause.</p>
      <details className="fretted-rhythm-guide">
        <summary>Reading the rhythm</summary>
        <div className="fretted-rhythm-examples">
          {[{ beats: 1, label: '1 beat' }, { beats: 0.5, label: '1/2 beat' },
            { beats: 0.25, label: '1/4 beat' }, { beats: 2, label: '2 beats' },
            { beats: 1, rest: true, label: 'Pause for 1 beat' }].map((example) =>
            <span key={`${example.beats}:${!!example.rest}`}>
              <svg viewBox="0 0 36 42" width="36" height="42" aria-hidden="true">
                <RhythmMark x={13} y={4} beats={example.beats} rest={example.rest} />
              </svg>
              {example.label}
            </span>)}
        </div>
        <p>A beam joining notes means the same as a flag. A dot adds half the note's length. A small 3 means three notes in the time normally taken by two.</p>
      </details>
      {!!unplaced.length && <ul className="fretted-unplaced" aria-label="Notes without a playable fret"
        data-note-count={unplaced.reduce((sum, group) => sum + group.length, 0)}
        data-message-count={unplaced.length}>
        {unplaced.map((group) => {
          const firstNote = group[0]
          return <li key={`${firstNote.reason}:${firstNote.midi}`} data-note-index={firstNote.index}
            data-note-indices={group.map((note) => note.index).join(',')}
            data-note-count={group.length} data-reason={firstNote.reason}>
            <span className="fretted-unplaced-message">{unplacedDescription(firstNote)}
              {group.length > 1 && <strong> {group.length} notes.</strong>}
            </span>
            {group.length === 1
              ? <button type="button" aria-label={`Go to ${frettedPitchName(firstNote.midi)}, ${seekLabel(firstNote)}`}
                onClick={() => onPick(firstNote.startBeat)}>Go to this note</button>
              : <select aria-label={`Choose from ${group.length} occurrences of ${frettedPitchName(firstNote.midi)}`}
                defaultValue="" onChange={(event) => {
                  const note = group[Number(event.target.value)]
                  if (note) onPick(note.startBeat)
                  event.currentTarget.value = ''
                }}>
                <option value="" disabled>Go to one of {group.length} notes…</option>
                {group.map((note, index) => <option key={note.index} value={index}>
                  Note {index + 1} · {seekLabel(note)}
                </option>)}
              </select>}
          </li>
        })}
      </ul>}
    </section>
  )
}
