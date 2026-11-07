#!/usr/bin/env node
/**
 * Isolated Candidate Server for COS Control Web (`:3149`).
 *
 * Leaves the production LaunchAgent (`com.cos.glasses-server` on `:3141` / `:3143`)
 * completely untouched while serving `/control`, the Tailscale MagicDNS Origin gate,
 * the `cos_web_session` HttpOnly cookie, and the 3 new web bridges (`POST /api/web-bridge/memories`,
 * `GET /api/meetings/live-chunks`, `GET /api/usage/summary`, `GET /api/work-board/your-move`)
 * backed by live data from `127.0.0.1:3141`.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'

if (!process.env.COS_SCRIPTS_DIR) {
  const defaultScripts = path.join(homedir(), 'Documents', 'GitHub', 'Ukaoma Chief Of Staff', 'MU-Chief-Staff', 'operations', 'scripts')
  if (existsSync(defaultScripts)) process.env.COS_SCRIPTS_DIR = defaultScripts
}

import express from 'express'
import cors from 'cors'
import { isAllowedNetworkIp, isAllowedNetworkOrigin } from '../lib/network-policy.js'
import { requireApiToken } from '../lib/api-auth.js'
import { createWebControlRouter, webControlCsp } from '../routes/web-control.js'
import { createWebControlStatic } from '../lib/web-control-static.js'
import { Readable } from 'node:stream'
import { WebHandoffStore } from '../lib/web-session-auth.js'
import { execFileRunner, parseTailscaleStatus, resolveTailscaleBin, STATUS_ARGS } from '../lib/tailscale-nudge.js'

const CANDIDATE_PORT = parseInt(process.env.CANDIDATE_PORT ?? '3149', 10)
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT ?? '3141', 10)

function readStandingToken() {
  if (process.env.COS_API_TOKEN) return process.env.COS_API_TOKEN
  const envFile = path.join(homedir(), '.cos-glasses', '.env')
  if (existsSync(envFile)) {
    const lines = readFileSync(envFile, 'utf8').split('\n')
    for (const line of lines) {
      const m = /^COS_API_TOKEN=(.+)$/.exec(line.trim())
      if (m) return m[1].trim()
    }
  }
  throw new Error('Could not find COS_API_TOKEN in ~/.cos-glasses/.env')
}

const API_TOKEN = readStandingToken()
const handoffStore = new WebHandoffStore()
let cachedSelfDns = null
let cachedStatus = null

async function refreshTailscaleStatus() {
  const bin = resolveTailscaleBin()
  if (!bin) return null
  const res = await execFileRunner(bin, STATUS_ARGS, 5000)
  const parsed = res.spawnError ? null : parseTailscaleStatus(res.stdout, Date.now())
  if (parsed) {
    cachedStatus = parsed
    if (parsed.selfDnsName) cachedSelfDns = parsed.selfDnsName
  }
  return cachedStatus
}

await refreshTailscaleStatus()

const app = express()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webControlDir = path.resolve(__dirname, '..', 'web-control')

app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || ''
  if (!isAllowedNetworkIp(ip)) {
    return res.status(403).json({ error: 'forbidden — not on allowed network' })
  }
  next()
})

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin === 'null') return cb(null, true)
    if (isAllowedNetworkOrigin(origin, { selfDnsName: cachedSelfDns, allowedPorts: [CANDIDATE_PORT, UPSTREAM_PORT] })) {
      return cb(null, true)
    }
    cb(new Error('CORS blocked'))
  },
  exposedHeaders: ['Content-Range', 'Accept-Ranges'],
}))

app.use('/control', (req, res, next) => {
  res.setHeader('Content-Security-Policy', webControlCsp(req.path))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  // Candidate only: always serve the files on disk so a reload shows the latest edit.
  res.setHeader('Cache-Control', 'no-store')
  next()
}, createWebControlStatic(webControlDir), express.static(webControlDir, { etag: false, lastModified: false }))

app.get('/', (_req, res) => res.redirect('/control'))

app.use('/api', requireApiToken(API_TOKEN, {
  selfDnsName: () => cachedSelfDns,
  allowedPorts: () => [CANDIDATE_PORT, UPSTREAM_PORT],
}))

app.use('/api', express.json({ limit: '10mb' }))

app.use('/api', createWebControlRouter({
  apiToken: () => API_TOKEN,
  port: () => UPSTREAM_PORT,
  publicPort: () => CANDIDATE_PORT,
  handoffStore,
  selfDnsName: () => cachedSelfDns,
  queryTailscaleStatus: refreshTailscaleStatus,
}))

// Proxy all other authenticated /api/* requests to the production server on 127.0.0.1:3141
app.use('/api', async (req, res) => {
  const targetUrl = `http://127.0.0.1:${UPSTREAM_PORT}/api${req.url}`
  try {
    const isBodyMethod = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    const upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'X-COS-Token': API_TOKEN,
        ...(req.headers['content-type'] ? { 'Content-Type': String(req.headers['content-type']) } : {}),
        ...(req.headers.range ? { Range: String(req.headers.range) } : {}),
      },
      ...(isBodyMethod && req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
    })
    res.status(upstreamRes.status)
    for (const [k, v] of upstreamRes.headers.entries()) {
      if (['content-encoding', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) continue
      res.setHeader(k, v)
    }
    // Stream, never buffer: SSE routes (session streams, display stream) never end, and a
    // buffered proxy would hold each one open forever and exhaust the browser's six
    // per-host connections.
    if (!upstreamRes.body) return res.end()
    const body = Readable.fromWeb(upstreamRes.body)
    req.on('close', () => body.destroy())
    body.on('error', () => { if (!res.writableEnded) res.end() })
    body.pipe(res)
  } catch (err) {
    res.status(502).json({ error: 'upstream_unavailable', message: err instanceof Error ? err.message : 'Upstream error' })
  }
})

app.listen(CANDIDATE_PORT, '0.0.0.0', () => {
  const { ticket: tailscaleTicket } = handoffStore.mint(24 * 60 * 60_000)
  const { ticket: localTicket } = handoffStore.mint(24 * 60 * 60_000)
  console.log(`[COS Control Web Candidate] Listening on http://0.0.0.0:${CANDIDATE_PORT}/control`)
  if (cachedSelfDns) {
    console.log(`[COS Control Web Candidate] Tailscale URL:   http://${cachedSelfDns}:${CANDIDATE_PORT}/control`)
    console.log(`[COS Control Web Candidate] Tailscale Login: http://${cachedSelfDns}:${CANDIDATE_PORT}/control?handoff=${tailscaleTicket}`)
  }
  console.log(`[COS Control Web Candidate] Local Login:     http://127.0.0.1:${CANDIDATE_PORT}/control?handoff=${localTicket}`)
})
