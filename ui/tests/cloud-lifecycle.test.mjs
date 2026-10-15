import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from '../node_modules/typescript/lib/typescript.js'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const sourceRoot = fileURLToPath(new URL('../src/library/', import.meta.url))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
const rawText = (node) => node == null || typeof node === 'boolean' ? ''
  : Array.isArray(node) ? node.map(rawText).join(' ')
    : typeof node === 'object' ? rawText(node.props?.children) : String(node)
const text = (node) => rawText(node).replace(/\s+/g, ' ').trim()
function nodes(tree, predicate) {
  if (tree == null || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap((node) => nodes(node, predicate))
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)]
}
const button = (tree, label) => nodes(tree, (node) => node.type === 'button'
  && (node.props['aria-label'] === label || text(node) === label))[0]
const showSettingsSection = (view, name) => {
  const target = nodes(view.tree, (node) => node.type === 'button' && text(node).startsWith(name))[0]
  assert.ok(target, `Settings section ${name} is available`)
  target.props.onClick()
  view.update()
}
const openSettings = (view, section = 'Analysis processing') => {
  button(view.tree, 'Song analysis settings').props.onClick()
  view.update()
  showSettingsSection(view, section)
}

function harness(overrides = {}, { loadCloudSetup = false, gettingStartedSeen = true, liveMidiPreview = false } = {}) {
  let active
  const preferences = new Map(gettingStartedSeen ? [['mizan:getting-started:seen', 'true']] : [])
  const timers = []
  const intervals = new Map()
  const midiListeners = new Set()
  let nextInterval = 1
  const host = {
    library: async () => [], folders: async () => [],
    searchYouTube: async () => [], searchYouTubeMusic: async () => [],
    popularSongs: async () => ({
      title: 'Top Songs', period: 'CHART_PERIOD_TYPE_WEEKLY', market: 'global',
      chartDate: '2026-10-03', fetchedAt: '2026-10-10T00:00:00Z',
      sourceUrl: 'https://artists.youtube.com/charts/tracks', rows: [],
    }),
    getTranscriptionModel: async () => 'muscriptor-small',
    ffmpegStatus: async () => ({
      configuredPath: null, effectivePath: 'ffmpeg', available: true, issue: null,
    }),
    setFfmpegPath: async (path) => ({
      configuredPath: path || null, effectivePath: path || 'ffmpeg', available: true, issue: null,
    }),
    hfTokenStatus: async () => true, modelPreflight: async () => ({}),
    modelDownloadStatus: async () => ({}), resourceUsage: async () => null,
    cloudProviders: async () => ({ providers: [
      { id: 'azure', name: 'Azure' },
      { id: 'gcp', name: 'Google Cloud' }, { id: 'aws', name: 'AWS' },
    ], activeProvider: 'azure' }),
    cloudSettings: async (provider) => ({ provider, settings: { provider } }),
    selectCloudProvider: async (provider) => ({ provider, providerName: provider }),
    cloudStatus: async (_id, provider = 'azure') => ({
      provider, providerName: provider, available: false, configured: false, mode: 'local',
    }),
    cancelCloudStatus: async () => ({ cancelRequested: true }),
    cloudReadinessProgress: async () => ({
      stage: 'idle', detail: null, elapsedSeconds: 0, timeoutSeconds: 120,
    }),
    cloudSetupProgress: async () => ({ operation: null, stage: '', completed: 0, total: 0, detail: null }),
    cancelCloudSetup: async () => ({ cancelRequested: true }),
    ...overrides,
  }
  class HostError extends Error { fix = null }
  const react = {
    useState(initial) {
      const renderer = active, index = renderer.cursor++
      const slot = renderer.slots[index] ??= {
        value: typeof initial === 'function' ? initial() : initial,
      }
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (!Object.is(value, slot.value)) { slot.value = value; renderer.dirty = true }
      }]
    },
    useRef(initial) {
      const index = active.cursor++
      return active.slots[index] ??= { current: initial }
    },
    useMemo(factory, deps) {
      const index = active.cursor++, old = active.slots[index]
      if (!old || !sameDeps(old.deps, deps)) active.slots[index] = { deps, value: factory() }
      return active.slots[index].value
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps) },
    useEffect(effect, deps) {
      const renderer = active, index = renderer.cursor++, old = renderer.slots[index]
      if (!old || !sameDeps(old.deps, deps)) {
        renderer.slots[index] = { deps, cleanup: old?.cleanup }
        renderer.effects.push(() => {
          old?.cleanup?.()
          renderer.slots[index].cleanup = effect()
        })
      }
    },
  }
  const modules = new Map()
  const jsx = (type, props) => ({ type, props })
  const browser = {
    location: { origin: 'https://mizan.local' },
    localStorage: {
      getItem: (key) => preferences.get(key) ?? null,
      setItem: (key, value) => preferences.set(key, String(value)),
    },
    addEventListener() {}, removeEventListener() {},
    setInterval: (callback, ms) => {
      const id = nextInterval++
      intervals.set(id, { callback, ms })
      return id
    },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (callback) => { timers.push(callback); return timers.length },
    clearTimeout() {},
  }
  function load(name) {
    if (modules.has(name)) return modules.get(name)
    const filename = sourceRoot + name
    let source = readFileSync(filename, 'utf8').replaceAll('import.meta.env', '({})')
    if (name === 'Library.tsx') source += '\nexport { Queue, YouTubeSearch, PopularMusic, unifyMidiResults, MidiSearch }\n'
    if (name === 'CloudSetup.tsx') source += '\nexport { GcpAccountFields, AwsAccountFields, ProviderCredentialPrerequisites }\n'
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2023 },
    }).outputText
    const module = { exports: {} }
    modules.set(name, module.exports)
    vm.runInNewContext(output, {
      module, exports: module.exports, console, Error, crypto: webcrypto,
      window: browser, document: { activeElement: null, addEventListener() {}, removeEventListener() {} },
      ResizeObserver: class { observe() {} disconnect() {} },
      setTimeout: browser.setTimeout, clearTimeout: browser.clearTimeout,
      setInterval: browser.setInterval, clearInterval: browser.clearInterval,
      require(specifier) {
        if (specifier === 'react') return react
        if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' }
        if (specifier === 'lucide-react') return new Proxy({}, { get: (_target, key) => key })
        if (specifier === './bridge') return {
          host, HostError, IMPORTABLE: /\.(mid|midi|musicxml|xml|mxl)$/i,
          liveMidiPreview,
          onMidiFileOpened(listener) {
            midiListeners.add(listener)
            return () => midiListeners.delete(listener)
          },
        }
        if (specifier === '../course/Course') return { CourseSection: 'course-section' }
        if (specifier === '../course/curriculum') return { LESSONS: [] }
        if (specifier === '../course/piano') return { PIANO_LESSONS: [] }
        if (specifier === '../course/pianoInspired') return { PIANO_INSPIRED: [] }
        if (specifier === '../course/fretted') return { FRETTED_LESSONS: [] }
        if (specifier === './CloudSetup') return loadCloudSetup
          ? load('CloudSetup.tsx') : { CloudSetup: 'cloud-setup' }
        if (specifier.endsWith('.css')) return {}
        if (specifier.startsWith('./')) return load(specifier.slice(2) + '.ts')
        return require(specifier)
      },
    }, { filename })
    return module.exports
  }
  function render(Component, props) {
    const renderer = {
      slots: [], cursor: 0, effects: [], dirty: true, tree: null, props,
      update(next = this.props) {
        this.props = next
        for (let pass = 0; pass < 20; pass++) {
          this.cursor = 0; this.dirty = false; active = this
          this.tree = Component(this.props)
          for (const effect of this.effects.splice(0)) effect()
          if (!this.dirty) return this.tree
        }
        throw new Error('Unstable hook rendering')
      },
      async settle() {
        await new Promise((resolve) => setImmediate(resolve))
        return this.update()
      },
      unmount() { for (const slot of this.slots) slot?.cleanup?.() },
    }
    renderer.update()
    return renderer
  }
  return {
    host, HostError, load, render, preferences,
    openMidiFile: (file) => { for (const listener of midiListeners) listener(file) },
    runTimers: () => { for (const callback of timers.splice(0)) callback() },
    runIntervals: (ms) => {
      for (const interval of intervals.values()) if (interval.ms === ms) interval.callback()
    },
  }
}

const libraryProps = {
  jobs: [], version: 0, onQueueChange() {}, onOpen() {}, onDetails() {}, onCredits() {},
  tab: 'catalog', onTab() {},
}
const cloudReady = { mode: 'cloud', configured: true, available: true,
  supportedModels: ['muscriptor-small', 'muscriptor-medium', 'muscriptor-large'] }
const savedCloudSetup = {
  configured: false, mode: 'cloud', available: true, prepared: true, jobCreated: true,
  config: { tenantId: 'tenant', subscriptionId: 'subscription', resourceGroup: 'rg-existing',
    storageAccount: 'mizanexisting', container: 'jobs', jobName: 'mizan-gpu-transcribe',
    location: 'italynorth', registry: 'mizanexistingacr', vnet: 'mizan-vnet',
    subnet: 'aca-subnet', vnetCidr: '10.42.0.0/16', subnetCidr: '10.42.0.0/23',
    environment: 'mizan-aca-env', identity: 'mizan-gpu-identity' },
}

test('library separates Discover, the local catalog, and the existing Course tab', async () => {
    const h = harness({ popularSongs: async () => ({
      title: 'YouTube Music', fetchedAt: '2026-10-13T00:00:00Z', sections: [],
    }) })
    const Library = h.load('Library.tsx').Library
    const view = h.render(Library, libraryProps)
    await view.settle()

    const tabs = nodes(view.tree, (node) => node.props?.role === 'tab')
    assert.deepEqual(tabs.map((node) => node.props['data-tab']), ['discover', 'catalog', 'course'])
    assert.match(text(tabs[0]), /^Discover$/)
    assert.match(text(tabs[1]), /^Local song catalog/)
    assert.match(text(tabs[2]), /^Course/)
    const panel = (id) => nodes(view.tree, (node) => node.props?.id === `lib-panel-${id}`)[0]
    assert.equal(panel('discover').props.hidden, true)
    assert.equal(panel('catalog').props.hidden, false, 'The saved catalog remains the default')
    assert.equal(panel('course').props.hidden, true)
    assert.equal(nodes(panel('catalog'), (node) => node.type?.name === 'PopularMusic').length, 0)
    const libraryRoot = () => nodes(view.tree, (node) => node.props?.className?.split(' ').includes('lib'))[0]
    assert.ok(libraryRoot().props.className.split(' ').includes('lib-empty'),
      'An empty catalog centers the first-use intake')

    view.update({ ...libraryProps, tab: 'discover' })
    assert.equal(panel('discover').props.hidden, false)
    assert.equal(nodes(panel('discover'), (node) => node.type?.name === 'PopularMusic').length, 1)
    assert.equal(nodes(panel('catalog'), (node) => node.type?.name === 'PopularMusic').length, 0)
    assert.ok(!libraryRoot().props.className.split(' ').includes('lib-empty'),
      'Discover starts at the top and stays scrollable without saved songs')

    view.update({ ...libraryProps, tab: 'course' })
    assert.equal(panel('course').props.hidden, false)
    assert.equal(nodes(panel('course'), (node) => node.type === 'course-section').length, 1)
    assert.ok(!libraryRoot().props.className.split(' ').includes('lib-empty'),
      'Course starts at the top and stays scrollable without saved songs')
    view.unmount()
})

const job = (overrides = {}) => ({
  id: 'running', kind: 'transcribe', songId: null, url: 'https://youtu.be/aB_12-cD345',
  title: 'Synthetic song', status: 'running', stage: 'detect', order: 0,
  processingMode: 'cloud', transcriptionModel: 'muscriptor-large', progress: 0.3,
  warnings: [], detected: null, stages: [{ name: 'detect', seconds: null, provider: null, method: null }],
  createdAt: new Date().toISOString(), ...overrides,
})

test('slow Azure dialog opens immediately, shows checking, and never guesses Local', async () => {
  const status = deferred(), ids = []
  const h = harness({ cloudStatus: (id) => { ids.push(id); return status.promise } })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view)
  const processing = nodes(view.tree, (node) => node.props?.className === 'model-settings-cloud')[0]
  assert.equal(text(nodes(processing, (node) => node.type === 'h3')[0]), 'Analysis processing')
  const mode = nodes(processing, (node) => node.props?.className === 'cloud-mode')[0]
  assert.equal(text(nodes(mode, (node) => node.type === 'legend')[0]), 'Send new analysis to')
  assert.deepEqual(nodes(mode, (node) => node.type === 'label').map(text), ['This PC', 'Cloud'])
  const controls = nodes(processing, (node) => node.type === 'fieldset' || node.type === 'select')
  assert.equal(controls[0], mode, 'Processing choice comes before the Cloud provider picker')
  assert.equal(controls[1].props['aria-label'], 'Cloud provider')
  assert.match(text(view.tree), /Loading cloud providers/)
  await view.settle()
  assert.match(text(view.tree), /Checking Azure setup/)
  assert.ok(button(view.tree, 'Close song analysis settings'))
  assert.equal(ids.length, 1)
  assert.equal(nodes(view.tree, (node) => node.type === 'input'
    && node.props.name === 'processing-mode').some((node) => node.props.checked), false)
  status.resolve(cloudReady)
  await view.settle()
  assert.match(text(view.tree), /Cloud is on for new and redone analyses/)
  view.unmount()
})

test('getting started is optional, limited to first use, and replayable from settings', async () => {
  const tabs = []
  const firstRun = harness({}, { gettingStartedSeen: false })
  const view = firstRun.render(firstRun.load('Library.tsx').Library, {
    ...libraryProps, onTab: (tab) => tabs.push(tab),
  })
  await view.settle()
  firstRun.runTimers()
  view.update()
  assert.match(text(view.tree), /Try a lesson or import a score now/)
  assert.equal(firstRun.preferences.get('mizan:getting-started:seen'), undefined)
  assert.equal(nodes(view.tree, (node) => node.type === 'input' && node.props.id === 'ffmpeg-path').length, 0)
  button(view.tree, 'Practice with the Course').props.onClick()
  view.update()
  assert.deepEqual(tabs, ['course'])
  assert.equal(firstRun.preferences.get('mizan:getting-started:seen'), 'true')
  assert.equal(nodes(view.tree, (node) => node.props?.id === 'model-settings').length, 0)
  button(view.tree, 'Song analysis settings').props.onClick()
  view.update()
  button(view.tree, 'Getting started guide').props.onClick()
  view.update()
  assert.match(text(view.tree), /Try a lesson or import a score now/)
  view.unmount()

  const established = harness({ library: async () => [{
    id: 'saved', title: 'Saved song', artist: null, thumbnail: null, source: 'midi',
    parts: ['Piano'], recording: false, duration: null, createdAt: new Date().toISOString(),
    practicedAt: null, position: null, folders: [], outdated: false,
    transcriptionModel: null, separationMethod: null,
  }] }, { gettingStartedSeen: false })
  const establishedView = established.render(established.load('Library.tsx').Library, libraryProps)
  await establishedView.settle()
  established.runTimers()
  establishedView.update()
  assert.equal(nodes(establishedView.tree, (node) => node.props?.id === 'model-settings').length, 0)
  establishedView.unmount()

  const course = harness({}, { gettingStartedSeen: false })
  const courseView = course.render(course.load('Library.tsx').Library, { ...libraryProps, tab: 'course' })
  await courseView.settle()
  course.runTimers()
  courseView.update()
  assert.equal(nodes(courseView.tree, (node) => node.props?.id === 'model-settings').length, 0)
  courseView.unmount()

  const activation = harness({}, { gettingStartedSeen: false })
  const activationView = activation.render(activation.load('Library.tsx').Library, libraryProps)
  activation.openMidiFile({ name: 'Opened.mid', dataBase64: 'T1RoZA==' })
  activationView.update()
  activation.runTimers()
  activationView.update()
  assert.equal(nodes(activationView.tree, (node) => node.props?.id === 'model-settings').length, 0)
  assert.equal(nodes(activationView.tree, (node) => node.props?.className === 'midi-import-dialog').length, 1)
  activationView.unmount()
})

test('getting started uses real save actions and only finishes with ready audio and model', async () => {
  const calls = []
  let audio = { configuredPath: null, effectivePath: null, available: false, issue: 'Install FFmpeg first.' }
  let downloaded = false
  let eligible = true
  const h = harness({
    ffmpegStatus: async () => audio,
    browseFfmpegPath: async () => ({ path: 'C:\\Audio\\ffmpeg.exe' }),
    setFfmpegPath: async (path) => {
      calls.push(['audio', path])
      return audio = { configuredPath: path, effectivePath: path, available: true, issue: null }
    },
    hfTokenStatus: async () => false,
    setHfToken: async (token) => { calls.push(['token', token]); return true },
    modelPreflight: async () => ({ 'muscriptor-small': {
      eligible, reason: eligible ? null : 'Close other apps to free memory.',
    } }),
    modelDownloadStatus: async () => ({ 'muscriptor-small': { downloaded, active: false } }),
    startModelDownload: async (model) => { calls.push(['download', model]); downloaded = true },
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view, 'Audio support')
  await view.settle(); await view.settle()
  button(view.tree, 'Getting started guide').props.onClick()
  view.update()
  button(view.tree, 'Set up song analysis').props.onClick()
  view.update()
  assert.equal(button(view.tree, 'Continue').props.disabled, true)
  assert.deepEqual(calls, [], 'The guide does not save or download anything on its own')
  button(view.tree, 'Browse…').props.onClick()
  await view.settle()
  assert.equal(nodes(view.tree, (node) => node.props?.id === 'ffmpeg-path')[0].props.value, 'C:\\Audio\\ffmpeg.exe')
  assert.deepEqual(calls, [], 'Browsing fills the field but does not save it')
  await nodes(view.tree, (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  await view.settle()
  assert.equal(button(view.tree, 'Continue').props.disabled, false)
  button(view.tree, 'Continue').props.onClick()
  view.update()
  assert.equal(button(view.tree, 'Continue').props.disabled, true)
  const token = 'hf_test_placeholder_not_a_real_token'
  nodes(view.tree, (node) => node.props?.id === 'hf-token')[0].props.onChange({ target: { value: token } })
  view.update()
  await nodes(view.tree, (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  await view.settle()
  assert.equal(nodes(view.tree, (node) => node.props?.id === 'hf-token')[0].props.value, '')
  assert.equal(JSON.stringify([...h.preferences]).includes(token), false)
  button(view.tree, 'Continue').props.onClick()
  view.update()
  assert.equal(button(view.tree, 'Find a song').props.disabled, true)
  button(view.tree, 'Back').props.onClick()
  view.update()
  assert.equal(button(view.tree, 'Continue').props.disabled, false, 'Back retains the saved token state')
  button(view.tree, 'Continue').props.onClick()
  view.update()
  await button(view.tree, 'Download MuScriptor Small').props.onClick()
  await view.settle()
  assert.equal(button(view.tree, 'Find a song').props.disabled, false)
  eligible = false
  h.runIntervals(5000)
  await view.settle()
  assert.equal(button(view.tree, 'Find a song').props.disabled, true)
  assert.match(text(view.tree), /Close other apps to free memory/)
  eligible = true
  h.runIntervals(5000)
  await view.settle()
  button(view.tree, 'Find a song').props.onClick()
  view.update()
  assert.equal(nodes(view.tree, (node) => node.props?.id === 'model-settings').length, 0)
  assert.equal(h.preferences.get('mizan:getting-started:seen'), 'true')
  assert.deepEqual(calls, [['audio', 'C:\\Audio\\ffmpeg.exe'], ['token', token], ['download', 'muscriptor-small']])
  view.unmount()
})

test('model settings explain token access before offering MuScriptor downloads', async () => {
  const h = harness()
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view, 'Models and account')
  await view.settle()
  const sections = nodes(view.tree, (node) => node.props?.className === 'model-settings-models')[0]
  const children = nodes(sections, () => true)
  const access = children.findIndex((node) => node.props?.className === 'model-settings-access')
  const models = children.findIndex((node) => node.props?.className === 'model-settings-choices')
  assert.ok(access >= 0 && models > access, 'Token controls appear before the model choices')
  assert.match(text(sections), /Hugging Face read-access token is needed to download MuScriptor models/)
  assert.equal(nodes(sections, (node) => node.props?.id === 'hf-token').length, 1)
  view.unmount()
})

test('missing Hugging Face access opens by default and can still be collapsed', async () => {
  const h = harness({ hfTokenStatus: async () => false })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view, 'Models and account')
  await view.settle()
  const access = () => nodes(view.tree, (node) => node.props?.className === 'model-settings-access')[0]
  assert.equal(access().props.open, true)
  access().props.onToggle({ currentTarget: { open: false } })
  view.update()
  assert.equal(access().props.open, false, 'The user can collapse the explanation after reading it')
  view.unmount()
  const configured = harness({ hfTokenStatus: async () => true })
  const saved = configured.render(configured.load('Library.tsx').Library, libraryProps)
  openSettings(saved, 'Models and account')
  await saved.settle()
  assert.equal(nodes(saved.tree, (node) => node.props?.className === 'model-settings-access')[0].props.open, false)
  saved.unmount()
})

test('native FFmpeg browsing uses the Windows request and reply format', async () => {
  const requests = []
  let listener
  let reply = { ok: true, result: { ok: true, path: 'C:\\Native\\ffmpeg.exe' } }
  const exports = {}
  const source = readFileSync(sourceRoot + 'bridge.ts', 'utf8').replaceAll('import.meta.env', '({})')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText
  vm.runInNewContext(output, {
    exports,
    require(specifier) {
      assert.equal(specifier, './mock')
      return { mockHost: {} }
    },
    window: {
      __mizanNativeShell: true,
      chrome: { webview: {
        addEventListener: (_type, callback) => { listener = callback },
        postMessage(request) {
          requests.push(request)
          listener({ data: { id: request.id, ...reply } })
        },
      } },
    },
  })
  assert.deepEqual(await exports.host.browseFfmpegPath(),
    { ok: true, path: 'C:\\Native\\ffmpeg.exe' })
  reply = { ok: true, result: { ok: true, path: null } }
  assert.deepEqual(await exports.host.browseFfmpegPath(), { ok: true, path: null })
  reply = { ok: false, error: {
    code: 'native_picker_unavailable', message: 'The file picker could not open.',
  } }
  await assert.rejects(exports.host.browseFfmpegPath(), error =>
    error.code === 'native_picker_unavailable' && error.message === reply.error.message)
  assert.deepEqual(JSON.parse(JSON.stringify(requests)),
    [1, 2, 3].map(id => ({ id, method: 'browse_ffmpeg_path', args: [] })))
})

test('FFmpeg settings show the effective path and protect drafts during file browsing', async () => {
  const current = {
    configuredPath: null, effectivePath: 'C:\\Auto\\ffmpeg.exe', available: true, issue: null,
  }
  let statusChecks = 0
  let browseRequest = () => Promise.resolve({ path: null })
  const selection = deferred()
  let browseCalls = 0
  const saved = []
  const h = harness({
    ffmpegStatus: async () => {
      if (statusChecks++ === 0) throw new Error('Status check failed.')
      return current
    },
    browseFfmpegPath: () => { browseCalls++; return browseRequest() },
    setFfmpegPath: async (path) => {
      saved.push(path)
      return { configuredPath: path || null, effectivePath: path || current.effectivePath, available: true, issue: null }
    },
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view, 'Audio support')
  await view.settle()
  assert.ok(button(view.tree, 'Retry status check'), 'A failed status request offers a retry')
  button(view.tree, 'Retry status check').props.onClick()
  await view.settle()
  assert.equal(nodes(view.tree, (node) => node.props?.id === 'ffmpeg-path')[0].props.value,
    current.effectivePath, 'Retry fills the field with the detected executable')

  const input = nodes(view.tree, (node) => node.props?.id === 'ffmpeg-path')[0]
  input.props.onChange({ target: { value: 'C:\\Draft\\ffmpeg.exe' } })
  view.update()
  browseRequest = () => selection.promise
  nodes(view.tree, (node) => node.props?.['aria-label'] === 'Browse for FFmpeg executable')[0].props.onClick()
  await view.settle()
  assert.equal(nodes(view.tree, (node) => node.props?.id === 'ffmpeg-path')[0].props.disabled, true)
  assert.equal(button(view.tree, 'Save path').props.disabled, true, 'Saving is blocked while the picker is open')
  assert.equal(browseCalls, 1)
  nodes(view.tree, (node) => node.props?.['aria-label'] === 'Browse for FFmpeg executable')[0].props.onClick()
  assert.equal(browseCalls, 1, 'A second browse request is ignored')
  selection.resolve({ path: 'C:\\Picked\\ffmpeg.exe' })
  await view.settle()
  assert.equal(nodes(view.tree, (node) => node.props?.id === 'ffmpeg-path')[0].props.value,
    'C:\\Picked\\ffmpeg.exe')
  assert.deepEqual(saved, [], 'Selecting a file does not save it')

  const updateDraft = (value) => {
    nodes(view.tree, (node) => node.props?.id === 'ffmpeg-path')[0].props.onChange({ target: { value } })
    view.update()
  }
  updateDraft('C:\\Draft\\ffmpeg.exe')
  browseRequest = () => Promise.resolve({ path: null })
  nodes(view.tree, (node) => node.props?.['aria-label'] === 'Browse for FFmpeg executable')[0].props.onClick()
  await view.settle()
  assert.equal(nodes(view.tree, (node) => node.props?.id === 'ffmpeg-path')[0].props.value,
    'C:\\Draft\\ffmpeg.exe', 'Cancel keeps the existing draft')
  assert.deepEqual(saved, [], 'Cancel does not change saved settings')

  browseRequest = () => Promise.reject(new h.HostError(
    'Could not open the Windows file picker. Enter the full path to ffmpeg.exe instead.',
  ))
  nodes(view.tree, (node) => node.props?.['aria-label'] === 'Browse for FFmpeg executable')[0].props.onClick()
  await view.settle()
  assert.match(text(nodes(view.tree, (node) => node.props?.role === 'alert')[0]),
    /Enter the full path to ffmpeg\.exe/)
  assert.equal(nodes(view.tree, (node) => node.props?.id === 'ffmpeg-path')[0].props.value,
    'C:\\Draft\\ffmpeg.exe', 'Picker errors keep the draft')
  assert.deepEqual(saved, [], 'Picker errors do not change saved settings')
  view.unmount()
})

test('FFmpeg settings show current paths after load, save, and automatic reset', async () => {
  const detected = {
    configuredPath: null, effectivePath: 'C:\\Found\\ffmpeg.exe', available: true, issue: null,
  }
  let current = detected
  const saved = []
  const h = harness({
    ffmpegStatus: async () => current,
    setFfmpegPath: async (path) => {
      saved.push(path)
      current = path
        ? { configuredPath: path, effectivePath: path, available: true, issue: null }
        : detected
      return current
    },
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view, 'Audio support')
  await view.settle()
  assert.equal(nodes(view.tree, (node) => node.props?.id === 'ffmpeg-path')[0].props.value,
    detected.effectivePath, 'Initial load shows the detected executable')

  const selected = 'C:\\Selected\\ffmpeg.exe'
  nodes(view.tree, (node) => node.props?.id === 'ffmpeg-path')[0]
    .props.onChange({ target: { value: selected } })
  view.update()
  await nodes(view.tree, (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  await view.settle()
  assert.equal(nodes(view.tree, (node) => node.props?.id === 'ffmpeg-path')[0].props.value,
    selected, 'Successful save keeps the configured path in the field')

  button(view.tree, 'Use automatic detection').props.onClick()
  await view.settle()
  assert.deepEqual(saved, [selected, ''])
  assert.equal(nodes(view.tree, (node) => node.props?.id === 'ffmpeg-path')[0].props.value,
    detected.effectivePath, 'Automatic reset shows the path found on this PC')
  view.unmount()
})

test('Azure starts with an existing subnet, keeps saved networks, and resets approvals after edits', async () => {
  const subscriptionId = '11111111-1111-1111-1111-111111111111'
  const subnetId = `/subscriptions/${subscriptionId}/resourceGroups/network/providers/Microsoft.Network/virtualNetworks/shared/subnets/aca`
  const subscriptions = [{ id: subscriptionId, name: 'Test subscription', tenantId: '22222222-2222-2222-2222-222222222222' }]
  const calls = []
  const h = harness({
    azureSubscriptions: async () => subscriptions,
    configureCloud: async (config) => { calls.push(['save', config]); return { config, mode: 'local', configured: false } },
    prepareCloud: async (config, consent) => { calls.push(['prepare', config, consent]); return { prepared: true } },
  }, { loadCloudSetup: true })
  const props = { provider: 'azure', status: null, onStatus() {}, onClose() {}, acquireOperation: () => () => {} }
  const entry = h.render(h.load('CloudSetup.tsx').CloudSetup, props)
  const view = h.render(entry.tree.type, entry.tree.props)
  button(view.tree, 'Continue').props.onClick()
  view.update()
  await view.settle()
  nodes(view.tree, (node) => node.props?.role === 'option')[0].props.onClick()
  view.update()
  nodes(view.tree, (node) => node.props?.id === 'cloud-setup-form')[0].props.ref.current = { reportValidity: () => true }
  button(view.tree, 'Continue').props.onClick()
  await view.settle()
  const networks = () => nodes(view.tree, (node) => node.type === 'input' && node.props.name === 'cloud-network')
  assert.deepEqual(networks().map((node) => node.props.value), ['existing', 'managed'])
  assert.equal(networks()[0].props.checked, true)
  const subnet = () => nodes(view.tree, (node) => node.props?.name === 'subnetResourceId')[0]
  assert.equal(subnet().props.required, true)
  subnet().props.onChange({ target: { value: subnetId } })
  view.update()
  const consent = () => nodes(view.tree, (node) => node.type === 'input' && node.props.type === 'checkbox' && node.props.required)[0]
  consent().props.onChange({ target: { checked: true } })
  view.update()
  assert.equal(consent().props.checked, true)
  networks()[1].props.onChange()
  view.update()
  assert.equal(consent().props.checked, false)
  assert.equal(subnet(), undefined)
  networks()[0].props.onChange()
  view.update()
  assert.equal(subnet().props.value, '', 'Switching back does not retain an approval for another network')
  subnet().props.onChange({ target: { value: subnetId } })
  view.update()
  consent().props.onChange({ target: { checked: true } })
  view.update()
  await nodes(view.tree, (node) => node.props?.id === 'cloud-setup-form')[0].props.onSubmit({ preventDefault() {} })
  await view.settle()
  assert.equal(calls.length, 2)
  assert.equal(calls[0][1].vnet, '')
  assert.equal(calls[0][1].subnet, '')
  assert.equal(calls[0][1].subnetResourceId, subnetId)
  assert.equal(calls[1][2], true)
  view.unmount(); entry.unmount()

  for (const saved of [
    { vnet: '', subnet: '', subnetResourceId: subnetId, mode: 'existing' },
    { vnet: 'custom-network', subnet: 'custom-subnet', subnetResourceId: '', mode: 'managed' },
    { vnet: '', subnet: '', subnetResourceId: '', mode: 'legacy' },
  ]) {
    const savedEntry = h.render(h.load('CloudSetup.tsx').CloudSetup, {
      ...props, status: { ...savedCloudSetup, config: { ...savedCloudSetup.config, subscriptionId, ...saved } },
    })
    const savedView = h.render(savedEntry.tree.type, savedEntry.tree.props)
    button(savedView.tree, 'Back').props.onClick()
    await savedView.settle()
    const choices = nodes(savedView.tree, (node) => node.type === 'input' && node.props.name === 'cloud-network')
    assert.equal(choices[0].props.checked, saved.mode === 'existing')
    assert.equal(choices[1].props.checked, saved.mode === 'managed')
    if (saved.mode === 'existing') {
      assert.equal(nodes(savedView.tree, (node) => node.props?.name === 'subnetResourceId')[0].props.value, subnetId)
    } else if (saved.mode === 'managed') {
      assert.match(text(savedView.tree), /custom-network/)
      assert.match(text(savedView.tree), /custom-subnet/)
    } else {
      assert.match(text(savedView.tree), /saved Azure-managed network stays unchanged/)
    }
    savedView.unmount(); savedEntry.unmount()
  }
})

test('all cloud account entries show credential and capacity prerequisites before their actions', async () => {
  const h = harness({}, { loadCloudSetup: true })
  const { CloudSetup, ProviderCredentialPrerequisites } = h.load('CloudSetup.tsx')
  const cases = [
    {
      provider: 'azure', name: 'Azure', href: 'https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-windows',
      commands: ['az --version', 'az login'],
      text: [/Before you start/, /saved local Azure sign-in/, /browser sign-in/, /Azure PowerShell/,
        /CLI is optional/, /same Windows account/, /not a sign-in failure/,
        /active subscription with billing enabled/, /A100 GPU availability and quota/],
    },
    {
      provider: 'gcp', name: 'Google Cloud', href: 'https://cloud.google.com/sdk/docs/install',
      commands: ['gcloud --version', 'gcloud auth application-default login'],
      text: [/Before you start/, /Application Default Credentials, or ADC/,
        /Browser sign-in/, /gcloud auth login/, /Google Cloud CLI is optional/,
        /same Windows account/, /not a sign-in failure/, /active project with billing enabled/,
        /g2-standard-4/, /g2-standard-8/, /nvidia-l4/, /GPU availability and quota/],
    },
    {
      provider: 'aws', name: 'AWS',
      href: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
      commands: ['aws --version', 'aws configure sso --profile "mizan"', 'aws sso login --profile "mizan"'],
      text: [/Before you start/, /AWS profile entered here/, /browser sign-in/,
        /CLI is optional if the profile is ready/, /aws configure/, /same Windows account/, /not a sign-in failure/,
        /active account with billing enabled/, /g5\.4xlarge/, /not Fargate/,
        /GPU availability and quota/, /Replace mizan with the profile name/],
    },
  ]

  for (const item of cases) {
    const entry = h.render(CloudSetup, {
      provider: item.provider, status: null, onStatus() {}, onClose() {},
      acquireOperation: () => () => {},
    })
    const views = [entry]
    let current = entry.tree
    while (typeof current.type === 'function') {
      const nested = h.render(current.type, current.props)
      views.push(nested)
      current = nested.tree
    }
    const panel = views.at(-1)
    await panel.settle()
    const guideNode = nodes(panel.tree,
      (node) => node.type === ProviderCredentialPrerequisites)[0]
    assert.ok(guideNode, `${item.name} mounts its credential guide`)
    const action = nodes(panel.tree, (node) => node.type === 'button'
      && text(node) === (item.provider === 'azure' ? 'Continue' : `Check ${item.name} access`))[0]
    assert.ok(action, `${item.name} has its expected next account action`)
    const order = nodes(panel.tree, (node) => node.type === ProviderCredentialPrerequisites || node === action)
    assert.strictEqual(order[0], guideNode, `${item.name} prerequisites appear before the action`)
    assert.strictEqual(order[1], action)

    const guide = h.render(guideNode.type, guideNode.props)
    const guidance = text(guide.tree)
    for (const expected of item.text) assert.match(guidance, expected, `${item.name}: ${expected}`)
    assert.doesNotMatch(guidance, /boto3|noninteractive credential chain|profile-backed SDK|quota\/capacity/i)
    const commands = nodes(guide.tree, (node) => node.type === 'code').map(text)
    for (const expected of item.commands) assert.ok(commands.includes(expected), `${item.name}: ${expected}`)
    assert.equal(nodes(guide.tree, (node) => node.type === 'a')[0].props.href, item.href)

    if (item.provider === 'gcp') {
      const instructions = nodes(guide.tree, (node) => node.type === 'p'
        && text(node).includes('gcloud auth login'))[0]
      const children = Array.isArray(instructions.props.children)
        ? instructions.props.children : [instructions.props.children]
      const loginCommand = children.findIndex((child) => child?.type === 'code'
        && text(child) === 'gcloud auth login')
      assert.equal(children[loginCommand + 1], ' ',
        'The rendered gcloud command and its explanation have a visible separating space')
    }
    guide.unmount()
    for (const view of views) view.unmount()
  }
})

test('unsupported cloud provider metadata does not open a supported provider setup', () => {
  const h = harness({}, { loadCloudSetup: true })
  const { CloudSetup } = h.load('CloudSetup.tsx')
  const view = h.render(CloudSetup, {
    status: { provider: 'unsupported', configured: false, mode: 'local' },
    onStatus() {}, onClose() {},
  })
  assert.match(text(view.tree), /This cloud provider is not supported/)
  assert.ok(button(view.tree, 'Close'))
})

test('a removed provider requires an explicit choice and never falls back to Azure', async () => {
  const calls = []
  const h = harness({
    cloudProviders: async () => ({
      providers: [{ id: 'azure', name: 'Azure' }, { id: 'gcp', name: 'Google Cloud' }, { id: 'aws', name: 'AWS' }],
      activeProvider: null, issue: 'The saved cloud provider is no longer supported. Choose a provider.',
    }),
    selectCloudProvider: async (provider) => { calls.push(['select', provider]); return { provider } },
    cloudStatus: async (_request, provider) => {
      calls.push(['status', provider])
      return { provider, configured: false, available: false, mode: 'local' }
    },
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view)
  await view.settle()
  assert.deepEqual(calls, [])
  assert.match(text(view.tree), /no longer supported/)
  const picker = nodes(view.tree, (node) => node.type === 'select' && node.props['aria-label'] === 'Cloud provider')[0]
  assert.equal(picker.props.value, '')
  assert.equal(picker.props.disabled, false)
  assert.deepEqual(nodes(picker, (node) => node.type === 'option').map((node) => node.props.value), ['', 'azure', 'gcp', 'aws'])
  assert.equal(nodes(view.tree, (node) => node.props?.className === 'cloud-mode')[0].props.disabled, true)
  picker.props.onChange({ target: { value: 'azure' } })
  await view.settle(); await view.settle()
  assert.deepEqual(calls, [['select', 'azure'], ['status', 'azure']])
  view.unmount()
})

test('Google Cloud project discovery is retryable and fills resource names only after selection', async () => {
  let result = 'missing', calls = 0
  const h = harness({
    cloudSubscriptions: async (provider) => {
      assert.equal(provider, 'gcp')
      calls++
      if (result === 'missing') throw new Error(
        'Google Cloud Application Default Credentials are unavailable. Run gcloud auth application-default login under the same Windows account that runs Mizan, then retry. Browser sign-in and gcloud auth login alone do not configure Application Default Credentials for Mizan.')
      if (result === 'refresh') throw new Error(
        'Google Cloud Application Default Credentials could not be refreshed. The credentials may have expired or been revoked. Run gcloud auth application-default login under the same Windows account that runs Mizan, then retry.')
      if (result === 'empty') return { subscriptions: [] }
      return { subscriptions: [{ projectId: 'test-project', projectName: 'Test project', projectNumber: '123456789012', state: 'ACTIVE' }] }
    },
  })
  let config = { provider: 'gcp', region: 'us-central1' }
  const setConfig = (next) => { config = typeof next === 'function' ? next(config) : next }
  const view = h.render(h.load('CloudSetup.tsx').GcpAccountFields, { config, setConfig })
  assert.equal(nodes(view.tree, (node) => node.type === 'select')[0].props.disabled, true)
  assert.match(text(view.tree), /Application Default Credentials \(ADC\)/)
  assert.match(text(view.tree), /separate from Check Google Cloud access/)
  assert.doesNotMatch(text(view.tree), /using your saved sign-in/)
  await view.settle()
  assert.match(text(view.tree), /Application Default Credentials are unavailable/)
  assert.match(text(view.tree), /then retry/)
  assert.equal(config.projectId, undefined)
  const refreshProjects = async () => {
    button(view.tree, 'Refresh projects').props.onClick()
    view.update()
    assert.equal(nodes(view.tree, (node) => node.type === 'select')[0].props.disabled, true,
      'Refresh immediately disables selection until the newest request settles')
    assert.match(text(view.tree), /Finding projects…/)
    assert.doesNotMatch(text(view.tree), /Test project \( ?test-project ?\)/,
      'Refresh clears stale discovered projects while loading')
    await view.settle()
  }
  result = 'projects'
  await refreshProjects()
  const picker = nodes(view.tree, (node) => node.type === 'select')[0]
  assert.equal(picker.props.required, true)
  picker.props.onChange({ target: { value: 'test-project' } })
  assert.equal(config.bucket, 'mizan-test-project')
  assert.equal(config.serviceAccount, 'mizan-worker@test-project.iam.gserviceaccount.com')
  assert.equal(config.machineType, 'g2-standard-8')
  assert.equal(config.location, config.region)
  config = { ...config, bucket: 'saved-custom-bucket' }
  view.update({ config, setConfig })
  nodes(view.tree, (node) => node.type === 'select')[0].props.onChange({ target: { value: 'test-project' } })
  assert.equal(config.bucket, 'saved-custom-bucket', 'The saved project keeps its custom resources')

  result = 'refresh'
  await refreshProjects()
  assert.match(text(view.tree), /could not be refreshed/)
  assert.doesNotMatch(text(view.tree), /Test project \( ?test-project ?\)/,
    'A failed refresh does not leave stale discovered projects visible')
  assert.match(text(view.tree), /Saved project: test-project \( ?not verified ?\)/)
  assert.equal(config.projectId, 'test-project', 'A failed refresh preserves the saved project')
  assert.equal(config.bucket, 'saved-custom-bucket')

  result = 'empty'
  await refreshProjects()
  assert.match(text(view.tree), /No active Google Cloud projects are visible/)
  assert.match(text(view.tree), /Saved project: test-project \( ?not verified ?\)/)
  assert.equal(config.projectId, 'test-project', 'An empty list preserves the saved project')

  result = 'projects'
  await refreshProjects()
  assert.match(text(view.tree), /Test project \( ?test-project ?\)/,
    'Refresh recovers after an empty accessible-project list')
  assert.equal(config.projectId, 'test-project')
  assert.equal(config.bucket, 'saved-custom-bucket')
  assert.equal(calls, 5)
  view.unmount()
})

test('AWS confirms the selected profile through its API before filling account and resource names', async () => {
  const calls = []
  let fail = true
  const h = harness({
    cloudSubscriptions: async (provider, profile, region) => {
      calls.push([provider, profile, region])
      if (fail) throw new Error('AWS credentials expired.')
      return { subscriptions: [{ accountId: '123456789012', profile, region, arn: 'arn:aws:iam::123456789012:user/test', userId: null }] }
    },
  })
  let config = { provider: 'aws', profile: 'work', region: 'us-west-2' }
  const setConfig = (next) => { config = typeof next === 'function' ? next(config) : next }
  const view = h.render(h.load('CloudSetup.tsx').AwsAccountFields, { config, setConfig })
  const field = (name) => nodes(view.tree, (node) => node.type === 'input' && node.props.name === name)[0]
  assert.deepEqual(calls, [], 'Account discovery is an explicit read-only action')
  assert.equal(field('accountId').props.readOnly, true)
  button(view.tree, 'Find AWS account').props.onClick()
  view.update()
  assert.equal(field('profile').props.disabled, true)
  await view.settle()
  assert.match(text(view.tree), /AWS credentials expired/)
  assert.equal(config.accountId, undefined)
  fail = false
  button(view.tree, 'Find AWS account').props.onClick()
  await view.settle()
  view.update({ config, setConfig })
  assert.equal(field('accountId').props.value, '123456789012')
  assert.equal(config.bucket, 'mizan-123456789012-us-west-2')
  assert.equal(config.computeEnvironment, 'mizan-gpu')
  assert.equal(config.jobQueue, 'mizan-queue')
  assert.match(text(view.tree), /AWS confirmed account 123456789012/)
  field('profile').props.onChange({ target: { value: 'different' } })
  view.update({ config, setConfig })
  assert.equal(field('accountId').props.value, '', 'A different profile must be checked again')
  assert.deepEqual(calls, [['aws', 'work', 'us-west-2'], ['aws', 'work', 'us-west-2']])
  view.unmount()
})

test('Google Cloud and AWS discover accounts and use typed setup and finish actions', async () => {
  const image = `ghcr.io/example/mizan-cloud-worker@sha256:${'a'.repeat(64)}`
  const cases = [
    { provider: 'gcp', name: 'Google Cloud', fields: {
      projectId: 'project-b', location: 'us-central1', region: 'us-central1',
      bucket: 'mizan-jobs', serviceAccount: 'worker@example.invalid',
      machineType: 'g2-standard-4', accelerator: 'nvidia-l4',
    } },
    { provider: 'aws', name: 'AWS', fields: {
      profile: 'dev', region: 'us-east-1', accountId: '123456789012', bucket: 'mizan-jobs',
      computeEnvironment: 'mizan-gpu', jobQueue: 'mizan-queue', jobDefinition: 'mizan-worker',
      role: 'mizan-job-role',
    } },
  ]

  for (const { provider, name, fields } of cases) {
    const calls = []
    const baseStatus = {
      provider, providerName: name, available: true, configured: false, mode: 'local',
      prepared: false, jobCreated: false, workerImage: null,
    }
    const h = harness({
      cloudSettings: async (id) => {
        calls.push(['settings', id])
        return { provider: id, settings: { provider: id } }
      },
      cloudSubscriptions: async (id, profile, region) => {
        calls.push(['accounts', id, profile, region])
        return { subscriptions: id === 'gcp'
          ? [{ projectId: fields.projectId, projectName: 'Test project', projectNumber: '123456789012', state: 'ACTIVE' }]
          : [{ accountId: fields.accountId, profile, region, arn: 'arn:aws:iam::123456789012:user/test', userId: null }] }
      },
      cloudStatus: async (requestId, id) => {
        calls.push(['status', requestId, id])
        return requestId
          ? baseStatus
          : { ...baseStatus, config: { ...fields, provider }, prepared: true, workerImage: null }
      },
      cloudReadinessProgress: async (id, selectedProvider) => {
        calls.push(['readiness-progress', id, selectedProvider])
        return { stage: 'ready', detail: null, elapsedSeconds: 0, timeoutSeconds: 120 }
      },
      cancelCloudStatus: async (id, selectedProvider) => {
        calls.push(['cancel-status', id, selectedProvider])
        return { cancelRequested: true }
      },
      configureCloud: async (config, id) => {
        calls.push(['configure', config, id])
        return { ...baseStatus, config, prepared: false }
      },
      prepareCloud: async (config, consent, id) => {
        calls.push(['prepare', config, consent, id])
        return { provider: id, prepared: true, configured: false, next: 'Resources are ready.' }
      },
      finishCloud: async (workerImage, useSavedToken, id) => {
        calls.push(['finish', workerImage, useSavedToken, id])
        return useSavedToken
          ? { ...baseStatus, config: { ...fields, provider, image }, configured: true,
            jobCreated: true, workerImage }
          : { ...baseStatus, requiresHfTokenConsent: true, next: 'Approve token transfer.' }
      },
      importCloudImage: async (sourceImage, id) => {
        calls.push(['import-image', sourceImage, id])
        return { provider: id, image, digest: `sha256:${'a'.repeat(64)}`,
          verified: true, sourceHash: 'verified-by-host' }
      },
    }, { loadCloudSetup: true })
    const props = {
      provider, status: baseStatus, onStatus() {}, onClose() {}, acquireOperation: () => () => {},
    }
    const entry = h.render(h.load('CloudSetup.tsx').CloudSetup, props)
    const providerEntry = h.render(entry.tree.type, entry.tree.props)
    const view = h.render(providerEntry.tree.type, providerEntry.tree.props)
    await view.settle()

    const groupedFields = provider === 'gcp'
        ? [['projectId', 'region'], ['bucket', 'serviceAccount'], ['machineType', 'accelerator']]
        : [['profile', 'region', 'accountId'], ['bucket'],
          ['computeEnvironment', 'jobQueue', 'jobDefinition', 'role', 'subnetIds', 'securityGroupIds']]
    const visitedFields = []
    for (const group of groupedFields) {
      const accountNode = nodes(view.tree, (node) => typeof node.type === 'function'
        && ['GcpAccountFields', 'AwsAccountFields'].includes(node.type.name))[0]
      if (accountNode) assert.equal(button(view.tree, 'Continue').props.disabled, true,
        `${name} requires account discovery before advancing`)
      const accountView = accountNode ? h.render(accountNode.type, accountNode.props) : null
      if (accountView) await accountView.settle()
      const fieldNodes = () => [
        ...nodes(view.tree, (node) => node.type === 'input' || node.type === 'select'),
        ...nodes(accountView?.tree, (node) => node.type === 'input' || node.type === 'select'),
      ]
      const stageFields = fieldNodes().map((node) => node.props.name)
      for (const field of group) assert.ok(stageFields.includes(field), `${name} shows ${field} in its setup stage`)
      assert.equal(stageFields.includes('image'), false)
      assert.equal(stageFields.includes('subscriptionId'), false)
      visitedFields.push(...stageFields)
      for (const field of group) {
        const input = fieldNodes().find((node) => node.props.name === field)
        if (provider === 'aws' && ['subnetIds', 'securityGroupIds'].includes(field))
          assert.equal(input.props.required, false, `${field} can be left blank for app-created networking`)
        if (field !== 'accountId') input.props.onChange({ target: { value: fields[field] ?? '' } })
      }
      view.update()
      if (accountView) {
        const nextAccount = nodes(view.tree, (node) => node.type === accountNode.type)[0]
        accountView.update(nextAccount.props)
        if (provider === 'aws') {
          button(accountView.tree, 'Find AWS account').props.onClick()
          await accountView.settle()
          view.update()
          assert.equal(nodes(view.tree, (node) => node.type === accountNode.type)[0].props.config.accountId, fields.accountId)
        }
        assert.equal(button(view.tree, 'Continue').props.disabled, false)
        if (provider === 'gcp') assert.equal(nodes(view.tree, (node) => node.type === accountNode.type)[0].props.config.location, fields.region)
      }
      nodes(view.tree, (node) => node.type === 'form' && node.props.id === 'cloud-provider-settings')[0]
        .props.onSubmit({ preventDefault() {} })
      await view.settle()
      accountView?.unmount()
    }
    for (const field of Object.keys(fields)) assert.ok(field === 'location' || visitedFields.includes(field), `${name} exposes ${field}`)
    assert.equal(visitedFields.includes('image'), false)
    assert.doesNotMatch(text(view.tree), /experimental|untested/i)

    button(view.tree, `Check ${name} access`).props.onClick()
    h.runIntervals(500)
    await view.settle()
    assert.ok(calls.some(([kind, requestId, id]) =>
      kind === 'status' && typeof requestId === 'string' && id === provider))
    assert.equal(calls.some(([kind]) => kind === 'finish'), false, 'readiness does not start a GPU job')

    await view.settle()
    assert.ok(calls.some(([kind, config, id]) => kind === 'configure'
      && id === provider && Object.keys(config).includes('provider')))
    assert.equal(calls.some(([kind, config]) => kind === 'configure' && config.image),
      false, 'resource settings do not persist an unverified image')
    if (provider === 'aws') {
      const savedSettings = calls.find(([kind]) => kind === 'configure')[1]
      assert.equal(savedSettings.subnetIds, undefined)
      assert.equal(savedSettings.securityGroupIds, undefined)
    }

    nodes(view.tree, (node) => node.type === 'input' && node.props.type === 'checkbox')[0]
      .props.onChange({ target: { checked: true } })
    view.update()
    button(view.tree, 'Approve and prepare resources').props.onClick()
    await view.settle(); await view.settle()
    assert.ok(calls.some(([kind, _config, consent, id]) =>
      kind === 'prepare' && consent === true && id === provider))

    button(view.tree, 'Back').props.onClick()
    await view.settle()
    assert.match(text(view.tree), /Resources for/)
    button(view.tree, 'Back').props.onClick()
    await view.settle()
    for (const field of groupedFields[2]) {
      const input = nodes(view.tree, (node) => node.type === 'input' && node.props.name === field)[0]
      assert.ok(input, `${name} Back returns to compute settings`)
      assert.equal(input.props.value, fields[field] ?? '', `${name} Back preserves ${field}`)
    }
    await nodes(view.tree, (node) => node.props?.id === 'cloud-provider-settings')[0].props.onSubmit({ preventDefault() {} })
    await view.settle()
    nodes(view.tree, (node) => node.type === 'input' && node.props.type === 'checkbox')[0]
      .props.onChange({ target: { checked: true } })
    view.update()
    button(view.tree, 'Approve and prepare resources').props.onClick()
    await view.settle(); await view.settle()

    const imageInput = nodes(view.tree, (node) => node.type === 'input'
      && node.props.name === 'worker-image')[0]
    assert.ok(imageInput)
    assert.equal(nodes(view.tree, (node) => node.type === 'input'
      && node.props.name === 'worker-image').length, 1)
    imageInput.props.onChange({ target: { value: image } })
    view.update()
    button(view.tree, 'Verify and save public GPU worker image').props.onClick()
    await view.settle(); await view.settle()
    assert.ok(calls.some(([kind, sourceImage, id]) =>
      kind === 'import-image' && sourceImage === image && id === provider))
    assert.ok(calls.some(([kind, config, id]) =>
      kind === 'configure' && id === provider && config.image === image))

    button(view.tree, 'Check existing GPU job').props.onClick()
    await view.settle(); await view.settle()
    assert.ok(calls.some(([kind, workerImage, approved, id]) =>
      kind === 'finish' && workerImage === image && approved === false && id === provider))
    nodes(view.tree, (node) => node.type === 'input' && node.props.type === 'checkbox')[0]
      .props.onChange({ target: { checked: true } })
    view.update()
    button(view.tree, `Approve token transfer and create ${name} GPU job`).props.onClick()
    await view.settle(); await view.settle()
    assert.ok(calls.some(([kind, workerImage, approved, id]) =>
      kind === 'finish' && workerImage === image && approved === true && id === provider))
    view.unmount(); providerEntry.unmount(); entry.unmount()
  }
})

test('worker image verification rejects provider, digest, and host-verification mismatches without saving', async () => {
  const image = `ghcr.io/example/mizan-cloud-worker@sha256:${'a'.repeat(64)}`
  const digest = `sha256:${'a'.repeat(64)}`
  const invalidResults = [
    { provider: 'gcp', digest, verified: true },
    { provider: 'aws', digest: `sha256:${'b'.repeat(64)}`, verified: true },
    { provider: 'aws', digest, verified: false },
  ]

  for (const invalid of invalidResults) {
    const calls = []
    const status = {
      provider: 'aws', providerName: 'AWS', configured: false, mode: 'local',
      prepared: true, jobCreated: false, workerImage: null,
    }
    const h = harness({
      cloudSettings: async (provider) => ({ provider, settings: { provider } }),
      importCloudImage: async (sourceImage, provider) => {
        calls.push(['import-image', sourceImage, provider])
        return { ...invalid, image, sourceHash: 'checked-by-host' }
      },
      configureCloud: async (config, provider) => {
        calls.push(['configure', config, provider])
        return { ...status, provider, config }
      },
    }, { loadCloudSetup: true })
    const entry = h.render(h.load('CloudSetup.tsx').CloudSetup, {
      provider: 'aws', status, onStatus() {}, onClose() {}, acquireOperation: () => () => {},
    })
    const providerEntry = h.render(entry.tree.type, entry.tree.props)
    const view = h.render(providerEntry.tree.type, providerEntry.tree.props)
    await view.settle()

    nodes(view.tree, (node) => node.type === 'input' && node.props.name === 'worker-image')[0]
      .props.onChange({ target: { value: image } })
    view.update()
    button(view.tree, 'Verify and save public GPU worker image').props.onClick()
    await view.settle(); await view.settle()

    assert.ok(calls.some(([kind, sourceImage, provider]) =>
      kind === 'import-image' && sourceImage === image && provider === 'aws'))
    assert.equal(calls.some(([kind]) => kind === 'configure'), false)
    assert.match(text(view.tree), /did not verify the entered worker image and matching digest/)
    view.unmount(); providerEntry.unmount(); entry.unmount()
  }
})

test('readiness progress shows local phases while the Azure check is pending', async () => {
  const status = deferred(), requests = []
  const h = harness({
    cloudStatus: () => status.promise,
    cloudReadinessProgress: async (id) => {
      requests.push(id)
      return { stage: 'Azure role assignments',
        detail: 'Checking selected-user and Job identity role assignments.',
        elapsedSeconds: 18, timeoutSeconds: 120 }
    },
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view)
  await view.settle(); await view.settle()
  h.runIntervals(500)
  await view.settle()
  assert.match(text(view.tree), /Checking selected-user and Job identity role assignments\. \(18s\)/)
  assert.equal(requests.length, 1)
  status.resolve(cloudReady)
  await view.settle()
  h.runIntervals(500)
  assert.equal(requests.length, 1, 'progress polling stops when readiness completes')
  view.unmount()
})

test('provider switching keeps readiness progress and cancellation on their original request', async () => {
  const azure = deferred(), gcp = deferred()
  const requests = [], cancelled = [], selected = [], progress = []
  const h = harness({
    cloudProviders: async () => ({
      providers: [{ id: 'azure', name: 'Azure' }, { id: 'gcp', name: 'Google Cloud' }],
      activeProvider: 'azure',
    }),
    cloudStatus: (id, provider) => {
      requests.push({ id, provider })
      return provider === 'azure' ? azure.promise : gcp.promise
    },
    selectCloudProvider: async (provider) => {
      selected.push(provider)
      return { provider, providerName: provider === 'gcp' ? 'Google Cloud' : 'Azure' }
    },
    cloudReadinessProgress: async (id, provider) => {
      progress.push({ id, provider })
      return { stage: 'private storage', detail: 'Reading storage access.', elapsedSeconds: 2, timeoutSeconds: 120 }
    },
    cancelCloudStatus: async (id, provider) => {
      cancelled.push({ id, provider })
      return { cancelRequested: true }
    },
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view)
  await view.settle(); await view.settle()
  assert.equal(requests[0].provider, 'azure')

  const providerSelect = nodes(view.tree, (node) => node.type === 'select' && node.props['aria-label'] === 'Cloud provider')[0]
  providerSelect.props.onChange({ target: { value: 'gcp' } })
  await view.settle(); await view.settle()
  assert.deepEqual(selected, ['gcp'])
  assert.deepEqual(cancelled[0], { id: requests[0].id, provider: 'azure' })
  assert.equal(requests[1].provider, 'gcp')

  h.runIntervals(500)
  await view.settle()
  assert.ok(progress.some((item) => item.id === requests[1].id && item.provider === 'gcp'))
  button(view.tree, 'Cancel check').props.onClick()
  await view.settle()
  assert.ok(cancelled.some((item) => item.id === requests[1].id && item.provider === 'gcp'))

  azure.resolve({ provider: 'azure', configured: true, mode: 'local' })
  gcp.resolve({ provider: 'gcp', configured: true, mode: 'local' })
  await view.settle()
  assert.match(text(view.tree), /Google Cloud readiness check cancelled/)
  assert.doesNotMatch(text(view.tree), /Cloud is on/)
  view.unmount()
})

test('readiness progress polling does not overlap unresolved bridge calls', async () => {
  const status = deferred(), progress = deferred(), requests = []
  const h = harness({
    cloudStatus: () => status.promise,
    cloudReadinessProgress: (id) => {
      requests.push(id)
      return requests.length === 1 ? progress.promise : Promise.resolve({
        stage: 'private Blob storage', detail: 'Checking private storage settings.',
        elapsedSeconds: 8, timeoutSeconds: 120,
      })
    },
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view)
  await view.settle(); await view.settle()
  h.runIntervals(500)
  h.runIntervals(500)
  assert.equal(requests.length, 1)
  progress.resolve({ stage: 'Azure role assignments',
    detail: 'Checking role assignments.', elapsedSeconds: 4, timeoutSeconds: 120 })
  await view.settle()
  assert.match(text(view.tree), /Checking role assignments\. \(4s\)/)
  h.runIntervals(500)
  await view.settle()
  assert.equal(requests.length, 2)
  assert.match(text(view.tree), /Checking private storage settings\. \(8s\)/)
  status.resolve(cloudReady)
  await view.settle()
  view.unmount()
})

test('successful readiness clears a failed progress poll', async () => {
  const status = deferred()
  const h = harness({
    cloudStatus: () => status.promise,
    cloudReadinessProgress: async () => { throw new h.HostError('Progress polling failed') },
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view)
  await view.settle(); await view.settle()
  h.runIntervals(500)
  await view.settle()
  assert.match(text(view.tree), /Progress polling failed/)
  status.resolve(cloudReady)
  await view.settle()
  assert.match(text(view.tree), /Cloud is on for new and redone analyses/)
  assert.doesNotMatch(text(view.tree), /Progress polling failed|Azure access check failed/)
  view.unmount()
})

test('MIDI activation offers Import or Cancel before saving', async () => {
  const imported = []
  const entry = {
    id: 'midi1', title: 'Piano score', artist: null, thumbnail: null, source: 'midi',
    parts: ['Piano'], recording: false, duration: null, createdAt: new Date().toISOString(),
    practicedAt: null, position: null, folders: [], outdated: false,
    transcriptionModel: null, separationMethod: null,
  }
  const h = harness({
    library: async () => imported.length ? [entry] : [],
    importFile: async (name, base64) => { imported.push({ name, base64 }); return entry },
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  const chooseFile = () => h.openMidiFile({ name: 'Piano score.mid', dataBase64: 'T1RoZA==' })

  chooseFile()
  view.update()
  assert.match(text(view.tree), /Import “\s*Piano score\.mid\s*”\?/)
  assert.equal(button(view.tree, 'Cancel').props.autoFocus, true)
  assert.equal(imported.length, 0)
  nodes(view.tree, (node) => node.type === 'dialog'
    && node.props.className === 'midi-import-dialog')[0].props.onCancel({ preventDefault() {} })
  view.update()
  assert.equal(nodes(view.tree, (node) => node.type === 'dialog'
    && node.props.className === 'midi-import-dialog').length, 0)

  chooseFile()
  view.update()
  button(view.tree, 'Cancel').props.onClick()
  view.update()
  assert.equal(imported.length, 0)

  chooseFile()
  view.update()
  button(view.tree, 'Import').props.onClick()
  await view.settle()
  assert.equal(imported.length, 1, text(view.tree))
  assert.deepEqual(imported, [{ name: 'Piano score.mid', base64: 'T1RoZA==' }])
  view.unmount()
})

test('search folding matches accents and canonical Unicode forms', () => {
  const { foldSearchText } = harness().load('searchText.ts')
  assert.equal(foldSearchText('Beyoncé').includes(foldSearchText('beyonce')), true)
  assert.equal(foldSearchText('café'), foldSearchText('cafe\u0301'))
  assert.equal(foldSearchText('café').includes(foldSearchText('cafe')), true)
})

test('library search finds accented titles and artists but keeps their original spelling', async () => {
  const entries = [
    {
      id: 'beyonce', title: 'Live', artist: 'Beyoncé', thumbnail: null, source: 'midi',
      parts: ['Piano'], recording: false, duration: null, createdAt: new Date().toISOString(),
      practicedAt: null, position: null, folders: [], outdated: false,
      transcriptionModel: null, separationMethod: null,
    },
    {
      id: 'cafe', title: 'Cafe\u0301 Sonata', artist: null, thumbnail: null, source: 'midi',
      parts: ['Piano'], recording: false, duration: null, createdAt: new Date().toISOString(),
      practicedAt: null, position: null, folders: [], outdated: false,
      transcriptionModel: null, separationMethod: null,
    },
  ]
  const h = harness({ library: async () => entries, folders: async () => [] })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  await view.settle()
  const search = () => nodes(view.tree, (node) => node.type === 'input' && node.props.name === 'url')[0]
  search().props.onChange({ target: { value: 'beyonce' } })
  view.update()
  assert.match(text(view.tree), /1 of 2 songs/)
  search().props.onChange({ target: { value: 'cafe' } })
  view.update()
  assert.match(text(view.tree), /1 of 2 songs/)
  assert.equal(entries[0].artist, 'Beyoncé')
  assert.equal(entries[1].title, 'Cafe\u0301 Sonata')
  view.unmount()
})

test('unknown Cloud model catalog keeps choices available; known omission is unsupported', async () => {
  const h = harness({
    cloudStatus: async () => ({ mode: 'cloud', configured: false, available: true, jobCreated: true }),
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view, 'Models and account')
  await view.settle(); await view.settle()
  const choices = nodes(view.tree, (node) => node.type === 'input'
    && node.props.name === 'transcription-model')
  assert.equal(choices.length, 3)
  assert.deepEqual(choices.map((choice) => choice.props.disabled), [false, false, false], text(view.tree))
  assert.match(text(view.tree), /Cloud worker model support has not been checked/)
  assert.doesNotMatch(text(view.tree), /Not supported by this Cloud worker/)
  view.unmount()

  const known = harness({
    cloudStatus: async () => ({ mode: 'cloud', configured: false, available: true,
      jobCreated: true, supportedModels: ['muscriptor-small'] }),
  })
  const knownView = known.render(known.load('Library.tsx').Library, libraryProps)
  openSettings(knownView, 'Models and account')
  await knownView.settle(); await knownView.settle()
  const knownChoices = nodes(knownView.tree, (node) => node.type === 'input'
    && node.props.name === 'transcription-model')
  assert.equal(knownChoices[0].props.disabled, false)
  assert.equal(knownChoices[1].props.disabled, true)
  assert.equal(knownChoices[2].props.disabled, true)
  assert.equal(nodes(knownView.tree, (node) => node.type === 'small'
    && text(node) === 'Not supported by this Cloud worker').length, 2)
  knownView.unmount()
})

test('Check Azure access retries status for unknown Job state instead of opening setup', async () => {
  let checks = 0
  const calls = []
  const h = harness({
    cloudStatus: async () => {
      checks++
      return checks === 1
        ? { mode: 'local', configured: false, available: true }
        : { ...savedCloudSetup, mode: 'local', issue: 'Azure access is still unknown' }
    },
    configureCloud: async (...args) => { calls.push(['configure', ...args]) },
    prepareCloud: async (...args) => { calls.push(['prepare', ...args]) },
    finishCloud: async (...args) => { calls.push(['finish', ...args]) },
    setProcessingModeWithStatus: async (mode) => ({ mode }),
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view)
  await view.settle(); await view.settle()
  nodes(view.tree, (node) => node.type === 'input' && node.props.name === 'processing-mode')[1]
    .props.onChange()
  await view.settle()
  assert.ok(button(view.tree, 'Check Azure access'))
  button(view.tree, 'Check Azure access').props.onClick()
  await view.settle(); await view.settle()
  assert.equal(checks, 2)
  assert.equal(calls.length, 0)
  assert.equal(nodes(view.tree, (node) => node.type === 'cloud-setup').length, 0)
  view.unmount()
})

test('This PC hides cloud configuration while Cloud keeps setup reachable', async () => {
  const modes = []
  const h = harness({
    cloudStatus: async () => ({ mode: 'local', available: true, configured: false,
      prepared: false, jobCreated: false, workerImage: null }),
    setProcessingModeWithStatus: async (mode) => {
      modes.push(mode)
      return { mode, configured: false }
    },
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view)
  await view.settle(); await view.settle()
  const provider = () => nodes(view.tree, (node) => node.type === 'select' && node.props['aria-label'] === 'Cloud provider')
  const mode = (index) => nodes(view.tree, (node) => node.type === 'input' && node.props.name === 'processing-mode')[index]
  assert.equal(mode(0).props.checked, true)
  assert.equal(provider().length, 0)
  assert.equal(nodes(view.tree, (node) => node.props?.className === 'cloud-status').length, 0)
  mode(1).props.onChange()
  await view.settle()
  assert.equal(mode(1).props.checked, true)
  assert.equal(provider().length, 1)
  assert.match(text(view.tree), /New analysis still uses This PC/)
  assert.deepEqual(modes, [], 'Opening cloud options cannot enable an unconfigured worker')
  await mode(0).props.onChange()
  await view.settle()
  assert.equal(provider().length, 0)
  assert.equal(mode(0).props.checked, true)
  view.unmount()
})

test('confirmed empty setup opens onboarding; absent Job metadata does not', async () => {
  const selected = []
  const h = harness({
    cloudStatus: async () => ({ mode: 'local', configured: false, available: true,
      prepared: false, jobCreated: false, workerImage: null }),
    setProcessingModeWithStatus: async (mode) => { selected.push(mode); return { mode } },
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view)
  await view.settle(); await view.settle()
  nodes(view.tree, (node) => node.type === 'input' && node.props.name === 'processing-mode')[1]
    .props.onChange()
  view.update()
  assert.equal(nodes(view.tree, (node) => node.type === 'cloud-setup').length, 0,
    'Choosing Cloud first shows provider options without opening setup')
  assert.match(text(view.tree), /New analysis still uses This PC/)
  button(view.tree, 'Set up Azure').props.onClick()
  view.update()
  assert.equal(nodes(view.tree, (node) => node.type === 'cloud-setup').length, 1)
  assert.deepEqual(selected, [])
  view.unmount()

  let checks = 0
  const partial = harness({
    cloudStatus: async () => {
      checks++
      return { mode: 'local', configured: false, prepared: false, jobCreated: false }
    },
    setProcessingModeWithStatus: async (mode) => ({ mode }),
  })

  const partialView = partial.render(partial.load('Library.tsx').Library, libraryProps)
  openSettings(partialView)
  await partialView.settle(); await partialView.settle()
  nodes(partialView.tree, (node) => node.type === 'input' && node.props.name === 'processing-mode')[1]
    .props.onChange()
  await partialView.settle(); await partialView.settle()
  assert.equal(nodes(partialView.tree, (node) => node.type === 'cloud-setup').length, 0)
  assert.ok(button(partialView.tree, 'Check Azure access'))
  button(partialView.tree, 'Check Azure access').props.onClick()
  await partialView.settle(); await partialView.settle()
  assert.equal(checks, 2)
  assert.equal(nodes(partialView.tree, (node) => node.type === 'cloud-setup').length, 0)
  partialView.unmount()
})

test('prepared environment without a worker resumes the saved worker-only path', async () => {
  const saved = {
    ...savedCloudSetup, mode: 'local', configured: false, jobCreated: false,
    workerImage: null,
  }
  const actions = []
  const h = harness({
    buildCloudWorker: async () => {
      actions.push('build-worker')
      return { image: 'registry.azurecr.io/mizan-aca-gpu@sha256:test' }
    },
    cloudStatus: async () => ({ ...saved, workerImage: 'registry.azurecr.io/mizan-aca-gpu@sha256:test' }),
    cloudSetupProgress: async () => ({ operation: null, stage: 'idle', completed: 0, total: 0, detail: null }),
    configureCloud: async (...args) => { actions.push(['configure', ...args]) },
    prepareCloud: async (...args) => { actions.push(['prepare', ...args]) },
    finishCloud: async (...args) => { actions.push(['finish', ...args]) },
    azureSubscriptions: async () => [{ id: 'subscription', name: 'Existing', tenantId: 'tenant' }],
  }, { loadCloudSetup: true })
  const component = h.load('CloudSetup.tsx').CloudSetup
  const props = { status: saved, onStatus() {}, onClose() {},
    acquireOperation: () => () => {} }
  const entry = h.render(component, props)
  assert.equal(typeof entry.tree.type, 'function', 'legacy status selects the Azure setup entry')
  const view = h.render(entry.tree.type, entry.tree.props)
  assert.match(text(view.tree), /Build the GPU worker, then create the Job/)
  assert.ok(button(view.tree, 'Build GPU worker in my registry'))
  button(view.tree, 'Build GPU worker in my registry').props.onClick()
  await view.settle(); await view.settle()
  assert.deepEqual(actions, ['build-worker'])
  assert.match(text(view.tree), /GPU worker built and ready for the Job/)
  assert.equal(nodes(view.tree, (node) => node.type === 'button'
    && text(node) === 'Approve and provision infrastructure').length, 0)
  view.unmount()
  entry.unmount()
})

test('Cloud intent is saved during blocked readiness without claiming Azure is ready', async () => {
  const status = deferred(), chosen = [], cancelled = []
  const h = harness({
    cloudStatus: () => status.promise,
    getTranscriptionModel: async () => 'muscriptor-large',
    setProcessingModeWithStatus: async (mode) => { chosen.push(mode); return { ...savedCloudSetup, mode } },
    cancelCloudStatus: async (id) => { cancelled.push(id); return { cancelRequested: true } },
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view)
  await view.settle(); await view.settle()
  const fieldset = nodes(view.tree, (node) => node.type === 'fieldset' && node.props.className === 'cloud-mode')[0]
  assert.equal(fieldset.props.disabled, false)
  nodes(view.tree, (node) => node.type === 'input' && node.props.name === 'processing-mode')[1]
    .props.onChange()
  await view.settle()
  assert.deepEqual(chosen, ['cloud'])
  assert.equal(cancelled.length, 1)
  assert.match(text(view.tree), /Cloud selected.*no Local fallback/)
  assert.ok(button(view.tree, 'Check Azure access'))
  assert.ok(button(view.tree, 'Disconnect Azure from Mizan'))
  assert.equal(nodes(view.tree, (node) => node.type === 'cloud-setup').length, 0)
  assert.doesNotMatch(text(view.tree), /Cloud is on|Azure is ready/)
  status.resolve({ mode: 'local', configured: false, issue: 'Azure readiness check timed out' })
  await view.settle()
  const modes = nodes(view.tree, (node) => node.type === 'input' && node.props.name === 'processing-mode')
  assert.equal(modes[1].props.checked, true)
  assert.match(text(view.tree), /Cloud selected.*no Local fallback/)
  view.unmount()
})

test('selecting Cloud during a refresh does not reuse an older ready result', async () => {
  const refresh = deferred(), chosen = []
  let checks = 0
  const h = harness({
    cloudStatus: () => ++checks === 1
      ? Promise.resolve({ mode: 'local', configured: true, jobCreated: true })
      : refresh.promise,
    getTranscriptionModel: async () => 'muscriptor-large',
    setProcessingModeWithStatus: async (mode) => { chosen.push(mode); return { ...savedCloudSetup, mode } },
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view)
  await view.settle(); await view.settle()
  assert.equal(nodes(view.tree, (node) => node.type === 'input' && node.props.name === 'processing-mode')[0].props.checked, true)
  assert.doesNotMatch(text(view.tree), /Azure is ready/, 'This PC hides cloud readiness details')
  button(view.tree, 'Close song analysis settings').props.onClick(); view.update()
  openSettings(view)
  await view.settle(); await view.settle()
  assert.match(text(view.tree), /Checking Azure setup/)
  nodes(view.tree, (node) => node.type === 'input' && node.props.name === 'processing-mode')[1]
    .props.onChange()
  await view.settle()
  assert.deepEqual(chosen, ['cloud'])
  assert.match(text(view.tree), /Cloud selected.*no Local fallback/)
  assert.doesNotMatch(text(view.tree), /Cloud is on|Azure is ready/)
  refresh.resolve({ mode: 'local', configured: true, jobCreated: true })
  await view.settle()
  assert.match(text(view.tree), /Cloud selected.*no Local fallback/)
  view.unmount()
})

test('failed readiness does not send a locally saved Cloud Job back through setup', async () => {
  const h = harness({
    cloudStatus: async () => ({ mode: 'local', configured: false, available: true,
      jobCreated: true, issue: 'Azure connection preflight failed: Synthetic Azure access failure' }),
    setProcessingModeWithStatus: async (mode) => ({ ...savedCloudSetup, mode,
      issue: 'Synthetic Azure access failure' }),
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view)
  await view.settle(); await view.settle()
  nodes(view.tree, (node) => node.type === 'input' && node.props.name === 'processing-mode')[1]
    .props.onChange()
  await view.settle()
  assert.equal(nodes(view.tree, (node) => node.type === 'cloud-setup').length, 0)
  assert.match(text(view.tree), /Cloud selected.*no Local fallback/)
  assert.match(text(view.tree), /Azure access check failed/)
  assert.match(text(view.tree), /Synthetic Azure access failure/)
  assert.doesNotMatch(text(view.tree), /Cloud is on|Azure is ready/)
  view.unmount()
})

test('saved Job without a completed check is shown as unverified', async () => {
  const h = harness({
    cloudStatus: async () => ({ ...savedCloudSetup, issue: 'Azure readiness has not been checked.' }),
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view)
  await view.settle(); await view.settle()
  assert.match(text(view.tree), /Azure readiness is not verified/)
  assert.doesNotMatch(text(view.tree), /Azure is not ready/)
  view.unmount()
})

test('invalid local Cloud selection shows an error without changing the selected mode', async () => {
  const h = harness({
    cloudStatus: async () => ({ mode: 'local', configured: false, jobCreated: true }),
    setProcessingModeWithStatus: async () => { throw new h.HostError('Selected model is not supported') },
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view)
  await view.settle(); await view.settle()
  nodes(view.tree, (node) => node.type === 'input' && node.props.name === 'processing-mode')[1]
    .props.onChange()
  await view.settle()
  assert.match(text(view.tree), /Selected model is not supported/)
  assert.equal(nodes(view.tree, (node) => node.type === 'input' && node.props.name === 'processing-mode')[0].props.checked, true)
  view.unmount()
})

test('close cancels only its request; late responses cannot overwrite a reopened panel', async () => {
  const first = deferred(), second = deferred(), ids = [], cancelled = []
  const h = harness({
    cloudStatus: (id) => { ids.push(id); return ids.length === 1 ? first.promise : second.promise },
    cancelCloudStatus: async (id) => { cancelled.push(id); return { cancelRequested: true } },
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view)
  await view.settle(); await view.settle()
  button(view.tree, 'Close song analysis settings').props.onClick(); view.update()
  openSettings(view)
  await view.settle(); await view.settle()
  assert.equal(cancelled[0], ids[0])
  assert.notEqual(ids[0], ids[1])
  first.resolve({ mode: 'local', configured: true })
  await view.settle()
  assert.match(text(view.tree), /Checking Azure setup/)
  second.resolve({ ...cloudReady, configured: false, issue: 'Synthetic access denied' })
  await view.settle()
  assert.match(text(view.tree), /Cloud selected.*no Local fallback/)
  assert.match(text(view.tree), /Synthetic access denied/)
  const modes = nodes(view.tree, (node) => node.type === 'input' && node.props.name === 'processing-mode')
  assert.equal(modes[0].props.checked, false)
  assert.equal(modes[1].props.checked, true)
  view.unmount()
})

test('Cancel check gives an explicit state and ignores later readiness success', async () => {
  const status = deferred(), cancelled = []
  const h = harness({
    cloudStatus: () => status.promise,
    cancelCloudStatus: async (id) => { cancelled.push(id); return { cancelRequested: true } },
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view)
  await view.settle(); await view.settle()
  button(view.tree, 'Cancel check').props.onClick(); view.update()
  assert.equal(cancelled.length, 1)
  assert.match(text(view.tree), /readiness check cancelled/)
  status.resolve(cloudReady)
  await view.settle()
  assert.doesNotMatch(text(view.tree), /Cloud is on/)
  view.unmount()
})

test('an old cancellation error cannot replace a newer ready panel', async () => {
  const first = deferred(), second = deferred(), cancellation = deferred()
  let checks = 0
  const h = harness({
    cloudStatus: () => ++checks === 1 ? first.promise : second.promise,
    cancelCloudStatus: () => cancellation.promise,
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  openSettings(view)
  await view.settle(); await view.settle()
  button(view.tree, 'Close song analysis settings').props.onClick(); view.update()
  openSettings(view)
  await view.settle(); await view.settle()
  second.resolve(cloudReady)
  await view.settle()
  cancellation.reject(new h.HostError('Obsolete cancellation error'))
  first.resolve({ mode: 'local', configured: true })
  await view.settle()
  assert.match(text(view.tree), /Cloud is on for new and redone analyses/)
  assert.doesNotMatch(text(view.tree), /Obsolete cancellation error/)
  view.unmount()
})

test('YouTube submission is immediately pending, deduplicated, and retryable after failure', async () => {
  const pending = deferred(), submissions = []
  const h = harness({ addLink: (url) => { submissions.push(url); return pending.promise } })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  const url = 'https://youtu.be/aB_12-cD345'
  nodes(view.tree, (node) => node.type === 'input' && node.props.name === 'url')[0]
    .props.onChange({ target: { value: url } })
  view.update()
  const submit = nodes(view.tree, (node) => node.type === 'form')[0].props.onSubmit
  submit({ preventDefault() {} }); submit({ preventDefault() {} })
  view.update()
  assert.equal(submissions.length, 1)
  assert.equal(button(view.tree, 'Queuing…').props.disabled, true)
  assert.match(text(view.tree), /Adding recording to the queue/)
  pending.reject(new h.HostError('Synthetic submission failure'))
  await view.settle()
  assert.match(text(view.tree), /Synthetic submission failure/)
  assert.equal(button(view.tree, 'Transcribe').props.disabled, false)
  h.host.addLink = async (next) => { submissions.push(next) }
  button(view.tree, 'Transcribe')
  nodes(view.tree, (node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} })
  await view.settle()
  assert.equal(submissions.length, 2)
  view.unmount()
})

test('search result buttons reflect pending work and distinguish selected Cloud/model', async () => {
  const video = { id: 'aB_12-cD345', url: 'https://youtu.be/aB_12-cD345', title: 'Synthetic', channel: '', duration: 5 }
  const h = harness({ searchYouTube: async () => [video] })
  const props = { query: 'study', jobs: [job({ url: video.url, processingMode: 'local' })],
    busy: false, pendingLinks: [], processingMode: 'cloud', transcriptionModel: 'muscriptor-large', onAdd: async () => {} }
  const view = h.render(h.load('Library.tsx').YouTubeSearch, props)
  h.runTimers(); await view.settle()
  assert.equal(button(view.tree, 'Transcribe Synthetic').props.disabled, false)
  view.update({ ...props, pendingLinks: [video.url] })
  assert.equal(button(view.tree, 'Queuing Synthetic').props.disabled, true)
  view.update({ ...props, jobs: [job({ url: video.url })] })
  assert.equal(button(view.tree, 'Queued Synthetic').props.disabled, true)
  view.update({ ...props, jobs: [job({ url: video.url, transcriptionModel: 'muscriptor-small' })] })
  assert.equal(button(view.tree, 'Transcribe Synthetic').props.disabled, false)
  view.unmount()
})

test('YouTube Music failures are visible while YouTube results remain available', async () => {
  const video = {
    id: 'aB_12-cD345', url: 'https://www.youtube.com/watch?v=aB_12-cD345',
    title: 'Für Elise', channel: 'Artist', duration: 92,
    thumbnail: 'https://i.ytimg.com/vi/aB_12-cD345/mqdefault.jpg', source: 'youtube',
  }
  const h = harness({
    searchYouTube: async () => [video],
    searchYouTubeMusic: async () => { throw new h.HostError('Temporary Music error') },
  })
  const props = { query: 'fur elise', jobs: [], busy: false, pendingLinks: [],
    onAdd: async () => {} }
  const view = h.render(h.load('Library.tsx').YouTubeSearch, props)
  h.runTimers()
  await view.settle()
  assert.match(text(view.tree), /YouTube Music\s*:\s*Unavailable — Temporary Music error/)
  assert.equal(nodes(view.tree, (node) => node.type === 'li' && node.props.className === 'youtube-result').length, 1)
  assert.equal(button(view.tree, 'Transcribe Für Elise').props.disabled, false)
  view.unmount()
})

test('YouTube and YouTube Music duplicates merge by video id and show both sources', async () => {
  const video = {
    id: 'aB_12-cD345', url: 'https://www.youtube.com/watch?v=aB_12-cD345',
    title: 'Für Elise', channel: 'Artist', duration: 92,
    thumbnail: 'https://i.ytimg.com/vi/aB_12-cD345/mqdefault.jpg',
  }
  const h = harness({
    searchYouTube: async () => [{ ...video, source: 'youtube' }],
    searchYouTubeMusic: async () => [{ ...video, source: 'youtube_music' }],
  })
  const view = h.render(h.load('Library.tsx').YouTubeSearch,
    { query: 'fur elise', jobs: [], busy: false, pendingLinks: [], onAdd: async () => {} })
  h.runTimers()
  await view.settle()
  assert.equal(nodes(view.tree, (node) => node.type === 'li' && node.props.className === 'youtube-result').length, 1)
  assert.deepEqual(nodes(view.tree, (node) => node.props.className === 'video-source').map((node) => text(node)),
    ['YouTube', 'YouTube Music'])
  view.unmount()
})

test('unified MIDI ranking folds accents and deduplicates only shared file identities', () => {
  const { unifyMidiResults } = harness().load('Library.tsx')
  const result = (provider, id, dedupeKey, title, artist = null) => ({
    provider, id, dedupeKey, title, artist,
    source: provider === 'commons' ? 'Wikimedia Commons' : 'Mutopia Project',
    license: 'Public Domain', licenseUrl: null, attribution: artist,
    sourceUrl: provider === 'commons' ? 'https://commons.wikimedia.org/wiki/File:score.mid'
      : 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1',
  })
  const groups = unifyMidiResults([
    result('commons', 'commons:one', 'file-a', 'Beyoncé Nocturne', 'Ludwig van Beethoven'),
    result('mutopia', 'mutopia:one', 'file-a', 'Beyoncé Nocturne', 'Ludwig van Beethoven'),
    result('mutopia', 'mutopia:arrangement', 'file-b', 'Beyoncé Nocturne', 'Ludwig van Beethoven'),
    result('commons', 'commons:other', 'file-c', 'Chopin Study', 'Beyoncé'),
  ], 'beyonce')

  assert.equal(groups.length, 3)
  assert.equal(groups[0].primary.title, 'Beyoncé Nocturne')
  assert.equal(groups.find((group) => group.sources.length === 2).sources.map((source) => source.provider).join(','),
    'commons,mutopia')
  assert.equal(groups.find((group) => group.sources.some((source) => source.id === 'mutopia:arrangement')).sources.length, 1)
})

test('MIDI search includes both additional providers and isolates a failure for retry', async () => {
  const calls = []
  let freeMidiAttempts = 0
  const result = (provider, source, id) => ({
    id, provider, dedupeKey: `${provider}:${id}`, source, title: 'Moonlight Sonata',
    artist: null, license: provider === 'bitmidi' || provider === 'freemidi' ? 'Not listed by source' : 'Public Domain',
    licenseUrl: null, attribution: null, sourceUrl: `https://${provider}.example/${id}`,
  })
  const h = harness({
    searchMidiCommons: async () => (calls.push('commons'), [result('commons', 'Wikimedia Commons', 'c')]),
    searchMidiMutopia: async () => (calls.push('mutopia'), {
      results: [result('mutopia', 'Mutopia Project', 'm')], nextStart: null,
    }),
    searchMidiArchive: async () => (calls.push('archive'), [result('archive', 'Internet Archive', 'a')]),
    searchMidiBitMidi: async () => (calls.push('bitmidi'), [result('bitmidi', 'BitMidi', 'b')]),
    searchMidiFreeMidi: async () => {
      calls.push('freemidi')
      if (freeMidiAttempts++ === 0) throw new Error('FreeMIDI is unavailable')
      return [result('freemidi', 'FreeMIDI', 'f')]
    },
  })
  const view = h.render(h.load('Library.tsx').MidiSearch, { query: 'moonlight', onImport() {} })
  h.runTimers()
  await view.settle()

  assert.deepEqual(calls.sort(), ['archive', 'bitmidi', 'commons', 'freemidi', 'mutopia'])
  assert.ok(text(view.tree).includes('BitMidi'))
  assert.ok(text(view.tree).includes('FreeMIDI'))
  assert.equal(nodes(view.tree, (node) => node.type === 'li' && node.props.className === 'midi-result').length, 4)
  const retry = button(view.tree, 'Retry FreeMIDI')
  assert.ok(retry)
  retry.props.onClick()
  view.update()
  h.runTimers()
  await view.settle()
  assert.equal(calls.filter((provider) => provider === 'freemidi').length, 2)
  assert.equal(nodes(view.tree, (node) => node.type === 'li' && node.props.className === 'midi-result').length, 5)
  view.unmount()
})

test('live MIDI preview is opt-in and read-only; dev search validates requests and reports Python failures', async () => {
  const bridgeFile = fileURLToPath(new URL('../src/library/bridge.ts', import.meta.url))
  const fixture = [{
    id: 'freemidi:1', provider: 'freemidi', dedupeKey: 'freemidi:1', source: 'FreeMIDI',
    title: 'Smells Like Teen Spirit', artist: 'Nirvana', license: 'Not listed by source',
    licenseUrl: null, attribution: 'Artist listed: Nirvana',
    sourceUrl: 'https://freemidi.org/download3-26749-smells-like-teen-spirit-nirvana',
  }]
  const loadBridge = ({ dev, search = '', nativeApi = null, fetchImpl }) => {
    const calls = []
    const mockHost = {
      search_midi_freemidi: async (query) => {
        calls.push(['mock', query])
        return { ok: true, results: fixture }
      },
    }
    const source = readFileSync(bridgeFile, 'utf8')
      .replaceAll('import.meta.env', `({ DEV: ${dev} })`)
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
    }).outputText
    const module = { exports: {} }
    const browser = {
      location: { search },
      __mizanNativeShell: !!nativeApi,
      pywebview: nativeApi ? { api: nativeApi } : undefined,
      addEventListener() {},
    }
    vm.runInNewContext(output, {
      module, exports: module.exports, window: browser, URLSearchParams,
      setTimeout(callback) { callback(); return 1 },
      clearTimeout() {},
      fetch: fetchImpl,
      require(specifier) {
        if (specifier === './mock') return { mockHost }
        return require(specifier)
      },
    }, { filename: bridgeFile })
    return { bridge: module.exports, calls }
  }

  const noFetch = () => { throw new Error('Unexpected live MIDI request') }
  const mock = loadBridge({ dev: true, fetchImpl: noFetch })
  assert.equal(mock.bridge.liveMidiPreview, false)
  assert.deepEqual(await mock.bridge.host.searchMidiFreeMidi('smells like teen'), fixture)
  assert.deepEqual(mock.calls, [['mock', 'smells like teen']])

  const liveCalls = []
  const live = loadBridge({
    dev: true,
    search: '?midi=live',
    fetchImpl: async (url, init) => {
      liveCalls.push([url, JSON.parse(init.body)])
      return { json: async () => ({ ok: true, results: fixture, nextStart: null }) }
    },
  })
  assert.equal(live.bridge.liveMidiPreview, true)
  assert.deepEqual(await live.bridge.host.searchMidiFreeMidi('smells like teen'), fixture)
  assert.equal(liveCalls[0][0], '/__dev/midi-search')
  assert.equal(liveCalls[0][1].provider, 'freemidi')

  const nativeCalls = []
  const production = loadBridge({
    dev: false,
    search: '?midi=live',
    fetchImpl: noFetch,
    nativeApi: {
      search_midi_freemidi: async (query) => {
        nativeCalls.push(query)
        return { ok: true, results: fixture }
      },
    },
  })
  assert.equal(production.bridge.liveMidiPreview, false)
  assert.deepEqual(await production.bridge.host.searchMidiFreeMidi('smells like teen'), fixture)
  assert.deepEqual(nativeCalls, ['smells like teen'])

  const searchHost = {
    searchMidiCommons: async () => [],
    searchMidiMutopia: async () => ({ results: [], nextStart: null }),
    searchMidiArchive: async () => [],
    searchMidiBitMidi: async () => [],
    searchMidiFreeMidi: async () => fixture,
  }
  const liveUi = harness(searchHost, { liveMidiPreview: true })
  const liveView = liveUi.render(liveUi.load('Library.tsx').MidiSearch, {
    query: 'smells like teen', onImport() { assert.fail('Live results must not be importable') },
  })
  liveUi.runTimers()
  await liveView.settle()
  assert.ok(text(liveView.tree).includes('Search only; import files in the installed app.'))
  assert.equal(button(liveView.tree, 'Search only')?.props.disabled, true)
  liveView.unmount()

  const normalUi = harness(searchHost)
  const normalView = normalUi.render(normalUi.load('Library.tsx').MidiSearch, {
    query: 'smells like teen', onImport() {},
  })
  normalUi.runTimers()
  await normalView.settle()
  assert.equal(button(normalView.tree, 'Import')?.props.disabled, false)
  normalView.unmount()

  const uiRoot = fileURLToPath(new URL('..', import.meta.url))
  const missingPython = resolve(uiRoot, 'tests', `missing-python-${process.pid}.exe`)
  assert.equal(existsSync(missingPython), false)
  const previousPython = process.env.MIZAN_DEV_MIDI_PYTHON
  let server
  try {
    process.env.MIZAN_DEV_MIDI_PYTHON = missingPython
    server = await createServer({
      configFile: resolve(uiRoot, 'vite.config.ts'),
      root: uiRoot,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const address = server.httpServer.address()
    assert.ok(address && typeof address !== 'string')
    const logs = []
    server.config.logger.error = (message, options) => logs.push({ message, options })
    const endpoint = `http://127.0.0.1:${address.port}/__dev/midi-search`
    const post = (body) => fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })
    const invalidProvider = await post(JSON.stringify({ provider: 'other', query: 'x', startAt: 0 }))
    assert.equal(invalidProvider.status, 400)
    const oversized = await post('x'.repeat(4097))
    assert.equal(oversized.status, 413)
    const invalidStart = await post(JSON.stringify({ provider: 'mutopia', query: 'x', startAt: 3 }))
    assert.equal(invalidStart.status, 400)
    const failedSearch = await post(JSON.stringify({ provider: 'freemidi', query: 'x', startAt: 0 }))
    const failure = await failedSearch.json()
    assert.equal(failedSearch.status, 200)
    assert.equal(failure.ok, false)
    assert.equal(failure.error.code, 'midi_search_failed')
    assert.equal('results' in failure, false)
    assert.equal(logs.length, 1)
    assert.equal(logs[0].message, 'Live MIDI search failed.')
    assert.ok(logs[0].options.error instanceof Error)
  } finally {
    if (server) await server.close()
    if (previousPython === undefined) delete process.env.MIZAN_DEV_MIDI_PYTHON
    else process.env.MIZAN_DEV_MIDI_PYTHON = previousPython
  }
})

test('unknown-license MIDI import requires permission for each offered file', async () => {
  const calls = []
  const h = harness({
    importMidiResult: async (id, permission) => {
      calls.push([id, permission])
      return { id, source: 'midi' }
    },
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  await view.settle()
  nodes(view.tree, (node) => node.type === 'input' && node.props.placeholder?.startsWith('Search your library'))[0]
    .props.onChange({ target: { value: 'moonlight' } })
  view.update()
  const offer = (provider) => {
    const search = nodes(view.tree, (node) => node.type?.name === 'MidiSearch')[0]
    assert.ok(search)
    search.props.onImport({
      id: `${provider}:test`, provider, source: provider, dedupeKey: provider,
      title: 'Moonlight', artist: null,
      license: provider === 'commons' ? 'Public Domain' : 'Not listed by source',
      licenseUrl: null, attribution: null, sourceUrl: `https://${provider}.example/score`,
    })
    view.update()
  }
  const permission = () => nodes(view.tree, (node) => node.type === 'input' && node.props.type === 'checkbox')[0]

  offer('bitmidi')
  assert.equal(permission().props.checked, false)
  assert.equal(button(view.tree, 'Import').props.disabled, true)
  button(view.tree, 'Import').props.onClick()
  await view.settle()
  assert.deepEqual(calls, [], 'The handler also rejects an unchecked permission box')
  permission().props.onChange({ target: { checked: true } })
  view.update()
  assert.equal(button(view.tree, 'Import').props.disabled, false)
  offer('freemidi')
  button(view.tree, 'Cancel').props.onClick()
  view.update()
  assert.equal(permission().props.checked, false, 'Permission does not carry to the next file')
  assert.equal(button(view.tree, 'Import').props.disabled, true)
  permission().props.onChange({ target: { checked: true } })
  view.update()
  button(view.tree, 'Import').props.onClick()
  await view.settle()
  assert.deepEqual(calls, [['freemidi:test', true]])

  offer('freemidi')
  assert.equal(permission().props.checked, false, 'Reopening a result needs new permission')
  button(view.tree, 'Cancel').props.onClick()
  view.update()
  offer('commons')
  assert.equal(permission(), undefined, 'Confirmed-license imports keep their existing flow')
  assert.equal(button(view.tree, 'Import').props.disabled, false)
  button(view.tree, 'Import').props.onClick()
  await view.settle()
  assert.deepEqual(calls, [['freemidi:test', true], ['commons:test', false]])
  view.unmount()
})

test('YouTube Music editorial shelves keep playlist order and require an explicit Transcribe click', async () => {
  const feed = {
    title: 'YouTube Music', fetchedAt: '2026-10-13T00:00:00Z',
    sections: [
      {
        id: 'hit-list', title: "Today's Biggest Hits — The Hit List", publisher: 'YouTube Music',
        sourceUrl: 'https://music.youtube.com/playlist?list=RDCLAK5uy_kmPRjHDECIcuVwnKsx2Ng7fyNgFKWNJFs',
        kind: 'editorial', status: 'available', description: "The home of today's biggest and hottest hits.",
        chartDate: '20261010',
        rows: [{
          videoId: '78wrful9cVU', title: 'Hit List song', artist: 'Hit List artist',
          thumbnail: 'https://i.ytimg.com/vi/78wrful9cVU/mqdefault.jpg',
        }],
      },
      {
        id: 'pops-biggest-hits', title: "Pop's Biggest Hits", publisher: 'YouTube Music',
        sourceUrl: 'https://music.youtube.com/playlist?list=RDCLAK5uy_nmS3YoxSwVVQk9lEQJ0UX4ZCjXsW_psU8',
        kind: 'editorial', status: 'available',
        description: 'The biggest pop songs from the last two decades, all in one place.',
        chartDate: '',
        rows: [{
          videoId: 'ic8j13piAhQ', title: 'Taylor Swift - Cruel Summer (Official Audio)', artist: 'Taylor Swift',
          thumbnail: 'https://i.ytimg.com/vi/ic8j13piAhQ/hqdefault.jpg',
        }],
      },
      {
        id: 'classic-rock-greatest-hits', title: "Classic Rock's Greatest Hits", publisher: 'YouTube Music',
        sourceUrl: 'https://music.youtube.com/playlist?list=RDCLAK5uy_nZiG9ehz_MQoWQxY5yElsLHCcG0tv9PRg',
        kind: 'editorial', status: 'available',
        description: 'Essential hits from the classic rock era, featuring long hair, big solos and singers who graduated from frontman school with honors! ',
        chartDate: '',
        rows: [{
          videoId: 'OMOGaugKpzs', title: 'The Police - Every Breath You Take (Official Music Video)', artist: 'The Police',
          thumbnail: 'https://i.ytimg.com/vi/OMOGaugKpzs/hqdefault.jpg',
        }],
      },
      {
        id: 'all-time-alt', title: 'All-Time Alt', publisher: 'YouTube Music',
        sourceUrl: 'https://music.youtube.com/playlist?list=RDCLAK5uy_mgHrXs_5F6wPwPFA47S8yrzCfjCi4AXDE',
        kind: 'editorial', status: 'available',
        description: "Alternative hits from the '90s through today.",
        chartDate: '',
        rows: [{
          videoId: 'hTWKbfoikeg', title: 'Nirvana - Smells Like Teen Spirit (Official Music Video)', artist: 'Nirvana',
          thumbnail: 'https://i.ytimg.com/vi/hTWKbfoikeg/hqdefault.jpg',
        }],
      },
    ],
  }
  const queued = []
  const h = harness({ popularSongs: async () => feed })
  const view = h.render(h.load('Library.tsx').PopularMusic, {
    jobs: [], busy: false, pendingLinks: [], onTranscribe: async (url) => queued.push(url),
  })
  await view.settle()

  assert.match(text(view.tree), /Today's Biggest Hits — The Hit List/)
  assert.match(text(view.tree), /Pop's Biggest Hits/)
  assert.match(text(view.tree), /Classic Rock's Greatest Hits/)
  assert.match(text(view.tree), /All-Time Alt/)
  assert.equal(nodes(view.tree, (node) => node.props.className === 'popular-music-card').length, 4)
  assert.equal(nodes(view.tree, (node) => node.props.className === 'popular-chart-badge').length, 0)
  for (const section of feed.sections) {
    assert.ok(nodes(view.tree, (node) => node.type === 'a' && node.props.href === section.sourceUrl).length)
  }
  assert.ok(feed.sections.slice(1).every((section) => section.rows.every((row) => row.rank === undefined)))
  assert.ok(nodes(view.tree, (node) => node.type === 'a'
    && node.props.href === 'https://www.youtube.com/watch?v=78wrful9cVU').length)
  assert.equal(queued.length, 0)
  const players = () => nodes(view.tree, (node) => node.type === 'iframe')
  assert.equal(players().length, 0, 'No player loads before the user chooses Preview')
  button(view.tree, 'Preview Taylor Swift - Cruel Summer (Official Audio)').props.onClick()
  view.update()
  assert.equal(players().length, 1)
  assert.equal(players()[0].props.src,
    'https://www.youtube-nocookie.com/embed/ic8j13piAhQ?autoplay=1&playsinline=1&controls=1&origin=https%3A%2F%2Fmizan.local')
  assert.equal(players()[0].props.title, 'YouTube preview: Taylor Swift - Cruel Summer (Official Audio)')
  assert.equal(players()[0].props.allow, 'autoplay; encrypted-media; picture-in-picture; web-share')
  assert.equal(players()[0].props.referrerPolicy, 'strict-origin-when-cross-origin')
  const previewCard = nodes(view.tree, (node) => node.props?.className === 'popular-music-card' && node.props['data-previewing'])[0]
  assert.equal(nodes(previewCard, (node) => node.type === 'iframe').length, 1, 'The player stays attached to its selected card')
  assert.equal(nodes(previewCard, (node) => node.props?.className === 'popular-cover-actions popular-cover-actions-playing').length, 1,
    'Stop and Transcribe controls sit below the player')
  assert.ok(nodes(view.tree, (node) => node.type === 'a'
    && node.props.href === 'https://www.youtube.com/watch?v=ic8j13piAhQ').length)
  assert.equal(queued.length, 0, 'Preview does not queue a transcription')
  button(view.tree, 'Preview The Police - Every Breath You Take (Official Music Video)').props.onClick()
  view.update()
  assert.equal(players().length, 1, 'Selecting another shelf stops the previous preview')
  assert.equal(players()[0].props.src,
    'https://www.youtube-nocookie.com/embed/OMOGaugKpzs?autoplay=1&playsinline=1&controls=1&origin=https%3A%2F%2Fmizan.local')
  assert.equal(queued.length, 0)
  button(view.tree, 'Stop preview of The Police - Every Breath You Take (Official Music Video)').props.onClick()
  view.update()
  assert.equal(players().length, 0, 'Stopping removes the iframe')
  assert.equal(queued.length, 0)
  const transcribe = button(view.tree, 'Transcribe Taylor Swift - Cruel Summer (Official Audio)')
  assert.equal(transcribe.props.type, 'button')
  assert.equal(transcribe.props.tabIndex, undefined)
  let stopped = false
  transcribe.props.onClick({ stopPropagation() { stopped = true } })
  await view.settle()
  assert.equal(stopped, true)
  assert.equal(queued[0], 'https://www.youtube.com/watch?v=ic8j13piAhQ')
  view.unmount()

  const queuedView = h.render(h.load('Library.tsx').PopularMusic, {
    jobs: [{
      kind: 'transcribe', url: 'https://www.youtube.com/watch?v=ic8j13piAhQ', status: 'queued',
    }],
    busy: false, pendingLinks: [], onTranscribe: async () => {},
  })
  await queuedView.settle()
  assert.equal(button(queuedView.tree, 'Queued Taylor Swift - Cruel Summer (Official Audio)').props.disabled, true)
  queuedView.unmount()

  const busyView = h.render(h.load('Library.tsx').PopularMusic, {
    jobs: [], busy: true, pendingLinks: [], onTranscribe: async () => {},
  })
  await busyView.settle()
  assert.equal(button(busyView.tree, 'Transcribe Taylor Swift - Cruel Summer (Official Audio)').props.disabled, true)
  assert.equal(button(busyView.tree, 'Preview Taylor Swift - Cruel Summer (Official Audio)').props.disabled, undefined)
  busyView.unmount()
})

test('playlist failures remain visible and retryable without rendering fake songs', async () => {
  let attempts = 0
  const feed = {
    title: 'YouTube Music', fetchedAt: '2026-10-10T00:00:00Z',
    sections: [
      {
        id: 'hit-list', title: "Today's Biggest Hits — The Hit List", publisher: 'YouTube Music',
        sourceUrl: 'https://music.youtube.com/playlist?list=RDCLAK5uy_kmPRjHDECIcuVwnKsx2Ng7fyNgFKWNJFs',
        kind: 'editorial', status: 'unavailable', description: '', chartDate: '',
        message: 'YouTube Music could not load this playlist.', rows: [],
      },
      {
        id: 'pops-biggest-hits', title: "Pop's Biggest Hits", publisher: 'YouTube Music',
        sourceUrl: 'https://music.youtube.com/playlist?list=RDCLAK5uy_nmS3YoxSwVVQk9lEQJ0UX4ZCjXsW_psU8',
        kind: 'editorial', status: 'available',
        rows: [{
          videoId: 'ic8j13piAhQ', title: 'Taylor Swift - Cruel Summer (Official Audio)', artist: 'Taylor Swift',
          thumbnail: 'https://i.ytimg.com/vi/ic8j13piAhQ/hqdefault.jpg',
        }],
      },
      {
        id: 'classic-rock-greatest-hits', title: "Classic Rock's Greatest Hits", publisher: 'YouTube Music',
        sourceUrl: 'https://music.youtube.com/playlist?list=RDCLAK5uy_nZiG9ehz_MQoWQxY5yElsLHCcG0tv9PRg',
        kind: 'editorial', status: 'available',
        rows: [{
          videoId: 'OMOGaugKpzs', title: 'The Police - Every Breath You Take (Official Music Video)', artist: 'The Police',
          thumbnail: 'https://i.ytimg.com/vi/OMOGaugKpzs/hqdefault.jpg',
        }],
      },
      {
        id: 'all-time-alt', title: 'All-Time Alt', publisher: 'YouTube Music',
        sourceUrl: 'https://music.youtube.com/playlist?list=RDCLAK5uy_mgHrXs_5F6wPwPFA47S8yrzCfjCi4AXDE',
        kind: 'editorial', status: 'available',
        rows: [{
          videoId: 'hTWKbfoikeg', title: 'Nirvana - Smells Like Teen Spirit (Official Music Video)', artist: 'Nirvana',
          thumbnail: 'https://i.ytimg.com/vi/hTWKbfoikeg/hqdefault.jpg',
        }],
      },
    ],
  }
  const h = harness({
    popularSongs: async () => {
      if (attempts++ === 0) throw new h.HostError('YouTube Music is unavailable')
      return feed
    },
  })
  const view = h.render(h.load('Library.tsx').PopularMusic, {
    jobs: [], busy: false, pendingLinks: [], onTranscribe: async () => {},
  })
  await view.settle()
  assert.match(text(view.tree), /YouTube Music is unavailable/)
  assert.equal(nodes(view.tree, (node) => node.props.className === 'popular-music-card').length, 0)
  button(view.tree, 'Retry playlists').props.onClick()
  await view.settle()
  await view.settle()
  assert.match(text(view.tree), /Pop's Biggest Hits/)
  assert.match(text(view.tree), /Classic Rock's Greatest Hits/)
  assert.match(text(view.tree), /All-Time Alt/)
  assert.match(text(view.tree), /Today's Biggest Hits — The Hit List unavailable/)
  assert.match(text(view.tree), /Taylor Swift - Cruel Summer/)
  assert.equal(nodes(view.tree, (node) => node.props.className === 'popular-music-card').length, 3)
  assert.equal(attempts, 2)
  view.unmount()
})

test('queue and panel agree on waiting, truthful Cloud scope, and unmeasured progress', () => {
  const h = harness(), running = job(), queued = job({ id: 'queued', status: 'queued', order: 1 })
  const jobs = [running, queued], format = h.load('format.ts')
  assert.equal(format.jobStagePercent(running), null)
  assert.equal(format.jobQueueLabel(queued, jobs), 'Next after current job')
  const queue = h.render(h.load('Library.tsx').Queue, { jobs, onChange() {}, onDetails() {}, onOpen() {} })
  assert.match(text(queue.tree), /Next after current job/)
  const panel = h.render(h.load('JobPanel.tsx').JobPanel,
    { job: queued, jobs, onChange() {}, onClose() {}, onOpen() {} })
  assert.match(text(panel.tree), /Waiting for earlier work/)
  assert.doesNotMatch(text(panel.tree), /Starts next/)
  assert.match(text(panel.tree), /Cloud.*MuScriptor Large/)
  const live = h.render(h.load('JobPanel.tsx').JobPanel,
    { job: running, jobs, onChange() {}, onClose() {}, onOpen() {} })
  assert.equal(nodes(live.tree, (node) => node.props.role === 'progressbar')[0].props['aria-valuenow'], undefined)
  assert.doesNotMatch(text(live.tree), /30%/)
  queue.unmount(); panel.unmount(); live.unmount()
})

test('cloud job details name the provider in processing and failure text', () => {
  const h = harness()
  const current = job({
    status: 'failed', cloudProvider: 'gcp', errorMessage: 'GPU quota is too low.',
    fix: 'Choose a region with available quota.',
  })
  const view = h.render(h.load('JobPanel.tsx').JobPanel, {
    job: current, jobs: [current], onChange() {}, onClose() {}, onDetails() {}, onOpen() {},
  })
  assert.match(text(view.tree), /Google Cloud GPU processing/)
  assert.match(text(view.tree), /Google Cloud: GPU quota is too low/)
  view.unmount()
})

test('queue and panel display action failures and prevent duplicate cancellation clicks', async () => {
  for (const component of ['Queue', 'JobPanel']) {
    let calls = 0
    const h = harness({ cancel: async () => { calls++; throw new h.HostError('Synthetic cancel failure') } })
    const current = job()
    const Component = component === 'Queue' ? h.load('Library.tsx').Queue : h.load('JobPanel.tsx').JobPanel
    const view = h.render(Component, { job: current, jobs: [current], onChange() {}, onClose() {}, onDetails() {}, onOpen() {} })
    const cancel = button(view.tree, component === 'Queue' ? 'Cancel Synthetic song' : 'Cancel')
    cancel.props.onClick(); cancel.props.onClick()
    await view.settle()
    assert.equal(calls, 1)
    assert.ok(nodes(view.tree, (node) => node.props.role === 'alert').some((node) =>
      text(node).includes('Synthetic cancel failure')))
    view.unmount()
  }
})
