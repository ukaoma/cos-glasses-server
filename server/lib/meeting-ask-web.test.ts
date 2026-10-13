import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { publicWebUrl, publicSearchQueryAllowed, parseWebEvidence, WEB_HOOK_SOURCE, publicSearchGate, publicIntent, explicitWebRequest, userWebQuery, resolveMeetingWebQuery, type WebGateReason } from './meeting-ask-web.js';
import { runBoundedSearch } from './meeting-ask-search-process.js';
describe('bounded public meeting search', () => {
    it('fact checks and public comparisons request retrieval and retain the typed public subject', () => {
        expect(explicitWebRequest('Can you fact check this')).toBe(true);
        expect(publicIntent('Compare cost to other similar fixes in that area')).toBe(true);
        expect(userWebQuery('Can you fact check this')).toBeNull();
        expect(publicSearchGate({question:'Can you fact check this',query:'New York firehouse 750000'}).ok).toBe(false);
        const priorQuestions=['Fact-check New York firehouse roof repair 750000'];
        expect(userWebQuery('Compare cost to other similar fixes in that area',priorQuestions)).toBe('New York firehouse roof repair 750000');
        expect(publicSearchGate({question:'Compare cost to other similar fixes in that area',query:'New York firehouse roof repair cost',priorQuestions})).toEqual({ok:true,query:'New York firehouse roof repair cost'});
        expect(publicSearchGate({question:'Fact-check my confidential client budget',query:'client budget'}).ok).toBe(false);
        expect(explicitWebRequest('Summarize the decisions')).toBe(false);
    });
    it('only accepts public http links, no credentials/private addresses', () => { for (const u of ['file:///tmp/x', 'http://localhost', 'http://127.0.0.1', 'https://10.1.1.1', 'http://[::1]', 'https://user:pass@example.com', 'https://foo.local', 'http://192.168.0.1', 'http://example.com:8080'])
        expect(publicWebUrl(u)).toBeNull(); expect(publicWebUrl('https://developer.apple.com/documentation')).toBe('https://developer.apple.com/documentation'); });
    it('will not turn private names or evidence into public queries', () => { expect(publicSearchQueryAllowed("When is Taylor birthday?", 'Taylor birthday')).toBe(false); expect(publicSearchQueryAllowed('Search web for Apple documentation', 'Apple documentation')).toBe(true); expect(publicSearchQueryAllowed('Search web for Apple documentation', 'Taylor salary Apple documentation')).toBe(false); expect(publicSearchQueryAllowed('What did we decide?', 'Apple documentation')).toBe(false); });
    it('keeps generated search summary separate from authoritative observed result links', () => { const sources = parseWebEvidence({ results: [{ content: [{ title: 'Apple doc', url: 'https://developer.apple.com/' }] }, 'Search summary mentions facts.'] }, 'Apple docs'); expect(sources).toHaveLength(2); expect(sources[0].url).toBeUndefined(); expect(sources[1].text).toContain('page not fetched'); expect(sources[1].retrievalId).toBe(sources[0].retrievalId); });
    it('enforces single WebSearch before tool execution and rejects every other tool', () => { const d = mkdtempSync(join(tmpdir(), 'web-hook-test-')); try {
        const p = join(d, 'hook.cjs');
        writeFileSync(p, WEB_HOOK_SOURCE);
        writeFileSync(join(d, "query.txt"), "public test");
        const run = (tool_name: string) => { const r = spawnSync(process.execPath, [p], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input:{query:'public test'} }), encoding: 'utf8' }); expect(r.status).toBe(0); return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision; };
        expect(run('Bash')).toBe('deny');
        expect(run('WebSearch')).toBe('allow');
        expect(run('WebSearch')).toBe('deny');
        expect(readFileSync(join(d, 'events.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3);
    }
    finally {
        rmSync(d, { recursive: true, force: true });
    } });
    it('cancels retrieval process and confirms its group exited promptly', async () => { const c = new AbortController(); const at = Date.now(); const p = runBoundedSearch(process.execPath, ['-e', 'setInterval(()=>{},10000)'], tmpdir(), c.signal); setTimeout(() => c.abort(), 30); await expect(p).rejects.toThrow('cancelled'); expect(Date.now() - at).toBeLessThan(1500); });
});
// 6.70.0. Each "observed" row is a question asked in the Oct 10 live test on 6.69.0 that was withheld.
const OBSERVED_ALLOWED: Array<[name: string, question: string, query: string, prior: string[], sent: string]> = [
    ['observed 1: "who is" with a split brand name', 'Who is alt coin daily?', 'Altcoin Daily', [], 'Altcoin Daily'],
    ['observed 1: model switch sentence before the question', "Let's try with sonnet. Who is alt coin daily?", 'Altcoin Daily YouTube channel', [], 'Altcoin Daily YouTube channel'],
    ['observed 2: "our competitor" no longer blocks', "What's the latest news on our competitor Acme?", 'Acme latest news', [], 'Acme latest news'],
    ['observed 2: the possessive is dropped, not sent', "What's the latest news on our competitor Acme?", 'our competitor Acme news', [], 'competitor Acme news'],
    ['observed 3: follow-up borrows the user\'s earlier question', 'Run the web search', 'Altcoin Daily', ['Who are these people?', 'Who is alt coin daily?'], 'Altcoin Daily'],
    ['our client X searches X', 'Search the web for our client Acme Corp', 'our client Acme Corp', [], 'Acme Corp'],
    ['follow-up "look it up"', 'look it up', 'alt coin daily', ['Who is alt coin daily?'], 'alt coin daily'],
    ['follow-up "Google it"', 'Google it', 'Altcoin Daily', ['Who is alt coin daily?'], 'Altcoin Daily'],
    ['followers and "how many"', 'How many subscribers does Altcoin Daily have?', 'Altcoin Daily subscribers', [], 'Altcoin Daily subscribers'],
    ['founded', 'Who founded Shopify?', 'Shopify founder', [], 'Shopify founder'],
    ['known for', 'What is Acme known for?', 'Acme', [], 'Acme'],
    ['a typed word the query splits', 'Search the web for altcoin daily', 'alt coin daily', [], 'alt coin daily'],
    ['6.69.0 allowed case still allowed', 'Search web for Apple documentation', 'Apple documentation', [], 'Apple documentation'],
];
const WITHHELD: Array<[name: string, question: string, query: string, prior: string[], reason: WebGateReason]> = [
    ['transcript-only name in query', 'Who are these people?', 'Joseph Wharton Charles Elliot', [], 'not_user_words'],
    ['screenshot OCR-only words in query', 'Who is alt coin daily?', 'Altcoin Daily MASSIVE WARNING', [], 'not_user_words'],
    ['follow-up never lends transcript names', 'Run the web search', 'Joseph Wharton', ['Who are these people?', 'Who is alt coin daily?'], 'not_user_words'],
    ['follow-up reads only the last three questions', 'Run the web search', 'Acme', ['Who is Acme?', 'Who are they?', 'Who is that?', 'And them?'], 'not_user_words'],
    ['a question that names something does not borrow', 'Who is Shopify?', 'Altcoin Daily', ['Who is alt coin daily?'], 'not_user_words'],
    ['6.69.0 meeting question still withheld', 'What did we decide?', 'Apple documentation', [], 'not_user_words'],
    ['secret in the question', 'Search the web for sk-abcdefghijklmnop', 'sk-abcdefghijklmnop', [], 'secret'],
    ['secret already redacted in the stored question', 'Search the web for sk-REDACTED pricing', 'pricing', [], 'secret'],
    ['secret in the query only', 'Search the web for Apple documentation', 'Apple documentation ghp_abcdefghijklmnopqrstuvwxyz0123', [], 'secret'],
    ['secret in a borrowed earlier question', 'Run the web search', 'docs', ['Search the web for sk-REDACTED docs'], 'secret'],
    ['salary', 'What is the average salary at Apple?', 'Apple salary', [], 'personal'],
    ['medical', 'Search the web for my medical diagnosis', 'medical diagnosis', [], 'personal'],
    ['address', "What is Jordan's address?", 'Jordan address', [], 'personal'],
    ['family term', "Who is Sam's wife?", 'Sam wife', [], 'personal'],
    ['birthday (6.69.0 case)', 'When is Taylor birthday?', 'Taylor birthday', [], 'personal'],
    ['personal word in a borrowed earlier question', 'Run the web search', 'Taylor', ['When is Taylor birthday?'], 'personal'],
    ['salary added by the query', 'Search web for Apple documentation', 'Taylor salary Apple documentation', [], 'personal'],
    ['no public intent', 'Thanks, that helps', 'Altcoin Daily', [], 'no_public_intent'],
    ['nothing specific to search', 'Run the web search', 'latest news', [], 'no_public_subject'],
];
describe('public search gate (6.70.0)', () => {
    it.each(OBSERVED_ALLOWED)('allows %s', (_name, question, query, prior, sent) => {
        expect(publicSearchGate({ question, query, priorQuestions: prior })).toEqual({ ok: true, query: sent });
        expect(publicSearchQueryAllowed(question, query, prior)).toBe(true);
    });
    it.each(WITHHELD)('withholds %s', (_name, question, query, prior, reason) => {
        const d = publicSearchGate({ question, query, priorQuestions: prior });
        expect(d.ok).toBe(false);
        expect(d.ok === false && d.reason).toBe(reason);
        expect(publicSearchQueryAllowed(question, query, prior)).toBe(false);
    });
    it('names the reason and an example in every withheld notice, without em dashes or arrows', () => {
        const notices = new Map<WebGateReason, string>();
        for (const [, question, query, prior, reason] of WITHHELD) {
            const d = publicSearchGate({ question, query, priorQuestions: prior });
            if (d.ok === false)
                notices.set(reason, d.notice);
        }
        expect([...notices.keys()].sort()).toEqual(['no_public_intent', 'no_public_subject', 'not_user_words', 'personal', 'secret']);
        const phrase: Record<WebGateReason, string> = { secret: 'key or token', personal: 'personal detail', no_public_intent: 'did not ask for public information', not_user_words: 'words you did not type', no_public_subject: 'nothing specific to search' };
        for (const [reason, notice] of notices) {
            expect(notice).toMatch(/^Public search was withheld: /);
            expect(notice).toContain(phrase[reason]);
            expect(notice).toContain('for example "');
            expect(notice).not.toMatch(/[—→]/);
        }
        expect(new Set(notices.values()).size).toBe(5);
    });
    it('recognizes public intent by one rule and not meeting chatter', () => {
        for (const q of ['Who is alt coin daily?', "What's Shopify?", 'Where was it founded', 'How does Square work', 'How many followers does it have', 'When did Toast go public', 'Which is cheaper', 'What is Acme known for', 'look it up', 'Find Altcoin Daily', 'Who is the CEO', 'Their website?'])
            expect(publicIntent(q), q).toBe(true);
        for (const q of ['Thanks, that helps', 'Summarize the decisions', 'Did Maya send the draft', 'Who should own this', 'Catch me up'])
            expect(publicIntent(q), q).toBe(false);
    });
    it('treats only a plain request for the web as explicit', () => {
        for (const q of ['Run the web search', 'Search the web for Altcoin Daily', 'Can you google Altcoin Daily?', 'Google it', 'look it up online', 'Find it on the web', 'Search the internet for Toast'])
            expect(explicitWebRequest(q), q).toBe(true);
        for (const q of ['What does our web team think?', 'What is our Google Ads spend?', 'Who is alt coin daily?', 'look it up', 'search that'])
            expect(explicitWebRequest(q), q).toBe(false);
    });
    it('builds the explicit query from the user\'s own words only, newest earlier question first, last three only', () => {
        expect(userWebQuery('Run the web search', ['Who are these people?', "Let's try with sonnet. Who is alt coin daily?"])).toBe('alt coin daily');
        expect(userWebQuery('Search the web for Google Cloud pricing')).toBe('Google Cloud pricing');
        expect(userWebQuery('Search the web for our client Acme Corp')).toBe('Acme Corp');
        expect(userWebQuery('Run the web search', ['Who is Acme?', 'Who are they?', 'Who is that?', 'And them?'])).toBeNull();
        expect(userWebQuery('Run the web search')).toBeNull();
    });
    it('substitutes the user\'s words only for an explicit request whose query added words, never past a personal or secret check', () => {
        const swapped = resolveMeetingWebQuery({ question: 'Search the web for alt coin daily', query: 'Altcoin Daily crypto MASSIVE WARNING 2026', explicitQuery: 'alt coin daily' });
        expect(swapped.query).toBe('alt coin daily');
        expect(swapped.notices.join(' ')).toContain('your words "alt coin daily"');
        expect(resolveMeetingWebQuery({ question: 'Who is alt coin daily?', query: 'Altcoin Daily crypto' })).toEqual({ query: null, notices: [expect.stringContaining('words you did not type')] });
        expect(resolveMeetingWebQuery({ question: 'Search the web for my wife Taylor', query: 'Taylor', explicitQuery: 'Taylor' }).query).toBeNull();
        expect(resolveMeetingWebQuery({ question: 'Search the web for sk-REDACTED', query: 'pricing', explicitQuery: 'pricing' }).query).toBeNull();
        // The substitute passes the same gate: a bad explicit query is refused even when the planner's query only added words.
        expect(resolveMeetingWebQuery({ question: 'Search the web for alt coin daily', query: 'crypto', explicitQuery: 'Taylor birthday' })).toEqual({ query: null, notices: [expect.stringContaining('words you did not type')] });
    });
});


describe('average comparison follow-ups',()=>{
 it('treats how much more than average as external verification, with no bare subject exported',()=>{
  expect(publicIntent('How much more is that than the average?')).toBe(true);
  expect(explicitWebRequest('How much more is that than the average?')).toBe(true);
  expect(userWebQuery('How much more is that than the average?')).toBeNull();
 });
});

describe('private cost claims',()=>{
 it.each(['Fact check our client contract for 25000','Compare our internal budget with the average','Fact check my employee salary'])('does not export typed private details: %s',question=>expect(publicSearchGate({question,query:question}).ok).toBe(false));
});
