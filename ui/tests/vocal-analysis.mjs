// Browser checks called by playback.mjs in its isolated Edge profile.
export async function vocalChecks() {
  const { Engine } = await import('/src/workspace/engine.ts')
  const { buildSong } = await import('/src/workspace/song.ts')
  const { fromHost } = await import('/src/library/adapt.ts')
  const { vocalXml } = await import('/src/workspace/musicxml.ts')
  const check = (value, message) => { if (!value) throw new Error(message) }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const song = fromHost({ ...buildSong(), bpm: 120, bars: 2, piano: [], drums: [], chords: [],
    tracks: [{ id: 'vocals', instrument: 'vocals', name: 'Vocal melody', detail: 'Draft' }],
    vocals: [{ midi: 60, startBeat: 0, beats: 5.5, velocity: 0.8 }, { midi: 64, startBeat: 6, beats: 1, velocity: 0.6 }],
    confidence: {},
  })
  check(song.confidence.vocals.every((value) => value === 'low'), 'Unspecified vocal confidence stays low')
  check(fromHost({ ...song, vocals: undefined }).vocals.length === 0, 'Legacy songs default to no vocal notes')
  const xml = new DOMParser().parseFromString(vocalXml(song), 'application/xml')
  check(!xml.querySelector('parsererror'), 'Vocal MusicXML parses')
  check(xml.querySelectorAll('clef').length === 1 && !xml.querySelector('fingering'), 'Single vocal staff, no piano fingering')
  check(xml.querySelector('clef sign')?.textContent === 'G', 'Higher vocal melodies use treble clef')
  const lowVoice = new DOMParser().parseFromString(vocalXml({ ...song, vocals: [{ midi: 50, startBeat: 0, beats: 1 }] }), 'application/xml')
  check(lowVoice.querySelector('clef sign')?.textContent === 'F', 'Low vocal melodies use bass clef')
  check(xml.querySelectorAll('tie[type="start"]').length === xml.querySelectorAll('tie[type="stop"]').length, 'Vocal sustained notes have balanced ties')
  check(xml.querySelector('measure[number="2"] pitch'), 'Held vocal note continues across the barline')
  const engine = new Engine(song)
  engine.countIn = false
  try {
    await engine.play()
    const analyser = engine.ctx.createAnalyser()
    engine.master.connect(analyser)
    await wait(180)
    const samples = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(samples)
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length)
    check(rms > 0.005, `Vowel synth produces audible output (${rms})`)
    check([...engine.nodes].some((node) => node instanceof OscillatorNode && node.type === 'custom'), 'Vocal sound is a shaped vowel, not square-wave melody')
    engine.trackGains.set('vocals', 0.4)
    engine.refreshMix()
    check(engine.buses.get('vocals').gain.value <= 1, 'Vocal melody has its own mixer bus')
    engine.muted.add('vocals')
    engine.refreshMix()
    await wait(200)
    analyser.getFloatTimeDomainData(samples)
    check(Math.max(...samples.map(Math.abs)) < 0.001, 'Vocal mute silences only its bus')
    engine.muted.clear()
    engine.rate = 0.5
    engine.refresh()
    engine.seek(4.5)
    await wait(150)
    check([...engine.nodes].some((node) => node instanceof OscillatorNode), 'Seek resumes a held vocal note at half speed')
    engine.pause()
    check(!engine.playing, 'Vocal playback pauses')
    return `Vocal checks passed: low confidence, single staff, cross-bar ties, distinct synth (RMS ${rms.toFixed(4)}), mute, half-speed seek and pause.`
  } finally { engine.dispose() }
}

export async function analysisChecks() {
  const { default: React } = await import('/node_modules/.vite/deps/react.js')
  const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js')
  const { default: App } = await import('/src/App.tsx')
  const { TrackPicker } = await import('/src/workspace/TrackPicker.tsx')
  const { JobPanel } = await import('/src/library/JobPanel.tsx')
  const { instrumentStatus, stageModelLabel, stageProviderLabel } = await import('/src/library/format.ts')
  // Vite stamps changed dependencies; patch the instance actually imported by App.
  const appSource = await (await fetch('/src/App.tsx')).text()
  const bridgeUrl = appSource.match(/from "([^"]*\/library\/bridge\.ts[^"]*)"/)?.[1]
  if (!bridgeUrl) throw new Error('Could not resolve the application bridge module')
  const { host } = await import(bridgeUrl)
  const { buildSong } = await import('/src/workspace/song.ts')
  const check = (value, message) => { if (!value) throw new Error(message) }
  check(stageModelLabel({ model: 'htdemucs-6s-fp16weights', method: 'htdemucs-6s-onnx' }) === 'HT-Demucs (six stems)',
    'Separation model has a readable name')
  check(stageModelLabel({ model: 'muscriptor-medium', method: 'muscriptor-medium-pytorch-cpu' }) === 'muscriptor-medium',
    'Current MuScriptor note model retains its official name')
  check(stageModelLabel({ model: 'beat-this-final0', method: 'beat-this-final0+chroma-templates-uncertain-v3' }) === 'Beat This! + chroma chords',
    'Chord row names both the beat model and chroma analysis')
  check(stageModelLabel({ model: 'future-model', method: null }) === 'future-model',
    'Unknown models retain their diagnostic identifier')
  check(stageProviderLabel('DmlExecutionProvider, CPUExecutionProvider') === 'GPU (DirectML) + CPU',
    'The mixed execution provider is readable without hiding CPU fallback')
  check(instrumentStatus({ instrument: 'auto', transcriptionModel: 'muscriptor-small',
    selectedInstruments: ['piano', 'drums'] }, 'vocals') === 'no dedicated vocal score',
  'Older MuScriptor jobs without a vocal pass do not claim a vocal score')
  check(instrumentStatus({ instrument: 'auto', transcriptionModel: 'muscriptor-small',
    selectedInstruments: ['piano', 'drums', 'vocals'], stage: 'transcribe' }, 'vocals') === 'transcribing',
  'A MuScriptor job requesting a vocal score shows the in-progress status')
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const originalRoot = document.getElementById('root')
  originalRoot.style.display = 'none'
  const container = document.createElement('div')
  document.body.append(container)
  const root = ReactDOM.createRoot(container)
  const originalHost = { ...host }
  const find = (text) => [...container.querySelectorAll('button')].find((button) => button.textContent.trim() === text)
  const until = async (predicate, message) => {
    for (let i = 0; i < 120; i++) {
      if (predicate()) return
      await wait(100)
    }
    throw new Error(`${message}: ${container.textContent.slice(0, 2000)}`)
  }
  const entry = { id: 'synthetic-vocal-check', title: 'Synthetic vocal study', artist: null, thumbnail: null,
    source: 'youtube', parts: ['Piano'], recording: true, duration: 4, createdAt: new Date().toISOString(),
    practicedAt: null, position: null, folders: [], outdated: true,
    transcriptionModel: 'muscriptor-medium', separationMethod: 'htdemucs-6s-onnx' }
  const oldSong = { ...buildSong(), title: entry.title, bars: 2, sections: [{ name: 'Study', startBar: 1, bars: 2 }],
    chords: [], piano: [{ midi: 60, startBeat: 0, beats: 1, hand: 'right' }], drums: [],
    tracks: [{ id: 'piano', instrument: 'piano', name: 'Piano', detail: 'Old draft' }] }
  const newSong = { ...oldSong, vocals: [{ midi: 64, startBeat: 0, beats: 5, velocity: 0.7 }],
    tracks: [...oldSong.tracks,
      { id: 'drums', instrument: 'drums', name: 'Drum kit', detail: 'Draft percussion' },
      { id: 'vocals', instrument: 'vocals', name: 'Vocal melody', detail: 'Low-confidence draft' }] }
  const allStems = ['mix', 'vocals', 'piano', 'guitar', 'bass', 'drums', 'other'].map((id) => ({
    id, label: id === 'mix' ? 'Full mix' : id[0].toUpperCase() + id.slice(1),
    url: '/samples/piano/A4-v5.ogg', level: 0.2,
  }))
  const pickerNode = document.createElement('div')
  document.body.append(pickerNode)
  const pickerRoot = ReactDOM.createRoot(pickerNode)
  try {
    pickerRoot.render(React.createElement(TrackPicker, {
      tracks: oldSong.tracks, stems: allStems.filter((stem) => ['mix', 'piano'].includes(stem.id)),
      value: 'piano', onChange: () => {}, muted: new Set(), onMute: () => {},
      solo: new Set(), onSolo: () => {}, volumes: {}, onVolume: () => {},
      onSynthOnly: () => {}, onOriginalOnly: () => {},
    }))
    await until(() => pickerNode.querySelector('.track-button'), 'Filtered picker is mounted')
    pickerNode.querySelector('.track-button').click()
    await until(() => pickerNode.querySelectorAll('.track-stem').length === 2, 'Filtered picker shows only available recordings')
    check(pickerNode.querySelector('.track-menu').textContent.includes('Full mix') &&
      pickerNode.querySelector('.track-menu').textContent.includes('Piano') &&
      !pickerNode.querySelector('.track-menu').textContent.includes('Drums') &&
      !pickerNode.querySelector('.track-menu').textContent.includes('Vocals'),
    'Absent scores and near-zero stems have no selectable entry while full mix and real piano remain')
  } finally {
    pickerRoot.unmount()
    pickerNode.remove()
  }
  let jobs = [{ id: 'already-running', songId: entry.id, kind: 'transcribe', url: 'https://youtu.be/aB_12-cD345',
    title: entry.title, status: 'running', stage: 'detect', stageProgress: 0.4,
    startedAt: new Date(Date.now() - 90_000).toISOString(),
    stageStartedAt: new Date(Date.now() - 12_000).toISOString(), progress: 0.39, order: 0, warnings: [],
    detected: null, stages: [], createdAt: entry.createdAt, updatedAt: entry.createdAt }]
  let requests = 0
  let fail = true
  const queuedLinks = []
  Object.assign(host, {
    library: async () => [structuredClone(entry)], folders: async () => [], queue: async () => structuredClone(jobs),
    open: async () => ({ entry: structuredClone(entry), song: entry.outdated ? oldSong : newSong, artifacts: {},
      stems: entry.outdated ? allStems.filter((stem) => ['mix', 'piano', 'drums'].includes(stem.id)) : allStems }),
    savePosition: async () => ({}), jobLog: async () => [],
    addLink: async (url) => { queuedLinks.push(url); await wait(100); return {} },
    reprocess: async () => {
      requests++
      await wait(100)
      if (fail) throw new Error('Synthetic queue failure')
      jobs = [{ ...jobs[0], id: 'new-analysis', status: 'running', progress: 0.1 }]
      return jobs[0]
    },
  })
  try {
    root.render(React.createElement(App))
    await until(() => container.querySelector('.song-analysis')?.textContent.includes('39%'), 'Library shows existing update progress')
    check(container.querySelector('.job-state')?.textContent.includes('39% overall') &&
      container.querySelector('.job-state')?.textContent.includes('elapsed'),
    'Queue row labels overall progress and total elapsed time')
    const firstElapsed = container.querySelector('.job-state').textContent
    await until(() => container.querySelector('.job-state')?.textContent !== firstElapsed,
      'Queue elapsed counter advances while processing')
    check(container.querySelector('.song-text .song-meta:nth-child(3)')?.textContent.includes('MuScriptor Medium') &&
      container.querySelector('.song-text .song-meta:nth-child(3)')?.textContent.includes('HT-Demucs'),
    'Saved processing metadata shows the actual model and separator')
    const about = container.querySelector('button[aria-label="About Mizan"]')
    check(about && !find('Credits'), 'About replaces the header Credits action')
    about.click()
    await until(() => container.querySelector('.about-dialog[open]'), 'About opens as a modal dialog')
    const dialog = container.querySelector('.about-dialog')
    check(dialog.textContent.includes('Ahmed Sabbour') && dialog.textContent.includes('Development build') &&
      dialog.querySelector('a[href="https://github.com/sabbour/mizan/releases"]') &&
      dialog.querySelector('a[href="https://github.com/sabbour/mizan/blob/main/LICENSE"]') &&
      dialog.querySelector('a[href="https://www.linkedin.com/in/ahmedsabbour/"]') &&
      dialog.querySelector('a[href="https://x.com/sabbour"]'),
    'About includes version, release notes, license, author and social links')
    dialog.querySelector('[aria-label="Close About"]').click()
    await until(() => !dialog.open && document.activeElement === about, 'Closing About restores header focus')
    about.click()
    await until(() => dialog.open, 'About reopens')
    dialog.querySelector('.about-links button').click()
    await until(() => container.querySelector('.credits h1')?.textContent === 'Credits', 'Credits opens from About')
    find('Back').click()
    await until(() => container.querySelector('.song-analysis')?.textContent.includes('39%'), 'Credits returns to the library')
    const library = container.querySelector('.lib')
    library.setAttribute('data-panel', '')
    check(getComputedStyle(library.querySelector('.lib-main')).overflowY === 'hidden',
      'Opening job details locks the library behind the panel')
    library.removeAttribute('data-panel')
    const search = container.querySelector('.intake-field input')
    const typeSearch = (value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, value)
      search.dispatchEvent(new Event('input', { bubbles: true }))
    }
    typeSearch('https://youtu.be/another-song')
    await until(() => container.querySelector('.intake-row .btn-primary')?.textContent === 'Transcribe', 'URL changes search to transcribe')
    container.querySelector('.intake-row').requestSubmit()
    await until(() => search.value === '', 'Submitted link clears immediately')
    typeSearch('https://youtu.be/follow-up-song')
    await until(() => container.querySelector('.intake-row .btn-primary')?.textContent === 'Transcribe', 'Next URL can be queued')
    check(!container.querySelector('.intake-row .btn-primary').disabled, 'Next Transcribe stays enabled during the first request')
    container.querySelector('.intake-row').requestSubmit()
    await until(() => queuedLinks.length === 2, 'Two links can be queued without waiting')
    typeSearch('Next song')
    await wait(180)
    check(queuedLinks.length === 2 && search.value === 'Next song' && document.activeElement === search,
      'Queuing preserves focus and never clears the next search during queue refresh')
    check(search === container.querySelector('.intake-field input'), 'Polling does not replace the search field')
    typeSearch('')
    container.querySelector('.song-open').click()
    await until(() => container.querySelector('.analysis-notice'), 'Saved workspace has contextual analysis notice')
    find('View progress').click()
    await until(() => container.querySelector('.jp'), 'Existing job progress opens')
    check(requests === 0 && !find('Redo analysis'), 'Viewing existing progress never enqueues a duplicate')
    const panel = container.querySelector('.jp')
    check(panel.querySelector('.jp-sub').textContent.includes('40% step · 39% overall') &&
      panel.querySelector('.jp-elapsed').textContent.includes('Total elapsed') &&
      panel.querySelector('.jp-elapsed').textContent.includes('This step') &&
      panel.scrollWidth <= panel.clientWidth, 'Running shows both progress percentages and elapsed time without horizontal scrolling')
    panel.style.height = '400px'
    panel.style.bottom = 'auto'
    check(panel.scrollHeight > panel.clientHeight && getComputedStyle(panel).overflowY === 'auto',
      'The entire running-job panel, including its header, is scrollable')
    const rect = panel.getBoundingClientRect()
    const misplacedWheel = new WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaY: 120, clientX: rect.left + 40, clientY: rect.top + 100,
    })
    container.querySelector('.ws').dispatchEvent(misplacedWheel)
    check(misplacedWheel.defaultPrevented && panel.scrollTop > 0,
      'Wheel delivered to the main page scrolls the panel under the cursor instead')
    panel.scrollTop = 0
    const innerWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 })
    panel.querySelector('.jp-now').dispatchEvent(innerWheel)
    check(innerWheel.defaultPrevented && panel.scrollTop > 0,
      'Wheel delivered inside the progress panel scrolls its content')
    panel.scrollTop = 0
    const background = container.querySelector('.lib-main, .ws')
    const previousBackground = background.scrollTop
    const offscreenWheel = new WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaY: 120, clientX: 24, clientY: rect.top + 100,
    })
    background.dispatchEvent(offscreenWheel)
    check(offscreenWheel.defaultPrevented && panel.scrollTop > 0 &&
      background.scrollTop === previousBackground,
    `While details are open, wheel input scrolls the panel even if WebView reports the wrong coordinates: prevented=${offscreenWheel.defaultPrevented}, panel=${panel.scrollTop}, background=${background.scrollTop}/${previousBackground}`)
    panel.scrollTop = 120
    const beforeScroll = panel.scrollTop
    await wait(850)
    check(panel.scrollTop === beforeScroll && container.querySelector('.jp') === panel,
      `Queue polling preserves the running-job scroll position (${beforeScroll} -> ${panel.scrollTop})`)
    check(panel.querySelector('.jp-elapsed').textContent.includes('1 min'), 'Total elapsed continues while the job runs')
    panel.style.height = ''
    panel.style.bottom = ''
    jobs[0].stages = [{ name: 'detect', seconds: null, provider: 'DmlExecutionProvider, CPUExecutionProvider',
      method: 'htdemucs-6s-onnx', model: 'htdemucs-6s-fp16weights' }]
    await until(() => panel.querySelector('.jp-stage-list')?.textContent.includes('HT-Demucs (six stems)'),
      'Real model identifiers render readably in job details')
    check(panel.querySelector('.jp-stage[data-active]')?.textContent.includes('GPU (DirectML) + CPU') &&
      panel.querySelector('.jp-stage[data-active]')?.textContent.includes('Running') &&
      panel.querySelector('.jp-stage[data-active]')?.textContent.includes('40%') &&
      panel.querySelector('.jp-stage[data-active]')?.textContent.includes('elapsed') &&
      panel.querySelector('.jp-stage[data-active] [role="progressbar"]'),
      'Active step is distinguished, animated, and shows its model and actual processors')
    check(panel.querySelector('.jp-stage[data-active] .jp-stage-top .num').getBoundingClientRect().right <=
      panel.getBoundingClientRect().right - 8, 'Active step timing is visible without scrolling right')
    check(panel.querySelector('.jp-stage [title="htdemucs-6s-fp16weights"]'),
      'Raw model identifier stays available in the tooltip')
    container.querySelector('#jp-title').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await until(() => !container.querySelector('.jp'), 'Escape closes progress')
    check(container.querySelector('.ws'), 'Escape keeps saved workspace available')
    const doneNode = document.createElement('div')
    document.body.append(doneNode)
    const doneRoot = ReactDOM.createRoot(doneNode)
    let openedReady = null
    try {
      doneRoot.render(React.createElement(JobPanel, {
        job: { ...jobs[0], stage: 'finalize', stages: [
          { name: 'finalize', seconds: null, method: null, model: null, provider: 'CPU' },
        ] }, jobs: [], onClose: () => {}, onChange: () => {}, onOpen: () => {},
      }))
      await until(() => doneNode.querySelector('.jp-stage-detail'), 'Finalizing job details render')
      check(doneNode.querySelector('.jp-stage-detail').textContent.includes('Saving the song') &&
        !doneNode.querySelector('.jp-stage-detail').textContent.includes('Starting model'),
      'Finishing never claims to be starting a model')
      doneRoot.render(React.createElement(JobPanel, {
        job: { ...jobs[0], status: 'done', songId: entry.id,
          warnings: ['Duplicate warning', 'Duplicate warning'] }, jobs: [],
        onClose: () => {}, onChange: () => {}, onOpen: (id) => { openedReady = id },
      }))
      await until(() => doneNode.querySelector('.jp-ready'), 'Completed details offer a persistent Open song action')
      const ready = doneNode.querySelector('.jp-ready')
      check(getComputedStyle(ready).position === 'fixed' &&
        ready.getBoundingClientRect().bottom === window.innerHeight &&
        doneNode.querySelector('.jp-limits summary').textContent.includes('1'),
      'Open song remains visible at the bottom and repeated limitations appear once')
      doneNode.querySelector('.jp-ready button').click()
      check(openedReady === entry.id, 'Persistent Open song opens the completed job')
    } finally {
      doneRoot.unmount()
      doneNode.remove()
    }
    jobs[0].status = 'cancelled'
    await until(() => find('Redo analysis'), 'Cancelled update allows retry from saved result')
    find('Redo analysis').click()
    await until(() => container.querySelector('.analysis-notice [role="alert"]'), 'Reprocess error is visible')
    check(container.querySelector('.ws'), 'Reprocess error preserves old workspace')
    fail = false
    find('Redo analysis').click()
    await wait(25)
    check(find('Queuing...')?.disabled, 'Pending reprocess is disabled')
    await until(() => container.querySelector('.jp'), 'Successful reprocess opens progress over saved score')
    check(requests === 2, 'Exactly one failed and one successful request')
    container.querySelector('.jp [aria-label="Close"]').click()
    await until(() => !container.querySelector('.jp'), 'Close returns to saved workspace')
    jobs[0].progress = 0.71
    await until(() => container.querySelector('.analysis-notice')?.textContent.includes('71%'), 'Workspace progress updates live')
    entry.outdated = false
    entry.transcriptionModel = 'muscriptor-large'
    entry.parts.push('Vocal melody')
    jobs[0].status = 'done'
    jobs[0].progress = 1
    await until(() => find('Open updated analysis'), 'Completion offers updated result without silently replacing practice')
    find('Open updated analysis').click()
    await until(() => !container.querySelector('.analysis-notice'), 'Fresh result clears stale notice')
    container.querySelector('.track-button').click()
    await until(() => container.querySelectorAll('.track-stem').length === 7, 'All six isolated stems and full mix appear')
    check([...container.querySelectorAll('.track-stem')].every((row) => row.hasAttribute('data-muted')), 'New recording stems do not unexpectedly unmute when analysis is reopened')
    find('Original only').click()
    await until(() => container.querySelector('.track-button .track-detail')?.textContent === 'Full recording only', 'Full recording is identified rather than a generic original source')
    container.querySelector('[aria-label="Unmute Vocals"]').click()
    await until(() => container.querySelector('.track-button .track-detail')?.textContent === 'Vocals recording only', 'Isolated vocals are distinguished from the full song')
    check(container.querySelector('.track-menu [role="status"]').textContent.includes('Viewing Piano (muted)'), 'Selected score mute is visible')
    check(container.querySelector('.track-menu [role="status"]').textContent.includes('silent between phrases'), 'Vocal-only silence has an explanation and full-song recovery action')
    const mixer = () => JSON.parse(localStorage.getItem(`mizan:mixer:${entry.id}`))
    const selectedScore = () => container.querySelector('.track-item[role="menuitemradio"][aria-checked="true"] .track-name')?.textContent
    const soloButton = (name, recording = false) => container.querySelector(`${recording ? '.track-stem' : '.track-row:not(.track-stem)'} [aria-label="Solo ${name}"]`)
    const vocalVolume = container.querySelector('.track-stem:has([aria-label="Solo Vocals"]) input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(vocalVolume, '0.45')
    vocalVolume.dispatchEvent(new Event('input', { bubbles: true }))
    vocalVolume.dispatchEvent(new Event('change', { bubbles: true }))
    await until(() => mixer().volumes['stem:vocals'] === 0.45, 'Set a nondefault recording volume before solo checks')
    const initialMix = mixer()
    const synthNames = [...container.querySelectorAll('.track-item[role="menuitemradio"] .track-name')].map((node) => node.textContent)
    const cases = [
      ...synthNames.map((name) => [name, name, false]),
      ['Drums', 'Drum kit', true], ['Vocals', 'Vocal melody', true], ['Piano', 'Piano', true],
      ['Full mix', null, true], ['Guitar', null, true], ['Bass', null, true], ['Other', null, true],
    ]
    for (const [name, expectedScore, recording] of cases) {
      const previousScore = selectedScore()
      soloButton(name, recording).click()
      await until(() => soloButton(name, recording)?.getAttribute('aria-checked') === 'true', `${name} solo turns on`)
      check(selectedScore() === (expectedScore ?? previousScore), `${name} solo selects only an available matching score`)
      check(container.querySelectorAll('.track-mute:not(.track-solo)[aria-checked="false"]').length === 1, `${name} solo leaves exactly one audio source unmuted`)
      soloButton(name, recording).click()
      await until(() => !mixer().soloId, `${name} solo turns off`)
      check(selectedScore() === (expectedScore ?? previousScore), `${name} unsolo does not jump back`)
      check(JSON.stringify([...mixer().muted].sort()) === JSON.stringify([...initialMix.muted].sort()), `${name} unsolo restores the original mutes`)
      check(JSON.stringify(mixer().volumes) === JSON.stringify(initialMix.volumes), `${name} solo preserves volumes`)
    }
    soloButton('Drum kit').click()
    await until(() => selectedScore() === 'Drum kit', 'Synth solo selects drum score')
    soloButton('Vocals', true).click()
    await until(() => selectedScore() === 'Vocal melody' && mixer().soloId === 'stem:vocals', 'Switching solo selects matching original vocal score')
    soloButton('Vocals', true).click()
    await until(() => !mixer().soloId, 'Switched solo turns off')
    check(selectedScore() === 'Vocal melody', 'Unsolo leaves the most recently selected score')
    check(JSON.stringify([...mixer().muted].sort()) === JSON.stringify([...initialMix.muted].sort()), 'Switching solos retains the first pre-solo mute snapshot')
    const vocal = [...container.querySelectorAll('.track-item')].find((item) => item.textContent.includes('Vocal melody'))
    check(vocal, 'Distinct vocal synth track appears alongside original vocals')
    vocal.click()
    await until(() => container.querySelector('.ws[data-instrument="vocals"] .guide canvas') && container.querySelector('.score-osmd svg'), 'Vocal staff and piano roll render')
    check(container.querySelector('.track-button .track-detail').textContent === 'Vocals recording only', 'Selecting vocal notation does not silently change the mixer')
    check(container.querySelector('.track-button').title.includes('Vocal melody is muted'), 'Header tooltip distinguishes muted vocal synth from original vocals')
    container.querySelector('.track-button').click()
    await until(() => container.querySelector('.track-menu'), 'Vocal track details open')
    check(!container.querySelector('.view-error') && !container.querySelector('.ws-head .vocal-note') &&
      container.querySelector('.track-menu .track-row:has([aria-label="Solo Vocal melody"]) .track-detail')?.textContent.includes('vowel synth, no lyrics'),
    'Vocal score renders with its sound limits in the picker instead of a warning banner')
    container.querySelector('.track-button').click()
    await until(() => {
      const canvas = container.querySelector('.guide canvas')
      if (!canvas || !canvas.width || !canvas.height || container.querySelector('.score[aria-busy="true"]')) return false
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      return pixels.some((value, index) => index % 4 === 3 && value > 0)
    }, 'Vocal roll draws real pixels')
    const canvas = container.querySelector('.guide canvas')
    check(canvas.getBoundingClientRect().bottom < window.innerHeight, 'Vocal roll is visible above transport')
    const score = container.querySelector('.score').getBoundingClientRect()
    const sheet = container.querySelector('.score-sheet').getBoundingClientRect()
    const roll = canvas.getBoundingClientRect()
    check(Math.abs(roll.left - sheet.left) < 2, 'Vocal roll aligns horizontally with the score')
    check(Math.abs(container.querySelector('.guide').getBoundingClientRect().bottom - score.bottom) < 2, 'Short vocal scores keep the guide above transport')
    check(!container.querySelector('.unsure-label'), 'Vocal score does not repeat low-confidence labels under every bar')
    container.querySelector('.ws-back').click()
    await until(() => container.querySelector('.song-open'), 'Back action returns to library')
    check(!container.querySelector('.song-analysis') && container.querySelector('.song-meta').textContent.includes('Vocal melody'), 'Library automatically replaces old parts and stale status')
    check(container.querySelector('.song-text .song-meta:nth-child(3)')?.textContent.includes('MuScriptor Large') &&
      !!find('Redo analysis'), 'Fresh results show their new model and remain reprocessable')
    localStorage.setItem(`mizan:mixer:${entry.id}`, JSON.stringify({
      muted: ['piano', 'stem:mix', 'stem:piano', 'stem:guitar', 'stem:bass', 'stem:drums', 'stem:other'],
      volumes: {}, soloId: 'stem:vocals', beforeSolo: ['stem:mix'], enabledStems: ['vocals'],
    }))
    container.querySelector('.song-open').click()
    await until(() => container.querySelector('.track-button'), 'Reopen v4 score with a remembered v3 solo')
    container.querySelector('.track-button').click()
    await until(() => container.querySelector('[aria-label="Unmute Vocal melody"]'), 'Remembered solo mutes the newly added vocal synth')
    check(container.querySelector('[aria-label="Mute Vocals"]') && container.querySelector('[aria-label="Solo Vocals"]').getAttribute('aria-checked') === 'true', 'Original isolated vocals remain the only soloed source')
    check(container.querySelector('.track-button .track-detail').textContent === 'Vocals solo: Vocals recording only', 'Restored solo summary matches the actual audible sources')
    container.querySelector('.ws-back').click()
    await until(() => container.querySelector('.song-open'), 'Back after restored-solo regression')
    newSong.tracks = []
    newSong.piano = []
    newSong.vocals = []
    container.querySelector('.song-open').click()
    await until(() => container.querySelector('.track-button'), 'Recording picker remains available without score notes')
    container.querySelector('.track-button').click()
    await until(() => container.querySelectorAll('.track-stem').length === 7, 'Empty transcription does not hide isolated stems')
    const previousScore = selectedScore()
    const scoreCount = container.querySelectorAll('.track-item[role="menuitemradio"]').length
    soloButton('Drums', true).click()
    await until(() => mixer().soloId === 'stem:drums', 'Recording drums can solo without a drum score')
    check(selectedScore() === previousScore && container.querySelectorAll('.track-item[role="menuitemradio"]').length === scoreCount, 'Missing matching transcription keeps the current score without fabricating one')
    soloButton('Drums', true).click()
    await until(() => !mixer().soloId, 'Recording drums unsolo without a score')
    check(selectedScore() === previousScore, 'Unsolo without a matching score preserves selection')
    return 'Analysis UI passed: job lifecycle, seven recording sources, vocal notation, solo-to-score for synth/stems, unmatched stems, and mute/volume restoration.'
  } finally {
    root.unmount()
    container.remove()
    Object.assign(host, originalHost)
    originalRoot.style.display = ''
    localStorage.removeItem(`mizan:mixer:${entry.id}`)
  }
}
