// Token audit logger — zero-cost file I/O tracking for all claude -p calls.
// Both Python (COS scripts) and TypeScript (G2 glasses) write to the same JSONL.
// No LLM calls. Pure file append.

import { appendFileSync, chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

import { COS_SCRIPTS_DIR } from './python-bridge.js'

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

export interface TokenAuditEntry {
  source: string       // "g2-voice", "g2-prewarm", "g2-archive", "g2-query"
  model: string        // "opus", "sonnet", "haiku"
  inputChars: number
  outputChars: number
  durationMs: number
  caller: string       // "voice_query", "prewarm", "chat_summary", "day_summary"
}

export function logTokenAudit(entry: TokenAuditEntry): void {
  const record = {
    ts: new Date().toISOString(),
    source: entry.source,
    model: entry.model,
    input_chars: entry.inputChars,
    output_chars: entry.outputChars,
    est_input_tokens: estimateTokens(entry.inputChars),
    est_output_tokens: estimateTokens(entry.outputChars),
    duration_ms: entry.durationMs,
    caller: entry.caller,
  }
  try {
    appendFileSync(AUDIT_FILE, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 })
    chmodSync(AUDIT_FILE, 0o600)
  } catch {
    // Never let logging break the actual call
  }
}
