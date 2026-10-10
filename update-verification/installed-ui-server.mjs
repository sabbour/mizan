import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const root = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Pass the exact installed package UI directory')
const html = await readFile(resolve(root, 'index.html'), 'utf8')
if (!html.includes('<div id="root">')) throw new Error('The selected directory is not a built Mizan UI')
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wav': 'audio/wav',
}
createServer(async (request, response) => {
  if (request.method !== 'GET') { response.writeHead(405).end(); return }
  let path
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
    path = resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1))
    if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return }
    const file = await stat(path)
    if (!file.isFile()) { response.writeHead(404).end(); return }
    response.writeHead(200, {
      'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
      'Content-Length': file.size, 'Cache-Control': 'no-store',
    })
    createReadStream(path).on('error', (error) => {
      console.error('Installed UI file read failed', path, error)
      response.destroy(error)
    }).pipe(response)
  } catch (error) {
    if (error.code === 'ENOENT') { response.writeHead(404).end(); return }
    console.error('Installed UI request failed', path, error)
    response.writeHead(500).end('Installed UI verification server error')
  }
}).listen(5398, '127.0.0.1', () => console.log(`Installed UI verification ready: ${root}`))
