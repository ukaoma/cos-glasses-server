// 6.74.0: trusting COS Control's signed fluidaudiocli (parakeet-cli-trust.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkDeveloperIdCli, COS_TEAM_ID, parseCodesignDisplay, plistVersion, readEmbeddedInfoPlist, TRUST_REQUIREMENT,
  versionMatches, isCliPathShape, type CliTrustDeps,
} from './parakeet-cli-trust.js'

const PLIST = (v: string) => `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.gotcos.fluidaudiocli</string><key>CFBundleShortVersionString</key><string>${v}</string></dict></plist>`
// Real `codesign -dv` shapes (2026-10-16): a Developer ID build with a bound plist, an ad hoc build.
const DEV_ID = `Executable=/x/fluidaudiocli\nIdentifier=com.gotcos.fluidaudiocli\nFormat=Mach-O thin (arm64)\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+7 location=embedded\nSignature size=9000\nAuthority=Developer ID Application: COS (${COS_TEAM_ID})\nInfo.plist entries=2\nTeamIdentifier=${COS_TEAM_ID}\nSealed Resources=none\n`
const ADHOC = 'Executable=/x/fluidaudiocli\nIdentifier=fluidaudiocli\nFormat=Mach-O thin (arm64)\nCodeDirectory v=20400 size=170982 flags=0x20002(adhoc,linker-signed) hashes=5340+0 location=embedded\nSignature=adhoc\nInfo.plist=not bound\nTeamIdentifier=not set\n'

let dir = '', cli = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cos-cli-trust-')); cli = join(dir, 'fluidaudiocli'); writeFileSync(cli, 'signed bytes') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function deps(over: Partial<CliTrustDeps> = {}): CliTrustDeps & { [k: string]: any } {
  return {
    display: vi.fn(async () => ({ code: 0, output: DEV_ID })),
    verify: vi.fn(async () => ({ code: 0, output: '' })),
    versionOutput: vi.fn(async () => ''),
    embeddedPlist: vi.fn(() => PLIST('0.17.4')),
    sha256: vi.fn(async () => 'a'.repeat(64)),
    ...over,
  }
}

describe('checkDeveloperIdCli', () => {
  it('trusts a COS Developer ID build whose bound Info.plist says 0.17.4, and never runs it', async () => {
    const d = deps()
    expect(await checkDeveloperIdCli(cli, d)).toEqual({ trusted: true, trust: 'developer-id', path: cli, teamId: COS_TEAM_ID, version: '0.17.4', versionSource: 'info-plist', sha256: 'a'.repeat(64), size: 12 })
    expect(d.verify).toHaveBeenCalledWith(cli)
    expect(d.verify).toHaveBeenCalledWith(cli, TRUST_REQUIREMENT)
    expect(d.versionOutput).not.toHaveBeenCalled()
  })

  it('accepts --version output when no Info.plist is bound', async () => {
    const d = deps({ display: vi.fn(async () => ({ code: 0, output: DEV_ID.replace('Info.plist entries=2', 'Info.plist=not bound') })), versionOutput: vi.fn(async () => 'fluidaudiocli 0.17.4\n') })
    expect(await checkDeveloperIdCli(cli, d)).toMatchObject({ trusted: true, versionSource: 'version-output' })
  })

  it('refuses another team', async () => {
    const d = deps({ display: vi.fn(async () => ({ code: 0, output: DEV_ID.replace(`TeamIdentifier=${COS_TEAM_ID}`, 'TeamIdentifier=ABCDE12345') })) })
    expect(await checkDeveloperIdCli(cli, d)).toMatchObject({ trusted: false, reason: 'wrong_team' })
  })

  it('refuses a certificate that claims the COS team but does not chain to Apple', async () => {
    const d = deps({ verify: vi.fn(async (_p: string, req?: string) => ({ code: req ? 3 : 0, output: req ? 'test-requirement: code failed to satisfy specified code requirement(s)' : '' })) })
    expect(await checkDeveloperIdCli(cli, d)).toMatchObject({ trusted: false, reason: 'wrong_team' })
  })

  it('refuses unsigned and ad hoc builds (the upstream build on this Mac is ad hoc)', async () => {
    expect(await checkDeveloperIdCli(cli, deps({ display: vi.fn(async () => ({ code: 0, output: ADHOC })) }))).toMatchObject({ trusted: false, reason: 'unsigned' })
    expect(await checkDeveloperIdCli(cli, deps({ display: vi.fn(async () => ({ code: 1, output: `${cli}: code object is not signed at all` })) }))).toMatchObject({ trusted: false, reason: 'unsigned' })
    expect(await checkDeveloperIdCli(cli, deps({ display: vi.fn(async () => ({ code: 1, output: 'codesign failed' })) }))).toMatchObject({ trusted: false, reason: 'unsigned' })
  })

  it('refuses a signature that does not verify strictly', async () => {
    const d = deps({ verify: vi.fn(async () => ({ code: 1, output: `${cli}: invalid signature (code or signature have been modified)` })) })
    expect(await checkDeveloperIdCli(cli, d)).toMatchObject({ trusted: false, reason: 'signature_invalid', detail: expect.stringMatching(/invalid signature/) })
  })

  it('refuses another version; a bound plist naming one means the binary is never run', async () => {
    const other = deps({ embeddedPlist: vi.fn(() => PLIST('0.5.316')), versionOutput: vi.fn(async () => '0.17.4') })
    expect(await checkDeveloperIdCli(cli, other)).toMatchObject({ trusted: false, reason: 'wrong_version' })
    expect(other.versionOutput).not.toHaveBeenCalled()
    const unbound = deps({ display: vi.fn(async () => ({ code: 0, output: DEV_ID.replace('Info.plist entries=2', 'Info.plist=not bound') })), versionOutput: vi.fn(async () => '[ERROR] Unknown command: --version') })
    expect(await checkDeveloperIdCli(cli, unbound)).toMatchObject({ trusted: false, reason: 'wrong_version' })
  })

  it('a missing file is missing, before any codesign call', async () => {
    const d = deps()
    expect(await checkDeveloperIdCli(join(dir, 'nope'), d)).toMatchObject({ trusted: false, reason: 'missing' })
    expect(d.display).not.toHaveBeenCalled()
  })
})

describe('helpers', () => {
  it('versionMatches takes 0.17.4 as a whole token only', () => {
    for (const ok of ['0.17.4', 'v0.17.4', 'fluidaudiocli 0.17.4\n', 'FluidAudio 0.17.4 (abc)']) expect(versionMatches(ok), ok).toBe(true)
    for (const no of ['0.17.40', '10.17.4', '0.17.4.1', '0.17.3', '', '1.0.17.4']) expect(versionMatches(no), no).toBe(false)
  })
  it('plistVersion prefers the short version string', () => {
    expect(plistVersion(PLIST('0.17.4'))).toBe('0.17.4')
    expect(plistVersion('<key>CFBundleVersion</key><string>7</string>')).toBe('7')
    expect(plistVersion('<dict/>')).toBeNull()
  })
  it('parseCodesignDisplay', () => {
    expect(parseCodesignDisplay(DEV_ID)).toEqual({ teamId: COS_TEAM_ID, adhoc: false, unsigned: false, plistBound: true })
    expect(parseCodesignDisplay(ADHOC)).toEqual({ teamId: null, adhoc: true, unsigned: false, plistBound: false })
  })
  it('only an absolute path to a file named fluidaudiocli is ever checked', () => {
    expect(isCliPathShape('/Applications/COS Control.app/Contents/Helpers/fluidaudiocli')).toBe(true)
    for (const no of ['fluidaudiocli', '/Applications/COS Control.app/Contents/MacOS/COS Control', '/bin/sh', 3, '/x/fluidaudiocli\0']) expect(isCliPathShape(no), String(no)).toBe(false)
  })
})

describe('readEmbeddedInfoPlist', () => {
  /** A minimal thin arm64 Mach-O with one __TEXT segment holding __info_plist. */
  function macho(plist: string, fat = false): Buffer {
    const body = Buffer.from(plist)
    const cmdsize = 72 + 80
    const header = Buffer.alloc(32)
    header.writeUInt32LE(0xfeedfacf, 0); header.writeUInt32LE(0x0100000c, 4); header.writeUInt32LE(1, 16); header.writeUInt32LE(cmdsize, 20)
    const seg = Buffer.alloc(cmdsize)
    seg.writeUInt32LE(0x19, 0); seg.writeUInt32LE(cmdsize, 4); seg.write('__TEXT', 8); seg.writeUInt32LE(1, 64)
    const dataOff = 32 + cmdsize
    seg.write('__info_plist', 72); seg.write('__TEXT', 88); seg.writeBigUInt64LE(BigInt(body.length), 72 + 40); seg.writeUInt32LE(dataOff, 72 + 48)
    const thin = Buffer.concat([header, seg, body])
    if (!fat) return thin
    const fatHead = Buffer.alloc(8 + 20)
    fatHead.writeUInt32BE(0xcafebabe, 0); fatHead.writeUInt32BE(1, 4)
    fatHead.writeUInt32BE(0x0100000c, 8); fatHead.writeUInt32BE(4096, 16); fatHead.writeUInt32BE(thin.length, 20)
    return Buffer.concat([fatHead, Buffer.alloc(4096 - fatHead.length), thin])
  }
  it('reads the section from a thin and a fat binary, and nothing from other files', () => {
    const p = join(dir, 'm'); writeFileSync(p, macho(PLIST('0.17.4')))
    expect(plistVersion(readEmbeddedInfoPlist(p)!)).toBe('0.17.4')
    const f = join(dir, 'f'); writeFileSync(f, macho(PLIST('0.17.4'), true))
    expect(plistVersion(readEmbeddedInfoPlist(f)!)).toBe('0.17.4')
    const t = join(dir, 't'); writeFileSync(t, '#!/bin/sh\necho 0.17.4\n')
    expect(readEmbeddedInfoPlist(t)).toBeNull()
    expect(readEmbeddedInfoPlist(join(dir, 'missing'))).toBeNull()
  })
  it('a FIFO named fluidaudiocli returns at once and is never trusted (a blocking open would stop the server)', async () => {
    const { execFileSync } = await import('node:child_process')
    const fifo = join(dir, 'fifo', 'fluidaudiocli')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(fifo, '..'))
    execFileSync('/usr/bin/mkfifo', [fifo])
    const t0 = Date.now()
    expect(readEmbeddedInfoPlist(fifo)).toBeNull()
    expect(await checkDeveloperIdCli(fifo, deps())).toMatchObject({ trusted: false, reason: 'missing' })
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})
