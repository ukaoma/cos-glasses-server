// Key lanes K1 P5 (plan v4 9.1): the OpenAI chat-completions SSE parser and tool-call accumulator
// for Lane C1 (direct answers on the Mac).
//
// Why not the Ollama parser (ollama-bridge.ts parseOllamaChatDelta): Ollama streams NDJSON and
// hands over each tool call WHOLE, with `arguments` as an object and no id. OpenAI-style SSE
// (OpenRouter, OpenAI, any compatible endpoint) sends `data:` events, and a tool call arrives as
// INDEXED FRAGMENTS: the first fragment for index N carries `id`, `type` and `function.name`, and
// later fragments for the same index carry more of `function.arguments` as a STRING. The next
// request must send the assembled calls back as `{ id, type: 'function', function: { name,
// arguments } }` and each result as `{ role: 'tool', tool_call_id: <that id> }`. Ollama's
// `tool_name` is meaningless here.
//
// Pure: no I/O, no timers, no env. Bounded: an unterminated event, a call's arguments and the
// number of calls per response are all capped, and going past a cap is an error, never a silent cut.

export const DIRECT_SSE_LIMITS = {
  /** An event without its blank-line terminator may not grow past this. */
  eventBufferChars: 1024 * 1024,
  /** One tool call's assembled arguments. */
  argumentChars: 64 * 1024,
  /** Tool calls in one response. */
  callsPerResponse: 16,
  /** One tool name. */
  nameChars: 128,
} as const

export interface DirectToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface DirectSseUsage {
  input: number
  output: number
  /** Provider-reported cost in USD (OpenRouter `usage.cost`), when present. */
  costUsd?: number
}

export type DirectSseEvent =
  | { type: 'text'; text: string }
  | { type: 'error'; message: string; code?: string | number }
  | { type: 'done' }

function nonNegative(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

interface Slot {
  index: number
  id: string
  name: string
  args: string
}

/**
 * Assembles indexed fragments into whole calls.
 *
 * Index is the key. A fragment without an index (some compatible servers) joins the slot whose id
 * it repeats, else opens a new slot when it brings a new id, else extends the last slot. The first
 * non-empty id wins. A name that repeats the one already held is ignored (servers that resend it
 * on every fragment); anything else is appended (servers that stream the name too). Arguments
 * concatenate; an OBJECT (non-standard) replaces them with its JSON.
 */
export class DirectToolCallAccumulator {
  private readonly slots: Slot[] = []
  private overflow: string | null = null

  constructor(private readonly idPrefix: string) {}

  add(fragment: unknown): void {
    if (this.overflow || !fragment || typeof fragment !== 'object') return
    const f = fragment as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }
    const id = typeof f.id === 'string' ? f.id.trim() : ''
    let slot: Slot | undefined
    if (typeof f.index === 'number' && Number.isInteger(f.index) && f.index >= 0) {
      slot = this.slots.find(s => s.index === f.index)
      if (!slot) slot = this.open(f.index)
    } else if (id && this.slots.some(s => s.id === id)) {
      slot = this.slots.find(s => s.id === id)
    } else if (id || this.slots.length === 0) {
      slot = this.open(this.slots.length ? Math.max(...this.slots.map(s => s.index)) + 1 : 0)
    } else {
      slot = this.slots[this.slots.length - 1]
    }
    if (!slot) return
    if (id && !slot.id) slot.id = id
    const name = f.function?.name
    if (typeof name === 'string' && name) {
      if (!slot.name) slot.name = name
      else if (name !== slot.name) slot.name += name
      if (slot.name.length > DIRECT_SSE_LIMITS.nameChars) this.overflow = 'tool name too long'
    }
    const args = f.function?.arguments
    if (typeof args === 'string') slot.args += args
    else if (args && typeof args === 'object') slot.args = JSON.stringify(args)
    if (slot.args.length > DIRECT_SSE_LIMITS.argumentChars) this.overflow = 'tool arguments too long'
  }

  private open(index: number): Slot | undefined {
    if (this.slots.length >= DIRECT_SSE_LIMITS.callsPerResponse) {
      this.overflow = 'too many tool calls in one response'
      return undefined
    }
    const slot: Slot = { index, id: '', name: '', args: '' }
    this.slots.push(slot)
    return slot
  }

  /** Why the calls cannot be trusted (a cap was passed), or null. */
  error(): string | null {
    return this.overflow
  }

  get size(): number {
    return this.slots.length
  }

  /**
   * The whole calls, in index order. A call the server sent without an id gets `<prefix>_<index>`
   * so the assistant message and its tool result still pair up. A call with no name is dropped.
   */
  calls(): DirectToolCall[] {
    return [...this.slots]
      .sort((a, b) => a.index - b.index)
      .filter(s => s.name.trim())
      .map(s => ({
        id: s.id || `${this.idPrefix}_${s.index}`,
        type: 'function' as const,
        function: { name: s.name.trim(), arguments: s.args.trim() ? s.args : '{}' },
      }))
  }
}

/**
 * One chat-completions response stream. Feed it bytes with `push`, read the text, error and done
 * events it returns, and after the stream ends read `tools`, `usage`, `finishReason` and
 * `generationId`.
 */
export class DirectSseParser {
  private readonly decoder = new TextDecoder()
  private buffer = ''
  private ended = false
  readonly tools: DirectToolCallAccumulator
  usage: DirectSseUsage | null = null
  finishReason: string | null = null
  generationId: string | null = null
  /** True once `data: [DONE]` was seen. */
  sawDone = false

  constructor(idPrefix: string) {
    this.tools = new DirectToolCallAccumulator(idPrefix)
  }

  push(chunk: Uint8Array | string): DirectSseEvent[] {
    if (this.ended) return []
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
    const events: DirectSseEvent[] = []
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buffer)
      if (!m) break
      const raw = this.buffer.slice(0, m.index)
      this.buffer = this.buffer.slice(m.index + m[0].length)
      this.onEvent(raw, events)
      if (this.ended) return events
    }
    if (this.buffer.length > DIRECT_SSE_LIMITS.eventBufferChars) {
      this.buffer = ''
      this.ended = true
      events.push({ type: 'error', message: 'stream event too large' })
    }
    return events
  }

  /** The stream closed: parse a final event that had no blank-line terminator. */
  finish(): DirectSseEvent[] {
    if (this.ended) return []
    const events: DirectSseEvent[] = []
    const tail = this.buffer + this.decoder.decode()
    this.buffer = ''
    if (tail.trim()) this.onEvent(tail, events)
    this.ended = true
    return events
  }

  private onEvent(raw: string, events: DirectSseEvent[]): void {
    const data = raw.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n')
    // Comments (`: OPENROUTER PROCESSING`), `event:` and `id:` lines carry nothing we need.
    if (!data.trim()) return
    if (data.trim() === '[DONE]') {
      this.sawDone = true
      this.ended = true
      events.push({ type: 'done' })
      return
    }
    let chunk: Record<string, unknown>
    try {
      chunk = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }
    if (!this.generationId && typeof chunk.id === 'string' && chunk.id) this.generationId = chunk.id
    const err = chunk.error as { message?: unknown; code?: unknown } | undefined
    if (err && typeof err === 'object') {
      const message = typeof err.message === 'string' && err.message.trim() ? err.message.trim().slice(0, 240) : 'upstream error'
      events.push({ type: 'error', message, ...(typeof err.code === 'string' || typeof err.code === 'number' ? { code: err.code } : {}) })
      this.ended = true
      return
    }
    const usage = chunk.usage as Record<string, unknown> | undefined
    if (usage && typeof usage === 'object') {
      const cost = usage.cost
      this.usage = {
        input: nonNegative(usage.prompt_tokens),
        output: nonNegative(usage.completion_tokens),
        ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
      }
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue
      const c = choice as { index?: unknown; delta?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }
      // One answer per request: only choice 0 is read.
      if (typeof c.index === 'number' && c.index !== 0) continue
      const content = c.delta?.content
      if (typeof content === 'string' && content) events.push({ type: 'text', text: content })
      if (Array.isArray(c.delta?.tool_calls)) for (const fragment of c.delta!.tool_calls as unknown[]) this.tools.add(fragment)
      if (typeof c.finish_reason === 'string' && c.finish_reason) {
        this.finishReason = c.finish_reason
        if (c.finish_reason === 'error') {
          events.push({ type: 'error', message: 'upstream finished with an error' })
          this.ended = true
          return
        }
      }
    }
    const toolError = this.tools.error()
    if (toolError) {
      events.push({ type: 'error', message: toolError })
      this.ended = true
    }
  }
}

/** A non-stream JSON body (a server that ignored `stream: true`), read into the same shape. */
export function parseDirectJsonBody(text: string, idPrefix: string): { parser: DirectSseParser; events: DirectSseEvent[] } {
  const parser = new DirectSseParser(idPrefix)
  const events: DirectSseEvent[] = []
  try {
    const body = JSON.parse(text) as { id?: unknown; usage?: unknown; error?: unknown; choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }> }
    const choices = (body.choices ?? []).map((c, index) => ({
      index,
      delta: { content: c?.message?.content, tool_calls: Array.isArray(c?.message?.tool_calls) ? (c.message!.tool_calls as unknown[]).map((t, i) => ({ index: i, ...(t as object) })) : undefined },
      finish_reason: c?.finish_reason,
    }))
    events.push(...parser.push(`data: ${JSON.stringify({ id: body.id, usage: body.usage, error: body.error, choices })}\n\n`))
  } catch { /* not JSON: an empty parser, the caller reports an empty response */ }
  return { parser, events }
}
