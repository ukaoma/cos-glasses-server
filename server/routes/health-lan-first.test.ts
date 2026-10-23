// 6.88.0 LAN first on /api/health and /api/models (docs/lan-first.md). The addresses appear only
// on authenticated /api/models; public health carries protocol flags and nothing else; and the
// old 6.87.0 shape of both responses is unchanged apart from the new keys.
import express from 'express'
import { mkdtempSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { requireApiToken } from '../lib/api-auth.js'
import { __setInterfaceReaderForTests } from '../lib/lan-first.js'
import { __resetServerInstanceIdForTests, getServerInstanceId, initializeServerInstanceId } from '../lib/server-instance-id.js'
import { healthRouter } from './health.js'

const TOKEN = 'golden-capture-token-0123456789abcdef0123'
const LAN_IP = '192.168.1.204'
const TS_IP = '100.108.149.114'
const savedToken = process.env.COS_API_TOKEN
const savedSwitch = process.env.COS_LAN_FIRST

let server: Server | null = null
let base = ''
beforeAll(async () => {
  process.env.COS_API_TOKEN = TOKEN
  __resetServerInstanceIdForTests()
  initializeServerInstanceId(join(mkdtempSync(join(tmpdir(), 'lan-first-health-')), 'server-instance-id'))
  const app = express()
  app.use('/api', requireApiToken(TOKEN))
  app.use('/api', healthRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server!.address()
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : ''
})
afterAll(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  __resetServerInstanceIdForTests()
  if (savedToken === undefined) delete process.env.COS_API_TOKEN
  else process.env.COS_API_TOKEN = savedToken
})
afterEach(() => {
  __setInterfaceReaderForTests(null)
  if (savedSwitch === undefined) delete process.env.COS_LAN_FIRST
  else process.env.COS_LAN_FIRST = savedSwitch
})

const fakeInterfaces = () => __setInterfaceReaderForTests(() => ({
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  en0: [{ address: LAN_IP, family: 'IPv4', internal: false }],
  utun4: [{ address: TS_IP, family: 'IPv4', internal: false }],
}))
const auth = { headers: { 'x-cos-token': TOKEN } }
const models = async () => (await fetch(`${base}/api/models`, auth)).json() as Promise<any>
const health = async () => (await fetch(`${base}/api/health`)).json() as Promise<any>
const paths = (v: any, p = ''): string[] => {
  if (Array.isArray(v)) return [`${p}[]`]
  if (v && typeof v === 'object') return Object.keys(v).flatMap(k => [`${p}.${k}`, ...paths(v[k], `${p}.${k}`)])
  return []
}
const NEW_MODELS_PATH = /^\.(routes|capabilities\.routeProof|capabilities\.lanRoutes)(\.|\[|$)/
const withoutNew = (body: any) => {
  const copy = JSON.parse(JSON.stringify(body))
  delete copy.routes
  delete copy.capabilities?.routeProof
  delete copy.capabilities?.lanRoutes
  return copy
}

describe('LAN first on /api/models (authenticated)', () => {
  it('publishes routes with the documented shape', async () => {
    fakeInterfaces()
    const body = await models()
    expect(body.routes).toEqual({
      v: 1,
      serverInstanceId: getServerInstanceId(),
      learnedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      lan: [{ ip: LAN_IP, port: 3141, scheme: 'http' }],
      tailscale: [{ ip: TS_IP, port: 3141, scheme: 'http' }],
    })
    expect(body.routes.serverInstanceId).toBe(body.serverInstanceId)
    expect(body.capabilities.routeProof).toEqual({ protocol: 1 })
    expect(body.capabilities.lanRoutes).toEqual({ protocol: 1 })
  }, 20_000)

  it('is behind the token: without it the answer is the standard 401 and holds no address', async () => {
    fakeInterfaces()
    for (const init of [{}, { headers: { 'x-cos-token': 'not-the-token' } }]) {
      const res = await fetch(`${base}/api/models`, init)
      expect(res.status).toBe(401)
      const text = await res.text()
      expect(text).not.toContain(LAN_IP)
      expect(text).not.toContain(TS_IP)
      expect(JSON.parse(text).reason).toBe('pairing_token_rejected')
    }
  }, 20_000)

  it('a failed interface read leaves routes out and the rest of the response intact', async () => {
    __setInterfaceReaderForTests(() => { throw new Error('uv_interface_addresses failed') })
    const res = await fetch(`${base}/api/models`, auth)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect('routes' in body).toBe(false)
    expect(Object.keys(withoutNew(body))).toEqual(GOLDEN_MODELS_TOP)
    expect(body.capabilities.lanRoutes).toEqual({ protocol: 1 })
  }, 20_000)

  it('keeps every 6.87.0 field: the old shape is the new shape minus the new keys, path for path', async () => {
    fakeInterfaces()
    const body = await models()
    expect(Object.keys(body).filter(k => k !== 'routes')).toEqual(GOLDEN_MODELS_TOP)
    expect(Object.keys(body.capabilities).filter(k => k !== 'routeProof' && k !== 'lanRoutes')).toEqual(GOLDEN_MODELS_CAPS)
    expect(paths(body).filter(p => !NEW_MODELS_PATH.test(p))).toEqual(GOLDEN_MODELS_PATHS)
  }, 20_000)

  it('with COS_LAN_FIRST=0 the response is the 6.87.0 shape exactly, and byte-equal to the on response minus the new keys', async () => {
    fakeInterfaces()
    process.env.COS_LAN_FIRST = '0'
    const off = await models()
    delete process.env.COS_LAN_FIRST
    const on = await models()
    expect(Object.keys(off)).toEqual(GOLDEN_MODELS_TOP)
    expect(Object.keys(off.capabilities)).toEqual(GOLDEN_MODELS_CAPS)
    expect(paths(off)).toEqual(GOLDEN_MODELS_PATHS)
    // Two values move between calls on their own: the ticket's second-resolution expiry, and the
    // Cursor catalog's refresh stamp (an unavailable catalog re-probes per call). Compared by shape.
    for (const body of [off, on]) {
      expect(body.displayStreamTicket).toMatch(/^\d+\.[0-9a-f]{64}$/)
      delete body.displayStreamTicket
      expect(typeof body.cursor.refreshedAt).toBe('string')
      delete body.cursor.refreshedAt
    }
    expect(JSON.stringify(withoutNew(on))).toBe(JSON.stringify(off))
  }, 20_000)
})

describe('LAN first on public /api/health', () => {
  it('carries the protocol flags and no address at all', async () => {
    fakeInterfaces()
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    const text = await res.text()
    const body = JSON.parse(text)
    expect(body.capabilities.routeProof).toEqual({ protocol: 1 })
    expect(body.capabilities.lanRoutes).toEqual({ protocol: 1 })
    expect('routes' in body).toBe(false)
    expect(text).not.toContain(LAN_IP)
    expect(text).not.toContain(TS_IP)
  }, 20_000)

  it('keeps every 6.87.0 key, in order', async () => {
    const body = await health()
    expect(Object.keys(body)).toEqual(GOLDEN_HEALTH_TOP)
    expect(Object.keys(body.capabilities).filter(k => k !== 'routeProof' && k !== 'lanRoutes')).toEqual(GOLDEN_HEALTH_CAPS)
  }, 20_000)

  it('drops both flags with COS_LAN_FIRST=0', async () => {
    process.env.COS_LAN_FIRST = '0'
    const body = await health()
    expect(Object.keys(body.capabilities)).toEqual(GOLDEN_HEALTH_CAPS)
  }, 20_000)

  it('does not advertise routeProof for a token too short to expose, and the models answer agrees', async () => {
    process.env.COS_API_TOKEN = 'short-token-0123456789'
    try {
      const body = await health()
      expect(body.capabilities.routeProof).toBeUndefined()
      expect(body.capabilities.lanRoutes).toEqual({ protocol: 1 })
      const m = await models()
      expect(m.capabilities.routeProof).toBeUndefined()
      expect(m.capabilities.lanRoutes).toEqual({ protocol: 1 })
    } finally {
      process.env.COS_API_TOKEN = TOKEN
    }
  }, 20_000)
})

// Captured from the unmodified 6.87.0 base (601d807) with the same harness: healthRouter mounted
// alone, COS_API_TOKEN set, the instance id minted. Key order included. Arrays collapse to `[]`.
const GOLDEN_MODELS_TOP = [
  'source',
  'refreshedAt',
  'autoUpdates',
  'selectionPolicy',
  'options',
  'threadAttachSupported',
  'threadAttachEnabled',
  'threadAttachProviders',
  'threadForkSupported',
  'threadForkProviders',
  'continueLive',
  'codexLiveQueue',
  'providers',
  'cursor',
  'cursorReady',
  'ollama',
  'ollamaReady',
  'serverInstanceId',
  'displayStreamTicket',
  'capabilities',
]
const GOLDEN_MODELS_CAPS = [
  'meetingAsk',
  'dictationCleanup',
  'durableQueryJobs',
  'sessionQuestions',
  'runningTurnMeta',
  'transcription',
  'meetingLifecycle',
  'cliDebug',
  'recovery',
  'liveCues',
  'liveMeeting',
  'richMedia',
  'localFirstMeetings',
  'tasks',
]
const GOLDEN_MODELS_PATHS = [
  '.source',
  '.refreshedAt',
  '.autoUpdates',
  '.selectionPolicy',
  '.options',
  '.options[]',
  '.threadAttachSupported',
  '.threadAttachEnabled',
  '.threadAttachProviders',
  '.threadAttachProviders[]',
  '.threadForkSupported',
  '.threadForkProviders',
  '.threadForkProviders[]',
  '.continueLive',
  '.continueLive.enabled',
  '.continueLive.attempts',
  '.continueLive.delivered',
  '.continueLive.fallbacks',
  '.continueLive.lastReason',
  '.continueLive.lastAt',
  '.codexLiveQueue',
  '.codexLiveQueue.enabled',
  '.codexLiveQueue.attempts',
  '.codexLiveQueue.delivered',
  '.codexLiveQueue.fallbacks',
  '.codexLiveQueue.lastReason',
  '.codexLiveQueue.lastAt',
  '.providers',
  '.providers.claude',
  '.providers.claude.act',
  '.providers.claude.act.continueIdle',
  '.providers.claude.act.continueIdle.supported',
  '.providers.claude.act.continueIdle.mode',
  '.providers.claude.act.continueBusy',
  '.providers.claude.act.continueBusy.supported',
  '.providers.claude.act.continueBusy.reason',
  '.providers.claude.act.fork',
  '.providers.claude.act.fork.supported',
  '.providers.claude.act.cancelDesk',
  '.providers.claude.act.cancelDesk.supported',
  '.providers.claude.act.cancelDesk.reason',
  '.providers.claude.act.approvals',
  '.providers.claude.act.approvals.supported',
  '.providers.claude.act.approvals.reason',
  '.providers.claude.act.nativeQueue',
  '.providers.claude.act.nativeQueue.supported',
  '.providers.claude.act.nativeQueue.reason',
  '.providers.claude.act.keepModel',
  '.providers.claude.act.keepModel.supported',
  '.providers.claude.act.permissions',
  '.providers.claude.act.permissions.supported',
  '.providers.claude.act.permissions.mode',
  '.providers.claude.observe',
  '.providers.claude.observe.hooks',
  '.providers.claude.observe.liveState',
  '.providers.claude.observe.children',
  '.providers.claude.observe.compaction',
  '.providers.claude.observe.reasoning',
  '.providers.codex',
  '.providers.codex.act',
  '.providers.codex.act.continueIdle',
  '.providers.codex.act.continueIdle.supported',
  '.providers.codex.act.continueIdle.mode',
  '.providers.codex.act.continueBusy',
  '.providers.codex.act.continueBusy.supported',
  '.providers.codex.act.continueBusy.mode',
  '.providers.codex.act.fork',
  '.providers.codex.act.fork.supported',
  '.providers.codex.act.cancelDesk',
  '.providers.codex.act.cancelDesk.supported',
  '.providers.codex.act.cancelDesk.reason',
  '.providers.codex.act.approvals',
  '.providers.codex.act.approvals.supported',
  '.providers.codex.act.approvals.reason',
  '.providers.codex.act.nativeQueue',
  '.providers.codex.act.nativeQueue.supported',
  '.providers.codex.act.keepModel',
  '.providers.codex.act.keepModel.supported',
  '.providers.codex.act.permissions',
  '.providers.codex.act.permissions.supported',
  '.providers.codex.act.permissions.mode',
  '.providers.codex.observe',
  '.providers.codex.observe.hooks',
  '.providers.codex.observe.liveState',
  '.providers.codex.observe.children',
  '.providers.codex.observe.compaction',
  '.providers.codex.observe.reasoning',
  '.providers.cursor',
  '.providers.cursor.act',
  '.providers.cursor.act.continueIdle',
  '.providers.cursor.act.continueIdle.supported',
  '.providers.cursor.act.continueIdle.mode',
  '.providers.cursor.act.continueBusy',
  '.providers.cursor.act.continueBusy.supported',
  '.providers.cursor.act.continueBusy.reason',
  '.providers.cursor.act.fork',
  '.providers.cursor.act.fork.supported',
  '.providers.cursor.act.fork.mode',
  '.providers.cursor.act.cancelDesk',
  '.providers.cursor.act.cancelDesk.supported',
  '.providers.cursor.act.cancelDesk.reason',
  '.providers.cursor.act.approvals',
  '.providers.cursor.act.approvals.supported',
  '.providers.cursor.act.approvals.reason',
  '.providers.cursor.act.nativeQueue',
  '.providers.cursor.act.nativeQueue.supported',
  '.providers.cursor.act.nativeQueue.reason',
  '.providers.cursor.act.keepModel',
  '.providers.cursor.act.keepModel.supported',
  '.providers.cursor.act.permissions',
  '.providers.cursor.act.permissions.supported',
  '.providers.cursor.act.permissions.mode',
  '.providers.cursor.observe',
  '.providers.cursor.observe.hooks',
  '.providers.cursor.observe.liveState',
  '.providers.cursor.observe.children',
  '.providers.cursor.observe.compaction',
  '.providers.cursor.observe.reasoning',
  '.cursor',
  '.cursor.source',
  '.cursor.refreshedAt',
  '.cursor.options',
  '.cursor.options[]',
  '.cursor.agentBinary',
  '.cursor.refreshError',
  '.cursorReady',
  '.ollama',
  '.ollama.origin',
  '.ollama.model',
  '.ollama.models',
  '.ollama.models[]',
  '.ollama.refreshedAt',
  '.ollamaReady',
  '.serverInstanceId',
  '.displayStreamTicket',
  '.capabilities',
  '.capabilities.meetingAsk',
  '.capabilities.meetingAsk.protocolVersion',
  '.capabilities.meetingAsk.durableHistory',
  '.capabilities.meetingAsk.attachmentContext',
  '.capabilities.meetingAsk.webRetrieval',
  '.capabilities.meetingAsk.phoneFiles',
  '.capabilities.meetingAsk.cosSearchMode',
  '.capabilities.meetingAsk.meetingContext',
  '.capabilities.meetingAsk.followUpReview',
  '.capabilities.meetingAsk.publicTopics',
  '.capabilities.meetingAsk.factCheck',
  '.capabilities.meetingAsk.factCheckScope',
  '.capabilities.dictationCleanup',
  '.capabilities.dictationCleanup.models',
  '.capabilities.dictationCleanup.models[]',
  '.capabilities.dictationCleanup.customInstructions',
  '.capabilities.dictationCleanup.customInstructions.protocol',
  '.capabilities.dictationCleanup.customInstructions.maxChars',
  '.capabilities.durableQueryJobs',
  '.capabilities.durableQueryJobs.enabled',
  '.capabilities.durableQueryJobs.protocolVersion',
  '.capabilities.durableQueryJobs.trail',
  '.capabilities.sessionQuestions',
  '.capabilities.sessionQuestions.enabled',
  '.capabilities.sessionQuestions.mode',
  '.capabilities.sessionQuestions.protocolVersion',
  '.capabilities.sessionQuestions.pollIntervalMs',
  '.capabilities.sessionQuestions.liveWindowMs',
  '.capabilities.sessionQuestions.awayHoldMs',
  '.capabilities.sessionQuestions.awayRecentClientMs',
  '.capabilities.runningTurnMeta',
  '.capabilities.runningTurnMeta.protocolVersion',
  '.capabilities.transcription',
  '.capabilities.transcription.mode',
  '.capabilities.transcription.localRequired',
  '.capabilities.transcription.openaiFallbackConfigured',
  '.capabilities.transcription.openaiFallbackReady',
  '.capabilities.transcription.live',
  '.capabilities.transcription.live.requested',
  '.capabilities.transcription.live.effectiveModel',
  '.capabilities.transcription.live.ready',
  '.capabilities.transcription.live.backend',
  '.capabilities.transcription.live.degraded',
  '.capabilities.transcription.live.reason',
  '.capabilities.transcription.live.previewDegraded',
  '.capabilities.transcription.live.commitDegraded',
  '.capabilities.transcription.live.commitReason',
  '.capabilities.transcription.live.committedModel',
  '.capabilities.transcription.live.requestedCommitModel',
  '.capabilities.transcription.live.requestedTier',
  '.capabilities.transcription.live.effectiveTier',
  '.capabilities.transcription.live.promptPolicy',
  '.capabilities.transcription.hq',
  '.capabilities.transcription.hq.hqAvailable',
  '.capabilities.transcription.hq.model',
  '.capabilities.transcription.hq.backend',
  '.capabilities.transcription.hq.reason',
  '.capabilities.transcription.profile',
  '.capabilities.transcription.profile.configured',
  '.capabilities.transcription.profile.ownerConfigured',
  '.capabilities.transcription.profile.vocabularyTerms',
  '.capabilities.transcription.profile.ignoredPlaceholderTerms',
  '.capabilities.transcription.profile.ignoredPlaceholderCorrection',
  '.capabilities.meetingLifecycle',
  '.capabilities.meetingLifecycle.earlySyncClaim',
  '.capabilities.meetingLifecycle.earlySyncClaim.requested',
  '.capabilities.meetingLifecycle.earlySyncClaim.enabled',
  '.capabilities.meetingLifecycle.earlySyncClaim.available',
  '.capabilities.meetingLifecycle.earlySyncClaim.reason',
  '.capabilities.meetingLifecycle.earlySyncClaim.inFlight',
  '.capabilities.meetingLifecycle.earlySyncClaim.pendingCount',
  '.capabilities.meetingLifecycle.earlySyncClaim.lastOutcome',
  '.capabilities.meetingLifecycle.earlySyncClaim.lastAt',
  '.capabilities.meetingLifecycle.earlySyncClaim.lastError',
  '.capabilities.meetingLifecycle.progressiveHq',
  '.capabilities.meetingLifecycle.progressiveHq.requested',
  '.capabilities.meetingLifecycle.progressiveHq.enabled',
  '.capabilities.meetingLifecycle.progressiveHq.tier',
  '.capabilities.meetingLifecycle.progressiveHq.mode',
  '.capabilities.meetingLifecycle.progressiveHq.threads',
  '.capabilities.meetingLifecycle.progressiveHq.reason',
  '.capabilities.meetingLifecycle.progressiveHq.activeSessionId',
  '.capabilities.meetingLifecycle.progressiveHq.sessions',
  '.capabilities.meetingLifecycle.progressiveHq.sessions[]',
  '.capabilities.meetingLifecycle.finalization',
  '.capabilities.meetingLifecycle.finalization.pending',
  '.capabilities.meetingLifecycle.finalization.failed',
  '.capabilities.meetingLifecycle.finalization.oldestUpdatedAt',
  '.capabilities.meetingLifecycle.finalization.lastError',
  '.capabilities.meetingLifecycle.finalization.malformed',
  '.capabilities.cliDebug',
  '.capabilities.cliDebug.schemaVersion',
  '.capabilities.cliDebug.providers',
  '.capabilities.cliDebug.providers.claude',
  '.capabilities.cliDebug.providers.codex',
  '.capabilities.cliDebug.providers.cursor',
  '.capabilities.cliDebug.metadataOnly',
  '.capabilities.recovery',
  '.capabilities.recovery.status',
  '.capabilities.recovery.restartWhisper',
  '.capabilities.recovery.restartServer',
  '.capabilities.recovery.maintenanceDrain',
  '.capabilities.recovery.lifecycleProof',
  '.capabilities.recovery.managed',
  '.capabilities.recovery.contractVersion',
  '.capabilities.liveCues',
  '.capabilities.liveCues.available',
  '.capabilities.liveCues.reason',
  '.capabilities.liveCues.kinds',
  '.capabilities.liveCues.kinds[]',
  '.capabilities.liveMeeting',
  '.capabilities.liveMeeting.protocol',
  '.capabilities.liveMeeting.macLiveCues',
  '.capabilities.liveMeeting.provisional',
  '.capabilities.liveMeeting.provisional.route',
  '.capabilities.liveMeeting.provisional.maxChars',
  '.capabilities.liveMeeting.provisional.ttlMs',
  '.capabilities.liveMeeting.chunkLevels',
  '.capabilities.richMedia',
  '.capabilities.richMedia.video',
  '.capabilities.richMedia.maxPromptVisuals',
  '.capabilities.richMedia.videoUploadV2',
  '.capabilities.richMedia.videoUploadV2.available',
  '.capabilities.richMedia.videoUploadV2.protocol',
  '.capabilities.richMedia.videoUploadV2.chunkBytes',
  '.capabilities.richMedia.videoUploadV2.maxOriginalBytes',
  '.capabilities.richMedia.videoUploadV2.maxDurationMs',
  '.capabilities.richMedia.videoUploadV2.acceptedMimes',
  '.capabilities.richMedia.videoUploadV2.acceptedMimes[]',
  '.capabilities.richMedia.videoUploadV2.phoneFramesAvailable',
  '.capabilities.richMedia.videoUploadV2.phoneFramesMin',
  '.capabilities.richMedia.videoUploadV2.phoneFramesMax',
  '.capabilities.richMedia.videoUploadV2.serverFramesMin',
  '.capabilities.richMedia.videoUploadV2.serverFramesMax',
  '.capabilities.richMedia.videoUploadV2.maxFrameBytes',
  '.capabilities.richMedia.videoUploadV2.maxPackBytes',
  '.capabilities.richMedia.videoUploadV2.maxSourcePixels',
  '.capabilities.richMedia.videoUploadV2.reason',
  '.capabilities.richMedia.videoUploadV2.promptAdmission',
  '.capabilities.richMedia.videoUploadV2.promptAdmission.maxVideos',
  '.capabilities.richMedia.videoUploadV2.promptAdmission.maxOtherVisualsWithVideo',
  '.capabilities.localFirstMeetings',
  '.capabilities.localFirstMeetings.protocolVersion',
  '.capabilities.localFirstMeetings.serverInstanceId',
  '.capabilities.localFirstMeetings.idempotentSave',
  '.capabilities.localFirstMeetings.sessionStatus',
  '.capabilities.localFirstMeetings.pinnedServerIdentity',
  '.capabilities.localFirstMeetings.asrCompletionStatus',
  '.capabilities.localFirstMeetings.retentionMs',
  '.capabilities.tasks',
  '.capabilities.tasks.gate',
]
const GOLDEN_HEALTH_TOP = [
  'status',
  'mode',
  'server',
  'python',
  'claude',
  'codex',
  'cursor',
  'ollama',
  'uptime_seconds',
  'request_count',
  'silero_vad',
  'speaker_id',
  'cli_session_available',
  'server_version',
  'threadAttachSupported',
  'threadAttachEnabled',
  'threadAttachProviders',
  'threadForkSupported',
  'threadForkProviders',
  'sessionHooks',
  'permissionBroker',
  'continueLive',
  'codexLiveQueue',
  'continueReads',
  'providers',
  'server_instance_id',
  'boot_id',
  'generation_id',
  'mediaLimits',
  'features',
  'voice',
  'readiness',
  'whisper_health',
  'openai_whisper_budget',
  'meeting_summary',
  'lens_gist',
  'tts_local',
  'codex_models',
  'cursor_models',
  'ollama_models',
  'meeting_sync',
  'meeting_library',
  'unsaved_captures',
  'stranded_captures',
  'chunk_embeddings',
  'speaker_corrections',
  'review_audio',
  'capabilities',
  'durable_query_jobs',
  'messages_trail',
  'crash_loop_parking',
]
const GOLDEN_HEALTH_CAPS = [
  'meetingAsk',
  'dictationCleanup',
  'pairing',
  'displayStream',
  'transcription',
  'recovery',
  'maintenance',
  'cliDebug',
  'liveCues',
  'liveMeeting',
  'transcriptCleanup',
  'richMedia',
  'meetingLifecycle',
  'localFirstMeetings',
  'morningBrief',
  'tasks',
]
