#!/usr/bin/env node
'use strict'
const { resolve, dirname } = require('node:path')
const { readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
function option(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const runtime = option('--runtime-dir'), data = option('--data-root')
if (!runtime || !data || args.some((x, i) => i % 2 === 0 && !['--runtime-dir', '--data-root', '--python'].includes(x))) {
  console.error('Usage: glasses-memory-setup --runtime-dir /path/to/runtime --data-root /path/to/private-data [--python python3]')
  process.exit(2)
}
const root = resolve(__dirname, '..')
const manifest = JSON.parse(readFileSync(resolve(root, 'memory-runtime/runtime.json'), 'utf8'))
if (manifest.protocol !== 1 || !/^[a-zA-Z0-9.-]+\.tar\.gz$/.test(manifest.file)) throw new Error('Invalid runtime manifest')
const archive = resolve(root, 'memory-runtime', manifest.file)
if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== manifest.sha256) throw new Error('Runtime bundle checksum mismatch')
const program = String.raw`
import json,os,shutil,sys,tarfile,tempfile
from pathlib import Path
archive,destination,data=map(Path,sys.argv[1:])
if sys.version_info<(3,11):raise SystemExit('Python 3.11 or newer is required')
if destination.resolve()==data.resolve() or destination.resolve() in data.resolve().parents or data.resolve() in destination.resolve().parents:raise SystemExit('Keep runtime code and private data in separate directories')
destination.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='cos-runtime-install-',dir=destination.parent) as staging:
 with tarfile.open(archive,'r:gz') as bundle:
  members=bundle.getmembers()
  if sum(item.size for item in members)>10*1024*1024:raise SystemExit('Runtime bundle is too large')
  for item in members:
   relative=Path(item.name)
   if relative.is_absolute() or '..' in relative.parts or not (item.isfile() or item.isdir()):raise SystemExit('Unsafe runtime member')
   target=Path(staging)/relative
   if item.isdir():target.mkdir(parents=True,exist_ok=True)
   else:
    target.parent.mkdir(parents=True,exist_ok=True)
    with bundle.extractfile(item) as source,target.open('wb') as output:shutil.copyfileobj(source,output)
 roots=list(Path(staging).iterdir())
 if len(roots)!=1 or not roots[0].is_dir():raise SystemExit('Invalid runtime layout')
 for source in roots[0].iterdir():
  if source.name in {'instance.json','venv'} or not source.is_file():raise SystemExit('Unexpected runtime member')
  target=destination/source.name
  if target.is_symlink():raise SystemExit('Refusing to replace symlinked runtime code')
  fd,temp=tempfile.mkstemp(prefix='.'+target.name+'-',dir=destination)
  try:
   with os.fdopen(fd,'wb') as output,source.open('rb') as input:shutil.copyfileobj(input,output);output.flush();os.fsync(output.fileno())
   os.replace(temp,target)
  finally:Path(temp).unlink(missing_ok=True)
`
let result = spawnSync(option('--python') || 'python3', ['-c', program, archive, resolve(runtime), resolve(data)], { stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status || 1)
result = spawnSync(option('--python') || 'python3', [resolve(runtime, 'install.py'), '--data-root', resolve(data)], { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status || 0)
