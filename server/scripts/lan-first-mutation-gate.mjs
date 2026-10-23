#!/usr/bin/env node
// 6.88.0 mutation gate: LAN first (docs/lan-first.md). The public pre-token route proof (its message, key, nonce rule,
// token-strength gate, rate limit and exact public door), the `routes` field on authenticated /api/models (interface
// filtering, cache, never-throw), and the capability flags on both surfaces. Mutations run only in a disposable copy of
// the checkout; the live checkout is never rewritten.
//
// What it proves, in order:
//   0. The target suites are GREEN unmutated. A gate over a red suite reads every mutant as killed and proves nothing.
//   1. Each target string appears EXACTLY ONCE in its file, so the mutation is unambiguous.
//   2. The mutated file differs from the original, so the edit landed.
//   3. A NAMED test fails ("FAIL  server/x.test.ts > name"); a build error or a harness failure is not a kill.
//   4. The file is restored byte for byte (compared) before the next mutant.
// Usage: node server/scripts/lan-first-mutation-gate.mjs [--list] [name…]
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const LIB_T = ['server/lib/lan-first.test.ts']
const ROUTE_T = ['server/routes/route-proof.test.ts']
const AUTH_T = ['server/lib/api-auth.test.ts', 'server/routes/route-proof.test.ts']
const HEALTH_T = ['server/routes/health-lan-first.test.ts']
const WIRING_T = ['server/lib/lan-first-wiring.test.ts']
const ALL = [...new Set([...LIB_T, ...ROUTE_T, ...AUTH_T, ...HEALTH_T, ...WIRING_T])]
const LIB = 'server/lib/lan-first.ts', ROUTE = 'server/routes/route-proof.ts', AUTH = 'server/lib/api-auth.ts'
const HEALTH = 'server/routes/health.ts', INDEX = 'server/index.ts'
const m = (name, file, edits, tests) => ({ name, file, edits: typeof edits[0] === 'string' ? [edits] : edits, tests })

const mutations = [
  // ── The proof: message, key, nonce rule, token strength ──
  m('proof-prefix', LIB, ["export const ROUTE_PROOF_PREFIX = 'cos-route-proof:v1:'", "export const ROUTE_PROOF_PREFIX = 'cos-route-proof:v2:'"], LIB_T),
  m('proof-binds-instance-id', LIB, ['return `${ROUTE_PROOF_PREFIX}${nonce}:${serverInstanceId}`', 'return `${ROUTE_PROOF_PREFIX}${nonce}`'], [...LIB_T, ...ROUTE_T]),
  m('proof-keyed-by-token', LIB, ["return createHmac('sha256', token)", "return createHmac('sha256', 'cos')"], [...LIB_T, ...ROUTE_T]),
  m('proof-hex', LIB, [".digest('hex')", ".digest('base64url')"], [...LIB_T, ...ROUTE_T]),
  m('nonce-min-length', LIB, ['/^[A-Za-z0-9_-]{22,64}$/', '/^[A-Za-z0-9_-]{1,64}$/'], [...LIB_T, ...ROUTE_T]),
  m('nonce-max-length', LIB, ['/^[A-Za-z0-9_-]{22,64}$/', '/^[A-Za-z0-9_-]{22,65}$/'], [...LIB_T, ...ROUTE_T]),
  m('nonce-charset', LIB, ['/^[A-Za-z0-9_-]{22,64}$/', '/^[A-Za-z0-9_:.%-]{22,64}$/'], [...LIB_T, ...ROUTE_T]),
  m('nonce-string-only', LIB, ["return typeof value === 'string' && ROUTE_PROOF_NONCE_PATTERN.test(value)", 'return ROUTE_PROOF_NONCE_PATTERN.test(String(value))'], LIB_T),
  m('token-min-length', LIB, ['export const ROUTE_PROOF_MIN_TOKEN_LENGTH = 32', 'export const ROUTE_PROOF_MIN_TOKEN_LENGTH = 16'], [...LIB_T, ...ROUTE_T]),
  m('token-strength-checked', LIB, ["return typeof token === 'string' && token.length >= ROUTE_PROOF_MIN_TOKEN_LENGTH", "return typeof token === 'string'"], [...LIB_T, ...ROUTE_T]),
  m('switch-honoured', LIB, ["return env.COS_LAN_FIRST !== '0'", 'return true'], [...LIB_T, ...ROUTE_T]),
  m('available-needs-instance-id', LIB, ['lanFirstEnabled(input.env) && !!input.serverInstanceId && routeProofTokenUsable', 'lanFirstEnabled(input.env) && routeProofTokenUsable'], LIB_T),
  m('capability-gated-on-availability', LIB, ['...(routeProofAvailable(input) ? { routeProof:', '...(true ? { routeProof:'], [...LIB_T, ...HEALTH_T]),
  m('port-falls-back', LIB, ['Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3141', 'port'], LIB_T),
  // ── The rate limit ──
  m('limit-per-ip', LIB, ['export const ROUTE_PROOF_IP_LIMIT = 20', 'export const ROUTE_PROOF_IP_LIMIT = 2000'], [...LIB_T, ...ROUTE_T]),
  m('limit-per-ip-inclusive', LIB, ['if (recent.length >= ROUTE_PROOF_IP_LIMIT) {', 'if (recent.length > ROUTE_PROOF_IP_LIMIT) {'], [...LIB_T, ...ROUTE_T]),
  m('limit-global', LIB, ['if (this.global.length >= ROUTE_PROOF_GLOBAL_LIMIT) {', 'if (false) {'], LIB_T),
  m('limit-window-expires', LIB, ['const live = (times: number[]) => times.filter(t => at - t < ROUTE_PROOF_WINDOW_MS)', 'const live = (times: number[]) => times'], LIB_T),
  m('limit-retry-after', LIB, ['Math.max(1, Math.ceil((ROUTE_PROOF_WINDOW_MS - (at - oldest)) / 1000))', '60'], LIB_T),
  m('limit-normalizes-ipv4-mapped', LIB, ["const ip = normalizeRemoteIp(remoteAddress ?? '') || 'unknown'", "const ip = (remoteAddress ?? '') || 'unknown'"], LIB_T),
  m('limit-refused-stores-nothing', LIB, ['      if (recent.length) this.perIp.set(ip, recent)\n', '      this.perIp.set(ip, recent)\n'], LIB_T),
  m('limit-sweeps-idle', LIB, ['      for (const [key, times] of this.perIp) if (live(times).length === 0) this.perIp.delete(key)\n', ''], LIB_T),
  // ── The route lists ──
  m('lists-ipv4-only', LIB, ["return family === 'IPv4' && !info.internal", 'return !info.internal'], LIB_T),
  m('lists-skip-internal', LIB, ["return family === 'IPv4' && !info.internal", "return family === 'IPv4'"], LIB_T),
  m('lists-rfc1918-only', LIB, ['if (isRfc1918Ipv4(ip) && !NOT_LAN_INTERFACE.test(name)', 'if (!NOT_LAN_INTERFACE.test(name)'], LIB_T),
  m('lists-skip-tunnels-bridges', LIB, ['if (isRfc1918Ipv4(ip) && !NOT_LAN_INTERFACE.test(name)', 'if (isRfc1918Ipv4(ip)'], LIB_T),
  m('lists-tailscale-interface', LIB, ['if (TAILSCALE_INTERFACE.test(name) && tailscale.length', 'if (tailscale.length'], LIB_T),
  m('lists-dedupe', LIB, ['      if (seen.has(ip)) continue\n', ''], LIB_T),
  m('lists-cap', LIB, ['&& lan.length < LAN_ROUTES_MAX_PER_KIND) {', ') {'], LIB_T),
  m('routes-need-instance-id', LIB, ['if (!lanFirstEnabled(input.env) || !input.serverInstanceId) return null', 'if (!lanFirstEnabled(input.env)) return null'], LIB_T),
  m('routes-switch-honoured', LIB, ['if (!lanFirstEnabled(input.env) || !input.serverInstanceId) return null', 'if (!input.serverInstanceId) return null'], LIB_T),
  m('routes-cache-expires', LIB, ['|| at - cache.at >= LAN_ROUTES_CACHE_MS ||', '|| false ||'], LIB_T),
  m('routes-cache-used', LIB, ['if (!cache || cache.port !== input.port ||', 'if (true ||'], LIB_T),
  m('routes-copies-out', LIB, ['lan: cache.lists.lan.map(r => ({ ...r })),', 'lan: cache.lists.lan,'], LIB_T),
  m('routes-never-throw', LIB, ['  } catch {\n    cache = null\n    return null\n  }', '  } catch (error) {\n    throw error\n  }'], [...LIB_T, ...HEALTH_T]),
  // ── The route ──
  m('route-get-only', ROUTE, ["    if (req.method !== 'GET') {", '    if (false) {'], ROUTE_T),
  m('route-disabled', ROUTE, ["    if (!lanFirstEnabled(env())) return send(res, 'disabled')\n", ''], ROUTE_T),
  m('route-rate-limited', ROUTE, ["    if (!admission.ok) return send(res, 'rate_limited', admission.retryAfterSeconds)\n", ''], ROUTE_T),
  m('route-limit-before-nonce', ROUTE, [
    ["    const admission = limiter.admit(req.socket?.remoteAddress)\n    if (!admission.ok) return send(res, 'rate_limited', admission.retryAfterSeconds)\n    const nonce = req.query.nonce\n    if (!isValidRouteProofNonce(nonce)) return send(res, 'bad_nonce')\n",
      "    const nonce = req.query.nonce\n    if (!isValidRouteProofNonce(nonce)) return send(res, 'bad_nonce')\n    const admission = limiter.admit(req.socket?.remoteAddress)\n    if (!admission.ok) return send(res, 'rate_limited', admission.retryAfterSeconds)\n"],
  ], ROUTE_T),
  m('route-validates-nonce', ROUTE, ["if (!isValidRouteProofNonce(nonce)) return send(res, 'bad_nonce')", "if (typeof nonce !== 'string') return send(res, 'bad_nonce')"], ROUTE_T),
  m('route-needs-instance-id', ROUTE, ['if (!serverInstanceId || !routeProofTokenUsable(token))', 'if (!routeProofTokenUsable(token))'], ROUTE_T),
  m('route-needs-strong-token', ROUTE, ['if (!serverInstanceId || !routeProofTokenUsable(token))', 'if (!serverInstanceId)'], ROUTE_T),
  m('route-no-store', ROUTE, ["    res.setHeader('Cache-Control', 'no-store')\n    res.json({", '    res.json({'], ROUTE_T),
  m('route-never-sends-token', ROUTE, ['      proof: computeRouteProof(token, nonce, serverInstanceId),\n', '      proof: computeRouteProof(token, nonce, serverInstanceId),\n      token,\n'], ROUTE_T),
  m('route-never-echoes-nonce', ROUTE, ['      proof: computeRouteProof(token, nonce, serverInstanceId),\n', '      proof: computeRouteProof(token, nonce, serverInstanceId),\n      nonce,\n'], ROUTE_T),
  // ── The public door ──
  m('door-exists', AUTH, ["  if (method === 'GET' && path === ROUTE_PROOF_PATH) return true\n", ''], AUTH_T),
  m('door-get-only', AUTH, ["if (method === 'GET' && path === ROUTE_PROOF_PATH) return true", 'if (path === ROUTE_PROOF_PATH) return true'], AUTH_T),
  m('door-exact-path', AUTH, ["if (method === 'GET' && path === ROUTE_PROOF_PATH) return true", "if (method === 'GET' && path.startsWith(ROUTE_PROOF_PATH)) return true"], AUTH_T),
  // ── The surfaces ──
  m('health-flags', HEALTH, ["      ...lanFirstCapabilities({ token: process.env.COS_API_TOKEN ?? '', serverInstanceId: getServerInstanceId() }),\n", ''], HEALTH_T),
  m('health-flags-real-token', HEALTH, ["lanFirstCapabilities({ token: process.env.COS_API_TOKEN ?? '', serverInstanceId", "lanFirstCapabilities({ token: 'x'.repeat(40), serverInstanceId"], HEALTH_T),
  m('health-never-carries-routes', HEALTH, ["      ...lanFirstCapabilities({ token: process.env.COS_API_TOKEN ?? '', serverInstanceId: getServerInstanceId() }),\n", "      ...lanFirstCapabilities({ token: process.env.COS_API_TOKEN ?? '', serverInstanceId: getServerInstanceId() }),\n      routes: lanRoutesModelsField().routes,\n"], HEALTH_T),
  m('models-flags', HEALTH, ['      ...lanFirstCapabilities({ token: apiToken, serverInstanceId: getServerInstanceId() }),\n', ''], HEALTH_T),
  m('models-routes', HEALTH, ['    ...lanRoutesModelsField(),\n', ''], HEALTH_T),
  m('models-routes-omitted-not-null', HEALTH, ['return routes ? { routes } : {}', 'return { routes } as never'], HEALTH_T),
  m('models-routes-port', HEALTH, ['lanRoutesField({ port: lanFirstHttpPort(),', 'lanRoutesField({ port: 3143,'], HEALTH_T),
  // ── The mount ──
  m('index-mounts-route', INDEX, ["app.use('/api', createRouteProofRouter({\n  token: () => API_TOKEN,\n", "app.use('/api', createRouteProofRouter({\n  token: () => '',\n"], WIRING_T),
]

const args = process.argv.slice(2)
if (args.includes('--list')) { for (const { name } of mutations) console.log(name); process.exit(0) }
const selected = args.length ? mutations.filter(({ name }) => args.includes(name)) : mutations
if (args.length && selected.length !== args.length) throw new Error('Unknown mutation name in: ' + args.join(' '))
if (new Set(mutations.map(x => x.name)).size !== mutations.length) throw new Error('Duplicate mutation name')

const scratch = mkdtempSync(join(tmpdir(), 'lan-first-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  for (const dir of ['shared', 'work-task-runtime', 'bin', 'docs', 'memory-runtime']) cpSync(join(root, dir), join(scratch, dir), { recursive: true })
  for (const file of ['vitest.config.ts', 'package.json', 'managed-runtime-contract.json']) cpSync(join(root, file), join(scratch, file))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = tests => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: process.env.TMPDIR, COS_DATA_DIR: join(scratch, 'data'), COS_PROFILE_PATH: join(scratch, 'data', 'profile.json') },
    encoding: 'utf8', timeout: 300000,
  })
  const baseline = run(ALL)
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout + '\n' + baseline.stderr)
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
    const killers = [...new Set([...output.matchAll(/FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/g)].map(x => x[1].trim()))]
    if (result.status === 0 || result.error || !killers.length) { console.log(`${name} SURVIVED or harness failed\n${output.slice(-3000)}`); process.exitCode = 1; continue }
    killed += 1
    console.log(`${name} KILLED by ${killers.slice(0, 2).join(' | ')}${killers.length > 2 ? ` (+${killers.length - 2} more)` : ''}`)
  }
  console.log(`${killed} of ${selected.length} LAN first 6.88.0 mutations killed`)
} finally { rmSync(scratch, { recursive: true, force: true }) }
