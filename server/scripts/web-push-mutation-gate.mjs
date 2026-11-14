#!/usr/bin/env node
// X1 (iPhone pings, one-ping proof): RFC 8291 encryption, VAPID, the device store, the sender and the routes behind
// COS_WEB_PUSH. Same harness as control-tsnet-https-mutation-gate.mjs: disposable copy, green baseline, each target
// matched exactly once, each mutant killed by the test named for it (WRONG KILLER fails), byte-for-byte restoration. Left out as EQUIVALENT (not a gap): dropping validPushKeys' 0x04 prefix check, because
// the curve check after it rejects a compressed point anyway.
import { mkdtempSync, cpSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// [name, file, exact target, replacement, a substring of the test that must fail, tests]
const mutations = [
  ["info-label", "server/lib/web-push-crypto.ts", "Buffer.from('WebPush: info\\0', 'latin1')", "Buffer.from('WebPush: info', 'latin1')", "reproduces RFC 8291 Appendix A exactly", ["server/lib/web-push-crypto.test.ts"]],
  ["record-delimiter", "server/lib/web-push-crypto.ts", "Buffer.from([0x02])", "Buffer.from([0x01])", "reproduces RFC 8291 Appendix A exactly", ["server/lib/web-push-crypto.test.ts"]],
  ["record-size", "server/lib/web-push-crypto.ts", "header.writeUInt32BE(RECORD_SIZE, 16)", "header.writeUInt32BE(RECORD_SIZE * 2, 16)", "reproduces RFC 8291 Appendix A exactly", ["server/lib/web-push-crypto.test.ts"]],
  ["salt-fixed", "server/lib/web-push-crypto.ts", "const salt = opts.salt ?? randomBytes(16)", "const salt = opts.salt ?? Buffer.alloc(16)", "the phone decrypts what we send, with a fresh key and salt each time", ["server/lib/web-push-crypto.test.ts"]],
  ["payload-unlimited", "server/lib/web-push-crypto.ts", "if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error('payload too large')", "void MAX_PLAINTEXT_BYTES", "refuses a payload over the limit", ["server/lib/web-push-crypto.test.ts"]],
  ["keys-curve-unchecked", "server/lib/web-push-crypto.ts", "    probe.computeSecret(pub) // throws on a point not on the curve\n", "", "validPushKeys: a real P-256 point", ["server/lib/web-push-crypto.test.ts"]],
  ["vapid-two-days", "server/lib/web-push-crypto.ts", "export const VAPID_TTL_SECONDS = 12 * 60 * 60", "export const VAPID_TTL_SECONDS = 48 * 60 * 60", "an ES256 JWT for the push service origin", ["server/lib/web-push-crypto.test.ts"]],
  ["vapid-aud-whole-url", "server/lib/web-push-crypto.ts", "  return `${u.protocol}//${u.host}`", "  return endpoint", "pushServiceOrigin drops the path and query", ["server/lib/web-push-crypto.test.ts"]],
  ["vapid-der-signature", "server/lib/web-push-crypto.ts", "{ key: createPrivateKey(keys.privatePem), dsaEncoding: 'ieee-p1363' }", "{ key: createPrivateKey(keys.privatePem), dsaEncoding: 'der' }", "an ES256 JWT for the push service origin", ["server/lib/web-push-crypto.test.ts"]],
  ["endpoint-suffix-loose", "server/lib/web-push-store.ts", "host.endsWith('.push.apple.com')", "host.endsWith('push.apple.com')", "endpoints only on Apple's push service", ["server/routes/web-push.test.ts"]],
  ["endpoint-http-ok", "server/lib/web-push-store.ts", "if (u.protocol !== 'https:' || u.username || u.password || u.port) return false", "if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.port) return false", "endpoints only on Apple's push service", ["server/routes/web-push.test.ts"]],
  ["key-made-on-read", "server/lib/web-push-store.ts", "  devices(): PushDevice[] {\n", "  devices(): PushDevice[] {\n    this.vapidKeys()\n", "makes nothing until asked", ["server/routes/web-push.test.ts"]],
  ["file-mode-open", "server/lib/web-push-store.ts", "export const PUSH_FILE_MODE = 0o600", "export const PUSH_FILE_MODE = 0o644", "makes nothing until asked", ["server/routes/web-push.test.ts"]],
  ["dir-mode-open", "server/lib/web-push-store.ts", "export const PUSH_DIR_MODE = 0o700", "export const PUSH_DIR_MODE = 0o755", "makes nothing until asked", ["server/routes/web-push.test.ts"]],
  ["dedupe-lost", "server/lib/web-push-store.ts", "const existing = devices.find(d => d.endpoint === input.endpoint)", "const existing = undefined as PushDevice | undefined", "adds a phone (0600), refreshes the same endpoint in place", ["server/routes/web-push.test.ts"]],
  ["cap-off", "server/lib/web-push-store.ts", "if (devices.length >= MAX_PUSH_DEVICES) return { ok: false, reason: 'too_many_devices' }", "void MAX_PUSH_DEVICES", "adds a phone (0600), refreshes the same endpoint in place", ["server/routes/web-push.test.ts"]],
  ["view-leaks-endpoint", "server/lib/web-push-store.ts", "service: new URL(d.endpoint).hostname }))", "service: d.endpoint }))", "adds a phone (0600), refreshes the same endpoint in place", ["server/routes/web-push.test.ts"]],
  ["remove-ignored", "server/lib/web-push-store.ts", "if (kept.length === devices.length) return false", "return true", "adds a phone (0600), refreshes the same endpoint in place", ["server/routes/web-push.test.ts"]],
  ["navigate-relative", "server/lib/web-push-sender.ts", "navigate: `${origin}/control`", "navigate: '/control'", "sends exactly one POST to the device endpoint", ["server/routes/web-push.test.ts"]],
  ["ttl-a-day", "server/lib/web-push-sender.ts", "export const PING_TTL_SECONDS = 300", "export const PING_TTL_SECONDS = 86_400", "sends exactly one POST to the device endpoint", ["server/routes/web-push.test.ts"]],
  ["topic-says-kind", "server/lib/web-push-sender.ts", "return b64u(createHash('sha256').update(`cos-ping:${vapidPublicKey}:${kind}`).digest()).slice(0, 22)", "return `cos-${kind}`", "sends exactly one POST to the device endpoint", ["server/routes/web-push.test.ts"]],
  ["subject-changed", "server/lib/web-push-sender.ts", "export const VAPID_SUBJECT = 'https://gotcos.com'", "export const VAPID_SUBJECT = 'mailto:owner@example.com'", "sends exactly one POST to the device endpoint", ["server/routes/web-push.test.ts"]],
  ["gone-kept", "server/lib/web-push-sender.ts", "    if (gone) store.remove(id)\n", "", "410 or 404 (the subscription is gone) removes the device", ["server/routes/web-push.test.ts"]],
  ["only-410-gone", "server/lib/web-push-sender.ts", "const gone = res.status === 404 || res.status === 410", "const gone = res.status === 410", "410 or 404 (the subscription is gone) removes the device", ["server/routes/web-push.test.ts"]],
  ["origin-http-ok", "server/routes/web-push.ts", "if (!origin.startsWith('https://') || !deps.originAllowed(origin))", "if (!deps.originAllowed(origin))", "subscribe from his https origin", ["server/routes/web-push.test.ts"]],
  ["origin-unchecked", "server/routes/web-push.ts", "if (!origin.startsWith('https://') || !deps.originAllowed(origin))", "if (!origin.startsWith('https://'))", "subscribe from his https origin", ["server/routes/web-push.test.ts"]],
  ["test-id-unchecked", "server/routes/web-push.ts", "    const id = typeof req.body?.deviceId === 'string' ? req.body.deviceId : ''\n    if (!DEVICE_ID_RE.test(id)) return res.status(400).json({ error: 'bad_id' })\n", "    const id = typeof req.body?.deviceId === 'string' ? req.body.deviceId : ''\n", "subscribe from his https origin", ["server/routes/web-push.test.ts"]],
  ["switch-default-on", "server/routes/web-push.ts", "return readSwitch(env.COS_WEB_PUSH, false)", "return readSwitch(env.COS_WEB_PUSH, true)", "is off by default and on only for 1, true or on", ["server/routes/web-push.test.ts"]],
  ["index-mount-always", "server/index.ts", "if (webPushEnabled()) {\n  app.use('/api', createWebPushRouter({", "if (true) {\n  app.use('/api', createWebPushRouter({", "off: index.ts mounts no route and builds no store", ["server/routes/web-push.test.ts"]],
  ["route-kind-from-body", "server/routes/web-push.ts", "sendOnePing(deps.store, id, 'test', {", "sendOnePing(deps.store, id, (req.body?.kind ?? 'test') as never, {", "subscribe from his https origin", ["server/routes/web-push.test.ts"]],
  ["3xx-treated-gone", "server/lib/web-push-sender.ts", "const gone = res.status === 404 || res.status === 410", "const gone = res.status >= 300", "a redirect is never followed", ["server/routes/web-push.test.ts"]]
]
const args = process.argv.slice(2)
if (args.includes('--list')) { for (const [name] of mutations) console.log(name); process.exit(0) }
const names = args.filter(a => !a.startsWith('--'))
const chosen = names.length ? mutations.filter(([name]) => names.includes(name)) : mutations
if (names.length && chosen.length !== names.length) throw new Error(`Unknown mutation name in: ${args.join(' ')}`)

const scratch = mkdtempSync(join(tmpdir(), 'web-push-mutations-'))
try {
  const skip = new Set(['data', 'models', 'certs', 'node_modules'])
  cpSync(join(root, 'server'), join(scratch, 'server'), { recursive: true, filter: src => !(skip.has(basename(src)) && dirname(src) === join(root, 'server')) })
  cpSync(join(root, 'shared'), join(scratch, 'shared'), { recursive: true })
  cpSync(join(root, 'bin'), join(scratch, 'bin'), { recursive: true })
  // vitest.config.ts names setup files here (the 6.71.7 gate predates them).
  if (existsSync(join(root, 'test-support'))) cpSync(join(root, 'test-support'), join(scratch, 'test-support'), { recursive: true })
  cpSync(join(root, 'vitest.config.ts'), join(scratch, 'vitest.config.ts'))
  cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
  cpSync(join(root, 'managed-runtime-contract.json'), join(scratch, 'managed-runtime-contract.json'))
  // The listing test reads .env.example (the S6 lesson).
  cpSync(join(root, '.env.example'), join(scratch, '.env.example'))
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  const run = tests => spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...tests], {
    cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, COS_DATA_DIR: join(scratch, 'data') }, encoding: 'utf8', timeout: 300_000,
  })
  if (args.includes('--check')) {
    for (const [name, file, find] of chosen) {
      const n = readFileSync(join(scratch, file), 'utf8').split(find).length - 1
      console.log(`${n === 1 ? 'ok  ' : 'BAD '} ${name} (${n})`)
    }
    process.exit(0)
  }
  // Green baseline first, over every suite any mutant names.
  const all = [...new Set(chosen.flatMap(m => m[5]))]
  const baseline = run(all)
  if (baseline.status !== 0) throw new Error('Baseline failed; a gate over a red suite proves nothing:\n' + baseline.stdout + '\n' + baseline.stderr)
  const summary = /Tests\s+(\d+) passed \((\d+)\)/.exec(baseline.stdout)
  if (!summary || summary[1] !== summary[2]) throw new Error('Baseline did not report every test passing:\n' + baseline.stdout)
  console.log(`baseline PASS (${summary[1]} tests in ${all.length} files)`)
  // Every target exactly once, before any mutant runs.
  for (const [name, file, find] of chosen) {
    const n = readFileSync(join(scratch, file), 'utf8').split(find).length - 1
    if (n !== 1) throw new Error(`Mutation ${name} matches ${n} times in ${file}; it must match exactly once`)
  }
  let killed = 0
  // Every mutant runs; survivors are collected and reported together (Q1: stopping at the first hid the rest).
  const survivors = []
  for (const [name, file, find, replacement, killerName, tests] of chosen) {
    const target = join(scratch, file), original = readFileSync(target, 'utf8')
    const mutated = original.replace(find, () => replacement)
    if (mutated === original) throw new Error(`Mutation ${name} did not change ${file}`)
    writeFileSync(target, mutated)
    let result
    try { result = run(tests) } finally { writeFileSync(target, original) }
    if (readFileSync(target, 'utf8') !== original) throw new Error(`${file} was not restored after ${name}`)
    const output = result.stdout + '\n' + result.stderr
    // The intended test must be among the named failures: a kill by some unrelated test proves nothing about the rule.
    const killers = [...output.matchAll(/FAIL\s+(server\/\S+\.test\.ts > [^\n]+)/g)].map(match => match[1].trim())
    if (result.status === 0 || result.error || !killers.length) { survivors.push(`${name}: SURVIVED or harness failed`); console.log(`${name} SURVIVED\n${output.slice(-1500)}`); continue }
    const killer = killers.find(line => line.includes(killerName))
    if (!killer) { survivors.push(`${name}: WRONG KILLER, expected "${killerName}", killed by: ${killers.join(' | ')}`); console.log(`${name} KILLED BY THE WRONG TEST: ${killers.join(' | ')}`); continue }
    killed++
    console.log(`${name} KILLED by ${killer}`)
  }
  console.log(`${killed} of ${chosen.length} web-push mutations killed`)
  if (survivors.length) { console.log('NOT KILLED:\n  ' + survivors.join('\n  ')); process.exitCode = 1 }
} finally { rmSync(scratch, { recursive: true, force: true }) }
