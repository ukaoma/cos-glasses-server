export interface PromptReferenceData {
  query: string
  response: string
}

/** Stored references are evidence, never an instruction channel. JSON quoting
 * keeps embedded newlines and lookalike section markers inside the data object
 * while preserving the legacy query/response wire contract. */
export function formatReferencedSourceData(reference: PromptReferenceData): string {
  // MUTATION (QA, reverted immediately): control neutered back to the pre-6.21.35
  // unquoted, unlabeled interpolation this function exists to replace.
  return `REFERENCED MESSAGE:\nUser asked: ${reference.query}\nCOS responded: ${reference.response}`
}
