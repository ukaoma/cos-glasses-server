import { carriesBoundTo } from './agent-session-binding-store.js'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { acquireModelSessionRunLock, callModelStreaming } from './model-router.js'
import { emitDisplay } from './display-bus.js'
import { resolveQueryAttachments } from './query-attachments.js'
import { getMediaStore } from './media-store.js'
import { dataPath } from './data-dir.js'
import { currentMessageEra, LEGACY_MESSAGE_ERA } from './message-era.js'
import { durableQueryJobsEnabled, messagesSteerEnabled, messagesTrailEnabled } from './query-job-feature.js'
import { claudeSupportsSteer } from './claude-cli-support.js'
import { steerProviderFor } from './claude-steer.js'
import { QueryJobCoordinator, type QueryJobRunner } from './query-job-coordinator.js'
import { QueryJobStore, createQueryJobJournalStorage } from './query-job-store.js'
import {
  isCodexModel,
  isCursorModel,
  isOllamaModel,
  normalizeEffortPreference,
  type CursorExecutionMode,
  type ModelPreference,
} from '../../shared/model-preference.js'
import { mergeMediaAttachmentRefs } from '../../shared/media-attachment.js'
import { attachmentHistoryPrefix, defaultAttachmentRequest } from '../../shared/media-attachment.js'
import {
  findExchangesByJobIdentity,
  flushConversationToDisk,
  getSessionBinding,
  getSessionModel,
  reconcileExchangeByJobIdentity,
  removeExchangesByJobIdentity,
  type KeyProfileBinding,
  type SessionModelBinding,
} from './conversation.js'
import { parsePreference, profilePreference } from '../../shared/key-preference.js'
import { linkageProviderForEngine, profileSteerProvider, type KeyProfileTurn } from './key-profile-routing.js'
import {
  isTerminalQueryJobStatus,
  type QueryJobProviderLinkage,
  type QueryJobRequest,
  type QueryJobSnapshot,
} from './query-job-types.js'
import { acquireMaintenanceWork } from './maintenance-lifecycle.js'
import type { JobTrailDraft } from './job-trail.js'
import { registerMessageReservationSource } from './message-reservations.js'
import { bootResumeGate } from './boot-resume.js'
import { keyAnswerCompletionFields, keyAnswerDoneFields } from './key-answer-fields.js'

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
    const { dispatch: _strippedDispatch, origin: rawOrigin, ...rest } = input
    const origin = (rawOrigin && typeof rawOrigin === 'object' && (rawOrigin as { kind?: string }).kind === 'task')
      ? undefined
      : rawOrigin
    if (_strippedDispatch !== undefined || origin !== rawOrigin) queryJobStore.noteOriginStripped()
    return {
      ...rest,
      ...(origin !== undefined ? { origin } : {}),
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

/**
 * Plan 5.2 Accept by syntax for the terminal projection: a model slot exactly as
 * normalizeModelPreference gives it, or `profile:<id>`. Same rule as conversation's
 * normalizeSessionBinding, computed here so the projection needs nothing new from the store.
 */
function requestBinding(model: unknown): SessionModelBinding | undefined {
  const parsed = parsePreference(model)
  if (!parsed) return undefined
  return parsed.kind === 'model' ? parsed.value : profilePreference(parsed.id) as KeyProfileBinding
}

/** Linkage provider for a keyed turn: the profile's engine. Direct (Lane C) carries none. */
function keyProfileLinkageProvider(turn: KeyProfileTurn): { provider?: 'claude' | 'codex' } {
  const provider = linkageProviderForEngine(turn.profile.engine)
  return provider ? { provider } : {}
}

/**
 * The steer gate's provider for a job (P6 owns this; P3 consumes it). With no profile anywhere
 * this is exactly `providerOfModel(resolveRunModel(...))`, as in 6.78.0.
 */
export function steerProviderForJob(request: Pick<QueryJobRequest, 'model' | 'sessionId'>): ReturnType<typeof profileSteerProvider> {
  const verdict = steerProviderFor(
    request.model,
    getSessionModel(request.sessionId),
    process.env.COS_G2_DEFAULT_MODEL,
    () => getSessionBinding(request.sessionId),
  )
  if (verdict.kind === 'profile_session') return profileSteerProvider(verdict.profileId)
  return verdict.provider
}

function providerFor(model: ModelPreference): 'claude' | 'codex' | 'cursor' | 'ollama' {
  if (isOllamaModel(model)) return 'ollama'
  if (isCursorModel(model)) return 'cursor'
  return isCodexModel(model) ? 'codex' : 'claude'
}

/** The origin label as it travels on the display bus and the message views:
 * FLATTENED (`origin: 'routine', originId: 'morning-brief'`) so every client
 * parses one shape, and identical on `start`, `done` and `error`. Spread LAST
 * into each event so no provider metadata key can overwrite it. */
function originStamp(request: QueryJobRequest): { origin?: NonNullable<QueryJobRequest['origin']>['kind']; originId?: string } {
  return request.origin ? { origin: request.origin.kind, originId: request.origin.id } : {}
}

/** Project the authoritative terminal journal into the derived conversation
 * cache. Journaled request/response text always wins over bridge-written
 * partial rows; validated media refs may be merged because output media can
 * finish immediately before a crash. Exact provenance collapses duplicates. */
export async function projectPublicConversationTerminal(
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
    requestBinding(request.model),
    request.origin,
  )
  reconcileExchangeByJobIdentity(
    request.sessionId,
    identity,
    'assistant',
    job.response ?? job.partialText,
    request.globalMsgNum,
    mergeMediaAttachmentRefs(outputAttachments, existingOutputAttachments),
    request.messageEra,
    requestBinding(request.model),
    request.origin,
  )
  flushConversationToDisk()
}

/**
 * 6.62.0 (plan 3.9, W11): a provider's early "this is my session" into the job's linkage.
 * A Claude announcement carries no provider (its bridge is unchanged) and reads as Claude.
 */
export function nativeSessionLinkage(linkage: { cliSessionId: string; provider?: 'claude' | 'codex' | 'cursor' }): QueryJobProviderLinkage {
  const provider = linkage.provider ?? 'claude'
  return provider === 'codex'
    ? { provider, codexThreadId: linkage.cliSessionId }
    : { provider, cliSessionId: linkage.cliSessionId }
}

const runner: QueryJobRunner = async ({ jobId, turnId, request, signal, callbacks, steer }) => {
  // Resolve ids again at execution time. This closes the admission/execution
  // TOCTOU window without ever putting paths or bytes in the journal.
  const resolvedAttachments = await resolveQueryAttachments({
    attachmentIds: request.attachmentIds,
    clientQueueItemId: request.clientQueueItemId,
    sessionId: request.sessionId,
  })
  const imageInputs = resolvedAttachments.inputs.length > 0 ? resolvedAttachments.inputs : undefined
  // Key lanes K1 (plan 5.2): Accept. A `profile:<id>` goes to model-router, which runs it on the
  // profile's engine or refuses it; the closed slot keeps every family guard below unchanged.
  const requestedBinding = parsePreference(request.model)
  const validModel = requestedBinding?.kind === 'model' ? requestedBinding.value : undefined
  const validEffort = normalizeEffortPreference(request.effort)
  let activeModel = validModel
  // Set only by model-router's onKeyProfileTurn, so a subscription turn never sees it.
  let keyTurn: KeyProfileTurn | undefined
  const linkageFor = (model: ModelPreference) => keyTurn
    ? { ...keyProfileLinkageProvider(keyTurn), resolvedModel: keyTurn.binding }
    : { provider: providerFor(model), resolvedModel: model }

  await callModelStreaming(
    request.query,
    request.sessionId,
    {
      ...(requestedBinding?.kind === 'model' ? {} : {
        onKeyProfileTurn: (turn: KeyProfileTurn) => { keyTurn = turn },
      }),
      onStart: async (model, sessionId, cliSessionId, metadata) => {
        activeModel = model
        const linkage = {
          ...linkageFor(model),
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
          model: keyTurn ? keyTurn.binding : model,
          sessionId,
          cliSessionId,
          ...metadata,
          ...originStamp(request),
        } })
      },
      onProviderProcess: metadata => callbacks.onProviderProcess({
        provider: metadata.provider,
        ...(keyTurn ? { resolvedModel: keyTurn.binding } : activeModel ? { resolvedModel: activeModel } : {}),
        ...(metadata.provider === 'claude'
          ? { claudeRunId: metadata.runId }
          : metadata.provider === 'cursor'
            ? { cursorRunId: metadata.runId }
            : metadata.provider === 'ollama'
              ? { ollamaRunId: metadata.runId }
              : { codexRunId: metadata.runId }),
      }),
      // 6.58.2: the provider's own session id, as soon as it names it (Claude: first stream event).
      // 6.62.0 (plan 3.9, W11): provider-aware, so a Codex or Cursor job links to its native
      // session as early as a Claude one. Codex names it as `codexThreadId`, the field its
      // completion has always used. No naming for Codex or Cursor this release (uncanaried).
      onNativeSession: linkage => { void callbacks.onLinkage?.(nativeSessionLinkage(linkage)) },
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
      // 6.52.0, the Messages trail. Journaled only (the coordinator applies the user's
      // tool-activity mode and the store redacts); it NEVER goes on the display bus, which
      // any paired display may read. Absent entirely with COS_MESSAGES_TRAIL=0, so the
      // bridges attach no second stdout reader at all.
      ...(messagesTrailEnabled() ? {
        onTrail: (draft: JobTrailDraft) => callbacks.onTrail(draft),
      } : {}),
      onAnswerReady: text => callbacks.onAnswerReady(text, {
        ...(keyTurn ? { ...keyProfileLinkageProvider(keyTurn), resolvedModel: keyTurn.binding }
          : activeModel ? { provider: providerFor(activeModel), resolvedModel: activeModel } : {}),
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
          ...linkageFor(model),
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
            ...keyAnswerCompletionFields(metadata),
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
            model: keyTurn ? keyTurn.binding : model,
            cliSessionId,
            ...runMetadata,
            ...keyAnswerDoneFields(runMetadata),
            ...(attachments.length > 0 ? { attachments } : {}),
            ...originStamp(request),
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
          ...originStamp(request),
          error,
        } })
      },
    },
    requestedBinding?.kind === 'profile' ? requestBinding(request.model) : validModel,
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
      ...(request.dispatch ? { dispatch: request.dispatch } : {}),
      ...(request.sessionName ? { sessionName: request.sessionName } : {}),
      // 6.78.0: only on a run the coordinator decided is steerable.
      ...(steer ? { steer } : {}),
    },
  )
}

const configuredRoot = process.env.COS_QUERY_JOB_DIR?.trim()
const queryJobRoot = configuredRoot ? resolve(configuredRoot) : dataPath('query-jobs')

export const queryJobStore = new QueryJobStore({
  root: queryJobRoot,
  bootId: randomUUID(),
  // 6.78.0 (MVP-D release 1): reads delta-only chunk rows; writes them only with
  // COS_QUERY_JOB_DELTA_JOURNAL=1 (default off: every append is the 6.77.0 line).
  storage: createQueryJobJournalStorage(),
  // 6.61.3: only when the coordinator will run them. With COS_DURABLE_QUERY_JOBS=0 no
  // coordinator starts, so prior-boot never-started jobs are interrupted as before.
  requeueNeverStartedOnBoot: durableQueryJobsEnabled(),
})

export const queryJobCoordinator = new QueryJobCoordinator(queryJobStore, runner, {
  projectTerminal: projectPublicConversationTerminal,
  acquireSessionLock: acquireModelSessionRunLock,
  acquireMaintenanceWork: () => acquireMaintenanceWork('durable_query', { phase: 'queued' }),
  // 6.78.0: the boot requeue counts crashed boots per lineage and parks one past the limit.
  bootResumeGate,
  // 6.78.0 Messages steer (COS_MESSAGES_STEER, default off). The provider is resolved as
  // model-router resolves it, so a run is steerable only when it will run on Claude.
  // Key lanes K1 (plan 5.2): claude-steer stays closed and names a profile-bound job
  // `profile_session`; the profile's engine then decides (only Lane B Claude steers).
  steer: {
    enabled: () => messagesSteerEnabled(),
    provider: request => steerProviderForJob(request),
    cliSupported: () => claudeSupportsSteer(),
  },
})

// A job's number is a live reservation from admission until its terminal
// projection; the counter must see it or the phone mints it again.
registerMessageReservationSource(() => queryJobCoordinator.liveMessageReservations().map(item => ({
  globalMsgNum: item.globalMsgNum,
  ...(item.messageEra ? { messageEra: item.messageEra } : {}),
  owner: `job:${item.jobId}`,
})))

export function initQueryJobRuntime() {
  if (!durableQueryJobsEnabled()) return Promise.resolve(queryJobCoordinator.getHealth())
  // 6.78.0: warm the steer probe so /api/models can advertise steer on its first answers.
  if (messagesSteerEnabled()) void claudeSupportsSteer()
  return queryJobCoordinator.init()
}

export function shutdownQueryJobRuntime(reason = 'server_shutdown') {
  return queryJobCoordinator.shutdown(reason)
}

export function getQueryJobRuntimeHealth() {
  return queryJobCoordinator.getHealth()
}
