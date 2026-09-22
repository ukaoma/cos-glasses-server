import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

const probeFaults = vi.hoisted(() => ({
  processTableFailures: 0,
  startFailures: new Set<number>(),
}))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    execFileSync: (file: string, args: readonly string[], options: unknown) => {
      if (file === '/bin/ps' && args[0] === '-axo' && probeFaults.processTableFailures > 0) {
        probeFaults.processTableFailures -= 1
        throw Object.assign(new Error('injected process-table failure'), { code: 'EIO' })
      }
      const pid = Number(args.at(-1))
      if (file === '/bin/ps' && args.includes('lstart=') && probeFaults.startFailures.has(pid)) {
        throw Object.assign(new Error('injected process-start failure'), { code: 'EIO' })
      }
      return actual.execFileSync(file, args as string[], options as any)
    },
  }
})

import { realAttachedTurnDeps, type AttachedChildProcess } from './attached-provider-adapter.js'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntilDead(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await delay(25)
  }
  return !alive(pid)
}

describe.skipIf(process.platform === 'win32')('attached provider production process-tree termination', () => {
  it('remembers and SIGKILLs a tool that made its own process group before the Codex leader exited', async () => {
    const child = spawn(process.execPath, [
      '-e',
      [
        "const { spawn } = require('node:child_process')",
        "const tool = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] })",
        "process.stdout.write(String(tool.pid) + '\\n')",
        "setInterval(() => {}, 1000)",
      ].join(';'),
    ], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    const toolPid = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.stdout!.once('data', chunk => resolve(Number(String(chunk).trim())))
    })
    expect(Number.isSafeInteger(toolPid)).toBe(true)
    expect(alive(child.pid!)).toBe(true)
    expect(alive(toolPid)).toBe(true)

    const deps = realAttachedTurnDeps(() => ({ attachable: false, reason: 'test' }))
    try {
      deps.terminate(child as unknown as AttachedChildProcess, 'SIGTERM')
      expect(await waitUntilDead(child.pid!)).toBe(true)
      // The fixture ignores TERM and is now re-parented; this is the live Codex
      // failure 6.53.0 shipped. The second call must use the remembered identity.
      expect(alive(toolPid)).toBe(true)
      expect(deps.processTreeAlive(child as unknown as AttachedChildProcess)).toBe(true)

      deps.terminate(child as unknown as AttachedChildProcess, 'SIGKILL')
      expect(await waitUntilDead(toolPid)).toBe(true)
      expect(deps.processTreeAlive(child as unknown as AttachedChildProcess)).toBe(false)
    } finally {
      try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already dead */ }
      try { process.kill(-toolPid, 'SIGKILL') } catch { /* already dead */ }
      try { process.kill(toolPid, 'SIGKILL') } catch { /* already dead */ }
    }
  })

  it('latches an initial process-table failure instead of later claiming the escaped tree was reaped', async () => {
    const child = spawn(process.execPath, [
      '-e',
      [
        "const { spawn } = require('node:child_process')",
        "const tool = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] })",
        "process.stdout.write(String(tool.pid) + '\\n')",
        "setInterval(() => {}, 1000)",
      ].join(';'),
    ], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const toolPid = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.stdout!.once('data', chunk => resolve(Number(String(chunk).trim())))
    })
    const deps = realAttachedTurnDeps(() => ({ attachable: false, reason: 'test' }))
    try {
      probeFaults.processTableFailures = 1
      deps.terminate(child as unknown as AttachedChildProcess, 'SIGTERM')
      expect(await waitUntilDead(child.pid!)).toBe(true)
      expect(alive(toolPid)).toBe(true)
      // Ancestry was unavailable before the wrapper died. A later clean scan
      // cannot prove that no process escaped, so the result must stay unknown.
      expect(deps.processTreeAlive(child as unknown as AttachedChildProcess)).toBe(true)
    } finally {
      probeFaults.processTableFailures = 0
      try { process.kill(-toolPid, 'SIGKILL') } catch { /* already dead */ }
      try { process.kill(toolPid, 'SIGKILL') } catch { /* already dead */ }
      try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already dead */ }
    }
  })

  it('treats a live pid with an unreadable start time as doubt, never as death', async () => {
    const child = spawn(process.execPath, [
      '-e',
      [
        "const { spawn } = require('node:child_process')",
        "const tool = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] })",
        "process.stdout.write(String(tool.pid) + '\\n')",
        "setInterval(() => {}, 1000)",
      ].join(';'),
    ], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const toolPid = await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.stdout!.once('data', chunk => resolve(Number(String(chunk).trim())))
    })
    const deps = realAttachedTurnDeps(() => ({ attachable: false, reason: 'test' }))
    try {
      probeFaults.startFailures.add(toolPid)
      deps.terminate(child as unknown as AttachedChildProcess, 'SIGTERM')
      probeFaults.startFailures.delete(toolPid)
      expect(await waitUntilDead(child.pid!)).toBe(true)
      deps.terminate(child as unknown as AttachedChildProcess, 'SIGKILL')
      // Its unreadable start prevented an unsafe remembered-PID signal. The
      // adapter must therefore admit it cannot prove reaping.
      expect(alive(toolPid)).toBe(true)
      try { process.kill(-toolPid, 'SIGKILL') } catch { /* already dead */ }
      try { process.kill(toolPid, 'SIGKILL') } catch { /* already dead */ }
      expect(await waitUntilDead(toolPid)).toBe(true)
      // The later absence is real, but the earlier identity check was not. It
      // must remain unreaped so the route fences rather than inventing safety.
      expect(deps.processTreeAlive(child as unknown as AttachedChildProcess)).toBe(true)
    } finally {
      probeFaults.startFailures.delete(toolPid)
      try { process.kill(-toolPid, 'SIGKILL') } catch { /* already dead */ }
      try { process.kill(toolPid, 'SIGKILL') } catch { /* already dead */ }
      try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already dead */ }
    }
  })
})
