// Run from ui\: node tests\kit-hands-browser.mjs   (needs the Vite dev server: MIZAN_TEST_URL, default http://127.0.0.1:5187)
// The drum and piano hands in a real browser, on the real views with a stand-in clock (tests\kit-hands-preview.html): they are
// drawn, follow the sticking and fingering, show the same pose for the same time, stay still under reduced motion, and the
// kit and keyboard keep working when the hand models cannot be loaded.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = process.env.MIZAN_TEST_URL ?? 'http://127.0.0.1:5187'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const profile = await mkdtemp(join(tmpdir(), 'mizan-kit-hands-test-'))
const browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-sync',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', 'about:blank',
], { stdio: 'ignore' })
let socket
let failed = false
try {
  let port
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break } catch { await sleep(100) }
  }
  assert.ok(port, 'The test browser has a debugging endpoint')
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = targets.find((item) => item.type === 'page' && item.url === 'about:blank')
  const address = new URL(target.webSocketDebuggerUrl)
  address.hostname = '127.0.0.1'
  socket = new WebSocket(address.href)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let sequence = 0
  const pending = new Map()
  const logs = []
  socket.onmessage = ({ data }) => {
    const reply = JSON.parse(data)
    if (reply.id) pending.get(reply.id)?.(reply)
    else if (reply.method === 'Runtime.consoleAPICalled') logs.push(`${reply.params.type}: ${reply.params.args.map((a) => a.value ?? a.description).join(' ')}`)
    else if (reply.method === 'Runtime.exceptionThrown') logs.push(`exception: ${reply.params.exceptionDetails.exception?.description ?? reply.params.exceptionDetails.text}`)
  }
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 60000)
    pending.set(id, (reply) => { pending.delete(id); clearTimeout(timeout); if (reply.error) reject(new Error(JSON.stringify(reply.error))); else resolve(reply.result) })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text)
    return result.result.value
  }
  await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable')
  // Keep the drawn frame so pixels can be read back, and note the last state of each frame.
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.__mizanKitCapture = true;
    window.__frames = 0; window.__hands = null;
    window.__mizanKitFrame = (canvas, state) => { window.__frames++; window.__hands = state.hands ? JSON.parse(JSON.stringify(state.hands)) : null; window.__canvas = canvas };
    window.__mizanPianoFrame = (canvas, state) => { window.__frames++; window.__hands = state.hands ? JSON.parse(JSON.stringify(state.hands)) : null; window.__canvas = canvas };
  ` })
  const open = async (query, { width = 1440, height = 1100, scale = 1, reduced = false, block = false } = {}) => {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] })
    await call('Network.setBlockedURLs', { urls: block ? ['*FrettingLeftHand.glb', '*FrettingRightHand.glb'] : [] })
    await call('Network.setCacheDisabled', { cacheDisabled: true })
    logs.length = 0
    await call('Page.navigate', { url: `${base}/tests/kit-hands-preview.html?${query}` })
    for (let attempt = 0; attempt < 300; attempt++) {
      const ready = await evaluate(`(() => { const s = document.querySelector('.practice-kit'); return !!s && s.dataset.handsShown !== 'loading' && (s.dataset.ready === undefined || s.dataset.ready === 'true') && !!window.__canvas })()`).catch(() => false)
      if (ready) return
      await sleep(100)
    }
    throw new Error(`${query} did not become ready: ${logs.join(' | ')}`)
  }
  // Moves the stand-in clock and waits for the view to draw it.
  const at = async (beat, extra = {}) => {
    await evaluate(`window.__t = ${JSON.stringify({ playing: true, countingIn: false, countBeat: 0, beat, ...extra })}; new Promise((resolve) => { const before = window.__frames; const tick = () => document.querySelector('.practice-kit') && (window.__frames > before || performance.now() > window.__deadline) ? resolve() : requestAnimationFrame(tick); window.__deadline = performance.now() + 700; requestAnimationFrame(tick) })`)
    await sleep(60)
    return evaluate('window.__hands')
  }
  const dataset = (name) => evaluate(`document.querySelector('.practice-kit').dataset.${name}`)
  const readEnergy = () => evaluate(`(() => { const gl = window.__canvas.getContext('webgl'); const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); let sum = 0; for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2]; return sum })()`)
  // The sum of every drawn pixel; the kit's model may still be loading, so redraw at the same beat until it is on screen.
  const energy = async (beat) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      await at(beat + (attempt % 2) * 0.0001)
      const sum = await readEnergy()
      if (sum > 0) return sum
      await sleep(300)
    }
    return 0
  }
  const rects = () => evaluate(`(() => { const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] }; return { toolbar: r('.kit-toolbar'), stage: r('.practice-stage'), legend: r('.kit-legend') } })()`)
  const HINT = 'Hands show a suggested motion, not a recording.'

  // ---------- Drums ----------
  for (const style of ['acoustic:Realistic', 'electronic:Realistic']) {
    await open(`view=drums&example=groove&style=${style}&stage=420`)
    assert.equal(await dataset('handsShown'), 'true', `${style}: the hands are drawn`)
    assert.ok((await evaluate('document.querySelector(".kit-legend .practice-note").textContent')).includes(HINT), `${style}: the hint says the motion is suggested`)
    const striking = await at(1.0)
    assert.ok(striking.left.striking && striking.right.striking, `${style}: both sticks land on the beat`)
    assert.equal(await dataset('sticks'), 'left:snare,right:hihat', `${style}: the lesson's sticking — left on the snare, right on the hi-hat`)
    const raised = await at(1.25)
    assert.ok(!raised.left.striking && raised.left.lift > 0.02, `${style}: between strokes the stick is raised (${raised.left.lift})`)
    // The hands are really drawn: the same frame without them (models blocked) is different.
    const withHands = await energy(1.0)
    // Seeking, and coming back: the same time shows the same pose.
    const first = await at(2.3)
    await at(0); await at(3.7); await at(0.9)
    assert.deepEqual(await at(2.3), first, `${style}: the same time shows the same hands after seeking around`)
    // Paused: ready over the first strokes, not mid-air at an old time.
    const paused = await at(0, { playing: false })
    assert.ok(!paused.left.striking && !paused.right.striking, `${style}: paused hands wait without striking`)
    assert.equal(await dataset('sticks'), 'left:snare,right:hihat', `${style}: paused hands wait over their first strokes`)
    await open(`view=drums&example=groove&style=${style}&stage=420`, { block: true })
    assert.equal(await dataset('handsShown'), 'failed', `${style}: a missing hand model is reported`)
    assert.ok((await evaluate('document.querySelector(".kit-legend .practice-note").textContent')).includes('The hands could not be loaded, so only the kit is shown.'), `${style}: the hint says so plainly`)
    assert.ok(logs.some((line) => line.includes('The drumming hands could not be loaded')), `${style}: the failure is logged as a warning`)
    await at(1.0)
    const withoutHands = await energy(1.0)
    assert.ok(withoutHands > 1000 && Math.abs(withHands - withoutHands) > 3000, `${style}: the hands change the picture (${withHands} with, ${withoutHands} without) and the kit still draws`)
  }
  // Layout: the controls and stage keep their places whether or not the hands load.
  await open('view=drums&example=groove&style=acoustic:Realistic&stage=420')
  const shown = await rects()
  await open('view=drums&example=groove&style=acoustic:Realistic&stage=420', { block: true })
  const missing = await rects()
  assert.deepEqual([shown.toolbar, shown.stage, shown.legend.slice(0, 2)], [missing.toolbar, missing.stage, missing.legend.slice(0, 2)], 'the toolbar, stage and legend keep their places with or without hands')
  // Tom fill on the electronic kit: each stroke goes to the written drum with the written hand.
  await open('view=drums&example=fill&style=electronic:Realistic&stage=420')
  for (const [beat, expected] of [[0, 'right:snare'], [0.5, 'left:tom1'], [1, 'right:tom2'], [1.5, 'left:floor'], [2, 'right:floor'], [3, 'right:crash']]) {
    const state = await at(beat)
    const [side, piece] = expected.split(':')
    assert.ok(state[side].striking && state[side].piece === piece, `fill beat ${beat}: ${expected} (${JSON.stringify({ piece: state[side].piece, striking: state[side].striking })})`)
  }
  // Reduced motion: no swinging between strokes.
  await open('view=drums&example=groove&style=acoustic:Realistic&stage=420', { reduced: true })
  const still = [await at(0.1), await at(0.2), await at(0.35)].map((state) => [state.right.tip[0], state.right.tip[2]])
  assert.deepEqual(still[0], still[1], 'reduced motion: the stick does not travel between strokes')
  assert.deepEqual(still[1], still[2], 'reduced motion: it stays over the same drum until the next stroke')
  assert.ok((await at(3.0)).left.striking, 'reduced motion: a stroke still touches the drum in its instant')
  // A narrow phone-sized stage.
  await open('view=drums&example=groove&style=acoustic:Realistic', { width: 617, scale: 2 })
  assert.equal(await dataset('handsShown'), 'true', 'the hands are drawn on a narrow screen')
  assert.ok((await at(1.0)).left.striking, 'and land on the beat there too')

  // ---------- Piano ----------
  await open('view=piano&example=chord')
  assert.equal(await dataset('handsShown'), 'true', 'piano: the hands are drawn')
  assert.ok((await evaluate('document.querySelector(".kit-legend .practice-note").textContent')).includes(HINT), 'piano: the hint says the motion is suggested')
  let chord = await at(0.5)
  assert.equal(await dataset('pressed'), '48L5,55L1,60R1,64R3,67R5', 'piano: the keys down name their hand and finger')
  for (const side of ['left', 'right']) {
    const down = chord[side].fingers.filter((finger) => finger.pressing !== null)
    assert.deepEqual(down.map((finger) => `${finger.pressing}:${finger.finger}`).sort(), side === 'left' ? ['48:5', '55:1'] : ['60:1', '64:3', '67:5'], `piano: the ${side} hand presses its keys with the written fingers`)
    assert.ok(down.every((finger) => finger.error < 0.004), `piano: each pressing fingertip is on its key (${down.map((finger) => (finger.error * 1000).toFixed(1))} mm off)`)
    assert.ok(chord[side].fingers.filter((finger) => finger.pressing === null).every((finger) => finger.pad[1] > 0.745), `piano: the other ${side} fingers hover above the keys`)
  }
  assert.ok(await evaluate('document.querySelectorAll(".piano-finger").length >= 5'), 'piano: the finger numbers are still on the keys')
  const pianoFirst = await at(2.5)
  await at(0.2); await at(3.6)
  assert.deepEqual(await at(2.5), pianoFirst, 'piano: the same time shows the same hands after seeking around')
  const left0 = (await at(0.3)).left.center, left1 = (await at(2.2)).left.center
  assert.notEqual(left0, left1, 'piano: the hands move to the next chord')
  await at(0, { playing: false })
  assert.ok((await evaluate('window.__hands')).right.fingers.every((finger) => finger.pressing === null), 'piano: paused, no finger presses a key')
  assert.equal(await dataset('depressed'), '', 'piano: and the keys rest up')
  // No hands written: placed by pitch, and said so.
  await open('view=piano&example=nohands')
  assert.ok((await evaluate('document.querySelector(".kit-legend .practice-note").textContent')).includes('placed by pitch: left below middle C, right from middle C up'), 'piano: hands placed by pitch are said so')
  const bare = await at(0.5)
  assert.deepEqual([bare.left.fingers.some((finger) => finger.pressing === 48), bare.right.fingers.some((finger) => finger.pressing === 60)], [true, true], 'piano: low notes go to the left hand and middle C to the right')
  // Reduced motion: no gliding.
  await open('view=piano&example=melody', { reduced: true })
  const centres = [(await at(0.6)).right.center, (await at(0.7)).right.center]
  assert.equal(centres[0], centres[1], 'piano, reduced motion: the hand stays over its notes instead of gliding')
  // Hands missing: the keyboard still works and says so.
  await open('view=piano&example=chord', { block: true })
  assert.equal(await dataset('handsShown'), 'failed', 'piano: a missing hand model is reported')
  assert.ok((await evaluate('document.querySelector(".kit-legend .practice-note").textContent')).includes('The hands could not be loaded, so only the keyboard is shown.'), 'piano: the hint says so plainly')
  assert.ok(logs.some((line) => line.includes('piano hands could not be loaded')), 'piano: the failure is logged as a warning')
  await at(0.5)
  assert.equal(await dataset('pressed'), '48L5,55L1,60R1,64R3,67R5', 'piano: the keys still follow the notes without hands')
  // ---------- Hands toggle (shared by every 3D view) ----------
  const toggle = '.kit-toolbar [data-kit-toggle="hands"]'
  const handModelsFetched = () => evaluate(`performance.getEntriesByType('resource').some((entry) => /Fretting(Left|Right)Hand|Hand.*\\.glb/i.test(entry.name))`)
  await evaluate('localStorage.removeItem("mizan:practice")')
  const views = { drums: 'view=drums&example=groove&style=acoustic:Realistic&stage=420', piano: 'view=piano&example=chord' }
  for (const [view, query] of Object.entries(views)) {
    await open(query)
    assert.equal(await evaluate(`document.querySelector('${toggle}')?.textContent`), 'Hands', `${view}: the toolbar has a Hands toggle`)
    assert.equal(await evaluate(`document.querySelector('${toggle}').getAttribute('aria-pressed')`), 'true', `${view}: Hands is on by default`)
    assert.equal(await dataset('handsShown'), 'true', `${view}: the hands are drawn while Hands is on`)
    const onLayout = await rects()
    await evaluate(`document.querySelector('${toggle}').click()`)
    await sleep(300)
    const off = await at(1.0)
    assert.equal(off, null, `${view}: with Hands off the frame data reports no hands`)
    assert.equal(await dataset('handsShown'), 'off', `${view}: the view says the hands are off`)
    assert.equal(await evaluate(`document.querySelector('${toggle}').getAttribute('aria-pressed')`), 'false', `${view}: the toggle shows Hands off`)
    assert.ok(!(await evaluate('document.querySelector(".kit-legend .practice-note").textContent')).includes(HINT), `${view}: the suggested-motion hint is hidden while Hands is off`)
    const offLayout = await rects()
    assert.deepEqual([offLayout.toolbar, offLayout.stage, offLayout.legend.slice(0, 2)], [onLayout.toolbar, onLayout.stage, onLayout.legend.slice(0, 2)], `${view}: turning Hands off does not move the toolbar, stage or legend`)
    if (view === 'drums') assert.ok((await dataset('lit')).length > 0, 'drums: the stroke glows stay with Hands off')
    else {
      assert.ok((await dataset('pressed')).length > 0 && await evaluate('document.querySelectorAll(".piano-finger").length >= 5'), 'piano: key colours and finger numbers stay with Hands off')
    }
    // Remembered after a reload, and not even fetched.
    await open(query)
    assert.equal(await dataset('handsShown'), 'off', `${view}: Hands stays off after a reload`)
    assert.equal(await handModelsFetched(), false, `${view}: the hand models are not loaded while Hands is off`)
    // Remembered when the other instrument opens.
    await open(view === 'drums' ? views.piano : views.drums)
    assert.equal(await dataset('handsShown'), 'off', `${view}: the other instrument also opens with Hands off`)
    // Turning it back on loads and draws them without moving anything.
    await evaluate(`document.querySelector('${toggle}').click()`)
    for (let attempt = 0; attempt < 100 && (await dataset('handsShown')) !== 'true'; attempt++) await sleep(100)
    assert.equal(await dataset('handsShown'), 'true', `${view}: turning Hands on loads and draws them`)
    assert.ok((await at(1.0)) !== null, `${view}: the frame data reports hands again`)
    await open(query)
    assert.equal(await dataset('handsShown'), 'true', `${view}: Hands on is remembered too`)
  }
  const errors = logs.filter((line) => line.startsWith('exception'))
  assert.deepEqual(errors, [], 'no script errors')
  console.log('Kit hands browser checks passed: drums (both kits, fill, paused, seeking, reduced motion, narrow screen, missing models) and piano (chord, seeking, paused, pitch-placed, reduced motion, missing models).')
} catch (error) {
  failed = true
  throw error
} finally {
  try {
    if (socket?.readyState === WebSocket.OPEN) { socket.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); await sleep(500); socket.close() }
    // Only the browser this run started, by its own process id and its children.
    if (browser.exitCode === null && browser.pid) execFileSync('taskkill.exe', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore', timeout: 20000 })
  } catch { /* the browser already exited */ }
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }).catch((error) => { if (!failed) throw error })
}
