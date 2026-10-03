/** Canonical task-only fallback. Never advertises unrelated Python capabilities. */
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { callPython, pythonBridgeAvailable } from './python-bridge.js'
import { resolveCosOperationsDir } from './cos-operations-meetings.js'
import { dataPath } from './data-dir.js'
import { taskDomainNames } from './domains.js'
import { loadProfileObject } from './profile.js'
const runtime = resolve(import.meta.dirname, '../../work-task-runtime')
const commands = new Set(['task-rows','task-capture','task-set-text','task-set-run-at','task-set-marker','task-set-stage','task-set-done-when','task-move','task-check','task-work-capabilities','task-set-work-stage','task-link-meeting','task-edit-work'])
export function taskBridgeUnavailableMessage(): string {
  if (process.env.COS_SCRIPTS_DIR && !pythonBridgeAvailable()) return 'The configured COS bridge is unavailable. Repair COS_SCRIPTS_DIR so it contains cos_api_bridge.py and an executable venv/bin/python3. Work will not switch task storage automatically.'
  if (process.env.COS_PORTABLE_TASKS === '0') return 'Portable Work tasks are disabled. Enable COS_PORTABLE_TASKS or configure a compatible COS bridge.'
  return 'Work tasks require Python 3.10 or later on macOS/Linux, or a compatible COS bridge. On a Mac with Homebrew, run brew install python@3.12, then restart the server. You can also set COS_TASK_PYTHON to a compatible interpreter’s absolute path.'
}
const unavailable = (prerequisite = false) => ({ error: { code: 'task_runtime_unavailable', message: prerequisite ? taskBridgeUnavailableMessage() : 'The portable task source or runtime is unavailable. Check the configured operations folder and runtime installation before retrying.' } })
export function portablePythonCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.COS_TASK_PYTHON) return [env.COS_TASK_PYTHON]
  return ['/opt/homebrew/bin/python3', '/usr/local/bin/python3',
    '/opt/homebrew/opt/python@3.12/bin/python3.12', '/opt/homebrew/opt/python@3.11/bin/python3.11',
    '/usr/local/opt/python@3.12/bin/python3.12', '/usr/local/opt/python@3.11/bin/python3.11',
    '/opt/homebrew/bin/python3.12', '/opt/homebrew/bin/python3.11',
    '/usr/local/bin/python3.12', '/usr/local/bin/python3.11', '/usr/bin/python3']
}
export function taskOperationsRoot(): string {
  // Preserve the full configured bridge's namespace. An explicit operations root
  // is also honored before its first task/meeting exists.
  return process.env.COS_OPERATIONS_DIR ? resolve(process.env.COS_OPERATIONS_DIR)
    : resolveCosOperationsDir() ?? (process.env.COS_SCRIPTS_DIR ? resolve(process.env.COS_SCRIPTS_DIR, '..') : dataPath('operations'))
}
const pythonChecks = new Map<string, boolean>()
function python(): string | undefined {
  if (!['darwin', 'linux'].includes(process.platform)) return undefined
  const candidates = portablePythonCandidates()
  return candidates.find(candidate => {
    if (!isAbsolute(candidate) || !existsSync(candidate)) return false
    if (!pythonChecks.has(candidate)) {
      try {
        execFileSync(candidate, ['-I','-S','-c','import sys, os, fcntl; sys.exit(0 if sys.version_info >= (3,10) and hasattr(os, "O_NOFOLLOW") and hasattr(os, "O_DIRECTORY") else 1)'], {timeout:3000,stdio:'ignore',env:{PATH:'/usr/bin:/bin'}})
        pythonChecks.set(candidate,true)
      } catch { pythonChecks.set(candidate,false) }
    }
    return pythonChecks.get(candidate) === true
  })
}
export function portableTasksEnabled(): boolean {
  // Existing tests intentionally exercise bridge-unavailable behavior. New
  // portable tests opt in with isolated roots; no implicit production IO in tests.
  return !process.env.COS_SCRIPTS_DIR && process.env.COS_PORTABLE_TASKS !== '0'
    && (!(process.env.VITEST || process.env.NODE_ENV === 'test') || process.env.COS_PORTABLE_TASKS === '1')
}
export function taskBridgeAvailable(): boolean { return pythonBridgeAvailable() || (portableTasksEnabled() && !!python()) }
function verifyRuntime(): void {
  const manifest = JSON.parse(readFileSync(join(runtime, 'manifest.json'), 'utf8'))
  const expected = ['cos_atomic.py','runtime_io.py','task_bridge.py','task_checkout.py','task_commands.py','task_dedup.py','task_rows.py','task_work_metadata.py','task_write.py']
  if (manifest.protocol !== 'cos-control-task-write/1' || !manifest.files || Object.keys(manifest.files).sort().join() !== expected.sort().join()) throw new Error('invalid manifest')
  for (const name of expected) if (createHash('sha256').update(readFileSync(join(runtime, name))).digest('hex') !== manifest.files[name]) throw new Error('runtime checksum mismatch')
}
export async function callTaskBridge(args: string[], timeoutMs = 12_000, input?: string): Promise<unknown> {
  // The installed COS bridge remains authoritative, including its lock namespace.
  if (pythonBridgeAvailable()) return callPython(args, timeoutMs, input)
  if (!portableTasksEnabled()) return unavailable(true)
  if (!commands.has(args[0]) || args.some(arg => arg.length > 8192 || arg.includes('\0')) || Buffer.byteLength(input ?? '') > 32768) return unavailable()
  const executable = python(); if (!executable) return unavailable(true)
  try {
    verifyRuntime()
    const root = taskOperationsRoot()
    const domains = taskDomainNames(root), profile = loadProfileObject()
    const operator = typeof profile.owner_name === 'string' ? profile.owner_name.trim().split(/\s+/)[0] : ''
    const isolated = !!(process.env.VITEST || process.env.NODE_ENV === 'test' || process.env.COS_CONTROL_TEST_HOME)
    const lock = process.env.COS_TASK_LOCK_STORE ?? (isolated ? dataPath('task-locks.json') : join(homedir(), 'Library/Application Support/COS/.task_locks.json'))
    const argv = ['-I','-S','-B',join(runtime,'task_bridge.py'),'--root',root,'--lock-store',lock,'--domains',JSON.stringify(domains),'--operator',operator,...args]
    return await new Promise(resolveResult => {
      const child = execFile(executable, argv, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, cwd: runtime,
        env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', LANG: 'en_US.UTF-8', HOME: homedir() } }, (error, stdout) => {
        if (error) { resolveResult(unavailable()); return }
        try { resolveResult(JSON.parse(stdout)) } catch { resolveResult(unavailable()) }
      })
      child.stdin?.end(input ?? '')
    })
  } catch { return unavailable() }
}
