// Filesystem guards shared by every meeting library on this box.
//
// These were private methods on MeetingStore. 6.47.0 gives the imported library
// its own root under the data home, and it needs the SAME guards rather than a
// second, subtly different copy of them: a symlinked month folder, a meeting
// file that is really a link to ~/.ssh/id_ed25519, or a "markdown" file of
// 400 MB are the three ways a directory of user-named files becomes a read
// primitive, and each is closed here once.
//
// Every rule is carried over unchanged:
//   - lstat before open, so a symlink is refused rather than followed;
//   - realpath containment, and the parent must be the directory we meant, so
//     `../` in a name cannot climb out;
//   - O_NOFOLLOW on the open itself, which closes the window between the lstat
//     and the open;
//   - a byte ceiling, because the caller decides what "too big to read" means
//     and the answer differs for markdown and for a sidecar.

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { dirname, join, sep } from 'node:path'

/** Markdown ceiling. A meeting record past this is not a meeting record. */
export const MAX_MEETING_BYTES = 10 * 1024 * 1024

export class UnsafeMeetingDirectoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeMeetingDirectoryError'
  }
}

export function isContained(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`)
}

/**
 * Realpath of an existing root, or null when it does not exist.
 *
 * `unsafe` builds the error thrown when the root is a symlink or not a
 * directory, so each caller can keep its own error contract: MeetingStore
 * throws a MeetingStoreError with a status and a code, and the imported library
 * throws its own.
 */
export function existingRootRealpath(
  root: string,
  unsafe: () => Error = () => new UnsafeMeetingDirectoryError(`Unsafe meeting directory: ${root}`),
): string | null {
  if (!existsSync(root)) return null
  const stat = lstatSync(root)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw unsafe()
  }
  return realpathSync(root)
}

export function safeDirectoryRealpath(path: string, parentReal: string): string | null {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null
    const real = realpathSync(path)
    return isContained(parentReal, real) && dirname(real) === parentReal ? real : null
  } catch {
    return null
  }
}

/**
 * Read a whole file inside a verified directory, or null.
 *
 * `maxBytes` defaults to the markdown ceiling. The imported library passes a
 * larger one for its JSON sidecars, which legitimately run to megabytes.
 */
export function safeReadFile(
  directory: string,
  directoryReal: string,
  filename: string,
  maxBytes: number = MAX_MEETING_BYTES,
): string | null {
  const filepath = join(directory, filename)
  let fd: number | null = null
  try {
    const linkStat = lstatSync(filepath)
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) return null
    const real = realpathSync(filepath)
    if (!isContained(directoryReal, real) || dirname(real) !== directoryReal) return null
    fd = openSync(filepath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > maxBytes) return null
    return readFileSync(fd, 'utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* already closed */ }
    }
  }
}

/** Read only the first `bytes`, with the same guards as safeReadFile.
 *
 *  Exists so a list can lift one field out of a sidecar without reading it
 *  whole: sidecars run to megabytes (1.3 MB for a 32-minute meeting) and would
 *  also trip the markdown ceiling. */
export function safeReadFileHead(
  directory: string,
  directoryReal: string,
  filename: string,
  bytes: number,
): string | null {
  const filepath = join(directory, filename)
  let fd: number | null = null
  try {
    const linkStat = lstatSync(filepath)
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) return null
    const real = realpathSync(filepath)
    if (!isContained(directoryReal, real) || dirname(real) !== directoryReal) return null
    fd = openSync(filepath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(fd)
    if (!stat.isFile()) return null
    const buffer = Buffer.alloc(Math.min(bytes, stat.size))
    if (buffer.length === 0) return ''
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* already closed */ }
    }
  }
}
