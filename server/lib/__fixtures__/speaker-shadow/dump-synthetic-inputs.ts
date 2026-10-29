// Writes the synthetic meeting's decide() inputs as JSON, for synthetic_python_decide.py:
//   npx tsx server/lib/__fixtures__/speaker-shadow/dump-synthetic-inputs.ts <out.json>
import { writeFileSync } from 'node:fs'
import { SR, SYNTHETIC_SECONDS, syntheticEmbeddings, syntheticNative, syntheticSegments } from './synthetic-meeting.js'

writeFileSync(process.argv[2], JSON.stringify({ total: SYNTHETIC_SECONDS * SR, segs: syntheticSegments(), native: syntheticNative().segments, embeddings: syntheticEmbeddings() }))
