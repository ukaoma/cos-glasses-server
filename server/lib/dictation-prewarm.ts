import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveProviderBinary } from './provider-binary.js'
import { terminateProviderProcess } from './provider-process-lifecycle.js'
import {
  buildDictationPolishPrompt, claudePolishArgs, dictationChildEnv, dictationPolishPromptVersion,
  type DictationPolishPromptVersion,
} from './dictation-clean.js'

/**
 * 6.79.2: start the polish Claude process when dictation starts, not when it ends.
 *
 * About 70% of a polish is the CLI's own start (measured on Miles's Mac: cold polish 1.8 to
 * 1.9 s; the same process started 3 s earlier answered 1.0 to 1.3 s after the text arrived).
 * A warm process is the exact polish process (same args, no tools, MCP, hooks or session
 * file, its own empty workspace) in stream-json input mode, waiting for ONE user message.
 * It gets that message, answers, and its stdin is closed at once, so it exits: no history
 * ever carries into another dictation.
 *
 * Bounded: at most PREWARM_MAX live (a new one evicts the oldest), each killed after
 * PREWARM_TTL_MS unused, killed when finalize decides not to call the model, and killed
 * with the server. A warm process costs no model call until a message is written, so the
 * daily polish budget is spent only when it is used.
 */
export const PREWARM_TTL_MS = 150_000
export const PREWARM_MAX = 2
export const PREWARM_MODELS = ['haiku', 'sonnet'] as const
export type PrewarmModel = typeof PREWARM_MODELS[number]

export class PrewarmUnavailableError extends Error {}

interface WarmPolish {
  token: string
  model: PrewarmModel
  version: DictationPolishPromptVersion
  proc: ChildProcess
  scratch: string
  exited: boolean
  timer: NodeJS.Timeout
  onResult: ((event: any) => void) | null
  onExit: (() => void) | null
}

/** Unclaimed warm processes, by token. */
const warm = new Map<string, WarmPolish>()
/** Every process not yet exited, claimed or not: what the server kills on its way out. */
const alive = new Set<WarmPolish>()

export function prewarmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['0', 'false', 'off'].includes((env.COS_DICTATION_PREWARM ?? '').trim().toLowerCase())
}

export function isPrewarmModel(model: unknown): model is PrewarmModel {
  return typeof model === 'string' && (PREWARM_MODELS as readonly string[]).includes(model)
}

export function livePrewarmCount(): number {
  return warm.size
}

function retire(entry: WarmPolish): void {
  warm.delete(entry.token)
  clearTimeout(entry.timer)
  if (!entry.exited) void terminateProviderProcess(entry.proc).catch(() => {})
}

export function startPolishPrewarm(model: PrewarmModel): { token: string; expiresMs: number } {
  const binary = resolveProviderBinary('claude')
  if (!binary.ok) throw new PrewarmUnavailableError('Dictation cleanup Claude CLI unavailable')
  while (warm.size >= PREWARM_MAX) retire(warm.values().next().value!)
  const version = dictationPolishPromptVersion()
  const scratch = mkdtempSync(join(tmpdir(), 'cos-dictation-prewarm-'))
  const workspace = join(scratch, 'workspace')
  mkdirSync(workspace, { mode: 0o700 })
  const proc = spawn(binary.path, claudePolishArgs(model, version, 'stream'), {
    stdio: ['pipe', 'pipe', 'pipe'], env: dictationChildEnv(binary.path), cwd: workspace, detached: true,
  })
  const token = randomUUID()
  const entry: WarmPolish = {
    token, model, version, proc, scratch, exited: false, onResult: null, onExit: null,
    timer: setTimeout(() => retire(entry), PREWARM_TTL_MS),
  }
  entry.timer.unref?.()
  let buffer = ''
  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    if (buffer.length > 256_000) { retire(entry); return }
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let event: any
      try { event = JSON.parse(line) } catch { continue }
      if (event?.type === 'result') entry.onResult?.(event)
    }
  })
  // Do not log provider stderr: it can contain login or dictation data.
  proc.stderr?.resume()
  proc.stdin?.on('error', () => {})
  const exited = () => {
    if (entry.exited) return
    entry.exited = true
    warm.delete(token)
    alive.delete(entry)
    clearTimeout(entry.timer)
    rmSync(scratch, { recursive: true, force: true })
    entry.onExit?.()
  }
  proc.on('error', exited)
  proc.on('close', exited)
  warm.set(token, entry)
  alive.add(entry)
  return { token, expiresMs: PREWARM_TTL_MS }
}

/** Kill a warm process nobody will use (finalize skipped the model, or the press was cancelled). */
export function discardPolishPrewarm(token: string | undefined): boolean {
  const entry = token ? warm.get(token) : undefined
  if (!entry) return false
  retire(entry)
  return true
}

/** One use: the entry leaves the pool whether or not it matches. A model mismatch kills it. */
export function takePolishPrewarm(token: string | undefined, model: string): WarmPolish | null {
  const entry = token ? warm.get(token) : undefined
  if (!entry) return null
  warm.delete(entry.token)
  if (entry.model !== model || entry.exited) { retire(entry); return null }
  return entry
}

/**
 * Write the one message and read the one result. PrewarmUnavailableError means nothing was
 * sent (the process had already gone), so the caller may spawn cold. Any later failure means
 * the model may have run, so it is a real polish failure.
 */
export async function runWarmPolish(
  entry: WarmPolish,
  text: string,
  terms: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  if (entry.exited || !entry.proc.stdin || entry.proc.stdin.destroyed) {
    retire(entry)
    throw new PrewarmUnavailableError('Warm polish process already exited')
  }
  if (opts.signal?.aborted) { retire(entry); throw new Error('Auto-clean aborted') }
  clearTimeout(entry.timer)
  const configuredTimeout = Number.parseInt(process.env.COS_DICTATION_AUTOCLEAN_TIMEOUT_MS || '20000', 10)
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 20_000
  return await new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, output?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', abort)
      entry.onResult = null
      entry.onExit = null
      // Exactly one message: once it is answered (or abandoned) the process must go.
      retire(entry)
      if (error) reject(error); else resolve(output!)
    }
    const abort = () => finish(new Error('Auto-clean aborted'))
    const timer = setTimeout(() => finish(new Error(`Auto-clean timed out (${timeoutMs}ms)`)), timeoutMs)
    entry.onResult = (event) => {
      if (event.subtype !== 'success' || event.is_error || typeof event.result !== 'string') {
        return finish(new Error('Warm polish returned an unsuccessful result'))
      }
      const output = event.result.trim()
      if (!output) return finish(new Error('Auto-clean returned empty text'))
      finish(undefined, output)
    }
    entry.onExit = () => finish(new Error('Warm polish process exited without a result'))
    opts.signal?.addEventListener('abort', abort, { once: true })
    const message = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: buildDictationPolishPrompt(text, terms, entry.version) },
    })
    try {
      entry.proc.stdin!.write(message + '\n')
      entry.proc.stdin!.end()
    } catch {
      finish(new Error('Auto-clean input failed'))
    }
  })
}

/** The server is going away: a detached warm process would outlive it. */
export function killAllPrewarmsSync(): void {
  for (const entry of alive) {
    try { if (entry.proc.pid) process.kill(-entry.proc.pid, 'SIGTERM') } catch {}
    // No close event will run before the server is gone, so its workspace goes now.
    try { rmSync(entry.scratch, { recursive: true, force: true }) } catch {}
  }
  warm.clear()
  alive.clear()
}
process.once('exit', killAllPrewarmsSync)

export function _resetPrewarmsForTest(): void {
  for (const entry of [...alive]) retire(entry)
  warm.clear()
}
