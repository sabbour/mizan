import type { DecodingErrors, Song } from '../workspace/song'
import { mockHost } from './mock'

export type Source = 'youtube' | 'midi' | 'musicxml'
export type TranscriptionModel = 'muscriptor-small' | 'muscriptor-medium' | 'muscriptor-large'
export type ProcessingMode = 'local' | 'cloud'
export type CloudProvider = 'azure' | 'gcp' | 'aws'
export type CloudProviderInfo = { id: CloudProvider; name: string }
export type AzureSubscription = { id: string; name: string; tenantId: string }
export type AzureCloudConfig = {
  provider?: 'azure'
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
export type GcpProject = { projectId: string; projectName: string; projectNumber: string; state: string }
export type AwsAccount = { accountId: string; profile: string; region: string; arn: string; userId: string | null }
type CloudAccountsById = { gcp: GcpProject; aws: AwsAccount }
export type GcpCloudSettings = {
  provider?: 'gcp'
  projectId?: string
  location?: string
  region?: string
  bucket?: string
  serviceAccount?: string
  machineType?: string
  accelerator?: string
  image?: string
  workerSourceHash?: string
  workerAuthResource?: string
}
export type AwsCloudSettings = {
  provider?: 'aws'
  profile?: string
  region?: string
  accountId?: string
  bucket?: string
  computeEnvironment?: string
  jobQueue?: string
  jobDefinition?: string
  role?: string
  subnetIds?: string[]
  securityGroupIds?: string[]
  image?: string
  sourceHash?: string
  executionRole?: string
  serviceRole?: string
  instanceRole?: string
  hfSecretArn?: string
  vpcId?: string
  routeTableId?: string
  internetGatewayId?: string
}
export type CloudConfig = AzureCloudConfig
export type CloudProviderSettings =
  | AzureCloudConfig
  | GcpCloudSettings
  | AwsCloudSettings
export type CloudProviderSettingsById = {
  azure: AzureCloudConfig
  gcp: GcpCloudSettings
  aws: AwsCloudSettings
}
export type CloudStatus = {
  provider?: CloudProvider
  providerName?: string
  available?: boolean
  configured: boolean
  mode: ProcessingMode
  config?: CloudProviderSettings
  issue?: string
  warning?: string
  runtimeVerified?: boolean
  prepared?: boolean
  jobCreated?: boolean
  requiresHfTokenConsent?: boolean
  verified?: boolean
  verifiedModels?: TranscriptionModel[]
  /** Missing means model support is unknown; an explicit list is authoritative. */
  supportedModels?: TranscriptionModel[]
  existingPilot?: boolean
  workerDigest?: string | null
  workerImage?: string | null
  loggingConfigured?: boolean
  loggingLocation?: string
}
export type FfmpegStatus = {
  configuredPath: string | null
  effectivePath: string | null
  available: boolean
  issue: string | null
}
export type CloudStatusFor<P extends CloudProvider> = Omit<CloudStatus, 'provider' | 'config'> & {
  provider?: P
  config?: CloudProviderSettingsById[P]
}
export type ProcessingModeResult = { mode: ProcessingMode } & Partial<Omit<CloudStatus, 'mode'>>
export type AzureCloudPrepared = {
  provider: 'azure'
  prepared: boolean
  configured: false
  identityPrincipalId: string
  identityClientId: string
  containerScope: string
  registryScope: string
  next: string
}
export type ProviderCloudPrepared = {
  provider: Exclude<CloudProvider, 'azure'>
  prepared: boolean
  configured: boolean
  mode?: ProcessingMode
  next?: string
}
export type CloudPrepared = AzureCloudPrepared | ProviderCloudPrepared
export type CloudPreparedFor<P extends CloudProvider> =
  P extends 'azure' ? AzureCloudPrepared : ProviderCloudPrepared & { provider: P }
export type CloudImageImportResult<P extends CloudProvider = CloudProvider> = {
  provider: P
  image: string
  digest: string
  verified: boolean
  sourceHash?: string
}
export type CloudSetupProgress = {
  operation: string | null
  stage: string
  completed: number
  total: number
  detail: string | null
}
export type CloudReadinessProgress = {
  stage: string
  detail: string | null
  elapsedSeconds: number
  timeoutSeconds: number
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
  sourceUrl?: string | null
  license?: string | null
  attribution?: string | null
  provider?: string | null
}
export type Folder = { id: string; name: string; count: number }
export type ResourceUsage = { cpu: number | null; ramBytes: number | null; gpu: null; npu: null }
export type YouTubeResult = {
  id: string
  title: string
  channel: string
  duration: number | null
  thumbnail: string
  url: string
  source: 'youtube' | 'youtube_music'
}
export type PopularChartRow = {
  videoId: string
  title: string
  artist: string
  rank?: number
  thumbnail: string
}
export type PopularShelf = {
  id: string
  title: string
  publisher: string
  sourceUrl: string
  kind: 'editorial' | 'chart'
  status: 'available' | 'unavailable'
  description: string
  chartDate: string
  rows: PopularChartRow[]
  message?: string
}
export type PopularChart = {
  title: string
  fetchedAt: string
  sections: PopularShelf[]
  warning?: string
  sample?: boolean
}
export type MidiSearchResult = {
  id: string
  provider: 'commons' | 'mutopia' | 'archive' | 'bitmidi' | 'freemidi'
  dedupeKey: string
  source: 'Wikimedia Commons' | 'Mutopia Project' | 'Internet Archive' | 'BitMidi' | 'FreeMIDI'
  title: string
  artist: string | null
  license: string
  licenseUrl: string | null
  attribution: string | null
  sourceUrl: string
}
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
  cloudProvider?: string
  cloudProviderName?: string | null
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
export type OpenedMidiFile = { name: string; dataBase64: string }
const openedMidiQueue: OpenedMidiFile[] = []
const openedMidiListeners = new Set<(file: OpenedMidiFile) => void>()

export function onMidiFileOpened(listener: (file: OpenedMidiFile) => void): () => void {
  openedMidiListeners.add(listener)
  for (const file of openedMidiQueue.splice(0)) listener(file)
  return () => openedMidiListeners.delete(listener)
}

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
    if ((data as { type?: string }).type === 'mizan-open-midi') {
      const file = data as unknown as OpenedMidiFile
      if (openedMidiListeners.size)
        for (const listener of openedMidiListeners) listener(file)
      else openedMidiQueue.push(file)
      return
    }
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
  cloudProviders: () =>
    call<{ providers: CloudProviderInfo[]; activeProvider: CloudProvider | null; issue?: string }>('cloud_providers'),
  cloudSettings: <P extends CloudProvider>(provider: P) =>
    call<{ provider: P; settings: CloudProviderSettingsById[P] }>('cloud_settings', provider),
  selectCloudProvider: (provider: CloudProvider) =>
    call<{ provider: CloudProvider; providerName: string }>('select_cloud_provider', provider),
  cloudStatus: <P extends CloudProvider = CloudProvider>(requestId?: string, provider?: P) =>
    call<CloudStatusFor<P>>('cloud_status', requestId ?? null, provider ?? null),
  cancelCloudStatus: (requestId: string, provider?: CloudProvider) =>
    call<{ cancelRequested: boolean }>('cancel_cloud_status', requestId, provider ?? null),
  cloudReadinessProgress: (requestId: string, provider?: CloudProvider) =>
    call<CloudReadinessProgress>('cloud_readiness_progress', requestId, provider ?? null),
  cloudSetupProgress: (provider?: CloudProvider) =>
    call<CloudSetupProgress>('cloud_setup_progress', provider ?? null),
  cancelCloudSetup: (provider?: CloudProvider) =>
    call<{ cancelRequested: boolean }>('cancel_cloud_setup', provider ?? null),
  cloudSubscriptions: <P extends keyof CloudAccountsById>(provider: P, profile?: string, region?: string) =>
    call<{ subscriptions: CloudAccountsById[P][] }>('list_cloud_subscriptions', provider, profile ?? null, region ?? null),
  azureSubscriptions: () => {
    if (!subscriptionsRequest)
      subscriptionsRequest = call<{ subscriptions: AzureSubscription[] }>('azure_subscriptions')
        .then((result) => result.subscriptions)
        .finally(() => { subscriptionsRequest = null })
    return subscriptionsRequest
  },
  configureCloud: <P extends CloudProvider>(config: CloudProviderSettingsById[P], provider: P) =>
    call<CloudStatusFor<P>>('configure_cloud', config, provider),
  prepareCloud: <P extends CloudProvider>(config: CloudProviderSettingsById[P], consent: boolean, provider: P) =>
    call<CloudPreparedFor<P>>('prepare_cloud', config, consent, provider),
  enableCloudLogging: (consent: boolean, provider?: CloudProvider) =>
    call<{ workspaceId: string; customerId: string; location: string }>(
      'enable_cloud_logging', consent, provider ?? null),
  buildCloudWorker: (provider?: CloudProvider) =>
    call<{ provider: CloudProvider; image: string; digest: string }>(
      'build_cloud_worker', provider ?? null),
  importCloudImage: <P extends CloudProvider>(sourceImage: string, provider: P) =>
    call<CloudImageImportResult<P>>('import_cloud_image', sourceImage, provider),
  finishCloud: <P extends CloudProvider>(image: string, useSavedToken: boolean, provider: P) =>
    call<CloudStatusFor<P> & { next?: string }>('finish_cloud', image, useSavedToken, provider),
  setProcessingMode: async (mode: ProcessingMode, provider?: CloudProvider) =>
    (await call<ProcessingModeResult>('set_processing_mode', mode, provider ?? null)).mode,
  setProcessingModeWithStatus: (mode: ProcessingMode, provider?: CloudProvider) =>
    call<ProcessingModeResult>('set_processing_mode', mode, provider ?? null),
  clearCloud: (provider?: CloudProvider) => call<CloudStatus>('clear_cloud', provider ?? null),
  modelDownloadStatus: () => call<{ models: ModelDownloads }>('model_download_status').then((r) => r.models),
  modelPreflight: () => call<{ models: ModelPreflight }>('model_preflight').then((r) => r.models),
  startModelDownload: (model: TranscriptionModel) =>
    call('start_model_download', model),
  getTranscriptionModel: () => call<{ model: TranscriptionModel }>('get_transcription_model').then((r) => r.model),
  setTranscriptionModel: (model: TranscriptionModel) =>
    call<{ model: TranscriptionModel }>('set_transcription_model', model).then((r) => r.model),
  ffmpegStatus: () => call<FfmpegStatus>('ffmpeg_status'),
  setFfmpegPath: (path: string) => call<FfmpegStatus>('set_ffmpeg_path', path),
  browseFfmpegPath: () => call<{ path: string | null }>('browse_ffmpeg_path'),
  hfTokenStatus: () => call<{ configured: boolean }>('hf_token_status').then((r) => r.configured),
  setHfToken: (token: string) => call<{ configured: boolean }>('set_hf_token', token).then((r) => r.configured),
  clearHfToken: () => call<{ configured: boolean }>('clear_hf_token').then((r) => r.configured),
  searchYouTube: (query: string) =>
    call<{ results: YouTubeResult[] }>('search_youtube', query).then((r) => r.results),
  searchYouTubeMusic: (query: string) =>
    call<{ results: YouTubeResult[] }>('search_youtube_music', query).then((r) => r.results),
  popularSongs: (refresh = false) => call<PopularChart>('popular_songs', refresh),
  searchMidiCommons: (query: string) =>
    call<{ results: MidiSearchResult[] }>('search_midi_commons', query).then((r) => r.results),
  searchMidiMutopia: (query: string, startAt = 0) =>
    call<{ results: MidiSearchResult[]; nextStart: number | null }>('search_midi_mutopia', query, startAt),
  searchMidiArchive: (query: string) =>
    call<{ results: MidiSearchResult[] }>('search_midi_archive', query).then((r) => r.results),
  searchMidiBitMidi: (query: string) =>
    call<{ results: MidiSearchResult[] }>('search_midi_bitmidi', query).then((r) => r.results),
  searchMidiFreeMidi: (query: string) =>
    call<{ results: MidiSearchResult[] }>('search_midi_freemidi', query).then((r) => r.results),
  importMidiResult: (resultId: string, allowUnknownLicense = false) =>
    call<{ entry: Entry }>('import_midi_result', resultId, allowUnknownLicense).then((r) => r.entry),
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
