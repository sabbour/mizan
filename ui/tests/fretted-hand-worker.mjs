import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const cacheDir = await mkdtemp(join(tmpdir(), 'mizan-hand-worker-check-'))
const vite = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  cacheDir,
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  appType: 'custom',
})
const originalSelf = globalThis.self
const replies = []
let nextReply
globalThis.self = {
  onmessage: null,
  postMessage(reply) {
    replies.push(reply)
    nextReply?.(reply)
  },
}
const solve = (key) => globalThis.self.onmessage({ data: {
  kind: 'solve', key, side: 'left', contacts: [], state: 'pressed',
  neck: { halfWidth: 0.0235, depth: 0.024 },
} })
const waitForReply = (kind, key) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('The hand worker did not reply.')), 8000)
  nextReply = (reply) => {
    if (reply.kind !== kind || reply.key !== key) return
    clearTimeout(timer)
    nextReply = null
    resolve()
  }
})

try {
  await vite.ssrLoadModule('/src/workspace/frettedHandWorker.ts')
  let ready = waitForReply('error', 'before-init')
  solve('before-init')
  await ready
  assert.deepEqual(replies.pop(), {
    kind: 'error', key: 'before-init', message: 'The fretting-hand models are not ready.',
  }, 'An uninitialized worker reports an explicit error')

  globalThis.self.onmessage({ data: { kind: 'init', assets: { left: {}, right: {} } } })
  ready = waitForReply('pose', 'current')
  solve('superseded')
  solve('current')
  assert.deepEqual(replies, [{ kind: 'discarded', key: 'superseded' }],
    'Superseded queued work releases its pending key without solving an obsolete grip')
  replies.length = 0
  await ready
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(replies.length, 1)
  const first = replies.pop()
  assert.equal(first.kind, 'pose')
  assert.equal(first.key, 'current')
  assert.equal(first.pose.unavailable, true, 'Empty contacts never invent a hand pose')

  ready = waitForReply('pose', 'current')
  solve('current')
  await ready
  assert.equal(replies.pop().pose, first.pose, 'An unchanged grip reuses its prepared pose')

  ready = waitForReply('pose', 'same-queued-key')
  solve('same-queued-key')
  solve('same-queued-key')
  await ready
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(replies.length, 1, 'Two identical queued requests produce only one response')
  assert.equal(replies.pop().key, 'same-queued-key')

  const order = []
  const collect = (reply) => { if (reply.kind === 'pose') order.push(reply.key) }
  const originalPost = globalThis.self.postMessage
  globalThis.self.postMessage = (reply) => { collect(reply); originalPost(reply) }
  const ahead = (key) => globalThis.self.onmessage({ data: {
    kind: 'solve', key, side: 'left', contacts: [], state: 'pressed', ahead: true, neck: { halfWidth: 0.0235, depth: 0.024 },
  } })
  ready = waitForReply('pose', 'later-two')
  ahead('later-one')
  ahead('later-two')
  solve('needed-now')
  await ready
  assert.deepEqual(order, ['needed-now', 'later-one', 'later-two'],
    'The pose needed now is solved first and coming poses are kept, not discarded')
  globalThis.self.postMessage = originalPost
  console.log('Fretting-hand worker queue, cached poses and explicit error checks passed.')
} finally {
  if (originalSelf === undefined) delete globalThis.self
  else globalThis.self = originalSelf
  await vite.close()
  await rm(cacheDir, { recursive: true, force: true })
}
