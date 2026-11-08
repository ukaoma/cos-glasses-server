/* COS Control Web: Memories, built to Control's Memories page (the bundle ActivityWindow.swift MemoriesWebView hosts,
   server/web-control/memories/memories-app.js 0.5.191 to 0.5.362): Recent learning, Applied this week, All memories,
   To review and Knowledge, the lesson reader with Open sources, Explore in graph and Copy context, the counts line,
   the activity log and Memory settings. Native here, so it fills the phone and follows the app's theme; the old
   hosted page (memories/memories.html) is no longer on this path.
   Data: POST /api/web-bridge/memories {id, op, args} answers {ok, message, details} (lib/web-memories-bridge.ts).
   Reads: status, workspace.request (learning_page, review_page, memory_page, get_memory, policy_get, rule_page,
   source_status, trace_summary, identity_status, status, graph_overview, graph_expand), learning.list, learning.review,
   learning.event, memories.list, memories.search, memory.detail, cues.summary, graph.status, graph.search,
   graph.entity, graph.passages, graph.setup, graph.progress, graph.ask, graph.duplicates, graph.merge.preview,
   graph.merge.status, profile.owner, memory.guardrails.
   Writes (each only from a tap, never on load): memory.review, learning.decide, workspace.request (review_memory,
   policy_set, propose_rule, review_rule, activate_rule, rollback_rule, refresh_source, identity_keep_apart and the
   graph workspace's own saves), profile.owner.set, memory.guardrails.set, memory.guardrails.run, graph.ingest,
   graph.build, graph.merge, graph.setup.sources, graph.setup.owner, graph.setup.extraction, graph.setup.embedding,
   graph.sample, graph.schedule.
   Routes: #/memories, #/memories/e/<eventId>, #/memories/m/<memoryId>, #/memories/k/<graph|sources|setup>,
   #/memories/view/<recent|applied|memories|review|knowledge>. */
(function () {
  'use strict';
  var W = window.COSWeb;
  var esc = W.esc;
  var pane = W.$('pane-memories');
  if (!pane) return;

  // ── vocabulary (plain words for the store and event names Control's page shows) ──
  var KIND = { captured: 'Captured', proposed: 'Proposed', promotable: 'Suggested rule', saved: 'Saved', retrieved: 'Recalled',
    used: 'Used in an answer', included: 'Included in context', applied: 'Use recorded', checked: 'Checked', dismissed: 'Dismissed',
    reverted: 'Reverted', reopened: 'Reopened', consolidated: 'Merged with another', previewed: 'Previewed', accepted: 'Accepted', pruned: 'Quarantined' };
  var STORE = { self_improvement_queue: 'Improvement suggestions', correction_journal: 'Your corrections', bot_memory: 'Saved memory',
    review_ledger: 'Your review decisions', git_versions: 'Skill versions', eval_scores: 'Run checks', reflect_log: 'Daily reflection',
    capture_ledger: 'Capture record', memory_trace: 'Recall record', retrieval_log: 'Recall record', used: 'Use record',
    memory: 'Saved memory', occurrence: 'When it happened', assistant_turn: 'An answer' };
  var GATE = { attribution: 'Who said it is unclear', low_confidence: 'Low confidence', prune_ready: 'Ready to quarantine', contradiction: 'Contradicts another memory' };
  var VIEWS = [['recent', 'Recent learning'], ['applied', 'Applied this week'], ['memories', 'All memories'], ['review', 'To review'], ['knowledge', 'Knowledge']];
  // Control's cue review (MeetingAsk.swift CueReviewPane): shown beside the views once the server's cue history answers.
  var CUE_VIEWS = [['cues', 'Cues to rate'], ['rated', 'Rated cues']];
  function knownView(v) { return VIEWS.concat(CUE_VIEWS).some(function (x) { return x[0] === v; }); }
  var KTABS = ['graph', 'sources', 'setup'];
  var PRUNE_READY = 'Prune ready';
  // The bridge's read-only ops (READ_ONLY_MEMORY_WEB_OPS and WORKSPACE_READ_ACTIONS in lib/web-memories-bridge.ts).
  var READ_OPS = {}; ('status learning.list learning.review learning.event learning.status memories.list memories.search memory.detail graph.status ' +
    'profile.owner graph.search graph.entity graph.passages graph.setup graph.ask graph.progress memory.guardrails graph.merge.preview ' +
    'graph.merge.status graph.duplicates cues.summary').split(' ').forEach(function (k) { READ_OPS[k] = 1; });
  var WS_READ = {}; ('status graph_overview graph_expand graph_paths graph_resolve list_explorations get_exploration policy_get memory_page ' +
    'learning_page review_page get_memory trace_summary source_status current_sources identity_split_preview identity_status rule_page ' +
    'rule_evaluation').split(' ').forEach(function (k) { WS_READ[k] = 1; });
  // Reads give up a little after the bridge's own limit, so a sleeping Mac never leaves a view loading forever.
  // Writes wait for the answer (W.api's rule): a slow save is never reported as failed while it may still land.
  var READ_LIMIT = { 'graph.ask': 175000, 'graph.duplicates': 50000, 'graph.merge.preview': 40000 };
  // Server codes in plain words. The code itself stays on err.code for the retry rules below.
  var PLAIN = {
    learning_unavailable: 'This record could not be read on your Mac right now. Try again in a moment.',
    revision_conflict: 'This changed since you opened it. It has been reloaded; check it and choose again.',
    idempotency_conflict: 'That request was already used. Reload and choose again.',
    memory_not_found: 'That memory is no longer on your Mac.',
    not_memory_authority: 'Only the Mac that owns your memory can change this.',
    owner_review_required: 'This needs your review first.',
    index_missing: 'There is no knowledge index on this Mac yet.'
  };

  // ── small helpers ────────────────────────────────────────
  function fmt(n) { return Number(n || 0).toLocaleString(); }
  function plural(n, one, many) { return Number(n) === 1 ? one : many; }
  function str(v) { return typeof v === 'string' ? v : ''; }
  function clip(text, n) { var s = String(text || ''); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; }
  function toDate(v) { if (v == null || v === '') return null; var d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  function when(v) {
    var d = toDate(v); if (!d) return v ? String(v) : '';
    var o = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
    return d.toLocaleString(undefined, o);
  }
  function day(v) {
    var d = toDate(v); if (!d) return v ? String(v).slice(0, 10) : '';
    var o = { month: 'short', day: 'numeric' }; if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
    return d.toLocaleDateString(undefined, o);
  }
  // Server titles end with the trace source ("Included in context 39 times · context_emitted"); people read the first part.
  function cleanTitle(t) { return String(t || '').replace(/\s+·\s+[a-z]+(?:_[a-z]+)+\s*$/, '').trim(); }
  function known(v) { return v && v !== 'unknown' ? v : ''; }
  function storeName(k) { return STORE[k] || (k ? String(k).replace(/_/g, ' ') : ''); }
  // A UUID v4 from getRandomValues: crypto.randomUUID needs a secure context, and a tailnet page over http is not one.
  function uuid() {
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function icon(name) { return '<svg class="icon"><use href="#i-' + name + '"/></svg>'; }
  // The tab is in the address: #/memories/t/<view> (app.js isTabRoute), so a reload, a new browser or Safari clearing its
  // storage all land on the same tab; the stored view is only the fallback for a bare #/memories.
  function tabRoute(args) { return args.length === 2 && args[0] === 't'; }
  function readerArgs(r) { return r.pane === 'memories' && !tabRoute(r.args) ? r.args : []; }
  function showTab(v) {
    var h = '#/memories/t/' + encodeURIComponent(v);
    if (location.hash === h) paint(); else location.replace(h);
  }
  function isWide() { return !!(window.matchMedia && window.matchMedia('(min-width: 760px)').matches); }
  function el(id) { return document.getElementById(id); }
  function btn(act, label, extra) { return '<button type="button" class="cx-btn' + (extra && extra.cls ? ' ' + extra.cls : ' quiet') + '" data-mm="' + act + '"' + (extra && extra.id != null ? ' data-id="' + esc(extra.id) + '"' : '') + (extra && extra.arg != null ? ' data-arg="' + esc(extra.arg) + '"' : '') + (extra && extra.disabled ? ' disabled' : '') + '>' + label + '</button>'; }
  function textBtn(act, label, extra) { return '<button type="button" class="mm-link" data-mm="' + act + '"' + (extra && extra.id != null ? ' data-id="' + esc(extra.id) + '"' : '') + (extra && extra.arg != null ? ' data-arg="' + esc(extra.arg) + '"' : '') + (extra && extra.disabled ? ' disabled' : '') + '>' + label + '</button>'; }

  // ── the bridge ───────────────────────────────────────────
  var seq = 0;
  function isRead(op, args) { return !!READ_OPS[op] || (op === 'workspace.request' && !!WS_READ[str(args && args.action)]); }
  function call(op, args) {
    var a = args || {};
    // Copy stays in this browser: the same copy the rest of Control Web uses (plain-http fallback included).
    if (op === 'copy') return W.copyText(String(a.text || '')).then(function () { return {}; });
    var limit = READ_LIMIT[op] != null ? READ_LIMIT[op] : (isRead(op, a) ? 45000 : 0);
    return W.api('/api/web-bridge/memories', { method: 'POST', body: { id: ++seq, op: op, args: a }, timeoutMs: limit }).then(function (r) {
      if (r && r.ok) return r.details || {};
      var raw = (r && r.message) || 'Your Mac did not answer that.';
      var err = new Error(PLAIN[raw] || raw); err.code = raw; throw err;
    });
  }
  // A request that never reached COS is said in plain words by W.api itself (app.js, 6.99.30: code 'unreachable'),
  // as a timeout is: nothing to translate here.
  function codeOf(e) { return String((e && (e.code || e.message)) || ''); }

  // ── state ────────────────────────────────────────────────
  var STORE_KEY = 'cos.web.memories';
  var saved = W.readStore(STORE_KEY);
  function list() { return { rows: [], total: null, cursor: null, loaded: false, loading: false, error: '', paged: undefined, coverage: {}, info: null }; }
  var S = {
    view: knownView(saved.view) ? saved.view : 'recent',
    ktab: KTABS.indexOf(saved.ktab) >= 0 ? saved.ktab : 'graph', ktabChosen: false,
    started: false, loadedAt: 0,
    status: null, statusError: '', statusLoading: false,
    recent: list(), review: list(), applied: Object.assign(list(), { days: 7 }), mem: Object.assign(list(), { q: '', hits: null, hitCursor: null }),
    graph: null, graphError: '', setup: null, setupError: '', setupLoading: false, setupBusy: '', progress: null,
    ingest: null, ingestLimit: 10, building: '', folderDraft: '',
    detail: {}, memDetail: {}, passages: {}, loading: {},
    decisions: {}, decisionTs: {}, decided: {},
    armed: '', reviewBusy: '', reviewIntent: null, bulk: null,
    ask: { q: '', busy: false, answer: null, error: '', cards: [], cardsBusy: false, startedAt: 0, message: '', pending: null },
    focus: null, focusChosen: false, focusResolved: false, knowledgeFocus: null, neighbors: [], graphVisible: null,
    graphFull: false, kit: null, kitError: '', ws: null, graphMemories: {},
    dups: { busy: false, data: null, error: '' }, merge: null,
    modal: null, copyId: null, copyOpts: { sources: true, graph: false }, drafts: {},
    owner: null, ownerError: '', ownerBusy: false,
    policy: null, policyError: '', policyBusy: false, policyIntent: null, policyLoading: false,
    guard: null, guardError: '', guardBusy: '', guardRun: null, guardLines: 0, guardLoading: false,
    steward: { tab: 'rules', rows: [], cursor: null, busy: false, error: '', intent: null, outcomes: null, serial: 0 }
  };
  function persist() { W.writeStore(STORE_KEY, { view: S.view, ktab: S.ktab }); }
  var serials = {};
  function nextSerial(k) { serials[k] = (serials[k] || 0) + 1; return serials[k]; }

  // ── loading ──────────────────────────────────────────────
  function loadAll() {
    S.started = true; S.loadedAt = Date.now();
    loadStatus(); loadRecent(false); loadReview(false); loadCues(); loadGraph();
    if (S.view === 'memories') loadMem(false);
    if (S.view === 'applied') loadApplied(false);
    paint();
  }
  function loadStatus() {
    if (S.statusLoading) return;
    S.statusLoading = true;
    // A decision made here stays out of the needs-you count until Refresh: the status read right after a write can still
    // list it while the server's needs-you reader catches up.
    call('status').then(function (d) { S.status = d; S.statusError = ''; chooseDefaultFocus(); },
      function (e) { S.statusError = e.message; })
      .then(function () { S.statusLoading = false; paint(); });
  }
  // Cues to rate and Rated cues read the server's cue history themselves, as Control's store does: the read is the
  // capability check (a 404 is a server from before the routes, and both entries hide).
  function loadCues() { loadCueWeek(); }
  // Newest first, then by event id: many recall rows share one timestamp, and the server's order among them can differ from
  // one read to the next, which reshuffled Recent learning on every visit.
  function stableOrder(rows) {
    return rows.map(function (r, i) { return { r: r, t: toDate(r && r.ts), i: i }; }).sort(function (a, b) {
      var ta = a.t ? a.t.getTime() : -Infinity, tb = b.t ? b.t.getTime() : -Infinity;
      if (ta !== tb) return tb - ta;
      var ia = str(a.r && a.r.event_id), ib = str(b.r && b.r.event_id);
      return ia < ib ? -1 : ia > ib ? 1 : a.i - b.i;
    }).map(function (x) { return x.r; });
  }
  // Recent learning: the snapshot pages (protocol 1), else the older 90-day list.
  function loadRecent(more) {
    var L = S.recent;
    if (more && (L.loading || !L.cursor)) return;
    var serial = nextSerial('recent'); L.loading = true; if (!more) L.error = '';
    paint();
    var paged = L.paged === false ? Promise.reject(new Error('older server')) :
      call('workspace.request', { action: 'learning_page', days: 90, limit: 50, cursor: more ? L.cursor : null }).then(function (d) {
        if (d.protocol !== 1 || !Array.isArray(d.items)) throw new Error('older server');
        L.paged = true;
        return { rows: d.items, total: d.matched_total, cursor: d.next_cursor || null, coverage: d.coverage || {}, info: d };
      });
    paged.catch(function (err) {
      if (more && L.paged) throw new Error(err.message + ' Refresh to start a new snapshot.');
      L.paged = false;
      var args = { days: 90, limit: 50 };
      if (more && L.cursor) { args.sinceTs = L.cursor.since_ts; args.sinceEventId = L.cursor.since_event_id; }
      return call('learning.list', args).then(function (d) {
        return { rows: d.events || [], total: d.total, cursor: d.nextCursor || null, coverage: d.coverage || {},
          info: { counts_by_type: {}, stores: {}, complete: false, notice: 'Activity totals need a newer server. The list covers 90 days.' } };
      });
    }).then(function (r) {
      if (serial !== serials.recent) return;
      L.rows = stableOrder(more ? L.rows.concat(r.rows) : r.rows); L.total = r.total != null ? r.total : L.total; L.cursor = r.cursor; L.coverage = r.coverage; L.info = r.info;
      L.loaded = true; L.error = '';
      seedDecisions(r.rows); prefetchLessons(r.rows);
    }, function (e) {
      if (serial !== serials.recent) return;
      if (more) W.toast(e.message); else { L.error = e.message; L.loaded = true; }
    }).then(function () { if (serial === serials.recent) L.loading = false; paint(); });
  }
  function loadReview(more) {
    var L = S.review;
    if (more && (L.loading || !L.cursor)) return;
    var serial = nextSerial('review'); L.loading = true; if (!more) L.error = '';
    paint();
    call('workspace.request', { action: 'review_page', limit: 25, cursor: more ? L.cursor : null }).then(function (d) {
      if (d.protocol !== 1 || !Array.isArray(d.items)) throw new Error('older server');
      return { rows: d.items, total: d.matched_total, cursor: d.next_cursor || null };
    }).catch(function (err) {
      if (more) throw err;
      return call('learning.review', { limit: 200 }).then(function (d) {
        return { rows: d.events || [], total: d.reviewCount != null ? d.reviewCount : d.total, cursor: null };
      });
    }).then(function (r) {
      if (serial !== serials.review) return;
      L.rows = more ? L.rows.concat(r.rows) : r.rows; L.total = r.total; L.cursor = r.cursor; L.loaded = true; L.error = '';
      seedDecisions(r.rows);
    }, function (e) {
      if (serial !== serials.review) return;
      if (more) W.toast(e.message + ' Refresh To review to start again.'); else { L.error = e.message; L.loaded = true; }
    }).then(function () { if (serial === serials.review) L.loading = false; paint(); });
  }
  var memTimer = null;
  function loadMem(more) {
    var L = S.mem, q = L.q.trim();
    var cursor = more ? (q ? L.hitCursor : L.cursor) : null;
    if (more && (L.loading || !cursor)) return;
    var serial = nextSerial('mem'); L.loading = true; if (!more) L.error = '';
    paint();
    var paged = L.paged === false ? Promise.reject(new Error('older server')) :
      call('workspace.request', { action: 'memory_page', q: q, limit: 25, cursor: cursor }).then(function (d) {
        if (d.protocol !== 1 || !Array.isArray(d.items)) throw new Error('older server');
        L.paged = true; return { rows: d.items, total: d.matched_total, cursor: d.next_cursor || null };
      });
    paged.catch(function (err) {
      if (more) throw new Error(err.message + ' Search again to refresh.');
      L.paged = false;
      return call(q ? 'memories.search' : 'memories.list', q ? { q: q, limit: 20 } : { limit: 50 }).then(function (d) {
        return q ? { rows: d.hits || [], total: null, cursor: null } : { rows: d.memories || [], total: d.total, cursor: null };
      });
    }).then(function (r) {
      if (serial !== serials.mem || L.q.trim() !== q) return;
      if (q) { L.hits = more ? (L.hits || []).concat(r.rows) : r.rows; L.hitCursor = r.cursor; }
      else { L.hits = null; L.rows = more ? L.rows.concat(r.rows) : r.rows; L.total = r.total; L.cursor = r.cursor; }
      L.loaded = true; L.error = '';
    }, function (e) {
      if (serial !== serials.mem) return;
      if (more) W.toast(e.message); else { L.error = e.message; L.loaded = true; }
    }).then(function () { if (serial === serials.mem) L.loading = false; paint(); });
  }
  function memQuery(q) {
    S.mem.q = q; clearTimeout(memTimer);
    if (q.trim().length === 1) return;
    memTimer = setTimeout(function () { loadMem(false); }, q ? 350 : 0);
  }
  // Applied: the helper's `--kind used` window, never Recent filtered here. Fails closed: a server that ignored
  // `kind` returns the whole window, and Applied stays empty rather than call those rows uses.
  function loadApplied(more) {
    var L = S.applied;
    if (more && (L.loading || !L.cursor)) return;
    var serial = nextSerial('applied'); L.loading = true; if (!more) L.error = '';
    paint();
    var args = { kind: 'used', days: L.days, limit: 50 };
    if (more) { args.sinceTs = L.cursor.since_ts; args.sinceEventId = L.cursor.since_event_id; }
    call('learning.list', args).then(function (d) {
      if (serial !== serials.applied) return;
      var events = d.events || [];
      if (events.some(function (e) { return e.event_type !== 'used'; })) {
        L.rows = []; L.total = null; L.cursor = null; L.loaded = true;
        L.error = 'This server sent learning rows that are not uses. Applied stays empty rather than mislabel them.';
        return;
      }
      var seen = {}; (more ? L.rows : []).forEach(function (e) { seen[e.event_id] = 1; });
      var rows = events.filter(function (e) { if (seen[e.event_id]) return false; seen[e.event_id] = 1; return true; });
      L.rows = stableOrder(more ? L.rows.concat(rows) : rows); L.total = d.total; L.cursor = d.nextCursor || null; L.coverage = d.coverage || {};
      L.loaded = true; L.error = '';
      L.rows.forEach(function (e) { if (e.lesson_id) ensureMem(e.lesson_id); });
    }, function (e) { if (serial !== serials.applied) return; L.error = e.message; L.loaded = true; })
      .then(function () { if (serial === serials.applied) L.loading = false; paint(); });
  }
  function setAppliedDays(days) {
    S.applied = Object.assign(list(), { days: days === 90 ? 90 : 7 });
    loadApplied(false);
  }
  function loadGraph() {
    return call('graph.status').then(function (d) {
      S.graph = d; S.graphError = '';
      var lk = d.lock || {};
      if (lk.state === 'exclusive' || lk.state === 'shared') watchIngest();
      if (d.entities == null && !S.ktabChosen) S.ktab = 'setup';
    }, function (e) { S.graphError = e.message; }).then(paint);
  }
  // A bot-memory row is read from the memory store (memory.detail): the learning index cannot look those events up
  // by id ("learning_unavailable" after 8 s on 11/06). Governed rows read the workspace record; the rest, learning.event.
  function ensureDetail(row) {
    var id = row && row.event_id;
    if (!id || S.detail[id] || S.loading[id]) return;
    if (row.store === 'bot_memory' && row.lesson_id) { ensureMem(row.lesson_id); return; }
    S.loading[id] = true;
    var p = row.governance ? call('workspace.request', { action: 'get_memory', id: row.lesson_id }).then(function (d) {
      var item = d.item || {};
      return { detail: { content: item.payload && item.payload.content }, governance: item.state, journal_revision: item.revision };
    }) : call('learning.event', { id: id });
    p.then(function (d) { S.detail[id] = d; }, function (e) { S.detail[id] = { _error: e.message }; })
      .then(function () { delete S.loading[id]; paint(); });
  }
  function ensureMem(id) {
    if (!id || S.memDetail[id] || S.loading['m:' + id]) return;
    S.loading['m:' + id] = true;
    call('memory.detail', { id: id }).then(function (d) { S.memDetail[id] = d; }, function (e) { S.memDetail[id] = { _error: e.message }; })
      .then(function () { delete S.loading['m:' + id]; paint(); });
  }
  // Recall rows are titled by what happened ("Included in context 39 times"). The row says which memory it was once its
  // record is read: the first page only, three at a time, each record once.
  var prefetchQueue = [], prefetchRunning = 0;
  function prefetchLessons(rows) {
    (rows || []).slice(0, 25).forEach(function (e) {
      if (e && /^mem_/.test(str(e.lesson_id)) && isUseType(e) && !S.memDetail[e.lesson_id] && prefetchQueue.indexOf(e.lesson_id) < 0) prefetchQueue.push(e.lesson_id);
    });
    pump();
  }
  function pump() {
    while (prefetchRunning < 3 && prefetchQueue.length) {
      var id = prefetchQueue.shift();
      if (S.memDetail[id] || S.loading['m:' + id]) continue;
      prefetchRunning++; S.loading['m:' + id] = true;
      (function (mid) {
        call('memory.detail', { id: mid }).then(function (d) { S.memDetail[mid] = d; }, function (e) { S.memDetail[mid] = { _error: e.message }; })
          .then(function () { delete S.loading['m:' + mid]; prefetchRunning--; paintSoon(); pump(); });
      })(id);
    }
  }
  // A review decision survives a reload: the ledger's pruned/accepted rows seed the map the actions read, newest wins,
  // and one made in this session is stamped now so a stale seed never undoes it.
  function seedDecisions(rows) {
    (rows || []).forEach(function (e) {
      if (!e || e.store !== 'review_ledger' || !e.lesson_id || (e.event_type !== 'pruned' && e.event_type !== 'accepted')) return;
      var ts = String(e.ts || '');
      if (S.decisionTs[e.lesson_id] && S.decisionTs[e.lesson_id] >= ts) return;
      S.decisionTs[e.lesson_id] = ts; S.decisions[e.lesson_id] = e.event_type;
    });
  }
  // The graph opens on the person this COS is about (the owner name, resolved through a search so the entity's exact
  // spelling wins). A focus the person picks is never overridden.
  function chooseDefaultFocus() {
    var name = S.status && S.status.ownerName;
    if (!name || S.focusChosen || S.focusResolved) return;
    S.focusResolved = true;
    call('graph.search', { q: name, limit: 5 }).then(function (d) {
      var items = d.items || [];
      var pick = items.filter(function (it) { return String(it.id).toLowerCase() === String(name).toLowerCase(); })[0] ||
        items.filter(function (it) { return String(it.type || '').toLowerCase() === 'person'; })[0] || items[0];
      if (pick && !S.focusChosen) { S.focus = pick.id; if (S.ws && el('mm-graph-host')) S.ws.attach(el('mm-graph-host'), S.focus); }
    }, function () {});
  }

  // ── what a row is ────────────────────────────────────────
  function isProposal(e) { return !!(e && e.target && e.target.kind === 'task-proposal'); }
  function isPattern(e) { return !!(e && (e.event_type === 'promotable' || (e.target && e.target.kind === 'pattern'))); }
  function isPruneReady(e) { return !!e && e.store === 'bot_memory' && typeof e.category === 'string' && e.category.indexOf(PRUNE_READY) === 0; }
  function pruneReason(e) { var c = String(e.category || ''); return c.indexOf(' · ') > 0 ? c.slice(c.indexOf(' · ') + 3) : ''; }
  function decisionFor(e) { return e && S.decisions[e.lesson_id]; }
  function isUseType(e) { return !!e && ['used', 'checked', 'retrieved', 'included', 'applied'].indexOf(e.event_type) >= 0; }
  function isMemoryLesson(e) { return !!e && !!e.lesson_id && (/^mem_/.test(e.lesson_id) || (e.target && e.target.kind === 'memory')); }
  function kindLabel(e) {
    if (e && e.store === 'bot_memory' && e.event_type === 'captured' && decisionFor(e) === 'pruned') return 'Quarantined';
    if (isPruneReady(e) && !decisionFor(e)) return 'Ready to quarantine';
    if (isProposal(e)) return 'Suggested change';
    if (isPattern(e)) return 'Suggested rule';
    return KIND[e && e.event_type] || 'Event';
  }
  function outcomeText(e) { var o = e && e.outcome; if (!o) return null; if (typeof o === 'string') return o; return o.result ? o.result + (o.name ? ' · ' + o.name : '') : null; }
  function rowStatus(e) {
    var o = outcomeText(e);
    if (o) { var r = typeof e.outcome === 'object' ? e.outcome.result : e.outcome; return { text: 'Checked: ' + o, tone: /^(pass|passed|success)$/.test(r) ? 'ok' : /^(fail|failed)$/.test(r) ? 'bad' : '' }; }
    if (e.needs) return { text: (GATE[e.needs.gate] || 'Needs you') + (e.needs.reason ? '. ' + e.needs.reason : ''), tone: 'warn' };
    if (isProposal(e) || isPattern(e)) return { text: decisionFor(e) === 'dismissed' ? 'Dismissed' : 'Needs your review', tone: decisionFor(e) === 'dismissed' ? '' : 'warn' };
    if (e.event_type === 'dismissed') return { text: 'Dismissed', tone: '' };
    if (e.event_type === 'retrieved') return { text: 'Recalled. Not yet shown to be used.', tone: '' };
    if (e.event_type === 'included') return { text: 'Included in context. Not yet shown to be used.', tone: '' };
    if (e.event_type === 'applied' || e.event_type === 'used') return { text: 'Use recorded', tone: 'ok' };
    if (isPruneReady(e) && !decisionFor(e)) return { text: pruneReason(e) || 'Ready to quarantine', tone: 'warn' };
    return { text: 'Saved. No later use yet.', tone: '' };
  }
  function memText(id) { var m = id && S.memDetail[id]; return m && !m._error ? str(m.summary) || str(m.content) : ''; }
  function memError(id) { var m = id && S.memDetail[id]; return m && m._error ? String(m._error) : ''; }
  // What a row is titled: a recall row names its memory once that record is read.
  function rowTitle(e) {
    var t = cleanTitle(e.title);
    if (isUseType(e) && isMemoryLesson(e)) { var m = memText(e.lesson_id); if (m) return m; }
    return t || '(untitled)';
  }
  function rowWhat(e) { return isUseType(e) && isMemoryLesson(e) && memText(e.lesson_id) ? cleanTitle(e.title) : ''; }

  // ── To review: what needs you, then every proposed change ──
  // The count is Control's gated needs-you list (status.needs_you, capped), never the review page's total. The page
  // lists those items first so the number on the tab is a list you can see, then every proposed change after them.
  // The gate's reason in plain words where its shape is known; otherwise as the server wrote it.
  function plainReason(r) {
    var t = String(r || ''), m;
    if ((m = /^promotable at confidence ([\d.]+) \(< ([\d.]+)\)$/.exec(t))) return 'Confidence ' + m[1] + ', under the ' + m[2] + ' bar for a rule';
    if ((m = /^names (.+?) near '(.+?)' with no attribution field$/.exec(t))) return 'Mentions ' + m[1].replace(/\b\w/g, function (c) { return c.toUpperCase(); }) + ' near "' + m[2] + '" without saying who said it';
    return t;
  }
  function needsItems() {
    var ny = (S.recent.info && S.recent.info.needs_you) || (S.status && S.status.needs_you) || null;
    return ny && Array.isArray(ny.items) ? ny.items : [];
  }
  function needsRows() {
    // A row decided here stays listed (its reader offers Restore); only the count leaves it out.
    return needsItems().map(function (it) {
      var fromList = S.review.rows.filter(function (r) { return r.event_id === it.event_id; })[0] ||
        S.recent.rows.filter(function (r) { return r.event_id === it.event_id; })[0];
      var mem = /^mem_/.test(str(it.lesson_id));
      var base = fromList || { event_id: it.event_id, lesson_id: it.lesson_id, ts: it.ts, title: it.title, category: it.category,
        store: it.store || (mem ? 'bot_memory' : null), event_type: mem ? 'captured' : 'promotable', scope: 'unknown', engine: 'unknown',
        target: { kind: mem ? 'memory' : 'pattern', id: it.lesson_id }, source_refs: [], applies_to: [] };
      return Object.assign({}, base, { needs: { gate: it.gate, reason: plainReason(it.reason) } });
    });
  }
  function needsCount() {
    var s = S.status || {}, ny = (S.recent.info && S.recent.info.needs_you) || s.needs_you;
    if (ny && Array.isArray(ny.items)) return ny.items.filter(function (it) { return !S.decided[it.lesson_id]; }).length;
    if (ny && ny.count != null) return ny.limit != null ? Math.min(Number(ny.count), Number(ny.limit)) : Number(ny.count);
    if (typeof s.learningToReview === 'number') return s.learningToReview;
    return null;
  }
  function findRow(id) {
    var all = needsRows().concat(S.review.rows, S.recent.rows, S.applied.rows);
    for (var i = 0; i < all.length; i++) if (all[i].event_id === id) return all[i];
    var d = S.detail[id];
    return d && !d._error && d.event_id ? d : null;
  }
  function fullRow(e) { var d = S.detail[e.event_id]; return Object.assign({}, e, d && !d._error ? d : {}); }
  function rewardOn() { return !!(S.status && S.status.learningRewardEnabled === true); }
  function rankingSentence() { return rewardOn() ? '<p>This lesson now ranks ahead of unused memories like it in later recall.</p>' : ''; }
  function appliedCount(e) { var m = /Applied\s+([\d,]+)\s+time/.exec(String((e && e.title) || '')); return m ? Number(m[1].replace(/,/g, '')) : null; }
  function bridgeOn() { return !!(S.status && S.status.contextScriptsDirectory); }
  function fileGraph() { return !!(S.graph && S.graph.engine === 'explicit_document_links'); }
  function memoryPath() { if (bridgeOn()) return 'bridge'; if (S.graph && (S.graph.entities != null || S.graph.engine)) return 'knowledge'; return 'files'; }
  function hostLabel(h) { return String(h || '').replace(/\.local$/, '').replace(/-/g, ' '); }
  function lockHeld(lk) { return !!lk && (lk.state === 'exclusive' || lk.state === 'shared'); }

  // ── Cues to rate and Rated cues (MeetingAsk.swift CueReviewPane, CueRateCard, CueRatedRow; MeetingAskCore.swift
  //    CueVerdict, CueVerdicts, CueVerdictsStore) ─────────────────────────────────────────────────────────────────────
  // The server keeps the cue log and the verdicts: GET /api/live-cues/history (days, unrated, limit) and
  // POST /api/live-cues/feedback {sessionId, cueId, verdict, note?}. A verdict here never touches the glasses' up or down
  // vote, which the server keeps beside it. Rating is the only write, and only from a tap or a key on a focused card.
  var VERDICTS = ['useful', 'late', 'repeat', 'wrong', 'obvious'];
  var CUE_MIN_SERVER = '6.79.0', CUE_DAYS = 7, CUE_NOTE_MAX = 200;
  var CUE_KIND = { challenge: 'Challenge', reinforce: 'Reinforce', decision: 'Decision', promise: 'Promise', followUp: 'Follow-up', insight: 'Insight' };
  var CUE_READ_LINE = {
    checking: 'Loading cues…', olderServer: 'Rating cues needs server ' + CUE_MIN_SERVER + '. Update the server in Settings.',
    unreachable: 'COS server unreachable. Cues show here once it answers.', reconnect: 'Sign this browser in again to see cues.',
    unreadable: 'The server\'s answer about cues was not readable. Update the server in Settings.',
    storageUnreadable: 'The server\'s ratings file cannot be read, so cues cannot be listed. Check again after the server restarts.' };
  S.cue = { available: null, weekState: 'checking', queue: [], counts: null, ratedState: 'checking', rated: [], ratedLoaded: false,
    saving: {}, errors: {}, skipped: [], notes: {}, weekBusy: false, ratedBusy: false, failedStatus: 0, ratedStatus: 0 };
  function verdictLabel(v) { return v ? v.charAt(0).toUpperCase() + v.slice(1) : ''; }
  function cueNum(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  // CueVerdicts.read: the answer to a state, and from a 200 in the contract's shape, the cues and counts.
  function cueRead(d) {
    var c = d && d.counts;
    if (!d || d.v !== 1 || !Array.isArray(d.cues) || !c || typeof c.total !== 'number' || typeof c.rated !== 'number' || typeof c.unrated !== 'number') return { state: 'unreadable' };
    var by = {}; VERDICTS.forEach(function (v) { by[v] = c.byVerdict && typeof c.byVerdict[v] === 'number' ? c.byVerdict[v] : 0; });
    var cues = d.cues.filter(function (r) { return r && typeof r.cueId === 'string' && r.cueId && typeof r.sessionId === 'string' && r.sessionId && cueNum(r.createdAt) > 0 && typeof r.detail === 'string' && r.detail; });
    return { state: 'loaded', cues: cues, counts: { total: c.total, rated: c.rated, unrated: c.unrated, byVerdict: by } };
  }
  function cueReadError(err) {
    var st = err && err.status;
    if (!st) return { state: 'unreachable' };
    if (st === 404) return { state: 'olderServer' };
    if (st === 401 || st === 403) return { state: 'reconnect' };
    if (st === 503 && err.code === 'verdicts_unreadable') return { state: 'storageUnreadable' };
    return { state: 'failed', status: st };
  }
  function cueLearn(state) {
    var next = state === 'loaded' ? true : state === 'olderServer' ? false : S.cue.available;
    S.cue.available = next;
    if (next === false && (S.view === 'cues' || S.view === 'rated')) { S.view = 'recent'; persist(); if (tabRoute(W.parseRoute().args)) showTab('recent'); }
  }
  function cueVerdict(c) { return c && c.rating && c.rating.verdict ? c.rating.verdict : null; }
  // CueVerdicts.queueOrder: oldest first, then the skipped cues in the order they were skipped.
  function queueOrder(cues) {
    var skip = S.cue.skipped;
    var fresh = cues.filter(function (c) { return skip.indexOf(c.cueId) < 0; }).sort(function (a, b) { return cueNum(a.createdAt) - cueNum(b.createdAt); });
    return fresh.concat(skip.map(function (id) { return cues.filter(function (c) { return c.cueId === id; })[0]; }).filter(Boolean));
  }
  function loadCueWeek() {
    var C = S.cue; if (C.weekBusy) return;
    C.weekBusy = true; if (C.weekState !== 'loaded') C.weekState = 'checking'; paint();
    W.api('/api/live-cues/history?days=' + CUE_DAYS + '&unrated=1&limit=200').then(cueRead, cueReadError).then(function (r) {
      C.weekBusy = false; cueLearn(r.state); C.weekState = r.state; C.failedStatus = r.status || 0;
      if (r.state === 'loaded') { C.queue = queueOrder(r.cues.filter(function (c) { return !cueVerdict(c); })); C.counts = r.counts; }
      paint();
    });
  }
  // The rated list reads the whole week (up to the server's 1,000 rows), so every rated cue shows, not only the newest 200's.
  function loadCueRated() {
    var C = S.cue; if (C.ratedBusy) return;
    C.ratedBusy = true; if (C.ratedState !== 'loaded') C.ratedState = 'checking'; paint();
    W.api('/api/live-cues/history?days=' + CUE_DAYS + '&limit=1000').then(cueRead, cueReadError).then(function (r) {
      C.ratedBusy = false; cueLearn(r.state); C.ratedState = r.state; C.ratedStatus = r.status || 0;
      if (r.state === 'loaded') { C.rated = r.cues.filter(cueVerdict).sort(function (a, b) { return cueNum(b.createdAt) - cueNum(a.createdAt); }); C.counts = r.counts; C.ratedLoaded = true; }
      paint();
    });
  }
  // CueVerdicts.note: whitespace collapsed, at most 200 UTF-16 units, cut on a character, as the server stores it.
  function cueNote(raw) {
    var collapsed = String(raw || '').split(/\s+/).filter(Boolean).join(' '), out = '';
    for (var i = 0, chars = Array.from(collapsed); i < chars.length; i++) { if (out.length + chars[i].length > CUE_NOTE_MAX) break; out += chars[i]; }
    return out.trim();
  }
  // CueVerdicts.rateOutcome and rateLine: why a rating did not save, in Control's words.
  function cueRateLine(err) {
    var st = err && err.status, code = err && err.code;
    if (code === 'unknown_cue') return 'This cue is older than 30 days and was removed.';
    if (code === 'cue_session_mismatch' || st === 409) return 'The server files this cue under another meeting. The rating was not saved.';
    if (code === 'verdicts_unreadable') return 'The server\'s ratings file cannot be read. The rating was not saved.';
    if (!st) return 'Your Mac did not answer. The rating was not saved; try again.';
    if (st === 404) return 'Rating cues needs server ' + CUE_MIN_SERVER + '. Update the server in Settings.';
    if (st === 503) return 'Server is updating. Rating not saved, try again.';
    if (st === 400) return 'The server did not accept this rating.';
    if (st === 401 || st === 403) return 'Sign this browser in again to rate cues.';
    return 'The rating was not saved (HTTP ' + st + '). Try again.';
  }
  function findCue(id) {
    var C = S.cue; return C.queue.filter(function (c) { return c.cueId === id; })[0] || C.rated.filter(function (c) { return c.cueId === id; })[0] || null;
  }
  // CueVerdictsStore.rate: one call per cue at a time; on success every list that holds the cue shows the new verdict.
  function rateCue(id, verdict, note) {
    var C = S.cue, cue = findCue(id);
    if (!cue || C.saving[id] || (verdict && VERDICTS.indexOf(verdict) < 0)) return;
    var text = verdict ? cueNote(note) : '';
    var body = { sessionId: cue.sessionId, cueId: cue.cueId, verdict: verdict || 'clear' };
    if (text) body.note = text;
    C.saving[id] = true; delete C.errors[id]; paint();
    W.api('/api/live-cues/feedback', { method: 'POST', body: body }).then(function (d) {
      if (!d || d.ok !== true) throw Object.assign(new Error('not saved'), { status: 200 });
      var stored = VERDICTS.indexOf(d.verdict) >= 0 ? d.verdict : null, vote = d.vote === 'up' || d.vote === 'down' ? d.vote : null;
      var old = cueVerdict(cue), updated = Object.assign({}, cue, { rating: stored || vote ? { verdict: stored, note: stored ? text || null : null, vote: vote, at: Date.now() } : null });
      applyCue(updated, old);
      delete C.notes[id];
    }, function (err) {
      if (err && err.status === 404 && err.code !== 'unknown_cue') C.available = false;
      C.errors[id] = cueRateLine(err);
    }).then(function () { delete C.saving[id]; paint(); focusCueCard(); });
  }
  function moveCounts(old, next) {
    var c = S.cue.counts; if (!c || old === next) return;
    c = { total: c.total, rated: c.rated, unrated: c.unrated, byVerdict: Object.assign({}, c.byVerdict) };
    if (old) c.byVerdict[old] = Math.max(0, (c.byVerdict[old] || 0) - 1);
    if (next) c.byVerdict[next] = (c.byVerdict[next] || 0) + 1;
    if (!old) { c.rated += 1; c.unrated = Math.max(0, c.unrated - 1); }
    if (!next) { c.rated = Math.max(0, c.rated - 1); c.unrated += 1; }
    S.cue.counts = c;
  }
  function applyCue(cue, old) {
    var C = S.cue, now = cueVerdict(cue);
    moveCounts(old, now);
    C.skipped = C.skipped.filter(function (x) { return x !== cue.cueId; });
    var waiting = C.queue.filter(function (c) { return c.cueId !== cue.cueId; });
    if (!now && C.weekState === 'loaded' && cueNum(cue.createdAt) > Date.now() - CUE_DAYS * 86400000) waiting.push(cue);
    C.queue = queueOrder(waiting);
    var done = C.rated.filter(function (c) { return c.cueId !== cue.cueId; });
    if (now && C.ratedState === 'loaded') done.push(cue);
    C.rated = done.sort(function (a, b) { return cueNum(b.createdAt) - cueNum(a.createdAt); });
  }
  function skipCue(id) {
    var C = S.cue; C.skipped = C.skipped.filter(function (x) { return x !== id; }); C.skipped.push(id);
    C.queue = queueOrder(C.queue); paint(); focusCueCard();
  }
  // The card takes focus after a rating or a skip only when the person was already working from the keyboard there.
  var cueKeyboard = false;
  function focusCueCard() { if (!cueKeyboard) return; var card = el('mm-cue-card'); if (card && card.focus) card.focus({ preventScroll: true }); }
  // CueVerdicts.key: 1 to 5 rate, N goes to the note, S skips; only while the card itself has focus, without modifiers.
  function cueKey(e) {
    var card = e.target;
    if (!card || card.id !== 'mm-cue-card' || e.metaKey || e.ctrlKey || e.altKey) return false;
    var id = card.getAttribute('data-cue'), k = String(e.key || '');
    if (/^[1-5]$/.test(k)) { cueKeyboard = true; rateCue(id, VERDICTS[Number(k) - 1], S.cue.notes[id]); return true; }
    if (k === 'n' || k === 'N') { cueKeyboard = true; var n = el('mm-cue-note'); if (n && n.focus) n.focus(); return true; }
    if (k === 's' || k === 'S') { cueKeyboard = true; skipCue(id); return true; }
    return false;
  }
  function cueClock(ms) { return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  // "Today 7:48 AM, 7 min in"; "Yesterday", a weekday within the week, else "Oct 12".
  function cueWhen(c) {
    var d = new Date(cueNum(c.createdAt)), now = new Date();
    var days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    var day = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : days > 1 && days < 7 ? d.toLocaleDateString(undefined, { weekday: 'short' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    var start = c.armedAt ? cueNum(c.armedAt) : (/^meeting_(\d{13})_/.exec(c.sessionId || '') || [])[1] ? Number(/^meeting_(\d{13})_/.exec(c.sessionId)[1]) : null;
    var sec = start ? (cueNum(c.createdAt) - start) / 1000 : -1;
    return day + ' ' + cueClock(cueNum(c.createdAt)) + (sec >= 0 && sec < 43200 ? ', ' + Math.floor(sec / 60) + ' min in' : '');
  }
  function cueTitle(c) {
    var saved = (c.titleSource === 'saved' || c.titleSource === 'library') ? str(c.title) : '';
    return [saved, str(c.meetingTitle)].filter(function (t) { return t.trim(); })[0] || 'Glasses meeting';
  }
  function cueScore(g) { return typeof g === 'number' && isFinite(g) ? g.toFixed(2) : ''; }
  // A host a stranger could own, as MeetingAskText.publicHost decides; anything else stays plain text.
  function publicHost(raw) {
    var h = String(raw || '').toLowerCase(); if (h.slice(-1) === '.') h = h.slice(0, -1);
    if (!h || h.charAt(0) === '.' || h.slice(-1) === '.' || h.indexOf('..') >= 0 || /[:[%]/.test(h)) return false;
    if (h === 'localhost' || /\.(localhost|local|internal)$/.test(h)) return false;
    var labels = h.split('.'); return labels.length >= 2 && /^[a-z]/.test(labels[labels.length - 1]);
  }
  function cueHttps(u) {
    try { var x = new URL(String(u || '')); return x.protocol === 'https:' && publicHost(x.hostname) && !x.username && !x.password && (!x.port || x.port === '443') ? x : null; } catch (_e) { return null; }
  }
  function cueSourceText(s) {
    var x = s.kind === 'web' ? cueHttps(s.url) : null;
    if (x) { var host = x.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, ''); return (s.title || host) + ' (' + host + ')'; }
    return s.date ? (s.title || '') + ' (' + s.date + ')' : (s.title || '');
  }
  // CueSourcesList: a web source opens its https page and a memory opens in All memories; a meeting or a file has no place
  // to open from the browser (the Mac opens its library row or shows the file in Finder), so those stay plain text.
  function cueSourcesHtml(c) {
    var src = (c.sources || []).filter(function (s) { return s && s.title; });
    if (!src.length) return '<p class="mm-muted">Sources: none, from the room only</p>';
    function opens(s) { return (s.kind === 'web' && cueHttps(s.url)) || (s.kind === 'memory' && s.memoryId); }
    if (!src.some(opens)) return '<p class="mm-muted">Sources: ' + esc(src.map(cueSourceText).join('; ')) + '</p>';
    return '<div class="mm-cue-sources"><span class="mm-muted">Sources:</span><ul>' + src.map(function (s) {
      var t = esc(cueSourceText(s)), x = s.kind === 'web' ? cueHttps(s.url) : null;
      if (x) return '<li><a href="' + esc(x.href) + '" target="_blank" rel="noopener noreferrer">' + t + '</a></li>';
      if (s.kind === 'memory' && s.memoryId) return '<li>' + textBtn('cue-memory', t, { id: s.memoryId }) + '</li>';
      return '<li class="mm-muted">' + t + '</li>';
    }).join('') + '</ul></div>';
  }
  function cueMetaHtml(c, extra) {
    return '<p class="mm-cue-meta"><b>' + esc(cueTitle(c)) + '</b><span>' + esc(cueWhen(c)) + '</span><span>' + esc(CUE_KIND[c.kind] || c.kind || '') + '</span>' +
      (cueScore(c.gate) ? '<span class="mm-mono">score ' + esc(cueScore(c.gate)) + '</span>' : '') + (extra || '') + '</p>';
  }
  function verdictButtons(id, selected, showKeys, disabled) {
    return '<div class="mm-verdicts" role="group" aria-label="Rate this cue">' + VERDICTS.map(function (v, i) {
      var on = v === selected;
      return '<button type="button" class="cx-btn' + (on ? ' primary' : ' quiet') + '" data-mm="cue-rate" data-id="' + esc(id) + '" data-arg="' + v + '" aria-pressed="' + on + '"' + (disabled ? ' disabled' : '') + '>' +
        (showKeys ? '<span class="mm-key" aria-hidden="true">' + (i + 1) + '</span>' : '') + esc(verdictLabel(v)) + '</button>';
    }).join('') + '</div>';
  }
  function cueStateHtml(state, status) {
    var line = state === 'failed' ? 'The server could not list cues (HTTP ' + status + '). Check again.' : CUE_READ_LINE[state];
    if (!line) return '';
    return '<div class="cx-list"><div class="mm-state"><strong' + (state === 'checking' ? '' : ' class="mm-warn"') + '>' + esc(line) + '</strong>' +
      (state !== 'checking' && state !== 'olderServer' ? '<span class="mm-state-act">' + btn('cue-check', 'Check again') + '</span>' : '') + '</div></div>';
  }
  function cueHeading(title, detail) {
    var c = S.cue.counts;
    return '<div class="mm-cue-head"><div><h2 class="mm-cue-title">' + esc(title) + '</h2><p class="mm-muted">' + detail + '</p>' +
      (c ? '<p class="mm-muted">Ratings in the last 7 days: ' + fmt(c.rated) + ' of ' + fmt(c.total) + '.</p>' : '') + '</div>' +
      '<button type="button" class="cx-btn quiet mm-icon-btn" data-mm="cue-check" aria-label="Check again" title="Check again">' + icon('refresh') + '</button></div>';
  }
  function cueQueueHtml() {
    var C = S.cue, head = cueHeading('Cues to rate', 'Oldest first.<span class="mm-keys-hint"> Keys 1 to 5 rate, N adds a note, S skips.</span>');
    if (C.weekState !== 'loaded') return head + cueStateHtml(C.weekState, C.failedStatus);
    var cue = C.queue[0];
    if (!cue) return head + '<div class="cx-list"><div class="mm-state"><strong>' + esc(C.counts && C.counts.total ? 'Every cue from the last 7 days is rated.' : 'No cues in the last 7 days.') + '</strong></div></div>';
    var id = cue.cueId, saving = !!C.saving[id], left = Math.max(C.queue.length, C.counts ? C.counts.unrated : 0), next = C.queue[1];
    var vote = cue.rating && cue.rating.vote === 'up' ? 'Voted up on the glasses' : cue.rating && cue.rating.vote === 'down' ? 'Voted down on the glasses' : '';
    return head + '<section class="cx-card mm-cue" id="mm-cue-card" tabindex="0" data-cue="' + esc(id) + '" aria-label="Cue to rate. Keys 1 to 5 rate, N adds a note, S skips.">' +
      cueMetaHtml(cue, '<span class="mm-cue-left">' + (left === 1 ? '1 left' : fmt(left) + ' left') + '</span>') +
      '<p class="mm-cue-text">' + esc(cue.detail) + '</p>' + cueSourcesHtml(cue) +
      (cue.general && cue.general.query ? '<p class="mm-muted">Searched the web for: ' + esc(cue.general.query) + '</p>' : '') +
      (cue.before ? '<div class="mm-cue-before"><span class="mm-muted">What was said just before</span><p>' + esc(cue.before) + '</p></div>' : '') +
      (vote ? '<p class="mm-muted">' + vote + '</p>' : '') + verdictButtons(id, null, true, saving) +
      '<label class="mm-pick mm-block"><span>Note (optional)</span><input class="field" id="mm-cue-note" data-cue="' + esc(id) + '" maxlength="' + CUE_NOTE_MAX + '" autocomplete="off" placeholder="What would have made it useful?" value="' + esc(C.notes[id] || '') + '"></label>' +
      '<div class="mm-actions">' + btn('cue-skip', 'Skip', { id: id, disabled: saving }) + (saving ? '<span class="mm-muted">Saving…</span>' : '') +
      (C.errors[id] ? '<span class="mm-warn">' + esc(C.errors[id]) + '</span>' : '') + '</div></section>' +
      (next ? '<p class="mm-muted mm-cue-next">Next up: ' + esc(cueClock(cueNum(next.createdAt))) + ' · ' + esc(clip(next.headline || next.detail, 80)) + '</p>' : '');
  }
  function cueRatedHtml() {
    var C = S.cue, head = cueHeading('Rated cues', 'Newest first. Pick another verdict to change one.');
    if (C.ratedState !== 'loaded') return head + cueStateHtml(C.ratedState, C.ratedStatus);
    if (!C.rated.length) return head + '<div class="cx-list"><div class="mm-state"><strong>No rated cues in the last 7 days.</strong></div></div>';
    return head + C.rated.map(function (c) {
      var id = c.cueId, saving = !!C.saving[id], r = c.rating || {};
      return '<article class="cx-card mm-cue-row">' + cueMetaHtml(c) + '<p class="mm-cue-text small">' + esc(c.detail) + '</p>' +
        (r.verdict ? '<p class="mm-cue-rated">Rated ' + esc(verdictLabel(r.verdict)) + (r.note ? ' · “' + esc(r.note) + '”' : '') + '</p>' : '') +
        '<div class="mm-actions">' + verdictButtons(id, r.verdict, false, saving) +
        '<button type="button" class="mm-link" data-mm="cue-clear" data-id="' + esc(id) + '" title="Back to Cues to rate"' + (saving ? ' disabled' : '') + '>Clear</button></div>' +
        (C.errors[id] ? '<p class="mm-warn">' + esc(C.errors[id]) + '</p>' : '') + '</article>';
    }).join('');
  }
  function cueAct(name, id, arg) {
    var C = S.cue, cue = findCue(id);
    if (name === 'cue-check') return S.view === 'rated' ? loadCueRated() : loadCueWeek();
    if (name === 'cue-skip') return skipCue(id);
    if (name === 'cue-clear') return rateCue(id, null);
    if (name === 'cue-memory') { S.view = 'memories'; persist(); if (!S.mem.loaded && !S.mem.loading) loadMem(false); return W.go('memories', ['m', id]); }
    if (name === 'cue-rate') {
      if (!cue) return;
      // A rated row keeps its note when its verdict changes; picking the verdict it already has changes nothing.
      if (cueVerdict(cue)) { if (arg === cueVerdict(cue)) return; return rateCue(id, arg, cue.rating && cue.rating.note); }
      return rateCue(id, arg, C.notes[id]);
    }
  }

  // ── chrome: hero, views, counts, footer ──────────────────
  function heroHtml() {
    return '<header class="cx-hero mm-hero" data-tint="memories"><span class="cx-glyph">' + icon('memories') + '</span>' +
      '<div class="cx-hero-text"><h1 class="cx-title">Memories</h1><p class="cx-detail-line">Follow what COS learns, how skills change, and whether it helps.</p></div>' +
      '<div class="cx-actions">' + btn('settings', 'Memory settings') +
      '<button type="button" class="cx-btn quiet mm-icon-btn" data-mm="refresh" aria-label="Refresh memories" title="Refresh memories">' + icon('refresh') + '</button></div></header>';
  }
  function viewsHtml() {
    var n = needsCount();
    // The two cue views show once the server's cue history has answered (a 404, a server without it, hides them).
    var cueOn = S.cue.available === true || (S.cue.available === null && (S.view === 'cues' || S.view === 'rated'));
    var unrated = S.cue.counts ? S.cue.counts.unrated : null;
    return '<div class="cx-switch mm-tabs" role="group" aria-label="Memories view">' + VIEWS.concat(cueOn ? CUE_VIEWS : []).map(function (v) {
      var label = v[0] === 'review' && n ? 'To review (' + fmt(n) + ')' : v[0] === 'cues' && unrated ? 'Cues to rate (' + fmt(unrated) + ')' : v[1];
      return '<button type="button" data-mm="view" data-arg="' + v[0] + '" aria-pressed="' + (S.view === v[0]) + '">' + esc(label) + '</button>';
    }).join('') + '</div>';
  }
  function countsHtml() {
    var n = needsCount(), parts = [];
    var checked = S.recent.rows.filter(function (e) { return outcomeText(e); }).length;
    if (S.statusError && !S.status) parts.push('<span class="mm-bad">' + esc('Could not read this Mac\'s status. ' + S.statusError) + '</span>');
    if (n) parts.push('<span><b>' + fmt(n) + '</b> ' + plural(n, 'change', 'changes') + ' to review</span>');
    if (S.recent.total != null) parts.push('<span><b>' + fmt(S.recent.total) + '</b> ' + plural(S.recent.total, 'event', 'events') + ' in 90 days</span>');
    else if (S.recent.loading) parts.push('<span>Counting events…</span>');
    else if (S.recent.error) parts.push('<span class="mm-warn">Events in 90 days could not be counted</span>');
    if (S.recent.loaded) parts.push('<span><b>' + fmt(checked) + '</b> ' + plural(checked, 'result', 'results') + ' checked on this page</span>');
    parts.push('<span>Capture status in ' + textBtn('settings', 'Memory settings') + '</span>');
    parts.push('<span>' + textBtn('log', 'View activity log') + '<span class="mm-phone-only"><span class="mm-dot" aria-hidden="true"> · </span>' + textBtn('refresh', 'Refresh') + '</span></span>');
    return parts.join('<span class="mm-dot" aria-hidden="true">·</span>');
  }
  function footHtml() {
    var s = S.status;
    if (!s) return 'Stored on this Mac';
    return 'Stored on this Mac · ' + (bridgeOn() ? 'Advanced search connected' : 'Plain files') + (s.installedVersion ? ' · Server ' + esc(s.installedVersion) : '');
  }

  // ── lists ────────────────────────────────────────────────
  function rowHtml(e, selected, act) {
    var st = rowStatus(e), what = rowWhat(e);
    var facts = [kindLabel(e), storeName(e.store), known(e.scope), when(e.ts)].filter(Boolean);
    return '<button type="button" class="mm-row" data-mm="' + (act || 'open-e') + '" data-id="' + esc(e.event_id) + '" aria-selected="' + (selected ? 'true' : 'false') + '">' +
      '<span class="mm-row-body"><span class="mm-row-title">' + esc(clip(rowTitle(e), 220)) + '</span>' +
      (what ? '<span class="mm-row-what">' + esc(what) + '</span>' : '') +
      '<span class="mm-facts"><span class="mm-kind">' + esc(facts[0]) + '</span>' + (facts.length > 1 ? ' · ' + esc(facts.slice(1).join(' · ')) : '') + '</span>' +
      '<span class="mm-status' + (st.tone ? ' ' + st.tone : '') + '">' + esc(clip(st.text, 200)) + '</span></span><span class="chev"></span></button>';
  }
  function memRowHtml(m, selected) {
    var facts = [m.type ? String(m.type).replace(/_/g, ' ') : 'Memory', day(m.created_at)].filter(Boolean);
    return '<button type="button" class="mm-row" data-mm="open-m" data-id="' + esc(m.id) + '" aria-selected="' + (selected ? 'true' : 'false') + '">' +
      '<span class="mm-row-body"><span class="mm-row-title">' + esc(clip(m.summary || m.content || '(untitled)', 220)) + '</span>' +
      '<span class="mm-facts"><span class="mm-kind">' + esc(facts[0]) + '</span>' + (facts[1] ? ' · ' + esc(facts[1]) : '') + '</span></span><span class="chev"></span></button>';
  }
  function appliedRowHtml(e, selected) {
    var lesson = memText(e.lesson_id) || e.lesson_id || 'Lesson';
    var facts = [known(e.engine), when(e.ts)].filter(Boolean);
    var ex = appliedExcerpt(e);
    return '<button type="button" class="mm-row" data-mm="open-e" data-id="' + esc(e.event_id) + '" aria-selected="' + (selected ? 'true' : 'false') + '">' +
      '<span class="mm-row-body"><span class="mm-row-title">' + esc(clip(lesson, 220)) + '</span>' +
      '<span class="mm-facts"><span class="mm-kind">Used in an answer</span>' + (facts.length ? ' · ' + esc(facts.join(' · ')) : '') + '</span>' +
      '<span class="mm-status ok mm-clamp">' + esc(clip(ex, 200) || 'A later answer used this lesson') + '</span></span><span class="chev"></span></button>';
  }
  function appliedExcerpt(e) { return ((e.source_refs || [])[0] || {}).excerpt || (e.detail && e.detail.excerpts && e.detail.excerpts[0]) || ''; }
  function groupHead(text, side) { return '<h2 class="group-title mm-group"><span>' + text + '</span>' + (side ? '<span>' + side + '</span>' : '') + '</h2>'; }
  function stateBox(title, body, retry) {
    return '<div class="cx-list"><div class="mm-state"><strong>' + esc(title) + '</strong>' + (body ? '<span>' + esc(body) + '</span>' : '') +
      (retry ? '<span class="mm-state-act">' + btn(retry, 'Try again') + '</span>' : '') + '</div></div>';
  }
  function loadingBox(what) { return '<div class="cx-list" aria-busy="true"><div class="mm-state"><strong>' + esc(what) + '</strong><span>Your Mac reads this from its memory store. It can take a few seconds.</span></div>' + W.skeletonRows(3).replace(/^<div class="list">|<\/div>$/g, '') + '</div>'; }
  function moreBtn(act, label, busy) { return '<div class="mm-more">' + btn(act, busy ? 'Loading…' : label, { disabled: busy }) + '</div>'; }
  function coverageNote(cov) {
    var c = cov || {}, gaps = Object.keys(c).filter(function (k) { return c[k] && c[k].state && c[k].state !== 'ok' && c[k].state !== 'legacy'; });
    if (!gaps.length) return '';
    return '<p class="cx-note">Not recorded on this Mac yet: ' + esc(gaps.map(function (k) { return storeName(k); }).join(', ')) + '.</p>';
  }
  function selectedId() { var a = readerArgs(W.parseRoute()); return a.length === 2 ? a[1] : (autoPick() || ''); }

  function listHtml() {
    if (S.view === 'cues') return cueQueueHtml();
    if (S.view === 'rated') return cueRatedHtml();
    if (S.view === 'knowledge') return knowledgeListHtml();
    if (S.view === 'memories') return memListHtml();
    if (S.view === 'applied') return appliedListHtml();
    if (S.view === 'review') return reviewListHtml();
    return recentListHtml();
  }
  function recentListHtml() {
    var L = S.recent, sel = selectedId();
    if (!L.loaded && L.loading) return groupHead('Recent learning', '90 days') + loadingBox('Reading what COS learned in the last 90 days');
    if (L.error && !L.rows.length) return groupHead('Recent learning', '90 days') + stateBox('Recent learning did not load.', L.error, 'refresh');
    if (!L.rows.length) return groupHead('Recent learning', '90 days') + stateBox('Nothing learned in the last 90 days.', 'Lessons, corrections and recalls show here as COS records them.');
    return groupHead('Recent learning', L.total != null ? fmt(L.total) + ' in 90 days' : '90 days') +
      '<div class="cx-list">' + L.rows.map(function (e) { return rowHtml(e, e.event_id === sel); }).join('') + '</div>' +
      (L.cursor ? moreBtn('more-recent', 'Load more', L.loading) : '') + coverageNote(L.coverage);
  }
  function reviewListHtml() {
    var L = S.review, sel = selectedId(), needs = needsRows(), seen = {};
    needs.forEach(function (e) { seen[e.event_id] = 1; });
    var rest = L.rows.filter(function (e) { return !seen[e.event_id]; });
    var other = rest.filter(function (e) { return !isPruneReady(e); }), ready = rest.filter(isPruneReady);
    var out = '';
    var openNeeds = needsCount();
    if (needs.length) out += groupHead('Needs you now', openNeeds ? fmt(openNeeds) + ' open' : 'All decided') + '<div class="cx-list">' + needs.map(function (e) { return rowHtml(e, e.event_id === sel); }).join('') + '</div>';
    if (!L.loaded && L.loading) return out + groupHead('Proposed changes') + loadingBox('Reading the changes waiting for you');
    if (L.error && !L.rows.length) return out + groupHead('Proposed changes') + stateBox('The review list did not load.', L.error, 'refresh');
    if (!needs.length && !rest.length) return groupHead('To review') + stateBox('You are up to date.', 'No proposed changes are waiting for review.');
    if (other.length) out += groupHead('Proposed changes', L.total != null ? fmt(L.total) + ' in all' : '') + '<div class="cx-list">' + other.map(function (e) { return rowHtml(e, e.event_id === sel); }).join('') + '</div>';
    if (ready.length) {
      var open = ready.filter(function (e) { return !decisionFor(e); }).length, b = S.bulk;
      out += groupHead('Ready to quarantine', open ? fmt(open) + ' open' : 'All decided') +
        '<p class="mm-group-note">Saved memories that are old, unused and rarely recalled. Quarantine takes them out of recall and keeps them; Restore brings one back.</p>' +
        (b ? '<p class="mm-group-note" aria-live="polite">Quarantining ' + fmt(b.done) + ' of ' + fmt(b.total) + '…</p>' :
          open ? '<div class="mm-more mm-more-top">' + btn('prune-all', S.armed === 'prune-all' ? 'Tap again to quarantine ' + fmt(open) : 'Quarantine all ' + fmt(open)) + '</div>' : '') +
        '<div class="cx-list">' + ready.map(function (e) { return rowHtml(e, e.event_id === sel); }).join('') + '</div>';
    }
    if (L.cursor) out += moreBtn('more-review', 'Load more to review', L.loading);
    return out;
  }
  function memSearchHtml() {
    return '<form class="cx-search mm-search" data-mm-form="mem-search" role="search"><input class="field" type="search" id="mm-mem-q" placeholder="Search topics, ideas…" value="' + esc(S.mem.q) + '" autocomplete="off" enterkeyhint="search" aria-label="Search memories">' +
      (S.mem.q ? '<button type="button" class="cx-clear" data-mm="mem-clear">Clear</button>' : '') + '</form>';
  }
  function memListHtml() {
    var L = S.mem, q = L.q.trim(), rows = L.hits != null ? L.hits : L.rows, sel = selectedId();
    var head = groupHead(q ? 'Memories matching “' + esc(q) + '”' : 'Saved memories', !q && L.total != null ? fmt(L.total) + ' stored' : '');
    if (!L.loaded && L.loading) return head + loadingBox(q ? 'Searching your memories' : 'Reading your saved memories');
    if (L.error && !rows.length) return head + stateBox(q ? 'That search did not finish.' : 'Your memories did not load.', L.error, 'mem-retry');
    if (!rows.length) return head + stateBox(q ? 'No memories match that search.' : 'No memories yet.', q ? 'Try fewer or different words.' : 'COS saves memories as you work. Plain notes in the memory folder show here too.');
    var cursor = q ? L.hitCursor : L.cursor;
    return head + '<div class="cx-list">' + rows.map(function (m) { return memRowHtml(m, m.id === sel); }).join('') + '</div>' +
      (cursor ? moreBtn('more-mem', 'Load more memories', L.loading) : '') + (L.paged === false ? '<p class="cx-note">This server shows the newest memories only.</p>' : '');
  }
  function appliedListHtml() {
    var L = S.applied, sel = selectedId();
    var toggle = textBtn('applied-days', L.days === 90 ? 'Show this week' : 'Show 90 days', { arg: L.days === 90 ? 7 : 90 });
    var head = groupHead((L.days === 90 ? 'Applied in 90 days' : 'Applied this week') + (L.total != null ? ' · ' + fmt(L.total) : ''), toggle);
    if (!L.loaded) return head + loadingBox('Reading which lessons later answers used');
    if (!L.rows.length) { var c = appliedEmpty(); return head + stateBox(c.h, c.p, L.error ? 'applied-retry' : ''); }
    return head + '<div class="cx-list">' + L.rows.map(function (e) { return appliedRowHtml(e, e.event_id === sel); }).join('') + '</div>' +
      (L.cursor ? moreBtn('more-applied', 'Load more', L.loading) : '') + coverageNote(L.coverage);
  }
  // Empty copy by memory path: the bridge can detect use and saw none; the other paths cannot detect it at all.
  function appliedEmpty() {
    var L = S.applied, cov = (L.coverage && L.coverage.used) || (S.recent.coverage && S.recent.coverage.used) || {};
    if (L.error) return { h: 'Applied is not available right now.', p: L.error };
    if (!S.status) return S.statusError ? { h: 'Could not read this Mac\'s status.', p: 'Applied says nothing about the memory path until your Mac answers. ' + S.statusError }
      : { h: 'Checking how this Mac stores memory…', p: 'Applied says nothing about use until your Mac has answered.' };
    var path = memoryPath();
    if (path === 'files') return { h: 'This memory setup cannot detect use.', p: 'Applied stays empty until advanced search is connected. Plain-file memories keep working.' };
    if (path === 'knowledge') return { h: 'Knowledge citations are not lesson use.', p: 'Applied is for saved lessons. Connect advanced search to see when a later answer uses one.' };
    if (cov.state === 'unavailable') return { h: 'The use record could not be read on this Mac.', p: 'Nothing is made up here. Check the record on your Mac and refresh.' };
    if (cov.state && cov.state !== 'ok' && cov.state !== 'legacy') return { h: 'Use has not been recorded on this Mac yet.', p: 'Nothing here is a measured zero.' };
    return { h: 'No later answer has used a lesson ' + (L.days === 90 ? 'in 90 days.' : 'this week.'), p: 'Being recalled is not the same as being used. A lesson shows here when a later answer visibly applied it.' };
  }
  // On a wide screen with nothing chosen, the reader shows the first row (Control's page does the same).
  function autoPick() {
    if (!isWide() || S.view === 'cues' || S.view === 'rated') return '';
    if (S.view === 'knowledge') return S.ktab;
    if (S.view === 'memories') { var m = S.mem.hits != null ? S.mem.hits : S.mem.rows; return m[0] ? m[0].id : ''; }
    var rows = S.view === 'applied' ? S.applied.rows : S.view === 'review' ? needsRows().concat(S.review.rows) : S.recent.rows;
    return rows[0] ? rows[0].event_id : '';
  }

  // ── the reader: a lesson's timeline ──────────────────────
  function step(title, meta, body, last) {
    return '<section class="mm-step' + (last ? ' last' : '') + '"><div class="mm-step-head"><h3>' + title + '</h3>' + (meta ? '<span class="mm-step-meta">' + meta + '</span>' : '') + '</div><div class="mm-step-body">' + body + '</div></section>';
  }
  function quote(text) { return '<blockquote class="mm-quote">' + esc(text) + '</blockquote>'; }
  function readerHead(title, facts, actions) {
    var full = SPLIT_KIT.fullButton(SPLIT.key, SPLIT.controls);
    return '<div class="mm-reader-head"><h2 class="mm-title">' + esc(title) + '</h2>' + (facts ? '<p class="mm-sub">' + facts + '</p>' : '') +
      (actions || full ? '<div class="mm-actions">' + (actions || '') + full + '</div>' : '') + '</div>';
  }
  function eventReader(id) {
    var base = findRow(id);
    if (!base) {
      var loading = !S.recent.loaded || !S.review.loaded || S.loading[id];
      if (loading) return readerState('Opening this item…', 'Your Mac is reading it.');
      if (!S.detail[id]) { S.detail[id] = null; ensureDetail({ event_id: id }); return readerState('Opening this item…', 'Your Mac is reading it.'); }
      return readerState('This item is not in the list any more.', 'It may have been reviewed already.', true);
    }
    if (S.view === 'applied' && base.event_type === 'used' && S.applied.rows.indexOf(base) >= 0) return appliedReader(base);
    ensureDetail(base);
    if (isMemoryLesson(base)) ensureMem(base.lesson_id);
    var full = S.detail[base.event_id], e = fullRow(base);
    crumb(clip(rowTitle(e), 60));
    var o = outcomeText(e);
    var facts = ['<span class="mm-kind">' + esc(o ? 'Checked: ' + o : kindLabel(e)) + '</span>', esc(storeName(e.store)), esc(known(e.scope)), esc(known(e.engine) !== known(e.scope) ? known(e.engine) : ''), esc(when(e.ts))].filter(function (x) { return x && x !== '<span class="mm-kind"></span>'; }).join(' · ');
    var actions = btn('open-sources', 'Open sources', { id: e.event_id }) + btn('explore', 'Explore in graph', { id: e.event_id }) + btn('copy-open', 'Copy context', { id: e.event_id, cls: 'primary' });
    var note = '';
    if (e.needs) note += '<div class="cx-notice warn">' + esc((GATE[e.needs.gate] || 'Needs you') + (e.needs.reason ? ': ' + e.needs.reason : '') + '.') + '</div>';
    if (full && full._error && !(e.store === 'bot_memory')) note += '<div class="cx-notice">' + esc(full._error) + '</div>';
    else if (!full && !(e.store === 'bot_memory' && e.lesson_id) && S.loading[e.event_id]) note += '<p class="cx-note">Reading the full record…</p>';
    if (e.detail && e.detail.truncated) note += '<div class="cx-notice">The record was shortened to fit. Your Mac holds more than shown here.</div>';
    return readerHead(clip(rowTitle(e), 140), facts, actions) + note +
      '<div class="mm-timeline">' + sourceStep(e) + changeStep(e) + useSteps(e) + evidenceStep(e) + '</div>';
  }
  function sourceStep(e) {
    var ref = (e.source_refs || [])[0] || {}, d = e.detail || {};
    var lessonText = isMemoryLesson(e) ? (S.memDetail[e.lesson_id] && !S.memDetail[e.lesson_id]._error ? str(S.memDetail[e.lesson_id].content) || str(S.memDetail[e.lesson_id].summary) : '') : '';
    var q = ref.excerpt || d.content || (d.bodies || [])[0] || lessonText || '';
    var title = e.store === 'correction_journal' ? 'You corrected COS' : e.store === 'self_improvement_queue' ? 'A task suggested a change' :
      e.store === 'bot_memory' ? 'COS saved this' : e.store === 'eval_scores' || e.store === 'reflect_log' ? 'A run was checked' : isMemoryLesson(e) ? 'The memory' : 'Captured';
    var body = q ? quote(q) : (isMemoryLesson(e) && S.loading['m:' + e.lesson_id] ? '<p class="cx-note">Reading the memory…</p>' :
      isMemoryLesson(e) && memError(e.lesson_id) ? '<p class="mm-muted">The memory could not be read: ' + esc(memError(e.lesson_id)) + '</p>' : '<p class="mm-muted">No excerpt was stored with this record.</p>');
    if (isMemoryLesson(e)) body += '<p>' + textBtn('open-m', 'Open the memory', { id: e.lesson_id }) + '</p>';
    else if (ref.id) body += '<p class="mm-muted">' + esc(storeName(ref.kind)) + ' · ' + esc(ref.id) + '</p>';
    return step(esc(title), esc(when(e.ts)), body + memoryActions(e));
  }
  // Accept keeps a memory in recall; Quarantine (prune on the wire) takes it out and keeps the content; Restore brings it
  // back. Forget is separate and explicit. Each needs a second tap where it removes something.
  function memoryActions(e) {
    var busy = S.reviewBusy === e.lesson_id;
    if (e.governance) {
      var acts = [['accept', 'Accept for recall'], ['quarantine', 'Quarantine'], ['restore', 'Restore to recall'], ['forget', 'Forget permanently']].filter(function (p) {
        return !(p[0] === 'accept' && e.governance !== 'candidate' || p[0] === 'restore' && e.governance !== 'quarantined' || p[0] === 'quarantine' && e.governance === 'quarantined');
      }).map(function (p) { var armed = p[0] === 'forget' && S.armed === 'forget:' + e.lesson_id; return btn('governed', armed ? 'Tap again to forget permanently' : p[1], { id: e.lesson_id, arg: p[0], disabled: busy }); }).join('');
      return '<p class="mm-muted">State: ' + esc(e.governance) + '</p><div class="mm-actions">' + acts + '</div>' +
        (S.armed === 'forget:' + e.lesson_id ? '<p class="mm-warn">Forgetting removes the searchable content. Outside sources and protected backups are reported separately.</p>' : '');
    }
    if (e.store !== 'bot_memory' || !e.lesson_id || e.event_type !== 'captured') return '';
    var decision = decisionFor(e);
    if (decision === 'pruned') return '<p class="mm-muted">Quarantined from recall. The content is kept for review.</p><div class="mm-actions">' + btn('memory-review', busy ? 'Working…' : 'Restore to recall', { id: e.lesson_id, arg: 'restore', disabled: busy }) + '</div>';
    var armed = S.armed === 'prune:' + e.lesson_id;
    return (isPruneReady(e) && !decision ? '<p class="mm-muted">Ready to quarantine' + (pruneReason(e) ? ': ' + esc(pruneReason(e)) : '') + '. Accept keeps it in recall and stops it being suggested again; Quarantine takes it out of recall; Restore brings it back.</p>' : '') +
      '<div class="mm-actions">' + (decision === 'accepted' ? '<span class="cx-cap ok">Accepted</span>' : btn('memory-review', busy ? 'Working…' : 'Accept', { id: e.lesson_id, arg: 'accept', disabled: busy, cls: 'primary' })) +
      btn('memory-review', armed ? 'Tap again to quarantine' : 'Quarantine', { id: e.lesson_id, arg: 'prune', disabled: busy }) + '</div>';
  }
  function changeStep(e) {
    var d = e.detail || {}, proposal = isProposal(e), pattern = isPattern(e), body = '';
    var applies = (e.applies_to || []).map(function (a) { return typeof a === 'string' ? a : [a.name || a.path || a.id, a.cadence].filter(Boolean).join(' · '); }).filter(Boolean);
    if (proposal) {
      body += '<p>Suggested by <b>' + esc(d.task || e.category || 'a scheduled task') + '</b>' + (d.layer ? ' · ' + esc(d.layer) : '') + (d.date ? ' · ' + esc(d.date) : '') + '.</p>';
      body += (d.entry || d.content ? quote(d.entry || d.content) : '') + (d.bodies || []).map(function (b) { return '<p>' + esc(b) + '</p>'; }).join('');
      if (d.logged_times) body += '<p>Logged ' + fmt(d.logged_times) + ' ' + plural(d.logged_times, 'time', 'times') + '.</p>';
    } else if (d.before || d.after || d.rule) {
      body += '<div class="mm-change">' + (d.before ? '<div><span class="mm-label">Before</span>' + esc(d.before) + '</div>' : '') + '<div class="after"><span class="mm-label">' + (d.after ? 'After' : 'Rule') + '</span>' + esc(d.after || d.rule || '') + '</div></div>';
      if (d.rule && d.after) body += '<p><b>Rule</b> ' + esc(d.rule) + '</p>';
    } else if (d.content && !(e.store === 'bot_memory')) body += quote(d.content);
    else if (!isMemoryLesson(e)) body += '<p>' + esc(cleanTitle(e.title)) + '</p>';
    else return '';
    if (e.target && e.target.version) body += '<p>Version <b>' + esc(e.target.version) + '</b></p>';
    body += effectBlock(e, applies);
    var decision = decisionFor(e);
    if (proposal || pattern) body += '<div class="mm-actions">' + btn('steward', 'Review rule versions', { cls: 'primary' }) +
      (decision === 'dismissed' ? btn('decide', 'Restore suggestion', { id: e.event_id, arg: 'reopened' }) : btn('decide', 'Dismiss', { id: e.event_id, arg: 'dismissed' })) + '</div>';
    var title = decision === 'dismissed' ? 'Change dismissed' : proposal ? 'Suggested change' : e.event_type === 'promotable' ? 'Suggested rule' : (KIND[e.event_type] || 'Change');
    return step(esc(title), esc(proposal ? 'Instruction' : known(e.engine) || known(e.scope)), body);
  }
  function effectBlock(e, applies) {
    var d = e.detail || {}, o = outcomeText(e), rows = [];
    var repeat = d.occurrences != null ? fmt(d.occurrences) + ' ' + plural(d.occurrences, 'occurrence', 'occurrences') + (d.threshold ? ' (threshold ' + esc(d.threshold) + ')' : '')
      : d.logged_times ? 'logged ' + fmt(d.logged_times) + ' ' + plural(d.logged_times, 'time', 'times') : null;
    if (applies.length) rows.push('<li><b>Where it applies</b>' + esc(applies.join(', ')) + '</li>');
    if (o || d.status) rows.push('<li><b>Checks</b>' + esc(o || d.status) + '</li>');
    if (repeat) rows.push('<li><b>Repeat rate</b>' + esc(repeat) + '</li>');
    return rows.length ? '<div class="mm-effect"><span class="mm-label">Expected effect</span><ul>' + rows.join('') + '</ul></div>' : '';
  }
  function useSteps(e) {
    var id = e.lesson_id, rows = [], seen = {};
    S.recent.rows.concat(S.review.rows).forEach(function (r) { if (r && !seen[r.event_id] && isUseType(r) && id && r.lesson_id === id) { seen[r.event_id] = 1; rows.push(r); } });
    if (isUseType(e) && !seen[e.event_id]) rows.push(e);
    rows.sort(function (a, b) { return String(a.ts || '').localeCompare(String(b.ts || '')); });
    return rows.map(useStep).join('');
  }
  function useStep(r) {
    var o = outcomeText(r), stage = (r.detail && r.detail.stage) || r.event_type, eng = known(r.engine) || (r.outcome && r.outcome.evaluator) || '';
    var times = r.detail && r.detail.count ? ' · ' + fmt(r.detail.count) + ' ' + plural(r.detail.count, 'time', 'times') : '';
    if (o || stage === 'checked') return step('A later result was checked', esc((r.outcome && r.outcome.evaluator) || when(r.ts)), '<p class="mm-check">' + esc(o || cleanTitle(r.title) || 'Checked') + '</p><p class="mm-muted">One recorded check. Evidence for that run, not a promise about every later answer.</p>');
    if (r.event_type === 'used' || stage === 'applied') {
      var ex = appliedExcerpt(r);
      return step('Used in a later session', esc(when(r.ts)), (ex ? quote(ex) : '') + '<p>' + esc(cleanTitle(r.title)) + (eng ? ' by ' + esc(eng) : '') + times + '.</p>' + rankingSentence());
    }
    return step(stage === 'included' ? 'Included in a later session' : 'Recalled in a later session', esc(when(r.ts)), '<p>' + esc(cleanTitle(r.title)) + (eng ? ' by ' + esc(eng) : '') + times + '.</p><p class="mm-muted">Being recalled is not the same as being used.</p>');
  }
  function evidenceStep(e) {
    var n = (e.source_refs || []).length;
    return step('Evidence for this lesson', 'Knowledge', '<p>' + fmt(n) + ' source ' + plural(n, 'record', 'records') + '. Sources are what was actually said. Graph links are extracted context, not proof that the lesson worked.</p>' +
      (e.provenance && e.provenance !== 'complete' ? '<p class="mm-muted">Provenance: ' + esc(e.provenance) + '.</p>' : ''), true);
  }
  function appliedReader(e) {
    ensureMem(e.lesson_id);
    var lesson = memText(e.lesson_id) ? (S.memDetail[e.lesson_id].content || S.memDetail[e.lesson_id].summary) : '', err = memError(e.lesson_id), ex = appliedExcerpt(e), d = e.detail || {};
    var n = appliedCount(e);
    crumb(clip(lesson || 'Lesson', 60));
    var facts = ['<span class="mm-kind">Used in an answer</span>', esc(known(e.engine)), d.sessions ? fmt(d.sessions) + ' ' + plural(d.sessions, 'session', 'sessions') : '', esc(when(e.ts))].filter(Boolean).join(' · ');
    var lessonBody = lesson ? quote(lesson) : err ? '<div class="cx-notice">This lesson\'s record could not be read (' + esc(err) + '). The use below is still recorded.</div>' : '<p class="cx-note">Reading the record…</p>';
    return readerHead(lesson ? clip(lesson, 200) : 'Lesson', facts, e.lesson_id ? btn('open-m', 'Open the memory', { id: e.lesson_id }) : '') +
      '<div class="mm-timeline">' + step('The lesson', 'Saved memory', lessonBody) +
      step('A later answer used it', esc(when(e.ts)), (ex ? quote(ex) : '') + '<p>' + esc(n != null ? 'Recorded ' + fmt(n) + ' ' + plural(n, 'time', 'times') + ' since first use' : 'Recorded') + ', from the assistant\'s own words. Evidence for that answer, not a promise about every later one.</p>', !rewardOn()) +
      (rewardOn() ? step('Ranking', 'Reward on', rankingSentence(), true) : '') + '</div>';
  }
  function memoryReader(id) {
    var rows = S.mem.hits != null ? S.mem.hits.concat(S.mem.rows) : S.mem.rows;
    var m = rows.filter(function (x) { return x.id === id; })[0] || { id: id };
    ensureMem(id);
    var full = S.memDetail[id] || null, r = Object.assign({}, m, full && !full._error ? full : {});
    var text = r.content || r.summary || '';
    if (!text && (!full || S.loading['m:' + id])) return readerState('Opening this memory…', 'Your Mac is reading it.');
    crumb(clip(r.summary || 'Memory', 60));
    var facts = ['<span class="mm-kind">Saved memory</span>', esc(r.type ? String(r.type).replace(/_/g, ' ') : ''), esc(day(r.created_at)), esc(r.source || '')].filter(Boolean).join(' · ');
    return readerHead(clip(r.summary || text || 'Memory', 200), facts, btn('copy-memory', 'Copy context', { id: id, cls: 'primary' })) +
      (full && full._error ? '<div class="cx-notice">' + esc(full._error) + '</div>' : '') +
      '<div class="mm-timeline">' + step('Captured memory', esc(r.type ? String(r.type).replace(/_/g, ' ') : 'Memory'), text ? quote(text) : '<p class="mm-muted">This memory has no text.</p>') +
      step('Available for recall', r.filePath ? 'Plain files' : 'Memory store', '<p>Active memories are available to signed-in sessions. Later recall, use or results show under Recent learning when they are recorded.</p>', true) + '</div>';
  }
  function readerState(title, body, back) {
    return '<div class="mm-reader-state"><strong>' + esc(title) + '</strong>' + (body ? '<span>' + esc(body) + '</span>' : '') + (back ? '<span class="mm-state-act">' + btn('back', 'Back to the list') + '</span>' : '') + '</div>';
  }

  // ── Knowledge ────────────────────────────────────────────
  function setupDone() {
    var s = S.setup; if (!s || fileGraph()) return null;
    var checks = s.checks || [], ok = checks.length > 0 && checks.every(function (c) { return c.ok; });
    var on = (s.sources || []).some(function (r) { return r.enabled && r.exists && (r.files || 0) > 0; });
    var b = s.budget || {}, budgetOk = b.used != null && b.cap != null && b.used < b.cap, graphN = (s.graph || {}).entities;
    var sample = (s.sample || {}).indexed >= 1 || (graphN != null && graphN > 0);
    return [ok, on, (s.owner || {}).is_owner === true, ok && budgetOk, sample, !!S.ask.answer, (s.schedule || {}).installed === true].filter(Boolean).length;
  }
  function knowledgeListHtml() {
    var sel = selectedId(), focus = S.knowledgeFocus && findRow(S.knowledgeFocus), done = setupDone();
    function route(tab, title, sub) {
      return '<button type="button" class="mm-row" data-mm="ktab" data-arg="' + tab + '" aria-selected="' + (sel === tab) + '"><span class="mm-row-body"><span class="mm-row-title">' + esc(title) + '</span><span class="mm-status">' + esc(sub) + '</span></span><span class="chev"></span></button>';
    }
    return groupHead('Explore knowledge') + '<div class="cx-list">' +
      route('graph', 'Ask the graph', 'Explore connections · ' + (fileGraph() ? 'your document links' : 'your knowledge graph')) +
      route('sources', 'Source records', 'What was actually said') +
      route('setup', 'Set up Knowledge', done != null ? done + ' of 7 steps done' : 'Sources, owner, first index') + '</div>' +
      '<div class="mm-aside-note"><h3>' + (focus ? 'Related to: ' + esc(clip(rowTitle(focus), 80)) : 'Better context. Traceable learning.') + '</h3><p>Sources explain a memory. Relationships add context. Run evidence shows whether a change helped.</p>' +
      textBtn('back-learning', 'Back to recent learning') + '</div>';
  }
  function knowledgeReader(tab) {
    crumb(tab === 'graph' ? 'Ask the graph' : tab === 'sources' ? 'Source records' : 'Set up Knowledge');
    if (tab === 'sources') return syncCard() + sourcesHtml();
    if (tab === 'setup') { if (!S.setup && !S.setupLoading && !S.setupError) loadSetup(); return syncCard() + setupHtml(); }
    return '<div id="mm-ask">' + askHtml() + '</div>' + graphSectionHtml() +
      '<details class="mm-health"><summary>Knowledge status and maintenance</summary>' + syncCard() + dupsHtml() + '</details>';
  }
  // Ask the graph in plain words; the hybrid query the setup step uses. About a minute, two model calls under today's budget.
  function askHtml() {
    if (fileGraph()) return '<section class="cx-card mm-card"><h3 class="mm-card-title">Ask the graph</h3><p>Model answers need the advanced graph. Explore your document links below.</p></section>';
    var a = S.ask, focus = S.focus, nb = S.neighbors || [];
    var hint = !focus ? 'Ask about people, ideas, or how they connect' : nb.length ? 'Show me the relation between ' + focus + ' and ' + nb[0] : 'What does the graph know about ' + focus + '?';
    var tries = !a.busy && focus ? nb.slice(0, 3).map(function (n) { return '<li>' + textBtn('ask-pair', esc(focus) + ' and ' + esc(n), { arg: n }) + '</li>'; }).join('') : '';
    var parsed = a.answer ? parseAnswer(a.answer.answer) : null;
    return '<section class="cx-card mm-card mm-ask"' + (a.busy ? ' aria-busy="true"' : '') + '><div class="mm-card-head"><h3 class="mm-card-title">Ask the graph</h3><span class="mm-step-meta" data-role="ask-meta">' + (a.busy ? 'Working · ' + askSecs() + ' s' : 'About a minute') + '</span></div>' +
      '<p class="mm-muted">Ask about a person, an idea, or how things connect. COS picks the points and traces their connections.</p>' +
      '<form class="mm-inline" data-mm-form="ask"><input class="field" id="mm-ask-q" aria-label="Ask the graph" placeholder="' + esc(hint) + '" value="' + esc(a.q) + '"' + (a.busy ? ' disabled' : '') + ' maxlength="400" enterkeyhint="go">' +
      '<button type="submit" class="cx-btn primary"' + (a.busy ? ' disabled' : '') + '>' + (a.busy ? 'Asking…' : 'Ask') + '</button></form>' +
      (tries ? '<p class="mm-muted mm-try">Try the relation between</p><ul class="mm-tries">' + tries + '</ul>' : '') +
      (a.busy ? '<p class="mm-progress" role="status" aria-live="polite" data-role="ask-progress">' + esc(askBusyCopy(askSecs())) + '</p>' : '') +
      (a.message ? '<p class="mm-muted" role="status">' + esc(a.message) + '</p>' : '') +
      (a.error ? '<p class="mm-bad">' + esc(a.error) + '</p>' : '') +
      (parsed ? '<div class="mm-answer">' + renderMarkdown(parsed.prose) + '</div>' + refsHtml(parsed.refs) +
        '<p class="mm-muted">' + (a.answer.elapsed_s != null ? Math.round(a.answer.elapsed_s) + ' s · ' : '') + esc(a.answer.mode || 'hybrid') + ' mode · put together from the graph, not a quote</p>' +
        '<div class="mm-actions">' + btn('copy-ask', 'Copy answer') + btn('copy-ask', 'Copy with context', { arg: 'ctx' }) + '</div>' +
        (a.cardsBusy ? '<p class="cx-note">Looking up the people and ideas it names…</p>' : a.cards.length ? '<h4 class="mm-sub-title">In the graph</h4>' + a.cards.map(entityCard).join('') : '') : '') +
      '</section>';
  }
  function askSecs() { return S.ask.startedAt ? Math.max(0, Math.floor((Date.now() - S.ask.startedAt) / 1000)) : 0; }
  function askBusyCopy(s) { return (s < 8 ? 'Searching the graph' : s < 25 ? 'Choosing the relevant points' : 'Still working') + ' · ' + s + ' s · usually about a minute'; }
  // A safe Markdown subset for a model answer: escape first, then headings, bold, code, lists, pipe tables, paragraphs.
  function renderMarkdown(md) {
    var lines = esc(md || '').split('\n'), out = [], ul = null, table = null;
    function inline(s) { return s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'); }
    function flush() { if (ul) { out.push('<ul>' + ul.join('') + '</ul>'); ul = null; } if (table) { out.push(tableHtml(table)); table = null; } }
    // Duo tables: the first row is the header; the shared column floors (app.js tableFit) set how far each column shrinks.
    function tableHtml(rows) {
      var fit = W.tableFit(rows);
      return '<div class="mm-table tf-wrap"><table class="' + fit.tableClass + ' tf-grid">' + rows.map(function (cells, n) {
        var tag = n ? 'td' : 'th';
        return '<tr>' + cells.map(function (c, k) { var w = fit.width(k, !n); return '<' + tag + (w ? ' style="' + w + '"' : '') + '>' + fit.cell(k, inline(c), !n) + '</' + tag + '>'; }).join('') + '</tr>';
      }).join('') + '</table></div>';
    }
    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, '');
      if (!line.trim()) { flush(); return; }
      var h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { flush(); out.push('<h4>' + inline(h[2]) + '</h4>'); return; }
      var li = line.match(/^\s*[-*•]\s+(.*)$/);
      if (li) { if (table) flush(); ul = ul || []; ul.push('<li>' + inline(li[1]) + '</li>'); return; }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return;
        if (ul) flush();
        table = table || [];
        table.push(line.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); })); return;
      }
      flush(); out.push('<p>' + inline(line) + '</p>');
    });
    flush();
    return out.join('');
  }
  function parseAnswer(answer) {
    var text = String(answer || ''), marker = '\n\nEvidence references:\n', i = text.indexOf(marker), refs = [];
    if (i >= 0) text.slice(i + marker.length).split('\n').forEach(function (line) {
      var m = line.match(/^\[(S\d+)\]\s+(.*)$/); if (!m) return;
      var p = m[2].split(' · ');
      refs.push({ id: m[1], source: (p[0] || '').trim() || 'Original passage', date: (p[1] || '').trim() === 'date unknown' ? '' : (p[1] || '').trim(), status: p[3] || '' });
    });
    return { prose: i < 0 ? text : text.slice(0, i), refs: refs };
  }
  function refsHtml(refs) {
    if (!refs.length) return '';
    return '<div class="mm-refs"><h4 class="mm-sub-title">Sources</h4><ol>' + refs.map(function (r) {
      var meta = [r.date, r.status === 'source_unresolved' ? 'not linked to a meeting file' : ''].filter(Boolean).join(' · ');
      return '<li><span class="mm-ref">[' + esc(r.id) + ']</span> ' + esc(r.source) + (meta ? '<span class="mm-muted"> · ' + esc(meta) + '</span>' : '') + '</li>';
    }).join('') + '</ol></div>';
  }
  function entityCard(en) {
    var desc = (en.descriptions && en.descriptions.length ? en.descriptions[0] : en.description) || '';
    var rels = (en.edges || []).slice(0, 3).map(function (e) { var other = e.source === en.id ? e.target : e.source; return '<li><b>' + esc(other) + '</b> ' + esc(clip(e.description || '', 140)) + '</li>'; }).join('');
    return '<section class="mm-entity"><div class="mm-card-head"><h4>' + esc(en.id) + '</h4><span class="mm-step-meta">' + esc(en.type || 'entity') + ' · ' + fmt(en.degree || 0) + ' ' + plural(en.degree, 'connection', 'connections') + '</span></div>' +
      (desc ? '<p>' + esc(clip(String(desc).split('<SEP>')[0], 320)) + '</p>' : '<p class="mm-muted">No description stored.</p>') + (rels ? '<ul class="mm-rels">' + rels + '</ul>' : '') +
      '<div class="mm-actions">' + btn('copy-entity', 'Copy context', { id: en.id }) + btn('passages', 'Show passages', { id: en.id }) + btn('focus', 'Explore from here', { id: en.id }) + '</div></section>';
  }
  function entityText(en) {
    var desc = (en.descriptions && en.descriptions.length ? en.descriptions : (en.description ? [en.description] : [])).join('\n');
    var rels = (en.edges || []).slice(0, 6).map(function (e) { var other = e.source === en.id ? e.target : e.source; return '- ' + other + (e.description ? ': ' + e.description : ''); }).join('\n');
    return en.id + ' (' + (en.type || 'entity') + ', ' + fmt(en.degree || 0) + ' connections)\n' + desc + (rels ? '\nRelationships:\n' + rels : '');
  }
  function graphSectionHtml() {
    var full = S.graphFull;
    return '<section class="mm-graph' + (full ? ' full' : '') + '" id="mm-graph"' + (full ? ' role="dialog" aria-modal="true" aria-label="Your knowledge graph"' : '') + '>' +
      '<div class="mm-graph-head"><div class="mm-graph-text"><h3 class="mm-card-title">Your knowledge</h3><p class="mm-muted">' + (fileGraph() ? 'Your document links.' : 'Connected people and ideas from your meetings and notes.') +
      (S.graphVisible != null ? ' ' + fmt(S.graphVisible) + ' points in this view.' : '') + '</p></div>' +
      btn('graph-full', full ? 'Done' : 'Full screen', { cls: full ? 'primary' : 'quiet' }) + '</div>' +
      '<div id="mm-graph-host" class="mm-graph-host">' + (S.ws ? '' : S.kitError ? '<div class="mm-state"><strong>The graph explorer did not load.</strong><span>' + esc(S.kitError) + '</span><span class="mm-state-act">' + btn('graph-retry', 'Try again') + '</span></div>' : '<p class="cx-note mm-graph-wait">Loading the graph explorer…</p>') + '</div></section>';
  }
  function syncCard() {
    var g = S.graph;
    if (S.graphError) return '<section class="cx-card mm-card"><h3 class="mm-card-title">Sync</h3><p class="mm-bad">' + esc(S.graphError) + '</p><div class="mm-actions">' + btn('graph-status', 'Try again') + '</div></section>';
    if (!g) return '<section class="cx-card mm-card"><h3 class="mm-card-title">Sync</h3><p class="cx-note">Reading the graph\'s state…</p></section>';
    if (fileGraph()) return '<section class="cx-card mm-card"><h3 class="mm-card-title">Document links</h3><p>Documents you grant and your own links build this local graph. Links describe associations; they do not establish causes.</p><dl class="mm-grid"><dt>Indexed</dt><dd>' + fmt(g.entities || 0) + ' points · ' + fmt(g.relationships || 0) + ' links</dd><dt>Index</dt><dd>' + esc(indexWord(g.index_state)) + '</dd></dl><div class="mm-actions">' + btn('steward', 'Current sources and rules') + '</div></section>';
    var src = g.source || {}, q = g.queue || {}, b = g.budget || {}, lk = g.lock || {}, proc = g.processor || {};
    var ownerName = hostLabel(src.owner_host) || 'the owner Mac';
    var owner = src.owner_state === 'owner' ? 'This Mac builds the graph (' + esc(ownerName) + ').' : src.owner_state === 'replica' ? '<b>' + esc(ownerName) + '</b> builds the graph; this Mac reads a copy through iCloud.' : 'No Mac is set to build the graph yet. Set one in Set up Knowledge.';
    var pending = q.pending != null ? Number(q.pending) : 0;
    var indexing = proc.state === 'none' || !proc.state ? 'No scheduled indexing on this Mac' : proc.state === 'installed-idle' ? 'Scheduled, no run recorded yet' : 'Scheduled: ' + esc(proc.state);
    if (S.ingest && S.ingest.note) indexing += '<br><span class="mm-muted">' + esc(S.ingest.note) + '</span>';
    else if (lockHeld(lk)) indexing += '<br><span class="mm-muted">Indexing now</span>';
    var control = '';
    if (!S.ingest && !lockHeld(lk) && src.owner_state === 'owner' && pending > 0) {
      var sizes = [5, 10, 25, 50].filter(function (n) { return n < pending; });
      var opts = sizes.map(function (n) { return '<option value="' + n + '"' + (n === S.ingestLimit ? ' selected' : '') + '>' + n + '</option>'; }).join('');
      if (pending <= 50) opts += '<option value="' + pending + '"' + (sizes.indexOf(S.ingestLimit) < 0 ? ' selected' : '') + '>All ' + fmt(pending) + '</option>';
      control = '<div class="mm-inline mm-ingest"><label class="mm-pick"><span>Batch</span><select class="field" id="mm-ingest-limit" data-mm-change="ingest-limit" aria-label="How many to index">' + opts + '</select></label>' + btn('ingest', 'Index now', { cls: 'primary' }) + '</div>';
    }
    var queued = (q.pending != null ? fmt(q.pending) + ' waiting' : 'unknown') + (q.oldest_pending_at ? ' · oldest ' + esc(day(q.oldest_pending_at)) : '') + (q.missing_sources ? ' · ' + fmt(q.missing_sources) + ' sources missing' : '') + (q.conflict_copies ? ' · ' + fmt(q.conflict_copies) + ' iCloud conflict copies' : '');
    var indexed = (g.entities != null ? fmt(g.entities) + ' people and ideas' : 'no graph yet') + (g.relationships != null ? ' · ' + fmt(g.relationships) + ' connections' : '') + (g.source_updated_at ? ' · updated ' + esc(when(g.source_updated_at)) : '');
    var invite = g.index_state === 'missing' || g.index_state === 'stale';
    var build = S.building ? ' <span class="mm-muted">' + esc(S.building) + '</span>' : invite ? '<div class="mm-actions">' + btn('build-index', 'Build index (usually a few seconds)') + '</div>' : '';
    var captured = S.status && S.status.meetingLibraryCount != null ? fmt(S.status.meetingLibraryCount) + ' meetings in the library' : '';
    return '<section class="cx-card mm-card"><h3 class="mm-card-title">Sync</h3><p>' + owner + '</p><dl class="mm-grid">' +
      (captured ? '<dt>Captured</dt><dd>' + esc(captured) + '</dd>' : '') + '<dt>Queued</dt><dd>' + queued + '</dd><dt>Indexing</dt><dd>' + indexing + control + '</dd>' +
      '<dt>Indexed</dt><dd>' + indexed + '</dd><dt>Index</dt><dd>' + esc(indexWord(g.index_state)) + (g.index_built_at ? ' · built ' + esc(when(g.index_built_at)) : '') + (g.index_degraded ? ' · partly built' : '') + build + '</dd>' +
      '<dt>Budget</dt><dd>' + (b.used != null && b.cap != null ? fmt(b.used) + ' of ' + fmt(b.cap) + ' model calls today' : 'unknown') + '</dd></dl>' + progressHtml() +
      '<p class="cx-note">Values from this Mac.</p></section>';
  }
  function indexWord(s) { return s === 'fresh' ? 'Up to date' : s === 'stale' ? 'Out of date' : s === 'missing' ? 'Not built yet' : s === 'building' ? 'Building' : s || 'Unknown'; }
  function progressHtml() {
    var pr = S.progress, g = S.graph || {}, lk = (pr && pr.lock) || g.lock || {};
    if (!((pr && pr.running === true) || lockHeld(lk))) return '';
    if (!pr) return '<p class="mm-progress">Indexing now · reading progress…</p>';
    var head = pr.external ? 'Indexing now from another session · ' + fmt(pr.pending || 0) + ' waiting' :
      'Indexing ' + (pr.total != null ? fmt(Math.min(pr.done + pr.failed + (pr.current ? 1 : 0), pr.total)) + ' of ' + fmt(pr.total) : 'now') + ' · ' + fmt(pr.pending || 0) + ' waiting';
    var items = (pr.items || []).slice(-4).map(function (it) { return '<li class="' + (it.outcome === 'failed' ? 'mm-bad' : '') + '">' + esc((it.outcome === 'indexed' ? 'Indexed ' : it.outcome === 'failed' ? 'Failed ' : '') + String(it.id).split('/').pop()) + (it.seconds != null ? ' · ' + Math.round(it.seconds) + ' s' : '') + '</li>'; }).join('');
    return '<div class="mm-progress" aria-live="polite"><b>' + esc(head) + '</b>' + (items ? '<ul>' + items + '</ul>' : '') +
      (pr.budget ? '<span class="mm-muted">Budget: ' + fmt(pr.budget.used) + ' of ' + fmt(pr.budget.cap) + ' model calls today</span>' : '') +
      (pr.log_tail && pr.log_tail.length ? '<details><summary>Show log</summary><pre>' + esc(pr.log_tail.join('\n')) + '</pre></details>' : '') + '</div>';
  }
  function dupsHtml() {
    if (fileGraph()) return '';
    var d = S.dups, head = '<h3 class="mm-card-title">Possible duplicates</h3><p class="mm-muted">People whose names look like one person. Suggestions only.</p>';
    var again = '<div class="mm-actions">' + btn('dups', 'Scan again') + '</div>';
    if (d.error) return '<section class="cx-card mm-card">' + head + '<p class="mm-bad">' + esc(d.error) + '</p>' + again + '</section>';
    if (d.busy) return '<section class="cx-card mm-card">' + head + '<p class="cx-note">Scanning this Mac\'s index…</p></section>';
    if (!d.data) return '<section class="cx-card mm-card">' + head + '<p>Groups people whose names are variants of one another: a first name that matches one full name, a surname within two letters, one name spelling out the other. People the graph knows are different never share a group. Nothing merges on its own; each row opens the same two-step preview.</p><div class="mm-actions">' + btn('dups', 'Find possible duplicates') + '</div></section>';
    var groups = d.data.groups || [];
    if (!groups.length) return '<section class="cx-card mm-card">' + head + '<p>No name variants among ' + fmt(d.data.scanned || 0) + ' people' + (d.data.available === false ? ' (no index on this Mac yet)' : '') + '.</p>' + again + '</section>';
    return '<section class="cx-card mm-card">' + head + '<p>' + fmt(d.data.total_groups || groups.length) + ' ' + plural(d.data.total_groups || groups.length, 'group', 'groups') + ' among ' + fmt(d.data.scanned || 0) + ' people. Read both descriptions before merging.</p>' +
      groups.map(function (g) {
        var t = g.members[0] || {};
        return '<div class="mm-dup"><div class="mm-card-head"><b>' + esc(g.target) + '</b><span class="mm-step-meta">' + fmt(t.degree || 0) + ' connections · ' + esc(g.confidence) + ' confidence</span></div>' +
          g.members.slice(1).map(function (m) { return '<div class="mm-dup-member"><span><b>' + esc(m.id) + '</b> <span class="mm-muted">' + fmt(m.degree) + ' ' + plural(m.degree, 'connection', 'connections') + ' · ' + fmt(m.shared_neighbors) + ' shared' + (m.why ? ' · ' + esc(m.why) : '') + '</span></span>' + btn('merge-from', 'Preview merge', { id: m.id, arg: g.target }) + '</div>'; }).join('') + '</div>';
      }).join('') + again + '</section>';
  }
  function exploreTerm(e) { if (known(e.category) && e.category !== e.scope && e.category.indexOf(PRUNE_READY) !== 0) return e.category; return String(cleanTitle(e.title) || '').split(' ').slice(0, 4).join(' ') || 'COS'; }
  function sourcesHtml() {
    var focus = S.knowledgeFocus && findRow(S.knowledgeFocus), cards = [];
    if (focus) {
      ensureDetail(focus);
      var e = fullRow(focus);
      (e.source_refs || []).forEach(function (r, i) { cards.push({ title: storeName(r.kind) || 'Source', kind: '', text: r.excerpt || '', note: i === 0 ? 'The record this lesson came from.' : '' }); });
      var term = exploreTerm(e);
      if (!S.passages[term] && !S.loading['p:' + term]) {
        S.loading['p:' + term] = true;
        call('graph.passages', { entity: term, limit: 5 }).then(function (d) { S.passages[term] = d; }, function (er) { S.passages[term] = { _error: er.message }; }).then(function () { delete S.loading['p:' + term]; paint(); });
      }
      var p = S.passages[term];
      if (p && !p._error) (p.items || []).forEach(function (it) { var s = it.source || {}; cards.push({ title: s.title || 'Passage', kind: s.status === 'resolved' ? 'Meeting excerpt' : 'Passage, not linked to a file', text: it.excerpt, note: s.date || '' }); });
      else if (p && p._error) cards.push({ title: 'Passages', kind: 'Not available', text: p._error, note: '' });
      else cards.push({ title: 'Passages', kind: '', text: '', note: 'Reading passages about ' + term + '…' });
    } else {
      cards = S.recent.rows.slice(0, 8).filter(function (e) { return (e.source_refs || []).some(function (r) { return r.excerpt; }); }).map(function (e) {
        var r = e.source_refs.filter(function (x) { return x.excerpt; })[0];
        return { title: rowTitle(e), kind: storeName(r.kind), text: r.excerpt, note: when(e.ts), event: e.event_id };
      });
    }
    return readerHead('The context behind the lesson.', 'Open the original evidence before reusing an interpretation.' + (focus ? ' For: ' + esc(clip(rowTitle(focus), 80)) : '')) +
      (cards.length ? cards.map(function (x) {
        return '<article class="cx-card mm-card"><div class="mm-card-head"><h3 class="mm-card-title">' + esc(clip(x.title, 140)) + '</h3>' + (x.kind ? '<span class="mm-step-meta">' + esc(x.kind) + '</span>' : '') + '</div>' +
          (x.text ? quote(x.text) : '') + (x.note ? '<p class="mm-muted">' + esc(x.note) + '</p>' : '') + (x.event ? '<div class="mm-actions">' + btn('open-e', 'Inspect learning', { id: x.event }) + '</div>' : '') + '</article>';
      }).join('') : '<div class="mm-reader-state"><strong>No source records yet.</strong><span>Your first saved lesson brings its source here.</span></div>');
  }

  // ── Set up Knowledge: seven steps, each a live check with its own control ──
  function loadSetup() {
    if (fileGraph()) { S.setup = { engine: 'explicit_document_links' }; paint(); return Promise.resolve(); }
    S.setupLoading = true; S.setupError = ''; paint();
    return call('graph.setup').then(function (d) { S.setup = d; }, function (e) { S.setupError = e.message; })
      .then(function () { S.setupLoading = false; paint(); });
  }
  function setupAction(name, op, args, onDone) {
    if (S.setupBusy) return Promise.resolve();
    S.setupBusy = name; S.armed = ''; paint();
    return call(op, args).then(function (d) { S.setupBusy = ''; if (onDone) onDone(d); return loadSetup(); },
      function (e) { S.setupBusy = ''; W.toast(e.message); paint(); });
  }
  function setupStep(n, done, title, body, blocked) {
    return '<li class="mm-setup-step' + (done ? ' done' : blocked ? ' blocked' : '') + '"><span class="mm-setup-mark" aria-hidden="true">' + (done ? '✓' : n) + '</span>' +
      '<div class="mm-setup-body"><h4>' + title + (done ? '<span class="sr-only"> (done)</span>' : '') + '</h4>' + body + '</div></li>';
  }
  function shortPath(p) { return String(p || '').replace(/^\/Users\/[^/]+/, '~'); }
  function setupHtml() {
    if (fileGraph()) return '<section class="cx-card mm-card"><h3 class="mm-card-title">Set up document links</h3><p>This setup indexes Markdown and text documents the owner grants on the Mac. Write links as [[Document title]] to connect ideas. Model extraction and embeddings are not set up here; keyword search and document links work.</p><div class="mm-actions">' + btn('steward', 'Current sources and rules') + '</div></section>';
    var s = S.setup;
    if (S.setupError) return '<section class="cx-card mm-card"><h3 class="mm-card-title">Set up Knowledge</h3><p class="mm-bad">' + esc(S.setupError) + '</p><div class="mm-actions">' + btn('setup-refresh', 'Try again') + '</div></section>';
    if (!s) return '<section class="cx-card mm-card"><h3 class="mm-card-title">Set up Knowledge</h3><p class="cx-note">Checking this Mac…</p></section>';
    var checks = s.checks || [], checksOk = checks.length > 0 && checks.every(function (c) { return c.ok; });
    var sources = s.sources || [], withFiles = sources.filter(function (r) { return r.enabled && r.exists && (r.files || 0) > 0; });
    var owner = s.owner || {}, isOwner = owner.is_owner === true, budget = s.budget || {}, sample = s.sample || {}, cands = sample.candidates || [];
    var graphN = (s.graph || {}).entities, hasGraph = graphN != null && graphN > 0, sched = s.schedule || {}, held = lockHeld(s.lock);
    var busy = !!S.setupBusy, emb = s.embedding || {}, ext = s.extraction || {};
    var budgetOk = budget.used != null && budget.cap != null && budget.used < budget.cap, embNotReady = emb.ready === false;
    var steps = [];
    steps.push(setupStep(1, checksOk, 'Turn on Knowledge', '<p>What indexing needs on this Mac.</p><ul class="mm-checks">' + checks.map(function (c) { return '<li class="' + (c.ok ? 'ok' : 'mm-bad') + '"><span aria-hidden="true">' + (c.ok ? '✓' : '!') + '</span> ' + esc(c.detail) + '</li>'; }).join('') + '</ul>', checks.length && !checksOk));
    steps.push(setupStep(2, withFiles.length > 0, 'Choose sources', '<p>Folders of notes or documents (Markdown and text). Only files in these folders are read.</p>' +
      (sources.length ? '<ul class="mm-sources">' + sources.map(function (r) {
        return '<li><code>' + esc(shortPath(r.path)) + '</code><span class="mm-muted">' + (r.exists ? (r.files != null ? fmt(r.files) + ' ' + plural(r.files, 'document', 'documents') : '') : 'missing') + '</span>' +
          btn('source-toggle', r.enabled ? 'On' : 'Off', { arg: r.path, disabled: busy }) + btn('source-remove', S.armed === 'remove:' + r.path ? 'Tap again to remove' : 'Remove', { arg: r.path, disabled: busy }) + '</li>';
      }).join('') + '</ul>' : '') +
      '<form class="mm-inline" data-mm-form="folder"><input class="field" id="mm-folder" aria-label="Folder path on your Mac" placeholder="Folder path on your Mac, like ~/Documents/Notes" value="' + esc(S.folderDraft) + '" autocomplete="off" autocapitalize="off" spellcheck="false">' +
      '<button type="submit" class="cx-btn"' + (busy ? ' disabled' : '') + '>' + (S.setupBusy === 'add' ? 'Adding…' : 'Add folder') + '</button></form>' +
      (sources.length && !withFiles.length ? '<p class="mm-muted">No documents found in the folders that are on.</p>' : '')));
    var ownerBody = isOwner ? '<p>This Mac (' + esc(hostLabel(owner.this_host)) + ') indexes the queue. Its graph, queue and sources stay here.</p>' :
      owner.owner_host ? '<p><b>' + esc(hostLabel(owner.owner_host)) + '</b> indexes the queue; this Mac reads a copy. Make this Mac the owner only if that Mac stops indexing.</p>' : '<p>No Mac is set to index yet.</p>';
    if (!isOwner) ownerBody += '<div class="mm-actions">' + btn('claim-owner', S.armed === 'owner' ? 'Tap again to make this Mac the owner' : S.setupBusy === 'owner' ? 'Setting…' : 'Make this Mac the owner', { disabled: busy }) + '</div>';
    steps.push(setupStep(3, isOwner, 'Owner Mac', ownerBody));
    var exe = ext.execution || {};
    steps.push(setupStep(4, checksOk && budgetOk && !emb.mismatch && !embNotReady, 'Choose how it indexes',
      '<p>Extraction quality for the next run. Runs with: ' + esc([exe.provider, exe.requested_model, exe.reasoning_effort].filter(Boolean).join(' · ') || 'not reported by this server') + '.</p>' + extractionCards(ext, busy) +
      '<p>Embeddings for search: one choice for the knowledge graph and every meeting index. A graph keeps the embedding it was built with.</p>' + localOnlyStrip(emb, busy) + embeddingCards(emb, busy) +
      '<p class="mm-muted">Budget today: ' + (budget.used != null ? fmt(budget.used) + ' of ' + fmt(budget.cap) + ' model calls' : 'unknown') + (budgetOk ? '' : ' (used up until tomorrow)') + '.</p>' +
      '<p class="mm-muted">What leaves this Mac: each document\'s text goes to the model for extraction' + (emb.kind === 'local' ? '; embeddings are made on this Mac' : ' and to OpenAI for embeddings') + '. The graph, the queue and this folder list never leave it.</p>', emb.mismatch || embNotReady));
    var sampleDone = (sample.indexed || 0) >= 1 || hasGraph;
    var sb = sampleDone ? '<p>' + ((sample.indexed || 0) >= 1 ? fmt(sample.indexed) + ' sample ' + plural(sample.indexed, 'document', 'documents') + ' indexed.' : 'Your graph already holds ' + fmt(graphN) + ' people and ideas.') + '</p>' : '<p>The three newest documents from the folders that are on, through the same checks a meeting gets, in one bounded run.</p>';
    if (cands.length) sb += '<ul class="mm-sources">' + cands.map(function (c) { return '<li><code>' + esc(String(c.path).split('/').pop()) + '</code><span class="mm-muted">' + (c.bytes != null ? fmt(Math.max(1, Math.round(c.bytes / 1024))) + ' KB' : '') + '</span></li>'; }).join('') + '</ul>';
    if (S.ingest && S.ingest.note) sb += '<p class="mm-muted">' + esc(S.ingest.note) + '</p>'; else if (held) sb += progressHtml();
    if ((sample.queued || 0) > 0 && !held) sb += '<p class="mm-muted">' + fmt(sample.queued) + ' queued and waiting for a run.</p>';
    if (cands.length && isOwner && !held) sb += '<div class="mm-actions">' + btn('index-sample', S.setupBusy === 'sample' ? 'Queueing…' : 'Index ' + (cands.length === 1 ? 'this document' : 'these ' + cands.length), { disabled: busy || !checksOk || embNotReady }) + '</div>' + (embNotReady ? '<p class="mm-muted">Blocked: ' + esc(emb.label || emb.provider) + ' is not ready. ' + esc(emb.fix || '') + '</p>' : '');
    else if (cands.length && !isOwner) sb += '<p class="mm-muted">Indexing runs on the owner Mac.</p>';
    steps.push(setupStep(5, sampleDone, 'Index three sample documents', sb, !checksOk));
    steps.push(setupStep(6, !!S.ask.answer, 'Ask one question', '<p>One question, answered from the graph. About a minute; two model calls under today\'s budget.</p>' +
      (s.ask_ready ? '<p>' + btn('ktab', 'Ask the graph', { arg: 'graph' }) + '</p>' : '<p class="mm-muted">Index something first.</p>') +
      (S.ask.answer ? '<div class="mm-answer">' + renderMarkdown(parseAnswer(S.ask.answer.answer).prose) + '</div>' : ''), !s.ask_ready));
    var schedBody = sched.installed ? '<p>On: up to 4 queued documents every ' + (sched.interval_s ? fmt(Math.round(sched.interval_s / 60)) + ' minutes' : 'interval') + '.</p>' : '<p>Off. Turn it on and this Mac indexes what is queued on a schedule, 4 at a time, under the daily budget.</p>';
    if (isOwner) schedBody += sched.installed ? '<div class="mm-actions">' + btn('schedule', S.setupBusy === 'schedule' ? 'Working…' : 'Turn off', { arg: 'off', disabled: busy }) + '</div>' :
      '<div class="mm-inline"><label class="mm-pick"><span>How often</span><select class="field" id="mm-schedule"><option value="900">Every 15 minutes</option><option value="3600" selected>Every hour</option><option value="14400">Every 4 hours</option><option value="86400">Once a day</option></select></label>' + btn('schedule', S.setupBusy === 'schedule' ? 'Working…' : 'Turn on', { arg: 'on', disabled: busy }) + '</div>';
    else schedBody += '<p class="mm-muted">Schedules live on the owner Mac.</p>';
    steps.push(setupStep(7, sched.installed === true, 'Scheduled batches', schedBody));
    var done = setupDone();
    return '<section class="cx-card mm-card"><div class="mm-card-head"><h3 class="mm-card-title">Set up Knowledge</h3><span class="mm-step-meta">' + done + ' of 7 done' + (S.setupLoading ? ' · refreshing' : '') + '</span></div>' +
      '<p class="mm-muted">From nothing to a first index on this Mac. Each step is a live check; do them in order.</p><ol class="mm-setup">' + steps.join('') + '</ol>' +
      '<div class="mm-actions">' + btn('setup-refresh', 'Refresh checks') + btn('ktab', 'Source records', { arg: 'sources' }) + '</div></section>';
  }
  function extractionCards(ext, busy) {
    var tiers = ext.tiers || [];
    if (!tiers.length) return '<p class="mm-muted">Indexing tiers need a newer server.</p>';
    return '<div class="mm-picks" role="radiogroup" aria-label="Extraction quality">' + tiers.map(function (t) {
      return '<label class="mm-pick-card' + (t.selected ? ' on' : '') + '"><input type="radio" name="mm-tier" data-mm-change="tier" value="' + esc(t.id) + '"' + (t.selected ? ' checked' : '') + (busy ? ' disabled' : '') + '><span><b>' + esc(t.label) + '</b><span class="mm-muted">' + esc(t.detail) + '</span></span></label>';
    }).join('') + '</div>';
  }
  // One question the person answers (may text leave this Mac), one fact detected (an OpenAI key), and Ollama running
  // picks premium over light. The answer moves the Recommended mark, never the choice.
  function localOnlyStrip(emb, busy) {
    if (!emb.preference) return '<p class="mm-muted">The recommendation needs a newer server.</p>';
    var v = emb.preference.local_only, rec = emb.recommended || null;
    return '<div class="mm-inline mm-ask-strip"><span>May your text leave this Mac for embeddings?</span><span class="cx-switch">' +
      '<button type="button" data-mm="local-only" data-arg="0" aria-pressed="' + (v === false) + '"' + (busy ? ' disabled' : '') + '>Cloud is fine</button>' +
      '<button type="button" data-mm="local-only" data-arg="1" aria-pressed="' + (v === true) + '"' + (busy ? ' disabled' : '') + '>Stays on this Mac</button></span></div>' +
      (rec ? '<p class="mm-muted"><b>Recommended: ' + esc(rec.label) + '.</b> ' + esc(rec.reason) + '</p>' : '');
  }
  function embeddingCards(emb, busy) {
    var rows = emb.providers || [];
    if (!rows.length) return '<p class="mm-muted">Embedding choices need a newer server.</p>';
    var fetch = emb.fetch || null, recId = emb.recommended ? emb.recommended.id : null;
    var cards = rows.map(function (r) {
      var canPick = !emb.locked || r.selected, fetching = fetch && fetch.state === 'running' && fetch.provider === r.id, failed = fetch && fetch.state === 'failed' && fetch.provider === r.id;
      var offline = r.id === 'ollama' && /not running/.test(r.detail || '');
      return '<label class="mm-pick-card' + (r.selected ? ' on' : '') + (canPick ? '' : ' off') + '"><input type="radio" name="mm-emb" data-mm-change="embedding" value="' + esc(r.id) + '"' + (r.selected ? ' checked' : '') + (canPick && !busy ? '' : ' disabled') + '>' +
        '<span><b>' + esc(r.label) + '</b>' + (r.id === recId ? ' <span class="cx-cap gold">Recommended</span>' : '') + '<span class="mm-muted">' + esc(r.model) + (r.dimensions != null ? ' · ' + fmt(r.dimensions) + ' dims' : '') + ' · ' + esc(r.cost) + '</span>' +
        '<span class="' + (r.ready ? 'mm-ok' : 'mm-muted') + '">' + (r.ready ? '✓ ' : '') + esc(r.detail) + '</span>' + (r.selected && !r.ready && r.fix ? '<span class="mm-bad">' + esc(r.fix) + '</span>' : '') +
        (fetching ? '<span class="mm-muted">Fetching ' + esc(fetch.model) + '… this refreshes as it runs.</span>' : failed ? '<span class="mm-bad">Fetch failed: ' + esc(fetch.error || 'unknown') + '</span>' : '') +
        (r.kind === 'local' && !r.ready && !offline ? btn('fetch-model', fetching ? 'Fetching…' : 'Fetch model', { arg: r.id, disabled: busy || fetching }) : '') + '</span></label>';
    }).join('');
    var note = '';
    if (emb.mismatch && emb.manifest) note = '<p class="mm-bad">This graph was built with ' + esc(emb.manifest.provider) + ' (' + esc(emb.manifest.model) + ') but ' + esc(emb.provider) + ' is chosen. Choose the one it was built with; Index now is blocked until then.</p>';
    else if (emb.locked) note = '<p class="mm-muted">This graph was built with ' + esc(emb.label || emb.provider) + '. Changing it means rebuilding the graph, which is not available yet.</p>';
    else if (emb.ready === false) note = '<p class="mm-bad">' + esc(emb.label || emb.provider) + ' is chosen but not ready on this Mac. ' + esc(emb.fix || '') + ' Indexing waits until then.</p>';
    return '<div class="mm-picks" role="radiogroup" aria-label="Embeddings">' + cards + '</div>' + note;
  }

  // ── sheets: Copy context, activity log, Memory settings, stewardship, passages, merge ──
  function openModal(kind, extra) { S.modal = Object.assign({ kind: kind }, extra || {}); paintModal(true); }
  function closeModal() {
    var m = S.modal; if (!m) return;
    if (m.kind === 'merge' && S.merge && (S.merge.phase === 'preview' || S.merge.phase === 'loading')) { var pend = S.merge; S.merge = null; if (pend.resolve) pend.resolve(false); W.toast('Nothing was changed.'); }
    if (m.kind === 'steward') S.steward.serial++;
    S.modal = null; paintModal(); if (m.opener && m.opener.focus) { try { m.opener.focus({ preventScroll: true }); } catch (_e) {} }
  }
  function modalHtml() {
    var m = S.modal; if (!m) return '';
    var body = m.kind === 'copy' ? copyBody() : m.kind === 'log' ? logBody() : m.kind === 'settings' ? settingsBody() : m.kind === 'steward' ? stewardBody() :
      m.kind === 'passages' ? passagesBody(m) : m.kind === 'merge' ? mergeBody() : '';
    var title = m.kind === 'copy' ? 'Copy context' : m.kind === 'log' ? 'Recent learning activity' : m.kind === 'settings' ? 'Memory settings' : m.kind === 'steward' ? 'Rules, sources and outcome evidence' :
      m.kind === 'passages' ? 'Passages about ' + m.id : m.kind === 'merge' && S.merge ? 'Merge ' + S.merge.source + ' into ' + S.merge.target : '';
    return '<div class="mm-backdrop' + (m.entered ? '' : ' mm-enter') + '" data-mm="modal-backdrop"><section class="mm-modal" role="dialog" aria-modal="true" aria-labelledby="mm-modal-title">' +
      '<div class="mm-modal-head"><h2 id="mm-modal-title">' + esc(title) + '</h2><button type="button" class="cx-btn quiet" data-mm="modal-close">Close</button></div>' +
      '<div class="mm-modal-body">' + body + '</div></section></div>';
  }
  // Copy context: the exact text, quoted and labelled with its id (the data-not-instructions contract the glasses use).
  function contextText(e, o) {
    var x = fullRow(e), d = x.detail || {};
    var lines = ['Learning ' + x.event_id + ' (' + kindLabel(x) + ' · ' + (x.scope || '') + ' · ' + (x.ts || '') + ')', '', '"""', x.title || ''];
    if (d.before) lines.push('Before: ' + d.before); if (d.after) lines.push('After: ' + d.after); if (d.rule) lines.push('Rule: ' + d.rule);
    if (d.content) lines.push(d.content); (d.bodies || []).forEach(function (b) { lines.push(b); });
    if (isMemoryLesson(x) && memText(x.lesson_id) && !d.content) lines.push(S.memDetail[x.lesson_id].content || S.memDetail[x.lesson_id].summary);
    lines.push('"""');
    if (o.sources && (x.source_refs || []).length) { lines.push('', 'Sources:'); x.source_refs.forEach(function (r) { lines.push('- ' + (r.kind || '') + ' ' + (r.id || '') + (r.excerpt ? ': ' + r.excerpt : '')); }); }
    var oc = outcomeText(x); if (oc) lines.push('', 'Checked: ' + oc);
    if (o.graph) lines.push('', 'Related knowledge: open the entity in Knowledge and use its Copy context for descriptions and relationships.');
    return lines.join('\n');
  }
  function copyBody() {
    var e = findRow(S.copyId); if (!e) return '<p>This item is no longer in the list.</p>';
    return '<p>Check the exact text, then copy it. Sources are included unless you turn them off.</p>' +
      '<div class="mm-checkrow"><label class="cx-check"><input type="checkbox" data-mm-change="copy-opt" data-arg="sources"' + (S.copyOpts.sources ? ' checked' : '') + '> Include sources</label>' +
      '<label class="cx-check"><input type="checkbox" data-mm-change="copy-opt" data-arg="graph"' + (S.copyOpts.graph ? ' checked' : '') + '> Include a related-knowledge note</label></div>' +
      '<textarea class="field mm-preview" id="mm-copy-preview" readonly aria-label="Text to copy">' + esc(contextText(e, S.copyOpts)) + '</textarea>' +
      '<div class="mm-actions">' + btn('copy-now', 'Copy', { cls: 'primary' }) + btn('copy-select', 'Select text') + '</div>' +
      '<p class="cx-note">Quoted and labelled with its id, so whatever reads it treats it as data, not instructions.</p>';
  }
  function logBody() {
    var ls = S.recent.info || {}, counts = ls.counts_by_type || {}, cap = 10, A = S.applied;
    if (!A.loaded && !A.loading) loadApplied(false);
    var used = A.rows, total = Math.max(A.total != null ? Number(A.total) : 0, used.length), label = A.days === 90 ? 'in 90 days' : 'this week';
    var usedRows = used.slice(0, cap).map(function (e) { return '<li><b>' + esc(clip(memText(e.lesson_id) || (S.loading['m:' + e.lesson_id] ? 'Reading the lesson…' : 'Lesson'), 90)) + '</b><span class="mm-muted">' + esc(clip(appliedExcerpt(e), 110) || 'used by a later answer') + '</span></li>'; }).join('');
    var stores = Object.keys(ls.stores || {}).map(function (k) { var st = ls.stores[k]; return '<li><b>' + esc(storeName(k)) + '</b><span class="mm-muted">' + (st.readable || st.state === 'legacy' ? 'Readable · ' + fmt(st.count || 0) + (st.last_ts ? ' · last ' + esc(when(st.last_ts)) : '') : 'Not readable right now') + '</span></li>'; }).join('');
    return '<p>' + esc(ls.notice || ('Snapshot from ' + when(ls.generated_at) + '. Window: ' + when(ls.window_start) + ' to ' + when(ls.window_end) + '. ' + (ls.complete ? 'Every store answered.' : 'Some stores answered only in part.'))) + '</p>' +
      '<h3 class="mm-sub-title">Applied ' + label + '</h3>' + (!A.loaded ? '<p class="cx-note">Reading which lessons were used…</p>' : used.length ? '<ul class="mm-log">' + usedRows + '</ul>' + (total > cap ? '<p class="mm-muted">and ' + fmt(total - cap) + ' more in Applied ' + label + '.</p>' : '') : '<p class="mm-muted">' + esc(appliedEmpty().h) + '</p>') +
      '<h3 class="mm-sub-title">Event counts</h3>' + (Object.keys(counts).length ? '<ul class="mm-log">' + Object.keys(counts).sort().map(function (k) { return '<li><b>' + esc(KIND[k] || k) + '</b><span class="mm-muted">' + fmt(counts[k]) + ' in the window</span></li>'; }).join('') + '</ul>' : '<p class="mm-muted">No events counted.</p>') +
      (stores ? '<h3 class="mm-sub-title">Where they come from</h3><ul class="mm-log">' + stores + '</ul>' : '');
  }
  function loadSettings() { loadPolicy(); loadGuard(); loadOwner(); }
  function loadOwner() {
    if (S.ownerBusy) return; var serial = nextSerial('owner'); S.ownerError = '';
    call('profile.owner', {}).then(function (d) { if (serial !== serials.owner) return; S.owner = d; if (S.drafts.owner == null) S.drafts.owner = d.owner_name || ''; },
      function (e) { if (serial !== serials.owner) return; S.ownerError = e.message; }).then(function () { paintModal(); });
  }
  function loadPolicy() {
    if (S.policyLoading || S.policyBusy) return; S.policyLoading = true; var serial = nextSerial('policy');
    call('workspace.request', { action: 'policy_get' }).then(function (d) { if (serial !== serials.policy) return; S.policy = d; S.policyError = ''; },
      function (e) { if (serial !== serials.policy) return; S.policyError = e.message; }).then(function () { S.policyLoading = false; paintModal(); });
  }
  function loadGuard() {
    if (S.guardLoading) return; S.guardLoading = true;
    call('memory.guardrails').then(function (d) { S.guard = d.guardrails; S.guardLines = d.philosophy_rubric_lines; S.guardError = ''; },
      function (e) { S.guardError = e.message; }).then(function () { S.guardLoading = false; paintModal(); });
  }
  function readOnlyWords(st) { return st === 'adoption_required' || st === 'not_initialized' ? 'the memory workspace on your Mac is not set up yet.' : 'your Mac did not allow changes right now.'; }
  function settingsBody() {
    var s = S.status || {}, d = S.policy, p = d && d.policy;
    var name = S.drafts.owner != null ? S.drafts.owner : (S.owner && S.owner.owner_name) || '';
    var owner = '<section class="mm-set"><h3 class="mm-sub-title">Who is COS for?</h3><p class="mm-muted">Your name personalizes COS and where the graph starts. It does not change which Mac indexes or who owns the memory.</p>' +
      '<form class="mm-inline" data-mm-form="owner"><input class="field" id="mm-owner" data-draft="owner" aria-label="Your name" placeholder="Your full name" maxlength="120" value="' + esc(name) + '">' +
      '<button type="submit" class="cx-btn"' + (!S.owner || S.ownerBusy ? ' disabled' : '') + '>' + (S.ownerBusy ? 'Saving…' : 'Save name') + '</button></form>' +
      (S.ownerError ? '<p class="mm-bad">' + esc(S.ownerError) + '</p>' + btn('owner-retry', 'Try again') : '') + '</section>';
    function row(key, title, sub) {
      var on = !!(p && p[key]), dis = !d || !d.writable || S.policyBusy || !!S.policyIntent;
      return '<div class="cx-set-row"><span class="cx-set-text"><span class="cx-set-name">' + esc(title) + '</span><span class="cx-set-desc">' + esc(sub) + '</span></span>' +
        '<button type="button" class="switch" role="switch" aria-checked="' + on + '" aria-label="' + esc(title) + '" data-mm="policy" data-arg="' + key + '"' + (dis ? ' disabled' : '') + '></button></div>';
    }
    var policy = p ? '<div class="cx-list">' + row('capture_enabled', 'Capture completed sessions', 'Pausing affects new automatic captures. What COS already knows stays readable.') +
      row('review_required', 'Review new memories before recall', 'New memories wait for your acceptance. Accepted memories stay active.') + '</div>' +
      (d && !d.writable ? '<p class="mm-muted">Read-only: ' + esc(readOnlyWords(d.state)) + '</p>' : '<p class="mm-muted">Only the owner can change these. Skill changes need a reviewed, checked version.</p>') :
      S.policyError ? '' : '<p class="cx-note">Reading your memory settings…</p>';
    if (S.policyError) policy += '<p class="mm-bad">' + esc(S.policyError) + '</p>' + btn(S.policyIntent ? 'policy-retry' : 'policy-load', 'Try again');
    var tier = s.contextScriptsDirectory ? 'Advanced search (memory store and files)' : s.contextFilesDirectory ? 'Plain files' : 'Not set up';
    return owner + '<section class="mm-set"><h3 class="mm-sub-title">Capture and recall</h3><p class="mm-muted">Recall treats source text as evidence, never as instructions.</p>' + policy + '</section>' +
      '<section class="mm-set"><div class="mm-actions">' + btn('steward', 'Rules, current sources and outcome evidence') + '</div>' +
      '<p class="mm-muted">Where memory is stored: ' + esc(tier) + '.</p></section>' + guardHtml();
  }
  function guardHtml() {
    var g = S.guard, busy = S.guardBusy, dr = S.drafts;
    if (S.guardError) return '<section class="mm-set"><h3 class="mm-sub-title">Guardrails</h3><p class="mm-bad">' + esc(S.guardError) + '</p>' + btn('guard-load', 'Try again') + '</section>';
    if (!g) return '<section class="mm-set"><h3 class="mm-sub-title">Guardrails</h3><p class="cx-note">Reading your guardrails…</p></section>';
    var llm = g.llm_review || {}, run = S.guardRun, v = run ? run.verdicts || [] : [];
    var flagged = v.filter(function (x) { return x.verdict === 'prune'; }), review = v.filter(function (x) { return x.verdict === 'review'; });
    function val(k, fallback) { return dr['g.' + k] != null ? dr['g.' + k] : fallback; }
    function num(k, label, min, max, stepv, value) { return '<label class="mm-pick"><span>' + label + '</span><input class="field mm-num" type="number" id="mm-g-' + k + '" data-draft="g.' + k + '" min="' + min + '" max="' + max + '"' + (stepv ? ' step="' + stepv + '"' : '') + ' value="' + esc(val(k, value)) + '" inputmode="decimal"></label>'; }
    return '<section class="mm-set"><h3 class="mm-sub-title">Guardrails</h3><p class="mm-muted">What a captured memory must be to stay. The same rules refuse nonsense when it is captured; a run applies them to what already landed.</p>' +
      '<div class="mm-inline mm-wrap">' + num('min_words', 'Fewest words', 0, 200, '', g.min_words) + num('min_distinct_chars', 'Fewest different letters', 0, 100, '', g.min_distinct_chars) + num('max_repeat_ratio', 'Most repetition', 0.1, 1, 0.05, g.max_repeat_ratio) + '</div>' +
      '<label class="mm-pick mm-block"><span>Banned patterns, one per line (regular expressions)</span><textarea class="field" id="mm-g-banned" data-draft="g.banned" rows="3">' + esc(val('banned', (g.banned_patterns || []).join('\n'))) + '</textarea></label>' +
      (llm.supported === false ? '<p class="mm-muted">This setup applies fixed admission rules. A model review is not set up.</p>' :
        '<label class="cx-check mm-block"><input type="checkbox" id="mm-g-llm" data-draft="g.llm"' + ((dr['g.llm'] != null ? dr['g.llm'] : llm.enabled) ? ' checked' : '') + '> Also check against the COS philosophy with a model (' + fmt(S.guardLines || 0) + ' principles)</label>' +
        '<div class="mm-inline mm-wrap"><label class="mm-pick"><span>Model</span><select class="field" id="mm-g-model" data-draft="g.model">' + ['haiku', 'sonnet', 'opus'].map(function (m) { return '<option value="' + m + '"' + (val('model', llm.model) === m ? ' selected' : '') + '>' + ({ haiku: 'Fast (Haiku)', sonnet: 'Balanced (Sonnet)', opus: 'Deep (Opus)' })[m] + '</option>'; }).join('') + '</select></label>' +
        num('max', 'At most per run', 1, 100, '', llm.max_per_run || 20) + '</div><p class="mm-muted">The model check makes one bounded request per memory it reviews and stops at the cap. Off by default.</p>') +
      '<div class="mm-actions">' + btn('guard-save', busy === 'save' ? 'Saving…' : 'Save guardrails', { disabled: !!busy, cls: 'primary' }) + btn('guard-run', busy === 'run' ? 'Reviewing…' : 'Review captured memories now', { disabled: !!busy }) +
      (flagged.length && run && !run.run.applied ? btn('guard-apply', busy === 'apply' ? 'Quarantining…' : S.armed === 'guard-apply' ? 'Tap again to quarantine matches' : 'Review the next batch and quarantine matches', { disabled: !!busy }) : '') + '</div>' +
      (run ? '<p class="mm-muted">Last run: ' + fmt(run.run.scanned) + ' checked in ' + fmt(run.run.days) + ' days, ' + fmt(run.run.flagged) + ' flagged, ' + fmt(run.run.kept) + ' kept' + (run.run.review ? ', ' + fmt(run.run.review) + ' for you' : '') + (run.run.llm_reviewed ? ', ' + fmt(run.run.llm_reviewed) + ' judged by the model' : '') + (run.run.applied ? ', ' + fmt(run.run.pruned) + ' quarantined' : '') + (run.run.coverage ? ', ' + fmt(run.run.coverage.remaining_after_page) + ' left in this pass' : '') + '.</p>' +
        '<ul class="mm-log">' + flagged.concat(review).slice(0, 60).map(function (x) { return '<li><b class="' + (x.verdict === 'prune' ? 'mm-bad' : '') + '">' + (x.verdict === 'prune' ? (x.applied ? 'Quarantined' : 'Would quarantine') : 'For you') + '</b> <span>' + esc(clip(x.excerpt || x.id, 160)) + '</span><span class="mm-muted">' + esc((x.reasons || []).join('; ')) + (x.by === 'model' ? ' (model)' : '') + '</span></li>'; }).join('') + '</ul>' : '') + '</section>';
  }
  // Stewardship (memories/memory-stewardship.js, ported): standing rules, current sources and outcome evidence.
  function stewardLoad(more) {
    var T = S.steward; if (T.busy) return;
    T.busy = true; T.error = ''; var serial = ++T.serial;
    var action = T.tab === 'rules' ? 'rule_page' : T.tab === 'sources' ? 'source_status' : 'trace_summary', body = { action: action };
    if (action === 'rule_page') { body.limit = 25; body.cursor = more ? T.cursor : null; }
    paintModal();
    call('workspace.request', body).then(function (d) {
      if (serial !== T.serial) return;
      if (action === 'trace_summary') T.outcomes = d; else { T.rows = more ? T.rows.concat(d.items || []) : d.items || []; T.cursor = d.next_cursor || null; }
    }, function (e) { if (serial !== T.serial) return; T.error = e.message; }).then(function () { if (serial === T.serial) T.busy = false; paintModal(); });
  }
  function stewardMutate(body) {
    var T = S.steward; if (T.busy) return;
    if (T.intent && body !== T.intent) { T.error = 'Retry the pending action before starting another.'; paintModal(); return; }
    if (!T.intent) T.intent = JSON.parse(JSON.stringify(body));
    T.busy = true; T.error = ''; paintModal();
    call('workspace.request', T.intent).then(function (d) { T.busy = false; T.intent = null; W.toast(d.status ? 'Saved: ' + d.status : 'Saved'); stewardLoad(false); },
      function (e) {
        T.busy = false; var c = codeOf(e);
        T.error = /evaluation_not_found/.test(c) ? 'No passing check was found for this id. The rule stays in shadow. Check the result and enter a valid id.' :
          /evaluation_unreadable/.test(c) ? 'This check could not be verified. The rule stays in shadow. Run the check again before retrying.' : e.message;
        if (/revision_conflict|idempotency_conflict|invalid_|rule_not_|evaluation_|owner_review_required|not_memory_authority/.test(c)) T.intent = null;
        paintModal();
      });
  }
  function stewardBody() {
    var T = S.steward, dis = T.busy || !!T.intent, dr = S.drafts;
    function sbtn(act, label, id) { return btn(act, label, { id: id, disabled: dis && act !== 'steward-retry' }); }
    var tabs = '<div class="cx-switch mm-tabs" role="group" aria-label="Stewardship section">' + [['rules', 'Standing rules'], ['sources', 'Current sources'], ['outcomes', 'Outcome evidence']].map(function (t) {
      return '<button type="button" data-mm="steward-tab" data-arg="' + t[0] + '" aria-pressed="' + (T.tab === t[0]) + '"' + (T.intent ? ' disabled' : '') + '>' + t[1] + '</button>'; }).join('') + '</div>';
    var body = '<p class="mm-muted">Evidence and your decisions govern changes. A saved rule stays in shadow until you review it and an independent check passes.</p>' + tabs;
    if (T.error) body += '<p class="mm-bad">' + esc(T.error) + '</p>' + (T.intent ? btn('steward-retry', 'Retry the same action') : btn('steward-reload', 'Reload'));
    if (T.busy) body += '<p class="cx-note">Working…</p>';
    if (T.tab === 'rules') {
      body += T.rows.length ? T.rows.map(function (r) {
        var p = r.payload || {};
        return '<section class="cx-card mm-card"><h4>' + esc(p.text) + '</h4><p class="mm-muted">' + esc(r.state) + ' · revision ' + esc(r.revision) + ' · ' + esc(p.review) + '</p><p>Applies when: ' + esc(p.trigger || 'not given') + '</p><p>Exclusions: ' + esc((p.exclusions || []).join('; ') || 'none recorded') + '</p><p class="mm-muted">Evidence: ' + esc((p.evidence_refs || []).join(', ')) + '</p><div class="mm-actions">' +
          (r.state === 'candidate' && p.review !== 'approved_by_owner' ? sbtn('steward-review', 'Review this version', r.id) : '') + (r.state === 'candidate' && p.review === 'approved_by_owner' ? sbtn('steward-activate', 'Check the evaluation and turn it on', r.id) : '') + (r.state === 'active' ? sbtn('steward-rollback', 'Roll back this rule', r.id) : '') + '</div></section>';
      }).join('') : (!T.busy ? '<p>No standing-rule versions recorded.</p>' : '');
      if (T.cursor) body += sbtn('steward-more', 'Load more');
      body += '<section class="mm-set"><h4>Propose a rule</h4><label class="mm-pick mm-block"><span>The behavior you want</span><textarea class="field" id="mm-st-text" data-draft="st.text" rows="3">' + esc(dr['st.text'] || '') + '</textarea></label>' +
        '<label class="mm-pick mm-block"><span>When it applies</span><input class="field" id="mm-st-trigger" data-draft="st.trigger" value="' + esc(dr['st.trigger'] || '') + '"></label>' +
        '<label class="mm-pick mm-block"><span>Exclusions, one per line</span><textarea class="field" id="mm-st-excl" data-draft="st.excl" rows="2">' + esc(dr['st.excl'] || '') + '</textarea></label>' +
        '<label class="mm-pick mm-block"><span>Source or memory ids, separated by commas</span><input class="field" id="mm-st-evidence" data-draft="st.evidence" value="' + esc(dr['st.evidence'] || '') + '"></label>' + sbtn('steward-propose', 'Save as a shadow proposal') + '</section>' +
        '<section class="mm-set"><label class="mm-pick mm-block"><span>Independent check id</span><input class="field" id="mm-st-eval" data-draft="st.eval" value="' + esc(dr['st.eval'] || '') + '"></label><p class="mm-muted">The check must cover this exact revision, when it applies, its exclusions, counterexamples and regressions. A rule cannot turn on without a verified check.</p></section>';
    } else if (T.tab === 'sources') {
      body += T.rows.length ? T.rows.map(function (r) { return '<section class="cx-card mm-card"><h4>' + esc(r.title || r.id) + '</h4><p class="mm-muted">Revision ' + esc(r.revision) + ' · ' + esc(when(r.captured_at)) + ' · ' + esc(r.projection) + '</p>' + sbtn('steward-refresh', 'Refresh this document', r.id) + '</section>'; }).join('') :
        (!T.busy ? '<p>No granted documents right now. The owner grants documents on the Mac.</p>' : '');
    } else {
      var d = T.outcomes;
      body += d ? '<dl class="mm-grid"><dt>Observed runs</dt><dd>' + fmt(d.unique_runs || 0) + '</dd><dt>Checked runs that count</dt><dd>' + fmt(d.checked_eligible_runs || 0) + '</dd><dt>Not conclusive</dt><dd>' + fmt(d.inconclusive_runs || 0) + '</dd><dt>Days observed</dt><dd>' + fmt(d.observation_days || 0) + '</dd><dt>Evidence bar</dt><dd>' + (d.evidence_gate_met ? 'Met' : 'Not met yet') + (d.rate_limit_reason ? '. ' + esc(d.rate_limit_reason) : '') + '</dd></dl>' +
        '<details><summary>Show the raw numbers</summary><pre class="mm-pre">' + esc(JSON.stringify(d, null, 2)) + '</pre></details>' : '';
      body += '<p class="mm-muted">Being recalled, being included in context, a model saying it applied something and an independently checked result are four different things. Too little evidence does not mean things improved.</p>';
    }
    return body;
  }
  function stewardAct(act, id) {
    var T = S.steward, dr = S.drafts;
    if (act === 'steward-retry') return stewardMutate(T.intent);
    if (act === 'steward-tab') { if (T.intent) return; T.tab = id; T.rows = []; T.cursor = null; T.outcomes = null; return stewardLoad(false); }
    if (act === 'steward-reload') return stewardLoad(false);
    if (act === 'steward-more') return stewardLoad(true);
    if (act === 'steward-propose') {
      var text = str(dr['st.text']).trim(); if (!text) { T.error = 'Write the behavior you want first.'; paintModal(); return; }
      return stewardMutate({ action: 'propose_rule', payload: { lesson_id: 'owner_proposal', text: text, trigger: str(dr['st.trigger']).trim(),
        exclusions: str(dr['st.excl']).split('\n').map(function (x) { return x.trim(); }).filter(Boolean), evidence_refs: str(dr['st.evidence']).split(',').map(function (x) { return x.trim(); }).filter(Boolean) } });
    }
    var row = T.rows.filter(function (r) { return r.id === id; })[0]; if (!row) return;
    var body = { action: act === 'steward-refresh' ? 'refresh_source' : act === 'steward-review' ? 'review_rule' : act === 'steward-rollback' ? 'rollback_rule' : 'activate_rule', id: id, expected_revision: row.revision, idempotency_key: 'steward_' + uuid() };
    if (act === 'steward-activate') { body.evaluation_id = str(dr['st.eval']).trim(); if (!body.evaluation_id) { T.error = 'Enter the independent check id for this reviewed revision.'; paintModal(); return; } }
    stewardMutate(body);
  }
  function openPassages(id, d) { openModal('passages', { id: id, data: d }); }
  function passagesBody(m) {
    var d = m.data || {}, items = d.items || [];
    return (d.note ? '<p>' + esc(d.note) + '</p>' : '') + (items.length ? '<ul class="mm-log">' + items.map(function (it) { var s = it.source || {}; return '<li><b>' + esc(s.title || 'Passage') + (s.date ? ' · ' + esc(s.date) : '') + (s.status && s.status !== 'resolved' ? ' · not linked to a file' : '') + '</b><span>' + esc(it.excerpt) + '</span></li>'; }).join('') + '</ul>' : '<p>No passages behind this in the index.</p>') +
      '<p class="mm-muted">' + fmt(d.total || 0) + ' ' + plural(d.total, 'passage', 'passages') + ' in the index.</p>';
  }
  // Merge (0.5.205): the explorer's comparison is step one, the owner Mac's preview step two, and the receipt is polled
  // until it settles. The promise keeps the explorer's row pending and undoes it on a refusal or failure.
  function mergeFlow(source, target, rule) {
    return new Promise(function (resolve) {
      if (S.merge && (S.merge.phase === 'running' || S.merge.phase === 'starting')) { W.toast('A merge is already running. Wait for its receipt.'); resolve(false); return; }
      var m = S.merge = { source: source, target: target, rule: rule || null, preview: null, phase: 'loading', receipt: null, logTail: [], armed: false, resolve: resolve, startedAt: 0 };
      openModal('merge');
      call('graph.merge.preview', { source: source, target: target }).then(function (pv) {
        if (S.merge !== m) return;
        m.preview = pv;
        if (pv.blocked) return finishMerge(false, pv.block_reason || 'Your Mac refused this merge.');
        if (!pv.source || !pv.source.found || !pv.target || !pv.target.found) return finishMerge(false, 'No entity named ' + (pv.source && pv.source.found ? target : source) + ' in this Mac\'s index. Rebuild the index and try again.');
        m.phase = 'preview'; paintModal();
        call('workspace.request', { action: 'identity_status', source: source, target: target }).then(function (d) { if (S.merge === m) { m.identity = d; paintModal(); } },
          function (e) { if (S.merge === m) { m.identityError = e.message; paintModal(); } });
      }, function (e) { if (S.merge === m) finishMerge(false, e.message); });
    });
  }
  function finishMerge(ok, message) {
    var m = S.merge; if (!m) return;
    S.merge = null;
    if (S.modal && S.modal.kind === 'merge') { S.modal = null; paintModal(); }
    if (message) W.toast(message);
    if (m.resolve) m.resolve(ok);
  }
  function mergeCol(en, keep) {
    var descs = (en.descriptions && en.descriptions.length) ? en.descriptions.map(function (d) { return '<p>' + esc(d) + '</p>'; }).join('') : '<p class="mm-muted">No description extracted.</p>';
    return '<div class="mm-merge-col' + (keep ? ' keep' : '') + '"><h4>' + esc(en.id) + '</h4><p class="mm-muted">' + (keep ? 'Stays · ' : 'Folds in · ') + esc(en.type || 'entity') + ' · ' + fmt(en.degree || 0) + ' ' + plural(en.degree, 'connection', 'connections') + '</p>' + descs + '</div>';
  }
  var MERGE_STEPS = [['starting', 'Starting the worker'], ['locking', 'Waiting for other indexing to finish'], ['staging', 'Preparing a separate copy of the graph'], ['snapshot', 'Setting a copy of the graph aside'],
    ['merging', 'Merging (re-embeds the merged text)'], ['indexing', 'Rebuilding this Mac\'s index'], ['exporting', 'Refreshing the graph export']];
  function mergeSteps(stepName) {
    var at = Math.max(0, MERGE_STEPS.map(function (s) { return s[0]; }).indexOf(stepName || 'starting'));
    return '<ol class="mm-merge-steps">' + MERGE_STEPS.map(function (s, i) { return '<li class="' + (i < at ? 'done' : i === at ? 'now' : '') + '">' + esc(s[1]) + '</li>'; }).join('') + '</ol>';
  }
  function mergeBody() {
    var m = S.merge; if (!m) return '';
    if (m.phase === 'loading') return '<p class="cx-note">Asking this Mac what the merge would do…</p>';
    var pv = m.preview || {}, eff = pv.effect || {}, r = m.receipt || {};
    if (m.phase === 'preview' || m.phase === 'starting') {
      var big = (pv.warnings || []).some(function (w) { return w.code === 'large_merge'; }), off = (pv.warnings || []).some(function (w) { return w.code === 'physical_merge_unavailable'; });
      var mins = eff.estimated_seconds ? Math.max(1, Math.round(eff.estimated_seconds / 60)) : null, starting = m.phase === 'starting';
      return '<p>Read both before merging. ' + (pv.name_signal ? '<span class="cx-cap ok">' + esc(pv.name_signal) + '</span>' : '<span class="cx-cap">No name similarity</span>') + '</p>' +
        '<div class="mm-merge">' + mergeCol(pv.target, true) + mergeCol(pv.source, false) + '</div>' +
        '<p class="mm-muted">' + (pv.shared_count ? 'Shared neighbors: ' + esc((pv.shared_neighbors || []).join(', ')) + (pv.shared_count > (pv.shared_neighbors || []).length ? ' and ' + fmt(pv.shared_count - pv.shared_neighbors.length) + ' more' : '') : 'No shared neighbors.') + (pv.adjacent ? ' They are directly connected; that connection folds away.' : '') + '</p>' +
        '<p><b>What would change:</b> ' + fmt(eff.moved || 0) + ' ' + plural(eff.moved, 'connection moves', 'connections move') + ' to ' + esc(m.target) + ', ' + fmt(eff.collapsed || 0) + ' fold into ones it already has, ' + fmt(eff.embeddings || 0) + ' ' + plural(eff.embeddings, 'text', 'texts') + ' re-embedded' + (mins ? ', about ' + mins + ' ' + plural(mins, 'minute', 'minutes') : '') + '. Your original documents stay as they are. A graph-only copy does not restore every affected store.</p>' +
        (pv.warnings || []).map(function (w) { return '<p class="' + (w.code === 'large_merge' || w.code === 'nothing_links_them' ? 'mm-bad' : 'mm-muted') + '">' + esc(w.text) + '</p>'; }).join('') +
        (m.rule ? '<p class="mm-muted">Rule saved with the receipt: ' + esc(m.rule.scope || '') + ' "' + esc(m.rule.pattern || '') + '" becomes "' + esc(m.rule.replacement || '') + '".</p>' : '') +
        (m.identity && m.identity.writable && !m.identity.same_identity ? '<p class="mm-muted">If these are different people or ideas, keep them separate so they are never merged later.</p><div class="mm-actions">' + btn('keep-apart', 'Keep these separate', { disabled: starting }) + '</div>' : '') +
        (m.identityError ? '<p class="mm-muted">Identity rules: ' + esc(m.identityError) + '</p>' : '') +
        '<div class="mm-actions">' + btn('merge-cancel', 'Cancel', { disabled: starting }) + btn('merge-go', off ? 'Merge unavailable' : starting ? 'Starting…' : big && !m.armed ? 'Merge ' + fmt(pv.source.degree) + ' connections…' : m.armed ? 'Yes, merge ' + fmt(pv.source.degree) + ' connections' : 'Merge on this Mac', { disabled: starting || off, cls: 'primary' }) + '</div>' +
        (big && m.armed ? '<p class="mm-bad">Tap again to confirm. This re-embeds ' + fmt(eff.embeddings || 0) + ' texts and rewrites the search stores.</p>' : '');
    }
    if (m.phase === 'running') {
      var secs = m.startedAt ? Math.round((Date.now() - m.startedAt) / 1000) : 0;
      return '<p>Running on this Mac · ' + secs + ' s' + (eff.estimated_seconds ? ' of about ' + eff.estimated_seconds : '') + '</p>' + mergeSteps(r.step) +
        (m.logTail.length ? '<pre class="mm-pre">' + esc(m.logTail.slice(-4).join('\n')) + '</pre>' : '') +
        '<p class="mm-muted">It runs in the background; you can close this and come back. The graph reloads around ' + esc(m.target) + ' when it is done.</p><div class="mm-actions">' + btn('modal-close', 'Close') + '</div>';
    }
    if (m.phase === 'failed') return '<p class="mm-bad">' + esc(r.error || 'The merge did not finish.') + '</p>' + mergeSteps(r.step) + (r.snapshot ? '<p class="mm-muted">The copy of the graph from before the merge is intact.</p>' : '') + '<div class="mm-actions">' + btn('merge-cancel', 'Close') + '</div>';
    return '';
  }
  function pollMerge() {
    var m = S.merge; if (!m || m.phase !== 'running') return;
    setTimeout(function () {
      if (S.merge !== m || m.phase !== 'running') return;
      call('graph.merge.status').then(function (d) {
        if (S.merge !== m) return;
        m.receipt = d.receipt || m.receipt; m.logTail = d.log_tail || [];
        var st = m.receipt && m.receipt.state;
        if (st === 'done') return mergeDone();
        if (st === 'failed' || (!d.running && st !== 'done')) { m.phase = 'failed'; if (!S.modal || S.modal.kind !== 'merge') W.toast('Merging ' + m.source + ' did not finish: ' + ((m.receipt && m.receipt.error) || 'no detail')); paintModal(); return; }
        paintModal(); pollMerge();
      }, function () { paintModal(); pollMerge(); });
    }, 3000);
  }
  function mergeDone() {
    var m = S.merge, r = m.receipt || {}, after = r.after || {};
    finishMerge(true, 'Merged ' + m.source + ' into ' + m.target + (after.target != null ? ' · ' + fmt(after.target) + ' connections now' : '') + '.');
    S.focus = m.target; S.focusChosen = true; S.graphMemories = {};
    loadGraph(); if (S.dups.data) scanDups();
  }
  function scanDups() {
    if (S.dups.busy) return;
    S.dups = { busy: true, data: null, error: '' }; paint();
    call('graph.duplicates', { limit: 25 }).then(function (d) { S.dups = { busy: false, data: d, error: '' }; }, function (e) { S.dups = { busy: false, data: null, error: e.message }; }).then(paint);
  }

  // ── the graph explorer (memories/graph-explorer.js and memory-workspace.js, loaded as they are) ──
  function graphAssets() { try { return JSON.parse((el('memories-graph-assets') || {}).textContent || '{}'); } catch (_e) { return {}; } }
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script'); s.src = src; s.async = false;
      s.onload = function () { resolve(); };
      s.onerror = function () { if (s.remove) s.remove(); reject(new Error('Could not load the graph explorer. Check the connection to your Mac.')); };
      document.body.appendChild(s);
    });
  }
  function loadKit() {
    if (window.COSGraphExplorer && window.COSMemoryWorkspace) return Promise.resolve();
    if (S.kit) return S.kit;
    var a = graphAssets();
    if (!a.d3 || !a.explorer || !a.workspace) return Promise.reject(new Error('This page does not list the graph explorer files.'));
    if (a.css && !document.querySelector('link[data-mm-graph]')) { var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = a.css; l.setAttribute('data-mm-graph', '1'); document.head.appendChild(l); }
    // The workspace names its drafts with crypto.randomUUID, which a plain-http tailnet page does not have.
    if (window.crypto && typeof window.crypto.randomUUID !== 'function') { try { Object.defineProperty(window.crypto, 'randomUUID', { value: uuid, configurable: true }); } catch (_e) {} }
    S.kit = (window.d3 ? Promise.resolve() : loadScript(a.d3)).then(function () { return window.COSGraphExplorer ? null : loadScript(a.explorer); })
      .then(function () { return window.COSMemoryWorkspace ? null : loadScript(a.workspace); })
      .then(function () { if (!window.COSGraphExplorer || !window.COSMemoryWorkspace) throw new Error('The graph explorer did not start.'); }, function (e) { S.kit = null; throw e; });
    return S.kit;
  }
  function memoriesFor(id) {
    var hits = S.graphMemories[id];
    if (hits === undefined) {
      S.graphMemories[id] = null;
      call('memories.search', { q: id, limit: 5 }).then(function (d) {
        S.graphMemories[id] = (d.hits || []).map(function (h) { return { id: h.id, title: h.summary || h.content || h.id }; });
        var c = S.wsController; if (c && c.select) c.select(id);
      }, function () { S.graphMemories[id] = []; });
    }
    return hits || [];
  }
  function mountGraph() {
    var host = el('mm-graph-host'); if (!host) return;
    if (S.ws) { if (host.firstChild && !host.querySelector('.memory-investigation')) host.innerHTML = ''; S.ws.attach(host, S.focus); return; }
    if (S.kitError) return;
    loadKit().then(function () {
      var h = el('mm-graph-host'); if (!h) return;
      if (!S.ws) {
        var src = (S.graph && S.graph.source) || {};
        S.ws = window.COSMemoryWorkspace.create({ call: call, toast: W.toast, openPassages: openPassages,
          onUserIntent: function () { S.focusChosen = true; },
          onController: function (c) {
            S.wsController = c;
            try {
              var snap = c.snapshot(); S.graphVisible = snap.nodes.length;
              var f = S.focus;
              S.neighbors = (snap.links || []).filter(function (l) { var a = typeof l.source === 'object' ? l.source.id : l.source, b = typeof l.target === 'object' ? l.target.id : l.target; return f && (a === f || b === f); })
                .sort(function (x, y) { return (y.weight || 0) - (x.weight || 0); }).map(function (l) { var a = typeof l.source === 'object' ? l.source.id : l.source, b = typeof l.target === 'object' ? l.target.id : l.target; return a === f ? b : a; })
                .filter(function (v, i, arr) { return v !== f && arr.indexOf(v) === i; }).slice(0, 6);
            } catch (_e) {}
            paintSoon();
          },
          graphOptions: {
            labels: { graphName: fileGraph() ? 'Your document links' : 'Your knowledge graph' },
            onCopy: function (text, label) { call('copy', { text: text, label: label }).then(function () { W.toast('Copied as grounded context'); }, function (e) { W.toast(e.message); }); },
            memoriesFor: memoriesFor,
            onOpenMemory: function (memoryId) { W.go('memories', ['m', memoryId]); },
            curation: { enabled: !fileGraph(), ownerLabel: hostLabel(src.owner_host) || 'the owner Mac', isOwner: !!src.is_owner },
            onCuration: function (change) { if (change.op !== 'merge') { W.toast('Rename and remove are not available. Nothing was changed.'); return false; } return mergeFlow(change.source, change.target, change.rule && change.rule.pattern ? change.rule : null); }
          } });
      }
      h.innerHTML = ''; S.ws.attach(h, S.focus); applyPending();
    }, function (e) { S.kitError = e.message; paint(); });
  }
  // A question answered while the graph was not on screen is shown in it once the explorer is free.
  function applyPending() {
    var inv = S.ask.pending; if (!inv || !S.ws) return;
    var tries = 0;
    (function again() {
      if (S.ask.pending !== inv || !S.ws) return;
      if (S.ws.applyQuestion(inv, S.ws.questionToken())) { S.ask.pending = null; S.ask.message = 'The graph now shows the points and connections chosen for your question.'; paint(); return; }
      if (++tries < 30) setTimeout(again, 500);
    })();
  }
  // The workspace's Find points button and Enter in its search box run this (the pane's click and keydown handlers).
  function graphSearch() {
    var input = el('graphQuery'), status = el('graphSearchStatus'), q = input ? String(input.value || '').trim() : '';
    if (q.length < 2) { if (status) status.textContent = 'Type at least two characters.'; return; }
    S.focusChosen = true; if (status) status.textContent = 'Looking up…';
    call('graph.search', { q: q, limit: 5 }).then(function (d) {
      var items = d.items || [];
      if (!items.length) { if (status) status.textContent = d.indexState === 'missing' ? 'No knowledge index on this Mac yet. Build it under Knowledge status.' : 'Nothing in the graph matches that.'; return; }
      if (S.ws) { S.ws.showMatches(items); if (status) status.textContent = items.length + ' ' + plural(items.length, 'match', 'matches') + '. Pick one below.'; }
    }, function (e) { if (status) status.textContent = e.message; });
  }
  function explore(eventId) {
    var e = findRow(eventId); if (!e) return;
    S.knowledgeFocus = eventId; S.view = 'knowledge'; S.ktab = 'graph'; S.ktabChosen = true; persist();
    W.go('memories', ['k', 'graph']);
    var term = exploreTerm(e);
    call('graph.search', { q: term, limit: 3 }).then(function (d) {
      var items = d.items || [];
      if (items.length) { S.focus = items[0].id; S.focusChosen = true; if (S.ws && el('mm-graph-host')) S.ws.attach(el('mm-graph-host'), S.focus); paint(); }
      else W.toast('Nothing in the graph matches "' + term + '".' + (S.focus ? ' Showing ' + S.focus + '.' : ''));
    }, function (er) { W.toast(er.message); });
  }

  // ── asking the graph ─────────────────────────────────────
  var askTimer = null, askSerial = 0;
  function ask(question) {
    var a = S.ask; if (a.busy) return;
    var input = el('mm-ask-q'), q = String(typeof question === 'string' ? question : input ? input.value : a.q).trim();
    if (q.length < 3) { W.toast('Ask a fuller question.'); return; }
    if (q.length > 400) { W.toast('Keep the question under 400 characters.'); return; }
    var serial = ++askSerial, ws = S.ws, token = ws && ws.questionToken();
    S.focusChosen = true;
    S.ask = { q: q, busy: true, answer: null, error: '', cards: [], cardsBusy: false, startedAt: Date.now(), message: '', pending: null };
    clearInterval(askTimer); askTimer = setInterval(tickAsk, 1000); paint();
    call('graph.ask', { q: q }).then(function (d) {
      if (serial !== askSerial) return;
      var inv = d.investigation, message = inv && inv.message, pending = null;
      if (inv && inv.status === 'ready') {
        if (ws && S.ws === ws && el('mm-graph-host')) message = ws.applyQuestion(inv, token) ? 'The graph now shows the points and connections chosen for your question.' : 'Your graph edits were kept. Ask again when you want the view updated.';
        else { pending = inv; message = 'Open Ask the graph to see these points in the graph.'; }
      } else if (!message) message = 'This answer has no checked graph plan. Use Advanced investigation under the graph to choose points.';
      S.ask = { q: q, busy: false, answer: d, error: '', cards: [], cardsBusy: false, startedAt: 0, message: message, pending: pending };
      clearInterval(askTimer); paint(); loadCards(d.answer || '', q, serial);
    }, function (e) {
      if (serial !== askSerial) return;
      S.ask = { q: q, busy: false, answer: null, error: e.message, cards: [], cardsBusy: false, startedAt: 0, message: '', pending: null };
      clearInterval(askTimer); paint();
    });
  }
  function tickAsk() {
    if (!S.ask.busy) { clearInterval(askTimer); return; }
    var s = askSecs(), p = document.querySelector('[data-role="ask-progress"]'), m = document.querySelector('[data-role="ask-meta"]');
    if (p) p.textContent = askBusyCopy(s); if (m) m.textContent = 'Working · ' + s + ' s';
  }
  // The people and ideas an answer names, as cards: headings and bold names are looked up; an exact id wins, then a person.
  function askNames(answer, q) {
    var names = [];
    function add(n) { n = String(n || '').replace(/\s*\(.*?\)\s*$/, '').replace(/[*_#`]/g, '').trim(); if (n.length >= 3 && n.length <= 60 && /[A-Za-z]/.test(n) && names.indexOf(n) < 0) names.push(n); }
    (answer.match(/^#{1,4}\s+(.+)$/gm) || []).forEach(function (h) { add(h.replace(/^#+\s+/, '').replace(/^(Relationship|Relationships|References|Key Context|Summary|Overview)\s*:?\s*/i, '')); });
    (answer.match(/\*\*([^*]{3,60})\*\*/g) || []).forEach(function (b) { var n = b.replace(/\*\*/g, ''); if (/^[A-Z][\w'.-]*(\s+[A-Z][\w'.-]*){0,3}$/.test(n)) add(n); });
    var m = q.match(/between\s+(.+?)\s+and\s+(.+?)\??$/i); if (m) { add(m[1]); add(m[2]); }
    return names.filter(function (n) { return !/^(Primary Relationship|Role|Current Focus|Completion|Birthday|Children|Attribute|Detail|Regular syncs|Family management|Shared parenthood)$/i.test(n); }).slice(0, 8);
  }
  function loadCards(answer, q, serial) {
    var names = askNames(answer, q), seen = {};
    S.ask.cardsBusy = names.length > 0; paint();
    Promise.all(names.map(function (n) {
      return call('graph.search', { q: n, limit: 3 }).then(function (d) {
        var items = d.items || [];
        var hit = items.filter(function (it) { return String(it.id).toLowerCase() === n.toLowerCase(); })[0] || items.filter(function (it) { return String(it.type || '').toLowerCase() === 'person' && String(it.id).toLowerCase().indexOf(n.toLowerCase()) === 0; })[0];
        if (!hit || seen[hit.id]) return null; seen[hit.id] = 1;
        return call('graph.entity', { id: hit.id, limit: 6 }).then(function (en) { return en.found === false ? null : en; }, function () { return null; });
      }, function () { return null; });
    })).then(function (ents) { if (serial !== askSerial) return; S.ask.cards = ents.filter(Boolean); S.ask.cardsBusy = false; paint(); });
  }

  // ── long runs: indexing, model fetch, index build ────────
  var watch = { ingest: null, fetch: null, build: null };
  function watchIngest() {
    if (watch.ingest) return;
    var before = S.graph && S.graph.queue ? Number(S.graph.queue.pending) : null, ticks = 0;
    function finish() {
      clearInterval(watch.ingest); watch.ingest = null;
      var pr = S.progress || {};
      loadGraph().then(function () {
        var g = S.graph || {}, after = g.queue ? Number(g.queue.pending) : null;
        var done = pr.done ? fmt(pr.done) + ' indexed' + (pr.failed ? ', ' + fmt(pr.failed) + ' failed' : '') : before != null && after != null && before > after ? fmt(before - after) + ' indexed' : 'Indexing finished';
        S.ingest = { note: done + (after != null ? ' · ' + fmt(after) + ' still waiting' : '') };
        if (S.setup) loadSetup();
        setTimeout(function () { S.ingest = null; paint(); }, 60000);
        paint();
      });
    }
    function tick() {
      ticks++;
      var reads = [call('graph.progress').then(function (d) { S.progress = d; }, function () {})];
      if (ticks % 3 === 0) reads.push(loadGraph());
      Promise.all(reads).then(function () {
        var pr = S.progress || {}, lk = pr.lock || (S.graph || {}).lock || {};
        if (!(pr.running === true || lockHeld(lk)) || ticks > 2880) return finish();
        paint();
      });
    }
    watch.ingest = setInterval(tick, 5000); tick();
  }
  function watchFetch() {
    if (watch.fetch) return;
    var ticks = 0;
    watch.fetch = setInterval(function () {
      ticks++;
      loadSetup().then(function () {
        var f = S.setup && S.setup.embedding && S.setup.embedding.fetch;
        if (!f || f.state !== 'running' || ticks > 360) { clearInterval(watch.fetch); watch.fetch = null; if (f && f.state === 'done') W.toast('Model fetched.'); else if (f && f.state === 'failed') W.toast('Fetch failed: ' + (f.error || 'unknown')); }
      });
    }, 10000);
  }
  function stopWatches() { clearInterval(watch.ingest); watch.ingest = null; clearInterval(watch.fetch); watch.fetch = null; clearInterval(watch.build); watch.build = null; clearInterval(askTimer); }

  // ── decisions (writes, each from a tap) ──────────────────
  function arm(key) { S.armed = key; paint(); setTimeout(function () { if (S.armed === key) { S.armed = ''; paint(); } }, 6000); }
  function afterWrite() { loadStatus(); }
  function reviewMemory(id, decision) {
    if (S.reviewBusy) return;
    if (decision === 'prune' && S.armed !== 'prune:' + id) return arm('prune:' + id);
    S.armed = ''; S.reviewBusy = id; paint();
    // Restore is Accept on the wire: the bridge returns a quarantined memory to recall before marking it accepted.
    call('memory.review', { id: id, decision: decision === 'restore' ? 'accept' : decision }).then(function (d) {
      var row = d.decision || {};
      S.decisions[id] = row.decision || (decision === 'prune' ? 'pruned' : 'accepted'); S.decisionTs[id] = new Date().toISOString(); S.decided[id] = 1;
      if (decision === 'prune') { S.mem.rows = S.mem.rows.filter(function (m) { return m.id !== id; }); }
      W.toast(decision === 'prune' ? 'Memory quarantined.' : decision === 'restore' ? 'Memory restored to recall.' : 'Memory accepted.');
      afterWrite();
    }, function (e) { W.toast(e.message); }).then(function () { S.reviewBusy = ''; paint(); });
  }
  function reviewGoverned(id, decision) {
    if (S.reviewBusy) return;
    var row = S.review.rows.concat(S.recent.rows).filter(function (e) { return e.lesson_id === id && e.governance; })[0];
    if (row && S.detail[row.event_id] && S.detail[row.event_id].journal_revision) row = Object.assign({}, row, S.detail[row.event_id]);
    if (!row) { W.toast('Refresh To review before changing this memory.'); return; }
    if (decision === 'forget' && S.armed !== 'forget:' + id) return arm('forget:' + id);
    var intent = S.reviewIntent;
    if (!intent) intent = S.reviewIntent = { action: 'review_memory', id: id, decision: decision, expected_revision: row.journal_revision, idempotency_key: 'review_' + uuid() };
    if (intent.id !== id || intent.decision !== decision) { W.toast('Retry the pending review action before starting another.'); return; }
    S.reviewBusy = id; paint();
    call('workspace.request', intent).then(function (d) {
      S.reviewIntent = null; S.armed = ''; S.detail = {}; S.memDetail = {}; S.decided[id] = 1;
      W.toast(d.status === 'deletion_pending_projection' ? 'Forgotten content is hidden; cleanup is still running.' : decision === 'forget' ? 'Searchable memory removed. Outside sources and protected backups remain.' : 'Memory ' + (d.state || d.status || 'updated') + '.');
      loadReview(false); loadRecent(false); if (S.mem.loaded) loadMem(false); afterWrite();
    }, function (e) {
      if (/revision_conflict|idempotency_conflict|memory_not_found/.test(codeOf(e))) { S.reviewIntent = null; S.detail = {}; loadReview(false); loadRecent(false); }
      W.toast(e.message);
    }).then(function () { S.reviewBusy = ''; paint(); });
  }
  function decide(eventId, decision) {
    var e = findRow(eventId); if (!e) return;
    call('learning.decide', { id: e.lesson_id, decision: decision }).then(function () {
      S.decisions[e.lesson_id] = decision; if (decision === 'dismissed') S.decided[e.lesson_id] = 1; else delete S.decided[e.lesson_id];
      W.toast(decision === 'dismissed' ? 'Suggestion dismissed.' : 'Suggestion restored.');
      loadReview(false); afterWrite();
    }, function (er) { W.toast(er.message); });
  }
  function pruneAll() {
    if (S.bulk) return;
    var ids = S.review.rows.filter(function (e) { return isPruneReady(e) && !decisionFor(e); }).map(function (e) { return e.lesson_id; });
    if (!ids.length) return;
    if (S.armed !== 'prune-all') return arm('prune-all');
    S.armed = ''; S.bulk = { done: 0, total: ids.length }; paint();
    // One memory at a time through the same review call as the card's Quarantine; the first failure stops the run.
    ids.reduce(function (chain, id) {
      return chain.then(function () {
        return call('memory.review', { id: id, decision: 'prune', note: 'prune ready' }).then(function (d) {
          var row = d.decision || {}; S.decisions[id] = row.decision || 'pruned'; S.decisionTs[id] = new Date().toISOString(); S.decided[id] = 1; S.bulk.done += 1; paint();
        });
      });
    }, Promise.resolve()).then(function () { var n = S.bulk.done; S.bulk = null; W.toast('Quarantined ' + fmt(n) + '. Restore any of them from its card.'); afterWrite(); paint(); },
      function (e) { var b = S.bulk; S.bulk = null; W.toast('Stopped after ' + fmt(b.done) + ' of ' + fmt(b.total) + ': ' + e.message); paint(); });
  }
  function policySet(key) {
    if (S.policyBusy || !S.policy || !S.policy.policy) return;
    if (!S.policyIntent) { var changes = {}; changes[key] = !S.policy.policy[key]; S.policyIntent = { action: 'policy_set', changes: changes, expected_revision: S.policy.policy.revision, idempotency_key: 'policy_' + uuid() }; }
    serials.policy = (serials.policy || 0) + 1; S.policyLoading = false; S.policyBusy = true; S.policyError = ''; paintModal();
    call('workspace.request', S.policyIntent).then(function (d) { S.policy = { policy: d.policy, writable: true, state: 'available' }; S.policyIntent = null; W.toast('Memory settings saved.'); },
      function (e) {
        S.policyError = e.message;
        if (/revision_conflict|idempotency_conflict|unknown_policy|invalid_policy/.test(codeOf(e))) { S.policyIntent = null; S.policyError = 'These settings changed or the change was refused. Reload, check the current value, then choose again.'; }
      }).then(function () { S.policyBusy = false; paintModal(); });
  }
  function saveOwner() {
    if (S.ownerBusy || !S.owner) return;
    var name = str(S.drafts.owner).trim(); if (!name) { S.ownerError = 'Enter your name.'; paintModal(); return; }
    serials.owner = (serials.owner || 0) + 1; S.ownerBusy = true; S.ownerError = ''; paintModal();
    call('profile.owner.set', { name: name, expected: S.owner.owner_name || '' }).then(function (d) {
      S.owner = d; S.drafts.owner = d.owner_name; if (S.status) S.status.ownerName = d.owner_name; S.focusResolved = false; chooseDefaultFocus(); W.toast('Name saved.');
    }, function (e) { S.ownerError = e.message; }).then(function () { S.ownerBusy = false; paintModal(); });
  }
  function guardPatch() {
    var g = S.guard || {}, llm = g.llm_review || {}, dr = S.drafts;
    function pick(k, v) { return dr['g.' + k] != null ? dr['g.' + k] : v; }
    var patch = { min_words: Number(pick('min_words', g.min_words)), min_distinct_chars: Number(pick('min_distinct_chars', g.min_distinct_chars)), max_repeat_ratio: Number(pick('max_repeat_ratio', g.max_repeat_ratio)),
      banned_patterns: String(pick('banned', (g.banned_patterns || []).join('\n'))).split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
      llm_review: { enabled: !!pick('llm', llm.enabled), model: pick('model', llm.model) || 'haiku', max_per_run: Number(pick('max', llm.max_per_run || 20)) || 20 } };
    if (llm.supported === false) delete patch.llm_review;
    return patch;
  }
  function guardSave() {
    if (S.guardBusy) return;
    S.guardBusy = 'save'; paintModal();
    call('memory.guardrails.set', { patch: JSON.stringify(guardPatch()) }).then(function (d) {
      S.guard = d.guardrails; Object.keys(S.drafts).forEach(function (k) { if (k.indexOf('g.') === 0) delete S.drafts[k]; }); W.toast('Guardrails saved.');
    }, function (e) { W.toast(e.message); }).then(function () { S.guardBusy = ''; paintModal(); });
  }
  function guardRun(apply) {
    if (S.guardBusy) return;
    if (apply && S.armed !== 'guard-apply') { S.armed = 'guard-apply'; paintModal(); return; }
    S.armed = ''; S.guardBusy = apply ? 'apply' : 'run'; paintModal();
    call('memory.guardrails.run', { days: 30, apply: apply === true }).then(function (d) {
      S.guardRun = d;
      if (apply) {
        var ids = (d.verdicts || []).filter(function (v) { return v.applied; }).map(function (v) { return v.id; });
        S.mem.rows = S.mem.rows.filter(function (m) { return ids.indexOf(m.id) < 0; }); ids.forEach(function (id) { S.decisions[id] = 'pruned'; S.decided[id] = 1; });
        W.toast('Quarantined ' + fmt(d.run.pruned) + '.'); afterWrite();
      } else W.toast(fmt(d.run.flagged) + ' flagged, ' + fmt(d.run.kept) + ' kept' + (d.run.review ? ', ' + fmt(d.run.review) + ' for you' : '') + '.');
    }, function (e) { W.toast(e.message); }).then(function () { S.guardBusy = ''; paintModal(); paint(); });
  }
  function copyMemory(id) {
    var rows = (S.mem.hits || []).concat(S.mem.rows), m = rows.filter(function (x) { return x.id === id; })[0] || {}, full = S.memDetail[id] || {}, r = Object.assign({}, m, full._error ? {} : full);
    var text = 'Memory ' + id + (r.type || r.created_at ? ' (' + [r.type, String(r.created_at || '').slice(0, 10)].filter(Boolean).join(' · ') + ')' : '') + '\n\n"""\n' + (r.content || r.summary || '') + '\n"""';
    call('copy', { text: text }).then(function () { W.toast('Copied as grounded context'); }, function (e) { W.toast(e.message); });
  }
  function copyAsk(withContext) {
    var a = S.ask; if (!a.answer) return;
    var text = 'Question: ' + a.q + '\n\nAnswer (put together from the COS knowledge graph, ' + (a.answer.mode || 'hybrid') + ' mode):\n' + a.answer.answer;
    if (withContext && a.cards.length) text += '\n\nIn the graph:\n\n' + a.cards.map(entityText).join('\n\n');
    call('copy', { text: text }).then(function () { W.toast(withContext ? 'Copied the answer with its context.' : 'Copied the answer.'); }, function (e) { W.toast(e.message); });
  }
  function startIngest() {
    var sel = el('mm-ingest-limit'), limit = sel ? Number(sel.value) || 10 : S.ingestLimit; S.ingestLimit = limit;
    S.ingest = { note: 'Starting…' }; paint();
    call('graph.ingest', { limit: limit }).then(function (d) {
      if (d.started) { var batch = Math.min(d.limit || 0, d.pending || 0); S.ingest = { note: d.pending <= batch ? 'Indexing all ' + fmt(d.pending) + ' waiting' : 'Indexing the next ' + fmt(batch) + ' of ' + fmt(d.pending) + ' waiting' }; watchIngest(); }
      else if (d.already_running) { S.ingest = null; W.toast('Indexing is already running. This refreshes as it runs.'); watchIngest(); }
      else if (d.nothing_pending) { S.ingest = null; W.toast('Nothing is waiting.'); }
      else if (d.budget_exhausted) { S.ingest = null; W.toast('Today\'s model budget for the graph is used up' + (d.budget ? ' (' + fmt(d.budget.used) + ' of ' + fmt(d.budget.cap) + ' calls)' : '') + '. It resets tomorrow.'); }
      else { S.ingest = null; W.toast('Nothing started.'); }
    }, function (e) { S.ingest = null; W.toast(e.message); }).then(paint);
  }
  function buildIndex() {
    S.building = 'Starting…'; paint();
    call('graph.build').then(function (d) {
      S.building = d.already_running ? 'A build is already running' : 'Building…'; paint();
      var tries = 0; clearInterval(watch.build);
      watch.build = setInterval(function () {
        tries++;
        loadGraph().then(function () {
          var b = S.graph && S.graph.build;
          if (b && (b.state === 'done' || b.state === 'failed')) { S.building = b.state === 'done' ? 'Index rebuilt' : 'Build failed: ' + (b.error || ''); clearInterval(watch.build); watch.build = null; paint(); }
          else if (tries > 150) { S.building = 'Still building after 5 minutes. Refresh later.'; clearInterval(watch.build); watch.build = null; paint(); }
        });
      }, 2000);
    }, function (e) { S.building = ''; W.toast(e.message); paint(); });
  }
  function indexSample() {
    setupAction('sample', 'graph.sample', { limit: 3 }, function (d) {
      var q = (d.queued || []).length;
      if (d.started) { S.ingest = { note: 'Indexing ' + fmt(q) + ' sample ' + plural(q, 'document', 'documents') }; watchIngest(); }
      else if (d.already_running) { W.toast((q ? fmt(q) + ' queued. ' : '') + 'Indexing is already running; this refreshes as it runs.'); watchIngest(); }
      else if (d.nothing_pending) W.toast('Nothing new to index in the folders that are on.');
      else if (d.budget_exhausted) W.toast('Today\'s model budget for the graph is used up. It resets tomorrow.');
      if ((d.skipped || []).length) W.toast(fmt(d.skipped.length) + ' skipped: ' + d.skipped.map(function (x) { return x.reason; }).join(', '));
    });
  }
  function addFolder() {
    var input = el('mm-folder'), path = String(input ? input.value : S.folderDraft).trim();
    if (!path) { W.toast('Type the folder\'s path on your Mac first.'); return; }
    setupAction('add', 'graph.setup.sources', { action: 'add', path: path }, function () { S.folderDraft = ''; W.toast('Folder added.'); });
  }
  function mergeGo() {
    var m = S.merge; if (!m || m.phase !== 'preview') return;
    var w = (m.preview || {}).warnings || [], off = w.filter(function (x) { return x.code === 'physical_merge_unavailable'; })[0];
    if (off) { W.toast(off.text); return; }
    if (w.some(function (x) { return x.code === 'large_merge'; }) && !m.armed) { m.armed = true; paintModal(); return; }
    m.phase = 'starting'; paintModal();
    call('graph.merge', { source: m.source, target: m.target, confirm: true, rule: m.rule || undefined }).then(function (d) {
      if (S.merge !== m) return;
      m.phase = 'running'; m.receipt = d.receipt || null; m.startedAt = Date.now(); paintModal(); pollMerge();
    }, function (e) { if (S.merge !== m) return; m.phase = 'preview'; m.armed = false; paintModal(); W.toast(e.message); });
  }
  function keepApart() {
    var m = S.merge; if (!m || m.phase !== 'preview' || !m.identity || !m.identity.writable) return;
    if (!m.constraintIntent) m.constraintIntent = { action: 'identity_keep_apart', source: m.source, target: m.target, expected_revision: m.identity.revision, idempotency_key: 'keep-apart:' + uuid() };
    m.phase = 'starting'; paintModal();
    call('workspace.request', m.constraintIntent).then(function () { if (S.merge === m) { finishMerge(false, 'Saved. These two will be kept separate.'); loadGraph(); } },
      function (e) {
        if (S.merge !== m) return; m.phase = 'preview'; paintModal(); W.toast(e.message);
        if (/revision_conflict|identity_split_required|idempotency_conflict/.test(codeOf(e))) { m.constraintIntent = null; call('workspace.request', { action: 'identity_status', source: m.source, target: m.target }).then(function (d) { if (S.merge === m) { m.identity = d; paintModal(); } }, function () {}); }
      });
  }

  // ── painting ─────────────────────────────────────────────
  // Duo tables: the divider between the list and the reader from 760 px (app.js splitKit; the same limits as Sessions),
  // with its own remembered width, and Full width in a reader's header.
  var SPLIT = { key: 'cos_web_memories_split', label: 'Memories list', controls: 'mm-list-col', media: '(min-width: 760px)', listMin: 240, readerMin: 380, handleW: 18 };
  // A page without the kit (a test's stand-in W) draws no divider and keeps working.
  var SPLIT_KIT = W.splitKit || { handle: function () { return ''; }, mount: function () { return null; }, fullButton: function () { return ''; } };
  var SPLIT_HANDLE = SPLIT_KIT.handle({ id: 'mm-handle', controls: SPLIT.controls, label: SPLIT.label });
  var SKELETON = '<div class="cx mm" data-tint="memories" id="mm-root"><div id="mm-hero"></div><div class="mm-controls" id="mm-views"></div><p class="mm-counts" id="mm-counts"></p>' +
    '<div class="split mm-split" id="mm-split"><div class="split-list mm-list" id="mm-list-col"><div id="mm-tools"></div><div id="mm-list"></div></div>' +
    SPLIT_HANDLE + '<div class="reader mm-reader" id="mm-reader"></div></div>' +
    '<p class="mm-foot" id="mm-foot"></p></div><div id="mm-modal-host"></div>';
  function write(node, html) { if (!node || node.__mm === html) return false; node.innerHTML = html; node.__mm = html; return true; }
  var paintTimer = null;
  function paintSoon() { if (paintTimer) return; paintTimer = setTimeout(function () { paintTimer = null; paint(); }, 60); }
  function paint() {
    var r = W.parseRoute(); if (r.pane !== 'memories') return;
    if (!el('mm-root')) pane.innerHTML = SKELETON;
    var reading = readerArgs(r).length > 0, split = el('mm-split');
    SPLIT_KIT.mount(split, el('mm-handle'), SPLIT);
    pane.classList.toggle('reading', reading); if (split) split.classList.toggle('reading', reading);
    // The cue views are one column at every width, like Control's cue review (a card, not a list beside a reader).
    if (split) split.classList.toggle('solo', !reading && (S.view === 'cues' || S.view === 'rated'));
    write(el('mm-hero'), heroHtml()); write(el('mm-views'), viewsHtml()); write(el('mm-counts'), countsHtml()); write(el('mm-foot'), footHtml());
    var tools = el('mm-tools');
    if (tools && tools.__view !== S.view) { tools.innerHTML = S.view === 'memories' ? memSearchHtml() : ''; tools.__view = S.view; }
    write(el('mm-list'), listHtml());
    paintReader(r);
    paintModal();
  }
  function readerHtml(r) {
    var a = r.args;  // a tab route (t/<view>) opens no reader: the auto-pick below decides, as on a bare list
    S.crumbText = '';
    if (a[0] === 'e' && a[1]) return eventReader(a[1]);
    if (a[0] === 'm' && a[1]) return memoryReader(a[1]);
    if (a[0] === 'k') return knowledgeReader(KTABS.indexOf(a[1]) >= 0 ? a[1] : 'graph');
    var pick = autoPick();
    if (pick) return S.view === 'knowledge' ? knowledgeReader(pick) : S.view === 'memories' ? memoryReader(pick) : eventReader(pick);
    return isWide() ? '<p class="reader-placeholder">Pick an item to read it.</p>' : '';
  }
  function paintReader(r) {
    var node = el('mm-reader'); if (!node) return;
    var html = readerHtml(r);
    if (readerArgs(r).length && W.crumb && W.crumb() !== S.crumbText) W.setCrumb(S.crumbText);
    if (write(node, html) && el('mm-graph-host')) mountGraph();
    // Full width hides the list only while a reader with the button is open, so the list is never hidden behind a
    // placeholder with no way back.
    var split = el('mm-split'); if (split) split.classList.toggle('mm-fullable', !!(node.querySelector && node.querySelector('[data-split-full]')));
    document.body.classList.toggle('mm-graph-open', S.graphFull && !!el('mm-graph-host'));
  }
  function crumb(t) { S.crumbText = String(t || ''); }
  function paintModal(focusFirst) {
    var host = el('mm-modal-host'); if (!host) return;
    var a = document.activeElement, keepId = a && a.id && host.contains && host.contains(a) ? a.id : '', caret = null;
    if (keepId) { try { caret = [a.selectionStart, a.selectionEnd]; } catch (_e) {} }
    var body = host.querySelector ? host.querySelector('.mm-modal-body') : null, top = body ? body.scrollTop : 0;
    var changed = write(host, modalHtml());
    // The sheet fades in once, when it opens; a later repaint (a list that finished loading) must not fade it again.
    if (S.modal && !S.modal.entered) S.modal.entered = true;
    if (changed) {
      var b2 = host.querySelector ? host.querySelector('.mm-modal-body') : null; if (b2 && top) b2.scrollTop = top;
      if (keepId) { var n = el(keepId); if (n && n.focus) { n.focus({ preventScroll: true }); if (caret && caret[0] != null) { try { n.setSelectionRange(caret[0], caret[1]); } catch (_e) {} } } }
      else if (focusFirst && S.modal) { var f = host.querySelector && host.querySelector('.mm-modal-head button'); if (f && f.focus) f.focus(); }
    }
    document.body.classList.toggle('mm-modal-open', !!S.modal);
  }

  // ── taps, typing, keys ───────────────────────────────────
  function setView(v) {
    if (!knownView(v)) return;
    S.view = v; persist();
    if (v === 'memories' && !S.mem.loaded && !S.mem.loading) loadMem(false);
    if (v === 'applied' && !S.applied.loaded && !S.applied.loading) loadApplied(false);
    if (v === 'cues' && S.cue.weekState !== 'loaded') loadCueWeek();
    if (v === 'rated' && !S.cue.ratedLoaded) loadCueRated();
    showTab(v);
  }
  function refresh() {
    S.loadedAt = Date.now(); S.detail = {}; S.passages = {}; S.decided = {};
    loadStatus(); loadRecent(false); loadReview(false); loadCues(); loadGraph();
    if (S.cue.ratedLoaded || S.view === 'rated') loadCueRated();
    if (S.mem.loaded || S.view === 'memories') loadMem(false);
    if (S.applied.loaded || S.view === 'applied') loadApplied(false);
    if (S.setup) loadSetup();
  }
  function openKnowledge(tab, focusId) {
    if (focusId) S.knowledgeFocus = focusId;
    S.view = 'knowledge'; S.ktab = tab; S.ktabChosen = true; persist();
    W.go('memories', ['k', tab]);
  }
  function act(name, t, ev) {
    var id = t.getAttribute('data-id'), arg = t.getAttribute('data-arg');
    if (name.indexOf('steward-') === 0) return stewardAct(name, id || arg);
    if (name.indexOf('cue-') === 0) return cueAct(name, id, arg);
    switch (name) {
      case 'view': return setView(arg);
      case 'refresh': return refresh();
      case 'settings': openModal('settings', { opener: t }); return loadSettings();
      case 'log': return openModal('log', { opener: t });
      case 'open-e': return W.go('memories', ['e', id]);
      case 'open-m': return W.go('memories', ['m', id]);
      case 'ktab': return openKnowledge(KTABS.indexOf(arg) >= 0 ? arg : 'graph');
      case 'back': return W.goBack();
      case 'back-learning': S.view = 'recent'; persist(); return S.knowledgeFocus ? W.go('memories', ['e', S.knowledgeFocus]) : showTab('recent');
      case 'more-recent': return loadRecent(true);
      case 'more-review': return loadReview(true);
      case 'more-mem': return loadMem(true);
      case 'more-applied': return loadApplied(true);
      case 'mem-retry': return loadMem(false);
      case 'mem-clear': { var qi = el('mm-mem-q'); if (qi) qi.value = ''; S.mem.hits = null; S.mem.hitCursor = null; var tl = el('mm-tools'); if (tl) tl.__view = ''; memQuery(''); return paint(); }
      case 'applied-days': return setAppliedDays(Number(arg));
      case 'applied-retry': S.applied.error = ''; S.applied.loaded = false; return loadApplied(false);
      case 'open-sources': return openKnowledge('sources', id);
      case 'explore': return explore(id);
      case 'copy-open': S.copyId = id; return openModal('copy', { opener: t });
      case 'copy-now': { var ce = findRow(S.copyId); if (!ce) return; call('copy', { text: contextText(ce, S.copyOpts) }).then(function () { W.toast('Copied as grounded context'); closeModal(); }, function (er) { W.toast(er.message); }); return; }
      case 'copy-select': { var ta = el('mm-copy-preview'); if (ta) { ta.focus(); ta.select(); } return; }
      case 'copy-memory': return copyMemory(id);
      case 'memory-review': return reviewMemory(id, arg);
      case 'governed': return reviewGoverned(id, arg);
      case 'decide': return decide(id, arg);
      case 'prune-all': return pruneAll();
      case 'steward': openModal('steward', { opener: S.modal && S.modal.opener || t }); return stewardLoad(false);
      case 'modal-close': return closeModal();
      case 'modal-backdrop': if (!ev || ev.target === t) closeModal(); return;
      case 'policy': case 'policy-retry': return policySet(arg);
      case 'policy-load': return loadPolicy();
      case 'owner-retry': return loadOwner();
      case 'guard-load': return loadGuard();
      case 'guard-save': return guardSave();
      case 'guard-run': return guardRun(false);
      case 'guard-apply': return guardRun(true);
      case 'graph-full': S.graphFull = !S.graphFull; return paint();
      case 'graph-retry': S.kitError = ''; S.kit = null; var gh = el('mm-reader'); if (gh) gh.__mm = ''; return paint();
      case 'graph-status': return loadGraph();
      case 'ingest': return startIngest();
      case 'build-index': return buildIndex();
      case 'dups': return scanDups();
      case 'merge-from': return mergeFlow(id, arg, null);
      case 'merge-go': return mergeGo();
      case 'merge-cancel': return finishMerge(false, 'Nothing was changed.');
      case 'keep-apart': return keepApart();
      case 'ask-pair': return ask('Show me the relation between ' + S.focus + ' and ' + arg);
      case 'copy-ask': return copyAsk(arg === 'ctx');
      case 'copy-entity': { var en = S.ask.cards.filter(function (c) { return c.id === id; })[0]; if (en) call('copy', { text: entityText(en) }).then(function () { W.toast('Copied ' + id + ' as context.'); }, function (er) { W.toast(er.message); }); return; }
      case 'passages': return call('graph.passages', { entity: id, limit: 5 }).then(function (d) { openPassages(id, d); }, function (er) { W.toast(er.message); });
      case 'focus': S.focus = id; S.focusChosen = true; if (S.ws && el('mm-graph-host')) S.ws.attach(el('mm-graph-host'), id); return paint();
      case 'setup-refresh': return loadSetup();
      case 'source-toggle': { var src = ((S.setup && S.setup.sources) || []).filter(function (r) { return r.path === arg; })[0]; return setupAction('toggle', 'graph.setup.sources', { action: src && src.enabled ? 'disable' : 'enable', path: arg }); }
      case 'source-remove': if (S.armed !== 'remove:' + arg) return arm('remove:' + arg); return setupAction('remove', 'graph.setup.sources', { action: 'remove', path: arg }, function () { W.toast('Folder removed.'); });
      case 'claim-owner': if (S.armed !== 'owner') return arm('owner'); return setupAction('owner', 'graph.setup.owner', {}, function () { W.toast('This Mac now builds the graph.'); });
      case 'local-only': return setupAction('preference', 'graph.setup.embedding', { local_only: arg === '1' }, function (d) { var rec = (d.embedding || {}).recommended; W.toast(rec ? 'Recommended: ' + rec.label + '.' : 'Saved.'); });
      case 'fetch-model': return setupAction('fetch', 'graph.setup.embedding', { provider: arg, fetch: true }, function (d) { var f = d.fetch || {}; W.toast(f.started ? 'Fetching the model in the background.' : f.already_running ? 'A fetch is already running.' : 'Nothing to fetch.'); watchFetch(); });
      case 'index-sample': return indexSample();
      case 'schedule': { var sel = el('mm-schedule'), every = sel ? Number(sel.value) || 3600 : 3600; return setupAction('schedule', 'graph.schedule', { enabled: arg === 'on', intervalS: every }, function (d) { W.toast(d.installed ? 'Scheduled batches on.' : 'Scheduled batches off.'); }); }
    }
  }
  pane.addEventListener('click', function (e) {
    var target = e.target;
    var t = target && target.closest ? target.closest('[data-mm]') : null;
    // The workspace's Find points button (memories/memory-workspace.js, data-role find-points) has no handler of its own.
    if (!t) { if (target && target.closest && target.closest('.memory-investigation [data-role="find-points"]')) graphSearch(); return; }
    if (t.disabled) return;
    act(t.getAttribute('data-mm'), t, e);
  });
  pane.addEventListener('change', function (e) {
    var t = e.target; if (!t || !t.getAttribute) return;
    var c = t.getAttribute('data-mm-change');
    if (c === 'tier') return setupAction('extraction', 'graph.setup.extraction', { tier: t.value }, function (d) { W.toast('Indexing set to ' + ((d.extraction || {}).label || t.value) + '.'); });
    if (c === 'embedding') return setupAction('embedding', 'graph.setup.embedding', { provider: t.value }, function (d) { W.toast('Embeddings set to ' + ((d.embedding || {}).label || t.value) + '.'); });
    if (c === 'ingest-limit') { S.ingestLimit = Number(t.value) || 10; return; }
    if (c === 'copy-opt') { S.copyOpts[t.getAttribute('data-arg')] = !!t.checked; var ce = findRow(S.copyId), ta = el('mm-copy-preview'); if (ce && ta) ta.value = contextText(ce, S.copyOpts); return; }
    var dk = t.getAttribute('data-draft'); if (dk) S.drafts[dk] = t.type === 'checkbox' ? !!t.checked : t.value;
  });
  pane.addEventListener('input', function (e) {
    var t = e.target; if (!t || !t.getAttribute) return;
    if (t.id === 'mm-mem-q') { memQuery(t.value); var clr = pane.querySelector('[data-mm="mem-clear"]'); if (!t.value && clr) { var tl = el('mm-tools'); if (tl) tl.__view = ''; } return; }
    if (t.id === 'mm-ask-q') { S.ask.q = t.value; return; }
    if (t.id === 'mm-cue-note') { S.cue.notes[t.getAttribute('data-cue')] = t.value; return; }
    if (t.id === 'mm-folder') { S.folderDraft = t.value; return; }
    var dk = t.getAttribute('data-draft'); if (dk) S.drafts[dk] = t.type === 'checkbox' ? !!t.checked : t.value;
  });
  pane.addEventListener('submit', function (e) {
    var f = e.target, k = f && f.getAttribute && f.getAttribute('data-mm-form'); if (!k) return;
    e.preventDefault();
    if (k === 'mem-search') { clearTimeout(memTimer); var qi = el('mm-mem-q'); if (qi) { S.mem.q = qi.value; if (qi.blur) qi.blur(); } var tl = el('mm-tools'); if (tl) tl.__view = ''; loadMem(false); }
    else if (k === 'ask') ask();
    else if (k === 'folder') addFolder();
    else if (k === 'owner') saveOwner();
  });
  // Enter in a multi-line field writes a new line here: the shell's desktop rule (Enter submits a textarea's form) is
  // for chat boxes, and these lists are one pattern or one exclusion per line.
  pane.addEventListener('keydown', function (e) {
    if (cueKey(e)) { e.preventDefault(); return; }
    if (e.target && e.target.id === 'mm-cue-note' && (e.key === 'Enter' || e.key === 'Escape')) { e.preventDefault(); e.stopPropagation(); cueKeyboard = true; var cc = el('mm-cue-card'); if (cc) cc.focus({ preventScroll: true }); return; }
    if (e.key === 'Enter' && e.target && e.target.tagName === 'TEXTAREA') e.stopPropagation();
    if (e.key === 'Enter' && e.target && e.target.id === 'graphQuery') { e.preventDefault(); graphSearch(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || W.parseRoute().pane !== 'memories') return;
    if (S.modal) { e.preventDefault(); closeModal(); } else if (S.graphFull) { S.graphFull = false; paint(); }
  });
  // Folding or unfolding the Duo crosses 760px: the list and reader trade places by CSS, the reader fills in for the
  // wide layout, and the row being read is scrolled into view. Nothing reloads and the route stays as it was.
  var wideMq = window.matchMedia ? window.matchMedia('(min-width: 760px)') : null;
  function onWide() {
    if (W.parseRoute().pane !== 'memories' || !el('mm-root')) return;
    paint();
    var sel = pane.querySelector && pane.querySelector('.mm-row[aria-selected="true"]');
    if (sel && sel.scrollIntoView && isWide()) sel.scrollIntoView({ block: 'nearest' });
  }
  if (wideMq) { if (wideMq.addEventListener) wideMq.addEventListener('change', onWide); else if (wideMq.addListener) wideMq.addListener(onWide); }

  W.registerPane('memories', {
    load: function (args) {
      // #/memories/view/<view> (older links) and a bare #/memories become the tab's own address; an unknown tab, the stored one.
      if (args[0] === 'view' || !args.length || (args[0] === 't' && !knownView(args[1]))) {
        if (args[0] === 'view' && knownView(args[1])) { S.view = args[1]; persist(); }
        location.replace('#/memories/t/' + encodeURIComponent(S.view)); return;
      }
      if (tabRoute(args) && S.view !== args[1]) { S.view = args[1]; persist(); }
      if (args[0] === 'k') { S.view = 'knowledge'; if (KTABS.indexOf(args[1]) >= 0) { S.ktab = args[1]; S.ktabChosen = true; } persist(); }
      if (!S.started) loadAll();
      else if (S.graph && lockHeld(S.graph.lock)) watchIngest();
      if (S.view === 'memories' && !S.mem.loaded && !S.mem.loading) loadMem(false);
      if (S.view === 'applied' && !S.applied.loaded && !S.applied.loading) loadApplied(false);
      if (S.view === 'rated' && !S.cue.ratedLoaded && !S.cue.ratedBusy) loadCueRated();
      paint();
    },
    leave: function () {
      stopWatches(); S.graphFull = false;
      if (S.modal && S.modal.kind !== 'merge') closeModal();
      document.body.classList.remove('mm-modal-open'); document.body.classList.remove('mm-graph-open');
    },
    // Back from a reader lands on the tab it was opened from.
    up: function (args) { return tabRoute(args) ? null : ['t', S.view]; },
    // For the vm tests (web-control/memories-web.test.ts): the same functions taps and loads run.
    _t: { S: S, act: act, paint: paint, listHtml: listHtml, readerHtml: readerHtml, countsHtml: countsHtml, viewsHtml: viewsHtml, modalHtml: modalHtml,
      needsCount: needsCount, needsRows: needsRows, contextText: contextText, findRow: findRow, isRead: isRead, cleanTitle: cleanTitle, mergeFlow: mergeFlow,
      loadApplied: loadApplied, ask: ask, renderMarkdown: renderMarkdown, cueKey: cueKey, cueNote: cueNote, cueHttps: cueHttps }
  });
})();
