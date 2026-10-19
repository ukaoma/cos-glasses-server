// K0-G G-server and G-journeys (plan v4 section 3.3): today's behaviour with NO key-lane
// code, recorded by booting THIS checkout's server from source under a scratch world.
//
// It imports no server module (importing them runs them). The server is a child process:
//   HOME, COS_DATA_DIR, COS_PROFILE_PATH, COS_SERVER_LOCK_DIR, TMPDIR  -> one mktemp root
//   PATH = <root>/bin:/usr/bin:/bin:/usr/sbin:/sbin, where bin/ holds fake claude, codex,
//          agent (fake-cli.cjs); COS_CLAUDE_BIN / COS_CODEX_BIN / COS_CURSOR_AGENT_BIN point
//          at the same fakes so the absolute-path candidates (/opt/homebrew/...) never win
//   COS_OLLAMA_HOST = a fake Ollama on loopback run by this process
//   PORT / HTTPS_PORT ephemeral, BIND_HOST 127.0.0.1, COS_TTS_LOCAL_DISABLE=1
//   No whisper model exists under the scratch HOME, so whisper never preflights port 8178.
// The parent env is NOT inherited: the child env is built from nothing, so a golden cannot
// depend on the operator's shell.
//
// usage:
//   node --import tsx/esm server/lib/__fixtures__/key-lanes/key-lanes-off-scenario.ts \
//        --out <file.json> [--compare <golden.json>] [--keep]
//
// Normalizations (every one is listed in the output header): the scratch root, the repo
// path and the node binary path; the three ports; ISO timestamps, dates, clock times and
// epoch-millisecond numbers; UUIDs, long hex ids and base64url tokens (first-appearance
// order); per-boot credential hashes (first-appearance order); weekday and month names
// inside prompts. Nothing else is rewritten.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..', '..')
const API_TOKEN = 'kl-golden-api-token-0000000000000000'
// P11 (K1 replay): `--key-lanes <value>` sets COS_KEY_LANES on the server, and only then is that one
// name left out of each spawn's recorded env names (the switch itself, not a code path). Without
// the flag the recording is exactly K0's.
const KEY_LANES_ARG = (() => { const i = process.argv.indexOf('--key-lanes'); return i >= 0 ? process.argv[i + 1] : undefined })()

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const s = createNetServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => res(port))
    })
  })
}

// ------------------------------------------------------------------ normalizer
class Normalizer {
  private maps = new Map<string, Map<string, string>>()
  addLiteral(lit: string, rep: string): void {
    if (!lit || this.literals.some(([l]) => l === lit)) return
    this.literals.push([lit, rep])
    this.literals.sort((a, b) => b[0].length - a[0].length)
  }
  constructor(private literals: Array<[string, string]>) {
    // Longest first, so a path inside another path is replaced as the longer one.
    this.literals.sort((a, b) => b[0].length - a[0].length)
  }
  // Ids become a constant per kind, not a numbered token: background callers interleave
  // with the journeys, so first-appearance numbering would depend on scheduling.
  private token(kind: string, _raw: string): string {
    return `<${kind}>`
  }
  text(s: string): string {
    let out = s
    for (const [lit, rep] of this.literals) if (lit) out = out.split(lit).join(rep)
    out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, m => this.token('UUID', m.toLowerCase()))
    out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>')
    out = out.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<DATE>')
    out = out.replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\b/gi, '<TIME>')
    out = out.replace(/\b1[6-9]\d{11}\b/g, '<EPOCH_MS>')
    out = out.replace(/\b1[6-9]\d{8}\b/g, '<EPOCH_S>')
    out = out.replace(/\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b/g, '<WEEKDAY>')
    out = out.replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/g, '<MONTH>')
    out = out.replace(/\b[0-9a-f]{24,}\b/gi, m => this.token('HEX', m.toLowerCase()))
    // 8-hex run and session ids (`claude-1a2b3c4d`, `"sessionId": "1a2b3c4d"`).
    out = out.replace(/(?<![0-9A-Za-z])[0-9a-f]{8}(?![0-9A-Za-z])/g, m => this.token('ID8', m))
    // mkdtemp suffixes (`/tmp/cos-glasses-output-images-AbC123`).
    out = out.replace(/((?:\/private)?\/tmp\/[A-Za-z0-9._-]*-)[A-Za-z0-9]{6}(?![A-Za-z0-9])/g, '$1<MKDTEMP>')
    out = out.replace(/(?<![\w-])_?[A-Za-z0-9_-]{40,}(?![\w-])/g, m => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? this.token('B64', m) : m))
    return out
  }
  value(v: unknown): unknown {
    if (typeof v === 'string') return this.text(v)
    if (typeof v === 'number') {
      if (v > 1.6e12 && v < 2e12) return '<EPOCH_MS>'
      if (v > 1.6e9 && v < 2e9) return '<EPOCH_S>'
      return v
    }
    if (Array.isArray(v)) return v.map(x => this.value(x))
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {}
      for (const k of Object.keys(v as object).sort()) o[this.text(k)] = this.value((v as Record<string, unknown>)[k])
      return o
    }
    return v
  }
  credential(hash: string): string { return this.token('CRED', hash) }
}

// Fields whose VALUE is a measurement of this run (latency, uptime, memory, load), not
// behaviour. Their presence and type are kept; the number is replaced.
const MEASUREMENT_KEY = /^(uptime\w*|\w*(Ms|_ms|Seconds|_s|Sec)|\w*[Ll]atency\w*|elapsed\w*|duration\w*|rss|heap\w*|external|arrayBuffers|cpu\w*|load\w*|memory\w*|freeMem\w*|totalMem\w*|pid|ppid|age\w*|lastSeen\w*|bytes\w*|size\w*|mtime\w*|count|\w*Bytes)$/
function maskMeasurements(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskMeasurements)
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      o[k] = typeof x === 'number' && MEASUREMENT_KEY.test(k) ? '<MEASURED>' : maskMeasurements(x)
    }
    return o
  }
  return v
}

// ------------------------------------------------------------------ scratch world
interface World {
  root: string
  home: string
  data: string
  bin: string
  log: string
  profile: string
}

function makeWorld(): World {
  const base = argOf('--scratch-base') ?? tmpdir()
  mkdirSync(base, { recursive: true })
  const root = realpathSync(mkdtempSync(join(base, 'kl-off-')))
  const w: World = {
    root,
    home: join(root, 'home'),
    data: join(root, 'data'),
    bin: join(root, 'bin'),
    log: join(root, 'spawn-log'),
    profile: join(root, 'profile', '.cos-profile.json'),
  }
  // The lock dir is NOT created: the server's instance lock is the mkdir of it.
  for (const d of [w.home, w.data, w.bin, w.log, join(root, 'tmp'), dirname(w.profile)]) mkdirSync(d, { recursive: true })
  const shim = join(HERE, 'fake-cli.cjs')
  for (const name of ['claude', 'codex', 'agent']) {
    const p = join(w.bin, name)
    // A node shebang, not /bin/sh: a shell wrapper would add PWD and SHLVL to the env
    // the fake records, which the server never set.
    writeFileSync(p, `#!${process.execPath}\nprocess.argv.splice(2, 0, ${JSON.stringify(name)})\nrequire(${JSON.stringify(shim)})\n`)
    chmodSync(p, 0o755)
  }
  return w
}

// ------------------------------------------------------------------ fake Ollama
interface OllamaRecord { method: string; path: string; body: unknown }
function startFakeOllama(records: OllamaRecord[]): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      let body: unknown = raw
      try { body = raw ? JSON.parse(raw) : null } catch { /* keep text */ }
      records.push({ method: req.method ?? '', path: req.url ?? '', body })
      const url = req.url ?? ''
      res.setHeader('content-type', 'application/json')
      if (url.startsWith('/api/version')) { res.end(JSON.stringify({ version: '0.12.0' })); return }
      if (url.startsWith('/api/tags')) {
        res.end(JSON.stringify({ models: [{ name: 'golden:latest', model: 'golden:latest', size: 1, digest: 'd'.repeat(64), details: { family: 'golden', parameter_size: '1B', quantization_level: 'Q4' } }] }))
        return
      }
      if (url.startsWith('/api/show')) { res.end(JSON.stringify({ capabilities: ['completion'], details: { family: 'golden' }, model_info: {} })); return }
      if (url.startsWith('/api/ps')) { res.end(JSON.stringify({ models: [] })); return }
      if (url.startsWith('/api/chat') || url.startsWith('/api/generate')) {
        res.setHeader('content-type', 'application/x-ndjson')
        res.write(`${JSON.stringify({ model: 'golden:latest', message: { role: 'assistant', content: 'Golden answer.' }, done: false })}\n`)
        res.end(`${JSON.stringify({ model: 'golden:latest', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 })}\n`)
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'not found' }))
    })
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>(c => server.close(() => c())),
  })))
}

// ------------------------------------------------------------------ server process
function serverEnv(w: World, ports: { http: number; https: number; ollama: number }): NodeJS.ProcessEnv {
  return {
    HOME: w.home,
    USER: 'golden',
    LOGNAME: 'golden',
    SHELL: '/bin/sh',
    LANG: 'en_US.UTF-8',
    TZ: 'America/Chicago',
    // `<root>/opt/homebrew/bin` (which does not exist) satisfies the PATH "repair" in
    // prompt-edit.ts and g2-ops-handoff.ts (`PATH.includes('/opt/homebrew/bin')`), which
    // would otherwise PREPEND the real /opt/homebrew/bin and run the installed claude.
    PATH: `${w.bin}:${join(w.root, 'opt', 'homebrew', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: join(w.root, 'tmp'),
    COS_DATA_DIR: w.data,
    COS_PROFILE_PATH: w.profile,
    COS_SERVER_LOCK_DIR: join(w.root, 'lock'),
    PORT: String(ports.http),
    HTTPS_PORT: String(ports.https),
    BIND_HOST: '127.0.0.1',
    COS_API_TOKEN: API_TOKEN,
    COS_CLAUDE_BIN: join(w.bin, 'claude'),
    COS_CODEX_BIN: join(w.bin, 'codex'),
    COS_CURSOR_AGENT_BIN: join(w.bin, 'agent'),
    COS_OLLAMA_HOST: `http://127.0.0.1:${ports.ollama}`,
    COS_TTS_LOCAL_DISABLE: '1',
    KL_FAKE_CLI_LOG: w.log,
    ...(KEY_LANES_ARG !== undefined ? { COS_KEY_LANES: KEY_LANES_ARG } : {}),
  }
}

async function bootServer(w: World, env: NodeJS.ProcessEnv): Promise<{ proc: ChildProcess; output: () => string }> {
  let output = ''
  const proc = spawn(process.execPath, ['--import', 'tsx/esm', 'server/index.ts'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stdout!.on('data', c => { output += c })
  proc.stderr!.on('data', c => { output += c })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server exited ${proc.exitCode}\n${output.slice(-4000)}`)
    try {
      const r = await fetch(`http://127.0.0.1:${env.PORT}/api/health`, { headers: { 'X-Cos-Token': API_TOKEN } })
      if (r.status === 200) return { proc, output: () => output }
    } catch { /* not yet */ }
    await sleep(250)
  }
  proc.kill('SIGKILL')
  throw new Error(`server never became healthy\n${output.slice(-4000)}`)
}

async function stopServer(proc: ChildProcess): Promise<number | null> {
  if (proc.exitCode !== null) return proc.exitCode
  proc.kill('SIGTERM')
  const deadline = Date.now() + 20_000
  while (proc.exitCode === null && proc.signalCode === null && Date.now() < deadline) await sleep(100)
  if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGKILL'); await sleep(200) }
  return proc.exitCode
}

/** Quiet = no new fake-CLI record and no new Ollama request for `quietMs`. */
async function quiesce(w: World, ollama: OllamaRecord[], quietMs = 2500, maxMs = 30_000): Promise<void> {
  const start = Date.now()
  let last = -1
  let since = Date.now()
  while (Date.now() - start < maxMs) {
    const n = readdirSync(w.log).length + ollama.length
    if (n !== last) { last = n; since = Date.now() }
    else if (Date.now() - since >= quietMs) return
    await sleep(200)
  }
}

// ------------------------------------------------------------------ HTTP helpers
interface Reply { status: number; contentType: string; body: unknown }
async function call(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = { 'X-Cos-Token': API_TOKEN }): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]
  let parsed: unknown = text
  if (contentType === 'application/json') { try { parsed = JSON.parse(text) } catch { /* keep text */ } }
  else if (contentType === 'text/event-stream') parsed = parseSse(text)
  return { status: res.status, contentType, body: parsed }
}

function parseSse(text: string): unknown[] {
  const events: unknown[] = []
  for (const block of text.split(/\n\n/)) {
    const lines = block.split('\n').filter(Boolean)
    if (!lines.length || lines.every(l => l.startsWith(':'))) continue
    let event = 'message'
    const data: string[] = []
    for (const l of lines) {
      if (l.startsWith('event:')) event = l.slice(6).trim()
      else if (l.startsWith('data:')) data.push(l.slice(5).trim())
    }
    let payload: unknown = data.join('\n')
    try { payload = JSON.parse(data.join('\n')) } catch { /* text */ }
    events.push({ event, data: payload })
  }
  return events
}

// ------------------------------------------------------------------ trees
function tree(dir: string, base = dir): Array<{ path: string; type: string; sha256?: string; mode?: string }> {
  if (!existsSync(dir)) return []
  const out: Array<{ path: string; type: string; sha256?: string; mode?: string }> = []
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    const st = lstatSync(p)
    const rel = relative(base, p)
    if (st.isDirectory()) { out.push({ path: rel, type: 'dir', mode: (st.mode & 0o777).toString(8) }); out.push(...tree(p, base)) }
    else if (st.isSymbolicLink()) out.push({ path: rel, type: 'symlink' })
    else out.push({ path: rel, type: 'file', mode: (st.mode & 0o777).toString(8), sha256: sha256(readFileSync(p)) })
  }
  return out
}

// ------------------------------------------------------------------ scenario
const MODELS = ['opus', 'fable', 'sonnet', 'haiku', 'codex-frontier', 'codex-balanced', 'cursor-grok', 'cursor-composer', 'ollama'] as const

const ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/api/health'],
  ['GET', '/api/base-health'],
  ['GET', '/api/models'],
  ['GET', '/api/stt-settings'],
  ['GET', '/api/transcript-cleanup/settings'],
  ['GET', '/api/decision-provider'],
  ['GET', '/api/meeting-ask/config'],
  ['GET', '/api/session-hooks/status'],
  ['GET', '/api/handoffs/latest'],
  ['GET', '/api/sessions/recent'],
  ['GET', '/api/key-lanes/status'],
  ['POST', '/api/key-lanes/enable', {}],
]

export async function runScenario(): Promise<{ result: Record<string, unknown>; world: World }> {
  const w = makeWorld()
  const ollamaRecords: OllamaRecord[] = []
  const ollama = await startFakeOllama(ollamaRecords)
  const ports = { http: await freePort(), https: await freePort(), ollama: ollama.port }
  const env = serverEnv(w, ports)
  const norm = new Normalizer([
    [w.root, '<ROOT>'],
    [REPO, '<REPO>'],
    [process.execPath, '<NODE>'],
    [`127.0.0.1:${ports.http}`, '127.0.0.1:<PORT>'],
    [`127.0.0.1:${ports.https}`, '127.0.0.1:<HTTPS_PORT>'],
    [`127.0.0.1:${ports.ollama}`, '127.0.0.1:<OLLAMA_PORT>'],
    [`:${ports.http}`, ':<PORT>'],
    [`:${ports.https}`, ':<HTTPS_PORT>'],
    [`:${ports.ollama}`, ':<OLLAMA_PORT>'],
    [API_TOKEN, '<API_TOKEN>'],
  ])
  const result: Record<string, unknown> = {}
  let booted: Awaited<ReturnType<typeof bootServer>>
  try { booted = await bootServer(w, env) } catch (error) { await ollama.close(); throw error }
  const { proc, output } = booted
  let exitCode: number | null = null
  try {
    await quiesce(w, ollamaRecords)
    // Boot-time catalogs (Cursor `agent models`, Codex app-server) settle asynchronously;
    // read the routes only once /api/health stops changing and reports nothing unresolved.
    {
      let prev = ''
      let same = 0
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const h = await call(ports.http, 'GET', '/api/health')
        const text = JSON.stringify(norm.value(maskMeasurements(h.body)))
        if (text === prev && !/unresolved/i.test(text)) { if (++same >= 2) break } else same = 0
        prev = text
        await sleep(500)
      }
    }
    const bootSpawns = readdirSync(w.log).filter(n => n.startsWith('spawn-')).length
    const bootOllama = ollamaRecords.length

    // ---- routes
    const routes: Record<string, unknown> = {}
    for (const [method, path, body] of ROUTES) {
      const r = await call(ports.http, method, path, body)
      routes[`${method} ${path}`] = { status: r.status, contentType: r.contentType, body: maskMeasurements(r.body) }
    }
    const v1NoAuth = await call(ports.http, 'GET', '/v1/models', undefined, {})
    const v1Bearer = await call(ports.http, 'GET', '/v1/models', undefined, { Authorization: `Bearer ${API_TOKEN}` })
    const v1Cos = await call(ports.http, 'GET', '/v1/models', undefined, { 'X-Cos-Token': API_TOKEN })
    routes['GET /v1/models (no auth)'] = { status: v1NoAuth.status, body: v1NoAuth.body }
    routes['GET /v1/models (Bearer)'] = { status: v1Bearer.status, body: v1Bearer.body }
    routes['GET /v1/models (X-Cos-Token)'] = { status: v1Cos.status, body: v1Cos.body }
    const unauth = await call(ports.http, 'GET', '/api/models', undefined, {})
    routes['GET /api/models (no auth)'] = { status: unauth.status, body: unauth.body }
    result.routes = routes

    // ---- journeys: one ask per provider slot, then a resume turn on the same session
    const journeys: Record<string, unknown> = {}
    for (const model of MODELS) {
      const sessionId = `kl-golden-${model}`
      const before = readdirSync(w.log).length
      const first = await call(ports.http, 'POST', '/api/query', { query: `Golden question for ${model}.`, sessionId, model })
      await quiesce(w, ollamaRecords, 800, 15_000)
      const second = await call(ports.http, 'POST', '/api/query', { query: `Golden follow-up for ${model}.`, sessionId, model })
      await quiesce(w, ollamaRecords, 800, 15_000)
      const spawned = readdirSync(w.log).filter(n => n.startsWith('spawn-')).sort().slice(Math.max(0, before - 1))
      journeys[`ask+resume ${model}`] = {
        ask: { status: first.status, events: first.body },
        resume: { status: second.status, events: second.body },
        newSpawnFiles: spawned.length,
      }
    }
    // Durable job path (the G2 ask path) and its steer route.
    // Effort variants: the effort flags are part of the argv the regression matrix pins.
    for (const [model, effort] of [['sonnet', 'max'], ['codex-frontier', 'xhigh']] as const) {
      const r = await call(ports.http, 'POST', '/api/query', { query: `Golden effort question for ${model}.`, sessionId: `kl-golden-effort-${model}`, model, effort })
      await quiesce(w, ollamaRecords, 800, 15_000)
      journeys[`ask ${model} effort ${effort}`] = { status: r.status, events: r.body }
    }
    const job = await call(ports.http, 'POST', '/api/query-jobs', { clientJobId: '11111111-1111-4111-8111-111111111111', generation: 1, query: 'Golden durable question.', sessionId: 'kl-golden-job', model: 'sonnet' })
    const jobId = (job.body as { job?: { jobId?: string }; jobId?: string })?.job?.jobId ?? (job.body as { jobId?: string })?.jobId
    journeys['query-job sonnet'] = { status: job.status, body: job.body }
    if (jobId) {
      for (let i = 0; i < 60; i++) {
        const s = await call(ports.http, 'GET', `/api/query-jobs/${jobId}?generation=1`)
        const status = (s.body as { job?: { status?: string } })?.job?.status
        if (status && !['accepted', 'starting', 'running', 'queued'].includes(status)) break
        await sleep(250)
      }
      await quiesce(w, ollamaRecords, 800, 15_000)
      const snap = await call(ports.http, 'GET', `/api/query-jobs/${jobId}?generation=1`)
      journeys['query-job sonnet snapshot'] = { status: snap.status, body: maskMeasurements(snap.body) }
      const steer = await call(ports.http, 'POST', `/api/query-jobs/${jobId}/steer`, { clientSteerId: 'kl-golden-steer-1', text: 'Golden steer.' })
      journeys['query-job steer after completion'] = { status: steer.status, body: steer.body }
    }
    // Continue (attach), Fork and handoff routes against sessions COS does not know: the
    // refusal bodies are today's behaviour for those entry points.
    for (const provider of ['claude', 'codex', 'cursor']) {
      const t = `00000000-0000-4000-8000-99999999999${provider.length}`
      journeys[`attachability ${provider}`] = await call(ports.http, 'GET', `/api/agent-sessions/${provider}/${t}/attachability`)
      journeys[`attach ${provider}`] = await call(ports.http, 'POST', `/api/agent-sessions/${provider}/${t}/attach`, { cosSessionId: 'kl-golden-sonnet' })
      journeys[`fork ${provider}`] = await call(ports.http, 'POST', `/api/agent-sessions/${provider}/${t}/fork`, { cosSessionId: 'kl-golden-sonnet', prompt: 'Golden fork.' })
    }
    journeys['handoff create'] = await call(ports.http, 'POST', '/api/handoffs', { sessionId: 'kl-golden-sonnet', summary: 'Golden handoff.' })
    // The handoff code is a random 8-character id: normalized like the other ids.
    const code = ((journeys['handoff create'] as Reply).body as { context?: { code?: string } })?.context?.code
    if (code) norm.addLiteral(code, '<HANDOFF_CODE>')
    journeys['handoff latest'] = await call(ports.http, 'GET', '/api/handoffs/latest')
    journeys['prompt-edit'] = await call(ports.http, 'POST', '/api/prompt-edit', { draftText: 'golden promt to tidy', editInstruction: 'fix the spelling' })
    await quiesce(w, ollamaRecords, 800, 15_000)
    // Background callers reachable from a route without meeting audio.
    journeys['lens-gist config'] = await call(ports.http, 'GET', '/api/lens-gist/config')
    journeys['lens-gist'] = await call(ports.http, 'POST', '/api/lens-gist', { kind: 'session', sessionId: 'kl-golden-sonnet' })
    await quiesce(w, ollamaRecords, 800, 15_000)
    journeys['live-cues status'] = await call(ports.http, 'GET', '/api/live-cues/status')
    journeys['live-cues v2 settings'] = await call(ports.http, 'GET', '/api/live-cues/v2/settings')
    journeys['archive now'] = await call(ports.http, 'POST', '/api/archive/now', {})
    await quiesce(w, ollamaRecords, 800, 15_000)
    await quiesce(w, ollamaRecords)
    for (const k of Object.keys(journeys)) journeys[k] = maskMeasurements(journeys[k])
    result.journeys = journeys
    result.bootCounts = { fakeCliSpawns: bootSpawns, ollamaRequests: bootOllama }
  } finally {
    exitCode = await stopServer(proc)
    await ollama.close()
  }
  result.serverExit = { code: exitCode }

  // ---- spawn records, in a canonical order (background callers may interleave)
  const recs = readdirSync(w.log).filter(n => n.startsWith('spawn-')).sort()
    .map(n => JSON.parse(readFileSync(join(w.log, n), 'utf8')) as Record<string, unknown>)
  const normRecs = recs.map(r => {
    const creds: Record<string, string> = {}
    for (const [k, h] of Object.entries((r.credentialHashes ?? {}) as Record<string, string>)) {
      if (KEY_LANES_ARG !== undefined && k === 'COS_KEY_LANES') continue
      creds[k] = h === sha256(API_TOKEN) ? '<sha256(API_TOKEN)>' : '<per-boot-secret>'
    }
    return {
      name: r.name,
      argv: norm.value(r.argv),
      cwd: norm.text(String(r.cwd)),
      envNames: KEY_LANES_ARG !== undefined ? (r.envNames as string[]).filter(n => n !== 'COS_KEY_LANES') : r.envNames,
      credentialHashes: creds,
      // QA G1: the prompt is compared, not masked: sha256 of the normalized stdin text.
      // 80 bits, written so the id normalizers below leave it alone (they mask 24+ hex runs).
      stdinSha256: typeof r.stdinText === 'string' ? `sha256:${sha256(norm.text(r.stdinText)).slice(0, 20)}` : null,
      stdinBytes: typeof r.stdinText === 'string' ? norm.text(r.stdinText).length : null,
      stdinMode: r.stdinMode,
    }
  })
  const key = (r: unknown) => JSON.stringify(r)
  result.spawns = normRecs.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
  result.spawnCount = normRecs.length
  result.ollamaRequests = (norm.value(ollamaRecords) as OllamaRecord[]).slice().sort((a, b) => (key(a) < key(b) ? -1 : 1))

  // ---- files touched: names and modes only for files whose bytes carry timestamps/ids;
  // the tree itself (which files exist) is the zero-impact surface.
  const shape = (entries: ReturnType<typeof tree>) => entries.map(e => ({ path: norm.text(e.path), type: e.type, mode: e.mode }))
  result.dataTree = shape(tree(w.data))
  // Writes that ignore COS_DATA_DIR land in the package's own server/data (handoffs,
  // Cursor and Ollama run ledgers, Cursor model cache, TTS cache): recorded, since they
  // are part of what a no-key boot touches.
  result.packageDataTree = shape(tree(join(REPO, 'server', 'data')))
  result.homeTree = shape(tree(w.home))
  result.claudeHomeHashes = tree(join(w.home, '.claude')).map(e => ({ path: norm.text(e.path), type: e.type, sha256: e.sha256 ? sha256(norm.text(readFileSync(join(w.home, '.claude', e.path), 'utf8'))) : undefined }))
  result.codexHomeHashes = tree(join(w.home, '.codex')).map(e => ({ path: norm.text(e.path), type: e.type, sha256: e.sha256 ? sha256(norm.text(readFileSync(join(w.home, '.codex', e.path), 'utf8'))) : undefined }))
  result.serverLogTail = undefined
  void output

  const normalized = norm.value(result) as Record<string, unknown>
  return { result: normalized, world: w }
}

const HEADER = {
  schema: 'key-lanes-off/1',
  golden: 'G-server + G-journeys (plan v4 3.3)',
  normalizations: [
    'scratch root -> <ROOT>; repo path -> <REPO>; node binary -> <NODE>',
    'ports: HTTP -> <PORT>, HTTPS -> <HTTPS_PORT>, fake Ollama -> <OLLAMA_PORT>',
    'fixed test API token -> <API_TOKEN>',
    'ISO timestamps -> <TS>; YYYY-MM-DD -> <DATE>; clock times -> <TIME>; epoch ms/s numbers and digit strings -> <EPOCH_MS>/<EPOCH_S>',
    'weekday and month names -> <WEEKDAY>/<MONTH> (prompts carry the date)',
    'the random handoff code -> <HANDOFF_CODE>',
    'UUIDs -> <UUID>, hex ids of 24+ chars -> <HEX>, isolated 8-hex run/session ids -> <ID8>, 40+ char base64url tokens -> <B64> (constant per kind: background callers interleave, so numbering would depend on scheduling)',
    'mkdtemp suffixes under /tmp -> <MKDTEMP>',
    'credential-shaped env values: the fixed API token hash is named <sha256(API_TOKEN)>; every other value is minted per boot (hook and image tokens) -> <per-boot-secret>',
    'numeric fields named like measurements (uptime, *Ms, latency, duration, memory, pid, size, bytes, count, age) -> <MEASURED>',
    'stdin: sha256 and length of the stdin text AFTER the normalizations above (so prompt and history changes fail the replay); stdin mode kept',
    'spawn records and Ollama requests sorted canonically (background callers interleave)',
    'data and HOME trees: path, type and mode only; ~/.claude and ~/.codex files: sha256 of the normalized text',
  ],
}

async function main(): Promise<void> {
  const outPath = argOf('--out')
  const compare = argOf('--compare')
  const keep = process.argv.includes('--keep')
  const head = (await import('node:child_process')).execFileSync('git', ['-C', REPO, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim()
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }
  const pkgData = join(REPO, 'server', 'data')
  if (existsSync(pkgData) && readdirSync(pkgData).length > 0) {
    if (!process.argv.includes('--clean-package-data')) {
      throw new Error(`${pkgData} is not empty. The server writes handoffs and run ledgers there regardless of COS_DATA_DIR, so a golden needs it empty. Pass --clean-package-data in a scratch worktree to remove it before and after.`)
    }
  }
  if (process.argv.includes('--clean-package-data')) rmSync(pkgData, { recursive: true, force: true })
  const { result, world } = await runScenario()
  if (process.argv.includes('--clean-package-data')) rmSync(pkgData, { recursive: true, force: true })
  const doc = { ...HEADER, sourceSha: head, sourceVersion: pkg.version, ...result }
  const text = `${JSON.stringify(doc, null, 2)}\n`
  if (outPath) writeFileSync(outPath, text)
  if (!keep) rmSync(world.root, { recursive: true, force: true })
  else console.error(`scratch kept at ${world.root}`)
  if (compare) {
    // The build identity (sha, version) is the one thing a replay is expected to change:
    // a K1 candidate is a different commit and version. Everything else must match.
    const body = (t: string) => { const d = JSON.parse(t) as Record<string, unknown>; delete d.sourceSha; delete d.sourceVersion; return `${JSON.stringify(d, null, 2)}\n` }
    const golden = body(readFileSync(compare, 'utf8'))
    const replay = body(text)
    if (golden === replay) { console.log(`REPLAY OK: identical to ${compare} (sourceSha/sourceVersion excluded)`); return }
    const a = golden.split('\n'); const b = replay.split('\n')
    let shown = 0
    for (let i = 0; i < Math.max(a.length, b.length) && shown < 40; i++) {
      if (a[i] !== b[i]) { console.log(`line ${i + 1}\n- ${a[i]}\n+ ${b[i]}`); shown++ }
    }
    console.log('REPLAY DIFF')
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 2 })
}
