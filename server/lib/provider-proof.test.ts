import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SAFE_MODE_ENV,
  CLAUDE_PROOF_MODEL,
  CLAUDE_PROOF_TIMEOUT_MS,
  PROOF_PROVIDERS,
  claudeProofArgs,
  claudeProofText,
  classifyProofFailure,
  codexProofText,
  cursorProofArgs,
  cursorProofText,
  describeProofCode,
  runBounded,
} from './provider-proof.js'

describe('transactional provider proof parsing', () => {
  it('accepts only Claude result text', () => {
    expect(claudeProofText(JSON.stringify({ result: 'COS_CONTROL_OK' }))).toBe('COS_CONTROL_OK')
    expect(claudeProofText(JSON.stringify({ prompt: 'COS_CONTROL_OK' }))).toBe('')
  })

  it('accepts Codex assistant output but not echoed input', () => {
    const jsonl = [
      JSON.stringify({ type: 'user_message', text: 'COS_CONTROL_OK' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'COS_CONTROL_OK' } }),
    ].join('\n')
    expect(codexProofText(jsonl)).toBe('COS_CONTROL_OK')
    expect(codexProofText(JSON.stringify({ type: 'user_message', text: 'COS_CONTROL_OK' }))).toBe('')
  })

  it('uses a bounded lightweight Claude model for readiness', () => {
    expect(CLAUDE_PROOF_MODEL).toBe('haiku')
    expect(CLAUDE_PROOF_TIMEOUT_MS).toBe(45_000)
    expect(claudeProofArgs()).toContain('--model')
    expect(claudeProofArgs()[claudeProofArgs().indexOf('--model') + 1]).toBe('haiku')
    // 6.43.2 — the proof must not depend on CLAUDE_CODE_SAFE_MODE to keep
    // the MCP catalog out: without it, `--tools ''` alone is a 244K-token
    // request that Haiku refuses before any API call.
    const args = claudeProofArgs()
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}')
    expect(args.indexOf('--strict-mcp-config')).toBeLessThan(args.indexOf('--tools'))
  })

  it('isolates readiness from oversized project configuration', async () => {
    const result = await runBounded(
      process.execPath,
      ['-e', `process.stdout.write(process.env.${CLAUDE_SAFE_MODE_ENV} ?? '')`],
      '',
      2_000,
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('1')
  })

  it('preserves timeout classification when child close wins termination race', async () => {
    const result = await runBounded(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      '',
      30,
    )
    expect(result.timedOut).toBe(true)
    expect(result.aborted).toBe(false)
  })

  it('names Cursor as a proof provider and reads its result event or timestamped deltas (6.43.2)', () => {
    expect(PROOF_PROVIDERS).toEqual(['claude', 'codex', 'cursor'])
    const args = cursorProofArgs('/tmp/ws')
    expect(args.slice(0, 3)).toEqual(['-p', '--mode', 'ask'])
    expect(args).not.toContain('--model')
    expect(args[args.indexOf('--workspace') + 1]).toBe('/tmp/ws')
    const stream = [
      JSON.stringify({ type: 'assistant', timestamp_ms: 1, message: { content: [{ text: 'COS_' }] } }),
      JSON.stringify({ type: 'assistant', timestamp_ms: 2, message: { content: [{ text: 'CONTROL_OK' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ text: 'flush' }] } }),
    ].join('\n')
    expect(cursorProofText(stream)).toBe('COS_CONTROL_OK')
    expect(cursorProofText(`${stream}\n${JSON.stringify({ type: 'result', subtype: 'success', result: 'COS_CONTROL_OK' })}`)).toBe('COS_CONTROL_OK')
    expect(cursorProofText(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'Not logged in' }))).toBe('')
  })

  it('classifies a vendor limit, a sign-in failure, an overflow, and a missing binary as distinct codes (6.43.2)', () => {
    const base = { code: 1, stdout: '', stderr: '', timedOut: false, aborted: false }
    const claudeLimit = JSON.stringify({ type: 'result', is_error: true, result: "You've hit your usage limit. Your limit resets at 12am (America/Chicago)." })
    expect(classifyProofFailure({ ...base, stdout: claudeLimit }, '')).toBe('provider_quota')
    expect(classifyProofFailure({ ...base, stderr: 'Error: 429 Too Many Requests' }, '')).toBe('provider_quota')
    expect(classifyProofFailure({ ...base, stderr: 'Not logged in. Run `claude login`.' }, '')).toBe('provider_auth')
    expect(classifyProofFailure({ ...base, stdout: JSON.stringify({ is_error: true, result: 'Prompt is too long · the request is ~244334 tokens (limit 200000)' }) }, '')).toBe('provider_context_overflow')
    expect(classifyProofFailure({ ...base, code: null, stderr: 'spawn agent ENOENT' }, '')).toBe('provider_missing')
    expect(classifyProofFailure({ ...base, timedOut: true }, '')).toBe('provider_timeout')
    expect(classifyProofFailure({ ...base, aborted: true }, '')).toBe('provider_canceled')
    expect(classifyProofFailure({ ...base, code: 0, stdout: JSON.stringify({ result: 'ok' }) }, 'ok')).toBe('provider_bad_answer')
    expect(classifyProofFailure({ ...base, stderr: 'segfault' }, '')).toBe('provider_failed')
    // The description never carries vendor text.
    const described = describeProofCode('provider_quota', { ...base, stdout: claudeLimit })
    expect(described).toBe('provider session or usage limit reached')
    expect(described).not.toMatch(/12am|Chicago/)
  })
})
