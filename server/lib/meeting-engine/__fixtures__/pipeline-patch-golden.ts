/**
 * The one generator behind `pipeline-patch.golden.json`, and the one reader of it.
 *
 * WHY IT LIVES IN `__fixtures__`. This directory is excluded from the published tarball
 * (`package.json` `files`), so the generator ships with the repo and never with the product.
 * The golden test imports from here rather than defining the scene itself, so "regenerate"
 * and "compare" can never drift into two different renders.
 *
 * REGENERATE (only together with a deliberate output change, in the same commit):
 *   node --import tsx/esm server/lib/meeting-engine/__fixtures__/pipeline-patch-golden.ts --write
 *
 * The COS pipeline keeps its own copy of this file as the shape it must splice. Regenerate
 * both from the same sha.
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderPipelinePatch } from '../render.js'
import { GOLDEN_PATCH_ACTION_ID, GOLDEN_PATCH_TZ, goldenPatchScene } from './synthetic.js'

export const GOLDEN_PATCH_PATH = fileURLToPath(new URL('./pipeline-patch.golden.json', import.meta.url))

/**
 * The exact bytes the golden file holds: pretty JSON, one trailing newline.
 *
 * TIME ZONE. `formatClock` reads LOCAL time, so the caller pins `process.env.TZ` to
 * `GOLDEN_PATCH_TZ` around this call. Node re-reads TZ on the next Date operation.
 */
export function renderGoldenPatchBytes(): string {
  const scene = goldenPatchScene()
  const patch = renderPipelinePatch({
    actionId: GOLDEN_PATCH_ACTION_ID,
    tier: 'auto',
    primary: scene.primary,
    alternates: [scene.alternate],
    captures: [scene.capture],
    evidence: { k1: 48, k2: 6 },
    coarseOffsetMsBySession: scene.coarseOffsetMsBySession,
    sidecarRelPathBySession: scene.sidecarRelPathBySession,
  })
  return `${JSON.stringify(patch, null, 2)}\n`
}

/** Render under the pinned clock and restore whatever the caller had. */
export function renderGoldenPatchBytesPinned(): string {
  const previous = process.env.TZ
  process.env.TZ = GOLDEN_PATCH_TZ
  try {
    return renderGoldenPatchBytes()
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--write')) {
    process.stdout.write(renderGoldenPatchBytesPinned())
  } else {
    writeFileSync(GOLDEN_PATCH_PATH, renderGoldenPatchBytesPinned(), 'utf8')
    process.stdout.write(`wrote ${GOLDEN_PATCH_PATH}\n`)
  }
}
