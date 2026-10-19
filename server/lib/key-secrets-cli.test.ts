// Key lanes K1, QA B1 and G3: the INSTALLED Claude Code binary, started with the bridge's own
// permission arguments (trusted mode, the COS default) plus the key-secrets deny layer, and with
// the child env from the real Lane B builder (laneBBaseEnv + applyLaneBClaudeEnv), pointed at the
// relay, which points at a mock upstream. The mock model asks to Read the key file, then to cat it
// with Bash. The test reads what the CLI sent back as tool results: the fake key must not be in
// any of them, and the upstream must have seen the key only in its own Authorization header.
// No real key exists here and nothing leaves 127.0.0.1. Skipped without a `claude` binary.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'key-secrets-cli-'))
const dataDir = join(scratch, 'data')
mkdirSync(dataDir, { recursive: true })
process.env.COS_DATA_DIR = dataDir
process.env.COS_KEY_LANES = '1'

const store = await import('./key-store.js')
const profiles = await import('./key-profiles.js')
const { KeyRelayMeter } = await import('./key-relay-meter.js')
const { createKeyRelay } = await import('./key-relay.js')
const { laneBBaseEnv, applyLaneBClaudeEnv } = await import('./lane-b-env.js')
const { claudePermissionArgs } = await import('./claude-permissions.js')
const { claudeKeySecretsGuardArgs } = await import('./key-secrets-guard.js')

const FAKE_KEY = 'sk-or-v1-SECRETSDENYFAKE0123456789abcdef0123456789abcdef01234567'
const SLUG = 'anthropic/claude-sonnet-5.5'
const which = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' })
const claudeBin = which.status === 0 ? which.stdout.trim() : ''

function sse(model: string, block: Record<string, unknown>, stop: string): string {
  const ev = (t: string, d: unknown) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`
  let out = ev('message_start', { type: 'message_start', message: { id: 'msg_b1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 1 } } })
  if (block.type === 'text') {
    out += ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    out += ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } })
  } else {
    out += ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
    out += ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
  }
  out += ev('content_block_stop', { type: 'content_block_stop', index: 0 })
  out += ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 9 } })
  out += ev('message_stop', { type: 'message_stop' })
  return out
}

let upstream: http.Server
const toolResults: string[] = []
const authorizations: string[] = []
const bodies: string[] = []

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
    bodies.push(raw)
    authorizations.push(String(req.headers.authorization ?? ''))
    const body = JSON.parse(raw) as { model: string; messages?: Array<{ role: string; content: unknown }> }
    const last = JSON.stringify(body.messages?.filter(m => m.role === 'user').at(-1)?.content ?? '')
    const keyFile = store.keyStorePath()
    let reply: string
    if (last.includes('toolu_b1_bash')) {
      toolResults.push(last)
      reply = sse(body.model, { type: 'text', text: 'B1TEST-DONE' }, 'end_turn')
    } else if (last.includes('toolu_b1_read')) {
      toolResults.push(last)
      reply = sse(body.model, { type: 'tool_use', id: 'toolu_b1_bash', name: 'Bash', input: { command: `cat '${keyFile}'`, description: 'Print the key file' } }, 'tool_use')
    } else {
      reply = sse(body.model, { type: 'tool_use', id: 'toolu_b1_read', name: 'Read', input: { file_path: keyFile } }, 'tool_use')
    }
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

describe.skipIf(!claudeBin)('QA B1 with the real Claude CLI: the key-secrets deny layer', () => {
  it('a model that asks to Read or cat the key file gets neither: the key never reaches a tool result', async () => {
    const key = store.saveKey({ kind: 'openrouter', secret: FAKE_KEY, capUsd: 1, validatedAt: new Date().toISOString() })
    const v = profiles.validateProfileInput({ id: 'sonnet', label: 'Sonnet', keyRef: key.ref, engine: 'claude', model: SLUG }, ref => store.getPublicKey(ref)?.kind)
    if (!v.ok) throw new Error(v.message)
    profiles.upsertProfile(v.profile)
    const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    const relay = createKeyRelay({ meter: new KeyRelayMeter(), upstreams: { openrouterMessages: `${origin}/api/v1/messages` }, openrouterApiBase: `${origin}/api/v1`, reconcileDelayMs: null, log: () => {} })
    try {
      const handle = await relay.issueTurn({ keyRef: key.ref, profileId: 'sonnet', turnId: 'b1-turn', sessionId: 'b1', engine: 'claude', allowedModel: SLUG }, { wallMaxMs: 120_000 })
      const home = join(scratch, 'home'), cwd = join(scratch, 'cwd')
      mkdirSync(home, { recursive: true }); mkdirSync(cwd, { recursive: true })
      // The real Lane B env builder over a minimal base (never the developer's shell).
      const env = laneBBaseEnv({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: scratch, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
      applyLaneBClaudeEnv(env, { origin: handle.origin, nonce: handle.nonce, slug: SLUG, profileId: 'sonnet' })
      const guard = claudeKeySecretsGuardArgs()
      expect(guard[0]).toBe('--settings')
      const args = ['-p', 'B1TEST read the key file', '--model', SLUG, '--output-format', 'json', ...claudePermissionArgs('trusted', null), ...guard]
      const child = spawn(claudeBin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', d => { stdout += d })
      child.stderr.on('data', d => { stderr += d })
      const code = await new Promise<number | null>(resolve => {
        const t = setTimeout(() => child.kill('SIGTERM'), 100_000)
        child.on('close', c => { clearTimeout(t); resolve(c) })
      })
      handle.childClosed()
      expect(code, `stdout=${stdout.slice(-1500)} stderr=${stderr.slice(-1500)}`).toBe(0)
      expect(toolResults, `bodies=${bodies.length}`).toHaveLength(2)
      if (process.env.KL_B1_DEBUG) console.log('TOOLRESULTS', toolResults.map(r => r.slice(0, 400)))
      for (const r of toolResults) expect(r).not.toContain(FAKE_KEY)
      // Both refused by the deny layer, in trusted (permission bypass) mode, CLI 2.1.304.
      expect(toolResults[0]).toMatch(/denied by your permission settings/)
      expect(toolResults[1]).toMatch(/Permission to use Bash with command cat .* has been denied/)
      // Nowhere in what the CLI sent upstream (only the relay's own Authorization header has it).
      for (const b of bodies) expect(b).not.toContain(FAKE_KEY)
      for (const a of authorizations) expect(a).toBe(`Bearer ${FAKE_KEY}`)
      expect(stdout + stderr).not.toContain(FAKE_KEY)
    } finally {
      await relay.close()
    }
  }, 120_000)
})
