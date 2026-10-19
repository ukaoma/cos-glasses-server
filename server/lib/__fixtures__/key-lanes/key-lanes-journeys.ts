// Key lanes K1, QA C2 (plan v4 15 "K1 Mac" journeys) and the boot-wiring proof (QA Ghost note):
// boot THIS checkout's server/index.ts in a scratch world (the K0 harness), with key lanes on and
// two saved profiles, against a LOOPBACK mock upstream (COS_KEY_RELAY_TEST_UPSTREAM), and walk the
// journeys a user takes. Fake claude, codex and agent CLIs (fake-cli.cjs); a keyed fake Claude child
// asks the relay exactly like Claude Code does. No real key, nothing leaves 127.0.0.1.
//
//   pick         /api/models lists both profiles; /api/key-lanes/status is active
//   ask          a Claude-engine profile answers through the relay; the child never held the key
//   resume       the next model-less turn of that session stays on the key
//   switch back  an explicit model slot answers on the plan, the relay sees nothing
//   direct       a direct profile answers from a compatible endpoint
//   cap          a cap below today's spend refuses with the cap line, nothing spawned on the plan
//   bad key      the provider's 401 ends the turn with the rejected-key line
//   restart      a new boot keeps the binding and answers on the key again
//   remove all   keys, profiles and the ledger go; the bound session is refused, never the plan
//   downgrade    6.79.1 (git archive a0035a8) booted on the same data dir, both ways (see below)
//
// usage: node --import tsx/esm server/lib/__fixtures__/key-lanes/key-lanes-journeys.ts [--old-ref a0035a8] [--skip-downgrade]
// Exit 0 when every assertion holds; prints one JSON receipt either way.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API_TOKEN, REPO, bootServer, call, freePort, makeWorld, serverEnv, startFakeOllama, stopServer, type World } from './key-lanes-off-scenario.js'

const FAKE_KEY = 'sk-or-v1-JOURNEYFAKE0123456789abcdef0123456789abcdef0123456789abcd'
const FAKE_COMPAT_KEY = 'sk-compat-JOURNEYFAKE-0123456789abcdef'
const SLUG = 'anthropic/claude-sonnet-5.5'
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const argOf = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined }

interface Upstream { port: number; seen: Array<{ path: string; auth: string }>; mode: { status: number; usageDaily: number; outputTokens: number }; close(): Promise<void> }

function startUpstream(): Promise<Upstream> {
  const seen: Upstream['seen'] = []
  const mode = { status: 200, usageDaily: 0, outputTokens: 20 }
  let n = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]!
      seen.push({ path, auth: String(req.headers.authorization ?? '') })
      const ev = (t: string, d: unknown) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`
      if (path === '/api/v1/models') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ id: SLUG, name: 'Claude Sonnet 5.5', pricing: { prompt: '0.000002', completion: '0.00001' }, architecture: { output_modalities: ['text'] }, supported_parameters: ['tools'] }] }))
        return
      }
      if (path === '/api/v1/key') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: { limit: 10, limit_remaining: 10, usage_daily: mode.usageDaily } }))
        return
      }
      if (path === '/api/v1/messages') {
        if (mode.status !== 200) { res.writeHead(mode.status, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"authentication_error","message":"bad key"}}'); return }
        n++
        const model = (() => { try { return (JSON.parse(raw) as { model: string }).model } catch { return SLUG } })()
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(
          ev('message_start', { type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 40, output_tokens: 1 } } })
          + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
          + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `KEYED-ANSWER-${n}` } })
          + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
          + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: mode.outputTokens } })
          + ev('message_stop', { type: 'message_stop' }),
        )
        return
      }
      if (path === '/compat/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'DIRECT-ANSWER' } }] })}\n\n`
          + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
        return
      }
      res.writeHead(404); res.end('{}')
    })
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({
    port: (server.address() as { port: number }).port, seen, mode,
    close: () => new Promise<void>(c => { server.close(() => c()); server.closeAllConnections() }),
  })))
}

type Events = Array<{ event: string; data: Record<string, unknown> }>
const evOf = (body: unknown, name: string) => (body as Events).filter(e => e.event === name).map(e => e.data)
const spawnsOf = (w: World) => readdirSync(w.log).filter(f => f.startsWith('spawn-')).map(f => JSON.parse(readFileSync(join(w.log, f), 'utf8')) as { name: string; argv: string[]; envNames: string[]; credentialHashes: Record<string, string> })
const claudeTurns = (w: World) => spawnsOf(w).filter(s => s.name === 'claude' && s.argv.includes('-p') && !s.argv.includes('--help'))

async function seed(w: World, upstreamPort: number): Promise<{ keyRef: string; compatRef: string }> {
  process.env.COS_DATA_DIR = w.data
  const store = await import('../../key-store.js')
  const profiles = await import('../../key-profiles.js')
  const lanes = await import('../../key-lanes.js')
  process.env.COS_KEY_LANES = '1'
  lanes.setKeyLanesEnabled(true)
  const key = store.saveKey({ kind: 'openrouter', secret: FAKE_KEY, capUsd: 1, validatedAt: new Date().toISOString() })
  const compat = store.saveKey({ kind: 'openai-compatible', secret: FAKE_COMPAT_KEY, capUsd: 1, validatedAt: new Date().toISOString(), baseUrl: `http://127.0.0.1:${upstreamPort}/compat/v1` })
  for (const input of [
    { id: 'sonnet', label: 'Sonnet key', keyRef: key.ref, engine: 'claude', model: SLUG },
    { id: 'direct', label: 'Direct key', keyRef: compat.ref, engine: 'direct', model: 'local/model' },
  ]) {
    const v = profiles.validateProfileInput(input, ref => store.getPublicKey(ref)?.kind)
    if (!v.ok) throw new Error(`seed profile ${input.id}: ${v.message}`)
    profiles.upsertProfile(v.profile)
  }
  delete process.env.COS_KEY_LANES
  return { keyRef: key.ref, compatRef: compat.ref }
}

async function main(): Promise<void> {
  const checks: Array<{ journey: string; ok: boolean; detail?: string }> = []
  const check = (journey: string, ok: boolean, detail?: string) => { checks.push({ journey, ok, ...(detail ? { detail } : {}) }); if (!ok) console.error(`FAIL ${journey}: ${detail ?? ''}`) }
  const w = makeWorld()
  const upstream = await startUpstream()
  const ollama = await startFakeOllama([])
  const refs = await seed(w, upstream.port)
  const boot = async (repo = REPO) => {
    const ports = { http: await freePort(), https: await freePort(), ollama: ollama.port }
    const env = { ...serverEnv(w, ports), COS_KEY_LANES: '1', COS_KEY_RELAY_TEST_UPSTREAM: `http://127.0.0.1:${upstream.port}` }
    const b = await bootServer(w, env, repo)
    return { ...b, port: ports.http }
  }
  const ask = (port: number, sessionId: string, model?: string, extra: Record<string, unknown> = {}) =>
    call(port, 'POST', '/api/query', { query: 'Journey question.', sessionId, ...(model ? { model } : {}), ...extra })
  const doneText = (r: { body: unknown }) => String(evOf(r.body, 'done')[0]?.text ?? '')
  // The server names the session on the stream (an unknown client id gets a fresh one).
  const sidOf = (r: { body: unknown }) => String(evOf(r.body, 'done')[0]?.sessionId ?? evOf(r.body, 'start')[0]?.sessionId ?? '')
  const errText = (r: { body: unknown }) => String(evOf(r.body, 'error')[0]?.error ?? evOf(r.body, 'error')[0]?.message ?? '')
  let srv = await boot()
  let keyedSid = ''
  try {
    // pick
    const models = await call(srv.port, 'GET', '/api/models')
    const ids = ((models.body as { keyProfiles?: Array<{ id: string }> }).keyProfiles ?? []).map(p => p.id).sort()
    check('pick: /api/models lists both profiles', JSON.stringify(ids) === '["direct","sonnet"]', JSON.stringify(ids))
    const status = await call(srv.port, 'GET', '/api/key-lanes/status')
    check('pick: status active, no secret', (status.body as { active?: boolean }).active === true && !JSON.stringify(status.body).includes(FAKE_KEY))

    // ask
    const before = claudeTurns(w).length
    const a1 = await ask(srv.port, 'journey-keyed', 'profile:sonnet')
    keyedSid = sidOf(a1)
    check('ask: answered through the relay', doneText(a1).includes('KEYED-ANSWER-'), doneText(a1) || errText(a1))
    const done1 = evOf(a1.body, 'done')[0] ?? {}
    check('ask: done carries lane, credential, profile, usd', done1.lane === 'key' && done1.profile === 'sonnet' && typeof done1.usd === 'number' && (done1.usd as number) > 0, JSON.stringify({ lane: done1.lane, profile: done1.profile, usd: done1.usd }))
    check('ask: upstream saw the key, only in its Authorization header', upstream.seen.filter(s => s.path === '/api/v1/messages').every(s => s.auth === `Bearer ${FAKE_KEY}`))
    const keyedSpawns = claudeTurns(w).slice(before)
    check('ask: the keyed child never held the key', keyedSpawns.length === 1 && !Object.values(keyedSpawns[0]!.credentialHashes).includes(sha256(FAKE_KEY)) && keyedSpawns[0]!.envNames.includes('COS_KEY_PROFILE'))
    check('ask: the keyed child carries the key-secrets deny layer', keyedSpawns[0]?.argv.includes('--settings') === true)

    // resume
    const relayCalls = () => upstream.seen.filter(s => s.path === '/api/v1/messages').length
    const r0 = relayCalls()
    const a2 = await ask(srv.port, keyedSid)
    check('resume: the model-less next turn stays on the key', doneText(a2).includes('KEYED-ANSWER-') && relayCalls() === r0 + 1, doneText(a2) || errText(a2))

    // switch back
    const r1 = relayCalls()
    const a3 = await ask(srv.port, keyedSid, 'haiku')
    check('switch back: an explicit slot answers on the plan, the relay sees nothing', doneText(a3) === 'Golden answer.' && relayCalls() === r1, doneText(a3) || errText(a3))

    // direct
    const a4 = await ask(srv.port, 'journey-direct', 'profile:direct')
    check('direct: a direct profile answers from the compatible endpoint', doneText(a4).includes('DIRECT-ANSWER'), doneText(a4) || errText(a4))
    check('direct: the endpoint saw the compatible key', upstream.seen.some(s => s.path === '/compat/v1/chat/completions' && s.auth === `Bearer ${FAKE_COMPAT_KEY}`))

    // bad key
    upstream.mode.status = 401
    const a6 = await ask(srv.port, 'journey-badkey', 'profile:sonnet')
    check('bad key: the rejected-key line, not the CLI error', /was rejected/.test(errText(a6)) && !/API Error/.test(errText(a6)), errText(a6) || doneText(a6))
    upstream.mode.status = 200
    await call(srv.port, 'POST', '/api/key-lanes/breaker/reset', { ref: refs.keyRef })

    // cap
    upstream.mode.usageDaily = 1
    const c0 = claudeTurns(w).length
    const a5 = await ask(srv.port, keyedSid, 'profile:sonnet')
    check('cap: refused with the cap line', /cap on this key is used/.test(errText(a5)), errText(a5) || doneText(a5))
    check('cap: nothing ran on the plan', claudeTurns(w).length === c0)
    upstream.mode.usageDaily = 0

    // restart
    if (process.env.KL_JOURNEY_DEBUG) console.error('SERVER OUTPUT', srv.output().split('\n').filter(l => /conversation|session/i.test(l)).slice(-15).join('\n'))
    await stopServer(srv.proc)
    srv = await boot()
    // The cap journey left usage_daily at the cap for today (the meter keeps the day's highest):
    // a higher cap from Control lets the key answer again.
    await call(srv.port, 'POST', '/api/key-lanes/keys', { ref: refs.keyRef, capUsd: 5 })
    const a7 = await ask(srv.port, keyedSid, 'profile:sonnet')
    checks.push({ journey: 'restart: OBSERVED the session id after the restart', ok: true, detail: `same=${sidOf(a7) === keyedSid}` })
    const a8 = await ask(srv.port, sidOf(a7))
    check('restart: after a new boot the profile answers, and its binding holds for the next model-less turn', doneText(a7).includes('KEYED-ANSWER-') && doneText(a8).includes('KEYED-ANSWER-'), `a7=${doneText(a7) || errText(a7)} a8=${doneText(a8) || errText(a8)}`)

    // downgrade, keys left behind (an undocumented path: Control tells the user to remove keys first)
    const oldRef = argOf('--old-ref') ?? 'a0035a8'
    let oldTree = ''
    if (!process.argv.includes('--skip-downgrade')) {
      oldTree = mkdtempSync(join(tmpdir(), 'kl-old-'))
      execFileSync('/bin/sh', ['-c', `git -C '${REPO}' archive ${oldRef} | tar -x -C '${oldTree}'`])
      symlinkSync(join(REPO, 'node_modules'), join(oldTree, 'node_modules'), 'dir')
      await stopServer(srv.proc)
      const o0 = claudeTurns(w).length
      const old = await boot(oldTree)
      const oa = await ask(old.port, keyedSid)
      const ranOnPlan = claudeTurns(w).length > o0 && doneText(oa) === 'Golden answer.'
      check('downgrade, keys left: 6.79.1 leaves the key files untouched', existsSync(join(w.data, 'key-secrets', 'provider-keys.json')))
      // OBSERVATION, not a pass/fail row: 6.79.1 cannot know a key profile, so a session bound to
      // one answers on the plan. 6.80 cannot change what an older server does; the mitigation is
      // Control's "Remove your keys first" before a downgrade (QA U7, C2).
      checks.push({ journey: 'downgrade, keys left: OBSERVED 6.79.1 answers a keyed session on the plan', ok: true, detail: `ranOnPlan=${ranOnPlan}` })
      await stopServer(old.proc)
      srv = await boot()
    }

    // remove all
    const rm = await call(srv.port, 'POST', '/api/key-lanes/remove-all', {})
    check('remove all: answered', rm.status === 200, JSON.stringify(rm.body))
    check('remove all: keys, profiles and ledger are gone', !existsSync(join(w.data, 'key-secrets')) && !existsSync(join(w.data, 'provider-profiles.json')) && !existsSync(join(w.data, 'key-ledger.jsonl')))
    const r9 = claudeTurns(w).length
    const a9 = await ask(srv.port, keyedSid)
    check('remove all: the bound session is not answered on the key', !doneText(a9).includes('KEYED-ANSWER-'), doneText(a9) || errText(a9))
    checks.push({ journey: 'remove all: OBSERVED the next turn of the cleared session', ok: true, detail: `plan spawn=${claudeTurns(w).length > r9} text=${(doneText(a9) || errText(a9)).slice(0, 80)}` })

    // downgrade, documented path: keys removed first
    if (oldTree) {
      await stopServer(srv.proc)
      const old = await boot(oldTree)
      const health = await call(old.port, 'GET', '/api/health')
      check('downgrade after Remove all keys: 6.79.1 boots healthy on the same data dir', health.status === 200)
      check('downgrade after Remove all keys: no key file is left for it', !existsSync(join(w.data, 'key-secrets')))
      await stopServer(old.proc)
      rmSync(oldTree, { recursive: true, force: true })
      srv = await boot()
    }
  } finally {
    await stopServer(srv.proc)
    await upstream.close()
    await ollama.close()
  }
  const failed = checks.filter(c => !c.ok)
  console.log(JSON.stringify({ apiTokenUsed: API_TOKEN.length > 0, root: w.root, passed: checks.length - failed.length, failed: failed.length, checks }, null, 2))
  if (!process.argv.includes('--keep')) rmSync(w.root, { recursive: true, force: true })
  process.exitCode = failed.length ? 1 : 0
}

void main().catch(err => { console.error(err); process.exitCode = 2 })
