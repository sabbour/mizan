import type { DrumHit, DrumLane, Song, Track } from './song'
import { barAt as measureIndex, barStart, barTempo, measures as meterMeasures } from './meter'
import { isGuitarTrack } from './guitar'
import { isBassTrack } from './bass'

const DIV = 16 // divisions per quarter note
const notationEvents = (song: Song) => [...song.piano, ...song.vocals, ...song.chords, ...song.drums,
  ...Object.values(song.instrumentNotes ?? {}).flat()]
function notationPrecision(song: Song): number {
  const small = meterMeasures(song).filter((bar) => bar.beats < 1 / DIV)
  if (!small.length) return DIV
  let minimum = Math.min(...small.map((bar) => bar.beats))
  const events = notationEvents(song)
  for (const event of events) {
    const onset = event.startBeat
    const end = onset + ('beats' in event ? event.beats : 0)
    for (const bar of small) {
      const first = bar.startBeat
      const last = first + bar.beats
      if (onset < last && end >= first) {
        const points = [...new Set([first, last, Math.max(first, onset), Math.min(last, end)])]
          .filter((beat) => beat >= first && beat <= last).sort((a, b) => a - b)
        for (let i = 1; i < points.length; i++) minimum = Math.min(minimum, points[i] - points[i - 1])
      }
    }
  }
  // OSMD rounds fractions above denominator 46340 and cannot draw ghost gaps below 1e-4 whole notes.
  const division = Math.min(2048, DIV * 2 ** Math.max(0, Math.ceil(Math.log2(2 / (minimum * DIV)))))
  const last = meterMeasures(song).at(-1)!
  if (!Number.isSafeInteger(division) || (last.startBeat + last.beats) * division > Number.MAX_SAFE_INTEGER)
    throw new RangeError('The bar map exceeds safe engraving precision.')
  return division
}
type NotationBar = { startDiv: number; endDiv: number; points: { beat: number; div: number }[] }
type NotationGrid = {
  division: number
  bars: NotationBar[]
  toDiv: (beat: number) => number
  toBeat: (div: number) => number
}
const gridCache = new WeakMap<Song, { inputs: unknown[]; grid: NotationGrid }>()
export function notationGrid(song: Song): NotationGrid {
  const inputs = [song.barMap, song.bars, song.beatsPerBar, song.beatUnit, song.piano,
    song.vocals, song.chords, song.drums, song.instrumentNotes]
  const previous = gridCache.get(song)
  if (previous && inputs.every((input, index) => input === previous.inputs[index])) return previous.grid
  const division = notationPrecision(song)
  const spans = meterMeasures(song)
  const events = notationEvents(song)
  let cursor = 0
  const bars = spans.map((span) => {
    const end = span.startBeat + span.beats
    const startDiv = cursor
    const edges = new Set([span.startBeat, end])
    if (span.beats < 1 / DIV) {
      for (const event of events) {
        for (const beat of [event.startBeat, event.startBeat + ('beats' in event ? event.beats : 0)])
          if (beat > span.startBeat && beat < end) edges.add(beat)
      }
    }
    const beats = [...edges].sort((a, b) => a - b)
    const projected = beats.some((beat, index) => index > 0 &&
      Math.round(beat * division) <= Math.round(beats[index - 1] * division))
    const duration = Math.max(beats.length - 1, Math.round(end * division) - Math.round(span.startBeat * division))
    cursor += duration
    // Preserve distinct partial-bar source edges when the renderer cannot resolve their spacing.
    let last = startDiv - 1
    const points = projected ? beats.map((beat, index) => {
      const desired = startDiv + Math.round((beat - span.startBeat) / span.beats * duration)
      const div = Math.max(last + 1, Math.min(cursor - (beats.length - 1 - index), desired))
      last = div
      return { beat, div }
    }) : []
    return { startDiv, endDiv: cursor, points }
  })
  const interpolate = (value: number, points: NotationBar['points'], input: 'beat' | 'div', output: 'beat' | 'div') => {
    const right = Math.max(1, points.findIndex((point) => point[input] >= value))
    const first = points[right - 1]
    const last = points[right]
    return first[output] + (value - first[input]) / (last[input] - first[input]) * (last[output] - first[output])
  }
  const toDiv = (beat: number) => {
    const index = measureIndex(song, beat)
    const span = spans[index]
    const bar = bars[index]
    if (beat >= span.startBeat + span.beats)
      return bar.endDiv + Math.round((beat - span.startBeat - span.beats) * division)
    if (bar.points.length) return Math.round(interpolate(beat, bar.points, 'beat', 'div'))
    return bar.startDiv + Math.round(beat * division) - Math.round(span.startBeat * division)
  }
  const toBeat = (div: number) => {
    let first = 0
    let last = bars.length
    while (first < last) {
      const middle = Math.floor((first + last) / 2)
      if (bars[middle].startDiv <= div) first = middle + 1
      else last = middle
    }
    const index = Math.max(0, first - 1)
    const span = spans[index]
    const bar = bars[index]
    if (div >= bar.endDiv) return span.startBeat + span.beats + (div - bar.endDiv) / division
    if (bar.points.length) return interpolate(div, bar.points, 'div', 'beat')
    return span.startBeat + (div - bar.startDiv) / division
  }
  const grid = { division, bars, toDiv, toBeat }
  gridCache.set(song, { inputs, grid })
  return grid
}
const timeXml = (song: Song, index = 0) => {
  const bar = meterMeasures(song)[index]
  return `<time><beats>${bar.numerator}</beats><beat-type>${bar.denominator}</beat-type></time>`
}
type TimedNote = { midi: number; startBeat: number; beats: number; confidence?: number; generated?: boolean; trackId?: string; hand?: string }
export type NotationNote<T extends TimedNote = TimedNote> = {
  sourceId: string
  source: T
  midi: number
  sourceStartBeat: number
  sourceEndBeat: number
  startBeat: number
  endBeat: number
  startDiv: number
  endDiv: number
  staccato: boolean
}

const NOTATION_GRID = 0.25
const NOTATION_TOLERANCE = 0.1
const ATTACK_CONTEXT_TOLERANCE = 0.125

/** Simplify uncertain automatic engraving from nearby attacks; source timing remains unchanged. */
export function notationNotes<T extends TimedNote>(
  notes: readonly T[],
  partId: string,
  meter: number | Song,
): NotationNote<T>[] {
  const grid = typeof meter === 'number' ? undefined : notationGrid(meter)
  const toDiv = grid?.toDiv ?? ((beat: number) => Math.round(beat * DIV))
  const toBeat = grid?.toBeat ?? ((div: number) => div / DIV)
  const beatsPerBar = typeof meter === 'number' ? meter : meter.beatsPerBar
  const barAt = (beat: number, end: boolean) => {
    if (typeof meter !== 'number') {
      const index = measureIndex(meter, beat)
      return end && Math.abs(beat - barStart(meter, index)) < 1e-9 ? Math.max(0, index - 1) : index
    }
    const nearest = Math.round(beat / beatsPerBar) * beatsPerBar
    return Math.floor((end && Math.abs(beat - nearest) < 1e-9 ? beat - 1e-9 : beat) / beatsPerBar)
  }
  const automatic = (note: T) => note.generated === false && Number.isFinite(note.confidence) && note.confidence! <= 0.5
  const voiceKey = (note: T) =>
    partId === 'piano' ? note.hand === 'right' ? 'right' : 'left' : note.hand ?? 'part'
  const attackGroups = new Map<string, Map<number, T[]>>()
  for (const note of notes) {
    if (!Number.isFinite(note.startBeat)) continue
    const voice = voiceKey(note)
    const beats = attackGroups.get(voice) ?? new Map<number, T[]>()
    const group = beats.get(note.startBeat) ?? []
    group.push(note)
    beats.set(note.startBeat, group)
    attackGroups.set(voice, beats)
  }
  const voiceAttacks = new Map<string, number[]>()
  const attackIndices = new Map<string, Map<number, number>>()
  const attackByMicrobeat = new Map<string, Map<number, number>>()
  for (const [voice, groups] of attackGroups) {
    const beats = [...groups.keys()].sort((a, b) => a - b)
    voiceAttacks.set(voice, beats)
    attackIndices.set(voice, new Map(beats.map((beat, index) => [beat, index])))
    attackByMicrobeat.set(voice, new Map(beats.map((beat) => [Math.round(beat * 1e6), beat])))
  }
  const hasFastNeighbor = (voice: string, beat: number) => {
    const beats = voiceAttacks.get(voice) ?? []
    const index = attackIndices.get(voice)?.get(beat)
    return index !== undefined &&
      ((index > 0 && beat - beats[index - 1] < 0.5) ||
        (index + 1 < beats.length && beats[index + 1] - beat < 0.5))
  }
  const supportedByAttackSpacing = (voice: string, beat: number) => {
    const index = attackIndices.get(voice)?.get(beat)
    if (index === undefined) return false
    const attacks = voiceAttacks.get(voice) ?? []
    const gaps = [attacks[index - 1] === undefined ? undefined : beat - attacks[index - 1],
      attacks[index + 1] === undefined ? undefined : attacks[index + 1] - beat].filter((gap): gap is number => gap !== undefined)
    return gaps.length > 0 && gaps.every((gap) => gap >= 0.5 &&
      Math.abs(gap - Math.round(gap / NOTATION_GRID) * NOTATION_GRID) <= NOTATION_TOLERANCE)
  }
  const projectedAttacks = new Map<string, Map<number, number>>()
  for (const [voice, groups] of attackGroups) {
    const projected = new Map<number, number>()
    for (const [beat, simultaneous] of groups) {
      const snapped = Math.round(beat / NOTATION_GRID) * NOTATION_GRID
      const distance = Math.abs(snapped - beat)
      const contextual = distance > NOTATION_TOLERANCE && distance <= ATTACK_CONTEXT_TOLERANCE &&
        supportedByAttackSpacing(voice, beat)
      projected.set(beat, simultaneous.every(automatic) && !hasFastNeighbor(voice, beat) &&
        (distance <= NOTATION_TOLERANCE || contextual) &&
        barAt(beat, false) === barAt(snapped, false) ? snapped : beat)
    }
    projectedAttacks.set(voice, projected)
  }
  const simultaneousAttacks = new Map<number, { voice: string; div: number }[]>()
  for (const [voice, attacks] of projectedAttacks) {
    for (const [beat, projectedBeat] of attacks) {
      const group = simultaneousAttacks.get(beat) ?? []
      group.push({ voice, div: toDiv(projectedBeat) })
      simultaneousAttacks.set(beat, group)
    }
  }
  for (const [beat, group] of simultaneousAttacks) {
    if (new Set(group.map(({ div }) => div)).size < 2) continue
    for (const { voice } of group) projectedAttacks.get(voice)?.set(beat, beat)
  }
  const projected = notes.map((source, index) => {
    const sourceStartBeat = source.startBeat
    const sourceEndBeat = sourceStartBeat + source.beats
    const voice = voiceKey(source)
    let startBeat = sourceStartBeat
    let endBeat = sourceEndBeat
    let staccato = false
    if (automatic(source) && Number.isFinite(beatsPerBar) && beatsPerBar > 0 &&
        !hasFastNeighbor(voice, sourceStartBeat)) {
      startBeat = projectedAttacks.get(voice)?.get(sourceStartBeat) ?? sourceStartBeat
      const matchingAttack = attackByMicrobeat.get(voice)?.get(Math.round(sourceEndBeat * 1e6))
      if (matchingAttack !== undefined && Math.abs(matchingAttack - sourceEndBeat) < 1e-6) {
        endBeat = projectedAttacks.get(voice)?.get(matchingAttack) ?? matchingAttack
      } else {
        const snappedEnd = Math.round(sourceEndBeat / NOTATION_GRID) * NOTATION_GRID
        if (Math.abs(snappedEnd - sourceEndBeat) <= NOTATION_TOLERANCE &&
            barAt(sourceEndBeat, true) === barAt(snappedEnd, true)) endBeat = snappedEnd
      }
      const nextAttack = voiceAttacks.get(voice)?.find((beat) => beat > sourceStartBeat)
      if (nextAttack !== undefined && startBeat === projectedAttacks.get(voice)?.get(sourceStartBeat) &&
          nextAttack - sourceStartBeat <= 2 && source.beats <= 1.5 &&
          sourceEndBeat <= nextAttack + 1e-6) {
        const logicalEnd = projectedAttacks.get(voice)?.get(nextAttack) ?? nextAttack
        if (logicalEnd > startBeat &&
            (sourceEndBeat >= nextAttack - 1e-6 ||
              barAt(sourceStartBeat, false) === barAt(nextAttack, false))) {
          const gate = sourceEndBeat - sourceStartBeat
          const gap = nextAttack - sourceStartBeat
          staccato = sourceEndBeat < nextAttack - 0.125 && gate <= gap * 0.85 &&
            barAt(sourceStartBeat, false) === barAt(nextAttack, false)
          endBeat = logicalEnd
        }
      }
    }
    const sourceStartDiv = toDiv(sourceStartBeat)
    const sourceEndDiv = Math.max(sourceStartDiv + 1, toDiv(sourceEndBeat))
    const startDiv = toDiv(startBeat)
    const endDiv = Math.max(startDiv + 1, toDiv(endBeat))
    return {
      sourceId: `${source.trackId ?? partId}:note:${index}`,
      source,
      midi: source.midi,
      sourceStartBeat,
      sourceEndBeat,
      sourceStartDiv,
      sourceEndDiv,
      startDiv,
      endDiv,
      staccato,
    }
  })
  const sharedStartGroups = new Map<number, number[]>()
  projected.forEach((note, index) => {
    const group = sharedStartGroups.get(note.sourceStartBeat) ?? []
    group.push(index)
    sharedStartGroups.set(note.sourceStartBeat, group)
  })
  const overlapPairs = (intervals: { index: number; startDiv: number; endDiv: number }[]) => {
    const pairs = new Map<string, [number, number]>()
    const staves = new Map<string, typeof intervals>()
    for (const interval of intervals) {
      const staff = partId === 'piano' ? voiceKey(projected[interval.index].source) : 'part'
      const group = staves.get(staff) ?? []
      group.push(interval)
      staves.set(staff, group)
    }
    for (const staff of staves.values()) {
      const ordered = staff.sort((a, b) => a.startDiv - b.startDiv || a.index - b.index)
      for (let i = 0; i < ordered.length; i++) {
        const left = ordered[i]
        for (let j = i + 1; j < ordered.length && ordered[j].startDiv < left.endDiv; j++) {
          const right = ordered[j]
          if (right.endDiv <= right.startDiv) continue
          const first = Math.min(left.index, right.index)
          const second = Math.max(left.index, right.index)
          pairs.set(`${first}:${second}`, [first, second])
        }
      }
    }
    return pairs
  }
  const sourcePairs = overlapPairs(projected.map((note, index) => ({
    index,
    startDiv: note.sourceStartDiv,
    endDiv: note.sourceEndDiv,
  })))
  const blocked = new Set<number>()
  let changed = true
  while (changed) {
    changed = false
    const writtenPairs = overlapPairs(projected.map((note, index) => ({
      index,
      startDiv: blocked.has(index) ? note.sourceStartDiv : note.startDiv,
      endDiv: blocked.has(index) ? note.sourceEndDiv : note.endDiv,
    })))
    const fallbackChanged = (index: number) => {
      const note = projected[index]
      if (!blocked.has(index) &&
          (note.startDiv !== note.sourceStartDiv || note.endDiv !== note.sourceEndDiv)) {
        blocked.add(index)
        changed = true
      }
    }
    for (const [pair, participants] of sourcePairs)
      if (!writtenPairs.has(pair)) participants.forEach(fallbackChanged)
    for (const [pair, participants] of writtenPairs)
      if (!sourcePairs.has(pair)) participants.forEach(fallbackChanged)
    for (const participants of sharedStartGroups.values())
      if (participants.some((index) => blocked.has(index))) participants.forEach(fallbackChanged)
  }
  return projected.map((note, index) => {
    const { sourceStartDiv, sourceEndDiv, ...notation } = note
    const startDiv = blocked.has(index) ? sourceStartDiv : note.startDiv
    const endDiv = blocked.has(index) ? sourceEndDiv : note.endDiv
    return {
      ...notation,
      startDiv,
      endDiv,
      startBeat: toBeat(startDiv),
      endBeat: toBeat(endDiv),
      staccato: !blocked.has(index) && note.staccato,
    }
  })
}

const TYPES: [number, string, boolean][] = [
  [64, 'whole', false], [48, 'half', true], [32, 'half', false], [24, 'quarter', true],
  [16, 'quarter', false], [12, 'eighth', true], [8, 'eighth', false], [6, '16th', true],
  [4, '16th', false], [3, '32nd', true], [2, '32nd', false], [1, '64th', false],
]

function pieces(duration: number, division = DIV): number[] {
  const out: number[] = []
  let left = duration
  while (left > 0) {
    const d = TYPES.map(([value]) => value * division / DIV).find((value) => value <= left) ?? left
    out.push(d)
    left -= d
  }
  return out
}

function typeOf(duration: number, division = DIV): string {
  const match = TYPES.find(([d]) => d * division / DIV === duration)
  if (!match) {
    const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a
    const divisor = gcd(division / DIV, duration)
    return `<type>64th</type><time-modification><actual-notes>${division / DIV / divisor}</actual-notes><normal-notes>${duration / divisor}</normal-notes></time-modification>`
  }
  const [, type, dot] = match
  return `<type>${type}</type>${dot ? '<dot/>' : ''}`
}

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

/** Spell in flats in a flat key, for authored music with no analysed chords to spell from (Eb major, F minor). */
function keyFlats(song: Song): boolean {
  if (song.chords.length || !song.key) return false
  return (song.key.mode === 'major' ? ['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'] : ['D', 'G', 'C', 'F', 'Bb', 'Eb']).includes(song.key.tonic)
}

function pitch(midi: number, flats: boolean, spelled?: string): string {
  if (spelled) {
    const natural = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[spelled[0]]!
    const alter = [...spelled.slice(1)].reduce((sum, mark) => sum + (mark === '#' ? 1 : -1), 0)
    const octave = Math.round((midi - natural - alter) / 12) - 1
    return `<pitch><step>${spelled[0]}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>`
  }
  const base = Math.ceil(midi - 0.5)
  const name = (flats ? FLAT : SHARP)[((base % 12) + 12) % 12]
  const alter = (name[1] === '#' ? 1 : name[1] === 'b' ? -1 : 0) + midi - base
  return `<pitch><step>${name[0]}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${Math.floor(base / 12) - 1}</octave></pitch>`
}

type Head = { xml: string; stop?: boolean; start?: boolean; cents?: string; staccato?: boolean; finger?: number }
type Event = { pos: number; dur: number; heads: Head[] }

function voice(events: Event[], voiceNo: number, staff: number, stem: string | null, barDivs: number, division = DIV): string {
  if (events.length === 0) {
    return `<note><rest measure="yes"/><duration>${barDivs}</duration><voice>${voiceNo}</voice><staff>${staff}</staff></note>`
  }
  let xml = ''
  let cursor = 0
  const rest = (d: number) => {
    for (const p of pieces(d, division)) xml += `<note><rest/><duration>${p}</duration><voice>${voiceNo}</voice>${typeOf(p, division)}<staff>${staff}</staff></note>`
  }
  events.sort((a, b) => a.pos - b.pos)
  for (const e of events) {
    if (e.pos >= barDivs) continue
    if (e.pos > cursor) rest(e.pos - cursor)
    const duration = Math.max(1, Math.min(e.dur, barDivs - e.pos))
    const lengths = pieces(duration, division)
    for (const [index, length] of lengths.entries()) {
      if (index && e.heads.every((head) => head.xml.startsWith('<unpitched>'))) {
        rest(length)
        continue
      }
      e.heads.forEach((head, i) => {
        const stop = head.stop || index > 0
        const start = head.start || index < lengths.length - 1
        const ties = `${stop ? '<tie type="stop"/>' : ''}${start ? '<tie type="start"/>' : ''}`
        const articulation = head.staccato && !stop && !index ? '<articulations><staccato/></articulations>' : ''
        const fingering = head.finger && !stop && !index ? `<technical><fingering>${head.finger}</fingering></technical>` : ''
        const notation = stop || start || articulation || fingering
          ? `<notations>${stop ? '<tied type="stop"/>' : ''}${start ? '<tied type="start"/>' : ''}${articulation}${fingering}</notations>`
          : ''
        xml += `<note>${i ? '<chord/>' : ''}${head.xml}<duration>${length}</duration>${ties}<voice>${voiceNo}</voice>${typeOf(length, division)}${stem ? `<stem>${stem}</stem>` : ''}<staff>${staff}</staff>${notation}${head.cents && !stop ? `<lyric><text>${head.cents}</text></lyric>` : ''}</note>`
      })
    }
    cursor = e.pos + duration
  }
  if (cursor < barDivs) rest(barDivs - cursor)
  return xml
}

function wrap(partName: string, measures: string[], gmProgram?: number): string {
  const instrument = gmProgram != null && gmProgram >= 0 && gmProgram <= 127
    ? `<score-instrument id="P1-I1"><instrument-name>${partName}</instrument-name></score-instrument><midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>${gmProgram + 1}</midi-program></midi-instrument>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>${partName}</part-name>${instrument}</score-part></part-list><part id="P1">${measures.join('')}</part></score-partwise>`
}

function measureOpen(n: number, attributes: string, song: Song): string {
  const print = n > 1 && (n - 1) % 4 === 0 ? '<print new-system="yes"/>' : ''
  const bars = meterMeasures(song)
  const bar = bars[n - 1]
  const changed = n > 1 && (bar.numerator !== bars[n - 2].numerator || bar.denominator !== bars[n - 2].denominator)
  return `<measure number="${n}"${bar.partial ? ' implicit="yes"' : ''}>${print}${n === 1
    ? attributes : changed ? `<attributes>${timeXml(song, n - 1)}</attributes>` : ''}`
}

const KIND: Record<string, string> = {
  '': 'major', m: 'minor', '7': 'dominant', m7: 'minor-seventh', maj7: 'major-seventh', add9: 'major',
  sus4: 'suspended-fourth', sus2: 'suspended-second', dim: 'diminished', aug: 'augmented',
  m7b5: 'half-diminished', '6': 'major-sixth', m6: 'minor-sixth', '5': 'power', '9': 'dominant-ninth',
  m9: 'minor-ninth', maj9: 'major-ninth',
}

const step = (letter: string, acc: string | undefined, tag: 'root' | 'bass') =>
  `<${tag}-step>${letter}</${tag}-step>${acc ? `<${tag}-alter>${acc === '#' ? 1 : -1}</${tag}-alter>` : ''}`

/** A chord symbol such as "Am7" or the slash chord "C/E" (an inversion) as a MusicXML harmony. */
function harmony(symbol: string): string {
  if (symbol === 'N.C.') return '<harmony placement="above"><root><root-step>C</root-step></root><kind text="N.C.">none</kind></harmony>'
  const m = /^([A-G])(#|b)?(.*?)(?:\/([A-G])(#|b)?)?$/.exec(symbol)
  if (!m || !(m[3] in KIND)) return ''
  const add9 = m[3] === 'add9' ? '<degree><degree-value>9</degree-value><degree-alter>0</degree-alter><degree-type>add</degree-type></degree>' : ''
  const bass = m[4] ? `<bass>${step(m[4], m[5], 'bass')}</bass>` : ''
  return `<harmony placement="above"><root>${step(m[1], m[2], 'root')}</root><kind>${KIND[m[3]]}</kind>${bass}${add9}</harmony>`
}

/** Chord symbols and (bar 1) tempo, written before the notes; mid-bar chords are placed with forward/backup. Section names are drawn by the score overlay. */
function annotations(song: Song, bar: number, chords: boolean, scale = 1): string {
  const grid = notationGrid(song)
  const span = grid.bars[bar - 1]
  let xml = ''
  const tempo = barTempo(song, bar - 1)
  const previous = bar > 1 ? barTempo(song, bar - 2) : undefined
  const dotted = (meter: { numerator: number; denominator: number }) =>
    meter.denominator === 8 && meter.numerator > 3 && meter.numerator % 3 === 0
  const compound = dotted(meterMeasures(song)[bar - 1])
  const unitChanged = bar > 1 && dotted(meterMeasures(song)[bar - 2]) !== compound
  // Mark the tempo at the start and where the beat unit or speed changes (e.g. 4/4 to 12/8).
  if (bar === 1 || unitChanged || Math.abs(tempo / previous! - 1) >= 0.05) {
    xml += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>${compound ? '<beat-unit-dot/>' : ''}<per-minute>${Math.round(compound ? tempo / 1.5 : tempo)}</per-minute></metronome></direction-type><sound tempo="${Math.round(tempo * 1000) / 1000}"/></direction>`
  }
  let cursor = 0
  const names = song.chords.length ? song.chords : song.chordLabels ?? []
  for (const c of names) {
    const pos = (grid.toDiv(c.startBeat) - span.startDiv) * scale
    if (!chords || pos < 0 || pos >= (span.endDiv - span.startDiv) * scale || c.symbol === null) continue
    const h = harmony(c.symbol)
    if (!h) continue
    if (pos > cursor) xml += `<forward><duration>${pos - cursor}</duration></forward>`
    cursor = pos
    xml += h
  }
  if (cursor) xml += `<backup><duration>${cursor}</duration></backup>`
  return xml
}

/** `chords: false` leaves chord symbols out, for when the overlay draws them as keyboards. */
export function pianoXml(song: Song, chords = true): string {
  const grid = notationGrid(song)
  const DIV = grid.division
  const spelled = keyFlats(song)
  const notes = notationNotes(song.piano, 'piano', song).map((note) => ({
    ...note,
    flats: song.chords.find((chord) =>
      chord.startBeat <= note.startBeat && chord.startBeat + chord.beats > note.startBeat)?.flats ?? spelled,
  }))
  const attrs = `<attributes><divisions>${DIV}</divisions><key><fifths>0</fifths></key>${timeXml(song)}<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`
  const lines = voiceLines(notes.map((note) => ({
    startDiv: note.startDiv,
    endDiv: note.endDiv,
    staff: note.source.hand === 'left' ? 2 : 1,
    head: { xml: pitch(note.midi, note.flats, note.source.spell), staccato: note.staccato, finger: note.source.finger },
  })), true)
  const measures: string[] = []
  for (let bar = 1; bar <= song.bars; bar++) {
    measures.push(
      measureOpen(bar, attrs, song) +
        annotations(song, bar, chords) +
        voiceLinesXml(lines, [1, 2], grid.bars[bar - 1], DIV) +
        (bar === song.bars ? '<barline location="right"><bar-style>light-heavy</bar-style></barline>' : '') +
        '</measure>',
    )
  }
  return wrap('Piano', measures)
}

type StaffEvent = { startDiv: number; endDiv: number; staff: number; heads: Head[] }
type VoiceLines = Map<number, { endDiv: number; events: StaffEvent[] }[]>

/**
 * Splits each staff into voices that never overlap themselves, so no voice outlasts its bar.
 * Notes sharing an onset form one chord (held to the longest when `mergeOnsets`, as the piano is
 * engraved); a note starting under a held one gets its own voice.
 */
function voiceLines(notes: { startDiv: number; endDiv: number; staff: number; head: Head }[], mergeOnsets = false): VoiceLines {
  const grouped = new Map<string, StaffEvent>()
  for (const note of notes) {
    const key = mergeOnsets ? `${note.staff}:${note.startDiv}` : `${note.staff}:${note.startDiv}:${note.endDiv}`
    const event = grouped.get(key)
    if (event) {
      event.heads.push(note.head)
      event.endDiv = Math.max(event.endDiv, note.endDiv)
    } else grouped.set(key, { startDiv: note.startDiv, endDiv: note.endDiv, staff: note.staff, heads: [note.head] })
  }
  const lines: VoiceLines = new Map()
  const events = [...grouped.values()].sort((a, b) =>
    a.staff - b.staff || a.startDiv - b.startDiv || b.endDiv - a.endDiv)
  for (const event of events) {
    const staffLines = lines.get(event.staff) ?? []
    let line = staffLines.find((candidate) => candidate.endDiv <= event.startDiv)
    if (!line) {
      line = { endDiv: 0, events: [] }
      staffLines.push(line)
      lines.set(event.staff, staffLines)
    }
    line.events.push(event)
    line.endDiv = event.endDiv
  }
  return lines
}

/** One bar of every staff's voices; voice numbers stay fixed for the whole song so ties keep their voice. */
function voiceLinesXml(lines: VoiceLines, staves: number[], bar: { startDiv: number; endDiv: number }, division: number): string {
  const { startDiv, endDiv } = bar
  const barDivs = endDiv - startDiv
  const parts: string[] = []
  let firstVoice = 1
  for (const staff of staves) {
    const staffLines = lines.get(staff) ?? []
    // Second-staff voices conventionally start at 5, but never reuse a first-staff number.
    if (staff !== staves[0]) firstVoice = Math.max(firstVoice, 5)
    const written = staffLines
      .map((line, index) => ({
        voiceNo: firstVoice + index,
        events: line.events
          .filter((event) => event.startDiv < endDiv && event.endDiv > startDiv)
          .map((event) => ({
            pos: Math.max(startDiv, event.startDiv) - startDiv,
            dur: Math.min(endDiv, event.endDiv) - Math.max(startDiv, event.startDiv),
            heads: event.heads.map((head) => ({ ...head, stop: event.startDiv < startDiv, start: event.endDiv > endDiv })),
          })),
      }))
      .filter((line) => line.events.length)
    for (const line of (written.length ? written : [{ voiceNo: firstVoice, events: [] as Event[] }])) {
      if (parts.length) parts.push(`<backup><duration>${barDivs}</duration></backup>`)
      parts.push(voice(line.events, line.voiceNo, staff, null, barDivs, division))
    }
    firstVoice += Math.max(1, staffLines.length)
  }
  return parts.join('')
}

/** One vocal staff, with tied durations across beats and bar lines; no hand assignment. */
export function vocalXml(song: Song): string {
  const grid = notationGrid(song)
  const DIV = grid.division
  const notes = notationNotes(song.vocals, 'vocals', song)
  const pitches = notes.map((n) => n.midi).sort((a, b) => a - b)
  const bass = pitches.length > 0 && pitches[Math.floor(pitches.length / 2)] < 60
  const clef = bass ? '<sign>F</sign><line>4</line>' : '<sign>G</sign><line>2</line>'
  const attrs = `<attributes><divisions>${DIV}</divisions>${timeXml(song)}<clef>${clef}</clef></attributes>`
  const written = notes.map((note) => ({ ...note, from: note.startDiv, to: note.endDiv }))
  const measures: string[] = []
  for (let bar = 1; bar <= song.bars; bar++) {
    const span = grid.bars[bar - 1]
    const start = span.startDiv
    const barDivs = span.endDiv - start
    let cursor = start
    let xml = measureOpen(bar, attrs, song) + annotations(song, bar, true)
    const rest = (duration: number) => {
      for (const d of pieces(duration, DIV)) xml += `<note><rest/><duration>${d}</duration>${typeOf(d, DIV)}</note>`
    }
    for (const n of written) {
      const from = Math.max(start, n.from, cursor)
      const to = Math.min(start + barDivs, n.to)
      if (to <= from) continue
      rest(from - cursor)
      cursor = from
      for (const d of pieces(to - from, DIV)) {
        const stop = cursor > n.from
        const begin = cursor + d < n.to
        const ties = `${stop ? '<tie type="stop"/>' : ''}${begin ? '<tie type="start"/>' : ''}`
        const articulation = n.staccato && cursor === n.from ? '<articulations><staccato/></articulations>' : ''
        const notation = stop || begin || articulation
          ? `<notations>${stop ? '<tied type="stop"/>' : ''}${begin ? '<tied type="start"/>' : ''}${articulation}</notations>`
          : ''
        xml += `<note>${pitch(n.midi, false)}<duration>${d}</duration>${ties}${typeOf(d, DIV)}${notation}</note>`
        cursor += d
      }
    }
    rest(start + barDivs - cursor)
    measures.push(xml + '</measure>')
  }
  return wrap('Vocal melody (draft)', measures)
}

/** Guitar and bass use their octave-transposing clefs; unknown mixed registers use two staves. */
export function instrumentXml(song: Song, track: Track): string {
  const grid = notationGrid(song)
  const DIV = grid.division
  const notes = notationNotes(song.instrumentNotes?.[track.id] ?? [], track.id, song)
  const low = notes.some((n) => n.midi < 60)
  const high = notes.some((n) => n.midi >= 60)
  const bass = isBassTrack(track)
  const guitar = !bass && isGuitarTrack(track)
  const fretted = bass || guitar
  const split = !fretted && low && high
  const attrs = `<attributes><divisions>${DIV}</divisions>${timeXml(song)}${split
    ? '<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>'
    : `<clef><sign>${bass || (!guitar && low) ? 'F' : 'G'}</sign><line>${bass || (!guitar && low) ? 4 : 2}</line>${fretted ? '<clef-octave-change>-1</clef-octave-change>' : ''}</clef>`}</attributes>`
  const lines = voiceLines(notes.filter((note) => note.source.beats > 0).map((note) => {
    const base = Math.ceil(note.midi - 0.5)
    const cents = Math.round((note.midi - base) * 100)
    return {
      startDiv: note.startDiv,
      endDiv: note.endDiv,
      staff: split && note.midi < 60 ? 2 : 1,
      head: { xml: pitch(base + (fretted ? 12 : 0), keyFlats(song)), cents: cents ? `${cents > 0 ? '+' : ''}${cents}¢` : undefined, staccato: note.staccato },
    }
  }))
  const measures: string[] = []
  for (let bar = 1; bar <= song.bars; bar++) {
    measures.push(measureOpen(bar, attrs, song) + annotations(song, bar, true) +
      voiceLinesXml(lines, split ? [1, 2] : [1], grid.bars[bar - 1], DIV) +
      (bar === song.bars ? '<barline location="right"><bar-style>light-heavy</bar-style></barline>' : '') + '</measure>')
  }
  return wrap(track.name.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!), measures, track.gmProgram)
}

/** The accompaniment as a grand staff: each chord's voicing held in the right hand, its bass note in the left. Plays what the engine plays. */
export function chordsXml(song: Song, chords = true): string {
  const grid = notationGrid(song)
  const DIV = grid.division
  const attrs = `<attributes><divisions>${DIV}</divisions><key><fifths>0</fifths></key>${timeXml(song)}<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`
  const measures: string[] = []
  for (let bar = 1; bar <= song.bars; bar++) {
    const span = meterMeasures(song)[bar - 1]
    const start = span.startBeat
    const end = start + span.beats
    const { startDiv, endDiv } = grid.bars[bar - 1]
    const barDivs = endDiv - startDiv
    const inBar = song.chords.filter((c) => c.tones.length && c.startBeat < end && c.startBeat + c.beats > start)
    const events = (pick: (tones: number[]) => number[]): Event[] =>
      inBar.map((c) => {
        const from = Math.max(c.startBeat, start)
        return {
          pos: grid.toDiv(from) - startDiv,
          dur: grid.toDiv(Math.min(c.startBeat + c.beats, end)) - grid.toDiv(from),
          heads: pick(c.tones).map((m) => ({ xml: pitch(m, c.flats) })),
        }
      })
    measures.push(
      measureOpen(bar, attrs, song) +
        annotations(song, bar, chords) +
        voice(events((t) => t), 1, 1, null, barDivs, DIV) +
        `<backup><duration>${barDivs}</duration></backup>` +
        voice(events((t) => [t[0] - 24]), 5, 2, null, barDivs, DIV) +
        (bar === song.bars ? '<barline location="right"><bar-style>light-heavy</bar-style></barline>' : '') +
        '</measure>',
    )
  }
  return wrap('Chords', measures)
}

const DRUM_POS: Record<DrumLane, [string, number, string | null]> = {
  crash: ['A', 5, 'x'],
  ride: ['F', 5, 'x'],
  hihat: ['G', 5, 'x'],
  openhat: ['G', 5, 'circle-x'],
  hightom: ['E', 5, null],
  snare: ['C', 5, null],
  floortom: ['A', 4, null],
  kick: ['F', 4, null],
}

/**
 * Where a hit is written: its lane, or a GM-specific position when the hit names one. The six GM toms get
 * their own lines and spaces and the pedalled hi-hat is written with the feet below the staff; generic lane
 * hits keep the lane positions above.
 */
type DrumKey = DrumLane | 'pedal' | 'tom50' | 'tom48' | 'tom47' | 'tom45' | 'tom43' | 'tom41'
const DETAIL_POS: Record<Exclude<DrumKey, DrumLane>, [string, number, string | null]> = {
  pedal: ['D', 4, 'x'],
  tom50: ['E', 5, null], tom48: ['D', 5, null], tom47: ['B', 4, null],
  tom45: ['A', 4, null], tom43: ['G', 4, null], tom41: ['E', 4, null],
}
export function drumKey(hit: Pick<DrumHit, 'lane' | 'sourceMidi'>): DrumKey {
  if (hit.lane === 'hihat' && hit.sourceMidi === 44) return 'pedal'
  if ((hit.lane === 'hightom' && [50, 48, 47].includes(hit.sourceMidi ?? 0)) ||
      (hit.lane === 'floortom' && [45, 43, 41].includes(hit.sourceMidi ?? 0))) return `tom${hit.sourceMidi}` as DrumKey
  return hit.lane
}
const footKey = (key: DrumKey) => key === 'kick' || key === 'pedal'

/** Staff position and notehead shape for a written drum key. */
export const drumPosition = (key: DrumKey) => key in DRUM_POS ? DRUM_POS[key as DrumLane] : DETAIL_POS[key as Exclude<DrumKey, DrumLane>]

type Piece = { length: number; type?: string; dot: boolean; triplet: boolean }

/** Standard values for a span, split at beats when needed; 3:2 triplets where exact (matches the host export). */
function spanPieces(start: number, end: number, division: number): Piece[] {
  const standard = TYPES.map(([value, type, dot]) => [value * division / DIV, type, dot] as const)
    .filter(([value]) => Number.isInteger(value))
  const out: Piece[] = []
  let left = end - start
  while (left > 0) {
    const match = standard.find(([value]) => value <= left)
    if (!match) break
    out.push({ length: match[0], type: match[1], dot: match[2], triplet: false })
    left -= match[0]
  }
  if (!left) return out
  const boundary = (Math.floor(start / division) + 1) * division
  if (start < boundary && boundary < end) return [...spanPieces(start, boundary, division), ...spanPieces(boundary, end, division)]
  const triplet = standard.find(([value]) => value * 2 === (end - start) * 3)
  return triplet ? [{ length: end - start, type: triplet[1], dot: triplet[2], triplet: true }] : [...out, { length: left, dot: false, triplet: false }]
}

const pieceXml = (piece: Piece, division: number) => piece.type
  ? `<type>${piece.type}</type>${piece.dot ? '<dot/>' : ''}${piece.triplet ? '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>' : ''}`
  : typeOf(piece.length, division)

/** One written stroke: where it is drawn, how it is played, and the hand for the sticking letters. */
type Stroke = { key: DrumKey; ghost: boolean; accent: boolean; foot: boolean; hand?: 'left' | 'right'; unhanded: boolean }

const BEAMS: Record<string, number> = { eighth: 1, '16th': 2, '32nd': 3, '64th': 4 }

/**
 * Beam groups in divisions for a bar: each quarter in simple time, each dotted quarter in compound time, and pairs of
 * eighths (the last group three when the count is odd) in other eighth-note meters, such as 7/8 as 2 + 2 + 3.
 */
function beamGroups(numerator: number, denominator: number, barDivs: number, division: number): number[] {
  const starts: number[] = []
  if (denominator === 8 && numerator >= 6 && numerator % 3 === 0) {
    for (let at = 0; at < barDivs; at += division * 1.5) starts.push(at)
  } else if (denominator === 8) {
    for (let eighth = 0; eighth < numerator; eighth += 2) if (numerator - eighth !== 1) starts.push(eighth * division / 2)
  } else {
    for (let at = 0; at < barDivs; at += division) starts.push(at)
  }
  return starts
}

/**
 * One drum voice: chorded simultaneous strokes, each written length reaching the next attack. Beams follow the
 * meter's beat groups, so stems keep the voice's direction instead of being chosen by pitch. Ghost notes are marked
 * with parenthesised noteheads and accents with an accent mark; the sticking letters go under the hand strokes.
 */
function drumVoice(attacks: Map<number, Stroke[]>, voiceNo: number, stem: string, barDivs: number, division: number,
  groups: number[]): string {
  const positions = [...attacks.keys()].filter((pos) => pos >= 0 && pos < barDivs).sort((a, b) => a - b)
  if (!positions.length) return `<note><rest measure="yes"/><duration>${barDivs}</duration><voice>${voiceNo}</voice><staff>1</staff></note>`
  const items: { piece: Piece; start: number; strokes?: Stroke[] }[] = []
  let cursor = 0
  const rest = (from: number, to: number) => {
    let at = from
    for (const piece of spanPieces(from, to, division)) { items.push({ piece, start: at }); at += piece.length }
  }
  positions.forEach((pos, index) => {
    if (pos > cursor) rest(cursor, pos)
    const head = spanPieces(pos, positions[index + 1] ?? barDivs, division)[0]
    items.push({ piece: head, start: pos, strokes: attacks.get(pos)! })
    cursor = pos + head.length
  })
  if (cursor < barDivs) rest(cursor, barDivs)
  // Bracket each complete 3:2 group (three triplet units, notes or rests) so the renderer draws it.
  const brackets = items.map(() => '')
  for (let first = 0; first < items.length; first++) {
    if (!items[first].piece.triplet) continue
    const unit = items[first].piece.length
    let filled = 0
    let last = first
    while (last < items.length && items[last].piece.triplet && filled < unit * 3) filled += items[last++].piece.length
    if (filled !== unit * 3) continue
    brackets[first] = '<tuplet type="start"/>'
    brackets[last - 1] += '<tuplet type="stop"/>'
    first = last - 1
  }
  // Beams join consecutive notes of eighth value or shorter inside one beat group; rests break them.
  const levels = items.map((item) => item.strokes ? BEAMS[item.piece.type ?? ''] ?? 0 : 0)
  const group = (start: number) => groups.filter((at) => at <= start).length
  const beams = items.map(() => '')
  for (let index = 0; index < items.length; index++) {
    if (!levels[index]) continue
    const joins = (other: number) => other >= 0 && other < items.length && levels[other] > 0 && group(items[other].start) === group(items[index].start)
    const before = joins(index - 1)
    const after = joins(index + 1)
    if (!before && !after) continue
    for (let level = 1; level <= levels[index]; level++) {
      const prev = before && levels[index - 1] >= level
      const next = after && levels[index + 1] >= level
      const kind = prev && next ? 'continue' : next ? 'begin' : prev ? 'end' : before ? 'backward hook' : 'forward hook'
      beams[index] += `<beam number="${level}">${kind}</beam>`
    }
  }
  return items.map(({ piece, strokes }, index) => {
    const notations = brackets[index]
    if (!strokes) return `<note><rest/><duration>${piece.length}</duration><voice>${voiceNo}</voice>${pieceXml(piece, division)}<staff>1</staff>${notations ? `<notations>${notations}</notations>` : ''}</note>`
    const hands = strokes.filter((stroke) => !stroke.foot)
    // Letters only where every hand stroke at this moment has a hand; R above L when both play.
    const lyric = hands.length && hands.every((stroke) => stroke.hand) ? ['right', 'left']
      .map((hand, line) => hands.some((stroke) => stroke.hand === hand)
        ? `<lyric number="${line + 1}" placement="below"><syllabic>single</syllabic><text>${hand === 'right' ? 'R' : 'L'}</text></lyric>` : '').join('') : ''
    const accent = strokes.some((stroke) => stroke.accent) ? '<articulations><accent placement="above"/></articulations>' : ''
    return strokes.map((stroke, chord) => {
      const [step, octave, head] = drumPosition(stroke.key)
      const shape = head ?? 'normal'
      const notehead = stroke.ghost ? `<notehead parentheses="yes">${shape}</notehead>` : head ? `<notehead>${head}</notehead>` : ''
      const marks = chord ? '' : notations + accent
      return `<note>${chord ? '<chord/>' : ''}<unpitched><display-step>${step}</display-step><display-octave>${octave}</display-octave></unpitched>` +
        `<duration>${piece.length}</duration><voice>${voiceNo}</voice>${pieceXml(piece, division)}<stem>${stem}</stem>${notehead}<staff>1</staff>` +
        `${chord ? '' : beams[index]}${marks ? `<notations>${marks}</notations>` : ''}${chord ? '' : lyric}</note>`
    }).join('')
  }).join('')
}

const FINE_UNITS = [1 / 16, 1 / 12]

/** The 64th or 16th-triplet grid that a recurring fine figure fits, if any. */
function fineUnit(gap: number): number | undefined {
  let best: [number, number] | undefined
  for (const unit of FINE_UNITS) {
    const steps = Math.floor(gap / unit + 0.5)
    const error = Math.abs(gap / unit - steps)
    if (steps >= 1 && error <= 0.15 && (!best || error < best[1] - 1e-9)) best = [unit, error]
  }
  return best?.[0]
}

/**
 * Written beat for each drum hit, identical to the host MusicXML export; playback keeps the
 * source `startBeat`. Automatic hits (with `confidence`) move to their bar's sixteenth grid,
 * removing timing jitter. A same-lane fine figure is kept instead: three or more hits with
 * consistent spacing of 0.05–0.2 beat or off the sixteenth grid (64th rolls, triplets), or an
 * isolated pair 0.1–0.2 beat apart, whose spacing fits the 64th or 16th-triplet grid; its hits snap
 * to that grid. Spacing that fits neither is jitter; closer isolated hits are one written hit;
 * imports are unchanged.
 */
export function drumNotationBeats(song: Song): number[] {
  const bars = meterMeasures(song)
  const barSnap = (beat: number, unit: number) => {
    const bar = bars[measureIndex(song, beat)]
    const snapped = bar.startBeat + Math.floor((beat - bar.startBeat) / unit + 0.5) * unit
    return snapped >= bar.startBeat && snapped < bar.startBeat + bar.beats - 1e-9 ? snapped : beat
  }
  const automatic = song.drums.map((hit) => Number.isFinite(hit.confidence))
  const written = song.drums.map((hit, index) => automatic[index] ? barSnap(hit.startBeat, 0.25) : hit.startBeat)
  const lanes = new Map<string, number[]>()
  song.drums.forEach((hit, index) => {
    if (!automatic[index]) return
    const key = `${hit.trackId ?? ''}:${hit.lane}`
    lanes.set(key, [...(lanes.get(key) ?? []), index])
  })
  for (const indexes of lanes.values()) {
    indexes.sort((a, b) => song.drums[a].startBeat - song.drums[b].startBeat)
    const beats = indexes.map((index) => song.drums[index].startBeat)
    let start = 0
    while (start < indexes.length - 1) {
      const firstGap = beats[start + 1] - beats[start]
      let stop = start + 1
      while (stop + 1 < indexes.length && Math.abs(beats[stop + 1] - beats[stop] - firstGap) <= Math.max(0.2 * firstGap, 0.03)) stop++
      const gap = (beats[stop] - beats[start]) / (stop - start)
      const count = stop - start + 1
      const offGrid = Math.abs(gap - Math.floor(gap * 4 + 0.5) / 4) > 0.05
      const unit = gap >= 0.05 ? fineUnit(gap) : undefined
      if (unit && ((count >= 3 && (gap < 0.2 || offGrid)) || (count === 2 && gap >= 0.1 && gap < 0.2))) {
        let positions = beats.slice(start, stop + 1).map((beat) => barSnap(beat, unit))
        if (positions.some((value, step) => step > 0 && value <= positions[step - 1])) positions = beats.slice(start, stop + 1)
        positions.forEach((value, step) => { written[indexes[start + step]] = value })
        start = stop + 1
      } else start = Math.max(count >= 3 ? stop : start + 1, start + 1)
    }
  }
  const groups = new Map<string, number[]>()
  song.drums.forEach((hit, index) => {
    const key = `${hit.trackId ?? ''}:${hit.lane}:${written[index]}`
    groups.set(key, [...(groups.get(key) ?? []), index])
  })
  for (const indexes of groups.values()) {
    const sources = indexes.map((index) => song.drums[index].startBeat)
    if (Math.max(...sources) - Math.min(...sources) >= 0.1) for (const index of indexes) written[index] = song.drums[index].startBeat
  }
  return written
}

/** True when a bar puts triplet hand strokes and duple foot strokes in the same beat (3 against 2), which one voice cannot write. */
function crossRhythm(hands: number[], feet: number[], division: number): boolean {
  const kind = (pos: number) => {
    const offset = pos % division
    if (!offset) return null
    return (offset * 3) % division === 0 && (offset * 2) % division !== 0 ? 'triplet' : (offset * 4) % division === 0 ? 'duple' : 'other'
  }
  const beats = (list: number[], wanted: string) => new Set(list.filter((pos) => kind(pos) === wanted).map((pos) => Math.floor(pos / division)))
  const triplets = [beats(hands, 'triplet'), beats(feet, 'triplet')]
  const duples = [beats(hands, 'duple'), beats(feet, 'duple')]
  return [...triplets[0]].some((beat) => duples[1].has(beat)) || [...triplets[1]].some((beat) => duples[0].has(beat))
}

/**
 * The drum part as one staff. Hands and feet share one up-stemmed voice, as drum charts usually write them, so a
 * hi-hat and a kick played together sit on one stem; a bar where the hands play triplets against duple feet keeps
 * the feet in a second, down-stemmed voice instead. `hands` (one per hit, for the hand strokes) adds sticking letters.
 */
export function drumXml(song: Song, chords = true, hands?: ('left' | 'right' | undefined)[]): string {
  const grid = notationGrid(song)
  // Three times the shared grid so sixteenth-triplet figures have exact written positions.
  const division = grid.division * 3
  const attrs = `<attributes><divisions>${division}</divisions><key><fifths>0</fifths></key>${timeXml(song)}<clef><sign>percussion</sign></clef></attributes>`
  const spans = meterMeasures(song)
  const measures: string[] = []
  const written = drumNotationBeats(song)
  const hitsByBar = new Map<number, { stroke: Stroke; beat: number }[]>()
  song.drums.forEach((hit, index) => {
    const bar = measureIndex(song, written[index])
    const key = drumKey(hit)
    const stroke: Stroke = { key, ghost: hit.dynamic === 'ghost', accent: hit.dynamic === 'accent', foot: footKey(key),
      hand: hands?.[index], unhanded: !!hands && !hands[index] }
    hitsByBar.set(bar, [...(hitsByBar.get(bar) ?? []), { stroke, beat: written[index] }])
  })
  for (let bar = 1; bar <= song.bars; bar++) {
    const { startDiv, endDiv, points } = grid.bars[bar - 1]
    const span = spans[bar - 1]
    const barDivs = (endDiv - startDiv) * 3
    const position = (beat: number) => points.length
      ? (grid.toDiv(beat) - startDiv) * 3 : Math.round((beat - span.startBeat) * division)
    const attacks = (include: (stroke: Stroke) => boolean) => {
      const map = new Map<number, Stroke[]>()
      for (const { stroke, beat } of hitsByBar.get(bar - 1) ?? []) {
        if (!include(stroke)) continue
        const strokes = map.get(position(beat)) ?? []
        const same = strokes.find((other) => other.key === stroke.key)
        // Repeats of one sound at one moment are one written note: a ghost only if every repeat is, an accent if any is.
        if (same) Object.assign(same, { ghost: same.ghost && stroke.ghost, accent: same.accent || stroke.accent,
          hand: same.hand === stroke.hand ? same.hand : undefined, unhanded: same.unhanded || stroke.unhanded || same.hand !== stroke.hand })
        else strokes.push({ ...stroke })
        map.set(position(beat), strokes)
      }
      for (const strokes of map.values()) {
        if (strokes.some((stroke) => !stroke.foot && stroke.unhanded)) for (const stroke of strokes) stroke.hand = undefined
      }
      return map
    }
    const groups = beamGroups(span.numerator, span.denominator, barDivs, division)
    const handMap = attacks((stroke) => !stroke.foot)
    const footMap = attacks((stroke) => stroke.foot)
    const split = crossRhythm([...handMap.keys()], [...footMap.keys()], division)
    const voices = split
      ? drumVoice(handMap, 1, 'up', barDivs, division, groups) + `<backup><duration>${barDivs}</duration></backup>` +
        drumVoice(footMap, 2, 'down', barDivs, division, groups)
      : drumVoice(attacks(() => true), 1, 'up', barDivs, division, groups)
    measures.push(
      measureOpen(bar, attrs, song) +
        annotations(song, bar, chords, 3) +
        voices +
        (bar === song.bars ? '<barline location="right"><bar-style>light-heavy</bar-style></barline>' : '') +
        '</measure>',
    )
  }
  return wrap('Drum kit', measures)
}