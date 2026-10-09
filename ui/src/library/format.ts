import type { Entry, Position, QueueJob, Stage } from './bridge'

export const STAGE_LABEL: Record<Stage, string> = {
  inspect: 'Reading video details',
  download: 'Downloading audio',
  decode: 'Decoding audio',
  detect: 'Preparing audio and notes',
  separate: 'Saving separated audio',
  transcribe: 'Transcribing notes',
  chords: 'Finding chords',
  notation: 'Writing the score',
  align: 'Lining up with the recording',
  finalize: 'Finishing',
}

const MODEL_LABEL: Record<string, string> = {
  'htdemucs-6s-fp16weights': 'HT-Demucs (six stems)',
  'beat-this-final0': 'Beat This! + chroma chords',
  'youtube-metadata': 'YouTube metadata',
  'yt-dlp': 'yt-dlp downloader',
  ffmpeg: 'FFmpeg decoder',
  'stem-rms-priority-v2': 'Stem loudness',
  'voice-leading-v2+mido': 'Score and MIDI generation',
}

const PROVIDER_LABEL: Record<string, string> = {
  CPUExecutionProvider: 'CPU',
  'CPU-DSP': 'CPU (audio analysis)',
  CPU: 'CPU',
  DmlExecutionProvider: 'GPU (DirectML)',
  QNNExecutionProvider: 'NPU (QNN)',
  CUDAExecutionProvider: 'GPU (CUDA)',
  'PyTorch CUDA': 'GPU (PyTorch CUDA)',
  'PyTorch CPU': 'CPU (PyTorch)',
}

export function stageModelLabel(stage: QueueJob['stages'][number]): string {
  const raw = stage.model ?? stage.method
  if (!raw) return '—'
  const name = MODEL_LABEL[raw] ?? raw
  return name
}

export function stageProviderLabel(provider: string | null): string {
  return provider?.split(',').map((name) => PROVIDER_LABEL[name.trim()] ?? name.trim()).join(' + ') || '—'
}

export function resumeParts(p: Position | null): string[] {
  if (!p) return ['Not started']
  const parts = [`Last at bar ${p.bar}`]
  if (p.loop) parts.push(p.loopName ? `${p.loopName} loop` : `Bars ${p.loop.startBar}–${p.loop.endBar} loop`)
  if (p.rate < 1) parts.push(`${Math.round(p.rate * 100)}%`)
  return parts
}

export function sourceLine(e: Entry): string {
  if (e.source === 'youtube') return 'YouTube'
  const file = e.source === 'midi' ? 'MIDI file' : 'MusicXML file'
  return e.recording ? `${file} · linked recording` : `${file} · no recording`
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
export function ago(iso: string): string {
  const s = (new Date(iso).getTime() - Date.now()) / 1000
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [['second', 60], ['minute', 60], ['hour', 24], ['day', 7], ['week', 4.35], ['month', 12], ['year', Infinity]]
  let v = s
  for (const [unit, size] of steps) {
    if (Math.abs(v) < size) return unit === 'second' ? 'just now' : rtf.format(Math.round(v), unit)
    v /= size
  }
  return ''
}

export function clock(seconds: number | null): string {
  if (seconds == null) return ''
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// "About 3 min", "8–12 min", "40 s": rough on purpose, because estimates are.
export function roughly(seconds: number, low = seconds, high = seconds): string {
  if (high < 50) return `${Math.max(5, Math.round(seconds / 5) * 5)} s`
  const min = (s: number) => Math.max(1, Math.round(s / 60))
  if (seconds > 150 && high / Math.max(low, 1) > 1.4 && min(high) > min(low)) return `${min(low)}–${min(high)} min`
  return `about ${min(seconds)} min`
}

export function took(seconds: number): string {
  return seconds < 90 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`
}

export const jobTitle = (j: QueueJob) => j.title ?? j.url.replace(/^https?:\/\/(www\.)?/, '')

export function jobExecutionLabel(job: QueueJob): string {
  if (job.kind === 'align') return 'Local · Recording alignment'
  const size = job.transcriptionModel?.replace('muscriptor-', '')
  return `${job.processingMode === 'cloud' ? 'Cloud' : 'Local'}${size ? ` · MuScriptor ${size[0].toUpperCase()}${size.slice(1)}` : ''}`
}

export function jobQueuePosition(job: QueueJob, jobs: QueueJob[]) {
  const ahead = jobs.filter((other) => other.id !== job.id && (
    other.status === 'running' || other.status === 'queued' && other.order < job.order))
  const place = ahead.filter((other) => other.status === 'queued').length + 1
  return { ahead, place }
}

export function jobQueueLabel(job: QueueJob, jobs: QueueJob[]): string {
  const { ahead, place } = jobQueuePosition(job, jobs)
  return place > 1 ? `Waiting · ${place} in line`
    : ahead.length ? 'Next after current job' : 'Next up'
}

export function jobStagePercent(job: QueueJob): number | null {
  const progress = job.status === 'running' ? job.stageProgress : null
  return typeof progress === 'number' && Number.isFinite(progress) && progress >= 0 && progress <= 1
    ? Math.round(progress * 100) : null
}

export function jobStageLabel(job: QueueJob): string {
  return job.status !== 'queued' && job.status !== 'done' && job.stageMessage
    ? job.stageMessage : STAGE_LABEL[job.stage]
}

export type JobStageState = 'now' | 'done' | 'failed' | 'cancelled' | 'not-run' | 'queued' | 'todo'

export function jobStageState(job: QueueJob, stage: Stage): JobStageState {
  if (job.status === 'running' && stage === job.stage) return 'now'
  if (job.status === 'failed' && stage === job.stage) return 'failed'
  if (job.status === 'cancelled' && stage === job.stage) return 'cancelled'
  if (job.status === 'done') return 'done'
  const stageIndex = job.stages.findIndex((item) => item.name === stage)
  const currentIndex = job.stages.findIndex((item) => item.name === job.stage)
  if (job.status === 'running' && currentIndex >= 0 && stageIndex >= 0 && stageIndex < currentIndex) return 'done'
  if (job.stages.find((item) => item.name === stage)?.seconds != null) return 'done'
  if (job.status === 'queued') return 'queued'
  if (job.status === 'failed' || job.status === 'cancelled') return 'not-run'
  return 'todo'
}

export const activeAnalysis = (jobs: QueueJob[], songId: string) =>
  jobs.find((job) => job.kind === 'transcribe' && job.songId === songId && (job.status === 'running' || job.status === 'queued'))

export function analysisProgress(job: QueueJob): string {
  if (job.status === 'queued') return 'Updating analysis · queued'
  const percent = jobStagePercent(job)
  return `Updating analysis · ${jobStageLabel(job)}${percent == null ? '' : ` · ${percent}% step`}`
}

export function decodingErrorHeadline(count: number | null | undefined): string | null {
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) return null
  return `Best-effort transcription · ${count} decoding error${count === 1 ? '' : 's'}`
}

export function instrumentStatus(job: QueueJob, instrument: 'piano' | 'drums' | 'vocals'): string {
  const result = job.transcriptionQuality?.[instrument]
  if (result) {
    if (result.scoreWithheld) return 'score withheld; insufficient instrument evidence'
    if (result.status === 'empty') return 'attempted; no events recovered'
    return result.status === 'tentative' ? 'transcribed; tentative / low confidence' : 'transcribed; draft'
  }
  if (job.transcribedInstruments?.includes(instrument)) return 'transcribed; quality pending'
  if (job.selectedInstruments && !job.selectedInstruments.includes(instrument)) {
    if (instrument === 'vocals' && job.instrument === 'auto')
      return 'no dedicated vocal score'
    return 'not requested'
  }
  if (!job.selectedInstruments) return 'status unavailable'
  if (job.status === 'cancelled' || job.status === 'failed') return 'attempt interrupted'
  if (job.status === 'done') return 'quality unavailable'
  return job.stage === 'transcribe' ? 'transcribing' : 'selected; waiting'
}
