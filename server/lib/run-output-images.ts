// Run-scoped output image publishing foundation (Release C).
//
// A model process receives only a capability-scoped executable + private env.
// The executable copies already-local image artifacts into a unique 0700 /tmp
// inbox and appends an opaque id + generic provenance to JSONL. Once the model
// settles, the bridge calls collect(): bytes pass through MediaStore.ingestOutputImage
// (the single image-safety/normalization boundary), refs are associated with
// the run's COS session/message, and only public MediaAttachmentRef objects
// leave this module. cleanup() removes all publisher scratch data on either
// success or error.

import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import {
  MAX_ATTACHMENTS_PER_PROMPT,
  type MediaAttachmentRef,
} from '../../shared/media-attachment.js'
import { MAX_OUTPUT_ARTIFACT_BYTES } from './image-safety.js'
import { getMediaStore, type MediaStore } from './media-store.js'

export type OutputImageProvenance = 'generated' | 'research' | 'email'

export interface RunOutputImageTarget {
  sessionId: string
  globalMsgNum?: number
  runId?: string
}

export interface CreateRunOutputImagePublisherOptions extends RunOutputImageTarget {
  mediaStore?: MediaStore
  /** Remaining attachment capacity after request-side photos; clamped 0..5. */
  maxImages?: number
  /** Test-only/custom parent. It must remain beneath /tmp. */
  tempRoot?: string
}

export interface RunOutputImagePublisher {
  /** Append to the model prompt; contains no capability, directory, or path. */
  readonly promptInstructions: string
  /** Merge into the spawned CLI environment. Never serialize this object. */
  readonly env: Readonly<Record<string, string>>
  /** Append to Claude CLI's comma-delimited --allowedTools value. */
  readonly claudeAllowedTool: string
  /** Private per-run directory that Codex may receive through --add-dir.
   *  Server-internal only: never serialize this path to a client or ledger. */
  readonly writableDirectory: string
  /** Ingest + associate newly published images; safe to call/replay. */
  collect(): Promise<MediaAttachmentRef[]>
  /** Safe aggregate from the most recent completed collect; no paths/ids. */
  readonly stats: Readonly<RunOutputImageCollectionStats>
  /** Remove the private run directory. Idempotent; call on every terminal path. */
  cleanup(): void
}

export interface RunOutputImageCollectionStats {
  /** Valid, unique manifest publications considered by the collector. */
  published: number
  /** Publications durably associated with the target message/run. */
  attached: number
  /** Publications rejected during byte validation, ingest, or association. */
  rejected: number
}

export const RUN_OUTPUT_IMAGE_DIR_PREFIX = 'cos-glasses-output-images-'
export const RUN_OUTPUT_IMAGE_STALE_MS = 2 * 60 * 60_000
export const RUN_OUTPUT_IMAGE_COLLECTION_TIMEOUT_MS = 2 * 60_000
const MANIFEST_MAX_BYTES = 64 * 1024
export const RUN_OUTPUT_IMAGE_COLLECTION_CONCURRENCY = 2
const ASSOCIATION_ATTEMPTS = 2
const OUTPUT_ID_RE = /^o_[a-f0-9]{32}$/
const PROVENANCE = new Set<OutputImageProvenance>(['generated', 'research', 'email'])
const LABELS: Record<OutputImageProvenance, string> = {
  generated: 'Generated image',
  research: 'Research image',
  email: 'Email image',
}
const HELPER_PATH = resolve(import.meta.dirname, '..', 'bin', 'cos-output-image-publisher.mjs')

/**
 * Keep answer post-processing bounded independently of provider generation.
 * The answer is already durable when bridges call this helper, so an image
 * collector stall must not retain the session lease or strand finalization.
 */
export async function collectRunOutputImagesBounded(
  publisher: Pick<RunOutputImagePublisher, 'collect'>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<MediaAttachmentRef[]> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? RUN_OUTPUT_IMAGE_COLLECTION_TIMEOUT_MS)
  const signal = options.signal
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error('Output image collection aborted.'), { code: 'output_image_collection_aborted' })
  }

  let timer: NodeJS.Timeout | undefined
  let abortHandler: (() => void) | undefined
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(
        new Error('Output image collection exceeded its post-answer deadline.'),
        { code: 'output_image_collection_timeout' },
      ))
    }, timeoutMs)
    timer.unref?.()
    if (signal) {
      abortHandler = () => reject(signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error('Output image collection aborted.'), { code: 'output_image_collection_aborted' }))
      signal.addEventListener('abort', abortHandler, { once: true })
    }
  })

  try {
    return await Promise.race([publisher.collect(), guard])
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
  }
}

interface ManifestPublishEntry {
  v: 1
  type: 'publish'
  id: string
  provenance: OutputImageProvenance
}

function outputId(bytes: Buffer): string {
  // Provenance is display metadata, not content identity. The first publish of
  // identical bytes wins, so reusing one image for research + email consumes
  // one attachment slot and creates one durable media asset.
  const digest = createHash('sha256').update(bytes).digest('hex')
  return `o_${digest.slice(0, 32)}`
}

interface PrivateDirectoryIdentity {
  path: string
  dev: number
  ino: number
}

/** Validate the publisher inbox without ever chmodding an attacker-selected
 * path. Opening with O_NOFOLLOW + O_DIRECTORY and comparing inode/device on
 * both sides narrows the lstat/open race available in Node (which has no
 * openat). Call again around each file open to detect path replacement. */
function validateItemsDirectory(runDir: string, expected?: PrivateDirectoryIdentity): PrivateDirectoryIdentity {
  const path = join(runDir, 'items')
  let fd = -1
  try {
    const before = lstatSync(path)
    if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o700) {
      throw new Error('publisher items directory is invalid')
    }
    if (typeof process.getuid === 'function' && before.uid !== process.getuid()) {
      throw new Error('publisher items directory has the wrong owner')
    }
    const real = realpathSync(path)
    if (real !== path || !real.startsWith(`${runDir}${sep}`)) {
      throw new Error('publisher items directory escapes the run directory')
    }
    fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    const after = lstatSync(path)
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino ||
        after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino ||
        (opened.mode & 0o777) !== 0o700 ||
        (typeof process.getuid === 'function' && opened.uid !== process.getuid())) {
      throw new Error('publisher items directory changed during validation')
    }
    if (expected && (opened.dev !== expected.dev || opened.ino !== expected.ino)) {
      throw new Error('publisher items directory was replaced')
    }
    return { path, dev: opened.dev, ino: opened.ino }
  } finally {
    if (fd >= 0) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function safeTarget(options: CreateRunOutputImagePublisherOptions): RunOutputImageTarget {
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim().slice(0, 64) : ''
  if (!sessionId) throw new Error('run output image publisher requires a sessionId')
  const globalMsgNum = typeof options.globalMsgNum === 'number' && Number.isFinite(options.globalMsgNum) && options.globalMsgNum > 0
    ? Math.floor(options.globalMsgNum)
    : undefined
  const runId = typeof options.runId === 'string' && options.runId.trim()
    ? options.runId.trim().slice(0, 120)
    : undefined
  return { sessionId, ...(globalMsgNum ? { globalMsgNum } : {}), ...(runId ? { runId } : {}) }
}

function assertTempRoot(rawRoot: string): string {
  mkdirSync(rawRoot, { recursive: true, mode: 0o700 })
  const root = realpathSync(rawRoot)
  const tmp = realpathSync('/tmp')
  if (root !== tmp && !root.startsWith(`${tmp}${sep}`)) {
    throw new Error('run output image temp root must be beneath /tmp')
  }
  return root
}

function parseManifest(path: string, maxImages: number): ManifestPublishEntry[] {
  if (maxImages <= 0) return []
  if (!existsSync(path)) return []
  let fd = -1
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MANIFEST_MAX_BYTES) {
      console.warn('[output-images] publisher manifest rejected: invalid size/type')
      return []
    }
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const seen = new Set<string>()
    const entries: ManifestPublishEntry[] = []
    const lines = readFileSync(fd, 'utf8').split('\n')
    for (const line of lines) {
      if (!line || line.length > 512) continue
      try {
        const raw = JSON.parse(line) as Record<string, unknown>
        // Exact field allowlist: URLs, filesystem paths, bytes, and arbitrary
        // model-controlled metadata make the whole line invalid.
        if (Object.keys(raw).sort().join(',') !== 'id,provenance,type,v') continue
        if (raw.v !== 1 || raw.type !== 'publish' || !OUTPUT_ID_RE.test(String(raw.id))) continue
        if (typeof raw.provenance !== 'string' || !PROVENANCE.has(raw.provenance as OutputImageProvenance)) continue
        const id = String(raw.id)
        if (seen.has(id)) continue
        seen.add(id)
        entries.push({ v: 1, type: 'publish', id, provenance: raw.provenance as OutputImageProvenance })
        if (entries.length >= maxImages) break
      } catch {
        // Append-only JSONL can end in a partial line after abrupt process
        // termination. Preserve all complete earlier publications.
      }
    }
    return entries
  } catch (err) {
    console.warn('[output-images] publisher manifest unavailable:', err instanceof Error ? err.message : String(err))
    return []
  } finally {
    if (fd >= 0) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
  }
}

function readPublishedBytes(runDir: string, entry: ManifestPublishEntry): Buffer {
  const items = validateItemsDirectory(runDir)
  const path = join(items.path, `${entry.id}.img`)
  let fd = -1
  try {
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > MAX_OUTPUT_ARTIFACT_BYTES) {
      throw new Error('published image has invalid type or size')
    }
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    validateItemsDirectory(runDir, items)
    if (!opened.isFile() || opened.size !== before.size || opened.ino !== before.ino || opened.dev !== before.dev) {
      throw new Error('published image changed while collecting')
    }
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (after.size !== opened.size || after.ino !== opened.ino || after.dev !== opened.dev) {
      throw new Error('published image changed while collecting')
    }
    validateItemsDirectory(runDir, items)
    if (outputId(bytes) !== entry.id) {
      throw new Error('published image content id mismatch')
    }
    return bytes
  } finally {
    if (fd >= 0) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
  }
}

export function cleanupStaleRunOutputImageDirs(options: {
  tempRoot?: string
  now?: number
  staleAfterMs?: number
} = {}): number {
  const root = assertTempRoot(options.tempRoot ?? '/tmp')
  const now = options.now ?? Date.now()
  const staleAfterMs = options.staleAfterMs ?? RUN_OUTPUT_IMAGE_STALE_MS
  let removed = 0
  let names: string[] = []
  try { names = readdirSync(root) } catch { return 0 }
  for (const name of names) {
    if (!name.startsWith(RUN_OUTPUT_IMAGE_DIR_PREFIX)) continue
    const path = join(root, name)
    try {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue
      if (now - stat.mtimeMs <= staleAfterMs) continue
      rmSync(path, { recursive: true, force: true })
      removed++
    } catch { /* one inaccessible stale dir must not block startup */ }
  }
  return removed
}

/** Tool-activity guard for both bridges. Publisher commands contain a source
 * path by necessity, so their raw command input must not be mirrored to SSE. */
export function isRunOutputImagePublisherCommand(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  return raw.includes('$COS_OUTPUT_IMAGE_PUBLISHER') ||
    raw.includes(HELPER_PATH) ||
    raw.includes('cos-output-image-publisher.mjs')
}

export function createRunOutputImagePublisher(
  options: CreateRunOutputImagePublisherOptions,
): RunOutputImagePublisher {
  const target = safeTarget(options)
  const maxImages = typeof options.maxImages === 'number' && Number.isFinite(options.maxImages)
    ? Math.max(0, Math.min(MAX_ATTACHMENTS_PER_PROMPT, Math.floor(options.maxImages)))
    : MAX_ATTACHMENTS_PER_PROMPT
  const tempRoot = assertTempRoot(options.tempRoot ?? '/tmp')
  cleanupStaleRunOutputImageDirs({ tempRoot })

  const runDir = mkdtempSync(join(tempRoot, RUN_OUTPUT_IMAGE_DIR_PREFIX))
  chmodSync(runDir, 0o700)
  mkdirSync(join(runDir, 'items'), { mode: 0o700 })
  validateItemsDirectory(runDir)
  writeFileSync(join(runDir, 'manifest.jsonl'), '', { mode: 0o600 })
  const capability = randomBytes(24).toString('hex')
  writeFileSync(join(runDir, '.capability'), capability, { mode: 0o600 })

  const mediaStore = options.mediaStore ?? getMediaStore()
  const collected = new Map<string, MediaAttachmentRef>()
  let collectChain: Promise<MediaAttachmentRef[]> = Promise.resolve([])
  let lastStats: RunOutputImageCollectionStats = { published: 0, attached: 0, rejected: 0 }
  let closed = false

  const promptInstructions = [
    'OUTPUT IMAGES',
    'If an image you generated, selected during research, or explicitly used as an inbound/outbound email attachment for this request is materially useful in the answer, publish the already-local image artifact with:',
    '$COS_OUTPUT_IMAGE_PUBLISHER <generated|research|email> "<absolute-local-image-path>"',
    `Publish at most ${maxImages}. Never pass a URL, data URI, base64, or private/unrelated image.`,
    'Do not monitor or re-read Sent Mail just to find images; publish the selected local file during the original action.',
    'Do not include the local path in your response. A successful publisher call is enough; continue with the normal text answer.',
  ].join('\n')

  const collectOnce = async (): Promise<MediaAttachmentRef[]> => {
    if (closed) return [...collected.values()]
    const entries = parseManifest(join(runDir, 'manifest.jsonl'), maxImages)
    const results = await mapWithConcurrency(
      entries,
      RUN_OUTPUT_IMAGE_COLLECTION_CONCURRENCY,
      async (entry): Promise<MediaAttachmentRef | null> => {
        let ref = collected.get(entry.id)
        let newlyIngested = false
        if (!ref) {
          try {
            const bytes = readPublishedBytes(runDir, entry)
            // This is the only output-artifact ingestion boundary. It validates
            // supported image containers, enforces dimensions/megapixels, then
            // strips metadata and normalizes to the existing JPEG contract.
            ref = await mediaStore.ingestOutputImage({
              bytes,
              kind: 'generated_visual',
              label: LABELS[entry.provenance],
              sessionId: target.sessionId,
            })
            newlyIngested = true
          } catch (err) {
            console.warn(
              `[output-images] rejected ${entry.provenance} publication ${entry.id}:`,
              err instanceof Error ? err.message : String(err),
            )
            return null
          }
        }

        let associationError: unknown
        for (let attempt = 0; attempt < ASSOCIATION_ATTEMPTS; attempt++) {
          try {
            // Associate on every replay. MediaStore.associate is idempotent; a
            // second attempt repairs a transient index-write failure.
            await mediaStore.associate([ref.id], target)
            collected.set(entry.id, ref)
            return ref
          } catch (err) {
            associationError = err
          }
        }

        console.warn(
          `[output-images] could not associate ${entry.provenance} publication ${entry.id} after ${ASSOCIATION_ATTEMPTS} attempts:`,
          associationError instanceof Error ? associationError.message : String(associationError),
        )
        // An ingest that never became message-owned must not leak. This public
        // API refuses to delete an asset if an ambiguous failure actually
        // associated it, so cleanup is safe even after a post-commit throw.
        if (newlyIngested) {
          try {
            await mediaStore.deleteUnassociated(ref.id)
          } catch (err) {
            console.warn(
              `[output-images] could not release unassociated publication ${entry.id}:`,
              err instanceof Error ? err.message : String(err),
            )
          }
        }
        return null
      },
    )
    const attached = results.flatMap((ref) => ref ? [ref] : [])
    lastStats = {
      published: entries.length,
      attached: attached.length,
      rejected: entries.length - attached.length,
    }
    return attached
  }

  return {
    promptInstructions,
    writableDirectory: runDir,
    env: Object.freeze({
      COS_OUTPUT_IMAGE_PUBLISHER: HELPER_PATH,
      COS_OUTPUT_IMAGE_DIR: runDir,
      COS_OUTPUT_IMAGE_TOKEN: capability,
      COS_OUTPUT_IMAGE_MAX: String(maxImages),
    }),
    claudeAllowedTool: 'Bash($COS_OUTPUT_IMAGE_PUBLISHER *)',
    get stats() {
      return Object.freeze({ ...lastStats })
    },
    collect() {
      const run = collectChain.then(collectOnce, collectOnce)
      collectChain = run
      return run
    },
    cleanup() {
      if (closed) return
      closed = true
      try { rmSync(runDir, { recursive: true, force: true }) } catch { /* best effort */ }
    },
  }
}

// Retained only to make stale-directory tests deterministic without exposing
// a production mutation surface.
export const _touchRunOutputImageDirForTests = (path: string, atMs: number): void => {
  const at = new Date(atMs)
  utimesSync(path, at, at)
}
