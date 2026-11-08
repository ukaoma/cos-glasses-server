#!/usr/bin/env node
// 6.99.31 Phase 3 mutation gate: every guard of the phone key signer page (server/web-signer/), its
// proof assembly seam (signer-proof.js), the 3144 listener handler (lib/web-key-signer-app.ts), the
// 3143 to 3144 handoff (lib/web-key-handoff.ts and its routes in routes/web-key.ts), the health
// capability and the Control Web composer offer (app.js). Same harness as web-key-mutation-gate.mjs:
// mutations run only in a disposable copy of the checkout; the live checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated (a gate over a red suite reads every mutant as killed).
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/web-key-signer-mutation-gate.mjs [--list | --check] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PRT = ['server/web-signer/signer-proof.test.ts']
const PGT = ['server/web-signer/signer-page.test.ts']
const APT = ['server/lib/web-key-signer-app.test.ts']
const HOT = ['server/lib/web-key-handoff.test.ts']
const CMT = ['server/web-control/web-key-handoff-web.test.ts']
const HLT = ['server/routes/health-web-key-signer.test.ts']
const ALL = [...PRT, ...PGT, ...APT, ...HOT, ...CMT, ...HLT]
const PROOF = 'server/web-signer/signer-proof.js', PAGE = 'server/web-signer/signer.js', SAPP = 'server/lib/web-key-signer-app.ts'
const HAND = 'server/lib/web-key-handoff.ts', WKR = 'server/routes/web-key.ts', HEALTH = 'server/routes/health.ts', APP = 'server/web-control/app.js'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })
const drop = (name, file, line, tests) => m(name, file, [line, ''], tests)

const mutations = [
  m('proof-approval-packet-sha', PROOF, ["if (hex(d) !== scope.packetSha256) throw fail('packet_mismatch');", ''], [...PRT, ...PGT]),
  m('page-shown-packet-unchanged', PAGE, ["    if (($('sign-packet') ? $('sign-packet').textContent : '') !== state.shownPacket) { problem('The release request on screen changed. Nothing was signed.'); return undefined }\n", ''], PGT),
  m('composer-selected-packet-hash', APP, ['      if (packetSha) request.packetSha256 = packetSha;\n', ''], CMT),
  m('composer-late-handoff-live', APP, ["        if (!view.live()) return 'stale';\n        var body = h.body || {};", '        var body = h.body || {};'], CMT),
  // ── The proof seam (server/web-signer/signer-proof.js) ──
  m('proof-trim-trailing-ws', PROOF, ["return String(words == null ? '' : words).replace(TRAILING_WS, '')", "return String(words == null ? '' : words)"], [...PRT, ...PGT]),
  m('proof-challenge-is-sha256-envelope', PROOF, ['function passkeyChallenge(envelopeBytes) { return sha256(envelopeBytes) }', 'function passkeyChallenge(envelopeBytes) { return sha256(concat(envelopeBytes, [0])) }'], [...PRT, ...PGT]),
  m('proof-origin-from-page-only', PROOF, ['        words: h.words, attachments: h.attachments, origin: input.origin,', '        words: h.words, attachments: h.attachments, origin: h.origin || input.origin,'], PRT),
  m('proof-origin-https-only', PROOF, ["if (typeof f.origin !== 'string' || !/^https:\\/\\/[^/\\s]+$/.test(f.origin))", "if (typeof f.origin !== 'string' || !/^https?:\\/\\/[^/\\s]+$/.test(f.origin))"], PRT),
  drop('proof-attachments-refused', PROOF, "    if (f.attachments && f.attachments.length) throw fail('attachments_not_signable')\n", PRT),
  drop('proof-words-empty', PROOF, "    if (!words.trim()) throw fail('words_empty')\n", PRT),
  drop('proof-p1363-length', PROOF, "      if (s.length !== 64) throw fail('signature_not_p1363')\n", PRT),
  m('proof-iat-backdate', PROOF, ['    var iat = nowS - IAT_BACKDATE_S', '    var iat = nowS'], PRT),
  m('proof-never-fork', PROOF, ['          fork: false, wordsSha256: d.sha256,', '          fork: true, wordsSha256: d.sha256,'], PRT),
  m('proof-sas-includes-r', PROOF, ['return sha256(concat(challenge, spkiDer, r)).then', 'return sha256(concat(challenge, spkiDer)).then'], [...PRT, ...PGT]),
  m('proof-enroll-message-nonce', PROOF, ['      phoneNonce: p.phoneNonce, passkey_credential_id: p.passkeyCredentialId,', '      passkey_credential_id: p.passkeyCredentialId,'], PRT),
  m('proof-scope-closed', PROOF, ["    throw fail('scope_not_allowed')\n  }\n\n  /**", "    return { kind: 'message' }\n  }\n\n  /**"], PRT),
  m('proof-jcs-lone-surrogate', PROOF, ["      if (hasLoneSurrogate(value)) throw fail('not_signable')\n      return JSON.stringify(value)", '      return JSON.stringify(value)'], PRT),
  // ── The page (server/web-signer/signer.js) ──
  drop('page-never-framed', PAGE, "    if (framed()) { show('framed'); return Promise.resolve() }\n", PGT),
  m('page-approve-trusted-tap', PAGE, ['    if (!ev || ev.isTrusted !== true) return undefined\n    if (state.busy || !state.handoff', '    if (state.busy || !state.handoff'], PGT),
  m('page-enroll-trusted-tap', PAGE, ['    if (!ev || ev.isTrusted !== true || state.busy) return undefined', '    if (!ev || state.busy) return undefined'], PGT),
  drop('page-shown-words-unchanged', PAGE, "    if (shown !== state.shownWords) { problem('The words on screen changed. Nothing was signed.'); return undefined }\n", PGT),
  m('page-enroll-confirm-trusted-tap', PAGE, ['    if (!ev || ev.isTrusted !== true || state.busy || !c) return undefined', '    if (!ev || state.busy || !c) return undefined'], PGT),
  m('page-sas-must-match', PAGE, ['      if (a.body.sas !== c.code) return enrollFail(', '      if (false) return enrollFail('], PGT),
  m('page-hash-cleared', PAGE, ["    try { if (W.location.hash) W.history.replaceState(null, '', W.location.pathname) }", "    try { if (false) W.history.replaceState(null, '', W.location.pathname) }"], PGT),
  m('page-get-uv-required', PAGE, ["        challenge: challenge, rpId: W.location.hostname, userVerification: 'required', timeout: 120000,", "        challenge: challenge, rpId: W.location.hostname, userVerification: 'preferred', timeout: 120000,"], PGT),
  m('page-create-uv-required', PAGE, ["authenticatorSelection: { residentKey: 'preferred', requireResidentKey: false, userVerification: 'required' }", "authenticatorSelection: { residentKey: 'preferred', requireResidentKey: false, userVerification: 'preferred' }"], PGT),
  m('page-create-resident-preferred', PAGE, ["authenticatorSelection: { residentKey: 'preferred', requireResidentKey: false,", "authenticatorSelection: { residentKey: 'discouraged', requireResidentKey: false,"], PGT),
  m('page-render-trims', PAGE, ['    var words = P.signedWords(h.words)\n    if (!words.trim())', '    var words = h.words\n    if (!words.trim())'], PGT),
  m('page-key-non-extractable', PAGE, ["generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])", "generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])"], PGT),
  m('page-rp-full-host', PAGE, ["        rp: { id: W.location.hostname, name: 'COS Control' },", "        rp: { id: W.location.hostname.split('.').slice(-2).join('.'), name: 'COS Control' },"], PGT),
  // ── The 3144 listener (lib/web-key-signer-app.ts) ──
  m('app-csp-frame-ancestors-none', SAPP, ['  "frame-ancestors \'none\'",', '  "frame-ancestors \'self\'",'], APT),
  m('app-csp-no-inline-style', SAPP, ['  "style-src \'self\'",', '  "style-src \'self\' \'unsafe-inline\'",'], APT),
  drop('app-x-frame-options', SAPP, "  'X-Frame-Options': 'DENY',\n", APT),
  m('app-origin-refused', SAPP, ['      if (origin !== undefined && origin !== expected) {', '      if (false) {'], APT),
  m('app-write-names-origin', SAPP, ["      if (method !== 'GET' && method !== 'HEAD' && (expected === null || origin !== expected)) {", '      if (false) {'], APT),
  m('app-api-allowlist', SAPP, ["      if (!signerApiAllowed(method === 'HEAD' ? 'GET' : method, pathname)) {", '      if (false) {'], APT),
  m('app-allowlist-anchored', SAPP, ["  { method: 'POST', path: /^\\/api\\/web-key\\/nonce$/ },", "  { method: 'POST', path: /^\\/api\\/web-key\\/nonce/ },"], APT),
  m('app-verified-bytes-only', SAPP, ['    const snapshot = deps.integrity ? deps.integrity.snapshot() : null', '    const snapshot = deps.integrity ? deps.integrity.snapshot() ?? new Map() : null'], APT),
  m('app-page-types-only', SAPP, ['    const body = TYPES[ext] ? snapshot.get(file) : undefined', '    const body = snapshot.get(file)'], APT),
  m('app-combined-needs-signer', SAPP, ['  const signerOk = signer !== null && signer.state.ok === true', '  const signerOk = signer === null || signer.state.ok === true'], APT),
  m('app-combined-needs-web-control', SAPP, ['lastCheckOk: webControl.state.ok === true && signerOk,', 'lastCheckOk: signerOk,'], APT),
  // ── The handoff (lib/web-key-handoff.ts, routes/web-key.ts) ──
  m('handoff-files-refused', HAND, ["  if (b.attachmentIds !== undefined && !(Array.isArray(b.attachmentIds) && b.attachmentIds.length === 0)) return { ok: false, reason: 'attachments_not_signable' }\n", ''], HOT),
  drop('handoff-words-too-long', HAND, "  if (b.prompt.length > WEB_KEY_HANDOFF_MAX_WORDS) return { ok: false, reason: 'words_too_long' }\n", HOT),
  drop('handoff-expiry', HAND, "    if (at > h.view.exp) return { ok: false, reason: 'handoff_expired' }\n", HOT),
  drop('handoff-single-claim', HAND, "    if (h.claimed) return { ok: false, reason: 'handoff_claimed' }\n", [...HOT, ...PGT]),
  m('handoff-cap', HAND, ['    if (live >= WEB_KEY_HANDOFF_MAX_OPEN)', '    if (false)'], HOT),
  m('handoff-scope-checked', HAND, ["    if (parseWebTurnScope(scope) === null) return { ok: false, reason: 'scope_not_allowed' }\n", ''], HOT),
  m('route-create-web-only', WKR, ["  router.post('/web-key/handoff', (req, res) => {\n    if (!web(req)) return refuse(res, 403, 'web_origin_required')\n", "  router.post('/web-key/handoff', (req, res) => {\n"], HOT),
  drop('route-create-needs-key', WKR, "    if (deps.authority.registry.activeCount(deps.selfDnsName()) < 1) return refuse(res, 409, 'no_phone_key')\n", HOT),
  drop('route-create-binding-unknown', WKR, "    if (!target) return refuse(res, 404, 'unknown_binding')\n", HOT),
  drop('route-create-binding-changed', WKR, "    if (target.epoch !== request.turn.epoch || target.targetKey !== request.turn.targetKey) return refuse(res, 409, 'binding_changed')\n", HOT),
  m('route-create-target-from-binding', WKR, ['deps.handoffs.create(request, { provider: target.provider, sessionId: target.sessionId }, scope, approvalPacket)', 'deps.handoffs.create(request, { provider: String(req.body.provider ?? target.provider), sessionId: String(req.body.sessionId ?? target.sessionId) }, scope, approvalPacket)'], HOT),
  drop('route-packet-unknown', WKR, "      if (!packet) return refuse(res, 404, 'packet_unknown')\n", HOT),
  drop('route-packet-session', WKR, "      if (packet.provider !== target.provider || packet.sessionId !== target.sessionId) return refuse(res, 409, 'packet_session_mismatch')\n", HOT),
  m('route-claim-needs-wiring', WKR, ['    if (!deps.isSignerRequest || !onSigner(req) || !signerOrigin', '    if (!onSigner(req) || !signerOrigin'], HOT),
  m('route-claim-on-signer', WKR, ['    if (!deps.isSignerRequest || !onSigner(req) || !signerOrigin', '    if (!deps.isSignerRequest || !signerOrigin'], HOT),
  m('route-claim-origin', WKR, [' || req.headers.origin !== signerOrigin) return refuse(res, 403, SIGNER_ORIGIN_REQUIRED)', ') return refuse(res, 403, SIGNER_ORIGIN_REQUIRED)'], HOT),
  m('route-claim-web-only', WKR, ["  router.post('/web-key/handoff/claim', (req, res) => {\n    if (!web(req)) return refuse(res, 403, 'web_origin_required')\n", "  router.post('/web-key/handoff/claim', (req, res) => {\n"], HOT),
  m('route-nonce-on-signer', WKR, ["  router.post('/web-key/nonce', (req, res) => {\n    if (!web(req)) return refuse(res, 403, 'web_origin_required')\n    if (!onSigner(req)) return refuse(res, 403, SIGNER_ORIGIN_REQUIRED)\n", "  router.post('/web-key/nonce', (req, res) => {\n    if (!web(req)) return refuse(res, 403, 'web_origin_required')\n"], HOT),
  m('route-enroll-start-on-signer', WKR, ["  router.post('/web-key/enroll/start', (req, res) => {\n    if (!web(req)) return refuse(res, 403, 'web_origin_required')\n    if (!onSigner(req)) return refuse(res, 403, SIGNER_ORIGIN_REQUIRED)\n", "  router.post('/web-key/enroll/start', (req, res) => {\n    if (!web(req)) return refuse(res, 403, 'web_origin_required')\n"], HOT),
  m('route-enroll-prove-on-signer', WKR, ["  router.post('/web-key/enroll/prove', (req, res) => {\n    if (!web(req)) return refuse(res, 403, 'web_origin_required')\n    if (!onSigner(req)) return refuse(res, 403, SIGNER_ORIGIN_REQUIRED)\n", "  router.post('/web-key/enroll/prove', (req, res) => {\n    if (!web(req)) return refuse(res, 403, 'web_origin_required')\n"], HOT),
  m('route-onsigner-absent-is-old-behaviour', WKR, ['    if (!deps.isSignerRequest) return true', '    if (!deps.isSignerRequest) return false'], HOT),
  // ── Health and the composer ──
  m('health-flag-gated', HEALTH, ['    ...(webKeyAuthorityEnabled() ? { webKeySigner: 1 } : {}),', '    ...({ webKeySigner: 1 }),'], HLT),
  m('composer-offer-gated', APP, ['  function paintWebKeyOffer(r, opts) {\n    if (!webKeyCapable()) return;\n', '  function paintWebKeyOffer(r, opts) {\n'], CMT),
  m('composer-needs-active-key', APP, ["      if (!st || st.activeKeys < 1 || !view.live() || !view.form || !view.send || view.form !== $(view.prefix + '-form')) return;", "      if (!st || !view.live() || !view.form || !view.send || view.form !== $(view.prefix + '-form')) return;"], CMT),
  m('composer-url-https', APP, ["      return x.protocol === 'https:' && x.hostname", '      return x.hostname'], CMT),
  m('composer-url-host', APP, ["x.hostname === location.hostname && x.port === '3144'", "x.port === '3144'"], CMT),
  m('composer-url-port', APP, ["x.port === '3144' && x.pathname === '/'", "x.pathname === '/'"], CMT),
  m('composer-url-path', APP, ["x.pathname === '/' && !x.search", '!x.search'], CMT),
  m('composer-url-no-query', APP, ["&& !x.search && /^#h=", '&& /^#h='], CMT),
  m('composer-url-fragment-id', APP, ["/^#h=[A-Za-z0-9_-]{16,64}$/.test(x.hash);", 'true;'], CMT),
  m('composer-files-refused', APP, ["    if (view.files() !== 'none') { say(WEB_KEY_COPY.attachments_not_signable, 'error'); return Promise.resolve('files'); }", "    if (false) { say(WEB_KEY_COPY.attachments_not_signable, 'error'); return Promise.resolve('files'); }"], CMT),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = args.length && !args.includes('--check') ? mutations.filter(({ name }) => args.includes(name)) : mutations
if (args.length && !args.includes('--check') && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')
if (args.includes('--check')) {
  let bad = 0
  for (const { name, file, edits } of mutations) {
    let text = readFileSync(join(root, file), 'utf8')
    const original = text
    for (const [find, replacement] of edits) {
      const n = text.split(find).length - 1
      if (n !== 1) { console.log(`${name}: matches ${n} times in ${file}: ${find.slice(0, 90)}`); bad++ }
      else text = text.replace(find, () => replacement)
    }
    if (text === original) { console.log(`${name}: no change`); bad++ }
  }
  console.log(`${mutations.length - bad} of ${mutations.length} targets match exactly once`)
  process.exit(bad ? 1 : 0)
}

const scratch = mkdtempSync(join(tmpdir(), 'web-key-signer-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  for (const dir of ['shared', 'work-task-runtime', 'bin', 'docs', 'test-support']) cpSync(join(root, dir), join(scratch, dir), { recursive: true })
  for (const file of ['vitest.config.ts', 'package.json', 'managed-runtime-contract.json', '.env.example']) cpSync(join(root, file), join(scratch, file))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = tests => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: process.env.TMPDIR, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json') },
    encoding: 'utf8', timeout: 300000,
  })
  const baseline = run(ALL)
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout.slice(-4000) + '\n' + baseline.stderr.slice(-4000))
  const totals = /Tests\s+(\d+) passed/.exec(baseline.stdout)
  console.log(`baseline PASS (${totals ? totals[1] : '?'} tests in ${ALL.length} files)`)
  let killed = 0
  for (const { name, file, edits, tests } of selected) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    let mutated = original
    for (const [find, replacement] of edits) {
      if (mutated.split(find).length !== 2) throw new Error(`Mutation ${name} does not match exactly once in ${file}: ${find.slice(0, 80)}`)
      mutated = mutated.replace(find, () => replacement)
    }
    if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
    writeFileSync(target, mutated)
    let result
    try { result = run(tests) } finally { writeFileSync(target, original) }
    if (readFileSync(target, 'utf8') !== original) throw new Error(`Restore failed for ${file} after ${name}`)
    const output = result.stdout + '\n' + result.stderr
    const killers = [...new Set([...output.matchAll(/FAIL\s+((?:server|shared)\/\S+\.test\.ts > [^\n]+)/g)].map(x => x[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) { console.log(`${name} SURVIVED or harness failed\n${output.slice(-1500)}`); process.exitCode = 1; continue }
    killed += 1
    console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
  }
  console.log(`${killed} of ${selected.length} web-key signer 6.99.31 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
