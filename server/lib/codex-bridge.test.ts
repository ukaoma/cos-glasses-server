import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'

const isolatedDataDir = vi.hoisted(() => {
  const dir = `/tmp/cos-glasses-server-codex-bridge-${process.pid}`
  process.env.COS_DATA_DIR = dir
  return dir
})
import { buildCodexExecArgs, CodexExtraArgsError, extractCodexResponseText, parseCodexExtraArgs } from './codex-bridge.js'

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

function clearCodexEnv() {
  delete process.env.COS_CODEX_EXTRA_ARGS
  delete process.env.COS_CODEX_MODEL
  delete process.env.COS_CODEX_SANDBOX
}

beforeEach(clearCodexEnv)
afterEach(clearCodexEnv)

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
    const args = buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: false,
      resolvedModel: frontier,
    })
    expect(args).toContain('workspace-write')
    expect(args).toContain('sandbox_workspace_write.network_access=true')
    // Network opt-in must sit with the other global -c flags, not replace sandbox.
    const sandboxIdx = args.indexOf('--sandbox')
    const networkIdx = args.indexOf('sandbox_workspace_write.network_access=true')
    expect(args[sandboxIdx + 1]).toBe('workspace-write')
    expect(args[networkIdx - 1]).toBe('-c')
    expect(networkIdx).toBeGreaterThan(sandboxIdx)

    process.env.COS_CODEX_SANDBOX = 'danger-full-access'
    const safe = buildCodexExecArgs({ codexCwd: '/tmp/cos', persistentCodexSession: false, resolvedModel: frontier })
    expect(safe).toContain('read-only')
    expect(safe).not.toContain('danger-full-access')
    expect(safe).not.toContain('sandbox_workspace_write.network_access=true')
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

  function expectExtraArgsRefusal(raw: string, needle: string) {
    process.env.COS_CODEX_EXTRA_ARGS = raw
    expect(() => buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      resolvedModel: frontier,
    })).toThrow(CodexExtraArgsError)
    try {
      buildCodexExecArgs({
        codexCwd: '/tmp/cos',
        persistentCodexSession: true,
        resolvedModel: frontier,
      })
    } catch (error) {
      expect(error).toBeInstanceOf(CodexExtraArgsError)
      const message = String((error as Error).message)
      expect(message).toContain(needle)
      expect(message).not.toContain('/tmp/cos')
      expect(message).not.toContain('thread')
    }
  }

  it('is a no-op when extra args are unset', () => {
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
  })

  it('inserts the documented Ollama recipe before json/resume and skips cloud pins', () => {
    process.env.COS_CODEX_EXTRA_ARGS = '--oss --local-provider ollama'
    const args = buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      resolvedModel: frontier,
      effort: 'max',
    })
    const skipIdx = args.indexOf('--skip-git-repo-check')
    const jsonIdx = args.indexOf('--json')
    expect(args[skipIdx + 1]).toBe('--oss')
    expect(args[skipIdx + 2]).toBe('--local-provider')
    expect(args[skipIdx + 3]).toBe('ollama')
    expect(args.indexOf('--oss')).toBeLessThan(jsonIdx)
    expect(args).toContain('--model')
    expect(args).toContain('gpt-5.6-sol')
    expect(args.join(' ')).not.toContain('service_tier')
    expect(args.join(' ')).not.toContain('model_reasoning_effort')

    process.env.COS_CODEX_EXTRA_ARGS = '--oss --local-provider=ollama'
    const fusedProvider = buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      resolvedModel: frontier,
    })
    expect(fusedProvider).toContain('--local-provider=ollama')
    expect(fusedProvider.join(' ')).not.toContain('service_tier')

    process.env.COS_CODEX_EXTRA_ARGS = '--oss -c=oss_provider=ollama'
    const fusedOss = buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      resolvedModel: frontier,
    })
    expect(fusedOss).toContain('-c=oss_provider=ollama')
  })

  it('lets extra --model win, including Ollama names', () => {
    process.env.COS_CODEX_EXTRA_ARGS = '--model qwen2.5:latest'
    const colon = buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      resolvedModel: frontier,
    })
    expect(colon).toContain('qwen2.5:latest')
    expect(colon).not.toContain('gpt-5.6-sol')

    process.env.COS_CODEX_EXTRA_ARGS = '--model=qwen2.5:latest'
    const fused = buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      resolvedModel: frontier,
    })
    expect(fused).toContain('--model=qwen2.5:latest')
    expect(fused).not.toContain('gpt-5.6-sol')

    process.env.COS_CODEX_EXTRA_ARGS = '--oss --local-provider ollama --model qwen2.5-coder'
    const ollamaName = buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      resolvedModel: frontier,
    })
    expect(ollamaName).toContain('qwen2.5-coder')
    expect(ollamaName).not.toContain('gpt-5.6-sol')
  })

  it('lets -c model= win by exact key, including glued form', () => {
    process.env.COS_CODEX_EXTRA_ARGS = '-c model="qwen2.5:latest"'
    const args = buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      resolvedModel: frontier,
    })
    expect(args).toContain('model="qwen2.5:latest"')
    expect(args).not.toContain('gpt-5.6-sol')

    process.env.COS_CODEX_EXTRA_ARGS = '-c=model=qwen2.5:latest'
    const glued = buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      resolvedModel: frontier,
    })
    expect(glued).toContain('-c=model=qwen2.5:latest')
    expect(glued).not.toContain('gpt-5.6-sol')

    process.env.COS_CODEX_EXTRA_ARGS = '-c model_reasoning_effort=high'
    const negative = buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      resolvedModel: frontier,
    })
    expect(negative).toContain('--model')
    expect(negative).toContain('gpt-5.6-sol')
    expect(negative).toContain('service_tier="priority"')
  })

  it('skips service_tier and effort for -c model_provider= without --oss', () => {
    process.env.COS_CODEX_EXTRA_ARGS = '-c model_provider="local_vllm"'
    const args = buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      resolvedModel: frontier,
    })
    expect(args).toContain('model_provider="local_vllm"')
    expect(args.join(' ')).not.toContain('service_tier')
    expect(args.join(' ')).not.toContain('model_reasoning_effort')

    process.env.COS_CODEX_EXTRA_ARGS = '-c=model_provider=local_vllm'
    const glued = buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      resolvedModel: frontier,
    })
    expect(glued).toContain('-c=model_provider=local_vllm')
    expect(glued.join(' ')).not.toContain('service_tier')
  })

  it('places extra args before resume without replacing the trailing dash', () => {
    process.env.COS_CODEX_EXTRA_ARGS = '--oss --local-provider ollama'
    const args = buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      codexThreadId: 'thread-123',
      resolvedModel: frontier,
      publisherWritableDirectory: '/tmp/cos-output-private',
    })
    expect(args.indexOf('--oss')).toBeLessThan(args.indexOf('resume'))
    expect(args.indexOf('--add-dir')).toBeLessThan(args.indexOf('resume'))
    expect(args.at(-1)).toBe('-')
    expect(args).toContain('thread-123')
  })

  it('refuses flags and -c keys outside the hatch allowlist', () => {
    expectExtraArgsRefusal('--sandbox danger-full-access', '--sandbox')
    expectExtraArgsRefusal('--sandbox=workspace-write', '--sandbox')
    expectExtraArgsRefusal('--permission-profile :workspace', '--permission-profile')
    expectExtraArgsRefusal('-c sandbox_mode=danger-full-access', '-c sandbox_mode')
    expectExtraArgsRefusal('-c sandbox_workspace_write.network_access=true', '-c sandbox_workspace_write.network_access')
    expectExtraArgsRefusal('-c=sandbox_workspace_write.network_access=true', '-c sandbox_workspace_write.network_access')
    expectExtraArgsRefusal('--config=sandbox_mode=danger-full-access', '-c sandbox_mode')
    expectExtraArgsRefusal('-c default_permissions=":workspace"', '-c default_permissions')
    expectExtraArgsRefusal('-c=default_permissions=:workspace', '-c default_permissions')
    expectExtraArgsRefusal('-c model', '-c model')
    expectExtraArgsRefusal('-p ollama', '-p')
    expectExtraArgsRefusal('resume', 'resume')
    expectExtraArgsRefusal('--json', '--json')
    expectExtraArgsRefusal('--model', '--model')
    expectExtraArgsRefusal('--local-provider', '--local-provider')
    expectExtraArgsRefusal('--config', '--config')
    expectExtraArgsRefusal('--', '--')
    expectExtraArgsRefusal('--oss', '--oss')
    expectExtraArgsRefusal('--oss -c model_provider=openai', '-c model_provider')
    expectExtraArgsRefusal('--local-provider ollama', '--local-provider')
    expectExtraArgsRefusal('--oss --local-provider openai', '--local-provider')
    expectExtraArgsRefusal('--oss --local-provider ollama --model --sandbox=workspace-write', '--model')
    expectExtraArgsRefusal('--model --permission-profile=:workspace', '--model')
    expectExtraArgsRefusal('--model=--sandbox=workspace-write', '--model')
  })

  it('keeps interior quotes and unwraps a whole-value wrapper', () => {
    process.env.COS_CODEX_EXTRA_ARGS = '"--oss --local-provider ollama"'
    const wrapped = buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      resolvedModel: frontier,
    })
    expect(wrapped).toContain('--oss')
    expect(wrapped).toContain('--local-provider')
    expect(wrapped).toContain('ollama')

    process.env.COS_CODEX_EXTRA_ARGS = '-c model="qwen2.5:latest"'
    const interior = parseCodexExtraArgs(process.env.COS_CODEX_EXTRA_ARGS)
    expect(interior).toEqual(['-c', 'model="qwen2.5:latest"'])
  })

  it('caps token count and raw length', () => {
    process.env.COS_CODEX_EXTRA_ARGS = Array.from({ length: 33 }, () => '--oss').join(' ')
    expect(() => buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      resolvedModel: frontier,
    })).toThrow(CodexExtraArgsError)

    process.env.COS_CODEX_EXTRA_ARGS = 'x'.repeat(2001)
    expect(() => buildCodexExecArgs({
      codexCwd: '/tmp/cos',
      persistentCodexSession: true,
      resolvedModel: frontier,
    })).toThrow(CodexExtraArgsError)
  })
})

