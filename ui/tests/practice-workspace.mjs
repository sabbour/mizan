// Run by playback.mjs --instrument in its isolated, muted browser.
export async function practiceChecks(phase) {
  const { default: React } = await import('/node_modules/.vite/deps/react.js')
  const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js')
  const { Workspace } = await import('/src/workspace/Workspace.tsx')
  const { Engine } = await import('/src/workspace/engine.ts')
  const { buildSong } = await import('/src/workspace/song.ts')
  const { loadPrefs, savePref } = await import('/src/workspace/prefs.ts')
  const check = (value, message) => { if (!value) throw new Error(message) }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, message) => {
    for (let i = 0; i < 400; i++) {
      if (predicate()) return
      await sleep(50)
    }
    throw new Error(`${message}: ${container.textContent.slice(0, 300)}`)
  }
  const base = buildSong()
  const song = {
    ...base, title: 'Practice view and clock check', bpm: 120, bars: 16, barMap: undefined, tempoMap: undefined,
    sections: [{ name: 'Practice', startBar: 1, bars: 16 }], chords: [], vocals: [],
    tracks: [
      { id: 'piano', instrument: 'piano', name: 'Piano', detail: 'Both hands' },
      { id: 'upper', instrument: 'piano', name: 'Right hand', detail: 'Upper part' },
      { id: 'drums', instrument: 'drums', name: 'Drum kit', detail: 'Drum part' },
    ],
    piano: base.piano.filter((note) => note.startBeat < 64).flatMap((note) => [
      { ...note, trackId: 'piano' }, { ...note, trackId: 'upper', midi: note.midi + 12 },
    ]),
    drums: base.drums.filter((hit) => hit.startBeat < 64).map((hit) => ({ ...hit, trackId: 'drums' })),
  }
  const stems = [{ id: 'mix', label: 'Full mix', url: '/samples/piano/A4-v5.ogg', level: 1 }]
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;inset:0;z-index:100;overflow:auto'
  document.body.append(container)
  const root = ReactDOM.createRoot(container)
  const engines = new Set()
  const originalSelect = Engine.prototype.selectPart
  let engine, release, restoreContext
  Engine.prototype.selectPart = function (id) {
    engine = this
    engines.add(this)
    return originalSelect.call(this, id)
  }
  const find = (selector) => container.querySelector(selector)
  const view = () => find('.chordview-option[aria-checked="true"]')?.dataset.view
  const render = async (key, piece = song, defaults = {}) => {
    root.render(React.createElement(Workspace, {
      key, song: piece, songId: `practice-browser-${key}`, stems, defaults,
      start: { bar: 1, rate: 1, loop: { startBar: 1, endBar: piece.bars }, muted: [], solo: [], trackId: piece.tracks[0].id },
    }))
    await until(() => engine?.song === piece && find('.score[aria-busy="false"]'), `${key} opens`)
  }
  const pickView = async (choice) => {
    const button = find(`.chordview-option[data-view="${choice}"]`)
    check(button, `${choice} is available`)
    button.click()
    await until(() => view() === choice, `${choice} selected`)
  }
  const menu = async () => {
    if (!find('.track-menu')) find('.track-button').click()
    await until(() => find('.track-menu'), 'Track menu opens')
  }
  const select = async (name, id) => {
    await menu()
    const item = [...container.querySelectorAll('[role="menuitemradio"]')]
      .find((row) => row.querySelector('.track-name')?.textContent === name)
    check(item, `${name} is listed`)
    item.click()
    await until(() => engine.selectedPart === id && find('.track-button .track-name')?.textContent.startsWith(name),
      `${name} selected`)
  }
  const clock = () => ({
    engine, beat: engine.read().beat, time: engine.ctx.currentTime, anchors: engine.anchors,
    revision: engine.revision, timer: engine.timer, muted: [...engine.muted].sort().join(),
    gains: JSON.stringify([...engine.trackGains]), loop: JSON.stringify(engine.loop), rate: engine.rate,
  })
  const sameClock = (before, message) => {
    const elapsed = engine.ctx.currentTime - before.time
    const expected = before.beat + elapsed * song.bpm * before.rate / 60
    check(engine === before.engine && engine.playing && engine.anchors === before.anchors &&
      engine.timer === before.timer && engine.revision === before.revision &&
      Math.abs(engine.read().beat - expected) < 0.08, `${message}: the same clock continues at its current position`)
    check([...engine.muted].sort().join() === before.muted && JSON.stringify([...engine.trackGains]) === before.gains &&
      JSON.stringify(engine.loop) === before.loop && engine.rate === before.rate,
      `${message}: mutes, faders, loop and speed stay unchanged`)
  }
  try {
    if (phase !== 'session') {
      const stored = localStorage.getItem('mizan:practice')
      check(loadPrefs().pianoView === 'hands' && loadPrefs().drumsView === 'kit',
        `Both separate view preferences survive ${phase}`)
      await render('restart', song, { piano: 'keyboard', drums: 'score' })
      check(view() === 'hands' && !engine.playing && engine.read().beat === 0, 'Restart restores Hands & keys, stopped')
      await select('Drum kit', 'drums')
      check(view() === 'kit', 'Restart also restores the drum kit')
      check(localStorage.getItem('mizan:practice') === stored, 'Opening and changing parts never rewrite preferences')
      return `Practice ${phase} checks passed: separate piano/drum views restored without preference writes.`
    }

    localStorage.removeItem('mizan:practice')
    for (const [key, value] of Object.entries({ countIn: false, rate: 0.75, click: false, sticking: false,
      kitStyle: 'electronic:Realistic' })) savePref(key, value)
    const initial = localStorage.getItem('mizan:practice')
    await render('first')
    check(view() === 'score' && localStorage.getItem('mizan:practice') === initial,
      'Without a saved view, the song default applies and does not write preferences')
    await pickView('score')
    await pickView('hands')
    check(loadPrefs().pianoView === 'hands' && loadPrefs().drumsView === undefined, 'Only the selected piano view is saved')
    engine.seek(6.5)
    await select('Drum kit', 'drums')
    check(!engine.playing && engine.read().beat === 6.5 && view() === 'score',
      'A paused part switch keeps the position and the other instrument default')
    await pickView('kit')
    await select('Right hand', 'upper')
    check(view() === 'hands' && loadPrefs().drumsView === 'kit', 'Piano parts share the piano view, not the drum view')
    await render('another', { ...song, title: 'Another practice song' }, { piano: 'keyboard', drums: 'score' })
    check(view() === 'hands', 'The saved piano view overrides a different song or lesson default')
    await select('Drum kit', 'drums')
    check(view() === 'kit', 'The drum kit view also follows to another song')
    await select('Piano', 'piano')
    await pickView('keyboard')
    const preferred = localStorage.getItem('mizan:practice')
    const drumOnly = { ...song, title: 'Drums only', piano: [], tracks: [song.tracks[2]] }
    await render('drum-only', drumOnly)
    check(view() === 'kit' && !find('[data-view="keyboard"]') && localStorage.getItem('mizan:practice') === preferred,
      'A song without piano offers its available drum view without overwriting the piano preference')

    const getContext = HTMLCanvasElement.prototype.getContext
    restoreContext = () => { HTMLCanvasElement.prototype.getContext = getContext }
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null
      return getContext.call(this, type, ...args)
    }
    await render('flat-fallback')
    await until(() => find('.practice-piano .practice-failure') && find('.practice-hands'), 'Unavailable 3D piano shows its flat guide')
    check(view() === 'keyboard' && localStorage.getItem('mizan:practice') === preferred,
      'A temporary 3D fallback preserves the preferred 3D view')
    restoreContext()
    restoreContext = null
    await render('supported-again')
    await until(() => find('.practice-piano')?.dataset.ready === 'true', 'The supported song restores the preferred 3D piano')
    check(localStorage.getItem('mizan:practice') === preferred, 'The restored 3D view also makes no preference write')
    await pickView('hands')

    await menu()
    const volume = find('.track-row:has([aria-label="Mute Piano"]) input')
    check(volume, 'Piano fader is available')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(volume, '0.4')
    volume.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() => engine.trackGains.get('piano') === 0.4, 'Piano fader changes')
    find('[aria-label="Mute Drum kit"]').click()
    await until(() => engine.muted.has('drums'), 'Drums are muted')
    await select('Piano', 'piano')
    engine.seek(6.5)
    await engine.play()
    await until(() => !engine.starting && engine.read().beat > 6.5, 'The song plays after sound preparation')
    await until(() => engine.buses.has('piano') && engine.buses.has('upper'), 'Both piano parts have audio buses')
    const activeEngines = engines.size
    for (const [name, id] of [['Drum kit', 'drums'], ['Right hand', 'upper'], ['Piano', 'piano'],
      ['Right hand', 'upper'], ['Drum kit', 'drums'], ['Piano', 'piano']]) {
      const before = clock()
      await select(name, id)
      await sleep(160)
      sameClock(before, `Playing switch to ${name}`)
      check(['piano', 'upper'].every((part) => Math.abs(engine.buses.get(part).gain.value - engine.level(part)) < 0.035),
        'The existing voices smoothly change emphasis to match the selected part')
      check(engine.level('drums') === 0 && engine.trackGains.get('piano') === 0.4,
        'Selection cannot unmute drums or replace the piano fader')
    }
    check(engines.size === activeEngines, 'Repeated part switches never create another engine')
    for (let i = 0; i < 5; i++) {
      const rate = Math.round((engine.rate - 0.05) * 20) / 20
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true }))
      await until(() => engine.rate === rate, 'Speed decreases in one step')
    }
    check(engine.rate === 0.5, 'The second clock check uses half speed')
    for (const [name, id] of [['Right hand', 'upper'], ['Drum kit', 'drums'], ['Piano', 'piano']]) {
      const before = clock()
      await select(name, id)
      sameClock(before, `Half-speed switch to ${name}`)
    }
    await menu()
    find('[aria-label="Solo Right hand"]').click()
    await until(() => engine.selectedPart === 'upper' && engine.muted.has('piano'), 'Solo selects the upper part')
    const soloClock = clock()
    await select('Drum kit', 'drums')
    sameClock(soloClock, 'A switch with solo active')
    await menu()
    check(find('[aria-label="Solo Right hand"]').getAttribute('aria-checked') === 'true', 'Selection keeps the active solo')
    find('[aria-label="Solo Right hand"]').click()
    await until(() => !engine.muted.has('piano') && engine.muted.has('drums'), 'Stopping solo restores earlier mutes')
    engine.pause()
    find('.track-button').click()
    const countIn = [...container.querySelectorAll('.toggle')].find((button) => button.querySelector('.toggle-label')?.textContent === 'Count-in')
    countIn.click()
    await until(() => engine.countIn, 'Count-in is on')
    const loadSamples = engine.loadSamples
    let loads = 0
    const gate = new Promise((resolve) => { release = resolve })
    engine.loadSamples = async function () { loads++; await gate; return loadSamples.call(this) }
    const preparing = engine.play()
    await until(() => engine.starting && engine.recording, 'Preparation includes the recording route')
    const revision = engine.revision, pausedBeat = engine.pausedBeat
    await select('Right hand', 'upper')
    await select('Piano', 'piano')
    check(engine.starting && engine.revision === revision && engine.pausedBeat === pausedBeat && loads === 1,
      'Part changes during loading do not cancel or restart preparation')
    release()
    release = null
    await preparing
    engine.loadSamples = loadSamples
    await until(() => engine.read().countingIn, 'The original preparation begins its count-in')
    const anchors = engine.anchors, timer = engine.timer, counting = engine.read()
    await select('Drum kit', 'drums')
    const after = engine.read()
    check(engine.playing && engine.anchors === anchors && engine.timer === timer &&
      (!after.countingIn || after.countBeat >= counting.countBeat), 'Part switching keeps the current count-in instead of beginning it again')
    engine.pause()
    await select('Piano', 'piano')
    check(!engine.playing && engine.read().beat === pausedBeat, 'Switching a paused count-in does not start or rewind it')
    await pickView('hands')
    countIn.click()
    await until(() => !engine.countIn, 'Count-in is off before navigation')
    await engine.play()
    const old = engine
    await render('different-song', { ...song, title: 'A different song' }, { piano: 'keyboard', drums: 'score' })
    check(!old.playing && old.ctx === null && old.nodes.size === 0 && !engine.playing && engine.read().beat === 0,
      'A different song disposes the old voices and opens from the top, stopped')
    check(view() === 'hands' && loadPrefs().drumsView === 'kit' && loadPrefs().rate === 0.5 &&
      loadPrefs().click === false && loadPrefs().sticking === false && loadPrefs().kitStyle === 'electronic:Realistic',
      'Views remain separate without changing the other saved preferences')
    return 'Practice checks passed: independent saved views, song/lesson defaults, unavailable instrument and 3D fallback, ' +
      'paused/playing/repeated switches at 75% and 50%, mixer/solo retention, loading/count-in clock continuity, different-song disposal.'
  } finally {
    release?.()
    restoreContext?.()
    root.unmount()
    container.remove()
    Engine.prototype.selectPart = originalSelect
    for (const item of engines) item.dispose()
    for (const key of Object.keys(localStorage)) if (key.startsWith('mizan:mixer:practice-browser-')) localStorage.removeItem(key)
  }
}
