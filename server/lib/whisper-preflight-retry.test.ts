// The startup preflight must survive a transient process probe.
//
// THE INCIDENT THESE REPRODUCE (2026-08-06). During the 6.21.20 generation
// changeover, the `/bin/ps` probe inside the preflight reap failed exactly
// ONCE while the previous generation's Python child was shutting down.
// `startWhisperServer` caught it, set state 'failed', and stopped. whisper
// never launched, port 8178 refused for ~30 minutes across a live recording,
// and only a manual restart recovered it — because boot calls
// `startWhisperServer()` once and the only other recovery is a circuit breaker
// that first needs three failed transcriptions.
//
// These drive the REAL startWhisperServer through a mocked child_process, so
// they observe behaviour (did whisper spawn? what does health report?) rather
// than asserting on source text. Source-shape assertions cannot see a retry.

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeChild extends EventEmitter {
  pid: number
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    this.signalCode = signal
    this.emit('close', null, signal)
    return true
  })

  constructor(pid: number) {
    super()
    this.pid = pid
  }
}

type ProbeError = Error & { code?: number | string; killed?: boolean; signal?: string }

/** An execFile that fails `psFailures` times on /bin/ps, then behaves. */
function installMocks(psFailures: number, failure?: Partial<ProbeError>) {
  const psCalls: number[] = []
  let psSeen = 0

  const spawnMock = vi.fn(() => new FakeChild(500))
  const execFileMock = vi.fn((
    file: string,
    _args: string[],
    _options: unknown,
    callback: (error: ProbeError | null, stdout: string, stderr: string) => void,
  ) => {
    if (file.endsWith('/ps') || file === 'ps') {
      psSeen += 1
      psCalls.push(psSeen)
      if (psSeen <= psFailures) {
        // execFile's shape for a timeout kill: bare "Command failed", empty
        // stderr. Exactly what the field failure logged.
        const err = new Error('Command failed: /bin/ps -axww -o pid=,ppid=,command=') as ProbeError
        Object.assign(err, { killed: true, signal: 'SIGKILL', ...failure })
        callback(err, '', '')
        return {} as any
      }
      callback(null, '', '')  // no whisper processes to reap
      return {} as any
    }
    if (file.endsWith('/lsof') || file === 'lsof') {
      const err = new Error('no listeners') as ProbeError
      err.code = 1                       // lsof's "no matches" — port is clear
      callback(err, '', '')
      return {} as any
    }
    callback(new Error(`unexpected executable: ${file}`), '', '')
    return {} as any
  })

  vi.doMock('node:child_process', () => ({ spawn: spawnMock, execFile: execFileMock }))
  vi.doMock('node:fs', async importOriginal => ({
    ...(await importOriginal<typeof import('node:fs')>()),
    existsSync: () => true,
  }))
  return { spawnMock, execFileMock, psCalls: () => psCalls.length }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.doUnmock('node:child_process')
  vi.doUnmock('node:fs')
  vi.resetModules()
})

describe('whisper startup preflight retry', () => {
  it('survives a single transient ps failure and still starts whisper', async () => {
    // THE REGRESSION, stated as behaviour. Before the fix this threw and
    // whisper never spawned.
    const { spawnMock, psCalls } = installMocks(1)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const { startWhisperServer, getWhisperHealth } = await import('./whisper-local.js')

    await expect(startWhisperServer()).resolves.toBeUndefined()

    expect(spawnMock).toHaveBeenCalled()
    expect(psCalls()).toBeGreaterThanOrEqual(2)     // it actually retried
    expect(getWhisperHealth().startupState).not.toBe('failed')
  })

  it('survives two consecutive transient failures', async () => {
    const { spawnMock } = installMocks(2)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const { startWhisperServer } = await import('./whisper-local.js')

    await expect(startWhisperServer()).resolves.toBeUndefined()
    expect(spawnMock).toHaveBeenCalled()
  })

  it('still FAILS CLOSED when the probe is genuinely broken', async () => {
    // Preflight exists to prove no orphaned whisper owns port 8178. Retrying
    // must not become "give up and spawn anyway" — two owners on one port is
    // worse than no whisper. This is the guard on the guard.
    const { spawnMock } = installMocks(99)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const { startWhisperServer, getWhisperHealth } = await import('./whisper-local.js')

    await expect(startWhisperServer()).rejects.toThrow(/process table/i)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(getWhisperHealth().startupState).toBe('failed')
  })

  it('bounds the retries — a broken probe fails fast, it does not hang boot', async () => {
    const { psCalls } = installMocks(99)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const { startWhisperServer } = await import('./whisper-local.js')

    await expect(startWhisperServer()).rejects.toThrow()

    // Exactly the configured attempt budget, not an unbounded loop.
    expect(psCalls()).toBe(3)
  })

  it('reports every attempt with discriminating detail, not a bare Command failed', async () => {
    // The field failure logged only `Command failed: /bin/ps ...` with empty
    // stderr — indistinguishable between a timeout kill, a non-zero exit, and
    // a failed fork. That ambiguity cost an investigation and STILL did not
    // settle the mechanism. The next occurrence must name itself.
    const { psCalls } = installMocks(99, { killed: true, signal: 'SIGKILL' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const { startWhisperServer, getWhisperHealth } = await import('./whisper-local.js')

    await expect(startWhisperServer()).rejects.toThrow()
    expect(psCalls()).toBe(3)

    const reported = String(getWhisperHealth().lastError ?? '')
    expect(reported).toMatch(/after 3 attempts/)
    expect(reported).toMatch(/killed=true/)
    expect(reported).toMatch(/signal=SIGKILL/)
    expect(reported).toMatch(/attempt 1/)
    expect(reported).toMatch(/attempt 3/)     // every attempt, not just the last
  })

  it('does not retry lsof "no matches", which is a normal answer', async () => {
    // lsof exits 1 to mean the port is clear. Retrying that would triple the
    // cost of the common path on every single start.
    const { execFileMock } = installMocks(0)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const { startWhisperServer } = await import('./whisper-local.js')

    await startWhisperServer()

    const lsofCalls = (execFileMock.mock.calls as unknown as Array<[string]>)
      .filter(([file]) => file.endsWith('/lsof') || file === 'lsof')
    expect(lsofCalls.length).toBeGreaterThan(0)
    expect(lsofCalls.length).toBeLessThanOrEqual(2)   // once per preflight, never 3x
  })
})
