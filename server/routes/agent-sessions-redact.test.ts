/**
 * 7.0.4 S1: no absolute Mac path reaches the browser through the session detail (or the list and search that show
 * the same words). A read-only scan of 14 days found 111 Claude links and 826 Codex links carrying `/Users/...` into
 * Control Web. Real-shaped Claude and Codex transcripts, hand-written (no real content), through the real route.
 */
import express from 'express'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentSessionsRouter } from './agent-sessions.js'

const temps: string[] = []
afterAll(() => { for (const p of temps.splice(0)) rmSync(p, { recursive: true, force: true }) })
const closers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())) })

/**
 * Independent of the module under test: a person's home folder anywhere (prose or code), or a file or editor URL. Code
 * spans keep system paths and show the home folder as `[home]` (7.0.4 W5), so `/private/tmp` in backticks is allowed.
 */
const ABSOLUTE = /\/+users\/(?!shared\b)|\bfile:\/\/|\bvscode:\/\//gi
const WEB = ['https://github.com/example/repo/pull/12', 'https://example.com/docs/setup#step-2', 'http://localhost:3141/api/health']

const CLAUDE_ID = 'aaaaaaaa-1111-4222-8333-444444444444'
const CODEX_ID = '019f0000-1111-7222-8333-444444444444'
let home = ''
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cos-redact-route-')); temps.push(home)
  for (const k of ['COS_AGENT_SESSIONS_HOME', 'CODEX_HOME']) saved[k] = process.env[k]
  process.env.COS_AGENT_SESSIONS_HOME = home
  process.env.CODEX_HOME = join(home, '.codex')
})
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })

function write(path: string, rows: unknown[]) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
}
async function serve(): Promise<string> {
  const app = express(); app.use('/api', agentSessionsRouter)
  const server = await new Promise<ReturnType<typeof app.listen>>(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  closers.push(() => new Promise<void>(r => server.close(() => r())))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const t = (m: number) => `2026-11-08T12:${String(m).padStart(2, '0')}:00.000Z`
function claudeFixture() {
  const cwd = '/Users/jane/Documents/GitHub/Acme Chief Of Staff/Repo-One'
  const row = (type: 'user' | 'assistant', m: number, content: unknown[], extra: Record<string, unknown> = {}) =>
    ({ type, uuid: `${type[0]}${m}`, timestamp: t(m), cwd, sessionId: CLAUDE_ID, message: { role: type, content }, ...extra })
  write(join(home, '.claude', 'projects', '-Users-jane-Documents-GitHub-Acme-Chief-Of-Staff-Repo-One', `${CLAUDE_ID}.jsonl`), [
    row('user', 1, [{ type: 'text', text: `Fix the bug in ${cwd}/server/app.ts and read ~/Documents/plan.md` }]),
    row('assistant', 2, [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: `${cwd}/server/app.ts` } }]),
    row('user', 3, [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: `${cwd}/server/app.ts contents` }] }], { toolUseResult: { type: 'text', file: { filePath: `${cwd}/server/app.ts` } } }),
    row('assistant', 4, [{ type: 'text', text: [
      `Fixed in [app.ts](${cwd}/server/app.ts#L42) and [routes.ts:9](/Users/jane/repo/server/routes.ts:9).`,
      `Notes at /Users/jane/repo/notes.md. Logs in \`/private/tmp/build/out.log\`.`,
      `Screenshot: ![render](/private/var/folders/ab/T/render.png)`,
      `See [the PR](${WEB[0]}), ${WEB[1]} and ${WEB[2]}.`,
      'Relative: [guide](docs/guide.md) and server/lib/x.ts:12.',
      'Editor: vscode://file/Users/jane/repo/a.ts:3 and file:///Users/jane/repo/b.md',
    ].join('\n') }]),
    row('assistant', 5, [{ type: 'tool_use', id: 'tu2', name: 'SendUserFile', input: { files: [`${cwd}/out/report.pdf`, '/Users/jane/Desktop/shot.png'], caption: `Saved under ~/Desktop and ${cwd}/out`, status: 'normal' } }]),
    row('user', 6, [{ type: 'text', text: 'Thanks, now check $HOME/.config/app.json' }]),
    row('assistant', 7, [{ type: 'text', text: `Checked [app.json](</Users/jane/.config/app.json>). Done; see ${WEB[0]}.` }]),
  ])
}
function codexFixture() {
  const cwd = '/Users/jane/Documents/GitHub/repo'
  const item = (m: number, payload: Record<string, unknown>) => ({ timestamp: t(m), type: 'response_item', payload })
  write(join(home, '.codex', 'sessions', '2026', '11', '08', `rollout-2026-11-08T12-00-00-${CODEX_ID}.jsonl`), [
    { timestamp: t(0), type: 'session_meta', payload: { id: CODEX_ID, cwd, originator: 'codex_cli_rs', timestamp: t(0) } },
    item(1, { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Audit ${cwd}/server/app.ts` }] }),
    item(2, { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', `cat ${cwd}/server/app.ts`], workdir: cwd }) }),
    item(3, { type: 'function_call_output', call_id: 'c1', output: `${cwd}/server/app.ts: 120 lines` }),
    item(4, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: [
      `- [server/app.ts](${cwd}/server/app.ts:42) handles the route.`,
      `- [app.test.ts](${cwd}/server/app.test.ts:7)`,
      `- Config lives at \`${cwd}/.config/x.json\` and ~/.codex/config.toml.`,
      `- Upstream: [issue](${WEB[0]}). Docs: ${WEB[1]}.`,
      '- Relative: server/lib/x.ts:12 and [guide](docs/guide.md).',
    ].join('\n') }] }),
  ])
}

function assertNoLocalPaths(json: string) {
  expect(json).not.toContain('/Users/')
  expect(json.match(ABSOLUTE) ?? []).toEqual([])
  // Prose paths read as base names: no private root survives outside a code span.
  expect(json.replace(/`[^`]*`/g, '').match(/(?:^|[^A-Za-z0-9.:/-])\/+(?:Users|Volumes|private)\/|~\//gi) ?? []).toEqual([])
}

describe('session detail: no absolute local path in any field', () => {
  it('Claude: links, bare paths, code spans, file and editor URLs, sent-file names and captions, the first prompt', async () => {
    claudeFixture()
    const base = await serve()
    const res = await fetch(`${base}/api/agent-sessions/claude/${CLAUDE_ID}?turns=20`)
    expect(res.status).toBe(200)
    const json = await res.text()
    assertNoLocalPaths(json)
    const body = JSON.parse(json) as { latest_reply: string; first_prompt: string; recent_turns: Array<{ text: string; outputFiles?: Array<{ name: string }> }> }
    // Base names with the line anchor, the web untouched, relative paths as written.
    const reply = body.recent_turns.map(x => x.text).join('\n')
    for (const want of ['app.ts:42', 'routes.ts:9', 'notes.md.', '`/private/tmp/build/out.log`', 'a.ts:3', 'b.md', '[guide](cos-file:', 'server/lib/x.ts:12', ...WEB]) expect(reply, want).toContain(want)
    expect(body.latest_reply).toContain('Checked app.json.')
    expect(body.latest_reply).toContain(WEB[0])
    // The first prompt is capped by the parser (mid-path here); what is left of the path is a base name.
    expect(body.first_prompt).toMatch(/^Fix the bug in \S+/)
    expect(body.recent_turns.flatMap(x => x.outputFiles ?? []).map(f => f.name)).toEqual(['report.pdf'])
  })
  it('Codex: [file](/abs/file:line) links, code spans, ~/ and the prompt', async () => {
    codexFixture()
    const base = await serve()
    const res = await fetch(`${base}/api/agent-sessions/codex/${CODEX_ID}?turns=20`)
    expect(res.status).toBe(200)
    const json = await res.text()
    assertNoLocalPaths(json)
    const body = JSON.parse(json) as { latest_reply: string; recent_turns: Array<{ text: string }> }
    for (const want of ['server/app.ts:42', 'app.test.ts:7', '`[home]/Documents/GitHub/repo/.config/x.json`', 'config.toml', 'server/lib/x.ts:12', '[guide](docs/guide.md)', WEB[0], WEB[1]]) expect(body.latest_reply, want).toContain(want)
    expect(body.recent_turns.map(x => x.text).join('\n')).toContain('Audit app.ts')
  })
})

describe('the list and search carry the same words', () => {
  it('list rows and search hits have no absolute local path', async () => {
    claudeFixture(); codexFixture()
    const base = await serve()
    const list = await fetch(`${base}/api/agent-sessions?limit=20`)
    expect(list.status).toBe(200)
    const listJson = await list.text()
    expect((JSON.parse(listJson) as { sessions: unknown[] }).sessions.length).toBeGreaterThan(0)
    assertNoLocalPaths(listJson)
    const search = await fetch(`${base}/api/agent-sessions/search?q=app.ts`)
    expect(search.status).toBe(200)
    assertNoLocalPaths(await search.text())
  })
})
