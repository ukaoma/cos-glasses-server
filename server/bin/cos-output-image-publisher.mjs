#!/usr/bin/env node

// Capability-scoped image publisher used by a single COS Glasses model run.
// It copies one already-local supported image artifact into the run's private inbox and
// appends only an opaque content id + generic provenance to the manifest.
// Source paths, URLs, and bytes never enter the manifest or stdout.

import { createHash, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, isAbsolute, join, sep } from 'node:path'

const RUN_DIR_PREFIX = 'cos-glasses-output-images-'
const ABSOLUTE_MAX_IMAGES = 5
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MANIFEST_MAX_BYTES = 64 * 1024
const PROVENANCE = new Set(['generated', 'research', 'email'])
const OUTPUT_ID_RE = /^o_[a-f0-9]{32}$/
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4))

function configuredMaxImages() {
  const parsed = Number(process.env.COS_OUTPUT_IMAGE_MAX)
  if (!Number.isInteger(parsed)) return ABSOLUTE_MAX_IMAGES
  return Math.max(0, Math.min(ABSOLUTE_MAX_IMAGES, parsed))
}

function fail(message) {
  throw new Error(message)
}

function sleep(ms) {
  Atomics.wait(WAIT_ARRAY, 0, 0, ms)
}

function isSupportedMagic(bytes) {
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const png = bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  const webp = bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  let isoImage = false
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const declaredBoxSize = bytes.readUInt32BE(0)
    const boxEnd = Math.min(bytes.length, declaredBoxSize >= 16 ? declaredBoxSize : 16, 256)
    const brands = [bytes.toString('ascii', 8, 12)]
    for (let offset = 16; offset + 4 <= boxEnd; offset += 4) brands.push(bytes.toString('ascii', offset, offset + 4))
    isoImage = brands.some((brand) => [
      'avif', 'avis',
      'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis',
      'mif1', 'msf1',
    ].includes(brand))
  }
  return jpeg || png || webp || isoImage
}

function outputId(bytes) {
  // Provenance is presentation metadata, not identity. The first publication
  // of identical bytes wins regardless of how that image was later reused.
  const digest = createHash('sha256').update(bytes).digest('hex')
  return `o_${digest.slice(0, 32)}`
}

function validateItemsDir(runDir, expected) {
  const itemsDir = join(runDir, 'items')
  let fd = -1
  try {
    const before = lstatSync(itemsDir)
    if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o700) {
      fail('Publisher items directory is unavailable.')
    }
    if (typeof process.getuid === 'function' && before.uid !== process.getuid()) {
      fail('Publisher items directory is unavailable.')
    }
    const real = realpathSync(itemsDir)
    if (real !== itemsDir || !real.startsWith(`${runDir}${sep}`)) {
      fail('Publisher items directory is unavailable.')
    }
    fd = openSync(itemsDir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    const after = lstatSync(itemsDir)
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino ||
        after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino ||
        (opened.mode & 0o777) !== 0o700 ||
        (typeof process.getuid === 'function' && opened.uid !== process.getuid())) {
      fail('Publisher items directory is unavailable.')
    }
    if (expected && (opened.dev !== expected.dev || opened.ino !== expected.ino)) {
      fail('Publisher items directory is unavailable.')
    }
    return { path: itemsDir, dev: opened.dev, ino: opened.ino }
  } catch (err) {
    if (err instanceof Error && err.message === 'Publisher items directory is unavailable.') throw err
    fail('Publisher items directory is unavailable.')
  } finally {
    if (fd >= 0) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
  }
}

function readManifestIds(path) {
  if (!existsSync(path)) return new Set()
  let contents = ''
  let fd = -1
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MANIFEST_MAX_BYTES) {
      fail('Publisher manifest is unavailable.')
    }
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    contents = readFileSync(fd, 'utf8')
  } catch {
    fail('Publisher manifest is unavailable.')
  } finally {
    if (fd >= 0) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
  }
  const ids = new Set()
  for (const line of contents.split('\n')) {
    if (!line || line.length > 512) continue
    try {
      const item = JSON.parse(line)
      if (item?.v === 1 && item?.type === 'publish' && OUTPUT_ID_RE.test(item.id) && PROVENANCE.has(item.provenance)) {
        ids.add(item.id)
      }
    } catch {
      // A process can die between append bytes. A malformed tail never makes
      // a valid earlier publication disappear.
    }
  }
  return ids
}

function acquireLock(runDir) {
  const lockDir = join(runDir, '.publish.lock')
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir, { mode: 0o700 })
      return lockDir
    } catch (err) {
      if (err?.code !== 'EEXIST') fail('Publisher lock is unavailable.')
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > 30_000) {
          rmSync(lockDir, { recursive: true, force: true })
          continue
        }
      } catch {
        // The owner may have released it between the failed mkdir and stat.
      }
      sleep(25)
    }
  }
  fail('Publisher is busy; try once more.')
}

function readCapability(runDir, supplied) {
  if (!supplied || Buffer.byteLength(supplied) > 256) fail('Publisher capability is unavailable.')
  let expected = ''
  try {
    expected = readFileSync(join(runDir, '.capability'), 'utf8').trim()
  } catch {
    fail('Publisher capability is unavailable.')
  }
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) fail('Publisher capability is unavailable.')
}

function validateRunDir(rawDir) {
  if (!rawDir || !isAbsolute(rawDir)) fail('Publisher directory is unavailable.')
  let runDir
  let tmpRoot
  try {
    runDir = realpathSync(rawDir)
    tmpRoot = realpathSync('/tmp')
    const stat = lstatSync(runDir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Publisher directory is unavailable.')
    if ((stat.mode & 0o777) !== 0o700) fail('Publisher directory is not private.')
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('Publisher directory is unavailable.')
  } catch {
    fail('Publisher directory is unavailable.')
  }
  if (!runDir.startsWith(`${tmpRoot}${sep}`) || !basename(runDir).startsWith(RUN_DIR_PREFIX)) {
    fail('Publisher directory is unavailable.')
  }
  return runDir
}

function readLocalImage(source) {
  if (!source || !isAbsolute(source) || /^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith('//')) {
    fail('Publisher accepts an absolute local file, never a URL.')
  }
  let fd = -1
  try {
    const before = lstatSync(source)
    if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > MAX_IMAGE_BYTES) {
      fail('Source must be a supported local image no larger than 16 MiB.')
    }
    fd = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.size !== before.size || opened.ino !== before.ino || opened.dev !== before.dev) {
      fail('Source image changed while publishing.')
    }
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (after.size !== opened.size || after.ino !== opened.ino || after.dev !== opened.dev) {
      fail('Source image changed while publishing.')
    }
    if (!isSupportedMagic(bytes)) fail('Only JPEG, PNG, WebP, HEIC, HEIF, or AVIF images can be published.')
    return bytes
  } catch (err) {
    if (typeof err?.message === 'string' && err.message.startsWith('Source ')) throw err
    fail('Source image is unavailable.')
  } finally {
    if (fd >= 0) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
  }
}

function main() {
  const [provenance, source, ...extra] = process.argv.slice(2)
  if (!PROVENANCE.has(provenance) || !source || extra.length > 0) {
    fail('Usage: publisher <generated|research|email> <absolute-local-image>')
  }

  const runDir = validateRunDir(process.env.COS_OUTPUT_IMAGE_DIR)
  readCapability(runDir, process.env.COS_OUTPUT_IMAGE_TOKEN)
  const bytes = readLocalImage(source)
  const id = outputId(bytes)
  const maxImages = configuredMaxImages()
  const manifestPath = join(runDir, 'manifest.jsonl')
  const items = validateItemsDir(runDir)
  const itemsDir = items.path
  const lockDir = acquireLock(runDir)

  try {
    const published = readManifestIds(manifestPath)
    if (!published.has(id) && published.size >= maxImages) {
      fail(maxImages === 0 ? 'This response cannot accept output images.' : `This response already has ${maxImages} published images.`)
    }

    const target = join(itemsDir, `${id}.img`)
    if (!existsSync(target)) {
      const tmp = join(itemsDir, `.${id}-${process.pid}.tmp`)
      let fd = -1
      try {
        validateItemsDir(runDir, items)
        fd = openSync(
          tmp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        )
        const opened = fstatSync(fd)
        if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600) {
          fail('Publisher items directory is unavailable.')
        }
        // If the path was swapped between validation and open, detect that
        // before writing any source bytes to the selected directory.
        validateItemsDir(runDir, items)
        writeSync(fd, bytes)
        fsyncSync(fd)
        closeSync(fd)
        fd = -1
        validateItemsDir(runDir, items)
        renameSync(tmp, target)
        validateItemsDir(runDir, items)
      } finally {
        if (fd >= 0) {
          try { closeSync(fd) } catch { /* best effort */ }
        }
        try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
      }
    }

    if (!published.has(id)) {
      const line = `${JSON.stringify({ v: 1, type: 'publish', id, provenance })}\n`
      const fd = openSync(
        manifestPath,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
        0o600,
      )
      try {
        const stat = fstatSync(fd)
        if (!stat.isFile()) fail('Publisher manifest is unavailable.')
        writeSync(fd, line)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      chmodSync(manifestPath, 0o600)
    }
    process.stdout.write(`Published ${provenance} image.\n`)
  } finally {
    rmSync(lockDir, { recursive: true, force: true })
  }
}

try {
  main()
} catch (err) {
  const message = err instanceof Error ? err.message : 'Image publication failed.'
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}
