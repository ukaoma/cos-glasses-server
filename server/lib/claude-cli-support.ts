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

export function resetClaudeCliSupportForTests(): void {
  sessionNameSupport = null
}
