// The engines behind the lens gist (lens-gist.ts): one text-in, text-out call each, with no
// session, no history and no MCP servers, in an empty workspace made for the call and
// removed after it. Every runner rejects on any failure so the caller can count it against
// that engine's breaker and the phone keeps its verbatim card.
//
// WHAT EACH ENGINE CAN STILL DO (the reply is untrusted text: a web page an agent quoted
// can carry instructions, /qa round 1 B1):
//   claude  no tools at all (`--tools ""`), no hooks (`disableAllHooks`).
//   codex   its shell, browser, computer-use, app and plugin tools disabled, web search
//           off, no user config and no rules files.
//   cursor  ask mode, which is read-only but keeps its read tools; the CLI has no switch to
//           remove them. It reads an empty workspace, and what it answers is redacted.
//   ollama  a bare completion: no tools.
//
// Measured 2026-09-25 (operations/personal/wk39_2026 in the COS repo): Claude Sonnet with the
// tools off answered in 2.3 to 3.7 s on about 1.2k tokens; Claude Haiku with the flags the
// dictation cleaner ships (no `--tools ""`) wrote a 26.5k-token cache of tool definitions.
// Cursor's agent carries 13 to 17k tokens of its own harness on every call.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveProviderBinary } from './provider-binary.js'
import { getOllamaCatalog, ollamaFetch, resolveOllamaOrigin } from './ollama-catalog.js'
import { logTokenAudit } from './token-audit.js'

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

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key]'],
  [/\bsk-[A-Za-z0-9_*.-]{6,}/g, 'sk-REDACTED'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1REDACTED'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, 'gh-REDACTED'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'gh-REDACTED'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, 'xox-REDACTED'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AWS-REDACTED'],
  [/\bpat-(?:na|eu|ap)\d-[0-9a-f-]{20,}\b/gi, 'pat-REDACTED'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'jwt-REDACTED'],
]

/** A key or token never reaches a log, the cache or the lens, whichever side echoed it. */
export function redactSecrets(text: string): string {
  let out = text
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to)
  const own = process.env.COS_API_TOKEN
  if (own && own.length >= 12) out = out.split(own).join('COS-TOKEN-REDACTED')
  return out
}

/** A fresh, private, empty directory for one call: nothing planted in it, nothing to read. */
function withScratchWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'cos-lens-gist-'))
  return fn(dir).finally(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  })
}

/** Nothing the server itself holds reaches a model's process. */
const STRIPPED_ENV = ['CLAUDECODE', 'COS_API_TOKEN']

export function lensGistChildEnv(binary: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of STRIPPED_ENV) delete env[key]
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
    const proc = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: lensGistChildEnv(binary), cwd: opts.cwd })
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
    // No tools: nothing to act on an instruction hidden in the reply, and ~1.2k tokens a
    // call instead of a cache of tool definitions.
    '--tools', '',
    '--output-format', 'json', '--no-session-persistence',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    // The user's own hooks (session trackers, prompt loggers) would otherwise spool every
    // reply this summarizes. Proven 2026-09-25: a hook set in the same call did not fire.
    '--settings', '{"disableAllHooks":true}',
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

/** Codex tools switched off for a gist (`codex features list`, CLI 0.155). */
export const CODEX_GIST_DISABLED_FEATURES = [
  'shell_tool', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'apps', 'plugins',
] as const

export function buildCodexGistArgs(model: string, workspace: string): string[] {
  return [
    'exec',
    // No config.toml (its MCP servers, profiles, model settings) and no rules files. Auth
    // still comes from CODEX_HOME, and AGENTS.md discovery starts at the empty workspace.
    '--ignore-user-config',
    '--ignore-rules',
    // A read-only sandbox still lets the shell read the whole disk; the shell is off.
    ...CODEX_GIST_DISABLED_FEATURES.flatMap(feature => ['--disable', feature]),
    '-c', 'web_search="disabled"',
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
  args: (workspace: string) => string[],
  prompt: string,
  opts: LensGistRunOptions,
  parse: (stdout: string) => LensGistEngineRun,
): Promise<LensGistEngineRun> {
  const binary = binaryFor(provider)
  const result = await withScratchWorkspace(workspace =>
    runProcess(binary, args(workspace), { stdin: prompt, cwd: workspace, timeoutMs: opts.timeoutMs, label: provider }))
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

function dispatch(engine: LensGistEngineName, model: string, prompt: string, opts: LensGistRunOptions): Promise<LensGistEngineRun> {
  switch (engine) {
    case 'claude':
      return runCli('claude', () => buildClaudeGistArgs(model, opts.system), prompt, opts, parseClaudeGistOutput)
    case 'codex':
      return runCli('codex', workspace => buildCodexGistArgs(model, workspace), prompt, opts, parseCodexGistOutput)
    case 'cursor':
      return runCli('cursor', workspace => buildCursorGistArgs(model, workspace), prompt, opts, parseCursorGistOutput)
    case 'ollama':
      return runOllama(model, prompt, opts)
  }
}

/** One engine call, and one row in the shared token audit either way (source g2-lens-gist). */
export async function runLensGistEngine(
  engine: LensGistEngineName,
  model: string,
  prompt: string,
  opts: LensGistRunOptions,
): Promise<LensGistEngineRun> {
  const started = Date.now()
  let outputChars = 0
  let resolvedModel = model
  try {
    const run = await dispatch(engine, model, prompt, opts)
    outputChars = run.text.length
    resolvedModel = run.model || model
    return run
  } finally {
    logTokenAudit({
      source: 'g2-lens-gist',
      caller: 'lens_gist',
      model: `${engine}:${resolvedModel || 'default'}`,
      inputChars: prompt.length + opts.system.length,
      outputChars,
      durationMs: Date.now() - started,
    })
  }
}
