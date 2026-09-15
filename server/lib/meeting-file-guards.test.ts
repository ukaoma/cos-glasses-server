// The shared meeting filesystem guards.
//
// These were private to MeetingStore and covered only through it. Now that a
// second library depends on them, each rule gets a direct test: a rule that is
// only exercised through one caller is a rule the next caller can lose.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_MEETING_BYTES,
  UnsafeMeetingDirectoryError,
  existingRootRealpath,
  isContained,
  safeDirectoryRealpath,
  safeReadFile,
  safeReadFileHead,
} from './meeting-file-guards.js'

const roots: string[] = []

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cos-meeting-guards-'))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('root', () => {
  it('returns null for a root that does not exist', () => {
    expect(existingRootRealpath(join(newRoot(), 'nope'))).toBeNull()
  })

  it('throws the caller error when the root is a symlink', () => {
    const parent = newRoot()
    const real = join(parent, 'real')
    const link = join(parent, 'link')
    mkdirSync(real)
    symlinkSync(real, link)
    expect(() => existingRootRealpath(link)).toThrow(UnsafeMeetingDirectoryError)

    class Custom extends Error {}
    expect(() => existingRootRealpath(link, () => new Custom('mine'))).toThrow(Custom)
  })
})

describe('directories', () => {
  it('accepts a real child and refuses a symlinked one', () => {
    const root = newRoot()
    const rootReal = existingRootRealpath(root)!
    mkdirSync(join(root, '2026-09'))
    expect(safeDirectoryRealpath(join(root, '2026-09'), rootReal)).not.toBeNull()

    const outside = newRoot()
    symlinkSync(outside, join(root, '2026-08'))
    expect(safeDirectoryRealpath(join(root, '2026-08'), rootReal)).toBeNull()
  })

  it('refuses a child whose real parent is somewhere else', () => {
    const root = newRoot()
    const rootReal = existingRootRealpath(root)!
    expect(safeDirectoryRealpath(join(root, 'missing'), rootReal)).toBeNull()
    expect(isContained(rootReal, join(rootReal, 'a'))).toBe(true)
    expect(isContained(rootReal, join(rootReal, '..', 'b'))).toBe(false)
  })
})

describe('files', () => {
  function monthDir(): { dir: string; real: string } {
    const root = newRoot()
    const dir = join(root, '2026-09')
    mkdirSync(dir)
    return { dir, real: safeDirectoryRealpath(dir, existingRootRealpath(root)!)! }
  }

  it('reads a regular file', () => {
    const { dir, real } = monthDir()
    writeFileSync(join(dir, 'note.md'), 'hello')
    expect(safeReadFile(dir, real, 'note.md')).toBe('hello')
  })

  it('refuses a symlink even when it points at a readable file', () => {
    const { dir, real } = monthDir()
    const secret = join(newRoot(), 'id_ed25519')
    writeFileSync(secret, 'PRIVATE KEY MATERIAL')
    symlinkSync(secret, join(dir, 'note.md'))
    expect(safeReadFile(dir, real, 'note.md')).toBeNull()
    expect(safeReadFileHead(dir, real, 'note.md', 16)).toBeNull()
  })

  it('refuses a name that climbs out of the directory', () => {
    const { dir, real } = monthDir()
    writeFileSync(join(dir, '..', 'outside.md'), 'not yours')
    expect(safeReadFile(dir, real, '../outside.md')).toBeNull()
  })

  it('refuses a file past the ceiling, and honours a caller ceiling', () => {
    const { dir, real } = monthDir()
    const big = 'x'.repeat(2048)
    writeFileSync(join(dir, 'big.md'), big)
    expect(safeReadFile(dir, real, 'big.md', 1024)).toBeNull()
    expect(safeReadFile(dir, real, 'big.md', 4096)).toBe(big)
    expect(MAX_MEETING_BYTES).toBe(10 * 1024 * 1024)
  })

  it('reads only the head, and an empty file reads empty', () => {
    const { dir, real } = monthDir()
    writeFileSync(join(dir, 'head.json'), `{"sessionId":"abc"}${'p'.repeat(5000)}`)
    expect(safeReadFileHead(dir, real, 'head.json', 19)).toBe('{"sessionId":"abc"}')
    writeFileSync(join(dir, 'empty.json'), '')
    expect(safeReadFileHead(dir, real, 'empty.json', 64)).toBe('')
  })

  it('returns null for a missing file rather than throwing', () => {
    const { dir, real } = monthDir()
    expect(safeReadFile(dir, real, 'gone.md')).toBeNull()
    expect(safeReadFileHead(dir, real, 'gone.md', 10)).toBeNull()
  })
})
