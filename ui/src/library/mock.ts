import { buildSong } from '../workspace/song'
import type { Entry, Folder, MidiSearchResult, ModelDownloads, PopularChart, QueueJob, Stage, Stem, TranscriptionModel } from './bridge'
import { foldSearchText } from './searchText'

// A stand-in host for the browser dev server: same calls and shapes as the Python bridge.

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const STAGES: Stage[] = ['inspect', 'download', 'decode', 'detect', 'separate', 'transcribe', 'chords', 'notation', 'finalize']

const entries: Entry[] = [
  {
    id: 's1', title: 'Paper Rain', artist: 'Mizan Sessions', thumbnail: null, source: 'youtube', parts: ['Piano', 'Drum kit'], recording: true, duration: 196,
    createdAt: ago(60 * 30), practicedAt: ago(95), outdated: false, transcriptionModel: 'muscriptor-medium', separationMethod: 'htdemucs-6s-onnx',
    folders: ['f1'],
    position: { bar: 34, loop: { startBar: 33, endBar: 38 }, loopName: null, rate: 0.75, trackId: 'piano', muted: ['piano'], solo: [] },
  },
  {
    id: 's2', title: 'Beethoven — Für Elise', artist: 'Lang Lang', thumbnail: 'https://i.ytimg.com/vi/wfF0zHeU3Zs/mqdefault.jpg', source: 'youtube', parts: ['Piano'],
    recording: true, duration: 175, createdAt: ago(60 * 26), practicedAt: ago(60 * 22), outdated: false, transcriptionModel: 'muscriptor-small', separationMethod: 'htdemucs-6s-onnx',
    folders: ['f1', 'f2'],
    position: { bar: 12, loop: null, rate: 1, trackId: 'piano', muted: [], solo: [] },
  },
  {
    id: 's3', title: 'Take Five', artist: 'The Dave Brubeck Quartet', thumbnail: null, source: 'midi', parts: ['Piano', 'Drum kit', 'Bass'], recording: false, duration: 324,
    createdAt: ago(60 * 50), practicedAt: null, outdated: false, position: null, transcriptionModel: null, separationMethod: null,
    folders: ['f2'],
  },
  {
    id: 's4', title: 'Clair de Lune', artist: 'Claude Debussy', thumbnail: null, source: 'musicxml', parts: ['Piano'], recording: true, duration: 301,
    createdAt: ago(60 * 24 * 6), practicedAt: ago(60 * 24 * 4), outdated: false, transcriptionModel: null, separationMethod: null,
    folders: ['f1'],
    position: { bar: 15, loop: { startBar: 15, endBar: 18 }, loopName: null, rate: 0.6, trackId: 'piano', muted: [], solo: [] },
  },
  {
    id: 's5', title: 'Stevie Wonder — Superstition', artist: 'Stevie Wonder', thumbnail: null, source: 'youtube', parts: ['Drum kit'], recording: true, duration: 245,
    createdAt: ago(60 * 24 * 20), practicedAt: ago(60 * 24 * 12), outdated: true, transcriptionModel: null, separationMethod: null,
    folders: [],
    position: { bar: 9, loop: { startBar: 1, endBar: 8 }, loopName: 'Intro', rate: 0.85, trackId: 'drums', muted: [], solo: [] },
  },
  { id: 's6', title: 'Blue Monk', artist: 'Thelonious Monk', thumbnail: null, source: 'youtube', parts: ['Piano'], recording: true, duration: 219, createdAt: ago(60 * 24 * 2), practicedAt: null, outdated: false, transcriptionModel: 'muscriptor-small', separationMethod: 'htdemucs-6s-onnx', position: null, folders: ['f2'] },
  { id: 's7', title: 'Rosanna', artist: 'Toto', thumbnail: null, source: 'youtube', parts: ['Drum kit'], recording: true, duration: 331, createdAt: ago(60 * 24 * 3), practicedAt: null, outdated: false, transcriptionModel: 'muscriptor-large', separationMethod: 'htdemucs-6s-onnx', position: null, folders: [] },
  { id: 's8', title: 'Gymnopédie No. 1', artist: 'Erik Satie', thumbnail: null, source: 'musicxml', parts: ['Piano'], recording: false, duration: 188, createdAt: ago(60 * 24 * 9), practicedAt: null, outdated: false, transcriptionModel: null, separationMethod: null, position: null, folders: ['f1'] },
  { id: 's9', title: 'Funky Drummer', artist: 'James Brown', thumbnail: null, source: 'midi', parts: ['Drum kit'], recording: false, duration: 303, createdAt: ago(60 * 24 * 18), practicedAt: null, outdated: false, transcriptionModel: null, separationMethod: null, position: null, folders: ['f2'] },
]

let folders: Folder[] = [
  { id: 'f1', name: 'Repertoire', count: 0 },
  { id: 'f2', name: 'Grooves', count: 0 },
]
const recount = () => {
  folders = folders.map((folder) => ({ ...folder, count: entries.filter((entry) => entry.folders.includes(folder.id)).length }))
}
recount()

const BASE = [2.2, 6.2, 0.6, 1.1, 7.7, 7.1, 2.8, 0.9, 0.3]
const MODEL: Record<string, string> = { separate: 'HT-Demucs 6s', transcribe: 'MuScriptor Small · CPU', chords: 'Beat This! · Chroma templates', detect: 'Stem RMS (priority only)' }
const stageRows = (upTo: number): QueueJob['stages'] =>
  STAGES.map((name, i) => ({
    name,
    seconds: i < upTo ? BASE[i] : null,
    estimate: BASE[i] * 1.08,
    provider: i < upTo ? (name === 'chords' ? 'DirectML + CPU' : name === 'download' || name === 'inspect' ? null : 'CPU') : null,
    method: i < upTo ? ({ separate: 'htdemucs-6s-onnx', transcribe: 'muscriptor-small-pytorch-cpu', chords: 'chroma-templates-contiguous-v2', detect: 'stem-rms-priority-v2' } as Record<string, string>)[name] ?? null : null,
    model: i < upTo ? MODEL[name] ?? null : null,
  }))

const CHORDS = ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'E7']
const found = (upTo: number): QueueJob['found'] => {
  const f: NonNullable<QueueJob['found']> = {}
  if (upTo > STAGES.indexOf('separate')) f.stems = clips()
  if (upTo > STAGES.indexOf('transcribe')) f.tempo = 112
  if (upTo > STAGES.indexOf('chords')) {
    f.key = 'A minor'
    f.chords = Array.from({ length: 48 }, (_, k) => ({ time: 6 + k * 4.3, label: CHORDS[k % CHORDS.length] }))
  }
  return upTo > STAGES.indexOf('separate') ? f : null
}

// Twelve-second WAV clips cover the demo's four-bar loop during workspace playback.
let cached: Record<'mix' | 'piano' | 'drums', string> | null = null
function clips() {
  if (cached) return cached
  const rate = 22050
  const make = (fn: (t: number) => number) => {
    const n = rate * 12
    const view = new DataView(new ArrayBuffer(44 + n * 2))
    const text = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)))
    text(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); text(8, 'WAVEfmt '); view.setUint32(16, 16, true)
    view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true)
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, n * 2, true)
    for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, fn(i / rate))) * 0x5fff, true)
    return URL.createObjectURL(new Blob([view], { type: 'audio/wav' }))
  }
  const piano = (t: number) => {
    const f = [220, 174.6, 261.6, 196][Math.floor(t) % 4]
    const e = Math.exp(-3 * (t % 1))
    return 0.3 * e * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 1.5 * t) + 0.4 * Math.sin(2 * Math.PI * f * 2 * t))
  }
  const drums = (t: number) => {
    const b = t % 0.5
    const kick = Math.floor(t * 2) % 2 ? 0 : Math.sin(2 * Math.PI * 60 * b) * Math.exp(-18 * b)
    const hat = (Math.random() * 2 - 1) * Math.exp(-60 * (t % 0.25)) * 0.25
    return 0.8 * kick + hat
  }
  cached = { piano: make(piano), drums: make(drums), mix: make((t) => 0.7 * piano(t) + 0.6 * drums(t)) }
  return cached
}

let seq = 10
const job = (over: Partial<QueueJob>): QueueJob => ({
  id: `j${seq++}`, kind: 'transcribe', songId: null, url: '', title: null, thumbnail: null, status: 'queued', stage: 'inspect',
  progress: 0, order: 0, errorCode: null, errorMessage: null, fix: null, warnings: [], detected: null, stages: stageRows(0),
  createdAt: ago(0), updatedAt: ago(0), duration: 249, stageProgress: null, eta: { seconds: 31, low: 26, high: 40 }, found: null,
  ...over,
})

const jobs: QueueJob[] = [
  job({ url: 'https://www.youtube.com/watch?v=aGSKrC7dGcY', title: 'Tears for Fears — Everybody Wants to Rule the World',
    status: 'running', progress: 0.38, startedAt: ago(2), order: 0 }),
  job({ url: 'https://www.youtube.com/watch?v=hTWKbfoikeg', title: 'Nirvana — Smells Like Teen Spirit', order: 1 }),
  job({
    url: 'https://www.youtube.com/watch?v=xxxxxxxxxxx', title: 'Live at the Blue Room (unlisted)', status: 'failed', stage: 'download', progress: 0.12, order: 2,
    errorCode: 'download_forbidden', errorMessage: 'YouTube refused the download for this video.',
    fix: 'Check the video plays in your browser without signing in, then retry.', stages: stageRows(1), eta: null,
  }),
]

function advance() {
  const running = jobs.find((j) => j.status === 'running')
  if (!running) {
    const next = jobs.filter((j) => j.status === 'queued').sort((a, b) => a.order - b.order)[0]
    if (next) {
      next.status = 'running'
      next.startedAt = ago(0)
    }
    return
  }
  running.progress = Math.min(1, running.progress + 0.012)
  const i = Math.min(STAGES.length - 1, Math.floor(running.progress * STAGES.length))
  if (running.stage !== STAGES[i] || !running.stageStartedAt) running.stageStartedAt = ago(0)
  running.stage = STAGES[i]
  running.stages = stageRows(i)
  running.stageProgress = null
  const left = (1 - running.progress) / 0.024
  running.eta = { seconds: left, low: left * 0.85, high: left * 1.3 }
  running.found = found(i)
  if (i >= 3 && !running.detected) {
    running.detected = { piano: 0.91, drums: 0.34 }
    running.selectedInstruments = ['piano', 'drums']
  }
  if (i > STAGES.indexOf('transcribe')) {
    running.transcribedInstruments = ['piano', 'drums']
    running.transcriptionQuality = {
      piano: { status: 'usable', confidence: 'medium', eventCount: 120, meanEventConfidence: 0.7,
        stemRms: 0.1, stemLevel: 0.91, rhythmicConsistency: 0.8, reasons: [] },
      drums: { status: 'tentative', confidence: 'low', eventCount: 48, meanEventConfidence: 0.4,
        stemRms: 0.03, stemLevel: 0.34, rhythmicConsistency: 0.6, reasons: ['Transcription event confidence is low.'] },
    }
    running.warnings = ['Drums: tentative / low confidence. Transcription event confidence is low.']
  }
  running.updatedAt = ago(0)
  if (running.progress >= 1) {
    running.status = 'done'
    running.stageStartedAt = null
    running.stages = stageRows(STAGES.length)
    running.eta = null
    running.stageProgress = null
    running.found = found(STAGES.length)
    const existing = entries.find((entry) => entry.id === running.songId)
    if (existing) {
      existing.outdated = false
      existing.transcriptionModel = running.transcriptionModel ?? 'muscriptor-small'
      existing.separationMethod = 'htdemucs-6s-onnx'
    } else {
      const id = `s${seq++}`
      running.songId = id
      entries.unshift({
        id, title: running.title ?? 'Untitled', artist: null, thumbnail: running.thumbnail, source: 'youtube', parts: ['Piano'], recording: true,
        duration: 250, createdAt: ago(0), practicedAt: null, outdated: false, transcriptionModel: running.transcriptionModel ?? 'muscriptor-small', separationMethod: 'htdemucs-6s-onnx', position: null, folders: [],
      })
    }
    jobs.forEach((j) => j.status === 'queued' && j.order--)
  }
}
setInterval(advance, 500)

const ok = <T extends object>(v: T) => Promise.resolve({ ok: true as const, ...v })
const fail = (code: string, message: string, fix?: string) => Promise.resolve({ ok: false as const, error: { code, message, fix } })
const find = (id: string) => jobs.find((j) => j.id === id)
const visible = () => jobs.filter((j) => j.status !== 'cancelled' && j.order > -100).sort((a, b) => a.order - b.order)
const scores = new Map<string, ReturnType<typeof buildSong>>()
const score = (entry: Entry) => {
  if (!scores.has(entry.id)) {
    const song = buildSong()
    song.title = entry.title
    song.tracks = song.tracks.filter((track) => track.group === 'creative' || entry.parts.includes(track.name))
    if (!song.tracks.some((track) => track.group !== 'creative' && track.instrument === 'piano')) song.piano = []
    if (!song.tracks.some((track) => track.group !== 'creative' && track.instrument === 'drums')) song.drums = []
    if (!song.tracks.some((track) => track.group !== 'creative' && track.instrument === 'vocals')) song.vocals = []
    scores.set(entry.id, song)
  }
  return scores.get(entry.id)!
}

let mockHfConfigured = false
let mockModel: TranscriptionModel = 'muscriptor-small'
const mockDownloads: ModelDownloads = {
  'muscriptor-small': { downloaded: false, active: false, bytesReceived: 0, totalBytes: 411888600, bytesPerSecond: null, error: null },
  'muscriptor-medium': { downloaded: false, active: false, bytesReceived: 0, totalBytes: 1228144472, bytesPerSecond: null, error: null },
  'muscriptor-large': { downloaded: false, active: false, bytesReceived: 0, totalBytes: 5465642136, bytesPerSecond: null, error: null },
}
export const mockHost = {
  model_download_status: () => ok({ models: structuredClone(mockDownloads) }),
  cloud_status: () => ok({ available: false, configured: false, mode: 'local' as const,
    issue: 'Cloud setup needs the installed Mizan app.' }),
  cloud_setup_progress: () => ok({ operation: null, stage: '', completed: 0, total: 0, detail: null }),
  cancel_cloud_setup: () => ok({ cancelRequested: false }),
  azure_subscriptions: () => fail('host_required', 'Azure subscription discovery needs the installed Mizan app.'),
  configure_cloud: () => fail('host_required', 'Cloud setup needs the installed Mizan app.'),
  prepare_cloud: () => fail('host_required', 'Azure provisioning needs the installed Mizan app.'),
  enable_cloud_logging: () => fail('host_required', 'Azure log configuration needs the installed Mizan app.'),
  build_cloud_worker: () => fail('host_required', 'Azure image build needs the installed Mizan app.'),
  finish_cloud: () => fail('host_required', 'Azure Job creation needs the installed Mizan app.'),
  set_processing_mode: (mode: string) => mode === 'local'
    ? ok({ mode: 'local' as const })
    : fail('cloud_not_ready', 'Cloud processing needs the installed Mizan app and a working Azure Job.'),
  clear_cloud: () => ok({ configured: false, mode: 'local' as const }),
  start_model_download(model: TranscriptionModel) {
    if (!Object.hasOwn(mockDownloads, model))
      return fail('invalid_transcription_model', 'Choose a MuScriptor size to download.')
    if (!mockHfConfigured) return fail('missing_token', 'Save a Hugging Face token to download this model.')
    const status = mockDownloads[model as keyof ModelDownloads]
    if (status.active || status.downloaded) return fail('download_in_progress', 'This model is already downloading or ready.')
    status.active = true
    status.error = null
    status.bytesPerSecond = 55_000_000
    const timer = setInterval(() => {
      status.bytesReceived = Math.min(status.totalBytes, status.bytesReceived + status.totalBytes / 15)
      if (status.bytesReceived >= status.totalBytes) {
        status.active = false
        status.downloaded = true
        status.bytesPerSecond = null
        clearInterval(timer)
      }
    }, 200)
    return ok({})
  },
  get_transcription_model: () => ok({ model: mockModel }),
  model_preflight: () => ok({ models: Object.fromEntries(
    (['small', 'medium', 'large'] as const).map((name, index) => [
      `muscriptor-${name}`,
      { eligible: true, reason: null, requiredRamGiB: [6, 10, 20][index],
        freeRamGiB: 32, requiredCommitGiB: [4, 8, 16][index], freeCommitGiB: 36 },
    ]),
  ) }),
  set_transcription_model(model: TranscriptionModel) {
    if (!['muscriptor-small', 'muscriptor-medium', 'muscriptor-large'].includes(model))
      return fail('invalid_transcription_model', 'Choose an available model.')
    mockModel = model
    return ok({ model })
  },
  hf_token_status: () => ok({ configured: mockHfConfigured }),
  set_hf_token(token: string) {
    if (!token.trim()) return fail('invalid_token', 'Enter a Hugging Face token.')
    mockHfConfigured = true
    return ok({ configured: true })
  },
  clear_hf_token() {
    mockHfConfigured = false
    return ok({ configured: false })
  },
  search_youtube(query: string) {
    const samples = [
      { id: 'wfF0zHeU3Zs', title: 'Beethoven — Für Elise', channel: 'Lang Lang', duration: 175 },
      { id: 'aGSKrC7dGcY', title: 'Tears for Fears — Everybody Wants to Rule the World', channel: 'Tears for Fears', duration: 249 },
      { id: 'hTWKbfoikeg', title: 'Nirvana — Smells Like Teen Spirit', channel: 'Nirvana', duration: 278 },
    ]
    const needle = foldSearchText(query.trim())
    return ok({ results: samples.filter((video) => foldSearchText(`${video.title} ${video.channel}`).includes(needle)).map((video) => ({
      ...video, source: 'youtube', url: `https://www.youtube.com/watch?v=${video.id}`, thumbnail: `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`,
    })) })
  },
  search_youtube_music(query: string) {
    const samples = [
      { id: 'wfF0zHeU3Zs', title: 'Beethoven — Für Elise', channel: 'Lang Lang', duration: 175 },
      { id: 'NMW9ik7KSWw', title: 'Für Elise (Piano)', channel: 'YouTube Music', duration: null },
    ]
    const needle = foldSearchText(query.trim())
    return ok({ results: samples.filter((video) => foldSearchText(`${video.title} ${video.channel}`).includes(needle)).map((video) => ({
      ...video, source: 'youtube_music', url: `https://www.youtube.com/watch?v=${video.id}`,
      thumbnail: `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`,
    })) })
  },
  popular_songs(_refresh = false) {
    const hitList = [
      ['78wrful9cVU', 'Olivia Rodrigo - drop dead (Official Music Video)', 'Olivia Rodrigo'],
      ['nUsrYVxrDwI', "Ella Langley - Choosin' Texas (Official Video)", 'Ella Langley'],
      ['fRIhCiUVaKs', 'KAROL G, Judeline, rusowsky - BbY WOW (Visualizer)', 'KAROL G'],
      ['6KjVYeQ9SRw', 'Dracula', 'Tame Impala'],
      ['3sur4BmjQt8', 'Olivia Dean - So Easy (To Fall In Love)', 'Olivia Dean'],
      ['Rt9tW3cMLhI', 'Olivia Rodrigo - stupid song (Official Music Video)', 'Olivia Rodrigo'],
      ['SD4yRDY9mek', 'Drake - Janice STFU', 'Drake'],
      ['hDU4GB1PTxc', 'Taylor Swift - I Knew It, I Knew You (from Toy Story 5)', 'Taylor Swift'],
      ['Dg47eNL_Usw', 'Ella Langley - Be Her (Official Video)', 'Ella Langley'],
      ['uvY8fdgezLQ', 'Zara Larsson - Midnight Sun (Official Music Video)', 'Zara Larsson'],
      ['v2ttAph6PhM', 'Stella Lefty - Boston (Lyric Video)', 'Stella Lefty'],
      ['lIxQe1R5hs0', 'PinkPantheress - Stateside + Zara Larsson (Official Video)', 'Pinkpantheress'],
    ].map(([videoId, title, artist]) => ({
      videoId, title, artist,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    }))
    const globalChart = [
      ['fcnDmrtj6Sk', 'Shakira, Burna Boy - Dai Dai (Official Video)', 'Shakira'],
      ['fRIhCiUVaKs', 'KAROL G, Judeline, rusowsky - BbY WOW (Visualizer)', 'KAROL G'],
      ['xvT1jH8B9AM', 'KALYANI (with Shreya Ghoshal) OFFICIAL MUSIC VIDEO | ARJN | KDS | FIFTY4 | RONN | SHREYA GHOSHAL |', 'MONEY VERSE RECORDS'],
      ['s2HYl12gmOY', 'Parvati - Full Song | Hanuman Ansh | Sadhu Tiwari | Shobhinaw Satyaa | In Cinemas Now', 'Times Music Spiritual'],
      ['vRjaGgDsWSo', 'Casa Tupka Anthemo | @YoYoHoneySingh feat. Priyanshi | Full Video', 'Yo Yo Honey Singh'],
      ['is8UDe2PhKQ', "KATSEYE (캣츠아이) 'Hootie Frutti' Official MV", 'HYBE LABELS'],
      ['JqFzhcWo3EU', 'Yeshanagula | The Paradise | Nani | Keerthy Suresh | Anirudh Ravichander | Srikanth Odela', 'Saregama Telugu'],
      ['vSA7yMrTETg', 'Xamdam Sobirov - Peshta / Хамдам Собиров - Пешта / Video Klip', 'Xamdam Sobirov'],
    ].map(([videoId, title, artist], index) => ({
      videoId, title, artist, rank: index + 1,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    }))
    const snapshot: PopularChart = {
      title: 'YouTube Music',
      fetchedAt: '2026-10-10T08:49:51.327717+00:00',
      sample: true,
      sections: [
        {
          id: 'hit-list',
          title: "Today's Biggest Hits — The Hit List",
          publisher: 'YouTube Music',
          sourceUrl: 'https://music.youtube.com/playlist?list=RDCLAK5uy_kmPRjHDECIcuVwnKsx2Ng7fyNgFKWNJFs',
          kind: 'editorial',
          status: 'available',
          description: "The home of today's biggest and hottest hits.",
          chartDate: '20261010',
          rows: hitList,
        },
        {
          id: 'global-top-100',
          title: 'Top 100 Songs Global',
          publisher: 'YouTube Music Global Charts',
          sourceUrl: 'https://music.youtube.com/playlist?list=PL4fGSI1pDJn6puJdseH2Rt9sMvt9E2M4i',
          kind: 'chart',
          status: 'available',
          description: "This week's ranking of the most popular songs on YouTube.",
          chartDate: '20261010',
          rows: globalChart,
        },
      ],
    }
    return ok(snapshot)
  },
  search_midi_commons(query: string) {
    const results: MidiSearchResult[] = [{
      id: 'commons:mock-fur-elise',
      provider: 'commons',
      dedupeKey: 'mock-file:commons-fur-elise',
      source: 'Wikimedia Commons',
      title: 'Für Elise, WoO 59',
      artist: 'Ludwig van Beethoven',
      license: 'Public Domain',
      licenseUrl: null,
      attribution: 'Wikimedia Commons contributor',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:Beethoven_Fur_Elise.mid',
    }]
    const needle = foldSearchText(query.trim())
    return ok({ results: results.filter((item) => foldSearchText(`${item.title} ${item.artist}`).includes(needle)) })
  },
  search_midi_mutopia(query: string, startAt = 0) {
    const results: MidiSearchResult[] = [{
      id: 'mutopia:mock-moonlight',
      provider: 'mutopia',
      dedupeKey: 'mock-file:mutopia-moonlight',
      source: 'Mutopia Project',
      title: 'Piano Sonata No. 14, Op. 27 No. 2',
      artist: 'Ludwig van Beethoven',
      license: 'Public Domain',
      licenseUrl: 'https://www.mutopiaproject.org/legal.html#publicdomain',
      attribution: 'Composer: Ludwig van Beethoven',
      sourceUrl: 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=mock-moonlight',
    }]
    const needle = foldSearchText(query.trim())
    return ok({ results: startAt === 0 ? results.filter((item) =>
      foldSearchText(`${item.title} ${item.artist}`).includes(needle)) : [], nextStart: null })
  },
  search_midi_archive(query: string) {
    const results: MidiSearchResult[] = [{
      id: 'archive:mock-ut-queant-laxis',
      provider: 'archive',
      dedupeKey: 'mock-file:archive-ut-queant-laxis',
      source: 'Internet Archive',
      title: 'Ut queant laxis',
      artist: 'Guido von Arezzo',
      license: 'CC0',
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      attribution: 'Creator: Guido von Arezzo',
      sourceUrl: 'https://archive.org/details/guido-von-arezzo-ut-queant-laxis',
    }]
    const needle = foldSearchText(query.trim())
    return ok({ results: results.filter((item) => foldSearchText(`${item.title} ${item.artist}`).includes(needle)) })
  },
  async add_link(url: string) {
    const id = /(?:youtu\.be\/|v=|shorts\/)([\w-]{11})/.exec(url)?.[1]
    if (!id) return fail('invalid_url', "That isn't a YouTube video link.", 'Copy the link from the video page, like youtube.com/watch?v=…')
    if (/private/i.test(url)) return fail('video_private', 'This video is private.', 'Only public or unlisted videos can be transcribed.')
    url = `https://www.youtube.com/watch?v=${id}`
    const active = () => jobs.find((job) => job.url === url && job.kind === 'transcribe' && (job.status === 'queued' || job.status === 'running'))
    const existing = active()
    if (existing) return ok({ job: existing })
    const title = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m: { title?: string } | null) => m?.title ?? null)
      .catch(() => null)
    const pending = active()
    if (pending) return ok({ job: pending })
    const j = job({ url, title: title ?? `YouTube video ${id}`, thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, transcriptionModel: mockModel, order: visible().filter((q) => q.status !== 'done').length })
    jobs.push(j)
    return ok({ job: j })
  },
  import_file(name: string) {
    const source = /\.mid(i)?$/i.test(name) ? 'midi' : 'musicxml'
    const entry: Entry = {
      id: `s${seq++}`, title: name.replace(/\.[^.]+$/, ''), artist: null, thumbnail: null, source, parts: ['Piano'], recording: false, duration: 180,
      createdAt: ago(0), practicedAt: null, outdated: false, transcriptionModel: null, separationMethod: null, position: null, folders: [],
    }
    entries.unshift(entry)
    return ok({ entry })
  },
  import_midi_result(resultId: string) {
    const results: MidiSearchResult[] = [
      {
        id: 'commons:mock-fur-elise', provider: 'commons', source: 'Wikimedia Commons', title: 'Für Elise, WoO 59',
        dedupeKey: 'mock-file:commons-fur-elise',
        artist: 'Ludwig van Beethoven', license: 'Public Domain', licenseUrl: null,
        attribution: 'Wikimedia Commons contributor',
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:Beethoven_Fur_Elise.mid',
      },
      {
        id: 'mutopia:mock-moonlight', provider: 'mutopia', source: 'Mutopia Project',
        dedupeKey: 'mock-file:mutopia-moonlight',
        title: 'Piano Sonata No. 14, Op. 27 No. 2', artist: 'Ludwig van Beethoven',
        license: 'Public Domain', licenseUrl: 'https://www.mutopiaproject.org/legal.html#publicdomain',
        attribution: 'Composer: Ludwig van Beethoven',
        sourceUrl: 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=mock-moonlight',
      },
      {
        id: 'archive:mock-ut-queant-laxis', provider: 'archive', source: 'Internet Archive',
        dedupeKey: 'mock-file:archive-ut-queant-laxis', title: 'Ut queant laxis', artist: 'Guido von Arezzo',
        license: 'CC0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
        attribution: 'Creator: Guido von Arezzo',
        sourceUrl: 'https://archive.org/details/guido-von-arezzo-ut-queant-laxis',
      },
    ]
    const result = results.find((item) => item.id === resultId)
    if (!result) return fail('invalid_file', 'Search for this MIDI again before importing it.')
    const entry: Entry = {
      id: `s${seq++}`, title: result.title, artist: result.artist, thumbnail: null, source: 'midi',
      parts: ['Piano'], recording: false, duration: 180, createdAt: ago(0), practicedAt: null,
      outdated: false, transcriptionModel: null, separationMethod: null, position: null, folders: [],
      sourceUrl: result.sourceUrl, license: result.license, attribution: result.attribution,
    }
    entries.unshift(entry)
    return ok({ entry })
  },
  list_library: () => ok({ entries: [...entries].sort((a, b) => (b.practicedAt ?? b.createdAt).localeCompare(a.practicedAt ?? a.createdAt)) }),
  list_folders: () => (recount(), ok({ folders: folders.map((folder) => ({ ...folder })) })),
  create_folder(name: string) {
    name = name.trim()
    if (!name || name.length > 60) return fail('invalid_folder_name', 'Folder names must be between 1 and 60 characters.', 'Use a shorter name.')
    if (folders.some((folder) => folder.name.toLowerCase() === name.toLowerCase())) return fail('folder_name_exists', 'A folder with that name already exists.', 'Choose a different name.')
    const folder = { id: `f${seq++}`, name, count: 0 }
    folders.push(folder)
    return ok({ folder })
  },
  rename_folder(id: string, name: string) {
    name = name.trim()
    const folder = folders.find((item) => item.id === id)
    if (!folder) return fail('folder_not_found', 'This folder could not be found.')
    if (!name || name.length > 60) return fail('invalid_folder_name', 'Folder names must be between 1 and 60 characters.', 'Use a shorter name.')
    if (folders.some((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) return fail('folder_name_exists', 'A folder with that name already exists.', 'Choose a different name.')
    folder.name = name
    return ok({ folder: { ...folder } })
  },
  delete_folder(id: string) {
    if (!folders.some((folder) => folder.id === id)) return fail('folder_not_found', 'This folder could not be found.')
    folders = folders.filter((folder) => folder.id !== id)
    entries.forEach((entry) => (entry.folders = entry.folders.filter((folderId) => folderId !== id)))
    return ok({})
  },
  set_song_folders(songId: string, folderIds: string[]) {
    const entry = entries.find((item) => item.id === songId)
    if (!entry) return fail('song_not_found', 'This song could not be found.')
    if (folderIds.some((id) => !folders.some((folder) => folder.id === id))) return fail('folder_not_found', 'This folder could not be found.')
    entry.folders = [...new Set(folderIds)]
    recount()
    return ok({})
  },
  list_queue: () => ok({ jobs: visible().map((j) => ({ ...j })) }),
  resource_usage: () => ok({ usage: visible().some((j) => j.status === 'running')
    ? { cpu: null, ramBytes: null, gpu: null, npu: null } : null }),
  get_job: (id: string) => (find(id) ? ok({ job: { ...find(id)! } }) : fail('not_found', 'That job no longer exists.')),
  cancel_job(id: string) {
    const j = find(id)
    if (j) j.status = 'cancelled'
    return ok({ job: j })
  },
  retry_job(id: string) {
    const j = find(id)
    if (j) Object.assign(j, { status: 'queued', progress: 0, stage: 'inspect', startedAt: null, stageStartedAt: null,
      errorCode: null, errorMessage: null, fix: null, stages: stageRows(0) })
    return ok({ job: j })
  },
  move_job(id: string, order: number) {
    const queued = visible().filter((j) => j.status === 'queued' && j.id !== id)
    const j = find(id)
    if (j) queued.splice(Math.max(0, order - 1), 0, j)
    queued.forEach((q, i) => (q.order = i + 1))
    return ok({ job: j })
  },
  dismiss_job(id: string) {
    const j = find(id)
    if (j) j.order = -1000
    return ok({})
  },
  get_job_log(id: string) {
    const j = find(id)
    if (!j) return fail('not_found', 'That job is no longer in the queue.')
    const lines = j.stages
      .filter((s) => s.seconds != null)
      .map((s, i) => `14:0${i}:${String(10 + i * 7).padStart(2, '0')} ${s.name.padEnd(10)} done in ${s.seconds!.toFixed(2)} s${s.provider ? ` on ${s.provider}` : ''}`)
    if (j.status === 'running') lines.push(`14:0${lines.length}:59 ${j.stage.padEnd(10)} Running`)
    if (j.errorCode) lines.push(`14:00:02 error      ${j.errorCode}: HTTP Error 403: Forbidden`)
    return ok({ lines })
  },
  open_song(id: string) {
    const entry = entries.find((e) => e.id === id)
    if (!entry) return fail('not_found', 'That song is no longer in the library.')
    const audio = clips()
    const stems: Stem[] | undefined = entry.recording ? [
      { id: 'mix', label: 'Full mix', url: audio.mix, level: 1 },
      { id: 'piano', label: 'Piano', url: audio.piano, level: 0.72 },
      { id: 'drums', label: 'Drums', url: audio.drums, level: 0.58 },
      { id: 'vocals', label: 'Vocals', url: audio.mix, level: 0.64 },
      { id: 'guitar', label: 'Guitar', url: audio.piano, level: 0.37 },
      { id: 'bass', label: 'Bass', url: audio.drums, level: 0.42 },
      { id: 'other', label: 'Other', url: audio.mix, level: 0.25 },
    ] : undefined
    return ok({ entry, song: score(entry), artifacts: {}, stems })
  },
  delete_score_track(id: string, trackId: string) {
    const entry = entries.find((item) => item.id === id)
    if (!entry) return fail('song_not_found', 'This song could not be found.')
    const song = score(entry)
    const track = song.tracks.find((item) => item.id === trackId && item.group !== 'creative')
    if (!track) return fail('score_track_not_found', 'This transcribed score track could not be found.')
    song.tracks = song.tracks.filter((item) => item.id !== trackId)
    if (track.instrument === 'piano') song.piano = []
    if (track.instrument === 'drums') song.drums = []
    if (track.instrument === 'vocals') song.vocals = []
    entry.parts = song.tracks.filter((item) => item.group !== 'creative').map((item) => item.name)
    if (entry.position?.trackId === trackId) entry.position.trackId = song.tracks[0]?.id ?? ''
    return this.open_song(id)
  },
  save_position(id: string, position: Entry['position']) {
    const entry = entries.find((e) => e.id === id)
    if (entry) Object.assign(entry, { position, practicedAt: ago(0) })
    return ok({})
  },
  delete_song(id: string) {
    const i = entries.findIndex((e) => e.id === id)
    if (i >= 0) entries.splice(i, 1)
    recount()
    return ok({})
  },
  reprocess_song(id: string) {
    const e = entries.find((x) => x.id === id)
    if (!e || e.source !== 'youtube') return fail('invalid_reprocess', 'Only YouTube transcriptions can be reprocessed.')
    const active = jobs.find((j) => j.songId === id && (j.status === 'queued' || j.status === 'running'))
    if (active) return ok({ job: active })
    const j = job({ url: 'https://www.youtube.com/watch?v=reprocess00', title: e.title, songId: id, transcriptionModel: mockModel, order: 99 })
    jobs.push(j)
    return ok({ job: j })
  },
  link_recording(id: string, url: string) {
    const e = entries.find((x) => x.id === id)
    const j = job({ kind: 'align', songId: id, url, title: e?.title ?? null, order: 99 })
    jobs.push(j)
    return ok({ job: j })
  },
  set_timing(id: string) {
    return ok({ entry: entries.find((e) => e.id === id) })
  },
}
