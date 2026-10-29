// Speaker merge shadow mode (6.95.0). OFF BY DEFAULT. LOG ONLY.
//
// WHY. Mac recordings split one person into many anonymous `Voice N` labels (45 on one
// 60-minute call). A research canary found a hybrid that fixes this safely on the
// reference call: production labels stay the base and FluidAudio's offline Community-1
// diarizer only PROPOSES merges, behind the gates in speaker-shadow-decide.ts. Shadow mode
// computes and logs those proposals for every finished Mac meeting so they can be scored
// against Miles's later corrections. There is no write path, and none may be added here.
//
// SWITCH, per Mac, in the transcript-cleanup pattern (6.77.0), off for everyone by default:
//   1. env COS_SPEAKER_SHADOW=1|true|yes|on forces it on, =0|false|no|off forces it off
//      (source 'env'); a request to change it then answers 409 env_forced;
//   2. the saved setting <data>/speaker-shadow/settings.json (atomic), written through the
//      token-protected POST /api/speaker-shadow/settings {"enabled":true|false}, read at use
//      time, so no restart is needed (source 'setting');
//   3. off (source 'default').
// An unreadable settings file reads as no setting, which is off. Off means nothing is queued,
// nothing is spawned and no file is created. Turning it off mid-run stops the run.
//
// HOW IT STOPS.
//   - the switch (remove it and restart);
//   - a daily cap on runs (COS_SPEAKER_SHADOW_DAILY_RUNS, default 12);
//   - a breaker: 3 consecutive failures pause it for 1 hour;
//   - a hard wall clock (180 s, COS_SPEAKER_SHADOW_TIMEOUT_MS may only lower it) and an
//     RSS cap on the whole process group (COS_SPEAKER_SHADOW_RSS_MB, default 3072);
//   - live work: a recording, a save, a batch finalization or a one-shot transcription
//     defers it, and one that starts mid-run kills the run and puts the meeting back.
//
// No LLM and no network at run time: the CLI runs under sandbox-exec with network denied,
// and only after the pinned models verify (speaker-shadow-models.ts).
//
// WHAT IT WRITES, all under <data>/speaker-shadow/: proposals.jsonl (one record per
// meeting, atomic rewrite, rotated past 8 MB), state.json (queue, cap, breaker), and the
// CLI's private HOME. Plus a temp directory the worker removes. Never a meeting file, a
// label, a name, a profile, an embedding cache or the correction ledger.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { setPriority, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { MAC_CAPTURE_ID } from './mac-recording.js'
import { maintenanceLifecycle } from './maintenance-lifecycle.js'
import { installedCliIntact, installedCliTrust, parakeetCliPath, parakeetInstalled, SANDBOX_EXEC } from './parakeet.js'
import { SHADOW_GATES } from './speaker-shadow-decide.js'
import { shadowModelsPresent, speakerShadowHome, speakerShadowModelsDir, speakerShadowRoot } from './speaker-shadow-models.js'
import { readShadowMeetingTitle, shadowEntries, shadowLabelsHash, shadowMeetingDay } from './speaker-shadow-timeline.js'
import { renderShadowRunFacts, renderShadowSkipReport, shadowReportRelativePath } from './speaker-shadow-report.js'
import { SHADOW_TMP_PREFIX, type ShadowJob, type ShadowJobOutcome, type ShadowRunFacts } from './speaker-shadow-worker.js'
import type { ShadowProposals } from './speaker-shadow-decide.js'

export const SPEAKER_SHADOW_ENV = 'COS_SPEAKER_SHADOW'
export const SPEAKER_SHADOW_RECORDS = 'proposals.jsonl'
export const SPEAKER_SHADOW_STATE = 'state.json'
/** The wall clock the brief fixes (the canary took about 20 s for 60 minutes). */
export const SPEAKER_SHADOW_MAX_TIMEOUT_MS = 180_000
export const SPEAKER_SHADOW_BREAKER_FAILURES = 3
export const SPEAKER_SHADOW_BREAKER_PAUSE_MS = 60 * 60_000
export const SPEAKER_SHADOW_RECORDS_ROTATE_BYTES = 8 * 1024 * 1024
const MAX_QUEUE = 25
const QUEUE_MAX_AGE_MS = 24 * 60 * 60_000
const DEFER_RETRY_MS = 60_000
const SAMPLE_MS = 1_000
const MAX_STDOUT = 8 * 1024 * 1024

export const SPEAKER_SHADOW_SETTINGS = 'settings.json'
const ENV_ON = new Set(['1', 'true', 'yes', 'on'])
const ENV_OFF = new Set(['0', 'false', 'no', 'off'])
export type SpeakerShadowSwitchSource = 'env' | 'setting' | 'default'

/** What the environment pins, or null when it pins nothing (unset, empty or unrecognised). */
export function speakerShadowEnvSwitch(env: NodeJS.ProcessEnv = process.env): boolean | null {
  const raw = (env[SPEAKER_SHADOW_ENV] ?? '').trim().toLowerCase()
  return ENV_ON.has(raw) ? true : ENV_OFF.has(raw) ? false : null
}

const settingsCache = new Map<string, { key: string; value: boolean | null }>()
/** The saved per-Mac setting: true, false, or null when there is none or it cannot be read. */
export function readSpeakerShadowSetting(root: string = speakerShadowRoot()): boolean | null {
  const file = join(root, SPEAKER_SHADOW_SETTINGS)
  try {
    const st = statSync(file)
    const key = `${st.mtimeMs}:${st.size}`
    const cached = settingsCache.get(file)
    if (cached?.key === key) return cached.value
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.enabled === 'boolean' ? raw.enabled : null
    settingsCache.set(file, { key, value })
    return value
  } catch { return null }
}

/** Atomic and durable. The only writer of the setting. */
export function writeSpeakerShadowSetting(enabled: boolean, root: string = speakerShadowRoot(), now: Date = new Date()): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  durableAtomicWriteFileSync(join(root, SPEAKER_SHADOW_SETTINGS), `${JSON.stringify({ schema: 1, enabled, updatedAt: now.toISOString() })}\n`, { mode: 0o600 })
  settingsCache.delete(join(root, SPEAKER_SHADOW_SETTINGS))
}

export function resolveSpeakerShadowSwitch(env: NodeJS.ProcessEnv = process.env, root: string = speakerShadowRoot()): { enabled: boolean; source: SpeakerShadowSwitchSource } {
  const pinned = speakerShadowEnvSwitch(env)
  if (pinned !== null) return { enabled: pinned, source: 'env' }
  const stored = readSpeakerShadowSetting(root)
  if (stored !== null) return { enabled: stored, source: 'setting' }
  return { enabled: false, source: 'default' }
}

export function speakerShadowEnabled(env: NodeJS.ProcessEnv = process.env, root: string = speakerShadowRoot()): boolean {
  return resolveSpeakerShadowSwitch(env, root).enabled
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = Number(env[key])
  return Number.isFinite(raw) && raw > 0 ? Math.min(max, Math.max(min, Math.floor(raw))) : fallback
}

export interface SpeakerShadowLimits { dailyRuns: number; timeoutMs: number; rssBytes: number }
export function speakerShadowLimits(env: NodeJS.ProcessEnv = process.env): SpeakerShadowLimits {
  return {
    dailyRuns: intEnv(env, 'COS_SPEAKER_SHADOW_DAILY_RUNS', 12, 1, 50),
    timeoutMs: intEnv(env, 'COS_SPEAKER_SHADOW_TIMEOUT_MS', SPEAKER_SHADOW_MAX_TIMEOUT_MS, 10_000, SPEAKER_SHADOW_MAX_TIMEOUT_MS),
    rssBytes: intEnv(env, 'COS_SPEAKER_SHADOW_RSS_MB', 3072, 256, 8192) * 1024 * 1024,
  }
}

// ── Records ──────────────────────────────────────────────────────────────────

export type SpeakerShadowStatus = 'proposed' | 'skipped' | 'failed'
export type SpeakerShadowRunnerReason =
  | 'stale' | 'daily_cap' | 'cli_missing' | 'models_missing' | 'audio_missing'
  | 'timeout' | 'rss_cap' | 'worker_crashed' | 'worker_spawn_failed'

export interface SpeakerShadowRecord {
  schema: 1
  kind: 'speaker_shadow'
  /** Always true: nothing in this record was applied anywhere. */
  logOnly: true
  recordedAt: string
  serverVersion: string
  sessionId: string
  enqueuedAt: string
  status: SpeakerShadowStatus
  reason: string | null
  detail: string | null
  gates: { majority: number; minCoveredFraction: number; floorSeconds: number; outlier: string; anchorRatioPostHocColumnOnly: number }
  facts?: ShadowRunFacts
  proposals?: ShadowProposals
  resources?: { wallMs: number; peakRssBytes: number | null; cliTrust: string | null }
  /** The readable report, relative to <data>/speaker-shadow/ (reports/<day>/<title>__<session>.md). */
  report?: string | null
}

const GATES_RECORD = { majority: SHADOW_GATES.majority, minCoveredFraction: SHADOW_GATES.minCoveredFraction, floorSeconds: SHADOW_GATES.floorSeconds, outlier: 'leave-fragment-out cluster p95', anchorRatioPostHocColumnOnly: SHADOW_GATES.anchorRatioPostHoc }

/** Append one record: the whole file is rewritten to a temp file, fsynced and renamed, so a reader never sees half a line. */
export async function appendSpeakerShadowRecord(root: string, record: SpeakerShadowRecord): Promise<void> {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = join(root, SPEAKER_SHADOW_RECORDS)
  let existing = ''
  try { existing = await readFile(path, 'utf8') } catch { /* first record */ }
  if (existing.length >= SPEAKER_SHADOW_RECORDS_ROTATE_BYTES) {
    await rename(path, join(root, `proposals-${new Date(Date.parse(record.recordedAt)).toISOString().replace(/[:.]/g, '-')}.jsonl`))
    existing = ''
  }
  if (existing && !existing.endsWith('\n')) existing += '\n'
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  const handle = await open(tmp, 'wx', 0o600)
  try {
    await handle.writeFile(`${existing}${JSON.stringify(record)}\n`)
    await handle.sync()
  } finally { await handle.close() }
  try { await rename(tmp, path) } catch (error) { await unlink(tmp).catch(() => {}); throw error }
}

/** Newest first. Malformed lines are skipped, never fatal. */
export async function readSpeakerShadowRecords(root: string, options: { limit?: number; sessionId?: string } = {}): Promise<SpeakerShadowRecord[]> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 10))
  let names: string[] = []
  try { names = (await readdir(root)).filter(n => n === SPEAKER_SHADOW_RECORDS || /^proposals-[0-9TZ-]+\.jsonl$/.test(n)) } catch { return [] }
  names.sort((a, b) => a === SPEAKER_SHADOW_RECORDS ? -1 : b === SPEAKER_SHADOW_RECORDS ? 1 : b.localeCompare(a))
  const out: SpeakerShadowRecord[] = []
  for (const name of names) {
    let text = ''
    try { text = await readFile(join(root, name), 'utf8') } catch { continue }
    const lines = text.split('\n').filter(Boolean).reverse()
    for (const line of lines) {
      let record: SpeakerShadowRecord
      try { record = JSON.parse(line) } catch { continue }
      if (record?.kind !== 'speaker_shadow') continue
      if (options.sessionId && record.sessionId !== options.sessionId) continue
      out.push(record)
      if (out.length >= limit) return out
    }
  }
  return out
}

// ── State ────────────────────────────────────────────────────────────────────

interface QueueItem { sessionId: string; sidecarPath: string; labelsHash: string | null; enqueuedAt: number }
interface ShadowState {
  schema: 1
  day: string
  runsToday: number
  consecutiveFailures: number
  breakerUntil: number | null
  lastRun: { at: number; sessionId: string; status: SpeakerShadowStatus; reason: string | null } | null
  lastError: { at: number; reason: string; detail: string } | null
  done: string[]
  queue: QueueItem[]
}

const emptyState = (day: string): ShadowState => ({ schema: 1, day, runsToday: 0, consecutiveFailures: 0, breakerUntil: null, lastRun: null, lastError: null, done: [], queue: [] })

function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── Runner ───────────────────────────────────────────────────────────────────

export interface SpeakerShadowCli { path: string; sha256: string; trust: string | null }

export interface SpeakerShadowDeps {
  env: () => NodeJS.ProcessEnv
  root: () => string
  now: () => number
  /** True while a recording, save, finalization or one-shot transcription is live. Null = not wired: never run. */
  captureActive: (() => boolean) | null
  /** False during a maintenance drain. */
  admissionsOpen: () => boolean
  resolveCli: () => Promise<SpeakerShadowCli | null>
  audioDirFor: (sessionId: string) => string
  modelsDir: () => string
  homeDir: () => string
  sandboxExec: string
  tmpRoot: string
  /** Starts the worker child. Must start it as its own process group leader. */
  spawnWorker: () => ChildProcess
  /** Resident bytes of the process group led by pid, or null when it cannot be read. */
  sampleRss: (pgid: number) => Promise<number | null>
  killGroup: (pgid: number) => void
  log: (line: string) => void
  setTimer: (fn: () => void, ms: number) => { unref?: () => void }
  /** The cheap scheduler-side model look (sizes only); the worker hashes every file. */
  modelsPresent: (dir: string) => boolean
  limits: () => SpeakerShadowLimits
  /** Cheap, synchronous: is the CLI the runner would use installed, and how is it trusted. */
  cliReadiness: () => { installed: boolean; trust: string | null }
}

export interface SpeakerShadowReadiness {
  /** Every pinned model file is present with its size (the worker hashes them before each run). */
  modelsPresent: boolean
  /** The Parakeet install's fluidaudiocli is installed, and how it was trusted. */
  cliInstalled: boolean
  cliTrust: string | null
  sandboxExec: boolean
}

export interface SpeakerShadowSnapshot {
  enabled: boolean
  /** Where the switch came from: env pins it, the saved per-Mac setting, or the default (off). */
  source: SpeakerShadowSwitchSource
  state: 'off' | 'idle' | 'queued' | 'running' | 'deferred' | 'breaker_open' | 'no_live_probe'
  queued: number
  runsToday: number
  dailyCap: number
  breaker: { open: boolean; failures: number; until: string | null }
  lastRun: { at: string; status: SpeakerShadowStatus; reason: string | null } | null
  lastError: { at: string; reason: string } | null
  lastErrorDetail?: string | null
  readiness?: SpeakerShadowReadiness
  deferredReason: string | null
}

const WORKER_PATH = fileURLToPath(new URL('./speaker-shadow-worker.ts', import.meta.url))

function defaultSpawnWorker(): ChildProcess {
  const tsx = createRequire(import.meta.url).resolve('tsx/esm')
  return spawn(process.execPath, ['--import', pathToFileURL(tsx).href, WORKER_PATH], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    // The worker needs the data dir to resolve nothing at all (paths arrive in the job), but
    // importing server modules creates DATA_DIR, so point it at the same one.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, COS_DATA_DIR: process.env.COS_DATA_DIR, LANG: process.env.LANG },
  })
}

function defaultSampleRss(pgid: number): Promise<number | null> {
  return new Promise(resolve => {
    execFile('/bin/ps', ['-axo', 'pgid=,rss='], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve(null); return }
      let kb = 0
      for (const line of stdout.split('\n')) {
        const [g, rss] = line.trim().split(/\s+/).map(Number)
        if (g === pgid && Number.isFinite(rss)) kb += rss
      }
      resolve(kb * 1024)
    })
  })
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), new Transform({ transform(chunk, _e, cb) { hash.update(chunk); cb(null) } }))
  return hash.digest('hex')
}

/** The server's own fluidaudiocli: the one the Parakeet install placed and verified. */
async function defaultResolveCli(): Promise<SpeakerShadowCli | null> {
  try {
    if (!parakeetInstalled().installed) return null
    const path = parakeetCliPath()
    if (!(await installedCliIntact(path))) return null
    return { path, sha256: await sha256File(path), trust: installedCliTrust() }
  } catch { return null }
}

export function defaultSpeakerShadowDeps(): SpeakerShadowDeps {
  return {
    env: () => process.env,
    root: speakerShadowRoot,
    now: Date.now,
    captureActive: null,
    admissionsOpen: () => true,
    resolveCli: defaultResolveCli,
    audioDirFor: sessionId => join(speakerShadowRoot(), '..', 'meeting-audio', sessionId.replace(/:/g, '_')),
    modelsDir: () => speakerShadowModelsDir(process.env),
    homeDir: speakerShadowHome,
    sandboxExec: SANDBOX_EXEC,
    tmpRoot: tmpdir(),
    spawnWorker: defaultSpawnWorker,
    sampleRss: defaultSampleRss,
    killGroup: pgid => { try { process.kill(-pgid, 'SIGKILL') } catch { /* gone */ } },
    log: line => console.log(`[speaker-shadow] ${line}`),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    modelsPresent: shadowModelsPresent,
    limits: () => speakerShadowLimits(process.env),
    cliReadiness: () => { try { return { installed: parakeetInstalled().installed, trust: installedCliTrust() } } catch { return { installed: false, trust: null } } },
  }
}

type Supervised = ShadowJobOutcome | { status: 'deferred'; reason: string } | { status: 'failed'; reason: SpeakerShadowRunnerReason; detail: string }

export class SpeakerShadowRunner {
  private readonly deps: SpeakerShadowDeps
  private running: { sessionId: string; pgid: number | null } | null = null
  private pumping = false
  private timer: { unref?: () => void } | null = null
  private deferredReason: string | null = null
  private exitHook = false

  constructor(deps: Partial<SpeakerShadowDeps> = {}) {
    this.deps = { ...defaultSpeakerShadowDeps(), ...deps }
  }

  enabled(): boolean { return speakerShadowEnabled(this.deps.env(), this.deps.root()) }

  switchState(): { enabled: boolean; source: SpeakerShadowSwitchSource } { return resolveSpeakerShadowSwitch(this.deps.env(), this.deps.root()) }

  /** Production wiring: what counts as live meeting work. Until it is set, nothing runs. */
  setCaptureProbe(probe: () => boolean, admissionsOpen?: () => boolean): void {
    this.deps.captureActive = probe
    if (admissionsOpen) this.deps.admissionsOpen = admissionsOpen
  }

  private statePath(): string { return join(this.deps.root(), SPEAKER_SHADOW_STATE) }

  private readState(): ShadowState {
    const day = localDay(this.deps.now())
    let state: ShadowState
    try {
      const parsed = JSON.parse(readFileSyncSafe(this.statePath()) ?? '') as ShadowState
      state = parsed?.schema === 1 && Array.isArray(parsed.queue) ? { ...emptyState(day), ...parsed, done: Array.isArray(parsed.done) ? parsed.done : [] } : emptyState(day)
    } catch { state = emptyState(day) }
    if (state.day !== day) state = { ...state, day, runsToday: 0 }
    return state
  }

  private writeState(state: ShadowState): void {
    mkdirSync(this.deps.root(), { recursive: true, mode: 0o700 })
    state.done = state.done.slice(-500)
    durableAtomicWriteFileSync(this.statePath(), `${JSON.stringify(state, null, 1)}\n`, { mode: 0o600 })
  }

  /**
   * A Mac recording finished finalizing. Never throws and never blocks the caller: the
   * sidecar read and everything after it run in the background.
   */
  notifyFinalized(input: { sessionId: string; sidecarPath: string }): void {
    try {
      if (!this.enabled() || !MAC_CAPTURE_ID.test(input.sessionId)) return
      void this.enqueue(input).catch(error => this.deps.log(`enqueue failed for ${input.sessionId}: ${describe(error)}`))
    } catch (error) {
      this.deps.log(`notify failed: ${describe(error)}`)
    }
  }

  private async enqueue(input: { sessionId: string; sidecarPath: string }): Promise<void> {
    let labelsHash: string | null = null
    try { labelsHash = shadowLabelsHash(shadowEntries(JSON.parse(await readFile(input.sidecarPath, 'utf8')))) } catch { /* the worker reports the sidecar */ }
    // Read, change and write with no await in between: the pump also rewrites this file.
    const state = this.readState()
    if (state.done.includes(input.sessionId) || state.queue.some(q => q.sessionId === input.sessionId)) return
    state.queue.push({ sessionId: input.sessionId, sidecarPath: input.sidecarPath, labelsHash, enqueuedAt: this.deps.now() })
    const dropped = state.queue.splice(0, Math.max(0, state.queue.length - MAX_QUEUE))
    for (const item of dropped) state.done.push(item.sessionId)
    this.writeState(state)
    for (const item of dropped) await this.record(item, 'skipped', 'stale', 'the shadow queue was full')
    this.deps.log(`queued ${input.sessionId}`)
    void this.pump()
  }

  /** Boot: pick up meetings a previous process queued but never ran. */
  resume(): void {
    try {
      if (!this.enabled() || !existsSync(this.statePath())) return
      if (this.readState().queue.length) void this.pump()
    } catch (error) { this.deps.log(`resume failed: ${describe(error)}`) }
  }

  private schedule(ms: number, reason: string): void {
    if (this.deferredReason !== reason) this.deps.log(`deferred: ${reason}`)
    this.deferredReason = reason
    if (this.timer) return
    const t = this.deps.setTimer(() => { this.timer = null; void this.pump() }, ms)
    t.unref?.()
    this.timer = t
  }

  private async record(item: QueueItem, status: SpeakerShadowStatus, reason: string | null, detail: string | null, extra: Partial<SpeakerShadowRecord> = {}): Promise<void> {
    const record: SpeakerShadowRecord = {
      schema: 1, kind: 'speaker_shadow', logOnly: true,
      recordedAt: new Date(this.deps.now()).toISOString(),
      serverVersion: process.env.COS_SERVER_VERSION?.trim() || 'development',
      sessionId: item.sessionId, enqueuedAt: new Date(item.enqueuedAt).toISOString(),
      status, reason, detail, gates: GATES_RECORD, ...extra,
    }
    await appendSpeakerShadowRecord(this.deps.root(), record)
  }

  /**
   * The readable page for one finished meeting, written atomically under reports/<day>/. Every
   * finished meeting gets one: proposals, or a short page saying why there are none. A report
   * that cannot be written is logged and never blocks the record.
   */
  private async writeReport(item: QueueItem, status: SpeakerShadowStatus, reason: string | null, detail: string | null, report?: { title: string; markdown: string }): Promise<string | null> {
    try {
      const title = report?.title ?? await readShadowMeetingTitle(item.sidecarPath)
      const markdown = report?.markdown ?? renderShadowSkipReport({ title, sessionId: item.sessionId, status: status === 'proposed' ? 'skipped' : status, reason, detail })
      const rel = shadowReportRelativePath(title, item.sessionId, shadowMeetingDay(item.sidecarPath) ?? localDay(this.deps.now()))
      const path = join(this.deps.root(), rel)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      durableAtomicWriteFileSync(path, markdown, { mode: 0o600 })
      return rel
    } catch (error) {
      this.deps.log(`report not written for ${item.sessionId}: ${describe(error)}`)
      return null
    }
  }

  /** Runs queued meetings one at a time until the queue is empty or something says wait. */
  async pump(): Promise<void> {
    if (this.pumping || this.running) return
    this.pumping = true
    try {
      for (;;) {
        if (!this.enabled()) return
        const state = this.readState()
        const item = state.queue[0]
        if (!item) { this.deferredReason = null; return }
        const now = this.deps.now()
        const finish = async (status: SpeakerShadowStatus, reason: string | null, detail: string | null, extra: Partial<SpeakerShadowRecord> = {}, report?: { title: string; markdown: string }) => {
          const reportPath = await this.writeReport(item, status, reason, detail, report)
          await this.record(item, status, reason, detail, { ...extra, report: reportPath })
          const next = this.readState()
          next.queue = next.queue.filter(q => q.sessionId !== item.sessionId)
          next.done.push(item.sessionId)
          next.lastRun = { at: this.deps.now(), sessionId: item.sessionId, status, reason }
          if (status === 'failed') {
            next.consecutiveFailures += 1
            next.lastError = { at: this.deps.now(), reason: reason ?? 'failed', detail: (detail ?? '').slice(0, 300) }
            if (next.consecutiveFailures >= SPEAKER_SHADOW_BREAKER_FAILURES) {
              next.breakerUntil = this.deps.now() + SPEAKER_SHADOW_BREAKER_PAUSE_MS
              this.deps.log(`breaker open for 1 h after ${next.consecutiveFailures} failures (last: ${reason})`)
            }
          } else if (status === 'proposed') {
            next.consecutiveFailures = 0
            next.breakerUntil = null
          }
          this.writeState(next)
          this.deps.log(`${status} ${item.sessionId}${reason ? ` (${reason})` : ''}${extra.proposals ? `: ${extra.proposals.productionVoices} voices, ${extra.proposals.acceptedMerges} of ${extra.proposals.proposedMerges} proposed merges pass` : ''}`)
        }

        if (now - item.enqueuedAt > QUEUE_MAX_AGE_MS) { await finish('skipped', 'stale', 'queued for more than 24 hours'); continue }
        if (state.breakerUntil && now < state.breakerUntil) { this.schedule(state.breakerUntil - now, 'breaker_open'); return }
        if (!this.deps.captureActive) { this.schedule(DEFER_RETRY_MS, 'no_live_probe'); return }
        if (this.deps.captureActive() || !this.deps.admissionsOpen()) { this.schedule(DEFER_RETRY_MS, 'live_work'); return }
        const limits = this.deps.limits()
        if (state.runsToday >= limits.dailyRuns) { await finish('skipped', 'daily_cap', `${limits.dailyRuns} runs today`); continue }
        const cli = await this.deps.resolveCli()
        if (!cli) { await finish('skipped', 'cli_missing', 'no verified fluidaudiocli from the Parakeet install'); continue }
        const modelsDir = this.deps.modelsDir()
        if (!this.deps.modelsPresent(modelsDir)) { await finish('skipped', 'models_missing', 'the pinned speaker-diarization models are not on this Mac (the server never downloads them)'); continue }
        const audioDir = this.deps.audioDirFor(item.sessionId)
        if (!existsSync(audioDir)) { await finish('skipped', 'audio_missing', 'no retained chunk audio for this meeting'); continue }

        // Fresh read: the awaits above let an enqueue rewrite the file since `state` was read.
        const counted = this.readState()
        counted.runsToday += 1
        this.writeState(counted)
        this.deferredReason = null
        const job: ShadowJob = {
          sessionId: item.sessionId, sidecarPath: item.sidecarPath, audioDir, expectedLabelsHash: item.labelsHash,
          cliPath: cli.path, cliSha256: cli.sha256, sandboxExec: this.deps.sandboxExec, modelsDir,
          homeDir: this.deps.homeDir(), tmpRoot: this.deps.tmpRoot, cliTimeoutMs: Math.max(5_000, limits.timeoutMs - 5_000),
        }
        this.deps.log(`start ${item.sessionId}`)
        const started = this.deps.now()
        const { outcome, peakRss } = await this.supervise(job, limits)
        const resources = { wallMs: this.deps.now() - started, peakRssBytes: peakRss, cliTrust: cli.trust }
        if (outcome.status === 'deferred') {
          // Not a failure and not a run: the meeting stays at the head of the queue.
          const back = this.readState()
          back.runsToday = Math.max(0, back.runsToday - 1)
          this.writeState(back)
          this.deps.log(`stopped ${item.sessionId}: ${outcome.reason}; it runs again when the live work ends`)
          this.schedule(DEFER_RETRY_MS, outcome.reason)
          return
        }
        if (outcome.status === 'proposed') {
          const f = outcome.facts
          const markdown = `${outcome.report.markdown}\n${renderShadowRunFacts({ rebuildMs: f.timing.rebuildMs, nativeMs: f.timing.nativeMs, wallMs: resources.wallMs, peakRssBytes: resources.peakRssBytes, osTempDirsLeft: f.osTempDirsLeft, sidecarPath: item.sidecarPath, pcmSHA256: f.timelinePCMSHA256, cliTrust: cli.trust })}`
          await finish('proposed', null, null, { facts: outcome.facts, proposals: outcome.proposals, resources }, { title: outcome.report.title, markdown })
        }
        else await finish(outcome.status, outcome.reason, outcome.detail, { resources })
      }
    } catch (error) {
      this.deps.log(`pump failed: ${describe(error)}`)
    } finally {
      this.pumping = false
    }
  }

  private supervise(job: ShadowJob, limits: SpeakerShadowLimits): Promise<{ outcome: Supervised; peakRss: number | null }> {
    return new Promise(resolvePromise => {
      let child: ChildProcess
      try { child = this.deps.spawnWorker() } catch (error) {
        resolvePromise({ outcome: { status: 'failed', reason: 'worker_spawn_failed', detail: describe(error) }, peakRss: null })
        return
      }
      const pgid = child.pid ?? null
      this.running = { sessionId: job.sessionId, pgid }
      this.installExitHook()
      if (pgid) { try { setPriority(pgid, 10) } catch { /* runs at normal priority */ } }
      const started = this.deps.now()
      let stdout = '', stderr = '', verdict: Supervised | null = null, peak: number | null = null, sampling = false, settled = false
      const stop = (outcome: Supervised) => { if (!verdict) verdict = outcome; if (pgid) this.deps.killGroup(pgid) }
      const tick = setInterval(() => {
        if (verdict) return
        if (this.deps.now() - started > limits.timeoutMs) { stop({ status: 'failed', reason: 'timeout', detail: `no result within ${limits.timeoutMs} ms` }); return }
        if (!this.enabled()) { stop({ status: 'deferred', reason: 'switched_off' }); return }
        if (this.deps.captureActive?.() || !this.deps.admissionsOpen()) { stop({ status: 'deferred', reason: 'capture_live' }); return }
        if (!pgid || sampling) return
        sampling = true
        void this.deps.sampleRss(pgid).then(bytes => {
          sampling = false
          if (bytes === null || verdict) return
          peak = Math.max(peak ?? 0, bytes)
          if (bytes > limits.rssBytes) stop({ status: 'failed', reason: 'rss_cap', detail: `the run used ${Math.round(bytes / 1048576)} MB, over the ${Math.round(limits.rssBytes / 1048576)} MB cap` })
        })
      }, SAMPLE_MS)
      tick.unref?.()
      const done = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return
        settled = true
        clearInterval(tick)
        this.running = null
        if (verdict) { resolvePromise({ outcome: verdict, peakRss: peak }); return }
        const line = stdout.trim().split('\n').pop() ?? ''
        try {
          const outcome = JSON.parse(line) as ShadowJobOutcome
          if (outcome && (outcome.status === 'proposed' || outcome.status === 'skipped' || outcome.status === 'failed')) { resolvePromise({ outcome, peakRss: peak }); return }
        } catch { /* below */ }
        resolvePromise({ outcome: { status: 'failed', reason: 'worker_crashed', detail: `worker exit ${code ?? signal}: ${stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 200)}` }, peakRss: peak })
      }
      child.stdout?.on('data', (d: Buffer) => { if (stdout.length < MAX_STDOUT) stdout += d.toString(); else stop({ status: 'failed', reason: 'worker_crashed', detail: 'worker output over 8 MB' }) })
      child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 16_384) stderr += d.toString() })
      child.on('error', error => { stop({ status: 'failed', reason: 'worker_spawn_failed', detail: error.message }); done(null, null) })
      child.on('close', done)
      child.stdin?.on('error', () => { /* a crashed worker closes stdin; close reports it */ })
      child.stdin?.end(JSON.stringify(job))
    })
  }

  private installExitHook(): void {
    if (this.exitHook) return
    this.exitHook = true
    process.once('exit', () => { if (this.running?.pgid) this.deps.killGroup(this.running.pgid) })
  }

  snapshot(options: { detail?: boolean } = {}): SpeakerShadowSnapshot {
    const { enabled, source } = this.switchState()
    const limits = this.deps.limits()
    let state: ShadowState | null = null
    try { if (existsSync(this.statePath())) state = this.readState() } catch { state = null }
    const now = this.deps.now()
    const breakerOpen = !!state?.breakerUntil && now < state.breakerUntil
    const phase: SpeakerShadowSnapshot['state'] = !enabled ? 'off'
      : this.running ? 'running'
      : breakerOpen ? 'breaker_open'
      : !this.deps.captureActive && state?.queue.length ? 'no_live_probe'
      : this.deferredReason && state?.queue.length ? 'deferred'
      : state?.queue.length ? 'queued' : 'idle'
    const readiness = (): SpeakerShadowReadiness => {
      const cli = this.deps.cliReadiness()
      let modelsPresent = false
      try { modelsPresent = this.deps.modelsPresent(this.deps.modelsDir()) } catch { modelsPresent = false }
      return { modelsPresent, cliInstalled: cli.installed, cliTrust: cli.trust, sandboxExec: existsSync(this.deps.sandboxExec) }
    }
    return {
      enabled, source, state: phase,
      queued: state?.queue.length ?? 0,
      runsToday: state && state.day === localDay(now) ? state.runsToday : 0,
      dailyCap: limits.dailyRuns,
      breaker: { open: breakerOpen, failures: state?.consecutiveFailures ?? 0, until: breakerOpen ? new Date(state!.breakerUntil!).toISOString() : null },
      lastRun: state?.lastRun ? { at: new Date(state.lastRun.at).toISOString(), status: state.lastRun.status, reason: state.lastRun.reason } : null,
      lastError: state?.lastError ? { at: new Date(state.lastError.at).toISOString(), reason: state.lastError.reason } : null,
      ...(options.detail ? { lastErrorDetail: state?.lastError?.detail ?? null, readiness: readiness() } : {}),
      deferredReason: this.deferredReason,
    }
  }
}

/** One synchronous read, only for the small state file. */
function readFileSyncSafe(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Server start: temp directories a previous worker left (a SIGKILL skips its cleanup). */
export function sweepStaleSpeakerShadowTmp(root = tmpdir(), minAgeMs = 10 * 60_000, now = Date.now()): number {
  let removed = 0
  try {
    for (const name of readdirSync(root)) {
      if (!name.startsWith(SHADOW_TMP_PREFIX)) continue
      const path = join(root, name)
      try { if (now - statSync(path).mtimeMs >= minAgeMs) { rmSync(path, { recursive: true, force: true }); removed++ } } catch { /* raced */ }
    }
  } catch { /* no tmp root */ }
  return removed
}

// ── Process-wide runner ──────────────────────────────────────────────────────

let shared: SpeakerShadowRunner | null = null
export function getSpeakerShadowRunner(): SpeakerShadowRunner {
  shared ??= new SpeakerShadowRunner()
  return shared
}
export function resetSpeakerShadowRunnerForTests(runner: SpeakerShadowRunner | null = null): void {
  shared = runner
}

/**
 * Leases that mean live meeting or dictation work. The merge engine's CAPTURE_LEASE_KINDS
 * (meeting-actions.ts) plus dictation's draft writes, warms and finalize: dictation runs
 * Parakeet on the same Neural Engine this CLI uses. Pinned against CAPTURE_LEASE_KINDS by test.
 */
export const SPEAKER_SHADOW_LIVE_LEASES = [
  'recording_chunk', 'meeting_save', 'meeting_batch_finalization', 'orphan_recovery', 'one_shot_transcription',
  'prompt_draft_write', 'prompt_draft_warm', 'prompt_draft_finalize',
] as const

export function speakerShadowLeaseActive(activeByKind: () => Record<string, number> = () => maintenanceLifecycle.snapshot().activeByKind as Record<string, number>): boolean {
  const byKind = activeByKind()
  return SPEAKER_SHADOW_LIVE_LEASES.some(kind => (byKind[kind] ?? 0) > 0)
}

/** Server boot: what counts as live work, then the temp sweep and any queue a previous process left. */
export function configureSpeakerShadow(probe: { captureActive: () => boolean; admissionsOpen: () => boolean }): void {
  try {
    const runner = getSpeakerShadowRunner()
    runner.setCaptureProbe(probe.captureActive, probe.admissionsOpen)
    if (!runner.enabled()) return
    const swept = sweepStaleSpeakerShadowTmp()
    if (swept) console.log(`[speaker-shadow] removed ${swept} stale temp dir(s)`)
    console.log('[speaker-shadow] enabled (log only)')
    runner.resume()
  } catch (error) {
    console.warn('[speaker-shadow] configure failed:', describe(error))
  }
}

/** The finalization path's call. Never throws. */
export function notifySpeakerShadowFinalized(input: { sessionId: string; sidecarPath: string }): void {
  try { getSpeakerShadowRunner().notifyFinalized(input) } catch (error) { console.warn('[speaker-shadow] unavailable:', describe(error)) }
}

/**
 * `/api/health`: `speaker_shadow` only while shadow mode is on. Absent, never null, when off, so
 * the public health shape is unchanged by default (pinned by health-6890-parity.test.ts).
 */
export function speakerShadowHealthFields(env: NodeJS.ProcessEnv = process.env, root: string = speakerShadowRoot()): { speaker_shadow?: Omit<SpeakerShadowSnapshot, 'lastErrorDetail' | 'readiness'> } {
  if (!speakerShadowEnabled(env, root)) return {}
  return { speaker_shadow: speakerShadowHealth() }
}

/** For /api/health (codes and counts only, no session ids, paths or error text). */
export function speakerShadowHealth(): Omit<SpeakerShadowSnapshot, 'lastErrorDetail' | 'readiness'> {
  try {
    const { lastErrorDetail: _detail, readiness: _readiness, ...rest } = getSpeakerShadowRunner().snapshot()
    return rest
  } catch {
    return { enabled: false, source: 'default', state: 'off', queued: 0, runsToday: 0, dailyCap: 0, breaker: { open: false, failures: 0, until: null }, lastRun: null, lastError: null, deferredReason: null }
  }
}
