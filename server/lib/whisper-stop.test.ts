// S1 (2026-11-09): whisper-server must be stopped without SIGTERM, and waited for.
// Field evidence: 9 whisper-server crash reports 11/03 to 11/08, each SIGABRT in
// signal_handler -> exit -> __cxa_finalize_ranges -> ggml_metal_device_free ->
// ggml_metal_rsets_free -> ggml_abort, in the minute of a COS server restart, parent launchd.
// These drive the REAL startWhisperServer/stopWhisperServer through a mocked child_process.
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeChild extends EventEmitter {
  pid = 700
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  closeOnKill = true
  kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    // Like Node: signalCode is set when the child has exited, not when the signal is sent.
    if (this.closeOnKill) setTimeout(() => { this.signalCode = signal; this.emit('close', null, signal) }, 5)
    return true
  })
}

function installMocks(child: FakeChild) {
  const spawnMock = vi.fn(() => child)
  const execFileMock = vi.fn((file: string, _a: string[], _o: unknown, cb: (e: any, out: string, err: string) => void) => {
    if (file.endsWith('/ps') || file === 'ps') { cb(null, '', ''); return {} as any }
    cb(Object.assign(new Error('no listeners'), { code: 1 }), '', '')
    return {} as any
  })
  vi.doMock('node:child_process', () => ({ spawn: spawnMock, execFile: execFileMock }))
  vi.doMock('node:fs', async importOriginal => ({
    ...(await importOriginal<typeof import('node:fs')>()),
    existsSync: () => true,
  }))
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
  return { spawnMock }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.doUnmock('node:child_process')
  vi.doUnmock('node:fs')
  vi.resetModules()
})

describe('stopping whisper-server (S1)', () => {
  it('never sends SIGTERM, and resolves only after the child closed', async () => {
    const child = new FakeChild()
    const { spawnMock } = installMocks(child)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const whisper = await import('./whisper-local.js')
    await whisper.startWhisperServer()
    expect(spawnMock).toHaveBeenCalledTimes(1)

    let closed = false
    child.once('close', () => { closed = true })
    const result = await whisper.stopWhisperServer()
    expect(closed).toBe(true) // node must not move on (and exit) before the child is gone
    expect(child.kill.mock.calls.map(c => c[0])).toEqual(['SIGKILL'])
    expect(child.kill.mock.calls.map(c => c[0])).not.toContain('SIGTERM')
    expect(result).toMatchObject({ stopped: true, exited: true })
    expect(log.mock.calls.some(c => /whisper-server stopped \(SIGKILL.*exited in \d+ ms/.test(String(c[0])))).toBe(true)
    expect(whisper.getWhisperHealth().startupState).toBe('stopped')
  })

  it('is bounded: a child that never closes is reported, not waited on forever', async () => {
    const child = new FakeChild()
    installMocks(child)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const whisper = await import('./whisper-local.js')
    await whisper.startWhisperServer()
    child.closeOnKill = false
    const started = Date.now()
    const result = await whisper.stopWhisperServer({ waitMs: 50 })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(result).toMatchObject({ stopped: true, exited: false })
    expect(log.mock.calls.some(c => /did not exit within 50 ms/.test(String(c[0])))).toBe(true)
  })

  it('a stop with nothing running resolves at once and says nothing', async () => {
    installMocks(new FakeChild())
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const whisper = await import('./whisper-local.js')
    await expect(whisper.stopWhisperServer()).resolves.toEqual({ stopped: false, exited: true, waitedMs: expect.any(Number), hqChildren: 0 })
    expect(log.mock.calls.some(c => /whisper-server stopped/.test(String(c[0])))).toBe(false)
  })
})

// SOURCE-SHAPE, and it says so (the repo's convention for server/index.ts, see
// boot-resume-wiring.test.ts): index.ts binds ports at import, so no test can execute
// gracefulShutdown. The behaviour behind the line is executed above.
describe('server/index.ts waits for both whisper-server children before exit (S1)', () => {
  it('awaits stopWhisperServer and the preview stop before process.exit(0)', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const index = readFileSync(resolve(process.cwd(), 'server/index.ts'), 'utf8')
    const from = index.indexOf('async function gracefulShutdown')
    const to = index.indexOf("process.on('SIGTERM'")
    expect(from).toBeGreaterThan(-1)
    const shutdown = index.slice(from, to)
    const awaitAt = shutdown.indexOf('await Promise.all([\n    stopWhisperServer()')
    expect(awaitAt).toBeGreaterThan(-1)
    expect(shutdown.indexOf('stopWhisperPreviewServer({ final: true })')).toBeGreaterThan(awaitAt)
    expect(awaitAt).toBeLessThan(shutdown.indexOf('process.exit(0)'))
    expect(index.split('stopWhisperServer()').length - 1).toBe(1)
  })
})
