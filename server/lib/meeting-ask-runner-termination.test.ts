import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('./provider-binary.js', () => ({ resolveProviderBinary: () => ({ ok: true, path: '/fake/provider' }) }))
vi.mock('./token-audit.js', () => ({ logTokenAudit: vi.fn() }))
vi.mock('./provider-usage.js', () => ({ readOneShotUsage: () => ({}) }))
vi.mock('./lens-gist-engines.js', () => ({
  buildClaudeGistArgs: () => [], buildCodexGistArgs: () => [], lensGistChildEnv: () => ({}),
  parseClaudeGistOutput: () => ({ text: 'answer' }), parseCodexGistOutput: () => ({ text: 'answer' }),
}))
import { spawn } from 'node:child_process'
import { runMeetingAskModel, AskProcessError, MEETING_ASK_TERMINATION_PROOF_MS, MEETING_ASK_LATE_PROOF_POLL_MS } from './meeting-ask-runner.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function fixture(pid: number | undefined = 654321) {
  const child = Object.assign(new EventEmitter(), { pid: pid as number | undefined, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() })
  vi.mocked(spawn).mockReturnValue(child as any)
  let alive = true, denied = false
  const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 0 && (!alive || denied)) throw Object.assign(new Error('probe'), { code: denied ? 'EPERM' : 'ESRCH' })
    return true
  })
  return { child, kill, gone: () => { alive = false }, denied: () => { denied = true }, allowed: () => { denied = false } }
}

describe('unconfirmed Ask provider termination proof', () => {
  it('does not prove exit from process-group absence alone; later close proves it without another signal', async () => {
    const f = fixture(), controller = new AbortController()
    const outcome = runMeetingAskModel({ engine: 'claude', model: 'sonnet' }, 'question', 'system', controller.signal).catch(e => e as AskProcessError)
    controller.abort()
    await vi.advanceTimersByTimeAsync(MEETING_ASK_TERMINATION_PROOF_MS + 100)
    const error = await outcome
    expect(error).toBeInstanceOf(AskProcessError)
    if (!(error instanceof AskProcessError)) throw Error('runner unexpectedly returned an answer')
    expect(error.terminationUnconfirmed).toBe(true)
    expect(error.terminationConfirmed).toBeInstanceOf(Promise)
    let proved = 0
    error.terminationConfirmed!.then(() => { proved++ })
    const sent = () => f.kill.mock.calls.filter(([, signal]) => signal !== 0)
    expect(sent().map(([, signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
    f.child.pid = 987654 // The watcher remains bound to the originally spawned process group.
    f.gone(); await vi.advanceTimersByTimeAsync(2000)
    expect(proved, 'absence without the original close event is not proof').toBe(0)
    f.child.emit('error', new Error('late child error'))
    await vi.advanceTimersByTimeAsync(MEETING_ASK_LATE_PROOF_POLL_MS * 2)
    expect(proved, 'a child error event cannot replace the original close event').toBe(0)
    f.child.emit('close', null)
    await vi.advanceTimersByTimeAsync(MEETING_ASK_LATE_PROOF_POLL_MS * 2)
    expect(proved).toBe(1)
    const probes = f.kill.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(proved).toBe(1); expect(f.kill).toHaveBeenCalledTimes(probes)
    expect(sent()).toHaveLength(2)
    expect(f.kill.mock.calls.every(([pid]) => pid === -654321)).toBe(true)
  })

  it('does not prove exit while any group exists or its absence cannot be checked', async () => {
    const f = fixture(), controller = new AbortController()
    const outcome = runMeetingAskModel({ engine: 'claude', model: 'sonnet' }, 'question', 'system', controller.signal).catch(e => e as AskProcessError)
    controller.abort(); f.child.emit('close', null)
    await vi.advanceTimersByTimeAsync(MEETING_ASK_TERMINATION_PROOF_MS + 100)
    const error = await outcome
    expect(error).toBeInstanceOf(AskProcessError)
    if (!(error instanceof AskProcessError)) throw Error('runner unexpectedly returned an answer')
    expect(error.terminationConfirmed).toBeInstanceOf(Promise)
    let proved = false
    error.terminationConfirmed!.then(() => { proved = true })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(proved, 'a surviving or reused process group must keep the hold').toBe(false)
    f.denied(); f.gone(); await vi.advanceTimersByTimeAsync(2000)
    expect(proved, 'EPERM must not count as absence').toBe(false)
    f.allowed(); await vi.advanceTimersByTimeAsync(MEETING_ASK_LATE_PROOF_POLL_MS * 2)
    expect(proved).toBe(true)
  })

  it('does not mint termination proof when the spawned process group was never known', async () => {
    const f = fixture(), controller = new AbortController()
    f.child.pid = undefined
    const outcome = runMeetingAskModel({ engine: 'claude', model: 'sonnet' }, 'question', 'system', controller.signal).catch(e => e as AskProcessError)
    controller.abort(); await vi.advanceTimersByTimeAsync(MEETING_ASK_TERMINATION_PROOF_MS + 100)
    const error = await outcome
    if (!(error instanceof AskProcessError)) throw Error('runner unexpectedly returned an answer')
    let proved = false
    error.terminationConfirmed!.then(() => { proved = true })
    f.child.emit('close', null); await vi.advanceTimersByTimeAsync(10_000)
    expect(proved, 'unknown process identity cannot count as confirmed absence').toBe(false)
    expect(f.kill).not.toHaveBeenCalled()
  })
})
