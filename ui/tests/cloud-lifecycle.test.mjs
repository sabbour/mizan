import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from '../node_modules/typescript/lib/typescript.js'

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

function harness(overrides = {}, { loadCloudSetup = false } = {}) {
  let active
  const timers = []
  const intervals = new Map()
  let nextInterval = 1
  const host = {
    library: async () => [], folders: async () => [],
    getTranscriptionModel: async () => 'muscriptor-small',
    hfTokenStatus: async () => true, modelPreflight: async () => ({}),
    modelDownloadStatus: async () => ({}), resourceUsage: async () => null,
    cancelCloudStatus: async () => ({ cancelRequested: true }),
    cloudReadinessProgress: async () => ({
      stage: 'idle', detail: null, elapsedSeconds: 0, timeoutSeconds: 120,
    }),
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
    if (name === 'Library.tsx') source += '\nexport { Queue, YouTubeSearch }\n'
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
        if (specifier === './bridge') return { host, HostError, IMPORTABLE: /\.(mid|musicxml)$/i }
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
    host, HostError, load, render,
    runTimers: () => { for (const callback of timers.splice(0)) callback() },
    runIntervals: (ms) => {
      for (const interval of intervals.values()) if (interval.ms === ms) interval.callback()
    },
  }
}

const libraryProps = { jobs: [], version: 0, onQueueChange() {}, onOpen() {}, onDetails() {}, onCredits() {} }
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
  button(view.tree, 'Song analysis settings').props.onClick()
  view.update()
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
  button(view.tree, 'Song analysis settings').props.onClick(); view.update()
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
  button(view.tree, 'Song analysis settings').props.onClick(); view.update()
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
  button(view.tree, 'Song analysis settings').props.onClick(); view.update()
  h.runIntervals(500)
  await view.settle()
  assert.match(text(view.tree), /Progress polling failed/)
  status.resolve(cloudReady)
  await view.settle()
  assert.match(text(view.tree), /Cloud is on for new and redone analyses/)
  assert.doesNotMatch(text(view.tree), /Progress polling failed|Azure access check failed/)
  view.unmount()
})

test('unknown Cloud model catalog keeps choices available; known omission is unsupported', async () => {
  const h = harness({
    cloudStatus: async () => ({ mode: 'cloud', configured: false, available: true, jobCreated: true }),
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  button(view.tree, 'Song analysis settings').props.onClick()
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
  button(knownView.tree, 'Song analysis settings').props.onClick()
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
  })
  const view = h.render(h.load('Library.tsx').Library, libraryProps)
  button(view.tree, 'Song analysis settings').props.onClick()
  await view.settle(); await view.settle()
  assert.ok(button(view.tree, 'Check Azure access'))
  button(view.tree, 'Check Azure access').props.onClick()
  await view.settle(); await view.settle()
  assert.equal(checks, 2)
  assert.equal(calls.length, 0)
  assert.equal(nodes(view.tree, (node) => node.type === 'cloud-setup').length, 0)
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
  button(view.tree, 'Song analysis settings').props.onClick()
  await view.settle(); await view.settle()
  nodes(view.tree, (node) => node.type === 'input' && node.props.name === 'processing-mode')[1]
    .props.onChange()
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
  button(partialView.tree, 'Song analysis settings').props.onClick()
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
  const view = h.render(component, { status: saved, onStatus() {}, onClose() {},
    acquireOperation: () => () => {} })
  assert.match(text(view.tree), /Build the GPU worker, then create the Job/)
  assert.ok(button(view.tree, 'Build GPU worker in my registry'))
  button(view.tree, 'Build GPU worker in my registry').props.onClick()
  await view.settle(); await view.settle()
  assert.deepEqual(actions, ['build-worker'])
  assert.match(text(view.tree), /GPU worker built and ready for the Job/)
  assert.equal(nodes(view.tree, (node) => node.type === 'button'
    && text(node) === 'Approve and provision infrastructure').length, 0)
  view.unmount()
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
  button(view.tree, 'Song analysis settings').props.onClick(); view.update()
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
  button(view.tree, 'Song analysis settings').props.onClick(); await view.settle(); await view.settle()
  assert.match(text(view.tree), /Azure is ready/)
  button(view.tree, 'Close song analysis settings').props.onClick(); view.update()
  button(view.tree, 'Song analysis settings').props.onClick(); view.update()
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
  button(view.tree, 'Song analysis settings').props.onClick(); await view.settle()
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
  button(view.tree, 'Song analysis settings').props.onClick()
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
  button(view.tree, 'Song analysis settings').props.onClick(); await view.settle()
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
  button(view.tree, 'Song analysis settings').props.onClick(); view.update()
  button(view.tree, 'Close song analysis settings').props.onClick(); view.update()
  button(view.tree, 'Song analysis settings').props.onClick(); view.update()
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
  button(view.tree, 'Song analysis settings').props.onClick(); view.update()
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
  button(view.tree, 'Song analysis settings').props.onClick(); view.update()
  button(view.tree, 'Close song analysis settings').props.onClick(); view.update()
  button(view.tree, 'Song analysis settings').props.onClick(); view.update()
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
