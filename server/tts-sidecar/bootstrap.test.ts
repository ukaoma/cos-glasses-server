import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const bootstrap = resolve(import.meta.dirname, 'bootstrap.sh')
const roots: string[] = []

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cos-tts-bootstrap-'))
  roots.push(root)
  return root
}

function fakePython(path: string, version: string): void {
  const script = `#!/bin/bash
set -eu
if [ "\${1:-}" = "-c" ]; then
  printf '${version}\\n'
  exit 0
fi
if [ "\${1:-}" = "-m" ] && [ "\${2:-}" = "venv" ]; then
  mkdir -p "$3/bin"
  cp "$0" "$3/bin/python"
  printf '#!/bin/bash\\nprintf "%%s\\n" "$*" >> "\${FAKE_PIP_LOG}"\\n' > "$3/bin/pip"
  chmod +x "$3/bin/python" "$3/bin/pip"
  exit 0
fi
exit 64
`
  writeFileSync(path, script)
  chmodSync(path, 0o755)
}

function run(root: string, extraEnv: Record<string, string> = {}) {
  const bin = join(root, 'bin')
  const model = join(root, 'models')
  mkdirSync(bin, { recursive: true })
  return spawnSync('/bin/bash', [bootstrap], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      PATH: `${bin}:/usr/bin:/bin`,
      COS_TTS_MODEL_DIR: model,
      FAKE_PIP_LOG: join(root, 'pip.log'),
      ...extraEnv,
    },
  })
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('Kokoro bootstrap Python compatibility', () => {
  it('skips Python 3.13 and selects Python 3.12', () => {
    const root = testRoot()
    mkdirSync(join(root, 'bin'), { recursive: true })
    fakePython(join(root, 'bin/python3.13'), '3.13')
    fakePython(join(root, 'bin/python3.12'), '3.12')

    const result = run(root)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('with ' + join(root, 'bin/python3.12'))
    expect(readFileSync(join(root, 'pip.log'), 'utf8')).toContain('requirements.txt')
  })

  it('rejects an explicit incompatible interpreter before creating a venv', () => {
    const root = testRoot()
    const python313 = join(root, 'bin/python3.13')
    mkdirSync(join(root, 'bin'), { recursive: true })
    fakePython(python313, '3.13')

    const result = run(root, { COS_TTS_BOOTSTRAP_PYTHON: python313 })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('pinned Kokoro requires Python 3.11 or 3.12')
  })

  it('rebuilds a stale Python 3.13 venv with the compatible interpreter', () => {
    const root = testRoot()
    const bin = join(root, 'bin')
    const venvBin = join(root, 'models/.venv/bin')
    mkdirSync(bin, { recursive: true })
    mkdirSync(venvBin, { recursive: true })
    fakePython(join(bin, 'python3.12'), '3.12')
    fakePython(join(venvBin, 'python'), '3.13')
    writeFileSync(join(venvBin, 'pip'), '#!/bin/bash\nexit 99\n')
    chmodSync(join(venvBin, 'pip'), 0o755)

    const result = run(root)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('rebuilding incompatible Python 3.13 venv')
    expect(spawnSync(join(venvBin, 'python'), ['-c', 'x'], { encoding: 'utf8' }).stdout.trim()).toBe('3.12')
  })
})
