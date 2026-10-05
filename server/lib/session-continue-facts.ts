// One resolver for "what model is this session on, and what would a Continue run with"
// (6.62.0, plans 1.8, 3.2, 3.3, 3.12).
//
// Four readers share it, so they cannot disagree:
//   - the attached shim in index.ts (the plan that becomes argv),
//   - list rows and the detail route (`reported_model`, `continue_note`),
//   - the attachability verdict (`continue_note`).
//
// Every read is bounded and fails to "unknown": `reported_model` is OMITTED on any failure
// (never blanked, never guessed), and a Continue whose session cannot be read falls back
// to the 6.61 posture with a note that says so.

import { open, stat } from 'node:fs/promises'
import {
  codexReportedModel,
  planCodexContinue,
  readCodexConfigText,
  readCodexSessionPosture,
  type CodexSessionPosture,
} from './codex-session-posture.js'
import {
  continueFullPermissionsEnabled,
  killSwitchNote,
  planCursorContinue,
  CURSOR_ASK_UNACKED_NOTE,
  CURSOR_COMPOSER_NOTE,
  type AttachedContinuePlan,
} from './continue-plan.js'
import {
  cursorSlugCandidates,
  pickListedCursorModel,
  readCliChatFacts,
  readComposerFacts,
} from './cursor-session-model.js'

/** The lens's own filter for this field (session-model-identity.ts:14), applied here first. */
export const REPORTED_MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/ -]*$/
export const REPORTED_MODEL_MAX = 100

export function sanitizeReportedModel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > REPORTED_MODEL_MAX) return null
  return REPORTED_MODEL_RE.test(trimmed) ? trimmed : null
}

// ---------------------------------------------------------------------------
// Claude: the transcript's newest `message.model`
// ---------------------------------------------------------------------------

const CLAUDE_TAIL_WINDOWS = [1024 * 1024, 8 * 1024 * 1024]
const claudeModelMemo = new Map<string, { mtimeMs: number; size: number; model: string | null }>()
const MAX_MEMO = 512

/** Tests only. */
export function __resetSessionContinueFactsForTests(): void {
  claudeModelMemo.clear()
}

function newestClaudeModel(text: string): string | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('"assistant"') || !line.includes('"model"')) continue
    let row: any
    try { row = JSON.parse(line) } catch { continue }
    if (row?.type !== 'assistant') continue
    const model = row?.message?.model
    // `<synthetic>` is Claude Code's own stand-in for a reply no model wrote (an API error,
    // an interrupt). It is not what the session runs on.
    if (typeof model === 'string' && model.trim() && model !== '<synthetic>') return model.trim()
  }
  return null
}

/** Claude's newest real model from the transcript tail, memoized on (mtime, size). */
export async function readClaudeReportedModel(path: string | null | undefined): Promise<string | null> {
  if (typeof path !== 'string' || !path.startsWith('/')) return null
  let mtimeMs: number
  let size: number
  try {
    const st = await stat(path)
    if (!st.isFile()) return null
    mtimeMs = st.mtimeMs
    size = st.size
  } catch {
    return null
  }
  const memo = claudeModelMemo.get(path)
  if (memo && memo.mtimeMs === mtimeMs && memo.size === size) return memo.model
  let model: string | null = null
  try {
    const handle = await open(path, 'r')
    try {
      for (const window of CLAUDE_TAIL_WINDOWS) {
        const length = Math.min(window, size)
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, size - length)
        model = newestClaudeModel(buffer.subarray(0, bytesRead).toString('utf8'))
        if (model !== null || length >= size) break
      }
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
  claudeModelMemo.delete(path)
  claudeModelMemo.set(path, { mtimeMs, size, model })
  while (claudeModelMemo.size > MAX_MEMO) {
    const oldest = claudeModelMemo.keys().next()
    if (oldest.done) break
    claudeModelMemo.delete(oldest.value)
  }
  return model
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export interface ContinueFactsDeps {
  env?: NodeJS.ProcessEnv
  /** The 6.61 Codex sandbox (`getCodexTrustMode`). */
  codexFallbackSandbox: () => 'read-only' | 'workspace-write'
  isKnownCodexModel: (id: string) => boolean
  codexModelLabel: (id: string) => string | null
  /** `~/.codex/config.toml` text. Defaults to the live, read-only reader. */
  codexConfigText?: () => string | null
  isKnownCursorModel: (id: string) => boolean
  cursorModelLabel: (id: string) => string | null
  /** The CLI chat dir for this id (`~/.cursor/chats/<hash>/<id>`), or null for an IDE composer. */
  cursorChatDir: (threadId: string) => string | null
  /** `globalStorage/state.vscdb`. */
  cursorComposerDb: string
}

export interface SessionContinueFacts {
  /** For the attached shim only. Undefined: the 6.61 argv. */
  plan?: AttachedContinuePlan
  /** At most 60 characters, or null (Claude: unchanged, so no note). */
  note: string | null
  /** Sanitized to the lens rule, or null (then omitted from the wire). */
  reportedModel: string | null
}

export interface ContinueFactsInput {
  provider: string
  threadId: string
  /** The transcript or rollout, when the caller already holds it. */
  transcriptPath: string | null
  /** The Continue's real cwd (the shim's resolved workspace). Rows pass null. */
  cwd: string | null
  /** Pre-read composer facts for list pages (one query for the whole page). */
  composerFacts?: Map<string, import('./cursor-session-model.js').ComposerFacts | null>
  /**
   * 6.62.0 /qa (Q3): the client sent `X-COS-Continue-Note: 1` (it shows this note). Without
   * it a Cursor Continue gets NO plan (the 6.61 Ask posture) and a note that says so.
   */
  noteAck?: boolean
}

export async function resolveSessionContinueFacts(
  input: ContinueFactsInput,
  deps: ContinueFactsDeps,
): Promise<SessionContinueFacts> {
  const full = continueFullPermissionsEnabled(deps.env)
  if (input.provider === 'claude') {
    return { note: null, reportedModel: sanitizeReportedModel(await readClaudeReportedModel(input.transcriptPath)) }
  }
  if (input.provider === 'codex') {
    let posture: CodexSessionPosture | null = null
    try {
      posture = await readCodexSessionPosture(input.transcriptPath)
    } catch {
      posture = null
    }
    const reportedModel = sanitizeReportedModel(codexReportedModel(posture))
    let fallback: 'read-only' | 'workspace-write' = 'read-only'
    try { fallback = deps.codexFallbackSandbox() === 'workspace-write' ? 'workspace-write' : 'read-only' } catch { fallback = 'read-only' }
    if (!full) return { note: killSwitchNote('codex', fallback), reportedModel }
    const plan = planCodexContinue(posture, input.cwd ?? posture?.cwd ?? '', {
      fallbackSandbox: () => fallback,
      configText: deps.codexConfigText ?? (() => readCodexConfigText()),
      isKnownModel: deps.isKnownCodexModel,
      modelLabel: deps.codexModelLabel,
    })
    return { plan, note: plan.note, reportedModel }
  }
  if (input.provider === 'cursor') {
    const id = input.threadId.toLowerCase()
    let chatDir: string | null = null
    try { chatDir = deps.cursorChatDir(id) } catch { chatDir = null }
    if (chatDir) {
      const chat = await readCliChatFacts(chatDir)
      const reportedModel = sanitizeReportedModel(chat?.model ?? null)
      if (!full) return { note: killSwitchNote('cursor', 'read-only'), reportedModel }
      if (input.noteAck !== true) return { note: CURSOR_ASK_UNACKED_NOTE, reportedModel }
      const plan = planCursorContinue({
        candidates: chat?.model ? [chat.model] : [],
        isKnown: deps.isKnownCursorModel,
        label: deps.cursorModelLabel,
        askModeChat: chat?.mode === 'ask',
      })
      return { plan, note: plan.note, reportedModel }
    }
    // An IDE composer: no plan (it is never resumed from outside), and its model is read
    // from the composer record in a query of its own.
    let facts = input.composerFacts?.get(id)
    if (facts === undefined) {
      try {
        facts = (await readComposerFacts([id], deps.cursorComposerDb)).get(id) ?? null
      } catch {
        facts = null
      }
    }
    const candidates = cursorSlugCandidates(facts?.modelConfig ?? null)
    const listed = pickListedCursorModel(candidates, deps.isKnownCursorModel)
    return { note: CURSOR_COMPOSER_NOTE, reportedModel: sanitizeReportedModel(listed ?? candidates[0] ?? null) }
  }
  return { note: null, reportedModel: null }
}

/** The two wire keys, omitted when unknown, so an older client sees the same payload. */
export function continueFactsFields(facts: SessionContinueFacts | null | undefined): { reported_model?: string; continue_note?: string } {
  if (!facts) return {}
  return {
    ...(facts.reportedModel ? { reported_model: facts.reportedModel } : {}),
    ...(facts.note ? { continue_note: facts.note } : {}),
  }
}

