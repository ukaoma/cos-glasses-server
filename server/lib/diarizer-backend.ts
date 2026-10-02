// Which model assigns who-spoke-when.
//
// Voiceprints (ERes2Net) name a person. They do not separate two people inside
// one chunk. Nemotron 3 Diarization does that, then the voiceprint names the
// track. COS_DIARIZER selects the track model. The default is Nemotron. If its
// CLI is not installed, the server stays on the voiceprint path and says so.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type DiarizerMode = 'nemotron' | 'embedding'

export interface DiarizerChoice {
  requested: DiarizerMode
  active: DiarizerMode
  /** Why Nemotron was not used. Null when the request is what is running. */
  fallback: 'cli_missing' | null
}

const EMBEDDING_ALIASES = new Set(['embedding', 'eres2net', 'voiceprint', 'legacy'])

export function requestedDiarizer(env: NodeJS.ProcessEnv = process.env): DiarizerMode {
  const raw = (env.COS_DIARIZER ?? 'nemotron').trim().toLowerCase()
  return EMBEDDING_ALIASES.has(raw) ? 'embedding' : 'nemotron'
}

/** First existing binary. Never returns a path that is not on disk. */
export function nemotronCliPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof env.COS_NEMOTRON_CLI === 'string') {
    return env.COS_NEMOTRON_CLI.length > 0 && existsSync(env.COS_NEMOTRON_CLI) ? env.COS_NEMOTRON_CLI : null
  }
  const installed = join(homedir(), '.cos-glasses', 'bin', 'fluidaudiocli')
  if (existsSync(installed)) return installed
  try {
    const found = execFileSync('which', ['fluidaudiocli'], { encoding: 'utf8' }).trim()
    return found && existsSync(found) ? found : null
  } catch {
    return null
  }
}

export function activeDiarizer(env: NodeJS.ProcessEnv = process.env): DiarizerChoice {
  const requested = requestedDiarizer(env)
  if (requested === 'embedding') return { requested, active: 'embedding', fallback: null }
  if (!nemotronCliPath(env)) return { requested, active: 'embedding', fallback: 'cli_missing' }
  return { requested, active: 'nemotron', fallback: null }
}
