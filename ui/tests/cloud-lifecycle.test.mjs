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

function harness(overrides = {}) {
  let active
  const timers = []
  const host = {
    library: async () => [], folders: async () => [],
    getTranscriptionModel: async () => 'muscriptor-small',
    hfTokenStatus: async () => true, modelPreflight: async () => ({}),
    modelDownloadStatus: async () => ({}), resourceUsage: async () => null,
    cancelCloudStatus: async () => ({ cancelRequested: true }),
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
    setInterval: () => 1, clearInterval() {},
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
        if (specifier === './CloudSetup') return { CloudSetup: 'cloud-setup' }
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
  return { host, HostError, load, render, runTimers: () => { for (const callback of timers.splice(0)) callback() } }
}

const libraryProps = { jobs: [], version: 0, onQueueChange() {}, onOpen() {}, onDetails() {}, onCredits() {} }
const cloudReady = { mode: 'cloud', configured: true, available: true,
  supportedModels: ['muscriptor-small', 'muscriptor-medium', 'muscriptor-large'] }
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
