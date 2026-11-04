/* COS Control Web: the shell around the panes, mirroring Control's Activity window.
   - The rail's story line under each pane name (TodayHome.story, Models.swift 14738-14800).
   - The navigation bar off Today: Home, Back, "COS Control > Section > Detail", Settings.
   - The server line at the foot of the rail: "Server connected" or "Server not reachable".
   Stories read the same server routes Control's helper reads. They load with the shell, then
   every five minutes while the page is visible, and again when it comes back into view. */
(function () {
  'use strict';
  var W = window.COSWeb;
  var $ = W.$, esc = W.esc, api = W.api;

  // ── stories ───────────────────────────────────────────
  var FALLBACK = {
    today: 'Reading',
    messages: 'Questions and answers from your glasses',
    speakers: 'Voices from your meetings',
    meetings: 'Saved meetings by day',
    memories: 'What your COS can recall',
    threads: 'Work that develops over time',
    sessions: 'Claude, Codex and Cursor on this Mac',
    work: 'Your tasks and meeting follow-ups',
    dictation: 'Dictate anywhere on this Mac'
  };

  function setStory(name, text, hot) {
    document.querySelectorAll('[data-story="' + name + '"]').forEach(function (el) {
      el.textContent = text;
      el.classList.toggle('hot', !!hot);
    });
    document.querySelectorAll('.rail-btn[data-pane="' + name + '"]').forEach(function (b) {
      b.classList.toggle('hot', !!hot);
      b.title = (W.titles[name] || name) + ', ' + text;
    });
  }

  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function clock(d) { return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function monthDay(d) { return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  function toDate(v) {
    if (v == null || v === '') return null;
    var n = typeof v === 'number' ? v : (/^\d+$/.test(String(v)) ? Number(v) : NaN);
    var d = !isNaN(n) ? new Date(n > 1e10 ? n : n * 1000) : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
  function plural(n, one, many) { return n === 1 ? one : many; }
  // Quiet hours (Control 0.5.361): after 6 PM and on weekends, what needs you can wait until tomorrow.
  function quietNow(now) { var d = now.getDay(); return d === 0 || d === 6 || now.getHours() >= 18; }
  function soft(p) { return p.then(function (d) { return d; }, function () { return null; }); }

  // A meeting the Speakers pane would list as needing names (Control: Meetings to review).
  function needsNames(m) {
    var r = m && (m.voiceReview || m.review);
    return !!(r && Number(r.unattributedVoices) > 0 && !r.humanTouched);
  }
  function meetingDate(m) {
    var d = toDate(m && (m.date && m.time ? m.date + ' ' + m.time : m.date));
    return d;
  }

  var storyTimer = null;
  var storiesAt = 0;
  // About 16 reads: never two runs at once, never more than one a minute, and never ahead of
  // the pane the person just opened (Safari keeps 6 connections to the Mac over HTTP/1.1).
  // On the closed Duo (below 600px) the stories show only inside the section menu, so they load
  // when the menu opens rather than costing the pane its connections on every visit.
  function loadStories(force) {
    if (!force && W.isPhone()) return;
    if (Date.now() - storiesAt < 60000) return;
    storiesAt = Date.now();
    var now = new Date();
    var quiet = quietNow(now);

    // Sessions and Today share the sessions list and Work's your move.
    Promise.all([
      soft(api('/api/agent-sessions?limit=80&sort=updated')),
      soft(api('/api/work-board/your-move')),
      soft(api('/api/meetings/live-chunks'))
    ]).then(function (res) {
      var rows = (res[0] && res[0].sessions) || [];
      var moves = (res[1] && res[1].items) || [];
      var live = (res[2] && res[2].sessions) || [];
      // Control's rule (Models.swift isWorking / isWaiting) through the Sessions pane's own state:
      // working is running; waiting is waiting or failed; warm-up sessions never count.
      var real = rows.filter(function (s) { return !(W.isKeepWarm && W.isKeepWarm(s)); });
      var stateOf = W.sessionState || function (s) { return s.running_active || s.agent_state === 'running' ? 'running' : s.agent_state === 'waiting' ? 'waiting' : 'recent'; };
      var working = real.filter(function (s) { return stateOf(s) === 'running'; }).length;
      var waiting = real.filter(function (s) { var st = stateOf(s); return st === 'waiting' || st === 'error'; }).length;
      if (res[0]) {
        if (!waiting && !working) setStory('sessions', 'No agents running', false);
        else setStory('sessions', [waiting ? waiting + ' waiting on you' : '', working ? working + ' working' : ''].filter(Boolean).join(', '), waiting > 0);
      } else setStory('sessions', FALLBACK.sessions, false);

      var needs = waiting + moves.length;
      var folded = quiet ? needs : 0;
      // A fresh file is not proof of a recording: a meeting saved a minute ago still has one.
      // Ask each recent session the way Today does (live-chunks read: not ended, active lately).
      var recent = live.filter(function (s) { return Date.now() - (s.mtimeMs || 0) < 5 * 60000; }).slice(0, 3);
      Promise.all(recent.map(function (f) {
        return soft(api('/api/meetings/live-chunks?sessionId=' + encodeURIComponent(f.sessionId) + '&since=1000000')).then(function (r) {
          var read = r && r.read;
          return !!(read && !read.ended && Date.now() - Number(read.lastActivityAt || 0) < 5 * 60000);
        });
      })).then(function (flags) {
        var recordings = flags.filter(Boolean).length;
        var waitNow = needs - folded;
        var needText = waitNow > 0 ? (waitNow === 1 ? '1 needs you' : waitNow + ' need you')
          : folded > 0 ? folded + ' can wait until tomorrow'
          : (res[0] || res[1]) ? 'Nothing needs you' : "Couldn't read your Mac";
        if (recordings > 0) setStory('today', [recordings + ' recording', waitNow > 0 ? needText : ''].filter(Boolean).join(', '), true);
        else setStory('today', [needText, working ? working + ' running' : ''].filter(Boolean).join(', '), waitNow > 0);
      });

      // Work: your move (minus the sessions already counted as waiting), and the older-to-sort count.
      Promise.all([soft(api('/api/work-intake')), soft(api('/api/work-board'))]).then(function (w) {
        var items = (w[0] && (w[0].items || w[0].suggestions)) || [];
        var today = now.toISOString().slice(0, 10);
        var olderIntake = items.filter(function (it) {
          var st = it.status || it.state;
          if (st && ['suggested', 'review', 'ask'].indexOf(st) < 0) return false;
          var day = String((it.meeting && (it.meeting.filename || it.meeting.date)) || it.meetingFile || it.date || '').match(/\d{4}-\d{2}-\d{2}/);
          return !day || day[0] !== today;
        }).length;
        var tasks = (w[1] && (w[1].tasks || w[1].cards)) || [];
        var mentioned = tasks.filter(function (t) {
          if (t.workStage !== 'mentioned' || t.checked) return false;
          var ref = (t.meetingRefs && t.meetingRefs[0]) || (t.meetings && t.meetings[0]) || null;
          var day = String((ref && (ref.filename || ref.date)) || '').match(/\d{4}-\d{2}-\d{2}/);
          return !day || day[0] !== today;
        }).length;
        var older = w[0] || w[1] ? olderIntake + mentioned : null;
        var needsWork = moves.length;
        var foldedWork = quiet ? needsWork : 0;
        var needsNow = Math.max(0, needsWork - foldedWork);
        var bits = [];
        if (needsNow > 0) bits.push(needsNow === 1 ? '1 needs you' : needsNow + ' need you');
        if (foldedWork > 0) bits.push(foldedWork + ' can wait');
        if (older) bits.push(older + ' older to sort');
        if (bits.length) setStory('work', bits.join(', '), needsNow > 0);
        else setStory('work', older == null || !res[1] ? FALLBACK.work : 'Nothing to sort', false);
      });
    });

    // Messages: the morning brief that reached the glasses today, else the last message today.
    Promise.all([soft(api('/api/morning-brief')), soft(api('/api/sessions/today/all-messages?limit=5'))]).then(function (res) {
      var runs = (res[0] && res[0].runs) || [];
      var brief = runs.filter(function (r) { return r.status === 'completed'; })
        .map(function (r) { return toDate(r.firedAt); }).filter(Boolean)
        .sort(function (a, b) { return b - a; })[0];
      if (brief && sameDay(brief, now)) return setStory('messages', 'Morning brief reached the glasses at ' + clock(brief), false);
      var msgs = (res[1] && res[1].messages) || [];
      var last = msgs.map(function (m) { return toDate(m.timestamp); }).filter(Boolean).sort(function (a, b) { return b - a; })[0];
      if (last && sameDay(last, now)) return setStory('messages', 'Last from the glasses at ' + clock(last), false);
      setStory('messages', FALLBACK.messages, false);
    });

    // Speakers (TodayHome.things): each held voice counts one; today's meetings count their
    // unnamed voices (up to three meetings); every other meeting with unnamed voices counts one.
    Promise.all([soft(api('/api/voice/held-groups')), soft(api('/api/meetings?limit=30'))]).then(function (res) {
      if (!res[0] && !res[1]) return setStory('speakers', FALLBACK.speakers, false);
      var groups = (res[0] && res[0].groups) || [];
      var meetings = ((res[1] && res[1].meetings) || []).filter(function (m) { return m.sessionId && needsNames(m); });
      var n = groups.length, todayRows = 0;
      meetings.forEach(function (m) {
        var d = meetingDate(m);
        if (todayRows < 3 && d && sameDay(d, now)) { todayRows += 1; n += Math.max(1, Number((m.voiceReview || m.review).unattributedVoices) || 1); }
        else n += 1;
      });
      setStory('speakers', n > 0 ? (n === 1 ? '1 voice to name' : n + ' voices to name') : 'Every voice has a name', n > 0);
    });

    // Meetings: reviews ready, then the next calendar event (it counts until an hour past its start).
    Promise.all([soft(api('/api/work-reviews')), soft(api('/api/welcome-context'))]).then(function (res) {
      var reviews = (res[0] && (res[0].reviews || res[0].items)) || [];
      var ready = reviews.filter(function (r) { return r.status === 'ready'; }).length;
      var ev = res[1] && res[1].nextEvent;
      var start = ev && toDate(ev.time || ev.start || ev.startDate);
      var bits = [];
      if (ready > 0) bits.push(ready + ' ready to review');
      if (start && Date.now() - start.getTime() < 3600000) bits.push((bits.length ? 'next at ' : 'Next at ') + clock(start));
      setStory('meetings', bits.length ? bits.join(', ') : FALLBACK.meetings, false);
    });

    // Threads: "N active, newest <name>". Newest is the unresolved thread seen most recently.
    Promise.all([soft(api('/api/context/status')), soft(api('/api/threads?limit=50'))]).then(function (res) {
      var t = res[0] && res[0].threads;
      var active = t && t.available ? Number(t.active) || 0 : 0;
      if (!active) return setStory('threads', FALLBACK.threads, false);
      var list = ((res[1] && res[1].threads) || []).filter(function (x) { return !x.is_resolved; });
      list.sort(function (a, b) { return String(b.last_seen || b.created_at || '').localeCompare(String(a.last_seen || a.created_at || '')); });
      setStory('threads', active + ' active' + (list[0] && list[0].name ? ', newest ' + clip(list[0].name, 40) : ''), false);
    });

    // Memories (TodayHome.memoriesStory): n is the gated needs-you count (capped, from the
    // bridge's status, which runs the same CLI Control's helper runs); total is the number of
    // rows to review. "Next n of total" when there are more rows than n, else "n to review".
    Promise.all([
      soft(api('/api/web-bridge/memories', { method: 'POST', body: { id: 'rail-status', op: 'status', args: {} } })),
      soft(api('/api/context/learning/review?limit=200'))
    ]).then(function (res) {
      var n = res[0] && res[0].details ? res[0].details.learningToReview : null;
      if (typeof n !== 'number') return setStory('memories', FALLBACK.memories, false);
      if (n <= 0) return setStory('memories', 'Nothing to review', false);
      var total = res[1] && Array.isArray(res[1].events) ? res[1].events.length : null;
      setStory('memories', total != null && total > n ? 'Next ' + n + ' of ' + total : n + ' to review', true);
    });
    // Dictation lives on the Mac (its history and suggestions are local files).
    setStory('dictation', FALLBACK.dictation, false);
  }

  // ── server line ───────────────────────────────────────
  function setServer(ok) {
    document.querySelectorAll('[data-host-dot]').forEach(function (d) { d.classList.toggle('ok', ok); d.classList.toggle('bad', !ok); });
    document.querySelectorAll('[data-server-text]').forEach(function (t) { t.textContent = ok ? 'Server connected' : 'Server not reachable'; });
    document.querySelectorAll('[data-server-line]').forEach(function (l) { l.classList.toggle('down', !ok); });
  }
  function checkServer() {
    return api('/api/health').then(function (h) { setServer(!!h && h.status !== 'down'); }, function () { setServer(false); });
  }

  // ── navigation bar (Home, Back, breadcrumb, Settings) ──
  function paintNavbar(r) {
    var bar = $('navbar');
    if (!bar) return;
    var onToday = r.pane === 'today';
    bar.classList.toggle('hidden', onToday);
    document.body.classList.toggle('has-navbar', !onToday);
    var crumbs = $('crumbs');
    var section = r.pane === 'usage' ? 'Sessions' : (W.titles[r.pane] || '');
    var detail = W.crumb();
    var parts = ['<li class="crumb root">COS Control</li>'];
    if (r.pane === 'settings') parts.push('<li class="crumb current">Settings</li>');
    else {
      parts.push('<li class="crumb' + (detail || r.pane === 'usage' ? ' dim' : ' current') + '">' + esc(section) + '</li>');
      if (r.pane === 'usage') parts.push('<li class="crumb' + (detail ? ' dim' : ' current') + '">Usage</li>');
      if (detail) parts.push('<li class="crumb current detail">' + esc(detail) + '</li>');
    }
    crumbs.innerHTML = parts.join('');
    $('nav-back').disabled = onToday;
    // The phone top bar names the detail too, so a reader says where it is.
    var label = $('section-name');
    if (label && detail && W.isPhone()) label.textContent = detail;
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('#section-btn')) loadStories(true);
    var t = e.target.closest('#nav-home,#nav-back,#nav-settings');
    if (!t) return;
    if (t.id === 'nav-home') W.go('today');
    else if (t.id === 'nav-back') W.goBack();
    else W.go('settings');
  });
  document.addEventListener('keydown', function (e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    var tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    // ⌘0 Today, ⌘1 to ⌘8 the panes in rail order, ⌘← Back, ⌘⇧H Home (Control's shortcuts).
    var order = ['messages', 'speakers', 'meetings', 'memories', 'threads', 'sessions', 'work', 'dictation'];
    if (e.key === '0') { e.preventDefault(); W.go('today'); }
    else if (/^[1-8]$/.test(e.key)) { e.preventDefault(); W.go(order[Number(e.key) - 1]); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); W.goBack(); }
    else if (e.shiftKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); W.go('today'); }
  });

  W.onRoute(paintNavbar);
  W.onShell(function () {
    Object.keys(FALLBACK).forEach(function (k) { setStory(k, FALLBACK[k], false); });
    setTimeout(function () { loadStories(); checkServer(); }, 2500);
    clearInterval(storyTimer);
    storyTimer = setInterval(function () { if (!document.hidden) { loadStories(); checkServer(); } }, 5 * 60000);
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && document.querySelector('#app-shell:not(.hidden)')) { loadStories(); checkServer(); } });
  W.refreshStories = loadStories;
})();
