import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

const probeFaults = vi.hoisted(() => ({
  processTableFailures: 0,
  malformedTableStarts: new Set<number>(),
  perPidStartFailures: new Set<number>(),
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
      if (file === '/bin/ps' && args[0] !== '-axo' && args.includes('lstart=') && probeFaults.perPidStartFailures.has(pid)) {
        throw Object.assign(new Error('injected process-start failure'), { code: 'EIO' })
      }
      const output = actual.execFileSync(file, args as string[], options as any)
      if (file === '/bin/ps' && args[0] === '-axo' && probeFaults.malformedTableStarts.size > 0) {
        return String(output).split('\n').map(line => {
          const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+/)
          if (!match || !probeFaults.malformedTableStarts.has(Number(match[1]))) return line
          return `${match[1]} ${match[2]} ${match[3]} not-a-process-start`
        }).join('\n')
      }
      return output
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

  it('uses the atomic table identity when a later per-pid start probe would race with death', async () => {
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
      // The old implementation took ancestry from one table snapshot, then
      // launched a separate ps process per descendant for its start time. A
      // short-lived process could disappear between those probes and poison
      // this root as permanently unreaped. Atomic rows never make that call.
      probeFaults.perPidStartFailures.add(toolPid)
      deps.terminate(child as unknown as AttachedChildProcess, 'SIGTERM')
      expect(await waitUntilDead(child.pid!)).toBe(true)
      deps.terminate(child as unknown as AttachedChildProcess, 'SIGKILL')
      expect(await waitUntilDead(toolPid)).toBe(true)
      expect(deps.processTreeAlive(child as unknown as AttachedChildProcess)).toBe(false)
    } finally {
      probeFaults.perPidStartFailures.delete(toolPid)
      try { process.kill(-toolPid, 'SIGKILL') } catch { /* already dead */ }
      try { process.kill(toolPid, 'SIGKILL') } catch { /* already dead */ }
      try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already dead */ }
    }
  })

  it('treats a malformed start in the atomic process table as permanent doubt', async () => {
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
      probeFaults.malformedTableStarts.add(toolPid)
      deps.terminate(child as unknown as AttachedChildProcess, 'SIGTERM')
      probeFaults.malformedTableStarts.delete(toolPid)
      expect(await waitUntilDead(child.pid!)).toBe(true)
      expect(alive(toolPid)).toBe(true)
      // The malformed whole snapshot may have hidden an escaping child. Later
      // clean absence cannot reconstruct ancestry, so cancellation stays fenced.
      expect(deps.processTreeAlive(child as unknown as AttachedChildProcess)).toBe(true)
    } finally {
      probeFaults.malformedTableStarts.delete(toolPid)
      try { process.kill(-toolPid, 'SIGKILL') } catch { /* already dead */ }
      try { process.kill(toolPid, 'SIGKILL') } catch { /* already dead */ }
      try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already dead */ }
    }
  })
})
