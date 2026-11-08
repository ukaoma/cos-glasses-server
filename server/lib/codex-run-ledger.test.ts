import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  classifyCodexError,
  codexTerminalUsageLimitError,
  finishCodexRun,
  safeCodexUsageLimitMessage,
  getCodexRun,
  getCodexRunConfig,
  getCodexTrustMode,
  startCodexRun,
} from './codex-run-ledger.js'

let tmp = ''

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cos-codex-ledger-'))
  process.env.COS_CODEX_RUN_LEDGER_FILE = join(tmp, 'runs.jsonl')
  delete process.env.COS_CODEX_SANDBOX
  delete process.env.COS_CODEX_RUN_CONTENT_PREVIEWS
})

afterEach(() => {
  delete process.env.COS_CODEX_RUN_LEDGER_FILE
  delete process.env.COS_CODEX_SANDBOX
  delete process.env.COS_CODEX_RUN_CONTENT_PREVIEWS
  rmSync(tmp, { recursive: true, force: true })
})

describe('Codex run diagnostics', () => {
  it('records the concrete live model and clamped effort without content by default', () => {
    const run = startCodexRun({
      cosSessionId: 'session-1',
      model: 'codex-frontier',
      cliModel: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
      cwd: '/tmp/cos',
      ephemeral: true,
      query: 'private user prompt',
    })
    const saved = getCodexRun(run.runId)
    expect(saved?.cliModel).toBe('gpt-5.6-sol')
    expect(saved?.reasoningEffort).toBe('ultra')
    expect(saved?.queryPreview).toBeUndefined()
  })

  it('reports only the public trust modes', () => {
    expect(getCodexTrustMode()).toBe('read-only')
    expect(getCodexRunConfig().trustMode).toBe('read-only')
    process.env.COS_CODEX_SANDBOX = 'workspace-write'
    expect(getCodexTrustMode()).toBe('workspace-write')
  })
})

describe('Codex quota diagnostics boundary', () => {
  const fallback = 'Codex usage limit reached. Try again later or choose another model.'

  it('persists provider_limit without terminal content in the default ledger', () => {
    const run = startCodexRun({ cosSessionId: 'quota', model: 'codex-frontier', cwd: '/tmp', ephemeral: true, query: 'private' })
    const message = codexTerminalUsageLimitError({
      type: 'turn.failed',
      error: { codex_error_info: 'usage_limit_exceeded', message: 'secret sk-private-user-content' },
    })
    expect(message).toBe(fallback)
    finishCodexRun(run.runId, { status: 'failed', startedAtMs: Date.now(), error: message })
    const saved = getCodexRun(run.runId)
    expect(saved?.errorCode).toBe('provider_limit')
    expect(saved?.errorPreview).toBeUndefined()
  })

  it('keeps terminal secrets out of an explicitly enabled error preview', () => {
    process.env.COS_CODEX_RUN_CONTENT_PREVIEWS = '1'
    const run = startCodexRun({ cosSessionId: 'quota-preview', model: 'codex-frontier', cwd: '/tmp', ephemeral: true, query: 'example' })
    const message = codexTerminalUsageLimitError({
      type: 'error', codex_error_info: 'usage_limit_exceeded',
      message: 'Bearer sk-private https://private.invalid Try again at Nov 10, 2026 9:28 AM',
    })
    finishCodexRun(run.runId, { status: 'failed', startedAtMs: Date.now(), error: message })
    const saved = getCodexRun(run.runId)
    expect(saved?.errorCode).toBe('provider_limit')
    expect(saved?.errorPreview).toBe('Codex usage limit reached. Try again at Nov 10, 2026 9:28 AM (provider time), or choose another model.')
  })

  it.each([
    null,
    { type: 'item.completed', codex_error_info: 'usage_limit_exceeded' },
    { type: 'turn.failed', error: { codex_error_info: 'unauthorized', message: 'usage limit exceeded' } },
    { type: 'error', message: 'A normal answer mentioning usage_limit_exceeded' },
  ])('does not treat unstructured or nonterminal content as a structured quota event: %j', event => {
    expect(codexTerminalUsageLimitError(event)).toBeUndefined()
  })

  it('normalizes a calendar-valid retry date without exposing adjacent provider text', () => {
    const message = safeCodexUsageLimitMessage('Bearer sk-private. Resets at February 29th, 2028 12:05 pm. /Users/private https://secret.invalid')
    expect(message).toBe('Codex usage limit reached. Try again at Feb 29, 2028 12:05 PM (provider time), or choose another model.')
    expect(message.length).toBeLessThan(160)
    expect(safeCodexUsageLimitMessage(message)).toBe(message)
  })

  it.each([
    'Try again at Feb 29, 2027 9:00 AM',
    'Try again at Apr 31, 2027 9:00 AM',
    'Try again at Nov 10, 2026 0:00 AM',
    'Try again at Nov 10, 2026 13:00 PM',
    'Try again at Nov 10, 2026 9:60 AM',
    'Try again at Nov 10, 9999 9:00 AM',
    'Try again later. Bearer sk-private',
    'x'.repeat(8000) + ' Try again at Nov 10, 2026 9:00 AM',
  ])('uses fixed safe fallback for invalid or unbounded retry detail', message => {
    expect(safeCodexUsageLimitMessage(message)).toBe(fallback)
  })

  it.each([
    ['codex-bridge: authentication required.', 'codex.auth_error'],
    ['Sandbox permission denied', 'codex.permission_denied'],
    ['command not found', 'codex.cli_unavailable'],
    ['wall clock timeout', 'codex.timeout'],
    ['exit 2', 'codex.nonzero_exit'],
  ])('preserves existing classification for %s', (message, code) => {
    expect(classifyCodexError(message)).toBe(code)
  })
})
