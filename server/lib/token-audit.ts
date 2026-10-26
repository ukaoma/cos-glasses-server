// Token audit logger — zero-cost file I/O tracking for all claude -p calls.
// Both Python (COS scripts) and TypeScript (G2 glasses) write to the same JSONL.
// No LLM calls. Pure file append.

import { appendFileSync, chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

import { COS_SCRIPTS_DIR } from './python-bridge.js'
import type { TokenAuditKeyFields } from './key-relay-contract.js'

// Shared JSONL file — same path as Python's llm_client.py uses
// Uses COS_SCRIPTS_DIR when available (server mode), falls back to user home
const AUDIT_FILE = COS_SCRIPTS_DIR
  ? resolve(COS_SCRIPTS_DIR, '.cos_token_audit.jsonl')
  : resolve(homedir(), '.cos-glasses', 'token-audit.jsonl')

// Rough char-to-token ratio (1 token ~ 4 chars for English)
const CHARS_PER_TOKEN = 4

function estimateTokens(chars: number): number {
  return Math.max(1, Math.floor(chars / CHARS_PER_TOKEN))
}

export interface TokenAuditEntry extends TokenAuditKeyFields {
  source: string       // "g2-voice", "g2-prewarm", "g2-archive", "g2-query"
  model: string        // "opus", "sonnet", "haiku", "cursor-composer", ...
  inputChars: number
  outputChars: number
  durationMs: number
  caller: string       // "voice_query", "prewarm", "chat_summary", "day_summary"
  turnId?: string
  runId?: string
  sessionId?: string
  clientJobId?: string
  usageKind?: 'provider_final' | 'estimated'
  /** 6.85.0, dictation polish only: whether the user's polish instructions were in the prompt, and their hash. */
  polishInstructions?: { on: boolean; hash: string }
  /** 6.91.0, dictation polish only: whether the learned style was in the prompt, and its hash. */
  learnedStyle?: { on: boolean; hash: string }
  /** 6.91.0, dictation polish only: the register code (literal or default). Never the app name. */
  polishRegister?: string
  /** 6.91.0, dictation polish only: the prompt that ran (v3 or v4). */
  polishPrompt?: string
  /** 6.91.0, dictation polish only: what became of the model's answer (polished, unchanged, guarded) and the guard kind.
   * 6.92.0: `aborted` (audit only, never in a finalize answer) when the client went away mid-call. */
  polishOutcome?: string
  polishGuard?: string
  /** 6.92.0, prompt edit only: ok, failed or aborted. */
  promptEditOutcome?: 'ok' | 'failed' | 'aborted'
}

/**
 * The JSONL record. Key-lane fields (plan v4 3.1: `profile`, `lane`, `credentialKind`, `usd`) are
 * conditional spreads AFTER every 6.79.0 key, written only when the caller sets them, so a Lane A
 * (subscription) row is byte-identical to 6.79.0. Callers set them only on keyed turns.
 */
export function buildTokenAuditRecord(entry: TokenAuditEntry, now: Date = new Date()): Record<string, unknown> {
  return {
    ts: now.toISOString(),
    source: entry.source,
    model: entry.model,
    input_chars: entry.inputChars,
    output_chars: entry.outputChars,
    est_input_tokens: estimateTokens(entry.inputChars),
    est_output_tokens: estimateTokens(entry.outputChars),
    duration_ms: entry.durationMs,
    caller: entry.caller,
    usage_kind: entry.usageKind ?? 'estimated',
    ...(entry.turnId ? { turn_id: entry.turnId } : {}),
    ...(entry.runId ? { run_id: entry.runId } : {}),
    ...(entry.sessionId ? { session_id: entry.sessionId } : {}),
    ...(entry.clientJobId ? { client_job_id: entry.clientJobId } : {}),
    ...(entry.profile ? { profile: entry.profile } : {}),
    ...(entry.lane ? { lane: entry.lane } : {}),
    ...(entry.credentialKind ? { credentialKind: entry.credentialKind } : {}),
    ...(typeof entry.usd === 'number' && Number.isFinite(entry.usd) ? { usd: entry.usd } : {}),
    // 6.85.0: set only by the dictation polish caller, so every other row is unchanged. Never the text.
    ...(entry.polishInstructions ? {
      custom_instructions: entry.polishInstructions.on,
      ...(entry.polishInstructions.hash ? { instructions_hash: entry.polishInstructions.hash } : {}),
    } : {}),
    // 6.91.0: codes and a hash only, set only by the dictation polish caller.
    ...(entry.learnedStyle ? {
      learned_style: entry.learnedStyle.on,
      ...(entry.learnedStyle.hash ? { learned_style_hash: entry.learnedStyle.hash } : {}),
    } : {}),
    ...(entry.polishRegister ? { polish_register: entry.polishRegister } : {}),
    ...(entry.polishPrompt ? { polish_prompt: entry.polishPrompt } : {}),
    ...(entry.polishOutcome ? { polish_outcome: entry.polishOutcome } : {}),
    ...(entry.polishGuard ? { polish_guard: entry.polishGuard } : {}),
    // 6.92.0: set only by the prompt-edit caller.
    ...(entry.promptEditOutcome ? { prompt_edit_outcome: entry.promptEditOutcome } : {}),
  }
}

export function logTokenAudit(entry: TokenAuditEntry): void {
  const record = buildTokenAuditRecord(entry)
  try {
    appendFileSync(AUDIT_FILE, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 })
    chmodSync(AUDIT_FILE, 0o600)
  } catch {
    // Never let logging break the actual call
  }
}
