// Speaker shadow mode (6.95.0): one meeting's proposal run, in its own child process.
//
// The server never runs this on its event loop. speaker-shadow.ts starts it as a niced
// child (`node --import tsx/esm speaker-shadow-worker.ts`), sends one job on stdin, and
// reads exactly one JSON outcome line from stdout. The parent owns the wall clock and the
// RSS cap and kills the whole process group; this side also stops the CLI on its own
// deadline and exits if its parent goes away.
//
// READ ONLY, LOG ONLY. Reads the finalized sidecar and the retained chunk WAVs; writes
// only a private temp directory (the timeline WAV and the CLI's two JSON outputs), which
// is removed before the outcome is printed. No meeting file, label, name, profile,
// embedding cache or correction ledger is opened for writing anywhere in this file.
//
// The CLI is FluidAudio 0.17.4 `process --mode offline --overlapping-segments
// --export-embeddings`, the exact invocation of round3/propose.py, run through
// sandbox-exec with network denied (the Parakeet profile: writes only to the temp dir,
// the private HOME and the per-user temp dir NSTemporaryDirectory uses).

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { darwinUserTempDir, parakeetChildEnv, parakeetSandboxProfile } from './parakeet.js'
import {
  SHADOW_GATES, SHADOW_SAMPLE_RATE, buildShadowProposals, decide, nativeTurns,
  type ShadowEmbeddingRow, type ShadowProposals,
} from './speaker-shadow-decide.js'
import { SHADOW_MODEL_REPO, SHADOW_MODEL_REVISION, prepareShadowHome, verifyShadowModels, type ShadowModelCheck } from './speaker-shadow-models.js'
import {
  ShadowInputError, buildShadowTimeline, pcm16WavFile, readShadowMeetingTitle, shadowEntries, shadowHumanProtectedVoices,
  shadowLabelsHash, shadowProductionSegments,
} from './speaker-shadow-timeline.js'
import { renderShadowReport } from './speaker-shadow-report.js'
import { pyRound } from './speaker-shadow-numeric.js'

export const SHADOW_TMP_PREFIX = 'cos-speaker-shadow-'
/** The CLI's flags, verbatim from round3/propose.py (via scripts/guard.py). */
export const SHADOW_CLI_FLAGS = ['--mode', 'offline', '--overlapping-segments'] as const

export interface ShadowJob {
  sessionId: string
  sidecarPath: string
  /** The retained chunk WAV directory (`<data>/meeting-audio/<session>`). */
  audioDir: string
  /** The labels hash recorded when the meeting finalized; a different one now means a person edited it. */
  expectedLabelsHash: string | null
  cliPath: string
  /** SHA-256 the parent verified for cliPath; re-checked here before the run. */
  cliSha256: string
  sandboxExec: string
  modelsDir: string
  homeDir: string
  tmpRoot: string
  cliTimeoutMs: number
}

export type ShadowSkipReason =
  | 'not_finalized' | 'labels_changed' | 'no_voices' | 'audio_missing' | 'audio_drift' | 'audio_format'
  | 'bad_sidecar' | 'too_long' | 'models_missing' | 'models_mismatch' | 'cli_changed'
export type ShadowFailReason = 'cli_timeout' | 'cli_failed' | 'cli_unsupported' | 'bad_cli_output' | 'sandbox_unavailable' | 'internal'

export interface ShadowRunFacts {
  minutes: number
  originals: number
  verifiedAgainstSidecar: number
  unhashedOriginals: number
  unhashedWithText: number[]
  timelinePCMSHA256: string
  timelineWAVSHA256: string
  labelsHash: string
  clippedTurns: number
  humanProtectedVoices: string[]
  /**
   * Empty `NSIRD_fluidaudiocli_*` OS temp dirs that appeared during the run and are still
   * there. A cold CoreML cache leaves up to four (MPSGraph staging); warm runs leave none.
   * Counted, never removed: the server cannot prove a dir in the shared temp folder is its own.
   */
  osTempDirsLeft: number
  timing: { rebuildMs: number; nativeMs: number; totalMs: number }
  tool: { cliSha256: string; flags: string[]; modelRepo: string; modelRevision: string; modelBytes: number }
}

export type ShadowJobOutcome =
  | { status: 'proposed'; facts: ShadowRunFacts; proposals: ShadowProposals; report: { title: string; markdown: string } }
  | { status: 'skipped'; reason: ShadowSkipReason; detail: string }
  | { status: 'failed'; reason: ShadowFailReason; detail: string }

type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess

export interface ShadowWorkerDeps {
  spawn?: SpawnLike
  now?: () => number
  /** Aborts the CLI (the parent went away). */
  signal?: AbortSignal
  /** Tests only (the fake-CLI integration worker): real model bytes cannot be faked. */
  verifyModels?: (dir: string) => Promise<ShadowModelCheck>
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), new Transform({ transform(chunk, _e, cb) { hash.update(chunk); cb(null) } }))
  return hash.digest('hex')
}

/** Foundation's item-replacement dirs for this CLI, in the per-user temp folder. Read only. */
function nsirdDirs(): Set<string> {
  const root = darwinUserTempDir()
  if (!root) return new Set()
  try { return new Set(readdirSync(join(root, 'TemporaryItems')).filter(name => name.startsWith('NSIRD_fluidaudiocli_'))) } catch { return new Set() }
}

const skip = (reason: ShadowSkipReason, detail: string): ShadowJobOutcome => ({ status: 'skipped', reason, detail })
const fail = (reason: ShadowFailReason, detail: string): ShadowJobOutcome => ({ status: 'failed', reason, detail: detail.slice(0, 300) })

function runCli(job: ShadowJob, wavPath: string, nativePath: string, embPath: string, work: string, deps: ShadowWorkerDeps): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; timedOut: boolean; error?: string }> {
  const args = ['-p', parakeetSandboxProfile(work, job.homeDir), job.cliPath, 'process', wavPath, '--mode', 'offline', '--output', nativePath, '--overlapping-segments', '--export-embeddings', embPath]
  return new Promise(resolvePromise => {
    let child: ChildProcess
    try {
      child = (deps.spawn ?? (spawn as unknown as SpawnLike))(job.sandboxExec, args, { stdio: ['ignore', 'ignore', 'pipe'], env: parakeetChildEnv(job.homeDir, work) })
    } catch (error) {
      resolvePromise({ code: null, signal: null, stderr: '', timedOut: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    let stderr = '', timedOut = false, settled = false
    const done = (value: Parameters<typeof resolvePromise>[0]) => { if (settled) return; settled = true; clearTimeout(timer); deps.signal?.removeEventListener('abort', onAbort); resolvePromise(value) }
    const kill = () => { try { child.kill('SIGKILL') } catch { /* gone */ } }
    // SIGKILL: CoreML work does not stop for TERM.
    const timer = setTimeout(() => { timedOut = true; kill() }, job.cliTimeoutMs)
    const onAbort = () => kill()
    deps.signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 65_536) stderr += d.toString() })
    child.on('error', error => done({ code: null, signal: null, stderr, timedOut, error: error.message }))
    child.on('close', (code, signal) => done({ code, signal, stderr, timedOut }))
  })
}

/** One meeting. Never throws: every path ends in an outcome, and the temp dir is always removed. */
export async function runShadowJob(job: ShadowJob, deps: ShadowWorkerDeps = {}): Promise<ShadowJobOutcome> {
  const now = deps.now ?? Date.now
  const started = now()
  let work: string | null = null
  try {
    // 1. The finalized meeting, unchanged since it finalized.
    let sidecar: Record<string, unknown>
    try { sidecar = JSON.parse(await readFile(job.sidecarPath, 'utf8')) } catch { return skip('bad_sidecar', 'the sidecar is missing or unreadable') }
    if (sidecar.sessionId !== job.sessionId) return skip('bad_sidecar', 'the sidecar belongs to another session')
    if (sidecar.finalizationState !== 'complete') return skip('not_finalized', `finalizationState=${String(sidecar.finalizationState)}`)
    const entries = shadowEntries(sidecar)
    const labelsHash = shadowLabelsHash(entries)
    if (job.expectedLabelsHash && labelsHash !== job.expectedLabelsHash) return skip('labels_changed', 'labels changed after the meeting finalized (a correction landed first)')
    const missing = entries.filter(e => !existsSync(join(job.audioDir, `chunk_${String(e.chunkIndex).padStart(4, '0')}.wav`))).length
    if (missing) return skip('audio_missing', `${missing} original chunk WAVs missing`)

    // 2. Models and CLI, verified now rather than trusted from the scheduler's look.
    const models = await (deps.verifyModels ?? verifyShadowModels)(job.modelsDir)
    if (!models.ok) return skip(models.reason, models.detail)
    if (!existsSync(job.cliPath) || await sha256File(job.cliPath) !== job.cliSha256) return skip('cli_changed', 'the FluidAudio CLI changed since it was verified')
    if (!existsSync(job.sandboxExec)) return fail('sandbox_unavailable', 'sandbox-exec is missing, so the CLI cannot be proven offline and does not run')

    // 3. The timeline, then the production segments on it.
    const timeline = await buildShadowTimeline(entries, idx => join(job.audioDir, `chunk_${String(idx).padStart(4, '0')}.wav`))
    const { segs, sources } = shadowProductionSegments(entries, timeline.rows, timeline.total)
    if (!segs.length) return skip('no_voices', 'no production segments to compare')
    const wav = pcm16WavFile(timeline.pcm)
    const rebuildMs = now() - started

    work = mkdtempSync(join(job.tmpRoot, SHADOW_TMP_PREFIX))
    const wavPath = join(work, 'timeline.wav'), nativePath = join(work, 'native.json'), embPath = join(work, 'embeddings.json')
    await writeFile(wavPath, wav, { mode: 0o600, flag: 'wx' })
    const timelineWAVSHA256 = createHash('sha256').update(wav).digest('hex')
    prepareShadowHome(job.homeDir, models.dir)

    // 4. One offline diarization.
    const nativeStarted = now()
    const nsirdBefore = nsirdDirs()
    const run = await runCli(job, wavPath, nativePath, embPath, work, deps)
    const nativeMs = now() - nativeStarted
    const osTempDirsLeft = [...nsirdDirs()].filter(name => !nsirdBefore.has(name)).length
    if (run.timedOut) return fail('cli_timeout', `no result within ${job.cliTimeoutMs} ms`)
    if (run.error) return fail('cli_failed', `spawn: ${run.error}`)
    const tail = run.stderr.trim().split('\n').slice(-2).join(' | ')
    if (/Unknown option|unexpected argument|Unrecognized/i.test(run.stderr)) return fail('cli_unsupported', `the CLI rejected an option: ${tail}`)
    if (run.code !== 0) return fail('cli_failed', `exit ${run.code ?? run.signal}: ${tail}`)

    let native: { segments?: unknown }, emb: unknown
    try {
      native = JSON.parse(await readFile(nativePath, 'utf8'))
      emb = JSON.parse(await readFile(embPath, 'utf8'))
    } catch (error) { return fail('bad_cli_output', `unreadable output: ${error instanceof Error ? error.message : String(error)}`) }
    if (!Array.isArray(native.segments) || !Array.isArray(emb)) return fail('bad_cli_output', 'the CLI output has no segments or embeddings')

    // 5. The gates, exactly as the research tool applies them.
    let proposals: ShadowProposals, clipped: number
    try {
      const turns = nativeTurns(native.segments as Array<{ speakerId: unknown; startTimeSeconds: unknown; endTimeSeconds: unknown }>, timeline.total / SHADOW_SAMPLE_RATE)
      clipped = turns.clipped
      for (const row of emb as ShadowEmbeddingRow[]) {
        if (!row || typeof row.startTime !== 'number' || typeof row.endTime !== 'number' || !Array.isArray(row.embedding256) || row.embedding256.length !== 256) throw new Error('bad embedding row')
      }
      const D = decide(segs, timeline.total, turns.turns, emb as ShadowEmbeddingRow[], SHADOW_GATES.floorSeconds, SHADOW_GATES.majority)
      proposals = buildShadowProposals(D, segs, sources, turns.turns)
    } catch (error) { return fail('bad_cli_output', error instanceof Error ? error.message : String(error)) }

    const humanProtectedVoices = shadowHumanProtectedVoices(entries)
    const facts: ShadowRunFacts = {
      minutes: pyRound(timeline.total / SHADOW_SAMPLE_RATE / 60, 1),
      originals: entries.length,
      verifiedAgainstSidecar: timeline.verified,
      unhashedOriginals: timeline.unhashed,
      unhashedWithText: timeline.unhashedWithText,
      timelinePCMSHA256: timeline.pcmSHA256,
      timelineWAVSHA256,
      labelsHash,
      clippedTurns: clipped,
      humanProtectedVoices,
      osTempDirsLeft,
      timing: { rebuildMs, nativeMs, totalMs: now() - started },
      tool: { cliSha256: job.cliSha256, flags: [...SHADOW_CLI_FLAGS, '--export-embeddings'], modelRepo: SHADOW_MODEL_REPO, modelRevision: SHADOW_MODEL_REVISION, modelBytes: models.bytes },
    }
    const title = await readShadowMeetingTitle(job.sidecarPath)
    const chunkText = new Map(entries.map(e => [e.chunkIndex, typeof e.chunk.text === 'string' ? e.chunk.text : '']))
    const markdown = renderShadowReport({ title, sessionId: job.sessionId, proposals, facts, audioDir: job.audioDir, chunkText })
    return { status: 'proposed', proposals, facts, report: { title, markdown } }
  } catch (error) {
    if (error instanceof ShadowInputError) return skip(error.reason, error.message)
    return fail('internal', error instanceof Error ? error.message : String(error))
  } finally {
    if (work) { try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort; swept at boot */ } }
  }
}

// ── Child process entry ──────────────────────────────────────────────────────

async function readStdin(limit = 64 * 1024): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) {
    text += chunk.toString()
    if (text.length > limit) throw new Error('job too large')
  }
  return text
}

/** The child's whole life: one job in on stdin, one outcome line out on stdout. */
export async function workerMain(deps: Omit<ShadowWorkerDeps, 'signal'> = {}): Promise<void> {
  const controller = new AbortController()
  const parent = process.ppid
  // A parent that died (or was SIGKILLed with its group spared) must not leave this running.
  const watch = setInterval(() => { if (process.ppid !== parent) { controller.abort(); process.exit(3) } }, 1_000)
  watch.unref()
  let outcome: ShadowJobOutcome
  try {
    const job = JSON.parse(await readStdin()) as ShadowJob
    outcome = await runShadowJob(job, { ...deps, signal: controller.signal })
  } catch (error) {
    outcome = fail('internal', error instanceof Error ? error.message : String(error))
  }
  process.stdout.write(`${JSON.stringify(outcome)}\n`, () => process.exit(0))
}

function isEntry(): boolean {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}
if (isEntry()) void workerMain()
