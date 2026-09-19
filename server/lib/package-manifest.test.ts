import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The package manifest must be readable, and its version must be the one the
 * changelog documents.
 *
 * WHY THIS FILE EXISTS. On 2026-08-23 the 6.36.26 version bump was applied with
 *
 *   open('package.json', 'w').write(open('package.json').read().replace(...))
 *
 * Python evaluates the outer `open(..., 'w')` first, which TRUNCATES the file,
 * so the inner read returned '' and the manifest was committed as zero bytes.
 * 3,028 tests and a clean tsc run all passed -- none of them read package.json.
 * It surfaced only because a clean clone was made before publishing, and it
 * would otherwise have reached `npm publish`.
 *
 * WHAT EACH HALF ACTUALLY CATCHES. Verified by mutation, not assumed:
 *
 *   empty manifest    caught by the RUNNER, not by the assertion below. vitest
 *                     cannot load vitest.config.ts without a parseable
 *                     package.json and exits with "Unexpected end of file in
 *                     JSON". The first test is therefore a belt-and-braces
 *                     statement of intent; the loud failure comes for free.
 *   version drift     caught here, and only here. Bumping package.json without
 *                     the changelog leaves 3,027 other tests green.
 *
 * Saying which is which matters: a comment claiming this file catches the empty
 * case would be the same defect it was written about.
 */

const PKG = new URL('../../package.json', import.meta.url).pathname

describe('package manifest', () => {
  it('is non-empty and parses', () => {
    const raw = readFileSync(PKG, 'utf8')
    expect(raw.length, 'package.json is empty').toBeGreaterThan(0)
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('carries the fields publishing depends on', () => {
    const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
    expect(pkg.name).toBe('@gotcos/glasses-server')
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(pkg.bin, 'the CLI entrypoint is what users run').toBeTruthy()
  })

  // Version and changelog are two touchpoints of one release. A bump that lands
  // in only one of them ships a package whose notes describe something else.
  it('matches the newest changelog heading', () => {
    const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
    const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url).pathname, 'utf8')
    // 6.52.0: a section written ahead of its release sits on top as `## X.Y.Z (unreleased)`
    // while the package keeps the published version. Only such sections, and only above
    // the newest released heading, are skipped; the release bump drops the marker, and a
    // bump that leaves it (or a marked version equal to the package's) still fails here.
    const headings = [...changelog.matchAll(/^##\s*\[?(\d+\.\d+\.\d+)\]?(.*)$/gm)]
    const unreleased = (rest: string) => /\(unreleased\)/i.test(rest)
    const firstReleased = headings.findIndex(h => !unreleased(h[2] ?? ''))
    expect(firstReleased, 'no version heading found in CHANGELOG.md').toBeGreaterThanOrEqual(0)
    expect(headings[firstReleased]?.[1]).toBe(pkg.version)
    for (const h of headings.slice(0, firstReleased)) expect(h[1], 'an unreleased section cannot carry the published version').not.toBe(pkg.version)
    expect(headings.slice(firstReleased).some(h => unreleased(h[2] ?? '')), 'an (unreleased) section below a released one').toBe(false)
  })

  // 6.52.0 QA round 1. The lockfile carries the version twice, and a bump that misses
  // either ships a tarball whose lock disagrees with its manifest.
  it('the package-lock version and packages[""].version equal package.json', () => {
    const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url).pathname, 'utf8'))
    expect(lock.version).toBe(pkg.version)
    expect(lock.packages?.['']?.version).toBe(pkg.version)
  })

  // An unreleased section says "Not published"; the release bump drops the marker, and a
  // section that shipped with that line still in it would tell readers it never did.
  it('a released section never says "Not published"', () => {
    const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url).pathname, 'utf8')
    const sections = changelog.split(/^(?=##\s*\[?\d+\.\d+\.\d+)/m).filter(section => /^##\s*\[?\d+\.\d+\.\d+/.test(section))
    expect(sections.length).toBeGreaterThan(10)
    for (const section of sections) {
      const heading = section.split('\n')[0]!
      if (/\(unreleased\)/i.test(heading)) continue
      expect(section, heading).not.toMatch(/not published/i)
    }
  })
})

describe('package.json ships the security surface', () => {
  it('lists SECURITY.md in files and names a bugs URL', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { files?: string[]; bugs?: { url?: string } }
    expect(pkg.files).toContain('SECURITY.md')
    expect(pkg.bugs?.url).toMatch(/github\.com\/ukaoma\/cos-glasses-server\/issues/)
  })
})
