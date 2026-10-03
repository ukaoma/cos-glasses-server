import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), terminate: vi.fn(), binary: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('./provider-binary.js', () => ({ resolveProviderBinary: mocks.binary }))
vi.mock('./provider-process-lifecycle.js', () => ({ terminateProviderProcess: mocks.terminate }))
import { autoCleanDictation } from './dictation-clean.js'

let configDir: string
let child: any
let output: string
let code: number
let hang: boolean
let scratchWorkspace: string
let childConfig: any
let childConfigMode: number
beforeEach(() => {
  vi.clearAllMocks()
  configDir = mkdtempSync(join(tmpdir(), 'dictation-clean-test-'))
  writeFileSync(join(configDir, 'cli-config.json'), JSON.stringify({
    version: 1, authInfo: { fixture: true }, hooks: { unsafe: true }, permissions: { allow: ['Shell(*)'] },
  }))
  vi.stubEnv('CURSOR_CONFIG_DIR', configDir)
  vi.stubEnv('COS_DICTATION_AUTOCLEAN_MODEL', '')
  vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-secret')
  vi.stubEnv('CURSOR_API_KEY', 'fixture-secret')
  vi.stubEnv('COS_API_TOKEN', 'fixture-secret')
  mocks.binary.mockImplementation(provider => ({ ok: true, path: `/fixture/${provider}` }))
  mocks.terminate.mockResolvedValue({ closed: true })
  output = JSON.stringify({ type: 'result', subtype: 'success', result: 'Keep the limit at 1250, not 12500.' })
  code = 0
  hang = false
  mocks.spawn.mockImplementation((_binary, _args, opts) => {
    scratchWorkspace = opts.cwd
    if (opts.env.CURSOR_CONFIG_DIR !== configDir) {
      const file = join(opts.env.CURSOR_CONFIG_DIR, 'cli-config.json')
      childConfig = JSON.parse(readFileSync(file, 'utf8'))
      childConfigMode = statSync(file).mode & 0o777
    }
    child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
    child.stdin.on('finish', () => {
      if (!hang) queueMicrotask(() => { child.stdout.write(output); child.emit('close', code) })
    })
    return child
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  rmSync(configDir, { recursive: true, force: true })
})

describe('subscription CLI dictation cleanup', () => {
  it('routes Luna to the canary model with a private isolated Cursor profile and deletes it afterwards', async () => {
    expect(await autoCleanDictation('keep the the limit at 1250 not 12500', [], { model: 'luna-5.6-fast' })).toBe('Keep the limit at 1250, not 12500.')
    expect(mocks.binary).toHaveBeenCalledWith('cursor')
    const [binary, args, opts] = mocks.spawn.mock.calls[0]
    expect(binary).toBe('/fixture/cursor')
    expect(args).toEqual(['-p', '--mode', 'ask', '--model', 'gpt-5.6-luna-none-fast', '--output-format', 'json', '--trust', '--workspace', opts.cwd])
    expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(opts.env.CURSOR_API_KEY).toBeUndefined()
    expect(opts.env.COS_API_TOKEN).toBeUndefined()
    expect(childConfig).toEqual({ version: 1, authInfo: { fixture: true }, permissions: { allow: [], deny: [] } })
    expect(childConfigMode).toBe(0o600)
    expect(existsSync(scratchWorkspace)).toBe(false)
    expect(existsSync(opts.env.CURSOR_CONFIG_DIR)).toBe(false)
  })
  it('defaults to Sonnet and disables Claude tools, MCP and hooks', async () => {
    output = 'Do not send this yet.'
    expect(await autoCleanDictation('do not send this yet', [])).toBe(output)
    const [binary, args, opts] = mocks.spawn.mock.calls[0]
    expect(binary).toBe('/fixture/claude')
    expect(args).toContain('sonnet')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--settings') + 1]).toBe('{"disableAllHooks":true}')
    expect(args).toContain('--strict-mcp-config')
    expect(opts.detached).toBe(true)
  })
  it.each([
    [JSON.stringify({ subtype: 'success', is_error: true, result: 'Failure' }), 0],
    [JSON.stringify({ subtype: 'success', result: '' }), 0],
    ['not json', 0],
    [JSON.stringify({ subtype: 'success', result: 'ignored' }), 1],
  ])('rejects unusable Cursor results without switching providers (%s)', async (raw, exit) => {
    output = raw; code = exit
    await expect(autoCleanDictation('original', [], { model: 'luna-5.6-fast' })).rejects.toThrow()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(existsSync(scratchWorkspace)).toBe(false)
  })
  it('terminates the entire process tree on timeout and clears its scratch profile', async () => {
    vi.useFakeTimers(); hang = true
    vi.stubEnv('COS_DICTATION_AUTOCLEAN_TIMEOUT_MS', '20')
    const promise = autoCleanDictation('original', [], { model: 'luna-5.6-fast' })
    const rejection = expect(promise).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(21)
    await rejection
    expect(mocks.terminate).toHaveBeenCalledWith(child)
    expect(existsSync(scratchWorkspace)).toBe(false)
  })
  it('cancels a running call, and never spawns for an already cancelled call', async () => {
    hang = true
    const controller = new AbortController()
    const promise = autoCleanDictation('original', [], { signal: controller.signal })
    controller.abort()
    await expect(promise).rejects.toThrow('aborted')
    expect(mocks.terminate).toHaveBeenCalledTimes(1)
    await expect(autoCleanDictation('original', [], { signal: controller.signal })).rejects.toThrow('aborted')
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
  })
  it('refuses unknown models or missing CLI authentication configuration without trying another provider', async () => {
    await expect(autoCleanDictation('original', [], { model: 'typo' })).rejects.toThrow('Unsupported')
    rmSync(join(configDir, 'cli-config.json'))
    await expect(autoCleanDictation('original', [], { model: 'luna-5.6-fast' })).rejects.toThrow('Sign in')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})
