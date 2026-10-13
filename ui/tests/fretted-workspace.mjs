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
  const { loadPrefs, LOOKS, LOOK_LABEL } = await import('/src/workspace/prefs.ts')
  const { instrumentXml } = await import('/src/workspace/musicxml.ts')
  const check = (value, message) => { if (!value) throw new Error(message) }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const luminance = (color) => {
    const channels = color.match(/[\d.]+/g).slice(0, 3).map((value) => Number(value) / 255)
    return channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
  }
  const contrast = (foreground, background) => {
    const a = luminance(foreground)
    const b = luminance(background)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }
  const until = async (predicate, message) => {
    for (let i = 0; i < 400; i++) {
      if (predicate()) return
      await sleep(50)
    }
    throw new Error(message)
  }
  const checkUpcomingAnimation = (phase) => {
    const marker = find('.fretted-position[data-state="upcoming"]')
    check(marker && marker.getBoundingClientRect().width > 0, `${phase} keeps its upcoming cue visible`)
    const reducedMotion = innerWidth === 617
    check(matchMedia('(prefers-reduced-motion: reduce)').matches === reducedMotion,
      `${phase} runs with the expected emulated motion preference`)
    const expected = reducedMotion ? 'none' : 'fretted-upcoming'
    check(getComputedStyle(marker).animationName === expected,
      `${phase} uses ${expected} for the current motion preference`)
  }
  localStorage.removeItem('mizan:practice')
  const query = (selector) => document.querySelector(selector)
  const fretboardVisible = (section, strings) => {
    const stage = section.querySelector('.fretted-stage').getBoundingClientRect()
    const labels = [...section.querySelectorAll('.fretted-overlay-string-label')]
    check(labels.length === strings, `All ${strings} string labels appear in the playing view`)
    const current = section.querySelector('.fretted-position[data-state="playback"]')
    check(current, 'The playhead note has a visible string marker')
    for (const item of [...labels, current]) {
      const rect = item.getBoundingClientRect()
      check(rect.width > 0 && rect.height > 0 && rect.left >= stage.left && rect.right <= stage.right &&
        rect.top >= stage.top && rect.bottom <= stage.bottom, 'String labels and the current note remain inside the playing view')
    }
    const open = section.querySelector('.fretted-position[data-fret="0"]')
    check(open?.textContent === 'O' && open.getAttribute('aria-label').includes('open string, no fret press'),
      'An open string uses an O at the real nut and says not to press a fret')
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
    const toolbar = physical.querySelector('.fretted-toolbar')
    const styleSelect = toolbar.querySelector('[aria-label="Look"]')
    check(JSON.stringify([...styleSelect.options].map((option) => [option.value, option.textContent])) ===
      JSON.stringify(LOOKS.map((look) => [look, LOOK_LABEL[look]])),
    `${instrument} has the same direct four-look menu as piano and drums`)
    check(!physical.querySelector('details, .fretted-mode, [aria-label="Instrument view"]') &&
      ![...toolbar.querySelectorAll('button')].some((button) => button.textContent.includes('Whole instrument')),
    `${instrument} has one close playing view without an appearance drawer or whole-instrument control`)
    const triangleCount = Number(physical.dataset.triangles)
    const frameHookName = instrument === 'guitar' ? '__mizanGuitarFrame' : '__mizanBassFrame'
    const previousFrameHook = globalThis[frameHookName]
    const renderedStyles = new Map([[physical.dataset.style, triangleCount]])
    globalThis[frameHookName] = (_canvas, frame) => renderedStyles.set(physical.dataset.style, frame.triangles)
    for (const style of LOOKS.slice(1)) {
      styleSelect.value = style
      styleSelect.dispatchEvent(new Event('change', { bubbles: true }))
      await until(() => physical.dataset.style === style && renderedStyles.has(style),
        `${instrument} ${LOOK_LABEL[style]} appearance renders`)
      check(!query('.fretted-failure') && renderedStyles.get(style) === triangleCount,
        `${instrument} ${LOOK_LABEL[style]} keeps rendering the same model geometry`)
      if (style === 'NeonRhythm') {
        const view = physical.querySelector('.fretted-view')
        const surface = getComputedStyle(view).backgroundColor
        const stage = getComputedStyle(physical.querySelector('.fretted-stage')).backgroundColor
        const select = toolbar.querySelector('select')
        check(luminance(surface) > 0.85 && luminance(stage) < 0.1 &&
          contrast(getComputedStyle(toolbar.querySelector('label')).color, surface) >= 4.5 &&
          contrast(getComputedStyle(select).color, getComputedStyle(select).backgroundColor) >= 4.5 &&
          contrast(getComputedStyle(physical.querySelector('.fretted-instrument-note')).color, surface) >= 4.5,
        `${instrument} neon keeps the controls and instruction readable on Canvas beside the dark model stage`)
      }
    }
    globalThis[frameHookName] = previousFrameHook
    check(renderedStyles.size === LOOKS.length, `${instrument} renders all four shared appearances`)
    fretboardVisible(physical, instrument === 'guitar' ? 6 : 4)
    const handedness = physical.querySelector('[aria-label="Handedness"]')
    check(handedness?.querySelector('option[value="left"]'), 'Left-handed alignment is available')
    const capture = async () => {
      if (globalThis.__mizanFrettedShot) {
        await sleep(150)
        await globalThis.__mizanFrettedShot(`${instrument}-${physical.dataset.handedness}-playing-view`)
      }
    }
    handedness.value = 'right'
    handedness.dispatchEvent(new Event('change', { bubbles: true }))
    await until(() => physical.dataset.handedness === 'right', 'Right-handed alignment is selected')
    await capture()
    handedness.value = 'left'
    handedness.dispatchEvent(new Event('change', { bubbles: true }))
    await until(() => physical.dataset.handedness === 'left', 'Left-handed alignment is selected')
    await capture()
    check(loadPrefs().frettedHandedness === 'left', 'The selected alignment is saved')
    fretboardVisible(physical, instrument === 'guitar' ? 6 : 4)
    const tab = physical.querySelector('.fretted-tab')
    const firstString = tab.querySelector('.fretted-string-label')?.textContent
    check(firstString === (instrument === 'guitar' ? 'E4' : 'G2'), 'Changing handedness does not reverse the conventional tab order')
    check(tab.querySelector('.fretted-rhythm') && !tab.querySelector('.fretted-duration'), 'Tab uses rhythm marks rather than long tails')
    const stageRect = physical.querySelector('.fretted-stage').getBoundingClientRect()
    const toolbarRect = physical.querySelector('.fretted-toolbar').getBoundingClientRect()
    const tabRect = tab.getBoundingClientRect()
    check(stageRect.height >= 200 && stageRect.height <= 340 &&
      toolbarRect.bottom <= stageRect.top && tabRect.top >= stageRect.bottom,
      `Controls do not cover the playing view or compact tab: ${JSON.stringify({ toolbar: toolbarRect.toJSON(), stage: stageRect.toJSON(), tab: tabRect.toJSON() })}`)
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

  const selectScale = (label, value) => {
    const select = [...document.querySelectorAll('.course label')]
      .find((element) => element.textContent.trim().startsWith(label))?.querySelector('select')
    check(select, `${label} scale selector is available`)
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }
  for (const [instrument, artist, title] of [
    ['guitar', 'Nile Rodgers', 'Clipped offbeat chord cuts'],
    ['bass', 'James Jamerson', 'Syncopated roots with chromatic approaches'],
  ]) {
    query(`[data-instrument="${instrument}"]`).click()
    await until(() => query(`[data-instrument="${instrument}"][aria-checked="true"]`),
      `${instrument} is selected for its new lesson shelves`)
    query('[data-fretted-shelf="inspired"]').click()
    await until(() => query(`[data-genre="${artist}"]`), `${instrument} inspired artists appear`)
    query(`[data-genre="${artist}"]`).click()
    await until(() => query('.course-lesson')?.textContent.includes(title), 'The selected original study appears')
    query('.course-lesson').click()
    await until(() => query('.ws') && document.body.textContent.includes(title),
      `${instrument} inspired study opens a real practice workspace`)
    query('.ws-back').click()
    await until(() => query('[data-fretted-shelf="inspired"][aria-checked="true"]') &&
      query(`[data-genre="${artist}"][aria-checked="true"]`), 'Back restores the inspired artist')
    query('[data-fretted-shelf="scale"]').click()
    await until(() => document.querySelectorAll('.course select').length === 2, 'Scales have tonic and family selectors')
    selectScale('Tonic', '6')
    selectScale('Scale', 'melodic-minor')
    await until(() => query('.course-lesson')?.textContent.includes('F# Melodic minor'),
      `${instrument} changes to the selected tonic and scale family`)
    check(document.querySelectorAll('.course-lesson').length === 3, 'The selected scale has three real patterns')
    query('.course-lesson').click()
    await until(() => query('.ws') && document.body.textContent.includes('One-octave run'), 'The scale run opens')
    query('.lesson-nav button:last-child').click()
    await until(() => query('.ws') && document.body.textContent.includes('Broken thirds'),
      'Next opens the second pattern in the same scale')
    query('.lesson-nav button:first-child').click()
    await until(() => query('.ws') && document.body.textContent.includes('One-octave run'),
      'Previous returns to the scale run')
    query('.ws-back').click()
    await until(() => query('[data-fretted-shelf="scale"][aria-checked="true"]'), 'Back restores Scales')
    const selected = [...document.querySelectorAll('.course select')].map((select) => select.value)
    check(selected.includes('6') && selected.includes('melodic-minor'), 'Back restores the selected tonic and family')
  }
  query('[data-instrument="guitar"]').click()
  await until(() => query('[data-instrument="guitar"][aria-checked="true"]'), 'Returning to guitar keeps its scale choices')
  check(query('[data-fretted-shelf="scale"][aria-checked="true"]') &&
    [...document.querySelectorAll('.course select')].some((select) => select.value === '6'),
  'Guitar and bass keep independent scale selections')

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
  const cueGuitar = [
    { midi: 40, startBeat: 0, beats: 0.75 },
    { midi: 45, startBeat: 0.5, beats: 0.25 },
    { midi: 50, startBeat: 1, beats: 0.5 },
    { midi: 50, startBeat: 3.9, beats: 0.25 },
    { midi: 50, startBeat: 15.5, beats: 0.25 },
  ]
  const cueBass = [
    { midi: 28, startBeat: 0, beats: 0.75 },
    { midi: 33, startBeat: 0.5, beats: 0.25 },
    { midi: 38, startBeat: 1, beats: 0.5 },
    { midi: 38, startBeat: 15.5, beats: 0.25 },
  ]
  const song = {
    ...guitar, title: 'String-instrument practice check', bpm: 84,
    tracks: [guitar.tracks[0], bass.tracks[0], secondGuitar],
    instrumentNotes: {
      ...guitar.instrumentNotes, ...bass.instrumentNotes,
      [guitar.tracks[0].id]: cueGuitar,
      [bass.tracks[0].id]: cueBass,
      [secondGuitar.id]: cueGuitar,
    },
  }
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;inset:0;z-index:100;overflow:auto'
  document.body.append(container)
  const root = ReactDOM.createRoot(container)
  const originalSelect = Engine.prototype.selectPart
  let engine
  const engines = new Set()
  let previousBassFrameHook
  let previousGuitarFrameHook
  let bassHookInstalled = false
  let guitarHookInstalled = false
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
      find('.fretted-toolbar [aria-label="Handedness"]').value === 'left',
      'A saved player alignment follows the guitar into another song')
    await choose('tab')
    check(loadPrefs().guitarView === 'tab' && loadPrefs().bassView === undefined, 'Only the guitar view is saved')
    previousBassFrameHook = globalThis.__mizanBassFrame
    bassHookInstalled = true
    let bassFrame
    globalThis.__mizanBassFrame = (_canvas, frame) => { bassFrame = frame }
    await select('bass', 'Electric bass')
    check(view() === 'fretboard', 'Bass keeps its own unsaved default')
    await until(() => Number(find('.fretted-practice')?.dataset.triangles) > 0 &&
      bassFrame?.markers.some((marker) => marker.position.fret === 0), 'The bass model draws its open-string cue')
    check(bassFrame.plucks.length === 0 && bassFrame.vibrations.length === 0 &&
      bassFrame.stringCues.some((cue) => cue.state === 'upcoming'),
    'The paused bass shows upcoming strings without a false pluck or vibration')
    engine.loop = { startBar: 2, endBar: 4 }
    engine.countIn = true
    engine.seek(0)
    await engine.play()
    await until(() => engine.read().countingIn &&
      bassFrame?.stringCues.some((cue) => cue.state === 'upcoming') &&
      find('.fretted-practice')?.dataset.countingIn === 'true',
    'The bass previews notes before the loop during count-in')
    checkUpcomingAnimation('Bass count-in')
    engine.pause()
    engine.countIn = false
    engine.seek(0)
    await engine.play()
    await until(() => !engine.starting && engine.read().beat > 0.02 && bassFrame?.plucks.length > 0 &&
      bassFrame.stringCues.some((cue) => cue.state === 'upcoming') &&
      find('.fretted-practice')?.dataset.playing === 'true',
    'The bass plays notes before the loop with upcoming cues and pickup flashes')
    checkUpcomingAnimation('Bass playback')
    check(bassFrame.plucks.some((pluck) => pluck.string === 1) &&
      bassFrame.stringCues.some((cue) => cue.state === 'upcoming'),
    'Bass pluck flash and next-string cue follow the same transport')
    engine.pause()
    await until(() => bassFrame && !bassFrame.plucks.length && !bassFrame.vibrations.length,
      'Pausing bass clears movement but keeps its playhead')
    globalThis.__mizanBassFrame = previousBassFrameHook
    previousBassFrameHook = undefined
    await choose('score')
    await until(() => find('.score[aria-busy="false"]'), 'Bass score finishes drawing')
    check(find('.score svg') && loadPrefs().bassView === 'score', 'Bass offers a rendered score and saves its separate choice')
    await select('guitar-two', 'Second guitar')
    check(view() === 'tab' && engine.selectedPart === 'guitar-two', 'Another guitar part uses the saved guitar view')
    previousGuitarFrameHook = globalThis.__mizanGuitarFrame
    guitarHookInstalled = true
    let guitarFrame
    let guitarFrameCount = 0
    globalThis.__mizanGuitarFrame = (_canvas, frame) => { guitarFrame = frame; guitarFrameCount++ }
    await choose('fretboard')
    engine.countIn = false
    engine.muted = new Set(['bass'])
    engine.trackGains.set('guitar', 0.4)
    engine.refreshMix()
    engine.seek(0)
    await until(() => guitarFrame?.markers.some((marker) => marker.position.fret === 0),
      'The paused playhead positions render without playing sounds')
    check(guitarFrame.plucks.length === 0 && guitarFrame.vibrations.length === 0 &&
      guitarFrame.stringCues.some((cue) => cue.state === 'playback'),
    'A paused playhead stays lit but does not invent a pluck or vibration')
    check(guitarFrame.stringCues.some((cue) => cue.state === 'upcoming') &&
      guitarFrame.markers.some((marker) => marker.state === 'upcoming'),
    'The next string and fret are visibly cued while playback is paused')
    const physical = find('.fretted-practice')
    const embeddedTab = physical.querySelector('.fretted-tab')
    const caption = physical.querySelector('.fretted-instrument-note')
    const embeddedPlayhead = embeddedTab.querySelector('.fretted-playhead')
    const tabNote = (index) => embeddedTab.querySelector(`.fretted-tab-note[data-note-index="${index}"]`)
    await until(() => tabNote(0)?.dataset.state === 'current', 'The embedded tab follows the paused playhead')
    const firstTabX = Number(embeddedPlayhead.getAttribute('x1'))
    check(embeddedTab.dataset.playing === 'false' && caption.textContent.includes('Paused:'),
      'The embedded tab and caption show the paused transport')
    engine.seek(1.1)
    await until(() => tabNote(2)?.dataset.state === 'current' &&
      Number(embeddedPlayhead.getAttribute('x1')) > firstTabX,
    'Seeking moves the embedded tab playhead and active note')
    const soughtTabX = Number(embeddedPlayhead.getAttribute('x1'))
    engine.seek(0)
    await until(() => tabNote(0)?.dataset.state === 'current' &&
      Number(embeddedPlayhead.getAttribute('x1')) < soughtTabX,
    'Seeking back restores the embedded tab playhead and active note')
    const upcomingFret = find('.fretted-position[data-state="upcoming"]')
    check(upcomingFret && getComputedStyle(upcomingFret).animationName === 'none',
      'Upcoming frets stay visibly highlighted but static while paused')
    await engine.play()
    await until(() => !engine.starting && engine.read().beat > 0.02 &&
      embeddedTab.dataset.playing === 'true' && caption.textContent.includes('Current and upcoming') &&
      tabNote(0)?.dataset.state === 'current' &&
      Number(embeddedPlayhead.getAttribute('x1')) > firstTabX,
    'The embedded tab and caption follow active playback')
    check(tabNote(0)?.dataset.state === 'current' &&
      Number(embeddedPlayhead.getAttribute('x1')) > firstTabX,
    'The embedded tab marks the playing note and advances its playhead')
    await until(() => guitarFrame?.plucks.length > 0, 'Guitar notes pluck near the pickups')
    checkUpcomingAnimation('Guitar playback before the loop')
    check(guitarFrame.plucks.some((pluck) => pluck.string === guitarFrame.stringCues.find((cue) =>
      cue.state === 'playback')?.string) && guitarFrame.stringCues.some((cue) => cue.state === 'upcoming') &&
      guitarFrame.markers.some((marker) => marker.state === 'upcoming'),
    'The struck string flashes by its pickup while the upcoming string remains cued')
    const canvas = find('.fretted-canvas')
    check(guitarFrame.plucks.every((pluck) => pluck.x > 0 && pluck.x < canvas.width &&
      pluck.y > 0 && pluck.y < canvas.height),
    'Pluck feedback is projected onto the visible instrument')
    engine.pause()
    await until(() => guitarFrame && !guitarFrame.plucks.length && !guitarFrame.vibrations.length,
      'Pausing clears the pluck and string motion')
    check(guitarFrame.stringCues.some((cue) => cue.state === 'playback'),
      'Pausing keeps the playhead string highlighted')
    engine.loop = { startBar: 1, endBar: 4 }
    engine.seek(15.75)
    await until(() => guitarFrame?.stringCues.some((cue) => cue.state === 'upcoming' && cue.string === 1),
      'Loop end anticipates the first string of the loop')
    check(!guitarFrame.plucks.length && !guitarFrame.vibrations.length,
      'A paused loop seek does not create a strike effect')
    engine.loop = { startBar: 4, endBar: 4 }
    await until(() => !guitarFrame?.stringCues.some((cue) => cue.state === 'upcoming' && cue.string === 1),
      'Paused loop-bound changes immediately update the upcoming cue')
    engine.loop = { startBar: 1, endBar: 4 }
    await until(() => guitarFrame?.stringCues.some((cue) => cue.state === 'upcoming' && cue.string === 1),
      'Restoring the original loop restores its wrapped cue')
    engine.loop = null
    await until(() => !guitarFrame?.stringCues.some((cue) => cue.state === 'upcoming' && cue.string === 1),
      'Disabling the loop immediately clears its wrapped cue without a seek')
    await sleep(100)
    const staticFrameCount = guitarFrameCount
    await sleep(120)
    check(guitarFrameCount === staticFrameCount, 'Unchanged paused frames remain cached')
    engine.loop = { startBar: 2, endBar: 4 }
    engine.countIn = false
    engine.seek(15.999)
    await engine.play()
    await until(() => {
      const beat = engine.read().beat
      return !engine.starting && beat >= 4.05 && beat < 4.5
    }, 'Playback wraps to the loop start')
    check(!guitarFrame.plucks.some((pluck) => pluck.index === 3),
      'A pre-loop note is not flashed again after playback wraps')
    engine.pause()
    engine.countIn = true
    engine.seek(0)
    await engine.play()
    await until(() => engine.read().countingIn && guitarFrame?.stringCues.some((cue) => cue.state === 'upcoming'),
      'Count-in anticipates the first string')
    await until(() => physical.dataset.countingIn === 'true' &&
      caption.textContent.includes('count-in') && tabNote(0)?.dataset.state === 'current',
    'The embedded tab previews the first note and the caption shows count-in')
    checkUpcomingAnimation('Guitar count-in')
    check(embeddedTab.dataset.playing === 'false',
    'Count-in previews upcoming frets without marking the tab as playing')
    check(!guitarFrame.plucks.length && !guitarFrame.vibrations.length,
      'Count-in does not show a note as already plucked')
    engine.pause()
    engine.countIn = false
    await until(() => physical.dataset.countingIn !== 'true' && caption.textContent.includes('Paused:'),
      'The caption returns to paused state after count-in')
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
    globalThis.__mizanGuitarFrame = previousGuitarFrameHook
    previousGuitarFrameHook = undefined
    const preferred = localStorage.getItem('mizan:practice')
    await render('restart')
    check(view() === 'tab' && localStorage.getItem('mizan:practice') === preferred,
      'Reopening restores the last guitar view without writing preferences')
    return 'Guitar and bass course, direct shared looks, open strings, playback cues, loop seek and continuous clock checks passed.'
  } finally {
    root.unmount()
    container.remove()
    Engine.prototype.selectPart = originalSelect
    if (bassHookInstalled) globalThis.__mizanBassFrame = previousBassFrameHook
    if (guitarHookInstalled) globalThis.__mizanGuitarFrame = previousGuitarFrameHook
  }
}
