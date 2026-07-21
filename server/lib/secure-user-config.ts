import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

export class UnsafeUserConfigPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUserConfigPathError'
  }
}

export function securePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stats = lstatSync(dir)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new UnsafeUserConfigPathError(`${dir} must be a private directory, not a symlink`)
  }
  chmodSync(dir, 0o700)
}

export function secureExistingPrivateFile(file: string): void {
  if (!existsSync(file)) return
  const stats = lstatSync(file)
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new UnsafeUserConfigPathError(`${file} must be a regular file, not a symlink`)
  }
  chmodSync(file, 0o600)
}

/**
 * Append an env block without ever following a symlink or exposing a partially
 * written credential file. The replacement is created beside the destination
 * at 0600 and atomically renamed into place.
 */
export function appendPrivateEnvBlock(file: string, block: string): void {
  const dir = dirname(file)
  securePrivateDirectory(dir)
  secureExistingPrivateFile(file)

  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
  const temp = join(dir, `.${basename(file)}.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(temp, `${current}${separator}${block}`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    chmodSync(temp, 0o600)
    renameSync(temp, file)
    chmodSync(file, 0o600)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* best-effort cleanup */ }
    throw error
  }
}
