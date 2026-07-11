import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'

const isolatedDataDir = vi.hoisted(() => {
  const dir = `/tmp/cos-glasses-server-codex-bridge-${process.pid}`
  process.env.COS_DATA_DIR = dir
  return dir
})
import { buildCodexExecArgs, extractCodexResponseText } from './codex-bridge.js'

afterAll(() => {
  delete process.env.COS_DATA_DIR
  rmSync(isolatedDataDir, { recursive: true, force: true })
})

const frontier = {
  preference: 'codex-frontier' as const,
  id: 'gpt-5.6-sol',
  displayName: 'GPT-5.6 Sol',
  description: 'Frontier',
  hidden: false,
  supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  defaultReasoningEffort: 'low',
  serviceTiers: ['priority'],
  isDefault: true,
}

afterEach(() => {
  delete process.env.COS_CODEX_SANDBOX
})

describe('Codex response-text boundary', () => {
  it('accepts assistant messages and rejects reasoning/tool lookalikes', () => {
    expect(extractCodexResponseText({ type: 'item.completed', item: { type: 'agent_message', text: 'visible' } })).toBe('visible')
    expect(extractCodexResponseText({ type: 'agent_message.delta', delta: 'chunk' })).toBe('chunk')
    expect(extractCodexResponseText({ type: 'item.completed', item: { type: 'reasoning', text: 'hidden', content: [{ text: 'also hidden' }] }, delta: 'hidden delta' })).toBe('')
    expect(extractCodexResponseText({ type: 'item.completed', item: { type: 'command_execution', content: [{ output_text: 'secret tool output' }] } })).toBe('')
    expect(extractCodexResponseText({ type: 'agent_message', content: [{ type: 'reasoning', text: 'hidden' }, { type: 'output_text', output_text: 'answer' }] })).toBe('answer')
  })
})

describe('buildCodexExecArgs', () => {
  it('returns before writing stdin when cancellation wins the spawn race', () => {
    const source = readFileSync(new URL('./codex-bridge.ts', import.meta.url), 'utf8')
    const lateAbort = source.lastIndexOf('if (options?.abortSignal)')
    const stdinWrite = source.indexOf('proc.stdin.write(prompt)', lateAbort)
    const guard = source.slice(lateAbort, stdinWrite)
    expect(guard).toContain('if (options.abortSignal.aborted)')
    expect(guard).toContain('handleAbort()')
    expect(guard).toContain('return sid')
  })

  it('awaits the TTL-coalesced live catalog before resolving each run', () => {
    const source = readFileSync(new URL('./codex-bridge.ts', import.meta.url), 'utf8')
    const refresh = source.indexOf('await getCodexModelCatalog()')
    const resolve = source.indexOf('const resolvedCodexModel = resolveCodexModelOption(model)')
    expect(refresh).toBeGreaterThan(0)
    expect(resolve).toBeGreaterThan(refresh)
  })

  it('keeps the public server read-only while using the live model and effort', () => {
    const args = buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      resolvedModel: frontier,
      effort: 'max',
    })
    expect(args).toEqual([
      'exec',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--json',
      '--cd', '/tmp/cos',
      '--model', 'gpt-5.6-sol',
      '-c', 'model_reasoning_effort="max"',
      '-c', 'service_tier="priority"',
      '-',
    ])
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('permits only the documented workspace-write opt-in', () => {
    process.env.COS_CODEX_SANDBOX = 'workspace-write'
    expect(buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: false,
      resolvedModel: frontier,
    })).toContain('workspace-write')

    process.env.COS_CODEX_SANDBOX = 'danger-full-access'
    const safe = buildCodexExecArgs({ codexCwd: '/tmp/cos', persistentCodexSession: false, resolvedModel: frontier })
    expect(safe).toContain('read-only')
    expect(safe).not.toContain('danger-full-access')
  })

  it('keeps sandboxing on resumed runs and omits unavailable pins', () => {
    const fallback = { ...frontier, id: '', serviceTiers: [] }
    const args = buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      codexThreadId: 'thread-123',
      resolvedModel: fallback,
    })
    expect(args).toContain('read-only')
    expect(args).not.toContain('--model')
    expect(args).not.toContain('service_tier="priority"')
  })

  it('places the run-scoped writable directory before resume without weakening the sandbox', () => {
    const args = buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      codexThreadId: 'thread-123',
      resolvedModel: frontier,
      publisherWritableDirectory: '/tmp/cos-output-private',
    })
    expect(args.slice(0, 7)).toEqual([
      'exec',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--add-dir', '/tmp/cos-output-private',
      'resume',
    ])
    expect(args).not.toContain('danger-full-access')
    expect(args.indexOf('--add-dir')).toBeLessThan(args.indexOf('resume'))
  })
})
