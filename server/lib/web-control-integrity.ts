// Served-asset integrity for COS Control Web (6.99.31, plan §4.8 / Phase 6). OFF by default:
// on with COS_WEB_CONTROL_INTEGRITY=1, and by default whenever COS_WEB_KEY_AUTHORITY=1 (signing
// is worthless if the page that holds the key can be rewritten on disk); COS_WEB_CONTROL_INTEGRITY=0
// turns it off even then. Read once at boot.
//
// WHY. The managed generation is user-writable (plan canary C7), and the static layer re-read the
// tree every second (C8), so any process running as Miles could rewrite app.js and have the phone
// run it within a second. With integrity on:
//   - the pack step writes `web-control/.manifest.json` (sha256 of every shipped file; the script is
//     server/scripts/write-web-control-manifest.mjs, mirrored by computeWebControlManifest below)
//   - at boot the manifest is read ONCE and kept in memory; every file is read once, hashed and
//     compared; only bytes that matched are ever served, from memory (the 1 s disk re-read is off)
//   - nothing outside the manifest is served (express.static is not mounted behind it)
//   - the tree is re-checked every `recheckMs` (60 s); a mismatch flips /control to a plain
//     integrity-error page (503) and logs which files; a later passing check serves again
//
// WHAT IT CANNOT DO. The manifest sits in the same writable directory: an edit of both an asset
// and the manifest BEFORE a boot passes here. Only COS Control (signed, App Management protected)
// holding the manifest hash itself catches that (plan §4.8 Control audit, Phase 2). `manifestSha256`
// is reported for that audit. A process that patches the server code and restarts it is out of reach.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readSwitch } from './env-switch.js'

export const WEB_CONTROL_MANIFEST_FILE = '.manifest.json'
export const WEB_CONTROL_INTEGRITY_RECHECK_MS = 60_000

export function webControlIntegrityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readSwitch(env.COS_WEB_CONTROL_INTEGRITY, readSwitch(env.COS_WEB_KEY_AUTHORITY, false))
}

export interface WebControlManifest { v: 1; algorithm: 'sha256'; files: Record<string, string> }

/** The files the manifest covers: every regular, non-dot file, except tests (never shipped). */
export function manifestFiles(dir: string, base = ''): Array<{ urlPath: string; file: string }> {
  const out: Array<{ urlPath: string; file: string }> = []
  let names: string[]
  try { names = readdirSync(dir) } catch { return out }
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue
    const file = join(dir, name)
    let st
    try { st = statSync(file) } catch { continue }
    const urlPath = `${base}/${name}`
    if (st.isDirectory()) out.push(...manifestFiles(file, urlPath))
    else if (st.isFile() && !name.endsWith('.test.ts')) out.push({ urlPath, file })
  }
  return out
}

/** What the pack step writes (and the .mjs script must produce byte for byte). */
export function computeWebControlManifest(dir: string): WebControlManifest {
  const files: Record<string, string> = {}
  for (const f of manifestFiles(dir)) files[f.urlPath] = createHash('sha256').update(readFileSync(f.file)).digest('hex')
  return { v: 1, algorithm: 'sha256', files }
}

export type IntegrityMismatch = { path: string; problem: 'changed' | 'missing' | 'unexpected' | 'unreadable' }

export interface IntegrityState {
  ok: boolean
  /** Why it failed, when it did: a manifest problem or the files that differ. */
  error: 'manifest_missing' | 'manifest_invalid' | 'files_mismatch' | null
  mismatches: IntegrityMismatch[]
  checkedAt: number
}

export class WebControlIntegrity {
  private manifest: WebControlManifest | null = null
  private manifestError: 'manifest_missing' | 'manifest_invalid' | null = null
  readonly manifestSha256: string | null
  private snapshotBytes: Map<string, Buffer> | null = null
  /** Bumps each time a passing check follows a failed one (or the first pass): the static layer rebuilds then. */
  generation = 0
  state: IntegrityState

  constructor(readonly dir: string, private readonly opts: { now?: () => number; log?: (line: string) => void } = {}) {
    let raw: Buffer | null = null
    try { raw = readFileSync(join(dir, WEB_CONTROL_MANIFEST_FILE)) } catch { this.manifestError = 'manifest_missing' }
    this.manifestSha256 = raw ? createHash('sha256').update(raw).digest('hex') : null
    if (raw) {
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as WebControlManifest
        const files = parsed?.files
        if (parsed?.v === 1 && parsed.algorithm === 'sha256' && files && typeof files === 'object'
          && Object.entries(files).every(([k, v]) => k.startsWith('/') && !k.includes('..') && typeof v === 'string' && /^[0-9a-f]{64}$/.test(v))) {
          this.manifest = { v: 1, algorithm: 'sha256', files: { ...files } }
        } else this.manifestError = 'manifest_invalid'
      } catch { this.manifestError = 'manifest_invalid' }
    }
    this.state = { ok: false, error: this.manifestError ?? 'files_mismatch', mismatches: [], checkedAt: 0 }
    this.check()
  }

  private now(): number { return (this.opts.now ?? Date.now)() }
  private log(line: string): void { (this.opts.log ?? ((l: string) => console.error(l)))(line) }

  /** The verified bytes (urlPath to bytes), or null while failing. Never re-read from disk by a server. */
  snapshot(): Map<string, Buffer> | null {
    return this.state.ok ? this.snapshotBytes : null
  }

  /**
   * Read every file once, hash it, compare with the boot manifest. The snapshot is built from the
   * very bytes that were hashed, so nothing read after the comparison is ever served.
   */
  check(): IntegrityState {
    const wasOk = this.state.ok
    const first = this.state.checkedAt === 0
    const at = this.now()
    if (!this.manifest) {
      this.state = { ok: false, error: this.manifestError ?? 'manifest_missing', mismatches: [], checkedAt: at }
      if (first) this.log(`[web-control-integrity] ${this.state.error}: /control is refused`)
      this.snapshotBytes = null
      return this.state
    }
    const expected = this.manifest.files
    const seen = new Set<string>()
    const bytes = new Map<string, Buffer>()
    const mismatches: IntegrityMismatch[] = []
    for (const f of manifestFiles(this.dir)) {
      seen.add(f.urlPath)
      const want = expected[f.urlPath]
      if (!want) { mismatches.push({ path: f.urlPath, problem: 'unexpected' }); continue }
      let body: Buffer
      try { body = readFileSync(f.file) } catch { mismatches.push({ path: f.urlPath, problem: 'unreadable' }); continue }
      if (createHash('sha256').update(body).digest('hex') !== want) { mismatches.push({ path: f.urlPath, problem: 'changed' }); continue }
      bytes.set(f.urlPath, body)
    }
    for (const p of Object.keys(expected)) if (!seen.has(p)) mismatches.push({ path: p, problem: 'missing' })
    const ok = mismatches.length === 0
    this.state = { ok, error: ok ? null : 'files_mismatch', mismatches, checkedAt: at }
    if (ok) {
      if (!wasOk) { this.snapshotBytes = bytes; this.generation += 1 }
    } else {
      this.snapshotBytes = null
      const list = mismatches.slice(0, 20).map(m => `${m.problem}:${m.path}`).join(', ')
      this.log(`[web-control-integrity] ${mismatches.length} file(s) do not match the manifest; /control is refused: ${list}`)
    }
    if (ok && !wasOk && this.generation > 1) this.log('[web-control-integrity] files match the manifest again; /control is served')
    return this.state
  }

  status(): Record<string, unknown> {
    return {
      enabled: true,
      ok: this.state.ok,
      error: this.state.error,
      mismatches: this.state.mismatches.slice(0, 50),
      checkedAt: this.state.checkedAt ? new Date(this.state.checkedAt).toISOString() : null,
      manifestSha256: this.manifestSha256,
      files: this.manifest ? Object.keys(this.manifest.files).length : 0,
    }
  }
}

/** The page served instead of /control while integrity fails. Plain, no script, no references. */
export const INTEGRITY_ERROR_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>COS Control Web: integrity check failed</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">COS Control Web is paused</h1><p>The files this Mac would send your phone do not match the files that shipped with this version, so they are not being served. Nothing was signed.</p><p>Open COS Control on the Mac to repair or reinstall the server.</p></body></html>'
