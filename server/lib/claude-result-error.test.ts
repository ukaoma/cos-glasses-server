import { afterAll, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'

const isolatedDataDir = vi.hoisted(() => {
  const dir = `/tmp/cos-glasses-server-claude-result-${process.pid}`
  process.env.COS_DATA_DIR = dir
  return dir
})
import { claudeResultErrorMessage } from './claude-bridge.js'

afterAll(() => {
  delete process.env.COS_DATA_DIR
  rmSync(isolatedDataDir, { recursive: true, force: true })
})

describe('Claude terminal result errors', () => {
  it('treats is_error and error subtypes as failure despite success-shaped result events', () => {
    expect(claudeResultErrorMessage({ type: 'result', subtype: 'success', is_error: true, result: 'There is an issue.' })).toContain('There is an issue.')
    expect(claudeResultErrorMessage({ type: 'result', subtype: 'error', error: 'bad model' })).toContain('bad model')
    expect(claudeResultErrorMessage({ type: 'result', subtype: 'success', is_error: false, result: 'answer' })).toBeNull()
  })

  it('checks result errors before saving a resumable session and returns on late abort', () => {
    const source = readFileSync(new URL('./claude-bridge.ts', import.meta.url), 'utf8')
    expect(source).toContain("event.session_id && !claudeResultErrorMessage(event)")
    const resultBranch = source.indexOf("} else if (event.type === 'result')")
    const saveSession = source.indexOf('cliSessionMap.set(resolvedCliKey', resultBranch)
    expect(source.indexOf('claudeResultErrorMessage(event)', resultBranch)).toBeLessThan(saveSession)
    const lateAbort = source.lastIndexOf('if (options?.abortSignal)')
    const stdinWrite = source.indexOf('proc.stdin.write(cliQuery)', lateAbort)
    expect(source.slice(lateAbort, stdinWrite)).toContain('return sid')
  })
})
