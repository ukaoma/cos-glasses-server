// The pipeline spawn and its one result line.
//
// A FAKE CHILD, NOT A MOCK. `sync_meetings.py --apply-merge-decision` does not exist yet
// (WS8b builds it), and a mocked `spawn` would prove only that this file calls spawn. Every
// test here runs a real child process that prints the contract's lines and exits with the
// contract's codes, so exit-code routing, line streaming, the environment and the kill path
// are exercised rather than described.

import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PIPELINE_EXIT_LOCK_BUSY } from './meeting-decisions.js'
import {
  PIPELINE_DEFAULT_KILL_GRACE_MS,
  PIPELINE_DEFAULT_TIMEOUT_MS,
  parseResultLine,
  pipelinePath,
  runPipelineCommand,
} from './pipeline-runner.js'

const PREFIX = 'COS_MERGE_RESULT='
const dirs: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cos-pipeline-'))
  dirs.push(dir)
  return dir
}

/** A child that behaves exactly as the contract says, driven by its arguments. */
function fakeChild(dir: string, body: string): string {
  const path = join(dir, 'fake_sync.sh')
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
  chmodSync(path, 0o700)
  return path
}

function run(script: string, args: string[] = [], options: Record<string, unknown> = {}) {
  return runPipelineCommand({
    pythonBin: '/bin/sh',
    script,
    args,
    cwd: '/tmp',
    env: { ...process.env, PATH: '/usr/bin:/bin' },
    resultPrefix: PREFIX,
    timeoutMs: 10_000,
    ...options,
  })
}

const anyObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('running one pipeline command', () => {
  it('collects the result line, strips its prefix, and reports exit 0', async () => {
    const dir = scratch()
    const script = fakeChild(dir, `echo 'working'\necho '${PREFIX}{"status":"applied"}'\nexit 0`)
    const attempt = await run(script)
    expect(attempt.code).toBe(0)
    expect(attempt.timedOut).toBe(false)
    expect(attempt.resultLines).toEqual(['{"status":"applied"}'])
  })

  it('hands every stdout line over as it arrives', async () => {
    const dir = scratch()
    const script = fakeChild(dir, `echo 'step one'\necho 'step two'\necho '${PREFIX}{"status":"applied"}'\nexit 0`)
    const lines: string[] = []
    await run(script, [], { onLine: (line: string) => lines.push(line) })
    expect(lines).toEqual(['step one', 'step two', `${PREFIX}{"status":"applied"}`])
  })

  it('reads a final line that never got its newline', async () => {
    const dir = scratch()
    const script = fakeChild(dir, `printf '${PREFIX}{"status":"applied"}'\nexit 0`)
    const attempt = await run(script)
    expect(attempt.resultLines).toEqual(['{"status":"applied"}'])
  })

  it('reports exit 3 without treating it as a failure of its own', async () => {
    const dir = scratch()
    const script = fakeChild(dir, 'echo "lock busy" >&2\nexit 3')
    const attempt = await run(script)
    expect(attempt.code).toBe(3)
    expect(attempt.resultLines).toEqual([])
    expect(attempt.stderr).toContain('lock busy')
  })

  it('reports exit 4 and exit 5 distinctly', async () => {
    const dir = scratch()
    expect((await run(fakeChild(dir, 'exit 4'))).code).toBe(4)
    expect((await run(fakeChild(scratch(), 'exit 5'))).code).toBe(5)
  })

  it('passes its arguments to the child after the script', async () => {
    const dir = scratch()
    const script = fakeChild(dir, `echo "${PREFIX}{\\"args\\":\\"$1 $2\\"}"\nexit 0`)
    const attempt = await run(script, ['--apply-merge-decision', 'a_0123456789abcdef'])
    expect(attempt.resultLines[0]).toContain('--apply-merge-decision a_0123456789abcdef')
  })

  it('gives the child exactly the environment it was handed', async () => {
    const dir = scratch()
    const script = fakeChild(dir, `echo "${PREFIX}{\\"file\\":\\"$COS_MERGE_DECISION_FILE\\",\\"data\\":\\"$COS_DATA_DIR\\"}"\nexit 0`)
    const attempt = await runPipelineCommand({
      pythonBin: '/bin/sh',
      script,
      args: [],
      cwd: '/tmp',
      env: { PATH: '/usr/bin:/bin', COS_MERGE_DECISION_FILE: '/x/a_1.json', COS_DATA_DIR: '/x/data' },
      resultPrefix: PREFIX,
      timeoutMs: 10_000,
    })
    expect(attempt.resultLines[0]).toBe('{"file":"/x/a_1.json","data":"/x/data"}')
  })

  it('reports a child that could not be spawned rather than throwing', async () => {
    const attempt = await runPipelineCommand({
      pythonBin: join(scratch(), 'no-such-interpreter'),
      script: 'anything.py',
      args: [],
      cwd: '/tmp',
      env: { PATH: '/usr/bin:/bin' },
      resultPrefix: PREFIX,
      timeoutMs: 2_000,
    })
    expect(attempt.spawnError).toBeTruthy()
    expect(attempt.code).toBeNull()
  })

  it('kills a child that runs past its wall and says so', async () => {
    const dir = scratch()
    const script = fakeChild(dir, 'sleep 20\nexit 0')
    const attempt = await run(script, [], { timeoutMs: 300, killGraceMs: 50 })
    expect(attempt.timedOut).toBe(true)
    expect(attempt.code === null || attempt.code !== 0).toBe(true)
    expect(attempt.elapsedMs).toBeLessThan(10_000)
  })

  it('SIGKILLs a child that ignores SIGTERM, inside the grace window', async () => {
    // `sleep` dies on SIGTERM, so a test built on it proves nothing about the kill path.
    // The pipeline spawns its own children and a python that is mid-`os.replace` can be
    // slow to die; without the escalation the spawn would hang past the drain timeout with
    // the sync lock still held.
    const dir = scratch()
    const script = fakeChild(dir, 'trap "" TERM\nsleep 20\nexit 0')
    const started = Date.now()
    const outcome = await run(script, [], { timeoutMs: 200, killGraceMs: 200 })
    expect(outcome.timedOut).toBe(true)
    expect(outcome.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('keeps the wall under COS Control drain timeout by default', () => {
    expect(PIPELINE_DEFAULT_TIMEOUT_MS).toBe(75_000)
    expect(PIPELINE_DEFAULT_TIMEOUT_MS).toBeLessThan(90_000)
    expect(PIPELINE_DEFAULT_KILL_GRACE_MS).toBe(2_000)
  })
})

describe('a real lock the child cannot take', () => {
  // The contract COS Control depends on: while another pipeline process holds the sync
  // lock, the child exits 3 at once and prints nothing. A fake that simply returned 3
  // would prove nothing about contention, so the lock here is a REAL flock, taken by a
  // separate live process, and the child is a real `--apply-merge-decision` stand-in that
  // tries for it with LOCK_NB exactly as the pipeline's `_acquire_lock` does with
  // `max_retries = 0`.
  it('exits 3 while another process holds a real flock, and applies when it does not', async () => {
    const dir = scratch()
    const lockPath = join(dir, 'sync.lock')
    writeFileSync(lockPath, '')

    const childPy = join(dir, 'apply.py')
    writeFileSync(childPy, [
      'import fcntl, sys',
      `f = open(${JSON.stringify(lockPath)}, "r+")`,
      'try:',
      '    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)',
      'except OSError:',
      '    sys.exit(3)',
      `print('${PREFIX}' + '{"status":"applied"}')`,
      'sys.exit(0)',
    ].join('\n'))

    const holderPy = join(dir, 'holder.py')
    writeFileSync(holderPy, [
      'import fcntl, sys, time',
      `f = open(${JSON.stringify(lockPath)}, "r+")`,
      'fcntl.flock(f, fcntl.LOCK_EX)',
      'print("held", flush=True)',
      'time.sleep(30)',
    ].join('\n'))

    const python = '/usr/bin/python3'
    const holder = spawn(python, [holderPy], { stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>((resolveHeld, rejectHeld) => {
      const timer = setTimeout(() => rejectHeld(new Error('the lock holder never started')), 10_000)
      holder.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('held')) { clearTimeout(timer); resolveHeld() }
      })
      holder.on('error', error => { clearTimeout(timer); rejectHeld(error) })
    })

    try {
      const contended = await runPipelineCommand({
        pythonBin: python,
        script: childPy,
        args: ['--apply-merge-decision', 'a_0123456789abcdef'],
        cwd: dir,
        env: { ...process.env, PATH: '/usr/bin:/bin' },
        resultPrefix: PREFIX,
        timeoutMs: 10_000,
      })
      expect(contended.code).toBe(PIPELINE_EXIT_LOCK_BUSY)
      expect(contended.resultLines).toEqual([])
    } finally {
      holder.kill('SIGKILL')
      await new Promise<void>(done => holder.on('close', () => done()))
    }

    // The same child, the same lock file, nobody holding it: it applies. Without this the
    // exit-3 assertion could pass on a child that always exits 3.
    const free = await runPipelineCommand({
      pythonBin: python,
      script: childPy,
      args: ['--apply-merge-decision', 'a_0123456789abcdef'],
      cwd: dir,
      env: { ...process.env, PATH: '/usr/bin:/bin' },
      resultPrefix: PREFIX,
      timeoutMs: 10_000,
    })
    expect(free.code).toBe(0)
    expect(free.resultLines).toEqual(['{"status":"applied"}'])
  })
})

describe('reading the one result line', () => {
  it('parses exactly one valid line', () => {
    const outcome = parseResultLine(['{"status":"applied"}'], anyObject)
    expect(outcome).toEqual({ ok: true, value: { status: 'applied' } })
  })

  it('calls no line missing', () => {
    expect(parseResultLine([], anyObject)).toEqual({ ok: false, reason: 'missing' })
  })

  it('calls two lines duplicated rather than taking the last', () => {
    // Two reports mean the command ran its terminal step twice, or printed a stale one.
    // Either way neither can be trusted as THE outcome of this spawn.
    expect(parseResultLine(['{"status":"applied"}', '{"status":"failed"}'], anyObject))
      .toEqual({ ok: false, reason: 'duplicated' })
  })

  it('calls unparseable JSON malformed', () => {
    expect(parseResultLine(['{oops'], anyObject)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('calls a line that fails validation malformed', () => {
    expect(parseResultLine(['"a string"'], anyObject)).toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('the child PATH', () => {
  it('prepends Homebrew when it is absent', () => {
    expect(pipelinePath('/usr/bin:/bin')).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })

  it('leaves a PATH that already has it alone', () => {
    expect(pipelinePath('/usr/bin:/opt/homebrew/bin')).toBe('/usr/bin:/opt/homebrew/bin')
  })

  it('does not mistake a longer path that merely contains the string', () => {
    // `/opt/homebrew/bin-old` contains "/opt/homebrew/bin" as a substring. A substring
    // check would leave a PATH with no real Homebrew bin on it.
    expect(pipelinePath('/opt/homebrew/bin-old')).toBe('/opt/homebrew/bin:/opt/homebrew/bin-old')
  })

  it('handles an empty PATH', () => {
    expect(pipelinePath(undefined)).toContain('/opt/homebrew/bin')
  })
})
