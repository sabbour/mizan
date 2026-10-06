import type { DrumLane, Song, Track } from './song'

const DIV = 16 // divisions per quarter note
const timeXml = (song: Song) => `<time><beats>${Math.round(song.beatsPerBar * (song.beatUnit ?? 4) / 4)}</beats><beat-type>${song.beatUnit ?? 4}</beat-type></time>`
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
  beatsPerBar: number,
): NotationNote<T>[] {
  const barAt = (beat: number, end: boolean) => {
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
      group.push({ voice, div: Math.round(projectedBeat * DIV) })
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
    const sourceStartDiv = Math.round(sourceStartBeat * DIV)
    const sourceEndDiv = Math.max(sourceStartDiv + 1, Math.round(sourceEndBeat * DIV))
    const startDiv = Math.round(startBeat * DIV)
    const endDiv = Math.max(startDiv + 1, Math.round(endBeat * DIV))
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
      startBeat: startDiv / DIV,
      endBeat: endDiv / DIV,
      staccato: !blocked.has(index) && note.staccato,
    }
  })
}

const TYPES: [number, string, boolean][] = [
  [64, 'whole', false], [48, 'half', true], [32, 'half', false], [24, 'quarter', true],
  [16, 'quarter', false], [12, 'eighth', true], [8, 'eighth', false], [6, '16th', true],
  [4, '16th', false], [3, '32nd', true], [2, '32nd', false], [1, '64th', false],
]

function pieces(duration: number): number[] {
  const out: number[] = []
  let left = duration
  while (left > 0) {
    const [d] = TYPES.find(([d]) => d <= left)!
    out.push(d)
    left -= d
  }
  return out
}

function typeOf(duration: number): string {
  const [, type, dot] = TYPES.find(([d]) => d === duration)!
  return `<type>${type}</type>${dot ? '<dot/>' : ''}`
}

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

function pitch(midi: number, flats: boolean): string {
  const base = Math.ceil(midi - 0.5)
  const name = (flats ? FLAT : SHARP)[((base % 12) + 12) % 12]
  const alter = (name[1] === '#' ? 1 : name[1] === 'b' ? -1 : 0) + midi - base
  return `<pitch><step>${name[0]}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${Math.floor(base / 12) - 1}</octave></pitch>`
}

type Head = { xml: string; stop?: boolean; start?: boolean; cents?: string; staccato?: boolean }
type Event = { pos: number; dur: number; heads: Head[] }

function voice(events: Event[], voiceNo: number, staff: number, stem: string | null, barDivs: number): string {
  if (events.length === 0) {
    return `<note><rest measure="yes"/><duration>${barDivs}</duration><voice>${voiceNo}</voice><staff>${staff}</staff></note>`
  }
  let xml = ''
  let cursor = 0
  const rest = (d: number) => {
    for (const p of pieces(d)) xml += `<note><rest/><duration>${p}</duration><voice>${voiceNo}</voice>${typeOf(p)}<staff>${staff}</staff></note>`
  }
  events.sort((a, b) => a.pos - b.pos)
  for (const e of events) {
    if (e.pos >= barDivs) continue
    if (e.pos > cursor) rest(e.pos - cursor)
    const duration = Math.max(1, Math.min(e.dur, barDivs - e.pos))
    const lengths = pieces(duration)
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
        const notation = stop || start || articulation
          ? `<notations>${stop ? '<tied type="stop"/>' : ''}${start ? '<tied type="start"/>' : ''}${articulation}</notations>`
          : ''
        xml += `<note>${i ? '<chord/>' : ''}${head.xml}<duration>${length}</duration>${ties}<voice>${voiceNo}</voice>${typeOf(length)}${stem ? `<stem>${stem}</stem>` : ''}<staff>${staff}</staff>${notation}${head.cents && !stop ? `<lyric><text>${head.cents}</text></lyric>` : ''}</note>`
      })
    }
    cursor = e.pos + duration
  }
  if (cursor < barDivs) rest(barDivs - cursor)
  return xml
}

function group(items: { pos: number; dur: number; head: Head }[]): Event[] {
  const map = new Map<number, Event>()
  for (const it of items) {
    const e = map.get(it.pos)
    if (e) {
      e.dur = Math.max(e.dur, it.dur)
      e.heads.push(it.head)
    } else map.set(it.pos, { pos: it.pos, dur: it.dur, heads: [it.head] })
  }
  return [...map.values()]
}

/** Give each event the gap to the next onset as its written length (drum notation convention). */
function toGaps(events: Event[], barDivs: number): Event[] {
  const sorted = [...events].sort((a, b) => a.pos - b.pos)
  return sorted.map((e, i) => ({ ...e, dur: (sorted[i + 1]?.pos ?? barDivs) - e.pos }))
}

function wrap(partName: string, measures: string[], gmProgram?: number): string {
  const instrument = gmProgram != null && gmProgram >= 0 && gmProgram <= 127
    ? `<score-instrument id="P1-I1"><instrument-name>${partName}</instrument-name></score-instrument><midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>${gmProgram + 1}</midi-program></midi-instrument>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>${partName}</part-name>${instrument}</score-part></part-list><part id="P1">${measures.join('')}</part></score-partwise>`
}

function measureOpen(n: number, attributes: string): string {
  const print = n > 1 && (n - 1) % 4 === 0 ? '<print new-system="yes"/>' : ''
  return `<measure number="${n}">${print}${n === 1 ? attributes : ''}`
}

const KIND: Record<string, string> = {
  '': 'major', m: 'minor', '7': 'dominant', m7: 'minor-seventh', maj7: 'major-seventh', add9: 'major',
  sus4: 'suspended-fourth', sus2: 'suspended-second', dim: 'diminished', aug: 'augmented',
  m7b5: 'half-diminished', '6': 'major-sixth', m6: 'minor-sixth',
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
function annotations(song: Song, bar: number, chords: boolean): string {
  const start = (bar - 1) * song.beatsPerBar
  let xml = ''
  if (bar === 1) {
    xml += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(song.bpm)}</per-minute></metronome></direction-type><sound tempo="${song.bpm}"/></direction>`
  }
  let cursor = 0
  for (const c of song.chords) {
    const pos = Math.round((c.startBeat - start) * DIV)
    if (!chords || pos < 0 || pos >= song.beatsPerBar * DIV || c.symbol === null) continue
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
  const barDivs = song.beatsPerBar * DIV
  const notes = notationNotes(song.piano, 'piano', song.beatsPerBar).map((note) => ({
    ...note,
    flats: song.chords.find((chord) =>
      chord.startBeat <= note.startBeat && chord.startBeat + chord.beats > note.startBeat)?.flats ?? false,
  }))
  const attrs = `<attributes><divisions>${DIV}</divisions><key><fifths>0</fifths></key>${timeXml(song)}<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`
  const measures: string[] = []
  for (let bar = 1; bar <= song.bars; bar++) {
    const start = (bar - 1) * song.beatsPerBar
    const startDiv = Math.round(start * DIV)
    const endDiv = startDiv + barDivs
    const hand = (h: 'right' | 'left') =>
      group(
        notes
          .filter((note) => note.source.hand === h && note.startDiv < endDiv && note.endDiv > startDiv)
          .map((note) => {
            const from = Math.max(note.startDiv, startDiv)
            const to = Math.min(note.endDiv, endDiv)
            return {
              pos: from - startDiv,
              dur: to - from,
              head: { xml: pitch(note.midi, note.flats), stop: note.startDiv < startDiv, start: note.endDiv > endDiv,
                staccato: note.staccato },
            }
          }),
      )
    measures.push(
      measureOpen(bar, attrs) +
        annotations(song, bar, chords) +
        voice(hand('right'), 1, 1, null, barDivs) +
        `<backup><duration>${barDivs}</duration></backup>` +
        voice(hand('left'), 5, 2, null, barDivs) +
        (bar === song.bars ? '<barline location="right"><bar-style>light-heavy</bar-style></barline>' : '') +
        '</measure>',
    )
  }
  return wrap('Piano', measures)
}

/** One vocal staff, with tied durations across beats and bar lines; no hand assignment. */
export function vocalXml(song: Song): string {
  const barDivs = song.beatsPerBar * DIV
  const notes = notationNotes(song.vocals, 'vocals', song.beatsPerBar)
  const pitches = notes.map((n) => n.midi).sort((a, b) => a - b)
  const bass = pitches.length > 0 && pitches[Math.floor(pitches.length / 2)] < 60
  const clef = bass ? '<sign>F</sign><line>4</line>' : '<sign>G</sign><line>2</line>'
  const attrs = `<attributes><divisions>${DIV}</divisions>${timeXml(song)}<clef>${clef}</clef></attributes>`
  const written = notes.map((note) => ({ ...note, from: note.startDiv, to: note.endDiv }))
  const measures: string[] = []
  for (let bar = 1; bar <= song.bars; bar++) {
    const start = (bar - 1) * barDivs
    let cursor = start
    let xml = measureOpen(bar, attrs) + annotations(song, bar, true)
    const rest = (duration: number) => {
      for (const d of pieces(duration)) xml += `<note><rest/><duration>${d}</duration>${typeOf(d)}</note>`
    }
    for (const n of written) {
      const from = Math.max(start, n.from, cursor)
      const to = Math.min(start + barDivs, n.to)
      if (to <= from) continue
      rest(from - cursor)
      cursor = from
      for (const d of pieces(to - from)) {
        const stop = cursor > n.from
        const begin = cursor + d < n.to
        const ties = `${stop ? '<tie type="stop"/>' : ''}${begin ? '<tie type="start"/>' : ''}`
        const articulation = n.staccato && cursor === n.from ? '<articulations><staccato/></articulations>' : ''
        const notation = stop || begin || articulation
          ? `<notations>${stop ? '<tied type="stop"/>' : ''}${begin ? '<tied type="start"/>' : ''}${articulation}</notations>`
          : ''
        xml += `<note>${pitch(n.midi, false)}<duration>${d}</duration>${ties}${typeOf(d)}${notation}</note>`
        cursor += d
      }
    }
    rest(start + barDivs - cursor)
    measures.push(xml + '</measure>')
  }
  return wrap('Vocal melody (draft)', measures)
}

/** Transcribed pitched notes; mixed registers use treble and bass staves without inventing hands or fingering. */
export function instrumentXml(song: Song, track: Track): string {
  const barDivs = song.beatsPerBar * DIV
  const notes = notationNotes(song.instrumentNotes?.[track.id] ?? [], track.id, song.beatsPerBar)
  const low = notes.some((n) => n.midi < 60)
  const high = notes.some((n) => n.midi >= 60)
  const split = low && high
  const attrs = `<attributes><divisions>${DIV}</divisions>${timeXml(song)}${split
    ? '<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>'
    : `<clef><sign>${low ? 'F' : 'G'}</sign><line>${low ? 4 : 2}</line></clef>`}</attributes>`
  type InstrumentEvent = { startDiv: number; endDiv: number; staff: number; heads: Head[] }
  type VoiceLine = { endDiv: number; events: InstrumentEvent[] }
  const grouped = new Map<string, InstrumentEvent>()
  for (const note of notes) {
    if (!(note.source.beats > 0)) continue
    const staff = split && note.midi < 60 ? 2 : 1
    const key = `${staff}:${note.startDiv}:${note.endDiv}`
    const base = Math.ceil(note.midi - 0.5)
    const cents = Math.round((note.midi - base) * 100)
    const head: Head = {
      xml: pitch(base, false),
      cents: cents ? `${cents > 0 ? '+' : ''}${cents}¢` : undefined,
      staccato: note.staccato,
    }
    const event = grouped.get(key)
    if (event) event.heads.push(head)
    else grouped.set(key, { startDiv: note.startDiv, endDiv: note.endDiv, staff, heads: [head] })
  }
  const voiceLines = new Map<number, VoiceLine[]>()
  const events = [...grouped.values()].sort((a, b) =>
    a.staff - b.staff || a.startDiv - b.startDiv || b.endDiv - a.endDiv)
  for (const event of events) {
    const lines = voiceLines.get(event.staff) ?? []
    let line = lines.find((candidate) => candidate.endDiv <= event.startDiv)
    if (!line) {
      line = { endDiv: 0, events: [] }
      lines.push(line)
      voiceLines.set(event.staff, lines)
    }
    line.events.push(event)
    line.endDiv = event.endDiv
  }
  const measures: string[] = []
  for (let bar = 1; bar <= song.bars; bar++) {
    const start = (bar - 1) * song.beatsPerBar
    const startDiv = Math.round(start * DIV)
    const endDiv = startDiv + barDivs
    const parts: string[] = []
    for (const staff of (split ? [1, 2] : [1])) {
      const lines = (voiceLines.get(staff) ?? [])
        .map((line, index) => ({
          voiceNo: staff === 1 ? index + 1 : index + 5,
          events: line.events
            .filter((event) => event.startDiv < endDiv && event.endDiv > startDiv)
            .map((event) => ({
              pos: Math.max(startDiv, event.startDiv) - startDiv,
              dur: Math.min(endDiv, event.endDiv) - Math.max(startDiv, event.startDiv),
              heads: event.heads.map((head) => ({
                ...head,
                stop: event.startDiv < startDiv,
                start: event.endDiv > endDiv,
              })),
            })),
        }))
        .filter((line) => line.events.length)
      for (const line of (lines.length ? lines : [{ voiceNo: staff === 1 ? 1 : 5, events: [] as Event[] }])) {
        if (parts.length) parts.push(`<backup><duration>${barDivs}</duration></backup>`)
        parts.push(voice(line.events, line.voiceNo, staff, null, barDivs))
      }
    }
    measures.push(measureOpen(bar, attrs) + annotations(song, bar, true) + parts.join('') +
      (bar === song.bars ? '<barline location="right"><bar-style>light-heavy</bar-style></barline>' : '') + '</measure>')
  }
  return wrap(track.name.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!), measures, track.gmProgram)
}

/** The accompaniment as a grand staff: each chord's voicing held in the right hand, its bass note in the left. Plays what the engine plays. */
export function chordsXml(song: Song, chords = true): string {
  const barDivs = song.beatsPerBar * DIV
  const attrs = `<attributes><divisions>${DIV}</divisions><key><fifths>0</fifths></key>${timeXml(song)}<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`
  const measures: string[] = []
  for (let bar = 1; bar <= song.bars; bar++) {
    const start = (bar - 1) * song.beatsPerBar
    const end = start + song.beatsPerBar
    const inBar = song.chords.filter((c) => c.tones.length && c.startBeat < end && c.startBeat + c.beats > start)
    const events = (pick: (tones: number[]) => number[]): Event[] =>
      inBar.map((c) => {
        const from = Math.max(c.startBeat, start)
        return {
          pos: Math.round((from - start) * DIV),
          dur: Math.round((Math.min(c.startBeat + c.beats, end) - from) * DIV),
          heads: pick(c.tones).map((m) => ({ xml: pitch(m, c.flats) })),
        }
      })
    measures.push(
      measureOpen(bar, attrs) +
        annotations(song, bar, chords) +
        voice(events((t) => t), 1, 1, null, barDivs) +
        `<backup><duration>${barDivs}</duration></backup>` +
        voice(events((t) => [t[0] - 24]), 5, 2, null, barDivs) +
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

function drumHead(lane: DrumLane): string {
  const [step, octave, head] = DRUM_POS[lane]
  return `<unpitched><display-step>${step}</display-step><display-octave>${octave}</display-octave></unpitched>${head ? `<notehead>${head}</notehead>` : ''}`
}

export function drumXml(song: Song, chords = true): string {
  const barDivs = song.beatsPerBar * DIV
  const attrs = `<attributes><divisions>${DIV}</divisions><key><fifths>0</fifths></key>${timeXml(song)}<clef><sign>percussion</sign></clef></attributes>`
  const measures: string[] = []
  for (let bar = 1; bar <= song.bars; bar++) {
    const start = (bar - 1) * song.beatsPerBar
    const hits = song.drums.filter((h) => h.startBeat >= start && h.startBeat < start + song.beatsPerBar)
    const events = (feet: boolean) =>
      toGaps(
        group(hits.filter((h) => (h.lane === 'kick') === feet).map((h) => ({ pos: Math.round((h.startBeat - start) * DIV), dur: 0, head: { xml: drumHead(h.lane) } }))),
        barDivs,
      )
    measures.push(
      measureOpen(bar, attrs) +
        annotations(song, bar, chords) +
        voice(events(false), 1, 1, 'up', barDivs) +
        `<backup><duration>${barDivs}</duration></backup>` +
        voice(events(true), 2, 1, 'down', barDivs) +
        (bar === song.bars ? '<barline location="right"><bar-style>light-heavy</bar-style></barline>' : '') +
        '</measure>',
    )
  }
  return wrap('Drum kit', measures)
}
