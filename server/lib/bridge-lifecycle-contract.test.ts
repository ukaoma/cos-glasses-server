import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const bridgeFiles = ['claude-bridge.ts', 'codex-bridge.ts'] as const

function source(file: string): string {
  return readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
}

describe('public provider lifecycle contract', () => {
  for (const file of bridgeFiles) {
    it(`${file} persists answer_ready before assistant conversation mutation`, () => {
      const text = source(file)
      const answerReady = text.indexOf('await callbacks.onAnswerReady?.(text)')
      const assistantMutation = text.indexOf("'assistant',", answerReady)
      expect(answerReady).toBeGreaterThan(0)
      expect(assistantMutation).toBeGreaterThan(answerReady)
      const barrierBlock = text.slice(answerReady, assistantMutation)
      expect(barrierBlock).toContain('catch (error)')
      expect(barrierBlock).toContain('removeExchange(sid, pendingUserExchange)')
      expect(barrierBlock).toContain('await callbacks.onError(')
      expect(text).toContain('await callbacks.onDone(')
      expect(text).toContain('await callbacks.onError(')
    })

    it(`${file} fences provider launch metadata before model input`, () => {
      const text = source(file)
      const providerCallback = text.indexOf('await callbacks.onProviderProcess?.({')
      const stdinWrite = text.indexOf('proc.stdin.write(', providerCallback)
      expect(providerCallback).toBeGreaterThan(0)
      expect(stdinWrite).toBeGreaterThan(providerCallback)
      const callbackBlock = text.slice(providerCallback, stdinWrite)
      expect(callbackBlock).toContain('runId: run.runId')
      expect(callbackBlock).toContain('pid: proc.pid')
      expect(callbackBlock).toContain('clientJobId: options?.clientJobId')
      expect(callbackBlock).toContain('generation: options?.generation')
    })
  }

  it('retains the public promise-tail queue and imports no private runtime seams', () => {
    const files = [...bridgeFiles, 'model-router.ts', 'conversation.ts']
    const combined = files.map(source).join('\n')
    const importLines = combined.split('\n').filter(line => /^\s*import\b/.test(line)).join('\n')

    expect(source('model-router.ts')).toContain('const sessionRunTails = new Map<string, Promise<void>>()')
    expect(importLines).not.toMatch(/day-context|handoff-store|full-access|cos-glasses-app/)
    expect(combined).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(combined).not.toContain('createDayContextTurn')
  })
})
