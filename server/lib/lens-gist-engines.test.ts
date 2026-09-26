// The lens-gist engine runners, executed: a real child process for the timeout and exit
// paths, and the real Ollama path against a fake fetch. /qa round 1 found these untested.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const audit = vi.fn()

beforeEach(() => {
  audit.mockReset()
  vi.resetModules()
  vi.doMock('./token-audit.js', () => ({ logTokenAudit: audit }))
})

afterEach(() => {
  vi.doUnmock('./token-audit.js')
  vi.resetModules()
})

describe('runProcess', () => {
  it('kills a process past its timeout and says so', async () => {
    const { runProcess } = await import('./lens-gist-engines.js')
    const started = Date.now()
    await expect(runProcess('/bin/sleep', ['5'], { stdin: '', cwd: '/tmp', timeoutMs: 150, label: 'sleep' })).rejects.toThrow(/sleep timed out after 150 ms/)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('returns a non-zero exit with its output, for the caller to judge', async () => {
    const { runProcess } = await import('./lens-gist-engines.js')
    const result = await runProcess('/bin/sh', ['-c', 'cat; echo err >&2; exit 3'], { stdin: 'hello', cwd: '/tmp', timeoutMs: 5_000, label: 'sh' })
    expect(result).toEqual({ code: 3, stdout: 'hello', stderr: 'err\n' })
  })
})

describe('the child environment', () => {
  it('carries no server token and no CLAUDECODE, and can find the binary\'s own interpreter', async () => {
    const { lensGistChildEnv } = await import('./lens-gist-engines.js')
    const saved = { token: process.env.COS_API_TOKEN, cc: process.env.CLAUDECODE }
    try {
      process.env.COS_API_TOKEN = 'server-secret-token'
      process.env.CLAUDECODE = '1'
      const env = lensGistChildEnv('/opt/tools/bin/claude')
      expect(env.COS_API_TOKEN).toBeUndefined()
      expect(env.CLAUDECODE).toBeUndefined()
      expect(env.PATH?.split(':')[0]).toBe('/opt/tools/bin')
    } finally {
      if (saved.token === undefined) delete process.env.COS_API_TOKEN; else process.env.COS_API_TOKEN = saved.token
      if (saved.cc === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = saved.cc
    }
  })
})

describe('Ollama, and the token audit on every engine call', () => {
  it('asks /api/generate with no thinking and a warm model, and audits the call', async () => {
    const catalog = await import('./ollama-catalog.js')
    const calls: Array<{ url: string; body: any }> = []
    catalog._setOllamaCatalogFetchForTests((async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(JSON.stringify({ response: 'Outcome: done', prompt_eval_count: 300, eval_count: 20 }), { status: 200 })
    }) as typeof fetch)
    const { runLensGistEngine } = await import('./lens-gist-engines.js')
    const run = await runLensGistEngine('ollama', 'qwen3.8:27b', 'PROMPT', { timeoutMs: 5_000, system: 'SYS' })
    expect(run).toMatchObject({ text: 'Outcome: done', model: 'qwen3.8:27b', usage: { inputTokens: 300, outputTokens: 20 } })
    expect(calls[0].url).toMatch(/\/api\/generate$/)
    expect(calls[0].body).toMatchObject({ model: 'qwen3.8:27b', prompt: 'PROMPT', system: 'SYS', stream: false, think: false, keep_alive: '30m' })
    expect(audit).toHaveBeenCalledTimes(1)
    expect(audit.mock.calls[0][0]).toMatchObject({ source: 'g2-lens-gist', caller: 'lens_gist', model: 'ollama:qwen3.8:27b', inputChars: 'PROMPT'.length + 'SYS'.length, outputChars: 'Outcome: done'.length })
    catalog._setOllamaCatalogFetchForTests(null)
  })

  it('audits a failed call too, with nothing written back', async () => {
    const catalog = await import('./ollama-catalog.js')
    catalog._setOllamaCatalogFetchForTests((async () => new Response('boom', { status: 500 })) as unknown as typeof fetch)
    const { runLensGistEngine } = await import('./lens-gist-engines.js')
    await expect(runLensGistEngine('ollama', 'qwen', 'P', { timeoutMs: 5_000, system: 'S' })).rejects.toThrow(/ollama answered 500/)
    expect(audit).toHaveBeenCalledTimes(1)
    expect(audit.mock.calls[0][0]).toMatchObject({ source: 'g2-lens-gist', model: 'ollama:qwen', outputChars: 0 })
    catalog._setOllamaCatalogFetchForTests(null)
  })
})

describe('a provider limit, read from a real process the way Claude Code reports it', () => {
  const LIMIT = "You've hit your session limit · resets 11:40am (America/Chicago)"

  async function withFakeClaude(script: string, fn: () => Promise<void>) {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'cos-fake-claude-'))
    const bin = join(dir, 'claude')
    writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\n${script}\n`)
    chmodSync(bin, 0o755)
    const saved = process.env.COS_CLAUDE_BIN
    process.env.COS_CLAUDE_BIN = bin
    try {
      await fn()
    } finally {
      if (saved === undefined) delete process.env.COS_CLAUDE_BIN; else process.env.COS_CLAUDE_BIN = saved
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('the limit on STDOUT with other noise on stderr and exit 1 is a limit (Claude Code prints it there)', async () => {
    await withFakeClaude(`echo "${LIMIT}"\necho "warning: something unrelated" >&2\nexit 1`, async () => {
      const { runLensGistEngine, LensGistLimitError } = await import('./lens-gist-engines.js')
      const err = await runLensGistEngine('claude', 'sonnet', 'P', { timeoutMs: 5_000, system: 'S' }).catch(e => e)
      expect(err).toBeInstanceOf(LensGistLimitError)
      expect(String(err.message)).toMatch(/session limit/)
    })
  })

  it('a JSON result marked as an error that says the limit is spent is a limit too', async () => {
    const json = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: LIMIT })
    await withFakeClaude(`echo '${json.replace(/'/g, "'\\''")}'\nexit 0`, async () => {
      const { runLensGistEngine, LensGistLimitError } = await import('./lens-gist-engines.js')
      const err = await runLensGistEngine('claude', 'sonnet', 'P', { timeoutMs: 5_000, system: 'S' }).catch(e => e)
      expect(err).toBeInstanceOf(LensGistLimitError)
    })
  })

  it('any other failure is an ordinary failure', async () => {
    await withFakeClaude(`echo "Error: model not found" >&2\nexit 1`, async () => {
      const { runLensGistEngine, LensGistLimitError } = await import('./lens-gist-engines.js')
      const err = await runLensGistEngine('claude', 'nope', 'P', { timeoutMs: 5_000, system: 'S' }).catch(e => e)
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(LensGistLimitError)
      expect(String(err.message)).toMatch(/claude exited 1: Error: model not found/)
    })
  })
})
