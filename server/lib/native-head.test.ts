// Behavioral tests for the native-head watermark, against a real filesystem.
//
// WHY DOT-DIRECTORY FIXTURES. Both production roots are dot directories
// (`~/.claude/projects`, `~/.codex/sessions`). A bare `mkdtemp` root cannot
// contain a dot component, and this repo has already shipped a bug that stayed
// invisible for exactly that reason — `res.sendFile` refuses any absolute path
// with a dot component, so every audio route 404'd on a default install while a
// mktemp-rooted suite stayed green. Every root here is `<mkdtemp>/.claude/...`
// or `<mkdtemp>/.codex/...`.
//
// WHY REAL DEPS. Almost every test runs `realNativeHeadDeps(dirs)`, so the
// production `readTail`, `readDir`, `fileExists` and `dirExists` are the code
// under test. Fakes appear only where the real filesystem cannot express the
// case (a throwing dependency, a short read).
//
// WHAT IS ASSERTED. The outcome a caller depends on: the token a comparison
// will be made against, and whether two observations compare equal. Nothing
// asserts on source text, and nothing re-implements the digest — a test that
// recomputed SHA-256 itself would pass with the classifier deleted.
//
// FIXTURE CONTENT IS INVENTED. The row SHAPES are copied from a schema census
// of the real transcripts on this machine (key names and type labels only); the
// text inside them is fabricated for this file.

import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HEAD_ROW_COUNT,
  NATIVE_HEAD_TOKEN_RE,
  TAIL_WINDOW_BYTES,
  headsDiffer,
  isNativeHeadToken,
  nativeHead,
  realNativeHeadDeps,
  realNativeHeadDirs,
  type NativeHeadDeps,
  type NativeHeadDirs,
} from './native-head.js'

const THREAD = '9dc7fc6f-04d5-46b7-a1c2-ba3ec91364a0'
const OTHER_THREAD = '019fc80a-cc79-7921-8541-298e71695afd'
const CODEX_THREAD = '01a00621-3e75-7ce1-ab95-375200d6f9be'

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

let root = ''
let dirs: NativeHeadDirs
let deps: NativeHeadDeps

/** `<mkdtemp>/.claude/projects` and `<mkdtemp>/.codex/sessions`. Dot components on purpose. */
function makeRoots(): void {
  root = mkdtempSync(join(tmpdir(), 'cos-native-head-'))
  dirs = {
    claudeProjectsDir: join(root, '.claude', 'projects'),
    codexSessionsDir: join(root, '.codex', 'sessions'),
  }
  mkdirSync(dirs.claudeProjectsDir, { recursive: true })
  mkdirSync(dirs.codexSessionsDir, { recursive: true })
  deps = realNativeHeadDeps(dirs)
}

beforeEach(makeRoots)

/** Directories chmod'ed to 000 by a test, so afterEach can still remove the tree. */
let locked: string[] = []

function lock(path: string): void {
  locked.push(path)
  chmodSync(path, 0o000)
}

afterEach(() => {
  for (const path of locked) {
    try {
      chmodSync(path, 0o755)
    } catch {
      /* already gone */
    }
  }
  locked = []
  if (!root) return
  rmSync(root, { recursive: true, force: true })
  root = ''
})

// ---------------------------------------------------------------------------
// Claude fixture rows. Shapes from the schema census; text invented.
// ---------------------------------------------------------------------------

let uuidCounter = 0
function nextUuid(): string {
  uuidCounter += 1
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`
}

const BASE = {
  parentUuid: null as string | null,
  isSidechain: false,
  userType: 'external',
  cwd: '/private/tmp/fixture-workspace',
  sessionId: THREAD,
  version: '2.1.226',
  gitBranch: 'main',
  entrypoint: 'claude-code',
  timestamp: '2026-08-16T00:00:00.000Z',
}

function claudeUserRow(text: string): string {
  return JSON.stringify({
    ...BASE,
    type: 'user',
    message: { role: 'user', content: text },
    promptId: `prompt_${nextUuid()}`,
    uuid: nextUuid(),
  })
}

function claudeAssistantRow(text: string): string {
  return JSON.stringify({
    ...BASE,
    type: 'assistant',
    effort: 'high',
    requestId: `req_${nextUuid()}`,
    message: {
      id: `msg_${nextUuid()}`,
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 12, output_tokens: 34 },
    },
    uuid: nextUuid(),
  })
}

/** Injected context. Carries a `message` but is not something the user typed. */
function claudeMetaUserRow(text: string): string {
  return JSON.stringify({
    ...BASE,
    type: 'user',
    isMeta: true,
    message: { role: 'user', content: text },
    promptId: `prompt_${nextUuid()}`,
    uuid: nextUuid(),
  })
}

/**
 * Everything a resumed CLI can write at spawn, before a prompt byte is
 * delivered. The 2.2 canary's final row was the `mode` one.
 */
function claudeSpawnRows(): string[] {
  return [
    JSON.stringify({ type: 'mode', mode: 'default', sessionId: THREAD }),
    JSON.stringify({ type: 'custom-title', customTitle: 'fixture thread', sessionId: THREAD }),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'earlier ask', leafUuid: nextUuid(), sessionId: THREAD }),
    JSON.stringify({ type: 'queue-operation', operation: 'clear', sessionId: THREAD, timestamp: BASE.timestamp }),
    JSON.stringify({
      ...BASE,
      type: 'attachment',
      attachment: { type: 'directory_context', path: '/private/tmp/fixture-workspace' },
      uuid: nextUuid(),
    }),
    JSON.stringify({
      ...BASE,
      type: 'system',
      subtype: 'hook',
      level: 'info',
      hasOutput: false,
      hookCount: 1,
      uuid: nextUuid(),
    }),
    claudeMetaUserRow('Caveat: the messages below were generated while running local commands.'),
  ]
}

/**
 * Two shapes that split the classifier's AND apart.
 *
 * Deliberately synthetic: the census found no real Claude row that has one half
 * without the other, so no natural fixture can show that BOTH halves are load-
 * bearing. Without these, dropping either half is undetectable.
 */
function claudeHalfShapedRows(): string[] {
  return [
    // Conversational type, no message: a marker row, not a turn.
    JSON.stringify({ ...BASE, type: 'user', toolProgress: { state: 'running' }, uuid: nextUuid() }),
    // A message object hanging off a bookkeeping row.
    JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      sessionId: THREAD,
      message: { role: 'user', content: 'queued, not delivered' },
      timestamp: BASE.timestamp,
    }),
  ]
}

/** A plausible opening exchange plus a spawn tail, as a real transcript looks. */
function claudeTranscriptLines(): string[] {
  return [
    JSON.stringify({ type: 'custom-title', customTitle: 'fixture thread', sessionId: THREAD }),
    claudeMetaUserRow('Caveat: the messages below were generated while running local commands.'),
    claudeUserRow('Draft the release note for the watermark change.'),
    claudeAssistantRow('Here is a first pass at the release note.'),
    JSON.stringify({ type: 'mode', mode: 'default', sessionId: THREAD }),
    claudeUserRow('Tighten the second paragraph.'),
    claudeAssistantRow('Tightened. The second paragraph now leads with the limit.'),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'Tighten the second paragraph.', leafUuid: nextUuid(), sessionId: THREAD }),
    claudeUserRow('Good. Add the measured window size.'),
    claudeAssistantRow('Added, with the eight measured distances behind it.'),
    JSON.stringify({ type: 'mode', mode: 'plan', sessionId: THREAD }),
  ]
}

function claudeProjectDir(slug: string): string {
  const dir = join(dirs.claudeProjectsDir, slug)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeClaude(slug: string, lines: string[], threadId = THREAD): string {
  const path = join(claudeProjectDir(slug), `${threadId}.jsonl`)
  writeFileSync(path, lines.length ? `${lines.join('\n')}\n` : '')
  return path
}

function append(path: string, text: string): void {
  appendFileSync(path, text)
}

function appendLines(path: string, lines: string[]): void {
  append(path, `${lines.join('\n')}\n`)
}

// ---------------------------------------------------------------------------
// Codex fixture rows.
// ---------------------------------------------------------------------------

function codexRow(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: '2026-08-16T00:00:00.000Z', type, payload })
}

function codexSessionMeta(): string {
  return codexRow('session_meta', {
    id: CODEX_THREAD,
    cwd: '/private/tmp/fixture-workspace',
    originator: 'codex_cli_rs',
    cli_version: '0.148.0-alpha.9',
  })
}

/** The instruction block injected on open AND on resume. Spawn-time by definition. */
function codexDeveloperRow(text: string): string {
  return codexRow('response_item', {
    type: 'message',
    role: 'developer',
    id: `dev_${nextUuid()}`,
    content: [{ type: 'input_text', text }],
  })
}

function codexUserRow(text: string): string {
  return codexRow('response_item', {
    type: 'message',
    role: 'user',
    id: `usr_${nextUuid()}`,
    content: [{ type: 'input_text', text }],
  })
}

function codexAssistantRow(text: string): string {
  return codexRow('response_item', {
    type: 'message',
    role: 'assistant',
    id: `ast_${nextUuid()}`,
    phase: null,
    content: [{ type: 'output_text', text }],
  })
}

function codexAgentMessageEvent(text: string): string {
  return codexRow('event_msg', { type: 'agent_message', message: text, phase: null })
}

function codexTranscriptLines(): string[] {
  return [
    codexSessionMeta(),
    codexRow('turn_context', { cwd: '/private/tmp/fixture-workspace', approval_policy: 'never' }),
    codexDeveloperRow('You are a coding agent running in the Codex CLI.'),
    codexUserRow('Summarize the rollout format.'),
    codexRow('event_msg', { type: 'user_message', message: 'Summarize the rollout format.', images: null }),
    codexRow('response_item', { type: 'reasoning', id: `rsn_${nextUuid()}`, summary: [] }),
    codexAssistantRow('A rollout is JSONL, one row per event.'),
    codexAgentMessageEvent('A rollout is JSONL, one row per event.'),
    codexRow('event_msg', { type: 'token_count', info: { total_tokens: 1234 } }),
  ]
}

function writeCodexRollout(
  date: { y: string; m: string; d: string },
  lines: string[],
  threadId = CODEX_THREAD,
  stamp = '2026-08-16T00-00-00',
): string {
  const dir = join(dirs.codexSessionsDir, date.y, date.m, date.d)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-${stamp}-${threadId}.jsonl`)
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

const AUG16 = { y: '2026', m: '08', d: '16' }
const AUG15 = { y: '2026', m: '08', d: '15' }

// ---------------------------------------------------------------------------

describe('nativeHead — Claude', () => {
  it('returns a fixed-shape opaque token for a real-shape transcript', () => {
    writeClaude('-private-tmp-fixture-workspace', claudeTranscriptLines())

    const head = nativeHead('claude', THREAD, deps)

    expect(head).toMatch(NATIVE_HEAD_TOKEN_RE)
    expect(isNativeHeadToken(head)).toBe(true)
  })

  it('does not leak transcript content, thread size, or the project path into the token', () => {
    // Same last three message rows, wildly different history and file size, and
    // a different project folder. If any of those reached the digest, the two
    // tokens would differ.
    const tail = [
      claudeUserRow('final ask'),
      claudeAssistantRow('final answer'),
      claudeUserRow('acknowledged'),
    ]
    const smallPath = writeClaude('-slug-one', tail)
    const small = nativeHead('claude', THREAD, deps)
    expect(small).toMatch(NATIVE_HEAD_TOKEN_RE)
    rmSync(smallPath)

    const history: string[] = []
    for (let i = 0; i < 400; i++) {
      history.push(claudeUserRow(`history question ${i} ${'x'.repeat(200)}`))
      history.push(claudeAssistantRow(`history answer ${i} ${'y'.repeat(200)}`))
    }
    writeClaude('-a-completely-different-slug', [...history, ...tail])
    const large = nativeHead('claude', THREAD, deps)

    expect(large).toBe(small)
    expect(large).toHaveLength(36)
  })

  it('gives two threads different tokens even when their rows are byte-identical', () => {
    // Byte-identical rows on purpose: no sessionId, no uuid, nothing that
    // differs between the two files. Only the thread id salt separates them, so
    // a caller that compares one thread's stored head against another thread's
    // live head gets `changed`, never a false `same`.
    const identical = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'same bytes' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'same bytes' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'same bytes' } }),
    ]
    writeClaude('-slug-one', identical, THREAD)
    writeClaude('-slug-two', identical, OTHER_THREAD)

    const a = nativeHead('claude', THREAD, deps)
    const b = nativeHead('claude', OTHER_THREAD, deps)

    expect(a).toMatch(NATIVE_HEAD_TOKEN_RE)
    expect(b).toMatch(NATIVE_HEAD_TOKEN_RE)
    expect(headsDiffer(a, b)).toBe('changed')
  })

  it('a torn trailing row does not throw and does not move the head', () => {
    const path = writeClaude('-slug', claudeTranscriptLines())
    const before = nativeHead('claude', THREAD, deps)

    // An append caught mid-write: a real, complete row cut off partway.
    const torn = claudeAssistantRow('this row was still being written')
    append(path, torn.slice(0, Math.floor(torn.length / 2)))

    expect(nativeHead('claude', THREAD, deps)).toBe(before)
  })

  it('completes the torn row and the head then moves', () => {
    const path = writeClaude('-slug', claudeTranscriptLines())
    const before = nativeHead('claude', THREAD, deps)

    const row = claudeAssistantRow('a completed desktop turn')
    const cut = Math.floor(row.length / 2)
    append(path, row.slice(0, cut))
    expect(nativeHead('claude', THREAD, deps)).toBe(before)

    append(path, `${row.slice(cut)}\n`)
    expect(nativeHead('claude', THREAD, deps)).not.toBe(before)
  })

  it('spawn-time rows written before prompt delivery do not move the head', () => {
    // THE load-bearing case (plan 4.3). A resume that aborts before stdin still
    // appends session/mode rows. A naive head advances here and the next
    // attempt reports `native_thread_changed` while its own journal says the
    // delivery aborted.
    const path = writeClaude('-slug', claudeTranscriptLines())
    const before = nativeHead('claude', THREAD, deps)
    expect(before).toMatch(NATIVE_HEAD_TOKEN_RE)

    appendLines(path, claudeSpawnRows())

    expect(nativeHead('claude', THREAD, deps)).toBe(before)
    expect(headsDiffer(before, nativeHead('claude', THREAD, deps))).toBe('same')
  })

  it('requires both a conversational type and a message object, not either one', () => {
    const path = writeClaude('-slug', claudeTranscriptLines())
    const before = nativeHead('claude', THREAD, deps)

    appendLines(path, claudeHalfShapedRows())

    expect(nativeHead('claude', THREAD, deps)).toBe(before)
  })

  it('a completed assistant turn moves the head', () => {
    const path = writeClaude('-slug', claudeTranscriptLines())
    const before = nativeHead('claude', THREAD, deps)

    appendLines(path, [claudeAssistantRow('a real desktop reply landed here')])
    const after = nativeHead('claude', THREAD, deps)

    expect(after).toMatch(NATIVE_HEAD_TOKEN_RE)
    expect(headsDiffer(before, after)).toBe('changed')
  })

  it('a completed user turn moves the head', () => {
    const path = writeClaude('-slug', claudeTranscriptLines())
    const before = nativeHead('claude', THREAD, deps)

    appendLines(path, [claudeUserRow('typed straight into the desktop app')])

    expect(headsDiffer(before, nativeHead('claude', THREAD, deps))).toBe('changed')
  })

  it('two message rows appended in one desktop turn move the head once, to a new value', () => {
    const path = writeClaude('-slug', claudeTranscriptLines())
    const before = nativeHead('claude', THREAD, deps)

    appendLines(path, [claudeUserRow('follow-up'), claudeAssistantRow('reply')])
    const after = nativeHead('claude', THREAD, deps)

    expect(after).not.toBe(before)
    expect(nativeHead('claude', THREAD, deps)).toBe(after)
  })

  it('follows the transcript when the thread moves to another project folder', () => {
    const path = writeClaude('-slug-before-move', claudeTranscriptLines())
    const before = nativeHead('claude', THREAD, deps)

    const moved = join(claudeProjectDir('-slug-after-move'), `${THREAD}.jsonl`)
    renameSync(path, moved)

    expect(nativeHead('claude', THREAD, deps)).toBe(before)
  })

  it('refuses when the same thread id exists under two project folders', () => {
    writeClaude('-slug-one', claudeTranscriptLines())
    writeClaude('-slug-two', claudeTranscriptLines())

    expect(nativeHead('claude', THREAD, deps)).toBeNull()
  })

  it('refuses when no transcript exists for the thread', () => {
    writeClaude('-slug', claudeTranscriptLines(), OTHER_THREAD)

    expect(nativeHead('claude', THREAD, deps)).toBeNull()
  })

  it('refuses when the projects directory does not exist', () => {
    rmSync(dirs.claudeProjectsDir, { recursive: true, force: true })

    expect(nativeHead('claude', THREAD, deps)).toBeNull()
  })

  it.skipIf(isRoot)('refuses when the projects directory is unreadable', () => {
    writeClaude('-slug', claudeTranscriptLines())
    expect(nativeHead('claude', THREAD, deps)).toMatch(NATIVE_HEAD_TOKEN_RE)

    // readDir must throw here. Softened to `[]` it would read as "no project
    // folders", which is indistinguishable from a clean empty install.
    lock(dirs.claudeProjectsDir)

    expect(nativeHead('claude', THREAD, deps)).toBeNull()
  })

  it.skipIf(isRoot)('refuses when the transcript itself is unreadable', () => {
    const path = writeClaude('-slug', claudeTranscriptLines())
    lock(path)

    expect(nativeHead('claude', THREAD, deps)).toBeNull()
  })

  it('refuses on a corrupt row in the middle of the window', () => {
    const lines = claudeTranscriptLines()
    lines.splice(4, 0, '{"type":"assistant","message":{"role":"assist')
    writeClaude('-slug', lines)

    expect(nativeHead('claude', THREAD, deps)).toBeNull()
  })

  it('refuses a transcript that carries no message-bearing rows', () => {
    writeClaude('-slug', claudeSpawnRows())

    expect(nativeHead('claude', THREAD, deps)).toBeNull()
  })

  it('refuses an empty transcript', () => {
    writeClaude('-slug', [])

    expect(nativeHead('claude', THREAD, deps)).toBeNull()
  })

  it('refuses a malformed or truncated thread id', () => {
    writeClaude('-slug', claudeTranscriptLines())

    for (const bad of [
      THREAD.slice(0, 8),
      THREAD.toUpperCase(),
      `../../${THREAD}`,
      `${THREAD}/x`,
      '',
      'not-a-uuid',
    ]) {
      expect(nativeHead('claude', bad, deps)).toBeNull()
    }
  })

  it('refuses providers without a certified transcript shape', () => {
    // BOTH stores are populated under the same id. A gate that merely falls
    // through to the other provider's reader would answer with that provider's
    // token instead of refusing, and Cursor is Fork-only precisely because its
    // transcript shape has never been certified.
    writeClaude('-slug', claudeTranscriptLines())
    writeCodexRollout(AUG16, codexTranscriptLines(), THREAD)
    expect(nativeHead('claude', THREAD, deps)).toMatch(NATIVE_HEAD_TOKEN_RE)
    expect(nativeHead('codex', THREAD, deps)).toMatch(NATIVE_HEAD_TOKEN_RE)

    for (const provider of ['cursor', 'CLAUDE', '', 'claude-code', 'bogus']) {
      expect(nativeHead(provider, THREAD, deps)).toBeNull()
    }
  })

  it('refuses rather than raising when a dependency throws', () => {
    writeClaude('-slug', claudeTranscriptLines())
    const boom = (): never => {
      throw new Error('probe exploded')
    }

    expect(nativeHead('claude', THREAD, { ...deps, readDir: boom })).toBeNull()
    expect(nativeHead('claude', THREAD, { ...deps, dirExists: boom })).toBeNull()
    expect(nativeHead('claude', THREAD, { ...deps, fileExists: boom })).toBeNull()
    expect(nativeHead('claude', THREAD, { ...deps, readTail: boom })).toBeNull()
  })

  it('refuses when the tail read reports itself unreadable', () => {
    writeClaude('-slug', claudeTranscriptLines())

    expect(nativeHead('claude', THREAD, { ...deps, readTail: () => null })).toBeNull()
  })

  it('refuses when a directory listing exceeds the project-folder ceiling', () => {
    // The real slug is IN the flood list, so without the ceiling this resolves
    // to a perfectly good token after 2049 stats. The refusal has to come from
    // the ceiling itself, not from failing to find anything.
    writeClaude('-slug', claudeTranscriptLines())
    const listing = [...Array.from({ length: 2048 }, (_, i) => `slug-${i}`), '-slug']
    const flood = { ...deps, readDir: () => listing }

    expect(nativeHead('claude', THREAD, flood)).toBeNull()
    expect(nativeHead('claude', THREAD, { ...deps, readDir: () => listing.slice(-1) }))
      .toMatch(NATIVE_HEAD_TOKEN_RE)
  })
})

describe('nativeHead — Claude, windowed tail', () => {
  // The window is injectable so truncation is reachable without a multi-megabyte
  // fixture. One production-sized case follows this block, because a small
  // window alone cannot show that TAIL_WINDOW_BYTES is large enough to be useful.
  const SMALL_WINDOW = 4096

  function windowed(bytes: number): NativeHeadDeps {
    return { ...deps, tailWindowBytes: bytes }
  }

  it('tracks the last three message rows when the window has slid past the file start', () => {
    const padding = Array.from({ length: 40 }, (_, i) => claudeUserRow(`old turn ${i}`))
    const path = writeClaude('-slug', [
      ...padding,
      claudeUserRow('recent ask'),
      claudeAssistantRow('recent answer'),
      claudeUserRow('recent follow-up'),
    ])
    const small = windowed(SMALL_WINDOW)

    const before = nativeHead('claude', THREAD, small)
    expect(before).toMatch(NATIVE_HEAD_TOKEN_RE)
    // The whole-file reading must agree: the head is a function of the last
    // three message rows, not of which bytes happened to be in view.
    expect(nativeHead('claude', THREAD, deps)).toBe(before)

    // Spawn rows slide the window forward. The last three message rows are
    // still inside it, so the head must not move.
    appendLines(path, claudeSpawnRows())
    expect(nativeHead('claude', THREAD, small)).toBe(before)

    appendLines(path, [claudeAssistantRow('a genuine new desktop turn')])
    expect(headsDiffer(before, nativeHead('claude', THREAD, small))).toBe('changed')
  })

  it('refuses when a truncated window shows no complete message row at all', () => {
    const fat = 'z'.repeat(SMALL_WINDOW)
    writeClaude('-slug', [
      claudeUserRow(`old ${fat}`),
      claudeAssistantRow(`old ${fat}`),
      claudeUserRow(`newest ${fat}`),
    ])

    expect(nativeHead('claude', THREAD, windowed(SMALL_WINDOW))).toBeNull()
    // Same file, whole-file read: three rows are visible, so a token is fine.
    expect(nativeHead('claude', THREAD, deps)).toMatch(NATIVE_HEAD_TOKEN_RE)
  })

  it('refuses when a truncated window shows two complete message rows but not three', () => {
    // Sized off the real serialized rows so the boundary is exact rather than
    // approximate: one window holds two whole rows behind a fragment, the other
    // holds three. Same file, same guard, and only the third row differs — so a
    // token from the two-row window could only have come from hashing a short
    // set, which is the false-change this refusal prevents.
    const pad = 'z'.repeat(500)
    const tail = [
      claudeUserRow(`first ${pad}`),
      claudeAssistantRow(`second ${pad}`),
      claudeUserRow(`third ${pad}`),
    ]
    writeClaude('-slug', [
      ...Array.from({ length: 20 }, (_, i) => claudeUserRow(`old ${i} ${pad}`)),
      ...tail,
    ])

    const lastTwo = Buffer.byteLength(`${tail[1]}\n${tail[2]}\n`)
    const twoRows = lastTwo + Math.floor(Buffer.byteLength(tail[0]!) / 2)
    const threeRows = lastTwo + Buffer.byteLength(`${tail[0]}\n`) + 32

    expect(nativeHead('claude', THREAD, windowed(twoRows))).toBeNull()
    expect(nativeHead('claude', THREAD, windowed(threeRows))).toMatch(NATIVE_HEAD_TOKEN_RE)
    expect(nativeHead('claude', THREAD, windowed(threeRows))).toBe(nativeHead('claude', THREAD, deps))
  })

  /** A window holding exactly HEAD_ROW_COUNT message rows and nothing to spare. */
  function atTheBoundary(): { path: string; small: NativeHeadDeps } {
    const fat = 'z'.repeat(600)
    const path = writeClaude('-slug', [
      ...Array.from({ length: 20 }, (_, i) => claudeUserRow(`old ${i} ${fat}`)),
      claudeUserRow('a'),
      claudeAssistantRow('b'),
      claudeUserRow('c'),
    ])
    return { path, small: windowed(2048) }
  }

  it('accepts a truncated window that shows exactly three message rows', () => {
    const { small } = atTheBoundary()

    const head = nativeHead('claude', THREAD, small)

    expect(HEAD_ROW_COUNT).toBe(3)
    expect(head).toMatch(NATIVE_HEAD_TOKEN_RE)
    // The windowed and whole-file readings must agree, or the token would
    // depend on how much of the file happened to be in view.
    expect(nativeHead('claude', THREAD, deps)).toBe(head)
  })

  it('degrades to unknown, never to a false change, when a slide pushes a row out of view', () => {
    // The failure this guard exists for. With no headroom left, spawn-time rows
    // slide the third message row out of the window. Hashing the two that
    // remain would mint a DIFFERENT token and report `native_thread_changed`
    // for a run that delivered nothing. Unknown is the honest answer.
    const { path, small } = atTheBoundary()
    const head = nativeHead('claude', THREAD, small)

    appendLines(path, claudeSpawnRows())
    const after = nativeHead('claude', THREAD, small)

    expect(after).toBeNull()
    expect(headsDiffer(head, after)).toBe('unknown')
    // A whole-file read still sees all three rows, so this is a window limit,
    // not a claim that the thread changed.
    expect(nativeHead('claude', THREAD, deps)).toBe(head)
  })

  it('holds at the production window size on a transcript larger than it', () => {
    // Production value, no injection: proves 2 MiB actually reaches back past
    // the last three message rows on a file that exceeds it.
    const bulk = 'q'.repeat(64 * 1024)
    const lines: string[] = []
    for (let i = 0; i < 40; i++) lines.push(claudeAssistantRow(`bulk ${i} ${bulk}`))
    lines.push(claudeUserRow('final ask'), claudeAssistantRow('final answer'), claudeUserRow('ok'))
    const path = writeClaude('-slug', lines)

    const before = nativeHead('claude', THREAD, deps)
    expect(before).toMatch(NATIVE_HEAD_TOKEN_RE)
    expect(TAIL_WINDOW_BYTES).toBeGreaterThan(1024 * 1024)

    appendLines(path, claudeSpawnRows())
    expect(nativeHead('claude', THREAD, deps)).toBe(before)

    appendLines(path, [claudeAssistantRow('a genuine new desktop turn')])
    expect(headsDiffer(before, nativeHead('claude', THREAD, deps))).toBe('changed')
  })
})

describe('nativeHead — Codex', () => {
  it('locates a rollout under the date tree and returns a token', () => {
    writeCodexRollout(AUG16, codexTranscriptLines())

    expect(nativeHead('codex', CODEX_THREAD, deps)).toMatch(NATIVE_HEAD_TOKEN_RE)
  })

  it('spawn-time rows, including the developer instruction block, do not move the head', () => {
    // Codex re-injects the developer message on resume. It is the direct analogue
    // of Claude's spawn-time mode row and must not read as a desktop turn.
    const path = writeCodexRollout(AUG16, codexTranscriptLines())
    const before = nativeHead('codex', CODEX_THREAD, deps)
    expect(before).toMatch(NATIVE_HEAD_TOKEN_RE)

    appendLines(path, [
      codexSessionMeta(),
      codexRow('turn_context', { cwd: '/private/tmp/fixture-workspace', approval_policy: 'never' }),
      codexDeveloperRow('You are a coding agent running in the Codex CLI.'),
      codexRow('world_state', { files: [] }),
      codexRow('event_msg', { type: 'token_count', info: { total_tokens: 99 } }),
      codexRow('event_msg', { type: 'thread_settings_applied', settings: {} }),
      codexRow('response_item', { type: 'reasoning', id: `rsn_${nextUuid()}`, summary: [] }),
    ])

    expect(nativeHead('codex', CODEX_THREAD, deps)).toBe(before)
  })

  it('an agent message event moves the head', () => {
    const path = writeCodexRollout(AUG16, codexTranscriptLines())
    const before = nativeHead('codex', CODEX_THREAD, deps)

    appendLines(path, [codexAgentMessageEvent('a real desktop reply')])

    expect(headsDiffer(before, nativeHead('codex', CODEX_THREAD, deps))).toBe('changed')
  })

  it('an assistant response item moves the head', () => {
    const path = writeCodexRollout(AUG16, codexTranscriptLines())
    const before = nativeHead('codex', CODEX_THREAD, deps)

    appendLines(path, [codexAssistantRow('a real desktop reply')])

    expect(headsDiffer(before, nativeHead('codex', CODEX_THREAD, deps))).toBe('changed')
  })

  it('a user message typed on the desktop moves the head', () => {
    const path = writeCodexRollout(AUG16, codexTranscriptLines())
    const before = nativeHead('codex', CODEX_THREAD, deps)

    appendLines(path, [codexRow('event_msg', { type: 'user_message', message: 'typed here', images: null })])

    expect(headsDiffer(before, nativeHead('codex', CODEX_THREAD, deps))).toBe('changed')
  })

  it('refuses when two rollouts claim the same thread id', () => {
    writeCodexRollout(AUG15, codexTranscriptLines(), CODEX_THREAD, '2026-08-15T09-00-00')
    writeCodexRollout(AUG16, codexTranscriptLines())

    expect(nativeHead('codex', CODEX_THREAD, deps)).toBeNull()
  })

  it('ignores a file that carries the id but not the certified rollout name', () => {
    const dir = join(dirs.codexSessionsDir, AUG16.y, AUG16.m, AUG16.d)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `backup-2026-08-16T00-00-00-${CODEX_THREAD}.jsonl`), `${codexTranscriptLines().join('\n')}\n`)

    expect(nativeHead('codex', CODEX_THREAD, deps)).toBeNull()

    // And the certified name, in the same directory, does resolve.
    writeCodexRollout(AUG16, codexTranscriptLines())
    expect(nativeHead('codex', CODEX_THREAD, deps)).toMatch(NATIVE_HEAD_TOKEN_RE)
  })

  it('refuses when the sessions directory does not exist', () => {
    rmSync(dirs.codexSessionsDir, { recursive: true, force: true })

    expect(nativeHead('codex', CODEX_THREAD, deps)).toBeNull()
  })

  it.skipIf(isRoot)('refuses when a day directory cannot be listed, instead of answering from the rest', () => {
    writeCodexRollout(AUG15, codexTranscriptLines(), CODEX_THREAD, '2026-08-15T09-00-00')
    writeCodexRollout(AUG16, codexTranscriptLines())
    expect(nativeHead('codex', CODEX_THREAD, deps)).toBeNull()

    // Hide one of the two behind an unreadable directory. A readDir that
    // swallowed EACCES into `[]` would now see a single rollout and hand back a
    // confident token, having silently resolved an ambiguity it could not see.
    lock(join(dirs.codexSessionsDir, AUG15.y, AUG15.m, AUG15.d))

    expect(nativeHead('codex', CODEX_THREAD, deps)).toBeNull()
  })

  it('refuses a rollout with no message-bearing rows', () => {
    writeCodexRollout(AUG16, [
      codexSessionMeta(),
      codexRow('turn_context', { cwd: '/private/tmp/fixture-workspace' }),
      codexDeveloperRow('instructions only'),
      codexRow('event_msg', { type: 'token_count', info: { total_tokens: 1 } }),
    ])

    expect(nativeHead('codex', CODEX_THREAD, deps)).toBeNull()
  })

  it('keeps Claude and Codex heads distinct for the same thread id', () => {
    // A shared row set under both providers still produces different tokens, so
    // a provider mix-up in a caller reads as `changed`, never as `same`.
    const shared = [codexUserRow('a'), codexAssistantRow('b'), codexUserRow('c')]
    writeCodexRollout(AUG16, shared, THREAD)
    writeClaude('-slug', shared)

    const claude = nativeHead('claude', THREAD, deps)
    const codex = nativeHead('codex', THREAD, deps)

    expect(codex).toMatch(NATIVE_HEAD_TOKEN_RE)
    // Codex rows are not Claude message rows, so Claude sees nothing to hash.
    expect(claude).toBeNull()
    expect(headsDiffer(claude, codex)).toBe('unknown')
  })
})

describe('headsDiffer', () => {
  it('reports same only for two identical well-formed tokens', () => {
    writeClaude('-slug', claudeTranscriptLines())
    const head = nativeHead('claude', THREAD, deps)

    expect(headsDiffer(head, head)).toBe('same')
  })

  it('reports changed for two different well-formed tokens', () => {
    writeClaude('-slug', claudeTranscriptLines())
    const a = nativeHead('claude', THREAD, deps)
    writeCodexRollout(AUG16, codexTranscriptLines())
    const b = nativeHead('codex', CODEX_THREAD, deps)

    expect(headsDiffer(a, b)).toBe('changed')
  })

  it('treats null on either side as unknown, never as same', () => {
    writeClaude('-slug', claudeTranscriptLines())
    const head = nativeHead('claude', THREAD, deps)

    expect(headsDiffer(null, head)).toBe('unknown')
    expect(headsDiffer(head, null)).toBe('unknown')
    expect(headsDiffer(null, null)).toBe('unknown')
  })

  it('treats an unrecognised token as unknown, even against an identical copy', () => {
    for (const bad of [
      '',
      'nh1:',
      'nh1:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
      'nh1:0123456789abcdef',
      'nh1:0123456789abcdef0123456789abcdef0',
      'nh0:0123456789abcdef0123456789abcdef',
      '0123456789abcdef0123456789abcdef',
      'nh1:0123456789ABCDEF0123456789ABCDEF',
    ]) {
      expect(headsDiffer(bad, bad)).toBe('unknown')
      expect(isNativeHeadToken(bad)).toBe(false)
    }
  })

  it('treats non-string inputs as unknown', () => {
    const odd = [undefined, 0, 1, {}, [], true, NaN] as unknown as (string | null)[]
    for (const value of odd) expect(headsDiffer(value, value)).toBe('unknown')
  })
})

describe('realNativeHeadDirs / realNativeHeadDeps', () => {
  const saved = process.env.COS_AGENT_SESSIONS_HOME

  afterEach(() => {
    if (saved === undefined) delete process.env.COS_AGENT_SESSIONS_HOME
    else process.env.COS_AGENT_SESSIONS_HOME = saved
  })

  it('resolves both roots as dot directories under the agent-sessions home', () => {
    process.env.COS_AGENT_SESSIONS_HOME = root

    const resolved = realNativeHeadDirs()

    expect(resolved.claudeProjectsDir).toBe(join(root, '.claude', 'projects'))
    expect(resolved.codexSessionsDir).toBe(join(root, '.codex', 'sessions'))
  })

  it('reads a transcript end to end through the default, un-injected dependencies', () => {
    process.env.COS_AGENT_SESSIONS_HOME = root
    writeClaude('-slug', claudeTranscriptLines())

    // No dirs argument: the same call a route would make.
    const head = nativeHead('claude', THREAD, realNativeHeadDeps())

    expect(head).toMatch(NATIVE_HEAD_TOKEN_RE)
    expect(head).toBe(nativeHead('claude', THREAD, deps))
  })
})
