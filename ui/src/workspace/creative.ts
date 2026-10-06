import { alternatives, type Alternative } from './harmonize'
import { barAt, measures, pulseBeats, songBeats } from './meter'
import { chordAt, hasPitchedScore, invert, smoothInversions, sustainedChords, type Chord, type PianoNote, type Song, type Track } from './song'

/** A generated part to play along with the song harmonically. Not a transcription: nothing here is what the recording plays. */
export type CreativeTrack = Track & { chords: Chord[]; piano: PianoNote[] }

/** Preserve sparse source accents; dense bars fall back to two meter-aware attacks. */
export function accompanimentRhythm(song: Song): number[] {
  const bars = measures(song)
  const totalBeats = songBeats(song)
  const percussion = new Map<number, number[]>()
  const backbeat = new Map<number, number[]>()
  const pitched = new Map<number, number[]>()
  const add = (map: Map<number, number[]>, beat: number) => {
    if (!Number.isFinite(beat) || beat < 0 || beat >= totalBeats) return
    const bar = barAt(song, beat)
    const beats = map.get(bar) ?? []
    beats.push(beat)
    map.set(bar, beats)
  }
  for (const hit of song.drums) {
    if (!(hit.velocity > 0)) continue
    add(percussion, hit.startBeat)
    if (hit.lane === 'kick' || hit.lane === 'snare') add(backbeat, hit.startBeat)
  }
  for (const note of [...song.piano, ...song.vocals, ...Object.values(song.instrumentNotes ?? {}).flat()]) {
    if (note.beats > 0 && (note.velocity ?? 1) > 0) add(pitched, note.startBeat)
  }
  const rhythm: number[] = []
  for (const [bar, measure] of bars.entries()) {
    const pulse = pulseBeats(measure)
    const compound = measure.denominator === 8 && measure.numerator >= 6 && measure.numerator % 3 === 0
    const second = compound
      ? Math.round((measure.beats / 2) / pulse) * pulse
      : measure.denominator === 4
        ? Math.min(2, measure.beats - pulse)
        : Math.min(measure.beats - pulse, Math.max(pulse, Math.round((measure.beats / 2) / pulse) * pulse))
    const anchors = [...new Set([0, second].filter((beat) => beat >= 0 && beat < measure.beats))]
    const local = backbeat.get(bar) ?? percussion.get(bar) ?? pitched.get(bar)
    const unique = local ? [...new Set(local)].sort((a, b) => a - b) : []
    if (unique.length > 0 && unique.length <= 2) rhythm.push(...unique)
    else if (!unique.length) rhythm.push(...anchors.map((beat) => measure.startBeat + beat))
    else {
      const barStart = measure.startBeat
      const selected = new Set<number>()
      for (const anchor of anchors) {
        const candidate = unique.filter((beat) => !selected.has(beat))
          .sort((a, b) => {
            const localA = a - barStart
            const localB = b - barStart
            return Math.abs(localA - anchor) - Math.abs(localB - anchor) ||
              Number(localA < anchor) - Number(localB < anchor) || a - b
          })[0]
        if (candidate !== undefined) selected.add(candidate)
      }
      rhythm.push(...selected)
    }
  }
  return [...new Set(rhythm)].sort((a, b) => a - b)
}

export function chordRhythm(chord: Pick<Chord, 'startBeat' | 'beats'>, rhythm: readonly number[]): { startBeat: number; beats: number }[] {
  const end = chord.startBeat + chord.beats
  if (!(chord.beats > 0)) return []
  const attacks = [...new Set([chord.startBeat, ...rhythm.filter((beat) => beat > chord.startBeat && beat < end)])].sort((a, b) => a - b)
  return attacks.map((startBeat, i) => ({ startBeat, beats: (attacks[i + 1] ?? end) - startBeat }))
}

function melodyNotes(song: Song): PianoNote[] {
  if (song.vocals.length) return song.vocals.map((note) => ({ ...note, hand: 'right' }))
  const right = song.piano.filter((note) => note.hand === 'right')
  if (right.length) return right
  return Object.values(song.instrumentNotes ?? {}).flat().map((note) => ({ ...note, hand: 'right' }))
}

function harmonicSlots(song: Song): number[] {
  return accompanimentRhythm({ ...song, piano: [], vocals: [], drums: [], instrumentNotes: undefined })
}

function melodyFit(notes: readonly PianoNote[], start: number, end: number, tones: readonly number[]): number {
  const pitchClasses = new Set(tones.map((tone) => ((tone % 12) + 12) % 12))
  return notes.reduce((score, note) => {
    const overlap = Math.min(note.startBeat + note.beats, end) - Math.max(note.startBeat, start)
    if (!(overlap > 0) || !Number.isFinite(note.midi)) return score
    const attacked = note.startBeat >= start && note.startBeat < end ? 0.05 : 0
    const velocity = Math.min(1.25, Math.max(0.5, (note.velocity ?? 0.7) / 0.7))
    const weight = (Math.min(1, overlap / Math.max(0.5, end - start)) + attacked) * velocity
    const pitch = ((Math.round(note.midi) % 12) + 12) % 12
    return score + (pitchClasses.has(pitch) ? weight : -weight)
  }, 0)
}

function sharedTones(left: readonly number[], right: readonly number[]): number {
  const pcs = new Set(left.map((tone) => ((tone % 12) + 12) % 12))
  return new Set(right.map((tone) => ((tone % 12) + 12) % 12).filter((tone) => pcs.has(tone))).size
}

/** Choose melody-supported variants at strong meter slots, keeping compatible chords steady. */
function movingChords(song: Song, rhythm: readonly number[], slots: readonly number[]): CreativeTrack {
  const notes = melodyNotes(song)
  const slotSet = new Set(slots)
  const changes = new Map<number, number>()
  let previous: Chord | undefined
  const chords = song.chords.map((source, index) => {
    if (source.symbol === 'N.C.') {
      previous = undefined
      return { ...source, tones: [...source.tones] }
    }
    if (!source.symbol || !source.tones.length) return { ...source, tones: [...source.tones] }
    const start = source.startBeat
    const end = start + source.beats
    const sourceCopy = { ...source, tones: [...source.tones] }
    let chosen: Chord = sourceCopy
    const hasMelody = notes.some((note) => note.startBeat < end && note.startBeat + note.beats > start)
    if (previous && hasMelody && sharedTones(previous.tones, source.tones) >= 2 &&
        melodyFit(notes, start, end, previous.tones) >= melodyFit(notes, start, end, source.tones) - 0.25) {
      chosen = { ...source, symbol: previous.symbol, numeral: previous.numeral,
        tones: [...previous.tones], flats: previous.flats }
    } else if (slotSet.has(start) && (changes.get(barAt(song, start)) ?? 0) < 2) {
      let options: Alternative[] = []
      try {
        options = alternatives(song, index, 8)
      } catch {
        previous = chosen
        return chosen
      }
      const sourceFit = melodyFit(notes, start, end, source.tones)
      const option = options
        .filter((candidate) => (candidate.kind === 'color' || candidate.kind === 'substitute') &&
          sharedTones(candidate.tones, source.tones) >= 2)
        .map((candidate, order) => ({ candidate, order, gain: melodyFit(notes, start, end, candidate.tones) - sourceFit }))
        .filter(({ gain }) => gain >= 0.65)
        .sort((a, b) => b.gain - a.gain || a.order - b.order)[0]?.candidate
      if (option) {
        chosen = { ...sourceCopy, symbol: option.symbol, numeral: option.numeral,
          tones: [...option.tones], flats: option.flats }
        const bar = barAt(song, start)
        changes.set(bar, (changes.get(bar) ?? 0) + 1)
      }
    }
    previous = chosen
    return chosen
  })
  const merged: Chord[] = []
  for (const chord of chords) {
    const prior = merged.at(-1)
    if (prior && chord.symbol && prior.symbol === chord.symbol &&
        prior.startBeat + prior.beats === chord.startBeat &&
        prior.tones.length === chord.tones.length &&
        prior.tones.every((tone, index) => tone === chord.tones[index])) prior.beats += chord.beats
    else merged.push(chord)
  }
  return {
    id: 'colour', instrument: 'piano', group: 'creative', chordal: true, name: 'Colour chords',
    detail: 'Meter-aware chord choices supported by the melody',
    chords: merged, piano: sustainedPattern(sustainedChords(merged), rhythm),
  }
}

/** Follow the source attacks with connected voicings and a held bass. */
function sustainedPattern(chords: Chord[], rhythm: readonly number[]): PianoNote[] {
  const piano: PianoNote[] = []
  chords.forEach((chord) => {
    if (!chord.tones.length) return
    piano.push({ midi: chord.tones[0] - 24, startBeat: chord.startBeat, beats: chord.beats, hand: 'left', velocity: 0.66 })
    for (const { startBeat, beats } of chordRhythm(chord, rhythm)) {
      chord.tones.forEach((midi) => piano.push({ midi, startBeat, beats, hand: 'right', velocity: 0.62 }))
    }
  })
  return piano
}

export type HarmonyOptions = { source: 'melody' | 'chords'; above: boolean; interval: 3 | 6 | 10; sparse: boolean }
export const HARMONY_DEFAULT: HarmonyOptions = { source: 'melody', above: false, interval: 3, sparse: false }

const DISTANCE = { 3: 4, 6: 9, 10: 16 }
const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const SCALE = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] }

/**
 * Melody mode shadows the lead in the detected key, even when a chord is uncertain.
 * Chord mode follows only identified chord tones; neither mode relabels an unknown chord.
 */
function harmonyLine(song: Song, { source, above, interval, sparse }: HarmonyOptions, slots: readonly number[]): CreativeTrack {
  const top = new Map<number, PianoNote>()
  const lead = melodyNotes(song)
  for (const n of lead) if ((top.get(n.startBeat)?.midi ?? -1) < n.midi) top.set(n.startBeat, n)
  const melody = [...top.values()].sort((a, b) => a.startBeat - b.startBeat)
  const tonic = song.key && (NAMES.includes(song.key.tonic) ? NAMES.indexOf(song.key.tonic) : SHARPS.indexOf(song.key.tonic))
  const scale = tonic !== null && tonic >= 0 ? SCALE[song.key!.mode].map((pc) => (pc + tonic) % 12) : null
  const direction = above ? 1 : -1
  const target = (midi: number) => midi + direction * DISTANCE[interval]
  const nearest = (midi: number, pcs: number[], avoid?: number, previous?: number) => {
    const candidates = Array.from({ length: 84 }, (_, i) => i + 24)
      .filter((note) => pcs.includes(note % 12) && note !== avoid && Math.abs(note - midi) <= 4)
    return candidates.sort((a, b) =>
      Math.abs(a - midi) + (previous === undefined ? 0 : Math.abs(a - previous) * 0.35) -
      Math.abs(b - midi) - (previous === undefined ? 0 : Math.abs(b - previous) * 0.35))[0]
  }
  const piano: PianoNote[] = []
  if (source === 'chords') {
    let previousPitch: number | undefined
    for (const chord of sustainedChords(song.chords)) {
      const lead = [...melody].reverse().find((m) => m.startBeat <= chord.startBeat)?.midi ?? 67
      const pcs = chord.tones.map((tone) => tone % 12)
      const pitch = nearest(target(lead), pcs, lead, previousPitch) ??
        nearest(lead + direction * 7, pcs, lead, previousPitch)
      if (pitch === undefined) continue
      piano.push({ midi: pitch, startBeat: chord.startBeat, beats: chord.beats,
        hand: !above && interval === 10 ? 'left' : 'right', velocity: 0.8 })
      previousPitch = pitch
    }
  } else {
    const selected = new Map<number, PianoNote>()
    for (const beat of slots) {
      const measure = measures(song)[barAt(song, beat)]
      const barStart = measure.startBeat
      const barEnd = barStart + measure.beats
      const candidates = melody.filter((note) => note.startBeat >= barStart && note.startBeat < barEnd &&
        (!sparse || (Math.abs(note.startBeat - Math.round(note.startBeat)) < 0.12 && note.beats >= 1)))
      const candidate = candidates.sort((a, b) =>
        Math.abs(a.startBeat - beat) - Math.abs(b.startBeat - beat) || a.startBeat - b.startBeat)[0]
      if (candidate) selected.set(candidate.startBeat, candidate)
    }
    const chosen = [...selected.values()].sort((a, b) => a.startBeat - b.startBeat)
    for (const m of chosen) {
      const next = melody.find((note) => note.startBeat > m.startBeat)
      const chord = song.chords[chordAt(song, m.startBeat)]
      const chordPcs = chord?.symbol && chord.symbol !== 'N.C.' ? chord.tones.map((tone) => tone % 12) : []
      const aimed = target(m.midi)
      const chordPitch = chordPcs.length ? nearest(aimed, chordPcs) : undefined
      const pitch = (chordPitch !== undefined && Math.abs(chordPitch - aimed) <= 1 ? chordPitch : undefined)
        ?? (scale ? nearest(aimed, scale) : aimed)
      if (pitch === m.midi) continue
      const beats = Math.min(m.beats, (next?.startBeat ?? Infinity) - m.startBeat)
      if (beats > 0) piano.push({ ...m, midi: pitch, beats, hand: !above && interval === 10 ? 'left' : 'right', velocity: 0.8 })
    }
  }
  const name = { 3: '3rds', 6: '6ths', 10: '10ths' }[interval]
  return {
    id: 'harmony-line', instrument: 'piano', group: 'creative', name: 'Harmony line',
    detail: `A second voice in ${name} ${above ? 'above' : 'under'} the ${source}${sparse && source === 'melody' ? ', long notes only' : ''}`,
    chords: song.chords, piano,
  }
}

/** Follow the groove with nearby inversions over a held root. */
function smoothComping(song: Song, rhythm: readonly number[]): CreativeTrack {
  const chords = sustainedChords(song.chords)
  const inv = smoothInversions(chords)
  const piano: PianoNote[] = []
  chords.forEach((c, i) => {
    if (!c.tones.length) return
    const tones = invert(c.tones, inv[i])
    piano.push({ midi: c.tones[0] - 24, startBeat: c.startBeat, beats: c.beats, hand: 'left' })
    for (const { startBeat, beats } of chordRhythm(c, rhythm)) {
      for (const m of tones) piano.push({ midi: m, startBeat, beats, hand: 'right' })
    }
  })
  return {
    id: 'comping', instrument: 'piano', group: 'creative', chordal: true, name: 'Smooth comping',
    detail: 'Chords that barely move your hand, following the song rhythm',
    chords: song.chords, piano,
  }
}

export function creativeTracks(song: Song, harmony: HarmonyOptions = HARMONY_DEFAULT): CreativeTrack[] {
  if (!hasPitchedScore(song)) return []
  const namedChords = song.chords.some((chord) => chord.symbol && chord.symbol !== 'N.C.' && chord.tones.length)
  const rhythm = accompanimentRhythm(song)
  const slots = harmonicSlots(song)
  const colour = namedChords ? movingChords(song, rhythm, slots) : undefined
  const harmonySong = harmony.source === 'chords' && colour ? { ...song, chords: colour.chords } : song
  return [...(colour ? [colour, smoothComping(song, rhythm)] : []), harmonyLine(harmonySong, harmony, slots)]
}
