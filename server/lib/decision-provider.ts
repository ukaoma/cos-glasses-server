/** Explicit classifier routing. No retry or cross-provider fallback; generative engines do not use this seam. */
import { lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { JevClient, JevError, type JevAnswers } from './jev.js'
import { dataPath } from './data-dir.js'
import { durableAtomicWriteFileSync } from './atomic-fs.js'
import { redactSecretText } from './activity-preview.js'
import { secureExistingPrivateFile } from './secure-user-config.js'

import { resolveSubqKey, SUBQ_MODEL } from './subq-key.js'
export { SUBQ_MODEL } from './subq-key.js'
import { resolveDecisionSelection, type DecisionProvider, type DecisionUseCase } from './decision-settings.js'
export type { DecisionProvider, DecisionUseCase } from './decision-settings.js'
export interface DecisionImage { mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string }
export interface DecisionOptions { signal?: AbortSignal; images?: DecisionImage[] }
export interface DecisionClient { readonly provider?: DecisionProvider; snapshot?: () => DecisionClient; ask(state: unknown, questions: Record<string, unknown>, estimate: number, options?: DecisionOptions): Promise<JevAnswers> }
export class DecisionProviderError extends Error {
  constructor(readonly code: 'decision_invalid_provider' | 'decision_not_configured' | 'decision_cap_reached' | 'decision_breaker_open' |
    'decision_key_rejected' | 'decision_credits_required' | 'decision_rate_limited' | 'decision_request_rejected' | 'decision_unavailable' |
    'decision_bad_answer' | 'decision_cancelled' | 'decision_images_unsupported' | 'decision_usage_unavailable') { super(code) }
}
export const SUBQ_ENDPOINT = 'https://api.subq.ai/v1/systemone'
export const SUBQ_LIMITS = { timeoutMs: 20_000, dailyTokens: 1_000_000, breakerFailures: 3, breakerMs: 3_600_000, maxBodyBytes: 13 * 1024 * 1024 } as const

/** No key probing, and no unknown value silently treated as Jev. Per-use-case settings override the global switch. */
export function selectedDecisionProvider(useCase: DecisionUseCase, env: NodeJS.ProcessEnv = process.env): DecisionProvider {
  try { return resolveDecisionSelection(useCase, env).provider } catch { throw new DecisionProviderError('decision_invalid_provider') }
}
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
function clean(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretText(value).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/g, '[phone]')
  if (Array.isArray(value)) return value.map(clean)
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, v]) => [String(clean(key)), clean(v)]))
  return value
}
/** Validate locally. Image bytes are never logged, persisted, fetched by URL, or inferred from a user's screen. */
function requestBody(state: unknown, questions: Record<string, unknown>, images: DecisionImage[] = []): string {
  const entries = Object.entries(questions)
  if (!entries.length || entries.length > 16 || entries.some(([k, q]) => !k || k.length > 100 || !isRecord(q) || typeof q.instructions !== 'string' ||
    !['noul', 'choice', 'score'].includes(String(q.type)) || (q.type === 'choice' && (!isRecord(q.criteria) || Object.keys(q.criteria).length < 2 || Object.keys(q.criteria).length > 255)) ||
    (q.type === 'score' && (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10)))) throw new DecisionProviderError('decision_request_rejected')
  let total = 0
  if (images.length > 4) throw new DecisionProviderError('decision_request_rejected')
  for (const image of images) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mediaType) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64)) throw new DecisionProviderError('decision_request_rejected')
    const bytes = Buffer.from(image.base64, 'base64'); total += bytes.length
    const valid = image.mediaType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) :
      image.mediaType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    if (!valid || bytes.length > 4 * 1024 * 1024 || total > 8 * 1024 * 1024) throw new DecisionProviderError('decision_request_rejected')
  }
  const body = JSON.stringify({ model: SUBQ_MODEL, state: clean(state), questions: clean(questions), ...(images.length ? { images } : {}) })
  if (Buffer.byteLength(body) > SUBQ_LIMITS.maxBodyBytes) throw new DecisionProviderError('decision_request_rejected')
  return body
}

/** Strict schema at the provider boundary, before any workflow threshold can turn it into advice. */
export function validateDecisionAnswers(raw: unknown, questions: Record<string, unknown>): JevAnswers['answers'] {
  if (!isRecord(raw) || Object.keys(raw).length !== Object.keys(questions).length) throw new DecisionProviderError('decision_bad_answer')
  for (const [name, spec] of Object.entries(questions)) {
    const q = spec as Record<string, unknown>, a = raw[name]
    if (!isRecord(a) || a.type !== q.type) throw new DecisionProviderError('decision_bad_answer')
    if (q.type === 'noul') { if (!probability(a.noul)) throw new DecisionProviderError('decision_bad_answer'); continue }
    const criteria = q.criteria as Record<string, unknown> | unknown[]
    const labels = Object.keys(criteria), probs = a.probabilities
    if (!isRecord(probs) || Object.keys(probs).length !== labels.length || labels.some(k => !probability(probs[k])) ||
      Math.abs(Object.values(probs).reduce<number>((sum, p) => sum + Number(p), 0) - 1) > 0.02 || !probability(a.confidence)) throw new DecisionProviderError('decision_bad_answer')
    if (q.type === 'choice' && (typeof a.choice !== 'string' || !labels.includes(a.choice))) throw new DecisionProviderError('decision_bad_answer')
    if (q.type === 'score' && (typeof a.score !== 'number' || !Number.isFinite(a.score) || a.score < 0 || a.score > labels.length - 1 || !isRecord(a.legend) || labels.some(k => !(k in (a.legend as Record<string, unknown>))))) throw new DecisionProviderError('decision_bad_answer')
  }
  return raw as JevAnswers['answers']
}

export class SubqDecisionClient implements DecisionClient {
  readonly provider = 'subq' as const
  private failures = 0
  private breakerUntil = 0
  private reserved = 0
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => Date = () => new Date(),
    private readonly usageFile = dataPath('subq-decisions-usage.json'), private readonly key = () => resolveSubqKey()?.key,
    private readonly cap = () => { const n = Number(process.env.COS_SUBQ_DAILY_TOKENS); return Number.isFinite(n) && n > 0 ? Math.floor(n) : SUBQ_LIMITS.dailyTokens },
    private readonly timeoutMs: number = SUBQ_LIMITS.timeoutMs) {}
  resetForNewKey(): void { this.failures = 0; this.breakerUntil = 0 }
  /** For an honest capability (6.76.2, live cues). An unreadable ledger reads as the cap reached: it fails toward not spending. */
  status(): { configured: boolean; usedToday: number; dailyCap: number; breakerOpenUntil: number | null } {
    const dailyCap = this.cap()
    let usedToday = dailyCap
    try { usedToday = Number(this.ledger()[this.day()]) || 0 } catch { /* unreadable ledger: saturated */ }
    return { configured: !!this.key(), usedToday, dailyCap, breakerOpenUntil: this.breakerUntil > this.now().getTime() ? this.breakerUntil : null }
  }
  private ledger(): Record<string, number> {
    try {
      const stat = lstatSync(this.usageFile)
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe')
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return {}
      throw new DecisionProviderError('decision_usage_unavailable')
    }
    try {
      secureExistingPrivateFile(this.usageFile)
      const value: unknown = JSON.parse(readFileSync(this.usageFile, 'utf8'))
      if (!isRecord(value) || Object.entries(value).some(([day, count]) => !/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof count !== 'number' || !Number.isFinite(count) || count < 0 || count > Number.MAX_SAFE_INTEGER)) throw new Error('invalid')
      return value as Record<string, number>
    } catch { throw new DecisionProviderError('decision_usage_unavailable') }
  }
  private day(): string { return this.now().toISOString().slice(0, 10) }
  private record(tokens: number): void {
    try {
      const ledger = this.ledger(); ledger[this.day()] = (ledger[this.day()] ?? 0) + tokens
      mkdirSync(dirname(this.usageFile), { recursive: true, mode: 0o700 })
      durableAtomicWriteFileSync(this.usageFile, JSON.stringify(ledger) + '\n', { mode: 0o600 })
    } catch { throw new DecisionProviderError('decision_usage_unavailable') }
  }
  private fail(code: DecisionProviderError['code'], breaker = false): never {
    if (breaker && ++this.failures >= SUBQ_LIMITS.breakerFailures) { this.breakerUntil = this.now().getTime() + SUBQ_LIMITS.breakerMs; this.failures = 0 }
    throw new DecisionProviderError(code)
  }
  async ask(state: unknown, questions: Record<string, unknown>, _estimate: number, options: DecisionOptions = {}): Promise<JevAnswers> {
    if (options.signal?.aborted) return this.fail('decision_cancelled')
    const key = this.key(); if (!key) return this.fail('decision_not_configured')
    if (this.breakerUntil > this.now().getTime()) return this.fail('decision_breaker_open')
    const body = requestBody(state, questions, options.images)
    // Reserve a conservative byte-based estimate, including encoded images, before concurrent requests can enter.
    const estimate = Buffer.byteLength(body) + 1
    if ((Number(this.ledger()[this.day()]) || 0) + this.reserved + estimate > this.cap()) return this.fail('decision_cap_reached')
    this.reserved += estimate
    try {
      let res: Response
      try { res = await this.fetchImpl(SUBQ_ENDPOINT, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body, signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(options.signal ? [options.signal] : [])]) }) }
      catch { this.record(estimate); return this.fail(options.signal?.aborted ? 'decision_cancelled' : 'decision_unavailable', !options.signal?.aborted) }
      if (res.status === 401 || res.status === 403) return this.fail('decision_key_rejected')
      if (res.status === 402) return this.fail('decision_credits_required')
      if (res.status === 429) return this.fail('decision_rate_limited')
      if ([400, 413, 422].includes(res.status)) return this.fail('decision_request_rejected')
      if (!res.ok) return this.fail('decision_unavailable', true)
      // Count conservative usage even when a successful response is unreadable. No raw provider error is echoed.
      let raw: unknown
      try { raw = await res.json() } catch { this.record(estimate); return this.fail('decision_bad_answer', true) }
      const used = isRecord(raw) && isRecord(raw.usage) && typeof raw.usage.input_tokens === 'number' && Number.isFinite(raw.usage.input_tokens) && raw.usage.input_tokens > 0 ? raw.usage.input_tokens : estimate
      this.record(used)
      if (!isRecord(raw) || raw.model !== SUBQ_MODEL) return this.fail('decision_bad_answer', true)
      let answers: JevAnswers['answers']
      try { answers = validateDecisionAnswers(raw.answers, questions) } catch { return this.fail('decision_bad_answer', true) }
      this.failures = 0
      return { provider: 'subq', answers, model: SUBQ_MODEL, inputTokens: used }
    } finally { this.reserved -= estimate }
  }
}

const configuredSubqClients = new Set<SubqDecisionClient>()
export function resetSubqDecisionClients(): void { configuredSubqClients.forEach(client => client.resetForNewKey()) }
/** A SubQ client built outside createDecisionClient (live cues, 6.76.2) still starts clean when a new key is saved. */
export function trackSubqDecisionClient(client: SubqDecisionClient): SubqDecisionClient { configuredSubqClients.add(client); return client }
/** Snapshot selection per workflow request. Separate clients and cache identities prevent stale cross-provider answers. */
export function createDecisionClient(useCase: DecisionUseCase, jev: Pick<JevClient, 'ask'> = new JevClient(), env: NodeJS.ProcessEnv = process.env): DecisionClient {
  const clients: Partial<Record<DecisionProvider, DecisionClient>> = {}
  const snapshot = (): DecisionClient => {
    const selected = selectedDecisionProvider(useCase, env)
    if (!clients[selected]) clients[selected] = selected === 'subq' ? new SubqDecisionClient(fetch, () => new Date(), dataPath(`subq-${useCase}-usage.json`)) : {
      provider: 'jev', async ask(state, questions, estimate, options) {
        if (options?.images?.length) throw new DecisionProviderError('decision_images_unsupported')
        return { ...await jev.ask(state, questions, estimate, options), provider: 'jev' }
      },
    }
    if (selected === 'subq') configuredSubqClients.add(clients[selected] as SubqDecisionClient)
    return clients[selected]!
  }
  return { snapshot, ask: (state, questions, estimate, options) => snapshot().ask(state, questions, estimate, options) }
}
export function isDecisionFailure(error: unknown): error is JevError | DecisionProviderError { return error instanceof JevError || error instanceof DecisionProviderError }
