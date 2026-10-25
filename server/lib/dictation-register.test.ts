import { describe, expect, it } from 'vitest'
import { LITERAL_APPS, literalAnswer, publishedRegisters, registerForApp, registerFromContext, registersEnabled } from './dictation-register.js'

// 6.91.0 registers (plan r2: literal for terminals, opt-in; default for everything else). Synthetic text only.

describe('6.91.0 the app-to-register table', () => {
  // The literal register is opt-in: terminal targets are mostly AI prompts in prose.
  const ON = { COS_DICTATION_REGISTERS: '1' }

  it('is exactly the seven terminals, and with registers on every one of them is literal', () => {
    expect(LITERAL_APPS).toEqual(['iTerm2', 'Terminal', 'Ghostty', 'Warp', 'WezTerm', 'Alacritty', 'kitty'])
    for (const app of LITERAL_APPS) expect(registerForApp(app, ON), app).toBe('literal')
  })

  it('off by default: every terminal is default unless COS_DICTATION_REGISTERS is 1, true or on', () => {
    expect(registersEnabled({})).toBe(false)
    for (const app of LITERAL_APPS) expect(registerForApp(app, {}), app).toBe('default')
    for (const off of ['0', 'false', 'off', '', 'yes']) {
      expect(registersEnabled({ COS_DICTATION_REGISTERS: off }), off).toBe(false)
      expect(registerForApp('iTerm2', { COS_DICTATION_REGISTERS: off }), off).toBe('default')
    }
    for (const on of ['1', 'true', ' ON ']) expect(registerForApp('iTerm2', { COS_DICTATION_REGISTERS: on }), on).toBe('literal')
  })

  it('the map is published whether or not it applies', () => {
    expect(publishedRegisters()).toEqual(Object.fromEntries(LITERAL_APPS.map(app => [app, 'literal'])))
  })

  it('matches the exact name, ignoring case and surrounding space', () => {
    expect(registerForApp('  iterm2 ', ON)).toBe('literal')
    expect(registerForApp('KITTY', ON)).toBe('literal')
    expect(registerForApp('iTerm', ON)).toBe('default')
    expect(registerForApp('iTerm2 Nightly', ON)).toBe('default')
  })

  it('Claude, Cursor, Codex, chat apps, editors and anything unknown are default', () => {
    for (const app of ['Claude', 'Cursor', 'Codex', 'Slack', 'Messages', 'ChatGPT', 'Comet', 'Mail', 'Xcode', 'Visual Studio Code', 'Notes', 'COS Control', 'Unknown App']) {
      expect(registerForApp(app, ON), app).toBe('default')
    }
  })

  it('a missing, blank, long, multi-line or non-string app is default', () => {
    for (const app of [undefined, null, '', '   ', 42, {}, ['iTerm2'], 'iTerm2\nTerminal', `iTerm2${' '.repeat(70)}x`, 'x'.repeat(65)]) {
      expect(registerForApp(app, ON), JSON.stringify(app)).toBe('default')
    }
  })

  it('reads context.app without trusting the shape of context', () => {
    expect(registerFromContext({ app: 'Terminal' }, ON)).toBe('literal')
    expect(registerFromContext({ app: 'Terminal' }, {})).toBe('default')
    for (const context of [undefined, null, 'Terminal', ['Terminal'], { application: 'Terminal' }, { app: 7 }]) {
      expect(registerFromContext(context, ON), JSON.stringify(context)).toBe('default')
    }
  })
})

describe('6.91.0 literalAnswer: the terminal word check', () => {
  it('keeps the answer when only punctuation, case, fillers and stutters changed, with the input casing put back', () => {
    expect(literalAnswer('git status', 'Git status.')).toBe('git status')
    expect(literalAnswer('cd into the server folder', 'Cd into the server folder.')).toBe('cd into the server folder')
    expect(literalAnswer('so run the the tests like now', 'Run the tests now')).toBe('run the tests now')
    expect(literalAnswer('npm test, then git status', 'npm test then git status')).toBe('npm test then git status')
  })

  it('keeps a period the input already had', () => {
    expect(literalAnswer('fix the bug.', 'Fix the bug.')).toBe('fix the bug.')
  })

  it('refuses a swapped word of the same count', () => {
    expect(literalAnswer('git status', 'git stash')).toBeNull()
  })

  it('refuses any word change: a resolved self-correction, a spoken symbol, a reworded command', () => {
    expect(literalAnswer('npm run build dash dash watch', 'npm run build --watch')).toBeNull()
    expect(literalAnswer('run five actually six workers', 'run six workers')).toBeNull()
    expect(literalAnswer('cd into the server folder', 'cd server')).toBeNull()
    expect(literalAnswer('git status', 'git status --short')).toBeNull()
  })

  it('never drops a negation or number as if it were a filler', () => {
    expect(literalAnswer('do not push to main', 'push to main')).toBeNull()
    expect(literalAnswer('run the tests not the build', 'run the tests the build')).toBeNull()
    expect(literalAnswer('wait 5 seconds', 'wait seconds')).toBeNull()
  })
})
