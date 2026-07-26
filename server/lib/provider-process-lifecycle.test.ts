import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { terminateProviderProcess } from './provider-process-lifecycle.js'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('provider process termination', () => {
  it('retains terminal ownership until an uncooperative provider is killed and closed', async () => {
    const child = spawn(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
    ], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.stdout!.once('data', () => resolve())
    })

    let terminalCallbackReached = false
    const termination = terminateProviderProcess(child, { termGraceMs: 80, killWaitMs: 1_000 })
      .then(result => {
        terminalCallbackReached = true
        return result
      })

    await delay(35)
    expect(terminalCallbackReached).toBe(false)
    expect(child.exitCode).toBeNull()

    const result = await termination
    expect(result).toMatchObject({ closed: true, escalated: true, signal: 'SIGKILL' })
    expect(terminalCallbackReached).toBe(true)
  })

  it('does not release ownership when the leader exits but a tool grandchild survives SIGTERM', async () => {
    const child = spawn(process.execPath, [
      '-e',
      [
        "const { spawn } = require('node:child_process')",
        "const grand = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); process.stdout.write('ready\\\\n'); setInterval(() => {}, 1000)\"], { stdio: ['ignore', 'pipe', 'ignore'] })",
        "process.on('SIGTERM', () => process.exit(0))",
        "grand.stdout.once('data', () => process.stdout.write(String(grand.pid) + '\\n'))",
        "setInterval(() => {}, 1000)",
      ].join(';'),
    ], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.stdout!.once('data', () => resolve())
    })

    let terminalCallbackReached = false
    const termination = terminateProviderProcess(child, { termGraceMs: 100, killWaitMs: 1_000 })
      .then(result => {
        terminalCallbackReached = true
        return result
      })

    await delay(45)
    expect(child.exitCode).toBe(0)
    expect(terminalCallbackReached).toBe(false)
    expect(() => process.kill(-child.pid!, 0)).not.toThrow()

    const result = await termination
    expect(result).toMatchObject({ closed: true, escalated: true })
    expect(terminalCallbackReached).toBe(true)
    expect(() => process.kill(-child.pid!, 0)).toThrow()
  })
})
