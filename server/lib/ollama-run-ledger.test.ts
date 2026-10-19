// Key lanes K1 P5 (plan v4 9.1): the run ledger's `model` was generalized from
// OllamaModelPreference to a string, plus `lane`, so the direct lane can share the machinery.
// Ollama rows must stay byte for byte what 6.79.0 (6237057) wrote. The literal below was
// recorded by this same test against the unmodified 963fe25 ledger before the change.
import crypto from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { finishOllamaRun, startOllamaRun, listOllamaRuns } from './ollama-run-ledger.js'

const OLLAMA_GOLDEN = [
  '{"runId":"ollama-0a1b2c3d","ts":"2026-10-19T18:00:00.000Z","patch":{"runId":"ollama-0a1b2c3d","turnId":"turn-1","clientJobId":"job-1","cosSessionId":"sess-1","status":"running","createdAt":"2026-10-19T18:00:00.000Z","updatedAt":"2026-10-19T18:00:00.000Z","model":"ollama","ollamaModel":"qwen3.8:27b","origin":"http://127.0.0.1:11434","queryPreview":"what is on my calendar"}}',
  '{"runId":"ollama-0a1b2c3d","ts":"2026-10-19T18:00:02.500Z","patch":{"status":"completed","durationMs":2500,"outputPreview":"Two meetings.","updatedAt":"2026-10-19T18:00:02.500Z"}}',
  '{"runId":"ollama-0a1b2c3d","ts":"2026-10-19T18:00:03.000Z","patch":{"status":"failed","durationMs":3000,"errorCode":"ollama.tool_cap","errorPreview":"ollama-bridge: tool round cap reached","updatedAt":"2026-10-19T18:00:03.000Z"}}',
  '',
].join('\n')

describe('ollama run ledger rows (key lanes P5 generalization)', () => {
  let dir: string
  const prior = process.env.COS_OLLAMA_RUN_LEDGER_FILE

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cos-ollama-ledger-'))
    process.env.COS_OLLAMA_RUN_LEDGER_FILE = join(dir, 'ollama-runs.jsonl')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (prior === undefined) delete process.env.COS_OLLAMA_RUN_LEDGER_FILE
    else process.env.COS_OLLAMA_RUN_LEDGER_FILE = prior
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes Ollama rows byte for byte as 6.79.0 did', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-19T18:00:00.000Z'))
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('0a1b2c3d-0000-4000-8000-000000000000')
    const start = Date.now()
    const run = startOllamaRun({
      turnId: 'turn-1',
      clientJobId: 'job-1',
      cosSessionId: 'sess-1',
      ollamaModel: 'qwen3.8:27b',
      origin: 'http://127.0.0.1:11434',
      query: '  what is on \n my calendar ',
    })
    vi.setSystemTime(new Date('2026-10-19T18:00:02.500Z'))
    finishOllamaRun(run.runId, { status: 'completed', startedAtMs: start, output: 'Two meetings.' })
    vi.setSystemTime(new Date('2026-10-19T18:00:03.000Z'))
    finishOllamaRun(run.runId, { status: 'failed', startedAtMs: start, error: 'ollama-bridge: tool round cap reached' })
    expect(readFileSync(process.env.COS_OLLAMA_RUN_LEDGER_FILE!, 'utf8')).toBe(OLLAMA_GOLDEN)
  })

  it('an Ollama record carries no lane and reads back model "ollama"', () => {
    const run = startOllamaRun({ cosSessionId: 's', ollamaModel: 'm', origin: 'http://127.0.0.1:11434', query: 'q' })
    expect(run.model).toBe('ollama')
    expect('lane' in run).toBe(false)
    const listed = listOllamaRuns(5)
    expect(listed.map(r => r.runId)).toEqual([run.runId])
    expect('lane' in listed[0]!).toBe(false)
  })
})
