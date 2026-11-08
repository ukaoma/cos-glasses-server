/**
 * 7.0.4 S2: one secret-name deny guard for every local file response. Every listed pattern, case-insensitivity,
 * the segment rule, and the canonical (symlink) rule, against real files in a scratch tree.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeniedSecretPath, SECRET_FILE_NOTICE } from './secret-path-guard.js'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'cos-secret-guard-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const at = (...parts: string[]) => join(root, 'repo', ...parts)

describe('isDeniedSecretPath: names', () => {
  // One row per pattern in the brief, each with a variant, so a dropped pattern fails its own row.
  const denied: Array<[string, string]> = [
    ['.env*', '.env'], ['.env*', '.env.local'], ['.env*', '.env.production'],
    ['.env*', '.envrc'], ['.env*', '.env_backup'], ['.env*', '.environment'],
    ['*-key.json', 'gcp-key.json'], ['*-key.json', 'firebase-admin-key.json'],
    ['.cos-profile*', '.cos-profile.json'], ['.cos-profile*', '.cos-profile.json.bak3'],
    ['id_*', 'id_rsa'], ['id_*', 'id_rsa.pub'], ['id_*', 'id_ed25519'], ['id_*', 'id_ecdsa_sk'],
    ['id_*', 'id_dsa'], ['id_*', 'id_xmss'], ['id_*', 'id_custom'], ['id_*', 'id_rs'], ['id_*', 'id_'],
    ['*.pem', 'server.pem'], ['*.p12', 'apple-dist.p12'], ['*.pfx', 'signing.pfx'], ['*.key', 'tls.key'],
    ['credentials*', 'credentials'], ['credentials*', 'credentials.json'],
    ['.netrc', '.netrc'], ['.npmrc', '.npmrc'], ['.pypirc', '.pypirc'],
    ['*.keychain*', 'login.keychain-db'], ['*.keychain*', 'build.keychain'],
    ['hook-token (7.0.5)', 'hook-token'],
  ]
  for (const [pattern, name] of denied) {
    it(`${pattern}: ${name} is denied`, () => { expect(isDeniedSecretPath(at('config', name))).toBe(true) })
  }
  it('anything under a .ssh or .gnupg segment, and .aws/credentials', () => {
    expect(isDeniedSecretPath(at('.ssh', 'config'))).toBe(true)
    expect(isDeniedSecretPath(at('.ssh', 'known_hosts'))).toBe(true)
    expect(isDeniedSecretPath(at('.gnupg', 'private-keys-v1.d', 'A1.png'))).toBe(true)
    expect(isDeniedSecretPath(at('.aws', 'credentials'))).toBe(true)
  })
  it('7.0.5: anything under a `secrets` folder; a name that only starts with it is not a secret', () => {
    expect(isDeniedSecretPath(at('secrets', 'notes.md'))).toBe(true)
    expect(isDeniedSecretPath(at('Secrets', 'deep', 'a.png'))).toBe(true)
    expect(isDeniedSecretPath(at('secrets-plan.md'))).toBe(false)
    expect(isDeniedSecretPath(at('hook-token.md'))).toBe(false)
  })
  it('case-insensitively', () => {
    for (const name of ['.ENV', '.Env.Local', '.ENVRC', '.Env_Backup', 'GCP-KEY.JSON', '.COS-PROFILE.json', 'ID_RSA', 'ID_DSA', 'Id_Xmss', 'Server.PEM', 'A.P12', 'B.PFX', 'C.KEY', 'Credentials.CSV', '.NETRC', '.NpmRc', '.PYPIRC', 'Login.KEYCHAIN-db']) {
      expect(isDeniedSecretPath(at(name)), name).toBe(true)
    }
    expect(isDeniedSecretPath(at('.SSH', 'config'))).toBe(true)
    expect(isDeniedSecretPath(at('.GnuPG', 'x'))).toBe(true)
  })
  it('7.0.4 QA: file-name patterns match the base name only; a folder named like a secret file is ordinary', () => {
    expect(isDeniedSecretPath(at('.env', 'readme.txt'))).toBe(false)
    expect(isDeniedSecretPath(at('.env_backup', 'readme.txt'))).toBe(false)
    expect(isDeniedSecretPath(at('id_xmss', 'shot.png'))).toBe(false)
    expect(isDeniedSecretPath(at('credentials', 'shot.png'))).toBe(false)
  })
  it('must allow: real project folders the first cut refused', () => {
    expect(isDeniedSecretPath('/Users/x/repos/credentials-portal/shots/home.png')).toBe(false)
    expect(isDeniedSecretPath('/Users/x/.envoy/app/shot.png')).toBe(false)
    expect(isDeniedSecretPath('/Users/x/repos/id_verification/docs/flow.png')).toBe(false)
    expect(isDeniedSecretPath('/Users/x/repos/app/id_card.png')).toBe(false)
    expect(isDeniedSecretPath('/Users/x/repos/my-secrets-app/out/shot.png')).toBe(false)
  })
  it('must refuse: real secret files, and anything inside secrets/, .ssh/ or .gnupg/', () => {
    for (const p of ['/Users/x/repo/.env', '/Users/x/repo/x-key.json', '/Users/x/.ssh/id_rsa', '/Users/x/repo/secrets/shot.png', '/Users/x/repo/SECRETS/a/b.txt', '/Users/x/.ssh/config', '/Users/x/.gnupg/pubring.kbx']) {
      expect(isDeniedSecretPath(p), p).toBe(true)
    }
  })
  it('7.0.4 QA: more secret file names (base name)', () => {
    for (const name of ['.git-credentials', 'token.json', 'tokens.json', 'secrets.yaml', 'secrets.yml', 'service-account.json', 'service-account-prod.json', '.pgpass', '.htpasswd', 'AuthKey_ABC123XYZ.p8', 'authkey_x.P8']) {
      expect(isDeniedSecretPath(at('config', name)), name).toBe(true)
    }
    for (const name of ['token.md', 'tokens.ts', 'secrets.md', 'service-account.md', 'pgpass.txt', 'AuthKey.png', 'key.p8.md']) {
      expect(isDeniedSecretPath(at('config', name)), name).toBe(false)
    }
  })
  it('7.0.4 QA: folder and file pairs; the same file name elsewhere is ordinary', () => {
    for (const p of ['/Users/x/.aws/credentials', '/Users/x/.aws/config', '/Users/x/.docker/config.json', '/Users/x/.kube/config', '/Users/x/.config/gh/hosts.yml']) {
      expect(isDeniedSecretPath(p), p).toBe(true)
    }
    for (const p of ['/Users/x/repo/config', '/Users/x/repo/config.json', '/Users/x/repo/hosts.yml', '/Users/x/repo/.kube-notes/config']) {
      expect(isDeniedSecretPath(p), p).toBe(false)
    }
  })
  it('ordinary files are not denied, including near misses', () => {
    for (const name of ['shot.png', 'report.pdf', 'env.md', 'environment.ts', 'my.env-notes.txt', 'key.json', 'monkey.json', 'keys.md', 'profile.json', 'cos-profile.md', 'id-report.txt', 'identity.json', 'my_id_dsa_notes.md', 'rsa.txt', 'pem.txt', 'keyboard.ts', 'netrc.md', 'npmrc.txt', 'my-credentials.txt', 'ssh.md', 'keychain.md']) {
      expect(isDeniedSecretPath(at('out', name)), name).toBe(false)
    }
    expect(isDeniedSecretPath(at('ssh', 'notes.md')), 'a folder named ssh, not .ssh').toBe(false)
    expect(isDeniedSecretPath(at('aws', 'notes.md'))).toBe(false)
  })
  it('never throws on junk', () => {
    expect(isDeniedSecretPath('')).toBe(false)
    expect(isDeniedSecretPath(undefined as unknown as string)).toBe(false)
    expect(isDeniedSecretPath(at('missing', 'nothing.png'))).toBe(false)
  })
  it('the card text', () => { expect(SECRET_FILE_NOTICE).toBe('Not shown: this file may hold secrets') })
})

describe('isDeniedSecretPath: after canonicalising', () => {
  for (const name of ['.envrc', '.env_backup', 'id_dsa', 'id_xmss']) {
    it(`an innocent symlink to ${name} is denied`, () => {
      mkdirSync(at('canonical-contract'), { recursive: true })
      const target = at('canonical-contract', name)
      const alias = at('canonical-contract', `preview-${name.replace(/[^a-z]/g, '')}.png`)
      writeFileSync(target, 'fixture')
      symlinkSync(target, alias)
      expect(isDeniedSecretPath(alias)).toBe(true)
    })
  }
  it('an innocent directory symlink into a secret directory is denied', () => {
    mkdirSync(at('directory-contract', 'secrets'), { recursive: true })
    writeFileSync(at('directory-contract', 'secrets', 'preview.png'), 'fixture')
    symlinkSync(at('directory-contract', 'secrets'), at('directory-contract', 'assets'))
    expect(isDeniedSecretPath(at('directory-contract', 'assets', 'preview.png'))).toBe(true)
  })
  it('a secret-named symlink to an ordinary file stays denied', () => {
    mkdirSync(at('lexical-contract'), { recursive: true })
    writeFileSync(at('lexical-contract', 'ordinary.png'), 'fixture')
    symlinkSync(at('lexical-contract', 'ordinary.png'), at('lexical-contract', '.envrc'))
    symlinkSync(at('lexical-contract', 'ordinary.png'), at('lexical-contract', 'id_dsa'))
    expect(isDeniedSecretPath(at('lexical-contract', '.envrc'))).toBe(true)
    expect(isDeniedSecretPath(at('lexical-contract', 'id_dsa'))).toBe(true)
  })
  it('a symlink with an innocent name pointing at a secret is denied', () => {
    mkdirSync(at('out'), { recursive: true }); mkdirSync(at('.ssh'), { recursive: true })
    writeFileSync(at('.env'), 'TOKEN=fixture'); writeFileSync(at('.ssh', 'id_ed25519'), 'fixture key')
    symlinkSync(at('.env'), at('out', 'readme.txt'))
    symlinkSync(at('.ssh', 'id_ed25519'), at('out', 'diagram.png'))
    symlinkSync(at('.ssh'), at('out', 'assets'))
    expect(isDeniedSecretPath(at('out', 'readme.txt'))).toBe(true)
    expect(isDeniedSecretPath(at('out', 'diagram.png'))).toBe(true)
    expect(isDeniedSecretPath(at('out', 'assets', 'id_ed25519')), 'a directory link into .ssh').toBe(true)
  })
  it('a symlink to an ordinary file stays allowed', () => {
    writeFileSync(at('out', 'shot.png'), 'png'); symlinkSync(at('out', 'shot.png'), at('out', 'alias.png'))
    expect(isDeniedSecretPath(at('out', 'alias.png'))).toBe(false)
  })
})
