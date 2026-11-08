// 6.99.31 (review B2/W2): one signing origin, and the signer listener only with the flag on.
import { describe, expect, it } from 'vitest'
import { WEB_KEY_SIGNER_PORT, webKeyRpId, webKeySignerOrigin } from './web-key-origin.js'
import { listenerPlan } from './listener-startup.js'

describe('signer origin', () => {
  it('is https on 3144 under the normalized MagicDNS name, never the 3143 app origin', () => {
    expect(WEB_KEY_SIGNER_PORT).toBe(3144)
    expect(webKeySignerOrigin('Ukaoma-Mac-Studio.tail38457f.ts.net.')).toBe('https://ukaoma-mac-studio.tail38457f.ts.net:3144')
    expect(webKeyRpId(' Ukaoma-Mac-Studio.tail38457f.ts.net. ')).toBe('ukaoma-mac-studio.tail38457f.ts.net')
  })
  it('unknown or junk names give no origin', () => {
    for (const v of [null, undefined, '', '   ', 'a b', 'host/x']) expect(webKeySignerOrigin(v as string)).toBeNull()
  })
})

describe('listenerPlan', () => {
  const base = { httpPort: 3141, httpsPort: 3143, signerPort: 3144 }
  it('flag unset: exactly the 6.99.29 set (HTTPS when certs exist, then HTTP)', () => {
    expect(listenerPlan({ ...base, httpsAvailable: true, webKeyAuthority: false })).toEqual([
      { label: 'HTTPS', port: 3143, tls: true }, { label: 'HTTP', port: 3141, tls: false },
    ])
    expect(listenerPlan({ ...base, httpsAvailable: false, webKeyAuthority: false })).toEqual([{ label: 'HTTP', port: 3141, tls: false }])
  })
  it('flag on: the signer joins the REQUIRED set beside HTTPS (fail closed like 3143); without certs there is no signer', () => {
    expect(listenerPlan({ ...base, httpsAvailable: true, webKeyAuthority: true })).toEqual([
      { label: 'HTTPS', port: 3143, tls: true }, { label: 'HTTPS signer', port: 3144, tls: true }, { label: 'HTTP', port: 3141, tls: false },
    ])
    expect(listenerPlan({ ...base, httpsAvailable: false, webKeyAuthority: true })).toEqual([{ label: 'HTTP', port: 3141, tls: false }])
  })
})
