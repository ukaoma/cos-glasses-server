import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { acquireModelSessionRunLock, callModelStreaming } from './model-router.js'
import { emitDisplay } from './display-bus.js'
import { resolveQueryAttachments } from './query-attachments.js'
import { getMediaStore } from './media-store.js'
import { dataPath } from './data-dir.js'
import { durableQueryJobsEnabled } from './query-job-feature.js'
import { QueryJobCoordinator, type QueryJobRunner } from './query-job-coordinator.js'
import { QueryJobStore } from './query-job-store.js'
import {
  isCodexModel,
  normalizeEffortPreference,
  normalizeModelPreference,
  type ModelPreference,
} from '../../shared/model-preference.js'
import { mergeMediaAttachmentRefs } from '../../shared/media-attachment.js'
import {
  findExchangesByJobIdentity,
  flushConversationToDisk,
  reconcileExchangeByJobIdentity,
  removeExchangesByJobIdentity,
} from './conversation.js'
import {
  isTerminalQueryJobStatus,
  type QueryJobRequest,
  type QueryJobSnapshot,
} from './query-job-types.js'

const TOOL_STATUS_MESSAGES: Record<string, string> = {
  WebSearch: 'Searching web...',
  WebFetch: 'Reading page...',
  Read: 'Analyzing photo...',
}

/** Resolve image bytes/ids before returning 202. The journal receives only
 * validated refs and ids; base64 bytes and provider-local paths are dropped by
 * the strict QueryJobRequest parser before persistence. */
export async function preparePublicDurableQueryAdmission(raw: unknown): Promise<unknown> {
  if (!raw || typeof raw !== 'object') return raw
  const input = raw as Record<string, unknown>
  const resolved = await resolveQueryAttachments(input)
  return {
    ...input,
    attachmentIds: resolved.ids,
    attachmentRefs: resolved.refs,
  }
}

function providerFor(model: ModelPreference): 'claude' | 'codex' {
  return isCodexModel(model) ? 'codex' : 'claude'
}

/** Project the authoritative terminal journal into the derived conversation
 * cache. Journaled request/response text always wins over bridge-written
 * partial rows; validated media refs may be merged because output media can
 * finish immediately before a crash. Exact provenance collapses duplicates. */
async function projectPublicConversationTerminal(
  job: QueryJobSnapshot,
  request: QueryJobRequest,
): Promise<void> {
  if (!isTerminalQueryJobStatus(job.status)) return
  const identity = { clientJobId: request.clientJobId, generation: request.generation }
  if (job.status !== 'completed') {
    removeExchangesByJobIdentity(request.sessionId, identity)
    flushConversationToDisk()
    return
  }

  const existing = findExchangesByJobIdentity(request.sessionId, identity)
  const existingAssistant = existing.find(exchange => exchange.role === 'assistant')
  const imageCount = request.attachmentRefs.length
  const photoPrefix = imageCount === 1 ? '[Photo]' : imageCount > 1 ? `[${imageCount} Photos]` : ''
  const userContent = photoPrefix ? `${photoPrefix} ${request.query || 'What do you see?'}` : request.query
  const requestIds = new Set(request.attachmentRefs.map(ref => ref.id))
  const outputAttachments = job.attachments.filter(ref => !requestIds.has(ref.id))
  const existingOutputAttachments = existingAssistant?.attachments?.filter(ref => !requestIds.has(ref.id))

  reconcileExchangeByJobIdentity(
    request.sessionId,
    identity,
    'user',
    userContent,
    request.globalMsgNum,
    request.attachmentRefs,
  )
  reconcileExchangeByJobIdentity(
    request.sessionId,
    identity,
    'assistant',
    job.response ?? job.partialText,
    request.globalMsgNum,
    mergeMediaAttachmentRefs(outputAttachments, existingOutputAttachments),
  )
  flushConversationToDisk()
}

const runner: QueryJobRunner = async ({ jobId, turnId, request, signal, callbacks }) => {
  // Resolve ids again at execution time. This closes the admission/execution
  // TOCTOU window without ever putting paths or bytes in the journal.
  const resolvedAttachments = await resolveQueryAttachments({
    attachmentIds: request.attachmentIds,
    clientQueueItemId: request.clientQueueItemId,
    sessionId: request.sessionId,
  })
  const imageInputs = resolvedAttachments.inputs.length > 0 ? resolvedAttachments.inputs : undefined
  const validModel = normalizeModelPreference(request.model)
  const validEffort = normalizeEffortPreference(request.effort)
  let activeModel = validModel

  await callModelStreaming(
    request.query,
    request.sessionId,
    {
      onStart: async (model, sessionId, cliSessionId, metadata) => {
        activeModel = model
        const linkage = {
          provider: providerFor(model),
          resolvedModel: model,
          cliSessionId,
          claudeRunId: metadata?.claudeRunId,
          codexRunId: metadata?.codexRunId,
          codexThreadId: metadata?.codexThreadId,
        } as const
        await callbacks.onStart({ sessionId, ...linkage })
        emitDisplay({ type: 'start', data: {
          jobId,
          clientJobId: request.clientJobId,
          generation: request.generation,
          turnId,
          messageEra: request.messageEra,
          globalMsgNum: request.globalMsgNum,
          model,
          sessionId,
          cliSessionId,
          ...metadata,
        } })
      },
      onProviderProcess: metadata => callbacks.onProviderProcess({
        provider: metadata.provider,
        ...(activeModel ? { resolvedModel: activeModel } : {}),
        ...(metadata.provider === 'claude'
          ? { claudeRunId: metadata.runId }
          : { codexRunId: metadata.runId }),
      }),
      onChunk: text => { callbacks.onChunk(text) },
      onToolStatus: toolName => {
        const message = request.activityToolMode === 'off'
          ? 'Processing...'
          : TOOL_STATUS_MESSAGES[toolName] ?? (/\s|\.{3}$/.test(toolName) ? toolName : `Using ${toolName}...`)
        callbacks.onToolStatus(message)
      },
      ...(request.activityToolMode === 'preview' ? {
        onActivityLine: (line: { kind: 'input' | 'output'; text: string }) => callbacks.onActivityLine(line),
      } : {}),
      onAnswerReady: text => callbacks.onAnswerReady(text, {
        ...(activeModel ? { provider: providerFor(activeModel), resolvedModel: activeModel } : {}),
      }),
      onDone: async (fullText, model, cliSessionId, metadata) => {
        const attachments = mergeMediaAttachmentRefs(
          resolvedAttachments.refs,
          metadata?.outputAttachments,
        )
        const linkage = {
          provider: providerFor(model),
          resolvedModel: model,
          cliSessionId,
          claudeRunId: metadata?.claudeRunId,
          codexRunId: metadata?.codexRunId,
          codexThreadId: metadata?.codexThreadId,
        } as const
        // Publish compatibility completion only after the durable terminal is
        // fsynced. Display subscribers can disappear without owning this job.
        const terminalOwned = await callbacks.onDone({
          text: fullText,
          attachments,
          outputImageStats: metadata?.outputImageStats,
          ...linkage,
        })
        if (!terminalOwned) return
        if (resolvedAttachments.ids.length > 0) {
          await getMediaStore().associate(resolvedAttachments.ids, {
            sessionId: request.sessionId,
            ...(request.globalMsgNum ? { globalMsgNum: request.globalMsgNum } : {}),
          }).catch(error => console.error('[query-jobs] attachment association failed:', error))
        }
        const { outputAttachments: _outputAttachments, ...runMetadata } = metadata ?? {}
        emitDisplay({ type: 'done', data: {
          jobId,
          clientJobId: request.clientJobId,
          generation: request.generation,
          turnId,
          messageEra: request.messageEra,
          globalMsgNum: request.globalMsgNum,
          text: fullText,
          sessionId: request.sessionId,
          model,
          cliSessionId,
          ...runMetadata,
          ...(attachments.length > 0 ? { attachments } : {}),
        } })
      },
      onError: async error => {
        const terminalOwned = await callbacks.onError(error)
        if (!terminalOwned) return
        emitDisplay({ type: 'error', data: {
          jobId,
          clientJobId: request.clientJobId,
          generation: request.generation,
          turnId,
          messageEra: request.messageEra,
          globalMsgNum: request.globalMsgNum,
          error,
        } })
      },
    },
    validModel,
    imageInputs,
    request.reference,
    request.globalMsgNum,
    {
      abortSignal: signal,
      effort: validEffort,
      clientJobId: request.clientJobId,
      generation: request.generation,
      sessionLockHeld: true,
    },
  )
}

const configuredRoot = process.env.COS_QUERY_JOB_DIR?.trim()
const queryJobRoot = configuredRoot ? resolve(configuredRoot) : dataPath('query-jobs')

export const queryJobStore = new QueryJobStore({
  root: queryJobRoot,
  bootId: randomUUID(),
})

export const queryJobCoordinator = new QueryJobCoordinator(queryJobStore, runner, {
  projectTerminal: projectPublicConversationTerminal,
  acquireSessionLock: acquireModelSessionRunLock,
})

export function initQueryJobRuntime() {
  if (!durableQueryJobsEnabled()) return Promise.resolve(queryJobCoordinator.getHealth())
  return queryJobCoordinator.init()
}

export function shutdownQueryJobRuntime(reason = 'server_shutdown') {
  return queryJobCoordinator.shutdown(reason)
}

export function getQueryJobRuntimeHealth() {
  return queryJobCoordinator.getHealth()
}
