// Run with Vite on localhost:5173: node tests\cloud-subscriptions.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const profile = await mkdtemp(join(process.cwd(), '.mizan-cloud-test-'))
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
  await call('Page.enable')
  await call('Page.navigate', { url: 'http://localhost:5173/@vite/client' })
  const reply = await call('Runtime.evaluate', {
    expression: `(async () => {
      let calls = 0
      let complete
      window.pywebview = { api: new Proxy({}, { get: (_, name) => name === 'then' ? undefined : () => {
        calls++
        return new Promise((resolve) => { complete = resolve })
      } }) }
      const { host } = await import('/src/library/bridge.ts?cloud-subscriptions-test')
      const first = host.azureSubscriptions()
      const duplicate = host.azureSubscriptions()
      await new Promise((resolve) => setTimeout(resolve, 10))
      if (calls !== 1) throw new Error('Overlapping subscription requests were sent to Azure')
      complete({ ok: true, subscriptions: [{ id: 'saved', name: 'Saved', tenantId: 'tenant' }] })
      const [a, b] = await Promise.all([first, duplicate])
      if (a[0].id !== 'saved' || b[0].id !== 'saved') throw new Error('The shared result was lost')
      const refresh = host.azureSubscriptions()
      await new Promise((resolve) => setTimeout(resolve, 10))
      if (calls !== 2) throw new Error('Refresh did not send a new request')
      complete({ ok: false, error: { code: 'cloud_failed', message: 'Azure list failed' } })
      try { await refresh; throw new Error('Failed list was accepted') }
      catch (error) { if (error.message !== 'Azure list failed') throw error }
      const retry = host.azureSubscriptions()
      await new Promise((resolve) => setTimeout(resolve, 10))
      if (calls !== 3) throw new Error('The failed request remained cached')
      complete({ ok: true, subscriptions: [{ id: 'saved', name: 'Saved', tenantId: 'tenant' }] })
      return (await retry)[0].id === 'saved'
    })()`,
    awaitPromise: true, returnByValue: true,
  })
  assert.ok(!reply.exceptionDetails, reply.exceptionDetails?.exception?.description)
  assert.equal(reply.result.value, true)
  const recovery = await call('Runtime.evaluate', {
    expression: `(async () => {
      const source = await (await fetch('/src/library/CloudSetup.tsx')).text()
      const bridgeUrl = source.match(/from "([^"]*bridge[^"]*)"/)?.[1]
      if (!bridgeUrl) throw new Error('Cloud setup bridge not found')
      const { host } = await import(bridgeUrl)
      const React = (await import('/node_modules/.vite/deps/react.js')).default
      const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
      const { CloudSetup } = await import('/src/library/CloudSetup.tsx')
      const status = { configured: false, mode: 'local', prepared: false,
        workerImage: 'registry.azurecr.io/worker@sha256:pinned', config: { subscriptionId: 'saved' } }
      let attempts = 0
      host.azureSubscriptions = () => { throw new Error('Recovery must not list subscriptions') }
      host.hfTokenStatus = async () => true
      host.cloudStatus = async () => ({ ...status, prepared: true })
      host.prepareCloud = async (config, consent) => {
        if (!consent || !config.resumePartial || config.existingPilot !== false)
          throw new Error('Recovery must obtain approval and resume the saved infrastructure')
        attempts++
        if (attempts === 1) throw new Error('GPU environment still unavailable')
        return { prepared: true }
      }
      const container = document.createElement('div')
      container.id = 'cloud-recovery-test'
      document.body.append(container)
      createRoot(container).render(React.createElement(CloudSetup,
        { status, onStatus: () => {}, onClose: () => {} }))
      const wait = async (condition) => {
        for (let i = 0; i < 100; i++) {
          if (condition()) return
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        throw new Error('Recovery view did not update')
      }
      const button = (text) => [...container.querySelectorAll('button')]
        .find((item) => item.textContent.includes(text))
      await wait(() => button('Retry GPU environment'))
      if (!container.textContent.includes('already built')
          || container.textContent.includes('Build GPU worker')
          || container.textContent.includes('Your Azure resources are ready')
          || !button('Retry GPU environment').disabled)
        throw new Error('Recovery replays setup or skips cost approval')
      container.querySelector('input[type="checkbox"]').click()
      await wait(() => !button('Retry GPU environment').disabled)
      button('Retry GPU environment').click()
      await wait(() => container.textContent.includes('GPU environment still unavailable'))
      if (attempts !== 1 || !button('Retry GPU environment').disabled)
        throw new Error('Failed retry was treated as approved or completed')
      container.querySelector('input[type="checkbox"]').click()
      await wait(() => !button('Retry GPU environment').disabled)
      button('Retry GPU environment').click()
      await wait(() => button('Create manual GPU Job'))
      if (attempts !== 2 || !container.textContent.includes('GPU worker built and ready'))
        throw new Error('Recovery did not return to the saved worker')
      return true
    })()`,
    awaitPromise: true, returnByValue: true,
  })
  assert.ok(!recovery.exceptionDetails, recovery.exceptionDetails?.exception?.description)
  assert.equal(recovery.result.value, true)
  console.log('Cloud subscriptions coalesce; failed GPU environments resume from the built worker with renewed consent.')
} finally {
  socket?.close()
  if (browser.exitCode === null && browser.signalCode === null) {
    const exited = new Promise((resolve) => browser.once('exit', resolve))
    browser.kill()
    await Promise.race([exited, sleep(5000)])
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 })
}
