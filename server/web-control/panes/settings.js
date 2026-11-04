/* COS Control Web: Settings in Control's hub categories (SettingsHubCatalog.swift 25-146 and its
   groups). Rows the server owns work here: Decision models, Live cues, Fireflies import status,
   Morning brief, Task folders, Paused threads and Server status. Everything Control keeps on the
   Mac (preferences, the pet, dictation, keys, pairing, permissions) is named under its category
   as "On your Mac", so nothing looks missing and nothing security-related is offered here.
   "This browser" is the web's own group: appearance and browser sign-in.
   Keeps the ids and data attributes app.js already handles: data-theme-choice, #device-code-btn,
   #device-code-panel, #copy-link, #tailnet-url, #sign-out, data-action="revoke-all", #settings-status. */
(function () {
  'use strict';
  var W = window.COSWeb;
  var $ = W.$, esc = W.esc, api = W.api;
  var pane = $('pane-settings');
  var S = { data: null, state: 'idle' };

  var CATEGORIES = [
    { id: 'general', title: 'General', summary: 'How COS Control opens, its shortcut, Today and the setup guide.', mac: ['App', 'Activity home', 'Setup guide'] },
    { id: 'ai', title: 'AI and accounts', summary: 'The AI apps COS works through, your keys and the models behind Work.', mac: ['Your AI apps', 'Local model', 'Your own key', 'Search'] },
    { id: 'glasses', title: 'Glasses and iPhone', summary: 'Pair your glasses and phone, and how videos reach this Mac.', mac: ['Devices', 'Video uploads'] },
    { id: 'meetings', title: 'Meetings', summary: 'Recording, the meeting assistant, live cues and your meeting library.', mac: ['Recording', 'Meeting assistant', 'Library and sync'] },
    { id: 'dictation', title: 'Dictation', summary: 'Type by voice into any Mac app: shortcuts, sounds, text and AI polish.', mac: ['Dictation', 'Microphone', 'Shortcuts', 'Sounds and audio', 'Text', 'AI polish', 'History'] },
    { id: 'voice', title: 'Transcription and voice', summary: 'The engines and models that turn speech into text on this Mac.', mac: ['Voice setup', 'Models', 'Performance'] },
    { id: 'work', title: 'Work and agents', summary: 'Sessions, Work chat, background jobs, folders and the morning brief.', mac: ['Sessions', 'Work chat', 'Background', 'Folders and notes'] },
    { id: 'privacy', title: 'Privacy and permissions', summary: 'What COS can use on this Mac. Each permission turns on one feature.', mac: ['Permissions'] },
    { id: 'pet', title: 'Pet', summary: 'The session pet: its character, size and motion.', mac: ['Session pet', 'Characters'] },
    { id: 'system', title: 'System and updates', summary: 'The COS server on this Mac, app updates, and checks when something is off.', mac: ['App updates', 'Troubleshooting'] }
  ];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function soft(p) { return p.then(function (d) { return d; }, function () { return null; }); }
  function load(force) {
    if (S.state === 'loading' || (S.data && !force)) return;
    S.state = 'loading';
    Promise.all([
      soft(api('/api/decision-provider')), soft(api('/api/live-cues/v2/settings')), soft(api('/api/morning-brief')),
      soft(api('/api/domains')), soft(api('/api/agent-sessions/fences')), soft(api('/api/meeting-import/fireflies/status')),
      soft(api('/api/health'))
    ]).then(function (r) {
      S.data = { dp: r[0], cues: r[1], mb: r[2], domains: r[3], fences: r[4], ff: r[5], health: r[6] };
      S.state = 'ready';
      render();
    });
  }

  function row(name, desc, control) {
    return '<div class="cx-set-row"><div class="cx-set-text"><span class="cx-set-name">' + esc(name) + '</span>' +
      (desc ? '<span class="cx-set-desc">' + esc(desc) + '</span>' : '') + '</div>' + (control || '') + '</div>';
  }
  function value(text) { return '<span class="cx-set-value">' + esc(text) + '</span>'; }
  function toggle(on, attr, label) { return '<button type="button" class="switch" role="switch" aria-checked="' + !!on + '" aria-label="' + esc(label) + '" ' + attr + '></button>'; }
  function group(title, blurb, rows) {
    return '<div class="cx-set-group"><h3 class="cx-set-title">' + esc(title) + '</h3>' + (blurb ? '<p class="cx-set-blurb">' + esc(blurb) + '</p>' : '') +
      '<div class="cx-list">' + rows + '</div></div>';
  }
  function onMac(names) {
    return '<p class="cx-set-mac">On your Mac: ' + esc(names.join(', ')) + '. Change these in COS Control.</p>';
  }

  function browserGroup() {
    var choice = window.CosTheme ? window.CosTheme.choice() : 'system';
    var themeBtn = function (id, label) {
      var on = choice === id;
      return '<button type="button" class="cx-set-row cx-set-choice" data-theme-choice="' + id + '" aria-pressed="' + on + '"><span class="cx-set-name">' + esc(label) + '</span><span class="value">' + (on ? '<span class="check">✓</span>' : '') + '</span></button>';
    };
    return '<section class="cx-set-cat"><h2 class="cx-col-title">This browser</h2>' +
      group('Appearance', '', themeBtn('system', 'Match this device') + themeBtn('light', 'Light') + themeBtn('dark', 'Dark')) +
      group('Sign-in', '',
        '<button type="button" class="cx-set-row" id="device-code-btn"><span class="cx-set-text"><span class="cx-set-name">Sign in another device</span><span class="cx-set-desc">Shows a QR for your phone's camera, and a code to type.</span></span><span class="chev"></span></button>' +
        '<div id="device-code-panel" class="device-code hidden" aria-live="polite"></div>' +
        '<button type="button" class="cx-set-row" id="copy-link"><span class="cx-set-text"><span class="cx-set-name">Copy link for your phone</span><span class="cx-set-desc" id="tailnet-url">' + esc(W.state.tailnetUrl || 'Checking Tailscale') + '</span></span></button>' +
        '<button type="button" class="cx-set-row" id="sign-out"><span class="cx-set-text"><span class="cx-set-name">Sign out of this browser</span></span></button>' +
        '<button type="button" class="cx-set-row" data-action="revoke-all"><span class="cx-set-text"><span class="grow cx-set-name">Sign out every browser</span><span class="cx-set-desc">Ends every signed-in browser, copies included. Glasses and the phone app stay paired.</span></span></button>') +
      '</section>';
  }

  function categoryBody(cat) {
    var d = S.data || {};
    var out = '';
    if (cat.id === 'ai' && d.dp) {
      var p = d.dp.provider || '';
      var name = function (x) { return x === 'subq' ? 'SubQ' : x === 'jev' ? 'Jev' : x || 'Not set'; };
      var eff = d.dp.effective || {};
      out += group('Decision models', 'Jev or SubQ, for Work suggestions, done checks, Work search and ⌘K.',
        ['jev', 'subq'].map(function (x) {
          var on = p === x;
          return '<button type="button" class="cx-set-row cx-set-choice" data-set="provider" data-provider="' + x + '" aria-pressed="' + on + '"><span class="cx-set-text"><span class="cx-set-name">Use ' + name(x) + '</span><span class="cx-set-desc">' +
            (x === 'jev' ? 'Fast and cheap.' : 'Asks a yes or no question per match.') + '</span></span><span class="value">' + (on ? '<span class="check">✓</span>' : '') + '</span></button>';
        }).join('') +
        row('In use', 'Work suggestions, done checks and search.', value(['session', 'completion', 'search'].map(function (k) { return name(eff[k]); }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', '))));
    }
    if (cat.id === 'meetings') {
      if (d.cues) {
        var cap = d.cues.capability || {};
        out += group('Live cues', 'Short prompts on the glasses during a meeting, and their limits.',
          row('Live cues', d.cues.source === 'env' ? 'Set on the Mac by the server environment.' : 'Quiet suggestions on your glasses during meetings.', toggle(d.cues.enabled, 'data-set="cues"' + (d.cues.source === 'env' ? ' disabled' : ''), 'Live cues')) +
          (cap.model ? row('Model', '', value(String(cap.model))) : ''));
      }
      if (d.ff) {
        var imported = d.ff.counts && typeof d.ff.counts.imported === 'number' ? d.ff.counts.imported : null;
        out += group('Fireflies import', 'Bring Fireflies meetings into your library.',
          row('Keep importing', d.ff.keyConfigured ? 'New Fireflies meetings come in on their own.' : 'Add a Fireflies key on the Mac to import.', value(d.ff.keepImporting ? 'On' : 'Off')) +
          (imported != null ? row('Imported', 'Last ' + (d.ff.windowDays || 30) + ' days.', value(String(imported))) : ''));
      }
    }
    if (cat.id === 'dictation') {
      out += group('Dictionary', 'One dictionary for G2 meetings, Mac recordings and dictation.',
        '<button type="button" class="cx-set-row" data-go="dictation/dictionary"><span class="cx-set-text"><span class="cx-set-name">Open the dictionary</span><span class="cx-set-desc">Words and corrections, shared with the Mac.</span></span><span class="chev"></span></button>');
    }
    if (cat.id === 'work') {
      if (d.mb && d.mb.config) {
        var c = d.mb.config, st = d.mb.status || {};
        var days = (c.days || []).map(function (x) { return DAYS[x] || ''; }).filter(Boolean).join(' ');
        var next = st.nextRunAt ? new Date(st.nextRunAt) : null;
        var last = st.lastRun && st.lastRun.firedAt ? new Date(st.lastRun.firedAt) : null;
        out += group('Morning brief', 'A daily brief in your inbox.',
          row('Morning brief', 'Runs at ' + (c.time || '07:00') + (days ? ' on ' + days : '') + (c.timezone ? ', ' + c.timezone : '') + '.', toggle(c.enabled !== false, 'data-set="brief"', 'Morning brief')) +
          (next && !isNaN(next) ? row('Next run', '', value(next.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }))) : '') +
          (last && !isNaN(last) ? row('Last run', st.lastRun.status ? st.lastRun.status : '', value(last.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))) : ''));
      }
      if (d.domains && d.domains.domains) {
        out += group('Task folders', 'The areas your tasks are grouped by.', d.domains.domains.map(function (x) { return row(x.label || x.name, x.name, value(x.abbr || '')); }).join(''));
      }
      if (d.fences && d.fences.fences && d.fences.fences.length) {
        out += group('Paused threads', 'Threads COS stopped writing to. Shows only when one exists.', d.fences.fences.map(function (f) {
          return row(f.title || f.target || 'Thread', [f.provider, f.adapterReason].filter(Boolean).join(' · '), '<button type="button" class="cx-btn quiet" data-set="release" data-target="' + esc(f.target || '') + '">Release</button>');
        }).join(''));
      }
    }
    if (cat.id === 'system' && d.health) {
      var h = d.health, up = Number(h.uptime_seconds) || 0;
      out += group('Server', 'Status, restart and updates for the COS server.',
        row('Status', '', value(h.status === 'ok' ? 'Running' : String(h.status || 'Unknown'))) +
        row('Version', '', value(h.server_version || '')) +
        (up ? row('Up for', '', value(up >= 86400 ? Math.floor(up / 86400) + ' d ' + Math.floor((up % 86400) / 3600) + ' h' : Math.floor(up / 3600) + ' h ' + Math.floor((up % 3600) / 60) + ' min')) : '') +
        (h.claude ? row('Claude Code', '', value(String(h.claude).replace(/\s*\(.*\)$/, ''))) : '') +
        (h.codex ? row('Codex', '', value(String(h.codex))) : ''));
    }
    return out + onMac(cat.mac);
  }

  function render() {
    if (W.parseRoute().pane !== 'settings') return;
    var host = String(W.state.serverName || 'your Mac').replace(/-/g, ' ');
    pane.innerHTML = '<div class="cx">' +
      '<header class="cx-hero"><span class="cx-glyph"><svg class="icon"><use href="#i-settings"/></svg></span>' +
      '<div class="cx-hero-text"><h1 class="cx-title">Settings</h1><p class="cx-detail-line">COS on ' + esc(host) + '. Keys, permissions and glasses pairing change only on the Mac.</p></div>' +
      '<div class="cx-actions"><button type="button" class="cx-btn quiet" data-set="refresh"><svg class="icon"><use href="#i-refresh"/></svg>Refresh</button></div></header>' +
      browserGroup() +
      (S.state !== 'ready' ? '<div class="cx-list" style="margin-top:18px">' + W.skeletonRows(4) + '</div>' :
        CATEGORIES.map(function (cat) {
          return '<section class="cx-set-cat"><h2 class="cx-col-title">' + esc(cat.title) + '</h2><p class="cx-set-blurb">' + esc(cat.summary) + '</p>' + categoryBody(cat) + '</section>';
        }).join('')) +
      '<p class="status-line" id="settings-status"></p></div>';
  }

  function say(text, isError) { var el = $('settings-status'); if (el) { el.textContent = text; el.classList.toggle('error', !!isError); } }

  pane.addEventListener('click', function (e) {
    var go = e.target.closest('[data-go]');
    if (go) { var parts = go.getAttribute('data-go').split('/'); return W.go(parts[0], parts.slice(1)); }
    var t = e.target.closest('[data-set]');
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-set');
    if (act === 'refresh') { S.data = null; S.state = 'idle'; load(true); return render(); }
    if (act === 'provider') {
      api('/api/decision-provider', { method: 'PATCH', body: { provider: t.getAttribute('data-provider') } })
        .then(function () { W.toast('Saved'); S.data = null; S.state = 'idle'; load(true); }, function (err) { say(err.message, true); });
      return;
    }
    if (act === 'cues') {
      var on = t.getAttribute('aria-checked') === 'true';
      t.setAttribute('aria-checked', String(!on));
      api('/api/live-cues/v2/settings', { method: 'POST', body: { enabled: !on } })
        .then(function () { W.toast(!on ? 'Live cues on' : 'Live cues off'); }, function (err) { t.setAttribute('aria-checked', String(on)); say(err.message, true); });
      return;
    }
    if (act === 'brief') {
      var bon = t.getAttribute('aria-checked') === 'true';
      t.setAttribute('aria-checked', String(!bon));
      api('/api/morning-brief', { method: 'PUT', body: { enabled: !bon } })
        .then(function () { W.toast(!bon ? 'Morning brief on' : 'Morning brief paused'); }, function (err) { t.setAttribute('aria-checked', String(bon)); say(err.message, true); });
      return;
    }
    if (act === 'release') {
      if (t.getAttribute('data-armed') !== '1') { t.setAttribute('data-armed', '1'); t.textContent = 'Tap again to release'; return; }
      // The server fails closed without confirm; the second tap is the confirmation.
      api('/api/agent-sessions/fences/release', { method: 'POST', body: { target: t.getAttribute('data-target'), confirm: true } })
        .then(function () { W.toast('Released'); S.data = null; S.state = 'idle'; load(true); }, function (err) { say(err.message, true); });
    }
  });

  W.registerPane('settings', {
    load: function () { load(false); render(); }
  });
})();
