import type { DrumLane, Song, Track } from './song'

const DIV = 16 // divisions per quarter note
const timeXml = (song: Song) => `<time><beats>${Math.round(song.beatsPerBar * (song.beatUnit ?? 4) / 4)}</beats><beat-type>${song.beatUnit ?? 4}</beat-type></time>`
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

type Head = { xml: string; stop?: boolean; start?: boolean; cents?: string }
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
        const notation = stop || start ? `<notations>${stop ? '<tied type="stop"/>' : ''}${start ? '<tied type="start"/>' : ''}</notations>` : ''
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
  const attrs = `<attributes><divisions>${DIV}</divisions><key><fifths>0</fifths></key>${timeXml(song)}<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`
  const measures: string[] = []
  for (let bar = 1; bar <= song.bars; bar++) {
    const start = (bar - 1) * song.beatsPerBar
    const chord = song.chords.find((c) => c.startBeat <= start && c.startBeat + c.beats > start)
    const flats = chord?.flats ?? false
    const hand = (h: 'right' | 'left') =>
      group(
        song.piano
          .filter((n) => n.hand === h && n.startBeat < start + song.beatsPerBar && n.startBeat + n.beats > start)
          .map((n) => ({
            pos: Math.round((Math.max(n.startBeat, start) - start) * DIV),
            dur: Math.round((Math.min(n.startBeat + n.beats, start + song.beatsPerBar) - Math.max(n.startBeat, start)) * DIV),
            head: { xml: pitch(n.midi, flats), stop: n.startBeat < start, start: n.startBeat + n.beats > start + song.beatsPerBar },
          })),
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
  const pitches = song.vocals.map((n) => n.midi).sort((a, b) => a - b)
  const bass = pitches.length > 0 && pitches[Math.floor(pitches.length / 2)] < 60
  const clef = bass ? '<sign>F</sign><line>4</line>' : '<sign>G</sign><line>2</line>'
  const attrs = `<attributes><divisions>${DIV}</divisions>${timeXml(song)}<clef>${clef}</clef></attributes>`
  const notes = song.vocals.map((n) => ({
    ...n, from: Math.round(n.startBeat * DIV), to: Math.max(Math.round(n.startBeat * DIV) + 1, Math.round((n.startBeat + n.beats) * DIV)),
  }))
  const measures: string[] = []
  for (let bar = 1; bar <= song.bars; bar++) {
    const start = (bar - 1) * barDivs
    let cursor = start
    let xml = measureOpen(bar, attrs) + annotations(song, bar, true)
    const rest = (duration: number) => {
      for (const d of pieces(duration)) xml += `<note><rest/><duration>${d}</duration>${typeOf(d)}</note>`
    }
    for (const n of notes) {
      const from = Math.max(start, n.from, cursor)
      const to = Math.min(start + barDivs, n.to)
      if (to <= from) continue
      rest(from - cursor)
      cursor = from
      for (const d of pieces(to - from)) {
        const stop = cursor > n.from
        const begin = cursor + d < n.to
        const ties = `${stop ? '<tie type="stop"/>' : ''}${begin ? '<tie type="start"/>' : ''}`
        const notation = stop || begin ? `<notations>${stop ? '<tied type="stop"/>' : ''}${begin ? '<tied type="start"/>' : ''}</notations>` : ''
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
  const notes = song.instrumentNotes?.[track.id] ?? []
  const low = notes.some((n) => n.midi < 60)
  const high = notes.some((n) => n.midi >= 60)
  const split = low && high
  const attrs = `<attributes><divisions>${DIV}</divisions>${timeXml(song)}${split
    ? '<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>'
    : `<clef><sign>${low ? 'F' : 'G'}</sign><line>${low ? 4 : 2}</line></clef>`}</attributes>`
  const measures: string[] = []
  for (let bar = 1; bar <= song.bars; bar++) {
    const start = (bar - 1) * song.beatsPerBar
    const end = start + song.beatsPerBar
    const events = notes.filter((n) => n.beats > 0 && n.startBeat < end && n.startBeat + n.beats > start)
      .map((n) => {
        const from = Math.max(start, n.startBeat)
        const to = Math.min(end, n.startBeat + n.beats)
        const base = Math.ceil(n.midi - 0.5)
        const cents = Math.round((n.midi - base) * 100)
        return {
          pos: Math.round((from - start) * DIV),
          dur: Math.max(1, Math.round((to - start) * DIV) - Math.round((from - start) * DIV)),
          staff: split && n.midi < 60 ? 2 : 1,
          head: { xml: pitch(base, false), cents: cents ? `${cents > 0 ? '+' : ''}${cents}¢` : undefined,
            stop: n.startBeat < start, start: n.startBeat + n.beats > end },
        }
      })
      .sort((a, b) => a.pos - b.pos || b.dur - a.dur)
    const parts: string[] = []
    for (const staff of (split ? [1, 2] : [1])) {
      const voices: { end: number; events: Event[] }[] = []
      for (const event of events.filter((e) => e.staff === staff)) {
        const same = voices.find((v) => v.events.some((e) => e.pos === event.pos && e.dur === event.dur))
        if (same) {
          same.events.find((e) => e.pos === event.pos && e.dur === event.dur)!.heads.push(event.head)
          continue
        }
        let line = voices.find((v) => v.end <= event.pos)
        if (!line) {
          line = { end: 0, events: [] }
          voices.push(line)
        }
        line.events.push({ pos: event.pos, dur: event.dur, heads: [event.head] })
        line.end = event.pos + event.dur
      }
      for (const [i, line] of (voices.length ? voices : [{ end: 0, events: [] }]).entries()) {
        if (parts.length) parts.push(`<backup><duration>${barDivs}</duration></backup>`)
        parts.push(voice(line.events, staff === 1 ? i + 1 : i + 5, staff, null, barDivs))
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
