#!/usr/bin/env node
'use strict'
// Candidate installer/probe. Does not configure the live COS bridge.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const flags = process.argv.slice(2)
const opts = {}
for (let i = 0; i < flags.length; i++) {
  if (flags[i] === '--install') { opts.install = true; continue }
  if (!['--runtime-dir', '--data-root', '--domain', '--operator', '--python'].includes(flags[i]) || !flags[i + 1] || flags[i + 1].startsWith('--')) {
    console.error('Usage: node bin/task-runtime-check.cjs --runtime-dir /absolute/runtime [--install] [--data-root /absolute/data --domain work] [--operator Name] [--python python3]')
    process.exit(2)
  }
  opts[flags[i].slice(2)] = flags[++i]
}
function verify(dir) {
  const manifestPath = path.join(dir, 'manifest.json')
  if (fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error('Symlinked manifest refused')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.schema !== 1 || manifest.protocol !== 'cos-control-task-read/1' || manifest.readOnly !== true ||
      Object.keys(manifest.files).sort().join(',') !== 'LICENSE,task_runtime.py') throw new Error('Unsupported runtime manifest')
  for (const [name, hash] of Object.entries(manifest.files)) {
    const file = path.join(dir, name)
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Nonregular runtime member')
    if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== hash) throw new Error('Runtime checksum mismatch')
  }
  return manifest
}
try {
  if (!opts['runtime-dir'] || !path.isAbsolute(opts['runtime-dir'])) throw new Error('Absolute runtime directory required')
  const runtime = path.resolve(opts['runtime-dir'])
  const data = opts['data-root'] && path.resolve(opts['data-root'])
  if (data && (!path.isAbsolute(opts['data-root']) || runtime === data || data.startsWith(runtime + path.sep) || runtime.startsWith(data + path.sep))) throw new Error('Runtime and data roots must be separate')
  if (fs.existsSync(runtime) && fs.lstatSync(runtime).isSymbolicLink()) throw new Error('Symlinked runtime directory refused')
  if (opts.install) {
    const source = path.resolve(__dirname, '../task-runtime')
    const manifest = verify(source)
    if (fs.existsSync(runtime) && fs.readdirSync(runtime).length) throw new Error('Install destination must be empty')
    fs.mkdirSync(runtime, { recursive: true, mode: 0o700 })
    for (const name of [...Object.keys(manifest.files), 'manifest.json']) fs.copyFileSync(path.join(source, name), path.join(runtime, name), fs.constants.COPYFILE_EXCL)
  }
  verify(runtime)
  const probe = (args) => {
    const result = spawnSync(opts.python || 'python3', ['-I', '-S', path.join(runtime, 'task_runtime.py'), ...args], {
      cwd: runtime, env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
      encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024,
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Runtime probe failed: ${result.stdout.trim() || result.stderr.trim().slice(0, 300)}`)
    return JSON.parse(result.stdout)
  }
  const capabilities = probe(['capabilities'])
  if (capabilities.protocol !== 'cos-control-task-read/1' || capabilities.writes !== false) throw new Error('Capability mismatch')
  const result = { ok: true, installed: !!opts.install, capabilities }
  if (data) {
    result.domains = probe(['domains', '--root', data]).domains
    if (opts.domain) result.tasks = probe(['task-rows', '--root', data, '--domain', opts.domain, ...(opts.operator ? ['--operator', opts.operator] : [])])
  } else if (opts.domain) throw new Error('--domain requires --data-root')
  console.log(JSON.stringify(result))
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }))
  process.exit(1)
}
