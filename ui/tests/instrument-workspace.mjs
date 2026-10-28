// Browser check run by playback.mjs --instrument against the Vite dev server.
export async function instrumentChecks() {
  const { default: React } = await import('/node_modules/.vite/deps/react.js')
  const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js')
  const { Workspace } = await import('/src/workspace/Workspace.tsx')
  const { Engine } = await import('/src/workspace/engine.ts')
  const { GM_CHOICES } = await import('/src/workspace/gmInstruments.ts')
  const { drumXml, instrumentXml } = await import('/src/workspace/musicxml.ts')
  const { buildSong } = await import('/src/workspace/song.ts')
  const { fromHost } = await import('/src/library/adapt.ts')
  const { creativeTracks } = await import('/src/workspace/creative.ts')
  const osmdModule = await import('/node_modules/.vite/deps/opensheetmusicdisplay.js')
  const OpenSheetMusicDisplay = osmdModule.OpenSheetMusicDisplay ?? osmdModule.default?.OpenSheetMusicDisplay
  const check = (value, message) => { if (!value) throw new Error(message) }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const drumOnly = fromHost({
    ...buildSong(), piano: [], vocals: [], tracks: [{ id: 'drums', instrument: 'drums', name: 'Drum kit', detail: 'Draft hits' }],
  })
  check(drumOnly.tracks.length === 1 && drumOnly.tracks[0].id === 'drums' && creativeTracks(drumOnly).length === 0,
    'A drum-only transcription does not offer chord or harmony tracks')
  check(!new DOMParser().parseFromString(drumXml(drumOnly, false), 'application/xml').querySelector('harmony'),
    'Drum-only score does not claim chord symbols')
  const hydrated = fromHost({
    ...buildSong(),
    bars: 1,
    piano: [],
    vocals: [],
    drums: [],
    chords: [],
    tracks: [
      { id: 'instrument-clean-electric-guitar', instrument: 'other', name: 'Clean Electric Guitar',
        detail: 'Draft notes', group: 'detected', sourceInstrument: 'clean_electric_guitar' },
      { id: 'instrument-electric-guitar', instrument: 'other', name: 'Electric Guitar',
        detail: 'Draft notes', sourceInstrument: 'electric_guitar' },
    ],
    instrumentNotes: {
      'instrument-clean-electric-guitar': [{ midi: 64, startBeat: 0, beats: 1 }],
    },
  })
  check(hydrated.tracks[0].gmProgram === 27 && hydrated.tracks[1].gmProgram === undefined,
    'Legacy guitar hydration assigns only the exact clean-electric-guitar GM program')
  const legacyEngine = new Engine(hydrated)
  const legacySources = []
  const fakeGain = () => ({
    gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
      setTargetAtTime(value) { this.value = value } },
    connect(destination) { this.destination = destination; return destination },
  })
  const legacyContext = {
    currentTime: 0,
    decodeAudioData: async (data) => ({ duration: 1, data }),
    createGain: fakeGain,
    createBufferSource: () => {
      const source = {
        playbackRate: { value: 1 },
        connect(destination) { this.destination = destination; return destination },
        start() {},
        stop() {},
      }
      legacySources.push(source)
      return source
    },
  }
  legacyEngine.ctx = legacyContext
  legacyEngine.master = {}
  await legacyEngine.loadGmSamples(legacyContext)
  legacyEngine.muted = new Set(hydrated.tracks
    .filter((track) => track.id !== 'instrument-clean-electric-guitar')
    .map((track) => track.id))
  legacyEngine.events(0, 1, 0, 0.5, false)
  check(legacyEngine.gmSamples.has(27), 'Legacy detected guitar loads GM27 samples')
  check(legacySources.length === 1, 'Legacy detected guitar schedules its instrument note')
  check(legacySources[0].destination.destination === legacyEngine.buses.get('instrument-clean-electric-guitar'),
    'Legacy detected guitar routes to its mixer bus')
  check(legacyEngine.buses.get('instrument-clean-electric-guitar').gain.value === 1,
    'Legacy detected guitar remains audible when soloed')
  legacyEngine.muted.add('instrument-clean-electric-guitar')
  legacyEngine.refreshMix()
  check(legacyEngine.buses.get('instrument-clean-electric-guitar').gain.value === 0,
    'The legacy guitar route responds to mixer mute')
  const guitar = { id: 'instrument-guitar', instrument: 'other', name: 'Guitar', detail: 'Draft notes' }
  const bass = { id: 'instrument-bass', instrument: 'other', name: 'Bass', detail: 'Draft notes' }
  const song = {
    ...buildSong(), title: 'Other instruments', bars: 2, chords: [], piano: [], vocals: [], drums: [],
    sections: [{ name: 'Study', startBar: 1, bars: 2 }], tracks: [guitar, bass],
    instrumentNotes: {
      [guitar.id]: [
        { trackId: guitar.id, midi: 64.5, startBeat: 0, beats: 5 },
        { trackId: guitar.id, midi: 67, startBeat: 0, beats: 1 },
        { trackId: guitar.id, midi: 71, startBeat: 0.5, beats: 1 },
      ],
      [bass.id]: [{ trackId: bass.id, midi: 40, startBeat: 0, beats: 2 }],
    },
  }
  for (const track of [guitar, bass]) {
    const xml = new DOMParser().parseFromString(instrumentXml(song, track), 'application/xml')
    check(!xml.querySelector('parsererror'), `${track.name} XML parses`)
    check(xml.querySelectorAll('clef').length === 1 && !xml.querySelector('staves, fingering, technical'),
      `${track.name} has one pitched staff and no fabricated hands, tabs or fingering`)
    check(xml.querySelector('clef sign')?.textContent === (track === bass ? 'F' : 'G'), `${track.name} has an appropriate clef`)
    check(xml.querySelectorAll('pitch').length >= (track === guitar ? 4 : 1), `${track.name} notes are in the score`)
  }
  const guitarXml = new DOMParser().parseFromString(instrumentXml(song, guitar), 'application/xml')
  check(guitarXml.querySelector('lyric text')?.textContent === '+50¢' &&
    guitarXml.querySelector('pitch step')?.textContent === 'E',
  'Fractional pitches are shown as cent offsets beside the nearest engravable note')
  check(guitarXml.querySelector('measure[number="2"] tie[type="stop"]'), 'Notes tied across barlines')
  check(guitarXml.querySelector('measure[number="1"] backup'), 'Overlapping notes use independent voices')
  const steelGuitar = { ...guitar, gmProgram: 25 }
  const steelXml = new DOMParser().parseFromString(instrumentXml(song, steelGuitar), 'application/xml')
  check(steelXml.querySelector('midi-instrument midi-program')?.textContent === '26',
    'MusicXML exports the one-based GM guitar program')
  const guitarEngine = new Engine({ ...song, tracks: [steelGuitar], instrumentNotes: {
    [steelGuitar.id]: song.instrumentNotes[guitar.id],
  } })
  const guitarPlayed = []
  guitarEngine.gmNote = (...args) => guitarPlayed.push(args)
  guitarEngine.sampleNote = () => { throw new Error('MIDI guitar preview must not use piano samples') }
  guitarEngine.bus = (id) => id
  guitarEngine.events(0, 0.75, 0, 0.5, false)
  check(guitarPlayed.length === 3 && guitarPlayed.every((args) => args[4] === steelGuitar.id),
    'GM guitar programs use the matched sound-bank router on their mixer bus')
  const organ = { id: 'instrument-organ', instrument: 'other', name: 'Organ', detail: 'Draft notes' }
  const organSong = { ...song, tracks: [organ], instrumentNotes: { [organ.id]: [
    { midi: 48, startBeat: 0, beats: 1 }, { midi: 72, startBeat: 0.40625, beats: 1 },
  ] } }
  const organXml = new DOMParser().parseFromString(instrumentXml(organSong, organ), 'application/xml')
  check(organXml.querySelectorAll('clef').length === 2 &&
    organXml.querySelector('clef[number="1"] sign')?.textContent === 'G' &&
    organXml.querySelector('clef[number="2"] sign')?.textContent === 'F' &&
    organXml.querySelector('measure[number="1"] note:has(pitch step:first-child)') !== null &&
    organXml.querySelector('measure[number="1"] note:has(staff)') !== null,
  'Mixed-register organ notes use treble and bass staves')
  check(organXml.querySelector('attributes divisions')?.textContent === '16' &&
    [...organXml.querySelectorAll('measure[number="1"] note')].some((n) =>
      n.querySelector('pitch step')?.textContent === 'C' && n.querySelector('staff')?.textContent === '1'),
  'Fractional-beat organ notes retain finer score timing')
  const probe = document.createElement('div')
  document.body.append(probe)
  try {
    const osmd = new OpenSheetMusicDisplay(probe)
    await osmd.load(instrumentXml(song, guitar))
    osmd.render()
  } catch (error) {
    throw new Error(`Instrument engraving failed: ${error.stack}; exports ${Object.keys(osmdModule)}`)
  } finally { probe.remove() }
  const engine = new Engine(song)
  const played = []
  engine.sampleNote = (time, midi, duration, velocity, bus) => played.push({ midi, duration, bus })
  engine.bus = (id) => id
  engine.events(0, 0.75, 0, 0.5, false)
  check(played.length === 4 && played.filter((note) => note.bus === guitar.id).length === 3 &&
    played.some((note) => note.bus === bass.id && note.midi === 40), 'Notes route to their own mixer buses')
  played.length = 0
  engine.events(1, 1.25, 0, 0.5, true)
  check(played.some((note) => note.midi === 64.5 && note.duration > 0), 'Seeking resumes held generic notes')
  const organEngine = new Engine(organSong)
  const organPlayed = []
  organEngine.organ = (...args) => organPlayed.push(args)
  organEngine.events(0, 0.75, 0, 0.5, false)
  check(organPlayed.length === 2 && organPlayed.every((args) => args[4] === organ.id),
    'Organ-labelled notes use organ synthesis instead of piano samples')
  const audible = new Engine(song)
  audible.countIn = false
  try {
    await audible.play()
    await wait(200)
    check(audible.buses.has(guitar.id) && audible.buses.has(bass.id) &&
      [...audible.nodes].some((node) => node instanceof AudioBufferSourceNode),
    'Both generic tracks schedule real sample playback')
    audible.muted.add(guitar.id)
    audible.refreshMix()
    await wait(120)
    check(audible.buses.get(guitar.id).gain.value < 0.01 && audible.buses.get(bass.id).gain.value > 0.9,
      'Muting guitar leaves the bass synth playing')
  } finally { audible.dispose() }
  const audibleOrgan = new Engine({ ...organSong, chords: [] })
  audibleOrgan.countIn = false
  try {
    await audibleOrgan.play()
    await wait(150)
    check([...audibleOrgan.nodes].some((node) => node instanceof OscillatorNode) &&
      audibleOrgan.buses.has(organ.id), 'Organ synthesis schedules sustained oscillators on its own mixer bus')
  } finally { audibleOrgan.dispose() }

  const container = document.createElement('div')
  document.body.append(container)
  const root = ReactDOM.createRoot(container)
  const until = async (predicate, message) => {
    for (let i = 0; i < 80; i++) {
      if (predicate()) return
      await wait(100)
    }
    throw new Error(`${message}: ${container.textContent.slice(0, 600)}`)
  }
  const find = (label) => container.querySelector(`[aria-label="${label}"]`)
  const originalUpdateSong = Engine.prototype.updateSong
  let liveEngine
  Engine.prototype.updateSong = function (next) {
    if (next.title === 'Instrument correction regression') liveEngine = this
    return originalUpdateSong.call(this, next)
  }
  try {
    root.render(React.createElement(Workspace, {
      song, songId: 'generic-instrument-browser-check',
      defaults: { guitar: 'score', bass: 'score' },
      stems: [{ id: 'guitar', label: 'Guitar', url: '/samples/piano/A4-v5.ogg', level: 0.2 }],
    }))
    await until(() => container.querySelector('.score[aria-busy="false"]'), 'Guitar score rendered')
    check(container.querySelector('.score-osmd svg') && container.querySelector('.head-letter') === null,
      `Pitched score is drawn without forcing note letters: ${container.querySelector('.view-error')?.textContent ?? container.querySelector('.score-osmd')?.innerHTML.slice(0, 200)}`)
    check(container.querySelector('[aria-label^="Transcribed instrument pitch roll"]'), 'Instrument pitch roll is available')
    container.querySelector('.transport button[title^="Note letters"]').click()
    await until(() => container.querySelector('.head-letter'), 'Note letters drawn inside generic score heads')
    check(!container.textContent.includes('No score/tab is available'), 'Guitar recording is not reported as scoreless')
    container.querySelector('.track-button').click()
    await until(() => find('Solo Guitar'), 'Guitar mixer controls appear')
    check(container.querySelector('.track-row .track-detail')?.textContent.includes('piano preview') &&
      !container.querySelector('.ws-head .vocal-note'), 'Preview timbre is disclosed in the picker without a warning banner')
    check(find('Mute Guitar') && find('Solo Bass'), 'Generic tracks have independent mute/solo controls')
    find('Solo Bass').click()
    await wait(100)
    check(find('Solo Bass').getAttribute('aria-checked') === 'true' && find('Unmute Guitar'),
      'Solo bass mutes guitar')
    check(container.querySelector('.track-button .track-name').textContent === 'Bass', 'Solo selects its score')
    find('Solo Bass').click()
    await wait(100)
    check(find('Mute Guitar') && find('Mute Bass'), 'Stopping solo restores track mutes')
    const guitarSelect = [...container.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent.includes('Guitar'))
    guitarSelect.click()
    await until(() => container.querySelector('.track-button .track-name')?.textContent === 'Guitar', 'Guitar selected again')
    container.querySelector('.track-button').click()
    await until(() => find('Solo Guitar'), 'Mixer reopened')
    find('Mute Guitar').click()
    await wait(100)
    check(find('Unmute Guitar') && find('Mute Bass'), 'Muting guitar does not mute bass')
    const drumStudy = {
      ...drumOnly, bars: 8, sections: [{ name: 'Drum study', startBar: 1, bars: 8 }],
      confidence: { ...drumOnly.confidence, drums: Array(8).fill('low') },
    }
    root.render(React.createElement(Workspace, {
      key: 'drum-only', song: drumStudy, songId: 'drum-only-browser-check',
      stems: [{ id: 'mix', label: 'Full mix', url: '/samples/piano/A4-v5.ogg', level: 1 },
        { id: 'drums', label: 'Drums', url: '/samples/drums/kick.ogg', level: 1 }],
    }))
    await until(() => container.querySelector('.score[aria-busy="false"]') &&
      container.querySelector('.track-button .track-name')?.textContent === 'Drum kit', 'Drum-only score rendered')
    const brackets = [...container.querySelectorAll('.score-overlay .unsure')]
    check(brackets.length === 0, 'A uniformly low-confidence draft does not repeat the same warning below every bar')
    container.querySelector('.track-button').click()
    await until(() => container.querySelector('.track-menu'), 'Drum-only track menu opened')
    check([...container.querySelectorAll('.track-menu .track-name')].every((item) =>
      !/Chords|comping|Harmony|Vocals/.test(item.textContent)), 'No unsupported tonal or vocal parts in the drum-only menu')
    let correctedSong = {
      ...song, title: 'Instrument correction regression', bars: 16,
      tracks: [{ id: 'flute', instrument: 'other', name: 'Flute', gmProgram: 73, detail: 'Draft notes' },
        { id: 'violin', instrument: 'other', name: 'Violin', gmProgram: 40, detail: 'Draft notes' },
        { id: 'kit', instrument: 'drums', name: 'Drum kit', detail: 'Draft hits' },
        { id: 'empty', instrument: 'other', name: 'Empty part', gmProgram: 73, detail: 'No notes' }],
      drums: [{ trackId: 'kit', lane: 'kick', startBeat: 3.5, velocity: 0.8 }],
      instrumentNotes: { flute: [{ midi: 60, startBeat: 4.25, beats: 20, velocity: 0.7 }],
        violin: [{ midi: 64, startBeat: 9.5, beats: 20, velocity: 0.7 }] },
    }
    const renderCorrection = () => root.render(React.createElement(Workspace, {
      key: 'correction', song: correctedSong, songId: 'instrument-correction-browser-check',
      onSaveInstrument: async (id, program) => {
        correctedSong = { ...correctedSong, tracks: correctedSong.tracks.map((part) =>
          part.id === id ? { ...part, gmProgram: program, name: GM_CHOICES.find((item) => item.program === program).name } : part) }
        renderCorrection()
      },
    }))
    renderCorrection()
    await until(() => liveEngine && find('Go to first note'), 'First-note action mounted')
    find('Go to first note').click()
    check(liveEngine.read().beat === 4.25 && !liveEngine.playing, 'First-note action skips leading rests without autoplay')
    container.querySelector('.track-button').click()
    await until(() => find('Change Flute instrument'), 'Instrument editor available')
    find('Change Flute instrument').click()
    await until(() => container.querySelector('.track-instrument-field select'), 'Native instrument select appears')
    const select = container.querySelector('.track-instrument-field select')
    check(document.activeElement === select, 'Instrument select receives native keyboard focus')
    const labels = [...select.options].slice(1).map((option) => option.textContent)
    check(JSON.stringify(labels) === JSON.stringify([...labels].sort((a, b) => a.localeCompare(b, 'en'))),
      'Displayed instrument names are alphabetized')
    select.value = '40'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await wait(50)
    container.querySelector('.track-instrument-actions button[type="submit"]').click()
    await until(() => liveEngine.song.tracks[0].gmProgram === 40, 'Paused correction applied')
    check(!liveEngine.playing && liveEngine.read().beat === 4.25, 'Paused correction retains its precise beat')
    liveEngine.countIn = false
    find('Play').click()
    await until(() => liveEngine.read().playing && liveEngine.nodes.size > 0, 'Corrected instrument is sounding')
    const incumbent = liveEngine
    const beforeBeat = liveEngine.read().beat
    const beforeRate = liveEngine.rate
    container.querySelector('.track-button').click()
    await until(() => find('Change Violin instrument'), 'Live editor available')
    // Both parts are now named Violin: the first editor belongs to the viewed flute-ID part.
    find('Change Violin instrument').click()
    await until(() => container.querySelector('.track-instrument-field select'), 'Live select appears')
    const liveSelect = container.querySelector('.track-instrument-field select')
    liveSelect.value = '73'
    liveSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await wait(50)
    container.querySelector('.track-instrument-actions button[type="submit"]').click()
    await until(() => liveEngine.song.tracks[0].gmProgram === 73, 'Live correction applied')
    check(liveEngine === incumbent && liveEngine.playing && liveEngine.read().beat >= beforeBeat &&
      liveEngine.rate === beforeRate, 'Live correction keeps the same running clock and speed')
    find('Go to first note').click()
    check(liveEngine.playing && Math.abs(liveEngine.read().beat - 4.25) < 0.1, 'First-note seek preserves active playback')
    liveEngine.pause()
    container.querySelector('.track-button').click()
    await until(() => container.querySelector('.track-menu'), 'Part picker reopened')
    const violinChoice = [...container.querySelectorAll('[role="menuitemradio"]')].find((item) =>
      item.querySelector('.track-name')?.textContent === 'Violin')
    violinChoice.click()
    await wait(100)
    find('Go to first note').click()
    check(liveEngine.read().beat === 9.5 && !liveEngine.playing, 'First note follows the currently viewed part')
    container.querySelector('.track-button').click()
    await until(() => container.querySelector('.track-menu'), 'Drum part picker opens')
    ;[...container.querySelectorAll('[role="menuitemradio"]')].find((item) =>
      item.querySelector('.track-name')?.textContent === 'Drum kit').click()
    await wait(100)
    find('Go to first note').click()
    check(liveEngine.read().beat === 3.5 && !liveEngine.playing, 'Drum first-note seek uses the hit beat without autoplay')
    container.querySelector('.track-button').click()
    await until(() => container.querySelector('.track-menu'), 'Empty part picker opens')
    ;[...container.querySelectorAll('[role="menuitemradio"]')].find((item) =>
      item.querySelector('.track-name')?.textContent === 'Empty part').click()
    await wait(100)
    check(find('Go to first note').disabled, 'An empty part disables the first-note action')
    return 'Instrument scores, alphabetical editor, continuous corrections and first-playable-note controls passed'
  } finally {
    Engine.prototype.updateSong = originalUpdateSong
    root.unmount()
    container.remove()
    engine.dispose()
    localStorage.removeItem('mizan:mixer:generic-instrument-browser-check')
    localStorage.removeItem('mizan:mixer:drum-only-browser-check')
    localStorage.removeItem('mizan:mixer:instrument-correction-browser-check')
  }
}
