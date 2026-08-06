import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  G2_RESULT_PREFIX,
  buildExactG2SyncArgs,
  parseG2EnrichmentOutcome,
  runG2EnrichmentWithRetry,
  spawnG2SyncAttempt,
  type G2EnrichmentAttempt,
  type G2EnrichmentOptions,
} from './g2-enrichment-runner.js'

const options: G2EnrichmentOptions = {
  pythonBin: '/python',
  syncScript: '/scripts/sync_meetings.py',
  scriptsDir: '/scripts',
  meetingFile: '/operations/quilt/meetings/2026-07/meeting.md',
  env: {},
  retryDelaysMs: [0, 5, 30],
}

describe('exact G2 enrichment runner', () => {
  it('uses an argument array with the exact meeting path', () => {
    expect(buildExactG2SyncArgs(options.syncScript, options.meetingFile)).toEqual([
      options.syncScript,
      '--g2-only',
      '--g2-file',
      options.meetingFile,
      '--quiet',
    ])
  })

  it('adds the deterministic claim-only flag without changing exact-file pinning', () => {
    expect(buildExactG2SyncArgs(options.syncScript, options.meetingFile, true)).toEqual([
      options.syncScript,
      '--g2-only',
      '--g2-file',
      options.meetingFile,
      '--g2-claim-only',
      '--quiet',
    ])
  })

  it('imports a local durable recording inside the locked sync process', () => {
    expect(buildExactG2SyncArgs(options.syncScript, options.meetingFile, true, true)).toEqual([
      options.syncScript,
      '--g2-only',
      '--g2-import-file',
      options.meetingFile,
      '--g2-claim-only',
      '--quiet',
    ])
  })

  it('parses only complete verified outcome sentinels', () => {
    const payload = {
      status: 'enriched',
      path: '/operations/quilt/meetings/2026-07/customer-rollout.md',
      title: 'Customer Rollout Decision (G2)',
    }
    expect(parseG2EnrichmentOutcome(`noise\n${G2_RESULT_PREFIX}${JSON.stringify(payload)}\n`)).toEqual(payload)
    expect(parseG2EnrichmentOutcome(`${G2_RESULT_PREFIX}{bad json}`)).toBeNull()
    expect(parseG2EnrichmentOutcome(`${G2_RESULT_PREFIX}${JSON.stringify({ status: 'enriched' })}`)).toBeNull()
  })

  it('retries failed and false-success attempts before accepting verified output', async () => {
    const attempts: G2EnrichmentAttempt[] = [
      { code: 2, stdout: '', stderr: 'temporary LLM failure' },
      { code: 0, stdout: 'quiet success without sentinel', stderr: '' },
      {
        code: 0,
        stdout: `${G2_RESULT_PREFIX}${JSON.stringify({
          status: 'enriched',
          path: '/operations/quilt/meetings/2026-07/final.md',
          title: 'Final Meeting (G2)',
        })}`,
        stderr: '',
      },
    ]
    const runAttempt = vi.fn(async () => attempts.shift()!)
    const sleep = vi.fn(async () => {})

    const result = await runG2EnrichmentWithRetry(options, { runAttempt, sleep, fileExists: () => true })

    expect(result).toMatchObject({
      ok: true,
      attempts: 3,
      outcome: { status: 'enriched', title: 'Final Meeting (G2)' },
    })
    expect(runAttempt).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls).toEqual([[5], [30]])
  })

  it('returns a truthful terminal failure after exhausting the bounded schedule', async () => {
    const runAttempt = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))

    const result = await runG2EnrichmentWithRetry(
      { ...options, retryDelaysMs: [0, 1] },
      { runAttempt, sleep: async () => {} },
    )

    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(2)
    expect(result.error).toContain('without verified')
  })

  it('rejects a success sentinel when its saved path does not exist', async () => {
    const runAttempt = vi.fn(async () => ({
      code: 0,
      stdout: `${G2_RESULT_PREFIX}${JSON.stringify({
        status: 'enriched',
        path: '/operations/quilt/meetings/2026-07/missing.md',
        title: 'Missing Meeting (G2)',
      })}`,
      stderr: '',
    }))

    const result = await runG2EnrichmentWithRetry(
      { ...options, retryDelaysMs: [0] },
      { runAttempt, sleep: async () => {}, fileExists: () => false },
    )

    expect(result).toMatchObject({ ok: false, attempts: 1 })
    expect(result.error).toContain('missing or non-absolute path')
  })

  it('waits for a timed-out child to exit and escalates an ignored SIGTERM', async () => {
    if (process.platform === 'win32') return
    const temp = mkdtempSync(join(tmpdir(), 'cos-g2-runner-timeout-'))
    const script = join(temp, 'hang.mjs')
    const pidFile = join(temp, 'pid.txt')
    writeFileSync(script, `
      import { writeFileSync } from 'node:fs'
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
      process.on('SIGTERM', () => {})
      setInterval(() => {}, 1000)
    `)

    try {
      const started = Date.now()
      const attempt = await spawnG2SyncAttempt({
        ...options,
        pythonBin: process.execPath,
        syncScript: script,
        scriptsDir: temp,
        timeoutMs: 400,
        killGraceMs: 100,
      })
      const elapsed = Date.now() - started
      const pid = Number(readFileSync(pidFile, 'utf8'))

      expect(attempt.error).toContain('timed out after 400ms')
      expect(elapsed).toBeGreaterThanOrEqual(450)
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
})
