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
    // Reads give up after 20 s (a sleeping or busy Mac must not leave a reader on its skeleton
    // forever); a caller can pass timeoutMs. Writes wait unless they ask, so a slow save is not
    // reported as failed while it may still land.
    var method = o.method || 'GET';
    var limit = o.timeoutMs != null ? o.timeoutMs : (method === 'GET' ? API_READ_TIMEOUT_MS : 0);
    var ctrl = limit && window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, limit) : null;
    return fetch(path, { method: method, headers: headers, credentials: 'same-origin', body: body, signal: ctrl ? ctrl.signal : undefined }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (res.status === 401 && path.indexOf('/api/web-session/') !== 0) { showAuth(); var gone = new Error('Signed out. Connect this browser again.'); gone.status = 401; throw gone; }
      return res.text().then(function (text) {
        var data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (_e) { data = {}; }
        if (!res.ok) {
          var msg = (data && (data.message || (data.error && data.error.message) || data.error)) || ('The server answered ' + res.status + '.');
          var err = new Error(typeof msg === 'string' ? msg : 'The server answered ' + res.status + '.');
          err.status = res.status;
          // The machine-readable reason, so a pane can say the right thing for a refusal whose
          // body carries a code and no sentence (for example work-intake's {error: {code}}).
          var code = data && ((data.error && typeof data.error === 'object' && data.error.code) || data.code || data.reason || (typeof data.error === 'string' ? data.error : ''));
          if (code) err.code = String(code);
          throw err;
        }
        return data;
      });
    }, function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === 'AbortError' && ctrl && ctrl.signal.aborted) {
        var late = new Error('Your Mac did not answer in ' + Math.round(limit / 1000) + ' seconds. Check that it is awake, then try again.');
        late.code = 'timeout'; throw late;
      }
      throw err;
    });
  }
  var API_READ_TIMEOUT_MS = 20000;

  // ── state ───────────────────────────────────────────────
  var state = {
    pane: 'today', serverName: '', tailnetUrl: '',
    sessions: [], sessionsMode: 'words', workTasks: [], workOpenStages: { complete: false },
    stream: null, memoriesLoaded: false, lastLoad: {}, livePoll: null
  };
  // Control's order (ActivitySection.visibleSections): Today, then Messages to Dictation. Usage is a
  // view inside Sessions on the Mac; its route stays so old links work, and the rail marks Sessions.
  var ROOT_PANES = ['today', 'messages', 'speakers', 'meetings', 'memories', 'threads', 'sessions', 'work', 'dictation', 'usage', 'settings'];
  var TITLES = { today: 'Today', messages: 'Messages', speakers: 'Speakers', meetings: 'Meetings', memories: 'Memories', threads: 'Threads', sessions: 'Sessions', work: 'Work', dictation: 'Dictation', usage: 'Usage', settings: 'Settings' };
  // Pane modules (panes/*.js) register here: { load(args, ctx), leave(), up(args) }. A registered
  // pane owns its section; route() only shows it and hands it the hash arguments.
  var PANES = {};
  var routeHooks = [];
  var shellHooks = [];
  var crumbDetail = '';

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
    if (state.pane !== r.pane && PANES[state.pane] && PANES[state.pane].leave) { try { PANES[state.pane].leave(); } catch (err) { console.error(err); } }
    state.pane = r.pane;
    crumbDetail = '';
    document.querySelectorAll('.pane').forEach(function (sec) { sec.classList.toggle('hidden', sec.id !== 'pane-' + r.pane); });
    document.querySelectorAll('#section-menu [data-goto]').forEach(function (b) { if (b.getAttribute('data-goto') === r.pane) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var railPane = r.pane === 'usage' ? 'sessions' : r.pane;
    document.querySelectorAll('.rail-btn,.rail-settings').forEach(function (b) { if (b.getAttribute('data-pane') === railPane) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
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

    if (PANES[r.pane]) { try { PANES[r.pane].load(r.args, { changed: changedPane }); } catch (err) { console.error(err); } }
    else if (r.pane === 'today') loadToday();
    else if (r.pane === 'sessions') { if (!reading || !state.sessions.length || changedPane) loadSessions(); if (reading) openSession(r.args[0], r.args[1]); }
    else if (r.pane === 'memories') loadMemories();
    else if (r.pane === 'usage') loadUsage(false);
    state.lastLoad[r.pane] = Date.now();
    runHooks(routeHooks, r);
  }
  function runHooks(list, arg) { list.forEach(function (fn) { try { fn(arg); } catch (err) { console.error(err); } }); }
  // Back unwinds one step, the way Control's Back does: a pane module may name the step above a
  // nested reader (an archive chat goes back to its day, not to the list).
  function goBack() {
    var r = parseRoute();
    var up = PANES[r.pane] && PANES[r.pane].up ? PANES[r.pane].up(r.args) : null;
    if (up) go(r.pane, up);
    else if (r.args.length) go(r.pane);
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
    var alreadyOpen = !$('auth-gate').classList.contains('hidden');
    $('app-shell').classList.add('hidden');
    $('auth-gate').classList.remove('hidden');
    // A later 401 from a pane still polling (W.api passes no message) must not blank what the gate already says:
    // the reason it opened, or "That code did not match" while the person retypes.
    if (!message && alreadyOpen) return;
    setStatus($('auth-error'), message || '', true);
    $('auth-error').classList.toggle('hidden', !message);
  }
  function showShell(info) {
    $('auth-gate').classList.add('hidden');
    $('app-shell').classList.remove('hidden');
    state.serverName = (info && info.serverName) || 'Your Mac';
    $('host-name').textContent = state.serverName.replace(/-/g, ' ');
    loadTailnetUrl();
    runHooks(shellHooks, info);
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
      loadTodayIntake();
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
    // Quiet hours (Control 0.5.361, and the rail's line): after 6 PM and at weekends what is
    // waiting can wait until tomorrow, so Today says so instead of "waiting on you".
    var nowD = new Date(), quiet = nowD.getDay() === 0 || nowD.getDay() === 6 || nowD.getHours() >= 18;
    var first = needs > 0
      ? (quiet ? countWord(needs) + ' ' + plural(needs, 'handoff', 'handoffs') + ' can wait until tomorrow'
        : countWord(needs) + ' ' + plural(needs, 'handoff is', 'handoffs are') + ' waiting on you')
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
  // From today's meetings: Work's suggestions from meetings held today. They stay here until
  // midnight, then join Sort in Work; Review opens them in Work's Sort.
  function localDay(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function loadTodayIntake() {
    var card = $('intake-card'); if (!card) return;
    api('/api/work-intake').then(function (d) {
      var today = localDay(new Date());
      var items = ((d && d.items) || []).filter(function (it) {
        if (['suggested', 'review', 'ask'].indexOf(it.status) < 0) return false;
        var day = String((it.meeting && (it.meeting.filename || it.meeting.date)) || '').match(/\d{4}-\d{2}-\d{2}/);
        return day && day[0] === today;
      });
      if (!items.length) { card.classList.add('hidden'); return; }
      var meetings = {};
      items.forEach(function (it) { var t = (it.meeting && it.meeting.title) || 'A meeting'; meetings[t] = (meetings[t] || 0) + 1; });
      $('intake-count').textContent = String(items.length);
      $('intake-body').innerHTML = Object.keys(meetings).slice(0, 4).map(function (t) {
        return '<div class="intake-row"><span class="intake-meeting">' + esc(t) + '</span><span class="intake-n">' + meetings[t] + '</span></div>';
      }).join('') + '<p class="intake-foot">Moves to Work at midnight.</p>';
      card.classList.remove('hidden');
    }, function () { card.classList.add('hidden'); });
  }
  function setBadge(name, on) { document.querySelectorAll('[data-badge="' + name + '"]').forEach(function (b) { b.classList.toggle('hidden', !on); }); }

  // ── Sessions ────────────────────────────────────────────
  // Control's Sessions pane (ActivityWindow.swift sessionsList 2288-2366, sessionRow 2773-2865,
  // sessionsStatus 2911-2933; Models.swift ClaudeSession 1762-2150): one flat list on a clock
  // (Updated, Opened, Pinned), the ON DISK / WAITING / PINNED strip, and per row the provider
  // badge, PINNED, the state chip, "Updated <time>" and, for twins, "Opened <date>". The pane holds
  // three views, Sessions | Usage | COS cost, as on the Mac. Data: GET /api/agent-sessions and
  // /api/agent-sessions/search. The Mac's own enrichment (Desktop titles, scheduled jobs, the
  // jobs-today list) has no server route, so it is not here.
  var SX_PREFS = 'cos_web_sessions';
  function sxPref(key, fallback, allowed) { var v = readStore(SX_PREFS)[key]; return allowed.indexOf(v) >= 0 ? v : fallback; }
  function sxSave() { writeStore(SX_PREFS, { clock: SX.clock, view: SX.view, recency: SX.recency }); }
  var SX = {
    rows: null, dropped: null, enabled: true, loading: false, error: '', loadedAt: 0,
    clock: sxPref('clock', 'updated', ['updated', 'opened', 'pinned']),
    view: sxPref('view', 'sessions', ['sessions', 'usage', 'cost']),
    recency: sxPref('recency', 'newest', ['newest', 'oldest', 'match']),
    q: '', instant: [], remote: [], searching: false, searchError: '', ranFor: '', semantic: null, semanticReason: '', searchSeq: 0, searchTimer: null,
    hooks: null, hooksAt: 0,
    usage: null, usageAt: 0, usageLoading: false, usageError: '',
    uPeriod: 'Last 30 days', uTool: 'All tools', uModel: 'All models'
  };
  var SX_VIEWS = { sessions: 'Sessions', usage: 'Usage', cost: 'COS cost' };

  function sxProvider(p) { return p === 'codex' || p === 'cursor' ? p : 'claude'; }
  function sxProviderLabel(p) { p = sxProvider(p); return p === 'codex' ? 'Codex' : p === 'cursor' ? 'Cursor' : 'Claude'; }
  // Each platform's own mark, the same SVGs COS Control draws (Resources/mark-claude.svg, mark-codex.svg,
  // mark-cursor.svg): Claude, OpenAI and Cursor. One filled path each, tinted by the tile's provider color.
  var SX_GLYPHS = {
    claude: '<path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/>',
    codex: '<path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/>',
    cursor: '<path d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"/>'
  };
  function sxGlyph(p) {
    p = sxProvider(p);
    return '<span class="sx-glyph ' + p + '" role="img" aria-label="' + (p === 'codex' ? 'ChatGPT' : sxProviderLabel(p)) + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + SX_GLYPHS[p] + '</svg></span>';
  }
  function sxBadge(p) { p = sxProvider(p); return '<span class="sx-badge ' + p + '">' + sxProviderLabel(p).toUpperCase() + '</span>'; }

  // ClaudeSession.title: the job label, else the name, else the workspace, else the id.
  function sxTitle(s) {
    var t = plain(s.display_label || s.custom_title || '').replace(/\s+/g, ' ').trim();
    return t || String(s.project || '').trim() || String(s.session_id || s.id || 'Session');
  }
  function sxWarmWords(t) { t = String(t || '').trim().toLowerCase(); return t === 'ready' || t.indexOf('this is an automated local readiness check') === 0; }
  // A warm-up is known by its first prompt, never by a title someone gave it (Models.swift isKeepWarm).
  function sxKeepWarm(s) { return sxWarmWords(s.display_label) && (!s.first_prompt || sxWarmWords(s.first_prompt)); }
  function sxTime(v) { var d = toDate(v); return d ? d.getTime() : 0; }
  function sxShortDate(d) {
    if (d.toDateString() === new Date().toDateString()) return clock(d);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // The row's state in Control's words (HelperSources/main.swift sessionStateFromServer and
  // claudePeerState): the server's derivation when the hooks or the registry back it; otherwise a
  // Claude row with no live process is stale, and the rest read from the server's own state.
  var SX_FROM_SERVER = { running: 'running', waiting: 'waiting', idle: 'recent', ended: 'stale', failed: 'error' };
  function sxState(s) {
    var a = s.agent_state || '', src = s.state_source || '';
    if ((src === 'hook' || src === 'registry') && SX_FROM_SERVER[a]) return SX_FROM_SERVER[a];
    if (sxProvider(s.provider) === 'claude' && !s.alive) return 'stale';
    if (a === 'waiting') return 'waiting';
    if (a === 'failed') return 'error';
    return s.running_active || a === 'running' ? 'running' : 'recent';
  }
  function sxNeedsPerson(s) { var st = sxState(s); return st === 'waiting' || st === 'error'; }
  // "Permission: Bash git push", "Question", "Plan approval", "Input".
  function sxWaitingKind(kind, detail) {
    detail = String(detail || '').trim();
    if (kind === 'permission') return detail ? 'Permission: ' + detail : 'Permission';
    if (kind === 'question') return 'Question';
    if (kind === 'plan') return 'Plan approval';
    if (kind === 'mcp_input') return 'Input';
    if (!kind) return detail;
    var cap = String(kind).charAt(0).toUpperCase() + String(kind).slice(1);
    return detail ? cap + ': ' + detail : cap;
  }
  function sxStateLabel(s, st) {
    var base = '';
    if (st === 'waiting') { var k = sxWaitingKind(s.waiting_kind, s.waiting_detail); base = k ? 'Waiting · ' + k : 'Waiting'; }
    else if (st === 'stale') base = 'Stale';
    else if (st === 'running') base = 'Running';
    else if (st === 'error') base = s.failure ? 'Failed · ' + String(s.failure).replace(/_/g, ' ') : 'Failed';
    var queued = Number(s.queued_turns) || 0;
    if (queued > 0) return base ? base + ' · ' + queued + ' queued' : queued + ' queued';
    return base;
  }

  function sxReal() { return (SX.rows || []).filter(function (s) { return !sxKeepWarm(s); }); }
  function byUpdated(a, b) { return sxTime(b.modified) - sxTime(a.modified); }
  // visibleSessions: Updated is every row by its last update; Opened is what is alive or was opened
  // in the last 7 days, newest first; Pinned is the pins.
  function sxVisible() {
    var real = sxReal();
    if (SX.clock === 'opened') {
      var week = Date.now() - 7 * 86400000;
      return real.filter(function (s) { if (s.alive) return true; var t = sxTime(s.created) || sxTime(s.modified); return t > 0 && t >= week; })
        .sort(function (a, b) { return sxTime(b.created) - sxTime(a.created); });
    }
    if (SX.clock === 'pinned') return real.filter(function (s) { return !!s.pinned; }).sort(byUpdated);
    return real.slice().sort(byUpdated);
  }
  // Two rows with one name are almost always a fork and its parent: those rows say when each opened.
  function sxAmbiguous(rows) {
    var seen = {}, dupes = {};
    rows.forEach(function (s) { var k = sxTitle(s); if (seen[k]) dupes[k] = true; else seen[k] = true; });
    return dupes;
  }
  function sxDropped() {
    var d = SX.dropped || {}, parts = [];
    var age = Math.max(0, Number(d.age) || 0), cap = Math.max(0, Number(d.limit) || 0), big = Math.max(0, Number(d.oversized) || 0);
    if (age) parts.push(age + ' older than 7 days');
    if (cap) parts.push(cap + ' over the cap');
    if (big) parts.push(big + ' too large');
    return { age: age, summary: parts.length ? parts.join(' · ') + ' not shown' : '' };
  }
  function sxQueryActive() { return SX.q.trim().length >= 2; }

  function sxDetailLine(vis) {
    if (sxQueryActive()) return SX.searching ? 'Looking up…' : 'Lookup across Claude, Codex, and Cursor';
    if (SX.loading) return vis.length ? 'Refreshing…' : 'Claude · Codex · Cursor · reading the last 7 days…';
    if (SX.error) return SX.error;
    if (!vis.length) return 'No sessions';
    if (SX.clock === 'opened') return 'Claude · Codex · Cursor · opened in last 7 days';
    if (SX.clock === 'pinned') return 'Claude · Codex · Cursor · pinned';
    var dropped = sxDropped().summary;
    return dropped ? 'Last 7 days · ' + dropped : 'Claude · Codex · Cursor · updated in last 7 days';
  }
  function sxStats(vis) {
    if (!vis.length && SX.loading && !sxQueryActive()) return [['–', 'ON DISK'], ['–', 'WAITING'], ['–', 'PINNED']];
    if (!vis.length) return [];
    return [[vis.length, 'ON DISK'], [vis.filter(sxNeedsPerson).length, 'WAITING'], [vis.filter(function (s) { return !!s.pinned; }).length, 'PINNED']];
  }
  function sxEmptyCopy() {
    if (SX.clock === 'opened') return 'No sessions opened in the last 7 days. Pins are under Pinned.';
    if (SX.clock === 'pinned') return 'No pinned sessions. Star Claude Desktop chats, pin Cursor chats, or pin Codex/ChatGPT threads to see them here.';
    var d = sxDropped();
    if (d.summary && d.age > 0) return 'No sessions updated on this Mac in the last 7 days. ' + d.summary.replace(/ not shown$/, '') + '. Search to find them.';
    return 'No Claude, Codex, or Cursor sessions updated on this Mac in the last 7 days.';
  }
  function sxEmpty(text) { return '<div class="cx-list"><p class="cx-empty">' + esc(text) + '</p></div>'; }

  // The hero, the view switch and the clock: painted on every change so the counts never lag the list.
  function paintSessionsHero() {
    var hero = $('sessions-hero'), views = $('sessions-views');
    if (!hero || !views) return;
    var view = SX.view, vis = SX.rows ? sxVisible() : [];
    var detail = view === 'cost' ? 'What COS itself used, on top of your sessions' : view === 'usage' ? 'Token usage and estimated API value' : sxDetailLine(vis);
    var stats = view === 'sessions' ? sxStats(vis) : [];
    var busy = view === 'sessions' ? SX.loading : SX.usageLoading;
    hero.innerHTML = '<span class="cx-glyph"><svg class="icon"><use href="#i-sessions"/></svg></span>' +
      '<div class="cx-hero-text"><h1 class="cx-title">Sessions</h1><p class="cx-detail-line">' + esc(detail) + '</p></div>' +
      '<div class="cx-actions"><button type="button" class="cx-btn quiet" data-sx="refresh"' + (busy ? ' disabled' : '') + '><svg class="icon"><use href="#i-refresh"/></svg>Refresh</button></div>' +
      (stats.length ? '<div class="cx-stats">' + stats.map(function (s) { return '<span class="cx-stat"><b>' + esc(typeof s[0] === 'number' ? s[0].toLocaleString() : s[0]) + '</b><span>' + s[1] + '</span></span>'; }).join('') + '</div>' : '');
    var clockOn = view === 'sessions' && !sxQueryActive();
    views.innerHTML = '<div class="cx-switch" role="group" aria-label="Sessions view">' +
        Object.keys(SX_VIEWS).map(function (v) { return '<button type="button" data-sx="view" data-view="' + v + '" aria-pressed="' + (v === view) + '">' + SX_VIEWS[v] + '</button>'; }).join('') +
      '</div>' +
      (clockOn ? '<div class="cx-switch sx-clock" role="group" aria-label="Clock">' +
        [['updated', 'Updated'], ['opened', 'Opened'], ['pinned', 'Pinned']].map(function (c) { return '<button type="button" data-sx="clock" data-clock="' + c[0] + '" aria-pressed="' + (c[0] === SX.clock) + '">' + c[1] + '</button>'; }).join('') +
      '</div>' : '');
    var split = $('sessions-split'), usage = $('sessions-usage');
    if (split) split.classList.toggle('hidden', view !== 'sessions');
    if (usage) usage.classList.toggle('hidden', view === 'sessions');
  }

  function loadSessions(force) {
    var r = parseRoute();
    var reading = r.pane === 'sessions' && r.args.length === 2;
    if (reading) SX.view = 'sessions';
    else if (r.pane === 'sessions') window.COSWeb.setCrumb(SX.view === 'sessions' ? '' : SX_VIEWS[SX.view]);
    paintSessionsHero();
    if (SX.view !== 'sessions') { renderUsageView(force === true); return Promise.resolve(); }
    loadSessionHooks();
    if (force !== true && SX.rows && Date.now() - SX.loadedAt < 15000) { renderSessionGroups(); return Promise.resolve(); }
    SX.loading = true;
    renderSessionGroups();
    return api('/api/agent-sessions?limit=80&sort=updated').then(function (d) {
      SX.rows = (d && d.sessions) || [];
      SX.dropped = (d && d.dropped) || null;
      SX.enabled = !(d && d.enabled === false);
      SX.loading = false; SX.error = ''; SX.loadedAt = Date.now();
      state.sessions = SX.rows;
      if (sxQueryActive()) SX.instant = sxInstant(SX.q);
      renderSessionGroups();
    }).catch(function (err) {
      SX.loading = false;
      SX.error = (err && err.message) || 'Sessions did not load';
      renderSessionGroups();
    });
  }
  // The project most sessions share says nothing; name it only when a session differs (Today's rows).
  function usualProject() {
    var counts = {}, best = '', n = 0;
    state.sessions.forEach(function (s) { if (!s.project) return; counts[s.project] = (counts[s.project] || 0) + 1; if (counts[s.project] > n) { n = counts[s.project]; best = s.project; } });
    return best;
  }
  // The Ask sheet's compact row (⌘K recents and hits).
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
  // Control's row: glyph, title, a snippet on search hits, then badge · PINNED · state · Updated ·
  // Opened (twins only, amber) · workspace; a match chip and a chevron on the right.
  function sxRow(s, hit, ambiguous) {
    var key = splitSessionId(s.provider, s.session_id || s.id);
    var r = parseRoute();
    var selected = r.pane === 'sessions' && r.args[0] === key.provider && r.args[1] === key.id;
    var st = sxState(s), label = sxStateLabel(s, st), title = sxTitle(s);
    var upd = toDate(s.modified), opened = toDate(s.created);
    var meta = sxBadge(key.provider) +
      (s.pinned ? '<span class="sx-pinned">PINNED</span>' : '') +
      (label ? '<span class="sx-chip ' + st + '">' + esc(label) + '</span>' : '') +
      (upd ? '<span class="sx-when">Updated ' + esc(sxShortDate(upd)) + '</span>' : '') +
      (ambiguous[title] && opened ? '<span class="sx-opened" title="Another session on screen has the same name. This one was opened ' + esc(sxShortDate(opened)) + '.">Opened ' + esc(sxShortDate(opened)) + '</span>' : '') +
      (s.project && String(s.project) !== title ? '<span class="sx-ws">' + esc(s.project) + '</span>' : '');
    var match = hit ? (hit.match === 'both' ? 'Keyword + meaning' : hit.match === 'semantic' ? 'Meaning' : 'Keyword') : '';
    // An instant title hit's snippet is the title itself; it says nothing twice.
    var snippet = hit && hit.snippet ? plain(hit.snippet).replace(/\s+/g, ' ').trim() : '';
    return '<button type="button" class="cx-row sx-row" data-session="' + esc(key.provider) + '|' + esc(key.id) + '"' + (selected ? ' aria-selected="true"' : '') + '>' +
      sxGlyph(key.provider) +
      '<span class="cx-row-body"><span class="sx-title">' + esc(title) + '</span>' +
      (snippet && snippet !== title ? '<span class="sx-snippet">' + esc(snippet) + '</span>' : '') +
      '<span class="sx-meta">' + meta + '</span></span>' +
      '<span class="sx-side">' + (match ? '<span class="sx-match">' + match + '</span>' : '') + '<span class="chev"></span></span></button>';
  }
  function sxListHtml() {
    if (!SX.rows) return SX.error ? sxEmpty(SX.error) : skeletonRows(6);
    if (!SX.enabled && !SX.rows.length) return sxEmpty('AI sessions are off. Turn on Show AI sessions in Settings, Work and agents.');
    var vis = sxVisible();
    if (!vis.length) return sxEmpty(SX.error || sxEmptyCopy());
    var amb = sxAmbiguous(vis);
    return '<div class="cx-list sx-list">' + vis.map(function (s) { return sxRow(s, null, amb); }).join('') + '</div>';
  }
  // The list, under the hero. The name stays: the shared input handler calls it when the search clears.
  function renderSessionGroups() {
    var input = $('sessions-q');
    var q = input ? input.value.trim() : '';
    if (q.length < 2 && SX.q) { SX.q = ''; SX.instant = []; SX.remote = []; SX.ranFor = ''; SX.searchError = ''; SX.semantic = null; SX.searching = false; }
    paintSessionsHero();
    paintHooks();
    var clear = $('sessions-clear'); if (clear) clear.classList.toggle('hidden', !(input && input.value));
    var hint = $('sessions-hint');
    if (hint) {
      var note = sxQueryActive() && SX.ranFor === SX.q && SX.semantic === false ? sxSemanticHint(SX.semanticReason) : '';
      hint.textContent = note; hint.classList.toggle('hidden', !note);
    }
    var list = $('sessions-list'); if (!list) return;
    list.innerHTML = sxQueryActive() ? sxSearchHtml() : sxListHtml();
  }

  // Search (ActivityWindow.swift sessionsSearchBar 2652-2712, ControllerModel scheduleSessionSearch):
  // instant title hits from the loaded list, then the server's keyword and meaning hits, one row
  // per session, ordered by the Recency choice.
  var SX_STOP = ['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'at', 'by', 'with', 'from', 'vs', 'is', 'it', 'be', 'as', 'we', 'our'];
  function sxTokens(q) {
    var seen = {}, out = [];
    String(q).toLowerCase().split(/[^\p{L}\p{N}]+/u).forEach(function (t) { if (t.length >= 2 && SX_STOP.indexOf(t) < 0 && !seen[t]) { seen[t] = true; out.push(t); } });
    return out;
  }
  function sxScore(tokens, title, hay) {
    if (!tokens.length) return 0;
    var tl = title.toLowerCase(), hl = hay.toLowerCase(), hits = 0, inTitle = 0;
    tokens.forEach(function (t) { var a = tl.indexOf(t) >= 0, b = hl.indexOf(t) >= 0; if (!a && !b) return; hits += 1; if (a) inTitle += 1; });
    if (!hits) return 0;
    var coverage = hits / tokens.length;
    if (coverage < 0.5 && !inTitle) return 0;
    return Math.min(1, coverage * 0.65 + (inTitle / tokens.length) * 0.35);
  }
  function sxInstant(q) {
    var tokens = sxTokens(q);
    if (!tokens.length) return [];
    return sxReal().map(function (s) {
      var t = sxTitle(s), v = sxScore(tokens, t, [s.display_label || '', s.project || '', t].join('\n'));
      return v > 0 ? { s: s, snippet: t, match: 'keyword', score: v } : null;
    }).filter(Boolean).sort(function (a, b) { return b.score - a.score; }).slice(0, 20);
  }
  function sxKey(s) { var k = splitSessionId(s.provider, s.session_id || s.id); return k.provider + ':' + k.id.toLowerCase(); }
  // One session whether the id is whole or the list's 8-character prefix (ClaudeSession.sameSession).
  function sxSame(a, b) {
    if (a === b) return true;
    var x = a.split(':'), y = b.split(':');
    if (x[0] !== y[0] || !x[1] || !y[1]) return false;
    var short = x[1].length <= y[1].length ? x[1] : y[1], long = short === x[1] ? y[1] : x[1];
    return short.length >= 8 && long.indexOf(short) === 0;
  }
  function sxHits() {
    var out = [];
    SX.instant.concat(SX.remote).forEach(function (h) {
      var k = sxKey(h.s);
      for (var i = 0; i < out.length; i++) if (sxSame(sxKey(out[i].s), k)) { if (out[i].score < h.score) out[i] = h; return; }
      out.push(h);
    });
    var date = function (h) { return sxTime(h.s.modified) || sxTime(h.s.created); };
    return out.sort(function (a, b) {
      if (SX.recency === 'match') return (b.score - a.score) || (date(b) - date(a));
      if (SX.recency === 'oldest') return ((date(a) || Infinity) - (date(b) || Infinity)) || (b.score - a.score);
      return (date(b) - date(a)) || (b.score - a.score);
    });
  }
  // A hit names the session as the search found it; the list's own row carries the live state.
  function sxListed(s) {
    var k = sxKey(s);
    var row = (SX.rows || []).filter(function (x) { return sxSame(sxKey(x), k); })[0];
    return row || s;
  }
  function sxSearchHtml() {
    var hits = sxHits();
    if (!hits.length) {
      if (SX.searching) return '<p class="cx-note sx-looking">Looking up…</p>';
      if (SX.searchError) return sxEmpty(SX.searchError);
      return sxEmpty('No sessions match that lookup.');
    }
    var rows = hits.map(function (h) { return { s: sxListed(h.s), h: h }; });
    var amb = sxAmbiguous(sxVisible().concat(rows.map(function (x) { return x.s; })));
    return '<div class="cx-list sx-list">' + rows.map(function (x) { return sxRow(x.s, x.h, amb); }).join('') + '</div>';
  }
  // The words Control shows when meaning search is not available (em dashes made periods).
  function sxSemanticHint(reason) {
    reason = String(reason || '');
    if (reason.indexOf('server_error_') === 0) return 'Keyword only. The server returned ' + reason.slice('server_error_'.length);
    if (reason === 'server_too_old') return 'Keyword only. Meaning search needs a server update';
    if (reason === 'server_unreachable') return 'Keyword only. The server did not answer in time';
    if (reason === 'no_server_token') return 'Keyword only. No server token available';
    if (reason === 'no_session_embeddings' || reason === 'embeddings_unreachable') return 'Keyword only. Meaning search needs an OpenAI key';
    return 'Keyword only. Meaning search is unavailable';
  }
  function searchSessions() {
    var input = $('sessions-q');
    var q = input ? input.value.trim() : '';
    clearTimeout(SX.searchTimer);
    SX.q = q;
    if (q.length < 2) { renderSessionGroups(); return; }
    if (q !== SX.ranFor) SX.remote = [];
    SX.instant = sxInstant(q);
    SX.searchError = '';
    SX.searching = true;
    var mine = ++SX.searchSeq;
    renderSessionGroups();
    api('/api/agent-sessions/search?q=' + encodeURIComponent(q) + '&limit=20').then(function (d) {
      if (mine !== SX.searchSeq) return;
      SX.remote = ((d && d.hits) || []).map(function (h) {
        return { s: h, snippet: h.snippet || '', match: h.match || 'keyword', score: Number(h.score) || Math.max(Number(h.keywordScore) || 0, Number(h.semanticScore) || 0) };
      });
      SX.semantic = !!(d && d.semanticAvailable === true);
      SX.semanticReason = (d && d.semanticReason) || '';
      SX.searching = false; SX.ranFor = q;
      renderSessionGroups();
    }, function (err) {
      if (mine !== SX.searchSeq) return;
      SX.searching = false; SX.ranFor = q; SX.remote = [];
      if (!SX.instant.length) SX.searchError = (err && err.message) || 'The lookup failed.';
      renderSessionGroups();
    });
  }
  // The meaning finder the Ask sheet offers ("Find a session about this").
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

  // The hooks banner (ActivityWindow.swift 2867-2905). Installing hooks writes to the Mac's Claude
  // settings, which stays a Mac action, so the web names where to do it.
  function loadSessionHooks() {
    if (Date.now() - SX.hooksAt < 60000) { paintHooks(); return; }
    SX.hooksAt = Date.now();
    api('/api/session-hooks/status').then(function (d) {
      SX.hooks = (d && d.sessionHooks && d.sessionHooks.state) || null; paintHooks();
    }, function (err) { SX.hooks = err && err.status === 404 ? 'route_absent' : null; paintHooks(); });
  }
  function paintHooks() {
    var el = $('sessions-hooks'); if (!el) return;
    var st = SX.hooks;
    if (['missing', 'drift', 'script_outdated', 'route_absent'].indexOf(st) < 0) { el.innerHTML = ''; return; }
    var text = st === 'route_absent' ? 'Live session state needs COS server 6.48.0 or later.'
      : st === 'missing' ? 'Claude Code hooks are not installed: sessions read from their transcripts only.'
      : 'Claude Code hooks need a refresh (' + (st === 'drift' ? 'settings changed' : 'script outdated') + ').';
    var where = st === 'route_absent' ? 'Update Server from COS Control on your Mac.' : (st === 'missing' ? 'Install hooks' : 'Reinstall hooks') + ' from COS Control on your Mac.';
    el.innerHTML = '<div class="sx-hooks"><span class="sx-hooks-dot" aria-hidden="true"></span><span>' + esc(text) + ' <span class="sx-hooks-where">' + esc(where) + '</span></span></div>';
  }

  // The view switch: Sessions | Usage | COS cost. A reader belongs to Sessions, so another view
  // closes it; the route repaints the pane and names the view in the breadcrumb.
  function setSessionsView(v) {
    if (!SX_VIEWS[v] || v === SX.view) return;
    SX.view = v; sxSave();
    go('sessions');
  }

  // Pane-level events for this pane's own controls (data-sx). Sends, Stop, Fork and the queue
  // keep their data-action names, which the shared listener handles.
  var sxPane = $('pane-sessions');
  if (sxPane) {
    if ($('sessions-recency')) $('sessions-recency').value = SX.recency;
    sxPane.addEventListener('click', function (e) {
      var t = e.target.closest('[data-sx]');
      if (!t || !sxPane.contains(t)) return;
      var act = t.getAttribute('data-sx'), rd = state.reading;
      if (act === 'view') return setSessionsView(t.getAttribute('data-view'));
      if (act === 'clock') { SX.clock = t.getAttribute('data-clock'); sxSave(); return renderSessionGroups(); }
      if (act === 'refresh') {
        if (SX.view !== 'sessions') return renderUsageView(true);
        SX.hooksAt = 0;
        loadSessions(true);
        if (sxQueryActive()) searchSessions();
        return;
      }
      if (act === 'clear') { var input = $('sessions-q'); input.value = ''; searchSessions(); input.focus(); return; }
      if (act === 'copy-session') return copySessionBrief();
      if (act === 'refresh-turns' && rd) { rd.refusal = null; renderVerdict(rd); refreshTurns(rd.provider, rd.id); return; }
      if (act === 'retry' && rd) { rd.refusal = null; renderVerdict(rd); return sendSessionTurn(!!rd.retryFork); }
      if (act === 'caution-send' && rd) { rd.cautionAck = true; rd.cautionAsk = false; renderVerdict(rd); return sendSessionTurn(false); }
      if (act === 'caution-cancel' && rd) { rd.cautionAsk = false; renderVerdict(rd); return; }
      if (act === 'usage-clear') { SX.uTool = 'All tools'; SX.uModel = 'All models'; return paintUsage(); }
    });
    sxPane.addEventListener('input', function (e) {
      if (e.target.id !== 'sessions-q') return;
      clearTimeout(SX.searchTimer);
      if (e.target.value.trim().length < 2) { searchSessions(); return; }
      // The last answer belonged to other words: until this one lands, the instant title hits stand alone.
      SX.q = e.target.value.trim();
      if (SX.q !== SX.ranFor) { SX.remote = []; SX.searching = true; }
      SX.instant = sxInstant(SX.q);
      renderSessionGroups();
      SX.searchTimer = setTimeout(searchSessions, 350);
    });
    sxPane.addEventListener('change', function (e) {
      var id = e.target.id;
      if (id === 'sessions-recency') { SX.recency = e.target.value; sxSave(); return renderSessionGroups(); }
      if (id === 'usage-period') { SX.uPeriod = e.target.value; return paintUsage(); }
      if (id === 'usage-tool') { SX.uTool = e.target.value; SX.uModel = 'All models'; return paintUsage(); }
      if (id === 'usage-model') { SX.uModel = e.target.value; return paintUsage(); }
    });
  }

  // ── Sessions: read, send, queue, fork, stop (the glasses' Continue, from a browser) ──
  // The server owns every safety rule (agent-session-bindings.ts): COS writes into a desktop
  // thread only through a binding, attaches only when no live process owns the thread, and
  // re-checks before delivery. This page follows the same order the glasses do:
  //   attach (or reuse this tab's binding) -> send the turn under ONE key per draft ->
  //   if the session is busy, park it in the session's queue -> watch the live stream.
  // A refusal is an answer with the server's own words, never an error to retry blindly. The
  // draft key is reused on a resend, so a retry after a lost answer can never post twice.
  // One id for the life of the page, read once. Without storage (a private window) the old code made
  // a new id on every call, so one page sent different ids to /attach, /queued-turns and /fork.
  var WEB_SESSION_KEY = 'cos_web_sid';
  var webSessionId = null;
  function cosSessionId() {
    if (webSessionId) return webSessionId;
    var stored = null;
    try { stored = localStorage.getItem(WEB_SESSION_KEY); } catch (_e) { stored = null; }
    if (stored && /^web-[a-z0-9]{8,24}$/.test(stored)) return (webSessionId = stored);
    webSessionId = 'web-' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
    try { localStorage.setItem(WEB_SESSION_KEY, webSessionId); } catch (_e) {}
    return webSessionId;
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

  // The server serves at most 40 turns (lib/agent-session-turns.ts SESSION_TURNS_MAX), each
  // shaped to 4,000 characters. Control reads up to 120 from the Mac's own files.
  var SX_TURNS = 40;
  // Control's detail subtitle (Models.swift ClaudeSessionDetail.subtitle).
  function sxSubtitle(d, provider, turns, more) {
    var parts = [sxProviderLabel(d.provider || provider)];
    if (d.project) parts.push(String(d.project).replace(/^-Users-[^-]+-/, ''));
    if (d.git_branch && d.git_branch !== 'unknown') parts.push(String(d.git_branch));
    var total = Number(d.message_count) || 0;
    if (more) parts.push(total > turns.length && !d.truncated ? 'last ' + turns.length + ' of ' + total + ' turns' : 'last ' + turns.length + ' turns');
    else parts.push(turns.length + (turns.length === 1 ? ' turn' : ' turns'));
    if (Number(d.omitted_tools) > 0) parts.push('tools omitted');
    if (d.truncated) parts.push('large session · earlier turns skipped');
    return parts.join(' · ');
  }
  function sxTruncNote(d, turns, more) {
    if (!more) return '';
    var total = Number(d.message_count) || 0;
    return 'Showing the last ' + turns.length + (total > turns.length && !d.truncated ? ' of ' + total : '') + ' turns. Copy session keeps the original request plus the newest context.';
  }

  function openSession(provider, id) {
    var reader = $('session-reader');
    if (!provider || !id) return;
    if (state.stream) { state.stream.close(); state.stream = null; }
    clearInterval(state.turnPoll);
    if (state.reading) { clearInterval(state.reading.heldTimer); clearInterval(state.reading.feedTimer); }
    var held = (readStore(HELD_KEY)[provider + '|' + id] || []).filter(function (h) { return h && typeof h.text === 'string' && typeof h.key === 'string'; });
    var r = state.reading = { provider: provider, id: id, draft: null, live: null, held: held, flushing: null, feed: newFeed(), verdict: null, cautionAck: false, cautionAsk: false, refusal: null, detail: null, turns: [], more: false, queued: 0 };
    if (SX.view !== 'sessions') { SX.view = 'sessions'; sxSave(); paintSessionsHero(); }
    document.querySelectorAll('#sessions-list [data-session]').forEach(function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-session') === provider + '|' + id)); });
    var listed = (SX.rows || []).filter(function (s) { return sxSame(sxKey(s), provider + ':' + String(id).toLowerCase()); })[0];
    if (listed) window.COSWeb.setCrumb(sxTitle(listed));
    reader.innerHTML = '<div class="sx-reader-head"><div class="skeleton" style="height:26px;width:70%;margin:6px 0 10px"></div><div class="skeleton" style="width:45%"></div></div>' + skeletonRows(3);
    api(sessionPath(provider, id, '?turns=' + SX_TURNS)).then(function (d) {
      if (state.reading !== r) return;
      var turns = Array.isArray(d && d.recent_turns) ? d.recent_turns : ((d && d.recent_turns && d.recent_turns.turns) || (d && d.turns) || []);
      r.detail = d; r.turns = turns; r.more = d.recent_turns_more === true;
      r.queued = Number(d.queued_turns) || 0;
      var title = sxTitle(d);
      window.COSWeb.setCrumb(title);
      var trunc = sxTruncNote(d, turns, r.more);
      reader.innerHTML =
        '<div class="sx-reader-head"><div class="sx-head-line">' + sxBadge(provider) + '<h2 class="sx-reader-title">' + esc(title) + '</h2></div>' +
          '<p class="sx-subtitle">' + esc(sxSubtitle(d, provider, turns, r.more)) + '</p></div>' +
        '<div class="sx-activity" id="session-live" aria-live="polite"></div>' +
        (trunc ? '<p class="sx-note">' + esc(trunc) + '</p>' : '') +
        '<div class="turns sx-turns" id="session-turns">' + renderTurns(turns, d) + '</div>' +
        '<div class="sx-foot"><button type="button" class="cx-btn quiet" data-sx="copy-session" title="A kickstart brief for another agent, built from the turns COS serves. Not a Claude Code resume: it does not reopen this session.">Copy session</button>' +
          '<span class="sx-foot-note">Kickstart brief for another agent. Not a Claude Code resume.</span></div>' +
        '<p class="sx-copy-note hidden" id="session-copy-note" role="status"></p>' +
        '<div class="sx-chat">' +
          '<div id="session-verdict"></div>' +
          '<form class="composer" id="session-form" data-provider="' + esc(provider) + '" data-id="' + esc(id) + '">' +
            '<textarea id="session-input" rows="1" placeholder="Continue this session…" enterkeyhint="send" aria-label="Continue this session"></textarea>' +
            '<div class="composer-actions"><button type="button" class="btn small" data-action="fork-session" title="Copy this session and send the message to the copy">Fork</button>' +
            '<button type="submit" class="btn primary small">Send</button></div>' +
          '</form><div class="status-line" id="session-status"></div>' +
          '<p class="sx-caution hidden" id="session-caution"></p>' +
          '<div id="session-queue"></div>' +
        '</div>';
      setLive({ working: !!d.running_active });
      renderHeld(state.reading);
      loadQueue(provider, id);
      sxProbeAttach(r);
      if (state.reading.held.length) {
        sessionStatus('Waiting for the current reply. ' + (state.reading.held.length > 1 ? state.reading.held.length + ' messages send' : 'Yours sends') + ' as soon as it finishes. ', null, '<button type="button" class="link-btn" data-action="drop-after">Don’t send</button>');
        startHeldTimer(state.reading);
      }
      if (turns.length) requestAnimationFrame(function () { window.scrollTo(0, document.documentElement.scrollHeight); });
      watchSession(provider, id);
    }).catch(function (err) {
      if (state.reading !== r) return;
      reader.innerHTML = sxEmpty((err && err.message) || 'This session did not open.') + '<p class="sx-retry"><button type="button" class="cx-btn quiet" data-session="' + esc(provider) + '|' + esc(id) + '">Retry</button></p>';
    });
  }

  // ACTIVITY (ActivityWindow.swift SessionActivityFeed 6800-6890, SessionLiveFeed.swift): the state
  // word with its clock, the current prompt, the last eight tool lines, and the honest counters.
  // The reducer follows SessionLiveFeed.applying: a reseed (seq 1 after anything) starts over.
  function newFeed() { return { transport: 'idle', agentState: null, stateSince: null, waitingKind: null, waitingDetail: null, failure: null, lastReply: null, prompt: '', tools: [], lastSeq: 0, lastEventAt: null, missed: 0, connected: false, fallback: null }; }
  function applyFeed(r, e) {
    if (typeof e.seq !== 'number') return;
    var f = r.feed;
    if (e.seq === 1 && f.lastSeq > 0) { var keep = f.connected; f = r.feed = newFeed(); f.connected = keep; }
    else if (f.lastSeq > 0 && e.seq > f.lastSeq + 1) f.missed += e.seq - f.lastSeq - 1;
    f.lastSeq = e.seq;
    f.lastEventAt = typeof e.at === 'number' ? new Date(e.at) : new Date();
    f.connected = true;
    if (f.fallback === 'reconnecting') f.fallback = null;
    if (e.kind === 'status') {
      if (e.state) f.transport = e.state;
      if (e.agent_state) {
        f.agentState = e.agent_state; f.stateSince = toDate(e.state_since);
        f.waitingKind = e.waiting_kind || null; f.waitingDetail = e.waiting_detail || null; f.failure = e.failure || null;
        if (e.last_reply) f.lastReply = e.last_reply;
      }
    } else if (e.kind === 'prompt') {
      f.prompt = String(e.text || ''); f.tools = [];
    } else if (e.kind === 'tool') {
      f.tools.push({ seq: e.seq, verb: e.verb || 'tool', target: e.target || '' });
      if (f.tools.length > 8) f.tools.splice(0, f.tools.length - 8);
    }
  }
  var SX_VERBS = { read: 'Read', edit: 'Edited', write: 'Edited', bash: 'Ran', run: 'Ran', search: 'Searched', grep: 'Searched', glob: 'Searched', fetch: 'Fetched', web: 'Fetched', agent: 'Delegated', task: 'Delegated' };
  function sxToolLine(t) { var v = String(t.verb || 'tool'); var w = SX_VERBS[v] || v.charAt(0).toUpperCase() + v.slice(1); return t.target ? w + ' ' + t.target : w; }
  // The word follows the page's own working flag, which a Stop or a finished turn settles before
  // the stream's status catches up; otherwise the server's derived state, as Control reads it.
  function sxFeedWord(r) {
    var f = r.feed;
    if (r.live && r.live.working) return 'Working';
    var s = f.agentState || f.transport;
    if (s === 'waiting') return 'Waiting';
    if (s === 'failed') return 'Failed';
    if (s === 'ended' || s === 'done') return 'Done';
    return 'Idle';
  }
  function sxFeedDetail(f, word) {
    if (word === 'Waiting' && f.agentState === 'waiting') {
      var d = String(f.waitingDetail || '').trim();
      if (f.waitingKind === 'permission') return d ? 'Permission: ' + d : 'Permission';
      if (f.waitingKind === 'question') return 'Question';
      if (f.waitingKind === 'plan') return 'Plan approval';
      if (f.waitingKind === 'mcp_input') return 'Input';
      return d;
    }
    if (word === 'Failed' && f.agentState === 'failed') return String(f.failure || '').replace(/_/g, ' ');
    if (word === 'Idle' && f.agentState === 'idle') { var reply = String(f.lastReply || '').trim(); return reply ? 'last reply: ' + reply : ''; }
    return '';
  }
  function sxElapsed(f) {
    var since = f.stateSince || f.lastEventAt;
    if (!since) return '';
    var s = Math.max(0, Math.floor((Date.now() - since.getTime()) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  }
  function sxFallbackLine(reason) {
    if (reason === 'http_404') return 'No live feed for this session (no transcript to follow); showing the stored turns.';
    if (reason === 'http_503') return 'The server has no room for another live feed right now; showing the stored turns.';
    if (reason === 'reconnecting') return 'Reconnecting to the live feed…';
    if (reason === 'stream_lost') return 'The live feed stopped answering; showing the stored turns. Reopen the session to try again.';
    return 'Live feed unavailable (' + reason + '); showing the stored turns.';
  }
  // The block keeps one size whatever it holds (/qa: the turns below moved while Miles read, as tool
  // lines and prose came and went): a label row with the counters, a state row with the clock and
  // Stop, one prompt line, and a tail of the newest tool lines and reply text, fixed in height and
  // anchored to its bottom, so the newest line shows and older lines slide out of view above it.
  function paintActivity(r) {
    var box = $('session-live');
    if (!box || state.reading !== r) return;
    var f = r.feed, live = r.live || {};
    var on = f.connected || f.lastSeq > 0 || live.working;
    var bits = [];
    if (on && f.missed > 0) bits.push('<span class="warn">missed ' + f.missed + '</span>');
    if (on && r.queued > 0) bits.push('<span class="accent">' + (r.queued === 1 ? '1 queued' : r.queued + ' queued') + '</span>');
    if (on && f.fallback === 'reconnecting') bits.push('<span>reconnecting…</span>');
    var html = '<div class="sx-act-label"><span>ACTIVITY</span>' + (bits.length ? '<span class="sx-act-bits">' + bits.join('') + '</span>' : '') + '</div>';
    if (on) {
      var word = sxFeedWord(r), detail = sxFeedDetail(f, word);
      html += '<div class="sx-act-state"><span class="sx-dot ' + word.toLowerCase() + '" aria-hidden="true"></span><strong>' + word + '</strong>' +
        '<span class="sx-act-detail">' + esc(detail) + '</span>' +
        '<span class="sx-act-clock" id="session-elapsed">' + esc(sxElapsed(f)) + '</span>' +
        (live.working ? '<button type="button" class="cx-btn quiet sx-act-stop" data-action="stop-session">Stop</button>' : '') + '</div>' +
        '<p class="sx-act-prompt">' + esc(f.prompt) + '</p>' +
        '<div class="sx-act-tail">' + f.tools.map(function (t) { return '<div class="sx-act-tool">' + esc(sxToolLine(t)) + '</div>'; }).join('') +
          (live.working && live.prose ? '<div class="sx-act-prose">' + esc(String(live.prose).slice(-600)) + '</div>' : '') + '</div>';
    } else {
      html += '<p class="sx-act-fallback">' + esc(f.fallback ? sxFallbackLine(f.fallback) : 'Connecting to the live feed…') + '</p>';
    }
    box.innerHTML = html;
    // The clock ticks only while the session works or waits (Control 0.5.337).
    clearInterval(r.feedTimer); r.feedTimer = null;
    var w = sxFeedWord(r);
    if ((f.connected || f.lastSeq > 0) && (w === 'Working' || w === 'Waiting')) {
      r.feedTimer = setInterval(function () {
        if (state.reading !== r) { clearInterval(r.feedTimer); return; }
        var el = $('session-elapsed'); if (el) el.textContent = sxElapsed(r.feed);
      }, 1000);
    }
  }
  // EventSource hides the status of a refused stream, so one GET reads it for the fallback line.
  function sxProbeStream(provider, id, r) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    fetch(sessionPath(provider, id, '/stream?seed=turn'), { headers: { 'X-COS-Web': '1' }, credentials: 'same-origin', signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) { var code = res.status; if (ctrl) ctrl.abort(); return code; }, function () { return 0; })
      .then(function (code) {
        if (state.reading !== r || r.feed.lastSeq > 0) return;
        r.feed.fallback = code === 200 ? 'stream_lost' : code ? 'http_' + code : 'unreachable';
        paintActivity(r);
      });
  }

  // The live stream: one JSON object per data line, `kind` = status | prompt | tool | prose | heartbeat.
  function watchSession(provider, id) {
    var r0 = state.reading;
    if (typeof EventSource !== 'function') { if (r0) { r0.feed.fallback = 'unsupported'; paintActivity(r0); } return; }
    var es;
    try { es = new EventSource(sessionPath(provider, id, '/stream?seed=turn')); } catch (_e) { if (r0) { r0.feed.fallback = 'unsupported'; paintActivity(r0); } return; }
    state.stream = es;
    var wasWorking = false;
    es.onerror = function () {
      var r = state.reading;
      if (!r || r.id !== id || state.stream !== es) return;
      if (es.readyState === 2) {
        if (r.feed.lastSeq > 0) { r.feed.connected = false; r.feed.fallback = 'stream_lost'; paintActivity(r); }
        else sxProbeStream(provider, id, r);
      } else { r.feed.fallback = 'reconnecting'; paintActivity(r); }
    };
    es.onmessage = function (ev) {
      var e; try { e = JSON.parse(ev.data); } catch (_e) { return; }
      var r = state.reading;
      if (!r || r.id !== id) return;
      applyFeed(r, e);
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
      } else if (e.kind === 'prompt') {
        paintActivity(r);
      }
    };
  }
  function setLive(patch) {
    var r = state.reading; if (!r) return;
    r.live = Object.assign(r.live || {}, patch);
    if (!r.live.working) { r.live.step = null; r.live.prose = null; }
    paintActivity(r);
  }
  function refreshTurns(provider, id) {
    api(sessionPath(provider, id, '?turns=' + SX_TURNS)).then(function (d) {
      var r = state.reading;
      if (!r || r.id !== id) return;
      var turns = Array.isArray(d && d.recent_turns) ? d.recent_turns : [];
      var box = $('session-turns'); if (box) sxMergeTurns(box, r.turns || [], turns, d);
      // The header keeps the subtitle it opened with: a rewrap above the turns would move them.
      r.detail = d; r.turns = turns; r.more = d.recent_turns_more === true;
      renderHeld(r);
      loadQueue(provider, id);
      sxProbeAttach(r);
    }).catch(function () {});
  }
  // Control's queue line for a parked turn (Models.swift 1655): Next, 2nd in line, 3rd in line.
  function sxQueueLine(t) {
    var p = Number(t.position);
    if (!(p >= 0)) return 'Waiting';
    if (p === 0) return 'Next';
    if (p === 1) return '2nd in line';
    if (p === 2) return '3rd in line';
    return (p + 1) + 'th in line';
  }
  function loadQueue(provider, id) {
    apiAnswer(sessionPath(provider, id, '/queued-turns')).then(function (q) {
      var r = state.reading;
      var box = $('session-queue'); if (!box || !r || r.id !== id) return;
      var rows = (q.status === 200 && q.body && q.body.turns) || [];
      var waiting = rows.filter(function (t) { return t.status === 'waiting' || t.status === 'queued' || t.status === 'pending'; });
      if (q.status === 200 && r.queued !== waiting.length) { r.queued = waiting.length; paintActivity(r); }
      if (!waiting.length) { box.innerHTML = ''; return; }
      box.innerHTML = '<div class="sx-queue"><p class="sx-queue-head">' + (waiting.length === 1 ? '1 follow-up queued. It sends when this session is available.' : waiting.length + ' follow-ups queued. They send in order when this session is available.') + '</p>' +
        waiting.map(function (t) {
          var mine = t.owner !== 'codex' && parkedByMe(r, t.clientTurnId);
          return '<div class="sx-queue-row"><span class="sx-queue-state">' + esc(sxQueueLine(t)) + '</span><span class="sx-queue-text">' + esc(t.preview || t.prompt || 'Message') + '</span>' +
            (mine ? '<button type="button" class="cx-btn quiet" data-action="unqueue" data-turn-key="' + esc(t.clientTurnId) + '" title="Cancel this queued message. It will not be sent.">Cancel</button>' : '') + '</div>';
        }).join('') + '</div>';
    }).catch(function () {});
  }

  // What the server says about writing into this session before anything is sent (Control's
  // probeChatAttachability): a busy thread parks a send, another app holding it idle asks first,
  // and anything else is the server's refusal, word for word.
  function sxProbeAttach(r) {
    apiAnswer(sessionPath(r.provider, r.id, '/attachability')).then(function (a) {
      if (state.reading !== r) return;
      if (a.status === 404) { r.verdict = { attachable: false, reason: 'route_absent', reasonCopy: 'Update the COS server to continue a thread from here.', ownerCount: 0 }; renderVerdict(r); return; }
      var b = a.body || {};
      if (a.status !== 200 || typeof b.attachable !== 'boolean') return;
      var owners = Number(b.ownerCount) || 0;
      r.verdict = { attachable: b.attachable, reason: String(b.reason || ''), reasonCopy: String(b.reasonCopy || ''), ownerCount: owners, caution: b.attachable === true && owners > 0 };
      renderVerdict(r);
    }).catch(function () {});
  }
  var SX_PARK = {
    cursor: 'Working right now. A message you send goes into this Cursor chat when its turn ends.',
    codex: 'Working right now. A message you send joins the Codex app’s queue for this thread.',
    claude: 'Working right now. A message you send waits and lands when this turn ends.'
  };
  function sxSupplement(reason) {
    if (reason === 'native_target_busy') return 'It frees itself within 30 minutes. Detaching is not available in Control yet.';
    if (reason === 'native_target_fenced') return 'Fences can be released from the Fences card in this panel.';
    return '';
  }
  function renderVerdict(r) {
    var box = $('session-verdict'), line = $('session-caution');
    if (!box || state.reading !== r) return;
    var v = r.verdict, html = '';
    var forkBtn = '<button type="button" class="cx-btn quiet" data-action="fork-session" title="Runs your message in a copy of this thread. The original is untouched.">Fork with this message</button>';
    function refusalBox(copy, supplement, buttons) {
      return '<div class="sx-box refusal" role="status"><p>' + esc(copy) + '</p>' + (supplement ? '<p class="sx-box-sub">' + esc(supplement) + '</p>' : '') +
        (buttons ? '<div class="sx-box-actions">' + buttons + '</div>' : '') + '</div>';
    }
    if (r.cautionAsk) {
      html = '<div class="sx-box confirm" role="alertdialog" aria-labelledby="sx-caution-title" aria-describedby="sx-caution-body"><strong id="sx-caution-title">Send into an open session?</strong>' +
        '<p id="sx-caution-body">Another app on this Mac has this session open. It looks idle right now, but a reply will run with that session’s own permissions.</p>' +
        '<div class="sx-box-actions"><button type="button" class="cx-btn danger" data-sx="caution-send">Send anyway</button><button type="button" class="cx-btn quiet" data-sx="caution-cancel">Cancel</button></div></div>';
    } else if (r.refusal) {
      var f = r.refusal;
      html = refusalBox(f.copy, f.supplement,
        (f.changed ? '<button type="button" class="cx-btn quiet" data-sx="refresh-turns">Refresh</button><button type="button" class="cx-btn quiet" data-action="send-anyway">Continue anyway</button>' : '') +
        (f.retry ? '<button type="button" class="cx-btn quiet" data-sx="retry">Retry</button>' : '') +
        (f.fork ? forkBtn : ''));
    } else if (v && v.attachable === false && /^(native_thread_working|native_target_busy)$/.test(v.reason)) {
      html = '<div class="sx-park"><p>' + esc(SX_PARK[sxProvider(r.provider)]) + '</p>' + (/fork/i.test(v.reasonCopy) ? '<div class="sx-box-actions">' + forkBtn + '</div>' : '') + '</div>';
    } else if (v && v.attachable === false && v.reasonCopy) {
      html = refusalBox(v.reasonCopy, sxSupplement(v.reason), /fork/i.test(v.reasonCopy) ? forkBtn : '');
    }
    box.innerHTML = html;
    if (line) {
      var caution = v && v.caution ? (sxProvider(r.provider) === 'codex'
        ? 'The Codex app has this thread open. COS will ask before the first send, then hands your message to the app’s own queue, where it shows.'
        : 'Another app on this Mac has this session open. COS will ask before the first send. The reply lands in the transcript; the open desk tab will not show it until you resume.') : '';
      line.textContent = caution; line.classList.toggle('hidden', !caution);
    }
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
    // Control's caution (SessionChatVerdict.caution): another app holds this session and looks
    // idle, so the first send asks before it writes. A fork writes to a copy and never asks.
    if (!fork && r.verdict && r.verdict.caution && !r.cautionAck) { r.cautionAsk = true; renderVerdict(r); return; }
    // One send at a time: Enter submits the form even while Send is disabled, and a second send
    // during the first attach could park the same text in the queue while the first lands.
    if (r.sending) return;
    if (r.refusal || r.cautionAsk) { r.refusal = null; r.cautionAsk = false; renderVerdict(r); }
    r.sending = true;
    var btns = form.querySelectorAll('button'); btns.forEach(function (b) { b.disabled = true; });
    var done = function () { r.sending = false; btns.forEach(function (b) { b.disabled = false; }); };
    (fork ? forkSession(r, text) : continueSession(r, text, opts || {})).then(done, function (err) {
      done();
      if (state.reading !== r) return;
      var why = err && err.name === 'AbortError'
        ? (fork ? 'No answer from your Mac yet. The copy may still be made; tapping Fork again is safe, it will not make a second one.' : 'No answer from your Mac yet. It may still land. Sending again is safe; it will not post twice.')
        : (err && err.message) || 'Could not reach your Mac.';
      sessionStatus('');
      r.retryFork = !!fork;
      r.refusal = { copy: why, retry: true, fork: !fork };
      renderVerdict(r);
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
        if (opts.held) settleHeld(r, opts.held, 'refused', copy);
        else {
          // Control's refusal box: the server's words, then Fork with this message.
          sessionStatus('');
          r.refusal = { copy: (at.refusal && at.refusal.reasonCopy) || 'COS cannot write to this session right now.', supplement: sxSupplement(why), fork: true };
          renderVerdict(r);
        }
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
            // Control's refusal box for a changed thread: Refresh, Continue anyway, Fork with this message.
            r.sendAnyway = b.revision;
            sessionStatus('');
            r.refusal = { copy: b.reasonCopy || 'This session changed on your Mac since you opened it.', changed: true, fork: true };
            renderVerdict(r);
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
        setTimeout(function () { if (state.pane === 'sessions') loadSessions(true); }, 4000);
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

  // Copy session (Control's Kickstart brief, HelperSources/main.swift claudeKickstartCopy). Control
  // builds it from the Mac's transcript; the web builds it from the turns the server serves and
  // the session's first prompt, so it keeps the original request and the newest context.
  function sxKickstart(r) {
    var d = r.detail || {}, p = sxProvider(r.provider);
    var name = p === 'codex' ? 'Codex' : p === 'cursor' ? 'Cursor' : 'Claude Code';
    var title = sxTitle(d);
    var branch = d.git_branch && d.git_branch !== 'unknown' ? d.git_branch : '(unknown)';
    var out = '# Kickstart: ' + (title || name + ' session') + '\n\n' +
      'Read-only export of a ' + name + ' session. Continue this work here. Do not look for ' + name + ' jsonl or session IDs to resume.\n\n' +
      '- Workspace: ' + (d.project || '(unknown)') + '\n- Branch: ' + branch + '\n- Session: ' + (d.session_id || r.id) +
      (Number(d.omitted_tools) > 0 ? '\n- Tool calls omitted: ' + d.omitted_tools : '') + '\n\n';
    var turns = (r.turns || []).filter(function (t) { return String(t.text || '').trim(); });
    var firstUser = turns.filter(function (t) { return t.role === 'user'; })[0];
    var original = String(d.first_prompt || '').trim() || (firstUser ? String(firstUser.text).trim() : '');
    out += original ? '## Original request\n\n' + original + '\n\n## Conversation\n\n' : '## Conversation\n\n';
    if (r.more) out += '[Older turns omitted. COS serves the newest ' + turns.length + '. Original request kept.]\n\n';
    turns.forEach(function (t) {
      var text = String(t.text).trim();
      if (original && t.role === 'user' && text === original) return;
      out += '**' + (t.role === 'user' ? 'You' : 'Assistant') + '**\n\n' + text + '\n\n';
    });
    return out.length > 100000 ? out.slice(0, 100000) + '\n[truncated]\n' : out;
  }
  function copySessionBrief() {
    var r = state.reading, note = $('session-copy-note');
    if (!r || !r.detail) return;
    var text = sxKickstart(r);
    var say = function (msg) { if (note) { note.textContent = msg; note.classList.remove('hidden'); } };
    if (!text.trim()) return say('Nothing to copy');
    copyText(text).then(function () { say('Copied kickstart for another agent'); }, function (err) { say((err && err.message) || 'This browser would not copy.'); });
  }

  // Markdown for an assistant turn (Control renders replies with COSMarkdownView): headings, lists,
  // code, quotes, tables, rules, links. Everything is escaped first, so a reply can never add
  // markup of its own; a link keeps only an http(s) address.
  function sxInline(s) {
    var codes = [];
    s = s.replace(/`([^`\n]+)`/g, function (_m, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, function (_m, i) { return '<code>' + codes[Number(i)] + '</code>'; });
  }
  var SX_LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
  var SX_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
  var SX_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  function sxCells(row) { return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }); }
  function sxMd(text) {
    var lines = esc(String(text || '')).replace(/\r\n?/g, '\n').split('\n');
    var out = [], para = [], i = 0;
    function flush() { if (para.length) { out.push('<p>' + para.map(sxInline).join('<br>') + '</p>'); para = []; } }
    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*(```|~~~)/.test(line)) {
        flush();
        var code = [];
        i += 1;
        while (i < lines.length && !/^\s*(```|~~~)/.test(lines[i])) { code.push(lines[i]); i += 1; }
        i += 1;
        out.push('<pre><code>' + code.join('\n') + '</code></pre>');
        continue;
      }
      if (!line.trim()) { flush(); i += 1; continue; }
      var h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) { flush(); var lvl = Math.min(6, h[1].length + 2); out.push('<h' + lvl + '>' + sxInline(h[2]) + '</h' + lvl + '>'); i += 1; continue; }
      if (SX_RULE.test(line)) { flush(); out.push('<hr>'); i += 1; continue; }
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && SX_TABLE_SEP.test(lines[i + 1])) {
        flush();
        var head = sxCells(line), aligns = sxCells(lines[i + 1]).map(function (a) { return /^:-+:$/.test(a) ? 'center' : /-:$/.test(a) ? 'right' : ''; });
        var cell = function (tag, c, k) { return '<' + tag + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + sxInline(c) + '</' + tag + '>'; };
        i += 2;
        var body = [];
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) { body.push(sxCells(lines[i])); i += 1; }
        out.push('<div class="sx-table"><table><thead><tr>' + head.map(function (c, k) { return cell('th', c, k); }).join('') + '</tr></thead><tbody>' +
          body.map(function (row) { return '<tr>' + head.map(function (_c, k) { return cell('td', row[k] || '', k); }).join('') + '</tr>'; }).join('') + '</tbody></table></div>');
        continue;
      }
      if (/^\s*&gt;/.test(line)) {
        flush();
        var quote = [];
        while (i < lines.length && /^\s*&gt;/.test(lines[i])) { quote.push(lines[i].replace(/^\s*&gt;\s?/, '')); i += 1; }
        out.push('<blockquote>' + sxMd.unescaped(quote) + '</blockquote>');
        continue;
      }
      if (SX_LIST.test(line)) { flush(); var list = sxListBlock(lines, i); out.push(list.html); i = list.next; continue; }
      para.push(line.trim());
      i += 1;
    }
    flush();
    return out.join('');
  }
  // A quote's lines are already escaped: paragraphs and line breaks only, inline styles kept.
  sxMd.unescaped = function (lines) {
    return lines.join('\n').split(/\n\s*\n/).map(function (p) { return '<p>' + p.split('\n').map(sxInline).join('<br>') + '</p>'; }).join('');
  };
  // Nested lists by indent: a deeper item opens a list inside the open item, a shallower one closes back.
  function sxListBlock(lines, i) {
    var html = '', stack = [];
    while (i < lines.length) {
      var m = SX_LIST.exec(lines[i]);
      if (!m) {
        if (!lines[i].trim() && i + 1 < lines.length && SX_LIST.test(lines[i + 1])) { i += 1; continue; }
        if (stack.length && /^\s{2,}\S/.test(lines[i])) { html += '<br>' + sxInline(lines[i].trim()); i += 1; continue; }
        break;
      }
      var indent = m[1].replace(/\t/g, '    ').length, tag = /\d/.test(m[2]) ? 'ol' : 'ul';
      var start = tag === 'ol' ? parseInt(m[2], 10) : 1;
      var open = '<' + tag + (tag === 'ol' && start > 1 ? ' start="' + start + '"' : '') + '>';
      if (!stack.length || indent > stack[stack.length - 1].indent) { html += open; stack.push({ indent: indent, tag: tag }); }
      else {
        while (stack.length > 1 && indent < stack[stack.length - 1].indent) html += '</li></' + stack.pop().tag + '>';
        html += '</li>';
        if (stack[stack.length - 1].tag !== tag) { html += '</' + stack.pop().tag + '>' + open; stack.push({ indent: indent, tag: tag }); }
      }
      html += '<li>' + sxInline(m[3]);
      i += 1;
    }
    while (stack.length) html += '</li></' + stack.pop().tag + '>';
    return { html: html, next: i };
  }

  // YOU and ASSISTANT cards, shown whole (Control: "a reply is Markdown; what you typed is shown as
  // you typed it"). The server shapes each turn to 4,000 characters with a visible ellipsis.
  function renderTurns(turns, d) {
    if (!turns.length) return '<p class="reader-placeholder">This session has no user or assistant prose stored.</p>';
    return turns.map(sxTurnHtml).join('');
  }
  // One turn's identity, for telling which turns a refresh brought that the page already shows.
  function sxTurnSig(t) {
    var text = String(t.text || t.content || '').trim();
    return (String(t.role || '').toLowerCase() === 'user' ? 'u' : 'a') + '|' + (t.at || '') + '|' + text.length + '|' + text.slice(0, 48);
  }
  function sxTurnHtml(t) {
    var role = String(t.role || '').toLowerCase() === 'user' ? 'user' : 'assistant';
    var text = String(t.text || t.content || '').trim();
    var at = toDate(t.at);
    var when = at ? (Date.now() - at.getTime() < 86400000 ? clock(at) : sxShortDate(at)) : '';
    return '<div class="turn ' + role + ' sx-turn" data-sig="' + esc(sxTurnSig(t)) + '"><span class="who"><span>' + (role === 'user' ? 'YOU' : 'ASSISTANT') + '</span>' +
      (when ? '<span class="sx-turn-when">' + esc(when) + '</span>' : '') + '</span>' +
      (role === 'user' ? '<div class="sx-plain">' + esc(text) + '</div>' : '<div class="sx-md">' + sxMd(text) + '</div>') + '</div>';
  }
  // A refresh never rebuilds what you are reading (Miles, /qa: "start to scroll and then it reloads
  // the section"). The server's window slides as a session grows, so the turns the page already
  // shows are found at the start of the new list and only what follows them is appended; older
  // cards stay. Your sent and waiting bubbles give way to the real turns only when new turns land.
  // When the lists share nothing, the card you are reading is kept where it was on screen.
  function sxMergeTurns(box, old, next, d) {
    if (!old.length && !next.length) return;
    var oldSigs = old.map(sxTurnSig), nextSigs = next.map(sxTurnSig), fresh = null;
    for (var j = 0; j < oldSigs.length && fresh === null; j++) {
      var tail = oldSigs.slice(j);
      if (tail.length > nextSigs.length) continue;
      if (tail.every(function (s, k) { return s === nextSigs[k]; })) fresh = next.slice(tail.length);
    }
    if (fresh) {
      if (!fresh.length) return;
      box.querySelectorAll('.turn.pending, .reader-placeholder').forEach(function (el) { el.remove(); });
      box.insertAdjacentHTML('beforeend', fresh.map(sxTurnHtml).join(''));
      return;
    }
    var anchor = null, top = 0, cards = box.querySelectorAll('.turn[data-sig]');
    for (var i = 0; i < cards.length; i++) {
      var rect = cards[i].getBoundingClientRect();
      if (rect.bottom > 0) { anchor = cards[i].getAttribute('data-sig'); top = rect.top; break; }
    }
    box.innerHTML = renderTurns(next, d);
    if (!anchor) return;
    var same = [].filter.call(box.querySelectorAll('.turn[data-sig]'), function (el) { return el.getAttribute('data-sig') === anchor; })[0];
    if (same) window.scrollBy(0, same.getBoundingClientRect().top - top);
  }

  // ── Ask COS (the Ask sheet's first row) ─────────────────
  // 6.99.10: the same request as the COS chat's Ask (panes/cos-chat.js submitAsk). Before, this sent `prompt` with a
  // `web_<time>` id and no generation or era, so the server refused every one (409 message_era_mismatch on a Mac with
  // a message era, else invalid_client_job_id) and a small status line was the only sign.
  function webJobId() {
    // crypto.randomUUID needs a secure context; a plain-http tailnet page is not one.
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 0x100).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function askCos(prompt, statusEl) {
    setStatus(statusEl, 'Sent. COS is answering.');
    var body = { clientJobId: webJobId(), generation: 1, query: prompt, source: 'web', activityToolMode: 'status' };
    return api('/api/query-jobs', { method: 'POST', body: body, timeoutMs: 30000 }).then(function () {
      // The answer lands in Messages; refresh it there if it is open.
      var again = function () { if (state.pane === 'messages' && PANES.messages && PANES.messages.refresh) PANES.messages.refresh(); };
      setTimeout(again, 4000);
      setTimeout(function () { again(); setStatus(statusEl, ''); }, 15000);
    }).catch(function (err) {
      setStatus(statusEl, err.message, true);
      toast('Ask COS did not send: ' + err.message);
      throw err;
    });
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

  // ── Usage ───────────────────────────────────────────────
  // Usage and COS cost are views inside Sessions, as on the Mac (ActivityWindow.swift 2306-2325);
  // an old #/usage link opens the Usage view there. Data: GET /api/usage/summary, the helper's
  // read-only session-usage and cos-usage reports (web-usage-bridge.ts). The figures follow
  // SessionUsageCore.swift: COS cost counts measured dollars (measuredUSD) and never adds
  // estimates into them, and its rows keep Control's category titles.
  function loadUsage() {
    SX.view = 'usage'; sxSave();
    location.replace('#/sessions');
  }
  function renderUsageView(force) {
    var box = $('sessions-usage'); if (!box) return;
    var stale = !SX.usage || Date.now() - SX.usageAt > 5 * 60000;
    if (SX.usage) paintUsage();
    else box.innerHTML = '<p class="cx-note sx-reading">' + (SX.view === 'cost' ? 'Reading what COS used.' : 'Reading local usage…') + '</p>';
    if ((!force && !stale) || SX.usageLoading) return;
    SX.usageLoading = true; paintSessionsHero();
    // The server runs the two Mac helpers side by side, each capped at 15 s (web-usage-bridge.ts), so a
    // cold read can pass the 20 s default for reads once the network is added; 30 s covers it.
    api('/api/usage/summary' + (force ? '?refresh=1' : ''), { timeoutMs: 30000 }).then(function (d) {
      SX.usage = d || {}; SX.usageAt = Date.now(); SX.usageError = ''; SX.usageLoading = false;
      paintSessionsHero(); paintUsage();
    }, function (err) {
      SX.usageLoading = false; SX.usageError = (err && err.message) || 'Usage did not load.';
      paintSessionsHero(); paintUsage();
    });
  }
  function paintUsage() {
    var box = $('sessions-usage'); if (!box || SX.view === 'sessions') return;
    if (!SX.usage) { box.innerHTML = SX.usageError ? '<div class="cx-notice warn">' + esc(SX.usageError) + '</div>' : ''; return; }
    box.innerHTML = (SX.usageError ? '<div class="cx-notice warn">' + esc(SX.usageError) + '</div>' : '') +
      (SX.view === 'cost' ? cosCostHtml(SX.usage) : sessionUsageHtml(SX.usage));
  }

  // Numbers the way Control writes them (SessionUsagePresentation, CosCostPresentation).
  function uCurrency(v, digits) { return (Number(v) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }); }
  function uMoney(v) { v = Number(v) || 0; return v > 0 && v < 0.01 ? 'under 1¢' : uCurrency(v, v < 10 ? 2 : 0); }
  function uAtLeast(v) { return v < 0.01 ? 'at least a fraction of 1¢' : 'at least ' + uMoney(v); }
  function uDollars(v) { v = Number(v) || 0; return v > 0 && v < 1 ? '<$1' : uCurrency(v, 0); }
  function uNum(n) { return (Number(n) || 0).toLocaleString('en-US'); }
  function uShort(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e8) return (n / 1e6).toFixed(0) + 'M';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e5) return (n / 1e3).toFixed(0) + 'K';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }
  function uShare(part, whole) { if (!(whole > 0)) return 'Unavailable'; var p = 100 * part / whole; return p > 0 && p < 0.1 ? '<0.1%' : p.toFixed(1) + '%'; }
  var U_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function uDayWords(key) { var p = String(key || '').split('-').map(Number); return p.length === 3 && p[1] ? U_MONTHS[p[1] - 1] + ' ' + p[2] + ', ' + p[0] : String(key || ''); }

  // ── Usage view (SessionUsageView.swift 329-445) ──
  var U_PERIODS = ['Last 7 days', 'Last 30 days', 'Last 90 days', 'Last weekend', 'All history'];
  function uToolName(p) { return p === 'Anthropic' ? 'Claude Code' : p === 'OpenAI' ? 'Codex' : p === 'Cursor' ? 'Cursor' : 'Codex (' + p + ')'; }
  // "claude-opus-5-5" reads "Opus 5.5"; an unknown id stays recognizable.
  function uModelName(id) {
    var name = String(id || '').replace(/-\d{8}$/, '');
    if (name.indexOf('cursor-') === 0) name = name.slice(7);
    var parts = name.split('-');
    if (parts.length < 2) return name;
    var isVersion = function (s) { return /^[\d.]+$/.test(s); };
    var cap = function (s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };
    if (parts[0] === 'claude') {
      parts.shift();
      if (parts.length > 1 && isVersion(parts[0])) { var t = parts[0]; parts[0] = parts[1]; parts[1] = t; }
      var family = parts.shift(), version = [];
      while (parts.length && isVersion(parts[0])) version.push(parts.shift());
      return [cap(family)].concat(version.length ? [version.join('.')] : []).concat(parts).join(' ');
    }
    if (parts[0] === 'gpt') return ['GPT-' + parts[1]].concat(parts.slice(2).map(function (p, i) { return i === 0 ? cap(p) : p; })).join(' ');
    return [cap(parts[0])].concat(parts.slice(1)).join(' ');
  }
  function uDayKey(tz) {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
    catch (_e) { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  }
  function uAddDays(key, n) { var p = key.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10); }
  function uWeekday(key) { var p = key.split('-').map(Number); return (new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() + 6) % 7; }
  function uBounds(period, tz) {
    var today = uDayKey(tz), counts = { 'Last 7 days': 7, 'Last 30 days': 30, 'Last 90 days': 90 };
    if (counts[period]) return [uAddDays(today, 1 - counts[period]), today];
    if (period === 'Last weekend') { var monday = uAddDays(today, -uWeekday(today)); return [uAddDays(monday, -2), uAddDays(monday, -1)]; }
    if (/^\d{4}-\d{2}$/.test(period)) return [period + '-01', period + '-31'];
    return null;
  }
  function uTotals(rows) {
    var t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, events: 0, priced: 0, usd: 0 };
    rows.forEach(function (b) {
      var c = b.counts || {};
      t.input += Number(c.input) || 0; t.output += Number(c.output) || 0; t.cacheRead += Number(c.cacheRead) || 0; t.cacheWrite += Number(c.cacheWrite) || 0;
      t.events += Number(b.events) || 0; t.priced += Number(b.pricedEvents) || 0; t.usd += Number(b.estimatedUSD) || 0;
    });
    t.fresh = t.input + t.output + t.cacheWrite;
    t.all = t.fresh + t.cacheRead;
    return t;
  }
  function uCostCell(t) { return t.priced > 0 ? uDollars(t.usd) + (t.priced < t.events ? '+' : '') : 'No price'; }
  function uGroup(rows, keyFn) {
    var by = {}, order = [];
    rows.forEach(function (b) { var k = keyFn(b); if (!by[k]) { by[k] = []; order.push(k); } by[k].push(b); });
    return order.map(function (k) { return { key: k, rows: by[k], t: uTotals(by[k]) }; });
  }
  function uSelect(id, label, value, options) {
    return '<select id="' + id + '" class="field sx-select" aria-label="' + label + '">' + options.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (o[0] === value ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('') + '</select>';
  }
  function sessionUsageHtml(d) {
    var su = d.sessionUsage;
    var how = '<details class="sx-how"><summary>How this is counted</summary>' + uHowLines(su).map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('') + '</details>';
    if (!su) return '<div class="sx-uempty">' + esc('Usage has not been read yet. Refresh reads Claude Code and Codex logs on this Mac.') + '</div>' + how;
    var tz = su.timeZone || '';
    var buckets = (Array.isArray(su.buckets) ? su.buckets : []).filter(function (b) { return b && typeof b.day === 'string'; });
    var pending = [];
    if (Number(su.pendingFiles) > 0) pending.push('Reading older history: ' + su.pendingFiles + ' files remaining. Totals will grow until it finishes.');
    if (su.cursorFeed && su.cursorFeed.pending === true && su.cursorFeed.message) pending.push(su.cursorFeed.message + ' Totals will grow until it finishes.');
    var pendingHtml = pending.map(function (n) { return '<p class="cx-note sx-unote">' + esc(n) + '</p>'; }).join('');
    if (!buckets.length) return '<div class="sx-uempty">' + esc('No usage recorded yet. Claude Code and Codex sessions on this Mac appear here once their logs are read. A missing tool is not zero usage.') + pendingHtml + '</div>' + how;

    var months = []; buckets.forEach(function (b) { var m = b.day.slice(0, 7); if (months.indexOf(m) < 0) months.push(m); });
    months.sort().reverse();
    var periods = U_PERIODS.concat(months.slice(0, 12));
    if (periods.indexOf(SX.uPeriod) < 0) SX.uPeriod = 'Last 30 days';
    var bounds = uBounds(SX.uPeriod, tz);
    var inPeriod = bounds ? buckets.filter(function (b) { return b.day >= bounds[0] && b.day <= bounds[1]; }) : buckets;
    var tools = uGroup(buckets, function (b) { return b.provider; }).sort(function (a, b) { return b.t.all - a.t.all; }).map(function (g) { return g.key; });
    if (SX.uTool !== 'All tools' && tools.indexOf(SX.uTool) < 0) SX.uTool = 'All tools';
    var forTool = buckets.filter(function (b) { return SX.uTool === 'All tools' || b.provider === SX.uTool; });
    var models = uGroup(forTool, function (b) { return b.model; }).sort(function (a, b) { return b.t.all - a.t.all; }).map(function (g) { return g.key; });
    if (SX.uModel !== 'All models' && models.indexOf(SX.uModel) < 0) SX.uModel = 'All models';
    var selected = inPeriod.filter(function (b) { return (SX.uTool === 'All tools' || b.provider === SX.uTool) && (SX.uModel === 'All models' || b.model === SX.uModel); });
    var hasFilter = SX.uTool !== 'All tools' || SX.uModel !== 'All models';
    var updated = toDate(su.updatedAt);

    var html = '<div class="sx-ufilters">' +
      uSelect('usage-period', 'Period', SX.uPeriod, periods.map(function (p) { return [p, /^\d{4}-\d{2}$/.test(p) ? U_MONTHS[Number(p.slice(5)) - 1] + ' ' + p.slice(0, 4) : p]; })) +
      uSelect('usage-tool', 'Tool', SX.uTool, [['All tools', 'All tools']].concat(tools.map(function (p) { return [p, uToolName(p)]; }))) +
      uSelect('usage-model', 'Model', SX.uModel, [['All models', 'All models']].concat(models.map(function (m) { return [m, uModelName(m)]; }))) +
      (hasFilter ? '<button type="button" class="sx-link" data-sx="usage-clear">Clear filters</button>' : '') +
      (updated ? '<span class="sx-fresh">Updated ' + esc(clock(updated)) + '</span>' : '') +
      '</div>' + pendingHtml;
    if (!selected.length) return html + '<div class="sx-uempty">No recorded usage for this selection. A missing tool is not zero usage.</div>' + uFooter(su, selected) + how;

    var t = uTotals(selected);
    var days = uGroup(selected, function (b) { return b.day; });
    var pricedDays = days.filter(function (g) { return g.t.priced > 0; });
    var perDay = pricedDays.length ? uDollars(pricedDays.reduce(function (s, g) { return s + g.t.usd; }, 0) / pricedDays.length) + (pricedDays.some(function (g) { return g.t.priced < g.t.events; }) ? '+' : '') : 'No price';
    var figures = [
      ['API value', uCostCell(t), '', 'What these tokens would cost at standard API rates. Not your subscription bill.'],
      ['New tokens', uShort(t.fresh), '', 'Input, output and cache writes.'],
      ['All tokens', uShort(t.all), uShare(t.cacheRead, t.all) + ' read again from cache', 'New tokens plus context read again from cache.'],
      ['API value a day', perDay, days.length + ' ' + (days.length === 1 ? 'day' : 'days') + ' with usage', 'Average across days with a price. Days without logs or a price are left out, not counted as zero.']
    ];
    html += '<div class="sx-figures">' + figures.map(function (f, i) {
      return '<div class="sx-figure' + (i === 0 ? ' lead' : '') + '" title="' + esc(f[3]) + '"><b>' + esc(f[1]) + '</b><span class="sx-figure-title">' + esc(f[0]) + '</span>' + (f[2] ? '<span class="sx-figure-note">' + esc(f[2]) + '</span>' : '') + '</div>';
    }).join('') + '</div>';

    // By tool and model, largest first.
    var byModel = uGroup(selected, function (b) { return b.provider + '|' + b.model; }).sort(function (a, b) { return b.t.all - a.t.all; });
    html += '<h3 class="sx-uhead">By tool and model</h3><div class="sx-table sx-utable"><table><thead><tr><th>Model</th><th>Tool</th><th class="num hp">New tokens</th><th class="num">All tokens</th><th class="num">API value</th></tr></thead><tbody>' +
      byModel.map(function (g) {
        var b = g.rows[0];
        return '<tr><td title="' + esc(b.model) + '">' + esc(uModelName(b.model)) + '</td><td>' + esc(uToolName(b.provider)) + '</td><td class="num hp">' + uShort(g.t.fresh) + '</td><td class="num">' + uShort(g.t.all) + '</td><td class="num">' + esc(uCostCell(g.t)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';

    // Day by day, newest first, with a bar for the day's new tokens.
    var dayRows = days.slice().sort(function (a, b) { return a.key < b.key ? 1 : -1; }).slice(0, 45);
    var peak = dayRows.reduce(function (m, g) { return Math.max(m, g.t.fresh); }, 0) || 1;
    html += '<h3 class="sx-uhead">Day by day</h3><div class="cx-list sx-days">' + dayRows.map(function (g) {
      var p = g.key.split('-').map(Number);
      var label = new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
      return '<div class="sx-day"><span class="sx-day-date">' + esc(label) + '</span><span class="sx-day-bar" aria-hidden="true"><span style="width:' + Math.max(1, Math.round(100 * g.t.fresh / peak)) + '%"></span></span>' +
        '<span class="sx-day-tok">' + uShort(g.t.fresh) + '</span><span class="sx-day-usd">' + esc(uCostCell(g.t)) + '</span></div>';
    }).join('') + '</div>' + (days.length > dayRows.length ? '<p class="cx-note">The newest ' + dayRows.length + ' of ' + days.length + ' days.</p>' : '');
    return html + uFooter(su, selected) + how;
  }
  function uFooter(su, selected) {
    var bits = ['Read from ' + uNum(su.filesIndexed) + ' log files on this Mac.'];
    if (Number(su.unreadableFiles) > 0) bits.push(uNum(su.unreadableFiles) + ' could not be read.');
    var missing = {}, unpriced = 0;
    selected.forEach(function (b) { var gap = (Number(b.events) || 0) - (Number(b.pricedEvents) || 0); if (gap > 0) { unpriced += gap; var n = uModelName(b.model); missing[n] = (missing[n] || 0) + gap; } });
    if (unpriced > 0) {
      var names = Object.keys(missing).sort(function (a, b) { return missing[b] - missing[a] || (a < b ? -1 : 1); });
      bits.push('A + means a figure leaves out ' + uNum(unpriced) + ' records with no verified price: ' + names.slice(0, 2).join(' and ') + (names.length > 2 ? ' and ' + (names.length - 2) + ' more' : '') + '.');
    }
    return '<p class="sx-ufoot">' + bits.map(esc).join(' ') + '</p>';
  }
  function uHowLines(su) {
    var lines = ['While COS Control is running it refreshes every five minutes. Pausing keeps existing history. Only counts, dates, model names and file checkpoints are stored. Local logs are never uploaded.'];
    if (su) {
      (su.coverage || []).forEach(function (c) { if (typeof c === 'string') lines.push(c); });
      var gaps = (Number(su.unreadableFiles) || 0) + (Number(su.malformedRows) || 0) + (Number(su.missingBaselineEvents) || 0);
      if (gaps > 0) lines.push('Gaps: ' + (su.unreadableFiles || 0) + ' unreadable files or oversized rows, ' + (su.malformedRows || 0) + ' malformed rows, ' + (su.missingBaselineEvents || 0) + ' missing usage baselines. Totals reflect what could be read.');
      lines.push('Calendar dates in ' + (su.timeZone || 'this Mac’s time zone') + '. Days without logs are missing, not zero. Weeks run Monday to Sunday, and the first and last week or month of a period can be partial.');
    }
    lines.push('New tokens are input, output and cache writes. Output includes reasoning. Cache reads are repeated context, not cache savings.');
    var checked = su && /^\d{4}-\d{2}-\d{2}/.test(String(su.pricingVersion || '')) ? uDayWords(String(su.pricingVersion).slice(0, 10)) : 'October 25, 2026';
    lines.push('API value is the standard API rate, checked ' + checked + ' and applied to all dates. It leaves out discounts, speed tiers, tools and taxes, and it is not your subscription bill. Cursor’s value is the per-request cost Cursor reports.');
    lines.push('Token share is not your plan allowance. It compares recorded tokens in this selection; providers calculate subscription limits separately.');
    return lines;
  }

  // ── COS cost view (SessionUsageView.swift CosCostView 1773-2009, CosCostPresentation) ──
  var COS_CATS = {
    dictation: ['Dictation', 'dictation', 'dictations'],
    transcription: ['Transcription cleanup', 'cleanup', 'cleanups'],
    dictationBeforeSplit: ['Dictation and transcripts, before Oct 20', 'cleanup', 'cleanups'],
    meetingNotes: ['Meeting notes', 'note or summary', 'notes and summaries'],
    answers: ['Answers', 'answer', 'answers'],
    liveAndUpkeep: ['Live help and upkeep', 'check', 'checks'],
    memoryIndexing: ['Memory indexing', 'indexing call', 'indexing calls'],
    other: ['Other', 'other call', 'other calls'],
    work: ['Work', 'background call', 'background calls'],
    sessionFinding: ['Finding sessions', 'search', 'searches']
  };
  var COS_FIELDS = ['calls', 'measuredCalls', 'measuredUSD', 'measuredTokens', 'unpricedMeasuredCalls', 'unpricedLedgerTokens', 'estimatedCalls', 'estimatedUSD', 'estimatedPricedCalls', 'estimatedTokens', 'addsToTotalUSD', 'addsUnlessCursorFeedUSD', 'approximateMatches'];
  function cosCount(cat, n) { var c = COS_CATS[cat] || COS_CATS.other; return uNum(n) + ' ' + (n === 1 ? c[1] : c[2]); }
  // A category this page does not know joins Other, so every row keeps one of Control's titles.
  function cosRows(report) {
    var by = {};
    (report.rows || []).forEach(function (row) {
      var cat = COS_CATS[row.category] ? row.category : 'other';
      var acc = by[cat] || (by[cat] = { category: cat });
      COS_FIELDS.forEach(function (k) { acc[k] = (acc[k] || 0) + (Number(row[k]) || 0); });
    });
    return Object.keys(by).map(function (k) { return by[k]; });
  }
  function cosSum(rows, k) { return rows.reduce(function (s, r) { return s + (Number(r[k]) || 0); }, 0); }
  function cosUsageState(su) {
    if (!su) return 'unavailable';
    if (Number(su.pendingFiles) > 0 || (su.cursorFeed && su.cursorFeed.pending === true)) return 'importing';
    return 'ready';
  }
  function cosCostHtml(d) {
    var report = d.cosCost, su = d.sessionUsage;
    if (!report) return '<div class="sx-uempty">Reading what COS used.</div>';
    var rows = cosRows(report), overhead = rows.filter(function (r) { return r.category !== 'work'; });
    var workRow = rows.filter(function (r) { return r.category === 'work'; })[0] || null;
    var work = report.work || {}, sessions = report.sessions || {};
    var reading = (Number(sessions.stillReading) || 0) > 0 || sessions.busy === true;
    var us = cosUsageState(su);
    // The total the person ran: Usage's API value in the window, plus COS spend Usage cannot see.
    var lo = report.windowStart || '', hi = report.windowEnd || '';
    var buckets = (su && su.buckets) || [];
    var inWin = function (b) { return (!lo || b.day >= lo) && (!hi || b.day <= hi); };
    var cursorHeld = !!(su && su.cursorFeed && su.cursorFeed.lastSuccessAt) || buckets.some(function (b) { return b.provider === 'Cursor' && inWin(b); });
    var ran = buckets.filter(inWin).reduce(function (s, b) { return s + (Number(b.estimatedUSD) || 0); }, 0) +
      rows.reduce(function (s, r) { return s + (Number(r.addsToTotalUSD) || 0) + (cursorHeld ? 0 : (Number(r.addsUnlessCursorFeedUSD) || 0)); }, 0) +
      (Number(work.addsToTotalUSD) || 0);
    var ranPartial = us !== 'unavailable' && buckets.some(function (b) { return inWin(b) && (Number(b.pricedEvents) || 0) < (Number(b.events) || 0); });
    var total = cosSum(overhead, 'calls'), measured = cosSum(overhead, 'measuredCalls'), estimated = cosSum(overhead, 'estimatedCalls');
    var usd = cosSum(overhead, 'measuredUSD');
    var measuredPartial = overhead.some(function (r) { return r.unpricedMeasuredCalls > 0 || r.unpricedLedgerTokens > 0; });
    var workUSD = (Number(work.measuredUSD) || 0) + (workRow ? workRow.measuredUSD : 0);
    var workTokens = (Number(work.measuredTokens) || 0) + (workRow ? workRow.measuredTokens : 0);
    var callWord = total === 1 ? 'call' : 'calls';

    // The headline: the answer, then what it leaves out (headlineParts).
    var answer, caveat = '';
    if (!report.auditFound && total === 0) { answer = 'COS has no record of its calls on this Mac yet.'; caveat = ' The record starts with its first one.'; }
    else if (total === 0) {
      var withoutCalls = overhead.some(function (r) { return r.measuredTokens > 0; }) || workTokens > 0 || (Number(work.widerTokens) || 0) > 0;
      answer = withoutCalls ? 'COS made no counted calls in the last 30 days.' : 'COS made no calls in the last 30 days.';
      caveat = withoutCalls ? ' Its Work and background usage is below.' : '';
    } else if (measured <= 0) {
      answer = 'COS made ' + uNum(total) + ' ' + callWord + ' in the last 30 days.';
      caveat = reading ? ' Still reading the session logs that could hold their cost.'
        : sessions.failed ? ' COS could not read the usage history, so the session logs that could hold their cost are missing from this pass.'
        : ' This server doesn’t measure their cost yet.';
    } else {
      var lead = reading || sessions.failed ? 'Measured so far: COS used ' : 'Measured: COS used ';
      var usdText = uMoney(usd) + (measuredPartial ? '+' : ''), ranText = uMoney(ran) + (ranPartial ? '+' : '');
      if (usd <= 0) answer = 'COS made ' + uNum(total) + ' ' + callWord + ' in the last 30 days. ' + uNum(measured) + ' were measured, on models with no verified price.';
      else if (us === 'unavailable' || ran <= 0 || usd > ran) answer = lead + usdText + ' in the last 30 days.';
      else if (us === 'importing') answer = lead + usdText + ' of the ' + ranText + ' read so far in the last 30 days.';
      else answer = lead + usdText + ' of the ' + ranText + ' you ran in the last 30 days.';
      if (estimated > 0 && usd > 0) caveat = ' ' + uNum(estimated) + ' more ' + (estimated === 1 ? 'call has' : 'calls have') + ' only character counts, so the real figure is higher.';
    }
    if (report.auditUnreadable) {
      if (total === 0) { answer = 'COS could not read its record of calls, so there is no count to show.'; caveat = ''; }
      else caveat += ' COS could not read its record of calls, so some are missing here.';
    }
    var html = '<h2 class="sx-cost-head">' + esc(answer) + (caveat ? '<span>' + esc(caveat) + '</span>' : '') + '</h2>';
    var showsDollars = rows.some(function (r) { return r.measuredUSD > 0 || r.estimatedUSD > 0; }) || (Number(work.widerUSD) || 0) > 0;
    if (showsDollars) html += '<p class="sx-cost-api">These are API values: what the same calls would cost at standard API rates. They aren’t your bill.</p>';

    var status = [];
    if (reading) { var n = Number(sessions.stillReading) || 0; status.push(['', n > 0 ? 'Still reading ' + uNum(n) + ' ' + (n === 1 ? 'session' : 'sessions') + '. These figures will grow until it finishes.' : 'Still reading. The usage history was busy, so these figures may grow.']); }
    if (us === 'importing') {
      var files = Number(su.pendingFiles) || 0;
      status.push(['warn', files > 0 ? 'Usage is still reading ' + uNum(files) + ' log ' + (files === 1 ? 'file' : 'files') + ', so the total will grow and the share will settle.' : 'Usage is still reading your Cursor usage, so the total will grow and the share will settle.']);
    } else if (us === 'unavailable') status.push(['warn', 'Usage has not been read yet, so there is no total to compare this with.']);
    if (status.length) html += '<div class="sx-cost-status">' + status.map(function (s) { return '<p class="' + s[0] + '">' + esc(s[1]) + '</p>'; }).join('') + '</div>';

    // Category rows (rowLines): measured first, largest first; then estimated; then tokens with no
    // price; then empty rows. Dictation and Transcription cleanup always show.
    if (total > 0 || overhead.some(function (r) { return r.measuredTokens > 0; })) {
      var list = overhead.slice();
      ['dictation', 'transcription'].forEach(function (c) { if (!list.some(function (r) { return r.category === c; })) { var e = { category: c }; COS_FIELDS.forEach(function (k) { e[k] = 0; }); list.push(e); } });
      var rank = function (r) { return r.measuredUSD > 0 ? 0 : r.estimatedUSD > 0 ? 1 : (r.calls > 0 || r.measuredTokens > 0 ? 2 : 3); };
      var size = function (r) { return r.measuredUSD > 0 ? r.measuredUSD : r.estimatedUSD > 0 ? r.estimatedUSD : r.calls; };
      list.sort(function (a, b) { return (rank(a) - rank(b)) || (size(b) - size(a)) || (a.category < b.category ? -1 : 1); });
      var peak = list.reduce(function (m, r) { return Math.max(m, r.measuredUSD + r.estimatedUSD); }, 0);
      html += '<div class="sx-cost-rows">' + list.map(function (r) { return cosRowHtml(r, peak); }).join('') + '</div>';
    }

    // Work: what a person chose, under the figure rather than inside it.
    var workCount = !work.handoffsFound ? 'This Mac has no record of Work runs.' : !(Number(work.runs) > 0) ? 'No Work runs in the last 30 days' : uNum(work.runs) + ' ' + (Number(work.runs) === 1 ? 'run' : 'runs') + ' you started';
    var workPartial = (Number(work.unpricedEvents) || 0) > 0 || (workRow ? workRow.unpricedMeasuredCalls > 0 : false);
    var workFigure = workUSD > 0 ? uMoney(workUSD) + (workPartial ? '+' : '') : workTokens > 0 ? 'No price' : '';
    var wider = (Number(work.widerUSD) || 0) + (workRow ? workRow.measuredUSD : 0);
    var widerPartial = (Number(work.widerUnpricedEvents) || 0) > 0 || (workRow ? workRow.unpricedMeasuredCalls > 0 : false);
    var workLines = [];
    if (wider - workUSD >= 0.01) workLines.push(['strong', uMoney(wider) + (widerPartial ? '+' : '') + ' if you count what you did later in those sessions.']);
    if (work.handoffsFound && Number(work.runs) > 0) workLines.push(['', 'From each run’s session log, from its start until you next typed in that session or its last turn finished. Not part of the figure above.']);
    if (workRow && workRow.estimatedCalls > 0) workLines.push(['', 'Plus ' + cosCount('work', workRow.estimatedCalls) + (workRow.estimatedUSD > 0 ? ', ' + uAtLeast(workRow.estimatedUSD) + ' estimated' : ', no verified price') + '.']);
    var unproven = Number(work.unprovenRuns) || 0;
    if (unproven > 0) workLines.push(['', uNum(unproven) + ' ' + (unproven === 1 ? 'run has' : 'runs have') + ' no provable end, so ' + (unproven === 1 ? 'it is' : 'they are') + ' only in the wider figure.']);
    var noLogs = Number(work.runsWithoutLogs) || 0;
    if (noLogs > 0) workLines.push(['', uNum(noLogs) + ' ' + (noLogs === 1 ? 'run' : 'runs') + ' left no log COS can read, so ' + (noLogs === 1 ? 'it isn’t' : 'they aren’t') + ' counted.']);
    html += '<div class="sx-work"><div class="sx-work-top"><div><b class="sx-work-title">Work</b><span class="sx-work-count">' + esc(workCount) + '</span></div>' +
      '<div class="sx-work-fig">' + (workFigure ? '<b>' + esc(workFigure) + '</b>' : '') + (workTokens > 0 ? '<span>' + uShort(workTokens) + ' tokens, measured</span>' : '') + '</div></div>' +
      workLines.map(function (l) { return '<p class="' + l[0] + '">' + esc(l[1]) + '</p>'; }).join('') + '</div>';

    // Footer: the notes, then how this is counted.
    var notes = [];
    if (ranPartial) {
      var short = measuredPartial || estimated > 0 || (Number(sessions.compressed) || 0) > 0 || (Number(sessions.noLogs) || 0) > 0 || reading;
      notes.push(short ? 'Some of your own sessions use models with no verified price, and COS’s own figure leaves some calls out too. Neither side is complete, so the share can be higher or lower.'
        : 'Some of your own sessions use models with no verified price. They aren’t in the total you ran, so it is higher than shown and COS’s share of it is lower.');
    }
    var compressed = Number(sessions.compressed) || 0, gone = Number(sessions.noLogs) || 0;
    if (compressed > 0) notes.push(uNum(compressed) + ' ' + (compressed === 1 ? 'session is' : 'sessions are') + ' compressed and could not be read, so their cost is not in these figures.');
    if (gone > 0) notes.push(uNum(gone) + ' ' + (gone === 1 ? 'session has' : 'sessions have') + ' no log left on this Mac, so their cost is not in these figures.');
    if (sessions.busy) notes.push('The usage history was busy, so this pass read nothing new. COS tries again soon.');
    if (sessions.failed) notes.push('COS could not read the usage history, so this pass read nothing new. It tries again in 5 minutes.');
    if (!report.runLedgersFound && overhead.some(function (r) { return r.category === 'answers' && r.calls > 0; })) notes.push('This server has no run records, so answers stay estimated.');
    var undated = Number(report.undatedCalls) || 0, unreadable = Number(report.unreadableRows) || 0;
    if (undated > 0) notes.push(uNum(undated) + ' ' + (undated === 1 ? 'call has' : 'calls have') + ' no readable date, so ' + (undated === 1 ? 'it isn’t' : 'they aren’t') + ' in these 30 days.');
    if (unreadable > 0) notes.push(uNum(unreadable) + ' ' + (unreadable === 1 ? 'line' : 'lines') + ' could not be read at all.');
    var approximate = cosSum(rows, 'approximateMatches');
    var method = [
      'Measured means the provider reported the tokens, in a session log or a record COS keeps. Estimated means COS only has the length of the text, so it divides characters by four and uses the model’s plain rate. Cache reads and system prompts aren’t in that, which is why an estimate says at least.',
      'Estimated figures stay out of every measured total. Rates are standard API rates, checked ' + (report.ratesCheckedOn ? uDayWords(report.ratesCheckedOn) : 'recently') + '. A model with no verified rate shows tokens and No price, never $0. A dollar figure that leaves out some calls with no rate ends in a +.',
      'The total you ran is what Usage counted in these 30 days, plus COS calls Usage can’t see because they keep no session log.',
      'A Work run counts from its start until you next typed in that session, another session messaged it, or its last turn finished. COS tells a typed turn from a tool result by the row’s type and never reads the words. Background work the run started counts as the run. With none of those endings in the log, a run has no provable end and stays in the wider figure only. The wider figure is everything in those sessions from the first run’s start, and it stays out of every share.'
    ];
    if (approximate > 0) method.push(uNum(approximate) + ' ' + (approximate === 1 ? 'call was' : 'calls were') + ' matched to ' + (approximate === 1 ? 'its run' : 'their runs') + ' by time and model, because older servers write no id. Newer rows carry one.');
    method.push('Only counts, dates and model names are read from these logs.');
    html += '<div class="sx-cost-foot">' + notes.map(function (n) { return '<p>' + esc(n) + '</p>'; }).join('') +
      '<details class="sx-how"><summary>How this is counted</summary>' + method.map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('') + '</details></div>';
    return html;
  }
  // One category (rowLine): what a person got, a bar (measured solid, an estimated floor paler
  // after it), and the dollars or the word for what the row has instead.
  function cosRowHtml(r, peak) {
    var title = (COS_CATS[r.category] || COS_CATS.other)[0];
    var tokens = uShort(r.measuredTokens + (r.measuredCalls === 0 ? r.estimatedTokens : 0)) + ' tokens';
    var count = r.calls > 0 ? cosCount(r.category, r.calls) : r.measuredTokens > 0 ? 'Counted by the day' : 'None in the last 30 days';
    var figure = '', detail = '', evidence = 'none', mix = [];
    if (r.calls > 0 || r.measuredTokens > 0) {
      if (r.measuredCalls > 0 && r.estimatedCalls > 0) {
        var rest = r.estimatedPricedCalls > 0 && r.estimatedPricedCalls < r.estimatedCalls ? uNum(r.estimatedPricedCalls) + ' of the ' + uNum(r.estimatedCalls) + ' others' : 'the rest';
        mix.push(uNum(r.measuredCalls) + ' measured' + (r.estimatedUSD > 0 ? ', ' + uAtLeast(r.estimatedUSD) + ' estimated for ' + rest : ', no verified price for the rest') + '.');
      }
      var partial = r.measuredUSD > 0 && (r.unpricedMeasuredCalls > 0 || r.unpricedLedgerTokens > 0);
      if (r.measuredUSD > 0 && r.unpricedMeasuredCalls > 0) mix.push(uNum(r.unpricedMeasuredCalls) + ' measured ' + (r.unpricedMeasuredCalls === 1 ? 'call has' : 'calls have') + ' no verified price, so the dollars are a floor.');
      if (r.measuredUSD > 0 && r.unpricedLedgerTokens > 0) mix.push(uShort(r.unpricedLedgerTokens) + ' tokens counted by the day have no verified price, so the dollars are a floor.');
      if (r.measuredUSD > 0) { evidence = 'measured'; figure = uMoney(r.measuredUSD) + (partial ? '+' : ''); detail = tokens + ', measured'; }
      else if (r.measuredTokens > 0 && r.estimatedCalls === 0) { evidence = 'noprice'; figure = 'No price'; detail = tokens; }
      else if (r.estimatedUSD > 0) { evidence = 'estimated'; figure = 'Estimated'; detail = uAtLeast(r.estimatedUSD); }
      else { evidence = 'noprice'; figure = 'No price'; detail = tokens; }
    }
    var m = peak > 0 ? Math.min(1, r.measuredUSD / peak) : 0, e = peak > 0 ? Math.min(1 - m, r.estimatedUSD / peak) : 0;
    return '<div class="sx-cost-row"><div class="sx-cost-name"><b>' + esc(title) + '</b><span>' + esc(count) + '</span>' + (mix.length ? '<span class="mix">' + esc(mix.join(' ')) + '</span>' : '') + '</div>' +
      '<div class="sx-cost-bar" aria-hidden="true">' + (m > 0 ? '<span class="m" style="width:' + (m * 100).toFixed(2) + '%"></span>' : '') + (e > 0 ? '<span class="e" style="width:' + (e * 100).toFixed(2) + '%"></span>' : '') + '</div>' +
      '<div class="sx-cost-fig ' + evidence + '">' + (figure ? '<b>' + esc(figure) + '</b>' : '') + (detail ? '<span>' + esc(detail) + '</span>' : '') + '</div></div>';
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
  var codeTimer = null;
  // A QR as inline SVG from vendor/qrcode-encoder.js (window.COSQR). Only numbers reach the
  // markup; the text is encoded, never inserted. Empty when the encoder did not load.
  function qrSvg(text) {
    if (!window.COSQR || !window.COSQR.matrix) return '';
    var m; try { m = window.COSQR.matrix(text); } catch (_e) { return ''; }
    var n = m.size, q = 4, d = '';
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (m.data[y * n + x]) d += 'M' + (x + q) + ' ' + (y + q) + 'h1v1h-1z';
    var w = n + q * 2;
    return '<svg class="qr" viewBox="0 0 ' + w + ' ' + w + '" role="img" aria-label="Sign-in QR code" shape-rendering="crispEdges"><rect width="' + w + '" height="' + w + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }
  function showDeviceCode() {
    var panel = $('device-code-panel');
    panel.classList.remove('hidden');
    panel.innerHTML = '<p>Getting a code</p>';
    api('/api/web-session/device-code', { method: 'POST', body: {} }).then(function (d) {
      var url = state.tailnetUrl || (location.origin + '/control');
      var exp = toDate(d.expiresAt);
      // The QR is the phone link with this code on it: the camera opens it, the page signs in
      // with the code (one use, five minutes), and nothing is typed. Same code, same rules.
      var link = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'code=' + encodeURIComponent(d.code);
      panel.innerHTML = qrSvg(link) +
        '<p class="qr-hint">Scan with your phone\'s camera to sign it in.</p>' +
        '<p>Or open <span class="url">' + esc(url) + '</span> on the phone and type this code:</p>' +
        '<span class="code">' + esc(d.code) + '</span>' +
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
      // The phone link is plain http by name, then by address. The https name link comes last:
      // the Mac's local certificate does not cover the Tailscale name, so Safari refuses it.
      state.tailnetUrl = d.magicDnsUrl || d.ipv4Url || d.magicDnsHttpsUrl || '';
      // Settings renders this line itself; fill it only if it is on screen now.
      var el = $('tailnet-url'); if (el) el.textContent = state.tailnetUrl || 'Tailscale is not running on the Mac';
    }).catch(function () { var el = $('tailnet-url'); if (el) el.textContent = 'Tailscale address unavailable'; });
  }

  // ── Ask sheet (⌘K) ──────────────────────────────────────
  var JUMPS = [
    ['today', 'Today'], ['messages', 'Messages'], ['speakers', 'Speakers'], ['meetings', 'Meetings'], ['memories', 'Memories'],
    ['threads', 'Threads'], ['sessions', 'Sessions'], ['work', 'Work'], ['dictation', 'Dictation'], ['usage', 'Usage'], ['settings', 'Settings']
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
    if (t.hasAttribute('data-goto') || t.hasAttribute('data-pane')) {
      if (inSheet) closeAsk(); closeMenu();
      // "work/sort" is a pane and its arguments, not one name.
      var dest = String(t.getAttribute('data-goto') || t.getAttribute('data-pane')).split('/');
      return go(dest[0], dest.slice(1));
    }
    if (t.hasAttribute('data-session')) { if (inSheet) closeAsk(); var p = t.getAttribute('data-session').split('|'); return go('sessions', [p[0], p.slice(1).join('|')]); }
    if (t.hasAttribute('data-meeting')) { var m = t.getAttribute('data-meeting').split('|'); return go('meetings', m); }
    if (t.hasAttribute('data-speakers')) return go('speakers', [t.getAttribute('data-speakers')]);
    var action = t.getAttribute('data-action');
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
    var q = $('ask-q').value.trim();
    if (action === 'ask-cos' && q) { askCos(q, $('ask-status')).then(function () { closeAsk(); go('messages'); }).catch(function () {}); return; }
    if (action === 'ask-meaning' && q) { $('ask-hits').innerHTML = skeletonRows(3); findByMeaning(q).then(function (html) { var el = $('ask-hits'); if (el) el.innerHTML = html; }); return; }
    if (action === 'ask-work' && q) {
      closeAsk(); go('work');
      // The Work pane (panes/work.js) owns its search box; hand it the query.
      if (PANES.work && PANES.work.search) PANES.work.search(q);
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
          // No status means the request never reached COS (the browser's own "Load failed").
          showAuth(err && err.status ? err.message : 'Could not reach COS on your Mac. Check that this phone is on Tailscale and the Mac is awake.');
        });
    } else if (f.id === 'session-form') sendSessionTurn(false);
    else if (f.id === 'sessions-search-form') { $('sessions-q').blur(); searchSessions(); }
    else if (f.id === 'ask-form') {
      var hits = $('ask-hits'); if (hits && $('ask-q').value.trim().length >= 2) renderAsk();
    }
  });

  document.addEventListener('input', function (e) {
    if (e.target.tagName === 'TEXTAREA') autoGrow(e.target);
    if (e.target.id === 'ask-q') renderAsk();
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
    // Coming back to the page refreshes Today in place. Other panes keep what is on screen:
    // rebuilding them here moved the page under Miles's finger ("it reloads the section").
    if (state.pane === 'today' && Date.now() - (state.lastLoad.today || 0) > 60000) { state.lastLoad.today = Date.now(); loadToday(); }
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
  // Copy that tells the truth: a plain-http tailnet page is not a secure context, so
  // navigator.clipboard is missing there. Fall back to a selected textarea, and reject when both
  // fail so no toast claims a copy that did not happen.
  function copyText(text) {
    return new Promise(function (resolve, reject) {
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = String(text == null ? '' : text);
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select(); ta.setSelectionRange(0, ta.value.length);
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (_e) { ok = false; }
        document.body.removeChild(ta);
        if (ok) resolve(); else reject(new Error('This browser would not copy. Select the text and copy it yourself.'));
      }
      if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) navigator.clipboard.writeText(String(text)).then(resolve, fallback);
      else fallback();
    });
  }

  // ── the shared kit for pane modules (panes/*.js) ───────
  window.COSWeb = {
    $: $, esc: esc, md: md, plain: plain, api: api, toast: toast, ago: ago, clock: clock, toDate: toDate,
    plural: plural, countWord: countWord, dayWord: dayWord, providerLabel: providerLabel, domainLabel: domainLabel,
    skeletonRows: skeletonRows, emptyBox: emptyBox, setStatus: setStatus, autoGrow: autoGrow,
    readStore: readStore, writeStore: writeStore, copyText: copyText, isPhone: isPhone,
    state: state, titles: TITLES, go: go, parseRoute: parseRoute, goBack: goBack,
    registerPane: function (name, def) { PANES[name] = def; },
    onRoute: function (fn) { routeHooks.push(fn); },
    onShell: function (fn) { shellHooks.push(fn); },
    // The detail title after "COS Control > Section" (Control's breadcrumb). Pane modules set it
    // once a detail has loaded; route() clears it on every navigation.
    setCrumb: function (text) { crumbDetail = String(text || ''); runHooks(routeHooks, parseRoute()); },
    crumb: function () { return crumbDetail; },
    // Panes that read with their own fetch call this on a 401 so the sign-in screen shows.
    showAuth: function (message) { showAuth(message); },
    // Control's session state (the Sessions pane's sxState) and warm-up test, so the rail's
    // "N waiting on you, N working" counts exactly what the pane lists.
    sessionState: function (s) { return sxState(s); },
    isKeepWarm: function (s) { return sxKeepWarm(s); }
  };

  // Every pane module is a plain script after this one; boot waits for all of them.
  function boot() {
    var params = new URLSearchParams(location.search);
    var linkCode = params.get('code');
    if (linkCode && !params.get('handoff')) {
      history.replaceState({}, document.title, location.pathname + location.hash);
      api('/api/web-session/login', { method: 'POST', body: { code: linkCode } }).then(showShell)
        .catch(function (err) {
          showAuth(err && err.status ? err.message : 'Could not reach COS on your Mac. Check that this phone is on Tailscale and the Mac is awake.');
          var box = $('auth-code'); if (box) box.value = linkCode;
        });
      return;
    }
    var handoff = params.get('handoff');
    if (handoff) {
      history.replaceState({}, document.title, location.pathname + location.hash);
      api('/api/web-session/login', { method: 'POST', body: { handoff: handoff } }).then(showShell)
        .catch(function (err) { showAuth(err && err.status ? err.message : 'That sign-in link did not work. Get a new one from COS Control on your Mac or the COS Glasses app, or use a code or the token.'); });
      return;
    }
    api('/api/web-session/status').then(function (st) { if (st && st.authenticated) showShell(st); else showAuth(); }).catch(function () { showAuth('COS on your Mac is not answering. Check that the Mac is awake and on Tailscale.'); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
