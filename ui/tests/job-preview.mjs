export async function jobPreviewChecks() {
  const { default: React } = await import('/node_modules/.vite/deps/react.js')
  const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js')
  const { JobPanel } = await import('/src/library/JobPanel.tsx')
  const { Workspace } = await import('/src/workspace/Workspace.tsx')
  const { Engine } = await import('/src/workspace/engine.ts')
  const { buildSong } = await import('/src/workspace/song.ts')
  const { fromHost } = await import('/src/library/adapt.ts')
  const check = (value, message) => { if (!value) throw new Error(message) }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, message) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (predicate()) return
      await sleep(25)
    }
    throw new Error(message)
  }
  const urls = []
  const clip = (frequency) => {
    const rate = 22050, count = rate * 12
    const buffer = new ArrayBuffer(44 + count * 2)
    const view = new DataView(buffer)
    const word = (at, value) => [...value].forEach((letter, i) => view.setUint8(at + i, letter.charCodeAt(0)))
    word(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true)
    word(8, 'WAVE'); word(12, 'fmt '); view.setUint32(16, 16, true)
    view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true)
    view.setUint16(32, 2, true); view.setUint16(34, 16, true)
    word(36, 'data'); view.setUint32(40, count * 2, true)
    for (let i = 0; i < count; i++) view.setInt16(44 + i * 2, Math.sin(i * frequency * 2 * Math.PI / rate) * 2000, true)
    const url = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
    urls.push(url)
    return url
  }
  const stems = { mix: clip(220), piano: clip(440), drums: clip(110) }
  const job = {
    id: 'job-preview-check', kind: 'transcribe', songId: null,
    url: 'https://www.youtube.com/watch?v=aB_12-cD345', title: 'Local preview check',
    thumbnail: null, status: 'running', stage: 'transcribe', progress: 0.6,
    instrument: 'piano', processingMode: 'local', transcriptionModel: 'muscriptor-small',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    warnings: [], detected: { piano: 0.91, drums: 0.34 },
    selectedInstruments: ['piano'], transcribedInstruments: [], stages: [],
    found: { key: 'A minor', tempo: 112, stems },
  }
  const mount = document.createElement('div')
  document.body.append(mount)
  const root = ReactDOM.createRoot(mount)
  const props = { jobs: [job], onClose() {}, onChange() {}, onOpen() {} }
  const player = () => mount.querySelector('.jp-listen audio')
  const choose = (label) => [...mount.querySelectorAll('.jp-seg button')].find((node) => node.textContent === label).click()
  const play = () => mount.querySelector('.jp-play').click()
  const originalPlay = HTMLMediaElement.prototype.play
  try {
    root.render(React.createElement(JobPanel, { ...props, job }))
    await until(() => player()?.readyState >= 1, 'The job panel loads its selected real WAV')
    check(mount.textContent.includes('A minor') && mount.textContent.includes('112 BPM'), 'Job facts are shown')
    check(mount.querySelectorAll('.jp-seg button').length === 3, 'All three available recording controls are shown')
    play()
    await until(() => player().currentTime > 0.25 && !player().paused, 'Preview audio advances')
    const before = player().currentTime
    choose('Drums')
    await until(() => player().currentSrc === stems.drums && !player().paused && player().currentTime >= before,
      'Switching recording waits for metadata, resumes, and preserves playback position')
    choose('Full mix')
    await until(() => player().currentSrc === stems.mix && !player().paused, 'Full mix plays')
    const previous = player()
    root.render(React.createElement(JobPanel, { ...props, job: {
      ...job, id: 'second-job-preview-check', found: { stems: { mix: stems.mix } },
    } }))
    await until(() => player() !== previous && player()?.readyState >= 1, 'Switching jobs creates an independent player')
    check(previous.paused && player().paused, 'Switching jobs stops the previous audio and does not auto-start another job')
    HTMLMediaElement.prototype.play = () => Promise.reject(new Error('Playback was blocked for this check'))
    play()
    await until(() => mount.querySelector('.jp-listen [role="alert"]')?.textContent.includes('Playback was blocked'),
      'A playback rejection is visible instead of an unhandled promise')
    HTMLMediaElement.prototype.play = originalPlay
    play()
    await until(() => !player().paused, 'Retry plays the available recording')
    const closing = player()
    root.render(React.createElement('div'))
    await until(() => !player(), 'The job panel closes')
    check(closing.paused, 'Closing job details stops audio')

    const base = buildSong()
    const creative = { id: 'chords', instrument: 'chords', group: 'creative', name: 'Chords', detail: 'Generated' }
    const raw = {
      ...base, tracks: [base.tracks.find((track) => track.instrument === 'piano'), creative],
    }
    check(fromHost(raw).tracks.every((track) => track.group !== 'creative' && track.instrument !== 'chords'),
      'Opening a saved song does not add generated Creative tracks')
    const isolated = { ...raw, piano: [], drums: [], vocals: [], instrumentNotes: {}, tracks: [creative] }
    const engine = new Engine(isolated)
    const events = []
    engine.sampleNote = () => events.push('note')
    engine.pad = () => events.push('pad')
    engine.bus = () => ({})
    engine.events(0, 4, 0, 0.5, false)
    check(events.length === 0, 'Legacy Creative chord tracks cannot play invisibly')
    const backing = new Engine({ ...isolated, tracks: [{ ...creative, group: undefined }] })
    backing.sampleNote = () => events.push('note')
    backing.pad = () => events.push('pad')
    backing.bus = () => ({})
    backing.events(0, 4, 0, 0.5, false)
    check(events.length > 0, 'Explicit course backing chord tracks still play')
    root.render(React.createElement(Workspace, {
      song: raw, songId: 'creative-removal-check', defaults: { piano: 'score' },
      start: { bar: 1, rate: 1, trackId: 'chords', muted: [], solo: [], loop: null },
    }))
    await until(() => mount.querySelector('.track-button .track-name')?.textContent.startsWith('Piano'),
      'A saved Creative selection falls back to an available score')
    mount.querySelector('.track-button').click()
    await until(() => mount.querySelector('.track-menu'), 'Practice track menu opens')
    check(![...mount.querySelectorAll('.track-group')].some((node) => node.textContent.includes('Creative')) &&
      !mount.querySelector('[aria-label="Mute Chords"]') &&
      !mount.textContent.includes('Colour chords') && !mount.textContent.includes('Harmony line'),
    'The removed Creative group is not shown')
    return 'Job preview checks passed: advancing WAV playback, recording switching, job switching, errors and close; Creative parts removed without disabling course backing.'
  } finally {
    HTMLMediaElement.prototype.play = originalPlay
    root.unmount()
    mount.remove()
    for (const url of urls) URL.revokeObjectURL(url)
    localStorage.removeItem('mizan:mixer:creative-removal-check')
  }
}
