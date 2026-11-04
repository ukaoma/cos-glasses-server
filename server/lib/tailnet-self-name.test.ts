import { describe, expect, it } from 'vitest'
import { createTailnetSelfName } from './tailnet-self-name.js'
import { isAllowedCorsOrigin } from '../routes/web-control.js'

const NAME = 'ukaoma-mac-studio.tail38457f.ts.net'

describe('tailnet self name (MagicDNS reverse lookup)', () => {
  it('learns the name when the Tailscale CLI never answers (the 6.99.1 field failure)', async () => {
    let lookups = 0
    const self = createTailnetSelfName({
      nudgerName: () => null,
      tailscaleIpv4: () => '100.108.149.114',
      reverse: async ip => { lookups++; expect(ip).toBe('100.108.149.114'); return [`${NAME.toUpperCase()}.`] },
    })
    expect(self.currentSelfDnsName()).toBeNull()
    expect(await self.refresh()).toBe(NAME)
    expect(self.currentSelfDnsName()).toBe(NAME)
    await self.refresh()
    expect(lookups).toBe(1)
    // The phone's sign-in POST from the name URL now passes the CORS gate, and only this Mac's name.
    expect(await isAllowedCorsOrigin(`http://${NAME}:3141`, self)).toBe(true)
    expect(await isAllowedCorsOrigin('http://other-mac.tail38457f.ts.net:3141', self)).toBe(false)
  })

  it('prefers the nudger, refuses names that are not *.ts.net, and keeps one lookup in flight', async () => {
    let lookups = 0
    let release: (v: string[]) => void = () => {}
    const self = createTailnetSelfName({
      nudgerName: () => null,
      tailscaleIpv4: () => '100.108.149.114',
      reverse: () => { lookups++; return new Promise(r => { release = r }) },
    })
    const a = self.refresh(), b = self.refresh()
    release(['router.local.', 'evil.example.com.'])
    expect(await a).toBeNull()
    expect(await b).toBeNull()
    expect(lookups).toBe(1)
    const viaNudger = createTailnetSelfName({ nudgerName: () => `${NAME}.`, reverse: async () => { throw new Error('not asked') } })
    expect(viaNudger.currentSelfDnsName()).toBe(NAME)
    expect(await viaNudger.refresh()).toBe(NAME)
  })

  it('a miss is retried after a minute, and never erases a name already learned', async () => {
    let now = 1_000_000
    let answer: string[] = []
    const self = createTailnetSelfName({ nudgerName: () => null, tailscaleIpv4: () => '100.108.149.114', reverse: async () => answer, now: () => now })
    expect(await self.refresh()).toBeNull()
    answer = [NAME]
    now += 30_000
    expect(await self.refresh()).toBeNull()
    now += 31_000
    expect(await self.refresh()).toBe(NAME)
    answer = []
    now += 11 * 60_000
    expect(await self.refresh()).toBe(NAME)
    // No Tailscale address at all: nothing to look up, no name.
    const offline = createTailnetSelfName({ nudgerName: () => null, tailscaleIpv4: () => null, reverse: async () => [NAME] })
    expect(await offline.refresh()).toBeNull()
  })
})
