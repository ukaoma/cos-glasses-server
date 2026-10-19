// Key lanes K1 P3 (plan v4 7.2, W17): the Claude settings-layer check before a keyed spawn.
//
// Claude Code applies the `env` block of its settings files over the process environment, and an
// `apiKeyHelper` hands it a credential of its own. Either would point a keyed turn somewhere other
// than the loopback relay, so the meter and the cap would not see it (or the user's other
// credential would pay for it). Before a profile spawn the three files the CLI reads for this
// working directory are checked; any `ANTHROPIC_*` or `CLAUDE_CODE_USE_*` name in `env`, or an
// `apiKeyHelper`, refuses the profile with a line that names it.
//
// Read only on a keyed turn. Never writes, never creates, never reads a value aloud: the refusal
// names the setting, not what it is set to. A file that does not parse is skipped, because the CLI
// cannot apply a file it cannot parse either.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CLAUDE_SETTINGS_REFUSED_ENV = /^(ANTHROPIC_|CLAUDE_CODE_USE_)/

export interface ClaudeSettingsRefusal {
  /** The file that sets it. */
  file: string
  /** The env name, or `apiKeyHelper`. */
  name: string
  message: string
}

export function claudeSettingsFiles(input: { cwd: string; home?: string }): string[] {
  const home = input.home ?? homedir()
  return [
    join(home, '.claude', 'settings.json'),
    join(input.cwd, '.claude', 'settings.json'),
    join(input.cwd, '.claude', 'settings.local.json'),
  ]
}

function readSettings(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

export function claudeSettingsRefusalMessage(name: string): string {
  return `A Claude settings file sets ${name}. Remove it to use a key.`
}

/** The first setting that would bypass the relay, or null when a keyed spawn may go ahead. */
export function claudeSettingsRefusal(input: { cwd: string; home?: string }): ClaudeSettingsRefusal | null {
  for (const file of claudeSettingsFiles(input)) {
    const settings = readSettings(file)
    if (!settings) continue
    if (settings.apiKeyHelper !== undefined && settings.apiKeyHelper !== null && settings.apiKeyHelper !== '') {
      return { file, name: 'apiKeyHelper', message: claudeSettingsRefusalMessage('apiKeyHelper') }
    }
    const env = settings.env
    if (env && typeof env === 'object' && !Array.isArray(env)) {
      for (const name of Object.keys(env).sort()) {
        if (CLAUDE_SETTINGS_REFUSED_ENV.test(name)) return { file, name, message: claudeSettingsRefusalMessage(name) }
      }
    }
  }
  return null
}
