import { songBeats } from './meter'
import { BASS, GUITAR, positionsForMidi } from './fretboard'
import { isBassTrack } from './bass'
import { isGuitarTrack } from './guitar'
import type { Song, Track } from './song'

const LANES = new Set(['crash', 'ride', 'hihat', 'openhat', 'hightom', 'snare', 'floortom', 'kick'])

/** Search real events in the viewed practice layer, never rests or chord-name annotations. */
export function firstPlayableBeat(song: Song, track?: Track): number | null {
  if (!track || track.chordal || track.instrument === 'chords') return null
  const events = track.instrument === 'other' ? song.instrumentNotes?.[track.id] ?? []
    : track.instrument === 'piano' ? song.piano
      : track.instrument === 'vocals' ? song.vocals ?? [] : song.drums
  const total = songBeats(song)
  const fretted = isBassTrack(track) ? BASS : isGuitarTrack(track) ? GUITAR : null
  let first = Infinity
  for (const note of events) {
    if (note.trackId && note.trackId !== track.id) continue
    if (!Number.isFinite(note.startBeat) || note.startBeat < 0 || note.startBeat >= total ||
        (note.velocity != null && (!Number.isFinite(note.velocity) || note.velocity <= 0))) continue
    if ('lane' in note) {
      if (!LANES.has(note.lane)) continue
    } else if (note.notPlayable || !Number.isFinite(note.midi) || note.midi < 0 || note.midi > 127 ||
        !Number.isFinite(note.beats) || note.beats <= 0 ||
        (track.instrument === 'piano' && (note.midi < 21 || note.midi > 108)) ||
        (fretted && !positionsForMidi(note.midi, fretted).length)) continue
    first = Math.min(first, note.startBeat)
  }
  return Number.isFinite(first) ? first : null
}
