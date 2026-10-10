// Run with Vite on localhost:5173: node tests\playback.mjs
// Add --mixer for only the mixer UI and persisted-state checks.
// Add --drums for drum sample decoding and drum-only output/mute/no-events checks.
// Add --charts for chord Shapes layout at wide and compact desktop sizes.
// Add --harmony for melody/chord harmony, unknown-sustain playback and controls.
// Add --delete-score to check confirmation, saved score removal and recording stems in the mock workspace.
// Add --timing for scheduled note onsets and active noteheads at normal and half speed.
// Add --scroll-follow to check score follow visibility only.
// Add --meter to check changing-meter engraving and workspace navigation.
// MIZAN_TEST_OPENED optionally points to a live Api.open_song JSON response for the Cairokee benchmark.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { analysisChecks, vocalChecks } from './vocal-analysis.mjs'
import { instrumentChecks } from './instrument-workspace.mjs'
import { browserMeterChecks } from './meter.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const testUrl = process.env.MIZAN_TEST_URL ?? 'http://localhost:5173'
const profile = await mkdtemp(join(process.cwd(), '.mizan-playback-'))
spawn(process.env.MIZAN_TEST_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', 'about:blank',
], { stdio: 'ignore' })
let socket
let onBinding
try {
  let port
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break } catch { await sleep(100) }
  }
  assert.ok(port, 'Edge debugging endpoint started')
  // A managed browser can open its own pages (such as a sync dialog) first: use the blank tab this run opened.
  let blank
  for (let attempt = 0; attempt < 50 && !blank; attempt++) {
    const targets = await (await fetch(`http://localhost:${port}/json/list`)).json()
    for (const target of targets) if (target.type === 'page' && target.url.startsWith('edge://')) await fetch(`http://localhost:${port}/json/close/${target.id}`)
    blank = targets.find((target) => target.type === 'page' && target.url === 'about:blank')
    if (!blank) await sleep(100)
  }
  assert.ok(blank, 'The browser opened its blank tab')
  socket = new WebSocket(blank.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let sequence = 0
  const pending = new Map()
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) pending.get(message.id)?.finish(message)
    if (message.method === 'Runtime.exceptionThrown') console.error(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
    if (message.method === 'Runtime.bindingCalled') onBinding?.(message.params)
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
  // The test tab must be the visible one, or animation frames (and so drawing) pause.
  await call('Page.bringToFront')
  await call('Page.navigate', { url: testUrl })
  for (let i = 0; i < 100; i++) {
    if (await evaluate('!!document.querySelector(".lib-main")')) break
    await sleep(100)
  }
  const drumsOnly = process.argv.includes('--drums')
  const chartsOnly = process.argv.includes('--charts')
  const deleteOnly = process.argv.includes('--delete-score')
  const timingOnly = process.argv.includes('--timing')
  const scrollOnly = process.argv.includes('--scroll-follow')
  const instrumentOnly = process.argv.includes('--instrument')
  const meterOnly = process.argv.includes('--meter')
  const readabilityOnly = process.argv.includes('--cairokee-readability')
  const courseOnly = process.argv.includes('--course')
  const pianoOnly = process.argv.includes('--piano')
  if (pianoOnly) {
    console.log(await evaluate(`(${pianoAudioChecks.toString()})()`))
    const artifacts = process.env.MIZAN_TEST_ARTIFACTS
    if (artifacts) {
      // The page asks for a screenshot by name; the capture happens here, beside the running check.
      await call('Runtime.addBinding', { name: 'mizanShot' })
      onBinding = async ({ name, payload }) => {
        if (name !== 'mizanShot') return
        const shot = await call('Page.captureScreenshot', { format: 'png' })
        await writeFile(join(artifacts, `piano-${payload}.png`), Buffer.from(shot.data, 'base64'))
      }
    }
    for (const [width, height, mobile, scale] of [[1440, 900, false, 1], [1024, 640, false, 2], [617, 900, false, 1.5], [390, 844, true, 3]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile })
      await call('Page.navigate', { url: testUrl })
      for (let i = 0; i < 100 && !await evaluate('!!document.querySelector(".lib-tabs")'); i++) await sleep(100)
      if (artifacts) await evaluate('window.__mizanPianoShot = (name) => { window.mizanShot(name); return new Promise((resolve) => setTimeout(resolve, 700)) }')
      console.log(await evaluate(`(${pianoChecks.toString()})(${width})`))
    }
  }
  if (courseOnly) {
    console.log(await evaluate(`(${backingChecks.toString()})()`))
    for (const [width, height] of [[1440, 900], [1024, 640]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      console.log(await evaluate(`(${courseChecks.toString()})(${width}, 'session')`))
      // A full reload stands in for an app restart: the saved choices must come back.
      await call('Page.navigate', { url: testUrl })
      for (let i = 0; i < 100 && !await evaluate('!!document.querySelector(".lib-tabs")'); i++) await sleep(100)
      console.log(await evaluate(`(${courseChecks.toString()})(${width}, 'restart')`))
      await call('Page.navigate', { url: testUrl })
      for (let i = 0; i < 100 && !await evaluate('!!document.querySelector(".lib-tabs")'); i++) await sleep(100)
    }
  }
  if (process.argv.includes('--layout')) {
    // The header with a control-heavy track (Harmony line) and the Hands & keys keyboard, narrow to very wide.
    for (const [width, height, scale] of [[617, 978, 1.5], [1440, 900, 1], [2000, 1100, 1]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
      await call('Page.navigate', { url: testUrl })
      for (let i = 0; i < 100 && !await evaluate('!!document.querySelector(".lib-tabs")'); i++) await sleep(100)
      console.log(await evaluate(`(${layoutChecks.toString()})(${width})`))
    }
  }
  if (instrumentOnly) console.log(await evaluate(`(${instrumentChecks.toString()})()`))
  if (meterOnly) console.log(await evaluate(`(${browserMeterChecks.toString()})()`))
  if (readabilityOnly) {
    assert.ok(process.env.MIZAN_TEST_CAIROKEE_ANALYSIS, 'Set MIZAN_TEST_CAIROKEE_ANALYSIS to the read-only saved analysis JSON')
    const raw = JSON.parse(await readFile(process.env.MIZAN_TEST_CAIROKEE_ANALYSIS, 'utf8'))
    await call('Emulation.setDeviceMetricsOverride', { width: 1900, height: 1700, deviceScaleFactor: 1, mobile: false })
    console.log(await evaluate(`(${cairokeeReadabilityChecks.toString()})(${JSON.stringify(raw)})`))
    if (process.env.MIZAN_TEST_ARTIFACTS) {
      const shot = await call('Page.captureScreenshot', { format: 'png' })
      await writeFile(join(process.env.MIZAN_TEST_ARTIFACTS, 'cairokee-readability-comparison.png'),
        Buffer.from(shot.data, 'base64'))
    }
  }
  if (timingOnly) {
    console.log(await evaluate(`(${timingChecks.toString()})()`))
    console.log(await evaluate(`(${activeHeadChecks.toString()})()`))
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    console.log(await evaluate(`(${scrollFollowChecks.toString()})()`))
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    console.log(await evaluate(`(${scrollFollowChecks.toString()})()`))
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
  if (scrollOnly) {
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    console.log(await evaluate(`(${scrollFollowChecks.toString()})()`))
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    console.log(await evaluate(`(${scrollFollowChecks.toString()})()`))
    await call('Emulation.setEmulatedMedia', { features: [] })
  }
  if (deleteOnly) console.log(await evaluate(`(${deleteScoreChecks.toString()})()`))
  if (process.argv.includes('--harmony')) {
    console.log(await evaluate(`(${harmonyChecks.toString()})()`))
  }
  if (!meterOnly && !instrumentOnly && !timingOnly && !scrollOnly && !deleteOnly && !readabilityOnly && !courseOnly && !pianoOnly && !process.argv.includes('--vocals') && !process.argv.includes('--mixer') && !drumsOnly && !process.argv.includes('--harmony')) {
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
  if (!meterOnly && !instrumentOnly && !timingOnly && !scrollOnly && !deleteOnly && !readabilityOnly && !courseOnly && !pianoOnly && !process.argv.includes('--vocals') && !process.argv.includes('--mixer') && !chartsOnly && !process.argv.includes('--harmony')) {
    console.log(await evaluate(`(${drumChecks.toString()})()`))
  }
  if (!meterOnly && !instrumentOnly && !timingOnly && !scrollOnly && !deleteOnly && !readabilityOnly && !courseOnly && !pianoOnly && !process.argv.includes('--vocals') && !drumsOnly && !chartsOnly && !process.argv.includes('--harmony')) {
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
  if (!meterOnly && !instrumentOnly && !timingOnly && !scrollOnly && !deleteOnly && !readabilityOnly && !courseOnly && !pianoOnly && !process.argv.includes('--mixer') && !drumsOnly && !chartsOnly && !process.argv.includes('--harmony')) {
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

async function scrollFollowChecks() {
  const { buildSong } = await import('/src/workspace/song.ts')
  const { pianoXml } = await import('/src/workspace/musicxml.ts')
  const { Score } = await import('/src/workspace/Score.tsx')
  const React = (await import('/node_modules/.vite/deps/react.js')).default
  const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
  const check = (value, message) => { if (!value) throw new Error(message) }
  const waitFor = async (test, message) => {
    for (let i = 0; i < 120; i++) {
      if (test()) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(typeof message === 'function' ? message() : message)
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400))
  const visible = (target, score, inset = 0) => {
    const bar = target.getBoundingClientRect()
    const viewport = score.getBoundingClientRect()
    if (bar.height > viewport.height) return bar.top >= viewport.top && bar.top < viewport.bottom
    return bar.top >= viewport.top + inset && bar.bottom <= viewport.bottom - inset
  }
  const base = buildSong()
  const bars = 32
  const song = {
    ...base,
    bars,
    chords: [],
    drums: [],
    vocals: [],
    sections: [],
    piano: Array.from({ length: bars }, (_, index) => ({
      midi: index < 4 ? 96 : index < 8 ? 36 : 60 + index % 12,
      startBeat: index * base.beatsPerBar, beats: 1, hand: index < 4 ? 'right' : 'left',
    })),
  }
  const xml = pianoXml(song)
  const beatsPerBar = song.beatsPerBar

  for (const height of [200, 360, 820]) {
    const mount = document.createElement('div')
    mount.className = 'ws'
    mount.style.cssText = `position:fixed;top:0;left:0;width:1100px;height:${height}px;grid-template-rows:56px minmax(0,1fr) 64px`
    document.body.append(mount)
    const root = createRoot(mount)
    const engine = {
      beat: 0,
      playing: false,
      read() { return { beat: this.beat, playing: this.playing, countingIn: false } },
      seek(beat) { this.beat = beat },
    }
    const render = (bar, playing = false) => {
      engine.seek((bar - 1) * beatsPerBar)
      engine.playing = playing
      root.render(React.createElement(React.Fragment, null,
        React.createElement('header', { className: 'ws-head' }, 'Fixture header'),
        React.createElement(Score, {
          xml, song, engine, bar, loop: null, confidence: [], noteNames: false, instrument: 'piano',
          playing, audioLoading: false, audioError: false, onPick: () => {}, previewId: 'scroll-fixture',
        }),
        React.createElement('footer', { className: 'ws-foot' }, 'Fixture transport')))
    }
    const score = () => mount.querySelector('.score')
    const barButton = (bar) => mount.querySelector(`.score-bar[aria-label="Bar ${bar}"]`)
    const describe = (bar) => {
      const rect = barButton(bar).getBoundingClientRect()
      const view = score().getBoundingClientRect()
      return { bar: { top: rect.top, bottom: rect.bottom, height: rect.height },
        view: { top: view.top, bottom: view.bottom, height: view.height },
        scrollTop: score().scrollTop, scrollHeight: score().scrollHeight }
    }

    try {
      render(1)
      await waitFor(() => barButton(1) && visible(barButton(1), score()),
        `The score renders with the start bar visible in the ${height}px fixture`)
      const scrollport = score()
      if (height === 200) {
        check(barButton(1).getBoundingClientRect().height > scrollport.getBoundingClientRect().height,
          'The compact fixture has a staff system taller than its score scrollport')
      }
      check(mount.querySelector('.ws-head').getBoundingClientRect().bottom <= scrollport.getBoundingClientRect().top + 1,
        'The score scrollport begins below the header')
      check(scrollport.getBoundingClientRect().bottom <= mount.querySelector('.ws-foot').getBoundingClientRect().top + 1,
        'The score scrollport ends above the transport')

      const targets = [...mount.querySelectorAll('.score-bar')]
      const rowTops = [...new Set(targets.map((target) => Math.round(target.getBoundingClientRect().top)))].sort((a, b) => a - b)
      const rowGaps = rowTops.slice(1).map((top, index) => top - rowTops[index])
      check(new Set(rowGaps).size > 1, 'The fixture contains systems with different vertical spacing')
      const pair = targets.slice(0, -1).map((target, index) => ({
        first: Number(target.getAttribute('aria-label').slice(4)),
        second: Number(targets[index + 1].getAttribute('aria-label').slice(4)),
        top: Math.round(target.getBoundingClientRect().top),
      })).find((candidate, index) =>
        candidate.top === Math.round(targets[index + 1].getBoundingClientRect().top))
      check(pair, 'The fixture contains two bars in one system')

      render(pair.first, true)
      await waitFor(() => visible(barButton(pair.first), scrollport, 1), 'The active bar is visible before manual scrolling')
      if (height > 700) {
        const activeTop = barButton(pair.first).getBoundingClientRect().top
        const nextSystem = targets.find((target) => {
          const rect = target.getBoundingClientRect()
          const view = scrollport.getBoundingClientRect()
          return rect.top > activeTop + 2 && rect.top >= view.top + 24 && rect.bottom <= view.bottom - 24
        })
        check(nextSystem, 'The large fixture keeps a later system visible without scrolling')
        const nextBar = Number(nextSystem.getAttribute('aria-label').slice(4))
        render(nextBar, true)
        const centred = () => {
          const rect = barButton(nextBar).getBoundingClientRect()
          const view = scrollport.getBoundingClientRect()
          const error = (rect.top + rect.bottom) / 2 - (view.top + view.bottom) / 2
          const max = scrollport.scrollHeight - scrollport.clientHeight
          return Math.abs(error) <= 2 || (error < 0 && scrollport.scrollTop <= 1) || (error > 0 && scrollport.scrollTop >= max - 1)
        }
        await waitFor(centred, () => `A later system is centred unless the score is at its start or end (${JSON.stringify(describe(nextBar))})`)
      }

      render(pair.first, true)
      await waitFor(() => visible(barButton(pair.first), scrollport, 1), 'The active bar is visible before the seek')
      await settle()
      scrollport.scrollTo({ top: scrollport.scrollHeight, behavior: 'instant' })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      check(scrollport.scrollTop > 0 && !visible(barButton(pair.first), scrollport),
        `Manual scrolling can move the active bar out of view at ${height}px (scrollTop ${scrollport.scrollTop}, max ${scrollport.scrollHeight - scrollport.clientHeight})`)
      render(pair.second, true)
      await waitFor(() => visible(barButton(pair.second), scrollport, 1),
        () => `Advancing within one system restores the active bar at ${height}px (${JSON.stringify(describe(pair.second))})`)

      scrollport.scrollTo({ top: 0, behavior: 'instant' })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const seekBar = height === 200 ? 24 : bars
      if (height === 200) {
        check(barButton(seekBar).getBoundingClientRect().height > scrollport.getBoundingClientRect().height,
          'The later seek target is taller than the compact score scrollport')
        check(barButton(seekBar).getBoundingClientRect().top >= scrollport.getBoundingClientRect().bottom,
          'The seek target system starts below the oversized-system fixture viewport')
      }
      render(seekBar)
      await waitFor(() => visible(barButton(seekBar), scrollport, 1),
        `Seeking to bar ${seekBar} reveals its current staff at ${height}px`)
      if (height === 200) {
        render(1)
        await waitFor(() => visible(barButton(1), scrollport, 1), 'The compact fixture returns to the first bar')
        await settle()
        const targetTop = barButton(seekBar).getBoundingClientRect().top
        const viewportBottom = scrollport.getBoundingClientRect().bottom
        scrollport.scrollTop += targetTop - viewportBottom + 1
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const nearBottom = barButton(seekBar).getBoundingClientRect()
        const viewport = scrollport.getBoundingClientRect()
        check(nearBottom.top >= viewport.bottom - 2 && nearBottom.top < viewport.bottom,
          'Only one pixel of the oversized target starts inside the viewport')
        render(seekBar)
        await waitFor(() => {
          const target = barButton(seekBar).getBoundingClientRect()
          const view = scrollport.getBoundingClientRect()
          return target.top >= view.top && target.top <= view.top + 13
        }, 'An oversized target with one pixel visible is aligned near the viewport top')
      }
      render(1)
      await waitFor(() => visible(barButton(1), scrollport, 1), `Seeking to the start keeps bar 1 visible at ${height}px`)
    } finally {
      root.unmount()
      mount.remove()
    }
  }
  return 'Playback-follow checks passed: nested header/transport boundaries, centred later system, same-system follow after manual scrolling, and start/end seeks at compact and tall viewports.'
}

async function activeHeadChecks() {
  const { buildSong } = await import('/src/workspace/song.ts')
  const { pianoXml, instrumentXml } = await import('/src/workspace/musicxml.ts')
  const { Score } = await import('/src/workspace/Score.tsx')
  const { Engine } = await import('/src/workspace/engine.ts')
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

    const projectedSong = {
      ...base, bars: 2, chords: [], drums: [], vocals: [], tracks: [],
      piano: [
        { midi: 72, startBeat: 0.46, beats: 0.52, hand: 'right', confidence: 0.4, generated: false },
        { midi: 76, startBeat: 3.96, beats: 0.3, hand: 'right', confidence: 0.4, generated: false },
        { midi: 79, startBeat: 4.25, beats: 0.125, hand: 'right' },
      ],
    }
    const projectedOriginal = structuredClone(projectedSong.piano)
    const projectedAudio = new Engine(projectedSong)
    const scheduled = []
    projectedAudio.piano = (time, note) => scheduled.push({ time, note })
    projectedAudio.events(0, 8, 0, 0.5, false)
    check(JSON.stringify(scheduled.map(({ time }) => time)) === JSON.stringify([0.23, 1.98, 2.125]),
      'the engine still schedules the unprojected source onset times')
    check(JSON.stringify(scheduled.map(({ note }) => note.startBeat)) === JSON.stringify([0.46, 3.96, 4.25]),
      'the engine receives the original source onset beats')
    check(JSON.stringify(projectedSong.piano) === JSON.stringify(projectedOriginal),
      'score rendering never rewrites source notes')
    beat = 0.45
    render({ xml: pianoXml(projectedSong), song: projectedSong, instrument: 'piano', bar: 1, previewId: 'piano' })
    await wait(() => !!ready() && mount.querySelectorAll('.score-osmd .head-letter').length === 4,
      'Projected notation did not finish rendering')
    await frame()
    check(active().length === 0, `Projected notation does not light before its source note is played (${letters()})`)
    await move(0.47)
    check(letters() === 'C', 'The projected notehead lights at its original source onset')
    await move(0.99)
    check(letters() === '', 'The projected notehead stops at its original source offset')
    await move(3.95)
    check(letters() === '', 'A note near the barline does not light before its source onset')
    await move(3.97)
    check(letters() === 'E', 'The barline note lights at the original source onset')
    await move(4.05)
    check(letters() === 'E', 'The tied continuation remains active after the barline')
    await move(4.13)
    check(letters() === 'E', 'The tied note follows its original source duration')
    await move(4.255)
    check(letters() === 'EG', 'The imported fine note retains its independent onset')
    await move(4.38)
    check(letters() === '', 'Both barline and imported notes stop at their source offsets')
    const beforeProjectedClick = seeks.length
    const projectedBar = mount.querySelector('.score-bar[aria-label="Bar 2"]')
    check(projectedBar, 'The projected score keeps its second-bar hit target')
    clickAt(projectedBar)
    check(seeks.length === beforeProjectedClick + 1 && seeks.at(-1) === 2,
      'Clicking the rounded note’s bar seeks to the real bar boundary, not its printed onset')

    const gateSong = {
      ...base, bars: 1, chords: [], drums: [], vocals: [], tracks: [],
      piano: [
        { midi: 60, startBeat: 0.02, beats: 0.125, hand: 'right', confidence: 0.4, generated: false },
        { midi: 62, startBeat: 1.02, beats: 0.95, hand: 'right', confidence: 0.4, generated: false },
      ],
    }
    const gateEngine = new Engine(gateSong)
    const gateEvents = []
    gateEngine.piano = (time, note) => gateEvents.push({ startBeat: note.startBeat, beats: note.beats })
    gateEngine.events(0, 4, 0, 0.5, false)
    check(gateEvents.map(({ startBeat, beats }) => [startBeat, beats]).every(([start, duration], index) =>
      start === gateSong.piano[index].startBeat && duration === gateSong.piano[index].beats),
    'Logical score spacing does not change the source attacks or sounding gates')
    beat = 0
    render({ xml: pianoXml(gateSong), song: gateSong, instrument: 'piano', bar: 1, previewId: 'piano' })
    await wait(() => !!ready() && mount.querySelectorAll('.score-osmd .head-letter').length === 2,
      'Staccato practice notation did not finish rendering')
    await move(0.05)
    check(letters() === 'C', 'A short gate highlights at its source attack')
    await move(0.15)
    check(letters() === '', 'A short gate highlight stops at its original release, before the logical note end')
    await move(1.05)
    check(letters() === 'D', 'The next logical note highlights at its original source attack')

    beat = 17.75
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

async function cairokeeReadabilityChecks(raw) {
  const { fromHost } = await import('/src/library/adapt.ts')
  const { pianoXml } = await import('/src/workspace/musicxml.ts')
  const { OpenSheetMusicDisplay: NamedOSMD } =
    await import('/node_modules/.vite/deps/opensheetmusicdisplay.js')
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const full = fromHost(raw)
  const song = {
    ...full, bars: 4, chords: full.chords.filter((chord) => chord.startBeat < 16),
    piano: full.piano.filter((note) => note.startBeat < 16),
  }
  const before = { ...song, piano: song.piano.map((note) => ({ ...note, generated: true })) }
  const OSMD = NamedOSMD ?? (await import('/node_modules/.vite/deps/opensheetmusicdisplay.js')).default?.OpenSheetMusicDisplay
  check(OSMD, 'OpenSheetMusicDisplay is available for the saved-song comparison')
  const panel = document.createElement('main')
  panel.style.cssText = 'position:fixed;inset:0;width:1800px;min-height:1600px;overflow:auto;background:#fff;color:#171717;padding:24px 48px;box-sizing:border-box;z-index:999999;font:16px Arial,sans-serif'
  const heading = document.createElement('h1')
  heading.textContent = `${raw.title} — first four piano measures`
  heading.style.cssText = 'font-size:28px;margin:0 0 16px'
  panel.append(heading)
  document.body.append(panel)
  const summary = (xml) => {
    const notes = [...xml.matchAll(/<note>([\s\S]*?)<\/note>/g)].map(([, note]) => note)
    const count = (type) => notes.filter((note) => note.includes(`<type>${type}</type>`)).length
    return `32nd ${count('32nd')} · 64th ${count('64th')} · rests ${notes.filter((note) => note.includes('<rest')).length}`
  }
  for (const [label, current] of [['Before', before], ['After', song]]) {
    const section = document.createElement('section')
    section.style.cssText = 'margin:0 0 28px;padding:0 0 18px;border-bottom:1px solid #aaa'
    const caption = document.createElement('h2')
    const xml = pianoXml(current, false)
    caption.textContent = `${label} — ${summary(xml)}`
    caption.style.cssText = 'font-size:20px;margin:0 0 10px'
    const host = document.createElement('div')
    host.style.width = '1650px'
    section.append(caption, host)
    panel.append(section)
    const osmd = new OSMD(host, {
      autoResize: false, backend: 'svg', drawTitle: false, drawPartNames: false, pageFormat: 'Endless',
    })
    await osmd.load(xml)
    osmd.render()
    check(host.querySelector('svg'), `${label} four-measure score rendered`)
  }
  return `Rendered before/after SVG scores for ${raw.title}; ${song.piano.length} source events, source timing unchanged.`
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

async function backingChecks() {
  const { Engine } = await import('/src/workspace/engine.ts')
  const { LESSONS, lessonSong } = await import('/src/course/curriculum.ts')
  const check = (value, message) => { if (!value) throw new Error(message) }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const genre = LESSONS.filter((lesson) => lesson.collection === 'genre')
  check(genre.length === 55 && genre.every((lesson) => lessonSong(lesson).tracks.map((t) => t.id).join() === 'drums,bass,harmony'), 'All 55 genre lessons carry drums, bass and chords')
  const song = lessonSong(LESSONS.find((lesson) => lesson.id === 'genre-funk-phrase'))
  const engine = new Engine(song)
  engine.countIn = false
  const errors = []
  engine.onError = (message) => errors.push(message)
  const calls = []
  const gmNote = engine.gmNote.bind(engine)
  engine.gmNote = (time, midi, duration, velocity, id, program) => { calls.push({ id, time, midi }); return gmNote(time, midi, duration, velocity, id, program) }
  const drum = engine.drum.bind(engine)
  engine.drum = (time, hit, id) => { calls.push({ id, time, beat: hit.startBeat }); return drum(time, hit, id) }
  const requests = []
  const originalFetch = window.fetch
  window.fetch = async (...args) => {
    const response = await originalFetch(...args)
    if (String(args[0]).startsWith('/samples/fluidr3/')) requests.push({ url: String(args[0]), status: response.status })
    return response
  }
  try {
    await engine.play()
    check(errors.length === 0, errors.join('; '))
    const programs = song.tracks.slice(1).map((track) => track.gmProgram)
    check(programs.every((program) => engine.gmSamples.get(program)?.length), `Backing samples decode for GM programs ${programs}`)
    check(requests.length > 0 && requests.every(({ status }) => status === 200), `Backing samples load locally: ${JSON.stringify(requests.map((r) => r.status))}`)
    // One clock: the bass and the drums at beat 0 are scheduled for the same instant; the chords follow at their written offset.
    await wait(200)
    const first = (id) => calls.find((call) => call.id === id)
    const spb = engine.seconds(0, 1)
    const kick = calls.find((call) => call.id === 'drums' && call.beat === 0)
    check(Math.abs(first('bass').time - kick.time) < 1e-6, `Bass and drums share beat 0 (${first('bass').time} vs ${kick.time})`)
    check(Math.abs(first('harmony').time - (kick.time + 0.25 * spb)) < 1e-6, 'The clavinet chop lands on "1 e" by the same clock')
    // Mixer: each part is heard alone, and muting everything is silence.
    const analyser = engine.ctx.createAnalyser()
    engine.master.connect(analyser)
    const data = new Float32Array(analyser.fftSize)
    const peak = async (milliseconds) => {
      let most = 0
      const until = performance.now() + milliseconds
      do {
        await wait(20)
        analyser.getFloatTimeDomainData(data)
        most = Math.max(most, Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length))
      } while (performance.now() < until)
      return most
    }
    const alone = {}
    for (const only of ['drums', 'bass', 'harmony', 'none']) {
      engine.muted = new Set(['drums', 'bass', 'harmony'].filter((id) => id !== only))
      engine.refreshMix()
      await wait(150)
      engine.seek(0)
      alone[only] = await peak(1200)
    }
    check(alone.drums > 0.001 && alone.bass > 0.0005 && alone.harmony > 0.0005 && alone.none < 0.00001, `Each part sounds alone and all-muted is silent: ${JSON.stringify(alone)}`)
    engine.muted = new Set()
    engine.refreshMix()
    // Pause stops every voice, including held bass and chord notes.
    engine.seek(0)
    await wait(400)
    engine.pause()
    await wait(450)
    const paused = await peak(300)
    check(paused < 0.00001 && engine.nodes.size === 0, `Pause silences the backing (${paused}, ${engine.nodes.size} voices)`)
    // Seek and loop: scheduling restarts from the new place on the same clock, and the loop repeats the backing.
    // Bar 8 of the sixteen-bar phrase ends in a fill.
    engine.loop = { startBar: 8, endBar: 8 }
    engine.rate = 0.5
    calls.length = 0
    engine.seek(28)
    await engine.play()
    await wait(200)
    const slow = engine.seconds(0, 1)
    check(Math.abs(slow - 2 * spb) < 1e-6, `Half speed doubles the beat (${slow} vs ${spb})`)
    const bass = calls.filter((call) => call.id === 'bass')
    const drums = calls.filter((call) => call.id === 'drums' && call.beat === 28)
    check(bass.length && drums.length && Math.abs(bass[0].time - drums[0].time) < 1e-6, 'After a seek the bass and drums restart together on bar 8')
    check(bass.every((call) => call.time >= bass[0].time - 1e-9), 'Nothing before the seek point is scheduled')
    const loopBeats = 4 * slow
    await wait(loopBeats * 1000 + 400)
    const again = calls.filter((call) => call.id === 'bass' && Math.abs(call.time - (bass[0].time + loopBeats)) < 1e-6)
    check(again.length === 1, `The loop repeats the bass from bar 8 (${calls.filter((c) => c.id === 'bass').map((c) => c.time.toFixed(3))})`)
    // The fill bar stops the backing at its half bar.
    check(calls.filter((call) => call.id !== 'drums').every((call) => ((call.time - bass[0].time) / slow + 1e-6) % 4 < 2 + 1e-5),
      `The backing rests during the fill (${calls.filter((c) => c.id !== 'drums').map((c) => ((c.time - bass[0].time) / slow).toFixed(3))})`)
    // Changing lesson disposes the old engine: its context closes and its voices stop.
    const ctx = engine.ctx
    engine.dispose()
    await wait(100)
    check(ctx.state === 'closed' && engine.nodes.size === 0, `The old lesson's sound stops (${ctx.state})`)
    check(errors.length === 0, errors.join('; '))
    return `Backing checks passed: 55 lessons with bass and chords; local GM samples ${programs}; one clock with the drums; solo/mute per part ${JSON.stringify(alone)}; ` +
      'pause, seek, half speed, loop and lesson change stop and restart every voice; backing rests for the fill.'
  } finally {
    window.fetch = originalFetch
    engine.dispose()
  }
}

async function pianoAudioChecks() {
  const { Engine } = await import('/src/workspace/engine.ts')
  const { pianoLessonById, pianoLessonSong } = await import('/src/course/piano.ts')
  const check = (value, message) => { if (!value) throw new Error(message) }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const lesson = pianoLessonById('piano-soul-rhythm')
  const run = async (song, seconds = 0.4) => {
    const engine = new Engine(song)
    engine.countIn = false
    const calls = []
    const errors = []
    engine.onError = (message) => errors.push(message)
    const piano = engine.piano.bind(engine)
    engine.piano = (time, note, duration, id) => { calls.push({ id: 'piano', time, note, duration }); return piano(time, note, duration, id) }
    const drum = engine.drum.bind(engine)
    engine.drum = (time, hit, id) => { calls.push({ id: 'drums', time, beat: hit.startBeat }); return drum(time, hit, id) }
    const gmNote = engine.gmNote.bind(engine)
    engine.gmNote = (time, midi, duration, velocity, id, program) => { calls.push({ id, time }); return gmNote(time, midi, duration, velocity, id, program) }
    await engine.play()
    await wait(seconds * 1000)
    check(errors.length === 0, errors.join('; '))
    return { engine, calls }
  }
  const song = pianoLessonSong(lesson)
  const { engine, calls } = await run(song)
  const spb = engine.seconds(0, 1)
  const first = calls.filter((c) => c.id === 'piano' && c.note.startBeat === 0)
  const kick = calls.find((c) => c.id === 'drums' && c.beat === 0)
  const bass = calls.find((c) => c.id === 'bass')
  check(first.length >= 4 && kick && bass && first.every((c) => Math.abs(c.time - kick.time) < 1e-6) && Math.abs(bass.time - kick.time) < 1e-6,
    'Piano, drums and bass start together on the same clock')
  // Under the written sustain pedal (held to beat 5.75) a chord written 1.5 beats long rings on; without pedalling it stops as written.
  const pedalEnd = lesson.pedals[0].startBeat + lesson.pedals[0].beats
  check(first.filter((c) => c.note.hand === 'right').every((c) => Math.abs(c.duration - pedalEnd * spb) < 1e-6),
    `Pedalled chords ring until the pedal lifts (${first.map((c) => (c.duration / spb).toFixed(2))})`)
  engine.dispose()
  const dry = await run({ ...song, pedals: undefined })
  const plain = dry.calls.filter((c) => c.id === 'piano' && c.note.startBeat === 0 && c.note.hand === 'right')
  check(plain.every((c) => Math.abs(c.duration - c.note.beats * spb) < 1e-6), 'Without written pedalling a chord stops as written')
  // The piano mutes on its own; the backing keeps playing; pause silences everything.
  const analyser = dry.engine.ctx.createAnalyser()
  dry.engine.master.connect(analyser)
  const data = new Float32Array(analyser.fftSize)
  const peak = async (milliseconds) => {
    let most = 0
    const until = performance.now() + milliseconds
    do { await wait(20); analyser.getFloatTimeDomainData(data); most = Math.max(most, Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length)) } while (performance.now() < until)
    return most
  }
  const alone = {}
  for (const only of ['piano', 'drums', 'bass', 'none']) {
    dry.engine.muted = new Set(['piano', 'drums', 'bass'].filter((id) => id !== only))
    dry.engine.refreshMix()
    await wait(150)
    dry.engine.seek(0)
    alone[only] = await peak(1200)
  }
  check(alone.piano > 0.0005 && alone.drums > 0.001 && alone.bass > 0.0005 && alone.none < 0.00001, `Each part sounds alone and all-muted is silent: ${JSON.stringify(alone)}`)
  dry.engine.muted = new Set()
  dry.engine.refreshMix()
  dry.engine.seek(0)
  await wait(300)
  dry.engine.pause()
  await wait(450)
  check(await peak(250) < 0.00001 && dry.engine.nodes.size === 0, 'Pause silences the piano and backing')
  dry.engine.dispose()
  return `Piano audio checks passed: one clock for piano, drums and bass; written sustain pedal holds chords to ${pedalEnd} beats, unpedalled music stops as written; per-part mute ${JSON.stringify(alone)}; pause silences.`
}

async function pianoChecks(width) {
  const check = (value, message) => { if (!value) throw new Error(message) }
  const wait = async (test, message, tries = 300) => {
    for (let i = 0; i < tries; i++) {
      if (test()) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(message)
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const where = () => document.querySelector('.ws-where')?.textContent ?? ''
  const bar = () => Number(/Bar (\d+)/.exec(where())?.[1])
  const playButton = () => document.querySelector('.ws-foot .play')
  const piano = () => document.querySelector('.practice-piano')
  const keysBefore = new Set(Object.keys(localStorage))
  await wait(() => document.querySelector('.lib-tabs'), 'The library shows its tabs')
  const tab = document.querySelector('.lib-tabs [data-tab="course"]')
  check(tab.textContent === 'Course263', `The Course tab counts drum and piano lessons: ${tab.textContent}`)
  tab.click()
  await wait(() => document.querySelector('.course-instrument'), 'The course offers an instrument choice')
  const radios = [...document.querySelectorAll('.course-instrument [role="radio"]')]
  check(radios.map((radio) => `${radio.textContent}:${radio.getAttribute('aria-checked')}`).join('|') === 'Drums 130:true|Piano 133:false', `Drums and piano with their counts: ${radios.map((r) => r.textContent)}`)
  radios[0].focus()
  radios[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  await wait(() => document.querySelector('#course-piano') && document.activeElement?.dataset.instrument === 'piano', 'ArrowRight chooses Piano')
  check(document.querySelectorAll('.course-genre-option').length === 11 && document.querySelectorAll('.course-genre-detail .course-lesson').length === 10 &&
    !document.querySelector('#course-title, .course-shelf'), 'Piano lists eleven genres and one genre\'s ten lessons, without the drum lists')
  const pianoShelves = [...document.querySelectorAll('.course-piano-shelf [role="radio"]')]
  check(pianoShelves.map((radio) => `${radio.textContent}:${radio.getAttribute('aria-checked')}`).join('|') === 'Genres 110:true|Inspired 23:false|Progressions 18:false|Scales 15:false',
    `Piano shelves with their counts: ${pianoShelves.map((r) => r.textContent)}`)
  // Inspired: original studies naming their artist and track.
  pianoShelves[1].click()
  // Grouped by artist: the artists listed with their study counts, one artist's studies at a time in learning order.
  await wait(() => document.querySelector('#course-piano-inspired-genres'), 'The inspired studies are grouped by artist')
  const pianoArtists = [...document.querySelectorAll('#course-piano-inspired-genres .course-genre-option')]
  const pianoStudies = pianoArtists.reduce((sum, option) => sum + Number(/\d+/.exec(option.querySelector('.course-genre-note').textContent)[0]), 0)
  check(pianoStudies === 23 && pianoArtists.length >= 10, `Twenty-three inspired studies by ${pianoArtists.length} artists (${pianoStudies})`)
  pianoArtists.find((option) => option.dataset.genre === 'Hans Zimmer').click()
  await wait(() => document.querySelector('.course-genre-detail h3')?.textContent === 'Hans Zimmer' &&
    document.querySelectorAll('.course-genre-detail .course-lesson').length === 9, 'Nine Hans Zimmer studies')
  const zimmerNumbers = [...document.querySelectorAll('.course-genre-detail .course-number')].map((n) => n.textContent).join(',')
  check(zimmerNumbers === '1,2,3,4,5,6,7,8,9', `Numbered in learning order within the artist: ${zimmerNumbers}`)
  // Progressions: a key menu and major or minor; changing the key lists that key's lessons.
  pianoShelves[2].click()
  await wait(() => document.querySelector('#course-piano-tonal') && document.querySelectorAll('.course-steps .course-lesson').length === 9, 'Nine progressions in the key')
  const tonic = document.querySelector('.course-key select')
  tonic.value = '3'
  tonic.dispatchEvent(new Event('change', { bubbles: true }))
  await wait(() => document.querySelector('.course-steps .course-lesson .course-title')?.textContent.includes('in Eb major'), 'Eb major progressions')
  document.querySelector('.course-mode [data-mode="minor"]').click()
  await wait(() => document.querySelector('.course-steps .course-lesson .course-title')?.textContent.includes('in Eb minor'), 'Eb minor progressions')
  check([...document.querySelectorAll('.course-steps .course-style')].every((line) => /^(Heard in|Same chords as) /.test(line.textContent)), 'Each progression\'s description names example songs')
  // Scales: a tonic and one of fifteen scales.
  pianoShelves[3].click()
  await wait(() => document.querySelectorAll('.course-key select').length === 2, 'Tonic and scale menus')
  const scaleMenu = document.querySelectorAll('.course-key select')[1]
  check(scaleMenu.options.length === 15, `Fifteen scales: ${scaleMenu.options.length}`)
  scaleMenu.value = 'dorian'
  scaleMenu.dispatchEvent(new Event('change', { bubbles: true }))
  await wait(() => /^(Eb|D#) Dorian/.test(document.querySelector('.course-steps .course-title')?.textContent ?? ''),
    `Dorian on the chosen tonic: ${document.querySelector('.course-steps .course-title')?.textContent}`)
  pianoShelves[0].click()
  await wait(() => document.querySelector('#course-piano'), 'Back to the genres')
  check([...document.querySelectorAll('.course-lesson, .course-genre-option')].every((button) => button.getBoundingClientRect().right <= innerWidth) &&
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, `Piano rows fit at ${width}px`)
  document.querySelector('.course-genre-option[data-genre="R&B and soul"]').click()
  await wait(() => document.querySelector('.course-genre-detail h3')?.textContent === 'R&B and soul' &&
    document.querySelector('.course-genre-detail .course-genre-facts').textContent.includes('sustain pedal written'), 'R&B and soul shows its lessons and pedalling')
  const open = async (title) => {
    const button = [...document.querySelectorAll('.course-lesson')].find((item) => item.querySelector('.course-title')?.firstChild?.textContent === title)
    check(button, `${title} is listed`)
    button.click()
    await wait(() => document.querySelector('.ws .score-bar[aria-label="Bar 2"]') && document.querySelector('.ws-song')?.textContent === title, `${title} opens`)
  }
  await open('R&B and soul piano: chords on the four beats')
  check(document.querySelector('.track-button')?.textContent.includes('Piano'), `A piano lesson opens on the piano part: ${document.querySelector('.track-button')?.textContent}`)
  check(document.querySelector('.chordview-option[data-view="keyboard"]')?.getAttribute('aria-checked') === 'true', 'The 3D keyboard is the default guide')
  check(document.querySelectorAll('.score-bar').length === 8 && document.querySelector('.lesson-panel')?.textContent.includes('Sustain, changed with each chord'), 'An eight-bar score and lesson panel with its pedalling')
  check(document.querySelector('.lesson-panel').getBoundingClientRect().height < 220 && document.querySelector('.lesson-details') && !document.querySelector('.lesson-details').open,
    `The lesson panel stays compact, details behind a disclosure (${Math.round(document.querySelector('.lesson-panel').getBoundingClientRect().height)}px)`)
  // The score never shows finger numbers (they stay in the written part and on the keyboards).
  await wait(() => document.querySelector('.score-osmd svg'), 'The score is drawn')
  const digits = [...document.querySelectorAll('.score-osmd svg text')].filter((text) => /^[1-5]$/.test(text.textContent.trim())).length
  check(digits < 12, `No finger numbers on the score (${digits} single digits drawn, bar numbers only)`)
  await wait(() => piano()?.dataset.ready === 'true', `The 3D keyboard loads (${piano()?.textContent.slice(0, 120)})`, 600)
  check(piano().dataset.variant === 'stage_piano_88' && piano().dataset.look === 'Realistic' && piano().querySelectorAll('select').length === 1,
    'The stage piano in its realistic look, with only the look to choose')
  check(document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, `The lesson fits ${width}px without sideways scrolling (${document.documentElement.scrollWidth})`)
  const fitted = () => { const [x0, x1, y0, y1] = piano().dataset.frame.split(',').map(Number); return x0 >= -1 && x1 <= 1 && y0 >= -1 && y1 <= 1 && (x1 - x0 > 1.6 || y1 - y0 > 1.6) }
  await wait(() => piano().dataset.framed === 'stage_piano_88:Realistic', 'The keyboard is framed')
  check(fitted(), `Every key fits the stage, the keybed filling its width (${piano().dataset.frame})`)
  // Paused at the top: the keys of the first chord are down, with their written fingers, in their hands' colours.
  await wait(() => piano().dataset.pressed && document.querySelectorAll('.piano-finger').length, 'The first chord is shown down')
  const pressed = piano().dataset.pressed.split(',')
  check(pressed.some((key) => /L5$/.test(key)) && pressed.filter((key) => /R\d$/.test(key)).length >= 3, `Both hands with written fingers: ${pressed}`)
  check(document.querySelectorAll('.piano-finger-right').length >= 3 && document.querySelectorAll('.piano-finger-left').length >= 1, 'Finger numbers over the keys, by hand')
  check(piano().dataset.chord === 'Eb' && piano().dataset.pedal === 'up', `Chord Eb, pedal up before it goes down: ${piano().dataset.chord} ${piano().dataset.pedal}`)
  check(piano().dataset.depressed === '', `Paused, the keys to play are coloured but rest up (${piano().dataset.depressed})`)
  const stage = document.querySelector('.practice-piano .practice-stage').getBoundingClientRect()
  check([...document.querySelectorAll('.piano-finger')].every((label) => {
    const box = label.getBoundingClientRect()
    return box.left >= stage.left - 1 && box.right <= stage.right + 1 && box.top >= stage.top - 1 && box.bottom <= stage.bottom + 1
  }), 'Finger labels sit on the keyboard')
  // Fingering and Note letters are switches: off hides the numbers on the keys (hands keep their colours); letters name the keys down.
  const toggle = (name) => [...document.querySelectorAll('.toggle')].find((button) => button.querySelector('.toggle-label')?.textContent === name)
  check(toggle('Fingering')?.getAttribute('aria-pressed') === 'true' && toggle('Note letters')?.getAttribute('aria-pressed') === 'false', 'Fingering on and Note letters off by default')
  toggle('Fingering').click()
  await wait(() => document.querySelectorAll('.piano-finger').length === 0, 'Fingering off: no numbers on the 3D keyboard')
  check(piano().dataset.pressed && document.querySelector('.kit-hand[data-hand="right"][data-lit]'), 'Fingering off keeps the keys and hands lit')
  toggle('Note letters').click()
  await wait(() => document.querySelectorAll('.piano-letter').length >= 3 && [...document.querySelectorAll('.piano-finger')].every((label) => !/\d/.test(label.textContent)),
    'Note letters on: letters over the keys that are down, without numbers')
  check([...document.querySelectorAll('.piano-letter')].some((letter) => letter.textContent === 'E♭'), `The key's spelling: ${[...document.querySelectorAll('.piano-letter')].map((l) => l.textContent)}`)
  toggle('Fingering').click()
  await wait(() => [...document.querySelectorAll('.piano-finger')].some((label) => /\d/.test(label.textContent) && label.querySelector('.piano-letter')), 'Both on: letters with numbers')
  toggle('Note letters').click()
  await wait(() => document.querySelectorAll('.piano-letter').length === 0 && document.querySelectorAll('.piano-finger').length >= 3, 'Letters off again, numbers back')
  // Playing: frames are drawn, the pedal goes down and the chords change.
  const frames = []
  window.__mizanPianoFrame = (canvas) => {
    const gl = canvas.getContext('webgl')
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(4)
    let varied = 0
    let previous = null
    for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
      gl.readPixels(Math.floor((x + 0.5) * w / 24), Math.floor((y + 0.5) * h / 24), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      const value = px[0] + px[1] + px[2]
      if (previous !== null && Math.abs(value - previous) > 30) varied++
      previous = value
    }
    frames.push({ varied, pedal: piano().dataset.pedal, chord: piano().dataset.chord, pressed: piano().dataset.pressed, upcoming: piano().dataset.upcoming, depressed: piano().dataset.depressed })
  }
  playButton().click()
  await wait(() => bar() === 2, `Playback reaches bar 2 (${where()})`, 900)
  await sleep(1200)
  playButton().click()
  window.__mizanPianoFrame = undefined
  check(frames.length > 10 && frames.every((f) => f.varied > 8), `Every frame draws the keyboard (${frames.length} frames, least detail ${Math.min(...frames.map((f) => f.varied))})`)
  check(frames.some((f) => f.depressed), 'While playing, sounding keys go down')
  await wait(() => piano().dataset.depressed === '', 'Paused again, every key rises')
  const chords = [...new Set(frames.map((f) => f.chord))]
  check(frames.some((f) => f.pedal === 'down') && frames.some((f) => f.upcoming) && chords.includes('Eb') && chords.includes('Cm') && new Set(frames.map((f) => f.pressed)).size >= 2,
    `While playing the pedal goes down, keys glow ahead and the chord and keys change (pedal ${[...new Set(frames.map((f) => f.pedal))]}, ` +
    `upcoming ${frames.filter((f) => f.upcoming).length}, chords ${chords}, pressed ${[...new Set(frames.map((f) => f.pressed))].slice(0, 4).join(' | ')})`)
  // Looks are a view choice: the playhead stays, nothing starts and nothing is stored.
  const at = where()
  const look = piano().querySelector('.kit-look select')
  check([...look.options].map((o) => o.textContent).join('|') === 'Realistic|Hand-painted clay|Neon rhythm|Technical blueprint', 'Four looks')
  const seen = []
  for (const name of ['Realistic', 'ClayStudyModel', 'TechnicalBlueprint', 'NeonRhythm']) {
    look.value = name
    look.dispatchEvent(new Event('change', { bubbles: true }))
    await wait(() => piano().dataset.look === name && piano().dataset.ready === 'true' && piano().dataset.framed === `stage_piano_88:${name}`, `${name} loads`, 600)
    check(fitted() && piano().dataset.depressed === '', `${name}: every key fits and rests while paused (${piano().dataset.frame})`)
    seen.push(name)
    if (window.__mizanPianoShot) await window.__mizanPianoShot(`${width}-stage-${name}`)
  }
  check(seen.length === 4 && where() === at && playButton().getAttribute('aria-label') === 'Play', `All four looks draw without moving playback (${where()} vs ${at})`)  // Blueprint: keys are solid, white keys pale and black keys dark, with nothing under the keybed showing through.
  const samples = []
  window.__mizanPianoFrame = (canvas) => {
    const gl = canvas.getContext('webgl'), px = new Uint8Array(4)
    const read = (midi) => {
      const at = window.__mizanPianoKeyAt(midi)
      gl.readPixels(Math.round(at.x * gl.drawingBufferWidth), Math.round(at.y * gl.drawingBufferHeight), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      return (px[0] + px[1] + px[2]) / 3
    }
    samples.push({ white: [36, 38, 40, 41, 43].map(read), black: [37, 39, 42, 44, 46].map(read) })
  }
  look.value = 'TechnicalBlueprint'
  look.dispatchEvent(new Event('change', { bubbles: true }))
  await wait(() => piano().dataset.look === 'TechnicalBlueprint' && piano().dataset.ready === 'true' && samples.length, 'The blueprint keyboard draws')
  window.__mizanPianoFrame = undefined
  const blueprint = samples.at(-1)
  check(blueprint.white.every((value) => value > 205) && blueprint.black.every((value) => value < 110),
    `Blueprint keys are solid: white ${blueprint.white.map(Math.round)}, black ${blueprint.black.map(Math.round)}`)
  look.value = 'Realistic'
  look.dispatchEvent(new Event('change', { bubbles: true }))
  await wait(() => piano().dataset.look === 'Realistic' && piano().dataset.ready === 'true', 'Back to the default keyboard')
  if (width === 1440) {
    // A lost graphics context shows the flat keyboard; when the device restores it, the 3D keyboard returns by itself.
    const lose = document.querySelector('.practice-piano canvas').getContext('webgl').getExtension('WEBGL_lose_context')
    lose.loseContext()
    await wait(() => piano().dataset.lost === 'true' && piano().querySelector('.practice-hands') && piano().dataset.ready === 'false', 'Context loss shows the flat keyboard')
    lose.restoreContext()
    await wait(() => !piano().dataset.lost && piano().dataset.ready === 'true' && !piano().querySelector('.practice-hands'), 'The 3D keyboard returns when the context is restored')
    const back = []
    window.__mizanPianoFrame = () => back.push(1)
    document.querySelector('.ws .score-bar[aria-label="Bar 1"]').click()
    await wait(() => back.length > 0 || bar() === 1, 'The restored keyboard draws again')
    window.__mizanPianoFrame = undefined
  }
  // The backing is in the mixer with the piano, each part on its own.
  document.querySelector('.track-button').click()
  await wait(() => document.querySelector('.track-menu'), 'The track menu opens')
  check(['Piano', 'Drum kit', 'Bass (fingered)'].every((name) => document.querySelector(`[aria-label="Mute ${name}"]`)), 'Piano, drums and bass are each in the mixer')
  // The selected part leads the mix by 2 dB: the others are turned down, never the selected one boosted.
  {
    let fiber = document.querySelector('.score-osmd')[Object.keys(document.querySelector('.score-osmd')).find((key) => key.startsWith('__reactFiber$'))]
    while (fiber && fiber.type?.name !== 'Score') fiber = fiber.return
    const engine = fiber?.memoizedProps.engine
    const lead = 10 ** (-2 / 20)
    check(engine?.selectedPart === 'piano' && Math.abs(engine.level('piano') - 1) < 1e-6 && Math.abs(engine.level('drums') - lead) < 1e-6 && Math.abs(engine.level('bass') - lead) < 1e-6,
      `The piano leads: piano ${engine?.level('piano')}, drums ${engine?.level('drums')}, bass ${engine?.level('bass')}`)
  }
  document.querySelector('.track-button').click()
  // Hands & keys: the same clock-driven glow and pulse in the flat keyboard; paused it is steady, and it names what it shows.
  document.querySelector('.chordview-option[data-view="hands"]').click()
  await wait(() => document.querySelector('.practice-hands'), 'Hands & keys shows')
  const hands = () => document.querySelector('.practice-hands')
  const said = () => hands().querySelector('.visually-hidden').textContent
  await wait(() => /^Paused\. Notes to play at the playhead: /.test(said()) && /finger/.test(said()), `Paused, it names the notes to play with their written fingers: ${said()}`)
  const flat = []
  const sample = () => {
    const canvas = hands().querySelector('canvas'), context = canvas.getContext('2d')
    flat.push({ said: said(), counting: !!playButton().dataset.counting, pixels: [...context.getImageData(0, 0, canvas.width, canvas.height).data.filter((_, i) => i % 97 === 0)].join() })
  }
  playButton().click()
  // Through the count-in (slow at this speed) and well into the music.
  for (let i = 0; i < 300 && flat.filter((f) => !f.counting && /^Sounding now: /.test(f.said)).length < 25; i++) { sample(); await sleep(80) }
  playButton().click()
  check(flat.some((f) => /^Sounding now: /.test(f.said)) && !flat.some((f) => /^Sounding now: /.test(f.said) && f.counting),
    'Playing, it says what sounds now, never during the count-in')
  check(new Set(flat.map((f) => f.pixels)).size >= 4, `The flat keyboard animates while playing (${new Set(flat.map((f) => f.pixels)).size} distinct frames)`)
  await wait(() => /^Paused\. /.test(said()), 'Paused again, it says so')
  const still = []
  for (let i = 0; i < 6; i++) { still.push(hands().querySelector('canvas').getContext('2d').getImageData(0, 0, 40, 40).data.join()); await sleep(80) }
  check(new Set(still).size === 1, 'Paused, nothing pulses')
  // Hands & keys keeps piano proportions: the range grows by octaves to fill the width instead of stretching a few keys.
  const [low, high, keyWidth] = hands().dataset.range.split(/[-:]/).map(Number)
  const canvasWidth = hands().querySelector('canvas').getBoundingClientRect().width
  check(keyWidth >= 14 && keyWidth <= 43 && high - low >= 23 && (high - low >= 87 || canvasWidth - keyWidth * [...Array(high - low + 1).keys()].filter((k) => ![1, 3, 6, 8, 10].includes((low + k) % 12)).length < keyWidth * 13),
    `Hands & keys keys keep their shape and fill the width (${hands().dataset.range} in ${Math.round(canvasWidth)}px)`)
  // Fingering off hides the numbers on the flat keyboard; Note letters names the keys down and the ones coming next.
  const switchFor = (name) => [...document.querySelectorAll('.toggle')].find((button) => button.querySelector('.toggle-label')?.textContent === name)
  switchFor('Fingering').click()
  await wait(() => hands().dataset.fingers === '' && /Finger numbers are off/.test(hands().textContent), 'Fingering off: no numbers on Hands & keys')
  switchFor('Note letters').click()
  await wait(() => hands().dataset.letters, 'Note letters on: the keys at the playhead are named')
  const lettered = []
  playButton().click()
  for (let i = 0; i < 200 && !lettered.some((l) => l.includes(':next')); i++) { lettered.push(hands().dataset.letters); await sleep(40) }
  playButton().click()
  check(lettered.some((l) => l.includes(':next')) && lettered.some((l) => /\d+:[A-G][♭♯]?(,|$)/.test(l)), `Letters on the keys sounding and the keys coming next (${lettered.filter(Boolean).slice(-2).join(' | ')})`)
  check(hands().dataset.fingers === '', 'Still no numbers while playing with Fingering off')
  // Next and Previous keep the guide the player chose (here Hands & keys), each lesson from the top and stopped.
  const view = () => document.querySelector('.chordview-option[aria-checked="true"]')?.dataset.view
  const fresh = (guide) => bar() === 1 && playButton().getAttribute('aria-label') === 'Play' && view() === guide &&
    document.querySelector('.track-button')?.textContent.includes('Piano')
  document.querySelector('.lesson-nav button:last-child').click()
  await wait(() => document.querySelector('.ws-song')?.textContent === 'R&B and soul piano: repeated eighth-note chords', 'The next piano lesson opens')
  await wait(() => fresh('hands') && hands() && !piano(), `Next keeps Hands & keys, on the piano part, at bar 1, stopped (${view()})`)
  check(switchFor('Fingering').getAttribute('aria-pressed') === 'false' && switchFor('Note letters').getAttribute('aria-pressed') === 'true', 'Next keeps Fingering off and Note letters on')
  switchFor('Fingering').click()
  switchFor('Note letters').click()
  await wait(() => switchFor('Fingering').getAttribute('aria-pressed') === 'true' && switchFor('Note letters').getAttribute('aria-pressed') === 'false', 'Back to the defaults')
  document.querySelector('.lesson-nav button:first-child').click()
  await wait(() => document.querySelector('.ws-song')?.textContent === 'R&B and soul piano: chords on the four beats', 'The previous piano lesson opens')
  await wait(() => fresh('hands') && hands(), `Previous keeps Hands & keys (${view()})`)
  document.querySelector('.chordview-option[data-view="score"]').click()
  await wait(() => view() === 'score' && !hands() && !piano(), 'Score on its own')
  document.querySelector('.lesson-nav button:last-child').click()
  await wait(() => document.querySelector('.ws-song')?.textContent === 'R&B and soul piano: repeated eighth-note chords', 'The next piano lesson opens again')
  await wait(() => fresh('score') && !hands() && !piano(), `Next keeps the score on its own (${view()})`)
  // Leaving the lessons forgets the choice: the next lesson opened from the list starts on the 3D keyboard.
  document.querySelector('.ws-back').click()
  await wait(() => document.querySelector('#course-piano'), 'Back to the piano lessons')
  await open('R&B and soul piano: chords on the four beats')
  await wait(() => fresh('keyboard') && piano()?.dataset.ready === 'true', `A lesson opened from the list starts on the 3D keyboard (${view()})`)
  document.querySelector('.ws-back').click()
  await wait(() => document.querySelector('#course-piano') && document.querySelector('.course-genre-option[aria-checked="true"]')?.dataset.genre === 'R&B and soul',
    'Back returns to the piano lessons of the same genre')
  const added = Object.keys(localStorage).filter((key) => !keysBefore.has(key))
  check(added.every((key) => key.startsWith('mizan:course:position:piano-') || key.startsWith('mizan:mixer:course:piano-')), `Only lesson places and mixers are stored: ${added}`)
  check(!localStorage.getItem('mizan:practice') || Object.keys(JSON.parse(localStorage.getItem('mizan:practice'))).every((key) => ['countIn', 'rate', 'click', 'sticking', 'kitStyle'].includes(key)),
    'The instrument and look are not stored')
  for (const key of added) localStorage.removeItem(key)
  document.querySelector('.course-instrument [data-instrument="drums"]').click()
  return `Piano checks passed at ${width}px: course switch and counts, piano lesson defaults (piano part, 3D stage piano), written fingers on keys, chord and pedal, ` +
    `keys rest when paused and press while playing, keybed framing, 4 looks without moving playback, solid blueprint keys, mixer, Hands & keys glow and pulse, next lesson, nothing new stored.`
}

async function layoutChecks(width) {
  const check = (value, message) => { if (!value) throw new Error(message) }
  const wait = async (test, message) => {
    for (let i = 0; i < 200; i++) { if (test()) return; await new Promise((resolve) => setTimeout(resolve, 50)) }
    throw new Error(message)
  }
  await wait(() => document.querySelector('.song-open'), 'The library lists songs')
  ;[...document.querySelectorAll('.song-open')].find((button) => button.textContent.includes('Paper Rain')).click()
  await wait(() => document.querySelector('.track-button'), 'The song opens')
  document.querySelector('.track-button').click()
  await wait(() => document.querySelector('.track-menu'), 'The track menu opens')
  ;[...document.querySelectorAll('.track-menu [role="menuitemradio"]')].find((row) => row.textContent.startsWith('Harmony line')).click()
  await wait(() => document.querySelector('.harmony-summary'), 'Harmony line shows its options as one compact button')
  document.querySelector('.chordview-option[data-view="hands"]')?.click()
  await wait(() => document.querySelector('.practice-hands')?.dataset.range, 'Hands & keys draws')
  const box = (selector) => document.querySelector(selector).getBoundingClientRect()
  const head = box('.ws-head'), title = box('.ws-song'), track = box('.track-button'), summary = box('.harmony-summary')
  const song = document.querySelector('.ws-song')
  check(song.scrollWidth <= song.clientWidth + 1, `The title is not cut off at ${width}px (${song.scrollWidth} > ${song.clientWidth})`)
  check(title.width >= 80 && [track, summary].every((b) => b.right <= innerWidth + 1 && b.left >= -1), `Title, harmony and track controls stay on screen (${Math.round(title.width)}px title)`)
  check(head.height <= (width < 960 ? 200 : 80), `The header stays compact (${Math.round(head.height)}px)`)
  check(document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, `No sideways scrolling at ${width}px`)
  // The options open in a panel over the page and close again; nothing in the header moves.
  const before = JSON.stringify([box('.ws-song'), box('.track-button')].map((b) => [Math.round(b.x), Math.round(b.y)]))
  document.querySelector('.harmony-summary').click()
  await wait(() => document.querySelector('.harmony-options[open] [aria-label="Follow"]'), 'The harmony options open')
  const panel = box('.harmony-options-panel')
  check(panel.left >= -1 && panel.right <= innerWidth + 1, `The harmony panel fits the window (${Math.round(panel.left)}–${Math.round(panel.right)})`)
  check(JSON.stringify([box('.ws-song'), box('.track-button')].map((b) => [Math.round(b.x), Math.round(b.y)])) === before, 'Opening the options does not move the header')
  document.querySelector('.harmony-summary').click()
  const [low, high, keyWidth] = document.querySelector('.practice-hands').dataset.range.split(/[-:]/).map(Number)
  check(keyWidth >= 14 && keyWidth <= 43 && high - low >= 23, `Hands & keys keeps piano proportions (${low}–${high} at ${keyWidth}px a key)`)
  document.querySelector('.ws-back').click()
  await wait(() => document.querySelector('.lib-tabs'), 'Back to the library')
  return `Layout checks passed at ${width}px: header ${Math.round(head.height)}px, title ${Math.round(title.width)}px, Harmony line options in a panel, Hands & keys ${low}–${high} at ${keyWidth}px.`
}

async function courseChecks(width, phase) {
  const check = (value, message) => { if (!value) throw new Error(message) }
  const wait = async (test, message) => {
    for (let i = 0; i < 160; i++) {
      if (test()) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(message)
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const where = () => document.querySelector('.ws-where')?.textContent ?? ''
  const bar = () => Number(/Bar (\d+)/.exec(where())?.[1])
  const toggle = (label) => [...document.querySelectorAll('.ws-foot .toggle')].find((button) => button.textContent.includes(label))
  const pressed = (label) => toggle(label)?.getAttribute('aria-pressed')
  const playButton = () => document.querySelector('.ws-foot .play')
  const showTab = async (id) => {
    document.querySelector(`.lib-tabs [data-tab="${id}"]`).click()
    await wait(() => !document.getElementById(`lib-panel-${id}`)?.hidden, `The ${id} tab shows`)
  }
  // Lessons are listed one shelf at a time: drums, then the course, the inspired lessons or one genre.
  const showShelf = async (shelf = 'course', genre) => {
    if (document.getElementById('lib-panel-course')?.hidden) await showTab('course')
    document.querySelector('.course-instrument [data-instrument="drums"]')?.click()
    await wait(() => document.querySelector('.course-shelf [data-shelf]'), 'The drum lists show')
    document.querySelector(`.course-shelf [data-shelf="${shelf}"]`).click()
    if (genre) {
      await wait(() => document.querySelector('.course-genre-option'), 'The genres show')
      document.querySelector(`.course-genre-option[data-genre="${genre}"]`).click()
      await wait(() => document.querySelector('.course-genre-detail h3')?.textContent === genre, `${genre} shows`)
    }
    await wait(() => document.querySelector('.course-lesson'), 'Lessons are listed')
  }
  const openLesson = async (title, shelf, genre) => {
    await showShelf(shelf, genre)
    const button = [...document.querySelectorAll('.course-lesson')].find((item) => item.querySelector('.course-title')?.firstChild?.textContent === title)
    check(button, `Lesson ${title} is listed`)
    button.click()
    await wait(() => document.querySelector('.ws .score-bar[aria-label="Bar 2"]') && document.querySelector('.ws-song'), `${title} opens`)
  }
  const back = async () => {
    document.querySelector('.ws-back').click()
    await wait(() => document.querySelector('.lib-tabs') && !document.querySelector('.ws'), 'Back returns to the library')
  }
  if (phase === 'restart') {
    // After a full reload: the choices made before are still in force.
    await wait(() => document.querySelector('.lib-tabs'), 'The library opens again')
    await openLesson('Fill around the toms')
    check(pressed('Count-in') === 'false' && pressed('Click') === 'false' && pressed('Sticking') === 'false',
      `Count-in, click and sticking stay off after a restart (${pressed('Count-in')}, ${pressed('Click')}, ${pressed('Sticking')})`)
    check(/75 bpm · 75%/.test(where()), `The chosen speed survives a restart: ${where()}`)
    await wait(() => document.querySelector('.practice-kit')?.dataset.style === 'acoustic:ClayStudyModel', 'The kit and look survive a restart')
    toggle('Count-in').click(); toggle('Click').click(); toggle('Sticking').click()
    await wait(() => pressed('Sticking') === 'true' && document.querySelector('.kit-hand'), 'Sticking returns with its legend')
    await back()
    const saved = JSON.parse(localStorage.getItem('mizan:practice'))
    check(Object.keys(saved).length === 5 && saved.kitStyle === 'acoustic:ClayStudyModel' && saved.countIn === true && saved.rate === 0.75 && saved.click === true && saved.sticking === true,
      `Preferences saved: ${localStorage.getItem('mizan:practice')}`)
    for (const key of Object.keys(localStorage)) if (key.startsWith('mizan:course:') || key.startsWith('mizan:mixer:course:') || key === 'mizan:practice') localStorage.removeItem(key)
    return `Course restart checks passed at ${width}px: count-in, click, sticking and speed restored after reload, then reset.`
  }
  // A library song's saved mixer state must survive practising lessons untouched.
  localStorage.removeItem('mizan:practice')
  localStorage.setItem('mizan:mixer:s1', JSON.stringify({ muted: ['piano'], volumes: { drums: 0.6 } }))
  const before = Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]))
  // Songs and the drum course are two tabs: Songs first; arrows, Home and End move between them.
  await wait(() => document.querySelector('.lib-tabs'), 'The library shows its tabs')
  const tabs = () => [...document.querySelectorAll('.lib-tabs [role="tab"]')]
  check(document.querySelector('.lib-tabs').getAttribute('role') === 'tablist' && tabs().map((tab) => `${tab.dataset.tab}:${tab.getAttribute('aria-selected')}:${tab.tabIndex}`).join('|') === 'songs:true:0|course:false:-1' &&
    !document.getElementById('lib-panel-songs').hidden && document.getElementById('lib-panel-course').hidden && !document.querySelector('.course-lesson'),
    `Songs is the first tab, with the course in its own tab: ${tabs().map((tab) => tab.textContent).join(' | ')}`)
  const key = (name) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
  tabs()[0].focus(); key('ArrowRight')
  await wait(() => document.activeElement?.dataset.tab === 'course' && !document.getElementById('lib-panel-course').hidden && document.getElementById('lib-panel-songs').hidden, 'ArrowRight selects and focuses Drum course')
  key('Home'); await wait(() => document.activeElement?.dataset.tab === 'songs', 'Home returns to Songs')
  key('End'); await wait(() => document.activeElement?.dataset.tab === 'course', 'End selects Drum course')
  key('ArrowRight'); await wait(() => document.activeElement?.dataset.tab === 'songs', 'Arrows wrap around')
  await showTab('course')
  const search = document.querySelector('.intake-unified input')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, 'paper')
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(() => tabs()[0].getAttribute('aria-selected') === 'true' && document.querySelector('.song-open'), 'Typing a search shows Songs with the matches')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, '')
  search.dispatchEvent(new Event('input', { bubbles: true }))
  check(!Object.keys(localStorage).some((name) => name.includes('tab')), 'The chosen tab is not stored')
  await showTab('course')
  // One list at a time: the levelled course first, then the inspired lessons, then the genres, each a choice above the list.
  await wait(() => document.querySelectorAll('.course-level .course-lesson').length === 49 && !document.querySelector('#course-inspired, #course-genre'),
    'The Course tab opens on the 49 course lessons alone')
  check(document.querySelectorAll('.course-level').length === 8, 'Lessons are grouped in eight levels')
  const shelves = [...document.querySelectorAll('.course-shelf [role="radio"]')]
  check(shelves.map((radio) => `${radio.textContent}:${radio.getAttribute('aria-checked')}`).join('|') === 'Course 49:true|Inspired 26:false|Genres 55:false',
    `Drum lessons are three lists with their counts: ${shelves.map((radio) => radio.textContent)}`)
  const fits = () => [...document.querySelectorAll('.course-lesson, .course-genre-option')].every((button) => button.getBoundingClientRect().right <= innerWidth) &&
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
  check(fits(), `Course rows fit at ${width}px`)
  shelves[0].focus()
  shelves[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  await wait(() => document.querySelector('#course-inspired') && document.activeElement?.dataset.shelf === 'inspired', 'ArrowRight shows the inspired lessons')
  const drumArtists = [...document.querySelectorAll('#course-inspired-genres .course-genre-option')]
  const drumStudies = drumArtists.reduce((sum, option) => sum + Number(/\d+/.exec(option.querySelector('.course-genre-note').textContent)[0]), 0)
  check(document.querySelector('#course-inspired').textContent.startsWith('Inspired by great drummers') && drumStudies === 26 &&
    [...document.querySelectorAll('.course-collection .course-style')].every((line) => /^Inspired by /.test(line.textContent)) && fits(),
    `The inspired lessons are grouped by artist, each naming its drummer (${drumStudies} by ${drumArtists.length} artists)`)
  drumArtists.find((option) => option.dataset.genre === 'Pink Floyd')?.click()
  await wait(() => document.querySelector('.course-genre-detail h3')?.textContent === 'Pink Floyd' && document.querySelectorAll('.course-genre-detail .course-lesson').length >= 3,
    'Pink Floyd lists its tracks')
  document.querySelector('.course-shelf [data-shelf="inspired"]').focus()
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
  await wait(() => document.querySelector('#course-genre')?.textContent.startsWith('Grooves by genre'), 'End shows the genres')
  const genreOptions = [...document.querySelectorAll('.course-genre-option')]
  check(genreOptions.length === 11 && genreOptions[0].getAttribute('aria-checked') === 'true', 'Eleven genres, the first chosen')
  const stages = []
  genreOptions[0].focus()
  for (let index = 0; index < 11; index++) {
    const name = document.querySelector('.course-genre-option[aria-checked="true"]').dataset.genre
    await wait(() => document.querySelector('.course-genre-detail h3')?.textContent === name, `${name} shows its lessons`)
    stages.push([...document.querySelectorAll('.course-genre-detail .course-style')].map((line) => line.textContent.split(' · ')[0]).join('|'))
    check(document.querySelector('.course-genre-detail .course-genre-facts').textContent.includes('Backing:') && fits(), `${name} names its backing and fits`)
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  }
  check(stages.length === 11 && stages.every((line) => line === 'Basic groove|Variation|Variation|Fill|Sixteen-bar phrase'),
    `Each genre lists five lessons from the basic groove to a sixteen-bar phrase: ${stages[0]}`)
  check(document.activeElement?.dataset.genre === genreOptions[0].dataset.genre, 'ArrowDown wraps from the last genre to the first')
  // A genre lesson: drums are the score, the kit and the selected track; the original bass and chords play along and mute on their own.
  await openLesson('Rock kick variations', 'genre', 'Rock')
  check(document.querySelector('.ws-song').textContent === 'Rock kick variations' && document.querySelector('.track-button')?.textContent.includes('Drum kit'),
    `The genre lesson opens on the drums: ${document.querySelector('.track-button')?.textContent}`)
  check(document.querySelector('.lesson-panel')?.textContent.includes('Backing') && document.querySelector('.lesson-panel').textContent.includes('A5 – D5'),
    'The lesson names its backing and chords')
  await wait(() => document.querySelector('.practice-kit'), 'The kit shows for the genre lesson')
  document.querySelector('.track-button').click()
  await wait(() => document.querySelector('.track-menu'), 'The track menu opens')
  const muteButton = (name) => document.querySelector(`[aria-label="Mute ${name}"]`)
  check(muteButton('Drum kit') && muteButton('Bass (picked)') && muteButton('Guitar (overdriven chords)'), 'Drums, bass and chords are each in the mixer, all audible')
  muteButton('Bass (picked)').click()
  await wait(() => document.querySelector('[aria-label="Unmute Bass (picked)"]') && muteButton('Guitar (overdriven chords)') && muteButton('Drum kit'), 'The bass mutes alone')
  document.querySelector('[aria-label="Unmute Bass (picked)"]').click()
  await wait(() => muteButton('Bass (picked)'), 'The bass unmutes')
  document.querySelector('.track-button').click()
  await back()
  // The hi-hat pedal glows and pulses on the pedal itself: pixels at the pedal turn the hi-hat's yellow when it is hit.
  await openLesson('Disco four on the floor', 'genre', 'Disco and dance')
  for (let i = 0; i < 600 && !(document.querySelector('.practice-kit canvas') && window.__mizanKitTargetAt?.('hatPedal')); i++) await sleep(50)
  await sleep(1500)
  check(document.querySelector('.practice-kit canvas') && window.__mizanKitTargetAt?.('hatPedal'),
    `The kit with its hi-hat pedal is ready (${document.querySelector('.ws-song')?.textContent}, ready ${document.querySelector('.practice-kit')?.dataset.ready}, view ${document.querySelector('.chordview-option[aria-checked="true"]')?.dataset.view}, track ${document.querySelector('.track-button')?.textContent})`)
  {
    const at = window.__mizanKitTargetAt('hatPedal')
    const pedalSamples = []
    window.__mizanKitFrame = (canvas, state) => {
      const gl = canvas.getContext('webgl')
      const ratio = canvas.width / canvas.clientWidth, n = 14, px = new Uint8Array(n * n * 4)
      gl.readPixels(Math.round(at.x * ratio) - n / 2, Math.round(canvas.height - at.y * ratio) - n / 2, n, n, gl.RGBA, gl.UNSIGNED_BYTE, px)
      let yellow = 0
      for (let i = 0; i < px.length; i += 4) yellow += (px[i] + px[i + 1]) / 2 - px[i + 2]
      const f = state.feedback.get('hatPedal')
      pedalSamples.push({ yellow: yellow / (n * n), pulse: f?.pulse ?? 0, upcoming: f?.upcoming ?? 0 })
    }
    const countIn = pressed('Count-in') === 'true'
    if (countIn) { toggle('Count-in').click(); await wait(() => pressed('Count-in') === 'false', 'Count-in off for the pedal check') }
    playButton().click()
    for (let i = 0; i < 120 && pedalSamples.filter((s) => s.pulse > 0.4).length < 2; i++) await sleep(50)
    playButton().click()
    window.__mizanKitFrame = undefined
    await wait(() => playButton().getAttribute('aria-label') === 'Play', 'Stopped after the pedal check')
    if (countIn) { toggle('Count-in').click(); await wait(() => pressed('Count-in') === 'true', 'Count-in back on') }
    const mean = (list) => list.reduce((sum, s) => sum + s.yellow, 0) / Math.max(1, list.length)
    const lit = pedalSamples.filter((s) => s.pulse > 0.4), idle = pedalSamples.filter((s) => s.pulse < 0.02 && s.upcoming < 0.02)
    check(lit.length && mean(lit) > mean(idle) + 20, `The hi-hat pedal glows when struck (yellowness ${Math.round(mean(lit))} lit vs ${Math.round(mean(idle))} idle, ${lit.length}/${idle.length} frames)`)
  }
  await back()
  await openLesson('Groove, fill, crash')
  check(document.querySelector('.ws-song').textContent === 'Lesson 35: Groove, fill, crash', `Lesson title: ${document.querySelector('.ws-song').textContent}`)
  check(/70 bpm · 70%/.test(where()), `The lesson starts at its starting tempo: ${where()}`)
  check(pressed('Loop') === 'true' && pressed('Count-in') === 'true' && pressed('Click') === 'true' && pressed('Sticking') === 'true',
    `Loop, count-in, click and sticking are on (${['Loop', 'Count-in', 'Click', 'Sticking'].map((name) => `${name} ${pressed(name)}`).join(', ')})`)
  check(document.querySelector('.lesson-goal')?.textContent.includes('crash'), 'The lesson instructions are beside the score')
  check(document.querySelectorAll('.lesson-counts tr').length === 3, 'Count and sticking for the groove and fill bars')
  check(document.querySelectorAll('.lesson-counts .hand-left').length > 0 && document.querySelectorAll('.lesson-counts .hand-right').length > 0,
    'The sticking line marks L and R')
  await wait(() => document.querySelectorAll('.score-hand-right').length && document.querySelectorAll('.score-hand-left').length, 'The score shows R and L letters')
  await wait(() => [...document.querySelectorAll('.kit-hand')].map((pill) => pill.textContent).join('|') === 'L Left hand|R Right hand', 'The kit legend names both hands')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true }))
  await wait(() => /75 bpm · 75%/.test(where()), 'Speed rises in 5% steps')
  // A view change does not move the playhead.
  document.querySelector('.ws .score-bar[aria-label="Bar 3"]').click()
  await wait(() => bar() === 3, 'Bar 3 is selected')
  document.querySelector('.chordview-option[data-view="score"]').click(); await sleep(300)
  document.querySelector('.chordview-option[data-view="kit"]').click(); await sleep(300)
  check(bar() === 3, `Switching the practice view keeps the position (${where()})`)
  // Kit and look are one compact menu: the electronic kit in its realistic look by default; changing it is a view change only.
  await wait(() => document.querySelector('.practice-kit')?.dataset.style === 'electronic:Realistic', 'The kit starts as the realistic electronic kit')
  const kitSwitch = [...document.querySelectorAll('.kit-type [role="radio"]')]
  const look = document.querySelector('.kit-look select')
  const toolbar = document.querySelector('.kit-toolbar').getBoundingClientRect()
  check(kitSwitch.map((radio) => `${radio.textContent}:${radio.getAttribute('aria-checked')}`).join('|') === 'Electronic:true|Acoustic:false' &&
    document.querySelector('.kit-type').getAttribute('aria-label') === 'Kit' && look?.labels[0]?.textContent.startsWith('Look') &&
    [...look.options].map((option) => option.textContent).join('|') === 'Realistic|Hand-painted clay|Neon rhythm|Technical blueprint',
    'The kit is a two-way switch and the look a labelled menu of four looks')
  check(toolbar.height < 44 && toolbar.bottom <= document.querySelector('.practice-kit .practice-stage').getBoundingClientRect().top + 1 &&
    toolbar.right <= document.querySelector('.practice-kit').getBoundingClientRect().right, 'The kit controls sit compactly above the kit, not over it')
  const chooseStyle = async (style) => {
    const [kit, lookName] = style.split(':')
    document.querySelector(`.kit-type [data-kit-type="${kit}"]`).click()
    await wait(() => document.querySelector('.practice-kit')?.dataset.kit === kit, `The ${kit} kit is chosen`)
    const menu = document.querySelector('.kit-look select')
    menu.value = lookName
    menu.dispatchEvent(new Event('change', { bubbles: true }))
    await wait(() => document.querySelector('.practice-kit')?.dataset.style === style && menu.value === lookName, `The ${style} kit is shown`)
  }
  for (const style of ['electronic:TechnicalBlueprint', 'acoustic:NeonRhythm', 'acoustic:ClayStudyModel']) {
    await chooseStyle(style)
    check(bar() === 3 && playButton().getAttribute('aria-label') === 'Play', `Changing the kit style does not move or start playback (${where()})`)
    check(JSON.parse(localStorage.getItem('mizan:practice')).kitStyle === style, 'The kit style is remembered')
  }
  // Next and Previous keep the drum guide the player chose: the score on its own stays the score on its own.
  const guide = () => document.querySelector('.chordview-option[aria-checked="true"]')?.dataset.view
  const drumPart = document.querySelector('.track-button')?.textContent
  const fresh = (title, view) => document.querySelector('.ws-song')?.textContent === title && bar() === 1 && playButton().getAttribute('aria-label') === 'Play' &&
    guide() === view && document.querySelector('.track-button')?.textContent === drumPart && !document.querySelector('.practice-kit') === (view === 'score')
  document.querySelector('.chordview-option[data-view="score"]').click()
  await wait(() => guide() === 'score' && !document.querySelector('.practice-kit'), 'The drum score on its own')
  document.querySelector('.lesson-nav button:last-child').click()
  await wait(() => fresh('Lesson 36: Fill around the toms', 'score'), `Next keeps the drum score on its own, on the drums, at bar 1, stopped (${guide()}, ${where()})`)
  document.querySelector('.lesson-nav button:first-child').click()
  await wait(() => fresh('Lesson 35: Groove, fill, crash', 'score'), `Previous keeps the drum score on its own (${guide()}, ${where()})`)
  document.querySelector('.chordview-option[data-view="kit"]').click()
  await wait(() => guide() === 'kit' && document.querySelector('.practice-kit'), 'Back to the kit')
  // Changing lesson starts the new one at bar 1, stopped, at the speed the player chose, still on the kit.
  document.querySelector('.lesson-nav button:last-child').click()
  await wait(() => document.querySelector('.ws-song')?.textContent === 'Lesson 36: Fill around the toms', 'Next lesson opens')
  await wait(() => /75 bpm · 75%/.test(where()) && bar() === 1 && fresh('Lesson 36: Fill around the toms', 'kit'), `The next lesson starts at bar 1 at the chosen speed, on the kit: ${where()}`)
  const toms = () => [...document.querySelectorAll('.kit-pill[data-piece]')].map((pill) => pill.textContent).filter((name) => /tom/i.test(name))
  await wait(() => toms().join('|') === 'Tom 1|Tom 2|Floor tom', `The tom fill uses the five-piece kit's three toms: ${toms()}`)
  // While playing: changing lesson stops the old one and starts the new one from the top, not playing.
  toggle('Count-in').click()
  await wait(() => pressed('Count-in') === 'false', 'Count-in turns off')
  // While playing, every drawn frame shows the kit (the realistic electronic kit once vanished between shadow passes).
  const frames = []
  window.__mizanKitFrame = (canvas) => {
    // One read of the finished frame, after every draw pass.
    const gl = canvas.getContext('webgl')
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, all = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, all)
    let dark = 0
    for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) {
      const i = (Math.floor((y + 0.5) * h / 48) * w + Math.floor((x + 0.5) * w / 48)) * 4
      if (all[i] + all[i + 1] + all[i + 2] < 300) dark++
    }
    frames.push({ dark, playing: playButton().getAttribute('aria-label') !== 'Play' })
  }
  await chooseStyle('electronic:Realistic')
  // The first switch to a kit may still be decoding its textures; a paused kit redraws once the new look is ready.
  for (let i = 0; i < 300 && !frames.some((f) => f.dark > 20); i++) await sleep(100)
  const kitCanvas = document.querySelector('.practice-kit canvas')
  check(frames.some((f) => f.dark > 20), `The realistic electronic kit is drawn (${frames.length} frames, most dark ${Math.max(0, ...frames.map((f) => f.dark))}, ` +
    `canvas ${kitCanvas?.width}x${kitCanvas?.height} hidden ${kitCanvas?.hidden}, page ${document.visibilityState}, failure ${document.querySelector('.practice-failure')?.textContent ?? 'none'})`)
  frames.length = 0
  playButton().click()
  for (let i = 0; i < 300 && !(bar() >= 2); i++) await sleep(50)
  check(bar() >= 2, `Playback advances (${where()})`)
  await sleep(3000)
  const played = frames.filter((f) => f.playing)
  window.__mizanKitFrame = undefined
  check(played.length > 30 && played.every((f) => f.dark > 20), `Every frame drawn while playing shows the kit (${played.filter((f) => f.dark > 20).length}/${played.length})`)
  await chooseStyle('acoustic:ClayStudyModel')
  check(!playButton().dataset.counting, 'No count-in when it is off')
  document.querySelector('.lesson-nav button:first-child').click()
  await wait(() => document.querySelector('.ws-song')?.textContent === 'Lesson 35: Groove, fill, crash', 'Previous lesson opens')
  await sleep(600)
  check(bar() === 1 && playButton().getAttribute('aria-label') === 'Play', `A lesson changed while playing opens at bar 1, stopped (${where()})`)
  check(pressed('Count-in') === 'false', 'Count-in stays off in the next lesson')
  playButton().click()
  await sleep(250)
  check(!playButton().dataset.counting, 'The new lesson plays without a count-in')
  playButton().click()
  toggle('Count-in').click()
  await wait(() => pressed('Count-in') === 'true', 'Count-in turns on')
  playButton().click()
  await wait(() => playButton().dataset.counting, 'With count-in on, play counts in')
  playButton().click()
  // Click and sticking off: the letters and the hand legend go, and the choices follow to other lessons.
  toggle('Click').click(); toggle('Sticking').click(); toggle('Count-in').click()
  await wait(() => !document.querySelector('.score-hand-left') && !document.querySelector('.kit-hand'), 'Sticking off hides the letters and hand legend')
  check(document.querySelector('.ws-where') && toggle('Sticking').querySelector('.toggle-state').textContent === 'off', 'Sticking reads off')
  document.querySelector('.chordview-option[data-view="score"]').click()
  await wait(() => guide() === 'score', 'The drum score on its own before leaving')
  await back()
  await openLesson('Ghost notes in a groove')
  await wait(() => guide() === 'kit' && document.querySelector('.practice-kit'), `A lesson opened from the list starts on the kit again (${guide()})`)
  check(pressed('Click') === 'false' && pressed('Sticking') === 'false' && pressed('Count-in') === 'false', 'The choices follow to another lesson, overriding its defaults')
  check(/60 bpm · 75%/.test(where()), `Speed follows too: ${where()}`)
  await wait(() => document.querySelectorAll('.score-ghost').length === 8 && document.querySelectorAll('.score-ghost-paren').length === 16,
    `Each ghost note is parenthesised (${document.querySelectorAll('.score-ghost').length})`)
  await back()
  check(tabs()[1].getAttribute('aria-selected') === 'true', 'Back from a lesson returns to the Drum course tab')
  await showTab('songs')
  // Song: a suggested sticking, and choosing another track starts it from the top.
  const song = [...document.querySelectorAll('.song-open')].find((element) => element.textContent.includes('Paper Rain'))
  check(song, 'Library has a song to open')
  song.click()
  await wait(() => document.querySelector('.track-button') && document.querySelector('.ws .score-bar[aria-label="Bar 3"]'), 'The song opens')
  // A library song with a saved place (bar 34) still opens from the top, keeping the player's saved choices.
  await wait(() => bar() === 1, `A library song opens at bar 1 (${where()})`)
  check(pressed('Count-in') === 'false' && pressed('Click') === 'false', 'Saved count-in and click stay in force')
  document.querySelector('.ws .score-bar[aria-label="Bar 3"]').click()
  await wait(() => bar() === 3, 'Bar 3 is selected in the song')
  document.querySelector('.track-button').click()
  await wait(() => document.querySelector('.track-menu'), 'The track menu opens')
  ;[...document.querySelectorAll('.track-item[role="menuitemradio"]')].find((element) => element.textContent.includes('Drum kit')).click()
  await wait(() => bar() === 1 && toggle('Sticking'), `Choosing another track starts it at bar 1 (${where()})`)
  check(pressed('Click') === 'false', 'The song opens with the saved click choice')
  toggle('Sticking').click()
  await wait(() => document.querySelectorAll('.score-hand-right').length > 4, 'The song shows suggested sticking letters')
  toggle('Sticking').click()
  await back()
  const after = Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]))
  const changed = Object.keys(before).filter((key) => after[key] !== before[key] && !key.startsWith('mizan:mixer:') && key !== 'mizan:position:s1')
  const added = Object.keys(after).filter((key) => !(key in before))
  check(!changed.filter((key) => key === 'mizan:mixer:s1').length, 'Library song mixer state is untouched by lessons')
  check(added.every((key) => key.startsWith('mizan:course:') || key.startsWith('mizan:mixer:') || key === 'mizan:practice'), `Lesson state is namespaced: ${added}`)
  check(JSON.parse(after['mizan:course:position:snare-fill']).rate === 0.75, 'The lesson keeps the practised speed')
  return `Course checks passed at ${width}px: sections, lesson defaults, sticking letters and legend, speed, view change keeps position, ` +
    'lesson change from paused and playing starts at bar 1, count-in/click/sticking/speed follow lessons, ghost parentheses, track change resets, suggested sticking.'
}
