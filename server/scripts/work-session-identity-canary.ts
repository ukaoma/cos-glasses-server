// Isolated end-to-end gate for the server detail route and compiled Control helper.
// Usage: node --import tsx/esm server/scripts/work-session-identity-canary.ts /absolute/path/to/cos-control-helper
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import express from 'express'

const helper = process.argv[2]
assert(helper && isAbsolute(helper), 'An existing compiled helper absolute path is required')
const root = mkdtempSync('/tmp/cos-fork-roundtrip-')
const parent = '11111111-2222-4333-8444-555555555555'
const child = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const unknown = '99999999-2222-4333-8444-555555555555'
const token = 'c'.repeat(64)
const key = `task:quilt:${'a'.repeat(12)}`
// Set all isolated roots before route dependencies initialize their stores.
process.env.COS_DATA_DIR = join(root, 'server-data')
process.env.COS_AGENT_SESSIONS_HOME = root
process.env.CODEX_HOME = join(root, '.codex')
delete process.env.COS_SCRIPTS_DIR
delete process.env.CODEX_THREAD_ID
delete process.env.CLAUDE_SESSION_ID
const rollouts = join(root, '.codex/sessions/2026/10/13')
mkdirSync(rollouts, { recursive: true })
mkdirSync(join(root, '.cos-glasses'), { mode: 0o700 })
writeFileSync(join(root, '.cos-glasses/.env'), `COS_API_TOKEN=${token}\n`, { mode: 0o600 })
const meta = { type: 'session_meta', payload: { id: parent, cwd: '/repo/quilt', timestamp: new Date().toISOString() } }
const reply = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })
for (const [id, text] of [[parent, 'Parent result'], [child, 'Child recovery result']]) {
  writeFileSync(join(rollouts, `rollout-2026-10-13T21-45-00-${id}.jsonl`), [meta, reply(text)].map(row => JSON.stringify(row)).join('\n') + '\n')
}
const { agentSessionsRouter } = await import('../routes/agent-sessions.js')
const app = express()
app.use((req, res, next) => {
  if (req.get('X-COS-Token') !== token) { res.status(401).json({ error: 'authentication_required' }); return }
  next()
})
app.get('/api/work-board', (_req, res) => res.json({
  tasks: [{ id: 'b'.repeat(12), domain: 'quilt', title: 'Quilt recovery', text: 'Quilt recovery context',
    workIdentity: 'a'.repeat(12), workRevision: 'd'.repeat(64), workStage: 'planned', checked: false,
    doneWhen: 'User reviewed the result', source: 'Manual entry', workMetadataError: '', meetingRefs: [] }],
  capabilities: { version: 1, writable: true },
}))
app.use('/api', agentSessionsRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>(resolve => server.once('listening', resolve))
const port = (server.address() as AddressInfo).port
const env = { ...process.env, COS_CONTROL_TEST_HOME: root, COS_CONTROL_TEST_API_PORT: String(port), COS_WORK_FIXTURE_TEST: '1' }
const run = async (native: string) => {
  let stdout: string
  try {
    ({ stdout } = await promisify(execFile)(helper, ['work-link-session', '--work-id', key, '--session-id', `codex:${native}`, '--expected-link', 'none'], { env, timeout: 20_000 }))
  } catch (error) {
    // A deliberate refusal exits 1 and still emits the structured helper result.
    const failure = error as { code?: unknown; stdout?: unknown; killed?: boolean }
    if (failure.code !== 1 || failure.killed || typeof failure.stdout !== 'string') throw error
    stdout = failure.stdout
  }
  return JSON.parse(stdout) as { ok: boolean; details?: { sessionID?: string } }
}
try {
  const response = await fetch(`http://127.0.0.1:${port}/api/agent-sessions/codex/${child}`, { headers: { 'X-COS-Token': token } })
  assert.equal(response.status, 200)
  const detail = await response.json() as { session_id: string; latest_reply: string }
  assert.equal(detail.session_id, child)
  assert.equal(detail.latest_reply, 'Child recovery result')
  const result = await run(child)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.details?.sessionID, `codex:${child}`)
  const links = join(root, 'work-handoffs/handoffs.session-cards.json')
  const before = readFileSync(links, 'utf8')
  const persisted = JSON.parse(before) as Record<string, { workID: string }>
  assert.equal(persisted[`codex:${child}`].workID, key)
  assert.equal(persisted[`codex:${parent}`], undefined)
  assert.equal((await run(unknown)).ok, false)
  assert.equal(readFileSync(links, 'utf8'), before, 'Unknown session must not alter associations')
  console.log(JSON.stringify({ ok: true, childDetailIdentity: child, compiledHelperAcceptedChild: true, unknownSessionRefused: true, parentNotAssociated: true }))
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  rmSync(root, { recursive: true, force: true })
}
