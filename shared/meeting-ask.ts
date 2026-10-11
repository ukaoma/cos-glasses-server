/** Meeting assistance v2. Additive to the legacy /api/meetings/live-ask contract. */
export type MeetingAskAction = 'catch_up' | 'summary' | 'questions' | 'actions' | 'ask';
export type MeetingAskEngine = 'claude' | 'codex' | 'cursor' | 'ollama';
export interface MeetingAskModel {
    engine: MeetingAskEngine;
    model: string;
}
export interface MeetingAskTurn {
    id: number;
    elapsedMs: number;
    speaker: string;
    text: string;
}
/**
 * GET /api/meeting-ask/transcript. A live meeting answers from memory. A meeting that has ended (6.71.1)
 * answers from its saved record with ended: true, so it stays askable. 404 meeting_transcript_unavailable
 * only when no source holds its words.
 */
export interface MeetingAskTranscript {
    turns: MeetingAskTurn[];
    elapsedMs: number;
    notices: string[];
    ended?: true;
    /** When the recording stopped, if known. */
    endedAt?: string;
    source?: 'live' | 'active_file' | 'saved';
}
export interface MeetingAskFile {
    id: string;
    revision: string;
    name: string;
    status: 'ready' | 'pending' | 'unsupported' | 'failed' | 'removed' | 'secret-held';
    text: string;
    notice?: string;
    /** "phone" for a file the phone attached through POST files/media (6.71.1). Control's rows omit it. */
    origin?: 'phone';
}
export interface MeetingAskSource {
    id: string;
    kind: 'transcript' | 'memory' | 'meeting' | 'file' | 'web';
    title: string;
    text: string;
    turnId?: number;
    elapsedMs?: number;
    sessionId?: string;
    recordId?: string;
    memoryId?: string;
    domain?: string;
    month?: string;
    filename?: string;
    fileId?: string;
    revision?: string;
    url?: string;
    retrievedAt?: string;
    retrievalId?: string;
}
/** One labeled row of an answer. sources are the ids cited inside text, in first-cited order (T3, H1, W2, F1). */
export interface MeetingAskSection {
    label: string;
    text: string;
    sources: string[];
}
/**
 * Allowed labels per action, in render order. "So what" is required and first; any other label is
 * omitted when empty. questions repeats Ask, at most three times, each a question plus one short reason.
 * "You asked" is rendered by clients from the question and is never model output.
 */
export const MEETING_ASK_LABELS: Readonly<Record<MeetingAskAction, readonly string[]>> = {
    catch_up: ['So what', 'Decided', 'Open', 'You owe', 'Next'],
    summary: ['So what', 'Covered', 'Decided', 'Open', 'Next'],
    actions: ['So what', 'You owe', 'Others owe', 'Unowned', 'Proposed'],
    questions: ['So what', 'Ask', 'Ask', 'Ask'],
    ask: ['So what', 'Details'],
};
/** Citation ids inside a text, deduplicated, in first-cited order. */
export function meetingAskCitations(text: string): string[] {
    return [...new Set([...text.matchAll(/\[([THFW]\d+)\]/g)].map(m => m[1]))];
}
/**
 * The legacy answer string: one `**Label:** text` paragraph per section, inline citations kept. Rows are
 * separated by a blank line so CommonMark clients keep one row per paragraph.
 */
export function meetingAskAnswerMarkdown(sections: readonly MeetingAskSection[]): string {
    return sections.map(s => `**${s.label}:** ${s.text}`).join('\n\n');
}
function monthDay(date: string): string | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const month = m ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1] : undefined;
    return m && month ? `${month} ${Number(m[3])}` : null;
}
/**
 * The lens "From:" row, without the "From: " prefix. null when the answer cites only this meeting's
 * transcript (or nothing), so a meeting-only answer shows no sources. Otherwise one line naming what
 * else was cited, in a fixed order: "the web, example.com", "COS memory", "earlier meeting, Sep 30
 * pricing sync", "file, Q4 pricing.pdf", joined with "; ". Only ids a section cites count; uncited
 * siblings of a web search do not.
 */
export function meetingAskFromLine(sections: readonly MeetingAskSection[] | undefined, sources: readonly MeetingAskSource[], maxChars = 80): string | null {
    const cited = new Set((sections ?? []).flatMap(s => s.sources));
    const used = sources.filter(s => cited.has(s.id) && s.kind !== 'transcript');
    if (!used.length)
        return null;
    const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
    const parts: string[] = [];
    const web = used.filter(s => s.kind === 'web');
    if (web.length) {
        const hosts = unique(web.map(s => { try {
            return s.url ? new URL(s.url).hostname.replace(/^www\./, '') : '';
        }
        catch {
            return '';
        } }));
        parts.push(hosts.length ? `the web, ${hosts.slice(0, 2).join(', ')}` : 'the web');
    }
    if (used.some(s => s.kind === 'memory'))
        parts.push('COS memory');
    const meetings = unique(used.filter(s => s.kind === 'meeting').map(s => {
        const [title, date] = s.title.split(' · ');
        const day = date ? monthDay(date.trim()) : null;
        return `${day ? day + ' ' : ''}${title.trim()}`;
    }));
    if (meetings.length)
        parts.push(`earlier meeting, ${meetings.join(', ')}`);
    const files = unique(used.filter(s => s.kind === 'file').map(s => s.title.trim()));
    if (files.length)
        parts.push(`file, ${files.join(', ')}`);
    const line = parts.join('; ');
    return line.length > maxChars ? line.slice(0, maxChars - 1).trimEnd() + '…' : line;
}
export interface MeetingAskSubmit {
    requestId: string;
    sessionId: string;
    serverInstanceId: string;
    action: MeetingAskAction;
    question: string;
    elapsedMs: number;
    turns: MeetingAskTurn[];
    model?: MeetingAskModel;
    files?: Array<{
        id: string;
        revision: string;
    }>;
    retryOf?: string;
}
export type MeetingAskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface MeetingAskExchange {
    requestId: string;
    sessionId: string;
    serverInstanceId: string;
    action: MeetingAskAction;
    question: string;
    status: MeetingAskStatus;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    selectedModel: MeetingAskModel;
    model?: string;
    /** Composed from sections for clients that predate them. */
    answer?: string;
    /** Labeled rows of the answer (server 6.71.0 and later). */
    sections?: MeetingAskSection[];
    sources: MeetingAskSource[];
    notices: string[];
    throughMs: number;
    files: MeetingAskFile[];
    error?: string;
    retryOf?: string;
}
export interface MeetingAskCapabilities {
    protocolVersion: 2;
    durableHistory: true;
    attachmentContext: true;
    webRetrieval: boolean;
    /** 6.71.1: POST /api/meeting-ask/files/media turns uploaded media into meeting files. */
    phoneFiles?: true;
}
export interface MeetingAskConfig {
    protocolVersion: 2;
    serverInstanceId: string;
    selected: MeetingAskModel;
    models: Array<MeetingAskModel & {
        available: boolean;
        reason?: string;
    }>;
    web: {
        available: boolean;
        reason?: string;
        engine?: string;
    };
    capabilities: MeetingAskCapabilities;
}
/** All paths under /api/meeting-ask. GET config; PUT config {engine,model}.
 * POST requests MeetingAskSubmit -> 202 {exchange}; GET requests/:requestId -> {exchange}.
 * POST requests/:requestId/cancel {serverInstanceId} -> {exchange}.
 * GET history?sessionId=...&serverInstanceId=...&offset=0&limit=50&order=asc|desc -> {exchanges,nextOffset,files}.
 * PUT files {sessionId,serverInstanceId,files:MeetingAskFile[]} -> {files}. Upsert only; removed is explicit.
 * POST files/media {sessionId,serverInstanceId,media:[{id,name?}]} -> {files} (6.71.1, capabilities.phoneFiles):
 * media already uploaded through /api/media joins the meeting's file list as id "phone_<mediaId>", origin "phone".
 * GET export?sessionId=...&serverInstanceId=... -> {text}; composes persisted Ask/file context,
 * client prepends its current canonical transcript. All operations use X-Cos-Token.
 * GET config is the capability probe (404 means old server); health.capabilities.meetingAsk mirrors capabilities.
 */
