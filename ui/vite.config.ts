import react from '@vitejs/plugin-react'
import { execFile as execFileCallback } from 'node:child_process'
import { delimiter, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

const execFile = promisify(execFileCallback)
const root = fileURLToPath(new URL('..', import.meta.url))
const providers = new Set(['commons', 'mutopia', 'archive', 'bitmidi', 'freemidi'])
const pythonSearch = [
  'import json, sys',
  'from mizan import midi_search as m',
  'p = json.loads(sys.argv[1])',
  "search = {'commons': m.search_commons, 'mutopia': m.search_mutopia, 'archive': m.search_archive, 'bitmidi': m.search_bitmidi, 'freemidi': m.search_freemidi}[p['provider']]",
  "result = search(p['query'], p['startAt']) if p['provider'] == 'mutopia' else search(p['query'])",
  "results, next_start = result if p['provider'] == 'mutopia' else (result, None)",
  "fields = ('id', 'dedupeKey', 'provider', 'source', 'title', 'artist', 'license', 'licenseUrl', 'attribution', 'sourceUrl')",
  "print(json.dumps({'ok': True, 'results': [{key: item.get(key) for key in fields} for item in results], 'nextStart': next_start}))",
].join('; ')

function liveMidiSearch(): Plugin {
  return {
    name: 'mizan-dev-live-midi-search',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
        if (pathname !== '/__dev/midi-search') return next()
        const json = (status: number, value: unknown) => {
          response.statusCode = status
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify(value))
        }
        if (request.method !== 'POST') {
          json(405, { ok: false, error: { code: 'method_not_allowed', message: 'Use POST for MIDI search.' } })
          return
        }

        let raw = ''
        for await (const chunk of request) {
          raw += chunk.toString()
          if (Buffer.byteLength(raw) > 4096) {
            json(413, { ok: false, error: { code: 'invalid_search', message: 'The MIDI search request is too large.' } })
            return
          }
        }

        let input
        try {
          input = JSON.parse(raw)
        } catch {
          json(400, { ok: false, error: { code: 'invalid_search', message: 'The MIDI search request is invalid.' } })
          return
        }
        if (!input || !providers.has(input.provider) || typeof input.query !== 'string'
          || input.query.length > 200 || input.query.includes('\0')
          || (input.provider === 'mutopia'
            ? !Number.isInteger(input.startAt) || input.startAt < 0 || input.startAt > 10000 || input.startAt % 10 !== 0
            : input.startAt !== 0)) {
          json(400, { ok: false, error: { code: 'invalid_search', message: 'Use a query of at most 200 characters.' } })
          return
        }

        const interpreter = process.env.MIZAN_DEV_MIDI_PYTHON
          || resolve(root, 'host', process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python')
        try {
          const { stdout } = await execFile(interpreter, ['-c', pythonSearch, JSON.stringify(input)], {
            cwd: root,
            env: { ...process.env, PYTHONPATH: [resolve(root, 'host'), process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
            timeout: 20000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
          })
          json(200, JSON.parse(stdout))
        } catch (error) {
          server.config.logger.error('Live MIDI search failed.', {
            error: error instanceof Error ? error : new Error(String(error)),
          })
          json(200, {
            ok: false,
            error: {
              code: 'midi_search_failed',
              message: 'MIDI search is unavailable right now.',
              fix: 'Check your connection, then try again.',
            },
          })
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), liveMidiSearch()],
})
