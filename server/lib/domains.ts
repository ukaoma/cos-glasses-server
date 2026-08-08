// Which domains this COS has, and which one a meeting belongs to.
//
// WHY THIS FILE EXISTS. Four places independently hardcoded ONE user's business
// domains, and a fifth pretended to make them configurable:
//
//   cos-operations-meetings.ts  ['quilt','sprocket_rocket','hermit_crabs','personal']
//   cos-control-macos           the same four, in the folder-picker validator
//   cos-glasses-app             two abbreviation maps (display-pages.ts:843, :1104)
//   meeting-store.ts            domain.slice(0,2), which renders sprocket_rocket "SP"
//   profile.ts                  getDomainKeywords() — exported, ZERO call sites
//
// The two abbreviation schemes already disagreed with each other, and
// getDomainKeywords was a whole configuration chain built and never connected —
// which reads as "domains are configurable" to anyone who greps for it.
//
// A second person set up their own COS on 2026-08-08. Nothing she could name
// would work: the picker demanded a `quilt/` tree, and a domain like `DNP study`
// was rejected on save by a pattern permitting only lowercase and underscores.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadProfileObject } from './profile.js'

/**
 * Defaults for a COS that has never been configured and has no folders yet.
 *
 * Two, not four. `personal` and `business` are the split almost everyone has, and
 * the alternative — shipping the author's own business units — is what created
 * this file.
 */
export const DEFAULT_DOMAINS = ['personal', 'business'] as const

/**
 * The domain a meeting falls back to when nothing else decides.
 *
 * `personal` on purpose, and it is the SAFE direction: a work meeting filed under
 * personal is a misfiling the user notices and fixes, while a personal
 * conversation filed under a business domain can end up pasted into a work
 * channel. Matches the standing correction that G2 recordings default to personal
 * and get reclassified by content.
 */
export const FALLBACK_DOMAIN = 'personal'

/** Keyword seeds for the two defaults, used only when the user has set none. */
const DEFAULT_KEYWORDS: Record<string, string[]> = {
  business: [
    'client', 'customer', 'revenue', 'pipeline', 'roadmap', 'sprint', 'standup',
    'quarter', 'invoice', 'proposal', 'stakeholder', 'deadline', 'launch',
    'budget', 'campaign', 'hiring', 'onboarding', 'contract', 'vendor', 'demo',
  ],
  personal: [
    'family', 'kids', 'wife', 'husband', 'partner', 'doctor', 'dentist',
    'school', 'vacation', 'holiday', 'dinner', 'birthday', 'weekend', 'church',
    'grocery', 'house', 'insurance', 'therapy', 'workout', 'anniversary',
  ],
}

export interface DomainConfig {
  name: string
  /** Badge override. Derived when absent. */
  abbr?: string
  /** Words that route a meeting here. Case-insensitive, word-boundary matched. */
  keywords?: string[]
}

/**
 * Is this name safe as a path component AND as a domain label?
 *
 * A safety check, not a naming policy. Permits spaces and mixed case, because
 * `DNP study` is a real domain and the previous pattern (`^[a-z][a-z0-9_]{0,31}$`)
 * silently encoded one author's snake_case habit as a requirement — it accepted
 * `sprocket_rocket` and rejected `DNP study`.
 */
export function isSafeDomainName(name: string): boolean {
  if (!name || name.length > 64) return false
  if (name !== name.trim()) return false
  if (name === '.' || name === '..' || name.startsWith('.')) return false
  if (/[/\\\0]/.test(name)) return false
  // Control characters would corrupt a path or a markdown header.
  if (/[\x00-\x1f\x7f]/.test(name)) return false
  return true
}

/** The user's configured domains, or [] when unset. Malformed entries dropped. */
export function configuredDomains(): DomainConfig[] {
  const raw = loadProfileObject().domains
  if (!Array.isArray(raw)) return []
  const out: DomainConfig[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    // A bare string is accepted: `"domains": ["personal", "work"]` is the
    // shortest thing a user will reach for, and rejecting it would be hostile.
    const name = typeof entry === 'string'
      ? entry
      : (entry && typeof entry === 'object' && typeof (entry as DomainConfig).name === 'string')
        ? (entry as DomainConfig).name
        : ''
    const trimmed = name.trim()
    if (!isSafeDomainName(trimmed) || seen.has(trimmed.toLowerCase())) continue
    seen.add(trimmed.toLowerCase())
    const obj: Partial<DomainConfig> =
      (entry && typeof entry === 'object') ? entry as Partial<DomainConfig> : {}
    out.push({
      name: trimmed,
      ...(typeof obj.abbr === 'string' && obj.abbr.trim() ? { abbr: obj.abbr.trim().slice(0, 4) } : {}),
      ...(Array.isArray(obj.keywords)
        ? { keywords: obj.keywords.filter((k): k is string => typeof k === 'string' && !!k.trim()) }
        : {}),
    })
  }
  return out
}

/** Immediate subdirectories of `operationsDir` holding a `meetings/` tree. */
export function discoveredDomains(operationsDir: string | null): string[] {
  if (!operationsDir || !existsSync(operationsDir)) return []
  let names: string[]
  try {
    names = readdirSync(operationsDir, { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name)
  } catch { return [] }
  return names.filter(isSafeDomainName).filter(name => {
    const meetings = join(operationsDir, name, 'meetings')
    try { if (!statSync(meetings).isDirectory()) return false } catch { return false }
    // A `meetings/` folder is not enough: it must hold at least one YYYY-MM month
    // directory, which is the only shape the lister reads. Measured on a real
    // install, `operations/archive/meetings/` contains domain names rather than
    // months, so accepting any `meetings/` folder listed it as a domain with
    // permanently zero meetings. Structural, so it needs no blocklist of names.
    try {
      return readdirSync(meetings, { withFileTypes: true })
        .some(e => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name))
    } catch { return false }
  }).sort()
}

/**
 * Every domain this COS has, as a UNION of configuration and what is on disk.
 *
 * A union rather than a replacement, and the distinction is load-bearing:
 *
 *  - Configured but no folder yet: still listed, so a brand-new user can be
 *    ROUTED before any folder exists.
 *  - On disk but not configured: still listed, so a folder someone made by hand
 *    never becomes invisible. This is also what protects an existing install —
 *    Miles has no `domains` in his profile, discovery finds his four, and the
 *    union is exactly his four. Nothing is written to his profile and nothing
 *    about his setup changes.
 *  - Neither: the DEFAULTS. Only a genuinely fresh COS ever sees them, which is
 *    why defaulting to two is safe.
 *
 * Configured order is preserved and comes first; discovered extras follow,
 * sorted, so the list is stable across calls.
 */
export function resolveDomains(operationsDir: string | null): DomainConfig[] {
  const configured = configuredDomains()
  const discovered = discoveredDomains(operationsDir)
  if (configured.length === 0 && discovered.length === 0) {
    return DEFAULT_DOMAINS.map(name => ({ name, keywords: DEFAULT_KEYWORDS[name] }))
  }
  const known = new Set(configured.map(d => d.name.toLowerCase()))
  return [
    ...configured,
    ...discovered.filter(name => !known.has(name.toLowerCase())).map(name => ({ name })),
  ]
}

/** Just the names, in resolved order. */
export function domainNames(operationsDir: string | null): string[] {
  return resolveDomains(operationsDir).map(d => d.name)
}

/**
 * Short badge for a domain.
 *
 * An explicit `abbr` wins; otherwise initials of up to two words. Derivation
 * reproduces the old hand-written table exactly — quilt Q, personal P,
 * hermit_crabs HC, sprocket_rocket SR — which is why that table is gone. The old
 * `meeting-store` version used `slice(0,2)` and rendered sprocket_rocket "SP", so
 * the two schemes in this codebase disagreed with each other.
 */
export function domainAbbreviation(domain: string, config?: DomainConfig[]): string {
  const hit = config?.find(d => d.name.toLowerCase() === domain.toLowerCase())
  if (hit?.abbr) return hit.abbr
  const words = domain.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length === 0) return '?'
  // A short single word IS its own badge: the companion uses the short forms `sr`
  // and `hc`, and taking a first initial would render them "S" and "H".
  if (words.length === 1 && words[0].length <= 3) return words[0].toUpperCase()
  return words.slice(0, 2).map(w => w[0].toUpperCase()).join('')
}

/**
 * Which domain does this meeting belong to?
 *
 * Keyword scoring over the title and body, highest score wins. Deliberately NOT
 * an LLM call: this runs on every save, and a per-meeting model call would breach
 * the standing rule that every recurring LLM caller must justify its volume.
 *
 * Scoring counts DISTINCT matched keywords rather than total occurrences, so one
 * word repeated forty times cannot outvote four different signals. Word-boundary
 * matched, so "car" does not fire inside "carrier".
 *
 * Returns null when nothing scores, rather than picking. The caller decides, and
 * an unscored meeting must not be asserted into a business domain by accident.
 */
export function classifyDomain(
  text: string,
  domains: DomainConfig[],
): { domain: string; score: number; matched: string[] } | null {
  const haystack = text.toLowerCase()
  if (!haystack.trim()) return null
  let best: { domain: string; score: number; matched: string[] } | null = null
  for (const d of domains) {
    const keywords = d.keywords?.length ? d.keywords : DEFAULT_KEYWORDS[d.name.toLowerCase()] ?? []
    const matched: string[] = []
    for (const kw of keywords) {
      const needle = kw.toLowerCase().trim()
      if (!needle) continue
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'u').test(haystack)) {
        matched.push(needle)
      }
    }
    // Strictly greater, so the FIRST domain in resolved order wins a tie. Ties are
    // then deterministic and under the user's control via ordering.
    if (matched.length > 0 && (!best || matched.length > best.score)) {
      best = { domain: d.name, score: matched.length, matched }
    }
  }
  return best
}

/**
 * The domain to file a meeting under: the client's choice, else inference, else
 * the safe fallback.
 *
 * The fallback prefers a domain the user actually has — `personal` when present,
 * otherwise the first resolved domain — so a COS with no `personal` domain does
 * not have one invented for it.
 */
export function domainForMeeting(
  explicit: string | undefined,
  text: string,
  operationsDir: string | null,
): string {
  const domains = resolveDomains(operationsDir)
  if (explicit && explicit.trim() && isSafeDomainName(explicit.trim())) return explicit.trim()
  const inferred = classifyDomain(text, domains)
  if (inferred) return inferred.domain
  const personal = domains.find(d => d.name.toLowerCase() === FALLBACK_DOMAIN)
  return personal?.name ?? domains[0]?.name ?? FALLBACK_DOMAIN
}
