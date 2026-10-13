import type { Stem } from '../library/bridge'
import { sustainedChords, type DrumHit, type DrumLane, type MelodyNote, type PianoNote, type Song } from './song'
import { barAt, barStart, measures, pulseBeats, recordingSeconds, songBeats } from './meter'
import { tomRate } from './kit'
import { accompanimentRhythm, chordRhythm } from './creative'
import { Recording } from './recording'

export type Transport = {
  playing: boolean
  countingIn: boolean
  /** 1-based count-in beat while counting in, otherwise 0. */
  countBeat: number
  beat: number
}

type Anchor = { time: number; beat: number; spb: number; count: number }
type Sample = { midi: number; soft: AudioBuffer; loud: AudioBuffer }
type GmSample = { midi: number; buffer: AudioBuffer }
type GmManifest = { instruments: { program: number; name: string; samples: { midi: number; url: string; silent?: boolean }[] }[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isGmManifest(value: unknown): value is GmManifest {
  return isRecord(value) && Array.isArray(value.instruments) &&
    value.instruments.every((item) => isRecord(item) &&
      typeof item.program === 'number' && Number.isInteger(item.program) &&
      item.program >= 0 && item.program <= 127 && typeof item.name === 'string' &&
      Array.isArray(item.samples) && item.samples.every((sample) =>
        isRecord(sample) && typeof sample.midi === 'number' &&
        Number.isInteger(sample.midi) && typeof sample.url === 'string' &&
        (sample.silent === undefined || typeof sample.silent === 'boolean')))
}

const LOOKAHEAD = 0.12
const STEP = 0.25
const RELEASE = 0.45
const PIANO_ROOTS = [
  [21, 'A0'], [24, 'C1'], [27, 'Ds1'], [30, 'Fs1'], [33, 'A1'], [36, 'C2'], [39, 'Ds2'], [42, 'Fs2'],
  [45, 'A2'], [48, 'C3'], [51, 'Ds3'], [54, 'Fs3'], [57, 'A3'], [60, 'C4'], [63, 'Ds4'], [66, 'Fs4'],
  [69, 'A4'], [72, 'C5'], [75, 'Ds5'], [78, 'Fs5'], [81, 'A5'], [84, 'C6'], [87, 'Ds6'], [90, 'Fs6'],
  [93, 'A6'], [96, 'C7'], [99, 'Ds7'], [102, 'Fs7'], [105, 'A7'], [108, 'C8'],
] as const
const DRUMS: DrumLane[] = ['crash', 'ride', 'hihat', 'openhat', 'hightom', 'snare', 'floortom', 'kick']
let gmManifest: Promise<GmManifest> | null = null

function loadGmManifest(): Promise<GmManifest> {
  if (!gmManifest) {
    gmManifest = fetch('/samples/fluidr3/manifest.json')
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load the GM sound bank (${response.status}).`)
        const value: unknown = await response.json()
        if (!isGmManifest(value)) throw new Error('The GM sound bank manifest is invalid.')
        return value
      })
      .catch((error: unknown) => {
        gmManifest = null
        throw error
      })
  }
  return gmManifest
}

/**
 * One transport clock schedules local instrument samples and keeps recording stems
 * aligned to the score. Vocal melody uses a soft, formant-shaped vowel synth.
 */
/** The other parts sit 2 dB under the selected one. */
export const BACKGROUND = 10 ** (-2 / 20)

export class Engine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private timer = 0
  private mediaTimer = 0
  private mediaPauseTimer = 0
  private endTimer = 0
  private revision = 0
  private starting = false
  private pendingCountIn = false
  private nodes = new Set<AudioScheduledSourceNode>()
  private anchors: Anchor[] = []
  private cursorBeat = 0
  private cursorTime = 0
  private counting = 0
  private pausedBeat = 0
  private sampleLoad: Promise<void> | null = null
  private pianoSamples: Sample[] = []
  private gmSamples = new Map<number, GmSample[]>()
  private drumSamples = new Map<DrumLane, AudioBuffer>()
  private organWave: PeriodicWave | null = null
  private recording: Recording | null = null
  private buses = new Map<string, GainNode>()
  private resumeNotes = false
  private noteBoundary = Infinity
  private openHats = new Set<AudioBufferSourceNode>()
  private rhythmSource: Song | null = null
  private rhythmInputs: unknown[] = []
  private rhythm: number[] = []

  rate = 1
  loop: { startBar: number; endBar: number } | null = null
  countIn = true
  click = false
  /** Ids of muted synth tracks and `stem:<id>` recording tracks. */
  muted = new Set<string>()
  /**
   * The selected part: it leads the synth mix by about 2 dB, made by turning the other parts down (never by boosting
   * it), on top of the player's own levels. The click and count-in are not parts and are never changed.
   */
  selectedPart: string | null = null
  trackGains = new Map<string, number>()
  /** Chord voicings replaced by harmonize choices, by chord index. */
  swaps = new Map<number, number[]>()
  /** Generated play-along parts, routed through their own mixer buses. */
  extras: { id: string; notes: PianoNote[] }[] = []
  onEnd: (() => void) | null = null
  onError: ((message: string) => void) | null = null
  onLoading: ((loading: boolean) => void) | null = null
  song: Song
  stems: Stem[]

  constructor(song: Song, stems: Stem[] = []) {
    if (![song.bpm, song.bars, song.beatsPerBar].every((value) => Number.isFinite(value) && value > 0) ||
        song.tempoMap?.some((point, index, map) =>
          !Number.isFinite(point.beat) || !Number.isFinite(point.time) || point.time < 0 ||
          (index > 0 && (point.beat <= map[index - 1].beat || point.time <= map[index - 1].time)))) {
      throw new Error('The song has invalid tempo or recording alignment data.')
    }
    measures(song)
    this.song = song
    this.stems = stems
  }

  get playing(): boolean {
    return this.timer !== 0 || this.starting
  }

  getEffectiveQuarterBpm(): number {
    return 60 / this.spbAt(this.read().beat)
  }

  private seconds(from: number, to: number): number {
    return (this.recordingTime(to) - this.recordingTime(from)) / this.rate
  }

  private spbAt(beat: number): number {
    return this.seconds(beat, beat + 0.001) / 0.001
  }

  private get totalBeats(): number {
    return songBeats(this.song)
  }

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' })
      this.master = this.ctx.createGain()
      this.master.gain.value = 0.72
      const comp = this.ctx.createDynamicsCompressor()
      comp.threshold.value = -10
      comp.knee.value = 18
      comp.ratio.value = 5
      this.master.connect(comp).connect(this.ctx.destination)
      if (this.stems.length) {
        this.recording = new Recording(this.ctx, this.stems, this.master)
        this.recording.media.addEventListener('error', () => {
          if (!this.timer || !this.recording?.media.hasAttribute('src') || !this.hasAudibleStem()) return
          this.pause()
          this.onError?.('The recording could not be read. Try playing again.')
        })
      }
    }
    return this.ctx
  }

  private hasAudibleStem(): boolean {
    return this.stems.some((stem) =>
      !this.muted.has(`stem:${stem.id}`) && (this.trackGains.get(`stem:${stem.id}`) ?? 1) > 0)
  }

  private async loadSamples(): Promise<void> {
    if (this.sampleLoad) return this.sampleLoad
    const ctx = this.ensure()
    const decode = async (url: string) => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Could not load instrument sample (${response.status}).`)
      return ctx.decodeAudioData(await response.arrayBuffer())
    }
    this.sampleLoad = Promise.all([
      ...PIANO_ROOTS.map(async ([midi, name]) => ({
        midi,
        soft: await decode(`/samples/piano/${name}-v5.ogg`),
        loud: await decode(`/samples/piano/${name}-v13.ogg`),
      })),
      ...DRUMS.map(async (lane) => [lane, await decode(`/samples/drums/${lane}.ogg`)] as const),
    ]).then(async (loaded) => {
      await this.loadGmSamples(ctx)
      if (ctx !== this.ctx) return
      this.pianoSamples = loaded.slice(0, PIANO_ROOTS.length) as Sample[]
      this.drumSamples = new Map(loaded.slice(PIANO_ROOTS.length) as [DrumLane, AudioBuffer][])
    }).catch((error: unknown) => {
      if (ctx === this.ctx) this.sampleLoad = null
      throw error
    })
    return this.sampleLoad
  }

  private async loadGmSamples(ctx: AudioContext): Promise<void> {
    const needed = new Map<number, MelodyNote[]>()
    for (const track of this.song.tracks) {
      if (track.instrument !== 'other' || track.gmProgram == null ||
          track.gmProgram < 0 || track.gmProgram > 127) continue
      const notes = this.song.instrumentNotes?.[track.id] ?? []
      if (notes.length) needed.set(track.gmProgram, [...(needed.get(track.gmProgram) ?? []), ...notes])
    }
    if (!needed.size) return

    const manifest = await loadGmManifest()
    const loaded = await Promise.all([...needed].map(async ([program, notes]) => {
      const instrument = manifest.instruments.find((item) => item.program === program)
      if (!instrument || !Array.isArray(instrument.samples)) {
        throw new Error(`The GM sound bank is missing program ${program + 1}.`)
      }
      const roots = instrument.samples
        .filter((sample) => sample.silent !== true && Number.isInteger(sample.midi) && sample.midi >= 21 &&
          sample.midi <= 108 && (sample.midi - 21) % 3 === 0 &&
          /^\/samples\/fluidr3\/[a-z0-9_-]+\/\d{2,3}\.mp3$/i.test(sample.url))
        .sort((a, b) => a.midi - b.midi)
      if (!roots.length) throw new Error(`The GM sound bank has no valid samples for program ${program + 1}.`)
      const targets = new Set(notes.map((note) => note.midi).filter(Number.isFinite))
      const neededRoots = new Map<number, (typeof roots)[number]>()
      for (const midi of targets) {
        const root = roots.reduce((best, item) =>
          Math.abs(item.midi - midi) < Math.abs(best.midi - midi) ? item : best)
        neededRoots.set(root.midi, root)
      }
      const samples = await Promise.all([...neededRoots.values()].map(async (sample) => {
        const response = await fetch(sample.url)
        if (!response.ok) throw new Error(`Could not load GM program ${program + 1} sample (${response.status}).`)
        const buffer = await ctx.decodeAudioData(await response.arrayBuffer())
        return { midi: sample.midi, buffer }
      }))
      return [program, samples] as const
    }))
    if (ctx !== this.ctx) return
    this.gmSamples = new Map(loaded)
  }

  read(): Transport {
    // While sounds are still being prepared nothing sounds yet: the clock reads as stopped (``engine.playing`` still says a start is pending).
    if (!this.ctx || !this.timer) return { playing: false, countingIn: false, countBeat: 0, beat: this.pausedBeat }
    const now = this.ctx.currentTime
    let a = this.anchors[0]
    for (const x of this.anchors) if (x.time <= now) a = x
    if (!a) return { playing: true, countingIn: false, countBeat: 0, beat: this.pausedBeat }
    if (a.count) return { playing: true, countingIn: true, countBeat: a.count, beat: a.beat }
    return { playing: true, countingIn: false, countBeat: 0, beat: Math.max(a.beat, a.beat + (now - a.time) / a.spb) }
  }

  async play(): Promise<void> {
    if (this.playing) return
    await this.prepare(this.countIn)
  }

  private async prepare(countIn: boolean): Promise<void> {
    const revision = ++this.revision
    this.starting = true
    this.pendingCountIn = countIn
    this.onLoading?.(true)
    try {
      const ctx = this.ensure()
      if (ctx.state === 'suspended') await ctx.resume()
      if (revision !== this.revision) return
      await Promise.all([this.loadSamples(), this.recording?.prepare(this.muted, this.trackGains)])
      if (revision !== this.revision) return
      this.starting = false
      this.updateMix()
      this.startAt(this.pausedBeat, countIn)
    } catch (error) {
      if (revision !== this.revision) return
      this.halt()
      this.onError?.(error instanceof Error ? error.message : 'Instrument samples could not be loaded.')
    } finally {
      if (revision === this.revision) {
        this.starting = false
        this.onLoading?.(false)
      }
    }
  }

  pause(): void {
    this.pausedBeat = this.read().beat
    this.halt()
  }

  dispose(): void {
    this.pause()
    this.recording?.dispose()
    this.recording = null
    if (this.ctx) void this.ctx.close()
    this.ctx = null
    this.master = null
    this.buses.clear()
    this.sampleLoad = null
    this.pianoSamples = []
    this.drumSamples.clear()
    this.gmSamples.clear()
    this.organWave = null
  }

  seek(beat: number): void {
    const target = Math.max(0, Math.min(beat, this.totalBeats - 0.001))
    if (this.starting) {
      this.pausedBeat = target
    } else if (this.playing) {
      this.halt()
      this.startAt(target, false)
    } else {
      this.pausedBeat = target
      this.seekMedia(target)
    }
  }

  /** Re-anchor timing changes; carry held notes into the new position. */
  refresh(): void {
    this.updateMix()
    if (!this.playing) return
    const t = this.read()
    const countIn = this.starting ? this.pendingCountIn : t.countingIn
    this.pausedBeat = t.beat
    this.halt()
    void this.prepare(countIn)
  }

  /** Lead the selected score without rebuilding the recording or restarting its clock. */
  selectPart(id: string | null): void {
    this.selectedPart = id
    this.updateMix()
  }

  refreshMix(): void {
    this.updateMix()
    if (!this.playing || !this.recording) return
    if (this.starting) return this.refresh()
    if (this.recording.adjustVolume(this.muted, this.trackGains)) return
    if (this.recording.signature(this.muted, this.trackGains) !== this.recording.readyKey) this.refresh()
  }

  /** Preview a chord through its track's mixer bus, without starting the transport. */
  async audition(tones: number[], trackId = 'chords'): Promise<void> {
    if (this.playing || this.muted.has(trackId) || !tones.length) return
    try {
      const ctx = this.ensure()
      if (ctx.state === 'suspended') await ctx.resume()
      await this.loadSamples()
      if (this.playing || this.muted.has(trackId) || !this.ctx || ctx !== this.ctx) return
      const t = ctx.currentTime + 0.03
      const bus = this.bus(trackId)
      this.sampleNote(t, tones[0] - 24, 1.6, 0.64, bus, 0.01, 0.6)
      tones.forEach((m, i) => this.sampleNote(t + i * 0.035, m, 1.5, 0.62, bus, 0.01, 0.55))
    } catch (error) {
      this.onError?.(error instanceof Error ? error.message : 'Instrument samples could not be loaded.')
    }
  }

  private halt(): void {
    this.revision++
    this.starting = false
    this.onLoading?.(false)
    clearInterval(this.timer)
    clearTimeout(this.mediaTimer)
    clearTimeout(this.mediaPauseTimer)
    clearTimeout(this.endTimer)
    this.timer = 0
    this.mediaTimer = 0
    this.mediaPauseTimer = 0
    this.endTimer = 0
    for (const n of this.nodes) {
      try {
        n.stop()
      } catch {
        // Already stopped.
      }
    }
    this.nodes.clear()
    this.openHats.clear()
    this.anchors = []
    this.recording?.media.pause()
  }

  private startAt(beat: number, countIn: boolean): void {
    const ctx = this.ensure()
    this.cursorBeat = beat
    this.pausedBeat = beat
    this.resumeNotes = true
    this.cursorTime = ctx.currentTime + 0.05
    this.counting = countIn ? 1 : 0
    this.anchors = [{ time: this.cursorTime, beat, spb: this.spbAt(beat), count: this.counting }]
    if (!this.counting) this.scheduleMedia(beat, this.cursorTime, true)
    this.timer = window.setInterval(() => this.schedule(), 25)
    this.schedule()
  }

  private schedule(): void {
    const ctx = this.ctx!
    while (this.cursorTime < ctx.currentTime + LOOKAHEAD) {
      const span = measures(this.song)[barAt(this.song, this.cursorBeat)]
      const pulse = pulseBeats(span)
      let spb = this.spbAt(this.cursorBeat)
      if (this.counting) {
        this.tick(this.cursorTime, this.counting === 1, 1)
        this.cursorTime += Math.min(pulse, span.beats - (this.counting - 1) * pulse) * spb
        this.counting = this.counting >= Math.ceil(span.beats / pulse) ? 0 : this.counting + 1
        this.anchors.push({ time: this.cursorTime, beat: this.cursorBeat, spb, count: this.counting })
        if (!this.counting) this.scheduleMedia(this.cursorBeat, this.cursorTime, true)
        continue
      }
      const loopStart = this.loop ? barStart(this.song, this.loop.startBar - 1) : 0
      const loopEnd = this.loop ? barStart(this.song, this.loop.endBar) : this.totalBeats
      if (this.cursorBeat >= loopEnd) {
        this.cursorBeat = loopStart
        this.anchors.push({ time: this.cursorTime, beat: loopStart, spb, count: 0 })
      }
      const from = this.cursorBeat
      const boundary = this.song.tempoMap?.find((point) => point.beat > from)?.beat ?? loopEnd
      const to = Math.min(from + STEP, loopEnd, boundary)
      spb = this.seconds(from, to) / (to - from)
      this.noteBoundary = this.cursorTime + this.seconds(from, loopEnd)
      this.events(from, to, this.cursorTime, spb, this.resumeNotes)
      this.noteBoundary = Infinity
      this.resumeNotes = false
      this.cursorTime += (to - from) * spb
      this.cursorBeat = to
      if (to >= loopEnd) {
        if (!this.loop) {
          const endAt = this.cursorTime
          this.endTimer = window.setTimeout(() => {
            this.halt()
            this.pausedBeat = 0
            this.onEnd?.()
          }, Math.max(0, (endAt - ctx.currentTime) * 1000))
          clearInterval(this.timer)
          this.timer = -1
          return
        }
        this.cursorBeat = loopStart
        this.resumeNotes = true
        this.counting = this.countIn ? 1 : 0
        if (this.counting && this.recording) {
          this.mediaPauseTimer = window.setTimeout(() => {
            this.mediaPauseTimer = 0
            this.recording?.media.pause()
          }, Math.max(0, (this.cursorTime - ctx.currentTime) * 1000))
        }
        if (!this.counting) this.scheduleMedia(loopStart, this.cursorTime)
      }
      this.anchors.push({ time: this.cursorTime, beat: this.cursorBeat, spb: this.spbAt(this.cursorBeat), count: this.counting })
    }
    const now = ctx.currentTime
    while (this.anchors.length > 2 && this.anchors[1].time < now) this.anchors.shift()
    const transport = this.read()
    if (!transport.countingIn && !this.mediaTimer) this.correctStemDrift(transport.beat)
  }

  private events(from: number, to: number, t0: number, spb: number, resume: boolean): void {
    const at = (beat: number) => t0 + (beat - from) * spb
    const inRange = (b: number) => b >= from && b < to
    const song = this.song
    const rhythmInputs = [song.drums, song.piano, song.vocals, song.instrumentNotes, song.beatsPerBar, song.beatUnit, song.bars, song.barMap]
    if (song !== this.rhythmSource || rhythmInputs.some((input, index) => input !== this.rhythmInputs[index])) {
      this.rhythmSource = song
      this.rhythmInputs = rhythmInputs
      this.rhythm = accompanimentRhythm(song)
    }

    const sustained = new Map(sustainedChords(song.chords).map((chord) => [chord.startBeat, chord.beats]))
    song.chords.forEach((chord, i) => {
      if (!song.tracks.some((track) => track.instrument === 'chords' && track.group !== 'creative')) return
      if (!chord.symbol || chord.symbol === 'N.C.' || !chord.tones.length) return
      const tones = this.swaps.get(i) ?? chord.tones
      if (!tones.length) return
      const endBeat = chord.startBeat + (sustained.get(chord.startBeat) ?? chord.beats)
      const attacks = chordRhythm({ startBeat: chord.startBeat, beats: endBeat - chord.startBeat }, this.rhythm)
      for (const attack of attacks) {
        const end = attack.startBeat + attack.beats
        if (inRange(attack.startBeat) || (resume && attack.startBeat < from && end > from)) {
          const start = Math.max(attack.startBeat, from)
          this.sampleNote(at(start), tones[0] - 24, this.seconds(start, end), 0.52, this.bus('chords'), 0.01, 0.7)
          this.pad(at(start), tones, this.seconds(start, end))
        }
      }
    })
    // A written sustain pedal holds a piano note until the pedal lifts; without written pedalling notes end as written.
    const sustains = (song.pedals ?? []).filter((pedal) => pedal.controller === 64)
    const released = (n: PianoNote) => {
      const end = n.startBeat + n.beats
      const pedal = sustains.find((item) => item.startBeat < end - 1e-9 && end < item.startBeat + item.beats - 1e-9)
      return pedal ? pedal.startBeat + pedal.beats : end
    }
    const note = (n: PianoNote, id: string) => {
      const end = id === 'piano' ? released(n) : n.startBeat + n.beats
      if (!inRange(n.startBeat) && !(resume && n.startBeat < from && end > from)) return
      const start = Math.max(n.startBeat, from)
      const duration = this.seconds(start, end)
      if (id === 'piano') this.piano(at(start), n, duration, n.trackId ?? song.tracks.find((track) => track.instrument === 'piano')?.id ?? 'piano')
      else this.lead(at(start), n, duration, id)
    }
    for (const n of song.piano) note(n, 'piano')
    for (const n of song.vocals ?? []) {
      if (!inRange(n.startBeat) && !(resume && n.startBeat < from && n.startBeat + n.beats > from)) continue
      const start = Math.max(n.startBeat, from)
      this.vocal(at(start), n, this.seconds(start, n.startBeat + n.beats), n.trackId ?? 'vocals')
    }
    for (const part of song.tracks) {
      if (part.instrument !== 'other') continue
      for (const n of song.instrumentNotes?.[part.id] ?? []) {
        if (!inRange(n.startBeat) && !(resume && n.startBeat < from && n.startBeat + n.beats > from)) continue
        const start = Math.max(n.startBeat, from)
        const duration = this.seconds(start, n.startBeat + n.beats)
        if (part.id === 'instrument-organ') this.organ(at(start), n.midi, duration, (n.velocity ?? 0.7) * 0.28, part.id)
        else if (part.gmProgram != null && part.gmProgram >= 0 && part.gmProgram <= 127) {
          this.gmNote(at(start), n.midi, duration, (n.velocity ?? 0.7) * 0.6, part.id, part.gmProgram)
        } else this.sampleNote(at(start), n.midi, duration,
          (n.velocity ?? 0.7) * 0.6, this.bus(part.id), 0.018, 0.7, true)
      }
    }
    for (const part of this.extras) {
      for (const n of part.notes) note(n, part.id)
    }
    for (const h of song.drums) if (inRange(h.startBeat)) this.drum(at(h.startBeat), h, h.trackId ?? song.tracks.find((track) => track.instrument === 'drums')?.id ?? 'drums')
    if (this.click) {
      const bars = measures(song)
      for (let index = barAt(song, from); index < bars.length && bars[index].startBeat < to; index++) {
        const span = bars[index]
        const pulse = pulseBeats(span)
        const end = Math.min(to, span.startBeat + span.beats)
        // A leading pickup is the end of a bar: count its pulses back from the first downbeat.
        const pickup = index === 0 && span.partial
        const phase = pickup ? ((span.beats % pulse) + pulse) % pulse : 0
        const first = span.startBeat + (phase > 1e-6 && pulse - phase > 1e-6 ? phase : 0)
        for (let number = Math.max(0, Math.ceil((from - first) / pulse - 1e-9)); ; number++) {
          const beat = first + number * pulse
          if (beat >= end) break
          this.tick(at(beat), number === 0 && !pickup, 0.6)
        }
      }
    }
  }

  /** A part's bus level: muted, the player's fader, and the lead's emphasis over the other parts. */
  level(id: string): number {
    if (this.muted.has(id)) return 0
    return (this.trackGains.get(id) ?? 1) * (this.selectedPart && id !== this.selectedPart ? BACKGROUND : 1)
  }

  private bus(id: string): GainNode {
    let bus = this.buses.get(id)
    if (!bus) {
      bus = this.ctx!.createGain()
      bus.gain.value = this.level(id)
      bus.connect(this.master!)
      this.buses.set(id, bus)
    }
    return bus
  }

  private updateMix(): void {
    if (!this.ctx) return
    for (const [id, bus] of this.buses) {
      // Muting is quick; the selection's lead glides, so changing parts while playing never clicks or restarts anything.
      bus.gain.setTargetAtTime(this.level(id), this.ctx.currentTime, this.muted.has(id) ? 0.012 : 0.04)
    }
  }

  private track<T extends AudioScheduledSourceNode>(node: T, start: number, stop: number): T {
    node.start(start)
    node.stop(stop)
    this.nodes.add(node)
    node.onended = () => {
      node.disconnect()
      this.nodes.delete(node)
      if (node instanceof AudioBufferSourceNode) this.openHats.delete(node)
    }
    return node
  }

  private nearestSample(midi: number): Sample {
    return this.pianoSamples.reduce((best, sample) =>
      Math.abs(sample.midi - midi) < Math.abs(best.midi - midi) ? sample : best)
  }

  private sampleNote(
    time: number,
    midi: number,
    duration: number,
    velocity: number,
    destination: AudioNode,
    attack = 0.006,
    release = RELEASE,
    soft = velocity < 0.56,
  ): void {
    const ctx = this.ctx!
    const sample = this.nearestSample(midi)
    const source = ctx.createBufferSource()
    source.buffer = soft ? sample.soft : sample.loud
    source.playbackRate.value = 2 ** ((midi - sample.midi) / 12)
    const gain = ctx.createGain()
    const peak = Math.max(0.0001, Math.min(1, velocity))
    const releaseAt = time + Math.max(0.04, duration)
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.linearRampToValueAtTime(peak, time + attack)
    gain.gain.setValueAtTime(peak, releaseAt)
    gain.gain.exponentialRampToValueAtTime(0.0001, releaseAt + release)
    source.connect(gain).connect(destination)
    const natural = source.buffer.duration / source.playbackRate.value
    this.track(source, time, Math.min(time + natural, releaseAt + release + 0.05, this.noteBoundary))
  }

  private organ(time: number, midi: number, duration: number, velocity: number, id: string): void {
    const ctx = this.ctx!
    const source = ctx.createOscillator()
    source.frequency.value = 440 * 2 ** ((midi - 69) / 12)
    this.organWave ??= ctx.createPeriodicWave(new Float32Array(5), new Float32Array([0, 1, 0.55, 0.24, 0.12]))
    source.setPeriodicWave(this.organWave)
    const gain = ctx.createGain()
    const end = Math.min(time + Math.max(0.04, duration), this.noteBoundary)
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.linearRampToValueAtTime(Math.max(0.0001, velocity), time + 0.025)
    gain.gain.setValueAtTime(Math.max(0.0001, velocity), end)
    gain.gain.exponentialRampToValueAtTime(0.0001, end + 0.08)
    source.connect(gain).connect(this.bus(id))
    this.track(source, time, end + 0.09)
  }

  private gmNote(time: number, midi: number, duration: number, velocity: number, id: string, program: number): void {
    const ctx = this.ctx!
    const samples = this.gmSamples.get(program)
    if (!samples?.length) throw new Error(`The GM sound bank is not ready for program ${program + 1}.`)
    const sample = samples.reduce((best, item) =>
      Math.abs(item.midi - midi) < Math.abs(best.midi - midi) ? item : best)
    const source = ctx.createBufferSource()
    source.buffer = sample.buffer
    source.playbackRate.value = 2 ** ((midi - sample.midi) / 12)
    const gain = ctx.createGain()
    const end = Math.min(time + Math.max(0.04, duration), this.noteBoundary)
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.linearRampToValueAtTime(Math.max(0.0001, velocity), time + 0.006)
    gain.gain.setValueAtTime(Math.max(0.0001, velocity), end)
    gain.gain.exponentialRampToValueAtTime(0.0001, end + 0.3)
    source.connect(gain).connect(this.bus(id))
    const natural = sample.buffer.duration / source.playbackRate.value
    this.track(source, time, Math.min(time + natural, end + 0.32, this.noteBoundary))
  }

  private piano(time: number, note: PianoNote, duration: number, id: string): void {
    const velocity = note.velocity ?? (note.hand === 'right' ? 0.78 : 0.68)
    this.sampleNote(time, note.midi, duration, velocity * 0.72, this.bus(id), 0.006, RELEASE, velocity < 0.56)
  }

  private vocal(time: number, note: MelodyNote, duration: number, id: string): void {
    const ctx = this.ctx!
    const fundamental = 440 * 2 ** ((note.midi - 69) / 12)
    const harmonics = new Float32Array(33)
    for (let h = 1; h < harmonics.length; h++) {
      const hz = h * fundamental
      if (hz >= ctx.sampleRate / 2) break
      harmonics[h] = (Math.exp(-0.5 * ((hz - 400) / 220) ** 2) +
        0.35 * Math.exp(-0.5 * ((hz - 1100) / 300) ** 2) +
        0.08 * Math.exp(-0.5 * ((hz - 2400) / 400) ** 2)) / h
    }
    const source = ctx.createOscillator()
    source.setPeriodicWave(ctx.createPeriodicWave(new Float32Array(33), harmonics))
    source.frequency.value = fundamental
    const gain = ctx.createGain()
    const peak = Math.max(0.01, Math.min(1, note.velocity ?? 0.6)) * 0.22
    gain.gain.setValueAtTime(0, time)
    gain.gain.linearRampToValueAtTime(peak, time + Math.min(0.045, duration / 2))
    gain.gain.setValueAtTime(peak, time + duration)
    gain.gain.linearRampToValueAtTime(0, time + duration + 0.1)
    source.connect(gain).connect(this.bus(id))
    this.track(source, time, Math.min(time + duration + 0.11, this.noteBoundary))
  }

  /** Creative parts use the softer piano velocity layer. */
  private lead(time: number, note: PianoNote, duration: number, id: string): void {
    this.sampleNote(time, note.midi, duration, (note.velocity ?? 0.7) * 0.6, this.bus(id), 0.018, 0.7, true)
  }

  private pad(time: number, tones: number[], duration: number): void {
    const ctx = this.ctx!
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 1500
    const bus = ctx.createStereoPanner()
    bus.pan.value = -0.22
    filter.connect(bus).connect(this.bus('chords'))
    for (const midi of tones.slice(0, 4)) {
      this.sampleNote(time, midi, duration, 0.18, filter, Math.min(0.16, duration / 2), 0.9, true)
    }
  }

  private drum(time: number, hit: DrumHit, id: string): void {
    const half = hit.articulation === 'half-open' && (hit.lane === 'hihat' || hit.lane === 'openhat')
    // An explicit half-open hat sounds the open-hat sample, cut short, on either hat lane.
    const buffer = this.drumSamples.get(half ? 'openhat' : hit.lane)
    if (!buffer) return
    const pedal = hit.lane === 'hihat' && hit.sourceMidi === 44
    if (hit.lane === 'hihat') {
      for (const open of this.openHats) {
        try {
          open.stop(time + 0.025)
        } catch {
          // Already stopped.
        }
      }
      this.openHats.clear()
    }
    const ctx = this.ctx!
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = tomRate(hit) * (pedal ? 0.85 : 1)
    const gain = ctx.createGain()
    // The pedalled hat is a soft "chick"; a half-open hat rings, but shorter than an open one.
    gain.gain.value = Math.min(1, hit.velocity * (hit.lane === 'crash' ? 0.62 : 0.82) * (pedal ? 0.5 : 1))
    source.connect(gain).connect(this.bus(id))
    if (hit.lane === 'openhat' || half) this.openHats.add(source)
    const ring = pedal ? 0.08 : half ? 0.35 : buffer.duration / source.playbackRate.value
    this.track(source, time, Math.min(time + ring + 0.02, this.noteBoundary))
  }

  private tick(time: number, accent: boolean, gain: number): void {
    const ctx = this.ctx!
    const oscillator = ctx.createOscillator()
    oscillator.type = 'square'
    oscillator.frequency.value = accent ? 1760 : 1175
    const volume = ctx.createGain()
    volume.gain.setValueAtTime(0.12 * gain, time)
    volume.gain.exponentialRampToValueAtTime(0.0001, time + 0.05)
    oscillator.connect(volume).connect(this.master!)
    this.track(oscillator, time, time + 0.07)
  }

  private recordingTime(beat: number): number {
    return recordingSeconds(this.song, beat)
  }

  private seekMedia(beat: number): void {
    const time = Math.max(0, this.recordingTime(beat))
    const media = this.recording?.media
    if (media?.hasAttribute('src')) media.currentTime = Number.isFinite(media.duration) ? Math.min(time, media.duration) : time
  }

  private scheduleMedia(beat: number, when: number, pauseNow = false): void {
    const media = this.recording?.media
    if (!media?.hasAttribute('src')) return
    clearTimeout(this.mediaTimer)
    if (pauseNow) media.pause()
    const delay = Math.max(0, (when - this.ctx!.currentTime) * 1000) +
      Math.max(0, -this.recordingTime(beat)) / this.rate * 1000
    this.mediaTimer = window.setTimeout(() => {
      this.mediaTimer = 0
      this.seekMedia(beat)
      media.playbackRate = this.rate
      const revision = this.revision
      void media.play().catch((error: unknown) => {
        if (revision !== this.revision || !media.hasAttribute('src') || !this.hasAudibleStem()) return
        this.pause()
        this.onError?.(error instanceof Error ? error.message : 'The recording could not be played.')
      })
    }, delay)
  }

  private correctStemDrift(beat: number): void {
    const media = this.recording?.media
    if (!media?.hasAttribute('src') || media.paused || media.ended) return
    const expected = this.recordingTime(beat)
    if (expected >= 0 && expected < media.duration && Math.abs(media.currentTime - expected) > 0.12) media.currentTime = expected
  }
}
