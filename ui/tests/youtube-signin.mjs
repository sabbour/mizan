// Run from ui: node tests\youtube-signin.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'vite'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function installTestHost() {
  const authChart = {
    title: 'YouTube Music',
    fetchedAt: new Date().toISOString(),
    sections: [{
      id: 'auth-playlist',
      title: 'Test playlist',
      publisher: 'YouTube Music',
      sourceUrl: 'https://music.youtube.com/playlist?list=test',
      kind: 'editorial',
      status: 'unavailable',
      requiresAuth: true,
      message: 'YouTube Music requires sign-in to load this playlist.',
      rows: [],
      description: '',
      chartDate: '',
    }],
  }
  const successChart = {
    title: 'YouTube Music',
    fetchedAt: new Date().toISOString(),
    warning: 'One playlist could not be refreshed.',
    sections: [{
      id: 'auth-playlist',
      title: 'Test playlist',
      publisher: 'YouTube Music',
      sourceUrl: 'https://music.youtube.com/playlist?list=test',
      kind: 'editorial',
      status: 'available',
      requiresAuth: false,
      rows: [{
        videoId: '78wrful9cVU',
        title: 'Test playlist song',
        artist: 'Test artist',
        thumbnail: 'https://i.ytimg.com/vi/78wrful9cVU/hqdefault.jpg',
      }],
      description: '',
      chartDate: '',
    }],
  }
  const state = window.__mizanYoutubeTest = {
    requests: [],
    popularPlan: [],
    pendingPopular: [],
    signInSucceeds: false,
    authenticated: false,
    authChart,
    successChart,
    errors: [],
  }
  window.__mizanNativeShell = true
  window.pywebview = {
    api: new Proxy({}, {
      get(_target, method) {
        if (method === 'then' || typeof method !== 'string') return undefined
        return (...args) => {
          state.requests.push({ method, args })
          if (method === 'popular_songs') {
            const mode = state.popularPlan.shift() ?? 'success'
            if (mode === 'auth') return Promise.resolve({ ok: true, ...state.authChart })
            if (mode === 'pending')
              return new Promise((resolve) => state.pendingPopular.push(resolve))
            return Promise.resolve({ ok: true, ...state.successChart })
          }
          if (method === 'youtube_sign_in') {
            if (state.signInSucceeds) state.authenticated = true
            return Promise.resolve({ ok: true, signedIn: state.signInSucceeds })
          }
          if (method === 'youtube_auth_status') {
            return Promise.resolve({
              ok: true,
              signedIn: state.authenticated,
              source: state.authenticated ? 'app' : null,
            })
          }
          if (method === 'youtube_sign_out') {
            state.authenticated = false
            return Promise.resolve({ ok: true, signedIn: false, source: null })
          }
          if (method === 'list_library') return Promise.resolve({ ok: true, entries: [] })
          if (method === 'list_folders') return Promise.resolve({ ok: true, folders: [] })
          if (method === 'list_queue') return Promise.resolve({ ok: true, jobs: [] })
          if (method === 'resource_usage') return Promise.resolve({ ok: true, usage: null })
          if (method === 'cloud_providers')
            return Promise.resolve({ ok: true, providers: [], activeProvider: null })
          if (method === 'ffmpeg_status')
            return Promise.resolve({
              ok: true, configuredPath: null, effectivePath: 'ffmpeg', available: true, issue: null,
            })
          if (method === 'get_transcription_model')
            return Promise.resolve({ ok: true, model: 'muscriptor-small' })
          if (method === 'hf_token_status') return Promise.resolve({ ok: true, configured: false })
          if (method === 'model_preflight') return Promise.resolve({ ok: true, models: {} })
          if (method === 'model_download_status') return Promise.resolve({ ok: true, models: {} })
          return Promise.resolve({ ok: true })
        }
      },
    }),
  }
  addEventListener('error', (event) => state.errors.push(event.message))
  addEventListener('unhandledrejection', (event) => state.errors.push(String(event.reason)))
}

const server = await createServer({
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
})
await server.listen()
const url = server.resolvedUrls.local[0]
const profile = join(process.cwd(), '..', `.youtube-signin-test-profile-${process.pid}`)
await rm(profile, { recursive: true, force: true })
await mkdir(profile, { recursive: true })
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
  const browserErrors = []
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    const resolve = pending.get(message.id)
    if (resolve) resolve(message)
    else if (message.method === 'Runtime.exceptionThrown')
      browserErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text)
    else if (message.method === 'Log.entryAdded')
      browserErrors.push(message.params.entry.text)
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
    const details = await evaluate(`JSON.stringify({
      href: location.href,
      readyState: document.readyState,
      title: document.title,
      text: document.body?.innerText?.slice(0, 500),
      requests: window.__mizanYoutubeTest?.requests.map(request => request.method),
      pendingPopular: window.__mizanYoutubeTest?.pendingPopular.length,
      buttons: [...document.querySelectorAll('.popular-music button')].map(button => button.textContent.trim()),
      shelf: document.querySelector('.popular-shelf')?.innerHTML.slice(0, 800),
    })`)
    assert.fail(`Timed out: ${description}; page=${details}; errors=${browserErrors.join(' | ')}`)
  }

  await call('Page.enable')
  await call('Runtime.enable')
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `(${installTestHost.toString()})();`,
  })
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  })
  await call('Page.navigate', { url })
  await waitFor('!!document.querySelector(".lib-main")', 'Library loads')
  await evaluate(`document.querySelector('#lib-tab-discover').click()`)
  await waitFor('!!document.querySelector(".popular-music")', 'Discover playlists appear')
  await waitFor('document.querySelector(".popular-music")?.getAttribute("aria-busy") === "false"',
    'Initial playlist data loads')

  await evaluate(`document.querySelector('[aria-label="Song analysis settings"]').click()`)
  await waitFor(`document.querySelector('#youtube-auth-status')?.textContent.includes('Not signed in')`,
    'YouTube settings report a signed-out session')
  assert.ok(await evaluate(`(() => {
    const section = document.querySelector('.model-settings-youtube')
    const labels = [...section.querySelectorAll('button')].map(button => button.textContent.trim())
    return labels.includes('Sign in to YouTube') && !labels.includes('Sign out')
  })()`), 'Signed-out settings show sign-in and hide sign-out')
  await evaluate(`document.querySelector('[aria-label="Close song analysis settings"]').click()`)

  await evaluate(`window.__mizanYoutubeTest.popularPlan.push('auth', 'auth', 'success', 'pending', 'pending');
    document.querySelector('#lib-tab-catalog').click()`)
  await waitFor('!document.querySelector(".popular-music")', 'Discover playlists unmount')
  await evaluate(`document.querySelector('#lib-tab-discover').click()`)
  await waitFor(`document.querySelector('.popular-music')?.getAttribute('aria-busy') === 'false'
    && [...document.querySelectorAll('.popular-music button')]
      .some(button => button.textContent.trim() === 'Sign in to YouTube')`,
  'An auth-required playlist exposes a sign-in action')
  assert.ok(await evaluate(`document.querySelector('.popular-shelf .popular-chart-error')
    ?.textContent.includes('Sign in to YouTube')`),
  'The playlist-level sign-in action stays next to its auth failure')

  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.popular-music button')]
      .find(item => item.textContent.trim() === 'Sign in to YouTube')
    window.__mizanYoutubeTest.signInSucceeds = false
    button.click()
  })()`)
  await waitFor(`document.querySelector('.popular-music .popular-chart-warning')
    ?.textContent.includes('sign-in was not completed')`,
  'Cancelled sign-in is announced beside the playlist failure')

  const successfulSignInStart = await evaluate('window.__mizanYoutubeTest.requests.length')
  await evaluate(`(() => {
    window.__mizanYoutubeTest.signInSucceeds = true
    const button = [...document.querySelectorAll('.popular-music button')]
      .find(item => item.textContent.trim() === 'Sign in to YouTube')
    button.click()
  })()`)
  await waitFor(`document.querySelector('.popular-music')?.getAttribute('aria-busy') === 'false'
    && document.querySelector('.popular-music-card')?.textContent.includes('Test playlist song')
    && ![...document.querySelectorAll('.popular-music button')]
      .some(button => button.textContent.trim() === 'Sign in to YouTube')`,
  'Successful sign-in retries and restores the playlist')
  assert.deepEqual(await evaluate(`window.__mizanYoutubeTest.requests.slice(${successfulSignInStart})
    .map(request => request.method)`),
  ['youtube_auth_status', 'youtube_sign_in', 'youtube_auth_status', 'popular_songs'],
  'A successful native sign-in is followed by status refresh and playlist retry')
  assert.equal(await evaluate('window.__mizanYoutubeTest.authenticated'), true,
    'The refreshed authentication status reflects the saved session')

  await evaluate(`(() => {
    const button = [...document.querySelectorAll('.popular-music button')]
      .find(item => item.textContent.trim() === 'Retry playlists')
    button.click()
  })()`)
  assert.ok(await evaluate(`document.querySelector('.popular-music')?.getAttribute('aria-busy') === 'true'
    && [...document.querySelectorAll('.popular-music button')]
      .filter(button => ['Loading…', 'Retry playlists'].includes(button.textContent.trim()))
      .some(button => button.disabled)`),
  'Retry immediately announces loading and disables duplicate requests')
  assert.equal(await evaluate('window.__mizanYoutubeTest.pendingPopular.length'), 1,
    'The playlist request remains pending for the loading-state assertion')
  await evaluate(`window.__mizanYoutubeTest.pendingPopular.shift()({
    ok: true, ...window.__mizanYoutubeTest.successChart,
  })`)
  await waitFor(`document.querySelector('.popular-music')?.getAttribute('aria-busy') === 'false'
    && document.querySelector('.popular-music-card')?.textContent.includes('Test playlist song')`,
  'A successful playlist retry clears loading')

  await evaluate(`document.querySelector('.popular-music .popular-chart-warning button').click()`)
  assert.ok(await evaluate(`document.querySelector('.popular-music')?.getAttribute('aria-busy') === 'true'
    && [...document.querySelectorAll('.popular-music button')]
      .filter(button => ['Loading…', 'Retry playlists'].includes(button.textContent.trim()))
      .some(button => button.disabled)`),
  'A second retry also enters its busy state before completion')
  await evaluate(`window.__mizanYoutubeTest.pendingPopular.shift()({
    ok: false, error: { code: 'youtube_playlist_unavailable', message: 'Playlist refresh failed. Retry.' },
  })`)
  await waitFor(`document.querySelector('.popular-music')?.getAttribute('aria-busy') === 'false'
    && document.querySelector('.popular-music .popular-chart-error')
      ?.textContent.includes('Playlist refresh failed')`,
  'A failed playlist retry clears loading and exposes recovery')
  assert.ok(await evaluate(`document.querySelector('.popular-music-card')
    ?.textContent.includes('Test playlist song')`),
  'A failed refresh preserves the last successful playlist rows')

  await evaluate(`window.__mizanYoutubeTest.popularPlan.push('auth');
    document.querySelector('.popular-music .popular-chart-error .btn-quiet').click()`)
  await waitFor(`document.querySelector('.popular-music')?.getAttribute('aria-busy') === 'false'
    && [...document.querySelectorAll('.popular-music button')]
      .some(button => button.textContent.trim() === 'Sign in to YouTube')`,
  'An authenticated session can still reach the playlist sign-in action')
  const alreadySignedInStart = await evaluate('window.__mizanYoutubeTest.requests.length')
  await evaluate(`(() => {
    window.__mizanYoutubeTest.authenticated = true
    ;[...document.querySelectorAll('.popular-music button')]
      .find(button => button.textContent.trim() === 'Sign in to YouTube').click()
  })()`)
  await waitFor(`document.querySelector('.popular-music')?.getAttribute('aria-busy') === 'false'
    && document.querySelector('.popular-music-card')?.textContent.includes('Test playlist song')
    && ![...document.querySelectorAll('.popular-music button')]
      .some(button => button.textContent.trim() === 'Sign in to YouTube')`,
  'An existing saved session retries the playlist without opening sign-in')
  assert.deepEqual(await evaluate(`window.__mizanYoutubeTest.requests.slice(${alreadySignedInStart})
    .map(request => request.method)`),
  ['youtube_auth_status', 'popular_songs'],
  'An existing saved session is checked before retry and skips the native sign-in window')

  await evaluate(`document.querySelector('[aria-label="Song analysis settings"]').click()`)
  await waitFor(`document.querySelector('#youtube-auth-status')?.textContent.includes('Signed in to YouTube in the Mizan app')`,
    'YouTube settings report the app-managed session')
  assert.ok(await evaluate(`(() => {
    const section = document.querySelector('.model-settings-youtube')
    const primary = section.querySelector('.youtube-auth-actions .btn-primary')
    const labels = [...section.querySelectorAll('button')].map(button => button.textContent.trim())
    return primary?.textContent.trim() === 'Sign out'
      && labels.includes('Sign out') && !labels.includes('Sign in to YouTube')
  })()`), 'Signed-in settings make sign-out primary and hide sign-in')
  await evaluate(`document.querySelector('.model-settings-youtube .btn-primary').click()`)
  await waitFor(`document.querySelector('#youtube-auth-status')?.textContent.includes('Not signed in')
    && [...document.querySelectorAll('.model-settings-youtube button')]
      .some(button => button.textContent.trim() === 'Sign in to YouTube')`,
  'Signing out restores the sign-in action')
  assert.ok(await evaluate(`![...document.querySelectorAll('.model-settings-youtube button')]
    .some(button => button.textContent.trim() === 'Sign out')`),
  'Signed-out settings hide sign-out')
  await evaluate(`document.querySelector('[aria-label="Close song analysis settings"]').click()`)

  const nativeResult = await evaluate(`(async () => {
    const calls = []
    const webview = new EventTarget()
    webview.postMessage = request => {
      calls.push(request.method)
      const result = request.method === 'youtube_sign_in'
        ? { ok: true, signedIn: true }
        : { ok: true, signedIn: true, source: 'app' }
      queueMicrotask(() => webview.dispatchEvent(new MessageEvent('message', {
        data: { id: request.id, ok: true, result },
      })))
    }
    window.chrome ??= {}
    window.chrome.webview = webview
    const { host } = await import('/src/library/bridge.ts?youtube-native-contract')
    return {
      signIn: await host.youtubeSignIn(),
      status: await host.youtubeAuthStatus(),
      calls,
    }
  })()`)
  assert.deepEqual(nativeResult, {
    signIn: { ok: true, signedIn: true },
    status: { ok: true, signedIn: true, source: 'app' },
    calls: ['youtube_sign_in', 'youtube_auth_status'],
  }, 'The real bridge accepts nested native success replies and refreshes auth status')
  assert.deepEqual(await evaluate('window.__mizanYoutubeTest.errors'), [],
    'Sign-in and retry flows produce no uncaught UI errors')

  console.log('YouTube sign-in and playlist recovery: signed-in/out settings, saved-session no-flash retry, cancellation feedback, nested native reply/status refresh, auth recovery, retry busy/disabled state, success, rejection, and stale-item preservation passed.')
} finally {
  socket?.close()
  if (browser.exitCode === null && !launchError) {
    const stopped = new Promise((resolve) => browser.once('exit', resolve))
    browser.kill()
    await stopped
  }
  await server.close()
  await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
