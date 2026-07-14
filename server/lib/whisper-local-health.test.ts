import { afterEach, describe, expect, it, vi } from 'vitest'

describe('whisper-server health reconciliation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('node:fs')
    vi.resetModules()
  })

  it('does not count prompt chunks as failures while the model is still loading', async () => {
    vi.doMock('node:fs', async importOriginal => ({
      ...(await importOriginal<typeof import('node:fs')>()),
      existsSync: () => true,
    }))
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
})
