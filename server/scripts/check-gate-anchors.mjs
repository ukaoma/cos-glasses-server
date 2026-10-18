#!/usr/bin/env node
// Read-only anchor check for every committed mutation gate (6.78.0, plan v3.1 G-anchors).
//
// WHY. A mutation gate names its targets by an exact string (`find`). When a change moves or
// duplicates that string, the gate refuses the case at run time ("does not match exactly
// once"), and `mutation-gate.mjs` has no `--check` to find that out without running tests.
// This script answers the one question a builder needs before handing a branch over: does
// every anchor of every gate that targets a file I changed still occur EXACTLY ONCE?
//
// HOW. Each gate's case table is evaluated on its own: the source up to the end of the
// table, with the imports bound to the real node modules and `import.meta.url` pinned to the
// gate's own path, runs in a fresh `vm` context. Nothing after the table runs, so no test,
// no copy and no child process is ever started. Then each anchor is counted in the working
// tree, and (with --base) in that revision too, so an anchor that was already ambiguous
// before the change is reported as pre-existing rather than blamed on it.
//
// Usage:
//   node server/scripts/check-gate-anchors.mjs [--base <rev>] [--files a,b,...] [--all] [--print]
//     --base   compare against this revision; changed files default to `git diff --name-only <rev>`
//     --files  check only anchors in these files (repo-relative)
//     --all    check every anchor of every gate, whatever changed
//     --print  also print every checked anchor (file, gate, case, the first 160 characters)
// Exit 0 when every checked anchor occurs exactly once (or was already not unique at --base
// and is unchanged); 1 otherwise. Writes nothing.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPTS = join(ROOT, 'server', 'scripts')
/** Gates whose tuples carry no file: the one file each mutates. */
const SINGLE_FILE_GATES = { 'work-review-mutation-gate.mjs': 'server/lib/work-review-runtime.ts' }

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const base = value('--base')
const all = flag('--all')
const print = flag('--print')

function git(...argv) {
  return execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

let changed = null
if (value('--files')) changed = new Set(value('--files').split(',').map(s => s.trim()).filter(Boolean))
else if (base) changed = new Set(git('diff', '--name-only', base).split('\n').map(s => s.trim()).filter(Boolean))
if (!all && changed === null) {
  console.error('check-gate-anchors: pass --base <rev>, --files a,b or --all')
  process.exit(2)
}

/** Bind `import { a, b as c } from 'x'` lines to the real modules, then evaluate the prefix. */
async function loadCases(gatePath) {
  const source = readFileSync(gatePath, 'utf8')
  const lines = source.split('\n')
  const start = lines.findIndex(l => /^const (mutations|CASES) = \[/.test(l))
  if (start < 0) throw new Error('no case table found')
  let end = -1
  for (let i = start + 1; i < lines.length; i++) if (/^\]/.test(lines[i])) { end = i; break }
  if (end < 0) throw new Error('case table has no closing line')
  const tableName = /^const (mutations|CASES)/.exec(lines[start])[1]
  const context = vm.createContext({ console, process: { argv: [], env: {}, execPath: process.execPath } })
  // Anything that could write or spawn is stubbed: a gate prefix may mint its scratch dir
  // before its table (work-review does), and this checker must stay read-only.
  const inert = name => (/^(mkdtemp|mkdir|cp|symlink|write|rm|unlink|rename|copy|append)/.test(name) || name === 'spawnSync' || name === 'execFileSync' || name === 'spawn')
    ? (...a) => (/^mkdtemp/.test(name) ? join('/nonexistent-anchor-check', String(a[0] ?? '')) : undefined)
    : null
  const kept = []
  for (const line of lines.slice(0, end + 1)) {
    const imp = /^import\s+(?:\{([^}]*)\}|(\w+))\s+from\s+'([^']+)'/.exec(line)
    if (imp) {
      const mod = await import(imp[3])
      if (imp[2]) context[imp[2]] = mod.default ?? mod
      else for (const part of imp[1].split(',').map(s => s.trim()).filter(Boolean)) {
        const [orig, alias] = part.split(/\s+as\s+/)
        context[alias ?? orig] = inert(orig) ?? mod[orig]
      }
      kept.push('')
      continue
    }
    if (/^#!/.test(line)) { kept.push(''); continue }
    kept.push(line.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(gatePath).href)))
  }
  vm.runInContext(kept.join('\n'), context, { filename: gatePath })
  const table = vm.runInContext(tableName, context)
  return table.map(c => {
    // Tuple tables: [name, file, find, replace, ...]; work-review's is [name, find, replace]
    // against its one target file (named in that gate as `target`).
    if (Array.isArray(c)) {
      if (c.length === 3) return { name: c[0], file: SINGLE_FILE_GATES[basename(gatePath)] ?? null, edits: [[c[1], c[2]]] }
      return { name: c[0], file: c[1], edits: [[c[2], c[3]]] }
    }
    const edits = Array.isArray(c.edits) ? c.edits
      : typeof c.find === 'string' ? [[c.find, c.replace]]
      : Array.isArray(c.mutations) ? c.mutations.map(x => [x.find, x.replace])
      : []
    return { name: c.name, file: c.file, edits }
  })
}

const count = (text, find) => (text === null ? null : text.split(find).length - 1)
const readNow = file => (existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), 'utf8') : null)
const baseCache = new Map()
function readBase(file) {
  if (!base) return null
  if (!baseCache.has(file)) {
    try { baseCache.set(file, git('show', `${base}:${file}`)) } catch { baseCache.set(file, null) }
  }
  return baseCache.get(file)
}

const gates = readdirSync(SCRIPTS).filter(f => /mutation-gate\.mjs$/.test(f)).sort()
let checked = 0, bad = 0, preexisting = 0, unreadable = 0
const touchedCases = new Map()
for (const gate of gates) {
  let cases
  try {
    cases = await loadCases(join(SCRIPTS, gate))
  } catch (error) {
    console.log(`UNREADABLE ${gate}: ${error instanceof Error ? error.message : error}`)
    unreadable++
    continue
  }
  for (const c of cases) {
    if (typeof c.file !== 'string') { console.log(`UNREADABLE ${gate} ${c.name}: no file`); unreadable++; continue }
    if (!all && !changed.has(c.file)) continue
    const now = readNow(c.file)
    const was = readBase(c.file)
    for (const [find] of c.edits) {
      if (typeof find !== 'string') continue
      checked++
      if (print) console.log(`ANCHOR ${c.file} :: ${gate} ${c.name} :: ${JSON.stringify(find.slice(0, 160))}`)
      const n = count(now, find)
      const b = count(was, find)
      if (!touchedCases.has(gate)) touchedCases.set(gate, new Set())
      touchedCases.get(gate).add(c.name)
      if (n === 1) continue
      if (base && b !== null && b !== 1 && b === n) {
        preexisting++
        console.log(`PRE-EXISTING ${gate} ${c.name}: ${c.file} matches ${n} times now and at ${base}`)
        continue
      }
      bad++
      console.log(`MOVED ${gate} ${c.name}: ${c.file} matches ${n ?? 'missing file'} times (was ${b ?? 'n/a'}): ${JSON.stringify(find.slice(0, 120))}`)
    }
  }
}
if (!all) for (const [gate, names] of touchedCases) console.log(`cases ${gate}: ${[...names].join(' ')}`)
console.log(`${checked - bad - preexisting} of ${checked} anchors in changed files match exactly once; ${bad} moved; ${preexisting} pre-existing; ${unreadable} gate(s) unreadable; gates scanned ${gates.length}`)
process.exit(bad || unreadable ? 1 : 0)
