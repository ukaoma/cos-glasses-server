/* COS Control Web: Work, built to Control 0.5.366's Work pane (WorkWorkspaceView.swift; stages 188-221, header 1523,
   tabs 1554, filters 1585, board 1818-1910, Your move 2013-2052, card 2365-2462, detail 2725-3052, Sort 3275-3514;
   WorkHandoffView.swift WorkHandoffState 88-133; ActivityWindow.swift WorkTaskEditor 50-200; WorkTaskContext.swift).
   Data: GET /api/work-board, /api/work-board/activity/open, /api/work-board/activity?domain&workIdentity, /api/work-intake,
   /api/domains, /api/agent-sessions (live session state, soft). Writes (each through W.api, never on load):
   POST /api/work-board/stage|edit, /api/tasks/capture, PATCH /api/tasks/:id, POST /api/work-intake/:id/resolve,
   /api/work-intake/resolve-batch|undo, /api/work-board/batch, /api/work-board/handoff-requests, /api/work/search (Return only).
   Routes: #/work, #/work/<workIdentity>, #/work/<workIdentity>/edit, #/work/<workIdentity>/start. */
(function () {
  'use strict';
  var W = window.COSWeb;
  var $ = W.$, esc = W.esc, api = W.api;
  var pane = $('pane-work');

  // ── Control's vocabulary ─────────────────────────────────
  var STAGES = ['mentioned', 'planned', 'draft', 'built', 'qa', 'complete'];
  var COLUMNS = ['planned', 'draft', 'built', 'qa', 'complete'];
  var STAGE_TITLE = { mentioned: 'Mentioned', planned: 'Planned', draft: 'Draft', built: 'Built', qa: 'QA', complete: 'Complete' };
  var STAGE_SUB = { mentioned: 'Captured for consideration', planned: 'Ready to work on', draft: 'First pass in progress',
    built: 'Implementation prepared', qa: 'Checks and review', complete: 'Task marked complete' };
  var SCOPES = [['all', 'All work'], ['attention', 'Needs attention'], ['progress', 'In progress'], ['completed', 'Completed']];
  var ORDERS = [['board', 'Board order'], ['recent', 'Recent activity'], ['newest', 'Newest'], ['oldest', 'Oldest']];
  var ORDER_HELP = { board: 'As you arranged each column',
    recent: 'Last stage move, session, file or edit. Edits made outside Control show up when the task file is next committed. Cards with no date go last.',
    newest: 'By the card’s date: its meeting or source, else when it first appeared. Cards with no date go last.' };
  ORDER_HELP.oldest = ORDER_HELP.newest;
  var STATE_LABEL = { running: 'Running', awaiting: 'Awaiting delivery', queued: 'Queued', waiting: 'Waiting for your input',
    replyReady: 'Reply ready for review', sent: 'Sent to session', attention: 'Needs attention', settled: 'Done' };
  var STATE_TONE = { running: 'green', awaiting: 'accent', queued: 'accent', replyReady: 'accent', sent: 'accent', waiting: 'amber', attention: 'danger', settled: 'muted' };
  var STATE_RANK = { running: 0, waiting: 1, attention: 2, replyReady: 3, sent: 4, awaiting: 5, queued: 6, settled: 7 };
  var SUMMARY_ORDER = [['running', 'running', 'running'], ['waiting', 'waiting for you', 'waiting for you'], ['attention', 'needs attention', 'need attention'],
    ['replyReady', 'reply ready', 'replies ready'], ['sent', 'sent', 'sent'], ['awaiting', 'awaiting delivery', 'awaiting delivery'], ['queued', 'queued', 'queued']];
  var PROVIDER_NAME = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', ollama: 'Local model' };
  var MODELS = [['', 'Server default'], ['opus', 'Claude Opus'], ['fable', 'Claude Fable'], ['sonnet', 'Claude Sonnet'],
    ['codex-frontier', 'Codex frontier'], ['codex-balanced', 'Codex balanced']];
  var MODEL_PROVIDER = { opus: 'claude', fable: 'claude', sonnet: 'claude', haiku: 'claude', 'codex-frontier': 'codex', 'codex-balanced': 'codex' };
  var HELPER = "'/Applications/COS Control.app/Contents/Resources/cos-control-helper'";
  var UNDO_MISSING = 'Undo needs a newer COS server. To change a card, open it in Work.';
  var INTAKE_REFUSALS = {
    meeting_identity_changed: 'That meeting was renamed or merged after it was scored. Dismiss this item; the renamed meeting is checked again.',
    meeting_unavailable: 'That meeting can’t be found; it may have been renamed or removed. Dismiss this item.',
    intake_task_changed: 'That task changed or was closed since it was suggested. Dismiss this suggestion.',
    meeting_links_full: 'That task already links eight meetings. Dismiss this suggestion.',
    work_board_read_only: 'This server can’t write Work links yet.',
    card_creation_unavailable: 'This server can’t create Work cards yet. Update the server.',
    task_bridge_unavailable: 'The task bridge didn’t answer. Try again in a moment.',
    intake_text_collision: 'The same words are on closed or archived work. Reopen that task instead, or dismiss this item.',
    intake_busy: 'That item is already being saved.', intake_not_found: 'That item is no longer in Intake. Refresh.',
    invalid_intake_action: 'Refresh Intake and try again.', invalid_intake_id: 'Refresh Intake and try again.',
    intake_store_full: 'Intake is full. Dismiss older items, then try again.',
    intake_store_closed: 'Intake is unavailable while the server restarts. Try again shortly.',
    work_intake_unavailable: 'Intake is unavailable right now. Try again shortly.' };
  var REQUEST_LINE = {
    pending: 'Waiting for COS Control on your Mac to pick this up. Nothing has been sent yet.',
    claimed: 'COS Control picked it up and is sending it.',
    sent: 'Sent. The session has the card’s context.',
    refused: 'COS Control did not send it.',
    unresolved: 'COS Control sent it but could not confirm it arrived. Check the session before sending again.',
    unconfirmed: 'COS Control took it and has not said whether it was sent. Check the session before sending again.',
    expired: 'COS Control did not pick it up in time. Nothing was sent.' };
  var STOP = {};
  ('a an and are as at be by for from in into is me my of on or our so that the their this to up was we with you your').split(' ').forEach(function (w) { STOP[w] = 1; });

  // ── state ────────────────────────────────────────────────
  var STORE = 'cos.web.work';
  var saved = W.readStore(STORE);
  var S = {
    tasks: null, caps: {}, complete: false, boardError: '', loading: false, loadedAt: 0,
    domains: null, open: null, openAvailable: false, openCaps: {}, openError: '', openAt: 0,
    sessions: {}, intake: null, intakeCaps: {}, intakeError: '', intakeLoading: false,
    tab: ['review', 'board', 'history', 'focus'].indexOf(saved.tab) >= 0 ? saved.tab : 'board',
    q: '', domain: '', scope: 'all', orders: saved.orders && typeof saved.orders === 'object' ? saved.orders : {},
    captureOpen: false, captureText: '', captureDomain: '', captureBusy: false, captureError: '',
    moreOpen: false, mentionedOpen: false, mentionedAll: false, showAllDecisions: false, columnAll: {},
    pendingComplete: null, busy: false, mutationError: '', note: '',
    hidden: W.readStore(STORE + '.hidden'),
    activity: {}, activityError: {}, activityLoading: {}, reply: {},
    sortIndex: 0, undoBatch: null, loopAvailable: null, intakeBusy: {}, sortError: '',
    waiting: null, dropped: null, waitingDropped: false, batchBusy: false, loopError: '',
    meaning: null, meaningPending: '',
    start: {}, edit: {}
  };
  function persist() { W.writeStore(STORE, { tab: S.tab === 'sort' || S.tab === 'waiting' ? 'board' : S.tab, orders: S.orders }); }

  // ── small helpers ────────────────────────────────────────
  function str(v) { return typeof v === 'string' ? v : ''; }
  function titleOf(t) { return str(t.text) || str(t.title); }
  function identity(t) { return str(t.workIdentity) || str(t.id); }
  function workId(t) { return 'task:' + t.domain + ':' + identity(t); }
  function stageOf(t) {
    if (t.checked) return 'complete';
    var v = STAGES.indexOf(t.workStage) >= 0 ? t.workStage : 'planned';
    return v === 'complete' ? 'planned' : v;
  }
  function domainName(d) {
    var hit = (S.domains || []).filter(function (x) { return x.name === d; })[0];
    if (hit && hit.label) return hit.label;
    return W.domainLabel(d) || String(d || '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function providerName(p) { return PROVIDER_NAME[p] || (p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Session'); }
  // Control's WorkSource.plainTitle: code marks, links, emphasis and stars out; whitespace collapsed.
  function plainTitle(line) {
    return String(line || '').replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, '$1$2').replace(/\*+/g, '').split(/\s+/).filter(Boolean).join(' ');
  }
  // A title with Control's inline markdown: bold and code, links as their words. Escaped first.
  function inline(text) {
    return esc(String(text || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'))
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*/g, '');
  }
  function clip(text, n) { var s = String(text || ''); return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+$/, '') + '…'; }
  function shortAge(seconds) {
    var s = Math.max(0, Math.floor(seconds));
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    if (s < 86400) return Math.floor(s / 3600) + ' h';
    return Math.floor(s / 86400) + ' d';
  }
  function secondsSince(v) { var d = W.toDate(v); return d ? (Date.now() - d.getTime()) / 1000 : null; }
  function localDay(d) { var x = d || new Date(); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
  // A UUID v4 from getRandomValues (crypto.randomUUID needs a secure context; a tailnet IP over http is not one).
  function uuid() {
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function icon(name) { return '<svg class="icon"><use href="#i-' + name + '"/></svg>'; }
  function errText(err, map) { var m = err && err.message ? err.message : 'That did not go through.'; return (map && map[m]) || m; }

  // ── live sessions and handoff state (WorkHandoffState, WorkActivity) ──
  function splitSession(id) { var m = /^(claude|codex|cursor):(.+)$/.exec(String(id || '')); return m ? { provider: m[1], id: m[2] } : null; }
  function sessionRow(a) { var s = splitSession(a && a.sessionId); return s ? S.sessions[s.id.toLowerCase()] || null : null; }
  function sessionStatus(row) {
    if (!row) return '';
    var st = String(row.agent_state || row.state || '').toLowerCase();
    if (st === 'running' || st === 'working') return 'running';
    if (st === 'waiting') return 'waiting';
    if (st === 'error' || st === 'failed') return 'error';
    return 'idle';
  }
  function observing(a) { return ['sending', 'queued', 'running', 'delivered'].indexOf(a.status) >= 0; }
  function observed(a) { return observing(a) ? sessionStatus(sessionRow(a)) : ''; }
  function reportOf(a) {
    if (!a || ['failed', 'refused', 'canceled'].indexOf(a.status) >= 0) return null;
    var p = a.progress; return p && !p.unreadable && p.reported ? p.reported : null;
  }
  function sessionRunning(a) { return observed(a) === 'running'; }
  function inProgress(a) { return ['preparing', 'sending', 'queued', 'running'].indexOf(a.status) >= 0 || a.sending === true || sessionRunning(a); }
  function needsAttention(a) {
    if (a.acknowledged) return false;
    var o = observed(a);
    return ['unknown', 'failed', 'refused', 'delivered', 'completed'].indexOf(a.status) >= 0 || o === 'waiting' || o === 'error';
  }
  function handoffState(a) {
    var status = a.status, o = observed(a);
    if (a.acknowledged || status === 'reviewed' || status === 'canceled') return 'settled';
    if (o === 'waiting') return 'waiting';
    if (o === 'error') return 'attention';
    if (o === 'running' || a.sending === true || status === 'preparing' || status === 'sending'
      || (status === 'running' && (a.mode === 'newSession' || a.mode === 'fork'))) return 'running';
    if (status === 'running') return 'awaiting';
    if (status === 'queued') return 'queued';
    if (status === 'completed') return 'replyReady';
    if (status === 'delivered') return sessionRow(a) ? 'replyReady' : 'sent';
    if (needsAttention(a)) return 'attention';
    return 'settled';
  }
  // A board session card: what the session reported wins while you have not handled it.
  function cardState(a) {
    if (!a.acknowledged) { var r = reportOf(a); if (r === 'needsInput') return 'waiting'; if (r === 'blocked') return 'attention'; }
    return handoffState(a);
  }
  function activityTitle(a) {
    if (a.acknowledged) return a.status === 'failed' || a.status === 'refused' ? 'Failure acknowledged' : 'Reviewed';
    switch (a.status) {
      case 'unknown': return a.sending ? 'Handoff in progress' : 'Delivery needs checking';
      case 'failed': case 'refused': return 'Needs attention';
      case 'completed': return 'Response ready for review';
      case 'reviewed': return 'Reviewed';
      case 'canceled': return 'Canceled';
      case 'queued': return 'Queued for session';
      default:
        if (sessionRunning(a)) return 'Session running';
        if (observed(a) === 'waiting') return 'Session needs your input';
        if (observed(a) === 'error') return 'Session needs attention';
        if (a.status === 'delivered') return 'Sent to session';
        return inProgress(a) ? 'Handoff in progress' : (a.status ? a.status.charAt(0).toUpperCase() + a.status.slice(1) : '');
    }
  }
  // WorkTracking: what the session reported (done, needs input, blocked) and where it stands.
  function tracking(a) {
    var r = reportOf(a); if (!r) return null;
    var handled = !!a.acknowledged;
    var label = r === 'done' ? 'Done' : handled ? 'Handled' : r === 'needsInput' ? 'Needs your input' : 'Blocked';
    var tone = r === 'done' ? 'accent' : handled ? 'muted' : r === 'needsInput' ? 'amber' : 'danger';
    var by = a.progress && a.progress.reportedBy;
    return { phase: r, label: label, short: r === 'needsInput' && !handled ? 'Needs input' : label, tone: tone,
      asks: (r === 'needsInput' || r === 'blocked') && !handled, evidence: str(a.progress && a.progress.evidence),
      byModel: by === 'jev' || by === 'subq', provider: by === 'subq' ? 'SubQ' : 'Jev' };
  }
  function ageText(a, state) {
    var sent = secondsSince(a.createdAt);
    if (state === 'running' || state === 'awaiting' || state === 'queued' || !sessionRow(a)) return 'sent ' + shortAge(sent || 0) + ' ago';
    var row = sessionRow(a), active = secondsSince(row.last_activity_at || row.modified);
    if (active == null) return 'sent ' + shortAge(sent || 0) + ' ago';
    var age = shortAge(active);
    return age === 'now' ? 'active now' : 'active ' + age + ' ago';
  }
  function ageLabel(row) {
    var st = sessionStatus(row), word = st === 'error' ? 'error' : st || 'status unavailable';
    var s = secondsSince(row && (row.last_activity_at || row.modified));
    return s == null ? word : word + ' · ' + shortAge(s);
  }

  // ── the board's items (WorkWorkspaceProjection.items) ────
  var ITEMS = null, ITEMS_KEY = '';
  function openByWork() {
    var map = {};
    (S.open || []).forEach(function (a) { if (a && a.workId) map[a.workId] = a; });
    return map;
  }
  function items() {
    var key = S.loadedAt + '|' + S.openAt;
    if (ITEMS && ITEMS_KEY === key) return ITEMS;
    var open = openByWork();
    var list = (S.tasks || []).map(function (t, i) {
      var a = open[workId(t)] || null, tr = a ? tracking(a) : null;
      var attention = !!a && needsAttention(a) && !sessionRunning(a);
      return {
        id: identity(t), wid: workId(t), task: t, title: titleOf(t), domain: t.domain, offset: i, activity: a, tracking: tr,
        stage: stageOf(t), completed: !!t.checked,
        subtitle: t.checked ? 'Completed task' : t.agentState === 'done' ? 'Agent finished · task still open' : STAGE_TITLE[stageOf(t)],
        needsAttention: !t.checked && (t.failed === true || t.missed === true || attention || t.agentState === 'done' || t.stage === 'review' || !!(tr && tr.asks)),
        inProgress: t.agentState === 'running' || (!!a && inProgress(a))
      };
    });
    function rank(it) { return it.completed ? 3 : it.needsAttention ? 0 : it.inProgress ? 1 : 2; }
    function priority(it) {
      if (it.task.workStage === 'qa') return 0;
      if (it.task.priority === 'urgent') return 1;
      var due = W.toDate(str(it.task.dueDate) + 'T00:00:00');
      if (str(it.task.dueDate) && due && due.getTime() - Date.now() < 14 * 86400000) return 1;
      return 2;
    }
    list.sort(function (l, r) {
      var a = rank(l), b = rank(r); if (a !== b) return a - b;
      a = priority(l); b = priority(r); if (a !== b) return a - b;
      var ld = str(l.task.createdAt), rd = str(r.task.createdAt);
      if (ld !== rd && ld && rd) return ld > rd ? -1 : 1;
      return l.offset - r.offset;
    });
    ITEMS = list; ITEMS_KEY = key;
    return list;
  }
  function itemFor(arg) {
    var all = items();
    return all.filter(function (it) { return it.id === arg; })[0] || all.filter(function (it) { return it.task.id === arg; })[0] || null;
  }
  function itemByWid(wid) { return items().filter(function (it) { return it.wid === wid; })[0] || null; }

  // ── search (WorkSearch: every word in the title, else any word anywhere on the card) ──
  function fold(s) { return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function tokens(s) { return fold(s).match(/[\p{L}\p{N}]+/gu) || []; }
  function queryWords(q) { var seen = {}; return tokens(q).filter(function (w) { if (w.length < 2 || STOP[w] || seen[w]) return false; seen[w] = 1; return true; }); }
  function found(w, toks) { for (var i = 0; i < toks.length; i++) if (toks[i].indexOf(w) === 0) return true; return false; }
  function fieldsOf(it) {
    if (it._fields) return it._fields;
    var t = it.task;
    it._fields = { title: tokens(plainTitle(it.title)),
      other: tokens([t.text, t.title, t.source].concat((t.meetingRefs || []).map(function (m) { return m && m.title; })).filter(Boolean).join(' \n ')) };
    return it._fields;
  }
  function match(it, words) {
    if (!words.length) return null;
    var f = fieldsOf(it);
    if (words.every(function (w) { return found(w, f.title); })) return { kind: 'title', words: words };
    var hit = words.filter(function (w) { return found(w, f.title) || found(w, f.other); });
    return hit.length ? { kind: 'words', words: hit } : null;
  }
  function inView(it, scope, domain) {
    if (domain && it.domain !== domain) return false;
    if (scope === 'attention') return it.needsAttention;
    if (scope === 'progress') return it.inProgress;
    if (scope === 'completed') return it.completed;
    return true;
  }
  // The view's cards narrowed by the query (Focus, Your move).
  function visible() {
    var words = queryWords(S.q);
    return items().filter(function (it) { return inView(it, S.scope, S.domain) && (!words.length || match(it, words)); });
  }
  function searchKey() { return S.q.trim().replace(/\s+/g, ' ').toLowerCase() + '|' + S.scope + '|' + S.domain; }
  function meaningNote(reason) {
    var notes = { jev_breaker_open: 'Meaning search is paused for an hour', jev_cap_reached: 'Meaning search has used today’s budget',
      too_many_candidates: 'Meaning search covers up to 254 cards. Pick a domain.', jev_not_configured: 'Meaning search needs a TypeSafe key in Settings',
      jev_key_rejected: 'TypeSafe did not accept the saved key. Check it in Settings.', jev_request_rejected: 'Meaning search could not take this search',
      server_too_old: 'Meaning search needs COS server 6.65', unreachable: 'Could not reach COS server. Showing word matches.',
      jev_unavailable: 'Meaning search is temporarily unavailable. Showing word matches.',
      subq_not_configured: 'Meaning search needs a SubQ key in Settings', subq_key_rejected: 'SubQ did not accept the saved key. Check it in Settings.' };
    if (!reason || reason === 'search_off') return null;
    return notes[reason] || 'Meaning search could not run. Showing word matches.';
  }
  // WorkSearch.result over the board's cards in board order, plus "N more in" other domains.
  function boardSearch(cards) {
    var words = queryWords(S.q);
    var res = { active: words.length > 0, hits: {}, band: [], titleCount: 0, wordsCount: 0, meaningCount: 0, elsewhere: [], note: null };
    if (!res.active) return res;
    cards.forEach(function (it) { var h = match(it, words); if (h) res.hits[it.id] = h; });
    var m = S.meaning && S.meaning.key === searchKey() ? S.meaning : null;
    if (m) {
      if (m.available) {
        cards.forEach(function (it) {
          var p = m.scores[it.task.id]; if (p == null) return;
          if (res.hits[it.id]) res.hits[it.id].p = p;
          else if (p >= 0.15) res.hits[it.id] = { kind: 'meaning', words: [], p: p };
        });
      } else res.note = meaningNote(m.reason);
    }
    Object.keys(res.hits).forEach(function (id) { res[res.hits[id].kind + 'Count']++; });
    var pos = {}; cards.forEach(function (it, i) { pos[it.id] = i; });
    function group(h) { return h.p != null && h.p >= 0.15 ? 0 : h.kind === 'title' ? 1 : h.kind === 'words' ? 2 : 3; }
    res.band = Object.keys(res.hits).sort(function (a, b) {
      var ha = res.hits[a], hb = res.hits[b], ga = group(ha), gb = group(hb);
      if (ga !== gb) return ga - gb;
      if (ga === 0 && ha.p !== hb.p) return (hb.p || 0) - (ha.p || 0);
      if (ga === 2 && ha.words.length !== hb.words.length) return hb.words.length - ha.words.length;
      return (pos[a] || 0) - (pos[b] || 0);
    }).slice(0, 3);
    if (S.domain) {
      var counts = {};
      items().forEach(function (it) { if (it.domain !== S.domain && inView(it, S.scope, '') && match(it, words)) counts[it.domain] = (counts[it.domain] || 0) + 1; });
      res.elsewhere = Object.keys(counts).map(function (d) { return { domain: d, count: counts[d] }; })
        .sort(function (a, b) { return a.count === b.count ? (a.domain < b.domain ? -1 : 1) : b.count - a.count; });
    }
    return res;
  }
  function kept(cards, res) { return res.active ? cards.filter(function (it) { return res.hits[it.id]; }) : cards; }
  function countLabel(k, all, active) { return active ? k + ' of ' + all : String(all); }
  function whyText(h) {
    if (h.kind === 'title') return 'Title';
    if (h.kind === 'words') return 'Words: ' + h.words.slice(0, 2).map(function (w) { return '“' + w + '”'; }).join(', ');
    return 'Similar meaning';
  }
  // The title with the start of each matched word underlined in gold.
  function underlined(title, words) {
    var plain = plainTitle(title);
    if (!words || !words.length) return inline(title);
    var out = '', last = 0, re = /[\p{L}\p{N}]+/gu, m;
    while ((m = re.exec(plain))) {
      var token = fold(m[0]), w = words.filter(function (x) { return token.indexOf(x) === 0; })[0];
      if (!w) continue;
      var len = Math.min(w.length, m[0].length);
      out += esc(plain.slice(last, m.index)) + '<span class="wk-u">' + esc(plain.slice(m.index, m.index + len)) + '</span>';
      last = m.index + len;
    }
    return out + esc(plain.slice(last));
  }

  // ── card dates (WorkCardDating) ──────────────────────────
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dayOf(text) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || '')); if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null;
  }
  function firstDay(source) {
    var label = String(source || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'), re = /20\d{2}-\d{2}-\d{2}/g, m;
    while ((m = re.exec(label))) { var d = dayOf(m[0]); if (d) return d; }
    return null;
  }
  function cardDates(it) {
    var t = it.task, created = null, firstSeen = false;
    var server = dayOf(t.createdOn);
    if (server) { created = server; firstSeen = t.createdFrom === 'git'; } else created = firstDay(t.source);
    var moments = [W.toDate(t.lineChangedAt)];
    var a = it.activity;
    if (a && ['refused', 'failed', 'canceled'].indexOf(a.status) < 0) moments.push(W.toDate(a.createdAt));
    moments = moments.filter(Boolean);
    var newest = moments.length ? moments.reduce(function (x, y) { return x > y ? x : y; }) : null;
    if (newest && (!created || newest >= created)) return { created: created, firstSeen: firstSeen, active: newest, activeIsDay: false };
    return { created: created, firstSeen: firstSeen, active: created, activeIsDay: !!created };
  }
  function shortDay(d) { var text = MONTHS[d.getMonth()] + ' ' + d.getDate(); return d.getFullYear() === new Date().getFullYear() ? text : text + ', ' + d.getFullYear(); }
  function dayAge(d, isDay) {
    var s = (Date.now() - d.getTime()) / 1000;
    if (!isDay && s < 86400) { if (s < 60) return 'now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; return Math.floor(s / 3600) + ' h ago'; }
    var a = new Date(d.getFullYear(), d.getMonth(), d.getDate()), n = new Date(); n = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    var days = Math.round((n - a) / 86400000);
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago';
  }
  function dateLine(it, order) {
    if (order === 'board') return null;
    var d = cardDates(it);
    if (order === 'recent') return d.active ? 'active ' + dayAge(d.active, d.activeIsDay) : 'No date';
    return d.created ? (d.firstSeen ? 'first seen ' : 'dated ') + shortDay(d.created) : 'No date';
  }
  function ordered(cards, order) {
    if (order === 'board') return cards;
    var keyed = cards.map(function (it, i) { var d = cardDates(it); return { it: it, i: i, at: order === 'recent' ? d.active : d.created }; });
    keyed.sort(function (l, r) {
      if (l.at && r.at && +l.at !== +r.at) return order === 'oldest' ? l.at - r.at : r.at - l.at;
      if (!l.at && r.at) return 1;
      if (l.at && !r.at) return -1;
      return l.i - r.i;
    });
    return keyed.map(function (k) { return k.it; });
  }
  function orderKey() { return (S.domain ? 'domain:' + S.domain : 'all') + '|' + S.scope; }
  function currentOrder() { var o = S.orders[orderKey()]; return ORDERS.some(function (x) { return x[0] === o; }) ? o : 'board'; }

  // ── data ─────────────────────────────────────────────────
  function soft(p) { return p.then(function (d) { return d; }, function () { return null; }); }
  function loadSessions() {
    return soft(api('/api/agent-sessions?limit=80&sort=updated')).then(function (d) {
      if (!d || !Array.isArray(d.sessions)) return;
      var map = {};
      d.sessions.forEach(function (s) { if (s && s.session_id) map[String(s.session_id).toLowerCase()] = s; });
      S.sessions = map;
    });
  }
  function loadOpen() {
    return api('/api/work-board/activity/open').then(function (d) {
      S.open = (d && Array.isArray(d.items)) ? d.items : [];
      S.openAvailable = !!(d && d.available !== false);
      S.openCaps = (d && d.capabilities) || {};
      S.openError = d && d.available === false ? str(d.reason) : '';
      S.openAt = Date.now();
    }, function (err) { S.open = S.open || []; S.openAvailable = false; S.openError = err.message || 'Session activity could not be read.'; S.openAt = Date.now(); });
  }
  function loadBoard() {
    if (S.loading) return Promise.resolve();
    S.loading = true; render();
    var board = api('/api/work-board').then(function (d) {
      S.tasks = (d && Array.isArray(d.tasks)) ? d.tasks : [];
      S.caps = (d && d.capabilities) || {};
      S.complete = !!(d && d.complete === true);
      S.boardError = '';
    }, function (err) { S.boardError = err.message || 'Work board is unavailable. Refresh before trying again.'; S.complete = false; if (!S.tasks) S.tasks = []; });
    var domains = S.domains ? Promise.resolve() : soft(api('/api/domains')).then(function (d) { S.domains = (d && Array.isArray(d.domains)) ? d.domains : []; });
    // Live session state only refines the status words, so the board never waits for it.
    loadSessions().then(function () { ITEMS = null; if (!S.loading) render(); });
    return Promise.all([board, loadOpen(), domains]).then(function () {
      S.loading = false; S.loadedAt = Date.now(); ITEMS = null;
      render();
      if (!S.intake && !S.intakeLoading) loadIntake();
    });
  }
  function loadIntake() {
    S.intakeLoading = true;
    return api('/api/work-intake').then(function (d) {
      S.intake = (d && Array.isArray(d.items)) ? d.items : [];
      S.intakeCaps = (d && d.capabilities) || {};
      S.intakeError = '';
    }, function (err) { S.intakeError = err.status === 404 ? 'Intake is unavailable on this server.' : (err.message || 'Intake could not be read.'); if (!S.intake) S.intake = []; })
      .then(function () { S.intakeLoading = false; render(); });
  }
  function refreshAll() {
    S.meaning = null;
    return Promise.all([loadBoard(), loadIntake()]);
  }
  // Session activity every 30 s while Work is open, as Control rechecks its sessions on a timer.
  var poll = null;
  function startPoll() {
    if (poll) return;
    poll = setInterval(function () {
      if (W.parseRoute().pane !== 'work' || document.hidden) return;
      Promise.all([loadOpen(), loadSessions()]).then(function () { ITEMS = null; render(); });
    }, 30000);
  }
  function stopPoll() { clearInterval(poll); poll = null; }

  // ── header, tabs, filters ────────────────────────────────
  function domainNames() {
    var names = {};
    (S.domains || []).forEach(function (d) { if (d && d.name) names[d.name] = 1; });
    (S.tasks || []).forEach(function (t) { if (t.domain) names[t.domain] = 1; });
    return Object.keys(names).sort();
  }
  function hero() {
    var line = S.tasks && !S.complete && !S.loading ? 'Showing available work. Task inventory is not confirmed complete.' : 'Your decisions, connected to the work.';
    return '<header class="cx-hero" data-tint="work"><span class="cx-glyph">' + icon('work') + '</span>' +
      '<div class="cx-hero-text"><h1 class="cx-title">Work</h1><p class="cx-detail-line">' + esc(line) + '</p></div>' +
      '<div class="cx-actions"><button type="button" class="cx-btn quiet" data-wk="capture-toggle" aria-expanded="' + S.captureOpen + '">Add task</button>' +
      '<button type="button" class="cx-btn quiet wk-icon-btn" data-wk="refresh" aria-label="Refresh work" title="Refresh work"' + (S.loading ? ' disabled' : '') + '>' + icon('refresh') + '</button></div></header>';
  }
  function sortTitle() {
    if (S.intakeError && !S.intake) return 'Intake · !';
    var n = sortSplit().count;
    return n > 0 ? 'Sort · ' + n + ' older' : 'Sort';
  }
  function tabs() {
    function tab(id, title, on) { return '<button type="button" data-wk="tab" data-tab="' + id + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(title) + '</button>'; }
    var moreOn = S.tab === 'focus' || S.tab === 'sort' || S.tab === 'waiting';
    var menu = S.moreOpen ? '<div class="wk-menu" role="menu">' +
      '<button type="button" role="menuitem" data-wk="tab" data-tab="focus">Focus view</button>' +
      (S.intake || S.intakeError ? '<button type="button" role="menuitem" data-wk="tab" data-tab="sort">' + esc(sortTitle()) + '</button>' : '') +
      (S.caps.workBatch === 1 && S.caps.writable === true ? '<button type="button" role="menuitem" data-wk="tab" data-tab="waiting">Waiting on</button>' : '') + '</div>' : '';
    return '<div class="cx-switch wk-tabs" role="group" aria-label="Work view">' + tab('review', 'Your move', S.tab === 'review') + tab('board', 'Board', S.tab === 'board') +
      tab('history', 'History', S.tab === 'history') +
      '<span class="wk-more"><button type="button" data-wk="more" aria-haspopup="menu" aria-expanded="' + S.moreOpen + '" aria-pressed="' + (moreOn ? 'true' : 'false') + '">' +
      esc(moreOn ? (S.tab === 'focus' ? 'Focus view' : S.tab === 'sort' ? 'Sort' : 'Waiting on') : 'More') + '<span class="wk-caret"></span></button>' + menu + '</span></div>';
  }
  function select(name, label, options, value) {
    return '<label class="wk-pick"><span>' + esc(label) + '</span><select class="field" data-wk-select="' + name + '">' +
      options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === value ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>';
  }
  function filters() {
    return '<div class="wk-filters"><form class="cx-search" data-wk-form="search" role="search">' +
      '<input class="field" type="search" id="wk-q" placeholder="Search work" value="' + esc(S.q) + '" autocomplete="off" enterkeyhint="search" aria-label="Search work">' +
      (S.q ? '<button type="button" class="cx-clear" data-wk="clear">Clear</button>' : '') + '</form>' +
      select('domain', 'Domain', [['', 'All domains']].concat(domainNames().map(function (d) { return [d, domainName(d)]; })), S.domain) +
      select('scope', 'Scope', SCOPES, S.scope) + '</div>';
  }
  function captureForm() {
    if (!S.captureOpen) return '';
    var names = domainNames();
    var ok = S.captureText.trim() && names.indexOf(S.captureDomain) >= 0 && !S.captureBusy;
    return '<form class="wk-capture" data-wk-form="capture">' +
      '<input class="field" id="wk-capture-text" type="text" placeholder="What needs to be done?" value="' + esc(S.captureText) + '" autocomplete="off" enterkeyhint="done"' + (S.captureBusy ? ' disabled' : '') + '>' +
      '<div class="wk-capture-row">' + (S.caps.workBatch === 1 ? '<button type="button" class="wk-text-btn" data-wk="tab" data-tab="waiting">Waiting on / Dropped</button>' : '') +
      '<select class="field" id="wk-capture-domain" aria-label="Domain"' + (S.captureBusy ? ' disabled' : '') + '><option value=""' + (S.captureDomain ? '' : ' selected') + ' disabled>Choose domain</option>' +
      names.map(function (d) { return '<option value="' + esc(d) + '"' + (d === S.captureDomain ? ' selected' : '') + '>' + esc(domainName(d)) + '</option>'; }).join('') + '</select>' +
      '<button type="submit" class="cx-btn primary"' + (ok ? '' : ' disabled') + '>' + (S.captureBusy ? 'Adding…' : 'Capture') + '</button></div>' +
      (S.captureError ? '<p class="wk-error">' + esc(S.captureError) + '</p>' : '') + '</form>';
  }
  function notices() {
    var out = '';
    if (S.note) out += '<div class="cx-notice wk-note"><span>' + esc(S.note) + '</span><button type="button" class="wk-text-btn" data-wk="dismiss-note">Dismiss</button></div>';
    if (S.mutationError) out += '<div class="cx-notice warn wk-note"><span>' + esc(S.mutationError) + '</span><button type="button" class="wk-text-btn" data-wk="dismiss-error">Dismiss</button></div>';
    return out;
  }

  // ── Your move and History (decisionQueue) ────────────────
  function signature(a) {
    var p = a.progress && !a.progress.unreadable ? a.progress : {};
    return JSON.stringify([a.status || '', p.reported || '', p.evidence || '', p.reportedBy || '', a.status === 'failed' || a.status === 'refused' ? a.error || '' : '']);
  }
  function isHidden(a) { return S.hidden[a.id] === signature(a); }
  function decisionCards(history) {
    var allowed = {};
    visible().forEach(function (it) { allowed[it.wid] = it; });
    var cards = [];
    (S.open || []).forEach(function (a) {
      var it = allowed[a.workId]; if (!it) return;
      if (!(inProgress(a) || needsAttention(a) || reportOf(a))) return;
      if (it.completed && !inProgress(a)) return;
      if (isHidden(a) !== history) return;
      cards.push({ it: it, a: a, state: cardState(a) });
    });
    return cards.sort(function (l, r) {
      var a = STATE_RANK[l.state], b = STATE_RANK[r.state];
      if (a !== b) return a - b;
      return (W.toDate(r.a.createdAt) || 0) - (W.toDate(l.a.createdAt) || 0);
    });
  }
  function summary(cards) {
    var parts = SUMMARY_ORDER.map(function (o) { var n = cards.filter(function (c) { return c.state === o[0]; }).length; return n ? n + ' ' + (n === 1 ? o[1] : o[2]) : ''; }).filter(Boolean);
    return parts.length ? parts.join(' · ') : 'None right now';
  }
  function decisionQueue(history) {
    var cards = decisionCards(history), shown = S.showAllDecisions ? cards : cards.slice(0, 5);
    var body = shown.map(function (c) {
      var a = c.a, tr = tracking(a), result = (tr && tr.evidence) || str(a.error);
      var action = c.state === 'attention' || a.status === 'unknown' ? 'Check delivery' : c.state === 'waiting' ? 'Answer question'
        : (c.state === 'replyReady' || c.state === 'sent') ? 'Review result' : 'Open session';
      var sess = splitSession(a.sessionId);
      return '<article class="wk-decision">' +
        '<div class="wk-decision-main"><p class="wk-state" data-tone="' + STATE_TONE[c.state] + '">' + esc(STATE_LABEL[c.state] + ' · ' + providerName(a.provider) + ' · ' + ageText(a, c.state)) + '</p>' +
        '<button type="button" class="wk-link wk-decision-title" data-wk="open" data-id="' + esc(c.it.id) + '">' + inline(c.it.title) + '</button>' +
        '<p class="wk-muted">' + esc(str((sessionRow(a) || {}).display_label) || str(a.sessionTitle)) + '</p>' +
        (result ? '<p class="wk-muted wk-clamp2">' + esc(result.replace(/\s+/g, ' ').slice(0, 200)) + '</p>' : '') + '</div>' +
        '<div class="wk-decision-actions">' +
        (action === 'Open session' && sess ? '<button type="button" class="cx-btn quiet" data-wk="session" data-provider="' + esc(sess.provider) + '" data-sid="' + esc(sess.id) + '">Open session</button>'
          : '<button type="button" class="cx-btn quiet" data-wk="open" data-id="' + esc(c.it.id) + '">' + esc(action) + '</button>') +
        '<button type="button" class="wk-text-btn" data-wk="' + (history ? 'restore' : 'hide') + '" data-rid="' + esc(a.id) + '">' + (history ? 'Restore' : 'Hide notice') + '</button></div></article>';
    }).join('');
    var empty = !cards.length ? '<p class="wk-muted wk-pad">' + esc(S.open == null ? 'Checking session activity…' : !S.openAvailable && S.openError ? S.openError
      : history ? 'No hidden notices in this view.' : 'Nothing needs review in this view.') + '</p>' : '';
    return '<section class="wk-queue"><div class="wk-queue-head"><h2 class="wk-h2">' + (history ? 'Hidden notices' : 'Your move') + '</h2>' +
      '<span class="wk-muted">' + esc(summary(cards)) + '</span>' +
      (cards.length > 5 ? '<button type="button" class="wk-text-btn wk-push" data-wk="show-all-decisions">' + (S.showAllDecisions ? 'Show fewer' : 'Show all ' + cards.length) + '</button>' : '') + '</div>' +
      body + empty + '<p class="wk-fine">Hiding a notice leaves its delivery warning and task stage unchanged. A new result brings it back. Hidden notices are kept in this browser.</p></section>';
  }

  // ── board ────────────────────────────────────────────────
  function canChangeStage(t) { return !S.busy && S.caps.version === 1 && S.caps.writable === true && !!str(t.workRevision) && !t.workMetadataError; }
  function stageMenu(it, extraClass) {
    var t = it.task, cur = stageOf(t), disabled = !canChangeStage(t);
    return '<select class="wk-stage' + (extraClass ? ' ' + extraClass : '') + '" data-wk-stage="' + esc(it.id) + '" aria-label="Change task stage" title="Change task stage"' + (disabled ? ' disabled' : '') + '>' +
      STAGES.map(function (s) {
        var label = s === cur ? STAGE_TITLE[s] : s === 'complete' ? 'Mark complete' : 'Move to ' + STAGE_TITLE[s];
        return '<option value="' + s + '"' + (s === cur ? ' selected disabled' : '') + '>' + esc(label) + '</option>';
      }).join('') + '</select>';
  }
  function statusLine(it) {
    var a = it.activity, tr = it.tracking;
    if (tr) {
      return '<p class="wk-status" data-tone="' + tr.tone + '"><span class="wk-dot' + (tr.phase === 'done' || tr.asks ? '' : ' hollow') + '"></span>' + esc(tr.label + ' · ' + str(a.sessionTitle)) + '</p>' +
        (tr.asks && tr.evidence ? '<p class="wk-quote">“' + esc(tr.evidence) + '”</p>' : '');
    }
    if (a) {
      var st = handoffState(a);
      if (st !== 'settled') return '<p class="wk-status" data-tone="' + STATE_TONE[st] + '"><span class="wk-dot' + (st === 'running' ? ' live' : '') + '"></span>' + esc(STATE_LABEL[st] + ' · ' + str(a.sessionTitle)) + '</p>';
    }
    if (it.inProgress) return '<p class="wk-status" data-tone="accent">' + icon('sessions') + 'Session running</p>';
    if (it.needsAttention) return '<p class="wk-status" data-tone="accent"><span class="wk-dot hollow"></span>Needs attention</p>';
    return '';
  }
  function meetingLink(m) {
    return '<button type="button" class="wk-meeting" data-wk="meeting" data-domain="' + esc(m.domain) + '" data-month="' + esc(m.month) + '" data-file="' + esc(m.filename) + '">' +
      icon('meetings') + '<span>' + esc(m.title || 'Saved meeting') + '</span></button>';
  }
  function boardCard(it, hit, order) {
    var t = it.task, tr = it.tracking, asking = !!(tr && tr.asks), running = !!it.activity && handoffState(it.activity) === 'running';
    var tone = asking ? 'asking' : running ? 'running' : hit ? 'matched' : '';
    var refs = (t.meetingRefs || []).filter(function (m) { return m && m.filename; });
    var line = dateLine(it, order);
    var confirm = S.pendingComplete === it.wid;
    return '<article class="wk-card"' + (tone ? ' data-tone="' + tone + '"' : '') + '>' +
      '<button type="button" class="wk-card-tap" data-wk="open" data-id="' + esc(it.id) + '" title="' + esc(plainTitle(it.title)) + '">' +
      '<span class="wk-card-title">' + underlined(it.title, hit && hit.words) + '</span>' + statusLine(it) +
      (!refs.length ? '<span class="wk-card-source">' + esc(str(t.source) || 'No meeting linked') + '</span>' : '') + '</button>' +
      refs.slice(0, 2).map(meetingLink).join('') +
      (line ? '<p class="wk-date">' + esc(line) + '</p>' : '') +
      (confirm ? completeConfirm(it) : '<div class="wk-card-foot">' + stageMenu(it) +
        (!it.completed ? '<button type="button" class="wk-text-btn" data-wk="start" data-id="' + esc(it.id) + '">Start work</button>' : '') + '</div>') +
      '</article>';
  }
  function completeConfirm(it) {
    return '<div class="wk-confirm"><p>' + esc('Mark “' + clip(plainTitle(it.title), 80) + '” complete?') + '</p>' +
      '<div class="wk-row"><button type="button" class="cx-btn quiet" data-wk="complete-yes" data-id="' + esc(it.id) + '"' + (canChangeStage(it.task) ? '' : ' disabled') + '>Mark complete</button>' +
      '<button type="button" class="wk-text-btn" data-wk="complete-no">Cancel</button></div></div>';
  }
  function columnHtml(stage, cards, all, res, order, phone) {
    var limit = S.columnAll[stage] ? cards.length : phone ? 8 : 40;
    var empty = !cards.length ? '<p class="wk-muted wk-pad">' + esc(!res.active ? 'No tasks here' : S.meaningPending === searchKey() ? 'Searching…'
      : (stage === 'complete' && S.scope === 'all' && !S.domain) ? 'No word matches here' : 'No matches here') + '</p>' : '';
    return '<section class="wk-col" data-stage="' + stage + '"><header class="wk-col-head"><div class="wk-row"><h3>' + esc(STAGE_TITLE[stage]) + '</h3>' +
      '<span class="wk-count">' + esc(countLabel(cards.length, all.length, res.active)) + '</span></div><p>' + esc(STAGE_SUB[stage]) + '</p></header>' +
      '<div class="wk-col-body">' + empty + cards.slice(0, limit).map(function (it) { return boardCard(it, res.hits[it.id], order); }).join('') +
      (cards.length > limit ? '<button type="button" class="wk-more-row" data-wk="column-all" data-stage="' + stage + '">Show all ' + cards.length + '</button>' : '') + '</div></section>';
  }
  function board() {
    var cards = items().filter(function (it) { return inView(it, S.scope, S.domain); });
    var res = boardSearch(cards), order = currentOrder(), phone = W.isPhone();
    var shown = kept(cards, res).length;
    var boardName = S.domain ? domainName(S.domain) : SCOPES.filter(function (s) { return s[0] === S.scope; })[0][1];
    var head = '<div class="wk-board-head"><div><h2 class="wk-h2">' + esc(boardName) + '</h2>' +
      '<p class="wk-muted">' + esc(countLabel(shown, cards.length, res.active) + ' tasks · Change a card’s stage from its menu, or use Start work to put a session on it') + '</p></div>' +
      '<div title="' + esc(ORDER_HELP[order]) + '">' + select('order', 'Order', ORDERS, order) + '</div></div>';
    var search = '';
    if (res.active) {
      var n = Object.keys(res.hits).length;
      var kinds = [[res.titleCount, 'by title'], [res.wordsCount, 'by words'], [res.meaningCount, 'by meaning']].filter(function (k) { return k[0] > 0; }).map(function (k) { return k[0] + ' ' + k[1]; }).join(' · ');
      var more = res.elsewhere.length ? (res.elsewhere.length === 1 ? res.elsewhere[0].count + ' more in ' + domainName(res.elsewhere[0].domain)
        : res.elsewhere.reduce(function (s, e) { return s + e.count; }, 0) + ' more in other domains') : '';
      search = '<div class="wk-results"><div class="wk-row wk-wrap"><strong>' + esc(n ? (n === 1 ? '1 match' : n + ' matches') : S.meaningPending === searchKey() ? 'Searching by meaning…' : 'No matches on this board') + '</strong>' +
        (n ? '<span class="wk-muted">' + esc(kinds) + '</span>' : '') + (more ? '<button type="button" class="wk-text-btn wk-push" data-wk="search-all">' + esc(more) + '</button>' : '') + '</div>' +
        (res.band.length ? '<div class="wk-band">' + res.band.map(function (id) {
          var it = cards.filter(function (c) { return c.id === id; })[0], h = res.hits[id]; if (!it) return '';
          return '<button type="button" class="wk-band-row" data-wk="open" data-id="' + esc(id) + '"><span class="wk-band-stage">' + esc(STAGE_TITLE[it.stage]) + '</span>' +
            '<span class="wk-band-title">' + underlined(it.title, h.words) + '</span><span class="wk-band-why' + (h.kind === 'meaning' ? ' meaning' : '') + '">' + esc(whyText(h)) + '</span></button>';
        }).join('') + '</div>' : '') +
        (res.note ? '<p class="wk-muted">' + esc(res.note) + '</p>' : '') +
        (!S.meaning || S.meaning.key !== searchKey() ? '<p class="wk-fine">Press Return to also search by meaning.</p>' : '') + '</div>';
    }
    var notes = '';
    if (S.tasks && !(S.caps.version === 1 && S.caps.writable === true)) notes += '<p class="wk-muted wk-pad-x">Board is read-only. Stage changes and meeting links need the connected Work service.</p>';
    if (S.boardError) notes += '<div class="cx-notice warn">' + esc(S.boardError) + '</div>';
    var mentionedAll = items().filter(function (it) { return inView(it, S.scope, S.domain) && it.stage === 'mentioned'; });
    var mentioned = kept(mentionedAll, res);
    var mlimit = S.mentionedAll ? mentioned.length : 30;
    var mentionedHtml = '<div class="wk-mentioned"><button type="button" class="wk-menu-label" data-wk="mentioned" aria-expanded="' + S.mentionedOpen + '">Mentioned · ' + mentioned.length + '<span class="wk-caret"></span></button>' +
      (S.mentionedOpen ? '<div class="cx-list wk-mentioned-list">' + (mentioned.length ? mentioned.slice(0, mlimit).map(function (it) {
        return '<button type="button" class="wk-mrow" data-wk="open" data-id="' + esc(it.id) + '"><span>' + inline(it.title) + '</span><span class="chev"></span></button>';
      }).join('') + (mentioned.length > mlimit ? '<button type="button" class="wk-more-row" data-wk="mentioned-all">Show all ' + mentioned.length + '</button>' : '')
        : '<p class="wk-muted wk-pad">Nothing mentioned in this view.</p>') + '</div>' : '') + '</div>';
    var columns = COLUMNS.map(function (stage) {
      var all = cards.filter(function (it) { return it.stage === stage; });
      return columnHtml(stage, ordered(kept(all, res), order), all, res, order, phone);
    }).join('');
    return '<section class="wk-board">' + head + search + notes +
      '<button type="button" class="wk-text-btn wk-pad-x" data-wk="tab" data-tab="review">Open decisions and results</button>' + mentionedHtml +
      '<div class="wk-columns">' + columns + '</div>' +
      '<p class="wk-fine">Stages reflect your decisions. Moving a card does not run an agent or publish changes. Start work asks before anything is sent.</p></section>';
  }

  // ── Focus view ───────────────────────────────────────────
  function focusView() {
    var all = items(), progress = all.filter(function (it) { return it.inProgress; }).length, attention = all.filter(function (it) { return it.needsAttention; }).length;
    var checked = S.openAt ? 'Sessions checked ' + (shortAge((Date.now() - S.openAt) / 1000) === 'now' ? 'just now' : shortAge((Date.now() - S.openAt) / 1000) + ' ago') : 'Session activity appears after a handoff';
    if (S.openError) checked = S.openError;
    var list = visible();
    function count(text, n, scope) { return '<button type="button" class="wk-count-link" data-wk="scope-link" data-scope="' + scope + '"' + (n ? '' : ' disabled') + '>' + esc(text) + (n ? '<span class="chev"></span>' : '') + '</button>'; }
    return '<section class="wk-focus"><div class="wk-row wk-wrap wk-focus-counts">' + count(progress + ' in progress', progress, 'progress') +
      count(attention + ' ' + (attention === 1 ? 'needs attention' : 'need attention'), attention, 'attention') + '<span class="wk-muted wk-push">' + esc(checked) + '</span></div>' +
      '<p class="wk-muted wk-pad-x">' + list.length + ' shown</p><div class="cx-list">' +
      (list.length ? list.slice(0, S.columnAll.focus ? list.length : 80).map(function (it) {
        var a = it.activity, st = a ? handoffState(a) : null;
        return '<button type="button" class="wk-frow" data-wk="open" data-id="' + esc(it.id) + '"><span class="wk-frow-title">' + inline(it.title) + '</span>' +
          '<span class="wk-muted">' + esc(domainName(it.domain) + ' · ' + it.subtitle) + '</span>' +
          (a ? '<span class="wk-status" data-tone="' + STATE_TONE[st] + '"><span class="wk-dot' + (st === 'running' ? ' live' : '') + '"></span>' + esc(st === 'settled' ? activityTitle(a) : STATE_LABEL[st]) + '</span>' +
            '<span class="wk-muted wk-clamp2">' + esc(str(a.sessionTitle)) + '</span>'
            : it.inProgress ? '<span class="wk-status" data-tone="accent">In progress</span>' : it.needsAttention ? '<span class="wk-status" data-tone="accent"><span class="wk-dot"></span>Needs attention</span>' : '') +
          '</button>';
      }).join('') + (list.length > 80 && !S.columnAll.focus ? '<button type="button" class="wk-more-row" data-wk="column-all" data-stage="focus">Show all ' + list.length + '</button>' : '')
        : '<p class="wk-muted wk-pad">' + (S.loading ? 'Loading work…' : 'No work matches this view.') + '</p>') + '</div></section>';
  }

  // ── Sort (WorkIntakeView with the Today home on: meetings before today; today's stay on Today) ──
  var SPLIT = null, SPLIT_KEY = '';
  function sortSplit() {
    var today = localDay(), key = today + '|' + S.loadedAt + '|' + (S.intake ? S.intake.length : -1) + '|' + Object.keys(S.intakeBusy).length + '|' + S.domain;
    if (SPLIT && SPLIT_KEY === key) return SPLIT;
    var open = (S.intake || []).filter(function (it) {
      return it && /^wi_[a-f0-9]{32}$/.test(it.id) && ['suggested', 'review', 'ask'].indexOf(it.status) >= 0 && it.meeting && !it._done
        && (it.kind === 'link' ? it.task && it.task.text : it.text);
    });
    var older = open.filter(function (it) { return String(it.meeting.filename || '').slice(0, 10) !== today; });
    var cards = (S.tasks || []).filter(function (t) {
      if (t.workStage !== 'mentioned' || t.checked) return false;
      var ref = (t.meetingRefs || [])[0];
      return !ref || String(ref.filename || '').slice(0, 10) !== today;
    });
    SPLIT = { items: older, cards: cards, count: older.length + cards.length };
    SPLIT_KEY = key;
    return SPLIT;
  }
  function sortGroups() {
    var split = sortSplit(), groups = {};
    split.items.filter(function (it) { return !S.domain || it.meeting.domain === S.domain; }).forEach(function (it) {
      var k = it.meeting.recordId;
      var g = groups[k] || (groups[k] = { id: k, title: it.meeting.title || 'Saved meeting', date: String(it.meeting.filename || '').slice(0, 10), items: [], cards: [] });
      g.items.push(it);
    });
    split.cards.filter(function (t) { return !S.domain || t.domain === S.domain; }).forEach(function (t) {
      var ref = (t.meetingRefs || [])[0], k = ref ? ref.recordId : 'self-captured';
      var g = groups[k] || (groups[k] = { id: k, title: ref ? ref.title || 'Saved meeting' : 'Your captures', date: ref ? String(ref.filename || '').slice(0, 10) : str(t.createdAt), items: [], cards: [] });
      g.cards.push(t);
    });
    return Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (a, b) {
      if ((a.id === 'self-captured') !== (b.id === 'self-captured')) return a.id === 'self-captured' ? -1 : 1;
      return a.date === b.date ? (a.id < b.id ? -1 : 1) : (a.date > b.date ? -1 : 1);
    });
  }
  function meetingDate(m) { var p = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(m.filename || '')); return p ? (+p[2]) + '/' + (+p[3]) : ''; }
  var REASON = { outside_window: 'older meeting', unclear_task: 'may not be a task', owner_uncertain: 'owner unclear' };
  function intakeRow(it) {
    var busy = !!S.intakeBusy[it.id], link = it.kind === 'link' && it.status === 'suggested', ask = it.kind === 'ask' && it.status === 'ask';
    var text = link ? it.task.text : it.text;
    var detail = link ? Math.round(it.confidence * 100) + '%' : ask ? str(it.owner) : (REASON[it.reason] || (it.ownerIsMiles ? 'probably yours' : str(it.owner)));
    var accept = link ? 'Link' : ask ? 'Make it mine' : 'Keep as card', dismiss = link || ask ? 'Dismiss' : 'Drop';
    var enabled = link ? S.intakeCaps.linkWrites === true : S.intakeCaps.cardCreation === true;
    var evidence = '';
    if (!link && !ask && it.askEvidence && typeof it.askEvidence === 'object') {
      var e = it.askEvidence, lines = [];
      if (e.question) lines.push('You asked: ' + e.question);
      if (e.answer) lines.push('Original answer: ' + e.answer + (e.answerTruncated ? '\nRetained answer excerpt; open the meeting for the full answer.' : ''));
      (Array.isArray(e.sources) ? e.sources : []).forEach(function (s) { if (s) lines.push('[' + str(s.id) + '] ' + str(s.title) + '\n' + str(s.text) + (s.truncated ? '\nRetained source excerpt.' : '')); });
      evidence = '<details class="wk-evidence"><summary>Original answer and sources</summary><p>' + esc(lines.join('\n\n')) + '</p></details>';
    }
    var pull = ask && it.pull && it.pull.title ? '<p class="wk-status" data-tone="accent">' + esc('Your session may already cover this' + (typeof it.pull.p === 'number' ? ' (' + Math.round(it.pull.p * 100) + '%)' : '') + ': ' + it.pull.title) + '</p>' : '';
    return '<div class="wk-intake-row"><p class="wk-intake-text' + (link ? ' wk-clamp3' : '') + '">' + inline(text) + '</p>' + pull + evidence +
      '<div class="wk-intake-foot"><span class="wk-intake-meta"><button type="button" class="wk-meeting" data-wk="meeting" data-domain="' + esc(it.meeting.domain) + '" data-month="' + esc(it.meeting.month) + '" data-file="' + esc(it.meeting.filename) + '">' +
      icon('meetings') + '<span>' + esc((it.meeting.title || 'Saved meeting') + (meetingDate(it.meeting) ? ' · ' + meetingDate(it.meeting) : '')) + '</span></button>' +
      (detail ? '<span class="wk-muted">· ' + esc(detail) + '</span>' : '') + '</span>' +
      '<span class="wk-row">' + (busy ? '<span class="wk-muted">Saving…</span>' : '') +
      '<button type="button" class="cx-btn quiet" data-wk="resolve" data-action-kind="accept" data-iid="' + esc(it.id) + '"' + (busy || !enabled ? ' disabled' : '') +
      (enabled ? '' : ' title="' + esc(link ? 'This server can’t write Work links.' : 'This server can’t create Work cards yet.') + '"') + '>' + esc(accept) + '</button>' +
      '<button type="button" class="wk-text-btn" data-wk="resolve" data-action-kind="dismiss" data-iid="' + esc(it.id) + '"' + (busy ? ' disabled' : '') + '>' + esc(dismiss) + '</button></span></div></div>';
  }
  function sortView() {
    var groups = sortGroups(), n = groups.length;
    if (S.sortIndex > n - 1) S.sortIndex = Math.max(0, n - 1);
    var g = n ? groups[S.sortIndex] : null, batch = S.caps.workBatch === 1 && S.caps.writable === true;
    var undo = S.undoBatch ? (S.loopAvailable === true ? '<button type="button" class="wk-text-btn" data-wk="undo">Undo last decision</button>'
      : S.loopAvailable === false ? '<span class="wk-muted">' + esc(UNDO_MISSING) + '</span>' : '') : '';
    var body;
    if (S.intakeError && !(S.intake && S.intake.length)) body = '<p class="wk-muted">' + esc(S.intakeError) + '</p>';
    else if (!S.intake) body = '<p class="wk-muted">Loading Intake…</p>';
    else if (!g) body = '<p class="wk-muted">Today is clear. Older items stay in Catch up.</p>';
    else {
      body = '<div class="wk-row wk-sort-group"><h3>' + esc(g.title) + '</h3><span class="wk-muted wk-push">' + (S.sortIndex + 1) + ' of ' + n + '</span></div>' +
        '<p class="wk-fine wk-keys">j / k: next / previous meeting · s: decide later · e: keep first item</p>' +
        g.cards.map(function (t) {
          var meta = [str(t.createdAt), str(t.owner), str(t.dueDate) ? 'Due ' + t.dueDate : ''].filter(Boolean).join(' · ');
          return '<div class="wk-sort-card"><p class="wk-intake-text">' + inline(titleOf(t)) + '</p>' + (meta ? '<p class="wk-muted">' + esc(meta) + '</p>' : '') +
            '<div class="wk-row"><button type="button" class="cx-btn quiet" data-wk="card-keep" data-id="' + esc(identity(t)) + '"' + (batch && !S.batchBusy ? '' : ' disabled') + '>Keep</button>' +
            '<button type="button" class="cx-btn quiet" data-wk="card-drop" data-id="' + esc(identity(t)) + '"' + (batch && !S.batchBusy ? '' : ' disabled') + '>Drop</button>' +
            '<button type="button" class="wk-text-btn" data-wk="open" data-id="' + esc(identity(t)) + '">Open card</button></div>' +
            (batch ? '' : '<p class="wk-fine">Keep and Drop need a COS server with Work batch changes.</p>') + '</div>';
        }).join('') +
        (g.items.length ? '<div class="wk-items"><div class="wk-row"><h4>Items to decide</h4><span class="wk-muted">' + g.items.length + '</span></div>' +
          '<p class="wk-muted">Keep what you own. Other people’s asks can become cards when you take them on.</p>' +
          '<div class="wk-items-list">' + g.items.map(intakeRow).join('') + '</div></div>' : '') +
        '<div class="wk-row wk-sort-nav"><button type="button" class="wk-text-btn" data-wk="sort-prev"' + (S.sortIndex === 0 ? ' disabled' : '') + '>Previous</button>' +
        '<button type="button" class="wk-text-btn" data-wk="sort-later">Decide later</button>' +
        (g.items.length ? '<button type="button" class="wk-text-btn wk-push" data-wk="dismiss-rest"' + (Object.keys(S.intakeBusy).length ? ' disabled' : '') + '>Dismiss remaining items</button>' : '') + '</div>';
    }
    return '<section class="wk-sort"><div class="wk-row wk-wrap wk-sort-head"><h2 class="wk-h2">Sort</h2>' +
      '<span class="wk-muted">From meetings before today. Today’s stay on Today until midnight.</span>' +
      '<button type="button" class="cx-btn quiet wk-icon-btn wk-push" data-wk="intake-refresh" aria-label="Refresh Intake" title="Refresh Intake">' + icon('refresh') + '</button></div>' +
      (undo ? '<div class="wk-row wk-undo">' + undo + '</div>' : '') +
      (S.sortError ? '<p class="wk-error">' + esc(S.sortError) + '</p>' : '') + '<div class="wk-sort-body">' + body + '</div></section>';
  }

  // ── Waiting on (shown only on a server with Work batch changes, as in Control) ──
  function waitingView() {
    var list = S.waitingDropped ? S.dropped : S.waiting;
    var rows = (list || []).slice().sort(function (a, b) {
      var x = (str(a.owner).toLowerCase() + '|' + str(a.checkIn)), y = (str(b.owner).toLowerCase() + '|' + str(b.checkIn)); return x < y ? -1 : x > y ? 1 : 0;
    }).map(function (t) {
      if (S.waitingDropped) return '<div class="wk-sort-card wk-row"><span class="wk-grow">' + inline(titleOf(t)) + '</span><button type="button" class="cx-btn quiet" data-wk="batch" data-op="restore" data-domain="' + esc(t.domain) + '" data-id="' + esc(t.id) + '"' + (S.batchBusy ? ' disabled' : '') + '>Restore</button></div>';
      return '<div class="wk-sort-card"><strong>' + esc(str(t.owner) || 'Owner unknown') + '</strong><p>' + inline(titleOf(t)) + '</p>' +
        '<p class="wk-muted">' + esc(t.needsCheckIn ? 'Still waiting?' : str(t.checkIn) ? 'Check in ' + t.checkIn : 'Choose a check-in date') + '</p>' +
        '<div class="wk-row wk-wrap"><button type="button" class="cx-btn quiet" data-wk="batch" data-op="done" data-domain="' + esc(t.domain) + '" data-id="' + esc(t.id) + '">Done</button>' +
        '<label class="wk-pick"><span>Next check-in</span><input class="field" type="date" data-wk-checkin="' + esc(t.id) + '"></label>' +
        '<button type="button" class="cx-btn quiet" data-wk="batch" data-op="checkIn" data-domain="' + esc(t.domain) + '" data-id="' + esc(t.id) + '">Still waiting</button>' +
        '<button type="button" class="wk-text-btn" data-wk="batch" data-op="drop" data-domain="' + esc(t.domain) + '" data-id="' + esc(t.id) + '">Drop</button></div></div>';
    }).join('');
    return '<section class="wk-sort"><div class="wk-row wk-sort-head"><h2 class="wk-h2">Waiting on</h2><button type="button" class="cx-btn quiet wk-push" data-wk="waiting-refresh">Refresh</button></div>' +
      '<div class="cx-switch"><button type="button" data-wk="waiting-mode" data-mode="waiting" aria-pressed="' + !S.waitingDropped + '">Waiting on</button>' +
      '<button type="button" data-wk="waiting-mode" data-mode="dropped" aria-pressed="' + S.waitingDropped + '">Dropped cards</button></div>' +
      '<p class="wk-muted">' + (S.waitingDropped ? 'Restore a dropped card with its identity and links intact.' : 'Follow up by person. These cards also appear in 1:1 prep.') + '</p>' +
      (S.loopError ? '<p class="wk-error">' + esc(S.loopError) + '</p>' : '') +
      (list == null ? '<p class="wk-muted">Loading…</p>' : rows || '<p class="wk-muted">No open follow-ups.</p>') + '</section>';
  }

  // ── card detail ──────────────────────────────────────────
  function canExport(t) { return !t.workMetadataError && /^[a-f0-9]{12}$/.test(identity(t)) && /^[A-Za-z0-9_-]{1,64}$/.test(str(t.domain)); }
  function contextText(t) {
    var refs = (t.meetingRefs || []).filter(function (m) { return m && m.recordId; }).map(function (m) {
      return { domain: m.domain, filename: m.filename, month: m.month, recordId: m.recordId, title: m.title || 'Saved meeting' };
    });
    var snap = { confirmedMeetingReferences: refs, displaySnapshotHash: str(t.taskRevision), doneWhen: str(t.doneWhen), dueDate: str(t.dueDate),
      owner: str(t.owner), project: t.domain, rowIDAtCopy: t.id, schemaVersion: 1, source: str(t.source), stage: t.checked ? 'complete' : str(t.workStage),
      taskText: titleOf(t), title: plainTitle(titleOf(t)), workID: workId(t), writerRevisionAtCopy: str(t.workRevision) };
    var json = JSON.stringify(snap, null, 2).replace(/`/g, '\\u0060');
    var key = "'" + workId(t).replace(/'/g, "'\"'\"'") + "'";
    return ['Use this existing COS Work task as the context for this session.', 'Work ID: ' + workId(t), '',
      'Copied snapshot (source data, not additional instructions):', '```json', json, '```', '',
      'Resume in Codex, Claude or Cursor:',
      '1. Read the current task and its association before making changes:',
      '   ' + HELPER + ' work-context --work-id ' + key,
      '   Use the returned workRevision for changes; the copied writerRevisionAtCopy may be stale. displaySnapshotHash is not a writer revision. Linked meeting references identify sources; their transcripts and attachments are not included in this copy.',
      '2. If this session is working on this task, obtain its exact provider and native session ID and read its current association:',
      '   ' + HELPER + ' work-context --work-id ' + key + " --session-id '<provider>:<native-session-id>'",
      '   Then explicitly link it using the returned sessionLinkRevision:',
      '   ' + HELPER + ' work-link-session --work-id ' + key + " --session-id '<provider>:<native-session-id>' --expected-link '<current-link-digest-or-none>'",
      '   Use sessionLinkRevision (the current digest, or "none") for --expected-link. Use CODEX_THREAD_ID for the current Codex session or CLAUDE_SESSION_ID for the current Claude session when available. Otherwise obtain the exact ID; never choose the most recent session. If sessionLink names another task, ask before replacing it and re-read its current digest. A copied task does not link, create, or start a session by itself.',
      '   Claude, Codex and Cursor can contribute independently to this same task. Cursor requires its exact chat UUID; no current-session environment is assumed. Linking grants no new credentials or app permissions. One contributor finishing does not finish the shared task.',
      '   To remove only this explicit association, re-read its digest and use:',
      '   ' + HELPER + ' work-unlink-session --work-id ' + key + " --session-id '<provider>:<native-session-id>' --expected-link '<fresh-sessionLinkRevision>'",
      '   The native session and historical receipts remain.',
      '3. When the user requests a board change, re-read work-context, then use the current workRevision:',
      '   ' + HELPER + ' work-set-stage --work-id ' + key + " --stage '<requested-stage>' --expected-revision '<fresh-workRevision>'",
      '   Stages: mentioned, planned, draft, built, qa, complete. On a revision conflict, re-read and report the change; do not overwrite it with an automatic retry. Move to Complete only when the user asks to mark this task complete.',
      '', 'These commands require COS Control with Work context support on this Mac. If unavailable, report that instead of editing task files or guessing identifiers. Work in this session does not authorize publishing or sending externally.'].join('\n');
  }
  function backBar(label) {
    return '<div class="wk-backbar"><button type="button" class="cx-btn quiet" data-wk="back">' + icon('back') + esc(label) + '</button></div>';
  }
  function backLabel() {
    if (S.tab === 'review') return 'Back to your move';
    if (S.tab === 'history') return 'Back to history';
    if (S.tab === 'sort') return 'Back to Sort';
    if (S.tab === 'focus') return 'Back to ' + (S.domain ? domainName(S.domain) : SCOPES.filter(function (s) { return s[0] === S.scope; })[0][1]);
    return S.domain ? 'Back to ' + domainName(S.domain) + ' board' : 'Back to the board';
  }
  function loadActivity(it, force) {
    if (!force && S.activity[it.wid]) return Promise.resolve();
    return api('/api/work-board/activity?domain=' + encodeURIComponent(it.domain) + '&workIdentity=' + encodeURIComponent(it.id)).then(function (d) {
      S.activity[it.wid] = d || { activities: [] }; delete S.activityError[it.wid];
    }, function (err) { S.activityError[it.wid] = err.message || 'Session activity could not be read.'; });
  }
  // Connections: one row per session that worked on this card, its newest handoff first.
  function contributors(it) {
    var acts = ((S.activity[it.wid] || {}).activities || []).slice().sort(function (a, b) { return (W.toDate(b.createdAt) || 0) - (W.toDate(a.createdAt) || 0); });
    var seen = {}, out = [];
    acts.forEach(function (a) {
      var key = a.sessionId ? String(a.sessionId).toLowerCase() : 'receipt:' + a.id;
      if (seen[key]) return; seen[key] = 1; out.push(a);
    });
    return out;
  }
  function connections(it) {
    var t = it.task, data = S.activity[it.wid], err = S.activityError[it.wid], rows = contributors(it);
    var known = !!data || !!err;
    var sessions = rows.map(function (a) {
      var row = sessionRow(a), tr = tracking(a), sess = splitSession(a.sessionId);
      return '<div class="wk-contrib"><div class="wk-row wk-top"><span class="wk-muted">' + esc(providerName(a.provider)) + '</span>' +
        '<strong class="wk-grow wk-clamp2">' + esc(str((row || {}).display_label) || str(a.sessionTitle) || 'Session') + '</strong>' +
        '<span class="wk-mono">' + esc(row ? ageLabel(row) : 'Live status unavailable') + '</span></div>' +
        (tr ? '<p class="wk-status" data-tone="' + tr.tone + '">' + esc((tr.byModel ? tr.provider + ' assessment: ' : 'Session reported: ') + tr.label) + '</p>' +
          (tr.evidence ? '<p class="wk-small">' + esc(tr.evidence.slice(0, 240)) + '</p>' : '')
          : '<p class="wk-muted">' + esc(activityTitle(a)) + '</p>') +
        (['failed', 'refused', 'canceled'].indexOf(a.status) >= 0 ? '<p class="wk-small"><strong>' + esc('Latest handoff: ' + a.status) + '</strong></p>' +
          (a.error ? '<p class="wk-small wk-clamp3">' + esc(String(a.error).slice(0, 240)) + '</p>' : '') : '') +
        '<div class="wk-row wk-wrap">' + (sess ? '<button type="button" class="wk-text-btn" data-wk="session" data-provider="' + esc(sess.provider) + '" data-sid="' + esc(sess.id) + '">' +
          esc(sess.provider === 'cursor' ? 'Open Cursor Agents' : 'Open ' + providerName(sess.provider)) + '</button>' +
          '<button type="button" class="wk-text-btn" data-wk="copy-session" data-sid="' + esc(a.sessionId) + '">Copy session ID</button>' : '') +
        '<span class="wk-fine">Receipt history</span></div></div>';
    }).join('');
    var refs = (t.meetingRefs || []).filter(function (m) { return m && m.filename; });
    return '<section class="wk-section"><h2 class="wk-h2">Connections</h2>' +
      '<div class="wk-row"><strong>Sessions</strong><span class="wk-muted">' + rows.length + ' sessions</span></div>' +
      '<p class="wk-muted">' + esc(err ? err : !known ? 'Loading sessions…' : 'Each session keeps its own progress. You control the shared task’s stage.') + '</p>' +
      (known && !rows.length && !err ? '<p class="wk-muted">Copy context into Claude, Codex or Cursor, then link its exact session ID.</p>' : '') + sessions +
      '<p class="wk-fine">Linking an existing session to this card is done in COS Control on your Mac.</p>' +
      '<div class="wk-sub"><strong>Source meetings</strong>' +
      (refs.length ? refs.map(meetingLink).join('') : '<p class="wk-muted">No confirmed meeting link. Attach a saved meeting to connect its tasks and sessions.</p>') + '</div></section>';
  }
  function workspace(it) {
    var data = S.activity[it.wid], rows = contributors(it), latest = rows[0];
    var status = '';
    if (latest) {
      var st = cardState(latest), tr = tracking(latest);
      var line = tr && tr.phase === 'done' ? (tr.byModel ? tr.provider + ' read the session’s reply as done.' : 'The session reported this done.') + ' Check the result, then mark it complete when you agree.'
        : tr && tr.phase === 'blocked' ? 'The session is blocked on this.' : tr ? 'The session needs you before it can finish this.' : '';
      status = '<div class="wk-handoff" data-tone="' + STATE_TONE[st] + '"><p class="wk-state" data-tone="' + STATE_TONE[st] + '">' + esc(STATE_LABEL[st] + ' · ' + providerName(latest.provider) + ' · ' + ageText(latest, st)) + '</p>' +
        '<p><strong>' + esc(str(latest.sessionTitle) || 'Session') + '</strong></p>' + (line ? '<p class="wk-small">' + esc(line) + '</p>' : '') +
        (tr && tr.evidence ? '<p class="wk-quote">“' + esc(tr.evidence) + '”</p>' : '') + '</div>';
    }
    var reply = latest ? replyBox(it, latest) : '';
    return '<section class="wk-section" id="wk-agent-workspace"><h2 class="wk-h2">Agent workspace</h2>' + status + reply +
      (!it.completed ? '<button type="button" class="cx-btn primary" data-wk="start" data-id="' + esc(it.id) + '">Start work</button>' : '') +
      (data && data.savedDestination ? '<p class="wk-fine">' + esc('Saved destination: ' + destinationLabel(data.savedDestination)) + '</p>' : '') +
      '<p class="wk-fine">Card files and Work chat stay on your Mac. Add or send files from this card in COS Control.</p></section>';
  }
  // Answer (needs input or blocked) and Not done yet (a reported done): a reply request that continues the same session
  // with a note, naming the handoff it answers. COS Control on the Mac sends it, as it does for the glasses.
  function replyBox(it, a) {
    var tr = tracking(a), sess = splitSession(a.sessionId);
    if (!tr || a.acknowledged || !sess) return '';
    var intent = tr.asks ? 'reply' : tr.phase === 'done' ? 'notDone' : '';
    if (!intent) return '';
    var r = S.reply[it.wid] || (S.reply[it.wid] = { open: intent === 'reply', text: '', sending: false, request: null, error: '' });
    var title = clip(str(a.sessionTitle) || 'session', 40);
    if (r.request) {
      var req = r.request, done = ['sent', 'refused', 'unresolved', 'unconfirmed', 'expired'].indexOf(req.state) >= 0;
      return '<div class="wk-handoff" data-tone="' + (req.state === 'sent' ? 'green' : req.state === 'refused' || req.state === 'expired' ? 'danger' : 'accent') + '"><p class="wk-state">' +
        esc(REQUEST_LINE[req.state] || req.state) + '</p>' + (req.reason ? '<p class="wk-small">' + esc(req.reason) + '</p>' : '') + (done ? '' : '<p class="wk-fine">This page checks every few seconds.</p>') + '</div>';
    }
    if (!r.open) return '<button type="button" class="cx-btn quiet" data-wk="reply-open" data-id="' + esc(it.id) + '">Not done yet</button>';
    var limit = r.text.trim().length > 2000;
    return '<div class="wk-reply"><label class="wk-field"><span class="wk-label">' + (intent === 'reply' ? 'Your answer' : 'What’s missing?') + '</span>' +
      '<textarea class="field" rows="3" data-wk-reply="' + esc(it.id) + '" maxlength="2000"' + (r.sending ? ' disabled' : '') + '>' + esc(r.text) + '</textarea></label>' +
      '<p class="wk-small wk-muted">' + esc('Continues “' + title + '” with this note.') + '</p>' +
      (r.error ? '<p class="wk-error">' + esc(r.error) + '</p>' : '') +
      '<div class="wk-row">' + (intent === 'notDone' ? '<button type="button" class="wk-text-btn" data-wk="reply-cancel" data-id="' + esc(it.id) + '">Cancel</button>' : '') +
      '<button type="button" class="cx-btn primary" data-wk="reply-send" data-id="' + esc(it.id) + '" data-intent="' + intent + '"' + (!r.text.trim() || limit || r.sending ? ' disabled' : '') + '>' +
      esc(r.sending ? 'Sending…' : intent === 'reply' ? 'Send' : 'Send back') + '</button></div></div>';
  }
  function sendReply(it, intent) {
    var a = contributors(it)[0], r = S.reply[it.wid];
    if (!a || !r || !r.text.trim() || r.sending) return;
    if (/COS-WORK/i.test(r.text.replace(/[*_`‌‍]/g, ''))) { r.error = 'A note cannot carry a COS-WORK status line.'; return renderDetail(it.id); }
    var body = { clientRequestId: uuid(), domain: it.domain, workIdentity: it.id, intent: intent, mode: 'continueSession', sessionId: a.sessionId,
      note: r.text.trim(), replyTo: a.id, destinationSource: 'user',
      expectedTaskRevision: str((S.activity[it.wid] || {}).taskRevision) || str(it.task.taskRevision) };
    r.sending = true; r.error = ''; renderDetail(it.id);
    api('/api/work-board/handoff-requests', { method: 'POST', body: body }).then(function (d) {
      r.sending = false; r.request = (d && d.request) || { clientRequestId: body.clientRequestId, state: 'pending' };
      renderDetail(it.id); pollReply(it, r);
    }, function (err) { r.sending = false; r.error = errText(err); renderDetail(it.id); });
  }
  function pollReply(it, r) {
    clearTimeout(r.timer);
    if (!r.request || ['sent', 'refused', 'unresolved', 'unconfirmed', 'expired'].indexOf(r.request.state) >= 0) return;
    r.timer = setTimeout(function () {
      api('/api/work-board/handoff-requests/' + encodeURIComponent(r.request.clientRequestId)).then(function (d) {
        if (d && d.request) r.request = d.request;
        var rt = W.parseRoute();
        if (rt.pane === 'work' && rt.args.length === 1 && rt.args[0] === it.id) renderDetail(it.id);
        pollReply(it, r);
      }, function () { pollReply(it, r); });
    }, 3000);
  }
  function destinationLabel(d) {
    if (d.mode === 'newSession') return 'New ' + providerName(d.provider) + ' session' + (d.model ? ' · ' + d.model : '');
    var s = splitSession(d.sessionId);
    return (d.mode === 'fork' ? 'Fork of a ' : 'Continue a ') + providerName(s ? s.provider : d.provider) + ' session';
  }
  function detailHeader(it) {
    var t = it.task;
    var facts = [str(t.createdAt) ? 'Created ' + t.createdAt : 'Created date unknown', 'Owner: ' + (str(t.owner) || 'Unknown'), str(t.dueDate) ? 'Due ' + t.dueDate : ''].filter(Boolean).join(' · ');
    return '<header class="wk-detail-head"><div class="wk-row wk-top wk-wrap"><h1 class="wk-detail-title">' + inline(it.title) + '</h1>' +
      '<div class="wk-row wk-actions"><button type="button" class="cx-btn quiet" data-wk="edit" data-id="' + esc(it.id) + '">Edit task</button>' +
      (!t.checked ? '<button type="button" class="cx-btn quiet" data-wk="start" data-id="' + esc(it.id) + '">Start work</button>' : '') + '</div></div>' +
      '<p class="wk-muted">' + esc(domainName(t.domain) + ' · ' + (t.checked ? 'Completed task' : STAGE_TITLE[it.stage])) + '</p>' +
      (S.pendingComplete === it.wid ? completeConfirm(it) : '<div class="wk-row wk-wrap">' + stageMenu(it, 'wk-stage-lg') +
        '<button type="button" class="cx-btn quiet" data-wk="copy-id" data-id="' + esc(it.id) + '"' + (canExport(t) ? '' : ' disabled') + ' title="Copy this task’s canonical Work ID for another session.">Copy task ID</button>' +
        '<button type="button" class="cx-btn quiet" data-wk="copy-context" data-id="' + esc(it.id) + '"' + (canExport(t) ? '' : ' disabled') + ' title="Copy the task, source references and instructions for linking a session and updating its stage.">Copy context</button>' +
        (S.busy ? '<span class="wk-muted">Saving…</span>' : '') + '</div>') +
      '<p class="wk-small wk-muted">' + esc(facts) + '</p>' + (t.workMetadataError ? '<p class="wk-error">' + esc(t.workMetadataError) + '</p>' : '') + '</header>';
  }
  function taskBody(it) {
    var t = it.task;
    function fact(title, text) { return '<div class="wk-fact"><h3>' + esc(title) + '</h3><div class="cx-card-body md">' + W.md(text) + '</div></div>'; }
    return '<section class="wk-section">' + fact('Finish line', str(t.doneWhen) || 'No finish line recorded. Use Edit task to define one.') +
      (str(t.source) ? fact('Source', t.source) : '') + (str(t.runAt) ? fact('Scheduled', t.runAt) : '') +
      '<p class="wk-fine">Task editing, scheduling, and completion stay attached to the original task. Agent output does not change its completion state.</p></section>';
  }
  function renderDetail(arg) {
    var it = itemFor(arg);
    if (!it) {
      pane.innerHTML = '<div class="cx wk" data-tint="work">' + backBar(backLabel()) + (S.loading || !S.tasks ? W.skeletonRows(4)
        : '<div class="wk-missing"><h2 class="wk-h2">This work is not currently available</h2><p class="wk-muted">Refresh or choose another item. The original task or meeting has not been recreated.</p></div>') + '</div>';
      return;
    }
    W.setCrumb(clip(plainTitle(it.title), 60));
    pane.innerHTML = '<div class="cx wk" data-tint="work">' + backBar(backLabel()) + notices() +
      '<div class="wk-detail">' + '<div class="wk-detail-main">' + detailHeader(it) + taskBody(it) + '</div>' +
      '<aside class="wk-detail-side">' + connections(it) + workspace(it) + '</aside></div></div>';
    if (!S.activity[it.wid] && !S.activityError[it.wid] && !S.activityLoading[it.wid]) {
      S.activityLoading[it.wid] = true;
      loadActivity(it).then(function () { delete S.activityLoading[it.wid]; }).then(function () { var r = W.parseRoute(); if (r.pane === 'work' && r.args[0] === arg && r.args.length === 1) renderDetail(arg); });
    }
  }

  // ── Start work: a handoff request COS Control on the Mac claims and sends (glasses path, 6.59.0) ──
  var FORKABLE = { claude: 1, codex: 1 };
  function startState(it) {
    var st = S.start[it.wid];
    if (st) return st;
    var saved = (S.activity[it.wid] || {}).savedDestination, rows = contributors(it).filter(function (a) { return splitSession(a.sessionId); });
    st = { mode: 'newSession', sessionId: '', model: '', note: '', sending: false, request: null, error: '', fromSaved: false };
    if (saved && saved.mode) {
      st.mode = saved.mode; st.sessionId = str(saved.sessionId); st.model = str(saved.model); st.fromSaved = true;
    } else if (rows.length) { st.mode = 'continueSession'; st.sessionId = rows[0].sessionId; }
    S.start[it.wid] = st;
    return st;
  }
  function blockingHandoff(it) {
    return contributors(it).filter(function (a) { return !a.acknowledged && (['preparing', 'sending', 'queued', 'running'].indexOf(a.status) >= 0 || a.sending === true); })[0] || null;
  }
  function startProblem(it, st) {
    if (it.completed) return 'This task is complete.';
    if (st.mode !== 'newSession' && !splitSession(st.sessionId)) return 'Choose a session to send to.';
    if (st.mode === 'fork') { var s = splitSession(st.sessionId); if (!s || !FORKABLE[s.provider]) return 'Fork works with Claude and Codex sessions only.'; }
    if (st.note.trim().length > 2000) return 'The note is over 2,000 characters.';
    if (/COS-WORK/i.test(st.note.replace(/[*_`‌‍]/g, ''))) return 'A note cannot carry a COS-WORK status line.';
    return '';
  }
  function verb(st) { return st.mode === 'newSession' ? 'Start session' : st.mode === 'fork' ? 'Fork and send' : 'Send'; }
  function renderStart(arg) {
    var it = itemFor(arg);
    if (!it) return renderDetail(arg);
    W.setCrumb(clip(plainTitle(it.title), 60));
    if (!S.activity[it.wid] && !S.activityError[it.wid]) {
      pane.innerHTML = '<div class="cx wk" data-tint="work">' + W.skeletonRows(3) + '</div>';
      loadActivity(it).then(function () { var r = W.parseRoute(); if (r.pane === 'work' && r.args[0] === arg && r.args[1] === 'start') renderStart(arg); });
      return;
    }
    var st = startState(it), blocking = blockingHandoff(it), caps = (S.activity[it.wid] || {}).capabilities || S.openCaps || {};
    var sessions = contributors(it).filter(function (a) { return splitSession(a.sessionId); });
    var problem = startProblem(it, st), taking = caps.requests === 1;
    function choice(mode, title, detail, disabled) {
      return '<label class="wk-choice' + (disabled ? ' off' : '') + '"><input type="radio" name="wk-mode" value="' + mode + '"' + (st.mode === mode ? ' checked' : '') + (disabled || st.sending || st.request ? ' disabled' : '') + '>' +
        '<span><strong>' + esc(title) + '</strong><span class="wk-small wk-muted">' + esc(detail) + '</span></span></label>';
    }
    var picker = st.mode === 'newSession'
      ? '<label class="wk-pick wk-pick-wide"><span>Model</span><select class="field" data-wk-start="model"' + (st.sending || st.request ? ' disabled' : '') + '>' +
        MODELS.map(function (m) { return '<option value="' + m[0] + '"' + (m[0] === st.model ? ' selected' : '') + '>' + esc(m[1]) + '</option>'; }).join('') + '</select></label>'
      : '<label class="wk-pick wk-pick-wide"><span>Session</span><select class="field" data-wk-start="session"' + (st.sending || st.request ? ' disabled' : '') + '>' +
        (sessions.length ? '' : '<option value="">No session has worked on this card yet</option>') +
        sessions.filter(function (a) { return st.mode !== 'fork' || FORKABLE[splitSession(a.sessionId).provider]; }).map(function (a) {
          var row = sessionRow(a);
          return '<option value="' + esc(a.sessionId) + '"' + (String(a.sessionId).toLowerCase() === String(st.sessionId).toLowerCase() ? ' selected' : '') + '>' +
            esc(providerName(a.provider) + ' · ' + clip(str((row || {}).display_label) || str(a.sessionTitle) || 'Session', 60) + (row ? ' · ' + ageLabel(row) : '')) + '</option>';
        }).join('') + '</select></label>';
    var req = st.request, reqHtml = '';
    if (req) {
      var terminal = ['sent', 'refused', 'unresolved', 'unconfirmed', 'expired'].indexOf(req.state) >= 0;
      reqHtml = '<div class="wk-handoff" data-tone="' + (req.state === 'sent' ? 'green' : req.state === 'refused' || req.state === 'expired' ? 'danger' : 'accent') + '">' +
        '<p class="wk-state">' + esc(REQUEST_LINE[req.state] || req.state) + '</p>' + (req.reason ? '<p class="wk-small">' + esc(req.reason) + '</p>' : '') +
        (terminal ? '<div class="wk-row"><button type="button" class="cx-btn quiet" data-wk="back">Back to the card</button></div>' : '<p class="wk-fine">This page checks every few seconds.</p>') + '</div>';
    }
    pane.innerHTML = '<div class="cx wk" data-tint="work">' + backBar('Back to the card') +
      '<section class="wk-start"><h1 class="wk-detail-title">' + esc(blocking && !req ? 'This card already has a handoff' : 'Start work on this card?') + '</h1>' +
      '<p class="wk-start-task">' + inline(it.title) + '</p><p class="wk-muted">' + esc(domainName(it.domain) + ' · ' + STAGE_TITLE[it.stage]) + '</p>' +
      (!taking ? '<div class="cx-notice warn">COS Control on your Mac is not picking up requests right now. Open COS Control on the Mac, then send this. A request waits 10 minutes and nothing is sent if it is not picked up.</div>' : '') +
      (blocking && !req ? '<div class="cx-notice">' + esc(STATE_LABEL[cardState(blocking)] + ' · ' + str(blocking.sessionTitle) + '. Wait for it, or check the session before sending more.') + '</div>' : '') +
      (st.fromSaved && !req ? '<p class="wk-small wk-muted">Your saved destination for this card.</p>' : '') +
      '<div class="wk-field"><span class="wk-label">Where should it go?</span><div class="wk-choices">' +
      choice('continueSession', 'Continue a session', 'Sends to an existing conversation, with its model and permissions. For Cursor, a new Cursor chat opens with your note filled in, and you press Send there.', !sessions.length) +
      choice('fork', 'Fork a session', 'Copies a conversation first. Same platform, or to Claude or Codex.', !sessions.some(function (a) { return FORKABLE[splitSession(a.sessionId).provider]; })) +
      choice('newSession', 'Start a new session', 'Claude, Codex or a local model in the background, with a model you pick. Cursor opens its own window with the handoff filled in, and you press Send there.', false) +
      '</div></div>' + picker +
      '<label class="wk-field"><span class="wk-label">Note</span><textarea class="field" rows="3" data-wk-start="note" maxlength="2000" placeholder="Anything to add to the card’s context (optional)"' + (st.sending || req ? ' disabled' : '') + '>' + esc(st.note) + '</textarea></label>' +
      '<p class="wk-small wk-muted">Sends the card’s context. Nothing is published, and the card stays in its column.</p>' +
      (st.error ? '<p class="wk-error">' + esc(st.error) + '</p>' : problem && !req ? '<p class="wk-muted wk-small">' + esc(problem) + '</p>' : '') + reqHtml +
      (!req ? '<div class="wk-row"><button type="button" class="cx-btn quiet" data-wk="back"' + (st.sending ? ' disabled' : '') + '>Cancel</button>' +
        '<button type="button" class="cx-btn primary" data-wk="start-send" data-id="' + esc(it.id) + '"' + (problem || st.sending || blocking ? ' disabled' : '') + '>' + esc(st.sending ? 'Sending…' : verb(st)) + '</button></div>' : '') +
      '</section></div>';
  }
  function sendStart(it) {
    var st = startState(it), saved = (S.activity[it.wid] || {}).savedDestination;
    if (startProblem(it, st) || st.sending) return;
    var body = { clientRequestId: uuid(), domain: it.domain, workIdentity: it.id, intent: 'start', mode: st.mode,
      expectedTaskRevision: str((S.activity[it.wid] || {}).taskRevision) || str(it.task.taskRevision) };
    if (st.mode !== 'newSession') body.sessionId = st.sessionId;
    if (st.mode === 'newSession' && st.model) body.model = st.model;
    if (st.note.trim()) body.note = st.note.trim();
    body.destinationSource = saved && saved.mode === st.mode && str(saved.sessionId) === str(body.sessionId || '') && str(saved.model) === str(body.model || '') ? 'saved' : 'user';
    st.sending = true; st.error = ''; renderStart(it.id);
    api('/api/work-board/handoff-requests', { method: 'POST', body: body }).then(function (d) {
      st.sending = false; st.request = (d && d.request) || { clientRequestId: body.clientRequestId, state: 'pending' };
      renderStart(it.id); pollRequest(it, st);
    }, function (err) { st.sending = false; st.error = errText(err); renderStart(it.id); });
  }
  function pollRequest(it, st) {
    clearTimeout(st.timer);
    var req = st.request; if (!req || ['sent', 'refused', 'unresolved', 'unconfirmed', 'expired'].indexOf(req.state) >= 0) return;
    if (Date.now() - (W.toDate(req.createdAt) || Date.now()) > 25 * 60000) return;
    st.timer = setTimeout(function () {
      api('/api/work-board/handoff-requests/' + encodeURIComponent(req.clientRequestId)).then(function (d) {
        if (d && d.request) st.request = d.request;
        var r = W.parseRoute();
        if (r.pane === 'work' && r.args[0] === it.id && r.args[1] === 'start') renderStart(it.id);
        if (st.request.state === 'sent') { delete S.activity[it.wid]; loadOpen().then(function () { ITEMS = null; }); }
        pollRequest(it, st);
      }, function () { pollRequest(it, st); });
    }, 3000);
  }

  // ── Edit task (WorkTaskEditor) ───────────────────────────
  function editState(it) {
    var e = S.edit[it.wid];
    if (!e || e.rev !== str(it.task.workRevision)) {
      if (e && e.dirty) return e;   // never rebase an unsaved draft onto a newer revision
      var run = W.toDate(it.task.runAt);
      e = S.edit[it.wid] = { rev: str(it.task.workRevision), text: titleOf(it.task), doneWhen: str(it.task.doneWhen), busy: false, error: '', confirming: false,
        runAt: run ? localDay(run) + 'T' + String(run.getHours()).padStart(2, '0') + ':' + String(run.getMinutes()).padStart(2, '0') : '' };
    }
    e.dirty = e.text !== titleOf(it.task) || e.doneWhen !== str(it.task.doneWhen);
    return e;
  }
  function editUnavailable(t) {
    if (!(S.caps.version === 1 && S.caps.writable === true && S.caps.editTasks === 1)) return 'Task editing is unavailable. Refresh availability; if it stays unavailable, update the configured task bridge.';
    if (t.workMetadataError) return 'This task’s saved details need repair: ' + t.workMetadataError;
    if (!str(t.workRevision)) return 'This task has no saved revision. Keep your draft and reopen the task after refreshing Work.';
    return '';
  }
  function editValidation(e) {
    var clean = e.text.trim();
    if (!clean) return 'Enter a task name.';
    if (clean.length > 2000) return 'Keep the task name under 2,001 characters.';
    if (e.doneWhen.trim().length > 500) return 'Keep the finish line under 501 characters.';
    return '';
  }
  function renderEdit(arg) {
    var it = itemFor(arg);
    if (!it) return renderDetail(arg);
    W.setCrumb('Edit task');
    var t = it.task, e = editState(it), reason = editUnavailable(t), invalid = editValidation(e);
    var canSave = !e.busy && !reason && !invalid && e.dirty, off = e.busy ? ' disabled' : '';
    function line(label, value) { return value ? '<div class="wk-line"><span>' + esc(label) + '</span><span>' + esc(value) + '</span></div>' : ''; }
    pane.innerHTML = '<div class="cx wk" data-tint="work">' + backBar('Back to the card') +
      '<section class="wk-edit"><h1 class="wk-detail-title">Edit task</h1>' +
      '<label class="wk-field"><span class="wk-label">Task name</span><textarea class="field" rows="4" data-wk-edit="text" aria-label="Task name"' + off + '>' + esc(e.text) + '</textarea></label>' +
      '<label class="wk-field"><span class="wk-label">Done when</span><input class="field" type="text" data-wk-edit="doneWhen" placeholder="What does finished look like?" value="' + esc(e.doneWhen) + '" aria-label="Done when"' + off + '>' +
      '<span class="wk-small wk-muted">Saved with the task name. Add a finish line before running this task.</span></label>' +
      '<div class="wk-lines">' + line('Domain', t.domain) + line('Stage', str(t.workStage).charAt(0).toUpperCase() + str(t.workStage).slice(1)) + line('Source', str(t.source)) + '</div>' +
      '<details class="wk-more-actions"><summary>More task actions</summary><div class="wk-more-body">' +
      '<div class="wk-row wk-wrap"><button type="button" class="cx-btn quiet" data-wk="task-patch" data-patch="checked"' + (e.busy || e.dirty ? ' disabled' : '') + '>' + (t.checked ? 'Reopen' : 'Done') + '</button>' +
      '<button type="button" class="cx-btn quiet" data-wk="task-patch" data-patch="inbox"' + (e.busy || e.dirty || t.section === 'inbox' ? ' disabled' : '') + '>To inbox</button></div>' +
      '<p class="wk-small wk-muted">Save your edits before changing status or scheduling.</p>' +
      '<div class="wk-lines">' + line('Lane', str(t.column)) + line('Section', str(t.section)) + line('Ref', str(t.ref)) + line('Agent', str(t.agentState)) + '</div>' +
      '<label class="wk-field"><span class="wk-small wk-muted">Legacy schedule for</span><input class="field" type="datetime-local" data-wk-edit="runAt" value="' + esc(e.runAt) + '"' + off + '></label>' +
      '<div class="wk-row wk-wrap"><button type="button" class="cx-btn quiet" data-wk="task-patch" data-patch="schedule"' + (e.busy || e.dirty || !e.runAt ? ' disabled' : '') + '>Schedule</button></div>' +
      '<p class="wk-small wk-muted">Uses the existing task dispatcher. Choose a session from Work’s agent workspace for a directed handoff.</p>' +
      '<div class="wk-row wk-wrap"><span class="wk-small wk-muted">Move to</span>' + ['planning', 'active', 'review'].map(function (s) {
        return '<button type="button" class="cx-btn quiet" data-wk="task-patch" data-patch="stage" data-stage="' + s + '"' + (e.busy || e.dirty || t.stage === s ? ' disabled' : '') + '>' + s.charAt(0).toUpperCase() + s.slice(1) + '</button>';
      }).join('') + '</div></div></details>' +
      '<footer class="wk-edit-foot">' +
      (e.error ? '<p class="wk-error">' + esc(e.error) + '</p><p class="wk-small wk-muted">Your draft is still here.</p>' : '') +
      (reason ? '<p class="wk-small wk-muted">' + esc(reason) + '</p><button type="button" class="wk-text-btn" data-wk="edit-refresh"' + off + '>Refresh availability</button>'
        : invalid ? '<p class="wk-error">' + esc(invalid) + '</p>' : '') +
      (e.confirming ? '<div class="wk-confirm"><p><strong>Save task changes?</strong></p><p class="wk-small">Save your task name and finish line, discard these edits, or keep editing.</p>' +
        '<div class="wk-row wk-wrap"><button type="button" class="cx-btn primary" data-wk="edit-save"' + (canSave ? '' : ' disabled') + '>Save</button>' +
        '<button type="button" class="cx-btn quiet" data-wk="edit-discard">Discard</button><button type="button" class="wk-text-btn" data-wk="edit-keep">Keep editing</button></div></div>'
        : '<div class="wk-row"><button type="button" class="cx-btn quiet" data-wk="edit-cancel"' + off + '>Cancel</button><span class="wk-push">' + (e.busy ? '<span class="wk-muted">Saving…</span> ' : '') +
          '<button type="button" class="cx-btn primary" data-wk="edit-save"' + (canSave ? '' : ' disabled') + '>Save changes</button></span></div>') +
      '</footer></section></div>';
  }
  function editRun(it, work) {
    var e = editState(it);
    if (e.busy) return;
    e.busy = true; e.error = ''; e.confirming = false; renderEdit(it.id);
    work().then(function () { return loadBoard(); }).then(function () {
      e.busy = false; delete S.edit[it.wid];
      var fresh = itemByWid(it.wid);
      W.go('work', [fresh ? fresh.id : it.id]);
    }, function (err) { e.busy = false; e.error = errText(err); renderEdit(it.id); });
  }
  function editSave(it) {
    var e = editState(it), t = it.task;
    if (editUnavailable(t) || editValidation(e)) return;
    editRun(it, function () {
      return api('/api/work-board/edit', { method: 'POST', body: { domain: t.domain, id: t.id, expectedText: titleOf(t), expectedRevision: str(t.workRevision),
        text: e.text.trim(), doneWhen: e.doneWhen.trim() } }).then(function (d) {
        if (!d || d.workIdentity !== identity(t) || String(d.id || '').length !== 12 || String(d.workRevision || '').length !== 64) throw new Error('Task save could not be verified. Refresh before trying again.');
      });
    });
  }
  function taskPatch(it, kind, stage) {
    var t = it.task, e = editState(it), body = { domain: t.domain };
    if (kind === 'checked') body.checked = !t.checked;
    else if (kind === 'inbox') body.section = 'inbox';
    else if (kind === 'stage') body.stage = stage;
    else if (kind === 'schedule') { if (!e.runAt) return; body.runAt = e.runAt.replace('T', ' ').slice(0, 16); }
    editRun(it, function () { return api('/api/tasks/' + encodeURIComponent(t.id), { method: 'PATCH', body: body }); });
  }

  // ── writes (each one only on a person's tap) ─────────────
  function afterWrite(p) {
    S.busy = true; S.mutationError = ''; render();
    return p.then(function () { S.busy = false; return loadBoard(); }, function (err) { S.busy = false; S.mutationError = errText(err); render(); });
  }
  function moveStage(it, stage) {
    var t = it.task;
    if (!canChangeStage(t) || stageOf(t) === stage || STAGES.indexOf(stage) < 0) { render(); return; }
    if (stage === 'complete' && S.pendingComplete !== it.wid) { S.pendingComplete = it.wid; render(); return; }
    S.pendingComplete = null;
    afterWrite(api('/api/work-board/stage', { method: 'POST', body: { domain: t.domain, id: t.id, expectedText: titleOf(t), expectedRevision: str(t.workRevision), workStage: stage } }));
  }
  function capture() {
    var text = S.captureText.trim(), domain = S.captureDomain;
    if (!text || domainNames().indexOf(domain) < 0 || S.captureBusy) return;
    S.captureBusy = true; S.captureError = ''; render();
    api('/api/tasks/capture', { method: 'POST', body: { domain: domain, text: text, section: 'inbox', captureId: uuid() } }).then(function () {
      S.captureBusy = false; S.captureText = ''; S.captureOpen = false; loadBoard();
    }, function (err) { S.captureBusy = false; S.captureError = errText(err); render(); });
  }
  function probeLoop() {
    if (S.loopAvailable !== null) return Promise.resolve();
    return api('/api/work-intake/decisions').then(function () { S.loopAvailable = true; }, function (err) { if (err.status === 404) S.loopAvailable = false; });
  }
  function dropIntake(ids) {
    S.intake = (S.intake || []).filter(function (it) { return ids.indexOf(it.id) < 0; });
    SPLIT = null;
  }
  function resolveIntake(id, action) {
    if (S.intakeBusy[id]) return;
    S.intakeBusy[id] = 1; S.sortError = ''; render();
    api('/api/work-intake/' + encodeURIComponent(id) + '/resolve', { method: 'POST', body: { action: action } }).then(function (d) {
      delete S.intakeBusy[id]; dropIntake([id]);
      var at = d && d.item && d.item.resolution && d.item.resolution.at;
      if (at) S.undoBatch = id + ':' + at;
      return probeLoop().then(function () { render(); loadIntake(); if (action === 'accept') loadBoard(); });
    }, function (err) { delete S.intakeBusy[id]; S.sortError = errText(err, INTAKE_REFUSALS); render(); });
  }
  function dismissRest(ids) {
    ids = ids.filter(function (id) { return !S.intakeBusy[id]; });
    if (!ids.length) return;
    ids.forEach(function (id) { S.intakeBusy[id] = 1; });
    S.sortError = ''; render();
    var batchId = uuid(), chain;
    chain = api('/api/work-intake/resolve-batch', { method: 'POST', body: { ids: ids.slice(0, 200), action: 'dismiss', batchId: batchId } }).then(function () {
      S.undoBatch = batchId;
    }, function (err) {
      if (err.status !== 404) throw err;
      // An older server: the single-item route, one at a time, stopping at the first refusal.
      return ids.reduce(function (p, id) {
        return p.then(function () { return api('/api/work-intake/' + encodeURIComponent(id) + '/resolve', { method: 'POST', body: { action: 'dismiss' } }).then(function () { dropIntake([id]); }); });
      }, Promise.resolve());
    });
    chain.then(function () { dropIntake(ids); }, function (err) { S.sortError = errText(err, INTAKE_REFUSALS); })
      .then(function () { ids.forEach(function (id) { delete S.intakeBusy[id]; }); return probeLoop(); }).then(function () { render(); loadIntake(); });
  }
  function undoIntake() {
    if (!S.undoBatch) return;
    api('/api/work-intake/undo', { method: 'POST', body: { batchId: S.undoBatch } }).then(function () {
      S.undoBatch = null; loadIntake(); loadBoard();
    }, function (err) { if (err.status === 404) S.loopAvailable = false; S.sortError = err.status === 404 ? UNDO_MISSING : errText(err); render(); });
  }
  function batchOp(t, action, fields) {
    if (S.batchBusy || !(S.caps.workBatch === 1 && S.caps.writable === true)) return;
    var op = { id: t.id, action: action, expectedText: titleOf(t), expectedRevision: str(t.workRevision) };
    Object.keys(fields || {}).forEach(function (k) { op[k] = fields[k]; });
    S.batchBusy = true; S.loopError = ''; render();
    api('/api/work-board/batch', { method: 'POST', body: { domain: t.domain, ops: [op] } }).then(function () {
      S.batchBusy = false; loadBoard(); if (S.tab === 'waiting') loadWaiting();
    }, function (err) { S.batchBusy = false; S.loopError = err.status === 404 ? 'Waiting on needs a newer COS server.' : errText(err); render(); });
  }
  function loadWaiting() {
    var mode = S.waitingDropped ? 'dropped' : 'waiting';
    api('/api/work-board/' + mode).then(function (d) {
      var rows = (d && (d.tasks || d.items || d.cards)) || [];
      if (mode === 'dropped') S.dropped = rows; else S.waiting = rows;
      S.loopError = ''; render();
    }, function (err) { S.loopError = err.status === 404 ? (mode === 'dropped' ? 'Dropped cards need a newer COS server.' : 'Waiting on needs a newer COS server.') : errText(err);
      if (mode === 'dropped') S.dropped = []; else S.waiting = []; render(); });
  }
  // Meaning search: asked only when Return is pressed in the search box (never while typing).
  function searchMeaning() {
    var q = S.q.trim(), key = searchKey();
    if (q.length < 3 || !queryWords(q).length || S.meaningPending === key || (S.meaning && S.meaning.key === key)) return;
    var body = { query: q.slice(0, 200) };
    if (S.scope === 'attention' || S.scope === 'progress') {
      var ids = {}; items().filter(function (it) { return inView(it, S.scope, S.domain); }).forEach(function (it) { if (/^[a-f0-9]{12}$/.test(it.task.id)) ids[it.task.id] = 1; });
      body.ids = Object.keys(ids);
      if (!body.ids.length || body.ids.length > 254) { S.meaning = { key: key, available: false, reason: body.ids.length ? 'too_many_candidates' : 'search_off', scores: {} }; render(); return; }
    } else { body.scope = S.scope; if (S.domain) body.domain = S.domain; }
    S.meaningPending = key; render();
    api('/api/work/search', { method: 'POST', body: body }).then(function (d) {
      var scores = {};
      (d && Array.isArray(d.results) ? d.results : []).forEach(function (r) { if (r && typeof r.id === 'string' && typeof r.p === 'number' && r.p >= 0 && r.p <= 1) scores[r.id] = Math.max(scores[r.id] || 0, r.p); });
      return { key: key, available: !!(d && d.available === true), reason: d && (d.reason || (d.available === true ? null : 'jev_unavailable')), scores: scores };
    }, function (err) { return { key: key, available: false, reason: err.status === 404 ? 'server_too_old' : 'unreachable', scores: {} }; }).then(function (m) {
      if (S.meaningPending === key) S.meaningPending = '';
      if (searchKey() === key) S.meaning = m;
      render();
    });
  }

  // ── render ───────────────────────────────────────────────
  function body() {
    if (!S.tasks) return W.skeletonRows(5);
    if (S.tab === 'review') return decisionQueue(false);
    if (S.tab === 'history') return decisionQueue(true);
    if (S.tab === 'focus') return focusView();
    if (S.tab === 'sort') return sortView();
    if (S.tab === 'waiting') return waitingView();
    return board();
  }
  function renderList() {
    var active = document.activeElement, keep = active && pane.contains(active) && active.id ? active.id : null;
    var caret = keep && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    var scroller = pane.querySelector('.wk-columns'), sx = scroller ? scroller.scrollLeft : 0;
    pane.innerHTML = '<div class="cx wk" data-tint="work" data-tab="' + esc(S.tab) + '">' + hero() + captureForm() +
      '<div class="wk-controls">' + tabs() + filters() + '</div>' + notices() + body() + '</div>';
    var nextScroller = pane.querySelector('.wk-columns'); if (nextScroller && sx) nextScroller.scrollLeft = sx;
    if (keep) { var el = $(keep); if (el) { el.focus(); if (caret) { try { el.setSelectionRange(caret[0], caret[1]); } catch (_e) {} } } }
  }
  function render() {
    var r = W.parseRoute();
    if (r.pane !== 'work') return;
    if (!r.args.length) return renderList();
    if (r.args[1] === 'start') return renderStart(r.args[0]);
    if (r.args[1] === 'edit') return renderEdit(r.args[0]);
    return renderDetail(r.args[0]);
  }
  function current() { var r = W.parseRoute(); return r.args.length ? itemFor(r.args[0]) : null; }

  // ── events (delegated on the pane) ───────────────────────
  pane.addEventListener('click', function (e) {
    var t = e.target.closest('[data-wk]');
    if (S.moreOpen && !e.target.closest('.wk-more')) { S.moreOpen = false; if (!t) { renderList(); return; } }
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-wk'), id = t.getAttribute('data-id'), it;
    switch (act) {
      case 'refresh': return refreshAll();
      case 'capture-toggle':
        S.captureOpen = !S.captureOpen;
        if (S.captureOpen && !S.captureDomain) S.captureDomain = S.domain || ((S.domains || [])[0] || {}).name || '';
        renderList(); if (S.captureOpen) { var f = $('wk-capture-text'); if (f) f.focus(); }
        return;
      case 'tab':
        S.tab = t.getAttribute('data-tab'); S.moreOpen = false; S.pendingComplete = null; persist();
        if (S.tab === 'sort' && !S.intake && !S.intakeLoading) loadIntake();
        if (S.tab === 'waiting') { S.waiting = null; S.dropped = null; loadWaiting(); }
        if (W.parseRoute().args.length) return W.go('work');
        window.scrollTo(0, 0);
        return renderList();
      case 'more': S.moreOpen = !S.moreOpen; return renderList();
      case 'clear': S.q = ''; S.meaning = null; return renderList();
      case 'open': return W.go('work', [id]);
      case 'back': return W.goBack();
      case 'start': return W.go('work', [id, 'start']);
      case 'edit': return W.go('work', [id, 'edit']);
      case 'meeting': return W.go('meetings', [t.getAttribute('data-domain'), t.getAttribute('data-month'), t.getAttribute('data-file')]);
      case 'session': return W.go('sessions', [t.getAttribute('data-provider'), t.getAttribute('data-sid')]);
      case 'dismiss-note': S.note = ''; return render();
      case 'dismiss-error': S.mutationError = ''; return render();
      case 'show-all-decisions': S.showAllDecisions = !S.showAllDecisions; return renderList();
      case 'hide': case 'restore':
        var a = (S.open || []).filter(function (x) { return x.id === t.getAttribute('data-rid'); })[0];
        if (!a) return;
        if (act === 'hide') S.hidden[a.id] = signature(a); else delete S.hidden[a.id];
        W.writeStore(STORE + '.hidden', S.hidden);
        return renderList();
      case 'mentioned': S.mentionedOpen = !S.mentionedOpen; return renderList();
      case 'mentioned-all': S.mentionedAll = true; return renderList();
      case 'column-all': S.columnAll[t.getAttribute('data-stage')] = true; return renderList();
      case 'search-all': S.domain = ''; S.scope = 'all'; return renderList();
      case 'scope-link':
        S.q = ''; S.domain = ''; S.scope = t.getAttribute('data-scope');
        var matches = items().filter(function (x) { return inView(x, S.scope, ''); });
        if (matches.length === 1) return W.go('work', [matches[0].id]);
        return renderList();
      case 'complete-yes': it = itemFor(id); if (it) moveStage(it, 'complete'); return;
      case 'complete-no': S.pendingComplete = null; return render();
      case 'copy-id': case 'copy-context':
        it = itemFor(id); if (!it || !canExport(it.task)) return;
        W.copyText(act === 'copy-id' ? workId(it.task) : contextText(it.task)).then(function () {
          W.toast(act === 'copy-id' ? 'Copied task ID: ' + workId(it.task) : 'Task context copied. Paste it into a session to resolve and link this task.');
        }, function (err) { W.toast(err.message || 'Could not copy to the clipboard. Try again.'); });
        return;
      case 'copy-session':
        W.copyText(t.getAttribute('data-sid')).then(function () { W.toast('Copied session ID'); }, function (err) { W.toast(err.message); });
        return;
      case 'start-send': it = itemFor(id); if (it) sendStart(it); return;
      case 'reply-open': case 'reply-cancel':
        it = itemFor(id); if (it && S.reply[it.wid]) { S.reply[it.wid].open = act === 'reply-open'; renderDetail(it.id); } return;
      case 'reply-send': it = itemFor(id); if (it) sendReply(it, t.getAttribute('data-intent')); return;
      case 'edit-save': it = current(); if (it) editSave(it); return;
      case 'edit-cancel':
        it = current(); if (!it) return W.goBack();
        if (editState(it).dirty) { editState(it).confirming = true; return renderEdit(it.id); }
        delete S.edit[it.wid]; return W.goBack();
      case 'edit-discard': it = current(); if (it) delete S.edit[it.wid]; return W.goBack();
      case 'edit-keep': it = current(); if (it) { editState(it).confirming = false; renderEdit(it.id); } return;
      case 'edit-refresh': loadBoard(); return;
      case 'task-patch': it = current(); if (it) taskPatch(it, t.getAttribute('data-patch'), t.getAttribute('data-stage')); return;
      case 'intake-refresh': return loadIntake();
      case 'resolve': return resolveIntake(t.getAttribute('data-iid'), t.getAttribute('data-action-kind'));
      case 'dismiss-rest':
        var g = sortGroups()[S.sortIndex]; if (g) dismissRest(g.items.map(function (x) { return x.id; }));
        return;
      case 'undo': return undoIntake();
      case 'sort-prev': S.sortIndex = Math.max(0, S.sortIndex - 1); return renderList();
      case 'sort-later': var n = sortGroups().length; S.sortIndex = n ? (S.sortIndex + 1) % n : 0; return renderList();
      case 'card-keep': case 'card-drop':
        var task = (S.tasks || []).filter(function (x) { return identity(x) === id; })[0];
        if (task) batchOp(task, act === 'card-keep' ? 'stage' : 'drop', act === 'card-keep' ? { workStage: 'planned' } : null);
        return;
      case 'waiting-refresh': return loadWaiting();
      case 'waiting-mode': S.waitingDropped = t.getAttribute('data-mode') === 'dropped'; renderList(); return loadWaiting();
      case 'batch':
        var list = (S.waitingDropped ? S.dropped : S.waiting) || [];
        var row = list.filter(function (x) { return x.id === id && x.domain === t.getAttribute('data-domain'); })[0];
        if (!row) return;
        var op = t.getAttribute('data-op');
        if (op === 'done') return batchOp(row, 'stage', { workStage: 'complete' });
        if (op === 'checkIn') {
          var input = pane.querySelector('[data-wk-checkin="' + CSS.escape(id) + '"]');
          var next = input && input.value ? input.value : localDay(new Date(Date.now() + 7 * 86400000));
          return batchOp(row, 'checkIn', { checkIn: next });
        }
        return batchOp(row, op);
    }
  });
  pane.addEventListener('change', function (e) {
    var el = e.target, it;
    if (el.hasAttribute('data-wk-select')) {
      var name = el.getAttribute('data-wk-select');
      if (name === 'domain') S.domain = el.value;
      else if (name === 'scope') S.scope = el.value;
      else if (name === 'order') { S.orders[orderKey()] = el.value; persist(); }
      S.pendingComplete = null;
      return renderList();
    }
    if (el.hasAttribute('data-wk-stage')) { it = itemFor(el.getAttribute('data-wk-stage')); if (it) moveStage(it, el.value); return; }
    if (el.id === 'wk-capture-domain') { S.captureDomain = el.value; return renderList(); }
    if (el.name === 'wk-mode' || el.hasAttribute('data-wk-start')) {
      it = current(); if (!it) return;
      var st = startState(it);
      if (el.name === 'wk-mode') {
        st.mode = el.value; st.fromSaved = false;
        var rows = contributors(it).filter(function (a) { var s = splitSession(a.sessionId); return s && (st.mode !== 'fork' || FORKABLE[s.provider]); });
        if (st.mode !== 'newSession' && !rows.some(function (a) { return a.sessionId === st.sessionId; })) st.sessionId = rows.length ? rows[0].sessionId : '';
      } else if (el.getAttribute('data-wk-start') === 'session') { st.sessionId = el.value; st.fromSaved = false; }
      else if (el.getAttribute('data-wk-start') === 'model') { st.model = el.value; st.fromSaved = false; }
      return renderStart(it.id);
    }
    if (el.hasAttribute('data-wk-edit')) { it = current(); if (it) { var ed = editState(it); ed[el.getAttribute('data-wk-edit')] = el.value; renderEdit(it.id); } }
  });
  var typing = null;
  pane.addEventListener('input', function (e) {
    var el = e.target, it;
    if (el.id === 'wk-q') {
      S.q = el.value;
      clearTimeout(typing); typing = setTimeout(renderList, 180);
      return;
    }
    if (el.id === 'wk-capture-text') {
      S.captureText = el.value;
      var b = pane.querySelector('.wk-capture [type="submit"]');
      if (b) b.disabled = !(S.captureText.trim() && domainNames().indexOf(S.captureDomain) >= 0 && !S.captureBusy);
      return;
    }
    if (el.hasAttribute('data-wk-reply')) {
      it = itemFor(el.getAttribute('data-wk-reply')); var rr = it && S.reply[it.wid]; if (!rr) return;
      rr.text = el.value;
      var rs = pane.querySelector('[data-wk="reply-send"]'); if (rs) rs.disabled = !rr.text.trim() || rr.text.trim().length > 2000 || rr.sending;
      return;
    }
    if (el.getAttribute('data-wk-start') === 'note') {
      it = current(); if (!it) return;
      var st = startState(it); st.note = el.value;
      var send = pane.querySelector('[data-wk="start-send"]'); if (send) send.disabled = !!startProblem(it, st) || st.sending || !!blockingHandoff(it);
      return;
    }
    if (el.hasAttribute('data-wk-edit') && el.getAttribute('data-wk-edit') !== 'runAt') {
      it = current(); if (!it) return;
      var ed = editState(it); ed[el.getAttribute('data-wk-edit')] = el.value;
      ed.dirty = ed.text !== titleOf(it.task) || ed.doneWhen !== str(it.task.doneWhen);
      var save = pane.querySelector('[data-wk="edit-save"]');
      if (save) save.disabled = !(!ed.busy && !editUnavailable(it.task) && !editValidation(ed) && ed.dirty);
    }
  });
  pane.addEventListener('submit', function (e) {
    var f = e.target.getAttribute('data-wk-form');
    if (!f) return;
    e.preventDefault();
    if (f === 'capture') return capture();
    if (f === 'search') { clearTimeout(typing); S.q = ($('wk-q') || {}).value || ''; renderList(); if (S.tab === 'board') searchMeaning(); }
  });
  // Sort's keys (j, k, s, e), as in Control, while Sort is showing and nothing is being typed.
  document.addEventListener('keydown', function (e) {
    var r = W.parseRoute();
    if (r.pane !== 'work' || r.args.length || S.tab !== 'sort' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    var groups = sortGroups(), n = groups.length;
    if (e.key === 'j') S.sortIndex = Math.min(Math.max(0, n - 1), S.sortIndex + 1);
    else if (e.key === 'k') S.sortIndex = Math.max(0, S.sortIndex - 1);
    else if (e.key === 's') S.sortIndex = n ? (S.sortIndex + 1) % n : 0;
    else if (e.key === 'e') {
      var g = groups[S.sortIndex]; if (!g) return;
      if (g.cards.length) batchOp(g.cards[0], 'stage', { workStage: 'planned' });
      else if (g.items.length) resolveIntake(g.items[0].id, 'accept');
      return;
    } else return;
    e.preventDefault(); renderList();
  });

  W.registerPane('work', {
    load: function (args) {
      startPoll();
      if (!S.tasks && !S.loading) loadBoard();
      else if (!args.length && Date.now() - S.loadedAt > 60000 && !S.loading) loadBoard();
      render();
    },
    leave: function () { stopPoll(); },
    // Back unwinds one step: Start work and Edit go to the card, the card to the list.
    up: function (args) { return args.length >= 2 ? [args[0]] : null; }
  });
})();
