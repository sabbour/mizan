import { type Confidence, type Song, type Track } from '../workspace/song'
import { measures } from '../workspace/meter'
import { detectedGmProgram } from '../workspace/gmInstruments'

type HostTrack = Track & { sourceInstrument?: string }

/** Shape saved song data for practice without generated accompaniment tracks. */
export function fromHost(raw: Omit<Song, 'tracks'> & { accompaniment?: unknown; tracks: HostTrack[] }): Song {
  const bpb = raw.beatsPerBar || 4
  const bars = raw.bars
  const barMap = measures({ ...raw, beatsPerBar: bpb })
  const tracks: Track[] = raw.tracks
    .filter((t) => t.id !== 'accompaniment' && t.instrument !== 'chords' && t.group !== 'creative')
    .map((track) => track.gmProgram != null || track.instrument !== 'other'
      ? track
      : { ...track, gmProgram: detectedGmProgram(track.sourceInstrument) })
  const filled = (list: Confidence[] | undefined): Confidence[] => Array.from({ length: bars }, (_, i) => list?.[i] ?? 'high')
  const chordConfidence = Array.from({ length: bars }, (_, i): Confidence => {
    const span = barMap[i]
    const inBar = raw.chords.filter((c) => c.startBeat < span.startBeat + span.beats && c.startBeat + c.beats > span.startBeat)
    const worst = Math.min(1, ...inBar.map((c) => c.confidence))
    return worst < 0.4 ? 'low' : worst < 0.7 ? 'medium' : 'high'
  })
  return {
    ...raw,
    beatsPerBar: bpb,
    tracks,
    piano: raw.piano ?? [],
    vocals: raw.vocals ?? [],
    drums: raw.drums ?? [],
    sections: raw.sections?.length ? raw.sections : [{ name: 'Song', startBar: 1, bars }],
    confidence: { piano: filled(raw.confidence?.piano), drums: filled(raw.confidence?.drums),
      vocals: Array.from({ length: bars }, (_, i) => raw.confidence?.vocals?.[i] ?? 'low'),
      chords: raw.confidence?.chords ?? chordConfidence },
  }
}
