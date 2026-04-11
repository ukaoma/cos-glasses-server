#!/usr/bin/env node

// COS Glasses Server Launcher
// Downloads and runs the COS Glasses server for Even G2 smart glasses

const { execSync, spawn } = require('child_process')
const { existsSync, mkdirSync, statSync, readFileSync, copyFileSync } = require('fs')
const { join, resolve } = require('path')
const { homedir } = require('os')

const COS_DIR = join(homedir(), '.cos-glasses')
const APP_DIR = join(COS_DIR, 'app')
const REPO_URL = 'https://github.com/ukaoma/cos-glasses-app.git'

// ANSI colors
const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`

console.log('')
console.log(bold('  COS Glasses Server'))
console.log(dim('  AI heads-up display for Even G2 smart glasses'))
console.log('')

// Step 1: Check Node version
const nodeVersion = parseInt(process.versions.node.split('.')[0])
if (nodeVersion < 18) {
  console.log(red('  \u2717 Node.js 18+ required') + ` (you have ${process.versions.node})`)
  console.log('    Update: https://nodejs.org')
  process.exit(1)
}
console.log(green('  \u2713') + ` Node.js ${process.versions.node}`)

// Step 2: Check Claude CLI
let claudeVersion = null
try {
  claudeVersion = execSync('claude --version', { stdio: 'pipe', timeout: 5000 }).toString().trim()
  console.log(green('  \u2713') + ` Claude Code ${claudeVersion}`)
} catch {
  console.log(red('  \u2717 Claude Code CLI not found'))
  console.log('')
  console.log('    Install from: ' + bold('https://claude.ai/download'))
  console.log('    Then run this command again.')
  console.log('')
  process.exit(1)
}

// Step 3: Download or update the app
if (!existsSync(APP_DIR)) {
  console.log('')
  console.log(`  ${yellow('\u2193')} Downloading COS Glasses Server...`)
  mkdirSync(COS_DIR, { recursive: true })
  try {
    execSync(`git clone --depth 1 ${REPO_URL} "${APP_DIR}"`, {
      stdio: 'pipe',
      timeout: 120000
    })
    console.log(green('  \u2713') + ' Downloaded')
  } catch (err) {
    console.log(red('  \u2717 Download failed'))
    console.log(`    ${err.message}`)
    console.log('')
    console.log('    Manual install:')
    console.log(`    git clone ${REPO_URL} "${APP_DIR}"`)
    process.exit(1)
  }
} else {
  // Check for updates (non-blocking, best-effort)
  try {
    const result = execSync('git fetch --dry-run 2>&1', {
      cwd: APP_DIR,
      stdio: 'pipe',
      timeout: 10000
    }).toString()
    if (result.trim()) {
      console.log(yellow('  \u2191') + ' Update available \u2014 run ' + dim('cd ~/.cos-glasses/app && git pull'))
    } else {
      console.log(green('  \u2713') + ' App up to date')
    }
  } catch {
    console.log(green('  \u2713') + ' App installed')
  }
}

// Step 4: npm install if needed
const nodeModules = join(APP_DIR, 'node_modules')
const packageJson = join(APP_DIR, 'package.json')

let needsInstall = !existsSync(nodeModules)
if (!needsInstall) {
  // Check if package.json is newer than node_modules
  try {
    const pkgMtime = statSync(packageJson).mtimeMs
    const nmMtime = statSync(nodeModules).mtimeMs
    needsInstall = pkgMtime > nmMtime
  } catch {
    needsInstall = true
  }
}

if (needsInstall) {
  console.log('')
  console.log(`  ${yellow('\u27f3')} Installing dependencies...`)
  try {
    execSync('npm install', {
      cwd: APP_DIR,
      stdio: 'pipe',
      timeout: 300000
    })
    console.log(green('  \u2713') + ' Dependencies installed')
  } catch (err) {
    console.log(red('  \u2717 npm install failed'))
    console.log(`    ${err.stderr?.toString().slice(0, 200) || err.message}`)
    process.exit(1)
  }
}

// Step 5: Copy .env.example if no .env exists
const envFile = join(APP_DIR, '.env')
const envExample = join(APP_DIR, '.env.example')
if (!existsSync(envFile) && existsSync(envExample)) {
  copyFileSync(envExample, envFile)
  console.log(green('  \u2713') + ' Created .env from template')
}

// Step 5b: Local Whisper detection — voice transcription is FREE if installed,
// otherwise the server silently falls back to OpenAI API ($0.006/min). Public
// users won't know they're being billed unless we tell them at startup.
//
// Detection mirrors what server/lib/whisper-local.ts looks for at runtime:
//   - whisper-cli binary (brew install whisper-cpp)
//   - ggml-large-v3-turbo.bin model (~3.1GB, downloaded from Hugging Face)
const WHISPER_CLI_PATH = '/opt/homebrew/bin/whisper-cli'
const WHISPER_MODEL_DIR = join(homedir(), '.local/share/whisper-models')
const WHISPER_MODEL_PATH = join(WHISPER_MODEL_DIR, 'ggml-large-v3-turbo.bin')
const WHISPER_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin'

const hasWhisperCli = existsSync(WHISPER_CLI_PATH)
const hasWhisperModel = existsSync(WHISPER_MODEL_PATH)

if (hasWhisperCli && hasWhisperModel) {
  console.log(green('  \u2713') + ' whisper.cpp + model ready ' + dim('— voice = local (FREE)'))
} else if (hasWhisperCli && !hasWhisperModel) {
  console.log(yellow('  \u26a0') + ' whisper.cpp installed but model missing')
  console.log('    ' + dim('Downloading large-v3-turbo (~3.1GB) from Hugging Face...'))
  console.log('    ' + dim('Cancel with Ctrl-C if you prefer to skip — server will use OpenAI API instead.'))
  try {
    mkdirSync(WHISPER_MODEL_DIR, { recursive: true })
    execSync(`curl -fL --progress-bar "${WHISPER_MODEL_URL}" -o "${WHISPER_MODEL_PATH}"`, {
      stdio: 'inherit',
      timeout: 600000  // 10 min for slow networks
    })
    console.log(green('  \u2713') + ' Model downloaded ' + dim('— voice = local (FREE)'))
  } catch (err) {
    console.log(red('  \u2717') + ' Model download failed ' + dim('— voice will use OpenAI API'))
    console.log('    ' + dim('Manual: curl -fL ' + WHISPER_MODEL_URL + ' -o ' + WHISPER_MODEL_PATH))
  }
} else {
  // No whisper-cli — voice will fall back to OpenAI API
  console.log(yellow('  \u26a0') + ' whisper.cpp not installed ' + dim('— voice will use OpenAI API ($0.006/min)'))
  console.log('    For free local voice transcription, run:')
  console.log('    ' + bold('brew install whisper-cpp'))
  console.log('    ' + dim('Then re-run npx @gotcos/glasses-server to download the model.'))
}

// Step 6: Start the server
console.log('')
console.log(dim('  Starting server...'))
console.log('')

// Pass through any env vars from command line
// Support: OPENAI_API_KEY=sk-... npx @gotcos/glasses-server
const serverProc = spawn(
  process.execPath, // node
  ['--import', 'tsx/esm', 'server/index.ts'],
  {
    cwd: APP_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      // Don't override COS_SCRIPTS_DIR if not set — let standalone mode activate
    }
  }
)

serverProc.on('error', (err) => {
  console.error(red(`  Server failed to start: ${err.message}`))
  if (err.message.includes('tsx')) {
    console.error('  Try: cd ~/.cos-glasses/app && npm install tsx')
  }
  process.exit(1)
})

serverProc.on('exit', (code) => {
  process.exit(code ?? 0)
})

// Forward signals
process.on('SIGINT', () => serverProc.kill('SIGINT'))
process.on('SIGTERM', () => serverProc.kill('SIGTERM'))
