import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listCodexSessions, idFromCodexFilename } from './agent-session-store.js'

/**
 * A cloned Codex conversation copies the parent's `session_meta` record, so the new
 * rollout carries the PARENT's id under its own filename. Two conversations, one
 * identity -- and the newer one never appears in the list because it is folded into its
 * parent. This is that shape, reduced to two files.
 */
const PARENT = '019e0943-62c4-7643-bcff-1a7be9a52a4c'
const FORK = '01a0119c-6177-7890-b35b-a5f7a4eaec14'

function rollout(id: string, title: string): string {
  return [
    JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/tmp/work', originator: 'test' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: title }] } }),
  ].join('\n') + '\n'
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'codex-clone-'))
  const day = join(root, '2026', '08', '17')
  mkdirSync(day, { recursive: true })
  writeFileSync(join(day, `rollout-2026-08-17T10-00-00-${PARENT}.jsonl`), rollout(PARENT, 'Markt POS 2.0 build'))
  // The clone: its own filename, the PARENT's id inside.
  writeFileSync(join(day, `rollout-2026-08-17T16-24-16-${FORK}.jsonl`), rollout(PARENT, 'POS Nation 3.0 build'))
  return root
}

describe('a cloned Codex conversation gets its own identity', () => {
  it('lists BOTH sessions, not one', async () => {
    // `async/await`, not `.then()` inside a sync try/finally -- the finally ran first and
    // deleted the fixture out from under the read, which reported as an empty list and
    // looked exactly like the bug under test.
    const root = fixture()
    try {
      const rows = await listCodexSessions(root, new Date(), 50)
      expect(rows).toHaveLength(2)
      const ids = rows.map(r => r.session_id.toLowerCase()).sort()
      expect(ids).toEqual([FORK, PARENT].sort())
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('gives the fork the FILENAME id, not the copied parent id', async () => {
    const root = fixture()
    try {
      const rows = await listCodexSessions(root, new Date(), 50)
      const fork = rows.find(r => r.display_label?.includes('POS Nation'))
      expect(fork).toBeDefined()
      expect(fork!.session_id.toLowerCase()).toBe(FORK)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves an ordinary session alone, where filename and meta agree', async () => {
    const root = fixture()
    try {
      const rows = await listCodexSessions(root, new Date(), 50)
      const parent = rows.find(r => r.display_label?.includes('Markt'))
      expect(parent!.session_id.toLowerCase()).toBe(PARENT)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('idFromCodexFilename reads the uuid off a real rollout name', () => {
    expect(idFromCodexFilename(`rollout-2026-08-17T16-24-16-${FORK}.jsonl`)).toBe(FORK)
    expect(idFromCodexFilename('not-a-rollout.txt')).toBeNull()
    expect(idFromCodexFilename('rollout-short.jsonl')).toBeNull()
  })
})
