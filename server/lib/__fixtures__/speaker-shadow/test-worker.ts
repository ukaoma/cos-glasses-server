// The shadow worker's real child entry (workerMain: stdin job, stdout outcome, parent watch)
// with ONE substitution: the model check. Real model bytes cannot be faked, and the fake CLI
// never reads them. Spawned by speaker-shadow.test.ts exactly as the server spawns the worker.
import { workerMain } from '../../speaker-shadow-worker.js'

void workerMain({ verifyModels: async dir => ({ ok: true, dir, bytes: 0 }) })
