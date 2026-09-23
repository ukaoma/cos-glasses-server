import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

const probeFaults = vi.hoisted(() => ({
  processTableFailures: 0,
  malformedTableStarts: new Set<number>(),
  perPidStartFailures: new Set<number>(),
  /** 6.53.3: table reads by kind, so a test can prove which one the liveness poll uses. */
  syncTableReads: 0,
  asyncTableReads: 0,
}))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const isTableRead = (file: string, args: readonly string[]) => file === '/bin/ps' && args[0] === '-axo'
  const malform = (output: string) => {
    if (probeFaults.malformedTableStarts.size === 0) return output
    return output.split('\n').map(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+/)
      if (!match || !probeFaults.malformedTableStarts.has(Number(match[1]))) return line
      return `${match[1]} ${match[2]} ${match[3]} not-a-process-start`
    }).join('\n')
  }
  return {
    ...actual,
    execFileSync: (file: string, args: readonly string[], options: unknown) => {
      if (isTableRead(file, args)) probeFaults.syncTableReads += 1
      if (isTableRead(file, args) && probeFaults.processTableFailures > 0) {
        probeFaults.processTableFailures -= 1
        throw Object.assign(new Error('injected process-table failure'), { code: 'EIO' })
      }
      const pid = Number(args.at(-1))
      if (file === '/bin/ps' && args[0] !== '-axo' && args.includes('lstart=') && probeFaults.perPidStartFailures.has(pid)) {
        throw Object.assign(new Error('injected process-start failure'), { code: 'EIO' })
      }
      const output = actual.execFileSync(file, args as string[], options as any)
      return isTableRead(file, args) ? malform(String(output)) : output
    },
    execFile: (file: string, args: readonly string[], options: unknown, callback: (...result: any[]) => void) => {
      if (!isTableRead(file, args)) return (actual.execFile as any)(file, args, options, callback)
      probeFaults.asyncTableReads += 1
      return (actual.execFile as any)(file, args, options, (error: unknown, stdout: unknown, stderr: unknown) => {
        callback(error, error ? stdout : malform(String(stdout)), stderr)
      })
    },
  }
})

import {
  createAttachedTreeMemory,
  ownedAttachedProcessRows,
  planAttachedTermination,
  realAttachedTurnDeps,
  type AttachedChildProcess,
  type AttachedProcessRow,
  type AttachedTreeMemory,
} from './attached-provider-adapter.js'

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
      expect(await deps.processTreeAlive(child as unknown as AttachedChildProcess)).toBe(true)

      deps.terminate(child as unknown as AttachedChildProcess, 'SIGKILL')
      expect(await waitUntilDead(toolPid)).toBe(true)
      expect(await deps.processTreeAlive(child as unknown as AttachedChildProcess)).toBe(false)
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
      expect(await deps.processTreeAlive(child as unknown as AttachedChildProcess)).toBe(true)
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
      expect(await deps.processTreeAlive(child as unknown as AttachedChildProcess)).toBe(false)
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
      expect(await deps.processTreeAlive(child as unknown as AttachedChildProcess)).toBe(true)
    } finally {
      probeFaults.malformedTableStarts.delete(toolPid)
      try { process.kill(-toolPid, 'SIGKILL') } catch { /* already dead */ }
      try { process.kill(toolPid, 'SIGKILL') } catch { /* already dead */ }
      try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already dead */ }
    }
  })
})


// ---------------------------------------------------------------------------
// 6.53.3: ownership rules on synthetic tables. Pure: nothing is signalled, so every rule
// can be pinned on exactly the row shape it exists for.
// ---------------------------------------------------------------------------

describe('6.53.3 process-tree ownership (pure, synthetic tables)', () => {
  const ROOT = 900_001
  const SPAWN = 1_790_000_000_000
  const SERVER_GROUP = 777_001
  const row = (pid: number, ppid: number, pgid: number, startMs = SPAWN + 100): AttachedProcessRow => ({ pid, ppid, pgid, startMs })
  // The table always carries this process (the "server") and launchd.
  const ambient = (): AttachedProcessRow[] => [
    row(1, 0, 1, SPAWN - 9_000_000),
    row(process.pid, 1, SERVER_GROUP, SPAWN - 100_000),
  ]
  const memoryWithFloor = (): AttachedTreeMemory => {
    const memory = createAttachedTreeMemory()
    memory.floorByRoot.set(ROOT, SPAWN - 1_000)
    return memory
  }
  const pids = (rows: AttachedProcessRow[]) => rows.map(r => r.pid).sort((a, b) => a - b)

  it('A3: after Node reaped the leader, its group\'s members (re-parented, holding stdout) are owned and the group is signalled', () => {
    const memory = memoryWithFloor()
    const rows = [...ambient(), row(900_010, 1, ROOT), row(900_011, 900_010, ROOT)]
    expect(pids(ownedAttachedProcessRows(rows, ROOT, 'reaped', memoryWithFloor()))).toEqual([900_010, 900_011])
    expect(planAttachedTermination(rows, ROOT, 'reaped', memory)).toEqual({ groups: [], pids: [900_010, 900_011], rootGroup: true })
  })

  it('A3: while Node holds the leader, its group is ours with no floor at all, and a failed read still signals it', () => {
    const memory = createAttachedTreeMemory()
    const rows = [...ambient(), row(900_020, 1, ROOT, SPAWN - 50_000)]
    expect(pids(ownedAttachedProcessRows(rows, ROOT, 'unreaped', memory))).toEqual([900_020])
    const failed = createAttachedTreeMemory()
    expect(planAttachedTermination(null, ROOT, 'unreaped', failed)).toEqual({ groups: [], pids: [], rootGroup: true })
    expect(failed.uncertainRoots.has(ROOT)).toBe(true)
    // Once Node has reaped it, a failed read signals nothing it cannot name.
    expect(planAttachedTermination(null, ROOT, 'reaped', createAttachedTreeMemory()).rootGroup).toBe(false)
  })

  it('forgets the root group the first time a read shows it empty: a later same-id group is a stranger', () => {
    const memory = memoryWithFloor()
    expect(ownedAttachedProcessRows([...ambient()], ROOT, 'reaped', memory)).toEqual([])
    const recycled = [...ambient(), row(900_030, 1, ROOT, SPAWN + 5_000)]
    expect(ownedAttachedProcessRows(recycled, ROOT, 'reaped', memory)).toEqual([])
    expect(planAttachedTermination(recycled, ROOT, 'reaped', memory).rootGroup).toBe(false)
  })

  it('a reaped leader\'s pid back in the table is a stranger, and proves its group emptied in between', () => {
    const memory = memoryWithFloor()
    const rows = [...ambient(), row(ROOT, 1, ROOT, SPAWN + 9_000), row(900_040, ROOT, ROOT, SPAWN + 9_100)]
    expect(ownedAttachedProcessRows(rows, ROOT, 'reaped', memory)).toEqual([])
    expect(memory.groupsByRoot.get(ROOT)?.has(ROOT)).toBe(false)
  })

  it('A2: a tool group is remembered from the read that sees it, and owns members with no ppid path back', () => {
    const memory = memoryWithFloor()
    // Read 1, at SIGTERM: leader alive, tool leader its child, the job already re-parented.
    const first = [...ambient(), row(ROOT, process.pid, ROOT), row(900_050, ROOT, 900_050), row(900_051, 1, 900_050)]
    expect(pids(ownedAttachedProcessRows(first, ROOT, 'unreaped', memory))).toEqual([ROOT, 900_050, 900_051])
    // Read 2: leader reaped, tool leader gone, a process never seen before sits in the group.
    const second = [...ambient(), row(900_052, 1, 900_050, SPAWN + 2_000)]
    expect(pids(ownedAttachedProcessRows(second, ROOT, 'reaped', memory))).toEqual([900_052])
    expect(planAttachedTermination(second, ROOT, 'reaped', memory)).toEqual({ groups: [900_050], pids: [900_052], rootGroup: false })
  })

  it('never owns a group member that started before the spawn floor, and then signals that group member by member', () => {
    const memory = memoryWithFloor()
    const rows = [...ambient(), row(ROOT, process.pid, ROOT), row(900_060, ROOT, 900_060), row(900_061, 1, 900_060, SPAWN - 5_000)]
    const plan = planAttachedTermination(rows, ROOT, 'unreaped', memory)
    expect(plan.pids).toEqual([900_060])
    expect(plan.groups).toEqual([])
    expect(plan.rootGroup).toBe(true)
  })

  it('forgets a tool group whose leader pid now carries another start', () => {
    const memory = memoryWithFloor()
    const first = [...ambient(), row(ROOT, process.pid, ROOT), row(900_070, ROOT, 900_070, SPAWN + 100)]
    ownedAttachedProcessRows(first, ROOT, 'unreaped', memory)
    const second = [...ambient(), row(900_070, 1, 900_070, SPAWN + 7_000), row(900_071, 900_070, 900_070, SPAWN + 7_100)]
    expect(ownedAttachedProcessRows(second, ROOT, 'reaped', memory)).toEqual([])
  })

  it('never owns the group this server runs in, even when a process of the tree sits in it', () => {
    const memory = memoryWithFloor()
    const rows = [
      ...ambient(),
      row(ROOT, process.pid, ROOT),
      row(900_080, ROOT, SERVER_GROUP),
      // Another child of the server, started during the turn: ours to leave alone.
      row(900_081, process.pid, SERVER_GROUP, SPAWN + 500),
    ]
    expect(pids(ownedAttachedProcessRows(rows, ROOT, 'unreaped', memory))).toEqual([ROOT, 900_080])
    expect(memory.groupsByRoot.get(ROOT)?.has(SERVER_GROUP)).toBe(false)
    expect(planAttachedTermination(rows, ROOT, 'unreaped', memory).groups).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 6.53.3: the same rules against real processes, through the production deps.
// ---------------------------------------------------------------------------

/** A detached leader that starts one same-group child and prints the child's pid. */
async function leaderWithSameGroupChild() {
  const child = spawn(process.execPath, [
    '-e',
    [
      "const { spawn } = require('node:child_process')",
      "const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "process.stdout.write(String(helper.pid) + '\\n')",
      'setInterval(() => {}, 1000)',
    ].join(';'),
  ], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const helperPid = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.stdout!.once('data', chunk => resolve(Number(String(chunk).trim())))
  })
  return { child, helperPid }
}

/** A detached leader whose tool made its own group and ignores SIGTERM (the Codex shape). */
async function leaderWithDetachedStubbornTool() {
  const child = spawn(process.execPath, [
    '-e',
    [
      "const { spawn } = require('node:child_process')",
      "const tool = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] })",
      "process.stdout.write(String(tool.pid) + '\\n')",
      'setInterval(() => {}, 1000)',
    ].join(';'),
  ], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const toolPid = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.stdout!.once('data', chunk => resolve(Number(String(chunk).trim())))
  })
  return { child, toolPid }
}

function sweep(...pidsToKill: Array<number | undefined>): void {
  for (const pid of pidsToKill) {
    if (typeof pid !== 'number') continue
    try { process.kill(-pid, 'SIGKILL') } catch { /* already dead */ }
    try { process.kill(pid, 'SIGKILL') } catch { /* already dead */ }
  }
}

describe.skipIf(process.platform === 'win32')('6.53.3 process-tree termination and liveness (real processes)', () => {
  it('A3: signals the leader\'s group while Node holds it, even when the first table read failed', async () => {
    const { child, helperPid } = await leaderWithSameGroupChild()
    const deps = realAttachedTurnDeps(() => ({ attachable: false, reason: 'test' }))
    try {
      probeFaults.processTableFailures = 1
      deps.terminate(child as unknown as AttachedChildProcess, 'SIGTERM')
      // 6.53.2 fell back to `child.kill` alone here: the leader died, its helper lived.
      expect(await waitUntilDead(helperPid)).toBe(true)
      expect(await waitUntilDead(child.pid!)).toBe(true)
      // The failed read is still doubt: the adapter may not later claim a clean reap.
      expect(await deps.processTreeAlive(child as unknown as AttachedChildProcess)).toBe(true)
    } finally {
      probeFaults.processTableFailures = 0
      sweep(child.pid, helperPid)
    }
  })

  it('A7: stops reading the process table once doubt is latched', async () => {
    const { child, helperPid } = await leaderWithSameGroupChild()
    const deps = realAttachedTurnDeps(() => ({ attachable: false, reason: 'test' }))
    try {
      probeFaults.processTableFailures = 1
      deps.terminate(child as unknown as AttachedChildProcess, 'SIGKILL')
      expect(await waitUntilDead(child.pid!)).toBe(true)
      const before = probeFaults.asyncTableReads + probeFaults.syncTableReads
      for (let i = 0; i < 3; i++) {
        expect(await deps.processTreeAlive(child as unknown as AttachedChildProcess)).toBe(true)
      }
      // The answer is "alive" whatever `ps` says, so 6.53.2's ~29 reads in two seconds bought nothing.
      expect(probeFaults.asyncTableReads + probeFaults.syncTableReads).toBe(before)
    } finally {
      probeFaults.processTableFailures = 0
      sweep(child.pid, helperPid)
    }
  })

  it('A7: the liveness read is asynchronous; only terminate reads the table synchronously', async () => {
    const { child, toolPid } = await leaderWithDetachedStubbornTool()
    const deps = realAttachedTurnDeps(() => ({ attachable: false, reason: 'test' }))
    try {
      const sync = probeFaults.syncTableReads
      const async = probeFaults.asyncTableReads
      const answer = deps.processTreeAlive(child as unknown as AttachedChildProcess)
      expect(typeof (answer as PromiseLike<boolean>).then).toBe('function')
      expect(await answer).toBe(true)
      expect(probeFaults.syncTableReads).toBe(sync)
      expect(probeFaults.asyncTableReads).toBe(async + 1)
    } finally {
      sweep(child.pid, toolPid)
    }
  })

  it('A11: the liveness poll takes identities from the atomic table, never from a per-pid probe', async () => {
    const { child, toolPid } = await leaderWithDetachedStubbornTool()
    const deps = realAttachedTurnDeps(() => ({ attachable: false, reason: 'test' }))
    try {
      probeFaults.perPidStartFailures.add(toolPid)
      deps.terminate(child as unknown as AttachedChildProcess, 'SIGTERM')
      expect(await waitUntilDead(child.pid!)).toBe(true)
      // Polled while the re-parented tool is alive: a per-pid start probe here would fail
      // and latch doubt for good (the gap review A11 found: only terminate was pinned).
      expect(await deps.processTreeAlive(child as unknown as AttachedChildProcess)).toBe(true)
      deps.terminate(child as unknown as AttachedChildProcess, 'SIGKILL')
      expect(await waitUntilDead(toolPid)).toBe(true)
      expect(await deps.processTreeAlive(child as unknown as AttachedChildProcess)).toBe(false)
    } finally {
      probeFaults.perPidStartFailures.delete(toolPid)
      sweep(child.pid, toolPid)
    }
  })

  it('a liveness read overtaken by a terminate answers alive and leaves memory to the newer read', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { detached: true, stdio: 'ignore' })
    await new Promise(resolve => child.once('exit', resolve))
    const deps = realAttachedTurnDeps(() => ({ attachable: false, reason: 'test' }))
    const overtaken = deps.processTreeAlive(child as unknown as AttachedChildProcess)
    deps.terminate(child as unknown as AttachedChildProcess, 'SIGKILL')
    expect(await overtaken).toBe(true)
    expect(await deps.processTreeAlive(child as unknown as AttachedChildProcess)).toBe(false)
  })
})
