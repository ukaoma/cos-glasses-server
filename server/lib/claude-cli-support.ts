import { execFile } from 'node:child_process'

/**
 * 6.58.2: does the installed Claude CLI take `--name`? A CLI that predates the option rejects
 * it as unknown and the whole run fails, so the server asks `claude --help` once, in the
 * background (it answers in about 50 ms on this Mac), and names a session only when the help
 * lists the option. Any failure to ask is a no: the session then runs unnamed, as before 6.58.2.
 */
let sessionNameSupport: Promise<boolean> | null = null

const HELP_TIMEOUT_MS = 5_000

export function claudeSupportsSessionName(): Promise<boolean> {
  if (!sessionNameSupport) {
    sessionNameSupport = new Promise<boolean>(resolve => {
      try {
        execFile('claude', ['--help'], { timeout: HELP_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
          const supported = !error && helpListsNameOption(`${stdout}\n${stderr}`)
          if (!supported) console.warn('[claude-bridge] this Claude CLI does not list --name; new sessions stay unnamed')
          resolve(supported)
        })
      } catch {
        resolve(false)
      }
    })
  }
  return sessionNameSupport
}

/** The help line reads `-n, --name <name>` on Claude Code 2.1.285. */
export function helpListsNameOption(help: string): boolean {
  return /(^|[\s,])--name[\s=<[]/m.test(help)
}

/**
 * 6.78.0 Messages steer: does the installed Claude CLI take `--input-format stream-json` and
 * `--replay-user-messages` (probed on 2.1.302)? Asked once, like `--name`. Any failure is a no,
 * and a run then streams exactly as before. `claudeSteerSupportKnown()` is the answer once it is
 * in, for the synchronous /api/models capability (null until the first probe finishes).
 */
let steerSupport: Promise<boolean> | null = null
let steerSupportKnown: boolean | null = null

export function claudeSupportsSteer(): Promise<boolean> {
  if (!steerSupport) {
    steerSupport = new Promise<boolean>(resolve => {
      try {
        execFile('claude', ['--help'], { timeout: HELP_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
          const supported = !error && helpListsSteerOptions(`${stdout}\n${stderr}`)
          if (!supported) console.warn('[claude-bridge] this Claude CLI does not list --input-format and --replay-user-messages; Messages steer is off')
          steerSupportKnown = supported
          resolve(supported)
        })
      } catch {
        steerSupportKnown = false
        resolve(false)
      }
    })
  }
  return steerSupport
}

export function claudeSteerSupportKnown(): boolean | null {
  return steerSupportKnown
}

/** Both options, as Claude Code 2.1.302 prints them (`--input-format <format>`, `--replay-user-messages`). */
export function helpListsSteerOptions(help: string): boolean {
  return /(^|[\s,])--input-format[\s=<[]/m.test(help) && /(^|[\s,])--replay-user-messages([\s=<[]|$)/m.test(help)
}

export function resetClaudeCliSupportForTests(): void {
  sessionNameSupport = null
  steerSupport = null
  steerSupportKnown = null
}
