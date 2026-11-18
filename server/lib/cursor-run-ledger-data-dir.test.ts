// 7.0.57 (X1, 2026-11-18): the Cursor run ledger lives in the data folder, so a new installed generation still reads the
// runs an earlier one wrote. A "new generation" here is a fresh module graph (vi.resetModules) over the same COS_DATA_DIR.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let root = ''
beforeEach(() => {
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'cos-cursor-ledger-'))
  process.env.COS_DATA_DIR = root
  delete process.env.COS_CURSOR_RUN_LEDGER_FILE
})
afterEach(() => {
  delete process.env.COS_DATA_DIR
  delete process.env.COS_CURSOR_RUN_LEDGER_FILE
  rmSync(root, { recursive: true, force: true })
  vi.resetModules()
})

const startInput = { cosSessionId: 'session-1', model: 'composer' as any, cwd: '/tmp', query: 'q', cliModel: 'composer-test' }

it('the ledger is in the data folder, not next to the code', async () => {
  const ledger = await import('./cursor-run-ledger.js')
  expect(ledger.getCursorLedgerPath()).toBe(resolve(root, 'cursor-runs.jsonl'))
  expect(ledger.getCursorLedgerPath().startsWith(resolve(import.meta.dirname, '..'))).toBe(false)
})

it('a new generation still reads the runs an earlier one wrote', async () => {
  const first = await import('./cursor-run-ledger.js')
  const run = first.startCursorRun(startInput)
  first.finishCursorRun(run.runId, { status: 'failed', startedAtMs: Date.now() - 1000, error: 'No output for 180s' })
  vi.resetModules()
  const next = await import('./cursor-run-ledger.js')
  const read = next.getCursorRun(run.runId)
  expect(read).toMatchObject({ runId: run.runId, status: 'failed', cosSessionId: 'session-1' })
  expect(next.listCursorRuns(10).map(r => r.runId)).toContain(run.runId)
})

it('COS_CURSOR_RUN_LEDGER_FILE still wins', async () => {
  process.env.COS_CURSOR_RUN_LEDGER_FILE = join(root, 'elsewhere', 'runs.jsonl')
  const ledger = await import('./cursor-run-ledger.js')
  expect(ledger.getCursorLedgerPath()).toBe(resolve(root, 'elsewhere', 'runs.jsonl'))
})
