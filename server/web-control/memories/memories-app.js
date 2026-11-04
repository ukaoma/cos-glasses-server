/* COS Control · Memories (0.5.191).
   The reviewed prototype (operations/personal/wk36_2026/design/cos-control-learning/index.html),
   with every piece of demo state replaced by live data through the app's helper. This page never
   holds the server token: it posts {id, op, args} to the native host, which runs the helper and
   resolves the promise with {ok, message, details}. Actions without a backend tonight are shown
   disabled with the reason, never faked. */
(function () {
  'use strict';

  // ── bridge ──────────────────────────────────────────────────────
  var pending = {}, nextId = 1;
  function call(op, args) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.cos;
      if (handler) {
        try { handler.postMessage({ id: id, op: op, args: args || {} }); }
        catch (e) { delete pending[id]; reject(e); }
        return;
      }
      delete pending[id];
      var a = args || {};
      if (op === 'copy') {
        // A plain-http tailnet page has no navigator.clipboard. Fall back to a selected
        // textarea, and reject when both fail so the page never says "Copied" for nothing.
        var text = String(a.text || '');
        var viaTextarea = function () {
          var ta = document.createElement('textarea');
          ta.value = text; ta.setAttribute('readonly', '');
          ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
          var ok = false;
          try { ok = document.execCommand('copy'); } catch (_e) { ok = false; }
          document.body.removeChild(ta);
          if (ok) resolve({}); else reject(new Error('This browser would not copy. Select the text and copy it yourself.'));
        };
        if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { resolve({}); }, viaTextarea);
        else viaTextarea();
        return;
      }
      if (op === 'pick.folder') {
        var chosen = window.prompt('Enter folder path on your Mac for Knowledge to index:', '');
        if (chosen && chosen.trim()) resolve({ path: chosen.trim() });
        else reject(new Error('No folder chosen.'));
        return;
      }
      if (op === 'open.section' || op === 'cues.open') {
        try { window.parent.postMessage({ type: 'cos-control-nav', op: op, args: a }, window.location.origin); } catch (_e) {}
        resolve({});
        return;
      }
      if (op === 'memory.reveal') {
        reject(new Error('Revealing files in Finder is available in the Mac app.'));
        return;
      }
      // The browser session cookie is the only credential; this page never holds the token.
      var headers = { 'Content-Type': 'application/json', 'X-COS-Web': '1' };
      fetch('/api/web-bridge/memories', {
        method: 'POST',
        headers: headers,
        credentials: 'same-origin',
        body: JSON.stringify({ id: id, op: op, args: a })
      }).then(function (r) { return r.json(); }).then(function (payload) {
        if (payload && payload.ok) resolve(payload.details || {});
        else reject(new Error((payload && payload.message) || 'The server bridge did not answer.'));
      }).catch(function (err) {
        reject(err instanceof Error ? err : new Error('Not connected to COS Control server.'));
      });
    });
  }
  window.cosBridge = {
    resolve: function (id, payload) {
      var p = pending[id]; if (!p) return; delete pending[id];
      if (payload && payload.ok) p.resolve(payload.details || {});
      else p.reject(new Error((payload && payload.message) || 'The helper did not answer.'));
    },
    refresh: function () { loadAll(); },
    show: function (view) { if (view) { state.view = view === 'knowledge' ? 'knowledge' : 'learning'; if (view !== 'knowledge') state.filter = view; render(); } }
  };

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  var fmt = function (n) { return Number(n || 0).toLocaleString(); };
  function stamp(iso) { if (!iso) return ''; var d=new Date(iso); return isNaN(d.getTime()) ? String(iso) : d.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'})+' '+Intl.DateTimeFormat().resolvedOptions().timeZone; }
  function dateOnly(iso) { return iso ? String(iso).slice(0, 10) : ''; }
  function toast(text) { var el = document.querySelector('#toast'); el.textContent = text; el.classList.remove('hidden'); clearTimeout(window.toastTimer); window.toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 3400); }

  // ── state ───────────────────────────────────────────────────────
  var state = {
    view: 'learning', filter: 'recent', selected: null, knowledgeTab: 'graph', knowledgeFocus: null,
    status: null, learningStatus: null, graphStatus: null,
    recent: [], recentTotal: null, recentCursor: null, review: [], reviewCount: null, memories: [], memoriesTotal: null,
    memoryQuery: '', memoryHits: null, memoryCursor:null, memorySearchCursor:null, memoryPageCapable:false, coverage: {},
    cues: null,
    applied: [], appliedTotal: null, appliedCursor: null, appliedDays: 7, appliedCoverage: {}, appliedLoaded: false, appliedLoading: false,
    detail: {}, memoryDetail: {}, passages: {}, loading: {}, errors: {},
    graphFocus: null, graphFocusChosen: false, ingesting: null, ingestLimit: 10, ingestWatch: null, graphQuery: '',
    progress: null, fetchWatch: null, modalOpen: null, graphAsk: { q: '', busy: false, answer: null, error: null, cards: [], cardsBusy: false }, graphNeighbors: [], guardrails: null, guardrailsRun: null, guardrailsBusy: null, guardrailsLoading: false, guardrailsError: null, guardrailsRubricLines: 0, memoryReviewBusy: null, setup: null, setupLoading: false, setupError: null, setupBusy: null, armed: null, askQ: '', askAnswer: null, askBusy: false, knowledgeTabChosen: false, graphController: null, copyId: null, copyOptions: { sources: true, graph: false }
  };

  // ── loading ─────────────────────────────────────────────────────
  function loadAll() {
    state.errors = {};
    call('status').then(function (d) { state.status = d; chooseDefaultFocus(); render(); }, function (e) { state.errors.status = e.message; render(); });
    loadLearning(false);
    loadReview(false);
    loadMemoryPage(false);
    loadApplied(false);
    loadCues();

    loadGraphStatus();
  }
  // 0.5.327: Cues to rate and Rated cues. The app answers from its own cue store; the two entries show only when it says
  // the server keeps a cue history (`available`), and either opens the app's native cue review, never a page view.
  function loadCues() {
    call('cues.summary').then(function (d) { state.cues = d && d.available === true ? d : null; render(); },
      function () { state.cues = null; render(); });
  }
  var memoryRequestSerial=0,learningRequestSerial=0,policyRequestSerial=0;
  function loadMemoryPage(more) {
    if(more&&state.memoryPageLoading)return Promise.resolve();
    var serial=++memoryRequestSerial;state.memoryPageLoading=true;
    var q=state.memoryQuery.trim(),cursor=more?(q?state.memorySearchCursor:state.memoryCursor):null;
    return call('workspace.request',{action:'memory_page',q:q,limit:25,cursor:cursor}).then(function(d){
      if(serial!==memoryRequestSerial||state.memoryQuery.trim()!==q)return;
      if(d.protocol!==1||!Array.isArray(d.items))throw new Error('Paged memory is unavailable in this version.');
      state.memoryPageCapable=true;
      if(q){state.memoryHits=more?(state.memoryHits||[]).concat(d.items):d.items;state.memorySearchCursor=d.next_cursor;}
      else{state.memoryHits=null;state.memories=more?state.memories.concat(d.items):d.items;state.memoriesTotal=d.matched_total;state.memoryCursor=d.next_cursor;}
      render();
    }).catch(function(error){
      if(serial!==memoryRequestSerial||state.memoryQuery.trim()!==q)return;
      if(more){toast(error.message+' Restart this lookup to refresh its snapshot.');return;}
      state.memoryPageCapable=false;
      return call(q?'memories.search':'memories.list',q?{q:q,limit:20}:{limit:50}).then(function(d){
        if(serial!==memoryRequestSerial||state.memoryQuery.trim()!==q)return;
        if(q)state.memoryHits=d.hits||[];else{state.memoryHits=null;state.memories=d.memories||[];state.memoriesTotal=d.total;}
        render();
      },function(e){if(serial!==memoryRequestSerial)return;state.errors.memories=e.message;render();});
    }).finally(function(){if(serial===memoryRequestSerial)state.memoryPageLoading=false;});
  }
  // The graph opens on the person this COS is about (the profile's owner_name,
  // resolved through a search so the entity's exact spelling wins), not on "COS".
  // A focus the user picks or recenters on is never overridden.
  function chooseDefaultFocus() {
    var name = state.status && state.status.ownerName;
    if (!name || state.graphFocusChosen || state.graphFocusResolved) return;
    state.graphFocusResolved = true;
    call('graph.search', { q: name, limit: 5 }).then(function (d) {
      var items = d.items || [];
      var exact = items.find(function (it) { return String(it.id).toLowerCase() === String(name).toLowerCase(); });
      var pick = exact || items.find(function (it) { return String(it.type || '').toLowerCase() === 'person'; }) || items[0];
      if (pick && !state.graphFocusChosen && state.status && state.status.ownerName === name) { state.graphFocus = pick.id; if (state.view === 'knowledge' && state.knowledgeTab === 'graph') render(); }
    }, function () {});
  }
  // While the ingest lock is held, read the run's progress every 5 s (and the
  // Sync card every 15 s), four hours at most; when the lock frees, say what
  // the run indexed and what is still queued. A run started elsewhere holds
  // the lock but writes no log here, so it shows as external with the counts.
  function watchIngest() {
    if (state.ingestWatch) return;
    var before = state.graphStatus && state.graphStatus.queue ? Number(state.graphStatus.queue.pending) : null, ticks = 0;
    function finish() {
      clearInterval(state.ingestWatch); state.ingestWatch = null;
      var pr = state.progress || {};
      loadGraphStatus().then(function () {
        var g = state.graphStatus || {}, after = g.queue ? Number(g.queue.pending) : null;
        var done = pr.done ? fmt(pr.done) + ' indexed' + (pr.failed ? ', ' + fmt(pr.failed) + ' failed' : '') : (before != null && after != null && before > after ? fmt(before - after) + ' indexed' : 'Indexing finished');
        state.ingesting = { note: done + (after != null ? ' · ' + fmt(after) + ' still queued' : '') };
        if (state.knowledgeTab === 'setup') loadSetup();
        setTimeout(function () { state.ingesting = null; if (state.view === 'knowledge') render(); }, 60000);
        if (state.view === 'knowledge') render();
      });
    }
    function tick() {
      ticks++;
      var reads = [call('graph.progress').then(function (d) { state.progress = d; }, function () {})];
      if (ticks % 3 === 0) reads.push(loadGraphStatus());
      Promise.all(reads).then(function () {
        var pr = state.progress || {}, g = state.graphStatus || {}, lk = pr.lock || g.lock || {};
        var held = pr.running === true || lk.state === 'exclusive' || lk.state === 'shared';
        if (!held || ticks > 2880) return finish();
        if (state.view === 'knowledge') render();
      });
    }
    state.ingestWatch = setInterval(tick, 5000); tick();
  }
  // The run as it stands: the Sync card and the setup's sample step both show it.
  function progressBlock() {
    var pr = state.progress, g = state.graphStatus || {}, lk = (pr && pr.lock) || g.lock || {};
    var held = (pr && pr.running === true) || lk.state === 'exclusive' || lk.state === 'shared';
    if (!held) return '';
    if (!pr) return '<div class="ingest-progress"><b>Indexing now</b><span class="muted"> · reading progress…</span></div>';
    var head, body = '';
    if (pr.external) head = '<b>Indexing now from another session</b>' + (pr.pid ? ' (pid ' + esc(pr.pid) + ')' : '') + ' · ' + fmt(pr.pending || 0) + ' pending · progress detail shows for runs started here';
    else {
      var seen = pr.done + pr.failed + (pr.current ? 1 : 0);
      head = '<b>Indexing ' + (pr.total != null ? fmt(Math.min(seen, pr.total)) + ' of ' + fmt(pr.total) : 'now') + '</b>' + (pr.pid ? ' (pid ' + esc(pr.pid) + ')' : '') + ' · ' + fmt(pr.pending || 0) + ' pending';
      if (pr.current) body += '<div class="muted">Now: ' + esc(pr.current.id) + (pr.current.est_calls != null ? ' · about ' + fmt(pr.current.est_calls) + ' calls' : '') + '</div>';
    }
    if (pr.items && pr.items.length) body += '<div class="ingest-items">' + pr.items.slice(-4).map(function (it) { return '<span class="' + (it.outcome === 'indexed' ? 'ok' : it.outcome === 'failed' ? 'bad' : '') + '">' + (it.outcome === 'indexed' ? '✓ ' : it.outcome === 'failed' ? '! ' : '') + esc(it.id) + (it.seconds != null ? ' ' + Math.round(it.seconds) + ' s' : '') + '</span>'; }).join('') + '</div>';
    if (pr.budget) body += '<div class="muted">Budget: ' + fmt(pr.budget.used) + ' of ' + fmt(pr.budget.cap) + ' calls today</div>';
    if (pr.log_tail && pr.log_tail.length) body += '<details class="ingest-log"><summary>Show log</summary><pre>' + esc(pr.log_tail.join('\n')) + '</pre></details>';
    return '<div class="ingest-progress" aria-live="polite"><div>' + head + '</div>' + body + '</div>';
  }
  function loadGraphStatus() {
    return call('graph.status').then(function (d) { state.graphStatus = d; state.errors.graph = null; var lk = d.lock || {}; if (lk.state === 'exclusive' || lk.state === 'shared') watchIngest(); if (d.entities == null && !state.knowledgeTabChosen) state.knowledgeTab = 'setup'; render(); }, function (e) { state.errors.graph = e.message; render(); });
  }
  function loadLearning(more) {
    if(more&&state.learningPageLoading)return Promise.resolve();
    var serial=++learningRequestSerial;state.learningPageLoading=true;
    return call('workspace.request',{action:'learning_page',days:90,limit:50,cursor:more?state.recentCursor:null}).then(function(d){
      if(serial!==learningRequestSerial)return;
      if(d.protocol!==1||!Array.isArray(d.items))throw new Error('Snapshot browsing unavailable in this version.');
      state.learningPageCapable=true;state.recent=more?state.recent.concat(d.items):d.items;seedDecisions(d.items);
      state.recentTotal=d.matched_total;state.recentCursor=d.next_cursor;state.coverage=d.coverage||{};
      state.learningStatus=d;render();
    }).catch(function(error){
      if(serial!==learningRequestSerial)return;
      if(more&&state.learningPageCapable){toast(error.message+' Refresh recent learning to start a new snapshot.');return;}
      state.learningPageCapable=false;
      var args={days:90,limit:50};if(more){args.sinceTs=state.recentCursor.since_ts;args.sinceEventId=state.recentCursor.since_event_id;}
      return call('learning.list',args).then(function(d){
        if(serial!==learningRequestSerial)return;
        state.recent=more?state.recent.concat(d.events||[]):d.events||[];seedDecisions(d.events);state.recentTotal=d.total;
        state.recentCursor=d.nextCursor;state.coverage=d.coverage||{};
        state.learningStatus={counts_by_type:{},stores:{},complete:false,notice:'Activity totals unavailable in this server version. The list uses a 90-day window.'};render();
      },function(e){if(serial!==learningRequestSerial)return;state.errors.recent=e.message;render();});
    }).finally(function(){if(serial===learningRequestSerial)state.learningPageLoading=false;});
  }
  function loadMore() {if(state.recentCursor)loadLearning(true);}
  // ── Applied this week (0.5.216) ─────────────────────────────────
  // The helper's `--kind used` window, never the first Recent page filtered
  // in JS: a use that is not on page 1 must still be listed. Fails closed:
  // an error or an unreadable trace leaves the list empty with its reason.
  var appliedRequestSerial=0;
  function loadApplied(more){
    if(more&&(state.appliedLoading||!state.appliedCursor))return Promise.resolve();
    var serial=++appliedRequestSerial;state.appliedLoading=true;
    var args={kind:'used',days:state.appliedDays,limit:50};
    if(more){args.sinceTs=state.appliedCursor.since_ts;args.sinceEventId=state.appliedCursor.since_event_id;}
    return call('learning.list',args).then(function(d){
      if(serial!==appliedRequestSerial)return;
      var events=d.events||[];
      // Fail closed: a server that ignored `kind` returns the whole window. Never label that Applied.
      if(events.some(function(e){return e.event_type!=='used';})){state.applied=[];state.appliedTotal=null;state.appliedCursor=null;state.appliedLoaded=true;state.errors.applied='This server returned unfiltered learning rows. Applied stays empty rather than mislabel them.';render();return;}
      var seen={};state.applied.forEach(function(e){seen[e.event_id]=true;});
      var rows=events.filter(function(e){if(seen[e.event_id])return false;seen[e.event_id]=true;return true;});
      state.applied=more?state.applied.concat(rows):rows;state.appliedTotal=d.total;state.appliedCursor=d.nextCursor;
      state.appliedCoverage=d.coverage||{};state.appliedLoaded=true;state.errors.applied=null;
      state.applied.forEach(function(e){if(e.lesson_id)ensureMemoryDetail(e.lesson_id);});
      render();
    },function(e){if(serial!==appliedRequestSerial)return;state.errors.applied=e.message;state.appliedLoaded=true;render();})
    .finally(function(){if(serial===appliedRequestSerial)state.appliedLoading=false;});
  }
  function setAppliedDays(days){state.appliedDays=days===90?90:7;state.applied=[];state.appliedCursor=null;state.appliedTotal=null;state.appliedLoaded=false;loadApplied(false);render();}
  var reviewRequestSerial=0;
  function loadReview(more){
    if(more&&state.reviewLoading)return;var serial=++reviewRequestSerial;state.reviewLoading=true;
    return call('workspace.request',{action:'review_page',limit:25,cursor:more?state.reviewCursor:null}).then(function(d){
      if(serial!==reviewRequestSerial)return;
      state.review=more?state.review.concat(d.items):d.items;seedDecisions(d.items);state.reviewCount=d.matched_total;state.reviewCursor=d.next_cursor;render();
    }).catch(function(e){
      if(serial!==reviewRequestSerial)return;if(more){toast(e.message+' Refresh review to start a new snapshot.');return;}
      return call('learning.review',{limit:200}).then(function(d){if(serial!==reviewRequestSerial)return;state.review=d.events||[];state.reviewCount=d.reviewCount!=null?d.reviewCount:d.total;render();},function(error){state.errors.review=error.message;render();});
    }).finally(function(){if(serial===reviewRequestSerial)state.reviewLoading=false;});
  }
  function reviewGoverned(id,decision){
    if(state.memoryReviewBusy)return;
    var row=state.review.concat(state.recent).find(function(e){return e.lesson_id===id&&e.governance;}),intent=state.reviewIntent;
    if(row&&state.detail[row.event_id]&&state.detail[row.event_id].journal_revision)row=Object.assign({},row,state.detail[row.event_id]);
    if(!row)throw new Error('Refresh the review list before changing this memory.');
    if(decision==='forget'&&state.armed!=='forget:'+id){state.armed='forget:'+id;toast('Click Forget permanently again. Searchable content will be removed; external sources and protected backups are reported separately.');render();return;}
    if(!intent)intent=state.reviewIntent={action:'review_memory',id:id,decision:decision,expected_revision:row.journal_revision,idempotency_key:'review_'+crypto.randomUUID()};
    if(intent.id!==id||intent.decision!==decision){toast('Retry the pending review action before starting another.');return;}
    state.memoryReviewBusy=id;render();
    call('workspace.request',intent).then(function(d){
      state.memoryReviewBusy=null;state.reviewIntent=null;state.armed=null;state.detail={};state.memoryDetail={};
      toast(d.status==='deletion_pending_projection'?'Forgotten content is suppressed; projection cleanup is pending.':decision==='forget'?'Searchable memory removed. External sources and protected backups remain.':'Memory '+(d.state||d.status)+'.');
      loadReview(false);loadLearning(false);loadMemoryPage(false);
    },function(e){state.memoryReviewBusy=null;if(/revision_conflict|idempotency_conflict|memory_not_found/.test(e.message)){state.reviewIntent=null;state.detail={};state.memoryDetail={};loadReview(false);loadLearning(false);loadMemoryPage(false);}toast(e.message);render();});
  }
  function ensureDetail(id) {
    if (!id || state.detail[id] || state.loading[id]) return;
    state.loading[id] = true;
    var governed=state.review.concat(state.recent).find(function(e){return e.event_id===id&&e.governance;});
    if(governed){call('workspace.request',{action:'get_memory',id:governed.lesson_id}).then(function(d){state.detail[id]={detail:{content:d.item.payload.content},governance:d.item.state,journal_revision:d.item.revision};delete state.loading[id];render();},function(e){state.detail[id]={_error:e.message};delete state.loading[id];render();});return;}
    call('learning.event', { id: id }).then(function (d) { state.detail[id] = d; delete state.loading[id]; render(); }, function (e) { state.detail[id] = { _error: e.message }; delete state.loading[id]; render(); });
  }
  function ensureMemoryDetail(id) {
    if (!id || state.memoryDetail[id] || state.loading['m:' + id]) return;
    state.loading['m:' + id] = true;
    call('memory.detail', { id: id }).then(function (d) { state.memoryDetail[id] = d; delete state.loading['m:' + id]; render(); }, function (e) { state.memoryDetail[id] = { _error: e.message }; delete state.loading['m:' + id]; render(); });
  }

  // ── rows ────────────────────────────────────────────────────────
  var KIND = { captured: 'Captured', proposed: 'Proposed', promotable: 'Promotable pattern', saved: 'Saved', retrieved: 'Retrieved', used: 'Application recorded', included:'Included in context', applied:'Application evidence', checked: 'Checked', dismissed: 'Dismissed', reverted: 'Reverted', reopened: 'Reopened', consolidated: 'Consolidated', previewed: 'Previewed', accepted: 'Accepted', pruned: 'Pruned' };
  var STORE = { self_improvement_queue: 'Self-improvement queue', correction_journal: 'Correction journal', bot_memory: 'Bot memory', review_ledger: 'Review ledger', git_versions: 'Skill versions', eval_scores: 'Eval scores', reflect_log: 'Reflect log', capture_ledger: 'Capture ledger' };
  function isProposal(e) { return e && e.target && e.target.kind === 'task-proposal'; }
  function isPattern(e) { return e && (e.event_type === 'promotable' || (e.target && e.target.kind === 'pattern')); }
  // A review decision survives a reload (0.5.257): the ledger's pruned/accepted events seed the map memoryActions
  // reads. Before, a reload forgot every prune and offered Accept and Prune on a memory already out of recall.
  // The newest decision per memory wins; one made in this session is stamped now, so a stale seed never undoes it.
  function seedDecisions(rows) {
    state.decisions = state.decisions || {}; state.decisionTs = state.decisionTs || {};
    (rows || []).forEach(function (e) {
      if (!e || e.store !== 'review_ledger' || !e.lesson_id || (e.event_type !== 'pruned' && e.event_type !== 'accepted')) return;
      var ts = String(e.ts || '');
      if (state.decisionTs[e.lesson_id] && state.decisionTs[e.lesson_id] >= ts) return;
      state.decisionTs[e.lesson_id] = ts; state.decisions[e.lesson_id] = e.event_type;
    });
  }
  // Prune ready (0.5.257): memories `bot_memory.py prune` would quarantine now, listed in To review by the bridge
  // as captured memories whose category starts with this label and carries the reason.
  var PRUNE_READY = 'Prune ready';
  function isPruneReady(e) { return !!e && e.store === 'bot_memory' && typeof e.category === 'string' && e.category.indexOf(PRUNE_READY) === 0; }
  function pruneReadyReason(e) { var c = String(e.category || ''); return c.indexOf(' · ') > 0 ? c.slice(c.indexOf(' · ') + 3) : ''; }
  function kindLabel(e) { if (e && e.store === 'bot_memory' && e.event_type === 'captured' && latestDecisionFor(e) === 'pruned') return 'Quarantined'; if (isPruneReady(e) && !latestDecisionFor(e)) return PRUNE_READY; if (isProposal(e)) return 'Task proposal'; if (isPattern(e)) return 'Promotable pattern'; return KIND[e.event_type] || e.event_type || 'Event'; }
  function outcomeText(e) { var o = e && e.outcome; if (!o) return null; if (typeof o === 'string') return o; return o.result ? (o.result + (o.name ? ' · ' + o.name : '')) : null; }
  function rowStatus(e) {
    var o = outcomeText(e);
    if (o) { var result=typeof e.outcome==='object'?e.outcome.result:e.outcome; return { text:'Checked: '+o, color: /^(pass|passed|success)$/.test(result)?'green':/^(fail|failed)$/.test(result)?'bad':'' }; }
    if (isProposal(e) || isPattern(e)) return { text: 'Needs your review', color: '' };
    if (e.event_type === 'dismissed') return { text: 'Dismissed', color: '' };
    if (e.event_type === 'retrieved') return {text:'Retrieved · application unverified',color:''};
    if (e.event_type === 'included') return {text:'Included in context · application unverified',color:''};
    if (e.event_type === 'applied' || e.event_type === 'used') return {text:'Application evidence recorded',color:''};
    return { text: 'Saved · No later use', color: '' };
  }
  function lessonRow(e, selected) {
    var st = rowStatus(e);
    var meta = [STORE[e.store] || e.store, e.scope, stamp(e.ts)].filter(Boolean).join(' · ');
    return '<button class="lesson ' + (selected ? 'selected' : '') + '" onclick="cosApp.select(' + attr(e.event_id) + ')" aria-pressed="' + (selected ? 'true' : 'false') + '"><div class="kind">' + esc(kindLabel(e)) + '</div><span class="title">' + esc(e.title || '(untitled)') + '</span><div class="meta">' + esc(meta) + '</div><span class="status ' + st.color + '">' + esc(st.text) + '</span></button>';
  }
  function memoryRow(m, selected) {
    var title = m.summary || m.content || '(untitled)';
    var meta = [m.type, dateOnly(m.created_at)].filter(Boolean).join(' · ');
    return '<button class="lesson ' + (selected ? 'selected' : '') + '" onclick="cosApp.selectMemory(' + attr(m.id) + ')" aria-pressed="' + (selected ? 'true' : 'false') + '"><div class="kind">Memory</div><span class="title">' + esc(String(title).slice(0, 140)) + '</span><div class="meta">' + esc(meta) + '</div></button>';
  }

  // ── summary and nav ─────────────────────────────────────────────
  // Needs-you (gated, cap 7). Never review_page matched_total / SIQ to_review.
  function needsYouCount() {
    var s = state.status || {}, ls = state.learningStatus || {}, ny = ls.needs_you || s.needs_you;
    if (Array.isArray(state.needsYou)) return state.needsYou.length;
    if (Array.isArray(s.needsYou)) return s.needsYou.length;
    if (ny && Array.isArray(ny.items)) return ny.items.length;
    if (ny && ny.count != null) return ny.limit != null ? Math.min(Number(ny.count), Number(ny.limit)) : Number(ny.count);
    if (s.learningNeedsYou != null) return s.learningNeedsYou;
    if (s.learningToReview != null) return s.learningToReview;
    return null;
  }
  // Reward is a ranking tiebreaker inside the startup hook. The page may say a
  // lesson moved ranking only on the projector's literal flag, and never a number.
  function rewardEnabled() { var s = state.status || {}; return s.learningRewardEnabled === true; }
  // One sentence, one place. Present tense, no magnitude: the hook applies a bounded
  // tiebreaker, not an observed reorder, so the page never says a rank 'moved'.
  function rankingSentence() { return rewardEnabled() ? '<p>This lesson now ranks ahead of unused memories like it in later recall.</p>' : ''; }
  // The parsed count travels in the projector title (list rows carry no detail block).
  function appliedCountFromTitle(e) { var m = /Applied\s+([\d,]+)\s+time/.exec(String((e && e.title) || '')); return m ? Number(m[1].replace(/,/g, '')) : null; }
  function bridgeConnected() { var s = state.status || {}; return !!s.contextScriptsDirectory; }
  // The memory path this install chose. Only the COS Data bridge (vector store)
  // has an `applied` detector; files, document links, and Knowledge do not.
  function memoryPath() {
    var s = state.status || {}, g = state.graphStatus || {};
    if (bridgeConnected()) return 'bridge';
    if (g.entities != null || g.engine) return 'knowledge';
    return 'files';
  }
  function memoryNav() {
    var review = needsYouCount();
    document.querySelector('#workspace').classList.toggle('knowledge', state.view === 'knowledge');
    document.querySelector('#memoryNav').innerHTML = [['recent', 'Recent learning'], ['applied', 'Applied this week'], ['memories', 'All memories'], ['review', 'To review' + (review ? ' (' + fmt(review) + ')' : '')]].map(function (p) {
      var on = state.view !== 'knowledge' && state.filter === p[0];
      return '<button class="' + (on ? 'active' : '') + '" aria-pressed="' + on + '" onclick="cosApp.setFilter(\'' + p[0] + '\')">' + p[1] + '</button>';
    }).join('') + (state.cues ? '<button onclick="cosApp.openCues(\'rate\')">Cues to rate' + (typeof state.cues.unrated === 'number' && state.cues.unrated > 0 ? ' (' + fmt(state.cues.unrated) + ')' : '') + '</button>' +
      '<button onclick="cosApp.openCues(\'rated\')">Rated cues</button>' : '') +
      '<button class="' + (state.view === 'knowledge' ? 'active' : '') + '" aria-pressed="' + (state.view === 'knowledge') + '" onclick="cosApp.openKnowledge()">Knowledge</button>';
  }
  function summary() {
    var review = needsYouCount();
    var checked = state.recent.filter(function (e) { return outcomeText(e); }).length;
    var parts = [];
    if (review) parts.push('<span><strong>' + fmt(review) + ' change' + (review === 1 ? '' : 's') + '</strong> to review</span>');
    if (state.recentTotal != null) parts.push('<span><strong>' + fmt(state.recentTotal) + ' event' + (state.recentTotal === 1 ? '' : 's') + '</strong> in 90 days</span>');
    parts.push('<span><strong>' + fmt(checked) + ' result' + (checked === 1 ? '' : 's') + '</strong> checked on this page</span>');
    parts.push('<span>Capture status in settings · <button class="link" onclick="cosApp.openLog()">View activity log</button></span>');
    document.querySelector('#summary').innerHTML = parts.join('');
    var s = state.status || {};
    document.querySelector('#storage').textContent = state.status ? ('Stored on this Mac · ' + (bridgeConnected() ? 'Advanced search connected' : 'Plain files')) : 'Stored on this Mac';
    document.querySelector('#footnote').textContent = state.status ? ('Server ' + (s.installedVersion || '') + ' · ' + (s.runtimeState || '')).trim() : '';
  }

  // ── render ──────────────────────────────────────────────────────
  function render() {
    summary(); memoryNav();
    if (state.view === 'knowledge') { renderKnowledge(); return; }
    var inbox = document.querySelector('#inbox'), detail = document.querySelector('#detail');
    document.querySelector('#workspace').style.gridTemplateColumns = ''; inbox.classList.remove('hidden');
    if (state.filter === 'memories') { renderMemories(inbox, detail); return; }
    if (state.filter === 'applied') { renderApplied(inbox, detail); return; }
    var rows = state.filter === 'review' ? state.review : state.recent;
    var err = state.filter === 'review' ? state.errors.review : state.errors.recent;
    var loading = state.filter === 'review' ? (state.reviewCount == null && !err) : (state.recentTotal == null && !err);
    if (rows.length && !rows.some(function (x) { return x.event_id === state.selected; })) state.selected = rows[0].event_id;
    inbox.innerHTML = '<div class="date">' + (state.filter === 'recent' ? 'RECENT LEARNING · 90 DAYS' : 'PROPOSED CHANGES') + '</div>' +
      (err ? '<div class="host-state"><div><h3>Not available</h3><p>' + esc(err) + '</p><button onclick="cosApp.refresh()">Retry</button></div></div>' : '') +
      (loading ? '<div class="host-state">Loading…</div>' : '') +
      (state.filter === 'review' ? reviewRows(rows) : rows.map(function (e) { return lessonRow(e, e.event_id === state.selected); }).join('')) +
      (state.filter === 'recent' && state.recentCursor ? '<div class="actions"><button class="quiet" onclick="cosApp.loadMore()">Load more</button></div>' : '') +
      (state.filter==='review'&&state.reviewCursor?'<button onclick="cosApp.loadMoreReview()">Load more review items</button>':'')+coverageNote();
    if (!rows.length) {
      detail.innerHTML = loading ? '<div class="host-state">Loading…</div>' : (err ? '' : '<div class="empty"><div><h2>You’re up to date.</h2><p>' + (state.filter === 'review' ? 'No proposed changes are waiting for review.' : 'Nothing learned in the last 90 days.') + '</p>' + (state.filter === 'review' ? '<button onclick="cosApp.setFilter(\'recent\')">View recent learning</button>' : '') + '</div></div>');
      return;
    }
    var event = rows.find(function (x) { return x.event_id === state.selected; });
    ensureDetail(event.event_id);
    var full = state.detail[event.event_id];
    detail.innerHTML = detailActions(event) + lessonDetail(Object.assign({}, event, full && !full._error ? full : {}), full);
  }
  function reviewRows(rows) {
    var other = rows.filter(function (e) { return !isPruneReady(e); }), ready = rows.filter(isPruneReady);
    var open = ready.filter(function (e) { return !latestDecisionFor(e); }).length, b = state.bulkPrune;
    var head = !ready.length ? '' : '<div class="date">' + esc(PRUNE_READY.toUpperCase()) + ' · ' + (open ? fmt(open) : 'ALL DECIDED') + '</div>' +
      (b ? '<p class="muted" style="padding:0 9px">Quarantining ' + fmt(b.done) + ' of ' + fmt(b.total) + '…</p>' :
        open ? '<div class="actions" style="padding:0 9px 8px"><button class="quiet" onclick="cosApp.pruneAllReady()">' +
          (state.armed === 'prune-ready' ? 'Click again to quarantine ' + fmt(open) : 'Quarantine all ' + fmt(open)) + '</button></div>' : '');
    var line = function (e) { return lessonRow(e, e.event_id === state.selected); };
    return other.map(line).join('') + head + ready.map(line).join('');
  }
  function coverageNote() {
    var gaps = Object.keys(state.coverage || {}).filter(function (k) { return state.coverage[k] && state.coverage[k].state !== 'ok'; });
    if (!gaps.length) return '';
    return '<p class="muted" style="font-size:10px;padding:10px 9px 0">Not instrumented: ' + esc(gaps.map(function (k) { return k + ' (' + state.coverage[k].state + ')'; }).join(', ')) + '</p>';
  }

  // ── lesson detail (the reviewed timeline) ───────────────────────
  function event(title, meta, body, done, last) { return '<section class="event ' + (done !== false ? 'complete' : '') + ' ' + (last ? 'last' : '') + '"><div class="row spread"><h3>' + title + '</h3><span class="meta">' + meta + '</span></div>' + body + '</section>'; }
  function detailActions(e) {
    return '<div class="context-actions row spread"><span class="eyebrow">' + esc(STORE[e.store] || e.store || '') + '</span><div class="row"><button class="quiet" onclick="cosApp.openKnowledge(' + attr(e.event_id) + ')">Open sources</button><button class="quiet" onclick="cosApp.exploreInGraph(' + attr(e.event_id) + ')">Explore in graph</button><button onclick="cosApp.openCopyContext(' + attr(e.event_id) + ')">Copy context</button></div></div>';
  }
  function sourceEvent(e) {
    var ref = (e.source_refs || [])[0] || {};
    var d = e.detail || {};
    var quote = ref.excerpt || d.content || (d.bodies || [])[0] || '';
    var title = e.store === 'correction_journal' ? 'You corrected COS' : e.store === 'self_improvement_queue' ? 'A task proposed a change' : e.store === 'bot_memory' ? 'COS captured this' : e.store === 'eval_scores' || e.store === 'reflect_log' ? 'A run was checked' : 'Captured';
    var open = e.store === 'bot_memory' && e.lesson_id ? '<button class="link" onclick="cosApp.openMemoryRecord(' + attr(e.lesson_id) + ')">Open source record</button>' : (ref.id ? '<span class="meta">' + esc(ref.kind || '') + ' · ' + esc(ref.id) + '</span>' : '');
    return event(title, esc(stamp(e.ts) || 'Source'), (quote ? '<div class="quote">' + esc(quote) + '</div>' : '<p>No excerpt was stored with this record.</p>') + open + memoryActions(e));
  }
  // Accept activates; quality quarantine retains content. Forget is a separate explicit action.
  // Both become timeline events; nothing else in the store is touched (0.5.201).
  function memoryActions(e) {
    if(e.governance){var busy=state.memoryReviewBusy===e.lesson_id;
      return '<p>State: '+esc(e.governance)+' · revision '+esc(e.journal_revision)+'</p><div class="row">'+
        [['accept','Accept for recall'],['quarantine','Quarantine'],['restore','Restore to recall'],['forget','Forget permanently']].map(function(pair){
          if(pair[0]==='accept'&&e.governance!=='candidate'||pair[0]==='restore'&&e.governance!=='quarantined'||pair[0]==='quarantine'&&e.governance==='quarantined')return '';
          return '<button '+(busy?'disabled':'')+' onclick="cosApp.reviewGoverned('+attr(e.lesson_id)+','+attr(pair[0])+')">'+pair[1]+'</button>';
        }).join('')+'</div>';
    }
    if (e.store !== 'bot_memory' || !e.lesson_id || e.event_type !== 'captured') return '';
    var decision = latestDecisionFor(e);
    var busy = state.memoryReviewBusy === e.lesson_id;
    if (decision === 'pruned') return '<p class="muted">Quarantined from active recall. Content is retained for review.</p>' +
      '<div class="actions"><button ' + (busy ? 'disabled' : '') + ' onclick="cosApp.reviewMemory(' + attr(e.lesson_id) + ', \'restore\')">' + (busy ? 'Working…' : 'Restore to recall') + '</button></div>';
    var armed = state.armed === 'prune:' + e.lesson_id;
    return (isPruneReady(e) && !decision ? '<p class="muted">' + esc(PRUNE_READY) + (pruneReadyReason(e) ? ': ' + esc(pruneReadyReason(e)) : '') + '. Accept keeps it in recall and stops it being proposed again; Prune takes it out of recall, and Restore brings it back.</p>' : '') +
      '<div class="actions">' +
      (decision === 'accepted' ? '<span class="pill ok">Accepted</span>' : '<button ' + (busy ? 'disabled' : '') + ' onclick="cosApp.reviewMemory(' + attr(e.lesson_id) + ', \'accept\')">' + (busy ? 'Working…' : 'Accept') + '</button>') +
      '<button class="quiet" ' + (busy ? 'disabled' : '') + ' onclick="cosApp.reviewMemory(' + attr(e.lesson_id) + ', \'prune\')">' + (armed ? 'Click again to prune' : 'Prune') + '</button>' +
      '</div>';
  }
  function changeEvent(e, full) {
    var d = e.detail || {};
    var proposal = isProposal(e), pattern = isPattern(e);
    var applies = (e.applies_to || []).map(function (a) { return typeof a === 'string' ? a : [a.name || a.path || a.id, a.cadence].filter(Boolean).join(' · '); }).filter(Boolean);
    var body = '';
    if (proposal) {
      body += '<p>Proposed by <b style="color:var(--fg)">' + esc(d.task || e.category || 'a scheduled task') + '</b>' + (d.layer ? ' · layer ' + esc(d.layer) : '') + (d.date ? ' · ' + esc(d.date) : '') + '.</p>';
      body += (d.entry || d.content ? '<div class="quote">' + esc(d.entry || d.content) + '</div>' : '') + (d.bodies || []).map(function (b) { return '<p>' + esc(b) + '</p>'; }).join('');
      if (d.logged_times) body += '<p>Logged ' + fmt(d.logged_times) + ' time' + (d.logged_times === 1 ? '' : 's') + '.</p>';
    } else if (d.before || d.after || d.rule) {
      body += '<div class="change">' + (d.before ? '<div><label>Before</label>' + esc(d.before) + '</div>' : '') + '<div class="after"><label>' + (d.after ? 'After' : 'Rule') + '</label>' + esc(d.after || d.rule || '') + '</div></div>';
      if (d.rule && d.after) body += '<p style="margin-top:8px"><b style="color:var(--fg)">Rule</b> ' + esc(d.rule) + '</p>';
    } else if (d.content) {
      body += '<div class="quote">' + esc(d.content) + '</div>';
    } else {
      body += '<p>' + esc(e.title || '') + '</p>';
    }
    if (e.target && e.target.version) body += '<p>Version <b style="color:var(--fg)">' + esc(e.target.version) + '</b></p>';
    body += effectBlock(e, applies);
    var decision = latestDecisionFor(e);
    var actions = '';
    if (proposal || pattern) {
      var dismissed = decision === 'dismissed';
      actions = '<div class="actions">' +
        '<button class="primary" onclick="cosApp.openStewardship()">Review rule versions</button>' +
        '<button disabled title="Editing a proposed instruction arrives with skill versioning.">Edit</button>' +
        (dismissed
          ? '<button onclick="cosApp.decide(' + attr(e.event_id) + ',\'reopened\')">Restore proposal</button>'
          : '<button class="quiet" onclick="cosApp.decide(' + attr(e.event_id) + ',\'dismissed\')">Dismiss</button>') +
        '</div>';
    }
    var title = decision === 'dismissed' ? 'Change dismissed' : proposal ? 'Proposed change' : e.event_type === 'promotable' ? 'Promotable pattern' : (KIND[e.event_type] || 'Change');
    return event(title, proposal ? 'Instruction' : esc(e.engine || e.scope || ''), body + actions);
  }
  function latestDecisionFor(e) { return state.decisions && state.decisions[e.lesson_id]; }
  function isUseType(e) {
    return e && (e.event_type === 'used' || e.event_type === 'checked' || e.event_type === 'retrieved' || e.event_type === 'included' || e.event_type === 'applied');
  }
  function relatedUseRows(e) {
    var id = e && e.lesson_id, rows = [], seen = {};
    function take(row) {
      if (!row || seen[row.event_id] || !isUseType(row)) return;
      if (id && row.lesson_id === id) { seen[row.event_id] = true; rows.push(row); }
    }
    (state.recent || []).forEach(take);
    (state.review || []).forEach(take);
    if (isUseType(e) && !seen[e.event_id]) rows.push(e);
    rows.sort(function (a, b) { return String(a.ts || '').localeCompare(String(b.ts || '')); });
    return rows;
  }
  function effectBlock(e, applies) {
    var d = e.detail || {}, o = outcomeText(e), rows = [];
    var repeat = d.occurrences != null
      ? (fmt(d.occurrences) + ' occurrence' + (d.occurrences === 1 ? '' : 's') + (d.threshold ? ' (threshold ' + d.threshold + ')' : ''))
      : (d.logged_times ? ('logged ' + fmt(d.logged_times) + ' time' + (d.logged_times === 1 ? '' : 's')) : null);
    if (applies.length) rows.push('<li><b>Where it applies</b>' + esc(applies.join(', ')) + '</li>');
    if (o || d.status) rows.push('<li><b>Checks</b>' + esc(o || d.status) + '</li>');
    if (repeat) rows.push('<li><b>Repeat rate</b>' + esc(repeat) + '</li>');
    if (!rows.length) return '';
    return '<div class="effect"><div class="row spread"><label>Expected effect</label></div><ul class="effect-list">' + rows.join('') + '</ul></div>';
  }
  function useEventBody(row) {
    var o = outcomeText(row);
    var stage = (row.detail && row.detail.stage) || row.event_type;
    var meta = esc(row.engine || (row.outcome && row.outcome.evaluator) || stage || '');
    if (o || row.event_type === 'checked' || stage === 'checked') {
      return event('A later result was checked', row.outcome && row.outcome.evaluator ? esc(row.outcome.evaluator) : 'Checked', '<div class="check">' + esc(o || row.title || 'Checked') + '</div><p>One recorded check. Evidence for that run, not a guarantee about every future answer.</p>');
    }
    if (row.event_type === 'used' || stage === 'applied') {
      var excerpt = ((row.source_refs || [])[0] || {}).excerpt || (row.detail && row.detail.excerpts && row.detail.excerpts[0]) || '';
      return event('Recorded use in a later session', meta, (excerpt ? '<div class="quote">' + esc(excerpt) + '</div>' : '') + '<p>This record was used by ' + esc(row.engine || 'an engine') + (row.detail && row.detail.count ? ' · ' + fmt(row.detail.count) + ' time' + (row.detail.count === 1 ? '' : 's') : '') + '.</p>'
        + rankingSentence());
    }
    var title = stage === 'included' ? 'Included in a later session' : 'Retrieved in a later session';
    return event(title, meta, '<p>This record was ' + esc(stage || row.event_type) + ' by ' + esc(row.engine || 'an engine') + (row.detail && row.detail.count ? ' · ' + fmt(row.detail.count) + ' time' + (row.detail.count === 1 ? '' : 's') : '') + '.</p>');
  }
  function useEvent(e) {
    var rows = relatedUseRows(e);
    if (!rows.length) return '';
    return rows.map(useEventBody).join('');
  }
  function evidenceEvent(e) {
    var n = (e.source_refs || []).length;
    return event('Evidence for this lesson', 'Knowledge', '<p>' + fmt(n) + ' source record' + (n === 1 ? '' : 's') + '. Sources are what was actually said. Graph links are extracted context, not proof that the lesson worked.</p><div class="actions"><button onclick="cosApp.openKnowledge(' + attr(e.event_id) + ')">Open sources</button><button onclick="cosApp.exploreInGraph(' + attr(e.event_id) + ')">Explore in graph</button></div>' + (e.provenance && e.provenance !== 'complete' ? '<p>Provenance: ' + esc(e.provenance) + '.</p>' : ''), true, true);
  }
  function lessonDetail(e, full) {
    var o = outcomeText(e);
    var badge = o ? '<span class="badge">Checked: '+esc(o)+'</span>' : isProposal(e) ? '<span class="badge">Task proposal</span>' : isPattern(e) ? '<span class="badge">Promotable pattern</span>' : e.event_type === 'retrieved' || e.event_type === 'used' ? '<span class="badge purple">Retrieved in a later session</span>' : '<span class="badge">' + esc(kindLabel(e)) + '</span>';
    var head = '<div class="row spread">' + badge + '<span class="meta">' + esc(e.event_id) + '</span></div><h2 style="margin-top:12px">' + esc(e.title || '(untitled)') + '</h2><p class="intro">' + esc([STORE[e.store] || e.store, e.scope !== 'unknown' ? e.scope : null, e.engine !== e.scope && e.engine !== 'unknown' ? e.engine : null].filter(Boolean).join(' · ')) + '</p>';
    var note = full && full._error ? '<div class="notice">' + esc(full._error) + '</div>' : (!full ? '<p class="muted" style="font-size:11px">Loading the record…</p>' : '');
    if (e.detail && e.detail.truncated) note += '<div class="notice">Record truncated to fit; the store holds more than shown here.</div>';
    return head + note + '<div class="timeline">' + sourceEvent(e) + changeEvent(e, full) + useEvent(e) + evidenceEvent(e) + '</div>';
  }

  // ── all memories ────────────────────────────────────────────────
  // ── applied this week ───────────────────────────────────────────
  function appliedExcerpt(e) { return ((e.source_refs || [])[0] || {}).excerpt || (e.detail && e.detail.excerpts && e.detail.excerpts[0]) || ''; }
  function lessonText(id) { var m = id && state.memoryDetail[id]; if (!m || m._error) return ''; return m.content || m.summary || ''; }
  function lessonError(id) { var m = id && state.memoryDetail[id]; return m && m._error ? String(m._error) : ''; }
  function clip(text, n) { text = String(text || ''); return text.length > n ? text.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : text; }
  function appliedRow(e, selected) {
    var lesson = lessonText(e.lesson_id) || e.lesson_id || '(lesson)';
    var meta = [e.engine && e.engine !== 'unknown' ? e.engine : null, stamp(e.ts)].filter(Boolean).join(' · ');
    return '<button class="lesson ' + (selected ? 'selected' : '') + '" onclick="cosApp.select(' + attr(e.event_id) + ')" aria-pressed="' + (selected ? 'true' : 'false') + '"><div class="kind">' + esc(KIND.used) + '</div><span class="title">' + esc(clip(lesson, 140)) + '</span><div class="meta">' + esc(meta) + '</div><span class="status green excerpt">' + esc(clip(appliedExcerpt(e), 120) || 'A later answer used this lesson') + '</span></button>';
  }
  // Empty copy by path. The bridge can detect use and simply saw none; the other
  // paths cannot detect it at all, and the list must not be filled from elsewhere.
  function appliedEmptyCopy() {
    var cov = (state.appliedCoverage && state.appliedCoverage.used) || (state.coverage && state.coverage.used) || {};
    if (state.errors.applied) return { h: 'Applied is not available right now.', p: state.errors.applied };
    // No path verdict before COS Control has answered: a pending or failed status must
    // never read as 'the bridge is off' on a Mac where it is on.
    if (!state.status) return state.errors.status
      ? { h: 'Could not read this Mac\'s status.', p: 'Applied says nothing about the memory path until COS Control answers. ' + state.errors.status }
      : { h: 'Checking this install\'s memory path…', p: 'Applied says nothing about use until COS Control has answered.' };
    var path = memoryPath();
    if (path === 'files') return { h: 'This memory path cannot detect use.', p: 'Applied stays empty until the COS Data bridge (vector store) is on. Plain-file memories keep working.' };
    if (path === 'knowledge') return { h: 'Knowledge citations are not lesson reward.', p: 'Applied is for bot-memory lessons. Turn on the COS Data bridge to detect when a later answer uses one.' };
    if (cov.state === 'unavailable') return { h: 'The use trace could not be read on this Mac.', p: 'Nothing is invented here. Check the trace file under COS Data and refresh.' };
    if (cov.state !== 'ok' && cov.state !== 'legacy') return { h: 'Use has not been recorded on this Mac yet.', p: 'The applied detector has not written to the trace. Nothing here is a measurement of zero.' };
    return { h: 'No later answer has used a lesson ' + (state.appliedDays === 90 ? 'in 90 days' : 'this week') + '.', p: 'Retrieval without acknowledgment is not use. A lesson lands here when a later answer visibly applied it.' };
  }
  function appliedDetail(e) {
    var lesson = lessonText(e.lesson_id), lessonErr = lessonError(e.lesson_id), excerpt = appliedExcerpt(e), d = e.detail || {};
    var n = appliedCountFromTitle(e);
    var count = n != null ? ('Recorded ' + fmt(n) + ' time' + (n === 1 ? '' : 's') + ' since first use') : 'Recorded';
    var head = '<div class="row spread"><span class="badge green">' + esc(KIND.used) + '</span><span class="meta">' + esc(e.lesson_id || '') + '</span></div>' +
      '<h2 style="margin-top:12px">' + esc(lesson ? clip(lesson, 200) : 'Lesson') + '</h2>' +
      '<p class="intro">' + esc([e.engine && e.engine !== 'unknown' ? e.engine : null, d.sessions ? fmt(d.sessions) + ' session' + (d.sessions === 1 ? '' : 's') : null, stamp(e.ts)].filter(Boolean).join(' · ')) + '</p>';
    var lessonBody = lesson ? '<div class="quote">' + esc(lesson) + '</div>' : lessonErr ? '<div class="notice">This lesson\'s record could not be read (' + esc(lessonErr) + '). The use below is still recorded.</div>' : '<p class="muted">Loading the record…</p>';
    var timeline = event('The lesson', 'Bot memory', lessonBody + (e.lesson_id ? '<button class="link" onclick="cosApp.openMemoryRecord(' + attr(e.lesson_id) + ')">Open source record</button>' : ''));
    timeline += event('A later answer used it', esc(stamp(e.ts)), (excerpt ? '<div class="quote">' + esc(excerpt) + '</div>' : '') + '<p>' + esc(count) + ' from the assistant\'s own words. An acknowledgment is evidence for that answer, not a guarantee about every future one.</p>');
    if (rewardEnabled()) timeline += event('Ranking', 'Reward on', rankingSentence(), true, true);
    return head + '<div class="timeline">' + timeline + '</div>';
  }
  function renderApplied(inbox, detail) {
    var rows = state.applied, err = state.errors.applied, loading = !state.appliedLoaded && !err;
    if (rows.length && !rows.some(function (x) { return x.event_id === state.selected; })) state.selected = rows[0].event_id;
    var toggle = '<button class="link" onclick="cosApp.appliedDays(' + (state.appliedDays === 90 ? 7 : 90) + ')">' + (state.appliedDays === 90 ? 'Show this week' : 'Show 90 days') + '</button>';
    inbox.innerHTML = '<div class="date row spread"><span>APPLIED · ' + (state.appliedDays === 90 ? '90 DAYS' : 'THIS WEEK') + (state.appliedTotal != null ? ' · ' + fmt(state.appliedTotal) : '') + '</span>' + toggle + '</div>' +
      (err ? '<div class="host-state"><div><h3>Not available</h3><p>' + esc(err) + '</p><button onclick="cosApp.retryApplied()">Retry</button></div></div>' : '') +
      (loading ? '<div class="host-state">Loading…</div>' : '') +
      rows.map(function (e) { return appliedRow(e, e.event_id === state.selected); }).join('') +
      (state.appliedCursor ? '<div class="actions"><button class="quiet" onclick="cosApp.loadMoreApplied()">Load more</button></div>' : '') +
      coverageNote();
    if (!rows.length) {
      var copy = appliedEmptyCopy();
      detail.innerHTML = loading ? '<div class="host-state">Loading…</div>' : '<div class="empty"><div><h2>' + esc(copy.h) + '</h2><p>' + esc(copy.p) + '</p>' + (err ? '<button onclick="cosApp.retryApplied()">Retry</button>' : '') + '</div></div>';
      return;
    }
    var e = rows.find(function (x) { return x.event_id === state.selected; });
    if (e.lesson_id) ensureMemoryDetail(e.lesson_id);
    detail.innerHTML = '<div class="context-actions row spread"><span class="eyebrow">Applied this week</span><div class="row">' + (e.lesson_id ? '<button class="quiet" onclick="cosApp.openMemoryRecord(' + attr(e.lesson_id) + ')">Open source record</button>' : '') + '</div></div>' + appliedDetail(e);
  }
  function renderMemories(inbox, detail) {
    var focusInput=inbox.querySelector('input[aria-label="Search memories"]');
    var hadFocus=focusInput && document.activeElement===focusInput;
    var selection=hadFocus?[focusInput.selectionStart,focusInput.selectionEnd]:null;
    var rows = state.memoryHits != null ? state.memoryHits : state.memories;
    if (rows.length && !rows.some(function (x) { return x.id === state.selectedMemory; })) state.selectedMemory = rows[0].id;
    inbox.innerHTML = '<div class="date">SAVED MEMORIES' + (state.memoriesTotal != null ? ' · ' + fmt(state.memoriesTotal) + ' STORED' : '') + '</div>' +
      '<div class="search"><input type="search" placeholder="Search topics, ideas…" value="' + esc(state.memoryQuery) + '" oninput="cosApp.memoryQuery(this.value)" aria-label="Search memories"></div>' +
      (state.errors.memories ? '<div class="host-state"><div><h3>Not available</h3><p>' + esc(state.errors.memories) + '</p></div></div>' : '') +
      rows.map(function (m) { return memoryRow(m, m.id === state.selectedMemory); }).join('') + ((state.memoryQuery?state.memorySearchCursor:state.memoryCursor)?'<button onclick="cosApp.loadMoreMemories()">Load more memories</button>':'') + (!state.memoryPageCapable?'<p class="muted">Bounded browsing on this server version.</p>':'');
    if(hadFocus) {var replacement=inbox.querySelector('input[aria-label="Search memories"]'); replacement.focus(); try{replacement.setSelectionRange(selection[0],selection[1]);}catch(ignore){} }
    if (!rows.length) { detail.innerHTML = '<div class="empty"><div><h2>' + (state.memoryQuery ? 'No memories match that lookup.' : 'No memories yet.') + '</h2><p>Drop markdown into memory/, or configure a bridge for the vector store.</p></div></div>'; return; }
    var m = rows.find(function (x) { return x.id === state.selectedMemory; });
    ensureMemoryDetail(m.id);
    var full = state.memoryDetail[m.id] || {};
    var record = full._error ? m : Object.assign({}, m, full);
    detail.innerHTML = '<div class="context-actions row spread"><span class="eyebrow">MEMORY</span><div class="row">' + (record.filePath ? '<button class="quiet" onclick="cosApp.reveal(' + attr(m.id) + ')">Reveal in Finder</button>' : '') + '<button onclick="cosApp.copyMemory(' + attr(m.id) + ')">Copy context</button></div></div>' +
      '<span class="badge green">Saved memory</span><h2 style="margin-top:12px">' + esc(record.summary || 'Memory') + '</h2><p class="intro">' + esc([record.type, dateOnly(record.created_at), record.source].filter(Boolean).join(' · ')) + '</p>' +
      (full._error ? '<div class="notice">' + esc(full._error) + '</div>' : '') +
      '<div class="timeline">' + event('Captured memory', esc(record.type || 'Memory'), '<div class="quote">' + esc(record.content || record.summary || '') + '</div>') + event('Available for recall', record.filePath ? 'Plain files' : 'Memory store', '<p>Active memories are available to authorized sessions. Later retrieval, use, or result appears under Recent learning when it is recorded.</p>', false, true) + '</div>';
  }
  var memorySearchTimer = null;
  function memoryQuery(q) {
    state.memoryQuery=q;clearTimeout(memorySearchTimer);
    if(q.trim().length===1)return;
    memorySearchTimer=setTimeout(function(){loadMemoryPage(false);},q?350:0);
  }

  // ── knowledge ───────────────────────────────────────────────────
  function knowledgeAside() {
    var focus = state.knowledgeFocus && findEvent(state.knowledgeFocus);
    return '<div class="knowledge-label">EXPLORE KNOWLEDGE</div>' +
      '<button class="knowledge-route ' + (state.knowledgeTab === 'graph' ? 'active' : '') + '" aria-pressed="' + (state.knowledgeTab === 'graph') + '" onclick="cosApp.setKnowledgeTab(\'graph\')"><span>Ask the graph</span><small>Explore connections · ' + (state.graphStatus&&state.graphStatus.engine==='explicit_document_links'?'Document links':'LightRAG') + '</small></button>' +
      '<button class="knowledge-route ' + (state.knowledgeTab === 'sources' ? 'active' : '') + '" aria-pressed="' + (state.knowledgeTab === 'sources') + '" onclick="cosApp.setKnowledgeTab(\'sources\')"><span>Source records</span><small>What was actually said</small></button>' +
      '<button class="knowledge-route ' + (state.knowledgeTab === 'setup' ? 'active' : '') + '" aria-pressed="' + (state.knowledgeTab === 'setup') + '" onclick="cosApp.setKnowledgeTab(\'setup\')"><span>Set up Knowledge</span><small>Sources, owner, first index</small></button>' +
      '<div class="knowledge-note"><h3>' + (focus ? 'Related to: ' + esc(focus.title) : 'Better context. Traceable learning.') + '</h3><p>Sources explain a memory. Relationships add context. Run evidence shows whether a change helped.</p><button class="link" onclick="cosApp.backToLearning()">← Back to recent learning</button></div>';
  }
  function hostLabel(h) { return String(h || '').replace(/\.local$/, '').replace(/-/g, ' '); }
  function fileGraph() { return !!(state.graphStatus && state.graphStatus.engine === 'explicit_document_links'); }
  function syncCard() {
    var g = state.graphStatus, s = state.status || {};
    if (state.errors.graph) return '<section class="source-card sync-card"><div class="row spread"><h3>Sync</h3></div><p class="owner">' + esc(state.errors.graph) + '</p><div class="actions"><button onclick="cosApp.refreshGraph()">Retry</button></div></section>';
    if (!g) return '<section class="source-card sync-card"><div class="row spread"><h3>Sync</h3></div><p class="owner">Loading…</p></section>';
    if (fileGraph()) return '<section class="source-card sync-card"><h3>Document links</h3><p>Granted documents and your assertions build this local graph. Links describe associations; they do not establish causation.</p><dl class="sync-grid"><dt>Indexed</dt><dd>' + fmt(g.entities || 0) + ' points · ' + fmt(g.relationships || 0) + ' links</dd><dt>Index</dt><dd>' + esc(g.index_state || 'unknown') + '</dd><dt>Visible</dt><dd data-role="graph-visible">' + (state.graphVisible == null ? 'Open the graph to load points' : fmt(state.graphVisible) + ' points') + '</dd></dl><p>Refresh granted documents in Memory stewardship to update their evidence and links.</p><button onclick="cosApp.openStewardship()">Current sources and rules</button></section>';
    var src = g.source || {}, q = g.queue || {}, b = g.budget || {}, lock = g.lock || {}, proc = g.processor || {};
    var ownerName = hostLabel(src.owner_host) || 'the owner Mac';
    var owner = (src.owner_state === 'owner' ? 'Owner: <b>this Mac</b> (' + esc(ownerName) + ') · canonical graph' : src.owner_state === 'replica' ? 'Owner: <b>' + esc(ownerName) + '</b> · this Mac reads an iCloud replica' : 'No ingestion owner set. Run --set-owner on the Mac that processes the queue.');
    var processor = (proc.state === 'none' || !proc.state ? 'No scheduled processor on this Mac' : proc.state === 'installed-idle' ? 'Processor installed, no run recorded yet' : 'Processor ' + esc(proc.state));
    // Index now (server 6.44.8): one bounded run of the queue, started here on the
    // owner Mac. A held lock (a Claude session, a scheduled run, a backup) shows
    // as "Indexing now" and the card refreshes until it is free again.
    var lockHeld = lock.state === 'exclusive' || lock.state === 'shared';
    var pendingN = q.pending != null ? Number(q.pending) : 0;
    {
      if (state.ingesting && state.ingesting.note) processor += ' · <span class="muted">' + esc(state.ingesting.note) + '</span>';
      else if (lockHeld) processor += ' · <span class="muted">Indexing now' + (lock.owner_pid ? ' (pid ' + esc(lock.owner_pid) + ')' : '') + '</span>';
      else if (src.owner_state === 'owner' && pendingN > 0) {
        var sizes = [5, 10, 25, 50].filter(function (n) { return n < pendingN; });
        var options = sizes.map(function (n) { return '<option value="' + n + '"' + (n === state.ingestLimit ? ' selected' : '') + '>' + n + '</option>'; }).join('');
        if (pendingN <= 50) options += '<option value="' + pendingN + '"' + (sizes.indexOf(state.ingestLimit) === -1 ? ' selected' : '') + '>' + fmt(pendingN) + ' (all)</option>';
        processor += ' <span class="ingest-control"><span class="ingest-pending">' + fmt(pendingN) + ' pending</span><label for="ingestLimit">Batch size</label><select id="ingestLimit" aria-label="Index batch size">' + options + '</select><button type="button" class="hairline" onclick="cosApp.startIngest()">Index now</button></span>';
      }
    }
    var queued = (q.pending != null ? fmt(q.pending) + ' pending' : 'unknown') + (q.oldest_pending_at ? ' · oldest ' + esc(dateOnly(q.oldest_pending_at)) : '') + (q.missing_sources != null ? ' · ' + fmt(q.missing_sources) + ' missing sources' : '') + (q.conflict_copies != null ? ' · ' + fmt(q.conflict_copies) + ' conflict copies' : '');
    var indexed = (g.entities != null ? fmt(g.entities) + ' entities' : 'no graph') + (g.relationships != null ? ' · ' + fmt(g.relationships) + ' relationships' : '') + (g.source_updated_at ? ' · graph updated ' + esc(stamp(g.source_updated_at)) : '');
    var invites = g.index_state === 'missing' || g.index_state === 'stale';
    var build = state.building ? ' <span class="muted">' + esc(state.building) + '</span>' : (invites ? ' <button class="quiet" onclick="cosApp.buildIndex()">Build index (usually a few seconds)</button>' : '');
    var captured = s.meetingLibraryCount != null ? fmt(s.meetingLibraryCount) + ' meetings in the library' : 'unknown';
    var visible = state.graphController && state.graphVisible != null ? fmt(state.graphVisible) + ' entities in this view' : (state.knowledgeTab === 'graph' ? 'loading the neighborhood' : 'open the graph to load a neighborhood');
    return '<section class="source-card sync-card"><div class="row spread"><h3>Sync</h3></div>' +
      '<p class="owner">' + owner + '</p>' +
      '<dl class="sync-grid"><dt>Captured</dt><dd>' + esc(captured) + '</dd><dt>Queued</dt><dd>' + queued + '</dd><dt>Indexing</dt><dd>' + processor + '</dd><dt>Indexed</dt><dd>' + indexed + '</dd><dt>Visible</dt><dd data-role="graph-visible">' + esc(visible) + '</dd><dt>Index</dt><dd>' + esc(g.index_state || 'unknown') + (g.index_built_at ? ' · built ' + esc(stamp(g.index_built_at)) : '') + (g.index_degraded ? ' · degraded' : '') + build + '</dd><dt>Budget</dt><dd>' + (b.used != null && b.cap != null ? fmt(b.used) + ' of ' + fmt(b.cap) + ' calls today' : 'unknown') + ' · lock ' + esc(lock.state || 'unknown') + (lock.owner_pid ? ' (pid ' + esc(lock.owner_pid) + ', advisory)' : '') + '</dd></dl>' +
      progressBlock() + '<p class="small">' + 'Values from this Mac.' + ' Saved investigations and assertions show their operation receipts in the workspace.</p></section>';
  }
  // ── Set up Knowledge (server 6.44.9): seven steps, each a live check with its own control ──
  function loadSetup() {
    if (!state.graphStatus && !state.errors.graph) return loadGraphStatus().then(function(){ return loadSetup(); });
    if (!state.graphStatus) { state.setupLoading=false; state.setupError=state.errors.graph || 'Graph capability is unavailable. Refresh the graph status before setup.'; return Promise.resolve(null); }
    if (fileGraph()) { state.setupLoading=false; state.setupError=null; state.setup={engine:'explicit_document_links'}; if(state.view==='knowledge')render(); return Promise.resolve(state.setup); }
    state.setupLoading = true; state.setupError = null; if (state.view === 'knowledge') render();
    return call('graph.setup').then(function (d) { state.setup = d; state.setupLoading = false; render(); }, function (e) { state.setupError = e.message; state.setupLoading = false; render(); });
  }
  function setupAction(name, op, args, onDone) {
    state.setupBusy = name; state.armed = null; render();
    return call(op, args).then(function (d) { state.setupBusy = null; if (onDone) onDone(d); return loadSetup(); }, function (e) { state.setupBusy = null; toast(e.message); render(); });
  }
  function setupStep(n, done, title, body, cls) {
    return '<div class="setup-step ' + (done ? 'done' : (cls || 'todo')) + '"><div class="setup-mark">' + (done ? '✓' : n) + '</div><div class="setup-body"><h4>' + title + '</h4>' + body + '</div></div>';
  }
  function shortPath(p) { return String(p || '').replace(/^\/Users\/[^/]+/, '~'); }
  function attr(v) { return JSON.stringify(String(v)).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  // The two pickers of step 4. A card is a radio: choosing posts the op and refreshes the checklist.
  function extractionCards(ext, busy) {
    var tiers = ext.tiers || [];
    if (!tiers.length) return '<p class="muted">Indexing tiers need server 6.44.11.</p>';
    return '<div class="pick-grid">' + tiers.map(function (tr) {
      return '<label class="pick-card ' + (tr.selected ? 'on' : '') + '"><input type="radio" name="extractionTier" ' + (tr.selected ? 'checked' : '') + (busy ? ' disabled' : '') + ' onchange="cosApp.chooseExtraction(' + attr(tr.id) + ')"><div><b>' + esc(tr.label) + '</b><p>' + esc(tr.detail) + '</p></div></label>';
    }).join('') + '</div>';
  }
  // The down-select (0.5.200, server 6.44.12). One question the user answers, may
  // text leave this Mac; one fact detected, an OpenAI key; Ollama running picks
  // premium over light. The answer moves the Recommended mark, never the choice.
  function localOnlyStrip(emb, busy) {
    if (!emb.preference) return '<p class="muted">The recommendation needs server 6.44.12.</p>';
    var v = emb.preference.local_only, rec = emb.recommended || null;
    function btn(value, text) { return '<button class="quiet' + (v === value ? ' on' : '') + '" ' + (busy ? 'disabled' : '') + ' onclick="cosApp.answerLocalOnly(' + value + ')">' + text + '</button>'; }
    return '<div class="setup-row ask-strip"><span>May your text leave this Mac for embeddings?</span>' + btn(false, 'Cloud is fine') + btn(true, 'Stays on this Mac') + '</div>' +
      (rec ? '<p class="pick-note"><b>Recommended: ' + esc(rec.label) + '.</b> ' + esc(rec.reason) + '</p>' : '');
  }
  function embeddingCards(emb, busy) {
    var rows = emb.providers || [];
    if (!rows.length) return '<p class="muted">Embedding choices need server 6.44.11.</p>';
    var fetch = emb.fetch || null;
    var recId = emb.recommended ? emb.recommended.id : null;
    var cards = rows.map(function (r) {
      var canPick = !emb.locked || r.selected;
      var fetching = fetch && fetch.state === 'running' && fetch.provider === r.id;
      var fetchFailed = fetch && fetch.state === 'failed' && fetch.provider === r.id;
      var offline = r.id === 'ollama' && /not running/.test(r.detail || '');
      var fetchBtn = r.kind === 'local' && !r.ready && !offline ? '<button class="quiet" ' + (busy || fetching ? 'disabled' : '') + ' onclick="cosApp.fetchEmbedding(' + attr(r.id) + ')">' + (fetching ? 'Fetching…' : 'Fetch model') + '</button>' : '';
      var badge = r.id === recId ? '<span class="pick-badge">Recommended</span>' : '';
      var fixLine = r.selected && !r.ready && r.fix ? '<p class="bad">' + esc(r.fix) + '</p>' : '';
      return '<label class="pick-card ' + (r.selected ? 'on' : '') + (canPick ? '' : ' off') + (r.id === recId ? ' rec' : '') + '"><input type="radio" name="embeddingProvider" ' + (r.selected ? 'checked' : '') + (canPick && !busy ? '' : ' disabled') + ' onchange="cosApp.chooseEmbedding(' + attr(r.id) + ')"><div><b>' + esc(r.label) + '</b> <span class="muted">' + esc(r.model) + (r.dimensions != null ? ' · ' + fmt(r.dimensions) + ' dims' : '') + '</span>' + badge + '<p>' + esc(r.cost) + '</p><p class="' + (r.ready ? 'ok' : '') + '">' + (r.ready ? '✓ ' : '') + esc(r.detail) + '</p>' + fixLine + (fetching ? '<p class="muted">Fetching ' + esc(fetch.model) + '… this page refreshes as it runs.</p>' : fetchFailed ? '<p class="bad">Fetch failed: ' + esc(fetch.error || 'unknown') + '</p>' : '') + fetchBtn + '</div></label>';
    }).join('');
    var note = '';
    if (emb.mismatch && emb.manifest) note = '<p class="pick-note bad">This graph was built with ' + esc(emb.manifest.provider) + ' (' + esc(emb.manifest.model) + ', ' + fmt(emb.manifest.dimensions) + ' dims) but ' + esc(emb.provider) + ' is chosen. Choose the one it was built with; Index now is blocked until then.</p>';
    else if (emb.locked) note = '<p class="pick-note">This graph was built with ' + esc(emb.label || emb.provider) + '. Changing the embedding means rebuilding the graph, and that path is not built yet.</p>';
    else if (emb.ready === false) note = '<p class="pick-note bad">' + esc(emb.label || emb.provider) + ' is chosen but not ready on this Mac. ' + esc(emb.fix || '') + ' Indexing is blocked until then.</p>';
    return '<div class="pick-grid">' + cards + '</div>' + note;
  }
  function watchFetch() {
    if (state.fetchWatch) return;
    var ticks = 0;
    state.fetchWatch = setInterval(function () {
      ticks++;
      loadSetup().then(function () {
        var f = state.setup && state.setup.embedding && state.setup.embedding.fetch;
        if (!f || f.state !== 'running' || ticks > 360) { clearInterval(state.fetchWatch); state.fetchWatch = null; if (f && f.state === 'done') toast('Model fetched.'); else if (f && f.state === 'failed') toast('Fetch failed: ' + (f.error || 'unknown')); }
      });
    }, 10000);
  }
  function setupDetail() {
    if (fileGraph()) return '<section class="source-card setup-card"><h3>Set up document links</h3><p>This runtime indexes Markdown and text documents explicitly granted by the instance owner. Use the installed runtime’s <code>manage.py grant</code> command to add a document. Write links as <code>[[Document title]]</code> to connect ideas.</p><p>Open Current sources to inspect or refresh granted documents. In the graph, select two points, add waypoints and find paths up to seven hops. Save a hypothesis separately from your asserted relationship.</p><p>Model extraction and embeddings are not configured in this file runtime. Keyword search and explicit document links are available.</p><button onclick="cosApp.openStewardship()">Current sources and rules</button></section>';
    var s = state.setup;
    if (state.setupError) return '<section class="source-card setup-card"><h3>Set up Knowledge</h3><p class="owner">' + esc(state.setupError) + '</p><div class="actions"><button onclick="cosApp.setupRefresh()">Retry</button></div></section>';
    if (!s) return '<section class="source-card setup-card"><h3>Set up Knowledge</h3><p class="owner">Checking this Mac…</p></section>';
    var checks = s.checks || [], checksOk = checks.length > 0 && checks.every(function (c) { return c.ok; });
    var sources = s.sources || [], enabledWithFiles = sources.filter(function (r) { return r.enabled && r.exists && (r.files || 0) > 0; });
    var owner = s.owner || {}, isOwner = owner.is_owner === true, budget = s.budget || {}, sample = s.sample || {}, cands = sample.candidates || [];
    var graphN = (s.graph || {}).entities, hasGraph = graphN != null && graphN > 0, schedule = s.schedule || {}, lk = s.lock || {};
    var lockHeld = lk.state === 'exclusive' || lk.state === 'shared';
    var busy = state.setupBusy;
    var steps = [];
    steps.push(setupStep(1, checksOk, 'Enable Knowledge',
      '<p>What indexing needs on this Mac.</p>' + checks.map(function (c) { return '<div class="setup-source"><span class="' + (c.ok ? 'ok' : 'bad') + '">' + (c.ok ? '✓' : '!') + '</span><span>' + esc(c.detail) + '</span></div>'; }).join(''),
      checks.length && !checksOk ? 'blocked' : 'todo'));
    var sourceRows = sources.map(function (r) {
      return '<div class="setup-source"><code>' + esc(shortPath(r.path)) + '</code><span class="muted">' + (r.exists ? (r.files != null ? fmt(r.files) + ' document' + (r.files === 1 ? '' : 's') : '') : 'missing') + '</span>' +
        '<button class="quiet" ' + (busy ? 'disabled' : '') + ' onclick="cosApp.sourceToggle(' + attr(r.path) + ', ' + (!r.enabled) + ')">' + (r.enabled ? 'On' : 'Off') + '</button>' +
        '<button class="quiet" ' + (busy ? 'disabled' : '') + ' onclick="cosApp.sourceRemove(' + attr(r.path) + ')" aria-label="Remove this folder">×</button></div>';
    }).join('');
    steps.push(setupStep(2, enabledWithFiles.length > 0, 'Choose sources',
      '<p>Folders of notes or documents (Markdown and text). Only files in these folders are read.</p>' + sourceRows +
      '<div class="setup-row"><button ' + (busy ? 'disabled' : '') + ' onclick="cosApp.pickFolder()">' + (busy === 'add' ? 'Adding…' : 'Add a folder…') + '</button>' + (sources.length && !enabledWithFiles.length ? '<span class="muted">No documents found in the folders that are on.</span>' : '') + '</div>'));
    var ownerBody = isOwner ? '<p>This Mac (' + esc(hostLabel(owner.this_host)) + ') indexes the queue. Its graph, queue and sources stay here.</p>'
      : owner.owner_host ? '<p><b>' + esc(hostLabel(owner.owner_host)) + '</b> indexes the queue; this Mac reads a replica. Make this Mac the owner only if that Mac stops indexing.</p>'
      : '<p>No Mac is set to index yet.</p>';
    if (!isOwner) ownerBody += '<div class="setup-row"><button ' + (busy ? 'disabled' : '') + ' onclick="cosApp.claimOwner()">' + (state.armed === 'owner' ? 'Click again to make this Mac the owner' : busy === 'owner' ? 'Setting…' : 'Make this Mac the owner') + '</button></div>';
    steps.push(setupStep(3, isOwner, 'Owner Mac', ownerBody));
    var budgetOk = budget.used != null && budget.cap != null && budget.used < budget.cap;
    var embBlock = s.embedding || {}, extBlock = s.extraction || {};
    var localEmb = embBlock.kind === 'local';
    var embNotReady = embBlock.ready === false;
    steps.push(setupStep(4, checksOk && budgetOk && !embBlock.mismatch && !embNotReady, 'Choose how it indexes',
      '<p>Extraction quality intent for the next run. Effective execution: ' + esc(extBlock.execution ? [extBlock.execution.provider,extBlock.execution.requested_model,extBlock.execution.reasoning_effort].filter(Boolean).join(' · ') : 'unavailable in this version') + '. Actual model identity: ' + esc((extBlock.execution || {}).actual_identity || 'unverified') + '.</p>' + extractionCards(extBlock, busy) +
      '<p style="margin-top:12px">Embeddings for search, one choice for the knowledge graph and every meeting index. A graph keeps the embedding it was built with.</p>' + localOnlyStrip(embBlock, busy) + embeddingCards(embBlock, busy) +
      '<div class="setup-source" style="margin-top:10px"><span>Budget today: ' + (budget.used != null ? fmt(budget.used) + ' of ' + fmt(budget.cap) + ' calls' : 'unknown') + (budgetOk ? '' : ' (used up until tomorrow)') + '</span></div>' +
      '<p>What leaves this Mac: each document\'s text goes to the model backend for entity extraction' + (localEmb ? '; embeddings are computed on this Mac' : ' and to OpenAI for embeddings') + '. The graph, the queue and this list of folders never leave it.</p>',
      embBlock.mismatch || embNotReady ? 'blocked' : 'todo'));
    var sampleDone = (sample.indexed || 0) >= 1 || hasGraph;
    var sampleBody = sampleDone ? '<p>' + ((sample.indexed || 0) >= 1 ? fmt(sample.indexed) + ' sample document' + (sample.indexed === 1 ? '' : 's') + ' indexed.' : 'Your graph already holds ' + fmt(graphN) + ' entities.') + '</p>' : '<p>The three newest documents from the folders that are on, through the same checks a meeting gets, in one bounded run.</p>';
    if (cands.length) sampleBody += cands.map(function (c) { return '<div class="setup-source"><code>' + esc(String(c.path).split('/').pop()) + '</code><span class="muted">' + (c.bytes != null ? fmt(Math.max(1, Math.round(c.bytes / 1024))) + ' KB' : '') + '</span></div>'; }).join('');
    if (state.ingesting && state.ingesting.note) sampleBody += '<p class="muted">' + esc(state.ingesting.note) + '</p>';
    else if (lockHeld) sampleBody += progressBlock();
    if ((sample.queued || 0) > 0 && !lockHeld) sampleBody += '<p class="muted">' + fmt(sample.queued) + ' queued and waiting for a run.</p>';
    if (cands.length && isOwner && !lockHeld) sampleBody += '<div class="setup-row"><button ' + (busy || !checksOk || embNotReady ? 'disabled' : '') + ' onclick="cosApp.indexSample()">' + (busy === 'sample' ? 'Queueing…' : 'Index ' + (cands.length === 1 ? 'this document' : 'these ' + cands.length)) + '</button>' +
      (embNotReady ? '<span class="muted">Blocked: ' + esc(embBlock.label || embBlock.provider) + ' is not ready. ' + esc(embBlock.fix || '') + '</span>' : '') + '</div>';
    else if (cands.length && !isOwner) sampleBody += '<p class="muted">Indexing runs on the owner Mac.</p>';
    steps.push(setupStep(5, sampleDone, 'Index three sample documents', sampleBody, checksOk ? 'todo' : 'blocked'));
    var askBody = '<p>One question, answered from the graph. About a minute; two model calls under today\'s budget.</p>' +
      '<div class="setup-row"><input id="askQ" placeholder="' + (hasGraph ? 'Who do I work with most?' : 'Index something first') + '" value="' + esc(state.askQ) + '" ' + (s.ask_ready && !state.askBusy ? '' : 'disabled') + ' onkeydown="if(event.key===\'Enter\')cosApp.askGraph()"><button ' + (s.ask_ready && !state.askBusy ? '' : 'disabled') + ' onclick="cosApp.askGraph()">' + (state.askBusy ? '<span class="ask-spin" aria-hidden="true"></span>Asking…' : 'Ask') + '</button></div>' +
      (state.askBusy ? askProgressHtml(state.askStartedAt) : '') +
      (state.askAnswer ? '<div class="setup-answer">' + esc(state.askAnswer.answer) + '</div><p class="muted">' + (state.askAnswer.elapsed_s != null ? Math.round(state.askAnswer.elapsed_s) + ' s, ' : '') + esc(state.askAnswer.mode || 'hybrid') + ' mode</p>' : '');
    steps.push(setupStep(6, !!state.askAnswer, 'Ask one question', askBody, s.ask_ready ? 'todo' : 'blocked'));
    var scheduleBody = schedule.installed ? '<p>On: a batch of up to 4 queued documents every ' + (schedule.interval_s ? fmt(Math.round(schedule.interval_s / 60)) + ' minutes' : 'interval') + ', logged under ~/Library/Logs/COS.</p>' : '<p>Off. Turn it on and this Mac indexes what is queued on a schedule, in bounded batches of 4, under the daily budget.</p>';
    if (isOwner) scheduleBody += schedule.installed
      ? '<div class="setup-row"><button class="quiet" ' + (busy ? 'disabled' : '') + ' onclick="cosApp.scheduleSet(false)">' + (busy === 'schedule' ? 'Working…' : 'Turn off') + '</button></div>'
      : '<div class="setup-row"><select id="scheduleInterval"><option value="900">every 15 minutes</option><option value="3600" selected>every hour</option><option value="14400">every 4 hours</option><option value="86400">once a day</option></select><button ' + (busy ? 'disabled' : '') + ' onclick="cosApp.scheduleSet(true)">' + (busy === 'schedule' ? 'Working…' : 'Turn on') + '</button></div>';
    else scheduleBody += '<p class="muted">Schedules live on the owner Mac.</p>';
    steps.push(setupStep(7, schedule.installed === true, 'Scheduled batches', scheduleBody));
    var done = [checksOk, enabledWithFiles.length > 0, isOwner, checksOk && budgetOk, sampleDone, !!state.askAnswer, schedule.installed === true].filter(Boolean).length;
    return '<section class="source-card setup-card"><div class="row spread"><h3>Set up Knowledge</h3><span class="setup-progress">' + done + ' OF 7 DONE' + (state.setupLoading ? ' · REFRESHING' : '') + '</span></div>' +
      '<p class="owner">From zero to a first index on this Mac. Each step is a live check; do them in order.</p><div class="setup-steps">' + steps.join('') + '</div>' +
      '<div class="actions"><button class="quiet" onclick="cosApp.setupRefresh()">Refresh checks</button><button type="button" class="hairline" data-role="real-records" onclick="cosApp.openSourceRecords()">Real records</button></div></section>';
  }
  function renderKnowledge() {
    document.querySelector('#workspace').style.gridTemplateColumns = ''; document.querySelector('#inbox').classList.remove('hidden');
    document.querySelector('#inbox').innerHTML = knowledgeAside();
    document.querySelector('#detail').innerHTML = state.knowledgeTab === 'graph' ? graphDetail() + '<details class="knowledge-health"><summary>Knowledge status and maintenance</summary>' + syncCard() + '<div id="graphDups">' + duplicatesCard() + '</div></details>' : syncCard() + (state.knowledgeTab === 'setup' ? setupDetail() : knowledgeSources());
    if (state.knowledgeTab === 'graph') mountKnowledgeGraph();
    if (state.knowledgeTab === 'setup' && !state.setup && !state.setupLoading && !state.setupError) loadSetup();
  }
  function knowledgeSources() {
    var focus = state.knowledgeFocus && findEvent(state.knowledgeFocus);
    var cards = [];
    if (focus) {
      var full = state.detail[focus.event_id]; if (!full) ensureDetail(focus.event_id);
      var e = Object.assign({}, focus, full && !full._error ? full : {});
      (e.source_refs || []).forEach(function (r, i) { cards.push({ title: STORE[r.kind] || r.kind || 'Source', kind: r.kind || '', id: r.id || '', text: r.excerpt || '', note: i === 0 ? 'The record this lesson was projected from.' : '' }); });
      var term = exploreTerm(e);
      if (!state.passages[term] && !state.loading['p:' + term]) { state.loading['p:' + term] = true; call('graph.passages', { entity: term, limit: 5 }).then(function (d) { state.passages[term] = d; delete state.loading['p:' + term]; render(); }, function (er) { state.passages[term] = { _error: er.message }; delete state.loading['p:' + term]; render(); }); }
      var p = state.passages[term];
      if (p && !p._error) (p.items || []).forEach(function (it) { var s = it.source || {}; cards.push({ title: s.title || 'Passage', kind: s.status === 'resolved' ? 'Meeting excerpt' : 'Passage (' + (s.status || 'unresolved') + ')', id: it.chunk_id, text: it.excerpt, note: s.date ? s.date : '' }); });
      else if (p && p._error) cards.push({ title: 'Passages', kind: 'unavailable', id: '', text: p._error, note: '' });
    } else {
      cards = state.recent.slice(0, 8).filter(function (e) { return (e.source_refs || []).length; }).map(function (e) { var r = e.source_refs[0]; return { title: e.title, kind: STORE[r.kind] || r.kind || 'Source', id: e.event_id, text: r.excerpt || '', note: stamp(e.ts), event: e.event_id }; });
    }
    return '<div class="row spread" id="sourceRecords"><span class="eyebrow">MEMORIES / KNOWLEDGE / SOURCES</span>' + (cards.length ? '<button type="button" class="hairline" data-role="real-records" onclick="cosApp.openSourceRecords()">Real records</button>' : '<span class="badge">No records</span>') + '</div><h2 style="margin-top:12px">The context behind the lesson.</h2><p class="intro">Open the original evidence before reusing an interpretation.</p>' +
      (cards.length ? cards.map(function (x) { return '<article class="source-card"><div class="row spread"><h3>' + esc(x.title) + '</h3><span class="badge">' + esc(x.kind) + '</span></div>' + (x.text ? '<div class="quote">' + esc(x.text) + '</div>' : '') + (x.note ? '<p>' + esc(x.note) + '</p>' : '') + (x.event ? '<div class="actions"><button class="link" onclick="cosApp.select(' + attr(x.event) + ');cosApp.setFilter(\'recent\')">Inspect learning →</button></div>' : '') + '</article>'; }).join('') : '<div class="empty"><div><h3>No source records yet.</h3><p>Your first saved lesson will bring its source here.</p></div></div>');
  }
  function graphDetail() {
    return '<div id="graphAsk">' + askBlockInner() + '</div><section class="knowledge-visual"><div class="row spread actual-header"><h2>Your knowledge</h2><span class="badge green">' + (fileGraph() ? 'Your document links' : 'Your LightRAG data') + '</span></div><p class="intro">Explore connected people and ideas. Ask a question above to trace the connections that matter.</p><div id="graphMount" class="cgx-host"></div></section>';
  }
  // Ask the graph in plain language from the focus (Miles 2026-09-07: "Show me the
  // relation between Queen and Ukaoma"). The question runs the same hybrid query
  // the setup step uses; the answer renders here, with the names it mentions as
  // focus buttons. About a minute; two model calls under the subscription.
  // A safe Markdown subset for a model answer: escape first, then headings,
  // bold, inline code, bullet lists, pipe tables and paragraphs. Nothing else.
  function renderMarkdown(md) {
    var lines = esc(md || '').split('\n'), out = [], list = null, table = null;
    function inline(s) { return s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\[(S?\d+)\]/g, function (_, n) { var id = n.charAt(0) === 'S' ? n : 'S' + n; return '<a class="ref" href="#ask-ref-' + id + '">[' + n + ']</a>'; }); }
    function flush() { if (list) { out.push('<ul>' + list.join('') + '</ul>'); list = null; } if (table) { out.push('<table>' + table.join('') + '</table>'); table = null; } }
    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, '');
      if (!line.trim()) { flush(); return; }
      var h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { flush(); out.push('<h' + Math.min(h[1].length + 3, 6) + '>' + inline(h[2]) + '</h' + Math.min(h[1].length + 3, 6) + '>'); return; }
      var li = line.match(/^\s*[-*•]\s+(.*)$/);
      if (li) { if (table) flush(); list = list || []; list.push('<li>' + inline(li[1]) + '</li>'); return; }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return;
        if (list) flush();
        var cells = line.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return inline(c.trim()); });
        var tag = table ? 'td' : 'th'; table = table || [];
        table.push('<tr>' + cells.map(function (c) { return '<' + tag + '>' + c + '</' + tag + '>'; }).join('') + '</tr>'); return;
      }
      flush(); out.push('<p>' + inline(line) + '</p>');
    });
    flush();
    return out.join('');
  }
  function parseAskAnswer(answer) {
    var text = String(answer || '');
    var marker = '\n\nEvidence references:\n';
    var i = text.indexOf(marker);
    var prose = i < 0 ? text : text.slice(0, i);
    var refs = [];
    if (i >= 0) {
      text.slice(i + marker.length).split('\n').forEach(function (line) {
        var m = line.match(/^\[(S\d+)\]\s+(.*)$/);
        if (!m) return;
        var parts = m[2].split(' · ');
        refs.push({ id: m[1], source: (parts[0] || '').trim() || 'Original passage', date: restTrim(parts[1], 'date unknown'), location: parts[2] || '', status: parts[3] || '' });
      });
    }
    return { prose: prose, refs: refs };
  }
  function restTrim(value, empty) {
    var s = String(value || '').trim();
    return !s || s === empty ? '' : s;
  }
  function askRefsHtml(refs) {
    if (!refs.length) return '';
    return '<div class="ask-refs"><h4>Sources</h4><ol>' + refs.map(function (r) {
      var note = r.status === 'source_unresolved' ? 'not linked to a meeting file' : '';
      var meta = [r.date, note].filter(Boolean).join(' · ');
      return '<li id="ask-ref-' + esc(r.id) + '"><span class="ref">[' + esc(r.id) + ']</span> ' + esc(r.source) + (meta ? '<span class="muted"> · ' + esc(meta) + '</span>' : '') + '</li>';
    }).join('') + '</ol></div>';
  }
  // The entities an answer names, as the same card the inspector shows: headings
  // and bold names are looked up in the index; an exact id wins, then a person.
  function askEntityCandidates(answer, q) {
    var names = [];
    function add(n) { n = String(n || '').replace(/\s*\(.*?\)\s*$/, '').replace(/[*_#`]/g, '').trim(); if (n.length >= 3 && n.length <= 60 && /[A-Za-z]/.test(n) && names.indexOf(n) === -1) names.push(n); }
    (answer.match(/^#{1,4}\s+(.+)$/gm) || []).forEach(function (h) { add(h.replace(/^#+\s+/, '').replace(/^(Relationship|Relationships|References|Key Context|Summary|Overview)\s*:?\s*/i, '')); });
    (answer.match(/\*\*([^*]{3,60})\*\*/g) || []).forEach(function (b) { var n = b.replace(/\*\*/g, ''); if (/^[A-Z][\w'.-]*(\s+[A-Z][\w'.-]*){0,3}$/.test(n)) add(n); });
    var m = q.match(/between\s+(.+?)\s+and\s+(.+?)\??$/i); if (m) { add(m[1]); add(m[2]); }
    return names.filter(function (n) { return !/^(Primary Relationship|Role|Current Focus|Completion|Birthday|Children|Attribute|Detail|Regular syncs|Family management|Shared parenthood)$/i.test(n); }).slice(0, 8);
  }
  function loadAskCards(answer, q, serial) {
    var names = askEntityCandidates(answer, q);
    state.graphAsk.cards = []; state.graphAsk.cardsBusy = names.length > 0;
    var host = document.querySelector('#graphAsk'); if (host) host.innerHTML = askBlockInner();
    var seen = {};
    Promise.all(names.map(function (n) {
      return call('graph.search', { q: n, limit: 3 }).then(function (d) {
        var items = d.items || [];
        var hit = items.find(function (it) { return String(it.id).toLowerCase() === n.toLowerCase(); }) || items.find(function (it) { return String(it.type || '').toLowerCase() === 'person' && String(it.id).toLowerCase().indexOf(n.toLowerCase()) === 0; });
        if (!hit || seen[hit.id]) return null; seen[hit.id] = 1;
        return call('graph.entity', { id: hit.id, limit: 6 }).then(function (en) { return en.found === false ? null : en; }, function () { return null; });
      }, function () { return null; });
    })).then(function (ents) {
      if(serial!==graphQuestionSerial)return;
      state.graphAsk.cards = ents.filter(Boolean); state.graphAsk.cardsBusy = false;
      var h = document.querySelector('#graphAsk'); if (h) h.innerHTML = askBlockInner();
    });
  }
  // The index stamps first_seen as epoch seconds; the inspector renders it as
  // an age, the card as a date. Accept seconds, milliseconds or ISO.
  function whenLabel(v) {
    if (v == null || v === '') return '';
    var n = typeof v === 'number' ? v : (/^\d{9,13}$/.test(String(v)) ? Number(v) : NaN);
    var d = isNaN(n) ? new Date(String(v)) : new Date(n < 1e11 ? n * 1000 : n);
    return isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
  }
  function entityCardText(en) {
    var desc = (en.descriptions && en.descriptions.length ? en.descriptions : (en.description ? [en.description] : [])).join('\n');
    var rels = (en.edges || []).slice(0, 6).map(function (e) { var other = e.source === en.id ? e.target : e.source; return '- ' + other + (e.description ? ': ' + e.description : ''); }).join('\n');
    return en.id + ' (' + (en.type || 'entity') + ', ' + fmt(en.degree || 0) + ' connections)\n' + desc + (rels ? '\nRelationships:\n' + rels : '');
  }
  function askEntityCard(en) {
    var inView = state.graphFocus === en.id || (state.graphNeighbors || []).indexOf(en.id) !== -1;
    var desc = (en.descriptions && en.descriptions.length ? en.descriptions[0] : en.description) || '';
    var rels = (en.edges || []).slice(0, 3).map(function (e) { var other = e.source === en.id ? e.target : e.source; return '<div class="setup-source"><b>' + esc(other) + '</b><span class="muted">' + esc((e.description || '').slice(0, 140)) + '</span></div>'; }).join('');
    return '<section class="ask-entity"><div class="row spread"><h4>' + esc(en.id) + '</h4><span class="meta">' + esc(en.type || 'entity') + ' · ' + fmt(en.degree || 0) + ' connections' + (en.created_at || en.first_seen_build ? ' · first indexed ' + esc(whenLabel(en.created_at || en.first_seen_build)) : '') + (inView ? ' · in view' : '') + '</span></div>' +
      (desc ? '<p>' + esc(desc.length > 320 ? desc.slice(0, 320) + '…' : desc) + '</p>' : '<p class="muted">No description stored.</p>') + rels +
      '<div class="setup-row"><button class="quiet" onclick="cosApp.copyAskEntity(' + attr(en.id) + ')">Copy context</button><button class="quiet" onclick="cosApp.askEntityPassages(' + attr(en.id) + ')">Show passages</button><button class="quiet" onclick="cosApp.focusEntity(' + attr(en.id) + ')">' + (inView ? 'Explore from here' : 'Explore from here (loads its neighborhood)') + '</button></div></section>';
  }
  var graphQuestionSerial=0;
  var askTickTimer=null;
  function askElapsed(startedAt){return startedAt?Math.max(0,Math.floor((Date.now()-startedAt)/1000)):0;}
  function askBusyCopy(secs){
    var phase = secs < 8 ? 'Searching the graph' : secs < 25 ? 'Choosing the relevant points' : 'Still working';
    return phase + ' · ' + secs + 's · usually about a minute';
  }
  function askProgressHtml(startedAt){
    return '<div class="ask-progress" role="status" aria-live="polite"><span class="ask-spin" aria-hidden="true"></span><span data-role="ask-progress-copy">' + esc(askBusyCopy(askElapsed(startedAt))) + '</span></div>';
  }
  function stopAskTick(){if(state.graphAsk.busy||state.askBusy)return;if(askTickTimer){clearInterval(askTickTimer);askTickTimer=null;}}
  function tickAskProgress(){
    if(!state.graphAsk.busy && !state.askBusy){stopAskTick();return;}
    var secs = state.graphAsk.busy ? askElapsed(state.graphAsk.startedAt) : askElapsed(state.askStartedAt);
    var copy = askBusyCopy(secs);
    var nodes = document.querySelectorAll('[data-role="ask-progress-copy"]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = copy;
    var meta = document.querySelector('[data-role="ask-busy-meta"]');
    if (meta) meta.textContent = 'working · ' + secs + 's';
  }
  function startAskTick(){if(askTickTimer){clearInterval(askTickTimer);askTickTimer=null;}askTickTimer=setInterval(tickAskProgress,1000);}
  function paintAsk(){var host=document.querySelector('#graphAsk');if(host)host.innerHTML=askBlockInner();}
  function askBlockInner() {
    if(fileGraph())return '<section class="source-card ask-card"><h3>Ask the graph</h3><p>Model answers need an advanced graph pipeline. Explore your document links below or configure Knowledge in settings.</p></section>';

    var a = state.graphAsk, focus = state.graphFocus, nbrs = state.graphNeighbors || [];
    var suggested = !focus ? 'Ask about people, ideas, or their connections' : nbrs.length ? 'Show me the relation between ' + focus + ' and ' + nbrs[0] : 'What does the graph know about ' + focus + '?';
    var chips = nbrs.slice(0, 4).map(function (n) { return '<button class="quiet chip" ' + (a.busy ? 'disabled' : '') + ' onclick="cosApp.askGraphAbout(' + attr(focus) + ', ' + attr(n) + ')">' + esc(focus) + ' ↔ ' + esc(n) + '</button>'; }).join('');
    var names = [];
    if (a.answer) { [focus].concat(nbrs).forEach(function (n) { if (n && a.answer.answer.indexOf(n) !== -1 && names.indexOf(n) === -1) names.push(n); }); }
    var parsed = a.answer ? parseAskAnswer(a.answer.answer) : { prose: '', refs: [] };
    return '<section class="source-card ask-card"' + (a.busy ? ' aria-busy="true"' : '') + '><div class="row spread"><h3>Ask the graph</h3><span class="meta"' + (a.busy ? ' data-role="ask-busy-meta"' : '') + '>' + (a.busy ? 'working · ' + askElapsed(a.startedAt) + 's' : 'plain language · about a minute') + '</span></div><p>Ask about a person, an idea, or how things connect. COS will choose the points and trace their connections.</p>' +
      '<div class="setup-row"><input aria-label="Ask the graph" id="graphAskQ" oninput="cosApp.questionDraft(this.value)" value="' + esc(a.q) + '" placeholder="' + esc(suggested) + '" ' + (a.busy ? 'disabled' : '') + ' onkeydown="if(event.key===\'Enter\')cosApp.askGraphGo()"><button ' + (a.busy ? 'disabled' : '') + ' onclick="cosApp.askGraphGo()">' + (a.busy ? '<span class="ask-spin" aria-hidden="true"></span>Asking…' : 'Ask') + '</button></div>' +
      (chips ? '<div class="setup-row chips">' + chips + '</div>' : '') +
      (a.busy ? askProgressHtml(a.startedAt) : '') +
      (a.graphMessage ? '<p class="graph-question-status" role="status">' + esc(a.graphMessage) + '</p>' : '') +
      (a.error ? '<p class="bad">' + esc(a.error) + '</p>' : '') +
      (a.answer ? '<div class="setup-answer prose">' + renderMarkdown(parsed.prose) + '</div>' + askRefsHtml(parsed.refs) + '<div class="row spread"><p class="muted">' + (a.answer.elapsed_s != null ? Math.round(a.answer.elapsed_s) + ' s · ' : '') + esc(a.answer.mode || 'hybrid') + ' mode · synthesized from the graph, not a quote</p><span class="row"><button class="quiet" onclick="cosApp.copyAsk(false)">Copy answer</button><button class="quiet" onclick="cosApp.copyAsk(true)">Copy with context</button></span></div>' +
        (a.cardsBusy ? '<p class="muted">Looking up the entities it names…</p>' : (a.cards && a.cards.length ? '<h4 class="ask-cards-title">In the graph</h4><div class="ask-cards">' + a.cards.map(askEntityCard).join('') + '</div>' : '')) : '') +
      '</section>';
  }
  function nodeFromEntity(en) { return { id: en.id, group: en.type || 'unknown', descs: en.descriptions && en.descriptions.length ? en.descriptions : (en.description ? [en.description] : []), ts: en.created_at || null, totalDegree: en.degree || 0 }; }
  function neighborhood(focus) {
    return call('graph.entity', { id: focus, limit: 30 }).then(function (en) {
      if (en.found === false) throw Object.assign(new Error('No entity named ' + focus + ' in the graph.'), { status: 404 });
      var nodes = [nodeFromEntity(en)], seen = {}; seen[en.id] = 1;
      (en.neighbors || []).forEach(function (n) { if (!seen[n.id]) { seen[n.id] = 1; nodes.push({ id: n.id, group: n.type || 'unknown', descs: [], ts: null, totalDegree: n.degree || 0 }); } });
      var links = (en.edges || []).filter(function (e) { return seen[e.source] && seen[e.target]; }).map(function (e) { return { source: e.source, target: e.target, weight: e.weight || 1, desc: e.description || '' }; });
      var g = state.graphStatus || {};
      state.graphVisible = nodes.length;
      state.graphNeighbors = links.slice().sort(function (a, b) { return (b.weight || 0) - (a.weight || 0); }).map(function (l) { return l.source === focus ? l.target : l.source; }).filter(function (id, i, arr) { return id !== focus && arr.indexOf(id) === i; }).slice(0, 6);
      setTimeout(function () { var host = document.querySelector('#graphAsk'); if (host && !state.graphAsk.busy) host.innerHTML = askBlockInner(); }, 0);
      return { nodes: nodes, links: links, corpus_total_nodes: g.entities || nodes.length, corpus_total_edges: g.relationships || links.length, generated_at: g.index_built_at || null,
        description_scope: 'the ' + focus + ' neighborhood', selection_description: focus + ' and up to 30 direct neighbors, read live from this Mac\'s index' };
    });
  }
  // ── Curation (0.5.205, server 6.44.14): merge with a preview and a receipt; duplicates that only propose ──
  // Miles 2026-09-08: "Build the Manage merge path with the preview" and "address any of the obvious
  // duplicates like the miels and queen example from above without clobbering entities."
  state.merge = null;   // { source, target, rule, preview, phase: loading|preview|starting|running|failed, receipt, logTail, armed, resolve }
  state.dups = { busy: false, data: null, error: null };
  var MERGE_POLL_MS = 3000;
  function mergeFlow(source, target, rule) {
    return new Promise(function (resolve) {
      if (state.merge && (state.merge.phase === 'running' || state.merge.phase === 'starting')) { toast('A merge is already running. Wait for its receipt.'); resolve(false); return; }
      state.merge = { source: source, target: target, rule: rule || null, preview: null, phase: 'loading', receipt: null, logTail: [], armed: false, resolve: resolve, startedAt: null };
      renderMerge(true);
      call('graph.merge.preview', { source: source, target: target }).then(function (pv) {
        var m = state.merge; if (!m || m.resolve !== resolve) return;
        m.preview = pv;
        if (pv.blocked) { finishMerge(false, pv.block_reason || 'Refused.'); return; }
        if (!pv.source || !pv.source.found || !pv.target || !pv.target.found) { finishMerge(false, 'No entity named ' + (pv.source && pv.source.found ? target : source) + ' in this Mac\'s index. Rebuild the index and try again.'); return; }
        m.phase = 'preview'; renderMerge(true);
        call('workspace.request',{action:'identity_status',source:source,target:target}).then(function(d){
          if(state.merge!==m)return;m.identity=d;renderMerge();
        },function(e){if(state.merge!==m)return;m.identityError=e.message;renderMerge();});
      }, function (e) { finishMerge(false, e.message); });
    });
  }
  function finishMerge(ok, message) {
    var m = state.merge; if (!m) return;
    state.merge = null;
    if (state.modalOpen === 'merge') closeModal();
    if (message) toast(message);
    if (m.resolve) m.resolve(ok);
  }
  // Updates the open sheet in place; opens it only when asked (a poll must never reopen a sheet the user closed).
  function renderMerge(open) {
    var m = state.merge; if (!m) return;
    var body = document.querySelector('#mergeBody');
    if (body && state.modalOpen === 'merge') { body.innerHTML = mergeSheetInner(); return; }
    if (!open) return;
    state.modalOpen = 'merge';
    modal('Merge ' + esc(m.source) + ' into ' + esc(m.target), '<div id="mergeBody">' + mergeSheetInner() + '</div>');
  }
  function mergeCard(en, keep) {
    var descs = (en.descriptions && en.descriptions.length) ? en.descriptions.map(function (d) { return '<p>' + esc(d) + '</p>'; }).join('') : '<p class="muted">No description extracted.</p>';
    var more = en.description_count > (en.descriptions || []).length ? '<p class="muted small">' + fmt(en.description_count - en.descriptions.length) + ' more description' + (en.description_count - en.descriptions.length === 1 ? '' : 's') + ' not shown</p>' : '';
    return '<div class="merge-col' + (keep ? ' keep' : '') + '"><h4>' + esc(en.id) + '</h4><div class="meta">' + (keep ? 'survives · ' : 'folds in · ') + esc(en.type || 'entity') + ' · ' + fmt(en.degree || 0) + ' connection' + (en.degree === 1 ? '' : 's') + (en.created_at ? ' · first indexed ' + esc(whenLabel(en.created_at)) : '') + '</div>' + descs + more + '</div>';
  }
  function mergeSteps(step) {
    var order = ['starting', 'locking', 'staging', 'snapshot', 'merging', 'indexing', 'exporting', 'done'];
    var labels = { starting: 'Starting the worker', locking: 'Taking the ingest lock', staging: 'Preparing an isolated copy of all graph stores', snapshot: 'Copying the graph aside', merging: 'Merging in LightRAG (re-embeds the merged texts)', indexing: 'Rebuilding this Mac\'s index', exporting: 'Refreshing the Observatory export', done: 'Done' };
    var at = Math.max(0, order.indexOf(step || 'starting'));
    return '<ol class="merge-steps">' + order.slice(0, -1).map(function (s, i) { return '<li class="' + (i < at ? 'done' : i === at ? 'now' : '') + '">' + esc(labels[s]) + '</li>'; }).join('') + '</ol>';
  }
  function mergeSheetInner() {
    var m = state.merge; if (!m) return '';
    if (m.phase === 'loading') return '<p class="muted">Asking this Mac what the merge would do…</p>';
    var pv = m.preview || {}, eff = pv.effect || {}, r = m.receipt || {};
    if (m.phase === 'preview' || m.phase === 'starting') {
      var big = (pv.warnings || []).some(function (w) { return w.code === 'large_merge'; });
      var unavailable = (pv.warnings || []).some(function (w) { return w.code === 'physical_merge_unavailable'; });
      var warn = (pv.warnings || []).map(function (w) { return '<p class="' + (w.code === 'large_merge' || w.code === 'nothing_links_them' ? 'bad' : 'muted') + '">' + esc(w.text) + '</p>'; }).join('');
      var mins = eff.estimated_seconds ? Math.max(1, Math.round(eff.estimated_seconds / 60)) : null;
      return '<p>Read both before merging. ' + (pv.name_signal ? '<span class="badge green">' + esc(pv.name_signal) + '</span>' : '<span class="badge">no name similarity</span>') + '</p>' +
        '<div class="merge-cmp">' + mergeCard(pv.target, true) + mergeCard(pv.source, false) + '</div>' +
        '<p class="muted">' + (pv.shared_count ? 'Shared neighbors: ' + esc((pv.shared_neighbors || []).join(', ')) + (pv.shared_count > (pv.shared_neighbors || []).length ? ' and ' + fmt(pv.shared_count - pv.shared_neighbors.length) + ' more' : '') : 'No shared neighbors.') + (pv.adjacent ? ' They are directly connected; that edge collapses.' : '') + '</p>' +
        '<p><b>Proposed effect:</b> ' + fmt(eff.moved || 0) + ' relationship' + (eff.moved === 1 ? '' : 's') + ' move to ' + esc(m.target) + ', ' + fmt(eff.collapsed || 0) + ' fold into ones it already has, ' + fmt(eff.embeddings || 0) + ' text' + (eff.embeddings === 1 ? '' : 's') + ' re-embedded' + (mins ? ', about ' + mins + ' minute' + (mins === 1 ? '' : 's') : '') + '. Original source documents remain unchanged. A graph-only copy does not restore every affected store.</p>' + warn +
        (m.rule ? '<p class="muted small">Rule recorded with the receipt: ' + esc(m.rule.scope || '') + ' "' + esc(m.rule.pattern || '') + '" → "' + esc(m.rule.replacement || '') + '".</p>' : '') +
        (m.identity && m.identity.writable && !m.identity.same_identity ? '<p class="small">If these are different people or ideas, keep them separate to block future merges of these alias groups.</p><button class="quiet" onclick="cosApp.keepApart()" ' + (m.phase === 'starting' ? 'disabled' : '') + '>Keep these separate</button>' : '') +
        (m.identityError ? '<p class="small muted">Identity constraints: ' + esc(m.identityError) + '</p>' : '') +
        '<div class="setup-row"><button class="quiet" onclick="cosApp.mergeCancel()" ' + (m.phase === 'starting' ? 'disabled' : '') + '>Cancel</button><button onclick="cosApp.mergeGo()" ' + (m.phase === 'starting' || unavailable ? 'disabled' : '') + '>' + (unavailable ? 'Merge unavailable' : m.phase === 'starting' ? 'Starting…' : (big && !m.armed ? 'Merge ' + fmt(pv.source.degree) + ' relationships…' : (m.armed ? 'Yes, merge ' + fmt(pv.source.degree) + ' relationships' : 'Merge on this Mac'))) + '</button></div>' +
        (big && m.armed ? '<p class="bad">Click again to confirm. This re-embeds ' + fmt(eff.embeddings || 0) + ' texts and rewrites the vector stores.</p>' : '');
    }
    if (m.phase === 'running') {
      var secs = m.startedAt ? Math.round((Date.now() - m.startedAt) / 1000) : 0;
      return '<p>Running on this Mac' + (r.ticket ? ' · ticket ' + esc(r.ticket) : '') + ' · ' + secs + ' s' + (eff.estimated_seconds ? ' of about ' + eff.estimated_seconds : '') + '</p>' + mergeSteps(r.step) +
        (m.logTail && m.logTail.length ? '<pre class="merge-log">' + esc(m.logTail.slice(-4).join('\n')) + '</pre>' : '') +
        '<p class="muted small">Runs in the background; you can close this and come back. The graph reloads around ' + esc(m.target) + ' when it is done.</p><div class="setup-row"><button class="quiet" onclick="cosApp.mergeHide()">Close</button></div>';
    }
    if (m.phase === 'failed') {
      return '<p class="bad">' + esc(r.error || 'The merge did not finish.') + '</p>' + mergeSteps(r.step) + (r.snapshot ? '<p class="muted small">The pre-merge copy of the graph is intact: ' + esc(r.snapshot) + '</p>' : '') +
        '<div class="setup-row"><button class="quiet" onclick="cosApp.mergeCancel()">Close</button></div>';
    }
    return '';
  }
  function pollMerge() {
    var m = state.merge; if (!m || m.phase !== 'running') return;
    setTimeout(function () {
      if (state.merge !== m || m.phase !== 'running') return;
      call('graph.merge.status').then(function (d) {
        if (state.merge !== m) return;
        m.receipt = d.receipt || m.receipt; m.logTail = d.log_tail || [];
        var st = m.receipt && m.receipt.state;
        if (st === 'done') { mergeDone(); return; }
        if (st === 'failed' || (!d.running && st !== 'done')) { m.phase = 'failed'; renderMerge(); if (state.modalOpen !== 'merge') toast('Merge of ' + m.source + ' failed: ' + ((m.receipt && m.receipt.error) || 'no detail')); return; }
        renderMerge(); pollMerge();
      }, function () { renderMerge(); pollMerge(); });
    }, MERGE_POLL_MS);
  }
  function mergeDone() {
    var m = state.merge; if (!m) return;
    var r = m.receipt || {}, after = r.after || {};
    finishMerge(true, 'Merged ' + m.source + ' into ' + m.target + (after.target != null ? ' · ' + fmt(after.target) + ' connections now' : '') + (r.embedded_texts != null ? ' · ' + fmt(r.embedded_texts) + ' texts re-embedded' : '') + '.');
    state.graphFocus = m.target; state.graphFocusChosen = true; state.graphQuery = '';
    state.graphMemories = {};
    loadGraphStatus().then(function () { render(); }, function () { render(); });
    if (state.dups.data) cosApp.duplicatesScan();
  }
  function dupGroup(g) {
    var t = g.members[0] || {};
    return '<div class="dup-group"><div class="row spread"><b>' + esc(g.target) + '</b><span class="meta">' + fmt(t.degree || 0) + ' connections · <span class="badge' + (g.confidence === 'high' ? ' green' : '') + '">' + esc(g.confidence) + '</span></span></div>' +
      (t.description ? '<p class="muted small">' + esc(t.description) + '</p>' : '') +
      g.members.slice(1).map(function (m) {
        return '<div class="setup-source dup-member"><span><b>' + esc(m.id) + '</b> <span class="muted">' + fmt(m.degree) + ' connection' + (m.degree === 1 ? '' : 's') + ' · ' + fmt(m.shared_neighbors) + ' shared' + (m.why ? ' · ' + esc(m.why) : '') + '</span>' + (m.description ? '<br><span class="muted small">' + esc(m.description) + '</span>' : '') + '</span><button class="quiet" onclick="cosApp.mergeFrom(' + attr(m.id) + ', ' + attr(g.target) + ')">Preview merge</button></div>';
      }).join('') + '</div>';
  }
  function duplicatesCard() {
    if(state.graphStatus && state.graphStatus.engine==='explicit_document_links')return '';

    var d = state.dups;
    var head = '<div class="row spread"><h3>Possible duplicates</h3><span class="meta">people whose names look like one person · proposals only</span></div>';
    var rescan = '<div class="setup-row"><button class="quiet" onclick="cosApp.duplicatesScan()">Scan again</button></div>';
    var wrap = function (inner) { return '<section class="source-card dups-card">' + head + inner + '</section>'; };
    if (d.error) return wrap('<p class="bad">' + esc(d.error) + '</p>' + rescan);
    if (d.busy) return wrap('<p class="muted">Scanning this Mac\'s index…</p>');
    if (!d.data) return wrap('<p class="muted">Groups person entities whose names are variants of one another: a bare first name that matches one full name, a surname within two letters, one name spelling out the other. People the graph knows to be different never share a group. Nothing merges on its own; each row opens the same two-step preview as Manage.</p><div class="setup-row"><button class="quiet" onclick="cosApp.duplicatesScan()">Find possible duplicates</button></div>');
    var groups = d.data.groups || [];
    if (!groups.length) return wrap('<p class="muted">No name variants among ' + fmt(d.data.scanned || 0) + ' people' + (d.data.available === false ? ' (no index on this Mac yet)' : '') + '.</p>' + rescan);
    return wrap('<p class="muted">' + fmt(d.data.total_groups || groups.length) + ' group' + (d.data.total_groups === 1 ? '' : 's') + ' among ' + fmt(d.data.scanned || 0) + ' people' + (groups.length < (d.data.total_groups || 0) ? ', showing the first ' + groups.length : '') + '. Read both descriptions before merging: a merge is reviewed twice and refused for people the graph knows apart.</p>' + groups.map(dupGroup).join('') + rescan);
  }
  function paintDups() { var host = document.querySelector('#graphDups'); if (host) host.innerHTML = duplicatesCard(); }

  function mountKnowledgeGraph() {
    var host = document.querySelector('#graphMount'); if (!host) return;
    if(window.COSMemoryWorkspace) {
      if(!state.workspace) state.workspace=window.COSMemoryWorkspace.create({call:call,toast:toast,openPassages:openPassages,onUserIntent:function(){state.graphFocusChosen=true;},onController:function(c){state.graphController=c;state.graphVisible=c.snapshot().nodes.length;var label=document.querySelector('[data-role="graph-visible"]');if(label)label.textContent=fmt(state.graphVisible)+' entities in this view';},graphOptions:{
        labels:{graphName:state.graphStatus && state.graphStatus.engine==='explicit_document_links'?'Your document links':'Your LightRAG data'},
        onCopy:function(text,label){call('copy',{text:text,label:label}).then(function(){toast('Copied as grounded context');},function(e){toast(e.message);});},
        memoriesFor:function(id){var hits=state.graphMemories[id];if(hits===undefined){state.graphMemories[id]=null;call('memories.search',{q:id,limit:5}).then(function(d){state.graphMemories[id]=(d.hits||[]).map(function(h){return {id:h.id,title:h.summary||h.content||h.id};});if(state.graphController)state.graphController.select(id);},function(){state.graphMemories[id]=[];});}return hits||[];},
        onOpenMemory:function(memoryId){state.view='learning';state.filter='memories';state.selectedMemory=memoryId;render();},
        curation:{enabled:!(state.graphStatus && state.graphStatus.engine==='explicit_document_links'),ownerLabel:hostLabel(state.graphStatus&&state.graphStatus.source&&state.graphStatus.source.owner_host)||'the owner Mac',isOwner:!!(state.graphStatus&&state.graphStatus.source&&state.graphStatus.source.is_owner)},
        onCuration:function(change){if(change.op!=='merge'){toast('Rename and remove are unavailable. Nothing was changed.');return false;}return mergeFlow(change.source,change.target,change.rule&&change.rule.pattern?change.rule:null);}
      }});
      state.workspace.attach(host,state.graphFocus); return;
    }
    if (state.graphController) { try { state.graphController.destroy(); } catch (e) {} state.graphController = null; }
    var focus = state.graphFocus;
    if (!focus) { host.textContent = 'Find a point above to explore its connections.'; return; }
    state.graphController = COSGraphExplorer.mount(host, {
      scope: 'actual', status: 'ready', focus: focus, endpoint: '',
      request: function (path) { if (path.indexOf('/api/graph') === 0) return neighborhood(focus); return Promise.reject(Object.assign(new Error('Not served by this host'), { status: 404 })); },
      labels: { sourceStatus: 'Descriptions are extracted summaries. Show passages reads the index behind this entity.' },
      memoriesFor: function (id) { var hits = state.graphMemories[id]; if (hits === undefined) { state.graphMemories[id] = null; call('memories.search', { q: id, limit: 5 }).then(function (d) { state.graphMemories[id] = (d.hits || []).map(function (h) { return { id: h.id, title: h.summary || h.content || h.id }; }); if (state.graphController && state.graphController.select) state.graphController.select(id); }, function () { state.graphMemories[id] = []; }); } return hits || []; },
      onOpenMemory: function (memoryId) { state.view = 'learning'; state.filter = 'memories'; state.selectedMemory = memoryId; render(); },
      onCopy: function (text, label) { call('copy', { text: text, label: label }).then(function () { toast('Copied as grounded context'); }, function (e) { toast(e.message); }); },
      onRecenter: function (id) { state.graphFocus = id; state.graphFocusChosen = true; state.graphQuery = ''; render(); },
      onPassages: function (id) { call('graph.passages', { entity: id, limit: 5 }).then(function (d) { openPassages(id, d); }, function (e) { toast(e.message); }); },
      curation: { ownerLabel: hostLabel(state.graphStatus && state.graphStatus.source && state.graphStatus.source.owner_host) || 'the owner Mac', isOwner: !!(state.graphStatus && state.graphStatus.source && state.graphStatus.source.is_owner) },
      // 0.5.205: Merge into… runs for real (server 6.44.14). The explorer's own comparison is
      // step one; the owner Mac's preview is step two; the receipt is polled until it settles.
      // The promise keeps the explorer's row "pending" and undoes it on a refusal or failure.
      onCuration: function (change) {
        if (change.op !== 'merge') { toast('Rename and remove arrive in a later release. Nothing was changed.'); return false; }
        return mergeFlow(change.source, change.target, change.rule && change.rule.pattern ? change.rule : null);
      }
    });
    // "Visible" in the Sync card counts what the neighborhood returned.
    setTimeout(function () { var dd = document.querySelector('.sync-grid'); if (dd && state.graphVisible != null) { var cells = dd.querySelectorAll('dd'); if (cells[4]) cells[4].textContent = fmt(state.graphVisible) + ' entities in this view'; } }, 1500);
  }
  state.graphMemories = {};
  function openPassages(id, d) {
    var items = d.items || [];
    modal('Passages · ' + esc(id), (d.note ? '<p>' + esc(d.note) + '</p>' : '') + (items.length ? items.map(function (it) { var s = it.source || {}; return '<div class="logrow">' + esc(s.title || 'Passage') + (s.date ? ' · ' + esc(s.date) : '') + (s.status && s.status !== 'resolved' ? ' · ' + esc(s.status) : '') + '<small>' + esc(it.excerpt) + '</small></div>'; }).join('') : '<p>No passages behind this entity in the index.</p>') + '<p class="muted">' + fmt(d.total || 0) + ' passage' + (d.total === 1 ? '' : 's') + ' in the index' + (d.fallback ? ' · read from ' + esc(d.fallback) : '') + '.</p>');
  }
  function graphSearch() {
    var q = (document.querySelector('#graphQuery') || {}).value || ''; q = q.trim(); state.graphQuery = q;
    var status = document.querySelector('#graphSearchStatus');
    if (q.length < 2) { if (status) status.textContent = 'Type at least two characters.'; return; }
    state.graphFocusChosen = true;
    if (status) status.textContent = 'Looking up…';
    call('graph.search', { q: q, limit: 5 }).then(function (d) {
      var items = d.items || [];
      if (!items.length) { if (status) status.textContent = d.indexState === 'missing' ? 'No knowledge index on this Mac yet. Build it above.' : 'No entities match that lookup.'; return; }
      if(state.workspace) { state.workspace.showMatches(items); if(status) status.textContent=items.length+' matches · select a point below'; return; }
      state.graphFocus = items[0].id; state.graphFocusChosen = true; render();
    }, function (e) { if (status) status.textContent = e.message; });
  }
  function exploreTerm(e) { if (e.category && e.category !== e.scope && e.category !== 'unknown') return e.category; return String(e.title || '').split(' ').slice(0, 4).join(' ') || 'COS'; }
  function exploreInGraph(id) {
    var e = findEvent(id); if (!e) return;
    state.knowledgeFocus = id; state.view = 'knowledge'; state.knowledgeTab = 'graph'; state.graphQuery = exploreTerm(e); render();
    call('graph.search', { q: state.graphQuery, limit: 3 }).then(function (d) { var items = d.items || []; if (items.length) { state.graphFocus = items[0].id; state.graphFocusChosen = true; render(); } else toast('No entity in the graph matches "' + state.graphQuery + '". Showing ' + state.graphFocus + '.'); }, function (er) { toast(er.message); });
  }
  function findEvent(id) { return state.recent.concat(state.review).find(function (x) { return x.event_id === id; }); }

  // ── decisions (the one write with a backend tonight) ────────────
  state.decisions = {};
  function decide(id, decision) {
    var e = findEvent(id); if (!e) return;
    call('learning.decide', { id: e.lesson_id, decision: decision }).then(function () {
      state.decisions[e.lesson_id] = decision;
      toast(decision === 'dismissed' ? 'Proposal dismissed. The To review count updates on the next refresh.' : 'Proposal restored.');
      call('learning.review', { limit: 200 }).then(function (d) { state.review = d.events || []; state.reviewCount = d.reviewCount != null ? d.reviewCount : d.total; render(); }, function () { render(); });
    }, function (er) { toast(er.message); });
  }

  // ── copy context ────────────────────────────────────────────────
  function contextText(e, opts) {
    var full = state.detail[e.event_id]; var x = Object.assign({}, e, full && !full._error ? full : {});
    var lines = ['Learning ' + x.event_id + ' (' + kindLabel(x) + ' · ' + (x.scope || '') + ' · ' + (x.ts || '') + ')', '', '"""', x.title || ''];
    var d = x.detail || {};
    if (d.before) lines.push('Before: ' + d.before); if (d.after) lines.push('After: ' + d.after); if (d.rule) lines.push('Rule: ' + d.rule); if (d.content) lines.push(d.content); (d.bodies || []).forEach(function (b) { lines.push(b); });
    lines.push('"""');
    if (opts.sources && (x.source_refs || []).length) { lines.push('', 'Sources:'); x.source_refs.forEach(function (r) { lines.push('- ' + (r.kind || '') + ' ' + (r.id || '') + (r.excerpt ? ': ' + r.excerpt : '')); }); }
    var o = outcomeText(x); if (o) lines.push('', 'Checked: ' + o);
    if (opts.graph) lines.push('', 'Related knowledge: open the entity in Knowledge and use its Copy context for descriptions and relationships.');
    return lines.join('\n');
  }
  function openCopyContext(id) {
    state.copyId = id; var e = findEvent(id); if (!e) return;
    modal('Copy context', '<p>Preview the exact text, then copy it. Sources are included by default.</p><div class="copy-options"><label><input type="checkbox" ' + (state.copyOptions.sources ? 'checked' : '') + ' onchange="cosApp.copyOption(\'sources\',this.checked)"> Include sources</label><label><input type="checkbox" ' + (state.copyOptions.graph ? 'checked' : '') + ' onchange="cosApp.copyOption(\'graph\',this.checked)"> Include a related-knowledge note</label></div><textarea class="editor context-preview" id="contextPreview" readonly>' + esc(contextText(e, state.copyOptions)) + '</textarea><div class="actions"><button class="primary" onclick="cosApp.copyNow()">Copy</button><button onclick="cosApp.selectContextText()">Select text</button></div><p class="copy-footnote muted">Quoted and labelled with its id: the same data-not-instructions contract the glasses use when they attach a reference.</p>');
  }
  function copyOption(k, v) { state.copyOptions[k] = v; var e = findEvent(state.copyId); var ta = document.querySelector('#contextPreview'); if (e && ta) ta.value = contextText(e, state.copyOptions); }
  function copyNow() { var e = findEvent(state.copyId); if (!e) return; call('copy', { text: contextText(e, state.copyOptions), label: 'Copy context' }).then(function () { toast('Copied as grounded context'); closeModal(); }, function (er) { toast(er.message); }); }
  function selectContextText() { var ta = document.querySelector('#contextPreview'); if (ta) { ta.focus(); ta.select(); } }
  function copyMemory(id) {
    var m = (state.memoryHits || state.memories).find(function (x) { return x.id === id; }) || {}; var full = state.memoryDetail[id] || {}; var r = Object.assign({}, m, full._error ? {} : full);
    var text = 'Memory ' + id + (r.type || r.created_at ? ' (' + [r.type, dateOnly(r.created_at)].filter(Boolean).join(' · ') + ')' : '') + '\n\n"""\n' + (r.content || r.summary || '') + '\n"""';
    call('copy', { text: text, label: 'Copy memory' }).then(function () { toast('Copied as grounded context'); }, function (er) { toast(er.message); });
  }

  // ── modals ──────────────────────────────────────────────────────
  function modal(title, body) {
    if (!document.querySelector('.modal')) window.previousFocus = document.activeElement;
    document.body.classList.add('modal-open');
    document.querySelector('#modalRoot').innerHTML = '<div class="modal-backdrop" onclick="if(event.target===this)cosApp.closeModal()"><section class="modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="row spread"><h2>' + title + '</h2><button class="quiet" aria-label="Close dialog" onclick="cosApp.closeModal()">✕</button></div>' + body + '</section></div>';
    var first = document.querySelector('.modal button'); if (first) first.focus();
  }
  function closeModal() {
    if(state.modalOpen==='stewardship'&&state.stewardship)state.stewardship.close();
    if (state.modalOpen === 'merge' && state.merge && (state.merge.phase === 'preview' || state.merge.phase === 'loading')) { var pending = state.merge; state.merge = null; if (pending.resolve) pending.resolve(false); toast('Nothing was changed.'); }
    state.modalOpen = null; document.body.classList.remove('modal-open'); var existed = !!document.querySelector('.modal'); document.querySelector('#modalRoot').innerHTML = ''; if (existed && window.previousFocus && window.previousFocus.isConnected && ['BODY', 'HTML'].indexOf(window.previousFocus.tagName) < 0) window.previousFocus.focus(); }
  function openSourceRecords() {
    state.view = 'knowledge'; state.knowledgeTab = 'sources'; state.knowledgeTabChosen = true; render();
    var el = document.querySelector('#sourceRecords'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' });
  }
  // Guardrails (0.5.201): the user's own rules for what a captured memory must
  // be, an optional model pass against the philosophy, and a review-now run.
  function loadGuardrails() {
    if (state.guardrailsLoading) return;
    state.guardrailsLoading = true;
    call('memory.guardrails').then(function (d) { state.guardrails = d.guardrails; state.guardrailsRubricLines = d.philosophy_rubric_lines; state.guardrailsError = null; state.guardrailsLoading = false; renderModalIfOpen(); },
      function (e) { state.guardrailsError = e.message; state.guardrailsLoading = false; renderModalIfOpen(); });
  }
  function renderModalIfOpen() { if (state.modalOpen === 'settings') openSettings(true); }
  function guardrailsSection() {
    var g = state.guardrails, busy = state.guardrailsBusy;
    if (state.guardrailsError) return '<section class="settings-block"><h3>Guardrails</h3><p class="muted">' + esc(state.guardrailsError) + '</p><button class="quiet" onclick="cosApp.guardrailsLoad()">Retry</button></section>';
    if (!g) { if (!state.guardrailsLoading) loadGuardrails(); return '<section class="settings-block"><h3>Guardrails</h3><p class="muted">Loading…</p></section>'; }
    var llm = g.llm_review || {};
    var run = state.guardrailsRun, verdicts = run ? (run.verdicts || []) : [];
    var flagged = verdicts.filter(function (v) { return v.verdict === 'prune'; }), review = verdicts.filter(function (v) { return v.verdict === 'review'; });
    var rows = flagged.concat(review).slice(0, 60).map(function (v) {
      return '<div class="setup-source"><span class="' + (v.verdict === 'prune' ? 'bad' : '') + '">' + (v.verdict === 'prune' ? (v.applied ? 'quarantined' : 'prune') : 'for you') + '</span><code>' + esc(v.excerpt || v.id) + '</code><span class="muted">' + esc((v.reasons || []).join('; ')) + (v.by === 'model' ? ' (model)' : '') + '</span></div>';
    }).join('');
    return '<section class="settings-block"><h3>Guardrails</h3>' +
      '<p class="muted">What a captured memory must be to stay. The same rules refuse nonsense at capture time; a run applies them to what already landed.</p>' +
      '<div class="setup-row"><label>Min words <input id="grMinWords" type="number" min="0" max="200" value="' + esc(g.min_words) + '"></label>' +
      '<label>Min distinct chars <input id="grDistinct" type="number" min="0" max="100" value="' + esc(g.min_distinct_chars) + '"></label>' +
      '<label>Max repeat ratio <input id="grRepeat" type="number" min="0.1" max="1" step="0.05" value="' + esc(g.max_repeat_ratio) + '"></label></div>' +
      '<label class="muted">Banned patterns, one per line (regular expressions)</label><textarea id="grBanned" rows="3">' + esc((g.banned_patterns || []).join('\n')) + '</textarea>' +
      (llm.supported===false ? '<p class="muted">This runtime applies deterministic admission rules. A model review provider is not configured.</p>' : '<div class="setup-row"><label><input id="grLlm" type="checkbox" ' + (llm.enabled ? 'checked' : '') + '> Model pass against the COS philosophy (' + fmt(state.guardrailsRubricLines || 0) + ' principles)</label>' +
      '<select id="grModel">' + ['haiku', 'sonnet', 'opus'].map(function (m) { return '<option value="' + m + '"' + (llm.model === m ? ' selected' : '') + '>' + ({ haiku: 'Fast (Haiku)', sonnet: 'Balanced (Sonnet)', opus: 'Deep (Opus)' })[m] + '</option>'; }).join('') + '</select>' +
      '<label>at most <input id="grMax" type="number" min="1" max="100" value="' + esc(llm.max_per_run || 20) + '"> per run</label></div>' +
      '<p class="muted">The model pass makes one bounded provider request per reviewed memory and stops at the configured cap. Off by default.</p>') +
      '<div class="setup-row"><button ' + (busy ? 'disabled' : '') + ' onclick="cosApp.guardrailsSave()">' + (busy === 'save' ? 'Saving…' : 'Save guardrails') + '</button>' +
      '<button class="quiet" ' + (busy ? 'disabled' : '') + ' onclick="cosApp.guardrailsRun(false)">' + (busy === 'run' ? 'Reviewing…' : 'Review captured memories now') + '</button>' +
      (flagged.length && !run.run.applied ? '<button class="quiet" ' + (busy ? 'disabled' : '') + ' onclick="cosApp.guardrailsRun(true)">' + (busy === 'apply' ? 'Pruning…' : 'Review next batch and quarantine matches') + '</button>' : '') + '</div>' +
      (run ? '<p class="muted">Last run: ' + fmt(run.run.scanned) + ' scanned in ' + fmt(run.run.days) + ' days, ' + fmt(run.run.flagged) + ' flagged, ' + fmt(run.run.kept) + ' kept' + (run.run.review ? ', ' + fmt(run.run.review) + ' for you' : '') + (run.run.llm_reviewed ? ', ' + fmt(run.run.llm_reviewed) + ' judged by the model' : '') + (run.run.applied ? ', ' + fmt(run.run.pruned) + ' quarantined' : '') + (run.run.coverage?', '+fmt(run.run.coverage.remaining_after_page)+' remain in this pass':'') + '.</p>' + rows : '') +
      '</section>';
  }
  function loadPolicy() {
    if(state.policyLoading||state.policyBusy)return;state.policyLoading=true;var serial=++policyRequestSerial;
    call('workspace.request',{action:'policy_get'}).then(function(d){if(serial!==policyRequestSerial)return;state.policyData=d;state.policyError=null;state.policyLoading=false;renderModalIfOpen();},function(e){if(serial!==policyRequestSerial)return;state.policyError=e.message;state.policyLoading=false;renderModalIfOpen();});
  }
  function policySet(key,value) {
    if(state.policyBusy)return;
    if(!state.policyIntent){
      var changes={};changes[key]=value;
      state.policyIntent={action:'policy_set',changes:changes,expected_revision:state.policyData.policy.revision,
        idempotency_key:'policy_'+crypto.randomUUID()};
    }
    policyRequestSerial++;state.policyLoading=false;state.policyBusy=true;state.policyError=null;renderModalIfOpen();
    call('workspace.request',state.policyIntent).then(function(d){
      state.policyData={policy:d.policy,writable:true,state:'available'};state.policyIntent=null;state.policyBusy=false;
      toast('Memory policy saved.');renderModalIfOpen();
    },function(e){state.policyBusy=false;state.policyError=e.message;
      if(/revision_conflict|idempotency_conflict|unknown_policy|invalid_policy/.test(e.message)){state.policyIntent=null;state.policyError='Policy changed or request was refused. Reload settings, review the current value, then choose again.';}
      renderModalIfOpen();});
  }
  function ownerCard(){
    var name=state.ownerDraft!=null?state.ownerDraft:(state.ownerProfile&&state.ownerProfile.owner_name)||'';
    return '<section class="setting owner-card"><h3>Who is COS for?</h3><p>Your name personalizes COS and the graph’s starting point. It does not change the indexing Mac or transfer memory ownership.</p><div class="row"><input id="ownerName" aria-label="Owner name" placeholder="Your full name" maxlength="120" value="'+esc(name)+'" oninput="cosApp.ownerDraft(this.value)"><button '+(!state.ownerProfile||state.ownerBusy?'disabled':'')+' onclick="cosApp.saveOwner()">'+(state.ownerBusy?'Saving…':'Save name')+'</button></div>'+(state.ownerError?'<p class="bad">'+esc(state.ownerError)+'</p><button onclick="cosApp.loadOwner()">Retry</button>':'')+'</section>';
  }
  var ownerReadSerial=0,ownerDraftRevision=0;
  function loadOwner(){
    if(state.ownerBusy)return;
    var serial=++ownerReadSerial;
    state.ownerError=null;
    call('profile.owner',{}).then(function(d){if(serial!==ownerReadSerial)return;state.ownerProfile=d;if(state.ownerDraft==null)state.ownerDraft=d.owner_name||'';renderModalIfOpen();},function(e){if(serial!==ownerReadSerial)return;state.ownerError=e.message;renderModalIfOpen();});
  }
  function openSettings(rerender) {
    state.modalOpen='settings';if(!rerender){loadPolicy();loadGuardrails();loadOwner();}
    var s=state.status||{},d=state.policyData,p=d&&d.policy;
    var tier=s.contextScriptsDirectory?'COS Data bridge (vector store + files)':s.contextFilesDirectory?'Plain files':'Not configured';
    function row(key,title,sub){var on=p&&p[key],disabled=!d||!d.writable||state.policyBusy||state.policyIntent;
      return '<div class="setting row spread"><div><h3>'+title+'</h3><small>'+sub+'</small></div><button class="switch '+(on?'on':'')+'" role="switch" aria-checked="'+!!on+'" aria-label="'+title+'" '+(disabled?'disabled':'')+' onclick="cosApp.policySet('+attr(key)+','+!on+')"><span></span></button></div>';}
    var policyBlock=p?row('capture_enabled','Capture completed sessions','Pausing affects new automatic captures. Existing knowledge remains readable.')+
      row('review_required','Review new memories before active recall','Captured candidates wait for your acceptance. Existing accepted memories remain active.')+
      '<p class="muted">Policy revision '+esc(p.revision)+'. Instance owner only. Skill changes require a reviewed, evaluated version.</p>':'<p>Loading effective memory policy…</p>';
    if(d&&!d.writable)policyBlock+='<p>Memory policy is read-only: '+esc(d.state)+'.</p>';
    if(state.policyError)policyBlock+='<p class="bad">'+esc(state.policyError)+'</p><button onclick="cosApp.'+(state.policyIntent?'policyRetry':'policyLoad')+'()">Retry</button>';
    modal('Memory settings',ownerCard()+'<p>Control capture and activation. Retrieval treats source text as evidence, never as instructions.</p>'+policyBlock+
      '<div class="actions"><button onclick="cosApp.openStewardship()">Rules, current sources and outcome evidence</button></div><div class="setting"><h3>Current storage source</h3><small>'+esc(tier)+(s.contextResolvedRoot?' · '+esc(s.contextResolvedRoot):'')+'</small></div>'+guardrailsSection());
  }
  function openLog() {
    var ls = state.learningStatus || {};
    var counts = ls.counts_by_type || {};
    var rows = Object.keys(counts).sort().map(function (k) { return '<div class="logrow">' + esc(KIND[k] || k) + '<small>' + fmt(counts[k]) + ' in the window</small></div>'; }).join('');
    var stores = Object.keys(ls.stores || {}).map(function (k) { var st = ls.stores[k]; return '<div class="logrow">' + esc(STORE[k] || k) + '<small>' + (st.readable || st.state === 'legacy' ? 'readable' + (st.state === 'legacy' ? ' (legacy sink)' : '') + ' · ' + fmt(st.count || 0) + (st.last_ts ? ' · last ' + esc(stamp(st.last_ts)) : '') : 'not readable (' + esc(st.state || '') + ')') + '</small></div>'; }).join('');
    // 0.5.216: name the lessons a later answer used in the Applied window, not just
    // type counts. Capped; overflow points at the Applied filter. Never a score.
    var used = state.applied || [], cap = 10;
    var usedRows = used.slice(0, cap).map(function (e) { var l = lessonText(e.lesson_id) || e.lesson_id || ''; var x = appliedExcerpt(e); return '<div class="logrow">' + esc(String(l).slice(0, 90)) + '<small>' + esc(String(x).slice(0, 110) || 'used by a later answer') + '</small></div>'; }).join('');
    var usedHead = '<h3 style="margin-top:14px">Applied ' + (state.appliedDays === 90 ? 'in 90 days' : 'this week') + '</h3>';
    var windowTotal = Math.max(state.appliedTotal != null ? Number(state.appliedTotal) : 0, used.length);
    var usedBody = used.length ? usedRows + (windowTotal > cap ? '<p class="muted">and ' + fmt(windowTotal - cap) + ' more in Applied ' + (state.appliedDays === 90 ? 'in 90 days' : 'this week') + '.</p>' : '') : '<p class="muted">' + esc(appliedEmptyCopy().h) + '</p>';
    modal('Recent learning activity', '<p>' + esc(ls.notice || ('Snapshot from '+stamp(ls.generated_at)+'. Window: '+stamp(ls.window_start)+' to '+stamp(ls.window_end)+'. Coverage: '+(ls.complete?'complete':'partial')+'.')) + '</p>' + usedHead + usedBody + '<h3 style="margin-top:14px">Event counts</h3>' + (rows || '<p>No events counted.</p>') + '<h3 style="margin-top:14px">Stores</h3>' + stores);
  }

  // ── public surface for inline handlers ──────────────────────────
  window.cosApp = {
    ownerDraft:function(value){ownerDraftRevision++;state.ownerDraft=value;},
    loadOwner:loadOwner,
    saveOwner:function(){
      if(state.ownerBusy||!state.ownerProfile)return;
      var name=(state.ownerDraft||'').trim();if(!name){state.ownerError='Enter your name.';renderModalIfOpen();return;}
      ownerReadSerial++;var draftRevision=ownerDraftRevision;
      state.ownerBusy=true;state.ownerError=null;renderModalIfOpen();
      call('profile.owner.set',{name:name,expected:state.ownerProfile.owner_name||''}).then(function(d){
        state.ownerBusy=false;state.ownerProfile=d;if(draftRevision===ownerDraftRevision)state.ownerDraft=d.owner_name;state.status=state.status||{};state.status.ownerName=d.owner_name;
        state.graphFocusResolved=false;chooseDefaultFocus();renderModalIfOpen();toast('Owner name saved.');
      },function(e){state.ownerBusy=false;state.ownerError=e.message;renderModalIfOpen();});
    },
    openStewardship:function(){if(!state.stewardship)state.stewardship=createMemoryStewardship({call:call,esc:esc,modal:modal,toast:toast});state.modalOpen='stewardship';state.stewardship.open();},
    reviewGoverned:reviewGoverned,loadMoreReview:function(){loadReview(true);},
    policySet:policySet,policyRetry:function(){policySet();},policyLoad:loadPolicy,
    select: function (id) { state.selected = id; render(); },
    selectMemory: function (id) { state.selectedMemory = id; render(); },
    setFilter: function (f) { state.view = 'learning'; state.filter = f; if (f === 'applied' && !state.appliedLoaded && !state.appliedLoading) loadApplied(false); render(); },
    appliedDays: setAppliedDays, loadMoreApplied: function () { loadApplied(true); }, retryApplied: function () { state.errors.applied = null; state.appliedLoaded = false; loadApplied(false); render(); },
    openCues: function (view) { call('cues.open', { view: view === 'rated' ? 'rated' : 'rate' }).catch(function (e) { toast(e.message); }); },
    openKnowledge: function (id) { state.view = 'knowledge'; state.knowledgeTab = id ? 'sources' : 'graph'; state.knowledgeFocus = id || null; render(); },
    setKnowledgeTab: function (t) { state.knowledgeTab = t; state.knowledgeTabChosen = true; render(); },
    openSourceRecords: openSourceRecords,
    backToLearning: function () { state.view = 'learning'; state.filter = 'recent'; if (state.knowledgeFocus) state.selected = state.knowledgeFocus; render(); },
    exploreInGraph: exploreInGraph, graphSearch: graphSearch,
    refresh: loadAll, loadMoreMemories:function(){loadMemoryPage(true);}, refreshGraph: loadGraphStatus, loadMore: loadMore, memoryQuery: memoryQuery,
    setupRefresh: function () { loadSetup(); },
    questionDraft:function(value){state.graphAsk.q=value;},
    askGraphAbout: function (a, b) { cosApp.askGraphGo('Show me the relation between ' + a + ' and ' + b); },
    askGraphGo: function (question) {
      if(state.graphAsk.busy)return;
      var input=document.querySelector('#graphAskQ'),q=typeof question==='string'?question:(input?input.value.trim():'');
      if(!q||q.length<3){toast('Ask a fuller question.');return;}
      if(q.length>400){toast('Keep the question under 400 characters.');return;}
      var serial=++graphQuestionSerial,workspace=state.workspace,token=workspace&&workspace.questionToken();
      state.graphFocusChosen=true;
      state.graphAsk={q:q,busy:true,answer:null,error:null,cards:[],cardsBusy:false,startedAt:Date.now()};paintAsk();startAskTick();
      call('graph.ask',{q:q}).then(function(d){
        if(serial!==graphQuestionSerial)return;
        var message=d.investigation&&d.investigation.message;
        if(d.investigation&&d.investigation.status==='ready'&&workspace){
          message=workspace.applyQuestion(d.investigation,token)?'The graph now shows the points and connections chosen for your question.':'Your graph edits were kept. Ask again when you are ready to update the view.';
        }else if(!message)message='This answer has no verified graph plan. Use Advanced investigation to choose points.';
        state.graphAsk={q:q,busy:false,answer:d,error:null,cards:[],cardsBusy:false,graphMessage:message};stopAskTick();paintAsk();loadAskCards(d.answer||'',q,serial);
      },function(e){if(serial!==graphQuestionSerial)return;state.graphAsk={q:q,busy:false,answer:null,error:e.message,cards:[],cardsBusy:false};stopAskTick();paintAsk();});
    },
    focusEntity: function (id) { state.graphFocus = id; state.graphFocusChosen = true; state.graphQuery = ''; render(); },
    keepApart: function () {
      var m=state.merge;if(!m || m.phase!=='preview' || !m.identity || !m.identity.writable)return;
      if(!m.constraintIntent)m.constraintIntent={action:'identity_keep_apart',source:m.source,target:m.target,
        expected_revision:m.identity.revision,idempotency_key:'keep-apart:'+crypto.randomUUID()};
      m.phase='starting';renderMerge();
      call('workspace.request',m.constraintIntent).then(function(){
        if(state.merge!==m)return;finishMerge(false,'Saved. These identities will be kept separate.');loadGraphStatus();
      },function(e){if(state.merge!==m)return;m.phase='preview';renderMerge();toast(e.message);
        if(/revision_conflict|identity_split_required|idempotency_conflict/.test(e.message)){m.constraintIntent=null;call('workspace.request',{action:'identity_status',source:m.source,target:m.target}).then(function(d){if(state.merge===m){m.identity=d;renderMerge();}},function(){});}
      });
    },
    mergeGo: function () {
      var m = state.merge; if (!m || m.phase !== 'preview') return;
      var unavailable = ((m.preview || {}).warnings || []).find(function (w) { return w.code === 'physical_merge_unavailable'; });
      if (unavailable) { toast(unavailable.text); return; }
      var big = ((m.preview || {}).warnings || []).some(function (w) { return w.code === 'large_merge'; });
      if (big && !m.armed) { m.armed = true; renderMerge(); return; }
      m.phase = 'starting'; renderMerge();
      call('graph.merge', { source: m.source, target: m.target, confirm: true, rule: m.rule || undefined }).then(function (d) {
        if (state.merge !== m) return;
        m.phase = 'running'; m.receipt = d.receipt || null; m.ticket = d.ticket || null; m.startedAt = Date.now(); renderMerge(); pollMerge();
      }, function (e) { if (state.merge !== m) return; m.phase = 'preview'; m.armed = false; renderMerge(); toast(e.message); });
    },
    mergeCancel: function () { finishMerge(false, 'Nothing was changed.'); },
    mergeHide: function () { closeModal(); },
    mergeFrom: function (source, target) { mergeFlow(source, target, null); },
    duplicatesScan: function () {
      if (state.dups.busy) return;
      state.dups = { busy: true, data: null, error: null }; paintDups();
      call('graph.duplicates', { limit: 25 }).then(function (d) { state.dups = { busy: false, data: d, error: null }; paintDups(); }, function (e) { state.dups = { busy: false, data: null, error: e.message }; paintDups(); });
    },
    copyAsk: function (withContext) {
      var a = state.graphAsk; if (!a.answer) return;
      var text = 'Question: ' + a.q + '\n\nAnswer (synthesized from the COS knowledge graph, ' + (a.answer.mode || 'hybrid') + ' mode):\n' + a.answer.answer;
      if (withContext && a.cards && a.cards.length) text += '\n\nEntities in the graph:\n\n' + a.cards.map(entityCardText).join('\n\n');
      call('copy', { text: text }).then(function () { toast(withContext ? 'Copied the answer with its entity context.' : 'Copied the answer.'); }, function (e) { toast(e.message); });
    },
    copyAskEntity: function (id) { var en = (state.graphAsk.cards || []).find(function (c) { return c.id === id; }); if (!en) return; call('copy', { text: entityCardText(en) }).then(function () { toast('Copied ' + id + ' as context.'); }, function (e) { toast(e.message); }); },
    askEntityPassages: function (id) { call('graph.passages', { entity: id, limit: 5 }).then(function (d) { openPassages(id, d); }, function (e) { toast(e.message); }); },
    reviewMemory: function (id, decision) {
      if (decision === 'prune' && state.armed !== 'prune:' + id) { state.armed = 'prune:' + id; render(); setTimeout(function () { if (state.armed === 'prune:' + id) { state.armed = null; render(); } }, 6000); return; }
      state.armed = null; state.memoryReviewBusy = id; render();
      // Restore is Accept on the wire: the bridge returns a quarantined memory to recall before marking it accepted.
      call('memory.review', { id: id, decision: decision === 'restore' ? 'accept' : decision }).then(function (d) {
        state.memoryReviewBusy = null;
        var row = d.decision || {};
        state.decisions = state.decisions || {}; state.decisions[id] = row.decision || (decision === 'prune' ? 'pruned' : 'accepted');
        state.decisionTs = state.decisionTs || {}; state.decisionTs[id] = new Date().toISOString();
        if (decision === 'prune') { state.memories = (state.memories || []).filter(function (m) { return m.id !== id; }); if (state.selectedMemory === id) state.selectedMemory = null; }
        toast(decision === 'prune' ? 'Memory quarantined.' : decision === 'restore' ? 'Memory restored to recall.' : 'Memory accepted.'); render();
      }, function (e) { state.memoryReviewBusy = null; toast(e.message); render(); });
    },
    pruneAllReady: function () {
      if (state.bulkPrune) return;
      var ids = (state.review || []).filter(function (e) { return isPruneReady(e) && !latestDecisionFor(e); }).map(function (e) { return e.lesson_id; });
      if (!ids.length) return;
      if (state.armed !== 'prune-ready') { state.armed = 'prune-ready'; render(); setTimeout(function () { if (state.armed === 'prune-ready') { state.armed = null; render(); } }, 6000); return; }
      state.armed = null; state.bulkPrune = { done: 0, total: ids.length }; render();
      // One memory at a time through the same review call as the card's Prune; the first failure stops the run.
      ids.reduce(function (chain, id) {
        return chain.then(function () {
          return call('memory.review', { id: id, decision: 'prune', note: 'prune ready' }).then(function (d) {
            var row = d.decision || {};
            state.decisions = state.decisions || {}; state.decisions[id] = row.decision || 'pruned';
            state.decisionTs = state.decisionTs || {}; state.decisionTs[id] = new Date().toISOString();
            state.bulkPrune.done += 1; render();
          });
        });
      }, Promise.resolve()).then(function () {
        var n = state.bulkPrune.done; state.bulkPrune = null;
        toast('Quarantined ' + fmt(n) + '. Restore any of them from its card.'); render();
      }, function (e) {
        var b = state.bulkPrune; state.bulkPrune = null;
        toast('Stopped after ' + fmt(b.done) + ' of ' + fmt(b.total) + ': ' + e.message); render();
      });
    },
    guardrailsLoad: function () { loadGuardrails(); },
    guardrailsSave: function () {
      var f = function (id) { var el = document.querySelector('#' + id); return el ? el.value : null; };
      var patch = { min_words: Number(f('grMinWords')), min_distinct_chars: Number(f('grDistinct')), max_repeat_ratio: Number(f('grRepeat')),
        banned_patterns: String(f('grBanned') || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
        llm_review: { enabled: !!(document.querySelector('#grLlm') || {}).checked, model: f('grModel') || 'haiku', max_per_run: Number(f('grMax')) || 20 } };
      if(state.guardrails && state.guardrails.llm_review && state.guardrails.llm_review.supported===false)delete patch.llm_review;
      state.guardrailsBusy = 'save'; renderModalIfOpen();
      call('memory.guardrails.set', { patch: JSON.stringify(patch) }).then(function (d) { state.guardrails = d.guardrails; state.guardrailsBusy = null; toast('Guardrails saved.'); renderModalIfOpen(); }, function (e) { state.guardrailsBusy = null; toast(e.message); renderModalIfOpen(); });
    },
    guardrailsRun: function (apply) {
      state.guardrailsBusy = apply ? 'apply' : 'run'; renderModalIfOpen();
      call('memory.guardrails.run', { days: 30, apply: apply === true }).then(function (d) {
        state.guardrailsRun = d; state.guardrailsBusy = null;
        if (apply) { var ids = (d.verdicts || []).filter(function (v) { return v.applied; }).map(function (v) { return v.id; }); state.memories = (state.memories || []).filter(function (m) { return ids.indexOf(m.id) === -1; }); state.decisions = state.decisions || {}; ids.forEach(function (id) { state.decisions[id] = 'pruned'; }); toast('Quarantined ' + fmt(d.run.pruned) + '.'); }
        else toast(fmt(d.run.flagged) + ' flagged, ' + fmt(d.run.kept) + ' kept' + (d.run.review ? ', ' + fmt(d.run.review) + ' for you' : '') + '.');
        renderModalIfOpen(); render();
      }, function (e) { state.guardrailsBusy = null; toast(e.message); renderModalIfOpen(); });
    },
    chooseExtraction: function (tier) { setupAction('extraction', 'graph.setup.extraction', { tier: tier }, function (d) { toast('Indexing set to ' + ((d.extraction || {}).label || tier) + '.'); }); },
    chooseEmbedding: function (provider) { setupAction('embedding', 'graph.setup.embedding', { provider: provider }, function (d) { toast('Embeddings set to ' + ((d.embedding || {}).label || provider) + '.'); }); },
    answerLocalOnly: function (localOnly) { setupAction('preference', 'graph.setup.embedding', { local_only: localOnly === true }, function (d) { var rec = (d.embedding || {}).recommended; toast(rec ? 'Recommended: ' + rec.label + '.' : 'Preference saved.'); }); },
    fetchEmbedding: function (provider) { setupAction('fetch', 'graph.setup.embedding', { provider: provider, fetch: true }, function (d) { var f = d.fetch || {}; toast(f.started ? 'Fetching the model in the background.' : f.already_running ? 'A fetch is already running.' : 'Nothing to fetch.'); watchFetch(); }); },
    pickFolder: function () {
      call('pick.folder').then(function (d) {
        if (!d || !d.path) return;
        setupAction('add', 'graph.setup.sources', { action: 'add', path: d.path }, function () { toast('Folder added.'); });
      }, function (e) { if (e.message !== 'No folder chosen.') toast(e.message); });
    },
    sourceToggle: function (path, enabled) { setupAction('toggle', 'graph.setup.sources', { action: enabled ? 'enable' : 'disable', path: path }); },
    sourceRemove: function (path) { setupAction('remove', 'graph.setup.sources', { action: 'remove', path: path }, function () { toast('Folder removed.'); }); },
    claimOwner: function () {
      if (state.armed !== 'owner') { state.armed = 'owner'; render(); setTimeout(function () { if (state.armed === 'owner') { state.armed = null; render(); } }, 6000); return; }
      setupAction('owner', 'graph.setup.owner', {}, function () { toast('This Mac is now the ingestion owner.'); });
    },
    indexSample: function () {
      setupAction('sample', 'graph.sample', { limit: 3 }, function (d) {
        var q = (d.queued || []).length;
        if (d.started) { state.ingesting = { pid: d.pid, note: 'Indexing ' + fmt(q) + ' sample document' + (q === 1 ? '' : 's') + ' (pid ' + esc(d.pid) + ')' }; watchIngest(); }
        else if (d.already_running) { toast((q ? fmt(q) + ' queued. ' : '') + 'Indexing is already running; this page refreshes as it runs.'); watchIngest(); }
        else if (d.nothing_pending) toast('Nothing new to index in the folders that are on.');
        else if (d.budget_exhausted) toast('Today\'s LightRAG budget is used up. It resets tomorrow.');
        if ((d.skipped || []).length) toast(fmt(d.skipped.length) + ' skipped: ' + d.skipped.map(function (x) { return x.reason; }).join(', '));
      });
    },
    askGraph: function () {
      if (state.askBusy) return;
      var input = document.querySelector('#askQ'); var q = input ? input.value.trim() : state.askQ;
      if (q.length < 3) { toast('Ask a fuller question.'); return; }
      state.askQ = q; state.askBusy = true; state.askAnswer = null; state.askStartedAt = Date.now(); render(); startAskTick();
      call('graph.ask', { q: q }).then(function (d) { state.askBusy = false; state.askStartedAt = null; stopAskTick(); state.askAnswer = d; render(); }, function (e) { state.askBusy = false; state.askStartedAt = null; stopAskTick(); toast(e.message); render(); });
    },
    scheduleSet: function (enabled) {
      var sel = document.querySelector('#scheduleInterval'); var interval = sel ? Number(sel.value) || 3600 : 3600;
      setupAction('schedule', 'graph.schedule', { enabled: enabled, intervalS: interval }, function (d) { toast(d.installed ? 'Scheduled batches on.' : 'Scheduled batches off.'); });
    },
    startIngest: function () {
      var sel = document.querySelector('#ingestLimit'); var limit = sel ? (Number(sel.value) || 10) : 10; state.ingestLimit = limit;
      state.ingesting = { note: 'Starting…' }; render();
      call('graph.ingest', { limit: limit }).then(function (d) {
        if (d.started) { var batch = Math.min(d.limit || 0, d.pending || 0); state.ingesting = { pid: d.pid, limit: d.limit, startedAt: Date.now(), note: (d.pending <= batch ? 'Indexing all ' + fmt(d.pending) + ' queued' : 'Indexing the next ' + fmt(batch) + ' of ' + fmt(d.pending) + ' queued') + ' (pid ' + esc(d.pid) + ')' }; watchIngest(); }
        else if (d.already_running) { state.ingesting = null; toast('Indexing is already running' + (d.lock && d.lock.owner_pid ? ' (pid ' + d.lock.owner_pid + ')' : '') + '. This card refreshes as it runs.'); watchIngest(); }
        else if (d.nothing_pending) { state.ingesting = null; toast('Nothing is queued.'); }
        else if (d.budget_exhausted) { state.ingesting = null; toast('Today\'s LightRAG budget is used up' + (d.budget ? ' (' + fmt(d.budget.used) + ' of ' + fmt(d.budget.cap) + ' calls)' : '') + '. It resets tomorrow.'); }
        else { state.ingesting = null; toast('Nothing started.'); }
        render();
      }, function (e) { state.ingesting = null; toast(e.message); render(); });
    },
    buildIndex: function () { state.building = 'Starting…'; render(); call('graph.build').then(function (d) { state.building = d.already_running ? 'A build is already running' : 'Building…'; render(); var tries = 0; var poll = setInterval(function () { tries++; loadGraphStatus().then(function () { var b = state.graphStatus && state.graphStatus.build; if (b && (b.state === 'done' || b.state === 'failed')) { state.building = b.state === 'done' ? 'Index rebuilt' : ('Build failed: ' + (b.error || '')); clearInterval(poll); render(); } else if (tries > 150) { state.building = 'Still building after 5 minutes. Refresh later.'; clearInterval(poll); render(); } }); }, 2000); }, function (e) { state.building = null; toast(e.message); render(); }); },
    decide: decide, openMemoryRecord: function (id) { state.view = 'learning'; state.filter = 'memories'; state.selectedMemory = id; state.memoryQuery = ''; state.memoryHits = null; if (!state.memories.some(function (m) { return m.id === id; })) state.memories.unshift({ id: id, summary: 'Memory ' + id }); render(); },
    reveal: function (id) { call('memory.reveal', { id: id }).then(function () {}, function (e) { toast(e.message); }); },
    copyMemory: copyMemory, openCopyContext: openCopyContext, copyOption: copyOption, copyNow: copyNow, selectContextText: selectContextText,
    closeModal: closeModal, openSettings: openSettings, openLog: openLog
  };
  window.openSettings = openSettings;
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && document.querySelector('.modal')) closeModal(); });

  render();
  loadAll();
})();
