import type { Stem } from '../library/bridge'

/** One media clock preserves pitch without letting isolated stems drift apart. */
export class Recording {
  readonly media = new Audio()
  private buffers = new Map<string, Promise<AudioBuffer>>()
  private key = ''
  private url: string | null = null
  private revision = 0
  private gain: GainNode
  private ctx: AudioContext
  private stems: Stem[]

  constructor(ctx: AudioContext, stems: Stem[], destination: AudioNode) {
    this.ctx = ctx
    this.stems = stems
    this.media.preload = 'auto'
    this.media.crossOrigin = 'anonymous'
    this.media.preservesPitch = true
    this.gain = ctx.createGain()
    ctx.createMediaElementSource(this.media).connect(this.gain).connect(destination)
  }

  private active(muted: ReadonlySet<string>, volumes: ReadonlyMap<string, number>) {
    return this.stems
      .filter((stem) => !muted.has(`stem:${stem.id}`) && (volumes.get(`stem:${stem.id}`) ?? 1) > 0)
      .map((stem) => ({ stem, volume: volumes.get(`stem:${stem.id}`) ?? 1 }))
  }

  signature(muted: ReadonlySet<string>, volumes: ReadonlyMap<string, number>): string {
    return JSON.stringify(this.active(muted, volumes).map(({ stem, volume }) => [stem.id, volume]))
  }

  get readyKey(): string {
    return this.key
  }

  adjustVolume(muted: ReadonlySet<string>, volumes: ReadonlyMap<string, number>): boolean {
    const active = this.active(muted, volumes)
    if (!this.key || active.length !== 1 || this.media.getAttribute('src') !== active[0].stem.url) return false
    this.gain.gain.setTargetAtTime(active[0].volume, this.ctx.currentTime, 0.012)
    this.key = this.signature(muted, volumes)
    return true
  }

  private async decode(stem: Stem): Promise<AudioBuffer> {
    let pending = this.buffers.get(stem.url)
    if (!pending) {
      pending = (async () => {
        const response = await fetch(stem.url)
        if (!response.ok) throw new Error(`Could not load ${stem.label} (${response.status}).`)
        return this.ctx.decodeAudioData(await response.arrayBuffer())
      })()
      this.buffers.set(stem.url, pending)
      pending.catch(() => this.buffers.delete(stem.url))
    }
    return pending
  }

  async prepare(muted: ReadonlySet<string>, volumes: ReadonlyMap<string, number>): Promise<void> {
    const key = this.signature(muted, volumes)
    const revision = ++this.revision
    if (key === this.key) return
    const active = this.active(muted, volumes)
    let url: string | null = null
    let level = active[0]?.volume ?? 0
    if (active.length > 1) {
      const buffers = await Promise.all(active.map(({ stem }) => this.decode(stem)))
      if (revision !== this.revision) return
      const length = Math.max(...buffers.map((buffer) => buffer.length))
      const render = new OfflineAudioContext(2, length, this.ctx.sampleRate)
      // Keep headroom in the PCM file; restore the user's levels on the output gain.
      level = active.reduce((sum, { volume }) => sum + volume, 0)
      buffers.forEach((buffer, index) => {
        const source = render.createBufferSource()
        source.buffer = buffer
        const gain = render.createGain()
        gain.gain.value = active[index].volume / level
        source.connect(gain).connect(render.destination)
        source.start(0)
      })
      const mix = await render.startRendering()
      if (revision !== this.revision) return
      url = URL.createObjectURL(wave(mix))
    }
    if (revision !== this.revision) return
    this.media.pause()
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = url
    this.key = ''
    this.gain.gain.value = level
    if (!active.length) {
      this.media.removeAttribute('src')
      this.media.load()
    } else {
      this.media.src = url ?? active[0].stem.url
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout)
          this.media.removeEventListener('canplay', ready)
          this.media.removeEventListener('error', failed)
          this.media.removeEventListener('emptied', cancelled)
        }
        const ready = () => { cleanup(); resolve() }
        const failed = () => { cleanup(); reject(new Error('The recording could not be decoded or loaded.')) }
        const cancelled = () => { if (revision !== this.revision) { cleanup(); resolve() } }
        const timeout = window.setTimeout(() => {
          cleanup()
          reject(new Error('The recording took too long to load. Try playing again.'))
        }, 30000)
        this.media.addEventListener('canplay', ready)
        this.media.addEventListener('error', failed)
        this.media.addEventListener('emptied', cancelled)
        this.media.load()
      })
    }
    if (revision === this.revision) this.key = key
  }

  dispose(): void {
    this.revision++
    this.media.pause()
    this.media.removeAttribute('src')
    this.media.load()
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = null
    this.buffers.clear()
  }
}

function wave(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels
  const bytes = new ArrayBuffer(44 + buffer.length * channels * 2)
  const view = new DataView(bytes)
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, bytes.byteLength - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, bytes.byteLength - 44, true)
  const data = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel))
  for (let frame = 0; frame < buffer.length; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, data[channel][frame]))
      view.setInt16(44 + (frame * channels + channel) * 2, Math.round(sample * 32767), true)
    }
  }
  return new Blob([bytes], { type: 'audio/wav' })
}
