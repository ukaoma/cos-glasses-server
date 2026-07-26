import { spawn } from 'node:child_process'
import { cosBrainDir } from './launch-dir.js'

export type ProofProvider = 'claude' | 'codex'

export interface ProviderProofResult {
  provider: ProofProvider
  ok: boolean
  durationMs: number
  cached: boolean
  error?: string
}

const PROOF_TOKEN = 'COS_CONTROL_OK'
const PROOF_PROMPT = `This is an automated local readiness check. Do not use tools. Reply with exactly ${PROOF_TOKEN} and nothing else.`
const successCache = new Map<ProofProvider, ProviderProofResult>()
const inFlight = new Map<ProofProvider, Promise<ProviderProofResult>>()

interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

function runBounded(
  command: string,
  args: string[],
  input: string,
  timeoutMs = 120_000,
): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    const env = { ...process.env }
    delete env.CLAUDECODE
    const child = spawn(command, args, {
      cwd: cosBrainDir() ?? process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const cap = (value: string) => value.slice(-256_000)
    child.stdout.on('data', chunk => { stdout = cap(stdout + chunk.toString()) })
    child.stderr.on('data', chunk => { stderr = cap(stderr + chunk.toString()) })
    const finish = (result: ProcessResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(result)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
      finish({ code: null, stdout, stderr, timedOut: true })
    }, timeoutMs)
    timer.unref?.()
    child.once('error', err => finish({ code: null, stdout, stderr: err.message, timedOut: false }))
    child.once('close', code => finish({ code, stdout, stderr, timedOut: false }))
    child.stdin.on('error', () => { /* close/error is authoritative */ })
    child.stdin.end(input)
  })
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
  if (result.timedOut) return 'provider proof timed out'
  if (result.code !== 0) return `provider process exited ${result.code ?? 'before launch'}`
  return 'provider returned no valid proof response'
}

async function executeProof(provider: ProofProvider): Promise<ProviderProofResult> {
  const started = Date.now()
  const result = provider === 'claude'
    ? await runBounded('claude', [
      '-p',
      '--output-format', 'json',
      '--permission-mode', 'dontAsk',
      '--tools', '',
      '--allowedTools', '',
      '--system-prompt', PROOF_PROMPT,
      PROOF_PROMPT,
    ], '')
    : await runBounded('codex', [
      'exec',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--json',
      '--cd', cosBrainDir() ?? process.cwd(),
      '--ephemeral',
      '-',
    ], PROOF_PROMPT)
  const text = provider === 'claude'
    ? claudeProofText(result.stdout)
    : codexProofText(result.stdout)
  const ok = result.code === 0 && text === PROOF_TOKEN
  return {
    provider,
    ok,
    durationMs: Date.now() - started,
    cached: false,
    ...(ok ? {} : { error: safeProofError(result) }),
  }
}

/** Actual no-tool model turn, cached only after success for this server boot. */
export async function runProviderProof(provider: ProofProvider): Promise<ProviderProofResult> {
  const cached = successCache.get(provider)
  if (cached) return { ...cached, cached: true }
  const existing = inFlight.get(provider)
  if (existing) return existing
  const operation = executeProof(provider).then(result => {
    if (result.ok) successCache.set(provider, result)
    return result
  }).finally(() => {
    inFlight.delete(provider)
  })
  inFlight.set(provider, operation)
  return operation
}
