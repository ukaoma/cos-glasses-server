#!/usr/bin/env node

// COS Glasses Server launcher.
// Runs the bundled server for Even G2 smart glasses. The server ships INSIDE this
// package — there is no clone. Config persists at ~/.cos-glasses/.

const { execSync, spawn } = require('child_process')
const {
  existsSync,
  mkdirSync,
  statSync,
  lstatSync,
  readFileSync,
  copyFileSync,
  unlinkSync,
  renameSync,
  chmodSync,
} = require('fs')
const { join, resolve } = require('path')
const { homedir } = require('os')

// bin/cli.cjs -> package root is one level up. The server lives at <root>/server.
const PKG_ROOT = resolve(__dirname, '..')
const CONFIG_DIR = join(homedir(), '.cos-glasses')

// Record where the user ran `npx @gotcos/glasses-server` from. The server spawns
// with cwd = PKG_ROOT (the npx cache), so without this the user's Starter-Kit COS
// (AGENTS.md / CLAUDE.md / .cos/) in their launch folder would never be seen.
// Chat spawns of claude/codex use this dir when it contains a COS brain.
if (!process.env.COS_LAUNCH_DIR) process.env.COS_LAUNCH_DIR = process.cwd()

const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('')
  console.log(bold('  COS Glasses Server'))
  console.log('')
  console.log('  Usage:')
  console.log('    npx --yes @gotcos/glasses-server@latest')
  console.log('')
  console.log('  Requirements:')
  console.log('    - Node.js 20.11+')
  console.log('    - Claude Code CLI (not Claude Desktop) or Codex CLI')
  console.log('    - Even G2 smart glasses + the COS Glasses app (Even Hub)')
  console.log('')
  console.log('  No API key is needed for chat — it runs through your installed CLI.')
  console.log('  Config persists at ~/.cos-glasses/.env')
  console.log('')
  console.log('  Setup guide: https://www.gotcos.com/wizard/')
  console.log('')
  process.exit(0)
}

console.log('')
console.log(bold('  COS Glasses Server'))
console.log(dim('  AI heads-up display for Even G2 smart glasses'))
console.log('')

// Step 1: Node version. The server uses import.meta.dirname (Node 20.11+ / 21.2+).
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map((n) => parseInt(n, 10))
if (nodeMajor < 20 || (nodeMajor === 20 && nodeMinor < 11)) {
  console.log(red('  ✗ Node.js 20.11+ required') + ` (you have ${process.versions.node})`)
  console.log('    Update: https://nodejs.org')
  process.exit(1)
}
console.log(green('  ✓') + ` Node.js ${process.versions.node}`)

// Step 2: agent CLI detection — at least one of Claude Code / Codex is required
function getCliVersion(command, versionArg = '--version') {
  try {
    return execSync(`${command} ${versionArg} 2>&1`, { shell: '/bin/sh', stdio: 'pipe', timeout: 5000 }).toString().trim()
  } catch {
    return null
  }
}
function normalizeCodexVersion(raw) {
  if (!raw) return 'available'
  const line = raw.split('\n').map((s) => s.trim()).find((s) => /^codex(?:-cli)?\s+/i.test(s)) || raw.split('\n')[0].trim()
  return line.replace(/^codex(?:-cli)?\s*/i, '') || line
}
function commandResult(command) {
  try {
    return {
      ok: true,
      output: execSync(`${command} 2>&1`, { shell: '/bin/sh', stdio: 'pipe', timeout: 5000 }).toString().trim(),
    }
  } catch (err) {
    return {
      ok: false,
      output: (err.stdout?.toString() || err.stderr?.toString() || '').trim(),
    }
  }
}
function claudeAuthState() {
  const result = commandResult('claude auth status --json')
  try {
    const parsed = JSON.parse(result.output)
    if (parsed.loggedIn === true) return 'ready'
    if (parsed.loggedIn === false) return 'signed-out'
  } catch { /* older CLIs may not support JSON status */ }
  if (/not logged in|logged out|sign[ -]?in required/i.test(result.output)) return 'signed-out'
  return 'unknown'
}
function codexAuthState() {
  const result = commandResult('codex login status')
  if (/logged in/i.test(result.output) && !/not logged in/i.test(result.output)) return 'ready'
  if (/not logged in|logged out|sign[ -]?in required/i.test(result.output)) return 'signed-out'
  return 'unknown'
}
const claudeVersion = getCliVersion('claude')
const codexVersion = getCliVersion('codex')
const claudeAuth = claudeVersion ? claudeAuthState() : null
const codexAuth = codexVersion ? codexAuthState() : null
if (claudeVersion) {
  if (claudeAuth === 'signed-out') {
    console.log(yellow('  ⚠') + ` Claude Code ${claudeVersion} installed — sign-in required`)
    console.log('    Run: ' + bold('claude auth login'))
  } else if (claudeAuth === 'unknown') {
    console.log(yellow('  ⚠') + ` Claude Code ${claudeVersion} installed — sign-in status unavailable`)
    console.log('    Verify: ' + bold('claude auth status'))
  } else {
    console.log(green('  ✓') + ` Claude Code ${claudeVersion} ` + dim('(Opus / Fable / Sonnet)'))
  }
} else {
  console.log(yellow('  ⚠') + ' Claude Code CLI not found ' + dim('— Opus/Fable/Sonnet unavailable'))
  console.log('    Claude Desktop does not install the terminal CLI.')
  console.log('    Install (no sudo): ' + bold('npm install -g @anthropic-ai/claude-code'))
  console.log('    Then run:          ' + bold('claude') + ' and finish sign-in')
}
if (codexVersion) {
  if (codexAuth === 'signed-out') {
    console.log(yellow('  ⚠') + ` Codex CLI ${normalizeCodexVersion(codexVersion)} installed — sign-in required`)
    console.log('    Run: ' + bold('codex login'))
  } else if (codexAuth === 'unknown') {
    console.log(yellow('  ⚠') + ` Codex CLI ${normalizeCodexVersion(codexVersion)} installed — sign-in status unavailable`)
    console.log('    Verify: ' + bold('codex login status'))
  } else {
    console.log(green('  ✓') + ` Codex CLI ${normalizeCodexVersion(codexVersion)} ` + dim('(GPT Frontier / Balanced)'))
  }
} else {
  console.log(yellow('  ⚠') + ' Codex CLI not found ' + dim('— GPT Frontier/Balanced unavailable'))
}
const hasUsableAgent = (claudeVersion && claudeAuth !== 'signed-out') || (codexVersion && codexAuth !== 'signed-out')
if (!hasUsableAgent) {
  console.log('')
  console.log(red('  ✗ No signed-in agent CLI is ready'))
  console.log('    Claude Desktop alone is not enough; COS needs a terminal CLI.')
  console.log('    Install Claude Code (no sudo): ' + bold('npm install -g @anthropic-ai/claude-code'))
  console.log('    Then run:                       ' + bold('claude auth login'))
  console.log('    or Codex CLI:        ' + bold('https://developers.openai.com/codex/') + ' then ' + bold('codex login'))
  console.log('    Setup help:          ' + bold('https://www.gotcos.com/wizard/'))
  console.log('')
  process.exit(1)
}

// Step 3: resolve the dependency npm already installed. With `npx`, dependency
// packages are siblings in npm's temporary node_modules tree rather than under
// PKG_ROOT/node_modules. Running a second `npm install` from inside that cache
// is both unnecessary and unsafe: a prior sudo-based npm install can make the
// shared cache root-owned and turn an otherwise valid first launch into EACCES.
let tsxImport
try {
  tsxImport = require.resolve('tsx/esm', { paths: [PKG_ROOT] })
} catch {
  console.log('')
  console.log(red('  ✗ COS package dependencies are incomplete'))
  console.log('    Do not use sudo. Retry with an isolated user-owned npm cache:')
  console.log('    ' + bold('npm_config_cache="$HOME/.cos-glasses/npm-cache" npx --yes @gotcos/glasses-server@latest'))
  console.log('    Source installs only: run ' + bold('npm install') + ' in the cloned repository.')
  process.exit(1)
}

// Step 4: persistent config at ~/.cos-glasses/ (survives npx cache churn)
function securePrivateDirectory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stats = lstatSync(dir)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${dir} must be a private directory, not a symlink`)
  }
  chmodSync(dir, 0o700)
}

function securePrivateFile(file) {
  if (!existsSync(file)) return
  const stats = lstatSync(file)
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${file} must be a regular file, not a symlink`)
  }
  chmodSync(file, 0o600)
}

try {
  securePrivateDirectory(CONFIG_DIR)
} catch (err) {
  console.log('')
  console.log(red('  ✗ COS config directory is unsafe'))
  console.log(`    ${err.message}`)
  console.log('    Move it aside and rerun COS; do not use sudo or broad ownership changes.')
  process.exit(1)
}
const ENV_FILE = join(CONFIG_DIR, '.env')
const ENV_EXAMPLE = join(PKG_ROOT, '.env.example')
if (!existsSync(ENV_FILE) && existsSync(ENV_EXAMPLE)) {
  copyFileSync(ENV_EXAMPLE, ENV_FILE)
  chmodSync(ENV_FILE, 0o600)
  console.log(green('  ✓') + ` Created config at ${dim(ENV_FILE)}`)
}
if (existsSync(ENV_FILE)) {
  try {
    securePrivateFile(ENV_FILE)
  } catch (err) {
    console.log('')
    console.log(red('  ✗ COS config file is unsafe'))
    console.log(`    ${err.message}`)
    process.exit(1)
  }
  try {
    for (const line of readFileSync(ENV_FILE, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
    }
  } catch { /* config is optional */ }
}
// Persistent profile (identity + transcription vocabulary)
const PROFILE_FILE = join(CONFIG_DIR, '.cos-profile.json')
const PROFILE_EXAMPLE = join(PKG_ROOT, '.cos-profile.example.json')
if (!existsSync(PROFILE_FILE) && existsSync(PROFILE_EXAMPLE)) {
  copyFileSync(PROFILE_EXAMPLE, PROFILE_FILE)
  chmodSync(PROFILE_FILE, 0o600)
}
try {
  securePrivateFile(PROFILE_FILE)
} catch (err) {
  console.log('')
  console.log(red('  ✗ COS profile is unsafe'))
  console.log(`    ${err.message}`)
  process.exit(1)
}
if (!process.env.COS_PROFILE_PATH) process.env.COS_PROFILE_PATH = PROFILE_FILE

// Step 5: local Whisper detection + model download. Voice stays local-only by
// default; cloud fallback requires an explicit flag plus a configured key.
const WHISPER_KNOWN_PATHS = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli']
const WHISPER_MODEL_DIR = join(homedir(), '.local/share/whisper-models')
const WHISPER_MODEL_PATH = join(WHISPER_MODEL_DIR, 'ggml-large-v3-turbo.bin')
const WHISPER_MODEL_PARTIAL = WHISPER_MODEL_PATH + '.partial'
const WHISPER_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin'
const WHISPER_MODEL_MIN_BYTES = 800_000_000
function findWhisperCli() {
  for (const p of WHISPER_KNOWN_PATHS) { if (existsSync(p)) return p }
  try {
    const found = execSync('command -v whisper-cli 2>/dev/null', { shell: '/bin/sh', stdio: 'pipe', timeout: 2000 }).toString().trim()
    return found || null
  } catch {
    return null
  }
}
function isValidWhisperModel(p) {
  if (!existsSync(p)) return false
  try { return statSync(p).size >= WHISPER_MODEL_MIN_BYTES } catch { return false }
}
const whisperCliPath = findWhisperCli()
const hasValidModel = isValidWhisperModel(WHISPER_MODEL_PATH)
let localVoiceReady = Boolean(whisperCliPath && hasValidModel)
if (whisperCliPath && hasValidModel) {
  console.log(green('  ✓') + ' whisper.cpp + model ready ' + dim('— voice = local (FREE)'))
} else if (whisperCliPath && !hasValidModel) {
  if (existsSync(WHISPER_MODEL_PATH)) { try { unlinkSync(WHISPER_MODEL_PATH) } catch {} }
  if (existsSync(WHISPER_MODEL_PARTIAL)) { try { unlinkSync(WHISPER_MODEL_PARTIAL) } catch {} }
  console.log(yellow('  ⚠') + ' whisper.cpp installed but model missing')
  console.log('    ' + dim('Downloading ggml-large-v3-turbo (~1.5 GB).'))
  console.log('    ' + dim('Skip: SKIP_WHISPER_DOWNLOAD=1 npx --yes @gotcos/glasses-server@latest'))
  if (process.env.SKIP_WHISPER_DOWNLOAD === '1') {
    console.log(yellow('  ⚠') + ' SKIP_WHISPER_DOWNLOAD=1 — local voice unavailable')
  } else {
    try {
      mkdirSync(WHISPER_MODEL_DIR, { recursive: true })
      execSync(`curl -fL --progress-bar "${WHISPER_MODEL_URL}" -o "${WHISPER_MODEL_PARTIAL}"`, { stdio: 'inherit', timeout: 900000 })
      const stats = statSync(WHISPER_MODEL_PARTIAL)
      if (stats.size < WHISPER_MODEL_MIN_BYTES) throw new Error(`Downloaded file too small: ${stats.size} bytes`)
      renameSync(WHISPER_MODEL_PARTIAL, WHISPER_MODEL_PATH)
      localVoiceReady = true
      console.log(green('  ✓') + ' Model downloaded ' + dim('— voice = local (FREE)'))
    } catch (err) {
      try { unlinkSync(WHISPER_MODEL_PARTIAL) } catch {}
      console.log(red('  ✗') + ' Model download failed ' + dim('— local voice unavailable'))
      console.log('    ' + dim('Error: ' + (err.message || err).toString().slice(0, 120)))
    }
  }
} else {
  console.log(yellow('  ⚠') + ' whisper.cpp not installed ' + dim('— local voice unavailable'))
  console.log('    Free local voice: ' + bold('brew install whisper-cpp') + dim('  (no Homebrew? https://brew.sh)'))
}
if (process.env.COS_OPENAI_WHISPER_FALLBACK === '1') {
  console.log(yellow('  ⚠') + ' Explicit OpenAI Whisper fallback requested ' + dim('— activates only if a key resolves; see /api/health'))
} else {
  console.log(green('  ✓') + ' Transcription policy: local-only ' + dim('— a key alone never uploads audio'))
}

// Step 6: image capability — ffmpeg validates, strips metadata, normalizes,
// and builds the exact 288x144 G2 variant. It is optional so text/voice remain
// useful on a minimal install, but the launcher should make the gap visible.
const ffmpegVersion = getCliVersion('ffmpeg', '-version')
if (ffmpegVersion) {
  const firstLine = ffmpegVersion.split('\n')[0].trim()
  console.log(green('  ✓') + ` ${firstLine} ` + dim('— phone + lens images ready'))
} else {
  console.log(yellow('  ⚠') + ' ffmpeg not installed ' + dim('— phone and answer images disabled'))
  console.log('    Enable photos: ' + bold('brew install ffmpeg') + dim('  (text + voice still work)'))
}

// Step 7: phone reachability — the glasses' phone app must reach this server.
if (!process.env.BIND_HOST) {
  process.env.BIND_HOST = '0.0.0.0'
  console.log(yellow('  ⚠') + ' BIND_HOST not set — defaulting to 0.0.0.0 so your phone can reach the server')
}

// Step 8: start the bundled server
try {
  const ld = process.env.COS_LAUNCH_DIR
  if (ld && (existsSync(join(ld, '.cos', 'manifest.json')) || existsSync(join(ld, 'AGENTS.md')) || existsSync(join(ld, 'CLAUDE.md')))) {
    console.log(green('  ✓') + ` COS detected in ${dim(ld)} — glasses chat will load its brain`)
  }
} catch { /* detection is best-effort */ }
if (!localVoiceReady) {
  console.log('')
  console.log(yellow('  ⚠ LOCAL VOICE NOT READY'))
  console.log('    Text chat can start. Under the default local-only policy, voice prompts remain unavailable.')
  console.log('    Install: ' + bold('brew install whisper-cpp'))
  console.log('    Then stop COS with Ctrl-C and rerun: ' + bold('npx --yes @gotcos/glasses-server@latest'))
}
console.log('')
console.log(dim('  Starting server...'))
console.log('')
const serverProc = spawn(
  process.execPath,
  ['--import', tsxImport, 'server/index.ts'],
  { cwd: PKG_ROOT, stdio: 'inherit', env: { ...process.env } }
)
serverProc.on('error', (err) => {
  console.error(red(`  Server failed to start: ${err.message}`))
  process.exit(1)
})
serverProc.on('exit', (code) => process.exit(code ?? 0))
process.on('SIGINT', () => serverProc.kill('SIGINT'))
process.on('SIGTERM', () => serverProc.kill('SIGTERM'))
