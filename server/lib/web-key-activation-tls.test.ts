import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ControlTsnetTls } from './control-tsnet-tls.js'
import { SignerTls } from './web-key-signer-tls.js'
import { SELF_DNS } from './__fixtures__/web-key-kit.js'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function dir() { const d = mkdtempSync(join(tmpdir(), 'activation-tls-')); dirs.push(d); return d }
function result(stdout = '') { return { code: 0, signal: null, killed: false, stdout, stderr: '', elapsedMs: 1 } }
it('no grant: no status or cert CLI, including explicit checks and status reads', async () => {
  const runner = vi.fn(async () => result())
  const tls = new SignerTls({ dir: dir(), selfDnsName: async () => SELF_DNS, permit: () => false, runner, resolveBin: () => '/fixture-only', schedule: () => ({ cancel() {} }) })
  expect((await tls.check()).reason).toBe('authority_activation_required'); tls.statusRead(); expect(runner).not.toHaveBeenCalled(); tls.stop()
})
it.each(['off', 'rename'])('recheck permit after awaited status and before cert for %s', async mode => {
  let allowed = true, currentName = SELF_DNS
  const runner = vi.fn(async (_bin: string, args: readonly string[]) => {
    expect(args[0]).toBe('status')
    if (mode === 'off') allowed = false; else currentName = 'renamed.tail00000a.ts.net'
    return result(JSON.stringify({ BackendState: 'Running', Self: { DNSName: SELF_DNS }, CertDomains: [SELF_DNS] }))
  })
  const tls = new SignerTls({ dir: dir(), selfDnsName: async () => SELF_DNS, permit: name => allowed && name === currentName, runner, resolveBin: () => '/fixture-only', schedule: () => ({ cancel() {} }) })
  expect((await tls.check()).reason).toBe('authority_activation_required'); expect(runner).toHaveBeenCalledTimes(1); tls.stop()
})
it('name changed during awaited lookup is refused before any CLI', async () => {
  const runner = vi.fn(async () => result())
  const tls = new SignerTls({ dir: dir(), selfDnsName: async () => 'renamed.tail00000a.ts.net', permit: name => name === SELF_DNS, runner, resolveBin: () => '/fixture-only', schedule: () => ({ cancel() {} }) })
  expect((await tls.check()).reason).toBe('authority_activation_required'); expect(runner).not.toHaveBeenCalled(); tls.stop()
})
it('independent ordinary3143 TLS with no authority permit keeps its existing CLI path', async () => {
  const runner = vi.fn(async () => result(JSON.stringify({ BackendState: 'Running', CertDomains: [] })))
  const tls = new SignerTls({ dir: dir(), selfDnsName: async () => SELF_DNS, runner, resolveBin: () => '/fixture-only', schedule: () => ({ cancel() {} }) })
  expect((await tls.check()).reason).toBe('tailnet_https_certs_off'); expect(runner).toHaveBeenCalledTimes(1); tls.stop()
})

it('revoked/renamed signer hands shared3143 to an independent manager without granting3144', async () => {
  let allow = true
  let shared: SignerTls | null = null
  const ownRunner = vi.fn(async () => result(JSON.stringify({ BackendState: 'Running', CertDomains: [] })))
  const makeOwn = vi.fn(deps => new SignerTls(deps))
  const control = new ControlTsnetTls(() => shared, { dir: dir(), selfDnsName: async () => SELF_DNS, runner: ownRunner, resolveBin: () => '/fixture-only', schedule: () => ({ cancel() {} }) }, makeOwn)
  const authority = new SignerTls({ dir: dir(), selfDnsName: async () => SELF_DNS, permit: () => allow,
    runner: async () => { allow = false; return result(JSON.stringify({ BackendState: 'Running', CertDomains: [SELF_DNS] })) },
    resolveBin: () => '/fixture-only', schedule: () => ({ cancel() {} }),
    onPermitRefused: () => { shared?.stop(); shared = null; control.start() },
  })
  shared = authority; control.start(); expect(makeOwn).not.toHaveBeenCalled()
  await authority.check(); expect(shared).toBeNull(); expect(makeOwn).toHaveBeenCalledTimes(1)
  expect(control.active()).not.toBe(authority); await control.active()!.check(); expect(ownRunner).toHaveBeenCalledTimes(1)
  expect(authority.status().trusted).toBe(false); expect(control.active()!.status().reason).toBe('tailnet_https_certs_off')
  control.stop(); authority.stop()
})
