// OpenAI-compatible /v1/chat/completions endpoint
// Adapter for Even Realities "Add Agent" and any OpenAI-compatible client.
// Accepts standard OpenAI format, routes through COS model-router, returns OpenAI format.
// Supports both streaming (SSE) and non-streaming responses.

import { Router } from 'express'
import { preWarmCLI, logLatency } from '../lib/claude-bridge.js'
import { callModelStreaming } from '../lib/model-router.js'
import { normalizeModelPreference, DEFAULT_MODEL, type ModelPreference } from '../../shared/model-preference.js'
import {
  getCodexModelCatalog,
  resolveCodexPreferenceForModelId,
} from '../lib/codex-model-catalog.js'
import { tryInstantResponse } from '../lib/response-cache.js'
import crypto from 'node:crypto'

export const openaiCompatRouter = Router()

// ─── Dedup guard — prevent Even from doubling server load ───
// Maps query text → { promise, timestamp } for in-flight requests.
// If the same query arrives within 2s of a pending request, reuse the result.
const inflightQueries = new Map<string, { promise: Promise<string>; timestamp: number }>()
const DEDUP_WINDOW_MS = 2000

function cleanupInflight() {
  const now = Date.now()
  for (const [key, entry] of inflightQueries) {
    if (now - entry.timestamp > 30000) inflightQueries.delete(key) // 30s max
  }
}

// ─── Daily persistent session ───
// Session persists across all G2 queries for the entire day, building context
// as the user explores concepts, checks facts, follows threads.
// Auto-resets at midnight to prevent context rot.
// Say "reset session" or "new session" to force reset.
let g2SessionId: string | undefined = undefined
let g2SessionDate: string | undefined = undefined  // YYYY-MM-DD of current session

function getOrResetG2Session(): string | undefined {
  const today = new Date().toISOString().slice(0, 10)
  if (g2SessionDate !== today) {
    // New day — reset session to prevent context rot
    g2SessionId = undefined
    g2SessionDate = today
    console.log(`[g2] Daily session reset (${today})`)
    // Lazy pre-warm: fire-and-forget so next query has a warm CLI session
    preWarmCLI().catch(() => {})
  }
  return g2SessionId
}

function shouldResetSession(query: string): boolean {
  return /\b(reset session|new session|fresh start|clear context|start over)\b/i.test(query)
}

// Optional: validate Bearer token against COS_API_TOKEN
function validateAuth(req: any, res: any): boolean {
  const cosToken = process.env.COS_API_TOKEN
  if (!cosToken) return true // No token configured = open access

  const auth = req.headers['authorization']
  if (!auth || !auth.startsWith('Bearer ')) {
    res.status(401).json({ error: { message: 'Missing Bearer token', type: 'invalid_request_error' } })
    return false
  }

  const token = auth.slice(7)
  if (token !== cosToken) {
    res.status(401).json({ error: { message: 'Invalid token', type: 'invalid_request_error' } })
    return false
  }

  return true
}

// Resolve model from OpenAI-compatible ids, stable app slots, or concrete ids
// currently advertised by the live Codex catalog.
function resolveModel(model?: string, _query?: string): ModelPreference {
  const normalized = normalizeModelPreference(model)
  if (normalized) return normalized
  if (model) {
    const catalogPreference = resolveCodexPreferenceForModelId(model)
    if (catalogPreference) return catalogPreference
  }
  if (model === 'cos-opus') return 'opus'
  if (model === 'cos-fable') return 'fable'
  if (model === 'cos-sonnet') return 'sonnet'
  if (model === 'cos-haiku') return 'haiku'
  if (model === 'cos-gpt-frontier' || model === 'cos-codex-high' || model === 'cos-codex') return 'codex-frontier'
  if (model === 'cos-gpt-balanced') return 'codex-balanced'
  return normalizeModelPreference(process.env.COS_G2_DEFAULT_MODEL) ?? DEFAULT_MODEL
}

const MODEL_NAMES: Record<ModelPreference, string> = {
  opus: 'cos-opus',
  fable: 'cos-fable',
  sonnet: 'cos-sonnet',
  haiku: 'cos-haiku',
  'codex-frontier': 'cos-gpt-frontier',
  'codex-balanced': 'cos-gpt-balanced',
}

// Extract the user's latest message from the OpenAI messages array
function extractUserQuery(messages: Array<{ role: string; content: string }>): string {
  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].content) {
      return messages[i].content
    }
  }
  return ''
}

openaiCompatRouter.post('/v1/chat/completions', async (req, res) => {
  if (!validateAuth(req, res)) return

  const { messages, stream, model } = req.body

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: { message: 'messages array required', type: 'invalid_request_error' },
    })
  }

  let query = extractUserQuery(messages)
  if (!query) {
    return res.status(400).json({
      error: { message: 'No user message found', type: 'invalid_request_error' },
    })
  }


  // Log request entry — tells us if Even sends stream: true or false
  console.log(`[g2] Request: stream=${!!stream}, query="${query.slice(0, 50)}"`)

  const requestReceivedAt = Date.now()
  const resolvedModel = resolveModel(model, query)
  const completionId = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`
  const timestamp = Math.floor(Date.now() / 1000)
  const responseModel = MODEL_NAMES[resolvedModel]

  // ── Predictive response cache — bypass Claude for common queries ──
  const cached = tryInstantResponse(query)
  if (cached) {
    const ttfb = Date.now() - requestReceivedAt
    logLatency({
      timestamp: new Date().toISOString(),
      query: query.slice(0, 50),
      ttfb_ms: ttfb,
      total_ms: ttfb,
      model: 'cache',
      resumed: false,
      contextInjected: false,
      cacheHit: true,
    })
    console.log(`[g2] Cache hit (${cached.pattern}): "${query}" → ${ttfb}ms`)

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
      })
      res.flushHeaders()
      const chunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: timestamp,
        model: responseModel,
        choices: [{ index: 0, delta: { content: cached.text }, finish_reason: null }],
      }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      const finalChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: timestamp,
        model: responseModel,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    // Non-streaming cache response
    return res.json({
      id: completionId,
      object: 'chat.completion',
      created: timestamp,
      model: responseModel,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: cached.text },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  }

  // ── Dedup guard — if same query is already in-flight within 2s, reuse result ──
  cleanupInflight()
  const dedupKey = `${resolvedModel}:${query.trim().toLowerCase()}`
  const inflight = inflightQueries.get(dedupKey)
  if (inflight && (Date.now() - inflight.timestamp) < DEDUP_WINDOW_MS) {
    console.log(`[g2] Dedup hit: "${query.slice(0, 50)}" (waiting for in-flight result)`)
    try {
      const dedupResult = await inflight.promise
      logLatency({
        timestamp: new Date().toISOString(),
        query: query.slice(0, 50),
        ttfb_ms: Date.now() - requestReceivedAt,
        total_ms: Date.now() - requestReceivedAt,
        model: resolvedModel,
        resumed: false,
        contextInjected: false,
        cacheHit: false,
        deduped: true,
      })
      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
        })
        res.flushHeaders()
        const chunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created: timestamp,
          model: responseModel,
          choices: [{ index: 0, delta: { content: dedupResult }, finish_reason: null }],
        }
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: timestamp, model: responseModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      return res.json({
        id: completionId,
        object: 'chat.completion',
        created: timestamp,
        model: responseModel,
        choices: [{ index: 0, message: { role: 'assistant', content: dedupResult }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })
    } catch {
      // Original request failed — fall through to make a fresh request
    }
  }

  // Register this query as in-flight for dedup
  let resolveInflight: (text: string) => void
  let rejectInflight: (err: any) => void
  const inflightPromise = new Promise<string>((res, rej) => { resolveInflight = res; rejectInflight = rej })
  void inflightPromise.catch(() => { /* duplicate waiters observe the original rejection */ })
  inflightQueries.set(dedupKey, { promise: inflightPromise, timestamp: Date.now() })

  // ── Streaming response (SSE) ──
  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
    })
    res.flushHeaders()

    // Immediate keepalive — prevents ER app timeout while Claude processes
    res.write(': keepalive\n\n')

    let done = false
    let firstChunkLogged = false
    let actualTtfbMs = -1  // Captured at first chunk arrival

    // Check for session reset command
    if (shouldResetSession(query)) {
      g2SessionId = undefined
      g2SessionDate = new Date().toISOString().slice(0, 10)
      console.log(`[g2] Manual session reset`)
    }

    const currentSessionId = getOrResetG2Session()

    // Pass query directly — conciseness instruction is in the system prompt now
    try {
      const returnedSid = await callModelStreaming(query, currentSessionId, {
        onChunk: (text) => {
          if (!done) {
            if (!firstChunkLogged) {
              firstChunkLogged = true
              actualTtfbMs = Date.now() - requestReceivedAt
              console.log(`[g2] TTFB: ${actualTtfbMs}ms (${resolvedModel}, session: ${currentSessionId ? 'resumed' : 'new'})`)
            }
            const chunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created: timestamp,
              model: responseModel,
              choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
          }
        },
        onDone: (fullText) => {
          if (!done) {
            done = true
            resolveInflight!(fullText || '')
            inflightQueries.delete(dedupKey)
            logLatency({
              timestamp: new Date().toISOString(),
              query: query.slice(0, 50),
              ttfb_ms: actualTtfbMs,
              total_ms: Date.now() - requestReceivedAt,
              model: resolvedModel,
              resumed: !!currentSessionId,
              contextInjected: /\b(schedule|calendar|meeting|task|tasks|today|tomorrow|next meeting|who do i meet|what's next)\b/i.test(query),
              cacheHit: false,
              stream_requested: true,
            })
            // Final chunk with finish_reason
            const finalChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created: timestamp,
              model: responseModel,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            }
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
          }
        },
        onError: (error) => {
          if (!done) {
            done = true
            rejectInflight!(new Error(error))
            inflightQueries.delete(dedupKey)
            const errChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created: timestamp,
              model: responseModel,
              choices: [{ index: 0, delta: { content: `Error: ${error}` }, finish_reason: 'stop' }],
            }
            res.write(`data: ${JSON.stringify(errChunk)}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
          }
        },
        onToolStatus: (status) => {
          if (!done) {
            // SSE comment — invisible to JSON parsers but keeps connection alive
            res.write(`: ${status}\n\n`)
          }
        },
        onStart: () => {},
      }, resolvedModel, undefined, undefined, undefined, { lightweight: true })
      // Persist session ID for multi-turn context on subsequent G2 queries
      g2SessionId = returnedSid
    } catch (err: any) {
      if (!done) {
        done = true
        rejectInflight!(err)
        inflightQueries.delete(dedupKey)
        res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      }
    }

    req.on('close', () => { done = true })
    return
  }

  // ── Non-streaming response ──
  // Check for session reset command
  if (shouldResetSession(query)) {
    g2SessionId = undefined
    g2SessionDate = new Date().toISOString().slice(0, 10)
    console.log(`[g2] Manual session reset (non-stream)`)
  }

  const currentSessionIdNS = getOrResetG2Session()

  try {
    const fullText = await new Promise<string>((resolve, reject) => {
      let result = ''
      let nsFirstChunkMs = -1
      let settled = false
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        const err = error instanceof Error ? error : new Error(String(error))
        rejectInflight!(err)
        inflightQueries.delete(dedupKey)
        reject(err)
      }
      callModelStreaming(query, currentSessionIdNS, {
        onChunk: (text) => {
          if (nsFirstChunkMs < 0) nsFirstChunkMs = Date.now() - requestReceivedAt
          result += text
        },
        onDone: (fullText) => {
          if (settled) return
          settled = true
          const text = fullText || result
          resolveInflight!(text)
          inflightQueries.delete(dedupKey)
          logLatency({
            timestamp: new Date().toISOString(),
            query: query.slice(0, 50),
            ttfb_ms: nsFirstChunkMs,
            total_ms: Date.now() - requestReceivedAt,
            model: resolvedModel,
            resumed: !!currentSessionIdNS,
            contextInjected: /\b(schedule|calendar|meeting|task|tasks|today|tomorrow)\b/i.test(query),
            cacheHit: false,
            stream_requested: false,
          })
          resolve(text)
        },
        onError: (error) => {
          fail(new Error(error))
        },
        onToolStatus: () => {},
        onStart: () => {},
      }, resolvedModel, undefined, undefined, undefined, { lightweight: true })
        .then(sid => { g2SessionId = sid })
        .catch(fail)
    })

    res.json({
      id: completionId,
      object: 'chat.completion',
      created: timestamp,
      model: responseModel,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: fullText },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  } catch (err: any) {
    res.status(500).json({
      error: { message: err.message, type: 'server_error' },
    })
  }
})

// GET /v1/models — required by some clients for model discovery
openaiCompatRouter.get('/v1/models', async (_req, res) => {
  const catalog = await getCodexModelCatalog()
  res.json({
    object: 'list',
	    data: [
	      { id: 'cos-opus', object: 'model', created: 1709251200, owned_by: 'cos' },
	      { id: 'cos-fable', object: 'model', created: 1709251200, owned_by: 'cos' },
	      { id: 'cos-sonnet', object: 'model', created: 1709251200, owned_by: 'cos' },
	      { id: 'cos-haiku', object: 'model', created: 1709251200, owned_by: 'cos' },
	      { id: 'cos-gpt-frontier', object: 'model', created: 1709251200, owned_by: 'cos' },
	      { id: 'cos-gpt-balanced', object: 'model', created: 1709251200, owned_by: 'cos' },
	      ...catalog.options.filter(option => option.id).map(option => ({
	        id: option.id,
	        object: 'model',
	        created: 1709251200,
	        owned_by: 'openai',
	      })),
	    ],
	  })
	})
