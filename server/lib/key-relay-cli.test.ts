// Key lanes P2 (plan v4 4.7 "Real CLI"): the installed Claude Code binary, pointed at the relay,
// with the relay pointed at a local mock Anthropic upstream. No real key exists here: the "real"
// key is a fake saved in a temp key store, and nothing leaves 127.0.0.1.
//
// What it pins:
//   - the upstream saw the saved key (and only it) on every request the CLI made;
//   - the child's own environment, as its Bash tool prints it, holds the nonce and not the key;
//   - one Agent (Task) subagent call, asked for `haiku` with no haiku env mapping, arrives at the
//     upstream as the profile slug because the relay rewrote it (the 4.4 backstop).
// Skipped when no `claude` binary is installed (CI); on the Mac it runs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'key-relay-cli-'))
const dataDir = join(scratch, 'data')
mkdirSync(dataDir, { recursive: true })
process.env.COS_DATA_DIR = dataDir
process.env.COS_KEY_LANES = '1'

const store = await import('./key-store.js')
const profiles = await import('./key-profiles.js')
const ledger = await import('./key-ledger.js')
const { KeyRelayMeter } = await import('./key-relay-meter.js')
const { createKeyRelay } = await import('./key-relay.js')
const { KEY_LANE_CHILD_ENV, RELAY_BASE_PATHS } = await import('./key-relay-contract.js')

const FAKE_KEY = 'sk-or-v1-CLIRELAYFAKE0123456789abcdef0123456789abcdef0123456789ab'
const SLUG = 'anthropic/claude-sonnet-5.5'

const which = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' })
const claudeBin = which.status === 0 ? which.stdout.trim() : ''

interface Upstream { model: string; authorization: string; kind: string; body: string }

function sseText(model: string, text: string): string {
  return sseEvents(model, [{ type: 'text', text }], 'end_turn')
}

function sseTool(model: string, id: string, name: string, input: unknown): string {
  return sseEvents(model, [{ type: 'tool_use', id, name, input }], 'tool_use')
}

function sseEvents(model: string, blocks: Array<Record<string, unknown>>, stop: string): string {
  const ev = (t: string, d: unknown) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`
  let out = ev('message_start', { type: 'message_start', message: { id: 'msg_cli', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 1 } } })
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      out += ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      out += ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } })
    } else {
      out += ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
      out += ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
    }
    out += ev('content_block_stop', { type: 'content_block_stop', index })
  })
  out += ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 9 } })
  out += ev('message_stop', { type: 'message_stop' })
  return out
}

function lastUserText(body: { messages?: Array<{ role: string; content: unknown }> }): string {
  return JSON.stringify(body.messages?.filter(m => m.role === 'user').at(-1)?.content ?? '')
}

function firstUserText(body: { messages?: Array<{ role: string; content: unknown }> }): string {
  return JSON.stringify(body.messages?.find(m => m.role === 'user')?.content ?? '')
}

let upstream: http.Server
const seen: Upstream[] = []
let envSeenByTool = ''

beforeAll(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const path = (req.url ?? '').split('?')[0]
    if (req.method !== 'POST' || !path.endsWith('/messages')) {
      res.writeHead(path.endsWith('/count_tokens') ? 200 : 404, { 'content-type': 'application/json' })
      res.end(path.endsWith('/count_tokens') ? '{"input_tokens":10}' : '{}')
      return
    }
    const body = JSON.parse(raw) as { model: string; messages?: Array<{ role: string; content: unknown }> }
    const last = lastUserText(body)
    const first = firstUserText(body)
    let kind = 'other'
    let reply: string
    if (first.includes('RELAYTEST-SUB')) {
      kind = 'subagent'
      reply = sseText(body.model, 'sub done')
    } else if (last.includes('toolu_relay_agent')) {
      kind = 'main-final'
      reply = sseText(body.model, 'all done RELAYTEST-OK')
    } else if (last.includes('toolu_relay_bash')) {
      kind = 'main-after-bash'
      envSeenByTool = last
      reply = sseTool(body.model, 'toolu_relay_agent', 'Agent', { description: 'relay sub test', prompt: 'RELAYTEST-SUB say done', subagent_type: 'general-purpose', model: 'haiku', run_in_background: false })
    } else if (first.includes('RELAYTEST-MAIN')) {
      kind = 'main-first'
      reply = sseTool(body.model, 'toolu_relay_bash', 'Bash', { command: 'env', description: 'Print environment' })
    } else {
      reply = sseText(body.model, 'ok')
    }
    seen.push({ model: body.model, authorization: String(req.headers.authorization ?? ''), kind, body: raw })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(reply)
  })
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
})

afterAll(async () => {
  await new Promise<void>(r => { upstream.close(() => r()); upstream.closeAllConnections() })
  rmSync(scratch, { recursive: true, force: true })
  delete process.env.COS_KEY_LANES
})

describe.skipIf(!claudeBin)('key relay with the real Claude CLI (plan 4.7)', () => {
  it('claude -p through the relay: upstream saw the key, the child held only the nonce, the subagent call was rewritten', async () => {
    const key = store.saveKey({ kind: 'openrouter', secret: FAKE_KEY, capUsd: 1, validatedAt: new Date().toISOString() })
    const v = profiles.validateProfileInput({ id: 'sonnet', label: 'Sonnet', keyRef: key.ref, engine: 'claude', model: SLUG }, ref => store.getPublicKey(ref)?.kind)
    if (!v.ok) throw new Error(v.message)
    profiles.upsertProfile(v.profile)

    const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    const logs: string[] = []
    const relay = createKeyRelay({
      meter: new KeyRelayMeter(),
      upstreams: { openrouterMessages: `${origin}/api/v1/messages` },
      openrouterApiBase: `${origin}/api/v1`,
      reconcileDelayMs: null,
      log: l => logs.push(l),
    })
    try {
      const handle = await relay.issueTurn(
        { keyRef: key.ref, profileId: 'sonnet', turnId: 'cli-turn', sessionId: 'cli-session', engine: 'claude', allowedModel: SLUG },
        { wallMaxMs: 120_000 },
      )
      const home = join(scratch, 'home')
      const cwd = join(scratch, 'cwd')
      mkdirSync(home, { recursive: true })
      mkdirSync(cwd, { recursive: true })
      // Plan 7.2 child env, built from scratch here (P3 owns the real builder). The haiku mapping
      // is left out on purpose so the subagent asks for a Claude id and the relay must rewrite it.
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        TMPDIR: scratch,
        [KEY_LANE_CHILD_ENV.claudeBaseUrl]: `${handle.origin}${RELAY_BASE_PATHS.claude}`,
        [KEY_LANE_CHILD_ENV.claudeToken]: handle.nonce,
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_DEFAULT_OPUS_MODEL: SLUG,
        ANTHROPIC_DEFAULT_SONNET_MODEL: SLUG,
        CLAUDE_CODE_MAX_RETRIES: '2',
        [KEY_LANE_CHILD_ENV.profileMarker]: 'sonnet',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      }
      expect(JSON.stringify(env)).not.toContain(FAKE_KEY)

      const child = spawn(claudeBin, ['-p', 'RELAYTEST-MAIN run env then one subagent', '--model', SLUG, '--output-format', 'json', '--dangerously-skip-permissions'], {
        cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', d => { stdout += d })
      child.stderr.on('data', d => { stderr += d })
      const code = await new Promise<number | null>(resolve => {
        const t = setTimeout(() => { child.kill('SIGTERM') }, 100_000)
        child.on('close', c => { clearTimeout(t); resolve(c) })
      })
      handle.childClosed()

      expect(code, `stdout=${stdout.slice(-2000)} stderr=${stderr.slice(-2000)}`).toBe(0)
      expect(stdout).toContain('RELAYTEST-OK')

      // Upstream saw the saved key on every request, and nothing else.
      expect(seen.length).toBeGreaterThanOrEqual(4)
      // (The nonce does reach the upstream once, inside the Bash tool result the model reads back;
      // it is useless off this Mac's loopback and dies with the turn.)
      for (const s of seen) expect(s.authorization).toBe(`Bearer ${FAKE_KEY}`)

      // The child's own environment (printed by its Bash tool) held the nonce, never the key.
      expect(envSeenByTool).toContain(`ANTHROPIC_AUTH_TOKEN=${handle.nonce}`)
      expect(envSeenByTool).not.toContain(FAKE_KEY)

      // Every model at the upstream is the profile slug; the subagent asked for haiku and was rewritten.
      expect(seen.map(s => s.kind)).toEqual(expect.arrayContaining(['main-first', 'main-after-bash', 'subagent', 'main-final']))
      for (const s of seen) expect(s.model).toBe(SLUG)
      const rewritten = logs.filter(l => l.includes('model rewritten'))
      expect(rewritten.some(l => /from=(claude-haiku|haiku)/i.test(l)), rewritten.join('\n')).toBe(true)

      // Every request was metered; no secret in the ledger or the logs.
      const settles = ledger.readKeyLedger().filter(r => r.kind === 'settle')
      expect(settles.length).toBe(seen.length)
      expect(readFileSync(ledger.keyLedgerPath(), 'utf8')).not.toContain(FAKE_KEY)
      expect(logs.join('\n')).not.toContain(FAKE_KEY)
      expect(stdout + stderr).not.toContain(FAKE_KEY)
    } finally {
      await relay.close()
    }
  }, 120_000)
})
