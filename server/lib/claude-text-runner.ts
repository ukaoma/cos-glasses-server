/**
 * 6.92.0 (plan r3, A-W0b): a small isolated `claude -p` text runner, for callers that only turn text
 * into text (G2's prompt edit today). It replaces spawnClaudeText for those callers; spawnClaudeText
 * stays in prompt-edit.ts for meeting summaries.
 *
 * Isolation, the dictation polish caller's (dictation-clean.ts claudePolishArgs) minus its env strip:
 * - no tools (`--tools ''`), so the key-secrets deny layer has nothing to guard (key-lanes census:
 *   TOOL_LESS_CLAUDE); no MCP servers (`--strict-mcp-config` with an empty config); no hooks, in
 *   exactly ONE `--settings` layer; `--permission-mode dontAsk`; no session file;
 * - `--model` is always passed, so it can never silently become Opus;
 * - a fresh scratch working directory, never the server's own;
 * - a verified absolute binary (provider-binary.ts), never a bare PATH lookup.
 * The environment is kept as spawnClaudeText kept it (only CLAUDECODE is removed and PATH repaired),
 * so a person who signs the Claude CLI in with an API key keeps working.
 *
 * Errors carry a code and never the CLI's stdout or stderr: those can hold the draft or login data.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveProviderBinary } from './provider-binary.js'
import { terminateProviderProcess } from './provider-process-lifecycle.js'

export type ClaudeTextErrorCode = 'unavailable' | 'aborted' | 'timeout' | 'failed' | 'empty' | 'too_large' | 'input'

export class ClaudeTextError extends Error {
  constructor(readonly code: ClaudeTextErrorCode, label: string) {
    super(`${label} ${code}`)
  }
}

export interface ClaudeTextRunOptions {
  model: string
  effort: string
  timeoutMs: number
  systemPrompt: string
  /** Prefix for the error message ("Prompt edit"). */
  label: string
  signal?: AbortSignal
}

/** The argv: one `--settings`, no tools, no MCP, no hooks, no session. */
export function claudeTextArgs(model: string, effort: string, systemPrompt: string): string[] {
  return [
    '-p', '--model', model, '--effort', effort, '--output-format', 'text',
    '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', '', '--settings', '{"disableAllHooks":true}', '--permission-mode', 'dontAsk',
    '--system-prompt', systemPrompt,
  ]
}

/** spawnClaudeText's environment: everything but CLAUDECODE (anti-recursion), with the binary's dir on PATH. */
export function claudeTextEnv(binary: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env }
  delete out.CLAUDECODE
  out.PATH = [dirname(binary), '/opt/homebrew/bin', out.PATH || ''].join(':')
  out.NO_OPEN_BROWSER = '1'
  return out
}

const MAX_OUTPUT_CHARS = 256_000

/** Run the prompt on stdin; resolve the trimmed text answer, or reject with a ClaudeTextError. */
export async function runClaudeText(prompt: string, opts: ClaudeTextRunOptions): Promise<string> {
  if (opts.signal?.aborted) throw new ClaudeTextError('aborted', opts.label)
  const binary = resolveProviderBinary('claude')
  if (!binary.ok) throw new ClaudeTextError('unavailable', opts.label)
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 45_000
  const scratch = mkdtempSync(join(tmpdir(), 'cos-claude-text-'))
  try {
    const workspace = join(scratch, 'workspace')
    mkdirSync(workspace, { mode: 0o700 })
    return await new Promise<string>((resolve, reject) => {
      const proc = spawn(binary.path, claudeTextArgs(opts.model, opts.effort, opts.systemPrompt), {
        stdio: ['pipe', 'pipe', 'pipe'], env: claudeTextEnv(binary.path), cwd: workspace, detached: true,
      })
      let stdout = ''
      let settled = false
      const finish = (error?: ClaudeTextError, output?: string, terminate = false) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', abort)
        const complete = () => error ? reject(error) : resolve(output!)
        if (terminate) void terminateProviderProcess(proc).then(complete, complete)
        else complete()
      }
      const abort = () => finish(new ClaudeTextError('aborted', opts.label), undefined, true)
      const timer = setTimeout(() => finish(new ClaudeTextError('timeout', opts.label), undefined, true), timeoutMs)
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        if (stdout.length > MAX_OUTPUT_CHARS) finish(new ClaudeTextError('too_large', opts.label), undefined, true)
      })
      // Never read or log stderr: it can carry login or draft data.
      proc.stderr.resume()
      proc.on('error', () => finish(new ClaudeTextError('unavailable', opts.label), undefined, true))
      proc.on('close', (code) => {
        if (settled) return
        if (code !== 0) return finish(new ClaudeTextError('failed', opts.label))
        const output = stdout.trim()
        if (!output) return finish(new ClaudeTextError('empty', opts.label))
        finish(undefined, output)
      })
      proc.stdin.on('error', () => finish(new ClaudeTextError('input', opts.label), undefined, true))
      opts.signal?.addEventListener('abort', abort, { once: true })
      if (opts.signal?.aborted) return abort()
      try { proc.stdin.end(prompt) } catch { finish(new ClaudeTextError('input', opts.label), undefined, true) }
    })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
