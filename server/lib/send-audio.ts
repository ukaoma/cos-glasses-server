// Serving a retained WAV back to a reviewer.
//
// WHY THIS EXISTS AT ALL, because `res.sendFile(path)` looks like it would do.
//
// `send` (what Express delegates to) defaults to `dotfiles: 'ignore'`, and when
// no `root` option is given it applies that policy to the ENTIRE absolute path,
// not to the part a request supplied:
//
//   parts = normalize(path).split(sep)      // send/index.js — the whole path
//   if (containsDotFile(parts)) ... error(404)
//
// The COS data home is `~/.cos-glasses/data` by default. `.cos-glasses` is a
// dot component, so every audio route 404'd on every default install — the play
// button rendered, the fetch failed, and nothing was heard. Verified directly
// against the installed module: `{}` -> 404, `{dotfiles:'allow'}` -> resolves.
//
// The tests never caught it because they point `COS_DATA_DIR` at
// `mktemp -d` (`/var/folders/...`), which structurally CANNOT contain a dot
// component. The suite was green and the feature was dead. `send-audio.test.ts`
// serves from a dot-directory on purpose.
//
// 'allow' is safe here rather than merely convenient: the dot component is ours
// (the data home), and nothing a caller supplies can introduce one. Every route
// resolves its path through a validator first — `sessionId` and speaker names
// match `[A-Za-z0-9:_-]`, chunk indices are integers, and the archive helpers
// re-check containment before returning. The path handed to this function is
// already known to exist and to live under the data dir.

import type { Response } from 'express'

/**
 * Send a WAV that has already been resolved and containment-checked.
 *
 * Callers must have verified the file exists; a missing file here surfaces as
 * send's own 404 HTML rather than the route's JSON, which is exactly the
 * confusing failure this module documents.
 */
export function sendAudioFile(res: Response, path: string): void {
  res.type('audio/wav')
  // See the file header: without this, any data home under a dot-directory 404s.
  res.sendFile(path, { dotfiles: 'allow' })
}
