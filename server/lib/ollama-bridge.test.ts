import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.COS_DATA_DIR = `/tmp/cos-ollama-bridge-test-${process.pid}-${Date.now()}`
  process.env.COS_OLLAMA_RUN_LEDGER_FILE = `${process.env.COS_DATA_DIR}/ollama-runs.jsonl`
})

// The loop tests exercise ROUND CONTROL, not the executors. Left unmocked,
// search_meetings really shells out to semantic_search.py and waits on its own
// 15s execFile timeout — fine in isolation, but past vitest's 5s under a full
// suite run. Executor behaviour is covered in ollama-tools.test.ts.
vi.mock('./meeting-library-search.js', () => ({
  searchMeetingLibrary: vi.fn(async () => ({
    hits: [], keywordCount: 0, semanticCount: 0, semanticAvailable: true,
  })),
}))
vi.mock('./context-library-search.js', () => ({
  searchMemories: vi.fn(async () => ({
    hits: [], keywordCount: 0, semanticCount: 0, semanticAvailable: true,
  })),
}))

import {
  _resetOllamaCatalogCache,
  _setOllamaCatalogFetchForTests,
} from './ollama-catalog.js'
import {
  callOllamaStreaming,
  historyToOllamaMessages,
  parseOllamaChatDelta,
} from './ollama-bridge.js'
import type { StreamCallbacks } from './claude-bridge.js'

function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`))
      controller.close()
    },
  })
}

function collectCallbacks() {
  const chunks: string[] = []
  const toolStatuses: string[] = []
  let error: string | undefined
  let done: string | undefined
  const callbacks: StreamCallbacks = {
    onChunk: text => { chunks.push(text) },
    onError: async message => { error = message },
    onDone: async text => { done = text },
    onToolStatus: name => { toolStatuses.push(name) },
  }
  return { callbacks, chunks, toolStatuses, result: () => ({ chunks, error, done, toolStatuses }) }
}

/** A real directory, because ollamaCosPipelineConfigured stats it live. */
function withScriptsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cos-ollama-scripts-'))
  process.env.COS_SCRIPTS_DIR = dir
  return dir
}

/** Answer /api/tags, /api/show and /api/chat separately. `chats` collects only
 *  real chat bodies, so an assertion can never match the show probe. */
function toolAwareFetch(options: {
  chats: unknown[]
  tools: boolean
  responses: string[][]
}) {
  let call = 0
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: [{ name: 'qwen3.8:27b' }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.endsWith('/api/show')) {
      return new Response(JSON.stringify({ capabilities: options.tools ? ['tools'] : [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    options.chats.push(init?.body ? JSON.parse(String(init.body)) : null)
    const lines = options.responses[Math.min(call, options.responses.length - 1)]!
    call += 1
    return new Response(ndjsonStream(lines), { status: 200 })
  }
}

describe('ollama bridge', () => {
  const priorScriptsDir = process.env.COS_SCRIPTS_DIR
  const scratchDirs: string[] = []

  afterEach(() => {
    _resetOllamaCatalogCache()
    _setOllamaCatalogFetchForTests(null)
    delete process.env.COS_CODEX_EXTRA_ARGS
    // The live process really has COS_SCRIPTS_DIR (health reports mode: "cos"),
    // so a test that sets it must put the original back or it leaks.
    if (priorScriptsDir === undefined) delete process.env.COS_SCRIPTS_DIR
    else process.env.COS_SCRIPTS_DIR = priorScriptsDir
    while (scratchDirs.length) {
      const dir = scratchDirs.pop()!
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  })

  it('parses streamed chat deltas', () => {
    expect(parseOllamaChatDelta('{"message":{"content":"Hi"},"done":false}')).toEqual({
      content: 'Hi', done: false,
    })
    expect(parseOllamaChatDelta('{"message":{"content":""},"done":true}')).toEqual({
      content: '', done: true,
    })
    expect(parseOllamaChatDelta('{"error":"model not found"}').error).toBe('model not found')
  })

  it('maps history without repeating the current user turn', () => {
    const messages = historyToOllamaMessages([
      { role: 'user', content: 'one', timestamp: 1 },
      { role: 'assistant', content: 'two', timestamp: 2 },
    ], [])
    expect(messages).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ])
  })

  it('streams a local reply and ignores COS_CODEX_EXTRA_ARGS', async () => {
    process.env.COS_CODEX_EXTRA_ARGS = '--oss --local-provider ollama --model stolen'
    const chatBodies: unknown[] = []
    _setOllamaCatalogFetchForTests(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      // /api/show must be answered BEFORE the chat else-branch, or the show
      // probe's `{name}` body lands in chatBodies[0] and the chat assertions
      // match the wrong request.
      if (url.endsWith('/api/show')) {
        return new Response(JSON.stringify({ capabilities: [] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      chatBodies.push(init?.body ? JSON.parse(String(init.body)) : null)
      return new Response(ndjsonStream([
        '{"message":{"role":"assistant","content":"Hello "},"done":false}',
        '{"message":{"role":"assistant","content":"there"},"done":true}',
      ]), { status: 200 })
    })

    const collected = collectCallbacks()
    await callOllamaStreaming('ping', 's-ollama-1', collected.callbacks)
    const result = collected.result()
    expect(result.done).toBe('Hello there')
    expect(result.chunks.join('')).toBe('Hello there')
    expect(result.error).toBeUndefined()
    expect(chatBodies[0]).toMatchObject({
      model: 'llama3.2:latest',
      stream: true,
      // The default request DISABLES thinking. Omitting the key would let a
      // thinking-class model ruminate for minutes before the first visible
      // token; sending false costs nothing on models that cannot think.
      think: false,
    })
    expect(JSON.stringify(chatBodies[0])).not.toContain('--oss')
  })

  it('maps thinking to the requested effort, with the env pin overriding', async () => {
    const { resolveOllamaThink } = await import('./ollama-bridge.js')
    // Unset env: the effort ladder decides. The default lens effort stays fast.
    expect(resolveOllamaThink(undefined)).toBe(false)
    expect(resolveOllamaThink(undefined, 'high')).toBe(false)
    expect(resolveOllamaThink(undefined, 'xhigh')).toBe('high')
    expect(resolveOllamaThink(undefined, 'max')).toBe('max')
    expect(resolveOllamaThink(undefined, 'ultracode')).toBe('max')
    // Garbage reads as unset, deferring to effort -- never as an accidental pin.
    expect(resolveOllamaThink('banana', 'xhigh')).toBe('high')
    // The env pin beats effort in BOTH directions.
    expect(resolveOllamaThink('0', 'xhigh')).toBe(false)
    expect(resolveOllamaThink('false', 'max')).toBe(false)
    expect(resolveOllamaThink('1')).toBe(true)
    expect(resolveOllamaThink('true', 'high')).toBe(true)
    expect(resolveOllamaThink('HIGH')).toBe('high')
    expect(resolveOllamaThink(' low ', 'max')).toBe('low')
  })

  it('threads the request effort into the chat body think field', async () => {
    const chatBodies: unknown[] = []
    _setOllamaCatalogFetchForTests(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      // /api/show must be answered BEFORE the chat else-branch, or the show
      // probe's `{name}` body lands in chatBodies[0] and the chat assertions
      // match the wrong request.
      if (url.endsWith('/api/show')) {
        return new Response(JSON.stringify({ capabilities: [] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      chatBodies.push(init?.body ? JSON.parse(String(init.body)) : null)
      return new Response(ndjsonStream([
        '{"message":{"role":"assistant","content":"ok"},"done":true}',
      ]), { status: 200 })
    })
    const collected = collectCallbacks()
    await callOllamaStreaming('ping', 's-ollama-effort', collected.callbacks, undefined, undefined, undefined, { effort: 'xhigh' })
    expect(chatBodies[0]).toMatchObject({ think: 'high' })
  })

  it('refuses photos', async () => {
    const collected = collectCallbacks()
    await callOllamaStreaming('what is this', 's-ollama-2', collected.callbacks, [
      { path: '/tmp/x.jpg', mimeType: 'image/jpeg', attachment: { id: 'm_1', kind: 'image' } } as any,
    ])
    expect(collected.result().error).toMatch(/text-only/i)
    expect(collected.result().done).toBeUndefined()
  })

  // ── Read-only tool loop (6.40.1) ─────────────────────────────────

  it('C3: tool_calls on line 1 and an empty done:true on line 2 issue a SECOND post', async () => {
    scratchDirs.push(withScriptsDir())
    const chats: any[] = []
    _setOllamaCatalogFetchForTests(toolAwareFetch({
      chats, tools: true,
      responses: [
        // The live shape. Judging only the done line sees no calls at all and
        // would report an empty response instead of running the tool.
        [
          '{"message":{"role":"assistant","content":"","tool_calls":[{"id":"c1","function":{"name":"search_meetings","arguments":{"query":"quilt"}}}]},"done":false}',
          '{"message":{"role":"assistant","content":""},"done":true}',
        ],
        ['{"message":{"role":"assistant","content":"Found it."},"done":true}'],
      ],
    }) as any)

    const collected = collectCallbacks()
    await callOllamaStreaming('what did we decide', 's-tool-c3', collected.callbacks)
    const result = collected.result()
    expect(result.error).toBeUndefined()
    expect(result.done).toBe('Found it.')
    expect(chats).toHaveLength(2)
  })

  it('C4: the second post carries role:tool with the call id', async () => {
    scratchDirs.push(withScriptsDir())
    const chats: any[] = []
    _setOllamaCatalogFetchForTests(toolAwareFetch({
      chats, tools: true,
      responses: [
        ['{"message":{"content":"","tool_calls":[{"id":"call-42","function":{"name":"search_memories","arguments":{"query":"x"}}}]},"done":true}'],
        ['{"message":{"content":"ok"},"done":true}'],
      ],
    }) as any)

    const collected = collectCallbacks()
    await callOllamaStreaming('recall', 's-tool-c4', collected.callbacks)
    const second = chats[1]
    const toolTurn = second.messages.find((m: any) => m.role === 'tool')
    expect(toolTurn).toBeDefined()
    expect(toolTurn.tool_name).toBe('search_memories')
    expect(toolTurn.tool_call_id).toBe('call-42')
    // The assistant turn carrying the calls must survive with empty content.
    const assistantCall = second.messages.find((m: any) => m.role === 'assistant' && m.tool_calls)
    expect(assistantCall.tool_calls[0].function.name).toBe('search_memories')
  })

  it('advertises only the three COS tools, never Claude CLI names', async () => {
    scratchDirs.push(withScriptsDir())
    const chats: any[] = []
    _setOllamaCatalogFetchForTests(toolAwareFetch({
      chats, tools: true,
      responses: [['{"message":{"content":"hi"},"done":true}']],
    }) as any)

    const collected = collectCallbacks()
    await callOllamaStreaming('ping', 's-tool-defs', collected.callbacks)
    const names = chats[0].tools.map((d: any) => d.function.name)
    expect(names).toEqual(['search_meetings', 'search_memories', 'read_meeting'])
    // Assert on the TOOLS ARRAY, not the whole body: the capability prompt
    // legitimately names Bash and web search in order to deny them, and a
    // body-wide check would fail on that denial.
    const tools = JSON.stringify(chats[0].tools)
    for (const banned of ['WebSearch', 'WebFetch', 'Bash', 'Write', 'mcp__']) {
      expect(tools).not.toContain(banned)
    }
  })

  it('sends no tools key when the tag does not advertise tools', async () => {
    scratchDirs.push(withScriptsDir())
    const chats: any[] = []
    _setOllamaCatalogFetchForTests(toolAwareFetch({
      chats, tools: false,
      responses: [['{"message":{"content":"hi"},"done":true}']],
    }) as any)

    const collected = collectCallbacks()
    await callOllamaStreaming('ping', 's-no-tools', collected.callbacks)
    expect(chats[0]).not.toHaveProperty('tools')
    const system = chats[0].messages[0].content
    expect(system).toContain('You have no tools')
  })

  it('sends no tools key when the COS pipeline is absent', async () => {
    delete process.env.COS_SCRIPTS_DIR
    const chats: any[] = []
    _setOllamaCatalogFetchForTests(toolAwareFetch({
      chats, tools: true,
      responses: [['{"message":{"content":"hi"},"done":true}']],
    }) as any)

    const collected = collectCallbacks()
    await callOllamaStreaming('ping', 's-no-pipeline', collected.callbacks)
    expect(chats[0]).not.toHaveProperty('tools')
    expect(chats[0].messages[0].content).toContain('You have no tools')
  })

  it('caps at 5 posts and never issues a sixth', async () => {
    scratchDirs.push(withScriptsDir())
    const chats: any[] = []
    // Every post answers with another tool call, so only the cap can stop it.
    _setOllamaCatalogFetchForTests(toolAwareFetch({
      chats, tools: true,
      responses: [[
        '{"message":{"content":"","tool_calls":[{"id":"c","function":{"name":"search_meetings","arguments":{"query":"x"}}}]},"done":true}',
      ]],
    }) as any)

    const collected = collectCallbacks()
    await callOllamaStreaming('loop', 's-tool-cap', collected.callbacks)
    const result = collected.result()
    expect(chats).toHaveLength(5)
    expect(result.done).toBeUndefined()
    // The user string, not "Ollama failed (ollama.error)".
    expect(result.error).toContain('tool round cap')
  })

  it('reports the tool name to the HUD on a tool round', async () => {
    scratchDirs.push(withScriptsDir())
    const chats: any[] = []
    _setOllamaCatalogFetchForTests(toolAwareFetch({
      chats, tools: true,
      responses: [
        ['{"message":{"content":"","tool_calls":[{"function":{"name":"search_meetings","arguments":{"query":"x"}}}]},"done":true}'],
        ['{"message":{"content":"done"},"done":true}'],
      ],
    }) as any)

    const collected = collectCallbacks()
    await callOllamaStreaming('status', 's-tool-status', collected.callbacks)
    // The NAME, not a human sentence: both HUD maps translate it.
    expect(collected.result().toolStatuses).toContain('search_meetings')
  })

  it('fails closed, not done, when a tool call is aborted', async () => {
    scratchDirs.push(withScriptsDir())
    const chats: any[] = []
    const controller = new AbortController()
    const base = toolAwareFetch({
      chats, tools: true,
      responses: [
        ['{"message":{"content":"","tool_calls":[{"function":{"name":"search_meetings","arguments":{"query":"x"}}}]},"done":true}'],
        ['{"message":{"content":"never"},"done":true}'],
      ],
    })
    // Abort DURING the first chat round, deterministically. Aborting after the
    // call returns is a race an instant mock always wins, which made the
    // earlier version of this test pass against a loop that kept posting.
    _setOllamaCatalogFetchForTests((async (input: any, init: any) => {
      if (String(input).endsWith('/api/chat')) controller.abort()
      return base(input, init)
    }) as any)

    const collected = collectCallbacks()
    await callOllamaStreaming('slow', 's-tool-abort', collected.callbacks, undefined, undefined, undefined, {
      abortSignal: controller.signal,
    })
    const result = collected.result()
    expect(result.done).toBeUndefined()
    // The CANCELLED copy specifically, not merely "an error". A truthy check
    // let the tool_abort/timeout ordering regress silently: "tool call
    // aborted" also matches the /aborted/ timeout branch, so if tool_abort is
    // classified after it the user is told the model timed out.
    expect(result.error).toBe('That tool call was cancelled before it finished.')
  })

  it('fails closed when Ollama is down', async () => {
    _setOllamaCatalogFetchForTests(async () => { throw new Error('ECONNREFUSED') })
    const collected = collectCallbacks()
    await callOllamaStreaming('ping', 's-ollama-3', collected.callbacks)
    expect(collected.result().error).toMatch(/not running|Ollama/i)
  })
})
