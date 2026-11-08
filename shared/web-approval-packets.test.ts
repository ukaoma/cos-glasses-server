import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { approveFieldsValid, canonicalJson, parseWebApprovalPacket, WEB_APPROVAL_PACKET_MAX_LIFETIME_MS } from './web-turn-envelope.js'

const goldens = JSON.parse(readFileSync(fileURLToPath(new URL('./web-approval-packets.golden.json', import.meta.url)), 'utf8')).packets as Array<{ packet: Record<string, any>; canonical: string; packetSha256: string }>

describe('approval packet cross-language contract', () => {
  it.each(goldens)('canonical bytes and SHA-256 for $packet.channel', row => {
    expect(parseWebApprovalPacket(row.packet)).toEqual(row.packet)
    expect(canonicalJson(row.packet)).toBe(row.canonical)
    expect(createHash('sha256').update(row.canonical, 'utf8').digest('hex')).toBe(row.packetSha256)
  })
  it('rejects unknown keys, booleans as timestamps, invalid packet ids and excessive lifetime', () => {
    const packet = goldens[0].packet
    for (const changes of [{ extra: 1 }, { createdAt: true }, { packetId: 'has-padding=====' }, { packetId: 'short' }, { exp: packet.createdAt }, { exp: packet.createdAt + WEB_APPROVAL_PACKET_MAX_LIFETIME_MS + 1 }]) {
      expect(parseWebApprovalPacket({ ...packet, ...changes })).toBeNull()
    }
  })
  it('new channels have disjoint manifest artifacts and SHA-256 only', () => {
    const names: Record<string, string> = { 'gotcos-site': 'gotcos-site-manifest', 'control-downloads': 'cos-control-downloads-manifest', 'release-docs': 'cos-release-docs-manifest' }
    for (const [channel, artifact] of Object.entries(names)) {
      expect(approveFieldsValid('publish', artifact, '7.0.6', 'sha256:' + 'a'.repeat(64), channel)).toBe(true)
      expect(approveFieldsValid('publish', 'wrong-manifest', '7.0.6', 'sha256:' + 'a'.repeat(64), channel)).toBe(false)
      expect(approveFieldsValid('publish', artifact, '7.0.6', 'sha512:' + 'a'.repeat(128), channel)).toBe(false)
      expect(approveFieldsValid('install', artifact, '7.0.6', 'sha256:' + 'a'.repeat(64), channel)).toBe(false)
    }
    for (const channel of ['all-release', 'gotcos-site/*', 'github-downloads', 'docs', 'https://gotcos.com']) expect(approveFieldsValid('publish', 'a', '7.0.6', 'sha256:' + 'a'.repeat(64), channel)).toBe(false)
  })
})
