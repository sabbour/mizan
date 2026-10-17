// Run from ui: node tests\ffmpeg-settings.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'vite'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const server = process.env.MIZAN_TEST_URL ? null : await createServer({
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
})
await server?.listen()
const url = process.env.MIZAN_TEST_URL ?? server.resolvedUrls.local[0]
const profile = await mkdtemp(join(tmpdir(), '.edge-ffmpeg-'))
const browser = spawn(process.env.MIZAN_TEST_BROWSER
  ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--disable-extensions', '--disable-background-networking', '--disable-gpu',
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' })
let launchError
browser.on('error', (error) => { launchError = error })
let socket
try {
  let port
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    if (launchError) throw launchError
    assert.equal(browser.exitCode, null, 'Dedicated test browser remains running')
    try {
      port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0])
    } catch (error) {
      if (!['ENOENT', 'EBUSY'].includes(error.code)) throw error
    }
    if (!port) await sleep(100)
  }
  assert.ok(port, 'Dedicated browser debugging endpoint started')
  const response = await fetch(`http://localhost:${port}/json/list`, { signal: AbortSignal.timeout(15000) })
  assert.ok(response.ok, 'Dedicated browser debugging endpoint is responsive')
  const target = (await response.json()).find((item) => item.type === 'page')
  assert.ok(target, 'Dedicated browser page exists')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let sequence = 0
  const pending = new Map()
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    pending.get(message.id)?.(message)
  }
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, 15000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      pending.delete(id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    })
    assert.ok(!result.exceptionDetails,
      result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text)
    return result.result.value
  }
  const waitFor = async (expression, description) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return
      await sleep(50)
    }
    assert.fail(`Timed out: ${description}`)
  }
  await call('Page.enable')
  await call('Runtime.enable')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  })
  await call('Page.navigate', { url })
  await waitFor('!!document.querySelector(\'[aria-label="Song analysis settings"]\')', 'Library loads')
  await evaluate(`(async () => {
    const appSource = await (await fetch('/src/App.tsx')).text()
    const bridgeUrl = appSource.match(/from "([^"]*bridge\\.ts[^"]*)"/)?.[1]
    if (!bridgeUrl) throw new Error('Could not resolve the application bridge')
    const { host, HostError } = await import(bridgeUrl)
    window.ffmpegTest = { host, HostError, calls: [], errors: [] }
    addEventListener('error', (event) => ffmpegTest.errors.push(event.message))
    addEventListener('unhandledrejection', (event) => ffmpegTest.errors.push(String(event.reason)))
    const save = host.setFfmpegPath
    host.setFfmpegPath = async (path) => {
      ffmpegTest.calls.push(path)
      return save(path)
    }
    document.querySelector('[aria-label="Song analysis settings"]').click()
  })()`)
  await waitFor('!!document.querySelector("#ffmpeg-path")', 'FFmpeg settings are visible')
  await waitFor('!document.querySelector("#ffmpeg-path").disabled', 'FFmpeg settings finish loading')
  assert.ok(await evaluate(`(() => {
    const input = document.querySelector('#ffmpeg-path')
    const section = document.querySelector('#ffmpeg-settings')
    const link = section.querySelector('a[href="https://ffmpeg.org/download.html#build-windows"]')
    return input.labels?.length > 0 && link?.target === '_blank'
      && link.rel.includes('noopener') && section.textContent.includes('ffmpeg.exe')
      && section.textContent.includes('Gyan or BtbN')
      && section.querySelector('.ffmpeg-install-command')?.textContent === 'winget install Gyan.FFmpeg'
  })()`), 'Path has an accessible label, a WinGet install command, and the official Windows download page')
  assert.equal(await evaluate('document.querySelector("#ffmpeg-path").value'), 'ffmpeg',
    'The initial field shows the detected executable')

  const selected = 'C:\\Tools with spaces\\ffmpeg\\bin\\ffmpeg.exe'
  await evaluate(`(() => {
    ffmpegTest.browseCalls = 0
    ffmpegTest.host.browseFfmpegPath = () => {
      ffmpegTest.browseCalls++
      return new Promise(resolve => { ffmpegTest.resolvePicker = resolve })
    }
    document.querySelector('#ffmpeg-settings [aria-label="Browse for FFmpeg executable"]').click()
  })()`)
  await waitFor('document.querySelector("#ffmpeg-path")?.disabled',
    'The field is disabled while the picker is open')
  assert.ok(await evaluate(`document.querySelector('#ffmpeg-path').closest('form')
    .querySelector('button[type="submit"]').disabled`), 'Saving waits for the picker')
  await evaluate(`(() => {
    document.querySelector('#ffmpeg-settings [aria-label="Browse for FFmpeg executable"]').click()
    document.querySelector('#ffmpeg-path').closest('form').requestSubmit()
  })()`)
  assert.equal(await evaluate('ffmpegTest.browseCalls'), 1, 'Repeated clicks do not open another picker')
  assert.deepEqual(await evaluate('ffmpegTest.calls'), [], 'Submitting while browsing does not save')
  await evaluate(`ffmpegTest.resolvePicker({ path: ${JSON.stringify(selected)} })`)
  await waitFor(`document.querySelector('#ffmpeg-path')?.value === ${JSON.stringify(selected)}`,
    'Browsing fills the path field')
  assert.equal(await evaluate('ffmpegTest.browseCalls'), 1)
  assert.deepEqual(await evaluate('ffmpegTest.calls'), [], 'Browsing does not save the selected path')
  await evaluate(`document.querySelector('#ffmpeg-path').closest('form').requestSubmit()`)
  await waitFor('ffmpegTest.calls.length === 1', 'Saving sends the selected path to the host')
  assert.deepEqual(await evaluate('ffmpegTest.calls'), [selected])
  await waitFor('!document.querySelector("#ffmpeg-path").disabled', 'Saving completes')
  await evaluate(`document.querySelector('[aria-label="Close song analysis settings"]').click()`)
  await evaluate(`document.querySelector('[aria-label="Song analysis settings"]').click()`)
  await waitFor(`document.querySelector('#ffmpeg-path')?.value === ${JSON.stringify(selected)}
    && !document.querySelector('#ffmpeg-path').disabled`,
    'Saved path is restored when settings reopen')

  await evaluate(`(() => {
    ffmpegTest.host.browseFfmpegPath = async () => ({ path: null })
    document.querySelector('#ffmpeg-settings [aria-label="Browse for FFmpeg executable"]').click()
  })()`)
  await waitFor('!document.querySelector("#ffmpeg-path").disabled', 'Cancelled browsing completes')
  assert.equal(await evaluate('document.querySelector("#ffmpeg-path").value'), selected,
    'Cancelling the picker keeps the current path')
  await evaluate(`(() => {
    ffmpegTest.host.browseFfmpegPath = () => Promise.reject(new ffmpegTest.HostError({
      code: 'native_picker_unavailable', message: 'The file picker could not open. Enter the full path instead.',
    }))
    document.querySelector('#ffmpeg-settings [aria-label="Browse for FFmpeg executable"]').click()
  })()`)
  await waitFor(`document.querySelector('#ffmpeg-settings [role="alert"]')
    ?.textContent.includes('The file picker could not open')`, 'Picker errors are visible')
  assert.equal(await evaluate('document.querySelector("#ffmpeg-path").value'), selected,
    'A picker error keeps the current path')
  assert.deepEqual(await evaluate('ffmpegTest.calls'), [selected],
    'Cancellation and picker errors do not change saved settings')

  await evaluate(`(() => {
    ffmpegTest.save = ffmpegTest.host.setFfmpegPath
    ffmpegTest.host.setFfmpegPath = () => Promise.reject(new ffmpegTest.HostError({
      code: 'ffmpeg_unavailable', message: 'The selected file is not FFmpeg. Choose ffmpeg.exe.',
    }))
    const input = document.querySelector('#ffmpeg-path')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
      input, 'C:\\\\Tools\\\\not-ffmpeg.exe')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await evaluate(`document.querySelector('#ffmpeg-path').closest('form').requestSubmit()`)
  await waitFor(`document.querySelector('#ffmpeg-settings [role="alert"]')
    ?.textContent.includes('The selected file is not FFmpeg')`, 'Invalid executable error is visible')
  assert.ok(await evaluate(`document.querySelector('#ffmpeg-settings').textContent
    .includes(${JSON.stringify(selected)})`), 'Failed save does not replace the active executable')
  await evaluate(`ffmpegTest.host.setFfmpegPath = ffmpegTest.save`)
  await evaluate(`document.querySelector('[aria-label="Close song analysis settings"]').click()`)
  await evaluate(`document.querySelector('[aria-label="Song analysis settings"]').click()`)
  await waitFor(`document.querySelector('#ffmpeg-path')?.value === ${JSON.stringify(selected)}
    && !document.querySelector('#ffmpeg-path').disabled`,
    'Failed save preserves the saved choice')
  await evaluate(`(() => {
    const reset = [...document.querySelectorAll('#ffmpeg-settings button')]
      .find((button) => button.textContent.trim() === 'Use automatic detection')
    if (!reset) throw new Error('Automatic detection action is missing')
    reset.click()
  })()`)
  await waitFor('ffmpegTest.calls.length === 2 && ffmpegTest.calls[1] === ""',
    'Reset clears the host setting')
  await waitFor('document.querySelector("#ffmpeg-path")?.value === "ffmpeg"',
    'Reset shows the executable found by automatic detection')

  await evaluate(`(async () => {
    document.querySelector('[aria-label="Close song analysis settings"]').click()
    const status = await ffmpegTest.host.ffmpegStatus()
    ffmpegTest.host.ffmpegStatus = async () => ({
      ...status, available: false, configuredPath: '', path: null,
      effectivePath: null, version: null,
      issue: 'FFmpeg is not installed. Download it, extract it, then choose bin\\\\ffmpeg.exe.',
    })
    document.querySelector('[aria-label="Song analysis settings"]').click()
  })()`)
  await waitFor(`document.querySelector('#ffmpeg-settings').textContent
    .includes('FFmpeg is not installed')`, 'Missing FFmpeg shows setup instructions')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 960, height: 900, deviceScaleFactor: 1, mobile: false,
  })
  assert.ok(await evaluate(`(() => {
    const section = document.querySelector('#ffmpeg-settings')
    const input = document.querySelector('#ffmpeg-path')
    return section.scrollWidth <= section.clientWidth + 1
      && input.getBoundingClientRect().right <= section.getBoundingClientRect().right + 1
  })()`), 'FFmpeg settings fit a narrow desktop window')

  await evaluate(`document.querySelector('[aria-label="Close song analysis settings"]').click()`)
  await waitFor('!document.querySelector("#model-settings")', 'Settings close before the next user action')
  await evaluate(`(() => {
    const { host, HostError } = ffmpegTest
    ffmpegTest.wizard = { tokenSaved: false, failToken: true, downloading: false, downloaded: false, downloads: 0 }
    host.cloudStatus = async () => ({ mode: 'local', configured: false, available: false })
    host.hfTokenStatus = async () => ffmpegTest.wizard.tokenSaved
    host.setHfToken = async () => {
      if (ffmpegTest.wizard.failToken) throw new HostError({ code: 'vault_unavailable', message: 'Token could not be saved. Try again.' })
      ffmpegTest.wizard.tokenSaved = true
      return true
    }
    host.modelPreflight = async () => Object.fromEntries(['small', 'medium', 'large'].map(size => [
      'muscriptor-' + size, { eligible: true, reason: null, requiredRamGiB: 6, freeRamGiB: 32 },
    ]))
    host.modelDownloadStatus = async () => Object.fromEntries(['small', 'medium', 'large'].map(size => [
      'muscriptor-' + size, {
        downloaded: size === 'small' && ffmpegTest.wizard.downloaded,
        active: size === 'small' && ffmpegTest.wizard.downloading,
        bytesReceived: 100000000, totalBytes: 412000000, bytesPerSecond: 2000000,
      },
    ]))
    host.startModelDownload = async () => { ffmpegTest.wizard.downloads++; ffmpegTest.wizard.downloading = true }
    document.querySelector('[aria-label="Song analysis settings"]').click()
  })()`)
  await waitFor('!!document.querySelector("#model-settings[open]") && !document.querySelector("#ffmpeg-path").disabled',
    'Settings open as a focused dialog')
  assert.ok(await evaluate(`!document.querySelector('input[name="transcription-model"]')
    && !document.querySelector('select[aria-label="Cloud provider"]')`), 'Only the selected settings topic is visible')
  await evaluate(`[...document.querySelectorAll('#model-settings button')]
    .find(button => button.textContent.trim() === 'Getting started guide').click()`)
  await waitFor('!!document.querySelector(".getting-started-welcome")', 'The guide can be replayed')
  assert.ok(await evaluate('document.activeElement === document.querySelector("#model-settings-title")'),
    'The guide receives keyboard focus')
  for (let index = 0; index < 8; index++) {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    assert.ok(await evaluate('document.querySelector("#model-settings").contains(document.activeElement)'),
      'Tab stays inside the setup dialog')
  }
  const clickGuideButton = async (label) => evaluate(`(() => {
    const button = [...document.querySelectorAll('#model-settings button')]
      .find(button => button.textContent.trim() === ${JSON.stringify(label)})
    if (!button || button.disabled) throw new Error('Guide action is unavailable: ' + ${JSON.stringify(label)})
    button.click()
  })()`)
  await clickGuideButton('Set up song analysis')
  await waitFor('!!document.querySelector("#ffmpeg-path")', 'The first step uses the real audio form')
  assert.equal(await evaluate(`document.querySelector('.getting-started-actions .btn-primary').disabled`), true,
    'Missing audio support prevents continuing')
  assert.equal(await evaluate('document.querySelectorAll(".getting-started-actions").length'), 1, 'One set of guide actions is shown')
  await evaluate(`(() => {
    const input = document.querySelector('#ffmpeg-path')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(selected)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await evaluate(`document.querySelector('#ffmpeg-path').closest('form').requestSubmit()`)
  await waitFor(`!document.querySelector('.getting-started-actions .btn-primary').disabled`, 'Saved FFmpeg enables the next step')
  await clickGuideButton('Continue')
  await waitFor('!!document.querySelector("#hf-token")', 'The second step shows account access')
  assert.equal(await evaluate(`document.querySelector('.getting-started-actions .btn-primary').disabled`), true,
    'No saved token prevents continuing before a model download')
  const enterToken = async () => evaluate(`(() => {
    const input = document.querySelector('#hf-token')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'hf_test_placeholder_not_a_real_token')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await enterToken()
  await evaluate(`document.querySelector('#hf-token').closest('form').requestSubmit()`)
  await waitFor(`document.querySelector('#model-settings [role="alert"]')?.textContent.includes('Token could not be saved')`,
    'Token errors stay visible in the guide')
  assert.equal(await evaluate('document.querySelector("#hf-token").value'), '', 'Failed token entry is cleared')
  await evaluate('ffmpegTest.wizard.failToken = false')
  await enterToken()
  await evaluate(`document.querySelector('#hf-token').closest('form').requestSubmit()`)
  await waitFor(`!document.querySelector('.getting-started-actions .btn-primary').disabled`, 'Saved account access enables the next step')
  await clickGuideButton('Continue')
  await waitFor('!!document.querySelector(\'[aria-label="Download MuScriptor Small"]\')', 'The last step shows model preparation')
  assert.equal(await evaluate(`[...document.querySelectorAll('#model-settings button')].find(button => button.textContent === 'Find a song').disabled`),
    true, 'The guide does not claim readiness before the model download')
  await clickGuideButton('Back')
  await waitFor('!!document.querySelector("#hf-token")', 'Back returns to account access')
  assert.ok(await evaluate(`document.querySelector('.model-settings-access [role="status"]').textContent.includes('Token saved')`),
    'Back retains the saved account state')
  await clickGuideButton('Continue')
  await evaluate(`document.querySelector('[aria-label="Download MuScriptor Small"]').click()`)
  await waitFor('!!document.querySelector(\'[aria-label="MuScriptor Small download"]\')', 'The actual model download shows progress')
  assert.equal(await evaluate('ffmpegTest.wizard.downloads'), 1, 'Only the explicit download click starts a model download')
  await evaluate('ffmpegTest.wizard.downloaded = true; ffmpegTest.wizard.downloading = false')
  await waitFor(`![...document.querySelectorAll('#model-settings button')].find(button => button.textContent === 'Find a song').disabled`,
    'The guide finishes only after audio and the selected model are ready')
  await clickGuideButton('Find a song')
  await waitFor('!document.querySelector("#model-settings")', 'Finishing returns to the library')
  assert.equal(await evaluate(`localStorage.getItem('mizan:getting-started:seen')`), 'true', 'Guide completion is saved')
  assert.ok(await evaluate(`!JSON.stringify({ ...localStorage, ...sessionStorage }).includes('hf_test_placeholder_not_a_real_token')`),
    'Guide preferences do not contain tokens')
  await evaluate(`document.querySelector('[aria-label="Song analysis settings"]').click()`)
  await waitFor('!!document.querySelector(".model-settings-guide")', 'Settings remain available after setup')
  await clickGuideButton('Getting started guide')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 480, height: 720, deviceScaleFactor: 1, mobile: false,
  })
  assert.ok(await evaluate(`(() => {
    const dialog = document.querySelector('#model-settings')
    const box = dialog.getBoundingClientRect()
    return box.left >= 0 && box.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth + 1
  })()`), 'The guide fits a narrow window')
  await clickGuideButton('Set up song analysis')
  await waitFor('!!document.querySelector("#ffmpeg-path")', 'The narrow guide shows audio setup')
  assert.ok(await evaluate(`(() => {
    const section = document.querySelector('#ffmpeg-settings')
    const input = document.querySelector('#ffmpeg-path').getBoundingClientRect()
    const browse = section.querySelector('[aria-label="Browse for FFmpeg executable"]').getBoundingClientRect()
    return section.scrollWidth <= section.clientWidth + 1
      && input.width >= 120 && browse.right <= section.getBoundingClientRect().right + 1
  })()`), 'The path field and Browse button fit a narrow guide')
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await waitFor('!document.querySelector("#model-settings")', 'Escape closes the optional guide')
  assert.ok(await evaluate(`document.activeElement === document.querySelector('[aria-label="Song analysis settings"]')`),
    'Closing restores keyboard focus')
  await evaluate(`(() => {
    const { host } = ffmpegTest
    host.cloudStatus = async (_id, provider = 'azure') => ({
      provider, mode: 'local', available: true, configured: false,
      prepared: false, jobCreated: false, workerImage: null,
    })
    host.azureSubscriptions = async () => [{
      id: '11111111-1111-1111-1111-111111111111', name: 'Test subscription',
      tenantId: '22222222-2222-2222-2222-222222222222',
    }]
    host.selectCloudProvider = async provider => ({ provider })
    host.cloudSettings = async provider => ({ provider, settings: { provider } })
    host.cloudSubscriptions = async () => ({ subscriptions: [{
      projectId: 'preview-project', projectName: 'Preview project', projectNumber: '123456789012', state: 'ACTIVE',
    }] })
    document.querySelector('[aria-label="Song analysis settings"]').click()
  })()`)
  await waitFor('!!document.querySelector(".model-settings-sections")', 'Settings reopen for processing setup')
  await evaluate(`[...document.querySelectorAll('.model-settings-sections button')]
    .find(button => button.textContent.includes('Analysis processing')).click()`)
  await waitFor(`document.querySelector('.cloud-status button')?.textContent === 'Set up Azure'`,
    'Confirmed empty setup offers Azure setup')
  await evaluate(`document.querySelector('.cloud-status button').click()`)
  await waitFor('!!document.querySelector(".cloud-dialog[open]")', 'Azure setup opens')
  await sleep(150)
  assert.ok(await evaluate('!!document.querySelector(".cloud-dialog[open]")'),
    'Strict Mode mounting does not close Azure setup')
  await evaluate(`[...document.querySelectorAll('.cloud-dialog button')].find(button => button.textContent === 'Continue').click()`)
  await waitFor('!!document.querySelector(".cloud-subscription-option")', 'Azure subscriptions load')
  await evaluate(`(() => {
    document.querySelector('.cloud-subscription-picker summary').click()
    document.querySelector('.cloud-subscription-option').click()
  })()`)
  await evaluate(`[...document.querySelectorAll('.cloud-dialog button')].find(button => button.textContent === 'Continue').click()`)
  await waitFor('!!document.querySelector(\'input[name="subnetResourceId"]\')', 'Azure requests the existing subnet first')
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('input[name="cloud-network"]')].map(input => ({ value: input.value, checked: input.checked }))`),
    [{ value: 'existing', checked: true }, { value: 'managed', checked: false }])
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await waitFor('!document.querySelector(".cloud-dialog")', 'Escape closes Azure setup without closing settings')
  assert.ok(await evaluate('document.activeElement === document.querySelector(".cloud-status button")'),
    'Cloud setup returns focus to its settings action')
  await evaluate(`(() => {
    const select = document.querySelector('[aria-label="Cloud provider"]')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'gcp')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await waitFor(`document.querySelector('.cloud-status button')?.textContent === 'Set up Google Cloud'`, 'Provider selection changes the setup action')
  await evaluate(`document.querySelector('.cloud-status button').click()`)
  await waitFor('!!document.querySelector(".cloud-dialog[open]") && !!document.querySelector(\'select[name="projectId"]:not(:disabled)\')', 'Google Cloud project discovery opens')
  await sleep(150)
  assert.ok(await evaluate('!!document.querySelector(".cloud-dialog[open]")'),
    'Strict Mode mounting does not close provider setup')
  await evaluate(`(() => {
    const select = document.querySelector('select[name="projectId"]')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'preview-project')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await evaluate(`[...document.querySelectorAll('.cloud-dialog button')].find(button => button.textContent === 'Continue').click()`)
  await waitFor(`document.querySelector('input[name="bucket"]')?.value === 'mizan-preview-project'`, 'The discovered project fills resource names')
  await evaluate(`document.querySelector('[aria-label="Close Google Cloud setup"]').click()`)
  await waitFor('!document.querySelector(".cloud-dialog")', 'Provider setup closes explicitly')
  await evaluate(`document.querySelector('[aria-label="Close song analysis settings"]').click()`)
  await waitFor('!document.querySelector("#model-settings")', 'Processing settings close')
  assert.deepEqual(await evaluate('ffmpegTest.errors'), [], 'No uncaught interface errors')
  await call('Page.navigate', { url })
  await waitFor('!!document.querySelector(".lib-main")', 'The app reloads')
  await sleep(1100)
  assert.equal(await evaluate('!!document.querySelector("#model-settings")'), false, 'A completed guide does not reopen on reload')
  console.log('Audio and guided setup: current path, browse/busy/cancel/error, save/reopen/reset, readiness, token errors, model download, Back, completion, keyboard focus, narrow layout, and persistence passed.')
} finally {
  socket?.close()
  if (browser.exitCode === null && !launchError) {
    const stopped = new Promise((resolve) => browser.once('exit', resolve))
    browser.kill()
    await stopped
  }
  await server?.close()
  await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
