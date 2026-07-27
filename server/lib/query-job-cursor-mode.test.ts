import { describe, expect, it } from 'vitest'
import { parseQueryJobRequest, requestFingerprint } from './query-job-types.js'
import { buildCursorAgentArgs } from './cursor-bridge.js'
import { normalizeCursorExecutionMode } from '../../shared/model-preference.js'

const base = {
  clientJobId: '11111111-1111-4111-8111-111111111111',
  generation: 1,
  query: 'run slack bridge health',
  sessionId: 'session-cursor-mode',
  model: 'cursor-grok',
}

describe('durable query Cursor execution mode', () => {
  it('parses agent and ask from admission input', () => {
    expect(parseQueryJobRequest({ ...base, cursorExecutionMode: 'agent' }).cursorExecutionMode).toBe('agent')
    expect(parseQueryJobRequest({ ...base, cursorExecutionMode: 'ask' }).cursorExecutionMode).toBe('ask')
  })

  it('drops unknown mode values before fingerprinting', () => {
    const parsed = parseQueryJobRequest({ ...base, cursorExecutionMode: 'weird' })
    expect(parsed.cursorExecutionMode).toBeUndefined()
    expect(requestFingerprint(parsed)).toBe(requestFingerprint(parseQueryJobRequest(base)))
  })

  it('agent mode reaches Cursor CLI --force argv (not --mode ask)', () => {
    const mode = normalizeCursorExecutionMode(
      parseQueryJobRequest({ ...base, cursorExecutionMode: 'agent' }).cursorExecutionMode === 'agent'
        ? 'agent'
        : 'ask',
    )
    const args = buildCursorAgentArgs({
      workspace: '/tmp/workspace',
      modelId: 'cursor-grok-4.5-high-fast',
      executionMode: mode,
    })
    expect(args).toContain('--force')
    expect(args).toContain('--sandbox')
    expect(args).not.toContain('ask')
  })

  it('omitted admission mode maps to agent for glasses Cursor turns', () => {
    // Runtime admission: only explicit ask stays ask; omit → agent (Settings default).
    const mode = parseQueryJobRequest(base).cursorExecutionMode === 'ask' ? 'ask' : 'agent'
    const args = buildCursorAgentArgs({
      workspace: '/tmp/workspace',
      modelId: 'composer-2.5-fast',
      executionMode: mode,
    })
    expect(args).toContain('--force')
    expect(args).not.toContain('ask')
  })

  it('bridge-level omit still defaults to ask when no admission default applied', () => {
    const mode = normalizeCursorExecutionMode(undefined)
    const args = buildCursorAgentArgs({
      workspace: '/tmp/workspace',
      modelId: 'composer-2.5-fast',
      executionMode: mode,
    })
    expect(args).toContain('--mode')
    expect(args).toContain('ask')
    expect(args).not.toContain('--force')
  })
})
