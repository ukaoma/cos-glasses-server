// 7.0.9: COS_WEB_KEY_ANCHOR_BOOTSTRAP serves only the anchor status and registration routes
// (routes/web-key.ts). These pin the surfaces index.ts builds at boot: the 3144 signer listener,
// its asset integrity, the extra cookie port and served-asset integrity all stay on
// COS_WEB_KEY_AUTHORITY alone, so a bootstrap-only boot is the flag-off boot plus two routes.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { listenerPlan } from './listener-startup.js'
import { webKeyAuthorityEnabled } from './web-key-authority.js'
import { webControlIntegrityEnabled } from './web-control-integrity.js'

const INDEX = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8')
const BOOT_ONLY = { COS_WEB_KEY_ANCHOR_BOOTSTRAP: '1' } as NodeJS.ProcessEnv
const count = (text: string, needle: string): number => text.split(needle).length - 1
const plan = (env: NodeJS.ProcessEnv) => listenerPlan({ httpsAvailable: true, webKeyAuthority: webKeyAuthorityEnabled(env), httpPort: 3141, httpsPort: 3143, signerPort: 3144 })

describe('7.0.9 bootstrap only: no signer listener, no integrity default, no extra cookie port', () => {
  it('the listener plan with only the bootstrap switch is exactly the flag-off plan (no 3144)', () => {
    expect(plan(BOOT_ONLY)).toEqual(plan({}))
    expect(plan(BOOT_ONLY).map(e => e.port)).toEqual([3143, 3141])
    expect(plan({ COS_WEB_KEY_AUTHORITY: '1', COS_WEB_KEY_ANCHOR_BOOTSTRAP: '1' }).map(e => e.port)).toEqual([3143, 3144, 3141])
  })

  it('served-asset integrity does not default on with the bootstrap switch', () => {
    expect(webControlIntegrityEnabled(BOOT_ONLY)).toBe(false)
  })

  it('index.ts builds the 3144 listener, the signer integrity and the cookie ports from the authority switch alone', () => {
    expect(count(INDEX, 'listenerPlan({ httpsAvailable, webKeyAuthority: webKeyAuthorityEnabled(), httpPort: PORT')).toBe(1)
    expect(count(INDEX, 'const webKeySignerIntegrity: WebControlIntegrity | null = webKeyAuthorityEnabled()\n')).toBe(1)
    expect(count(INDEX, 'const webCookiePorts = (): number[] => (webKeyAuthorityEnabled() ? [PORT, HTTPS_PORT, WEB_KEY_SIGNER_PORT] : [PORT, HTTPS_PORT])')).toBe(1)
    // The bootstrap switch and the routes' mode are read only by routes/web-key.ts, never at boot.
    expect(INDEX).not.toMatch(/webKeyAnchorBootstrapEnabled|\.mode\(\)|process\.env\.COS_WEB_KEY_ANCHOR_BOOTSTRAP/)
  })
})
