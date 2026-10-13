import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowUp, AudioLines, ChevronDown, ChevronLeft, ChevronRight, Ellipsis, ExternalLink, FileMusic, FolderOpen, FolderPlus, GripVertical, Info, Link2, Play, Plus, RotateCcw, Search, Settings2, Trash2, X } from 'lucide-react'
import { host, HostError, IMPORTABLE, onMidiFileOpened, toBase64, type CloudProvider, type CloudProviderInfo, type CloudReadinessProgress, type CloudStatus, type Entry, type FfmpegStatus, type Folder, type MidiSearchResult, type ModelDownloads, type ModelPreflight, type PopularChart, type ProcessingMode, type QueueJob, type ResourceUsage, type TranscriptionModel, type YouTubeResult } from './bridge'
import { foldSearchText } from './searchText'
import { CloudSetup } from './CloudSetup'
import { createCloudOperationGate } from './cloudOperation'
import { activeAnalysis, analysisProgress, ago, clock, decodingErrorHeadline, jobExecutionLabel, jobQueueLabel, jobQueuePosition, jobTitle, jobStageLabel, jobStagePercent, resumeParts, sourceLine, took } from './format'
import { CourseSection } from '../course/Course'
import type { CourseBrowse } from '../course/browse'
import { LESSONS } from '../course/curriculum'
import { PIANO_LESSONS } from '../course/piano'
import { FRETTED_LESSONS } from '../course/fretted'
import { PIANO_INSPIRED } from '../course/pianoInspired'
import './library.css'

type Problem = { message: string; fix: string | null }
type SettingsSection = 'audio' | 'models' | 'cloud'
type GettingStartedStep = 'welcome' | 'audio' | 'access' | 'model'
type MidiOffer =
  | { name: string; file: File; result?: never; dataBase64?: never; permissionConfirmed?: boolean }
  | { name: string; dataBase64: string; result?: never; file?: never; permissionConfirmed?: boolean }
  | { name: string; result: MidiSearchResult; file?: never; dataBase64?: never; permissionConfirmed?: boolean }
const problem = (e: unknown): Problem =>
  e instanceof HostError ? { message: e.message, fix: e.fix } : { message: 'Something went wrong talking to Mizan.', fix: 'Try again.' }

type Props = {
  jobs: QueueJob[]
  version: number
  onQueueChange: () => void
  onOpen: (entry: Entry) => void
  /** Opens a built-in drum or piano lesson. */
  onLesson: (id: string) => void
  /** Where the Course tab is (instrument, drum list, genre); held by the app, not stored. */
  courseBrowse: CourseBrowse
  onCourseBrowse: (value: CourseBrowse) => void
  /** Songs or Course; held by the app so it survives opening a song or lesson. */
  tab: LibraryTab
  onTab: (tab: LibraryTab) => void
  onDetails: (job: QueueJob) => void
  selectedJob?: string
  onCredits: () => void
}

type LibraryFolder = { id: string; name: string; count: number; user?: boolean }
const DAY = 86_400_000
const DEFAULT_CLOUD_PROVIDERS: CloudProviderInfo[] = [
  { id: 'azure', name: 'Azure' },
  { id: 'gcp', name: 'Google Cloud' },
  { id: 'aws', name: 'AWS' },
]
const CLOUD_PROVIDER_NAMES: Record<CloudProvider, string> = {
  azure: 'Azure',
  gcp: 'Google Cloud',
  aws: 'AWS',
}
const isCloudProvider = (value: string): value is CloudProvider =>
  DEFAULT_CLOUD_PROVIDERS.some(({ id }) => id === value)
const modelChoices: { id: TranscriptionModel; label: string; detail: string; info: string }[] = [
  { id: 'muscriptor-small', label: 'MuScriptor Small', detail: 'The smallest multi-instrument model, with the lowest memory needs.', info: '103M parameters · 412 MB download' },
  { id: 'muscriptor-medium', label: 'MuScriptor Medium', detail: 'A middle-sized multi-instrument model. Processing time depends on your hardware and the song.', info: '307M parameters · 1.23 GB download' },
  { id: 'muscriptor-large', label: 'MuScriptor Large', detail: 'The largest multi-instrument model; requires the most memory and disk space.', info: '1.4B parameters · 5.47 GB download' },
]
const GETTING_STARTED_KEY = 'mizan:getting-started:seen'
const hasSeenGettingStarted = () => {
  try { return window.localStorage?.getItem(GETTING_STARTED_KEY) === 'true' } catch (error) {
    console.warn('The getting-started preference could not be read.', error)
    return false
  }
}
const markGettingStartedSeen = () => {
  try { window.localStorage?.setItem(GETTING_STARTED_KEY, 'true') } catch (error) {
    console.warn('The getting-started preference could not be saved.', error)
  }
}
const formatBytes = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(2)} GB` : `${Math.round(value / 1e6)} MB`
const smartFolders = (entries: Entry[]): LibraryFolder[] => [
  { id: 'all', name: 'All songs', count: entries.length },
  { id: 'progress', name: 'In progress', count: entries.filter((entry) => entry.position).length },
  { id: 'piano', name: 'Piano', count: entries.filter((entry) => entry.parts.some((part) => /piano/i.test(part))).length },
  { id: 'drums', name: 'Drums', count: entries.filter((entry) => entry.parts.some((part) => /drum/i.test(part))).length },
  { id: 'imported', name: 'Imported', count: entries.filter((entry) => entry.source !== 'youtube').length },
  { id: 'youtube', name: 'YouTube', count: entries.filter((entry) => entry.source === 'youtube').length },
  { id: 'recent', name: 'Recently added', count: entries.filter((entry) => Date.now() - Date.parse(entry.createdAt) <= 14 * DAY).length },
].filter((folder) => folder.id === 'all' || folder.count)

function inFolder(entry: Entry, id: string) {
  if (id === 'all') return true
  if (id === 'progress') return !!entry.position
  if (id === 'piano') return entry.parts.some((part) => /piano/i.test(part))
  if (id === 'drums') return entry.parts.some((part) => /drum/i.test(part))
  if (id === 'imported') return entry.source !== 'youtube'
  if (id === 'youtube') return entry.source === 'youtube'
  if (id === 'recent') return Date.now() - Date.parse(entry.createdAt) <= 14 * DAY
  return entry.folders.includes(id)
}

export type LibraryTab = 'discover' | 'catalog' | 'course'
const TABS: { id: LibraryTab; label: string }[] = [
  { id: 'discover', label: 'Discover' },
  { id: 'catalog', label: 'Local song catalog' },
  { id: 'course', label: 'Course' },
]

export function Library({ jobs, version, onQueueChange, onOpen, onLesson, courseBrowse, onCourseBrowse, onDetails, selectedJob, onCredits, tab, onTab: setTab }: Props) {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [selectedFolder, setSelectedFolder] = useState('all')
  const [query, setQueryValue] = useState('')
  // Search results and imported songs belong to the local catalog.
  const setQuery = (next: string) => {
    setQueryValue(next)
    if (next.trim() && tab !== 'catalog') setTab('catalog')
  }
  const [error, setError] = useState<Problem | null>(null)
  const [folderFeedback, setFolderFeedback] = useState<{ message: string; error: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [midiOffers, setMidiOffers] = useState<MidiOffer[]>([])
  const [midiOfferError, setMidiOfferError] = useState<Problem | null>(null)
  const midiDialog = useRef<HTMLDialogElement>(null)
  const midiOfferReturnFocus = useRef<HTMLElement | null>(null)
  const [pendingLinks, setPendingLinks] = useState<string[]>([])
  const pendingLinkRequests = useRef(new Set<string>())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('audio')
  const [gettingStartedStep, setGettingStartedStep] = useState<GettingStartedStep | null>(null)
  const [cloud, setCloud] = useState<CloudStatus | null>(null)
  const [processingChoice, setProcessingChoice] = useState<ProcessingMode | null>(null)
  const [cloudProviderSelection, setCloudProviderSelection] = useState<{
    providers: CloudProviderInfo[]
    activeProvider: CloudProvider | null
  } | null>(null)
  const [cloudProvidersLoading, setCloudProvidersLoading] = useState(false)
  const [cloudStatusChecking, setCloudStatusChecking] = useState(false)
  const [cloudReadinessProgress, setCloudReadinessProgress] = useState<CloudReadinessProgress | null>(null)
  const [cloudOperationBusy, setCloudOperationBusy] = useState(false)
  const [cloudOperationLabel, setCloudOperationLabel] = useState<string | null>(null)
  const [cloudError, setCloudError] = useState<string | null>(null)
  const [cloudWizardOpen, setCloudWizardOpen] = useState(false)
  const [cloudOperationGate] = useState(createCloudOperationGate)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [model, setModel] = useState<TranscriptionModel | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [modelBusy, setModelBusy] = useState(false)
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null)
  const [ffmpegPathDraft, setFfmpegPathDraft] = useState('')
  const [ffmpegLoading, setFfmpegLoading] = useState(true)
  const [ffmpegBusy, setFfmpegBusy] = useState(false)
  const [ffmpegBrowsing, setFfmpegBrowsing] = useState(false)
  const [ffmpegError, setFfmpegError] = useState<string | null>(null)
  const [ffmpegLoadError, setFfmpegLoadError] = useState<string | null>(null)
  const [downloads, setDownloads] = useState<ModelDownloads | null>(null)
  const [preflight, setPreflight] = useState<ModelPreflight | null>(null)
  const [preflightError, setPreflightError] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<{ model: TranscriptionModel; message: string } | null>(null)
  const [downloadStatusError, setDownloadStatusError] = useState<string | null>(null)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [accessOpen, setAccessOpen] = useState<boolean | null>(null)
  const [hfConfigured, setHfConfigured] = useState<boolean | null>(null)
  const [tokenDraft, setTokenDraft] = useState('')
  const [hfError, setHfError] = useState<string | null>(null)
  const [hfBusy, setHfBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  // WinUI WebView2 cancels HTML drag sources; internal moves use pointer capture.
  const [songDrag, setSongDrag] = useState<{ songId: string; x: number; y: number; folderId: string | null } | null>(null)
  const songPointer = useRef<{ id: number; songId: string; x: number; y: number; moved: boolean } | null>(null)
  const suppressSongClick = useRef(false)
  const libraryRoot = useRef<HTMLDivElement>(null)
  const intake = useRef<HTMLElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const settingsButton = useRef<HTMLButtonElement>(null)
  const settingsDialog = useRef<HTMLDialogElement>(null)
  const settingsHeading = useRef<HTMLHeadingElement>(null)
  const cloudSetupButton = useRef<HTMLButtonElement>(null)
  const guideDismissed = useRef(false)
  const cloudWizardOpenRef = useRef(false)
  const cloudStatusCheckRef = useRef<symbol | null>(null)
  const cloudStatusLastCheckRef = useRef<symbol | null>(null)
  const cloudStatusCancelRef = useRef<(() => void) | null>(null)
  const aboutButton = useRef<HTMLButtonElement>(null)
  const aboutDialog = useRef<HTMLDialogElement>(null)
  const songs = useRef<HTMLElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const midiOffer = midiOffers[0] ?? null
  const isLink = /^https?:\/\//i.test(query.trim())
  const searchQuery = isLink ? '' : query
  const selectedCloudProvider = cloudProviderSelection?.activeProvider ?? 'azure'
  const cloudProviderOptions = cloudProviderSelection?.providers ?? DEFAULT_CLOUD_PROVIDERS
  const cloudModelSupportKnown = Array.isArray(cloud?.supportedModels)
  const cloudProviderName = cloud?.providerName
    ?? cloudProviderOptions.find(({ id }) => id === selectedCloudProvider)?.name
    ?? CLOUD_PROVIDER_NAMES[selectedCloudProvider]
  const cloudStatusText = cloudProvidersLoading
    ? 'Loading cloud providers…'
    : cloudStatusChecking
    ? cloudReadinessProgress?.detail
      ? `${cloudReadinessProgress.detail} (${cloudReadinessProgress.elapsedSeconds}s)`
      : `Checking ${cloudProviderName} setup…`
    : cloudOperationBusy ? cloudOperationLabel ?? 'Updating settings…'
      : cloudError ? `${cloudProviderName} access check failed`
        : cloud === null ? 'Cloud status unavailable'
          : cloud.configured
            ? cloud.mode === 'cloud' ? 'Cloud is on for new and redone analyses' : `${cloudProviderName} is ready · Processing is Local`
            : cloud.mode === 'cloud' ? cloud.jobCreated
              ? cloud.issue && !cloud.issue.includes('readiness has not been checked')
                ? `Cloud selected · ${cloudProviderName} access check failed; no Local fallback`
                : `Cloud selected · ${cloudProviderName} readiness is not verified; no Local fallback`
              : `Cloud selected · ${cloudProviderName} setup is not complete; no Local fallback`
              : cloud.jobCreated ? `GPU Job created · ${cloudProviderName} access needs checking`
              : cloud.prepared ? `${cloudProviderName} infrastructure prepared · setup not complete`
                : cloud.config ? `${cloudProviderName} settings saved · setup not complete` : 'Cloud is not set up'
  const cloudSetupConfirmedAbsent = cloud !== null
    && typeof cloud.available === 'boolean'
    && cloud.prepared === false
    && cloud.jobCreated === false
    && cloud.config === undefined
    && cloud.workerImage === null
  const cloudSetupCanContinue = cloud !== null && !cloud.configured
    && cloud.jobCreated === false
    && (cloud.config !== undefined || cloud.prepared === true || cloud.workerImage != null)
  const cloudActionText = cloudOperationBusy ? 'Working…'
    : cloudError || cloud === null ? 'Retry check'
      : cloud.configured ? `Review ${cloudProviderName} setup`
        : cloudSetupConfirmedAbsent ? `Set up ${cloudProviderName}`
          : cloudSetupCanContinue ? `Continue ${cloudProviderName} setup` : `Check ${cloudProviderName} access`

  const reload = useCallback(
    () => Promise.all([host.library(), host.folders()]).then(
      ([nextEntries, nextFolders]) => {
        setEntries(nextEntries)
        setFolders(nextFolders)
        setSelectedFolder((current) => current === 'all' || nextFolders.some((folder) => folder.id === current) || smartFolders(nextEntries).some((folder) => folder.id === current) ? current : 'all')
      },
      (e) => setError(problem(e)),
    ),
    [],
  )
  useEffect(() => void reload(), [reload, version])
  useEffect(() => {
    if (aboutOpen) aboutDialog.current?.showModal()
  }, [aboutOpen])
  useEffect(() => {
    if (!settingsOpen) return
    const button = settingsButton.current
    settingsDialog.current?.showModal()
    return () => button?.focus()
  }, [settingsOpen])
  useEffect(() => {
    if (settingsOpen) settingsHeading.current?.focus()
  }, [settingsOpen, gettingStartedStep])
  useEffect(() => {
    if (!cloudWizardOpen) return
    const button = cloudSetupButton.current
    return () => button?.focus()
  }, [cloudWizardOpen])
  const acquireCloudOperation = useCallback((label = 'Updating Cloud setup…') => {
    const release = cloudOperationGate.acquire()
    if (!release) return null
    setCloudOperationBusy(true)
    setCloudOperationLabel(label)
    return () => {
      release()
      if (!cloudOperationGate.isLocked()) {
        setCloudOperationBusy(false)
        setCloudOperationLabel(null)
      }
    }
  }, [cloudOperationGate])
  const checkCloudStatus = useCallback((provider: CloudProvider) => {
    const providerName = CLOUD_PROVIDER_NAMES[provider]
    const release = acquireCloudOperation(`Checking ${providerName} setup…`)
    if (!release) return null
    const token = Symbol()
    const requestId = crypto.randomUUID()
    cloudStatusCheckRef.current = token
    cloudStatusLastCheckRef.current = token
    let active = true
    setCloudStatusChecking(true)
    setCloudReadinessProgress(null)
    setCloudError(null)
    let progressPending = false
    const progressTimer = window.setInterval(() => {
      if (progressPending) return
      progressPending = true
      void host.cloudReadinessProgress(requestId, provider).then(
        (progress) => {
          if (active && cloudStatusCheckRef.current === token) setCloudReadinessProgress(progress)
        },
        (reason) => {
          if (active && cloudStatusCheckRef.current === token)
            setCloudError(`${providerName}: ${problem(reason).message}`)
        },
      ).finally(() => { progressPending = false })
    }, 500)
    const cancel = () => {
      active = false
      window.clearInterval(progressTimer)
      if (cloudStatusCheckRef.current === token) {
        cloudStatusCheckRef.current = null
        cloudStatusCancelRef.current = null
        setCloudStatusChecking(false)
        setCloudReadinessProgress(null)
        void host.cancelCloudStatus(requestId, provider).catch((reason) => {
          if (cloudStatusLastCheckRef.current === token)
            setCloudError(`${providerName}: ${problem(reason).message}`)
        })
      }
      release()
    }
    cloudStatusCancelRef.current = cancel
    void host.cloudStatus(requestId, provider).then(
      (status) => {
        if (active && cloudStatusCheckRef.current === token) {
          setCloud(status)
          setCloudError(null)
        }
      },
      (reason) => {
        if (active && cloudStatusCheckRef.current === token)
          setCloudError(`${providerName}: ${problem(reason).message}`)
      },
    ).finally(() => {
      window.clearInterval(progressTimer)
      if (active && cloudStatusCheckRef.current === token) {
        cloudStatusCheckRef.current = null
        cloudStatusCancelRef.current = null
        setCloudStatusChecking(false)
        setCloudReadinessProgress(null)
      }
      release()
    })
    return cancel
  }, [acquireCloudOperation])
  useEffect(() => {
    if (!settingsOpen) return
    let active = true
    let cancel: (() => void) | null = null
    setCloud(null)
    setCloudError(null)
    setCloudProvidersLoading(true)
    void host.cloudProviders().then(
      (selection) => {
        if (!active) return
        setCloudProviderSelection(selection)
        setCloudProvidersLoading(false)
        if (selection.activeProvider) cancel = checkCloudStatus(selection.activeProvider)
        else setCloudError(selection.issue ?? 'Choose a supported cloud provider.')
      },
      (reason) => {
        if (!active) return
        setCloudProvidersLoading(false)
        setCloudError(problem(reason).message)
      },
    )
    return () => {
      active = false
      cancel?.()
    }
  }, [settingsOpen, checkCloudStatus])
  useEffect(() => {
    if (!settingsOpen) return
    let active = true
    void host.ffmpegStatus().then(
      (status) => {
        if (!active) return
        setFfmpeg(status)
        setFfmpegPathDraft(status.configuredPath ?? status.effectivePath ?? '')
        setFfmpegError(null)
        setFfmpegLoadError(null)
        setFfmpegLoading(false)
      },
      (reason) => {
        if (!active) return
        setFfmpegLoadError(problem(reason).message)
        setFfmpegLoading(false)
      },
    )
    void host.getTranscriptionModel().then(
      (selected) => { if (active) { setModel(selected); setModelError(null) } },
      (reason) => { if (active) { setModel(null); setModelError(problem(reason).message) } },
    )
    void host.hfTokenStatus().then(
      (configured) => { if (active) { setHfConfigured(configured); setHfError(null) } },
      (reason) => { if (active) { setHfConfigured(null); setHfError(problem(reason).message) } },
    )
    return () => { active = false }
  }, [settingsOpen])
  useEffect(() => {
    if (!settingsOpen || cloud?.mode === 'cloud') return
    let active = true
    const refresh = () => void host.modelPreflight().then(
      (models) => { if (active) { setPreflight(models); setPreflightError(null) } },
      (reason) => { if (active) { setPreflight(null); setPreflightError(problem(reason).message) } },
    )
    refresh()
    const timer = window.setInterval(refresh, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [settingsOpen, cloud?.mode])
  useEffect(() => {
    if (!settingsOpen || cloud?.mode === 'cloud') return
    let active = true
    const refresh = () => void host.modelDownloadStatus().then(
      (statuses) => { if (active) { setDownloads(statuses); setDownloadStatusError(null) } },
      (reason) => { if (active) setDownloadStatusError(problem(reason).message) },
    )
    refresh()
    const timer = window.setInterval(refresh, 1000)
    return () => { active = false; window.clearInterval(timer) }
  }, [settingsOpen, cloud?.mode])

  const cancelSongDrag = useCallback(() => {
    const pointer = songPointer.current
    songPointer.current = null
    if (pointer && libraryRoot.current?.hasPointerCapture(pointer.id)) libraryRoot.current.releasePointerCapture(pointer.id)
    setSongDrag(null)
  }, [])

  useEffect(() => {
    const element = intake.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      libraryRoot.current?.style.setProperty('--intake-height', `${element.getBoundingClientRect().height}px`)
    })
    observer.observe(element)
    window.addEventListener('blur', cancelSongDrag)
    return () => {
      observer.disconnect()
      window.removeEventListener('blur', cancelSongDrag)
    }
  }, [cancelSongDrag])

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (aboutOpen || cloudWizardOpen) return
      if (event.key === 'Escape' && settingsOpen) {
        event.preventDefault()
        if (gettingStartedStep) { markGettingStartedSeen(); guideDismissed.current = true }
        setGettingStartedStep(null)
        setSettingsOpen(false)
        setTokenDraft('')
        return
      }
      if (event.key === 'Escape' && songPointer.current) {
        event.preventDefault()
        cancelSongDrag()
        return
      }
      const target = event.target as HTMLElement
      const editing = target.matches('input, textarea, [contenteditable="true"]')
      if ((event.ctrlKey && event.key.toLowerCase() === 'k') || (event.key === '/' && !editing)) {
        event.preventDefault()
        field.current?.focus()
      } else if (event.key === 'Escape' && query && !event.defaultPrevented && !selectedJob) {
        event.preventDefault()
        setQuery('')
      }
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [query, selectedJob, cancelSongDrag, settingsOpen, aboutOpen, cloudWizardOpen, gettingStartedStep])

  const chooseModel = async (selected: TranscriptionModel) => {
    const release = acquireCloudOperation('Saving analysis settings…')
    if (!release) return
    setModelBusy(true)
    setModelError(null)
    setDownloadError(null)
    try {
      setModel(await host.setTranscriptionModel(selected))
    } catch (reason) {
      setModelError(problem(reason).message)
    } finally {
      setModelBusy(false)
      release()
      if (cloud?.mode !== 'cloud')
        void host.modelPreflight().then(setPreflight, (reason) => setPreflightError(problem(reason).message))
    }
  }
  const ffmpegActionBusy = ffmpegBusy || ffmpegBrowsing
  const saveFfmpegPath = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (ffmpegLoading || ffmpegActionBusy) return
    setFfmpegBusy(true)
    setFfmpegError(null)
    setFfmpegLoadError(null)
    try {
      const status = await host.setFfmpegPath(ffmpegPathDraft)
      setFfmpeg(status)
      setFfmpegPathDraft(status.configuredPath ?? status.effectivePath ?? '')
    } catch (reason) {
      setFfmpegError(problem(reason).message)
    } finally {
      setFfmpegBusy(false)
    }
  }
  const browseFfmpegPath = async () => {
    if (ffmpegLoading || ffmpegActionBusy) return
    setFfmpegBrowsing(true)
    setFfmpegError(null)
    try {
      const result = await host.browseFfmpegPath()
      if (result.path !== null) setFfmpegPathDraft(result.path)
    } catch (reason) {
      setFfmpegError(problem(reason).message)
    } finally {
      setFfmpegBrowsing(false)
    }
  }
  const retryFfmpegStatus = async () => {
    setFfmpegLoading(true)
    setFfmpegLoadError(null)
    try {
      const status = await host.ffmpegStatus()
      setFfmpeg(status)
      setFfmpegPathDraft(status.configuredPath ?? status.effectivePath ?? '')
      setFfmpegError(null)
    } catch (reason) {
      setFfmpegLoadError(problem(reason).message)
    } finally {
      setFfmpegLoading(false)
    }
  }
  const openGettingStarted = () => {
    if (!settingsOpen) setFfmpegLoading(true)
    setSettingsSection('audio')
    setGettingStartedStep('welcome')
    setSettingsOpen(true)
  }
  const dismissGettingStarted = () => {
    markGettingStartedSeen()
    guideDismissed.current = true
    setGettingStartedStep(null)
    setSettingsOpen(false)
    setTokenDraft('')
  }
  const practiceNow = () => {
    markGettingStartedSeen()
    guideDismissed.current = true
    setGettingStartedStep(null)
    setSettingsOpen(false)
    setTokenDraft('')
    setTab('course')
  }
  const importMusicFile = () => {
    markGettingStartedSeen()
    guideDismissed.current = true
    setGettingStartedStep(null)
    setSettingsOpen(false)
    setTokenDraft('')
    picker.current?.click()
  }
  const continueWithAudio = () => {
    setGettingStartedStep('access')
    setSettingsSection('models')
  }
  const continueWithAccount = () => setGettingStartedStep('model')
  const modelReady = model !== null && !modelBusy && cloud !== null && !cloudStatusChecking && !cloudError
    && (cloud.mode === 'cloud'
      ? cloud.configured === true && cloudModelSupportKnown && cloud.supportedModels?.includes(model) === true
      : !downloadStatusError && !preflightError && downloads?.[model]?.downloaded === true && preflight?.[model]?.eligible === true)
  const audioReady = !ffmpegLoading && !ffmpegBusy && !ffmpegLoadError && ffmpeg?.available === true
  const accountReady = !hfBusy && (hfConfigured === true || cloud?.jobCreated === true
    || model !== null && downloads?.[model]?.downloaded === true)
  const setupReady = audioReady && modelReady
  const findSong = () => {
    markGettingStartedSeen()
    guideDismissed.current = true
    setGettingStartedStep(null)
    setSettingsOpen(false)
    setTokenDraft('')
    setTab('catalog')
    window.setTimeout(() => field.current?.focus(), 0)
  }
  const resetFfmpegPath = async () => {
    if (ffmpegLoading || ffmpegActionBusy) return
    setFfmpegBusy(true)
    setFfmpegError(null)
    setFfmpegLoadError(null)
    try {
      const status = await host.setFfmpegPath('')
      setFfmpeg(status)
      setFfmpegPathDraft(status.configuredPath ?? status.effectivePath ?? '')
    } catch (reason) {
      setFfmpegError(problem(reason).message)
    } finally {
      setFfmpegBusy(false)
    }
  }
  const openCloudWizard = () => {
    if (cloudOperationGate.isLocked() || cloudWizardOpenRef.current) return
    if (gettingStartedStep) {
      markGettingStartedSeen()
      setGettingStartedStep(null)
    }
    cloudWizardOpenRef.current = true
    setCloudWizardOpen(true)
  }
  const closeCloudWizard = () => {
    cloudWizardOpenRef.current = false
    setCloudWizardOpen(false)
  }
  const chooseMode = async (mode: ProcessingMode) => {
    const readinessCancelled = cloudStatusChecking
    if (readinessCancelled) cloudStatusCancelRef.current?.()
    if (cloudOperationGate.isLocked()) return
    setProcessingChoice(mode)
    if (mode === 'cloud' && (cloud?.available === false || cloudSetupConfirmedAbsent || cloudSetupCanContinue)) {
      setCloudError(null)
      return
    }
    const release = acquireCloudOperation('Changing processing mode…')
    if (!release) return
    setCloudError(null)
    try {
      const selected = await host.setProcessingModeWithStatus(mode, selectedCloudProvider)
      setCloud((current) => ({
        ...(current ?? { configured: false }),
        ...selected,
        ...(readinessCancelled ? { configured: false } : {}),
        mode: selected.mode,
      }))
    } catch (reason) {
      setProcessingChoice(null)
      setCloudError(problem(reason).message)
    } finally {
      release()
    }
  }
  const chooseCloudProvider = async (provider: CloudProvider) => {
    if (provider === cloudProviderSelection?.activeProvider) return
    if (cloudStatusChecking) cloudStatusCancelRef.current?.()
    if (cloudOperationGate.isLocked()) return
    const release = acquireCloudOperation(`Selecting ${CLOUD_PROVIDER_NAMES[provider]}…`)
    if (!release) return
    setCloudError(null)
    let selected: CloudProvider | null = null
    try {
      const result = await host.selectCloudProvider(provider)
      selected = result.provider
      setCloudProviderSelection((current) => current
        ? { ...current, activeProvider: result.provider } : current)
      setCloud(null)
    } catch (reason) {
      setCloudError(`${CLOUD_PROVIDER_NAMES[provider]}: ${problem(reason).message}`)
    } finally {
      release()
    }
    if (selected) void checkCloudStatus(selected)
  }
  const disconnectCloud = async () => {
    if (cloudOperationGate.isLocked() || !window.confirm(
      `Disconnect ${cloudProviderName} from Mizan?\n\nMizan will forget its saved ${cloudProviderName} setup and use Local processing for new songs. ${cloudProviderName} resources and running jobs will not be deleted or stopped, so charges may continue. Your saved Hugging Face token will remain in Windows Credential Manager.`,
    )) return
    const release = acquireCloudOperation(`Disconnecting ${cloudProviderName} from Mizan…`)
    if (!release) return
    setCloudError(null)
    try {
      setCloud(await host.clearCloud(selectedCloudProvider))
      setProcessingChoice('local')
    } catch (reason) {
      setCloudError(problem(reason).message)
    } finally {
      release()
    }
  }
  const downloadModel = async (selected: TranscriptionModel) => {
    setDownloadBusy(true)
    setDownloadError(null)
    try {
      await host.startModelDownload(selected)
      setDownloads(await host.modelDownloadStatus())
    } catch (reason) {
      setDownloadError({ model: selected, message: problem(reason).message })
      setAccessOpen(true)
    } finally {
      setDownloadBusy(false)
    }
  }

  const assignSong = (songId: string, folderId: string) => {
    const entry = entries?.find((item) => item.id === songId)
    const folder = folders.find((item) => item.id === folderId)
    if (!entry || !folder) {
      setFolderFeedback({ message: 'The song or folder is no longer available. Refresh the library.', error: true })
    } else if (entry.folders.includes(folderId)) {
      setFolderFeedback({ message: `${entry.title} is already in ${folder.name}.`, error: false })
    } else {
      void host.setSongFolders(songId, [...entry.folders, folderId]).then(
        async () => {
          await reload()
          setFolderFeedback({ message: `Added ${entry.title} to ${folder.name}.`, error: false })
        },
        (reason) => setFolderFeedback({ message: problem(reason).message, error: true }),
      )
    }
  }

  const folderAt = (x: number, y: number) =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>('.folder-item')

  const addLink = useCallback(
    async (url: string) => {
      const submitted = url.trim()
      if (pendingLinkRequests.current.has(submitted)) return
      pendingLinkRequests.current.add(submitted)
      setPendingLinks([...pendingLinkRequests.current])
      setError(null)
      const enteredLink = field.current?.value.trim() === submitted
      field.current?.focus()
      try {
        await host.addLink(submitted)
        if (enteredLink) setQueryValue((current) => current.trim() === submitted ? '' : current)
        onQueueChange()
      } catch (e) {
        setError(problem(e))
      } finally {
        pendingLinkRequests.current.delete(submitted)
        setPendingLinks([...pendingLinkRequests.current])
      }
    },
    [onQueueChange],
  )

  const importFiles = useCallback(
    async (files: File[]) => {
      setError(null)
      const bad = files.find((f) => !IMPORTABLE.test(f.name))
      if (bad) return setError({ message: `Mizan can't read “${bad.name}”.`, fix: 'Drop a YouTube link, a MIDI file (.mid), or a MusicXML file (.musicxml, .mxl).' })
      const midiFiles = files.filter((file) => /\.(mid|midi)$/i.test(file.name))
      if (midiFiles.length) {
        setMidiOfferError(null)
        setMidiOffers((current) => [...current, ...midiFiles.map((file) => ({ name: file.name, file }))])
      }
      const scoreFiles = files.filter((file) => !/\.(mid|midi)$/i.test(file.name))
      if (!scoreFiles.length) return
      setBusy(true)
      try {
        let last: Entry | null = null
        for (const f of scoreFiles) last = await host.importFile(f.name, await toBase64(f))
        await reload()
        if (scoreFiles.length === 1 && files.length === 1 && last) onOpen(last)
      } catch (e) {
        setError(problem(e))
      } finally {
        setBusy(false)
      }
    },
    [reload, onOpen],
  )

  const restoreMidiImportFocus = () => {
    const previous = midiOfferReturnFocus.current
    const target = previous?.isConnected && !(previous instanceof HTMLInputElement && previous.type === 'file')
      ? previous
      : field.current
    target?.focus()
  }

  const confirmMidiImport = async () => {
    if (!midiOffer) return
    const needsPermission = midiOffer.result?.provider === 'bitmidi' || midiOffer.result?.provider === 'freemidi'
    if (needsPermission && midiOffer.permissionConfirmed !== true) return
    setBusy(true)
    setMidiOfferError(null)
    try {
      const entry = midiOffer.result
        ? await host.importMidiResult(midiOffer.result.id, midiOffer.permissionConfirmed === true)
        : await host.importFile(midiOffer.name, midiOffer.dataBase64 ?? await toBase64(midiOffer.file!))
      setMidiOffers((current) => current.slice(1))
      await reload()
      if (midiOffers.length === 1) onOpen(entry)
    } catch (reason) {
      setMidiOfferError(problem(reason))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const dialog = midiDialog.current
    if (midiOffer && dialog && !dialog.open) {
      midiOfferReturnFocus.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : field.current
      dialog.showModal()
    }
    else if (!midiOffer && dialog?.open) dialog.close()
    return () => { if (dialog && !dialog.isConnected) restoreMidiImportFocus() }
  }, [midiOffer])

  useEffect(() => onMidiFileOpened((file) => {
    if (!file || typeof file.name !== 'string' || !/\.(mid|midi)$/i.test(file.name)
        || typeof file.dataBase64 !== 'string') return
    setTab('catalog')
    setMidiOfferError(null)
    setMidiOffers((current) => [...current, { name: file.name, dataBase64: file.dataBase64 }])
  }), [setTab])
  useEffect(() => {
    if (entries === null || entries.length || jobs.length || folders.length || tab !== 'catalog'
      || midiOffer || selectedJob || aboutOpen || cloudWizardOpen || settingsOpen || busy
      || error || query.trim() || pendingLinks.length || guideDismissed.current || hasSeenGettingStarted()) return
    const timer = window.setTimeout(() => {
      if (document.hasFocus?.() === false) return
      setGettingStartedStep('welcome')
      setSettingsOpen(true)
    }, 900)
    return () => window.clearTimeout(timer)
  }, [entries, jobs.length, folders.length, tab, midiOffer, selectedJob, aboutOpen, cloudWizardOpen,
    settingsOpen, busy, error, query, pendingLinks.length])
  useEffect(() => {
    if (!gettingStartedStep) return
    if (midiOffer || tab !== 'catalog' || aboutOpen || cloudWizardOpen) {
      markGettingStartedSeen()
      guideDismissed.current = true
      setGettingStartedStep(null)
      setSettingsOpen(false)
      setTokenDraft('')
    }
  }, [gettingStartedStep, midiOffer, tab, aboutOpen, cloudWizardOpen])

  // The whole window takes drops and pasted links.
  useEffect(() => {
    let depth = 0
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files') && !e.dataTransfer?.types.includes('text/uri-list')) return
      depth++
      setDragging(true)
    }
    const leave = () => {
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const over = (e: DragEvent) => e.preventDefault()
    const drop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      if (e.dataTransfer?.types.includes('application/x-mizan-song')) {
        const target = e.target instanceof Element ? e.target.closest('.folder-item') : null
        setFolderFeedback({ message: target ? 'Automatic categories cannot hold songs. Drop onto a folder under Folders.' : 'Drop the song onto a folder under Folders.', error: true })
        return
      }
      const files = [...(e.dataTransfer?.files ?? [])]
      const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain')
      if (files.length) void importFiles(files)
      else if (text) void addLink(text)
    }
    const paste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return
      const text = e.clipboardData?.getData('text/plain')
      if (text && /^https?:\/\//.test(text.trim())) void addLink(text)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    window.addEventListener('paste', paste)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
      window.removeEventListener('paste', paste)
    }
  }, [addLink, importFiles])

  const smart = useMemo(() => smartFolders(entries ?? []), [entries])
  const allFolders = useMemo(() => [...smart, ...folders.map((folder) => ({ ...folder, user: true }))], [smart, folders])
  const folderEntries = useMemo(() => (entries ?? []).filter((entry) => inFolder(entry, selectedFolder)), [entries, selectedFolder])
  const shown = useMemo(() => {
    const q = foldSearchText(searchQuery.trim())
    return folderEntries.filter((entry) => {
      const names = folders.filter((folder) => entry.folders.includes(folder.id)).map((folder) => folder.name)
      const source = entry.source === 'youtube' ? 'youtube' : entry.source === 'midi' ? 'midi imported' : 'musicxml imported'
      return !q || [entry.title, entry.artist, ...entry.parts, source, ...names]
        .some((value) => value && foldSearchText(value).includes(q))
    })
  }, [folderEntries, folders, searchQuery])

  const empty = tab === 'catalog' && entries !== null && entries.length === 0 && jobs.length === 0 && folders.length === 0 && !searchQuery
  const queueJobs = jobs.filter((job) => job.status !== 'done' || !entries?.some((entry) => entry.id === job.songId))
  const currentFolder = allFolders.find((folder) => folder.id === selectedFolder) ?? allFolders[0]
  const draggedEntry = entries?.find((entry) => entry.id === songDrag?.songId)
  const dragFolder = folders.find((folder) => folder.id === songDrag?.folderId)

  return (
    <div
      ref={libraryRoot}
      className={`lib${empty ? ' lib-empty' : ''}${settingsOpen ? ' lib-settings-open' : ''}`}
      data-panel={selectedJob ? '' : undefined}
      data-song-dragging={songDrag ? '' : undefined}
      onPointerDown={(event) => {
        suppressSongClick.current = false
        if (!event.isPrimary || event.button !== 0 || !(event.target instanceof Element)) return
        const handle = event.target.closest('.song-grip, .song-open')
        if (!handle || (event.pointerType === 'touch' && !handle.matches('.song-grip'))) return
        const row = handle.closest<HTMLElement>('.song')
        const songId = row?.dataset.songId
        if (!songId || row?.dataset.confirm) return
        songPointer.current = { id: event.pointerId, songId, x: event.clientX, y: event.clientY, moved: false }
      }}
      onPointerMove={(event) => {
        const pointer = songPointer.current
        if (!pointer || pointer.id !== event.pointerId) return
        if (!pointer.moved && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 6) return
        pointer.moved = true
        suppressSongClick.current = true
        event.currentTarget.setPointerCapture(event.pointerId)
        event.preventDefault()
        setSongDrag({
          songId: pointer.songId, x: event.clientX, y: event.clientY,
          folderId: folderAt(event.clientX, event.clientY)?.dataset.folderId ?? null,
        })
      }}
      onPointerUp={(event) => {
        const pointer = songPointer.current
        if (!pointer || pointer.id !== event.pointerId) return
        const target = folderAt(event.clientX, event.clientY)
        cancelSongDrag()
        if (!pointer.moved) return
        event.preventDefault()
        const folderId = target?.dataset.folderId
        if (folderId && target.dataset.user) {
          assignSong(pointer.songId, folderId)
        } else {
          setFolderFeedback({
            message: target ? 'Automatic categories cannot hold songs. Drop onto a folder under Folders.' : 'Drop the song onto a folder under Folders.',
            error: true,
          })
        }
      }}
      onPointerCancel={cancelSongDrag}
      onLostPointerCapture={cancelSongDrag}
      onClickCapture={(event) => {
        if (!suppressSongClick.current || event.detail === 0) return
        event.preventDefault()
        event.stopPropagation()
        suppressSongClick.current = false
      }}
    >
      <header className="lib-head">
        <p className="lib-mark">
          <img src="/mizan-wordmark.svg" alt="Mizan, ميزان" width="138" height="28" />
          <span className="lib-version" title="Mizan app version">
            {import.meta.env.VITE_MIZAN_VERSION ? `v${import.meta.env.VITE_MIZAN_VERSION}` : 'dev'}
          </span>
        </p>
        <div className="lib-head-actions">
          <button ref={settingsButton} type="button" className="lib-credits" aria-label="Song analysis settings"
            aria-expanded={settingsOpen} aria-controls="model-settings"
            onClick={() => {
              setFfmpegLoading(true)
              setTokenDraft('')
              setHfError(null)
              if (settingsOpen && gettingStartedStep) {
                markGettingStartedSeen()
                setGettingStartedStep(null)
              } else if (!settingsOpen) {
                setProcessingChoice(null)
                setSettingsSection('audio')
                setGettingStartedStep(null)
              }
              setSettingsOpen((open) => !open)
            }}>
            <Settings2 size={16} aria-hidden /> Song analysis
          </button>
          <button ref={aboutButton} type="button" className="lib-credits lib-about" aria-label="About Mizan"
            onClick={() => {
              if (gettingStartedStep) markGettingStartedSeen()
              setGettingStartedStep(null)
              setSettingsOpen(false)
              setTokenDraft('')
              setAboutOpen(true)
            }}>
            <Info size={16} aria-hidden /> <span>About</span>
          </button>
        </div>
        {settingsOpen && (
          <dialog ref={settingsDialog} id="model-settings" className="model-settings" aria-labelledby="model-settings-title"
            onClose={dismissGettingStarted}
            onClick={(event) => { if (event.target === event.currentTarget) dismissGettingStarted() }}>
            <div className="model-settings-head">
              <h2 ref={settingsHeading} tabIndex={-1} id="model-settings-title">{gettingStartedStep ? 'Getting started' : 'Song analysis settings'}</h2>
              {!gettingStartedStep && <button type="button" className="model-settings-guide" onClick={openGettingStarted}>
                Getting started guide
              </button>}
              <button type="button" className="model-settings-close" aria-label="Close song analysis settings"
                onClick={() => {
                  if (gettingStartedStep) markGettingStartedSeen()
                  if (gettingStartedStep) guideDismissed.current = true
                  setGettingStartedStep(null)
                  setSettingsOpen(false)
                  setTokenDraft('')
                }}>
                <X size={18} aria-hidden />
              </button>
            </div>
            {!gettingStartedStep && <p className="model-settings-intro">These choices apply to new analysis. Saved songs and running jobs stay unchanged.</p>}
            {gettingStartedStep === 'welcome' ? (
              <div className="getting-started-welcome">
                <p>Try a lesson or import a score now. Set up song analysis only when you need it.</p>
                <button type="button" className="btn btn-primary" onClick={practiceNow}>Practice with the Course</button>
                <button type="button" className="btn" onClick={importMusicFile}>Import a MIDI or MusicXML file</button>
                <button type="button" className="btn" onClick={() => {
                  setGettingStartedStep('audio')
                  setSettingsSection('audio')
                }}>Set up song analysis</button>
                <button type="button" className="model-settings-skip" onClick={dismissGettingStarted}>Not now</button>
              </div>
            ) : gettingStartedStep ? (
              <div className="getting-started-progress" aria-live="polite">
                <span>Step {gettingStartedStep === 'audio' ? 1 : gettingStartedStep === 'access' ? 2 : 3} of 3</span>
                <strong>{gettingStartedStep === 'audio' ? 'Audio support' : gettingStartedStep === 'access' ? 'Account and model terms' : 'Choose and prepare a model'}</strong>
                <progress max={3} value={gettingStartedStep === 'audio' ? 1 : gettingStartedStep === 'access' ? 2 : 3} />
              </div>
            ) : (
              <nav className="model-settings-sections" aria-label="Song analysis settings sections">
                <button type="button" aria-current={settingsSection === 'audio' ? 'page' : undefined}
                  onClick={() => setSettingsSection('audio')}>
                  <strong>Audio support</strong>
                  <small>{ffmpegLoading ? 'Checking…' : ffmpeg?.available ? 'Ready' : 'Needs attention'}</small>
                </button>
                <button type="button" aria-current={settingsSection === 'models' ? 'page' : undefined}
                  onClick={() => setSettingsSection('models')}>
                  <strong>Models and account</strong>
                  <small>{model ? modelChoices.find((choice) => choice.id === model)?.label : 'Checking model…'}</small>
                </button>
                <button type="button" aria-current={settingsSection === 'cloud' ? 'page' : undefined}
                  onClick={() => setSettingsSection('cloud')}>
                  <strong>Analysis processing</strong>
                  <small>{cloudProvidersLoading || cloudStatusChecking ? 'Checking…'
                    : cloud?.mode === 'cloud' ? `${cloudProviderName} · Cloud`
                      : cloud?.mode === 'local' ? 'This PC' : 'Status unknown'}</small>
                </button>
              </nav>
            )}
            {(gettingStartedStep === 'audio' || !gettingStartedStep && settingsSection === 'audio') && <section id="ffmpeg-settings" className="model-settings-ffmpeg" aria-labelledby="ffmpeg-settings-title">
              <h3 id="ffmpeg-settings-title">Audio support</h3>
              <p>Choose the FFmpeg file used on this PC. Cloud workers use their own copy.</p>
              <form onSubmit={(event) => void saveFfmpegPath(event)}>
                <label htmlFor="ffmpeg-path">FFmpeg executable path</label>
                <div className="ffmpeg-path-row">
                  <input id="ffmpeg-path" type="text" value={ffmpegPathDraft} autoComplete="off" spellCheck={false}
                    disabled={ffmpegLoading || ffmpegActionBusy}
                    aria-describedby="ffmpeg-path-help ffmpeg-status"
                    onChange={(event) => setFfmpegPathDraft(event.target.value)} />
                  <button type="button" className="btn" aria-label="Browse for FFmpeg executable"
                    disabled={ffmpegLoading || ffmpegActionBusy} aria-busy={ffmpegBrowsing || undefined}
                    onClick={() => void browseFfmpegPath()}>{ffmpegBrowsing ? 'Opening…' : 'Browse…'}</button>
                </div>
                <p id="ffmpeg-path-help">Get a Windows build from <a
                  href="https://ffmpeg.org/download.html#build-windows" target="_blank" rel="noopener noreferrer">FFmpeg's Windows build links</a>.
                  Choose a build linked there, such as Gyan or BtbN. Extract the ZIP, then browse for or enter the full path to <code>bin\ffmpeg.exe</code>.</p>
                <p id="ffmpeg-status" className="ffmpeg-settings-status" role="status" aria-live="polite">
                  {ffmpegLoading ? 'Checking FFmpeg status…'
                    : ffmpegBrowsing ? 'Opening the Windows file picker…'
                    : ffmpegLoadError ? `FFmpeg status could not load: ${ffmpegLoadError}`
                    : ffmpeg?.available ? `FFmpeg is ready: ${ffmpeg.effectivePath}`
                      : ffmpeg?.issue ?? 'FFmpeg status is unavailable.'}
                </p>
                <div className="model-settings-actions">
                  <button type="submit" className="btn btn-primary" disabled={ffmpegLoading || ffmpegActionBusy}>
                    {ffmpegBusy ? 'Saving…' : 'Save path'}
                  </button>
                  <button type="button" className="btn" disabled={ffmpegLoading || ffmpegActionBusy || !ffmpeg?.configuredPath}
                    onClick={() => void resetFfmpegPath()}>Use automatic detection</button>
                  {ffmpegLoadError && <button type="button" className="btn" disabled={ffmpegLoading}
                    onClick={() => void retryFfmpegStatus()}>Retry status check</button>}
                </div>
                {ffmpegError && <p className="model-settings-error" role="alert">{ffmpegError}</p>}
              </form>
            </section>}
            {!gettingStartedStep && settingsSection === 'cloud' && <section className="model-settings-cloud" aria-labelledby="cloud-settings-title">
            <h3 id="cloud-settings-title">Analysis processing</h3>
            <fieldset className="cloud-mode" disabled={cloudProvidersLoading || !cloudProviderSelection?.activeProvider || cloudOperationBusy && !cloudStatusChecking}>
              <legend>Send new analysis to</legend>
              <label><input type="radio" name="processing-mode" checked={(processingChoice ?? cloud?.mode) === 'local'}
                onChange={() => void chooseMode('local')} /> This PC</label>
              <label><input type="radio" name="processing-mode" checked={(processingChoice ?? cloud?.mode) === 'cloud'}
                onChange={() => void chooseMode('cloud')} /> Cloud</label>
            </fieldset>
            {(processingChoice ?? cloud?.mode) === 'local' && <p>This PC keeps analysis on this computer.</p>}
            <p className="model-settings-source">Queued and running jobs keep their selected model and processing mode.</p>
            {(processingChoice ?? cloud?.mode) !== 'local' && <>
            <label className="cloud-provider-choice">Cloud provider
              <select aria-label="Cloud provider" value={cloudProviderSelection?.activeProvider ?? ''}
                disabled={cloudProvidersLoading || cloudOperationBusy && !cloudStatusChecking || !cloudProviderSelection}
                onChange={(event) => {
                  if (isCloudProvider(event.target.value)) void chooseCloudProvider(event.target.value)
                }}>
                {!cloudProviderSelection?.activeProvider && <option value="">{cloudProvidersLoading ? 'Loading providers…'
                  : cloudProviderSelection ? 'Choose a provider' : 'Provider unavailable'}</option>}
                {cloudProviderOptions.map(({ id, name }) =>
                  <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
            <p>Cloud sends recordings to your own provider resources. This PC keeps analysis on this computer.</p>
            {processingChoice === 'cloud' && cloud?.mode === 'local' && <p className="model-settings-source" role="status">
              Finish cloud setup before using Cloud. New analysis still uses This PC.
            </p>}
            <div className="cloud-status" aria-busy={cloudOperationBusy}>
              <span role="status" aria-live="polite">
                {cloudOperationBusy && <span className="cloud-inline-spinner" aria-hidden="true" />}
                {cloudStatusText}
              </span>
              <button ref={cloudSetupButton} type="button" className="btn" disabled={cloudOperationBusy || !cloudProviderSelection?.activeProvider || (!cloud && !cloudError)}
                onClick={() => cloudError || !cloud || (!cloud.configured
                  && !cloudSetupConfirmedAbsent && !cloudSetupCanContinue)
                  ? void checkCloudStatus(selectedCloudProvider) : openCloudWizard()}>
                {cloudActionText}
              </button>
              {cloud?.mode === 'cloud' && !cloudModelSupportKnown
                && <p className="model-settings-source" role="status">Cloud worker model support has not been checked; model choices remain available.</p>}
              {cloudStatusChecking && <button type="button" className="btn btn-quiet" onClick={() => {
                cloudStatusCancelRef.current?.()
                setCloudError(`${cloudProviderName} readiness check cancelled. Processing selection is unchanged.`)
              }}>Cancel check</button>}
            </div>
            {cloud?.issue && <p className="model-settings-source" role={!cloud.configured ? 'alert' : undefined}>{cloud.issue}</p>}
            {cloud?.config && <details className="cloud-connection-details">
              <summary>{cloudProviderName} connection options</summary>
              <p>Disconnecting makes Mizan forget its saved {cloudProviderName} setup and selects Local processing for new songs. It does not delete {cloudProviderName} resources or stop running jobs, and charges may continue. Your saved Hugging Face token remains in Windows Credential Manager.</p>
              <button type="button" className="btn cloud-remove" disabled={cloudOperationBusy}
                onClick={() => void disconnectCloud()}>Disconnect {cloudProviderName} from Mizan</button>
            </details>}
            </>}
            {cloudError && <p className="model-settings-error" role="alert">{cloudError}</p>}
            </section>}
            {(gettingStartedStep === 'model' || gettingStartedStep === 'access'
              || !gettingStartedStep && settingsSection === 'models') && <section className="model-settings-models" aria-label="Models and account">
            <p className="model-settings-source">A Hugging Face read-access token is needed to download MuScriptor models. Save it here and accept the model terms before downloading.</p>
            <details className="model-settings-access" open={gettingStartedStep === 'access' || (accessOpen ?? (hfConfigured === false))}
              onToggle={(event) => setAccessOpen(event.currentTarget.open)}>
              <summary>
                <span>Hugging Face account and access</span>
                <span role="status">{hfConfigured === null ? 'Checking token…' : hfConfigured ? 'Token saved' : 'No token saved'}</span>
                <ChevronDown size={16} aria-hidden />
              </summary>
              <div className="model-settings-access-body">
              <p><a href="https://huggingface.co/join" target="_blank" rel="noopener noreferrer">Create a Hugging Face account</a>, sign in, and accept the terms for the model you choose. Then <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener noreferrer">create a read-access token</a> and save it here. Mizan stores it on this PC in Windows Credential Manager.</p>
              {gettingStartedStep === 'access' && <ul className="model-settings-terms">
                {modelChoices.map((choice) => <li key={choice.id}><a href={`https://huggingface.co/MuScriptor/${choice.id}`}
                  target="_blank" rel="noopener noreferrer">Accept {choice.label} terms</a></li>)}
              </ul>}
            <form onSubmit={async (event) => {
              event.preventDefault()
              setHfBusy(true)
              setHfError(null)
              try {
                setHfConfigured(await host.setHfToken(tokenDraft))
                setTokenDraft('')
              } catch (reason) {
                setTokenDraft('')
                setHfError(problem(reason).message)
              } finally {
                setHfBusy(false)
              }
            }}>
              <label htmlFor="hf-token">Hugging Face access token</label>
              <input id="hf-token" type="password" value={tokenDraft} autoComplete="off" spellCheck={false}
                onChange={(event) => setTokenDraft(event.target.value)} />
              <div className="model-settings-actions">
                <button type="submit" className="btn btn-primary" disabled={hfBusy || !tokenDraft.trim()}>
                  {hfBusy ? 'Saving…' : hfConfigured ? 'Replace token' : 'Save token'}
                </button>
                {hfConfigured && <button type="button" className="btn" disabled={hfBusy} onClick={async () => {
                  setHfBusy(true)
                  setHfError(null)
                  setTokenDraft('')
                  try {
                    setHfConfigured(await host.clearHfToken())
                    setAccessOpen(true)
                  } catch (reason) {
                    setHfError(problem(reason).message)
                  } finally {
                    setHfBusy(false)
                  }
                }}>Remove token</button>}
              </div>
            </form>
              </div>
            </details>
            {hfError && <p className="model-settings-error" role="alert">{hfError}</p>}
            {gettingStartedStep === 'access' && cloud?.mode === 'cloud'
              && <p className="model-settings-source">Cloud setup asks separately before sending this saved token to your provider.</p>}
            {gettingStartedStep === 'access' && cloud === null
              && <p className="model-settings-source" role="status">Checking the saved processing mode. This token is stored only after you save it.</p>}
            {gettingStartedStep !== 'access' && <>
            <h3 id="model-choice-title">Choose how Mizan finds notes</h3>
            <p>Choose a size that fits this computer, or your selected cloud worker.</p>
            {cloud?.mode === 'cloud' && !cloudModelSupportKnown
              && <p className="model-settings-source" role="status">Cloud worker model support has not been checked; model choices remain available.</p>}
            <fieldset className="model-settings-choices" disabled={cloudOperationBusy || modelBusy || model === null}>
              <legend className="visually-hidden">Choose how to find notes</legend>
              {modelChoices.map((choice) => {
                const status = downloads?.[choice.id]
                const capacity = preflight?.[choice.id]
                return (
                  <div className="model-settings-item" key={choice.id}>
                    <label className="model-settings-choice">
                      <input type="radio" name="transcription-model" value={choice.id} checked={model === choice.id}
                        disabled={!cloud || (cloud.mode === 'cloud'
                          ? cloudModelSupportKnown && cloud.supportedModels?.includes(choice.id) === false
                          : !capacity?.eligible)}
                        onChange={() => void chooseModel(choice.id)} />
                      <span><strong>{choice.label}</strong>
                        <small>{choice.detail}</small>
                        {cloud?.mode === 'cloud' && cloudModelSupportKnown
                          && cloud.supportedModels?.includes(choice.id) === false
                          && <small className="model-settings-incompatible">Not supported by this Cloud worker</small>}
                        {cloud?.mode === 'local' && <small className={capacity?.reason ? 'model-settings-incompatible' : ''}>
                          {capacity?.reason ?? (capacity
                            ? `${capacity.requiredRamGiB} GiB free RAM needed · ${capacity.freeRamGiB} GiB available`
                            : preflightError ?? 'Checking this PC…')}
                        </small>}
                        {cloud === null && <small>Checking processing mode…</small>}</span>
                    </label>
                    <details className="model-settings-meta">
                      <summary>Model size and requirements</summary>
                      <p className="model-settings-metadata">{choice.info}. {cloud?.mode === 'cloud'
                        ? `${cloudProviderName} reports model support separately.`
                        : 'MuScriptor reads the original recording; these models have noncommercial terms.'}</p>
                    </details>
                      {cloud?.mode === 'local' && <div className="model-settings-download" aria-live="polite">
                        <span>{status?.downloaded ? 'Downloaded' : status?.active ? 'Downloading' : status ? 'Not downloaded' : 'Checking download…'}</span>
                        {status?.active && (
                          <>
                            <progress max={status.totalBytes} value={status.bytesReceived} aria-label={`${choice.label} download`} />
                            <span>{formatBytes(status.bytesReceived)} of {formatBytes(status.totalBytes)}
                              {' · '}{status.bytesPerSecond === null ? 'Calculating speed…' : `${(status.bytesPerSecond / 1e6).toFixed(1)} MB/s`}</span>
                          </>
                        )}
                        {status && !status.downloaded && !status.active && (
                          <button type="button" className="btn" disabled={hfConfigured !== true || downloadBusy || !capacity?.eligible || !!downloads && Object.values(downloads).some((item) => item.active)}
                            aria-label={`Download ${choice.label}`}
                            onClick={() => void downloadModel(choice.id)}>Download</button>
                        )}
                        <a href={`https://huggingface.co/MuScriptor/${choice.id}`} target="_blank" rel="noopener noreferrer"
                          aria-label={`Accept ${choice.label} model terms`}>Accept terms</a>
                        {status?.error && <p className="model-settings-error" role="alert">{status.error}</p>}
                        {downloadError?.model === choice.id && <p className="model-settings-error" role="alert">{downloadError.message}</p>}
                      </div>}
                  </div>
                )
              })}
            </fieldset>
            {model === null && !modelError && <p role="status">Loading model choice…</p>}
            {modelError && <p className="model-settings-error" role="alert">{modelError}</p>}
            {cloud?.mode === 'local' && downloadStatusError && <p className="model-settings-error" role="alert">{downloadStatusError}</p>}
            <details className="model-settings-stems">
              <summary>Separate instrument tracks</summary>
              <p>HT-Demucs separates vocals, drums, bass, guitar, piano, and an Other mix. Other contains the remaining sounds, not one recording per detected instrument. This stays on for every model.</p>
            </details>
            </>}
            </section>}
            {gettingStartedStep && gettingStartedStep !== 'welcome' && (
              <div className="getting-started-actions">
                <button type="button" className="model-settings-skip" onClick={dismissGettingStarted}>Not now</button>
                {gettingStartedStep === 'audio' ? (
                  <>
                    <button type="button" className="btn" onClick={() => setGettingStartedStep('welcome')}>Back</button>
                    <button type="button" className="btn btn-primary" disabled={!audioReady} onClick={continueWithAudio}>Continue</button>
                  </>
                ) : gettingStartedStep === 'access' ? (
                  <>
                    <button type="button" className="btn" onClick={() => { setGettingStartedStep('audio'); setSettingsSection('audio') }}>Back</button>
                    <button type="button" className="btn btn-primary" disabled={!accountReady} onClick={continueWithAccount}>Continue</button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn" onClick={() => setGettingStartedStep('access')}>Back</button>
                    {!setupReady && <div className="getting-started-blockers" role="status">
                      {!ffmpeg?.available && <p>{ffmpegLoading ? 'Checking FFmpeg…'
                        : ffmpegLoadError ?? ffmpeg?.issue ?? 'FFmpeg must be ready before song analysis can start.'}</p>}
                      {(cloud === null || cloudError || cloudStatusChecking) && <p>{cloudError ?? cloudStatusText}</p>}
                      {cloud?.mode === 'cloud' && !modelReady
                        && <p>{!cloud.configured ? cloud.issue ?? 'Cloud access is not ready.'
                          : !cloudModelSupportKnown ? 'Cloud worker model support has not been checked.'
                            : model ? `${modelChoices.find((choice) => choice.id === model)?.label} is not supported by this worker.`
                              : 'Choose a model supported by this cloud worker.'}</p>}
                      {cloud?.mode === 'local' && !modelReady && <p>{model === null ? 'Choose a note-finding model.'
                        : preflight?.[model]?.eligible !== true
                          ? preflight?.[model]?.reason ?? preflightError ?? 'Checking this PC can run the selected model.'
                          : hfConfigured !== true && !downloads?.[model]?.downloaded
                            ? 'Save a Hugging Face token, accept the model terms, and download the selected model.'
                            : 'Download the selected model on this PC.'}</p>}
                    </div>}
                    <button type="button" className="btn btn-quiet" onClick={() => {
                      markGettingStartedSeen()
                      guideDismissed.current = true
                      setGettingStartedStep(null)
                      setSettingsSection('cloud')
                    }}>Analysis processing options</button>
                    <button type="button" className="btn btn-primary" disabled={!setupReady} onClick={findSong}>Find a song</button>
                  </>
                )}
              </div>
            )}
          </dialog>
        )}
      </header>
      {cloudWizardOpen && <CloudSetup provider={selectedCloudProvider} status={cloud} onStatus={setCloud} acquireOperation={acquireCloudOperation}
        onClose={closeCloudWizard} />}

      <dialog ref={aboutDialog} className="about-dialog" aria-labelledby="about-title"
        onClose={() => { setAboutOpen(false); aboutButton.current?.focus() }}
        onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close() }}>
        <div className="about-content">
          <div className="about-top">
            <img src="/mizan-wordmark.svg" alt="" width="138" height="28" />
            <button type="button" className="icon-btn" aria-label="Close About" onClick={() => aboutDialog.current?.close()}>
              <X size={18} aria-hidden />
            </button>
          </div>
          <h2 id="about-title">About Mizan</h2>
          <p className="about-description">Turn a recording into a practice kit: draft scores, visual note guides, chords, and isolated parts to play along with.</p>
          <p className="about-version">
            <span>Current version</span>
            <strong>{import.meta.env.VITE_MIZAN_VERSION ? `v${import.meta.env.VITE_MIZAN_VERSION}` : 'Development build'}</strong>
            <a href="https://github.com/sabbour/mizan/releases" target="_blank" rel="noopener noreferrer">Release notes <ExternalLink size={14} aria-hidden /></a>
          </p>
          <div className="about-links">
            <a href="https://github.com/sabbour/mizan" target="_blank" rel="noopener noreferrer">Source on GitHub <ExternalLink size={14} aria-hidden /></a>
            <a href="https://github.com/sabbour/mizan/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">MIT license <ExternalLink size={14} aria-hidden /></a>
            <button type="button" onClick={() => { aboutDialog.current?.close(); onCredits() }}>Credits & third-party licenses</button>
          </div>
          <div className="about-author">
            <p>Created by <strong>Ahmed Sabbour</strong></p>
            <div>
              <a href="https://github.com/sabbour" target="_blank" rel="noopener noreferrer">GitHub</a>
              <a href="https://www.linkedin.com/in/ahmedsabbour/" target="_blank" rel="noopener noreferrer">LinkedIn</a>
              <a href="https://x.com/sabbour" target="_blank" rel="noopener noreferrer">X</a>
            </div>
          </div>
        </div>
      </dialog>

      <main className="lib-main">
        <section ref={intake} className="intake" aria-labelledby="intake-title">
          <h1 id="intake-title" className={empty ? '' : 'visually-hidden'}>
            What do you want to learn?
          </h1>
          <form
            className="intake-row"
            onSubmit={(e) => {
              e.preventDefault()
              if (isLink) void addLink(query)
              else {
                setTab('catalog')
                songs.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            }}
          >
            <label className="intake-field intake-unified">
              {isLink ? <Link2 size={18} aria-hidden /> : <Search size={18} aria-hidden />}
              <span className="visually-hidden">Search your library, YouTube, and public MIDI, or paste a link</span>
              <input
                ref={field}
                name="url"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder="Search your library, YouTube, and public MIDI, or paste a link"
                value={query}
                aria-invalid={!!error}
                aria-describedby="intake-help"
                onChange={(event) => {
                  setQuery(event.target.value)
                  if (error) setError(null)
                }}
              />
              {query && <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery('')}><X size={14} /></button>}
              <kbd>Ctrl K</kbd>
            </label>
            <button className="btn btn-primary" type="submit" disabled={busy || pendingLinks.includes(query.trim())}>
              {pendingLinks.includes(query.trim()) ? 'Queuing…' : isLink ? 'Transcribe' : 'Search'}
            </button>
            <button className="btn" type="button" onClick={() => picker.current?.click()} disabled={busy}>
              <FolderOpen size={16} aria-hidden /> Import file
            </button>
            <input
              ref={picker}
              type="file"
              hidden
              multiple
              accept=".mid,.midi,.musicxml,.xml,.mxl"
              onChange={(e) => {
                void importFiles([...(e.target.files ?? [])])
                e.target.value = ''
              }}
            />
          </form>
          <div id="intake-help" className="intake-help" aria-live="polite">
            {error ? (
              <p className="intake-error" role="alert">
                <strong>{error.message}</strong> {error.fix}
              </p>
            ) : pendingLinks.length ? (
              <p role="status">Adding {pendingLinks.length === 1 ? 'recording' : 'recordings'} to the queue…</p>
            ) : (
              <p>MuScriptor makes draft notes for instruments it can identify in a recording. MIDI files ask before import; MusicXML imports directly. You can also drop files or links anywhere.</p>
            )}
          </div>
        </section>

        <div className="lib-tabs" role="tablist" aria-label="Library">
          {TABS.map((item, index) => (
            <button key={item.id} type="button" role="tab" id={`lib-tab-${item.id}`} aria-controls={`lib-panel-${item.id}`}
              aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className="lib-tab" data-tab={item.id}
              onClick={() => setTab(item.id)}
              onKeyDown={(event) => {
                const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
                const to = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : step ? (index + step + TABS.length) % TABS.length : -1
                if (to < 0) return
                event.preventDefault()
                setTab(TABS[to].id)
                ;(event.currentTarget.parentElement?.querySelector(`[data-tab="${TABS[to].id}"]`) as HTMLElement | null)?.focus()
              }}>
              {item.label}
              {item.id === 'catalog' && <span className="lib-tab-count num">{entries?.length ?? ''}</span>}
              {item.id === 'course' && <span className="lib-tab-count num">{LESSONS.length + PIANO_LESSONS.length + PIANO_INSPIRED.length + FRETTED_LESSONS.length}</span>}
              {item.id === 'catalog' && queueJobs.length > 0 && tab !== 'catalog' && <span className="lib-tab-count num">· {queueJobs.length} in queue</span>}
            </button>
          ))}
        </div>

        <div role="tabpanel" id="lib-panel-discover" aria-labelledby="lib-tab-discover" hidden={tab !== 'discover'}>
          {tab === 'discover' && !query.trim() && !selectedJob && <PopularMusic jobs={jobs} busy={busy}
            pendingLinks={pendingLinks} onTranscribe={addLink} />}
        </div>

        <div role="tabpanel" id="lib-panel-catalog" aria-labelledby="lib-tab-catalog" hidden={tab !== 'catalog'}>
        {queueJobs.length > 0 && <Queue jobs={queueJobs} selected={selectedJob} onChange={onQueueChange} onDetails={onDetails} onOpen={(id) => entries && onOpenId(id, entries, onOpen)} />}
        {empty && (
          <p className="library-first-note">
            <FileMusic size={19} aria-hidden />
            Your songs and practice progress will appear here. Paste a YouTube link above or import a MIDI or MusicXML file to begin.
          </p>
          )}

          {!empty && (
          <div className="lib-catalog">
            <FolderNav
              folders={allFolders}
              selected={selectedFolder}
              onSelect={setSelectedFolder}
              onChanged={reload}
              onDropSong={assignSong}
              pointerTarget={songDrag?.folderId ?? null}
              feedback={folderFeedback}
            />
            <section ref={songs} className="songs" aria-labelledby="songs-title">
              <h2 id="songs-title" className="lib-h2">
                {selectedFolder === 'all' ? 'Songs' : currentFolder?.name}
                <span className="dim num" aria-live="polite">{searchQuery ? `${shown.length} of ${folderEntries.length} songs` : folderEntries.length}</span>
              </h2>
              {entries === null ? (
                <p className="songs-note">Loading your library…</p>
              ) : shown.length === 0 ? (
                <div className="songs-empty">
                  <FileMusic size={21} aria-hidden />
                  <div>
                    <p>{searchQuery ? <>No songs match “{searchQuery}”.</> : selectedFolder === 'all' ? 'Your library is empty.' : `No songs in ${currentFolder?.name} yet.`}</p>
                    <span>{searchQuery ? 'Try another search or show all songs.' : selectedFolder === 'all' ? 'Paste a YouTube link or import a file to begin.' : 'Browse all songs, then drag one onto this folder or use its Folders button.'}</span>
                  </div>
                  <button className="btn btn-quiet" onClick={() => {
                    setQuery('')
                    setSelectedFolder('all')
                    if (!searchQuery && selectedFolder === 'all') field.current?.focus()
                  }}>{searchQuery ? 'Show all songs' : selectedFolder === 'all' ? 'Add a song' : 'Browse all songs'}</button>
                </div>
              ) : (
                <ol className="song-list">
                  {shown.map((entry) => (
                    <SongRow
                      key={entry.id}
                      entry={entry}
                      query={searchQuery}
                      folders={folders}
                      onOpen={() => onOpen(entry)}
                      onChanged={reload}
                      onQueued={onQueueChange}
                      updating={activeAnalysis(jobs, entry.id)}
                      onDetails={onDetails}
                    />
                  ))}
                </ol>
              )}
              <YouTubeSearch query={searchQuery.trim()} jobs={jobs} busy={busy} pendingLinks={pendingLinks}
                processingMode={cloud?.mode} transcriptionModel={model ?? undefined} onAdd={addLink} />
              <MidiSearch query={searchQuery.trim()} onImport={(result) => {
                setMidiOfferError(null)
                setMidiOffers((current) => [...current, { name: result.title, result }])
              }} />
            </section>
          </div>
        )}

        </div>

        <div role="tabpanel" id="lib-panel-course" aria-labelledby="lib-tab-course" hidden={tab !== 'course'}>
          {tab === 'course' && <CourseSection onLesson={onLesson} browse={courseBrowse} onBrowse={onCourseBrowse} />}
        </div>
      </main>

      {songDrag && draggedEntry && (
        <div className="song-drag-preview" aria-hidden style={{
          left: Math.min(songDrag.x + 16, window.innerWidth - 300),
          top: Math.min(songDrag.y + 16, window.innerHeight - 80),
        }}>
          <FileMusic size={18} />
          <span><strong>{draggedEntry.title}</strong><span>{dragFolder ? `Add to ${dragFolder.name}` : 'Drop onto a folder'}</span></span>
        </div>
      )}

      {dragging && (
        <div className="drop" aria-hidden>
          <p>
            <FileMusic size={28} />
            Drop to import
            <span>MIDI, MusicXML, or a YouTube link</span>
          </p>
        </div>
      )}

      {midiOffer && (
        <dialog
          ref={midiDialog}
          className="midi-import-dialog"
          aria-labelledby="midi-import-title"
          onClose={() => {
            if (midiOffers.length > 1) return
            restoreMidiImportFocus()
          }}
          onCancel={(event) => {
            if (busy) {
              event.preventDefault()
              return
            }
            event.preventDefault()
            setMidiOffers((current) => current.slice(1))
            setMidiOfferError(null)
          }}
          onClick={(event) => {
            if (!busy && event.target === event.currentTarget) {
              setMidiOffers((current) => current.slice(1))
              setMidiOfferError(null)
            }
          }}
        >
          <h2 id="midi-import-title">Import “{midiOffer.name}”?</h2>
          {midiOffer.result && (
            <div className="midi-offer-details">
              <p>{midiOffer.result.source}{midiOffer.result.artist ? ` · ${midiOffer.result.artist}` : ''}</p>
              <p>License: {midiOffer.result.license}</p>
              {midiOffer.result.attribution && <p>Attribution: {midiOffer.result.attribution}</p>}
            </div>
          )}
          {midiOffer.result
            && (midiOffer.result.provider === 'bitmidi' || midiOffer.result.provider === 'freemidi') && (
            <label className="midi-import-permission">
              <input
                type="checkbox"
                checked={midiOffer.permissionConfirmed === true}
                disabled={busy}
                onChange={(event) => {
                  const checked = event.target.checked
                  setMidiOffers((current) => current.map((offer, index) =>
                    index === 0 ? { ...offer, permissionConfirmed: checked } : offer))
                }}
              />
              <span>The source does not list a per-file license. I confirm that I have permission to use this MIDI file.</span>
            </label>
          )}
          <p>This MIDI file will be added to your library. It will not be treated as audio or transcribed.</p>
          {midiOfferError && <p className="intake-error" role="alert">{midiOfferError.message} {midiOfferError.fix}</p>}
          <div className="midi-import-actions">
            <button className="btn btn-quiet" autoFocus disabled={busy} onClick={() => {
              setMidiOffers((current) => current.slice(1))
              setMidiOfferError(null)
            }}>Cancel</button>
            <button className="btn btn-primary"
              disabled={busy || !!midiOffer.result
                && (midiOffer.result.provider === 'bitmidi' || midiOffer.result.provider === 'freemidi')
                && midiOffer.permissionConfirmed !== true}
              onClick={() => void confirmMidiImport()}>
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>
        </dialog>
      )}
    </div>
  )
}

type VideoProvider = 'youtube' | 'youtube_music'
type UnifiedVideo = Omit<YouTubeResult, 'source'> & { sources: VideoProvider[] }

function useVideoSearch(provider: VideoProvider, query: string) {
  const [result, setResult] = useState<{ query: string; entries: YouTubeResult[]; error: Problem | null } | null>(null)
  const [retry, setRetry] = useState(0)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!query) return
    let stale = false
    const timer = window.setTimeout(() => {
      setLoading(true)
      const request = provider === 'youtube'
        ? host.searchYouTube(query)
        : host.searchYouTubeMusic(query)
      void request.then(
        (entries) => { if (!stale) setResult({ query, entries, error: null }) },
        (error) => { if (!stale) setResult({ query, entries: [], error: problem(error) }) },
      ).finally(() => { if (!stale) setLoading(false) })
    }, 350)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [provider, query, retry])

  const current = result?.query === query ? result : null
  return {
    entries: current?.entries ?? [],
    error: current?.error ?? null,
    loading: !!query && (loading || current === null),
    retry: () => setRetry((value) => value + 1),
  }
}

function mergeVideoResults(youtube: YouTubeResult[], music: YouTubeResult[]): UnifiedVideo[] {
  const merged = new Map<string, UnifiedVideo>()
  for (const video of [...youtube, ...music]) {
    const source = video.source ?? 'youtube'
    const existing = merged.get(video.id)
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source)
    } else {
      const details: Omit<YouTubeResult, 'source'> = {
        id: video.id, title: video.title, channel: video.channel,
        duration: video.duration, thumbnail: video.thumbnail, url: video.url,
      }
      merged.set(video.id, { ...details, sources: [source] })
    }
  }
  return [...merged.values()]
}

function PopularMusic({ jobs, busy, pendingLinks, onTranscribe }: {
  jobs: QueueJob[]
  busy: boolean
  pendingLinks: string[]
  onTranscribe: (url: string) => Promise<void>
}) {
  const [chart, setChart] = useState<PopularChart | null>(null)
  const [error, setError] = useState<Problem | null>(null)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [activePreview, setActivePreview] = useState<{
    sectionId: string
    videoId: string
    title: string
  } | null>(null)
  const shelves = useRef(new Map<string, HTMLOListElement>())

  useEffect(() => {
    let stale = false
    setLoading(true)
    setError(null)
    void host.popularSongs(retry > 0).then(
      (result) => { if (!stale) setChart(result) },
      (reason) => { if (!stale) setError(problem(reason)) },
    ).finally(() => { if (!stale) setLoading(false) })
    return () => { stale = true }
  }, [retry])

  const scrollShelf = (id: string, direction: -1 | 1) => {
    const track = shelves.current.get(id)
    if (track) track.scrollBy({ left: direction * track.clientWidth * 0.8, behavior: 'smooth' })
  }
  const retryPlaylists = () => {
    setActivePreview(null)
    setRetry((value) => value + 1)
  }

  return (
    <section className="popular-music" aria-labelledby="popular-music-title" aria-busy={loading}>
      <div className="popular-music-heading">
        <div>
          <h2 id="popular-music-title" className="lib-h2">Popular on YouTube Music</h2>
          {chart?.sample && <p className="popular-music-summary">Development sample data</p>}
        </div>
        <div className="popular-heading-actions">
          {chart && <p className="popular-freshness">
            Updated {new Date(chart.fetchedAt).toLocaleString()} · refreshed every 6 hours
          </p>}
        </div>
      </div>

      {loading && !chart && <p className="songs-note" role="status">Loading YouTube Music playlists…</p>}
      {error && (
        <div className="popular-chart-error" role="alert">
          <span>{error.message}</span>
          <button className="btn btn-quiet" onClick={retryPlaylists}>Retry playlists</button>
        </div>
      )}
      {chart?.warning && (
        <p className="popular-chart-warning" role="status">
          {chart.warning}{' '}
          <button className="btn btn-quiet" onClick={retryPlaylists}>Retry playlists</button>
        </p>
      )}

      {chart?.sections.map((section) => (
        <section className="popular-shelf" key={section.id} aria-labelledby={`popular-shelf-${section.id}`}>
          <div className="popular-shelf-heading">
            <div className="popular-shelf-title-group">
              <h3 id={`popular-shelf-${section.id}`}>{section.title}</h3>
              {section.kind === 'chart' && <span className="popular-chart-badge">Chart</span>}
            </div>
            <div className="popular-heading-actions">
              <div className="popular-shelf-controls" aria-label={`${section.title} shelf controls`}>
                <button type="button" className="icon-btn" aria-label={`Previous songs in ${section.title}`}
                  title={`Previous songs in ${section.title}`}
                  onClick={() => scrollShelf(section.id, -1)} disabled={!section.rows.length}>
                  <ChevronLeft size={18} aria-hidden />
                </button>
                <button type="button" className="icon-btn" aria-label={`Next songs in ${section.title}`}
                  title={`Next songs in ${section.title}`}
                  onClick={() => scrollShelf(section.id, 1)} disabled={!section.rows.length}>
                  <ChevronRight size={18} aria-hidden />
                </button>
              </div>
            </div>
          </div>
          {section.status === 'unavailable' ? (
            <div className="popular-chart-error" role="alert">
              <span>{section.title} unavailable — {section.message ?? 'YouTube Music could not load this playlist.'}</span>
              <button className="btn btn-quiet" onClick={retryPlaylists}>Retry</button>
            </div>
          ) : (
            <>
              <ol ref={(node) => {
                if (node) shelves.current.set(section.id, node)
                else shelves.current.delete(section.id)
              }} className="popular-music-list" aria-label={section.title}>
                {section.rows.map((row) => {
                  const url = `https://www.youtube.com/watch?v=${row.videoId}`
                  const previewing = activePreview?.sectionId === section.id
                    && activePreview.videoId === row.videoId
                  const queued = jobs.some((job) => job.kind === 'transcribe' && job.url === url
                    && (job.status === 'queued' || job.status === 'running'))
                  const pending = pendingLinks.includes(url)
                  const transcribeLabel = pending ? 'Queuing' : queued ? 'Queued' : 'Transcribe'
                  return (
                    <li key={row.videoId} className="popular-music-card" data-previewing={previewing || undefined} tabIndex={0}>
                      <div className={`popular-cover${previewing ? ' popular-cover-playing' : ''}`}>
                        {previewing ? (
                          <iframe
                            key={`${activePreview.sectionId}:${activePreview.videoId}`}
                            className="popular-preview-player"
                            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(activePreview.videoId)}?autoplay=1&playsinline=1&controls=1&origin=${encodeURIComponent(window.location.origin)}`}
                            title={`YouTube preview: ${activePreview.title}`}
                            allow="autoplay; encrypted-media; picture-in-picture; web-share"
                            referrerPolicy="strict-origin-when-cross-origin"
                            allowFullScreen
                          />
                        ) : (
                          <a className="popular-cover-link" href={url} target="_blank" rel="noreferrer"
                            aria-label={`Open ${row.title} on YouTube`}>
                            <Thumb entry={{ thumbnail: row.thumbnail, source: 'youtube' }} />
                            {row.rank !== undefined && (
                              <span className="popular-rank num" aria-label={`Chart rank ${row.rank}`}>{row.rank}</span>
                            )}
                          </a>
                        )}
                        <div className={`popular-cover-actions${previewing ? ' popular-cover-actions-playing' : ''}`}>
                          <button type="button" className="btn btn-primary popular-song-preview"
                            aria-label={`${previewing ? 'Stop preview of' : 'Preview'} ${row.title}`}
                            aria-pressed={previewing}
                            onClick={() => setActivePreview(previewing
                              ? null
                              : { sectionId: section.id, videoId: row.videoId, title: row.title })}>
                            {previewing ? <X size={13} aria-hidden /> : <Play size={13} aria-hidden />}
                            {previewing ? 'Stop' : 'Preview'}
                          </button>
                          <button type="button" className="btn btn-primary popular-song-transcribe"
                            disabled={busy || queued || pending}
                            aria-label={`${transcribeLabel} ${row.title}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              void onTranscribe(url)
                            }}>
                            {pending ? 'Queuing…' : queued ? 'Queued' : 'Transcribe'}
                          </button>
                        </div>
                      </div>
                      <div className="popular-music-copy">
                        <a className="popular-song-title" href={url} target="_blank" rel="noreferrer"
                          aria-label={`Open ${row.title} on YouTube`}>{row.title}</a>
                        <p className="song-meta">{row.artist || 'Artist not listed'}</p>
                        {previewing && <a className="popular-preview-fallback" href={url} target="_blank" rel="noreferrer">
                          Open on YouTube <ExternalLink size={12} aria-hidden />
                        </a>}
                      </div>
                    </li>
                  )
                })}
              </ol>
              <p className="popular-chart-source">
                <a href={section.sourceUrl} target="_blank" rel="noreferrer">
                  Open source playlist <ExternalLink size={12} aria-hidden />
                </a>
              </p>
            </>
          )}
        </section>
      ))}
    </section>
  )
}

function YouTubeSearch({ query, jobs, busy, pendingLinks, processingMode, transcriptionModel, onAdd }: {
  query: string
  jobs: QueueJob[]
  busy: boolean
  pendingLinks: string[]
  processingMode?: ProcessingMode
  transcriptionModel?: TranscriptionModel
  onAdd: (url: string) => Promise<void>
}) {
  const youtube = useVideoSearch('youtube', query)
  const music = useVideoSearch('youtube_music', query)

  if (!query) return null
  const results = mergeVideoResults(youtube.entries, music.entries)
  const waiting = youtube.loading || music.loading
  const providers = [
    { id: 'youtube' as const, label: 'YouTube', result: youtube },
    { id: 'youtube_music' as const, label: 'YouTube Music', result: music },
  ]
  return (
    <section className="youtube-results" aria-labelledby="youtube-title" aria-busy={waiting}>
      <h2 id="youtube-title" className="lib-h2">YouTube <span className="dim num">{results.length || ''}</span></h2>
      <p className="youtube-help">Choose a recording to transcribe. Audio is only downloaded when you choose Transcribe.</p>
      <ul className="provider-status-list" aria-label="Video search sources">
        {providers.map(({ id, label, result }) => (
          <li key={id} role={result.error ? 'alert' : 'status'}>
            <strong>{label}:</strong>{' '}
            {result.error
              ? <>Unavailable — {result.error.message} {result.error.fix}
                  <button className="btn btn-quiet" onClick={result.retry}>Retry {label}</button>
                </>
              : result.loading
                ? 'Searching…'
                : result.entries.length
                  ? `${result.entries.length} results`
                  : 'No results'}
          </li>
        ))}
      </ul>
      {results.length === 0 ? (
        <p className="songs-note" role="status">
          {waiting ? 'Searching YouTube sources…' : 'No YouTube videos match this search. Your local results are above.'}
        </p>
      ) : (
        <ol className="youtube-list">
          {results.map((video) => {
            const pending = pendingLinks.includes(video.url)
            const queued = jobs.some((job) => job.kind === 'transcribe' && job.url === video.url
              && (!processingMode || (job.processingMode ?? 'local') === processingMode)
              && (!transcriptionModel || job.transcriptionModel === transcriptionModel)
              && (job.status === 'queued' || job.status === 'running'))
            return (
              <li key={video.id} className="youtube-result">
                <Thumb entry={{ thumbnail: video.thumbnail, source: 'youtube' }} />
                <div className="song-text">
                  <p className="song-title">{video.title}</p>
                  <p className="song-meta">{video.channel || 'YouTube'}{video.duration !== null ? ` · ${clock(video.duration)}` : ''}</p>
                  <p className="video-sources">
                    {video.sources.map((source) => (
                      <span key={source} className="video-source" data-source={source}>
                        {source === 'youtube_music' ? 'YouTube Music' : 'YouTube'}
                      </span>
                    ))}
                  </p>
                </div>
                <button className="btn" disabled={busy || queued || pending} aria-label={`${pending ? 'Queuing' : queued ? 'Queued' : 'Transcribe'} ${video.title}`} onClick={() => void onAdd(video.url)}>
                  {pending ? 'Queuing…' : queued ? 'Queued' : 'Transcribe'}
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

type MidiProvider = 'commons' | 'mutopia' | 'archive' | 'bitmidi' | 'freemidi'
type MidiProviderPage = { query: string; entries: MidiSearchResult[]; nextStart: number | null; error: Problem | null }
type UnifiedMidiResult = { id: string; primary: MidiSearchResult; sources: MidiSearchResult[] }

function useMidiProviderSearch(provider: MidiProvider, query: string) {
  const [result, setResult] = useState<MidiProviderPage | null>(null)
  const [retry, setRetry] = useState(0)
  const [loading, setLoading] = useState(false)
  const [moreLoading, setMoreLoading] = useState(false)
  const generation = useRef(0)

  useEffect(() => {
    generation.current++
    setMoreLoading(false)
    if (!query) {
      setLoading(false)
      setResult(null)
      return
    }
    let stale = false
    setLoading(true)
    setResult((previous) => previous?.query === query ? { ...previous, error: null } : previous)
    const timer = window.setTimeout(() => {
      const request = provider === 'commons'
        ? host.searchMidiCommons(query).then((entries) => ({ entries, nextStart: null }))
        : provider === 'mutopia'
          ? host.searchMidiMutopia(query, 0).then(({ results, nextStart }) => ({ entries: results, nextStart }))
          : provider === 'archive'
            ? host.searchMidiArchive(query).then((entries) => ({ entries, nextStart: null }))
            : provider === 'bitmidi'
              ? host.searchMidiBitMidi(query).then((entries) => ({ entries, nextStart: null }))
              : host.searchMidiFreeMidi(query).then((entries) => ({ entries, nextStart: null }))
      void request.then(
        ({ entries, nextStart }) => {
          if (!stale) setResult({ query, entries, nextStart, error: null })
        },
        (error) => {
          if (!stale) setResult((previous) => previous?.query === query
            ? { ...previous, error: problem(error) }
            : { query, entries: [], nextStart: null, error: problem(error) })
        },
      ).finally(() => { if (!stale) setLoading(false) })
    }, 350)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [provider, query, retry])

  const current = result?.query === query ? result : null
  const loadMore = async () => {
    if (provider !== 'mutopia' || current?.nextStart == null || moreLoading) return
    const requestGeneration = generation.current
    setMoreLoading(true)
    try {
      const page = await host.searchMidiMutopia(query, current.nextStart)
      if (generation.current === requestGeneration) {
        setResult((previous) => previous?.query === query
          ? { ...previous, entries: [...previous.entries, ...page.results], nextStart: page.nextStart, error: null }
          : previous)
      }
    } catch (error) {
      if (generation.current === requestGeneration)
        setResult((previous) => previous?.query === query
          ? { ...previous, error: problem(error) }
          : previous)
    } finally {
      if (generation.current === requestGeneration) setMoreLoading(false)
    }
  }
  return {
    page: current,
    loading: !!query && (loading || current === null),
    moreLoading,
    retry: () => setRetry((value) => value + 1),
    loadMore,
  }
}

function unifyMidiResults(entries: MidiSearchResult[], query: string): UnifiedMidiResult[] {
  const groups = new Map<string, UnifiedMidiResult>()
  const identities = new Map<string, UnifiedMidiResult>()
  for (const entry of entries) {
    const keys = [`url:${entry.dedupeKey}`, `provider:${entry.provider}:${entry.id}`]
    const existing = keys.map((key) => identities.get(key)).find(Boolean)
    const group = existing ?? { id: `${entry.provider}:${entry.id}`, primary: entry, sources: [] }
    if (!group.sources.some((source) => source.provider === entry.provider && source.id === entry.id))
      group.sources.push(entry)
    groups.set(group.id, group)
    for (const key of keys) identities.set(key, group)
  }
  const needle = foldSearchText(query.trim())
  const rank = (group: UnifiedMidiResult) => {
    if (!needle) return 0
    const title = foldSearchText(group.primary.title)
    const artists = group.sources.map((source) => foldSearchText(source.artist ?? ''))
    if (title === needle) return 0
    if (title.startsWith(needle)) return 1
    if (title.includes(needle)) return 2
    if (artists.some((artist) => artist === needle)) return 3
    if (artists.some((artist) => artist.startsWith(needle))) return 4
    if (artists.some((artist) => artist.includes(needle))) return 5
    return 6
  }
  return [...groups.values()].sort((a, b) => rank(a) - rank(b)
    || foldSearchText(a.primary.title).localeCompare(foldSearchText(b.primary.title))
    || a.id.localeCompare(b.id))
}

function MidiSearch({ query, onImport }: {
  query: string
  onImport: (result: MidiSearchResult) => void
}) {
  const commons = useMidiProviderSearch('commons', query)
  const mutopia = useMidiProviderSearch('mutopia', query)
  const archive = useMidiProviderSearch('archive', query)
  const bitmidi = useMidiProviderSearch('bitmidi', query)
  const freemidi = useMidiProviderSearch('freemidi', query)

  if (!query) return null
  const providers = [
    { id: 'commons' as const, label: 'Wikimedia Commons', state: commons },
    { id: 'mutopia' as const, label: 'Mutopia', state: mutopia },
    { id: 'archive' as const, label: 'Internet Archive', state: archive },
    { id: 'bitmidi' as const, label: 'BitMidi', state: bitmidi },
    { id: 'freemidi' as const, label: 'FreeMIDI', state: freemidi },
  ]
  const results = unifyMidiResults([
    ...(commons.page?.entries ?? []),
    ...(mutopia.page?.entries ?? []),
    ...(archive.page?.entries ?? []),
    ...(bitmidi.page?.entries ?? []),
    ...(freemidi.page?.entries ?? []),
  ], query)
  const waiting = commons.loading || mutopia.loading || archive.loading || bitmidi.loading || freemidi.loading
  return (
    <section className="youtube-results midi-results" aria-label="Public MIDI results"
      aria-busy={waiting || mutopia.moreLoading}>
      <h2 className="lib-h2">Public MIDI <span className="dim num">{results.length || ''}</span></h2>
      <p className="youtube-help">
        Commons, Mutopia, and Internet Archive results need a confirmed per-file license.
        BitMidi and FreeMIDI may not list one; import those files only if you have permission to use them.
      </p>
      <ul className="provider-status-list" aria-label="MIDI search sources">
        {providers.map(({ id, label, state }) => {
          const error = state.page?.error
          const entries = state.page?.entries ?? []
          return (
            <li key={id} role={error ? 'alert' : 'status'}>
              <strong>{label}:</strong>{' '}
              {error
                ? <>Unavailable — {error.message}{entries.length ? ` Showing ${entries.length} earlier results.` : ''} {error.fix}
                    <button className="btn btn-quiet" onClick={state.retry}>Retry {label}</button>
                  </>
                : state.loading
                  ? 'Searching…'
                  : entries.length ? `${entries.length} results` : 'No eligible results'}
              {id === 'mutopia' && state.page?.nextStart != null && (
                <button className="btn btn-quiet" disabled={state.moreLoading} onClick={() => void state.loadMore()}>
                  {state.moreLoading ? 'Loading…' : 'Load 10 more'}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {results.length === 0 ? (
        <p className="songs-note" role="status">
          {waiting ? 'Searching MIDI sources…' : 'No eligible MIDI files match this search.'}
        </p>
      ) : (
        <>
          <ol className="youtube-list">
            {results.map((result) => (
              <li key={result.id} className="midi-result">
                <div className="midi-result-copy">
                  <p className="song-title">{result.primary.title}</p>
                  <p className="song-meta">{result.primary.artist || 'Composer/artist not listed'}</p>
                  {result.sources.map((source) => (
                    <div className="midi-provenance" key={`${source.provider}:${source.id}`}>
                      <p className="song-meta">{source.source} · License: {source.license}</p>
                      <p className="song-meta">Attribution: {source.attribution || 'Not listed'}</p>
                      <p className="song-meta">
                        <a href={source.sourceUrl} target="_blank" rel="noreferrer">Open source page <ExternalLink size={12} aria-hidden /></a>
                        {source.licenseUrl && <> · <a href={source.licenseUrl} target="_blank" rel="noreferrer">License</a></>}
                      </p>
                    </div>
                  ))}
                </div>
                <button className="btn" onClick={() => onImport(result.primary)}>Import</button>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  )
}

function onOpenId(id: string, entries: Entry[], open: (e: Entry) => void) {
  const e = entries.find((x) => x.id === id)
  if (e) open(e)
}

function FolderNav({
  folders,
  selected,
  onSelect,
  onChanged,
  onDropSong,
  pointerTarget,
  feedback,
}: {
  folders: LibraryFolder[]
  selected: string
  onSelect: (id: string) => void
  onChanged: () => void
  onDropSong: (songId: string, folderId: string) => void
  pointerTarget: string | null
  feedback: { message: string; error: boolean } | null
}) {
  const [creating, setCreating] = useState(false)
  const [menu, setMenu] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dragTarget, setDragTarget] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const nav = useRef<HTMLElement>(null)
  const automatic = folders.filter((folder) => !folder.user)
  const user = folders.filter((folder) => folder.user)

  useEffect(() => {
    if (!menu) return
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.folder-item')) setMenu(null)
    }
    nav.current?.querySelector<HTMLButtonElement>('.folder-menu button')?.focus()
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu])

  const saveName = (action: Promise<unknown>) => {
    setError(null)
    void action.then(
      () => {
        setCreating(false)
        setRenaming(null)
        setMenu(null)
        onChanged()
      },
      (reason) => setError(problem(reason).message),
    )
  }

  const item = (folder: LibraryFolder) => (
    <div
      className="folder-item"
      key={folder.id}
      data-folder-id={folder.id}
      data-user={folder.user || undefined}
      data-drop={folder.user && (dragTarget === folder.id || pointerTarget === folder.id) || undefined}
      onContextMenu={folder.user ? (event) => {
        event.preventDefault()
        setMenu(folder.id)
      } : undefined}
      onDragOver={folder.user ? (event) => {
        if (event.dataTransfer.types.includes('application/x-mizan-song')) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          setDragTarget(folder.id)
        }
      } : undefined}
      onDragLeave={folder.user ? (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragTarget(null)
      } : undefined}
      onDrop={folder.user ? (event) => {
        setDragTarget(null)
        const songId = event.dataTransfer.getData('application/x-mizan-song')
        if (songId) {
          event.preventDefault()
          event.stopPropagation()
          onDropSong(songId, folder.id)
        }
      } : undefined}
    >
      {renaming === folder.id ? (
        <form
          className="folder-edit"
          onSubmit={(event) => {
            event.preventDefault()
            saveName(host.renameFolder(folder.id, String(new FormData(event.currentTarget).get('name') ?? '')))
          }}
        >
          <input name="name" aria-label="Rename folder" defaultValue={folder.name} maxLength={60} autoFocus onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setRenaming(null)
            }
          }} />
          <button type="submit" className="btn btn-quiet">Save</button>
        </form>
      ) : (
        <button className="folder-link" aria-current={selected === folder.id ? 'page' : undefined} onClick={() => onSelect(folder.id)}>
          <span>{folder.name}</span><span className="num">{folder.count}</span>
        </button>
      )}
      {folder.user && renaming !== folder.id && (
        <button className="folder-more" aria-label={`Manage ${folder.name}`} aria-expanded={menu === folder.id} onClick={() => setMenu(menu === folder.id ? null : folder.id)}>
          <Ellipsis size={15} />
        </button>
      )}
      {menu === folder.id && (
        <div className="folder-menu" role="group" aria-label={`Manage ${folder.name}`} onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('.folder-more')?.focus()
            setMenu(null)
          }
        }}>
          <button onClick={() => (setRenaming(folder.id), setMenu(null))}>Rename</button>
          <button
            onClick={() => {
              if (window.confirm(`Delete “${folder.name}”? Songs will stay in your library.`)) {
                saveName(host.deleteFolder(folder.id))
                if (selected === folder.id) onSelect('all')
              }
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  )

  return (
    <nav ref={nav} className="folder-nav" aria-label="Song folders">
      <div className="folder-scroll">
        <div className="folder-group folder-smart">{automatic.map(item)}</div>
        <div className="folder-group folder-user">
          <p className="folder-heading">Folders</p>
          {user.map(item)}
          {feedback && <p className="folder-feedback" role={feedback.error ? 'alert' : 'status'}>{feedback.message}</p>}
          {creating ? (
            <form
              className="folder-new"
              onSubmit={(event) => {
                event.preventDefault()
                saveName(host.createFolder(String(new FormData(event.currentTarget).get('name') ?? '')))
              }}
            >
              <input name="name" aria-label="Folder name" maxLength={60} autoFocus placeholder="Folder name" onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  setCreating(false)
                }
              }} />
              <button type="submit" className="btn btn-quiet">Create</button>
            </form>
          ) : (
            <button className="folder-add" onClick={() => setCreating(true)}><Plus size={14} /> New folder</button>
          )}
        </div>
      </div>
      {error && <p className="folder-error" role="alert">{error}</p>}
    </nav>
  )
}

function Thumb({ entry }: { entry: Pick<Entry, 'thumbnail' | 'source'> }) {
  const [broken, setBroken] = useState(false)
  if (entry.thumbnail && !broken) return <img className="thumb" src={entry.thumbnail} alt="" loading="lazy" onError={() => setBroken(true)} />
  const Icon = entry.source === 'youtube' ? AudioLines : FileMusic
  return (
    <span className="thumb thumb-blank" data-source={entry.source}>
      <Icon size={22} strokeWidth={1.6} aria-hidden />
    </span>
  )
}

function Queue({ jobs, selected, onChange, onDetails, onOpen }: { jobs: QueueJob[]; selected?: string; onChange: () => void; onDetails: (j: QueueJob) => void; onOpen: (songId: string) => void }) {
  const actionInFlight = useRef(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState<Problem | null>(null)
  const act = async (action: () => Promise<unknown>) => {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setActionBusy(true)
    setActionError(null)
    try {
      await action()
      onChange()
    } catch (reason) {
      setActionError(problem(reason))
    } finally {
      actionInFlight.current = false
      setActionBusy(false)
    }
  }
  const [clockTime, setClockTime] = useState(() => Date.now())
  const [sampled, setSampled] = useState<{ jobId: string; usage: ResourceUsage | null } | null>(null)
  const runningJob = jobs.find((j) => j.status === 'running')
  const running = !!runningJob
  const jobId = runningJob?.id
  const usage = sampled && sampled.jobId === jobId ? sampled.usage : null
  useEffect(() => {
    if (!jobId) return
    let active = true
    const sample = () => void host.resourceUsage().then((value) => {
      if (active) setSampled({ jobId, usage: value })
    }, () => { if (active) setSampled({ jobId, usage: null }) })
    sample()
    const timer = window.setInterval(sample, 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [jobId])
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setClockTime(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  return (
    <section className="queue" aria-labelledby="queue-title">
      <h2 id="queue-title" className="lib-h2">
        {jobs.some((j) => j.status === 'running' || j.status === 'queued') ? 'Transcribing' : 'Needs attention'} <span className="dim num">{jobs.filter((j) => j.status === 'running' || j.status === 'queued').length || ''}</span>
        {running && <span className="queue-usage" aria-label={`Mizan CPU ${usage?.cpu == null ? 'measuring or unavailable' : `${usage.cpu}%`}; RAM ${usage?.ramBytes == null ? 'measuring or unavailable' : `${Math.round(usage.ramBytes / 1048576)} mebibytes`}; GPU and NPU usage unavailable`} title="CPU across all logical processors; RAM is the combined resident working set of the Mizan host and its transcription subprocesses (shared pages may count twice). GPU and NPU utilization counters are not available.">
          CPU {usage?.cpu == null ? '—' : `${usage.cpu}%`} · RAM {usage?.ramBytes == null ? '—' : usage.ramBytes >= 1073741824 ? `${(usage.ramBytes / 1073741824).toFixed(1)} GiB` : `${Math.round(usage.ramBytes / 1048576)} MiB`} · GPU n/a · NPU n/a
        </span>}
      </h2>
      {actionError && <p className="intake-error" role="alert">{actionError.message} {actionError.fix}</p>}
      <ol className="queue-list">
        {jobs.map((j) => {
          const place = j.status === 'queued' ? jobQueuePosition(j, jobs).place - 1 : -1
          const elapsed = j.status === 'running' ? Math.max(0, (clockTime - Date.parse(j.attemptQueuedAt ?? j.startedAt ?? j.createdAt)) / 1000) : null
          const stagePercent = jobStagePercent(j)
          return (
            <li key={j.id} className="job" data-status={j.status} data-selected={j.id === selected || undefined}>
              <Thumb entry={{ thumbnail: j.thumbnail, source: 'youtube' }} />
              <div className="job-main" onClick={selected && selected !== j.id ? () => onDetails(j) : undefined}>
                <p className="job-title">{jobTitle(j)}</p>
                <p className="dim">{jobExecutionLabel(j)}</p>
                <p className="job-state">
                  {j.status === 'running' && (
                    <>
                      {jobStageLabel(j)} <span className="num">{stagePercent == null ? '' : `${stagePercent}% step · `}{j.attemptQueuedAt ? `${took(elapsed!)} elapsed` : j.startedAt ? `${took(elapsed!)} run time` : `${took(elapsed!)} since queued`}</span>
                    </>
                  )}
                  {j.status === 'queued' && jobQueueLabel(j, jobs)}
                  {j.status === 'failed' && <span className="job-error">{j.errorMessage ?? 'Failed.'}</span>}
                  {j.status === 'done' && <>{decodingErrorHeadline(j.decodingErrors?.count) ?? 'Ready'}{!j.decodingErrors?.count && j.warnings[0] && <span className="dim"> · {j.warnings[0]}</span>}</>}
                  {j.status === 'cancelled' && 'Cancelled'}
                  {j.status === 'running' && j.warnings[0] && <span className="dim"> · {j.warnings[0]}</span>}
                </p>
                {j.status === 'running' && (
                  <div className={`bar${stagePercent == null ? ' is-indeterminate' : ''}`}
                    role="progressbar" aria-label={`${jobTitle(j)} ${jobStageLabel(j)} progress`}
                    aria-valuemin={0} aria-valuemax={100} aria-valuenow={stagePercent ?? undefined}>
                    {stagePercent != null && <span style={{ transform: `scaleX(${stagePercent / 100})` }} />}
                  </div>
                )}
                {j.status === 'failed' && j.fix && <p className="job-fix">{j.fix}</p>}
              </div>
              <div className="job-actions">
                {j.status === 'done' && j.songId && (
                  <button className="btn btn-primary" onClick={() => onOpen(j.songId!)}>
                    Open
                  </button>
                )}
                {j.status === 'failed' && (
                  <button className="btn" disabled={actionBusy} onClick={() => void act(() => host.retry(j.id))}>
                    <RotateCcw size={15} aria-hidden /> Retry
                  </button>
                )}
                {place > 0 && (
                  <button className="icon-btn" disabled={actionBusy} title="Move to front" aria-label={`Move ${jobTitle(j)} to the front`} onClick={() => void act(() => host.move(j.id, 0))}>
                    <ArrowUp size={16} />
                  </button>
                )}
                <button className="btn btn-quiet" aria-expanded={j.id === selected} onClick={() => onDetails(j)}>
                  Details
                </button>
                {j.status === 'running' || j.status === 'queued' ? (
                  <button className="icon-btn" disabled={actionBusy} title="Cancel" aria-label={`Cancel ${jobTitle(j)}`} onClick={() => void act(() => host.cancel(j.id))}>
                    <X size={16} />
                  </button>
                ) : (
                  <button className="icon-btn" disabled={actionBusy} title="Dismiss" aria-label={`Dismiss ${jobTitle(j)}`} onClick={() => void act(() => host.dismiss(j.id))}>
                    <X size={16} />
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim()
  if (!q) return text
  const at = text.toLowerCase().indexOf(q.toLowerCase())
  if (at < 0) return text
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + q.length)}</mark>{text.slice(at + q.length)}</>
}

function SongRow({
  entry: e,
  query,
  folders,
  onOpen,
  onChanged,
  onQueued,
  updating,
  onDetails,
}: {
  entry: Entry
  query: string
  folders: Folder[]
  onOpen: () => void
  onChanged: () => void
  onQueued: () => void
  updating?: QueueJob
  onDetails: (job: QueueJob) => void
}) {
  const [confirm, setConfirm] = useState(false)
  const [linking, setLinking] = useState(false)
  const [folderOpen, setFolderOpen] = useState(false)
  const memberships = e.folders
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderError, setFolderError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<Problem | null>(null)
  const [reprocessing, setReprocessing] = useState(false)
  const [linkError, setLinkError] = useState<Problem | null>(null)
  const folderPopover = useRef<HTMLDivElement>(null)
  const imported = e.source !== 'youtube'
  const folderNames = folders.filter((folder) => memberships.includes(folder.id)).map((folder) => folder.name)

  useEffect(() => {
    if (!folderOpen) return
    folderPopover.current?.querySelector<HTMLInputElement>('.folder-popover input')?.focus()
    const close = (event: PointerEvent) => {
      if (!folderPopover.current?.contains(event.target as Node)) setFolderOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [folderOpen])

  const setFolders = async (next: string[]) => {
    setFolderBusy(true)
    setFolderError(null)
    try {
      await host.setSongFolders(e.id, next)
      await onChanged()
    } catch (reason) {
      setFolderError(problem(reason).message)
    } finally {
      setFolderBusy(false)
    }
  }

  return (
    <li
      className="song"
      data-song-id={e.id}
      data-confirm={confirm || undefined}
      draggable={false}
      title="Drag to a folder"
      onDragStart={(event) => event.preventDefault()}
    >
      <span className="song-grip" aria-hidden><GripVertical size={16} /></span>
      <button className="song-open" onClick={onOpen} aria-describedby={`song-${e.id}-meta`}>
        <Thumb entry={e} />
        <span className="song-text">
          <span className="song-title"><Highlight text={e.title} query={query} /></span>
          <span id={`song-${e.id}-meta`} className="song-meta">
            {e.parts.join(' · ')}
            <span className="dim"> · {sourceLine(e)}{e.duration ? ` · ${clock(e.duration)}` : ''}{folderNames.length ? ` · ${folderNames.join(', ')}` : ''}</span>
          </span>
          <span className="song-meta" title={e.source === 'youtube' ? 'The saved analysis, not the model currently selected in settings' : undefined}>
            {imported ? `${e.source === 'midi' ? 'MIDI' : 'MusicXML'} import${e.provider ? ` · ${e.provider}` : ''}${e.license ? ` · ${e.license}` : ''}${e.attribution ? ` · Credit: ${e.attribution}` : ''}` :
              `Notes: ${modelChoices.find((choice) => choice.id === e.transcriptionModel)?.label ?? 'Model not recorded'}${e.separationMethod ? ` · Stems: ${e.separationMethod === 'htdemucs-6s-onnx' ? 'HT-Demucs' : e.separationMethod}` : ''}`}
          </span>
          {(updating || (e.outdated && !imported)) && <span className="song-analysis" role="status">
            {updating ? analysisProgress(updating) : 'Older analysis · redo with the selected model'}
          </span>}
        </span>
        <span className="song-resume" data-fresh={!e.position || undefined}>
          {resumeParts(e.position).map((part, i) => (
            <span key={part}>
              {i > 0 && ' · '}
              {part}
            </span>
          ))}
        </span>
        <span className="song-when dim">{e.practicedAt ? ago(e.practicedAt) : `Added ${ago(e.createdAt)}`}</span>
      </button>
      <div className="song-actions">
        {imported && e.sourceUrl && (
          <a className="song-source-link" href={e.sourceUrl} target="_blank" rel="noreferrer"
            aria-label={`Open ${e.source === 'midi' ? 'MIDI' : 'MusicXML'} source for ${e.title}`}>
            Source <ExternalLink size={13} aria-hidden />
          </a>
        )}
        {confirm ? (
          <>
            <span className="song-ask">Delete this song and its transcription?</span>
            <button className="btn btn-danger" onClick={() => {
              setActionError(null)
              void host.remove(e.id).then(onChanged, (reason) => setActionError(problem(reason)))
            }}>
              Delete
            </button>
            <button className="btn btn-quiet" autoFocus onClick={() => setConfirm(false)}>
              Keep
            </button>
          </>
        ) : (
          <>
            {updating ? <button className="btn btn-quiet" onClick={() => onDetails(updating)}>View progress</button> : !imported && (
              <button className="btn btn-quiet" disabled={reprocessing} title="Redo analysis with the selected model. Reuse saved audio tracks when possible; keep the current result until the new one is ready." onClick={() => {
                setReprocessing(true)
                setActionError(null)
                void host.reprocess(e.id).then(onQueued, (reason) => setActionError(problem(reason))).finally(() => setReprocessing(false))
              }}>
                <RotateCcw size={15} aria-hidden /> {reprocessing ? 'Queuing...' : 'Redo analysis'}
              </button>
            )}
            {imported && !e.recording && !linking && (
              <button className="btn btn-quiet" onClick={() => setLinking(true)}>
                <Link2 size={15} aria-hidden /> Link recording
              </button>
            )}
            <div className="folder-popover-wrap" ref={folderPopover}>
              <button className="icon-btn" title="Folders" aria-label={`Choose folders for ${e.title}`} aria-expanded={folderOpen} onClick={() => setFolderOpen(!folderOpen)}>
                <FolderPlus size={16} />
              </button>
              {folderOpen && (
                <div className="folder-popover" role="dialog" aria-label={`Folders for ${e.title}`} onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    setFolderOpen(false)
                    folderPopover.current?.querySelector<HTMLButtonElement>('button')?.focus()
                  }
                }}>
                  <p>Folders</p>
                  {folders.length === 0 && <span className="folder-popover-empty">No folders yet</span>}
                  {folders.map((folder) => (
                    <label key={folder.id}>
                      <input
                        type="checkbox"
                        disabled={folderBusy}
                        checked={memberships.includes(folder.id)}
                        onChange={(event) => void setFolders(event.target.checked ? [...memberships, folder.id] : memberships.filter((id) => id !== folder.id))}
                      />
                      <span>{folder.name}</span>
                    </label>
                  ))}
                  <form
                    onSubmit={async (event) => {
                      event.preventDefault()
                      if (folderBusy) return
                      const input = event.currentTarget.elements.namedItem('name') as HTMLInputElement
                      setFolderBusy(true)
                      setFolderError(null)
                      try {
                        const folder = await host.createFolder(input.value)
                        await onChanged()
                        await setFolders([...memberships, folder.id])
                        input.value = ''
                      } catch (reason) {
                        setFolderError(problem(reason).message)
                      } finally {
                        setFolderBusy(false)
                      }
                    }}
                  >
                    <Plus size={14} aria-hidden />
                    <input name="name" maxLength={60} placeholder="New folder…" aria-label="New folder name" disabled={folderBusy} />
                    <button className="icon-btn" type="submit" aria-label="Create and assign folder" disabled={folderBusy}><Plus size={14} /></button>
                  </form>
                  {folderError && <span className="folder-error" role="alert">{folderError}</span>}
                </div>
              )}
            </div>
            <button className="icon-btn" title="Delete" aria-label={`Delete ${e.title}`} onClick={() => setConfirm(true)}>
              <Trash2 size={16} />
            </button>
          </>
        )}
      </div>
      {actionError && <p className="song-action-error" role="alert">{actionError.message} {actionError.fix}</p>}
      {linking && (
        <form
          className="song-link"
          onSubmit={(ev) => {
            ev.preventDefault()
            const url = String(new FormData(ev.currentTarget).get('url') ?? '').trim()
            if (!url) return
            host.linkRecording(e.id, url).then(
              () => {
                setLinking(false)
                onQueued()
              },
              (err) => setLinkError(problem(err)),
            )
          }}
        >
          <label className="intake-field">
            <Link2 size={16} aria-hidden />
            <span className="visually-hidden">YouTube link of a recording of {e.title}</span>
            <input name="url" autoFocus autoComplete="off" spellCheck={false} placeholder="YouTube link of a recording" onKeyDown={(k) => k.key === 'Escape' && setLinking(false)} />
          </label>
          <button className="btn btn-primary" type="submit">
            Line up
          </button>
          <button className="btn btn-quiet" type="button" onClick={() => setLinking(false)}>
            Cancel
          </button>
          <p className="song-link-help" role={linkError ? 'alert' : undefined}>
            {linkError ? (
              <>
                <strong>{linkError.message}</strong> {linkError.fix}
              </>
            ) : (
              'Mizan lines the file up with the recording by itself, following any tempo changes.'
            )}
          </p>
        </form>
      )}
    </li>
  )
}
