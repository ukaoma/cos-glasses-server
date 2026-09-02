import { spawn } from 'node:child_process'
import { cosBrainDir } from './launch-dir.js'
import { resolveAgentBinary } from './cursor-model-catalog.js'
import { terminateProviderProcess } from './provider-process-lifecycle.js'

export type ProofProvider = 'claude' | 'codex' | 'cursor'
export const PROOF_PROVIDERS: readonly ProofProvider[] = ['claude', 'codex', 'cursor']

/**
 * Why a proof did not pass, as a stable code COS Control can branch on
 * without reading logs. `provider_quota` is the one that matters: a vendor
 * session or usage limit is a fact about the vendor's meter, not about the
 * candidate server, and an update must not roll back on it when another
 * provider proves. (2026-09-01: six 6.43.1 updates rolled back on Claude's
 * session limit while Codex proved in 7 s.)
 */
export type ProviderProofCode =
  | 'provider_quota'
  | 'provider_auth'
  | 'provider_context_overflow'
  | 'provider_missing'
  | 'provider_timeout'
  | 'provider_canceled'
  | 'provider_bad_answer'
  | 'provider_failed'

export interface ProviderProofResult {
  provider: ProofProvider
  ok: boolean
  durationMs: number
  cached: boolean
  error?: string
  code?: ProviderProofCode
}

const PROOF_TOKEN = 'COS_CONTROL_OK'
const PROOF_PROMPT = `This is an automated local readiness check. Do not use tools. Reply with exactly ${PROOF_TOKEN} and nothing else.`
const successCache = new Map<ProofProvider, ProviderProofResult>()
const inFlight = new Map<ProofProvider, Promise<ProviderProofResult>>()

export interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
}

// A readiness proof must validate the installed/authenticated provider, not load
// the selected workspace's CLAUDE.md, skills, plugins, MCP servers, and other
// project customizations. Large COS workspaces can otherwise overflow Claude's
// context window before the tiny proof prompt is evaluated.
export const CLAUDE_SAFE_MODE_ENV = 'CLAUDE_CODE_SAFE_MODE'

type TerminationReason = 'timeout' | 'abort' | null

export function runBounded(
  command: string,
  args: string[],
  input: string,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true })
      return
    }
    const env = { ...process.env }
    delete env.CLAUDECODE
    env[CLAUDE_SAFE_MODE_ENV] = '1'
    const child = spawn(command, args, {
      cwd: cosBrainDir() ?? process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    // The child `close` event normally wins the race against the async
    // terminateProviderProcess() result. Record WHY termination began before
    // sending a signal so that close cannot misreport a timeout as
    // "exited before launch" (Control 0.3.5 field failure, 2026-08-03).
    let terminationReason: TerminationReason = null
    const cap = (value: string) => value.slice(-256_000)
    child.stdout.on('data', chunk => { stdout = cap(stdout + chunk.toString()) })
    child.stderr.on('data', chunk => { stderr = cap(stderr + chunk.toString()) })
    const finish = (result: ProcessResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolvePromise(result)
    }
    const terminatedResult = (code: number | null): ProcessResult => ({
      code,
      stdout,
      stderr,
      timedOut: terminationReason === 'timeout',
      aborted: terminationReason === 'abort',
    })
    const timer = setTimeout(() => {
      if (settled || terminationReason) return
      terminationReason = 'timeout'
      void terminateProviderProcess(child, { termGraceMs: 50 }).then(result => {
        if (result.closed) finish(terminatedResult(result.code))
        else console.error('[provider-proof] timed-out provider did not close after SIGKILL; retaining request ownership')
      })
    }, timeoutMs)
    timer.unref?.()
    const abort = () => {
      if (settled || terminationReason) return
      terminationReason = 'abort'
      void terminateProviderProcess(child).then(result => {
        if (result.closed) finish(terminatedResult(result.code))
        else console.error('[provider-proof] canceled provider did not close after SIGKILL; retaining request ownership')
      })
    }
    child.once('error', err => {
      stderr = cap(stderr + err.message)
      finish(terminatedResult(null))
    })
    child.once('close', code => finish(terminatedResult(code)))
    signal?.addEventListener('abort', abort, { once: true })
    child.stdin.on('error', () => { /* close/error is authoritative */ })
    child.stdin.end(input)
  })
}

export const CLAUDE_PROOF_MODEL = 'haiku'
export const CLAUDE_PROOF_TIMEOUT_MS = 45_000

/** No MCP servers for the proof, stated explicitly rather than relied on
 * from CLAUDE_CODE_SAFE_MODE alone. Without safe mode, Claude Code 2.1.251
 * turns `--tools ''` into "load the whole catalog, expose none of it", and
 * on a Mac with a large MCP fleet that catalog alone is ~244K tokens against
 * Haiku's 200K window ("Prompt is too long", exit 1, zero API time). Safe
 * mode currently prevents that; an explicit empty config with
 * --strict-mcp-config keeps the proof under 20K tokens whatever a future
 * CLI does with the safe-mode flag. */
export const CLAUDE_PROOF_MCP_CONFIG = '{"mcpServers":{}}'

export function claudeProofArgs(): string[] {
  return [
    '-p',
    '--model', CLAUDE_PROOF_MODEL,
    '--output-format', 'json',
    '--permission-mode', 'dontAsk',
    '--strict-mcp-config',
    '--mcp-config', CLAUDE_PROOF_MCP_CONFIG,
    '--tools', '',
    '--allowedTools', '',
    '--system-prompt', PROOF_PROMPT,
    PROOF_PROMPT,
  ]
}

export function claudeProofText(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown }
    return typeof parsed.result === 'string' ? parsed.result.trim() : ''
  } catch {
    return ''
  }
}

export function codexProofText(stdout: string): string {
  const parts: string[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as any
      const item = event?.item ?? event?.payload ?? event?.message ?? event
      const eventType = String(event?.type ?? '').toLowerCase()
      const itemType = String(item?.type ?? '').toLowerCase()
      const assistant = /(?:^|[._-])(agent_message|assistant_message|output_text)(?:$|[._-])/.test(eventType)
        || /^(?:agent_message|assistant_message|output_text)$/.test(itemType)
      if (!assistant) continue
      const text = typeof event?.text === 'string' ? event.text
        : typeof event?.delta === 'string' ? event.delta
          : typeof item?.text === 'string' ? item.text
            : ''
      if (text) parts.push(text)
    } catch { /* ignore non-JSON CLI chatter */ }
  }
  return parts.join('').trim()
}

function safeProofError(result: ProcessResult): string {
  if (result.aborted) return 'provider proof canceled'
  if (result.timedOut) return 'provider proof timed out'
  if (result.code !== 0) return `provider process exited ${result.code ?? 'before launch'}`
  return 'provider returned no valid proof response'
}

const QUOTA_RE = /usage limit|hit your (?:usage |session )?limit|session limit|rate.?limit|too many requests|\b429\b|\bquota\b|resets? (?:at|in) |over capacity|overloaded|\b529\b|plan limit/i
const AUTH_RE = /not logged in|please (?:log ?in|sign in)|invalid api key|authentication|unauthori[sz]ed|\b401\b|\b403\b|login required|token (?:has )?expired|no credentials/i
const OVERFLOW_RE = /prompt is too long|context window|too many tokens|exceeds the (?:model|context)/i
const MISSING_RE = /ENOENT|command not found|no such file/i

/** Vendor text the provider printed, so the code can be derived without ever
 * returning that text to a caller. Claude's JSON `result` carries the error
 * sentence on `is_error`; Codex and Cursor print it on stderr or as a
 * result/error event. */
export function classifyProofFailure(result: ProcessResult, answer: string, expected = PROOF_TOKEN): ProviderProofCode {
  if (result.aborted) return 'provider_canceled'
  if (result.timedOut) return 'provider_timeout'
  const haystack = `${result.stderr}\n${result.stdout}`.slice(0, 40_000)
  if (result.code === null && MISSING_RE.test(haystack)) return 'provider_missing'
  if (OVERFLOW_RE.test(haystack)) return 'provider_context_overflow'
  if (QUOTA_RE.test(haystack)) return 'provider_quota'
  if (AUTH_RE.test(haystack)) return 'provider_auth'
  if (result.code === 0) return answer === expected ? 'provider_failed' : 'provider_bad_answer'
  return 'provider_failed'
}

/** One safe sentence per code; never the vendor's text. */
export function describeProofCode(code: ProviderProofCode, result: ProcessResult): string {
  switch (code) {
    case 'provider_quota': return 'provider session or usage limit reached'
    case 'provider_auth': return 'provider is not signed in'
    case 'provider_context_overflow': return 'provider refused the proof prompt as too long'
    case 'provider_missing': return 'provider binary is not installed or not on PATH'
    case 'provider_timeout': return 'provider proof timed out'
    case 'provider_canceled': return 'provider proof canceled'
    case 'provider_bad_answer': return 'provider answered but not with the proof token'
    default: return safeProofError(result)
  }
}

export const CURSOR_PROOF_TIMEOUT_MS = 120_000

/** Cursor `agent` in documented read-only ask mode, one stream-json turn, the
 * prompt on stdin like the bridge. No `--model`: the account default is the
 * readiness question, not any particular model. */
export function cursorProofArgs(workspace = cosBrainDir() ?? process.cwd()): string[] {
  return ['-p', '--mode', 'ask', '--output-format', 'stream-json', '--trust', '--workspace', workspace]
}

/** The final `result` event wins; assistant deltas with a timestamp are the
 * fallback, mirroring cursor-bridge's extractCursorResponseText. */
export function cursorProofText(stdout: string): string {
  let deltas = ''
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let event: any
    try { event = JSON.parse(line) } catch { continue }
    const type = String(event?.type ?? '').toLowerCase()
    if (type === 'result') {
      if (event?.subtype === 'success' && event?.is_error !== true && typeof event?.result === 'string') return event.result.trim()
      continue
    }
    if (type !== 'assistant' || typeof event?.timestamp_ms !== 'number') continue
    if (event?.model_call_id != null && event.model_call_id !== '') continue
    const content = event?.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === 'string') deltas += block
        else if (typeof block?.text === 'string') deltas += block.text
      }
    } else if (typeof event?.text === 'string') {
      deltas += event.text
    }
  }
  return deltas.trim()
}

async function executeProof(provider: ProofProvider, signal?: AbortSignal): Promise<ProviderProofResult> {
  const started = Date.now()
  let result: ProcessResult
  if (provider === 'claude') {
    result = await runBounded('claude', claudeProofArgs(), '', CLAUDE_PROOF_TIMEOUT_MS, signal)
  } else if (provider === 'codex') {
    result = await runBounded('codex', [
      'exec',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--json',
      '--cd', cosBrainDir() ?? process.cwd(),
      '--ephemeral',
      '-',
    ], PROOF_PROMPT, 120_000, signal)
  } else {
    const binary = resolveAgentBinary()
    result = binary
      ? await runBounded(binary, cursorProofArgs(), PROOF_PROMPT, CURSOR_PROOF_TIMEOUT_MS, signal)
      : { code: null, stdout: '', stderr: 'ENOENT: cursor agent binary not found', timedOut: false, aborted: false }
  }
  const text = provider === 'claude'
    ? claudeProofText(result.stdout)
    : provider === 'codex' ? codexProofText(result.stdout) : cursorProofText(result.stdout)
  const ok = result.code === 0 && text === PROOF_TOKEN
  if (ok) return { provider, ok, durationMs: Date.now() - started, cached: false }
  const code = classifyProofFailure(result, text)
  return {
    provider,
    ok: false,
    durationMs: Date.now() - started,
    cached: false,
    error: describeProofCode(code, result),
    code,
  }
}

/** Actual no-tool model turn, cached only after success for this server boot. */
export async function runProviderProof(provider: ProofProvider, signal?: AbortSignal): Promise<ProviderProofResult> {
  const cached = successCache.get(provider)
  if (cached) return { ...cached, cached: true }
  const existing = inFlight.get(provider)
  if (existing) return existing
  const operation = executeProof(provider, signal).then(result => {
    if (result.ok) successCache.set(provider, result)
    return result
  }).finally(() => {
    inFlight.delete(provider)
  })
  inFlight.set(provider, operation)
  return operation
}
