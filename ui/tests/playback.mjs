// Run with Vite on localhost:5173: node tests\playback.mjs
// Add --mixer for only the mixer UI and persisted-state checks.
// Add --drums for drum sample decoding and drum-only output/mute/no-events checks.
// Add --charts for chord Shapes layout at wide and compact desktop sizes.
// Add --harmony for melody/chord harmony, unknown-sustain playback and controls.
// Add --delete-score to check confirmation, saved score removal and recording stems in the mock workspace.
// Add --timing for scheduled note onsets and active noteheads at normal and half speed.
// MIZAN_TEST_OPENED optionally points to a live Api.open_song JSON response for the Cairokee benchmark.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { analysisChecks, vocalChecks } from './vocal-analysis.mjs'
import { instrumentChecks } from './instrument-workspace.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const testUrl = process.env.MIZAN_TEST_URL ?? 'http://localhost:5173'
const profile = await mkdtemp(join(process.cwd(), '.mizan-playback-'))
spawn(process.env.MIZAN_TEST_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', 'about:blank',
], { stdio: 'ignore' })
let socket
try {
  let port
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break } catch { await sleep(100) }
  }
  assert.ok(port, 'Edge debugging endpoint started')
  const targets = await (await fetch(`http://localhost:${port}/json/list`)).json()
  socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let sequence = 0
  const pending = new Map()
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) pending.get(message.id)?.finish(message)
    if (message.method === 'Runtime.exceptionThrown') console.error(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
  }
  socket.onclose = () => {
    for (const { method, finish } of [...pending.values()]) {
      finish({ error: { message: `${method}: Browser connection closed` } })
    }
  }
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 120000)
    pending.set(id, { method, finish: (reply) => {
      pending.delete(id)
      clearTimeout(timeout)
      if (reply.error) reject(new Error(JSON.stringify(reply.error)))
      else resolve(reply.result)
    } })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text)
    return result.result.value
  }
  await call('Page.enable')
  await call('Runtime.enable')
  await call('Page.navigate', { url: testUrl })
  for (let i = 0; i < 100; i++) {
    if (await evaluate('!!document.querySelector(".lib-main")')) break
    await sleep(100)
  }
  const drumsOnly = process.argv.includes('--drums')
  const chartsOnly = process.argv.includes('--charts')
  const deleteOnly = process.argv.includes('--delete-score')
  const timingOnly = process.argv.includes('--timing')
  const instrumentOnly = process.argv.includes('--instrument')
  if (instrumentOnly) console.log(await evaluate(`(${instrumentChecks.toString()})()`))
  if (timingOnly) {
    console.log(await evaluate(`(${timingChecks.toString()})()`))
    console.log(await evaluate(`(${activeHeadChecks.toString()})()`))
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    for (const [width, height] of [[1440, 900], [1024, 640]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      for (const noteNames of [false, true]) {
        console.log(await evaluate(`(${scoreVisualChecks.toString()})(${width}, ${noteNames})`))
        if (process.env.MIZAN_TEST_ARTIFACTS) {
          const shot = await call('Page.captureScreenshot', { format: 'png' })
          await writeFile(join(process.env.MIZAN_TEST_ARTIFACTS, `score-${width}-letters-${noteNames}.png`), Buffer.from(shot.data, 'base64'))
        }
        await evaluate('window.__mizanScoreRoot?.unmount(); window.__mizanScoreMount?.remove(); delete window.__mizanScoreRoot; delete window.__mizanScoreMount')
      }
    }
    await call('Emulation.setEmulatedMedia', { features: [] })
  }
  if (deleteOnly) console.log(await evaluate(`(${deleteScoreChecks.toString()})()`))
  if (process.argv.includes('--harmony')) {
    console.log(await evaluate(`(${harmonyChecks.toString()})()`))
  }
  if (!instrumentOnly && !timingOnly && !deleteOnly && !process.argv.includes('--vocals') && !process.argv.includes('--mixer') && !drumsOnly && !process.argv.includes('--harmony')) {
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    for (const [width, height] of [[2000, 1000], [1024, 640]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      console.log(await evaluate(`(${chartChecks.toString()})()`))
      if (process.env.MIZAN_TEST_ARTIFACTS) {
        const shot = await call('Page.captureScreenshot', { format: 'png' })
        await writeFile(join(process.env.MIZAN_TEST_ARTIFACTS, `chart-${width}.png`), Buffer.from(shot.data, 'base64'))
      }
      await evaluate('document.querySelector(".ws-back").click()')
      for (let i = 0; i < 50 && !await evaluate('!!document.querySelector(".song-open")'); i++) await sleep(100)
    }
    await call('Emulation.setEmulatedMedia', { features: [] })
  }
  if (!instrumentOnly && !timingOnly && !deleteOnly && !process.argv.includes('--vocals') && !process.argv.includes('--mixer') && !chartsOnly && !process.argv.includes('--harmony')) {
    console.log(await evaluate(`(${drumChecks.toString()})()`))
  }
  if (!instrumentOnly && !timingOnly && !deleteOnly && !process.argv.includes('--vocals') && !drumsOnly && !chartsOnly && !process.argv.includes('--harmony')) {
    if (!process.argv.includes('--mixer')) {
      console.log(await evaluate(`(${libraryChecks.toString()})()`))
      console.log(await libraryPointerChecks(evaluate, call))
      console.log(await evaluate(`(${engineChecks.toString()})()`))
      if (process.env.MIZAN_TEST_OPENED) {
        const opened = JSON.parse(await readFile(process.env.MIZAN_TEST_OPENED, 'utf8'))
        console.log(await evaluate(`(${realHostChecks.toString()})(${JSON.stringify(opened)})`))
      }
    }
    for (const [width, height] of [[1440, 900], [1024, 640]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      console.log(await evaluate(`(${uiChecks.toString()})(${width}, ${height})`))
      await evaluate('document.querySelector(".track-row:has([aria-label=\\"Solo Vocals\\"]) input").focus()')
      await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
      assert.equal(await evaluate('document.querySelector(".track-row:has([aria-label=\\"Solo Vocals\\"]) input").value'), '0.5', 'Arrow key adjusts volume, not song position')
      await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 })
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 })
      if (process.env.MIZAN_TEST_ARTIFACTS) {
        const shot = await call('Page.captureScreenshot', { format: 'png' })
        await writeFile(join(process.env.MIZAN_TEST_ARTIFACTS, `playback-${width}.png`), Buffer.from(shot.data, 'base64'))
      }
    }
    await call('Page.navigate', { url: testUrl })
    for (let i = 0; i < 100; i++) {
      if (await evaluate('!!document.querySelector(".song-open")')) break
      await sleep(100)
    }
    console.log(await evaluate(`(${persistenceCheck.toString()})()`))
  }
  if (!instrumentOnly && !timingOnly && !deleteOnly && !process.argv.includes('--mixer') && !drumsOnly && !chartsOnly && !process.argv.includes('--harmony')) {
    console.log(await evaluate(`(${vocalChecks.toString()})()`))
    for (const [width, height] of [[1440, 900], [1024, 640]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      console.log(await evaluate(`(${analysisChecks.toString()})()`))
    }
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ id: -1, method: 'Browser.close' }))
    await sleep(1000)
  }
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `
      $all = Get-CimInstance Win32_Process
      $owned = $all | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${profile.replaceAll("'", "''")}') }
      function Stop-TestBrowser([int]$parentId) {
        foreach ($child in ($all | Where-Object ParentProcessId -eq $parentId)) { Stop-TestBrowser $child.ProcessId }
        Stop-Process -Id $parentId -ErrorAction SilentlyContinue
      }
      foreach ($ownedProcess in $owned) { Stop-TestBrowser $ownedProcess.ProcessId }
    `], { stdio: 'ignore', timeout: 15000 })
  socket?.close()
  await sleep(1000)
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  console.log('Playback checks finished; test resources removed.')
}

async function timingChecks() {
  const { OpenSheetMusicDisplay } = (await import('/node_modules/.vite/deps/opensheetmusicdisplay.js')).default
  const { buildSong } = await import('/src/workspace/song.ts')
  const { pianoXml } = await import('/src/workspace/musicxml.ts')
  const { Score, measure } = await import('/src/workspace/Score.tsx')
  const { Engine } = await import('/src/workspace/engine.ts')
  const React = (await import('/node_modules/.vite/deps/react.js')).default
  const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
  const check = (value, message) => { if (!value) throw new Error(message) }
  const baseSong = buildSong()
  const host = document.createElement('div')
  host.style.width = '1050px'
  document.body.append(host)
  try {
    const osmd = new OpenSheetMusicDisplay(host, {
      autoResize: false, backend: 'svg', drawTitle: false, drawPartNames: false, pageFormat: 'Endless',
    })
    await osmd.load(pianoXml(baseSong))
    osmd.render()
    const originalLayout = measure(osmd, host)
    const beat = 17.5
    const entry = osmd.GraphicSheet.MeasureList[4][0].staffEntries.find((e) => e.getAbsoluteTimestamp().RealValue * 4 === beat)
    const note = entry.graphicalVoiceEntries.flatMap((v) => v.notes).find((n) => !n.sourceNote.isRest())
    const head = note.getNoteheadSVGs()[note.vfnoteIndex].getBoundingClientRect()
    const noteX = head.left + head.width / 2 - host.getBoundingClientRect().left
    const oldX = originalLayout.bars[4].x + originalLayout.bars[4].inset + 1.5 / 4 * (originalLayout.bars[4].w - originalLayout.bars[4].inset)
    check(Math.abs(oldX - noteX) > 20, `Uneven engraving reproduces the cursor miss (${oldX} vs ${noteX})`)
    const tempoMap = [{ beat: 0, time: 0 }, { beat: 16, time: 8 }, { beat: 17, time: 8.4 }, { beat: 18, time: 9.2 }, { beat: 20, time: 10.2 }]
    const song = {
      ...buildSong(), bars: 5, chords: [], drums: [], vocals: [], tempoMap,
      piano: [
        { midi: 53, startBeat: 15.5, beats: 2, hand: 'left' },
        { midi: 60, startBeat: 16, beats: 0.25, hand: 'right' },
        { midi: 69, startBeat: 16.5, beats: 0.25, hand: 'right' },
        { midi: 72, startBeat: beat, beats: 0.5, hand: 'right' },
        { midi: 76, startBeat: beat, beats: 1, hand: 'right' },
        { midi: 79, startBeat: beat, beats: 2, hand: 'right' },
      ],
    }
    await osmd.load(pianoXml(song))
    osmd.render()
    const c4 = osmd.GraphicSheet.MeasureList[4][0].staffEntries
      .find((entry) => Math.abs(entry.getAbsoluteTimestamp().RealValue * 4 - 16) < 0.001)
      ?.graphicalVoiceEntries.flatMap((voice) => voice.notes)
      .find((note) => note.sourceNote.Pitch?.getHalfTone() === 48)
    check(c4 && c4.sourceNote.Pitch.getHalfTone() + 12 === 60, 'OSMD C4 pitch 48 maps to MIDI 60')
    for (const rate of [1, 0.5]) {
      const engine = new Engine({ ...song, piano: [{ midi: 72, startBeat: beat, beats: 0.5, hand: 'right' }] })
      engine.rate = rate
      engine.countIn = false
      engine.ctx = { currentTime: 0 }
      const sounded = []
      engine.piano = (time) => sounded.push(time)
      engine.startAt(16, false)
      try {
        for (let t = 0; t < 5 && !sounded.length; t += 0.05) {
          engine.ctx.currentTime = t
          engine.schedule()
        }
        check(sounded.length === 1, `Note scheduled once at ${rate}x`)
        engine.ctx.currentTime = sounded[0]
        const read = engine.read().beat
        check(Math.abs(read - beat) < 0.001, `Transport reads the sounding beat at ${rate}x: ${read}`)
        const mount = document.createElement('div')
        mount.className = 'timing-score'
        mount.style.width = '1050px'
        document.body.append(mount)
        const root = createRoot(mount)
        try {
          root.render(React.createElement(Score, {
            xml: pianoXml(song), song, engine, bar: 5, loop: null, confidence: [],
            noteNames: false, instrument: 'piano', playing: true, audioLoading: false, audioError: false,
            onPick: () => {}, previewId: 'piano',
          }))
          for (let i = 0; i < 60 && (!mount.querySelector('.score-osmd .score-head-active') ||
            !mount.querySelector('.score-playhead')?.style.transform); i++) {
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
          const heads = mount.querySelectorAll('.score-osmd .score-head-active')
          check(heads.length === 3, `All three source notes are highlighted at onset at ${rate}x (got ${heads.length}, beat ${engine.read().beat})`)
          const marker = mount.querySelector('.score-playhead')
          const markerRect = marker.getBoundingClientRect()
          const markerX = markerRect.left + markerRect.width / 2
          const headCenters = [...heads].map((head) => {
            const rect = head.getBoundingClientRect()
            return rect.left + rect.width / 2
          }).sort((a, b) => a - b)
          const onsetX = headCenters[Math.floor(headCenters.length / 2)]
          check(Number.isFinite(markerX) && Math.abs(markerX - onsetX) < 4,
            `Score playhead aligns with the active note onset at ${rate}x (${markerX}px vs ${onsetX}px)`)
          for (const [at, expected] of [[18, 2], [18.5, 1], [19.5, 0]]) {
            engine.seek(at)
            await new Promise((resolve) => setTimeout(resolve, 50))
            check(mount.querySelectorAll('.score-osmd .score-head-active').length === expected,
              `Source durations end independently at beat ${at} (${rate}x)`)
          }
        } finally { root.unmount(); mount.remove() }
        engine.seek(17)
        check(Math.abs(engine.read().beat - 17) < 0.001, `Seek updates marker at ${rate}x`)
        engine.loop = { startBar: 5, endBar: 5 }
        engine.seek(19.75)
        engine.ctx.currentTime += engine.seconds(19.75, 20) + 0.08
        engine.schedule()
        check(engine.read().beat >= 16 && engine.read().beat < 17, `Loop wraps marker at ${rate}x`)
      } finally { engine.halt() }
    }
    return `Timing checks passed: old cursor miss ${Math.round(Math.abs(oldX - noteX))}px; C4/MIDI 60 mapping, independent chord-note ends, variable tempo, nonzero start, seek and loop at 1x and 0.5x.`
  } finally { host.remove() }
}

async function activeHeadChecks() {
  const { buildSong } = await import('/src/workspace/song.ts')
  const { pianoXml, instrumentXml } = await import('/src/workspace/musicxml.ts')
  const { Score } = await import('/src/workspace/Score.tsx')
  const React = (await import('/node_modules/.vite/deps/react.js')).default
  const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
  const check = (value, message) => { if (!value) throw new Error(message) }
  const wait = async (test, message) => {
    for (let i = 0; i < 100; i++) {
      if (test()) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(message)
  }
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const base = buildSong()
  const song = {
    ...base,
    bars: 5,
    chords: [{ startBeat: 17.5, beats: 2, symbol: 'C', numeral: 'I', role: 'tonic', tones: [60, 64, 67], flats: false, confidence: 1 }],
    piano: [
      { midi: 53, startBeat: 15.5, beats: 2, hand: 'left' },
      { midi: 57, startBeat: 9, beats: 0.5, hand: 'left' },
      { midi: 60, startBeat: 16, beats: 0.25, hand: 'right' },
      { midi: 69, startBeat: 16.5, beats: 0.25, hand: 'right' },
      { midi: 72, startBeat: 17.5, beats: 0.5, hand: 'right' },
      { midi: 76, startBeat: 17.5, beats: 1, hand: 'right' },
      { midi: 79, startBeat: 17.5, beats: 2, hand: 'right' },
    ],
    vocals: [],
    drums: [],
    instrumentNotes: {},
  }
  let beat = 17.75
  let transportPlaying = true
  let countingIn = false
  const engine = {
    playing: false,
    read: () => ({ beat, playing: transportPlaying, countingIn, countBeat: 0 }),
    audition: async () => {},
  }
  const width = Math.max(320, Math.min(1440, window.innerWidth))
  const mount = document.createElement('div')
  mount.style.cssText = `position:fixed;inset:0 auto auto 0;width:${width}px;height:100vh;overflow:auto;background:#fff;z-index:9999`
  document.body.append(mount)
  const root = createRoot(mount)
  const seeks = []
  const loops = []
  const onPick = (bar, extend) => (extend ? loops : seeks).push(bar)
  let props = {
    xml: pianoXml(song), song, engine, bar: 5, loop: null, confidence: [],
    noteNames: true, instrument: 'piano', playing: true, audioLoading: false, audioError: false,
    onPick, previewId: 'piano',
  }
  const render = (changes = {}) => {
    props = { ...props, ...changes }
    root.render(React.createElement(Score, props))
  }
  const active = () => [...mount.querySelectorAll('.score-osmd .score-head-active')]
  const letters = () => active().flatMap((head) => [...head.querySelectorAll('.head-letter')])
    .map((label) => label.textContent).sort().join('')
  const ready = () => mount.querySelector('.score[aria-busy="false"] .score-osmd svg')
  const waitReady = () => wait(() => !!ready(), 'Score did not finish drawing')
  const move = async (value) => { beat = value; await frame() }
  try {
    render()
    await waitReady()
    await wait(() => active().length === 3, 'Source heads did not activate at the current beat')
    check(active().length === 3 && letters() === 'CEG', `Only the three sounding chord heads are highlighted (got ${active().length}: ${letters()}, error ${mount.querySelector('.view-error')?.textContent ?? 'none'})`)
    check(active().every((head) => head.classList.contains('score-head-hollow')), 'Open heads retain their hollow state')
    check(!mount.querySelector('.score-head-active rect'), 'Active styling never reaches transparent rectangles')
    check(!mount.querySelector('.score-osmd .playing'), 'The full-voice playing class is not used')

    const fHeads = [...mount.querySelectorAll('.head-letter')].filter((label) => label.textContent === 'F')
    check(fHeads.length === 2, 'A tied note has separate rendered heads on each side of the bar')
    await move(16)
    check(letters() === 'CF', 'C4 and the tied bass note are active at their source onsets')
    await move(16.25)
    check(letters() === 'F' && fHeads.filter((label) => label.closest('.score-head-active')).length === 1,
      'A tie hands highlighting to its continuation head across the bar/system')
    await move(17)
    check(letters() === 'F', 'A rest does not receive a highlight while the tied bass note sounds')
    await move(17.5)
    check(active().length === 3 && letters() === 'CEG', 'The tied head clears as the next chord begins')
    await move(18)
    check(active().length === 2 && letters() === 'EG', 'The short chord tone stops at its source duration')
    await move(18.5)
    check(active().length === 1 && letters() === 'G', 'The middle chord tone stops independently')
    await move(19.5)
    check(active().length === 0, 'No source note remains highlighted after its end')

    await move(17.75)
    let writes = 0
    const observer = new MutationObserver((records) => { writes += records.length })
    observer.observe(mount.querySelector('.score-osmd'), { attributes: true, attributeFilter: ['class'], subtree: true })
    await frame()
    observer.disconnect()
    check(writes === 0, 'An unchanged active-head set causes no DOM class writes')

    countingIn = true
    await frame()
    check(active().length === 0, 'Count-in clears active noteheads')
    countingIn = false
    await frame()
    check(active().length === 3, 'Active noteheads return after count-in')
    render({ playing: false })
    await frame()
    check(active().length === 0, 'Pause clears active noteheads')
    transportPlaying = false
    render({ playing: true })
    await frame()
    check(active().length === 0, 'End-of-playback transport state stays clear')
    transportPlaying = true
    render({ audioLoading: true })
    await frame()
    check(active().length === 0, 'Audio loading clears active noteheads')
    render({ audioLoading: false, audioError: true })
    await frame()
    check(active().length === 0, 'Audio errors clear active noteheads')
    render({ audioError: false })
    await frame()
    check(active().length === 3, 'Active noteheads return when playback is ready')

    const bar = mount.querySelector('.score-bar[aria-label="Bar 5"]')
    const chord = mount.querySelector('.score-osmd [data-chord-index="0"]')
    check(bar && chord, 'Bar and chord hit targets are rendered')
    const clickAt = (target, shiftKey = false) => {
      target.scrollIntoView({ block: 'center', inline: 'center' })
      const rect = target.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      const hit = document.elementFromPoint(x, y)
      check(hit && (hit === target || target.contains(hit)),
        `The intended target is topmost at its actual screen coordinate (${target.getAttribute('aria-label') ?? target.className}; hit ${hit?.getAttribute?.('aria-label') ?? hit?.getAttribute?.('class') ?? hit?.tagName}; point ${x},${y}; viewport ${innerWidth}x${innerHeight})`)
      hit.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, shiftKey }))
    }
    clickAt(bar)
    check(seeks.length === 1 && seeks[0] === 5, 'A bar coordinate causes exactly one jump')
    clickAt(bar, true)
    check(seeks.length === 1 && loops.length === 1 && loops[0] === 5, 'Shift-click changes the loop without seeking')
    clickAt(chord)
    check(seeks.length === 2 && seeks[1] === 5, 'A chord coordinate causes exactly one jump')
    chord.focus()
    const selection = window.getSelection()
    selection?.removeAllRanges()
    const range = document.createRange()
    range.selectNodeContents(chord)
    selection?.addRange(range)
    mount.style.width = `${width - 24}px`
    await new Promise((resolve) => setTimeout(resolve, 120))
    await waitReady()
    mount.style.width = `${width}px`
    await new Promise((resolve) => setTimeout(resolve, 120))
    await waitReady()
    check(seeks.length === 2, 'Focus, text selection and resize do not seek')

    const oldHeads = active()
    const track = { id: 'guitar', instrument: 'other', name: 'Guitar', detail: '' }
    const firstGuitar = { ...song, piano: [], instrumentNotes: { guitar: [{ midi: 69, startBeat: 17.5, beats: 1 }] } }
    render({ xml: instrumentXml(firstGuitar, track), song: firstGuitar, instrument: 'other', previewId: 'guitar' })
    await new Promise((resolve) => setTimeout(resolve, 70))
    const latestGuitar = { ...firstGuitar, instrumentNotes: { guitar: [{ midi: 67, startBeat: 17.5, beats: 1 }] } }
    render({ xml: instrumentXml(latestGuitar, track), song: latestGuitar })
    await wait(() => !!ready() && active().length === 1 && letters() === 'G',
      'Latest guitar note did not become active')
    check(oldHeads.every((head) => !head.classList.contains('score-head-active')), 'Track replacement clears classes from old or detached heads')
    check(active().length === 1 && letters() === 'G', 'Rapid track/XML replacement indexes only the latest guitar note')

    const liveHeads = active()
    render({ xml: '<score-partwise><invalid></score-partwise>' })
    await wait(() => !!mount.querySelector('.view-error[role="alert"]'), 'Invalid score should reach its visible error state')
    check(active().length === 0 && liveHeads.every((head) => !head.classList.contains('score-head-active')),
      'A score-load error clears active and detached noteheads')
    root.unmount()
    check(liveHeads.every((head) => !head.classList.contains('score-head-active')), 'Unmount clears active classes')
    return 'Active-head checks passed: chord durations, tied bar continuation, rests, readiness, no-op frame diff, coordinate seeks/loops, latest track load and cleanup.'
  } finally {
    root.unmount()
    mount.remove()
  }
}

async function scoreVisualChecks(width, noteNames) {
  const { buildSong } = await import('/src/workspace/song.ts')
  const { pianoXml } = await import('/src/workspace/musicxml.ts')
  const { Score } = await import('/src/workspace/Score.tsx')
  const React = (await import('/node_modules/.vite/deps/react.js')).default
  const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
  const check = (value, message) => { if (!value) throw new Error(message) }
  const base = buildSong()
  const song = {
    ...base, bars: 5, chords: [], drums: [], vocals: [], instrumentNotes: {},
    piano: [
      { midi: 72, startBeat: 17.5, beats: 0.5, hand: 'right' },
      { midi: 76, startBeat: 17.5, beats: 1, hand: 'right' },
      { midi: 79, startBeat: 17.5, beats: 2, hand: 'right' },
    ],
  }
  const engine = { playing: false, read: () => ({ beat: 17.75, playing: true, countingIn: false, countBeat: 0 }), audition: async () => {} }
  const mount = document.createElement('div')
  mount.style.cssText = `position:fixed;inset:0 auto auto 0;width:${width}px;height:100vh;overflow:auto;background:#fff;z-index:9999`
  document.body.append(mount)
  const root = createRoot(mount)
  try {
    root.render(React.createElement(Score, {
      xml: pianoXml(song), song, engine, bar: 5, loop: null, confidence: [], noteNames,
      instrument: 'piano', playing: true, audioLoading: false, audioError: false,
      onPick: () => {}, previewId: 'piano',
    }))
    for (let i = 0; i < 100 && !mount.querySelector('.score[aria-busy="false"] .score-osmd svg'); i++)
      await new Promise((resolve) => setTimeout(resolve, 50))
    const heads = [...mount.querySelectorAll('.score-osmd .score-head-active')]
    check(heads.length === 3, `${width}px score shows the three active source notes`)
    check(matchMedia('(prefers-reduced-motion: reduce)').matches, 'Reduced-motion preference is active for this capture')
    check(noteNames ? mount.querySelectorAll('.head-letter').length === 3 : mount.querySelectorAll('.head-letter').length === 0,
      `Note letters are ${noteNames ? 'shown' : 'hidden'} at ${width}px`)
    const shape = heads[0].querySelector('path')
    check(shape && getComputedStyle(shape).fill === 'none', 'The active half-note remains hollow')
    check(getComputedStyle(shape).stroke !== 'none', 'The hollow head retains its active outline')
    window.__mizanScoreRoot = root
    window.__mizanScoreMount = mount
    return `Visual fixture ready at ${width}px, note letters ${noteNames ? 'on' : 'off'}, reduced motion on.`
  } catch (error) {
    root.unmount()
    mount.remove()
    throw error
  }
}

async function deleteScoreChecks() {
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  const wait = async (test) => {
    for (let i = 0; i < 100; i++) {
      if (test()) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('Timed out waiting for saved score')
  }
  await wait(() => !!document.querySelector('[aria-describedby="song-s1-meta"]'))
  document.querySelector('[aria-describedby="song-s1-meta"]').click()
  await wait(() => !!document.querySelector('.track-button'))
  document.querySelector('.track-button').click()
  await wait(() => !!document.querySelector('.track-menu'))
  const stems = document.querySelectorAll('.track-stem').length
  assert(stems > 0, `The song has recording stems (${document.querySelector('.track-menu')?.textContent?.slice(0, 240) ?? 'menu closed'})`)
  assert(!document.querySelector('[aria-label="Delete Chords score"]'), 'Creative parts cannot be deleted')
  assert(!document.querySelector('[aria-label="Delete Piano recording"]'), 'Recording stems cannot be deleted')
  let prompt
  window.confirm = (message) => { prompt = message; return false }
  document.querySelector('[aria-label="Delete Piano score"]').click()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert(document.querySelector('[aria-label="Delete Piano score"]'), 'Cancelled deletion keeps score')
  assert(prompt.includes('recording') && prompt.includes('cannot be undone'), 'Confirmation explains deletion scope')
  window.confirm = () => true
  document.querySelector('[aria-label="Delete Piano score"]').click()
  await wait(() => !document.querySelector('[aria-label="Delete Piano score"]'))
  document.querySelector('.track-button').click()
  await wait(() => !!document.querySelector('.track-menu'))
  assert(document.querySelectorAll('.track-stem').length === stems, 'All recording stems remain')
  assert(document.querySelector('[aria-label="Delete Drum kit score"]'), 'Unrelated score stays')
  assert(document.querySelector('[role="menuitemradio"][aria-checked="true"]'), 'A replacement score is selected')
  await wait(() => !JSON.parse(localStorage.getItem('mizan:mixer:s1')).muted.includes('piano'))
  document.querySelector('[aria-label="Back to the library"]').click()
  await wait(() => !!document.querySelector('[aria-describedby="song-s1-meta"]'))
  document.querySelector('[aria-describedby="song-s1-meta"]').click()
  await wait(() => !!document.querySelector('.track-button'))
  document.querySelector('.track-button').click()
  await wait(() => !!document.querySelector('.track-menu'))
  assert(!document.querySelector('[aria-label="Delete Piano score"]'), 'Deleted score stays gone on reopen')
  assert(document.querySelectorAll('.track-stem').length === stems, 'Recording remains after reopen')
  document.querySelector('[aria-label="Delete Drum kit score"]').click()
  await wait(() => !document.querySelector('[aria-label="Delete Drum kit score"]'))
  document.querySelector('.track-button').click()
  await wait(() => !!document.querySelector('.track-menu'))
  assert([...document.querySelectorAll('.track-menu .track-empty')].some((item) =>
    item.textContent.includes('No transcribed score is available')), 'No score remains')
  assert(document.querySelectorAll('.track-stem').length === stems, 'Recording-only song keeps every stem')
  document.querySelector('[aria-label="Back to the library"]').click()
  await wait(() => !!document.querySelector('[aria-describedby="song-s1-meta"]'))
  document.querySelector('[aria-describedby="song-s1-meta"]').click()
  await wait(() => !!document.querySelector('.track-button'))
  document.querySelector('.track-button').click()
  await wait(() => !!document.querySelector('.track-menu'))
  assert([...document.querySelectorAll('.track-menu .track-empty')].some((item) =>
    item.textContent.includes('No transcribed score is available')), 'Empty score persists on reopen')
  assert(document.querySelectorAll('.track-stem').length === stems, 'Recording-only reopen keeps stems')
  return 'Score deletion: cancel, confirmation, remaining score, last score, mixer, recording-only reopen'
}

async function harmonyChecks() {
  const { buildSong, sustainedChords } = await import('/src/workspace/song.ts')
  const { alternatives } = await import('/src/workspace/harmonize.ts')
  const { creativeTracks, HARMONY_DEFAULT } = await import('/src/workspace/creative.ts')
  const { Engine } = await import('/src/workspace/engine.ts')
  const check = (value, message) => { if (!value) throw new Error(message) }
  const base = buildSong()
  const melodyNote = { midi: 61, startBeat: 0, beats: 4, hand: 'right' }
  const exactChoices = alternatives({ ...base, piano: [melodyNote] }, 0, 8).map(({ symbol }) => symbol)
  const fractionalNote = { ...melodyNote, midi: 61.25 }
  const projectedChoices = alternatives({ ...base, piano: [fractionalNote] }, 0, 8).map(({ symbol }) => symbol)
  check(JSON.stringify(projectedChoices) === JSON.stringify(exactChoices) && fractionalNote.midi === 61.25,
    `Fractional lead pitch keeps 12-TET chord clash rankings without changing source MIDI: ${exactChoices} vs ${projectedChoices}`)
  const known = { ...base.chords[0], startBeat: 0, beats: 4 }
  const unknown = { ...known, startBeat: 4, beats: 8, symbol: null, tones: [61, 65, 68], confidence: 0.12 }
  const nc = { ...known, startBeat: 12, beats: 4, symbol: 'N.C.', tones: [] }
  const next = { ...known, startBeat: 16, beats: 4, symbol: 'F', tones: [65, 69, 72] }
  const song = { ...base, bars: 5, chords: [known, unknown, nc, next],
    piano: Array.from({ length: 18 }, (_, i) => ({ midi: 72 + i % 4, startBeat: i, beats: 0.9, hand: 'right' })),
    vocals: [], drums: [] }
  const copied = JSON.stringify(song.chords)
  const held = sustainedChords(song.chords)
  check(held.length === 2 && held[0].beats === 12 && held[1].startBeat === 16,
    'Identified chord sustains through unknown but not across N.C.')
  check(sustainedChords([known, { ...unknown, startBeat: 7 }])[0].beats === 4,
    'Unlabelled gaps are not filled with a supposed chord')
  check(JSON.stringify(song.chords) === copied && song.chords[1].symbol === null,
    'Uncertain chord remains unknown with its original confidence')
  const melody = creativeTracks(song).find((part) => part.id === 'harmony-line')
  const chordLine = creativeTracks(song, { ...HARMONY_DEFAULT, source: 'chords' }).find((part) => part.id === 'harmony-line')
  check(melody.piano.length >= 17 && melody.piano.some((note) => note.startBeat === 8),
    `Melody harmony covers onsets including uncertain-chord measures (${melody.piano.length}/18)`)
  const above = creativeTracks(song, { ...HARMONY_DEFAULT, above: true, interval: 6 }).find((part) => part.id === 'harmony-line')
  const sparse = creativeTracks(song, { ...HARMONY_DEFAULT, sparse: true }).find((part) => part.id === 'harmony-line')
  const withoutKey = creativeTracks({ ...song, key: null }).find((part) => part.id === 'harmony-line')
  const instrumentLead = creativeTracks({ ...song, piano: [], vocals: [],
    instrumentNotes: { 'instrument-organ': [{ midi: 64, startBeat: 0, beats: 1 }] } })
    .find((part) => part.id === 'harmony-line')
  check(instrumentLead.piano.length === 1, 'Harmony follows available instrument notes when vocal and piano leads are absent')
  check(above.piano.length >= 17 && above.piano.every((note, i) => note.midi > song.piano[i].midi),
    'Above/sixths mode follows the lead with high note coverage')
  check(sparse.piano.length === 0 && withoutKey.piano.length >= 17,
    'Long-notes filter and keyless chromatic fallback are usable')
  check(chordLine.piano.length === 14 && chordLine.piano.slice(0, 12).every((note, i) => note.startBeat === i) &&
    chordLine.piano.slice(12).every((note, i) => note.startBeat === 16 + i) &&
    !chordLine.piano.some((note) => note.startBeat >= 12 && note.startBeat < 16),
    'Chord harmony follows source onsets without guessing through no-chord measures')
  const engine = new Engine({ ...song, piano: [] })
  engine.ctx = new AudioContext()
  engine.master = engine.ctx.createGain()
  const sounding = []
  engine.sampleNote = (time, midi, duration, velocity, destination) => sounding.push({ time, midi, duration, velocity, destination })
  engine.pad = (time, tones, duration) => sounding.push({ time, tones, duration })
  engine.events(0, 2, 0, 0.5, false)
  check(sounding.filter(({ tones }) => tones).map(({ time }) => time).join(',') === '0,0.5',
    'Engine chord pads follow the selected accompaniment rhythm')
  sounding.length = 0
  engine.events(10, 10.25, 0, 0.5, true)
  check(sounding.length > 0 && sounding.some(({ tones }) => tones?.includes(60)),
    'Chord playback remains audible near the end of an unknown span, using prior identified pitches')
  sounding.length = 0
  engine.events(11, 11.25, 0, 0.5, true)
  check(sounding.length > 0, 'Seeking into an uncertain hold resumes the sustained chord')
  sounding.length = 0
  engine.events(13, 13.25, 0, 0.5, true)
  check(sounding.length === 0, 'Explicit N.C. is not filled by a guessed chord')
  engine.loadSamples = async () => {}
  engine.trackGains.set('colour', 0.3)
  engine.muted.add('colour')
  await engine.audition(known.tones, 'colour')
  check(sounding.length === 0, 'Muted chord track cannot preview through the master output')
  engine.muted.clear()
  await engine.ctx.suspend()
  await engine.audition(known.tones, 'colour')
  check(engine.ctx.state === 'running' && sounding.length === known.tones.length + 1 &&
    sounding.every((event) => event.destination === engine.buses.get('colour')) &&
    Math.abs(engine.buses.get('colour')?.gain.value - 0.3) < 1e-6,
    `User-activated preview resumes audio context and respects track gain: ${JSON.stringify({
      state: engine.ctx.state, events: sounding.length, bus: !!engine.buses.get('colour'),
      gain: engine.buses.get('colour')?.gain.value,
    })}`)
  sounding.length = 0
  engine.timer = -1
  await engine.audition(known.tones, 'colour')
  engine.timer = 0
  check(sounding.length === 0, 'Preview does not overlap active playback')
  engine.dispose()
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const heard = new Engine({ ...song, piano: [] })
  try {
    await heard.audition(known.tones)
    check(heard.ctx?.state === 'running' && !heard.playing, 'Chord audition starts sound without starting transport')
    const analyser = heard.ctx.createAnalyser()
    heard.master.connect(analyser)
    await sleep(160)
    const wave = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(wave)
    check(wave.some((sample) => Math.abs(sample) > 0.0001), 'Chord preview produces real sample audio on the output bus')
  } finally { heard.dispose() }
  for (let i = 0; i < 50 && !document.querySelector('.song-open'); i++) await sleep(100)
  ;[...document.querySelectorAll('.song-open')].find((button) => button.textContent.includes('Paper Rain')).click()
  for (let i = 0; i < 50 && !document.querySelector('.track-button'); i++) await sleep(100)
  document.querySelector('.track-button').click()
  for (let i = 0; i < 50 && !document.querySelector('.track-menu'); i++) await sleep(100)
  const choose = (name) => {
    const item = [...document.querySelectorAll('.track-item[role="menuitemradio"]')].find((row) => row.querySelector('.track-name')?.textContent === name)
    check(item, `${name} is in the track menu`)
    item.click()
  }
  choose('Harmony line')
  for (let i = 0; i < 50 && !document.querySelector('[aria-label="Follow"]'); i++) await sleep(100)
  const follow = document.querySelector('[aria-label="Follow"]')
  check(follow?.querySelector('[role="radio"][aria-checked="true"]')?.textContent === 'Melody', 'Melody selected by default')
  follow.querySelectorAll('[role="radio"]')[1].click()
  await sleep(50)
  check(document.querySelector('[aria-label="Follow"] [aria-checked="true"]')?.textContent === 'Chords', 'Chord-following option is selectable')
  check(!document.querySelector('.chordview-smooth'), 'Long notes filter hides when following chords')
  document.querySelector('.track-button').click()
  for (let i = 0; i < 50 && !document.querySelector('.track-menu'); i++) await sleep(100)
  choose('Chords')
  for (let i = 0; i < 50 && !document.querySelector('.score-osmd [data-chord-index="1"]'); i++) await sleep(100)
  check(document.querySelectorAll('.score-osmd [data-chord-index]').length >= 30, 'Engraved named chords are interactive')
  document.querySelector('.track-button').click()
  for (let i = 0; i < 50 && !document.querySelector('[aria-label="Unmute Chords"]'); i++) await sleep(100)
  document.querySelector('[aria-label="Unmute Chords"]').click()
  await sleep(80)
  const previews = []
  const host = document.querySelector('.score-osmd')
  let fiber = host[Object.keys(host).find((key) => key.startsWith('__reactFiber$'))]
  while (fiber && fiber.type?.name !== 'Score') fiber = fiber.return
  check(fiber?.memoizedProps.engine, 'Mounted score owns the playback engine')
  const active = fiber.memoizedProps.engine
  const originalAudition = active.audition
  active.audition = async function(tones, id) { previews.push({ tones, id, muted: this.muted.has(id) }) }
  const name = document.querySelector('.score-osmd [data-chord-index="1"]')
  const svgClick = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  svgClick(name)
  check(previews.length === 1 && previews[0].id === 'chords' && !previews[0].muted &&
    previews[0].tones.join(',') === base.chords[1].tones.join(','),
    `Clicking an engraved chord name previews its identified pitches: ${JSON.stringify(previews.map(({ tones, id, muted }) => ({ tones, id, muted })))}`)
  check(name.getAttribute('role') === 'button', 'Engraved chord names are keyboard-accessible')
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  check(previews.length === 2, 'Keyboard activation previews the named chord')
  const originalSeek = active.seek
  const seeks = []
  active.seek = (beat) => seeks.push(beat)
  Object.defineProperty(active, 'playing', { get: () => true, configurable: true })
  svgClick(document.querySelector('.score-osmd [data-chord-index="2"]'))
  check(previews.length === 2 && seeks.at(-1) === base.chords[2].startBeat,
    'Playing name click still seeks to the chord without auditioning')
  delete active.playing
  active.seek = originalSeek
  for (let i = 0; i < 50 && !document.querySelector('[data-mode="shapes"]'); i++) await sleep(100)
  document.querySelector('[data-mode="shapes"]').click()
  for (let i = 0; i < 50 && !document.querySelector('.chart-chord[data-chord-index="1"]'); i++) await sleep(100)
  svgClick(document.querySelector('.chart-chord[data-chord-index="1"] .chart-keys'))
  document.querySelector('.chart-chord[data-chord-index="1"] .chart-name').click()
  check(previews.length === 4 && previews.at(-1).id === 'chords', 'Chart shape and name both preview while paused')
  Object.defineProperty(active, 'playing', { get: () => true, configurable: true })
  active.seek = (beat) => seeks.push(beat)
  document.querySelector('.chart-chord[data-chord-index="2"] .chart-name').click()
  check(previews.length === 4 && seeks.at(-1) === base.chords[2].startBeat,
    'Playing chart click still seeks without interrupting the music')
  delete active.playing
  active.seek = originalSeek
  active.audition = originalAudition
  check(document.querySelector('.chart')?.textContent.includes('—') &&
    !document.querySelector('.chart')?.textContent.includes('Chord unclear') &&
    !document.querySelector('.chart')?.textContent.includes('draft unsure'),
  'Chart marks unidentified chords without repeating warning prose')
  return 'Harmony checks passed: melody coverage, chord following, uncertainty, sustain playback, and paused name/shape preview respecting mixer and playing seeks.'
}

async function drumChecks() {
  const { Engine } = await import('/src/workspace/engine.ts')
  const { buildSong } = await import('/src/workspace/song.ts')
  const check = (value, message) => { if (!value) throw new Error(message) }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const lanes = ['crash', 'ride', 'hihat', 'openhat', 'hightom', 'snare', 'floortom', 'kick']
  const song = {
    ...buildSong(), piano: [], vocals: [], chords: [],
    drums: lanes.map((lane, index) => ({ lane, startBeat: index / 4, velocity: 0.8 })),
  }
  const engine = new Engine(song)
  engine.countIn = false
  const errors = []
  const requests = []
  engine.onError = (message) => errors.push(message)
  const originalFetch = window.fetch
  window.fetch = async (...args) => {
    const response = await originalFetch(...args)
    if (String(args[0]).startsWith('/samples/drums/')) requests.push({ url: String(args[0]), status: response.status })
    return response
  }
  try {
    await engine.play()
    check(errors.length === 0, errors.join('; '))
    check(requests.length === lanes.length && requests.every(({ status }) => status === 200), 'All eight drum sample requests succeed')
    const decoded = lanes.map((lane) => {
      const buffer = engine.drumSamples.get(lane)
      check(buffer, `${lane} decoded`)
      const data = buffer.getChannelData(0)
      const rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length)
      check(rms > 0.0001, `${lane} contains non-silent sample data: ${rms}`)
      return { lane, seconds: buffer.duration, rms }
    })
    const analyser = engine.ctx.createAnalyser()
    engine.master.connect(analyser)
    const data = new Float32Array(analyser.fftSize)
    const peakRms = async (milliseconds) => {
      let peak = 0
      const until = performance.now() + milliseconds
      do {
        await wait(20)
        analyser.getFloatTimeDomainData(data)
        peak = Math.max(peak, Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length))
      } while (performance.now() < until)
      return peak
    }
    engine.seek(0)
    const audible = await peakRms(1500)
    check(audible > 0.001, `Drum-only scheduled output reaches master: ${audible}; context=${engine.ctx.state}`)
    engine.muted.add('drums')
    engine.refreshMix()
    await wait(250)
    engine.seek(0)
    const muted = await peakRms(300)
    check(muted < 0.00001, `Muted Drum kit produces no output: ${muted}`)
    engine.muted.clear()
    engine.trackGains.set('drums', 0)
    engine.refreshMix()
    engine.seek(0)
    const zeroVolume = await peakRms(300)
    check(zeroVolume < 0.00001, `Zero-volume Drum kit produces no output: ${zeroVolume}`)
    engine.trackGains.set('drums', 1)
    engine.refreshMix()
    engine.seek(0)
    const restored = await peakRms(500)
    check(restored > 0.001, `Restored Drum kit produces output: ${restored}`)
    song.drums = []
    engine.seek(0)
    await wait(150)
    const noEvents = await peakRms(300)
    check(noEvents < 0.00001, `A passage without drum events is silent despite loaded samples: ${noEvents}`)
    check(errors.length === 0, errors.join('; '))
    return { drumChecks: 'passed', requests, decoded, outputRms: { audible, muted, zeroVolume, restored, noEvents } }
  } finally {
    window.fetch = originalFetch
    engine.dispose()
  }
}

async function engineChecks() {
  const { Engine } = await import('/src/workspace/engine.ts')
  const { Recording } = await import('/src/workspace/recording.ts')
  const { buildSong } = await import('/src/workspace/song.ts')
  const { creativeTracks } = await import('/src/workspace/creative.ts')
  const check = (value, message) => { if (!value) throw new Error(message) }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const song = buildSong()
  const engine = new Engine(song)
  const errors = []
  engine.onError = (error) => errors.push(error)
  engine.countIn = false
  try {
    await engine.play()
    check(engine.pianoSamples.length === 30 && engine.drumSamples.size === 8, 'All 68 bundled samples decode')
    check(engine.pianoSamples.every((sample) => sample.soft.duration > 0 && sample.loud.duration > 0), 'Piano layers have audio')
    engine.seek(1)
    check(engine.nodes.size > 0, 'Seeking into sustained notes reschedules held piano/chords')
    const oldNodes = [...engine.nodes]
    engine.trackGains.set('piano', 0.4)
    engine.refreshMix()
    check(oldNodes.every((node) => engine.nodes.has(node)), 'Synth volume changes do not cut off notes')
    const analyser = engine.ctx.createAnalyser()
    engine.master.connect(analyser)
    await wait(180)
    const samples = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(samples)
    check(samples.some((sample) => Math.abs(sample) > 0.0001), `Sampled playback produces nonzero audio: ${JSON.stringify({
      context: engine.ctx.state, time: engine.ctx.currentTime, master: engine.master.gain.value,
      transport: engine.read(), nodes: engine.nodes.size,
      buses: [...engine.buses].map(([id, bus]) => [id, bus.gain.value]),
    })}`)
    engine.pause()
    const beat = engine.read().beat
    await wait(100)
    check(engine.read().beat === beat && !engine.playing, 'Pause holds position')
    engine.seek(song.bars * song.beatsPerBar - 0.1)
    await engine.play()
    check(engine.endTimer !== 0, 'End callback was scheduled')
    engine.seek(0)
    await wait(200)
    check(engine.playing, 'Stale end callback cannot stop restarted playback')
    engine.pause()
    const originalLoad = engine.loadSamples.bind(engine)
    let release
    engine.loadSamples = () => new Promise((resolve) => { release = resolve })
    const pending = engine.play()
    engine.pause()
    release()
    await pending
    check(!engine.playing, 'Pause cancels pending sample loading')
    engine.loadSamples = originalLoad
    for (const part of creativeTracks(song).filter((track) => track.chordal)) {
      for (const chord of part.chords.filter((chord) => chord.tones.length)) {
        const notes = part.piano.filter((note) => note.hand === 'right' && note.startBeat >= chord.startBeat && note.startBeat < chord.startBeat + chord.beats)
        check(notes.some((note) => note.startBeat === chord.startBeat), `${part.name} starts each chord`)
        check(Math.max(...notes.map((note) => note.startBeat + note.beats)) === chord.startBeat + chord.beats, `${part.name} covers the full chord span`)
      }
    }
    const aligned = new Engine({ ...song, tempoMap: [{ beat: 0, time: 1 }, { beat: 1.5, time: 1.6 }, { beat: 4, time: 3.6 }] })
    aligned.rate = 0.5
    check(Math.abs(aligned.seconds(0, 4) - 5.2) < 1e-8, 'Tempo map controls transport duration at half speed')
    check(Math.abs(aligned.recordingTime(2) - 2) < 1e-8, 'Tempo map interpolates fractional beats')
    const one = new Engine({ ...song, tempoMap: [{ beat: 0, time: 2 }] })
    check(one.recordingTime(2) > 2, 'Single-point alignment advances beyond its anchor')
    let rejected = false
    try { new Engine({ ...song, tempoMap: [{ beat: 0, time: 1 }, { beat: 0, time: 2 }] }) } catch { rejected = true }
    check(rejected, 'Malformed tempo map fails explicitly')
    const stems = [
      { id: 'vocals', label: 'Phase A', level: 1, url: '/samples/piano/A4-v5.ogg' },
      { id: 'guitar', label: 'Phase B', level: 1, url: '/samples/piano/A4-v5.ogg' },
    ]
    const recording = new Recording(engine.ctx, stems, engine.master)
    let toneUrl
    try {
      await recording.prepare(new Set(), new Map())
      const wave = await (await fetch(recording.media.src)).arrayBuffer()
      const mixed = await engine.ctx.decodeAudioData(wave.slice(0))
      const source = await engine.ctx.decodeAudioData(await (await fetch(stems[0].url)).arrayBuffer())
      const data = mixed.getChannelData(0)
      const original = source.getChannelData(0)
      let error = 0
      for (let i = 0; i < Math.min(data.length, original.length); i++) error = Math.max(error, Math.abs(data[i] - original[i]))
      check(error < 0.00005, `Stem mixing is sample-aligned (PCM error ${error})`)
      check(recording.media.preservesPitch, 'Recording preserves pitch')
      // A pure sine distinguishes pitch preservation from the piano's upper harmonics.
      const view = new DataView(wave)
      for (let frame = 0; frame < mixed.length; frame++) {
        const sample = Math.round(6000 * Math.sin(2 * Math.PI * 440 * frame / mixed.sampleRate))
        view.setInt16(44 + frame * 4, sample, true)
        view.setInt16(46 + frame * 4, sample, true)
      }
      toneUrl = URL.createObjectURL(new Blob([wave], { type: 'audio/wav' }))
      const single = new Set(['stem:guitar'])
      await recording.prepare(single, new Map())
      const previous = recording.readyKey
      const releases = []
      recording.decode = () => new Promise((resolve) => releases.push(resolve))
      const pendingMix = recording.prepare(new Set(), new Map())
      await recording.prepare(single, new Map())
      releases.forEach((resolve) => resolve(source))
      await pendingMix
      check(recording.readyKey === previous && recording.media.getAttribute('src') === stems[0].url, 'Rapid mixer reversal cancels stale offline rendering')
    } finally { recording.dispose() }
    const timed = new Engine({
      ...song, bars: 2, piano: [], drums: [], chords: [],
      tempoMap: [{ beat: 0, time: 0 }, { beat: 2, time: 0.8 }, { beat: 4, time: 2.4 }, { beat: 8, time: 4.4 }],
    }, stems.map((stem) => ({ ...stem, url: toneUrl })))
    timed.countIn = false
    timed.onError = (error) => errors.push(error)
    try {
      await timed.play()
      await wait(1300)
      const media = timed.recording.media
      check(Math.abs(media.currentTime - timed.recordingTime(timed.read().beat)) < 0.1, 'Recording follows changing tempo without repeated seeks')
      const analyser = timed.ctx.createAnalyser()
      analyser.fftSize = 8192
      timed.master.connect(analyser)
      const peak = () => {
        const bins = new Float32Array(analyser.frequencyBinCount)
        analyser.getFloatFrequencyData(bins)
        const hz = timed.ctx.sampleRate / analyser.fftSize
        let best = Math.ceil(100 / hz)
        for (let bin = best; bin * hz < 1000; bin++) if (bins[bin] > bins[best]) best = bin
        check(bins[best] > -60, 'Pitch measurement has audible signal')
        return best * hz
      }
      await wait(150)
      const normalPitch = peak()
      check(Math.abs(normalPitch - 440) < 10, 'Recording starts at the reference pitch')
      timed.rate = 0.5
      timed.refresh()
      await wait(400)
      check(media.playbackRate === 0.5 && Math.abs(peak() - normalPitch) < 12, 'Half-speed recording retains measured piano pitch')
      check(Math.abs(media.currentTime - timed.recordingTime(timed.read().beat)) < 0.1, 'Half-speed recording stays aligned')
      timed.seek(1)
      await wait(180)
      check(Math.abs(media.currentTime - timed.recordingTime(timed.read().beat)) < 0.1, 'Playing seek keeps recording and score together')
      timed.pause()
      const stopped = media.currentTime
      await wait(100)
      check(media.paused && Math.abs(media.currentTime - stopped) < 0.001, 'Recording pauses with score')
      timed.rate = 1
      timed.loop = { startBar: 1, endBar: 1 }
      timed.countIn = false
      timed.seek(3.5)
      await timed.play()
      timed.countIn = true
      await wait(650)
      check(timed.read().countingIn && media.paused, `Loop count-in silences the recording: ${JSON.stringify(timed.read())}; paused=${media.paused}; time=${media.currentTime}; cursor=${timed.cursorBeat}; counting=${timed.counting}`)
      await wait(1600)
      check(timed.playing && !media.paused && timed.read().beat < 4, 'Loop restarts the aligned recording after count-in')
      timed.muted.add('stem:guitar')
      timed.refreshMix()
      await wait(200)
      const timer = timed.timer
      timed.trackGains.set('stem:vocals', 0.45)
      timed.refreshMix()
      check(timed.timer === timer && !timed.starting, 'Single-stem volume does not restart playback')
    } finally { timed.dispose(); URL.revokeObjectURL(toneUrl) }
    const leadIn = new Engine({
      ...song, piano: [], drums: [], chords: [], tempoMap: [{ beat: 2, time: 0 }, { beat: 6, time: 2 }],
    }, [stems[0]])
    leadIn.countIn = false
    try {
      await leadIn.play()
      await wait(150)
      check(leadIn.recording.media.paused, 'Recording waits during score lead-in before its first aligned beat')
      leadIn.seek(2)
      await wait(150)
      check(!leadIn.recording.media.paused, 'Seeking past the lead-in starts recording at its alignment')
    } finally { leadIn.dispose() }
    check(errors.length === 0, errors.join('; '))
    return 'Audio checks passed: 68 samples, audible output, held notes, transport cancellation, tempo map, full chord spans, sample-aligned mix.'
  } finally { engine.dispose() }
}

async function chartChecks() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const check = (value, message) => { if (!value) throw new Error(message) }
  const until = async (selector) => {
    for (let i = 0; i < 50; i++) {
      const element = document.querySelector(selector)
      if (element) return element
      await wait(100)
    }
    throw new Error(`Chord chart did not render ${selector}: ${document.body.innerText.slice(0, 900)}`)
  }
  await until('.song-open')
  const open = [...document.querySelectorAll('.song-open')].find((button) => button.textContent.includes('Paper Rain'))
  if (!open) throw new Error('Paper Rain is missing from the library')
  const libraryRow = open.closest('.song')
  const action = libraryRow.querySelector('.song-actions').getBoundingClientRect()
  const when = libraryRow.querySelector('.song-when').getBoundingClientRect()
  check(action.left >= open.getBoundingClientRect().right - 1, 'Song actions do not intrude into the song information')
  check(!when.width || when.right <= action.left + 1, 'Song time does not overlap the reprocess action')
  open.click()
  const title = await until('.ws-song')
  const originalTitle = title.textContent
  check(title.title === originalTitle, 'Full song title is available on hover')
  title.textContent = 'Mohamed Mohsen - Eslamy Ya Misr (Official Video Clip) موسيقى مصرية طويلة جدا من أجل التمرين'.repeat(4)
  const where = document.querySelector('.ws-where')
  check(title.scrollWidth > title.clientWidth, 'Long title is truncated')
  check(title.getBoundingClientRect().right < where.getBoundingClientRect().left, 'Long title does not overlap the bar position')
  title.textContent = originalTitle
  ;(await until('.track-button')).click()
  await until('.track-menu')
  const chords = [...document.querySelectorAll('.track-item[role="menuitemradio"]')].find((item) => item.querySelector('.track-name')?.textContent === 'Chords')
  if (!chords) throw new Error(`Chords track is missing: ${[...document.querySelectorAll('.track-name')].map((item) => item.textContent).join(', ')}`)
  chords.click()
  ;(await until('[data-mode="shapes"]')).click()
  await until('.chart-bar')
  const chart = document.querySelector('.score.chart')
  chart.scrollTop = 0
  const sheet = document.querySelector('.chart-sheet').getBoundingClientRect()
  const row = document.querySelector('.chart-row')
  const columns = getComputedStyle(row).gridTemplateColumns.split(' ').filter((width) => parseFloat(width) > 1).length
  const expectedColumns = Math.floor((Math.min(chart.clientWidth, 1600) - 64 - 2) / 176)
  const bars = [...row.querySelectorAll('.chart-bar')].map((bar) => bar.getBoundingClientRect())
  check(Math.abs(sheet.width - Math.min(chart.clientWidth, 1600)) <= 1, `Chart sheet fills available width up to 1600px: ${sheet.width}/${chart.clientWidth}`)
  check(bars.length === 4, `Intro has four bars, got ${bars.length}`)
  check(columns === Math.min(expectedColumns, bars.length),
    `Expected ${Math.min(expectedColumns, bars.length)} occupied columns, got ${columns}`)
  check(bars.every((bar) => bar.width >= 176), 'Chord shapes have enough room in each bar')
  check([...document.querySelectorAll('.chart-keys')].every((keys) =>
    keys.parentElement.getBoundingClientRect().width >= keys.getBoundingClientRect().width - 1),
  'Keyboard graphics fit within their chord items')
  check(!document.querySelector('.chart-keys path'), 'Chord keyboards show only keys and circled notes')
  check(bars.every((bar, index) => Math.abs(bar.top - bars[0].top) <= 1 && (index === 0 || bar.left > bars[index - 1].left)), 'All four Intro bars appear side by side')
  check(chart.scrollWidth === chart.clientWidth, 'Chord chart has no horizontal overflow')
  return { chartChecks: 'passed', viewport: innerWidth, sheetWidth: sheet.width, columns, introBarsInFirstRow: bars.length }
}

async function libraryPointerChecks(evaluate, call) {
  for (const [width, height] of [[1440, 900], [1024, 640]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await sleep(100)
    const points = await evaluate(`(() => {
      const song = [...document.querySelectorAll('.song')].find(e => e.textContent.includes('Rosanna'));
      song.scrollIntoView({block:'center',behavior:'instant'});
      const source = song.querySelector('.song-title').getBoundingClientRect();
      const folder = [...document.querySelectorAll('.folder-link')].find(e => e.textContent.includes('New practice'));
      const target = folder.getBoundingClientRect();
      return {source:{x:source.x+source.width/2,y:source.y+source.height/2},
        target:{x:target.x+target.width/2,y:target.y+target.height/2}};
    })()`)
    const start = async () => {
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...points.source })
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...points.source, button: 'left', buttons: 1, clickCount: 1 })
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...points.target, button: 'left', buttons: 1 })
      await sleep(50)
    }
    const release = () => call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...points.target, button: 'left', buttons: 0, clickCount: 1 })
    await start()
    assert.ok(await evaluate('document.querySelector(".song-drag-preview")?.textContent.includes("Rosanna")'), 'Pointer movement shows the actual dragged song')
    assert.ok(await evaluate('document.querySelector(".folder-item[data-drop]")?.textContent.includes("New practice")'), 'Pointer target is visible, hit-testable and highlighted')
    await release()
    await sleep(100)
    assert.ok(await evaluate('document.querySelector(".folder-feedback")?.textContent.includes("already in New practice")'), 'Pointer release handles duplicate membership')
    assert.ok(await evaluate('!!document.querySelector(".lib-main") && !document.querySelector(".song-drag-preview")'), 'Dragging a song title does not click/open it')
    await start()
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await release()
    assert.ok(await evaluate('!!document.querySelector(".lib-main") && !document.querySelector(".song-drag-preview")'), 'Escape cancels the pointer gesture without opening the song')
  }
  return 'Library pointer checks passed: real browser pointer capture, target highlighting, duplicate feedback, click suppression and Escape at both sizes.'
}

async function libraryChecks() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const check = (value, message) => { if (!value) throw new Error(message) }
  const until = async (predicate) => {
    for (let i = 0; i < 50; i++) {
      if (predicate()) return
      await wait(100)
    }
    throw new Error(`Library did not update: ${document.body.innerText.slice(0, 900)}`)
  }
  document.querySelector('.folder-add').click()
  await until(() => document.querySelector('.folder-new input'))
  document.querySelector('.folder-new input').value = 'New practice'
  document.querySelector('.folder-new button').click()
  await until(() => [...document.querySelectorAll('.folder-item[data-user]')].some((item) => item.textContent.includes('New practice')))
  const folder = [...document.querySelectorAll('.folder-item[data-user]')].find((item) => item.textContent.includes('New practice'))
  folder.querySelector('.folder-link').click()
  await until(() => document.querySelector('.songs-empty'))
  check(document.querySelector('.songs-empty')?.textContent.includes('Browse all songs'), 'Empty folder explains how to add songs')
  document.querySelector('.songs-empty button').click()
  await until(() => [...document.querySelectorAll('.song')].some((item) => item.textContent.includes('Rosanna')))
  const song = [...document.querySelectorAll('.song')].find((item) => item.textContent.includes('Rosanna'))
  check(song && song.querySelector('.song-grip').getBoundingClientRect().left >= song.getBoundingClientRect().left, 'Drag handle remains inside the row')
  const dataTransfer = new DataTransfer()
  dataTransfer.setData('application/x-mizan-song', song.dataset.songId)
  folder.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }))
  folder.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
  await until(() => folder.textContent.includes('1') && document.querySelector('.folder-feedback')?.textContent.includes('Added Rosanna'))
  folder.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
  await until(() => document.querySelector('.folder-feedback')?.textContent.includes('already in New practice'))
  folder.querySelector('.folder-link').click()
  check(document.querySelector('.song-list')?.textContent.includes('Rosanna'), 'Dropped song is available in its folder')
  document.querySelector('.folder-link').click()
  await until(() => document.querySelectorAll('.song').length > 1)
  const scroll = document.querySelector('.lib-main')
  const lastSong = [...document.querySelectorAll('.song')].at(-1)
  lastSong.scrollIntoView({ block: 'center' })
  const navTop = document.querySelector('.folder-nav').getBoundingClientRect().top
  const headerBottom = document.querySelector('.lib-head').getBoundingClientRect().bottom
  check(scroll.scrollTop > 0 && navTop >= headerBottom, `Folder targets remain visible when the song list scrolls (${scroll.scrollTop}, ${navTop}, ${headerBottom})`)
  scroll.scrollTop = 0
  return 'Library checks passed: actionable empty folder, handle in row, folder drop persisted, duplicate drop explained.'
}

async function uiChecks(width, height) {
  const check = (value, message) => { if (!value) throw new Error(message) }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const button = (label) => [...document.querySelectorAll('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent.trim() === label)
  const click = async (label) => { const target = button(label); check(target, `Found ${label}: ${document.body.innerText.slice(0,1000)}`); target.click(); await wait(100) }
  if (!document.querySelector('.ws')) {
    for (let i = 0; i < 50 && !document.querySelector('.song-open'); i++) await wait(100)
    const open = [...document.querySelectorAll('.song-open')].find((element) => element.textContent.includes('Paper Rain'))
    check(open, 'Library has a song to open')
    open.click()
    await wait(600)
  }
  check(document.querySelector('.track-button'), 'Workspace opened')
  if (!document.querySelector('.track-menu')) { document.querySelector('.track-button').click(); await wait(100) }
  const menu = document.querySelector('.track-menu')
  const bounds = menu.getBoundingClientRect()
  check(bounds.left >= 0 && bounds.right <= width && bounds.bottom <= height, 'Mixer fits the viewport')
  await click('Solo Chords')
  const drumScore = [...document.querySelectorAll('.track-item[role="menuitemradio"]')].find((element) => element.textContent.includes('Drum kit'))
  check(drumScore, 'Drum score is available')
  drumScore.click()
  await wait(100)
  check(!document.querySelector('.track-menu'), 'Choosing a score closes the mixer')
  check(document.querySelector('.track-button .track-name').textContent === 'Drum kit (muted)', 'Closed mixer identifies the selected score as muted')
  check(document.querySelector('.track-button .track-detail').textContent === 'Chords solo: Synth only', 'Closed mixer names the actual solo, not just the selected score')
  document.querySelector('.track-button').click()
  await wait(100)
  check(button('Solo Chords').getAttribute('aria-checked') === 'true', 'Choosing the drum score preserves the Chords solo')
  check(button('Unmute Drum kit') && button('Unmute Drums'), 'Synth drums and isolated recording drums remain distinct and muted')
  await click('Original only')
  check(document.querySelector('.track-button .track-detail').textContent === 'Full recording only', 'Original preset clears the solo and restores the full recording')
  const rows = [...document.querySelectorAll('.track-stem')]
  check(rows.length > 1, 'Host recording stems reach the mixer')
  const full = rows.find((row) => row.textContent.includes('Full mix'))
  check(full && !full.hasAttribute('data-muted'), 'Original preset plays full mix')
  check(rows.filter((row) => row !== full).every((row) => row.hasAttribute('data-muted')), 'Original preset does not double isolated stems')
  const vocal = rows.find((row) => row.textContent.includes('Vocals'))
  vocal.querySelector('.track-mute').click()
  await wait(100)
  check(full.hasAttribute('data-muted') && !vocal.hasAttribute('data-muted'), 'Unmuting isolation mutes full recording')
  await click('Solo Vocals')
  await click('Solo Vocals')
  check(!vocal.hasAttribute('data-muted') && full.hasAttribute('data-muted'), 'Solo restores prior mute state')
  const slider = vocal.querySelector('input')
  slider.focus()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(slider, '0.45')
  slider.dispatchEvent(new Event('input', { bubbles: true }))
  slider.dispatchEvent(new Event('change', { bubbles: true }))
  await wait(100)
  // Solo state and its restoration snapshot must survive reopening the song.
  await click('Solo Vocals')
  check(vocal.querySelector('.track-solo').getAttribute('aria-checked') === 'true', 'Solo is explicitly selected')
  const source = button('Synth only')
  source.click()
  await wait(100)
  check(rows.every((row) => row.hasAttribute('data-muted')), 'Synth preset mutes all recording stems')
  document.querySelector('.track-button').click()
  const countIn = [...document.querySelectorAll('.toggle')].find((element) => element.textContent.includes('Count-in'))
  if (countIn?.getAttribute('aria-pressed') === 'true') { countIn.click(); await wait(100) }
  await click('Play')
  for (let i = 0; i < 100 && document.querySelector('[role="status"]'); i++) await wait(100)
  await wait(200)
  check(button('Pause'), `Sample playback starts from transport: ${document.querySelector('.play')?.getAttribute('aria-label')}; ${document.querySelector('.audio-error')?.textContent}`)
  await click('Pause')
  check(button('Play'), 'Transport pauses')
  document.querySelector('.track-button').click()
  await wait(100)
  await click('Solo Vocals')
  const stored = Object.keys(localStorage).filter((key) => key.startsWith('mizan:mixer:')).map((key) => JSON.parse(localStorage.getItem(key)))
  check(stored.some((value) => value.soloId === 'stem:vocals' && value.beforeSolo), 'Mixer persists solo and restore state')
  check(stored.some((value) => value.volumes['stem:vocals'] === 0.45), 'Mixer persists recording volume')
  document.querySelector('[aria-label="Solo Vocals"]').scrollIntoView({ block: 'nearest' })
  return `UI checks passed at ${width}x${height}: mixer bounds, original/synth, mute/solo, playback and persistence.`
}

async function persistenceCheck() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const open = [...document.querySelectorAll('.song-open')].find((element) => element.textContent.includes('Paper Rain'))
  if (!open) throw new Error('Library reload failed')
  open.click()
  await wait(500)
  document.querySelector('.track-button').click()
  await wait(100)
  const solo = document.querySelector('[aria-label="Solo Vocals"]')
  if (solo?.getAttribute('aria-checked') !== 'true') throw new Error('Solo did not persist across reload')
  if (document.querySelector('.track-row:has([aria-label="Solo Vocals"]) input').value !== '0.45') throw new Error('Volume did not persist')
  solo.click()
  await wait(100)
  const stems = [...document.querySelectorAll('.track-stem')]
  if (!stems.every((row) => row.hasAttribute('data-muted'))) throw new Error('Restored solo unexpectedly enabled recording stems')
  document.querySelector('.ws-back').click()
  await wait(500)
  const imported = [...document.querySelectorAll('.song-open')].find((element) => element.textContent.includes('Take Five'))
  imported.click()
  await wait(500)
  document.querySelector('.track-button').click()
  await wait(100)
  const original = [...document.querySelectorAll('button')].find((element) => element.textContent === 'Original only')
  if (!original.disabled || document.querySelectorAll('.track-stem').length || !document.querySelector('.track-empty')) throw new Error('No-recording fallback failed')
  if (JSON.parse(localStorage.getItem('mizan:mixer:s3')).soloId) throw new Error('Mixer state leaked between songs')
  return 'Reload/fallback checks passed: saved volume, solo, prior mutes, and independent no-recording song.'
}

async function realHostChecks(opened) {
  const { Engine } = await import('/src/workspace/engine.ts')
  const { fromHost } = await import('/src/library/adapt.ts')
  const check = (value, message) => { if (!value) throw new Error(message) }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  check(opened.ok && opened.stems?.length === 7, 'Host exposes full mix and all six real stems')
  for (const stem of opened.stems) {
    const response = await fetch(stem.url, { headers: { Range: 'bytes=0-63' } })
    check(response.status === 206, `${stem.label} supports cross-origin range playback`)
    const header = await response.arrayBuffer()
    check(header.byteLength === 64 && new TextDecoder().decode(header.slice(0, 4)) === 'RIFF', `${stem.label} returns actual WAV data`)
  }
  const song = fromHost(opened.song)
  const engine = new Engine(song, opened.stems)
  engine.countIn = false
  engine.muted = new Set([...song.tracks.map((track) => track.id), 'stem:mix'])
  const errors = []
  engine.onError = (error) => errors.push(error)
  try {
    const started = performance.now()
    await engine.play()
    const prepareSeconds = (performance.now() - started) / 1000
    check(!errors.length && engine.playing, `Real six-stem playback starts: ${errors.join('; ')}`)
    const buffers = await Promise.all([...engine.recording.buffers.values()])
    check(buffers.length === 6 && buffers.every((buffer) => buffer.length === buffers[0].length), 'All six real stems decode to the same sample timeline')
    check(Math.abs(buffers[0].duration - 276.08530612244897) < 0.001, 'Real recording duration is preserved')
    engine.seek(100)
    const analyser = engine.ctx.createAnalyser()
    engine.master.connect(analyser)
    await wait(400)
    const output = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(output)
    check(output.some((sample) => Math.abs(sample) > 0.001), 'Real mixed stems produce audible WebAudio output')
    let maxDrift = 0
    for (const id of ['vocals', 'guitar', 'piano', 'mix']) {
      engine.pause()
      engine.muted = new Set([
        ...song.tracks.map((track) => track.id),
        ...opened.stems.filter((stem) => stem.id !== id).map((stem) => `stem:${stem.id}`),
      ])
      engine.seek(100)
      await engine.play()
      await wait(300)
      const media = engine.recording.media
      check(!media.paused && media.readyState >= 2, `Real ${id} URL plays through WebAudio`)
      engine.rate = 0.5
      engine.refresh()
      await wait(300)
      const drift = Math.abs(media.currentTime - engine.recordingTime(engine.read().beat))
      maxDrift = Math.max(maxDrift, drift)
      check(drift < 0.12 && media.playbackRate === 0.5 && media.preservesPitch, `${id} remains aligned at half speed (${drift}s)`)
      engine.rate = 1
    }
    engine.pause()
    check(engine.recording.media.paused && !engine.playing, 'Real host media stops with transport')
    check(errors.length === 0, errors.join('; '))
    return `Real host integration passed: seven cross-origin range URLs; six full-length aligned stems; vocals/guitar/quiet piano/full mix playback; half-speed max drift ${maxDrift.toFixed(3)}s; initial six-stem preparation ${prepareSeconds.toFixed(2)}s.`
  } finally { engine.dispose() }
}
