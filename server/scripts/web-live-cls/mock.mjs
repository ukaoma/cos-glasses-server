// A fake COS server for rendering and measuring COS Control Web's live meeting view.
// node mock.mjs <web-control dir> <port> [initialChunks]
// Serves /control/* from the given directory and answers /api/* with a scripted live glasses meeting.
// POST /__mock/append?n=K adds K transcript chunks (and their levels). Never touches a real COS server.
import http from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'

const ROOT = process.argv[2]
const PORT = Number(process.argv[3] || 4517)
const INITIAL = Number(process.argv[4] || 150)
const SID = 'meeting_1762349349000_g2demo'
const START = Date.now() - 15 * 60 * 1000 - 9000
let seed = 7
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
const SPEAKERS = ['Miles', 'Gina', 'Graham', 'Speaker 3']
const BITS = [
  'the Liquor pacing is ahead of plan for the month', 'Jewelry demo volume dipped after the show', 'we should move the webinar to Thursday',
  'Thrift leads came in heavier than the forecast said', 'the comparison page needs the new pricing table', 'call-in volume is up about a third',
  'I want the brief before the board prep', 'that number ties to the MTD dashboard', 'can we get the persona pull for Pet by Friday',
  'the endcap photo shows the spring set', 'Silas asked for the budget variance by region', 'let us keep the test running another week',
  'opportunities are the stickler layer here', 'the form conversion moved from four to six percent', 'Ryan has the creative ready for review',
]
const chunks = []
let speaker = 'Miles'
function addChunk() {
  const i = chunks.length
  if (rnd() < 0.55) speaker = SPEAKERS[Math.floor(rnd() * SPEAKERS.length)]
  const n = 1 + Math.floor(rnd() * 3)
  const words = []
  for (let k = 0; k < n; k++) words.push(BITS[Math.floor(rnd() * BITS.length)])
  const text = words.join(', and ').replace(/^./, c => c.toUpperCase()) + '.'
  const silent = rnd() < 0.15
  chunks.push({ i, elapsedMs: i * 6000, speaker, text: silent ? '' : text, level: silent ? 0.12 : 0.35 + rnd() * 0.6, speechSec: silent ? 0.1 : 1 + rnd() * 4.5, at: Date.now() })
}
for (let k = 0; k < INITIAL; k++) addChunk()
let files = []
let rev = 0
const HISTORY_DELAY = Number(process.env.HISTORY_DELAY_MS || 0)
let mediaSeq = 0
function stamp() { return String(chunks.length) + '.' + files.length + '.' + rev }
function read(since, known, knownRev) {
  if (known === stamp() && knownRev === String(rev)) return { sessionId: SID, ended: false, unchanged: true, stamp: stamp() }
  const full = knownRev !== String(rev)
  return {
    sessionId: SID, ended: false, unchanged: false, stamp: stamp(), startTime: START, lastActivityAt: Date.now(),
    maxIndex: chunks.length - 1, settledThrough: chunks.length - 1,
    speakerRevision: rev, fullSnapshot: full,
    turns: chunks.filter(c => (full || c.i > since) && c.text).map(c => ({ i: c.i, elapsedMs: c.elapsedMs, speaker: c.speaker, text: c.text })),
    levels: chunks.slice(-120).map(c => ({ i: c.i, level: Math.round(c.level * 1000) / 1000, speechSec: Math.round(c.speechSec * 100) / 100 })),
  }
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.json': 'application/json', '.png': 'image/png' }
function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) }
function body(req) { return new Promise(r => { const parts = []; req.on('data', d => parts.push(d)); req.on('end', () => r(Buffer.concat(parts))) }) }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname
  if (p === '/__mock/append') { const n = Number(url.searchParams.get('n') || 1); for (let k = 0; k < n; k++) addChunk(); return json(res, 200, { count: chunks.length }) }
  if (p === '/__mock/rewrite') { const upto = Number(url.searchParams.get('upto') || 20); for (const c of chunks.slice(0, upto)) if (c.text) c.text += ' Corrected after the speaker pass, with a longer line than before.'; rev++; return json(res, 200, { rev }) }
  if (p === '/__mock/addfile') { files = files.concat([{ id: 'phone_m_seed' + files.length, revision: 'r1', name: 'Board deck.pdf', status: 'ready', text: 'x', origin: 'phone' }]); return json(res, 200, { files }) }
  if (p === '/__mock/state') return json(res, 200, { count: chunks.length, files })
  if (p.startsWith('/control')) {
    let rel = p.slice('/control'.length) || '/'
    if (rel === '/') rel = '/index.html'
    const full = normalize(join(ROOT, rel))
    if (!full.startsWith(normalize(ROOT)) || !existsSync(full) || statSync(full).isDirectory()) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'Content-Type': TYPES[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    return res.end(readFileSync(full))
  }
  if (!p.startsWith('/api/')) { res.writeHead(302, { Location: '/control/' }); return res.end() }
  const raw = req.method === 'GET' ? Buffer.alloc(0) : await body(req)
  let b = {}; try { b = raw.length && /json/.test(req.headers['content-type'] || '') ? JSON.parse(raw.toString('utf8')) : {} } catch { b = {} }
  if (p === '/api/web-session/status') return json(res, 200, { authenticated: true, owner: 'Miles', version: '6.99.14' })
  if (p === '/api/health') return json(res, 200, { status: 'ok', version: '6.99.14', capabilities: { liveMeeting: { protocol: 1, chunkLevels: true } } })
  if (p === '/api/meetings/live-chunks') {
    const sessions = [{ sessionId: SID, mtimeMs: Date.now(), stamp: stamp() }]
    const sid = url.searchParams.get('sessionId')
    if (!sid) return json(res, 200, { sessions })
    return json(res, 200, { sessions, read: read(Number(url.searchParams.get('since') ?? -1), url.searchParams.get('stamp'), url.searchParams.get('speakerRevision')) })
  }
  if (p.startsWith('/api/meeting/sessions/') && p.endsWith('/status')) return json(res, 200, { state: 'active' })
  if (p === '/api/meeting-ask/config') return json(res, 200, { protocolVersion: 2, serverInstanceId: 'inst-demo-1', selected: { engine: 'claude', model: 'opus' }, cosSearch: 'meaning', publicTopics: false, capabilities: {}, models: [{ engine: 'claude', model: 'opus', available: true }] })
  if (p === '/api/meeting-ask/history') { if (HISTORY_DELAY) await new Promise(r => setTimeout(r, HISTORY_DELAY)); return json(res, 200, { exchanges: [], nextOffset: null, files }) }
  if (p === '/api/meeting-ask/context') return json(res, 200, { candidates: [] })
  if (p === '/api/live-cues/history') return json(res, 200, { cues: [] })
  if (p === '/api/media/file') { const id = 'm_' + (++mediaSeq).toString(16).padStart(24, '0'); return json(res, 200, { attachment: { id, kind: 'document' } }) }
  if (p === '/api/media') { const id = 'm_' + (++mediaSeq).toString(16).padStart(24, '0'); return json(res, 200, { attachments: [{ id, kind: 'image' }] }) }
  if (p === '/api/meeting-ask/files/media') {
    for (const m of b.media || []) files = files.filter(f => f.id !== 'phone_' + m.id).concat([{ id: 'phone_' + m.id, revision: 'r1', name: m.name || m.id, status: /\.(png|jpe?g|heic)$/i.test(m.name || '') ? 'ready' : 'ready', text: 'x', origin: 'phone', ...(/\.(png|jpe?g)$/i.test(m.name || '') ? { notice: 'Image text is available. Verify small numbers and table columns.' } : {}) }])
    return json(res, 200, { files })
  }
  if (p === '/api/meetings') return json(res, 200, { meetings: [] })
  if (p === '/api/meeting/orphans') return json(res, 200, { items: [], stranded: [], recovering: [] })
  return json(res, 200, {})
})
server.listen(PORT, '127.0.0.1', () => console.log('mock on', PORT, 'root', ROOT, 'chunks', chunks.length))
