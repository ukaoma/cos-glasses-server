import express from 'express'
import type { Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const TOKEN = 'test-cli-debug-token'
let root = ''
let server: Server
let base = ''
let privateValues: string[] = []

function expectNoForbiddenKeys(value: unknown): void {
  const forbidden = new Set([
    'cwd', 'clicommand', 'trustmode', 'querypreview', 'outputpreview',
    'errorpreview', 'resumecommand', 'clisessionid', 'codexthreadid',
    'cossessionid', 'turnid', 'clientjobid', 'pid', 'env', 'token',
  ])
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit)
      return
    }
    if (!candidate || typeof candidate !== 'object') return
    for (const [key, nested] of Object.entries(candidate as Record<string, unknown>)) {
      expect(forbidden.has(key.toLowerCase()), `forbidden response key: ${key}`).toBe(false)
      visit(nested)
    }
  }
  visit(value)
}

function expectNoPrivateValues(value: unknown): void {
  const serialized = JSON.stringify(value)
  for (const privateValue of privateValues) {
    expect(serialized).not.toContain(privateValue)
  }
}

async function request(path: string, authenticated = true): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: authenticated ? { 'x-cos-token': TOKEN } : {},
  })
}

beforeAll(async () => {
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'cos-public-cli-debug-'))
  process.env.COS_CLAUDE_RUN_LEDGER_FILE = join(root, 'claude-runs.jsonl')
  process.env.COS_CODEX_RUN_LEDGER_FILE = join(root, 'codex-runs.jsonl')
  process.env.COS_CLAUDE_RUN_CONTENT_PREVIEWS = '1'
  process.env.COS_CODEX_RUN_CONTENT_PREVIEWS = '1'

  const claude = await import('../lib/claude-run-ledger.js')
  const claudeRun = claude.startClaudeRun({
    cosSessionId: 'private-claude-session',
    cliSessionId: 'private-claude-cli-session',
    model: 'opus',
    cwd: join(root, 'private-workspace'),
    resumed: true,
    timeoutMs: 1_000,
    wallMaxMs: 2_000,
    query: 'private Claude prompt with a secret',
    effortLevel: 'max',
    cliModelId: 'opus[1m]',
  })
  claude.updateClaudeRun(claudeRun.runId, { resolvedModelId: 'claude-opus-4-8[1m]' })
  claude.finishClaudeRun(claudeRun.runId, {
    status: 'failed',
    startedAtMs: Date.now() - 500,
    error: 'Unauthorized private Claude failure detail',
    exitCode: 1,
  })

  const codex = await import('../lib/codex-run-ledger.js')
  const codexRun = codex.startCodexRun({
    cosSessionId: 'private-codex-session',
    model: 'codex-frontier',
    cliModel: 'gpt-5.6-sol',
    reasoningEffort: 'ultra',
    cwd: join(root, 'private-workspace'),
    ephemeral: false,
    resumed: true,
    codexThreadId: 'private-codex-thread',
    query: 'private Codex prompt with a secret',
  })
  codex.finishCodexRun(codexRun.runId, {
    status: 'completed',
    startedAtMs: Date.now() - 750,
    output: 'private Codex output with a secret',
    exitCode: 0,
  })

  privateValues = [
    root,
    claudeRun.runId,
    codexRun.runId,
    'private-claude-session',
    'private-claude-cli-session',
    'private-codex-session',
    'private-codex-thread',
    'private Claude prompt with a secret',
    'Unauthorized private Claude failure detail',
    'private Codex prompt with a secret',
    'private Codex output with a secret',
  ]

  const { cliDebugRouter } = await import('./cli-debug.js')
  const app = express()
  app.use('/api', (req, res, next) => {
    if (req.headers['x-cos-token'] !== TOKEN) {
      return res.status(401).json({ error: 'unauthorized' })
    }
    next()
  })
  app.use('/api', cliDebugRouter)
  server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  delete process.env.COS_CLAUDE_RUN_LEDGER_FILE
  delete process.env.COS_CODEX_RUN_LEDGER_FILE
  delete process.env.COS_CLAUDE_RUN_CONTENT_PREVIEWS
  delete process.env.COS_CODEX_RUN_CONTENT_PREVIEWS
  rmSync(root, { recursive: true, force: true })
  vi.resetModules()
})

describe('public CLI debug contract', () => {
  it('is registered behind the global API authentication boundary', () => {
    const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const authStart = indexSource.indexOf("app.use('/api', (req, res, next) =>")
    const routeRegistration = indexSource.indexOf("app.use('/api', cliDebugRouter)")
    expect(authStart).toBeGreaterThanOrEqual(0)
    expect(routeRegistration).toBeGreaterThan(authStart)

    const publicAllowlist = indexSource.slice(authStart, routeRegistration)
    expect(publicAllowlist).not.toContain("req.path === '/cli/debug'")
    expect(publicAllowlist).not.toContain("req.path === '/cli/runs'")
    expect(publicAllowlist).not.toContain("req.path === '/codex/runs'")
  })

  it.each(['/api/cli/debug', '/api/cli/runs', '/api/codex/runs'])(
    'keeps %s authenticated',
    async path => {
      expect((await request(path, false)).status).toBe(401)
    },
  )

  it('returns the exact versioned combined provider shape', async () => {
    const response = await request('/api/cli/debug')
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body).toEqual({
      schemaVersion: 1,
      providers: {
        claude: {
          supported: true,
          persistenceEnabled: true,
          workspaceConfigured: true,
          latestRun: expect.objectContaining({
            status: 'failed',
            model: 'opus',
            concreteModel: 'claude-opus-4-8[1m]',
            effort: 'max',
            resumed: true,
            errorCode: 'claude.auth_error',
          }),
        },
        codex: {
          supported: true,
          persistenceEnabled: true,
          workspaceConfigured: true,
          latestRun: expect.objectContaining({
            status: 'completed',
            model: 'codex-frontier',
            concreteModel: 'gpt-5.6-sol',
            effort: 'ultra',
            resumed: true,
          }),
        },
      },
    })
    expectNoForbiddenKeys(body)
    expectNoPrivateValues(body)
  })

  it('collapses an unrecognized ledger error code to a provider-safe category', async () => {
    const { safeClaudeLatestRun, safeCodexLatestRun } = await import('../lib/cli-debug-view.js')
    expect(safeClaudeLatestRun({
      status: 'failed',
      model: 'opus',
      errorCode: 'private-ledger-value',
    } as any)?.errorCode).toBe('claude.error')
    expect(safeCodexLatestRun({
      status: 'failed',
      model: 'codex-frontier',
      errorCode: 'private-ledger-value',
    } as any)?.errorCode).toBe('codex.error')
  })

  it.each(['/api/cli/runs?limit=50', '/api/codex/runs?limit=50'])(
    'keeps the build-210 compatibility view metadata-only at %s',
    async path => {
      const response = await request(path)
      expect(response.status).toBe(200)
      const body = await response.json() as any
      expect(body.schemaVersion).toBe(1)
      expect(body.config.cwd).toBe('Configured workspace')
      expect(body.config.contentPreviewsEnabled).toBe(false)
      expect(body.runs).toHaveLength(1)
      expect(body.runs[0]).not.toHaveProperty('runId')
      expectNoPrivateValues(body)
      // Legacy cwd is a fixed display label, never a filesystem path. Every
      // other forbidden key remains absent recursively.
      const withoutDisplayCwd = structuredClone(body)
      delete withoutDisplayCwd.config.cwd
      expectNoForbiddenKeys(withoutDisplayCwd)
    },
  )

  it('normalizes poisoned values even when they occupy allowlisted fields', async () => {
    const { safeClaudeLatestRun, safeCodexLatestRun } = await import('../lib/cli-debug-view.js')
    const poison = `${root}/secret-command --token private-token`
    const invalidTimestamp = 'not-a-date-private-value'
    const claude = safeClaudeLatestRun({
      status: poison,
      model: poison,
      resolvedModelId: poison,
      effortLevel: poison,
      resumed: poison,
      durationMs: -5,
      updatedAt: invalidTimestamp,
      errorCode: poison,
    } as any)
    const codex = safeCodexLatestRun({
      status: poison,
      model: poison,
      cliModel: poison,
      reasoningEffort: poison,
      resumed: poison,
      durationMs: Number.POSITIVE_INFINITY,
      updatedAt: invalidTimestamp,
      errorCode: poison,
    } as any)
    expect(claude).toEqual({
      status: 'failed',
      model: 'unknown',
      resumed: false,
      updatedAt: new Date(0).toISOString(),
      errorCode: 'claude.error',
    })
    expect(codex).toEqual({
      status: 'failed',
      model: 'unknown',
      resumed: false,
      updatedAt: new Date(0).toISOString(),
      errorCode: 'codex.error',
    })
    expectNoPrivateValues({ claude, codex })
    expect(JSON.stringify({ claude, codex })).not.toContain(poison)
    expect(JSON.stringify({ claude, codex })).not.toContain(invalidTimestamp)
  })
})
