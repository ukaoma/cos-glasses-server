// 6.88.0 LAN first: where server/index.ts mounts the route-proof router. A SOURCE-SHAPE check:
// importing index.ts boots the whole server (ports, whisper, schedulers), so no test runs it. The
// route's behaviour is proven in routes/route-proof.test.ts behind the real auth boundary; this
// file only pins that index.ts mounts it once, after the token gate, before the lease catch-all
// and the body parsers, with the live token and the live instance id.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8')
const MOUNT = `app.use('/api', createRouteProofRouter({
  token: () => API_TOKEN,
  serverInstanceId: getServerInstanceId,
}))`

describe('index.ts mounts GET /api/route-proof (6.88.0)', () => {
  it('exactly once, with the live token and the live instance id', () => {
    expect(source.split(MOUNT).length).toBe(2)
    expect(source.split('createRouteProofRouter(').length).toBe(2)
  })

  it('after the token gate and pairing, before the lease catch-all and the global body parser', () => {
    const at = source.indexOf(MOUNT)
    const gate = source.indexOf("app.use('/api', requireApiToken(API_TOKEN")
    const pairing = source.indexOf("app.use('/api', createPairingRouter(")
    const catchAll = source.indexOf('// Fail-closed catch-all for mutation routes')
    const parser = source.search(/app\.use\(express\.json\(/)
    expect(gate).toBeGreaterThan(0)
    expect(pairing).toBeGreaterThan(gate)
    expect(at).toBeGreaterThan(pairing)
    expect(catchAll).toBeGreaterThan(at)
    if (parser >= 0) expect(parser).toBeGreaterThan(at)
  })
})
