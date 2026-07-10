import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
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
})

afterEach(() => {
  delete process.env.COS_CODEX_RUN_LEDGER_FILE
  delete process.env.COS_CODEX_SANDBOX
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
