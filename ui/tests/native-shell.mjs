// Launch a dedicated shell with CDP and an isolated MIZAN_HOME containing a real six-stem song.
// MIZAN_TEST_SONG_ID=<id> node ui\tests\native-shell.mjs
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

const endpoint = process.env.MIZAN_TEST_CDP ?? 'http://localhost:9333'
const songId = process.env.MIZAN_TEST_SONG_ID
assert.ok(songId, 'Set MIZAN_TEST_SONG_ID to a real six-stem song in an isolated test library')
const targets = await (await fetch(`${endpoint}/json/list`)).json()
const target = targets.find((item) => item.type === 'page' && item.url.startsWith('https://mizan.local/'))
assert.ok(target, 'Native mizan.local WebView2 target exists')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let sequence = 0
const pending = new Map()
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data)
  pending.get(message.id)?.(message)
}
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 120000)
  pending.set(id, (message) => {
    clearTimeout(timeout)
    pending.delete(id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text)
  return result.result.value
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (expression, description, timeout = 60000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await evaluate(expression)) return
    await sleep(100)
  }
  throw new Error(`Timed out: ${description}`)
}
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
const setInput = (selector, value) => evaluate(`(() => {
  const input = document.querySelector(${JSON.stringify(selector)})
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
})()`)
const report = []
try {
  await call('Page.enable')
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `(${instrument.toString()})()` })
  await call('Page.reload', { ignoreCache: true })
  await waitFor('!!document.querySelector(".song-open") && !!window.nativeTest', 'native library')
  const result = await evaluate(`(${hostChecks.toString()})(${JSON.stringify(songId)})`)
  report.push(result)
  console.log(result)

  await evaluate(`(() => {
    const bytes = Uint8Array.from('4d546864000000060000000101e04d54726b0000000d00903c648360803c0000ff2f00'.match(/../g), x => parseInt(x, 16))
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], 'Native verification.mid', { type: 'audio/midi' }))
    const input = document.querySelector('input[type=file]')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await waitFor('!!document.querySelector(".transport")', 'MIDI file import opens workspace')
  await click('[aria-label="Back to the library"]')
  await waitFor('!!document.querySelector(".song-open")', 'library after import')
  const importedId = await evaluate(`nativeTest.rpc('list_library').then(r => r.entries.find(e => e.title === 'Native verification').id)`)
  await click(`[aria-describedby="song-${importedId}-meta"]`)
  await waitFor('!!document.querySelector(".transport")', 'reopen imported MIDI')
  await click('[aria-label="Back to the library"]')
  await waitFor('!!document.querySelector(".song-open")', 'library before search')
  await evaluate(`nativeTest.rpc('delete_song', ${JSON.stringify(importedId)})`)
  await setInput('.intake-field input', 'Cairokee')
  await waitFor('document.querySelectorAll(".song-open").length > 0 && [...document.querySelectorAll(".song-open")].every(e => /Cairokee/i.test(e.textContent))', 'local filtered songs')
  await waitFor('!!document.querySelector(".youtube-results .youtube-result")', 'live YouTube search results')
  report.push('Native UI: MIDI import/reopen, local search, live YouTube results')
  await setInput('.intake-field input', '')
  await click(`[aria-describedby="song-${songId}-meta"]`)
  await waitFor('!!document.querySelector(".transport")', 'real benchmark workspace')
  await setInput('#goto', '1')
  await evaluate('document.querySelector(".goto").requestSubmit()')
  await setInput('.speed input', '100')
  await click('.track-button')
  assert.equal(await evaluate('document.querySelectorAll(".track-stem").length'), 7)
  await evaluate(`[...document.querySelectorAll('.sound-presets button')].find(b => b.textContent === 'Original only').click()`)
  await evaluate(`document.querySelector('button[title="Count-in"][aria-pressed=true]')?.click()`)
  await click('[aria-label="Play"]')
  await waitFor('nativeTest.media.some(m => !m.paused && m.currentTime > 0.2)', 'original host WAV playback')
  await sleep(500)
  assert.ok(await evaluate('nativeTest.audible() > 0.00001'), 'Host WAV reaches WebAudio output')
  assert.equal(await evaluate('nativeTest.samples.size'), 68, 'All packaged piano/drum samples fetched successfully')
  await click('[aria-label="Unmute Vocals"]')
  await waitFor('nativeTest.media.some(m => !m.paused && m.src.includes("vocals.wav"))', 'isolated vocals')
  await click('[aria-label="Unmute Drums"]')
  await waitFor('nativeTest.media.some(m => !m.paused && m.src.startsWith("blob:"))', 'real vocals/drums OfflineAudioContext mix')
  await sleep(500)
  assert.ok(await evaluate('nativeTest.audible() > 0.00001'), 'Isolated mixed stems produce nonzero output')
  await setInput('.speed input', '50')
  await waitFor('nativeTest.media.some(m => !m.paused && m.playbackRate === 0.5 && m.preservesPitch)', 'half-speed pitch-preserving mixed recording')
  const beforeSeek = await evaluate('nativeTest.media.find(m => !m.paused).currentTime')
  await setInput('#goto', '10')
  await evaluate('document.querySelector(".goto").requestSubmit()')
  await sleep(400)
  const afterSeek = await evaluate('nativeTest.media.find(m => !m.paused).currentTime')
  assert.ok(afterSeek > beforeSeek + 0.5, `Native seek advances recording: ${beforeSeek} -> ${afterSeek}`)
  await click('[aria-label="Pause"]')
  assert.ok(await evaluate('nativeTest.media.every(m => m.paused)'), 'All recording media pause')
  const paused = await evaluate('nativeTest.media.at(-1).currentTime')
  await sleep(200)
  assert.equal(await evaluate('nativeTest.media.at(-1).currentTime'), paused)
  await click('[aria-label="Solo Vocals"]')
  assert.equal(await evaluate('document.querySelector("[aria-label=\\"Solo Vocals\\"]").getAttribute("aria-checked")'), 'true')
  await click('[aria-label="Solo Vocals"]')
  assert.equal(await evaluate('document.querySelector("[aria-label=\\"Mute Drums\\"]").getAttribute("aria-checked")'), 'false')
  await setInput('.track-stem:has([aria-label="Solo Vocals"]) input', '0.45')
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('mizan:mixer:${songId}')).volumes['stem:vocals']`), 0.45)
  report.push('Native mixer: seven real stems; 68 offline samples; audible original/isolated/mixed playback; seek, pause, half-speed, solo restoration, saved volume')
  const pitch = await evaluate(`(${pitchCheck.toString()})()`)
  report.push(pitch)
  if (process.env.MIZAN_TEST_SCREENSHOT) {
    const shot = await call('Page.captureScreenshot', { format: 'png' })
    await writeFile(process.env.MIZAN_TEST_SCREENSHOT, Buffer.from(shot.data, 'base64'))
  }
  assert.deepEqual(await evaluate('nativeTest.errors'), [], 'No uncaught native UI errors')
  console.log(JSON.stringify(report, null, 2))
} finally {
  socket.close()
}

function instrument() {
  const state = window.nativeTest = { media: [], contexts: [], samples: new Set(), errors: [] }
  addEventListener('error', (event) => state.errors.push(event.message))
  addEventListener('unhandledrejection', (event) => state.errors.push(String(event.reason)))
  const OriginalAudio = window.Audio
  window.Audio = class extends OriginalAudio {
    constructor(...args) { super(...args); state.media.push(this) }
  }
  const OriginalContext = window.AudioContext
  window.AudioContext = class extends OriginalContext {
    createDynamicsCompressor() {
      const compressor = super.createDynamicsCompressor()
      const analyser = this.createAnalyser()
      compressor.connect(analyser)
      state.contexts.push({ context: this, analyser })
      return compressor
    }
  }
  const originalFetch = window.fetch
  window.fetch = async (...args) => {
    const response = await originalFetch(...args)
    if (String(args[0]).startsWith('/samples/') && response.ok) state.samples.add(String(args[0]))
    return response
  }
  state.audible = () => Math.max(0, ...state.contexts.map(({ analyser }) => {
    const data = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(data)
    return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length)
  }))
  let sequence = 0
  state.rpc = (method, ...args) => new Promise((resolve, reject) => {
    const id = 'native-test-' + ++sequence
    const timeout = setTimeout(() => { chrome.webview.removeEventListener('message', listener); reject(new Error(method + ' timed out')) }, 90000)
    const listener = ({ data }) => {
      if (data.id !== id) return
      clearTimeout(timeout)
      chrome.webview.removeEventListener('message', listener)
      if (!data.ok || !data.result?.ok) reject(new Error(JSON.stringify(data)))
      else resolve(data.result)
    }
    chrome.webview.addEventListener('message', listener)
    chrome.webview.postMessage({ id, method, args })
  })
}

async function hostChecks(songId) {
  const check = (value, message) => { if (!value) throw new Error(message) }
  check(location.origin === 'https://mizan.local' && window.__mizanNativeShell && !!chrome.webview && !window.pywebview, 'Native transport, not mock or pywebview')
  const library = await nativeTest.rpc('list_library')
  const prior = library.entries.find(entry => entry.id !== songId && entry.recording)
  check(prior, 'Prior library song exists')
  check((await nativeTest.rpc('open_song', prior.id)).song.title === prior.title, 'Prior song reopens correctly')
  const opened = await nativeTest.rpc('open_song', songId)
  check(opened.stems.length === 7, 'Host returns full mix plus six real stems')
  check(opened.song.diagnostics.separate.method === 'htdemucs-6s-onnx', 'Real Demucs benchmark, not synthetic media')
  const ctx = new AudioContext()
  const decoded = []
  try {
    for (const stem of opened.stems) {
      const partial = await fetch(stem.url, { headers: { Range: 'bytes=0-43' } })
      check(partial.status === 206 && (await partial.arrayBuffer()).byteLength === 44, 'Native CORS Range fetch: ' + stem.id)
      const response = await fetch(stem.url)
      check(response.ok, 'Native CORS fetch: ' + stem.id)
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer())
      const data = buffer.getChannelData(0)
      const rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length)
      check(buffer.duration > 270 && rms > 0.0001, 'Real decoded audio: ' + stem.id)
      decoded.push({ id: stem.id, seconds: buffer.duration, rms })
    }
  } finally { await ctx.close() }
  return { origin: location.origin, prior: prior.title, decoded }
}

async function pitchCheck() {
  const ctx = new AudioContext()
  await ctx.resume()
  const rate = 48000
  const bytes = new ArrayBuffer(44 + rate * 4 * 2)
  const view = new DataView(bytes)
  const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, bytes.byteLength - 44, true)
  for (let i = 0; i < rate * 4; i++) view.setInt16(44 + i * 2, 6000 * Math.sin(2 * Math.PI * 440 * i / rate), true)
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
  const media = new Audio(url)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 8192
  ctx.createMediaElementSource(media).connect(analyser).connect(ctx.destination)
  try {
    media.preservesPitch = true
    media.playbackRate = 0.5
    await media.play()
    await new Promise(resolve => setTimeout(resolve, 500))
    const bins = new Float32Array(analyser.frequencyBinCount)
    analyser.getFloatFrequencyData(bins)
    const hz = bins.indexOf(Math.max(...bins)) * ctx.sampleRate / analyser.fftSize
    if (Math.abs(hz - 440) > 10) throw new Error('Native half-speed changed pitch: ' + hz)
    return { nativeHalfSpeedPeakHz: hz }
  } finally {
    media.pause(); media.removeAttribute('src'); media.load()
    URL.revokeObjectURL(url); await ctx.close()
  }
}
