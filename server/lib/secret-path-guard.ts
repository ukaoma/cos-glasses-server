// One shared secret-name deny guard for every route that serves a local file (7.0.4 S2).
//
// WHY. The preview routes (sent output files, sent output images, Markdown output images and
// path-backed tool images) authorize by workspace containment: a file inside the session's exact
// workspace is servable. A repo holds its own secrets inside that workspace (`.env`, a service
// account `*-key.json`, a `.pem`), and a session can name one in a SendUserFile call or a Markdown
// image just as easily as a render. Containment says "this session may show files from here", not
// "every file here is safe to put in a browser". This guard is the second question.
//
// HOW. By name, case-insensitively, and on both the path as given and its canonical (realpath) form, so a symlink
// with an innocent name that points at a secret is still refused. File-name patterns (`.env*`, `*-key.json`, `id_rsa`,
// ...) are matched against the BASE NAME only. Folders are matched only against an exact list of secret folder names
// (`.ssh`, `.gnupg`, `secrets`) and a few exact folder and file pairs (`.aws/config`, `.kube/config`, ...). 7.0.4 QA:
// the first cut ran every file pattern against every folder, so a repo under `credentials-portal/`, `.envoy/` or
// `id_verification/` had every preview refused. A path that cannot be canonicalised (gone, permission) is judged by its
// lexical form only; the callers refuse unreadable files separately.
//
// LIMITS. A name-based guard cannot see a COPY of a secret under another name, and realpath does not resolve a HARD
// link. The sent-file routes, which can serve any text, refuse a file with more than one hard link for that reason
// (agent-session-output-images.ts); images go through the JPEG normaliser, so a text secret cannot leave as one.
//
// The name is fixed (`isDeniedSecretPath`): another branch codes against it.
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** File names refused, matched against the base name only. Lower-cased input. */
const SECRET_NAME: readonly RegExp[] = [
  /^\.env/, // .env*: .env, .env.local, .envrc, .env_backup …
  /-key\.json$/, // service-account keys (gcp-key.json, firebase-admin-key.json)
  /^service-account.*\.json$/, // service-account.json, service-account-prod.json
  /^\.cos-profile/, // the COS profile and its backups
  /^id_(rsa|dsa|ecdsa|ed25519|xmss)/, /^id_[a-z0-9_-]*(\.pub)?$/, // SSH keys and look-alikes (id_rsa.png), not id_card.png
  /\.pem$/, /\.p12$/, /\.pfx$/, /\.key$/, // certificates and private keys
  /^authkey_.*\.p8$/, // App Store Connect API keys (AuthKey_ABC123.p8)
  /^credentials/, // credentials, credentials.json, credentials.csv; also .aws/credentials
  /^\.git-credentials$/, // plaintext git tokens
  /^tokens?\.json$/, // OAuth token stores (token.json)
  /^secrets?\.ya?ml$/, // secrets.yaml, secrets.yml
  /^\.netrc$/, /^\.npmrc$/, /^\.pypirc$/, /^\.pgpass$/, /^\.htpasswd$/, // package, network and database credentials
  /\.keychain/, // login.keychain-db and friends
  /^hook-token$/, // 7.0.5 (preview engine, PLAN 6): the COS hook token beside the glasses data
]
/** Folders whose whole subtree is refused, matched exactly as a folder name. Lower-cased. */
const SECRET_DIRECTORY = new Set(['.ssh', '.gnupg', 'secrets'])
/** A file refused only inside this folder (`config` alone is an ordinary name). Lower-cased `folder/file`. */
const SECRET_PAIR = new Set(['.aws/credentials', '.aws/config', '.docker/config.json', '.kube/config', 'gh/hosts.yml'])

function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean).map(s => s.toLowerCase())
}

function deniedLexically(path: string): boolean {
  const parts = segments(path)
  const name = parts[parts.length - 1]
  if (!name) return false
  if (SECRET_NAME.some(re => re.test(name))) return true
  if (parts.length >= 2 && SECRET_PAIR.has(parts[parts.length - 2] + '/' + name)) return true
  return parts.slice(0, -1).some(folder => SECRET_DIRECTORY.has(folder))
}

/**
 * True when this local path, or the file it canonically resolves to, may hold secrets and must
 * never be served to a browser. A relative path is resolved against the process directory first;
 * callers pass absolute paths. Never throws.
 */
export function isDeniedSecretPath(absPath: string): boolean {
  if (typeof absPath !== 'string' || !absPath) return false
  const path = isAbsolute(absPath) ? absPath : resolve(absPath)
  if (deniedLexically(path)) return true
  let canonical: string
  try { canonical = realpathSync(path) } catch { return false }
  return deniedLexically(canonical)
}

/** The card text a projection shows in place of a denied file. No name beyond the base name travels with it. */
export const SECRET_FILE_NOTICE = 'Not shown: this file may hold secrets'
