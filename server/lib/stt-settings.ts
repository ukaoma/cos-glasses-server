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
export const SECOND_OPINION_IDS = ['off', 'parakeet-v2', 'parakeet-ultra', 'large-v3'] as const
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

/** Items 1 to 3 on. Parakeet v2 as the second opinion with the resolver on: on
 *  the shipped Large-v3 path it passed the adoption rule (silver WER -11.1%,
 *  CI -19.7 to -2.8; entities +3.0 pts); with Ultra as the second opinion it did
 *  not (-7.3%, CI includes zero). See docs/stt-672-evaluation.md. */
export const DEFAULT_STT_SETTINGS: Readonly<SttSettings> = Object.freeze({
  preview: 'turbo',
  hq: 'large-v3',
  secondOpinion: 'parakeet-v2',
  resolver: true,
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

/** Stored settings (no capability check). Cheap enough for every live chunk. */
export function readSttSettings(): SttSettings {
  const path = settingsPath()
  let stat: { mtimeMs: number; size: number } | null = null
  try { const s = statSync(path); stat = { mtimeMs: s.mtimeMs, size: s.size } } catch { stat = null }
  if (!stat) { cache = null; return { ...DEFAULT_STT_SETTINGS } }
  if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return { ...cache.value }
  let value: SttSettings
  try { value = normalizeStoredSettings(JSON.parse(readFileSync(path, 'utf8'))) } catch { value = { ...DEFAULT_STT_SETTINGS } }
  cache = { ...stat, value }
  return { ...value }
}

export function writeSttSettings(next: SttSettings): void {
  atomicWriteFileSync(settingsPath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  cache = null
}

export function __resetSttSettingsCacheForTests(): void { cache = null }

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
  previewDisabledByEnv: boolean
}

export interface SttOption {
  id: string
  label: string
  available: boolean
  experimental: boolean
  note: string
}

export function previewOptions(c: SttCapabilities): SttOption[] {
  const parakeetNote = !c.parakeetInstalled
    ? 'Install Parakeet on this Mac first.'
    : c.parakeetPreviewWarm
      ? 'Parakeet Ultra on the Neural Engine, about 0.3 s per chunk. Experimental: compare it live yourself.'
      : c.parakeetPreviewWarming
        ? 'Warming up (the first load takes 15 to 25 s). Whisper Turbo previews until it is ready.'
        : 'Warms up when selected. Whisper Turbo previews until it is ready.'
  return [
    { id: 'turbo', label: 'Whisper Turbo', available: c.turboModel && !c.previewDisabledByEnv, experimental: false,
      note: c.previewDisabledByEnv ? 'Meeting preview is turned off on this server (COS_WHISPER_MEETING_PREVIEW=0).' : c.turboModel ? 'Fast provisional text. Saved text never comes from the preview.' : 'Turbo weights are missing on this Mac.' },
    { id: 'large-v3', label: 'Whisper Large-v3', available: c.liveLargeV3 && !c.previewDisabledByEnv, experimental: false,
      note: c.liveLargeV3 ? 'Runs on the live Large-v3 worker at preview priority. Slower than Turbo.' : 'Needs the Max transcription tier (the live Large-v3 worker).' },
    { id: 'parakeet', label: 'Parakeet (Neural Engine)', available: c.parakeetInstalled && !c.previewDisabledByEnv, experimental: true, note: parakeetNote },
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
    { id: 'parakeet-v2', label: 'Parakeet v2', available: c.parakeetInstalled, experimental: false,
      note: c.parakeetInstalled ? 'Hears every HQ window again on the Neural Engine. Disagreements are saved with the meeting. The measured best second opinion for Large-v3.' : 'Install Parakeet on this Mac first.' },
    { id: 'parakeet-ultra', label: 'Parakeet Ultra', available: c.parakeetInstalled, experimental: false,
      note: c.parakeetInstalled ? 'Hears every HQ window again on the Neural Engine. Inserts more words than v2 when it refines Large-v3.' : 'Install Parakeet on this Mac first.' },
    { id: 'large-v3', label: 'Whisper Large-v3', available: c.hqLargeV3, experimental: false, note: 'For a Parakeet HQ model. Adds a full Large-v3 pass.' },
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
    const other: SecondOpinionId = engineFamily(next.hq) === 'parakeet' ? 'large-v3' : 'parakeet-v2'
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

/** What will actually run, given what is installed. A stored choice that is no
 *  longer possible falls back to the default engine and says why. */
export function effectiveStt(settings: SttSettings, c: SttCapabilities): EffectiveStt {
  let preview: EffectiveStt['preview'] = { engine: 'turbo', reason: null }
  if (settings.preview === 'large-v3') preview = c.liveLargeV3 ? { engine: 'large-v3', reason: null } : { engine: 'turbo', reason: 'live_large_v3_unavailable' }
  else if (settings.preview === 'parakeet') {
    preview = !c.parakeetInstalled ? { engine: 'turbo', reason: 'parakeet_not_installed' }
      : c.parakeetPreviewWarm ? { engine: 'parakeet', reason: null }
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
  progress: { state: string; bytesDone: number; bytesTotal: number; error: string | null }
  warm: { preview: string }
  note: string
}

export function settingsView(settings: SttSettings, c: SttCapabilities, parakeet: ParakeetStatus) {
  const eff = effectiveStt(settings, c)
  return {
    preview: { selected: settings.preview, effective: eff.preview.engine, options: previewOptions(c) },
    hq: { selected: settings.hq, effective: eff.hq.engine, options: hqOptions(c) },
    secondOpinion: { selected: settings.secondOpinion, effective: eff.secondOpinion.engine, options: secondOpinionOptions(c) },
    resolver: { enabled: settings.resolver, effective: eff.resolver },
    frontEnd: { selected: settings.frontEnd, options: FRONT_END_OPTIONS },
    quietGate: { selected: settings.quietGate, options: QUIET_GATE_OPTIONS },
    parakeet,
    appliesTo: { preview: 'next live chunk', hq: 'next saved meeting' },
  }
}
