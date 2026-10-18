import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  calls: 0,
  reply: { error: null as Error | null, stdout: '', stderr: '' },
}))

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    state.calls++
    cb(state.reply.error, state.reply.stdout, state.reply.stderr)
  }),
}))

import { claudeSteerSupportKnown, claudeSupportsSessionName, claudeSupportsSteer, helpListsNameOption, helpListsSteerOptions, resetClaudeCliSupportForTests } from './claude-cli-support.js'

afterEach(() => {
  resetClaudeCliSupportForTests()
  state.calls = 0
  state.reply = { error: null, stdout: '', stderr: '' }
})

describe('6.58.2: the server names a session only when the Claude CLI takes --name', () => {
  it('reads the option off the help line Claude Code 2.1.285 prints', () => {
    expect(helpListsNameOption('  -n, --name <name>                     Set a display name for this session')).toBe(true)
    expect(helpListsNameOption('--name=<name>')).toBe(true)
    expect(helpListsNameOption('  --model <model>  Model for the session')).toBe(false)
    expect(helpListsNameOption('  --named-thing <x>')).toBe(false)
    expect(helpListsNameOption('  --name-prefix <x>')).toBe(false)
  })

  it('asks once and remembers', async () => {
    state.reply.stdout = 'Options:\n  -n, --name <name>  Set a display name for this session\n'
    expect(await claudeSupportsSessionName()).toBe(true)
    expect(await claudeSupportsSessionName()).toBe(true)
    expect(state.calls).toBe(1)
  })

  it('a CLI whose help lacks it, or a help that fails, is a no', async () => {
    state.reply.stdout = 'Options:\n  --model <model>\n'
    expect(await claudeSupportsSessionName()).toBe(false)
    resetClaudeCliSupportForTests()
    state.reply = { error: new Error('spawn claude ENOENT'), stdout: '  -n, --name <name>', stderr: '' }
    expect(await claudeSupportsSessionName()).toBe(false)
  })
})

describe('6.78.0: Messages steer only on a Claude CLI that takes stream-json input', () => {
  const HELP_2_1_302 = [
    '  --input-format <format>       Input format (only works with --print): "text" (default), or "stream-json"',
    '  --replay-user-messages        Re-emit user messages from stdin back on stdout for acknowledgment',
  ].join('\n')

  it('needs BOTH options, as Claude Code 2.1.302 prints them', () => {
    expect(helpListsSteerOptions(HELP_2_1_302)).toBe(true)
    expect(helpListsSteerOptions(HELP_2_1_302.split('\n')[0]!)).toBe(false)
    expect(helpListsSteerOptions(HELP_2_1_302.split('\n')[1]!)).toBe(false)
    expect(helpListsSteerOptions('  --input-format-x <f>\n  --replay-user-messages-later')).toBe(false)
  })

  it('asks once, remembers, and says so synchronously once the answer is in', async () => {
    expect(claudeSteerSupportKnown()).toBeNull()
    state.reply.stdout = HELP_2_1_302
    expect(await claudeSupportsSteer()).toBe(true)
    expect(await claudeSupportsSteer()).toBe(true)
    expect(state.calls).toBe(1)
    expect(claudeSteerSupportKnown()).toBe(true)
  })

  it('a failing help is a no', async () => {
    state.reply = { error: new Error('spawn claude ENOENT'), stdout: HELP_2_1_302, stderr: '' }
    expect(await claudeSupportsSteer()).toBe(false)
    expect(claudeSteerSupportKnown()).toBe(false)
  })
})
