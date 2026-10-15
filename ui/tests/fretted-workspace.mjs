// Run by playback.mjs --fretted in an isolated, muted browser.
export async function tabChecks() {
  const { default: React } = await import('react')
  const { default: ReactDOM } = await import('react-dom/client')
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
    const beam = find('.fretted-beam')
    const firstMark = find('.fretted-tab-measure .fretted-rhythm[data-kind="note"]')
    const stem = firstMark.querySelector('.fretted-note-stem')
    check(firstMark.querySelector('.fretted-notehead') && stem &&
      Number(beam.getAttribute('x1')) === Number(firstMark.transform.baseVal.getItem(0).matrix.e) + Number(stem.getAttribute('x1')) &&
      Number(beam.getAttribute('y1')) === Number(firstMark.transform.baseVal.getItem(0).matrix.f),
    'Recognizable noteheads have upward stems and beams attached to the stem tops')
    const fixtureId = 'rhythm-fixture'
    const fixtureTrack = { id: fixtureId, instrument: 'other', name: 'Electric guitar' }
    const lengths = [
      [0, 1], [1, 0.5], [2, 0.25], [3, 0.125],
      [4, 2], [7, 0.5], [8, 1.5], [10, 1 / 3],
      [12, 0.25], [12.25, 0.25], [12.75, 0.25],
    ]
    const rhythmSong = { ...eighths, bars: 4, barMap: undefined, chords: [], tracks: [fixtureTrack],
      instrumentNotes: { [fixtureId]: lengths.map(([startBeat, beats]) => ({
        midi: 43, string: 1, fret: 3, startBeat, beats,
      })) } }
    root.render(React.createElement(GuitarTabView, {
      song: rhythmSong, track: fixtureTrack, beat: 0, playing: false, onPick: () => {},
    }))
    await until(() => find('.fretted-rhythm[data-kind="note"][data-beats="0.125"]'), 'Rhythm examples draw')
    for (const [beats, flags] of [[1, 0], [0.5, 1], [0.25, 2], [0.125, 3]]) {
      const mark = find(`.fretted-rhythm[data-kind="note"][data-beats="${beats}"]`)
      check(mark?.querySelector('.fretted-notehead') &&
        mark.querySelectorAll('.fretted-note-flag').length === flags,
      `${beats}-beat notes have a visible head and the correct number of flags`)
    }
    check(find('.fretted-rhythm[data-kind="note"][data-beats="2"] .fretted-notehead.is-open') &&
      find('.fretted-rhythm[data-kind="note"][data-beats="1.5"] .fretted-rhythm-dot'),
    'Half notes have hollow heads and dotted notes retain their duration dot')
    const triplet = [...container.querySelectorAll('.fretted-rhythm[data-kind="note"]')]
      .find((mark) => Math.abs(Number(mark.dataset.beats) - 1 / 3) < 1e-6)
    check(triplet?.textContent.includes('3') && triplet.getAttribute('aria-label').includes('three in the time of two'),
      'Triplets retain their number and a plain-language description')
    check(find('.fretted-rhythm[data-kind="rest"] .fretted-rest') &&
      !find('.fretted-rhythm[data-kind="rest"] .fretted-notehead') &&
      find('.fretted-tab-footnote').textContent.includes('rests mean pause'),
    'Rests are distinct from noteheads and their purpose is explained')
    const separatedBar = find('.fretted-tab-measure[data-bar="4"]')
    check(separatedBar.querySelectorAll('.fretted-beam').length === 2 &&
      separatedBar.querySelectorAll('.fretted-note-flag').length === 2,
    'Sixteenth-note beams join consecutive notes but do not cross a rest')
    const guide = find('.fretted-rhythm-guide')
    check(guide && !guide.open, 'The illustrated rhythm guide starts closed to keep the tab compact')
    guide.querySelector('summary').click()
    check(guide.open && guide.textContent.includes('Pause for 1 beat') &&
      guide.querySelectorAll('svg').length === 5, 'The rhythm guide opens with labelled note and rest examples')
    if (globalThis.__mizanFrettedShot)
      await globalThis.__mizanFrettedShot('rhythm-symbols')
    return 'Compact four-bar tab, readable frets, rhythm below the strings, beams and current-bar follow checks passed.'
  } finally {
    root.unmount()
    container.remove()
  }
}

export async function frettedChecks() {
  const { default: React } = await import('react')
  const { default: ReactDOM } = await import('react-dom/client')
  const { Workspace } = await import('/src/workspace/Workspace.tsx')
  const { GuitarView } = await import('/src/workspace/GuitarView.tsx')
  const { BassView } = await import('/src/workspace/BassView.tsx')
  const { Engine } = await import('/src/workspace/engine.ts')
  const { frettedLessonById, frettedLessonSong } = await import('/src/course/fretted.ts')
  const { loadPrefs, LOOK_LABEL } = await import('/src/workspace/prefs.ts')
  const { FRETTED_LOOKS } = await import('/src/workspace/frettedStyles.ts')
  const { instrumentXml } = await import('/src/workspace/musicxml.ts')
  const check = (value, message) => { if (!value) throw new Error(message) }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, message) => {
    for (let i = 0; i < 400; i++) {
      if (predicate()) return
      await sleep(50)
    }
    throw new Error(typeof message === 'function' ? message() : message)
  }
  const setPhysicalView = async (section, mode) => {
    const button = section.querySelector(`[data-fretted-view="${mode}"]`)
    check(button, `${mode} is an available teaching view`)
    button.click()
    await until(() => section.dataset.view === mode, `${mode} teaching view is selected`)
  }
  const flatStringsVisible = (section, strings) => {
    const guide = section.querySelector('.fretted-finger-guide')
    check(guide && !section.querySelector('.fretted-canvas'),
      'The default finger guide is a flat diagram and needs no WebGL canvas')
    const labels = [...guide.querySelectorAll('.fretted-finger-string-label')]
    check(JSON.stringify(labels.map((label) => Number(label.dataset.string))) ===
      JSON.stringify(Array.from({ length: strings }, (_, index) => strings - index)),
    'The flat guide keeps the tab string order, highest string at the top')
    const rects = labels.map((label) => label.getBoundingClientRect())
    const guideRect = guide.getBoundingClientRect()
    check(rects.every((rect) => rect.height > 0) &&
      rects.slice(1).every((rect, index) => rect.top >= rects[index].bottom),
    'Flat string names are readable and do not overlap')
    check(labels.every((label) => Number.parseFloat(getComputedStyle(label).fontSize) >= 11) &&
      rects.every((rect) => rect.left >= guideRect.left && rect.right <= guideRect.right),
    'String names keep a readable size and stay inside the flat guide')
    const fretLabels = [...guide.querySelectorAll('.fretted-finger-fret-label')]
    const expectedFrets = section.dataset.instrument === 'bass' ? 20 : 22
    check(guide.dataset.startFret === '0' && Number(guide.dataset.endFret) === expectedFrets &&
      fretLabels.length === expectedFrets &&
      Number(fretLabels.at(-1).dataset.fret) === expectedFrets,
    `The flat guide shows every configured fret from the nut to fret ${expectedFrets}`)
    const nut = guide.querySelector('.fretted-guide-nut')
    const wires = [...guide.querySelectorAll('.fretted-guide-fretwire')]
    const nutX = Number(nut?.getAttribute('x1'))
    const boardEndX = Number(wires.at(-1)?.getAttribute('x1'))
    const lastDistance = Number(wires.at(-1)?.dataset.distanceFromNut)
    check(wires.length === expectedFrets && Number.isFinite(nutX) &&
      wires.every((wire) => {
        const physicalRatio = Number(wire.getAttribute('x1')) / 1
        const expectedRatio = Number(wire.dataset.distanceFromNut) / lastDistance
        const nutRelative = (physicalRatio - nutX) / (boardEndX - nutX)
        return Math.abs(nutRelative - expectedRatio) < 0.001
      }) &&
      Math.abs(Number(wires[0].getAttribute('x1')) - nutX) >
        Math.abs(Number(wires.at(-1).getAttribute('x1')) - Number(wires.at(-2).getAttribute('x1'))),
    'Flat fret wires keep their physical scale-length positions, with narrowing spaces toward the bridge')
  }
  // The next note is only shown as text (the NEXT or COUNT-IN line below the 3D view).
  const nextRow = () => [...document.querySelectorAll('.fretted-hand-guidance-cue')].map((item) => item.textContent)
    .find((text) => /^(NEXT|COUNT-IN) ·/.test(text))
  const checkUpcomingAnimation = (phase) => {
    const marker = find('.fretted-position[data-state="upcoming"]')
    const reducedMotion = innerWidth === 617
    check(matchMedia('(prefers-reduced-motion: reduce)').matches === reducedMotion,
      `${phase} runs with the expected emulated motion preference`)
    check(find('.fretted-feedback-key')?.textContent.includes('Finger badges are fingers') &&
      find('.fretted-feedback-key')?.textContent.includes('labels marked “Fret N” are frets.') &&
      !find('.fretted-feedback-key')?.textContent.includes('Gold dashed'),
    `${phase} explains finger badges and fret labels, with no next-note marker in the key`)
    if (marker) {
      const visibleCircle = getComputedStyle(marker, '::before')
      check(getComputedStyle(marker).animationName === 'none' &&
        marker.getBoundingClientRect().width >= 32 &&
        Number.parseFloat(visibleCircle.width) <= 13 && visibleCircle.borderStyle === 'dashed',
      `${phase} keeps the gold cue visibly small with an accessible click target`)
    } else check(!find('.fretted-position[data-fret="0"]'),
      `${phase} does not replace an open string with an O badge`)
  }
  localStorage.setItem('mizan:practice', JSON.stringify({ kitStyle: 'electronic:NeonRhythm', click: false }))
  const query = (selector) => document.querySelector(selector)
  const fretboardVisible = (section, strings) => {
    const stage = section.querySelector('.fretted-stage').getBoundingClientRect()
    const canvasRect = section.querySelector('.fretted-canvas').getBoundingClientRect()
    check(stage.width > 0 && stage.height >= 240 && canvasRect.width > 0 && canvasRect.height > 0,
      `The ${strings}-string playing view has a usable size: ${JSON.stringify(stage.toJSON())}`)
    check(!section.querySelector('.fretted-3d-pane[data-pane="hand"]') &&
      !section.querySelector('[data-fretted-view="hand"]'),
    'There is no hand close-up view or pane')
    check(!section.querySelector('.fretted-position[data-fret="0"]') &&
      !/O\s*=\s*open/i.test(section.querySelector('.fretted-instrument-note')?.textContent ?? ''),
    'Open strings have no O circle or O=Open legend')
    check(section.querySelector('.fretted-tab-note[data-fret="0"] .fretted-fret')?.textContent === '0' &&
      /open strings need no (fretting )?finger/i.test(section.querySelector('.fretted-instrument-note')?.textContent ?? ''),
    'Open strings keep fret zero in tab and are explained without a fretboard badge')
  }
  const overviewVisible = async (section) => {
    await setPhysicalView(section, 'mirror')
    const pane = () => section.querySelector('.fretted-3d-pane[data-pane="overview"]')
    await until(() => pane()?.querySelector('.fretted-mirror-toggles') && pane().querySelector('.fretted-mirror-target'),
      'The 3D mirror shows its small guidance targets and toggles')
    check(section.querySelectorAll('.fretted-3d-pane').length === 1 && !section.querySelector('.fretted-3d-pane[data-pane="hand"]'),
      'The 3D mirror is the only 3D pane')
    const paneRect = pane().getBoundingClientRect()
    check(!pane().querySelector('.fretted-overlay-fret-label') && !pane().querySelector('.fretted-mirror-string-label'),
      'The mirror has no permanent fret-label rows and string names are off by default')
    const stringCount = section.dataset.instrument === 'bass' ? 4 : 6
    const names = pane().querySelector('[data-mirror-toggle="names"]')
    names.click()
    await until(() => pane().querySelectorAll('.fretted-mirror-string-label').length === stringCount,
      'The String names toggle shows every string name')
    const nameRects = [...pane().querySelectorAll('.fretted-mirror-string-label')].map((item) => item.getBoundingClientRect())
      .sort((a, b) => a.top - b.top)
    check(nameRects.every((rect) => rect.left >= paneRect.left && rect.right <= paneRect.right &&
      rect.top >= paneRect.top && rect.bottom <= paneRect.bottom) &&
      nameRects.slice(1).every((rect, index) => rect.top >= nameRects[index].bottom),
    'String names stay inside the mirror pane and do not overlap')
    names.click()
    await until(() => !pane().querySelector('.fretted-mirror-string-label'), 'String names can be hidden again')
    const guides = pane().querySelector('[data-mirror-toggle="guides"]')
    guides.click()
    await until(() => !pane().querySelector('.fretted-mirror-target') && !pane().querySelector('.fretted-mirror-callout'),
      'The Guides toggle hides every target and label')
    guides.click()
    await until(() => pane().querySelector('.fretted-mirror-target'), 'The Guides toggle brings the guidance back')
    const targets = [...pane().querySelectorAll('.fretted-mirror-target')]
    check(targets.every((target) => target.getBoundingClientRect().width <= 20),
      'Mirror targets stay small so chords do not cover the neck')
  }
  query('[data-tab="course"]').click()
  await until(() => query('[data-instrument="guitar"]'), 'Guitar is available in Course')
  for (const instrument of ['guitar', 'bass']) {
    localStorage.setItem('mizan:practice', JSON.stringify({ kitStyle: 'electronic:NeonRhythm', click: false }))
    query(`[data-instrument="${instrument}"]`).click()
    await sleep(100)
    query('[data-fretted-shelf="course"]').click()
    await sleep(100)
    const lesson = [...document.querySelectorAll('.course-lesson')].find((button) =>
      button.textContent.includes(instrument === 'guitar' ? 'Name the open strings' : 'Name the four open strings'))
    check(lesson, `${instrument} open-string lesson is listed`)
    lesson.click()
    await until(() => query('.ws'), `${instrument} course opens a workspace`)
    check(query('[data-view="fretboard"][aria-checked="true"]'), `${instrument} lesson opens its fretboard and tab`)
    await until(() => query('.fretted-finger-guide'), `${instrument} opens the flat finger guide by default`)
    const physical = query('.fretted-practice')
    check(physical.dataset.view === 'guide', 'The clear finger guide is the default teaching view')
    flatStringsVisible(physical, instrument === 'guitar' ? 6 : 4)
    check(!physical.querySelector('.fretted-finger-dot'),
      'Open strings have no invented finger assignment')
    await setPhysicalView(physical, 'mirror')
    await until(() => Number(query('.fretted-practice')?.dataset.triangles) > 0,
      `${instrument} optional 3D model renders actual triangles`)
    check(!query('.fretted-failure') && query(`.fretted-tab[data-instrument="${instrument}"]`),
      `${instrument} has a working 3D view with tab below it`)
    const toolbar = physical.querySelector('.fretted-toolbar')
    const styleSelect = toolbar.querySelector('[aria-label="Look"]')
    check(JSON.stringify([...styleSelect.options].map((option) => [option.value, option.textContent])) ===
      JSON.stringify(FRETTED_LOOKS.map((look) => [look, LOOK_LABEL[look]])),
    `${instrument} offers three looks and omits Neon`)
    check(loadPrefs().kitStyle === 'electronic:NeonRhythm',
      'Opening a fretted view preserves the saved drum Neon look')
    check(!physical.querySelector('details:not(.fretted-rhythm-guide)') &&
      ![...toolbar.querySelectorAll('button')].some((button) => button.textContent.includes('Whole instrument')),
    `${instrument} keeps a close view without an appearance drawer or whole-instrument control`)
    const triangleCount = Number(physical.dataset.triangles)
    const frameHookName = instrument === 'guitar' ? '__mizanGuitarFrame' : '__mizanBassFrame'
    const previousFrameHook = globalThis[frameHookName]
    const renderedStyles = new Map([[physical.dataset.style, triangleCount]])
    globalThis[frameHookName] = (_canvas, frame) => renderedStyles.set(physical.dataset.style, frame.triangles)
    for (const style of FRETTED_LOOKS.slice(1)) {
      styleSelect.value = style
      styleSelect.dispatchEvent(new Event('change', { bubbles: true }))
      await until(() => physical.dataset.style === style && renderedStyles.has(style),
        `${instrument} ${LOOK_LABEL[style]} appearance renders`)
      check(!query('.fretted-failure') && renderedStyles.get(style) === triangleCount,
        `${instrument} ${LOOK_LABEL[style]} keeps rendering the same model geometry`)
    }
    globalThis[frameHookName] = previousFrameHook
    check(renderedStyles.size === FRETTED_LOOKS.length, `${instrument} renders all three offered appearances`)
    const guide = physical.querySelector('.fretted-instrument-note')?.textContent ?? ''
    check(guide.includes('Finger badges are fingers') && guide.includes('labels marked “Fret N” are frets') &&
      guide.includes('Coloured dot = play now') &&
      !guide.includes('Gold dashed') && guide.includes('String flash = pluck'),
    `${instrument} explains finger and fret labels, the finger colours and string flash, with no next-note marker`)
    fretboardVisible(physical, instrument === 'guitar' ? 6 : 4)
    await overviewVisible(physical)
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
    await overviewVisible(physical)
    const tab = physical.querySelector('.fretted-tab')
    const firstString = tab.querySelector('.fretted-string-label')?.textContent
    check(firstString === (instrument === 'guitar' ? 'E4' : 'G2'), 'Changing handedness does not reverse the conventional tab order')
    check(tab.querySelector('.fretted-rhythm') && !tab.querySelector('.fretted-duration'), 'Tab uses rhythm marks rather than long tails')
    const stageRect = physical.querySelector('.fretted-stage').getBoundingClientRect()
    const toolbarRect = physical.querySelector('.fretted-toolbar').getBoundingClientRect()
    const tabRect = tab.getBoundingClientRect()
    check(stageRect.height >= 240 && toolbarRect.bottom <= stageRect.top && tabRect.top >= stageRect.bottom,
      `Controls do not cover the playing view or compact tab: ${JSON.stringify({ toolbar: toolbarRect.toJSON(), stage: stageRect.toJSON(), tab: tabRect.toJSON() })}`)
    if (innerWidth >= 1100) {
      // The 3D stage, the NOW/NEXT panel, the first tab row and the transport are all on screen without scrolling.
      const staff = tab.querySelector('.fretted-tab-staff').getBoundingClientRect()
      const foot = query('.ws-foot').getBoundingClientRect()
      const practiceEl = query('.fretted-practice')
      check(stageRect.top >= 0 && staff.bottom <= innerHeight && foot.bottom <= innerHeight + 1 &&
        staff.bottom <= foot.top + 1 &&
        document.documentElement.scrollHeight <= innerHeight + 1 &&
        practiceEl.scrollHeight <= practiceEl.clientHeight + 1,
      `${instrument}: the 3D stage and the first tab staff fit ${innerWidth}x${innerHeight} without scrolling: ${JSON.stringify({
        stageTop: stageRect.top, staffBottom: staff.bottom, footBottom: foot.bottom,
        doc: [document.documentElement.scrollHeight, innerHeight], practice: [practiceEl.scrollHeight, practiceEl.clientHeight] })}`)
    }
    const fret = tab.querySelector('.fretted-fret')
    check(Number.parseFloat(getComputedStyle(fret).fontSize) >= 14 &&
      fret.getBoundingClientRect().height >= 21, 'Fret numbers stay readable without shrinking the whole tab')
    check(document.body.textContent.includes(instrument === 'guitar' ? 'six open-string' : 'standard low-to-high'),
      `${instrument} lesson instructions match the instrument`)
    // The chosen view, names, guides and alignment follow the player into another lesson.
    check(loadPrefs().frettedView === 'mirror' && loadPrefs().frettedHandedness === 'left',
      `${instrument}: the 3D mirror and alignment choices are saved: ${localStorage.getItem('mizan:practice')}`)
    query('.ws-back').click()
    await until(() => query('.course-browse'), 'Back returns to Course')
    check(query('[data-tab="course"][aria-selected="true"]') &&
      query(`[data-instrument="${instrument}"][aria-checked="true"]`), 'Back preserves the course instrument')
    const otherLesson = [...document.querySelectorAll('.course-lesson')].find((button) =>
      !button.textContent.includes(instrument === 'guitar' ? 'Name the open strings' : 'Name the four open strings'))
    check(otherLesson, `${instrument} has a second lesson to open`)
    otherLesson.click()
    await until(() => query('.ws'), `${instrument} second lesson opens`)
    await until(() => query('.fretted-practice[data-view="mirror"]'),
      `${instrument} second lesson keeps the 3D mirror view: ${query('.fretted-practice')?.dataset.view}`)
    check(query('.fretted-practice[data-handedness="left"]'), `${instrument} second lesson keeps the alignment`)
    query('.ws-back').click()
    await until(() => query('.course-browse'), 'Back returns to Course after the second lesson')
  }

  const selectScale = (label, value) => {
    const select = [...document.querySelectorAll('.course label')]
      .find((element) => element.textContent.trim().startsWith(label))?.querySelector('select')
    check(select, `${label} scale selector is available`)
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }
  for (const instrument of ['guitar', 'bass']) {
    const title = frettedLessonById(`${instrument}-funk-level-1`).title
    query(`[data-instrument="${instrument}"]`).click()
    await until(() => query(`[data-instrument="${instrument}"][aria-checked="true"]`),
      `${instrument} is selected for its new lesson shelves`)
    check(!query('[data-fretted-shelf="inspired"]'),
      `${instrument} withholds Inspired until real riffs are cleared for inclusion`)
    query('[data-fretted-shelf="genre"]').click()
    await until(() => query('[data-genre="Funk"]'), `${instrument} original genres appear`)
    query('[data-genre="Funk"]').click()
    await until(() => query('.course-lesson')?.textContent.includes(title), 'The selected original study appears')
    query('.course-lesson').click()
    await until(() => query('.ws') && document.body.textContent.includes(title),
      `${instrument} original genre study opens a real practice workspace`)
    query('.ws-back').click()
    await until(() => query('[data-fretted-shelf="genre"][aria-checked="true"]') &&
      query('[data-genre="Funk"][aria-checked="true"]'), 'Back restores the original genre')
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
  let previousHandFrameHook
  let previousGuitarCapture
  let previousRangeBassFrameHook
  let bassHookInstalled = false
  let guitarHookInstalled = false
  let handHookInstalled = false
  let rangeBassHookInstalled = false
  let handContainer
  let handRoot
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
  // The 3D view, look, names, guides and hands choices are remembered; each fixture below starts from the defaults.
  const resetFrettedPrefs = () => {
    const saved = JSON.parse(localStorage.getItem('mizan:practice') ?? '{}')
    for (const key of ['frettedView', 'frettedLook', 'frettedNames', 'frettedGuides', 'hands']) delete saved[key]
    localStorage.setItem('mizan:practice', JSON.stringify(saved))
  }
  try {
    resetFrettedPrefs()
    await render('first')
    check(view() === 'fretboard', 'An unsaved guitar view starts with the fretboard and tab')
    await until(() => find('.fretted-finger-guide'), 'The test song starts in the default flat guide')
    flatStringsVisible(find('.fretted-practice'), 6)
    await setPhysicalView(find('.fretted-practice'), 'mirror')
    await until(() => Number(find('.fretted-practice')?.dataset.triangles) > 0 &&
      container.querySelector('.fretted-3d-pane[data-pane="overview"] .fretted-mirror-toggles'),
    'The guitar 3D model and mirror toggles finish rendering')
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
    await until(() => find('.fretted-practice[data-instrument="bass"]'), 'The bass teaching view appears')
    check(find('.fretted-practice').dataset.view === 'mirror', 'The bass practice view follows the remembered 3D mirror choice')
    await setPhysicalView(find('.fretted-practice'), 'mirror')
    await until(() => Number(find('.fretted-practice')?.dataset.triangles) > 0 &&
      bassFrame?.stringCues.some((cue) => cue.state === 'playback'), 'The bass model draws its open-string cue')
    check(bassFrame.plucks.length === 0 && bassFrame.vibrations.length === 0 &&
      !bassFrame.stringCues.some((cue) => cue.state === 'upcoming') &&
      !bassFrame.markers.some((marker) => marker.state === 'upcoming') && /^NEXT ·/.test(nextRow() ?? ''),
    'The paused bass draws no next-note cue and names the next note in the NEXT text, without a false pluck or vibration')
    engine.loop = { startBar: 2, endBar: 4 }
    engine.countIn = true
    engine.seek(0)
    await engine.play()
    await until(() => engine.read().countingIn &&
      /^COUNT-IN · String/.test(nextRow() ?? '') && !bassFrame?.stringCues.some((cue) => cue.state === 'upcoming') &&
      find('.fretted-practice')?.dataset.countingIn === 'true',
    'The bass names the first note in the COUNT-IN text during count-in, without drawing it')
    checkUpcomingAnimation('Bass count-in')
    engine.pause()
    engine.countIn = false
    engine.seek(0)
    await engine.play()
    await until(() => !engine.starting && engine.read().beat > 0.02 && bassFrame?.plucks.length > 0 &&
      !bassFrame.stringCues.some((cue) => cue.state === 'upcoming') && /^NEXT ·/.test(nextRow() ?? '') &&
      find('.fretted-practice')?.dataset.playing === 'true',
    'The bass plays notes before the loop with string flashes and a NEXT text, but no upcoming cue')
    checkUpcomingAnimation('Bass playback')
    check(bassFrame.plucks.some((pluck) => pluck.string === 1) &&
      !bassFrame.stringCues.some((cue) => cue.state === 'upcoming'),
    'Bass pluck flash follows the transport and no next-string cue is drawn')
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
    await setPhysicalView(find('.fretted-practice'), 'mirror')
    engine.countIn = false
    engine.muted = new Set(['bass'])
    engine.trackGains.set('guitar', 0.4)
    engine.refreshMix()
    engine.seek(0)
    await until(() => guitarFrame?.stringCues.some((cue) => cue.state === 'playback'),
      'The paused playhead positions render without playing sounds')
    check(guitarFrame.plucks.length === 0 && guitarFrame.vibrations.length === 0 &&
      guitarFrame.stringCues.some((cue) => cue.state === 'playback'),
    'A paused playhead stays lit but does not invent a pluck or vibration')
    check(!guitarFrame.stringCues.some((cue) => cue.state === 'upcoming') && /^NEXT ·/.test(nextRow() ?? '') &&
      guitarFrame.markers.every((marker) => marker.position.fret > 0 && marker.state !== 'upcoming'),
    'No next string is cued in the 3D view, the NEXT text names it, and open strings never gain a zero-fret circle')
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
    checkUpcomingAnimation('Guitar paused')
    await engine.play()
    await until(() => !engine.starting && engine.read().beat > 0.02 &&
      embeddedTab.dataset.playing === 'true' && caption.textContent.includes('fretboard follows playback') &&
      tabNote(0)?.dataset.state === 'current' &&
      Number(embeddedPlayhead.getAttribute('x1')) > firstTabX,
    'The embedded tab and caption follow active playback')
    check(tabNote(0)?.dataset.state === 'current' &&
      Number(embeddedPlayhead.getAttribute('x1')) > firstTabX,
    'The embedded tab marks the playing note and advances its playhead')
    await until(() => guitarFrame?.plucks.length > 0, 'Guitar notes flash on the visible strings')
    checkUpcomingAnimation('Guitar playback before the loop')
    check(guitarFrame.plucks.some((pluck) => pluck.string === guitarFrame.stringCues.find((cue) =>
      cue.state === 'playback')?.string) && !guitarFrame.stringCues.some((cue) => cue.state === 'upcoming') &&
      guitarFrame.markers.every((marker) => marker.position.fret > 0 && marker.state !== 'upcoming'),
    'The struck string flashes and no upcoming string is cued')
    const canvas = find('.fretted-canvas')
    check(guitarFrame.plucks.every((pluck) => pluck.x > 0 && pluck.x < canvas.width &&
      pluck.y > 0 && pluck.y < canvas.height),
    'Pluck feedback is projected onto the visible instrument')
    check(guitarFrame.pick && guitarFrame.plucks.length > 0 &&
      guitarFrame.plucks.every((pluck) => Math.abs(pluck.x - guitarFrame.pick.x) < canvas.width * 0.06 &&
        !guitarFrame.markers.some((marker) => Math.hypot(marker.anchorX - pluck.x, marker.anchorY - pluck.y) < 24)),
    `The pluck pulse sits where the pick strikes the string, away from the fretted target: ${JSON.stringify({
      pick: guitarFrame.pick && [guitarFrame.pick.x, guitarFrame.pick.y],
      plucks: guitarFrame.plucks.map((pluck) => [pluck.x, pluck.y]),
      markers: guitarFrame.markers.map((marker) => [marker.anchorX, marker.anchorY]) })}`)
    engine.pause()
    await until(() => guitarFrame && !guitarFrame.plucks.length && !guitarFrame.vibrations.length,
      'Pausing clears the pluck and string motion')
    check(guitarFrame.stringCues.some((cue) => cue.state === 'playback'),
      'Pausing keeps the playhead string highlighted')
    engine.loop = { startBar: 1, endBar: 4 }
    engine.seek(15.75)
    await until(() => /^NEXT · String 6 /.test(nextRow() ?? ''),
      'Loop end names the first string of the loop in the NEXT text')
    check(!guitarFrame.stringCues.some((cue) => cue.state === 'upcoming'), 'No upcoming string is cued at the loop end')
    check(!guitarFrame.plucks.length && !guitarFrame.vibrations.length,
      'A paused loop seek does not create a strike effect')
    engine.loop = { startBar: 4, endBar: 4 }
    await until(() => !/^NEXT · String 6 /.test(nextRow() ?? ''),
      'Paused loop-bound changes immediately update the NEXT text')
    engine.loop = { startBar: 1, endBar: 4 }
    await until(() => /^NEXT · String 6 /.test(nextRow() ?? ''),
      'Restoring the original loop restores its wrapped NEXT text')
    engine.loop = null
    await until(() => !/^NEXT · String 6 /.test(nextRow() ?? ''),
      'Disabling the loop immediately clears its wrapped NEXT text without a seek')
    // Let the hand finish any pose it was still preparing, then an unchanged paused view must not redraw.
    for (let settled = 0, last = -1, attempt = 0; settled < 3 && attempt < 100; attempt++) {
      await sleep(100)
      settled = guitarFrameCount === last ? settled + 1 : 0
      last = guitarFrameCount
    }
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
    await until(() => engine.read().countingIn && /^COUNT-IN · String/.test(nextRow() ?? ''),
      'Count-in names the first string in the COUNT-IN text')
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
    const guideLoop = engine.loop
    await setPhysicalView(physical, 'guide')
    engine.loop = { startBar: 1, endBar: 4 }
    engine.seek(0)
    await until(() => physical.querySelector('.fretted-finger-open-cue[data-string="1"][data-state="pressed"]'),
      'The flat guide reads the paused engine playhead, not an old beat prop')
    engine.seek(1.1)
    await until(() => physical.querySelector('.fretted-finger-open-cue[data-string="3"][data-state="pressed"]') &&
      !physical.querySelector('.fretted-finger-open-cue[data-string="1"][data-state="pressed"]'),
    'Seeking moves the flat guide to the correct sounding string')
    engine.seek(15.75)
    await until(() => physical.querySelectorAll('.fretted-guide-row')[1]?.textContent.includes('String 6') &&
      !physical.querySelector('[data-state="preview"]'),
    'The flat guide names the first string of the loop in its NEXT row, with no next marker')
    engine.loop = { startBar: 2, endBar: 4 }
    await until(() => !physical.querySelectorAll('.fretted-guide-row')[1]?.textContent.includes('String 6'),
      'Changing loop bounds updates the NEXT row without a seek')
    engine.loop = guideLoop
    const guideFrameCount = guitarFrameCount
    await setPhysicalView(physical, 'mirror')
    await until(() => guitarFrameCount > guideFrameCount,
      'The optional 3D renderer resumes after the flat transport checks')
    engine.seek(1)
    await engine.play()
    await until(() => !engine.starting && engine.read().beat > 1, 'Guitar notes play')
    const before = {
      engine, anchors: engine.anchors, timer: engine.timer, revision: engine.revision,
      beat: engine.read().beat, time: engine.ctx.currentTime, rate: engine.rate,
      loop: JSON.stringify(engine.loop), count: engines.size,
    }
    await setPhysicalView(physical, 'guide')
    await until(() => find('.fretted-finger-guide'), 'Switching from 3D opens the flat guide during playback')
    flatStringsVisible(physical, 6)
    await setPhysicalView(physical, 'mirror')
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
    const single = [{ midi: 43, string: 1, fret: 3, finger: 3, startBeat: 0, beats: 2 }]
    const singleSong = { ...guitar, title: 'Suggested single-note grip', chords: [], chordLabels: [], piano: [],
      instrumentNotes: { ...guitar.instrumentNotes, guitar: single } }
    const singleIndexSong = { ...singleSong, title: 'Index finger at fret 3',
      instrumentNotes: { ...singleSong.instrumentNotes, guitar: [
        { ...single[0], finger: 1 },
      ] } }
    const nextOpenSong = { ...guitar, title: 'Repeated open-string cue after a rest', chords: [], chordLabels: [], piano: [],
      instrumentNotes: { ...guitar.instrumentNotes, guitar: [
        { midi: 40, string: 1, fret: 0, startBeat: 0, beats: 1 },
        { midi: 40, string: 1, fret: 0, startBeat: 4, beats: 0.5 },
      ] } }
    const guideSequenceSong = { ...guitar, title: 'Current and next fret after a rest', chords: [], chordLabels: [], piano: [],
      instrumentNotes: { ...guitar.instrumentNotes, guitar: [
        { midi: 43, string: 1, fret: 3, startBeat: 0, beats: 1 },
        { midi: 52, string: 2, fret: 7, startBeat: 4, beats: 1 },
      ] } }
    const repeatedFrettedSong = { ...guitar, title: 'Repeated fret cue after a rest', chords: [], chordLabels: [], piano: [],
      instrumentNotes: { ...guitar.instrumentNotes, guitar: [
        { midi: 43, string: 1, fret: 3, startBeat: 0, beats: 1 },
        { midi: 43, string: 1, fret: 3, startBeat: 4, beats: 1 },
      ] } }
    const heldLoopOpenSong = { ...singleSong, title: 'Held OPEN note in one-bar loop', bars: 1, barMap: undefined,
      instrumentNotes: { ...singleSong.instrumentNotes, guitar: [
        { midi: 40, string: 1, fret: 0, startBeat: 0, beats: 3.9 },
      ] } }
    const heldLoopFrettedSong = { ...singleSong, title: 'Held fretted note in one-bar loop', bars: 1, barMap: undefined,
      instrumentNotes: { ...singleSong.instrumentNotes, guitar: [
        { midi: 43, string: 1, fret: 3, startBeat: 0, beats: 3.9 },
      ] } }
    const emptySong = { ...guitar, title: 'Idle fretboard layout', chords: [], chordLabels: [], piano: [],
      instrumentNotes: { ...guitar.instrumentNotes, guitar: [] } }
    const barre = [
      { midi: 41, string: 1, fret: 1, finger: 1, startBeat: 0, beats: 2 },
      { midi: 48, string: 2, fret: 3, finger: 3, startBeat: 0, beats: 2 },
      { midi: 53, string: 3, fret: 3, finger: 3, startBeat: 0, beats: 2 },
      { midi: 57, string: 4, fret: 2, finger: 2, startBeat: 0, beats: 2 },
      { midi: 60, string: 5, fret: 1, finger: 1, startBeat: 0, beats: 2 },
      { midi: 65, string: 6, fret: 1, finger: 1, startBeat: 0, beats: 2 },
    ]
    const barreSong = { ...guitar, title: 'Suggested F barre', chords: [], chordLabels: [], piano: [],
      instrumentNotes: { ...guitar.instrumentNotes, guitar: barre } }
    const stageHandNotes = [
      { midi: 41, string: 1, fret: 1, startBeat: 0, beats: 1 },
      { midi: 50, string: 2, fret: 5, startBeat: 0, beats: 1 },
      { midi: 59, string: 3, fret: 9, startBeat: 0, beats: 1 },
    ]
    const unplayableSong = { ...guitar, title: 'Unplayable suggested stretch', piano: [],
      instrumentNotes: { ...guitar.instrumentNotes, guitar: stageHandNotes } }
    handContainer = document.createElement('div')
    handContainer.style.cssText = 'position:fixed;left:-900px;top:0;width:617px;height:500px;overflow:hidden'
    document.body.append(handContainer)
    handRoot = ReactDOM.createRoot(handContainer)
    const renderFlat = async (piece, options = {}) => {
      resetFrettedPrefs()
      handRoot.render(React.createElement(GuitarView, {
        key: 'flat-guide-check', song: piece, track: guitar.tracks[0], trackId: 'guitar',
        beat: 0, playing: false, countingIn: false, handedness: 'right', onPick() {}, ...options,
      }))
      await until(() => handContainer.querySelector('.fretted-finger-guide'),
        'The default flat finger guide renders')
    }
    const originalGetContext = HTMLCanvasElement.prototype.getContext
    let webglRequests = 0
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') {
        webglRequests++
        throw new Error('WebGL is deliberately unavailable for the flat-guide regression')
      }
      return originalGetContext.call(this, kind, ...args)
    }
    try {
      await renderFlat(singleSong)
      await until(() => handContainer.querySelector('.fretted-finger-dot[data-finger="3"][data-string="1"][data-fret="3"]'),
        'The flat guide marks the authored ring finger on low E at fret 3')
      flatStringsVisible(handContainer.querySelector('.fretted-practice'), 6)
      check(!handContainer.querySelector('.fretted-failure') && webglRequests === 0,
        'The default guide works without asking for WebGL')
      let pickedFingerBeat = -1
      await renderFlat(singleIndexSong, { onPick: (value) => { pickedFingerBeat = value } })
      await until(() => handContainer.querySelector('.fretted-finger-dot[data-finger="1"][data-string="1"][data-fret="3"]'),
        'Finger 1 is shown at fret 3 in the flat guide')
      const fingerDot = handContainer.querySelector('.fretted-finger-dot[data-finger="1"]')
      check(fingerDot.textContent.trim() === '1' &&
        handContainer.querySelector('.fretted-guide-summary')?.textContent.includes('Index finger (1)') &&
        handContainer.querySelector('.fretted-guide-summary')?.textContent.includes('Fret 3'),
      'A dot shows the finger number, not the fret number, with an explicit named instruction')
      check(fingerDot.getBoundingClientRect().width >= 32 &&
        Number.parseFloat(getComputedStyle(fingerDot).fontSize) >= 14,
      'Finger dots keep readable numbers and a usable click target')
      fingerDot.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      check(pickedFingerBeat === 0, 'The finger target seeks to its note without changing its assignment')
      const guideRect = handContainer.querySelector('.fretted-finger-guide').getBoundingClientRect()
      const rightDotX = fingerDot.getBoundingClientRect().x - guideRect.x
      await renderFlat(singleIndexSong, { handedness: 'left' })
      await until(() => handContainer.querySelector('.fretted-practice[data-handedness="left"]'),
        'Left-handed alignment applies to the flat guide')
      const leftDot = handContainer.querySelector('.fretted-finger-dot[data-finger="1"][data-fret="3"]')
      flatStringsVisible(handContainer.querySelector('.fretted-practice'), 6)
      check(Math.abs(leftDot.getBoundingClientRect().x - guideRect.x - rightDotX) > 10,
        'Handedness mirrors the fret axis while keeping each string in tab order')
      await renderFlat(barreSong)
      await until(() => handContainer.querySelector('.fretted-finger-barre[data-finger="1"][data-fret="1"]') &&
        handContainer.querySelector('.fretted-finger-barre[data-finger="3"][data-fret="3"]'),
      'The authored index and ring barres are visible connected shapes at their own frets')
      check(handContainer.querySelector('.fretted-guide-summary')?.textContent.includes('Lesson fingering') &&
        handContainer.querySelector('.fretted-hand-side-inset'),
      'The barre guide retains the fingering source and thumb/finger side illustration')
      await renderFlat(singleIndexSong, { beat: -0.5, countingIn: true })
      await until(() => handContainer.querySelectorAll('.fretted-guide-row')[1]?.textContent.includes('COUNT-IN') &&
        !handContainer.querySelector('.fretted-finger-dot'),
      'Count-in draws no finger dot and names the first note in the COUNT-IN row')
      await renderFlat(guitar)
      await until(() => !handContainer.querySelector('.fretted-finger-dot'),
        'Open-string practice clears the finger dots')
      check(!handContainer.querySelector('.fretted-finger-barre'),
        'Open strings receive no invented finger or barre')
      await renderFlat(unplayableSong)
      await until(() => handContainer.querySelector('.fretted-guide-row .is-unavailable'),
        'A wide stretch keeps the explanation instead of guessing finger assignments')
      const heldAcrossBar = { ...singleSong, instrumentNotes: { ...singleSong.instrumentNotes, guitar: [
        { midi: 52, string: 1, fret: 12, startBeat: 0, beats: 6 },
        { midi: 46, string: 2, fret: 1, startBeat: 4, beats: 1 },
      ] } }
      await renderFlat(heldAcrossBar, { beat: 4.1 })
      await until(() => handContainer.querySelector('.fretted-finger-target[data-string="1"][data-fret="12"]') &&
        handContainer.querySelector('.fretted-finger-fret-label[data-fret="12"]'),
      'A note held across a barline stays at its actual fret instead of being clipped to the current phrase')
      const heldTarget = handContainer.querySelector('.fretted-finger-target[data-fret="12"]').getBoundingClientRect()
      const heldBoard = handContainer.querySelector('.fretted-finger-guide').getBoundingClientRect()
      check(heldTarget.left >= heldBoard.left && heldTarget.right <= heldBoard.right,
        'The held high-fret target remains inside the diagram')
      const highPosition = { ...singleSong, instrumentNotes: { ...singleSong.instrumentNotes, guitar: [
        { midi: 52, string: 1, fret: 12, finger: 3, startBeat: 0, beats: 2 },
      ] } }
      await renderFlat(highPosition)
      await until(() => handContainer.querySelector('.fretted-finger-dot[data-fret="12"]'),
        'A high position opens its own fret range')
      check(handContainer.querySelector('.fretted-guide-nut') &&
        handContainer.querySelector('.fretted-finger-fret-label[data-fret="22"]'),
        'A high-position cue retains the real nut and every fret through the end of the configured board')
      check(webglRequests === 0 && !handContainer.querySelector('.fretted-failure'),
        'Single notes, barres, mirroring and previews all work without WebGL')
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext
    }
    previousHandFrameHook = globalThis.__mizanGuitarFrame
    handHookInstalled = true
    previousGuitarCapture = globalThis.__mizanGuitarCapture
    globalThis.__mizanGuitarCapture = true
    let handFrame
    const paneFrames = {}
    let handFrameCount = 0
    let renderedHandFixture = false
    globalThis.__mizanGuitarFrame = (_canvas, frame, pane) => {
      handFrame = frame
      if (pane) paneFrames[pane] = frame
      handFrameCount++
    }
    const renderHand = async (piece, { beat = 0, playing = false, countingIn = false,
      handedness = 'right', onPick = () => {}, engine: renderEngine } = {}) => {
      const previousCount = handFrameCount
      const previousSection = handContainer.querySelector('.fretted-practice')
      const replacingFlatFixture = !renderedHandFixture
      renderedHandFixture = true
      handRoot.render(React.createElement(GuitarView, {
        song: piece, track: guitar.tracks[0], trackId: 'guitar', beat, playing,
        countingIn, handedness, onPick, engine: renderEngine,
      }))
      if (replacingFlatFixture) await until(() =>
        handContainer.querySelector('.fretted-practice') !== previousSection,
      'The 3D fixture replaces the separate flat-guide fixture')
      await until(() => handContainer.querySelector('[data-fretted-view="mirror"]'),
        'The optional 3D mirror view is available')
      await setPhysicalView(handContainer.querySelector('.fretted-practice'), 'mirror')
      return previousCount
    }
    const layoutSnapshot = (mode) => {
      const selectors = [
        '.fretted-toolbar', '.fretted-stage', mode === 'guide' ? '.fretted-guide-summary' : '.fretted-hand-guidance',
        '.fretted-instrument-note', '.fretted-strip', '.fretted-tab',
      ]
      return Object.fromEntries(selectors.map((selector) => {
        const element = handContainer.querySelector(selector)
        check(element, `${mode} layout exposes ${selector}`)
        const { x, y, width, height } = element.getBoundingClientRect()
        return [selector, { x, y, width, height }]
      }))
    }
    const layoutRemainsStable = (baseline, mode, state) => {
      const current = layoutSnapshot(mode)
      for (const selector of Object.keys(baseline)) for (const field of ['x', 'y', 'width', 'height']) {
        check(Math.abs(current[selector][field] - baseline[selector][field]) <= 1,
          `${mode} ${state} keeps ${selector} ${field} fixed (expected ${baseline[selector][field]}, got ${current[selector][field]})`)
      }
    }
    handContainer.style.width = '617px'
    const flatLayoutStates = [
      ['idle', emptySong, { beat: 0 }],
      ['single note', singleSong, { beat: 0.25 }],
      ['chord', barreSong, { beat: 0.25 }],
      ['repeated OPEN next after a rest', nextOpenSong, { beat: 0.25 }],
      ['repeated fret next after a rest', repeatedFrettedSong, { beat: 0.25 }],
      ['unavailable grip', unplayableSong, { beat: 0.25 }],
      ['count-in', singleSong, { beat: -0.5, countingIn: true }],
      ['seek/playback', singleSong, { beat: 1.25, playing: true }],
    ]
    let flatLayoutBaseline
    for (const [state, piece, options] of flatLayoutStates) {
      await renderFlat(piece, options)
      await sleep(30)
      if (!flatLayoutBaseline) flatLayoutBaseline = layoutSnapshot('guide')
      else layoutRemainsStable(flatLayoutBaseline, 'guide', state)
    }
    await renderFlat(nextOpenSong, { beat: 0.25 })
    await until(() => handContainer.querySelector('.fretted-finger-open-cue[data-state="pressed"]') &&
      !handContainer.querySelector('.fretted-finger-open-cue[data-state="preview"]') &&
      handContainer.querySelectorAll('.fretted-guide-row')[1]?.textContent.includes('OPEN'),
    'The current OPEN cue appears and the repeated next OPEN is only named in the NEXT row')
    layoutRemainsStable(flatLayoutBaseline, 'guide', 'repeated OPEN next after a rest')
    check(handContainer.querySelector('.fretted-finger-open-cue[data-state="pressed"]') &&
      !handContainer.querySelector('.fretted-finger-open-cue[data-state="preview"]'),
    'The flat guide draws no upcoming OPEN cue')
    await renderFlat(guideSequenceSong, { beat: 0.25 })
    await until(() => handContainer.querySelector('.fretted-finger-dot[data-state="pressed"]') &&
      !handContainer.querySelector('.fretted-finger-target[data-state="preview"]') &&
      handContainer.querySelectorAll('.fretted-guide-row')[1]?.textContent.includes('Fret'),
    'The flat guide names the actual next fretted note beyond a multi-beat rest in its NEXT row, without a marker')
    layoutRemainsStable(flatLayoutBaseline, 'guide', 'current and distant next frets')
    await renderFlat(repeatedFrettedSong, { beat: 0.25 })
    await until(() => handContainer.querySelectorAll('.fretted-guide-row')[1]?.textContent.includes('Fret 3'),
      'The repeated same-fret onset appears in the flat next-note slot')
    const repeatedFlatDot = handContainer.querySelector('.fretted-finger-dot[data-state="pressed"]')
    check(repeatedFlatDot && !repeatedFlatDot.dataset.overlapsNext && !handContainer.querySelector('.fretted-finger-target[data-state="preview"]'),
      'The flat guide shows only the current marker; a repeated next fret appears as text')
    layoutRemainsStable(flatLayoutBaseline, 'guide', 'repeated fret next after a rest')
    for (const [piece, selectors, name] of [
      [heldLoopOpenSong, [
        '.fretted-finger-open-cue[data-string="1"][data-state="pressed"]',
      ], 'held OPEN'],
      [heldLoopFrettedSong, [
        '.fretted-finger-dot[data-string="1"][data-fret="3"][data-state="pressed"]',
      ], 'held fretted'],
    ]) {
      const loopEngine = new Engine(piece)
      loopEngine.loop = { startBar: 1, endBar: 1 }
      for (const beat of [3.5, 0]) {
        loopEngine.seek(beat)
        await renderFlat(piece, { engine: loopEngine })
        await sleep(50)
        await until(() => selectors.every((selector) => handContainer.querySelector(selector)),
          `${name} loop shows the current note at beat ${beat}`)
        check(!handContainer.querySelector('[data-state="preview"]') &&
          handContainer.querySelectorAll('.fretted-guide-row')[1]?.textContent.includes('String'),
        `${name} loop draws no next marker and names the wrapped next onset in the NEXT row at beat ${beat}`)
      }
      loopEngine.dispose()
    }
    if (globalThis.__mizanFrettedShot && innerWidth === 1440) {
      handContainer.style.cssText = 'position:fixed;left:0;top:0;z-index:1000;width:1440px;height:900px;overflow:hidden'
      await renderFlat(guideSequenceSong, { beat: 0.25 })
      await globalThis.__mizanFrettedShot('flat-guide-wide')
      handContainer.style.cssText = 'position:fixed;left:-900px;top:0;width:617px;height:500px;overflow:hidden'
    } else if (globalThis.__mizanFrettedShot && innerWidth === 617) {
      handContainer.style.cssText = 'position:fixed;left:0;top:0;z-index:1000;width:617px;height:900px;overflow:hidden'
      await globalThis.__mizanFrettedShot('flat-guide-compact')
      handContainer.style.cssText = 'position:fixed;left:-900px;top:0;width:617px;height:500px;overflow:hidden'
    }
    let handLayoutBaseline
    const handLayoutStates = [
      ['idle', emptySong, { beat: 0 }],
      ['single note', singleSong, { beat: 0.25 }],
      ['chord', barreSong, { beat: 0.25 }],
      ['repeated OPEN next after a rest', nextOpenSong, { beat: 0.25 }],
      ['repeated fret next after a rest', repeatedFrettedSong, { beat: 0.25 }],
      ['unavailable grip', unplayableSong, { beat: 0.25 }],
      ['count-in', singleSong, { beat: -0.5, countingIn: true }],
      ['seek/playback', singleSong, { beat: 1.25, playing: true }],
    ]
    for (const [state, piece, options] of handLayoutStates) {
      const frameBefore = await renderHand(piece, options)
      await until(() => {
        if (handFrameCount <= frameBefore) return false
        const guidance = handContainer.querySelector('.fretted-hand-guidance')?.textContent ?? ''
        if (state === 'idle') return guidance.includes('No current note')
        if (state === 'single note') return guidance.includes('Fret 3')
        if (state === 'chord') return guidance.includes('Fret 1')
        if (state === 'repeated OPEN next after a rest')
          return guidance.includes('NOW · String 6 Low E · OPEN') &&
            guidance.includes('NEXT · String 6 Low E · OPEN')
        if (state === 'repeated fret next after a rest')
          return guidance.includes('NOW · String 6 Low E · Fret 3') &&
            guidance.includes('NEXT · String 6 Low E · Fret 3')
        if (state === 'unavailable grip') return guidance.includes('No plausible hand pose')
        if (state === 'count-in') return guidance.includes('COUNT-IN · GET READY')
        return handContainer.querySelector('.fretted-practice')?.dataset.playing === 'true'
      }, `The 3D ${state} layout state draws`)
      await sleep(40)
      if (!handLayoutBaseline) handLayoutBaseline = layoutSnapshot('hand')
      else layoutRemainsStable(handLayoutBaseline, 'hand', state)
    }
    const repeatedOpenFrame = await renderHand(nextOpenSong, { beat: 0.25 })
    await until(() => handFrameCount > repeatedOpenFrame &&
      handContainer.querySelector('.fretted-hand-guidance')?.textContent.includes('NEXT · String 6 Low E · OPEN'),
    'The 3D repeated OPEN state draws')
    layoutRemainsStable(handLayoutBaseline, 'hand', 'repeated OPEN next after a rest')
    const openGuideText = handContainer.querySelector('.fretted-hand-guidance')?.textContent ?? ''
    check(openGuideText.includes('NOW · String 6 Low E · OPEN') &&
      openGuideText.includes('NEXT · String 6 Low E · OPEN'),
    `The 3D guidance names the currently playing OPEN note and its repeated next onset: ${openGuideText}`)
    const repeatedFretFrame = await renderHand(repeatedFrettedSong, { beat: 0.25 })
    await until(() => handFrameCount > repeatedFretFrame &&
      handContainer.querySelector('.fretted-hand-guidance')?.textContent.includes('NEXT · String 6 Low E · Fret 3'),
    'The 3D repeated-fret cue after a multi-beat rest draws')
    const repeatedFretMarkers = [...handContainer.querySelectorAll(
      '.fretted-3d-pane[data-pane="overview"] .fretted-mirror-target[data-string="1"][data-fret="3"]')]
    check(repeatedFretMarkers.length >= 1 &&
      repeatedFretMarkers.some((marker) => marker.dataset.state === 'playback'),
    'The 3D current marker stays at its fret while the next onset repeats it')
    layoutRemainsStable(handLayoutBaseline, 'hand', 'repeated fret next after a rest')
    handContainer.style.width = '1440px'
    await sleep(80)
    const wideHandFrameBefore = handFrameCount
    await renderHand(singleSong)
    await until(() => handFrameCount > wideHandFrameBefore &&
      handContainer.querySelector('.fretted-hand-guidance')?.textContent.includes('Fret 3'),
    'The wide 3D layout redraws after a panel resize')
    await sleep(30)
    const wideHandLayout = layoutSnapshot('hand')
    const wideOpenFrameBefore = await renderHand(nextOpenSong, { beat: 0.25 })
    await until(() => handFrameCount > wideOpenFrameBefore, 'The wide 3D repeated OPEN cue draws')
    layoutRemainsStable(wideHandLayout, 'hand', 'wide OPEN next after a rest')
    const wideChordFrame = await renderHand(barreSong)
    await until(() => handFrameCount > wideChordFrame &&
      !handFrame?.handPending && handFrame?.hand?.mesh.rendered &&
      handContainer.querySelector('.fretted-hand-guidance')?.textContent.includes('Fret 1'),
    'The wide chord draws')
    await sleep(40)
    handContainer.style.width = '617px'
    await sleep(80)
    const compactHandFrameBefore = handFrameCount
    await renderHand(singleSong)
    await until(() => handFrameCount > compactHandFrameBefore &&
      handContainer.querySelector('.fretted-hand-guidance')?.textContent.includes('Fret 3'),
    'The compact 3D layout redraws after a panel resize')
    const compactHandLayout = layoutSnapshot('hand')
    const compactChordFrameBefore = await renderHand(barreSong)
    await until(() => handFrameCount > compactChordFrameBefore &&
      !handFrame?.handPending && handFrame?.hand?.mesh.rendered &&
      handContainer.querySelector('.fretted-hand-guidance')?.textContent.includes('Fret 1'),
    'The compact chord guidance draws')
    layoutRemainsStable(compactHandLayout, 'hand', 'compact chord')
    await sleep(40)
    check(!handContainer.querySelector('.fretted-digit-identity'),
      'The mirror draws no close-up finger badges; the NOW panel names the fingers')
    if (globalThis.__mizanFrettedShot && innerWidth === 1440) {
      handContainer.style.cssText = 'position:fixed;left:0;top:0;z-index:1000;width:1440px;height:900px;overflow:hidden'
      const wideShotFrame = handFrameCount
      await renderHand(barreSong)
      await until(() => handFrameCount > wideShotFrame &&
        handContainer.querySelector('.fretted-hand-guidance')?.textContent.includes('Fret 1'),
      'The wide hand-shape screenshot finishes rendering')
      await globalThis.__mizanFrettedShot('hand-shape-wide')
      handContainer.style.cssText = 'position:fixed;left:-900px;top:0;width:617px;height:500px;overflow:hidden'
    } else if (globalThis.__mizanFrettedShot && innerWidth === 617) {
      handContainer.style.cssText = 'position:fixed;left:0;top:0;z-index:1000;width:617px;height:900px;overflow:hidden'
      await globalThis.__mizanFrettedShot('hand-shape-compact')
      handContainer.style.cssText = 'position:fixed;left:-900px;top:0;width:617px;height:500px;overflow:hidden'
    }
    await renderHand(singleSong)
    await until(() => handFrame?.hand?.state === 'pressed' &&
      handFrame.hand.mesh.rendered && handFrame.hand.contacts.length === 1,
    'A single fretted note draws a current 3D hand in the fretboard renderer')
    await sleep(30)
    const handSection = handContainer.querySelector('.fretted-practice')
    const mirrorFrame = async (handedness, side) => {
      const before = await renderHand(singleSong, { handedness })
      await setPhysicalView(handSection, 'mirror')
      try {
        await until(() => paneFrames.overview && !paneFrames.overview.handPending &&
          paneFrames.overview.hand?.assetSide === side && paneFrames.overview.hand.mesh.rendered,
        `The ${handedness}-handed mirror finishes its ${side} fretting hand`)
      } catch (error) {
        const frame = paneFrames.overview
        throw new Error(`${error.message} ${JSON.stringify({ count: handFrameCount, before, has: !!frame,
          pending: frame?.handPending, unavailable: frame?.handUnavailable, reason: frame?.handReason,
          side: frame?.hand?.assetSide, drawn: frame?.handDrawn })}`)
      }
      await until(() => handSection.querySelector('.fretted-mirror-target') ||
        handSection.querySelector('[data-pane="overview"] .fretted-mirror-toggles'),
      'The mirror guidance layer is drawn')
      const guidance = handSection.querySelector('.fretted-hand-guidance')
      const contact = paneFrames.overview.hand.contacts[0]
      const fingerName = { 1: 'Index finger', 2: 'Middle finger', 3: 'Ring finger', 4: 'Little finger', 5: 'Thumb' }[contact.finger]
      await until(() => guidance?.textContent.includes(fingerName) &&
        guidance.textContent.includes(`Fret ${contact.fret}`) &&
        !guidance.textContent.includes('No fretting finger needed'),
      `The mirror guidance describes ${fingerName} at Fret ${contact.fret}: ${guidance?.textContent}`)
      return paneFrames.overview
    }
    const mirrorOrientation = (frame) => ({
      nutX: frame.stringLabels[0].anchorX, lastFretX: frame.fretLabels.at(-1).x, pickX: frame.pick?.x,
      thickY: frame.stringLabels.find((label) => label.string === 1).anchorY,
      thinY: frame.stringLabels.find((label) => label.string === frame.stringLabels.length).anchorY,
    })
    const rightFrame = await mirrorFrame('right', 'left')
    const overviewHand = rightFrame.hand
    check(overviewHand.mesh.rendered && overviewHand.contacts.length === 1 &&
      overviewHand.mesh.triangles > 1000,
    'The 3D mirror draws the connected posed fretting hand')
    const rightMirror = mirrorOrientation(rightFrame)
    check(rightMirror.pickX > rightMirror.lastFretX && rightMirror.lastFretX > rightMirror.nutX &&
      rightMirror.thickY < rightMirror.thinY && rightFrame.pick.size > 0 &&
      rightFrame.pick.size < Math.abs(rightMirror.thickY - rightMirror.thinY),
    'The right-handed mirror keeps the LEFT fretting hand and neck at screen left, a small bridge pick at screen right, and the actual low E string above the thin high E string')
    const mirrorCanvas = handSection.querySelector('canvas')
    const fill = (rightFrame.bounds.right - rightFrame.bounds.left) / mirrorCanvas.width
    check(fill >= 0.68 && fill <= 0.98 && rightFrame.bounds.left >= 0 && rightFrame.bounds.right <= mirrorCanvas.width &&
      rightFrame.bounds.top >= 0 && rightFrame.bounds.bottom <= mirrorCanvas.height,
    `The whole guitar fills most of the mirror width without cropping (${fill.toFixed(2)})`)
    const leftFrame = await mirrorFrame('left', 'right')
    const leftMirror = mirrorOrientation(leftFrame)
    check(leftMirror.pickX < leftMirror.lastFretX && leftMirror.lastFretX < leftMirror.nutX,
    'A left-handed player sees the mirrored layout reversed with the RIGHT fretting hand and the pick at screen left')
    check(leftMirror.thickY !== undefined && Math.sign(leftMirror.thickY - leftMirror.thinY) ===
      Math.sign(rightMirror.thickY - rightMirror.thinY),
    'Mirroring is horizontal only: string numbering, thick/thin order and labels are not swapped')
    await mirrorFrame('right', 'left')
    await renderHand(singleSong)
    await until(() => !handFrame?.handPending &&
      handFrame?.hand?.assetSide === 'left', 'The mirror restores the right-handed LEFT fretting grip')
    check(handFrame.hand.mesh.triangles > 1000 && handFrame.hand.mesh.rendered &&
      handFrame.hand.mesh.contactTips.length === 1 && handFrame.hand.mesh.contactTips[0].gap <= 0.008 &&
      handFrame.hand.fingers.length === 4 &&
      handFrame.hand.fingers.filter((finger) => finger.pressed).length === 1 &&
      handFrame.hand.fingers.filter((finger) => !finger.pressed).length === 3 &&
      handFrame.hand.thumb &&
      handContainer.querySelector('.fretted-instrument-note')?.textContent.includes('suggested shape'),
    'A single note draws the connected skinned hand and its actual contacting finger with a restrained fingering note')
    for (const [piece, name, fret] of [
      [heldLoopOpenSong, 'OPEN', 0],
      [heldLoopFrettedSong, 'fretted', 3],
    ]) {
      const loopEngine = new Engine(piece)
      loopEngine.loop = { startBar: 1, endBar: 1 }
      for (const beat of [3.5, 0]) {
        loopEngine.seek(beat)
        const frameBefore = await renderHand(piece, { engine: loopEngine })
        await until(() => handFrameCount > frameBefore &&
          handFrame.stringCues.some((cue) => cue.string === 1 && cue.state === 'playback') &&
          !handFrame.stringCues.some((cue) => cue.state === 'upcoming') &&
          /^NEXT · String/.test(nextRow() ?? ''),
        `A held ${name} note shows playback only, and its repeated next onset is named in the NEXT text at loop beat ${beat}`)
        if (fret) {
          const markers = handFrame.markers.filter((marker) =>
            marker.position.string === 1 && marker.position.fret === fret)
          check(markers.some((marker) => marker.state === 'playback') &&
            !handFrame.markers.some((marker) => marker.state === 'upcoming'),
          `The held fret has a current marker and no wrapped-next marker at loop beat ${beat}`)
        }
      }
      loopEngine.dispose()
    }
    const restoredSingleFrame = await renderHand(singleSong)
    await until(() => handFrameCount > restoredSingleFrame && handFrame?.hand?.contacts.length === 1 &&
      handContainer.querySelector('.fretted-hand-guidance')?.textContent.includes('Fret 3'),
    'The single-note hand frame is restored after the loop cases')
    const knuckleRoots = handFrame.hand.fingers.map((finger) => finger.joints[0])
    const rootDistances = knuckleRoots.flatMap((point, index) =>
      knuckleRoots.slice(index + 1).map((other) =>
        Math.hypot(...point.map((value, axis) => value - other[axis]))))
    check(rootDistances.every((distance) => distance > 0.005) &&
      handFrame.hand.fingers.every((finger) => finger.lengths.length === 4 &&
        finger.lengths.every((length) => length > 0.005 && length < 0.08)),
    'The skinned hand keeps four distinct knuckles and plausible, connected source bone lengths')
    const pressed = handFrame.hand.fingers.find((finger) => finger.pressed)
    check(pressed.angles.length === 4 && pressed.angles.every(Number.isFinite) &&
      pressed.angles[0] === 0 &&
      pressed.angles.slice(1).every((angle, index) =>
        angle >= [-0.4, 0, 0][index] && angle <= [1.65, 1.8, 1.25][index]),
    'The active finger bends only at its constrained source joints')
    check(handFrame.stringGuides.length === 6 &&
      handFrame.stringGuides.every((guide) => guide.visible.length > 0 && Array.isArray(guide.hidden)),
    'Every physical guitar string has a haloed teaching guide')
    const guidanceNow = () => handContainer.querySelector('.fretted-hand-guidance')?.textContent
    await until(() => handContainer.querySelector('.fretted-hand-guidance')?.textContent.includes('Ring finger (3)') &&
      handContainer.querySelector('.fretted-hand-guidance')?.textContent.includes('6 Low E') &&
      handContainer.querySelector('.fretted-hand-guidance')?.textContent.includes('Fret 3') &&
      handContainer.querySelector('.fretted-hand-side-inset'),
    () => `Named finger, string and fret guidance disambiguates tab numbers and explains thumb support: ${guidanceNow()}`)
    const indexFrameBefore = await renderHand(singleIndexSong)
    await until(() => handFrameCount > indexFrameBefore && handFrame?.hand?.contacts[0]?.finger === 1 &&
      handContainer.querySelector('.fretted-hand-guidance')?.textContent.includes('Index finger (1)'),
    'An index-finger assignment remains explicit at fret 3')
    check(handFrame.hand.contacts[0].fret === 3 &&
      handContainer.querySelector('.fretted-hand-guidance')?.textContent.includes('Fret 3'),
    'Finger 1 is not confused with fret 1 when pressing fret 3')
    const restoreSingleFrame = await renderHand(singleSong)
    await until(() => handFrameCount > restoreSingleFrame && handFrame?.hand?.contacts[0]?.finger === 3,
      'The single-note hand pose is restored after the index-finger regression')
    const exactContacts = async () => {
      await until(() => handFrame.hand.contacts.every((contact) =>
        handContainer.querySelector(`.fretted-3d-pane[data-pane="overview"] .fretted-mirror-target[data-string="${contact.string}"][data-fret="${contact.fret}"]`)),
      'The hand frame and its matching fret targets finish drawing')
      for (const contact of handFrame.hand.contacts) {
        const marker = handContainer.querySelector(`.fretted-3d-pane[data-pane="overview"] .fretted-mirror-target[data-string="${contact.string}"][data-fret="${contact.fret}"]`)
        const markerFrame = handFrame.markers.find((item) =>
          item.position.string === contact.string && item.position.fret === contact.fret)
        const tip = handFrame.hand.mesh.contactTips.find((item) =>
          item.string === contact.string && item.fret === contact.fret)
        check(marker && markerFrame && tip, `The ${contact.finger} 3D finger targets its exact string/fret`)
        const skinGap = Math.hypot(...tip.skinPoint.map((value, axis) =>
          value - tip.surface[axis]))
        check(Math.abs(markerFrame.anchorX - contact.x) < 1 &&
          Math.abs(markerFrame.anchorY - contact.y) < 1 &&
          tip.finger === contact.finger &&
          (contact.barre ? /^(index|middle|ring|pinky)-finger-/.test(tip.skinJoint)
            : tip.skinJoint.endsWith('phalanx-distal') || tip.skinJoint.endsWith('-tip')) &&
          Math.hypot(...tip.surface.map((value, axis) => value - contact.surface[axis])) < 1e-6 &&
          Math.abs(tip.gap - skinGap) < 1e-6 && tip.gap <= 0.008,
        'The assigned distal finger-pad skin, not an unrelated phalanx, contacts each exact string/fret target')
      }
    }
    await exactContacts()
    const rightContact = handFrame.hand.contacts[0]
    const rightContactX = rightContact.x
    const rightCanvasWidth = handContainer.querySelector('.fretted-canvas').width
    const rightAssetSide = handFrame.hand.assetSide
    const leftFrameBefore = await renderHand(singleSong, { handedness: 'left' })
    await until(() => handFrameCount > leftFrameBefore && handFrame?.hand &&
      handFrame.hand.assetSide === 'right' &&
      handContainer.querySelector('.fretted-practice[data-handedness="left"]'),
      'The real right-hand mesh loads for left-handed fretting')
    const leftContact = handFrame.hand.contacts[0]
    check((rightContactX - rightCanvasWidth / 2) * (leftContact.x - rightCanvasWidth / 2) < 0 &&
      leftContact.string === rightContact.string && leftContact.fret === rightContact.fret &&
      Math.hypot(...leftContact.surface.map((value, axis) => value - rightContact.surface[axis])) < 1e-6,
      'Handedness mirrors the display while preserving the exact physical string and fret contact')
    check(rightAssetSide === 'left' && handFrame.hand.assetSide === 'right',
    'Right-handed fretting reports the left-hand rig and left-handed fretting the right-hand rig')
    await exactContacts()
    const chordFrameBefore = await renderHand(barreSong)
    await until(() => handFrameCount > chordFrameBefore && handFrame?.hand?.contacts.length === 6 &&
      handFrame.hand.mesh.rendered,
    'A six-string F barre chord draws its complete 3D suggested hand')
    check(handFrame.hand.fingers.some((finger) => finger.finger === 1 && finger.barre) &&
      handFrame.hand.fingers.some((finger) => finger.finger === 3 && finger.barre) &&
      handFrame.hand.mesh.contactTips.length === 6,
    'The chord shows its authored index/ring barres and all six real pressure points')
    await exactContacts()
    const previewFrameBefore = await renderHand(barreSong, { beat: -0.5, countingIn: true })
    await until(() => handFrameCount > previewFrameBefore && handFrame?.hand?.state === 'preview' &&
      handFrame.hand.mesh.surfaceGap > 0,
    'The next chord hand is shown as a lifted count-in preview')
    check(handFrame.hand.mesh.contactTips.every((contact) => contact.gap > 0.002),
    `An upcoming preview indicates targets without depicting false string contact ${JSON.stringify(
      handFrame.hand.mesh.contactTips.map((contact) => [contact.string, contact.skinJoint, contact.gap]))}`)
    await until(() => /^COUNT-IN · String/.test(nextRow() ?? '') &&
      !handContainer.querySelector('.fretted-mirror-target[data-state="upcoming"]'),
    'The count-in frame draws no upcoming marker and names the first note in the COUNT-IN text')
    check(handContainer.querySelector('.fretted-feedback-key')?.textContent.includes('Finger badges are fingers') &&
      handContainer.querySelector('.fretted-feedback-key')?.textContent.includes('labels marked “Fret N” are frets.'),
    'The count-in cue keeps its plain-language key')
    const openFrameBefore = await renderHand(guitar)
    await until(() => handFrameCount > openFrameBefore && handFrame?.hand?.state === 'relaxed' &&
      handFrame.hand.contacts.length === 0 && handFrame.hand.fingerLabels.length === 0,
    'Open-string practice keeps a relaxed fretting hand without contact claims or finger badges')
    await sleep(100)
    check(handFrame.markers.every((marker) => marker.position.fret > 0) &&
      handFrame.hand.mesh.contactTips.every((contact) => contact.gap > 0.012),
    'Open-only notes never show a pressing hand or an O/open-fret circle')
    const unplayableFrameBefore = await renderHand(unplayableSong)
    await until(() => handFrameCount > unplayableFrameBefore && handFrame?.handUnavailable &&
      handContainer.querySelector('.fretted-hand-guidance[data-unavailable="true"]'),
    'An impossible stretch is explained instead of receiving fabricated anatomy')
    check(handFrame.hand?.state === 'relaxed' && handFrame.hand.contacts.length === 0,
      'An impossible grip keeps the last hand without claiming a fake grip')
    // The fretting hand is drawn on every frame of a lesson that mixes open and fretted notes.
    {
      const mixedNotes = [
        { midi: 40, string: 1, fret: 0, startBeat: 0, beats: 1 },
        { midi: 43, string: 1, fret: 3, finger: 3, startBeat: 1, beats: 1 },
        { midi: 45, string: 2, fret: 0, startBeat: 2, beats: 1 },
        { midi: 48, string: 2, fret: 3, finger: 3, startBeat: 3, beats: 1 },
        { midi: 40, string: 1, fret: 0, startBeat: 4, beats: 1 },
        { midi: 44, string: 1, fret: 4, finger: 4, startBeat: 5, beats: 1 },
        { midi: 50, string: 3, fret: 0, startBeat: 6, beats: 1 },
        { midi: 53, string: 3, fret: 3, finger: 3, startBeat: 7, beats: 1 },
      ]
      const mixedSong = { ...guitar, title: 'Open and fretted notes alternate', bpm: 100, chords: [], chordLabels: [], piano: [],
        instrumentNotes: { ...guitar.instrumentNotes, guitar: mixedNotes } }
      const mixEngine = new Engine(mixedSong)
      mixEngine.countIn = false
      mixEngine.loop = { startBar: 1, endBar: 4 }
      await renderHand(mixedSong, { engine: mixEngine })
      await until(() => handFrame?.hand && !handFrame.handPending, 'The mixed lesson draws its first hand')
      await mixEngine.play()
      await until(() => !mixEngine.starting && mixEngine.read().beat > 0.05, 'The mixed lesson plays')
      const sampled = []
      let seen = handFrameCount
      for (let attempt = 0; sampled.length < 60 && attempt < 1200; attempt++) {
        await sleep(8)
        if (handFrameCount === seen) continue
        seen = handFrameCount
        sampled.push({
          drawn: handFrame.handDrawn, reason: handFrame.handReason, state: handFrame.hand?.state,
          open: handFrame.markers.every((marker) => marker.state !== 'playback'),
          contacts: handFrame.hand?.contacts.length ?? 0, badges: handFrame.hand?.fingerLabels.length ?? 0,
          rendered: handFrame.hand?.mesh.rendered, beat: mixEngine.read().beat,
          plucks: handFrame.plucks.map((pluck) => pluck.x), pickX: handFrame.pick?.x,
          markerX: handFrame.markers.filter((marker) => marker.state === 'playback').map((marker) => marker.anchorX),
        })
      }
      mixEngine.pause()
      check(sampled.length === 60, `Sixty playback frames were sampled (${sampled.length})`)
      check(sampled.every((frame) => frame.drawn && frame.rendered),
        `The fretting hand is drawn on every sampled frame: ${JSON.stringify(sampled.filter((frame) => !frame.drawn).slice(0, 4))}`)
      check(sampled.filter((frame) => frame.open).every((frame) => frame.state !== 'pressed' && frame.contacts === 0 && frame.badges === 0),
        `An open-only frame never presses or claims a finger: ${JSON.stringify(sampled.filter((frame) => frame.open && frame.state === 'pressed').slice(0, 3))}`)
      check(sampled.some((frame) => frame.open) && sampled.some((frame) => !frame.open),
        'The sampled playback includes both open and fretted notes')
      const struck = sampled.filter((frame) => frame.plucks.length && frame.pickX !== undefined)
      check(struck.length > 0 && struck.every((frame) => frame.plucks.every((x) =>
        Math.abs(x - frame.pickX) < handContainer.querySelector('.fretted-canvas').width * 0.06) &&
        frame.markerX.every((x) => frame.plucks.every((px) => Math.abs(x - px) > 30))),
      'The pluck pulse stays at the pick, never at the fretted target')
      mixEngine.dispose()
    }
    // Let-ring arpeggios, as in imported fingerpicking parts: overlapping notes must not take the hand away.
    {
      const openMidi = [40, 45, 50, 55, 59, 64]
      const ring = [[6, 7, 0, 2], [4, 1, 0.5, 2], [6, 0, 1, 1.5], [5, 2, 1.5, 2.5], [6, 5, 2, 2], [3, 0, 2.5, 3],
        [4, 2, 3, 2], [6, 7, 3.5, 1], [2, 0, 4, 4], [5, 1, 4.5, 2.5], [6, 0, 5, 1], [4, 2, 5.5, 2], [3, 3, 6, 2],
        [6, 8, 6.5, 1.5], [4, 1, 7, 1], [5, 3, 7.5, 0.5]]
      const ringSong = { ...guitar, title: 'Let-ring arpeggio', bpm: 80, chords: [], chordLabels: [], piano: [],
        instrumentNotes: { ...guitar.instrumentNotes, guitar: ring.map(([string, fret, startBeat, beats]) => ({
          midi: openMidi[string - 1] + fret, string, fret, startBeat, beats })) } }
      const ringEngine = new Engine(ringSong)
      ringEngine.countIn = false
      ringEngine.loop = { startBar: 1, endBar: 2 }
      await renderHand(ringSong, { engine: ringEngine })
      await until(() => handFrame?.hand && !handFrame.handPending, 'The let-ring song draws its first hand')
      await ringEngine.play()
      await until(() => !ringEngine.starting && ringEngine.read().beat > 0.05, 'The let-ring song plays')
      const sampleRing = async () => {
        const frames = []
        let seen = handFrameCount
        for (let attempt = 0; frames.length < 60 && attempt < 1500; attempt++) {
          await sleep(8)
          if (handFrameCount === seen) continue
          seen = handFrameCount
          frames.push({ drawn: handFrame.handDrawn, rendered: handFrame.hand?.mesh.rendered,
            unavailable: handFrame.handUnavailable, current: handFrame.handCurrent, beat: +ringEngine.read().beat.toFixed(2), reason: handFrame.handReason })
        }
        return frames
      }
      const share = (frames) => frames.filter((frame) => !frame.current).length / frames.length
      // First pass: nothing is cached yet. Second pass over the loop: the poses were solved ahead of time.
      const ringFrames = await sampleRing()
      await sleep(8000)
      const loopedFrames = await sampleRing()
      ringEngine.pause()
      globalThis.__ringBehind = `let-ring frames showing an earlier pose: ${(share(ringFrames) * 100).toFixed(0)}% on the first pass, ${(share(loopedFrames) * 100).toFixed(0)}% once looping`
      check(ringFrames.length === 60 && loopedFrames.length === 60 &&
        [...ringFrames, ...loopedFrames].every((frame) => frame.drawn && frame.rendered),
      `The hand is drawn on every let-ring frame: ${JSON.stringify(ringFrames.filter((frame) => !frame.drawn).slice(0, 3))}`)
      check([...ringFrames, ...loopedFrames].filter((frame) => frame.unavailable).length / 120 < 0.05,
        `No-grip frames stay under 5% (${[...ringFrames, ...loopedFrames].filter((frame) => frame.unavailable).length} of 120; first pass ${ringFrames.filter((frame) => frame.unavailable).length}, looping ${loopedFrames.filter((frame) => frame.unavailable).length}) ${JSON.stringify(loopedFrames.filter((frame) => frame.unavailable).map((frame) => [frame.beat, frame.reason]).slice(0, 6))}`)
      // Poses are solved for the whole coming part of the song ahead of the playhead, so the hand is on the current onset.
      check(share(ringFrames) < 0.1 && share(loopedFrames) < 0.05,
                `The hand shows the current onset's pose: ${globalThis.__ringBehind}`)
      ringEngine.dispose()
    }
    // Remembered choices: a new view, as in another lesson or after a restart, opens as the player left it.
    {
      resetFrettedPrefs()
      handRoot.render(React.createElement(GuitarView, {
        key: 'remember-a', song: singleSong, track: guitar.tracks[0], trackId: 'guitar', beat: 0, playing: false,
        handedness: 'right', onPick() {},
      }))
      await until(() => handContainer.querySelector('.fretted-practice[data-view="guide"]'),
        'A fresh view with no saved choices opens the Finger guide')
      await setPhysicalView(handContainer.querySelector('.fretted-practice'), 'mirror')
      const toggle = (name) => handContainer.querySelector(`[data-mirror-toggle="${name}"]`)
      await until(() => toggle('names') && toggle('guides') && toggle('hands'), 'The mirror toggles appear')
      check(toggle('hands').getAttribute('aria-pressed') === 'true' && toggle('hands').textContent === 'Hands',
        'Hands is on by default')
      toggle('names').click()
      toggle('guides').click()
      toggle('hands').click()
      const look = handContainer.querySelector('[aria-label="Look"]')
      look.value = 'ClayStudyModel'
      look.dispatchEvent(new Event('change', { bubbles: true }))
      await until(() => toggle('hands').getAttribute('aria-pressed') === 'false' &&
        handContainer.querySelector('.fretted-practice').dataset.style === 'ClayStudyModel', 'The choices are applied')
      const stored = loadPrefs()
      check(stored.frettedView === 'mirror' && stored.frettedNames === true && stored.frettedGuides === false &&
        stored.hands === false && stored.frettedLook === 'ClayStudyModel',
      `The view, names, guides, hands and look are saved: ${localStorage.getItem('mizan:practice')}`)
      handRoot.render(React.createElement(GuitarView, {
        key: 'remember-b', song: barreSong, track: guitar.tracks[0], trackId: 'guitar', beat: 0, playing: false,
        handedness: 'right', onPick() {},
      }))
      await until(() => handContainer.querySelector('.fretted-practice[data-view="mirror"]') &&
        toggle('hands'), 'Another lesson opens in the remembered 3D mirror')
      check(toggle('names').getAttribute('aria-pressed') === 'true' &&
        toggle('guides').getAttribute('aria-pressed') === 'false' &&
        toggle('hands').getAttribute('aria-pressed') === 'false' &&
        handContainer.querySelector('.fretted-practice').dataset.style === 'ClayStudyModel',
      'Another lesson keeps the view, string names, guides, hands and look')
      const offBefore = handFrameCount
      await until(() => handFrameCount > offBefore && handFrame && !handFrame.handsVisible && !handFrame.handDrawn &&
        !handFrame.hand && handFrame.handReason === 'off' && handFrame.markers.length > 0,
      'With Hands off the 3D guitar draws no hand, arm or player but keeps its markers')
      check(!handContainer.querySelector('.fretted-practice').textContent.includes('suggested shape'),
        'The hands wording is hidden while Hands is off')
      toggle('hands').click()
      await until(() => handFrame.handsVisible && handFrame.handDrawn && handFrame.hand?.mesh.rendered,
        'Turning Hands back on lazily loads the hand and draws it')
      check(JSON.parse(localStorage.getItem('mizan:practice')).hands === true, 'Turning Hands on is remembered')
      resetFrettedPrefs()
    }
    const outsideNotes = [0, 1, 2].map((index) => ({
      midi: 37, startBeat: index, beats: 0.5,
    }))
    const outsideSong = { ...guitar, title: 'Out-of-range C-sharp notes', piano: [],
      instrumentNotes: { ...guitar.instrumentNotes, guitar: outsideNotes } }
    const outsideFrameBefore = await renderHand(outsideSong)
    await until(() => handFrameCount > outsideFrameBefore &&
      handContainer.querySelector('.fretted-unplaced li[data-reason="outside-range"]'),
    'Repeated out-of-range guitar notes are summarized')
    const outOfRangeGroup = handContainer.querySelector('.fretted-unplaced li[data-reason="outside-range"]')
    const occurrencePicker = outOfRangeGroup.querySelector('select')
    check(handContainer.querySelector('.fretted-unplaced')?.dataset.noteCount === '3' &&
      handContainer.querySelector('.fretted-unplaced')?.dataset.messageCount === '1' &&
      outOfRangeGroup.querySelector('.fretted-unplaced-message')?.textContent.includes('C♯2') &&
      outOfRangeGroup.querySelector('.fretted-unplaced-message')?.textContent.includes('standard guitar range (E2–D6)') &&
      outOfRangeGroup.querySelector('.fretted-unplaced-message')?.textContent.includes('no tuning, octave shift or fret is guessed') &&
      occurrencePicker?.options.length === 4,
    'C-sharp 2 below standard guitar range appears once with its count and all occurrence seeks')
    let pickedRangeBeat = -1
    handRoot.render(React.createElement(GuitarView, {
      key: 'range-seek-check',
      song: outsideSong, track: guitar.tracks[0], trackId: 'guitar', beat: 0, playing: false,
      onPick: (value) => { pickedRangeBeat = value },
    }))
    await until(() => handContainer.querySelector('.fretted-unplaced select') &&
      handContainer.querySelector('.fretted-unplaced select') !== occurrencePicker,
      'The range-note seek choices remain available after rerender')
    const selectableOccurrence = handContainer.querySelector('.fretted-unplaced select')
    selectableOccurrence.value = '1'
    selectableOccurrence.dispatchEvent(new Event('change', { bubbles: true }))
    check(pickedRangeBeat === 1, 'The grouped range explanation still seeks to a chosen occurrence')
    const bassNote = [{ midi: 37, startBeat: 0, beats: 1 }]
    const bassSong = { ...bass, title: 'Bass C-sharp 2', piano: [],
      instrumentNotes: { ...bass.instrumentNotes, bass: bassNote } }
    previousRangeBassFrameHook = globalThis.__mizanBassFrame
    rangeBassHookInstalled = true
    let rangeBassFrame
    let rangeBassFrameCount = 0
    globalThis.__mizanBassFrame = (_canvas, frame) => { rangeBassFrame = frame; rangeBassFrameCount++ }
    const bassFrameBefore = rangeBassFrameCount
    resetFrettedPrefs()
    handRoot.render(React.createElement(BassView, {
      song: bassSong, track: bass.tracks[0], trackId: 'bass', beat: 0, playing: false, onPick() {},
    }))
    await until(() => handContainer.querySelector('.fretted-practice[data-instrument="bass"]'),
      'The bass range fixture opens its teaching view')
    await until(() => handContainer.querySelector('.fretted-finger-dot[data-string="2"][data-fret="4"]'),
      'The default bass guide places C-sharp 2 on the A string at fret 4')
    flatStringsVisible(handContainer.querySelector('.fretted-practice'), 4)
    check(!handContainer.querySelector('.fretted-unplaced'),
      'The flat bass guide does not borrow the six-string guitar range')
    await setPhysicalView(handContainer.querySelector('.fretted-practice'), 'mirror')
    await until(() => rangeBassFrameCount > bassFrameBefore && rangeBassFrame?.hand?.contacts.length === 1 &&
      handContainer.querySelector('.fretted-practice[data-instrument="bass"]'),
    'MIDI 37 is rendered against the four-string bass model')
    check(rangeBassFrame.hand.contacts[0].string === 2 && rangeBassFrame.hand.contacts[0].fret === 4 &&
      !handContainer.querySelector('.fretted-unplaced') &&
      handContainer.querySelector('.fretted-tab-note[data-fret="4"]'),
    'C-sharp 2 is a real fret-4 bass note on A1, not a repeated guitar-range error or octave shift')
    return `Default flat finger guides, optional 3D looks and hand contacts, open strings, compact tab, MIDI routing, playback and loop-clock checks passed. [${globalThis.__ringBehind}]`
  } finally {
    root.unmount()
    container.remove()
    Engine.prototype.selectPart = originalSelect
    if (bassHookInstalled) globalThis.__mizanBassFrame = previousBassFrameHook
    if (guitarHookInstalled) globalThis.__mizanGuitarFrame = previousGuitarFrameHook
    if (handRoot) handRoot.unmount()
    handContainer?.remove()
    globalThis.__mizanGuitarCapture = previousGuitarCapture
    if (handHookInstalled) globalThis.__mizanGuitarFrame = previousHandFrameHook
    if (rangeBassHookInstalled) globalThis.__mizanBassFrame = previousRangeBassFrameHook
  }
}
