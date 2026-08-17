// Phase 2, tested against REAL FILES.
//
// The offset arithmetic is exercised as a pure function, and then the whole tailer is
// driven against actual temp files through the actual `fsPromises.open` path — because
// the failure this module exists to prevent (a record bigger than a read window
// vanishing silently) is a property of real bytes at real offsets, and a mocked
// filesystem would reproduce whatever I assumed instead of what the disk does.
//
// The 587,878-byte record below is not an invented size. It is the one measured in
// Miles's own transcript on 2026-08-16, in a file whose largest record is 1,239,046
// bytes. A tail window of 768 KiB drops the larger one whole.

import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_READ_BYTES,
  __resetTranscriptWatchersForTests,
  acquireTranscriptWatcher,
  consumeTranscriptChunk,
  createTranscriptTailer,
  watchedTranscriptCount,
} from './session-transcript-watcher'
import { __resetSessionStreamBusForTests, beginAttachedTurn, sessionStreamKey } from './session-stream-bus'
import type { SessionStreamDraft } from './session-stream-events'

const KEY = sessionStreamKey('claude', 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d')
const roots: string[] = []

function tmpRoot(): string {
  // A DOT directory, mirroring `~/.claude/projects`. A bare mkdtemp root cannot
  // contain a dot component, and that exact gap has already shipped a bug here.
  const root = mkdtempSync(join(tmpdir(), 'cos-stream-'))
  const dir = join(root, '.claude')
  writeFileSync(join(root, '.keep'), '')
  roots.push(root)
  require('node:fs').mkdirSync(dir, { recursive: true })
  return dir
}

function assistantLine(text: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    session_id: 'a4b2b4dd-e40c-4b08-8a11-c89a018c197d',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })}\n`
}

function toolLine(name: string, input: Record<string, unknown>): string {
  return `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
  })}\n`
}

function collector() {
  const drafts: SessionStreamDraft[] = []
  return { drafts, publish: (_k: string, d: SessionStreamDraft) => { drafts.push(d) } }
}

afterEach(() => {
  __resetTranscriptWatchersForTests()
  __resetSessionStreamBusForTests()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// The pure cursor
// ---------------------------------------------------------------------------

describe('cursor arithmetic', () => {
  it('yields complete lines and stops at the last newline', () => {
    const result = consumeTranscriptChunk({ offset: 100, skipping: false }, Buffer.from('a\nb\npartial'), false)
    expect(result.lines).toEqual(['a', 'b'])
    // 100 + len('a\nb\n'), so `partial` is re-read next tick rather than consumed.
    expect(result.cursor).toEqual({ offset: 104, skipping: false })
  })

  it('leaves the cursor untouched when no record has completed', () => {
    const result = consumeTranscriptChunk({ offset: 40, skipping: false }, Buffer.from('{"type":"assis'), false)
    expect(result.lines).toEqual([])
    expect(result.cursor).toEqual({ offset: 40, skipping: false })
  })

  it('enters skip mode only when a FULL read contains no newline', () => {
    const capped = consumeTranscriptChunk({ offset: 0, skipping: false }, Buffer.from('x'.repeat(64)), true)
    expect(capped.cursor).toEqual({ offset: 64, skipping: true })

    const notCapped = consumeTranscriptChunk({ offset: 0, skipping: false }, Buffer.from('x'.repeat(64)), false)
    expect(notCapped.cursor).toEqual({ offset: 0, skipping: false })
  })

  it('stays skipping across chunks until a newline appears, then resumes', () => {
    const first = consumeTranscriptChunk({ offset: 0, skipping: true }, Buffer.from('xxxx'), true)
    expect(first).toEqual({ cursor: { offset: 4, skipping: true }, lines: [] })

    const second = consumeTranscriptChunk(first.cursor, Buffer.from('xx\nreal\n'), false)
    expect(second.lines).toEqual(['real'])
    expect(second.cursor).toEqual({ offset: 12, skipping: false })
  })

  it('drops empty lines rather than passing blanks to the grammar', () => {
    expect(consumeTranscriptChunk({ offset: 0, skipping: false }, Buffer.from('a\n\n\nb\n'), false).lines)
      .toEqual(['a', 'b'])
  })

  it('reads 4 MiB per tick, 3.2x the largest record measured on this Mac', () => {
    expect(MAX_READ_BYTES).toBe(4 * 1024 * 1024)
    expect(MAX_READ_BYTES).toBeGreaterThan(1_239_046)
  })
})

// ---------------------------------------------------------------------------
// The tailer, against a real file
// ---------------------------------------------------------------------------

describe('tailing a real transcript', () => {
  it('emits nothing for history and everything appended after', async () => {
    const dir = tmpRoot()
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, assistantLine('old turn one') + assistantLine('old turn two'))

    const { drafts, publish } = collector()
    const tailer = createTranscriptTailer({
      key: KEY, path, provider: 'claude', publish,
      offset: require('node:fs').statSync(path).size,
    })

    await tailer.tick()
    expect(drafts).toEqual([])

    appendFileSync(path, toolLine('Read', { file_path: '/x/occupied-threads.ts' }))
    await tailer.tick()

    expect(drafts).toEqual([
      { kind: 'status', state: 'working' },
      { kind: 'tool', verb: 'read', target: 'occupied-threads.ts', detail: '' },
    ])
  })

  it('DELIVERS A 587,878-BYTE RECORD WHOLE, which a 768 KiB tail window drops', async () => {
    const dir = tmpRoot()
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, '')
    const { drafts, publish } = collector()
    const tailer = createTranscriptTailer({ key: KEY, path, provider: 'claude', publish, offset: 0 })

    // Sized so the serialized record lands within a few bytes of the real one.
    const huge = assistantLine('z'.repeat(587_878))
    expect(huge.length).toBeGreaterThan(587_000)
    appendFileSync(path, huge)
    await tailer.tick()

    const prose = drafts.find(d => d.kind === 'prose')
    expect(prose).toBeDefined()
    // Whole record read, then capped by the grammar rather than lost by the reader.
    expect((prose as { text: string }).text.startsWith('zzz')).toBe(true)
    expect(tailer.cursor().offset).toBe(huge.length)
  })

  it('waits for a partially written record instead of parsing a fragment', async () => {
    const dir = tmpRoot()
    const path = join(dir, 'session.jsonl')
    const line = assistantLine('a complete thought')
    writeFileSync(path, line.slice(0, 50))

    const { drafts, publish } = collector()
    const tailer = createTranscriptTailer({ key: KEY, path, provider: 'claude', publish, offset: 0 })
    await tailer.tick()
    expect(drafts).toEqual([])
    expect(tailer.cursor().offset).toBe(0)

    appendFileSync(path, line.slice(50))
    await tailer.tick()
    expect(drafts.map(d => d.kind)).toEqual(['status', 'prose'])
  })

  it('reads a burst across ticks rather than allocating it all at once', async () => {
    const dir = tmpRoot()
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, '')
    const { drafts, publish } = collector()
    // A deliberately tiny budget so the multi-tick drain is reachable in a test.
    const tailer = createTranscriptTailer({
      key: KEY, path, provider: 'claude', publish, offset: 0, maxReadBytes: 256,
    })
    appendFileSync(path, assistantLine('one') + assistantLine('two') + assistantLine('three'))

    await tailer.tick()
    const afterFirst = drafts.filter(d => d.kind === 'prose').length
    expect(afterFirst).toBeGreaterThan(0)
    await tailer.tick()
    await tailer.tick()
    await tailer.tick()

    expect(drafts.filter(d => d.kind === 'prose')).toHaveLength(3)
  })

  it('skips a record larger than a whole tick budget instead of stalling forever', async () => {
    const dir = tmpRoot()
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, '')
    const { drafts, publish } = collector()
    const tailer = createTranscriptTailer({
      key: KEY, path, provider: 'claude', publish, offset: 0, maxReadBytes: 128,
    })
    appendFileSync(path, assistantLine('q'.repeat(2_000)) + assistantLine('after'))

    for (let i = 0; i < 40; i++) await tailer.tick()

    // The pathological record is gone; the one behind it still arrives.
    const prose = drafts.filter(d => d.kind === 'prose') as { text: string }[]
    expect(prose).toHaveLength(1)
    expect(prose[0]!.text).toBe('after')
  })

  it('rejoins at the new end when the file is truncated, never re-reading from zero', async () => {
    const dir = tmpRoot()
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, assistantLine('one') + assistantLine('two'))
    const { drafts, publish } = collector()
    const tailer = createTranscriptTailer({
      key: KEY, path, provider: 'claude', publish,
      offset: require('node:fs').statSync(path).size,
    })

    truncateSync(path, 0)
    await tailer.tick()

    expect(drafts).toEqual([])
    expect(tailer.cursor().offset).toBe(0)
  })

  it('treats a missing file as nothing to report, not as an error', async () => {
    const dir = tmpRoot()
    const { drafts, publish } = collector()
    const tailer = createTranscriptTailer({
      key: KEY, path: join(dir, 'absent.jsonl'), provider: 'claude', publish, offset: 0,
    })
    await expect(tailer.tick()).resolves.toBeUndefined()
    expect(drafts).toEqual([])
  })

  it('refuses to read through a symlink', async () => {
    const dir = tmpRoot()
    const real = join(dir, 'secret.jsonl')
    const link = join(dir, 'session.jsonl')
    writeFileSync(real, assistantLine('should never be streamed'))
    symlinkSync(real, link)

    const { drafts, publish } = collector()
    const tailer = createTranscriptTailer({ key: KEY, path: link, provider: 'claude', publish, offset: 0 })
    await tailer.tick()

    // O_NOFOLLOW: stat resolves the link and reports a size, the open refuses.
    expect(drafts).toEqual([])
  })
})

describe('status transitions are honest', () => {
  it('says working once, not once per record', async () => {
    const dir = tmpRoot()
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, '')
    const { drafts, publish } = collector()
    const tailer = createTranscriptTailer({ key: KEY, path, provider: 'claude', publish, offset: 0 })

    appendFileSync(path, assistantLine('one'))
    await tailer.tick()
    appendFileSync(path, assistantLine('two'))
    await tailer.tick()

    expect(drafts.filter(d => d.kind === 'status')).toEqual([{ kind: 'status', state: 'working' }])
  })

  it('falls to idle after the quiet window and does not flicker back', async () => {
    const dir = tmpRoot()
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, '')
    const { drafts, publish } = collector()
    let clock = 1_000_000
    const tailer = createTranscriptTailer({
      key: KEY, path, provider: 'claude', publish, offset: 0,
      now: () => clock, idleAfterMs: 45_000,
    })

    appendFileSync(path, assistantLine('working now'))
    await tailer.tick()
    expect(tailer.state()).toBe('working')

    clock += 44_000
    await tailer.tick()
    expect(tailer.state()).toBe('working')

    clock += 2_000
    await tailer.tick()
    expect(tailer.state()).toBe('idle')

    clock += 100_000
    await tailer.tick()
    expect(drafts.filter(d => d.kind === 'status' && d.state === 'idle')).toHaveLength(1)
  })

  it('never claims done, which it cannot observe from a file', async () => {
    const dir = tmpRoot()
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, assistantLine('x'))
    const { drafts, publish } = collector()
    let clock = 0
    const tailer = createTranscriptTailer({
      key: KEY, path, provider: 'claude', publish, offset: 0, now: () => clock,
    })
    await tailer.tick()
    clock += 10_000_000
    await tailer.tick()
    expect(drafts.some(d => d.kind === 'status' && d.state === 'done')).toBe(false)
  })
})

describe('duplicate suppression while a COS turn owns the session', () => {
  it('advances the cursor without emitting, then streams what comes after', async () => {
    const dir = tmpRoot()
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, '')
    const { drafts, publish } = collector()
    const tailer = createTranscriptTailer({ key: KEY, path, provider: 'claude', publish, offset: 0 })

    const endTurn = beginAttachedTurn(KEY)
    appendFileSync(path, assistantLine('streamed from stdout already'))
    await tailer.tick()
    expect(drafts).toEqual([])

    endTurn()
    appendFileSync(path, assistantLine('after the turn'))
    await tailer.tick()

    // Exactly one prose event: the suppressed record was consumed, not replayed.
    const prose = drafts.filter(d => d.kind === 'prose') as { text: string }[]
    expect(prose).toHaveLength(1)
    expect(prose[0]!.text).toBe('after the turn')
  })
})

describe('one watcher per session, ref-counted', () => {
  it('does not start a second poller for a second subscriber', () => {
    const dir = tmpRoot()
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, '')

    const first = acquireTranscriptWatcher({ key: KEY, path, provider: 'claude', offset: 0, intervalMs: 60_000 })
    const second = acquireTranscriptWatcher({ key: KEY, path, provider: 'claude', offset: 0, intervalMs: 60_000 })
    expect(watchedTranscriptCount()).toBe(1)

    first()
    expect(watchedTranscriptCount()).toBe(1)
    second()
    expect(watchedTranscriptCount()).toBe(0)
  })

  it('survives a release that fires twice without evicting a peer', () => {
    const dir = tmpRoot()
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, '')

    const first = acquireTranscriptWatcher({ key: KEY, path, provider: 'claude', offset: 0, intervalMs: 60_000 })
    acquireTranscriptWatcher({ key: KEY, path, provider: 'claude', offset: 0, intervalMs: 60_000 })
    first()
    first()
    first()

    expect(watchedTranscriptCount()).toBe(1)
  })

  it('actually polls, and stops polling once released', async () => {
    const dir = tmpRoot()
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, '')
    const seen: SessionStreamDraft[] = []
    const { subscribeSessionStream } = await import('./session-stream-bus')
    subscribeSessionStream(KEY, e => seen.push(e))

    const release = acquireTranscriptWatcher({ key: KEY, path, provider: 'claude', offset: 0, intervalMs: 10 })
    appendFileSync(path, assistantLine('live'))
    await new Promise(resolve => setTimeout(resolve, 120))
    const during = seen.length
    expect(during).toBeGreaterThan(0)

    release()
    appendFileSync(path, assistantLine('after release'))
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(seen).toHaveLength(during)
  })
})
