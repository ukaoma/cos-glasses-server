// Live events canary: a SCRATCH server that mounts the real routes behind the real /api gate, with a temp data home.
//
// Usage: node --import tsx/esm canaries/live-events/scratch-server.mts <abs scratch dir> <port>
//
// Why not boot server/index.ts: it starts whisper (8178), TTS, the Tailscale nudger and other sidecars that collide
// with the live server on 3141/3143. This composes only what the canary needs, from the same modules index.ts uses:
// requireApiToken (token header + web cookie), the hook spool ingester and signal store, the per-session stream, the
// session list, the permission broker list, and GET /api/events.
//
// Isolation: COS_DATA_DIR is <scratch>/data, so the hook spool, the hook runtime files (hook-port, hook-token), the
// ledger and the queue all live under <scratch>. The token is random and written to <scratch>/token (0600), never
// printed. The Claude registry (~/.claude/sessions) is READ, never written. Listens on 127.0.0.1 only.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const scratch = process.argv[2]
const port = Number(process.argv[3])
if (!scratch || !path.isAbsolute(scratch) || !Number.isInteger(port) || port === 3141 || port === 3143) {
  throw new Error('usage: scratch-server.mts <abs scratch dir> <port other than 3141/3143>')
}
fs.mkdirSync(path.join(scratch, 'data'), { recursive: true, mode: 0o700 })
process.env.COS_DATA_DIR = path.join(scratch, 'data')
process.env.COS_GLASSES_HOME = scratch
process.env.COS_PROFILE_PATH = path.join(scratch, 'profile.json')
process.env.COS_SESSION_HOOKS = '1'
process.env.COS_CLAUDE_SESSIONS_ENABLED = '1'
const token = `_${randomBytes(24).toString('base64url')}`
process.env.COS_API_TOKEN = token
fs.writeFileSync(path.join(scratch, 'token'), token, { mode: 0o600 })

const express = (await import('express')).default
const { requireApiToken } = await import('../../server/lib/api-auth.ts')
const { startSessionHooksRuntime, sessionSignalStore } = await import('../../server/lib/session-hooks-runtime.ts')
const { agentSessionStreamRouter } = await import('../../server/routes/agent-session-stream.ts')
const { createLiveEventsRouter, realLiveSources, liveEventsEnabled } = await import('../../server/routes/live-events.ts')
const { LiveEventsHub } = await import('../../server/lib/live-events.ts')

// The Control Web cookie path: a cookie minted by the same signer the login route uses, for the same token.
const { mintWebSessionCookieValue, WEB_SESSION_COOKIE_NAME } = await import('../../server/lib/web-session-auth.ts')
const minted = mintWebSessionCookieValue(token)
fs.writeFileSync(path.join(scratch, 'cookie'), `${WEB_SESSION_COOKIE_NAME}=${minted.value}`, { mode: 0o600 })
const app = express()
app.use('/api', requireApiToken(token, { allowedPorts: () => [port, Number(process.env.CANARY_HTTPS_PORT || 0)].filter(Boolean) }))
const hooks = startSessionHooksRuntime({ port })
// Canary 1 instrument: when each hook envelope was applied, against the envelope's own timestamp.
const applied = fs.createWriteStream(path.join(scratch, 'applied.jsonl'), { flags: 'a' })
sessionSignalStore.subscribe((signal, env, child) => {
  applied.write(JSON.stringify({ event: env.event, session: signal.sessionId.slice(0, 8), envTs: env.ts, appliedAt: Date.now(), child }) + '\n')
})
const hub = new LiveEventsHub({ sources: realLiveSources({ broker: () => null }) })
app.use('/api', createLiveEventsRouter({ hub, enabled: liveEventsEnabled() }))
app.use('/api', agentSessionStreamRouter)
// index.ts gives both listeners requestTimeout 900 s; CANARY_REQUEST_TIMEOUT_MS sets a short one to prove a stream
// outlives it (requestTimeout bounds receiving the REQUEST, and a GET's request is complete at once).
const requestTimeout = Number(process.env.CANARY_REQUEST_TIMEOUT_MS || 900_000)
const { createServer: createHttpServer } = await import('node:http')
const server = createHttpServer(app)
server.requestTimeout = requestTimeout
server.listen(port, '127.0.0.1', () => { console.log(`[scratch] listening 127.0.0.1:${port} requestTimeout=${requestTimeout} data=${process.env.COS_DATA_DIR}`) })
// The https listener path (index.ts: createHttpsServer(..., app)), on a scratch self-signed cert, when asked.
let tls: { close(): void } | null = null
const httpsPort = Number(process.env.CANARY_HTTPS_PORT || 0)
if (httpsPort && httpsPort !== 3143) {
  const { createServer: createHttpsServer } = await import('node:https')
  const s = createHttpsServer({ cert: fs.readFileSync(path.join(scratch, 'cert.pem')), key: fs.readFileSync(path.join(scratch, 'key.pem')) }, app)
  s.requestTimeout = requestTimeout
  s.listen(httpsPort, '127.0.0.1', () => { console.log(`[scratch] https 127.0.0.1:${httpsPort}`) })
  tls = s
}
const stop = () => { hooks.stop(); hub.dispose(); server.close(); tls?.close(); process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
