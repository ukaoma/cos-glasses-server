// X1 (iPhone pings, one-ping proof): the routes a phone uses to subscribe, and the one explicit test ping.
// Mounted by index.ts ONLY with COS_WEB_PUSH on (lib/web-push-switch... webPushEnabled), behind the same API auth as
// every /api route. Off: none of these paths exists, no key is made, nothing is sent (pinned in web-push.test.ts).
//
//   GET    /web-push/key           { publicKey }                    the VAPID public key (made on the first read)
//   GET    /web-push/devices       { devices: [{ id, label, addedAt, service }] }   never an endpoint or keys
//   POST   /web-push/devices       { subscription: { endpoint, keys: { p256dh, auth } }, label? } -> { id }
//                                  The Origin header must be an https Control Web origin this server serves; a tap on
//                                  the notification opens <origin>/control.
//   DELETE /web-push/devices/:id   { removed }
//   POST   /web-push/test          { deviceId } -> { ok, status, reason, removed }   ONE ping, "COS: Test ping". At most one
//                                  per 10 s and 20 a day per Mac (429 with reasonCopy), counted before the send.
//   GET    /web-push/status        boot-time test and production gates
//   POST   /web-push/subscription/status { endpoint } -> safe device view or null, same https origin only
//   PATCH  /web-push/devices/:id   { showWords: boolean } explicit device privacy choice
// Production subscription requires production:true and the separate production gate. Proof subscriptions never
// opt into production. /test may request delaySeconds:15: it claims the same cap and responds 202 scheduled:true;
// an in-memory server timer sends later, re-reading the device so removal cancels it. A restart cancels the timer.

import { Router, type Request, type Response } from 'express'
import { readSwitch } from '../lib/env-switch.js'
import { WebPushStore } from '../lib/web-push-store.js'
import { sendOnePing, type PushPost } from '../lib/web-push-sender.js'

/** `COS_WEB_PUSH`: default OFF, read once at boot. On sends data to Apple's push service: Miles's typed go. */
export function webPushEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readSwitch(env.COS_WEB_PUSH, false)
}

/** Independent activation: test delivery alone never connects the production ping engine. */
export function webPushProductionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return webPushEnabled(env) && readSwitch(env.COS_WEB_PUSH_PRODUCTION, false)
}

export interface WebPushRouterDeps {
  store: WebPushStore
  productionEnabled?: boolean
  /** True for an https Control Web origin this server serves (index.ts: isAllowedNetworkOrigin on 3143). */
  originAllowed: (origin: string) => boolean
  post?: PushPost
  nowSeconds?: () => number
  /** Fixture injection; production permits exactly a 15-second lock-phone delay. */
  scheduleForPhoneLock?: (send: () => Promise<void>) => void
}

const DEVICE_ID_RE = /^[0-9a-f]{16}$/
/** What a refused test ping says (lead 10:3x). */
export const TEST_PING_REFUSED_COPY = {
  too_soon: 'Not sent. A test ping was just sent.',
  daily_cap: "Not sent. Today's test pings are used up.",
} as const

export function createWebPushRouter(deps: WebPushRouterDeps): Router {
  const router = Router()
  const noStore = (res: Response) => res.set('Cache-Control', 'private, no-store')

  router.get('/web-push/status', (_req: Request, res: Response) => {
    noStore(res)
    res.json({ enabled: true, productionEnabled: deps.productionEnabled === true })
  })

  router.get('/web-push/key', (_req: Request, res: Response) => {
    noStore(res)
    try { res.json({ publicKey: deps.store.vapidKeys().publicKey }) } catch { res.status(503).json({ error: 'key_unavailable' }) }
  })

  router.get('/web-push/devices', (_req: Request, res: Response) => {
    noStore(res)
    res.json({ devices: deps.store.view() })
  })

  router.post('/web-push/devices', (req: Request, res: Response) => {
    noStore(res)
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
    if (!origin.startsWith('https://') || !deps.originAllowed(origin)) return res.status(400).json({ error: 'bad_origin' })
    const body = (req.body ?? {}) as { subscription?: { endpoint?: unknown; keys?: unknown }; label?: unknown; production?: unknown; showWords?: unknown }
    if (body.production === true && deps.productionEnabled !== true) return res.status(409).json({ error: 'production_off' })
    const added = deps.store.add({ endpoint: body.subscription?.endpoint, keys: body.subscription?.keys, origin, label: body.label, ...(typeof body.production === 'boolean' ? { production: body.production } : {}), ...(typeof body.showWords === 'boolean' ? { showWords: body.showWords } : {}) })
    if (!added.ok) return res.status(added.reason === 'too_many_devices' ? 409 : 400).json({ error: added.reason })
    return res.status(201).json({ id: added.id })
  })

  // Reconcile a browser's subscription without exposing its capability URL in any response.
  router.post('/web-push/subscription/status', (req: Request, res: Response) => {
    noStore(res)
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
    const trustedOrigin = origin.startsWith('https://') && deps.originAllowed(origin)
    if (!trustedOrigin) return res.status(400).json({ error: 'bad_origin' })
    const device = deps.store.devices().find(d => d.endpoint === req.body?.endpoint && d.origin === origin)
    return res.json({ device: device ? deps.store.view().find(d => d.id === device.id) : null })
  })

  router.patch('/web-push/devices/:id', (req: Request, res: Response) => {
    noStore(res)
    const id = String(req.params.id ?? '')
    if (!DEVICE_ID_RE.test(id)) return res.status(400).json({ error: 'bad_id' })
    if (typeof req.body?.showWords !== 'boolean') return res.status(400).json({ error: 'bad_preferences' })
    if (!deps.store.preferences(id, req.body.showWords)) return res.status(404).json({ error: 'unknown_device' })
    return res.json({ ok: true })
  })

  router.delete('/web-push/devices/:id', (req: Request, res: Response) => {
    noStore(res)
    const id = String(req.params.id ?? '')
    if (!DEVICE_ID_RE.test(id)) return res.status(400).json({ error: 'bad_id' })
    return res.json({ removed: deps.store.remove(id) })
  })

  router.post('/web-push/test', async (req: Request, res: Response) => {
    noStore(res)
    const id = typeof req.body?.deviceId === 'string' ? req.body.deviceId : ''
    if (!DEVICE_ID_RE.test(id)) return res.status(400).json({ error: 'bad_id' })
    if (!deps.store.get(id)) return res.status(404).json({ ok: false, status: 0, reason: 'unknown_device', removed: false })
    // Lead 10:3x: one test ping per 10 s and 20 a day, counted BEFORE the send; a refused call reaches no network.
    let claim: ReturnType<WebPushStore['claimTestPing']>
    try { claim = deps.store.claimTestPing() } catch { return res.status(503).json({ ok: false, status: 0, reason: 'cap_unavailable', removed: false }) }
    if (!claim.ok) return res.status(429).json({ ok: false, status: 0, reason: claim.reason, reasonCopy: TEST_PING_REFUSED_COPY[claim.reason], removed: false })
    if (req.body?.delaySeconds === 15) {
      const send = async () => {
        const result = await sendOnePing(deps.store, id, 'test', { post: deps.post, nowSeconds: deps.nowSeconds })
        console.log(`[web-push] scheduled test status=${result.status} ok=${result.ok} reason=${result.reason ?? 'none'} removed=${result.removed}`)
      }
      try {
        if (deps.scheduleForPhoneLock) deps.scheduleForPhoneLock(send)
        else { const timer = setTimeout(() => { void send() }, 15_000); timer.unref?.() }
      } catch { return res.status(503).json({ error: 'schedule_unavailable' }) }
      return res.status(202).json({ scheduled: true, delaySeconds: 15 })
    }
    const result = await sendOnePing(deps.store, id, 'test', { post: deps.post, nowSeconds: deps.nowSeconds })
    console.log(`[web-push] test ping status=${result.status} ok=${result.ok} reason=${result.reason ?? 'none'} removed=${result.removed}`)
    return res.status(result.ok ? 200 : 502).json(result)
  })

  return router
}
