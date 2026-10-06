import { hasPitchedScore, type Confidence, type Song, type Track } from '../workspace/song'

type HostTrack = Track & { sourceInstrument?: string }

/**
 * The host's song JSON, shaped for the workspace: the host's generated accompaniment is replaced
 * by the workspace's own Creative tracks, and the Chords track and its confidence are added.
 */
export function fromHost(raw: Omit<Song, 'tracks'> & { accompaniment?: unknown; tracks: HostTrack[] }): Song {
  const bpb = raw.beatsPerBar || 4
  const bars = raw.bars
  const tracks: Track[] = raw.tracks
    .filter((t) => t.id !== 'accompaniment' && t.instrument !== 'chords')
    .map((track) => track.gmProgram != null || track.sourceInstrument !== 'clean_electric_guitar'
      ? track
      : { ...track, gmProgram: 27 })
  if (hasPitchedScore(raw) && raw.chords.some((chord) => chord.symbol && chord.symbol !== 'N.C.' && chord.tones.length)) {
    tracks.push({ id: 'chords', instrument: 'chords', group: 'creative', chordal: true, name: 'Chords', detail: 'The progression as held chords over a bass line' })
  }
  const filled = (list: Confidence[] | undefined): Confidence[] => Array.from({ length: bars }, (_, i) => list?.[i] ?? 'high')
  const chordConfidence = Array.from({ length: bars }, (_, i): Confidence => {
    const inBar = raw.chords.filter((c) => c.startBeat < (i + 1) * bpb && c.startBeat + c.beats > i * bpb)
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
