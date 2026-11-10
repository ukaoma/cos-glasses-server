// S1 (2026-11-09): the ledger compaction tool, run on scratch copies only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compactSessionLog, lineSessionId } from './compact-session-log.js'

let dir = ''
let file = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cos-compact-'))
  file = join(dir, '.glasses_sessions.jsonl')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const entry = (id: string, n: number, reason = 'server_shutdown') => JSON.stringify({
  session_id: id, device_id: 'COS-Glasses', created_at: '2026-11-01T10:00:00.000Z',
  ended_at: `2026-11-01T10:${String(n).padStart(2, '0')}:00.000Z`, end_reason: reason, total_message_count: n,
  messages: [{ query: `q${n}`, response: 'r'.repeat(200), timestamp: '2026-11-01T10:00:00.000Z' }],
}) + '\n'
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const ids = (p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => lineSessionId(Buffer.from(l)))

function seed(): string {
  const body = entry('a', 1) + entry('b', 1) + entry('a', 2) + 'torn {"session' + '\n' + entry('a', 3, 'explicit_end') + entry('b', 2) + entry('c', 1)
  writeFileSync(file, body, { mode: 0o600 })
  return body
}

describe('compact-session-log', () => {
  it('dry run reports before and after and changes nothing', async () => {
    seed()
    const before = sha(file)
    const r = await compactSessionLog({ file })
    expect(r.mode).toBe('dry-run')
    expect(r.before).toMatchObject({ entries: 6, sessions: 3, unparsedLines: 1, bytes: statSync(file).size })
    expect(r.after.entries).toBe(3)
    expect(r.after.bytes).toBe(Buffer.byteLength(entry('a', 3, 'explicit_end') + entry('b', 2) + entry('c', 1) + 'torn {"session\n'))
    expect(r.mostCopied[0]).toEqual({ session: 'a', copies: 3 })
    expect(sha(file)).toBe(before)
    expect(readdirSync(dir)).toEqual(['.glasses_sessions.jsonl'])
  })

  it('apply keeps the last entry per session, keeps unparsed lines, backs up every byte by hard link', async () => {
    const original = seed()
    const r = await compactSessionLog({ file, apply: true, now: new Date(2026, 10, 9, 20, 0, 0) })
    expect(r.verified).toBe(true)
    expect(r.backup).toBe(`${file}.bak-20261109-200000`)
    expect(readFileSync(r.backup!, 'utf8')).toBe(original)
    expect(readFileSync(file, 'utf8')).toBe('torn {"session\n' + entry('a', 3, 'explicit_end') + entry('b', 2) + entry('c', 1))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(r.after).toMatchObject({ entries: 3, sessions: 3, unparsedLinesKept: 1 })
    // No temp file left behind.
    expect(readdirSync(dir).sort()).toEqual(['.glasses_sessions.jsonl', '.glasses_sessions.jsonl.bak-20261109-200000'])
    // Idempotent: a second run finds nothing to drop.
    const again = await compactSessionLog({ file })
    expect(again.before.entries).toBe(again.after.entries)
  })

  it('keeps lines a running server appends during the run', async () => {
    seed()
    const r = await compactSessionLog({ file, apply: true, now: new Date(2026, 10, 9, 21, 0, 0),
      afterRewrite: () => appendFileSync(file, entry('d', 1) + entry('a', 4)) })
    expect(r.appendedDuringRun).toBe(Buffer.byteLength(entry('d', 1) + entry('a', 4)))
    expect(r.verified).toBe(true)
    expect(ids(file)).toEqual([null, 'a', 'b', 'c', 'd', 'a'])
  })

  it('refuses to overwrite an existing backup name and leaves the original untouched', async () => {
    seed()
    const before = sha(file)
    const now = new Date(2026, 10, 9, 22, 0, 0)
    writeFileSync(`${file}.bak-20261109-220000`, 'someone else')
    await expect(compactSessionLog({ file, apply: true, now })).rejects.toThrow(/EEXIST/)
    expect(sha(file)).toBe(before)
    expect(readdirSync(dir).filter(n => n.includes('.compact-'))).toEqual([])
  })
})
