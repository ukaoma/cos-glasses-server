// 6.53.3 (review A11): the adapter's cancel and timeout, end to end, against REAL processes.
//
// Nothing here is faked below `deliverAttachedTurn` except the binary (node running a
// fixture), the argv, and the ownership ledger. Spawn, the process-table reads, the
// signals and the liveness poll are the production `realAttachedTurnDeps`. Every other
// cancel test either fakes `terminate` or answers `processTreeAlive: () => false`, which is
// how 6.53.1 shipped a false fence on every busy cancel and 6.53.2 shipped `reaped: true`
// with a live process (review A2) plus a regression from 6.52.3 (review A3).
//
// Each case asserts what the adapter REPORTED and what is actually still running,
// found by a token every fixture process carries in its argv. `reaped: true` with a
// survivor is the one outcome this file exists to make impossible.
//
// macOS only: on Linux, kernel threads list with pgid 0, which the adapter's table parser
// rejects (one bad row voids the read), so every read there is doubt and every cancel
// fences. That is fail-closed, but it is not what these cases assert.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, type TestContext } from 'vitest'

import { createRequire } from 'node:module'
import {
  CANCEL_KILL_GRACE_MS,
  TREE_POLL_MS,
  deliverAttachedTurn,
  realAttachedTurnDeps,
  type AttachedTurnDeps,
  type AttachedTurnResult,
} from './attached-provider-adapter.js'

const FIXTURE = join(__dirname, '__fixtures__', 'attached-fake-provider.cjs')
const SID = '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b'
const PER_TEST_TIMEOUT_MS = 30_000
const HAS_PERL = existsSync('/usr/bin/perl')

interface TokenProcess {
  pid: number
  ppid: number
  args: string
  cli: boolean
}

const tokens = new Set<string>()
let serial = 0

function newToken(variant: string): string {
  const token = `cospt6533x${process.pid}x${variant.replace(/[^a-z]/g, '')}x${serial++}`
  tokens.add(token)
  return token
}

/** Every live process whose argv carries the token. Zombies list without argv, so they never match. */
function tokenProcesses(token: string): TokenProcess[] {
  const out = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const found: TokenProcess[] = []
  for (const line of out.split('\n')) {
    if (!line.includes(token)) continue
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) continue
    const args = match[3]!
    found.push({ pid: Number(match[1]), ppid: Number(match[2]), args, cli: args.includes('attached-fake-provider.cjs') })
  }
  return found
}

function killToken(token: string): void {
  try { execFileSync('/usr/bin/pkill', ['-9', '-f', token]) } catch { /* nothing matched */ }
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(25)
  }
  throw new Error(`fixture never reached: ${what}`)
}

/** When the variant's tree is fully built, so the cancel lands on the shape under test. */
const READY: Record<string, (procs: TokenProcess[]) => boolean> = {
  churn: procs => procs.some(p => p.cli) && procs.some(p => !p.cli),
  idle: procs => procs.some(p => p.cli) && procs.filter(p => !p.cli).length >= 3,
  stubborn: procs => procs.some(p => p.cli) && procs.some(p => !p.cli),
  graceful: procs => procs.some(p => p.cli) && procs.some(p => !p.cli),
  // The leader has already exited; only its same-group child is left holding stdout.
  'orphan-stdout': procs => !procs.some(p => p.cli) && procs.some(p => !p.cli),
  'orphan-stdout-exit1': procs => !procs.some(p => p.cli) && procs.some(p => !p.cli),
  // The TERM-ignoring job has been re-parented to launchd and the leader has exec'd.
  'group-orphan': procs => procs.some(p => p.cli)
    && procs.some(p => p.args.includes('trap') && p.ppid === 1)
    && procs.some(p => p.args.startsWith('/bin/sh -c while')),
  'setsid-escape': procs => procs.some(p => p.cli) && procs.some(p => !p.cli),
}

interface Run {
  result: AttachedTurnResult
  settleMs: number
  survivors: TokenProcess[]
}

async function run(variant: string, mode: 'cancel' | 'timeout', context: TestContext): Promise<Run> {
  const token = newToken(variant)
  // Per test, not `afterEach`: this suite is concurrent, and a sweep of every token after
  // each test would kill its siblings' trees mid-run. Runs on failure and on timeout.
  context.onTestFinished(() => killToken(token))
  try {
    const base = realAttachedTurnDeps(() => ({ attachable: true, reason: null }))
    const deps: AttachedTurnDeps = {
      ...base,
      resolveBinary: () => ({ ok: true, path: process.execPath, source: 'absolute' }) as never,
      buildArgs: () => [FIXTURE, variant, token, SID],
      recordSpawn: () => 'recorded',
      releaseSpawn: () => true,
    }
    const controller = new AbortController()
    const pending = deliverAttachedTurn({
      provider: 'claude',
      nativeThreadId: SID,
      prompt: 'hi',
      cwd: tmpdir(),
      policy: 'read_only',
      deps,
      abortSignal: controller.signal,
      timeoutMs: mode === 'timeout' ? 2_000 : 60_000,
    })
    await waitFor(`${variant} ready`, () => READY[variant]!(tokenProcesses(token)))
    const startedAt = Date.now()
    if (mode === 'cancel') controller.abort()
    const result = await pending
    const settleMs = Date.now() - startedAt
    // Read at once: `reaped: true` claims nothing of ours is alive at settle time.
    return { result, settleMs, survivors: tokenProcesses(token) }
  } finally {
    killToken(token)
  }
}

function outcome(result: AttachedTurnResult) {
  return result.ok
    ? { reason: null, delivery: result.delivery, reaped: true }
    : { reason: result.reason, delivery: result.delivery, reaped: result.reaped }
}

describe.skipIf(process.platform !== 'darwin').concurrent('attached turn cancel against a real process tree (6.53.3)', () => {
  // Belt and braces for a worker torn down mid-test.
  afterAll(() => { for (const token of tokens) killToken(token) })

  it('a Claude Bash tool churning subprocesses: cancelled, reaped, nothing left', async (context) => {
    const { result, survivors } = await run('churn', 'cancel', context)
    expect(outcome(result)).toEqual({ reason: 'cancelled', delivery: 'cancelled', reaped: true })
    expect(survivors).toEqual([])
  }, PER_TEST_TIMEOUT_MS)

  it('a Claude run with long-lived children only: cancelled, reaped, nothing left', async (context) => {
    const { result, survivors } = await run('idle', 'cancel', context)
    expect(outcome(result)).toEqual({ reason: 'cancelled', delivery: 'cancelled', reaped: true })
    expect(survivors).toEqual([])
  }, PER_TEST_TIMEOUT_MS)

  it('a detached tool that ignores SIGTERM gets SIGKILL, and only then reads reaped', async (context) => {
    const { result, survivors } = await run('stubborn', 'cancel', context)
    expect(outcome(result)).toEqual({ reason: 'cancelled', delivery: 'cancelled', reaped: true })
    expect(survivors).toEqual([])
  }, PER_TEST_TIMEOUT_MS)

  it('a tool that stops one second after SIGTERM settles then, not after the five-second grace', async (context) => {
    const { result, settleMs, survivors } = await run('graceful', 'cancel', context)
    expect(outcome(result)).toEqual({ reason: 'cancelled', delivery: 'cancelled', reaped: true })
    expect(survivors).toEqual([])
    // 6.53.2 held this result ~5.3 s; the poll after `close` settles it at ~1.2 s: the tool's
    // own stop, then at most one TREE_POLL_MS poll to see it gone. The bound allows a second
    // poll and one second of scheduling under a loaded suite (2.4 s today), and stays under
    // the five-second grace so a regression to waiting it out still fails.
    const { GRACEFUL_TOOL_STOP_MS } = createRequire(import.meta.url)(FIXTURE) as { GRACEFUL_TOOL_STOP_MS: number }
    const bound = GRACEFUL_TOOL_STOP_MS + 2 * TREE_POLL_MS + 1_000
    expect(bound).toBeLessThan(CANCEL_KILL_GRACE_MS)
    expect(settleMs).toBeLessThan(bound)
  }, PER_TEST_TIMEOUT_MS)

  it('A3: the leader already exited and a same-group child holds stdout: its group is signalled (cancel)', async (context) => {
    const { result, survivors } = await run('orphan-stdout', 'cancel', context)
    // The CLI exited 0 with our id BEFORE the cancel, so the turn is delivered (the 6.53.0
    // rule: a clean exit that lands first wins). The cancel still has to stop the child it
    // left holding stdout, and the result must wait for that. 6.53.2 never signalled it:
    // unreaped and fenced after ~7.2 s, with the child alive 3/3.
    expect(outcome(result)).toEqual({ reason: null, delivery: 'delivered', reaped: true })
    expect(survivors).toEqual([])
  }, PER_TEST_TIMEOUT_MS)

  it('A3: the same shape with a failed CLI ends cancelled and reaped, which the route does not fence', async (context) => {
    const { result, survivors } = await run('orphan-stdout-exit1', 'cancel', context)
    expect(outcome(result)).toEqual({ reason: 'cancelled', delivery: 'cancelled', reaped: true })
    expect(survivors).toEqual([])
  }, PER_TEST_TIMEOUT_MS)

  it('A3: the same shape on a timeout is reaped as 6.52.3 reaped it', async (context) => {
    const { result, survivors } = await run('orphan-stdout', 'timeout', context)
    expect(outcome(result)).toEqual({ reason: 'timeout', delivery: 'ambiguous', reaped: true })
    expect(survivors).toEqual([])
  }, PER_TEST_TIMEOUT_MS)

  it('A2: a re-parented, TERM-ignoring member of a tool group is tracked and killed, never reported reaped alive', async (context) => {
    const { result, survivors } = await run('group-orphan', 'cancel', context)
    expect(outcome(result)).toEqual({ reason: 'cancelled', delivery: 'cancelled', reaped: true })
    expect(survivors).toEqual([])
  }, PER_TEST_TIMEOUT_MS)

  it.skipIf(!HAS_PERL)('a helper that moved to its own session after we saw it is killed by its remembered identity', async (context) => {
    const { result, survivors } = await run('setsid-escape', 'cancel', context)
    expect(outcome(result)).toEqual({ reason: 'cancelled', delivery: 'cancelled', reaped: true })
    expect(survivors).toEqual([])
  }, PER_TEST_TIMEOUT_MS)
})
