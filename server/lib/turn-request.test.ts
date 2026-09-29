import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'

vi.hoisted(() => {
  // Own data home, so the directory this file inspects holds only what it wrote.
  process.env.COS_DATA_DIR = `/tmp/cos-turn-request-test-${process.pid}-${Date.now()}`
})

import {
  TURN_REQUEST_ENV,
  TURN_REQUEST_MAX_BYTES,
  TURN_REQUEST_STALE_MS,
  applyTurnRequestEnv,
  createTurnRequestBinding,
  releaseTurnRequestOnExit,
  resetTurnRequestSweepForTests,
  spawnWithTurnRequest,
  stripLikePython,
  sweepStaleTurnRequests,
  turnPromptSha256,
  turnRequestDir,
} from './turn-request.js'

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const dir = () => turnRequestDir()
const listDir = () => (existsSync(dir()) ? readdirSync(dir()) : [])

beforeEach(() => {
  rmSync(dir(), { recursive: true, force: true })
  resetTurnRequestSweepForTests()
})

afterEach(() => {
  rmSync(dir(), { recursive: true, force: true })
})

describe('turn-request file', () => {
  it('writes the contract shape, in the contract key order, under the data dir', () => {
    const prompt = 'SYSTEM INSTRUCTIONS\nrules\n\nUSER REQUEST\nwhat did we decide about 6.52.0?\n'
    const binding = createTurnRequestBinding({
      userText: 'what did we decide about 6.52.0?',
      prompt,
      turnId: 'turn-abc_123',
      now: () => new Date('2026-09-29T12:00:00.000Z'),
    })
    expect(binding).not.toBeNull()
    expect(binding!.path).toBe(join(process.env.COS_DATA_DIR!, 'turn-requests', 'turn-abc_123.json'))
    const raw = readFileSync(binding!.path, 'utf8')
    const parsed = JSON.parse(raw)
    expect(Object.keys(parsed)).toEqual(['schema_version', 'turn_id', 'current_user_text', 'full_prompt_sha256', 'created_at'])
    expect(parsed).toEqual({
      schema_version: 1,
      turn_id: 'turn-abc_123',
      current_user_text: 'what did we decide about 6.52.0?',
      full_prompt_sha256: sha(prompt.trim()),
      created_at: '2026-09-29T12:00:00.000Z',
    })
    expect(parsed.full_prompt_sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('creates the directory 0700 and the file 0600', () => {
    const binding = createTurnRequestBinding({ userText: 'hello', prompt: 'x hello y' })!
    expect(statSync(dir()).mode & 0o777).toBe(0o700)
    expect(statSync(binding.path).mode & 0o777).toBe(0o600)
  })

  it('tightens an existing directory that was left open', () => {
    mkdirSync(dir(), { recursive: true, mode: 0o755 })
    chmodSync(dir(), 0o755)
    createTurnRequestBinding({ userText: 'hello', prompt: 'hello' })
    expect(statSync(dir()).mode & 0o777).toBe(0o700)
  })

  it('refuses a symlinked directory instead of writing through it', () => {
    const elsewhere = `${process.env.COS_DATA_DIR}-elsewhere`
    mkdirSync(elsewhere, { recursive: true })
    mkdirSync(process.env.COS_DATA_DIR!, { recursive: true })
    symlinkSync(elsewhere, dir())
    try {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(createTurnRequestBinding({ userText: 'hello', prompt: 'hello' })).toBeNull()
      spy.mockRestore()
      expect(readdirSync(elsewhere)).toEqual([])
    } finally {
      unlinkSync(dir())
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('uses a uuid when there is no turn id, or the turn id is not a safe file name', () => {
    const a = createTurnRequestBinding({ userText: 'hello', prompt: 'hello' })!
    expect(a.turnId).toMatch(/^[0-9a-f-]{36}$/)
    expect(a.path.endsWith(`${a.turnId}.json`)).toBe(true)
    const b = createTurnRequestBinding({ userText: 'hello', prompt: 'hello', turnId: '../escape' })!
    expect(b.turnId).toMatch(/^[0-9a-f-]{36}$/)
    expect(b.path.startsWith(dir())).toBe(true)
  })

  it('never overwrites a live file for the same turn id', () => {
    const first = createTurnRequestBinding({ userText: 'one', prompt: 'one', turnId: 'same-turn' })!
    const second = createTurnRequestBinding({ userText: 'two', prompt: 'two', turnId: 'same-turn' })!
    expect(second.path).not.toBe(first.path)
    expect(JSON.parse(readFileSync(first.path, 'utf8')).current_user_text).toBe('one')
    expect(JSON.parse(readFileSync(second.path, 'utf8'))).toMatchObject({ turn_id: 'same-turn', current_user_text: 'two' })
    first.release()
    expect(existsSync(second.path)).toBe(true)
  })

  it('never writes through a symlink planted at the turn path', () => {
    const target = `${process.env.COS_DATA_DIR}-planted-target.json`
    writeFileSync(target, 'original')
    mkdirSync(dir(), { recursive: true, mode: 0o700 })
    symlinkSync(target, join(dir(), 'planted-turn.json'))
    try {
      const binding = createTurnRequestBinding({ userText: 'secret words', prompt: 'secret words', turnId: 'planted-turn' })!
      expect(binding.path).not.toBe(join(dir(), 'planted-turn.json'))
      expect(readFileSync(target, 'utf8')).toBe('original')
      expect(JSON.parse(readFileSync(binding.path, 'utf8')).current_user_text).toBe('secret words')
    } finally {
      rmSync(target, { force: true })
    }
  })

  it('writes nothing when there is no genuine user query', () => {
    expect(createTurnRequestBinding({ userText: '', prompt: 'ready' })).toBeNull()
    expect(createTurnRequestBinding({ userText: '  \n\t', prompt: 'ready' })).toBeNull()
    expect(listDir()).toEqual([])
  })

  it('writes nothing when the user text is not inside the prompt (the hook could never bind it)', () => {
    expect(createTurnRequestBinding({ userText: 'what is on today', prompt: 'something else entirely' })).toBeNull()
    expect(listDir()).toEqual([])
  })

  it('writes nothing at or over the 64 KB limit the hook enforces', () => {
    const big = 'x'.repeat(TURN_REQUEST_MAX_BYTES)
    expect(createTurnRequestBinding({ userText: big, prompt: big })).toBeNull()
    expect(listDir()).toEqual([])
    const fits = 'y'.repeat(TURN_REQUEST_MAX_BYTES - 400)
    const binding = createTurnRequestBinding({ userText: fits, prompt: fits })!
    expect(statSync(binding.path).size).toBeLessThan(TURN_REQUEST_MAX_BYTES)
  })

  it('release deletes the file, and is idempotent', () => {
    const binding = createTurnRequestBinding({ userText: 'hello', prompt: 'hello' })!
    binding.release()
    expect(existsSync(binding.path)).toBe(false)
    expect(() => binding.release()).not.toThrow()
  })
})

describe('prompt hash', () => {
  it('strips exactly the Python str.isspace() set, not the JS trim() set', () => {
    // Python strips U+001C..U+001F and U+0085; JS trim() does not. JS trim() strips U+FEFF; Python does not.
    expect(stripLikePython('\u001c\u001d\u001e\u001f\u0085 hi \u0085\u001f')).toBe('hi')
    expect(stripLikePython('\ufeffhi\ufeff')).toBe('\ufeffhi\ufeff')
    expect(stripLikePython('\t\n\u000b\u000c\r \u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000hi\u3000')).toBe('hi')
    expect(stripLikePython('a \n b')).toBe('a \n b')
  })

  it('is sha256 of the Python-stripped UTF-8 prompt', () => {
    expect(turnPromptSha256('  héllo\n')).toBe(sha('héllo'))
    expect(turnPromptSha256('\u0085hi\u001c')).toBe(sha('hi'))
  })

  it.skipIf(spawnSync('python3', ['-c', 'pass']).status !== 0)(
    'matches hashlib.sha256(prompt.strip()) computed by python3',
    () => {
      const prompts = [
        'SYSTEM INSTRUCTIONS\nrules\n\nUSER REQUEST\nwhat is 6.52.0?\n',
        '\u001c\u0085  émoji 🚀 and 中文\u3000\n',
        '\ufeffBOM stays\ufeff',
        '\r\n\tplain\r\n',
      ]
      for (const prompt of prompts) {
        const result = spawnSync('python3', ['-c', [
          'import sys, hashlib',
          'data = sys.stdin.buffer.read().decode("utf-8")',
          'print(hashlib.sha256(data.strip().encode("utf-8")).hexdigest())',
        ].join('\n')], { input: Buffer.from(prompt, 'utf8'), encoding: 'utf8' })
        expect(result.status).toBe(0)
        expect(turnPromptSha256(prompt)).toBe(result.stdout.trim())
      }
    },
  )
})

describe('stale sweep', () => {
  it('removes files older than an hour and keeps fresh ones', () => {
    const now = Date.now()
    const fresh = createTurnRequestBinding({ userText: 'fresh', prompt: 'fresh' })!
    const stale = join(dir(), 'stale-turn.json')
    writeFileSync(stale, '{}', { mode: 0o600 })
    const old = (now - TURN_REQUEST_STALE_MS - 60_000) / 1000
    utimesSync(stale, old, old)
    const other = join(dir(), 'not-ours.txt')
    writeFileSync(other, 'x')
    utimesSync(other, old, old)

    expect(sweepStaleTurnRequests(now)).toBe(1)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh.path)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })

  it('keeps a file just inside the hour', () => {
    const now = Date.now()
    const file = join(dir(), 'recent.json')
    mkdirSync(dir(), { recursive: true, mode: 0o700 })
    writeFileSync(file, '{}', { mode: 0o600 })
    const t = (now - TURN_REQUEST_STALE_MS + 60_000) / 1000
    utimesSync(file, t, t)
    expect(sweepStaleTurnRequests(now)).toBe(0)
    expect(existsSync(file)).toBe(true)
  })

  it('runs on first use, so a crash leftover goes before the first new turn', () => {
    mkdirSync(dir(), { recursive: true, mode: 0o700 })
    const stale = join(dir(), 'crash-leftover.json')
    writeFileSync(stale, '{}', { mode: 0o600 })
    const old = (Date.now() - TURN_REQUEST_STALE_MS - 60_000) / 1000
    utimesSync(stale, old, old)
    createTurnRequestBinding({ userText: 'hello', prompt: 'hello' })
    expect(existsSync(stale)).toBe(false)
  })

  it('is a no-op when the directory does not exist', () => {
    expect(sweepStaleTurnRequests()).toBe(0)
  })
})

describe('child lifetime', () => {
  class FakeChild extends EventEmitter {
    constructor(public pid: number | undefined) { super() }
  }

  it('deletes the file on exit', () => {
    const binding = createTurnRequestBinding({ userText: 'hello', prompt: 'hello' })!
    const child = new FakeChild(10)
    releaseTurnRequestOnExit(child, binding)
    child.emit('exit', null, 'SIGKILL')
    expect(existsSync(binding.path)).toBe(false)
  })

  it('deletes the file on close alone', () => {
    const binding = createTurnRequestBinding({ userText: 'hello', prompt: 'hello' })!
    const child = new FakeChild(10)
    releaseTurnRequestOnExit(child, binding)
    child.emit('close', 0, null)
    expect(existsSync(binding.path)).toBe(false)
  })

  it('deletes the file on a spawn failure (error with no pid)', () => {
    const binding = createTurnRequestBinding({ userText: 'hello', prompt: 'hello' })!
    const child = new FakeChild(undefined)
    releaseTurnRequestOnExit(child, binding)
    child.emit('error', Object.assign(new Error('spawn agent ENOENT'), { code: 'ENOENT' }))
    expect(existsSync(binding.path)).toBe(false)
  })

  it('keeps the file on an error from a child that is still running', () => {
    const binding = createTurnRequestBinding({ userText: 'hello', prompt: 'hello' })!
    const child = new FakeChild(10)
    releaseTurnRequestOnExit(child, binding)
    child.emit('error', new Error('kill EPERM'))
    expect(existsSync(binding.path)).toBe(true)
    child.emit('exit', 0, null)
    expect(existsSync(binding.path)).toBe(false)
  })

  it('deletes the file when spawn throws synchronously, and rethrows', () => {
    const binding = createTurnRequestBinding({ userText: 'hello', prompt: 'hello' })!
    expect(() => spawnWithTurnRequest(binding, () => { throw new TypeError('bad argv') })).toThrow('bad argv')
    expect(existsSync(binding.path)).toBe(false)
  })
})

describe('child env', () => {
  it('sets the path, and only the path', () => {
    const binding = createTurnRequestBinding({ userText: 'private words', prompt: 'private words' })!
    const env: NodeJS.ProcessEnv = { PATH: '/bin' }
    applyTurnRequestEnv(env, binding)
    expect(env[TURN_REQUEST_ENV]).toBe(binding.path)
    expect(Object.values(env).some(v => typeof v === 'string' && v.includes('private words'))).toBe(false)
  })

  it('removes an inherited path when this spawn has no file', () => {
    const env: NodeJS.ProcessEnv = { [TURN_REQUEST_ENV]: '/tmp/someone-elses.json' }
    applyTurnRequestEnv(env, null)
    expect(TURN_REQUEST_ENV in env).toBe(false)
  })

  it('names the variable exactly as the hook reads it', () => {
    expect(TURN_REQUEST_ENV).toBe('COS_TURN_REQUEST_FILE')
  })
})

describe('server startup', () => {
  // A SOURCE-SHAPE TEST, the repo's convention for composition-root wiring
  // (meeting-import-wiring.test.ts): server/index.ts binds ports at import, so no test can
  // execute it, and a sweep that is never called leaves user text on disk until first use.
  it('sweeps stale turn-request files before the durable query runtime starts turns', () => {
    const index = readFileSync(join(process.cwd(), 'server/index.ts'), 'utf8')
    expect(index).toContain("import { sweepStaleTurnRequests } from './lib/turn-request.js'")
    const sweepAt = index.indexOf('sweepStaleTurnRequests()')
    expect(sweepAt).toBeGreaterThan(-1)
    expect(sweepAt).toBeLessThan(index.indexOf('void initQueryJobRuntime()'))
  })
})
