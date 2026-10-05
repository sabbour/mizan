// Run from the repository root:
//   node ui\tests\instrument-samples-browser.mjs --audit --write-catalog
//   node ui\tests\instrument-samples-browser.mjs
// Uses isolated headless Edge and a loopback server for only the sample bank.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const bankDirectory = path.join(root, 'ui', 'public', 'samples', 'fluidr3')
const catalogPath = path.join(root, 'ui', 'scripts', 'fluidr3-audibility.json')
const edgePath = process.env.MIZAN_TEST_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const args = process.argv.slice(2)
const mode = args.includes('--audit') ? 'audit' : 'nearest'
const writeCatalog = args.includes('--write-catalog')
const silentThreshold = 1 / 32768
assert.ok(args.every((arg) => ['--audit', '--write-catalog'].includes(arg)), `Unknown argument: ${args.join(' ')}`)
assert.ok(!writeCatalog || mode === 'audit', '--write-catalog requires --audit')

const bankManifest = JSON.parse(await readFile(path.join(bankDirectory, 'manifest.json'), 'utf8'))
const samplePaths = new Map()
const instruments = bankManifest.instruments.map((instrument) => ({
  program: instrument.program,
  name: instrument.name,
  samples: instrument.samples.map((sample) => {
    const url = `/sample/${instrument.program}/${sample.midi}`
    samplePaths.set(url, path.join(bankDirectory, instrument.name, `${sample.midi}.mp3`))
    return { ...sample, url }
  }),
}))
assert.equal(instruments.length, 128)
assert.ok(instruments.every((instrument) => instrument.samples.length === 30))

const fixtureManifest = {
  schemaVersion: bankManifest.schemaVersion,
  source: bankManifest.source,
  instruments,
}

const page = `<!doctype html>
<meta charset="utf-8">
<title>Instrument MP3 native decode audit</title>
<script>
(() => {
  const mode = ${JSON.stringify(mode)};
  const threshold = ${silentThreshold};
  let context;
  let sourceStarts = 0;
  let mediaPlayCalls = 0;
  const sourcePrototype = AudioScheduledSourceNode.prototype;
  const mediaPrototype = HTMLMediaElement.prototype;
  const originalStart = sourcePrototype.start;
  const originalPlay = mediaPrototype.play;
  sourcePrototype.start = function () {
    sourceStarts += 1;
    throw new Error('Audio node playback is prohibited in this validation');
  };
  mediaPrototype.play = function () {
    mediaPlayCalls += 1;
    return Promise.reject(new Error('Media playback is prohibited in this validation'));
  };

  const nearestUsableSample = (instrument, targetMidi) => instrument.samples
    .filter((sample) => sample.silent !== true)
    .sort((a, b) => Math.abs(a.midi - targetMidi) - Math.abs(b.midi - targetMidi) || a.midi - b.midi)[0];

  const run = async () => {
    try {
      const response = await fetch('/manifest.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('Test manifest request failed: ' + response.status);
      const manifest = await response.json();
      if (manifest.instruments.length !== 128) throw new Error('Expected 128 GM programs');
      context = new AudioContext();
      if (typeof context.decodeAudioData !== 'function') throw new Error('AudioContext.decodeAudioData is unavailable');

      const checks = [];
      if (mode === 'audit') {
        for (const instrument of manifest.instruments) {
          for (const sample of instrument.samples) checks.push({ instrument, sample, targetMidi: null });
        }
      } else {
        for (const instrument of manifest.instruments) {
          const sample = nearestUsableSample(instrument, 60);
          if (!sample) throw new Error('No non-silent roots remain for ' + instrument.name);
          checks.push({ instrument, sample, targetMidi: 60 });
        }
      }

      const results = new Array(checks.length);
      let next = 0;
      const worker = async () => {
        while (next < checks.length) {
          const index = next++;
          const { instrument, sample, targetMidi } = checks[index];
          if (sample.url !== '/sample/' + instrument.program + '/' + sample.midi) {
            throw new Error('Unexpected local sample URL for ' + instrument.name + ' MIDI ' + sample.midi);
          }
          const assetResponse = await fetch(sample.url, { cache: 'no-store' });
          if (!assetResponse.ok) {
            throw new Error('MP3 request failed for ' + instrument.name + ' MIDI ' + sample.midi + ': ' + assetResponse.status);
          }
          const bytes = await assetResponse.arrayBuffer();
          if (bytes.byteLength !== sample.bytes) {
            throw new Error('Byte count mismatch for ' + instrument.name + ' MIDI ' + sample.midi);
          }
          const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
            .map((value) => value.toString(16).padStart(2, '0')).join('');
          if (hash !== sample.sha256) {
            throw new Error('SHA-256 mismatch for ' + instrument.name + ' MIDI ' + sample.midi);
          }

          const audio = await context.decodeAudioData(bytes);
          if (!Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0
            || !Number.isFinite(audio.duration) || audio.duration <= 0
            || !Number.isInteger(audio.length) || audio.length <= 0
            || !Number.isInteger(audio.numberOfChannels) || audio.numberOfChannels <= 0) {
            throw new Error('Invalid decoded audio metadata for ' + instrument.name + ' MIDI ' + sample.midi);
          }
          let finiteSamples = 0;
          let peakAmplitude = 0;
          for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
            const waveform = audio.getChannelData(channel);
            if (waveform.length !== audio.length) {
              throw new Error('Empty decoded waveform for ' + instrument.name + ' MIDI ' + sample.midi);
            }
            for (const value of waveform) {
              if (!Number.isFinite(value)) {
                throw new Error('Non-finite waveform value for ' + instrument.name + ' MIDI ' + sample.midi);
              }
              finiteSamples += 1;
              peakAmplitude = Math.max(peakAmplitude, Math.abs(value));
            }
          }
          results[index] = {
            program: instrument.program,
            name: instrument.name,
            midi: sample.midi,
            sha256: sample.sha256,
            targetMidi,
            frames: audio.length,
            duration: audio.duration,
            sampleRate: audio.sampleRate,
            channels: audio.numberOfChannels,
            finiteSamples,
            peakAmplitude,
            silent: peakAmplitude <= threshold,
          };
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));

      const silentSamples = results
        .filter(({ silent }) => silent)
        .map(({ program, midi, sha256, peakAmplitude }) => ({ program, midi, sha256, peakAmplitude }))
        .sort((a, b) => a.program - b.program || a.midi - b.midi);
      const silentByProgram = Array(128).fill(0)
      for (const sample of silentSamples) silentByProgram[sample.program] += 1
      const audibleRootCounts = mode === 'audit'
        ? silentByProgram.map((count, program) => manifest.instruments[program].samples.length - count)
        : []
      const programsWithoutAudibleRoots = mode === 'audit'
        ? silentByProgram.flatMap((count, program) => count === manifest.instruments[program].samples.length ? [program] : [])
        : []
      if (sourceStarts !== 0 || mediaPlayCalls !== 0) {
        throw new Error('Playback side effects detected: source.start=' + sourceStarts + ', media.play=' + mediaPlayCalls);
      }

      if (mode === 'audit') {
        return {
          mode,
          revision: manifest.source.revision,
          programCount: manifest.instruments.length,
          physicalRootCount: results.length,
          audibleRootCount: results.length - silentSamples.length,
          silentRootCount: silentSamples.length,
          silentThreshold: threshold,
          thresholdDefinition: 'maximum absolute AudioContext.decodeAudioData waveform amplitude <= 1/32768',
          programsWithoutAudibleRoots,
          audibleRootCounts,
          sampleRateSet: [...new Set(results.map(({ sampleRate }) => sampleRate))].sort((a, b) => a - b),
          minimumDurationSeconds: Math.min(...results.map(({ duration }) => duration)),
          maximumDurationSeconds: Math.max(...results.map(({ duration }) => duration)),
          totalDecodedFrames: results.reduce((sum, { frames }) => sum + frames, 0),
          silentSamples,
          audioNodeStarts: sourceStarts,
          mediaPlayCalls,
        };
      }

      const unusableSelections = results.filter(({ silent }) => silent)
      const guitars = results.filter(({ program }) => program >= 24 && program <= 31)
      const byProgram = results.map(({ program, midi, name, peakAmplitude }) => ({ program, midi, name, peakAmplitude }))
      return {
        mode,
        programCount: results.length,
        decodedCount: results.length,
        targetMidi: 60,
        selectionRule: 'nearest non-silent root; ties choose the lower MIDI number',
        sampleRateSet: [...new Set(results.map(({ sampleRate }) => sampleRate))].sort((a, b) => a - b),
        minimumDurationSeconds: Math.min(...results.map(({ duration }) => duration)),
        maximumDurationSeconds: Math.max(...results.map(({ duration }) => duration)),
        totalDecodedFrames: results.reduce((sum, { frames }) => sum + frames, 0),
        unusableSelections,
        guitarProgramsDecoded: guitars.length,
        guitarWaveformsFiniteAndNonempty: guitars.length === 8 && guitars.every(({ finiteSamples, peakAmplitude }) => finiteSamples > 0 && peakAmplitude > threshold),
        audioNodeStarts: sourceStarts,
        mediaPlayCalls,
        selectedRoots: byProgram,
      };
    } finally {
      if (context && context.state !== 'closed') await context.close();
      if (sourceStarts !== 0 || mediaPlayCalls !== 0) {
        throw new Error('Playback side effects detected during decode cleanup');
      }
      sourcePrototype.start = originalStart;
      mediaPrototype.play = originalPlay;
    }
  };

  window.__instrumentSampleDecodePromise = run();
})();
</script>`

const server = createServer((request, response) => {
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' }).end()
    return
  }
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  if (pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(page)
    return
  }
  if (pathname === '/manifest.json') {
    const body = Buffer.from(JSON.stringify(fixtureManifest))
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(body)
    return
  }
  const samplePath = samplePaths.get(pathname)
  if (!samplePath) {
    response.writeHead(404).end()
    return
  }
  readFile(samplePath).then((body) => {
    response.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(body)
  }, () => response.writeHead(404).end())
})

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
let profile
let browser
let socket
let cdpPort
let sequence = 0
const pending = new Map()

function cdpCall(method, params = {}, timeoutMilliseconds = 30_000) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, timeoutMilliseconds)
    pending.set(id, {
      method,
      finish: (message) => {
        pending.delete(id)
        clearTimeout(timeout)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
      },
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression, timeoutMilliseconds = 600_000) {
  const result = await cdpCall('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: false,
  }, timeoutMilliseconds)
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text)
  return result.result.value
}

async function waitForBrowserExit(child, timeoutMilliseconds = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    sleep(timeoutMilliseconds).then(() => false),
  ])
}

async function stopOwnedBrowserTree(child, profilePath) {
  if (process.platform !== 'win32') {
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    return
  }
  const escapedProfile = profilePath.replaceAll("'", "''")
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `
    $profilePath = '${escapedProfile}'
    $all = Get-CimInstance Win32_Process
    $owned = $all | Where-Object {
      $_.ProcessId -ne $PID -and
      $_.CommandLine -and $_.CommandLine.Contains($profilePath)
    }
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    function Add-TestBrowserTree([int]$processId) {
      if (-not $ids.Add($processId)) { return }
      foreach ($childProcess in ($all | Where-Object ParentProcessId -eq $processId)) {
        Add-TestBrowserTree $childProcess.ProcessId
      }
    }
    foreach ($process in $owned) { Add-TestBrowserTree $process.ProcessId }
    foreach ($processId in $ids) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
  `], { stdio: 'ignore', timeout: 15_000 })
}

try {
  profile = await mkdtemp(path.join(root, '.mizan-instrument-samples-browser-'))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  browser = spawn(edgePath, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  browser.once('error', (error) => {
    for (const { finish } of pending.values()) finish({ error: { message: error.message } })
  })

  let activePort
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      activePort = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0])
      break
    } catch {
      if (browser.exitCode !== null) break
      await sleep(100)
    }
  }
  assert.ok(activePort, 'Isolated headless Edge debugging endpoint started')
  cdpPort = activePort
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
  const target = targets.find((entry) => entry.type === 'page')
  assert.ok(target, 'Edge created a page target')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) pending.get(message.id)?.finish(message)
  }
  socket.onclose = () => {
    for (const { method, finish } of [...pending.values()]) {
      finish({ error: { message: `${method}: browser connection closed` } })
    }
  }

  await cdpCall('Page.enable')
  await cdpCall('Runtime.enable')
  await cdpCall('Page.navigate', { url: `http://127.0.0.1:${address.port}/` })
  let pageReady = false
  for (let attempt = 0; attempt < 150; attempt += 1) {
    pageReady = await evaluate('typeof window.__instrumentSampleDecodePromise !== "undefined"', 10_000)
    if (pageReady) break
    await sleep(100)
  }
  assert.ok(pageReady, 'Local sample validation page initialized')
  const result = await evaluate('window.__instrumentSampleDecodePromise')
  assert.equal(result.audioNodeStarts, 0)
  assert.equal(result.mediaPlayCalls, 0)

  if (mode === 'audit') {
    assert.equal(result.revision, bankManifest.source.revision)
    assert.equal(result.programCount, 128)
    assert.equal(result.physicalRootCount, 3840)
    assert.deepEqual(result.programsWithoutAudibleRoots, [])
    if (writeCatalog) {
      const catalog = {
        schemaVersion: 1,
        sourceRevision: result.revision,
        classification: {
          decoder: 'Chromium AudioContext.decodeAudioData',
          metric: 'maximum absolute decoded waveform amplitude',
          silentAtOrBelow: silentThreshold,
          criterion: 'max(abs(channel samples)) <= 1/32768',
          rationale: 'The contrabass C4 rendition decodes as zero in Edge and as -91.0 dB mean/peak in the existing FFmpeg decoder, consistent with the MP3 codec noise floor.',
        },
        auditedPrograms: 128,
        physicalRootsPerProgram: 30,
        auditedRootCount: result.physicalRootCount,
        silentRootCount: result.silentRootCount,
        silentSamples: result.silentSamples.map(({ program, midi, sha256 }) => ({ program, midi, sha256 })),
      }
      await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
      console.log(`Wrote ${result.silentRootCount} checksum-pinned silent-root exceptions to ${path.relative(root, catalogPath)}.`)
    }
  } else {
    assert.equal(result.programCount, 128)
    assert.equal(result.decodedCount, 128)
    assert.equal(result.targetMidi, 60)
    assert.deepEqual(result.unusableSelections, [])
    assert.equal(result.guitarProgramsDecoded, 8)
    assert.equal(result.guitarWaveformsFiniteAndNonempty, true)
    const contrabass = result.selectedRoots.find(({ program }) => program === 43)
    assert.equal(contrabass?.name, 'contrabass')
    assert.equal(contrabass?.midi, 57, 'Contrabass C4 must route to the nearest usable root, A3/MIDI 57')
  }

  console.log(JSON.stringify(result, null, 2))
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    try {
      await cdpCall('Browser.close', {}, 5_000)
    } catch {
      socket.close()
    }
  }
  if (browser) {
    await waitForBrowserExit(browser, 5_000)
    await stopOwnedBrowserTree(browser, profile)
    await waitForBrowserExit(browser, 1_000)
  }
  socket?.close()
  if (server.listening) await new Promise((resolve) => server.close(resolve))
  if (cdpPort) {
    let cdpClosed = false
    for (let attempt = 0; attempt < 20; attempt += 1) {
      cdpClosed = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
        signal: AbortSignal.timeout(500),
      }).then(() => false, () => true)
      if (cdpClosed) break
      await sleep(100)
    }
    if (!cdpClosed) {
      console.error('Owned browser debugging endpoint is still open after cleanup.')
      process.exitCode = 1
    }
  }
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  console.log('Instrument sample browser validation finished; owned browser, server, and profile cleaned up.')
}
