import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const bridgeFiles = ['claude-bridge.ts', 'codex-bridge.ts'] as const

function source(file: string): string {
  return readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
}

describe('public durable provider lifecycle contract', () => {
  for (const file of bridgeFiles) {
    it(`${file} abandons conversation publication when answer ownership is lost`, () => {
      const text = source(file)
      const answerReady = text.indexOf('const answerOwned = await callbacks.onAnswerReady?.(text)')
      const assistantMutation = text.indexOf("'assistant',", answerReady)
      expect(answerReady).toBeGreaterThan(0)
      expect(assistantMutation).toBeGreaterThan(answerReady)
      const barrierBlock = text.slice(answerReady, assistantMutation)
      expect(barrierBlock).toContain('answerOwned === false')
      expect(barrierBlock).toContain('durable answer ownership was lost')
      expect(barrierBlock).toContain('removeExchange(sid, pendingUserExchange)')
      expect(text).toContain('const terminalOwned = await callbacks.onDone(')
      expect(text).toContain('terminalOwned === false')
    })

    it(`${file} refuses prompt input when provider ownership is lost`, () => {
      const text = source(file)
      const providerCallback = text.indexOf('const providerOwned = await callbacks.onProviderProcess?.({')
      const stdinWrite = text.indexOf('proc.stdin.write(', providerCallback)
      expect(providerCallback).toBeGreaterThan(0)
      expect(stdinWrite).toBeGreaterThan(providerCallback)
      const callbackBlock = text.slice(providerCallback, stdinWrite)
      expect(callbackBlock).toContain('runId: run.runId')
      expect(callbackBlock).toContain('pid: proc.pid')
      expect(callbackBlock).toContain('clientJobId: options?.clientJobId')
      expect(callbackBlock).toContain('generation: options?.generation')
      expect(callbackBlock).toContain('providerOwned === false')
      expect(callbackBlock).toContain('durable provider ownership was lost')
    })
  }

  it('lets the durable coordinator own the public model-router session lease', () => {
    const text = source('model-router.ts')
    expect(text).toContain("options?.sessionLockHeld ? (() => {}) : await acquireModelSessionRunLock(sid)")
    expect(text).toContain('return await callbacks.onDone(')
  })
})
