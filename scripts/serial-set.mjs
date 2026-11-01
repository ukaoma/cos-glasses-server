#!/usr/bin/env node
// The serial set for the opt-in fenced-parallel run: test files that must not run beside another
// test file, even with a private data home, HOME and TMPDIR per fork (test-support/fence-setup.ts).
//
// A file is serial when it
//   - imports child_process for real, or inspects/kills processes (pgrep, lsof, ps, process.kill,
//     process groups): a sibling worker's children and kill(-pid) are visible to it;
//   - asserts an upper bound on elapsed wall-clock time: a busier machine flips it;
//   - names a literal /tmp/... path: the fence redirects os.tmpdir(), not a string in the test;
//   - imports a bridge that spawns the provider CLIs or the speaker trainer (fixed /tmp files,
//     spawn paths), or touches the TTS spend ledger, which stays where it is (server/data);
//   - is listed by hand in test-support/serial-set.txt (the research-2 set and any later finding).
//
// These are static heuristics. A file that reaches a spawn or a shared path only through a helper
// module is invisible to them, which is what the per-test-ID parity run in qualify-parallel.mjs is for.
//
// A heuristic hit can be CLEARED by a person who read the file: test-support/parallel-reviewed.txt
// records the path, a hash of the file as reviewed, and the reason. A cleared file runs in the
// parallel set. The hash makes the review expire: edit the file and --check fails until someone
// reads it again (--review) or moves it back to the serial list. Clearing is never done by the script.
//
//   node scripts/serial-set.mjs --check   every hit is serial or reviewed; reviews match their file's hash
//   node scripts/serial-set.mjs --write   add heuristic hits to the serial list (never removes a line)
//   node scripts/serial-set.mjs --review <file> <reason...>   record (or refresh) a review at the file's current hash
//   node scripts/serial-set.mjs --files   print the parallel files, then the serial files, as JSON
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
export const LIST_FILE = join(ROOT, 'test-support', 'serial-set.txt')
export const REVIEWED_FILE = join(ROOT, 'test-support', 'parallel-reviewed.txt')

const HEURISTICS = {
  // Also the dynamic forms: `await import('node:child_process')` and `importOriginal<typeof import('node:child_process')>()`.
  'child_process import': /^\s*import\s[^\n]*['"](node:)?child_process['"]|require\(['"](node:)?child_process['"]\)|import\(\s*['"](node:)?child_process['"]\s*\)/m,
  'process inspection': /\b(pgrep|pkill|lsof)\b|['"]ps['"]|\bps -[a-z]/,
  'process.kill': /process\.kill\(/,
  'process group': /kill\(\s*-|detached:\s*true/,
  'wall-clock upper bound': /expect\([^\n]*(elapsed|took|Date\.now\(\) -|performance\.now\(\) -|duration)[^\n]*\)\.toBeLessThan/,
  'literal /tmp path': /['"`]\/tmp\/|\/private\/tmp/,
  'spawning bridge import': /from\s+['"][^'"]*\/(claude|codex|cursor|direct|ollama)-bridge(\.js)?['"]|from\s+['"][^'"]*speaker-trainer(\.js)?['"]/,
  'TTS ledger': /openai-tts-budget|routes\/tts\.js|tts-policy/,
}

export function listTestFiles(root = ROOT) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full) } else if (entry.name.endsWith('.test.ts')) out.push(relative(root, full))
    }
  }
  walk(join(root, 'server'))
  walk(join(root, 'shared'))
  return out.sort()
}

export function heuristicHits(files, root = ROOT) {
  const hits = new Map()
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8')
    const why = Object.entries(HEURISTICS).filter(([, re]) => re.test(text)).map(([name]) => name)
    // TTS: the two named files are serial even if the heuristic text moves.
    if (/(^|\/)tts(-policy)?\.test\.ts$/.test(file) && file.startsWith('server/routes/')) why.push('TTS ledger')
    if (why.length > 0) hits.set(file, [...new Set(why)])
  }
  return hits
}

export function readList(path = LIST_FILE) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').map(l => l.replace(/#.*$/, '').trim()).filter(Boolean)
}

export const fileHash = (root, file) => createHash('sha256').update(readFileSync(join(root, file))).digest('hex').slice(0, 12)

/** Reviewed-and-cleared entries: [{ file, hash, reason }]. Tab-separated: path, hash, reason. */
export function readReviewed(path = REVIEWED_FILE) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#')).map(line => {
    const [file, hash, ...reason] = line.split('\t')
    return { file: file.trim(), hash: (hash ?? '').trim(), reason: reason.join('\t').trim() }
  })
}

/** Split every test file into the parallel set and the serial set. Throws on a listed file that does not exist. */
export function splitSets(root = ROOT, listPath = LIST_FILE) {
  const all = listTestFiles(root)
  const listed = readList(listPath)
  const missing = listed.filter(f => !all.includes(f))
  if (missing.length > 0) throw new Error(`serial-set.txt lists ${missing.length} file(s) that do not exist:\n  ${missing.join('\n  ')}`)
  const serial = new Set(listed)
  return { all, serial: all.filter(f => serial.has(f)), parallel: all.filter(f => !serial.has(f)) }
}

function check() {
  const { all, serial } = splitSets()
  const listed = readList()
  const repeated = listed.filter((f, i) => listed.indexOf(f) !== i)
  if (repeated.length > 0) {
    console.error(`serial-set: ${repeated.length} repeated line(s) in test-support/serial-set.txt:\n  ${repeated.join('\n  ')}`)
    process.exit(1)
  }
  const exempt = readList(join(ROOT, 'test-support', 'real-tmpdir.txt'))
  const badExempt = exempt.filter(f => !serial.includes(f))
  if (badExempt.length > 0) {
    console.error(`real-tmpdir.txt lists file(s) that are not in the serial set or do not exist:\n  ${badExempt.join('\n  ')}`)
    process.exit(1)
  }
  const reviewed = readReviewed()
  const problems = []
  for (const r of reviewed) {
    if (!all.includes(r.file)) problems.push(`${r.file}: reviewed but does not exist`)
    else if (serial.includes(r.file)) problems.push(`${r.file}: both reviewed-and-cleared and in the serial list`)
    else if (!r.reason) problems.push(`${r.file}: a review needs a reason`)
    else if (fileHash(ROOT, r.file) !== r.hash) problems.push(`${r.file}: changed since it was reviewed (${r.hash} then, ${fileHash(ROOT, r.file)} now). Read it again and run --review, or move it to the serial list`)
  }
  const repeatedReviews = reviewed.filter((r, i) => reviewed.findIndex(x => x.file === r.file) !== i)
  for (const r of repeatedReviews) problems.push(`${r.file}: reviewed twice`)
  if (problems.length > 0) {
    console.error(`serial-set: ${problems.length} problem(s) in test-support/parallel-reviewed.txt:\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
  const clearedSet = new Set(reviewed.map(r => r.file))
  const hits = heuristicHits(all)
  const unlisted = [...hits.keys()].filter(f => !serial.includes(f) && !clearedSet.has(f))
  if (unlisted.length > 0) {
    console.error(`serial-set: ${unlisted.length} file(s) match a serial heuristic but are not in test-support/serial-set.txt:`)
    for (const f of unlisted) console.error(`  ${f}  (${hits.get(f).join(', ')})`)
    console.error('Run `node scripts/serial-set.mjs --write` to add them, or list them by hand with a reason.')
    process.exit(1)
  }
  console.log(`serial-set: ok, ${all.length} test files, ${serial.length} serial, ${all.length - serial.length} parallel (${reviewed.length} of them heuristic hits cleared by review)`)
}

function write() {
  const { all } = splitSets()
  const existing = readFileSync(LIST_FILE, 'utf8')
  const listed = new Set(readList())
  const cleared = new Set(readReviewed().map(r => r.file))
  const hits = heuristicHits(all)
  const add = [...hits.keys()].filter(f => !listed.has(f) && !cleared.has(f)).sort()
  if (add.length === 0) { console.log('serial-set: nothing to add'); return }
  const lines = add.map(f => `${f}  # ${hits.get(f).join(', ')}`)
  writeFileSync(LIST_FILE, `${existing.replace(/\n*$/, '\n')}${lines.join('\n')}\n`)
  console.log(`serial-set: added ${add.length} file(s)`)
}

/** Record, or refresh, a review. Does not move anything between lists; the serial line is removed by hand. */
export function recordReview(file, reason, root = ROOT, path = REVIEWED_FILE) {
  if (!listTestFiles(root).includes(file)) throw new Error(`${file} is not a test file under server/ or shared/`)
  const header = existsSync(path) ? '' : '# Heuristic hits a person read and cleared for the parallel set. Tab-separated: path, hash of the file as reviewed, reason.\n# The hash expires the review: edit the file and `node scripts/serial-set.mjs --check` fails until it is read again (--review).\n'
  const kept = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith(`${file}\t`)) : []
  writeFileSync(path, `${header}${kept.join('\n')}${kept.length ? '\n' : ''}${file}\t${fileHash(root, file)}\t${reason}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]
  if (mode === '--review') { recordReview(process.argv[3], process.argv.slice(4).join(' ')); console.log(`serial-set: reviewed ${process.argv[3]}`) }
  else if (mode === '--check') check()
  else if (mode === '--write') write()
  else if (mode === '--files') { const { parallel, serial } = splitSets(); console.log(JSON.stringify({ parallel, serial })) }
  else { console.error('usage: serial-set.mjs --check | --write | --files'); process.exit(2) }
}
