#!/usr/bin/env node
// Read-only anchor check for every committed mutation gate (6.78.0, plan v3.1 G-anchors).
//
// A mutation gate edits one exact string per case. When a change moves or duplicates that
// string, the gate refuses the case (or, worse, a stale anchor silently stops covering the
// guard it was written for). This walks every server/scripts/*-mutation-gate.mjs, evaluates
// only its mutation table (the source up to the end of the `mutations` / `CASES` array, with
// imports stubbed: nothing is spawned, nothing is written), and checks that every find string
// of every case still occurs EXACTLY ONCE in its file.
//
// Usage: node server/scripts/gate-anchor-check.mjs [--root <checkout>] [--base <checkout>] [--files a.ts,b.ts] [--json]
//   --root   check another checkout (a `git archive` of a commit, say) instead of this one
//   --base   report only REGRESSIONS against that checkout (an anchor that matched once there
//            and does not here), plus every anchor a gate rewrote (moved); exit 1 on a regression
//   --files  only cases whose target is one of these (paths relative to the repo root)
// Exit 0 when every checked anchor matches once; 1 otherwise.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null
const ROOT = arg('--root') ? resolve(arg('--root')) : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPTS = join(ROOT, 'server', 'scripts')
const only = arg('--files') ? new Set(arg('--files').split(',').map(s => s.trim()).filter(Boolean)) : null

/** The mutation table of one gate: its source up to the end of the table, evaluated with stubs. */
function loadTable(file) {
  const source = readFileSync(file, 'utf8')
  const open = /^const (mutations|CASES) = \[/m.exec(source)
  if (!open) return { error: 'no mutation table' }
  const close = source.indexOf('\n]\n', open.index)
  if (close < 0) return { error: 'mutation table not closed' }
  const head = source.slice(0, close + 2)
    .replace(/^#!.*$/m, '')
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/import\.meta\.url/g, '__gateUrl')
  const stubs = {
    __gateUrl: `file://${file}`,
    join, resolve, dirname, basename,
    fileURLToPath: url => fileURLToPath(url),
    tmpdir: () => '/tmp',
    readFileSync: () => '', writeFileSync: () => {}, existsSync: () => false, mkdtempSync: () => '/tmp/x',
    cpSync: () => {}, rmSync: () => {}, symlinkSync: () => {}, spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
    createHash: () => ({ update() { return this }, digest: () => '' }),
  }
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...Object.keys(stubs), `'use strict';\n${head}\nreturn ${open[1]}`)
    return { table: fn(...Object.values(stubs)) }
  } catch (error) {
    return { error: `evaluation failed: ${error.message}` }
  }
}

/** Every case as { name, file, finds[] }, whatever shape the gate wrote it in. */
function cases(table, root) {
  const out = []
  for (const entry of table) {
    if (Array.isArray(entry)) {
      const [name, file, third] = entry
      const finds = typeof third === 'string' ? [third]
        : Array.isArray(third) ? (typeof third[0] === 'string' ? [third[0]] : third.map(edit => edit[0])) : []
      out.push({ name, file, finds })
    } else if (entry && typeof entry === 'object') {
      const finds = Array.isArray(entry.edits) ? entry.edits.map(edit => edit[0])
        : typeof entry.find === 'string' ? [entry.find] : []
      out.push({ name: entry.name, file: entry.file, finds })
    }
  }
  return out.map(c => ({ ...c, file: String(c.file).replace(`${root}/`, '') }))
}

function check(root) {
  const scripts = join(root, 'server', 'scripts')
  const rows = []
  for (const gate of readdirSync(scripts).filter(f => f.endsWith('mutation-gate.mjs')).sort()) {
    const loaded = loadTable(join(scripts, gate))
    if (loaded.error) { rows.push({ gate, error: loaded.error }); continue }
    for (const c of cases(loaded.table, root)) {
      if (only && !only.has(c.file)) continue
      const path = join(root, c.file)
      const text = existsSync(path) ? readFileSync(path, 'utf8') : null
      c.finds.forEach((find, index) => {
        rows.push({ gate, name: c.name, file: c.file, edit: index, count: text == null ? -1 : text.split(find).length - 1, find })
      })
    }
  }
  return rows
}

const results = check(ROOT)
const base = arg('--base') ? check(resolve(arg('--base'))) : null
const key = r => `${r.gate}|${r.name}|${r.edit}`
const short = r => JSON.stringify(r.find.slice(0, 100))
let bad = 0
if (base) {
  // Regressions only: an anchor that matched exactly once at the base and does not now. An anchor
  // a gate rewrote (same case, new find text) is listed as moved.
  const before = new Map(base.filter(r => !r.error).map(r => [key(r), r]))
  const moved = [], regressed = []
  for (const r of results) {
    if (r.error) continue
    const was = before.get(key(r))
    if (was && was.find !== r.find) moved.push(r)
    if ((!was || was.count === 1) && r.count !== 1) regressed.push(r)
  }
  for (const r of moved) console.log(`MOVED ${r.gate} ${r.name} [${r.file}] now ${short(r)} (matches ${r.count})`)
  for (const r of regressed) console.log(`REGRESSED ${r.gate} ${r.name} [${r.file}] matches ${r.count === -1 ? 'MISSING FILE' : `${r.count} times`}: ${short(r)}`)
  const touched = results.filter(r => !r.error)
  console.log(`${touched.length - regressed.length} of ${touched.length} anchors hold against the base (${regressed.length} regressed, ${moved.length} moved)${only ? ` (files: ${[...only].join(', ')})` : ''}`)
  bad = regressed.length
} else if (process.argv.includes('--json')) {
  console.log(JSON.stringify(results, null, 2))
  bad = results.filter(r => r.error || r.count !== 1).length
} else {
  const byGate = new Map()
  for (const r of results) {
    if (r.error) { console.log(`${r.gate}: ${r.error}`); bad++; continue }
    const g = byGate.get(r.gate) ?? { ok: 0, bad: [] }
    if (r.count === 1) g.ok++
    else { g.bad.push(r); bad++ }
    byGate.set(r.gate, g)
  }
  for (const [gate, g] of byGate) {
    console.log(`${gate}: ${g.ok} of ${g.ok + g.bad.length} anchors match exactly once`)
    for (const r of g.bad) console.log(`  ${r.name} [${r.file}] matches ${r.count === -1 ? 'MISSING FILE' : `${r.count} times`}: ${short(r)}`)
  }
  const checked = results.filter(r => !r.error).length
  console.log(`${checked - bad} of ${checked} anchors match exactly once${only ? ` (files: ${[...only].join(', ')})` : ''}`)
}
process.exit(bad ? 1 : 0)
