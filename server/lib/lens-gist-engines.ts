// The engines behind the lens gist (lens-gist.ts): one text-in, text-out call each, with
// no session, no history, no tools and no MCP servers. Every runner rejects on any failure
// so the caller can count it against that engine's breaker and the phone keeps its
// verbatim card.
//
// Measured 2026-09-25 on one real session reply (operations/personal/wk39_2026 in the COS
// repo, lens_gist_engine_measurements): Claude Sonnet with the tools off answered in 2.3 s
// on about 1k tokens; the same call WITHOUT `--tools ""` created a 26.5k-token cache of
// tool definitions it never used. Cursor's agent carries about 17k tokens of its own
// harness on every call. Codex loads every MCP server in ~/.codex/config.toml unless the
// user config is ignored (an unauthenticated one failed the call).

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveProviderBinary } from './provider-binary.js'
import { getOllamaCatalog, ollamaFetch, resolveOllamaOrigin } from './ollama-catalog.js'

export type LensGistEngineName = 'claude' | 'codex' | 'cursor' | 'ollama'

export interface LensGistUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  costUsd?: number
}

export interface LensGistEngineRun {
  text: string
  usage?: LensGistUsage
  /** The model the engine reports it ran, when it says. */
  model?: string
}

export interface LensGistRunOptions {
  timeoutMs: number
  system: string
}

/** Replaces Claude Code's own system prompt, so the call carries none of it. */
export const LENS_GIST_SYSTEM_PROMPT = 'You write three-line summaries for a smart-glasses card. Output only the lines asked for.'

/** An API key never reaches a log or a response, whichever provider echoed it. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_*.-]{6,}/g, 'sk-REDACTED')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1REDACTED')
}

/** An empty directory for the agents that insist on a workspace: nothing in it to read. */
function scratchWorkspace(): string {
  const dir = join(tmpdir(), 'cos-lens-gist')
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch { /* the spawn reports it */ }
  return dir
}

function childEnv(binary: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.CLAUDECODE
  // A launchd- or Finder-spawned server has a minimal PATH, and `claude` is a node script:
  // resolving the binary is not enough, its interpreter must be findable too.
  const dirs = [dirname(binary), '/opt/homebrew/bin', '/usr/local/bin']
  const path = env.PATH ?? ''
  env.PATH = [...dirs.filter(dir => !path.split(':').includes(dir)), path].filter(Boolean).join(':')
  return env
}

interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Spawn, write the prompt to stdin, collect both streams; SIGTERM then SIGKILL on timeout. */
export function runProcess(
  binary: string,
  args: string[],
  opts: { stdin: string; cwd: string; timeoutMs: number; label: string },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let killTimer: NodeJS.Timeout | null = null
    const proc = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(binary), cwd: opts.cwd })
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const terminate = () => {
      try { proc.kill('SIGTERM') } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* already gone */ } }, 2_000)
      killTimer.unref?.()
    }
    const timer = setTimeout(() => finish(() => {
      terminate()
      reject(new Error(`${opts.label} timed out after ${opts.timeoutMs} ms${stderr ? `: ${redactSecrets(stderr.slice(-200))}` : ''}`))
    }), opts.timeoutMs)
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', err => finish(() => reject(err)))
    proc.on('close', code => {
      if (killTimer) clearTimeout(killTimer)
      finish(() => resolve({ code, stdout, stderr }))
    })
    proc.stdin.on('error', err => finish(() => { terminate(); reject(err) }))
    try {
      proc.stdin.end(opts.stdin)
    } catch (err) {
      finish(() => { terminate(); reject(err instanceof Error ? err : new Error(String(err))) })
    }
  })
}

function binaryFor(provider: 'claude' | 'codex' | 'cursor'): string {
  const resolved = resolveProviderBinary(provider)
  if (!resolved.ok) throw new Error(`${provider} binary not found (${resolved.detail})`)
  return resolved.path
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function lastJsonObject(stdout: string): any {
  const lines = stdout.trim().split('\n').reverse()
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try { return JSON.parse(trimmed) } catch { /* keep looking */ }
  }
  throw new Error('no JSON result in the output')
}

// --- Claude ---------------------------------------------------------------------------

export function buildClaudeGistArgs(model: string, system: string): string[] {
  return [
    '-p', '--model', model, '--effort', 'low',
    // The measured difference between 1k and 27.5k tokens a call.
    '--tools', '',
    '--output-format', 'json', '--no-session-persistence',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--system-prompt', system,
  ]
}

/** `claude -p --output-format json`: one result object. */
export function parseClaudeGistOutput(stdout: string): LensGistEngineRun {
  const result = lastJsonObject(stdout)
  if (result?.is_error || (result?.subtype && result.subtype !== 'success')) {
    throw new Error(`claude: ${redactSecrets(String(result?.result ?? result?.subtype ?? 'error')).slice(0, 200)}`)
  }
  const text = typeof result?.result === 'string' ? result.result : ''
  const usage = result?.usage ?? {}
  const cacheIn = (num(usage.cache_creation_input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0)
  // `sonnet` is an alias; modelUsage names what it resolved to.
  const resolved = result?.modelUsage && typeof result.modelUsage === 'object' ? Object.keys(result.modelUsage)[0] : undefined
  return {
    text,
    ...(resolved ? { model: resolved } : {}),
    usage: {
      inputTokens: (num(usage.input_tokens) ?? 0) + cacheIn,
      cachedInputTokens: num(usage.cache_read_input_tokens),
      outputTokens: num(usage.output_tokens),
      costUsd: num(result?.total_cost_usd),
    },
  }
}

// --- Codex ----------------------------------------------------------------------------

export function buildCodexGistArgs(model: string, workspace: string): string[] {
  return [
    'exec',
    // No MCP servers, no profile, no user instructions: the one call that must not fail
    // because an unrelated server needs a login.
    '--ignore-user-config',
    '--sandbox', 'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--json',
    '--cd', workspace,
    '--model', model,
    '-c', 'model_reasoning_effort="low"',
    '-',
  ]
}

/** `codex exec --json`: JSON lines; the answer is the last agent message. */
export function parseCodexGistOutput(stdout: string): LensGistEngineRun {
  let text = ''
  let usage: LensGistUsage | undefined
  let failure = ''
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event: any
    try { event = JSON.parse(trimmed) } catch { continue }
    const item = event?.item
    if (event?.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') text = item.text
    if (event?.type === 'turn.completed') {
      const u = event.usage ?? {}
      usage = { inputTokens: num(u.input_tokens), cachedInputTokens: num(u.cached_input_tokens), outputTokens: num(u.output_tokens) }
    }
    if (event?.type === 'turn.failed') failure = String(event?.error?.message ?? 'turn failed')
  }
  if (failure) throw new Error(`codex: ${redactSecrets(failure).slice(0, 200)}`)
  return { text, usage }
}

// --- Cursor ---------------------------------------------------------------------------

export function buildCursorGistArgs(model: string, workspace: string): string[] {
  // Ask mode is read-only; the workspace is an empty directory, so there is nothing to read.
  return ['-p', '--mode', 'ask', '--model', model, '--output-format', 'json', '--trust', '--workspace', workspace]
}

/** `agent -p --output-format json`: one result object. */
export function parseCursorGistOutput(stdout: string): LensGistEngineRun {
  const result = lastJsonObject(stdout)
  if (result?.is_error || (result?.subtype && result.subtype !== 'success')) {
    throw new Error(`cursor: ${redactSecrets(String(result?.result ?? result?.subtype ?? 'error')).slice(0, 200)}`)
  }
  const usage = result?.usage ?? {}
  return {
    text: typeof result?.result === 'string' ? result.result : '',
    usage: {
      inputTokens: num(usage.inputTokens) ?? num(usage.input_tokens),
      outputTokens: num(usage.outputTokens) ?? num(usage.output_tokens),
      cachedInputTokens: num(usage.cacheReadTokens) ?? num(usage.cache_read_input_tokens),
    },
  }
}

// --- Dispatch -------------------------------------------------------------------------

function failedExit(label: string, result: ProcessResult): Error {
  const detail = redactSecrets((result.stderr.trim() || result.stdout.trim()).split('\n').slice(-3).join(' ')).slice(0, 240)
  return new Error(`${label} exited ${result.code ?? 'by signal'}${detail ? `: ${detail}` : ''}`)
}

async function runCli(
  provider: 'claude' | 'codex' | 'cursor',
  args: string[],
  prompt: string,
  opts: LensGistRunOptions,
  parse: (stdout: string) => LensGistEngineRun,
): Promise<LensGistEngineRun> {
  const binary = binaryFor(provider)
  const result = await runProcess(binary, args, { stdin: prompt, cwd: scratchWorkspace(), timeoutMs: opts.timeoutMs, label: provider })
  // Codex reports its failure as a JSON event AND a non-zero exit; the event says why.
  if (result.code !== 0) {
    if (provider === 'codex') parse(result.stdout)
    throw failedExit(provider, result)
  }
  const run = parse(result.stdout)
  if (!run.text.trim()) throw new Error(`${provider} returned no text`)
  return run
}

async function runOllama(model: string, prompt: string, opts: LensGistRunOptions): Promise<LensGistEngineRun> {
  const origin = resolveOllamaOrigin()
  if (!origin.ok) throw new Error(`ollama: ${origin.error}`)
  const chosen = model || (await getOllamaCatalog()).model
  if (!chosen) throw new Error('ollama: no local model installed')
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs)
  try {
    const response = await ollamaFetch(`${origin.origin}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: chosen,
        system: opts.system,
        prompt,
        stream: false,
        think: false,
        // Loading a 27B model cold took 14 s of a 16.5 s call; kept warm it answered in 2.5 s.
        keep_alive: '30m',
        options: { temperature: 0.2, num_predict: 200 },
      }),
      signal: abort.signal,
    })
    if (!response.ok) throw new Error(`ollama answered ${response.status}`)
    const body = await response.json() as any
    const text = typeof body?.response === 'string' ? body.response : ''
    if (!text.trim()) throw new Error('ollama returned no text')
    return { text, model: chosen, usage: { inputTokens: num(body?.prompt_eval_count), outputTokens: num(body?.eval_count) } }
  } catch (err) {
    if (abort.signal.aborted) throw new Error(`ollama timed out after ${opts.timeoutMs} ms`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export async function runLensGistEngine(
  engine: LensGistEngineName,
  model: string,
  prompt: string,
  opts: LensGistRunOptions,
): Promise<LensGistEngineRun> {
  switch (engine) {
    case 'claude':
      return runCli('claude', buildClaudeGistArgs(model, opts.system), prompt, opts, parseClaudeGistOutput)
    case 'codex':
      return runCli('codex', buildCodexGistArgs(model, scratchWorkspace()), prompt, opts, parseCodexGistOutput)
    case 'cursor':
      return runCli('cursor', buildCursorGistArgs(model, scratchWorkspace()), prompt, opts, parseCursorGistOutput)
    case 'ollama':
      return runOllama(model, prompt, opts)
  }
}
