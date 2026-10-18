export async function compactPracticeLayoutChecks(mode) {
  const { default: React } = await import('/node_modules/.vite/deps/react.js')
  const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js')
  const { Workspace } = await import('/src/workspace/Workspace.tsx')
  const { Engine } = await import('/src/workspace/engine.ts')
  const { buildSong } = await import('/src/workspace/song.ts')
  const { savePref } = await import('/src/workspace/prefs.ts')
  const check = (value, message) => { if (!value) throw new Error(message) }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const container = document.createElement('div')
  container.style.cssText = 'position:fixed;inset:0;z-index:100;overflow:hidden'
  document.body.append(container)
  const root = ReactDOM.createRoot(container)
  const originalSelect = Engine.prototype.selectPart
  const engines = new Set()
  let engine
  const capture = globalThis.__mizanKitCapture
  let cleaned = false
  Engine.prototype.selectPart = function (id) {
    engine = this
    engines.add(this)
    return originalSelect.call(this, id)
  }
  globalThis.__mizanPracticeLayoutCleanup = () => {
    if (cleaned) return
    cleaned = true
    root.unmount()
    container.remove()
    Engine.prototype.selectPart = originalSelect
    for (const item of engines) item.dispose()
    if (capture === undefined) delete globalThis.__mizanKitCapture
    else globalThis.__mizanKitCapture = capture
    delete globalThis.__mizanPracticeLayoutCleanup
  }
  const find = (selector) => container.querySelector(selector)
  const until = async (predicate, message) => {
    for (let i = 0; i < 400; i++) {
      if (predicate()) return
      await sleep(25)
    }
    throw new Error(`${message}: ${container.textContent.slice(0, 240)}`)
  }
  check(mode === 'guitar' || mode === 'drums', `Unknown compact layout mode: ${mode}`)
  globalThis.__mizanKitCapture = true
  localStorage.removeItem('mizan:practice')
  for (const [key, value] of Object.entries({
    countIn: true, click: true, sticking: true, guitarView: 'fretboard',
    drumsView: 'kit', frettedView: 'mirror', hands: false,
  })) savePref(key, value)
  const guitar = { id: 'guitar', instrument: 'other', name: 'Electric guitar', detail: 'Melodic part' }
  const drums = { id: 'drums', instrument: 'drums', name: 'Drum kit', detail: 'Drum part' }
  const base = buildSong()
  const tracks = mode === 'guitar' ? [guitar, drums] : [drums, guitar]
  const song = {
    ...base,
    title: 'Compact layout check',
    bars: 32,
    sections: [{ name: 'Practice', startBar: 1, bars: 32 }],
    chords: [],
    piano: [],
    vocals: [],
    tracks,
    instrumentNotes: {
      guitar: Array.from({ length: 32 }, (_, bar) => ({
        midi: 60 + bar % 7, startBeat: bar * 4, beats: 1,
      })),
    },
    drums: ['kick', 'snare', 'hihat', 'openhat', 'crash', 'ride'].map((lane, index) => ({
      trackId: 'drums', lane, startBeat: index * 0.5, velocity: 0.8,
    })),
  }
  root.render(React.createElement(Workspace, {
    song, songId: `compact-layout-${mode}`, defaults: { guitar: 'fretboard', drums: 'kit', click: true },
    start: { bar: 1, rate: 1, loop: null, muted: [], solo: [], trackId: tracks[0].id },
  }))
  await until(() => find('.ws') && engine?.song === song, `${mode} workspace opens`)

  if (mode === 'guitar') {
    await until(() => find('.fretted-practice[data-view="mirror"] .fretted-tab-staff'),
      'The guitar fretboard and tab render')
    const input = find('#goto')
    check(input, 'Go to input is present')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '21')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.closest('form').requestSubmit()
    await until(() => find('.fretted-tab-heading .fretted-bar-nav span')?.textContent === 'Bar 21 of 32',
      'Go to selects bar 21')
    const bounds = () => {
      const group = find('.fretted-tab-measure[data-bar="21"]')
      const marks = group && [...group.children]
        .filter((child) => !child.classList.contains('fretted-active-bar'))
        .map((child) => child.getBoundingClientRect())
        .filter((rect) => rect.width || rect.height)
      const target = marks?.length ? {
        left: Math.min(...marks.map((rect) => rect.left)),
        top: Math.min(...marks.map((rect) => rect.top)),
        right: Math.max(...marks.map((rect) => rect.right)),
        bottom: Math.max(...marks.map((rect) => rect.bottom)),
      } : null
      const scroll = find('.fretted-tab-scroll')?.getBoundingClientRect()
      const foot = find('.ws-foot')?.getBoundingClientRect()
      const practice = find('.fretted-practice')
      return { target, scroll, foot, practice }
    }
    const visible = () => {
      const { target, scroll, foot } = bounds()
      return target && scroll && foot && target.left >= scroll.left - 1 &&
        target.right <= scroll.right + 1 && target.bottom <= foot.top - 1
    }
    try {
      await until(visible, 'Bar 21 notation clears the playback bar')
    } catch (error) {
      const { target, scroll, foot, practice } = bounds()
      throw new Error(`${error.message}; geometry=${JSON.stringify({
        target, scroll: scroll?.toJSON(), foot: foot?.toJSON(),
        practice: practice && { rect: practice.getBoundingClientRect().toJSON(),
          scroll: [practice.scrollHeight, practice.clientHeight, practice.scrollTop] },
      })}`, { cause: error })
    }
    const { target, scroll, foot } = bounds()
    return `Go to bar 21 stays in the tab viewport and clears the playback bar: ${JSON.stringify({
      target, scroll: scroll.toJSON(), foot: foot.toJSON(),
    })}`
  }

  await until(() => find('.practice-kit .kit-legend .kit-pill'), 'The drum legend renders')
  const chips = [...container.querySelectorAll('.practice-kit .kit-legend .kit-pill')]
  const controls = [...container.querySelectorAll('.ws-foot .transport-tools .toggle')]
    .filter((button) => ['Loop', 'Count-in', 'Click', 'Sticking'].includes(
      button.querySelector('.toggle-label')?.textContent))
  check(chips.length >= 4, `Drum legend has enough chips to wrap: ${chips.length}`)
  check(controls.length === 4, `Loop, Count-in, Click and Sticking controls are present: ${controls.length}`)
  const overlaps = chips.flatMap((chip) => controls
    .filter((button) => {
      const a = chip.getBoundingClientRect()
      const b = button.getBoundingClientRect()
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
    })
    .map((button) => `${chip.textContent.trim()} overlaps ${button.querySelector('.toggle-label')?.textContent}`))
  check(overlaps.length === 0, `Drum legend chips do not cover playback controls: ${overlaps.join('; ')}`)
  await sleep(250)
  return `Drum legend chips stay separate from Loop, Count-in, Click and Sticking at 571x499: ${chips.length} chips checked.`
}
