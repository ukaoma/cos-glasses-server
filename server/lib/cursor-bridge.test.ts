import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.COS_DATA_DIR = `/tmp/cos-cursor-bridge-test-${process.pid}-${Date.now()}`
})
import {
  buildCursorAgentArgs,
  extractCursorResponseText,
  extractCursorSessionId,
  extractCursorToolActivity,
} from './cursor-bridge.js'

describe('extractCursorResponseText', () => {
  it('emits assistant deltas only when timestamp_ms is present', () => {
    expect(extractCursorResponseText({
      type: 'assistant',
      timestamp_ms: 1784986351967,
      message: { role: 'assistant', content: [{ type: 'text', text: 'remember' }] },
    })).toBe('remember')

    expect(extractCursorResponseText({
      type: 'assistant',
      timestamp_ms: 1784986351967,
      message: { role: 'assistant', content: [{ type: 'text', text: 'ed' }] },
    })).toBe('ed')
  })

  it('skips thinking events even when timestamp_ms is present', () => {
    expect(extractCursorResponseText({
      type: 'thinking',
      subtype: 'delta',
      text: 'The codeword ZEBRA-77',
      timestamp_ms: 1784986351966,
    })).toBe('')
  })

  it('skips final assistant flush without timestamp_ms (avoids duplicate full text)', () => {
    expect(extractCursorResponseText({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'remembered-zebra' }] },
      session_id: '70851c49-b8a2-416e-8a39-5054cf41c24b',
    })).toBe('')
  })

  it('skips assistant events that carry model_call_id', () => {
    expect(extractCursorResponseText({
      type: 'assistant',
      timestamp_ms: 1,
      model_call_id: 'call_abc',
      message: { role: 'assistant', content: [{ type: 'text', text: 'secret' }] },
    })).toBe('')
  })
})

describe('extractCursorSessionId', () => {
  it('reads session_id from system/init', () => {
    expect(extractCursorSessionId({
      type: 'system',
      subtype: 'init',
      session_id: '70851c49-b8a2-416e-8a39-5054cf41c24b',
      model: 'Composer 2.5',
    })).toBe('70851c49-b8a2-416e-8a39-5054cf41c24b')
  })
})

describe('buildCursorAgentArgs', () => {
  it('ask mode includes --mode ask and never --force; prompt stays on stdin', () => {
    const args = buildCursorAgentArgs({
      workspace: '/tmp/cos',
      modelId: 'composer-2.5-fast',
      executionMode: 'ask',
      resumeSessionId: '70851c49-b8a2-416e-8a39-5054cf41c24b',
    })
    expect(args).toEqual([
      '-p',
      '--mode', 'ask',
      '--model', 'composer-2.5-fast',
      '--output-format', 'stream-json',
      '--stream-partial-output',
      '--trust',
      '--workspace', '/tmp/cos',
      '--resume', '70851c49-b8a2-416e-8a39-5054cf41c24b',
    ])
    expect(args).not.toContain('--force')
  })

  it('agent mode omits ask and uses --force + --sandbox disabled', () => {
    const args = buildCursorAgentArgs({
      workspace: '/tmp/cos',
      modelId: 'cursor-grok-4.5-high-fast',
      executionMode: 'agent',
    })
    expect(args).not.toContain('ask')
    expect(args).toContain('--force')
    expect(args).toContain('--sandbox')
    expect(args).toContain('disabled')
    expect(args).toContain('--approve-mcps')
  })

  it('omitted execution mode defaults to ask', () => {
    const args = buildCursorAgentArgs({
      workspace: '/tmp/cos',
      modelId: 'composer-2.5-fast',
    })
    expect(args).toContain('--mode')
    expect(args).toContain('ask')
    expect(args).not.toContain('--force')
  })
})

describe('extractCursorToolActivity', () => {
  it('flags editToolCall as Cursor editing files', () => {
    const activity = extractCursorToolActivity({
      type: 'tool_call',
      subtype: 'started',
      tool_call: {
        editToolCall: { args: { path: '/tmp/x/CURSOR_AGENT_WRITE_OK.txt' } },
      },
    })
    expect(activity.isWrite).toBe(true)
    expect(activity.status).toBe('Cursor editing files…')
    expect(activity.activity?.text).toContain('CURSOR · edit')
  })
})
