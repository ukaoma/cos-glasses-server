/* COS Control Web. One script, no framework, no inline handlers (the page CSP is script-src 'self').
   Auth is the HttpOnly cos_web_session cookie only: this page never holds the pairing token.
   Every server string reaches the DOM through esc(). Routes live in location.hash so the
   phone's back gesture and the browser's back button both work. */
(function () {
  'use strict';

  // ── utilities ───────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Agent turns and task text are markdown. Escape first, then style a small subset, so the
  // result can never contain markup the server sent.
  function md(text) {
    return esc(text).split('\n').map(function (line) {
      var l = line
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      if (/^#{1,4}\s+/.test(l)) return '<strong>' + l.replace(/^#{1,4}\s+/, '') + '</strong>';
      if (/^&gt;\s?/.test(l)) return '<span class="quote">' + l.replace(/^&gt;\s?/, '') + '</span>';
      if (/^\s*[-*]\s+/.test(l)) return l.replace(/^(\s*)[-*]\s+/, '$1• ');
      return l;
    }).join('\n');
  }
  function plain(text) { return String(text == null ? '' : text).replace(/\*\*|`/g, '').replace(/^#{1,4}\s+/, ''); }
  var WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
  function countWord(n, lower) { var w = n >= 0 && n <= 10 ? WORDS[n] : String(n); return lower ? w.toLowerCase() : w; }
  function plural(n, one, many) { return n === 1 ? one : many; }
  function toDate(v) {
    if (v == null || v === '') return null;
    var d = typeof v === 'number' || /^\d{10,}$/.test(String(v)) ? new Date(Number(v)) : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function ago(v) {
    var d = toDate(v); if (!d) return '';
    var s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.round(s / 60) + ' min';
    if (s < 86400) return Math.round(s / 3600) + ' h';
    if (s < 172800) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function span(v) {
    var d = toDate(v); if (!d) return '';
    var m = Math.max(1, Math.round((Date.now() - d.getTime()) / 60000));
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    return h < 48 ? h + ' h' : Math.round(h / 24) + ' days';
  }
  function clock(d) { return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function dayWord(d) {
    var today = new Date(); var t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    var diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - t0) / 86400000);
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    return d.toLocaleDateString(undefined, { weekday: 'long' });
  }
  var PROVIDERS = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', glasses: 'Glasses', cos: 'COS' };
  function providerLabel(p) { return PROVIDERS[p] || (p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Session'); }
  function badge(p) { var cls = PROVIDERS[p] ? (p === 'cos' ? 'glasses' : p) : 'work'; return '<span class="badge ' + esc(cls) + '">' + esc(providerLabel(p)) + '</span>'; }
  var DOMAINS = { quilt: 'Quilt', sprocket_rocket: 'Sprocket Rocket', hermit_crabs: 'Hermit Crabs', personal: 'Personal' };
  function domainLabel(d) { return DOMAINS[d] || d || ''; }
  function sessionTitle(s) {
    var t = s.display_label || s.custom_title || s.title || s.first_prompt || '';
    t = plain(t).replace(/\s+/g, ' ').trim();
    return t || 'Untitled session';
  }
  function splitSessionId(provider, id) {
    var raw = String(id || '');
    var m = /^(claude|codex|cursor):(.+)$/.exec(raw);
    return m ? { provider: m[1], id: m[2] } : { provider: provider || 'claude', id: raw };
  }
  function skeletonRows(n) {
    var out = '';
    for (var i = 0; i < n; i++) out += '<div class="skel-row"><div class="skeleton" style="width:' + (62 + (i * 13) % 30) + '%"></div><div class="skeleton" style="width:' + (30 + (i * 7) % 25) + '%"></div></div>';
    return '<div class="list">' + out + '</div>';
  }
  function emptyBox(title, body) { return '<div class="list"><p class="empty"><strong>' + esc(title) + '</strong>' + esc(body || '') + '</p></div>'; }
  var toastTimer = null;
  function toast(text) {
    var el = $('toast'); el.textContent = text; el.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 3200);
  }
  function setStatus(el, text, isError) { if (!el) return; el.textContent = text || ''; el.classList.toggle('error', !!isError); }
  function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; }

  // ── API ─────────────────────────────────────────────────
  function api(path, opts) {
    var o = opts || {};
    var headers = { 'X-COS-Web': '1' };
    var body;
    if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }
    return fetch(path, { method: o.method || 'GET', headers: headers, credentials: 'same-origin', body: body }).then(function (res) {
      if (res.status === 401 && path.indexOf('/api/web-session/') !== 0) { showAuth(); throw new Error('Signed out. Connect this browser again.'); }
      return res.text().then(function (text) {
        var data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (_e) { data = {}; }
        if (!res.ok) {
          var msg = (data && (data.message || (data.error && data.error.message) || data.error)) || ('The server answered ' + res.status + '.');
          var err = new Error(typeof msg === 'string' ? msg : 'The server answered ' + res.status + '.');
          err.status = res.status; throw err;
        }
        return data;
      });
    });
  }

  // ── state ───────────────────────────────────────────────
  var state = {
    pane: 'today', serverName: '', tailnetUrl: '',
    sessions: [], sessionsMode: 'words', workTasks: [], workOpenStages: { complete: false },
    stream: null, memoriesLoaded: false, lastLoad: {}, livePoll: null
  };
  var ROOT_PANES = ['today', 'meetings', 'work', 'sessions', 'messages', 'memories', 'speakers', 'usage', 'settings'];
  var TITLES = { today: 'Today', meetings: 'Meetings', work: 'Work', sessions: 'Sessions', messages: 'Messages', memories: 'Memories', speakers: 'Speakers', usage: 'Usage', settings: 'Settings' };

  // ── routing ─────────────────────────────────────────────
  function parseRoute() {
    var parts = (location.hash || '').replace(/^#\/?/, '').split('/').map(function (p) { try { return decodeURIComponent(p); } catch (_e) { return p; } });
    var pane = ROOT_PANES.indexOf(parts[0]) >= 0 ? parts[0] : 'today';
    return { pane: pane, args: parts.slice(1).filter(function (p) { return p !== ''; }) };
  }
  function go(pane, args) {
    var hash = '#/' + [pane].concat(args || []).map(encodeURIComponent).join('/');
    if (location.hash === hash) route(); else location.hash = hash;
  }
  function isPhone() { return !window.matchMedia('(min-width: 600px)').matches; }
  function route() {
    var r = parseRoute();
    var changedPane = r.pane !== state.pane || !document.querySelector('#pane-' + r.pane + ':not(.hidden)');
    state.pane = r.pane;
    document.querySelectorAll('.pane').forEach(function (sec) { sec.classList.toggle('hidden', sec.id !== 'pane-' + r.pane); });
    document.querySelectorAll('#section-menu [data-goto]').forEach(function (b) { if (b.getAttribute('data-goto') === r.pane) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    document.querySelectorAll('.rail-btn').forEach(function (b) { if (b.getAttribute('data-pane') === r.pane) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    if (state.stream && !(r.pane === 'sessions' && r.args.length === 2)) { state.stream.close(); state.stream = null; }
    if (!(r.pane === 'sessions' && r.args.length === 2)) { clearInterval(state.turnPoll); if (state.reading) clearInterval(state.reading.heldTimer); state.reading = null; }
    if (r.pane !== 'meetings' && state.livePoll) { clearInterval(state.livePoll); state.livePoll = null; }

    var reading = r.args.length > 0;
    var paneEl = $('pane-' + r.pane);
    if (paneEl) paneEl.classList.toggle('reading', reading);
    var split = paneEl && paneEl.querySelector('.split');
    if (split) split.classList.toggle('reading', reading);

    // Top bar (phone): the section switcher at a list, a back button on a reader.
    $('topbar-back').classList.toggle('hidden', !reading);
    $('section-btn').classList.toggle('hidden', reading);
    $('topbar-back-label').textContent = TITLES[r.pane] || 'Back';
    $('section-name').textContent = TITLES[r.pane] || 'Today';
    closeMenu();
    if (changedPane) window.scrollTo(0, 0);
    $('topbar').classList.remove('tucked');
    onScroll();

    if (r.pane === 'today') loadToday();
    else if (r.pane === 'sessions') { if (!reading || !state.sessions.length || changedPane) loadSessions(); if (reading) openSession(r.args[0], r.args[1]); }
    else if (r.pane === 'meetings') { if (changedPane || !reading) loadMeetings(); if (reading) openMeeting(r.args[0], r.args[1], r.args[2]); }
    else if (r.pane === 'work') loadWork();
    else if (r.pane === 'messages') loadMessages();
    else if (r.pane === 'memories') loadMemories();
    else if (r.pane === 'speakers') { if (changedPane || !reading) loadSpeakers(); if (reading) openSpeakers(r.args[0]); }
    else if (r.pane === 'usage') loadUsage(false);
    else if (r.pane === 'settings') loadSettings();
    state.lastLoad[r.pane] = Date.now();
  }
  function goBack() {
    var r = parseRoute();
    if (r.args.length) go(r.pane);
    else go('today');
  }
  // On the closed Duo every vertical pixel counts: the top bar slides away while you scroll
  // down and comes back the moment you scroll up.
  var lastY = 0;
  function onScroll() {
    var y = Math.max(0, window.scrollY || 0);
    var bar = $('topbar');
    bar.classList.toggle('scrolled', y > 8);
    if (y < 60 || y < lastY - 4) bar.classList.remove('tucked');
    else if (y > lastY + 4 && isPhone()) bar.classList.add('tucked');
    lastY = y;
  }
  function openMenu() { $('section-menu').classList.remove('hidden'); var cur = document.querySelector('#section-menu [aria-current="page"]') || document.querySelector('#section-menu [data-goto]'); if (cur) cur.focus(); }
  function closeMenu() { $('section-menu').classList.add('hidden'); }

  // ── auth ────────────────────────────────────────────────
  function showAuth(message) {
    $('app-shell').classList.add('hidden');
    $('auth-gate').classList.remove('hidden');
    setStatus($('auth-error'), message || '', true);
    $('auth-error').classList.toggle('hidden', !message);
  }
  function showShell(info) {
    $('auth-gate').classList.add('hidden');
    $('app-shell').classList.remove('hidden');
    state.serverName = (info && info.serverName) || 'Your Mac';
    $('host-name').textContent = state.serverName.replace(/-/g, ' ');
    loadTailnetUrl();
    route();
  }

  // ── Today ───────────────────────────────────────────────
  function loadToday() {
    var now = new Date();
    $('today-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) + ', ' + clock(now);
    Promise.all([
      api('/api/agent-sessions?limit=40&sort=updated').catch(function () { return null; }),
      api('/api/work-board/your-move').catch(function () { return null; }),
      api('/api/welcome-context').catch(function () { return null; }),
      api('/api/meetings/live-chunks').catch(function () { return null; })
    ]).then(function (res) {
      var sessions = (res[0] && res[0].sessions) || [];
      state.sessions = sessions;
      var needs = (res[1] && res[1].items) || [];
      var welcome = res[2] || {};
      var live = (res[3] && res[3].sessions) || [];
      var working = sessions.filter(function (s) { return s.running_active; });
      var open = sessions.filter(function (s) { return s.running && !s.running_active; });
      var recent = live.filter(function (s) { return Date.now() - (s.mtimeMs || 0) < LIVE_FRESH_MS; });
      var offline = !res[0] && !res[1];

      renderStory(needs.length, working.length, open.length, welcome.nextEvent, false, offline);
      renderRunning(working, open);
      renderNeeds(needs);
      renderNext(welcome);
      setBadge('today', needs.length > 0);
      setBadge('sessions', working.length > 0);
      liveSession(recent).then(function (rec) {
        renderRecording(rec);
        setBadge('meetings', !!rec);
        if (rec) renderStory(needs.length, working.length, open.length, welcome.nextEvent, true, offline);
      });
    });
  }
  // A capture counts as live only while it is still being written: an abandoned
  // active-sessions file must never read as "Recording now".
  var LIVE_FRESH_MS = 5 * 60000;
  var SOURCES = { mac: 'Mac recording', phone: 'iPhone recording', meeting: 'Glasses recording' };
  function liveSession(list) {
    if (!list || !list.length) return Promise.resolve(null);
    var top = list[0];
    return api('/api/meetings/live-chunks?sessionId=' + encodeURIComponent(top.sessionId) + '&since=1000000').then(function (r) {
      var read = r && r.read;
      if (!read || read.ended || Date.now() - Number(read.lastActivityAt || 0) > LIVE_FRESH_MS) return null;
      var prefix = String(top.sessionId).split('_')[0];
      return { sessionId: top.sessionId, source: SOURCES[prefix] || 'Recording', startTime: read.startTime, lines: (read.maxIndex || 0) + 1 };
    }).catch(function () { return null; });
  }
  function renderRecording(rec) {
    var box = $('today-rec');
    if (!rec) { box.innerHTML = ''; return; }
    box.innerHTML = '<button type="button" class="rec-banner" data-goto="meetings"><span class="rec-dot"></span>' +
      '<span class="rec-copy"><strong>Recording now</strong><span>' + esc(rec.source + (rec.startTime ? ', ' + span(rec.startTime) + ' so far' : '')) + '</span></span>' +
      '<span class="btn small">Live view</span></button>';
  }
  function renderStory(needs, working, open, next, recording, offline) {
    var el = $('today-story');
    el.className = 'story';
    if (offline) { el.textContent = 'COS on ' + state.serverName + ' is not answering right now. Today fills in when it does.'; return; }
    var first = needs > 0
      ? countWord(needs) + ' ' + plural(needs, 'handoff is', 'handoffs are') + ' waiting on you'
      : 'Nothing is waiting on you';
    var nextBit = '';
    var nd = next && toDate(next.time);
    if (nd && next.title && (nd.getTime() - Date.now()) < 18 * 3600000 && nd.getTime() > Date.now() - 600000) {
      var dw = dayWord(nd);
      nextBit = ', and ' + next.title + ' is at ' + clock(nd) + (dw === 'today' ? '' : ' ' + dw);
    }
    var second;
    if (working > 0) second = countWord(working) + ' ' + plural(working, 'agent is', 'agents are') + ' working' + (open > 0 ? ', with ' + countWord(open, true) + ' more ' + plural(open, 'session', 'sessions') + ' open' : '');
    else if (open > 0) second = countWord(open) + ' ' + plural(open, 'session is', 'sessions are') + ' open and quiet';
    else second = 'No agents are running';
    if (recording) second += (working > 0 || open > 0 ? ', and ' : '. ') + 'COS is recording a meeting';
    el.textContent = first + nextBit + '. ' + second + '.';
  }
  function runRow(s, activeNow) {
    var key = splitSessionId(s.provider, s.session_id);
    var meta = activeNow
      ? 'Working for ' + span(s.state_since || s.last_activity_at)
      : 'Open, quiet for ' + span(s.last_activity_at || s.state_since);
    if (s.project && s.project !== usualProject()) meta += ', in ' + String(s.project).replace(/^-Users-[^-]+-/, '');
    return '<button type="button" class="run-row" data-session="' + esc(key.provider) + '|' + esc(key.id) + '">' +
      '<span class="run-who">' + badge(key.provider) + (activeNow ? '<span class="pulse" aria-label="working"></span>' : '') + '</span>' +
      '<span class="run-title">' + esc(sessionTitle(s)) + '</span>' +
      '<span class="run-meta">' + esc(meta) + '</span></button>';
  }
  function renderRunning(working, open) {
    $('run-count').textContent = working.length ? String(working.length) : '';
    var list = $('run-list');
    var shown = working.slice(0, 3);
    var html = shown.map(function (s) { return runRow(s, true); }).join('');
    if (!shown.length) {
      html = open.slice(0, 2).map(function (s) { return runRow(s, false); }).join('');
      if (!html) html = '<div class="run-empty">Nothing running. Start a session on your Mac and it shows here.</div>';
    }
    var more = (working.length - shown.length) + (shown.length ? open.length : Math.max(0, open.length - 2));
    if (more > 0) html += '<button type="button" class="run-more" data-goto="sessions">' + countWord(more) + ' more open. All sessions</button>';
    list.innerHTML = html;
  }
  function needWhy(item) {
    var p = item.progress || {};
    if (p.reported === 'needsInput' || item.waitingInApp) return 'Waiting for your reply';
    if (p.reported === 'blocked') return 'Blocked';
    if (item.status === 'delivered') return 'Handed to you';
    return 'Needs a look';
  }
  function renderNeeds(items) {
    $('needs-count').textContent = items.length ? String(items.length) : '';
    var list = $('needs-list');
    if (!items.length) { list.innerHTML = '<p class="card-empty">You are clear. New handoffs from your agents land here.</p>'; return; }
    // One primary action, on the item that has waited longest for a reply; the rest stay quiet.
    list.innerHTML = items.slice(0, 6).map(function (it, i) {
      var key = splitSessionId(it.provider, it.sessionId);
      var title = it.sessionTitle || it.title || 'Handoff';
      var why = needWhy(it) + (it.domain ? ' in ' + domainLabel(it.domain) : '');
      return '<div class="need-row">' +
        '<div class="need-top"><span class="need-title">' + esc(title) + '</span><span class="need-age">' + esc(ago(it.updatedAt || it.createdAt)) + '</span></div>' +
        '<div class="need-foot">' + esc(why) + '</div>' +
        (key.id ? '<div class="need-actions"><button type="button" class="btn small' + (i === 0 ? ' primary' : '') + '" data-session="' + esc(key.provider) + '|' + esc(key.id) + '">Open session</button></div>' : '') +
      '</div>';
    }).join('');
  }
  function renderNext(w) {
    var card = $('next-card');
    var n = w && w.nextEvent; var d = n && toDate(n.time);
    if (!d || !n.title) { card.classList.add('hidden'); return; }
    var weather = w.weather && w.weather.temp ? w.weather.temp + ' and ' + String(w.weather.desc || '').toLowerCase() + (w.weather.location ? ' in ' + w.weather.location.split(',')[0] : '') : '';
    var dw = dayWord(d);
    $('next-body').innerHTML = '<span class="when">' + esc(clock(d)) + '</span><span><span class="what">' + esc(n.title) + '</span>' +
      '<span class="sub" style="display:block">' + esc((dw.charAt(0).toUpperCase() + dw.slice(1)) + (weather ? '. Now ' + weather : '')) + '</span></span>';
    card.classList.remove('hidden');
  }
  function setBadge(name, on) { document.querySelectorAll('[data-badge="' + name + '"]').forEach(function (b) { b.classList.toggle('hidden', !on); }); }

  // ── Sessions ────────────────────────────────────────────
  function loadSessions() {
    var list = $('sessions-list');
    if (!state.sessions.length) list.innerHTML = skeletonRows(6);
    return api('/api/agent-sessions?limit=60&sort=updated').then(function (d) {
      state.sessions = (d && d.sessions) || [];
      if (!$('sessions-q').value.trim()) renderSessionGroups(state.sessions);
    }).catch(function (err) { list.innerHTML = emptyBox('Sessions did not load', err.message); });
  }
  // The project most sessions share says nothing; name it only when a session differs.
  function usualProject() {
    var counts = {}, best = '', n = 0;
    state.sessions.forEach(function (s) { if (!s.project) return; counts[s.project] = (counts[s.project] || 0) + 1; if (counts[s.project] > n) { n = counts[s.project]; best = s.project; } });
    return best;
  }
  function sessionRow(s, sub) {
    var key = splitSessionId(s.provider, s.session_id || s.id);
    var r = parseRoute();
    var selected = r.pane === 'sessions' && r.args[0] === key.provider && r.args[1] === key.id;
    var project = s.project && s.project !== usualProject() ? String(s.project).replace(/^-Users-[^-]+-/, '') : '';
    return '<button type="button" class="row" data-session="' + esc(key.provider) + '|' + esc(key.id) + '"' + (selected ? ' aria-selected="true"' : '') + '>' +
      '<span class="row-title">' + esc(sessionTitle(s)) + '</span>' +
      '<span class="row-side">' + esc(ago(s.last_activity_at || s.modified || s.created)) + '</span>' +
      '<span class="row-sub">' + badge(key.provider) + '<span class="clip">' + esc(sub || project) + '</span></span></button>';
  }
  function renderSessionGroups(rows) {
    var working = rows.filter(function (s) { return s.running_active; });
    var open = rows.filter(function (s) { return s.running && !s.running_active; });
    var recent = rows.filter(function (s) { return !s.running; });
    var html = '';
    function group(title, items, subFn) {
      if (!items.length) return;
      html += '<h2 class="group-title"><span>' + esc(title) + '</span><span>' + items.length + '</span></h2><div class="list">' + items.map(function (s) { return sessionRow(s, subFn && subFn(s)); }).join('') + '</div>';
    }
    group('Working now', working, function (s) { return 'Working for ' + span(s.state_since); });
    group('Open', open);
    group('Recent', recent);
    $('sessions-list').innerHTML = html || emptyBox('No sessions this week', 'Claude Code, Codex and Cursor sessions on your Mac show up here.');
  }
  function searchSessions() {
    var q = $('sessions-q').value.trim();
    var list = $('sessions-list');
    if (q.length < 2) { renderSessionGroups(state.sessions); return; }
    list.innerHTML = skeletonRows(4);
    if (state.sessionsMode === 'meaning') {
      findByMeaning(q).then(function (html) { list.innerHTML = html; });
      return;
    }
    api('/api/agent-sessions/search?q=' + encodeURIComponent(q) + '&limit=25').then(function (d) {
      var hits = (d && d.hits) || [];
      list.innerHTML = hits.length
        ? '<h2 class="group-title"><span>Sessions with “' + esc(q) + '”</span><span>' + hits.length + '</span></h2><div class="list">' + hits.map(function (s) { return sessionRow(s, s.snippet); }).join('') + '</div>'
        : emptyBox('No session mentions “' + q + '”', 'Try Meaning to search by what the session was about.');
    }).catch(function (err) { list.innerHTML = emptyBox('Search did not run', err.message); });
  }
  function findByMeaning(q) {
    return api('/api/agent-sessions/find', { method: 'POST', body: { query: q } }).then(function (d) {
      if (d && d.available === false) return emptyBox('Meaning search is off', d.message || 'Turn on a decision provider in Settings.');
      var results = (d && d.results) || [];
      if (!results.length) return emptyBox('Nothing matched that meaning', 'Try different words, or search by Words.');
      return '<h2 class="group-title"><span>About “' + esc(q) + '”</span><span>' + results.length + '</span></h2><div class="list">' + results.map(function (r) {
        var s = r.session || r;
        if (!s.provider && r.provider) s.provider = r.provider;
        if (!s.session_id) s.session_id = r.sessionId || r.id;
        return sessionRow(s, r.reason || s.project);
      }).join('') + '</div>';
    }).catch(function (err) { return emptyBox('Meaning search did not run', err.message); });
  }
  // ── Sessions: read, send, queue, fork, stop (the glasses' Continue, from a browser) ──
  // The server owns every safety rule (agent-session-bindings.ts): COS writes into a desktop
  // thread only through a binding, attaches only when no live process owns the thread, and
  // re-checks before delivery. This page follows the same order the glasses do:
  //   attach (or reuse this tab's binding) -> send the turn under ONE key per draft ->
  //   if the session is busy, park it in the session's queue -> watch the live stream.
  // A refusal is an answer with the server's own words, never an error to retry blindly. The
  // draft key is reused on a resend, so a retry after a lost answer can never post twice.
  var WEB_SESSION_KEY = 'cos_web_sid';
  function cosSessionId() {
    try {
      var v = localStorage.getItem(WEB_SESSION_KEY);
      if (v && /^web-[a-z0-9]{8,24}$/.test(v)) return v;
      v = 'web-' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
      localStorage.setItem(WEB_SESSION_KEY, v);
      return v;
    } catch (_e) { return 'web-' + Date.now().toString(36); }
  }
  function newTurnKey() { return 'ct' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10).padEnd(8, '0'); }
  function targetKey(provider, id) { return provider.length + ':' + provider + ':' + id.length + ':' + id; }
  var BINDING_REUSE_MS = 25 * 60000; // the server keeps a binding 30 min
  var PARKABLE_REFUSALS = /^(native_thread_working|native_target_busy|target_busy)$/;
  // A binding is kept per browser, across reloads: the server allows one live binding per
  // thread, so a reload that forgot it would read its own binding as "target busy".
  var BINDINGS_KEY = 'cos_web_bindings';
  function readBindings() {
    try { var all = JSON.parse(localStorage.getItem(BINDINGS_KEY) || '{}'); return all && typeof all === 'object' ? all : {}; } catch (_e) { return {}; }
  }
  function bindingFor(provider, id) {
    var b = readBindings()[provider + '|' + id];
    return b && typeof b.bindingId === 'string' && typeof b.epoch === 'number' && Date.now() - b.at < BINDING_REUSE_MS ? b : null;
  }
  function rememberBinding(provider, id, b) {
    var all = readBindings(), now = Date.now();
    Object.keys(all).forEach(function (k) { if (!all[k] || now - all[k].at >= BINDING_REUSE_MS) delete all[k]; });
    if (b) all[provider + '|' + id] = b; else delete all[provider + '|' + id];
    try { localStorage.setItem(BINDINGS_KEY, JSON.stringify(all)); } catch (_e) {}
  }
  function sessionPath(provider, id, tail) { return '/api/agent-sessions/' + encodeURIComponent(provider) + '/' + encodeURIComponent(id) + (tail || ''); }

  // Like api(), but a 4xx refusal comes back as { status, body } instead of throwing, because
  // these routes answer "busy", "changed" or "not now" with a body the person should read.
  function apiAnswer(path, opts) {
    var o = opts || {};
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl && o.timeoutMs ? setTimeout(function () { ctrl.abort(); }, o.timeoutMs) : null;
    var headers = { 'X-COS-Web': '1' };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(path, { method: o.method || 'GET', headers: headers, credentials: 'same-origin', body: o.body !== undefined ? JSON.stringify(o.body) : undefined, signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        if (res.status === 401) { showAuth(); throw new Error('Signed out. Connect this browser again.'); }
        return res.text().then(function (t) { var b = {}; try { b = t ? JSON.parse(t) : {}; } catch (_e) { b = {}; } return { status: res.status, body: b || {} }; });
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  // Per-browser memory for one session: messages held until a reply ends, and the queue keys
  // this browser parked (so Remove is offered only on its own rows). Both survive a reload.
  var HELD_KEY = 'cos_web_held', PARKED_KEY = 'cos_web_parked';
  function readStore(key) { try { var v = JSON.parse(localStorage.getItem(key) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_e) { return {}; } }
  function writeStore(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_e) {} }
  function saveHeld(r) {
    var all = readStore(HELD_KEY), k = r.provider + '|' + r.id;
    var keep = r.held.filter(function (h) { return !h.cancelled; }).map(function (h) { return { text: h.text, key: h.key, since: h.since }; });
    if (keep.length) all[k] = keep; else delete all[k];
    writeStore(HELD_KEY, all);
  }
  function rememberParked(r, key) {
    var all = readStore(PARKED_KEY), k = r.provider + '|' + r.id;
    all[k] = (all[k] || []).concat(key).slice(-50);
    writeStore(PARKED_KEY, all);
  }
  function parkedByMe(r, key) { return (readStore(PARKED_KEY)[r.provider + '|' + r.id] || []).indexOf(key) >= 0; }

  function openSession(provider, id) {
    var reader = $('session-reader');
    if (!provider || !id) return;
    if (state.stream) { state.stream.close(); state.stream = null; }
    clearInterval(state.turnPoll);
    if (state.reading) clearInterval(state.reading.heldTimer);
    var held = (readStore(HELD_KEY)[provider + '|' + id] || []).filter(function (h) { return h && typeof h.text === 'string' && typeof h.key === 'string'; });
    state.reading = { provider: provider, id: id, draft: null, live: null, held: held, flushing: null };
    document.querySelectorAll('#sessions-list .row').forEach(function (r) { r.setAttribute('aria-selected', String(r.getAttribute('data-session') === provider + '|' + id)); });
    reader.innerHTML = '<div class="reader-head"><div class="skeleton" style="height:28px;width:70%;margin:10px 0"></div></div>' + skeletonRows(3);
    api(sessionPath(provider, id, '?turns=30')).then(function (d) {
      var turns = Array.isArray(d && d.recent_turns) ? d.recent_turns : ((d && d.recent_turns && d.recent_turns.turns) || (d && d.turns) || []);
      reader.innerHTML =
        '<div class="reader-head"><h2>' + esc(sessionTitle(d)) + '</h2>' +
        '<div class="row-sub">' + badge(provider) + '<span id="session-state">' + esc(d.running_active ? 'Working now' : d.running ? 'Open' : 'Not running') + '</span>' +
        (d.project ? '<span class="clip">' + esc(String(d.project).replace(/^-Users-[^-]+-/, '')) + '</span>' : '') + '</div></div>' +
        '<div class="turns" id="session-turns">' + renderTurns(turns, d) + '</div>' +
        '<div class="live-box hidden" id="session-live" aria-live="polite"></div>' +
        '<div id="session-queue"></div>' +
        '<form class="composer" id="session-form" data-provider="' + esc(provider) + '" data-id="' + esc(id) + '">' +
          '<textarea id="session-input" rows="1" placeholder="Send this session a message" enterkeyhint="send" aria-label="Message for this session"></textarea>' +
          '<div class="composer-actions"><button type="button" class="btn small" data-action="fork-session" title="Copy this session and send the message to the copy">Fork</button>' +
          '<button type="submit" class="btn primary small" aria-label="Send"><svg class="icon" style="width:18px;height:18px"><use href="#i-send"/></svg></button></div>' +
        '</form><div class="status-line" id="session-status"></div>';
      setLive({ working: !!d.running_active });
      renderHeld(state.reading);
      loadQueue(provider, id);
      if (state.reading.held.length) {
        sessionStatus('Waiting for the current reply. ' + (state.reading.held.length > 1 ? state.reading.held.length + ' messages send' : 'Yours sends') + ' as soon as it finishes. ', null, '<button type="button" class="link-btn" data-action="drop-after">Don\u2019t send</button>');
        startHeldTimer(state.reading);
      }
      if (turns.length) requestAnimationFrame(function () { window.scrollTo(0, document.documentElement.scrollHeight); });
      watchSession(provider, id);
    }).catch(function (err) { reader.innerHTML = emptyBox('This session did not open', err.message); });
  }

  // The live stream: one JSON object per data line, `kind` = status | tool | prose | heartbeat.
  function watchSession(provider, id) {
    if (typeof EventSource !== 'function') return;
    var es;
    try { es = new EventSource(sessionPath(provider, id, '/stream?seed=turn')); } catch (_e) { return; }
    state.stream = es;
    var wasWorking = false;
    es.onmessage = function (ev) {
      var e; try { e = JSON.parse(ev.data); } catch (_e) { return; }
      var r = state.reading;
      if (!r || r.id !== id) return;
      if (e.kind === 'status') {
        var working = e.state === 'working' || e.agent_state === 'running';
        // The stream's status trails a Stop by a few seconds; do not let that echo reopen it.
        if (working && r.stoppedAt && Date.now() - r.stoppedAt < 8000) working = false;
        var waiting = e.state === 'waiting' || e.state === 'needs_input' || e.agent_state === 'waiting';
        var el = $('session-state');
        if (el) el.textContent = working ? 'Working now' : waiting ? 'Waiting for you' : 'Open';
        setLive({ working: working });
        if (wasWorking && !working) { refreshTurns(provider, id); replyEnded(r); }
        wasWorking = working;
      } else if (e.kind === 'tool') {
        setLive({ step: [e.verb, e.target].filter(Boolean).join(' ') });
      } else if (e.kind === 'prose' && e.text) {
        setLive({ prose: String(e.text) });
      }
    };
  }
  function setLive(patch) {
    var r = state.reading; if (!r) return;
    r.live = Object.assign(r.live || {}, patch);
    var box = $('session-live'); if (!box) return;
    var live = r.live;
    if (!live.working) { box.classList.add('hidden'); box.innerHTML = ''; live.step = null; live.prose = null; return; }
    box.classList.remove('hidden');
    box.innerHTML = '<div class="live-head"><span class="pulse" aria-hidden="true"></span><strong>Working</strong>' +
      (live.step ? '<span class="live-step">' + esc(live.step) + '</span>' : '') +
      '<button type="button" class="link-btn" data-action="stop-session">Stop</button></div>' +
      (live.prose ? '<div class="live-prose">' + md(live.prose.slice(-1200)) + '</div>' : '');
  }
  function refreshTurns(provider, id) {
    api(sessionPath(provider, id, '?turns=30')).then(function (d) {
      var r = state.reading;
      if (!r || r.id !== id) return;
      var turns = Array.isArray(d && d.recent_turns) ? d.recent_turns : [];
      var box = $('session-turns'); if (box) box.innerHTML = renderTurns(turns, d);
      renderHeld(r);
      loadQueue(provider, id);
    }).catch(function () {});
  }
  function loadQueue(provider, id) {
    apiAnswer(sessionPath(provider, id, '/queued-turns')).then(function (q) {
      var r = state.reading;
      var box = $('session-queue'); if (!box || !r || r.id !== id) return;
      var rows = (q.status === 200 && q.body && q.body.turns) || [];
      var waiting = rows.filter(function (t) { return t.status === 'waiting' || t.status === 'queued' || t.status === 'pending'; });
      if (!waiting.length) { box.innerHTML = ''; return; }
      box.innerHTML = '<h3 class="group-title" style="margin-top:14px"><span>Waiting to send</span><span>' + waiting.length + '</span></h3><div class="list">' +
        waiting.map(function (t) {
          var mine = t.owner !== 'codex' && parkedByMe(r, t.clientTurnId);
          return '<div class="row"><span class="row-title">' + esc(t.preview || t.prompt || 'Message') + '</span><span class="row-side">' + esc(t.position != null && t.position >= 0 ? (t.position === 0 ? 'Next' : '#' + (t.position + 1)) : '') + '</span>' +
            (mine ? '<span class="row-actions"><button type="button" class="link-btn" data-action="unqueue" data-turn-key="' + esc(t.clientTurnId) + '">Remove</button></span>' : '') + '</div>';
        }).join('') + '</div>';
    }).catch(function () {});
  }

  function sessionStatus(text, kind, actionHtml) {
    var el = $('session-status'); if (!el) return;
    el.className = 'status-line' + (kind === 'error' ? ' error' : '');
    el.innerHTML = esc(text || '') + (actionHtml || '');
  }
  function draftFor(text) {
    var r = state.reading;
    if (!r.draft || r.draft.text !== text) r.draft = { text: text, key: newTurnKey() };
    return r.draft;
  }
  // The box is cleared only of the very words that were sent; anything typed since stays.
  function clearBoxOf(text) {
    var input = $('session-input');
    if (input && input.value.trim() === String(text).trim()) { input.value = ''; autoGrow(input); }
    if (state.reading && state.reading.draft && state.reading.draft.text === text) state.reading.draft = null;
  }
  // Words go back in the box only if the box is empty; otherwise the status line keeps them.
  function returnToBox(text, why) {
    var input = $('session-input');
    if (input && !input.value.trim()) { input.value = text; autoGrow(input); sessionStatus(why + ' Your message is back in the box.', 'error'); }
    else sessionStatus(why + ' Not sent: “' + String(text).slice(0, 80) + (text.length > 80 ? '…' : '') + '”', 'error');
  }
  // Your words show in the conversation the moment the Mac accepts them; the next refresh of
  // the transcript replaces the bubble with the real turn.
  function showPendingTurn(text, note, heldKey) {
    var box = $('session-turns'); if (!box) return;
    var ph = box.querySelector('.reader-placeholder'); if (ph) ph.remove();
    var el = document.createElement('div');
    el.className = 'turn user pending';
    if (heldKey) el.setAttribute('data-held-key', heldKey);
    el.innerHTML = '<span class="who">You, ' + esc(note) + '</span>' + md(text);
    box.appendChild(el);
    requestAnimationFrame(function () { window.scrollTo(0, document.documentElement.scrollHeight); });
  }
  function heldBubble(key) { return document.querySelector('#session-turns .turn.pending[data-held-key="' + key.replace(/[^A-Za-z0-9_-]/g, '') + '"]'); }
  function renderHeld(r) {
    r.held.forEach(function (h) { if (!h.cancelled && !heldBubble(h.key)) showPendingTurn(h.text, 'sends after this reply', h.key); });
  }

  function sendSessionTurn(fork, opts) {
    var r = state.reading; var form = $('session-form');
    if (!r || !form) return;
    var input = $('session-input'), text = input.value.trim();
    if (!text) { sessionStatus(fork ? 'Write what the copy should do first.' : 'Write a message first.', 'error'); return; }
    var btns = form.querySelectorAll('button'); btns.forEach(function (b) { b.disabled = true; });
    var done = function () { btns.forEach(function (b) { b.disabled = false; }); };
    (fork ? forkSession(r, text) : continueSession(r, text, opts || {})).then(done, function (err) {
      done();
      sessionStatus(err && err.name === 'AbortError'
        ? (fork ? 'No answer from your Mac yet. The copy may still be made; tapping Fork again is safe, it will not make a second one.' : 'No answer from your Mac yet. It may still land. Sending again is safe; it will not post twice.')
        : (err && err.message) || 'Could not reach your Mac.', 'error');
    });
  }

  // One attempt to deliver `text`. `opts.held` is a message waiting for a reply to end: its
  // attempts never touch the box or the status line unless they settle it.
  // Resolves to 'sent' | 'parked' | 'held' | 'refused' | 'changed'.
  function continueSession(r, text, opts) {
    var provider = r.provider, id = r.id;
    var draft = opts.held ? { text: opts.held.text, key: opts.held.key } : draftFor(text);
    if (!opts.held) sessionStatus('Sending');
    var bound = bindingFor(provider, id);
    var attach = bound ? Promise.resolve({ ok: true, binding: bound }) : apiAnswer(sessionPath(provider, id, '/attach'), { method: 'POST', body: { cosSessionId: cosSessionId() }, timeoutMs: 20000 }).then(function (a) {
      // 201 Created on success; any 2xx that says attached counts.
      if (a.status >= 200 && a.status < 300 && a.body.attached === true && a.body.bindingId && typeof a.body.epoch === 'number') {
        var b = { bindingId: a.body.bindingId, epoch: a.body.epoch, at: Date.now() };
        rememberBinding(provider, id, b);
        return { ok: true, binding: b };
      }
      return { ok: false, refusal: a.body };
    });
    return attach.then(function (at) {
      // Busy right now (the Mac is writing to it, or another binding holds it): park the
      // message in the session's own queue; the server delivers it when the session is free.
      // Any other refusal is permanent for this thread, and a parked message would never go.
      if (!at.ok) {
        var why = (at.refusal && at.refusal.reason) || '';
        if (PARKABLE_REFUSALS.test(why)) return parkTurn(r, draft, at.refusal, opts);
        var copy = ((at.refusal && at.refusal.reasonCopy) || 'COS cannot write to this session right now.') + ' Fork sends your message to a copy instead.';
        if (opts.held) settleHeld(r, opts.held, 'refused', copy); else sessionStatus(copy, 'error');
        return 'refused';
      }
      return apiAnswer('/api/agent-sessions/bindings/' + encodeURIComponent(at.binding.bindingId) + '/turns', {
        method: 'POST', timeoutMs: 25000,
        body: Object.assign({ prompt: draft.text, epoch: at.binding.epoch, targetKey: targetKey(provider, id), clientTurnId: draft.key }, opts.acknowledgedRevision ? { acknowledgedRevision: opts.acknowledgedRevision } : {}),
      }).then(function (t) {
        var b = t.body || {};
        if (t.status >= 200 && t.status < 300 && (b.outcome === 'queued' || b.outcome === 'completed')) {
          if (opts.held) settleHeld(r, opts.held, 'sent');
          else { showPendingTurn(draft.text, b.replayed ? 'already sent' : 'sent'); clearBoxOf(draft.text); }
          sessionStatus(b.replayed ? 'Already sent. Watching for the reply.' : 'Sent. Watching for the reply.');
          watchTurn(at.binding.bindingId, draft.key, provider, id);
          return 'sent';
        }
        var reason = b.reason || '';
        if (reason === 'native_thread_working') return parkTurn(r, draft, b, opts);
        // COS's own reply is still running on this thread. The server's queue counts that
        // thread as free (the running child is COS's), so it cannot park this; the page holds
        // it under the same key and sends it the moment the reply ends.
        if (reason === 'native_turn_in_progress') { if (!opts.held) holdUntilReplyEnds(r, draft); return 'held'; }
        if (reason === 'native_thread_changed' && b.revision) {
          if (opts.held) settleHeld(r, opts.held, 'refused', 'This session changed on your Mac while your message waited.');
          else {
            r.sendAnyway = b.revision;
            sessionStatus('This session changed on your Mac since you opened it. ', null, '<button type="button" class="link-btn" data-action="send-anyway">Send anyway</button>');
          }
          return 'changed';
        }
        if (/^(stale_epoch|binding_expired|binding_not_active|binding_unusable|unknown_binding)$/.test(reason) && !opts.reattached) {
          rememberBinding(provider, id, null);
          return continueSession(r, text, Object.assign({}, opts, { reattached: true }));
        }
        var refusedCopy = b.reasonCopy || 'The session did not take that message.';
        if (opts.held) settleHeld(r, opts.held, 'refused', refusedCopy);
        else sessionStatus(refusedCopy + ' It is still in the box.', 'error');
        return 'refused';
      });
    });
  }

  var HELD_MAX_MS = 5 * 60000, HELD_RETRY_MS = 8000;
  function holdUntilReplyEnds(r, draft) {
    if (!r.held.some(function (h) { return h.key === draft.key; })) {
      r.held.push({ text: draft.text, key: draft.key, since: Date.now() });
      showPendingTurn(draft.text, 'sends after this reply', draft.key);
      saveHeld(r);
    }
    clearBoxOf(draft.text);
    sessionStatus('COS is still answering. ' + (r.held.length > 1 ? r.held.length + ' messages send' : 'Yours sends') + ' as soon as it finishes. ', null, '<button type="button" class="link-btn" data-action="drop-after">Don’t send</button>');
    startHeldTimer(r);
  }
  function startHeldTimer(r) {
    clearInterval(r.heldTimer);
    r.heldTimer = setInterval(function () { flushHeld(r); }, HELD_RETRY_MS);
  }
  function replyEnded(r) { if (r && r.held && r.held.length) setTimeout(function () { flushHeld(r); }, 800); }
  // Tries the oldest held message once. A "still answering" answer changes nothing on screen.
  function flushHeld(r) {
    if (state.reading !== r) { clearInterval(r.heldTimer); return; }
    var next = r.held.filter(function (h) { return !h.cancelled; })[0];
    if (!next) { clearInterval(r.heldTimer); return; }
    if (r.flushing) return;
    if (Date.now() - next.since > HELD_MAX_MS) { settleHeld(r, next, 'timeout', 'The session stayed busy for five minutes.'); return; }
    r.flushing = next;
    continueSession(r, next.text, { held: next }).then(function () {}, function () { /* no answer: keep it, retry */ })
      .finally(function () { r.flushing = null; if (next.cancelled && r.held.indexOf(next) >= 0) settleHeld(r, next, 'cancelled'); });
  }
  // Ends one held message: sent, refused, timed out or cancelled.
  function settleHeld(r, h, how, copy) {
    r.held = r.held.filter(function (x) { return x !== h; });
    saveHeld(r);
    var bubble = heldBubble(h.key);
    if (how === 'sent') {
      if (bubble) { bubble.removeAttribute('data-held-key'); bubble.querySelector('.who').textContent = 'You, sent'; }
      if (h.cancelled) sessionStatus('Too late to stop it: that message had already gone.');
    } else if (how === 'parked') {
      if (bubble) { bubble.removeAttribute('data-held-key'); bubble.querySelector('.who').textContent = 'You, waiting in line'; }
    } else {
      if (bubble) bubble.remove();
      if (how === 'cancelled') returnToBox(h.text, 'Not sent.');
      else returnToBox(h.text, copy || 'Not sent.');
    }
    if (!r.held.some(function (x) { return !x.cancelled; })) clearInterval(r.heldTimer);
  }
  function dropHeld() {
    var r = state.reading; if (!r || !r.held.length) return;
    r.held.slice().forEach(function (h) {
      h.cancelled = true;
      if (r.flushing !== h) settleHeld(r, h, 'cancelled');
    });
    saveHeld(r);
  }

  function parkTurn(r, draft, refusal, opts) {
    return apiAnswer(sessionPath(r.provider, r.id, '/queued-turns'), {
      method: 'POST', timeoutMs: 15000,
      body: { cosSessionId: cosSessionId(), clientTurnId: draft.key, prompt: draft.text },
    }).then(function (q) {
      var b = q.body || {};
      if (b.queued === true || b.error === 'duplicate_turn') {
        rememberParked(r, draft.key);
        if (opts.held) settleHeld(r, opts.held, 'parked');
        else { showPendingTurn(draft.text, 'waiting in line'); clearBoxOf(draft.text); }
        sessionStatus(b.error === 'duplicate_turn' ? 'Already waiting to send.' : (b.position ? 'The session is busy. Yours is #' + (b.position + 1) + ' in line and sends on its own.' : 'The session is busy. Yours sends next, on its own.'));
        loadQueue(r.provider, r.id);
        return 'parked';
      }
      if (b.error === 'thread_free' && !opts.freeRetry) return continueSession(r, draft.text, Object.assign({}, opts, { freeRetry: true }));
      var copy = (refusal && refusal.reasonCopy) || (b.error === 'queue_full' ? 'That session already has a full line of waiting messages.' : 'COS could not send or queue that.');
      if (opts.held) settleHeld(r, opts.held, 'refused', copy); else sessionStatus(copy + ' It is still in the box.', 'error');
      return 'refused';
    });
  }

  // Follow one sent turn to its end (completed, refused, or ambiguous) for up to 3 minutes.
  function watchTurn(bindingId, key, provider, id) {
    clearInterval(state.turnPoll);
    var started = Date.now();
    state.turnPoll = setInterval(function () {
      var r = state.reading;
      if (!r || r.id !== id || Date.now() - started > 180000) { clearInterval(state.turnPoll); return; }
      apiAnswer('/api/agent-sessions/bindings/' + encodeURIComponent(bindingId) + '/turns/' + encodeURIComponent(key)).then(function (s) {
        var o = s.body && s.body.outcome;
        if (o === 'completed') {
          clearInterval(state.turnPoll); sessionStatus('Done.'); refreshTurns(provider, id);
          // The finished turn is the authority; the stream's idle status can trail it.
          setLive({ working: false }); var st = $('session-state'); if (st) st.textContent = 'Open';
          replyEnded(r);
        } else if (o === 'refused') { clearInterval(state.turnPoll); sessionStatus(s.body.reasonCopy || 'The session refused that message.', 'error'); replyEnded(r); }
        else if (o === 'ambiguous') { clearInterval(state.turnPoll); sessionStatus(s.body.reasonCopy || 'COS cannot tell whether that landed. Look at the session before sending it again.', 'error'); }
      }).catch(function () {});
    }, 3000);
  }

  // Fork copies the session and runs the message there. One key per draft, so a second tap or
  // a resend after a timeout finds the same job instead of making a second copy.
  function forkSession(r, text) {
    if (!r.forkDraft || r.forkDraft.text !== text) r.forkDraft = { text: text, key: 'fk' + newTurnKey().slice(2) };
    var forkId = r.forkDraft.key;
    sessionStatus('Copying the session. This can take up to a minute.');
    var settle = function (b) {
      if (b.forked === true) {
        r.forkDraft = null; clearBoxOf(text);
        sessionStatus('Forked. The copy has your message and shows in Sessions in a moment.');
        setTimeout(function () { if (state.pane === 'sessions') loadSessions(); }, 4000);
        return true;
      }
      if (b.forked === false || b.state === 'failed' || b.state === 'refused') { sessionStatus((b.reasonCopy || 'COS could not copy that session.'), 'error'); return true; }
      return false;
    };
    return apiAnswer(sessionPath(r.provider, r.id, '/fork'), { method: 'POST', timeoutMs: 65000, body: { prompt: text, cosSessionId: cosSessionId(), clientForkId: forkId } }).then(function (f) {
      if (settle(f.body || {})) return;
      if (f.status !== 202) { sessionStatus('COS could not copy that session.', 'error'); return; }
      // 202: running in the background. Follow its job for up to three minutes.
      var started = Date.now();
      return new Promise(function (resolve) {
        var poll = setInterval(function () {
          if (state.reading !== r || Date.now() - started > 180000) { clearInterval(poll); resolve(); return; }
          apiAnswer('/api/agent-session-forks/' + encodeURIComponent(forkId)).then(function (j) {
            if (settle(j.body || {})) { clearInterval(poll); resolve(); }
          }).catch(function () {});
        }, 3000);
      });
    });
  }

  function stopSession() {
    var r = state.reading; if (!r) return;
    sessionStatus('Stopping');
    apiAnswer(sessionPath(r.provider, r.id, '/cancel'), { method: 'POST', timeoutMs: 15000, body: { clientCancelId: newTurnKey() } }).then(function (c) {
      var b = c.body || {};
      sessionStatus(b.reasonCopy || (b.cancelled ? 'Stopped.' : 'COS could not stop it.'), b.cancelled ? null : 'error');
      if (b.cancelled) {
        r.stoppedAt = Date.now();
        clearInterval(state.turnPoll);
        setLive({ working: false }); var st = $('session-state'); if (st) st.textContent = 'Open';
        setTimeout(function () { if (state.reading === r) refreshTurns(r.provider, r.id); }, 1500);
      }
    }).catch(function (err) { sessionStatus(err.message, 'error'); });
  }

  function removeQueued(key) {
    var r = state.reading; if (!r || !key || !parkedByMe(r, key)) return;
    apiAnswer(sessionPath(r.provider, r.id, '/queued-turns/' + encodeURIComponent(key)), { method: 'DELETE' }).then(function (d) {
      sessionStatus(d.body && d.body.cancelled ? 'Removed from the line.' : ((d.body && d.body.reasonCopy) || 'It may already be sending.'), d.body && d.body.cancelled ? null : 'error');
      loadQueue(r.provider, r.id);
    });
  }

  function renderTurns(turns, d) {
    if (!turns.length) return '<p class="reader-placeholder">' + esc(d && (d.discussion_summary || d.first_prompt) || 'No turns recorded yet.') + '</p>';
    return turns.map(function (t, i) {
      var role = String(t.role || '').toLowerCase() === 'user' ? 'user' : 'assistant';
      var text = String(t.text || t.content || '').trim();
      var long = text.length > 900 && i < turns.length - 1; // the newest turn is always shown whole
      var at = toDate(t.at);
      var who = (role === 'user' ? 'You' : providerLabel(d.provider)) + (at ? ', ' + (Date.now() - at.getTime() < 86400000 ? clock(at) : ago(at)) : '');
      return '<div class="turn ' + role + (long ? ' clamped' : '') + '" data-turn="' + i + '"><span class="who">' + esc(who) + '</span>' + md(text) + '</div>' +
        (long ? '<button type="button" class="link-btn turn-more" data-action="expand-turn" data-turn="' + i + '">Show all of it</button>' : '');
    }).join('');
  }

  // ── Meetings ────────────────────────────────────────────
  function loadMeetings(q) {
    pollLive();
    if (!state.livePoll) state.livePoll = setInterval(function () { if (!document.hidden) pollLive(); }, 8000);
    var list = $('meetings-list');
    list.innerHTML = skeletonRows(5);
    var query = q != null ? q : $('meetings-q').value.trim();
    var url = query.length >= 2 ? '/api/meetings/search?q=' + encodeURIComponent(query) + '&limit=25' : '/api/meetings?limit=40';
    api(url).then(function (d) {
      var rows = (d && (d.meetings || d.hits || d.items)) || [];
      if (!rows.length) { list.innerHTML = emptyBox(query ? 'No meeting matched' : 'No meetings yet', query ? 'Try other words.' : 'Recorded and synced meetings show here.'); return; }
      var byDay = {};
      var order = [];
      rows.forEach(function (m) { var k = m.date || m.month || 'Earlier'; if (!byDay[k]) { byDay[k] = []; order.push(k); } byDay[k].push(m); });
      list.innerHTML = order.map(function (k) {
        var d = toDate(k + 'T12:00:00');
        var label = d ? d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) : k;
        return '<h2 class="group-title"><span>' + esc(label) + '</span></h2><div class="list">' + byDay[k].map(function (m) {
          var dur = m.durationMinutes ? Math.round(Number(m.durationMinutes)) + ' min' : '';
          return '<button type="button" class="row" data-meeting="' + esc(m.domain || '') + '|' + esc(m.month || '') + '|' + esc(m.filename || '') + '">' +
            '<span class="row-title">' + esc(String(m.title || m.filename || 'Meeting').replace(/\s*\((G2|Mac)\)\s*$/, '')) + '</span>' +
            '<span class="row-side">' + esc(m.time || '') + '</span>' +
            '<span class="row-sub"><span class="clip">' + esc([domainLabel(m.domain), dur, m.source].filter(Boolean).join(', ')) + '</span></span></button>';
        }).join('') + '</div>';
      }).join('');
    }).catch(function (err) { list.innerHTML = emptyBox('Meetings did not load', err.message); });
  }
  function pollLive() {
    api('/api/meetings/live-chunks').then(function (d) {
      var sessions = ((d && d.sessions) || []).filter(function (s) { return Date.now() - (s.mtimeMs || 0) < LIVE_FRESH_MS; });
      var box = $('meetings-live');
      if (!sessions.length) { box.innerHTML = ''; setBadge('meetings', false); return; }
      var top = sessions[0];
      return api('/api/meetings/live-chunks?sessionId=' + encodeURIComponent(top.sessionId) + '&since=-1').then(function (r) {
        var read = (r && r.read) || {};
        var turns = read.turns || [];
        var live = !read.ended && Date.now() - Number(read.lastActivityAt || 0) < LIVE_FRESH_MS;
        setBadge('meetings', live);
        if (!live) { box.innerHTML = ''; return; }
        var source = SOURCES[String(top.sessionId).split('_')[0]] || 'Recording';
        var keep = box.querySelector('#live-ask-input');
        var draft = keep ? keep.value : '';
        box.innerHTML = '<section class="card" style="margin-top:0;margin-bottom:18px"><div class="panel-head" style="padding:8px 16px 4px"><h2 class="panel-title"><span class="rec-dot" style="display:inline-block;margin-right:8px;vertical-align:1px"></span>Live now</h2><span class="row-side">' + esc(source + (read.startTime ? ', ' + span(read.startTime) : '')) + '</span></div>' +
          '<div style="padding:0 16px 12px">' + (turns.length ? turns.slice(-5).map(function (t) {
            return '<p style="margin:8px 0"><strong>' + esc(t.speaker || 'Speaker') + '.</strong> ' + esc(t.text) + '</p>';
          }).join('') : '<p class="row-side" style="white-space:normal">Listening. Lines appear as people speak.</p>') + '</div>' +
          '<form class="composer" id="live-ask-form" style="position:static;margin:0 12px 12px;box-shadow:none" data-session="' + esc(top.sessionId) + '"><textarea id="live-ask-input" rows="1" placeholder="Ask COS about this meeting" enterkeyhint="send"></textarea>' +
          '<div class="composer-actions"><button type="submit" class="btn primary small">Ask</button></div></form><p class="status-line" id="live-ask-status" style="margin:0 16px 12px"></p></section>';
        if (draft) $('live-ask-input').value = draft;
      });
    }).catch(function () {});
  }
  function openMeeting(domain, month, file) {
    var reader = $('meeting-reader');
    if (!domain || !month || !file) return;
    reader.innerHTML = '<div class="reader-head"><div class="skeleton" style="height:28px;width:70%;margin:10px 0"></div></div>' + skeletonRows(2);
    api('/api/meetings/' + encodeURIComponent(domain) + '/' + encodeURIComponent(month) + '/' + encodeURIComponent(file)).then(function (m) {
      var body = String(m.content || m.summary || '').replace(/^---[\s\S]*?---\s*/, '');
      reader.innerHTML = '<div class="reader-head"><h2>' + esc(String(m.title || file).replace(/\s*\((G2|Mac)\)\s*$/, '')) + '</h2>' +
        '<div class="row-sub"><span>' + esc([domainLabel(domain), m.date || '', m.duration || ''].filter(Boolean).join(', ')) + '</span></div></div>' +
        '<div class="doc">' + esc(body || 'This meeting has no notes yet.') + '</div>';
    }).catch(function (err) { reader.innerHTML = emptyBox('This meeting did not open', err.message); });
  }

  // ── Work ────────────────────────────────────────────────
  var STAGES = [
    { id: 'planned', title: 'Planned', next: 'draft', action: 'Start' },
    { id: 'draft', title: 'In progress', next: 'qa', action: 'Ready for review' },
    { id: 'qa', title: 'Review', next: 'complete', action: 'Mark done' },
    { id: 'complete', title: 'Done', next: null, action: null }
  ];
  function loadWork() {
    var box = $('work-stages');
    if (!state.workTasks.length) box.innerHTML = skeletonRows(5);
    api('/api/work-intake').then(function (d) {
      var items = (d && d.items) || [];
      // Intake is a backlog, not an alert, so it never lights the Work badge.
      $('work-intake').innerHTML = items.length ? '<p class="intake-note"><strong>' + countWord(items.length) + ' ' + plural(items.length, 'task', 'tasks') + ' suggested from recent meetings.</strong> Review them in COS Control on your Mac.</p>' : '';
    }).catch(function () {});
    api('/api/work-board').then(function (d) {
      state.workTasks = (d && d.tasks) || [];
      renderWork(null);
    }).catch(function (err) { box.innerHTML = emptyBox('Work did not load', err.message); });
  }
  function renderWork(onlyIds) {
    var q = $('work-q').value.trim().toLowerCase();
    var tasks = state.workTasks.filter(function (t) {
      if (onlyIds) return onlyIds.indexOf(t.id) >= 0 || onlyIds.indexOf(t.workIdentity) >= 0;
      return !q || String(t.text || '').toLowerCase().indexOf(q) >= 0 || String(t.domain || '').toLowerCase().indexOf(q) >= 0;
    });
    var html = STAGES.map(function (st) {
      var items = tasks.filter(function (t) { return (t.workStage || (t.checked ? 'complete' : 'planned')) === st.id; });
      var collapsed = st.id === 'complete' && !state.workOpenStages.complete && !q && !onlyIds;
      var limit = state.workOpenStages[st.id + ':all'] ? items.length : 25;
      var rows = collapsed ? '' : items.slice(0, limit).map(function (t) {
        return '<div class="row work-row"><span class="row-title">' + esc(plain(t.text)) + '</span><span class="row-side">' + esc(domainLabel(t.domain)) + '</span>' +
          (st.next && t.taskRevision ? '<span class="row-actions"><button type="button" class="link-btn" data-action="stage" data-domain="' + esc(t.domain) + '" data-id="' + esc(t.id) + '" data-stage="' + esc(st.next) + '">' + esc(st.action) + '</button></span>' : '') + '</div>';
      }).join('');
      var foot = '';
      if (collapsed && items.length) foot = '<button type="button" class="nav-row" data-action="show-done"><span class="grow">Show ' + items.length + ' done</span><span class="chev"></span></button>';
      else if (items.length > limit) foot = '<button type="button" class="nav-row" data-action="show-all" data-stage="' + st.id + '"><span class="grow">Show all ' + items.length + '</span><span class="chev"></span></button>';
      return '<section class="stage"><div class="stage-head"><h2>' + esc(st.title) + '</h2><span class="count">' + items.length + '</span></div>' +
        (rows || foot ? '<div class="list">' + rows + foot + '</div>' : '<div class="list"><p class="empty">Nothing here.</p></div>') + '</section>';
    }).join('');
    $('work-stages').innerHTML = html;
  }
  function moveStage(btn) {
    var dom = btn.getAttribute('data-domain'), id = btn.getAttribute('data-id'), next = btn.getAttribute('data-stage');
    var task = state.workTasks.find(function (t) { return t.domain === dom && t.id === id; });
    if (!task) return;
    btn.disabled = true;
    api('/api/work-board/stage', { method: 'POST', body: { domain: dom, id: id, workStage: next, expectedText: task.text, expectedRevision: task.taskRevision } })
      .then(function () { toast('Moved'); loadWork(); })
      .catch(function (err) { btn.disabled = false; setStatus($('work-status'), err.message, true); });
  }

  // ── Messages ────────────────────────────────────────────
  function loadMessages() {
    var list = $('messages-list');
    if (!list.children.length) list.innerHTML = skeletonRows(3);
    api('/api/sessions/today/all-messages').then(function (d) {
      var msgs = ((d && d.messages) || []).slice().sort(function (a, b) { return Number(a.timestamp || 0) - Number(b.timestamp || 0); });
      if (!msgs.length) { list.innerHTML = '<p class="reader-placeholder">No messages today. Ask COS something below.</p>'; }
      else list.innerHTML = msgs.slice(-40).map(function (m) {
        var t = toDate(m.timestamp);
        var q = String(m.query || '').trim(), a = String(m.text || m.content || '').trim();
        return (q ? '<div class="turn user"><span class="who">You' + (t ? ', ' + esc(clock(t)) : '') + '</span>' + esc(q) + '</div>' : '') +
          (a ? '<div class="turn assistant"><span class="who">COS</span>' + md(a) + '</div>' : '');
      }).join('');
      if (msgs.length && !state.messagesSeen) { state.messagesSeen = true; requestAnimationFrame(function () { window.scrollTo(0, $('messages-form').offsetTop - 120); }); }
    }).catch(function (err) { list.innerHTML = emptyBox('Messages did not load', err.message); });
    api('/api/threads?limit=30').then(function (d) {
      var threads = ((d && d.threads) || []).filter(function (t) { return !t.is_resolved; });
      $('threads-list').innerHTML = threads.length ? threads.slice(0, 20).map(function (t) {
        return '<div class="row"><span class="row-title">' + esc(t.name || t.title || t.id) + '</span><span class="row-side">' + esc(ago(t.last_seen)) + '</span>' +
          '<span class="row-sub"><span class="clip">' + esc([domainLabel(t.domain), t.meeting_count ? t.meeting_count + ' meetings' : '', t.velocity || ''].filter(Boolean).join(', ')) + '</span></span></div>';
      }).join('') : '<p class="empty">No open threads.</p>';
    }).catch(function () { $('threads-list').innerHTML = '<p class="empty">Threads did not load.</p>'; });
  }
  function askCos(prompt, statusEl) {
    setStatus(statusEl, 'Sent. COS is answering.');
    return api('/api/query-jobs', { method: 'POST', body: { prompt: prompt, clientJobId: 'web_' + Date.now() } }).then(function () {
      setTimeout(function () { if (state.pane === 'messages') loadMessages(); }, 4000);
      setTimeout(function () { if (state.pane === 'messages') { loadMessages(); setStatus(statusEl, ''); } }, 15000);
    }).catch(function (err) { setStatus(statusEl, err.message, true); throw err; });
  }

  // ── Memories (the native page, hosted) ──────────────────
  function syncFrameTheme() {
    var frame = $('memories-frame'); if (!frame) return;
    var mode = window.CosTheme ? window.CosTheme.mode() : 'light';
    frame.style.colorScheme = mode;
    try {
      var root = frame.contentDocument && frame.contentDocument.documentElement;
      if (root) {
        root.setAttribute('data-theme', mode);
        if (isPhone()) root.setAttribute('data-host', 'web-phone'); else root.removeAttribute('data-host');
      }
    } catch (_e) {}
  }
  function loadMemories() {
    var frame = $('memories-frame');
    if (state.memoriesLoaded) { syncFrameTheme(); return; }
    state.memoriesLoaded = true;
    frame.addEventListener('load', syncFrameTheme);
    frame.src = '/control/memories/memories.html';
  }

  // ── Speakers ────────────────────────────────────────────
  function loadSpeakers() {
    var box = $('speakers-meetings');
    box.innerHTML = skeletonRows(4);
    api('/api/meetings?limit=40').then(function (d) {
      var rows = ((d && d.meetings) || []).filter(function (m) { return !!m.sessionId; });
      box.innerHTML = rows.length ? '<h2 class="group-title"><span>Meetings with audio</span><span>' + rows.length + '</span></h2><div class="list">' + rows.map(function (m) {
        return '<button type="button" class="row" data-speakers="' + esc(m.sessionId) + '"><span class="row-title">' + esc(String(m.title || m.filename).replace(/\s*\((G2|Mac)\)\s*$/, '')) + '</span><span class="row-side">' + esc(ago(m.date ? m.date + 'T' + (m.time || '12:00') : '')) + '</span>' +
          '<span class="row-sub"><span class="clip">' + esc([domainLabel(m.domain), m.attendeeCount ? m.attendeeCount + ' people' : ''].filter(Boolean).join(', ')) + '</span></span></button>';
      }).join('') + '</div>' : emptyBox('No meetings with audio', 'Meetings recorded on your glasses or Mac show here.');
    }).catch(function (err) { box.innerHTML = emptyBox('Meetings did not load', err.message); });
    Promise.all([api('/api/voice/profiles').catch(function () { return {}; }), api('/api/voice/held-groups').catch(function () { return {}; })]).then(function (res) {
      var profiles = (res[0] && res[0].profiles) || [];
      var groups = (res[1] && res[1].groups) || [];
      var named = profiles.filter(function (p) { return !p.needsName; });
      var html = '<div class="setting"><span class="name">' + named.length + ' named ' + plural(named.length, 'voice', 'voices') + '</span><span class="desc">' + esc(named.slice(0, 6).map(function (p) { return p.name; }).join(', ')) + (named.length > 6 ? ' and more' : '') + '</span></div>';
      if (groups.length) html += '<div class="setting"><span class="name">' + groups.length + ' unnamed ' + plural(groups.length, 'voice', 'voices') + ' held</span><span class="desc">Name them in COS Control on your Mac, where you can hear each one.</span></div>';
      $('speakers-profiles').innerHTML = html;
    });
  }
  function openSpeakers(sessionId) {
    var reader = $('speaker-reader');
    if (!sessionId) return;
    reader.innerHTML = skeletonRows(3);
    api('/api/meeting/' + encodeURIComponent(sessionId) + '/speakers').then(function (d) {
      var speakers = (d && d.speakers) || [];
      if (!speakers.length) { reader.innerHTML = emptyBox('No speakers found', 'COS did not split this meeting by voice.'); return; }
      reader.innerHTML = '<div class="reader-head"><h2>Who spoke</h2><div class="row-sub"><span>Speaker names are suggestions. Listen before you rename.</span></div></div>' +
        '<div class="list" style="margin-top:14px">' + speakers.map(function (sp, i) {
          var label = sp.speaker || sp.label || 'Speaker';
          var chunk = sp.sampleChunkIndex != null ? sp.sampleChunkIndex : (sp.chunks && sp.chunks[0]);
          return '<div class="row speaker-row"><span class="row-title">' + esc(label) + '</span><span class="row-side">' + esc((sp.count || sp.turns || 0) + ' turns') + '</span>' +
            (sp.sampleText ? '<span class="row-sub"><span class="clip">“' + esc(sp.sampleText) + '”</span></span>' : '') +
            (chunk != null ? '<audio controls preload="none" src="/api/meeting/' + encodeURIComponent(sessionId) + '/audio/' + encodeURIComponent(chunk) + '"></audio>' : '') +
            '<form class="capture-row" data-relabel="' + esc(label) + '" data-session="' + esc(sessionId) + '"><input class="field" type="text" placeholder="Rename ' + esc(label) + '" aria-label="New name for ' + esc(label) + '" id="relabel-' + i + '"><button type="submit" class="btn small">Rename</button></form></div>';
        }).join('') + '</div><p class="status-line" id="speaker-status"></p>';
    }).catch(function (err) { reader.innerHTML = emptyBox('Speakers did not load', err.message); });
  }

  // ── Usage ───────────────────────────────────────────────
  function categoryLabel(id) {
    var words = String(id || 'Other').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  function money(n) { return '$' + (Number(n) || 0).toFixed(Number(n) >= 100 ? 0 : 2); }
  function loadUsage(force) {
    var box = $('usage-body');
    box.innerHTML = skeletonRows(4);
    api('/api/usage/summary' + (force ? '?refresh=1' : '')).then(function (d) {
      var cos = (d && d.cosCost) || {};
      var rows = (cos.rows || []).slice().sort(function (a, b) { return (b.estimatedUSD || 0) - (a.estimatedUSD || 0); });
      var total = rows.reduce(function (s, r) { return s + (Number(r.estimatedUSD) || 0); }, 0);
      var max = rows.length ? Math.max.apply(null, rows.map(function (r) { return Number(r.estimatedUSD) || 0; })) || 1 : 1;
      var calls = rows.reduce(function (s, r) { return s + (Number(r.calls) || 0); }, 0);
      var html = '<div class="list"><div class="stat-line"><span class="big-number">' + esc(money(total)) + '</span><span class="sub">' + esc(calls.toLocaleString() + ' background calls in 30 days') + '</span></div></div>';
      if (rows.length) {
        html += '<h2 class="group-title"><span>Where it went</span></h2><div class="list">' + rows.slice(0, 12).map(function (r) {
          var pct = Math.round(((Number(r.estimatedUSD) || 0) / max) * 100);
          return '<div class="row"><span class="row-title">' + esc(categoryLabel(r.category)) + '</span><span class="row-side">' + esc(money(r.estimatedUSD)) + '</span>' +
            '<span class="row-sub">' + esc((r.calls || 0).toLocaleString() + ' calls') + '</span><span class="meter"><span style="width:' + pct + '%"></span></span></div>';
        }).join('') + '</div>';
      }
      var buckets = ((d.sessionUsage && d.sessionUsage.buckets) || []).slice().reverse().slice(0, 14);
      if (buckets.length) {
        html += '<h2 class="group-title"><span>Your sessions by day</span></h2><div class="list">' + buckets.map(function (b) {
          var c = b.counts || {}; var tok = (c.input || 0) + (c.output || 0) + (c.cacheRead || 0) + (c.cacheWrite || 0);
          var usd = typeof b.costUSD === 'number' ? b.costUSD : b.estimatedUSD;
          return '<div class="row"><span class="row-title">' + esc(b.day || b.label || '') + '</span><span class="row-side">' + esc(usd != null ? money(usd) : '') + '</span><span class="row-sub">' + esc(providerLabel(b.provider) + ', ' + Math.round(tok / 1000).toLocaleString() + 'k tokens') + '</span></div>';
        }).join('') + '</div>';
      }
      box.innerHTML = html;
    }).catch(function (err) { box.innerHTML = emptyBox('Usage did not load', err.message); });
  }

  // ── Settings ────────────────────────────────────────────
  function paintAppearance() {
    var choice = window.CosTheme ? window.CosTheme.choice() : 'system';
    document.querySelectorAll('[data-theme-choice]').forEach(function (b) {
      var on = b.getAttribute('data-theme-choice') === choice;
      b.setAttribute('aria-pressed', String(on));
      b.querySelector('.value').innerHTML = on ? '<span class="check">✓</span>' : '';
    });
  }
  function loadSettings() {
    paintAppearance();
    var box = $('settings-server');
    var host = esc(state.serverName.replace(/-/g, ' '));
    box.innerHTML = '<h2 class="group-title">COS on ' + host + '</h2>' + skeletonRows(3);
    Promise.all([
      api('/api/decision-provider').catch(function () { return null; }),
      api('/api/live-cues/v2/settings').catch(function () { return null; }),
      api('/api/stt-settings').catch(function () { return null; }),
      api('/api/morning-brief').catch(function () { return null; })
    ]).then(function (res) {
      var dp = res[0] || {}, lc = res[1] || {}, stt = res[2] || {}, mb = (res[3] && (res[3].config || res[3])) || {};
      var provider = dp.provider || dp.decisionProvider || '';
      var cuesOn = !!(lc.enabled != null ? lc.enabled : (lc.settings && lc.settings.enabled));
      box.innerHTML = '<h2 class="group-title">COS on ' + host + '</h2><div class="list">' +
        '<div class="setting"><span class="name">Live cues</span><span class="desc">Quiet suggestions on your glasses during meetings.</span><button type="button" class="switch" role="switch" aria-checked="' + cuesOn + '" aria-label="Live cues" data-action="toggle-cues" data-on="' + cuesOn + '"></button></div>' +
        '<div class="setting"><span class="name">Meaning search</span><span class="desc">Which model ranks sessions and tasks by meaning.</span><span class="value">' + esc(provider ? (provider === 'subq' ? 'SubQ' : provider === 'jev' ? 'Jev' : provider) : 'Not set') + '</span></div>' +
        '<button type="button" class="setting" data-action="set-provider" data-provider="jev"><span class="name">Use Jev</span><span class="desc">Fast and cheap.</span><span class="value">' + (provider === 'jev' ? '<span class="check">✓</span>' : '') + '</span></button>' +
        '<button type="button" class="setting" data-action="set-provider" data-provider="subq"><span class="name">Use SubQ</span><span class="desc">Asks a yes or no question per match.</span><span class="value">' + (provider === 'subq' ? '<span class="check">✓</span>' : '') + '</span></button>' +
        '<div class="setting"><span class="name">Transcription</span><span class="desc">Speech to text on your Mac.</span><span class="value">' + esc(stt.tier || stt.liveModel || stt.mode || 'Local') + '</span></div>' +
        '<div class="setting"><span class="name">Morning brief</span><span class="desc">' + esc(mb.enabled === false ? 'Paused' : 'Runs every day') + '</span><span class="value">' + esc(mb.time || '7:00') + '</span></div>' +
      '</div><p class="status-line" id="settings-status">Keys, permissions and glasses pairing change only on the Mac.</p>';
    });
  }
  var codeTimer = null;
  function showDeviceCode() {
    var panel = $('device-code-panel');
    panel.classList.remove('hidden');
    panel.innerHTML = '<p>Getting a code</p>';
    api('/api/web-session/device-code', { method: 'POST', body: {} }).then(function (d) {
      var url = state.tailnetUrl || (location.origin + '/control');
      var exp = toDate(d.expiresAt);
      panel.innerHTML = '<span class="code">' + esc(d.code) + '</span>' +
        '<p>On your phone, open <span class="url">' + esc(url) + '</span> and type this code.</p>' +
        '<p id="device-code-left"></p>';
      clearInterval(codeTimer);
      var tick = function () {
        var left = exp ? Math.round((exp.getTime() - Date.now()) / 1000) : 0;
        var el = $('device-code-left');
        if (!el) { clearInterval(codeTimer); return; }
        if (left <= 0) { clearInterval(codeTimer); panel.innerHTML = '<p>That code expired. Choose Sign in another device for a new one.</p>'; return; }
        el.textContent = 'Works once, for ' + (left >= 60 ? Math.ceil(left / 60) + ' more min' : left + ' more sec') + '.';
      };
      tick(); codeTimer = setInterval(tick, 1000);
    }).catch(function (err) { panel.innerHTML = '<p class="status-line error">' + esc(err.message) + '</p>'; });
  }
  function loadTailnetUrl() {
    api('/api/tailscale/web-url').then(function (d) {
      state.tailnetUrl = d.magicDnsHttpsUrl || d.magicDnsUrl || d.ipv4Url || '';
      $('tailnet-url').textContent = state.tailnetUrl || 'Tailscale is not running on the Mac';
    }).catch(function () { $('tailnet-url').textContent = 'Tailscale address unavailable'; });
  }

  // ── Ask sheet (⌘K) ──────────────────────────────────────
  var JUMPS = [
    ['today', 'Today'], ['meetings', 'Meetings'], ['work', 'Work'], ['sessions', 'Sessions'], ['messages', 'Messages'],
    ['memories', 'Memories'], ['speakers', 'Speakers'], ['usage', 'Usage'], ['settings', 'Settings']
  ];
  function openAsk(prefill) {
    $('ask-sheet').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    var input = $('ask-q'); input.value = prefill || '';
    renderAsk();
    setTimeout(function () { input.focus(); }, 30);
  }
  function closeAsk() { $('ask-sheet').classList.add('hidden'); document.body.style.overflow = ''; }
  function renderAsk() {
    var q = $('ask-q').value.trim();
    var out = $('ask-results');
    if (!q) {
      var recent = state.sessions.slice(0, 5);
      out.innerHTML = '<h2 class="group-title">Go to</h2><div class="list">' + JUMPS.map(function (j) {
        return '<button type="button" class="nav-row" data-goto="' + j[0] + '"><svg class="icon"><use href="#i-' + j[0] + '"/></svg><span class="grow">' + esc(j[1]) + '</span><span class="chev"></span></button>';
      }).join('') + '</div>' +
        (recent.length ? '<h2 class="group-title">Recent sessions</h2><div class="list">' + recent.map(function (s) { return sessionRow(s); }).join('') + '</div>' : '');
      return;
    }
    var jumps = JUMPS.filter(function (j) { return j[1].toLowerCase().indexOf(q.toLowerCase()) === 0; });
    out.innerHTML = '<div class="list" style="margin-top:14px">' +
      '<button type="button" class="nav-row" data-action="ask-cos"><svg class="icon"><use href="#i-ask"/></svg><span class="grow">Ask COS<span class="note">“' + esc(q) + '”</span></span></button>' +
      '<button type="button" class="nav-row" data-action="ask-meaning"><svg class="icon"><use href="#i-sessions"/></svg><span class="grow">Find a session about this<span class="note">Ranks every session by meaning</span></span></button>' +
      '<button type="button" class="nav-row" data-action="ask-work"><svg class="icon"><use href="#i-work"/></svg><span class="grow">Find a task about this<span class="note">Searches Work by meaning</span></span></button>' +
      jumps.map(function (j) { return '<button type="button" class="nav-row" data-goto="' + j[0] + '"><svg class="icon"><use href="#i-' + j[0] + '"/></svg><span class="grow">Go to ' + esc(j[1]) + '</span><span class="chev"></span></button>'; }).join('') +
      '</div><div id="ask-hits"></div><p class="status-line" id="ask-status"></p>';
    clearTimeout(renderAsk.t);
    if (q.length >= 2) renderAsk.t = setTimeout(function () {
      api('/api/agent-sessions/search?q=' + encodeURIComponent(q) + '&limit=6').then(function (d) {
        var hits = (d && d.hits) || [];
        var el = $('ask-hits'); if (!el || $('ask-q').value.trim() !== q) return;
        el.innerHTML = hits.length ? '<h2 class="group-title"><span>Sessions with “' + esc(q) + '”</span><span>' + hits.length + '</span></h2><div class="list">' + hits.map(function (s) { return sessionRow(s, s.snippet); }).join('') + '</div>' : '';
      }).catch(function () {});
    }, 220);
  }

  // ── events (one delegated listener) ─────────────────────
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-goto],[data-pane],[data-session],[data-meeting],[data-speakers],[data-action],[data-open-ask],[data-theme-choice],#topbar-back,#section-btn,#sign-out,#copy-link,#ask-close,#auth-switch,#auth-token-show,#device-code-btn');
    if (!t) { if (e.target.id === 'ask-sheet') closeAsk(); if (e.target.id === 'section-menu') closeMenu(); return; }
    var inSheet = !!t.closest('#ask-sheet');
    if (t.id === 'topbar-back') return goBack();
    if (t.id === 'section-btn') return openMenu();
    if (t.id === 'auth-switch') {
      var toToken = $('auth-token-block').classList.contains('hidden');
      $('auth-token-block').classList.toggle('hidden', !toToken);
      $('auth-code-block').classList.toggle('hidden', toToken);
      t.textContent = toToken ? 'Use a sign-in code instead' : 'Use the pairing token instead';
      (toToken ? $('auth-token') : $('auth-code')).focus();
      return;
    }
    if (t.id === 'auth-token-show') {
      // A stale or partial paste is invisible in a password field; let the person look.
      var shown = $('auth-token').type === 'text';
      $('auth-token').type = shown ? 'password' : 'text';
      t.textContent = shown ? 'Show token' : 'Hide token';
      t.setAttribute('aria-pressed', shown ? 'false' : 'true');
      return;
    }
    if (t.id === 'device-code-btn') return showDeviceCode();
    if (t.id === 'ask-close') return closeAsk();
    if (t.id === 'sign-out') { api('/api/web-session/logout', { method: 'POST' }).finally(function () { showAuth(); }); return; }
    if (t.id === 'copy-link') {
      var link = state.tailnetUrl || location.origin + '/control';
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(function () { toast('Link copied'); }, function () { toast(link); });
      else toast(link);
      return;
    }
    if (t.hasAttribute('data-open-ask')) return openAsk();
    if (t.hasAttribute('data-theme-choice')) { window.CosTheme.set(t.getAttribute('data-theme-choice')); paintAppearance(); syncFrameTheme(); return; }
    if (t.hasAttribute('data-goto') || t.hasAttribute('data-pane')) { if (inSheet) closeAsk(); closeMenu(); return go(t.getAttribute('data-goto') || t.getAttribute('data-pane')); }
    if (t.hasAttribute('data-session')) { if (inSheet) closeAsk(); var p = t.getAttribute('data-session').split('|'); return go('sessions', [p[0], p.slice(1).join('|')]); }
    if (t.hasAttribute('data-meeting')) { var m = t.getAttribute('data-meeting').split('|'); return go('meetings', m); }
    if (t.hasAttribute('data-speakers')) return go('speakers', [t.getAttribute('data-speakers')]);
    var action = t.getAttribute('data-action');
    if (action === 'stage') return moveStage(t);
    if (action === 'show-done') { state.workOpenStages.complete = true; return renderWork(null); }
    if (action === 'show-all') { state.workOpenStages[t.getAttribute('data-stage') + ':all'] = true; return renderWork(null); }
    if (action === 'fork-session') return sendSessionTurn(true);
    if (action === 'send-anyway') { var rev = state.reading && state.reading.sendAnyway; if (state.reading) state.reading.sendAnyway = null; return sendSessionTurn(false, { acknowledgedRevision: rev }); }
    if (action === 'stop-session') return stopSession();
    if (action === 'drop-after') return dropHeld();
    if (action === 'unqueue') return removeQueued(t.getAttribute('data-turn-key'));
    if (action === 'revoke-all') {
      if (t.getAttribute('data-armed') !== '1') { t.setAttribute('data-armed', '1'); t.querySelector('.grow').firstChild.textContent = 'Tap again to sign out every browser'; return; }
      api('/api/web-session/revoke-all', { method: 'POST', body: {} }).then(function () { showAuth('Every browser is signed out, this one too.'); }).catch(function (err) { setStatus($('settings-status'), err.message, true); });
      return;
    }
    if (action === 'expand-turn') { var tr = document.querySelector('.turn[data-turn="' + t.getAttribute('data-turn') + '"]'); if (tr) tr.classList.remove('clamped'); t.remove(); return; }
    if (action === 'toggle-cues') {
      var on = t.getAttribute('aria-checked') === 'true';
      t.setAttribute('aria-checked', String(!on));
      api('/api/live-cues/v2/settings', { method: 'POST', body: { enabled: !on } }).then(function () { toast(!on ? 'Live cues on' : 'Live cues off'); })
        .catch(function (err) { t.setAttribute('aria-checked', String(on)); setStatus($('settings-status'), err.message, true); });
      return;
    }
    if (action === 'set-provider') {
      api('/api/decision-provider', { method: 'PATCH', body: { provider: t.getAttribute('data-provider') } }).then(function () { toast('Saved'); loadSettings(); })
        .catch(function (err) { setStatus($('settings-status'), err.message, true); });
      return;
    }
    var q = $('ask-q').value.trim();
    if (action === 'ask-cos' && q) { askCos(q, $('ask-status')).then(function () { closeAsk(); go('messages'); }).catch(function () {}); return; }
    if (action === 'ask-meaning' && q) { $('ask-hits').innerHTML = skeletonRows(3); findByMeaning(q).then(function (html) { var el = $('ask-hits'); if (el) el.innerHTML = html; }); return; }
    if (action === 'ask-work' && q) {
      closeAsk(); go('work'); $('work-q').value = q;
      api('/api/work/search', { method: 'POST', body: { query: q } }).then(function (d) { if (d && Array.isArray(d.results)) renderWork(d.results.map(function (r) { return r.id; })); }).catch(function () {});
    }
  });

  document.addEventListener('submit', function (e) {
    var f = e.target;
    e.preventDefault();
    if (f.id === 'auth-form') {
      var usingToken = !$('auth-token-block').classList.contains('hidden');
      var value = (usingToken ? $('auth-token') : $('auth-code')).value.trim();
      if (!value) return;
      var body = usingToken ? { token: value } : { code: value };
      api('/api/web-session/login', { method: 'POST', body: body }).then(function (d) { $('auth-token').value = ''; $('auth-code').value = ''; showShell(d); })
        .catch(function (err) {
          // The server names what failed (wrong token, wrong code, the glasses code, lockout).
          showAuth(err.message);
        });
    } else if (f.id === 'session-form') sendSessionTurn(false);
    else if (f.id === 'sessions-search-form') { $('sessions-q').blur(); searchSessions(); }
    else if (f.id === 'meetings-search-form') { $('meetings-q').blur(); if (parseRoute().args.length) go('meetings'); loadMeetings($('meetings-q').value.trim()); }
    else if (f.id === 'work-search-form') {
      var q = $('work-q').value.trim(); $('work-q').blur();
      if (q.length < 2) return renderWork(null);
      setStatus($('work-status'), 'Searching by meaning');
      api('/api/work/search', { method: 'POST', body: { query: q } }).then(function (d) {
        setStatus($('work-status'), d && d.available === false ? (d.message || 'Meaning search is off.') : '');
        if (d && Array.isArray(d.results)) renderWork(d.results.map(function (r) { return r.id; }));
      }).catch(function (err) { setStatus($('work-status'), err.message, true); });
    } else if (f.id === 'work-capture-form') {
      var text = $('work-capture-text').value.trim(); if (!text) return;
      api('/api/tasks/capture', { method: 'POST', body: { domain: $('work-capture-domain').value, text: text, captureId: 'web_' + Date.now() } })
        .then(function () { $('work-capture-text').value = ''; toast('Added to Work'); loadWork(); })
        .catch(function (err) { setStatus($('work-status'), err.message, true); });
    } else if (f.id === 'messages-form') {
      var inp = $('messages-input'), prompt = inp.value.trim(); if (!prompt) return;
      inp.value = ''; autoGrow(inp);
      askCos(prompt, $('messages-status')).catch(function () { inp.value = prompt; });
    } else if (f.id === 'live-ask-form') {
      var li = $('live-ask-input'), question = li.value.trim(); if (!question) return;
      setStatus($('live-ask-status'), 'Asking COS');
      api('/api/meetings/live-ask', { method: 'POST', body: { question: question, sessionId: f.getAttribute('data-session') } }).then(function (d) {
        li.value = ''; setStatus($('live-ask-status'), (d && (d.answer || d.text || d.message)) || 'Answered.');
      }).catch(function (err) { setStatus($('live-ask-status'), err.message, true); });
    } else if (f.hasAttribute('data-relabel')) {
      var from = f.getAttribute('data-relabel'), sid = f.getAttribute('data-session'), to = f.querySelector('input').value.trim();
      if (!to) return;
      api('/api/meeting/' + encodeURIComponent(sid) + '/relabel', { method: 'POST', body: { from: from, to: to } })
        .then(function () { toast('Renamed to ' + to); openSpeakers(sid); })
        .catch(function (err) { setStatus($('speaker-status'), err.message, true); });
    } else if (f.id === 'ask-form') {
      var hits = $('ask-hits'); if (hits && $('ask-q').value.trim().length >= 2) renderAsk();
    }
  });

  document.addEventListener('input', function (e) {
    if (e.target.tagName === 'TEXTAREA') autoGrow(e.target);
    if (e.target.id === 'ask-q') renderAsk();
    if (e.target.id === 'work-q') renderWork(null);
    if (e.target.id === 'sessions-q' && !e.target.value.trim()) renderSessionGroups(state.sessions);
  });
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openAsk(); return; }
    if (e.key === 'Escape' && !$('ask-sheet').classList.contains('hidden')) { closeAsk(); return; }
    if (e.key === 'Escape' && !$('section-menu').classList.contains('hidden')) { closeMenu(); $('section-btn').focus(); return; }
    if (e.key === 'Enter' && !e.shiftKey && e.target.tagName === 'TEXTAREA' && !isPhone()) { e.preventDefault(); var form = e.target.closest('form'); if (form) form.requestSubmit(); }
  });
  document.querySelectorAll('[data-mode]').forEach(function (b) {
    b.addEventListener('click', function () {
      state.sessionsMode = b.getAttribute('data-mode');
      document.querySelectorAll('[data-mode]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      if ($('sessions-q').value.trim().length >= 2) searchSessions();
    });
  });
  window.addEventListener('hashchange', route);
  // Folding or unfolding the Duo crosses the 600px line: keep the hosted Memories page in step.
  window.matchMedia('(min-width: 600px)').addEventListener('change', syncFrameTheme);
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || $('app-shell').classList.contains('hidden')) return;
    if (Date.now() - (state.lastLoad[state.pane] || 0) > 60000 && !parseRoute().args.length) route();
  });
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin) return;
    var d = e.data;
    if (d && d.type === 'cos-control-nav' && d.op === 'open.section' && d.args && d.args.section) {
      var target = String(d.args.section).toLowerCase();
      if (ROOT_PANES.indexOf(target) >= 0) go(target);
    }
  });

  // ── boot ────────────────────────────────────────────────
  (function boot() {
    var params = new URLSearchParams(location.search);
    var handoff = params.get('handoff');
    if (handoff) {
      history.replaceState({}, document.title, location.pathname + location.hash);
      api('/api/web-session/login', { method: 'POST', body: { handoff: handoff } }).then(showShell)
        .catch(function (err) { showAuth(err && err.status ? err.message : 'That sign-in link did not work. Scan a new one in COS Control, or use a code or the token.'); });
      return;
    }
    api('/api/web-session/status').then(function (st) { if (st && st.authenticated) showShell(st); else showAuth(); }).catch(function () { showAuth('COS on your Mac is not answering. Check that the Mac is awake and on Tailscale.'); });
  })();
})();
