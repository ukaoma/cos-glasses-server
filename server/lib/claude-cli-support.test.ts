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

import { claudeSupportsSessionName, helpListsNameOption, resetClaudeCliSupportForTests } from './claude-cli-support.js'

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
