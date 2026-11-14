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
  it('X1 7.0.42, the boot miss of 11/14: an ENOTFOUND lookup is cached a minute by refresh(), refreshIfMissing looks again at once, and lastMiss names every miss', async () => {
    let now = 1_000_000
    let lookups = 0
    // What a blocked boot loop produced on his Mac: the PTR answer arrived after the 1.5 s timer, and the lookup failed ENOTFOUND.
    const busyBoot = () => Object.assign(new Error('queryPtr ENOTFOUND'), { code: 'ENOTFOUND' })
    const self = createTailnetSelfName({
      nudgerName: () => null,
      tailscaleIpv4: () => '100.108.149.114',
      reverse: async () => { lookups++; if (lookups === 1) throw busyBoot(); return [`${NAME}.`] },
      now: () => now,
    })
    expect(self.lastMiss!()).toBeNull()
    expect(await self.refresh()).toBeNull()
    expect(self.lastMiss!()).toBe('no_answer')
    now += 5_000
    // The 7.0.41 path: refresh() answers the cached miss for a minute, without looking.
    expect(await self.refresh()).toBeNull()
    expect(lookups).toBe(1)
    // The 7.0.42 path for 3143: a fresh lookup now, which finds the name.
    expect(await self.refreshIfMissing()).toBe(NAME)
    expect(lookups).toBe(2)
    expect(self.lastMiss!()).toBeNull()
    // A later miss never erases the name, so there is no miss to report.
    now += 11 * 60_000
    lookups = 0
    expect(await self.refresh()).toBe(NAME)
    expect(self.lastMiss!()).toBeNull()
  })

  it('X1 7.0.42: lastMiss says no_tailscale_ip, not_ts_net or no_answer, never a name or an address', async () => {
    const offline = createTailnetSelfName({ nudgerName: () => null, tailscaleIpv4: () => null, reverse: async () => [NAME] })
    await offline.refresh()
    expect(offline.lastMiss!()).toBe('no_tailscale_ip')
    const foreign = createTailnetSelfName({ nudgerName: () => null, tailscaleIpv4: () => '100.108.149.114', reverse: async () => ['router.local.'] })
    await foreign.refresh()
    expect(foreign.lastMiss!()).toBe('not_ts_net')
    const empty = createTailnetSelfName({ nudgerName: () => null, tailscaleIpv4: () => '100.108.149.114', reverse: async () => [] })
    await empty.refresh()
    expect(empty.lastMiss!()).toBe('no_answer')
    // A miss, then the nudger learns the name: there is a name now, so no miss to report.
    let nudge: string | null = null
    const late = createTailnetSelfName({ nudgerName: () => nudge, tailscaleIpv4: () => null, reverse: async () => [] })
    await late.refresh()
    expect(late.lastMiss!()).toBe('no_tailscale_ip')
    nudge = NAME
    expect(late.lastMiss!()).toBeNull()
  })
})
