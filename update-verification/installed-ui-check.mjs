import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { inspectPianoMusic, inspectPianoScales, inspectPianoProgressions, inspectPianoInspired } from './piano-music-check.mjs'

const root = dirname(fileURLToPath(import.meta.url))
async function stopOwnedBrowsers(profile) {
  const ownedProfile = profile.replaceAll("'", "''")
  await promisify(execFile)('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" | ` +
    `Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${ownedProfile}') } | ` +
    `ForEach-Object { try { Stop-Process -Id $_.ProcessId -ErrorAction Stop } ` +
    `catch { if ($_.FullyQualifiedErrorId -notlike 'NoProcessFoundForGivenId,*') { throw } } }`,
  ], { timeout: 60000 })
}
const preview = process.argv.includes('--preview')
const previewPortArgument = process.argv.find(arg => arg.startsWith('--preview-port='))
const previewPort = previewPortArgument?.slice('--preview-port='.length) ?? '5199'
assert.ok(!previewPortArgument || preview, 'A preview port requires preview mode')
assert.ok(/^[1-9]\d{0,4}$/.test(previewPort) && Number(previewPort) <= 65535, 'The preview port must be 1 through 65535')
const visualCheckpoint = process.argv.includes('--visual-checkpoint')
const loadCheck = process.argv.includes('--load-check')
const controlsCheck = process.argv.includes('--controls-check')
const handsCheck = process.argv.includes('--hands-check') || controlsCheck
const musicCheck = process.argv.includes('--music-check')
const catalogCheck = process.argv.includes('--catalog-check')
const scalesInspiredCheck = process.argv.includes('--scales-inspired-check')
const progressionsCheck = process.argv.includes('--progressions-check')
const homeCheck = process.argv.includes('--home-check')
const viewMemoryCheck = process.argv.includes('--view-memory-check')
const viewMemoryPhase = process.argv.find(arg => arg.startsWith('--view-memory-phase='))?.split('=')[1]
const sharedProfile = process.argv.find(arg => arg.startsWith('--view-memory-profile='))?.slice('--view-memory-profile='.length)
const viewMemoryPairs = [
  { piano: 'hands', drums: 'kit' },
  { piano: 'keyboard', drums: 'score' },
  { piano: 'score', drums: 'kit' },
]
if (viewMemoryCheck && viewMemoryPhase === undefined) {
  const restartProfile = await mkdtemp(join(root, 'installed-edge-view-memory-'))
  try {
    for (let phase = 0; phase <= viewMemoryPairs.length; phase++) {
      const { stdout } = await promisify(execFile)(process.execPath, [
        fileURLToPath(import.meta.url), ...process.argv.slice(2),
        `--view-memory-phase=${phase}`, `--view-memory-profile=${restartProfile}`,
      ], { timeout: 240000, maxBuffer: 1024 * 1024 })
      process.stdout.write(stdout)
    }
  } finally {
    await stopOwnedBrowsers(restartProfile)
    await rm(restartProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 })
  }
  process.exit(0)
}
assert.ok(viewMemoryPhase === undefined || viewMemoryCheck, 'A restart phase requires the view-memory check')
assert.ok(sharedProfile === undefined || (viewMemoryCheck && viewMemoryPhase !== undefined && sharedProfile.length > 0 &&
  dirname(resolve(sharedProfile)) === root && basename(sharedProfile).startsWith('installed-edge-view-memory-')),
  'A shared restart profile must belong to this verification run')
if (viewMemoryPhase !== undefined) assert.ok(/^[0-3]$/.test(viewMemoryPhase), 'The restart phase must be 0 through 3')
const partialCheck = visualCheckpoint || handsCheck
assert.ok(!visualCheckpoint || preview, 'An incomplete curriculum checkpoint cannot certify the installed update')
assert.ok(!loadCheck || preview, 'A load diagnosis cannot certify the installed update')
assert.ok(!handsCheck || preview, 'A hands-only diagnosis cannot certify the installed update')
assert.ok(!musicCheck || preview, 'A source music diagnosis cannot certify the installed update')
assert.ok(!catalogCheck || preview, 'A source catalog diagnosis cannot certify the installed update')
assert.ok(!scalesInspiredCheck || preview, 'A source scale/inspired diagnosis cannot certify the installed update')
assert.ok(!progressionsCheck || preview, 'A source progression diagnosis cannot certify the installed update')
const url = preview ? `http://127.0.0.1:${previewPort}/` : 'http://127.0.0.1:5398/'
const artifact = progressionsCheck ? 'source-progressions' : scalesInspiredCheck ? 'source-scales-inspired' : catalogCheck ? 'source-catalog' : musicCheck ? 'piano-music' : loadCheck ? 'preview-load' : controlsCheck ? 'checkpoint-controls' : handsCheck ? 'checkpoint-hands' : visualCheckpoint ? 'checkpoint-visual' : preview ? 'preview-ui' : 'installed-ui'
const resultArtifact = viewMemoryCheck ? `view-memory-${preview ? 'preview' : 'installed'}-${viewMemoryPhase}` : homeCheck ? 'home-shelves' : artifact
const profile = sharedProfile ?? await mkdtemp(join(root, 'installed-edge-'))
const browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  '--headless=new', '--remote-debugging-pipe', '--no-first-run',
  '--force-device-scale-factor=1.5', '--autoplay-policy=no-user-gesture-required', '--mute-audio', `--user-data-dir=${profile}`,
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
const exited = new Promise((resolve) => browser.once('exit', resolve))
const pending = new Map(), errors = [], failedRequests = [], httpErrors = [], requestUrls = new Map()
const inflightRequests = new Map(), audioContexts = new Map()
const viteSockets = new Set(), viteUpdates = []
let readFailureContext, checkFailure
let sequence = 0, buffer = ''
browser.stdio[4].on('data', (chunk) => {
  buffer += chunk.toString()
  let end
  while ((end = buffer.indexOf('\0')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    if (message.id) {
      const entry = pending.get(message.id)
      if (!entry) continue
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map((arg) => arg.value ?? arg.description))
    else if (message.method === 'Network.requestWillBeSent') {
      requestUrls.set(message.params.requestId, message.params.request.url)
      inflightRequests.set(message.params.requestId, {
        url: message.params.request.url, type: message.params.type, started: message.params.timestamp,
      })
    }
    else if (message.method === 'Network.loadingFinished') inflightRequests.delete(message.params.requestId)
    else if (message.method === 'Network.loadingFailed') {
      inflightRequests.delete(message.params.requestId)
      failedRequests.push({
        url: requestUrls.get(message.params.requestId), error: message.params.errorText,
        type: message.params.type, canceled: message.params.canceled,
      })
    }
    else if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) httpErrors.push({
      url: message.params.response.url, status: message.params.response.status,
      type: message.params.type, mime: message.params.response.mimeType,
    })
    else if (message.method === 'Network.webSocketCreated') {
      const socket = new URL(message.params.url)
      if (['localhost', '127.0.0.1'].includes(socket.hostname) && socket.port === previewPort) viteSockets.add(message.params.requestId)
    }
    else if (message.method === 'Network.webSocketFrameReceived' && viteSockets.has(message.params.requestId) &&
      message.params.response.opcode === 1 && message.params.response.payloadData.startsWith('{')) {
      const update = JSON.parse(message.params.response.payloadData)
      if (['update', 'full-reload', 'error'].includes(update.type)) viteUpdates.push({
        type: update.type, time: message.params.timestamp,
        paths: update.updates?.map(item => item.path) ?? [],
      })
    }
    else if (['WebAudio.contextCreated', 'WebAudio.contextChanged'].includes(message.method)) {
      audioContexts.set(message.params.context.contextId, message.params.context)
    }
    else if (message.method === 'WebAudio.contextWillBeDestroyed') audioContexts.delete(message.params.contextId)
  }
})
function command(method, params = {}, sessionId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0')
  })
}
try {
  const version = await command('Browser.getVersion')
  const { targetId } = await command('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true })
  const call = (method, params) => command(method, params, sessionId)
  const evaluate = async (expression) => {
    const reply = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails))
    return reply.result.value
  }
  readFailureContext = () => evaluate(`({
    url: location.href, readyState: document.readyState,
    preferences: /^https?:$/.test(location.protocol) ? localStorage.getItem('mizan:practice') : undefined,
    startupErrors: globalThis.__installedStartupErrors,
    resizeNotifications: globalThis.__installedResizeNotifications,
    body: document.body?.innerText.slice(0, 4000),
    root: document.querySelector('#root')?.innerHTML.slice(0, 4000),
    inspired: document.querySelector('#course-inspired')?.closest('section')?.outerHTML.slice(0, 18000),
    overlay: document.querySelector('vite-error-overlay')?.shadowRoot?.textContent.slice(0, 4000),
    scripts: Array.from(document.scripts).map(script => script.src),
    controls: [...document.querySelectorAll('button[aria-pressed], .chordview-option')].map(button => ({
      text: button.textContent, label: button.getAttribute('aria-label'), title: button.getAttribute('title'),
      pressed: button.getAttribute('aria-pressed'), checked: button.getAttribute('aria-checked'), data: {...button.dataset},
    })),
    piano: document.querySelector('.practice-piano') && {
      data: {...document.querySelector('.practice-piano').dataset},
      badges: [...document.querySelectorAll('.piano-finger')].map(finger => finger.outerHTML),
    },
    hands: document.querySelector('.practice-hands') && {
      data: {...document.querySelector('.practice-hands').dataset},
      drawnText: document.querySelector('.practice-hands canvas')?.__installedDrawnText,
    },
  })`)
  await call('Runtime.enable')
  await call('Page.enable')
  await call('Network.enable')
  await call('WebAudio.enable')
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.__installedStartupErrors = [];
    globalThis.__installedResizeNotifications = [];
    addEventListener('error', event => {
      if (!event.error && event.message === 'ResizeObserver loop completed with undelivered notifications.') {
        globalThis.__installedResizeNotifications.push({time: performance.now(), message: event.message});
        console.warn(event.message);
      } else globalThis.__installedStartupErrors.push(event.message);
    });
    addEventListener('unhandledrejection', event => globalThis.__installedStartupErrors.push(String(event.reason)));
    const clearRect = CanvasRenderingContext2D.prototype.clearRect;
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.clearRect = function(...args) {
      if (this.canvas.closest('.practice-hands')) this.canvas.__installedDrawnText = [];
      return clearRect.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...args) {
      const result = fillText.call(this, text, x, y, ...args);
      if (this.canvas.closest('.practice-hands')) {
        const drawn = this.canvas.__installedDrawnText ??= [];
        if (drawn.length < 300) drawn.push({text: String(text), x, y, font: this.font, color: this.fillStyle});
      }
      return result;
    };
    globalThis.__mizanKitCapture = true;
    globalThis.__installedPianoFrames = [];
    globalThis.__mizanPianoFrame = (canvas, state) => {
      const frames = globalThis.__installedPianoFrames;
      frames.push({
        time: performance.now(), width: canvas.width, height: canvas.height,
        ready: canvas.closest('.practice-piano')?.dataset.ready,
        depressed: [...state.feedback].filter(([target, value]) => target.startsWith('key:') && (value.press ?? 0) > 0).map(([target]) => target),
        feedback: [...state.feedback].map(([target, value]) => ({target, press: value.press ?? 0, pulse: value.pulse, upcoming: value.upcoming})),
      });
      if (frames.length > 600) frames.shift();
    };
  ` })
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1.5, mobile: false })
  const navigation = await call('Page.navigate', { url })
  assert.equal(navigation.errorText, undefined, `Preview navigation failed: ${navigation.errorText}`)
  const waitFor = (selector) => evaluate(`new Promise((resolve, reject) => {
    const selector = ${JSON.stringify(selector)};
    if (globalThis.__installedStartupErrors?.length) return reject(new Error(globalThis.__installedStartupErrors.join('\\n')));
    if (document.querySelector(selector)) return resolve(true);
    const observer = new MutationObserver(() => {
      if (document.querySelector(selector)) { clearTimeout(timer); observer.disconnect(); resolve(true); }
    });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Missing installed UI: ' + selector)); }, 60000);
    observer.observe(document, { subtree: true, childList: true, attributes: true });
  })`)
  const waitForPlayback = () => evaluate(`new Promise((resolve, reject) => {
    const started = performance.now(), deadline = started + 90000;
    function inspect() {
      if (document.querySelector('button[aria-label="Pause"]') &&
          !document.body.innerText.includes('Preparing sounds')) return resolve(performance.now() - started);
      if (performance.now() > deadline) return reject(new Error('Playback did not finish preparing its sounds'));
      requestAnimationFrame(inspect);
    }
    inspect();
  })`)
  const checkMusic = async () => {
    const studies = await evaluate(`import('/src/course/piano.ts').then(module =>
      module.pianoGenres().flatMap(genre => genre.lessons.map(lesson => ({
        id: lesson.id, style: genre.style, level: lesson.level, song: module.pianoLessonSong(lesson),
      }))))`)
    const report = inspectPianoMusic(studies)
    await writeFile(join(root, 'piano-music-runtime.json'), JSON.stringify({url, report}, null, 2))
    assert.deepEqual(report.collisions, [], 'Piano genres must not reuse transposed full parts or four-bar piano motifs')
    assert.deepEqual(report.repeatedLoops, [], 'Longer genre loops must not merely tile a transposed two-bar piano phrase')
    return report
  }
  if (progressionsCheck) {
    const cases = await evaluate(`Promise.all([
      import('/src/course/piano.ts'), import('/src/course/pianoTonal.ts'),
    ]).then(([piano, tonal]) => ['major', 'minor'].flatMap(mode =>
      Array.from({length: 12}, (_, pitch) => tonal.progressionLessons(pitch, mode).map((lesson, variant) => ({
        id: lesson.id, mode, pitch, variant, title: lesson.title, goal: lesson.goal, hands: lesson.hands,
        numerals: lesson.numerals, chords: lesson.chords, song: piano.pianoLessonSong(lesson),
      }))).flat()))`)
    await writeFile(join(root, 'source-progressions-data.json'), JSON.stringify(cases))
    const report = inspectPianoProgressions(cases)
    await writeFile(join(root, 'source-progressions-runtime.json'), JSON.stringify({url, report, errors, viteUpdates}, null, 2))
    assert.deepEqual(errors, [], 'Source progression inspection produced browser errors')
    assert.deepEqual(viteUpdates, [], 'Source changed during the progression check; freeze it before admission')
    console.log(`Source progressions: ${report.families} families in all ${report.tonics} tonics; ${report.notesChecked} piano notes checked`)
  } else if (scalesInspiredCheck) {
    const cases = await evaluate(`Promise.all([
      import('/src/course/piano.ts'), import('/src/course/pianoInspired.ts'), import('/src/course/pianoTonal.ts'),
    ]).then(([piano, inspired, tonal]) => ({
      scales: tonal.SCALE_FAMILIES.flatMap(family => Array.from({length: 12}, (_, pitch) =>
        tonal.scaleLessons(pitch, family.id).map((lesson, variant) => ({
          id: lesson.id, family: family.id, pitch, variant, song: piano.pianoLessonSong(lesson),
        }))).flat()),
      inspired: inspired.PIANO_INSPIRED.map(lesson => ({
        id: lesson.id, influence: lesson.influence, song: piano.pianoLessonSong(lesson),
      })),
    }))`)
    await writeFile(join(root, 'source-scales-inspired-data.json'), JSON.stringify(cases))
    const report = {scales: inspectPianoScales(cases.scales), inspired: inspectPianoInspired(cases.inspired)}
    await writeFile(join(root, 'source-scales-inspired-runtime.json'), JSON.stringify({url, report, errors, viteUpdates}, null, 2))
    assert.deepEqual(report.inspired.collisions, [], 'Inspired artists must not be relabelled transposed piano parts')
    assert.deepEqual(report.inspired.repeatedLoops, [], 'Inspired studies must not simply tile a two-bar phrase')
    assert.deepEqual(errors, [], 'Source scale/inspired inspection produced browser errors')
    assert.deepEqual(viteUpdates, [], 'Source changed during the scale/Inspired check; freeze it before admission')
    console.log('Source piano: all 540 scale/family/tonic/hand combinations and 35 distinct, developed inspired studies checked')
  } else if (catalogCheck) {
    const catalog = await evaluate(`Promise.all([
      import('/src/course/pianoInspired.ts'), import('/src/course/pianoTonal.ts'),
    ]).then(([inspired, tonal]) => {
      const major = tonal.progressionLessons(0, 'major');
      const minor = tonal.progressionLessons(0, 'minor');
      const scales = tonal.scaleLessons(0, tonal.SCALE_FAMILIES[0].id);
      const metadata = lesson => Object.fromEntries(Object.entries(lesson).filter(([key, value]) =>
        !Array.isArray(value) && typeof value !== 'function'));
      return {
        inspiredExports: Object.keys(inspired), tonalExports: Object.keys(tonal),
        inspired: inspired.PIANO_INSPIRED.map(metadata),
        scaleFamilies: tonal.SCALE_FAMILIES,
        major: major.map(metadata), minor: minor.map(metadata),
        firstInspired: inspired.PIANO_INSPIRED[0], firstMajor: major[0], firstMinor: minor[0],
        firstScale: scales[0], scaleHandVariants: scales.map(metadata),
      };
    })`)
    await writeFile(join(root, 'source-catalog-runtime.json'), JSON.stringify({url, catalog, errors, viteUpdates}, null, 2))
    assert.equal(catalog.inspired.length, 35, 'The inspired piano catalog includes all 35 expanded studies')
    assert.equal(new Set(catalog.inspired.map(lesson => lesson.id)).size, 35, 'Inspired piano IDs are distinct')
    assert.equal(catalog.scaleFamilies.length, 15, 'The scale picker includes all 15 families')
    assert.equal(catalog.major.length, 10, 'The major picker includes ten distinct progression families')
    assert.equal(catalog.minor.length, 8, 'The minor picker includes eight distinct progression families')
    assert.equal(catalog.scaleHandVariants.length, 3, 'Each selected scale has three hand variants')
    assert.deepEqual(errors, [], 'Source catalog inspection produced browser errors')
    assert.deepEqual(viteUpdates, [], 'Source changed during the catalog check; freeze it before admission')
    console.log('Source catalog: 35 inspired piano originals; 15 scale/mode families; 18 progressions; three scale hand variants')
  } else if (musicCheck) {
    const report = await checkMusic()
    console.log(`Source piano music: ${report.lessons} lessons across ${report.genres} genres; no identical transposed two-hand four-bar parts or tiled two-bar phrases; ${report.rhythmCollisions.length} cross-genre rhythmic matches require musical review`)
  } else {
  await waitFor('#lib-tab-course')
  if (viewMemoryCheck) {
    const phase = Number(viewMemoryPhase)
    const snapshots = []
    const inspectView = () => evaluate(`({
      title: document.querySelector('h1')?.textContent,
      view: document.querySelector('.chordview-option[aria-checked="true"], .chordview-option[aria-pressed="true"]')?.dataset.view,
      preferences: JSON.parse(localStorage.getItem('mizan:practice') ?? '{}'),
    })`)
    const openLesson = async (instrument, index, expected) => {
      await evaluate(`(() => {
        if (document.querySelector('#lib-tab-course')) return;
        const back = document.querySelector('button[aria-label="Back to the library"]');
        if (!back) throw new Error('The library navigation control is unavailable');
        back.click();
      })()`)
      await waitFor('#lib-tab-course')
      await evaluate(`document.querySelector('#lib-tab-course').click()`)
      await waitFor(`[data-instrument="${instrument}"]`)
      await evaluate(`document.querySelector('[data-instrument="${instrument}"]').click()`)
      const shelf = instrument === 'piano' ? '[data-piano-shelf="genre"]' : '[data-shelf="genre"]'
      await waitFor(shelf)
      await evaluate(`document.querySelector(${JSON.stringify(shelf)}).click()`)
      await waitFor('[data-genre]')
      await evaluate(`document.querySelector('[data-genre]').click()`)
      await waitFor('.course-lesson')
      await evaluate(`(() => {
        const lesson = document.querySelectorAll('.course-lesson')[${index}];
        if (!lesson) throw new Error('The requested course lesson is unavailable');
        lesson.click();
      })()`)
      await waitFor('.chordview-option[data-view]')
      if (expected) {
        await waitFor(`.chordview-option[data-view="${expected}"][aria-checked="true"], .chordview-option[data-view="${expected}"][aria-pressed="true"]`)
      }
      await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      const state = await inspectView()
      if (expected) assert.equal(state.view, expected, `${instrument} retains its own chosen view`)
      snapshots.push({ instrument, index, expected, ...state })
      return state
    }
    const readSaved = () => evaluate(`JSON.parse(localStorage.getItem('mizan:practice') ?? '{}')`)
    const previous = phase > 0 ? viewMemoryPairs[phase - 1] : null
    if (previous) {
      const saved = await readSaved()
      assert.equal(saved.pianoView, previous.piano, 'Piano preference survives a full browser-process exit')
      assert.equal(saved.drumsView, previous.drums, 'Drum preference survives a full browser-process exit')
      for (const instrument of ['piano', 'drums']) {
        const first = await openLesson(instrument, 0, previous[instrument])
        const second = await openLesson(instrument, 1, previous[instrument])
        assert.notEqual(first.title, second.title, 'The view is retained across different songs')
      }
    }
    const chosen = viewMemoryPairs[phase]
    if (chosen) {
      for (const instrument of ['piano', 'drums']) {
        await openLesson(instrument, 0, previous?.[instrument])
        await evaluate(`document.querySelector('.chordview-option[data-view="${chosen[instrument]}"]').click()`)
        const selected = await inspectView()
        assert.equal(selected.view, chosen[instrument], 'The deliberate view selection takes effect')
        await openLesson(instrument, 1, chosen[instrument])
      }
      const saved = await readSaved()
      assert.equal(saved.pianoView, chosen.piano)
      assert.equal(saved.drumsView, chosen.drums)
      for (const instrument of ['piano', 'drums']) await openLesson(instrument, 0, chosen[instrument])
      const afterNavigation = await readSaved()
      assert.equal(afterNavigation.pianoView, saved.pianoView, 'Navigation does not overwrite the piano view')
      assert.equal(afterNavigation.drumsView, saved.drumsView, 'Navigation does not overwrite the drum view')
    }
    assert.deepEqual(errors, [], 'The view-memory check produced no browser errors')
    assert.deepEqual(viteUpdates, [], 'Source changed during the view-memory check')
    await writeFile(join(root, `${resultArtifact}-runtime.json`), JSON.stringify({
      url, version, phase, browserPid: browser.pid, profile, previous, chosen, snapshots, errors, viteUpdates,
      restartShutdown: 'CDP close, debugger pipe detach, exact owned-process cleanup',
    }, null, 2))
    console.log(`View memory: process ${browser.pid}, phase ${phase}, independent views retained across different songs`)
  } else if (homeCheck) {
    await waitFor('.popular-shelf .popular-music-card')
    const shelves = await evaluate(`({
      sample: document.querySelector('.popular-music-summary')?.textContent,
      freshness: document.querySelector('.popular-freshness')?.textContent,
      shelves: [...document.querySelectorAll('.popular-shelf')].map(shelf => ({
        title: shelf.querySelector('h3')?.textContent,
        publisher: shelf.querySelector('.popular-source-badge')?.textContent,
        chart: Boolean(shelf.querySelector('.popular-chart-badge')),
        source: shelf.querySelector('.popular-chart-source a')?.href,
        cards: [...shelf.querySelectorAll('.popular-music-card')].map(card => ({
          id: new URL(card.querySelector('.popular-cover-link').href).searchParams.get('v'),
          title: card.querySelector('.popular-song-title')?.textContent,
          artist: card.querySelector('.song-meta')?.textContent,
          rank: card.querySelector('.popular-rank')?.textContent ?? null,
          button: card.querySelector('button')?.getAttribute('aria-label'),
        })),
      })),
    })`)
    assert.equal(shelves.shelves.length, 2, 'The homepage offers a coherent editorial shelf and a separate chart')
    assert.match(shelves.shelves[0].title, /biggest hits/i)
    assert.match(shelves.shelves[0].source, /RDCLAK5uy_kmPRjHDECIcuVwnKsx2Ng7fyNgFKWNJFs/)
    assert.match(shelves.shelves[1].title, /global.*100|100.*global/i)
    assert.match(shelves.shelves[1].source, /PL4fGSI1pDJn6puJdseH2Rt9sMvt9E2M4i/)
    assert.ok(!shelves.shelves[0].chart && shelves.shelves[1].chart)
    for (const shelf of shelves.shelves) {
      assert.ok(shelf.cards.length >= 6, 'Each available shelf has a useful choice of songs')
      assert.equal(new Set(shelf.cards.map(card => card.id)).size, shelf.cards.length)
      assert.ok(shelf.cards.every(card => card.title && card.artist && card.button?.startsWith('Transcribe')))
    }
    assert.ok(shelves.shelves[0].cards.every(card => card.rank === null), 'Editorial playlist order is not a chart rank')
    assert.ok(shelves.shelves[1].cards.every((card, index) => Number(card.rank) === index + 1))
    if (shelves.sample?.includes('development data')) {
      const editorial = JSON.parse(await readFile(join(root, 'youtube-hit-list-proof.json'), 'utf8'))
      const chart = JSON.parse(await readFile(join(root, 'youtube-global-top-songs-proof.json'), 'utf8'))
      for (const [index, source] of [editorial, chart].entries()) {
        assert.deepEqual(shelves.shelves[index].cards.map(card => card.id),
          source.entries.slice(0, shelves.shelves[index].cards.length).map(card => card.id),
          'The dated development snapshot uses independently verified playlist entries')
      }
      assert.match(shelves.sample, /snapshot/i)
    }
    const geometry = []
    const inspectOverlay = () => evaluate(`(() => {
      const card = document.querySelector('.popular-music-card'), button = card.querySelector('.popular-song-transcribe');
      const image = card.querySelector('img');
      return {card: card.getBoundingClientRect().toJSON(), cover: card.querySelector('.popular-cover').getBoundingClientRect().toJSON(),
        button: button.getBoundingClientRect().toJSON(), opacity: Number(getComputedStyle(button).opacity),
        pointer: getComputedStyle(button).pointerEvents, tabIndex: button.tabIndex,
        imageLoaded: Boolean(image?.complete && image.naturalWidth > 0),
        hover: matchMedia('(hover: hover)').matches, coarse: matchMedia('(pointer: coarse)').matches,
        queue: [...document.querySelectorAll('.queue-job')].map(job => job.textContent)};
    })()`)
    const waitForOpacity = (opacity) => evaluate(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 3000;
      function inspect() {
        if (Math.abs(Number(getComputedStyle(document.querySelector('.popular-song-transcribe')).opacity) - ${opacity}) < .01) return resolve(true);
        if (performance.now() > deadline) return reject(new Error('The Transcribe overlay did not reach opacity ${opacity}'));
        requestAnimationFrame(inspect);
      }
      inspect();
    })`)
    for (const width of [1440, 617]) {
      await call('Emulation.setTouchEmulationEnabled', { enabled: false })
      await call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1.5, mobile: false })
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
      await evaluate(`document.activeElement?.blur(); document.querySelector('.popular-music-card').scrollIntoView({block: 'center'});`)
      await waitForOpacity(0)
      const idle = await inspectOverlay()
      assert.ok(idle.hover && !idle.coarse, 'Desktop pointer media reflects a hover-capable device')
      assert.equal(idle.pointer, 'none', 'The hidden overlay does not intercept the cover link')
      assert.ok(idle.tabIndex >= 0, 'The hover action stays in the keyboard tab order')
      await call('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: idle.cover.x + idle.cover.width / 2, y: idle.cover.y + idle.cover.height / 2,
      })
      await waitForOpacity(1)
      const hover = await inspectOverlay()
      assert.equal(hover.pointer, 'auto')
      assert.deepEqual(hover.card, idle.card, 'Hover creates no card layout shift')
      assert.ok(hover.button.left >= hover.cover.left && hover.button.right <= hover.cover.right &&
        hover.button.top >= hover.cover.top && hover.button.bottom <= hover.cover.bottom, 'Transcribe overlays only the cover')
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
      await evaluate(`document.querySelector('.popular-song-transcribe').focus()`)
      await waitForOpacity(1)
      const focus = await inspectOverlay()
      assert.deepEqual(focus.queue, idle.queue, 'Hover and focus never queue a transcription')
      assert.ok(await evaluate(`document.activeElement === document.querySelector('.popular-song-transcribe')`))
      const layout = await evaluate(`({
        width: innerWidth, documentWidth: document.documentElement.scrollWidth,
        shelves: [...document.querySelectorAll('.popular-music-list')].map(list => ({
          width: list.clientWidth, contentWidth: list.scrollWidth, overflow: getComputedStyle(list).overflowX,
        })),
      })`)
      assert.ok(layout.documentWidth <= width, 'The page has no horizontal overflow')
      assert.ok(layout.shelves.every(list => list.contentWidth > list.width && list.overflow === 'auto'),
        'Each cover shelf scrolls inside the page')
      geometry.push({width, idle, hover, focus, layout})
      const image = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      await writeFile(join(root, `${resultArtifact}-${width}.png`), Buffer.from(image.data, 'base64'))
    }
    await evaluate(`document.activeElement?.blur()`)
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    await waitForOpacity(1)
    const touch = await inspectOverlay()
    assert.ok(touch.coarse && touch.pointer === 'auto', 'Touch users get a visible, usable Transcribe action without hover')
    await call('Emulation.setTouchEmulationEnabled', { enabled: false })
    await evaluate(`document.querySelector('.popular-shelf-controls button[aria-label^="Next"]').click()`)
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 3000;
      function inspect() {
        if (document.querySelector('.popular-music-list').scrollLeft > 100) return resolve(true);
        if (performance.now() > deadline) return reject(new Error('The shelf Next control did not scroll'));
        requestAnimationFrame(inspect);
      }
      inspect();
    })`)
    assert.deepEqual(errors, [], 'The homepage produced no browser errors')
    assert.deepEqual(viteUpdates, [], 'The source changed during homepage verification')
    await writeFile(join(root, `${resultArtifact}-runtime.json`), JSON.stringify({url, version, shelves, geometry, touch, errors, viteUpdates}, null, 2))
    console.log('Homepage: verified editorial/chart snapshots, scrollable cover shelves, hover/focus-only desktop Transcribe and visible touch action')
  } else if (loadCheck) {
    const context = await readFailureContext()
    assert.deepEqual(errors, [], 'Fresh preview load produced browser errors')
    assert.deepEqual(failedRequests.filter(request => !request.canceled), [], 'Fresh preview load failed to retrieve a dependency')
    assert.deepEqual(httpErrors, [], 'Fresh preview load received an HTTP error')
    await writeFile(join(root, `${artifact}-runtime.json`), JSON.stringify({url, version, context, errors, failedRequests, httpErrors}, null, 2))
    console.log('Fresh preview load: course control mounted without browser or dependency errors')
  } else {
  if (preview && !partialCheck) await checkMusic()
  await evaluate(`document.querySelector('#lib-tab-course').click()`)
  await waitFor('[data-instrument="drums"]')
  await evaluate(`document.querySelector('[data-instrument="drums"]').click()`)
  await evaluate(`document.querySelector('[data-shelf="course"]').click()`)
  await waitFor('#course-title')
  const core = await evaluate(`document.querySelectorAll('.course-lesson').length`)
  if (partialCheck) assert.ok(core >= 37, 'The existing drum basics remain available')
  else assert.equal(core, 49)
  await evaluate(`document.querySelector('[data-shelf="inspired"]').click()`)
  await waitFor('#course-inspired')
  const artists = await evaluate(`[...document.querySelectorAll('button')]
    .map(button => button.innerText.trim()).filter(text => /\\d+\\s*tracks?\\s*$/.test(text))`)
  assert.ok(artists.length > 0, 'Inspired studies are browsable by artist')
  const inspiredGroups = []
  for (const artist of artists) {
    await evaluate(`(() => {
      const artist = ${JSON.stringify(artist)};
      const button = [...document.querySelectorAll('button')].find(button => button.innerText.trim() === artist);
      if (!button) throw new Error('The inspired artist control is missing: ' + artist);
      button.click();
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`)
    const group = await evaluate(`({
      artist: ${JSON.stringify(artist)},
      count: document.querySelectorAll('.course-lesson').length,
      titles: [...document.querySelectorAll('.course-lesson .course-title')].map(title => title.textContent),
    })`)
    assert.equal(group.count, Number(artist.match(/(\d+)\s*tracks?\s*$/)[1]),
      'Each artist shelf contains the advertised number of studies')
    inspiredGroups.push(group)
  }
  const inspired = inspiredGroups.reduce((total, group) => total + group.count, 0)
  if (partialCheck) assert.ok(inspired >= 8, 'The existing inspired drum studies remain available')
  else assert.equal(inspired, 38)
  const inspectGenres = async (expectedSteps) => {
    const styles = await evaluate(`Array.from(document.querySelectorAll('[data-genre]')).map(button => button.dataset.genre)`)
    assert.equal(styles.length, 11)
    const genres = []
    for (const style of styles) {
      await evaluate(`Array.from(document.querySelectorAll('[data-genre]')).find(button => button.dataset.genre === ${JSON.stringify(style)}).click()`)
      const genre = await evaluate(`({
        title: document.querySelector('.course-genre-detail h3').textContent,
        count: document.querySelectorAll('.course-lesson').length,
        titles: Array.from(document.querySelectorAll('.course-lesson .course-title')).map(title => title.textContent),
        backing: document.querySelector('.course-genre-facts').textContent,
      })`)
      assert.equal(genre.title, style)
      assert.equal(genre.count, expectedSteps, 'Only the selected genre ladder is displayed')
      assert.equal(new Set(genre.titles).size, expectedSteps)
      assert.match(genre.backing, /Backing:/)
      genres.push(genre)
    }
    await evaluate(`document.querySelector('[data-genre]').click()`)
    return genres
  }
  await evaluate(`document.querySelector('[data-shelf="genre"]').click()`)
  await waitFor('#course-genre')
  const drumGenres = await inspectGenres(5)
  const drums = { lessons: core + inspired + drumGenres.reduce((sum, genre) => sum + genre.count, 0), core, inspired, inspiredGroups, genres: drumGenres }
  if (!partialCheck) assert.equal(drums.lessons, 142)
  await evaluate(`document.querySelector('[data-instrument="piano"]').click()`)
  await waitFor('#course-piano')
  const pianoGenres = await inspectGenres(10)
  const piano = {
    lessons: pianoGenres.reduce((sum, genre) => sum + genre.count, 0), genres: pianoGenres,
    firstLesson: await evaluate(`document.querySelector('.course-lesson').textContent`),
  }
  assert.equal(piano.lessons, 110)
  const catalog = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  await writeFile(join(root, `${artifact}-catalog.png`), Buffer.from(catalog.data, 'base64'))
  await evaluate(`document.querySelector('.course-lesson').click()`)
  await waitFor('.practice-piano[data-ready="true"] canvas')
  const compactPanels = []
  const inspectPanel = () => evaluate(`(() => {
    const panel = document.querySelector('.lesson-panel');
    if (!panel) throw new Error('The lesson instructions are unavailable');
    const details = [...panel.querySelectorAll('details')].find(detail => detail.querySelector('.lesson-counts'));
    const rows = [...panel.querySelectorAll('.lesson-counts tr')];
    return {width: innerWidth, height: panel.getBoundingClientRect().height,
      details: Boolean(details), expanded: details?.open,
      rows: rows.length, visibleRows: rows.filter(row => row.checkVisibility({contentVisibilityAuto: true})).length,
      text: panel.textContent};
  })()`)
  const assertCompactPanel = async () => {
    const panel = await inspectPanel()
    await writeFile(join(root, `${artifact}-compact-${panel.width}.json`), JSON.stringify({url, panel}, null, 2))
    assert.ok(panel.details && !panel.expanded, 'Full lesson details are available but closed by default')
    assert.equal(panel.visibleRows, 0, 'The bar-by-bar instructions do not displace the score before the user opens them')
    assert.ok(panel.height <= 260, `The compact lesson panel fits comfortably above the practice view: ${panel.height}px`)
    assert.match(panel.text, /Backing/)
    assert.match(panel.text, /How to practise/)
    compactPanels.push(panel)
  }
  if (!partialCheck) {
    await assertCompactPanel()
    await evaluate(`[...document.querySelector('.lesson-panel').querySelectorAll('details')]
      .find(detail => detail.querySelector('.lesson-counts')).querySelector('summary').click()`)
    const expanded = await inspectPanel()
    assert.ok(expanded.expanded && expanded.rows > 0 && expanded.visibleRows === expanded.rows,
      'The complete bar-by-bar instructions remain available on demand')
    await evaluate(`[...document.querySelector('.lesson-panel').querySelectorAll('details')]
      .find(detail => detail.querySelector('.lesson-counts')).querySelector('summary').click()`)
  }
  const checkControls = controlsCheck || !partialCheck
  const controls = {}
  const toggle = async (name, enabled) => {
    const state = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button')].filter(button =>
        button.hasAttribute('aria-pressed') &&
        [button.textContent.trim(), button.getAttribute('aria-label') ?? ''].some(text =>
          text.startsWith(${JSON.stringify(name)})));
      if (buttons.length !== 1) throw new Error('Expected one ' + ${JSON.stringify(name)} + ' control, found ' + buttons.length);
      const button = buttons[0];
      const before = button.getAttribute('aria-pressed');
      if (!['true', 'false'].includes(before)) throw new Error('The toggle has no accessible pressed state');
      if ((before === 'true') !== ${enabled}) button.click();
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() =>
        resolve({before, after: button.getAttribute('aria-pressed')}))));
    })()`)
    assert.equal(state.after, String(enabled), `${name} respects the requested state`)
    return state
  }
  const readControls = () => evaluate(`({
    title: document.querySelector('h1')?.textContent,
    bar: document.querySelector('.ws-where strong')?.textContent,
    view: document.querySelector('.chordview-option[aria-checked="true"], .chordview-option[aria-pressed="true"]')?.dataset.view,
    letters: [...document.querySelectorAll('button[aria-pressed]')].find(button => button.textContent.trim().startsWith('Note letters'))?.getAttribute('aria-pressed'),
    fingers: [...document.querySelectorAll('button[aria-pressed]')].find(button => button.textContent.trim().startsWith('Fingering'))?.getAttribute('aria-pressed'),
    pianoLetters: [...document.querySelectorAll('.piano-letter')].map(letter => letter.textContent),
    pianoNumbers: [...document.querySelectorAll('.piano-finger')].map(finger => {
      const copy = finger.cloneNode(true);
      copy.querySelectorAll('.piano-letter').forEach(letter => letter.remove());
      const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
      const numbers = [];
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent.trim();
        if (/^[1-5]$/.test(text)) numbers.push(text);
      }
      return numbers;
    }).flat(),
  })`)
  const waitForScore = () => evaluate(`document.fonts.ready.then(() => new Promise((resolve, reject) => {
    const deadline = performance.now() + 15000;
    let previous = null, settled = 0;
    function inspect() {
      const svg = document.querySelector('.score-osmd svg');
      const rect = svg?.getBoundingClientRect();
      const ready = rect?.width > 0 && rect?.height > 0 && !document.body.innerText.includes('Drawing the score');
      settled = ready && svg === previous ? settled + 1 : 0;
      previous = svg;
      if (settled >= 5) return resolve(true);
      if (performance.now() > deadline) return reject(new Error('The actual score did not settle before playback'));
      requestAnimationFrame(inspect);
    }
    inspect();
  }))`)
  const inspectScoreFingering = async () => {
    await waitForScore()
    const score = await evaluate(`(() => {
      const element = document.querySelector('.score-osmd');
      let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))];
      let display = null;
      while (fiber && !display) {
        let hook = fiber.memoizedState;
        while (hook) {
          const current = hook.memoizedState?.current;
          if (current?.EngravingRules && typeof current.render === 'function') { display = current; break; }
          hook = hook.next;
        }
        fiber = fiber.return;
      }
      if (!display) throw new Error('The actual rendered score engraver is unavailable');
      return {renderFingerings: display.EngravingRules.RenderFingerings, svgCount: element.querySelectorAll('svg').length,
        fingerRules: Object.fromEntries(Object.entries(display.EngravingRules).filter(([key]) => /finger/i.test(key)))};
    })()`)
    assert.equal(score.renderFingerings, false, 'The actual score renderer never paints finger numbers')
    assert.ok(score.svgCount > 0, 'The assertion inspects a rendered score, not an empty container')
    return score
  }
  if (checkControls) {
    await waitFor('.practice-piano[data-ready="true"] .piano-finger')
    controls.initial = await readControls()
    assert.equal(controls.initial.fingers, 'true', 'Piano fingering is on by default')
    assert.ok(controls.initial.pianoNumbers.length > 0, 'Written fingering appears on the 3D keyboard')
    controls.scoreWithFingersOn = await inspectScoreFingering()
    await toggle('Note letters', true)
    await toggle('Fingering', false)
    controls.hidden3d = await readControls()
    assert.deepEqual(controls.hidden3d.pianoNumbers, [], 'Fingering off removes actual 3D finger numbers')
    controls.scoreWithFingersOff = await inspectScoreFingering()
    await waitForScore()
    await evaluate(`document.querySelector('button[aria-label="Play"]').click()`)
    controls.prepare3dMs = await waitForPlayback()
    controls.playing3d = await evaluate(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 10000;
      const samples = [];
      function inspect() {
        const piano = document.querySelector('.practice-piano');
        const letters = [...piano.querySelectorAll('.piano-letter')].map(letter => ({
          text: letter.textContent, next: Boolean(letter.closest('.piano-finger-next')),
          key: letter.closest('.piano-finger').dataset.key,
        }));
        if (letters.length) samples.push({letters, data: {...piano.dataset}});
        if (samples.some(sample => sample.letters.some(letter => letter.next)) &&
            samples.some(sample => sample.letters.some(letter => !letter.next &&
              sample.data.depressed.split(',').includes(letter.key))) &&
            document.querySelector('button[aria-label="Pause"]')) return resolve(samples);
        if (performance.now() > deadline) return reject(new Error('3D sounding and upcoming keys did not show their note letters'));
        requestAnimationFrame(inspect);
      }
      inspect();
    })`)
    assert.ok(controls.playing3d.every(sample => sample.letters.every(letter => /^[A-G](?:#|b|\u266f|\u266d)?$/.test(letter.text))),
      '3D key letters preserve pitch spelling without an octave suffix')
    await writeFile(join(root, `${artifact}-labels-3d.json`), JSON.stringify(controls.playing3d, null, 2))
    await evaluate(`document.querySelector('button[aria-label="Pause"]').click()`)
    assert.deepEqual((await readControls()).pianoNumbers, [], 'Playback cannot re-enable hidden 3D fingering')
    if (!handsCheck) {
      await toggle('Note letters', false)
      await toggle('Fingering', true)
      controls.scoreAfterRestoringFingers = await inspectScoreFingering()
    }
  }
  let visual = null
  if (!handsCheck) {
  const scene = await evaluate(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 60000;
    function inspect() {
      const canvases = Array.from(document.querySelectorAll('canvas'));
      if (canvases.some(canvas => canvas.width > 0 && canvas.height > 0)) {
        return resolve({
          title: document.querySelector('h1')?.textContent,
          canvases: canvases.map(canvas => ({ class: canvas.className, width: canvas.width, height: canvas.height, css: canvas.getBoundingClientRect().toJSON(), label: canvas.getAttribute('aria-label'), data: {...canvas.dataset} })),
          buttons: Array.from(document.querySelectorAll('button')).map(button => ({ label: button.getAttribute('aria-label'), text: button.textContent, checked: button.getAttribute('aria-checked') })),
          instructions: document.querySelector('.lesson-panel')?.textContent,
        });
      }
      if (performance.now() > deadline) return reject(new Error('Installed piano canvas did not initialize'));
      requestAnimationFrame(inspect);
    }
    inspect();
  })`)
  const ready = await evaluate(`({
    variant: document.querySelector('.practice-piano').dataset.variant,
    look: document.querySelector('.practice-piano').dataset.look,
    pressed: document.querySelector('.practice-piano').dataset.pressed,
    depressed: document.querySelector('.practice-piano').dataset.depressed,
    fingers: Array.from(document.querySelectorAll('.piano-finger')).map(finger => finger.textContent),
    frames: globalThis.__installedPianoFrames.length,
  })`)
  assert.equal(ready.variant, 'stage_piano_88')
  assert.equal(ready.look, 'Realistic')
  assert.equal(ready.depressed, '', 'Lesson highlights must not depress keys before playback')
  assert.ok(ready.fingers.length > 0, 'The installed lesson shows its written fingers')
  const variants = ['stage_piano_88']
  assert.equal(await evaluate(`document.querySelectorAll('.practice-piano select').length`), 1,
    'Only the look selector remains; retired instruments are not offered')
  const looks = await evaluate(`Array.from(document.querySelector('.practice-piano select').options).map(option => option.value)`)
  assert.equal(looks.length, 4)
  const ranges = await evaluate(`fetch('/models/KeyboardInstruments.json').then(response => {
    if (!response.ok) throw new Error('The rendered piano manifest is unavailable');
    return response.json();
  }).then(manifest => {
    const ranges = Object.fromEntries(Object.entries(manifest.variants).map(([id, variant]) => [id, [variant.low, variant.high]]));
    globalThis.__installedPianoRanges = ranges;
    return ranges;
  })`)
  assert.deepEqual(Object.keys(ranges).sort(), [...variants].sort())
  const assertKeybed = (frame) => {
    const [low, high] = ranges[frame.variant]
    assert.equal(frame.keyPoints.length, high - low + 1, 'Every key has a real screen projection')
    assert.ok(frame.keyPoints.every(point => Number.isFinite(point.x) && Number.isFinite(point.y) &&
      point.x >= 0.02 && point.x <= 0.98 && point.y >= 0.02 && point.y <= 0.98),
    'The complete playable keybed remains visible with padding')
    const span = Math.max(...frame.keyPoints.map(point => point.x)) - Math.min(...frame.keyPoints.map(point => point.x))
    assert.ok(span >= 0.78, `The keybed, not the legs and music rest, fills the view: ${frame.variant}/${span}`)
    const whites = frame.keyPoints.filter(point => [0, 2, 4, 5, 7, 9, 11].includes(point.midi % 12))
    assert.ok(whites.slice(1).every((point, index) => (point.x - whites[index].x) * frame.cssWidth >= 5),
      'White-key fronts stay distinguishable across the whole keyboard')
  }
  const assertFingerBadges = (fingers, label) => {
    assert.equal(fingers.length, ready.fingers.length, 'Every written finger number remains visible')
    for (let first = 0; first < fingers.length; first++) for (let second = first + 1; second < fingers.length; second++) {
      const a = fingers[first].rect, b = fingers[second].rect
      assert.ok(Math.min(a.right, b.right) - Math.max(a.left, b.left) <= 1 ||
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 1,
      `Written finger badges must not obscure each other: ${label}`)
    }
  }
  const combinations = []
  for (const variant of variants) for (const look of looks) {
    await evaluate(`(() => {
      const select = document.querySelector('.practice-piano select');
      select.value = ${JSON.stringify(look)};
      select.dispatchEvent(new Event('change', {bubbles: true}));
    })()`)
    await waitFor(`.practice-piano[data-variant="${variant}"][data-look="${look}"][data-ready="true"]`)
    const frame = await evaluate(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 15000;
      const schedule = () => requestAnimationFrame(() => {
        try { capture(); } catch (error) { reject(error); }
      });
      function capture() {
        const section = document.querySelector('.practice-piano');
        const canvas = section.querySelector('canvas');
        const gl = canvas?.getContext('webgl');
        if (gl && canvas.width > 0 && canvas.height > 0 && !gl.isContextLost()) {
          const pixels = new Uint8Array(canvas.width * canvas.height * 4);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const colors = new Set();
          for (let index = 0; index < pixels.length; index += 128) colors.add(pixels[index] + ',' + pixels[index+1] + ',' + pixels[index+2]);
          if (colors.size > 25) {
            const program = gl.getParameter(gl.CURRENT_PROGRAM);
            const view = Array.from(gl.getUniform(program, gl.getUniformLocation(program, 'vp')));
            const renderedLook = gl.getUniform(program, gl.getUniformLocation(program, 'look'));
            if (renderedLook === ${looks.indexOf(look)}) {
              let blueprint = null;
              if (section.dataset.look === 'TechnicalBlueprint') {
                const sample = (midi) => {
                  const at = globalThis.__mizanPianoKeyAt?.(midi);
                  if (!at) throw new Error('The actual rendered key has no projection: ' + midi);
                  const pixel = new Uint8Array(4);
                  gl.readPixels(Math.round(at.x * canvas.width), Math.round(at.y * canvas.height), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                  return (pixel[0] + pixel[1] + pixel[2]) / 3;
                };
                blueprint = {white: [36, 38, 40, 41, 43].map(sample), black: [37, 39, 42, 44, 46].map(sample)};
              }
              return resolve({variant: section.dataset.variant, look: section.dataset.look, colors: colors.size, width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight, depressed: section.dataset.depressed, view, renderedLook, blueprint,
                keyPoints: Array.from({length: globalThis.__installedPianoRanges[section.dataset.variant][1] - globalThis.__installedPianoRanges[section.dataset.variant][0] + 1}, (_, index) => {
                  const midi = globalThis.__installedPianoRanges[section.dataset.variant][0] + index;
                  const point = globalThis.__mizanPianoKeyAt?.(midi);
                  if (!point) throw new Error('The actual rendered key has no projection: ' + midi);
                  return {midi, ...point};
                }),
                fingers: Array.from(section.querySelectorAll('.piano-finger')).map(label => ({text: label.textContent, rect: label.getBoundingClientRect().toJSON()}))});
            }
          }
        }
        if (performance.now() > deadline) return reject(new Error('The installed variant/look did not render'));
        schedule();
      }
      schedule();
    })`)
    assert.equal(frame.variant, variant)
    assert.equal(frame.look, look)
    assert.ok(Math.abs(frame.width / frame.cssWidth - 1.5) < 0.02, `Actual piano backbuffer respects DPR 1.5: ${JSON.stringify(frame)}`)
    assert.equal(frame.depressed, '', 'Paused keys remain at rest in every instrument and look')
    assert.ok(Math.hypot(frame.view[3], frame.view[7], frame.view[11]) > 0.1,
      'The piano uses the requested perspective projection')
    const verticalFov = 2 * Math.atan(1 / Math.hypot(frame.view[1], frame.view[5], frame.view[9])) * 180 / Math.PI
    assert.ok(verticalFov > 0 && verticalFov <= 55, `The piano avoids a wide-angle lens: ${verticalFov}`)
    assertKeybed(frame)
    if (frame.blueprint) {
      assert.ok(frame.blueprint.white.every(value => value > 205) && frame.blueprint.black.every(value => value < 110),
        `Blueprint keys remain solid white/dark rather than revealing the structure: ${JSON.stringify(frame.blueprint)}`)
    }
    assertFingerBadges(frame.fingers, `${variant}/${look}`)
    combinations.push(frame)
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 617, height: 978, deviceScaleFactor: 1.5, mobile: false })
  const narrow = await evaluate(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 10000;
    let settled = 0;
    const schedule = () => requestAnimationFrame(() => {
      try { inspect(); } catch (error) { reject(error); }
    });
    function inspect() {
      const canvas = document.querySelector('.practice-piano canvas');
      const resized = canvas?.clientWidth && Math.abs(canvas.width / canvas.clientWidth - 1.5) < 0.02;
      settled = resized ? settled + 1 : 0;
      if (settled >= 3) {
        return resolve({width: innerWidth, documentWidth: document.documentElement.scrollWidth,
          bodyWidth: document.body.scrollWidth, canvasWidth: canvas.width, canvasCssWidth: canvas.clientWidth,
          variant: document.querySelector('.practice-piano').dataset.variant,
          cssWidth: canvas.clientWidth,
          keyPoints: Array.from({length: globalThis.__installedPianoRanges[document.querySelector('.practice-piano').dataset.variant][1] - globalThis.__installedPianoRanges[document.querySelector('.practice-piano').dataset.variant][0] + 1}, (_, index) => {
            const midi = globalThis.__installedPianoRanges[document.querySelector('.practice-piano').dataset.variant][0] + index;
            const point = globalThis.__mizanPianoKeyAt?.(midi);
            if (!point) throw new Error('The narrow rendered key has no projection: ' + midi);
            return {midi, ...point};
          }),
          fingers: Array.from(document.querySelectorAll('.practice-piano .piano-finger')).map(label => ({text: label.textContent, rect: label.getBoundingClientRect().toJSON()}))});
      }
      if (performance.now() > deadline) return reject(new Error('The narrow piano backbuffer did not resize'));
      schedule();
    }
    schedule();
  })`)
  assert.equal(narrow.width, 617)
  assert.ok(narrow.documentWidth <= 617 && narrow.bodyWidth <= 617, 'The lesson must not clip or scroll horizontally at the actual preview width')
  assertKeybed(narrow)
  assertFingerBadges(narrow.fingers, '617px stage piano')
  if (!partialCheck) await assertCompactPanel()
  const motion = await evaluate(`new Promise((resolve, reject) => {
    const section = document.querySelector('.practice-piano');
    let fiber = section[Object.keys(section).find(key => key.startsWith('__reactFiber$'))], engine = null;
    while (fiber && !engine) {
      if (typeof fiber.memoizedProps?.engine?.read === 'function') engine = fiber.memoizedProps.engine;
      fiber = fiber.return;
    }
    if (!engine) return reject(new Error('The rendered piano has no actual transport clock'));
    const button = document.querySelector('button[aria-label="Play"]');
    if (!button) return reject(new Error('Installed transport has no Play control'));
    globalThis.__installedPianoFrames.length = 0;
    const deadline = performance.now() + 90000;
    const down = new Set();
    const countInSamples = [];
    function inspect() {
      const clock = engine.read();
      if (clock.countingIn) {
        countInSamples.push({time: performance.now(), beat: clock.countBeat, depressed: section.dataset.depressed});
        if (section.dataset.depressed) return reject(new Error('Count-in physically depressed piano keys'));
      }
      if (clock.playing && !clock.countingIn && section.dataset.depressed)
        down.add(section.dataset.depressed.split(',').sort((a, b) => Number(a) - Number(b)).join(','));
      const frames = globalThis.__installedPianoFrames;
      const keys = frames.flatMap(frame => frame.feedback.filter(key => key.target.startsWith('key:')));
      if (keys.some(key => !Number.isFinite(key.press) || key.press < 0 || key.press > 1)) {
        return reject(new Error('Installed key press feedback is outside normalized travel'));
      }
      if (countInSamples.length >= 3 && down.size >= 2 && keys.some(key => key.press === 1)) {
        return resolve({countInReleasedKeys: true, countInFrames: countInSamples.length, countInSamples,
          pressedStates: [...down], renderedFrames: frames.length});
      }
      if (performance.now() > deadline) return reject(new Error('Installed key animation did not follow the actual count-in and sounding clock: ' +
        JSON.stringify({countInSamples: countInSamples.length, pressedStates: [...down], renderedFrames: frames.length})));
      requestAnimationFrame(inspect);
    }
    button.click();
    requestAnimationFrame(inspect);
  })`)
  const pausedAt = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === 'Pause');
    if (!button) throw new Error('Installed transport has no Pause control');
    button.click();
    return performance.now();
  })()`)
  const release = await evaluate(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 5000;
    let settled = 0;
    function inspect() {
      const frames = globalThis.__installedPianoFrames.filter(frame => frame.time > ${pausedAt});
      const latest = frames.at(-1);
      const released = latest && !latest.depressed.length && latest.feedback
        .filter(key => key.target.startsWith('key:')).every(key => key.press === 0) &&
        !document.querySelector('.practice-piano').dataset.depressed;
      settled = released ? settled + 1 : 0;
      if (settled >= 3) {
        return resolve({releasedAfterPause: true, settledAnimationFrames: settled, restingDraws: frames.length});
      }
      if (performance.now() > deadline) return reject(new Error('Highlighted piano keys stayed depressed after Pause'));
      requestAnimationFrame(inspect);
    }
    inspect();
  })`)
  await evaluate(`(() => {
    const canvas = document.querySelector('.practice-piano canvas');
    globalThis.__installedLostCanvas = canvas;
    const extension = canvas.getContext('webgl').getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('The test browser does not expose context-loss simulation');
    globalThis.__installedLossExtension = extension;
    extension.loseContext();
  })()`)
  await waitFor('.practice-piano[data-lost="true"]')
  const fallback = await evaluate(`({
    mounted: document.querySelector('.practice-piano canvas') === globalThis.__installedLostCanvas,
    message: document.querySelector('.practice-piano .practice-failure')?.textContent,
  })`)
  assert.ok(fallback.mounted, 'A temporary graphics loss must not unmount the restore listener')
  assert.match(fallback.message, /flat keyboard/i)
  await evaluate(`globalThis.__installedLossExtension.restoreContext()`)
  await waitFor('.practice-piano[data-ready="true"]:not([data-lost])')
  const restored = await evaluate(`({
    sameCanvas: document.querySelector('.practice-piano canvas') === globalThis.__installedLostCanvas,
    contextLost: document.querySelector('.practice-piano canvas').getContext('webgl').isContextLost(),
    failure: document.querySelector('.practice-piano .practice-failure')?.textContent ?? null,
  })`)
  assert.ok(restored.sameCanvas && !restored.contextLost && restored.failure === null, 'The installed 3D piano returns after graphics restoration')
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  await writeFile(join(root, `${artifact}-scene.png`), Buffer.from(screenshot.data, 'base64'))
  visual = {scene, ready, combinations, narrow, motion, release, fallback, restored}
  }
  if (handsCheck) await call('Emulation.setDeviceMetricsOverride', { width: 617, height: 978, deviceScaleFactor: 1.5, mobile: false })
  if (checkControls) {
    await toggle('Note letters', true)
    await toggle('Fingering', false)
  }
  await evaluate(`(() => {
    const button = document.querySelector('.chordview-option[data-view="hands"]');
    if (!button) throw new Error('The piano lesson has no Hands & keys view');
    button.click();
    return document.fonts.ready;
  })()`)
  await waitFor('.practice-hands canvas')
  const waitForHands = () => evaluate(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 10000;
    let previous = '', settled = 0;
    function inspect() {
      const canvas = document.querySelector('.practice-hands canvas');
      const rect = canvas?.getBoundingClientRect();
      const signature = canvas && [canvas.width, canvas.height, rect.width, rect.height].join(',');
      const sized = rect?.width > 0 && rect?.height > 0 &&
        Math.abs(canvas.width / rect.width - devicePixelRatio) < 0.02 &&
        Math.abs(canvas.height / rect.height - devicePixelRatio) < 0.02;
      settled = sized && signature === previous ? settled + 1 : 0;
      previous = signature;
      if (settled >= 5) return resolve(true);
      if (performance.now() > deadline) return reject(new Error('Hands & keys did not settle at the actual device pixel ratio'));
      requestAnimationFrame(inspect);
    }
    requestAnimationFrame(inspect);
  })`)
  await waitForHands()
  const settledResizeNotifications = await evaluate(`globalThis.__installedResizeNotifications.length`)
  const sampleHands = (milliseconds, startPlayback = false) => evaluate(`new Promise((resolve, reject) => {
    const frames = [];
    const started = performance.now(), limit = started + 90000 + ${milliseconds};
    let soundingAt = null, deadline = ${startPlayback} ? Infinity : started + ${milliseconds};
    const schedule = () => requestAnimationFrame(() => {
      try { capture(); } catch (error) { reject(error); }
    });
    function capture() {
      const section = document.querySelector('.practice-hands');
      const canvas = section?.querySelector('canvas');
      const context = canvas?.getContext('2d');
      if (!context || !canvas.width || !canvas.height) throw new Error('Hands & keys did not render');
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      const colors = new Set();
      for (let index = 0; index < pixels.length; index += 64) {
        for (let channel = 0; channel < 3; channel++) hash = Math.imul(hash ^ pixels[index + channel], 16777619);
        colors.add(pixels[index] + ',' + pixels[index + 1] + ',' + pixels[index + 2]);
      }
      frames.push({time: performance.now(), width: canvas.width, height: canvas.height, active: section.dataset.active, hash: hash >>> 0, colors: colors.size,
        letters: section.dataset.letters, fingers: section.dataset.fingers,
        drawnText: ${checkControls} ? [...(canvas.__installedDrawnText ?? [])] : undefined});
      if (${startPlayback} && soundingAt === null && section.dataset.active && !section.dataset.active.startsWith('paused:')) {
        soundingAt = performance.now();
        deadline = soundingAt + ${milliseconds};
      }
      if (performance.now() >= limit) return reject(new Error('Hands & keys did not reach actual sounding playback'));
      if (performance.now() >= deadline) return resolve({
        frames, width: canvas.width, cssWidth: canvas.clientWidth,
        startToSoundingMs: soundingAt === null ? null : soundingAt - started,
        summary: section.querySelector('.visually-hidden')?.textContent,
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        drawnText: canvas.__installedDrawnText ?? [],
      });
      schedule();
    }
    if (${startPlayback}) document.querySelector('button[aria-label="Play"]').click();
    schedule();
  })`)
  const idleHands = await sampleHands(300)
  assert.equal(await evaluate(`globalThis.__installedResizeNotifications.length`), settledResizeNotifications,
    'Resize delivery notifications must stop once the actual canvas dimensions settle')
  await writeFile(join(root, `${artifact}-hands-idle.json`), JSON.stringify(idleHands, null, 2))
  assert.ok(idleHands.frames.every(frame => frame.colors > 5), 'Hands & keys draws a nonblank keyboard')
  assert.ok(Math.abs(idleHands.width / idleHands.cssWidth - 1.5) < 0.02, 'Hands & keys uses the actual DPR 1.5 backbuffer')
  assert.equal(new Set(idleHands.frames.map(frame => `${frame.width},${frame.height}`)).size, 1,
    'The initial paused pixel sample is collected after mount layout settles')
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth`),
    'The Hands & keys view does not overflow the actual viewport')
  assert.equal(new Set(idleHands.frames.map(frame => frame.hash)).size, 1, 'Paused 2D highlights do not animate independently')
  assert.match(idleHands.summary, /Paused|No notes at the playhead/)
  if (checkControls) {
    assert.equal((await readControls()).fingers, 'false', 'The 2D view retains the 3D fingering preference')
    assert.ok(idleHands.frames.every(frame => frame.fingers === ''), 'Actual 2D finger labels are empty when disabled')
    assert.ok(idleHands.frames.every(frame => !frame.drawnText.some(item => /^[1-5]$/.test(item.text))),
      'The canvas does not draw hidden finger numbers')
    const navigation = async (direction) => {
      const before = await readControls()
      await evaluate(`(() => {
        const buttons = [...document.querySelectorAll('button')].filter(button =>
          [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent.trim()].some(text =>
            text && new RegExp('^' + ${JSON.stringify(direction)} + '(?: lesson)?$', 'i').test(text)));
        if (buttons.length !== 1) throw new Error('Expected one lesson navigation control: ' + ${JSON.stringify(direction)});
        buttons[0].click();
      })()`)
      await evaluate(`new Promise((resolve, reject) => {
        const deadline = performance.now() + 10000;
        function inspect() {
          if (document.querySelector('h1')?.textContent !== ${JSON.stringify(before.title)} &&
              document.querySelector('.practice-hands canvas') &&
              document.querySelector('button[aria-label="Play"]')) return resolve(true);
          if (performance.now() > deadline) return reject(new Error('Lesson navigation did not settle in Hands & keys'));
          requestAnimationFrame(inspect);
        }
        inspect();
      })`)
      await waitForScore()
      await waitForHands()
      const state = await readControls()
      assert.equal(state.view, 'hands', 'Lesson navigation retains the actual selected guide view')
      assert.equal(state.bar, '1', 'Lesson navigation resets to bar 1')
      assert.equal(state.letters, before.letters, 'Lesson navigation retains Note letters')
      assert.equal(state.fingers, before.fingers, 'Lesson navigation retains Fingering')
      assert.ok(await evaluate(`Boolean(document.querySelector('button[aria-label="Play"]'))`), 'Lesson navigation stops playback')
      return state
    }
    controls.next = await navigation('Next')
    controls.previous = await navigation('Previous')
    assert.notEqual(controls.next.title, controls.previous.title, 'Next and Previous change the actual lesson')
  }
  const playingHands = await sampleHands(checkControls ? 9000 : 6000, true)
  assert.ok(playingHands.frames.some(frame => frame.active === 'paused:'), 'Count-in has no sounding keys')
  if (checkControls) controls.startToSounding2dMs = playingHands.startToSoundingMs
  if (checkControls) await writeFile(join(root, `${artifact}-hands-playing.json`), JSON.stringify(playingHands, null, 2))
  const hashesByNotes = new Map()
  for (const frame of playingHands.frames) {
    if (!frame.active || frame.active.startsWith('paused:')) continue
    const hashes = hashesByNotes.get(frame.active) ?? new Set()
    hashes.add(frame.hash)
    hashesByNotes.set(frame.active, hashes)
  }
  assert.ok([...hashesByNotes.values()].some(hashes => hashes.size >= 3),
    'The actual 2D pixels pulse and glow while the sounding key set stays the same')
  if (checkControls) {
    const letterFrames = playingHands.frames.filter(frame => frame.letters)
    assert.ok(letterFrames.some(frame => frame.letters.includes(':next')), 'Upcoming 2D notes carry their note letters')
    assert.ok(letterFrames.some(frame => frame.letters.split(',').some(letter => !letter.endsWith(':next'))),
      'Sounding 2D notes carry their note letters')
    for (const frame of letterFrames) {
      for (const label of frame.letters.split(',')) {
        const letter = label.split(':')[1]
        assert.ok(frame.drawnText.some(item => item.text === letter), `The canvas actually draws ${label}`)
      }
      assert.equal(frame.fingers, '', 'Playback cannot re-enable hidden 2D fingering')
      assert.ok(!frame.drawnText.some(item => /^[1-5]$/.test(item.text)), 'Playback draws no hidden finger numbers')
    }
    controls.playing2d = {letterFrames: letterFrames.length, actualCanvasText: true}
  }
  await evaluate(`document.querySelector('button[aria-label="Pause"]').click()`)
  const pausedHands = await sampleHands(400)
  assert.equal(new Set(pausedHands.frames.slice(2).map(frame => frame.hash)).size, 1, '2D feedback stops changing after Pause')
  assert.match(pausedHands.summary, /Paused|No notes at the playhead/)
  if (checkControls) {
    assert.ok(pausedHands.frames.every(frame => !frame.letters?.includes(':next')), 'Paused 2D keys show no upcoming letters')
    await toggle('Note letters', false)
    await toggle('Fingering', true)
    await waitForScore()
    await waitForHands()
    const fingerHands = await sampleHands(200)
    await writeFile(join(root, `${artifact}-hands-fingering.json`), JSON.stringify(fingerHands, null, 2))
    assert.ok(fingerHands.frames.every(frame => !frame.drawnText.some(item => /^[A-G](?:#|b|\u266f|\u266d)?$/.test(item.text))),
      'Note letters off removes the actual drawn 2D letter labels')
    assert.ok(fingerHands.frames.some(frame => frame.fingers && frame.drawnText.some(item => /^[1-5]$/.test(item.text))),
      'Fingering on restores actual drawn 2D finger numbers')
    await toggle('Fingering', false)
    const header = () => evaluate(`(() => {
      const heading = document.querySelector('.ws-head');
      const title = heading?.querySelector('h1');
      const controls = heading?.querySelector('.ws-controls');
      const options = heading?.querySelector('.harmony-options');
      return {width: innerWidth, heading: heading?.getBoundingClientRect().toJSON(),
        title: title?.getBoundingClientRect().toJSON(), controls: controls?.getBoundingClientRect().toJSON(),
        clippedTitle: title ? title.scrollWidth > title.clientWidth : null,
        overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
        options: Boolean(options), expanded: options?.open, summary: options?.querySelector('summary')?.textContent};
    })()`)
    const harmonyAvailable = await evaluate(`(() => {
      const button = [...document.querySelectorAll('.chordview-option')].find(button => /Harmony line/i.test(button.textContent));
      if (button) button.click();
      return Boolean(button);
    })()`)
    controls.harmonyAvailable = harmonyAvailable
    controls.headers = []
    await writeFile(join(root, `${artifact}-controls-progress.json`), JSON.stringify({url, partial: true, controls, errors, viteUpdates}, null, 2))
    for (const width of [617, 1440, 2000]) {
      await call('Emulation.setDeviceMetricsOverride', {width, height: 978, deviceScaleFactor: 1.5, mobile: false})
      await waitForScore()
      const geometry = await header()
      controls.headers.push(geometry)
      await writeFile(join(root, `${artifact}-header-${width}.json`), JSON.stringify({url, geometry, errors, viteUpdates}, null, 2))
      assert.ok(geometry.heading && geometry.title && geometry.controls, 'The header groups its title and view controls')
      assert.ok(!geometry.overflow && !geometry.clippedTitle, 'The practice header keeps the title readable without horizontal overflow')
      if (harmonyAvailable) assert.ok(geometry.options && !geometry.expanded && /Harmony:/.test(geometry.summary),
        'Harmony settings stay available in a compact, closed disclosure')
    }
    await call('Emulation.setDeviceMetricsOverride', {width: 617, height: 978, deviceScaleFactor: 1.5, mobile: false})
    await evaluate(`document.querySelector('.chordview-option[data-view="hands"]').click()`)
    await waitFor('.practice-hands canvas')
    await waitForScore()
    await waitForHands()
  }
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  const reducedHands = await sampleHands(300)
  assert.ok(reducedHands.reduced && reducedHands.frames.every(frame => frame.colors > 5),
    'The reduced-motion preference keeps the existing 2D guide readable')
  assert.equal(new Set(reducedHands.frames.map(frame => frame.hash)).size, 1)
  const hands = {
    idleFrames: idleHands.frames.length, countInEmpty: true, pulseWhileSameNotes: true,
    distinctPixelStatesByNotes: [...hashesByNotes].map(([notes, hashes]) => ({notes, colors: hashes.size})),
    pausedStable: true, pausedSummary: pausedHands.summary, reducedMotionReadable: true,
  }
  const handsScreenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  await writeFile(join(root, `${artifact}-hands.png`), Buffer.from(handsScreenshot.data, 'base64'))
  const resizeNotifications = await evaluate(`globalThis.__installedResizeNotifications`)
  await writeFile(join(root, `${artifact}-runtime.json`), JSON.stringify({ url, partialCheck, handsCheck, controlsCheck, version, drums, piano, compactPanels, visual, hands, controls, resizeNotifications, errors }, null, 2))
  assert.deepEqual(errors, [], 'Installed UI produced browser errors')
  assert.deepEqual(viteUpdates, [], 'Source changed during the preview check; freeze the checkpoint before admission')
  console.log(`${handsCheck ? 'Hands-only checkpoint' : visualCheckpoint ? 'Visual checkpoint only' : preview ? 'Live preview' : 'Installed production bundle'}: ${drums.lessons} drum and ${piano.lessons} genre piano lessons; ${visual ? 'stage piano in all four looks; perspective camera; DPR 1.5; no 617px overflow; playing/released keys; graphics recovery; ' : ''}2D clock-driven pulse/glow`)
  }
  }
} catch (error) {
  checkFailure = error
  let context = null
  if (readFailureContext) {
    try { context = await readFailureContext() } catch (contextError) {
      context = { diagnosticError: contextError.message }
    }
  }
  await writeFile(join(root, `${resultArtifact}-failure.json`), JSON.stringify({
    url, error: error.stack ?? error.message, context, errors, failedRequests, httpErrors, viteUpdates,
    inflightRequests: [...inflightRequests.values()], audioContexts: [...audioContexts.values()],
  }, null, 2))
  throw error
} finally {
  let closeFailure
  if (browser.exitCode === null) {
    try {
      await command('Browser.close', {}, undefined, 10000)
      browser.stdio[3].destroy()
      browser.stdio[4].destroy()
    } catch (error) {
      closeFailure = error
      console.error('Owned browser close failed; terminating it', error.message)
      browser.kill()
    }
  }
  browser.stdio[3].destroy()
  browser.stdio[4].destroy()
  await stopOwnedBrowsers(profile)
  if (browser.exitCode === null) browser.kill()
  await exited
  for (const entry of pending.values()) {
    clearTimeout(entry.timer)
    entry.reject(new Error('Browser closed'))
  }
  if (!sharedProfile) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 })
  if (viewMemoryCheck && closeFailure) {
    if (checkFailure) throw new AggregateError([checkFailure, closeFailure], 'The UI check and browser shutdown both failed')
    throw new Error('The restart check could not request browser shutdown', { cause: closeFailure })
  }
}
