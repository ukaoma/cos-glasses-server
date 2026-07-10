import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CODEX_ENGINE_SESSION_TTL_MS,
  getCodexEngineSession,
  saveCodexEngineSession,
} from './codex-engine-sessions.js'

let tmp = ''

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cos-codex-sessions-'))
  process.env.COS_CODEX_ENGINE_SESSIONS_FILE = join(tmp, 'sessions.json')
})

afterEach(() => {
  delete process.env.COS_CODEX_ENGINE_SESSIONS_FILE
  rmSync(tmp, { recursive: true, force: true })
})

describe('Codex engine session migration and isolation', () => {
  it('keeps model and trust mode isolated', () => {
    saveCodexEngineSession({
      cosSessionId: 'session-1',
      model: 'codex-frontier',
      codexThreadId: 'thread-1',
      cwd: '/tmp/cos',
      trustMode: 'read-only',
    })
    expect(getCodexEngineSession({
      cosSessionId: 'session-1',
      model: 'codex-frontier',
      cwd: '/tmp/cos',
      trustMode: 'read-only',
    })?.codexThreadId).toBe('thread-1')
    expect(getCodexEngineSession({
      cosSessionId: 'session-1',
      model: 'codex-frontier',
      cwd: '/tmp/cos',
      trustMode: 'workspace-write',
    })).toBeNull()
  })

  it('migrates an unexpired legacy codex-high thread to frontier without changing trust', () => {
    const now = Date.now()
    writeFileSync(process.env.COS_CODEX_ENGINE_SESSIONS_FILE!, JSON.stringify({
      savedAt: new Date(now).toISOString(),
      sessions: {
        'legacy:codex-high': {
          key: 'legacy:codex-high',
          cosSessionId: 'legacy',
          model: 'codex-high',
          codexThreadId: 'legacy-thread',
          cwd: '/tmp/cos',
          trustMode: 'read-only',
          savedAt: now,
          lastUsedAt: now,
          expiresAt: new Date(now + CODEX_ENGINE_SESSION_TTL_MS).toISOString(),
        },
      },
    }))

    expect(getCodexEngineSession({
      cosSessionId: 'legacy',
      model: 'codex-frontier',
      cwd: '/tmp/cos',
      trustMode: 'read-only',
    })?.codexThreadId).toBe('legacy-thread')
  })
})
