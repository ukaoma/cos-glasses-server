import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The dedicated spawn is exercised against a fake `agent` shell script so the
// stream-json parse, the exit-0 auth detection, and the failure taxonomy run
// for real — no mocked child_process.

let fakeDir: string
let fakeAgent: string

const assistantEvent = (text: string) => JSON.stringify({
  type: 'assistant',
  timestamp_ms: 1,
  message: { content: [{ text }] },
})

function writeFakeAgent(script: string): void {
  writeFileSync(fakeAgent, `#!/bin/sh\n${script}\n`)
  chmodSync(fakeAgent, 0o755)
}

async function freshComposerAsk(binary?: () => string | undefined) {
  vi.resetModules()
  vi.doMock('./cursor-model-catalog.js', () => ({
    resolveAgentBinary: binary ?? (() => fakeAgent),
  }))
  // Tests must not write into the real token ledger.
  vi.doMock('./token-audit.js', () => ({ logTokenAudit: () => {} }))
  const { composerAsk } = await import('./live-cues-cursor.js')
  return composerAsk
}

async function unavailableComposerAsk() {
  return freshComposerAsk(() => undefined)
}

describe('composerAsk (dedicated spawn)', () => {
  beforeEach(() => {
    fakeDir = mkdtempSync(join(tmpdir(), 'live-cues-agent-'))
    fakeAgent = join(fakeDir, 'agent')
    // Imports below pull conversation/profile modules transitively. Keep their
    // module-load reconciliation out of the user's real COS data home.
    process.env.COS_DATA_DIR = join(fakeDir, 'data')
    process.env.COS_PROFILE_PATH = join(fakeDir, 'profile.json')
  })

  afterEach(() => {
    rmSync(fakeDir, { recursive: true, force: true })
    vi.doUnmock('./cursor-model-catalog.js')
    vi.doUnmock('./token-audit.js')
    delete process.env.COS_DATA_DIR
    delete process.env.COS_PROFILE_PATH
  })

  it('returns assistant delta text from stream-json on success', async () => {
    writeFakeAgent(`cat >/dev/null\necho '${assistantEvent('{"query":"pricing history","entity":null}')}'`)
    const composerAsk = await freshComposerAsk()
    const result = await composerAsk({ prompt: 'p', modelId: 'composer-2.5-fast', caller: 'live-cues-planner', timeoutMs: 10_000 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.text).toBe('{"query":"pricing history","entity":null}')
  })

  it('treats exit-0 auth text as failure, never as an answer', async () => {
    // Cursor can report auth failures as successful output with exit 0 —
    // exit code alone cannot catch this, and missing it renders
    // "authentication required" on the lens as a coaching cue.
    writeFakeAgent(`cat >/dev/null\necho '${assistantEvent('Error: 401 unauthorized — please run agent login')}'`)
    const composerAsk = await freshComposerAsk()
    const result = await composerAsk({ prompt: 'p', modelId: 'composer-2.5-fast', caller: 'live-cues-planner', timeoutMs: 10_000 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.authFailure).toBe(true)
      expect(result.reason).toBe('cursor.auth_error')
    }
  })

  it('reports empty output as failure', async () => {
    writeFakeAgent('cat >/dev/null\nexit 0')
    const composerAsk = await freshComposerAsk()
    const result = await composerAsk({ prompt: 'p', modelId: 'composer-2.5-fast', caller: 'live-cues-planner', timeoutMs: 10_000 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('cursor.empty_response')
  })

  it('reports non-zero exit as failure', async () => {
    writeFakeAgent('cat >/dev/null\necho boom >&2\nexit 3')
    const composerAsk = await freshComposerAsk()
    const result = await composerAsk({ prompt: 'p', modelId: 'composer-2.5-fast', caller: 'live-cues-planner', timeoutMs: 10_000 })
    expect(result.ok).toBe(false)
  })

  it('kills a hung spawn at the timeout and reports the tree state', async () => {
    writeFakeAgent('cat >/dev/null\nsleep 30')
    const composerAsk = await freshComposerAsk()
    const started = Date.now()
    const result = await composerAsk({ prompt: 'p', modelId: 'composer-2.5-fast', caller: 'live-cues-insight', timeoutMs: 1_000 })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('cursor.timeout')
      // A trivially-killable tree must be proven dead so the caller can
      // release its maintenance lease.
      expect(result.treeClosed).toBe(true)
    }
  })

  it('fails closed when no agent binary resolves', async () => {
    const composerAsk = await unavailableComposerAsk()
    const result = await composerAsk({ prompt: 'p', modelId: 'composer-2.5-fast', caller: 'live-cues-planner', timeoutMs: 10_000 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('cursor.cli_unavailable')
  })
})
