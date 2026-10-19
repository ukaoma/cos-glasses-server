// Key lanes K1 P5 (plan v4 9.1): OpenAI-style SSE, with tool calls as indexed fragments.
import { describe, expect, it } from 'vitest'

import { DIRECT_SSE_LIMITS, DirectSseParser, DirectToolCallAccumulator, parseDirectJsonBody } from './direct-sse.js'

const ev = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
const delta = (d: Record<string, unknown>, extra: Record<string, unknown> = {}) => ev({ id: 'gen-1', choices: [{ index: 0, delta: d }], ...extra })

describe('direct SSE parser', () => {
  it('streams text, skips comments and stops at [DONE]', () => {
    const p = new DirectSseParser('call_x')
    const out = [
      ...p.push(': OPENROUTER PROCESSING\n\n'),
      ...p.push(delta({ role: 'assistant', content: 'Hel' })),
      ...p.push(delta({ content: 'lo' })),
      ...p.push('data: [DONE]\n\n'),
      ...p.push(delta({ content: 'after done' })),
    ]
    expect(out).toEqual([{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }, { type: 'done' }])
    expect(p.sawDone).toBe(true)
    expect(p.generationId).toBe('gen-1')
  })

  it('reassembles events split at arbitrary byte boundaries, CRLF and multi-byte text included', () => {
    const wire = new TextEncoder().encode(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'café ◈ ok' } }] })}\r\n\r\n` + 'data: [DONE]\r\n\r\n',
    )
    for (const step of [1, 2, 3, 7]) {
      const p = new DirectSseParser('c')
      const texts: string[] = []
      for (let i = 0; i < wire.length; i += step) {
        for (const e of p.push(wire.slice(i, i + step))) if (e.type === 'text') texts.push(e.text)
      }
      expect(texts.join('')).toBe('café ◈ ok')
      expect(p.sawDone).toBe(true)
    }
  })

  it('assembles indexed tool-call fragments with string arguments, interleaved across two calls', () => {
    const p = new DirectSseParser('call_x')
    p.push(delta({ tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'search_meetings', arguments: '' } }] }))
    p.push(delta({ tool_calls: [{ index: 1, id: 'call_def', type: 'function', function: { name: 'search_memories', arguments: '{"qu' } }] }))
    p.push(delta({ tool_calls: [{ index: 0, function: { arguments: '{"que' } }] }))
    p.push(delta({ tool_calls: [{ index: 0, function: { arguments: 'ry":"bud' } }, { index: 1, function: { arguments: 'ery":"x"}' } }] }))
    p.push(delta({ tool_calls: [{ index: 0, function: { arguments: 'get"}' } }] }))
    p.push(ev({ id: 'gen-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
    expect(p.tools.calls()).toEqual([
      { id: 'call_abc', type: 'function', function: { name: 'search_meetings', arguments: '{"query":"budget"}' } },
      { id: 'call_def', type: 'function', function: { name: 'search_memories', arguments: '{"query":"x"}' } },
    ])
    expect(p.finishReason).toBe('tool_calls')
  })

  it('reads the usage chunk (empty choices) including OpenRouter cost', () => {
    const p = new DirectSseParser('c')
    p.push(delta({ content: 'Hi' }))
    p.push(ev({ id: 'gen-1', choices: [], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, cost: 0.0032 } }))
    expect(p.usage).toEqual({ input: 1200, output: 80, costUsd: 0.0032 })
  })

  it('turns an in-stream error object into an error event and ends', () => {
    const p = new DirectSseParser('c')
    const out = p.push(ev({ error: { message: 'Provider returned error', code: 502 } }))
    expect(out).toEqual([{ type: 'error', message: 'Provider returned error', code: 502 }])
    expect(p.push(delta({ content: 'late' }))).toEqual([])
  })

  it('parses a final event that arrived without its blank-line terminator', () => {
    const p = new DirectSseParser('c')
    expect(p.push('data: {"choices":[{"index":0,"delta":{"content":"tail"}}]}')).toEqual([])
    expect(p.finish()).toEqual([{ type: 'text', text: 'tail' }])
  })

  it('refuses an unterminated event past the buffer cap', () => {
    const p = new DirectSseParser('c')
    const out = p.push('data: ' + 'x'.repeat(DIRECT_SSE_LIMITS.eventBufferChars + 10))
    expect(out).toEqual([{ type: 'error', message: 'stream event too large' }])
  })

  it('reads a non-stream JSON body into the same shape', () => {
    const { parser, events } = parseDirectJsonBody(JSON.stringify({
      id: 'gen-9',
      choices: [{ message: { content: 'Answer', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_meeting', arguments: '{"domain":"quilt"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 5, completion_tokens: 6 },
    }), 'c')
    expect(events).toEqual([{ type: 'text', text: 'Answer' }])
    expect(parser.tools.calls()[0]).toEqual({ id: 'call_1', type: 'function', function: { name: 'read_meeting', arguments: '{"domain":"quilt"}' } })
    expect(parser.usage).toEqual({ input: 5, output: 6 })
    expect(parser.generationId).toBe('gen-9')
  })
})

describe('direct tool-call accumulator', () => {
  it('synthesizes an id when the server sent none, so the call and its result still pair', () => {
    const acc = new DirectToolCallAccumulator('call_run_2')
    acc.add({ index: 0, function: { name: 'search_memories', arguments: '{}' } })
    expect(acc.calls()).toEqual([{ id: 'call_run_2_0', type: 'function', function: { name: 'search_memories', arguments: '{}' } }])
  })

  it('first id wins, a repeated name is not doubled, a streamed name is appended', () => {
    const acc = new DirectToolCallAccumulator('c')
    acc.add({ index: 0, id: 'call_a', function: { name: 'search_meetings', arguments: '{"query":' } })
    acc.add({ index: 0, id: 'call_other', function: { name: 'search_meetings', arguments: '"q"}' } })
    acc.add({ index: 1, id: 'call_b', function: { name: 'read_', arguments: '' } })
    acc.add({ index: 1, function: { name: 'meeting' } })
    expect(acc.calls().map(c => [c.id, c.function.name, c.function.arguments])).toEqual([
      ['call_a', 'search_meetings', '{"query":"q"}'],
      ['call_b', 'read_meeting', '{}'],
    ])
  })

  it('without an index, follows the id, then the last slot', () => {
    const acc = new DirectToolCallAccumulator('c')
    acc.add({ id: 'call_a', function: { name: 'search_meetings', arguments: '{"query"' } })
    acc.add({ function: { arguments: ':"x"}' } })
    acc.add({ id: 'call_b', function: { name: 'search_memories', arguments: '{}' } })
    acc.add({ id: 'call_a', function: { arguments: '' } })
    expect(acc.calls().map(c => [c.id, c.function.arguments])).toEqual([['call_a', '{"query":"x"}'], ['call_b', '{}']])
  })

  it('an object arguments value (non-standard) becomes its JSON', () => {
    const acc = new DirectToolCallAccumulator('c')
    acc.add({ index: 0, id: 'x', function: { name: 'search_memories', arguments: { query: 'q' } } })
    expect(acc.calls()[0]!.function.arguments).toBe('{"query":"q"}')
  })

  it('caps calls per response and argument size as errors, never silent cuts', () => {
    const many = new DirectToolCallAccumulator('c')
    for (let i = 0; i <= DIRECT_SSE_LIMITS.callsPerResponse; i++) many.add({ index: i, id: `c${i}`, function: { name: 'search_memories' } })
    expect(many.error()).toBe('too many tool calls in one response')
    const big = new DirectToolCallAccumulator('c')
    big.add({ index: 0, id: 'a', function: { name: 'search_memories', arguments: 'x'.repeat(DIRECT_SSE_LIMITS.argumentChars + 1) } })
    expect(big.error()).toBe('tool arguments too long')
  })

  it('a call with no name is dropped', () => {
    const acc = new DirectToolCallAccumulator('c')
    acc.add({ index: 0, id: 'a', function: { arguments: '{}' } })
    expect(acc.calls()).toEqual([])
  })
})
