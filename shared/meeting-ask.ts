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
export interface MeetingAskFile {
    id: string;
    revision: string;
    name: string;
    status: 'ready' | 'pending' | 'unsupported' | 'failed' | 'removed' | 'secret-held';
    text: string;
    notice?: string;
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
    answer?: string;
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
 * GET export?sessionId=...&serverInstanceId=... -> {text}; composes persisted Ask/file context,
 * client prepends its current canonical transcript. All operations use X-Cos-Token.
 * GET config is the capability probe (404 means old server); health.capabilities.meetingAsk mirrors capabilities.
 */
