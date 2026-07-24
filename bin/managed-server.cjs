#!/usr/bin/env node

// Non-interactive entrypoint for trusted local service managers such as
// COS Control. The existing glasses-server CLI remains the interactive setup
// path; this launcher assumes ~/.cos-glasses/.env is already configured.

const { resolve } = require('node:path')
const packageJson = require('../package.json')

const PKG_ROOT = resolve(__dirname, '..')

try {
  require('tsx/cjs')
} catch {
  console.error('[cos-managed] Package dependencies are incomplete; reinstall @gotcos/glasses-server.')
  process.exit(1)
}

const workDir = process.env.COS_WORKDIR?.trim()
process.env.COS_MANAGED = '1'
process.env.COS_ENTRYPOINT = 'managed-server'
process.env.COS_SERVER_VERSION = packageJson.version
if (workDir) process.env.COS_LAUNCH_DIR = workDir

// The launchd-owned PID is the listener owner. Keeping the listener in this
// process removes the supervisor/child ambiguity that made lifecycle proof and
// crash receipts unreliable.
require(resolve(PKG_ROOT, 'server/index.ts'))
