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
  function openSession(provider, id) {
    var reader = $('session-reader');
    if (!provider || !id) return;
    if (state.stream) { state.stream.close(); state.stream = null; }
    document.querySelectorAll('#sessions-list .row').forEach(function (r) { r.setAttribute('aria-selected', String(r.getAttribute('data-session') === provider + '|' + id)); });
    reader.innerHTML = '<div class="reader-head"><div class="skeleton" style="height:28px;width:70%;margin:10px 0"></div></div>' + skeletonRows(3);
    api('/api/agent-sessions/' + encodeURIComponent(provider) + '/' + encodeURIComponent(id) + '?turns=30').then(function (d) {
      // recent_turns is a plain list of {role, text, at}, oldest first.
      var turns = Array.isArray(d && d.recent_turns) ? d.recent_turns : ((d && d.recent_turns && d.recent_turns.turns) || (d && d.turns) || []);
      var stateWord = d.running_active ? 'Working now' : d.running ? 'Open' : 'Not running';
      reader.innerHTML =
        '<div class="reader-head"><h2>' + esc(sessionTitle(d)) + '</h2>' +
        '<div class="row-sub">' + badge(provider) + '<span id="session-state">' + esc(stateWord) + '</span>' + (d.project ? '<span class="clip">' + esc(d.project) + '</span>' : '') + '</div></div>' +
        '<div class="turns" id="session-turns">' + renderTurns(turns, d) + '</div>' +
        '<form class="composer" id="session-form" data-provider="' + esc(provider) + '" data-id="' + esc(id) + '">' +
          '<textarea id="session-input" rows="1" placeholder="Send this session a turn" enterkeyhint="send" aria-label="Turn for this session"></textarea>' +
          '<div class="composer-actions"><button type="button" class="btn small" data-action="fork-session">Fork</button>' +
          '<button type="submit" class="btn primary small" aria-label="Send"><svg class="icon" style="width:18px;height:18px"><use href="#i-send"/></svg></button></div>' +
        '</form><p class="status-line" id="session-status"></p>';
      // Land on the latest turn, where a reply goes, not the oldest of the thirty.
      if (turns.length) requestAnimationFrame(function () { window.scrollTo(0, document.documentElement.scrollHeight); });
      try {
        var es = new EventSource('/api/agent-sessions/' + encodeURIComponent(provider) + '/' + encodeURIComponent(id) + '/stream');
        state.stream = es;
        es.addEventListener('state', function (ev) {
          try { var st = JSON.parse(ev.data); var el = $('session-state'); if (el && st && st.state) el.textContent = st.state === 'running' ? 'Working now' : st.state === 'idle' ? 'Open' : String(st.state); } catch (_e) {}
        });
      } catch (_e) {}
    }).catch(function (err) { reader.innerHTML = emptyBox('This session did not open', err.message); });
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
  function sendSessionTurn(fork) {
    var form = $('session-form'); if (!form) return;
    var provider = form.getAttribute('data-provider'), id = form.getAttribute('data-id');
    var input = $('session-input'), text = input.value.trim(), status = $('session-status');
    if (!text) { setStatus(status, fork ? 'Write what the fork should do first.' : 'Write a turn first.', true); return; }
    setStatus(status, fork ? 'Starting a fork' : 'Sending');
    var path = '/api/agent-sessions/' + encodeURIComponent(provider) + '/' + encodeURIComponent(id) + (fork ? '/fork' : '/queued-turns');
    var body = fork ? { prompt: text, clientForkId: 'web_fork_' + Date.now() } : { prompt: text, clientTurnId: 'web_turn_' + Date.now() };
    api(path, { method: 'POST', body: body }).then(function (res) {
      input.value = ''; autoGrow(input);
      setStatus(status, fork ? 'Fork started. It shows under Sessions in a moment.' : 'Sent. It runs when the session is free.');
      if (fork && res && res.newSessionId) toast('Fork started');
    }).catch(function (err) { setStatus(status, err.message, true); });
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
          (a ? '<div class="turn assistant"><span class="who">COS</span>' + esc(a) + '</div>' : '');
      }).join('');
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
    try { if (frame.contentDocument && frame.contentDocument.documentElement) frame.contentDocument.documentElement.setAttribute('data-theme', mode); } catch (_e) {}
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
          return '<div class="row"><span class="row-title">' + esc(r.category) + '</span><span class="row-side">' + esc(money(r.estimatedUSD)) + '</span>' +
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
    var t = e.target.closest('[data-goto],[data-pane],[data-session],[data-meeting],[data-speakers],[data-action],[data-open-ask],[data-theme-choice],#topbar-back,#section-btn,#sign-out,#copy-link,#ask-close');
    if (!t) { if (e.target.id === 'ask-sheet') closeAsk(); if (e.target.id === 'section-menu') closeMenu(); return; }
    var inSheet = !!t.closest('#ask-sheet');
    if (t.id === 'topbar-back') return goBack();
    if (t.id === 'section-btn') return openMenu();
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
      var tok = $('auth-token').value.trim(); if (!tok) return;
      api('/api/web-session/login', { method: 'POST', body: { token: tok } }).then(function (d) { $('auth-token').value = ''; showShell(d); })
        .catch(function (err) { showAuth(err.status === 401 ? 'That token did not match. Copy it again from COS Control.' : err.message); });
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
        .catch(function () { showAuth('That sign-in link expired. Open it again from COS Control, or paste the token.'); });
      return;
    }
    api('/api/web-session/status').then(function (st) { if (st && st.authenticated) showShell(st); else showAuth(); }).catch(function () { showAuth('COS on your Mac is not answering. Check that the Mac is awake and on Tailscale.'); });
  })();
})();
