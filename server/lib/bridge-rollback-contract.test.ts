import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('bridge pending-turn rollback contract', () => {
  for (const file of ['claude-bridge.ts', 'codex-bridge.ts']) {
    it(`${file} removes its exact pending user exchange on terminal failure`, () => {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
      expect(source).toContain("const pendingUserExchange = addExchange(sid, 'user'")
      const failureStart = source.indexOf('function finalizeError')
      const failureEnd = source.indexOf('\n  }', failureStart)
      const failureBody = source.slice(failureStart, failureEnd)
      expect(failureBody).toContain('removeExchange(sid, pendingUserExchange)')
    })
  }

  it('Claude cancellation is wired to terminal rollback', () => {
    const source = readFileSync(new URL('./claude-bridge.ts', import.meta.url), 'utf8')
    expect(source).toContain("finalizeError('claude-bridge: client disconnected before Claude completed.'")
    expect(source).toContain("options.abortSignal.addEventListener('abort', handleAbort")
    expect(source).toContain('cliSessionMap.delete(resolvedCliKey)')
    expect(source).toContain('scheduleCliSessionSave()')
  })
})
