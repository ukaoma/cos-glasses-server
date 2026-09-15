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
import { parseHookEnvelope } from './session-hook-events.js'

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
    let seen: { token: string | undefined; body: string } | null = null
    let reply = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    listener = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        seen = { token: req.headers['x-cos-hook-token'] as string | undefined, body }
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
    expect(seen!.token).toBe('tok-123')
    const posted = parseHookEnvelope(seen!.body)
    expect(posted.ok).toBe(true)
    if (posted.ok) expect(posted.envelope.payload.tool_name).toBe('Bash')
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
