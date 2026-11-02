// What the user shares in a meeting question (6.97.8): a pasted link is read as a page, and pasted text or a page that was read
// becomes meeting context, so the live cues' files arm can use it too. Both go through the same store as dropped files
// (MeetingAskStore.putFiles), so they are listed wherever dropped files are and every limit and the secret rule are the same.
//
// Privacy. Only what the user typed or pasted is used: the question text and the links in it. Nothing from the transcript,
// files, memory or earlier answers is ever read here. A page is redacted (redactSecrets) before it is stored and a paste has been
// redacted by normalizeAsk; a link that is not a clean public address is cut out of stored text (redactUnsafeLinks), because
// redactSecrets does not know every token parameter name. keepPastedContext is the last backstop: it refuses any file that still
// carries a key. The files belong to one meeting (session id), so a personal meeting's paste is only ever seen by that meeting's own cues.
import { createHash, randomUUID } from 'node:crypto';
import type { MeetingAskFile, MeetingAskSource } from '../../shared/meeting-ask.js';
import { redactSecrets } from './lens-gist-engines.js';
import { fetchPublicArticle, type PublicArticle } from './meeting-web-page.js';
import { READ_PAGE_PREFIX } from './meeting-ask-review.js';
import { publicAddress, pastedUrlKey, redactUnsafeLinks } from './meeting-ask-web.js';
import { isPastedFileId } from './meeting-ask-store.js';
import { AskError } from './live-cos-ask.js';

/** A question longer than this (links removed) is kept as meeting context for the live cues. */
export const PASTED_TEXT_MIN_CHARS = 400;
/** The most of a pasted question or a page that is kept as one file. The store allows 100,000 bytes; cues read passages of it. */
export const PASTED_FILE_MAX_CHARS = 12000;
/** Pasted-text and page files this server adds to one meeting. Dropped files are not counted. */
export const PASTED_FILES_PER_MEETING = 12;

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

export interface PastedPageRead {
    sources: MeetingAskSource[];
    /** Hosts whose page could not be read (blocked, too large, not an article, or too slow). */
    failedHosts: string[];
}
/** Read each link's page, at most PASTED_URL_MAX in parallel. `urls` must already have passed pastedPublicUrls. */
export async function readPastedPages(urls: readonly string[], options: { signal?: AbortSignal; focus?: readonly string[]; read?: typeof fetchPublicArticle } = {}): Promise<PastedPageRead> {
    const read = options.read ?? fetchPublicArticle;
    const pages: Array<PublicArticle | null> = await Promise.all(urls.map(url => read(url, publicAddress, options.signal, options.focus ?? []).catch(() => null)));
    const sources: MeetingAskSource[] = [], failedHosts: string[] = [];
    const retrievedAt = new Date().toISOString();
    pages.forEach((page, i) => {
        if (!page) {
            try {
                failedHosts.push(new URL(urls[i]).hostname.replace(/^www\./, ''));
            }
            catch { /* the address was checked before it got here */ }
            return;
        }
        const body = redactSecrets(page.text);
        const title = redactSecrets(page.title ?? '').trim().slice(0, 240) || new URL(page.url).hostname;
        sources.push({ id: `W${sources.length + 1}`, kind: 'web', title, url: page.url, text: READ_PAGE_PREFIX + body, retrievedAt, retrievalId: randomUUID() });
    });
    return { sources, failedHosts };
}
/** The one notice for pasted links that could not be read, in plain words. */
export function pastedReadFailedNotice(hosts: readonly string[]): string {
    const list = [...new Set(hosts)].join(' and ');
    return `Could not read the page${hosts.length > 1 ? 's' : ''} at ${list}. It may block automated readers, be too large, or not be an article. Nothing from the link was used.`;
}
export const PASTED_REFUSED_NOTICE = 'A link in your question was not opened because it is not a public web address, or it carries a key or token. Only public links without credentials are read.';
export const PASTED_OVER_LIMIT_NOTICE = 'Only the first two links in a question are read.';

/** The id of the meeting file for a page: the same page address (tracking parameters aside) is the same file. */
export function pastedPageFileId(url: string): string {
    return `web_${hash(pastedUrlKey(url)).slice(0, 16)}`;
}
/** The meeting file for a page that was read: the page title for the name, the address and the excerpt for the text. */
export function pastedPageFile(source: MeetingAskSource): MeetingAskFile | null {
    if (!source.url)
        return null;
    // The page's own address (final, after redirects) is cut to origin and path whatever it carried; the body goes through the link scrub.
    let address = '[link removed]';
    try {
        const u = new URL(source.url);
        address = u.origin + u.pathname;
    }
    catch { /* the address was checked before it got here */ }
    const text = `${address}\n\n${redactUnsafeLinks(redactSecrets(source.text.replace(READ_PAGE_PREFIX, '')))}`.slice(0, PASTED_FILE_MAX_CHARS);
    return { id: pastedPageFileId(source.url), revision: hash(text).slice(0, 16), name: flat(source.title).slice(0, 120) || 'Web page', status: 'ready', text };
}
/** "11:49" in this machine's time zone. */
function clock(ms: number): string {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}
/** The meeting file for text the user pasted (a question longer than PASTED_TEXT_MIN_CHARS once its links are removed), or null. */
export function pastedTextFile(question: string, atMs: number): MeetingAskFile | null {
    const withoutLinks = question.replace(/https?:\/\/\S+/gi, ' ');
    if (flat(withoutLinks).length <= PASTED_TEXT_MIN_CHARS)
        return null;
    // Stored text keeps no link that is not a clean public address (a ?access_token=... link is cut out, not kept).
    const text = redactUnsafeLinks(question.trim()).slice(0, PASTED_FILE_MAX_CHARS);
    return { id: `paste_${hash(text).slice(0, 16)}`, revision: hash(text).slice(0, 16), name: `Pasted text ${clock(atMs)}`, status: 'ready', text };
}
export interface PastedStore {
    files(sessionId: string): MeetingAskFile[];
    putFiles(sessionId: string, files: MeetingAskFile[]): MeetingAskFile[];
}
/** Add the files to the meeting. Never throws and never fails the answer: a file that cannot be kept comes back as a plain notice. */
export function keepPastedContext(store: PastedStore, sessionId: string, files: readonly MeetingAskFile[]): { kept: string[]; added: string[]; notices: string[] } {
    const kept: string[] = [], added: string[] = [], notices: string[] = [];
    let existing: MeetingAskFile[];
    try {
        existing = store.files(sessionId);
    }
    catch {
        return { kept, added, notices: ['What you shared could not be added to live cue context: the meeting files could not be read.'] };
    }
    const ours = existing.filter(f => isPastedFileId(f.id)).length;
    let newOnes = 0;
    for (const file of files) {
        const same = existing.find(f => f.id === file.id);
        if (same && same.revision === file.revision && same.status === 'ready') {
            kept.push(file.id);
            continue;
        }
        if (redactSecrets(file.text) !== file.text) {
            notices.push(`"${file.name}" was not added to live cue context because it contains a key or token.`);
            continue;
        }
        if (!same && ours + newOnes >= PASTED_FILES_PER_MEETING) {
            notices.push(`"${file.name}" was not added to live cue context: this meeting already holds ${PASTED_FILES_PER_MEETING} pasted items.`);
            continue;
        }
        try {
            store.putFiles(sessionId, [file]);
            kept.push(file.id);
            added.push(file.name);
            if (!same)
                newOnes += 1;
        }
        catch (e) {
            notices.push(`"${file.name}" could not be added to live cue context${e instanceof AskError && e.message === 'file_context_limit' ? ': the meeting file space is full' : ''}.`);
        }
    }
    return { kept, added, notices };
}
