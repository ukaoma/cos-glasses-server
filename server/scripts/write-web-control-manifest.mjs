#!/usr/bin/env node
// 6.99.31 (Phase 6): the pack step. Writes server/web-control/.manifest.json, the sha256 of every
// file COS Control Web ships (every regular non-dot file except *.test.ts, which never ship). With
// COS_WEB_CONTROL_INTEGRITY on, the server serves /control only while the files match it
// (server/lib/web-control-integrity.ts, whose computeWebControlManifest must agree with this byte
// for byte; web-control-integrity.test.ts pins that). Run by `npm pack` / `npm publish` (prepack).
// Writes one file, prints its path and the file count. Never reads anything outside web-control/.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function manifestFor(dir) {
  const files = {}
  const walk = (d, base) => {
    let names
    try { names = readdirSync(d) } catch { return }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue
      const file = join(d, name)
      let st
      try { st = statSync(file) } catch { continue }
      const urlPath = `${base}/${name}`
      if (st.isDirectory()) walk(file, urlPath)
      else if (st.isFile() && !name.endsWith('.test.ts')) files[urlPath] = createHash('sha256').update(readFileSync(file)).digest('hex')
    }
  }
  walk(dir, '')
  return { v: 1, algorithm: 'sha256', files }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'web-control')
  const manifest = manifestFor(dir)
  const out = join(dir, '.manifest.json')
  const tmp = `${out}.tmp`
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  renameSync(tmp, out)
  console.log(`[web-control-manifest] ${out} (${Object.keys(manifest.files).length} files)`)
}
