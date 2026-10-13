// Run by playback.mjs --fretted in an isolated, muted browser.
export async function tabChecks() {
  const { default: React } = await import('/node_modules/.vite/deps/react.js')
  const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js')
  const { GuitarTabView } = await import('/src/workspace/GuitarTabView.tsx')
  const { frettedLessonById, frettedLessonSong } = await import('/src/course/fretted.ts')
  const check = (value, message) => { if (!value) throw new Error(message) }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, message) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return
      await sleep(50)
    }
    throw new Error(message)
  }
  const song = frettedLessonSong(frettedLessonById('guitar-open-strings'))
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;inset:16px;z-index:100;overflow:auto'
  document.body.append(container)
  const root = ReactDOM.createRoot(container)
  const find = (selector) => container.querySelector(selector)
  const render = (beat) => root.render(React.createElement(GuitarTabView, {
    song, track: song.tracks[0], beat, playing: false, onPick: render,
  }))
  try {
    render(0)
    await until(() => find('.fretted-tab-note'), 'Tab notes draw')
    await sleep(100)
    check(container.querySelectorAll('.fretted-tab-measure').length === 4, 'Four compact bars appear together')
    check(container.querySelectorAll('.fretted-string-row').length === 6 &&
      find('.fretted-string-label').textContent === 'E4', 'The six strings keep their conventional order')
    const fret = find('.fretted-fret')
    check(Number.parseFloat(getComputedStyle(fret).fontSize) >= 14 &&
      fret.getBoundingClientRect().height >= 21, 'Compact fret numbers stay readable')
    const tabSize = { staff: find('.fretted-tab-staff').getBoundingClientRect().height,
      panel: find('.fretted-tab').getBoundingClientRect().height }
    check(tabSize.staff <= 230 && tabSize.panel <= 320,
      `The tab remains a compact strip, not a full-height panel: ${JSON.stringify(tabSize)}`)
    check(find('.fretted-rhythm') && !find('.fretted-duration'), 'Rhythm marks replace long duration tails')
    const staff = find('.fretted-tab-staff').getBoundingClientRect()
    const rhythm = find('.fretted-rhythm').getBoundingClientRect()
    check(rhythm.top > staff.top + 140, 'Rhythm marks sit below the strings')
    check(container.querySelectorAll('.fretted-string-line').length === 24, 'All four bars have actual six-string lines')
    find('[aria-label="Next measure"]').click()
    await until(() => find('.fretted-active-bar')?.parentElement.dataset.bar === '2', 'Measure navigation moves the playhead')
    render(8)
    await until(() => find('.fretted-active-bar')?.parentElement.dataset.bar === '3', 'An external seek updates the highlighted bar')
    await sleep(50)
    const scroll = find('.fretted-tab-scroll')
    const active = find('.fretted-active-bar').getBoundingClientRect()
    const viewport = scroll.getBoundingClientRect()
    check(active.left >= viewport.left - 1 && active.right <= viewport.right + 1,
      'The current compact bar stays visible after a seek')
    const eighths = frettedLessonSong(frettedLessonById('guitar-eighth-note-counting'))
    root.render(React.createElement(GuitarTabView, {
      song: eighths, track: eighths.tracks[0], beat: 0, playing: false, onPick: () => {},
    }))
    await until(() => find('.fretted-beam'), 'Eighth-note rhythm uses beams')
    return 'Compact four-bar tab, readable frets, rhythm below the strings, beams and current-bar follow checks passed.'
  } finally {
    root.unmount()
    container.remove()
  }
}

export async function frettedChecks() {
  const { default: React } = await import('/node_modules/.vite/deps/react.js')
  const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js')
  const { Workspace } = await import('/src/workspace/Workspace.tsx')
  const { Engine } = await import('/src/workspace/engine.ts')
  const { frettedLessonById, frettedLessonSong } = await import('/src/course/fretted.ts')
  const { loadPrefs } = await import('/src/workspace/prefs.ts')
  const { instrumentXml } = await import('/src/workspace/musicxml.ts')
  const check = (value, message) => { if (!value) throw new Error(message) }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, message) => {
    for (let i = 0; i < 400; i++) {
      if (predicate()) return
      await sleep(50)
    }
    throw new Error(message)
  }
  localStorage.removeItem('mizan:practice')
  const query = (selector) => document.querySelector(selector)
  const fretboardVisible = (section, strings) => {
    const stage = section.querySelector('.fretted-stage').getBoundingClientRect()
    const labels = [...section.querySelectorAll('.fretted-overlay-string-label')]
    check(labels.length === strings, `All ${strings} string labels appear in the fretboard close-up`)
    const current = section.querySelector('.fretted-position[data-state="playback"]')
    check(current, 'The current note has a visible fretboard marker')
    for (const item of [...labels, current]) {
      const rect = item.getBoundingClientRect()
      check(rect.width > 0 && rect.height > 0 && rect.left >= stage.left && rect.right <= stage.right &&
        rect.top >= stage.top && rect.bottom <= stage.bottom, 'String labels and the current note remain inside the visible fretboard')
    }
  }
  query('[data-tab="course"]').click()
  await until(() => query('[data-instrument="guitar"]'), 'Guitar is available in Course')
  for (const instrument of ['guitar', 'bass']) {
    query(`[data-instrument="${instrument}"]`).click()
    await sleep(100)
    query('[data-fretted-shelf="course"]').click()
    await sleep(100)
    const lesson = [...document.querySelectorAll('.course-lesson')].find((button) =>
      button.textContent.includes(instrument === 'guitar' ? 'Name the open strings' : 'Name the four open strings'))
    check(lesson, `${instrument} open-string lesson is listed`)
    lesson.click()
    await until(() => query('.ws'), `${instrument} course opens a workspace`)
    check(query('[data-view="fretboard"][aria-checked="true"]'), `${instrument} lesson opens its 3D fretboard and tab`)
    await until(() => Number(query('.fretted-practice')?.dataset.triangles) > 0,
      `${instrument} model renders actual triangles`)
    check(!query('.fretted-failure') && query(`.fretted-tab[data-instrument="${instrument}"]`),
      `${instrument} has a working 3D view with tab below it`)
    const physical = query('.fretted-practice')
    fretboardVisible(physical, instrument === 'guitar' ? 6 : 4)
    const handedness = physical.querySelector('.fretted-toolbar select')
    check(handedness?.querySelector('option[value="left"]'), 'Left-handed alignment is available')
    const capture = async () => {
      if (globalThis.__mizanFrettedShot) {
        await sleep(150)
        await globalThis.__mizanFrettedShot(`${instrument}-${physical.dataset.handedness}-${physical.dataset.viewMode}`)
      }
    }
    handedness.value = 'right'
    handedness.dispatchEvent(new Event('change', { bubbles: true }))
    await until(() => physical.dataset.handedness === 'right', 'Right-handed alignment is selected')
    await capture()
    physical.querySelectorAll('.fretted-mode button')[1].click()
    await until(() => physical.dataset.viewMode === 'whole', 'Whole-instrument viewing is selected')
    await capture()
    handedness.value = 'left'
    handedness.dispatchEvent(new Event('change', { bubbles: true }))
    await until(() => physical.dataset.handedness === 'left', 'Left-handed alignment is selected')
    await capture()
    physical.querySelectorAll('.fretted-mode button')[0].click()
    await until(() => physical.dataset.viewMode === 'fretboard', 'The fretboard close-up is restored')
    await capture()
    check(loadPrefs().frettedHandedness === 'left', 'The selected alignment is saved')
    fretboardVisible(physical, instrument === 'guitar' ? 6 : 4)
    const tab = physical.querySelector('.fretted-tab')
    const firstString = tab.querySelector('.fretted-string-label')?.textContent
    check(firstString === (instrument === 'guitar' ? 'E4' : 'G2'), 'Changing handedness does not reverse the conventional tab order')
    check(tab.querySelector('.fretted-rhythm') && !tab.querySelector('.fretted-duration'), 'Tab uses rhythm marks rather than long tails')
    const stageRect = physical.querySelector('.fretted-stage').getBoundingClientRect()
    const tabRect = tab.getBoundingClientRect()
    check(stageRect.height >= 200 && stageRect.height <= 340 &&
      tabRect.top >= stageRect.bottom,
      `The instrument stays in a wide strip above the compact tab: ${JSON.stringify({ stage: stageRect.toJSON(), tab: tabRect.toJSON() })}`)
    const fret = tab.querySelector('.fretted-fret')
    check(Number.parseFloat(getComputedStyle(fret).fontSize) >= 14 &&
      fret.getBoundingClientRect().height >= 21, 'Fret numbers stay readable without shrinking the whole tab')
    check(document.body.textContent.includes(instrument === 'guitar' ? 'six open-string' : 'standard low-to-high'),
      `${instrument} lesson instructions match the instrument`)
    query('.ws-back').click()
    await until(() => query('.course-browse'), 'Back returns to Course')
    check(query('[data-tab="course"][aria-selected="true"]') &&
      query(`[data-instrument="${instrument}"][aria-checked="true"]`), 'Back preserves the course instrument')
  }

  const guitar = frettedLessonSong(frettedLessonById('guitar-open-strings'))
  const bass = frettedLessonSong(frettedLessonById('bass-open-strings'))
  for (const [instrument, piece] of [['guitar', guitar], ['bass', bass]]) {
    const xml = new DOMParser().parseFromString(instrumentXml(piece, piece.tracks[0]), 'application/xml')
    check(xml.querySelectorAll('clef').length === 1 && !xml.querySelector('staves') &&
      xml.querySelector('clef sign')?.textContent === (instrument === 'guitar' ? 'G' : 'F') &&
      xml.querySelector('clef-octave-change')?.textContent === '-1',
      `${instrument} uses its own single octave-transposing staff, not a piano grand staff`)
    check(xml.querySelector('pitch octave')?.textContent === (instrument === 'guitar' ? '3' : '2'),
      `${instrument} written pitch matches the clef transposition`)
    check([...xml.querySelectorAll('type')].every((type) =>
      ['whole', 'half', 'quarter', 'eighth'].includes(type.textContent)), 'The open-string exercise uses simple written note lengths')
  }
  const secondGuitar = { ...guitar.tracks[0], id: 'guitar-two', name: 'Second guitar' }
  const song = {
    ...guitar, title: 'String-instrument practice check', bpm: 84,
    tracks: [guitar.tracks[0], bass.tracks[0], secondGuitar],
    instrumentNotes: {
      ...guitar.instrumentNotes, ...bass.instrumentNotes,
      [secondGuitar.id]: guitar.instrumentNotes.guitar.map((note) => ({ ...note, trackId: secondGuitar.id, midi: note.midi + 2 })),
    },
  }
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;inset:0;z-index:100;overflow:auto'
  document.body.append(container)
  const root = ReactDOM.createRoot(container)
  const originalSelect = Engine.prototype.selectPart
  let engine
  const engines = new Set()
  Engine.prototype.selectPart = function (id) {
    engine = this
    engines.add(this)
    return originalSelect.call(this, id)
  }
  const find = (selector) => container.querySelector(selector)
  const view = () => find('[data-view][aria-checked="true"]')?.dataset.view
  const render = async (key) => {
    root.render(React.createElement(Workspace, {
      key, song, songId: `fretted-browser-${key}`,
      start: { bar: 1, rate: 1, loop: { startBar: 1, endBar: 4 }, muted: [], solo: [], trackId: 'guitar' },
    }))
    await until(() => engine?.song === song && find('[data-view="fretboard"]'), 'The test workspace opens')
  }
  const choose = async (value) => {
    find(`[data-view="${value}"]`).click()
    await until(() => view() === value, `${value} is selected`)
  }
  const select = async (id, name) => {
    if (!find('.track-menu')) find('.track-button').click()
    await until(() => find('.track-menu'), 'The part menu opens')
    const row = [...container.querySelectorAll('[role="menuitemradio"]')].find((item) =>
      item.querySelector('.track-name')?.textContent === name)
    check(row, `${name} is available`)
    row.click()
    await until(() => engine.selectedPart === id, `${name} is selected`)
  }
  try {
    await render('first')
    check(view() === 'fretboard', 'An unsaved guitar view starts with the fretboard and tab')
    await until(() => Number(find('.fretted-practice')?.dataset.triangles) > 0, 'The guitar 3D model finishes rendering')
    fretboardVisible(find('.fretted-practice'), 6)
    check(find('.fretted-practice').dataset.handedness === 'left' &&
      find('.fretted-toolbar select').value === 'left',
      'A saved player alignment follows the guitar into another song')
    await choose('tab')
    check(loadPrefs().guitarView === 'tab' && loadPrefs().bassView === undefined, 'Only the guitar view is saved')
    await select('bass', 'Electric bass')
    check(view() === 'fretboard', 'Bass keeps its own unsaved default')
    await choose('score')
    await until(() => find('.score[aria-busy="false"]'), 'Bass score finishes drawing')
    check(find('.score svg') && loadPrefs().bassView === 'score', 'Bass offers a rendered score and saves its separate choice')
    await select('guitar-two', 'Second guitar')
    check(view() === 'tab' && engine.selectedPart === 'guitar-two', 'Another guitar part uses the saved guitar view')
    await choose('fretboard')
    engine.countIn = false
    engine.muted = new Set(['bass'])
    engine.trackGains.set('guitar', 0.4)
    engine.refreshMix()
    engine.seek(1)
    await engine.play()
    await until(() => !engine.starting && engine.read().beat > 1, 'Guitar notes play')
    const before = {
      engine, anchors: engine.anchors, timer: engine.timer, revision: engine.revision,
      beat: engine.read().beat, time: engine.ctx.currentTime, rate: engine.rate,
      loop: JSON.stringify(engine.loop), count: engines.size,
    }
    await choose('tab')
    await select('bass', 'Electric bass')
    await choose('fretboard')
    await select('guitar', 'Electric guitar')
    const expected = before.beat + (engine.ctx.currentTime - before.time) * song.bpm * before.rate / 60
    check(engine === before.engine && engine.anchors === before.anchors && engine.timer === before.timer &&
      engine.revision === before.revision && engines.size === before.count && engine.playing &&
      Math.abs(engine.read().beat - expected) < 0.1, 'View and part changes keep the same advancing playback clock')
    check(engine.muted.has('bass') && engine.trackGains.get('guitar') === 0.4 &&
      JSON.stringify(engine.loop) === before.loop && engine.rate === before.rate,
      'View changes preserve the mixer, speed and loop')
    engine.pause()
    const preferred = localStorage.getItem('mizan:practice')
    await render('restart')
    check(view() === 'tab' && localStorage.getItem('mizan:practice') === preferred,
      'Reopening restores the last guitar view without writing preferences')
    return 'Guitar and bass course, separate saved views, selected parts and continuous playback checks passed.'
  } finally {
    root.unmount()
    container.remove()
    Engine.prototype.selectPart = originalSelect
  }
}
