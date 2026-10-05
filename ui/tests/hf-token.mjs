// Run with Vite on localhost:5173: node tests\hf-token.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const profile = await mkdtemp(join(process.cwd(), '.mizan-hf-test-'))
const browser = spawn(process.env.MIZAN_TEST_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank',
], { stdio: 'ignore' })
let socket
try {
  let port
  for (let i = 0; i < 100; i++) {
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
    if (message.id) pending.get(message.id)?.(message)
  }
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 15000)
    pending.set(id, (reply) => {
      clearTimeout(timer)
      pending.delete(id)
      if (reply.error) reject(new Error(JSON.stringify(reply.error)))
      else resolve(reply.result)
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text)
    return result.result.value
  }
  await call('Page.enable')
  await call('Runtime.enable')
  await call('Page.navigate', { url: 'http://localhost:5173' })
  for (let i = 0; i < 100 && !await evaluate('!!document.querySelector(".lib-main")'); i++) await sleep(100)
  assert.ok(await evaluate('!!document.querySelector(".lib-main")'), 'Library loaded')
  const configured = await evaluate(`(async () => {
    const button = [...document.querySelectorAll('button')].find(el => /hugging face|model access|settings/i.test(el.textContent + ' ' + el.getAttribute('aria-label')))
    if (!button) throw new Error('Hugging Face settings button missing')
    button.click()
    await new Promise(resolve => setTimeout(resolve, 100))
    document.querySelector('.model-settings-access summary').click()
    const input = document.querySelector('input[type="password"]')
    if (!input || !input.labels?.length) throw new Error('Credential needs an accessible password label')
    const token = 'hf_browser_test_only_placeholder'
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, token)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.closest('form').querySelector('button[type="submit"]').click()
    for (let i = 0; i < 50 && input.value; i++) await new Promise(resolve => setTimeout(resolve, 50))
    if (input.value || document.body.textContent.includes(token)) throw new Error('Credential remained visible after save')
    if (JSON.stringify({ ...localStorage, ...sessionStorage }).includes(token)) throw new Error('Browser persisted credential')
    const status = () => input.closest('.model-settings-access').querySelector('[role="status"]').textContent
    const saved = status() === 'Token saved'
    if (document.querySelector('button[aria-label="Download MuScriptor Large"]')?.disabled) throw new Error('Saved token did not enable model download')
    const clear = [...document.querySelectorAll('button')].find(el => /^(remove|clear)( token)?$/i.test(el.textContent.trim()))
    if (!clear) throw new Error('Configured credential cannot be removed')
    clear.click()
    for (let i = 0; i < 50 && status() !== 'No token saved'; i++)
      await new Promise(resolve => setTimeout(resolve, 50))
    if (!saved || status() !== 'No token saved') return false
    if (!document.querySelector('button[aria-label="Download MuScriptor Large"]')?.disabled) throw new Error('Download remained enabled after removing token')
    const appSource = await (await fetch('/src/App.tsx')).text()
    const bridgeUrl = appSource.match(/from "([^"]*bridge\\.ts[^"]*)"/)?.[1]
    if (!bridgeUrl) throw new Error('Could not resolve application bridge')
    const { host, HostError } = await import(bridgeUrl)
    const original = host.setHfToken
    try {
      host.setHfToken = () => Promise.reject(new HostError({ code: 'vault_unavailable', message: 'Credential Manager unavailable' }))
      setter.call(input, token)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.closest('form').querySelector('button[type="submit"]').click()
      for (let i = 0; i < 50 && !input.closest('.model-settings-access').querySelector('[role="alert"]'); i++)
        await new Promise(resolve => setTimeout(resolve, 50))
      const message = input.closest('.model-settings-access').querySelector('[role="alert"]')?.textContent
      if (!message?.includes('Credential Manager unavailable')) throw new Error('Credential storage failure is hidden: ' + JSON.stringify({
        message, disabled: input.closest('form').querySelector('button[type="submit"]').disabled, status: status(),
      }))
      if (input.value || document.body.textContent.includes(token)) throw new Error('Failed credential remained visible')
      return status() === 'No token saved'
    } finally {
      host.setHfToken = original
    }
  })()`)
  assert.ok(configured, 'Settings confirms saved and removed credentials without exposing them')
  assert.ok(await evaluate(`(async () => {
    const small = document.querySelector('input[value="muscriptor-small"]')
    const large = document.querySelector('input[value="muscriptor-large"]')
    if (!small?.checked || !large || document.querySelector('input[value="standard"]')) throw new Error('Initial model choice: ' + JSON.stringify({
      small: small?.checked, large: !!large, errors: document.querySelector('.model-settings [role="alert"]')?.textContent,
    }))
    for (let i = 0; i < 50 && large.disabled; i++) await new Promise(resolve => setTimeout(resolve, 50))
    if (large.disabled) throw new Error('Large unavailable: ' + large.closest('.model-settings-item').textContent)
    large.click()
    for (let i = 0; i < 50 && !large.checked; i++) await new Promise(resolve => setTimeout(resolve, 50))
    if (!large.checked) throw new Error('Large did not become selected')
    document.querySelector('[aria-label="Close song analysis settings"]').click()
    document.querySelector('[aria-label="Song analysis settings"]').click()
    for (let i = 0; i < 50 && !document.querySelector('input[value="muscriptor-large"]')?.checked; i++)
      await new Promise(resolve => setTimeout(resolve, 50))
    const saved = document.querySelector('input[value="muscriptor-large"]')?.checked
    const appSource = await (await fetch('/src/App.tsx')).text()
    const bridgeUrl = appSource.match(/from "([^"]*bridge\\.ts[^"]*)"/)?.[1]
    const { host, HostError } = await import(bridgeUrl)
    const input = document.querySelector('input[type="password"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'hf_browser_test_only_placeholder')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.closest('form').querySelector('button[type="submit"]').click()
    const download = document.querySelector('button[aria-label="Download MuScriptor Large"]')
    for (let i = 0; i < 50 && download?.disabled; i++) await new Promise(resolve => setTimeout(resolve, 50))
    if (!download || download.disabled || !large.closest('.model-settings-item').querySelector('.model-settings-metadata')?.textContent.includes('parameters'))
      throw new Error('Download state: ' + JSON.stringify({ button: !!download, disabled: download?.disabled,
        metadata: large.closest('.model-settings-item').querySelector('.model-settings-metadata')?.textContent,
        access: document.querySelector('.model-settings-access [role="status"]')?.textContent,
        model: large.closest('.model-settings-item').textContent }))
    download.click()
    const largeDownload = () => document.querySelector('input[value="muscriptor-large"]').closest('.model-settings-item').querySelector('.model-settings-download')
    for (let i = 0; i < 50 && !largeDownload().querySelector('progress')?.value; i++)
      await new Promise(resolve => setTimeout(resolve, 50))
    const progress = largeDownload().querySelector('progress')
    const showsDownload = progress && progress.value > 0 &&
      largeDownload().textContent.includes('MB/s')
    await host.clearHfToken()
    const original = host.setTranscriptionModel
    try {
      host.setTranscriptionModel = () => Promise.reject(new HostError({ code: 'unavailable', message: 'Cannot save model choice' }))
      document.querySelector('input[value="muscriptor-small"]').click()
      for (let i = 0; i < 50 && !document.querySelector('.model-settings-choices + p + p[role="alert"]'); i++)
        await new Promise(resolve => setTimeout(resolve, 50))
      if (!saved) throw new Error('Model choice was not restored after reopening settings')
      if (!showsDownload) throw new Error('Download progress was not shown')
      if (!document.querySelector('input[value="muscriptor-large"]').checked) throw new Error('Failed save changed model choice')
      if (!document.querySelector('.model-settings [role="alert"]')?.textContent.includes('Cannot save model choice'))
        throw new Error('Model choice failure was not displayed')
      return true
    } finally {
      host.setTranscriptionModel = original
    }
  })()`), 'Model choice persists across reopening and errors preserve the previous selection')
  assert.ok(await evaluate(`(async () => {
    const appSource = await (await fetch('/src/App.tsx')).text()
    const bridgeUrl = appSource.match(/from "([^"]*bridge\\.ts[^"]*)"/)?.[1]
    const { host } = await import(bridgeUrl)
    const original = host.modelPreflight
    document.querySelector('[aria-label="Close song analysis settings"]').click()
    await new Promise(resolve => setTimeout(resolve, 50))
    host.modelPreflight = async () => ({
      'muscriptor-small': { eligible: true, reason: null, requiredRamGiB: 6, freeRamGiB: 12 },
      'muscriptor-medium': { eligible: true, reason: null, requiredRamGiB: 10, freeRamGiB: 12 },
      'muscriptor-large': { eligible: false, reason: 'MuScriptor Large needs 20 GiB free RAM (12 GiB available). Close other apps or choose a smaller model.', requiredRamGiB: 20, freeRamGiB: 12 },
    })
    try {
      document.querySelector('[aria-label="Song analysis settings"]').click()
      for (let i = 0; i < 50 && !document.querySelector('input[value="muscriptor-large"]')?.disabled; i++)
        await new Promise(resolve => setTimeout(resolve, 50))
      const large = document.querySelector('input[value="muscriptor-large"]')
      return large.disabled && large.closest('.model-settings-item').textContent.includes('20 GiB free RAM') &&
        !document.querySelector('input[value="muscriptor-medium"]').disabled &&
        document.querySelector('input[value="muscriptor-small"]').disabled === false
    } finally {
      host.modelPreflight = original
    }
  })()`), 'Insufficient RAM blocks Large but leaves smaller models selectable with a clear reason')
  const wheel = await evaluate(`(() => {
    const main = document.querySelector('.lib-main')
    const panel = document.querySelector('.model-settings')
    main.scrollTop = 200
    panel.scrollTop = 0
    const box = panel.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, main: main.scrollTop }
  })()`)
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: wheel.x, y: wheel.y })
  await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wheel.x, y: wheel.y, deltaX: 0, deltaY: 320 })
  await sleep(150)
  const scroll = await evaluate(`({
    main: document.querySelector('.lib-main').scrollTop,
    panel: document.querySelector('.model-settings').scrollTop,
  })`)
  assert.equal(scroll.main, wheel.main, 'Background library does not scroll while settings are open')
  assert.ok(scroll.panel > 0, 'Wheel scrolls the settings panel')
  assert.ok(await evaluate(`(async () => {
    const appSource = await (await fetch('/src/App.tsx')).text()
    const bridgeUrl = appSource.match(/from "([^"]*bridge\\.ts[^"]*)"/)?.[1]
    const { host, HostError } = await import(bridgeUrl)
    window.__mizanNativeShell = true
    try {
      await host.setHfToken('hf_browser_test_only_placeholder')
      return false
    } catch (error) {
      return error instanceof HostError && error.code === 'host_unavailable'
    } finally {
      window.__mizanNativeShell = false
    }
  })()`), 'A native shell with a missing bridge must never silently save in the mock')
  console.log('Hugging Face settings browser checks passed')
} finally {
  socket?.close()
  if (browser.exitCode === null && browser.signalCode === null) {
    const exited = new Promise(resolve => browser.once('exit', resolve))
    browser.kill()
    await Promise.race([exited, sleep(5000)])
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 })
}
