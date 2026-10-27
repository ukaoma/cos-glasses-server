// A stand-in for the sherpa speaker runtime (extractor + embedding manager), so tests can run the REAL
// enrolEmbedding / enrollEmbeddingsBatch / persist / eviction code against a real temp profile store
// without the 26 MB model. It copies the one behaviour of sherpa's SpeakerEmbeddingManager the enrolment
// code depends on: `add` returns false when the name is already registered (the caller then rebuilds).
// Install with `__installSpeakerRuntimeForTests(fakeSpeakerRuntime())` from speaker-embeddings.ts.
export interface FakeSpeakerRuntime {
  extractor: { dim: number }
  manager: {
    add(entry: { name: string; v: Float32Array }): boolean
    contains(name: string): boolean
    remove(name: string): boolean
    getAllSpeakerNames(): string[]
    search(): string
    verify(): boolean
  }
  /** What the manager holds, by name. */
  speakers: Map<string, Float32Array>
}

export function fakeSpeakerRuntime(dim = 192): FakeSpeakerRuntime {
  const speakers = new Map<string, Float32Array>()
  return {
    extractor: { dim },
    speakers,
    manager: {
      add({ name, v }) {
        if (speakers.has(name)) return false
        speakers.set(name, Float32Array.from(v))
        return true
      },
      contains: name => speakers.has(name),
      remove: name => speakers.delete(name),
      getAllSpeakerNames: () => [...speakers.keys()],
      search: () => '',
      verify: () => false,
    },
  }
}
