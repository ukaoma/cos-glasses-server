import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isMediaProcessingReady } from './image-safety.js'
import { MediaStore } from './media-store.js'
import {
  _touchRunOutputImageDirForTests,
  cleanupStaleRunOutputImageDirs,
  collectRunOutputImagesBounded,
  createRunOutputImagePublisher,
  isRunOutputImagePublisherCommand,
  RUN_OUTPUT_IMAGE_DIR_PREFIX,
} from './run-output-images.js'

describe('bounded run output image collection', () => {
  it('returns normal collections unchanged', async () => {
    const refs: [] = []
    await expect(collectRunOutputImagesBounded({ collect: async () => refs }, { timeoutMs: 50 }))
      .resolves.toBe(refs)
  })

  it('rejects a stalled collection at its post-answer deadline', async () => {
    const stalled = { collect: () => new Promise<never>(() => {}) }
    await expect(collectRunOutputImagesBounded(stalled, { timeoutMs: 10 }))
      .rejects.toMatchObject({ code: 'output_image_collection_timeout' })
  })

  it('rejects promptly when durable-job ownership aborts the tail', async () => {
    const controller = new AbortController()
    const stalled = { collect: () => new Promise<never>(() => {}) }
    const pending = collectRunOutputImagesBounded(stalled, { signal: controller.signal, timeoutMs: 1_000 })
    const reason = Object.assign(new Error('postprocess timeout'), { code: 'postprocess_timeout' })
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })
})

let ffmpegAvailable = false
let jpeg: Buffer
let png: Buffer
let webp: Buffer | null = null
const roots: string[] = []

function newRoot(): string {
  const root = mkdtempSync('/tmp/cos-output-images-test-')
  roots.push(root)
  return root
}

function image(path: string, bytes: Buffer): string {
  writeFileSync(path, bytes, { mode: 0o600 })
  return path
}

function publish(
  publisher: ReturnType<typeof createRunOutputImagePublisher>,
  provenance: 'generated' | 'research' | 'email',
  path: string,
) {
  return spawnSync(publisher.env.COS_OUTPUT_IMAGE_PUBLISHER, [provenance, path], {
    env: { ...process.env, ...publisher.env },
    encoding: 'utf8',
  })
}

class SelectiveAssociationFailureStore extends MediaStore {
  readonly associationAttempts = new Map<string, number>()
  readonly permanentlyFailedIds = new Set<string>()

  override async associate(
    ids: string[],
    target: { sessionId?: string; runId?: string; globalMsgNum?: number },
  ): Promise<void> {
    const id = ids[0]
    this.associationAttempts.set(id, (this.associationAttempts.get(id) ?? 0) + 1)
    if (this.getRef(id)?.label === 'Generated image') {
      this.permanentlyFailedIds.add(id)
      throw new Error('injected permanent association failure')
    }
    await super.associate(ids, target)
  }
}

beforeAll(async () => {
  ffmpegAvailable = await isMediaProcessingReady()
  if (!ffmpegAvailable) return
  jpeg = execFileSync('ffmpeg', [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x64',
    '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', '-',
  ], { maxBuffer: 4 * 1024 * 1024 })
  png = execFileSync('ffmpeg', [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=80x80',
    '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', '-',
  ], { maxBuffer: 4 * 1024 * 1024 })
  try {
    webp = execFileSync('ffmpeg', [
      '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=purple:s=72x48',
      '-frames:v', '1', '-c:v', 'libwebp', '-f', 'webp', '-',
    ], { maxBuffer: 4 * 1024 * 1024 })
  } catch {
    // The release path does not depend on ffmpeg having a WebP encoder. Other
    // environments still exercise WebP through the trusted decoder in QA.
    webp = null
  }
})

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('run output image publisher', () => {
  it('creates a unique private run dir and exposes bridge-safe integration fields', () => {
    const root = newRoot()
    const store = new MediaStore(join(root, 'media'))
    const a = createRunOutputImagePublisher({ sessionId: 's1', mediaStore: store, tempRoot: root })
    const b = createRunOutputImagePublisher({ sessionId: 's2', mediaStore: store, tempRoot: root })
    expect(a.env.COS_OUTPUT_IMAGE_DIR).not.toBe(b.env.COS_OUTPUT_IMAGE_DIR)
    expect(a.env.COS_OUTPUT_IMAGE_DIR).toContain(RUN_OUTPUT_IMAGE_DIR_PREFIX)
    expect(lstatSync(a.env.COS_OUTPUT_IMAGE_DIR).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(a.env.COS_OUTPUT_IMAGE_DIR, 'manifest.jsonl')).mode & 0o777).toBe(0o600)
    expect(a.promptInstructions).toContain('$COS_OUTPUT_IMAGE_PUBLISHER')
    expect(a.promptInstructions).toContain('Never pass a URL')
    expect(a.promptInstructions).toContain('local image artifact')
    expect(a.claudeAllowedTool).toBe('Bash($COS_OUTPUT_IMAGE_PUBLISHER *)')
    expect(a.stats).toEqual({ published: 0, attached: 0, rejected: 0 })
    expect(isRunOutputImagePublisherCommand(`"$COS_OUTPUT_IMAGE_PUBLISHER" generated /tmp/a.png`)).toBe(true)
    expect(isRunOutputImagePublisherCommand('git status')).toBe(false)
    a.cleanup()
    a.cleanup()
    b.cleanup()
  })

  it('publishes JPEG/PNG with opaque generic manifest metadata, ingests and associates refs', async () => {
    if (!ffmpegAvailable) return
    const root = newRoot()
    const store = new MediaStore(join(root, 'media'))
    const publisher = createRunOutputImagePublisher({
      sessionId: 'sess-output',
      globalMsgNum: 784,
      runId: 'run-output',
      mediaStore: store,
      tempRoot: root,
    })
    const sourceA = image(join(root, 'private-generated-name.jpg'), jpeg)
    const sourceB = image(join(root, 'private-research-name.png'), png)
    expect(publish(publisher, 'generated', sourceA).status).toBe(0)
    expect(publish(publisher, 'research', sourceB).status).toBe(0)

    const manifest = readFileSync(join(publisher.env.COS_OUTPUT_IMAGE_DIR, 'manifest.jsonl'), 'utf8')
    expect(manifest).not.toContain(sourceA)
    expect(manifest).not.toContain(sourceB)
    expect(manifest).not.toContain('http')
    expect(manifest).not.toContain(jpeg.toString('base64').slice(0, 30))
    for (const line of manifest.trim().split('\n')) {
      expect(Object.keys(JSON.parse(line)).sort()).toEqual(['id', 'provenance', 'type', 'v'])
    }

    const refs = await publisher.collect()
    expect(refs).toHaveLength(2)
    expect(refs.map((ref) => ref.kind)).toEqual(['generated_visual', 'generated_visual'])
    expect(refs.map((ref) => ref.label)).toEqual(['Generated image', 'Research image'])
    expect(publisher.stats).toEqual({ published: 2, attached: 2, rejected: 0 })
    for (const ref of refs) {
      const record = store.getRecord(ref.id)!
      expect(record.lifecycle).toBe('associated')
      expect(record.sessionId).toBe('sess-output')
      expect(record.globalMsgNum).toBe(784)
      expect(record.runId).toBe('run-output')
    }

    const replay = await publisher.collect()
    expect(replay.map((ref) => ref.id)).toEqual(refs.map((ref) => ref.id))
    expect(store.stats().total).toBe(2)
    publisher.cleanup()
    expect(existsSync(publisher.env.COS_OUTPUT_IMAGE_DIR)).toBe(false)
  })

  it('deduplicates identical bytes across provenance and preserves the first label', async () => {
    if (!ffmpegAvailable) return
    const root = newRoot()
    const store = new MediaStore(join(root, 'media'))
    const publisher = createRunOutputImagePublisher({
      sessionId: 'sess-provenance-dedupe',
      mediaStore: store,
      tempRoot: root,
    })
    const source = image(join(root, 'same.jpg'), jpeg)
    expect(publish(publisher, 'generated', source).status).toBe(0)
    expect(publish(publisher, 'email', source).status).toBe(0)
    const lines = readFileSync(join(publisher.env.COS_OUTPUT_IMAGE_DIR, 'manifest.jsonl'), 'utf8')
      .trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).provenance).toBe('generated')
    const refs = await publisher.collect()
    expect(refs).toHaveLength(1)
    expect(refs[0].label).toBe('Generated image')
    expect(store.stats().total).toBe(1)
    expect(publisher.stats).toEqual({ published: 1, attached: 1, rejected: 0 })
    publisher.cleanup()
  })

  it('retries one association failure, keeps other entries, and deletes the unowned ingest', async () => {
    if (!ffmpegAvailable) return
    const root = newRoot()
    const store = new SelectiveAssociationFailureStore(join(root, 'media'))
    const publisher = createRunOutputImagePublisher({
      sessionId: 'sess-partial-association',
      runId: 'run-partial-association',
      mediaStore: store,
      tempRoot: root,
    })
    expect(publish(publisher, 'generated', image(join(root, 'will-fail.jpg'), jpeg)).status).toBe(0)
    expect(publish(publisher, 'research', image(join(root, 'will-pass.png'), png)).status).toBe(0)

    const refs = await publisher.collect()
    expect(refs).toHaveLength(1)
    expect(refs[0].label).toBe('Research image')
    expect(store.getRecord(refs[0].id)?.lifecycle).toBe('associated')
    expect(store.getRecord(refs[0].id)?.runId).toBe('run-partial-association')
    expect(publisher.stats).toEqual({ published: 2, attached: 1, rejected: 1 })
    expect(store.permanentlyFailedIds.size).toBe(1)
    const [failedId] = [...store.permanentlyFailedIds]
    expect(store.associationAttempts.get(failedId)).toBe(2)
    expect(store.getRecord(failedId)?.lifecycle).toBe('deleted')
    expect(store.getContent(failedId).status).toBe('not_found')
    publisher.cleanup()
  })

  it('deduplicates helper replays, rejects URLs/unsupported bytes, and caps at five', () => {
    if (!ffmpegAvailable) return
    const root = newRoot()
    const store = new MediaStore(join(root, 'media'))
    const publisher = createRunOutputImagePublisher({ sessionId: 'sess-cap', mediaStore: store, tempRoot: root })
    const original = image(join(root, 'one.jpg'), jpeg)
    expect(publish(publisher, 'generated', original).status).toBe(0)
    expect(publish(publisher, 'generated', original).status).toBe(0)
    let manifest = readFileSync(join(publisher.env.COS_OUTPUT_IMAGE_DIR, 'manifest.jsonl'), 'utf8').trim().split('\n')
    expect(manifest).toHaveLength(1)

    const url = publish(publisher, 'research', 'https://example.com/image.png')
    expect(url.status).not.toBe(0)
    expect(url.stderr).not.toContain('example.com')
    const svg = image(join(root, 'bad.svg'), Buffer.from('<svg/>'))
    expect(publish(publisher, 'research', svg).status).not.toBe(0)

    // Provenance is not identity. First publication wins and later reuse of
    // identical bytes consumes neither another manifest row nor another slot.
    expect(publish(publisher, 'research', original).status).toBe(0)
    expect(publish(publisher, 'email', original).status).toBe(0)
    manifest = readFileSync(join(publisher.env.COS_OUTPUT_IMAGE_DIR, 'manifest.jsonl'), 'utf8').trim().split('\n')
    expect(manifest).toHaveLength(1)
    expect(JSON.parse(manifest[0]).provenance).toBe('generated')

    // Four byte-distinct, magic-valid images fill the remaining slots.
    for (let index = 1; index <= 4; index++) {
      const distinct = Buffer.concat([png, Buffer.from([index])])
      expect(publish(publisher, 'generated', image(join(root, `slot-${index}.png`), distinct)).status).toBe(0)
    }
    const sixth = publish(
      publisher,
      'research',
      image(join(root, 'six.png'), Buffer.concat([png, Buffer.from([99])])),
    )
    expect(sixth.status).not.toBe(0)
    // A cap rejection occurs after lock acquisition. It must still release
    // the lock so a replay of an existing publication succeeds immediately.
    expect(existsSync(join(publisher.env.COS_OUTPUT_IMAGE_DIR, '.publish.lock'))).toBe(false)
    expect(publish(publisher, 'generated', original).status).toBe(0)
    manifest = readFileSync(join(publisher.env.COS_OUTPUT_IMAGE_DIR, 'manifest.jsonl'), 'utf8').trim().split('\n')
    expect(manifest).toHaveLength(5)
    publisher.cleanup()
  })

  it('accepts and ingests realistic local artifacts above 2 MiB and WebP, while enforcing 16 MiB', async () => {
    if (!ffmpegAvailable) return
    const root = newRoot()
    const store = new MediaStore(join(root, 'media'))
    const publisher = createRunOutputImagePublisher({
      sessionId: 'sess-artifact-formats',
      maxImages: 3,
      mediaStore: store,
      tempRoot: root,
    })
    const overLegacyLimit = Buffer.concat([
      jpeg,
      Buffer.alloc((2 * 1024 * 1024 + 1) - jpeg.length),
    ])
    expect(publish(
      publisher,
      'generated',
      image(join(root, 'large-local.jpg'), overLegacyLimit),
    ).status).toBe(0)
    if (webp) {
      expect(publish(
        publisher,
        'research',
        image(join(root, 'research.webp'), webp),
      ).status).toBe(0)
    }
    const overHardLimit = Buffer.concat([
      jpeg,
      Buffer.alloc((16 * 1024 * 1024 + 1) - jpeg.length),
    ])
    expect(publish(
      publisher,
      'email',
      image(join(root, 'too-large.jpg'), overHardLimit),
    ).status).not.toBe(0)
    const refs = await publisher.collect()
    expect(refs.map((ref) => ref.label)).toEqual(
      webp ? ['Generated image', 'Research image'] : ['Generated image'],
    )
    expect(publisher.stats).toEqual({
      published: webp ? 2 : 1,
      attached: webp ? 2 : 1,
      rejected: 0,
    })
    publisher.cleanup()
  })

  it('clamps remaining output capacity and enforces it in helper and collector', async () => {
    if (!ffmpegAvailable) return
    const root = newRoot()
    const store = new MediaStore(join(root, 'media'))
    const publisher = createRunOutputImagePublisher({
      sessionId: 'sess-remaining',
      maxImages: 1,
      mediaStore: store,
      tempRoot: root,
    })
    expect(publisher.promptInstructions).toContain('Publish at most 1.')
    expect(publisher.env.COS_OUTPUT_IMAGE_MAX).toBe('1')
    expect(publish(publisher, 'generated', image(join(root, 'allowed.jpg'), jpeg)).status).toBe(0)
    expect(publish(publisher, 'research', image(join(root, 'blocked.png'), png)).status).not.toBe(0)
    expect(await publisher.collect()).toHaveLength(1)
    publisher.cleanup()

    const none = createRunOutputImagePublisher({
      sessionId: 'sess-none',
      maxImages: -10,
      mediaStore: store,
      tempRoot: root,
    })
    expect(none.env.COS_OUTPUT_IMAGE_MAX).toBe('0')
    expect(publish(none, 'generated', image(join(root, 'none.jpg'), jpeg)).status).not.toBe(0)
    expect(existsSync(join(none.env.COS_OUTPUT_IMAGE_DIR, '.publish.lock'))).toBe(false)
    expect(await none.collect()).toEqual([])
    none.cleanup()
  })

  it('ignores manifest lines with paths/URLs and rejects content-id tampering', async () => {
    if (!ffmpegAvailable) return
    const root = newRoot()
    const store = new MediaStore(join(root, 'media'))
    const publisher = createRunOutputImagePublisher({ sessionId: 'sess-tamper', mediaStore: store, tempRoot: root })
    const source = image(join(root, 'safe.jpg'), jpeg)
    expect(publish(publisher, 'email', source).status).toBe(0)
    const manifestPath = join(publisher.env.COS_OUTPUT_IMAGE_DIR, 'manifest.jsonl')
    const valid = JSON.parse(readFileSync(manifestPath, 'utf8').trim())
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...valid, url: 'https://forbidden.invalid' })}\n` +
      `${JSON.stringify({ v: 1, type: 'publish', id: `o_${'a'.repeat(32)}`, provenance: 'generated' })}\n`,
      { flag: 'a' },
    )
    const refs = await publisher.collect()
    expect(refs).toHaveLength(1)
    expect(refs[0].label).toBe('Email image')
    publisher.cleanup()
  })

  it('never follows a replaced manifest or source symlink', () => {
    if (!ffmpegAvailable) return
    const root = newRoot()
    const store = new MediaStore(join(root, 'media'))
    const publisher = createRunOutputImagePublisher({ sessionId: 'sess-links', mediaStore: store, tempRoot: root })
    const realSource = image(join(root, 'real.jpg'), jpeg)
    const linkedSource = join(root, 'linked.jpg')
    symlinkSync(realSource, linkedSource)
    expect(publish(publisher, 'generated', linkedSource).status).not.toBe(0)

    const manifest = join(publisher.env.COS_OUTPUT_IMAGE_DIR, 'manifest.jsonl')
    const outside = join(root, 'outside-manifest.txt')
    writeFileSync(outside, 'must-not-change')
    rmSync(manifest)
    symlinkSync(outside, manifest)
    expect(publish(publisher, 'generated', realSource).status).not.toBe(0)
    expect(readFileSync(outside, 'utf8')).toBe('must-not-change')
    publisher.cleanup()
  })

  it('rejects a replaced items directory without chmodding or writing outside', async () => {
    if (!ffmpegAvailable) return
    const root = newRoot()
    const store = new MediaStore(join(root, 'media'))
    const publisher = createRunOutputImagePublisher({ sessionId: 'sess-items-link', mediaStore: store, tempRoot: root })
    const source = image(join(root, 'safe-items.jpg'), jpeg)
    expect(publish(publisher, 'generated', source).status).toBe(0)

    const items = join(publisher.env.COS_OUTPUT_IMAGE_DIR, 'items')
    const outside = join(root, 'outside-items')
    mkdirSync(outside, { mode: 0o755 })
    const sentinel = join(outside, 'sentinel.txt')
    writeFileSync(sentinel, 'outside-must-not-change', { mode: 0o644 })
    const outsideMode = lstatSync(outside).mode & 0o777
    const outsideNames = readdirSync(outside)
    rmSync(items, { recursive: true, force: true })
    symlinkSync(outside, items)

    expect(publish(publisher, 'research', image(join(root, 'other-items.png'), png)).status).not.toBe(0)
    expect(await publisher.collect()).toEqual([])
    expect(publisher.stats).toEqual({ published: 1, attached: 0, rejected: 1 })
    expect(lstatSync(outside).mode & 0o777).toBe(outsideMode)
    expect(readdirSync(outside)).toEqual(outsideNames)
    expect(readFileSync(sentinel, 'utf8')).toBe('outside-must-not-change')
    publisher.cleanup()
  })

  it('cleans stale private run dirs without following symlinks or removing active dirs', () => {
    const root = newRoot()
    const old = join(root, `${RUN_OUTPUT_IMAGE_DIR_PREFIX}old`)
    const fresh = join(root, `${RUN_OUTPUT_IMAGE_DIR_PREFIX}fresh`)
    const outside = join(root, 'outside')
    mkdirSync(old, { mode: 0o700 })
    mkdirSync(fresh, { mode: 0o700 })
    mkdirSync(outside, { mode: 0o700 })
    const link = join(root, `${RUN_OUTPUT_IMAGE_DIR_PREFIX}link`)
    symlinkSync(outside, link)
    const now = Date.now()
    _touchRunOutputImageDirForTests(old, now - 10_000)
    _touchRunOutputImageDirForTests(fresh, now)
    expect(cleanupStaleRunOutputImageDirs({ tempRoot: root, now, staleAfterMs: 5_000 })).toBe(1)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(link)).toBe(true)
    expect(existsSync(outside)).toBe(true)
  })

  it('cleanup removes uncollected bytes after an error path', () => {
    const root = newRoot()
    const store = new MediaStore(join(root, 'media'))
    const publisher = createRunOutputImagePublisher({ sessionId: 'sess-error', mediaStore: store, tempRoot: root })
    const runDir = publisher.env.COS_OUTPUT_IMAGE_DIR
    chmodSync(runDir, 0o700)
    publisher.cleanup()
    expect(existsSync(runDir)).toBe(false)
  })
})
