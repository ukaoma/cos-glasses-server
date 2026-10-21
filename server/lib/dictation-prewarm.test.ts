import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync } from 'node:fs'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), terminate: vi.fn(), binary: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('./provider-binary.js', () => ({ resolveProviderBinary: mocks.binary }))
vi.mock('./provider-process-lifecycle.js', () => ({ terminateProviderProcess: mocks.terminate }))
import {
  _resetPrewarmsForTest, discardPolishPrewarm, killAllPrewarmsSync, livePrewarmCount, prewarmEnabled, PREWARM_MAX, PREWARM_TTL_MS,
  PrewarmUnavailableError, runWarmPolish, startPolishPrewarm, takePolishPrewarm,
} from './dictation-prewarm.js'
import { buildDictationPolishPrompt } from './dictation-clean.js'

interface FakeChild extends EventEmitter {
  stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; exitCode: number | null
  args: string[]; opts: any; written: string; stdinEnded: boolean
}
let children: FakeChild[] = []
/** What the fake CLI answers to its one message; null = never answers. */
let reply: ((message: any) => object | null) | null

const close = (child: FakeChild) => { if (child.exitCode === null) { child.exitCode = 0; child.emit('close', 0) } }

beforeEach(() => {
  vi.clearAllMocks()
  children = []
  vi.stubEnv('COS_DICTATION_POLISH_PROMPT', '')
  vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-secret')
  mocks.binary.mockImplementation((provider: string) => ({ ok: true, path: `/fixture/${provider}` }))
  reply = (message) => ({ type: 'result', subtype: 'success', is_error: false, result: `Cleaned: ${message.message.content.length}` })
  mocks.terminate.mockImplementation(async (child: FakeChild) => { close(child); return { closed: true } })
  mocks.spawn.mockImplementation((_binary: string, args: string[], opts: any) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242 + children.length,
      exitCode: null as number | null, args, opts, written: '', stdinEnded: false,
    }) as FakeChild
    child.stdin.on('data', (chunk: Buffer) => { child.written += chunk.toString() })
    child.stdin.on('finish', () => {
      child.stdinEnded = true
      const line = child.written.trim()
      if (!line) return close(child)
      const answer = reply?.(JSON.parse(line))
      if (answer === null) return
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n')
        child.stdout.write(JSON.stringify(answer) + '\n')
        setTimeout(() => close(child), 0)
      })
    })
    children.push(child)
    return child
  })
})

afterEach(() => {
  _resetPrewarmsForTest()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('6.79.2 polish prewarm', () => {
  it('spawns the exact polish process in stream-json mode with no tools, MCP, hooks or session file', () => {
    const { token, expiresMs } = startPolishPrewarm('haiku')
    expect(token).toMatch(/^[0-9a-f-]{36}$/)
    expect(expiresMs).toBe(PREWARM_TTL_MS)
    const { args, opts } = children[0]
    expect(args.slice(0, 5)).toEqual(['-p', '--model', 'haiku', '--effort', 'low'])
    expect(args).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--strict-mcp-config', '--permission-mode', 'dontAsk']))
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}')
    expect(args[args.indexOf('--settings') + 1]).toBe('{"disableAllHooks":true}')
    expect(args[args.indexOf('--system-prompt') + 1]).toContain("preserving meaning and the speaker's voice")
    expect(opts.detached).toBe(true)
    expect(opts.cwd).toMatch(/cos-dictation-prewarm-.*\/workspace$/)
    expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(children[0].written).toBe('')
  })

  it('sends exactly one message, closes stdin at once, answers, and removes its workspace', async () => {
    const { token } = startPolishPrewarm('sonnet')
    const entry = takePolishPrewarm(token, 'sonnet')!
    // 6.83.1: the warm process gets the default prompt, now v3.
    const prompt = buildDictationPolishPrompt('order five actually six', ['Quilt'], 'v3')
    const out = await runWarmPolish(entry, 'order five actually six', ['Quilt'])
    expect(out).toBe(`Cleaned: ${prompt.length}`)
    const child = children[0]
    expect(child.stdinEnded).toBe(true)
    const lines = child.written.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toEqual({ type: 'user', message: { role: 'user', content: prompt } })
    await vi.waitFor(() => expect(existsSync(child.opts.cwd)).toBe(false))
    expect(livePrewarmCount()).toBe(0)
  })

  it('a token is used once', async () => {
    const { token } = startPolishPrewarm('haiku')
    expect(takePolishPrewarm(token, 'haiku')).not.toBeNull()
    expect(takePolishPrewarm(token, 'haiku')).toBeNull()
  })

  it('a claimed process that is never run still dies at its TTL and leaves no workspace', async () => {
    vi.useFakeTimers()
    const { token } = startPolishPrewarm('haiku')
    expect(takePolishPrewarm(token, 'haiku')).not.toBeNull()
    expect(livePrewarmCount()).toBe(0)
    vi.advanceTimersByTime(PREWARM_TTL_MS)
    expect(mocks.terminate).toHaveBeenCalledWith(children[0])
    expect(existsSync(children[0].opts.cwd)).toBe(false)
  })

  it('server exit signals every live process group, claimed or not', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const claimed = startPolishPrewarm('haiku')
      startPolishPrewarm('sonnet')
      takePolishPrewarm(claimed.token, 'haiku')
      killAllPrewarmsSync()
      expect(kill).toHaveBeenCalledWith(-children[0].pid, 'SIGTERM')
      expect(kill).toHaveBeenCalledWith(-children[1].pid, 'SIGTERM')
      expect(existsSync(children[0].opts.cwd)).toBe(false)
      expect(existsSync(children[1].opts.cwd)).toBe(false)
    } finally { kill.mockRestore() }
  })

  it('server exit never signals a process that already exited (its pid may be reused)', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const { token } = startPolishPrewarm('haiku')
      takePolishPrewarm(token, 'haiku')
      close(children[0])
      killAllPrewarmsSync()
      expect(kill).not.toHaveBeenCalled()
    } finally { kill.mockRestore() }
  })

  it('reset reaches claimed processes too', () => {
    const { token } = startPolishPrewarm('haiku')
    takePolishPrewarm(token, 'haiku')
    _resetPrewarmsForTest()
    expect(mocks.terminate).toHaveBeenCalledWith(children[0])
    expect(existsSync(children[0].opts.cwd)).toBe(false)
  })

  it('a model mismatch kills the warm process and answers null', () => {
    const { token } = startPolishPrewarm('haiku')
    expect(takePolishPrewarm(token, 'sonnet')).toBeNull()
    expect(mocks.terminate).toHaveBeenCalledWith(children[0])
    expect(livePrewarmCount()).toBe(0)
  })

  it(`keeps at most ${PREWARM_MAX} warm processes: a new one evicts the oldest`, () => {
    const tokens = [startPolishPrewarm('haiku').token, startPolishPrewarm('haiku').token, startPolishPrewarm('haiku').token]
    expect(livePrewarmCount()).toBe(PREWARM_MAX)
    expect(mocks.terminate).toHaveBeenCalledTimes(1)
    expect(mocks.terminate).toHaveBeenCalledWith(children[0])
    expect(takePolishPrewarm(tokens[0], 'haiku')).toBeNull()
    expect(takePolishPrewarm(tokens[2], 'haiku')).not.toBeNull()
  })

  it('an unused warm process is killed at its TTL', () => {
    vi.useFakeTimers()
    const { token } = startPolishPrewarm('haiku')
    vi.advanceTimersByTime(PREWARM_TTL_MS - 1)
    expect(mocks.terminate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(mocks.terminate).toHaveBeenCalledWith(children[0])
    expect(takePolishPrewarm(token, 'haiku')).toBeNull()
  })

  it('discard kills it; an unknown token discards nothing', () => {
    const { token } = startPolishPrewarm('haiku')
    expect(discardPolishPrewarm('00000000-0000-0000-0000-000000000000')).toBe(false)
    expect(discardPolishPrewarm(token)).toBe(true)
    expect(mocks.terminate).toHaveBeenCalledWith(children[0])
    expect(livePrewarmCount()).toBe(0)
  })

  it('a process that died before the message is PrewarmUnavailable: nothing was sent', async () => {
    const { token } = startPolishPrewarm('haiku')
    const entry = takePolishPrewarm(token, 'haiku')!
    close(children[0])
    await expect(runWarmPolish(entry, 'hello', [])).rejects.toBeInstanceOf(PrewarmUnavailableError)
    expect(children[0].written).toBe('')
  })

  it('after the message is sent, every failure is a real failure, not PrewarmUnavailable', async () => {
    reply = () => ({ type: 'result', subtype: 'error_during_execution', is_error: true })
    let entry = takePolishPrewarm(startPolishPrewarm('haiku').token, 'haiku')!
    const unsuccessful = await runWarmPolish(entry, 'hello', []).catch(e => e)
    expect(unsuccessful).not.toBeInstanceOf(PrewarmUnavailableError)
    expect(unsuccessful.message).toMatch(/unsuccessful/)

    // The CLI puts an error's text in `result` too: it must never be pasted as the polish.
    for (const bad of [
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: overloaded' },
      { type: 'result', subtype: 'success', is_error: true, result: 'Credit balance is too low' },
    ]) {
      reply = () => bad
      entry = takePolishPrewarm(startPolishPrewarm('haiku').token, 'haiku')!
      await expect(runWarmPolish(entry, 'hello', []), JSON.stringify(bad)).rejects.toThrow('unsuccessful')
    }

    reply = () => ({ type: 'result', subtype: 'success', is_error: false, result: '   ' })
    entry = takePolishPrewarm(startPolishPrewarm('haiku').token, 'haiku')!
    await expect(runWarmPolish(entry, 'hello', [])).rejects.toThrow('empty')

    reply = () => { queueMicrotask(() => close(children[children.length - 1])); return null }
    entry = takePolishPrewarm(startPolishPrewarm('haiku').token, 'haiku')!
    await expect(runWarmPolish(entry, 'hello', [])).rejects.toThrow('exited without a result')
  })

  it('times out and kills the process', async () => {
    vi.stubEnv('COS_DICTATION_AUTOCLEAN_TIMEOUT_MS', '30')
    reply = () => null
    const entry = takePolishPrewarm(startPolishPrewarm('haiku').token, 'haiku')!
    await expect(runWarmPolish(entry, 'hello', [])).rejects.toThrow('timed out')
    expect(mocks.terminate).toHaveBeenCalledWith(children[0])
  })

  it('an abort kills the process; an already aborted call sends nothing', async () => {
    reply = () => null
    let entry = takePolishPrewarm(startPolishPrewarm('haiku').token, 'haiku')!
    const controller = new AbortController()
    const pending = runWarmPolish(entry, 'hello', [], { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
    expect(mocks.terminate).toHaveBeenCalledWith(children[0])

    entry = takePolishPrewarm(startPolishPrewarm('haiku').token, 'haiku')!
    const aborted = new AbortController(); aborted.abort()
    await expect(runWarmPolish(entry, 'hello', [], { signal: aborted.signal })).rejects.toThrow('aborted')
    expect(children[1].written).toBe('')
  })

  it('without a Claude CLI there is no warm process', () => {
    mocks.binary.mockReturnValue({ ok: false })
    expect(() => startPolishPrewarm('haiku')).toThrow(PrewarmUnavailableError)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('COS_DICTATION_PREWARM: on unless 0, false or off', () => {
    expect(prewarmEnabled({})).toBe(true)
    for (const off of ['0', 'false', ' OFF ']) expect(prewarmEnabled({ COS_DICTATION_PREWARM: off }), off).toBe(false)
  })
})

describe('6.85.0 polish instructions on the warm call', () => {
  it('the one message carries the instructions; the process was started without them', async () => {
    const { token } = startPolishPrewarm('haiku')
    const entry = takePolishPrewarm(token, 'haiku')!
    await runWarmPolish(entry, 'order five actually six', ['Quilt'], { customInstructions: 'Use Oxford commas.' })
    const sent = JSON.parse(children[0].written.trim())
    expect(sent.message.content).toBe(buildDictationPolishPrompt('order five actually six', ['Quilt'], 'v3', 'Use Oxford commas.'))
    expect(JSON.stringify(children[0].args)).not.toContain('Oxford')
  })
})
