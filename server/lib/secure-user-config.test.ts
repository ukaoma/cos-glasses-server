import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  appendPrivateEnvBlock,
  secureExistingPrivateFile,
  securePrivateDirectory,
} from './secure-user-config.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cos-secure-config-'))
  roots.push(root)
  return root
}

describe('secure user config', () => {
  it('creates and repairs the config directory at 0700', () => {
    const dir = join(freshRoot(), '.cos-glasses')
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    chmodSync(dir, 0o755)

    securePrivateDirectory(dir)

    expect(lstatSync(dir).mode & 0o777).toBe(0o700)
  })

  it('repairs legacy config files to 0600', () => {
    const file = join(freshRoot(), '.env')
    writeFileSync(file, 'COS_API_TOKEN=legacy\n', { mode: 0o644 })
    chmodSync(file, 0o644)

    secureExistingPrivateFile(file)

    expect(lstatSync(file).mode & 0o777).toBe(0o600)
  })

  it('atomically appends a token without broadening permissions', () => {
    const file = join(freshRoot(), '.cos-glasses', '.env')

    appendPrivateEnvBlock(file, '# generated\nCOS_API_TOKEN=secret\n')

    expect(readFileSync(file, 'utf8')).toBe('# generated\nCOS_API_TOKEN=secret\n')
    expect(lstatSync(file).mode & 0o777).toBe(0o600)
    expect(lstatSync(dirname(file)).mode & 0o777).toBe(0o700)
  })

  it('refuses symlinked config files', () => {
    const root = freshRoot()
    const target = join(root, 'target')
    const file = join(root, '.env')
    writeFileSync(target, 'do-not-touch\n')
    symlinkSync(target, file)

    expect(() => appendPrivateEnvBlock(file, 'COS_API_TOKEN=secret\n')).toThrow(/not a symlink/)
    expect(readFileSync(target, 'utf8')).toBe('do-not-touch\n')
  })
})
