// The turn-request binding as the three CLI bridges actually use it (lib/turn-request.ts).
//
// Every assertion is taken at the wire: the file is read AT SPAWN TIME (what the child's hook
// could see), the hash is checked against the bytes the bridge wrote to the child's stdin
// (what the CLI hands its UserPromptSubmit hook), and argv/env are the exact values given to
// spawn(). A test that hashed a prompt it rebuilt itself would pass while the wire differed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

const state = vi.hoisted(() => {
  process.env.COS_DATA_DIR = `/tmp/cos-turn-request-bridges-test-${process.pid}-${Date.now()}`
  return {
    spawnMode: 'ok' as 'ok' | 'throw' | 'enoent',
    spawns: [] as Array<{
      binary: string
      args: string[]
      env: Record<string, string | undefined>
      file: null | { path: string; text: string; mode: number; dirMode: number }
      child: any
    }>,
    codexEngine: null as null | { codexThreadId: string; expiresAt: string },
    cursorEngine: null as null | { cursorSessionId: string; expiresAt: string },
    terminateProviderProcess: null as any,
  }
})

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  const fs = await import('node:fs')
  const path = await import('node:path')
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdinText = ''
    stdin = Object.assign(new EventEmitter(), {
      write: vi.fn((text: string) => { this.stdinText += text; return true }),
      end: vi.fn(),
    })
    pid: number | undefined = 5150
    exitCode = null
    signalCode = null
    kill = vi.fn()
  }
  return {
    spawn: vi.fn((binary: string, args: string[], options: { env: Record<string, string | undefined> }) => {
      const turnPath = options.env.COS_TURN_REQUEST_FILE
      let file = null
      if (turnPath && fs.existsSync(turnPath)) {
        file = {
          path: turnPath,
          text: fs.readFileSync(turnPath, 'utf8'),
          mode: fs.statSync(turnPath).mode & 0o777,
          dirMode: fs.statSync(path.dirname(turnPath)).mode & 0o777,
        }
      }
      const record = { binary, args: [...args], env: { ...options.env }, file, child: null as any }
      state.spawns.push(record)
      if (state.spawnMode === 'throw') throw new TypeError('spawn argv rejected')
      const child = new FakeChild()
      record.child = child
      if (state.spawnMode === 'enoent') {
        // What Node does for a missing binary (probed on v24): no pid, 'error', then 'close'.
        child.pid = undefined
        setImmediate(() => {
          child.emit('error', Object.assign(new Error(`spawn ${binary} ENOENT`), { code: 'ENOENT' }))
          child.emit('close', -2, null)
        })
      }
      return child
    }),
    spawnSync: vi.fn(() => ({ status: 0, stdout: '--add-dir', stderr: '' })),
  }
})

vi.mock('./python-bridge.js', () => ({ COS_SCRIPTS_DIR: '/tmp' }))
vi.mock('./launch-dir.js', () => ({ resolveProviderWorkDir: () => '/tmp' }))
vi.mock('./token-audit.js', () => ({ logTokenAudit: vi.fn() }))
vi.mock('./model-image-input.js', () => ({ cleanupModelImageInputs: vi.fn() }))
vi.mock('./context-builder.js', () => ({
  buildSystemPrompt: vi.fn(async () => 'DISPLAY RULES. CURRENT CONTEXT: today, calendar, standing tasks for Niala and HubSpot.'),
  buildLightweightSystemPrompt: vi.fn(() => 'DISPLAY RULES. CURRENT CONTEXT: today, calendar, standing tasks for Niala and HubSpot.'),
  buildPrewarmSystemPrompt: vi.fn(() => 'prewarm system'),
  getCachedContextInstant: vi.fn(() => ''),
}))
vi.mock('./conversation.js', () => ({
  getHistory: () => [],
  addExchange: () => ({ id: 'exchange' }),
  reconcileExchangeByJobIdentity: () => ({ exchange: { id: 'exchange' } }),
  setExchangeAttachments: vi.fn(),
  removeExchange: vi.fn(),
  formatHistoryForPrompt: () => '',
  getOrCreateSession: (sid?: string) => sid ?? 'session-test',
  isNewSession: () => false,
  markSessionNotified: vi.fn(),
  getSessionModel: () => null,
  getSessionRaw: () => ({ contextBreaks: [] }),
  replaceLastExchangeWithSummary: vi.fn(),
}))
vi.mock('./telegram-notify.js', () => ({ notifySessionStart: vi.fn(), notifyExchange: vi.fn() }))
vi.mock('./claude-run-ledger.js', () => ({
  finishClaudeRun: vi.fn(),
  getClaudeEffortLevel: () => 'high',
  startClaudeRun: () => ({ runId: 'claude-run-test' }),
  updateClaudeRun: vi.fn(),
}))
vi.mock('./activity-preview.js', () => ({
  claudeToolInputPreview: () => undefined,
  claudeToolResultPreviewLines: () => [],
  codexActivityPreviewLines: () => [],
}))
vi.mock('./run-output-images.js', () => ({
  collectRunOutputImagesBounded: vi.fn(async () => []),
  createRunOutputImagePublisher: vi.fn(),
  isRunOutputImagePublisherCommand: () => false,
}))
vi.mock('./provider-process-lifecycle.js', () => ({
  terminateProviderProcess: (...args: any[]) => state.terminateProviderProcess(...args),
}))
vi.mock('./provider-binary.js', () => ({
  resolveProviderBinary: () => ({ ok: true, path: '/opt/test/bin/codex', source: 'absolute' }),
}))
vi.mock('./codex-engine-sessions.js', () => ({
  getCodexEngineSession: () => state.codexEngine,
  saveCodexEngineSession: () => ({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  clearCodexEngineSession: () => 1,
}))
vi.mock('./codex-model-catalog.js', () => ({
  getCodexModelCatalog: vi.fn(async () => ({ options: [] })),
  resolveCodexModelOption: () => ({
    id: 'gpt-test', supportedReasoningEfforts: ['high'], defaultReasoningEffort: 'high', serviceTiers: [],
  }),
  resolveCodexEffortForModel: () => 'high',
  resolveCodexServiceTier: () => undefined,
}))
vi.mock('./codex-run-ledger.js', () => ({
  classifyCodexError: () => 'codex.error',
  extractCodexThreadId: () => undefined,
  finishCodexRun: vi.fn(),
  getCodexExecutionCwd: () => '/tmp',
  isCodexPersistenceEnabled: () => true,
  getCodexTrustMode: () => 'read-only',
  startCodexRun: () => ({ runId: 'codex-run-test' }),
  updateCodexRun: vi.fn(),
}))
vi.mock('./cursor-engine-sessions.js', () => ({
  getCursorEngineSession: () => state.cursorEngine,
  saveCursorEngineSession: () => ({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  clearCursorEngineSession: () => 1,
}))
vi.mock('./cursor-model-catalog.js', () => ({
  getCursorModelCatalog: vi.fn(async () => ({ options: [] })),
  resolveAgentBinary: () => '/opt/test/bin/agent',
  resolveCursorModelOption: () => ({ id: 'composer-test' }),
}))
vi.mock('./cursor-run-ledger.js', () => ({
  classifyCursorError: () => 'cursor.error',
  finishCursorRun: vi.fn(),
  getCursorExecutionCwd: () => '/tmp',
  isCursorPersistenceEnabled: () => true,
  startCursorRun: () => ({ runId: 'cursor-run-test' }),
  updateCursorRun: vi.fn(),
}))

import { callClaudeStreaming, preWarmCLI } from './claude-bridge.js'
import { callCodexStreaming } from './codex-bridge.js'
import { callCursorStreaming } from './cursor-bridge.js'
import { TURN_REQUEST_ENV, turnRequestDir } from './turn-request.js'

const QUERY = 'what did we decide about the 6.52.0 release, zebra-77?'
const PY_SPACE = new RegExp('^[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+|[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+$', 'gu')
const pyStripSha = (text: string) => createHash('sha256').update(text.replace(PY_SPACE, ''), 'utf8').digest('hex')

function callbacks() {
  return {
    onChunk: vi.fn(),
    onDone: vi.fn(async () => {}),
    onError: vi.fn(async () => {}),
    onAnswerReady: vi.fn(async () => {}),
  } as any
}

function lastSpawn() {
  const rec = state.spawns.at(-1)
  expect(rec).toBeTruthy()
  return rec!
}

const flush = () => new Promise(resolve => setImmediate(resolve))
const turnFiles = () => (existsSync(turnRequestDir()) ? readdirSync(turnRequestDir()) : [])

/** The whole contract, read off one spawn record. Returns the file path. */
function expectBoundSpawn(rec: ReturnType<typeof lastSpawn>, userText: string): string {
  const path = rec.env[TURN_REQUEST_ENV]
  expect(path, 'env carries the file path').toBeTruthy()
  expect(isAbsolute(path!)).toBe(true)
  expect(dirname(path!)).toBe(join(process.env.COS_DATA_DIR!, 'turn-requests'))
  expect(rec.file, 'file existed when the child was spawned').not.toBeNull()
  expect(rec.file!.mode).toBe(0o600)
  expect(rec.file!.dirMode).toBe(0o700)

  const record = JSON.parse(rec.file!.text)
  expect(Object.keys(record)).toEqual(['schema_version', 'turn_id', 'current_user_text', 'full_prompt_sha256', 'created_at'])
  expect(record.schema_version).toBe(1)
  expect(record.current_user_text).toBe(userText)
  expect(Number.isNaN(Date.parse(record.created_at))).toBe(false)

  // The hash binds to EXACTLY what the CLI received on stdin.
  const wire: string = rec.child.stdinText
  expect(wire.length).toBeGreaterThan(0)
  expect(record.full_prompt_sha256).toBe(pyStripSha(wire))
  // The hook's second check: the user text is inside what it was given.
  expect(wire.includes(userText.trim())).toBe(true)

  // The user's words are never in argv or the child env; only the path is.
  expect(rec.args.some(arg => arg.includes(userText.trim()))).toBe(false)
  expect(Object.values(rec.env).some(v => typeof v === 'string' && v.includes(userText.trim()))).toBe(false)
  return path!
}

function exitChild(rec: ReturnType<typeof lastSpawn>, code: number | null = 0, signal: string | null = null) {
  rec.child.emit('exit', code, signal)
  rec.child.emit('close', code, signal)
}

beforeEach(() => {
  rmSync(turnRequestDir(), { recursive: true, force: true })
  state.spawns = []
  state.spawnMode = 'ok'
  state.codexEngine = null
  state.cursorEngine = null
  state.terminateProviderProcess = vi.fn(async (child: any) => {
    child.emit('exit', null, 'SIGTERM')
    child.emit('close', null, 'SIGTERM')
    return { closed: true, escalated: false, code: null, signal: 'SIGTERM' }
  })
  delete process.env[TURN_REQUEST_ENV]
})

afterEach(async () => {
  // Every child still open is ended so no bridge timer outlives its test.
  for (const rec of state.spawns) {
    if (rec.child && !rec.child.__ended) {
      rec.child.__ended = true
      rec.child.emit('close', 0, null)
    }
  }
  await flush()
  vi.useRealTimers()
  delete process.env[TURN_REQUEST_ENV]
})

describe('Claude bridge', () => {
  const run = (query: string, extra: Record<string, unknown> = {}, images?: any[]) => callClaudeStreaming(
    query, 'session-claude', callbacks(), 'opus', images, undefined, undefined, { lightweight: true, ...extra } as any,
  )

  it('binds a plain turn and deletes the file when the child exits', async () => {
    await run(QUERY)
    const rec = lastSpawn()
    const path = expectBoundSpawn(rec, QUERY)
    expect(rec.child.stdinText).toBe(QUERY)
    expect(existsSync(path)).toBe(true)
    exitChild(rec)
    expect(existsSync(path)).toBe(false)
  })

  it('binds the user words behind an image preamble and an attachment block', async () => {
    const images = [{ path: '/tmp/cos-photo-1.jpg', attachment: { id: 'a1', kind: 'user_image' }, deleteAfterRun: false }]
    await run(QUERY, { requestAttachments: [], attachmentPromptBlock: 'ATTACHMENT DATA\n{"doc":"quarterly.pdf"}' }, images)
    const rec = lastSpawn()
    expectBoundSpawn(rec, QUERY)
    expect(rec.child.stdinText.startsWith('The user has shared a photo')).toBe(true)
    expect(rec.child.stdinText).toContain('ATTACHMENT DATA')
    exitChild(rec)
  })

  it('hashes the ultracode keyword too, because the CLI receives it', async () => {
    await run(QUERY, { effort: 'ultracode' })
    const rec = lastSpawn()
    expectBoundSpawn(rec, QUERY)
    expect(rec.child.stdinText.endsWith('ultracode')).toBe(true)
    exitChild(rec)
  })

  it('writes a fresh file for a resumed turn', async () => {
    await run('first question about HubSpot')
    const first = lastSpawn()
    const firstPath = expectBoundSpawn(first, 'first question about HubSpot')
    first.child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', session_id: 'cli-session-1', result: 'ok' })}\n`))
    exitChild(first)
    first.child.__ended = true
    await flush()

    await run(QUERY)
    const second = lastSpawn()
    expect(second.args).toContain('--resume')
    expect(second.args).toContain('cli-session-1')
    const secondPath = expectBoundSpawn(second, QUERY)
    expect(secondPath).not.toBe(firstPath)
    exitChild(second)
    expect(turnFiles()).toEqual([])
  })

  it('writes no file for an image with no words, and passes no path', async () => {
    const images = [{ path: '/tmp/cos-photo-2.jpg', attachment: { id: 'a2', kind: 'user_image' }, deleteAfterRun: false }]
    await run('', { requestAttachments: [] }, images)
    const rec = lastSpawn()
    expect(TURN_REQUEST_ENV in rec.env).toBe(false)
    expect(turnFiles()).toEqual([])
    exitChild(rec)
  })

  it('removes the file when the binary is missing (spawn error, no pid)', async () => {
    state.spawnMode = 'enoent'
    await run(QUERY)
    const rec = lastSpawn()
    const path = expectBoundSpawn(rec, QUERY)
    await flush()
    expect(existsSync(path)).toBe(false)
    rec.child.__ended = true
  })

  it('removes the file when spawn throws synchronously', async () => {
    state.spawnMode = 'throw'
    await expect(run(QUERY)).rejects.toThrow('spawn argv rejected')
    const rec = lastSpawn()
    expect(rec.file).not.toBeNull()
    expect(existsSync(rec.env[TURN_REQUEST_ENV]!)).toBe(false)
    expect(turnFiles()).toEqual([])
  })

  it('removes the file when the child is killed on a client abort', async () => {
    const controller = new AbortController()
    await run(QUERY, { abortSignal: controller.signal })
    const rec = lastSpawn()
    const path = expectBoundSpawn(rec, QUERY)
    controller.abort()
    await flush()
    expect(state.terminateProviderProcess).toHaveBeenCalled()
    expect(existsSync(path)).toBe(false)
    rec.child.__ended = true
  })

  it('pre-warm writes no file and strips an inherited path', async () => {
    process.env[TURN_REQUEST_ENV] = '/tmp/inherited-from-a-parent-session.json'
    const warming = preWarmCLI()
    const rec = lastSpawn()
    expect(rec.child.stdinText).toBe('ready')
    expect(TURN_REQUEST_ENV in rec.env).toBe(false)
    expect(turnFiles()).toEqual([])
    exitChild(rec)
    rec.child.__ended = true
    await warming
  })

  it('a turn never forwards an inherited path in place of its own', async () => {
    process.env[TURN_REQUEST_ENV] = '/tmp/inherited-from-a-parent-session.json'
    await run(QUERY)
    const rec = lastSpawn()
    expect(rec.env[TURN_REQUEST_ENV]).not.toBe('/tmp/inherited-from-a-parent-session.json')
    expectBoundSpawn(rec, QUERY)
    exitChild(rec)
  })
})

describe('Codex bridge', () => {
  const run = (query: string, extra: Record<string, unknown> = {}) => callCodexStreaming(
    query, 'session-codex', callbacks(), undefined, undefined, undefined, undefined, { lightweight: true, ...extra } as any,
  )

  it('binds the SYSTEM INSTRUCTIONS / USER REQUEST prompt and deletes on exit', async () => {
    await run(QUERY, { attachmentPromptBlock: 'ATTACHMENT DATA\n{"doc":"x"}' })
    const rec = lastSpawn()
    expect(rec.binary).toBe('/opt/test/bin/codex')
    const path = expectBoundSpawn(rec, QUERY)
    expect(rec.child.stdinText.startsWith('SYSTEM INSTRUCTIONS\n')).toBe(true)
    expect(rec.child.stdinText).toContain(`USER REQUEST\n${QUERY}`)
    rec.child.stdout.emit('data', Buffer.from([
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answer' } }),
      JSON.stringify({ type: 'turn.completed' }),
      '',
    ].join('\n')))
    exitChild(rec)
    expect(existsSync(path)).toBe(false)
  })

  it('writes a fresh file on the resume path', async () => {
    state.codexEngine = { codexThreadId: 'thread-existing', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    await run(QUERY)
    const rec = lastSpawn()
    expect(rec.args).toContain('resume')
    expect(rec.args).toContain('thread-existing')
    const path = expectBoundSpawn(rec, QUERY)
    exitChild(rec)
    expect(existsSync(path)).toBe(false)
  })

  it('removes the file when the binary is missing (spawn error, no pid)', async () => {
    state.spawnMode = 'enoent'
    await run(QUERY)
    const rec = lastSpawn()
    const path = expectBoundSpawn(rec, QUERY)
    await flush()
    expect(existsSync(path)).toBe(false)
    rec.child.__ended = true
  })

  it('removes the file when the inactivity timeout kills the child', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    await run(QUERY)
    const rec = lastSpawn()
    const path = expectBoundSpawn(rec, QUERY)
    await vi.advanceTimersByTimeAsync(180_001)
    expect(state.terminateProviderProcess).toHaveBeenCalled()
    expect(existsSync(path)).toBe(false)
    rec.child.__ended = true
  })
})

describe('Cursor bridge', () => {
  const run = (query: string, extra: Record<string, unknown> = {}) => callCursorStreaming(
    query, 'session-cursor', callbacks(), undefined, undefined, undefined, undefined, { lightweight: true, ...extra } as any,
  )

  it('binds the SYSTEM INSTRUCTIONS / USER REQUEST prompt and deletes on exit', async () => {
    await run(QUERY)
    const rec = lastSpawn()
    expect(rec.binary).toBe('/opt/test/bin/agent')
    const path = expectBoundSpawn(rec, QUERY)
    expect(rec.child.stdinText).toContain(`USER REQUEST\n${QUERY}`)
    exitChild(rec)
    expect(existsSync(path)).toBe(false)
  })

  it('uses the durable turn id as the file name when the caller supplies one', async () => {
    await run(QUERY, { turnId: 'turn-0f3a' })
    const rec = lastSpawn()
    const path = expectBoundSpawn(rec, QUERY)
    expect(path.endsWith('/turn-0f3a.json')).toBe(true)
    expect(JSON.parse(rec.file!.text).turn_id).toBe('turn-0f3a')
    exitChild(rec)
  })

  it('writes a fresh file on the resume path', async () => {
    state.cursorEngine = { cursorSessionId: 'chat-existing', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    await run(QUERY)
    const rec = lastSpawn()
    expect(rec.args).toContain('--resume')
    expect(rec.args).toContain('chat-existing')
    const path = expectBoundSpawn(rec, QUERY)
    exitChild(rec)
    expect(existsSync(path)).toBe(false)
  })

  it('keeps the file while a SIGTERMed child is still alive, and removes it at exit', async () => {
    const controller = new AbortController()
    await run(QUERY, { abortSignal: controller.signal })
    const rec = lastSpawn()
    const path = expectBoundSpawn(rec, QUERY)
    controller.abort()
    await flush()
    expect(rec.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(existsSync(path)).toBe(true)
    exitChild(rec, null, 'SIGTERM')
    expect(existsSync(path)).toBe(false)
  })

  it('removes the file when the binary is missing (spawn error, no pid)', async () => {
    state.spawnMode = 'enoent'
    await run(QUERY)
    const rec = lastSpawn()
    const path = expectBoundSpawn(rec, QUERY)
    await flush()
    expect(existsSync(path)).toBe(false)
    rec.child.__ended = true
  })
})

describe('the directory after every bridge test', () => {
  it('holds nothing once every child has exited', async () => {
    await callCodexStreaming(QUERY, 's', callbacks(), undefined, undefined, undefined, undefined, { lightweight: true } as any)
    await callCursorStreaming(QUERY, 's', callbacks(), undefined, undefined, undefined, undefined, { lightweight: true } as any)
    await callClaudeStreaming(QUERY, 's', callbacks(), 'opus', undefined, undefined, undefined, { lightweight: true } as any)
    expect(turnFiles()).toHaveLength(3)
    for (const rec of state.spawns) { exitChild(rec); rec.child.__ended = true }
    expect(turnFiles()).toEqual([])
    expect(statSync(turnRequestDir()).mode & 0o777).toBe(0o700)
  })
})
