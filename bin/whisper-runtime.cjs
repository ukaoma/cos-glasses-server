// Shared by setup and both live Whisper workers. Explicit overrides fail closed.
const { accessSync, constants, statSync } = require('node:fs')
const { isAbsolute, join } = require('node:path')
function executable(path) {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile() } catch { return false }
}
function resolveWhisperBinary(name, env = process.env, available = executable) {
  if (!['whisper-cli', 'whisper-server'].includes(name)) throw new Error('Unknown Whisper binary')
  const key = name === 'whisper-cli' ? 'COS_WHISPER_CLI_BIN' : 'COS_WHISPER_SERVER_BIN'
  if (env[key] !== undefined && env[key] !== '') {
    const path = env[key].trim()
    return isAbsolute(path) && available(path) ? path : null
  }
  const candidates = ['/opt/homebrew/bin', '/usr/local/bin', ...(env.PATH || '').split(':')]
  return candidates.filter(isAbsolute).map(p => join(p, name)).find(available) || null
}
module.exports = { resolveWhisperBinary }
