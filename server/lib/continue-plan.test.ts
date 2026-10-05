// 6.62.0 (plans 3.1, 3.3, 3.12, W13): the Continue plan, its allowance, the notes, the
// kill switch, and the one resolver every reader shares.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CURSOR_COMPOSER_NOTE,
  boundedContinueNote,
  continueAllowanceFor,
  continueFullPermissionsEnabled,
  killSwitchNote,
  planCursorContinue,
  validateContinuePlan,
} from './continue-plan'
import { CONTINUE_NOTE_MAX, __resetCodexPostureCacheForTests } from './codex-session-posture'
import { SQLITE3_BIN, __resetCursorSessionModelCachesForTests } from './cursor-session-model'
import {
  __resetSessionContinueFactsForTests,
  continueFactsFields,
  readClaudeReportedModel,
  resolveSessionContinueFacts,
  sanitizeReportedModel,
  type ContinueFactsDeps,
} from './session-continue-facts'

const THREAD = 'da2e661c-293a-4c7f-a8d6-6cd788b84c2e'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'continue plan '))
  __resetCodexPostureCacheForTests()
  __resetCursorSessionModelCachesForTests()
  __resetSessionContinueFactsForTests()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the kill switch', () => {
  it('is on unless COS_CONTINUE_FULL_PERMISSIONS is exactly 0', () => {
    expect(continueFullPermissionsEnabled({})).toBe(true)
    expect(continueFullPermissionsEnabled({ COS_CONTINUE_FULL_PERMISSIONS: '1' })).toBe(true)
    expect(continueFullPermissionsEnabled({ COS_CONTINUE_FULL_PERMISSIONS: 'false' })).toBe(true)
    expect(continueFullPermissionsEnabled({ COS_CONTINUE_FULL_PERMISSIONS: '0' })).toBe(false)
  })
})

describe('validateContinuePlan and continueAllowanceFor', () => {
  const codex = { provider: 'codex', sandbox: 'danger-full-access', model: 'gpt-6.1-sol', effort: 'high', networkAccess: true, source: 'session', note: 'n' }
  const cursor = { provider: 'cursor', mode: 'force', model: 'grok-4.7-xhigh-fast', matched: true, note: 'n' }

  it('accepts only a well-formed plan for the same provider', () => {
    expect(validateContinuePlan('codex', undefined)).toBeNull()
    expect(validateContinuePlan('codex', codex)).toBe(codex)
    expect(validateContinuePlan('cursor', cursor)).toBe(cursor)
    expect(validateContinuePlan('cursor', codex)).toBe('invalid')
    expect(validateContinuePlan('claude', cursor)).toBe('invalid')
    expect(validateContinuePlan('codex', { ...codex, sandbox: 'yolo' })).toBe('invalid')
    expect(validateContinuePlan('cursor', { ...cursor, mode: 'ask' })).toBe('invalid')
    expect(validateContinuePlan('cursor', { ...cursor, model: '-f' })).toBe('invalid')
    expect(validateContinuePlan('codex', 'plan')).toBe('invalid')
  })

  it('grants exactly one escalation per plan, never for read-only or workspace-write', () => {
    expect(continueAllowanceFor(cursor as any)).toEqual({ path: 'attached_continue', cursorForce: true })
    expect(continueAllowanceFor(codex as any)).toEqual({ path: 'attached_continue', codexSandbox: 'danger-full-access' })
    expect(continueAllowanceFor({ ...codex, sandbox: 'workspace-write' } as any)).toBeUndefined()
    expect(continueAllowanceFor({ ...codex, sandbox: 'read-only' } as any)).toBeUndefined()
    expect(continueAllowanceFor(undefined)).toBeUndefined()
  })
})

describe('planCursorContinue', () => {
  const listed = new Set(['grok-4.7-xhigh-fast', 'composer-2.5-fast'])
  const labels: Record<string, string> = { 'grok-4.7-xhigh-fast': 'Grok 4.7 Extra High Fast', 'composer-2.5-fast': 'Composer 2.5 Fast' }

  it('runs everything on the listed session model', () => {
    expect(planCursorContinue({ candidates: ['grok-4.7-xhigh-fast', 'grok-4.7'], isKnown: id => listed.has(id), label: id => labels[id] ?? null, askModeChat: false }))
      .toEqual({ provider: 'cursor', mode: 'force', model: 'grok-4.7-xhigh-fast', matched: true, note: 'Run Everything on Grok 4.7 Extra High Fast.' })
  })

  it('falls back to composer-2.5-fast with a note when the model is unread or unlisted', () => {
    const plan = planCursorContinue({ candidates: ['gpt-9-unlisted'], isKnown: id => listed.has(id), label: id => labels[id] ?? null, askModeChat: false })
    expect(plan).toMatchObject({ model: 'composer-2.5-fast', matched: false, note: 'Run Everything on Composer 2.5 Fast; model unread.' })
  })

  it('names the escalation for a chat COS created in Ask mode', () => {
    expect(planCursorContinue({ candidates: ['grok-4.7-xhigh-fast'], isKnown: id => listed.has(id), label: id => labels[id] ?? null, askModeChat: true }).note)
      .toMatch(/^Now Run Everything \(was Ask\)/)
  })

  it('keeps every note under 61 characters, even for a very long display name', () => {
    const notes: string[] = []
    for (const label of ['Grok 4.7 Extra High Fast', 'Claude Opus 5.5 Max Thinking Fast With A Long Context Window', null]) {
      for (const askModeChat of [false, true]) {
        for (const candidates of [['grok-4.7-xhigh-fast'], []]) {
          notes.push(planCursorContinue({ candidates, isKnown: id => listed.has(id), label: () => label, askModeChat }).note)
        }
      }
    }
    notes.push(killSwitchNote('codex', 'read-only')!, killSwitchNote('codex', 'workspace-write')!, killSwitchNote('cursor', 'read-only')!, CURSOR_COMPOSER_NOTE)
    for (const note of notes) {
      expect(note.length, note).toBeLessThan(CONTINUE_NOTE_MAX + 1)
      expect(boundedContinueNote(note)).toBe(note)
    }
    expect(killSwitchNote('claude', 'read-only')).toBeNull()
    expect(boundedContinueNote('x'.repeat(61))).toBeNull()
  })
})

function deps(over: Partial<ContinueFactsDeps> = {}): ContinueFactsDeps {
  return {
    env: {},
    codexFallbackSandbox: () => 'read-only',
    isKnownCodexModel: id => id === 'gpt-6.1-sol',
    codexModelLabel: id => (id === 'gpt-6.1-sol' ? 'GPT-6.1 Sol' : null),
    codexConfigText: () => `[projects."${root}/work tree"]\ntrust_level = "trusted"\n`,
    isKnownCursorModel: id => id === 'grok-4.7-low-fast' || id === 'composer-2.5-fast',
    cursorModelLabel: id => (id === 'grok-4.7-low-fast' ? 'Grok 4.7 Low Fast' : null),
    cursorChatDir: () => null,
    cursorComposerDb: join(root, 'missing.vscdb'),
    ...over,
  }
}

describe('resolveSessionContinueFacts', () => {
  it('Claude: no plan, no note, and reported_model from the newest real message.model', async () => {
    const transcript = join(root, '.claude', 'projects', 'p', 's.jsonl')
    mkdirSync(join(root, '.claude', 'projects', 'p'), { recursive: true })
    writeFileSync(transcript, [
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [] } }),
      JSON.stringify({ type: 'user', message: { content: 'model' } }),
      JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: [] } }),
    ].join('\n') + '\n')
    const facts = await resolveSessionContinueFacts({ provider: 'claude', threadId: THREAD, transcriptPath: transcript, cwd: null }, deps())
    expect(facts).toEqual({ note: null, reportedModel: 'claude-opus-5-5' })
    expect(continueFactsFields(facts)).toEqual({ reported_model: 'claude-opus-5-5' })
    expect(await readClaudeReportedModel(join(root, 'none.jsonl'))).toBeNull()
  })

  it('Codex: the session plan, its note, and reported_model as <model> <effort>', async () => {
    const rollout = join(root, '.codex', 'r.jsonl')
    mkdirSync(join(root, '.codex'), { recursive: true })
    writeFileSync(rollout, `${JSON.stringify({ type: 'turn_context', payload: { cwd: `${root}/work tree`, sandbox_policy: { type: 'danger-full-access' }, model: 'gpt-6.1-sol', effort: 'high', approval_policy: 'never' } })}\n`)
    const facts = await resolveSessionContinueFacts({ provider: 'codex', threadId: THREAD, transcriptPath: rollout, cwd: `${root}/work tree/sub` }, deps())
    expect(facts.plan).toMatchObject({ sandbox: 'danger-full-access', model: 'gpt-6.1-sol', effort: 'high' })
    expect(continueFactsFields(facts)).toEqual({ reported_model: 'gpt-6.1-sol high', continue_note: "This Codex session's full access, GPT-6.1 Sol High." })
    const off = await resolveSessionContinueFacts({ provider: 'codex', threadId: THREAD, transcriptPath: rollout, cwd: null }, deps({ env: { COS_CONTINUE_FULL_PERMISSIONS: '0' } }))
    expect(off.plan).toBeUndefined()
    expect(off.note).toBe('Read-only: full permissions switched off.')
    const unreadable = await resolveSessionContinueFacts({ provider: 'codex', threadId: THREAD, transcriptPath: null, cwd: '/x' }, deps())
    expect(unreadable.plan).toMatchObject({ sandbox: 'read-only', source: 'fallback' })
    expect(unreadable.reportedModel).toBeNull()
  })

  it('Cursor CLI chat: Run Everything on the chat model; IDE composer: no plan, its own note', async () => {
    const chatDir = join(root, '.cursor', 'chats', 'h', THREAD)
    mkdirSync(chatDir, { recursive: true })
    const db = join(chatDir, 'store.db')
    execFileSync(SQLITE3_BIN, [db, 'CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);'])
    execFileSync(SQLITE3_BIN, [db, `INSERT INTO blobs VALUES ('a', CAST('{"providerOptions":{"cursor":{"modelName":"grok-4.7-low-fast"}}}' AS BLOB))`])
    const facts = await resolveSessionContinueFacts({ provider: 'cursor', threadId: THREAD, transcriptPath: null, cwd: '/w' }, deps({ cursorChatDir: () => chatDir }))
    expect(facts.plan).toEqual({ provider: 'cursor', mode: 'force', model: 'grok-4.7-low-fast', matched: true, note: 'Run Everything on Grok 4.7 Low Fast.' })
    expect(facts.reportedModel).toBe('grok-4.7-low-fast')

    const composer = await resolveSessionContinueFacts({ provider: 'cursor', threadId: THREAD, transcriptPath: null, cwd: null }, deps())
    expect(composer).toEqual({ note: CURSOR_COMPOSER_NOTE, reportedModel: null })
  })

  it('sanitizes reported_model to the lens rule', () => {
    expect(sanitizeReportedModel('gpt-6.1-sol high')).toBe('gpt-6.1-sol high')
    expect(sanitizeReportedModel('<synthetic>')).toBeNull()
    expect(sanitizeReportedModel('claude-opus-4-8[1m]')).toBeNull()
    expect(sanitizeReportedModel('x'.repeat(101))).toBeNull()
    expect(sanitizeReportedModel('')).toBeNull()
  })
})
