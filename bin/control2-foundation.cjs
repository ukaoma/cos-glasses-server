#!/usr/bin/env node
'use strict'
// Explicit lab entrypoint. Never imports or starts the managed production daemon.
const { spawn } = require('node:child_process')
const { resolve } = require('node:path')
const root = resolve(__dirname, '..')
const child = spawn(process.execPath, ['--import', require.resolve('tsx/esm'), resolve(root, 'server/scripts/control2-foundation-lab.ts')], {
  cwd: root, env: process.env, stdio: 'inherit',
})
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
