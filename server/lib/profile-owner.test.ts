import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cos-owner-')); vi.stubEnv('COS_PROFILE_PATH', join(root, 'profile.json')); vi.resetModules() })
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); vi.resetModules() })
it('sets an absent owner, preserves other fields, busts the cache and refuses stale edits', async () => {
 const path = process.env.COS_PROFILE_PATH!
 writeFileSync(path, JSON.stringify({ owner_name: 'User', vocabulary: ['Synthetic'], domain_keywords: { work: ['test'] } }))
 const profile = await import('./profile.js'); expect(profile.getOwnerName()).toBe('User')
 expect(profile.setProfileOwnerName(' Synthetic Owner ', null)).toBe('Synthetic Owner')
 expect(profile.getOwnerName()).toBe('Synthetic Owner')
 expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ owner_name: 'Synthetic Owner', vocabulary: ['Synthetic'], domain_keywords: { work: ['test'] } })
 expect(statSync(path).mode & 0o777).toBe(0o600)
 expect(() => profile.setProfileOwnerName('Other', null)).toThrow('owner_changed')
 expect(profile.setProfileOwnerName('Other', 'Synthetic Owner')).toBe('Other')
})
it('never overwrites a corrupt profile or accepts placeholder names', async () => {
 const path = process.env.COS_PROFILE_PATH!; const profile = await import('./profile.js')
 for (const name of ['', 'User', 'Owner', 'Me', 'Your name', 'a\nb', 'x'.repeat(121)]) expect(() => profile.setProfileOwnerName(name, null)).toThrow('invalid_owner_name')
 writeFileSync(path, 'broken'); expect(() => profile.setProfileOwnerName('Synthetic', null)).toThrow('profile_unreadable')
 expect(readFileSync(path, 'utf8')).toBe('broken')
})
