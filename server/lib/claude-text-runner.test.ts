// 6.92.0 (plan r3, A-W0b): the isolated text runner. The argv is pinned, and the runner executes
// against a FAKE `claude` (a shell script named by COS_CLAUDE_BIN). No real CLI and no model call.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ClaudeTextError, claudeTextArgs, claudeTextEnv, runClaudeText } from './claude-text-runner.js'

let dir = ''
const OPTS = { model: 'sonnet', effort: 'low', timeoutMs: 5_000, systemPrompt: 'You revise drafts.', label: 'Prompt edit' }

function fake(body: string): void {
  const path = join(dir, 'claude')
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  process.env.COS_CLAUDE_BIN = path
}

describe('6.92.0 claude text runner', () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cos-claude-text-test-')) })
  afterEach(() => {
    delete process.env.COS_CLAUDE_BIN
    rmSync(dir, { recursive: true, force: true })
  })

  it('isolation pin: no tools, no MCP, no hooks in exactly one --settings, no session, the model always named', () => {
    const args = claudeTextArgs('sonnet', 'low', 'System.')
    expect(args).toEqual([
      '-p', '--model', 'sonnet', '--effort', 'low', '--output-format', 'text',
      '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--tools', '', '--settings', '{"disableAllHooks":true}', '--permission-mode', 'dontAsk',
      '--system-prompt', 'System.',
    ])
    expect(args.filter(a => a === '--settings')).toHaveLength(1)
  })

  it('keeps the environment as spawnClaudeText did (API-key sign-in keeps working), minus CLAUDECODE', () => {
    const env = claudeTextEnv('/opt/fake/bin/claude', { ANTHROPIC_API_KEY: 'k', CLAUDECODE: '1', PATH: '/usr/bin' })
    expect(env.ANTHROPIC_API_KEY).toBe('k')
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.PATH!.startsWith('/opt/fake/bin:')).toBe(true)
  })

  it('runs the binary with that argv in a scratch directory, the prompt on stdin, and returns the answer', async () => {
    fake(`printf '%s\\n' "$@" > "${dir}/argv"; pwd > "${dir}/cwd"; cat > "${dir}/stdin"; echo "  Revised prompt.  "`)
    expect(await runClaudeText('Fix the draft', OPTS)).toBe('Revised prompt.')
    const argv = readFileSync(join(dir, 'argv'), 'utf8').split('\n').slice(0, -1)
    expect(argv).toEqual(claudeTextArgs('sonnet', 'low', 'You revise drafts.'))
    expect(readFileSync(join(dir, 'stdin'), 'utf8')).toBe('Fix the draft')
    const cwd = readFileSync(join(dir, 'cwd'), 'utf8').trim()
    expect(cwd).toMatch(/cos-claude-text-[^/]+\/workspace$/)
    expect(cwd).not.toBe(process.cwd())
  })

  it('a failure rejects with a code only, never the CLI output', async () => {
    fake('echo "secret draft words" >&2; echo "more draft words"; exit 3')
    const err = await runClaudeText('Fix the draft', OPTS).catch(e => e)
    expect(err).toBeInstanceOf(ClaudeTextError)
    expect(err.code).toBe('failed')
    expect(err.message).toBe('Prompt edit failed')
  })

  it('empty output, a timeout and an abort each have their code', async () => {
    fake('exit 0')
    expect((await runClaudeText('x', OPTS).catch(e => e)).code).toBe('empty')
    fake('sleep 5')
    expect((await runClaudeText('x', { ...OPTS, timeoutMs: 100 }).catch(e => e)).code).toBe('timeout')
    const controller = new AbortController()
    const pending = runClaudeText('x', { ...OPTS, signal: controller.signal }).catch(e => e)
    setTimeout(() => controller.abort(), 50)
    expect((await pending).code).toBe('aborted')
  })
})
