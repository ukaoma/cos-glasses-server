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
  var S = { data: null, state: 'idle', refreshing: false, refreshAt: 0, loadedAt: 0, failedAt: 0 };
  // The build after 7.0.43 (lead 19:09; W1's 17:0x note on fc4cb500): a second Refresh while one load runs starts
  // nothing, so a double tap cannot make the first answer land as a plain load. A refresh older than REFRESH_STUCK_MS no
  // longer counts as running, so a read that never answers cannot leave Refresh dead.
  var REFRESH_STUCK_MS = 30000;

  var CATEGORIES = [
    { id: 'general', title: 'General', summary: 'How COS Control opens, its shortcut, Today and the setup guide.', mac: ['App', 'Activity home', 'Setup guide'] },
    { id: 'ai', title: 'AI and accounts', summary: 'The AI apps COS works through, your keys and the models behind Work.', mac: ['Your AI apps', 'Local model', 'Your own key', 'Search'] },
    { id: 'glasses', title: 'Glasses, phone and web', summary: 'Pair your glasses and phone, and how videos reach this Mac.', mac: ['Devices', 'Video uploads'] },
    { id: 'meetings', title: 'Meetings', summary: 'Recording, the meeting assistant, live cues and your meeting library.', mac: ['Recording', 'Meeting assistant', 'Library and sync'] },
    { id: 'dictation', title: 'Dictation', summary: 'Type by voice into any Mac app: shortcuts, sounds, text and AI polish.', mac: ['Dictation', 'Microphone', 'Shortcuts', 'Sounds and audio', 'Text', 'AI polish', 'History'] },
    { id: 'voice', title: 'Transcription and voice', summary: 'The engines and models that turn speech into text on this Mac.', mac: ['Voice setup', 'Models', 'Performance'] },
    { id: 'work', title: 'Work and agents', summary: 'Sessions, Work chat, background jobs, folders and the morning brief.', mac: ['Sessions', 'Work chat', 'Background', 'Folders and notes'] },
    // 6.99.11 (Drop it P2): shown only when the server has the P2 settings and Drop it is on.
    { id: 'reach', title: 'COS reaching out', summary: 'What COS tells you about on its own, when it may interrupt, and your reminders.', mac: [], p2: true },
    { id: 'privacy', title: 'Privacy and permissions', summary: 'What COS can use on this Mac. Each permission turns on one feature.', mac: ['Permissions'] },
    { id: 'pet', title: 'Pet', summary: 'Which pet this browser shows, and where: on Today, in the top bar on a phone, or off. Size, motion and the Mac\u2019s own pet are set in COS Control.', mac: ['Session pet size and motion', 'Characters on the Mac'] },
    { id: 'system', title: 'System and updates', summary: 'The COS server on this Mac, app updates, and checks when something is off.', mac: ['App updates', 'Troubleshooting'] }
  ];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function soft(p) { return p.then(function (d) { return d; }, function () { return null; }); }
  // ── Pet (this browser) ──────────────────────────────────
  // Which pet Today shows here and whether it shows at all. Kept per browser (COSWeb.petPrefs), like the theme.
  // The Mac's own pet is changed in COS Control: the app does not watch its pet folder, so a change from here
  // would leave the Mac showing the old pet. Catalog: GET /api/web-pet/catalog (lib/web-pet-choice.ts).
  var PET = { catalog: null, state: 'idle', q: '' };
  function loadPetCatalog() {
    if (PET.state === 'loading' || PET.state === 'ready') return;
    PET.state = 'loading';
    api('/api/web-pet/catalog').then(function (c) { PET.catalog = c; PET.state = 'ready'; render(); },
      function () { PET.state = 'error'; render(); });
  }
  function petChoiceRow(pet, name, desc, preview, current) {
    var on = current === pet;
    return '<button type="button" class="cx-set-row cx-set-choice pet-choice" data-pet="' + esc(pet) + '" aria-pressed="' + on + '">' +
      (preview ? '<img class="pet-thumb" alt="" loading="lazy" src="' + esc(preview) + '">' : '<span class="pet-thumb"></span>') +
      '<span class="cx-set-text"><span class="cx-set-name">' + esc(name) + '</span>' + (desc ? '<span class="cx-set-desc">' + esc(desc) + '</span>' : '') + '</span>' +
      '<span class="value">' + (on ? '<span class="check">✓</span>' : '') + '</span></button>';
  }
  function petBody() {
    var prefs = W.petPrefs ? W.petPrefs() : { pet: 'mac', show: true };
    // 7.0.33 A13 (Anand round 2, slide 9): where the pet shows, one of three, in the choice rows Character uses.
    var where = !prefs.show ? 'off' : prefs.place === 'bar' ? 'bar' : 'today';
    var placeRow = function (v, name, desc) {
      return '<button type="button" class="cx-set-row cx-set-choice" data-set="pet-place" data-place="' + v + '" aria-pressed="' + (where === v) + '">' +
        '<span class="cx-set-text"><span class="cx-set-name">' + esc(name) + '</span><span class="cx-set-desc">' + esc(desc) + '</span></span>' +
        '<span class="value">' + (where === v ? '<span class="check">✓</span>' : '') + '</span></button>';
    };
    var out = group('On this browser', 'Where the pet shows here. The pet on your Mac stays as it is.',
      placeRow('today', 'On Today', 'As it has been: on Today, with what it is doing under it.') +
      placeRow('bar', 'In the top bar', 'On a phone: small, beside Ask, on every page. Tap it to see what it is doing. The Duo shows it on Today.') +
      placeRow('off', 'Off', 'No pet in this browser.'));
    if (PET.state === 'idle') loadPetCatalog();
    if (PET.state !== 'ready') {
      return out + group('Character', '', PET.state === 'error'
        ? '<p class="cx-set-row">Could not load the pets. <button type="button" class="cx-btn quiet" data-set="pet-retry">Try again</button></p>'
        : W.skeletonRows(3));
    }
    var c = PET.catalog || {}, shipped = c.shipped || [], gallery = c.gallery || [];
    out += group('Character', 'The pet this browser shows on Today. It does not change the pet on your Mac.',
      petChoiceRow('mac', 'Same as my Mac', c.mac && c.mac.available ? 'Follows the pet COS Control shows.' : 'Your Mac has no pet set.', c.mac && c.mac.preview, prefs.pet) +
      shipped.map(function (p) { return petChoiceRow(p.pet, p.name, p.summary || (p.animated ? 'Animated.' : ''), p.preview, prefs.pet); }).join(''));
    if (gallery.length) {
      var picked = gallery.filter(function (p) { return p.pet === prefs.pet; })[0];
      out += '<div class="cx-set-group"><h3 class="cx-set-title">Gallery</h3><p class="cx-set-blurb">' + gallery.length +
        ' pets from the OpenPets gallery COS Control uses. Each shows as one still picture, as it does on the Mac.' + (picked ? ' In use: ' + esc(picked.name) + '.' : '') + '</p>' +
        '<input type="search" class="pet-search" id="pet-search" placeholder="Search the gallery" aria-label="Search the gallery" value="' + esc(PET.q) + '">' +
        '<div class="pet-grid" id="pet-grid">' + gallery.map(function (p) {
          var on = p.pet === prefs.pet, words = (p.name + ' ' + p.category + ' ' + p.description).toLowerCase();
          return '<button type="button" class="pet-tile" data-pet="' + esc(p.pet) + '" data-words="' + esc(words) + '" aria-pressed="' + on + '" title="' + esc(p.description || p.name) + '">' +
            '<img alt="" loading="lazy" src="' + esc(p.preview) + '"><span>' + esc(p.name) + '</span></button>';
        }).join('') + '</div><p class="cx-set-blurb hidden" id="pet-none">No pets match that search.</p></div>';
    }
    return out;
  }
  function filterPets() {
    var q = PET.q.trim().toLowerCase(), grid = $('pet-grid'), shown = 0;
    if (!grid) return;
    grid.querySelectorAll('.pet-tile').forEach(function (t) {
      var hit = !q || (t.getAttribute('data-words') || '').indexOf(q) >= 0;
      t.classList.toggle('hidden', !hit); if (hit) shown++;
    });
    var none = $('pet-none'); if (none) none.classList.toggle('hidden', shown > 0);
  }

  function load(force) {
    if (S.state === 'loading' || (S.data && !force)) return;
    S.state = 'loading';
    Promise.all([
      soft(api('/api/decision-provider')), soft(api('/api/live-cues/v2/settings')), soft(api('/api/morning-brief')),
      soft(api('/api/domains')), soft(api('/api/agent-sessions/fences')), soft(api('/api/meeting-import/fireflies/status')),
      soft(api('/api/health')), soft(api('/api/drops/settings/p2')), soft(api('/api/today/brief/settings')),
      soft(api('/api/session-files/settings')), soft(api('/api/preview-folders/settings'))
    ]).then(function (r) {
      var next = { dp: r[0], cues: r[1], mb: r[2], domains: r[3], fences: r[4], ff: r[5], health: r[6], p2: r[7], tb: r[8], sf: r[9], pf: r[10] };
      // F1 (A4): on a refresh, a section whose read failed keeps what it showed; if every read failed, the page stays
      // as it was and one line says so.
      var old = S.refreshing ? S.data : null;
      if (old) Object.keys(next).forEach(function (k) { if (next[k] == null && old[k] != null) next[k] = old[k]; });
      var allFailed = !!old && r.every(function (x) { return x == null; });
      S.data = next; S.state = 'ready';
      if (allFailed) S.failedAt = Date.now(); else { S.loadedAt = Date.now(); S.failedAt = 0; }
      render(); S.refreshing = false;
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
    // 7.0.53 (Miles 23:39, the lead's R3): the look, per device, built like the theme rows. Amber is the default; Espresso is
    // the look from before Amber. It changes at once, in this browser only (theme.js CosLook): no request, nothing counted.
    var look = window.CosLook ? window.CosLook.choice() : 'amber';
    var lookBtn = function (id, label) {
      var on = look === id;
      return '<button type="button" class="cx-set-row cx-set-choice" data-look-choice="' + id + '" aria-pressed="' + on + '"><span class="cx-set-name">' + esc(label) + '</span><span class="value">' + (on ? '<span class="check">✓</span>' : '') + '</span></button>';
    };
    var story = window.CosStorySize ? window.CosStorySize.choice() : 'auto';
    var storyBtn = function (id, label, desc) {
      var on = story === id;
      return '<button type="button" class="cx-set-row cx-set-choice" data-story-choice="' + id + '" aria-pressed="' + on + '"><span class="cx-set-text"><span class="cx-set-name">' + esc(label) + '</span>' +
        (desc ? '<span class="cx-set-desc">' + esc(desc) + '</span>' : '') + '</span><span class="value">' + (on ? '<span class="check">✓</span>' : '') + '</span></button>';
    };
    return '<section class="cx-set-cat"><h2 class="cx-col-title">This browser</h2>' +
      group('Appearance', '', themeBtn('system', 'Match this device') + themeBtn('light', 'Light') + themeBtn('dark', 'Dark')) +
      group('Look', '', lookBtn('amber', 'Amber') + lookBtn('espresso', 'Espresso')) +
      // F1 (Miles 11/13 23:02): the size of Today's summary on this device, built like the theme rows (app.js paintStorySize).
      group('Today summary size', '', storyBtn('auto', 'Automatic', 'Small on a narrow screen, Medium on a wide one') + storyBtn('large', 'Large', '') +
        storyBtn('medium', 'Medium', '') + storyBtn('small', 'Small', '')) +
      group('Sign-in', '',
        '<button type="button" class="cx-set-row" id="device-code-btn"><span class="cx-set-text"><span class="cx-set-name">Use COS on another phone or browser</span><span class="cx-set-desc">A QR for your phone’s camera, and a code to type. This is not glasses pairing; pair glasses from COS Control on your Mac.</span></span><span class="chev"></span></button>' +
        '<div id="device-code-panel" class="device-code hidden" aria-live="polite"></div>' +
        '<button type="button" class="cx-set-row" id="copy-link"><span class="cx-set-text"><span class="cx-set-name">Copy link for your phone</span><span class="cx-set-desc" id="tailnet-url">' + esc(W.state.tailnetUrl || 'Checking Tailscale') + '</span></span></button>' +
        '<button type="button" class="cx-set-row" id="sign-out"><span class="cx-set-text"><span class="cx-set-name">Sign out of this browser</span></span></button>' +
        '<button type="button" class="cx-set-row" data-action="revoke-all"><span class="cx-set-text"><span class="grow cx-set-name">Sign out every browser</span><span class="cx-set-desc">Ends every signed-in browser, copies included. Glasses and the phone app stay paired.</span></span></button>') +
      '</section>';
  }

  // ── COS reaching out (6.99.11) ──────────────────────────
  // A subscription belongs to this origin. No worker or permission prompt runs on load.
  var PUSH = { loaded: false, known: false, reading: false, generation: 0, busy: false, key: null, productionAllowed: false, subscription: null, current: null, devices: [], error: '' };
  function pushOn() { return !!(S.data && S.data.health && S.data.health.features && S.data.health.features.webPush === true); }
  function pushManager() { return window.isSecureContext && window.pushManager ? window.pushManager : null; }
  function pushHome() { return !!(window.navigator && window.navigator.standalone) || !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches); }
  function pushProblem() {
    if (!window.isSecureContext) return 'Open COS over trusted HTTPS to set up phone pings.';
    if (!pushHome()) return 'Add COS to your Home Screen, then open that app to set up phone pings.';
    if (!pushManager()) return 'This phone needs a compatibility check before pings can be set up.';
    if (window.Notification && window.Notification.permission === 'denied') return 'Notifications are blocked for COS. Allow them in your phone settings, then reopen COS.';
    return '';
  }
  function pushLoad() {
    if (!pushOn() || PUSH.loaded) return;
    PUSH.loaded = true; PUSH.reading = true;
    var generation = ++PUSH.generation, manager = pushManager();
    function current() { return generation === PUSH.generation && !PUSH.busy; }
    function apply(r, device, sub) {
      if (!current()) return;
      PUSH.devices = r[0].devices || []; PUSH.subscription = sub; PUSH.current = device;
      PUSH.productionAllowed = r[2].productionEnabled; PUSH.known = true; PUSH.reading = false;
      render();
    }
    Promise.all([api('/api/web-push/devices'), manager ? manager.getSubscription() : Promise.resolve(null), api('/api/web-push/status')]).then(function (r) {
      if (!current()) return;
      if (!r[2] || r[2].enabled !== true || typeof r[2].productionEnabled !== 'boolean') throw new Error('status');
      if (!r[1]) return apply(r, null, null);
      return api('/api/web-push/subscription/status', { method: 'POST', body: { endpoint: r[1].endpoint } }).then(function (answer) {
        if (!current()) return;
        if (answer.device) return apply(r, answer.device, r[1]);
        // A remotely removed device stops receiving immediately. No new opt-in can race browser cleanup.
        PUSH.busy = true; render();
        return r[1].unsubscribe().then(function () {
          PUSH.busy = false; apply(r, null, null);
        }, function () { PUSH.busy = false; throw new Error('unsubscribe'); });
      });
    }).catch(function () {
      if (!current()) return;
      PUSH.reading = false; PUSH.error = 'Phone pings could not be checked. Refresh to try again.'; render();
    });
  }
  function pushBody() {
    if (!pushOn()) return '';
    pushLoad();
    // Until the first complete reconciliation, neither the boot gate nor this phone's subscription is known.
    if (!PUSH.known) return group('Phone pings', '', row('This phone', PUSH.reading ? 'Checking phone pings…' : 'Phone pings could not be checked. Refresh to try again.', value(PUSH.reading ? 'Checking' : 'Unavailable')));
    var current = PUSH.current, on = current && current.production, problem = pushProblem();
    var control = on ? '<button type="button" class="btn cx-push-action" data-set="push-off"' + (PUSH.busy ? ' disabled' : '') + '>Stop pings to this phone</button>' :
      '<button type="button" class="btn cx-push-action" data-set="push-on"' + (PUSH.busy || problem ? ' disabled' : '') + '>' + (PUSH.key ? 'Allow pings on this phone' : 'Send pings to this phone') + '</button>';
    var rows = PUSH.productionAllowed ? row('This phone', problem || (on ? 'On. Uses the same kinds, quiet hours and interruption limits as your Mac.' : PUSH.key ? 'Tap Allow to let COS ask your phone for notification permission.' : 'Off. Setup takes two taps; permission comes from your phone.'), control) : '';
    if (on && PUSH.productionAllowed) rows += row('Show the words', 'Off shows only COS and the kind. On includes the first line, up to 100 characters. Your phone controls lock-screen previews.', toggle(current.showWords, 'data-set="push-words"', 'Show the words on this phone'));
    rows += row('Test this phone', PUSH.productionAllowed ? 'Send a test notification to this phone.' : 'Temporary delivery check: tap Send test ping, close COS and lock the phone within 15 seconds. Check three pings arrive within one minute each and open COS when tapped. Tests are at least 10 seconds apart, with a limit of 20 a day. Remove the test device afterward.',
      current ? '<button type="button" class="btn cx-push-action" data-set="push-test"' + (PUSH.busy ? ' disabled' : '') + '>Send test ping</button>' :
      '<button type="button" class="btn cx-push-action" data-set="push-test-on"' + (PUSH.busy || problem ? ' disabled' : '') + '>' + (PUSH.key ? 'Allow test pings on this phone' : 'Set up test pings') + '</button>');
    if (!PUSH.productionAllowed) rows += row('Production pings', 'Off. Test delivery does not enable COS notifications.', value('Off'));
    if (problem && !PUSH.productionAllowed) rows += '<p class="cx-set-blurb">' + esc(problem) + '</p>';
    PUSH.devices.forEach(function (d) {
      rows += row(d.label, 'Added ' + String(d.addedAt || '').slice(0, 10) + (current && current.id === d.id ? ' · This phone' : ''),
        '<button type="button" class="btn cx-push-action" data-set="push-remove" data-device="' + esc(d.id) + '"' + (PUSH.busy ? ' disabled' : '') + '>Remove</button>');
    });
    if (PUSH.error) rows += '<p role="status" class="cx-set-blurb">' + esc(PUSH.error) + '</p>';
    return group('Phone pings', 'The Mac sends encrypted notifications through Apple. Apple sees delivery timing, not the words. The Mac must be awake and online.', rows);
  }
  function pushFinish() { ++PUSH.generation; PUSH.busy = false; PUSH.reading = false; render(); }
  function pushError() { PUSH.error = 'Phone pings could not be saved. Try again.'; pushFinish(); }
  function pushRemove(id) {
    ++PUSH.generation; PUSH.busy = true; PUSH.error = ''; render();
    api('/api/web-push/devices/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
      PUSH.devices = PUSH.devices.filter(function (d) { return d.id !== id; });
      if (!PUSH.current || PUSH.current.id !== id) return;
      PUSH.current = null;
      var sub = PUSH.subscription;
      if (sub) return sub.unsubscribe().then(function (ok) {
        if (!ok) throw new Error('unsubscribe');
        PUSH.subscription = null;
      }, function () { throw new Error('unsubscribe'); });
    }).then(function () { PUSH.error = 'Device removed. COS will send no more pings to it.'; pushFinish(); }, function () { PUSH.error = 'Delivery has stopped if the device was removed. Refresh to check and finish turning off this phone.'; pushFinish(); });
  }
  function pushClick(act, button) {
    if (!pushOn() || PUSH.busy || !PUSH.known) return;
    if (act === 'push-remove') return pushRemove(button.getAttribute('data-device'));
    if (act === 'push-off' && PUSH.current) return pushRemove(PUSH.current.id);
    if (act === 'push-words' && PUSH.current) {
      ++PUSH.generation; PUSH.busy = true;
      var words = !PUSH.current.showWords;
      return api('/api/web-push/devices/' + encodeURIComponent(PUSH.current.id), { method: 'PATCH', body: { showWords: words } }).then(function () { PUSH.current.showWords = words; pushFinish(); }, pushError);
    }
    if (act === 'push-test' && PUSH.current) {
      ++PUSH.generation; PUSH.busy = true; PUSH.error = 'Scheduling test ping…'; render();
      return api('/api/web-push/test', { method: 'POST', body: { deviceId: PUSH.current.id, delaySeconds: 15 } }).then(function (answer) {
        PUSH.error = answer.scheduled === true ? (PUSH.productionAllowed ? 'Test ping scheduled. Check your phone in 15 seconds.' : 'Test scheduled in 15 seconds. Close COS and lock your phone now. A server restart cancels this test.') : 'Test ping could not be scheduled.';
        pushFinish();
      }, function () { PUSH.error = 'Test ping could not be scheduled. Wait at least 10 seconds before trying again.'; pushFinish(); });
    }
    if ((act !== 'push-on' && act !== 'push-test-on') || pushProblem()) return;
    var production = act === 'push-on';
    if (production && !PUSH.productionAllowed) return;
    ++PUSH.generation;
    if (!PUSH.key) {
      PUSH.busy = true; PUSH.error = ''; render();
      // Prepare the key on the first explicit opt-in tap. The next tap calls subscribe immediately, keeping Safari's gesture.
      return api('/api/web-push/key').then(function (answer) {
        var raw = window.atob(answer.publicKey.replace(/-/g, '+').replace(/_/g, '/'));
        PUSH.key = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) PUSH.key[i] = raw.charCodeAt(i);
        pushFinish();
      }).catch(pushError);
    }
    var subscribing;
    try { subscribing = pushManager().subscribe({ userVisibleOnly: true, applicationServerKey: PUSH.key }); }
    catch (err) { pushError(); return; }
    PUSH.busy = true; PUSH.error = ''; render();
    var subscribed;
    return subscribing.then(function (sub) {
      subscribed = sub;
      return api('/api/web-push/devices', { method: 'POST', body: { subscription: sub.toJSON(), label: production ? 'Phone' : 'Phone test', production: production, showWords: false } });
    }).then(function (answer) {
      PUSH.subscription = subscribed;
      PUSH.current = { id: answer.id, label: production ? 'Phone' : 'Phone test', production: production, showWords: false, addedAt: new Date().toISOString() };
      PUSH.devices = PUSH.devices.filter(function (d) { return d.id !== answer.id; }).concat([PUSH.current]);
      pushFinish();
    }, function () {
      // A refused server write must not leave a newly permitted orphan subscription.
      if (subscribed && !PUSH.subscription) subscribed.unsubscribe().then(function () {}, function () {});
      pushError();
    });
  }

  function p2On() {
    var d = S.data || {}, cap = d.health && d.health.capabilities && d.health.capabilities.dropIt;
    return !!(cap && cap.enabled && cap.p2Settings && d.p2 && d.p2.settings);
  }
  function p2Get(path) { return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, S.data.p2.settings); }
  function p2Switch(path, label) { return toggle(p2Get(path), 'data-set="p2" data-p2="' + path + '"', label); }
  function p2Num(path, min, max, label) {
    return '<input type="number" class="field cx-set-num" inputmode="numeric" data-p2="' + path + '" min="' + min + '" max="' + max + '" value="' + esc(String(p2Get(path))) + '" aria-label="' + esc(label) + '">';
  }
  function p2Time(path, label) { return '<input type="time" class="field cx-set-time" data-p2="' + path + '" value="' + esc(String(p2Get(path))) + '" aria-label="' + esc(label) + '">'; }
  function p2Text(path, label, hint) {
    return '<textarea class="field cx-set-steer" rows="2" maxlength="300" data-p2="' + path + '" aria-label="' + esc(label) + '" placeholder="' + esc(hint) + '">' + esc(String(p2Get(path) || '')) + '</textarea>';
  }
  var FULL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function reachBody() {
    var day = p2Get('checkin.weekday');
    return pushBody() + group('Pings', 'COS posts these in the COS chat. They interrupt you only within these limits.',
        row('Pings', 'Turn off to keep COS from posting on its own. Reminders and follow-ups on your drops still come.', p2Switch('pings.on', 'Pings')) +
        row('Interruptions a day', 'On a weekday. Reminders do not count.', p2Num('pings.dailyCap', 0, 20, 'Interruptions a day')) +
        row('From one kind a day', '', p2Num('pings.perSource', 1, 10, 'Interruptions from one kind a day')) +
        row('Minutes between', 'The shortest gap between two interruptions.', p2Num('pings.gapMinutes', 0, 240, 'Minutes between interruptions')) +
        row('Quiet from', 'No interruption and no new work ping from this time.', p2Time('pings.quietStart', 'Quiet from')) +
        row('Quiet until', 'What waited posts as one item after this.', p2Time('pings.quietEnd', 'Quiet until')) +
        row('Weekends are quiet', '', p2Switch('pings.weekendsQuiet', 'Weekends are quiet')) +
        row('First interruption', 'The earliest a weekday interruption comes.', p2Time('pings.firstBanner', 'First interruption'))) +
      group('What COS pings about', 'Each lands in the COS chat.',
        row('Meeting prep', '15 minutes before your next meeting.', p2Switch('pings.sources.prep', 'Meeting prep')) +
        row('Agents finishing', 'When a session you sent work to ends its turn.', p2Switch('pings.sources.agent', 'Agents finishing')) +
        row('Follow-ups ready', 'When a meeting leaves follow-ups to review.', p2Switch('pings.sources.followups', 'Follow-ups ready')) +
        row('Threads gone quiet', 'At most once a week for each thread.', p2Switch('pings.sources.stale', 'Threads gone quiet')) +
        row('Red signals', 'A signal the system marks red.', p2Switch('pings.sources.signals', 'Red signals'))) +
      group('Steer', 'Words, matched whole. COS reads no more than this into them.',
        row('Ping me about', 'A ping that mentions one of these may interrupt you, even when its kind stays in the chat.', p2Text('steer.about', 'Ping me about', 'JCK, Rain, pricing')) +
        row('Leave alone', 'A ping that mentions one of these is not posted. Your reminders and follow-ups always are.', p2Text('steer.leaveAlone', 'Leave alone', 'HubDB, standup'))) +
      group('Follow-ups on your drops', 'One line under the drop when what it became resolves.',
        row('Follow-ups', '', p2Switch('followUps.on', 'Follow-ups')) +
        row('Work cards', 'At QA, complete or archived.', p2Switch('followUps.kinds.card', 'Work cards')) +
        row('Handoffs', 'Finished, failed or refused.', p2Switch('followUps.kinds.handoff', 'Handoffs')) +
        row('Sessions', 'Replied or stopped.', p2Switch('followUps.kinds.session', 'Sessions')) +
        row('Threads', 'Resolved or gone quiet.', p2Switch('followUps.kinds.thread', 'Threads'))) +
      group('Weekly check-in', 'COS asks what you do not want to forget this week. Your reply becomes a reminder.',
        row('Check-in', '', p2Switch('checkin.on', 'Weekly check-in')) +
        row('Day', '', '<select class="field cx-set-day" data-p2="checkin.weekday" aria-label="Check-in day">' + FULL_DAYS.map(function (n, i) {
          return '<option value="' + i + '"' + (i === day ? ' selected' : '') + '>' + n + '</option>';
        }).join('') + '</select>') +
        row('Time', '', p2Time('checkin.time', 'Check-in time'))) +
      group('Reminders', 'The ones you set by saying remind me.',
        row('Default time', 'What a day alone means, and the time for Tomorrow and Monday.', p2Time('reminders.defaultTime', 'Default reminder time')) +
        row('Snooze for', 'Minutes.', p2Num('reminders.snoozeMinutes', 5, 1440, 'Snooze minutes')) +
        row('Notify me', 'A reminder notifies you at any hour.', p2Switch('reminders.banners', 'Reminder notifications')) +
        row('Show on the glasses', 'For the glasses build that shows COS on the lens.', p2Switch('reminders.lensPush', 'Show reminders on the glasses'))) +
      group('Which may interrupt', 'The rest land in the COS chat without a notification.',
        row('Follow-ups on your drops', '', p2Switch('banners.resolution', 'Follow-ups on your drops may interrupt')) +
        row('Meeting prep', '', p2Switch('banners.prep', 'Meeting prep may interrupt')) +
        row('Agents finishing', '', p2Switch('banners.agent', 'Agents finishing may interrupt')) +
        row('Follow-ups ready', '', p2Switch('banners.followups', 'Follow-ups ready may interrupt')) +
        row('Threads and signals', '', p2Switch('banners.stale', 'Threads and signals may interrupt')) +
        row('Weekly check-in', '', p2Switch('banners.checkin', 'Weekly check-in may interrupt')));
  }
  /** One field as the partial PUT the server merges: "pings.sources.prep" becomes { pings: { sources: { prep: v } } }. */
  function p2Patch(path, v) {
    var keys = path.split('.'), out = {}, at = out;
    for (var i = 0; i < keys.length - 1; i++) { at[keys[i]] = {}; at = at[keys[i]]; }
    at[keys[keys.length - 1]] = v;
    return out;
  }
  function p2Save(path, v, undo) {
    return api('/api/drops/settings/p2', { method: 'PUT', body: p2Patch(path, v) }).then(function (ans) {
      if (ans && ans.settings) S.data.p2.settings = ans.settings;
      W.toast('Saved');
      return ans;
    }, function (err) { if (undo) undo(); say((err && err.message) || 'That did not save.', true); });
  }

  // One line under the Today summary toggle: paused until, today's cap reached, or the last call failed (GET /api/today/brief/settings status).
  function briefStatus(tb) {
    var st = tb && tb.enabled && tb.status;
    if (!st) return '';
    var at = function (iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
    if (st.kind === 'paused') return 'Paused after three failed tries. It tries again at ' + at(st.until) + '.';
    // 7.0.5: the number is the "Summaries per day" setting (an older server sends only the count).
    if (st.kind === 'daily_cap') { var n = typeof st.cap === 'number' ? st.cap : st.count; return 'Today\u2019s ' + n + (n === 1 ? ' summary is' : ' summaries are') + ' used. It writes again tomorrow.'; }
    if (st.kind === 'failed') return 'The last try failed at ' + at(st.at) + (st.code === 'timeout' ? ' (it took too long).' : st.code === 'unavailable' ? ' (Claude Code was not found on your Mac).' : '.');
    return '';
  }
  // 6.99.35: "Show files and images your sessions make" (GET/POST /api/session-files/settings, lib/session-files-setting.ts).
  // On by default. COS_WEB_SESSION_FILES=0 on the Mac forces it off; the row then says so and cannot be changed here.
  function sessionFilesGroup(d) {
    var sf = d && d.sf;
    if (!sf || typeof sf.enabled !== 'boolean') return '';
    var env = sf.source === 'env';
    // QA 7.0.0: a saved setting the Mac could not read fails closed (off). The row says so; turning it on saves it again.
    return group('Session files', '',
      // 7.0.4: the switch also covers screenshots, images a session opened and images attached to prompts, so it says so.
      row('Show session files, screenshots and images',
        env ? 'Turned off on the Mac by the server environment (COS_WEB_SESSION_FILES=0).'
          : sf.source === 'damaged' ? 'Couldn’t read the saved setting, so previews are off. Turn it on to save it again.'
          : 'Lets this page show the files and images your sessions send you, the screenshots and images they open, and images attached to your prompts. Files stay on your Mac.',
        toggle(sf.enabled, 'data-set="session-files"' + (env ? ' disabled' : ''), 'Show session files, screenshots and images')) +
      previewFoldersRows(d.pf));
  }
  // 7.0.5 (preview engine, Miles decision 2b): extra folders a session's linked or sent files may open from, besides its
  // own project folder (GET/POST /api/preview-folders/settings). Empty by default; each folder is listed by name and
  // removed one at a time. The server refuses broad folders (home, Documents, Library, /) and says why.
  function previewFoldersRows(pf) {
    if (!pf || !Array.isArray(pf.folders)) return '';
    var list = pf.folders.slice(0, 20);
    var blurb = pf.source === 'damaged' ? 'Couldn’t read the saved list, so no extra folder counts. Add a folder to save it again.'
      : list.length ? 'Sessions can also open files from these folders.' : 'None. Sessions open files only from their own project folder.';
    return '<div class="cx-set-row cx-set-folders"><div class="cx-set-text"><span class="cx-set-name">Extra folders</span><span class="cx-set-desc" id="pf-blurb">' + esc(blurb) + '</span></div></div>' +
      list.map(function (f, i) {
        return '<div class="cx-set-row cx-set-folder"><div class="cx-set-text"><span class="cx-set-name pf-name">' + esc(f) + '</span></div>' +
          '<button type="button" class="cx-btn quiet" data-set="pf-remove" data-index="' + i + '" aria-label="' + esc('Remove ' + f) + '">Remove</button></div>';
      }).join('') +
      (list.length < 20 ? '<form class="cx-set-row pf-add" id="pf-add"><label class="cx-set-text" for="pf-input"><span class="cx-set-desc">Add a project folder, like ~/cos-worktrees. Not your whole home or Documents folder.</span></label>' +
        '<span class="pf-add-line"><input id="pf-input" type="text" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="~/cos-worktrees" aria-label="Folder to add">' +
        '<button type="submit" class="cx-btn" data-set="pf-add">Add</button></span></form>' : '');
  }
  function savePreviewFolders(next, done) {
    api('/api/preview-folders/settings', { method: 'POST', body: { folders: next } }).then(function (v) {
      if (S.data && v && Array.isArray(v.folders)) S.data.pf = v;
      W.toast('Saved');
      render();
      if (done) done(true);
    }, function (err) { say((err && err.message) || 'That folder was not saved.', true); if (done) done(false); });
  }
  function categoryBody(cat) {
    var d = S.data || {};
    var out = '';
    if (cat.id === 'reach') return p2On() ? reachBody() : pushBody();
    if (cat.id === 'pet') return petBody() + onMac(cat.mac);
    if (cat.id === 'privacy') out += sessionFilesGroup(d);
    // The Today summary (routes/today-brief.ts): Sonnet on the Mac writes Today's top lines (7.0.1; Haiku before). Off unless switched on here or
    // by COS_TODAY_BRIEF_LLM on the Mac, which wins when set.
    if (cat.id === 'general' && d.tb && typeof d.tb.enabled === 'boolean') {
      out += group('Today summary', '',
        row('Write the Today summary with a model', d.tb.source === 'env' ? 'Set on the Mac by the server environment.' :
          'Sonnet writes two or three sentences after the count of what needs you. It reads what Today shows (session titles and states, each session\u2019s latest reply, the questions sessions ask you, what needs you) and, on your Mac, each session\u2019s sub-agents and the Work cards in progress. It runs only while Today is open, only when something changed, never during a recording, at most every 10 minutes and no more than Summaries per day allows. Refresh on Today asks for a new one at once, at most every 30 seconds.',
          toggle(d.tb.enabled, 'data-set="today-brief"' + (d.tb.source === 'env' ? ' disabled' : ''), 'Write the Today summary with a model')) +
        // 7.0.5 "Summaries per day" (GET/PUT /api/today/brief/settings/cap), 1 to 100, default 100. Shown when the server has it.
        (typeof d.tb.dailyCap === 'number' ? row('Summaries per day', 'At most this many new summaries a day, Refresh included. 1 to 100.',
          '<input type="number" class="cx-set-num" id="today-brief-cap" data-set="today-brief-cap" min="1" max="100" step="1" inputmode="numeric" value="' + esc(String(d.tb.dailyCap)) + '" aria-label="Summaries per day">') : '') +
        (briefStatus(d.tb) ? '<p class="cx-set-blurb" id="today-brief-status">' + esc(briefStatus(d.tb)) + '</p>' : ''));
    }
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
    return out + (cat.mac.length ? onMac(cat.mac) : '');
  }

  // F1 (A4): one line when a refresh failed and the old settings are still shown. Try again is the same refresh.
  function failLine() {
    if (!S.failedAt || !S.data) return '';
    return '<p class="cx-note refresh-fail" role="status">Could not refresh. Showing what was there at ' + esc(W.clock(new Date(S.loadedAt))) +
      '. <button type="button" class="link-btn" data-set="refresh">Try again</button></p>';
  }
  // F1 (A4): what is being typed survives a refresh. A field (by id, data-p2 or data-set) that has focus, or a value
  // other than the one it was drawn with, is put back with its caret after the re-render. Only during a refresh.
  function keepTyped() {
    var a = document.activeElement, kept = [];
    Array.prototype.forEach.call(pane.querySelectorAll('input, textarea'), function (el) {
      if (el.type === 'checkbox' || el.type === 'radio') return;
      var key = el.id ? '#' + el.id : el.getAttribute('data-p2') ? '[data-p2="' + el.getAttribute('data-p2') + '"]' : el.getAttribute('data-set') ? '[data-set="' + el.getAttribute('data-set') + '"]' : '';
      var focused = el === a;
      if (key && (focused || el.value !== el.defaultValue)) kept.push({ key: key, value: el.value, focused: focused, s: el.selectionStart, e: el.selectionEnd });
    });
    return function () {
      kept.forEach(function (k) {
        var el = pane.querySelector(k.key); if (!el) return;
        el.value = k.value;
        if (k.focused) { el.focus({ preventScroll: true }); try { el.setSelectionRange(k.s, k.e); } catch (_e) {} }
      });
    };
  }

  function render() {
    if (W.parseRoute().pane !== 'settings') return;
    var keep = S.refreshing ? keepTyped() : null;
    var host = String(W.state.serverName || 'your Mac').replace(/-/g, ' ');
    pane.innerHTML = '<div class="cx">' +
      '<header class="cx-hero"><span class="cx-glyph"><svg class="icon"><use href="#i-settings"/></svg></span>' +
      '<div class="cx-hero-text"><h1 class="cx-title">Settings</h1><p class="cx-detail-line">COS on ' + esc(host) + '. Keys, permissions and glasses pairing change only on the Mac.</p></div>' +
      '<div class="cx-actions"><button type="button" class="cx-btn quiet" data-set="refresh"><svg class="icon"><use href="#i-refresh"/></svg>Refresh</button></div></header>' +
      browserGroup() + failLine() +
      (!S.data ? '<div class="cx-list" style="margin-top:18px">' + W.skeletonRows(4) + '</div>' :
        CATEGORIES.filter(function (cat) { return !cat.p2 || p2On() || pushOn(); }).map(function (cat) {
          return '<section class="cx-set-cat" id="set-cat-' + cat.id + '"><h2 class="cx-col-title">' + esc(cat.title) + '</h2><p class="cx-set-blurb">' + esc(cat.summary) + '</p>' + categoryBody(cat) + '</section>';
        }).join('')) +
      '<p class="status-line" id="settings-status"></p></div>';
    if (PET.q) filterPets();
    if (keep) keep();
  }

  function say(text, isError) { var el = $('settings-status'); if (el) { el.textContent = text; el.classList.toggle('error', !!isError); } }

  pane.addEventListener('click', function (e) {
    var go = e.target.closest('[data-go]');
    if (go) { var parts = go.getAttribute('data-go').split('/'); return W.go(parts[0], parts.slice(1)); }
    var pick = e.target.closest('[data-pet]');
    if (pick && W.setPetPrefs) {
      W.setPetPrefs({ pet: pick.getAttribute('data-pet') });
      pane.querySelectorAll('[data-pet]').forEach(function (b) {
        var on = b === pick; b.setAttribute('aria-pressed', String(on));
        var v = b.querySelector('.value'); if (v) v.innerHTML = on ? '<span class="check">✓</span>' : '';
      });
      W.toast('Pet changed. Today shows it here.');
      return;
    }
    var t = e.target.closest('[data-set]');
    if (!t || t.disabled) return;
    if (t.getAttribute('data-set') === 'pet-place') {
      var v = t.getAttribute('data-place');
      if (W.setPetPrefs) W.setPetPrefs(v === 'off' ? { show: false } : { show: true, place: v });
      W.toast(v === 'off' ? 'Pet off' : v === 'bar' ? 'Pet in the top bar' : 'Pet on Today');
      return render();
    }
    if (t.getAttribute('data-set') === 'pet-retry') { PET.state = 'idle'; return render(); }
    var act = t.getAttribute('data-set');
    // F1 (A4): Refresh keeps the settings on screen; the new values swap in when they arrive.
    if (act && act.indexOf('push-') === 0) { pushClick(act, t); return; }
    if (act === 'refresh') {
      ++PUSH.generation; PUSH.loaded = false; PUSH.error = '';
      if (S.refreshing && Date.now() - S.refreshAt < REFRESH_STUCK_MS) return;
      S.state = 'idle'; S.refreshing = true; S.refreshAt = Date.now(); load(true); return render();
    }
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
    if (act === 'session-files') {
      var son = t.getAttribute('aria-checked') === 'true';
      t.setAttribute('aria-checked', String(!son));
      api('/api/session-files/settings', { method: 'POST', body: { enabled: !son } })
        .then(function (v) {
          if (S.data && v) S.data.sf = v;
          W.toast(!son ? 'Session files and images on' : 'Session files and images off');
          render();
        }, function (err) { t.setAttribute('aria-checked', String(son)); say(err.message, true); });
      return;
    }
    if (act === 'pf-remove') {
      var cur = (S.data && S.data.pf && S.data.pf.folders) || [], idx = Number(t.getAttribute('data-index'));
      if (!(idx >= 0 && idx < cur.length)) return;
      t.disabled = true;
      savePreviewFolders(cur.filter(function (_f, i) { return i !== idx; }), function (ok) { if (!ok) t.disabled = false; });
      return;
    }
    if (act === 'pf-add') return; // the form's submit handler saves
    if (act === 'today-brief') {
      var ton = t.getAttribute('aria-checked') === 'true';
      t.setAttribute('aria-checked', String(!ton));
      api('/api/today/brief/settings', { method: 'POST', body: { enabled: !ton } })
        .then(function (v) {
          if (S.data && v) S.data.tb = v;
          // Today forgets the summary it showed, so turning it on asks at once and turning it off shows the counts line.
          if (W.resetTodayBrief) W.resetTodayBrief();
          W.toast(!ton ? 'Today summary on' : 'Today summary off');
          render();
        }, function (err) { t.setAttribute('aria-checked', String(ton)); say(err.message, true); });
      return;
    }
    if (act === 'brief') {
      var bon = t.getAttribute('aria-checked') === 'true';
      t.setAttribute('aria-checked', String(!bon));
      api('/api/morning-brief', { method: 'PUT', body: { enabled: !bon } })
        .then(function () { W.toast(!bon ? 'Morning brief on' : 'Morning brief paused'); }, function (err) { t.setAttribute('aria-checked', String(bon)); say(err.message, true); });
      return;
    }
    if (act === 'p2') {
      var path = t.getAttribute('data-p2'), was = t.getAttribute('aria-checked') === 'true';
      t.setAttribute('aria-checked', String(!was));
      p2Save(path, !was, function () { t.setAttribute('aria-checked', String(was)); });
      return;
    }
    if (act === 'release') {
      if (!W.armTap(t, t, 'Tap again to release')) return;
      // The server fails closed without confirm; the second tap is the confirmation.
      api('/api/agent-sessions/fences/release', { method: 'POST', body: { target: t.getAttribute('data-target'), confirm: true } })
        .then(function () { W.toast('Released'); S.data = null; S.state = 'idle'; load(true); }, function (err) { say(err.message, true); });
    }
  });

  pane.addEventListener('submit', function (e) {
    if (!e.target || e.target.id !== 'pf-add') return;
    e.preventDefault();
    var input = $('pf-input'), v = input ? input.value.trim() : '';
    if (!v) { say('Type a folder, like ~/cos-worktrees.', true); return; }
    var cur = (S.data && S.data.pf && S.data.pf.folders) || [];
    savePreviewFolders(cur.concat([v]));
  });

  // A gallery picture that will not load shows the pet's name alone, never a broken image.
  pane.addEventListener('error', function (e) {
    var img = e.target;
    if (img && img.tagName === 'IMG' && img.closest && img.closest('.pet-tile, .pet-choice')) img.classList.add('hidden');
  }, true);
  pane.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'pet-search') { PET.q = e.target.value; filterPets(); }
  });

  // Number, time, day and steer fields save when they change (a number is clamped by the server, then shown as saved).
  pane.addEventListener('change', function (e) {
    // 7.0.5 "Summaries per day": the server clamps to 1 to 100 and answers what it saved; the field shows that.
    if (e.target && e.target.id === 'today-brief-cap') {
      // QA 7.0.5: an emptied field (or letters, which a number field reads as '') is Number('') = 0, which the server
      // clamps to 1. So an empty, non-numeric or below-1 value sends nothing, keeps the saved number and says why.
      var capField = e.target, capRaw = String(capField.value == null ? '' : capField.value).trim(), wanted = Number(capRaw);
      if (capRaw === '' || !isFinite(wanted) || wanted < 1) {
        if (S.data && S.data.tb && typeof S.data.tb.dailyCap === 'number') capField.value = String(S.data.tb.dailyCap);
        say('Type a number from 1 to 100.', true);
        return;
      }
      api('/api/today/brief/settings/cap', { method: 'PUT', body: { dailyCap: wanted } }).then(function (v) {
        if (v && typeof v.dailyCap === 'number') { capField.value = String(v.dailyCap); if (S.data && S.data.tb) S.data.tb.dailyCap = v.dailyCap; }
        W.toast('Saved');
      }, function (err) { say((err && err.message) || 'That did not save.', true); });
      return;
    }
    var f = e.target && e.target.closest ? e.target.closest('[data-p2]') : null;
    if (!f || f.getAttribute('data-set') === 'p2' || !S.data || !S.data.p2) return;
    var path = f.getAttribute('data-p2'), raw = f.value;
    var v = f.type === 'number' || f.tagName === 'SELECT' ? Number(raw) : raw;
    if (typeof v === 'number' && !isFinite(v)) return;
    p2Save(path, v).then(function (ans) {
      var saved = ans && ans.settings ? p2Get(path) : undefined;
      if (saved !== undefined && String(saved) !== String(f.value)) f.value = String(saved);
    });
  });

  W.registerPane('settings', {
    load: function (args) {
      load(false); render();
      // "Change pet" on Today opens Settings at the Pet section.
      if (args && args[0] === 'pet') {
        var tries = 0;
        (function scroll() {
          var el = document.getElementById('set-cat-pet');
          // Land on the pet in use once the catalog has drawn; until then, the Pet section's top.
          var chosen = el && el.querySelector('[data-pet][aria-pressed="true"]');
          if (chosen) { chosen.scrollIntoView({ block: 'center' }); return; }
          if (el && tries === 0) el.scrollIntoView({ block: 'start' });
          if (++tries < 40) setTimeout(scroll, 150);
        })();
      }
    }
  });
})();
