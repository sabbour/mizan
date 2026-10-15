import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every guide marker (finger badge or open-string ring) in the 3D mirror must sit on its own string and fret.
const base = process.env.MIZAN_TEST_URL ?? 'http://127.0.0.1:5187'
const browserPath = process.env.MIZAN_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const profile = await mkdtemp(join(tmpdir(), 'mizan-markers-'))
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
  await call('Page.enable'); await call('Runtime.enable')
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__frame = null
    window.__mizanGuitarFrame = window.__mizanBassFrame = (_canvas, frame, pane) => { if (pane === 'overview') window.__frame = frame }
  ` })
  let checked = 0, worst = 0, colourChecks = 0
  for (const [width, scale] of [[1440, 1], [1366, 1]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: scale, mobile: false })
    for (const instrument of ['guitar', 'bass']) {
      const examples = instrument === 'guitar' ? ['single', 'chord', 'barre', 'open', 'mixed', 'cshape'] : ['single', 'chord', 'open']
      for (const handedness of ['right', 'left']) for (const example of examples) {
        const name = `${instrument} ${handedness} ${example} ${width}`
        await call('Page.navigate', { url: `${base}/tests/fretted-preview.html?${new URLSearchParams({ instrument, handedness, example, style: 'Realistic' })}` })
        for (let attempt = 0; attempt < 150 && !(await evaluate('!!document.querySelector("[data-fretted-view=\\"mirror\\"]")')); attempt++) await sleep(100)
        await evaluate('window.__frame = null; document.querySelector("[data-fretted-view=\\"mirror\\"]").click()')
        let ready = false
        for (let attempt = 0; attempt < 200 && !ready; attempt++) {
          ready = await evaluate('!!window.__frame?.markers && !!document.querySelector(".fretted-mirror-target")')
          if (!ready) await sleep(100)
        }
        assert.ok(ready, `${name}: the mirror view shows guide markers`)
        // Once the hand is solved, every current marker wears its finger's colour and only pressing fingers are tinted.
        if (await evaluate('window.__frame.markers.some((marker) => marker.state === "playback")')) {
          let solved = false
          for (let attempt = 0; attempt < 600 && !solved; attempt++) {
            solved = await evaluate('!!window.__frame.hand?.contacts.length && window.__frame.handCurrent')
            if (!solved) await sleep(100)
          }
          assert.ok(solved, `${name}: the hand is solved for the current notes`)
          const colours = await evaluate(`(() => {
            const frame = window.__frame
            const hex = (css) => '#' + css.match(/\\d+/g).slice(0, 3).map((value) => Number(value).toString(16).padStart(2, '0')).join('')
            const tinted = new Map(frame.hand.tints.map((tint) => [tint.finger, tint.color]))
            const pressing = frame.hand.fingerLabels.filter((label) => label.pressed).map((label) => label.finger)
            const markers = [...document.querySelectorAll('.fretted-mirror-target[data-state="playback"][data-finger]')].map((element) => {
              const contact = frame.hand.contacts.find((item) => item.string === Number(element.dataset.string) && item.fret === Number(element.dataset.fret))
              return { finger: Number(element.dataset.finger), contactFinger: contact?.finger,
                colour: hex(getComputedStyle(element.querySelector('.fretted-mirror-core')).backgroundColor), tint: tinted.get(contact?.finger) }
            })
            return { markers, tinted: [...tinted.keys()], pressing, contacts: [...new Set(frame.hand.contacts.map((item) => item.finger))] }
          })()`)
          assert.ok(colours.markers.length > 0, `${name}: current markers carry a finger`)
          for (const marker of colours.markers) {
            assert.equal(marker.finger, marker.contactFinger, `${name}: a marker takes the finger the hand frame reports for its contact`)
            assert.equal(marker.colour, marker.tint, `${name}: finger ${marker.finger}'s marker colour equals its fingertip tint`)
          }
          assert.deepEqual(colours.tinted.sort(), colours.contacts.sort(), `${name}: exactly the fingers holding contacts are tinted`)
          assert.ok(colours.tinted.every((finger) => colours.pressing.includes(finger)), `${name}: only pressing fingers are tinted`)
          colourChecks++
        }
        await sleep(300)
        const result = await evaluate(`(() => {
          const frame = window.__frame
          const canvas = document.querySelector('.fretted-canvas')
          const box = canvas.getBoundingClientRect()
          const unit = box.width / canvas.width
          const strings = [...new Set([...frame.markers.map((m) => m.position.string), ...frame.openTargets.map((t) => t.string)])]
          const count = Math.max(...frame.stringLabels.map((label) => label.string))
          const lineDistance = (string, x, y) => {
            const a = frame.projectFret(string, 1), b = frame.projectFret(string, 12)
            const length = Math.hypot(b[0] - a[0], b[1] - a[1])
            return Math.abs((b[0] - a[0]) * (a[1] - y) - (a[0] - x) * (b[1] - a[1])) / length * unit
          }
          return [...document.querySelectorAll('.fretted-mirror-target')].map((element) => {
            const rect = element.getBoundingClientRect()
            const x = rect.left + rect.width / 2 - box.left, y = rect.top + rect.height / 2 - box.top
            const string = Number(element.dataset.string), fret = Number(element.dataset.fret)
            const expected = frame.projectFret(string, fret)
            const own = lineDistance(string, x / unit, y / unit)
            const nearest = Array.from({ length: count }, (_, index) => index + 1)
              .map((other) => [other, lineDistance(other, x / unit, y / unit)]).sort((p, q) => p[1] - q[1])[0][0]
            return { string, fret, kind: element.dataset.kind, error: Math.hypot(x - expected[0] * unit, y - expected[1] * unit), own, nearest }
          })
        })()`)
        assert.ok(result.length > 0, `${name}: there are markers to check`)
        for (const marker of result) {
          checked++; worst = Math.max(worst, marker.error)
          assert.ok(marker.error <= 3, `${name}: ${marker.kind} marker on string ${marker.string} fret ${marker.fret} is ${marker.error.toFixed(1)} CSS px from its string and fret point`)
          assert.equal(marker.nearest, marker.string, `${name}: the marker for string ${marker.string} fret ${marker.fret} is nearest its own string, not string ${marker.nearest}`)
          assert.ok(marker.own <= 3, `${name}: the marker for string ${marker.string} fret ${marker.fret} lies on its string (${marker.own.toFixed(1)} CSS px away)`)
        }
      }
    }
  }
  console.log(`Mirror markers: ${checked} markers sit within ${worst.toFixed(2)} CSS px of their string and fret points (limit 3); ${colourChecks} chords match marker and fingertip colours.`)
} finally {
  try { socket?.send(JSON.stringify({ id: 999999, method: 'Browser.close' })) } catch { /* the browser may already be gone */ }
  await sleep(500)
  if (browser.exitCode === null) browser.kill()
  await sleep(1000)
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {})
}
