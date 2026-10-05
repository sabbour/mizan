import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, AudioLines, ChevronDown, Ellipsis, ExternalLink, FileMusic, FolderOpen, FolderPlus, GripVertical, Info, Link2, Plus, RotateCcw, Search, Settings2, Trash2, X } from 'lucide-react'
import { host, HostError, IMPORTABLE, toBase64, type CloudStatus, type Entry, type Folder, type ModelDownloads, type ModelPreflight, type ProcessingMode, type QueueJob, type ResourceUsage, type TranscriptionModel, type YouTubeResult } from './bridge'
import { CloudSetup } from './CloudSetup'
import { createCloudOperationGate } from './cloudOperation'
import { activeAnalysis, analysisProgress, ago, clock, decodingErrorHeadline, jobExecutionLabel, jobQueueLabel, jobQueuePosition, jobTitle, jobStageLabel, jobStagePercent, resumeParts, sourceLine, took } from './format'
import './library.css'

type Problem = { message: string; fix: string | null }
const problem = (e: unknown): Problem =>
  e instanceof HostError ? { message: e.message, fix: e.fix } : { message: 'Something went wrong talking to Mizan.', fix: 'Try again.' }

type Props = {
  jobs: QueueJob[]
  version: number
  onQueueChange: () => void
  onOpen: (entry: Entry) => void
  onDetails: (job: QueueJob) => void
  selectedJob?: string
  onCredits: () => void
}

type LibraryFolder = { id: string; name: string; count: number; user?: boolean }
const DAY = 86_400_000
const modelChoices: { id: TranscriptionModel; label: string; detail: string; info: string }[] = [
  { id: 'muscriptor-small', label: 'MuScriptor Small', detail: 'The smallest multi-instrument model, with the lowest memory needs.', info: '103M parameters · 412 MB download' },
  { id: 'muscriptor-medium', label: 'MuScriptor Medium', detail: 'A middle-sized multi-instrument model. Processing time depends on your hardware and the song.', info: '307M parameters · 1.23 GB download' },
  { id: 'muscriptor-large', label: 'MuScriptor Large', detail: 'The largest multi-instrument model; requires the most memory and disk space.', info: '1.4B parameters · 5.47 GB download' },
]
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

export function Library({ jobs, version, onQueueChange, onOpen, onDetails, selectedJob, onCredits }: Props) {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [selectedFolder, setSelectedFolder] = useState('all')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<Problem | null>(null)
  const [folderFeedback, setFolderFeedback] = useState<{ message: string; error: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingLinks, setPendingLinks] = useState<string[]>([])
  const pendingLinkRequests = useRef(new Set<string>())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [cloud, setCloud] = useState<CloudStatus | null>(null)
  const [cloudStatusChecking, setCloudStatusChecking] = useState(false)
  const [cloudOperationBusy, setCloudOperationBusy] = useState(false)
  const [cloudOperationLabel, setCloudOperationLabel] = useState<string | null>(null)
  const [cloudError, setCloudError] = useState<string | null>(null)
  const [cloudWizardOpen, setCloudWizardOpen] = useState(false)
  const [cloudOperationGate] = useState(createCloudOperationGate)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [model, setModel] = useState<TranscriptionModel | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [modelBusy, setModelBusy] = useState(false)
  const [downloads, setDownloads] = useState<ModelDownloads | null>(null)
  const [preflight, setPreflight] = useState<ModelPreflight | null>(null)
  const [preflightError, setPreflightError] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<{ model: TranscriptionModel; message: string } | null>(null)
  const [downloadStatusError, setDownloadStatusError] = useState<string | null>(null)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [accessOpen, setAccessOpen] = useState(false)
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
  const cloudWizardOpenRef = useRef(false)
  const cloudStatusCheckRef = useRef<symbol | null>(null)
  const cloudStatusLastCheckRef = useRef<symbol | null>(null)
  const cloudStatusCancelRef = useRef<(() => void) | null>(null)
  const aboutButton = useRef<HTMLButtonElement>(null)
  const aboutDialog = useRef<HTMLDialogElement>(null)
  const songs = useRef<HTMLElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const isLink = /^https?:\/\//i.test(query.trim())
  const searchQuery = isLink ? '' : query
  const cloudStatusText = cloudStatusChecking ? 'Checking Azure setup…'
    : cloudOperationBusy ? cloudOperationLabel ?? 'Updating settings…'
      : cloudError ? 'Azure access check failed'
        : cloud === null ? 'Cloud status unavailable'
          : cloud.configured
            ? cloud.mode === 'cloud' ? 'Cloud is on for new and redone analyses' : 'Azure is ready · Processing is Local'
            : cloud.mode === 'cloud' ? 'Cloud selected · Azure is not ready; no Local fallback'
              : cloud.jobCreated ? 'GPU Job created · Azure access needs checking'
              : cloud.prepared ? 'Azure infrastructure prepared · setup not complete'
                : cloud.config ? 'Azure settings saved · setup not complete' : 'Cloud is not set up'
  const cloudActionText = cloudOperationBusy ? 'Working…'
    : cloudError || cloud === null ? 'Retry check'
      : cloud.configured ? 'Review Azure setup'
        : cloud.jobCreated ? 'Check Azure access'
          : cloud.config ? 'Continue Azure setup' : 'Set up Azure'

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
  const acquireCloudOperation = useCallback((label = 'Updating Azure setup…') => {
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
  const checkCloudStatus = useCallback(() => {
    const release = acquireCloudOperation('Checking Azure setup…')
    if (!release) return null
    const token = Symbol()
    const requestId = crypto.randomUUID()
    cloudStatusCheckRef.current = token
    cloudStatusLastCheckRef.current = token
    let active = true
    setCloudStatusChecking(true)
    setCloudError(null)
    const cancel = () => {
      active = false
      if (cloudStatusCheckRef.current === token) {
        cloudStatusCheckRef.current = null
        cloudStatusCancelRef.current = null
        setCloudStatusChecking(false)
        void host.cancelCloudStatus(requestId).catch((reason) => {
          if (cloudStatusLastCheckRef.current === token) setCloudError(problem(reason).message)
        })
      }
      release()
    }
    cloudStatusCancelRef.current = cancel
    void host.cloudStatus(requestId).then(
      (status) => {
        if (active && cloudStatusCheckRef.current === token) setCloud(status)
      },
      (reason) => {
        if (active && cloudStatusCheckRef.current === token) setCloudError(problem(reason).message)
      },
    ).finally(() => {
      if (active && cloudStatusCheckRef.current === token) {
        cloudStatusCheckRef.current = null
        cloudStatusCancelRef.current = null
        setCloudStatusChecking(false)
      }
      release()
    })
    return cancel
  }, [acquireCloudOperation])
  useEffect(() => {
    if (!settingsOpen) return
    return checkCloudStatus() ?? undefined
  }, [settingsOpen, checkCloudStatus])
  useEffect(() => {
    if (!settingsOpen) return
    let active = true
    void host.getTranscriptionModel().then(
      (selected) => { if (active) { setModel(selected); setModelError(null); setAccessOpen(true) } },
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
      if (aboutOpen) return
      if (event.key === 'Escape' && settingsOpen) {
        event.preventDefault()
        setSettingsOpen(false)
        setTokenDraft('')
        settingsButton.current?.focus()
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
  }, [query, selectedJob, cancelSongDrag, settingsOpen, aboutOpen])

  const chooseModel = async (selected: TranscriptionModel) => {
    const release = acquireCloudOperation('Saving analysis settings…')
    if (!release) return
    setModelBusy(true)
    setModelError(null)
    setDownloadError(null)
    try {
      setModel(await host.setTranscriptionModel(selected))
      setAccessOpen(true)
    } catch (reason) {
      setModelError(problem(reason).message)
    } finally {
      setModelBusy(false)
      release()
      if (cloud?.mode !== 'cloud')
        void host.modelPreflight().then(setPreflight, (reason) => setPreflightError(problem(reason).message))
    }
  }
  const openCloudWizard = () => {
    if (cloudOperationGate.isLocked() || cloudWizardOpenRef.current) return
    cloudWizardOpenRef.current = true
    setCloudWizardOpen(true)
  }
  const closeCloudWizard = () => {
    cloudWizardOpenRef.current = false
    setCloudWizardOpen(false)
    settingsButton.current?.focus()
  }
  const chooseMode = async (mode: ProcessingMode) => {
    const readinessCancelled = cloudStatusChecking
    if (readinessCancelled) cloudStatusCancelRef.current?.()
    if (cloudOperationGate.isLocked()) return
    if (mode === 'cloud' && cloud && !cloud.configured && !cloud.jobCreated) {
      openCloudWizard()
      return
    }
    const release = acquireCloudOperation('Changing processing mode…')
    if (!release) return
    setCloudError(null)
    try {
      const selected = await host.setProcessingMode(mode)
      setCloud((current) => ({
        ...(current ?? { configured: false }),
        ...(readinessCancelled ? { configured: false } : {}),
        mode: selected,
      }))
    } catch (reason) {
      setCloudError(problem(reason).message)
    } finally {
      release()
    }
  }
  const disconnectCloud = async () => {
    if (cloudOperationGate.isLocked() || !window.confirm(
      'Disconnect Azure from Mizan?\n\nMizan will forget its saved Azure setup and use Local processing for new songs. Azure resources and running Jobs will not be deleted or stopped, so charges may continue. Your saved Hugging Face token will remain in Windows Credential Manager.',
    )) return
    const release = acquireCloudOperation('Disconnecting Azure from Mizan…')
    if (!release) return
    setCloudError(null)
    try {
      setCloud(await host.clearCloud())
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
        if (enteredLink) setQuery((current) => current.trim() === submitted ? '' : current)
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
      setBusy(true)
      try {
        let last: Entry | null = null
        for (const f of files) last = await host.importFile(f.name, await toBase64(f))
        await reload()
        if (files.length === 1 && last) onOpen(last)
      } catch (e) {
        setError(problem(e))
      } finally {
        setBusy(false)
      }
    },
    [reload, onOpen],
  )

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
    const q = searchQuery.trim().toLowerCase()
    return folderEntries.filter((entry) => {
      const names = folders.filter((folder) => entry.folders.includes(folder.id)).map((folder) => folder.name)
      const source = entry.source === 'youtube' ? 'youtube' : entry.source === 'midi' ? 'midi imported' : 'musicxml imported'
      return !q || [entry.title, entry.artist, ...entry.parts, source, ...names].some((value) => value?.toLowerCase().includes(q))
    })
  }, [folderEntries, folders, searchQuery])

  const empty = entries !== null && entries.length === 0 && jobs.length === 0 && folders.length === 0 && !searchQuery
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
            onClick={() => { setTokenDraft(''); setHfError(null); setSettingsOpen((open) => !open) }}>
            <Settings2 size={16} aria-hidden /> Song analysis
          </button>
          <button ref={aboutButton} type="button" className="lib-credits lib-about" aria-label="About Mizan"
            onClick={() => { setSettingsOpen(false); setTokenDraft(''); setAboutOpen(true) }}>
            <Info size={16} aria-hidden /> <span>About</span>
          </button>
        </div>
        {settingsOpen && (
          <section id="model-settings" className="model-settings" aria-labelledby="model-settings-title">
            <div className="model-settings-head">
              <h2 id="model-settings-title">How Mizan finds notes</h2>
              <button type="button" className="model-settings-close" aria-label="Close song analysis settings"
                onClick={() => { setSettingsOpen(false); setTokenDraft(''); settingsButton.current?.focus() }}>
                <X size={18} aria-hidden />
              </button>
            </div>
            <p className="model-settings-intro">Choose how Mizan processes new songs. Your saved songs won't change.</p>
            <fieldset className="cloud-mode" disabled={cloudOperationBusy && !cloudStatusChecking}>
              <legend>Processing</legend>
              <label><input type="radio" name="processing-mode" checked={cloud?.mode === 'local'}
                onChange={() => void chooseMode('local')} /> Local <small>Process on this PC</small></label>
              <label><input type="radio" name="processing-mode" checked={cloud?.mode === 'cloud'}
                onChange={() => void chooseMode('cloud')} /> Cloud <small>Use your own Azure GPU</small></label>
            </fieldset>
            <p className="model-settings-source">Processing selection applies to new analysis and Redo analysis. Queued and running jobs keep their chosen model and processing mode.</p>
            <div className="cloud-status" aria-busy={cloudOperationBusy}>
              <span role="status" aria-live="polite">
                {cloudOperationBusy && <span className="cloud-inline-spinner" aria-hidden="true" />}
                {cloudStatusText}
              </span>
              <button type="button" className="btn" disabled={cloudOperationBusy || (!cloud && !cloudError)}
                onClick={() => cloudError || !cloud ? void checkCloudStatus() : openCloudWizard()}>
                {cloudActionText}
              </button>
              {cloudStatusChecking && <button type="button" className="btn btn-quiet" onClick={() => {
                cloudStatusCancelRef.current?.()
                setCloudError('Azure readiness check cancelled. Processing selection is unchanged.')
              }}>Cancel check</button>}
            </div>
            {cloud?.issue && <p className="model-settings-source" role={!cloud.configured ? 'alert' : undefined}>{cloud.issue}</p>}
            {cloudError && <p className="model-settings-error" role="alert">{cloudError}</p>}
            {cloud?.config && <details className="cloud-connection-details">
              <summary>Azure connection options</summary>
              <p>Disconnecting makes Mizan forget its saved Azure setup and selects Local processing for new songs. It does not delete Azure resources or stop running Jobs, and charges may continue. Your saved Hugging Face token remains in Windows Credential Manager.</p>
              <button type="button" className="btn cloud-remove" disabled={cloudOperationBusy}
                onClick={() => void disconnectCloud()}>Disconnect Azure from Mizan</button>
            </details>}
            <fieldset className="model-settings-choices" disabled={cloudOperationBusy || modelBusy || model === null}>
              <legend className="visually-hidden">Choose how to find notes</legend>
              {modelChoices.map((choice) => {
                const status = downloads?.[choice.id]
                const capacity = preflight?.[choice.id]
                return (
                  <div className="model-settings-item" key={choice.id}>
                    <label className="model-settings-choice">
                      <input type="radio" name="transcription-model" value={choice.id} checked={model === choice.id}
                        disabled={cloud?.mode === 'cloud'
                          ? !cloud.supportedModels?.includes(choice.id)
                          : !capacity?.eligible}
                        onChange={() => void chooseModel(choice.id)} />
                      <span><strong>{choice.label}</strong>
                        <small>{choice.detail}</small>
                        <small className="model-settings-metadata">{choice.info} · {cloud?.mode === 'cloud' ? 'Azure GPU' : 'CPU'}</small>
                        {cloud?.mode === 'cloud' && !cloud.supportedModels?.includes(choice.id)
                          && <small className="model-settings-incompatible">Not supported by this Cloud worker</small>}
                        {cloud?.mode !== 'cloud' && <small className={capacity?.reason ? 'model-settings-incompatible' : ''}>
                          {capacity?.reason ?? (capacity
                            ? `${capacity.requiredRamGiB} GiB free RAM needed · ${capacity.freeRamGiB} GiB available`
                            : preflightError ?? 'Checking this PC…')}
                        </small>}</span>
                    </label>
                      {cloud?.mode !== 'cloud' && <div className="model-settings-download" aria-live="polite">
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
            {cloud?.mode !== 'cloud' && hfConfigured === false && <p className="model-settings-source">Save a Hugging Face token below to enable model downloads.</p>}
            <p className="model-settings-source">MuScriptor reads the original recording. Official models by Kyutai and Mirelo; noncommercial license.</p>
            {model === null && !modelError && <p role="status">Loading model choice…</p>}
            {modelError && <p className="model-settings-error" role="alert">{modelError}</p>}
            {cloud?.mode !== 'cloud' && downloadStatusError && <p className="model-settings-error" role="alert">{downloadStatusError}</p>}
            <section className="model-settings-stems" aria-labelledby="stem-settings-title">
              <h3 id="stem-settings-title">Listen to instruments separately</h3>
              <div><strong>HT-Demucs</strong><span>Always on · {cloud?.mode === 'cloud' ? 'Azure GPU' : 'CPU'}</span></div>
              <p>Separates vocals, drums, bass, guitar, piano, and an Other stem for remaining sounds. Other is a mix of instruments, not a separate recording for every detected score. This stays on whichever note-finding option you choose.</p>
            </section>
            {cloud?.mode !== 'cloud' && <details className="model-settings-access" open={accessOpen}
              onToggle={(event) => setAccessOpen(event.currentTarget.open)}>
              <summary>
                <span>Hugging Face account & access</span>
                <span role="status">{hfConfigured === null ? 'Checking token…' : hfConfigured ? 'Token saved' : 'No token saved'}</span>
                <ChevronDown size={16} aria-hidden />
              </summary>
              <div className="model-settings-access-body">
              <p><a href="https://huggingface.co/join" target="_blank" rel="noopener noreferrer">Create a Hugging Face account</a> and sign in. Open each model you want above and accept its terms. Then <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener noreferrer">create a read-access token</a> and save it here. Mizan stores it on this PC in Windows Credential Manager.</p>
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
                  } catch (reason) {
                    setHfError(problem(reason).message)
                  } finally {
                    setHfBusy(false)
                  }
                }}>Remove token</button>}
              </div>
            </form>
              {hfError && <p className="model-settings-error" role="alert">{hfError}</p>}
              </div>
            </details>}
          </section>
        )}
      </header>
      {cloudWizardOpen && <CloudSetup status={cloud} onStatus={setCloud} acquireOperation={acquireCloudOperation}
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
              else songs.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}
          >
            <label className="intake-field intake-unified">
              {isLink ? <Link2 size={18} aria-hidden /> : <Search size={18} aria-hidden />}
              <span className="visually-hidden">Search your library and YouTube, or paste a link</span>
              <input
                ref={field}
                name="url"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder="Search your library and YouTube, or paste a link"
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
              <p>MuScriptor makes draft notes for instruments it can identify in the recording. MIDI and MusicXML files open straight away. You can also drop files or links anywhere.</p>
            )}
          </div>
        </section>

        {empty && (
          <p className="library-first-note">
            <FileMusic size={19} aria-hidden />
            Your songs and practice progress will appear here. Paste a YouTube link above or import a MIDI or MusicXML file to begin.
          </p>
        )}

        {queueJobs.length > 0 && <Queue jobs={queueJobs} selected={selectedJob} onChange={onQueueChange} onDetails={onDetails} onOpen={(id) => entries && onOpenId(id, entries, onOpen)} />}

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
            </section>
          </div>
        )}
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
    </div>
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
  const [result, setResult] = useState<{ query: string; entries: YouTubeResult[]; error: Problem | null } | null>(null)
  const [retry, setRetry] = useState(0)
  const [loading, setLoading] = useState(false)
  const flight = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    if (!query) return
    let stale = false
    const timer = window.setTimeout(() => {
      setLoading(true)
      flight.current = flight.current.then(async () => {
        if (stale) return
        try {
          const entries = await host.searchYouTube(query)
          if (!stale) setResult({ query, entries, error: null })
        } catch (error) {
          if (!stale) setResult({ query, entries: [], error: problem(error) })
        } finally {
          if (!stale) setLoading(false)
        }
      })
    }, 350)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [query, retry])

  if (!query) return null
  const waiting = loading || result?.query !== query
  return (
    <section className="youtube-results" aria-labelledby="youtube-title" aria-busy={waiting}>
      <h2 id="youtube-title" className="lib-h2">YouTube <span className="dim num">{!waiting && !result?.error ? result?.entries.length : ''}</span></h2>
      <p className="youtube-help">Choose a recording to transcribe. Audio is only downloaded when you choose Transcribe.</p>
      {waiting ? <p className="songs-note" role="status">Searching YouTube…</p> : result?.error ? (
        <div className="youtube-error">
          <p role="alert">{result.error.message} {result.error.fix}</p>
          <button className="btn btn-quiet" onClick={() => setRetry((value) => value + 1)}>Retry YouTube search</button>
        </div>
      ) : result?.entries.length === 0 ? <p className="songs-note" role="status">No YouTube videos match “{query}”. Your local results are above.</p> : (
        <ol className="youtube-list">
          {result?.entries.map((video) => {
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
            {imported ? `${e.source === 'midi' ? 'MIDI' : 'MusicXML'} import` :
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
