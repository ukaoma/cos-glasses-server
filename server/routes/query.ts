// POST /api/query — streaming SSE endpoint for Claude queries
// Returns text/event-stream with chunk, done, and error events

import { Router } from 'express'
import { callModelStreaming } from '../lib/model-router.js'
import { emitDisplay } from '../lib/display-bus.js'
import { errMsg } from '../lib/utils.js'
import {
  isCursorModel,
  normalizeEffortPreference,
  normalizeModelPreference,
} from '../../shared/model-preference.js'
import { QueryAttachmentError, resolveQueryAttachments } from '../lib/query-attachments.js'
import { getMediaStore } from '../lib/media-store.js'
import { mergeMediaAttachmentRefs } from '../../shared/media-attachment.js'
import {
  acquireMaintenanceWork,
  MaintenanceLifecycleError,
  maintenanceErrorPayload,
} from '../lib/maintenance-lifecycle.js'
import { currentMessageEra, LEGACY_MESSAGE_ERA } from '../lib/message-era.js'

const TOOL_STATUS_MESSAGES: Record<string, string> = {
  WebSearch: 'Searching web...',
  WebFetch: 'Reading page...',
  Read: 'Analyzing photo...',
  search_meetings: 'Searching meetings...',
  search_memories: 'Searching memory...',
  read_meeting: 'Reading meeting...',
}

export const queryRouter = Router()

queryRouter.post('/query', async (req, res) => {
  let maintenanceLease
  try {
    maintenanceLease = acquireMaintenanceWork('legacy_query')
  } catch (error) {
    if (error instanceof MaintenanceLifecycleError) {
      if (error.retryAfterSeconds != null) res.setHeader('Retry-After', String(error.retryAfterSeconds))
      return res.status(error.status).json(maintenanceErrorPayload(error))
    }
    throw error
  }
  const { query, sessionId, model, effort, reference, globalMsgNum, messageEra } = req.body
  const activityToolMode = req.body.activityToolMode === 'off' || req.body.activityToolMode === 'preview'
    ? req.body.activityToolMode
    : 'status'
  // Glasses Settings default is Agent. Only an explicit "ask" stays read-only —
  // omit/unknown must not silently force Ask (6.16.3 durable-only gap).
  const cursorExecutionMode = req.body.cursorExecutionMode === 'ask' ? 'ask' as const : 'agent' as const

  // Once a reset era exists, reject pre-era clients before they can stamp a
  // five-digit number into the fresh namespace. Companion learns the era from
  // /api/message-counter and includes it on every query.
  const activeMessageEra = currentMessageEra()
  if (activeMessageEra !== LEGACY_MESSAGE_ERA && messageEra !== activeMessageEra) {
    console.warn('[query] message era mismatch', {
      sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      sentEra: typeof messageEra === 'string' ? messageEra : '(missing)',
      expectedEra: activeMessageEra,
    })
    maintenanceLease.release()
    return res.status(409).json({
      error: 'message_era_mismatch',
      detail: 'Reopen or update COS Glasses. Your cards stay; the next message is #1.',
      era: activeMessageEra,
    })
  }

  // Resolve durable attachment ids and legacy base64 images through one
  // validation/normalization path before opening SSE.
  let resolvedAttachments
  try {
    resolvedAttachments = await resolveQueryAttachments(req.body)
  } catch (err) {
    if (err instanceof QueryAttachmentError) {
      maintenanceLease.release()
      return res.status(err.status).json({ error: err.code, detail: err.message })
    }
    maintenanceLease.release()
    return res.status(500).json({ error: errMsg(err) })
  }
  const imageInputs = resolvedAttachments.inputs.length > 0 ? resolvedAttachments.inputs : undefined
  const attachmentRefs = resolvedAttachments.refs

  const resolvedQuery = typeof query === 'string' ? query : ''

  // Attachment-only queries use a category-aware provider default.
  if ((!resolvedQuery || typeof resolvedQuery !== 'string') && attachmentRefs.length === 0) {
    maintenanceLease.release()
    return res.status(400).json({ error: 'query string or attachment required' })
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
  // The session id AS REPORTED BY THE BRIDGE.
  //
  // `const sid = await callModelStreaming(...)` below is not assigned until the
  // whole call resolves, but these callbacks fire DURING that await — so any
  // callback that reads `sid` reads a temporal-dead-zone binding and throws
  // ReferenceError. `onStart` never noticed because its own `sid` PARAMETER
  // shadows the outer const; `onDone` has no such parameter and did throw,
  // after setting `done = true` and before writing the terminal event, which
  // left the SSE socket open forever with the answer already persisted.
  //
  // Measured 2026-08-26: an Ollama tool turn streamed its full answer and never
  // sent `done`; the glasses counted past 1,100 seconds on a turn that had
  // finished in 166. Claude survived only because its bridge resolves outside
  // the window — the same line was one scheduling change away from hanging
  // every provider.
  let streamSessionId: string | undefined = typeof sessionId === 'string' ? sessionId : undefined
  const abortController = new AbortController()
  res.on('close', () => {
    if (!done) abortController.abort()
    done = true
  })

  try {
    const sid = await callModelStreaming(resolvedQuery || '', sessionId, {
      onStart: (model, sid, cliSessionId, metadata) => {
        streamSessionId = sid
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
      // Activity lines stay on this authenticated request stream. The guard is
      // unchanged; the reason has moved. Since 6.42.0 the global display stream is
      // not "unauthenticated" — it ADMITS ticketless subscribers (200 for everyone,
      // so an installed client keeps a live transport) and withholds CONTENT per
      // event instead. Broadcasting observable command/output text onto that bus
      // would leave it one allowlist entry away from an unauthenticated listener,
      // so it is never emitted there at all.
      ...(activityToolMode === 'preview' ? {
        onActivityLine: (line: { kind: 'input' | 'output'; text: string }) => {
          if (!done) {
            res.write(`event: activity_line\ndata: ${JSON.stringify(line)}\n\n`)
          }
        },
      } : {}),
      onDone: async (fullText, model, cliSessionId, metadata) => {
        try {
          // Durable association is independent of the SSE socket.
          // Backgrounding the phone cannot leave request media reserved until
          // expiry or make maintenance proof outrun the pending write.
          if (resolvedAttachments.ids.length > 0) {
            await getMediaStore().associate(resolvedAttachments.ids, {
              sessionId: streamSessionId ?? '',
              ...(validGlobalMsgNum ? { globalMsgNum: validGlobalMsgNum } : {}),
              messageEra: activeMessageEra,
            }).catch((err) => console.error('[query] attachment association failed:', err))
          }
          if (!done) {
            done = true
            const attachments = mergeMediaAttachmentRefs(attachmentRefs, metadata?.outputAttachments)
            const { outputAttachments: _outputAttachments, ...runMetadata } = metadata ?? {}
            const payload = {
              text: fullText, sessionId: streamSessionId, model, cliSessionId, ...runMetadata,
              ...(attachments.length > 0 ? { attachments } : {}),
            }
            res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`)
            emitDisplay({ type: 'done', data: payload })
            res.end()
          }
        } finally {
          maintenanceLease.release()
        }
      },
      onError: (error) => {
        try {
          if (!done) {
            done = true
            res.write(`event: error\ndata: ${JSON.stringify({ error })}\n\n`)
            emitDisplay({ type: 'error', data: { error } })
            res.end()
          }
        } finally {
          maintenanceLease.release()
        }
      },
    }, validModel, imageInputs,
      // Pass reference if provided (for "recall message N" feature)
      reference && typeof reference === 'object' && reference.query && reference.response
        ? { query: String(reference.query), response: String(reference.response) }
        : undefined,
      validGlobalMsgNum,
      {
        abortSignal: abortController.signal,
        effort: validEffort,
        messageEra: activeMessageEra,
        requestAttachments: attachmentRefs,
        attachmentPromptBlock: resolvedAttachments.promptBlock,
        ...(validModel && isCursorModel(validModel) ? { cursorExecutionMode } : {}),
      },
    )
  } catch (err: unknown) {
    maintenanceLease.release()
    if (!done) {
      done = true
      res.write(`event: error\ndata: ${JSON.stringify({ error: errMsg(err) })}\n\n`)
      res.end()
    }
  }

})
