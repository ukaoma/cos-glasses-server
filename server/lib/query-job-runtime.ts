import { carriesBoundTo } from './agent-session-binding-store.js'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { acquireModelSessionRunLock, callModelStreaming } from './model-router.js'
import { emitDisplay } from './display-bus.js'
import { resolveQueryAttachments } from './query-attachments.js'
import { getMediaStore } from './media-store.js'
import { dataPath } from './data-dir.js'
import { currentMessageEra, LEGACY_MESSAGE_ERA } from './message-era.js'
import { durableQueryJobsEnabled } from './query-job-feature.js'
import { QueryJobCoordinator, type QueryJobRunner } from './query-job-coordinator.js'
import { QueryJobStore } from './query-job-store.js'
import {
  isCodexModel,
  isCursorModel,
  isOllamaModel,
  normalizeEffortPreference,
  normalizeModelPreference,
  type CursorExecutionMode,
  type ModelPreference,
} from '../../shared/model-preference.js'
import { mergeMediaAttachmentRefs } from '../../shared/media-attachment.js'
import { attachmentHistoryPrefix, defaultAttachmentRequest } from '../../shared/media-attachment.js'
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
import { acquireMaintenanceWork } from './maintenance-lifecycle.js'

const TOOL_STATUS_MESSAGES: Record<string, string> = {
  WebSearch: 'Searching web...',
  WebFetch: 'Reading page...',
  Read: 'Analyzing photo...',
  search_meetings: 'Searching meetings...',
  search_memories: 'Searching memory...',
  read_meeting: 'Reading meeting...',
}

export class QueryJobAdmissionPreparationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'QueryJobAdmissionPreparationError'
  }
}

/** Resolve image bytes/ids before returning 202. The journal receives only
 * validated refs and ids; base64 bytes and provider-local paths are dropped by
 * the strict QueryJobRequest parser before persistence. Once a reset era
 * exists, reject pre-era clients before they stamp five-digit numbers into
 * the fresh namespace. */
export async function preparePublicDurableQueryAdmission(raw: unknown): Promise<unknown> {
  if (!raw || typeof raw !== 'object') return raw
  const input = raw as Record<string, unknown>

  // Plan 4.2: an attached turn must NEVER silently degrade into an ordinary COS
  // turn. The binding lives in the route path rather than the body, so a
  // re-admission through this generic route would otherwise carry no attachment
  // fields at all and there would be nothing here to reject — the turn would just
  // quietly run against COS's own conversation instead of the user's desktop
  // thread, and look like it worked.
  //
  // `carriesBoundTo` is the marker that makes such a request recognisable. It has
  // existed, tested, with no caller since it was written.
  //
  // Defensive today: attached turns are not journal-backed until Phase 2, so
  // nothing currently produces a request carrying this marker. It is wired now
  // because the moment Phase 2 does, the absence of this check becomes a silent
  // downgrade rather than a loud refusal.
  if (carriesBoundTo(input)) {
    throw new QueryJobAdmissionPreparationError(
      409,
      'attached_turn_on_generic_route',
      'That turn belongs to a thread on your Mac and cannot run as an ordinary COS turn.',
    )
  }

  const activeEra = currentMessageEra()
  if (activeEra !== LEGACY_MESSAGE_ERA && input.messageEra !== activeEra) {
    throw new QueryJobAdmissionPreparationError(
      409,
      'message_era_mismatch',
      'Reopen or update COS Glasses. Your cards stay; the next message is #1.',
    )
  }
  try {
    const resolved = await resolveQueryAttachments(input)
    return {
      ...input,
      messageEra: activeEra,
      attachmentIds: resolved.ids,
      attachmentRefs: resolved.refs,
    }
  } catch (error: any) {
    if (Number.isInteger(error?.status) && typeof error?.code === 'string') {
      throw new QueryJobAdmissionPreparationError(error.status, error.code, error.message)
    }
    throw error
  }
}

function providerFor(model: ModelPreference): 'claude' | 'codex' | 'cursor' | 'ollama' {
  if (isOllamaModel(model)) return 'ollama'
  if (isCursorModel(model)) return 'cursor'
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
  const attachmentPrefix = attachmentHistoryPrefix(request.attachmentRefs)
  const defaultRequest = defaultAttachmentRequest(request.attachmentRefs)
  const userContent = attachmentPrefix
    ? `${attachmentPrefix} ${request.query || defaultRequest}`
    : request.query
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
    request.messageEra,
    normalizeModelPreference(request.model),
  )
  reconcileExchangeByJobIdentity(
    request.sessionId,
    identity,
    'assistant',
    job.response ?? job.partialText,
    request.globalMsgNum,
    mergeMediaAttachmentRefs(outputAttachments, existingOutputAttachments),
    request.messageEra,
    normalizeModelPreference(request.model),
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
          cursorRunId: metadata?.cursorRunId,
          ollamaRunId: metadata?.ollamaRunId,
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
          : metadata.provider === 'cursor'
            ? { cursorRunId: metadata.runId }
            : metadata.provider === 'ollama'
              ? { ollamaRunId: metadata.runId }
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
        // Acquire before the durable terminal callback can release the main
        // query lease. Attachment association is a post-terminal write and
        // must not create a zero-count maintenance proof gap.
        const attachmentLease = resolvedAttachments.ids.length > 0
          ? acquireMaintenanceWork('query_attachment_write', { allowDuringDrain: true })
          : undefined
        const linkage = {
          provider: providerFor(model),
          resolvedModel: model,
          cliSessionId,
          claudeRunId: metadata?.claudeRunId,
          codexRunId: metadata?.codexRunId,
          codexThreadId: metadata?.codexThreadId,
          cursorRunId: metadata?.cursorRunId,
          ollamaRunId: metadata?.ollamaRunId,
        } as const
        // Publish compatibility completion only after the durable terminal is
        // fsynced. Display subscribers can disappear without owning this job.
        try {
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
              messageEra: request.messageEra,
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
        } finally {
          attachmentLease?.release()
        }
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
      // Glasses Settings default is Agent. Explicit ask stays ask; omit → agent
      // for Cursor so legacy clients aren't stuck in Ask when durable is off.
      ...(validModel && isCursorModel(validModel)
        ? {
            cursorExecutionMode: (
              request.cursorExecutionMode === 'ask' ? 'ask' : 'agent'
            ) as CursorExecutionMode,
          }
        : {}),
      clientJobId: request.clientJobId,
      generation: request.generation,
      requestAttachments: resolvedAttachments.refs,
      attachmentPromptBlock: resolvedAttachments.promptBlock,
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
  acquireMaintenanceWork: () => acquireMaintenanceWork('durable_query', { phase: 'queued' }),
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
