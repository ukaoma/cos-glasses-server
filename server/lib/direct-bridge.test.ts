// Key lanes K1 P5 (plan v4 9.1, 4.6, D7): Lane C1 against a mock OpenAI-compatible server on
// loopback, through a FAKE in-process relay (P2 builds the real one). No network, no real key:
// the fake relay forwards to the mock server with a made-up secret.
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const base = `${process.env.TMPDIR || '/tmp'}/cos-direct-bridge-test-${process.pid}-${Date.now()}`
  process.env.COS_DATA_DIR = `${base}/data`
  process.env.COS_PROFILE_PATH = `${base}/data/.cos-profile.json`
  process.env.HOME = `${base}/home`
  process.env.COS_DIRECT_RUN_LEDGER_FILE = `${base}/data/direct-runs.jsonl`
  process.env.COS_OLLAMA_RUN_LEDGER_FILE = `${base}/data/ollama-runs.jsonl`
  process.env.COS_KEY_LANES = '1'
})

const searchMeetingLibrary = vi.hoisted(() => vi.fn(async (_input: { query: string }) => ({
  hits: [{ title: 'Budget review', date: '2026-10-14', domain: 'quilt', month: '2026-10', filename: 'budget.md' }],
  keywordCount: 1, semanticCount: 0, semanticAvailable: true,
})))
const searchMemories = vi.hoisted(() => vi.fn(async (_input: { query: string }) => ({
  hits: [], keywordCount: 0, semanticCount: 0, semanticAvailable: true,
})))
const logTokenAudit = vi.hoisted(() => vi.fn())
vi.mock('./meeting-library-search.js', () => ({ searchMeetingLibrary }))
vi.mock('./context-library-search.js', () => ({ searchMemories }))
vi.mock('./telegram-notify.js', () => ({ notifySessionStart: vi.fn(), notifyExchange: vi.fn(), notifySessionEnd: vi.fn() }))
vi.mock('./token-audit.js', async importOriginal => ({ ...(await importOriginal<typeof import('./token-audit.js')>()), logTokenAudit }))

import type { StreamCallbacks } from './claude-bridge.js'
import { getHistory } from './conversation.js'
import type { KeyProfile } from './key-relay-contract.js'
import { saveKey } from './key-store.js'
import { deleteProfilesFile, upsertProfile } from './key-profiles.js'
import { KeyCatalog } from './key-catalog.js'
import { listDirectRuns } from './ollama-run-ledger.js'
import {
  DIRECT_COPY,
  DIRECT_MAX_POSTS,
  buildDirectToolMessage,
  callDirectStreaming,
  classifyDirectStatus,
  directEndpointFor,
  directToolsAllowed,
  isLoopbackEndpoint,
  loadDirectNotices,
  parseRetryAfterMs,
  registerDirectRelay,
  type DirectCallOptions,
  type DirectNoticeCopy,
  type DirectNoticeView,
  type DirectRefusalKind,
  type DirectRelay,
  type DirectTurnBinding,
  type DirectUsage,
} from './direct-bridge.js'

const FAKE_SECRET = 'sk-or-v1-' + 'f00d'.repeat(12)
const FAKE_COMPAT_SECRET = 'compat-' + 'beef'.repeat(8)

// ── Mock OpenAI-compatible server ────────────────────────────────────────────

type Handler = (body: Record<string, unknown>, res: http.ServerResponse, n: number) => void | Promise<void>
let server: http.Server
let origin = ''
let handler: Handler
const requests: Array<{ body: Record<string, unknown>; auth?: string; path: string }> = []

const sseHead = (res: http.ServerResponse, headers: Record<string, string> = {}) =>
  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-generation-id': 'gen-header-1', ...headers })
const data = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
const textDelta = (text: string) => data({ id: 'gen-1', choices: [{ index: 0, delta: { content: text } }] })
const usageEvent = (input: number, output: number, cost?: number) =>
  data({ id: 'gen-1', choices: [], usage: { prompt_tokens: input, completion_tokens: output, ...(cost !== undefined ? { cost } : {}) } })
function sendText(res: http.ServerResponse, parts: string[], usage?: [number, number, number?]) {
  sseHead(res)
  for (const p of parts) res.write(textDelta(p))
  res.write(data({ id: 'gen-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
  if (usage) res.write(usageEvent(usage[0], usage[1], usage[2]))
  res.end('data: [DONE]\n\n')
}
function sendToolCall(res: http.ServerResponse, name: string, id: string, argParts: string[]) {
  sseHead(res)
  res.write(data({ id: 'gen-t', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] } }] }))
  for (const a of argParts) res.write(data({ id: 'gen-t', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: a } }] } }] }))
  res.write(data({ id: 'gen-t', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
  res.write(usageEvent(100, 10))
  res.end('data: [DONE]\n\n')
}
function sendStatus(res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(body)
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      requests.push({ body, auth: req.headers.authorization, path: req.url ?? '' })
      void Promise.resolve(handler(body, res, requests.length)).catch(() => { try { res.destroy() } catch { /* ignore */ } })
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>(r => server.close(() => r()))
})

// ── Fake relay (the P2 contract seam), keys, profiles, notices ───────────────

interface RelayState {
  bindings: DirectTurnBinding[]
  posts: number
  settles: Array<DirectUsage | null>
  closed: number
}
function fakeRelay(opts: { refuseOpen?: DirectRefusalKind; refusePost?: (n: number) => DirectRefusalKind | undefined; throwPost?: (n: number) => boolean } = {}) {
  const state: RelayState = { bindings: [], posts: 0, settles: [], closed: 0 }
  const relay: DirectRelay = {
    async openTurn(binding) {
      state.bindings.push(binding)
      if (opts.refuseOpen) return { ok: false, refused: opts.refuseOpen }
      return {
        ok: true,
        turn: {
          async post(body, signal) {
            state.posts += 1
            const refused = opts.refusePost?.(state.posts)
            if (refused) return { refused }
            if (opts.throwPost?.(state.posts)) throw new Error('fetch failed')
            // The real relay posts to binding.endpoint; the fake sends the same body to the mock.
            const secret = binding.keyKind === 'openai-compatible' ? FAKE_COMPAT_SECRET : FAKE_SECRET
            const response = await fetch(`${origin}/v1/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
              body: JSON.stringify(body),
              signal,
            })
            return { response, settle: usage => { state.settles.push(usage) } }
          },
          spentTodayUsd: () => 0.12,
          close() { state.closed += 1 },
        },
      }
    },
  }
  return { relay, state }
}

const noticeCalls: Array<{ variant: string; costUsd?: number; spentTodayUsd?: number }> = []
const errorCalls: Array<{ id: string; keyKind?: string; capUsd?: number }> = []
const notices: DirectNoticeCopy = {
  keyLaneNotice: (ctx, seen) => {
    noticeCalls.push({ variant: ctx.variant, costUsd: ctx.costUsd, spentTodayUsd: ctx.spentTodayUsd })
    const fingerprint = `fp:${ctx.profileId}:${ctx.variant}`
    return seen && fingerprint in seen
      ? { form: 'compact', fingerprint, label: `label:${ctx.variant}` }
      : { form: 'first-time', fingerprint, header: 'H', body: [`body:${ctx.variant}`], footer: 'F', label: `label:${ctx.variant}` }
  },
  keyNoticeError: (id, params) => { errorCalls.push({ id, keyKind: params?.keyKind, capUsd: params?.capUsd }); return `LINE:${id}` },
  keyModelLabel: slug => slug === 'anthropic/claude-sonnet-5.5' ? 'Sonnet 5.5' : slug,
}

let orKeyRef = ''
let compatKeyRef = ''
function profile(over: Partial<KeyProfile> = {}): KeyProfile {
  const p: KeyProfile = {
    id: 'direct-sonnet',
    label: 'Sonnet direct',
    keyRef: orKeyRef,
    engine: 'direct',
    model: 'anthropic/claude-sonnet-5.5',
    enabled: true,
    timeoutTier: 'sonnet',
    offerOnV1: false,
    directTools: false,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
    ...over,
  }
  upsertProfile(p)
  return p
}

function collect() {
  const chunks: string[] = []
  const tools: string[] = []
  const starts: unknown[] = []
  let error: string | undefined
  let done: { text: string; meta: Record<string, unknown> } | undefined
  const callbacks: StreamCallbacks = {
    onChunk: t => { chunks.push(t) },
    onError: async m => { error = m },
    onDone: async (text, _model, _cli, meta) => { done = { text, meta: (meta ?? {}) as Record<string, unknown> } },
    onToolStatus: n => { tools.push(n) },
    onStart: (_m, _s, _c, meta) => { starts.push(meta) },
  }
  return { callbacks, chunks, tools, starts, error: () => error, done: () => done }
}

const sleeps: number[] = []
const sleep = async (ms: number) => { sleeps.push(ms) }
const catalog = new KeyCatalog({ url: 'http://127.0.0.1:9/never', fetchImpl: async () => { throw new Error('no catalog in tests') } })
function opts(relay: DirectRelay, extra: Partial<DirectCallOptions> = {}): DirectCallOptions {
  return { relay, notices, sleep, catalog, ...extra }
}

const priorScriptsDir = process.env.COS_SCRIPTS_DIR
beforeAll(() => {
  mkdirSync(process.env.HOME!, { recursive: true })
  orKeyRef = saveKey({ kind: 'openrouter', secret: FAKE_SECRET, capUsd: 1 }).ref
})
beforeEach(() => {
  // ollamaCosPipelineConfigured stats this live; a real directory turns the COS tools on.
  process.env.COS_SCRIPTS_DIR = mkdtempSync(join(tmpdir(), 'cos-direct-scripts-'))
  process.env.COS_KEY_LANES = '1'
  compatKeyRef = saveKey({ kind: 'openai-compatible', secret: FAKE_COMPAT_SECRET, capUsd: 0.5, baseUrl: `${origin}/v1` }).ref
  requests.length = 0
  sleeps.length = 0
  noticeCalls.length = 0
  errorCalls.length = 0
  searchMeetingLibrary.mockClear()
  searchMemories.mockClear()
  logTokenAudit.mockClear()
})
afterEach(() => {
  registerDirectRelay(null)
  deleteProfilesFile()
  if (priorScriptsDir === undefined) delete process.env.COS_SCRIPTS_DIR
  else process.env.COS_SCRIPTS_DIR = priorScriptsDir
})

// ── Pure pieces ──────────────────────────────────────────────────────────────

describe('direct lane pieces', () => {
  it('maps a tool result to tool_call_id, never Ollama tool_name', () => {
    const msg = buildDirectToolMessage({ id: 'call_abc', type: 'function', function: { name: 'search_meetings', arguments: '{}' } }, 'R')
    expect(msg).toEqual({ role: 'tool', tool_call_id: 'call_abc', content: 'R' })
    expect('tool_name' in msg).toBe(false)
  })

  it('D7: tools off for a non-loopback endpoint unless the profile opted in; on for loopback', () => {
    expect(directToolsAllowed({ directTools: false }, 'https://openrouter.ai/api/v1/chat/completions')).toBe(false)
    expect(directToolsAllowed({ directTools: true }, 'https://openrouter.ai/api/v1/chat/completions')).toBe(true)
    expect(directToolsAllowed({ directTools: false }, 'http://127.0.0.1:1234/v1/chat/completions')).toBe(true)
    expect(directToolsAllowed({ directTools: false }, 'http://localhost:1234/v1/chat/completions')).toBe(true)
    expect(directToolsAllowed({ directTools: false }, 'http://[::1]:1234/v1/chat/completions')).toBe(true)
    for (const remote of ['http://127.0.0.1.nip.io/v1', 'http://10.0.0.5/v1', 'http://100.64.1.2/v1', 'https://localhost.evil.com/v1', 'not a url']) {
      expect(isLoopbackEndpoint(remote)).toBe(false)
      expect(directToolsAllowed({ directTools: false }, remote)).toBe(false)
    }
  })

  it('endpoints per key kind; Anthropic keys cannot answer direct (P1 profile policy)', () => {
    expect(directEndpointFor({ kind: 'openrouter' })).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(directEndpointFor({ kind: 'openai' })).toBe('https://api.openai.com/v1/chat/completions')
    expect(directEndpointFor({ kind: 'anthropic' })).toBeNull()
    expect(directEndpointFor({ kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1/' })).toBe('http://127.0.0.1:1234/v1/chat/completions')
    expect(directEndpointFor({ kind: 'openai-compatible' })).toBeNull()
  })

  it('maps statuses per plan 4.6 and reads Retry-After', () => {
    expect(classifyDirectStatus(200)).toBeNull()
    expect(classifyDirectStatus(401)).toBe('key_rejected')
    expect(classifyDirectStatus(403, '{"error":{"message":"flagged"}}')).toBe('upstream_error')
    expect(classifyDirectStatus(402)).toBe('out_of_credit')
    expect(classifyDirectStatus(404)).toBe('model_gone')
    expect(classifyDirectStatus(400, '{"error":{"message":"anthropic/x is not a valid model ID"}}')).toBe('model_gone')
    expect(classifyDirectStatus(400, '{"error":{"message":"bad request"}}')).toBe('upstream_error')
    expect(classifyDirectStatus(429)).toBe('rate_limited')
    expect(classifyDirectStatus(503)).toBe('upstream_error')
    expect(classifyDirectStatus(529)).toBe('upstream_error')
    expect(parseRetryAfterMs('2')).toBe(2000)
    expect(parseRetryAfterMs(null)).toBeNull()
    expect(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT', () => Date.parse('Wed, 21 Oct 2026 07:27:50 GMT'))).toBe(10_000)
  })

  it('loads P8 notices when key-notices.ts is present, else null (TODO P11: static import)', async () => {
    const mod = await loadDirectNotices()
    if (existsSync(join(import.meta.dirname, 'key-notices.ts'))) {
      expect(typeof mod?.keyNoticeError).toBe('function')
    } else {
      expect(mod).toBeNull()
    }
  })
})

// ── Turns ────────────────────────────────────────────────────────────────────

describe('direct lane turns (mock OpenAI server, fake relay)', () => {
  it('streams text as it arrives, captures usage with cost, and records a direct run', async () => {
    let release!: () => void
    const released = new Promise<void>(r => { release = r })
    handler = async (_body, res) => {
      sseHead(res)
      res.write(textDelta('Two '))
      await released // the bridge must forward the first chunk before the stream ends
      res.write(textDelta('meetings left.'))
      res.write(usageEvent(1500, 40, 0.0042))
      res.end('data: [DONE]\n\n')
    }
    const { relay, state } = fakeRelay()
    const p = profile()
    const c = collect()
    const views: DirectNoticeView[] = []
    c.callbacks.onChunk = t => { c.chunks.push(t); release() }
    const sid = await callDirectStreaming('what is left today', undefined, c.callbacks, p, undefined, undefined, undefined, opts(relay, { onKeyNotice: v => views.push(v), turnId: 'turn-a' }))

    expect(c.error()).toBeUndefined()
    expect(c.chunks).toEqual(['Two ', 'meetings left.'])
    expect(c.done()!.text).toBe('Two meetings left.')
    expect(c.done()!.meta).toMatchObject({ keyLane: { lane: 'direct', credential: { kind: 'openrouter', ref: orKeyRef, profileId: 'direct-sonnet' } }, usd: 0.0042 })
    expect(c.starts[0]).toMatchObject({ keyLane: { lane: 'direct' } })
    expect(views[0]).toMatchObject({ form: 'first-time', body: ['body:c1-tools-off'] })

    // The request: OpenAI chat shape, streaming with usage, bounded output, no tools (D7 remote).
    const body = requests[0]!.body
    expect(body).toMatchObject({ model: 'anthropic/claude-sonnet-5.5', stream: true, stream_options: { include_usage: true }, max_tokens: 4096 })
    expect('tools' in body).toBe(false)
    expect(state.bindings[0]).toMatchObject({ keyRef: orKeyRef, keyKind: 'openrouter', profileId: 'direct-sonnet', turnId: 'turn-a', model: 'anthropic/claude-sonnet-5.5', endpoint: 'https://openrouter.ai/api/v1/chat/completions' })
    expect(state.settles).toEqual([{ input: 1500, output: 40, costUsd: 0.0042, generationId: 'gen-header-1' }])
    expect(state.closed).toBe(1)

    // Token audit: provider-final usage on the direct lane, with the key fields.
    expect(logTokenAudit).toHaveBeenCalledTimes(1)
    expect(logTokenAudit.mock.calls[0]![0]).toMatchObject({ model: 'anthropic/claude-sonnet-5.5', usageKind: 'provider_final', lane: 'direct', profile: 'direct-sonnet', credentialKind: 'openrouter', usd: 0.0042, caller: 'direct_query' })

    expect(getHistory(sid).map(e => [e.role, e.content])).toEqual([['user', 'what is left today'], ['assistant', 'Two meetings left.']])
    const run = listDirectRuns(5, sid)[0]!
    expect(run).toMatchObject({ status: 'completed', lane: 'direct', profile: 'direct-sonnet', providerModel: 'anthropic/claude-sonnet-5.5', model: 'profile:direct-sonnet', origin: 'https://openrouter.ai' })
    expect(existsSync(process.env.COS_OLLAMA_RUN_LEDGER_FILE!)).toBe(false)
    // The fake key never reaches anything the bridge writes.
    expect(readFileSync(process.env.COS_DIRECT_RUN_LEDGER_FILE!, 'utf8')).not.toContain(FAKE_SECRET)
    expect(JSON.stringify(logTokenAudit.mock.calls)).not.toContain(FAKE_SECRET)
  })

  it('prices tokens from the catalog when the provider sends no cost, and settles null when no usage arrived', async () => {
    const { relay, state } = fakeRelay()
    handler = (_b, res) => sendText(res, ['Hi.'], [1_000_000, 100_000])
    await callDirectStreaming('q', undefined, collect().callbacks, profile(), undefined, undefined, undefined, opts(relay))
    expect(logTokenAudit.mock.calls[0]![0]).toMatchObject({ usd: 3, usageKind: 'provider_final' }) // $2/M in + $10/M out (built-in Sonnet price)
    expect(state.settles[0]).toMatchObject({ input: 1_000_000, output: 100_000 })
    expect(state.settles[0]).not.toHaveProperty('costUsd')

    const second = fakeRelay()
    handler = (_b, res) => sendText(res, ['Hi.'])
    logTokenAudit.mockClear()
    await callDirectStreaming('q', undefined, collect().callbacks, profile(), undefined, undefined, undefined, opts(second.relay))
    expect(second.state.settles).toEqual([null])
    expect(logTokenAudit.mock.calls[0]![0]).toMatchObject({ usageKind: 'estimated', usd: 0 })
  })

  it('reassembles fragmented tool calls and answers each with tool_call_id', async () => {
    handler = (body, res, n) => {
      if (n === 1) {
        sseHead(res)
        res.write(data({ id: 'g', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'search_meetings', arguments: '' } }] } }] }))
        res.write(data({ id: 'g', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_def', type: 'function', function: { name: 'search_memories', arguments: '{"query":' } }] } }] }))
        res.write(data({ id: 'g', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"que' } }, { index: 1, function: { arguments: '"notes"}' } }] } }] }))
        res.write(data({ id: 'g', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"bud' } }] } }] }))
        res.write(data({ id: 'g', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'get"}' } }] } }] }))
        res.write(data({ id: 'g', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
        res.end('data: [DONE]\n\n')
        return
      }
      sendText(res, ['Budget review was 10/14.'], [300, 20])
    }
    const { relay } = fakeRelay()
    const c = collect()
    await callDirectStreaming('budget?', undefined, c.callbacks, profile({ directTools: true }), undefined, undefined, undefined, opts(relay))
    expect(c.error()).toBeUndefined()
    expect(c.done()!.text).toBe('Budget review was 10/14.')
    expect(searchMeetingLibrary).toHaveBeenCalledWith({ query: 'budget' })
    expect(searchMemories).toHaveBeenCalledWith({ query: 'notes' })
    expect(c.tools).toEqual(['search_meetings', 'search_memories'])

    expect((requests[0]!.body.tools as Array<{ function: { name: string } }>).map(t => t.function.name)).toEqual(['search_meetings', 'search_memories', 'read_meeting'])
    const second = requests[1]!.body.messages as Array<Record<string, unknown>>
    const assistant = second.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls))!
    expect(assistant.tool_calls).toEqual([
      { id: 'call_abc', type: 'function', function: { name: 'search_meetings', arguments: '{"query":"budget"}' } },
      { id: 'call_def', type: 'function', function: { name: 'search_memories', arguments: '{"query":"notes"}' } },
    ])
    const toolMsgs = second.filter(m => m.role === 'tool')
    expect(toolMsgs.map(m => m.tool_call_id)).toEqual(['call_abc', 'call_def'])
    for (const m of toolMsgs) expect('tool_name' in m).toBe(false)
    expect(JSON.parse(String(toolMsgs[0]!.content))).toMatchObject({ query: 'budget', hits: [{ title: 'Budget review' }] })
    expect(noticeCalls[0]!.variant).toBe('c1-tools-on')
  })

  it('caps a turn at 5 posts: post 5 is the closing fetch and its calls never run', async () => {
    handler = (_b, res, n) => {
      if (n >= 7) return sendText(res, ['too late']) // a removed cap would get here instead of failing
      sendToolCall(res, 'search_memories', `call_${n}`, ['{"query":"loop"}'])
    }
    const { relay, state } = fakeRelay()
    const c = collect()
    await callDirectStreaming('loop', undefined, c.callbacks, profile({ directTools: true }), undefined, undefined, undefined, opts(relay))
    expect(requests).toHaveLength(DIRECT_MAX_POSTS)
    expect(DIRECT_MAX_POSTS).toBe(5)
    expect(searchMemories).toHaveBeenCalledTimes(DIRECT_MAX_POSTS - 1)
    expect(c.error()).toBe(DIRECT_COPY.toolCap)
    expect(c.done()).toBeUndefined()
    expect(state.settles).toHaveLength(DIRECT_MAX_POSTS)
    expect(listDirectRuns(1)[0]).toMatchObject({ status: 'failed', errorCode: 'direct.tool_cap' })
  })

  it('D7: a remote endpoint without opt-in sends no tools and never runs a call the model makes anyway', async () => {
    handler = (_b, res) => sendToolCall(res, 'search_meetings', 'call_x', ['{"query":"secret"}'])
    const { relay } = fakeRelay()
    const c = collect()
    const views: DirectNoticeView[] = []
    await callDirectStreaming('q', undefined, c.callbacks, profile({ directTools: false }), undefined, undefined, undefined, opts(relay, { onKeyNotice: v => views.push(v) }))
    expect(views).toHaveLength(1)
    expect('tools' in requests[0]!.body).toBe(false)
    const system = (requests[0]!.body.messages as Array<{ role: string; content: string }>)[0]!
    expect(system.content).toContain('You have no tools.')
    expect(searchMeetingLibrary).not.toHaveBeenCalled()
    expect(requests).toHaveLength(1)
    expect(c.error()).toBe(DIRECT_COPY.empty)
    expect(noticeCalls[0]!.variant).toBe('c1-tools-off')
  })

  it('D7: a loopback endpoint gets the tools by default; the notice says so', async () => {
    handler = (_b, res) => sendText(res, ['ok'])
    const { relay, state } = fakeRelay()
    const p = profile({ id: 'local', keyRef: compatKeyRef, model: 'qwen-local', directTools: false })
    await callDirectStreaming('q', undefined, collect().callbacks, p, undefined, undefined, undefined, opts(relay))
    expect(state.bindings[0]!.endpoint).toBe(`${origin}/v1/chat/completions`)
    expect(Array.isArray(requests[0]!.body.tools)).toBe(true)
    expect(noticeCalls[0]!.variant).toBe('c1-tools-on')
  })

  it('a model the catalog says cannot call tools is sent none, even when the profile opted in', async () => {
    const live = new KeyCatalog({
      url: 'http://127.0.0.1:9/catalog',
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'meta-llama/llama-5-70b', name: 'Llama', pricing: { prompt: '0.0000004', completion: '0.0000004' }, supported_parameters: ['max_tokens'] }] }), { status: 200 }),
    })
    await live.get()
    handler = (_b, res) => sendText(res, ['ok'])
    await callDirectStreaming('q', undefined, collect().callbacks, profile({ model: 'meta-llama/llama-5-70b', directTools: true }), undefined, undefined, undefined, opts(fakeRelay().relay, { catalog: live }))
    expect('tools' in requests[0]!.body).toBe(false)
  })

  it('a server that rejects the tools key gets one retry without it, on the first post only', async () => {
    handler = (body, res, n) => n === 1 ? sendStatus(res, 400, '{"error":{"message":"tools are not supported by this model"}}') : sendText(res, ['plain'])
    const { relay, state } = fakeRelay()
    const c = collect()
    await callDirectStreaming('q', undefined, c.callbacks, profile({ directTools: true }), undefined, undefined, undefined, opts(relay))
    expect(c.done()!.text).toBe('plain')
    expect(Array.isArray(requests[0]!.body.tools)).toBe(true)
    expect('tools' in requests[1]!.body).toBe(false)
    expect(state.posts).toBe(2)
    expect(sleeps).toEqual([])
  })

  it('402 from upstream ends the turn at once with the out-of-credit line (no retry)', async () => {
    handler = (_b, res) => sendStatus(res, 402, '{"error":{"message":"Insufficient credits"}}')
    const { relay, state } = fakeRelay()
    const c = collect()
    const sid = await callDirectStreaming('q', undefined, c.callbacks, profile(), undefined, undefined, undefined, opts(relay))
    expect(c.error()).toBe('LINE:out_of_credit')
    expect(errorCalls.at(-1)).toMatchObject({ id: 'out_of_credit', keyKind: 'openrouter', capUsd: 1 })
    expect(requests).toHaveLength(1)
    expect(sleeps).toEqual([])
    expect(state.settles).toEqual([{ input: 0, output: 0 }])
    expect(getHistory(sid).map(e => e.role)).toEqual(['user'])
  })

  it('401 and model-gone end the turn with their lines', async () => {
    handler = (_b, res) => sendStatus(res, 401, '{"error":{"message":"No auth credentials found"}}')
    let c = collect()
    await callDirectStreaming('q', undefined, c.callbacks, profile(), undefined, undefined, undefined, opts(fakeRelay().relay))
    expect(c.error()).toBe('LINE:key_rejected')
    handler = (_b, res) => sendStatus(res, 400, '{"error":{"message":"anthropic/claude-sonnet-5.5 is not a valid model ID"}}')
    c = collect()
    await callDirectStreaming('q', undefined, c.callbacks, profile(), undefined, undefined, undefined, opts(fakeRelay().relay))
    expect(c.error()).toBe('LINE:model_gone')
    expect(requests).toHaveLength(2)
  })

  it('the relay cap refusal (402 billing, from the relay fake) refuses before any request', async () => {
    const atOpen = fakeRelay({ refuseOpen: 'cap_refused' })
    const c = collect()
    const sid = await callDirectStreaming('q', undefined, c.callbacks, profile(), undefined, undefined, undefined, opts(atOpen.relay))
    expect(c.error()).toBe('LINE:cap_refused')
    expect(requests).toHaveLength(0)
    expect(getHistory(sid)).toEqual([])

    const atPost = fakeRelay({ refusePost: () => 'cap_refused' })
    const c2 = collect()
    await callDirectStreaming('q', undefined, c2.callbacks, profile(), undefined, undefined, undefined, opts(atPost.relay))
    expect(c2.error()).toBe('LINE:cap_refused')
    expect(atPost.state.posts).toBe(1)
    expect(requests).toHaveLength(0)
    expect(sleeps).toEqual([])
  })

  it('429 with Retry-After is retried after that wait, then answers', async () => {
    handler = (_b, res, n) => n === 1 ? sendStatus(res, 429, '{}', { 'retry-after': '2' }) : sendText(res, ['ok'])
    const { relay, state } = fakeRelay()
    const c = collect()
    await callDirectStreaming('q', undefined, c.callbacks, profile(), undefined, undefined, undefined, opts(relay))
    expect(c.done()!.text).toBe('ok')
    expect(sleeps).toEqual([2000])
    expect(requests).toHaveLength(2)
    expect(state.settles[0]).toEqual({ input: 0, output: 0 })
  })

  it('429 three times: 2 retries, then the rate-limited line', async () => {
    handler = (_b, res) => sendStatus(res, 429, '{}')
    const c = collect()
    await callDirectStreaming('q', undefined, c.callbacks, profile(), undefined, undefined, undefined, opts(fakeRelay().relay))
    expect(requests).toHaveLength(3)
    expect(sleeps).toEqual([1000, 3000])
    expect(c.error()).toBe('LINE:rate_limited')
  })

  it('a Retry-After past 30 s stops at once with the rate-limited line', async () => {
    handler = (_b, res) => sendStatus(res, 429, '{}', { 'retry-after': '120' })
    const c = collect()
    await callDirectStreaming('q', undefined, c.callbacks, profile(), undefined, undefined, undefined, opts(fakeRelay().relay))
    expect(requests).toHaveLength(1)
    expect(sleeps).toEqual([])
    expect(c.error()).toBe('LINE:rate_limited')
  })

  it('5xx and network errors retry; a network error that persists ends with the network line', async () => {
    handler = (_b, res, n) => n === 1 ? sendStatus(res, 503, '{}') : sendText(res, ['ok'])
    const c = collect()
    await callDirectStreaming('q', undefined, c.callbacks, profile(), undefined, undefined, undefined, opts(fakeRelay().relay))
    expect(c.done()!.text).toBe('ok')
    expect(sleeps).toEqual([1000])

    sleeps.length = 0
    const down = fakeRelay({ throwPost: () => true })
    const c2 = collect()
    await callDirectStreaming('q', undefined, c2.callbacks, profile(), undefined, undefined, undefined, opts(down.relay))
    expect(down.state.posts).toBe(3)
    expect(c2.error()).toBe('LINE:network_error')
  })

  it('refuses before any work when lanes are off, the profile is not direct or off, or no relay is registered', async () => {
    const { relay, state } = fakeRelay()
    const ledger = process.env.COS_DIRECT_RUN_LEDGER_FILE!
    const ledgerBefore = existsSync(ledger) ? readFileSync(ledger, 'utf8') : null
    process.env.COS_KEY_LANES = '0'
    let c = collect()
    let sid = await callDirectStreaming('q', undefined, c.callbacks, profile(), undefined, undefined, undefined, opts(relay))
    expect(c.error()).toBe('LINE:profile_off')
    expect(getHistory(sid)).toEqual([])
    expect(logTokenAudit).not.toHaveBeenCalled()
    process.env.COS_KEY_LANES = '1'

    c = collect()
    await callDirectStreaming('q', undefined, c.callbacks, profile({ engine: 'claude' }), undefined, undefined, undefined, opts(relay))
    expect(c.error()).toBe(DIRECT_COPY.wrongEngine)

    c = collect()
    await callDirectStreaming('q', undefined, c.callbacks, profile({ enabled: false, id: 'off-one' }), undefined, undefined, undefined, opts(relay))
    expect(c.error()).toBe('LINE:profile_off')

    c = collect()
    await callDirectStreaming('q', undefined, c.callbacks, profile({ keyRef: 'key_000000000000' }), undefined, undefined, undefined, opts(relay))
    expect(c.error()).toBe('LINE:profile_removed')

    c = collect()
    sid = await callDirectStreaming('q', undefined, c.callbacks, profile(), undefined, undefined, undefined, { notices, sleep, catalog })
    expect(c.error()).toBe(DIRECT_COPY.relayUnavailable)
    expect(getHistory(sid)).toEqual([])

    expect(state.bindings).toHaveLength(0)
    expect(requests).toHaveLength(0)
    expect(existsSync(ledger) ? readFileSync(ledger, 'utf8') : null).toBe(ledgerBefore)
    expect(logTokenAudit).not.toHaveBeenCalled()
  })

  it('uses the registered relay when none is injected', async () => {
    const { relay, state } = fakeRelay()
    registerDirectRelay(() => relay)
    handler = (_b, res) => sendText(res, ['ok'])
    const c = collect()
    await callDirectStreaming('q', undefined, c.callbacks, profile(), undefined, undefined, undefined, { notices, sleep, catalog })
    expect(c.done()!.text).toBe('ok')
    expect(state.bindings).toHaveLength(1)
  })

  it('an external abort mid-stream ends the turn as cancelled and settles the reservation in full', async () => {
    const abort = new AbortController()
    handler = (_b, res) => { sseHead(res); res.write(textDelta('Start')) }
    const { relay, state } = fakeRelay()
    const c = collect()
    c.callbacks.onChunk = () => abort.abort()
    await callDirectStreaming('q', undefined, c.callbacks, profile(), undefined, undefined, undefined, opts(relay, { abortSignal: abort.signal }))
    expect(c.error()).toBe(DIRECT_COPY.cancelled)
    expect(state.settles).toEqual([null])
    expect(state.closed).toBe(1)
  })
})
