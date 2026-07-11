// POST /api/query — streaming SSE endpoint for Claude queries
// Returns text/event-stream with chunk, done, and error events

import { Router } from 'express'
import { callModelStreaming } from '../lib/model-router.js'
import { emitDisplay } from '../lib/display-bus.js'
import { errMsg } from '../lib/utils.js'
import { normalizeEffortPreference, normalizeModelPreference } from '../../shared/model-preference.js'
import { QueryAttachmentError, resolveQueryAttachments } from '../lib/query-attachments.js'
import { getMediaStore } from '../lib/media-store.js'
import { mergeMediaAttachmentRefs } from '../../shared/media-attachment.js'

const TOOL_STATUS_MESSAGES: Record<string, string> = {
  WebSearch: 'Searching web...',
  WebFetch: 'Reading page...',
  Read: 'Analyzing photo...',
}

export const queryRouter = Router()

queryRouter.post('/query', async (req, res) => {
  const { query, sessionId, model, effort, reference, globalMsgNum } = req.body
  const activityToolMode = req.body.activityToolMode === 'off' || req.body.activityToolMode === 'preview'
    ? req.body.activityToolMode
    : 'status'

  // Resolve durable attachment ids and legacy base64 images through one
  // validation/normalization path before opening SSE.
  let resolvedAttachments
  try {
    resolvedAttachments = await resolveQueryAttachments(req.body)
  } catch (err) {
    if (err instanceof QueryAttachmentError) {
      return res.status(err.status).json({ error: err.code, detail: err.message })
    }
    return res.status(500).json({ error: errMsg(err) })
  }
  const imageInputs = resolvedAttachments.inputs.length > 0 ? resolvedAttachments.inputs : undefined
  const attachmentRefs = resolvedAttachments.refs

  const resolvedQuery = typeof query === 'string' ? query : ''

  // Vision queries can have an empty query (default to "describe what you see")
  if ((!resolvedQuery || typeof resolvedQuery !== 'string') && !imageInputs) {
    return res.status(400).json({ error: 'query string or image required' })
  }

  // Validate model if provided
  const validModel = normalizeModelPreference(model)
  const validEffort = normalizeEffortPreference(effort)

  // Validate globalMsgNum if provided
  const validGlobalMsgNum = typeof globalMsgNum === 'number' && globalMsgNum > 0
    ? globalMsgNum : undefined

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',  // Disable nginx buffering if proxied
    'Access-Control-Allow-Origin': '*',  // Even Hub WebView loads from file://
  })

  // Flush headers immediately
  res.flushHeaders()
  res.write(': keepalive\n\n')

  let done = false
  const abortController = new AbortController()
  res.on('close', () => {
    if (!done) abortController.abort()
    done = true
  })

  try {
    const sid = await callModelStreaming(resolvedQuery || '', sessionId, {
      onStart: (model, sid, cliSessionId, metadata) => {
        if (!done) {
          const payload = { model, sessionId: sid, cliSessionId, ...metadata }
          res.write(`event: start\ndata: ${JSON.stringify(payload)}\n\n`)
          emitDisplay({ type: 'start', data: payload })
        }
      },
      onChunk: (text) => {
        if (!done) {
          res.write(`event: chunk\ndata: ${JSON.stringify({ text })}\n\n`)
          emitDisplay({ type: 'chunk', data: { text } })
        }
      },
      onToolStatus: (toolName) => {
        if (!done) {
          const message = activityToolMode === 'off'
            ? 'Processing...'
            : TOOL_STATUS_MESSAGES[toolName] ?? (/\s|\.{3}$/.test(toolName) ? toolName : `Using ${toolName}...`)
          res.write(`event: tool_status\ndata: ${JSON.stringify({ message })}\n\n`)
          emitDisplay({ type: 'tool_status', data: { message } })
        }
      },
      // Activity lines stay on this authenticated request stream. The global
      // display stream is intentionally unauthenticated for Even Hub recovery,
      // so observable command/output text must never be broadcast there.
      ...(activityToolMode === 'preview' ? {
        onActivityLine: (line: { kind: 'input' | 'output'; text: string }) => {
          if (!done) {
            res.write(`event: activity_line\ndata: ${JSON.stringify(line)}\n\n`)
          }
        },
      } : {}),
      onDone: (fullText, model, cliSessionId, metadata) => {
        // Durable association is independent of the SSE socket. Backgrounding
        // the phone cannot leave request media reserved until expiry.
        if (resolvedAttachments.ids.length > 0) {
          getMediaStore().associate(resolvedAttachments.ids, {
            sessionId: sid,
            ...(validGlobalMsgNum ? { globalMsgNum: validGlobalMsgNum } : {}),
          }).catch((err) => console.error('[query] attachment association failed:', err))
        }
        if (!done) {
          done = true
          const attachments = mergeMediaAttachmentRefs(attachmentRefs, metadata?.outputAttachments)
          const { outputAttachments: _outputAttachments, ...runMetadata } = metadata ?? {}
          const payload = {
            text: fullText, sessionId: sid, model, cliSessionId, ...runMetadata,
            ...(attachments.length > 0 ? { attachments } : {}),
          }
          res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`)
          emitDisplay({ type: 'done', data: payload })
          res.end()
        }
      },
      onError: (error) => {
        if (!done) {
          done = true
          res.write(`event: error\ndata: ${JSON.stringify({ error })}\n\n`)
          emitDisplay({ type: 'error', data: { error } })
          res.end()
        }
      },
    }, validModel, imageInputs,
      // Pass reference if provided (for "recall message N" feature)
      reference && typeof reference === 'object' && reference.query && reference.response
        ? { query: String(reference.query), response: String(reference.response) }
        : undefined,
      validGlobalMsgNum,
      { abortSignal: abortController.signal, effort: validEffort },
    )
  } catch (err: unknown) {
    if (!done) {
      done = true
      res.write(`event: error\ndata: ${JSON.stringify({ error: errMsg(err) })}\n\n`)
      res.end()
    }
  }

})
