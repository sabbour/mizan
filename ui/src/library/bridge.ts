import type { DecodingErrors, Song } from '../workspace/song'
import { mockHost } from './mock'

export type Source = 'youtube' | 'midi' | 'musicxml'
export type TranscriptionModel = 'muscriptor-small' | 'muscriptor-medium' | 'muscriptor-large'
export type ProcessingMode = 'local' | 'cloud'
export type AzureSubscription = { id: string; name: string; tenantId: string }
export type CloudConfig = {
  tenantId: string
  subscriptionId: string
  resourceGroup: string
  storageAccount: string
  container: string
  jobName: string
  location: string
  registry: string
  vnet: string
  subnet: string
  vnetCidr: string
  subnetCidr: string
  subnetResourceId?: string
  environment: string
  identity: string
  existingPilot?: boolean
  resumePartial?: boolean
}
export type CloudStatus = {
  available?: boolean
  configured: boolean
  mode: ProcessingMode
  config?: CloudConfig
  issue?: string
  warning?: string
  runtimeVerified?: boolean
  prepared?: boolean
  jobCreated?: boolean
  requiresHfTokenConsent?: boolean
  verified?: boolean
  verifiedModels?: TranscriptionModel[]
  supportedModels?: TranscriptionModel[]
  existingPilot?: boolean
  workerDigest?: string | null
  workerImage?: string | null
  loggingConfigured?: boolean
  loggingLocation?: string
}
export type CloudPrepared = {
  prepared: boolean
  configured: false
  identityPrincipalId: string
  identityClientId: string
  containerScope: string
  registryScope: string
  next: string
}
export type CloudSetupProgress = {
  operation: string | null
  stage: string
  completed: number
  total: number
  detail: string | null
}
export type ModelDownload = {
  downloaded: boolean
  active: boolean
  bytesReceived: number
  totalBytes: number
  bytesPerSecond: number | null
  error: string | null
}
export type ModelDownloads = Record<TranscriptionModel, ModelDownload>
export type ModelPreflight = Record<TranscriptionModel, {
  eligible: boolean
  reason: string | null
  requiredRamGiB: number
  freeRamGiB: number
  requiredCommitGiB: number
  freeCommitGiB: number
}>
export type Position = {
  bar: number
  loop: { startBar: number; endBar: number } | null
  loopName?: string | null
  rate: number
  trackId: string
  muted: string[]
  solo: string[]
}
export type Entry = {
  id: string
  title: string
  artist: string | null
  thumbnail: string | null
  source: Source
  parts: string[]
  recording: boolean
  duration: number | null
  createdAt: string
  practicedAt: string | null
  position: Position | null
  folders: string[]
  outdated: boolean
  transcriptionModel: TranscriptionModel | null
  separationMethod: string | null
}
export type Folder = { id: string; name: string; count: number }
export type ResourceUsage = { cpu: number | null; ramBytes: number | null; gpu: null; npu: null }
export type YouTubeResult = { id: string; title: string; channel: string; duration: number | null; thumbnail: string; url: string }
export type Stage = 'inspect' | 'download' | 'decode' | 'detect' | 'separate' | 'transcribe' | 'chords' | 'notation' | 'align' | 'finalize'
export type QueueJob = {
  id: string
  kind: 'transcribe' | 'align'
  songId: string | null
  url: string
  title: string | null
  thumbnail: string | null
  status: 'queued' | 'running' | 'failed' | 'cancelled' | 'done'
  stage: Stage
  progress: number
  order: number
  processingMode?: 'local' | 'cloud'
  errorCode: string | null
  errorMessage: string | null
  fix: string | null
  warnings: string[]
  decodingErrors?: DecodingErrors | null
  detected: { piano: number; drums: number; vocals?: number } | null
  instrument?: 'auto' | 'piano' | 'drums'
  transcriptionModel?: TranscriptionModel
  selectedInstruments?: ('piano' | 'drums' | 'vocals')[] | null
  transcribedInstruments?: string[] | null
  transcriptionQuality?: Partial<Record<'piano' | 'drums' | 'vocals', {
    status: 'usable' | 'tentative' | 'empty'
    scoreWithheld?: boolean
    confidence: 'low' | 'medium'
    eventCount: number
    meanEventConfidence: number
    stemRms: number
    stemLevel: number
    rhythmicConsistency: number | null
    reasons: string[]
  }>> | null
  stages: { name: Stage; seconds: number | null; provider: string | null; method: string | null; timingNote?: string | null; estimate?: number | null; model?: string | null }[]
  createdAt: string
  updatedAt: string
  // Live detail for the job panel; older hosts omit these.
  attemptQueuedAt?: string | null
  elapsedSeconds?: number | null
  cloudElapsedSeconds?: number | null
  finishedAt?: string | null
  duration?: number | null
  stageProgress?: number | null
  stageMessage?: string | null
  startedAt?: string | null
  stageStartedAt?: string | null
  eta?: { seconds: number; low: number; high: number } | null
  found?: Found | null
}
export type Found = {
  key?: string | null
  tempo?: number | null
  chords?: { time: number; label: string }[]
  stems?: Partial<Record<'mix' | 'piano' | 'drums', string>>
}
export type Stem = { id: 'mix'|'vocals'|'piano'|'guitar'|'bass'|'drums'|'other'; label: string; url: string; level: number }
export type Opened = { entry: Entry; song: Song; artifacts: Record<string, string>; stems?: Stem[] }

type Fail = { ok: false; error: { code: string; message: string; fix?: string } }
type Reply<T> = ({ ok: true } & T) | Fail

export class HostError extends Error {
  readonly code: string
  readonly fix: string | null
  constructor(e: Fail['error']) {
    super(e.message)
    this.code = e.code
    this.fix = e.fix ?? null
  }
}

type Api = Record<string, (...args: unknown[]) => Promise<unknown>>
type WebViewReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: Fail['error'] }
declare global {
  interface Window {
    __mizanNativeShell?: boolean
    pywebview?: { api: Api }
    chrome?: {
      webview?: {
        postMessage(message: unknown): void
        addEventListener(type: 'message', listener: (event: MessageEvent<WebViewReply>) => void): void
      }
    }
  }
}

const webviewApi = (): Api | null => {
  const webview = window.chrome?.webview
  if (!window.__mizanNativeShell || !webview) return null
  let nextId = 0
  const pending = new Map<number, { resolve(value: unknown): void; reject(reason: unknown): void }>()
  webview.addEventListener('message', ({ data }) => {
    const request = pending.get(data.id)
    if (!request) return
    pending.delete(data.id)
    if (data.ok) request.resolve(data.result)
    else request.reject(new HostError({ ok: false, error: data.error }.error))
  })
  return new Proxy({} as Api, {
    get: (_, method: string | symbol) => {
      if (method === 'then' || typeof method === 'symbol') return undefined
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          const id = ++nextId
          pending.set(id, { resolve, reject })
          webview.postMessage({ id, method, args })
        })
    },
  })
}

// Native WebView2 is immediate; pywebview injects shortly after load; browsers use the mock.
const ready: Promise<Api> = new Promise((resolve) => {
  const native = webviewApi()
  if (native) return resolve(native)
  if (window.pywebview?.api) return resolve(window.pywebview.api)
  const fallback = setTimeout(() => resolve(mockHost as unknown as Api), 400)
  window.addEventListener('pywebviewready', () => {
    clearTimeout(fallback)
    resolve(window.pywebview!.api)
  })
})

async function call<T = object>(name: string, ...args: unknown[]): Promise<T> {
  const api = await ready
  if (window.__mizanNativeShell && api === (mockHost as unknown as Api))
    throw new HostError({ code: 'host_unavailable', message: 'Mizan host is unavailable. Restart the app.' })
  const reply = (await api[name](...args)) as Reply<T>
  if (!reply.ok) throw new HostError(reply.error)
  return reply as T
}

let subscriptionsRequest: Promise<AzureSubscription[]> | null = null

export const host = {
  cloudStatus: (requestId?: string) => call<CloudStatus>('cloud_status', requestId ?? null),
  cancelCloudStatus: (requestId: string) =>
    call<{ cancelRequested: boolean }>('cancel_cloud_status', requestId),
  cloudSetupProgress: () => call<CloudSetupProgress>('cloud_setup_progress'),
  cancelCloudSetup: () => call<{ cancelRequested: boolean }>('cancel_cloud_setup'),
  azureSubscriptions: () => {
    if (!subscriptionsRequest)
      subscriptionsRequest = call<{ subscriptions: AzureSubscription[] }>('azure_subscriptions')
        .then((result) => result.subscriptions)
        .finally(() => { subscriptionsRequest = null })
    return subscriptionsRequest
  },
  configureCloud: (config: CloudConfig) => call<CloudStatus>('configure_cloud', config),
  prepareCloud: (config: CloudConfig, consent: boolean) =>
    call<CloudPrepared>('prepare_cloud', config, consent),
  enableCloudLogging: (consent: boolean) =>
    call<{ workspaceId: string; customerId: string; location: string }>('enable_cloud_logging', consent),
  buildCloudWorker: () =>
    call<{ image: string; digest: string }>('build_cloud_worker'),
  finishCloud: (image: string, useSavedToken: boolean) =>
    call<CloudStatus & { next: string }>('finish_cloud', image, useSavedToken),
  setProcessingMode: (mode: ProcessingMode) =>
    call<{ mode: ProcessingMode }>('set_processing_mode', mode).then((r) => r.mode),
  clearCloud: () => call<CloudStatus>('clear_cloud'),
  modelDownloadStatus: () => call<{ models: ModelDownloads }>('model_download_status').then((r) => r.models),
  modelPreflight: () => call<{ models: ModelPreflight }>('model_preflight').then((r) => r.models),
  startModelDownload: (model: TranscriptionModel) =>
    call('start_model_download', model),
  getTranscriptionModel: () => call<{ model: TranscriptionModel }>('get_transcription_model').then((r) => r.model),
  setTranscriptionModel: (model: TranscriptionModel) =>
    call<{ model: TranscriptionModel }>('set_transcription_model', model).then((r) => r.model),
  hfTokenStatus: () => call<{ configured: boolean }>('hf_token_status').then((r) => r.configured),
  setHfToken: (token: string) => call<{ configured: boolean }>('set_hf_token', token).then((r) => r.configured),
  clearHfToken: () => call<{ configured: boolean }>('clear_hf_token').then((r) => r.configured),
  searchYouTube: (query: string) => call<{ results: YouTubeResult[] }>('search_youtube', query).then((r) => r.results),
  addLink: (url: string) => call<{ job: QueueJob }>('add_link', url).then((r) => r.job),
  importFile: (name: string, dataBase64: string) => call<{ entry: Entry }>('import_file', name, dataBase64).then((r) => r.entry),
  library: () => call<{ entries: Entry[] }>('list_library').then((r) => r.entries),
  folders: () => call<{ folders: Folder[] }>('list_folders').then((r) => r.folders),
  createFolder: (name: string) => call<{ folder: Folder }>('create_folder', name).then((r) => r.folder),
  renameFolder: (id: string, name: string) => call<{ folder: Folder }>('rename_folder', id, name).then((r) => r.folder),
  deleteFolder: (id: string) => call('delete_folder', id),
  setSongFolders: (songId: string, folderIds: string[]) => call('set_song_folders', songId, folderIds),
  queue: () => call<{ jobs: QueueJob[] }>('list_queue').then((r) => r.jobs),
  resourceUsage: () => call<{ usage: ResourceUsage | null }>('resource_usage').then((r) => r.usage),
  job: (id: string) => call<{ job: QueueJob }>('get_job', id).then((r) => r.job),
  jobLog: (id: string) => call<{ lines: string[] }>('get_job_log', id).then((r) => r.lines),
  cancel: (id: string) => call('cancel_job', id),
  retry: (id: string) => call('retry_job', id),
  move: (id: string, order: number) => call('move_job', id, order),
  dismiss: (id: string) => call('dismiss_job', id),
  open: (id: string) => call<Opened>('open_song', id),
  savePosition: (id: string, position: Position) => call('save_position', id, position),
  remove: (id: string) => call('delete_song', id),
  deleteScoreTrack: (songId: string, trackId: string) =>
    call<Opened>('delete_score_track', songId, trackId),
  reprocess: (id: string) => call<{ job: QueueJob }>('reprocess_song', id).then((r) => r.job),
  linkRecording: (id: string, url: string) => call<{ job: QueueJob }>('link_recording', id, url).then((r) => r.job),
  setTiming: (id: string, timing: { offset: number; tempoScale: number }) =>
    call<{ entry: Entry }>('set_timing', id, timing).then((r) => r.entry),
}

export const IMPORTABLE = /\.(mid|midi|musicxml|xml|mxl)$/i

export function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
