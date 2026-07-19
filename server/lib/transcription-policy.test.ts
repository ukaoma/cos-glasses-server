import { afterEach, describe, expect, it, vi } from 'vitest'

const getKeyStatus = vi.fn()

vi.mock('./openai-key.js', () => ({ getKeyStatus }))

afterEach(() => {
  delete process.env.COS_OPENAI_WHISPER_FALLBACK
  getKeyStatus.mockReset()
})

describe('local-first transcription policy', () => {
  it('stays local-only when a key exists but fallback was not explicitly enabled', async () => {
    getKeyStatus.mockReturnValue({ hasKey: true, source: 'env' })
    const { getTranscriptionPolicySnapshot } = await import('./transcription-policy.js')
    expect(getTranscriptionPolicySnapshot()).toEqual({
      mode: 'local-only',
      localRequired: true,
      openaiFallbackConfigured: false,
      openaiFallbackReady: false,
    })
  })

  it('does not become ready when the flag is set without a key', async () => {
    process.env.COS_OPENAI_WHISPER_FALLBACK = '1'
    getKeyStatus.mockReturnValue({ hasKey: false, source: 'none' })
    const { getTranscriptionPolicySnapshot } = await import('./transcription-policy.js')
    expect(getTranscriptionPolicySnapshot()).toMatchObject({
      mode: 'local-only',
      openaiFallbackConfigured: true,
      openaiFallbackReady: false,
    })
  })

  it('allows fallback only when the exact flag and a key are both present', async () => {
    process.env.COS_OPENAI_WHISPER_FALLBACK = '1'
    getKeyStatus.mockReturnValue({ hasKey: true, source: 'env' })
    const { getTranscriptionPolicySnapshot } = await import('./transcription-policy.js')
    expect(getTranscriptionPolicySnapshot()).toMatchObject({
      mode: 'local-then-openai',
      openaiFallbackConfigured: true,
      openaiFallbackReady: true,
    })
  })

  it('rejects truthy spellings other than the documented exact value', async () => {
    process.env.COS_OPENAI_WHISPER_FALLBACK = 'true'
    getKeyStatus.mockReturnValue({ hasKey: true, source: 'env' })
    const { getTranscriptionPolicySnapshot } = await import('./transcription-policy.js')
    expect(getTranscriptionPolicySnapshot().openaiFallbackReady).toBe(false)
  })
})
