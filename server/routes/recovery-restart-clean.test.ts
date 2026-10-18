// 6.78.0 (P7 S4): the phone's Restart marks a clean exit before the kickstart, so a restart
// whose SIGTERM never lands (and that ends in the 2 s exit(1) fallback) does not count toward
// crash-loop parking. Executes the real route handler with the restart scheduler captured;
// no launchctl, no exit, no file outside a mock.
import { afterEach, describe, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({ options: null as null | { beforeRestart?: () => void; onError?: (e: unknown) => void } }))
vi.mock('../lib/managed-restart.js', () => ({ scheduleManagedServerRestart: (options: any) => { captured.options = options } }))
vi.mock('../lib/managed-runtime.js', () => ({ isManagedRuntime: () => true }))
vi.mock('../lib/recovery-activity.js', () => ({
  acquireMaintenance: () => ({ ok: true, release: () => {}, busy: [] }),
  getRecoveryActivityStatus: () => ({}),
}))
vi.mock('../lib/whisper-local.js', () => ({ getWhisperHealth: () => ({}), restartWhisperServer: async () => ({ status: 'ok' }) }))
vi.mock('../lib/atomic-fs.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/atomic-fs.js')>('../lib/atomic-fs.js')
  return { ...actual, atomicWriteFileSync: () => {} }
})

import { recoveryRouter } from './recovery.js'
import { installBootResumeGate, type BootResumeGate } from '../lib/boot-resume.js'

function restartHandler(): Function {
  const layer = (recoveryRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }> }).stack
    .find(l => l.route?.path === '/recovery/server/restart' && l.route.methods.post)!
  return layer.route!.stack[layer.route!.stack.length - 1]!.handle
}

afterEach(() => { installBootResumeGate(null); captured.options = null })

describe('POST /recovery/server/restart', () => {
  it('hands the scheduler a hook that marks the process gate clean, and marks nothing before the restart runs', () => {
    const markCleanShutdown = vi.fn()
    installBootResumeGate({ markCleanShutdown } as unknown as BootResumeGate)
    let status = 0
    let body: unknown = null
    const res = { status: (code: number) => { status = code; return res }, json: (b: unknown) => { body = b; return res } }
    restartHandler()({ headers: {} }, res)
    expect(status).toBe(202)
    expect(body).toMatchObject({ accepted: true })
    expect(markCleanShutdown).not.toHaveBeenCalled()
    expect(typeof captured.options?.beforeRestart).toBe('function')
    captured.options!.beforeRestart!()
    expect(markCleanShutdown).toHaveBeenCalledTimes(1)
  })
})
