// One shared secret-name deny guard for every route that serves a local file (7.0.4 S2).
//
// WHY. The preview routes (sent output files, sent output images, Markdown output images and
// path-backed tool images) authorize by workspace containment: a file inside the session's exact
// workspace is servable. A repo holds its own secrets inside that workspace (`.env`, a service
// account `*-key.json`, a `.pem`), and a session can name one in a SendUserFile call or a Markdown
// image just as easily as a render. Containment says "this session may show files from here", not
// "every file here is safe to put in a browser". This guard is the second question.
//
// HOW. By name, case-insensitively, on EVERY path segment (not only the last), so a file under a
// directory named like a secret is refused too, and on both the path as given and its canonical
// (realpath) form, so a symlink with an innocent name that points at a secret is still refused.
// A path that cannot be canonicalised (gone, permission) is judged by its lexical form only; the
// callers refuse unreadable files separately.
//
// The name is fixed (`isDeniedSecretPath`): another branch codes against it.
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** Names refused wherever they appear as a path segment. Lower-cased input. */
const SECRET_SEGMENT: readonly RegExp[] = [
  /^\.env$/, /^\.env\./, // .env, .env.local, .env.production …
  /-key\.json$/, // service-account keys (gcp-key.json, firebase-admin-key.json)
  /^\.cos-profile/, // the COS profile and its backups
  /^id_rsa/, /^id_ed25519/, /^id_ecdsa/, // SSH private (and public) keys
  /\.pem$/, /\.p12$/, /\.pfx$/, /\.key$/, // certificates and private keys
  /^credentials/, // credentials, credentials.json, credentials.csv; this is also what refuses .aws/credentials
  /^\.netrc$/, /^\.npmrc$/, /^\.pypirc$/, // package and network tokens
  /\.keychain/, // login.keychain-db and friends
]
/** Directories whose whole subtree is refused, matched as a path segment. Lower-cased. */
const SECRET_DIRECTORY = new Set(['.ssh', '.gnupg'])

function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean).map(s => s.toLowerCase())
}

function deniedLexically(path: string): boolean {
  const parts = segments(path)
  return parts.some(part => SECRET_DIRECTORY.has(part) || SECRET_SEGMENT.some(re => re.test(part)))
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
