/**
 * 6.92.0 (plan r3, A-W10): the canonical filler fixture's cases, one source of truth for the server's
 * filler pass and COS Control's port. `want` is written by hand, so the generated fixture is checked
 * against an expectation, never only against the function that produced it.
 *
 *   scope "both"    the token rules alone (stripDisfluencies). Control's port must match 100%.
 *   scope "server"  the server's outbound filler step (stripFillersIfEnglish: the language gate,
 *                   then the token rules). The gate is the server's own detector, so these rows are
 *                   not a parity target; Control gates with its own detector.
 *
 * Synthetic, fictional text only. Regenerate the fixture with
 *   npx tsx server/scripts/generate-dictation-fillers-fixture.ts
 * and update the sha256 pinned in dictation-fillers-fixture.test.ts (and in COS Control's copy).
 */
import { stripDisfluencies, stripFillersIfEnglish } from './dictation-fillers.js'

export type FillerFixtureScope = 'both' | 'server' | 'client'
export interface FillerFixtureCase { id: string; scope: FillerFixtureScope; group: 'english' | 'exemption' | 'language'; input: string; want: string }
export interface FillerFixtureRow { id: string; scope: FillerFixtureScope; group: FillerFixtureCase['group']; input: string; expected: string }

/** The 6.79.1 filler-pass tables (dictation-fillers.test.ts), as [input, want]. */
const ENGLISH: Array<[string, string]> = [
  ['We need uh the deck by Friday', 'We need the deck by Friday'],
  ['Send the um the update', 'Send the the update'],
  ['ship it er tomorrow', 'ship it tomorrow'],
  ['ship it erm tomorrow', 'ship it tomorrow'],
  ['Book the room uhm at noon', 'Book the room at noon'],
  ['So, um, we should ship', 'So, we should ship'],
  ['The plan, uh, is solid', 'The plan, is solid'],
  ['Um, I think we are ready', 'I think we are ready'],
  ['Uh, can you check the build', 'Can you check the build'],
  ['um, so we go', 'so we go'],
  ['Okay. Um, let us start', 'Okay. Let us start'],
  ['Done? Uh, maybe not', 'Done? Maybe not'],
  ['Hmm. Let me think about it.', 'Let me think about it.'],
  ['Okay. Um. Let us go', 'Okay. Let us go'],
  ['Mhm, sure thing', 'Sure thing'],
  ['I think, uh.', 'I think.'],
  ['Is that right, hmm?', 'Is that right?'],
  ['Let us ship it, um', 'Let us ship it'],
  ['Let us ship it um.', 'Let us ship it.'],
  ['Call (uh) Dana', 'Call () Dana'],
  ['It was um... great', 'It was great'],
  ['It was um… great', 'It was great'],
  ['well — um — we could', 'well — we could'],
  ['Um... I forgot', 'I forgot'],
  ['um um the deck', 'the deck'],
  ['Uh, um, so the plan', 'So the plan'],
  ['Ummm, yes', 'Yes'],
  ['the hmmm thing', 'the thing'],
  ['it is ahh fine', 'it is fine'],
  ['Ahh, I see', 'I see'],
  ['Mm, that works', 'That works'],
  ['that uhh works', 'that works'],
  ['He said "um, no"', 'He said "no"'],
  ['First line\num, second line', 'First line\nsecond line'],
  ['First line\nUm, second line', 'First line\nSecond line'],
  ['Ask, um, Ah Kow to join', 'Ask, Ah Kow to join'],
  ['uh uh the deck', 'the deck'],
  ['uh hmm let me think', 'let me think'],
  ['Uh hmm, the plan', 'The plan'],
  ['Hmm. Let me check ... and Ah Kim\'s notes', 'Let me check ... and Ah Kim\'s notes'],
  ['at 5 p.m. uh we meet', 'at 5 p.m. we meet'],
  ['e.g. um the deck', 'e.g. the deck'],
  ['We met Mr. uh Jones', 'We met Mr. Jones'],
  ['I spoke to the U.S. uh team', 'I spoke to the U.S. team'],
  ['Smith Jr. um signed', 'Smith Jr. signed'],
  ['I think, Um, we should', 'I think, we should'],
  ['Wait... Uh, maybe', 'Wait... maybe'],
  ['Wait. Uh, maybe', 'Wait. Maybe'],
  ['um,, so we go', 'so we go'],
  ['Bring an umbrella and keep going ahead', 'Bring an umbrella and keep going ahead'],
  ['To err is human', 'To err is human'],
  ['The hummingbird hummed', 'The hummingbird hummed'],
  ['Erma and Ahmed will join', 'Erma and Ahmed will join'],
  ['Check the umami and the uhaul', 'Check the umami and the uhaul'],
  ['Uh-oh, the build broke', 'Uh-oh, the build broke'],
  ['She said uh-huh and mm-hmm', 'She said uh-huh and mm-hmm'],
  ['UM beat ER in the final, AH was close', 'UM beat ER in the final, AH was close'],
  ['HMM is the model name', 'HMM is the model name'],
  ['Use a 5 mm bolt and a 10mm spacer', 'Use a 5 mm bolt and a 10mm spacer'],
  ['Ask Ah Kow to join the call', 'Ask Ah Kow to join the call'],
  ['Loop in Er Lin and Hm Tran', 'Loop in Er Lin and Hm Tran'],
  ['The note from Mm Patel is attached', 'The note from Mm Patel is attached'],
  ['We met Mr. Ah and Ms. Er yesterday', 'We met Mr. Ah and Ms. Er yesterday'],
  ['Dr. Er said the scan is clear', 'Dr. Er said the scan is clear'],
  ['Dr. Er said', 'Dr. Er said'],
  ['Dr. Er said yes', 'Dr. Er said yes'],
  ['Ask Jr. Ah and Sr. Um', 'Ask Jr. Ah and Sr. Um'],
  ['Ship it to the U.S. Um, team first', 'Ship it to the U.S. Um, team first'],
  ['Dr. Er, the surgeon, called', 'Dr. Er, the surgeon, called'],
  ['Meet with J. Ah tomorrow', 'Meet with J. Ah tomorrow'],
  ['Ask Mrs. Um and Prof. Hm about it', 'Ask Mrs. Um and Prof. Hm about it'],
  ['"um" is a filler word', '"um" is a filler word'],
  ['Say “uh” less often', 'Say “uh” less often'],
  ['He said uh huh and left', 'He said uh huh and left'],
  ['uh oh, the build broke', 'uh oh, the build broke'],
  ['She went mm hmm and nodded', 'She went mm hmm and nodded'],
  ['Plain text with no hesitation.', 'Plain text with no hesitation.'],
  [', and a leading comma stays when nothing was removed', ', and a leading comma stays when nothing was removed'],
]

/** 6.92.0 token exemptions and quote rules: scope "both". A filler that is part of a path, handle or code token is kept. */
const EXEMPTION: Array<[string, string]> = [
  ['open src/um.txt now', 'open src/um.txt now'],
  ['cd ~/uh and list it', 'cd ~/uh and list it'],
  ['ping @uh about the deck', 'ping @uh about the deck'],
  ['the tag #um is trending', 'the tag #um is trending'],
  ['echo $um in the shell', 'echo $um in the shell'],
  ['set the my_um field', 'set the my_um field'],
  ['rename it to .um before lunch', 'rename it to .um before lunch'],
  ['connect to host:um today', 'connect to host:um today'],
  ['run um.py again', 'run um.py again'],
  ['open port um:8080 first', 'open port um:8080 first'],
  ['the um/bin folder', 'the um/bin folder'],
  ['mail um@example.com later', 'mail um@example.com later'],
  ['the um_id column', 'the um_id column'],
  ['issue um#12 is open', 'issue um#12 is open'],
  ['the um$ variable', 'the um$ variable'],
  ['pass the -um flag', 'pass the -um flag'],
  // A sentence-final period or colon is not part of a token.
  ['Let us ship it um.', 'Let us ship it.'],
  ['The reason is um: we ran out', 'The reason is: we ran out'],
  ['src/um.txt and um, the notes', 'src/um.txt and the notes'],
  // Meaning, places and quotes.
  ['Uh-oh, the build broke', 'Uh-oh, the build broke'],
  ['We flew to Umbria in May', 'We flew to Umbria in May'],
  ['uh huh, sounds good', 'uh huh, sounds good'],
  ['she said "um" twice', 'she said "um" twice'],
  ['He said "um, no"', 'He said "no"'],
  ['Erm, the uhaul is here', 'The uhaul is here'],
]

/** 6.92.0 language gate: scope "server". Not English goes out as said; English still loses its fillers. */
const LANGUAGE: Array<[string, string]> = [
  ['Wir treffen uns um 5 Uhr', 'Wir treffen uns um 5 Uhr'],
  ['um drei Uhr', 'um drei Uhr'],
  ['Er kommt morgen.', 'Er kommt morgen.'],
  ['Er ist heute nicht da', 'Er ist heute nicht da'],
  ['Ich komme um 9 Uhr', 'Ich komme um 9 Uhr'],
  ['Er hat um 8 Uhr angerufen', 'Er hat um 8 Uhr angerufen'],
  ['Comprei um carro novo', 'Comprei um carro novo'],
  ['um carro', 'um carro'],
  ['Ela tem um gato', 'Ela tem um gato'],
  ['Vamos sair um pouco', 'Vamos sair um pouco'],
  ['Isso custa um real', 'Isso custa um real'],
  ['Han er hjemme nu', 'Han er hjemme nu'],
  ['Det er fint', 'Det er fint'],
  ['Er is een probleem', 'Er is een probleem'],
  ['Er komt morgen', 'Er komt morgen'],
  ['ship it er tomorrow', 'ship it tomorrow'],
  ['We need um the deck by Friday', 'We need the deck by Friday'],
  ['Um, sure thing', 'Sure thing'],
  ['er, the plan works', 'the plan works'],
  ['Ask Marco um about the pricing', 'Ask Marco about the pricing'],
  ['um the MIT report', 'the MIT report'],
  ['Send the deck to Dana, um, por favor', 'Send the deck to Dana, por favor'],
  // The known cost: an inline um with no English function word beside it is kept.
  ['um 5 pm works', 'um 5 pm works'],
]

const pad = (n: number) => String(n).padStart(3, '0')
export const FILLER_FIXTURE_CASES: FillerFixtureCase[] = [
  ...ENGLISH.map(([input, want], i) => ({ id: `en${pad(i + 1)}`, scope: 'both' as const, group: 'english' as const, input, want })),
  ...EXEMPTION.map(([input, want], i) => ({ id: `ex${pad(i + 1)}`, scope: 'both' as const, group: 'exemption' as const, input, want })),
  ...LANGUAGE.map(([input, want], i) => ({ id: `la${pad(i + 1)}`, scope: 'server' as const, group: 'language' as const, input, want })),
]

/** The server function a row's scope names. */
export function fillerFixtureOutput(scope: FillerFixtureScope, input: string): string {
  return scope === 'server' ? stripFillersIfEnglish(input) : stripDisfluencies(input)
}

/** The fixture file's exact text: generated by the server functions, never by hand. */
export function renderFillerFixture(): string {
  const rows: FillerFixtureRow[] = FILLER_FIXTURE_CASES.map(c => ({ id: c.id, scope: c.scope, group: c.group, input: c.input, expected: fillerFixtureOutput(c.scope, c.input) }))
  return JSON.stringify({
    schema: 1,
    generator: 'server/scripts/generate-dictation-fillers-fixture.ts',
    tokens: ['um+', 'uhm', 'uh+', 'er', 'erm', 'ah+', 'hm+', 'mm+', 'mhm'],
    scopes: {
      both: 'stripDisfluencies: the token rules alone; a port must match every row',
      server: 'stripFillersIfEnglish: the server language gate, then the token rules',
      client: 'reserved for client-only rows; the server generates none',
    },
    rows,
  }, null, 2) + '\n'
}
