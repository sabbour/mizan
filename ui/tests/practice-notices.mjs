import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'

// Saved-song notices (decoding warning, analysis status, playability) stay compact so the score, tab and live
// guitar keep the room; their explanations open over the practice view instead of pushing it down.
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
await server.listen()
const base = server.resolvedUrls.local[0].replace(/\/$/, '')
const browserPath = process.env.MIZAN_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const profile = await mkdtemp(join(tmpdir(), 'mizan-notices-'))
const browser = spawn(browserPath, ['--headless=new', '--mute-audio', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--no-first-run', '--disable-sync', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let socket
try {
  let port
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch { await sleep(100) }
  }
  assert.ok(port, 'The test browser has a debugging endpoint')
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const address = new URL(targets.find((item) => item.type === 'page').webSocketDebuggerUrl)
  address.hostname = '127.0.0.1'
  socket = new WebSocket(address.href)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let sequence = 0
  const pending = new Map()
  socket.onmessage = ({ data }) => { const reply = JSON.parse(data); if (reply.id) pending.get(reply.id)?.(reply) }
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 30000)
    pending.set(id, (reply) => {
      clearTimeout(timer); pending.delete(id)
      if (reply.error) reject(new Error(JSON.stringify(reply.error))); else resolve(reply.result)
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description)
    return result.result.value
  }
  const key = async (key, code, windowsVirtualKeyCode) => {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, ...(key === ' ' ? { text: ' ' } : {}) })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
  }
  const clickAt = async ({ x, y }) => {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  const measure = `(() => {
    const box = (selector) => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r && { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height } }
    return { head: box('.ws-head'), notices: box('.ws-notices'), analysis: box('.analysis-notice'), play: box('.playability-note'),
      practice: box('.fretted-practice'), foot: box('.ws-foot'), view: { width: innerWidth, height: innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      overflowing: [...document.querySelectorAll('.ws-notices *')].filter((el) => !el.closest('.notice-details-panel'))
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.right > innerWidth + 0.5 || r.left < -0.5) }).map((el) => el.className || el.tagName) }
  })()`
  await call('Page.enable'); await call('Runtime.enable')
  const checks = []
  // Short, scaled windows like the 150% and 125% Windows displays the practice page is played from.
  for (const [width, height, scale] of [[1768, 749, 1.5], [1280, 680, 1.25], [1024, 640, 1.25], [900, 600, 1]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
    const open = async (notice) => {
      await call('Page.navigate', { url: `${base}/tests/playability-preview.html?case=guitar&view=fretboard${notice ? `&notice=${notice}` : ''}` })
      for (let attempt = 0; attempt < 150 && !(await evaluate('!!document.querySelector(".fretted-practice") && !!document.querySelector(".playability-note")')); attempt++) await sleep(100)
      await sleep(150)
      return evaluate(measure)
    }
    const size = `${width}x${height}@${scale}`
    const bare = await open('')
    for (const notice of ['decoding', 'status', 'long']) {
      const name = `${notice} ${size}`
      const layout = await open(notice)
      assert.ok(layout.analysis, `${name}: the transcription warning is shown`)
      assert.equal(await evaluate('document.querySelector(".analysis-notice [role=status]")?.textContent.startsWith("Best-effort transcription")'), true,
        `${name}: the decoding headline stays visible`)
      assert.ok(layout.scrollWidth <= width, `${name}: no horizontal overflow (${layout.scrollWidth} > ${width})`)
      assert.deepEqual(layout.overflowing, [], `${name}: notice text wraps inside the window`)
      // The notices row never takes more than a slim strip, even with long text; the practice view keeps most of the page.
      const limit = notice === 'long' ? 150 : width < 1000 ? 96 : 76
      assert.ok(layout.notices.height <= limit, `${name}: the notices take ${layout.notices.height}px (limit ${limit})`)
      assert.ok(layout.head.height - bare.head.height <= limit, `${name}: the header grows ${layout.head.height - bare.head.height}px for the notices`)
      assert.ok(layout.practice.height >= (layout.foot.top - layout.head.height) - 1 && layout.practice.height >= height * (notice === 'long' ? 0.35 : 0.4),
        `${name}: the practice view keeps ${layout.practice.height}px of ${height}`)
      assert.ok(layout.foot.bottom <= height + 0.5 && layout.foot.top >= layout.practice.top, `${name}: the playback controls stay on screen`)
      if (notice === 'long') assert.equal(await evaluate('document.querySelector(".analysis-notice-error[role=alert]")?.textContent.includes("could not be queued")'), true,
        `${name}: errors stay visible, not behind details`)

      // Details open over the practice view without moving it, stay inside the window, and close with Escape or a click outside.
      const summaries = await evaluate('[...document.querySelectorAll(".ws-notices .notice-details > summary")].map((s) => s.textContent)')
      for (let index = 0; index < summaries.length; index++) {
        const label = `${name} "${summaries[index]}"`
        const toggle = await evaluate(`(() => { const r = document.querySelectorAll(".ws-notices .notice-details > summary")[${index}].getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
        await clickAt(toggle)
        await sleep(50)
        const opened = await evaluate(`(() => {
          const details = document.querySelectorAll(".ws-notices .notice-details")[${index}]
          const panel = details.querySelector(".notice-details-panel").getBoundingClientRect()
          return { open: details.open, panel: { top: panel.top, bottom: panel.bottom, left: panel.left, right: panel.right, height: panel.height },
            text: details.querySelector(".notice-details-panel").textContent, head: document.querySelector(".ws-head").getBoundingClientRect().height,
            practiceTop: document.querySelector(".fretted-practice").getBoundingClientRect().top,
            covered: document.elementFromPoint((panel.left + panel.right) / 2, panel.top + Math.min(12, panel.height / 2))?.closest(".notice-details-panel") != null }
        })()`)
        assert.equal(opened.open, true, `${label}: opens`)
        assert.ok(opened.text.trim().length > 10, `${label}: shows its explanation`)
        assert.equal(opened.head, layout.head.height, `${label}: opening does not grow the header`)
        assert.equal(opened.practiceTop, layout.practice.top, `${label}: opening does not push the practice view down`)
        assert.ok(opened.covered, `${label}: the panel is drawn above the practice view`)
        assert.ok(opened.panel.left >= -0.5 && opened.panel.right <= width + 0.5 && opened.panel.bottom <= height + 0.5,
          `${label}: the panel stays inside the window`)
        if (index === 0) {
          await key('Escape', 'Escape', 27)
          assert.equal(await evaluate(`document.querySelectorAll(".ws-notices .notice-details")[${index}].open`), false, `${label}: Escape closes it`)
          assert.equal(await evaluate('document.activeElement?.tagName'), 'SUMMARY', `${label}: Escape returns focus to the toggle`)
        } else {
          await clickAt({ x: 24, y: Math.round(Math.min(layout.foot.top - 8, opened.panel.bottom + 12)) })
          assert.equal(await evaluate(`document.querySelectorAll(".ws-notices .notice-details")[${index}].open`), false, `${label}: a click outside closes it`)
        }
        checks.push(label)
      }
    }
    // Keyboard: Space opens a focused toggle without starting playback; Escape closes it even after focus moves on.
    await open('status')
    await evaluate('document.querySelector(".analysis-notice .notice-details > summary").focus()')
    await key(' ', 'Space', 32)
    await sleep(100)
    assert.equal(await evaluate('document.querySelector(".analysis-notice .notice-details").open'), true, `Keyboard ${size}: Space opens the explanation`)
    assert.equal(await evaluate('document.querySelector("[title=\\"Play (Space)\\"]") != null'), true, `Keyboard ${size}: Space on a toggle does not start playback`)
    await key('Tab', 'Tab', 9)
    assert.equal(await evaluate('document.activeElement !== document.querySelector(".analysis-notice .notice-details > summary")'), true, `Keyboard ${size}: Tab moves on`)
    await key('Escape', 'Escape', 27)
    assert.equal(await evaluate('document.querySelector(".analysis-notice .notice-details").open'), false, `Keyboard ${size}: Escape closes it after focus moved on`)
    assert.equal(await evaluate('document.activeElement === document.querySelector(".analysis-notice .notice-details > summary")'), true,
      `Keyboard ${size}: Escape returns focus to its toggle`)
    // "Show where" still lists the moments and jumps playback to them.
    await open('decoding')
    await evaluate('document.querySelector(".playability-where > summary").click()')
    const where = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll(".playability-where li button")]
      buttons.at(-1)?.click()
      return { count: buttons.length, label: buttons.at(-1)?.textContent, open: document.querySelector(".playability-where").open }
    })()`)
    assert.ok(where.count > 0 && /^Bar \d+/.test(where.label), `Show where ${size}: lists bar positions`)
    assert.equal(where.open, true, `Show where ${size}: stays open while jumping between moments`)
  }
  console.log(`Practice notices: ${checks.length} compact notice and details checks passed across 4 short, scaled windows.`)
} finally {
  try { socket?.send(JSON.stringify({ id: 999999, method: 'Browser.close' })) } catch { /* the browser may already be gone */ }
  await sleep(500)
  if (browser.exitCode === null) browser.kill()
  await server.close()
  await sleep(500)
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {})
}
