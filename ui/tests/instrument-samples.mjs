import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createManifest,
  expectedRootMidis,
  noteToMidi,
  parseSoundfontScript,
  verifyInstalledSamples,
  AUDIBILITY_CATALOG_SHA256,
} from '../scripts/install-instrument-samples.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const sampleRoot = path.join(repositoryRoot, 'ui', 'public', 'samples', 'fluidr3')
const installerPath = path.join(repositoryRoot, 'ui', 'scripts', 'install-instrument-samples.mjs')
const validMp3Base64 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00]).toString('base64')

function scriptFor(slug, body) {
  return [
    "if (typeof(MIDI) === 'undefined') var MIDI = {};",
    "if (typeof(MIDI.Soundfont) === 'undefined') MIDI.Soundfont = {};",
    `MIDI.Soundfont.${slug} = {${body}}`,
  ].join('\n')
}

test('converts standard note spellings to MIDI numbers', () => {
  assert.equal(noteToMidi('C4'), 60)
  assert.equal(noteToMidi('A0'), 21)
  assert.equal(noteToMidi('C#4'), 61)
  assert.equal(noteToMidi('Db4'), 61)
  assert.equal(noteToMidi('Eb4'), 63)
  assert.equal(noteToMidi('B#3'), 60)
  assert.equal(noteToMidi('Cb4'), 59)
  assert.throws(() => noteToMidi('H4'), /Invalid MIDI note/)
  assert.throws(() => noteToMidi('C-2'), /out of range/)
  assert.deepEqual(expectedRootMidis().slice(0, 3), [21, 24, 27])
  assert.equal(expectedRootMidis().length, 30)
  assert.equal(expectedRootMidis().at(-1), 108)
})

test('parses only literal MP3 note data and never executes source code', () => {
  const samples = parseSoundfontScript(
    scriptFor('acoustic_guitar_nylon', `"A0": "data:audio/mp3;base64,${validMp3Base64}",`),
    'acoustic_guitar_nylon',
  )
  assert.deepEqual([...samples.keys()], [21])

  globalThis.__sampleParserCodeExecution = false
  const executable = `${scriptFor('acoustic_guitar_nylon', `"A0": "data:audio/mp3;base64,${validMp3Base64}",`)}; globalThis.__sampleParserCodeExecution = true`
  assert.throws(() => parseSoundfontScript(executable, 'acoustic_guitar_nylon'), /Unexpected or executable/)
  assert.equal(globalThis.__sampleParserCodeExecution, false)
  delete globalThis.__sampleParserCodeExecution
})

test('rejects unexpected assignments, malformed objects, duplicates, non-MP3 values, and invalid base64', () => {
  const dataUri = `data:audio/mp3;base64,${validMp3Base64}`
  assert.throws(
    () => parseSoundfontScript(scriptFor('acoustic_guitar_steel', `"A0": "${dataUri}"`), 'acoustic_guitar_nylon'),
    /Expected assignment/,
  )
  assert.throws(() => parseSoundfontScript('process.exit(1)', 'acoustic_guitar_nylon'), /Unexpected or executable/)
  assert.throws(
    () => parseSoundfontScript(scriptFor('acoustic_guitar_nylon', `"A0": "${dataUri}" "C1": "${dataUri}"`), 'acoustic_guitar_nylon'),
    /Expected comma/,
  )
  assert.throws(
    () => parseSoundfontScript(scriptFor('acoustic_guitar_nylon', `"A0": "${dataUri}", "A0": "${dataUri}"`), 'acoustic_guitar_nylon'),
    /Duplicate MIDI note/,
  )
  assert.throws(
    () => parseSoundfontScript(scriptFor('acoustic_guitar_nylon', `"A0": "data:audio/wav;base64,${validMp3Base64}"`), 'acoustic_guitar_nylon'),
    /Non-MP3 data URI/,
  )
  assert.throws(
    () => parseSoundfontScript(scriptFor('acoustic_guitar_nylon', '"A0": "data:audio/mp3;base64,%%%%"'), 'acoustic_guitar_nylon'),
    /Invalid base64/,
  )
  assert.throws(
    () => parseSoundfontScript(scriptFor('acoustic_guitar_nylon', `"A0": "data:audio/mp3;base64,${Buffer.from('not mp3').toString('base64')}"`), 'acoustic_guitar_nylon'),
    /Non-MP3 audio data/,
  )
})

test('manifest generation is deterministic', () => {
  const programs = [
    {
      program: 1,
      name: 'bright_acoustic_piano',
      samples: [{ midi: 24, buffer: Buffer.from([0xff, 0xfb, 0x90, 0x64]) }],
      missingMidi: expectedRootMidis().filter((midi) => midi !== 24),
    },
    {
      program: 0,
      name: 'acoustic_grand_piano',
      samples: [{ midi: 21, buffer: Buffer.from([0xff, 0xfb, 0x90, 0x64]) }],
      missingMidi: expectedRootMidis().filter((midi) => midi !== 21),
    },
  ]
  assert.deepEqual(createManifest(programs), createManifest(programs))
  assert.deepEqual(createManifest(programs).instruments.map(({ program }) => program), [0, 1])
})

test('installed manifest accounts for all programs and every available root has verified MP3 data', async () => {
  const summary = await verifyInstalledSamples(sampleRoot)
  const manifest = JSON.parse(await readFile(path.join(sampleRoot, 'manifest.json'), 'utf8'))
  assert.equal(summary.programCount, 128)
  assert.equal(summary.sampleCount, 3840)
  assert.equal(summary.silentCount, 207)
  assert.equal(summary.audibleSampleCount, 3633)
  assert.equal(summary.missingCount, 0)
  assert.equal(manifest.instruments.length, 128)
  assert.equal(manifest.source.license, 'CC BY 3.0 US')
  assert.equal(manifest.source.licenseUrl, 'https://creativecommons.org/licenses/by/3.0/us/')
  assert.equal(manifest.source.attribution, 'FluidR3 soundfont: Frank Wen (Copyright © 2000–2002, 2008); Toby Smithe (Copyright © 2008); Fluid contributors named in the original README. MIDI.js MP3 rendering by gleitz/midi-js-soundfonts')
  assert.equal(manifest.source.originalCopyright, 'Copyright © 2000–2002, 2008 Frank Wen; Copyright © 2008 Toby Smithe')
  assert.match(manifest.source.originalContributors, /Suren M\. Seron.*Ethan Winer/)
  assert.match(manifest.source.originalSoundfontLicense, /MIT.*CC BY 3\.0 US/)
  assert.deepEqual(manifest.instruments.map(({ program }) => program), Array.from({ length: 128 }, (_, i) => i))
  assert.equal(new Set(manifest.instruments.map(({ name }) => name)).size, 128)
  for (const instrument of manifest.instruments) {
    const present = new Set(instrument.samples.map(({ midi }) => midi))
    const missing = new Set(instrument.missingMidi ?? [])
    for (const midi of expectedRootMidis()) assert.notEqual(present.has(midi), missing.has(midi))
    for (const sample of instrument.samples) {
      const audio = await readFile(path.join(sampleRoot, instrument.name, `${sample.midi}.mp3`))
      assert.equal(audio.length, sample.bytes)
      assert.match(sample.sha256, /^[a-f0-9]{64}$/)
      assert.ok(audio.subarray(0, 3).toString('ascii') === 'ID3' || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0))
    }
  }
})

test('audibility catalog is pinned, complete, and leaves every GM program with a usable root', async () => {
  const catalogPath = path.join(repositoryRoot, 'ui', 'scripts', 'fluidr3-audibility.json')
  const catalogBytes = await readFile(catalogPath)
  const catalog = JSON.parse(catalogBytes.toString('utf8'))
  assert.equal(createHash('sha256').update(catalogBytes).digest('hex'), AUDIBILITY_CATALOG_SHA256)
  assert.equal(catalog.schemaVersion, 1)
  assert.equal(catalog.sourceRevision, '044fab8e1456bfafc5776e86dfd6bb8697149aef')
  assert.equal(catalog.classification.silentAtOrBelow, 1 / 32768)
  assert.equal(catalog.auditedPrograms, 128)
  assert.equal(catalog.physicalRootsPerProgram, 30)
  assert.equal(catalog.auditedRootCount, 3840)
  assert.equal(catalog.silentRootCount, 207)
  assert.equal(catalog.silentSamples.length, 207)

  const manifest = JSON.parse(await readFile(path.join(sampleRoot, 'manifest.json'), 'utf8'))
  const exceptions = new Map(catalog.silentSamples.map((sample) => [`${sample.program}:${sample.midi}`, sample]))
  let usableRootCount = 0
  for (const instrument of manifest.instruments) {
    assert.equal(instrument.samples.length, 30)
    const usable = instrument.samples.filter((sample) => sample.silent !== true)
    assert.ok(usable.length > 0, `${instrument.name} has no usable roots`)
    usableRootCount += usable.length
    for (const sample of instrument.samples) {
      const exception = exceptions.get(`${instrument.program}:${sample.midi}`)
      if (exception) {
        assert.equal(sample.silent, true)
        assert.equal(sample.sha256, exception.sha256)
      } else {
        assert.equal(sample.silent, undefined)
      }
    }
  }
  assert.equal(usableRootCount, 3633)

  const contrabass = manifest.instruments[43]
  assert.equal(contrabass.name, 'contrabass')
  assert.equal(contrabass.samples.find((sample) => sample.midi === 60).silent, true)
  const nearest = contrabass.samples
    .filter((sample) => sample.silent !== true)
    .sort((a, b) => Math.abs(a.midi - 60) - Math.abs(b.midi - 60) || a.midi - b.midi)[0]
  assert.equal(nearest.midi, 57)
})

test('license record identifies the upstream US license and legal code', async () => {
  const license = await readFile(path.join(repositoryRoot, 'licenses', 'samples-fluidr3-gm.txt'), 'utf8')
  assert.match(license, /https:\/\/creativecommons\.org\/licenses\/by\/3\.0\/us\//)
  assert.match(license, /https:\/\/creativecommons\.org\/licenses\/by\/3\.0\/us\/legalcode/)
  assert.match(license, /Copyright © 2000–2002, 2008 Frank Wen/)
  assert.match(license, /Copyright © 2008 Toby Smithe/)
  assert.match(license, /Fluid contributors \(quoted from its README\)/)
  assert.match(license, /Original Fluid MIT notice \(for the underlying soundfont only\)/)
  assert.match(license, /These rendition assets\s+remain under the linked CC BY 3\.0 US license; they are not relabeled MIT/)
})

test('guitar programs 24–31 use distinct samples from the piano program', async () => {
  const manifest = JSON.parse(await readFile(path.join(sampleRoot, 'manifest.json'), 'utf8'))
  const piano = new Map(manifest.instruments[0].samples.map((sample) => [sample.midi, sample.sha256]))
  for (const instrument of manifest.instruments.slice(24, 32)) {
    assert.ok(instrument.name.includes('guitar'), `Expected a guitar program, received ${instrument.name}`)
    assert.ok(instrument.samples.length > 0)
    for (const sample of instrument.samples) {
      assert.notEqual(sample.sha256, piano.get(sample.midi), `${instrument.name} MIDI ${sample.midi} reused the piano sample`)
    }
  }
})

test('offline CLI verification succeeds without fetching the pinned source', () => {
  const result = spawnSync(process.execPath, [installerPath, '--verify'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Verified \d+ FluidR3 GM samples for 128 programs/)
})

test('installer rerun verifies a complete installation without rewriting assets', () => {
  const result = spawnSync(process.execPath, [installerPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /already installed and verified: 3840 samples/)
})
