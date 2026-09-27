/** Foundation-only macOS containment for disposable, credential-free command probes.
 * This is not yet a Claude/Codex execution adapter. No fallback runs unsandboxed. */
import { spawn } from 'node:child_process'
import { constants, lstatSync, realpathSync, mkdtempSync, mkdirSync, openSync, closeSync, fstatSync, readSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'

const EXECUTABLES = ['/bin/sh', '/bin/bash', '/bin/cat', '/bin/echo', '/bin/sleep', '/bin/ln', '/usr/bin/env'] as const
const roots = new Map<string, { root: string; parent: string }>()
const activeSnapshots = new Set<string>()
const MAX_INPUT_BYTES = 16 * 1024 * 1024
export interface Control2Snapshot { id: string; root: string; files: string[]; dispose(): void }
export interface Control2SandboxResult { code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; canceled: boolean; outputLimited: boolean; durationMs: number }
export interface Control2SandboxCapability { supported: boolean; proven: boolean; code: string; checks: Record<string, boolean>; limitations: string[] }

function safeRelative(value: string): string {
  if (!value || isAbsolute(value) || value.includes('\\') || value.includes('\0') || value.split('/').some(p => !p || p === '..' || p.startsWith('.'))) throw new Error('unsafe_snapshot_path')
  if (/(?:^|\/)(?:credentials?|secrets?|id_rsa|id_ed25519)(?:[./_-]|$)|\.(?:pem|key|p12|pfx)$/i.test(value)) throw new Error('credential_file_refused')
  return value
}

/** Copies an explicit operator-approved file set. Never traverses or copies .git,
 * hidden settings, links, devices, or the user's environment. Content approval
 * remains the caller's responsibility: a benign filename does not prove safe data. */
export function createControl2Snapshot(input?: { sourceRoot: string; relativePaths: string[] }): Control2Snapshot {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'cos-control2-sandbox-')))
  const root = join(parent, 'workspace')
  mkdirSync(root, { mode: 0o700 })
  const id = randomUUID()
  const files: string[] = []
  let bytes = 0
  try {
    if (input) {
      if (input.relativePaths.length > 1000) throw new Error('snapshot_file_limit')
      const sourceRoot = realpathSync(input.sourceRoot)
      for (const supplied of input.relativePaths) {
        const name = safeRelative(supplied)
        let current = sourceRoot
        for (const part of name.split('/')) {
          current = join(current, part)
          if (lstatSync(current).isSymbolicLink()) throw new Error('snapshot_symlink_refused')
        }
        if (relative(sourceRoot, realpathSync(current)).startsWith('..')) throw new Error('snapshot_escape_refused')
        const beforeOpen = lstatSync(current)
        if (!beforeOpen.isFile() || beforeOpen.nlink !== 1) throw new Error('snapshot_regular_single_link_required')
        const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const stat = fstatSync(fd)
          if (!stat.isFile() || stat.nlink !== 1) throw new Error('snapshot_regular_single_link_required')
          bytes += stat.size
          if (bytes > MAX_INPUT_BYTES) throw new Error('snapshot_size_limit')
          const buffer = Buffer.alloc(stat.size + 1)
          let count = 0
          while (count < buffer.length) {
            const read = readSync(fd, buffer, count, buffer.length - count, count)
            if (!read) break
            count += read
          }
          const afterRead = fstatSync(fd)
          if (count !== stat.size || afterRead.size !== stat.size || afterRead.mtimeMs !== stat.mtimeMs || stat.ino !== beforeOpen.ino || stat.dev !== beforeOpen.dev) throw new Error('snapshot_source_changed')
          const content = buffer.subarray(0, count)
          const target = join(root, name)
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
          writeFileSync(target, content, { flag: 'wx', mode: 0o600 })
          files.push(name)
        } finally { closeSync(fd) }
      }
    }
    mkdirSync(join(root, '.home'), { mode: 0o700 })
    mkdirSync(join(root, '.tmp'), { mode: 0o700 })
    roots.set(id, { root, parent })
    return { id, root, files, dispose() { if (activeSnapshots.has(id)) throw new Error('sandbox_still_running'); roots.delete(id); rmSync(parent, { recursive: true, force: true }) } }
  } catch (error) { rmSync(parent, { recursive: true, force: true }); throw error }
}

function profile(root: string): string {
  const quoted = JSON.stringify(root)
  // Literal / permits dyld's root-directory read on modern macOS, not subtree
  // access. Metadata access is global; host file CONTENT is not readable.
  return `(version 1)
(deny default)
(allow process-fork)
(allow process-exec ${EXECUTABLES.map(path => `(literal ${JSON.stringify(path)})`).join(' ')})
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (literal "/") (subpath "/System/Library") (subpath "/usr/lib") (subpath "/bin") (subpath "/usr/bin") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (subpath ${quoted}))
(allow file-write* (subpath ${quoted}) (literal "/dev/null"))`
}

export async function runControl2Sandbox(input: { snapshot: Pick<Control2Snapshot, 'id' | 'root'>; executable: string; args?: string[]; timeoutMs?: number; signal?: AbortSignal }): Promise<Control2SandboxResult> {
  if (process.platform !== 'darwin') throw new Error('sandbox_platform_unsupported')
  const owned = roots.get(input.snapshot.id)
  if (!owned || owned.root !== input.snapshot.root || realpathSync(owned.root) !== owned.root) throw new Error('unowned_sandbox_root')
  if (!(EXECUTABLES as readonly string[]).includes(input.executable)) throw new Error('sandbox_executable_unsupported')
  if (input.args && (input.args.length > 128 || input.args.some(s => s.length > 65536 || s.includes('\0')))) throw new Error('sandbox_arguments_invalid')
  const timeoutMs = input.timeoutMs ?? 10000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000) throw new Error('sandbox_timeout_invalid')
  if (activeSnapshots.has(input.snapshot.id)) throw new Error('sandbox_already_running')
  const start = Date.now()
  if (input.signal?.aborted) return { code: null, signal: null, stdout: '', stderr: '', timedOut: false, canceled: true, outputLimited: false, durationMs: 0 }
  activeSnapshots.add(input.snapshot.id)
  try { return await new Promise((resolveResult, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile(owned.root), input.executable, ...(input.args ?? [])], {
      cwd: owned.root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: join(owned.root, '.home'), TMPDIR: join(owned.root, '.tmp'), LANG: 'C', LC_ALL: 'C' },
    })
    let stdout = '', stderr = '', received = 0, timedOut = false, canceled = false, outputLimited = false, settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const kill = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal) } catch { /* exited group */ } } }
    const stop = () => { kill('SIGTERM'); killTimer ??= setTimeout(() => { kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy() }, 200) }
    const abort = () => { canceled = true; stop() }
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    const collect = (stream: 'stdout' | 'stderr', data: Buffer) => {
      const remaining = Math.max(0, 65536 - received)
      received += data.length
      if (stream === 'stdout') stdout += data.subarray(0, remaining).toString('utf8')
      else stderr += data.subarray(0, remaining).toString('utf8')
      if (received > 65536) { outputLimited = true; stop() }
    }
    child.stdout.on('data', data => collect('stdout', data))
    child.stderr.on('data', data => collect('stderr', data))
    input.signal?.addEventListener('abort', abort, { once: true })
    // Cover abort between preflight and listener registration.
    if (input.signal?.aborted) abort()
    const cleanup = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); input.signal?.removeEventListener('abort', abort); kill('SIGKILL') }
    child.once('error', error => { if (!settled) { settled = true; cleanup(); reject(error) } })
    child.once('close', (code, signal) => { if (!settled) { settled = true; cleanup(); resolveResult({ code, signal, stdout, stderr, timedOut, canceled, outputLimited, durationMs: Date.now() - start }) } })
  }) } finally { activeSnapshots.delete(input.snapshot.id) }
}

/** Positive controls are mandatory: a broken command must not count as isolation. */
export async function probeControl2Sandbox(): Promise<Control2SandboxCapability> {
  const checks: Record<string, boolean> = {}
  const limitations = ['System file metadata is readable.', 'Only fixed system probe executables are enabled; provider/build adapters remain unproven.', 'No production target or publication capability is exercised.']
  if (process.platform !== 'darwin') return { supported: false, proven: false, code: 'sandbox_platform_unsupported', checks, limitations }
  const snapshot = createControl2Snapshot()
  const protectedRoot = mkdtempSync(join(tmpdir(), 'cos-control2-protected-'))
  const sentinel = join(realpathSync(protectedRoot), 'sentinel.txt')
  writeFileSync(sentinel, 'protected-canary-only', { mode: 0o600 })
  const listener = createServer(socket => socket.end('reachable'))
  let hits = 0
  listener.on('connection', () => { hits++ })
  try {
    await new Promise<void>((resolveListen, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolveListen) })
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('canary_listener_failed')
    // Host-positive control proves sentinel and loopback endpoint are real.
    checks.hostSentinelReadable = readFileSync(sentinel, 'utf8') === 'protected-canary-only'
    const { connect } = await import('node:net')
    await new Promise<void>((done, reject) => { const socket = connect(address.port, '127.0.0.1'); socket.once('error', reject); socket.once('data', () => { socket.destroy(); done() }) })
    checks.hostNetworkReachable = hits === 1
    const execute = (command: string, args: string[], timeoutMs = 3000) => runControl2Sandbox({ snapshot, executable: command, args, timeoutMs })
    const positive = await execute('/bin/sh', ['-c', 'printf local-ok > output.txt; cat output.txt'])
    checks.workspaceReadWrite = positive.code === 0 && positive.stdout === 'local-ok'
    const read = await execute('/bin/cat', [sentinel])
    checks.hostReadDenied = read.code !== 0 && !read.stdout.includes('protected-canary-only') && /not permitted|denied/i.test(read.stderr)
    const write = await execute('/bin/sh', ['-c', 'printf changed > "$1"', 'probe', sentinel])
    checks.hostWriteDenied = write.code !== 0 && readFileSync(sentinel, 'utf8') === 'protected-canary-only'
    const link = await execute('/bin/sh', ['-c', 'ln -s "$1" escape; cat escape', 'probe', sentinel])
    checks.symlinkReadDenied = link.code !== 0 && !link.stdout.includes('protected-canary-only') && /not permitted|denied/i.test(link.stderr)
    const hostBash = await new Promise<number | null>((done, reject) => {
      const child = spawn('/bin/bash', ['-c', `printf host-control > /dev/tcp/127.0.0.1/${address.port}`], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' })
      child.once('error', reject); child.once('close', done)
    })
    checks.bashNetworkFunctional = hostBash === 0 && hits === 2
    const network = await execute('/bin/bash', ['-c', `printf blocked > /dev/tcp/127.0.0.1/${address.port}`])
    checks.networkDenied = network.code !== 0 && hits === 2 && /not permitted|denied/i.test(network.stderr)
    const environment = await execute('/usr/bin/env', [])
    checks.environmentMinimal = environment.code === 0 && environment.stdout.split('\n').filter(Boolean).every(line => /^(PATH|HOME|TMPDIR|LANG|LC_ALL)=/.test(line))
    const timeout = await execute('/bin/sh', ['-c', 'sleep 20 & printf %s \"$!\" > timeout-child.pid; wait'], 100)
    checks.timeoutBounded = timeout.timedOut && timeout.durationMs < 2000
    const controller = new AbortController()
    const pending = runControl2Sandbox({ snapshot, executable: '/bin/sh', args: ['-c', 'sleep 20 & printf %s \"$!\" > cancel-child.pid; wait'], signal: controller.signal })
    const timer = setTimeout(() => controller.abort(), 100)
    const canceled = await pending
    clearTimeout(timer)
    checks.cancelBounded = canceled.canceled && canceled.durationMs < 2000
    await new Promise(done => setTimeout(done, 50))
    for (const kind of ['timeout', 'cancel']) {
      const pid = Number(readFileSync(join(snapshot.root, `${kind}-child.pid`), 'utf8'))
      let gone = false
      try { process.kill(pid, 0) } catch (error) { gone = (error as NodeJS.ErrnoException).code === 'ESRCH' }
      checks[`${kind}DescendantGone`] = pid > 0 && gone
    }
    const output = await execute('/bin/sh', ['-c', 'while :; do printf 012345678901234567890123456789; done'])
    checks.outputBounded = output.outputLimited && Buffer.byteLength(output.stdout + output.stderr) <= 65536
    return { supported: checks.workspaceReadWrite, proven: Object.values(checks).every(Boolean), code: Object.values(checks).every(Boolean) ? 'sandbox_probe_proven' : 'sandbox_probe_failed', checks, limitations }
  } catch (error) { return { supported: false, proven: false, code: `sandbox_probe_error:${error instanceof Error ? error.message : 'unknown'}`, checks, limitations } }
  finally { listener.close(); snapshot.dispose(); rmSync(protectedRoot, { recursive: true, force: true }) }
}
