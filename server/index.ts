// Load env and claim the one server slot before any mutable module initializes.
import './bootstrap.js'

import express from 'express'
import cors from 'cors'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { networkInterfaces, homedir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { healthRouter } from './routes/health.js'
import { diagRouter } from './routes/diag.js'
import { queryRouter } from './routes/query.js'
import { providerProofRouter } from './routes/provider-proof.js'
import { transcribeRouter } from './routes/transcribe.js'
import { sessionIndexRouter } from './routes/session-index.js'
import { agentSessionsRouter } from './routes/agent-sessions.js'
import { claudeSessionsRouter } from './routes/claude-sessions.js'
import { createAgentSessionBindingsRouter } from './routes/agent-session-bindings.js'
import { AgentSessionBindingRegistry } from './lib/agent-session-binding-registry.js'
import { cosSpawnedPids } from './lib/agent-session-ownership-store.js'
import { realOccupancyDirs, realOccupancyProbes } from './lib/occupancy-probes.js'
import { realAttachedWorkspaceDeps, resolveAttachedWorkspace } from './lib/attached-workspace.js'
import { deliverAttachedTurn, realAttachedTurnDeps } from './lib/attached-provider-adapter.js'
import { forkThread, realForkDeps } from './lib/fork-thread.js'
import { nativeHead, realNativeHeadDeps } from './lib/native-head.js'
import { threadOccupancy } from './lib/thread-occupancy.js'
import { displayRouter } from './routes/display.js'
import { transcribeStreamRouter } from './routes/transcribe-stream.js'
import { meetingRouter, resumeMeetingFinalizationJobs } from './routes/meeting.js'
import { meetingsRouter } from './routes/meetings.js'
import { openaiCompatRouter } from './routes/openai-compat.js'
import { openaiKeyRouter } from './routes/openai-key.js'
import { messageRefRouter } from './routes/message-ref.js'
import { archiveRouter } from './routes/archive.js'
import { sessionsRouter } from './routes/sessions.js'
import { mediaRouter, mediaBodyParser, mediaBinaryBodyParser } from './routes/media.js'
import { promptDraftsRouter } from './routes/prompt-drafts.js'
import { cliDebugRouter } from './routes/cli-debug.js'
import { maintenanceRouter } from './routes/maintenance.js'
import { ttsRouter } from './routes/tts.js'
import { voiceRouter } from './routes/voice.js'
import { glossaryRouter } from './routes/glossary.js'
import { handoffsRouter } from './routes/handoffs.js'
import { recoveryRouter } from './routes/recovery.js'
import { promptEditRouter } from './routes/prompt-edit.js'
import { bookmarksRouter } from './routes/bookmarks.js'
import { welcomeContextRouter } from './routes/welcome-context.js'
import { liveCuesRouter } from './routes/live-cues.js'
import { memoryRouter } from './routes/memory.js'
import { threadsRouter } from './routes/threads.js'
import { shutdownLiveCues } from './lib/live-cues-engine.js'
import { prewarmContext } from './lib/context-builder.js'
import { preWarmCLI } from './lib/claude-bridge.js'
import { getCodexRunConfig } from './lib/codex-run-ledger.js'
import {
  startCodexModelCatalogRefresh,
  stopCodexModelCatalogRefresh,
} from './lib/codex-model-catalog.js'
import { startWhisperServer, stopWhisperServer } from './lib/whisper-local.js'
import { startWhisperPreviewServer, stopWhisperPreviewServer } from './lib/whisper-preview.js'
import { startLocalTtsServer, stopLocalTtsServer } from './lib/tts-local.js'
import { initSileroVAD } from './lib/vad-silero.js'
import { initSessionCache } from './lib/session-cache-writer.js'
import { initSpeakerEmbeddings } from './lib/speaker-embeddings.js'
import { logActiveSessionsOnShutdown, startAutoSnapshot } from './lib/conversation.js'
import { getMediaStore } from './lib/media-store.js'
import { listenRequiredServers, type RequiredListener } from './lib/listener-startup.js'
import { serverMetrics } from './lib/server-metrics.js'
import { initializeServerInstanceId } from './lib/server-instance-id.js'
import { appendPrivateEnvBlock, UnsafeUserConfigPathError } from './lib/secure-user-config.js'
import { getTranscriptionProfileStatus } from './lib/profile.js'
import { createQueryJobsRouter } from './routes/query-jobs.js'
import {
  initQueryJobRuntime,
  preparePublicDurableQueryAdmission,
  queryJobCoordinator,
  shutdownQueryJobRuntime,
} from './lib/query-job-runtime.js'
import {
  isAllowedNetworkIp,
  isAllowedNetworkOrigin,
  isTailscaleIpv4,
} from './lib/network-policy.js'
import { requireApiToken } from './lib/api-auth.js'
import { isManagedRuntime } from './lib/managed-runtime.js'
import { reportClaudeExtraToolConfiguration } from './lib/claude-tool-access.js'
import {
  acquireMaintenanceWork,
  maintenanceOperationCredentialsValid,
  MaintenanceLifecycleError,
  maintenanceAdmissionsOpen,
  maintenanceErrorPayload,
  onMaintenanceAdmissionsOpen,
} from './lib/maintenance-lifecycle.js'

const app = express()
const PORT = parseInt(process.env.PORT ?? '3141', 10)

// Mode detection — COS mode when a full pipeline directory is configured.
// Standalone (default): glasses + your local Claude Code CLI only.
export const COS_MODE = !!process.env.COS_SCRIPTS_DIR

// Bind host: the glasses' phone app must reach this server over your network or
// mesh (e.g. Tailscale), so the default is 0.0.0.0 (all interfaces). The IP
// allowlist below still blocks untrusted public traffic. Set BIND_HOST=127.0.0.1
// to restrict to localhost only.
const BIND_HOST = process.env.BIND_HOST ?? '0.0.0.0'

// API token — auto-generate if not set so every session is authenticated.
const API_TOKEN_AUTO = !process.env.COS_API_TOKEN
if (isManagedRuntime() && API_TOKEN_AUTO) {
  throw new Error('Managed COS startup requires a pre-provisioned COS_API_TOKEN.')
}
const API_TOKEN = process.env.COS_API_TOKEN ?? `_${randomBytes(32).toString('base64url')}`
process.env.COS_API_TOKEN = API_TOKEN  // make available to routes that check it
// Persist an auto-generated token to ~/.cos-glasses/.env so it SURVIVES restarts.
// Without this, every re-run mints a new token and the app's saved token starts
// returning 401 — the symptom looks like a broken app, not a rotated credential.
let API_TOKEN_PERSISTED = false
if (API_TOKEN_AUTO) {
  try {
    const envDir = join(homedir(), '.cos-glasses')
    appendPrivateEnvBlock(
      join(envDir, '.env'),
      `# auto-generated by the server so the app token survives restarts\nCOS_API_TOKEN=${API_TOKEN}\n`,
    )
    API_TOKEN_PERSISTED = true
  } catch (error) {
    // Read-only homes may continue with a per-session token, but an unsafe
    // symlinked credential path must fail closed instead of being ignored.
    if (error instanceof UnsafeUserConfigPathError) throw error
  }
}

// IP allowlist — only accept connections from localhost, meshnet, and private networks.
// Blocks untrusted public access (coffee-shop WiFi, the open internet) while keeping all
// local + meshnet (Tailscale/CGNAT) + LAN consumers working.
app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || ''
  if (!isAllowedNetworkIp(ip)) {
    res.status(403).json({ error: 'forbidden — not on allowed network' })
    return
  }
  next()
})

// Allow localhost + LAN IPs (glasses WebView accesses server over LAN)
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (same-origin, curl, SSE) or "null" origin (file:// WebViews like Even Hub)
    if (!origin || origin === 'null') return cb(null, true)
    if (isAllowedNetworkOrigin(origin)) return cb(null, true)
    cb(new Error('CORS blocked'))
  },
}))
// Auth middleware — always active (token is auto-generated if not set).
// Mounted before body parsers so rejected uploads cannot consume parse memory.
// The only capability-URL exception is a canonical /tts/play/<UUID> GET/HEAD;
// authenticated /tts/prepare mints it for native audio players that cannot set
// X-Cos-Token headers.
app.use('/api', requireApiToken(API_TOKEN))

// Fail-closed catch-all for mutation routes that do not own a more specific
// lifecycle lease below. This closes the admission/drain race for secondary
// state-changing APIs (media, sessions, settings, diagnostics) without
// double-owning provider and recording continuations whose routes retain work
// through their true terminal boundary.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
  // V2 video original chunks are bounded to the advertised session size (1 MiB
  // on new sessions, 256 KiB on leftover drafts) and commit through the upload
  // registry's own generation lock. Holding the global mutation lease while
  // the phone transfers the body recreated the exact 90-second drain failure
  // this protocol exists to remove. Admission is checked by the route before
  // bytes are committed; in-flight bounded bodies finish or are discarded.
  const videoUploadBody = req.method === 'PUT'
    && /^\/media\/video-upload\/vu_[0-9a-f]{24}\/(?:original|frame)\/\d+$/.test(req.path)
  // Finalize may run ffmpeg for a long clip. Its durable registry state is the
  // restart/rollback gate, so holding the global request lease as well would
  // recreate Control's 90-second drain timeout. The route performs its own
  // fail-closed admission immediately before claiming `finalizing`.
  const videoUploadFinalize = req.method === 'POST'
    && /^\/media\/video-upload\/vu_[0-9a-f]{24}\/finalize$/.test(req.path)
  if (videoUploadBody || videoUploadFinalize) return next()
  const lifecycleOwned = (req.path === '/query-jobs' && req.method === 'POST')
    || req.path === '/query'
    || req.path === '/diagnostics/provider-proof'
    || req.path === '/transcribe'
    || req.path.startsWith('/transcribe-stream')
    || req.path === '/meeting/save'
    || req.path.startsWith('/prompt-drafts')
    || req.path.startsWith('/maintenance/drain')
  if (lifecycleOwned) return next()

  // COS Control must prove the candidate while a committed cross-boot gate is
  // still closed. Permit only its two bounded loopback proofs, and only with
  // the controller-held operation receipt. Normal phone/LAN admissions stay
  // closed throughout the update.
  const address = req.socket.remoteAddress ?? ''
  const loopback = address === '::1' || address === '127.0.0.1'
    || address.startsWith('127.') || address.startsWith('::ffff:127.')
  const controllerProofPath = req.path === '/diagnostics/provider-proof'
    || req.path === '/tts/prepare'
  const controllerProof = loopback && controllerProofPath
    && maintenanceOperationCredentialsValid({
      leaseId: typeof req.headers['x-cos-maintenance-lease'] === 'string'
        ? req.headers['x-cos-maintenance-lease'] : undefined,
      operationId: typeof req.headers['x-cos-maintenance-operation'] === 'string'
        ? req.headers['x-cos-maintenance-operation'] : undefined,
      nonce: typeof req.headers['x-cos-maintenance-nonce'] === 'string'
        ? req.headers['x-cos-maintenance-nonce'] : undefined,
    })
  // Cleanup and receipt acknowledgement only reduce rollback blockers. They
  // remain available during a drain so Control is never forced to wait for a
  // four-hour upload TTL after the phone already cancelled or persisted the
  // terminal receipt.
  const videoUploadCleanup = /^\/media\/video-upload\/vu_[0-9a-f]{24}$/.test(req.path)
    && req.method === 'DELETE'
    || /^\/media\/video-upload\/vu_[0-9a-f]{24}\/ack$/.test(req.path)
      && req.method === 'POST'

  try {
    // KNOWN HAZARD, deliberately not fixed here (2026-08-11). This lease is held for
    // the WHOLE request, including the body transfer. Every other mutation is
    // sub-second, but POST /api/media/file now accepts up to 100 MiB, which the
    // client itself budgets ~7.3 minutes for — far past COS Control's 90s drain
    // timeout (main.swift waitForRestartProof). A drain that catches a large upload
    // in flight will therefore hard-fail to Repair.
    //
    // Why no fix in this change: there is no per-kind budget map to declare a longer
    // allowance against, and blocksRestart belongs to the meeting-sync surface rather
    // than a generic active-work registry, so a new 'media_upload' kind would be a
    // label with no behaviour — a false signal that the case is handled. The correct
    // fix is to scope this lease to the INGEST (fast: validate + index write) instead
    // of the network transfer, which means changing a fail-closed middleware that
    // guards every mutation. That needs its own pass and its own tests.
    const lease = acquireMaintenanceWork('api_mutation', {
      allowDuringDrain: controllerProof || videoUploadCleanup,
    })
    let released = false
    const release = () => {
      if (released) return
      released = true
      lease.release()
    }
    res.once('finish', release)
    res.once('close', release)
    next()
  } catch (error) {
    if (error instanceof MaintenanceLifecycleError) {
      if (error.retryAfterSeconds != null) res.setHeader('Retry-After', String(error.retryAfterSeconds))
      return res.status(error.status).json(maintenanceErrorPayload(error))
    }
    return res.status(500).json({ error: 'maintenance_internal_error', retryable: false })
  }
})

// Authenticate before parsing large upload bodies. The 16 MB allowance stays
// scoped to /api/media; every other route retains the 10 MB ceiling.
app.use('/api/media/file', mediaBinaryBodyParser)
app.use('/api/media', mediaBodyParser)
app.use(express.json({ limit: '10mb' }))

// Request counter — must be before route registrations
app.use((_req, _res, next) => {
  serverMetrics.requestCount++
  next()
})

// Hydrated once at boot, before any route can read it. Never throws; a corrupt
// or unreadable store yields a degraded registry rather than a silent empty one.
const agentSessionBindingRegistry = AgentSessionBindingRegistry.open()
// Boot reap, and it is load-bearing rather than housekeeping. A turn pins its
// binding and unpins in a `finally` that never runs if the process dies during the
// provider run — a window of up to the 21-minute attached timeout, and exactly what
// a crash, a force-quit, or a COS Control "Update Server" does. A pinned binding
// never expires by design, and `blocksTarget` refuses any pinned target, so the
// thread becomes permanently unattachable: measured at +1m, +31m, +2d, +40d and
// +400d, all `native_target_busy`. The refusal copy tells the user to detach the
// other chat, and this router registers no detach route, so the only recovery was
// hand-editing the store. `reap()` already fixes it and simply had no caller.
try {
  const reaped = agentSessionBindingRegistry.reap(Date.now())
  if (reaped.pinsDropped > 0 || reaped.removed.length > 0) {
    console.log(`[binding-registry] boot reap: ${reaped.pinsDropped} stale pin(s) dropped, ${reaped.removed.length} binding(s) removed`)
  }
} catch (error) {
  console.warn('[binding-registry] boot reap failed', error)
}
// And periodically, so a strand created mid-run clears without waiting for the next
// restart. Unref'd so it never holds the process open during shutdown.
const bindingReapTimer = setInterval(() => {
  try { agentSessionBindingRegistry.reap(Date.now()) } catch { /* next tick retries */ }
}, 10 * 60_000)
bindingReapTimer.unref()

// Built once. Each of these reads the disk, so sharing them keeps an attach from
// re-deriving roots per request.
const occupancyProbes = realOccupancyProbes(cosSpawnedPids)
const occupancyDirs = realOccupancyDirs()
const nativeHeadDeps = realNativeHeadDeps()
const attachedWorkspaceDeps = realAttachedWorkspaceDeps(nativeHeadDeps)

/**
 * The shim between the route's request shape and the adapter's.
 *
 * The route was written against a contract that carries fingerprints and a veto
 * hook; the adapter needs a real cwd, a permission policy, and its dependencies.
 * Reconciling them is the composition root's job — putting it in either module
 * would make one of them know about the other's shape.
 *
 * OWNERSHIP IS RECORDED EXACTLY ONCE, BY THE ROUTE.
 *
 * An earlier version of this comment claimed "exactly once" while the code did it
 * twice: it called `recordCosSpawn` here and then `request.onSpawn(pid)`, and the
 * route's `onSpawn` is not a veto — it re-probes the process start and records the
 * claim itself (agent-session-bindings.ts:1395-1422). Measured, one turn produced
 * `recorded +2 / released +1`. Not a leak, since both writes hit one Map key and a
 * single release clears it, but it pinned `stats().recorded : released` at a
 * permanent 2:1 — and that ratio is exactly what an operator reads to detect the
 * leak this ledger exists to prevent, so the diagnostic was poisoned by the code
 * meant to feed it.
 *
 * The route is the right owner: it holds the `recordedPids` list its own `finally`
 * releases from. So this delegates rather than duplicating. Any return other than
 * the exact string 'recorded' makes the adapter SIGKILL the child and release
 * before a single prompt byte is written, which is the veto the route wants.
 */
const deliverAttachedTurnForRoute = async (request: {
  provider: 'claude' | 'codex'
  nativeThreadId: string
  prompt: string
  onSpawn: (pid: number) => boolean
}): Promise<unknown> => {
  // Resolved here, not stored on the binding: the cwd is read from the transcript,
  // which records it verbatim. Decoding the project slug is lossy — this Mac's own
  // workspace path contains both a space and hyphens.
  const workspace = resolveAttachedWorkspace(
    request.provider, request.nativeThreadId, attachedWorkspaceDeps,
  )
  // No cwd means no attach. Never fall back to the server's own working directory,
  // which is wherever the LaunchAgent happened to start.
  if (workspace === null) {
    return { ok: false, delivery: 'not_attempted', reason: 'target_unresolvable' }
  }

  const base = realAttachedTurnDeps(() => {
    // The final occupancy re-check, synchronous and immediately before spawn
    // (plan 4.3 step 6). A newly appeared owner is terminal, not a warning.
    const verdict = threadOccupancy(
      request.provider, request.nativeThreadId, occupancyProbes, occupancyDirs,
    )
    return { attachable: verdict.attachable, reason: verdict.reason }
  })

  return deliverAttachedTurn({
    provider: request.provider,
    nativeThreadId: request.nativeThreadId,
    prompt: request.prompt,
    cwd: workspace.path,
    // The only policy this build accepts. The adapter refuses anything else and
    // asserts no bypass/always-approve flag reaches the argv (plan 4.7).
    policy: 'read_only',
    deps: {
      ...base,
      // `startMs` is deliberately unused: the adapter already probed it as a GATE
      // (a null there aborts before this is reached), and the route probes again
      // as the recorder. One record, one authority.
      recordSpawn: (pid: number, _startMs: number) =>
        request.onSpawn(pid) ? 'recorded' : 'route_refused_ownership',
    },
  })
}

/**
 * The shim for FORK — the action seventeen refusal strings in this feature already
 * recommend, and which until 6.29 existed nowhere in the server or the app.
 *
 * Deliberately much thinner than the attached shim above, and every difference is
 * load-bearing:
 *
 *  - NO PREFLIGHT. `realAttachedTurnDeps` takes an occupancy re-check because it is
 *    about to APPEND to a thread someone may have open on their desktop. A fork
 *    appends to nothing: verified byte-for-byte on both providers on 2026-08-16,
 *    source sha256 unchanged across the run. A live desktop owner must therefore
 *    NOT block a fork — gating it here would refuse at exactly the moment fork is
 *    the only path the user has left.
 *  - NO `onSpawn` HAND-BACK. The turns route owns its own ledger record because it
 *    holds the `recordedPids` list that its `finally` releases from. The fork route
 *    holds no such list, so `fork-thread.ts` records and releases the child itself,
 *    exactly once, on every exit path — which keeps the recorded:released ratio the
 *    operator reads for leak detection at 1:1.
 *  - A WATERMARK IS SUPPLIED, and it is the point. `nativeHead` of the SOURCE, read
 *    once before the spawn and once after the child settles, is what turns "a fork
 *    does not touch the original" from a promise into a checked property. It is
 *    SYNCHRONOUS (native-head.ts:491), which is what lets the module read the
 *    baseline at the spawn boundary without an await. Unwired, the module can only
 *    ever report `unverified`, and it would report that honestly rather than
 *    claiming a verification it never performed.
 */
const forkThreadForRoute = (request: {
  provider: 'claude' | 'codex'
  nativeThreadId: string
  prompt: string
  cwd: string
  policy: 'read_only'
}): Promise<unknown> => forkThread({
  ...request,
  deps: realForkDeps((provider, threadId) => nativeHead(provider, threadId, nativeHeadDeps)),
})

// API routes
app.use('/api', healthRouter)
app.use('/api', diagRouter)
app.use('/api', createQueryJobsRouter(queryJobCoordinator, {
  prepareAdmission: preparePublicDurableQueryAdmission,
}))
app.use('/api', queryRouter)
app.use('/api', providerProofRouter)
app.use('/api', transcribeRouter)
// Ported from cos-glasses-app in 6.24.0. The companion's Sessions tab has been
// calling this and getting a 404 since the managed-runtime cutover.
app.use('/api', sessionIndexRouter)
// Claude + Codex + Cursor transcripts from this Mac. Same 7-day window as Control.
app.use('/api', agentSessionsRouter)
// Presence view of Claude Code sessions on this Mac. Dark unless
// COS_CLAUDE_SESSIONS_ENABLED=1 — it projects another product's 0700 state dir.
app.use('/api', claudeSessionsRouter)
// Phase 0 of Continue Original Agent Thread: can COS write into a desktop thread
// without colliding with a live writer? Read-only — it answers, it never attaches.
// Registered AFTER agentSessionsRouter deliberately: its paths are 2 and 4 segments
// (`/agent-sessions/bindings`, `/agent-sessions/:provider/:threadId/attachability`)
// and cannot shadow that router's `/agent-sessions/:provider/:id` transcript route.
app.use('/api', createAgentSessionBindingsRouter({
  probes: occupancyProbes,
  dirs: occupancyDirs,
  now: () => Date.now(),
  resolveTarget: (provider, threadId) => {
    const workspace = resolveAttachedWorkspace(provider, threadId, attachedWorkspaceDeps)
    // Only the fingerprints cross this boundary. The route persists what it is
    // given, and plan 3.3 keeps a filesystem path off anything client-visible.
    return workspace === null ? null : {
      workspaceFingerprint: workspace.workspaceFingerprint,
      sourceFingerprint: workspace.sourceFingerprint,
    }
  },
  nativeHead: (provider, threadId) => nativeHead(provider, threadId, nativeHeadDeps),
  deliverAttachedTurn: deliverAttachedTurnForRoute as never,
  forkThread: forkThreadForRoute,
  // The fork's real spawn directory. Separate from `resolveTarget` above, which
  // deliberately yields only fingerprints because plan 3.3 keeps a filesystem path
  // off anything client-visible. Null refuses: never fall back to the server's own
  // working directory, which is wherever the LaunchAgent happened to start.
  resolveForkWorkspace: (provider, threadId) =>
    resolveAttachedWorkspace(provider, threadId, attachedWorkspaceDeps)?.path ?? null,
  // One instance per process. The epoch high-water mark is only monotonic if a
  // single reader owns the durable store, so this must never be constructed twice.
  // `open()` never throws: an unreadable store yields a DEGRADED registry whose
  // `available()` is false, which the route renders as a refusal rather than as an
  // empty list — "nothing is bound" and "the store could not be read" must not
  // look the same.
  bindings: agentSessionBindingRegistry,
}))
app.use('/api', displayRouter)
app.use('/api', transcribeStreamRouter)
app.use('/api', meetingRouter)
app.use('/api', meetingsRouter)
app.use('/api', memoryRouter)
app.use('/api', threadsRouter)
app.use('/api', openaiKeyRouter)
// v6.3.0 — Message History, cross-day 'reference message N', and history
// recovery for public npx users (previously full-COS-server only).
app.use('/api', messageRefRouter)
app.use('/api', archiveRouter)
app.use('/api', sessionsRouter)
app.use('/api', mediaRouter)
app.use('/api', promptDraftsRouter)
app.use('/api', cliDebugRouter)
app.use('/api', maintenanceRouter)
app.use('/api', ttsRouter)
app.use('/api', voiceRouter)
app.use('/api', glossaryRouter)
app.use('/api', handoffsRouter)
app.use('/api', recoveryRouter)
app.use('/api', promptEditRouter)
app.use('/api', bookmarksRouter)
app.use('/api', welcomeContextRouter)
app.use('/api', liveCuesRouter)

// OpenAI-compatible endpoint for the G2 Agent (ER "Add Agent")
// Mounted at root — routes are /v1/chat/completions and /v1/models
app.use(openaiCompatRouter)

// Friendly root — this is an API server. The glasses client ships as the Even Hub
// app (the .ehpk), not from here. A browser hitting the host sees a status page.
app.get('/', (_req, res) => {
  res.type('html').send(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>COS Glasses Server</title>' +
    '<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.25rem;line-height:1.6;color:#111">' +
    '<h1 style="font-size:1.4rem">COS Glasses Server</h1>' +
    '<p>Running. This is the local API for the <strong>COS Glasses</strong> app on Even G2 smart glasses.</p>' +
    '<ul><li>Health: <a href="/api/health">/api/health</a></li>' +
    '<li>Setup guide: <a href="https://www.gotcos.com">gotcos.com</a></li></ul>' +
    '<p style="color:#666;font-size:.9rem">Install the client from the Even Hub, then point it at this server\'s address + token.</p></body>'
  )
})

// Graceful shutdown persists an interrupted terminal before provider abort.
// The bounded force-exit keeps service managers from hanging forever on a
// broken disk while retaining the previous session/catalog/Whisper cleanup.
let gracefulShutdownStarted = false
async function gracefulShutdown(): Promise<void> {
  if (gracefulShutdownStarted) return
  gracefulShutdownStarted = true
  const forceExit = setTimeout(() => process.exit(1), 8_000)
  forceExit.unref?.()
  try {
    await shutdownQueryJobRuntime('server_shutdown')
  } catch (error) {
    console.error('[query-jobs] graceful interruption failed:', error)
  }
  // Live Cues spawns detached trees (Cursor CLI, python with claude -p
  // grandchildren) that would survive this process's death — kill them
  // explicitly inside the 8s force-exit budget. Single-flight guarantees at
  // most one tree per session, which fits.
  try {
    await shutdownLiveCues()
  } catch (error) {
    console.error('[live-cues] shutdown termination failed:', error)
  }
  try { logActiveSessionsOnShutdown() } catch { /* best-effort flush */ }
  stopCodexModelCatalogRefresh()
  stopWhisperServer()
  await stopWhisperPreviewServer()
  stopLocalTtsServer()
  clearTimeout(forceExit)
  process.exit(0)
}
process.on('SIGTERM', () => { void gracefulShutdown() })
process.on('SIGINT', () => { void gracefulShutdown() })

// Crash protection for runtime work. Listener failures are handled separately
// and exit immediately so a supervisor can restart a clean, unified process.
process.on('uncaughtException', (err) => {
  console.error('[CRASH GUARD] Uncaught exception (server stays alive):', err.message)
  console.error(err.stack)
})
process.on('unhandledRejection', (reason: any) => {
  console.error('[CRASH GUARD] Unhandled rejection (server stays alive):', reason?.message ?? reason)
  if (reason?.stack) console.error(reason.stack)
})

// Start HTTPS alongside HTTP — Even Hub WebView prefers HTTPS (iOS ATS).
// Optional: drop cert.pem + key.pem in server/certs/ (e.g. via mkcert) to enable.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
/**
 * Let a slow large upload finish instead of killing its socket mid-body.
 *
 * Node's default `requestTimeout` is 300s. That was invisible while the cap was
 * 64 MiB, which needs ~262s at the throughput the CLIENT itself budgets for
 * (UPLOAD_FLOOR_BYTES_PER_SEC = 250 KiB/s, cos-glasses-app shared/media-attachment.ts).
 * Raising the video cap to 100 MiB pushes the worst case to ~7.3 minutes, so the default
 * would have destroyed the socket roughly 140 seconds BEFORE the client's own deadline
 * expired — breaking exactly the size band the raise exists to enable, and surfacing as
 * an opaque network error instead of a timeout that states its budget.
 *
 * 900_000 is deliberately the client's UPLOAD_TIMEOUT_CEILING_MS, so the two repos agree
 * by construction: the client always gives up first and gets to report the diagnostic.
 *
 * Wrapped at each createServer call rather than looped over `listeners`, because
 * RequiredListener types `server` as the base net.Server, which has no requestTimeout.
 * The generic constraint makes a server that cannot carry the timeout a compile error
 * instead of a silent no-op or a cast that hides the HTTP-specific dependency.
 *
 * headersTimeout stays at its default — headers arrive immediately even on a slow body,
 * so shortening their window is the wrong lever.
 */
const MAX_REQUEST_MS = 900_000
function withRequestTimeout<T extends { requestTimeout: number }>(server: T): T {
  server.requestTimeout = MAX_REQUEST_MS
  return server
}

const HTTPS_PORT = parseInt(process.env.HTTPS_PORT ?? '3143', 10)
const certDir = path.join(__dirname, 'certs')
const listeners: RequiredListener[] = []
if (existsSync(path.join(certDir, 'cert.pem'))) {
  const httpsServer = withRequestTimeout(createHttpsServer({
    cert: readFileSync(path.join(certDir, 'cert.pem')),
    key: readFileSync(path.join(certDir, 'key.pem')),
  }, app))
  listeners.push({ server: httpsServer, port: HTTPS_PORT, host: BIND_HOST, label: 'HTTPS' })
} else {
  console.log('[COS API] No certs found — HTTPS disabled (drop cert.pem/key.pem in server/certs to enable)')
}

const httpServer = withRequestTimeout(createHttpServer(app))
listeners.push({ server: httpServer, port: PORT, host: BIND_HOST, label: 'HTTP' })

listenRequiredServers(listeners).then(() => {
  const serverInstanceId = initializeServerInstanceId()
  const startupAdmissionsOpen = maintenanceAdmissionsOpen()
  if (listeners.some(listener => listener.label === 'HTTPS')) {
    console.log(`[COS API] HTTPS server running on https://${BIND_HOST}:${HTTPS_PORT}`)
  }
  console.log(`[COS API] HTTP server running on http://${BIND_HOST}:${PORT}`)
  console.log(`[COS API] Server instance: ${serverInstanceId}`)
  console.log(`[COS API] Mode: ${COS_MODE ? 'COS pipeline' : 'standalone'}`)

  if (!startupAdmissionsOpen) {
    console.log('[COS API] Startup maintenance gate is closed — durable recovery waits for controller release')
  }

  // Print ADDRESSES THE PHONE CAN ACTUALLY REACH. The bind address (0.0.0.0) is
  // not paste-able — enumerate real interfaces and label the Tailscale one.
  try {
    const nets = networkInterfaces()
    const addrs: Array<{ ip: string; label: string }> = []
    for (const [name, infos] of Object.entries(nets)) {
      for (const info of infos ?? []) {
        if (info.family !== 'IPv4' || info.internal) continue
        const isTailscale = isTailscaleIpv4(info.address) || name.startsWith('tailscale')
        addrs.push({ ip: info.address, label: isTailscale ? 'Tailscale — works from anywhere' : `${name} — same Wi-Fi only` })
      }
    }
    if (addrs.length > 0) {
      addrs.sort((a, b) => Number(b.label.startsWith('Tailscale')) - Number(a.label.startsWith('Tailscale')))
      console.log('')
      console.log('[COS API] Server URL for the COS Glasses app:')
      for (const a of addrs) console.log(`[COS API]   http://${a.ip}:${PORT}   (${a.label})`)
    }
  } catch { /* interface enumeration is best-effort */ }

  // Interactive standalone startup may print a newly generated pairing token.
  // Managed startup never generates or logs credentials; COS Control copies the
  // pre-provisioned token through the local pasteboard flow instead.
  if (API_TOKEN_AUTO && !isManagedRuntime()) {
    console.log('')
    console.log(`[COS API] API Token: ${API_TOKEN}`)
    console.log('[COS API]   ^ paste this into the COS Glasses app' + (API_TOKEN_PERSISTED ? ' — saved to ~/.cos-glasses/.env so it stays the same across restarts' : ' (set COS_API_TOKEN in .env for a fixed token)'))
    console.log('')
  }

  // Check Claude CLI availability. Codex-only installs remain fully valid.
  let claudeAvailable = false
  try {
    execSync('claude --version', { timeout: 5000, stdio: 'pipe' })
    claudeAvailable = true
    console.log('[COS API] Claude Code CLI detected')
  } catch {
    console.warn('[COS API] Claude Code CLI not found — install from https://docs.anthropic.com/en/docs/claude-code/getting-started')
    console.warn('[COS API]   Claude models unavailable; Codex models still work when Codex CLI is installed')
  }

  const codexConfig = getCodexRunConfig()
  console.log(`[COS API] Codex mode: ${codexConfig.persistenceEnabled ? 'persistent' : 'ephemeral'} · ${codexConfig.reasoningEffort} · ${codexConfig.trustMode}`)
  console.log(`[COS API] Codex models (${codexConfig.catalogSource}): ${codexConfig.availableModels.map(item => `${item.displayName}=${item.model}`).join(' · ')}`)
  console.log(`[COS API] Codex workdir: ${codexConfig.cwd}`)
  reportClaudeExtraToolConfiguration()

  // These services do not admit or mutate user work. They must start while a
  // managed successor is still behind the cross-boot gate so COS Control can
  // prove the candidate before opening admissions. Keeping this idempotent also
  // prevents a release notification from creating duplicate sidecars.
  let proofSafeServicesStarted = false
  const startProofSafeServices = () => {
    if (proofSafeServicesStarted) return
    proofSafeServicesStarted = true

    // Refresh immediately and then periodically. The catalog retains the last
    // known-good snapshot if Codex is temporarily unavailable.
    startCodexModelCatalogRefresh()
    // Start local whisper-server (model stays in RAM for ~50ms transcription)
    const transcriptionProfile = getTranscriptionProfileStatus()
    if (transcriptionProfile.ignoredPlaceholderTerms > 0 || transcriptionProfile.ignoredPlaceholderCorrection) {
      console.warn(
        '[whisper] .cos-profile.json still contains factory vocabulary. ' +
        'Placeholder terms are ignored; add real names and terminology in Guided Setup for better accuracy.',
      )
    }
    // Load the authoritative Turbo worker first. Starting both model loads at
    // once made first boot slower on smaller Macs and could cause Control's
    // readiness proof to time out even though both models were healthy.
    startWhisperServer()
      .then(() => startWhisperPreviewServer())
      .catch(err => console.error('[startup] Whisper server/preview error:', err))
    startLocalTtsServer().catch(err => console.error('[startup] Local TTS server error:', err))
    // Initialize speaker embeddings (voiceprint-based diarization) — fails soft if model absent
    const embeddingOk = initSpeakerEmbeddings()
    console.log(`[startup] Speaker embeddings: ${embeddingOk ? 'active' : 'disabled (model not found)'}`)
    // Initialize Silero VAD (silence trimming before Whisper) — fails soft if model absent
    const vadOk = initSileroVAD()
    console.log(`[startup] Silero VAD: ${vadOk ? 'active' : 'disabled (model not found)'}`)
  }

  // Durable recovery starts with the admitted runtime by default. A literal
  // COS_DURABLE_QUERY_JOBS=0 is the machine-wide rollback.
  let admittedRuntimeStarted = false
  const startAdmittedRuntime = () => {
    if (admittedRuntimeStarted) return
    admittedRuntimeStarted = true

    // Resume already-saved meetings whose post-response HQ/operations work
    // was interrupted by a prior server update or process exit.
    resumeMeetingFinalizationJobs()

    void initQueryJobRuntime().then(health => {
      if (process.env.COS_DURABLE_QUERY_JOBS !== '0') {
        console.log(`[COS API] Durable query jobs: ${health.store.state} · ${health.store.retainedIdentities} retained`)
      } else {
        console.log('[COS API] Durable query jobs: disabled by COS_DURABLE_QUERY_JOBS=0')
      }
    }).catch(error => {
      // The store remains degraded and rejects admission. Legacy /api/query is
      // still mounted, so the kill switch is an immediate rollback.
      console.error('[COS API] Durable query-job store unavailable:', error)
    })

    if (COS_MODE) {
      initSessionCache()
      // Pre-warm context cache so first query doesn't wait for the pipeline
      prewarmContext()
    }

    // Pre-warm Claude only when installed so Codex-only startup stays quiet.
    if (claudeAvailable) {
      preWarmCLI().catch(err => console.error('[startup] CLI pre-warm error:', err))
    }

    // Auto-snapshot active sessions every 5 min (survives restarts)
    startAutoSnapshot(5 * 60_000)

    // Durable media GC (staged/reserved expiry + generated-image content TTL).
    getMediaStore().startGC()
  }

  startProofSafeServices()
  onMaintenanceAdmissionsOpen(startAdmittedRuntime)
}).catch((error: NodeJS.ErrnoException) => {
  console.error(`[COS API] Fatal listener startup: ${error.message}`)
  process.exit(error.code === 'EADDRINUSE' ? 75 : 74)
})
