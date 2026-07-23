#!/usr/bin/env node

// Non-interactive entrypoint for trusted local service managers such as
// COS Control. The existing glasses-server CLI remains the interactive setup
// path; this launcher assumes ~/.cos-glasses/.env is already configured.

const { spawn } = require('node:child_process')
const { resolve } = require('node:path')
const packageJson = require('../package.json')

const PKG_ROOT = resolve(__dirname, '..')

let tsxImport
try {
  tsxImport = require.resolve('tsx/esm', { paths: [PKG_ROOT] })
} catch {
  console.error('[cos-managed] Package dependencies are incomplete; reinstall @gotcos/glasses-server.')
  process.exit(1)
}

const workDir = process.env.COS_WORKDIR?.trim()
const env = {
  ...process.env,
  COS_MANAGED: '1',
  COS_ENTRYPOINT: 'managed-server',
  COS_SERVER_VERSION: packageJson.version,
  ...(workDir ? { COS_LAUNCH_DIR: workDir } : {}),
}

const child = spawn(
  process.execPath,
  ['--import', tsxImport, resolve(PKG_ROOT, 'server/index.ts')],
  { cwd: PKG_ROOT, env, stdio: 'inherit' },
)

const forward = signal => {
  if (!child.killed) child.kill(signal)
}
process.on('SIGTERM', () => forward('SIGTERM'))
process.on('SIGINT', () => forward('SIGINT'))
child.once('error', error => {
  console.error(`[cos-managed] Failed to start server: ${error.message}`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  process.exitCode = typeof code === 'number' ? code : signal ? 1 : 0
})
