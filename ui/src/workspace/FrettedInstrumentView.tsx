import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { loadGlb } from './kitAsset'
import { useFrame, useReducedMotion } from './hooks'
import { barAt, barStart } from './meter'
import {
  fretDistanceFromNut, notesForTrack, planFrettedTab,
  type FrettedInstrumentConfig, type FrettedTabNote, type FrettedVisualState,
} from './fretboard'
import { LOOK_LABEL, loadPrefs, savePref, type Look } from './prefs'
import { FRETTED_LOOKS, normalizeFrettedStyle, type FrettedStyle } from './frettedStyles'
import {
  FrettedRenderer, type FrettedFrame,
} from './frettedRenderer'
import { loadFrettedHands } from './frettedHandAsset'
import { planFrettedHand, selectHandNotes, suggestFrettedFingers, type FrettedHandContact, type FrettedHandMemory } from './frettedHand'
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
type Overlay = Pick<FrettedFrame, 'markers' | 'openTargets' | 'fretRegions' | 'stringLabels' | 'fretLabels' | 'plucks'
  | 'pick' | 'stringGuides' | 'handUnavailable' | 'handPending'> & { hand: FrettedFrame['hand'] }
type GuideTarget = { note: FrettedTabNote; state: 'pressed' | 'preview'; feedback?: FrettedVisualState }
type GuideContact = FrettedHandContact & {
  source: 'lesson' | 'suggested'
  state: 'pressed' | 'preview'
  feedback?: FrettedVisualState
}
type GuideFrame = {
  contacts: GuideContact[]
  targets: GuideTarget[]
  openTargets: GuideTarget[]
  currentNotes: FrettedTabNote[]
  nextNotes: FrettedTabNote[]
  unavailable: boolean
  state: 'pressed' | 'preview' | null
  barIndex: number
  countingIn: boolean
  playing: boolean
  key: string
  chord: string | null
}
type FrameHook = (canvas: HTMLCanvasElement, frame: FrettedFrame, pane?: 'overview') => void
const EMPTY_FEEDBACK: Readonly<Record<string, FrettedVisualState | undefined>> = Object.freeze({})
const EMPTY_OVERLAY: Overlay = {
  markers: [], openTargets: [], fretRegions: [], stringLabels: [], fretLabels: [], plucks: [], pick: null,
  stringGuides: [], hand: null, handUnavailable: false, handPending: false,
}
const EMPTY_GUIDE: GuideFrame = {
  contacts: [], targets: [], openTargets: [], currentNotes: [], nextNotes: [], unavailable: false, state: null,
  barIndex: 0, countingIn: false, playing: false, key: '', chord: null,
}
const frameHook = (name: '__mizanGuitarFrame' | '__mizanBassFrame') =>
  (globalThis as typeof globalThis & Record<string, FrameHook | undefined>)[name]

function buildGuideFrame(
  plan: readonly FrettedTabNote[],
  config: FrettedInstrumentConfig,
  song: FrettedInstrumentViewProps['song'],
  beat: number,
  countingIn: boolean,
  playing: boolean,
  loop: { start: number; end: number } | null,
  feedback: Readonly<Record<string, FrettedVisualState | undefined>>,
  handMemory?: FrettedHandMemory,
): GuideFrame {
  const feedbackFor = (note: FrettedTabNote) => note.position
    ? feedback[`Position_S${note.position.string}_F${note.position.fret}`]
    : undefined
  const activeNotes = countingIn ? [] : plan.filter((note) =>
    note.position && note.startBeat <= beat + 1e-8 && beat < note.startBeat + note.beats - 1e-8)
  const distanceTo = (note: FrettedTabNote) => {
    if (!note.position) return Infinity
    if (loop) {
      if (note.startBeat >= loop.end) return Infinity
      if (countingIn)
        return note.startBeat >= beat - 1e-8 ? Math.max(0, note.startBeat - beat) : Infinity
      if (note.startBeat > beat + 1e-8) return note.startBeat - beat
      if (beat < loop.start || note.startBeat < loop.start) return Infinity
      return loop.end - beat + note.startBeat - loop.start
    }
    return countingIn ? note.startBeat - beat : note.startBeat > beat + 1e-8 ? note.startBeat - beat : Infinity
  }
  const futureNotes = plan.filter((note) => note.position && (loop || !activeNotes.includes(note)) &&
    distanceTo(note) >= -1e-8)
  const nextDistance = futureNotes.reduce((nearest, note) => Math.min(nearest, distanceTo(note)), Infinity)
  const nextNotes = futureNotes.filter((note) => Math.abs(distanceTo(note) - nextDistance) < 1e-8)
  const barIndex = barAt(song, Math.max(0, beat))
  const gripBeat = activeNotes.length ? Math.max(...activeNotes.map((note) => note.startBeat)) : beat
  const gripNotes = activeNotes.length ? plan.filter((note) => note.position && note.startBeat <= gripBeat + 1e-8 &&
    gripBeat < note.startBeat + note.beats - 1e-8) : []
  const selected = selectHandNotes(gripNotes, config)
  const frettedNow = selected.notes
  // Only the notes sounding now are marked; the next note is shown as text in the NEXT row, never as a marker.
  const handNotes = frettedNow
  const state = handNotes.length ? 'pressed' as const : null
  const grip = !handNotes.length ? { contacts: [], unavailable: false }
    : selected.unavailable && frettedNow.length ? { contacts: [], unavailable: true }
      : planFrettedHand(handNotes, config, handMemory)
  const contacts: GuideContact[] = grip.unavailable ? [] : grip.contacts.flatMap((contact) => {
    const note = handNotes.find((item) => item.index === contact.index)
    return note ? [{
      ...contact,
      source: note.finger === contact.finger ? 'lesson' as const : 'suggested' as const,
      state: state!,
      feedback: feedbackFor(note),
    }] : []
  })
  const targets: GuideTarget[] = []
  if (grip.unavailable) for (const note of handNotes)
    if (note.position?.fret) targets.push({ note, state: state!, feedback: feedbackFor(note) })
  // Ringing notes the hand is not asked to hold stay marked as targets without a finger.
  if (frettedNow.length) for (const note of activeNotes)
    if (note.position?.fret && !handNotes.includes(note) && !targets.some((target) => target.note === note))
      targets.push({ note, state: 'pressed', feedback: feedbackFor(note) })
  const openTargets: GuideTarget[] = []
  const activeOpenByString = new Map<number, FrettedTabNote>()
  for (const note of activeNotes) if (note.position?.fret === 0) {
    const previous = activeOpenByString.get(note.position.string)
    if (!previous || previous.startBeat < note.startBeat) activeOpenByString.set(note.position.string, note)
  }
  for (const note of activeOpenByString.values())
    openTargets.push({ note, state: 'pressed', feedback: feedbackFor(note) })
  const noteKey = (notes: readonly FrettedTabNote[]) => notes.map((note) =>
    `${note.index}:${note.startBeat}:${note.beats}:${note.position?.string ?? ''}:${note.position?.fret ?? ''}`)
    .join(',')
  const key = [
    contacts.map((contact) => `${contact.index}:${contact.finger}:${contact.string}:${contact.fret}:${contact.barre}:${contact.source}:${contact.state}:${contact.feedback ?? ''}`).join(','),
    targets.map((target) => `${target.note.index}:${target.state}:${target.feedback ?? ''}`).join(','),
    openTargets.map((target) => `${target.note.index}:${target.state}:${target.feedback ?? ''}`).join(','),
    `${grip.unavailable}:${state ?? ''}:${countingIn}:${playing}:${barIndex}:` +
      `${noteKey(activeNotes)}:${noteKey(nextNotes)}`,
  ].join('|')
  const chordSymbol = song.chords?.find((chord) => beat >= chord.startBeat - 1e-8 &&
    beat < chord.startBeat + chord.beats && chord.symbol && chord.symbol !== 'N.C.')?.symbol ?? null
  return { contacts, targets, openTargets, currentNotes: activeNotes, nextNotes, chord: chordSymbol,
    unavailable: grip.unavailable, state, countingIn, playing, barIndex, key: `${key}|${chordSymbol ?? ''}` }
}

function FingerGuide({
  config, handedness, plan, frame, onPick,
}: {
  config: FrettedInstrumentConfig
  handedness: 'right' | 'left'
  plan: readonly FrettedTabNote[]
  frame: GuideFrame
  onPick: (beat: number) => void
}) {
  const strings = [...config.strings].sort((a, b) => a.conventionalStringNumber - b.conventionalStringNumber)
  const startFret = 0
  const endFret = config.frets
  const visibleFrets = Math.max(1, endFret - startFret)
  const viewWidth = 1000
  const labelEnd = 180
  const boardEnd = 985
  const boardWidth = boardEnd - labelEnd
  const lastFretDistance = fretDistanceFromNut(endFret, config)
  const rowTop = 50
  const rowHeight = 42
  const viewHeight = rowTop + strings.length * rowHeight + 18
  const rowY = (string: number) => rowTop +
    (strings.findIndex((item) => item.string === string) + 0.5) * rowHeight
  const fretX = (fret: number) => {
    const ratio = Math.min(1, Math.max(0, fretDistanceFromNut(fret, config) / lastFretDistance))
    return labelEnd + boardWidth * (handedness === 'left' ? 1 - ratio : ratio)
  }
  const positionX = (fret: number) => {
    const centerDistance = fret > 0
      ? (fretDistanceFromNut(fret - 1, config) + fretDistanceFromNut(fret, config)) / 2
      : 0
    const ratio = Math.min(1, Math.max(0, centerDistance / lastFretDistance))
    return labelEnd + boardWidth * (handedness === 'left' ? 1 - ratio : ratio)
  }
  const fretLabelX = (fret: number) => positionX(fret)
  const yPercent = (string: number) => `${(rowY(string) / viewHeight) * 100}%`
  const xPercent = (x: number) => `${(x / viewWidth) * 100}%`
  const samePosition = (first: FrettedTabNote, second: FrettedTabNote) =>
    first.position?.string === second.position?.string && first.position?.fret === second.position?.fret
  const cueTop = (string: number, overlap: boolean, state: GuideTarget['state']) =>
    overlap ? `calc(${yPercent(string)} ${state === 'preview' ? '-' : '+'} 12px)` : yPercent(string)
  const describeNotes = (notes: readonly FrettedTabNote[]) => notes.map((note) => {
    const position = note.position
    if (!position) return ''
    const string = config.strings.find((item) => item.string === position.string)
    return `String ${position.conventionalStringNumber} ${string?.name ?? ''} · ${
      position.fret === 0 ? 'OPEN' : `Fret ${position.fret}`
    }`
  }).filter(Boolean).join('; ')
  const nowDescription = describeNotes(frame.currentNotes) || 'No current note'
  const nextDescription = describeNotes(frame.nextNotes) || 'No next note'
  const handCues = new Map<string, {
    finger: number; fret: number; source: Set<'lesson' | 'suggested'>; strings: Set<string>
  }>()
  for (const contact of frame.contacts) {
    const key = `${contact.finger}:${contact.fret}`
    const cue = handCues.get(key) ?? {
      finger: contact.finger, fret: contact.fret, source: new Set<'lesson' | 'suggested'>(), strings: new Set<string>(),
    }
    cue.source.add(contact.source)
    const string = config.strings.find((item) => item.string === contact.string)
    if (string) cue.strings.add(`${string.conventionalStringNumber} ${string.name}`)
    handCues.set(key, cue)
  }
  const fingerNames: Record<number, string> = {
    1: 'Index finger', 2: 'Middle finger', 3: 'Ring finger', 4: 'Little finger', 5: 'Thumb',
  }
  const fingerCues = [...handCues.values()].map((cue) => {
    const code = cue.finger === 5 ? 'T' : String(cue.finger)
    const source = cue.source.size === 1 && cue.source.has('lesson') ? 'Lesson fingering' : 'Suggested fingering'
    return { finger: cue.finger, text: `${fingerNames[cue.finger]} (${code}) · string${cue.strings.size > 1 ? 's' : ''} ${
      [...cue.strings].join(', ')
    } · Fret ${cue.fret} · ${source}` }
  })
  const fingerDescription = fingerCues.map((cue) => cue.text).join('; ')
  const barres = new Map<string, { finger: number; fret: number; strings: number[]; state: 'pressed' | 'preview' }>()
  for (const contact of frame.contacts) if (contact.barre) {
    const key = `${contact.finger}:${contact.fret}:${contact.state}`
    const group = barres.get(key) ?? { finger: contact.finger, fret: contact.fret, strings: [], state: contact.state }
    group.strings.push(contact.string)
    barres.set(key, group)
  }
  return (
    <div className="fretted-guide-content">
      <div className="fretted-finger-guide" data-handedness={handedness}
        data-start-fret={startFret} data-end-fret={endFret}
        role="group" aria-label={`${config.name} fretboard finger guide`}>
        <div className="fretted-guide-board" style={{ height: `${viewHeight}px` }}>
          <svg aria-hidden="true" viewBox={`0 0 ${viewWidth} ${viewHeight}`} preserveAspectRatio="none">
            <rect className="fretted-guide-board-wood" x={labelEnd} y={rowTop} width={boardWidth}
              height={strings.length * rowHeight} rx="5" />
            {Array.from({ length: visibleFrets + 1 }, (_, index) => {
              const fret = startFret + index
              const x = fretX(fret)
              return <line key={`fretline-${fret}`} className={fret === 0 ? 'fretted-guide-nut' : 'fretted-guide-fretwire'}
                data-fret={fret} data-distance-from-nut={fretDistanceFromNut(fret, config)}
                x1={x} y1={rowTop} x2={x} y2={rowTop + strings.length * rowHeight} />
            })}
            {strings.map((string) =>
              <line key={`stringline-${string.string}`} className="fretted-guide-string"
                x1={labelEnd} y1={rowY(string.string)} x2={boardEnd} y2={rowY(string.string)} />)}
            {[...barres.values()].map((barre) => {
              const ys = barre.strings.map(rowY)
              const first = Math.min(...ys)
              const last = Math.max(...ys)
              return <line key={`barre-${barre.finger}-${barre.fret}-${barre.state}`}
                className="fretted-finger-barre" data-finger={barre.finger} data-fret={barre.fret}
                data-state={barre.state} x1={positionX(barre.fret)} y1={first}
                x2={positionX(barre.fret)} y2={last} />
            })}
          </svg>
          {strings.map((string) =>
            <span key={`string-label-${string.string}`} className="fretted-finger-string-label"
              data-string={string.string} style={{ top: yPercent(string.string) }}
              title={`String ${string.conventionalStringNumber} ${string.name}; open pitch ${string.openPitch}`}>
              <b>{string.conventionalStringNumber}</b> {string.name}
            </span>)}
          {Array.from({ length: visibleFrets }, (_, index) => {
            const fret = startFret + index + 1
            return <span key={`fret-label-${fret}`} className="fretted-finger-fret-label"
              data-fret={fret} data-distance-from-nut={fretDistanceFromNut(fret, config)}
              style={{ left: xPercent(fretLabelX(fret)) }}>{fret}</span>
          })}
          {frame.contacts.map((contact) => {
            const note = plan.find((item) => item.index === contact.index)
            if (!note) return null
            const fingerCode = contact.finger === 5 ? 'T' : String(contact.finger)
            const string = config.strings.find((item) => item.string === contact.string)
            return <button key={`contact-${contact.index}`} type="button" className="fretted-finger-dot"
              data-finger={contact.finger} data-string={contact.string} data-fret={contact.fret}
              data-distance-from-nut={(fretDistanceFromNut(contact.fret - 1, config) +
                fretDistanceFromNut(contact.fret, config)) / 2}
              data-state={contact.state} data-source={contact.source}
              data-feedback-state={contact.feedback}
              aria-label={`${fingerNames[contact.finger]} (${fingerCode}) · string ${string?.conventionalStringNumber} ${string?.name} · fret ${contact.fret}${contact.source === 'lesson' ? ' · lesson fingering' : ' · suggested fingering'}`}
              title={`${fingerNames[contact.finger]} (${fingerCode}) · string ${string?.conventionalStringNumber} ${string?.name} · fret ${contact.fret}`}
              style={{ left: xPercent(positionX(contact.fret)),
                top: cueTop(contact.string, false, contact.state) }}
              onClick={() => onPick(note.startBeat)}>{fingerCode}</button>
          })}
          {frame.targets.map(({ note, state, feedback }) => {
            const position = note.position
            if (!position || position.fret < startFret + 1 || position.fret > endFret) return null
            const string = config.strings.find((item) => item.string === position.string)
            const overlapsCurrent = frame.currentNotes.some((item) => samePosition(item, note))
            return <button key={`target-${note.index}`} type="button" className="fretted-finger-target"
              data-string={position.string} data-fret={position.fret} data-state={state}
              data-distance-from-nut={(fretDistanceFromNut(position.fret - 1, config) +
                fretDistanceFromNut(position.fret, config)) / 2}
              data-overlaps-current={overlapsCurrent || undefined}
              data-feedback-state={feedback}
              aria-label={`${position.pitchName} · string ${position.conventionalStringNumber} ${string?.name} · fret ${position.fret} · ${state === 'pressed' ? 'current target, no finger assignment' : 'upcoming target'}`}
              title={`${position.pitchName} · string ${position.conventionalStringNumber} ${string?.name} · fret ${position.fret}`}
              style={{ left: xPercent(positionX(position.fret)),
                top: cueTop(position.string, overlapsCurrent, state) }}
              onClick={() => onPick(note.startBeat)}>{position.pitchClass}</button>
          })}
          {frame.openTargets.map(({ note, state, feedback }) => {
            const position = note.position
            if (!position) return null
            const string = config.strings.find((item) => item.string === position.string)
            return <button key={`open-${note.index}`} type="button" className="fretted-finger-open-cue"
              data-string={position.string} data-fret="0" data-state={state}
              data-feedback-state={feedback}
              aria-label={`String ${position.conventionalStringNumber} ${string?.name}, open string, no fretting finger · ${state === 'pressed' ? 'current' : 'upcoming'}`}
              title={`String ${position.conventionalStringNumber} ${string?.name} · open, no fretting finger`}
              style={{ left: xPercent(fretX(0)), top: cueTop(position.string, false, state) }}
              onClick={() => onPick(note.startBeat)}>OPEN</button>
          })}
        </div>
      </div>
      <div className="fretted-guide-summary" aria-live="polite">
        <div className="fretted-guide-cues">
          <div className="fretted-guide-row" title={nowDescription}>
            <b>NOW</b><span>{nowDescription}</span>
          </div>
          <div className="fretted-guide-row" title={nextDescription}>
            <b>{frame.countingIn ? 'COUNT-IN' : 'NEXT'}</b><span>{nextDescription}</span>
          </div>
          <div className="fretted-guide-row" title={fingerDescription || 'No finger assignment'}>
            <b>FINGERS</b><span className={frame.unavailable ? 'is-unavailable' : undefined}>
              {frame.unavailable ? 'No plausible hand pose; fret and string targets remain marked.' :
                fingerCues.length ? <FingerCueList cues={fingerCues} /> : <FingerLegend />}
            </span>
          </div>
          <div className="fretted-guide-row fretted-guide-key">
            <b>KEY</b><span><FingerLegend />. OPEN needs no finger.</span>
          </div>
        </div>
        <div className="fretted-hand-side-inset">
          <svg viewBox="0 0 108 48" aria-hidden="true">
            <rect className="neck" x="5" y="27" width="98" height="13" rx="3" />
            <line className="string" x1="7" y1="26" x2="101" y2="26" />
            <path className="finger" d="M12 13 C37 13 49 14 61 19 C67 22 68 25 74 26" />
            <circle className="joint" cx="43" cy="14" r="2.5" />
            <circle className="joint" cx="61" cy="19" r="2.5" />
            <path className="thumb" d="M52 42 C60 35 72 35 80 42" />
          </svg>
          <span>Fingertip close behind fret · thumb supports behind neck</span>
        </div>
      </div>
    </div>
  )
}

type MirrorGuidanceProps = {
  overlay: Overlay
  width: number
  height: number
  config: FrettedInstrumentConfig
  plan: readonly FrettedTabNote[]
  beat: number
  onPick: (beat: number) => void
  handedness: 'right' | 'left'
  showGuides: boolean
  showStringNames: boolean
  chordName: string | null
}

const FINGER_WORDS: Record<number, string> = { 1: '1', 2: '2', 3: '3', 4: '4', 5: 'T' }
const FINGER_LEGEND: [number, string][] = [[1, '1 Index'], [2, '2 Middle'], [3, '3 Ring'], [4, '4 Little'], [5, 'T Thumb']]
function FingerLegend() {
  return <>{FINGER_LEGEND.map(([finger, text], index) => <span key={finger} data-finger={finger}>
    {index > 0 && ' · '}<i className="finger-swatch" aria-hidden="true" />{text}</span>)}</>
}
function FingerCueList({ cues }: { cues: { finger: number; text: string }[] }) {
  return <>{cues.map((cue, index) => <span key={`${cue.finger}:${index}`} data-finger={cue.finger}>
    {index > 0 && '; '}<i className="finger-swatch" aria-hidden="true" />{cue.text}</span>)}</>
}

function MirrorGuidance({
  overlay, width, height, config, plan, beat, onPick, handedness, showGuides, showStringNames, chordName,
}: MirrorGuidanceProps) {
  const pixelRatio = Math.min(2, globalThis.devicePixelRatio || 1)
  const place = (x: number, y: number) => ({
    left: `${(x / Math.max(1, width)) * 100}%`, top: `${(y / Math.max(1, height)) * 100}%`,
  })
  const fingerFor = (string: number, fret: number, index: number) =>
    overlay.hand?.contacts.find((contact) => contact.string === string && contact.fret === fret)?.finger
    ?? plan.find((note) => note.index === index)?.finger
  type Target = {
    key: string; kind: 'fretted' | 'open'; state: string; string: number; fret: number
    x: number; y: number; index: number; pitchName: string; conventional: number; name: string
  }
  const targets: Target[] = [
    ...overlay.markers.map((marker): Target => ({
      key: `m:${marker.index}:${marker.position.string}:${marker.position.fret}:${marker.state}`,
      kind: 'fretted', state: marker.state, string: marker.position.string, fret: marker.position.fret,
      x: marker.anchorX, y: marker.anchorY, index: marker.index, pitchName: marker.position.pitchName,
      conventional: marker.position.conventionalStringNumber,
      name: config.strings.find((item) => item.string === marker.position.string)?.name ?? '',
    })),
    ...overlay.openTargets.map((target): Target => ({
      key: `o:${target.index}:${target.string}:${target.state}`, kind: 'open', state: target.state,
      string: target.string, fret: 0, x: target.x, y: target.y, index: target.index,
      pitchName: target.pitchName, conventional: target.conventionalStringNumber, name: target.name,
    })),
  ]
  // Only fretted notes with a finger get its colour; open and muted markers stay neutral.
  const fingerOf = (target: Target) => target.kind !== 'fretted' || target.state === 'muted' ? undefined
    : fingerFor(target.string, target.fret, target.index)
  const digitFor = (target: Target) => {
    if (target.kind !== 'fretted' || target.state === 'upcoming' || target.state === 'muted') return ''
    const finger = fingerFor(target.string, target.fret, target.index)
    return finger ? FINGER_WORDS[finger] : ''
  }
  const current = targets.filter((target) => target.state === 'playback')
  const labelled = current
  const labelTarget = [...labelled].sort((a, b) => a.y - b.y)[0]
  let label: { title: string; detail: string; next: string; badge: string; finger?: number; aria: string; x: number; y: number
    side: 'left' | 'right'; vertical: 'above' | 'below'; lead: number } | null = null
  if (labelTarget) {
    const single = labelled.length === 1
    const finger = single ? fingerFor(labelTarget.string, labelTarget.fret, labelTarget.index) : undefined
    const title = single ? labelTarget.pitchName : chordName ?? 'Chord'
    const where = labelTarget.fret === 0 ? 'Open' : `Fret ${labelTarget.fret}`
    const detail = single ? (current.length ? where : `Next · ${where}`)
      : `${labelled.length} notes${current.length ? '' : ' · next'}`
    const next = ''
    const badge = finger ? FINGER_WORDS[finger] : ''
    const cssWidth = width / pixelRatio
    const anchorX = labelTarget.x / pixelRatio, anchorY = labelTarget.y / pixelRatio
    const estimated = Math.max(title.length * 9, detail.length * 5.8, next.length * 5.2) + (badge ? 26 : 0) + 22
    let side: 'left' | 'right' = handedness === 'right' ? 'right' : 'left'
    if (side === 'right' && anchorX - 12 + estimated > cssWidth - 6) side = 'left'
    else if (side === 'left' && anchorX + 12 - estimated < 6) side = 'right'
    const above = anchorY >= (next ? 76 : 64)
    label = { title, detail, next, badge, finger,
      aria: [title, detail, badge ? `Finger ${badge}` : '', next].filter(Boolean).join(' · '),
      x: labelTarget.x, y: labelTarget.y, side, vertical: above ? 'above' : 'below',
      lead: above ? Math.max(8, Math.min(26, anchorY - (next ? 64 : 52))) : 14 }
  }
  const seek = (target: Target) => onPick(plan.find((note) => note.index === target.index)?.startBeat ?? beat)
  const describe = (target: Target) => target.kind === 'open'
    ? `${target.pitchName}, string ${target.conventional} ${target.name}, open string`
    : `${target.pitchName}, string ${target.conventional} ${target.name}, fret ${target.fret}`
  return <div className="fretted-overlay fretted-mirror-overlay" data-pane-overlay="overview"
    data-guides={showGuides || undefined}>
    <svg aria-hidden="true" viewBox={`0 0 ${Math.max(1, width)} ${Math.max(1, height)}`}
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 0, pointerEvents: 'none' }}>
      {showGuides && overlay.fretRegions.filter((region) => region.state === 'playback').map((region) =>
        <polygon key={`region-${region.fret}`} className="fretted-mirror-fret-region" data-fret={region.fret}
          points={region.points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} />)}
      {showStringNames && overlay.stringLabels.map((item) =>
        <line key={`name-leader-${item.string}`} className="fretted-mirror-name-leader"
          x1={item.x} y1={item.y} x2={item.anchorX} y2={item.anchorY} />)}
    </svg>
    {showStringNames && overlay.stringLabels.map((item) =>
      <span key={`name-${item.string}`} className="fretted-mirror-string-label" data-string={item.string}
        style={place(item.x, item.y)}
        title={`String ${item.name}; open pitch ${config.strings[item.string - 1].openPitch}`}>{item.name}</span>)}
    {showGuides && targets.map((target) =>
      <button key={target.key} type="button" className="fretted-mirror-target" data-kind={target.kind}
        data-state={target.state} data-string={target.string} data-fret={target.fret}
        data-finger={fingerOf(target)}
        style={place(target.x, target.y)} aria-label={`${describe(target)}; ${
          target.state === 'playback' ? 'current' : target.state}`}
        title={`${target.pitchName} · String ${target.conventional} · ${target.fret === 0 ? 'Open' : `Fret ${target.fret}`}`}
        onClick={() => seek(target)}>
        <span className="fretted-mirror-halo" />
        <span className="fretted-mirror-core" data-digit={digitFor(target) ? '' : undefined}>
          {target.state === 'muted' ? '×'
            : target.state === 'correctly-played' || target.state === 'current-played' ? '✓'
              : digitFor(target)}
        </span>
      </button>)}
    {showGuides && label && <div className="fretted-mirror-callout" data-side={label.side} data-vertical={label.vertical}
      style={{ ...place(label.x, label.y), '--lead': `${label.lead}px` } as CSSProperties}>
      <span className="fretted-mirror-leader" />
      <span className="fretted-mirror-label" aria-label={label.aria}>
        <span className="fretted-mirror-label-text">
          <b>{label.title}</b><small>{label.detail}</small>{label.next && <small>{label.next}</small>}
        </span>
        {label.badge && <i className="fretted-mirror-badge" data-finger={label.finger}>{label.badge}</i>}
      </span>
    </div>}
    {overlay.plucks.map((pluck) =>
      <span key={`${pluck.index}:${pluck.string}`} className="fretted-pluck" data-string={pluck.string}
        style={place(pluck.x, pluck.y)}
        title={`Pluck ${pluck.name}, string ${pluck.conventionalStringNumber}`} aria-hidden="true" />)}
  </div>
}

export function FrettedInstrumentView({
  song, track, trackId, beat, playing, countingIn = false, onPick, engine,
  style: chosenStyle, onStyleChange,
  handedness: chosenHandedness, onHandednessChange,
  feedback = EMPTY_FEEDBACK, showTabStrip = true, config,
}: FrettedInstrumentViewProps & { config: FrettedInstrumentConfig }) {
  const section = useRef<HTMLElement>(null)
  // The view, look, string names, guides and hands follow the player across lessons and restarts.
  const [saved] = useState(loadPrefs)
  const [viewMode, setViewModeState] = useState<'guide' | 'mirror'>(saved.frettedView ?? 'guide')
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const [renderer, setRenderer] = useState<FrettedRenderer | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [handRevision, setHandRevision] = useState(0)
  const [localStyle, setLocalStyle] = useState<FrettedStyle>(
    saved.frettedLook ? normalizeFrettedStyle(saved.frettedLook) : 'Realistic')
  const [localHandedness, setLocalHandedness] = useState<'right' | 'left'>(saved.frettedHandedness ?? 'right')
  const [overlay, setOverlay] = useState<Overlay>(EMPTY_OVERLAY)
  const [guideFrame, setGuideFrame] = useState<GuideFrame>(EMPTY_GUIDE)
  const [showGuides, setShowGuidesState] = useState(saved.frettedGuides ?? true)
  const [showStringNames, setShowStringNamesState] = useState(saved.frettedNames ?? false)
  const [showHands, setShowHandsState] = useState(saved.hands ?? true)
  const [noteOpen, setNoteOpen] = useState(false)
  const handsRef = useRef(showHands)
  const blending = useRef(false)
  const blendFrame = useRef(0)
  const redraw = useRef<(transport?: Transport) => void>(() => {})
  useEffect(() => () => cancelAnimationFrame(blendFrame.current), [])
  const reduced = useReducedMotion()
  const handedness = chosenHandedness ?? localHandedness
  const style = chosenStyle ? normalizeFrettedStyle(chosenStyle as Look) : localStyle
  const source = notesForTrack(song, track, trackId)
  const plan = useMemo(() => planFrettedTab(source, config), [source, config])
  const latest = useRef({ beat, playing, countingIn, style, handedness, plan, feedback, song })
  const handMemory = useRef<{ plan: readonly FrettedTabNote[]; assignments: FrettedHandMemory } | null>(null)
  const lastOverlayKey = useRef('')
  const lastStaticFrame = useRef<string | null>(null)
  useEffect(() => {
    latest.current = { beat, playing, countingIn, style, handedness, plan, feedback, song }
  }, [beat, playing, countingIn, style, handedness, plan, feedback, song])
  const selectHandedness = (value: 'right' | 'left') => {
    setLocalHandedness(value)
    savePref('frettedHandedness', value)
    onHandednessChange?.(value)
  }
  const selectStyle = (value: FrettedStyle) => {
    setLocalStyle(value)
    savePref('frettedLook', value)
    onStyleChange?.(value)
  }
  const setViewMode = (value: 'guide' | 'mirror') => { setViewModeState(value); savePref('frettedView', value) }
  const setShowGuides = (update: (value: boolean) => boolean) => setShowGuidesState((value) => {
    const next = update(value); savePref('frettedGuides', next); return next
  })
  const setShowStringNames = (update: (value: boolean) => boolean) => setShowStringNamesState((value) => {
    const next = update(value); savePref('frettedNames', next); return next
  })
  const setShowHands = (update: (value: boolean) => boolean) => setShowHandsState((value) => {
    const next = update(value); savePref('hands', next); return next
  })
  useEffect(() => { handsRef.current = showHands }, [showHands])

  const drawFrame = useCallback((transport?: Transport) => {
    const current = latest.current
    const clock = transport ?? {
      beat: current.beat, playing: current.playing, countingIn: current.countingIn, countBeat: 0,
    }
    const loop = engine?.loop ? {
      start: barStart(current.song, engine.loop.startBar - 1),
      end: barStart(current.song, engine.loop.endBar),
    } : null
    if (!handMemory.current || handMemory.current.plan !== current.plan)
      handMemory.current = { plan: current.plan, assignments: suggestFrettedFingers(current.plan, config) }
    const guide = buildGuideFrame(current.plan, config, current.song, clock.beat,
      clock.countingIn, clock.playing, loop, current.feedback, handMemory.current.assignments)
    setGuideFrame((previous) => previous.key === guide.key ? previous : guide)
    if (viewMode === 'guide' || !renderer || !canvas || !size.width || !size.height) return
    const secondsPerBeat = 60 / Math.max(1, engine?.getEffectiveQuarterBpm() ?? current.song.bpm)
    const viewport = { x: 0, y: 0, width: canvas.width, height: canvas.height }
    renderer.setGuides(showGuides)
    renderer.setHands(showHands)
    const frame = renderer.draw(viewport.width, viewport.height, current.style, performance.now(),
      current.plan, clock.beat, secondsPerBeat, clock.playing, clock.countingIn, loop,
      current.feedback, reduced, current.handedness, current.song.beatsPerBar,
      viewport, handMemory.current.assignments)
    blending.current = frame.handBlending
    if (frame.handBlending && !blendFrame.current) {
      // A blending hand needs frames even while paused; the animation ends by itself.
      blendFrame.current = requestAnimationFrame(() => { blendFrame.current = 0; redraw.current(engine?.read()) })
    }
    const overlayOf = (frame: FrettedFrame): Overlay => ({
      markers: [...frame.markers], openTargets: [...frame.openTargets], fretRegions: [...frame.fretRegions],
      stringLabels: [...frame.stringLabels],
      fretLabels: [...frame.fretLabels], plucks: [...frame.plucks], pick: frame.pick,
      stringGuides: [...frame.stringGuides], hand: frame.hand,
      handUnavailable: frame.handUnavailable,
      handPending: frame.handPending,
    })
    const keyOf = (frame: FrettedFrame) =>
      frame.markers.map((marker) =>
        `${marker.index}:${marker.x.toFixed(1)}:${marker.y.toFixed(1)}:${marker.state}`).join('|') +
      frame.openTargets.map((target) =>
        `o${target.index}:${target.string}:${target.x.toFixed(1)}:${target.y.toFixed(1)}:${target.state}`).join('|') +
      frame.fretRegions.map((region) => `r${region.fret}:${region.state}:${region.points.map(([x, y]) =>
        `${x.toFixed(1)},${y.toFixed(1)}`).join(';')}`).join('|') +
      frame.stringLabels.map((label) => `${label.string}:${label.x.toFixed(1)}:${label.y.toFixed(1)}`).join('|') +
      frame.fretLabels.map((label) => `${label.fret}:${label.x.toFixed(1)}:${label.y.toFixed(1)}`).join('|') +
      (frame.pick ? `pick:${frame.pick.x.toFixed(1)}:${frame.pick.y.toFixed(1)}:${frame.pick.index}:${frame.pick.active}` : '') +
      frame.plucks.map((pluck) => `${pluck.index}:${pluck.string}:${pluck.x.toFixed(1)}:${pluck.y.toFixed(1)}`).join('|') +
      frame.stringGuides.map((guide) =>
        `${guide.string}:${guide.visible.join(';')}:${guide.hidden.join(';')}`).join('|') +
      (frame.hand?.contacts.map((contact) =>
        `${contact.finger}:${contact.string}:${contact.fret}:${contact.source}`).join('|') ?? '') +
      (frame.hand?.fingerLabels.map((label) =>
        `${label.finger}:${label.x.toFixed(1)}:${label.y.toFixed(1)}:${label.pressed}`).join('|') ?? '') +
      `${frame.hand?.state ?? ''}:${frame.handUnavailable}:${frame.handPending}:${frame.handDrawn}`
    const key = keyOf(frame)
    if (key !== lastOverlayKey.current) {
      lastOverlayKey.current = key
      setOverlay(overlayOf(frame))
    }
    if (section.current) {
      section.current.dataset.vibrating = frame.vibrations.map((item) => item.string).join(',')
      section.current.dataset.vibrationFret = frame.vibrations.map((item) =>
        `${item.string}:${item.fret}:${item.activeStartX.toFixed(4)}`).join(',')
      section.current.dataset.triangles = String(frame.triangles)
      section.current.dataset.handDrawn = String(frame.handDrawn)
      section.current.dataset.handReason = frame.handReason
    }
    const hook = frameHook(config.id === 'guitar' ? '__mizanGuitarFrame' : '__mizanBassFrame')
    hook?.(canvas, frame, 'overview')
  }, [canvas, config, engine, reduced, renderer, showGuides, showHands, size.height, size.width, viewMode])
  useEffect(() => { redraw.current = drawFrame }, [drawFrame])

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
    if (!element || viewMode === 'guide') return
    let cancelled = false
    let instance: FrettedRenderer | null = null
    setLoading(true)
    Promise.all([
      loadGlb(config.file),
      // The hand models are only fetched when hands are on; turning them on later loads them then.
      handsRef.current ? loadFrettedHands().catch((error: unknown) => {
        console.warn('The optional fretting-hand models could not load; 3D targets will remain available.', error)
        return null
      }) : Promise.resolve(null),
    ]).then(async ([asset, hands]) => {
      const images = await asset.images
      if (cancelled) return
      const capture = globalThis as { __mizanGuitarCapture?: boolean; __mizanBassCapture?: boolean }
      const keep = config.id === 'guitar' ? !!capture.__mizanGuitarCapture : !!capture.__mizanBassCapture
      const gl = element.getContext('webgl', { alpha: false, antialias: true, preserveDrawingBuffer: keep })
      if (!gl) throw new Error('WebGL is unavailable on this device.')
      instance = new FrettedRenderer(gl, asset, config, images, hands, (error) => {
        if (cancelled) return
        if (error) setFailure('The 3D hand could not be prepared. Use Finger guide or the tab below.')
        lastStaticFrame.current = null
        setHandRevision((previous) => previous + 1)
      })
      if (cancelled) { instance.dispose(); return }
      setFailure(null)
      setRenderer(instance)
      setLoading(false)
    }).catch((error: unknown) => {
      if (cancelled) return
      console.error(`${config.name} visualization could not load.`, error)
      setFailure(`The 3D ${config.name.toLowerCase()} could not load. Use Finger guide or the tab below.`)
      setLoading(false)
    })
    const lost = (event: Event) => { event.preventDefault(); setFailure('The 3D view lost its graphics context. Reload the practice view to restore it.') }
    element.addEventListener('webglcontextlost', lost)
    return () => {
      cancelled = true
      element.removeEventListener('webglcontextlost', lost)
      instance?.dispose()
      setRenderer(null)
      setLoading(false)
    }
  }, [canvas, config, viewMode])

  // Turning hands on after the model loaded fetches the hand models then, not before.
  useEffect(() => {
    if (!renderer || !showHands) return
    let cancelled = false
    loadFrettedHands().then((hands) => { if (!cancelled) renderer.attachHands(hands) }).catch((error: unknown) => {
      console.warn('The optional fretting-hand models could not load; 3D targets will remain available.', error)
    })
    return () => { cancelled = true }
  }, [renderer, showHands])

  useEffect(() => {
    if (engine) return
    drawFrame()
  }, [drawFrame, engine, style, handedness, plan, beat, playing, countingIn, feedback, song, handRevision])
  useEffect(() => {
    if (!engine) return
    lastStaticFrame.current = null
    drawFrame(engine.read())
  }, [drawFrame, engine, style, handedness, plan, feedback, song, handRevision])
  useFrame(engine ?? null, (transport) => {
    const loop = engine?.loop
    const staticFrame = `${transport.beat}:${loop ? `${loop.startBar}:${loop.endBar}` : ''}`
    if (!transport.playing && lastStaticFrame.current === staticFrame && !blending.current) return
    lastStaticFrame.current = transport.playing ? null : staticFrame
    drawFrame(transport)
  })

  const names = config.strings.map((item) => item.name).join(', ')
  const fingerNames: Record<number, string> = {
    1: 'Index finger', 2: 'Middle finger', 3: 'Ring finger', 4: 'Little finger', 5: 'Thumb',
  }
  const groupedCues = new Map<string, {
    finger: number; fret: number; source: Set<'lesson' | 'suggested'>; strings: Set<string>
  }>()
  const activeOverlay = overlay
  const displayedContacts = viewMode === 'guide' ? guideFrame.contacts : activeOverlay.hand?.contacts ?? []
  for (const contact of displayedContacts) {
    const key = `${contact.finger}:${contact.fret}`
    const cue = groupedCues.get(key) ?? {
      finger: contact.finger, fret: contact.fret, source: new Set<'lesson' | 'suggested'>(), strings: new Set<string>(),
    }
    cue.source.add(contact.source)
    const string = config.strings.find((item) => item.string === contact.string)
    if (string) cue.strings.add(`${string.conventionalStringNumber} ${string.name}`)
    groupedCues.set(key, cue)
  }
  const displayedCountingIn = guideFrame.countingIn
  const displayedPlaying = guideFrame.playing
  const handCueState = displayedCountingIn ? 'COUNT-IN · GET READY'
    : guideFrame.currentNotes.length ? 'NOW · HOLD' : 'NEXT · PREPARE'
  const describeNotes = (notes: readonly FrettedTabNote[]) => notes.map((note) => {
    const position = note.position
    if (!position) return ''
    const string = config.strings.find((item) => item.string === position.string)
    return `String ${position.conventionalStringNumber} ${string?.name ?? ''} · ${
      position.fret === 0 ? 'OPEN' : `Fret ${position.fret}`
    }`
  }).filter(Boolean).join('; ')
  const currentDescription = describeNotes(guideFrame.currentNotes) || 'No current note'
  const nextDescription = describeNotes(guideFrame.nextNotes) || 'No next note'
  const fingerCues = [...groupedCues.values()].map((cue) => {
    const code = cue.finger === 5 ? 'T' : String(cue.finger)
    const source = cue.source.size === 1 && cue.source.has('lesson') ? 'Lesson fingering' : 'Suggested fingering'
    return { finger: cue.finger, text: `${fingerNames[cue.finger]} (${code}) · string${cue.strings.size > 1 ? 's' : ''} ${
      [...cue.strings].join(', ')
    } · Fret ${cue.fret} · ${source}` }
  })
  const fingerDescription = fingerCues.map((cue) => cue.text).join('; ')
  const poseUnavailable = guideFrame.unavailable || activeOverlay.handUnavailable
  const paneSize = { width: size.width, height: size.height }

  return (
    <section ref={section} className="fretted-practice" data-instrument={config.id} data-style={style}
      data-view={viewMode}
      data-handedness={handedness} data-playing={displayedPlaying && !displayedCountingIn}
      data-counting-in={displayedCountingIn || undefined}
      data-loading={viewMode !== 'guide' && loading || undefined}
      aria-label={`${config.name} practice view`}>
      <div className="fretted-view" data-style={style}>
        <div className="kit-toolbar fretted-toolbar">
          <div className="fretted-view-switch" role="group" aria-label="Practice view">
            <button type="button" data-fretted-view="guide" aria-pressed={viewMode === 'guide'}
              onClick={() => setViewMode('guide')}>Finger guide</button>
            <button type="button" data-fretted-view="mirror" aria-pressed={viewMode === 'mirror'}
              onClick={() => setViewMode('mirror')}>3D mirror</button>
          </div>
          {viewMode !== 'guide' && <label className="kit-look">Look
            <select aria-label="Look" value={style} onChange={(event) => selectStyle(event.target.value as FrettedStyle)}>
              {FRETTED_LOOKS.map((item) => <option key={item} value={item}>{LOOK_LABEL[item]}</option>)}
            </select>
          </label>}
          <label className="kit-look">Handedness
            <select aria-label="Handedness" value={handedness} onChange={(event) => selectHandedness(event.target.value as 'right' | 'left')}>
              <option value="right">Right-handed</option>
              <option value="left">Left-handed</option>
            </select>
          </label>
          {viewMode === 'mirror' && <button type="button" className="fretted-info" aria-expanded={noteOpen}
            aria-controls="fretted-instrument-note" onClick={() => setNoteOpen((value) => !value)}>Key</button>}
        </div>
        <div className={`fretted-stage${viewMode === 'guide' ? ' fretted-stage-guide' : ' fretted-stage-3d'}`}
          data-mirror={viewMode === 'mirror' || undefined}>
          {viewMode === 'guide' ?
            <FingerGuide config={config} handedness={handedness} plan={plan}
              frame={guideFrame} onPick={onPick} /> :
            <>
              <canvas ref={setCanvas} className="fretted-canvas fretted-dual-canvas" aria-hidden="true" />
              <div className="fretted-3d-panes">
                <div className="fretted-3d-pane" data-pane="overview">
                  <span className="fretted-pane-title">Mirror view</span>
                  <div className="fretted-mirror-toggles" role="group" aria-label="Mirror view guidance">
                    <button type="button" data-mirror-toggle="names" aria-pressed={showStringNames}
                      onClick={() => setShowStringNames((value) => !value)}>String names</button>
                    <button type="button" data-mirror-toggle="guides" aria-pressed={showGuides}
                      onClick={() => setShowGuides((value) => !value)}>Guides</button>
                    <button type="button" data-mirror-toggle="hands" aria-pressed={showHands}
                      onClick={() => setShowHands((value) => !value)}>Hands</button>
                  </div>
                  {!failure && <MirrorGuidance overlay={overlay}
                    width={paneSize.width} height={paneSize.height} config={config} plan={plan} beat={beat}
                    onPick={onPick} handedness={handedness} showGuides={showGuides}
                    showStringNames={showStringNames} chordName={guideFrame.chord} />}
                </div>
              </div>
              {loading && <p className="fretted-loading" role="status">Loading the original instrument model…</p>}
              {failure && <p className="fretted-failure" role="status">{failure}</p>}
            </>}
        </div>
        {viewMode !== 'guide' && <div className="fretted-hand-guidance" aria-live="polite"
          data-state={guideFrame.state ?? 'idle'} data-unavailable={poseUnavailable || undefined}>
          <div className="fretted-hand-guidance-copy">
            <span className="fretted-hand-guidance-state">{handCueState}</span>
            <span className="fretted-hand-guidance-cue" title={currentDescription}>
              NOW · {currentDescription}
            </span>
            <span className="fretted-hand-guidance-cue" title={nextDescription}>
              {displayedCountingIn ? 'COUNT-IN' : 'NEXT'} · {nextDescription}
            </span>
            <span className="fretted-hand-guidance-cue fretted-hand-guidance-finger" title={fingerDescription || undefined}>
              {activeOverlay.handPending ? 'Preparing the hand shape; frets and strings remain marked.' :
                poseUnavailable ? 'No plausible hand pose; the hand keeps its last position and frets and strings remain marked.' :
                fingerCues.length ? <FingerCueList cues={fingerCues} /> : 'No fretting finger needed for the current note.'}
            </span>
            <span className="fretted-hand-guidance-source">
              Finger key: <FingerLegend />. Labels say “Fret N.”
            </span>
          </div>
          <div className="fretted-hand-side-inset">
            <svg viewBox="0 0 108 48" aria-hidden="true">
              <rect className="neck" x="5" y="27" width="98" height="13" rx="3" />
              <line className="string" x1="7" y1="26" x2="101" y2="26" />
              <path className="finger" d="M12 13 C37 13 49 14 61 19 C67 22 68 25 74 26" />
              <circle className="joint" cx="43" cy="14" r="2.5" />
              <circle className="joint" cx="61" cy="19" r="2.5" />
              <path className="thumb" d="M52 42 C60 35 72 35 80 42" />
            </svg>
            <span>Press close behind fret · thumb supports behind neck</span>
          </div>
        </div>}
        <p className="fretted-instrument-note" id="fretted-instrument-note" data-open={noteOpen || undefined}
          onMouseEnter={(event) => { event.currentTarget.title = event.currentTarget.textContent ?? '' }}>
          <span className="fretted-feedback-key"><strong>{viewMode === 'guide'
            ? 'Numbers in dots are fingers. Numbers above are frets.'
            : 'Finger badges are fingers; labels marked “Fret N” are frets.'}</strong> <span className="is-now">Coloured dot = play now (one colour per finger)</span>{viewMode !== 'guide' && ' · String flash = pluck.'}</span>
          {' '}Standard tuning · {names}. {viewMode === 'guide'
            ? 'Finger numbers use written lesson fingering when available; otherwise they are suggestions.'
            : showHands ? 'The rendered hand is a suggested shape, not recorded fingering.' : ''} Open strings need no fretting finger.
          {' '}{displayedCountingIn ? viewMode === 'guide'
            ? 'The first note is named in the NEXT row during the count-in.'
            : 'The first note is named in the NEXT row during the count-in; the hand stays raised until it plays.' :
            displayedPlaying ? 'The fretboard follows playback.' :
              viewMode === 'guide' ? 'Paused: the playhead stays lit.' :
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
