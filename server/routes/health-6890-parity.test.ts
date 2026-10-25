// 6.89.0: LAN first is gone (Miles, 2026-10-23 19:57). /api/health and /api/models are the 6.87.0
// shape again, checked path for path against goldens captured from the unmodified 6.87.0 base
// (601d807). The one new key is /api/health `tailscaleNudge` (lib/tailscale-nudge.ts), which
// carries no address. /api/route-proof is an ordinary unknown path behind the token again, and
// COS_LAN_FIRST is read by nothing.
import express from 'express'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { isPublicApiRequest, requireApiToken } from '../lib/api-auth.js'
import { __resetServerInstanceIdForTests, initializeServerInstanceId } from '../lib/server-instance-id.js'
import { healthRouter } from './health.js'

const TOKEN = 'golden-capture-token-0123456789abcdef0123'
const savedToken = process.env.COS_API_TOKEN
const savedSwitch = process.env.COS_LAN_FIRST
const root = new URL('../../', import.meta.url)

let server: Server | null = null
let base = ''
beforeAll(async () => {
  process.env.COS_API_TOKEN = TOKEN
  __resetServerInstanceIdForTests()
  initializeServerInstanceId(join(mkdtempSync(join(tmpdir(), 'parity-6890-')), 'server-instance-id'))
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
  if (savedSwitch === undefined) delete process.env.COS_LAN_FIRST
  else process.env.COS_LAN_FIRST = savedSwitch
})

const auth = { headers: { 'x-cos-token': TOKEN } }
const models = async () => (await fetch(`${base}/api/models`, auth)).json() as Promise<any>
const health = async () => (await fetch(`${base}/api/health`)).json() as Promise<any>
const paths = (v: any, p = ''): string[] => {
  if (Array.isArray(v)) return [`${p}[]`]
  if (v && typeof v === 'object') return Object.keys(v).flatMap(k => [`${p}.${k}`, ...paths(v[k], `${p}.${k}`)])
  return []
}
/** 6.87.0's /api/health keys with the one 6.89.0 addition in the place it is spread. */
const healthTop6890 = (): string[] => {
  const keys = [...GOLDEN_HEALTH_TOP_6870]
  keys.splice(keys.indexOf('continueReads') + 1, 0, 'tailscaleNudge')
  return keys
}

describe('6.89.0: /api/models is the 6.87.0 shape exactly', () => {
  it('top-level keys, capability keys and every path match the 6.87.0 golden', async () => {
    const body = await models()
    expect(Object.keys(body)).toEqual(GOLDEN_MODELS_TOP)
    expect(Object.keys(body.capabilities)).toEqual(GOLDEN_MODELS_CAPS)
    expect(paths(body)).toEqual(GOLDEN_MODELS_PATHS)
    expect('routes' in body).toBe(false)
  }, 20_000)

  it('COS_LAN_FIRST=1 changes nothing: the switch is read by no one', async () => {
    delete process.env.COS_LAN_FIRST
    const unset = await models()
    process.env.COS_LAN_FIRST = '1'
    const on = await models()
    for (const body of [unset, on]) {
      delete body.displayStreamTicket
      delete body.cursor?.refreshedAt
    }
    expect(JSON.stringify(on)).toBe(JSON.stringify(unset))
  }, 20_000)
})

describe('6.89.0: /api/health is 6.87.0 plus tailscaleNudge', () => {
  it('keeps every 6.87.0 key, in order, and adds only tailscaleNudge', async () => {
    const body = await health()
    expect(Object.keys(body)).toEqual(healthTop6890())
    expect(Object.keys(body.capabilities)).toEqual(GOLDEN_HEALTH_CAPS_6870)
    expect(body.capabilities.routeProof).toBeUndefined()
    expect(body.capabilities.lanRoutes).toBeUndefined()
  }, 20_000)

  it('tailscaleNudge has the documented keys and holds no address', async () => {
    const res = await fetch(`${base}/api/health`)
    const text = await res.text()
    const field = JSON.parse(text).tailscaleNudge
    expect(Object.keys(field)).toEqual(['enabled', 'available', 'lastAt', 'lastTrigger', 'lastOutcome', 'lastDataPath', 'lastRecoveredAt', 'nudgesLastHour'])
    expect(JSON.stringify(field)).not.toMatch(/\b100\.\d+\.\d+\.\d+\b/)
  }, 20_000)
})

describe('6.91.0: dictationCleanup.learnedStyle and polishOptions on both surfaces', () => {
  it('the same block on /api/health (public) and /api/models; enabled follows COS_DICTATION_LEARNED_STYLE', async () => {
    const saved = process.env.COS_DICTATION_LEARNED_STYLE
    try {
      delete process.env.COS_DICTATION_LEARNED_STYLE
      const on = (await health()).capabilities.dictationCleanup
      expect(on.learnedStyle).toEqual({ protocol: 1, maxChars: 1500, maxRules: 20, enabled: true })
      expect(on.polishOptions).toEqual({ protocol: 1 })
      expect((await models()).capabilities.dictationCleanup).toEqual(on)
      // The old keys are unchanged, and nothing new sits at the top level of capabilities.
      expect(on.customInstructions).toEqual({ protocol: 1, maxChars: 1000 })
      expect((await health()).capabilities.dictationLearnedStyle).toBeUndefined()
      process.env.COS_DICTATION_LEARNED_STYLE = '0'
      expect((await health()).capabilities.dictationCleanup.learnedStyle).toEqual({ protocol: 1, maxChars: 1500, maxRules: 20, enabled: false })
      expect((await models()).capabilities.dictationCleanup.learnedStyle.enabled).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.COS_DICTATION_LEARNED_STYLE
      else process.env.COS_DICTATION_LEARNED_STYLE = saved
    }
  }, 20_000)
})

describe('6.89.0: the route proof door is closed', () => {
  it('GET /api/route-proof is no longer a public path', () => {
    expect(isPublicApiRequest('GET', '/route-proof')).toBe(false)
  })

  it('without a token it is the standard 401; with one it is not served by health', async () => {
    const anon = await fetch(`${base}/api/route-proof?nonce=phoneNonce_0123456789-AB`)
    expect(anon.status).toBe(401)
    expect((await anon.json() as any).reason).toBe('pairing_token_rejected')
    const authed = await fetch(`${base}/api/route-proof?nonce=phoneNonce_0123456789-AB`, auth)
    expect(authed.status).toBe(404)
  }, 20_000)

  it('no LAN-first source, doc, gate or package entry remains', () => {
    for (const rel of ['server/lib/lan-first.ts', 'server/routes/route-proof.ts', 'docs/lan-first.md', 'server/scripts/lan-first-mutation-gate.mjs']) {
      expect(existsSync(new URL(rel, root)), rel).toBe(false)
    }
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { files: string[] }
    expect(pkg.files.filter(f => /lan-first|route-proof/.test(f))).toEqual([])
    const index = readFileSync(new URL('server/index.ts', root), 'utf8')
    expect(index).not.toMatch(/route-proof|RouteProof|lan-first/)
    const contract = readFileSync(new URL('managed-runtime-contract.json', root), 'utf8')
    expect(contract).not.toContain('COS_LAN_FIRST')
  })
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
  // 6.91.0: Your style and Previous polish, next to customInstructions (plan r2 contract).
  '.capabilities.dictationCleanup.learnedStyle',
  '.capabilities.dictationCleanup.learnedStyle.protocol',
  '.capabilities.dictationCleanup.learnedStyle.maxChars',
  '.capabilities.dictationCleanup.learnedStyle.maxRules',
  '.capabilities.dictationCleanup.learnedStyle.enabled',
  '.capabilities.dictationCleanup.polishOptions',
  '.capabilities.dictationCleanup.polishOptions.protocol',
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
const GOLDEN_HEALTH_TOP_6870 = [
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
const GOLDEN_HEALTH_CAPS_6870 = [
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
