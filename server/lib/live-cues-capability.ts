// Live Cues capability — ONE truth source for both health surfaces.
//
// Called from routes/health.ts at BOTH assembly sites (/api/health at :271 and
// /api/models at :314). Duplicated literals at two sites is exactly how the
// "patched one site" bug class recurs; the companion polls /api/models, so a
// value present only on /api/health leaves the indicator blind.
//
// /api/health is unauthenticated: `reason` stays a user-safe enum — no paths,
// no usernames, no counts.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { COS_SCRIPTS_DIR, PYTHON_BIN } from './python-bridge.js'
import { resolveAgentBinary, resolveCursorModelOption } from './cursor-model-catalog.js'
import { CURSOR_COMPOSER_MODEL } from '../../shared/model-preference.js'

export type LiveCuesReason =
  | 'master_flag_off'
  | 'no_composer'
  | 'no_cos_pipeline'
  | 'no_memory_scripts'
  | 'budget_exhausted'
  | 'legacy_runtime'
  | 'maintenance_drain_active'

export interface LiveCuesCapability {
  available: boolean
  reason?: LiveCuesReason
}

export function liveCuesEnabled(): boolean {
  return process.env.COS_LIVE_CUES === '1'
}

/** Composer is the only supported v1 model. Anything else fails closed. */
export function liveCuesModelSupported(): boolean {
  const requested = process.env.COS_LIVE_CUES_MODEL?.trim()
  return !requested || requested === CURSOR_COMPOSER_MODEL
}

export function liveCuesGraphEnabled(): boolean {
  return process.env.COS_LIVE_CUES_GRAPH !== '0'
}

export const LIVE_CUES_MEMORY_SCRIPTS = ['semantic_search.py', 'lightrag_search.py'] as const

export function memoryScriptsPresent(): boolean {
  const scriptsDir = COS_SCRIPTS_DIR
  const pythonBin = PYTHON_BIN
  if (!scriptsDir || !pythonBin) return false
  if (!existsSync(pythonBin)) return false
  return LIVE_CUES_MEMORY_SCRIPTS.every(script => existsSync(resolve(scriptsDir, script)))
}

/** Injected by the engine so capability can reflect an exhausted weekly budget
 *  without a circular import. Absent hook = budget not exhausted. */
let budgetExhaustedProbe: (() => boolean) | null = null
export function registerLiveCuesBudgetProbe(probe: () => boolean): void {
  budgetExhaustedProbe = probe
}

export function liveCuesCapability(): LiveCuesCapability {
  if (!liveCuesEnabled()) return { available: false, reason: 'master_flag_off' }
  // An unsupported model is a misconfiguration, not a missing Composer, but
  // the public reason vocabulary maps it to no_composer: the actionable fact
  // for the user is the same — the cue brain has no usable model.
  if (!liveCuesModelSupported()) return { available: false, reason: 'no_composer' }
  if (!COS_SCRIPTS_DIR) return { available: false, reason: 'no_cos_pipeline' }
  if (!memoryScriptsPresent()) return { available: false, reason: 'no_memory_scripts' }
  const option = resolveCursorModelOption(CURSOR_COMPOSER_MODEL)
  // resolveCursorModelOption returns a TRUTHY object with id '' when the
  // catalog is unavailable — the test must be !option?.id, never !option.
  // isCursorProviderReady() is wrong here: it requires BOTH cursor slots.
  if (!resolveAgentBinary() || !option?.id) return { available: false, reason: 'no_composer' }
  if (budgetExhaustedProbe?.()) return { available: false, reason: 'budget_exhausted' }
  return { available: true }
}
