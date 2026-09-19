// 6.52.0 QA round 2: when a COS-driven Continue turn finished, its last lines were shown
// TWICE on the lens, and the status went from done back to working.
//
// THE RACE. The transcript watcher reads the hold-off when it READS, once a second. The
// CLI writes each record to the transcript that watcher tails AND prints it on stdout,
// which the producer maps. Records written after the watcher's last check of the turn
// were read by its first check AFTER `finish()` had released the hold-off, so they were
// emitted again, and the watcher's resume put `working` after `done`.
//
// QA reproduced it with the real tailer and producer on the real codex exec sample: rows
// appended with NO check during the turn, then `finish('done')`, then one check.
// `session-stream-codex-exec.test.ts` always runs a check during the turn, which is why it
// could not see this. The regressions here never do.
//
// Real throughout unless a test says otherwise: the watcher registry, the tailer against
// real files under a DOT directory (as `~/.codex` and `~/.claude` are), the producer, and
// the module bus a Sessions subscriber reads. The one seam is `tailer:` on
// `acquireTranscriptWatcher`: the registered tailer is the real one, held by the test so it
// can run the check the 1 s timer would run at the moment the race needs.

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAttachedTurnStream } from './session-stream-producer.js'
import {
  CATCH_UP_TIMEOUT_MS,
  __resetTranscriptWatchersForTests,
  acquireTranscriptWatcher,
  createTranscriptTailer,
  transcriptCatchUpCounts,
  type TranscriptTailer,
} from './session-transcript-watcher.js'
import {
  __resetSessionStreamBusForTests,
  isAttachedTurnActive,
  sessionStreamKey,
  subscribeSessionStream,
  type PublishedSessionEvent,
} from './session-stream-bus.js'
import { CLAUDE_RUN } from './__fixtures__/job-trail-runs.js'

const CODEX_SAMPLE = readFileSync(new URL('./__fixtures__/codex-exec-json-0.155.0.jsonl', import.meta.url), 'utf8')
const CODEX_THREAD = '01a0bad9-71a3-7061-bfed-d91918099cb3'
const CLAUDE_SESSION = 'c8382982-75a2-4a07-b64a-d02f211acc4f'

const roots: string[] = []
afterEach(() => {
  __resetTranscriptWatchersForTests()
  __resetSessionStreamBusForTests()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** An empty transcript at `<tmp>/<dotDir>/<name>`. */
function transcript(dotDir: string, name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'cos-catch-up-'))
  roots.push(root)
  const dir = join(root, dotDir)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, '')
  return path
}

/** A Codex rollout row, in the shape QA's probe appended. */
function rolloutRow(id: string, text: string): string {
  return `${JSON.stringify({ timestamp: '2026-09-19T18:06:50.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id, content: [{ type: 'Text', text }] } } })}\n`
}

function assistantRow(text: string): string {
  return `${JSON.stringify({ type: 'assistant', sessionId: CLAUDE_SESSION, message: { role: 'assistant', content: [{ type: 'text', text }] } })}\n`
}

/** What a Sessions subscriber on this key receives, through the real bus. */
function subscribe(key: string): PublishedSessionEvent[] {
  const seen: PublishedSessionEvent[] = []
  const unsubscribe = subscribeSessionStream(key, event => { seen.push(event) })
  expect(unsubscribe).not.toBeNull()
  return seen
}

function label(event: PublishedSessionEvent): string {
  if (event.kind === 'prose') return `prose:${event.text}`
  if (event.kind === 'tool') return `tool:${event.verb} ${event.target}`
  if (event.kind === 'status') return `status:${event.state}`
  return event.kind
}

function prose(seen: PublishedSessionEvent[]): string[] {
  return seen.map(label).filter(l => l.startsWith('prose:'))
}

function workingAfterDone(seen: PublishedSessionEvent[]): boolean {
  const labels = seen.map(label)
  const done = labels.indexOf('status:done')
  return done >= 0 && labels.slice(done).includes('status:working')
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function until(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await sleep(5)
  }
}

function fakeTailer(overrides: Partial<TranscriptTailer>): TranscriptTailer {
  return {
    tick: async () => {},
    skipToEnd: async () => {},
    cursor: () => ({ offset: 0 }),
    state: () => null,
    degraded: () => false,
    ...overrides,
  }
}

describe('rows the watcher never checked during the turn are not shown again after it', () => {
  it('codex exec resume, on the real 0.155.0 sample: QA\'s exact sequence', async () => {
    const key = sessionStreamKey('codex', CODEX_THREAD)
    const path = transcript('.codex/sessions', `rollout-2026-09-19T18-06-50-${CODEX_THREAD}.jsonl`)
    const seen = subscribe(key)
    // The watcher a Sessions subscriber holds, opened before the turn. Its timer is 60 s,
    // so it makes NO check during the turn: the 1 s poll's case whenever the turn's last
    // writes land after its last check.
    const tailer = createTranscriptTailer({ key, path, provider: 'codex', offset: 0 })
    const release = acquireTranscriptWatcher({ key, path, provider: 'codex', offset: 0, intervalMs: 60_000, tailer })

    const live = createAttachedTurnStream({ provider: 'codex', sessionId: CODEX_THREAD })
    appendFileSync(path, rolloutRow('msg_1', 'I’ll run the command now.'))
    live.observeStdout(CODEX_SAMPLE)
    appendFileSync(path, rolloutRow('msg_2', 'done'))
    await live.finish('done')
    expect(isAttachedTurnActive(key)).toBe(false)
    // The watcher's first check after the release.
    await tailer.tick()

    // Before the fix this ended `status:done, status:done, status:working,
    // prose:I’ll run the command now., prose:done`.
    expect(seen.map(label)).toEqual([
      'status:working',
      'status:working',
      'prose:I’ll run the command now.',
      'tool:bash echo COS_CANARY',
      'status:working',
      'prose:done',
      'status:done',
      'status:done',
    ])
    expect(workingAfterDone(seen)).toBe(false)

    // Control: the watcher is live after the turn, so the silence above is the catch-up
    // and not a dead tail. What Codex writes next still streams.
    appendFileSync(path, rolloutRow('msg_3', 'after the turn'))
    await tailer.tick()
    expect(prose(seen)).toEqual(['prose:I’ll run the command now.', 'prose:done', 'prose:after the turn'])
    release()
  })

  it('claude -p, on the stream-json run the Messages trail fixtures pin', async () => {
    const key = sessionStreamKey('claude', CLAUDE_SESSION)
    const path = transcript('.claude/projects/-Users-example-project', `${CLAUDE_SESSION}.jsonl`)
    const seen = subscribe(key)
    const tailer = createTranscriptTailer({ key, path, provider: 'claude', offset: 0 })
    const release = acquireTranscriptWatcher({ key, path, provider: 'claude', offset: 0, intervalMs: 60_000, tailer })

    // stdout carries the whole stream; the transcript carries the message records, which
    // is what Claude Code persists (the stream events and `result` are stdout only).
    const stdout = CLAUDE_RUN.map(record => `${JSON.stringify(record)}\n`).join('')
    const persisted = (CLAUDE_RUN as Array<{ type?: string }>).filter(r => r.type === 'assistant' || r.type === 'user')
    expect(persisted.length).toBeGreaterThan(0)

    const live = createAttachedTurnStream({ provider: 'claude', sessionId: CLAUDE_SESSION })
    for (const record of persisted) appendFileSync(path, `${JSON.stringify(record)}\n`)
    live.observeStdout(stdout)
    await live.finish('done')
    expect(isAttachedTurnActive(key)).toBe(false)
    await tailer.tick()

    expect(seen.map(label)).toEqual([
      'status:working',
      'status:working',
      "prose:I'll check the config first.",
      'tool:read config.json',
      'status:working',
      'prose:The config sets port 3141.',
      'status:done',
      'status:done',
    ])
    expect(workingAfterDone(seen)).toBe(false)

    appendFileSync(path, assistantRow('after the turn'))
    await tailer.tick()
    expect(prose(seen)).toEqual(["prose:I'll check the config first.", 'prose:The config sets port 3141.', 'prose:after the turn'])
    release()
  })

  it('goes to the RAW end of file: a record cut mid-write cannot swallow the next real one', async () => {
    const key = sessionStreamKey('claude', CLAUDE_SESSION)
    const path = transcript('.claude/projects/-Users-example-project', `${CLAUDE_SESSION}.jsonl`)
    const seen = subscribe(key)
    const tailer = createTranscriptTailer({ key, path, provider: 'claude', offset: 0 })
    const release = acquireTranscriptWatcher({ key, path, provider: 'claude', offset: 0, intervalMs: 60_000, tailer })

    const live = createAttachedTurnStream({ provider: 'claude', sessionId: CLAUDE_SESSION })
    appendFileSync(path, assistantRow('the turn reply'))
    live.observeStdout(assistantRow('the turn reply'))
    // The child is killed mid-write: a record with no newline, never completed.
    appendFileSync(path, assistantRow('cut off').slice(0, 40))
    await live.finish('idle')
    await tailer.tick()

    // Stopping at the last newline would read the cut bytes and this row as ONE line,
    // which does not parse, and the desktop's next reply would never appear.
    appendFileSync(path, assistantRow('the next desktop reply'))
    await tailer.tick()
    expect(prose(seen)).toEqual(['prose:the turn reply', 'prose:the next desktop reply'])
    release()
  })
})

describe('the catch-up is ordered with the watcher\'s own checks', () => {
  it('waits for a check already in flight, so that check reads the hold-off while it holds', async () => {
    const key = sessionStreamKey('codex', CODEX_THREAD)
    const log: string[] = []
    let settleTick = (): void => {}
    const tailer = fakeTailer({
      tick: () => new Promise<void>(resolve => {
        log.push('tick started')
        settleTick = () => {
          log.push(`tick settled, held=${isAttachedTurnActive(key)}`)
          resolve()
        }
      }),
      skipToEnd: async () => { log.push(`skip to end, held=${isAttachedTurnActive(key)}`) },
    })
    const live = createAttachedTurnStream({ provider: 'codex', sessionId: CODEX_THREAD, publish: () => {} })
    // The real timer path, shortened: its check starts during the turn and does not settle.
    const release = acquireTranscriptWatcher({ key, path: '/nonexistent', provider: 'codex', offset: 0, intervalMs: 5, tailer })
    await until(() => log.includes('tick started'))

    const finished = live.finish('done')
    try {
      await sleep(40)
      // Still held while that check runs, and the timer started no second pass beside it.
      expect(isAttachedTurnActive(key)).toBe(true)
      expect(log).toEqual(['tick started'])

      settleTick()
      await finished
      expect(log.slice(0, 3)).toEqual(['tick started', 'tick settled, held=true', 'skip to end, held=true'])
      expect(isAttachedTurnActive(key)).toBe(false)
    } finally {
      // A failed assertion must not leave a catch-up pending into the next test.
      settleTick()
      await finished
      release()
    }
  })

  it('the timer starts no check beside the held pass, which could move the cursor back', async () => {
    const key = sessionStreamKey('codex', CODEX_THREAD)
    let ticks = 0
    let skipStarted = false
    let settleSkip = (): void => {}
    const tailer = fakeTailer({
      tick: async () => { ticks++ },
      skipToEnd: () => new Promise<void>(resolve => {
        skipStarted = true
        settleSkip = resolve
      }),
    })
    const live = createAttachedTurnStream({ provider: 'codex', sessionId: CODEX_THREAD, publish: () => {} })
    const release = acquireTranscriptWatcher({ key, path: '/nonexistent', provider: 'codex', offset: 0, intervalMs: 5, tailer })
    await until(() => ticks > 0)

    const finished = live.finish('done')
    try {
      await until(() => skipStarted)
      const ticksAtSkip = ticks
      await sleep(40)
      expect(ticks).toBe(ticksAtSkip)
      expect(isAttachedTurnActive(key)).toBe(true)

      settleSkip()
      await finished
      expect(isAttachedTurnActive(key)).toBe(false)
      // And the timer resumes once the pass is done.
      await until(() => ticks > ticksAtSkip)
    } finally {
      settleSkip()
      await finished
      release()
    }
  })

  it('releases at once, with no catch-up, when nothing tails the session', () => {
    const key = sessionStreamKey('codex', CODEX_THREAD)
    const live = createAttachedTurnStream({ provider: 'codex', sessionId: CODEX_THREAD, publish: () => {} })
    void live.finish('done')
    expect(isAttachedTurnActive(key)).toBe(false)
  })
})

describe('a watcher that hangs or throws cannot wedge finish()', () => {
  async function finishAgainst(tailer: TranscriptTailer, intervalMs: number, waitForTick: () => boolean) {
    const key = sessionStreamKey('codex', CODEX_THREAD)
    const seen = subscribe(key)
    const live = createAttachedTurnStream({ provider: 'codex', sessionId: CODEX_THREAD })
    const release = acquireTranscriptWatcher({ key, path: '/nonexistent', provider: 'codex', offset: 0, intervalMs, tailer })
    await until(waitForTick)
    const before = transcriptCatchUpCounts()
    const startedAt = Date.now()
    const finished = live.finish('done')
    // Recorded, not asserted, here: an assertion before the wait would leave this catch-up
    // pending into the next test.
    const returnedIn = Date.now() - startedAt
    const lastOnReturn = seen.map(label).at(-1)
    const outcome = await Promise.race([
      finished.then(() => 'released' as const),
      sleep(CATCH_UP_TIMEOUT_MS + 2_000).then(() => 'wedged' as const),
    ])
    const elapsed = Date.now() - startedAt
    const after = transcriptCatchUpCounts()
    release()
    // finish() itself returns at once, and the terminal status is already on the stream.
    expect(returnedIn).toBeLessThan(100)
    expect(lastOnReturn).toBe('status:done')
    return { key, outcome, elapsed, before, after }
  }

  it('a check in flight that never settles: released on the bound, and counted', async () => {
    let started = false
    const tailer = fakeTailer({ tick: () => { started = true; return new Promise<void>(() => {}) } })
    const run = await finishAgainst(tailer, 5, () => started)
    expect(run.outcome).toBe('released')
    expect(run.elapsed).toBeGreaterThanOrEqual(CATCH_UP_TIMEOUT_MS - 20)
    expect(run.elapsed).toBeLessThan(CATCH_UP_TIMEOUT_MS + 1_000)
    expect(isAttachedTurnActive(run.key)).toBe(false)
    expect(run.after.timedOut).toBe(run.before.timedOut + 1)
  })

  it('a catch-up pass that never settles: released on the bound, and counted', async () => {
    const tailer = fakeTailer({ skipToEnd: () => new Promise<void>(() => {}) })
    const run = await finishAgainst(tailer, 60_000, () => true)
    expect(run.outcome).toBe('released')
    expect(run.elapsed).toBeGreaterThanOrEqual(CATCH_UP_TIMEOUT_MS - 20)
    expect(isAttachedTurnActive(run.key)).toBe(false)
    expect(run.after.timedOut).toBe(run.before.timedOut + 1)
  })

  it('a catch-up pass that throws: released at once, and counted', async () => {
    const tailer = fakeTailer({ skipToEnd: () => { throw new Error('EIO') } })
    const run = await finishAgainst(tailer, 60_000, () => true)
    expect(run.outcome).toBe('released')
    expect(run.elapsed).toBeLessThan(CATCH_UP_TIMEOUT_MS)
    expect(isAttachedTurnActive(run.key)).toBe(false)
    expect(run.after.failed).toBe(run.before.failed + 1)
    expect(run.after.timedOut).toBe(run.before.timedOut)
  })

  it('a check in flight that rejects: the held pass still runs after it, and nothing is counted', async () => {
    const key = sessionStreamKey('codex', CODEX_THREAD)
    let ticksStarted = 0
    let failTick = (): void => {}
    let skippedHeld: boolean | null = null
    const tailer = fakeTailer({
      tick: () => new Promise<void>((_resolve, reject) => {
        ticksStarted++
        failTick = () => reject(new Error('EIO'))
      }),
      skipToEnd: async () => { skippedHeld = isAttachedTurnActive(key) },
    })
    const live = createAttachedTurnStream({ provider: 'codex', sessionId: CODEX_THREAD, publish: () => {} })
    const release = acquireTranscriptWatcher({ key, path: '/nonexistent', provider: 'codex', offset: 0, intervalMs: 5, tailer })
    await until(() => ticksStarted > 0)
    const before = transcriptCatchUpCounts()
    const startedAt = Date.now()
    const finished = live.finish('done')
    try {
      // The check the catch-up is waiting on fails, which a real tick never does.
      failTick()
      await finished
      expect(Date.now() - startedAt).toBeLessThan(CATCH_UP_TIMEOUT_MS)
      expect(skippedHeld).toBe(true)
      expect(isAttachedTurnActive(key)).toBe(false)
      expect(transcriptCatchUpCounts()).toEqual(before)
    } finally {
      failTick()
      await finished
      release()
    }
  })
})
