// Speech-to-text settings (6.72.0): which engine previews live speech, which
// engine writes the saved meeting (HQ), which engine gives HQ a second opinion,
// whether the resolver may use it, the ASR input front end and the quiet gate.
//
// Stored in <data>/stt-settings.json (atomic). Read on every use with an mtime
// check, so a change applies without a restart: the preview, front end and
// quiet gate from the next live chunk; HQ, second opinion and resolver from the
// next saved meeting (an HQ job snapshots the settings when it starts and never
// switches engines mid-job).
//
// Defaults and the evidence behind them: docs/stt-672-evaluation.md.

import { readFileSync, statSync } from 'node:fs'
import { atomicWriteFileSync } from './atomic-fs.js'
import { dataPath } from './data-dir.js'

export const PREVIEW_IDS = ['turbo', 'large-v3', 'parakeet', 'nemotron-560'] as const
export const HQ_IDS = ['large-v3', 'large-v3-legacy', 'parakeet-ultra'] as const
export const SECOND_OPINION_IDS = ['off', 'parakeet-ultra', 'large-v3'] as const
export const FRONT_END_IDS = ['highpass', 'full'] as const
export const QUIET_GATE_IDS = ['silero', 'rms'] as const

export type PreviewId = typeof PREVIEW_IDS[number]
export type HqId = typeof HQ_IDS[number]
export type SecondOpinionId = typeof SECOND_OPINION_IDS[number]
export type FrontEndId = typeof FRONT_END_IDS[number]
export type QuietGateId = typeof QUIET_GATE_IDS[number]

export interface SttSettings {
  preview: PreviewId
  hq: HqId
  secondOpinion: SecondOpinionId
  resolver: boolean
  frontEnd: FrontEndId
  quietGate: QuietGateId
}

/** Items 1 to 3 on. Second opinion off and the resolver off: on the shipped
 *  path (production 30 s windows, docs/stt-672-evaluation.md) neither
 *  resolver configuration passed the adoption rule (Large-v3 + Ultra -1.6% WER,
 *  CI -4.7 to +1.1), so Large-v3 alone writes the meeting. Parakeet Ultra stays
 *  installable for the preview and as the HQ primary. */
export const DEFAULT_STT_SETTINGS: Readonly<SttSettings> = Object.freeze({
  preview: 'turbo',
  hq: 'large-v3',
  secondOpinion: 'off',
  resolver: false,
  frontEnd: 'highpass',
  quietGate: 'silero',
})

export const STT_SETTINGS_FILE = 'stt-settings.json'
const settingsPath = () => dataPath(STT_SETTINGS_FILE)

function pick<T extends string>(ids: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (ids as readonly string[]).includes(value) ? value as T : fallback
}

/** Unknown or damaged stored values fall back to the default, key by key. */
export function normalizeStoredSettings(raw: unknown): SttSettings {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  return {
    preview: pick(PREVIEW_IDS, o.preview, DEFAULT_STT_SETTINGS.preview),
    hq: pick(HQ_IDS, o.hq, DEFAULT_STT_SETTINGS.hq),
    secondOpinion: pick(SECOND_OPINION_IDS, o.secondOpinion, DEFAULT_STT_SETTINGS.secondOpinion),
    resolver: typeof o.resolver === 'boolean' ? o.resolver : DEFAULT_STT_SETTINGS.resolver,
    frontEnd: pick(FRONT_END_IDS, o.frontEnd, DEFAULT_STT_SETTINGS.frontEnd),
    quietGate: pick(QUIET_GATE_IDS, o.quietGate, DEFAULT_STT_SETTINGS.quietGate),
  }
}

let cache: { mtimeMs: number; size: number; value: SttSettings } | null = null
let warnedCorrupt = false

/** Stored settings (no capability check). Cheap enough for every live chunk. */
export function readSttSettings(): SttSettings {
  const path = settingsPath()
  let stat: { mtimeMs: number; size: number } | null = null
  try { const s = statSync(path); stat = { mtimeMs: s.mtimeMs, size: s.size } } catch { stat = null }
  if (!stat) { cache = null; return { ...DEFAULT_STT_SETTINGS } }
  if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return { ...cache.value }
  let value: SttSettings
  try { value = normalizeStoredSettings(JSON.parse(readFileSync(path, 'utf8'))) } catch (error) {
    // Unreadable settings run the defaults; say so once, not on every chunk.
    if (!warnedCorrupt) { warnedCorrupt = true; console.warn(`[stt] ${STT_SETTINGS_FILE} is unreadable (${error instanceof Error ? error.message : error}); using the defaults until it is rewritten`) }
    value = { ...DEFAULT_STT_SETTINGS }
  }
  cache = { ...stat, value }
  return { ...value }
}

export function writeSttSettings(next: SttSettings): void {
  atomicWriteFileSync(settingsPath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  cache = null
}

export function __resetSttSettingsCacheForTests(): void { cache = null; warnedCorrupt = false }

// ── Last HQ job (for GET: what actually happened, not only what was chosen) ──

export interface LastSttJob {
  at: string
  meeting: string
  outcome: 'batch' | 'rejected' | 'failed'
  summary: unknown
}
const LAST_JOB_FILE = 'stt-last-job.json'

export function recordLastSttJob(job: LastSttJob): void {
  try { atomicWriteFileSync(dataPath(LAST_JOB_FILE), JSON.stringify(job, null, 2) + '\n', { mode: 0o600 }) } catch { /* telemetry only */ }
}

export function readLastSttJob(): LastSttJob | null {
  try { return JSON.parse(readFileSync(dataPath(LAST_JOB_FILE), 'utf8')) as LastSttJob } catch { return null }
}

// ── Capabilities ──────────────────────────────────────────────────────────────

export interface SttCapabilities {
  turboModel: boolean
  /** The live commit worker runs Large-v3 (the Max tier). */
  liveLargeV3: boolean
  /** whisper-cli plus Large-v3 weights for meeting HQ. */
  hqLargeV3: boolean
  parakeetInstalled: boolean
  parakeetPreviewWarm: boolean
  parakeetPreviewWarming: boolean
  /** The warm-up ran and failed (distinct from still warming). */
  parakeetPreviewWarmFailed?: boolean
  /** Repeated preview misses opened the preview breaker: Turbo until it closes. */
  parakeetPreviewBreakerOpen?: boolean
  previewDisabledByEnv: boolean
}

export interface SttOption {
  id: string
  label: string
  available: boolean
  experimental: boolean
  note: string
}

/** Every preview `model` string this server can return (contract-tested;
 *  a subset of what phone 6.10.639 accepts). */
export const PREVIEW_MODEL_STRINGS = ['large-v3-turbo', 'parakeet-ultra'] as const
/** The request parameter a client uses to say which preview models it accepts. */
export const PREVIEW_MODELS_PARAM = 'previewModels'
export const PREVIEW_REQUIRES_APP = '6.10.639'

export function previewOptions(c: SttCapabilities): SttOption[] {
  const parakeetNote = !c.parakeetInstalled
    ? 'Install Parakeet on this Mac first.'
    : c.parakeetPreviewBreakerOpen
      ? 'Parakeet missed several previews in a row; Whisper Turbo previews for a few minutes, then Parakeet is tried again.'
      : c.parakeetPreviewWarm
        ? 'Parakeet Ultra on the Neural Engine, about 0.3 s per chunk. Experimental: compare it live yourself. Needs COS Glasses 6.10.639; older phones keep Whisper Turbo.'
        : c.parakeetPreviewWarmFailed
          ? 'Parakeet could not start; Whisper Turbo previews. It is tried again every 2 minutes.'
          : c.parakeetPreviewWarming
            ? 'Warming up (the first load takes 15 to 25 s). Whisper Turbo previews until it is ready.'
            : 'Warms up when selected and no recording is live. Whisper Turbo previews until it is ready.'
  return [
    { id: 'turbo', label: 'Whisper Turbo', available: c.turboModel && !c.previewDisabledByEnv, experimental: false,
      note: c.previewDisabledByEnv ? 'Meeting preview is turned off on this server (COS_WHISPER_MEETING_PREVIEW=0).' : c.turboModel ? 'Fast provisional text. Saved text never comes from the preview.' : 'Turbo weights are missing on this Mac.' },
    { id: 'large-v3', label: 'Whisper Large-v3', available: false, experimental: false,
      note: 'Not offered: a Large-v3 preview would share the live Large-v3 worker that writes the saved text.' },
    { id: 'parakeet', label: 'Parakeet Ultra', available: c.parakeetInstalled && !c.previewDisabledByEnv, experimental: true, note: parakeetNote },
    { id: 'nemotron-560', label: 'Nemotron streaming 560 ms', available: false, experimental: true,
      note: 'Not wired in this server: FluidAudio 0.17.4 runs Nemotron only as a whole-file batch, so it cannot stream a live preview yet.' },
  ]
}

export function hqOptions(c: SttCapabilities): SttOption[] {
  const lv3 = c.hqLargeV3 ? '' : 'Needs whisper-cli and the Large-v3 weights. '
  return [
    { id: 'large-v3', label: 'Whisper Large-v3', available: c.hqLargeV3, experimental: false, note: `${lv3}Word timestamps on, mapped through Whisper's own speech segments.`.trim() },
    { id: 'large-v3-legacy', label: 'Whisper Large-v3 (legacy decoder)', available: c.hqLargeV3, experimental: false, note: `${lv3}The pre-6.72 decoder without timestamps. Kept for rollback.`.trim() },
    { id: 'parakeet-ultra', label: 'Parakeet Ultra', available: c.parakeetInstalled, experimental: true,
      note: c.parakeetInstalled ? 'Lower silver WER than Large-v3, weaker on names; see the evaluation.' : 'Install Parakeet on this Mac first.' },
  ]
}

export function secondOpinionOptions(c: SttCapabilities): SttOption[] {
  return [
    { id: 'off', label: 'Off', available: true, experimental: false, note: 'One engine only.' },
    { id: 'parakeet-ultra', label: 'Parakeet Ultra', available: c.parakeetInstalled, experimental: false,
      note: c.parakeetInstalled ? 'Hears every saved meeting again on the Neural Engine, about 0.6 s per 30 s of audio, after the meeting is saved. Disagreements are saved with the meeting.' : 'Install Parakeet on this Mac first.' },
    { id: 'large-v3', label: 'Whisper Large-v3', available: c.hqLargeV3, experimental: false, note: 'For a Parakeet HQ model. Adds a full Large-v3 pass to every saved meeting: about 0.2x the audio length on Metal, about 1x on a busy CPU.' },
  ]
}

const FRONT_END_OPTIONS: SttOption[] = [
  { id: 'highpass', label: 'Highpass only', available: true, experimental: false, note: '80 Hz highpass. Does not lift faint background speech over the speech detector.' },
  { id: 'full', label: 'Full chain', available: true, experimental: false, note: 'Highpass, noise reduction and loudness normalization (before 6.72).' },
]
const QUIET_GATE_OPTIONS: SttOption[] = [
  { id: 'silero', label: 'Speech detector', available: true, experimental: false, note: 'A chunk with under 0.5 s of detected speech is treated as quiet.' },
  { id: 'rms', label: 'Volume threshold', available: true, experimental: false, note: 'RMS below 150 (before 6.72). Rarely fires on G2 audio.' },
]

/** The engine family a choice decodes with; a second opinion must differ from HQ. */
export function engineFamily(id: HqId | SecondOpinionId): 'whisper' | 'parakeet' | 'off' {
  return id === 'off' ? 'off' : id.startsWith('parakeet') ? 'parakeet' : 'whisper'
}

export class SttSettingsError extends Error {
  constructor(message: string) { super(message); this.name = 'SttSettingsError' }
}

const KEYS = ['preview', 'hq', 'secondOpinion', 'resolver', 'frontEnd', 'quietGate'] as const

/**
 * Apply a partial PUT. Throws SttSettingsError with a plain sentence for an
 * unknown key, an unknown id, an unavailable choice or a conflict.
 * Changing HQ onto the second opinion's engine moves the second opinion to the
 * other engine (unless the same request sets it), so one tap never fails.
 */
export function applySettingsPatch(current: SttSettings, body: unknown, c: SttCapabilities): SttSettings {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SttSettingsError('Send a JSON object, for example {"hq":"large-v3"}.')
  const patch = body as Record<string, unknown>
  const unknown = Object.keys(patch).filter(k => !(KEYS as readonly string[]).includes(k))
  if (unknown.length) throw new SttSettingsError(`Unknown setting: ${unknown.join(', ')}.`)
  const next = { ...current }
  const choose = <T extends string>(key: string, ids: readonly T[], options: SttOption[], label: string): T | undefined => {
    if (!(key in patch)) return undefined
    const value = patch[key]
    if (typeof value !== 'string' || !(ids as readonly string[]).includes(value)) {
      throw new SttSettingsError(`${label} must be one of: ${ids.join(', ')}.`)
    }
    const option = options.find(o => o.id === value)
    if (option && !option.available) throw new SttSettingsError(`${option.label} is not available: ${option.note}`)
    return value as T
  }
  const preview = choose('preview', PREVIEW_IDS, previewOptions(c), 'Preview model')
  const hq = choose('hq', HQ_IDS, hqOptions(c), 'HQ model')
  const second = choose('secondOpinion', SECOND_OPINION_IDS, secondOpinionOptions(c), 'Second opinion')
  const frontEnd = choose('frontEnd', FRONT_END_IDS, FRONT_END_OPTIONS, 'Front end')
  const quietGate = choose('quietGate', QUIET_GATE_IDS, QUIET_GATE_OPTIONS, 'Quiet gate')
  if ('resolver' in patch && typeof patch.resolver !== 'boolean') throw new SttSettingsError('resolver must be true or false.')
  if (preview) next.preview = preview
  if (hq) next.hq = hq
  if (second) next.secondOpinion = second
  if (frontEnd) next.frontEnd = frontEnd
  if (quietGate) next.quietGate = quietGate
  if (typeof patch.resolver === 'boolean') next.resolver = patch.resolver
  if (engineFamily(next.hq) === engineFamily(next.secondOpinion)) {
    if (second) throw new SttSettingsError('The second opinion must be a different engine from the HQ model.')
    const other: SecondOpinionId = engineFamily(next.hq) === 'parakeet' ? 'large-v3' : 'parakeet-ultra'
    const otherOk = secondOpinionOptions(c).find(o => o.id === other)?.available
    next.secondOpinion = otherOk ? other : 'off'
  }
  return next
}

// ── Effective choices ─────────────────────────────────────────────────────────

export interface EffectiveStt {
  settings: SttSettings
  preview: { engine: 'turbo' | 'large-v3' | 'parakeet'; reason: string | null }
  hq: { engine: HqId; reason: string | null }
  secondOpinion: { engine: SecondOpinionId; reason: string | null }
  resolver: boolean
  frontEnd: FrontEndId
  quietGate: QuietGateId
}

export const REASON_TEXT: Record<string, string> = {
  parakeet_not_installed: 'Parakeet is not installed on this Mac.',
  parakeet_warming: 'Parakeet is warming up.',
  parakeet_warm_failed: 'Parakeet could not start; using Turbo.',
  parakeet_breaker_open: 'Parakeet missed several previews; using Turbo for a few minutes.',
  large_v3_preview_not_offered: 'A Large-v3 preview is not offered; using Turbo.',
  nemotron_not_wired: 'Nemotron preview is not available in this server; using Turbo.',
  large_v3_unavailable: 'Large-v3 is not available on this Mac.',
  same_engine_as_hq: 'Same engine as the HQ model.',
  no_second_opinion: 'No second opinion is running, so nothing to refine with.',
}

/** What will actually run, given what is installed. A stored choice that is no
 *  longer possible falls back (preview to Turbo, HQ to Large-v3, second opinion
 *  to off) and says why with a code. */
export function effectiveStt(settings: SttSettings, c: SttCapabilities): EffectiveStt {
  let preview: EffectiveStt['preview'] = { engine: 'turbo', reason: null }
  if (settings.preview === 'large-v3') preview = { engine: 'turbo', reason: 'large_v3_preview_not_offered' }
  else if (settings.preview === 'parakeet') {
    preview = !c.parakeetInstalled ? { engine: 'turbo', reason: 'parakeet_not_installed' }
      : c.parakeetPreviewBreakerOpen ? { engine: 'turbo', reason: 'parakeet_breaker_open' }
        : c.parakeetPreviewWarm ? { engine: 'parakeet', reason: null }
          : c.parakeetPreviewWarmFailed ? { engine: 'turbo', reason: 'parakeet_warm_failed' }
            : { engine: 'turbo', reason: 'parakeet_warming' }
  } else if (settings.preview === 'nemotron-560') preview = { engine: 'turbo', reason: 'nemotron_not_wired' }
  let hq: EffectiveStt['hq'] = { engine: settings.hq, reason: null }
  if (settings.hq === 'parakeet-ultra' && !c.parakeetInstalled) hq = { engine: 'large-v3', reason: 'parakeet_not_installed' }
  let second: EffectiveStt['secondOpinion'] = { engine: settings.secondOpinion, reason: null }
  if (engineFamily(second.engine) === 'parakeet' && !c.parakeetInstalled) second = { engine: 'off', reason: 'parakeet_not_installed' }
  if (second.engine === 'large-v3' && !c.hqLargeV3) second = { engine: 'off', reason: 'large_v3_unavailable' }
  if (second.engine !== 'off' && engineFamily(second.engine) === engineFamily(hq.engine)) second = { engine: 'off', reason: 'same_engine_as_hq' }
  return {
    settings,
    preview,
    hq,
    secondOpinion: second,
    resolver: settings.resolver && second.engine !== 'off',
    frontEnd: settings.frontEnd,
    quietGate: settings.quietGate,
  }
}

export interface ParakeetStatus {
  installed: boolean
  installable: boolean
  version: string
  bytes: number
  progress: { state: string; bytesDone: number; bytesTotal: number; error: string | null; source?: unknown }
  warm: { preview: string; error?: string; at?: string }
  preview?: { breaker: { open: boolean; retryAt: string | null; misses: number }; counters: Record<string, number> }
  note: string
}

function slotReason(code: string | null): { reason: string | null; reasonCode: string | null } {
  return { reason: code ? (REASON_TEXT[code] ?? code) : null, reasonCode: code }
}

export function settingsView(settings: SttSettings, c: SttCapabilities, parakeet: ParakeetStatus, lastJob: LastSttJob | null = null) {
  const eff = effectiveStt(settings, c)
  const resolverCode = settings.resolver && !eff.resolver ? 'no_second_opinion' : null
  return {
    preview: {
      selected: settings.preview, effective: eff.preview.engine, ...slotReason(eff.preview.reason), options: previewOptions(c),
      models: [...PREVIEW_MODEL_STRINGS], clientParam: PREVIEW_MODELS_PARAM, requiresApp: PREVIEW_REQUIRES_APP,
      note: `Only phones that list a preview model in ${PREVIEW_MODELS_PARAM} get it (COS Glasses ${PREVIEW_REQUIRES_APP} and later); every other client gets Whisper Turbo.`,
    },
    hq: { selected: settings.hq, effective: eff.hq.engine, ...slotReason(eff.hq.reason), options: hqOptions(c) },
    secondOpinion: { selected: settings.secondOpinion, effective: eff.secondOpinion.engine, ...slotReason(eff.secondOpinion.reason), options: secondOpinionOptions(c) },
    resolver: { enabled: settings.resolver, effective: eff.resolver, ...slotReason(resolverCode) },
    frontEnd: { selected: settings.frontEnd, options: FRONT_END_OPTIONS },
    quietGate: { selected: settings.quietGate, options: QUIET_GATE_OPTIONS },
    parakeet,
    lastJob,
    appliesTo: { preview: 'next live chunk', hq: 'next saved meeting' },
  }
}
