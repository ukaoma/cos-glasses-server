import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionHookLedger } from './session-hook-ledger.js'
import { LAST_DRAIN_STAMP, SPOOL_BATCH, STARTUP_MAX_PASSES, startSpoolIngester, type SpoolIngester } from './session-hook-spool.js'
import { parseHookEnvelope, type HookEnvelope } from './session-hook-events.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'session-hooks-6.48.0')
const lines = (name: string) => readFileSync(join(FIXTURES, name), 'utf-8').split('\n').filter(Boolean)

let running: SpoolIngester | null = null
afterEach(() => { running?.stop(); running = null })

/** The spool proper, with the ledger BESIDE it as in production (`data/hook-spool/` vs `data/…jsonl`). */
function spoolDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'cos-spool-'))
  const dir = join(root, 'hook-spool')
  mkdirSync(dir)
  return dir
}
const ledgerPath = (dir: string) => join(dirname(dir), 'ledger.jsonl')

/** Write recorded envelopes as the script would: `<ts>-<pid>-<Event>.json`, sorted by time. */
function seed(dir: string, name: string): string[] {
  const names: string[] = []
  for (const line of lines(name)) {
    const env = JSON.parse(line) as { ts: number; ppid: number; event: string }
    const file = `${env.ts}-${env.ppid}-${env.event}.json`
    writeFileSync(join(dir, file), line + '\n')
    names.push(file)
  }
  return names
}

describe('the spool ingester', () => {
  it('drains a backlog at startup in filename order, ledgers each event, applies it and unlinks the file', () => {
    const dir = spoolDir()
    const names = seed(dir, 'post-tool-use.hooks.jsonl')
    const ledger = new SessionHookLedger(ledgerPath(dir))
    const applied: HookEnvelope[] = []
    running = startSpoolIngester({ dir, ledger, apply: env => applied.push(env), sweepMs: 60_000 })
    expect(applied.map(e => e.event)).toEqual(['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'])
    expect(readdirSync(dir).filter(n => n.endsWith('.json'))).toEqual([])
    expect(existsSync(join(dir, LAST_DRAIN_STAMP))).toBe(true)
    const rows = readFileSync(ledgerPath(dir), 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    expect(rows.map(r => r.key)).toEqual(names)
    // The ledger keeps the projection, never the response.
    const post = rows.find(r => r.event === 'PostToolUse')
    expect(post.payload).not.toHaveProperty('tool_response')
    expect(post.payload.tool_name).toBe('Bash')
    expect(post.payload.tool_target).toBe('touch par-a')
    expect(post.payload.tool_fingerprint).toMatch(/^[0-9a-f]{64}$/)
    const stats = running.stats()
    expect(stats.ingested).toBe(9)
    expect(stats.rejected).toBe(0)
    expect(stats.backlog).toBe(0)
  })

  it('moves a non-envelope to rejected/, salvages a cut Stop, and dedupes a key the ledger already has', () => {
    const dir = spoolDir()
    const [first] = seed(dir, 'p-mode-run.hooks.jsonl')
    const stopLine = lines('p-mode-run.hooks.jsonl')[2]
    // A Stop cut mid-payload: still names its session and event in the head.
    writeFileSync(join(dir, '1789999999999-1-Stop.json'), stopLine.slice(0, 120))
    writeFileSync(join(dir, '1789999999998-1-Notification.json'), 'not json at all')
    writeFileSync(join(dir, '1789999999997-1-Stop.json'), JSON.stringify({ ts: 1, ppid: 1, event: 'Stop', payload: { session_id: 'nope' } }))
    const ledger = new SessionHookLedger(ledgerPath(dir))
    const applied: HookEnvelope[] = []
    running = startSpoolIngester({ dir, ledger, apply: env => applied.push(env), seenKeys: new Set([first]), sweepMs: 60_000 })
    const stats = running.stats()
    expect(stats.duplicates).toBe(1)
    expect(stats.salvaged).toBe(1)
    expect(stats.rejected).toBe(2)
    expect(readdirSync(join(dir, 'rejected')).length).toBe(2)
    // The salvaged envelope carries the ts the head of the file named, not the filename's.
    const stops = applied.filter(e => e.event === 'Stop')
    expect(stops).toHaveLength(2) // the seeded Stop and the salvaged one
    const salvaged = stops.find(e => Object.keys(e.payload).length === 1)
    expect(salvaged?.ts).toBe(JSON.parse(stopLine).ts)
    expect(salvaged?.payload).toEqual({ session_id: salvaged?.sessionId })
    // The duplicate never reached apply and the file is gone.
    expect(applied.some(e => e.event === 'SessionStart')).toBe(false)
    expect(existsSync(join(dir, first))).toBe(false)
  })

  it('with no apply (feature off) it still drains, ledgers and stamps', () => {
    const dir = spoolDir()
    seed(dir, 'p-mode-run.hooks.jsonl')
    const ledger = new SessionHookLedger(ledgerPath(dir))
    running = startSpoolIngester({ dir, ledger, sweepMs: 60_000 })
    expect(readdirSync(dir).filter(n => n.endsWith('.json'))).toEqual([])
    expect(ledger.stats().appended).toBe(4)
    expect(statSync(join(dir, LAST_DRAIN_STAMP)).isFile()).toBe(true)
  })

  it('drains in bounded batches and keeps the file when the ledger refuses', () => {
    const dir = spoolDir()
    for (let i = 0; i < 5; i++) {
      for (const line of lines('p-mode-run.hooks.jsonl')) {
        const env = JSON.parse(line)
        writeFileSync(join(dir, `${env.ts + i}-${100 + i}-${env.event}.json`), line + '\n')
      }
    }
    const ledger = new SessionHookLedger(ledgerPath(dir))
    const applied: string[] = []
    running = startSpoolIngester({ dir, ledger, apply: env => applied.push(env.event), sweepMs: 60_000, batch: 4 })
    // Startup drain loops full batches; the tail shorter than a batch waits for the next sweep.
    expect(applied.length).toBe(20)
    running.stop()

    const locked = spoolDir()
    seed(locked, 'p-mode-run.hooks.jsonl')
    mkdirSync(ledgerPath(locked)) // a directory where the ledger file should be: every append fails
    const refusing = new SessionHookLedger(ledgerPath(locked))
    const kept: string[] = []
    running = startSpoolIngester({ dir: locked, ledger: refusing, apply: env => kept.push(env.event), sweepMs: 60_000 })
    expect(kept).toEqual([])
    expect(readdirSync(locked).filter(n => n.endsWith('.json')).length).toBe(4)
    expect(running.stats().lastError).toBeTruthy()
  })
})

describe('the spool ingester under the QA blockers', () => {
  it('a refusing ledger with a batch-sized backlog cannot hang the boot: passes are bounded by progress', () => {
    const dir = spoolDir()
    const batch = 4
    for (let i = 0; i < batch * 3; i++) {
      for (const line of lines('p-mode-run.hooks.jsonl')) {
        const env = JSON.parse(line)
        writeFileSync(join(dir, `${env.ts + i}-${100 + i}-${env.event}.json`), line + '\n')
      }
    }
    mkdirSync(ledgerPath(dir)) // every append fails: nothing is ever removed
    let attempts = 0
    const refusing = new (class extends SessionHookLedger {
      override append(key: string, env: HookEnvelope, child?: boolean): boolean { attempts++; return super.append(key, env, child) }
    })(ledgerPath(dir))
    const applied: string[] = []
    const started = Date.now()
    running = startSpoolIngester({ dir, ledger: refusing, apply: env => applied.push(env.event), sweepMs: 60_000, batch })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(applied).toEqual([])
    // A pass that removed nothing ends the drain: ONE batch of attempts, not STARTUP_MAX_PASSES of them.
    expect(attempts).toBe(batch)
    const stats = running.stats()
    expect(stats.stuck).toBe(batch)
    expect(stats.backlog).toBe(batch * 3 * 4)
    expect(stats.lastError).toBe('EISDIR')
    expect(STARTUP_MAX_PASSES).toBe(Math.ceil(2_000 / SPOOL_BATCH) + 1)
  })

  it('classifies a child at ingest and the ledger row remembers it, so a replay applies the same rule', () => {
    const dir = spoolDir()
    const names = seed(dir, 'p-mode-run.hooks.jsonl')
    const ledger = new SessionHookLedger(ledgerPath(dir))
    const seen: Array<[string, boolean]> = []
    running = startSpoolIngester({ dir, ledger, isChild: env => env.event !== 'SessionStart', apply: (env, child) => seen.push([env.event, child]), sweepMs: 60_000 })
    expect(seen).toEqual([['SessionStart', false], ['UserPromptSubmit', true], ['Stop', true], ['SessionEnd', true]])
    const rows = readFileSync(ledgerPath(dir), 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    expect(rows.map(r => r.child ?? false)).toEqual([false, true, true, true])
    expect(rows.map(r => r.key)).toEqual(names)
    const replayed: Array<[string, boolean]> = []
    ledger.replay(0, (env, _key, child) => replayed.push([env.event, child]))
    expect(replayed).toEqual(seen)
  })

  it('a replayed PermissionRequest carries the same target and fingerprint the live event did', () => {
    const dir = spoolDir()
    const ledger = new SessionHookLedger(ledgerPath(dir))
    const live = lines('post-tool-use.hooks.jsonl').map(l => parseHookEnvelope(l)).map(p => { if (!p.ok) throw new Error(p.reason); return p.envelope })
    const request = live.find(e => e.event === 'PermissionRequest')!
    expect(ledger.append('k', request)).toBe(true)
    let replayed: HookEnvelope | null = null
    ledger.replay(0, env => { replayed = env })
    expect(replayed).not.toBeNull()
    const r = replayed! as HookEnvelope
    expect(r.ts).toBe(request.ts)
    expect(r.payload.tool_name).toBe('Bash')
    expect(r.payload.tool_target).toBe('touch par-a')
    expect(r.payload.tool_fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(r.payload).not.toHaveProperty('tool_input')
    expect(r.payload.permission_suggestions).toEqual(request.payload.permission_suggestions)
  })

  it('orders the spool numerically (a shorter stamp or a wrapped pid never reorders) and touches the stamp once per interval', () => {
    const dir = spoolDir()
    const line = lines('p-mode-run.hooks.jsonl')[0]
    // Same event, three names whose lexical and numeric orders disagree.
    writeFileSync(join(dir, `9999999999-5-SessionStart.json`), line + '\n')     // 10-digit stamp
    writeFileSync(join(dir, `10000000000-5-SessionStart.json`), line + '\n')    // 11-digit, numerically later
    writeFileSync(join(dir, `10000000000-100-SessionStart.json`), line + '\n')  // same stamp, pid 100 after pid 5
    writeFileSync(join(dir, `10000000000-20-SessionStart.json`), line + '\n')   // pid 20 between them, lexically last
    const ledger = new SessionHookLedger(ledgerPath(dir))
    const order: string[] = []
    let clock = Date.now() // the first stamp is CREATED with the real clock; later touches use this one
    running = startSpoolIngester({ dir, ledger, apply: () => { /* keys tell the order */ }, sweepMs: 2_000, now: () => clock })
    const rows = readFileSync(ledgerPath(dir), 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l).key as string)
    order.push(...rows)
    expect(order).toEqual(['9999999999-5-SessionStart.json', '10000000000-5-SessionStart.json', '10000000000-20-SessionStart.json', '10000000000-100-SessionStart.json'])
    const stampAt = () => statSync(join(dir, LAST_DRAIN_STAMP)).mtimeMs
    const first = stampAt()
    clock += 500
    running.sweep()
    expect(stampAt()).toBe(first) // inside the interval: not touched, so a watcher never loops on it
    clock += 2_000
    running.sweep()
    expect(stampAt()).toBeGreaterThan(first)
  })
})

describe('the ledger', () => {
  it('replays rows inside the window and reports every key it holds', () => {
    const dir = spoolDir()
    const ledger = new SessionHookLedger(ledgerPath(dir))
    const envs = lines('p-mode-run.hooks.jsonl').map(l => parseHookEnvelope(l)).map(p => { if (!p.ok) throw new Error(p.reason); return p.envelope })
    envs.forEach((env, i) => { expect(ledger.append(`k${i}`, env)).toBe(true) })
    const seen: string[] = []
    const result = ledger.replay(envs[2].ts, env => seen.push(env.event))
    expect(result.rows).toBe(4)
    expect(result.applied).toBe(2)
    expect(seen).toEqual(['Stop', 'SessionEnd'])
    expect([...result.keys]).toEqual(['k0', 'k1', 'k2', 'k3'])
    // A replayed Stop still carries what the reducer needs.
    let reply = ''
    ledger.replay(envs[2].ts, env => { if (env.event === 'Stop') reply = String(env.payload.last_assistant_message) })
    expect(reply).toBe('canary')
  })
})
