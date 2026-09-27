/** Standalone opt-in lab: does not import production server, jobs, profile or providers. */
import express from 'express'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createFoundationRouter } from '../routes/control2-foundation.js'

const root = process.env.COS_CONTROL_TEST_HOME
const port = Number(process.env.COS_CONTROL_TEST_API_PORT ?? '3147')
if (process.env.COS_CONTROL2_FOUNDATION !== '1' || !root || !isAbsolute(root) || !Number.isInteger(port) || port < 1024 || port > 65535 || [3141, 3143].includes(port)) throw new Error('An explicit temporary test home, opt-in and nonproduction port are required')
const requested = resolve(root)
if (![resolve(tmpdir()), '/tmp', '/private/tmp'].some(parent => requested.startsWith(parent + '/'))) throw new Error('Test home must be beneath the system temporary directory')
// Validate an EXISTING mktemp directory before any filesystem mutation. Recursive
// mkdir here can traverse an attacker-controlled ancestor symlink before we reject it.
const rootStat = lstatSync(requested)
if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o777) !== 0o700) throw new Error('Test home must be an existing owned private directory (0700); create it with mktemp -d')
const canonical = realpathSync(requested)
const temp = realpathSync(tmpdir())
if (!(canonical.startsWith(temp + '/') || canonical.startsWith('/private/tmp/')) || canonical === '/private/tmp' || lstatSync(root).isSymbolicLink()) throw new Error('Test home must be beneath the system temporary directory')
const tokenDir = join(canonical, '.cos-glasses')
if (!existsSync(tokenDir)) mkdirSync(tokenDir, { mode: 0o700 })
const tokenDirStat = lstatSync(tokenDir)
if (!tokenDirStat.isDirectory() || tokenDirStat.isSymbolicLink() || tokenDirStat.uid !== process.getuid?.() || (tokenDirStat.mode & 0o777) !== 0o700) throw new Error('Unsafe token directory')
const tokenPath = join(tokenDir, '.env')
if (existsSync(tokenPath)) {
  const tokenStat = lstatSync(tokenPath)
  if (!tokenStat.isFile() || tokenStat.isSymbolicLink() || tokenStat.nlink !== 1 || tokenStat.uid !== process.getuid?.() || (tokenStat.mode & 0o777) !== 0o600) throw new Error('Unsafe token file')
}
if (!existsSync(tokenPath)) writeFileSync(tokenPath, `COS_API_TOKEN=${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' })
const token = /^COS_API_TOKEN=([a-zA-Z0-9_-]{16,})$/m.exec(readFileSync(tokenPath, 'utf8'))?.[1]
if (!token) throw new Error('Invalid lab token')
const app = express()
app.use((req, res, next) => {
  const got = Buffer.from(req.header('X-COS-Token') ?? '')
  const expected = Buffer.from(token)
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return res.status(401).json({ error: 'unauthorized' })
  if (req.header('origin')) return res.status(403).json({ error: 'native_lab_only' })
  next()
})
app.use(express.json({ limit: '40kb' }))
app.use('/api', createFoundationRouter({ enabled: true, root: join(canonical, 'foundation'), draftEnabled: process.env.COS_CONTROL2_DRAFT_ENABLED === '1' }))
const server = app.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, port, testHome: canonical, mode: 'foundation', publication: false })))
server.on('error', error => { console.error(error.message); process.exitCode = 1 })
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close(() => process.exit(0)))
