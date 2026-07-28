import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
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

interface LifecycleMocks {
  children?: FakeChild[]
  processSnapshots?: string[]
  portSnapshots?: number[][]
}

interface ProcessProbeOptions {
  timeout?: number
  maxBuffer?: number
}

type ProcessProbeError = Error & { code?: number | string }

function installLifecycleMocks(options: LifecycleMocks = {}) {
  const children = [...(options.children ?? [new FakeChild(500)])]
  const processSnapshots = [...(options.processSnapshots ?? ['', ''])]
  const portSnapshots = [...(options.portSnapshots ?? [[]])]
  let lastProcessSnapshot = processSnapshots.at(-1) ?? ''
  let lastPortSnapshot = portSnapshots.at(-1) ?? []

  const spawnMock = vi.fn(() => {
    const child = children.shift()
    if (!child) throw new Error('unexpected extra whisper-server spawn')
    return child
  })
  const execFileMock = vi.fn((
    file: string,
    _args: string[],
    _options: ProcessProbeOptions,
    callback: (error: ProcessProbeError | null, stdout: string, stderr: string) => void,
  ) => {
    if (file.endsWith('/ps') || file === 'ps') {
      if (processSnapshots.length > 0) lastProcessSnapshot = processSnapshots.shift()!
      callback(null, lastProcessSnapshot, '')
      return {} as any
    }
    if (file.endsWith('/lsof') || file === 'lsof') {
      if (portSnapshots.length > 0) lastPortSnapshot = portSnapshots.shift()!
      if (lastPortSnapshot.length === 0) {
      const err = new Error('no listeners') as ProcessProbeError
        err.code = 1
        callback(err, '', '')
        return {} as any
      }
      callback(null, `${lastPortSnapshot.join('\n')}\n`, '')
      return {} as any
    }
    callback(new Error(`unexpected executable: ${file}`), '', '')
    return {} as any
  })

  vi.doMock('node:child_process', () => ({
    spawn: spawnMock,
    execFile: execFileMock,
  }))
  vi.doMock('node:fs', async importOriginal => ({
    ...(await importOriginal<typeof import('node:fs')>()),
    existsSync: () => true,
  }))

  return { spawnMock, execFileMock }
}

describe('whisper-server health reconciliation', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.doUnmock('node:child_process')
    vi.doUnmock('node:fs')
    vi.resetModules()
  })

  it('does not count prompt chunks as failures while the model is still loading', async () => {
    installLifecycleMocks()
    let finishHealth!: (value: { ok: boolean }) => void
    const fetchMock = vi.fn(() => new Promise<{ ok: boolean }>(resolve => { finishHealth = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const { getWhisperHealth, startWhisperServer, transcribeLocal } = await import('./whisper-local.js')

    const startup = startWhisperServer()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await expect(transcribeLocal(Buffer.alloc(3200, 1))).rejects.toThrow(/starting/i)
    expect(getWhisperHealth()).toMatchObject({ server: false, restarting: true, consecutiveFailures: 0 })

    finishHealth({ ok: true })
    await startup
    expect(getWhisperHealth()).toMatchObject({ server: true, restarting: false, consecutiveFailures: 0 })
  })

  it('recovers from one timed-out inference without leaving availability latched false', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'recovered prompt chunk', segments: [] }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const { getWhisperHealth, transcribeLocal } = await import('./whisper-local.js')
    const audio = Buffer.alloc(3200, 1)

    await expect(transcribeLocal(audio)).rejects.toThrow(/whisper-server unavailable/i)
    expect(getWhisperHealth()).toMatchObject({ server: false, consecutiveFailures: 1 })

    await expect(transcribeLocal(audio)).resolves.toMatchObject({
      text: 'recovered prompt chunk',
      backend: 'server',
    })
    expect(getWhisperHealth()).toMatchObject({ server: true, consecutiveFailures: 0 })
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      'http://127.0.0.1:8178/health',
      'http://127.0.0.1:8178/inference',
      'http://127.0.0.1:8178/health',
      'http://127.0.0.1:8178/inference',
    ])
  })

  it('uses compact JSON and accepts a VAD-empty transcript without native verbose serialization', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const body = init.body as FormData
        expect(body.get('response_format')).toBe('json')
        return { ok: true, json: async () => ({ text: '' }) }
      })
    vi.stubGlobal('fetch', fetchMock)

    const { transcribeLocal } = await import('./whisper-local.js')
    await expect(transcribeLocal(Buffer.alloc(3200))).resolves.toMatchObject({
      text: '',
      backend: 'server',
    })
  })

  it('rejects malformed compact JSON instead of acknowledging false silence', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }))
    const { transcribeLocal } = await import('./whisper-local.js')
    await expect(transcribeLocal(Buffer.alloc(3200))).rejects.toThrow(/invalid compact JSON/i)
  })

  it('keeps meeting-save polish off live Metal', () => {
    // The 6.14.1 invariant is unchanged: batch polish must never fight live ASR
    // for the GPU. What changed is HOW it is enforced. 6.14.1 pinned batch to
    // CPU unconditionally, which taxed every idle polish too; the device is now
    // chosen per segment by whisper-metal-gate, which still yields CPU whenever
    // anything live contends AND whenever Metal is not explicitly opted in.
    const source = readFileSync(new URL('./whisper-local.ts', import.meta.url), 'utf8')
    expect(source).toContain('chooseBatchDevice()')
    expect(source).toContain("...(useMetal ? ['-fa'] : ['-ng'])")
    // CPU batch keeps 8 threads so it cannot starve live work of cores.
    expect(source).toContain("'-t', (isBatch && !useMetal) ? '8' : '16'")
    // Interactive HQ stays outside batch device policy.
    expect(source).toContain("{ device: 'metal', reason: 'interactive'")
    expect(source).toContain("const captureBatchWords = opts.priority === 'batch'")
    expect(source).toContain("args.push('-ojf', '-of', outBase)")
  })

  it('defaults meeting-save polish to CPU until Metal is explicitly opted in', async () => {
    // Behavioral guard on the same invariant: with COS_BATCH_HQ_METAL unset —
    // the shipped default — an idle machine must still choose CPU. This keeps
    // 6.14.1's protection in force until the meeting-to-meeting smoke passes,
    // and fails loudly if the default is flipped without doing that smoke.
    const priorMetal = process.env.COS_BATCH_HQ_METAL
    const priorForce = process.env.COS_BATCH_HQ_FORCE_CPU
    delete process.env.COS_BATCH_HQ_METAL
    delete process.env.COS_BATCH_HQ_FORCE_CPU
    try {
      const gate = await import('./whisper-metal-gate.js')
      gate.resetMetalGateForTests()
      gate.registerLiveActivityProbe(() => null)
      expect(gate.chooseBatchDevice()).toMatchObject({ device: 'cpu', reason: 'metal_opt_out' })
    } finally {
      if (priorMetal === undefined) delete process.env.COS_BATCH_HQ_METAL
      else process.env.COS_BATCH_HQ_METAL = priorMetal
      if (priorForce === undefined) delete process.env.COS_BATCH_HQ_FORCE_CPU
      else process.env.COS_BATCH_HQ_FORCE_CPU = priorForce
    }
  })

  it('serializes concurrent restarts and starts exactly one child', async () => {
    const { spawnMock } = installLifecycleMocks()
    let finishHealth!: (value: { ok: boolean }) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<{ ok: boolean }>(resolve => { finishHealth = resolve })))
    const { getWhisperHealth, restartWhisperServer } = await import('./whisper-local.js')

    const first = restartWhisperServer()
    const second = restartWhisperServer()
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    expect(getWhisperHealth()).toMatchObject({ restarting: true, server: false })

    finishHealth({ ok: true })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'recovered' },
      { status: 'recovered' },
    ])
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(getWhisperHealth()).toMatchObject({ restarting: false, server: true })
  })

  it('queues a restart behind an in-flight start before replacing the child', async () => {
    const firstChild = new FakeChild(500)
    const secondChild = new FakeChild(600)
    const modelPath = `${process.env.HOME}/.local/share/whisper-models/ggml-large-v3-turbo.bin`
    const { spawnMock } = installLifecycleMocks({
      children: [firstChild, secondChild],
      processSnapshots: [
        '',
        '',
        `500 100 /opt/homebrew/bin/whisper-server -m ${modelPath} --host 127.0.0.1 --port 8178\n`,
        '',
        '',
      ],
      portSnapshots: [[], []],
    })
    let finishInitialHealth!: (value: { ok: boolean }) => void
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<{ ok: boolean }>(resolve => { finishInitialHealth = resolve }))
      .mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const { getWhisperHealth, restartWhisperServer, startWhisperServer } = await import('./whisper-local.js')

    const start = startWhisperServer()
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    const restart = restartWhisperServer()
    await Promise.resolve()
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(getWhisperHealth()).toMatchObject({ restarting: true, server: false })

    finishInitialHealth({ ok: true })
    await start
    await expect(restart).resolves.toEqual({ status: 'recovered' })
    expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL')
    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(getWhisperHealth()).toMatchObject({ restarting: false, server: true })
  })

  it('kills a stale whisper-server tree before successful recovery', async () => {
    const modelPath = `${process.env.HOME}/.local/share/whisper-models/ggml-large-v3-turbo.bin`
    const { spawnMock } = installLifecycleMocks({
      processSnapshots: [
        `991 1 /opt/homebrew/bin/whisper-server -m ${modelPath} --host 127.0.0.1 --port 8178\n` +
          '992 991 /opt/homebrew/bin/whisper-worker\n',
        '',
        '',
      ],
    })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const { restartWhisperServer } = await import('./whisper-local.js')

    await expect(restartWhisperServer()).resolves.toEqual({ status: 'recovered' })

    expect(killSpy.mock.calls).toEqual([
      [992, 'SIGKILL'],
      [991, 'SIGKILL'],
    ])
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('never kills a diagnostic shell whose arguments merely mention the Whisper signature', async () => {
    const modelPath = `${process.env.HOME}/.local/share/whisper-models/ggml-large-v3-turbo.bin`
    const { spawnMock } = installLifecycleMocks({
      processSnapshots: [
        `991 1 /bin/zsh -lc grep whisper-server ${modelPath} --port 8178\n`,
        `991 1 /bin/zsh -lc grep whisper-server ${modelPath} --port 8178\n`,
      ],
    })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const { restartWhisperServer } = await import('./whisper-local.js')

    await expect(restartWhisperServer()).resolves.toEqual({ status: 'recovered' })
    expect(killSpy).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('fails closed with an actionable health error when the bounded process probe times out', async () => {
    const { spawnMock, execFileMock } = installLifecycleMocks()
    execFileMock.mockImplementation((
      file: string,
      _args: string[],
      options: ProcessProbeOptions,
      callback: (error: ProcessProbeError | null, stdout: string, stderr: string) => void,
    ) => {
      expect(file).toMatch(/\/ps$/)
      expect(options.timeout).toBe(2_000)
      expect(options.maxBuffer).toBe(1024 * 1024)
      const error = new Error('probe timed out') as ProcessProbeError
      error.code = 'ETIMEDOUT'
      callback(error, '', '')
      return {} as any
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { getWhisperHealth, startWhisperServer } = await import('./whisper-local.js')

    await expect(startWhisperServer()).rejects.toThrow(/unable to inspect process table.*timed out/i)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(logSpy.mock.calls.some(call => call.join(' ').includes('preflight: inspecting'))).toBe(true)
    expect(getWhisperHealth()).toMatchObject({
      server: false,
      restarting: false,
      startupState: 'failed',
      lastError: expect.stringMatching(/unable to inspect process table.*timed out/i),
    })
  })

  it('fails closed with an actionable health error when the bounded port probe times out', async () => {
    const { spawnMock, execFileMock } = installLifecycleMocks()
    execFileMock.mockImplementation((
      file: string,
      _args: string[],
      options: ProcessProbeOptions,
      callback: (error: ProcessProbeError | null, stdout: string, stderr: string) => void,
    ) => {
      expect(options.timeout).toBe(2_000)
      expect(options.maxBuffer).toBe(1024 * 1024)
      if (file.endsWith('/ps')) {
        callback(null, '', '')
      } else {
        const error = new Error('lsof probe timed out') as ProcessProbeError
        error.code = 'ETIMEDOUT'
        callback(error, '', '')
      }
      return {} as any
    })
    const { getWhisperHealth, startWhisperServer } = await import('./whisper-local.js')

    await expect(startWhisperServer()).rejects.toThrow(/unable to inspect whisper-server port 8178.*timed out/i)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(getWhisperHealth()).toMatchObject({
      startupState: 'failed',
      lastError: expect.stringMatching(/unable to inspect whisper-server port 8178.*timed out/i),
    })
  })

  it('fails closed without spawning while port 8178 remains occupied', async () => {
    vi.useFakeTimers()
    const { spawnMock } = installLifecycleMocks({
      processSnapshots: [
        '777 1 /opt/homebrew/bin/whisper-server -m /tmp/unrelated.bin --port 9999\n',
        '777 1 /opt/homebrew/bin/whisper-server -m /tmp/unrelated.bin --port 9999\n',
      ],
      portSnapshots: [[777]],
    })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const { getWhisperHealth, restartWhisperServer } = await import('./whisper-local.js')

    const restart = restartWhisperServer()
    await vi.runAllTimersAsync()
    await expect(restart).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/port 8178 remains occupied.*777/i),
    })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(killSpy).not.toHaveBeenCalled()
    expect(getWhisperHealth()).toMatchObject({ server: false, restarting: false })
  })

  it('cleans a failed start before allowing one recovery child', async () => {
    vi.useFakeTimers()
    const firstChild = new FakeChild(500)
    const secondChild = new FakeChild(600)
    const { spawnMock } = installLifecycleMocks({
      children: [firstChild, secondChild],
      processSnapshots: ['', '', '', '', '', ''],
      portSnapshots: [[], [], []],
    })
    let recovering = false
    const fetchMock = vi.fn(() => recovering
      ? Promise.resolve({ ok: true })
      : Promise.reject(new Error('connection refused')))
    vi.stubGlobal('fetch', fetchMock)
    const { getWhisperHealth, restartWhisperServer, startWhisperServer } = await import('./whisper-local.js')

    const failedStart = expect(startWhisperServer()).rejects.toThrow(/startup timeout/i)
    await vi.runAllTimersAsync()
    await failedStart
    expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL')
    expect(getWhisperHealth()).toMatchObject({ server: false, restarting: false })

    recovering = true
    await expect(restartWhisperServer()).resolves.toEqual({ status: 'recovered' })
    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(getWhisperHealth()).toMatchObject({ server: true, restarting: false })
  })

  it('reaps the owned child and descendants before replacing it', async () => {
    const firstChild = new FakeChild(500)
    const secondChild = new FakeChild(600)
    const modelPath = `${process.env.HOME}/.local/share/whisper-models/ggml-large-v3-turbo.bin`
    const { spawnMock } = installLifecycleMocks({
      children: [firstChild, secondChild],
      processSnapshots: [
        '',
        '',
        `500 100 /opt/homebrew/bin/whisper-server -m ${modelPath} --host 127.0.0.1 --port 8178\n` +
          '501 500 /opt/homebrew/bin/whisper-worker\n',
        '',
        '',
      ],
      portSnapshots: [[], []],
    })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    const { getWhisperHealth, restartWhisperServer, startWhisperServer } = await import('./whisper-local.js')

    await startWhisperServer()
    await expect(restartWhisperServer()).resolves.toEqual({ status: 'recovered' })

    expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL')
    expect(killSpy).toHaveBeenCalledWith(501, 'SIGKILL')
    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(getWhisperHealth()).toMatchObject({ server: true, restarting: false, consecutiveFailures: 0 })
  })
})
