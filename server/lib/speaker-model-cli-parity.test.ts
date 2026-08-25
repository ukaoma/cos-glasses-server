import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SPEAKER_MODEL_FILENAME, speakerModelCandidates } from './speaker-embeddings.js'

/**
 * `bin/cli.cjs --setup-speaker-model` downloads the voiceprint model into the
 * same path the server later reads it from. Those are two files that must agree
 * on one filename, and they cannot import each other: the CLI is CJS, the server
 * is TS/ESM.
 *
 * That is the duplicated-source-of-truth shape. Both drift directions are silent
 * and they fail identically to the user: the CLI reports "Installed and
 * verified", the server finds nothing, and speaker ID degrades to amplitude
 * fallback without an error anywhere. That is precisely the failure a beta user
 * reported on 2026-08-25 as "voice training didn't work".
 */

const cli = () => readFileSync(new URL('../../bin/cli.cjs', import.meta.url).pathname, 'utf8')

describe('the CLI installs the model where the server looks for it', () => {
  it('uses the same filename the server resolves', () => {
    const src = cli()
    const declared = src.match(/filename:\s*'([^']+\.onnx)'/)?.[1]
    expect(declared, 'the CLI does not declare a model filename').toBeTruthy()
    expect(declared, 'CLI filename has drifted from SPEAKER_MODEL_FILENAME')
      .toBe(SPEAKER_MODEL_FILENAME)
  })

  it('installs into a directory the server actually searches', () => {
    // The CLI writes to join(CONFIG_DIR, 'models'); the server searches
    // ~/.cos-glasses/models. Assert the server's candidate list really contains
    // that location rather than trusting the two comments agree.
    const inHome = speakerModelCandidates().find((p) => p.includes('.cos-glasses'))
    expect(inHome, 'the server no longer searches the data home').toBeTruthy()
    expect(inHome).toContain('models')
    expect(inHome).toContain(SPEAKER_MODEL_FILENAME)
    expect(cli(), 'the CLI no longer targets the models dir').toMatch(/join\(CONFIG_DIR, 'models'\)/)
  })

  it('pins an integrity hash and refuses to install without a match', () => {
    const src = cli()
    expect(src, 'no SHA-256 pin on a file handed to a native loader')
      .toMatch(/sha256:\s*'[0-9a-f]{64}'/)
    // The verify must gate the install: the rename cannot precede the check.
    const checkAt = src.indexOf('Checksum mismatch')
    const renameAt = src.indexOf('renameSync(partial, dest)')
    expect(checkAt).toBeGreaterThan(-1)
    expect(renameAt, 'the model is installed before it is verified').toBeGreaterThan(checkAt)
  })

  it('is synchronous, so the command cannot fall through into server startup', () => {
    // The first version was `async` and fire-and-forget. bin/cli.cjs is CJS with
    // no top-level await, so the whole file kept executing and the download
    // never landed. Caught by running it, not by reading it.
    const src = cli()
    expect(src, 'setupSpeakerModel is async again').not.toMatch(/async function setupSpeakerModel/)
    expect(src, 'the handler no longer exits').toMatch(/process\.exit\(setupSpeakerModel\(\)\)/)
  })
})
