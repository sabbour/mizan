import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const uiRoot = dirname(here)
const projectRoot = dirname(uiRoot)
const profile = join(projectRoot, `.release-update-test-profile-${process.pid}`)
const evidenceDir = process.env.MIZAN_RELEASE_UPDATE_EVIDENCE_DIR
  ? resolve(process.env.MIZAN_RELEASE_UPDATE_EVIDENCE_DIR)
  : join(projectRoot, 'artifacts', `release-update-evidence-${process.pid}`)
const browserPath = process.env.MIZAN_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const fixtureKey = 'mizan:dev-release-update-fixture'
const server = await createServer({ root: uiRoot, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
await server.listen()
let browser
let socket

try {
  const updates = await server.ssrLoadModule('/src/release/updates.ts')
  assert.deepEqual(updates.parseReleaseVersion('v0.2.7'), [0, 2, 7, 0])
  assert.deepEqual(updates.parseReleaseVersion('0.2.30.26'), [0, 2, 30, 26])
  assert.equal(updates.compareReleaseVersions('0.2.30.26', '0.2.7.0'), 1)
  assert.equal(updates.compareReleaseVersions('0.2.7', 'v0.2.7.0'), 0)
  for (const invalid of ['v0.2', '0.2.7.0.1', 'v0.2.7-beta', '0.02.7', '0.-2.7', '65536.2.7']) {
    assert.equal(updates.parseReleaseVersion(invalid), null, `${invalid} is rejected`)
  }

  const summary = updates.summarizeReleaseNotes(
    'Mizan adds a concise update summary. Release links stay in the browser. <script>alert(1)</script> ![cover](https://example.invalid/image.png)\n\n## Detailed changelog\n- Do not include this list.',
  )
  assert.equal(summary, 'Mizan adds a concise update summary. Release links stay in the browser.')
  assert.ok(!summary.includes('<script') && !summary.includes('cover') && !summary.includes('Detailed changelog'))
  assert.equal(
    updates.summarizeReleaseNotes('## Changelog\n\n## What’s new in v0.2.8\nMizan adds a concise update summary. Release links stay in the browser.'),
    'Mizan adds a concise update summary. Release links stay in the browser.',
    'A leading changelog heading is skipped in favor of the opening summary.',
  )
  assert.equal(
    updates.summarizeReleaseNotes('<h2>Release notes</h2>\n\nMizan adds a concise update summary.'),
    'Mizan adds a concise update summary.',
    'An HTML release-notes heading does not become the summary.',
  )
  assert.ok(updates.summarizeReleaseNotes('') === null)
  assert.ok(updates.summarizeReleaseNotes(`A ${'long '.repeat(120)}summary.`).length <= 360)
  assert.equal(updates.summarizeReleaseNotes(`A ${'long '.repeat(120)}summary.`).match(/[.!?](?:\s|$)/g)?.length ?? 0, 0)

  const releasePayload = {
    tag_name: 'v0.2.8',
    draft: false,
    prerelease: false,
    html_url: 'https://github.com/sabbour/mizan/releases/tag/v0.2.8',
    body: 'A new release.',
    assets: [{
      name: 'Mizan_0.2.8_x64.msix',
      state: 'uploaded',
      size: 1024,
      browser_download_url: 'https://github.com/sabbour/mizan/releases/download/v0.2.8/Mizan_0.2.8_x64.msix',
    }],
  }
  const payload = (overrides = {}) => ({ ...releasePayload, ...overrides })
  const hostResponse = {
    status: 'checked',
    currentVersion: '0.2.7.0',
    architecture: 'x64',
    releasePayload: JSON.stringify(releasePayload),
    message: null,
  }
  const validUpdate = updates.validateReleaseUpdateResult(hostResponse)
  assert.equal(validUpdate.status, 'update-available')
  assert.equal(validUpdate.latestVersion, '0.2.8.0')
  assert.equal(updates.validateReleaseUpdateResult({ ...hostResponse, releasePayload: '{bad json' }).status, 'unavailable')
  assert.equal(updates.validateReleaseUpdateResult({ ...hostResponse, architecture: 'arm64' }).status, 'unavailable')
  assert.equal(updates.validateReleaseUpdateResult({
    ...hostResponse, releasePayload: JSON.stringify(payload({ draft: true })),
  }).status, 'unavailable')
  assert.equal(updates.validateReleaseUpdateResult({
    ...hostResponse, releasePayload: JSON.stringify(payload({ prerelease: true })),
  }).status, 'unavailable')
  assert.equal(updates.validateReleaseUpdateResult({
    ...hostResponse, releasePayload: JSON.stringify(payload({ tag_name: 'v0.2.8-rc.1' })),
  }).status, 'unavailable')
  assert.equal(updates.validateReleaseUpdateResult({
    ...hostResponse, releasePayload: JSON.stringify(payload({ html_url: 'https://example.invalid/v0.2.8' })),
  }).status, 'unavailable')
  assert.equal(updates.validateReleaseUpdateResult({
    ...hostResponse,
    releasePayload: JSON.stringify(payload({ assets: [{ ...releasePayload.assets[0], state: 'new' }] })),
  }).status, 'unavailable')
  assert.equal(updates.validateReleaseUpdateResult({
    ...hostResponse,
    releasePayload: JSON.stringify(payload({ assets: [{ ...releasePayload.assets[0], name: 'Mizan_0.2.8_arm64.msix' }] })),
  }).status, 'unavailable')
  assert.equal(updates.validateReleaseUpdateResult({
    ...hostResponse,
    releasePayload: JSON.stringify(payload({ assets: [{
      ...releasePayload.assets[0],
      browser_download_url: 'https://example.invalid/Mizan_0.2.8_x64.msix',
    }] })),
  }).status, 'unavailable')
  assert.equal(updates.validateReleaseUpdateResult({
    ...hostResponse, releasePayload: JSON.stringify(payload({ tag_name: 'v0.2.7', assets: [] })),
  }).status, 'up-to-date')
  assert.equal(updates.validateReleaseUpdateResult({
    ...hostResponse,
    currentVersion: '0.2.30.26',
    releasePayload: JSON.stringify(payload({ tag_name: 'v0.2.7', assets: [] })),
  }).status, 'up-to-date', 'A remote tag cannot downgrade a higher local major/minor/revision version.')
  assert.equal(updates.validateReleaseUpdateResult({
    ...hostResponse,
    currentVersion: '0.2.7.1',
    releasePayload: JSON.stringify(payload({ tag_name: 'v0.2.7', assets: [] })),
  }).status, 'up-to-date', 'The local fourth version part prevents a downgrade.')
  assert.equal(updates.validateReleaseUpdateResult({
    ...hostResponse,
    currentVersion: '0.2.7.0',
    releasePayload: JSON.stringify(payload({ tag_name: 'v0.2.7', assets: [] })),
  }).status, 'up-to-date', 'An equal three-part release matches a zero local revision.')
  const arm64Asset = {
    name: 'Mizan_0.2.8_arm64.msix',
    state: 'uploaded',
    size: 1024,
    browser_download_url: 'https://github.com/sabbour/mizan/releases/download/v0.2.8/Mizan_0.2.8_arm64.msix',
  }
  assert.equal(updates.validateReleaseUpdateResult({
    ...hostResponse,
    architecture: 'arm64',
    releasePayload: JSON.stringify(payload({ assets: [arm64Asset] })),
  }).status, 'update-available', 'A matching uploaded ARM64 package is eligible.')
  const revisionAsset = {
    name: 'Mizan_0.2.7.1_x64.msix',
    state: 'uploaded',
    size: 1024,
    browser_download_url: 'https://github.com/sabbour/mizan/releases/download/v0.2.7.1/Mizan_0.2.7.1_x64.msix',
  }
  const revisionRelease = payload({
    tag_name: 'v0.2.7.1',
    html_url: 'https://github.com/sabbour/mizan/releases/tag/v0.2.7.1',
    assets: [revisionAsset],
  })
  assert.equal(updates.validateReleaseUpdateResult({
    ...hostResponse,
    releasePayload: JSON.stringify(revisionRelease),
  }).status, 'update-available', 'Nonzero package revisions require the exact four-part asset filename.')
  assert.equal(updates.validateReleaseUpdateResult({
    ...hostResponse,
    releasePayload: JSON.stringify(payload({
      ...revisionRelease,
      assets: [{
        ...revisionAsset,
        name: 'Mizan_0.2.7_x64.msix',
        browser_download_url: 'https://github.com/sabbour/mizan/releases/download/v0.2.7.1/Mizan_0.2.7_x64.msix',
      }],
    })),
  }).status, 'unavailable', 'A three-part asset cannot satisfy a nonzero package revision.')
  assert.equal(updates.validateReleaseUpdateResult({
    status: 'unsupported', currentVersion: null, architecture: null, releasePayload: null,
    message: 'Package identity is unavailable.',
  }).status, 'unsupported')
  assert.equal(updates.validateReleaseUpdateResult({
    status: 'unavailable', message: 'GitHub is offline.',
  }).message, 'GitHub is offline.')

  const React = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { ReleaseUpdateNotice } = await server.ssrLoadModule('/src/release/ReleaseUpdateNotice.tsx')
  const emptySummaryMarkup = renderToStaticMarkup(React.createElement(ReleaseUpdateNotice, {
    version: 'v0.2.8',
    summary: updates.summarizeReleaseNotes(''),
    releaseUrl: 'https://github.com/sabbour/mizan/releases/tag/v0.2.8',
    onDismiss: () => {},
  }))
  assert.ok(emptySummaryMarkup.includes('See the release notes for what’s new.'),
    'An empty release body directs users to the release notes.')

  const now = 2_000_000_000_000
  assert.equal(updates.isBackgroundCheckDue(null, now), true)
  assert.equal(updates.isBackgroundCheckDue(String(now - 23 * 60 * 60 * 1000), now), false)
  assert.equal(updates.isBackgroundCheckDue(String(now - 24 * 60 * 60 * 1000), now), true)
  assert.equal(updates.isBackgroundCheckDue('bad', now), true)
  assert.equal(updates.isBackgroundCheckDue(String(now + 1), now), true)
  assert.equal(updates.shouldShowUpdateNotification('update-available', validUpdate.latestVersion, validUpdate.latestVersion, false), false)
  assert.equal(updates.shouldShowUpdateNotification('update-available', validUpdate.latestVersion, validUpdate.latestVersion, true), true)
  assert.equal(updates.shouldShowUpdateNotification('up-to-date', validUpdate.latestVersion, null, true), false)

  const preferences = new Map()
  let nowValue = now
  let checks = 0
  const createController = (check = async () => {
    checks++
    return hostResponse
  }) => new updates.ReleaseUpdateController({
    check,
    readLastAttempt: () => preferences.get('last') ?? null,
    readDismissedVersion: () => preferences.get('dismissed') ?? null,
    writeLastAttempt: (value) => preferences.set('last', value),
    writeDismissedVersion: (value) => preferences.set('dismissed', value),
    now: () => nowValue,
  })

  const startup = createController()
  await startup.start()
  assert.equal(checks, 1, 'A due launch check calls the fixture host once.')
  assert.equal(startup.getSnapshot().showNotification, true, 'A new update is shown after startup.')
  await startup.start()
  assert.equal(checks, 1, 'The launch check runs once per app lifetime.')
  startup.dismiss()
  assert.equal(preferences.get('dismissed'), '0.2.8.0', 'Dismissal persists the exact normalized version.')
  assert.equal(startup.getSnapshot().showNotification, false)
  nowValue += 1000
  await startup.start()
  assert.equal(checks, 1, 'Dismissed updates do not trigger another launch check.')
  await startup.check(true)
  assert.equal(checks, 2, 'Manual check bypasses the launch cadence.')
  assert.equal(startup.getSnapshot().showNotification, true, 'A manual check intentionally resurfaces a dismissed version.')

  nowValue += 24 * 60 * 60 * 1000
  preferences.set('last', String(nowValue - 24 * 60 * 60 * 1000))
  const dismissedLaunch = createController()
  await dismissedLaunch.start()
  assert.equal(checks, 3)
  assert.equal(dismissedLaunch.getSnapshot().showNotification, false, 'A dismissed version stays quiet on a later launch.')
  await dismissedLaunch.check(true)
  assert.equal(checks, 4, 'A manual check can intentionally show the dismissed version again.')
  assert.equal(dismissedLaunch.getSnapshot().showNotification, true)

  preferences.set('last', String(nowValue - 60 * 60 * 1000))
  const recentLaunch = createController()
  await recentLaunch.start()
  assert.equal(checks, 4, 'A recent launch attempt observes the daily cadence.')
  await recentLaunch.check(true)
  assert.equal(checks, 5, 'Manual checks remain available inside the launch cadence.')

  const manualCooldown = createController()
  await manualCooldown.check(true)
  assert.equal(checks, 6)
  nowValue += 1000
  await manualCooldown.check(true)
  assert.equal(checks, 6, 'Repeated manual checks are throttled.')
  assert.match(manualCooldown.getSnapshot().statusMessage, /Try again/, 'The manual cooldown explains when to try again.')
  nowValue += 60_000
  await manualCooldown.check(true)
  assert.equal(checks, 7, 'Manual checking is available again after the cooldown.')

  let resolveDeferred
  let coalescedCalls = 0
  preferences.delete('last')
  const coalesced = createController(() => {
    coalescedCalls++
    return new Promise((resolve) => { resolveDeferred = resolve })
  })
  const backgroundRequest = coalesced.start()
  await Promise.resolve()
  const manualRequest = coalesced.check(true)
  assert.equal(coalescedCalls, 1, 'Concurrent startup and manual checks share one host request.')
  resolveDeferred(hostResponse)
  await Promise.all([backgroundRequest, manualRequest])
  assert.equal(coalesced.getSnapshot().showNotification, true, 'The joined manual check can resurface the result.')

  const warningCalls = []
  const originalWarn = console.warn
  console.warn = (...args) => warningCalls.push(args)
  preferences.delete('last')
  const invalidBackground = createController(async () => ({
    status: 'checked',
    currentVersion: '0.2.7.0',
    architecture: 'x64',
    releasePayload: 'invalid JSON containing remote release notes',
  }))
  try {
    await invalidBackground.start()
  } finally {
    console.warn = originalWarn
  }
  assert.equal(invalidBackground.getSnapshot().result?.status, 'unavailable')
  assert.equal(invalidBackground.getSnapshot().statusMessage, null,
    'A malformed background response stays quiet in the app UI.')
  assert.deepEqual(warningCalls, [['GitHub release background check returned unavailable result.']],
    'An unavailable validation result emits one bounded diagnostic without remote payload text.')

  let failingCalls = 0
  preferences.delete('last')
  const failure = createController(async () => {
    failingCalls++
    throw new Error('The mocked release service is offline.')
  })
  await failure.start()
  assert.equal(failure.getSnapshot().checking, false)
  assert.equal(failure.getSnapshot().statusMessage, null, 'A failed background check is silent.')
  await failure.check(true)
  assert.equal(failingCalls, 2)
  assert.match(failure.getSnapshot().statusMessage, /offline/, 'Manual failures are reported accurately.')
  console.log('Release update policy: versions, summaries, trusted links, cadence, startup, manual checks, coalescing, failures, and dismissal passed.')

  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  await mkdir(profile, { recursive: true })
  await mkdir(evidenceDir, { recursive: true })
  browser = spawn(browserPath, ['--headless=new', '--mute-audio', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--disable-sync', 'about:blank'], { stdio: 'ignore' })
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let port
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch { await sleep(100) }
  }
  assert.ok(port, 'The fixture browser has a debugging endpoint')
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const address = new URL(targets.find((item) => item.type === 'page').webSocketDebuggerUrl)
  address.hostname = '127.0.0.1'
  socket = new WebSocket(address.href)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let sequence = 0
  const pending = new Map()
  const pageLoadWaiters = new Set()
  const fixtureRequests = []
  const runtimeEvents = []
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === 'Page.loadEventFired') {
      for (const resolveLoaded of pageLoadWaiters) resolveLoaded()
      pageLoadWaiters.clear()
    }
    if (message.method === 'Network.requestWillBeSent'
      && message.params.request.url.includes('example.invalid'))
      fixtureRequests.push(message.params.request.url)
    if (message.method === 'Runtime.consoleAPICalled' || message.method === 'Runtime.exceptionThrown') {
      const params = message.params
      const text = message.method === 'Runtime.exceptionThrown'
        ? params.exceptionDetails?.text ?? params.exceptionDetails?.exception?.description
        : (params.args ?? []).map((argument) => argument.value ?? argument.description ?? '').join(' ')
      runtimeEvents.push({ type: params.type ?? 'exception', text: String(text).slice(0, 300) })
      if (runtimeEvents.length > 25) runtimeEvents.shift()
    }
    if (message.id) pending.get(message.id)?.(message)
  }
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 30000)
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
  const waitFor = async (expression, description) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return
      await sleep(100)
    }
    throw new Error(`Timed out: ${description}`)
  }
  const waitForPageLoad = () => {
    let loadedHandler
    const loaded = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pageLoadWaiters.delete(loadedHandler)
        reject(new Error('Page reload timed out'))
      }, 30000)
      loadedHandler = () => {
        clearTimeout(timeout)
        resolve()
      }
      pageLoadWaiters.add(loadedHandler)
    })
    return loaded
  }
  const navigatePage = async (url) => {
    const loaded = waitForPageLoad()
    await call('Page.navigate', { url })
    await loaded
  }
  const reloadPage = async () => {
    const loaded = waitForPageLoad()
    await call('Page.reload', { ignoreCache: true })
    await loaded
  }
  const waitForReleaseNotification = async () => {
    try {
      await waitFor('!!document.querySelector(".release-update-notice")', 'actual App release notification')
    } catch (error) {
      let state
      try {
        state = await evaluate(`(() => {
          let fixture = null
          try { fixture = JSON.parse(localStorage.getItem(${JSON.stringify(fixtureKey)}) || 'null') } catch {}
          return {
            readyState: document.readyState,
            fixtureStatus: fixture?.releaseUpdate?.status ?? null,
            fixtureKeys: fixture && typeof fixture === 'object' ? Object.keys(fixture) : [],
            releasePayloadLength: fixture?.releaseUpdate?.releasePayload?.length ?? null,
            lastAttempt: localStorage.getItem('mizan:release-update:last-attempt'),
            dismissedVersion: localStorage.getItem('mizan:release-update:dismissed-version'),
            notification: !!document.querySelector('.release-update-notice'),
            aboutStatus: document.querySelector('.about-update-check [role=status]')?.textContent?.trim() ?? null,
          }
        })()`)
      } catch (diagnosticError) {
        state = { diagnosticError: diagnosticError instanceof Error ? diagnosticError.message : 'Page state unavailable.' }
      }
      const reason = error instanceof Error ? error.message : 'Update notification timed out.'
      throw new Error(`${reason}; runtime state=${JSON.stringify({ ...state, runtimeEvents })}`)
    }
  }
  const capture = async (name) => {
    const shot = await call('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(evidenceDir, name), Buffer.from(shot.data, 'base64'))
  }
  await call('Page.enable')
  await call('Runtime.enable')
  await call('Network.enable')
  await call('Network.setBlockedURLs', { urls: ['https://*'] })
  await call('Emulation.setDeviceMetricsOverride', { width: 1360, height: 820, deviceScaleFactor: 1, mobile: false })
  const base = server.resolvedUrls.local[0].replace(/\/$/, '')
  const emptyHostFixture = {
    releaseUpdate: {
      status: 'unsupported',
      currentVersion: null,
      latestVersion: null,
      tagName: null,
      releaseNotes: null,
      releaseUrl: null,
      message: 'Synthetic browser fixture.',
    },
    libraryEntries: [],
    folderEntries: [],
    queueJobs: [],
  }
  const seedFixture = `(() => {
    try {
      if (!localStorage.getItem(${JSON.stringify(fixtureKey)})) {
        localStorage.setItem(${JSON.stringify(fixtureKey)}, ${JSON.stringify(JSON.stringify(emptyHostFixture))})
        localStorage.removeItem('mizan:release-update:dismissed-version')
        localStorage.removeItem('mizan:release-update:last-attempt')
      }
    } catch {}
  })()`
  await call('Page.addScriptToEvaluateOnNewDocument', { source: seedFixture })
  await navigatePage(`${base}/`)
  await waitFor('!!document.querySelector(".lib-about")', 'actual App library')
  await waitFor('document.querySelector(".library-first-note")?.textContent.includes("Your songs and practice progress will appear here")',
    'empty synthetic library and queue fixture')
  const addFixtureLabel = () => evaluate(`(() => {
    if (document.querySelector('.test-fixture-label')) return true
    const label = document.createElement('div')
    label.className = 'test-fixture-label'
    label.textContent = 'Synthetic release fixture'
    Object.assign(label.style, {
      position: 'fixed', bottom: '8px', left: '8px', zIndex: 1000, pointerEvents: 'none',
      padding: '4px 8px', border: '1px solid #9b7b00', borderRadius: '6px',
      color: '#3b2f00', background: '#fff4ce', font: '600 11px/1.2 sans-serif',
    })
    document.body.appendChild(label)
    return true
  })()`)
  await addFixtureLabel()
  await sleep(200)
  assert.equal(await evaluate('!!document.querySelector(".release-update-notice")'), false,
    'No update is shown before the synthetic update is installed.')
  assert.equal(await evaluate("/Tears for Fears|Nirvana|Stevie Wonder|Beethoven/.test(document.body.textContent)"),
    false, 'The evidence uses no commercial-name library entries.')
  await capture('release-update-before.png')

  const expectedSummary = 'Mizan 0.2.8 adds a synthetic update to the library. It also demonstrates safe release-note summaries.'
  const fixtureReleasePayload = {
    tag_name: 'v0.2.8',
    draft: false,
    prerelease: false,
    html_url: 'https://github.com/sabbour/mizan/releases/tag/v0.2.8',
    body: `## What’s new in v0.2.8\n${expectedSummary} <script>localStorage.setItem('mizan:release-update-fixture-executed', 'yes')</script><img src="https://example.invalid/update-payload.png" onerror="localStorage.setItem('mizan:release-update-fixture-executed', 'yes')">\n\n## Changelog\n- Details are intentionally omitted.`,
    assets: [{
      name: 'Mizan_0.2.8_x64.msix',
      state: 'uploaded',
      size: 1024,
      browser_download_url: 'https://github.com/sabbour/mizan/releases/download/v0.2.8/Mizan_0.2.8_x64.msix',
    }],
  }
  const updateFixture = {
    status: 'checked',
    currentVersion: '0.2.7.0',
    architecture: 'x64',
    releasePayload: JSON.stringify(fixtureReleasePayload),
    message: null,
  }
  const updateFixtureScript = await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      try {
        localStorage.removeItem('mizan:release-update-fixture-executed')
        localStorage.removeItem('mizan:release-update:dismissed-version')
        localStorage.removeItem('mizan:release-update:last-attempt')
        localStorage.setItem(${JSON.stringify(fixtureKey)}, ${JSON.stringify(JSON.stringify({
          ...emptyHostFixture,
          releaseUpdate: updateFixture,
        }))})
      } catch {}
    })()`,
  })
  await reloadPage()
  await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: updateFixtureScript.identifier })
  await waitForReleaseNotification()
  await addFixtureLabel()
  await waitFor(
    `document.querySelector('.release-update-summary')?.textContent === ${JSON.stringify(expectedSummary)}`,
    'sanitized two-sentence release summary',
  )
  assert.equal(await evaluate('!!document.querySelector(".release-update-summary img, .release-update-summary script")'),
    false, 'Untrusted release markup is rendered as safe text only.')
  assert.equal(await evaluate("localStorage.getItem('mizan:release-update-fixture-executed')"), null,
    'Release markup cannot execute script or image event handlers.')
  assert.deepEqual(fixtureRequests, [], 'The synthetic release cannot request its remote image.')
  await capture('release-update-after.png')
  await call('Emulation.setDeviceMetricsOverride', { width: 800, height: 640, deviceScaleFactor: 1.5, mobile: false })
  await sleep(120)
  await capture('release-update-compact.png')
  await call('Emulation.setDeviceMetricsOverride', { width: 1360, height: 820, deviceScaleFactor: 1, mobile: false })

  await evaluate("document.querySelector('#lib-tab-course')?.click()")
  await waitFor('document.querySelector("#lib-panel-course")?.hidden === false && !!document.querySelector(".course-lesson")',
    'actual App Course tab')
  await evaluate("document.querySelector('.course-lesson')?.click()")
  await waitFor('!!document.querySelector(".ws") && !!document.querySelector(".transport-main .play")',
    'original built-in sample lesson')
  assert.equal(await evaluate('!!document.querySelector(".release-update-notice")'), true,
    'The global update notification survives navigation into a sample lesson.')

  const layoutMeasurements = []
  for (const [width, height, scale] of [[1360, 820, 1], [800, 640, 1.5], [390, 844, 1], [800, 540, 1], [390, 540, 1]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: width < 600 })
    await sleep(120)
    const layout = await evaluate(`(() => {
      const box = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect()
        return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width }
      }
      return { notice: box('.release-update-notice'), toolbar: box('.transport[role="toolbar"]'), viewport: { width: innerWidth, height: innerHeight },
        link: document.querySelector('.release-update-link').href,
        text: document.querySelector('.release-update-summary').textContent,
        scrollWidth: document.documentElement.scrollWidth }
    })()`)
    assert.ok(layout.notice.left >= -0.5 && layout.notice.right <= width + 0.5, `${width} wide: update card stays on screen`)
    assert.ok(layout.scrollWidth <= width, `${width} wide: no horizontal overflow`)
    assert.equal(layout.link, 'https://github.com/sabbour/mizan/releases/tag/v0.2.8')
    assert.equal(layout.text, expectedSummary)
    layoutMeasurements.push({ width, height, notice: layout.notice, toolbar: layout.toolbar })
  }
  assert.ok(layoutMeasurements.every(({ notice, toolbar }) => notice.bottom < toolbar.top),
    `The update card stays clear of playback controls at every viewport (${JSON.stringify(layoutMeasurements)})`)

  await call('Emulation.setDeviceMetricsOverride', { width: 1360, height: 820, deviceScaleFactor: 1, mobile: false })
  await evaluate("document.querySelector('.transport-main .play')?.click()")
  await waitFor("document.querySelector('.transport-main .play')?.getAttribute('aria-label') === 'Pause' && !!document.querySelector('.release-update-notice')",
    'sample lesson playback active alongside the update notification')
  await evaluate("document.querySelector('.ws-back')?.click()")
  await waitFor('!!document.querySelector(".lib-about")', 'return to the actual library')
  await evaluate("document.querySelector('.lib-about')?.click()")
  await waitFor('!!document.querySelector(".about-dialog[open]")', 'actual About dialog')
  await evaluate("document.querySelector('.about-links button')?.click()")
  await waitFor('document.querySelector(".credits h1")?.textContent === "Credits"',
    'actual Credits route')
  assert.equal(await evaluate('!!document.querySelector(".release-update-notice")'), true,
    'The global notification survives navigation to Credits.')
  await evaluate("document.querySelector('.credits-back')?.click()")
  await waitFor('!!document.querySelector(".lib-about")', 'return from Credits')
  await waitFor('!!document.querySelector(".release-update-notice")', 'notification after returning from Credits')

  await evaluate('document.querySelector(".release-update-dismiss").focus()')
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  assert.equal(await evaluate('!!document.querySelector(".release-update-notice")'), false, 'Keyboard activation dismisses the update')
  assert.equal(await evaluate("localStorage.getItem('mizan:release-update:dismissed-version')"), '0.2.8.0',
    'Dismissal persists the normalized release version.')
  await reloadPage()
  await waitFor('!!document.querySelector(".lib-about")', 'actual App after reload')
  await addFixtureLabel()
  await sleep(200)
  assert.equal(await evaluate('!!document.querySelector(".release-update-notice")'), false,
    'A dismissed update stays hidden after reload.')
  await evaluate("document.querySelector('.lib-about')?.click()")
  await waitFor('!!document.querySelector(".about-dialog[open]")', 'About dialog after reload')
  assert.equal(await evaluate("document.querySelector('.about-update-check button')?.textContent.trim()"),
    'Check for updates')
  await evaluate("document.querySelector('.about-update-check button')?.click()")
  await waitFor('document.querySelector(".about-update-check [role=status]")?.textContent.includes("available")',
    'manual About check result')
  await waitFor('!!document.querySelector(".release-update-notice")', 'manual check resurfaces dismissed update')
  assert.equal(await evaluate('document.querySelector(".release-update-summary")?.textContent'),
    expectedSummary, 'The safe summary is also preserved when a manual check resurfaces the update.')
  assert.deepEqual(fixtureRequests, [], 'No untrusted release resource was requested during manual checking.')
  await call('Emulation.setDeviceMetricsOverride', { width: 1360, height: 820, deviceScaleFactor: 1, mobile: false })
  await addFixtureLabel()
  await capture('release-update-about.png')

  console.log('Release update UI: actual App startup fixture, Course/lesson and Credits navigation, sample playback, responsive transport clearance, safe notes, keyboard dismissal, reload persistence, and manual resurfacing passed.')
  console.log(`Actual App screenshots (synthetic release fixture) saved under ${evidenceDir}.`)
} finally {
  try { socket?.send(JSON.stringify({ id: 999999, method: 'Browser.close' })) } catch { /* the fixture browser may have closed already */ }
  await new Promise((resolve) => setTimeout(resolve, 250))
  if (browser && browser.exitCode === null) browser.kill()
  await server.close()
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
}
