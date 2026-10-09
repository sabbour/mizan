import type { BarMeter, Song } from './song'

type MeterSong = Pick<Song, 'bars' | 'beatsPerBar' | 'beatUnit' | 'barMap'>
type TimedSong = Pick<Song, 'bpm' | 'tempoMap'>
const cache = new WeakMap<MeterSong, { inputs: unknown[]; bars: BarMeter[] }>()

export function measures(song: MeterSong): BarMeter[] {
  const inputs = [song.barMap, song.bars, song.beatsPerBar, song.beatUnit]
  const previous = cache.get(song)
  if (previous && inputs.every((input, index) => input === previous.inputs[index])) return previous.bars
  if (!Number.isSafeInteger(song.bars) || song.bars <= 0 || song.bars > 100_000) throw new RangeError('The song has an invalid bar count.')
  if (song.barMap !== undefined && !Array.isArray(song.barMap)) throw new RangeError('The song has an invalid bar map.')
  const unit = song.beatUnit ?? 4
  const bars: BarMeter[] = song.barMap ?? Array.from({ length: song.bars }, (_, index) => ({
    startBeat: index * song.beatsPerBar, beats: song.beatsPerBar,
    numerator: song.beatsPerBar * unit / 4, denominator: unit,
  }))
  if (bars.length !== song.bars) throw new RangeError('The song bar count does not match its bar map.')
  let end = 0
  for (const bar of bars) {
    const nominal = bar.numerator * 4 / bar.denominator
    if (!Number.isFinite(bar.startBeat) || !Number.isFinite(bar.beats) || bar.beats <= 0 ||
        Math.abs(bar.startBeat - end) > 1e-6 ||
        !Number.isSafeInteger(bar.numerator) || bar.numerator <= 0 ||
        !Number.isSafeInteger(bar.denominator) || bar.denominator <= 0 || bar.denominator > 64 ||
        !Number.isInteger(Math.log2(bar.denominator)) ||
        (!bar.partial && Math.abs(bar.beats - nominal) > 1e-6) ||
        (bar.partial && bar.beats > nominal + 1e-6) ||
        (bar.status !== undefined && !['explicit', 'supported', 'unverified'].includes(bar.status))) {
      throw new RangeError('The song has an invalid or non-contiguous bar map.')
    }
    end = bar.startBeat + bar.beats
  }
  cache.set(song, { inputs, bars })
  return bars
}

export function barAt(song: MeterSong, beat: number): number {
  const bars = measures(song)
  let first = 0
  let last = bars.length
  while (first < last) {
    const middle = Math.floor((first + last) / 2)
    if (bars[middle].startBeat <= beat) first = middle + 1
    else last = middle
  }
  return Math.max(0, first - 1)
}

export function barStart(song: MeterSong, index: number): number {
  const bars = measures(song)
  return index >= bars.length ? songBeats(song) : bars[Math.max(0, index)].startBeat
}

export function songBeats(song: MeterSong): number {
  const last = measures(song).at(-1)!
  return last.startBeat + last.beats
}

export function pulseBeats(bar: BarMeter): number {
  return bar.denominator === 8 && bar.numerator >= 6 && bar.numerator % 3 === 0 ? 1.5 : 4 / bar.denominator
}

/** Recording seconds for a score beat; beyond the map the nearest segment's tempo continues. */
export function recordingSeconds(song: TimedSong, beat: number): number {
  const map = song.tempoMap
  if (!map?.length) return beat * 60 / song.bpm
  if (beat <= map[0].beat) return map[0].time + (beat - map[0].beat) * 60 / song.bpm
  for (let i = 1; i < map.length; i++) {
    const right = map[i]
    if (beat <= right.beat) {
      const left = map[i - 1]
      return left.time + (beat - left.beat) / (right.beat - left.beat) * (right.time - left.time)
    }
  }
  if (map.length === 1) return map[0].time + (beat - map[0].beat) * 60 / song.bpm
  const left = map[map.length - 2]
  const right = map[map.length - 1]
  return right.time + (beat - right.beat) / (right.beat - left.beat) * (right.time - left.time)
}

/** Quarter-note tempo across one bar of the recording. */
export function barTempo(song: MeterSong & TimedSong, index: number): number {
  const bar = measures(song)[index]
  return 60 * bar.beats / (recordingSeconds(song, bar.startBeat + bar.beats) - recordingSeconds(song, bar.startBeat))
}
