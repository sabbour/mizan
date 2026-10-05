import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..', '..')
const OUTPUT_DIRECTORY = path.join(REPOSITORY_ROOT, 'ui', 'public', 'samples', 'fluidr3')
const MANIFEST_PATH = path.join(OUTPUT_DIRECTORY, 'manifest.json')
const AUDIBILITY_CATALOG_PATH = path.join(SCRIPT_DIRECTORY, 'fluidr3-audibility.json')

export const SOURCE_REVISION = '044fab8e1456bfafc5776e86dfd6bb8697149aef'
export const SOURCE_DIRECTORY = 'FluidR3_GM'
export const SOURCE_REPOSITORY = 'https://github.com/gleitz/midi-js-soundfonts'
export const RAW_SOURCE_BASE = `https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/${SOURCE_REVISION}/${SOURCE_DIRECTORY}/`
export const LICENSE_URL = 'https://creativecommons.org/licenses/by/3.0/us/'
export const ATTRIBUTION = 'FluidR3 soundfont: Frank Wen (Copyright © 2000–2002, 2008); Toby Smithe (Copyright © 2008); Fluid contributors named in the original README. MIDI.js MP3 rendering by gleitz/midi-js-soundfonts'
export const MODIFICATION = 'Selected minor-third root sample subset extracted without audio transcoding.'
export const AUDIBILITY_CATALOG_SHA256 = 'c904d1aadcff56bd6b284a609e18c2a5a2efc65f6bc2053ce4f884478603b78e'

const EXPECTED_PROGRAM_COUNT = 128
const FIRST_ROOT_MIDI = 21
const LAST_ROOT_MIDI = 108
const ROOT_STEP = 3
const MAX_INDEX_BYTES = 64 * 1024
const MAX_PROGRAM_SOURCE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_SOURCE_BYTES = 512 * 1024 * 1024
const MAX_TOTAL_SAMPLE_BYTES = 250 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 45_000
const MAX_RETRIES = 3
const CONCURRENCY = 4
const SILENT_SAMPLE_THRESHOLD = 1 / 32768
const EXPECTED_SILENT_SAMPLE_COUNT = 207
const EXPECTED_AUDITED_ROOT_COUNT = EXPECTED_PROGRAM_COUNT * ((LAST_ROOT_MIDI - FIRST_ROOT_MIDI) / ROOT_STEP + 1)

const PREVIOUS_SOURCE_METADATA = Object.freeze({
  repository: SOURCE_REPOSITORY,
  revision: SOURCE_REVISION,
  directory: SOURCE_DIRECTORY,
  indexUrl: `${RAW_SOURCE_BASE}names.json`,
  readmeUrl: `https://github.com/gleitz/midi-js-soundfonts/blob/${SOURCE_REVISION}/README.md`,
  license: 'CC BY 3.0 US',
  licenseUrl: LICENSE_URL,
  attribution: 'FluidR3 Soundfont contributors; MIDI.js rendering by gleitz/midi-js-soundfonts',
  modification: MODIFICATION,
})

const SOURCE_METADATA = Object.freeze({
  repository: SOURCE_REPOSITORY,
  revision: SOURCE_REVISION,
  directory: SOURCE_DIRECTORY,
  indexUrl: `${RAW_SOURCE_BASE}names.json`,
  readmeUrl: `https://github.com/gleitz/midi-js-soundfonts/blob/${SOURCE_REVISION}/README.md`,
  license: 'CC BY 3.0 US',
  licenseUrl: LICENSE_URL,
  attribution: ATTRIBUTION,
  modification: MODIFICATION,
  originalSoundfont: 'FluidR3_GM.sf2',
  originalCopyright: 'Copyright © 2000–2002, 2008 Frank Wen; Copyright © 2008 Toby Smithe',
  originalContributors: 'Fluid was constructed in part from samples found in the public domain that I edited/cleaned/remixed/programmed and largely from recordings of my own and in conjunction with the people below who helped along the way: Suren M. Seron Scott Hanan Steve Aupperle Chris Gillman Alex Taubr Chris Prola Andrew Klenk Winfried Hubbe Dylan Tim Gort Uros Katic Ethan Winer (http://www.ethanwiner.com)',
  originalSoundfontLicense: 'MIT for the underlying FluidR3 Soundfont; the MIDI.js MP3 renditions distributed here are CC BY 3.0 US.',
  originalCopyrightSource: 'https://sources.debian.org/data/main/f/fluid-soundfont/3.1-5.3/debian/copyright',
})

const NATURAL_PITCH_CLASSES = Object.freeze({
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
})

export function noteToMidi(note) {
  const match = /^([A-G])([#b]?)(-?\d+)$/.exec(note)
  if (!match) throw new Error(`Invalid MIDI note name: ${note}`)
  const [, letter, accidental, octaveText] = match
  const octave = Number(octaveText)
  const accidentalOffset = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0
  const midi = (octave + 1) * 12 + NATURAL_PITCH_CLASSES[letter] + accidentalOffset
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
    throw new Error(`MIDI note is out of range: ${note}`)
  }
  return midi
}

export function expectedRootMidis() {
  const roots = []
  for (let midi = FIRST_ROOT_MIDI; midi <= LAST_ROOT_MIDI; midi += ROOT_STEP) roots.push(midi)
  return roots
}

function validateSlug(slug) {
  if (typeof slug !== 'string' || !/^[a-z][a-z0-9_]*$/.test(slug)) {
    throw new Error(`Invalid GM instrument slug: ${slug}`)
  }
  return slug
}

function readQuotedString(source, start, label) {
  if (source[start] !== '"') throw new Error(`Expected a quoted ${label}`)
  const end = source.indexOf('"', start + 1)
  if (end === -1) throw new Error(`Unterminated ${label}`)
  const value = source.slice(start + 1, end)
  if (value.includes('\\') || /[\r\n]/.test(value)) throw new Error(`Escaped ${label} values are not supported`)
  return { value, end: end + 1 }
}

function validateMp3Base64(base64, note) {
  if (!base64 || base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error(`Invalid base64 for ${note}`)
  }
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.toString('base64') !== base64) throw new Error(`Non-canonical base64 for ${note}`)
  if (!isMp3(buffer)) throw new Error(`Non-MP3 audio data for ${note}`)
}

function isMp3(buffer) {
  return buffer.length >= 4 && (
    buffer.subarray(0, 3).toString('ascii') === 'ID3'
    || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
  )
}

export function parseSoundfontScript(source, expectedSlug) {
  validateSlug(expectedSlug)
  if (typeof source !== 'string') throw new Error('Soundfont source must be text')
  const wrapped = /^\s*if \(typeof\(MIDI\) === 'undefined'\) var MIDI = \{\};\s*if \(typeof\(MIDI\.Soundfont\) === 'undefined'\) MIDI\.Soundfont = \{\};\s*MIDI\.Soundfont\.([a-z][a-z0-9_]*) = \{\s*([\s\S]*?)\s*\};?\s*$/.exec(source)
  if (!wrapped) throw new Error(`Unexpected or executable source syntax for ${expectedSlug}`)
  if (wrapped[1] !== expectedSlug) {
    throw new Error(`Expected assignment for ${expectedSlug}; received ${wrapped[1]}`)
  }

  const body = wrapped[2]
  const samples = new Map()
  let cursor = 0
  while (cursor < body.length) {
    while (/\s/.test(body[cursor] ?? '')) cursor += 1
    if (cursor >= body.length) break

    const key = readQuotedString(body, cursor, 'note key')
    cursor = key.end
    if (!/^([A-G])([#b]?)(-?\d+)$/.test(key.value)) {
      throw new Error(`Invalid note key in ${expectedSlug}: ${key.value}`)
    }
    while (/\s/.test(body[cursor] ?? '')) cursor += 1
    if (body[cursor] !== ':') throw new Error(`Expected colon after ${key.value} in ${expectedSlug}`)
    cursor += 1
    while (/\s/.test(body[cursor] ?? '')) cursor += 1
    const value = readQuotedString(body, cursor, 'audio value')
    cursor = value.end

    const prefix = 'data:audio/mp3;base64,'
    if (!value.value.startsWith(prefix)) throw new Error(`Non-MP3 data URI for ${expectedSlug} ${key.value}`)
    const base64 = value.value.slice(prefix.length)
    validateMp3Base64(base64, `${expectedSlug} ${key.value}`)
    const midi = noteToMidi(key.value)
    if (samples.has(midi)) throw new Error(`Duplicate MIDI note ${midi} in ${expectedSlug}`)
    samples.set(midi, { note: key.value, base64 })

    while (/\s/.test(body[cursor] ?? '')) cursor += 1
    if (cursor < body.length) {
      if (body[cursor] !== ',') throw new Error(`Expected comma after ${key.value} in ${expectedSlug}`)
      cursor += 1
    }
  }
  if (samples.size === 0) throw new Error(`No sample data found for ${expectedSlug}`)
  return samples
}

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function sampleKey(program, midi) {
  return `${program}:${midi}`
}

function validateAudibilityCatalog(catalog) {
  if (catalog?.schemaVersion !== 1 || catalog.sourceRevision !== SOURCE_REVISION) {
    throw new Error('Unsupported FluidR3 audibility catalog or source revision')
  }
  if (catalog.classification?.decoder !== 'Chromium AudioContext.decodeAudioData'
    || catalog.classification.metric !== 'maximum absolute decoded waveform amplitude'
    || catalog.classification.silentAtOrBelow !== SILENT_SAMPLE_THRESHOLD
    || catalog.classification.criterion !== 'max(abs(channel samples)) <= 1/32768') {
    throw new Error('Unexpected FluidR3 audibility classification')
  }
  if (catalog.auditedPrograms !== EXPECTED_PROGRAM_COUNT
    || catalog.physicalRootsPerProgram !== expectedRootMidis().length
    || catalog.auditedRootCount !== EXPECTED_AUDITED_ROOT_COUNT
    || catalog.silentRootCount !== EXPECTED_SILENT_SAMPLE_COUNT
    || !Array.isArray(catalog.silentSamples)
    || catalog.silentSamples.length !== EXPECTED_SILENT_SAMPLE_COUNT) {
    throw new Error('FluidR3 audibility catalog coverage is incomplete')
  }

  const roots = new Set(expectedRootMidis())
  const silentSamples = new Map()
  const perProgram = Array(EXPECTED_PROGRAM_COUNT).fill(0)
  let previousProgram = -1
  let previousMidi = -1
  for (const sample of catalog.silentSamples) {
    if (!Number.isInteger(sample.program) || sample.program < 0 || sample.program >= EXPECTED_PROGRAM_COUNT
      || !roots.has(sample.midi)
      || !/^[a-f0-9]{64}$/.test(sample.sha256)
      || sample.program < previousProgram
      || (sample.program === previousProgram && sample.midi <= previousMidi)) {
      throw new Error('Invalid or unsorted silent sample in audibility catalog')
    }
    const key = sampleKey(sample.program, sample.midi)
    if (silentSamples.has(key)) throw new Error(`Duplicate silent root in audibility catalog: ${key}`)
    silentSamples.set(key, { ...sample })
    perProgram[sample.program] += 1
    previousProgram = sample.program
    previousMidi = sample.midi
  }
  if (perProgram.some((count) => count >= expectedRootMidis().length)) {
    throw new Error('A GM program has no usable sample root in the audibility catalog')
  }
  return silentSamples
}

async function readAudibilityCatalog() {
  const bytes = await readFile(AUDIBILITY_CATALOG_PATH)
  if (digest(bytes) !== AUDIBILITY_CATALOG_SHA256) {
    throw new Error('FluidR3 audibility catalog checksum does not match the pinned audit')
  }
  const catalog = JSON.parse(bytes.toString('utf8'))
  return validateAudibilityCatalog(catalog)
}

function validInstrumentIndex(names) {
  if (!Array.isArray(names) || names.length !== EXPECTED_PROGRAM_COUNT) {
    throw new Error(`Expected ${EXPECTED_PROGRAM_COUNT} GM instrument names`)
  }
  const unique = new Set()
  for (const name of names) {
    validateSlug(name)
    if (unique.has(name)) throw new Error(`Duplicate GM instrument slug: ${name}`)
    unique.add(name)
  }
  return names
}

function expectedMissingMidis(samples) {
  return expectedRootMidis().filter((midi) => !samples.has(midi))
}

function sortedManifestProgram(program, name, samples, missingMidi) {
  const sortedSamples = samples
    .map(({ midi, buffer, silent }) => {
      const sample = {
        midi,
        url: `/samples/fluidr3/${name}/${midi}.mp3`,
        sha256: digest(buffer),
        bytes: buffer.length,
      }
      if (silent === true) sample.silent = true
      return sample
    })
    .sort((a, b) => a.midi - b.midi)
  const instrument = { program, name, samples: sortedSamples }
  if (missingMidi.length > 0) instrument.missingMidi = [...missingMidi].sort((a, b) => a - b)
  return instrument
}

export function createManifest(programs) {
  const instruments = [...programs]
    .sort((a, b) => a.program - b.program)
    .map(({ program, name, samples, missingMidi = [] }) => sortedManifestProgram(program, name, samples, missingMidi))
  return {
    schemaVersion: 1,
    source: SOURCE_METADATA,
    instruments,
  }
}

function validateManifestShape(manifest, silentCatalog) {
  if (manifest?.schemaVersion !== 1 || manifest.source?.revision !== SOURCE_REVISION) {
    throw new Error('Unsupported instrument sample manifest or source revision')
  }
  for (const [key, expected] of Object.entries(SOURCE_METADATA)) {
    if (manifest.source[key] !== expected) throw new Error(`Manifest source metadata mismatch: ${key}`)
  }
  if (!Array.isArray(manifest.instruments) || manifest.instruments.length !== EXPECTED_PROGRAM_COUNT) {
    throw new Error(`Manifest must contain ${EXPECTED_PROGRAM_COUNT} instruments`)
  }

  const roots = new Set(expectedRootMidis())
  let sampleCount = 0
  let missingCount = 0
  let totalBytes = 0
  let silentCount = 0
  const listedSilentSamples = new Set()
  for (let program = 0; program < EXPECTED_PROGRAM_COUNT; program += 1) {
    const instrument = manifest.instruments[program]
    if (instrument?.program !== program) throw new Error(`Manifest program order or coverage error at ${program}`)
    validateSlug(instrument.name)
    if (!Array.isArray(instrument.samples) || !Array.isArray(instrument.missingMidi)) {
      if (instrument.missingMidi === undefined && Array.isArray(instrument.samples)) instrument.missingMidi = []
      else throw new Error(`Invalid sample list for program ${program}`)
    }
    let lastMidi = -1
    const present = new Set()
    for (const sample of instrument.samples) {
      if (!roots.has(sample.midi) || sample.midi <= lastMidi) {
        throw new Error(`Unexpected or unsorted root sample in program ${program}`)
      }
      lastMidi = sample.midi
      if (sample.url !== `/samples/fluidr3/${instrument.name}/${sample.midi}.mp3`) {
        throw new Error(`Unexpected sample URL for program ${program}`)
      }
      if (!/^[a-f0-9]{64}$/.test(sample.sha256) || !Number.isSafeInteger(sample.bytes) || sample.bytes < 4) {
        throw new Error(`Invalid sample metadata for program ${program}, MIDI ${sample.midi}`)
      }
      const key = sampleKey(program, sample.midi)
      const silentRecord = silentCatalog.get(key)
      if (silentRecord) {
        if (sample.sha256 !== silentRecord.sha256 || sample.silent !== true) {
          throw new Error(`Silent sample marker or hash does not match the pinned audit: ${instrument.name}/${sample.midi}`)
        }
        listedSilentSamples.add(key)
        silentCount += 1
      } else if (sample.silent !== undefined) {
        throw new Error(`Unexpected silent marker in ${instrument.name}/${sample.midi}`)
      }
      present.add(sample.midi)
      sampleCount += 1
      totalBytes += sample.bytes
    }
    if (present.size - instrument.samples.filter((sample) => sample.silent === true).length < 1) {
      throw new Error(`Program ${program} has no usable sample root`)
    }
    if (present.size === 0) throw new Error(`No root samples for program ${program}`)

    const missing = new Set()
    let lastMissing = -1
    for (const midi of instrument.missingMidi) {
      if (!roots.has(midi) || midi <= lastMissing || present.has(midi)) {
        throw new Error(`Invalid missing-root list for program ${program}`)
      }
      lastMissing = midi
      missing.add(midi)
      missingCount += 1
    }
    for (const midi of roots) {
      if (present.has(midi) === missing.has(midi)) {
        throw new Error(`Program ${program} does not account for MIDI root ${midi}`)
      }
    }
  }
  if (listedSilentSamples.size !== silentCatalog.size) {
    throw new Error('Manifest does not contain every pinned silent-root marker')
  }
  return { sampleCount, missingCount, totalBytes, silentCount, audibleSampleCount: sampleCount - silentCount }
}

export async function verifyInstalledSamples(outputDirectory = OUTPUT_DIRECTORY, manifestInput, silentCatalogInput) {
  const manifestPath = path.join(outputDirectory, 'manifest.json')
  const manifest = manifestInput ?? JSON.parse(await readFile(manifestPath, 'utf8'))
  const silentCatalog = silentCatalogInput ?? await readAudibilityCatalog()
  const summary = validateManifestShape(manifest, silentCatalog)
  const files = manifest.instruments.flatMap((instrument) => (
    instrument.samples.map((sample) => ({ instrument, sample }))
  ))
  let nextFile = 0
  const verifyWorker = async () => {
    while (nextFile < files.length) {
      const { instrument, sample } = files[nextFile]
      nextFile += 1
      const filePath = path.join(outputDirectory, instrument.name, `${sample.midi}.mp3`)
      const buffer = await readFile(filePath)
      if (buffer.length !== sample.bytes || digest(buffer) !== sample.sha256 || !isMp3(buffer)) {
        throw new Error(`Sample verification failed: ${instrument.name}/${sample.midi}.mp3`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(16, files.length) }, verifyWorker))
  return { programCount: manifest.instruments.length, ...summary }
}

async function readBoundedResponse(response, maxBytes, description) {
  if (!response.ok) {
    const error = new Error(`${description} returned HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${description} exceeds the ${maxBytes}-byte response limit`)
  }
  const chunks = []
  let length = 0
  const reader = response.body?.getReader()
  if (!reader) throw new Error(`${description} has no response body`)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel()
        throw new Error(`${description} exceeds the ${maxBytes}-byte response limit`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, length)
}

function isRetryable(error) {
  return error.name === 'AbortError'
    || error.name === 'TimeoutError'
    || error.status === 408
    || error.status === 425
    || error.status === 429
    || (Number.isInteger(error.status) && error.status >= 500)
    || (!Number.isInteger(error.status) && error.name !== 'Error')
}

async function fetchBounded(url, maxBytes, description) {
  let lastError
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      return await readBoundedResponse(response, maxBytes, description)
    } catch (error) {
      lastError = error
      if (attempt === MAX_RETRIES || !isRetryable(error)) break
      const delay = Math.min(300 * (2 ** (attempt - 1)), 1500)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw new Error(`${description} failed: ${lastError?.message ?? 'unknown error'}`)
}

async function atomicWrite(destination, buffer) {
  await mkdir(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.${process.pid}.${randomUUID()}.part`
  await writeFile(temporary, buffer)
  await rename(temporary, destination)
}

async function installProgram(program, name, downloadedBytes, sampleBytes, silentCatalog) {
  const sourceUrl = `${RAW_SOURCE_BASE}${name}-mp3.js`
  const sourceBuffer = await fetchBounded(sourceUrl, MAX_PROGRAM_SOURCE_BYTES, `Program ${program} (${name})`)
  downloadedBytes.count += sourceBuffer.length
  if (downloadedBytes.count > MAX_TOTAL_SOURCE_BYTES) {
    throw new Error(`Pinned source downloads exceed the ${MAX_TOTAL_SOURCE_BYTES}-byte safety limit`)
  }
  const source = sourceBuffer.toString('utf8')
  const noteSamples = parseSoundfontScript(source, name)
  const samples = []
  for (const midi of expectedRootMidis()) {
    const entry = noteSamples.get(midi)
    if (!entry) continue
    const buffer = Buffer.from(entry.base64, 'base64')
    const silentRecord = silentCatalog.get(sampleKey(program, midi))
    const sha256 = digest(buffer)
    if (silentRecord && silentRecord.sha256 !== sha256) {
      throw new Error(`Pinned silent-root hash mismatch for ${name} MIDI ${midi}`)
    }
    samples.push({ midi, buffer, silent: Boolean(silentRecord) })
  }
  sampleBytes.count += samples.reduce((sum, sample) => sum + sample.buffer.length, 0)
  if (sampleBytes.count > MAX_TOTAL_SAMPLE_BYTES) {
    throw new Error(`Bundled samples exceed the ${MAX_TOTAL_SAMPLE_BYTES}-byte safety limit`)
  }
  for (const { midi, buffer } of samples) {
    const destination = path.join(OUTPUT_DIRECTORY, name, `${midi}.mp3`)
    let unchanged = false
    try {
      const current = await readFile(destination)
      unchanged = current.length === buffer.length && digest(current) === digest(buffer)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (!unchanged) await atomicWrite(destination, buffer)
  }
  return {
    program,
    name,
    samples,
    missingMidi: expectedMissingMidis(new Map(samples.map(({ midi }) => [midi, true]))),
  }
}

function sourceMetadataMatches(source, expected) {
  return source
    && Object.keys(source).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => source[key] === value)
}

function upgradeManifest(previous, silentCatalog) {
  if (previous?.schemaVersion !== 1) return null
  const sourceIsCurrent = sourceMetadataMatches(previous.source, SOURCE_METADATA)
  const sourceIsPrevious = sourceMetadataMatches(previous.source, PREVIOUS_SOURCE_METADATA)
  if (!sourceIsCurrent && !sourceIsPrevious) return null

  const instruments = previous.instruments.map((instrument) => ({
    ...instrument,
    samples: instrument.samples.map((sample) => {
      const record = silentCatalog.get(sampleKey(instrument.program, sample.midi))
      if (record) {
        if (record.sha256 !== sample.sha256) {
          throw new Error(`Pinned silent-root hash mismatch for ${instrument.name} MIDI ${sample.midi}`)
        }
        return { ...sample, silent: true }
      }
      if (sample.silent !== undefined) {
        throw new Error(`Unexpected silent marker for ${instrument.name} MIDI ${sample.midi}`)
      }
      return sample
    }),
  }))
  return { ...previous, source: SOURCE_METADATA, instruments }
}

async function installAll() {
  const silentCatalog = await readAudibilityCatalog()
  const existingManifest = await readFile(MANIFEST_PATH, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existingManifest) {
    try {
      const summary = await verifyInstalledSamples(OUTPUT_DIRECTORY, JSON.parse(existingManifest), silentCatalog)
      console.log(`FluidR3 GM already installed and verified: ${summary.sampleCount} samples (${summary.silentCount} marked silent), ${formatBytes(summary.totalBytes)}.`)
      return
    } catch {
      let migrated
      try {
        migrated = upgradeManifest(JSON.parse(existingManifest), silentCatalog)
      } catch {
        migrated = undefined
      }
      if (migrated) {
        try {
          const summary = await verifyInstalledSamples(OUTPUT_DIRECTORY, migrated, silentCatalog)
          await atomicWrite(MANIFEST_PATH, Buffer.from(`${JSON.stringify(migrated, null, 2)}\n`, 'utf8'))
          console.log(`Updated FluidR3 metadata and silent-root markers; verified ${summary.sampleCount} existing samples (${summary.silentCount} marked silent).`)
          return
        } catch {
          migrated = undefined
        }
      }
      if (!migrated) await rm(MANIFEST_PATH, { force: true })
    }
  }

  const namesBuffer = await fetchBounded(`${RAW_SOURCE_BASE}names.json`, MAX_INDEX_BYTES, 'GM instrument index')
  const names = validInstrumentIndex(JSON.parse(namesBuffer.toString('utf8')))
  const downloadedBytes = { count: namesBuffer.length }
  const sampleBytes = { count: 0 }
  const programs = new Array(names.length)
  let nextProgram = 0
  let completed = 0
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const program = nextProgram
      nextProgram += 1
      if (program >= names.length) return
      programs[program] = await installProgram(program, names[program], downloadedBytes, sampleBytes, silentCatalog)
      completed += 1
      if (completed % 8 === 0 || completed === names.length) {
        console.log(`Installed ${completed}/${names.length} instrument programs.`)
      }
    }
  })
  await Promise.all(workers)

  for (const [key, record] of silentCatalog) {
    const sample = programs[record.program]?.samples.find(({ midi }) => midi === record.midi)
    if (!sample || digest(sample.buffer) !== record.sha256) {
      throw new Error(`Pinned silent-root catalog entry is missing from downloaded source: ${key}`)
    }
  }

  const manifest = createManifest(programs)
  const summary = validateManifestShape(manifest, silentCatalog)
  const missingPrograms = manifest.instruments.filter((instrument) => instrument.missingMidi?.length)
  if (missingPrograms.length) {
    const count = summary.missingCount
    console.warn(`Source omitted ${count} expected root samples across ${missingPrograms.length} programs; gaps are listed in manifest.json.`)
  }
  await mkdir(OUTPUT_DIRECTORY, { recursive: true })
  await atomicWrite(MANIFEST_PATH, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))
  const verified = await verifyInstalledSamples(OUTPUT_DIRECTORY, manifest, silentCatalog)
  console.log(`Installed ${verified.sampleCount} samples for ${verified.programCount} programs (${verified.silentCount} marked silent, ${verified.audibleSampleCount} usable); ${formatBytes(verified.totalBytes)} assets, downloaded ${formatBytes(downloadedBytes.count)} of pinned source.`)
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node ui/scripts/install-instrument-samples.mjs [--verify]')
    return
  }
  if (args.length === 1 && args[0] === '--verify') {
    const summary = await verifyInstalledSamples()
    console.log(`Verified ${summary.sampleCount} FluidR3 GM samples for ${summary.programCount} programs (${summary.silentCount} marked silent, ${summary.audibleSampleCount} usable; ${formatBytes(summary.totalBytes)}).`)
    if (summary.missingCount) console.log(`${summary.missingCount} source roots are explicitly recorded as missing.`)
    return
  }
  if (args.length) throw new Error(`Unknown option: ${args.join(' ')}`)
  await installAll()
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
