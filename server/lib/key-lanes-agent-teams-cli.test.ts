// Key lanes K1, canary R12: Miles's project `.claude/settings.json` `env` turns
// CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS back on inside a keyed turn, although the child process env
// strips it. The keyed run's flag `--settings` layer must win. Proven with the INSTALLED Claude CLI
// against the relay and a mock upstream (no real key): an env-probe PreToolUse hook in the same
// project settings file writes what the hook process sees, once without the Lane B layer (the
// probe must show 1, or this test proves nothing) and once with it (0). Skipped without `claude`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'kl-agent-teams-cli-'))
process.env.COS_DATA_DIR = join(scratch, 'data')
mkdirSync(process.env.COS_DATA_DIR, { recursive: true })
process.env.COS_KEY_LANES = '1'

const store = await import('./key-store.js')
const { KeyRelayMeter } = await import('./key-relay-meter.js')
const { createKeyRelay } = await import('./key-relay.js')
const { laneBBaseEnv, applyLaneBClaudeEnv } = await import('./lane-b-env.js')
const { claudePermissionArgs } = await import('./claude-permissions.js')
const { claudeKeySecretsGuardArgs } = await import('./key-secrets-guard.js')

const SLUG = 'anthropic/claude-sonnet-5.5'
const which = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' })
const claudeBin = which.status === 0 ? which.stdout.trim() : ''

function sse(model: string, block: Record<string, unknown>, stop: string): string {
  const ev = (t: string, d: unknown) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`
  let out = ev('message_start', { type: 'message_start', message: { id: 'msg_at', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 1 } } })
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
const cwd = join(scratch, 'cwd')
const probe = join(scratch, 'hook-env.txt')

beforeAll(async () => {
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  writeFileSync(join(cwd, 'hello.txt'), 'hello\n')
  // Miles's shape: the project file sets agent teams on, plus an env-probe hook.
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({
    env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `/bin/sh -c 'printf "%s" "$CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS" > "${probe}"'` }] }] },
  }))
  upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const path = (req.url ?? '').split('?')[0]
    if (req.method !== 'POST' || !path.endsWith('/messages')) {
      res.writeHead(path.endsWith('/count_tokens') ? 200 : 404, { 'content-type': 'application/json' })
      res.end(path.endsWith('/count_tokens') ? '{"input_tokens":10}' : '{}')
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; messages?: Array<{ role: string; content: unknown }> }
    const last = JSON.stringify(body.messages?.filter(m => m.role === 'user').at(-1)?.content ?? '')
    const reply = last.includes('toolu_at_read')
      ? sse(body.model, { type: 'text', text: 'AT-DONE' }, 'end_turn')
      : sse(body.model, { type: 'tool_use', id: 'toolu_at_read', name: 'Read', input: { file_path: join(cwd, 'hello.txt') } }, 'tool_use')
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

async function keyedRun(laneB: boolean): Promise<string> {
  rmSync(probe, { force: true })
  const key = store.saveKey({ kind: 'openrouter', secret: 'sk-or-v1-AGENTTEAMSFAKE0123456789abcdef0123456789abcdef0123', capUsd: 1, validatedAt: new Date().toISOString() })
  const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  const relay = createKeyRelay({ isActive: () => true, meter: new KeyRelayMeter(), upstreams: { openrouterMessages: `${origin}/api/v1/messages` }, openrouterApiBase: `${origin}/api/v1`, reconcileDelayMs: null, log: () => {} })
  try {
    const handle = await relay.issueTurn({ keyRef: key.ref, profileId: 'sonnet', turnId: `at-${laneB}`, sessionId: 'at', engine: 'claude', allowedModel: SLUG }, { wallMaxMs: 120_000 })
    const home = join(scratch, `home-${laneB}`); mkdirSync(home, { recursive: true })
    const env = laneBBaseEnv({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: scratch, DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
    applyLaneBClaudeEnv(env, { origin: handle.origin, nonce: handle.nonce, slug: SLUG, profileId: 'sonnet' })
    const args = ['-p', 'AT read hello', '--model', SLUG, '--output-format', 'json', ...claudePermissionArgs('trusted', null), ...claudeKeySecretsGuardArgs(laneB ? { laneB: true } : {})]
    const child = spawn(claudeBin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { out += d })
    const code = await new Promise<number | null>(resolve => { const t = setTimeout(() => child.kill('SIGTERM'), 100_000); child.on('close', c => { clearTimeout(t); resolve(c) }) })
    handle.childClosed()
    expect(code, out.slice(-1500)).toBe(0)
    expect(existsSync(probe), 'the probe hook ran').toBe(true)
    return readFileSync(probe, 'utf8')
  } finally {
    await relay.close()
  }
}

describe.skipIf(!claudeBin)('canary R12 with the real Claude CLI: the keyed layer forces agent teams off', () => {
  it('the project file turns it on without the Lane B layer (the probe works), and the Lane B layer wins', async () => {
    expect(await keyedRun(false)).toBe('1')
    expect(await keyedRun(true)).toBe('0')
  }, 200_000)
})
