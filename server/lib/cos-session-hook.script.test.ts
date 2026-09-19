// The shipped hook script, run as Claude runs it: `sh <script> <Event>` with the payload on
// stdin and only the baked environment. Every path must exit 0 and print nothing except a
// permission decision. macOS-only (BSD head, ioreg); skipped elsewhere.

import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { parseHookEnvelope } from './session-hook-events.js'
import { requireApiToken } from './api-auth.js'
import { PermissionBroker, questionHookOutput, type BrokerMode } from './permission-broker.js'
import { createPermissionBrokerHookRouter, createSessionQuestionsRouter } from '../routes/permission-broker.js'
import { ASK_INPUT, Q1, Q2 } from './__fixtures__/permission-broker.js'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'hooks', 'cos-session-hook')
const SESSION = 'a1b2c3d4-0000-4000-8000-00000000abcd'
const payload = (extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: SESSION, hook_event_name: 'Stop', cwd: '/Users/example/project', ...extra })

function home(): { home: string; spool: string } {
  const root = mkdtempSync(join(tmpdir(), 'cos-hook-script-'))
  // The production home has a dot component; keep that property (gotcha: a fixture that
  // cannot reproduce the production value is not coverage).
  const h = join(root, '.cos-glasses')
  const spool = join(h, 'data', 'hook-spool')
  mkdirSync(spool, { recursive: true })
  return { home: h, spool }
}

/** Run the script exactly as the installed command does: env baked, PATH the script's own. */
function run(event: string, stdin: string | Buffer, paths: { home: string; spool: string }) {
  return spawnSync('/bin/sh', [SCRIPT, event], {
    input: stdin,
    env: { HOME: dirname(paths.home), COS_GLASSES_HOME: paths.home, COS_HOOK_SPOOL: paths.spool, PATH: '/usr/bin:/bin' },
    timeout: 10_000,
  })
}

/** The same, asynchronously: the listener the script talks to lives in THIS process. */
function runAsync(event: string, stdin: string, paths: { home: string; spool: string }): Promise<{ status: number | null; stdout: string }> {
  return new Promise(resolvePromise => {
    const child = spawn('/bin/sh', [SCRIPT, event], {
      env: { HOME: dirname(paths.home), COS_GLASSES_HOME: paths.home, COS_HOOK_SPOOL: paths.spool, PATH: '/usr/bin:/bin' },
    })
    let stdout = ''
    child.stdout.on('data', c => { stdout += c })
    child.on('close', status => resolvePromise({ status, stdout }))
    child.stdin.end(stdin)
  })
}

const spooled = (spool: string) => readdirSync(spool).filter(n => /^\d+-\d+-[A-Za-z]+\.json$/.test(n))
const onMac = process.platform === 'darwin'

describe.skipIf(!onMac)('bin/hooks/cos-session-hook', () => {
  let listener: Server | null = null
  afterEach(() => { listener?.close(); listener = null })

  it('spools one envelope per event, named by the millisecond stamp and its pid, prints nothing, exits 0', () => {
    const paths = home()
    const before = Date.now()
    const r = run('Stop', payload({ last_assistant_message: 'done' }), paths)
    expect(r.status).toBe(0)
    expect(r.stdout.toString()).toBe('')
    expect(r.stderr.toString()).toBe('')
    const names = spooled(paths.spool)
    expect(names).toHaveLength(1)
    const [stamp, pid, event] = names[0].replace(/\.json$/, '').split('-')
    expect(Number(stamp)).toBeGreaterThanOrEqual(before)
    expect(Number(stamp)).toBeLessThanOrEqual(Date.now())
    expect(Number(pid)).toBeGreaterThan(0)
    expect(event).toBe('Stop')
    const parsed = parseHookEnvelope(readFileSync(join(paths.spool, names[0]), 'utf-8'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.envelope).toMatchObject({ ts: Number(stamp), event: 'Stop', sessionId: SESSION })
    expect(parsed.envelope.payload.last_assistant_message).toBe('done')
    // Nothing but the published file: no temp file, no request copy.
    expect(readdirSync(paths.spool).filter(n => n.startsWith('.tmp'))).toEqual([])
    expect(statSync(join(paths.spool, names[0])).mode & 0o077).toBe(0)
    expect(existsSync(join(paths.spool, 'rejected'))).toBe(true)
  })

  it('a non-JSON payload is spooled under the event name "rejected" with the bytes kept', () => {
    const paths = home()
    expect(run('Stop', 'not json', paths).status).toBe(0)
    const names = spooled(paths.spool)
    expect(names).toHaveLength(1)
    expect(names[0].endsWith('-rejected.json')).toBe(true)
    expect(readFileSync(join(paths.spool, names[0]), 'utf-8')).toContain('"event":"rejected","payload":not json}')
  })

  it('caps stdin at 1 MiB', () => {
    const paths = home()
    const big = payload({ pad: 'x'.repeat(2 * 1024 * 1024) })
    expect(run('PostToolUse', big, paths).status).toBe(0)
    const [name] = spooled(paths.spool)
    expect(statSync(join(paths.spool, name)).size).toBeLessThan(1_048_576 + 256)
  })

  it('B8: a full spool or a drain stamp older than a day drops everything but a PermissionRequest', () => {
    const paths = home()
    for (let i = 0; i < 2000; i++) writeFileSync(join(paths.spool, `${1700000000000 + i}-1-Stop.json`), '{}\n')
    expect(run('Stop', payload(), paths).status).toBe(0)
    expect(spooled(paths.spool)).toHaveLength(2000)
    // A PermissionRequest still spools (the row must read waiting even with nobody draining).
    writeFileSync(join(paths.home, 'hook-desk-idle-s'), '999999999') // the desk is never idle enough: no HTTP
    expect(run('PermissionRequest', payload({ tool_name: 'Bash', tool_input: { command: 'ls' } }), paths).status).toBe(0)
    expect(spooled(paths.spool)).toHaveLength(2001)

    const fresh = home()
    const stamp = join(fresh.spool, '.last-drain')
    writeFileSync(stamp, '')
    const dayAgo = new Date(Date.now() - 25 * 60 * 60_000)
    utimesSync(stamp, dayAgo, dayAgo)
    expect(run('Stop', payload(), fresh).status).toBe(0)
    expect(spooled(fresh.spool)).toEqual([])
    const recent = new Date(Date.now() - 23 * 60 * 60_000)
    utimesSync(stamp, recent, recent) // -mmin +1440 is a day; -mtime +1 would have been two
    expect(run('Stop', payload(), fresh).status).toBe(0)
    expect(spooled(fresh.spool)).toHaveLength(1)
  })

  it('a PermissionRequest with the desk idle posts its own copy of the envelope and prints only a decision', async () => {
    const paths = home()
    writeFileSync(join(paths.home, 'hook-desk-idle-s'), '0') // idle enough at once
    writeFileSync(join(paths.home, 'hook-token'), 'tok-123')
    let seen: { url: string | undefined; token: string | undefined; body: string } | null = null
    let reply = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    listener = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        seen = { url: req.url, token: req.headers['x-cos-hook-token'] as string | undefined, body }
        res.setHeader('content-type', 'application/json')
        res.end(reply)
      })
    })
    await new Promise<void>(r => listener!.listen(0, '127.0.0.1', () => r()))
    writeFileSync(join(paths.home, 'hook-port'), String((listener.address() as AddressInfo).port))

    const r = await runAsync('PermissionRequest', payload({ tool_name: 'Bash', tool_input: { command: 'touch x' } }), paths)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe(reply)
    expect(seen).not.toBeNull()
    // 6.52.0: the hook's own door, outside /api (the /api gate answers a hook token 401).
    expect(seen!.url).toBe('/hooks/permission-requests/ask')
    expect(seen!.token).toBe('tok-123')
    const posted = parseHookEnvelope(seen!.body)
    expect(posted.ok).toBe(true)
    if (posted.ok) {
      expect(posted.envelope.event).toBe('PermissionRequest')
      expect(posted.envelope.payload.tool_name).toBe('Bash')
      // The spool wrapper around Claude's own payload, unwrapped: the input verbatim.
      expect(posted.envelope.payload.tool_input).toEqual({ command: 'touch x' })
    }
    // The spooled file is published too, and the request copy is gone afterwards.
    expect(spooled(paths.spool)).toHaveLength(1)
    expect(readdirSync(paths.spool).filter(n => n.endsWith('.req'))).toEqual([])

    // Anything that is not a decision is swallowed: the native dialog follows.
    reply = '{"ok":false,"error":"broker off"}'
    const junk = await runAsync('PermissionRequest', payload({ tool_name: 'Bash', tool_input: { command: 'touch y' } }), paths)
    expect(junk.status).toBe(0)
    expect(junk.stdout).toBe('')

    // A missing token means no request at all.
    seen = null
    writeFileSync(join(paths.home, 'hook-token'), '')
    expect((await runAsync('PermissionRequest', payload({ tool_name: 'Bash', tool_input: { command: 'touch z' } }), paths)).stdout).toBe('')
    expect(seen).toBeNull()
  })

  // 6.51.0: the Cursor-only Stop branch. Cursor runs this same hook (from
  // ~/.claude/settings.json) with CURSOR_VERSION in the environment and its own payload.
  describe('Cursor Stop follow-up (6.51.0)', () => {
    const CONVERSATION = 'c0ffee00-0000-4000-8000-0000000000cc'
    const cursorStop = (extra: Record<string, unknown> = {}) => JSON.stringify({
      conversation_id: CONVERSATION, session_id: CONVERSATION, hook_event_name: 'stop',
      status: 'completed', loop_count: 0, cursor_version: '3.21.13', workspace_roots: ['/Users/example/project'], ...extra,
    })
    const runWithEnv = (event: string, stdin: string, paths: { home: string; spool: string }, extraEnv: Record<string, string>) =>
      new Promise<{ status: number | null; stdout: string }>(resolvePromise => {
        const child = spawn('/bin/sh', [SCRIPT, event], {
          env: { HOME: dirname(paths.home), COS_GLASSES_HOME: paths.home, COS_HOOK_SPOOL: paths.spool, PATH: '/usr/bin:/bin', ...extraEnv },
        })
        let stdout = ''
        child.stdout.on('data', c => { stdout += c })
        child.on('close', status => resolvePromise({ status, stdout }))
        child.stdin.end(stdin)
      })
    async function listen(reply: () => string): Promise<{ paths: { home: string; spool: string }; seen: Array<{ url: string | undefined; token: string | undefined; body: string }> }> {
      const paths = home()
      writeFileSync(join(paths.home, 'hook-token'), 'hook-tok')
      const seen: Array<{ url: string | undefined; token: string | undefined; body: string }> = []
      listener = createServer((req, res) => {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => {
          seen.push({ url: req.url, token: req.headers['x-cos-hook-token'] as string | undefined, body })
          res.setHeader('content-type', 'application/json')
          res.end(reply())
        })
      })
      await new Promise<void>(r => listener!.listen(0, '127.0.0.1', () => r()))
      writeFileSync(join(paths.home, 'hook-port'), String((listener.address() as AddressInfo).port))
      return { paths, seen }
    }

    it('a Cursor Stop posts its envelope to the follow-up route and prints exactly the follow-up', async () => {
      const reply = JSON.stringify({ followup_message: 'Queued from the phone' })
      const { paths, seen } = await listen(() => reply)
      const r = await runWithEnv('Stop', cursorStop(), paths, { CURSOR_VERSION: '3.21.13' })
      expect(r.status).toBe(0)
      expect(r.stdout).toBe(reply)
      expect(seen).toHaveLength(1)
      expect(seen[0]!.url).toBe('/hooks/cursor/stop-followup')
      expect(seen[0]!.token).toBe('hook-tok')
      const posted = parseHookEnvelope(seen[0]!.body)
      expect(posted.ok).toBe(true)
      if (posted.ok) {
        expect(posted.envelope.event).toBe('Stop')
        expect(posted.envelope.payload.conversation_id).toBe(CONVERSATION)
      }
      // The Stop is still spooled for the signal store, and no request copy is left.
      expect(spooled(paths.spool)).toHaveLength(1)
      expect(readdirSync(paths.spool).filter(n => n.endsWith('.req') || n.startsWith('.tmp'))).toEqual([])
    })

    it('reads a payload with spaces after the colons too (any JSON writer)', async () => {
      const reply = JSON.stringify({ followup_message: 'Queued from the phone' })
      const { paths, seen } = await listen(() => reply)
      const spaced = cursorStop().replace(/":/g, '": ')
      const r = await runWithEnv('Stop', spaced, paths, { CURSOR_VERSION: '3.21.13' })
      expect(r.stdout).toBe(reply)
      expect(seen).toHaveLength(1)
    })

    it('skips the request when the queue folder has nothing for this composer, and asks when it does', async () => {
      const reply = JSON.stringify({ followup_message: 'Queued from the phone' })
      const { paths, seen } = await listen(() => reply)
      const qdir = join(dirname(paths.spool), 'thread-turn-queue')
      mkdirSync(qdir, { recursive: true })
      writeFileSync(join(qdir, 'claude-a1b2c3d4-0000-4000-8000-00000000abcd.json'), '{}')
      expect((await runWithEnv('Stop', cursorStop(), paths, { CURSOR_VERSION: '3.21.13' })).stdout).toBe('')
      expect(seen).toEqual([])
      writeFileSync(join(qdir, `cursor-${CONVERSATION}.json`), '{}')
      expect((await runWithEnv('Stop', cursorStop(), paths, { CURSOR_VERSION: '3.21.13' })).stdout).toBe(reply)
      expect(seen).toHaveLength(1)
      // Both Stops are still spooled for the signal store, and nothing is left behind.
      expect(spooled(paths.spool)).toHaveLength(2)
      expect(readdirSync(paths.spool).filter(n => n.endsWith('.req') || n.startsWith('.tmp'))).toEqual([])
    })

    it('a payload with only session_id still asks when that composer has a queue (QA W2)', async () => {
      const reply = JSON.stringify({ followup_message: 'Queued from the phone' })
      const { paths, seen } = await listen(() => reply)
      const qdir = join(dirname(paths.spool), 'thread-turn-queue')
      mkdirSync(qdir, { recursive: true })
      const onlySession = cursorStop({ conversation_id: undefined })
      expect(onlySession).not.toContain('conversation_id')
      expect((await runWithEnv('Stop', onlySession, paths, { CURSOR_VERSION: '3.21.13' })).stdout).toBe('')
      expect(seen).toEqual([])
      writeFileSync(join(qdir, `cursor-${CONVERSATION}.json`), '{}')
      expect((await runWithEnv('Stop', onlySession, paths, { CURSOR_VERSION: '3.21.13' })).stdout).toBe(reply)
      expect(seen).toHaveLength(1)
      // Both ids present and different: conversation_id decides, as it does on the server.
      const other = 'c0ffee00-0000-4000-8000-0000000000dd'
      expect((await runWithEnv('Stop', cursorStop({ session_id: other }), paths, { CURSOR_VERSION: '3.21.13' })).stdout).toBe(reply)
      expect(seen).toHaveLength(2)
      expect((await runWithEnv('Stop', cursorStop({ conversation_id: other, session_id: CONVERSATION }), paths, { CURSOR_VERSION: '3.21.13' })).stdout).toBe('')
      expect(seen).toHaveLength(2)
      // No id the hook can read: it asks, and the server (which reads ids the same way) decides.
      const noId = cursorStop({ conversation_id: undefined, session_id: undefined })
      expect((await runWithEnv('Stop', noId, paths, { CURSOR_VERSION: '3.21.13' })).stdout).toBe(reply)
      expect(seen).toHaveLength(3)
    })

    it('an answer that is not a follow-up prints nothing', async () => {
      const { paths, seen } = await listen(() => '{}')
      const r = await runWithEnv('Stop', cursorStop(), paths, { CURSOR_VERSION: '3.21.13' })
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
      expect(seen).toHaveLength(1)
    })

    it('a Claude Stop never reaches the network, even when its text mentions cursor_version', async () => {
      const { paths, seen } = await listen(() => JSON.stringify({ followup_message: 'must not print' }))
      const claude = payload({ last_assistant_message: 'the payload has "cursor_version":"3.21" in it' })
      const r = await runWithEnv('Stop', claude, paths, {})
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
      expect(seen).toEqual([])
      expect(spooled(paths.spool)).toHaveLength(1)
    })

    it('CURSOR_VERSION without a Cursor payload, or a Cursor payload on another event, sends nothing', async () => {
      const { paths, seen } = await listen(() => JSON.stringify({ followup_message: 'must not print' }))
      expect((await runWithEnv('Stop', payload(), paths, { CURSOR_VERSION: '3.21.13' })).stdout).toBe('')
      expect((await runWithEnv('PostToolUse', cursorStop({ hook_event_name: 'postToolUse' }), paths, { CURSOR_VERSION: '3.21.13' })).stdout).toBe('')
      expect((await runWithEnv('Stop', cursorStop(), paths, {})).stdout).toBe('')
      expect(seen).toEqual([])
      expect(spooled(paths.spool)).toHaveLength(3)
    })

    it('no hook token means no request, and a closed port fails fast and silently', async () => {
      const { paths, seen } = await listen(() => JSON.stringify({ followup_message: 'x' }))
      writeFileSync(join(paths.home, 'hook-token'), '')
      expect((await runWithEnv('Stop', cursorStop(), paths, { CURSOR_VERSION: '3.21.13' })).stdout).toBe('')
      expect(seen).toEqual([])
      writeFileSync(join(paths.home, 'hook-token'), 'hook-tok')
      writeFileSync(join(paths.home, 'hook-port'), '1')
      const started = Date.now()
      const r = await runWithEnv('Stop', cursorStop(), paths, { CURSOR_VERSION: '3.21.13' })
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(spooled(paths.spool)).toHaveLength(2)
    })
  })

  // 6.52.0: the real script against the real broker doors, and both mixed-version pairs.
  describe('the permission broker (6.52.0)', () => {
    const API = 'api-tok'
    const HOOK = 'tok-123'
    const askPayload = (extra: Record<string, unknown> = {}) => payload({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: ASK_INPUT, ...extra })
    const brokers: PermissionBroker[] = []
    afterEach(() => { for (const b of brokers.splice(0)) b.stop() })

    /** A server wired as index.ts wires it; `withBroker: false` is a 6.51 server (no such route). */
    async function server(opts: { withBroker?: boolean; mode?: BrokerMode; seenAt?: number | null } = {}) {
      const paths = home()
      writeFileSync(join(paths.home, 'hook-desk-idle-s'), '0') // the script's own gate passes at once
      writeFileSync(join(paths.home, 'hook-token'), HOOK)
      const hits: Array<{ url: string; status: number }> = []
      const broker = new PermissionBroker({
        now: () => Date.now(),
        mode: () => opts.mode ?? 'all',
        admissionsOpen: () => true,
        lastClientSeenAt: () => (opts.seenAt === undefined ? Date.now() : opts.seenAt),
        readDeskIdleSeconds: async () => 1_000,
        deskIdleSeconds: () => 90,
        timeoutMs: () => 20_000,
        pollMs: 50,
        log: () => {},
      })
      brokers.push(broker)
      const app = express()
      app.use((req, res, next) => { const url = req.originalUrl; res.on('finish', () => hits.push({ url, status: res.statusCode })); next() })
      app.use('/api', requireApiToken(API))
      app.use(express.json({ limit: '10mb' }))
      if (opts.withBroker !== false) {
        app.use(createPermissionBrokerHookRouter({ hookToken: () => HOOK, broker }))
        app.use('/api', createSessionQuestionsRouter({ broker }))
      }
      await new Promise<void>(r => { listener = app.listen(0, '127.0.0.1', () => r()) })
      const port = (listener!.address() as AddressInfo).port
      writeFileSync(join(paths.home, 'hook-port'), String(port))
      return { paths, broker, hits, base: `http://127.0.0.1:${port}` }
    }

    async function firstPending(broker: PermissionBroker) {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const [item] = broker.list()
        if (item) return item
        await new Promise(r => setTimeout(r, 20))
      }
      throw new Error('nothing was parked')
    }

    it('a question answered on the glasses: the script prints exactly the updatedInput decision', async () => {
      const s = await server()
      const run = runAsync('PermissionRequest', askPayload(), s.paths)
      const item = await firstPending(s.broker)
      expect(item.questions?.[0]?.question).toBe(Q1)
      const res = await fetch(`${s.base}/api/session-questions/${item.id}/answer`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-cos-token': API },
        body: JSON.stringify({ clientAnswerId: 'lens-1', answers: [{ labels: ['Tag', 'Bump'] }, { other: 'Teal, like the logo' }] }),
      })
      expect(res.status).toBe(200)
      const r = await run
      expect(r.status).toBe(0)
      expect(r.stdout).toBe(JSON.stringify(questionHookOutput(ASK_INPUT, { [Q1]: ['Bump', 'Tag'], [Q2]: ['Teal, like the logo'] })))
      expect(JSON.parse(r.stdout)).toEqual({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...ASK_INPUT, answers: { [Q1]: ['Bump', 'Tag'], [Q2]: ['Teal, like the logo'] } } } },
      })
      expect(s.hits.find(h => h.url === '/hooks/permission-requests/ask')?.status).toBe(200)
      expect(readdirSync(s.paths.spool).filter(n => n.endsWith('.req'))).toEqual([])
    })

    it('an approval denied on the glasses: the script prints the deny with its message', async () => {
      const s = await server()
      const run = runAsync('PermissionRequest', payload({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }), s.paths)
      const item = await firstPending(s.broker)
      expect(s.broker.answer(item.id, { clientAnswerId: 'lens-2', decision: 'deny' }).status).toBe(200)
      expect((await run).stdout).toBe('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from COS glasses"}}}')
    })

    it('no lens live, or the kill switch: {} at once and the script prints nothing (the native dialog, as today)', async () => {
      for (const opts of [{ seenAt: null }, { mode: 'off' as BrokerMode }]) {
        const s = await server(opts)
        const started = Date.now()
        const r = await runAsync('PermissionRequest', askPayload(), s.paths)
        expect(r.status).toBe(0)
        expect(r.stdout).toBe('')
        expect(Date.now() - started).toBeLessThan(3_000)
        expect(s.hits).toEqual([{ url: '/hooks/permission-requests/ask', status: 200 }])
        expect(s.broker.health().counters.parked).toBe(0)
        listener?.close(); listener = null
      }
    })

    it('mixed versions fail safe: a 6.51 script against this server gets 401 and prints nothing', async () => {
      const s = await server()
      const current = readFileSync(SCRIPT, 'utf-8')
      // The one functional difference from 6.51.0 is the URL the curl line posts to.
      const url = '"http://127.0.0.1:$PORT/hooks/permission-requests/ask"'
      expect(current.split(url).length - 1).toBe(1)
      const oldScript = join(s.paths.home, 'cos-session-hook-6.51')
      writeFileSync(oldScript, current.replace(url, '"http://127.0.0.1:$PORT/api/permission-requests/ask"'))
      const r = await new Promise<{ status: number | null; stdout: string }>(resolvePromise => {
        const child = spawn('/bin/sh', [oldScript, 'PermissionRequest'], {
          env: { HOME: dirname(s.paths.home), COS_GLASSES_HOME: s.paths.home, COS_HOOK_SPOOL: s.paths.spool, PATH: '/usr/bin:/bin' },
        })
        let stdout = ''
        child.stdout.on('data', c => { stdout += c })
        child.on('close', status => resolvePromise({ status, stdout }))
        child.stdin.end(askPayload())
      })
      expect(r).toEqual({ status: 0, stdout: '' })
      expect(s.hits).toEqual([{ url: '/api/permission-requests/ask', status: 401 }])
      expect(s.broker.health().counters.parked).toBe(0)
    })

    it('mixed versions fail safe: this script against a 6.51 server gets 404 and prints nothing', async () => {
      const s = await server({ withBroker: false })
      const r = await runAsync('PermissionRequest', askPayload(), s.paths)
      expect(r).toEqual({ status: 0, stdout: '' })
      expect(s.hits).toEqual([{ url: '/hooks/permission-requests/ask', status: 404 }])
    })
  })

  it('a closed port fails fast and silently', () => {
    const paths = home()
    writeFileSync(join(paths.home, 'hook-desk-idle-s'), '0')
    writeFileSync(join(paths.home, 'hook-token'), 'tok')
    writeFileSync(join(paths.home, 'hook-port'), '1') // nothing listens on tcp/1
    const started = Date.now()
    const r = run('PermissionRequest', payload({ tool_name: 'Bash', tool_input: { command: 'ls' } }), paths)
    expect(r.status).toBe(0)
    expect(r.stdout.toString()).toBe('')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(spooled(paths.spool)).toHaveLength(1)
  })
})
