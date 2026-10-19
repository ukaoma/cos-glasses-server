// Key lanes (K1, plan v4 section 3.1): `/api/key-lanes/*`.
//
// While keyLanesEnabled() is false, every path here falls through to the server's existing 404,
// byte for byte, with ONE deliberate exception agreed for K1: `POST /api/key-lanes/enable`, so COS
// Control can turn lanes on from its own Settings row without an env edit. That door answers only
// an authenticated (X-Cos-Token, checked here as well as by the global gate), loopback,
// non-browser request, and never while COS_KEY_LANES=0. It is the only call that creates
// key-lanes.json. Everything else (wrong method, wrong path, phone, browser, missing token) gets
// today's 404.
//
// While enabled: the exposure list in plan 3.1, nothing else. Writes are Mac only (loopback, no
// browser Origin), so a G2 or phone request cannot add, change or remove a key. No route ever
// returns a secret: keys go out as PublicKeyRecord (ref, kind, last 4, cap). No route logs a body.
import express, { Router, type ErrorRequestHandler, type Request, type RequestHandler } from 'express'
import { copyFileSync, existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dataPath } from '../lib/data-dir.js'
import {
  keyLanesActive,
  keyLanesEnabled,
  keyLanesEnvSwitch,
  keyLanesStatusProvider,
  runKeyLanesInactiveHooks,
  setKeyLanesEnabled,
} from '../lib/key-lanes.js'
import { deleteProfile, deleteProfilesFile, listProfiles, upsertProfile, validateProfileInput } from '../lib/key-profiles.js'
import type { BreakerState, KeyKind, KeyLanesStatusBody } from '../lib/key-relay-contract.js'
import { KEY_REF_RE } from '../lib/key-relay-contract.js'
import {
  deleteKey,
  deleteKeyStore,
  getPublicKey,
  isKeyKind,
  keyShapeProblem,
  listPublicKeys,
  normalizeCapUsd,
  normalizeCompatibleBaseUrl,
  saveKey,
  updateKeyCap,
} from '../lib/key-store.js'
import { isLoopbackSocket } from '../lib/network-policy.js'
import { timingSafeTokenEqual } from '../lib/token-auth.js'
import { isKeyProfileId } from '../../shared/key-preference.js'

export const KEY_LANES_ENABLE_PATH = '/api/key-lanes/enable'
export const KEY_LEDGER_FILE = 'key-ledger.jsonl'
export const CODEX_HOMES_DIR = 'codex-homes'
const VALIDATE_TIMEOUT_MS = 10_000
const CATALOG_TIMEOUT_MS = 8_000
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000

export type KeyValidation =
  | { ok: true; limitRemainingUsd?: number; isFreeTier?: boolean }
  | { ok: false; error: string; message: string }

export interface CatalogModel {
  id: string
  name: string
  inUsdPerM: number
  outUsdPerM: number
}

export interface KeyLanesRouteDeps {
  /** The pairing token. The door checks it itself so it never relies on mount order alone. */
  apiToken?: () => string
  /** Plan 10.3 provider check. Tests inject a fake; the default calls the provider once. */
  validateKey?: (kind: KeyKind, secret: string, baseUrl?: string) => Promise<KeyValidation>
  /** Public OpenRouter catalog (no key). Called only by GET /key-lanes/catalog. */
  fetchCatalog?: () => Promise<CatalogModel[]>
  downloadsDir?: () => string
  now?: () => Date
}

// ── Who may write ────────────────────────────────────────────────────────────

export type MacOnlyRefusal = 'not_loopback' | 'browser'

/**
 * Null for a request from a native client on this Mac (COS Control). A phone or G2 companion
 * arrives on a LAN or Tailscale socket; a WebView or browser sends Origin (the companion's is
 * `null`). An agent child on loopback with the token cannot be told apart in
 * K1; it can still never read a secret back.
 */
export function macOnlyRefusal(req: Pick<Request, 'socket' | 'headers'>): MacOnlyRefusal | null {
  if (!isLoopbackSocket(req)) return 'not_loopback'
  // Browsers send Origin on every POST and DELETE (Fetch Metadata alone is not a tell: Node's
  // fetch sends sec-fetch-mode too).
  if (req.headers.origin !== undefined) return 'browser'
  return null
}

function requestPath(req: Request): string {
  return (req.originalUrl || req.url).split('?')[0]
}

/** The one door that answers while lanes are off. Everything it does not admit is today's 404. */
export function enableDoorOpen(req: Request, apiToken: () => string): boolean {
  return req.method === 'POST'
    && requestPath(req) === KEY_LANES_ENABLE_PATH
    && keyLanesEnvSwitch() !== 'off'
    && timingSafeTokenEqual(req.headers['x-cos-token'], apiToken())
    && macOnlyRefusal(req) === null
}

function admitted(req: Request, apiToken: () => string): boolean {
  return keyLanesEnabled() || enableDoorOpen(req, apiToken)
}

const defaultApiToken = () => process.env.COS_API_TOKEN ?? ''

/**
 * Mounted at `/api/key-lanes` BEFORE the global 10 MB JSON parser. A request it does not admit
 * passes through untouched, so the global parser and the 404 behave exactly as before. An admitted
 * one is parsed here at 32 KB, and a malformed body is refused without echoing a byte of it (Node's
 * JSON errors quote the input, which could be a key).
 */
export function createKeyLanesBodyParser(deps: Pick<KeyLanesRouteDeps, 'apiToken'> = {}): RequestHandler[] {
  const apiToken = deps.apiToken ?? defaultApiToken
  const parse = express.json({ limit: '32kb' })
  const gate: RequestHandler = (req, res, next) => {
    if (!admitted(req, apiToken)) return next()
    parse(req, res, next)
  }
  const refuse: ErrorRequestHandler = (_err, req, res, next) => {
    if (!admitted(req, apiToken)) return next(_err)
    res.status(400).json({ error: 'bad_json', message: 'The request body is not valid JSON.' })
  }
  return [gate, refuse as unknown as RequestHandler]
}

// ── Provider checks (plan 10.3) ──────────────────────────────────────────────

const PROVIDER_NAME: Record<KeyKind, string> = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-compatible': 'The endpoint',
}

/** One GET per save. Never logs, never puts the key in a URL, never returns it. */
export async function defaultValidateKey(kind: KeyKind, secret: string, baseUrl?: string): Promise<KeyValidation> {
  const name = PROVIDER_NAME[kind]
  const target = kind === 'openrouter' ? 'https://openrouter.ai/api/v1/key'
    : kind === 'anthropic' ? 'https://api.anthropic.com/v1/models'
    : kind === 'openai' ? 'https://api.openai.com/v1/models'
    : `${baseUrl ?? ''}/models`
  const headers: Record<string, string> = kind === 'anthropic'
    ? { 'x-api-key': secret, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${secret}` }
  let response: Response
  try {
    response = await fetch(target, { headers, signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS), redirect: 'error' })
  } catch {
    return { ok: false, error: 'validation_unreachable', message: `Could not reach ${name} to check the key. Try again.` }
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: 'key_rejected', message: `${name} rejected this key. Check it and paste it again.` }
  }
  if (!response.ok) return { ok: false, error: 'validation_failed', message: `${name} could not check the key (HTTP ${response.status}). Try again.` }
  if (kind !== 'openrouter') return { ok: true }
  let data: { limit?: unknown; limit_remaining?: unknown; is_free_tier?: unknown } | undefined
  try { data = ((await response.json()) as { data?: typeof data }).data } catch { data = undefined }
  if (!data) return { ok: false, error: 'validation_failed', message: 'OpenRouter sent an answer COS could not read. Try again.' }
  if (data.limit === null || data.limit === undefined) {
    return { ok: false, error: 'no_credit_limit', message: 'Set a credit limit on this key at openrouter.ai first.' }
  }
  if (typeof data.limit_remaining === 'number' && data.limit_remaining <= 0) {
    return { ok: false, error: 'out_of_credit', message: 'This OpenRouter key has no credit left.' }
  }
  return {
    ok: true,
    ...(typeof data.limit_remaining === 'number' ? { limitRemainingUsd: data.limit_remaining } : {}),
    ...(typeof data.is_free_tier === 'boolean' ? { isFreeTier: data.is_free_tier } : {}),
  }
}

// ── Catalog (plan 10.4) ──────────────────────────────────────────────────────

export const CURATED_KEY_MODELS = [
  { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', inUsdPerM: 2, outUsdPerM: 10, role: 'default' as const },
  { id: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5', inUsdPerM: 0.1, outUsdPerM: 0.5, role: 'cheaper' as const },
]

export async function defaultFetchCatalog(): Promise<CatalogModel[]> {
  const response = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS), redirect: 'error' })
  if (!response.ok) throw new Error(`catalog HTTP ${response.status}`)
  const body = await response.json() as { data?: Array<{ id?: unknown; name?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }> }
  const out: CatalogModel[] = []
  for (const m of body.data ?? []) {
    const inPer = Number(m.pricing?.prompt), outPer = Number(m.pricing?.completion)
    if (typeof m.id !== 'string' || !Number.isFinite(inPer) || !Number.isFinite(outPer)) continue
    out.push({ id: m.id, name: typeof m.name === 'string' ? m.name : m.id, inUsdPerM: inPer * 1e6, outUsdPerM: outPer * 1e6 })
  }
  return out
}

// ── Router ───────────────────────────────────────────────────────────────────

const CLOSED_BREAKER: BreakerState = { open: false, failures: 0 }

function statusBody(): KeyLanesStatusBody {
  const provider = keyLanesStatusProvider()
  return {
    enabled: keyLanesEnabled(),
    active: keyLanesActive(),
    keys: listPublicKeys().map(k => ({
      ref: k.ref,
      kind: k.kind,
      last4: k.last4,
      capUsd: k.capUsd,
      spentTodayUsd: provider.spentTodayUsd?.(k.ref) ?? 0,
      breaker: provider.breaker?.(k.ref) ?? CLOSED_BREAKER,
    })),
    profiles: listProfiles(),
    keyedSessionIds: provider.keyedSessionIds?.() ?? [],
  }
}

function ledgerExportName(dir: string, now: Date): string {
  const stem = `cos-key-ledger-${now.toISOString().slice(0, 10)}`
  let candidate = join(dir, `${stem}.jsonl`)
  for (let n = 2; existsSync(candidate) && n < 100; n++) candidate = join(dir, `${stem}-${n}.jsonl`)
  return candidate
}

export function createKeyLanesRouter(deps: KeyLanesRouteDeps = {}): Router {
  const apiToken = deps.apiToken ?? defaultApiToken
  const validateKey = deps.validateKey ?? defaultValidateKey
  const fetchCatalog = deps.fetchCatalog ?? defaultFetchCatalog
  const downloadsDir = deps.downloadsDir ?? (() => join(homedir(), 'Downloads'))
  const now = deps.now ?? (() => new Date())
  let catalogCache: { at: number; models: CatalogModel[] } | null = null

  const router = Router()

  // Off: the door or today's 404. `next('router')` leaves this router untouched.
  router.use('/key-lanes', (req, _res, next) => {
    if (admitted(req, apiToken)) return next()
    return next('router')
  })

  const macOnly: RequestHandler = (req, res, next) => {
    const refusal = macOnlyRefusal(req)
    if (!refusal) return next()
    return res.status(403).json({ error: 'mac_only', reason: refusal, message: 'Keys are managed in COS Control on this Mac.' })
  }

  /** After a write that may have ended the last enabled profile. */
  const settle = async (wasActive: boolean, reason: 'disabled' | 'no_enabled_profile') => {
    if (wasActive && !keyLanesActive()) await runKeyLanesInactiveHooks(reason)
  }

  router.post('/key-lanes/enable', macOnly, (_req, res) => {
    setKeyLanesEnabled(true, now)
    res.json({ enabled: keyLanesEnabled(), active: keyLanesActive() })
  })

  router.post('/key-lanes/disable', macOnly, async (_req, res) => {
    const wasActive = keyLanesActive()
    setKeyLanesEnabled(false, now)
    await settle(wasActive, 'disabled')
    const forcedOn = keyLanesEnvSwitch() === 'on'
    res.json({ enabled: keyLanesEnabled(), active: keyLanesActive(), ...(forcedOn ? { forcedOnBy: 'COS_KEY_LANES' } : {}) })
  })

  router.get('/key-lanes/status', (_req, res) => {
    res.set('Cache-Control', 'private, no-store')
    res.json(statusBody())
  })

  router.post('/key-lanes/keys', macOnly, async (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const body = (req.body ?? {}) as { kind?: unknown; key?: unknown; ref?: unknown; capUsd?: unknown; baseUrl?: unknown }
    // Cap change on a saved key: no secret in the body.
    if (body.key === undefined && typeof body.ref === 'string') {
      const cap = normalizeCapUsd(body.capUsd)
      if (body.capUsd === undefined || cap === null) return res.status(400).json({ error: 'invalid_cap', message: 'A daily cap is between $0.01 and $1000.' })
      const updated = updateKeyCap(body.ref, cap)
      if (!updated) return res.status(404).json({ error: 'unknown_key', message: 'That key is not saved on this Mac.' })
      return res.json({ key: updated })
    }
    if (!isKeyKind(body.kind)) return res.status(400).json({ error: 'invalid_kind', message: 'Pick OpenRouter, Anthropic, OpenAI or a custom endpoint.' })
    const kind = body.kind
    const shape = keyShapeProblem(kind, body.key)
    if (shape) return res.status(400).json({ error: 'invalid_key', message: shape })
    const cap = normalizeCapUsd(body.capUsd)
    if (cap === null) return res.status(400).json({ error: 'invalid_cap', message: 'A daily cap is between $0.01 and $1000.' })
    let baseUrl: string | undefined
    if (kind === 'openai-compatible') {
      baseUrl = normalizeCompatibleBaseUrl(body.baseUrl) ?? undefined
      if (!baseUrl) return res.status(400).json({ error: 'invalid_base_url', message: 'Give the endpoint URL, starting with https://.' })
    }
    const secret = (body.key as string).trim()
    let check: KeyValidation
    try {
      check = await validateKey(kind, secret, baseUrl)
    } catch {
      check = { ok: false, error: 'validation_failed', message: 'COS could not check the key. Try again.' }
    }
    if (!check.ok) return res.status(422).json({ error: check.error, message: check.message })
    const saved = saveKey({ kind, secret, capUsd: cap, validatedAt: now().toISOString(), ...(baseUrl ? { baseUrl } : {}) }, now)
    return res.json({
      key: saved,
      ...(check.limitRemainingUsd !== undefined || check.isFreeTier !== undefined
        ? { credit: { ...(check.limitRemainingUsd !== undefined ? { remainingUsd: check.limitRemainingUsd } : {}), ...(check.isFreeTier !== undefined ? { freeTier: check.isFreeTier } : {}) } }
        : {}),
    })
  })

  // Remove one key (plan 17 item 3). Refused while an enabled profile uses it, unless ?force=1,
  // which turns those profiles off first so no turn can pick a key that is gone.
  router.delete('/key-lanes/keys/:ref', macOnly, async (req, res) => {
    const ref = typeof req.params.ref === 'string' ? req.params.ref : ''
    if (!KEY_REF_RE.test(ref)) return res.status(400).json({ error: 'invalid_key_ref', message: 'Unknown key.' })
    if (!getPublicKey(ref)) return res.status(404).json({ error: 'unknown_key', message: 'That key is not saved on this Mac.' })
    const force = req.query.force === '1'
    const users = listProfiles().filter(p => p.keyRef === ref && p.enabled)
    if (users.length && !force) {
      return res.status(409).json({
        error: 'key_in_use',
        message: `Turn off the profiles that use this key first: ${users.map(p => p.label).join(', ')}.`,
        profiles: users.map(p => p.id),
      })
    }
    const wasActive = keyLanesActive()
    for (const p of users) upsertProfile({ ...p, enabled: false, updatedAt: now().toISOString() })
    deleteKey(ref)
    await settle(wasActive, 'no_enabled_profile')
    return res.json({ removed: true, disabledProfiles: users.map(p => p.id), active: keyLanesActive() })
  })

  router.post('/key-lanes/profiles', macOnly, async (req, res) => {
    const wasActive = keyLanesActive()
    const result = validateProfileInput((req.body ?? {}) as Record<string, unknown>, ref => getPublicKey(ref)?.kind, now)
    if (!result.ok) return res.status(400).json({ error: result.error, message: result.message })
    const write = upsertProfile(result.profile)
    if (!write.ok) return res.status(409).json({ error: write.error, message: 'That is the most key profiles COS keeps. Remove one first.' })
    await settle(wasActive, 'no_enabled_profile')
    return res.json({ profile: result.profile, active: keyLanesActive() })
  })

  router.delete('/key-lanes/profiles/:id', macOnly, async (req, res) => {
    if (!isKeyProfileId(req.params.id)) return res.status(400).json({ error: 'invalid_profile', message: 'Unknown profile id.' })
    const wasActive = keyLanesActive()
    const removed = deleteProfile(req.params.id)
    if (!removed) return res.status(404).json({ error: 'unknown_profile', message: 'No profile with that id.' })
    await settle(wasActive, 'no_enabled_profile')
    return res.json({ removed: true, active: keyLanesActive() })
  })

  router.post('/key-lanes/remove-all', macOnly, async (req, res) => {
    const body = (req.body ?? {}) as { exportLedger?: unknown }
    if (body.exportLedger !== undefined && typeof body.exportLedger !== 'boolean') {
      return res.status(400).json({ error: 'invalid_request', message: 'exportLedger is true or false.' })
    }
    const ledger = dataPath(KEY_LEDGER_FILE)
    let ledgerExportedTo: string | undefined
    if (body.exportLedger === true && existsSync(ledger)) {
      // Export first: if it fails, nothing has been removed yet.
      try {
        const dir = downloadsDir()
        mkdirSync(dir, { recursive: true })
        ledgerExportedTo = ledgerExportName(dir, now())
        copyFileSync(ledger, ledgerExportedTo)
      } catch {
        return res.status(500).json({ error: 'export_failed', message: 'Could not save the spend ledger to Downloads. Nothing was removed.' })
      }
    }
    // Revoke nonces and close the relay (P2), clear session bindings (P6) before the files go.
    const hookFailures = await runKeyLanesInactiveHooks('remove_all')
    const removed: string[] = []
    if (deleteKeyStore()) removed.push('keys')
    if (deleteProfilesFile()) removed.push('profiles')
    const homes = dataPath(CODEX_HOMES_DIR)
    if (existsSync(homes)) { rmSync(homes, { recursive: true, force: true }); removed.push('codexHomes') }
    if (existsSync(ledger)) { unlinkSync(ledger); removed.push('ledger') }
    setKeyLanesEnabled(false, now)
    return res.json({
      removed,
      enabled: keyLanesEnabled(),
      active: keyLanesActive(),
      ...(ledgerExportedTo ? { ledgerExportedTo } : {}),
      ...(hookFailures.length ? { hookFailures } : {}),
    })
  })

  router.get('/key-lanes/catalog', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase().slice(0, 40) : ''
    let models: CatalogModel[] | null = catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS ? catalogCache.models : null
    if (!models) {
      try {
        models = await fetchCatalog()
        catalogCache = { at: Date.now(), models }
      } catch {
        models = null
      }
    }
    const live = new Map((models ?? []).map(m => [m.id, m]))
    const curated = CURATED_KEY_MODELS.map(c => {
      const m = live.get(c.id)
      return { ...c, ...(m ? { inUsdPerM: m.inUsdPerM, outUsdPerM: m.outUsdPerM } : {}) }
    })
    // Lane B takes only anthropic/ and openai/ slugs; every other model is direct only (plan 4.4).
    const search = q && models
      ? models.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)).slice(0, 20)
        .map(m => ({ ...m, lanes: m.id.startsWith('anthropic/') || m.id.startsWith('openai/') ? ['key', 'direct'] : ['direct'] }))
      : undefined
    res.json({ curated, pricesFrom: models ? 'openrouter' : 'built-in', ...(search ? { search } : {}) })
  })

  return router
}
